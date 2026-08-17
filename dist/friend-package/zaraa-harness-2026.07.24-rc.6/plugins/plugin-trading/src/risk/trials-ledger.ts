import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { deflatedSharpeGate, type DeflatedSharpeGateResult } from "./deflated-sharpe.js";

/**
 * D14 — append-only trials ledger shared across all agents and crash-resumes.
 *
 * Every backtested variant is recorded so the deflated-Sharpe hurdle sees the
 * true number of trials (N), not a per-run undercount. The gate fails CLOSED if
 * the ledger is unreadable or has regressed below a recorded high-water mark
 * (rows lost / tampered) — a too-low N would silently weaken the hurdle.
 *
 * See docs/research/2026-06-13-markets-understanding-build-spec.md (D14).
 */

export interface TrialRecord {
	strategyName: string;
	paramsHash: string;
	symbol?: string;
	windowStart?: number;
	windowEnd?: number;
	agentId?: string;
	backtestSharpe?: number | null;
	evaluatedAt: number;
}

export interface TrialsGateInput {
	strategyName: string;
	rawSharpe: number;
	nObs: number;
	minDeflatedSharpe?: number;
}

export interface TrialsGateResult extends DeflatedSharpeGateResult {
	nTrials: number;
	/** Set when the high-water-mark write failed — non-fatal here, but a persistent
	 *  failure blinds future regression detection, so it is surfaced for observability. */
	hwmWriteError?: string;
}

export class TrialsLedger {
	constructor(private readonly db: Database.Database) {}

	/** Append one evaluated variant. Append-only: identical params still add a row. */
	record(entry: TrialRecord): void {
		this.db
			.prepare(
				`INSERT INTO trials_ledger
					(id, strategyName, paramsHash, symbol, windowStart, windowEnd, agentId, backtestSharpe, evaluatedAt)
				 VALUES (@id, @strategyName, @paramsHash, @symbol, @windowStart, @windowEnd, @agentId, @backtestSharpe, @evaluatedAt)`,
			)
			.run({
				id: randomUUID(),
				strategyName: entry.strategyName,
				paramsHash: entry.paramsHash,
				symbol: entry.symbol ?? "",
				windowStart: entry.windowStart ?? 0,
				windowEnd: entry.windowEnd ?? 0,
				agentId: entry.agentId ?? "unknown",
				backtestSharpe: entry.backtestSharpe ?? null,
				evaluatedAt: entry.evaluatedAt,
			});
	}

	/** Total trials recorded, optionally scoped to one strategy. */
	count(strategyName?: string): number {
		const row = strategyName
			? (this.db
					.prepare("SELECT COUNT(*) AS c FROM trials_ledger WHERE strategyName = ?")
					.get(strategyName) as { c: number })
			: (this.db.prepare("SELECT COUNT(*) AS c FROM trials_ledger").get() as { c: number });
		return row.c;
	}

	private getHwm(strategyName: string): number {
		const row = this.db
			.prepare("SELECT maxCount FROM trials_ledger_hwm WHERE strategyName = ?")
			.get(strategyName) as { maxCount: number } | undefined;
		return row?.maxCount ?? 0;
	}

	private setHwm(strategyName: string, value: number): void {
		this.db
			.prepare(
				`INSERT INTO trials_ledger_hwm (strategyName, maxCount) VALUES (?, ?)
				 ON CONFLICT(strategyName) DO UPDATE SET maxCount = excluded.maxCount`,
			)
			.run(strategyName, value);
	}

	/**
	 * Deflated-Sharpe promotion gate using the cumulative trial count as N.
	 * Fails closed on ledger I/O error or a high-water-mark regression.
	 */
	gate(input: TrialsGateInput): TrialsGateResult {
		let n: number;
		let hwm: number;
		try {
			n = this.count(input.strategyName);
			hwm = this.getHwm(input.strategyName);
		} catch (err) {
			return {
				pass: false,
				deflatedSharpe: Number.NEGATIVE_INFINITY,
				benchmark: Number.POSITIVE_INFINITY,
				nTrials: 0,
				reason: `fail-closed: trials ledger unreadable (${err instanceof Error ? err.message : String(err)})`,
			};
		}
		if (n < hwm) {
			return {
				pass: false,
				deflatedSharpe: Number.NEGATIVE_INFINITY,
				benchmark: Number.POSITIVE_INFINITY,
				nTrials: n,
				reason: `fail-closed: trials ledger regressed (count ${n} < high-water-mark ${hwm}) — possible data loss or tampering`,
			};
		}
		let hwmWriteError: string | undefined;
		try {
			this.setHwm(input.strategyName, Math.max(n, hwm));
		} catch (err) {
			// Non-fatal for THIS gate (it must not loosen), but surfaced: a persistent
			// HWM write failure would blind future regression detection.
			hwmWriteError = err instanceof Error ? err.message : String(err);
		}
		const dg = deflatedSharpeGate({
			rawSharpe: input.rawSharpe,
			nTrials: Math.max(n, 1),
			nObs: input.nObs,
			minDeflatedSharpe: input.minDeflatedSharpe,
		});
		return { ...dg, nTrials: n, ...(hwmWriteError ? { hwmWriteError } : {}) };
	}
}
