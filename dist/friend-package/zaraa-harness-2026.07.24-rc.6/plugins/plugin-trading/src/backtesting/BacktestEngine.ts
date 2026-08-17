import { readFileSync } from "node:fs";
import type { Candle, CandleStore } from "../data/candle-store.js";
import type { StrategyRegistry } from "../strategies/strategy-registry.js";
import type { Strategy } from "../strategies/strategy.js";
import { Backtester, type BacktestConfig, type BacktestResult } from "../backtest/backtester.js";
import { generateBacktestReport } from "../backtest/backtest-report.js";

export interface BacktestEngineInput {
	/** Name of a registered strategy (e.g. "mean-reversion", "trend-following") */
	strategyName: string;
	/** Symbol to backtest (e.g. "BTC_USDT") */
	symbol: string;
	/** Candle timeframe (e.g. "1h", "15m") — defaults to strategy.timeframe */
	timeframe?: string;
	/** Inclusive start of the date range */
	startDate: Date;
	/** Inclusive end of the date range */
	endDate: Date;
	/** Starting account equity in USD (default: 10 000) */
	startingEquity?: number;
	/** Risk per trade as % of equity — overrides strategy default if set */
	riskPerTradePct?: number;
	/** Commission per trade in USD (default: 0) */
	commission?: number;
	/** Slippage as % of price (default: 0.05) */
	slippagePct?: number;
	/** Hard cap on position value per trade in USD. When set, riskPerTradePct is
	 *  automatically reduced so no single position can exceed this amount. */
	maxTradeUsd?: number;
}

export interface BacktestEngineResult extends BacktestResult {
	/** Human-readable markdown summary of the backtest */
	report: string;
}

/**
 * High-level orchestrator for running backtests.
 *
 * Wraps the low-level Backtester with strategy-name resolution, date-range
 * candle loading from the store or a CSV file, and max_trade_usd enforcement.
 *
 * The agent handler `trade_backtest` uses this class under the hood.
 */
export class BacktestEngine {
	constructor(
		private strategyRegistry: StrategyRegistry,
		private candleStore?: CandleStore,
	) {}

	/**
	 * Run a backtest by loading candles from the CandleStore for the given date range.
	 */
	run(input: BacktestEngineInput): BacktestEngineResult {
		const strategy = this.resolveStrategy(input.strategyName);
		const timeframe = input.timeframe ?? strategy.timeframe;

		if (!this.candleStore) {
			throw new Error("CandleStore is required for run(). Use runFromCsv() to backtest from a file.");
		}

		const candles = this.candleStore.getRange(
			input.symbol,
			timeframe,
			input.startDate.getTime(),
			input.endDate.getTime(),
		);

		return this.execute(strategy, timeframe, candles, input);
	}

	/**
	 * Run a backtest by loading candles from a CSV file.
	 * Candles are filtered to the specified date range after loading.
	 */
	runFromCsv(input: BacktestEngineInput, csvPath: string): BacktestEngineResult {
		const strategy = this.resolveStrategy(input.strategyName);
		const timeframe = input.timeframe ?? strategy.timeframe;

		const allCandles = BacktestEngine.loadCsv(csvPath, input.symbol, timeframe);
		const fromMs = input.startDate.getTime();
		const toMs = input.endDate.getTime();
		const candles = allCandles.filter((c) => c.openTime >= fromMs && c.openTime <= toMs);

		return this.execute(strategy, timeframe, candles, input);
	}

	private resolveStrategy(name: string): Strategy {
		const strategy = this.strategyRegistry.get(name);
		if (!strategy) {
			const available = this.strategyRegistry.list().map((s) => s.name);
			throw new Error(`Strategy not found: "${name}". Available: ${available.join(", ")}`);
		}
		return strategy;
	}

	private execute(
		strategy: Strategy,
		timeframe: string,
		candles: Candle[],
		input: BacktestEngineInput,
	): BacktestEngineResult {
		if (candles.length === 0) {
			throw new Error(
				`No candles for ${input.symbol} ${timeframe} between ` +
				`${input.startDate.toISOString()} and ${input.endDate.toISOString()}. ` +
				"Load candles first (trade_fetch_candles) or use runFromCsv().",
			);
		}

		const startingEquity = input.startingEquity ?? 10_000;
		let riskPerTradePct = input.riskPerTradePct ?? strategy.riskParams.riskPerTradePct;

		// Enforce maxTradeUsd: shrink riskPerTradePct if it would produce an
		// oversized position relative to account equity.
		if (input.maxTradeUsd != null && input.maxTradeUsd > 0 && startingEquity > 0) {
			const maxRiskPct = (input.maxTradeUsd / startingEquity) * 100;
			if (riskPerTradePct > maxRiskPct) {
				riskPerTradePct = maxRiskPct;
			}
		}

		const config: BacktestConfig = {
			startingEquity,
			riskPerTradePct,
			commission: input.commission ?? 0,
			slippagePct: input.slippagePct ?? 0.05,
		};

		const backtester = new Backtester(config);
		const result = backtester.run(strategy, candles);
		const report = generateBacktestReport(result);

		return { ...result, report };
	}

	/**
	 * Parse OHLCV candles from a CSV file.
	 *
	 * Expected header row (case-insensitive, comma-separated):
	 *   timestamp | openTime, open, high, low, close, volume
	 *
	 * The timestamp column accepts:
	 *   - Unix milliseconds  (e.g. 1704067200000)
	 *   - Unix seconds       (e.g. 1704067200) — auto-detected if < 1e12
	 *   - ISO 8601 strings   (e.g. "2024-01-01T00:00:00.000Z")
	 *
	 * Rows with non-finite or non-positive OHLC values are silently skipped.
	 * Output is sorted ascending by openTime.
	 */
	static loadCsv(csvPath: string, symbol: string, timeframe: string): Candle[] {
		const raw = readFileSync(csvPath, "utf-8");
		const lines = raw.trim().split(/\r?\n/);
		if (lines.length < 2) return [];

		const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/"/g, ""));
		const col = (names: string[]) => {
			for (const n of names) {
				const i = header.indexOf(n);
				if (i !== -1) return i;
			}
			return -1;
		};

		const timeIdx = col(["timestamp", "opentime", "open_time", "date", "datetime", "time"]);
		const openIdx = col(["open"]);
		const highIdx = col(["high"]);
		const lowIdx = col(["low"]);
		const closeIdx = col(["close"]);
		const volIdx = col(["volume", "vol"]);

		if (timeIdx === -1 || openIdx === -1 || closeIdx === -1) {
			throw new Error(
				`CSV at "${csvPath}" must have columns: timestamp/openTime, open, high, low, close, volume. ` +
				`Found: ${header.join(", ")}`,
			);
		}

		const candles: Candle[] = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			const cols = line.split(",");
			if (cols.length < Math.max(timeIdx, openIdx, closeIdx) + 1) continue;

			const rawTime = cols[timeIdx].trim().replace(/"/g, "");
			let openTime: number;
			if (/^\d+(\.\d+)?$/.test(rawTime)) {
				openTime = Math.floor(Number(rawTime));
				if (openTime < 1e12) openTime *= 1000; // convert seconds → ms
			} else {
				openTime = new Date(rawTime).getTime();
			}
			if (!Number.isFinite(openTime) || isNaN(openTime)) continue;

			const open = Number(cols[openIdx]);
			const close = Number(cols[closeIdx]);
			const high = highIdx !== -1 ? Number(cols[highIdx]) : Math.max(open, close);
			const low = lowIdx !== -1 ? Number(cols[lowIdx]) : Math.min(open, close);
			const volume = volIdx !== -1 ? Number(cols[volIdx]) : 0;

			if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) continue;
			if (highIdx !== -1 && (!Number.isFinite(high) || high < Math.max(open, close))) continue;
			if (lowIdx !== -1 && (!Number.isFinite(low) || low > Math.min(open, close))) continue;

			candles.push({ symbol, timeframe, openTime, open, high, low, close, volume: isFinite(volume) ? volume : 0 });
		}

		return candles.sort((a, b) => a.openTime - b.openTime);
	}
}
