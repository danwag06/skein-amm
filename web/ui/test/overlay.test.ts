/**
 * The public read API's client (skein-amm 0.34.0, src/lib/overlay.ts; docs/AMM.md "The public read
 * API"): the pools routes' answers (P1, P2) and their stream, P3's pools and BEEF, P7's terms, P9's
 * bytes, P10's record — every one a plain GET — and the rule that the pages send `/lookup`
 * nowhere (D8).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Beef, Transaction, Utils } from "@bsv/sdk";
import * as overlay from "../src/lib/overlay";
import { liveOfPools, parseAllPools, parsePools, poolOutputOf, readPoolsBeef, readSwap, readTerms, readTx, toPoolRow, watchPools, type EventSourceLike } from "../src/lib/overlay";
import v from "./fixtures/amm-topic-vectors.json";

const K = "03142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9";
const LP = "02" + "aa".repeat(32);
const PEER = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";
const row = (outpoint: string, extra: Record<string, unknown> = {}) => ({ lpPubKey: LP, outpoint, bsvReserve: 1000000, tokenReserve: 5000000, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: K, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the pools routes (P1, P2)", () => {
  it("P2: {market, pools}; each row the engine's PoolState (bigints) with its LP key and its validator's peer ID", () => {
    const a = parsePools({ market: { commissionPkh: "AB".repeat(20), minCommissionBps: 5 }, pools: [row("aa_0", { validatorPeerId: PEER }), { junk: true }] });
    expect(a.market).toEqual({ commissionPkh: "ab".repeat(20), minCommissionBps: 5 });
    expect(a.pools).toEqual([
      { outpoint: "aa_0", bsvReserve: 1000000n, tokenReserve: 5000000n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: K, lpPubKey: LP, validatorPeerId: PEER },
    ]);
    expect(parsePools({ pools: [] })).toEqual({ market: { commissionPkh: null, minCommissionBps: 0 }, pools: [] });
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

  it("watchPools: an EventSource on the route, each `pools` event parsed and handed on; closed on unsubscribe", () => {
    const made: { url: string; es: FakeES }[] = [];
    class FakeES implements EventSourceLike {
      fns = new Map<string, (e: { data?: unknown }) => void>();
      closed = false;
      onerror: ((e: unknown) => void) | null = null;
      onopen: ((e: unknown) => void) | null = null;
      constructor(url: string) {
        made.push({ url, es: this });
      }
      addEventListener(t: string, fn: (e: { data?: unknown }) => void) {
        this.fns.set(t, fn);
      }
      close() {
        this.closed = true;
      }
    }
    const got: unknown[] = [];
    const off = watchPools("http://x/@t/amm/pools", parsePools, (a) => got.push(a), { EventSource: FakeES });
    expect(made.map((m) => m.url)).toEqual(["http://x/@t/amm/pools"]);
    made[0]!.es.fns.get("pools")!({ data: JSON.stringify({ market: {}, pools: [row("aa_0", { validatorPeerId: PEER })] }) });
    made[0]!.es.fns.get("pools")!({ data: JSON.stringify({ market: {}, pools: [] }) });
    expect(got).toHaveLength(2);
    expect((got[1] as { pools: unknown[] }).pools).toEqual([]);
    off();
    expect(made[0]!.es.closed).toBe(true);
  });

  it("watchPools without an EventSource: ONE plain GET, no poll", async () => {
    const asked: string[] = [];
    const got: unknown[] = [];
    watchPools("http://x/amm/pools", parseAllPools, (a) => got.push(a), {
      EventSource: null,
      fetch: async (url: string) => {
        asked.push(url);
        return json([row("aa_0", { tokenId: `${"11".repeat(32)}_0` })]);
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(["http://x/amm/pools"]);
    expect(got).toHaveLength(1);
  });
});

describe("P3 /pools/beef, P7 /terms, P9 /tx, P10 /swaps", () => {
  const fund = Transaction.fromHex(v.fund);
  const tokenDeploy = Transaction.fromHex(v.token_deploy);
  const poolDeploy = Transaction.fromHex(v.pool_deploy);
  const pd = poolDeploy.id("hex");

  it("P3: the LP keys' pools and ONE BEEF of their transactions (base64); a pool's output out of it as an Atomic BEEF of its transaction", async () => {
    const b = new Beef();
    for (const t of [fund, tokenDeploy, poolDeploy]) b.mergeRawTx(t.toBinary());
    const asked: string[] = [];
    const pb = await readPoolsBeef("http://x/@t/amm", [LP, K], (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${init?.cache ?? ""}`);
      return json({ pools: [row(`${pd}_0`)], beef: Utils.toBase64(b.toBinary()) });
    }) as never);
    expect(asked).toEqual([`http://x/@t/amm/pools/beef?lp=${LP},${K} `]);
    expect(pb.pools.map((p) => p.lpPubKey)).toEqual([LP]);
    const out = poolOutputOf(pb, `${pd}_0`)!;
    expect(out.outputIndex).toBe(0);
    expect(Transaction.fromAtomicBEEF(out.beef).id("hex")).toBe(pd);
    expect(poolOutputOf(pb, `${"ee".repeat(32)}_0`)).toBeNull();
    expect(poolOutputOf({ pools: [], beef: [] }, `${pd}_0`)).toBeNull();
  });

  it("P7: the validator's terms with its identity and peer, and the market; no terms, validator null", async () => {
    const t = await readTerms("http://x/@t/amm", (async () => json({ validator: { identity: K, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, market: { commissionPkh: "55".repeat(20), minCommissionBps: 10 } })) as never);
    expect(t).toEqual({ validator: { identity: K, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, market: { commissionPkh: "55".repeat(20), minCommissionBps: 10 } });
    const none = await readTerms("http://x/@t/amm", (async () => json({ validator: null, market: { commissionPkh: null, minCommissionBps: 0 } })) as never);
    expect(none.validator).toBeNull();
  });

  it("P9: the bytes; 404 none. P10: the record; 404 none", async () => {
    const f = (async (url: string) => {
      if (url.includes("/tx?id=aa")) return new Response(new Uint8Array([1, 2, 3]));
      if (url.includes("/swaps?id=bb")) return json({ id: "bb", status: "pending" });
      return json({ error: "not found" }, 404);
    }) as never;
    expect(await readTx("http://x/@t/amm", "aa", f)).toEqual([1, 2, 3]);
    expect(await readTx("http://x/@t/amm", "cc", f)).toBeNull();
    expect(await readSwap("http://x/@t/amm", "bb", f)).toEqual({ id: "bb", status: "pending" });
    expect(await readSwap("http://x/@t/amm", "cc", f)).toBeNull();
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
