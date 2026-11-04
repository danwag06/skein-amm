/**
 * LP pools and fees (skein-amm 0.33.0): `lpFeesOf` asks `ls_amm_<assetId>`'s `{tokenId, lpPubKeys}` once for every
 * key of a token and reads one record per key (status live / rescinded / closed, the pool state, the LP fees);
 * `feesByToken` sums the positions, live and closed, per token (the Liquidity page's line).
 */
import { describe, expect, it } from "vitest";
import { lpFeesOf, type SignedFetch } from "../src/lib/overlay";
import { feesByToken } from "../src/lp/positions";

const TOKEN = `${"ab".repeat(32)}_0`;
const LP1 = "03" + "11".repeat(32);
const LP2 = "02" + "22".repeat(32);
const LP3 = "02" + "33".repeat(32);
const BASE = "http://x.localhost/@" + TOKEN + "/amm";
const wire = (outpoint: string) => ({ outpoint, bsvReserve: 10, tokenReserve: 20, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: LP1 });

function fakeLookup(result: unknown, status = 200): { af: SignedFetch; asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    af: {
      fetch: async (_url: string, init?: unknown) => {
        asked.push(JSON.parse(String((init as { body: string }).body)));
        return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
      },
    } as SignedFetch,
  };
}

describe("LP pools (0.33.0)", () => {
  it("lpFeesOf: ONE {tokenId, lpPubKeys} query for all the keys; a live record (outpoint, current), a rescinded one (the Rescind's output and its state), a closed or unknown one (no outpoint, no current)", async () => {
    const { af, asked } = fakeLookup({
      type: "freeform",
      result: [
        { lpPubKey: LP1, status: "live", outpoint: `${"ef".repeat(32)}_0`, current: wire(`${"ef".repeat(32)}_0`), sats: 60, tokens: 150, swaps: 2 },
        { lpPubKey: LP2, status: "rescinded", outpoint: `${"cd".repeat(32)}_0`, current: wire(`${"cd".repeat(32)}_0`), sats: 7, tokens: 0, swaps: 1 },
        { lpPubKey: LP3, status: "closed", sats: 0, tokens: 0, swaps: 0 },
      ],
    });
    const ps = await lpFeesOf(af, BASE, TOKEN, [LP1, LP2, LP3]);
    expect(asked).toEqual([{ service: `ls_amm_${TOKEN}`, query: { tokenId: TOKEN, lpPubKeys: [LP1, LP2, LP3] } }]);
    expect(ps[0]).toMatchObject({ lpPubKey: LP1, status: "live", outpoint: `${"ef".repeat(32)}_0`, sats: 60n, tokens: 150n, swaps: 2 });
    expect(ps[0]!.current?.bsvReserve).toBe(10n);
    expect(ps[1]).toMatchObject({ status: "rescinded", outpoint: `${"cd".repeat(32)}_0`, sats: 7n });
    expect(ps[2]).toEqual({ lpPubKey: LP3, status: "closed", outpoint: null, current: null, sats: 0n, tokens: 0n, swaps: 0 });
  });

  it("lpFeesOf: an answer that is not one record per key (an older lookup's pool list, a short list) is refused", async () => {
    await expect(lpFeesOf(fakeLookup({ type: "freeform", result: [] }).af, BASE, TOKEN, [LP1])).rejects.toThrow(/no LP pools answer/);
    await expect(lpFeesOf(fakeLookup({ type: "freeform", result: { current: wire("x_0"), hops: 0 } }).af, BASE, TOKEN, [LP1])).rejects.toThrow(/no LP pools answer/);
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
