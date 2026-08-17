import type { CryptoClient } from "../crypto-client.js";
import type { TradingStore } from "../trading-store.js";
import type { TradingCircuitBreaker } from "./trading-circuit-breaker.js";

export interface EmergencyFlattenResult {
	flattened: Array<{
		positionId: string;
		symbol: string;
		side: "long" | "short";
		exitPrice: number;
		pnl: number;
		mode: "PAPER" | "LIVE";
	}>;
	failures: Array<{
		positionId: string;
		symbol: string;
		error: string;
	}>;
}

export async function emergencyFlattenAllPositions(input: {
	client: CryptoClient;
	store: TradingStore;
	circuitBreaker?: TradingCircuitBreaker;
	isPaperMode: boolean;
	/** Optional journal handle — closes the matching strategy_trades row so the learning loop can grade the outcome. */
	tradeJournal?: {
		closeTradeBySymbol: (
			symbol: string,
			direction: "long" | "short",
			exitPrice: number,
			exitReason: string,
		) => boolean;
	};
}): Promise<EmergencyFlattenResult> {
	const { client, store, circuitBreaker, isPaperMode, tradeJournal } = input;
	const flattened: EmergencyFlattenResult["flattened"] = [];
	const failures: EmergencyFlattenResult["failures"] = [];
	const feeRate = isPaperMode ? 0 : Number(store.getSetting("fee_rate") || "0.00075");

	for (const pos of store.getOpenPositions()) {
		if (![true, false, 0, 1].includes(pos.isPaper as never)) {
			failures.push({
				positionId: pos.id,
				symbol: pos.symbol,
				error: "Position mode is unknown; refused emergency exchange/local close",
			});
			continue;
		}
		const positionIsPaper = pos.isPaper === true || pos.isPaper === 1;
		if (positionIsPaper !== isPaperMode) continue;
		try {
			const ticker = await client.getTicker(pos.symbol);
			let exitPrice = pos.side === "long" ? ticker.bid : ticker.ask;

			if (!isPaperMode) {
				const order = await client.createOrder({
					symbol: pos.symbol,
					side: pos.side === "long" ? "SELL" : "BUY",
					type: "MARKET",
					qty: pos.qty,
				});
				if (!order.orderId || typeof client.getOrderDetail !== "function") {
					throw new Error("Emergency close could not reconcile exchange fill");
				}
				const fill = await client.getOrderDetail(pos.symbol, order.orderId);
				const tolerance = Math.max(1e-12, pos.qty * 1e-8);
				if (!Number.isFinite(fill.filledQty) || fill.filledQty <= 0) {
					throw new Error(
						`Emergency close fill not confirmed (${fill.status}, ${fill.filledQty}/${pos.qty})`,
					);
				}
				if (Number.isFinite(fill.avgPrice) && fill.avgPrice > 0) exitPrice = fill.avgPrice;
				const fullyFilled =
					fill.status.toUpperCase() === "FILLED" && fill.filledQty + tolerance >= pos.qty;
				if (!fullyFilled) {
					if (typeof client.cancelOrder === "function") {
						await client.cancelOrder(pos.symbol, order.orderId).catch(() => undefined);
					}
					const closedPart = store.closePartial(
						pos.id,
						Math.min(pos.qty, fill.filledQty),
						exitPrice,
					);
					if (closedPart?.pnl != null) circuitBreaker?.recordTrade(closedPart.pnl);
					failures.push({
						positionId: pos.id,
						symbol: pos.symbol,
						error:
							`Emergency close partially filled ${Math.min(pos.qty, fill.filledQty)}/${pos.qty}; ` +
							"local remaining quantity retained for reconciliation",
					});
					continue;
				}
			}

			const closed = store.closePosition(pos.id, exitPrice, feeRate);
			if (!closed || closed.pnl == null) {
				failures.push({
					positionId: pos.id,
					symbol: pos.symbol,
					error: "Position close returned no result",
				});
				continue;
			}

			circuitBreaker?.recordTrade(closed.pnl);
			tradeJournal?.closeTradeBySymbol(closed.symbol, closed.side, exitPrice, "emergency_flatten");
			flattened.push({
				positionId: pos.id,
				symbol: pos.symbol,
				side: pos.side,
				exitPrice,
				pnl: closed.pnl,
				mode: isPaperMode ? "PAPER" : "LIVE",
			});
		} catch (err) {
			failures.push({
				positionId: pos.id,
				symbol: pos.symbol,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { flattened, failures };
}
