/**
 * LP fees per position (skein-amm 0.32.0): `lpFeesOf` reads `ls_amm_<assetId>`'s `{tokenId, lpPubKey}`
 * answer, `positionFees` asks it per position (null when the instance does not answer), and
 * `feesByToken` sums the positions, live and closed, per token (the Liquidity page's line).
 */
import { describe, expect, it } from "vitest";
import { lpFeesOf, type SignedFetch } from "../src/lib/overlay";
import { feesByToken, positionFees } from "../src/lp/positions";

const TOKEN = `${"ab".repeat(32)}_0`;
const LP = "03" + "11".repeat(32);
const BASE = "http://x.localhost/@" + TOKEN + "/amm";

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

describe("LP fees (0.32.0)", () => {
  it("lpFeesOf: the {tokenId, lpPubKey} query at ls_amm_<tokenId>; a live answer (current a pool), a closed one (current null), an unknown key (zeros, root null)", async () => {
    const live = fakeLookup({
      type: "freeform",
      result: { lpPubKey: LP, root: `${"cd".repeat(32)}_0`, sats: 60, tokens: 150, swaps: 2, current: { outpoint: `${"ef".repeat(32)}_0`, bsvReserve: 10, tokenReserve: 20, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: LP } },
    });
    const f = await lpFeesOf(live.af, BASE, TOKEN, LP);
    expect(live.asked).toEqual([{ service: `ls_amm_${TOKEN}`, query: { tokenId: TOKEN, lpPubKey: LP } }]);
    expect(f).toMatchObject({ lpPubKey: LP, root: `${"cd".repeat(32)}_0`, sats: 60n, tokens: 150n, swaps: 2 });
    expect(f.current?.bsvReserve).toBe(10n);

    const closed = await lpFeesOf(fakeLookup({ type: "freeform", result: { lpPubKey: LP, root: `${"cd".repeat(32)}_0`, sats: 7, tokens: 0, swaps: 1, current: null } }).af, BASE, TOKEN, LP);
    expect(closed).toEqual({ lpPubKey: LP, root: `${"cd".repeat(32)}_0`, sats: 7n, tokens: 0n, swaps: 1, current: null });

    const unknown = await lpFeesOf(fakeLookup({ type: "freeform", result: { lpPubKey: LP, root: null, sats: 0, tokens: 0, swaps: 0, current: null } }).af, BASE, TOKEN, LP);
    expect(unknown).toEqual({ lpPubKey: LP, root: null, sats: 0n, tokens: 0n, swaps: 0, current: null });

    // An older lookup answers the pool list for any query: not an LP fees answer.
    await expect(lpFeesOf(fakeLookup({ type: "freeform", result: [] }).af, BASE, TOKEN, LP)).rejects.toThrow(/no LP fees answer/);
  });

  it("positionFees: the sats and tokens; zeros for an unknown key; null when the instance does not answer", async () => {
    expect(await positionFees(null, BASE, TOKEN, LP, async () => ({ lpPubKey: LP, root: "r_0", sats: 60n, tokens: 150n, swaps: 2, current: null }))).toEqual({ sats: 60n, tokens: 150n });
    expect(await positionFees(null, BASE, TOKEN, LP, async () => ({ lpPubKey: LP, root: null, sats: 0n, tokens: 0n, swaps: 0, current: null }))).toEqual({ sats: 0n, tokens: 0n });
    expect(await positionFees(fakeLookup({ status: "error" }, 400).af, BASE, TOKEN, LP)).toBeNull();
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
