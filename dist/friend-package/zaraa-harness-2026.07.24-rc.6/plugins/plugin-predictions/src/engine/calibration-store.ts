/**
 * Calibration Store — Track forecasts and outcomes for accuracy measurement.
 *
 * Stores every ensemble forecast alongside its eventual outcome.
 * Uses accumulated data to:
 * 1. Compute per-model Brier scores
 * 2. Fit Platt scaling parameters via logistic regression
 * 3. Identify which categories the ensemble is best/worst at
 */

export interface ForecastRecord {
	id?: number;
	marketId: string;
	question: string;
	category: string;
	/** JSON-encoded model → probability map */
	modelForecasts: Record<string, number>;
	/** Final ensemble probability */
	ensembleForecast: number;
	/** Market price at time of forecast */
	marketPriceAtForecast: number;
	/** When the forecast was made */
	createdAt: number;
	/** 0 or 1, set after market resolves */
	outcome?: number;
	/** When the outcome was recorded */
	resolvedAt?: number;
}

export interface CalibrationBucket {
	/** Midpoint of the bucket (e.g., 0.25 for 20-30% range) */
	midpoint: number;
	/** Average predicted probability in this bucket */
	avgPredicted: number;
	/** Actual outcome rate in this bucket */
	actualRate: number;
	/** Number of forecasts in this bucket */
	count: number;
}

export interface CalibrationReport {
	/** Total forecasts with known outcomes */
	totalResolved: number;
	/** Overall Brier score (lower = better, 0 = perfect) */
	brierScore: number;
	/** Per-model Brier scores */
	modelBrierScores: Record<string, number>;
	/** Calibration buckets (10 buckets: 0-10%, 10-20%, ..., 90-100%) */
	buckets: CalibrationBucket[];
	/** Expected Calibration Error */
	ece: number;
	/** Per-category Brier scores */
	categoryBrierScores: Record<string, number>;
}

type Database = {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...params: unknown[]): { lastInsertRowid: number | bigint };
		get(...params: unknown[]): Record<string, unknown> | undefined;
		all(...params: unknown[]): Record<string, unknown>[];
	};
};

export class CalibrationStore {
	private db: Database;
	/** Count of rows dropped due to corrupted JSON — exposed for monitoring */
	droppedCorruptRows = 0;

	constructor(db: Database) {
		this.db = db;
		this.initialize();
	}

	private initialize(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS prediction_forecasts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				market_id TEXT NOT NULL,
				question TEXT NOT NULL,
				category TEXT NOT NULL,
				model_forecasts TEXT NOT NULL,
				ensemble_forecast REAL NOT NULL,
				market_price REAL NOT NULL,
				created_at INTEGER NOT NULL,
				outcome INTEGER,
				resolved_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_pf_market ON prediction_forecasts(market_id);
			CREATE INDEX IF NOT EXISTS idx_pf_category ON prediction_forecasts(category);
			CREATE INDEX IF NOT EXISTS idx_pf_outcome ON prediction_forecasts(outcome);
		`);
	}

	/** Store a new forecast */
	saveForecast(record: Omit<ForecastRecord, "id">): number {
		const stmt = this.db.prepare(`
			INSERT INTO prediction_forecasts
				(market_id, question, category, model_forecasts, ensemble_forecast, market_price, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		const result = stmt.run(
			record.marketId,
			record.question,
			record.category,
			JSON.stringify(record.modelForecasts),
			record.ensembleForecast,
			record.marketPriceAtForecast,
			record.createdAt,
		);
		return Number(result.lastInsertRowid);
	}

	/** Record the outcome after a market resolves */
	recordOutcome(marketId: string, outcome: 0 | 1): void {
		const stmt = this.db.prepare(`
			UPDATE prediction_forecasts
			SET outcome = ?, resolved_at = ?
			WHERE market_id = ? AND outcome IS NULL
		`);
		stmt.run(outcome, Date.now(), marketId);
	}

	/** Get all resolved forecasts (with known outcomes) */
	getResolvedForecasts(category?: string): ForecastRecord[] {
		const sql = category
			? `SELECT * FROM prediction_forecasts WHERE outcome IS NOT NULL AND category = ? ORDER BY created_at`
			: `SELECT * FROM prediction_forecasts WHERE outcome IS NOT NULL ORDER BY created_at`;
		const rows = category
			? this.db.prepare(sql).all(category)
			: this.db.prepare(sql).all();
		return rows.map(rowToRecord).filter((r): r is ForecastRecord => r !== null);
	}

	/** Get forecasts for a specific market */
	getForecastsForMarket(marketId: string): ForecastRecord[] {
		const rows = this.db.prepare(
			`SELECT * FROM prediction_forecasts WHERE market_id = ? ORDER BY created_at`,
		).all(marketId);
		return rows.map(rowToRecord).filter((r): r is ForecastRecord => r !== null);
	}

	/** Count total forecasts */
	count(): number {
		const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM prediction_forecasts`).get() as { cnt: number };
		return row.cnt;
	}

	/** Number of rows dropped due to corrupted JSON since process start */
	getDroppedCorruptRows(): number {
		return _droppedCorruptRows;
	}

	/**
	 * Generate a full calibration report from all resolved forecasts.
	 */
	getCalibrationReport(): CalibrationReport {
		const resolved = this.getResolvedForecasts();

		if (resolved.length === 0) {
			return {
				totalResolved: 0,
				brierScore: 0,
				modelBrierScores: {},
				buckets: [],
				ece: 0,
				categoryBrierScores: {},
			};
		}

		// Overall Brier score
		let brierSum = 0;
		for (const r of resolved) {
			brierSum += (r.ensembleForecast - r.outcome!) ** 2;
		}
		const brierScore = brierSum / resolved.length;

		// Per-model Brier scores
		const modelBriers: Record<string, { sum: number; count: number }> = {};
		for (const r of resolved) {
			for (const [model, prob] of Object.entries(r.modelForecasts)) {
				if (!modelBriers[model]) modelBriers[model] = { sum: 0, count: 0 };
				modelBriers[model].sum += (prob - r.outcome!) ** 2;
				modelBriers[model].count++;
			}
		}
		const modelBrierScores: Record<string, number> = {};
		for (const [model, data] of Object.entries(modelBriers)) {
			modelBrierScores[model] = Math.round((data.sum / data.count) * 10000) / 10000;
		}

		// Per-category Brier scores
		const catBriers: Record<string, { sum: number; count: number }> = {};
		for (const r of resolved) {
			if (!catBriers[r.category]) catBriers[r.category] = { sum: 0, count: 0 };
			catBriers[r.category].sum += (r.ensembleForecast - r.outcome!) ** 2;
			catBriers[r.category].count++;
		}
		const categoryBrierScores: Record<string, number> = {};
		for (const [cat, data] of Object.entries(catBriers)) {
			categoryBrierScores[cat] = Math.round((data.sum / data.count) * 10000) / 10000;
		}

		// Calibration buckets (10 buckets)
		const buckets = computeCalibrationBuckets(resolved);

		// ECE (Expected Calibration Error)
		let ece = 0;
		const total = resolved.length;
		for (const b of buckets) {
			ece += (b.count / total) * Math.abs(b.actualRate - b.avgPredicted);
		}

		return {
			totalResolved: resolved.length,
			brierScore: Math.round(brierScore * 10000) / 10000,
			modelBrierScores,
			buckets,
			ece: Math.round(ece * 10000) / 10000,
			categoryBrierScores,
		};
	}

	/**
	 * Fit Platt scaling parameters from resolved forecasts.
	 * Uses simple gradient descent on logistic regression.
	 * Returns null if insufficient data (< 30 resolved).
	 */
	fitPlattScaling(category?: string): { a: number; b: number } | null {
		const resolved = category
			? this.getResolvedForecasts(category)
			: this.getResolvedForecasts();

		if (resolved.length < 30) return null;

		// Gradient descent for logistic regression: outcome ~ sigmoid(a * logodds + b)
		let a = 1.0;
		let b = 0.0;
		const lr = 0.01;
		const epochs = 500;

		for (let epoch = 0; epoch < epochs; epoch++) {
			let gradA = 0;
			let gradB = 0;

			for (const r of resolved) {
				const p = Math.max(0.01, Math.min(0.99, r.ensembleForecast));
				const logOdds = Math.log(p / (1 - p));
				const predicted = 1 / (1 + Math.exp(-(a * logOdds + b)));
				const error = predicted - r.outcome!;

				gradA += error * logOdds;
				gradB += error;
			}

			a -= lr * (gradA / resolved.length);
			b -= lr * (gradB / resolved.length);
		}

		return {
			a: Math.round(a * 10000) / 10000,
			b: Math.round(b * 10000) / 10000,
		};
	}
}

// ── Helpers ──

/** Module-level corruption counter — incremented by rowToRecord, read by CalibrationStore */
let _droppedCorruptRows = 0;

function rowToRecord(row: Record<string, unknown>): ForecastRecord | null {
	let modelForecasts: Record<string, number>;
	try {
		modelForecasts = JSON.parse(row.model_forecasts as string);
	} catch (err) {
		_droppedCorruptRows++;
		console.warn("[predictions] corrupted model_forecasts JSON in calibration row (total dropped:", _droppedCorruptRows, "):", err instanceof Error ? err.message : err);
		return null;
	}
	return {
		id: row.id as number,
		marketId: row.market_id as string,
		question: row.question as string,
		category: row.category as string,
		modelForecasts,
		ensembleForecast: row.ensemble_forecast as number,
		marketPriceAtForecast: row.market_price as number,
		createdAt: row.created_at as number,
		outcome: row.outcome as number | undefined,
		resolvedAt: row.resolved_at as number | undefined,
	};
}

function computeCalibrationBuckets(records: ForecastRecord[]): CalibrationBucket[] {
	const bucketData: { predicted: number[]; outcomes: number[] }[] = Array.from(
		{ length: 10 },
		() => ({ predicted: [], outcomes: [] }),
	);

	for (const r of records) {
		const idx = Math.min(9, Math.floor(r.ensembleForecast * 10));
		bucketData[idx].predicted.push(r.ensembleForecast);
		bucketData[idx].outcomes.push(r.outcome!);
	}

	return bucketData
		.map((data, i) => {
			if (data.predicted.length === 0) {
				return {
					midpoint: (i + 0.5) / 10,
					avgPredicted: 0,
					actualRate: 0,
					count: 0,
				};
			}
			return {
				midpoint: (i + 0.5) / 10,
				avgPredicted:
					Math.round(
						(data.predicted.reduce((s, v) => s + v, 0) / data.predicted.length) * 10000,
					) / 10000,
				actualRate:
					Math.round(
						(data.outcomes.reduce((s, v) => s + v, 0) / data.outcomes.length) * 10000,
					) / 10000,
				count: data.predicted.length,
			};
		})
		.filter((b) => b.count > 0);
}
