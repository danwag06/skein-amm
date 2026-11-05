/**
 * src/data/exchange.ts, wired (skein-amm 0.34.0: the public read API; agent-env
 * plans/exchange-api-2026-11-04.md D1–D25): each function against a fake exchange (one route table:
 * the swap instance's /tokens, /defaults, /discovery, /admin and card, the host's pools routes, a
 * token instance's /pools/beef, /positions, /terms, /spends, /tx, /swaps, /call, discovery's
 * /tokens and /<token>/deploy, /sendMessage) and a fake wallet, over the Go fixtures
 * (src/fixtures/vectors.zig's copy). Every request is recorded: the pages send `/lookup` nowhere,
 * and the request counts per page are measured here ("requests per page").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { ColorPlan } from "@bsv/color-permission-module";
import { sdk as toolboxSdk } from "@bsv/wallet-toolbox-client";
const { specOpWalletBalance } = toolboxSdk;
import { decodeOneColor } from "../src/pool";
import { tokenP2pkhScript } from "../src/lp/poolDeploy";
import { decode, encode } from "cbor2";
import { OneColor } from "@1sat/templates";
import {
  NO_TERMS_TEXT,
  clearDefaultMarket,
  clearDefaultTerms,
  closePosition,
  connectAction,
  defaults,
  disableToken,
  enableToken,
  forgetReads,
  hasTerms,
  setDefaultMarket,
  setDefaultTerms,
  setDiscovery,
  discoveryState,
  tokenBaseOf,
  deployPosition,
  deployBeef,
  tokensToEnable,
  executeSwap,
  hostedTokens,
  hostedFrom,
  isRoot,
  lookupOf,
  ammLookupOf,
  myPositions,
  myTokens,
  onDataChange,
  poolViews,
  quoteSwap,
  registeredTokens,
  setExchangeContext,
  settleSwaps,
  topicOf,
  validatorTerms,
  walletSats,
  watchHostedPools,
  watchTokenPools,
  claimStatus,
  SPEC_OP_WALLET_BALANCE,
  type PoolsAnswer,
} from "../src/data/exchange";
import { parsePools, readPools } from "../src/lib/overlay";
import { compactSats, fmtAmount, fmtChange, fmtPrice, parseInput } from "../src/ox/format";
import { parseRoute, routeHref } from "../src/ox/route";
import { PEER } from "./liveRead";
import v from "./fixtures/amm-topic-vectors.json";

const OUTPOINT = /^[0-9a-f]{64}\.\d+$/;
const ORIGIN = "http://alice.localhost:8300";
/** The swap instance's AMM base (the pages'). */
const BASE = `${ORIGIN}/amm`;
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const fund = Transaction.fromHex(v.fund);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const swap1 = Transaction.fromHex(v.swap_bsv_in);
const DEPLOY = tokenDeploy.id("hex");
const TOKEN = `${DEPLOY}_0`;
const TOPIC = `tm_color_${TOKEN}`;
const OTHER = `${"cd".repeat(32)}_0`;
const ME = "02" + "11".repeat(32);
const SKEIN = v.identity;

function atomic(tx: Transaction, ancestors: Transaction[]): number[] {
  const b = new Beef();
  for (const a of ancestors) b.mergeRawTx(a.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinaryAtomic(tx.id("hex"));
}
/** A pool row as the pools routes answer it (P2: with the validator's peer ID). */
const wirePool = (txid: string, p: { bsv: number; tokens: number }, extra: Record<string, unknown> = {}) => ({ lpPubKey: v.lp, outpoint: `${txid}_0`, bsvReserve: p.bsv, tokenReserve: p.tokens, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: SKEIN, validatorPeerId: PEER, ...extra });

/** The exchange: a route table over plain fetch and the wallet's signed fetch alike. */
interface Instance {
  /** The swap instance's enable list (`/amm/tokens`). */
  enabled: Record<string, unknown>[];
  defaults: Record<string, unknown>;
  discovery: Record<string, unknown>;
  /** The host's pools routes (P1, P2): each token's listed pools (the host filtered them). */
  pools: Record<string, unknown[]>;
  market: { commissionPkh: string | null; minCommissionBps: number };
  /** P2's `validators` (0.34.1): beating on the token's topic now. */
  validators: { identity: string; peerId: string }[];
  /** The transactions P3's BEEF carries. */
  poolTxs: Transaction[];
  /** P4: records by LpPubKey (unknown: closed with zeros). */
  lpPools: Record<string, unknown>;
  /** P7's validator; null: no terms set. */
  terms: Record<string, unknown> | null;
  /** P8: by outpoint `<txid>.<vout>`. */
  spends: Record<string, unknown>;
  /** P9: by txid. */
  txs: Record<string, number[]>;
  /** Discovery's token list (P13); null: discovery off (404). */
  discoveryList: Record<string, unknown>[] | null;
  /** P16: by token id. */
  discoveryDeploys: Record<string, number[]>;
  sent: { url: string; body: Record<string, unknown> }[];
  calls: { fn: string; args: unknown }[];
  /** Every request: method, path and query. */
  requests: string[];
}

const enabledRow = (tokenId: string, sym: string, dec: number, since: number) => ({ tokenId, topic: `tm_color_${tokenId}`, sym, dec, status: "enabled", since });

function instance(): Instance {
  return {
    enabled: [enabledRow(TOKEN, "TST", 0, 2)],
    defaults: {},
    discovery: { on: false },
    pools: { [TOKEN]: [wirePool(poolDeploy.id("hex"), v.pool0)] },
    market: { commissionPkh: null, minCommissionBps: 0 },
    validators: [{ identity: SKEIN, peerId: PEER }],
    poolTxs: [fund, tokenDeploy, poolDeploy],
    lpPools: {},
    terms: { identity: SKEIN, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 0 },
    spends: {},
    txs: {},
    discoveryList: null,
    discoveryDeploys: {},
    sent: [],
    calls: [],
    requests: [],
  };
}

let inst: Instance;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bytes = (b: number[]) => new Response(new Uint8Array(b), { status: 200, headers: { "content-type": "application/octet-stream" } });
const list = (u: URL, k: string) => (u.searchParams.get(k) ?? "").split(",").filter((x) => x !== "");

async function route(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> {
  const u = new URL(url);
  inst.requests.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
  if (u.pathname.endsWith("/lookup")) return json({ status: "error", message: "the pages send no lookup" }, 400);
  if (u.pathname === "/.well-known/skein") return json({ handle: "swap", identity: SKEIN, origin: ORIGIN, claimed: true });
  if (u.pathname === "/sendMessage") {
    inst.sent.push({ url, body: decode(init!.body as Uint8Array) as Record<string, unknown> });
    return new Response(encode({ status: "success", id: `msg${inst.sent.length}` }) as BodyInit, { status: 200 });
  }
  const disc = /^\/@discovery\/1color\/(.*)$/.exec(u.pathname);
  if (disc) {
    if (!inst.discoveryList) return json({ error: "no instance discovery" }, 404);
    if (disc[1] === "tokens") {
      const ids = u.searchParams.get("ids");
      if (ids !== null) return json(ids.split(",").map((id) => inst.discoveryList!.find((t) => t.tokenId === id) ?? { tokenId: id, listed: false }));
      return json(inst.discoveryList.slice(Number(u.searchParams.get("skip") ?? 0), Number(u.searchParams.get("skip") ?? 0) + Number(u.searchParams.get("limit") ?? 100)));
    }
    const dep = /^([0-9a-f]{64}_\d+)\/deploy$/.exec(disc[1]!);
    if (dep && inst.discoveryDeploys[dep[1]!]) return bytes(inst.discoveryDeploys[dep[1]!]!);
    return json({ error: "not found" }, 404);
  }
  const tok = /^\/@([0-9a-f]{64}_\d+)\/amm(\/.*)$/.exec(u.pathname);
  if (!tok) {
    const path = u.pathname.replace(/^\/amm/, "");
    if (path === "/tokens") return json(inst.enabled);
    if (path === "/defaults") return json(inst.defaults);
    if (path === "/discovery") return json(inst.discovery);
    if (path === "/admin") return json({});
    if (path === "/pools") return json(inst.enabled.filter((t) => t.status === "enabled").flatMap((t) => (inst.pools[String(t.tokenId)] ?? []).map((p) => ({ tokenId: t.tokenId, ...(p as object) }))));
    return json({ error: `no route ${url}` }, 404);
  }
  const [, token, path] = tok;
  const rows = (inst.pools[token!] ?? []) as Record<string, unknown>[];
  if (path === "/pools") return json({ market: inst.market, validators: inst.validators, pools: rows });
  if (path === "/pools/beef") {
    const keys = list(u, "lp");
    const b = new Beef();
    for (const t of inst.poolTxs) b.mergeRawTx(t.toBinary());
    const pools = rows.filter((r) => keys.includes(String(r.lpPubKey))).map(({ validatorPeerId: _, ...r }) => r);
    return json({ pools, beef: Utils.toBase64(b.toBinary()) });
  }
  if (path === "/positions") return json(list(u, "lp").map((k) => inst.lpPools[k] ?? { lpPubKey: k, status: "closed", sats: 0, tokens: 0, swaps: 0 }));
  if (path === "/terms") return json({ validator: inst.terms, market: inst.market });
  if (path === "/spends") {
    const ops = list(u, "outpoint");
    const rec = (o: string) => inst.spends[o] ?? { outpoint: o, hops: 0, closed: false };
    return json(ops.length === 1 ? rec(ops[0]!) : ops.map(rec));
  }
  if (path === "/tx") return inst.txs[u.searchParams.get("id") ?? ""] ? bytes(inst.txs[u.searchParams.get("id")!]!) : json({ error: "unknown transaction" }, 404);
  if (path === "/call") {
    const b = JSON.parse(String(init!.body)) as { fn: string; args: unknown };
    inst.calls.push(b);
    return json({ fn: b.fn, error: { code: "failed", message: "no relay here" } }, 500);
  }
  return json({ error: `no route ${url}` }, 404);
}

/** The requests made since `from`, as "METHOD path?query". */
const since = (from: number) => inst.requests.slice(from);

/**
 * A fake wallet: its position rows (`amm-pools`), the BRC-207 module's views (`p color assets`:
 * `held`; `p color balance <tag>`: `balances`), the active swap basket (`amm-swap`), the toolbox's
 * balance special operation, its identity.
 */
interface WalletRows {
  deploy?: { basket: string; outpoint: string; beef: number[] };
  pools?: unknown[];
  held?: unknown[];
  balances?: Record<string, string>;
  swaps?: unknown[];
  /** 0.28.0: the wallet's actions labelled amm-pool-deploy (listActions with includeOutputs). */
  actions?: unknown[];
}
/** Every basket the fake wallet was asked to list, in order. */
let walletReads: string[] = [];
/** Every internalizeAction the fake wallet was given. */
let internalized: unknown[] = [];
function fakeWallet(rows: WalletRows = {}, sats: number[] = [1_000, 2_500]): WalletInterface {
  return {
    async listOutputs(args: { basket: string; tags?: string[] }) {
      walletReads.push(args.basket);
      if (args.basket === specOpWalletBalance) return { totalOutputs: sats.reduce((a, s) => a + s, 0), outputs: [] };
      if (args.basket === "amm-pools") return { totalOutputs: rows.pools?.length ?? 0, outputs: rows.pools ?? [] };
      if (args.basket === "amm-swap") return { totalOutputs: rows.swaps?.length ?? 0, outputs: rows.swaps ?? [] };
      if (args.basket === "p color assets") return { totalOutputs: rows.held?.length ?? 0, outputs: rows.held ?? [] };
      if (args.basket.startsWith("p color balance ")) return { totalOutputs: rows.balances?.[args.basket] ?? "0", outputs: [] };
      if (rows.deploy && args.basket === rows.deploy.basket) return { totalOutputs: 1, outputs: [{ outpoint: rows.deploy.outpoint, satoshis: 1, spendable: true }], BEEF: rows.deploy.beef };
      return { totalOutputs: 0, outputs: [] };
    },
    async listActions(args: { labels?: string[] }) {
      const a = args.labels?.includes("amm-pool-deploy") ? (rows.actions ?? []) : [];
      return { totalActions: a.length, actions: a };
    },
    async getPublicKey() {
      return { publicKey: ME };
    },
    async internalizeAction(args: unknown) {
      internalized.push(args);
      return { accepted: true };
    },
  } as unknown as WalletInterface;
}

const af = { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => route(url, init) };

/** A browser EventSource over the route table: the first `pools` event is the route's answer now. */
const streams: string[] = [];
class FakeEventSource {
  fns = new Map<string, (e: { data?: unknown }) => void>();
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  constructor(url: string) {
    streams.push(url);
    void route(url).then(async (r) => this.fns.get("pools")?.({ data: await r.text() }));
  }
  addEventListener(t: string, fn: (e: { data?: unknown }) => void) {
    this.fns.set(t, fn);
  }
  close() {}
}

beforeEach(() => {
  inst = instance();
  walletReads = [];
  internalized = [];
  streams.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => route(url, init as never));
  vi.stubGlobal("EventSource", FakeEventSource);
  setExchangeContext({ base: BASE, wallet: null, signedFor: null, identityKey: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const connect = (rows?: WalletRows) => setExchangeContext({ wallet: fakeWallet(rows), signedFor: () => af as never, identityKey: ME });
/** The token's pools route's answer, as the Swap page holds it. */
const held = async (): Promise<PoolsAnswer> => readPools(`${ORIGIN}/@${TOKEN}/amm`);
const META = { sym: "TST", dec: 0 };
const noLookup = () => expect(inst.requests.filter((r) => r.includes("/lookup") || r.includes("/.live/"))).toEqual([]);

describe("exchange.ts, wired", () => {
  it("hostedTokens (D6, D22): the enabled 1Color tokens, priced from the host-wide pools route's rows (the host listed only live validators' pools); a token with no rows, no price", async () => {
    inst.enabled.push(enabledRow(OTHER, "OTH", 2, 1));
    const ts = await hostedTokens();
    expect(ts.map((t) => [t.tokenId, t.sym, t.dec])).toEqual([
      [TOKEN, "TST", 0],
      [OTHER, "OTH", 2],
    ]);
    const t = ts[0]!;
    expect(t.reserves).toEqual({ sats: BigInt(v.pool0.bsv), tokens: BigInt(v.pool0.tokens) });
    expect(t.pools).toBe(1);
    expect(t.marginalPrice).toBeCloseTo(v.pool0.bsv / v.pool0.tokens, 9);
    expect(t.depth!.sats).toBeGreaterThan(0n);
    expect(ts[1]).toMatchObject({ marginalPrice: null, pools: 0, reserves: { sats: 0n, tokens: 0n } });
    expect(since(0)).toEqual(["GET /amm/tokens", "GET /amm/pools"]);
    // Not read yet: no prices.
    expect(hostedFrom(inst.enabled as never, null)[0]).toMatchObject({ marginalPrice: null, pools: 0 });
  });

  it("the pools streams (D16, D22): the host-wide route and a token's route held as EventSources; each answer handed on", async () => {
    const rows: unknown[] = [];
    const answers: PoolsAnswer[] = [];
    const off1 = watchHostedPools((r) => rows.push(r));
    const off2 = watchTokenPools(TOKEN, (a) => answers.push(a));
    await new Promise((r) => setTimeout(r, 10));
    expect(streams).toEqual([`${BASE}/pools`, `${ORIGIN}/@${TOKEN}/amm/pools`]);
    expect(rows).toHaveLength(1);
    expect(answers[0]!.pools.map((p) => p.outpoint)).toEqual([`${poolDeploy.id("hex")}_0`]);
    off1();
    off2();
  });

  it("poolViews: the token's pools route's rows, outpoints dotted, every validator live (the host lists no other)", async () => {
    expect(poolViews(await held(), TOKEN)).toEqual([{ outpoint: `${poolDeploy.id("hex")}.0`, tokenId: TOKEN, sats: BigInt(v.pool0.bsv), tokens: BigInt(v.pool0.tokens), validator: { identityKey: SKEIN, live: true } }]);
    expect(poolViews(null, TOKEN)).toEqual([]);
  });

  it("quoteSwap (D12): the matching engine's plan over the held pools, no request; a buy pays above marginal, a sell gets below; no pool: refused", async () => {
    const h = await held();
    const n = inst.requests.length;
    const buy = quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, h, META);
    expect(buy.legs).toHaveLength(1);
    expect(buy.legs[0]!.poolOutpoint).toMatch(OUTPOINT);
    expect(buy.legs[0]!.amountIn).toBe(20_000n);
    expect(buy.amountOut).toBe(BigInt(v.swapBsvInTokensOut));
    expect(buy.minAmountOut).toBeLessThanOrEqual(buy.amountOut);
    expect(buy.effectivePrice).toBeGreaterThan(buy.marginalPrice);
    expect(buy.fees).toEqual({ lpBps: 30, validatorBps: 5, commissionBps: 10 });
    const sell = quoteSwap({ tokenId: TOKEN, side: "sell", amountIn: 50_000n, maxSlippageBps: 100, allowPartial: false }, h, META);
    expect(sell.effectivePrice).toBeLessThan(sell.marginalPrice);
    expect(inst.requests.length).toBe(n);
    expect(() => quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, { ...h, pools: [] }, META)).toThrow(/No pool to swap against/);
  });

  it("executeSwap (D14): needs a wallet; a planned pool gone from ONE /pools/beef?lp= read stops it (no partial fills)", async () => {
    const q = quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, await held(), META);
    await expect(executeSwap(q)).rejects.toThrow(/Connect a wallet/);
    connect();
    inst.pools[TOKEN] = [];
    const n = inst.requests.length;
    await expect(executeSwap(q)).rejects.toThrow(/spent since the quote/);
    expect(since(n)).toEqual([`GET /@${TOKEN}/amm/pools/beef?lp=${v.lp}`]);
  });

  it("executeSwap, tokens in (0.12.0; 0.29.0): each leg spends amm-swap outputs carrying its amount exactly and one sats output of its exact sats; what they do not cover is staged by ONE send first (the module's with the tokens, else a plain sats send)", async () => {
    const swapKey = new PrivateKey(77);
    const sent: CreateActionArgs[] = [];
    const swapRows: unknown[] = [];
    const swapBeef = new Beef();
    const wallet = {
      ...fakeWallet(),
      async listOutputs(args: { basket: string }) {
        if (args.basket === "amm-swap") return { totalOutputs: swapRows.length, outputs: swapRows, BEEF: swapBeef.toBinary() };
        return { totalOutputs: 0, outputs: [] };
      },
      async getPublicKey(args: { identityKey?: boolean }) {
        return { publicKey: args.identityKey ? ME : swapKey.toPublicKey().toString() };
      },
      async createAction(args: CreateActionArgs) {
        sent.push(args);
        const tx = new Transaction();
        tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: 0, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
        for (const o of args.outputs ?? []) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) });
        return { txid: tx.id("hex"), tx: tx.toAtomicBEEF(true) };
      },
      async internalizeAction() {
        return { accepted: true };
      },
    } as unknown as WalletInterface;
    setExchangeContext({ wallet, signedFor: () => af as never, identityKey: ME });
    const q = quoteSwap({ tokenId: TOKEN, side: "sell", amountIn: 50_000n, maxSlippageBps: 100, allowPartial: false }, await held(), META);
    expect(q.legs.map((l) => l.amountIn)).toEqual([50_000n]);
    // Nothing in the swap basket: ONE module send of exactly the leg's amount AND the leg's sats (0.29.0), before the leg; no funding action.
    await executeSwap(q);
    expect(sent).toHaveLength(1);
    const plan = ColorPlan.fromLabels(sent[0]!.labels)!;
    expect(plan).toMatchObject({ assets: [TOKEN], ownedOutputs: [], operations: [{ assetId: TOKEN, operation: "transfer" }] });
    expect(sent[0]!.outputs).toHaveLength(2);
    expect(decodeOneColor(Utils.toArray(sent[0]!.outputs![0]!.lockingScript, "hex"))!.amount).toBe(50_000n);
    const satsOut = sent[0]!.outputs![1]!;
    expect(decodeOneColor(Utils.toArray(satsOut.lockingScript, "hex"))).toBeNull();
    expect([satsOut.basket, JSON.parse(satsOut.customInstructions!).sats]).toEqual(["amm-swap", true]);
    // D19: the swap-basket send is submitted at the host root, routed by X-Topics.
    expect(inst.requests).toContain("POST /submit");
    // The swap basket holds an output of exactly the leg's amount: the sats only, by a plain send (no p color plan).
    const heldTx = new Transaction();
    heldTx.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    heldTx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenP2pkhScript(TOKEN, 50_000n, swapKey.toPublicKey().toString())) });
    swapBeef.mergeTransaction(heldTx);
    swapRows.push({ outpoint: `${heldTx.id("hex")}.0`, satoshis: 1, spendable: true, lockingScript: heldTx.outputs[0]!.lockingScript.toHex(), customInstructions: JSON.stringify({ assetId: TOKEN, amount: "50000", protocolID: [2, "amm swap"], keyID: "amm-swap-x", counterparty: "self" }) });
    sent.length = 0;
    await executeSwap(q);
    expect(sent.map((a) => [ColorPlan.fromLabels(a.labels) !== undefined, a.labels, a.outputs!.map((o) => [o.satoshis, o.basket])])).toEqual([[false, ["amm-swap"], [[satsOut.satoshis, "amm-swap"]]]]);
    // It holds the leg's exact sats too: no send at all.
    const heldSats = new Transaction();
    heldSats.addInput({ sourceTXID: "78".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    heldSats.addOutput({ satoshis: satsOut.satoshis, lockingScript: LockingScript.fromHex(satsOut.lockingScript) });
    swapBeef.mergeTransaction(heldSats);
    swapRows.push({ outpoint: `${heldSats.id("hex")}.0`, satoshis: satsOut.satoshis, spendable: true, lockingScript: satsOut.lockingScript, customInstructions: satsOut.customInstructions });
    sent.length = 0;
    await executeSwap(q);
    expect(sent).toEqual([]);
    noLookup();
  });

  it("executeSwap, sats in (0.29.0; 0.34.0): the leg's sats staged by ONE plain createAction, then the leg; ONE /pools/beef read, no terms read (the market's key hash is the held pools route's)", async () => {
    const sent: CreateActionArgs[] = [];
    const wallet = {
      ...fakeWallet(),
      async listOutputs(args: { basket: string }) {
        if (args.basket === "amm-swap") return { totalOutputs: 0, outputs: [], BEEF: new Beef().toBinary() };
        return { totalOutputs: 0, outputs: [] };
      },
      async getPublicKey(args: { identityKey?: boolean }) {
        return { publicKey: args.identityKey ? ME : new PrivateKey(78).toPublicKey().toString() };
      },
      async createAction(args: CreateActionArgs) {
        sent.push(args);
        const tx = new Transaction();
        tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: 0, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
        for (const o of args.outputs ?? []) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) });
        return { txid: tx.id("hex"), tx: tx.toAtomicBEEF(true) };
      },
    } as unknown as WalletInterface;
    setExchangeContext({ wallet, signedFor: () => af as never, identityKey: ME });
    inst.market = { commissionPkh: v.commissionPkh, minCommissionBps: 10 };
    const h = await held();
    expect(h.market.commissionPkh).toBe(v.commissionPkh);
    const q = quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, h, META);
    expect(q.legs.map((l) => l.amountIn)).toEqual([20_000n]);
    const n = inst.requests.length;
    const r = await executeSwap(q);
    // ONE read of the pools the legs spend; no terms read (this fake wallet signs nothing, so the leg stops before its relay: test/swap.test.ts relays one).
    expect(since(n)).toEqual([`GET /@${TOKEN}/amm/pools/beef?lp=${v.lp}`]);
    expect(inst.calls.map((c) => c.fn)).toEqual([]);
    expect(r.status).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.labels).toEqual(["amm-swap"]);
    expect(ColorPlan.fromLabels(sent[0]!.labels)).toBeUndefined();
    const o = sent[0]!.outputs![0]!;
    expect(o.basket).toBe("amm-swap");
    expect(JSON.parse(o.customInstructions!)).toMatchObject({ sats: true, protocolID: [2, "amm swap"], counterparty: "self" });
    expect(o.satoshis).toBeGreaterThan(20_001);
    expect(o.satoshis).toBeLessThan(20_001 + 2_000);
  });

  it("walletSats (0.31.4): one listOutputs on the toolbox's balance special operation (no limit, no other basket), its totalOutputs as a bigint", async () => {
    const asked: unknown[] = [];
    setExchangeContext({
      wallet: { async listOutputs(args: unknown) { asked.push(args); return { totalOutputs: 3_500, outputs: [] }; } } as unknown as WalletInterface,
      signedFor: () => af as never,
      identityKey: ME,
    });
    expect(await walletSats()).toBe(3_500n);
    expect(asked).toEqual([{ basket: "893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8" }]);
    expect(SPEC_OP_WALLET_BALANCE).toBe(specOpWalletBalance);
    connect();
    expect(await walletSats()).toBe(3_500n);
  });

  it("myPositions (D9): the wallet's pool rows grouped by token, ONE GET /positions?lp= per token for each pool's state and fees; the token list read once; nothing else read on load", async () => {
    const pd = poolDeploy.id("hex");
    const s1 = swap1.id("hex");
    const ci = JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { validatorIdentity: SKEIN } });
    const row = { outpoint: `${pd}.0`, satoshis: v.pool0.bsv, lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(), tags: ["amm-pool"], customInstructions: ci };
    // A second row of the same pool: one key, one position.
    const again = { outpoint: `${s1}.0`, satoshis: v.pool1.bsv, lockingScript: swap1.outputs[0]!.lockingScript.toHex(), tags: ["amm-pool"], customInstructions: ci };
    connect({ pools: [row, again] });
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "live", outpoint: `${s1}_0`, current: wirePool(s1, v.pool1), sats: 60, tokens: 0, swaps: 1 };
    expect(await myPositions()).toEqual([
      { outpoint: `${s1}.0`, tokenId: TOKEN, sym: "TST", dec: 0, sats: BigInt(v.pool1.bsv), tokens: BigInt(v.pool1.tokens), validator: { identityKey: SKEIN, live: true }, feesEarnedSats: 60n, feesEarnedTokens: 0n },
    ]);
    expect(since(0)).toEqual(["GET /amm/tokens", `GET /@${TOKEN}/amm/positions?lp=${v.lp}`, `GET /@${TOKEN}/amm/pools`]);
    // 0.34.1: live = the validator is in P2's `validators` (beating now), not whether the pool is listed.
    inst.validators = [];
    expect((await myPositions())[0]!.validator.live).toBe(false);
    inst.validators = [{ identity: SKEIN, peerId: PEER }];
    inst.pools[TOKEN] = [];
    expect((await myPositions())[0]!.validator.live).toBe(true);

    // Rescinded: the card's status from the record, the Rescind's output and its state.
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "rescinded", outpoint: `${s1}_0`, current: wirePool(s1, v.pool1), sats: 60, tokens: 150, swaps: 2 };
    expect(await myPositions()).toEqual([
      { outpoint: `${s1}.0`, tokenId: TOKEN, sym: "TST", dec: 0, sats: BigInt(v.pool1.bsv), tokens: BigInt(v.pool1.tokens), validator: { identityKey: SKEIN, live: true }, rescinded: true, feesEarnedSats: 60n, feesEarnedTokens: 150n },
    ]);

    // Closed: kept, marked closed (no card), for its fees; a close of a position not held is refused.
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "closed", sats: 60, tokens: 150, swaps: 2 };
    expect(await myPositions()).toEqual([
      { outpoint: `${pd}.0`, tokenId: TOKEN, sym: "TST", dec: 0, sats: 0n, tokens: 0n, validator: { identityKey: SKEIN, live: false }, closed: true, feesEarnedSats: 60n, feesEarnedTokens: 150n },
    ]);
    await expect(closePosition({ outpoint: `${s1}.0` })).rejects.toThrow(/No such position/);
    // The list was read once this page load.
    expect(inst.requests.filter((r) => r === "GET /amm/tokens")).toHaveLength(1);
    noLookup();
  });

  it("myPositions (D23): a deploy only in the history (listActions amm-pool-deploy, its output script) is asked by its LP key and listed; while its pool is still at the deploy's output, its row is filed in amm-pools (basket insertion over GET /tx?id=); a row with no script (no LP key) is not", async () => {
    const pd = poolDeploy.id("hex");
    const ci = JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { validatorIdentity: SKEIN } });
    const action = (script?: string) => ({
      txid: pd,
      satoshis: 0,
      status: "completed",
      isOutgoing: true,
      description: "AMM pool deploy: TST",
      labels: ["amm-pool-deploy"],
      version: 1,
      lockTime: 0,
      outputs: [
        { outputIndex: 0, satoshis: v.pool0.bsv, spendable: false, basket: "amm-pools", tags: ["amm-pool"], customInstructions: ci, outputDescription: "AMM pool: TST / BSV", ...(script ? { lockingScript: script } : {}) },
        { outputIndex: 1, satoshis: 5, spendable: false, basket: "default", tags: [], outputDescription: "change" },
      ],
    });
    connect({ pools: [], actions: [action(poolDeploy.outputs[0]!.lockingScript.toHex())] });
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "live", outpoint: `${pd}_0`, current: wirePool(pd, v.pool0), sats: 0, tokens: 0, swaps: 0 };
    inst.txs[pd] = atomic(poolDeploy, [fund, tokenDeploy]);
    expect(await myPositions()).toEqual([
      { outpoint: `${pd}.0`, tokenId: TOKEN, sym: "TST", dec: 0, sats: BigInt(v.pool0.bsv), tokens: BigInt(v.pool0.tokens), validator: { identityKey: SKEIN, live: true }, feesEarnedSats: 0n, feesEarnedTokens: 0n },
    ]);
    expect(since(0)).toEqual(["GET /amm/tokens", `GET /@${TOKEN}/amm/positions?lp=${v.lp}`, `GET /@${TOKEN}/amm/pools`, `GET /@${TOKEN}/amm/tx?id=${pd}`]);
    expect(internalized).toHaveLength(1);
    const ia = internalized[0] as { tx: number[]; outputs: { outputIndex: number; protocol: string; insertionRemittance: { basket: string; tags: string[]; customInstructions: string } }[]; labels: string[] };
    expect(ia.labels).toEqual(["amm-pool-deploy"]);
    expect(ia.outputs).toHaveLength(1);
    expect(ia.outputs[0]).toMatchObject({ outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "amm-pools", tags: ["amm-pool"] } });
    expect(JSON.parse(ia.outputs[0]!.insertionRemittance.customInstructions)).toMatchObject({ id: TOKEN, op: "amm-pool", sym: "TST", dec: "0", keyID: "lp key", protocolID: [2, "3241645161d8"] });
    // Filed already (the basket lists it), or the pool moved on: nothing filed.
    internalized = [];
    connect({ pools: [{ outpoint: `${pd}.0`, satoshis: v.pool0.bsv, lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(), tags: ["amm-pool"], customInstructions: ci }], actions: [action(poolDeploy.outputs[0]!.lockingScript.toHex())] });
    await myPositions();
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "live", outpoint: `${swap1.id("hex")}_0`, current: wirePool(swap1.id("hex"), v.pool1), sats: 0, tokens: 0, swaps: 1 };
    connect({ pools: [], actions: [action(poolDeploy.outputs[0]!.lockingScript.toHex())] });
    await myPositions();
    expect(internalized).toEqual([]);
    connect({ pools: [], actions: [action()] });
    expect(await myPositions()).toEqual([]);
  });

  it("closePosition: the pool's current output and its BEEF by its LP key (GET /pools/beef?lp=<key>)", async () => {
    const pd = poolDeploy.id("hex");
    const ci = JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { validatorIdentity: SKEIN } });
    connect({ pools: [{ outpoint: `${pd}.0`, satoshis: v.pool0.bsv, lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(), tags: ["amm-pool"], customInstructions: ci }] });
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "live", outpoint: `${pd}_0`, current: wirePool(pd, v.pool0), sats: 0, tokens: 0, swaps: 0 };
    await myPositions();
    const n = inst.requests.length;
    // The fake wallet builds nothing: the close fails after the read, the read is what is checked.
    await expect(closePosition({ outpoint: `${pd}.0` })).rejects.toThrow();
    expect(since(n)).toEqual([`GET /@${TOKEN}/amm/pools/beef?lp=${v.lp}`]);
  });

  it("defaults (0.17.0): GET /defaults; root's {fn: defaults} to <app>/admin, swap's identity (D21: from the claim card) the recipient; bad values refused before anything is sent", async () => {
    expect(await defaults()).toEqual({});
    inst.defaults = { terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, market: { minCommissionBps: 1 } };
    expect(await defaults()).toEqual(inst.defaults);
    await expect(setDefaultMarket(1)).rejects.toThrow(/Connect a wallet/);
    connect();
    let changed = 0;
    const off = onDataChange(() => changed++);
    await setDefaultTerms({ lpBps: 30, validatorBps: 5, commissionBps: 25 });
    await clearDefaultTerms();
    await setDefaultMarket(1);
    await clearDefaultMarket();
    off();
    expect(changed).toBe(4);
    const msgs = inst.sent.map((s) => s.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array });
    expect(new Set(msgs.map((m) => `${Utils.toHex(Array.from(m.recipient))} ${m.messageBox}`))).toEqual(new Set([`${SKEIN} amm/admin`]));
    expect(inst.sent.every((x) => x.url === `${ORIGIN}/sendMessage`)).toBe(true);
    expect(msgs.map((m) => decode(m.body))).toEqual([
      { fn: "defaults", args: { terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 } } },
      { fn: "defaults", args: { terms: null } },
      { fn: "defaults", args: { market: { minCommissionBps: 1 } } },
      { fn: "defaults", args: { market: null } },
    ]);
    // The card read once, for all four (no signed read for an identity header).
    expect(inst.requests.filter((r) => r === "GET /.well-known/skein")).toHaveLength(1);
    for (const bad of [1.5, -1, 10_001]) await expect(setDefaultMarket(bad)).rejects.toThrow(/0 to 10000/);
    for (const bad of [{ lpBps: 30.5, validatorBps: 5, commissionBps: 0 }, { lpBps: -1, validatorBps: 5, commissionBps: 0 }, { lpBps: 30, validatorBps: 10_001, commissionBps: 0 }])
      await expect(setDefaultTerms(bad)).rejects.toThrow(/0 to 10000/);
    expect(inst.sent).toHaveLength(4);
  });

  it("discovery: GET /discovery; setDiscovery: root's {fn: discovery, args: {on}} to <app>/admin, the card's identity the recipient (the card read on load is used)", async () => {
    expect(await discoveryState()).toEqual({ on: false });
    inst.discovery = { on: true, since: 3 };
    expect(await discoveryState()).toEqual(inst.discovery);
    await expect(setDiscovery(true)).rejects.toThrow(/Connect a wallet/);
    connect();
    expect((await claimStatus()).identity).toBe(SKEIN);
    const n = inst.requests.length;
    let changed = 0;
    const off = onDataChange(() => changed++);
    await setDiscovery(true);
    await setDiscovery(false);
    off();
    expect(changed).toBe(2);
    expect(since(n)).toEqual(["POST /sendMessage", "POST /sendMessage"]);
    const msgs = inst.sent.map((s) => s.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array });
    expect(new Set(msgs.map((m) => `${Utils.toHex(Array.from(m.recipient))} ${m.messageBox}`))).toEqual(new Set([`${SKEIN} amm/admin`]));
    expect(msgs.map((m) => decode(m.body))).toEqual([
      { fn: "discovery", args: { on: true } },
      { fn: "discovery", args: { on: false } },
    ]);
  });

  it("tokenBaseOf: an enabled token's own instance, <origin>/@<tokenId>/amm; a token not enabled on the swap instance's list refused", async () => {
    expect(await tokenBaseOf(TOKEN)).toBe(`${ORIGIN}/@${TOKEN}/amm`);
    await expect(tokenBaseOf(OTHER)).rejects.toThrow(/not enabled on this exchange/);
    forgetReads();
    inst.enabled.push({ ...enabledRow(OTHER, "OTH", 2, 3), status: "disabled" });
    await expect(tokenBaseOf(OTHER)).rejects.toThrow(/not enabled on this exchange/);
  });

  it("validatorTerms (D21): GET /terms, plain — this skein's validator, its fees (read-only); none set: {none: true}, which the pages show as the no-terms text", async () => {
    expect(await validatorTerms(TOKEN)).toEqual({ validator: { identityKey: SKEIN, live: true }, isThisExchange: true, fees: { lpBps: 30, validatorBps: 5, commissionBps: 0 } });
    expect(inst.calls).toEqual([]);
    expect(inst.requests.at(-1)).toBe(`GET /@${TOKEN}/amm/terms`);
    inst.terms = null;
    const t = await validatorTerms(TOKEN);
    expect(t).toEqual({ none: true });
    expect(hasTerms(t)).toBe(false);
    expect(NO_TERMS_TEXT).toBe("This exchange validates nothing: no terms are set.");
  });

  it("deployPosition (0.12.0): from the module's held outputs; refused without the token, or short of the deposit", async () => {
    await expect(deployPosition({ tokenId: TOKEN, tokens: 1n, sats: 1n })).rejects.toThrow(/Connect a wallet/);
    const heldOut = { outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() };
    connect({});
    await expect(deployPosition({ tokenId: TOKEN, tokens: 0n, sats: 1n })).rejects.toThrow(/more than 0/);
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/fewer than 5 /);
    connect({ held: [heldOut] });
    await expect(deployPosition({ tokenId: TOKEN, tokens: 10_000_001n, sats: 1_000n })).rejects.toThrow(/fewer than 10000001 /);
    connect({ held: [{ ...heldOut, spendable: false }] });
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/fewer than 5 /);
    expect(inst.calls.filter((c) => c.fn === "amm.pool.affirm")).toEqual([]);
    inst.terms = null;
    connect({ held: [heldOut] });
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/no validator here/);
  });

  it("myTokens (0.27.0): the module's assets (p color assets), each balance the SUM of its held value outputs there; what the swap basket holds; on this exchange (registered) or not", async () => {
    const heldOut = { outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() };
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const more = { outpoint: `${"ee".repeat(32)}.0`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(TOKEN, 7n, key) };
    const other = [1, 2].map((n) => ({ outpoint: `${"ef".repeat(32)}.${n}`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(OTHER, BigInt(n * 100), key) }));
    const swapRow = { outpoint: `${poolDeploy.id("hex")}.1`, satoshis: 1, lockingScript: poolDeploy.outputs[1]!.lockingScript.toHex(), customInstructions: JSON.stringify({ assetId: TOKEN, amount: "50000", protocolID: [2, "amm swap"], keyID: "amm-swap-1", counterparty: "self" }) };
    connect({ held: [heldOut, more, ...other], balances: { [`p color balance ${DEPLOY}v0`]: "9999999", [`p color balance ${"cd".repeat(32)}v0`]: "1" }, swaps: [swapRow] });
    walletReads = [];
    const ts = await myTokens();
    expect(walletReads.filter((b) => b.startsWith("p color balance"))).toEqual([]);
    expect(walletReads).toContain("p color assets");
    const deployAmount = decodeOneColor(tokenDeploy.outputs[0]!.lockingScript.toBinary())!.amount;
    expect(ts).toHaveLength(2);
    expect(ts.find((t) => t.tokenId === TOKEN)).toMatchObject({ sym: "TST", dec: 0, balance: BigInt(deployAmount) + 7n, outputs: 2, onExchange: true, inSwaps: 50_000n });
    expect(ts.find((t) => t.tokenId === OTHER)).toMatchObject({ balance: 300n, outputs: 2, inSwaps: 0n, onExchange: false });
    connect({ swaps: [swapRow] });
    expect(await myTokens()).toEqual([expect.objectContaining({ tokenId: TOKEN, balance: 0n, outputs: 0, inSwaps: 50_000n })]);
  });

  it("myTokens (0.29.6): the sats staged in amm-swap for a token's legs — beside its tokens, and a token with ONLY sats staged still listed", async () => {
    const satsRow = (n: number, satoshis: number, assetId: string) => ({ outpoint: `${"5a".repeat(32)}.${n}`, satoshis, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(), customInstructions: JSON.stringify({ sats: true, assetId, protocolID: [2, "amm swap"], keyID: `amm-swap-${n}:sats`, counterparty: "self" }) });
    const swapRow = { outpoint: `${poolDeploy.id("hex")}.1`, satoshis: 1, lockingScript: poolDeploy.outputs[1]!.lockingScript.toHex(), customInstructions: JSON.stringify({ assetId: TOKEN, amount: "50000", protocolID: [2, "amm swap"], keyID: "amm-swap-1", counterparty: "self" }) };
    connect({ swaps: [swapRow, satsRow(0, 4_000, TOKEN), satsRow(1, 1_000, TOKEN)] });
    expect(await myTokens()).toEqual([expect.objectContaining({ tokenId: TOKEN, balance: 0n, inSwaps: 50_000n, swapSats: 5_000 })]);
    connect({ swaps: [satsRow(2, 2_500, TOKEN)] });
    expect(await myTokens()).toEqual([expect.objectContaining({ tokenId: TOKEN, sym: "TST", balance: 0n, outputs: 0, inSwaps: 0n, swapSats: 2_500 })]);
  });

  it("myTokens (D17): the list once, then ONE discovery GET /tokens?ids= for every held token the list lacks; a token not on discovery keeps its own metadata", async () => {
    inst.enabled = [];
    const B = `${"b1".repeat(32)}_0`;
    inst.discoveryList = [{ tokenId: TOKEN, topic: TOPIC, sym: "DSC", dec: 1, iconUrl: `${TOKEN}/icon` }];
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const heldOut = { outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() };
    const b = { outpoint: `${"ee".repeat(32)}.0`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(B, 5n, key) };
    connect({ held: [heldOut, b] });
    const ts = await myTokens();
    expect(ts.find((t) => t.tokenId === TOKEN)).toMatchObject({ sym: "DSC", dec: 1, icon: `${ORIGIN}/@discovery/1color/${TOKEN}/icon`, onExchange: false });
    expect(ts.find((t) => t.tokenId === B)).toMatchObject({ sym: B.slice(0, 8), onExchange: false });
    const reads = since(0);
    expect(reads[0]).toBe("GET /amm/tokens");
    expect(reads.slice(1).map((r) => r.split("?")[0])).toEqual(["GET /@discovery/1color/tokens"]);
    expect(new Set(reads[1]!.split("ids=")[1]!.split(","))).toEqual(new Set([TOKEN, B]));
    noLookup();
  });

  it("the silent pass (D18): per token with staged rows ONE /spends?outpoint= over their pools; nothing staged, no read", async () => {
    connect();
    expect(await settleSwaps()).toEqual([]);
    expect(since(0)).toEqual([]);
    const p1 = `${"a1".repeat(32)}.0`;
    const p2 = `${"a2".repeat(32)}.1`;
    const sats = (pool: string) => ({ outpoint: `${"5a".repeat(32)}.0`, satoshis: 10, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(), customInstructions: JSON.stringify({ sats: true, assetId: TOKEN, protocolID: [2, "amm swap"], keyID: `amm-swap-${pool}:sats`, counterparty: "self" }) });
    connect({ swaps: [sats(p1), sats(p2)] });
    expect(await settleSwaps()).toEqual([]);
    expect(since(0)).toEqual([`GET /@${TOKEN}/amm/spends?outpoint=${p1},${p2}`]);
  });

  it("enableToken / disableToken: root's {fn: enable, args: {tokenId, beef}} to swap's <app>/admin, the deploy's Atomic BEEF from the wallet's module basket, else from discovery (GET /@discovery/1color/<token>/deploy), else refused naming both; disable {tokenId}; a stopped token enabled again without a BEEF; the list read again after each", async () => {
    connect();
    await expect(enableToken(OTHER)).rejects.toThrow(`no deploy for ${OTHER}: not on discovery and not in this wallet`);
    expect(inst.sent).toHaveLength(0);
    const full = atomic(tokenDeploy, [fund]);
    const beefOf = (m: Record<string, unknown>) => (decode((m.message as { body: Uint8Array }).body) as { args: { beef: Uint8Array } }).args.beef;
    const basketBeef = new Beef();
    basketBeef.mergeRawTx(fund.toBinary());
    basketBeef.mergeRawTx(tokenDeploy.toBinary());
    connect({ deploy: { basket: `p color ${DEPLOY}v0`, outpoint: `${DEPLOY}.0`, beef: basketBeef.toBinary() } });
    inst.discoveryList = [];
    const n = inst.requests.length;
    expect(await enableToken(TOKEN)).toEqual({ beefFrom: "wallet" });
    let msg = inst.sent.at(-1)!.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array };
    expect(Utils.toHex(Array.from(msg.recipient))).toBe(SKEIN);
    expect(msg.messageBox).toBe("amm/admin");
    const body = decode(msg.body) as { fn: string; args: { tokenId: string; beef: Uint8Array } };
    expect(body.fn).toBe("enable");
    expect(body.args.tokenId).toBe(TOKEN);
    expect(Transaction.fromAtomicBEEF(Array.from(body.args.beef)).id("hex")).toBe(DEPLOY);
    expect(since(n).filter((r) => r.includes("@discovery"))).toEqual([]); // the wallet had it: discovery not asked
    connect();
    inst.discoveryDeploys[TOKEN] = full;
    expect(await enableToken(TOKEN)).toEqual({ beefFrom: "discovery" });
    expect(Array.from(beefOf(inst.sent.at(-1)!.body))).toEqual(full);
    expect(inst.requests).toContain(`GET /@discovery/1color/${TOKEN}/deploy`);
    await disableToken(TOKEN);
    msg = inst.sent.at(-1)!.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array };
    expect(decode(msg.body)).toEqual({ fn: "disable", args: { tokenId: TOKEN } });
    inst.enabled[0] = { ...inst.enabled[0], status: "disabled" };
    await enableToken(TOKEN);
    expect(decode((inst.sent.at(-1)!.body.message as { body: Uint8Array }).body)).toEqual({ fn: "enable", args: { tokenId: TOKEN } });
    noLookup();
  });

  it("deployBeef: the wallet's module basket first, else discovery (P16), each with the deploy's metadata; neither: refused naming both", async () => {
    const full = atomic(tokenDeploy, [fund]);
    const basketBeef = new Beef();
    basketBeef.mergeRawTx(fund.toBinary());
    basketBeef.mergeRawTx(tokenDeploy.toBinary());
    const wallet = fakeWallet({ deploy: { basket: `p color ${DEPLOY}v0`, outpoint: `${DEPLOY}.0`, beef: basketBeef.toBinary() } });
    const w = await deployBeef(TOKEN, wallet);
    expect(w.from).toBe("wallet");
    expect(Transaction.fromAtomicBEEF(w.beef).id("hex")).toBe(DEPLOY);
    expect(w.meta).toEqual({});
    expect(since(0)).toEqual([]);
    inst.discoveryList = [];
    inst.discoveryDeploys[TOKEN] = full;
    const d = await deployBeef(TOKEN, fakeWallet());
    expect(d).toEqual({ from: "discovery", beef: full, meta: {} });
    expect(since(0)).toEqual([`GET /@discovery/1color/${TOKEN}/deploy`]);
    expect((await deployBeef(TOKEN)).from).toBe("discovery");
    await expect(deployBeef(OTHER, fakeWallet())).rejects.toThrow(`no deploy for ${OTHER}: not on discovery and not in this wallet`);
    await expect(deployBeef("nope")).rejects.toThrow(/not a token id/);
  });

  it("tokensToEnable (D20): discovery's list (A, B) ∪ the wallet's held assets (B, C), minus the swap instance's list (A) → B then C; C's metadata from ONE ?ids= read (not listed: its short id); discovery off → the wallet's only", async () => {
    const A = TOKEN;
    const B = `${"b1".repeat(32)}_0`;
    const C = `${"c1".repeat(32)}_0`;
    inst.enabled = [enabledRow(A, "TST", 0, 2)];
    inst.discoveryList = [
      { tokenId: A, topic: `tm_color_${A}`, sym: "TST", dec: 0 },
      { tokenId: B, topic: `tm_color_${B}`, sym: "BBB", dec: 2, iconUrl: `${B}/icon` },
    ];
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const heldOf = (tokenId: string, n: number) => ({ outpoint: `${"ee".repeat(32)}.${n}`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(tokenId, 5n, key) });
    connect({ held: [heldOf(B, 0), heldOf(C, 1), heldOf(C, 2)] });
    expect(await tokensToEnable()).toEqual([
      { tokenId: B, sym: "BBB", icon: `${ORIGIN}/@discovery/1color/${B}/icon`, onDiscovery: true, inWallet: true },
      { tokenId: C, onDiscovery: false, inWallet: true },
    ]);
    expect(since(0)).toEqual(["GET /@discovery/1color/tokens?limit=100&skip=0", "GET /amm/tokens", `GET /@discovery/1color/tokens?ids=${C}`]);
    inst.discoveryList = null;
    expect((await tokensToEnable()).map((t) => [t.tokenId, t.onDiscovery, t.inWallet])).toEqual([
      [B, false, true],
      [C, false, true],
    ]);
    noLookup();
  });

  it("tokensToEnable: a wallet-only token not on discovery takes its metadata from the deploy in the wallet's module basket", async () => {
    inst.enabled = [];
    inst.discoveryList = null;
    const key = PrivateKey.fromRandom().toPublicKey();
    const deployTx = new Transaction();
    deployTx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    const lock = OneColor.deployValue(1_000n, { lock: key.toAddress(), payload: { sym: "CCC", dec: 3 } }).lock();
    deployTx.addOutput({ satoshis: 1, lockingScript: lock });
    const C = `${deployTx.id("hex")}_0`;
    const basketBeef = new Beef();
    basketBeef.mergeRawTx(fund.toBinary());
    basketBeef.mergeRawTx(deployTx.toBinary());
    connect({
      held: [{ outpoint: `${deployTx.id("hex")}.0`, satoshis: 1, spendable: true, lockingScript: lock.toHex() }],
      deploy: { basket: `p color ${deployTx.id("hex")}v0`, outpoint: `${deployTx.id("hex")}.0`, beef: basketBeef.toBinary() },
    });
    expect(await tokensToEnable()).toEqual([{ tokenId: C, sym: "CCC", onDiscovery: false, inWallet: true }]);
    noLookup();
  });

  it("registeredTokens: the swap instance's enable list, enabled and disabled", async () => {
    inst.enabled.push({ tokenId: OTHER, topic: `tm_color_${OTHER}`, sym: "OTH", dec: 2, status: "disabled", since: 1 });
    expect(await registeredTokens()).toEqual([
      { tokenId: TOKEN, sym: "TST", status: "enabled" },
      { tokenId: OTHER, sym: "OTH", status: "disabled" },
    ]);
  });

  // isRoot (0.26.0) is real: test/claim.test.tsx (the host's /skeins?key=).
  it("isRoot: no key, no root", async () => {
    expect(await isRoot(null)).toBe(false);
  });

  it("topic and lookup names are derived from the assetId (BRC-207: tm_color_<txid>_<vout>, `_0` included)", () => {
    const t = "cd".repeat(32);
    expect(topicOf(`${t}_0`)).toBe(`tm_color_${t}_0`);
    expect(lookupOf(`${t}_0`)).toBe(`ls_color_${t}_0`);
    expect(topicOf(`${t}_2`)).toBe(`tm_color_${t}_2`);
    expect(ammLookupOf(`${t}_0`)).toBe(`ls_amm_${t}_0`);
    expect(ammLookupOf(t)).toBe(`ls_amm_${t}_0`);
    expect(ammLookupOf(`${t.toUpperCase()}.2`)).toBe(`ls_amm_${t}_2`);
  });
});

/**
 * The requests each page makes (0.34.0), measured over the fake exchange: the data functions and
 * the streams each page's hooks run (the wallet's own calls aside). The app shell's claim reads
 * (`/.well-known/skein`, `/amm/admin`, `/skeins?key=`, P17) are the same on every page and counted
 * apart.
 */
describe("requests per page (0.34.0)", () => {
  /** A connected wallet holding the token (on the exchange) and nothing staged. */
  const heldWallet = () => connect({ held: [{ outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() }] });

  it("Swap: load = the token list + the host-wide pools stream + the token's pools stream; a quote = 0; a swap = ONE /pools/beef + the relay's /call per leg; after the swap = 0 (the stream carries the new pool)", async () => {
    heldWallet();
    const offs: (() => void)[] = [];
    let h: PoolsAnswer | null = null;
    // Load: App's useHostedTokens (the list, P1 stream), Swap's useTokenPools (P2 stream), useMyTokens, useWalletSats.
    await registeredTokens();
    offs.push(watchHostedPools(() => {}));
    offs.push(watchTokenPools(TOKEN, (a) => (h = a)));
    await myTokens();
    await walletSats();
    await new Promise((r) => setTimeout(r, 10));
    const load = since(0);
    expect(load).toEqual(["GET /amm/tokens", `GET /amm/pools`, `GET /@${TOKEN}/amm/pools`]);
    expect(streams).toEqual([`${BASE}/pools`, `${ORIGIN}/@${TOKEN}/amm/pools`]);
    const n = inst.requests.length;
    const q = quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, h ?? parsePools({}), META);
    expect(since(n)).toEqual([]);
    expect(q.legs).toHaveLength(1);
    // A swap: ONE /pools/beef (the executeSwap tests above), then each leg's relay /call (test/swap.test.ts).
    // After it: the pages' data reloads (onDataChange) read the wallet and the cached list; the pools come on the stream.
    await myTokens();
    await walletSats();
    expect(since(n)).toEqual([]);
    offs.forEach((f) => f());
  });

  it("Your tokens: load = the token list + (only for held tokens the list lacks) ONE ?ids= + (only with staged rows) ONE /spends per token", async () => {
    heldWallet();
    await myTokens();
    await settleSwaps();
    expect(since(0)).toEqual(["GET /amm/tokens"]);
  });

  it("Positions: load = the token list + per token ONE /positions and ONE plain /pools (0.34.1: the validators beating, for the live mark); the deploy form's terms ONE /terms", async () => {
    const pd = poolDeploy.id("hex");
    const ci = JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { validatorIdentity: SKEIN } });
    connect({ held: [{ outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() }], pools: [{ outpoint: `${pd}.0`, satoshis: v.pool0.bsv, lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(), tags: ["amm-pool"], customInstructions: ci }] });
    inst.lpPools[v.lp] = { lpPubKey: v.lp, status: "live", outpoint: `${pd}_0`, current: wirePool(pd, v.pool0), sats: 0, tokens: 0, swaps: 0 };
    await myPositions();
    await myTokens();
    await validatorTerms(TOKEN);
    expect(since(0)).toEqual(["GET /amm/tokens", `GET /@${TOKEN}/amm/positions?lp=${v.lp}`, `GET /@${TOKEN}/amm/pools`, `GET /@${TOKEN}/amm/terms`]);
    expect(streams).toEqual([]);
  });

  it("Settings: load = the token list + defaults + discovery state + the claim card (card + admin) + discovery's list pages + (only for wallet-only tokens) ONE ?ids=", async () => {
    heldWallet();
    inst.discoveryList = [{ tokenId: TOKEN, topic: TOPIC, sym: "TST", dec: 0 }];
    await Promise.all([registeredTokens(), defaults(), discoveryState(), claimStatus(), tokensToEnable()]);
    expect(new Set(since(0))).toEqual(new Set(["GET /amm/tokens", "GET /amm/defaults", "GET /amm/discovery", "GET /.well-known/skein", "GET /amm/admin", "GET /@discovery/1color/tokens?limit=100&skip=0"]));
    expect(since(0)).toHaveLength(6);
  });
});

describe("formats and routes", () => {
  it("formats amounts, sats, prices and changes", () => {
    expect(fmtAmount(120_450n, 2)).toBe("1,204.5");
    expect(fmtAmount(5_000n, 0)).toBe("5,000");
    expect(compactSats(1_240_000n)).toBe("1.24M");
    expect(compactSats(480_000n)).toBe("480k");
    expect(compactSats(80_000n)).toBe("80,000");
    expect(fmtPrice(1250)).toBe("1,250");
    expect(fmtPrice(411.96)).toBe("412.0");
    expect(fmtChange(0.018)).toBe("+1.8%");
    expect(fmtChange(-0.004)).toBe("−0.4%");
    expect(fmtChange(0)).toBe("0.0%");
    expect(parseInput("250,000", 0)).toBe(250_000n);
    expect(parseInput("1.5", 0)).toBeNull();
  });

  it("hash routes round-trip", () => {
    const id = `${"ef".repeat(32)}_0`;
    expect(parseRoute(routeHref({ page: "swap", tokenId: id }))).toEqual({ page: "swap", tokenId: id });
    expect(parseRoute("#/liquidity")).toEqual({ page: "liquidity" });
    expect(parseRoute("")).toEqual({ page: "landing" });
    expect(parseRoute("#/nope")).toEqual({ page: "landing" });
  });
});

describe("connectAction (0.9.1: the connect dialog listed nothing)", () => {
  it("auto-detects the wallet when no providers are configured", async () => {
    let opened = 0, connected = 0;
    expect(connectAction(0, () => { opened++; }, async () => { connected++; })).toBe("auto");
    expect(opened).toBe(0); expect(connected).toBe(1);
  });
  it("opens the dialog when providers are configured", () => {
    let opened = 0, connected = 0;
    expect(connectAction(2, () => { opened++; }, async () => { connected++; })).toBe("dialog");
    expect(opened).toBe(1); expect(connected).toBe(0);
  });
  it("swallows a failed auto-connect (the wallet shows its own error)", () => {
    expect(connectAction(0, () => {}, async () => { throw new Error("no wallet"); })).toBe("auto");
  });
});
