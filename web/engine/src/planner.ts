import { acceptedSwap, smallestAccepted } from "./pricing.js";
import { planSplit } from "./allocation.js";
import type { Direction, FixedCost, Leg, Plan, PlanRequest, PoolState, SlippageBound } from "./types.js";

/** Applies the liveness filter (pure: caller supplies `now`, engine never reads the clock). */
export function filterLivePools(
  inventory: PoolState[],
  livenessThreshold: number | undefined,
  now: number | undefined,
): PoolState[] {
  if (livenessThreshold === undefined || now === undefined) return inventory;
  return inventory.filter((p) => p.lastSeen !== undefined && now - p.lastSeen <= livenessThreshold);
}

/**
 * Resolves a SlippageBound to a single absolute minAmountOut. When both
 * minAmountOut and toleranceBps are given, the stricter (larger) bound wins.
 * toleranceBps is measured against `totalAmountOut`, the plan's own total
 * (the split with the fixed per-leg cost).
 */
export function resolveMinAmountOut(totalAmountOut: bigint, slippage: SlippageBound): bigint {
  let bound = 0n;
  if (slippage.minAmountOut !== undefined && slippage.minAmountOut > bound) {
    bound = slippage.minAmountOut;
  }
  if (slippage.toleranceBps !== undefined) {
    const tolerant = (totalAmountOut * (10000n - slippage.toleranceBps)) / 10000n;
    if (tolerant > bound) bound = tolerant;
  }
  return bound;
}

/** The pools with their minimum leg sizes removed. */
export function withoutMinimums(pools: PoolState[]): PoolState[] {
  return pools.map((p) => ({ ...p, minLegSats: undefined }));
}

export function pickBestSingleLeg(
  pools: PoolState[],
  direction: Direction,
  amountIn: bigint,
  minAmountOut: bigint,
): Leg | null {
  let best: Leg | null = null;
  for (const pool of pools) {
    const result = acceptedSwap(pool, direction, amountIn);
    if (result === null) continue;
    if (minAmountOut > 0n && result.amountOut < minAmountOut) continue;
    const leg: Leg = {
      outpoint: pool.outpoint,
      amountIn,
      liquidityFee: result.liquidityFee,
      validationFee: result.validationFee,
      commission: result.commission,
      amountOut: result.amountOut,
      newBsvReserve: result.newBsvReserve,
      newTokenReserve: result.newTokenReserve,
    };
    if (
      best === null ||
      leg.amountOut > best.amountOut ||
      (leg.amountOut === best.amountOut && leg.outpoint < best.outpoint)
    ) {
      best = leg;
    }
  }
  return best;
}

/** Core planning step shared by plan() and replan(): plan `amountIn` against `pools` given an absolute minAmountOut. */
export function planOrder(
  pools: PoolState[],
  direction: Direction,
  amountIn: bigint,
  maxSources: number,
  fixedCost: FixedCost,
  minAmountOut: bigint,
): Leg[] {
  if (amountIn <= 0n || pools.length === 0) return [];

  // 0.40.2: one source — the best single pool for the whole amount.
  if (maxSources === 1) {
    const best = pickBestSingleLeg(pools, direction, amountIn, minAmountOut);
    return best ? [best] : [];
  }

  return planSplit(pools, direction, amountIn, fixedCost, maxSources);
}

/** The smallest amountIn one of `pools` accepts (contract-valid and at its minimum), or undefined. */
export function minAmountInOf(pools: PoolState[], direction: Direction): bigint | undefined {
  let min: bigint | undefined;
  for (const pool of pools) {
    const a = smallestAccepted(pool, direction);
    if (a !== null && (min === undefined || a < min)) min = a;
  }
  return min;
}

/** Plans a fresh order against the given inventory. Pure, deterministic. */
export function plan(request: PlanRequest): Plan {
  const eligible = filterLivePools(request.inventory, request.livenessThreshold, request.now);
  const explicitMin = request.slippage.minAmountOut ?? 0n;

  const legs = planOrder(
    eligible,
    request.direction,
    request.amountIn,
    request.maxSources,
    request.fixedCost,
    explicitMin,
  );

  const totalAmountIn = legs.reduce((a, l) => a + l.amountIn, 0n);
  const totalAmountOut = legs.reduce((a, l) => a + l.amountOut, 0n);
  const resolvedMinAmountOut = resolveMinAmountOut(totalAmountOut, request.slippage);
  const usedOutpoints = new Set(legs.map((l) => l.outpoint));
  const remainingInventory = eligible.filter((p) => !usedOutpoints.has(p.outpoint));

  const result: Plan = {
    legs,
    totalAmountIn,
    totalAmountOut,
    meetsSlippageBound: totalAmountOut >= resolvedMinAmountOut,
    filledCompletely: totalAmountIn === request.amountIn,
    direction: request.direction,
    maxSources: request.maxSources,
    fixedCost: request.fixedCost,
    livenessThreshold: request.livenessThreshold,
    now: request.now,
    originalAmountIn: request.amountIn,
    resolvedMinAmountOut,
    cumulativeFilledAmountIn: 0n,
    cumulativeFilledAmountOut: 0n,
    remainingInventory,
  };

  // No legs because of the minimums: the same order without them has legs.
  if (
    legs.length === 0 &&
    planOrder(
      withoutMinimums(eligible),
      request.direction,
      request.amountIn,
      request.maxSources,
      request.fixedCost,
      explicitMin,
    ).length > 0
  ) {
    result.unfillable = "min";
    const minAmountIn = minAmountInOf(eligible, request.direction);
    if (minAmountIn !== undefined) result.minAmountIn = minAmountIn;
  }

  return result;
}
