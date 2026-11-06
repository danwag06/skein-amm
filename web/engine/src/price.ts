import { planSplit } from "./allocation.js";
import { withoutMinimums } from "./planner.js";
import type { PoolState } from "./types.js";

/** The reference size of the price quote: this share, in basis points, of the token's pooled reserves. */
export const PRICE_SHARE_BPS = 100n;

/** An exact price as a pair: `sats` per `tokens`. */
export interface PricePair {
  sats: bigint;
  tokens: bigint;
}

export interface Price {
  /** What a buy of the reference sats would pay now. */
  buy: PricePair;
  /** What a sell of the reference tokens would pay now. */
  sell: PricePair;
  /** The arithmetic midpoint of buy and sell, exact. */
  mid: PricePair;
}

/**
 * The price = what the next trade would pay, for a reference size of
 * `shareBps` of the pooled sats (a buy) and of the pooled tokens (a sell),
 * split across `pools` with no per-leg cost and no minimum leg sizes. Null
 * with no pool, or when a side has no leg. Pure, deterministic.
 */
export function priceOf(pools: PoolState[], shareBps: bigint = PRICE_SHARE_BPS): Price | null {
  if (pools.length === 0) return null;
  const free = withoutMinimums(pools);
  const bsv = free.reduce((a, p) => a + p.bsvReserve, 0n);
  const tok = free.reduce((a, p) => a + p.tokenReserve, 0n);
  const refSats = maxOne((bsv * shareBps) / 10000n);
  const refTokens = maxOne((tok * shareBps) / 10000n);

  const buyLegs = planSplit(free, "bsvToToken", refSats, { minerFeeSats: 0n });
  const sellLegs = planSplit(free, "tokenToBsv", refTokens, { minerFeeSats: 0n });
  if (buyLegs.length === 0 || sellLegs.length === 0) return null;

  const buy: PricePair = {
    sats: buyLegs.reduce((a, l) => a + l.amountIn, 0n),
    tokens: buyLegs.reduce((a, l) => a + l.amountOut, 0n),
  };
  const sell: PricePair = {
    sats: sellLegs.reduce((a, l) => a + l.amountOut, 0n),
    tokens: sellLegs.reduce((a, l) => a + l.amountIn, 0n),
  };
  const mid: PricePair = {
    sats: buy.sats * sell.tokens + sell.sats * buy.tokens,
    tokens: 2n * buy.tokens * sell.tokens,
  };
  return { buy, sell, mid };
}

function maxOne(x: bigint): bigint {
  return x < 1n ? 1n : x;
}
