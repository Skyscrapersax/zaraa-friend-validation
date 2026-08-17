/**
 * D14 — Multiple-testing deflation (Bailey & López de Prado, simplified).
 *
 * When the autonomy loop selects the best of N backtested variants, the winner's
 * Sharpe is selection-inflated: even pure-noise strategies produce a high "best"
 * Sharpe when you try enough of them. The deflated Sharpe subtracts the Sharpe a
 * zero-edge strategy would be *expected* to reach as the maximum of N trials over
 * nObs observations, leaving the portion attributable to a real edge.
 *
 * Units: `rawSharpe` is a per-observation Sharpe measured over `nObs`
 * observations (trades). The deflation haircut is monotone in both N (more trials
 * → bigger haircut) and nObs (more data → smaller haircut) regardless of the
 * absolute Sharpe convention, so it is a sound multiple-testing penalty even if
 * the upstream Sharpe is reported in a different period convention.
 *
 * See docs/research/2026-06-13-markets-understanding-build-spec.md (D14).
 */

const EULER_MASCHERONI = 0.5772156649015329;

/** Inverse standard-normal CDF (Acklam's rational approximation, ~1e-9). */
export function inverseNormalCdf(p: number): number {
	if (p <= 0) return Number.NEGATIVE_INFINITY;
	if (p >= 1) return Number.POSITIVE_INFINITY;
	const a = [
		-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
		1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0,
	];
	const b = [
		-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
		6.680131188771972e1, -1.328068155288572e1,
	];
	const c = [
		-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
		-2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0,
	];
	const d = [
		7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
		3.754408661907416e0,
	];
	const plow = 0.02425;
	const phigh = 1 - plow;
	if (p < plow) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (
			(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
			((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
		);
	}
	if (p <= phigh) {
		const q = p - 0.5;
		const r = q * q;
		return (
			((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
			(((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
		);
	}
	const q = Math.sqrt(-2 * Math.log(1 - p));
	return -(
		(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
		((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
	);
}

/** Expected maximum of `nTrials` i.i.d. standard normals (Gumbel approximation). */
export function expectedMaxZ(nTrials: number): number {
	const n = Math.max(1, Math.floor(nTrials));
	if (n <= 1) return 0;
	const a = inverseNormalCdf(1 - 1 / n);
	const b = inverseNormalCdf(1 - 1 / (n * Math.E));
	return (1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b;
}

/** The Sharpe a pure-noise strategy is expected to reach as the best of N trials. */
export function expectedMaxSharpeUnderNull(nTrials: number, nObs: number): number {
	if (!Number.isFinite(nObs) || nObs <= 1) return Number.POSITIVE_INFINITY;
	// SE of a per-observation Sharpe estimate under the null (~0 true Sharpe).
	const sharpeStdErr = Math.sqrt(1 / nObs);
	return sharpeStdErr * expectedMaxZ(nTrials);
}

/** Raw Sharpe minus the expected best-of-N noise Sharpe. */
export function deflatedSharpe(rawSharpe: number, nTrials: number, nObs: number): number {
	return rawSharpe - expectedMaxSharpeUnderNull(nTrials, nObs);
}

export interface DeflatedSharpeGateInput {
	rawSharpe: number;
	nTrials: number;
	nObs: number;
	/** Required margin of deflated Sharpe above the noise benchmark. Default 0.5 (conservative). */
	minDeflatedSharpe?: number;
}

export interface DeflatedSharpeGateResult {
	pass: boolean;
	deflatedSharpe: number;
	benchmark: number;
	reason: string;
}

/**
 * Promotion gate: a strategy may advance only if, after deflating for the number
 * of variants tried, its Sharpe still clears a conservative margin. Fails closed
 * on a degenerate sample (nObs <= 1).
 */
export function deflatedSharpeGate(input: DeflatedSharpeGateInput): DeflatedSharpeGateResult {
	const minDeflated = input.minDeflatedSharpe ?? 0.5;
	const benchmark = expectedMaxSharpeUnderNull(input.nTrials, input.nObs);
	const deflated = input.rawSharpe - benchmark;

	if (!Number.isFinite(input.nObs) || input.nObs <= 1) {
		return {
			pass: false,
			deflatedSharpe: Number.NEGATIVE_INFINITY,
			benchmark,
			reason: `fail-closed: degenerate sample (nObs=${input.nObs}); cannot deflate`,
		};
	}
	if (deflated < minDeflated) {
		return {
			pass: false,
			deflatedSharpe: deflated,
			benchmark,
			reason: `deflated Sharpe ${deflated.toFixed(2)} < ${minDeflated.toFixed(2)} hurdle (raw ${input.rawSharpe.toFixed(2)}, selected from ${input.nTrials} trials over ${input.nObs} obs)`,
		};
	}
	return {
		pass: true,
		deflatedSharpe: deflated,
		benchmark,
		reason: `deflated Sharpe ${deflated.toFixed(2)} ≥ ${minDeflated.toFixed(2)} (raw ${input.rawSharpe.toFixed(2)}, ${input.nTrials} trials over ${input.nObs} obs)`,
	};
}
