/**
 * Prices (0.34.0, D6, David Case 2026-11-04: one source for prices; 0.39.0, D3, D7): a token's
 * listed price comes from the host-wide stats (`GET <origin>/amm/stats`, read once per load and
 * every 30 s while the tab is visible; no host-wide stream), the Swap page's quote from the pools
 * its token's pools route lists. No price is derived from beats (the 0.9.0 beat prices are gone);
 * the depth is the sats a buy needs to move the price up by 2%, x·(√1.02 − 1), over the summed
 * sats.
 */

/** The sats a buy needs to move the marginal price up by `bps`, over `sats` summed reserves; null with none. */
export function depthOf(sats: bigint, bps = 200): { bps: number; sats: bigint } | null {
  if (sats === 0n) return null;
  return { bps, sats: BigInt(Math.round(Number(sats) * (Math.sqrt(1 + bps / 10_000) - 1))) };
}
