/**
 * Prices (0.34.0, D6, David Case 2026-11-04: one source for prices): a token's price comes from
 * its pool list — the pools route the host answers (`GET <origin>/amm/pools`, held as an event
 * stream on every page) — Σsats / Σtokens over the pools listed there (the host lists only pools
 * whose validator is beating). No price is derived from beats (the 0.9.0 beat prices are gone);
 * the depth is the sats a buy needs to move the price up by 2%, x·(√1.02 − 1), over the summed
 * sats.
 */

/** The sats a buy needs to move the marginal price up by `bps`, over `sats` summed reserves; null with none. */
export function depthOf(sats: bigint, bps = 200): { bps: number; sats: bigint } | null {
  if (sats === 0n) return null;
  return { bps, sats: BigInt(Math.round(Number(sats) * (Math.sqrt(1 + bps / 10_000) - 1))) };
}
