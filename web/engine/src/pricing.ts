/**
 * Contract-exact swap arithmetic, mirroring pool/Pool.runar.go's Swap method
 * bit for bit (BigInt, same truncation/ceiling behaviour as the Go integer
 * division the contract uses).
 *
 *   lpFee         = ceil(amountIn * LpFeeBps / 10000)
 *   validatorFee  = ceil(amountIn * ValidatorFeeBps / 10000)
 *   commission    = ceil(amountIn * CommissionBps / 10000)
 *   net           = amountIn - lpFee - validatorFee - commission   (must be > 0)
 *
 *   tokenToBsv (token in, bsv out):
 *     out          = floor(net * bsvReserve / (tokenReserve + net))
 *     newBsv       = bsvReserve - out
 *     newTokens    = tokenReserve + net
 *
 *   bsvToToken (bsv in, token out):
 *     out          = floor(net * tokenReserve / (bsvReserve + net))
 *     newBsv       = bsvReserve + net
 *     newTokens    = tokenReserve - out
 *
 *   out must be > 0.
 */
import type { Direction, PoolState } from "./types.js";

export interface SwapResult {
  liquidityFee: bigint;
  validationFee: bigint;
  commission: bigint;
  net: bigint;
  amountOut: bigint;
  newBsvReserve: bigint;
  newTokenReserve: bigint;
}

/** ceil(amountIn * bps / 10000), exactly as the contract computes each fee. */
export function feeAmount(amountIn: bigint, bps: bigint): bigint {
  return (amountIn * bps + 9999n) / 10000n;
}

/**
 * Computes one pool's swap exactly as the contract would, or returns null if
 * the contract's assertions (`net > 0`, `out > 0`) would fail — i.e. this
 * amountIn is not a valid swap against this pool.
 */
export function computeSwap(
  pool: Pick<PoolState, "bsvReserve" | "tokenReserve" | "liquidityFeeBps" | "validationFeeBps" | "commissionBps">,
  direction: Direction,
  amountIn: bigint,
): SwapResult | null {
  if (amountIn <= 0n) return null;

  const liquidityFee = feeAmount(amountIn, pool.liquidityFeeBps);
  const validationFee = feeAmount(amountIn, pool.validationFeeBps);
  const commission = feeAmount(amountIn, pool.commissionBps);
  const net = amountIn - liquidityFee - validationFee - commission;
  if (net <= 0n) return null;

  let amountOut: bigint;
  let newBsvReserve: bigint;
  let newTokenReserve: bigint;

  if (direction === "tokenToBsv") {
    amountOut = (net * pool.bsvReserve) / (pool.tokenReserve + net);
    newBsvReserve = pool.bsvReserve - amountOut;
    newTokenReserve = pool.tokenReserve + net;
  } else {
    amountOut = (net * pool.tokenReserve) / (pool.bsvReserve + net);
    newBsvReserve = pool.bsvReserve + net;
    newTokenReserve = pool.tokenReserve - amountOut;
  }

  if (amountOut <= 0n) return null;

  return { liquidityFee, validationFee, commission, net, amountOut, newBsvReserve, newTokenReserve };
}

/** A leg's sats side: amountIn when sats go in (bsvToToken), amountOut when sats come out. */
export function legSats(direction: Direction, amountIn: bigint, amountOut: bigint): bigint {
  return direction === "bsvToToken" ? amountIn : amountOut;
}

/** True when a leg's sats side is under its pool's minimum leg size (absent or 0 = none). */
export function underMinimum(pool: Pick<PoolState, "minLegSats">, direction: Direction, amountIn: bigint, amountOut: bigint): boolean {
  return legSats(direction, amountIn, amountOut) < (pool.minLegSats ?? 0n);
}

/** computeSwap, or null when the contract would refuse it or the leg is under the pool's minimum. */
export function acceptedSwap(pool: PoolState, direction: Direction, amountIn: bigint): SwapResult | null {
  const result = computeSwap(pool, direction, amountIn);
  if (result === null || underMinimum(pool, direction, amountIn, result.amountOut)) return null;
  return result;
}

/**
 * The smallest amountIn this pool accepts (contract-valid and at its minimum),
 * by doubling then bisection over amountIn; null when none up to 2^128.
 */
export function smallestAccepted(pool: PoolState, direction: Direction): bigint | null {
  const cap = 1n << 128n;
  let hi = 1n;
  while (acceptedSwap(pool, direction, hi) === null) {
    if (hi >= cap) return null;
    hi *= 2n;
  }
  let lo = hi / 2n; // not accepted (or 0)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (acceptedSwap(pool, direction, mid) === null) lo = mid;
    else hi = mid;
  }
  return hi;
}
