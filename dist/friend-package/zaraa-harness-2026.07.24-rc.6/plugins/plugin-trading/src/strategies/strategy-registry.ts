import type { Strategy } from "./strategy.js";
import { meanReversionStrategy } from "./builtin/mean-reversion.js";
import { trendFollowingStrategy } from "./builtin/trend-following.js";
import { breakoutStrategy } from "./builtin/breakout.js";
import { rsiDivergenceStrategy } from "./builtin/rsi-divergence.js";
import { momentumBreakoutStrategy } from "./builtin/momentum-breakout.js";
import { emaCrossoverStrategy } from "./builtin/ema-crossover.js";
import { volumeMomentumStrategy } from "./builtin/volume-momentum.js";

export interface ActiveStrategy {
	strategy: Strategy;
	symbols: string[];
	enabled: boolean;
	activatedAt: string;
}

/**
 * Always-off strategies with repeated negative expectancy in paper/shadow
 * journals. Merged with operator `trading.disabledStrategies` so config cannot
 * accidentally re-enable a known fee-bleed sleeve without code change.
 */
export const PROFIT_HARD_DISABLED_STRATEGIES: readonly string[] = [
	"trend-following",
	"rsi-divergence",
	"breakout",
	"momentum-breakout",
];

export function mergeDisabledStrategies(
	operatorDisabled: readonly string[] = [],
): string[] {
	return [...new Set([...PROFIT_HARD_DISABLED_STRATEGIES, ...operatorDisabled])];
}

export class StrategyRegistry {
	private strategies = new Map<string, Strategy>();
	private active = new Map<string, ActiveStrategy>();
	private disabled: Set<string>;

	/**
	 * @param disabledStrategies Names that `activate()` will skip. Strategies
	 * remain registered (visible via `list()` and `trade_list_strategies`) but
	 * cannot be activated, so the signal engine never sees them. Always merged
	 * with {@link PROFIT_HARD_DISABLED_STRATEGIES}.
	 */
	constructor(disabledStrategies: readonly string[] = []) {
		this.disabled = new Set(mergeDisabledStrategies(disabledStrategies));

		// Register built-in strategies
		this.register(meanReversionStrategy);
		this.register(trendFollowingStrategy);
		this.register(breakoutStrategy);
		this.register(rsiDivergenceStrategy);
		this.register(momentumBreakoutStrategy);
		this.register(emaCrossoverStrategy);
		this.register(volumeMomentumStrategy);
	}

	register(strategy: Strategy): void {
		this.strategies.set(strategy.name, strategy);
	}

	get(name: string): Strategy | undefined {
		return this.strategies.get(name);
	}

	list(): Strategy[] {
		return [...this.strategies.values()];
	}

	/** True when the operator has disabled this strategy via config. */
	isDisabled(name: string): boolean {
		return this.disabled.has(name);
	}

	/** Snapshot of currently-disabled strategy names. */
	getDisabled(): string[] {
		return [...this.disabled];
	}

	/**
	 * Activate a strategy for live/paper signal generation.
	 * If the name is in the disabled list, returns a non-enabled
	 * `ActiveStrategy` stub WITHOUT adding it to the active map — so
	 * `getActive()` / `isActive()` will not surface it, and the signal engine
	 * will never run it. The stub lets callers (the deploy tool, init wiring)
	 * keep their return-shape contract without throwing.
	 */
	activate(name: string, symbols: string[]): ActiveStrategy {
		const strategy = this.strategies.get(name);
		if (!strategy) throw new Error(`Strategy not found: ${name}`);

		if (this.disabled.has(name)) {
			return {
				strategy,
				symbols,
				enabled: false,
				activatedAt: new Date().toISOString(),
			};
		}

		const active: ActiveStrategy = {
			strategy,
			symbols,
			enabled: true,
			activatedAt: new Date().toISOString(),
		};
		this.active.set(name, active);
		return active;
	}

	deactivate(name: string): boolean {
		return this.active.delete(name);
	}

	getActive(): ActiveStrategy[] {
		return [...this.active.values()].filter((a) => a.enabled);
	}

	isActive(name: string): boolean {
		return this.active.get(name)?.enabled === true;
	}
}
