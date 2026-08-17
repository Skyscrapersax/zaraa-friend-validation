import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TradingStore } from "../trading-store.js";

const WINDOW_DAYS = 30;
const TOP_N_PROMOTED = 2;
const PROMOTE_WEIGHT = 1.5;
const DEMOTE_WEIGHT = 0.5;
const DEFAULT_WEIGHT = 1.0;
const MIN_TRADES_TO_RANK = 3;
const STARTING_EQUITY = 10_000;

export interface StrategyRankingRow {
	id: string;
	strategyName: string;
	computedAt: string;
	windowStartMs: number;
	windowEndMs: number;
	tradeCount: number;
	winRate: number;
	sharpeRatio: number;
	maxDrawdownPct: number;
	totalPnl: number;
	rank: number;
	signalWeightMultiplier: number;
}

function getDb(store: TradingStore): Database.Database | null {
	const s = store as unknown as { getDb?: () => Database.Database };
	return typeof s.getDb === "function" ? s.getDb() : null;
}

export interface StrategyRankerOptions {
	/**
	 * Database that holds the `strategy_trades` source rows. In production
	 * this is trade-journal.db (TradeJournal/LeaderboardStore file). When
	 * omitted the ranker falls back to `store.getDb()` so the in-memory unit
	 * tests keep working — they insert trades into the same DB they read from.
	 */
	readDb?: Database.Database;
	/**
	 * When true, shadow trades (isShadow=1) are included. Set this when the
	 * runtime is in paperMode — ShadowModeExecutor tags every paper trade as
	 * shadow, so excluding them leaves the ranker blind to the entire paper
	 * book. Live mode keeps the strict exclusion.
	 */
	includeShadow?: boolean;
}

function computeSharpe(pnls: number[]): number {
	if (pnls.length < 2) return 0;
	let eq = STARTING_EQUITY;
	const returns = pnls.map((p) => {
		const r = eq > 0 ? p / eq : 0;
		eq += p;
		return r;
	});
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
	const std = Math.sqrt(variance);
	if (std === 0) return 0;
	return (mean / std) * Math.sqrt(365);
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
	return Math.round(maxDd * 100) / 100;
}

interface TradeRow {
	strategyName: string;
	pnl: number;
	exitedAt: string;
}

export class StrategyRanker {
	private store: TradingStore;
	private readDb: Database.Database | null;
	private includeShadow: boolean;

	constructor(store: TradingStore, options: StrategyRankerOptions = {}) {
		this.store = store;
		this.readDb = options.readDb ?? null;
		this.includeShadow = options.includeShadow ?? false;
	}

	/** DB used for reading `strategy_trades` (the journal). Defaults to the
	 *  store DB so unit tests that seed via `store.getDb()` keep working. */
	private getReadDb(): Database.Database | null {
		return this.readDb ?? getDb(this.store);
	}

	/** DB used for writing `strategy_rankings` (lives in trading.db). */
	private getWriteDb(): Database.Database | null {
		return getDb(this.store);
	}

	updateRankings(): StrategyRankingRow[] {
		const readDb = this.getReadDb();
		const writeDb = this.getWriteDb();
		if (!readDb || !writeDb) return [];

		const now = Date.now();
		const windowStartMs = now - WINDOW_DAYS * 24 * 60 * 60 * 1000;
		const windowStartIso = new Date(windowStartMs).toISOString();
		const shadowFilter = this.includeShadow ? "" : " AND isShadow = 0";

		const rows = readDb
			.prepare(
				`SELECT strategyName, pnl, exitedAt FROM strategy_trades
				 WHERE exitedAt >= ? AND exitedAt IS NOT NULL${shadowFilter}
				 ORDER BY strategyName, exitedAt ASC`,
			)
			.all(windowStartIso) as TradeRow[];

		// Group by strategy
		const byStrategy = new Map<string, number[]>();
		for (const row of rows) {
			if (!byStrategy.has(row.strategyName)) byStrategy.set(row.strategyName, []);
			byStrategy.get(row.strategyName)!.push(row.pnl);
		}

		type RankedEntry = {
			strategyName: string;
			tradeCount: number;
			winRate: number;
			sharpeRatio: number;
			maxDrawdownPct: number;
			totalPnl: number;
		};

		const ranked: RankedEntry[] = [];
		for (const [strategyName, pnls] of byStrategy) {
			if (pnls.length < MIN_TRADES_TO_RANK) continue;
			const wins = pnls.filter((p) => p > 0).length;
			ranked.push({
				strategyName,
				tradeCount: pnls.length,
				winRate: Math.round((wins / pnls.length) * 10000) / 100,
				sharpeRatio: Math.round(computeSharpe(pnls) * 100) / 100,
				maxDrawdownPct: computeMaxDrawdownPct(pnls),
				totalPnl: Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100,
			});
		}

		// Sort: Sharpe desc, then win rate desc
		ranked.sort((a, b) => {
			if (b.sharpeRatio !== a.sharpeRatio) return b.sharpeRatio - a.sharpeRatio;
			return b.winRate - a.winRate;
		});

		const computedAt = new Date().toISOString();
		const insertRow = writeDb.prepare(
			`INSERT INTO strategy_rankings
				(id, strategyName, computedAt, windowStartMs, windowEndMs,
				 tradeCount, winRate, sharpeRatio, maxDrawdownPct, totalPnl, rank, signalWeightMultiplier)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		const results: StrategyRankingRow[] = [];
		const n = ranked.length;

		writeDb.transaction(() => {
			ranked.forEach((entry, idx) => {
				const rank = idx + 1;
				let weight: number;
				if (n <= 1) {
					weight = DEFAULT_WEIGHT;
				} else if (rank <= TOP_N_PROMOTED) {
					weight = PROMOTE_WEIGHT;
				} else if (rank === n) {
					weight = DEMOTE_WEIGHT;
				} else {
					weight = DEFAULT_WEIGHT;
				}

				const row: StrategyRankingRow = {
					id: randomUUID(),
					strategyName: entry.strategyName,
					computedAt,
					windowStartMs,
					windowEndMs: now,
					tradeCount: entry.tradeCount,
					winRate: entry.winRate,
					sharpeRatio: entry.sharpeRatio,
					maxDrawdownPct: entry.maxDrawdownPct,
					totalPnl: entry.totalPnl,
					rank,
					signalWeightMultiplier: weight,
				};

				insertRow.run(
					row.id, row.strategyName, row.computedAt, row.windowStartMs, row.windowEndMs,
					row.tradeCount, row.winRate, row.sharpeRatio, row.maxDrawdownPct, row.totalPnl,
					row.rank, row.signalWeightMultiplier,
				);
				results.push(row);
			});
		})();

		return results;
	}

	getRankings(): StrategyRankingRow[] {
		const db = this.getWriteDb();
		if (!db) return [];

		// Most recent snapshot per strategy — use rowid as tiebreaker for same-ms inserts
		return db
			.prepare(
				`SELECT r.* FROM strategy_rankings r
				 INNER JOIN (
					SELECT strategyName, MAX(rowid) AS maxRowid
					FROM strategy_rankings GROUP BY strategyName
				 ) latest ON r.rowid = latest.maxRowid
				 ORDER BY r.rank ASC`,
			)
			.all() as StrategyRankingRow[];
	}

	getRecommendedWeights(): Record<string, number> {
		const rankings = this.getRankings();
		const weights: Record<string, number> = {};
		for (const row of rankings) {
			weights[row.strategyName] = row.signalWeightMultiplier;
		}
		return weights;
	}
}
