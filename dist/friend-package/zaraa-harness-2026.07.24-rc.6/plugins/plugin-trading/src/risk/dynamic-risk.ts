import type Database from "better-sqlite3";
import type { TradingStore } from "../trading-store.js";

const RECENT_TRADE_WINDOW = 20;
const PAUSE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const CONSECUTIVE_LOSS_THRESHOLD = 3;
const DRAWDOWN_REDUCE_THRESHOLD = 10; // %
const WIN_RATE_STOP_WIDEN_THRESHOLD = 40; // %
const WIN_RATE_INCREASE_THRESHOLD = 60; // %
const DRAWDOWN_INCREASE_CEILING = 5; // %
const MAX_RISK_MULTIPLIER = 1.5;
const REDUCED_RISK_MULTIPLIER = 0.5;
const PAUSED_RISK_MULTIPLIER = 0.5;
const STOP_WIDEN_MULTIPLIER = 1.2;
const IMPROVE_STEP = 0.1; // gradual increase per refresh cycle
const RESET_IMPROVE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const STARTING_EQUITY = 10_000;

export interface DynamicRiskAdjustment {
	riskMultiplier: number;
	stopLossMultiplier: number;
	paused: boolean;
	reason: string;
}

interface TradeRow {
	pnl: number;
	exitedAt: string;
}

interface StateRow {
	riskMultiplier: number;
	stopLossMultiplier: number;
	pausedUntilMs: number;
	consecutiveLosses: number;
	improvingSinceMs: number | null;
	lastUpdatedAt: string;
	reasonJson: string | null;
}

function getDb(store: TradingStore): Database.Database | null {
	const s = store as unknown as { getDb?: () => Database.Database };
	return typeof s.getDb === "function" ? s.getDb() : null;
}

function computeMaxDrawdownPct(pnls: number[]): number {
	let eq = STARTING_EQUITY;
	let peak = eq;
	let maxDd = 0;
	for (const p of pnls) {
		eq += p;
		if (eq > peak) peak = eq;
		const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
		if (dd > maxDd) maxDd = dd;
	}
	return maxDd;
}

export class DynamicRiskAdjuster {
	private store: TradingStore;

	constructor(store: TradingStore) {
		this.store = store;
	}

	refresh(): DynamicRiskAdjustment {
		const db = getDb(this.store);
		if (!db) return this.failSafeAdjustment();

		const trades = db
			.prepare(
				`SELECT pnl, exitedAt FROM strategy_trades
				 WHERE exitedAt IS NOT NULL AND isShadow = 0 ORDER BY exitedAt DESC LIMIT ?`,
			)
			.all(RECENT_TRADE_WINDOW) as TradeRow[];

		if (trades.length === 0) {
			const adj = this.baseAdjustment();
			this.persistState(db, adj, 0, null, "insufficient_data: no closed trades");
			return adj;
		}

		const pnls = trades.map((t) => t.pnl); // DESC order — most recent first
		const pnlsChronological = [...pnls].reverse();

		const now = Date.now();
		const wins = pnls.filter((p) => p > 0).length;
		const winRate = (wins / pnls.length) * 100;
		const maxDrawdownPct = computeMaxDrawdownPct(pnlsChronological);

		// ponytail: canary only, not a fix. computeMaxDrawdownPct seeds its running
		// peak from the hardcoded STARTING_EQUITY (10_000) below, not the real paper
		// balance — on a real account far from that scale (e.g. ~$1,100), the same
		// dollar loss reads as a much smaller %, so the 10%-reduce / 5%-increase
		// rules below are desensitized by roughly (STARTING_EQUITY / realBalance)x.
		// Rewiring the reference equity is the real fix, but it changes drawdown%
		// on every account size and needs a paper-portfolio-init-ordering check
		// (getPaperBalance can read 0 before initPaperPortfolio runs) before it's
		// safe to land blind — flag the mismatch loudly instead of guessing at it.
		const paperBalance = this.store.getPaperBalance("USDT");
		if (paperBalance > 0 && (paperBalance > STARTING_EQUITY * 2 || paperBalance < STARTING_EQUITY / 2)) {
			this.log(
				`drawdown reference-equity mismatch: computeMaxDrawdownPct baseline $${STARTING_EQUITY} vs real paper balance $${paperBalance.toFixed(2)} — drawdown% may be miscalibrated`,
				{ startingEquity: STARTING_EQUITY, paperBalance, maxDrawdownPct },
			);
		}

		// Count consecutive losses from most recent trade backward
		let consecutiveLosses = 0;
		for (const p of pnls) {
			if (p >= 0) break;
			consecutiveLosses++;
		}

		// Load existing state to check pause / improving timers
		const existing = db
			.prepare(`SELECT * FROM dynamic_risk_state WHERE id = 'portfolio'`)
			.get() as StateRow | undefined;

		const pausedUntilMs = existing?.pausedUntilMs ?? 0;
		const improvingSinceMs = existing?.improvingSinceMs ?? null;
		const prevRiskMultiplier = existing?.riskMultiplier ?? 1.0;

		// Still within forced pause window → maintain paused state
		if (pausedUntilMs > now) {
			const remaining = Math.ceil((pausedUntilMs - now) / 60000);
			const adj: DynamicRiskAdjustment = {
				riskMultiplier: PAUSED_RISK_MULTIPLIER,
				stopLossMultiplier: 1.0,
				paused: true,
				reason: `paused: ${remaining}min remaining after ${CONSECUTIVE_LOSS_THRESHOLD} consecutive losses`,
			};
			this.persistState(db, adj, consecutiveLosses, null, adj.reason, pausedUntilMs);
			return adj;
		}

		// Rule: 3 consecutive losses → pause 1 hour at 0.5x risk
		if (consecutiveLosses >= CONSECUTIVE_LOSS_THRESHOLD) {
			const newPauseUntil = now + PAUSE_DURATION_MS;
			const adj: DynamicRiskAdjustment = {
				riskMultiplier: PAUSED_RISK_MULTIPLIER,
				stopLossMultiplier: 1.0,
				paused: true,
				reason: `paused: ${consecutiveLosses} consecutive losses, resuming in 1h at 0.5x risk`,
			};
			this.persistState(db, adj, consecutiveLosses, null, adj.reason, newPauseUntil);
			this.log(adj.reason, { consecutiveLosses, winRate, maxDrawdownPct });
			return adj;
		}

		let riskMultiplier = 1.0;
		let stopLossMultiplier = 1.0;
		let reasons: string[] = [];

		// Rule: max drawdown > 10% → reduce risk by 50%
		if (maxDrawdownPct > DRAWDOWN_REDUCE_THRESHOLD) {
			riskMultiplier = Math.min(riskMultiplier, REDUCED_RISK_MULTIPLIER);
			reasons.push(`drawdown ${maxDrawdownPct.toFixed(1)}% > ${DRAWDOWN_REDUCE_THRESHOLD}%: risk 0.5x`);
		}

		// Rule: win rate < 40% over 20 trades → widen stop-loss by 20%
		if (winRate < WIN_RATE_STOP_WIDEN_THRESHOLD && trades.length >= RECENT_TRADE_WINDOW) {
			stopLossMultiplier = STOP_WIDEN_MULTIPLIER;
			reasons.push(`win rate ${winRate.toFixed(1)}% < ${WIN_RATE_STOP_WIDEN_THRESHOLD}%: stop-loss +20%`);
		}

		// Rule: win rate > 60% AND drawdown < 5% → gradually increase risk (max 1.5x)
		if (winRate > WIN_RATE_INCREASE_THRESHOLD && maxDrawdownPct < DRAWDOWN_INCREASE_CEILING) {
			const newImprovingSince = improvingSinceMs ?? now;
			const improvingForMs = now - newImprovingSince;

			if (improvingForMs >= RESET_IMPROVE_DURATION_MS) {
				// 24h of good performance — boost risk
				riskMultiplier = Math.min(prevRiskMultiplier + IMPROVE_STEP, MAX_RISK_MULTIPLIER);
				reasons.push(`improving 24h+: win ${winRate.toFixed(1)}% dd ${maxDrawdownPct.toFixed(1)}%: risk ${riskMultiplier.toFixed(2)}x`);
				const adj: DynamicRiskAdjustment = {
					riskMultiplier,
					stopLossMultiplier,
					paused: false,
					reason: reasons.join("; "),
				};
				this.persistState(db, adj, consecutiveLosses, newImprovingSince, adj.reason);
				return adj;
			}

			reasons.push(`improving: win ${winRate.toFixed(1)}% dd ${maxDrawdownPct.toFixed(1)}%: tracking 24h`);
			const adj: DynamicRiskAdjustment = {
				riskMultiplier: prevRiskMultiplier < 1.0 ? prevRiskMultiplier : 1.0,
				stopLossMultiplier,
				paused: false,
				reason: reasons.join("; "),
			};
			this.persistState(db, adj, consecutiveLosses, newImprovingSince, adj.reason);
			return adj;
		}

		// Check reset: if we had reduced risk and performance improved for 24h
		if (prevRiskMultiplier < 1.0 && improvingSinceMs !== null) {
			const improvingForMs = now - improvingSinceMs;
			if (improvingForMs >= RESET_IMPROVE_DURATION_MS) {
				reasons.push(`reset: 24h improved performance → base risk restored`);
				const adj: DynamicRiskAdjustment = {
					riskMultiplier: 1.0,
					stopLossMultiplier: 1.0,
					paused: false,
					reason: reasons.join("; ") || "base risk",
				};
				this.persistState(db, adj, consecutiveLosses, null, adj.reason);
				return adj;
			}
		}

		const reason = reasons.length > 0 ? reasons.join("; ") : "normal: no risk adjustments";
		const adj: DynamicRiskAdjustment = { riskMultiplier, stopLossMultiplier, paused: false, reason };
		this.persistState(db, adj, consecutiveLosses, riskMultiplier < 1.0 ? (improvingSinceMs ?? null) : null, reason);
		return adj;
	}

	getAdjustment(): DynamicRiskAdjustment {
		const db = getDb(this.store);
		if (!db) return this.failSafeAdjustment();

		const row = db
			.prepare(`SELECT * FROM dynamic_risk_state WHERE id = 'portfolio'`)
			.get() as StateRow | undefined;

		// ponytail: distinct from baseAdjustment() (which also covers "refreshed, zero
		// trades yet") — this branch means refresh() has literally never persisted a row,
		// e.g. because trade_dynamic_risk_status has never been called. Same multiplier/
		// paused values as base risk (zero behavior change), but the reason string makes
		// "never computed" distinguishable from "computed and found normal" for anyone
		// reading this value, closing the ambiguity a live canary already flagged upstream.
		if (!row) {
			return {
				riskMultiplier: 1.0,
				stopLossMultiplier: 1.0,
				paused: false,
				reason: "base risk (never refreshed — dynamic_risk_state has no row; call trade_dynamic_risk_status or wire refresh() to a scheduler)",
			};
		}

		const now = Date.now();
		const paused = row.pausedUntilMs > now;
		return {
			riskMultiplier: paused ? PAUSED_RISK_MULTIPLIER : row.riskMultiplier,
			stopLossMultiplier: row.stopLossMultiplier,
			paused,
			reason: row.reasonJson ? JSON.parse(row.reasonJson) : "base risk",
		};
	}

	/** Normal baseline when no trade history exists */
	private baseAdjustment(): DynamicRiskAdjustment {
		return { riskMultiplier: 1.0, stopLossMultiplier: 1.0, paused: false, reason: "base risk" };
	}

	/** Fail-safe: when DB is unavailable, reduce risk rather than using full 1.0x exposure */
	private failSafeAdjustment(): DynamicRiskAdjustment {
		return { riskMultiplier: 0.5, stopLossMultiplier: 0.8, paused: false, reason: "fail-safe: reduced risk (DB unavailable)" };
	}

	private persistState(
		db: Database.Database,
		adj: DynamicRiskAdjustment,
		consecutiveLosses: number,
		improvingSinceMs: number | null,
		reason: string,
		pausedUntilMs = 0,
	): void {
		db.prepare(
			`INSERT INTO dynamic_risk_state
				(id, riskMultiplier, stopLossMultiplier, pausedUntilMs, consecutiveLosses, improvingSinceMs, lastUpdatedAt, reasonJson)
			 VALUES ('portfolio', ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				riskMultiplier = excluded.riskMultiplier,
				stopLossMultiplier = excluded.stopLossMultiplier,
				pausedUntilMs = excluded.pausedUntilMs,
				consecutiveLosses = excluded.consecutiveLosses,
				improvingSinceMs = excluded.improvingSinceMs,
				lastUpdatedAt = excluded.lastUpdatedAt,
				reasonJson = excluded.reasonJson`,
		).run(
			adj.riskMultiplier,
			adj.stopLossMultiplier,
			pausedUntilMs,
			consecutiveLosses,
			improvingSinceMs,
			new Date().toISOString(),
			JSON.stringify(reason),
		);
	}

	private log(reason: string, context: Record<string, unknown>): void {
		console.log(`[dynamic-risk] ${reason}`, context);
	}
}
