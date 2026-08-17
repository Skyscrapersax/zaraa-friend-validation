// src/dex/stellar-client.ts
var HORIZON = "https://horizon.stellar.org";
var TIMEOUT_MS = 15e3;
var STELLAR_ASSETS = {
  XLM: { type: "native", name: "Stellar Lumens" },
  USDC: { type: "credit_alphanum4", code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", name: "USDC (Centre)" },
  AQUA: { type: "credit_alphanum4", code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", name: "Aquarius" },
  MOBI: { type: "credit_alphanum4", code: "MOBI", issuer: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH", name: "Mobius" },
  ETH: { type: "credit_alphanum4", code: "ETH", issuer: "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR", name: "Stellar ETH" }
};
var STELLAR_PAIRS = [
  { base: { type: "native" }, counter: STELLAR_ASSETS.USDC, label: "XLM/USDC" },
  { base: STELLAR_ASSETS.AQUA, counter: { type: "native" }, label: "AQUA/XLM" },
  { base: STELLAR_ASSETS.MOBI, counter: { type: "native" }, label: "MOBI/XLM" },
  { base: STELLAR_ASSETS.ETH, counter: { type: "native" }, label: "ETH/XLM" }
];
var StellarClient = class {
  horizon;
  constructor(horizon) {
    this.horizon = horizon ?? HORIZON;
  }
  /** Get order book for a trading pair */
  async getOrderBook(base, counter, limit = 20) {
    const params = new URLSearchParams();
    this.setAssetParams(params, "selling", base);
    this.setAssetParams(params, "buying", counter);
    params.set("limit", String(limit));
    const url = `${this.horizon}/order_book?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const bids = data.bids.map((b) => ({ price: Number(b.price), amount: Number(b.amount) }));
    const asks = data.asks.map((a) => ({ price: Number(a.price), amount: Number(a.amount) }));
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const spreadPct = spread != null && midPrice != null && midPrice > 0 ? spread / midPrice * 100 : null;
    return { base, counter, bids, asks, midPrice, spread, spreadPct, timestamp: Date.now() };
  }
  /** Get recent trades for a pair */
  async getTrades(base, counter, limit = 50) {
    const params = new URLSearchParams();
    this.setAssetParams(params, "base", base);
    this.setAssetParams(params, "counter", counter);
    params.set("limit", String(limit));
    params.set("order", "desc");
    const url = `${this.horizon}/trades?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data._embedded.records.map((r) => ({
      id: r.id,
      baseAmount: Number(r.base_amount),
      counterAmount: Number(r.counter_amount),
      price: r.price.n / r.price.d,
      timestamp: r.ledger_close_time,
      baseIsSeller: r.base_is_seller
    }));
  }
  /** Get account balances */
  async getAccountBalances(address) {
    const res = await fetch(`${this.horizon}/accounts/${address}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    let xlm = 0;
    const tokens = [];
    for (const b of data.balances) {
      if (b.asset_type === "native") {
        xlm = Number(b.balance);
      } else if (b.asset_code && b.asset_issuer) {
        tokens.push({
          code: b.asset_code,
          issuer: b.asset_issuer,
          balance: Number(b.balance)
        });
      }
    }
    return { xlm, tokens };
  }
  /** Get trade aggregations (candle-like data) */
  async getTradeAggregations(base, counter, resolution = 36e5, limit = 50) {
    const params = new URLSearchParams();
    this.setAssetParams(params, "base", base);
    this.setAssetParams(params, "counter", counter);
    params.set("resolution", String(resolution));
    params.set("limit", String(limit));
    params.set("order", "desc");
    const url = `${this.horizon}/trade_aggregations?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Horizon error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data._embedded.records.map((r) => ({
      timestamp: Number(r.timestamp),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.base_volume)
    }));
  }
  setAssetParams(params, prefix, asset) {
    let type = asset.type;
    if (type !== "native" && asset.code) {
      type = asset.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
    }
    params.set(`${prefix}_asset_type`, type);
    if (asset.code) params.set(`${prefix}_asset_code`, asset.code);
    if (asset.issuer) params.set(`${prefix}_asset_issuer`, asset.issuer);
  }
};

export {
  STELLAR_ASSETS,
  STELLAR_PAIRS,
  StellarClient
};
