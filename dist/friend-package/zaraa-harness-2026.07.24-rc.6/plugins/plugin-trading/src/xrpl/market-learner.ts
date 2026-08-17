/**
 * Market Learner — records daily market observations and discovers patterns.
 *
 * Tracks:
 * - Price movements by time of day (hourly buckets)
 * - Spread patterns (when are spreads widest/tightest?)
 * - Volume & liquidity shifts across sessions
 * - Recurring setups (e.g., "SOLO/XRP spread widens every day at 14:00 UTC")
 * - Order book imbalance trends
 *
 * All data is stored in SQLite alongside the existing trading store.
 * Over time, Zaraa builds intuition about when/where opportunities appear.
 */

import Database from "better-sqlite3";

export interface MarketObservation {
	pair: string;
	midPrice: number | null;
	spreadPct: number | null;
	bidDepth: number;
	askDepth: number;
	imbalanceRatio: number;
	timestamp: number;
}

export interface HourlyPattern {
	hour: number; // 0-23 UTC
	avgSpreadPct: number;
	avgImbalance: number;
	avgPriceChangePct: number;
	sampleCount: number;
	bestOpportunityType: string | null;
}

export interface DailyDigest {
	date: string; // YYYY-MM-DD
	pair: string;
	openPrice: number | null;
	closePrice: number | null;
	highPrice: number | null;
	lowPrice: number | null;
	changePct: number | null;
	avgSpreadPct: number;
	avgImbalance: number;
	observations: number;
	patterns: string[];
}

export interface LearnedPattern {
	id: string;
	pair: string;
	type: string; // "spread_window", "momentum_hour", "imbalance_shift", "price_level"
	description: string;
	confidence: number;
	hourOfDay: number | null; // For time-based patterns
	dayOfWeek: number | null; // 0=Sun, 6=Sat
	details: Record<string, unknown>;
	firstSeen: string;
	lastSeen: string;
	occurrences: number;
}

export class MarketLearner {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.initTables();
	}

	private initTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS market_observations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				pair TEXT NOT NULL,
				midPrice REAL,
				spreadPct REAL,
				bidDepth REAL NOT NULL,
				askDepth REAL NOT NULL,
				imbalanceRatio REAL NOT NULL,
				timestamp INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_obs_pair_time
				ON market_observations (pair, timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_obs_time
				ON market_observations (timestamp DESC);

			CREATE TABLE IF NOT EXISTS learned_patterns (
				id TEXT PRIMARY KEY,
				pair TEXT NOT NULL,
				type TEXT NOT NULL,
				description TEXT NOT NULL,
				confidence REAL NOT NULL,
				hourOfDay INTEGER,
				dayOfWeek INTEGER,
				details TEXT NOT NULL DEFAULT '{}',
				firstSeen TEXT NOT NULL,
				lastSeen TEXT NOT NULL,
				occurrences INTEGER NOT NULL DEFAULT 1
			);
			CREATE INDEX IF NOT EXISTS idx_patterns_pair
				ON learned_patterns (pair, confidence DESC);

			CREATE TABLE IF NOT EXISTS daily_digests (
				date TEXT NOT NULL,
				pair TEXT NOT NULL,
				openPrice REAL,
				closePrice REAL,
				highPrice REAL,
				lowPrice REAL,
				changePct REAL,
				avgSpreadPct REAL,
				avgImbalance REAL,
				observations INTEGER NOT NULL DEFAULT 0,
				patterns TEXT NOT NULL DEFAULT '[]',
				PRIMARY KEY (date, pair)
			);
		`);
	}

	/** Record a single market observation from the DEX watcher */
	recordObservation(obs: MarketObservation): void {
		this.db.prepare(`
			INSERT INTO market_observations (pair, midPrice, spreadPct, bidDepth, askDepth, imbalanceRatio, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(obs.pair, obs.midPrice, obs.spreadPct, obs.bidDepth, obs.askDepth, obs.imbalanceRatio, obs.timestamp);
	}

	/** Get hourly patterns for a pair (what does each hour of the day look like?) */
	getHourlyPatterns(pair: string, days = 7): HourlyPattern[] {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

		const rows = this.db.prepare(`
			SELECT
				CAST(strftime('%H', datetime(timestamp / 1000, 'unixepoch')) AS INTEGER) as hour,
				AVG(spreadPct) as avgSpread,
				AVG(imbalanceRatio) as avgImbalance,
				COUNT(*) as cnt
			FROM market_observations
			WHERE pair = ? AND timestamp > ?
			GROUP BY hour
			ORDER BY hour
		`).all(pair, cutoff) as { hour: number; avgSpread: number; avgImbalance: number; cnt: number }[];

		// Compute average price change per hour
		const priceChanges = new Map<number, number[]>();
		const observations = this.db.prepare(`
			SELECT midPrice, timestamp
			FROM market_observations
			WHERE pair = ? AND timestamp > ? AND midPrice IS NOT NULL
			ORDER BY timestamp ASC
		`).all(pair, cutoff) as { midPrice: number; timestamp: number }[];

		for (let i = 1; i < observations.length; i++) {
			const prev = observations[i - 1];
			const curr = observations[i];
			const hour = new Date(curr.timestamp).getUTCHours();
			const changePct = prev.midPrice > 0 ? ((curr.midPrice - prev.midPrice) / prev.midPrice) * 100 : 0;
			const existing = priceChanges.get(hour) ?? [];
			existing.push(changePct);
			priceChanges.set(hour, existing);
		}

		return rows.map((r) => {
			const changes = priceChanges.get(r.hour) ?? [];
			const avgChange = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
			return {
				hour: r.hour,
				avgSpreadPct: r.avgSpread ?? 0,
				avgImbalance: r.avgImbalance ?? 1,
				avgPriceChangePct: avgChange,
				sampleCount: r.cnt,
				bestOpportunityType: r.avgSpread > 1 ? "spread_capture" : Math.abs(avgChange) > 0.5 ? "momentum" : null,
			};
		});
	}

	/** Generate a daily digest for a pair */
	generateDailyDigest(pair: string, date?: string): DailyDigest | null {
		const targetDate = date ?? new Date().toISOString().slice(0, 10);
		const dayStart = new Date(`${targetDate}T00:00:00Z`).getTime();
		const dayEnd = dayStart + 24 * 60 * 60 * 1000;

		const obs = this.db.prepare(`
			SELECT midPrice, spreadPct, imbalanceRatio, timestamp
			FROM market_observations
			WHERE pair = ? AND timestamp >= ? AND timestamp < ? AND midPrice IS NOT NULL
			ORDER BY timestamp ASC
		`).all(pair, dayStart, dayEnd) as { midPrice: number; spreadPct: number | null; imbalanceRatio: number; timestamp: number }[];

		if (obs.length === 0) return null;

		const prices = obs.map((o) => o.midPrice);
		const spreads = obs.map((o) => o.spreadPct).filter((s): s is number => s != null);
		const imbalances = obs.map((o) => o.imbalanceRatio);

		const openPrice = prices[0];
		const closePrice = prices[prices.length - 1];
		const highPrice = Math.max(...prices);
		const lowPrice = Math.min(...prices);
		const changePct = openPrice > 0 ? ((closePrice - openPrice) / openPrice) * 100 : null;
		const avgSpreadPct = spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0;
		const avgImbalance = imbalances.reduce((a, b) => a + b, 0) / imbalances.length;

		// Detect patterns for this day
		const patterns: string[] = [];

		// Pattern: Wide spread window
		const hourlyData = new Map<number, number[]>();
		for (const o of obs) {
			if (o.spreadPct != null) {
				const hour = new Date(o.timestamp).getUTCHours();
				const existing = hourlyData.get(hour) ?? [];
				existing.push(o.spreadPct);
				hourlyData.set(hour, existing);
			}
		}
		for (const [hour, hourSpreads] of hourlyData) {
			const avg = hourSpreads.reduce((a, b) => a + b, 0) / hourSpreads.length;
			if (avg > avgSpreadPct * 1.5 && avg > 0.8) {
				patterns.push(`Wide spread at ${hour}:00 UTC (${avg.toFixed(2)}%)`);
			}
		}

		// Pattern: Strong directional moves
		if (changePct != null && Math.abs(changePct) > 3) {
			patterns.push(`${changePct > 0 ? "Bullish" : "Bearish"} day: ${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%`);
		}

		// Pattern: Sustained imbalance
		const strongBuyPressure = imbalances.filter((r) => r > 2).length;
		const strongSellPressure = imbalances.filter((r) => r < 0.5).length;
		if (strongBuyPressure > obs.length * 0.5) {
			patterns.push(`Sustained buying pressure (${((strongBuyPressure / obs.length) * 100).toFixed(0)}% of observations)`);
		}
		if (strongSellPressure > obs.length * 0.5) {
			patterns.push(`Sustained selling pressure (${((strongSellPressure / obs.length) * 100).toFixed(0)}% of observations)`);
		}

		const digest: DailyDigest = {
			date: targetDate,
			pair,
			openPrice,
			closePrice,
			highPrice,
			lowPrice,
			changePct,
			avgSpreadPct,
			avgImbalance,
			observations: obs.length,
			patterns,
		};

		// Save digest
		this.db.prepare(`
			INSERT OR REPLACE INTO daily_digests (date, pair, openPrice, closePrice, highPrice, lowPrice, changePct, avgSpreadPct, avgImbalance, observations, patterns)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(targetDate, pair, openPrice, closePrice, highPrice, lowPrice, changePct, avgSpreadPct, avgImbalance, obs.length, JSON.stringify(patterns));

		return digest;
	}

	/** Analyze observations and learn recurring patterns */
	learnPatterns(pair: string, days = 14): LearnedPattern[] {
		const hourly = this.getHourlyPatterns(pair, days);
		const discovered: LearnedPattern[] = [];
		const now = new Date().toISOString();

		// Learn: Best spread capture hours
		// Threshold lowered from 0.8 to 0.5 to capture CEX pairs with tighter spreads
		const spreadHours = hourly
			.filter((h) => h.avgSpreadPct > 0.5 && h.sampleCount >= 3)
			.sort((a, b) => b.avgSpreadPct - a.avgSpreadPct);

		for (const h of spreadHours.slice(0, 3)) {
			const id = `spread_window:${pair}:${h.hour}`;
			const pattern: LearnedPattern = {
				id,
				pair,
				type: "spread_window",
				description: `${pair} spreads widen to ~${h.avgSpreadPct.toFixed(2)}% around ${h.hour}:00 UTC — good market making window`,
				confidence: Math.min(h.avgSpreadPct / 2, 0.9),
				hourOfDay: h.hour,
				dayOfWeek: null,
				details: { avgSpreadPct: h.avgSpreadPct, sampleCount: h.sampleCount },
				firstSeen: now,
				lastSeen: now,
				occurrences: h.sampleCount,
			};
			discovered.push(pattern);
			this.upsertPattern(pattern);
		}

		// Learn: Momentum hours (when does price tend to move?)
		const momentumHours = hourly
			.filter((h) => Math.abs(h.avgPriceChangePct) > 0.3 && h.sampleCount >= 3)
			.sort((a, b) => Math.abs(b.avgPriceChangePct) - Math.abs(a.avgPriceChangePct));

		for (const h of momentumHours.slice(0, 3)) {
			const direction = h.avgPriceChangePct > 0 ? "up" : "down";
			const id = `momentum_hour:${pair}:${h.hour}`;
			const pattern: LearnedPattern = {
				id,
				pair,
				type: "momentum_hour",
				description: `${pair} tends to move ${direction} ~${Math.abs(h.avgPriceChangePct).toFixed(2)}% around ${h.hour}:00 UTC`,
				confidence: Math.min(Math.abs(h.avgPriceChangePct) / 2, 0.8),
				hourOfDay: h.hour,
				dayOfWeek: null,
				details: { avgChangePct: h.avgPriceChangePct, direction, sampleCount: h.sampleCount },
				firstSeen: now,
				lastSeen: now,
				occurrences: h.sampleCount,
			};
			discovered.push(pattern);
			this.upsertPattern(pattern);
		}

		// Learn: Imbalance shift hours (when does buying/selling pressure appear?)
		// Thresholds relaxed from >1.8/<0.55 to >1.5/<0.6 for broader pattern discovery
		const imbalanceHours = hourly
			.filter((h) => (h.avgImbalance > 1.5 || h.avgImbalance < 0.6) && h.sampleCount >= 3)
			.sort((a, b) => Math.abs(b.avgImbalance - 1) - Math.abs(a.avgImbalance - 1));

		for (const h of imbalanceHours.slice(0, 3)) {
			const direction = h.avgImbalance > 1 ? "buy" : "sell";
			const id = `imbalance_shift:${pair}:${h.hour}`;
			const pattern: LearnedPattern = {
				id,
				pair,
				type: "imbalance_shift",
				description: `${pair} shows ${direction} pressure at ${h.hour}:00 UTC (avg ratio ${h.avgImbalance.toFixed(2)})`,
				confidence: Math.min(Math.abs(h.avgImbalance - 1) / 3, 0.75),
				hourOfDay: h.hour,
				dayOfWeek: null,
				details: { avgImbalance: h.avgImbalance, direction, sampleCount: h.sampleCount },
				firstSeen: now,
				lastSeen: now,
				occurrences: h.sampleCount,
			};
			discovered.push(pattern);
			this.upsertPattern(pattern);
		}

		// Learn: Day-of-week patterns from daily digests
		const dayOfWeekRows = this.db.prepare(`
			SELECT
				CAST(strftime('%w', date) AS INTEGER) as dow,
				AVG(changePct) as avgChange,
				AVG(avgSpreadPct) as avgSpread,
				COUNT(*) as cnt
			FROM daily_digests
			WHERE pair = ?
			GROUP BY dow
			HAVING cnt >= 2
		`).all(pair) as { dow: number; avgChange: number; avgSpread: number; cnt: number }[];

		const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		for (const row of dayOfWeekRows) {
			if (Math.abs(row.avgChange) > 1) {
				const id = `day_pattern:${pair}:${row.dow}`;
				const direction = row.avgChange > 0 ? "bullish" : "bearish";
				const pattern: LearnedPattern = {
					id,
					pair,
					type: "day_pattern",
					description: `${pair} tends to be ${direction} on ${dayNames[row.dow]}s (avg ${row.avgChange > 0 ? "+" : ""}${row.avgChange.toFixed(2)}%)`,
					confidence: Math.min(Math.abs(row.avgChange) / 5, 0.7),
					hourOfDay: null,
					dayOfWeek: row.dow,
					details: { avgChange: row.avgChange, avgSpread: row.avgSpread, sampleCount: row.cnt },
					firstSeen: now,
					lastSeen: now,
					occurrences: row.cnt,
				};
				discovered.push(pattern);
				this.upsertPattern(pattern);
			}
		}

		return discovered;
	}

	/** Get all learned patterns for a pair, sorted by confidence */
	getPatterns(pair?: string, minConfidence = 0): LearnedPattern[] {
		const query = pair
			? "SELECT * FROM learned_patterns WHERE pair = ? AND confidence >= ? ORDER BY confidence DESC"
			: "SELECT * FROM learned_patterns WHERE confidence >= ? ORDER BY confidence DESC";
		const params = pair ? [pair, minConfidence] : [minConfidence];

		return (this.db.prepare(query).all(...params) as (Omit<LearnedPattern, "details"> & { details: string })[])
			.map((row) => {
				let details: Record<string, unknown> = {};
				try { details = JSON.parse(row.details); } catch { console.warn("Failed to parse pattern details JSON:", row.details); }
				return { ...row, details };
			});
	}

	/** Get daily digests for a pair */
	getDigests(pair: string, limit = 14): DailyDigest[] {
		return (this.db.prepare(`
			SELECT * FROM daily_digests WHERE pair = ? ORDER BY date DESC LIMIT ?
		`).all(pair, limit) as (Omit<DailyDigest, "patterns"> & { patterns: string })[])
			.map((row) => {
				let patterns: string[] = [];
				try { patterns = JSON.parse(row.patterns); } catch { console.warn("Failed to parse digest patterns JSON:", row.patterns); }
				return { ...row, patterns } as DailyDigest;
			});
	}

	/** Get observation count */
	getObservationCount(pair?: string): number {
		if (pair) {
			const row = this.db.prepare("SELECT COUNT(*) as cnt FROM market_observations WHERE pair = ?").get(pair) as { cnt: number };
			return row.cnt;
		}
		const row = this.db.prepare("SELECT COUNT(*) as cnt FROM market_observations").get() as { cnt: number };
		return row.cnt;
	}

	/** Get latest observations for a pair */
	getRecentObservations(pair: string, limit = 20): MarketObservation[] {
		return this.db.prepare(`
			SELECT pair, midPrice, spreadPct, bidDepth, askDepth, imbalanceRatio, timestamp
			FROM market_observations
			WHERE pair = ?
			ORDER BY timestamp DESC
			LIMIT ?
		`).all(pair, limit) as MarketObservation[];
	}

	/** Backfill daily digests for all dates that have observations but no digest */
	backfillDigests(): number {
		const dates = (this.db.prepare(`
			SELECT DISTINCT date(timestamp/1000, 'unixepoch') as day
			FROM market_observations
			WHERE day NOT IN (SELECT DISTINCT date FROM daily_digests)
		`).all() as { day: string }[]).map(r => r.day);

		const pairs = (this.db.prepare(
			"SELECT DISTINCT pair FROM market_observations",
		).all() as { pair: string }[]).map(r => r.pair);

		let count = 0;
		for (const date of dates) {
			for (const pair of pairs) {
				const digest = this.generateDailyDigest(pair, date);
				if (digest) count++;
			}
		}
		return count;
	}

	/** Clean up old observations (keep last N days) */
	prune(keepDays = 30): number {
		const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
		const result = this.db.prepare("DELETE FROM market_observations WHERE timestamp < ?").run(cutoff);
		return result.changes;
	}

	/** Get a summary of what Zaraa has learned across all pairs */
	getLearningSummary(): {
		totalObservations: number;
		pairsTracked: string[];
		patternsLearned: number;
		topPatterns: LearnedPattern[];
		digestCount: number;
	} {
		const totalObservations = this.getObservationCount();
		const pairs = (this.db.prepare("SELECT DISTINCT pair FROM market_observations").all() as { pair: string }[]).map((r) => r.pair);
		const patternsLearned = (this.db.prepare("SELECT COUNT(*) as cnt FROM learned_patterns").get() as { cnt: number }).cnt;
		const topPatterns = this.getPatterns(undefined, 0.3).slice(0, 10);
		const digestCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM daily_digests").get() as { cnt: number }).cnt;

		return { totalObservations, pairsTracked: pairs, patternsLearned, topPatterns, digestCount };
	}

	private upsertPattern(pattern: LearnedPattern): void {
		const existing = this.db.prepare("SELECT id, occurrences FROM learned_patterns WHERE id = ?").get(pattern.id) as { id: string; occurrences: number } | undefined;

		if (existing) {
			this.db.prepare(`
				UPDATE learned_patterns
				SET description = ?, confidence = ?, details = ?, lastSeen = ?, occurrences = occurrences + 1
				WHERE id = ?
			`).run(pattern.description, pattern.confidence, JSON.stringify(pattern.details), pattern.lastSeen, pattern.id);
		} else {
			this.db.prepare(`
				INSERT INTO learned_patterns (id, pair, type, description, confidence, hourOfDay, dayOfWeek, details, firstSeen, lastSeen, occurrences)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(pattern.id, pattern.pair, pattern.type, pattern.description, pattern.confidence, pattern.hourOfDay, pattern.dayOfWeek, JSON.stringify(pattern.details), pattern.firstSeen, pattern.lastSeen, pattern.occurrences);
		}
	}
}
