import { EventEmitter } from "node:events";
import { z } from "zod";

const DEFAULT_WS_URL = "wss://stream.crypto.com/v2/market";

// ── Zod schemas for incoming WebSocket messages ──────────────────────
const TickDataSchema = z.object({
	i: z.union([z.string(), z.number()]).optional(),
	b: z.union([z.string(), z.number()]).optional(),
	k: z.union([z.string(), z.number()]).optional(),
	a: z.union([z.string(), z.number()]).optional(),
	h: z.union([z.string(), z.number()]).optional(),
	l: z.union([z.string(), z.number()]).optional(),
	v: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const TickerResultSchema = z.object({
	channel: z.string().optional(),
	instrument_name: z.string().optional(),
	data: z.array(TickDataSchema).optional(),
}).passthrough();

/** Top-level WebSocket message — covers heartbeats, ticker data, and subscription acks */
const WsMessageSchema = z.object({
	method: z.string().optional(),
	result: TickerResultSchema.optional(),
}).passthrough();

export interface PriceUpdate {
	symbol: string;
	bid: number;
	ask: number;
	last: number;
	high24h: number;
	low24h: number;
	volume24h: number;
	timestamp: number;
}

export interface PriceFeedConfig {
	/** WebSocket URL (default: Crypto.com market stream) */
	url?: string;
	/** Auto-reconnect on disconnect (default: true) */
	autoReconnect?: boolean;
	/** Reconnect delay in ms (default: 3000, doubles each retry up to 30s) */
	reconnectDelayMs?: number;
	/** Max reconnect delay in ms (default: 30000) */
	maxReconnectDelayMs?: number;
	/** Heartbeat interval in ms (default: 30000) */
	heartbeatIntervalMs?: number;
}

export interface PriceFeedEvents {
	price: (update: PriceUpdate) => void;
	connected: () => void;
	disconnected: (reason: string) => void;
	error: (error: Error) => void;
	subscribed: (symbols: string[]) => void;
}

type PriceFeedEventName = keyof PriceFeedEvents;

/**
 * Real-time WebSocket price feed.
 * Connects to exchange WebSocket, subscribes to ticker channels,
 * and emits price updates. Auto-reconnects on disconnect.
 *
 * Usage:
 *   const feed = new PriceFeed();
 *   feed.on("price", (update) => console.log(update));
 *   await feed.connect();
 *   feed.subscribe(["BTC_USDT", "ETH_USDT"]);
 */
export class PriceFeed extends EventEmitter {
	private config: Required<PriceFeedConfig>;
	private ws: WebSocket | null = null;
	private subscriptions = new Set<string>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private currentDelay: number;
	private requestId = 1;
	private _connected = false;
	private _closed = false;
	private latestPrices = new Map<string, PriceUpdate>();

	// Bound handlers — stored so they can be removed on reconnect/close
	private boundHandleMessage = (event: MessageEvent) => {
		this.handleMessage(event.data as string);
	};
	private boundHandleClose = (event: CloseEvent) => {
		this._connected = false;
		this.stopHeartbeat();
		this.emit("disconnected", event.reason || "connection closed");
		if (this.config.autoReconnect && !this._closed) {
			this.scheduleReconnect();
		}
	};

	constructor(config: PriceFeedConfig = {}) {
		super();
		this.config = {
			url: config.url ?? DEFAULT_WS_URL,
			autoReconnect: config.autoReconnect ?? true,
			reconnectDelayMs: config.reconnectDelayMs ?? 3000,
			maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30000,
			heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
		};
		this.currentDelay = this.config.reconnectDelayMs;
	}

	// Type-safe event methods
	on<E extends PriceFeedEventName>(event: E, listener: PriceFeedEvents[E]): this {
		return super.on(event, listener);
	}

	emit<E extends PriceFeedEventName>(event: E, ...args: Parameters<PriceFeedEvents[E]>): boolean {
		return super.emit(event, ...args);
	}

	get connected(): boolean {
		return this._connected;
	}

	get subscribedSymbols(): string[] {
		return Array.from(this.subscriptions);
	}

	/** Maximum age (ms) for a cached price to be considered fresh. Default: 60s. */
	private static readonly MAX_STALENESS_MS = 60_000;

	/**
	 * Get the latest cached price for a symbol (if available from WebSocket stream).
	 * Returns undefined if the cached price is stale (older than MAX_STALENESS_MS),
	 * e.g., during a WebSocket reconnect gap.
	 */
	getLatestPrice(symbol: string): PriceUpdate | undefined {
		const update = this.latestPrices.get(symbol);
		if (!update) return undefined;
		if (Date.now() - update.timestamp > PriceFeed.MAX_STALENESS_MS) return undefined;
		return update;
	}

	/**
	 * Get all cached prices.
	 */
	getAllPrices(): Map<string, PriceUpdate> {
		return new Map(this.latestPrices);
	}

	/**
	 * Connect to the WebSocket server.
	 */
	async connect(): Promise<void> {
		if (this._connected || this._closed) return;

		return new Promise<void>((resolve, reject) => {
			try {
				// Remove listeners from any previous WebSocket before creating a new one
				this.detachWsListeners();

				this.ws = new WebSocket(this.config.url);

				const onOpen = () => {
					this._connected = true;
					this.currentDelay = this.config.reconnectDelayMs;
					this.startHeartbeat();
					this.emit("connected");

					// Resubscribe to any previously subscribed channels
					if (this.subscriptions.size > 0) {
						this.sendSubscribe(Array.from(this.subscriptions));
					}

					resolve();
				};

				const onError = (event: Event) => {
					const err = new Error(`WebSocket error: ${(event as ErrorEvent).message ?? "connection failed"}`);
					this.emit("error", err);
					if (!this._connected) reject(err);
				};

				this.ws.addEventListener("open", onOpen, { once: true });
				this.ws.addEventListener("error", onError, { once: true });

				this.ws.addEventListener("message", this.boundHandleMessage);
				this.ws.addEventListener("close", this.boundHandleClose);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * Subscribe to real-time ticker updates for symbols.
	 */
	subscribe(symbols: string[]): void {
		const newSymbols = symbols.filter((s) => !this.subscriptions.has(s));
		if (newSymbols.length === 0) return;

		for (const s of newSymbols) {
			this.subscriptions.add(s);
		}

		if (this._connected && this.ws) {
			this.sendSubscribe(newSymbols);
		}
	}

	/**
	 * Unsubscribe from symbols.
	 */
	unsubscribe(symbols: string[]): void {
		const toRemove = symbols.filter((s) => this.subscriptions.has(s));
		if (toRemove.length === 0) return;

		for (const s of toRemove) {
			this.subscriptions.delete(s);
			this.latestPrices.delete(s);
		}

		if (this._connected && this.ws) {
			const channels = toRemove.map((s) => `ticker.${s}`);
			this.ws.send(JSON.stringify({
				id: this.requestId++,
				method: "unsubscribe",
				params: { channels },
			}));
		}
	}

	/**
	 * Disconnect and stop all activity.
	 */
	close(): void {
		this._closed = true;
		this.stopHeartbeat();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.detachWsListeners();
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this._connected = false;
		this.latestPrices.clear();
	}

	/**
	 * Get connection status info.
	 */
	status(): {
		connected: boolean;
		subscriptions: string[];
		cachedPrices: number;
		url: string;
	} {
		return {
			connected: this._connected,
			subscriptions: Array.from(this.subscriptions),
			cachedPrices: this.latestPrices.size,
			url: this.config.url,
		};
	}

	/** Remove message/close listeners from the current WebSocket (idempotent). */
	private detachWsListeners(): void {
		if (!this.ws) return;
		this.ws.removeEventListener("message", this.boundHandleMessage);
		this.ws.removeEventListener("close", this.boundHandleClose);
	}

	private sendSubscribe(symbols: string[]): void {
		if (!this.ws || !this._connected) return;
		const channels = symbols.map((s) => `ticker.${s}`);
		this.ws.send(JSON.stringify({
			id: this.requestId++,
			method: "subscribe",
			params: { channels },
		}));
		this.emit("subscribed", symbols);
	}

	private handleMessage(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			console.debug("[price-feed] malformed JSON:", err instanceof Error ? err.message : err);
			return;
		}

		const result = WsMessageSchema.safeParse(parsed);
		if (!result.success) {
			const truncated = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
			console.warn("[price-feed] message failed validation, skipping:", truncated);
			return;
		}

		const msg = result.data;

		// Heartbeat response
		if (msg.method === "public/heartbeat") {
			this.ws?.send(JSON.stringify({
				id: this.requestId++,
				method: "public/respond-heartbeat",
			}));
			return;
		}

		// Ticker subscription data
		if (msg.result?.channel?.startsWith("ticker.") && msg.result.data) {
			for (const tick of msg.result.data) {
				const bid = Number(tick.b ?? 0);
				const ask = Number(tick.k ?? 0);
				const last = Number(tick.a ?? 0);
				// Reject ticks with NaN prices — Number("abc") produces NaN which would corrupt trading decisions
				if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(last)) continue;

				const update: PriceUpdate = {
					symbol: String(tick.i ?? msg.result.instrument_name ?? ""),
					bid,
					ask,
					last,
					high24h: Number(tick.h ?? 0),
					low24h: Number(tick.l ?? 0),
					volume24h: Number(tick.v ?? 0),
					timestamp: Date.now(),
				};

				if (update.symbol) {
					this.latestPrices.set(update.symbol, update);
					this.emit("price", update);
				}
			}
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		if (this._closed) return; // Don't start heartbeat on a closed feed
		this.heartbeatTimer = setInterval(() => {
			if (this._closed || !this.ws || !this._connected) {
				this.stopHeartbeat();
				return;
			}
			try {
				this.ws.send(JSON.stringify({
					id: this.requestId++,
					method: "public/heartbeat",
				}));
			} catch (err) {
				console.debug("[price-feed] heartbeat send failed:", err instanceof Error ? err.message : err);
				this.stopHeartbeat();
			}
		}, this.config.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this._closed) return;

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			try {
				await this.connect();
			} catch (err) {
				console.debug("[price-feed] reconnect failed:", err instanceof Error ? err.message : err);
				this.currentDelay = Math.min(
					this.currentDelay * 2,
					this.config.maxReconnectDelayMs,
				);
				if (!this._closed) {
					this.scheduleReconnect();
				}
			}
		}, this.currentDelay);
	}
}
