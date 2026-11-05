/**
 * LP pools and fees (skein-amm 0.34.0, D9): `readPositions` reads `GET /@<token>/amm/positions?lp=k1,k2`
 * once for every key of a token, one record per key (status live / rescinded / closed, the pool
 * state, the LP fees); `feesByToken` sums the positions, live and closed, per token (the Liquidity
 * page's line).
 */
import { describe, expect, it } from "vitest";
import { readPositions } from "../src/lib/overlay";
import { feesByToken } from "../src/lp/positions";

const TOKEN = `${"ab".repeat(32)}_0`;
const LP1 = "03" + "11".repeat(32);
const LP2 = "02" + "22".repeat(32);
const LP3 = "02" + "33".repeat(32);
const BASE = "http://x.localhost/@" + TOKEN + "/amm";
const wire = (outpoint: string) => ({ lpPubKey: LP1, outpoint, bsvReserve: 10, tokenReserve: 20, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: LP1 });

function fakeRoute(result: unknown, status = 200): { fetchFn: (url: string) => Promise<Response>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchFn: async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
    },
  };
}

describe("LP pools (0.34.0: the positions route)", () => {
  it("readPositions: ONE GET /positions?lp=k1,k2,k3 for all the keys; a live record (outpoint, current), a rescinded one (the Rescind's output and its state), a closed or unknown one (no outpoint, no current)", async () => {
    const { fetchFn, asked } = fakeRoute([
      { lpPubKey: LP1, status: "live", outpoint: `${"ef".repeat(32)}_0`, current: wire(`${"ef".repeat(32)}_0`), sats: 60, tokens: 150, swaps: 2 },
      { lpPubKey: LP2, status: "rescinded", outpoint: `${"cd".repeat(32)}_0`, current: wire(`${"cd".repeat(32)}_0`), sats: 7, tokens: 0, swaps: 1 },
      { lpPubKey: LP3, status: "closed", sats: 0, tokens: 0, swaps: 0 },
    ]);
    const ps = await readPositions(BASE, [LP1, LP2, LP3], fetchFn as never);
    expect(asked).toEqual([`${BASE}/positions?lp=${LP1},${LP2},${LP3}`]);
    expect(ps[0]).toMatchObject({ lpPubKey: LP1, status: "live", outpoint: `${"ef".repeat(32)}_0`, sats: 60n, tokens: 150n, swaps: 2 });
    expect(ps[0]!.current?.bsvReserve).toBe(10n);
    expect(ps[1]).toMatchObject({ status: "rescinded", outpoint: `${"cd".repeat(32)}_0`, sats: 7n });
    expect(ps[2]).toEqual({ lpPubKey: LP3, status: "closed", outpoint: null, current: null, sats: 0n, tokens: 0n, swaps: 0 });
  });

  it("readPositions: an answer that is not one record per key (a short list, another shape) is refused", async () => {
    await expect(readPositions(BASE, [LP1], fakeRoute([]).fetchFn as never)).rejects.toThrow(/not one record per key/);
    await expect(readPositions(BASE, [LP1], fakeRoute({ current: wire("x_0"), hops: 0 }).fetchFn as never)).rejects.toThrow(/not one record per key/);
  });

  it("feesByToken: one line per token, its positions counted (closed ones too), the fees summed; fees not told count as 0", () => {
    const OTHER = `${"99".repeat(32)}_0`;
    expect(
      feesByToken([
        { tokenId: TOKEN, sym: "TST", dec: 2, feesEarnedSats: 60n, feesEarnedTokens: 150n },
        { tokenId: OTHER, sym: "OTH", dec: 0, feesEarnedSats: 5n, feesEarnedTokens: 0n },
        { tokenId: TOKEN, sym: "TST", dec: 2, feesEarnedSats: 40n, feesEarnedTokens: 50n }, // a closed one
        { tokenId: TOKEN, sym: "TST", dec: 2 }, // fees not told
      ]),
    ).toEqual([
      { tokenId: TOKEN, sym: "TST", dec: 2, positions: 3, sats: 100n, tokens: 200n },
      { tokenId: OTHER, sym: "OTH", dec: 0, positions: 1, sats: 5n, tokens: 0n },
    ]);
    expect(feesByToken([])).toEqual([]);
  });
});
