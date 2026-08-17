/**
 * Bellman-Ford negative cycle detection for multi-currency arbitrage.
 *
 * Math:
 *   Edge weight = -log(exchange_rate)
 *   Negative cycle ⟹ product of rates along cycle > 1 ⟹ profit
 *   Profit multiplier = exp(-sum_of_weights) = ∏(rates)
 *
 * Example cycle: XRP →(2.5)→ USD →(50)→ SOLO →(0.009)→ XRP
 *   product = 2.5 × 50 × 0.009 = 1.125 → 12.5% profit per loop
 */

export interface Edge {
	from: string;      // source currency
	to: string;        // destination currency
	rate: number;      // exchange rate: 1 unit of `from` = `rate` units of `to`
	weight: number;    // -log(rate) — Bellman-Ford finds negative cycles
	pair: string;      // trading pair label (e.g., "XRP/USD")
	source: string;    // data source (e.g., "xrpl", "stellar", "cex")
	bidQty: number;    // available depth at this rate (in `from` currency)
	fee: number;       // estimated fee as fraction (e.g., 0.001 = 0.1%)
}

export interface ArbitrageCycle {
	/** Currencies in the cycle path (first = last to close the loop) */
	path: string[];
	/** Edges traversed */
	edges: Edge[];
	/** Raw profit multiplier before fees (product of rates) */
	rawMultiplier: number;
	/** Net profit multiplier after estimated fees */
	netMultiplier: number;
	/** Net profit as percentage */
	profitPct: number;
	/** Maximum volume that can traverse the full cycle (limited by thinnest depth) */
	maxVolumeUsd: number;
	/** Estimated profit in USD at max volume */
	estimatedProfitUsd: number;
	/** Data sources involved */
	sources: string[];
	/** Number of hops */
	hops: number;
	/** Timestamp of detection */
	detectedAt: number;
}

export interface BellmanFordResult {
	cycles: ArbitrageCycle[];
	nodesCount: number;
	edgesCount: number;
	scanTimeMs: number;
}

/**
 * Build an edge from a conversion rate, applying fee deduction.
 */
export function createEdge(
	from: string,
	to: string,
	rate: number,
	pair: string,
	source: string,
	bidQty: number,
	fee = 0,
): Edge {
	// Effective rate after fee deduction
	const effectiveRate = rate * (1 - fee);
	return {
		from,
		to,
		rate,
		weight: -Math.log(effectiveRate),
		pair,
		source,
		bidQty,
		fee,
	};
}

/**
 * Run Bellman-Ford on the currency graph and extract all profitable negative cycles.
 *
 * @param edges - All exchange rate edges
 * @param minProfitPct - Minimum cycle profit % to report (default: 0.05%)
 * @param maxHops - Maximum cycle length (default: 5)
 */
export function findArbitrageCycles(
	edges: Edge[],
	minProfitPct = 0.05,
	maxHops = 5,
): BellmanFordResult {
	const startTime = Date.now();

	// Collect all unique currency nodes
	const nodeSet = new Set<string>();
	for (const e of edges) {
		nodeSet.add(e.from);
		nodeSet.add(e.to);
	}
	const nodes = Array.from(nodeSet);
	const n = nodes.length;

	if (n === 0 || edges.length === 0) {
		return { cycles: [], nodesCount: 0, edgesCount: 0, scanTimeMs: 0 };
	}

	const cycles: ArbitrageCycle[] = [];
	const seenCycleKeys = new Set<string>();

	// Run Bellman-Ford from each node as source to find all reachable negative cycles
	for (const source of nodes) {
		const dist = new Map<string, number>();
		const parent = new Map<string, { node: string; edge: Edge } | null>();

		// Initialize
		for (const node of nodes) {
			dist.set(node, node === source ? 0 : Infinity);
			parent.set(node, null);
		}

		// Relax edges |V|-1 times
		for (let i = 0; i < n - 1; i++) {
			let updated = false;
			for (const edge of edges) {
				const du = dist.get(edge.from)!;
				const dv = dist.get(edge.to)!;
				if (du + edge.weight < dv - 1e-12) {
					dist.set(edge.to, du + edge.weight);
					parent.set(edge.to, { node: edge.from, edge });
					updated = true;
				}
			}
			if (!updated) break; // Early termination — no updates means no negative cycles reachable
		}

		// Detect negative cycles: one more pass
		for (const edge of edges) {
			const du = dist.get(edge.from)!;
			const dv = dist.get(edge.to)!;
			if (du + edge.weight < dv - 1e-12) {
				// Negative cycle found — trace it back
				const cycle = extractCycle(edge.to, parent, edges, maxHops);
				if (cycle && cycle.profitPct >= minProfitPct) {
					// Deduplicate: normalize cycle key
					const key = normalizeCycleKey(cycle.path);
					if (!seenCycleKeys.has(key)) {
						seenCycleKeys.add(key);
						cycles.push(cycle);
					}
				}
			}
		}
	}

	// Sort by profit descending
	cycles.sort((a, b) => b.profitPct - a.profitPct);

	return {
		cycles,
		nodesCount: n,
		edgesCount: edges.length,
		scanTimeMs: Date.now() - startTime,
	};
}

/**
 * Extract a negative cycle by backtracking parent pointers.
 */
function extractCycle(
	startNode: string,
	parent: Map<string, { node: string; edge: Edge } | null>,
	_allEdges: Edge[],
	maxHops: number,
): ArbitrageCycle | null {
	// Walk back to find a node that's part of the cycle
	let current = startNode;
	const visited = new Set<string>();
	for (let i = 0; i < maxHops * 2; i++) {
		if (visited.has(current)) break;
		visited.add(current);
		const p = parent.get(current);
		if (!p) return null;
		current = p.node;
	}

	// current is now in the cycle — walk it to extract the full loop
	const cycleStart = current;
	const path: string[] = [cycleStart];
	const cycleEdges: Edge[] = [];

	let node = cycleStart;
	for (let i = 0; i < maxHops + 1; i++) {
		const p = parent.get(node);
		if (!p) return null;

		// Walk backwards through parent pointers
		// But we need the edge FROM parent TO node
		cycleEdges.unshift(p.edge);
		path.unshift(p.node);

		if (p.node === cycleStart && cycleEdges.length >= 2) {
			// Found complete cycle
			break;
		}
		node = p.node;

		if (cycleEdges.length > maxHops) return null;
	}

	if (path[0] !== path[path.length - 1]) return null; // Not a proper cycle
	if (cycleEdges.length < 2) return null; // Need at least 2 hops
	if (cycleEdges.length > maxHops) return null;

	// Calculate profit
	let rawMultiplier = 1;
	let netMultiplier = 1;
	let minDepthUsd = Infinity;

	for (const edge of cycleEdges) {
		rawMultiplier *= edge.rate;
		netMultiplier *= edge.rate * (1 - edge.fee);
		// Estimate depth in USD (rough: quantity × rate approximation)
		const depthUsd = edge.bidQty * edge.rate;
		if (depthUsd > 0 && depthUsd < minDepthUsd) {
			minDepthUsd = depthUsd;
		}
	}

	const profitPct = (netMultiplier - 1) * 100;
	if (minDepthUsd === Infinity) minDepthUsd = 0;
	const estimatedProfitUsd = minDepthUsd * (netMultiplier - 1);

	const sources = [...new Set(cycleEdges.map((e) => e.source))];

	return {
		path,
		edges: cycleEdges,
		rawMultiplier,
		netMultiplier,
		profitPct,
		maxVolumeUsd: Math.round(minDepthUsd * 100) / 100,
		estimatedProfitUsd: Math.round(estimatedProfitUsd * 100) / 100,
		sources,
		hops: cycleEdges.length,
		detectedAt: Date.now(),
	};
}

/** Normalize a cycle path for dedup (rotate to smallest element first) */
function normalizeCycleKey(path: string[]): string {
	// Remove last element (same as first)
	const cycle = path.slice(0, -1);
	if (cycle.length === 0) return "";

	// Find index of lexicographically smallest element
	let minIdx = 0;
	for (let i = 1; i < cycle.length; i++) {
		if (cycle[i] < cycle[minIdx]) minIdx = i;
	}

	// Rotate so smallest is first
	const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
	return rotated.join("→");
}
