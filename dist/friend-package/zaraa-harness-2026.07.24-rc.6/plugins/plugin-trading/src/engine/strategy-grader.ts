import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { TradingStore } from "../trading-store.js";

const AGG_SYMBOL = "*";

export type StrategyLifecycleState =
	| "insufficient_data"
	| "promoted"
	| "active"
	| "reduced"
	| "weak"
	| "paused"
	| "archived";

export interface StrategyGraderConfig {
	/** Max closed trades sampled per strategy (most recent first). */
	maxTradesLookback: number;
	/** Minimum closes required before quartiles / multipliers apply. */
	minTradesToGrade: number;
	strategyVersion: string;
	paramsHash: string;
}

const DEFAULT_CONFIG: StrategyGraderConfig = {
	maxTradesLookback: 80,
	minTradesToGrade: 12,
	strategyVersion: "1",
	paramsHash: "",
};

interface ClosedTradeRow {
	pnl: number;
	exitedAt: string;
	regimeraw: string | null;
}

export interface StrategyGradeRunRow {
	id: string;
	strategyName: string;
	symbol: string;
	strategyVersion: string;
	paramsHash: string;
	computedAt: string;
	windowStart: string;
	windowEnd: string;
	closedTradeCount: number;
	rollingProfitFactor: number;
	expectancy: number;
	winRate: number;
	maxEquityDrawdownPct: number;
	regimeBreakdownJson: string;
	compositeScore: number;
	quartile: number;
	lifecycleState: StrategyLifecycleState;
	allocationMultiplier: number;
}

export interface StrategyLifecycleRow {
	strategyName: string;
	symbol: string;
	strategyVersion: string;
	paramsHash: string;
	lifecycleState: StrategyLifecycleState;
	allocationMultiplier: number;
	lastGradeRunId: string | null;
	updatedAt: string;
	detailJson: string | null;
}

interface GradedSlice {
	strategyName: string;
	symbol: string;
	trades: ClosedTradeRow[];
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function computeProfitFactor(pnls: number[]): number {
	let gw = 0;
	let gl = 0;
	for (const p of pnls) {
		if (p > 0) gw += p;
		else if (p < 0) gl += -p;
	}
	if (gl <= 0) return gw > 0 ? 99 : 0;
	return gw / gl;
}

function computeMaxDrawdownPctFromPnls(chronoPnls: number[]): number {
	let eq = 0;
	let peak = 0;
	let maxDd = 0;
	for (const p of chronoPnls) {
		eq += p;
		if (eq > peak) peak = eq;
		const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
		if (dd > maxDd) maxDd = dd;
	}
	return round2(maxDd);
}

function regimeBreakdown(trades: ClosedTradeRow[]): Record<string, number> {
	const m: Record<string, number> = {};
	for (const t of trades) {
		const k = t.regimeraw && t.regimeraw.length > 0 ? t.regimeraw : "unknown";
		m[k] = (m[k] ?? 0) + 1;
	}
	return m;
}

function compositeScore(expectancy: number, profitFactor: number): number {
	const pf = Math.min(Math.max(profitFactor, 0), 6);
	if (expectancy >= 0) {
		return round2(expectancy * Math.min(pf, 3));
	}
	return round2(expectancy * (1 + pf * 0.1));
}

function multiplierForQuartile(q: number): { mult: number; state: StrategyLifecycleState } {
	switch (q) {
		case 0:
			return { mult: 1, state: "promoted" };
		case 1:
			return { mult: 0.75, state: "active" };
		case 2:
			return { mult: 0.5, state: "reduced" };
		default:
			return { mult: 0.25, state: "weak" };
	}
}

function applyRiskOverrides(
	mult: number,
	state: StrategyLifecycleState,
	pf: number,
	expectancy: number,
	n: number,
): { mult: number; state: StrategyLifecycleState } {
	if (pf < 0.55 && n >= 20) {
		return { mult: 0, state: "archived" };
	}
	if (pf < 0.85 && expectancy < 0 && n >= minRiskN(pf)) {
		return { mult: 0, state: "paused" };
	}
	return { mult, state };
}

function minRiskN(pf: number): number {
	return pf < 0.7 ? 12 : 18;
}

function assignQuartiles(scores: number[]): number[] {
	const order = scores
		.map((s, i) => ({ s, i }))
		.sort((a, b) => b.s - a.s);
	const n = order.length;
	const out = new Array<number>(n).fill(3);
	for (let rank = 0; rank < n; rank++) {
		const q = Math.min(3, Math.floor((4 * rank) / n));
		out[order[rank].i] = q;
	}
	return out;
}

function getTradingDb(store: TradingStore): Database.Database | null {
	const maybe = store as unknown as { getDb?: () => Database.Database };
	return typeof maybe.getDb === "function" ? maybe.getDb() : null;
}

/**
 * Read sizing multiplier for a strategy/symbol pair.
 * Uses per-strategy rollup (`*`) only in v1; returns 1 if no row.
 * Returns 1 when the store has no getDb() (test mocks) so sizing stays unchanged.
 */
export function getStrategyGradeMultiplier(store: TradingStore, strategyName: string, _symbol: string): number {
	const db = getTradingDb(store);
	if (!db) return 1;
	const row = db
		.prepare(
			`SELECT allocationMultiplier FROM strategy_lifecycle
			 WHERE strategyName = ? AND symbol = ? AND strategyVersion = ? AND paramsHash = ?`,
		)
		.get(strategyName, AGG_SYMBOL, DEFAULT_CONFIG.strategyVersion, DEFAULT_CONFIG.paramsHash) as
			| { allocationMultiplier: number }
			| undefined;
	if (!row) return 1;
	const m = Number(row.allocationMultiplier);
	return Number.isFinite(m) && m >= 0 ? m : 1;
}

export function listStrategyLifecycles(store: TradingStore): StrategyLifecycleRow[] {
	const db = getTradingDb(store);
	if (!db) return [];
	return db.prepare(`SELECT * FROM strategy_lifecycle ORDER BY updatedAt DESC`).all() as StrategyLifecycleRow[];
}

function loadClosedTrades(
	db: Database.Database,
	strategyName: string,
	symbol: string | null,
	limit: number,
	includeShadow: boolean,
): ClosedTradeRow[] {
	const shadowFilter = includeShadow ? "" : " AND isShadow = 0";
	if (symbol === null) {
		return db
			.prepare(
				`SELECT pnl, exitedAt, regime AS regimeraw FROM strategy_trades
				 WHERE strategyName = ? AND exitedAt IS NOT NULL${shadowFilter}
				 ORDER BY exitedAt DESC LIMIT ?`,
			)
			.all(strategyName, limit) as ClosedTradeRow[];
	}
	return db
		.prepare(
			`SELECT pnl, exitedAt, regime AS regimeraw FROM strategy_trades
			 WHERE strategyName = ? AND symbol = ? AND exitedAt IS NOT NULL${shadowFilter}
			 ORDER BY exitedAt DESC LIMIT ?`,
		)
		.all(strategyName, symbol, limit) as ClosedTradeRow[];
}

function gradeSlice(slice: GradedSlice, config: StrategyGraderConfig): Omit<StrategyGradeRunRow, "quartile" | "lifecycleState" | "allocationMultiplier" | "id" | "computedAt" | "strategyVersion" | "paramsHash"> | null {
	const trades = slice.trades;
	if (trades.length === 0) return null;
	const pnlsDesc = trades.map((t) => t.pnl);
	const chrono = [...trades].sort((a, b) => a.exitedAt.localeCompare(b.exitedAt)).map((t) => t.pnl);
	const winRate = pnlsDesc.filter((p) => p > 0).length / pnlsDesc.length;
	const expectancy = pnlsDesc.reduce((s, p) => s + p, 0) / pnlsDesc.length;
	const rollingProfitFactor = round2(computeProfitFactor(pnlsDesc));
	const maxEquityDrawdownPct = computeMaxDrawdownPctFromPnls(chrono);
	const regimeBreakdownJson = JSON.stringify(regimeBreakdown(trades));
	const windowEnd = trades[0]?.exitedAt ?? "";
	const windowStart = trades.at(-1)?.exitedAt ?? "";
	const comp = compositeScore(round2(expectancy), rollingProfitFactor);

	return {
		strategyName: slice.strategyName,
		symbol: slice.symbol,
		windowStart,
		windowEnd,
		closedTradeCount: trades.length,
		rollingProfitFactor,
		expectancy: round2(expectancy),
		winRate: round2(winRate),
		maxEquityDrawdownPct,
		regimeBreakdownJson,
		compositeScore: comp,
	};
}

export interface RefreshStrategyGradesOptions extends Partial<StrategyGraderConfig> {
	/**
	 * Database that holds `strategy_trades` rows. In production this is
	 * trade-journal.db (TradeJournal/LeaderboardStore file). When omitted
	 * the grader falls back to `store.getDb()` so in-memory unit tests
	 * (which seed via store.getDb()) keep working.
	 */
	readDb?: Database.Database;
	/**
	 * When true, shadow trades (isShadow=1) are included. Set this when
	 * the runtime is in paperMode — ShadowModeExecutor tags every paper
	 * trade as shadow, so excluding them leaves the grader blind to the
	 * entire paper book. Live mode keeps the strict exclusion.
	 */
	includeShadow?: boolean;
}

/**
 * Recompute grades from `strategy_trades`, assign cross-strategy quartiles on rollups (`*`),
 * persist runs and upsert `strategy_lifecycle`.
 */
export function refreshStrategyGrades(
	store: TradingStore,
	options: RefreshStrategyGradesOptions = {},
): {
	gradedStrategies: number;
	runsInserted: number;
} {
	const { readDb: optReadDb, includeShadow = false, ...partialConfig } = options;
	const config = { ...DEFAULT_CONFIG, ...partialConfig };
	const writeDb = getTradingDb(store);
	if (!writeDb) {
		return { gradedStrategies: 0, runsInserted: 0 };
	}
	const readDb = optReadDb ?? writeDb;
	const shadowFilter = includeShadow ? "" : " AND isShadow = 0";

	const strategies = readDb
		.prepare(
			`SELECT DISTINCT strategyName FROM strategy_trades WHERE exitedAt IS NOT NULL${shadowFilter} ORDER BY strategyName`,
		)
		.all() as { strategyName: string }[];

	const slices: GradedSlice[] = [];
	for (const { strategyName } of strategies) {
		const aggTrades = loadClosedTrades(readDb, strategyName, null, config.maxTradesLookback, includeShadow);
		slices.push({ strategyName, symbol: AGG_SYMBOL, trades: aggTrades });
	}

	const rollupParts: Array<
		NonNullable<ReturnType<typeof gradeSlice>> & { strategyName: string; symbol: string }
	> = [];

	for (const slice of slices) {
		const g = gradeSlice(slice, config);
		if (!g) continue;
		rollupParts.push({ ...g, strategyName: slice.strategyName, symbol: slice.symbol });
	}

	const eligible = rollupParts.filter((p) => p.closedTradeCount >= config.minTradesToGrade);
	const scores = eligible.map((p) => p.compositeScore);
	const quartileByKey = new Map<string, number>();
	if (eligible.length > 0) {
		const quartiles = assignQuartiles(scores);
		for (let i = 0; i < eligible.length; i++) {
			quartileByKey.set(`${eligible[i].strategyName}|${eligible[i].symbol}`, quartiles[i]);
		}
	}

	const now = new Date().toISOString();
	let runsInserted = 0;

	const insertRun = writeDb.prepare(
		`INSERT INTO strategy_grade_runs (
			id, strategyName, symbol, strategyVersion, paramsHash, computedAt,
			windowStart, windowEnd, closedTradeCount, rollingProfitFactor, expectancy, winRate,
			maxEquityDrawdownPct, regimeBreakdownJson, compositeScore, quartile, lifecycleState, allocationMultiplier
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const upsertLife = writeDb.prepare(
		`INSERT INTO strategy_lifecycle (
			strategyName, symbol, strategyVersion, paramsHash,
			lifecycleState, allocationMultiplier, lastGradeRunId, updatedAt, detailJson
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(strategyName, symbol, strategyVersion, paramsHash) DO UPDATE SET
			lifecycleState = excluded.lifecycleState,
			allocationMultiplier = excluded.allocationMultiplier,
			lastGradeRunId = excluded.lastGradeRunId,
			updatedAt = excluded.updatedAt,
			detailJson = excluded.detailJson`,
	);

	for (const slice of slices) {
		const base = gradeSlice(slice, config);
		if (!base) continue;

		const key = `${slice.strategyName}|${slice.symbol}`;
		const n = base.closedTradeCount;
		let quartile = 3;
		let lifecycleState: StrategyLifecycleState = "insufficient_data";
		let allocationMultiplier = 1;

		if (n < config.minTradesToGrade) {
			lifecycleState = "insufficient_data";
			allocationMultiplier = 1;
		} else {
			quartile = quartileByKey.get(key) ?? 3;
			const tier = multiplierForQuartile(quartile);
			const risk = applyRiskOverrides(tier.mult, tier.state, base.rollingProfitFactor, base.expectancy, n);
			allocationMultiplier = risk.mult;
			lifecycleState = risk.state;
		}

		const id = randomUUID();
		insertRun.run(
			id,
			base.strategyName,
			base.symbol,
			config.strategyVersion,
			config.paramsHash,
			now,
			base.windowStart,
			base.windowEnd,
			base.closedTradeCount,
			base.rollingProfitFactor,
			base.expectancy,
			base.winRate,
			base.maxEquityDrawdownPct,
			base.regimeBreakdownJson,
			base.compositeScore,
			quartile,
			lifecycleState,
			allocationMultiplier,
		);
		runsInserted++;

		if (base.symbol === AGG_SYMBOL) {
			upsertLife.run(
				base.strategyName,
				AGG_SYMBOL,
				config.strategyVersion,
				config.paramsHash,
				lifecycleState,
				allocationMultiplier,
				id,
				now,
				JSON.stringify({
					quartile,
					compositeScore: base.compositeScore,
					rollingProfitFactor: base.rollingProfitFactor,
					expectancy: base.expectancy,
					closedTradeCount: base.closedTradeCount,
				}),
			);
		}
	}

	return { gradedStrategies: strategies.length, runsInserted };
}
