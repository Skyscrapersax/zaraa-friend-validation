import type { CryptoClient, TradeResult } from "../crypto-client.js";
import { scrubErrorMessage } from "../util/scrub-secrets.js";
import type { TradingStore } from "../trading-store.js";
import type { TradingEventLog } from "../engine/event-log.js";
import { resolvePaperMode } from "./trading-mode.js";

export interface Discrepancy {
	type: "partial_fill_mismatch" | "orphaned_exchange_order";
	symbol: string;
	detail: string;
	orderId?: string;
	exchangeQty?: number;
}

export interface ReconciliationResult {
	ok: boolean;
	skipped?: boolean;
	discrepancies: Discrepancy[];
	error?: string;
	checkedAt: string;
	/** Hours of submitted_orders history included in this run (from settings or default). */
	lookbackHours: number;
}

/** Aligns with submitted_orders TTL (24h) so open orders are not false “orphans” after one hour. */
export const DEFAULT_RECONCILE_LOOKBACK_HOURS = 24;

/** How long an orphaned exchange order must persist before auto-cancellation (5 minutes). */
export const DEFAULT_ORPHAN_GRACE_MS = 300_000;
export const MIN_RECONCILE_LOOKBACK_HOURS = 1;
export const MAX_RECONCILE_LOOKBACK_HOURS = 168;

const RECONCILE_LOOKBACK_SETTING = "reconcile_lookback_hours";

// Row shape from the submitted_orders table (migration 005, camelCase columns)
interface SubmittedOrderRow {
	key: string;
	orderId: string | null;
	status: string;
	symbol: string;
	createdAt: string;
}

/**
 * Whether an exchange-reported open order status should be treated as a partial fill
 * (needs operator attention vs fully working limit/market flow).
 * Normalizes casing, spaces, and hyphens; avoids matching NOT_FILLED / UNFILLED.
 */
export function isPartialFillOrderStatus(status: string): boolean {
	const s = status.trim().toUpperCase().replace(/[\s-]+/g, "_");
	if (s === "PARTIALLY_FILLED" || s === "PARTIAL_FILL" || s === "PARTIALLYFILLED") {
		return true;
	}
	if (!s.includes("PARTIAL")) return false;
	if (s.includes("NOT_") || s === "NOTFILLED" || s === "UNFILLED") return false;
	return s.includes("FILL") || s.includes("FILLED");
}

export function resolveReconcileLookbackHours(store: TradingStore): number {
	const raw = store.getSetting(RECONCILE_LOOKBACK_SETTING);
	if (raw == null || raw === "") return DEFAULT_RECONCILE_LOOKBACK_HOURS;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_RECONCILE_LOOKBACK_HOURS;
	return Math.min(
		MAX_RECONCILE_LOOKBACK_HOURS,
		Math.max(MIN_RECONCILE_LOOKBACK_HOURS, Math.trunc(n)),
	);
}

function dedupeOpenOrdersById(orders: TradeResult[]): TradeResult[] {
	const seen = new Set<string>();
	const out: TradeResult[] = [];
	for (const o of orders) {
		if (!o.orderId || seen.has(o.orderId)) continue;
		seen.add(o.orderId);
		out.push(o);
	}
	return out;
}

export interface CancelledOrphan {
	orderId: string;
	symbol: string;
	dryRun: boolean;
}

export interface CancelError {
	orderId: string;
	error: string;
}

export interface ReconcileAndCleanResult {
	ok: boolean;
	skipped?: boolean;
	cancelled: CancelledOrphan[];
	cancelErrors: CancelError[];
	discrepancies: Discrepancy[];
	checkedAt: string;
	lookbackHours: number;
	error?: string;
}

const ORPHAN_TRACKER_KEY = "orphan_first_seen";

export class OrderReconciler {
	constructor(
		private deps: {
			store: TradingStore;
			client: CryptoClient;
		},
	) {}

	/**
	 * @param options.referenceTimeMs — Optional clock anchor for tests (cutoff window and checkedAt).
	 */
	async reconcile(options?: { referenceTimeMs?: number }): Promise<ReconciliationResult> {
		const refMs = options?.referenceTimeMs ?? Date.now();
		const now = new Date(refMs).toISOString();
		const lookbackHours = resolveReconcileLookbackHours(this.deps.store);

		if (resolvePaperMode(this.deps.store)) {
			return { ok: true, skipped: true, discrepancies: [], checkedAt: now, lookbackHours };
		}

		let exchangeOrders: TradeResult[];
		try {
			exchangeOrders = await this.deps.client.getOpenOrders();
		} catch (err) {
			const msg =
				typeof this.deps.client.scrubError === "function"
					? this.deps.client.scrubError(err)
					: scrubErrorMessage(err);
			console.error(`[order-reconciler] Exchange API error: ${msg}`);
			return { ok: false, discrepancies: [], error: msg, checkedAt: now, lookbackHours };
		}

		exchangeOrders = dedupeOpenOrdersById(exchangeOrders);

		const discrepancies: Discrepancy[] = [];

		// Use JS time for the window so it matches how createdAt is written (ISO from Node),
		// and so tests can pin referenceTimeMs to simulate clock / skew scenarios.
		const cutoffIso = new Date(refMs - lookbackHours * 3600_000).toISOString();
		const db = this.deps.store.getDb();
		const submittedOrders = db
			.prepare(
				"SELECT * FROM submitted_orders WHERE createdAt > ? ORDER BY createdAt DESC",
			)
			.all(cutoffIso) as SubmittedOrderRow[];

		// Build a quick lookup: exchangeOrderId → local row
		const localByOrderId = new Map<string, SubmittedOrderRow>();
		for (const row of submittedOrders) {
			if (row.orderId) {
				localByOrderId.set(row.orderId, row);
			}
		}

		for (const exOrder of exchangeOrders) {
			const localOrder = localByOrderId.get(exOrder.orderId);

			if (!localOrder) {
				// Exchange has an order we have no local record of
				discrepancies.push({
					type: "orphaned_exchange_order",
					symbol: exOrder.symbol,
					detail: `Exchange order ${exOrder.orderId} not found in local records`,
					orderId: exOrder.orderId,
					exchangeQty: exOrder.qty,
				});
				continue;
			}

			if (isPartialFillOrderStatus(exOrder.status)) {
				// Partially-filled working order — local state may not reflect remaining size
				discrepancies.push({
					type: "partial_fill_mismatch",
					symbol: exOrder.symbol,
					detail: `Order ${exOrder.orderId} is partially filled (exchange status=${exOrder.status}, qty=${exOrder.qty})`,
					orderId: exOrder.orderId,
					exchangeQty: exOrder.qty,
				});
			}
		}

		if (discrepancies.length > 0) {
			console.warn(
				`[order-reconciler] ${discrepancies.length} discrepancies found:`,
				discrepancies.map((d) => d.detail).join("; "),
			);
		}

		return { ok: discrepancies.length === 0, discrepancies, checkedAt: now, lookbackHours };
	}

	/**
	 * Like `reconcile`, but also auto-cancels orphaned exchange orders after a grace period.
	 * First-seen timestamps are persisted in store settings under `orphan_first_seen` (JSON map).
	 */
	async reconcileAndClean(options?: {
		referenceTimeMs?: number;
		gracePeriodMs?: number;
		dryRun?: boolean;
		eventLog?: TradingEventLog;
	}): Promise<ReconcileAndCleanResult> {
		const refMs = options?.referenceTimeMs ?? Date.now();
		const gracePeriodMs = options?.gracePeriodMs ?? DEFAULT_ORPHAN_GRACE_MS;
		const dryRun = options?.dryRun ?? false;
		const eventLog = options?.eventLog;
		const now = new Date(refMs).toISOString();
		const lookbackHours = resolveReconcileLookbackHours(this.deps.store);

		if (resolvePaperMode(this.deps.store)) {
			return { ok: true, skipped: true, cancelled: [], cancelErrors: [], discrepancies: [], checkedAt: now, lookbackHours };
		}

		let exchangeOrders: TradeResult[];
		try {
			exchangeOrders = await this.deps.client.getOpenOrders();
		} catch (err) {
			const msg =
				typeof this.deps.client.scrubError === "function"
					? this.deps.client.scrubError(err)
					: scrubErrorMessage(err);
			return { ok: false, cancelled: [], cancelErrors: [], discrepancies: [], error: msg, checkedAt: now, lookbackHours };
		}

		exchangeOrders = dedupeOpenOrdersById(exchangeOrders);

		// Load orphan tracker
		const trackerRaw = this.deps.store.getSetting(ORPHAN_TRACKER_KEY);
		const tracker: Record<string, number> = trackerRaw ? JSON.parse(trackerRaw) : {};

		// Run standard discrepancy detection
		const cutoffIso = new Date(refMs - lookbackHours * 3600_000).toISOString();
		const db = this.deps.store.getDb();
		const submittedOrders = db
			.prepare("SELECT * FROM submitted_orders WHERE createdAt > ? ORDER BY createdAt DESC")
			.all(cutoffIso) as SubmittedOrderRow[];
		const localByOrderId = new Map<string, SubmittedOrderRow>();
		for (const row of submittedOrders) {
			if (row.orderId) localByOrderId.set(row.orderId, row);
		}

		const discrepancies: Discrepancy[] = [];
		const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.orderId));
		const cancelled: CancelledOrphan[] = [];
		const cancelErrors: CancelError[] = [];

		for (const exOrder of exchangeOrders) {
			if (isPartialFillOrderStatus(exOrder.status)) {
				discrepancies.push({
					type: "partial_fill_mismatch",
					symbol: exOrder.symbol,
					detail: `Order ${exOrder.orderId} is partially filled (exchange status=${exOrder.status}, qty=${exOrder.qty})`,
					orderId: exOrder.orderId,
					exchangeQty: exOrder.qty,
				});
				continue;
			}

			if (localByOrderId.has(exOrder.orderId)) continue;

			// Orphaned order — track first-seen
			if (tracker[exOrder.orderId] == null) {
				tracker[exOrder.orderId] = refMs;
			}

			const firstSeen = tracker[exOrder.orderId];
			if (refMs - firstSeen < gracePeriodMs) continue;

			// Grace period expired — cancel or report
			if (!dryRun) {
				try {
					await this.deps.client.cancelOrder(exOrder.symbol, exOrder.orderId);
					delete tracker[exOrder.orderId];
					cancelled.push({ orderId: exOrder.orderId, symbol: exOrder.symbol, dryRun: false });
					eventLog?.append("position_closed", { action: "orphan_cancelled", orderId: exOrder.orderId, symbol: exOrder.symbol }, { symbol: exOrder.symbol });
				} catch (err) {
					const msg =
						typeof this.deps.client.scrubError === "function"
							? this.deps.client.scrubError(err)
							: scrubErrorMessage(err);
					cancelErrors.push({ orderId: exOrder.orderId, error: msg });
				}
			} else {
				cancelled.push({ orderId: exOrder.orderId, symbol: exOrder.symbol, dryRun: true });
			}

			discrepancies.push({
				type: "orphaned_exchange_order",
				symbol: exOrder.symbol,
				detail: `Exchange order ${exOrder.orderId} not found in local records`,
				orderId: exOrder.orderId,
				exchangeQty: exOrder.qty,
			});
		}

		// Clean up tracker entries for orders no longer on exchange
		for (const trackedId of Object.keys(tracker)) {
			if (!exchangeOrderIds.has(trackedId)) {
				delete tracker[trackedId];
			}
		}

		this.deps.store.setSetting(ORPHAN_TRACKER_KEY, JSON.stringify(tracker));

		return {
			ok: discrepancies.length === 0 && cancelErrors.length === 0,
			cancelled,
			cancelErrors,
			discrepancies,
			checkedAt: now,
			lookbackHours,
		};
	}
}
