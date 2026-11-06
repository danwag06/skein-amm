/** 0.40.2: `maxSources` caps how many pools an order draws on — in plan() and across nextLeg's fills. */
import { describe, expect, it } from "vitest";
import { plan, pickBestSingleLeg } from "../src/planner.js";
import { nextLeg } from "../src/nextLeg.js";
import { computeSwap } from "../src/pricing.js";
import type { FixedCost, Leg, PlanRequest, PoolState } from "../src/types.js";
import { makePool } from "./helpers.js";

const noCost: FixedCost = { minerFeeSats: 0n };
const three = () => [
  makePool({ outpoint: "a:0", bsvReserve: 1_000_000n, tokenReserve: 5_000_000n }),
  makePool({ outpoint: "b:0", bsvReserve: 1_200_000n, tokenReserve: 6_000_000n }),
  makePool({ outpoint: "c:0", bsvReserve: 900_000n, tokenReserve: 4_500_000n }),
];
const req = (o: Partial<PlanRequest>): PlanRequest => ({ tokenId: "t", direction: "bsvToToken", amountIn: 600_000n, slippage: {}, fixedCost: noCost, inventory: three(), ...o });

describe("plan: the cap", () => {
  it("none: every useful pool (3 here); 2: at most two; 1: the best single pool for the whole amount (allowPartial false's pick)", () => {
    expect(plan(req({})).legs).toHaveLength(3);
    const two = plan(req({ maxSources: 2 }));
    expect(two.legs).toHaveLength(2);
    expect(two.totalAmountIn).toBe(600_000n);
    expect(two.maxSources).toBe(2);
    const one = plan(req({ maxSources: 1 }));
    expect(one.legs).toEqual([pickBestSingleLeg(three(), "bsvToToken", 600_000n, 0n)]);
    expect(one.legs[0]!.amountIn).toBe(600_000n);
    expect(plan(req({})).totalAmountOut).toBeGreaterThan(two.totalAmountOut);
    expect(two.totalAmountOut).toBeGreaterThan(one.totalAmountOut);
  });

  it("the minimums still set pools aside within the cap: with 2, a pool whose share is under its minimum gives way to the next", () => {
    const [a, b, c] = three();
    const p = plan(req({ maxSources: 2, amountIn: 200_000n, inventory: [a!, { ...b!, minLegSats: 150_000n }, c!] }));
    expect(p.legs.length).toBeLessThanOrEqual(2);
    expect(p.legs.map((l) => l.outpoint)).not.toContain("b:0");
    expect(p.totalAmountIn).toBe(200_000n);
  });
});

describe("nextLeg: maxSources is the legs the order may STILL fill", () => {
  /** Fill legs one at a time, each pool moved by its leg, the budget down by one per fill. */
  function run(maxSources: number | undefined, amount = 600_000n) {
    let pools: PoolState[] = three();
    let remaining = amount;
    let budget = maxSources;
    const legs: Leg[] = [];
    for (let i = 0; i < 10; i++) {
      const r = nextLeg({ pools, direction: "bsvToToken", remaining, fixedCost: noCost, minOut: 0n, ...(budget !== undefined ? { maxSources: budget } : {}) });
      if ("stop" in r) return { legs, stop: r.stop };
      legs.push(r.leg);
      remaining -= r.leg.amountIn;
      pools = pools.map((p) => (p.outpoint === r.leg.outpoint ? { ...p, outpoint: `${p.outpoint}+`, bsvReserve: r.leg.newBsvReserve, tokenReserve: r.leg.newTokenReserve } : p));
      if (budget !== undefined) budget -= 1;
    }
    return { legs, stop: "loop" };
  }

  it("1: one leg taking all; 2: two legs, the second taking all that remains; none: as many as the split gives", () => {
    const one = run(1);
    expect(one).toMatchObject({ stop: "filled" });
    expect(one.legs.map((l) => l.amountIn)).toEqual([600_000n]);
    const two = run(2);
    expect(two.stop).toBe("filled");
    expect(two.legs).toHaveLength(2);
    expect(two.legs[0]!.amountIn + two.legs[1]!.amountIn).toBe(600_000n);
    const none = run(undefined);
    expect(none.stop).toBe("filled");
    expect(none.legs.length).toBeGreaterThanOrEqual(3);
  });

  it("1: the best single pool that meets minOut and its minimum, else floor / min / no_pool", () => {
    const pools = three();
    const best = pickBestSingleLeg(pools, "bsvToToken", 600_000n, 0n)!;
    const base = { pools, direction: "bsvToToken" as const, remaining: 600_000n, fixedCost: noCost, maxSources: 1 };
    expect(nextLeg({ ...base, minOut: best.amountOut })).toEqual({ leg: best, projectedOut: best.amountOut });
    expect(nextLeg({ ...base, minOut: best.amountOut + 1n })).toEqual({ stop: "floor" });
    const minned = pools.map((p) => ({ ...p, minLegSats: 700_000n }));
    expect(nextLeg({ ...base, pools: minned, minOut: 0n })).toEqual({ stop: "min" });
    // A pool under its minimum is skipped for the next best.
    const oneMin = pools.map((p) => (p.outpoint === best.outpoint ? { ...p, minLegSats: 700_000n } : p));
    const r = nextLeg({ ...base, pools: oneMin, minOut: 0n });
    expect("leg" in r && r.leg.outpoint !== best.outpoint && r.leg.amountIn === 600_000n).toBe(true);
    expect(nextLeg({ ...base, pools: [], minOut: 0n })).toEqual({ stop: "no_pool" });
    expect(computeSwap(pools[0]!, "bsvToToken", 600_000n)).not.toBeNull();
  });
});
