/**
 * Trade review & narrative journaling system.
 *
 * Allows traders to self-assess each trade with grades, emotional state,
 * setup/execution quality, tags, and free-form notes. Aggregates these
 * reviews into actionable insights about behavioral patterns.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TradeGrade = "A" | "B" | "C" | "D" | "F";

export type EmotionalState =
	| "calm"
	| "fomo"
	| "fear"
	| "revenge"
	| "confident"
	| "neutral";

export interface TradeReview {
	id: string;
	tradeId: string;
	symbol: string;
	pnl: number;
	grade: TradeGrade;
	setupQuality: number; // 1-5
	executionQuality: number; // 1-5
	emotionalState: EmotionalState;
	lessonLearned: string | null;
	wouldTakeAgain: boolean;
	tags: string[];
	notes: string;
	createdAt: string;
}

export interface ReviewInsights {
	avgGrade: string;
	avgSetupQuality: number;
	avgExecutionQuality: number;
	emotionBreakdown: Record<string, number>;
	topTags: Array<{ tag: string; count: number; avgPnl: number }>;
	lessonsLearned: string[];
	improvementAreas: string[];
}

export interface ListReviewOptions {
	grade?: TradeGrade;
	tag?: string;
	emotionalState?: EmotionalState;
	symbol?: string;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TRADE_TAGS = [
	"trend-following",
	"breakout",
	"mean-reversion",
	"momentum",
	"false-breakout",
	"trend-trap",
	"gap-fill",
	"support-bounce",
	"resistance-rejection",
	"news-driven",
	"high-volume",
	"low-conviction",
	"high-conviction",
	"revenge-trade",
	"fomo-trade",
	"oversize",
	"scaled-in",
	"scaled-out",
	"stop-hunted",
] as const;

export type TradeTag = (typeof TRADE_TAGS)[number];

const VALID_GRADES: TradeGrade[] = ["A", "B", "C", "D", "F"];
const VALID_EMOTIONS: EmotionalState[] = [
	"calm",
	"fomo",
	"fear",
	"revenge",
	"confident",
	"neutral",
];

const GRADE_VALUES: Record<TradeGrade, number> = {
	A: 4,
	B: 3,
	C: 2,
	D: 1,
	F: 0,
};

const VALUE_TO_GRADE: [number, TradeGrade][] = [
	[3.5, "A"],
	[2.5, "B"],
	[1.5, "C"],
	[0.5, "D"],
	[0, "F"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}

function numericGradeToLetter(avg: number): string {
	for (const [threshold, grade] of VALUE_TO_GRADE) {
		if (avg >= threshold) return grade;
	}
	return "F";
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// TradeReviewManager
// ---------------------------------------------------------------------------

export class TradeReviewManager {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.initTables();
	}

	private initTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS trade_reviews (
				id TEXT PRIMARY KEY,
				tradeId TEXT NOT NULL UNIQUE,
				symbol TEXT NOT NULL,
				pnl REAL NOT NULL,
				grade TEXT NOT NULL,
				setupQuality INTEGER NOT NULL,
				executionQuality INTEGER NOT NULL,
				emotionalState TEXT NOT NULL,
				lessonLearned TEXT,
				wouldTakeAgain INTEGER NOT NULL DEFAULT 1,
				tags TEXT NOT NULL DEFAULT '[]',
				notes TEXT NOT NULL DEFAULT '',
				createdAt TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_trade_reviews_tradeId
				ON trade_reviews (tradeId);
			CREATE INDEX IF NOT EXISTS idx_trade_reviews_grade
				ON trade_reviews (grade, createdAt DESC);
			CREATE INDEX IF NOT EXISTS idx_trade_reviews_symbol
				ON trade_reviews (symbol, createdAt DESC);
			CREATE INDEX IF NOT EXISTS idx_trade_reviews_emotion
				ON trade_reviews (emotionalState, createdAt DESC);
		`);
	}

	// -- CRUD -----------------------------------------------------------------

	createReview(
		input: Omit<TradeReview, "id" | "createdAt">,
	): TradeReview {
		this.validateInput(input);

		const id = randomUUID();
		const now = new Date().toISOString();

		this.db
			.prepare(
				`INSERT INTO trade_reviews
				 (id, tradeId, symbol, pnl, grade, setupQuality, executionQuality,
				  emotionalState, lessonLearned, wouldTakeAgain, tags, notes, createdAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.tradeId,
				input.symbol,
				input.pnl,
				input.grade,
				input.setupQuality,
				input.executionQuality,
				input.emotionalState,
				input.lessonLearned ?? null,
				input.wouldTakeAgain ? 1 : 0,
				JSON.stringify(input.tags),
				input.notes,
				now,
			);

		return {
			id,
			tradeId: input.tradeId,
			symbol: input.symbol,
			pnl: input.pnl,
			grade: input.grade,
			setupQuality: input.setupQuality,
			executionQuality: input.executionQuality,
			emotionalState: input.emotionalState,
			lessonLearned: input.lessonLearned ?? null,
			wouldTakeAgain: input.wouldTakeAgain,
			tags: input.tags,
			notes: input.notes,
			createdAt: now,
		};
	}

	getReview(tradeId: string): TradeReview | null {
		const row = this.db
			.prepare("SELECT * FROM trade_reviews WHERE tradeId = ?")
			.get(tradeId) as RawReviewRow | undefined;

		return row ? this.hydrateRow(row) : null;
	}

	getReviewById(id: string): TradeReview | null {
		const row = this.db
			.prepare("SELECT * FROM trade_reviews WHERE id = ?")
			.get(id) as RawReviewRow | undefined;

		return row ? this.hydrateRow(row) : null;
	}

	updateReview(
		id: string,
		updates: Partial<Omit<TradeReview, "id" | "tradeId" | "createdAt">>,
	): TradeReview | null {
		const existing = this.getReviewById(id);
		if (!existing) return null;

		const merged = { ...existing, ...updates };
		this.validateInput(merged);

		const parts: string[] = [];
		const values: unknown[] = [];

		if (updates.grade !== undefined) {
			parts.push("grade = ?");
			values.push(updates.grade);
		}
		if (updates.setupQuality !== undefined) {
			parts.push("setupQuality = ?");
			values.push(updates.setupQuality);
		}
		if (updates.executionQuality !== undefined) {
			parts.push("executionQuality = ?");
			values.push(updates.executionQuality);
		}
		if (updates.emotionalState !== undefined) {
			parts.push("emotionalState = ?");
			values.push(updates.emotionalState);
		}
		if (updates.lessonLearned !== undefined) {
			parts.push("lessonLearned = ?");
			values.push(updates.lessonLearned);
		}
		if (updates.wouldTakeAgain !== undefined) {
			parts.push("wouldTakeAgain = ?");
			values.push(updates.wouldTakeAgain ? 1 : 0);
		}
		if (updates.tags !== undefined) {
			parts.push("tags = ?");
			values.push(JSON.stringify(updates.tags));
		}
		if (updates.notes !== undefined) {
			parts.push("notes = ?");
			values.push(updates.notes);
		}
		if (updates.symbol !== undefined) {
			parts.push("symbol = ?");
			values.push(updates.symbol);
		}
		if (updates.pnl !== undefined) {
			parts.push("pnl = ?");
			values.push(updates.pnl);
		}

		if (parts.length === 0) return existing;

		values.push(id);
		this.db
			.prepare(
				`UPDATE trade_reviews SET ${parts.join(", ")} WHERE id = ?`,
			)
			.run(...values);

		return this.getReviewById(id);
	}

	deleteReview(id: string): boolean {
		const result = this.db
			.prepare("DELETE FROM trade_reviews WHERE id = ?")
			.run(id);
		return result.changes > 0;
	}

	listReviews(options?: ListReviewOptions): TradeReview[] {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (options?.grade) {
			conditions.push("grade = ?");
			params.push(options.grade);
		}
		if (options?.emotionalState) {
			conditions.push("emotionalState = ?");
			params.push(options.emotionalState);
		}
		if (options?.symbol) {
			conditions.push("symbol = ?");
			params.push(options.symbol);
		}
		// Tag filter uses JSON LIKE match (SQLite has no native JSON array search)
		if (options?.tag) {
			conditions.push("tags LIKE ?");
			params.push(`%"${options.tag}"%`);
		}

		const limit = options?.limit ?? 50;
		params.push(limit);

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const rows = this.db
			.prepare(
				`SELECT * FROM trade_reviews ${where} ORDER BY createdAt DESC LIMIT ?`,
			)
			.all(...params) as RawReviewRow[];

		return rows.map((r) => this.hydrateRow(r));
	}

	// -- Aggregate Insights ---------------------------------------------------

	getInsights(): ReviewInsights {
		const allReviews = this.listReviews({ limit: 1000 });

		if (allReviews.length === 0) {
			return {
				avgGrade: "N/A",
				avgSetupQuality: 0,
				avgExecutionQuality: 0,
				emotionBreakdown: {},
				topTags: [],
				lessonsLearned: [],
				improvementAreas: [],
			};
		}

		// Average grade
		const gradeSum = allReviews.reduce(
			(s, r) => s + GRADE_VALUES[r.grade],
			0,
		);
		const avgGradeNum = gradeSum / allReviews.length;
		const avgGrade = numericGradeToLetter(avgGradeNum);

		// Average quality scores
		const avgSetupQuality = r2(
			allReviews.reduce((s, r) => s + r.setupQuality, 0) / allReviews.length,
		);
		const avgExecutionQuality = r2(
			allReviews.reduce((s, r) => s + r.executionQuality, 0) /
				allReviews.length,
		);

		// Emotion breakdown
		const emotionBreakdown: Record<string, number> = {};
		for (const review of allReviews) {
			emotionBreakdown[review.emotionalState] =
				(emotionBreakdown[review.emotionalState] ?? 0) + 1;
		}

		// Top tags with P&L correlation
		const tagMap = new Map<string, { count: number; totalPnl: number }>();
		for (const review of allReviews) {
			for (const tag of review.tags) {
				const entry = tagMap.get(tag) ?? { count: 0, totalPnl: 0 };
				entry.count++;
				entry.totalPnl += review.pnl;
				tagMap.set(tag, entry);
			}
		}
		const topTags = Array.from(tagMap.entries())
			.map(([tag, data]) => ({
				tag,
				count: data.count,
				avgPnl: r2(data.totalPnl / data.count),
			}))
			.sort((a, b) => b.count - a.count);

		// Collect unique lessons
		const lessonsLearned = allReviews
			.filter((r) => r.lessonLearned != null && r.lessonLearned.trim() !== "")
			.map((r) => r.lessonLearned as string)
			.slice(0, 50); // Cap to avoid huge payloads

		// Generate improvement areas
		const improvementAreas = this.deriveImprovementAreas(
			allReviews,
			avgSetupQuality,
			avgExecutionQuality,
			emotionBreakdown,
			topTags,
		);

		return {
			avgGrade,
			avgSetupQuality,
			avgExecutionQuality,
			emotionBreakdown,
			topTags,
			lessonsLearned,
			improvementAreas,
		};
	}

	// -- Internal Helpers -----------------------------------------------------

	private deriveImprovementAreas(
		reviews: TradeReview[],
		avgSetup: number,
		avgExec: number,
		emotions: Record<string, number>,
		tags: Array<{ tag: string; count: number; avgPnl: number }>,
	): string[] {
		const areas: string[] = [];
		const totalReviews = reviews.length;

		// Setup quality issues
		if (avgSetup < 3.0) {
			areas.push(
				`Average setup quality is ${avgSetup}/5. Spend more time validating setups before entry — wait for confluences.`,
			);
		}

		// Execution quality issues
		if (avgExec < 3.0) {
			areas.push(
				`Average execution quality is ${avgExec}/5. Work on entry timing, position sizing, and stop placement.`,
			);
		}

		// Emotional trading detection
		const emotionalTrades =
			(emotions["fomo"] ?? 0) +
			(emotions["revenge"] ?? 0) +
			(emotions["fear"] ?? 0);
		if (totalReviews > 0 && emotionalTrades / totalReviews > 0.3) {
			const pct = r2((emotionalTrades / totalReviews) * 100);
			areas.push(
				`${pct}% of reviewed trades involved negative emotions (FOMO/revenge/fear). Implement a pre-trade checklist to reduce impulsive entries.`,
			);
		}

		// Revenge trading pattern
		const revengePct =
			totalReviews > 0
				? ((emotions["revenge"] ?? 0) / totalReviews) * 100
				: 0;
		if (revengePct > 10) {
			areas.push(
				`${r2(revengePct)}% of trades are revenge trades. Enforce a mandatory cooldown period after losses.`,
			);
		}

		// FOMO pattern
		const fomoPct =
			totalReviews > 0
				? ((emotions["fomo"] ?? 0) / totalReviews) * 100
				: 0;
		if (fomoPct > 15) {
			areas.push(
				`${r2(fomoPct)}% of trades are FOMO-driven. Use limit orders instead of market orders to enforce discipline.`,
			);
		}

		// Behavioral tags with negative P&L
		const dangerTags = tags.filter(
			(t) =>
				["revenge-trade", "fomo-trade", "oversize", "low-conviction"].includes(
					t.tag,
				) &&
				t.avgPnl < 0 &&
				t.count >= 3,
		);
		for (const dt of dangerTags) {
			areas.push(
				`Trades tagged '${dt.tag}' lose an average of $${Math.abs(dt.avgPnl)} each. Eliminate or reduce this pattern.`,
			);
		}

		// "Would not take again" analysis
		const wouldNotRetake = reviews.filter((r) => !r.wouldTakeAgain);
		if (wouldNotRetake.length >= 5) {
			const noRetakePct = r2((wouldNotRetake.length / totalReviews) * 100);
			areas.push(
				`${noRetakePct}% of trades you would not take again. Review these trades for common patterns to filter out.`,
			);
		}

		// Low grade trades with losses
		const lowGradeLosses = reviews.filter(
			(r) => (r.grade === "D" || r.grade === "F") && r.pnl < 0,
		);
		if (lowGradeLosses.length >= 3) {
			const avgLoss = r2(
				lowGradeLosses.reduce((s, r) => s + r.pnl, 0) /
					lowGradeLosses.length,
			);
			areas.push(
				`${lowGradeLosses.length} trades graded D/F resulted in losses (avg $${avgLoss}). Poor-quality setups are a primary P&L leak.`,
			);
		}

		return areas;
	}

	private validateInput(
		input: Omit<TradeReview, "id" | "createdAt"> | TradeReview,
	): void {
		if (!VALID_GRADES.includes(input.grade)) {
			throw new Error(
				`Invalid grade "${input.grade}". Must be one of: ${VALID_GRADES.join(", ")}`,
			);
		}
		if (!VALID_EMOTIONS.includes(input.emotionalState)) {
			throw new Error(
				`Invalid emotional state "${input.emotionalState}". Must be one of: ${VALID_EMOTIONS.join(", ")}`,
			);
		}
		if (input.setupQuality < 1 || input.setupQuality > 5) {
			throw new Error(
				`Setup quality must be between 1 and 5, got ${input.setupQuality}`,
			);
		}
		if (input.executionQuality < 1 || input.executionQuality > 5) {
			throw new Error(
				`Execution quality must be between 1 and 5, got ${input.executionQuality}`,
			);
		}
		// Clamp quality scores to integers
		input.setupQuality = clamp(Math.round(input.setupQuality), 1, 5);
		input.executionQuality = clamp(Math.round(input.executionQuality), 1, 5);
	}

	private hydrateRow(row: RawReviewRow): TradeReview {
		return {
			id: row.id,
			tradeId: row.tradeId,
			symbol: row.symbol,
			pnl: row.pnl,
			grade: row.grade as TradeGrade,
			setupQuality: row.setupQuality,
			executionQuality: row.executionQuality,
			emotionalState: row.emotionalState as EmotionalState,
			lessonLearned: row.lessonLearned,
			wouldTakeAgain: row.wouldTakeAgain === 1,
			tags: row.tags ? (() => { try { return JSON.parse(row.tags); } catch { return []; } })() : [],
			notes: row.notes,
			createdAt: row.createdAt,
		};
	}
}

// ---------------------------------------------------------------------------
// Internal raw DB row type
// ---------------------------------------------------------------------------

interface RawReviewRow {
	id: string;
	tradeId: string;
	symbol: string;
	pnl: number;
	grade: string;
	setupQuality: number;
	executionQuality: number;
	emotionalState: string;
	lessonLearned: string | null;
	wouldTakeAgain: number; // SQLite stores boolean as 0/1
	tags: string; // JSON string
	notes: string;
	createdAt: string;
}
