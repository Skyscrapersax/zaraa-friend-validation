/**
 * Solana DEX execution via Jupiter quote + swap API (v6).
 * Paper mode uses quote-only implied price; live mode signs and sends (optional key).
 */

import { randomUUID } from "node:crypto";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { TradingStore } from "../trading-store.js";
import { DEX_EXECUTION_VENUE_SOLANA } from "./dex-execution-symbol.js";
import { SOLANA_TOKENS } from "./solana-client.js";
import { resolvePaperMode } from "../risk/trading-mode.js";
import { validateLiveModeLock } from "../risk/live-mode-lock.js";

const JUPITER_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP = "https://quote-api.jup.ag/v6/swap";
const DEFAULT_SLIPPAGE_BPS = 50;
const USDC_MINT = SOLANA_TOKENS.USDC.address;

/**
 * Hard ceiling on slippage tolerance sent to Jupiter.
 * 300 bps = 3%.  Higher values are silently clamped down.
 */
export const MAX_SAFE_SLIPPAGE_BPS = 300;

/**
 * Minimum safe slippage (floors NaN / negative values).
 * 1 bps prevents zero-slippage API errors.
 */
export const MIN_SLIPPAGE_BPS = 1;

/**
 * Default price-impact ceiling (10%).  Swaps whose quote shows higher
 * impact than this are rejected.  Override per-call via maxPriceImpactPct.
 */
export const DEFAULT_MAX_PRICE_IMPACT_PCT = 0.1;

export interface JupiterQuoteSummary {
	inputMint: string;
	outputMint: string;
	inAmount: string;
	outAmount: string;
	priceImpactPct?: string;
	raw: Record<string, unknown>;
}

export interface JupiterSwapPaperResult {
	symbol: string;
	side: "BUY" | "SELL";
	entryPriceUsd: number;
	qtyToken: number;
	notionalUsd: number;
	slippageBps: number;
	routeJson: string;
}

export interface JupiterSwapLiveResult extends JupiterSwapPaperResult {
	txSignature: string;
}

function tokenDecimals(sym: string): number {
	const t = SOLANA_TOKENS[sym.toUpperCase()];
	if (!t)
		throw new Error(
			`Unknown Solana token symbol "${sym}" — add to SOLANA_TOKENS or use a supported pair`,
		);
	return t.decimals;
}

function tokenMint(sym: string): string {
	const t = SOLANA_TOKENS[sym.toUpperCase()];
	if (!t)
		throw new Error(
			`Unknown Solana token symbol "${sym}" — add to SOLANA_TOKENS or use a supported pair`,
		);
	return t.address;
}

function toRawAmount(human: number, decimals: number): string {
	if (!Number.isFinite(human) || human <= 0)
		throw new Error("qty must be a positive finite number");
	const n = BigInt(Math.round(human * 10 ** decimals));
	return n.toString();
}

/**
 * Clamp slippage to [MIN_SLIPPAGE_BPS, MAX_SAFE_SLIPPAGE_BPS].
 * NaN, negative, or non-finite values are floored to MIN_SLIPPAGE_BPS.
 */
function safeSlippage(raw: number | undefined): number {
	const v = raw ?? DEFAULT_SLIPPAGE_BPS;
	if (!Number.isFinite(v) || v < MIN_SLIPPAGE_BPS) return MIN_SLIPPAGE_BPS;
	return Math.min(v, MAX_SAFE_SLIPPAGE_BPS);
}

async function fetchQuote(
	params: URLSearchParams,
	fetchFn: typeof fetch,
): Promise<JupiterQuoteSummary> {
	const url = `${JUPITER_QUOTE}?${params.toString()}`;
	const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
	if (!res.ok) {
		const t = await res.text().catch(() => "");
		throw new Error(`Jupiter quote failed HTTP ${res.status}: ${t.slice(0, 200)}`);
	}
	const raw = (await res.json()) as Record<string, unknown>;
	return {
		inputMint: String(raw.inputMint ?? ""),
		outputMint: String(raw.outputMint ?? ""),
		inAmount: String(raw.inAmount ?? "0"),
		outAmount: String(raw.outAmount ?? "0"),
		priceImpactPct: raw.priceImpactPct != null ? String(raw.priceImpactPct) : undefined,
		raw,
	};
}

/**
 * Guard: reject if the quote's priceImpactPct exceeds the ceiling.
 * Does NOT fail-closed on a missing/unparseable field (Jupiter may omit it
 * for very liquid pairs).
 */
function assertPriceImpact(q: JupiterQuoteSummary, ceiling: number): void {
	if (q.priceImpactPct == null) return; // missing -> allow
	const impact = Number(q.priceImpactPct);
	if (!Number.isFinite(impact)) return; // unparseable -> allow
	if (impact > ceiling) {
		throw new Error(
			`Jupiter quote price impact ${(impact * 100).toFixed(2)}% exceeds ceiling ${(ceiling * 100).toFixed(2)}% — swap blocked`,
		);
	}
}

function impliedUsdPriceFromQuote(
	direction: "long" | "short",
	qtyToken: number,
	q: JupiterQuoteSummary,
): { entryPriceUsd: number; notionalUsd: number } {
	if (direction === "long") {
		// ExactOut: spend USDC (inAmount), receive token (outAmount)
		const inUsdc = Number(q.inAmount) / 10 ** 6;
		const entryPriceUsd = qtyToken > 0 ? inUsdc / qtyToken : 0;
		return { entryPriceUsd, notionalUsd: inUsdc };
	}
	// ExactIn: sell token (inAmount), receive USDC (outAmount)
	const outUsdc = Number(q.outAmount) / 10 ** 6;
	const entryPriceUsd = qtyToken > 0 ? outUsdc / qtyToken : 0;
	return { entryPriceUsd, notionalUsd: outUsdc };
}

export interface JupiterSwapExecutorConfig {
	store: TradingStore;
	rpcUrl?: string;
	/** Base58-encoded Solana secret key (64 bytes). Live swaps only. */
	secretKeyBase58?: string;
	fetchFn?: typeof fetch;
	/**
	 * Daily-rotating live-mode lock string.  Required for live swaps.
	 * Format: "I-CONFIRM-LIVE-TRADING-YYYY-MM-DD" (UTC date).
	 */
	liveModeLock?: string;
}

export class JupiterSwapExecutor {
	private store: TradingStore;
	private rpcUrl: string;
	private secretKeyBase58?: string;
	private fetchFn: typeof fetch;
	private liveModeLock?: string;

	constructor(cfg: JupiterSwapExecutorConfig) {
		this.store = cfg.store;
		this.rpcUrl = cfg.rpcUrl ?? "https://api.mainnet-beta.solana.com";
		this.secretKeyBase58 = cfg.secretKeyBase58;
		this.fetchFn = cfg.fetchFn ?? fetch;
		this.liveModeLock = cfg.liveModeLock;
	}

	async quoteAndSwapPaper(params: {
		tokenSymbol: string;
		direction: "long" | "short";
		qty: number;
		slippageBps?: number;
		/** Reject quotes whose priceImpactPct exceeds this value. Default 0.10 (10%). */
		maxPriceImpactPct?: number;
	}): Promise<JupiterSwapPaperResult> {
		const slippageBps = safeSlippage(params.slippageBps);
		const priceCeiling =
			params.maxPriceImpactPct != null
				? params.maxPriceImpactPct
				: DEFAULT_MAX_PRICE_IMPACT_PCT;
		const tokenSym = params.tokenSymbol.toUpperCase();
		const qty = params.qty;
		const tokenMintAddr = tokenMint(tokenSym);
		const dec = tokenDecimals(tokenSym);

		let q: JupiterQuoteSummary;
		if (params.direction === "long") {
			const amount = toRawAmount(qty, dec);
			const p = new URLSearchParams({
				inputMint: USDC_MINT,
				outputMint: tokenMintAddr,
				amount,
				slippageBps: String(slippageBps),
				swapMode: "ExactOut",
			});
			q = await fetchQuote(p, this.fetchFn);
		} else {
			const amount = toRawAmount(qty, dec);
			const p = new URLSearchParams({
				inputMint: tokenMintAddr,
				outputMint: USDC_MINT,
				amount,
				slippageBps: String(slippageBps),
				swapMode: "ExactIn",
			});
			q = await fetchQuote(p, this.fetchFn);
		}

		// Guard: price impact ceiling
		assertPriceImpact(q, priceCeiling);

		const { entryPriceUsd, notionalUsd } = impliedUsdPriceFromQuote(params.direction, qty, q);
		if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
			throw new Error("Could not derive USD price from Jupiter quote");
		}

		const routeJson = JSON.stringify({
			inputMint: q.inputMint,
			outputMint: q.outputMint,
			inAmount: q.inAmount,
			outAmount: q.outAmount,
			priceImpactPct: q.priceImpactPct,
		});

		return {
			symbol: `solana:${tokenSym}`,
			side: params.direction === "long" ? "BUY" : "SELL",
			entryPriceUsd,
			qtyToken: qty,
			notionalUsd,
			slippageBps,
			routeJson,
		};
	}

	async quoteAndSwapLive(params: {
		tokenSymbol: string;
		direction: "long" | "short";
		qty: number;
		slippageBps?: number;
		/**
		 * Re-validate the live-quote notionalUsd against this cap before
		 * building/signing the swap.  Pass max_trade_usd from settings.
		 */
		maxNotionalUsd?: number;
		/** Reject quotes whose priceImpactPct exceeds this value. Default 0.10 (10%). */
		maxPriceImpactPct?: number;
	}): Promise<JupiterSwapLiveResult> {
		// ── Guard 1: paperMode + liveModeLock (defense-in-depth) ──────────────
		// Must run BEFORE any network call or key decode.
		const isPaper = resolvePaperMode(this.store);
		if (isPaper) {
			throw new Error(
				"quoteAndSwapLive called while paper_mode is enabled — set paper_mode=false in zaraa.config.json to enable live trading",
			);
		}
		const lockResult = validateLiveModeLock(this.liveModeLock, false);
		if (!lockResult.ok) {
			throw new Error(
				`quoteAndSwapLive blocked: ${lockResult.reason}`,
			);
		}

		const tokenSym = params.tokenSymbol.toUpperCase();
		const tokenMintAddr = tokenMint(tokenSym);
		const dec = tokenDecimals(tokenSym);
		const slippageBps = safeSlippage(params.slippageBps);
		const priceCeiling =
			params.maxPriceImpactPct != null
				? params.maxPriceImpactPct
				: DEFAULT_MAX_PRICE_IMPACT_PCT;
		const qty = params.qty;

		let q: JupiterQuoteSummary;
		if (params.direction === "long") {
			const amount = toRawAmount(qty, dec);
			const p = new URLSearchParams({
				inputMint: USDC_MINT,
				outputMint: tokenMintAddr,
				amount,
				slippageBps: String(slippageBps),
				swapMode: "ExactOut",
			});
			q = await fetchQuote(p, this.fetchFn);
		} else {
			const amount = toRawAmount(qty, dec);
			const p = new URLSearchParams({
				inputMint: tokenMintAddr,
				outputMint: USDC_MINT,
				amount,
				slippageBps: String(slippageBps),
				swapMode: "ExactIn",
			});
			q = await fetchQuote(p, this.fetchFn);
		}

		// ── Guard 2: price impact ceiling ─────────────────────────────────────
		assertPriceImpact(q, priceCeiling);

		const { entryPriceUsd, notionalUsd } = impliedUsdPriceFromQuote(params.direction, qty, q);
		if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
			throw new Error("Could not derive USD price from Jupiter quote");
		}

		// ── Guard 3: live-notional re-check after live quote ──────────────────
		// The paper preview may have used a different quote; re-validate here.
		if (params.maxNotionalUsd != null && Number.isFinite(params.maxNotionalUsd)) {
			if (notionalUsd > params.maxNotionalUsd) {
				throw new Error(
					`Live swap notional $${notionalUsd.toFixed(2)} exceeds max_trade_usd $${params.maxNotionalUsd.toFixed(2)} (re-checked after live quote) — swap blocked`,
				);
			}
		}

		const routeJson = JSON.stringify({
			inputMint: q.inputMint,
			outputMint: q.outputMint,
			inAmount: q.inAmount,
			outAmount: q.outAmount,
			priceImpactPct: q.priceImpactPct,
		});
		const paperBase: JupiterSwapPaperResult = {
			symbol: `solana:${tokenSym}`,
			side: params.direction === "long" ? "BUY" : "SELL",
			entryPriceUsd,
			qtyToken: qty,
			notionalUsd,
			slippageBps,
			routeJson,
		};

		// ── Key decode (after all guards) ─────────────────────────────────────
		if (!this.secretKeyBase58?.trim()) {
			throw new Error("Live Solana DEX requires SOLANA_DEX_SECRET_KEY (base58) in environment");
		}
		const keypair = Keypair.fromSecretKey(bs58.decode(this.secretKeyBase58.trim()));
		const connection = new Connection(this.rpcUrl, "confirmed");

		const swapRes = await this.fetchFn(JUPITER_SWAP, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				quoteResponse: q.raw,
				userPublicKey: keypair.publicKey.toBase58(),
				wrapAndUnwrapSol: true,
				dynamicComputeUnitLimit: true,
			}),
			signal: AbortSignal.timeout(45_000),
		});
		if (!swapRes.ok) {
			const t = await swapRes.text().catch(() => "");
			throw new Error(`Jupiter swap build failed HTTP ${swapRes.status}: ${t.slice(0, 200)}`);
		}
		const swapJson = (await swapRes.json()) as { swapTransaction?: string };
		if (!swapJson.swapTransaction) throw new Error("Jupiter swap response missing swapTransaction");

		const tx = VersionedTransaction.deserialize(Buffer.from(swapJson.swapTransaction, "base64"));
		tx.sign([keypair]);
		const sig = await connection.sendTransaction(tx, {
			skipPreflight: false,
			maxRetries: 2,
		});

		return {
			...paperBase,
			txSignature: sig,
		};
	}

	/** Record paper or live open in store (trade_log + positions). */
	recordOpen(params: {
		result: JupiterSwapPaperResult | JupiterSwapLiveResult;
		direction: "long" | "short";
		stopLoss: number;
		takeProfit: number;
		trailingStopPct?: number;
		isPaper: boolean;
		feeRate?: number;
	}): { tradeId: string; positionId: string } {
		const { result, direction, stopLoss, takeProfit, trailingStopPct, isPaper, feeRate } = params;
		const txSig = "txSignature" in result ? result.txSignature : `paper:jup:${randomUUID()}`;

		const trade = this.store.logTrade({
			symbol: result.symbol,
			side: result.side,
			type: "MARKET",
			qty: result.qtyToken,
			price: result.entryPriceUsd,
			orderId: txSig,
			isPaper,
			executionVenue: DEX_EXECUTION_VENUE_SOLANA,
			chain: "solana",
			txSignature: "txSignature" in result ? result.txSignature : undefined,
			slippageBps: result.slippageBps,
			routeJson: result.routeJson,
		});

		const position = this.store.openPosition({
			symbol: result.symbol,
			side: direction,
			entryPrice: result.entryPriceUsd,
			qty: result.qtyToken,
			stopLoss,
			takeProfit,
			trailingStopPct,
			isPaper,
			feeRate,
			executionVenue: DEX_EXECUTION_VENUE_SOLANA,
			chain: "solana",
			txSignature: "txSignature" in result ? result.txSignature : undefined,
			slippageBps: result.slippageBps,
			routeJson: result.routeJson,
		});

		return { tradeId: trade.id, positionId: position.id };
	}
}
