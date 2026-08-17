/**
 * Rolling per-symbol performance tracker.
 *
 * Reads closed positions from trading-store and computes a rolling win rate
 * per symbol over the last N trades. Results are cached in the settings
 * table as JSON so external observers (dashboard, audit reports) can read
 * the same view the gate uses.
 *
 * The audit found persistent loser symbols (e.g. ETH at -$0.26 across the
 * window) and persistent winners (SOL at +$1.12). The gate this tracker
 * powers requires unanimous ensemble + confirmed edge to enter on persistent
 * losers, while keeping winners on the default entry path.
 */
import type { TradingStore } from "../trading-store.js";

const SETTINGS_KEY = "symbol_performance_cache";
const CACHE_TTL_MS = 60_000;

export interface SymbolStats {
	symbol: string;
	trades: number;
	wins: number;
	losses: number;
	winRate: number;
	totalPnl: number;
	updatedAt: number;
}

export interface SymbolPerformanceTrackerConfig {
	/** Trades counted per symbol in the rolling window. Default: 20. */
	rollingWindow: number;
	/** Win-rate threshold below which strict gating kicks in. Default: 0.4. */
	minWinRate: number;
	/** Minimum trades required before gating applies. Default: 10. */
	minTrades: number;
	/** Restrict to paper trades only (filters by isPaper column). Default: undefined = both. */
	isPaper?: boolean;
}

export const DEFAULT_SYMBOL_TRACKER_CONFIG: SymbolPerformanceTrackerConfig = {
	rollingWindow: 20,
	minWinRate: 0.4,
	minTrades: 10,
};

export class SymbolPerformanceTracker {
	private cache = new Map<string, { stats: SymbolStats; ts: number }>();

	constructor(
		private readonly store: TradingStore,
		private readonly config: SymbolPerformanceTrackerConfig = DEFAULT_SYMBOL_TRACKER_CONFIG,
	) {}

	getConfig(): SymbolPerformanceTrackerConfig {
		return this.config;
	}

	/** Compute (or return cached) rolling stats for a symbol. */
	getStats(symbol: string, now: number = Date.now()): SymbolStats {
		const hit = this.cache.get(symbol);
		if (hit && now - hit.ts < CACHE_TTL_MS) return hit.stats;

		const stats = this.computeStats(symbol, now);
		this.cache.set(symbol, { stats, ts: now });
		this.persistCache();
		return stats;
	}

	/**
	 * Returns true when the symbol's rolling win rate is below the threshold
	 * AND we have at least `minTrades` data points. Below `minTrades` the
	 * gate yields (no data → don't penalize).
	 */
	requiresStrictGating(symbol: string, now: number = Date.now()): boolean {
		const stats = this.getStats(symbol, now);
		if (stats.trades < this.config.minTrades) return false;
		return stats.winRate < this.config.minWinRate;
	}

	/** Force a re-read on next getStats() call. */
	invalidate(symbol?: string): void {
		if (symbol) this.cache.delete(symbol);
		else this.cache.clear();
	}

	/**
	 * Render the current cache snapshot. Used by tests and dashboards.
	 */
	snapshot(): Record<string, SymbolStats> {
		const out: Record<string, SymbolStats> = {};
		for (const [sym, entry] of this.cache) out[sym] = entry.stats;
		return out;
	}

	private computeStats(symbol: string, now: number): SymbolStats {
		const rows = this.queryRecent(symbol);
		const trades = rows.length;
		let wins = 0;
		let losses = 0;
		let totalPnl = 0;
		for (const r of rows) {
			const pnl = r.pnl ?? 0;
			totalPnl += pnl;
			if (pnl > 0) wins++;
			else if (pnl < 0) losses++;
		}
		const winRate = trades > 0 ? wins / trades : 0;
		return {
			symbol,
			trades,
			wins,
			losses,
			winRate,
			totalPnl,
			updatedAt: now,
		};
	}

	private queryRecent(symbol: string): Array<{ pnl: number | null }> {
		// Tracker is best-effort. If the store is mocked without a real DB
		// (common in unit tests of unrelated subsystems), or the prepared
		// statement fails for any reason, return empty rows so the gate
		// yields rather than throws.
		try {
			const getDb = (this.store as unknown as { getDb?: () => unknown }).getDb;
			if (typeof getDb !== "function") return [];
			const db = getDb.call(this.store) as
				| { prepare?: (sql: string) => { all?: (...args: unknown[]) => unknown[] } }
				| undefined;
			if (!db || typeof db.prepare !== "function") return [];
			const isPaper = this.config.isPaper;
			const sql = isPaper === undefined
				? "SELECT pnl FROM positions WHERE status = 'closed' AND symbol = ? ORDER BY closedAt DESC, rowid DESC LIMIT ?"
				: "SELECT pnl FROM positions WHERE status = 'closed' AND symbol = ? AND isPaper = ? ORDER BY closedAt DESC, rowid DESC LIMIT ?";
			const stmt = db.prepare(sql);
			if (!stmt || typeof stmt.all !== "function") return [];
			const args = isPaper === undefined
				? [symbol, this.config.rollingWindow]
				: [symbol, isPaper ? 1 : 0, this.config.rollingWindow];
			return stmt.all(...args) as Array<{ pnl: number | null }>;
		} catch {
			return [];
		}
	}

	private persistCache(): void {
		try {
			const payload: Record<string, SymbolStats> = {};
			for (const [sym, entry] of this.cache) payload[sym] = entry.stats;
			this.store.setSetting(SETTINGS_KEY, JSON.stringify(payload));
		} catch {
			// Persist is best-effort — cache is in-memory authoritative.
		}
	}
}
