import type { KillGateSnapshot } from "../risk/trading-kill-gate.js";
import type { Position } from "../trading-store.js";
import type { RiskManager } from "../risk/risk-manager.js";

export const DEFAULT_QUIET_HOURS_BENCHMARK_SYMBOLS = [
	"BTC_USDT",
	"ETH_USDT",
	"SOL_USDT",
	"XRP_USDT",
	"DOGE_USDT",
] as const;

export interface RiskAuditViolation {
	code: string;
	severity: "critical" | "high" | "medium" | "low";
	detail: string;
	symbol?: string;
}

export interface PositionNotionalRow {
	positionId: string;
	symbol: string;
	side: "long" | "short";
	notionalUsd: number;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function computeExposureByAsset(
	rows: Array<{ symbol: string; notionalUsd: number }>,
): Record<string, { notionalUsd: number; pctOfGross: number }> {
	const bySym: Record<string, number> = {};
	for (const r of rows) {
		bySym[r.symbol] = (bySym[r.symbol] ?? 0) + Math.abs(r.notionalUsd);
	}
	const gross = Object.values(bySym).reduce((s, n) => s + n, 0);
	const out: Record<string, { notionalUsd: number; pctOfGross: number }> = {};
	for (const sym of Object.keys(bySym)) {
		const n = bySym[sym];
		out[sym] = {
			notionalUsd: round2(n),
			pctOfGross: gross > 0 ? round2((n / gross) * 100) : 0,
		};
	}
	return out;
}

export function collectRiskViolations(input: {
	killSnap: KillGateSnapshot;
	positionsMissingStopLoss: Position[];
	riskManager: RiskManager | undefined;
	currentEquity: number;
	peakEquity: number;
	totalExposureNotional: number;
	perPositionRows: PositionNotionalRow[];
	/** Mark price by position id for breach checks */
	markByPositionId: Map<string, number>;
	/** Positions that have a non-null stop price */
	stopsByPositionId: Map<
		string,
		{ symbol: string; side: "long" | "short"; stopLoss: number }
	>;
}): RiskAuditViolation[] {
	const violations: RiskAuditViolation[] = [];
	const {
		killSnap,
		positionsMissingStopLoss,
		riskManager,
		currentEquity,
		peakEquity,
		totalExposureNotional,
		perPositionRows,
		markByPositionId,
		stopsByPositionId,
	} = input;

	if (!killSnap.newEntriesAllowed) {
		violations.push({
			code: "execution_gate_blocked",
			severity: "critical",
			detail: killSnap.blockReason ?? "New entries blocked by trading gate.",
		});
	}

	for (const p of positionsMissingStopLoss) {
		violations.push({
			code: "missing_stop_loss",
			severity: "high",
			symbol: p.symbol,
			detail: `Open ${p.side} ${p.qty.toString()} ${p.symbol} has no stop-loss.`,
		});
	}

	if (riskManager && peakEquity > 0 && currentEquity > 0) {
		if (riskManager.isDrawdownExceeded(currentEquity, peakEquity)) {
			violations.push({
				code: "drawdown_limit_breached",
				severity: "critical",
				detail: `Equity ${currentEquity.toFixed(2)} vs peak ${peakEquity.toFixed(2)} exceeds max drawdown rule.`,
			});
		}
		const cfg = riskManager.getConfig();
		const expPct = (totalExposureNotional / currentEquity) * 100;
		if (expPct > cfg.maxExposurePct) {
			violations.push({
				code: "max_total_exposure",
				severity: "high",
				detail: `Gross notional exposure ${expPct.toFixed(1)}% of equity exceeds limit ${cfg.maxExposurePct}%.`,
			});
		}
		for (const row of perPositionRows) {
			const pct = (row.notionalUsd / currentEquity) * 100;
			if (pct > cfg.maxPositionPct) {
				violations.push({
					code: "position_concentration",
					severity: "medium",
					symbol: row.symbol,
					detail: `${row.side} ${row.symbol} is ${pct.toFixed(1)}% of equity (max single ${cfg.maxPositionPct}%).`,
				});
			}
		}
	}

	for (const [id, stopMeta] of stopsByPositionId) {
		const mark = markByPositionId.get(id);
		if (mark == null || !Number.isFinite(mark)) continue;
		const { stopLoss, side, symbol } = stopMeta;
		if (side === "long" && mark <= stopLoss) {
			violations.push({
				code: "stop_loss_breached",
				severity: "critical",
				symbol,
				detail: `Long ${symbol}: mark ${mark} at/below stop ${stopLoss}.`,
			});
		}
		if (side === "short" && mark >= stopLoss) {
			violations.push({
				code: "stop_loss_breached",
				severity: "critical",
				symbol,
				detail: `Short ${symbol}: mark ${mark} at/above stop ${stopLoss}.`,
			});
		}
	}

	return violations;
}

export function escalationRecommendedForViolations(v: RiskAuditViolation[]): boolean {
	return v.some(
		(x) =>
			x.severity === "critical" ||
			x.code === "missing_stop_loss" ||
			x.code === "stop_loss_breached" ||
			x.code === "execution_gate_blocked",
	);
}
