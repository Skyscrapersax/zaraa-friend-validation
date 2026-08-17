/**
 * journal-reporter.ts
 *
 * Generates a markdown trade journal for a configurable time period.
 * Queries the trading database for closed trades, computes performance stats,
 * identifies behavioral patterns, and saves the report to disk.
 *
 * Designed to be called either on-demand (via the `trade_journal` tool)
 * or on a schedule (e.g. every Monday morning via the Zaraa scheduler).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { StrategyTradeRecord } from "./trade-journal.js";

// ── Public interfaces ────────────────────────────────────────────────────────

export interface JournalOptions {
	/**
	 * How many days back to include (default: 7 for a weekly report).
	 * Use 30 for monthly, 1 for daily, etc.
	 */
	days?: number;

	/**
	 * Where to write the markdown file.
	 * Defaults to ~/.zaraa/data/journals/
	 */
	outputDir?: string;
}

export interface JournalStats {
	totalTrades: number;
	wins: number;
	losses: number;
	/** 0–1 fraction */
	winRate: number;
	totalPnl: number;
	bestTrade: number;
	worstTrade: number;
}

export interface JournalResult {
	/** Full path to the saved .md file */
	path: string;
	/** The complete markdown text */
	markdown: string;
	/** Quick numeric summary for callers that just want the numbers */
	stats: JournalStats;
}

// ── JournalReporter ──────────────────────────────────────────────────────────

/**
 * Generates and saves a markdown trade journal.
 *
 * Usage:
 *   const reporter = new JournalReporter(db);
 *   const result = reporter.generate({ days: 7 });
 *   console.log("Saved to:", result.path);
 */
export class JournalReporter {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/**
	 * Run the report: query trades, build markdown, save to disk, return result.
	 */
	generate(options: JournalOptions = {}): JournalResult {
		const days = options.days ?? 7;
		const outputDir =
			options.outputDir ?? join(homedir(), ".zaraa", "data", "journals");

		// Date range: from `days` ago until now
		const now = new Date();
		const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
		const sinceIso = since.toISOString();

		// Fetch all closed trades in the window, joining in signal metadata
		const trades = this.fetchTrades(sinceIso);

		// Compute top-level stats
		const stats = this.computeStats(trades);

		// Build the markdown document
		const periodLabel = days === 7 ? "Weekly" : days === 30 ? "Monthly" : `${days}-Day`;
		const markdown = this.buildMarkdown(trades, stats, {
			periodLabel,
			since: formatDate(since),
			until: formatDate(now),
		});

		// Ensure the journals directory exists
		mkdirSync(outputDir, { recursive: true });

		// Date-stamped filename, e.g. journal-2026-03-20.md
		const filename = `journal-${now.toISOString().slice(0, 10)}.md`;
		const path = join(outputDir, filename);
		writeFileSync(path, markdown, "utf-8");

		return { path, markdown, stats };
	}

	// ── Private: data fetching ─────────────────────────────────────────────

	/**
	 * Query strategy_trades joined with signal_log for the given time window.
	 * Only returns trades that have been closed (exitedAt IS NOT NULL).
	 */
	private fetchTrades(sinceIso: string): TradeRow[] {
		// Check if signal_log table exists (it won't on a fresh DB with no strategies)
		const tables = (
			this.db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all() as { name: string }[]
		).map((r) => r.name);

		if (!tables.includes("strategy_trades")) {
			return [];
		}

		const joinSignal = tables.includes("signal_log");

		const query = joinSignal
			? `SELECT
					st.id, st.strategyName, st.symbol, st.direction,
					st.entryPrice, st.exitPrice, st.qty, st.pnl, st.rMultiple,
					st.exitReason, st.enteredAt, st.exitedAt,
					st.regime, st.session,
					sl.reason    AS signalReason,
					sl.confidence AS signalConfidence,
					sl.stopLoss  AS signalStopLoss,
					COALESCE(sl.regime, st.regime) AS signalRegime,
					COALESCE(sl.session, st.session) AS signalSession
				FROM strategy_trades st
				LEFT JOIN signal_log sl ON st.signalId = sl.id
				WHERE st.exitedAt IS NOT NULL
				  AND st.isShadow = 0
				  AND st.exitedAt >= ?
				ORDER BY st.enteredAt ASC`
			: `SELECT
					id, strategyName, symbol, direction,
					entryPrice, exitPrice, qty, pnl, rMultiple,
					exitReason, enteredAt, exitedAt,
					regime, session,
					NULL AS signalReason,
					NULL AS signalConfidence,
					NULL AS signalStopLoss,
					regime AS signalRegime,
					session AS signalSession
				FROM strategy_trades
				WHERE exitedAt IS NOT NULL
				  AND isShadow = 0
				  AND exitedAt >= ?
				ORDER BY enteredAt ASC`;

		return this.db.prepare(query).all(sinceIso) as TradeRow[];
	}

	// ── Private: stats ─────────────────────────────────────────────────────

	private computeStats(trades: TradeRow[]): JournalStats {
		const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
		const losses = trades.filter((t) => (t.pnl ?? 0) <= 0);
		const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

		return {
			totalTrades: trades.length,
			wins: wins.length,
			losses: losses.length,
			winRate: trades.length > 0 ? wins.length / trades.length : 0,
			totalPnl,
			bestTrade: wins.reduce((best, t) => Math.max(best, t.pnl ?? 0), 0),
			worstTrade: losses.reduce((worst, t) => Math.min(worst, t.pnl ?? 0), 0),
		};
	}

	// ── Private: markdown builder ──────────────────────────────────────────

	private buildMarkdown(
		trades: TradeRow[],
		stats: JournalStats,
		meta: { periodLabel: string; since: string; until: string },
	): string {
		const lines: string[] = [];

		// Header
		lines.push(`# Zaraa ${meta.periodLabel} Trade Journal`);
		lines.push(`**Period:** ${meta.since} → ${meta.until}`);
		lines.push(`**Generated:** ${new Date().toUTCString()}`);
		lines.push("");

		// ── Summary table ──
		lines.push("## Summary");
		lines.push("");
		lines.push("| Metric | Value |");
		lines.push("|--------|-------|");
		lines.push(`| Total Closed Trades | ${stats.totalTrades} |`);
		lines.push(`| Wins / Losses | ${stats.wins} / ${stats.losses} |`);
		lines.push(`| Win Rate | ${pct(stats.winRate)} |`);
		lines.push(`| Total P&L | ${usd(stats.totalPnl)} |`);
		lines.push(`| Best Trade | ${usd(stats.bestTrade)} |`);
		lines.push(`| Worst Trade | ${usd(stats.worstTrade)} |`);
		lines.push("");

		if (trades.length === 0) {
			lines.push("_No closed trades in this period._");
			lines.push("");
			lines.push("## Lessons Learned");
			lines.push("");
			lines.push("_No trades to analyze._");
			return lines.join("\n");
		}

		// ── Full trade list ──
		lines.push("## All Trades");
		lines.push("");
		lines.push("| # | Date | Symbol | Dir | Strategy | Entry | Exit | P&L | R | Regime | Exit Reason |");
		lines.push("|---|------|--------|-----|----------|-------|------|-----|---|--------|-------------|");

		for (let i = 0; i < trades.length; i++) {
			const t = trades[i];
			const date = t.exitedAt ? t.exitedAt.slice(0, 10) : t.enteredAt.slice(0, 10);
			const dir = t.direction === "long" ? "Long" : "Short";
			const pnlStr = t.pnl != null ? usd(t.pnl) : "open";
			const rStr = t.rMultiple != null ? r(t.rMultiple) : "--";
			const exitStr = t.exitPrice != null ? `$${fmt(t.exitPrice)}` : "--";
			const regimeStr = t.signalRegime ?? "--";

			lines.push(
				`| ${i + 1} | ${date} | ${t.symbol} | ${dir} | ${t.strategyName} ` +
				`| $${fmt(t.entryPrice)} | ${exitStr} | ${pnlStr} | ${rStr} | ${regimeStr} | ${t.exitReason ?? "--"} |`,
			);
		}
		lines.push("");

		// ── Per-strategy breakdown ──
		lines.push("## Performance by Strategy");
		lines.push("");

		const byStrategy = groupBy(trades, (t) => t.strategyName);
		for (const [name, stratTrades] of Object.entries(byStrategy)) {
			const stratWins = stratTrades.filter((t) => (t.pnl ?? 0) > 0).length;
			const stratPnl = stratTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
			const stratWr = stratTrades.length > 0 ? stratWins / stratTrades.length : 0;
			const avgR =
				stratTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) /
				stratTrades.length;

			lines.push(`### ${name}`);
			lines.push(
				`- **Trades:** ${stratTrades.length} &nbsp;|&nbsp; ` +
				`**Win Rate:** ${pct(stratWr)} &nbsp;|&nbsp; ` +
				`**Total P&L:** ${usd(stratPnl)} &nbsp;|&nbsp; ` +
				`**Avg R:** ${r(avgR)}`,
			);
			lines.push("");
		}

		// ── Per-symbol breakdown ──
		const bySymbol = groupBy(trades, (t) => t.symbol);
		if (Object.keys(bySymbol).length > 1) {
			lines.push("## Performance by Symbol");
			lines.push("");
			lines.push("| Symbol | Trades | Win Rate | Total P&L |");
			lines.push("|--------|--------|----------|-----------|");

			for (const [sym, symTrades] of Object.entries(bySymbol)) {
				const symWins = symTrades.filter((t) => (t.pnl ?? 0) > 0).length;
				const symPnl = symTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
				const symWr = symTrades.length > 0 ? symWins / symTrades.length : 0;
				lines.push(
					`| ${sym} | ${symTrades.length} | ${pct(symWr)} | ${usd(symPnl)} |`,
				);
			}
			lines.push("");
		}

		// ── Performance by regime ──
		const byRegime = groupBy(
			trades.filter((t) => t.signalRegime),
			(t) => t.signalRegime!,
		);
		if (Object.keys(byRegime).length > 0) {
			lines.push("## Performance by Market Regime");
			lines.push("");
			lines.push("| Regime | Trades | Win Rate | Total P&L | Avg R |");
			lines.push("|--------|--------|----------|-----------|-------|");

			for (const [regime, regTrades] of Object.entries(byRegime)) {
				const regWins = regTrades.filter((t) => (t.pnl ?? 0) > 0).length;
				const regPnl = regTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
				const regWr = regTrades.length > 0 ? regWins / regTrades.length : 0;
				const avgR = regTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / regTrades.length;
				lines.push(
					`| ${regime} | ${regTrades.length} | ${pct(regWr)} | ${usd(regPnl)} | ${r(avgR)} |`,
				);
			}
			lines.push("");
		}

		// ── Performance by session ──
		const bySession = groupBy(
			trades.filter((t) => t.signalSession),
			(t) => t.signalSession!,
		);
		if (Object.keys(bySession).length > 0) {
			lines.push("## Performance by Trading Session");
			lines.push("");
			lines.push("| Session | Trades | Win Rate | Total P&L | Avg R |");
			lines.push("|---------|--------|----------|-----------|-------|");

			for (const [session, sesTrades] of Object.entries(bySession)) {
				const sesWins = sesTrades.filter((t) => (t.pnl ?? 0) > 0).length;
				const sesPnl = sesTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
				const sesWr = sesTrades.length > 0 ? sesWins / sesTrades.length : 0;
				const avgR = sesTrades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / sesTrades.length;
				lines.push(
					`| ${session} | ${sesTrades.length} | ${pct(sesWr)} | ${usd(sesPnl)} | ${r(avgR)} |`,
				);
			}
			lines.push("");
		}

		// ── Lessons learned ──
		lines.push("## Lessons Learned");
		lines.push("");
		lines.push(
			"_Auto-generated by analyzing patterns in this period's trades._",
		);
		lines.push("");

		const lessons = this.generateLessons(trades, byStrategy);
		for (const lesson of lessons) {
			lines.push(`- ${lesson}`);
		}
		lines.push("");

		return lines.join("\n");
	}

	// ── Private: pattern analysis ──────────────────────────────────────────

	/**
	 * Looks for recurring patterns in losing (and winning) trades and returns
	 * plain-English observations. Designed to be easy to understand for beginners.
	 */
	private generateLessons(
		trades: TradeRow[],
		byStrategy: Record<string, TradeRow[]>,
	): string[] {
		const lessons: string[] = [];
		const losses = trades.filter((t) => (t.pnl ?? 0) <= 0);
		const wins = trades.filter((t) => (t.pnl ?? 0) > 0);

		// No losses at all — still worth noting, but continue to regime/session analysis
		if (losses.length === 0) {
			lessons.push(
				"Clean period — zero losing trades! Review whether stop-losses are too wide (wins may be small too).",
			);
		}

		if (losses.length > 0) {
			// ── Which strategy had the most losses? ──
			const lossesByStrategy = countBy(losses, (t) => t.strategyName);
			const worstStrategy = topEntry(lossesByStrategy);
			if (worstStrategy) {
				const total = byStrategy[worstStrategy.key]?.length ?? 0;
				if (worstStrategy.count >= 2) {
					const lossRate = worstStrategy.count / total;
					lessons.push(
						`**${worstStrategy.key}** had the most losses: ${worstStrategy.count} of ${total} trades` +
						` (${pct(lossRate)} loss rate). Consider reviewing its signal conditions or pausing it during volatile periods.`,
					);
				}
			}

			// ── Direction bias: were longs or shorts consistently losing? ──
			const longTrades = trades.filter((t) => t.direction === "long");
			const shortTrades = trades.filter((t) => t.direction === "short");
			const longLossRate =
				longTrades.length > 0
					? losses.filter((t) => t.direction === "long").length / longTrades.length
					: 0;
			const shortLossRate =
				shortTrades.length > 0
					? losses.filter((t) => t.direction === "short").length / shortTrades.length
					: 0;

			if (longTrades.length >= 3 && longLossRate > 0.6) {
				lessons.push(
					`Long trades struggled this period (${pct(longLossRate)} loss rate on ${longTrades.length} longs). ` +
					`The market may have been in a downtrend — consider adding a trend filter before going long.`,
				);
			}
			if (shortTrades.length >= 3 && shortLossRate > 0.6) {
				lessons.push(
					`Short trades struggled this period (${pct(shortLossRate)} loss rate on ${shortTrades.length} shorts). ` +
					`The market may have been in an uptrend — consider adding a trend filter before going short.`,
				);
			}

			// ── Which symbol was most problematic? ──
			const lossesBySymbol = countBy(losses, (t) => t.symbol);
			const worstSymbol = topEntry(lossesBySymbol);
			if (worstSymbol && worstSymbol.count >= 2) {
				lessons.push(
					`**${worstSymbol.key}** had ${worstSymbol.count} losses this period. ` +
					`It may be unusually range-bound or illiquid right now. Consider reducing position size or skipping it until conditions improve.`,
				);
			}

			// ── High-confidence signals that lost ──
			const highConfLosses = losses.filter(
				(t) => (t.signalConfidence ?? 0) > 0.7,
			);
			if (
				highConfLosses.length >= 2 &&
				highConfLosses.length >= losses.length * 0.35
			) {
				lessons.push(
					`${highConfLosses.length} losses came from high-confidence (>70%) signals. ` +
					`This suggests the confidence model may be overfit — review what drove those signals and whether the conditions still hold.`,
				);
			}

			// ── Losses by hour-of-day ──
			const lossByHour = countBy(losses, (t) =>
				String(new Date(t.exitedAt ?? t.enteredAt).getUTCHours()),
			);
			const worstHour = topEntry(lossByHour);
			if (worstHour && worstHour.count >= 3) {
				lessons.push(
					`${worstHour.count} losses exited around ${worstHour.key}:00 UTC. ` +
					`This hour may have noisy or low-liquidity conditions. Consider a time-of-day filter to avoid trading then.`,
				);
			}
		}

		// ── Positive: best performing strategy ──
		const winsByStrategy = countBy(wins, (t) => t.strategyName);
		const bestStrategy = topEntry(winsByStrategy);
		if (bestStrategy && bestStrategy.count >= 2) {
			const total = byStrategy[bestStrategy.key]?.length ?? 1;
			const wr = bestStrategy.count / total;
			if (wr >= 0.55) {
				lessons.push(
					`**${bestStrategy.key}** is your best performer this period (${pct(wr)} win rate, ${bestStrategy.count} wins). ` +
					`Consider increasing its allocation if risk manager allows.`,
				);
			}
		}

		// ── R-multiple insight ──
		const closedWithR = trades.filter((t) => t.rMultiple != null);
		if (closedWithR.length >= 3) {
			const avgR =
				closedWithR.reduce((s, t) => s + (t.rMultiple ?? 0), 0) /
				closedWithR.length;
			if (avgR < 0) {
				lessons.push(
					`Average R-multiple is ${r(avgR)} — you are losing more than your stops imply. ` +
					`Check if exits are happening too early or if stop placement is too tight.`,
				);
			} else if (avgR > 1) {
				lessons.push(
					`Average R-multiple is ${r(avgR)} — strong risk/reward. ` +
					`Trades are capturing more than 1× their initial risk when they win.`,
				);
			}
		}

		// ── Regime-specific insights ──
		const tradesByRegime = groupBy(
			trades.filter((t) => t.signalRegime),
			(t) => t.signalRegime!,
		);
		for (const [regime, regTrades] of Object.entries(tradesByRegime)) {
			if (regTrades.length < 2) continue;
			const regLosses = regTrades.filter((t) => (t.pnl ?? 0) <= 0);
			const lossRate = regLosses.length / regTrades.length;
			if (lossRate > 0.6) {
				lessons.push(
					`Struggled in **${regime}** regime (${pct(lossRate)} loss rate, ${regTrades.length} trades). ` +
					`Consider adjusting strategy weights for this regime or tightening entry criteria.`,
				);
			} else if (lossRate < 0.3 && regTrades.length >= 3) {
				lessons.push(
					`Thrived in **${regime}** regime (${pct(1 - lossRate)} win rate, ${regTrades.length} trades). ` +
					`These conditions suit your strategy set well.`,
				);
			}
		}

		// ── Session-specific insights ──
		const tradesBySession = groupBy(
			trades.filter((t) => t.signalSession),
			(t) => t.signalSession!,
		);
		for (const [session, sesTrades] of Object.entries(tradesBySession)) {
			if (sesTrades.length < 2) continue;
			const sesLosses = sesTrades.filter((t) => (t.pnl ?? 0) <= 0);
			const lossRate = sesLosses.length / sesTrades.length;
			if (lossRate > 0.6) {
				lessons.push(
					`The **${session}** session produced ${pct(lossRate)} losses across ${sesTrades.length} trades. ` +
					`Consider tightening the session filter or avoiding entries during this window.`,
				);
			}
		}

		if (lessons.length === 0) {
			lessons.push("Not enough data to identify strong patterns yet. Keep trading and the journal will grow more useful.");
		}

		return lessons;
	}
}

// ── Internal row type (matches the SQL query above) ──────────────────────────

interface TradeRow extends StrategyTradeRecord {
	signalReason: string | null;
	signalConfidence: number | null;
	signalStopLoss: number | null;
	/** Regime and session from signal_log (via join) */
	signalRegime: string | null;
	signalSession: string | null;
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
	const result: Record<string, T[]> = {};
	for (const item of arr) {
		const k = key(item);
		const bucket = result[k] ?? [];
		bucket.push(item);
		result[k] = bucket;
	}
	return result;
}

function countBy<T>(arr: T[], key: (t: T) => string): Record<string, number> {
	const result: Record<string, number> = {};
	for (const item of arr) {
		const k = key(item);
		result[k] = (result[k] ?? 0) + 1;
	}
	return result;
}

function topEntry(
	counts: Record<string, number>,
): { key: string; count: number } | null {
	const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	return entries[0] ? { key: entries[0][0], count: entries[0][1] } : null;
}

/** Formats a dollar amount with sign, e.g. +$12.34 or -$5.00 */
function usd(n: number): string {
	const abs = Math.abs(n).toFixed(2);
	return n >= 0 ? `+$${abs}` : `-$${abs}`;
}

/** Formats a percentage, e.g. 62.5% */
function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

/** Formats an R-multiple, e.g. +1.50R */
function r(n: number): string {
	return `${n >= 0 ? "+" : ""}${n.toFixed(2)}R`;
}

/** Formats a price with appropriate decimal places */
function fmt(n: number): string {
	return n < 1 ? n.toFixed(6) : n.toFixed(2);
}

/** Formats a Date as "Mar 20, 2026" */
function formatDate(d: Date): string {
	return d.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}
