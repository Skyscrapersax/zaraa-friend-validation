/**
 * Multi-dimensional performance attribution engine.
 *
 * Pure-function design (no DB dependency) — feed it an array of TradeRecords
 * and it returns a rich AttributionResult with breakdowns by hour, day,
 * symbol, strategy, tag, and hold-duration, plus actionable recommendations.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradeRecord {
	symbol: string;
	side: "buy" | "sell";
	entryPrice: number;
	exitPrice: number;
	quantity: number;
	pnl: number;
	entryTime: string; // ISO-8601
	exitTime: string; // ISO-8601
	strategy?: string;
	tags?: string[];
}

export interface HourBucket {
	hour: number;
	trades: number;
	winRate: number;
	avgPnl: number;
	totalPnl: number;
}

export interface DayBucket {
	day: string;
	trades: number;
	winRate: number;
	avgPnl: number;
	totalPnl: number;
}

export interface SymbolBucket {
	symbol: string;
	trades: number;
	winRate: number;
	avgPnl: number;
	totalPnl: number;
	bestTrade: number;
	worstTrade: number;
}

export interface StrategyBucket {
	strategy: string;
	trades: number;
	winRate: number;
	avgPnl: number;
	totalPnl: number;
	profitFactor: number;
}

export interface TagBucket {
	tag: string;
	trades: number;
	winRate: number;
	avgPnl: number;
	totalPnl: number;
}

export interface DurationBucket {
	bucket: string;
	trades: number;
	winRate: number;
	avgPnl: number;
}

export interface AttributionResult {
	byHourOfDay: HourBucket[];
	byDayOfWeek: DayBucket[];
	bySymbol: SymbolBucket[];
	byStrategy: StrategyBucket[];
	byTags: TagBucket[];
	byHoldDuration: DurationBucket[];
	bestPerformingHour: number;
	worstPerformingHour: number;
	bestPerformingDay: string;
	recommendations: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

const DURATION_BUCKETS = [
	{ label: "< 5min", maxMs: 5 * 60_000 },
	{ label: "5-15min", maxMs: 15 * 60_000 },
	{ label: "15-60min", maxMs: 60 * 60_000 },
	{ label: "1-4h", maxMs: 4 * 3_600_000 },
	{ label: "> 4h", maxMs: Infinity },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}

function winRate(trades: TradeRecord[]): number {
	if (trades.length === 0) return 0;
	const wins = trades.filter((t) => t.pnl > 0).length;
	return r2((wins / trades.length) * 100);
}

function avgPnl(trades: TradeRecord[]): number {
	if (trades.length === 0) return 0;
	return r2(trades.reduce((s, t) => s + t.pnl, 0) / trades.length);
}

function totalPnl(trades: TradeRecord[]): number {
	return r2(trades.reduce((s, t) => s + t.pnl, 0));
}

function profitFactor(trades: TradeRecord[]): number {
	const grossProfit = trades
		.filter((t) => t.pnl > 0)
		.reduce((s, t) => s + t.pnl, 0);
	const grossLoss = Math.abs(
		trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0),
	);
	if (grossLoss === 0) return grossProfit > 0 ? 999.99 : 0;
	return r2(grossProfit / grossLoss);
}

function holdDurationMs(trade: TradeRecord): number {
	return (
		new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime()
	);
}

function durationBucketLabel(ms: number): string {
	for (const bucket of DURATION_BUCKETS) {
		if (ms < bucket.maxMs) return bucket.label;
	}
	return "> 4h";
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const list = map.get(key);
		if (list) {
			list.push(item);
		} else {
			map.set(key, [item]);
		}
	}
	return map;
}

// ---------------------------------------------------------------------------
// AttributionAnalyzer
// ---------------------------------------------------------------------------

export class AttributionAnalyzer {
	/**
	 * Run full multi-dimensional attribution analysis on a set of closed trades.
	 */
	analyze(trades: TradeRecord[]): AttributionResult {
		if (trades.length === 0) {
			return {
				byHourOfDay: [],
				byDayOfWeek: [],
				bySymbol: [],
				byStrategy: [],
				byTags: [],
				byHoldDuration: [],
				bestPerformingHour: -1,
				worstPerformingHour: -1,
				bestPerformingDay: "N/A",
				recommendations: [
					"No closed trades to analyze. Start trading to generate attribution data.",
				],
			};
		}

		const byHourOfDay = this.analyzeByHour(trades);
		const byDayOfWeek = this.analyzeByDay(trades);
		const bySymbol = this.analyzeBySymbol(trades);
		const byStrategy = this.analyzeByStrategy(trades);
		const byTags = this.analyzeByTags(trades);
		const byHoldDuration = this.analyzeByHoldDuration(trades);

		// Determine best/worst hours (by avg P&L, minimum 3 trades)
		const qualifiedHours = byHourOfDay.filter((h) => h.trades >= 3);
		const bestHour =
			qualifiedHours.length > 0
				? qualifiedHours.reduce((best, h) =>
						h.avgPnl > best.avgPnl ? h : best,
					)
				: null;
		const worstHour =
			qualifiedHours.length > 0
				? qualifiedHours.reduce((worst, h) =>
						h.avgPnl < worst.avgPnl ? h : worst,
					)
				: null;

		// Determine best day (by avg P&L, minimum 3 trades)
		const qualifiedDays = byDayOfWeek.filter((d) => d.trades >= 3);
		const bestDay =
			qualifiedDays.length > 0
				? qualifiedDays.reduce((best, d) =>
						d.avgPnl > best.avgPnl ? d : best,
					)
				: null;

		const partial: Partial<AttributionResult> = {
			byHourOfDay,
			byDayOfWeek,
			bySymbol,
			byStrategy,
			byTags,
			byHoldDuration,
			bestPerformingHour: bestHour ? bestHour.hour : -1,
			worstPerformingHour: worstHour ? worstHour.hour : -1,
			bestPerformingDay: bestDay ? bestDay.day : "N/A",
		};

		const recommendations = this.generateRecommendations(partial, trades);

		return { ...partial, recommendations } as AttributionResult;
	}

	// -- Dimension: Hour of Day -----------------------------------------------

	private analyzeByHour(trades: TradeRecord[]): HourBucket[] {
		const grouped = groupBy(trades, (t) =>
			String(new Date(t.entryTime).getHours()),
		);

		const buckets: HourBucket[] = [];
		for (let h = 0; h < 24; h++) {
			const hourTrades = grouped.get(String(h));
			if (!hourTrades || hourTrades.length === 0) continue;
			buckets.push({
				hour: h,
				trades: hourTrades.length,
				winRate: winRate(hourTrades),
				avgPnl: avgPnl(hourTrades),
				totalPnl: totalPnl(hourTrades),
			});
		}

		return buckets.sort((a, b) => a.hour - b.hour);
	}

	// -- Dimension: Day of Week -----------------------------------------------

	private analyzeByDay(trades: TradeRecord[]): DayBucket[] {
		const grouped = groupBy(trades, (t) => {
			const dayIndex = new Date(t.entryTime).getDay();
			return DAYS[dayIndex];
		});

		return Array.from(grouped.entries())
			.map(([day, dayTrades]) => ({
				day,
				trades: dayTrades.length,
				winRate: winRate(dayTrades),
				avgPnl: avgPnl(dayTrades),
				totalPnl: totalPnl(dayTrades),
			}))
			.sort(
				(a, b) => DAYS.indexOf(a.day as (typeof DAYS)[number]) - DAYS.indexOf(b.day as (typeof DAYS)[number]),
			);
	}

	// -- Dimension: Symbol ----------------------------------------------------

	private analyzeBySymbol(trades: TradeRecord[]): SymbolBucket[] {
		const grouped = groupBy(trades, (t) => t.symbol);

		return Array.from(grouped.entries())
			.map(([symbol, symTrades]) => {
				const pnls = symTrades.map((t) => t.pnl);
				return {
					symbol,
					trades: symTrades.length,
					winRate: winRate(symTrades),
					avgPnl: avgPnl(symTrades),
					totalPnl: totalPnl(symTrades),
					bestTrade: r2(Math.max(...pnls)),
					worstTrade: r2(Math.min(...pnls)),
				};
			})
			.sort((a, b) => b.totalPnl - a.totalPnl);
	}

	// -- Dimension: Strategy --------------------------------------------------

	private analyzeByStrategy(trades: TradeRecord[]): StrategyBucket[] {
		const grouped = groupBy(trades, (t) => t.strategy ?? "untagged");

		return Array.from(grouped.entries())
			.map(([strategy, stratTrades]) => ({
				strategy,
				trades: stratTrades.length,
				winRate: winRate(stratTrades),
				avgPnl: avgPnl(stratTrades),
				totalPnl: totalPnl(stratTrades),
				profitFactor: profitFactor(stratTrades),
			}))
			.sort((a, b) => b.totalPnl - a.totalPnl);
	}

	// -- Dimension: Tags ------------------------------------------------------

	private analyzeByTags(trades: TradeRecord[]): TagBucket[] {
		const tagMap = new Map<string, TradeRecord[]>();

		for (const trade of trades) {
			const tags = trade.tags ?? [];
			for (const tag of tags) {
				const list = tagMap.get(tag);
				if (list) {
					list.push(trade);
				} else {
					tagMap.set(tag, [trade]);
				}
			}
		}

		return Array.from(tagMap.entries())
			.map(([tag, tagTrades]) => ({
				tag,
				trades: tagTrades.length,
				winRate: winRate(tagTrades),
				avgPnl: avgPnl(tagTrades),
				totalPnl: totalPnl(tagTrades),
			}))
			.sort((a, b) => b.totalPnl - a.totalPnl);
	}

	// -- Dimension: Hold Duration ---------------------------------------------

	private analyzeByHoldDuration(trades: TradeRecord[]): DurationBucket[] {
		const grouped = groupBy(trades, (t) =>
			durationBucketLabel(holdDurationMs(t)),
		);

		// Return in natural order matching DURATION_BUCKETS
		return DURATION_BUCKETS.map((db) => {
			const bucketTrades = grouped.get(db.label);
			if (!bucketTrades || bucketTrades.length === 0) {
				return { bucket: db.label, trades: 0, winRate: 0, avgPnl: 0 };
			}
			return {
				bucket: db.label,
				trades: bucketTrades.length,
				winRate: winRate(bucketTrades),
				avgPnl: avgPnl(bucketTrades),
			};
		}).filter((b) => b.trades > 0);
	}

	// -- Recommendation Engine ------------------------------------------------

	private generateRecommendations(
		result: Partial<AttributionResult>,
		trades: TradeRecord[],
	): string[] {
		const recs: string[] = [];
		const totalTradeCount = trades.length;

		// --- Time-based recommendations ---
		this.addHourRecommendations(result.byHourOfDay ?? [], recs);
		this.addDayRecommendations(result.byDayOfWeek ?? [], recs);

		// --- Symbol-based recommendations ---
		this.addSymbolRecommendations(result.bySymbol ?? [], totalTradeCount, recs);

		// --- Strategy-based recommendations ---
		this.addStrategyRecommendations(result.byStrategy ?? [], recs);

		// --- Hold-duration recommendations ---
		this.addDurationRecommendations(result.byHoldDuration ?? [], recs);

		// --- Tag-based recommendations ---
		this.addTagRecommendations(result.byTags ?? [], recs);

		// --- Overall recommendations ---
		this.addOverallRecommendations(trades, recs);

		return recs;
	}

	private addHourRecommendations(hours: HourBucket[], recs: string[]): void {
		const qualified = hours.filter((h) => h.trades >= 3);
		if (qualified.length < 2) return;

		const best = qualified.reduce((a, b) => (a.avgPnl > b.avgPnl ? a : b));
		const worst = qualified.reduce((a, b) => (a.avgPnl < b.avgPnl ? a : b));

		// Find consecutive good hours
		const goodHours = qualified
			.filter((h) => h.winRate >= 55 && h.avgPnl > 0)
			.map((h) => h.hour)
			.sort((a, b) => a - b);

		if (goodHours.length >= 2) {
			const ranges = this.findConsecutiveRanges(goodHours);
			for (const range of ranges) {
				if (range.length >= 2) {
					const start = range[0];
					const end = range[range.length - 1];
					const rangeTrades = qualified.filter(
						(h) => h.hour >= start && h.hour <= end,
					);
					const rangeWinRate = r2(
						rangeTrades.reduce((s, h) => s + h.winRate * h.trades, 0) /
							rangeTrades.reduce((s, h) => s + h.trades, 0),
					);
					recs.push(
						`You perform best during hours ${start}:00-${end + 1}:00 (${rangeWinRate}% weighted win rate). Consider focusing trading during this window.`,
					);
				}
			}
		} else if (best.avgPnl > 0) {
			recs.push(
				`Your best trading hour is ${best.hour}:00 (${best.winRate}% win rate, avg $${best.avgPnl}). Consider concentrating activity here.`,
			);
		}

		if (worst.avgPnl < 0 && worst.trades >= 5) {
			recs.push(
				`Avoid trading at ${worst.hour}:00 — ${worst.winRate}% win rate with avg loss of $${Math.abs(worst.avgPnl)} over ${worst.trades} trades.`,
			);
		}
	}

	private addDayRecommendations(days: DayBucket[], recs: string[]): void {
		const qualified = days.filter((d) => d.trades >= 3);
		if (qualified.length < 2) return;

		const worst = qualified.reduce((a, b) => (a.avgPnl < b.avgPnl ? a : b));
		if (worst.avgPnl < 0 && worst.trades >= 5) {
			recs.push(
				`${worst.day}s are your weakest day (${worst.winRate}% win rate, avg $${r2(worst.avgPnl)}). Consider reducing size or skipping this day.`,
			);
		}

		const best = qualified.reduce((a, b) => (a.avgPnl > b.avgPnl ? a : b));
		if (best.avgPnl > 0) {
			recs.push(
				`${best.day}s are your strongest day (${best.winRate}% win rate, avg $${r2(best.avgPnl)} over ${best.trades} trades).`,
			);
		}
	}

	private addSymbolRecommendations(
		symbols: SymbolBucket[],
		totalCount: number,
		recs: string[],
	): void {
		for (const sym of symbols) {
			if (sym.trades < 3) continue;

			// Losing symbol with significant sample
			if (sym.winRate < 45 && sym.totalPnl < 0) {
				recs.push(
					`${sym.symbol} has a ${sym.winRate}% win rate (${sym.trades} trades, total $${r2(sym.totalPnl)}). Consider reducing position sizes or reviewing your ${sym.symbol} strategy.`,
				);
			}

			// Big winner — reinforce
			if (
				sym.winRate >= 60 &&
				sym.totalPnl > 0 &&
				sym.trades >= 5
			) {
				recs.push(
					`${sym.symbol} is a strong performer: ${sym.winRate}% win rate, $${r2(sym.avgPnl)} avg P&L over ${sym.trades} trades. Consider sizing up on this instrument.`,
				);
			}

			// Over-concentration risk
			if (totalCount > 10 && sym.trades / totalCount > 0.5) {
				recs.push(
					`${sym.symbol} accounts for ${r2((sym.trades / totalCount) * 100)}% of all trades. Consider diversifying to reduce concentration risk.`,
				);
			}
		}
	}

	private addStrategyRecommendations(
		strategies: StrategyBucket[],
		recs: string[],
	): void {
		for (const strat of strategies) {
			if (strat.strategy === "untagged" || strat.trades < 3) continue;

			if (strat.profitFactor >= 2.0) {
				recs.push(
					`Your '${strat.strategy}' strategy has a profit factor of ${strat.profitFactor} — this is your strongest strategy. Consider allocating more capital here.`,
				);
			} else if (strat.profitFactor > 0 && strat.profitFactor < 1.0 && strat.trades >= 5) {
				recs.push(
					`Your '${strat.strategy}' strategy has a profit factor of ${strat.profitFactor} (losing money). Review entry/exit criteria or pause this strategy.`,
				);
			}

			if (strat.winRate < 40 && strat.trades >= 5) {
				recs.push(
					`'${strat.strategy}' has a ${strat.winRate}% win rate over ${strat.trades} trades. Tighten entry criteria or add confirmation filters.`,
				);
			}
		}

		// Suggest tagging if too many untagged
		const untagged = strategies.find((s) => s.strategy === "untagged");
		if (untagged && untagged.trades >= 10) {
			recs.push(
				`${untagged.trades} trades have no strategy tag. Tag your trades to enable better strategy-level analysis.`,
			);
		}
	}

	private addDurationRecommendations(
		durations: DurationBucket[],
		recs: string[],
	): void {
		for (const dur of durations) {
			if (dur.trades < 3) continue;

			if (dur.bucket === "< 5min" && dur.winRate < 45) {
				recs.push(
					`Trades held < 5min have a ${dur.winRate}% win rate (avg $${r2(dur.avgPnl)}). Avoid scalping or increase minimum hold time.`,
				);
			}

			if (dur.bucket === "> 4h" && dur.winRate < 40) {
				recs.push(
					`Long-duration trades (> 4h) have a ${dur.winRate}% win rate. Consider tightening stop-losses or taking profits earlier.`,
				);
			}
		}

		// Compare short vs long hold durations
		const shortDur = durations.find((d) => d.bucket === "< 5min");
		const medDur = durations.find((d) => d.bucket === "15-60min");
		if (
			shortDur &&
			medDur &&
			shortDur.trades >= 5 &&
			medDur.trades >= 5 &&
			medDur.avgPnl > shortDur.avgPnl * 2
		) {
			recs.push(
				`Mid-duration trades (15-60min) significantly outperform scalps. Consider shifting towards swing setups.`,
			);
		}
	}

	private addTagRecommendations(tags: TagBucket[], recs: string[]): void {
		// Flag dangerous behavioral tags
		const dangerTags = ["revenge-trade", "fomo-trade", "oversize"];
		for (const tag of tags) {
			if (dangerTags.includes(tag.tag) && tag.trades >= 3 && tag.avgPnl < 0) {
				recs.push(
					`Trades tagged '${tag.tag}' average $${r2(tag.avgPnl)} P&L over ${tag.trades} trades. This behavioral pattern is costing you money.`,
				);
			}
		}

		// Highlight strong setups
		for (const tag of tags) {
			if (
				tag.trades >= 5 &&
				tag.winRate >= 60 &&
				tag.avgPnl > 0 &&
				!dangerTags.includes(tag.tag)
			) {
				recs.push(
					`The '${tag.tag}' setup has a ${tag.winRate}% win rate over ${tag.trades} trades. This is a reliable edge — keep taking these setups.`,
				);
			}
		}
	}

	private addOverallRecommendations(
		trades: TradeRecord[],
		recs: string[],
	): void {
		if (trades.length < 20) {
			recs.push(
				`Only ${trades.length} trades analyzed. Attribution insights become more reliable with 50+ trades.`,
			);
		}

		// Check for streak of losses at the tail
		const recent = trades
			.slice()
			.sort(
				(a, b) =>
					new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime(),
			)
			.slice(0, 5);

		const recentLosses = recent.filter((t) => t.pnl < 0).length;
		if (recentLosses >= 4 && recent.length >= 5) {
			recs.push(
				`${recentLosses} of your last 5 trades were losses. Consider pausing to reassess market conditions and avoid tilt.`,
			);
		}

		// Win/loss asymmetry
		const wins = trades.filter((t) => t.pnl > 0);
		const losses = trades.filter((t) => t.pnl < 0);
		if (wins.length > 0 && losses.length > 0) {
			const avgWinAmt = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
			const avgLossAmt =
				Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length;
			const ratio = avgWinAmt / avgLossAmt;

			if (ratio < 1.0) {
				recs.push(
					`Your average win ($${r2(avgWinAmt)}) is smaller than your average loss ($${r2(avgLossAmt)}). Let winners run longer or tighten stop-losses.`,
				);
			} else if (ratio >= 2.0) {
				recs.push(
					`Good risk/reward discipline: average win ($${r2(avgWinAmt)}) is ${r2(ratio)}x your average loss ($${r2(avgLossAmt)}).`,
				);
			}
		}
	}

	/**
	 * Find runs of consecutive integers in a sorted array.
	 * e.g. [9,10,11,14,15] => [[9,10,11],[14,15]]
	 */
	private findConsecutiveRanges(sorted: number[]): number[][] {
		if (sorted.length === 0) return [];
		const ranges: number[][] = [[sorted[0]]];
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i] === sorted[i - 1] + 1) {
				ranges[ranges.length - 1].push(sorted[i]);
			} else {
				ranges.push([sorted[i]]);
			}
		}
		return ranges;
	}
}
