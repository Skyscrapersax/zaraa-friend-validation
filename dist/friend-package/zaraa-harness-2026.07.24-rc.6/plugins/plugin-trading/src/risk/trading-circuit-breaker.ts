import type Database from "better-sqlite3";
import {
	DEFAULT_VOL_REGIME_BANDS,
	type VolRegime,
	type VolRegimeBands,
	classifyVolRegime,
	scaleForRegime,
} from "./volatility-estimator.js";

export type BreakerType = "consecutive_loss" | "drawdown" | "velocity" | "policy_volume";

export interface BreakerRow {
	id: number;
	breaker_type: BreakerType;
	trip_count: number;
	is_tripped: number; // SQLite stores booleans as 0/1
	trip_reason: string | null;
	tripped_at: string | null;
	cooldown_until: string | null;
	peak_equity: number;
	consecutive_losses: number;
	last_updated: string;
}

export interface BreakerStatus {
	halted: boolean;
	reasons: string[];
}

export interface TradingCircuitBreakerConfig {
	/** Max consecutive losses before halting. Default: 5 */
	maxConsecutiveLosses?: number;
	/** Max drawdown % before halting. Default: 10 */
	maxDrawdownPct?: number;
	/** Velocity window for fast-drop detection in ms. Default: 10 minutes */
	velocityWindowMs?: number;
	/** Min equity drop % within the velocity window to trip. Default: 5 */
	velocityDropPct?: number;
	/** How often to flush velocity buffer to equity_snapshots (ms). Default: 5 minutes */
	persistIntervalMs?: number;
	/** Cooldown period in ms before auto-resetting tripped breakers. Default: 4 hours (14400000). Set to 0 to disable auto-reset. */
	cooldownMs?: number;
	/** Vol-adaptive CB: scale drawdown/velocity thresholds by current vol regime. Default: false (disabled). */
	useVolAdaptiveCB?: boolean;
	/** Bands defining low/normal/high regimes + their threshold multipliers. */
	volRegimeBands?: VolRegimeBands;
	/** Current annualized vol used to derive the regime. Caller is responsible for refreshing. */
	currentAnnualizedVol?: number;
	// ── Equity sanity guards (added 2026-05-09 after the 5/8 ticker-timeout incident) ──
	// TODO(config): expose under `trading.circuitBreaker` in zaraa.config.json so
	// these can be tuned without a code change. Hardcoded sensible defaults for now.
	/** Rolling buffer size for median-smoothing the equity reading used in the
	 *  drawdown comparison. A single outlier tick can't move the median when
	 *  the buffer holds ≥3 entries. Default: 5. */
	equitySmoothingWindow?: number;
	/** A tick-to-tick drop ≥ this pct within `suspiciousTickWindowMs` is treated
	 *  as a likely feed glitch (skips drawdown evaluation until confirmed by
	 *  `suspiciousTickConfirmCount` consecutive ticks). Default: 15. */
	suspiciousTickDropPct?: number;
	/** Max ms between the previous and current tick for the rate-of-change guard
	 *  to apply. Drops spread over longer than this window are treated as real.
	 *  Default: 5 minutes. */
	suspiciousTickWindowMs?: number;
	/** Number of consecutive ticks that must remain in the drop zone (≥
	 *  `suspiciousTickDropPct` below the pre-drop baseline) before the drawdown
	 *  CB is allowed to evaluate. Default: 3. */
	suspiciousTickConfirmCount?: number;
	/** Configured starting capital (paper `virtual_balance_usd`, or the live
	 *  initial equity). On startup the drawdown peak high-water mark is floored at
	 *  this value so drawdown is always measured from at least the real starting
	 *  balance — even when `equity_snapshots` never recorded a tick at the full
	 *  starting balance (e.g. snapshots began after equity had already dipped a few
	 *  dollars), which would otherwise pin the peak below the starting capital via
	 *  the snapshot-cap and UNDER-report drawdown. The floor only ever RAISES the
	 *  peak, so it tightens (never loosens) the breaker. Default: 0 (no floor —
	 *  preserves legacy behavior for callers that don't supply it). */
	virtualBalance?: number;
}

interface EquityPoint {
	timestamp: number; // ms epoch
	equity: number;
}

/**
 * Persistent trading risk circuit breaker.
 *
 * Manages three breakers:
 *   - consecutive_loss: trips after N consecutive losing trades
 *   - drawdown: trips when equity falls N% below peak
 *   - velocity: trips when equity drops >N% within a rolling time window
 *
 * All state is persisted to the circuit_breaker_state SQLite table so that
 * trips survive process restarts. The drawdown peak_equity and consecutive loss
 * counter are restored from the DB on construction.
 */
export class TradingCircuitBreaker {
	private db: Database.Database;
	private readonly baseMaxDrawdownPct: number;
	private readonly baseVelocityDropPct: number;
	private readonly maxConsecutiveLosses: number;
	private maxDrawdownPct: number;
	private readonly velocityWindowMs: number;
	private velocityDropPct: number;
	private readonly persistIntervalMs: number;
	private readonly cooldownMs: number;
	private readonly useVolAdaptiveCB: boolean;
	private readonly volRegimeBands: VolRegimeBands;
	private currentVolRegime: VolRegime = "normal";
	// Equity sanity guards (see config docs above)
	private readonly equitySmoothingWindow: number;
	private readonly suspiciousTickDropPct: number;
	private readonly suspiciousTickWindowMs: number;
	private readonly suspiciousTickConfirmCount: number;
	/** Configured starting capital used as the drawdown peak floor on startup. 0 = no floor. */
	private readonly virtualBalance: number;

	// In-memory state — kept in sync with the DB on every change
	private consecutiveLosses = 0;
	private peakEquity = 0;
	private lastEquity = 0;
	private lastEquityTimestampMs = 0;
	private consecutiveLossTripped = false;
	private drawdownTripped = false;
	private velocityTripped = false;
	/** Previous sample's drop pct; velocity only trips when two consecutive
	 * samples both exceed velocityDropPct. Guards against single spurious
	 * equity readings (see 2026-04-18 01:46:03 incident — $1087 was a
	 * single spike between $1178 neighbors). */
	private pendingVelocityDropPct = 0;
	/** Drawdown pct on the previous sample; drawdown only trips when two
	 * consecutive samples both exceed maxDrawdownPct. Same guard as velocity —
	 * a single bad equity tick should not halt trading. */
	private pendingDrawdownPct = 0;

	// Velocity ring buffer — flushed to equity_snapshots periodically
	private equityBuffer: EquityPoint[] = [];
	private lastPersistTime = 0;
	// Median-smoothing buffer (in-memory only; rebuilt naturally after restart).
	private equitySmoothingBuffer: EquityPoint[] = [];
	// Frozen pre-drop baseline; non-null while a suspicious drop is being confirmed.
	private suspiciousBaseline: EquityPoint | null = null;
	private consecutiveSuspiciousTicks = 0;

	constructor(db: Database.Database, config: TradingCircuitBreakerConfig = {}) {
		this.db = db;
		this.maxConsecutiveLosses = config.maxConsecutiveLosses ?? 5;
		this.baseMaxDrawdownPct = config.maxDrawdownPct ?? 10;
		this.baseVelocityDropPct = config.velocityDropPct ?? 5;
		this.maxDrawdownPct = this.baseMaxDrawdownPct;
		this.velocityWindowMs = config.velocityWindowMs ?? 10 * 60 * 1000;
		this.velocityDropPct = this.baseVelocityDropPct;
		this.persistIntervalMs = config.persistIntervalMs ?? 5 * 60 * 1000;
		this.cooldownMs = config.cooldownMs ?? 4 * 60 * 60 * 1000; // 4 hours default
		this.useVolAdaptiveCB = config.useVolAdaptiveCB ?? false;
		this.volRegimeBands = config.volRegimeBands ?? DEFAULT_VOL_REGIME_BANDS;
		this.equitySmoothingWindow = config.equitySmoothingWindow ?? 5;
		this.suspiciousTickDropPct = config.suspiciousTickDropPct ?? 15;
		this.suspiciousTickWindowMs = config.suspiciousTickWindowMs ?? 5 * 60 * 1000;
		this.suspiciousTickConfirmCount = config.suspiciousTickConfirmCount ?? 3;
		this.virtualBalance =
			typeof config.virtualBalance === "number" &&
			Number.isFinite(config.virtualBalance) &&
			config.virtualBalance > 0
				? config.virtualBalance
				: 0;
		if (this.useVolAdaptiveCB && config.currentAnnualizedVol !== undefined) {
			this.applyVolRegime(config.currentAnnualizedVol);
		}

		this.loadFromDb();
	}

	/**
	 * Update the current vol regime estimate. No-op when useVolAdaptiveCB=false.
	 * Caller is expected to pass a fresh annualized vol estimate (e.g., from
	 * realizedVolEwma over recent candles). Drawdown / velocity thresholds
	 * are scaled relative to the constructor-time base values.
	 */
	updateVolRegime(annualizedVol: number): VolRegime {
		this.currentVolRegime = classifyVolRegime(annualizedVol, this.volRegimeBands);
		if (!this.useVolAdaptiveCB) return this.currentVolRegime;
		this.applyVolRegime(annualizedVol);
		return this.currentVolRegime;
	}

	getCurrentVolRegime(): VolRegime {
		return this.currentVolRegime;
	}

	getActiveThresholds(): { maxDrawdownPct: number; velocityDropPct: number; regime: VolRegime } {
		return {
			maxDrawdownPct: this.maxDrawdownPct,
			velocityDropPct: this.velocityDropPct,
			regime: this.currentVolRegime,
		};
	}

	private applyVolRegime(annualizedVol: number): void {
		this.currentVolRegime = classifyVolRegime(annualizedVol, this.volRegimeBands);
		const scale = scaleForRegime(this.currentVolRegime, this.volRegimeBands);
		this.maxDrawdownPct = this.baseMaxDrawdownPct * scale;
		this.velocityDropPct = this.baseVelocityDropPct * scale;
	}

	private ensurePrunedArchive(): void {
		this.db
			.prepare(
				`CREATE TABLE IF NOT EXISTS equity_snapshots_pruned (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					timestamp TEXT NOT NULL,
					equity REAL NOT NULL,
					pruned_at TEXT NOT NULL,
					pruned_reason TEXT NOT NULL
				)`,
			)
			.run();
		this.db
			.prepare(
				"CREATE INDEX IF NOT EXISTS idx_equity_snapshots_pruned_pruned_at ON equity_snapshots_pruned(pruned_at)",
			)
			.run();
	}

	private loadFromDb(): void {
		const rows = this.db
			.prepare(
				"SELECT * FROM circuit_breaker_state WHERE breaker_type IN ('consecutive_loss', 'drawdown', 'velocity')",
			)
			.all() as BreakerRow[];

		for (const row of rows) {
			if (row.breaker_type === "consecutive_loss") {
				this.consecutiveLosses = row.consecutive_losses;
				this.consecutiveLossTripped = row.is_tripped === 1;
			} else if (row.breaker_type === "drawdown") {
				this.peakEquity = row.peak_equity;
				this.drawdownTripped = row.is_tripped === 1;
			} else if (row.breaker_type === "velocity") {
				this.velocityTripped = row.is_tripped === 1;
			}
		}

		// If the CB was manually reset (is_tripped=0) but peak_equity still holds
		// a stale high-water mark that exceeds equity_snapshots, cap the peak to
		// what equity_snapshots actually recorded. Without this, the CB would
		// re-trip on the very next equity tick after a manual reset — because the
		// stored watermark is from a drawdown that was already acknowledged.
		// Only applies when NOT tripped: a legitimately tripped CB must keep its
		// historical peak so drawdown% is measured from the real high-water mark.
		if (!this.drawdownTripped && this.peakEquity > 0) {
			const snapRow = this.db
				.prepare("SELECT MAX(equity) as peak FROM equity_snapshots WHERE equity > 0")
				.get() as { peak: number | null } | undefined;
			const snapPeak = snapRow?.peak ?? 0;
			if (snapPeak > 0 && snapPeak < this.peakEquity) {
				// Never cap below configured starting capital: equity_snapshots often
				// miss the first full-balance tick, so snapPeak < virtualBalance. Capping
				// to snapPeak then flooring back to virtualBalance on every boot caused
				// permanent restart thrash (two warns + two writes per launch).
				const startFloor = this.virtualBalance > 0 ? this.virtualBalance : 0;
				const nextPeak = Math.max(snapPeak, startFloor);
				if (nextPeak + 1e-9 < this.peakEquity) {
					console.warn(
						`[circuit-breaker] stale stored peak ${this.peakEquity.toFixed(2)} exceeds equity_snapshots MAX ${snapPeak.toFixed(2)} — capping to ${nextPeak.toFixed(2)} on startup (breaker was not tripped${startFloor > snapPeak ? `; held at starting capital floor ${startFloor.toFixed(2)}` : ""})`,
					);
					this.peakEquity = nextPeak;
					this.writeBreaker("drawdown", { peak_equity: nextPeak });
				}
			}

			// Final safety net: if the (possibly snapshot-capped) peak is STILL so far
			// above the most recent equity reading that the next tick would immediately
			// trip the drawdown CB, treat the peak as poisoned (stale historical high
			// from a phantom-loss bug, a paper-equity glitch, or a previous live mode
			// the operator already lived through). Reset peak to current equity to
			// prevent perpetual re-trips after a manual reset.
			//
			// This ONLY fires when the CB is not currently tripped — a legitimately
			// tripped CB must keep its historical peak so the operator sees the real
			// drawdown% in audit logs.
			const currentRow = this.db
				.prepare(
					"SELECT equity FROM equity_snapshots WHERE equity > 0 ORDER BY timestamp DESC LIMIT 1",
				)
				.get() as { equity: number } | undefined;
			const currentEquity = currentRow?.equity ?? 0;
			if (currentEquity > 0 && this.peakEquity > currentEquity) {
				const impliedDrawdownPct =
					((this.peakEquity - currentEquity) / this.peakEquity) * 100;
				if (impliedDrawdownPct >= this.maxDrawdownPct) {
					console.warn(
						`[circuit-breaker] stored peak ${this.peakEquity.toFixed(2)} would immediately re-trip drawdown CB vs latest equity ${currentEquity.toFixed(2)} (${impliedDrawdownPct.toFixed(2)}% implied drawdown ≥ ${this.maxDrawdownPct}% threshold) — peak treated as poisoned, resetting baseline to current equity`,
					);
					this.peakEquity = currentEquity;
					this.writeBreaker("drawdown", { peak_equity: currentEquity });
				}
			}

			// Snapshot poison detector: even when the stored CB peak is clean (often
			// because the operator just manually reset it via SQL), MAX(equity_snapshots)
			// can still hold a stale high-water mark from a prior phantom-loss bug or
			// paper-equity glitch. Because handlers.ts calls
			// `syncPeakFromStore(store.getPeakEquity())` before every recordEquity tick,
			// the very next tick would re-poison the CB peak from the store's MAX and
			// trip drawdown immediately. Quarantine snapshot rows above the (clean) stored
			// peak (move them to equity_snapshots_pruned with reason+timestamp) so
			// getPeakEquity() can no longer surface poisoned history while audit history
			// is preserved for post-incident review and operator restoration.
			if (currentEquity > 0 && this.peakEquity > 0 && snapPeak > this.peakEquity) {
				const impliedSnapDrawdownPct =
					((snapPeak - currentEquity) / snapPeak) * 100;
				if (impliedSnapDrawdownPct >= this.maxDrawdownPct) {
					this.ensurePrunedArchive();
					const prunedAt = new Date().toISOString();
					const reason = `poison-detector: snapPeak=${snapPeak.toFixed(2)}, currentEquity=${currentEquity.toFixed(2)}, impliedDD=${impliedSnapDrawdownPct.toFixed(2)}%, storedPeak=${this.peakEquity.toFixed(2)}`;
					const archive = this.db
						.prepare(
							"INSERT INTO equity_snapshots_pruned (timestamp, equity, pruned_at, pruned_reason) SELECT timestamp, equity, ?, ? FROM equity_snapshots WHERE equity > ?",
						)
						.run(prunedAt, reason, this.peakEquity);
					const pruned = this.db
						.prepare("DELETE FROM equity_snapshots WHERE equity > ?")
						.run(this.peakEquity);
					console.warn(
						`[circuit-breaker] equity_snapshots MAX ${snapPeak.toFixed(2)} would re-poison drawdown CB via syncPeakFromStore (${impliedSnapDrawdownPct.toFixed(2)}% implied DD vs latest equity ${currentEquity.toFixed(2)} ≥ ${this.maxDrawdownPct}% threshold) — quarantined ${pruned.changes} snapshot row(s) above stored peak ${this.peakEquity.toFixed(2)} into equity_snapshots_pruned (archived ${archive.changes}) so the next equity tick cannot re-poison the breaker; restore via \`INSERT INTO equity_snapshots SELECT timestamp, equity FROM equity_snapshots_pruned WHERE pruned_at = '${prunedAt}'\``,
					);
				}
			}
		}

		// Floor the drawdown high-water mark at the configured starting capital.
		// The snapshot-cap above pins the peak to MAX(equity_snapshots); if
		// equity_snapshots never recorded a tick at the full starting balance —
		// e.g. the first snapshot was taken after equity had already dipped a few
		// dollars — the peak gets stuck below the real starting capital and drawdown
		// is then UNDER-reported (measured from the lower peak). Restoring the floor
		// only ever RAISES the peak, so it tightens (never loosens) the breaker, and
		// it also seeds the peak on a first-ever startup where no snapshots exist yet.
		//
		// Applied AFTER the snapshot-cap/poison block on purpose: were it applied
		// before, the cap would immediately pull the floored peak back down to
		// MAX(equity_snapshots). The poison detectors above already guarantee the
		// floored peak cannot self-trip — they refuse/reset any peak whose implied
		// drawdown vs latest equity meets the threshold, and a starting-capital floor
		// is by construction at or below a non-poisoned historical high.
		if (this.virtualBalance > 0 && this.peakEquity < this.virtualBalance) {
			if (this.peakEquity > 0) {
				console.warn(
					`[circuit-breaker] drawdown peak ${this.peakEquity.toFixed(2)} is below configured starting capital ${this.virtualBalance.toFixed(2)} — flooring peak to starting capital so drawdown is measured from the real high-water mark`,
				);
			}
			this.peakEquity = this.virtualBalance;
			this.writeBreaker("drawdown", { peak_equity: this.virtualBalance });
		}

		// Reload velocity ring buffer from persisted equity snapshots for crash recovery.
		// If the restored buffer already shows a >N% drop, keep velocity tripped.
		const windowStart = new Date(Date.now() - this.velocityWindowMs).toISOString();
		const snapshots = this.db
			.prepare(
				"SELECT timestamp, equity FROM equity_snapshots WHERE timestamp >= ? ORDER BY timestamp ASC",
			)
			.all(windowStart) as { timestamp: string; equity: number }[];

		this.equityBuffer = snapshots.map((s) => ({
			timestamp: new Date(s.timestamp).getTime(),
			equity: s.equity,
		}));

		if (!this.velocityTripped && this.equityBuffer.length >= 2) {
			const current = this.equityBuffer[this.equityBuffer.length - 1];
			const maxInWindow = Math.max(...this.equityBuffer.map((e) => e.equity));
			if (maxInWindow > 0) {
				const dropPct = ((maxInWindow - current.equity) / maxInWindow) * 100;
				if (dropPct > this.velocityDropPct) {
					this.velocityTripped = true;
					this.writeBreaker("velocity", {
						is_tripped: 1,
						trip_reason: `Equity dropped ${dropPct.toFixed(2)}% within ${this.velocityWindowMs / 60000}min window (restored from DB)`,
						tripped_at: new Date().toISOString(),
						trip_count_increment: true,
					});
				}
			}
		}

		this.lastPersistTime = Date.now();
	}

	/**
	 * Record a completed trade's P&L.
	 * Positive pnl = win (resets consecutive-loss streak).
	 * Zero or negative pnl = non-win (increments streak; trips breaker if threshold reached).
	 *
	 * Break-even (pnl = 0) counts as a loss for streak purposes: it consumed
	 * capital, paid fees, and produced no edge proof. A "win" must clear costs.
	 */
	recordTrade(pnl: number): void {
		if (pnl > 0) {
			// Win — reset the streak and clear the breaker
			const wasTripped = this.consecutiveLossTripped;
			this.consecutiveLosses = 0;
			this.consecutiveLossTripped = false;
			this.writeBreaker("consecutive_loss", {
				consecutive_losses: 0,
				is_tripped: 0,
				trip_reason: wasTripped ? null : undefined,
				tripped_at: wasTripped ? null : undefined,
			});
		} else {
			// Loss — increment streak
			this.consecutiveLosses++;
			const nowTripped = this.consecutiveLosses >= this.maxConsecutiveLosses;
			if (nowTripped && !this.consecutiveLossTripped) {
				this.consecutiveLossTripped = true;
				this.writeBreaker("consecutive_loss", {
					consecutive_losses: this.consecutiveLosses,
					is_tripped: 1,
					trip_reason: `${this.consecutiveLosses} consecutive losses (max: ${this.maxConsecutiveLosses})`,
					tripped_at: new Date().toISOString(),
					trip_count_increment: true,
				});
			} else {
				this.writeBreaker("consecutive_loss", {
					consecutive_losses: this.consecutiveLosses,
					is_tripped: this.consecutiveLossTripped ? 1 : 0,
				});
			}
		}
	}

	/**
	 * Record the current account equity.
	 * - Updates peak equity and checks absolute drawdown.
	 * - Adds to the velocity ring buffer and checks for fast equity drops.
	 * - Flushes the ring buffer to equity_snapshots every persistIntervalMs.
	 *
	 * Should be called approximately every minute by the trading engine.
	 */
	recordEquity(equity: number): void {
		if (!Number.isFinite(equity) || equity <= 0) {
			if (equity < 0) {
				console.warn("[circuit-breaker] Ignoring negative equity value:", equity);
			}
			return;
		}

		const now = Date.now();
		const prevEquity = this.lastEquity;
		const prevTimestampMs = this.lastEquityTimestampMs;
		this.lastEquity = equity;
		this.lastEquityTimestampMs = now;

		// Update peak equity (only ever moves up — a glitchy LOW tick can't poison the peak)
		if (equity > this.peakEquity) {
			this.peakEquity = equity;
		}

		// Equity sanity guard — flags transient feed glitches before they reach the
		// drawdown evaluation. Returns true when the current tick should skip the
		// drawdown check entirely (still in unconfirmed-suspicious state).
		const skipDrawdownEval = this.checkSuspiciousDrop(equity, now, prevEquity, prevTimestampMs);

		// Median-smoothing ring buffer (in-memory). A single outlier tick can't move
		// the median once the buffer has ≥3 entries, so the drawdown comparison is
		// resilient to one-shot ticker glitches even when the rate-of-change guard
		// missed (e.g. drop slightly under suspiciousTickDropPct).
		this.equitySmoothingBuffer.push({ timestamp: now, equity });
		if (this.equitySmoothingBuffer.length > this.equitySmoothingWindow) {
			this.equitySmoothingBuffer.shift();
		}

		// Absolute drawdown check — uses median-smoothed equity, requires two
		// consecutive samples over threshold (existing guard), and skips entirely
		// when the rate-of-change guard flagged this tick as suspicious.
		if (this.peakEquity > 0 && !this.drawdownTripped) {
			if (skipDrawdownEval) {
				// Suspicious drop not yet confirmed — don't advance the pendingDD
				// or pending-velocity state machines on a tick we don't trust.
				// Persist peak_equity only.
				this.pendingDrawdownPct = 0;
				this.pendingVelocityDropPct = 0;
				this.writeBreaker("drawdown", { peak_equity: this.peakEquity });
			} else {
				const smoothedEquity = this.computeSmoothedEquity(equity);
				const drawdownPct = ((this.peakEquity - smoothedEquity) / this.peakEquity) * 100;
				if (drawdownPct >= this.maxDrawdownPct) {
					if (this.pendingDrawdownPct >= this.maxDrawdownPct) {
						this.drawdownTripped = true;
						this.pendingDrawdownPct = 0;
						this.writeBreaker("drawdown", {
							peak_equity: this.peakEquity,
							is_tripped: 1,
							trip_reason: `Drawdown ${drawdownPct.toFixed(2)}% (smoothed) exceeded max ${this.maxDrawdownPct}% (confirmed across two samples)`,
							tripped_at: new Date().toISOString(),
							trip_count_increment: true,
						});
					} else {
						this.pendingDrawdownPct = drawdownPct;
						this.writeBreaker("drawdown", { peak_equity: this.peakEquity });
					}
				} else {
					this.pendingDrawdownPct = 0;
					this.writeBreaker("drawdown", { peak_equity: this.peakEquity });
				}
			}
		} else {
			// Still update peak_equity even when tripped, so it's correct on reset
			this.writeBreaker("drawdown", { peak_equity: this.peakEquity });
		}

		// Velocity ring buffer update
		this.equityBuffer.push({ timestamp: now, equity });

		// Trim entries outside the velocity window
		const windowStart = now - this.velocityWindowMs;
		this.equityBuffer = this.equityBuffer.filter((e) => e.timestamp >= windowStart);

		// Velocity check: did equity drop >N% from the recent high within the window?
		// Require two consecutive samples over threshold before tripping — a single
		// spurious equity reading (mid-update race, stale ticker, glitch) should not
		// halt trading on its own. The rate-of-change sanity guard also applies here:
		// while a tick is flagged as suspicious (likely feed glitch), velocity is
		// skipped just like drawdown — same root cause, same filter.
		if (!this.velocityTripped && !skipDrawdownEval && this.equityBuffer.length >= 2) {
			const maxInWindow = Math.max(...this.equityBuffer.map((e) => e.equity));
			const dropPct = maxInWindow > 0 ? ((maxInWindow - equity) / maxInWindow) * 100 : 0;
			if (dropPct > this.velocityDropPct) {
				if (this.pendingVelocityDropPct > this.velocityDropPct) {
					this.velocityTripped = true;
					this.pendingVelocityDropPct = 0;
					this.writeBreaker("velocity", {
						is_tripped: 1,
						trip_reason: `Equity dropped ${dropPct.toFixed(2)}% within ${this.velocityWindowMs / 60000}min window (confirmed across two samples)`,
						tripped_at: new Date().toISOString(),
						trip_count_increment: true,
					});
				} else {
					this.pendingVelocityDropPct = dropPct;
				}
			} else {
				this.pendingVelocityDropPct = 0;
			}
		}

		// Periodically flush ring buffer to equity_snapshots for crash recovery
		if (now - this.lastPersistTime >= this.persistIntervalMs) {
			this.flushEquityBuffer();
			this.lastPersistTime = now;
		}
	}

	/**
	 * Returns whether any breaker is tripped and the reasons why.
	 * Auto-resets breakers that have exceeded their cooldown period.
	 */
	getStatus(): BreakerStatus {
		// Auto-reset breakers after cooldown period
		if (this.cooldownMs > 0) {
			this.autoResetExpiredBreakers();
		}

		const reasons: string[] = [];

		if (this.consecutiveLossTripped) {
			reasons.push(
				`Consecutive loss circuit breaker: ${this.consecutiveLosses} losses (max: ${this.maxConsecutiveLosses})`,
			);
		}

		if (this.drawdownTripped) {
			const dd =
				this.peakEquity > 0 && this.lastEquity > 0
					? ((this.peakEquity - this.lastEquity) / this.peakEquity * 100).toFixed(2)
					: "unknown";
			reasons.push(
				`Drawdown circuit breaker tripped (${dd}% drawdown from peak ${this.peakEquity})`,
			);
		}

		if (this.velocityTripped) {
			reasons.push(
				`Velocity drawdown circuit breaker: equity dropped >${this.velocityDropPct}% within ${this.velocityWindowMs / 60000} minutes`,
			);
		}

		return { halted: reasons.length > 0, reasons };
	}

	/** Current drawdown status derived from in-memory peak/last equity. */
	getDrawdownStatus(): { tripped: boolean; currentDrawdownPct: number } {
		const currentDrawdownPct =
			this.peakEquity > 0 && this.lastEquity > 0
				? Math.max(0, ((this.peakEquity - this.lastEquity) / this.peakEquity) * 100)
				: 0;
		return { tripped: this.drawdownTripped, currentDrawdownPct };
	}

	/**
	 * Peak equity persisted on the drawdown breaker row (may differ slightly from
	 * `TradingStore.getPeakEquity()` around resets or missed ticks — see `trade_risk_status.peakEquityReconciliation`).
	 */
	getDrawdownPeakEquity(): number {
		return this.peakEquity;
	}

	/**
	 * Monotonically lift the drawdown peak to match `storePeak` when the store's
	 * persisted MAX(equity) exceeds the breaker's in-memory peak. Prevents a
	 * 2026-04-19 class of bug where the breaker's peak lagged the store's
	 * snapshot MAX by ~$0.48, causing drawdown% to be measured against a stale
	 * watermark and triggering a spurious halt (see project memory
	 * `project_peak_equity_drift.md`).
	 *
	 * Returns the previous and new peak so callers can log the sync event.
	 * `driftWarnUsd` controls the warn threshold; any drift larger than this
	 * is logged at WARN so operators can investigate upstream desync causes.
	 */
	syncPeakFromStore(
		storePeak: number,
		driftWarnUsd = 1,
	): { synced: boolean; prev: number; next: number } {
		const prev = this.peakEquity;
		if (!Number.isFinite(storePeak) || storePeak <= 0) {
			return { synced: false, prev, next: prev };
		}
		if (storePeak <= prev) {
			return { synced: false, prev, next: prev };
		}

		// Runtime poison guard. Without this, a phantom MAX(equity_snapshots) from
		// a paper-balance race or a stale ticker burst gets blindly imported as
		// the new CB peak, and the very next genuine equity tick computes a
		// drawdown above maxDrawdownPct and re-trips the drawdown breaker —
		// the project_re_poisoning_cycle / project_phantom_equity_drain class
		// of bug. Mirrors the constructor-time detector in loadFromDb().
		//
		// The store-side equity_snapshots row that caused the poison can be
		// inspected via the warn log; the CB simply refuses to import a
		// watermark that would immediately self-trip.
		if (this.lastEquity > 0) {
			const impliedDdPct = ((storePeak - this.lastEquity) / storePeak) * 100;
			if (impliedDdPct >= this.maxDrawdownPct) {
				console.warn(
					`[circuit-breaker] refusing to sync poisoned peak ${storePeak.toFixed(2)} from store — ` +
					`would imply ${impliedDdPct.toFixed(2)}% drawdown vs lastEquity ${this.lastEquity.toFixed(2)} ` +
					`(threshold ${this.maxDrawdownPct.toFixed(2)}%). Keeping prev peak ${prev.toFixed(2)}.`,
				);
				return { synced: false, prev, next: prev };
			}
		}

		const drift = storePeak - prev;
		if (drift >= driftWarnUsd) {
			console.warn(
				`[circuit-breaker] peak drift ${drift.toFixed(2)} USD detected — lifting breaker peak ${prev.toFixed(2)} → ${storePeak.toFixed(2)} to match TradingStore.getPeakEquity()`,
			);
		}
		this.peakEquity = storePeak;
		this.writeBreaker("drawdown", { peak_equity: storePeak });
		return { synced: true, prev, next: storePeak };
	}

	private reseedVelocityWindow(equity?: number): void {
		this.pendingVelocityDropPct = 0;
		this.equityBuffer = equity && Number.isFinite(equity) && equity > 0
			? [{ timestamp: Date.now(), equity }]
			: [];
	}

	/**
	 * Rate-of-change sanity check. Returns true when the current tick should
	 * skip drawdown evaluation because it looks like a transient feed glitch
	 * (a sudden ≥`suspiciousTickDropPct` drop within `suspiciousTickWindowMs`).
	 *
	 * Behavior:
	 *   - First flagged tick freezes a `suspiciousBaseline` (the prior tick's
	 *     equity + ts) and starts a counter.
	 *   - While in suspicious mode, subsequent ticks compare against the FROZEN
	 *     baseline, not the previous tick — so a drop that "persists" at the
	 *     low level (rather than recovering or dropping further) still counts
	 *     as suspicious until either (a) it recovers (≤ baseline*(1-tol)) →
	 *     glitch confirmed, or (b) the counter hits `suspiciousTickConfirmCount`
	 *     → real drawdown, hand off to the standard pendingDD evaluation.
	 *   - On recovery or confirmation, suspicious state is cleared.
	 *
	 * Replays the 2026-05-08 incident: equity 1208 → 1003 in <3min from ticker
	 * timeouts (not a real drop) tripped the drawdown CB at 9.33%. With this
	 * guard, the bad ticks are skipped until either the feed recovers or the
	 * drop is confirmed across multiple ticks.
	 */
	private checkSuspiciousDrop(
		equity: number,
		now: number,
		prevEquity: number,
		prevTimestampMs: number,
	): boolean {
		if (this.suspiciousBaseline === null) {
			// Not yet in suspicious mode — only entry condition is a single
			// tick-to-tick drop ≥ threshold within the time window.
			if (prevEquity <= 0 || prevTimestampMs <= 0) return false;
			const dropPct = ((prevEquity - equity) / prevEquity) * 100;
			const dtMs = now - prevTimestampMs;
			if (dropPct >= this.suspiciousTickDropPct && dtMs <= this.suspiciousTickWindowMs) {
				this.suspiciousBaseline = { timestamp: prevTimestampMs, equity: prevEquity };
				this.consecutiveSuspiciousTicks = 1;
				const skip = this.consecutiveSuspiciousTicks < this.suspiciousTickConfirmCount;
				console.warn(
					`[circuit-breaker] Suspicious equity drop ${dropPct.toFixed(2)}% in ${(dtMs / 1000).toFixed(1)}s (${prevEquity.toFixed(2)} → ${equity.toFixed(2)}); ${skip ? `skipping drawdown eval (${this.consecutiveSuspiciousTicks}/${this.suspiciousTickConfirmCount} consecutive)` : "confirm-count=1, allowing drawdown eval"}`,
				);
				return skip;
			}
			return false;
		}

		// Already suspicious — compare against the frozen baseline so a flat
		// "stuck low" reading still counts as suspicious until confirmed/cleared.
		const dropFromBaseline =
			((this.suspiciousBaseline.equity - equity) / this.suspiciousBaseline.equity) * 100;
		if (dropFromBaseline >= this.suspiciousTickDropPct) {
			this.consecutiveSuspiciousTicks++;
			if (this.consecutiveSuspiciousTicks < this.suspiciousTickConfirmCount) {
				console.warn(
					`[circuit-breaker] Suspicious drop persists (${dropFromBaseline.toFixed(2)}% below baseline ${this.suspiciousBaseline.equity.toFixed(2)}); skipping drawdown eval (${this.consecutiveSuspiciousTicks}/${this.suspiciousTickConfirmCount} consecutive)`,
				);
				return true;
			}
			console.warn(
				`[circuit-breaker] Suspicious drop confirmed across ${this.consecutiveSuspiciousTicks} consecutive ticks — releasing to drawdown evaluation`,
			);
			this.suspiciousBaseline = null;
			this.consecutiveSuspiciousTicks = 0;
			return false;
		}

		// Equity recovered — feed glitch confirmed.
		console.log(
			`[circuit-breaker] Suspicious drop cleared (recovered to ${equity.toFixed(2)} after ${this.consecutiveSuspiciousTicks} tick(s)) — confirmed transient feed glitch`,
		);
		this.suspiciousBaseline = null;
		this.consecutiveSuspiciousTicks = 0;
		return false;
	}

	/**
	 * Median of the last N entries in the smoothing buffer, used as the equity
	 * value for drawdown comparison. Falls back to the raw current value when
	 * the buffer has < 3 entries (insufficient samples for a meaningful median).
	 */
	private computeSmoothedEquity(rawCurrent: number): number {
		if (this.equitySmoothingBuffer.length < 3) return rawCurrent;
		const values = this.equitySmoothingBuffer
			.map((e) => e.equity)
			.sort((a, b) => a - b);
		const mid = Math.floor(values.length / 2);
		return values.length % 2 === 1
			? values[mid]
			: (values[mid - 1] + values[mid]) / 2;
	}

	/**
	 * Accept the current equity as the new drawdown baseline after operator review.
	 * This clears any tripped drawdown breaker and re-seeds the in-memory and
	 * persisted peak watermark so the next equity sample is measured from the
	 * accepted baseline rather than the old historical high. It also clears any
	 * stale velocity window state from the pre-reset drawdown so the next sample
	 * is evaluated from the accepted baseline instead of the old high-water mark.
	 */
	resetDrawdownBaseline(equity: number): void {
		if (!Number.isFinite(equity) || equity <= 0) {
			throw new Error(`resetDrawdownBaseline requires positive equity, got ${equity}`);
		}
		this.peakEquity = equity;
		this.lastEquity = equity;
		this.lastEquityTimestampMs = Date.now();
		this.drawdownTripped = false;
		this.velocityTripped = false;
		this.pendingDrawdownPct = 0;
		this.pendingVelocityDropPct = 0;
		this.suspiciousBaseline = null;
		this.consecutiveSuspiciousTicks = 0;
		this.equitySmoothingBuffer = [{ timestamp: this.lastEquityTimestampMs, equity }];
		this.reseedVelocityWindow(equity);
		this.writeBreaker("drawdown", {
			peak_equity: equity,
			is_tripped: 0,
			trip_reason: null,
			tripped_at: null,
		});
		this.writeBreaker("velocity", {
			is_tripped: 0,
			trip_reason: null,
			tripped_at: null,
		});
	}

	/**
	 * Manually reset a breaker after review.
	 * Does not re-enable trading automatically — the engine must also clear its halt flag.
	 */
	resetBreaker(type: BreakerType): void {
		if (type === "consecutive_loss") {
			this.consecutiveLosses = 0;
			this.consecutiveLossTripped = false;
			this.writeBreaker("consecutive_loss", {
				consecutive_losses: 0,
				is_tripped: 0,
				trip_reason: null,
				tripped_at: null,
			});
		} else if (type === "drawdown") {
			this.drawdownTripped = false;
			this.pendingDrawdownPct = 0;
			this.suspiciousBaseline = null;
			this.consecutiveSuspiciousTicks = 0;
			this.writeBreaker("drawdown", {
				is_tripped: 0,
				trip_reason: null,
				tripped_at: null,
			});
		} else if (type === "velocity") {
			this.velocityTripped = false;
			this.reseedVelocityWindow();
			this.writeBreaker("velocity", {
				is_tripped: 0,
				trip_reason: null,
				tripped_at: null,
			});
		}
	}

	/** Return the raw persisted state rows for display / audit. */
	getPersistedStates(): BreakerRow[] {
		return this.db
			.prepare("SELECT * FROM circuit_breaker_state ORDER BY breaker_type")
			.all() as BreakerRow[];
	}

	/**
	 * Reset all four breakers in one call. Mirrors resetBreaker() per type so
	 * the in-memory flags and DB rows stay in sync. Returns the breaker types
	 * that were actually tripped (caller can log/report on the cleared set).
	 */
	resetAllBreakers(): BreakerType[] {
		const cleared: BreakerType[] = [];
		if (this.consecutiveLossTripped) cleared.push("consecutive_loss");
		if (this.drawdownTripped) cleared.push("drawdown");
		if (this.velocityTripped) cleared.push("velocity");
		this.resetBreaker("consecutive_loss");
		this.resetBreaker("drawdown");
		this.resetBreaker("velocity");
		return cleared;
	}

	/**
	 * Auto-reset breakers whose tripped_at timestamp exceeds the cooldown period.
	 * Logs a warning when auto-resetting so it's visible in audit logs.
	 */
	private autoResetExpiredBreakers(): void {
		const now = Date.now();
		const rows = this.db
			.prepare("SELECT breaker_type, tripped_at FROM circuit_breaker_state WHERE is_tripped = 1 AND tripped_at IS NOT NULL")
			.all() as Pick<BreakerRow, "breaker_type" | "tripped_at">[];

		for (const row of rows) {
			if (!row.tripped_at) continue;
			const trippedAt = new Date(row.tripped_at).getTime();
			if (now - trippedAt >= this.cooldownMs) {
				console.warn(`[circuit-breaker] Auto-resetting ${row.breaker_type} breaker after ${Math.round((now - trippedAt) / 60_000)}min cooldown (tripped at ${row.tripped_at})`);
				this.resetBreaker(row.breaker_type);
			}
		}
	}

	private flushEquityBuffer(): void {
		try {
			const insert = this.db.prepare(
				"INSERT OR IGNORE INTO equity_snapshots (timestamp, equity) VALUES (?, ?)",
			);
			const batch = this.db.transaction(() => {
				for (const point of this.equityBuffer) {
					if (!Number.isFinite(point.equity) || !(point.equity > 0)) continue;
					// Collapse same-second dual-daemon flushes onto one PK so duplicate
					// equity ticks become INSERT OR IGNORE no-ops instead of parallel
					// high-water marks with millisecond-only differences.
					const timestampSecond = Math.floor(point.timestamp / 1000) * 1000;
					insert.run(new Date(timestampSecond).toISOString(), point.equity);
				}
			});
			batch();
		} catch (err) {
			console.error("[circuit-breaker] Equity snapshot flush failed (data loss risk):", err instanceof Error ? err.message : err);
		}
	}

	private writeBreaker(
		type: BreakerType,
		updates: {
			consecutive_losses?: number;
			peak_equity?: number;
			is_tripped?: number;
			trip_reason?: string | null;
			tripped_at?: string | null;
			trip_count_increment?: boolean;
		},
	): void {
		const parts: string[] = ["last_updated = ?"];
		const values: unknown[] = [new Date().toISOString()];

		if (updates.trip_count_increment) {
			parts.push("trip_count = trip_count + 1");
		}
		if (updates.consecutive_losses !== undefined) {
			parts.push("consecutive_losses = ?");
			values.push(updates.consecutive_losses);
		}
		if (updates.peak_equity !== undefined) {
			parts.push("peak_equity = ?");
			values.push(updates.peak_equity);
		}
		if (updates.is_tripped !== undefined) {
			parts.push("is_tripped = ?");
			values.push(updates.is_tripped);
		}
		if ("trip_reason" in updates) {
			parts.push("trip_reason = ?");
			values.push(updates.trip_reason ?? null);
		}
		if ("tripped_at" in updates) {
			parts.push("tripped_at = ?");
			values.push(updates.tripped_at ?? null);
		}

		values.push(type);
		this.db
			.prepare(
				`UPDATE circuit_breaker_state SET ${parts.join(", ")} WHERE breaker_type = ?`,
			)
			.run(...values);
	}
}
