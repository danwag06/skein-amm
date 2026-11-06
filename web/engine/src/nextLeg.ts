import { planSplit } from "./allocation.js";
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
  /**
   * 0.40.2: the number of legs the order may STILL fill, a positive integer. The plan of
   * `remaining` uses at most that many pools; 1: the leg takes all of `remaining`.
   */
  maxSources: number;
}

export type NextLegResult =
  | { leg: Leg; projectedOut: bigint }
  | { stop: "filled" | "floor" | "min" | "no_pool" };

/**
 * The next leg of an order executed one leg at a time: plans `remaining`
 * against `pools` (planSplit, minimums applied, at most `maxSources` pools)
 * and returns that plan's leg with the largest amountIn (tie: the smaller
 * outpoint), with `projectedOut` = the plan's total amountOut. With
 * `maxSources` 1 the leg takes ALL of `remaining` in the best single pool
 * (the pick of plan()'s single source), its minimum applied.
 *
 * Stops: `filled` when nothing remains; `no_pool` when no pool takes any of
 * it; `min` when only the pools' minimums leave no leg; `floor` when the
 * plan's total out is under `minOut`. Pure, deterministic.
 */
export function nextLeg(request: NextLegRequest): NextLegResult {
  const { pools, direction, remaining, fixedCost, minOut, maxSources } = request;
  if (remaining <= 0n) return { stop: "filled" };

  if (maxSources === 1) {
    const leg = pickBestSingleLeg(pools, direction, remaining, 0n);
    if (leg === null) return { stop: pickBestSingleLeg(withoutMinimums(pools), direction, remaining, 0n) !== null ? "min" : "no_pool" };
    if (leg.amountOut < minOut) return { stop: "floor" };
    return { leg, projectedOut: leg.amountOut };
  }

  const legs = planSplit(pools, direction, remaining, fixedCost, maxSources);
  if (legs.length === 0) {
    const unconstrained = planSplit(withoutMinimums(pools), direction, remaining, fixedCost, maxSources);
    return { stop: unconstrained.length > 0 ? "min" : "no_pool" };
  }

  const projectedOut = legs.reduce((a, l) => a + l.amountOut, 0n);
  if (projectedOut < minOut) return { stop: "floor" };

  let leg = legs[0]!;
  for (const l of legs) {
    if (l.amountIn > leg.amountIn || (l.amountIn === leg.amountIn && l.outpoint < leg.outpoint)) leg = l;
  }
  return { leg, projectedOut };
}
