/**
 * Walk-forward validation with L2-regularized logistic regression (batch gradient descent).
 * No external ML dependencies — suitable for macro feature panels.
 */

export interface WalkForwardConfig {
	/** Trading days per test block */
	testDays: number;
	/** Minimum training rows before first test */
	minTrainRows: number;
	/** Gradient descent steps per fold */
	epochs: number;
	learningRate: number;
	l2Lambda: number;
}

const DEFAULT_CONFIG: WalkForwardConfig = {
	testDays: 126,
	minTrainRows: 400,
	epochs: 600,
	learningRate: 0.15,
	l2Lambda: 0.01,
};

function sigmoid(z: number): number {
	if (z >= 20) return 1;
	if (z <= -20) return 0;
	return 1 / (1 + Math.exp(-z));
}

function dot(w: number[], b: number, x: number[]): number {
	let s = b;
	for (let j = 0; j < x.length; j++) s += w[j] * x[j];
	return s;
}

/** Z-score columns using train stats; mutates X in place for the slice provided */
function normalizeRows(
	rows: number[][],
	mean: number[],
	std: number[],
): void {
	for (const row of rows) {
		for (let j = 0; j < row.length; j++) {
			const s = std[j] > 1e-12 ? std[j] : 1;
			row[j] = (row[j] - mean[j]) / s;
		}
	}
}

function computeMeanStd(train: number[][]): { mean: number[]; std: number[] } {
	const d = train[0]?.length ?? 0;
	const mean = Array(d).fill(0);
	for (const row of train) {
		for (let j = 0; j < d; j++) mean[j] += row[j];
	}
	for (let j = 0; j < d; j++) mean[j] /= train.length;

	const variance = Array(d).fill(0);
	for (const row of train) {
		for (let j = 0; j < d; j++) {
			const diff = row[j] - mean[j];
			variance[j] += diff * diff;
		}
	}
	const std = variance.map((v) => Math.sqrt(v / train.length));
	return { mean, std };
}

function cloneRows(rows: number[][]): number[][] {
	return rows.map((r) => [...r]);
}

export function trainLogisticRegression(
	X: number[][],
	y: number[],
	config: Partial<WalkForwardConfig> = {},
): { w: number[]; b: number; loss: number } {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const n = X.length;
	const d = X[0]?.length ?? 0;
	if (n === 0 || d === 0) return { w: Array(d).fill(0), b: 0, loss: 0 };

	let w = Array(d).fill(0);
	let b = 0;

	for (let e = 0; e < cfg.epochs; e++) {
		const gw = Array(d).fill(0);
		let gb = 0;
		let loss = 0;

		for (let i = 0; i < n; i++) {
			const z = dot(w, b, X[i]);
			const p = sigmoid(z);
			const err = p - y[i];
			loss += -(y[i] * Math.log(p + 1e-12) + (1 - y[i]) * Math.log(1 - p + 1e-12));
			gb += err;
			for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
		}

		for (let j = 0; j < d; j++) {
			gw[j] = gw[j] / n + cfg.l2Lambda * w[j];
		}
		gb /= n;

		for (let j = 0; j < d; j++) w[j] -= cfg.learningRate * gw[j];
		b -= cfg.learningRate * gb;

		if (e === cfg.epochs - 1) {
			loss = loss / n + (cfg.l2Lambda / 2) * w.reduce((s, v) => s + v * v, 0);
			return { w, b, loss };
		}
	}

	return { w, b, loss: 0 };
}

export function predictProba(w: number[], b: number, x: number[]): number {
	return sigmoid(dot(w, b, x));
}

export interface WalkForwardFoldResult {
	trainStartIdx: number;
	trainEndIdx: number;
	testStartIdx: number;
	testEndIdx: number;
	accuracy: number;
	baselineAccuracy: number;
	nTest: number;
}

export interface WalkForwardReport {
	folds: WalkForwardFoldResult[];
	meanAccuracy: number;
	meanBaseline: number;
	/** Mean |weight| across folds (last epoch) for interpretability */
	featureImportance: { name: string; meanAbsWeight: number }[];
}

export function runWalkForward(
	X: number[][],
	y: number[],
	featureNames: readonly string[],
	config: Partial<WalkForwardConfig> = {},
): WalkForwardReport {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const folds: WalkForwardFoldResult[] = [];
	const importanceAcc: number[] = Array(X[0]?.length ?? 0).fill(0);
	let foldCount = 0;

	let trainStart = 0;
	let trainEnd = cfg.minTrainRows - 1;

	while (trainEnd + cfg.testDays < X.length) {
		const testStart = trainEnd + 1;
		const testEnd = Math.min(testStart + cfg.testDays - 1, X.length - 1);
		if (testStart > testEnd) break;

		const Xtrain = cloneRows(X.slice(trainStart, trainEnd + 1));
		const ytrain = y.slice(trainStart, trainEnd + 1);
		const Xtest = cloneRows(X.slice(testStart, testEnd + 1));
		const ytest = y.slice(testStart, testEnd + 1);

		const { mean, std } = computeMeanStd(Xtrain);
		normalizeRows(Xtrain, mean, std);
		normalizeRows(Xtest, mean, std);

		const { w, b } = trainLogisticRegression(Xtrain, ytrain, cfg);

		let correct = 0;
		for (let i = 0; i < Xtest.length; i++) {
			const p = predictProba(w, b, Xtest[i]);
			const pred = p >= 0.5 ? 1 : 0;
			if (pred === ytest[i]) correct++;
		}
		const accuracy = Xtest.length > 0 ? correct / Xtest.length : 0;

		const maj = ytrain.reduce((s, v) => s + v, 0) / ytrain.length;
		const baselinePred = maj >= 0.5 ? 1 : 0;
		const baselineAccuracy = ytest.filter((v) => v === baselinePred).length / (ytest.length || 1);

		folds.push({
			trainStartIdx: trainStart,
			trainEndIdx: trainEnd,
			testStartIdx: testStart,
			testEndIdx: testEnd,
			accuracy,
			baselineAccuracy,
			nTest: Xtest.length,
		});

		for (let j = 0; j < w.length; j++) importanceAcc[j] += Math.abs(w[j]);
		foldCount++;

		trainEnd = testEnd;
	}

	const meanAccuracy = folds.length > 0
		? folds.reduce((s, f) => s + f.accuracy, 0) / folds.length
		: 0;
	const meanBaseline = folds.length > 0
		? folds.reduce((s, f) => s + f.baselineAccuracy, 0) / folds.length
		: 0;

	const featureImportance = featureNames.map((name, j) => ({
		name,
		meanAbsWeight: foldCount > 0 ? importanceAcc[j] / foldCount : 0,
	}));
	featureImportance.sort((a, b) => b.meanAbsWeight - a.meanAbsWeight);

	return { folds, meanAccuracy, meanBaseline, featureImportance };
}

/** Train on all rows, return model + normalized params (for live row). */
export function trainFullSample(
	X: number[][],
	y: number[],
	config: Partial<WalkForwardConfig> = {},
): {
	w: number[];
	b: number;
	mean: number[];
	std: number[];
} {
	const { mean, std } = computeMeanStd(X);
	const Xn = cloneRows(X);
	normalizeRows(Xn, mean, std);
	const { w, b } = trainLogisticRegression(Xn, y, config);
	return { w, b, mean, std };
}

export function normalizeSingleRow(row: number[], mean: number[], std: number[]): number[] {
	const out = [...row];
	for (let j = 0; j < out.length; j++) {
		const s = std[j] > 1e-12 ? std[j] : 1;
		out[j] = (out[j] - mean[j]) / s;
	}
	return out;
}
