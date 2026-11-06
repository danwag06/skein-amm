import { describe, expect, it } from "vitest";
import { plan, resolveMinAmountOut } from "../src/planner.js";
import { planSplit, quoteMid } from "../src/allocation.js";
import { computeSwap } from "../src/pricing.js";
import { nextLeg, underEveryMinimum } from "../src/nextLeg.js";
import { priceOf, PRICE_SHARE_BPS } from "../src/price.js";
import type { FixedCost, PlanRequest } from "../src/types.js";
import { makePool } from "./helpers.js";

const noCost: FixedCost = { minerFeeSats: 0n };

function req(overrides: Partial<PlanRequest>): PlanRequest {
  return {
    tokenId: "token-1",
    direction: "bsvToToken",
    amountIn: 100_000n,
    slippage: {},
    allowPartial: true,
    fixedCost: noCost,
    inventory: [],
    ...overrides,
  };
}

describe("item 1: the bound is measured from the plan's own total", () => {
  it("toleranceBps resolves against totalAmountOut of the fixed-cost split, not quoteMid", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const b = makePool({ outpoint: "b:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    // A heavy per-leg cost keeps the plan to one leg; quoteMid (no cost) splits in two.
    const p = plan(req({ amountIn: 1_000_000n, inventory: [a, b], fixedCost: { minerFeeSats: 10_000_000n }, slippage: { toleranceBps: 100n } }));
    expect(p.legs).toHaveLength(1);
    const mid = quoteMid([a, b], "bsvToToken", 1_000_000n);
    expect(mid).toBeGreaterThan(p.totalAmountOut);
    expect(p.resolvedMinAmountOut).toBe((p.totalAmountOut * 9_900n) / 10_000n);
    expect(p.meetsSlippageBound).toBe(true);
  });

  it("a stricter minAmountOut still wins", () => {
    expect(resolveMinAmountOut(1_000n, { toleranceBps: 100n, minAmountOut: 995n })).toBe(995n);
    expect(resolveMinAmountOut(1_000n, { toleranceBps: 100n, minAmountOut: 900n })).toBe(990n);
    expect(resolveMinAmountOut(1_000n, {})).toBe(0n);
  });
});

describe("item 2: minimum leg size", () => {
  it("bsvToToken: no leg's amountIn under its pool's minimum; the share folds into the other leg", () => {
    const big = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const small = makePool({ outpoint: "b:0", bsvReserve: 500_000n, tokenReserve: 500_000n, minLegSats: 1_000_000n });
    const free = planSplit([big, { ...small, minLegSats: undefined }], "bsvToToken", 1_000_000n, noCost);
    expect(free).toHaveLength(2);
    const legs = planSplit([big, small], "bsvToToken", 1_000_000n, noCost);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.outpoint).toBe("a:0");
    expect(legs[0]!.amountIn).toBe(1_000_000n);
    expect(legs[0]!.amountOut).toBe(computeSwap(big, "bsvToToken", 1_000_000n)!.amountOut);
  });

  it("tokenToBsv: the minimum is on amountOut", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const b = makePool({ outpoint: "b:0", bsvReserve: 5_000_000n, tokenReserve: 5_000_000n });
    const free = planSplit([a, b], "tokenToBsv", 1_000_000n, noCost);
    expect(free).toHaveLength(2);
    const bOut = free.find((l) => l.outpoint === "b:0")!.amountOut;
    // A minimum on b just above its share's payout (but under its share's amountIn would not matter).
    const legs = planSplit([a, { ...b, minLegSats: bOut + 1n }], "tokenToBsv", 1_000_000n, noCost);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.outpoint).toBe("a:0");
    expect(legs[0]!.amountIn).toBe(1_000_000n);
  });

  it("an order no pool can take: no legs, unfillable min, minAmountIn = the smallest one pool accepts", () => {
    const a = makePool({ outpoint: "a:0", minLegSats: 50_000n });
    const b = makePool({ outpoint: "b:0", minLegSats: 20_000n });
    const p = plan(req({ amountIn: 10_000n, inventory: [a, b] }));
    expect(p.legs).toHaveLength(0);
    expect(p.unfillable).toBe("min");
    expect(p.minAmountIn).toBe(20_000n);
  });

  it("tokenToBsv minAmountIn: the smallest token amountIn whose payout reaches the minimum", () => {
    const a = makePool({ outpoint: "a:0", minLegSats: 10_000n });
    const p = plan(req({ direction: "tokenToBsv", amountIn: 1_000n, inventory: [a] }));
    expect(p.unfillable).toBe("min");
    const m = p.minAmountIn!;
    expect(computeSwap(a, "tokenToBsv", m)!.amountOut).toBeGreaterThanOrEqual(10_000n);
    expect(computeSwap(a, "tokenToBsv", m - 1n)!.amountOut).toBeLessThan(10_000n);
  });

  it("no unfillable mark when the minimums are not the cause", () => {
    expect(plan(req({ inventory: [] })).unfillable).toBeUndefined();
    const p = plan(req({ inventory: [makePool({ outpoint: "a:0", minLegSats: 1_000n })] }));
    expect(p.legs).toHaveLength(1);
    expect(p.unfillable).toBeUndefined();
  });

  it("allowPartial false skips a pool whose minimum the order is under", () => {
    const a = makePool({ outpoint: "a:0", liquidityFeeBps: 1n, minLegSats: 1_000_000n });
    const b = makePool({ outpoint: "b:0" });
    const p = plan(req({ amountIn: 100_000n, allowPartial: false, inventory: [a, b] }));
    expect(p.legs.map((l) => l.outpoint)).toEqual(["b:0"]);
  });
});

describe("item 3: nextLeg", () => {
  const base = { direction: "bsvToToken" as const, fixedCost: noCost, minOut: 0n };

  it("filled when nothing remains; no_pool with no pool", () => {
    expect(nextLeg({ ...base, pools: [makePool({ outpoint: "a:0" })], remaining: 0n })).toEqual({ stop: "filled" });
    expect(nextLeg({ ...base, pools: [], remaining: 1_000n })).toEqual({ stop: "no_pool" });
  });

  it("min when only the minimums leave no leg", () => {
    expect(nextLeg({ ...base, pools: [makePool({ outpoint: "a:0", minLegSats: 50_000n })], remaining: 1_000n })).toEqual({ stop: "min" });
  });

  it("floor when the plan's total out is under minOut", () => {
    const pool = makePool({ outpoint: "a:0" });
    const out = computeSwap(pool, "bsvToToken", 10_000n)!.amountOut;
    expect(nextLeg({ ...base, pools: [pool], remaining: 10_000n, minOut: out + 1n })).toEqual({ stop: "floor" });
    const r = nextLeg({ ...base, pools: [pool], remaining: 10_000n, minOut: out });
    expect(r).toMatchObject({ projectedOut: out });
  });

  it("the leg is the plan's largest by amountIn; projectedOut = the plan's total", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 2_000_000n, tokenReserve: 2_000_000n });
    const b = makePool({ outpoint: "b:0", bsvReserve: 6_000_000n, tokenReserve: 6_000_000n });
    const legs = planSplit([a, b], "bsvToToken", 1_000_000n, noCost);
    expect(legs).toHaveLength(2);
    const r = nextLeg({ ...base, pools: [a, b], remaining: 1_000_000n });
    if (!("leg" in r)) throw new Error("expected a leg");
    expect(r.leg.outpoint).toBe("b:0");
    expect(r.leg).toEqual(legs.find((l) => l.outpoint === "b:0"));
    expect(r.projectedOut).toBe(legs.reduce((s, l) => s + l.amountOut, 0n));
  });

  it("ties broken by outpoint", () => {
    const a = makePool({ outpoint: "z:0" });
    const b = makePool({ outpoint: "a:0" });
    const r = nextLeg({ ...base, pools: [a, b], remaining: 2_000_000n });
    if (!("leg" in r)) throw new Error("expected a leg");
    expect(r.leg.amountIn).toBe(1_000_000n);
    expect(r.leg.outpoint).toBe("a:0");
  });

  it("underEveryMinimum: the take-all test on what would remain", () => {
    const a = makePool({ outpoint: "a:0", minLegSats: 300_000n });
    const b = makePool({ outpoint: "b:0", minLegSats: 200_000n });
    expect(underEveryMinimum([a, b], "bsvToToken", 199_999n)).toBe(true);
    expect(underEveryMinimum([a, b], "bsvToToken", 200_000n)).toBe(false);
    // a pool with no minimum takes any remainder
    expect(underEveryMinimum([a, makePool({ outpoint: "c:0" })], "bsvToToken", 1n)).toBe(false);
    // tokenToBsv: measured on the payout each pool would give
    const out = computeSwap(a, "tokenToBsv", 250_000n)!.amountOut;
    expect(underEveryMinimum([{ ...a, minLegSats: out + 1n }], "tokenToBsv", 250_000n)).toBe(true);
    expect(underEveryMinimum([{ ...a, minLegSats: out }], "tokenToBsv", 250_000n)).toBe(false);
  });

  it("with minimums met by every planned leg, the largest leg stands (the rest is not under every minimum)", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 2_000_000n, tokenReserve: 2_000_000n, minLegSats: 200_000n });
    const b = makePool({ outpoint: "b:0", bsvReserve: 6_000_000n, tokenReserve: 6_000_000n, minLegSats: 200_000n });
    const legs = planSplit([a, b], "bsvToToken", 1_000_000n, noCost);
    expect(legs).toHaveLength(2);
    const r = nextLeg({ ...base, pools: [a, b], remaining: 1_000_000n });
    if (!("leg" in r)) throw new Error("expected a leg");
    expect(r.leg).toEqual(legs.find((l) => l.outpoint === "b:0"));
  });

  it("a share under its pool's minimum folds, so the one leg takes all of remaining", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 2_000_000n, tokenReserve: 2_000_000n, minLegSats: 300_000n });
    const b = makePool({ outpoint: "b:0", bsvReserve: 6_000_000n, tokenReserve: 6_000_000n, minLegSats: 300_000n });
    const r = nextLeg({ ...base, pools: [a, b], remaining: 1_000_000n });
    if (!("leg" in r)) throw new Error("expected a leg");
    expect(r.leg.outpoint).toBe("b:0");
    expect(r.leg.amountIn).toBe(1_000_000n);
    expect(r.projectedOut).toBe(r.leg.amountOut);
  });

  it("is deterministic over pool order", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 2_000_000n });
    const b = makePool({ outpoint: "b:0", tokenReserve: 3_000_000n });
    const c = makePool({ outpoint: "c:0" });
    const r1 = nextLeg({ ...base, pools: [a, b, c], remaining: 700_000n });
    const r2 = nextLeg({ ...base, pools: [c, b, a], remaining: 700_000n });
    expect(r1).toEqual(r2);
  });
});

describe("item 4: priceOf", () => {
  it("PRICE_SHARE_BPS is 100", () => {
    expect(PRICE_SHARE_BPS).toBe(100n);
  });

  it("null with no pool", () => {
    expect(priceOf([])).toBeNull();
  });

  it("buy and sell are planSplit of 1% of the pooled sats / tokens, mid their exact midpoint", () => {
    const a = makePool({ outpoint: "a:0", bsvReserve: 4_000_000n, tokenReserve: 8_000_000n });
    const b = makePool({ outpoint: "b:0", bsvReserve: 6_000_000n, tokenReserve: 12_000_000n });
    const p = priceOf([a, b])!;
    const buyLegs = planSplit([a, b], "bsvToToken", 100_000n, noCost);
    const sellLegs = planSplit([a, b], "tokenToBsv", 200_000n, noCost);
    expect(p.buy).toEqual({ sats: 100_000n, tokens: buyLegs.reduce((s, l) => s + l.amountOut, 0n) });
    expect(p.sell).toEqual({ sats: sellLegs.reduce((s, l) => s + l.amountOut, 0n), tokens: 200_000n });
    expect(p.mid).toEqual({
      sats: p.buy.sats * p.sell.tokens + p.sell.sats * p.buy.tokens,
      tokens: 2n * p.buy.tokens * p.sell.tokens,
    });
    // a buy pays more sats per token than a sell receives
    expect(p.buy.sats * p.sell.tokens).toBeGreaterThan(p.sell.sats * p.buy.tokens);
    const mid = Number(p.mid.sats) / Number(p.mid.tokens);
    expect(mid).toBeGreaterThan(Number(p.sell.sats) / Number(p.sell.tokens));
    expect(mid).toBeLessThan(Number(p.buy.sats) / Number(p.buy.tokens));
  });

  it("minimums are not applied", () => {
    const a = makePool({ outpoint: "a:0", minLegSats: 10_000_000_000n });
    const p = priceOf([a]);
    expect(p).not.toBeNull();
    expect(p).toEqual(priceOf([{ ...a, minLegSats: undefined }]));
  });

  it("another share; the reference size is at least 1", () => {
    const a = makePool({ outpoint: "a:0" });
    expect(priceOf([a], 500n)!.buy.sats).toBe(500_000n);
    const tiny = makePool({ outpoint: "t:0", bsvReserve: 50n, tokenReserve: 50n, liquidityFeeBps: 0n, validationFeeBps: 0n });
    // 1% of 50 rounds to 0 -> 1; one sat in buys 0 tokens -> no leg -> null
    expect(priceOf([tiny])).toBeNull();
  });
});
