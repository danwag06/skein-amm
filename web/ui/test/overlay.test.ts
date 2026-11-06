/**
 * The public read API's client (skein-amm 0.34.0, src/lib/overlay.ts; docs/AMM.md "The public read
 * API"): the pools routes' answers (P1, P2; 0.41.0: plain reads only), P3's pools and BEEF, P7's terms, P9's
 * bytes, P10's record — every one a plain GET — and the rule that the pages send `/lookup`
 * nowhere (D8).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Beef, Transaction, Utils } from "@bsv/sdk";
import * as overlay from "../src/lib/overlay";
import { liveOfPools, parseAllPools, parsePools, poolOutputOf, readPoolsBeef, readTerms, readTx, toPoolRow } from "../src/lib/overlay";
import * as overlayMod from "../src/lib/overlay";
import v from "./fixtures/amm-topic-vectors.json";

const K = "03142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9";
const LP = "02" + "aa".repeat(32);
const PEER = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";
const row = (outpoint: string, extra: Record<string, unknown> = {}) => ({ poolId: "dd_0", lpPubKey: LP, swaps: 3, outpoint, bsvReserve: 1000000, tokenReserve: 5000000, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: K, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the pools routes (P1, P2)", () => {
  it("P2: {market, pools}; each row the engine's PoolState (bigints) with its pool id (0.40.0), LP key, swap count and its validator's peer ID; a validator's minimum leg (0.40.0)", () => {
    const a = parsePools({ market: { commissionPkh: "AB".repeat(20), minCommissionBps: 5 }, validators: [{ identity: K.toUpperCase(), peerId: PEER, minLegSats: 2000 }, { identity: LP, peerId: PEER, minLegSats: 0 }, { junk: 1 }], pools: [row("aa_0", { validatorPeerId: PEER }), { junk: true }] });
    expect(a.market).toEqual({ commissionPkh: "ab".repeat(20), minCommissionBps: 5 });
    // 0.34.1: the validators beating on the token's topic now; 0.40.0: a minimum of 0 is none.
    expect(a.validators).toEqual([{ identity: K, peerId: PEER, minLegSats: 2000n }, { identity: LP, peerId: PEER }]);
    expect(a.pools).toEqual([
      { outpoint: "aa_0", bsvReserve: 1000000n, tokenReserve: 5000000n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: K, poolId: "dd_0", lpPubKey: LP, swaps: 3, validatorPeerId: PEER },
    ]);
    expect(parsePools({ pools: [] })).toEqual({ market: { commissionPkh: null, minCommissionBps: 0 }, pools: [], validators: [] });
    expect(toPoolRow(row("x_0", { commissionBps: undefined }))?.commissionBps).toBe(0n);
  });

  it("P1: every token's rows, each naming its tokenId", () => {
    const T = `${"11".repeat(32)}_0`;
    expect(parseAllPools([row("aa_0", { tokenId: T }), row("bb_0")]).map((r) => [r.tokenId, r.outpoint])).toEqual([[T, "aa_0"]]);
  });

  it("the validators of the rows are live (the host listed only those), with their peer IDs; a row with no peer ID names none", () => {
    const live = liveOfPools([{ validatorIdentityKey: K.toUpperCase(), validatorPeerId: PEER }, { validatorIdentityKey: LP }], 7);
    expect(live).toEqual({ now: 7, kept: true, validators: [{ identityKey: K, peerId: PEER, at: 0, ageMs: 0, live: true }] });
  });
});

describe("P3 /pools/beef, P7 /terms, P9 /tx (0.44.0: no P10 /swaps)", () => {
  const fund = Transaction.fromHex(v.fund);
  const tokenDeploy = Transaction.fromHex(v.token_deploy);
  const poolDeploy = Transaction.fromHex(v.pool_deploy);
  const pd = poolDeploy.id("hex");

  it("P3 (0.40.0: by pool id): the pools and ONE BEEF of their transactions (base64); a pool's output out of it as an Atomic BEEF of its transaction", async () => {
    const b = new Beef();
    for (const t of [fund, tokenDeploy, poolDeploy]) b.mergeRawTx(t.toBinary());
    const asked: string[] = [];
    const pb = await readPoolsBeef("http://x/@t/amm", ["dd_0", "ee_1"], (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${init?.cache ?? ""}`);
      return json({ pools: [row(`${pd}_0`)], beef: Utils.toBase64(b.toBinary()) });
    }) as never);
    expect(asked).toEqual([`http://x/@t/amm/pools/beef?pool=dd_0,ee_1 `]);
    expect(pb.pools.map((p) => [p.poolId, p.lpPubKey])).toEqual([["dd_0", LP]]);
    const out = poolOutputOf(pb, `${pd}_0`)!;
    expect(out.outputIndex).toBe(0);
    expect(Transaction.fromAtomicBEEF(out.beef).id("hex")).toBe(pd);
    expect(poolOutputOf(pb, `${"ee".repeat(32)}_0`)).toBeNull();
    expect(poolOutputOf({ pools: [], beef: [] }, `${pd}_0`)).toBeNull();
  });

  it("P7: the validator's terms with its identity and peer, and the market; no terms, validator null", async () => {
    const t = await readTerms("http://x/@t/amm", (async () => json({ validator: { identity: K, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25, minLegSats: 2000 }, market: { commissionPkh: "55".repeat(20), minCommissionBps: 10 } })) as never);
    expect(t).toEqual({ validator: { identity: K, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25, minLegSats: 2000 }, market: { commissionPkh: "55".repeat(20), minCommissionBps: 10 } });
    const none = await readTerms("http://x/@t/amm", (async () => json({ validator: null, market: { commissionPkh: null, minCommissionBps: 0 } })) as never);
    expect(none.validator).toBeNull();
  });

  it("P9: the bytes; 404 none. No swap record read (0.44.0: nothing is recorded)", async () => {
    const f = (async (url: string) => {
      if (url.includes("/tx?id=aa")) return new Response(new Uint8Array([1, 2, 3]));
      return json({ error: "not found" }, 404);
    }) as never;
    expect(await readTx("http://x/@t/amm", "aa", f)).toEqual([1, 2, 3]);
    expect(await readTx("http://x/@t/amm", "cc", f)).toBeNull();
    expect("readSwap" in overlayMod).toBe(false);
  });
});

describe("the pages send /lookup nowhere (0.34.0, D8)", () => {
  it("the client module exports no lookup helper", () => {
    for (const name of ["lookup", "queryPools", "lookupPoolOutput", "lpFeesOf", "fetchLive", "fetchLiveByToken", "liveUrl", "parseLookupAnswer", "parseOutputList"]) expect(name in overlay).toBe(false);
  });

  it("no page source asks /lookup or a liveness read", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\/lookup[`"']/);
      expect(code, f).not.toMatch(/\/\.live\//);
    }
  });
});
