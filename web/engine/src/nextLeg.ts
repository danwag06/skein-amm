import { planSplit } from "./allocation.js";
import { computeSwap, underMinimum } from "./pricing.js";
import { pickBestSingleLeg, withoutMinimums } from "./planner.js";
import type { Direction, FixedCost, Leg, PoolState } from "./types.js";

export interface NextLegRequest {
  pools: PoolState[];
  direction: Direction;
  /** The order's amountIn not yet filled. */
  remaining: bigint;
  fixedCost: FixedCost;
  /** The least total amountOut the remainder must still bring (the floor minus what has filled). */
  minOut: bigint;
}

export type NextLegResult =
  | { leg: Leg; projectedOut: bigint }
  | { stop: "filled" | "floor" | "min" | "no_pool" };

/** True when `amountIn` as a leg is under every pool's minimum leg size. */
export function underEveryMinimum(pools: PoolState[], direction: Direction, amountIn: bigint): boolean {
  return pools.every((p) => {
    const out = direction === "bsvToToken" ? 0n : computeSwap(p, direction, amountIn)?.amountOut ?? 0n;
    return underMinimum(p, direction, amountIn, out);
  });
}

/**
 * The next leg of an order executed one leg at a time: plans `remaining`
 * against `pools` (planSplit, minimums applied) and returns that plan's leg
 * with the largest amountIn (tie: the smaller outpoint), with `projectedOut`
 * = the plan's total amountOut. When what would remain after that leg is
 * nonzero and under every pool's minimum, the leg takes all of `remaining`
 * (the best single pool that accepts it, as plan() with allowPartial false
 * picks) when one pool can.
 *
 * Stops: `filled` when nothing remains; `no_pool` when no pool takes any of
 * it; `min` when only the pools' minimums leave no leg; `floor` when the
 * plan's total out is under `minOut`. Pure, deterministic.
 */
export function nextLeg(request: NextLegRequest): NextLegResult {
  const { pools, direction, remaining, fixedCost, minOut } = request;
  if (remaining <= 0n) return { stop: "filled" };

  const legs = planSplit(pools, direction, remaining, fixedCost);
  if (legs.length === 0) {
    const unconstrained = planSplit(withoutMinimums(pools), direction, remaining, fixedCost);
    return { stop: unconstrained.length > 0 ? "min" : "no_pool" };
  }

  const projectedOut = legs.reduce((a, l) => a + l.amountOut, 0n);
  if (projectedOut < minOut) return { stop: "floor" };

  let leg = legs[0]!;
  for (const l of legs) {
    if (l.amountIn > leg.amountIn || (l.amountIn === leg.amountIn && l.outpoint < leg.outpoint)) leg = l;
  }

  const rest = remaining - leg.amountIn;
  if (rest > 0n && underEveryMinimum(pools, direction, rest)) {
    const whole = pickBestSingleLeg(pools, direction, remaining, 0n);
    if (whole !== null) leg = whole;
  }

  return { leg, projectedOut };
}
