/**
 * src/data/exchange.ts, wired (skein-amm 0.9.0; 0.17.0: a config instance and
 * one instance per token): each function against fake instances (one route
 * table: the config instance's /tokens, /defaults and a token
 * instance's liveness reads, /lookup, /spends, /call, /sendMessage, at
 * `/@<tokenId>/amm/…`) and a fake wallet, over the Go fixtures
 * (src/fixtures/vectors.zig's copy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { ColorPlan } from "@bsv/color-permission-module";
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
  hasTerms,
  instanceIdentity,
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
  isRoot,
  lookupOf,
  ammLookupOf,
  myPositions,
  myTokens,
  onDataChange,
  quoteSwap,
  registeredTokens,
  setExchangeContext,
  subscribePrices,
  swapPools,
  marketMinimum,
  atMarketMinimum,
  belowMinimumText,
  tokenPools,
  topicOf,
  validatorTerms,
  walletSats,
} from "../src/data/exchange";
import { REFRESH_MS } from "../src/lib/config";
import { PendingPayoutStore } from "../src/wallet/pendingPayouts";
import { compactSats, fmtAmount, fmtChange, fmtPrice, parseInput } from "../src/ox/format";
import { parseRoute, routeHref } from "../src/ox/route";
import { PEER } from "./liveRead";
import v from "./fixtures/amm-topic-vectors.json";

const OUTPOINT = /^[0-9a-f]{64}\.\d+$/;
const ORIGIN = "http://alice.localhost:8300";
/** The config instance's AMM base (the pages'). */
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
const V2 = "03" + "22".repeat(32);
const SKEIN = v.identity;

const b64 = (b: Uint8Array) => Utils.toBase64(Array.from(b));
const beat = (sender: string, at: number, body: unknown) => ({ sender, at, from: PEER, body: b64(encode(body, { cde: true })) });
function atomic(tx: Transaction, ancestors: Transaction[]): number[] {
  const b = new Beef();
  for (const a of ancestors) b.mergeRawTx(a.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinaryAtomic(tx.id("hex"));
}
const wirePool = (txid: string, p: { bsv: number; tokens: number }) => ({ outpoint: `${txid}_0`, bsvReserve: p.bsv, tokenReserve: p.tokens, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: SKEIN });

/** The instance: a route table over plain fetch and the wallet's signed fetch alike. */
interface Instance {
  /** The config instance's enable list (0.17.0, `/tokens`). */
  enabled: Record<string, unknown>[];
  /** The config instance's defaults (`/defaults`). */
  defaults: Record<string, unknown>;
  /** The config instance's discovery record (0.18.0, `/discovery`). */
  discovery: Record<string, unknown>;
  topics: Record<string, unknown>;
  tokens: unknown[];
  live: Record<string, unknown[]>;
  pools: Record<string, unknown[]>;
  spends: Record<string, unknown>;
  /** A token instance's `ls_color_<tokenId>` BRC-207 answers (0.20.1), by outpoint `<txid>.<vout>`. */
  color: Record<string, unknown>;
  /** The host root's `ls_color` BRC-207 `color-admission` answers (the discovery instance, 0.20.1), by outpoint. */
  deploys: Record<string, unknown>;
  /** The discovery instance's token list (`/@discovery/1color/color/tokens`, 2026-10-31); null: discovery off (404). */
  discoveryList: unknown[] | null;
  /** Every lookup asked: its URL and body. */
  lookups: { url: string; service: string; query: Record<string, unknown> }[];
  sent: { url: string; body: Record<string, unknown> }[];
  calls: { fn: string; args: unknown }[];
  /** amm.pool.terms's answer; null: no terms set (0.15.0: "no validator here"). */
  terms: Record<string, unknown> | null;
  /** amm.swap.terms's minCommissionBps (0.16.0: the market record; unset 0). */
  minCommissionBps: number;
}

const enabledRow = (tokenId: string, sym: string, dec: number, since: number) => ({ tokenId, topic: `tm_color_${tokenId}`, sym, dec, status: "enabled", since });

function instance(): Instance {
  return {
    enabled: [enabledRow(TOKEN, "TST", 0, 2)],
    defaults: {},
    discovery: { on: false },
    topics: { [TOPIC]: { name: "1Color" }, tm_color: { name: "1Color discovery" } },
    tokens: [
      { tokenId: TOKEN, topic: TOPIC, sym: "TST", dec: 0, txid: DEPLOY, vout: 0 },
      { tokenId: OTHER, topic: `tm_color_${OTHER}`, sym: "OTH", dec: 2, txid: OTHER.slice(0, 64), vout: 0 },
    ],
    live: {
      // ls_amm_<TOKEN>'s beats (0.21.0): this skein's own (its pools of the token), and another skein naming a validator that is not live.
      [`ls_amm_${TOKEN}-live`]: [
        beat(SKEIN, 2_000, { tokens: { [TOKEN]: { [SKEIN]: { sats: 1_000_000, tokens: 5_000_000, pools: 1 } } } }),
        beat(ME, 1_000, { tokens: { [TOKEN]: { [SKEIN]: { sats: 1, tokens: 1, pools: 1 }, [V2]: { sats: 600, tokens: 300, pools: 1 } } } }),
      ],
      [`${TOPIC}-live`]: [{ sender: SKEIN, at: Date.now(), from: PEER, body: "" }],
    },
    pools: { [TOKEN]: [wirePool(poolDeploy.id("hex"), v.pool0)] },
    spends: {},
    color: {},
    deploys: {},
    discoveryList: null,
    lookups: [],
    sent: [],
    calls: [],
    minCommissionBps: 0,
    terms: { validator: { "/": { bytes: Utils.toBase64(Utils.toArray(SKEIN, "hex")).replace(/=+$/, "") } }, peerId: PEER, lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 0 },
  };
}

let inst: Instance;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A signed answer of the instance: BRC-104's header names the key it is signed by. */
const signed = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-bsv-auth-identity-key": SKEIN } });

async function route(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> {
  const u = new URL(url);
  if (u.pathname === "/@discovery/1color/color/tokens") return inst.discoveryList ? json(inst.discoveryList) : json({ error: "no instance discovery" }, 404);
  const path = u.pathname.replace(/^\/@[^/]+/, "").replace(/^\/amm/, "");
  if (path === "/tokens") return signed(inst.enabled);
  if (path === "/defaults") return json(inst.defaults);
  if (path === "/discovery") return json(inst.discovery);
  if (path === "/listTopicManagers") return json(inst.topics);
  if (path === "/color/tokens") return json(inst.tokens);
  if (path.startsWith("/.live/")) {
    const t = decodeURIComponent(path.slice(7));
    return t in inst.live ? json(inst.live[t]) : json({}, 404);
  }
  if (path === "/spends") return json(inst.spends[u.searchParams.get("outpoint")!] ?? { outpoint: u.searchParams.get("outpoint"), hops: 0, closed: false });
  if (path === "/lookup") {
    const q = JSON.parse(String(init!.body)) as { service: string; query: Record<string, unknown> };
    inst.lookups.push({ url, ...q });
    const atHostRoot = u.pathname === "/lookup";
    const empty = { type: "output-list", outputs: [] };
    // 0.20.0: the discovery lookup `ls_color` only at the host root; a token instance has `ls_color_<tokenId>`, no `ls_color`.
    const op = Array.isArray(q.query.outpoints) ? String(q.query.outpoints[0]) : "";
    if (atHostRoot) return q.service === "ls_color" && q.query.topic === "tm_color" && q.query.type === "color-admission" ? json(inst.deploys[op] ?? empty) : json({ status: "error", message: "Lookup service not supported" }, 400);
    // 0.21.0: the AMM lookup is `ls_amm_<tokenId>`; a plain `ls_amm` is no service here.
    const ammService = q.service === `ls_amm_${String(q.query.tokenId)}`;
    if (ammService && q.query.beef) return json({ type: "output-list", outputs: [{ beef: atomic(poolDeploy, [fund, tokenDeploy]), outputIndex: 0 }] });
    if (ammService) return json({ type: "freeform", result: inst.pools[String(q.query.tokenId)] ?? [] });
    if (q.service === `ls_color_${TOKEN}` && q.query.topic === TOPIC && q.query.assetId === TOKEN && q.query.version === 1) return json(inst.color[op] ?? empty);
    return json({ status: "error", message: "Lookup service not supported" }, 400);
  }
  if (path === "/call") {
    const b = JSON.parse(String(init!.body)) as { fn: string; args: unknown };
    inst.calls.push(b);
    if (b.fn === "amm.pool.terms") return inst.terms ? signed({ fn: b.fn, result: inst.terms }) : signed({ fn: b.fn, error: { code: "failed", message: "no validator here" } }, 500);
    if (b.fn === "amm.swap.terms") return signed({ fn: b.fn, result: { commissionPkh: null, minCommissionBps: inst.minCommissionBps } });
  }
  if (path === "/sendMessage") {
    inst.sent.push({ url, body: decode(init!.body as Uint8Array) as Record<string, unknown> });
    return new Response(encode({ status: "success", id: `msg${inst.sent.length}` }) as BodyInit, { status: 200 });
  }
  return json({ error: `no route ${url}` }, 404);
}

/**
 * A fake wallet: its position rows (`amm-pools`), the BRC-207 module's views
 * (`p color assets`: `held`; `p color balance <tag>`: `balances`), the
 * active swap basket (`amm-swap`), a default basket, its identity.
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
/** Every basket the fake wallet was asked to list, in order (0.27.0: myTokens reads no `p color balance`). */
let walletReads: string[] = [];
function fakeWallet(rows: WalletRows = {}, sats: number[] = [1_000, 2_500]): WalletInterface {
  return {
    async listOutputs(args: { basket: string; tags?: string[] }) {
      walletReads.push(args.basket);
      if (args.basket === "default") return { totalOutputs: sats.length, outputs: sats.map((s, i) => ({ outpoint: `${"aa".repeat(32)}.${i}`, satoshis: s, spendable: true })) };
      if (args.basket === "amm-pools") return { totalOutputs: rows.pools?.length ?? 0, outputs: rows.pools ?? [] };
      if (args.basket === "amm-swap") return { totalOutputs: rows.swaps?.length ?? 0, outputs: rows.swaps ?? [] };
      if (args.basket === "p color assets") return { totalOutputs: rows.held?.length ?? 0, outputs: rows.held ?? [] };
      if (args.basket.startsWith("p color balance ")) return { totalOutputs: rows.balances?.[args.basket] ?? "0", outputs: [] };
      // 0.17.0: a deploy output in its token's module basket (enableToken reads its BEEF there).
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
  } as unknown as WalletInterface;
}

const af = { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => route(url, init) };

beforeEach(() => {
  inst = instance();
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => route(url, init as never));
  setExchangeContext({ base: BASE, wallet: null, signedFor: null, identityKey: null, payouts: new PendingPayoutStore(null) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const connect = (rows?: WalletRows) => setExchangeContext({ wallet: fakeWallet(rows), signedFor: () => af as never, identityKey: ME });

describe("exchange.ts, wired", () => {
  it("hostedTokens: the registered 1Color tokens, priced from ls_amm_<assetId>'s beats over the live validators (each validator's own report first); a token no beat reports, from this skein's listing", async () => {
    inst.enabled.push(enabledRow(OTHER, "OTH", 2, 1));
    inst.pools[OTHER] = [];
    const ts = await hostedTokens();
    expect(ts.map((t) => [t.tokenId, t.sym, t.dec])).toEqual([
      [TOKEN, "TST", 0],
      [OTHER, "OTH", 2],
    ]);
    const t = ts[0]!;
    // SKEIN's own report (1,000,000 / 5,000,000), not ME's of SKEIN; V2 is no live sender: left out.
    expect(t.reserves).toEqual({ sats: 1_000_000n, tokens: 5_000_000n });
    expect(t.pools).toBe(1);
    expect(t.marginalPrice).toBeCloseTo(0.2, 9);
    expect(t.depth!.sats).toBeGreaterThan(0n);
    // No beat, no listed pool: no price.
    expect(ts[1]).toMatchObject({ marginalPrice: null, pools: 0, reserves: { sats: 0n, tokens: 0n } });
  });

  it("subscribePrices: polls every REFRESH_MS and after an action (onDataChange); unsubscribed, it stops", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const off = subscribePrices((u) => seen.push(`${u.tokenId}:${u.reserves.sats}`));
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(seen).toEqual([`${TOKEN}:1000000`]);
    inst.live[`ls_amm_${TOKEN}-live`] = [beat(SKEIN, 3_000, { tokens: { [TOKEN]: { [SKEIN]: { sats: 2_000_000, tokens: 5_000_000, pools: 1 } } } })];
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(seen.at(-1)).toBe(`${TOKEN}:2000000`);
    off();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(seen).toHaveLength(2);
    const changes: number[] = [];
    const off2 = onDataChange(() => changes.push(1));
    off2();
  });

  it("tokenPools: this skein's listed pools, outpoints dotted, each validator live or not", async () => {
    const ps = await tokenPools(TOKEN);
    expect(ps).toEqual([{ outpoint: `${poolDeploy.id("hex")}.0`, tokenId: TOKEN, sats: BigInt(v.pool0.bsv), tokens: BigInt(v.pool0.tokens), validator: { identityKey: SKEIN, live: true } }]);
    inst.live[`${TOPIC}-live`] = [];
    expect((await tokenPools(TOKEN))[0]!.validator.live).toBe(false);
  });

  it("quoteSwap: the matching engine's plan over the live pools; a buy pays above marginal, a sell gets below; no live validator: refused", async () => {
    const buy = await quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false });
    expect(buy.legs).toHaveLength(1);
    expect(buy.legs[0]!.poolOutpoint).toMatch(OUTPOINT);
    expect(buy.legs[0]!.amountIn).toBe(20_000n);
    expect(buy.amountOut).toBe(BigInt(v.swapBsvInTokensOut));
    expect(buy.minAmountOut).toBeLessThanOrEqual(buy.amountOut);
    expect(buy.effectivePrice).toBeGreaterThan(buy.marginalPrice);
    expect(buy.fees).toEqual({ lpBps: 30, validatorBps: 5, commissionBps: 10 });
    const sell = await quoteSwap({ tokenId: TOKEN, side: "sell", amountIn: 50_000n, maxSlippageBps: 100, allowPartial: false });
    expect(sell.effectivePrice).toBeLessThan(sell.marginalPrice);
    inst.live[`${TOPIC}-live`] = [];
    await expect(quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false })).rejects.toThrow(/validator/);
  });

  it("executeSwap: needs a wallet; a planned pool spent since the quote stops it (no partial fills)", async () => {
    const q = await quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false });
    await expect(executeSwap(q)).rejects.toThrow(/Connect a wallet/);
    connect();
    inst.pools[TOKEN] = [];
    await expect(executeSwap(q)).rejects.toThrow(/spent since the quote/);
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
    const q = await quoteSwap({ tokenId: TOKEN, side: "sell", amountIn: 50_000n, maxSlippageBps: 100, allowPartial: false });
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
    // The swap basket holds an output of exactly the leg's amount: the sats only, by a plain send (no p color plan).
    const held = new Transaction();
    held.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    held.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenP2pkhScript(TOKEN, 50_000n, swapKey.toPublicKey().toString())) });
    swapBeef.mergeTransaction(held);
    swapRows.push({ outpoint: `${held.id("hex")}.0`, satoshis: 1, spendable: true, lockingScript: held.outputs[0]!.lockingScript.toHex(), customInstructions: JSON.stringify({ assetId: TOKEN, amount: "50000", protocolID: [2, "amm swap"], keyID: "amm-swap-x", counterparty: "self" }) });
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
  });

  it("executeSwap, sats in (0.29.0): the leg's sats (amount in + the token payout's sat + the fee) staged in amm-swap by ONE plain createAction (no p color labels), then the leg; no funding action", async () => {
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
    const q = await quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false });
    expect(q.legs.map((l) => l.amountIn)).toEqual([20_000n]);
    await executeSwap(q);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.labels).toEqual(["amm-swap"]);
    expect(ColorPlan.fromLabels(sent[0]!.labels)).toBeUndefined();
    expect(sent[0]!.outputs).toHaveLength(1);
    const o = sent[0]!.outputs![0]!;
    expect(o.basket).toBe("amm-swap");
    expect(JSON.parse(o.customInstructions!)).toMatchObject({ sats: true, protocolID: [2, "amm swap"], counterparty: "self" });
    // Amount in + 1 sat for the token payout, plus the fee at the rate (> 0).
    expect(o.satoshis).toBeGreaterThan(20_001);
    expect(o.satoshis).toBeLessThan(20_001 + 2_000);
  });

  it("walletSats: the default basket's spendable sats", async () => {
    connect();
    expect(await walletSats()).toBe(3_500n);
  });

  it("myPositions: the wallet's pool rows (amm-pools) read from the chain state — followed to the current output (its BEEF from the token instance's ls_color_<tokenId>, BRC-207 color-spendability, 0.20.1); closed ones left out", async () => {
    const pd = poolDeploy.id("hex");
    const row = {
      outpoint: `${pd}.0`,
      satoshis: v.pool0.bsv,
      lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(),
      tags: ["amm-pool"],
      customInstructions: JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { validatorIdentity: SKEIN } }),
    };
    connect({ pools: [row] });
    inst.spends[`${pd}.0`] = { outpoint: `${pd}.0`, spentBy: swap1.id("hex"), current: `${swap1.id("hex")}.0`, hops: 1, closed: false };
    inst.color[`${swap1.id("hex")}.0`] = { type: "output-list", outputs: [{ beef: atomic(swap1, [fund, tokenDeploy, poolDeploy]), outputIndex: 0 }] };
    const ps = await myPositions();
    expect(ps).toEqual([
      {
        outpoint: `${swap1.id("hex")}.0`,
        tokenId: TOKEN,
        sym: "TST",
        dec: 0,
        sats: BigInt(v.pool1.bsv),
        tokens: BigInt(v.pool1.tokens),
        validator: { identityKey: SKEIN, live: true },
      },
    ]);
    expect(inst.lookups.filter((l) => l.service.startsWith("ls_color"))).toEqual([
      { url: `${ORIGIN}/@${TOKEN}/amm/lookup`, service: `ls_color_${TOKEN}`, query: { type: "color-spendability", version: 1, assetId: TOKEN, topic: TOPIC, outpoints: [`${swap1.id("hex")}.0`] } },
    ]);
    // Closed: gone from the list; and a close of a position not held is refused.
    inst.spends[`${pd}.0`] = { outpoint: `${pd}.0`, hops: 2, closed: true };
    expect(await myPositions()).toEqual([]);
    await expect(closePosition({ outpoint: `${swap1.id("hex")}.0` })).rejects.toThrow(/No such position/);
  });

  it("myPositions (0.28.0): a pool whose filed output the wallet itself spent (listOutputs has no row) is found in its deploy history (listActions amm-pool-deploy) and listed at its current output; a filed row for the same pool is not listed twice", async () => {
    const pd = poolDeploy.id("hex");
    const ci = JSON.stringify({ id: TOKEN, op: "amm-pool", protocolID: [2, "3241645161d8"], keyID: "lp key", counterparty: "self", amm: { validatorIdentity: SKEIN } });
    const deployAction = {
      txid: pd,
      satoshis: 0,
      status: "completed",
      isOutgoing: true,
      description: "AMM pool deploy: TST",
      labels: ["amm-pool-deploy"],
      version: 1,
      lockTime: 0,
      outputs: [
        { outputIndex: 0, satoshis: v.pool0.bsv, spendable: false, basket: "amm-pools", tags: ["amm-pool"], customInstructions: ci, outputDescription: "AMM pool: TST / BSV" },
        { outputIndex: 1, satoshis: 5, spendable: false, basket: "default", tags: [], outputDescription: "change" },
      ],
    };
    connect({ pools: [], actions: [deployAction] });
    inst.spends[`${pd}.0`] = { outpoint: `${pd}.0`, spentBy: swap1.id("hex"), current: `${swap1.id("hex")}.0`, hops: 1, closed: false };
    inst.color[`${swap1.id("hex")}.0`] = { type: "output-list", outputs: [{ beef: atomic(swap1, [fund, tokenDeploy, poolDeploy]), outputIndex: 0 }] };
    const want = [{ outpoint: `${swap1.id("hex")}.0`, tokenId: TOKEN, sym: "TST", dec: 0, sats: BigInt(v.pool1.bsv), tokens: BigInt(v.pool1.tokens), validator: { identityKey: SKEIN, live: true } }];
    expect(await myPositions()).toEqual(want);
    // A filed row (a Recover of the current output) beside the history's: one position.
    connect({ pools: [{ outpoint: `${swap1.id("hex")}.0`, satoshis: v.pool1.bsv, tags: ["amm-pool"], customInstructions: ci }], actions: [deployAction] });
    inst.spends[`${swap1.id("hex")}.0`] = { outpoint: `${swap1.id("hex")}.0`, current: `${swap1.id("hex")}.0`, hops: 0, closed: false };
    expect(await myPositions()).toEqual(want);
    // Closed: gone, as for a filed row.
    connect({ pools: [], actions: [deployAction] });
    inst.spends[`${pd}.0`] = { outpoint: `${pd}.0`, hops: 2, closed: true };
    expect(await myPositions()).toEqual([]);
  });

  it("market terms (0.16.0): amm.swap.terms's minCommissionBps; swapPools lists the pools at or above it and counts the rest; quoteSwap plans over the listed ones only; no wallet, no minimum known, nothing hidden", async () => {
    // The fixture pool charges 10 bps.
    expect(await marketMinimum(TOKEN)).toBeNull();
    inst.minCommissionBps = 11;
    expect(await swapPools(TOKEN)).toMatchObject({ pools: [{ outpoint: `${poolDeploy.id("hex")}.0` }], hidden: 0 });
    connect();
    expect(await marketMinimum(TOKEN)).toBe(11);
    expect(await swapPools(TOKEN)).toEqual({ pools: [], hidden: 1 });
    await expect(quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false })).rejects.toThrow("No pool to swap against: 1 pool below this market's minimum commission");
    inst.minCommissionBps = 10;
    const at = await swapPools(TOKEN);
    expect(at.hidden).toBe(0);
    expect(at.pools).toEqual(await tokenPools(TOKEN));
    expect((await quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false })).legs).toHaveLength(1);
    // The filter itself: at or above; 0 or unknown hides nothing.
    const ps = [{ commissionBps: 0n }, { commissionBps: 25n }, { commissionBps: 1n }];
    expect(atMarketMinimum(ps, 1)).toEqual({ listed: [ps[1], ps[2]], hidden: 1 });
    expect(atMarketMinimum(ps, 25)).toEqual({ listed: [ps[1]], hidden: 2 });
    expect(atMarketMinimum(ps, 0)).toEqual({ listed: ps, hidden: 0 });
    expect(atMarketMinimum(ps, null)).toEqual({ listed: ps, hidden: 0 });
    expect(belowMinimumText(2)).toBe("2 pools below this market's minimum commission");
  });

  it("defaults (0.17.0): the config instance's GET /defaults; setDefaultTerms / clearDefaultTerms / setDefaultMarket / clearDefaultMarket: root's {fn: defaults} to <app>/admin, the config instance's identity the recipient; bad values refused before anything is sent", async () => {
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
    for (const bad of [1.5, -1, 10_001]) await expect(setDefaultMarket(bad)).rejects.toThrow(/0 to 10000/);
    for (const bad of [{ lpBps: 30.5, validatorBps: 5, commissionBps: 0 }, { lpBps: -1, validatorBps: 5, commissionBps: 0 }, { lpBps: 30, validatorBps: 10_001, commissionBps: 0 }])
      await expect(setDefaultTerms(bad)).rejects.toThrow(/0 to 10000/);
    expect(inst.sent).toHaveLength(4);
  });

  it("discovery: the swap instance's GET /discovery; setDiscovery: root's {fn: discovery, args: {on}} to <app>/admin, the swap instance's identity the recipient", async () => {
    expect(await discoveryState()).toEqual({ on: false });
    inst.discovery = { on: true, since: 3 };
    expect(await discoveryState()).toEqual(inst.discovery);
    await expect(setDiscovery(true)).rejects.toThrow(/Connect a wallet/);
    connect();
    let changed = 0;
    const off = onDataChange(() => changed++);
    await setDiscovery(true);
    await setDiscovery(false);
    off();
    expect(changed).toBe(2);
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
    inst.enabled.push({ ...enabledRow(OTHER, "OTH", 2, 3), status: "disabled" });
    await expect(tokenBaseOf(OTHER)).rejects.toThrow(/not enabled on this exchange/);
  });

  it("validatorTerms: amm.pool.terms on /call — this skein's validator, its fees (read-only)", async () => {
    connect();
    expect(await validatorTerms(TOKEN)).toEqual({ validator: { identityKey: SKEIN, live: true }, isThisExchange: true, fees: { lpBps: 30, validatorBps: 5, commissionBps: 0 } });
    expect(inst.calls).toEqual([{ fn: "amm.pool.terms", args: {} }]);
  });

  it("validatorTerms (0.15.0): none set — amm.pool.terms answers \"no validator here\" — is {none: true}, which the pages show as the no-terms text", async () => {
    connect();
    inst.terms = null;
    const t = await validatorTerms(TOKEN);
    expect(t).toEqual({ none: true });
    expect(hasTerms(t)).toBe(false);
    expect(NO_TERMS_TEXT).toBe("This exchange validates nothing: no terms are set.");
    // Another failure is still an error.
    inst.terms = { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 0 };
    await expect(validatorTerms(TOKEN)).rejects.toThrow(/no validator identity/);
  });

  it("instanceIdentity (0.15.0; 0.17.0): the key an instance's signed answer carries — a token instance's off amm.swap.terms (every token instance answers it, terms or none), the config instance's off a signed read of its token list", async () => {
    await expect(instanceIdentity()).rejects.toThrow(/Connect a wallet/);
    connect();
    inst.terms = null;
    expect(await instanceIdentity(await tokenBaseOf(TOKEN))).toBe(SKEIN);
    expect(inst.calls).toEqual([{ fn: "amm.swap.terms", args: {} }]);
    expect(await instanceIdentity()).toBe(SKEIN);
    expect(inst.calls).toHaveLength(1);
  });

  it("deployPosition (0.12.0): from the module's held outputs; refused without the token, or short of the deposit (no claim's unit any more)", async () => {
    await expect(deployPosition({ tokenId: TOKEN, tokens: 1n, sats: 1n })).rejects.toThrow(/Connect a wallet/);
    const held = { outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() };
    connect({});
    await expect(deployPosition({ tokenId: TOKEN, tokens: 0n, sats: 1n })).rejects.toThrow(/more than 0/);
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/fewer than 5 /);
    connect({ held: [held] });
    await expect(deployPosition({ tokenId: TOKEN, tokens: 10_000_001n, sats: 1_000n })).rejects.toThrow(/fewer than 10000001 /);
    // A reserved output (an action in progress holds it) is not offered.
    connect({ held: [{ ...held, spendable: false }] });
    await expect(deployPosition({ tokenId: TOKEN, tokens: 5n, sats: 1_000n })).rejects.toThrow(/fewer than 5 /);
    expect(inst.calls.filter((c) => c.fn === "amm.pool.affirm")).toEqual([]);
  });

  it("myTokens (0.27.0): the module's assets (p color assets), each balance the SUM of its held value outputs there — no per-token p color balance read (one group grant covers the list); what the swap basket holds; on this exchange (registered) or not", async () => {
    const held = { outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() };
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const more = { outpoint: `${"ee".repeat(32)}.0`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(TOKEN, 7n, key) };
    const other = [1, 2].map((n) => ({ outpoint: `${"ef".repeat(32)}.${n}`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(OTHER, BigInt(n * 100), key) }));
    const swapRow = { outpoint: `${poolDeploy.id("hex")}.1`, satoshis: 1, lockingScript: poolDeploy.outputs[1]!.lockingScript.toHex(), customInstructions: JSON.stringify({ assetId: TOKEN, amount: "50000", protocolID: [2, "amm swap"], keyID: "amm-swap-1", counterparty: "self" }) };
    // The module's own figures differ from the outputs' sums: the list must not read them.
    connect({ held: [held, more, ...other], balances: { [`p color balance ${DEPLOY}v0`]: "9999999", [`p color balance ${"cd".repeat(32)}v0`]: "1" }, swaps: [swapRow] });
    walletReads = [];
    const ts = await myTokens();
    expect(walletReads.filter((b) => b.startsWith("p color balance"))).toEqual([]);
    expect(walletReads).toContain("p color assets");
    const deployAmount = decodeOneColor(tokenDeploy.outputs[0]!.lockingScript.toBinary())!.amount;
    expect(ts).toHaveLength(2);
    expect(ts.find((t) => t.tokenId === TOKEN)).toMatchObject({ sym: "TST", dec: 0, balance: BigInt(deployAmount) + 7n, outputs: 2, onExchange: true, inSwaps: 50_000n });
    expect(ts.find((t) => t.tokenId === OTHER)).toMatchObject({ balance: 300n, outputs: 2, inSwaps: 0n, onExchange: false });
    // Only what the swap basket holds: still listed, with "Move back".
    connect({ swaps: [swapRow] });
    expect(await myTokens()).toEqual([expect.objectContaining({ tokenId: TOKEN, balance: 0n, outputs: 0, inSwaps: 50_000n })]);
  });

  it("myTokens (0.29.6): the sats staged in amm-swap for a token's legs (sats rows naming its assetId) — beside its tokens, and a token with ONLY sats staged (no balance, no token row) still listed", async () => {
    const satsRow = (n: number, satoshis: number, assetId: string) => ({ outpoint: `${"5a".repeat(32)}.${n}`, satoshis, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex(), customInstructions: JSON.stringify({ sats: true, assetId, protocolID: [2, "amm swap"], keyID: `amm-swap-${n}:sats`, counterparty: "self" }) });
    const swapRow = { outpoint: `${poolDeploy.id("hex")}.1`, satoshis: 1, lockingScript: poolDeploy.outputs[1]!.lockingScript.toHex(), customInstructions: JSON.stringify({ assetId: TOKEN, amount: "50000", protocolID: [2, "amm swap"], keyID: "amm-swap-1", counterparty: "self" }) };
    connect({ swaps: [swapRow, satsRow(0, 4_000, TOKEN), satsRow(1, 1_000, TOKEN)] });
    expect(await myTokens()).toEqual([expect.objectContaining({ tokenId: TOKEN, balance: 0n, inSwaps: 50_000n, swapSats: 5_000 })]);
    connect({ swaps: [satsRow(2, 2_500, TOKEN)] });
    expect(await myTokens()).toEqual([expect.objectContaining({ tokenId: TOKEN, sym: "TST", balance: 0n, outputs: 0, inSwaps: 0n, swapSats: 2_500 })]);
  });

  it("myTokens (0.20.1): a token not enabled here — its metadata from its deploy, the discovery lookup ls_color (BRC-207 color-admission, topic tm_color) at the HOST ROOT (plain fetch), not /@<tokenId>", async () => {
    inst.enabled = [];
    inst.deploys[`${DEPLOY}.0`] = { type: "output-list", outputs: [{ beef: atomic(tokenDeploy, [fund]), outputIndex: 0 }] };
    const held = { outpoint: `${DEPLOY}.0`, satoshis: 1, spendable: true, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex() };
    connect({ held: [held] });
    const ts = await myTokens();
    expect(ts).toEqual([expect.objectContaining({ tokenId: TOKEN, balance: BigInt(decodeOneColor(tokenDeploy.outputs[0]!.lockingScript.toBinary())!.amount), onExchange: false })]);
    expect(inst.lookups).toEqual([{ url: `${ORIGIN}/lookup`, service: "ls_color", query: { type: "color-admission", version: 1, assetId: TOKEN, topic: "tm_color", outpoints: [`${DEPLOY}.0`] } }]);
  });

  it("enableToken / disableToken (0.17.0; 2026-10-31 no paste): root's {fn: enable, args: {tokenId, beef}} to the config instance's <app>/admin, the deploy's Atomic BEEF from the wallet's module basket (p color <txid>v<vout>), else from discovery (ls_color at the host root), else refused naming both; disable {tokenId}; a stopped token enabled again without a BEEF", async () => {
    connect();
    await expect(enableToken(OTHER)).rejects.toThrow(`no deploy for ${OTHER}: not on discovery and not in this wallet`);
    expect(inst.sent).toHaveLength(0);
    const full = atomic(tokenDeploy, [fund]);
    const beefOf = (m: Record<string, unknown>) => (decode((m.message as { body: Uint8Array }).body) as { args: { beef: Uint8Array } }).args.beef;
    // Held by the wallet: its basket's BEEF, as an Atomic BEEF of the deploy.
    const basketBeef = new Beef();
    basketBeef.mergeRawTx(fund.toBinary());
    basketBeef.mergeRawTx(tokenDeploy.toBinary());
    connect({ deploy: { basket: `p color ${DEPLOY}v0`, outpoint: `${DEPLOY}.0`, beef: basketBeef.toBinary() } });
    inst.lookups = [];
    expect(await enableToken(TOKEN)).toEqual({ beefFrom: "wallet" });
    let msg = inst.sent.at(-1)!.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array };
    expect(Utils.toHex(Array.from(msg.recipient))).toBe(SKEIN);
    expect(msg.messageBox).toBe("amm/admin");
    const body = decode(msg.body) as { fn: string; args: { tokenId: string; beef: Uint8Array } };
    expect(body.fn).toBe("enable");
    expect(body.args.tokenId).toBe(TOKEN);
    expect(Transaction.fromAtomicBEEF(Array.from(body.args.beef)).id("hex")).toBe(DEPLOY);
    expect(inst.lookups).toEqual([]); // the wallet had it: discovery not asked
    // Not in the wallet: discovery's deploy (the host root's ls_color color-admission answer).
    connect();
    inst.deploys[`${DEPLOY}.0`] = { type: "output-list", outputs: [{ beef: full, outputIndex: 0 }] };
    expect(await enableToken(TOKEN)).toEqual({ beefFrom: "discovery" });
    expect(Array.from(beefOf(inst.sent.at(-1)!.body))).toEqual(full);
    expect(inst.lookups.at(-1)).toMatchObject({ url: `${ORIGIN}/lookup`, service: "ls_color" });
    // Disable; a token on the list enabled again names no BEEF (the swap instance keeps its deploy).
    await disableToken(TOKEN);
    msg = inst.sent.at(-1)!.body.message as { recipient: Uint8Array; messageBox: string; body: Uint8Array };
    expect(decode(msg.body)).toEqual({ fn: "disable", args: { tokenId: TOKEN } });
    inst.enabled[0] = { ...inst.enabled[0], status: "disabled" };
    await enableToken(TOKEN);
    expect(decode((inst.sent.at(-1)!.body.message as { body: Uint8Array }).body)).toEqual({ fn: "enable", args: { tokenId: TOKEN } });
  });

  it("deployBeef (2026-10-31): the wallet's module basket first, else discovery (ls_color at the host root), each with the deploy's metadata; neither: refused naming both", async () => {
    const full = atomic(tokenDeploy, [fund]);
    const basketBeef = new Beef();
    basketBeef.mergeRawTx(fund.toBinary());
    basketBeef.mergeRawTx(tokenDeploy.toBinary());
    const wallet = fakeWallet({ deploy: { basket: `p color ${DEPLOY}v0`, outpoint: `${DEPLOY}.0`, beef: basketBeef.toBinary() } });
    const w = await deployBeef(TOKEN, wallet);
    expect(w.from).toBe("wallet");
    expect(Transaction.fromAtomicBEEF(w.beef).id("hex")).toBe(DEPLOY);
    expect(w.meta).toEqual({}); // the fixture's deploy carries no metadata (a 1Color deploy output all the same)
    expect(inst.lookups).toEqual([]);
    inst.deploys[`${DEPLOY}.0`] = { type: "output-list", outputs: [{ beef: full, outputIndex: 0 }] };
    const d = await deployBeef(TOKEN, fakeWallet());
    expect(d).toEqual({ from: "discovery", beef: full, meta: {} });
    expect(inst.lookups).toEqual([{ url: `${ORIGIN}/lookup`, service: "ls_color", query: { type: "color-admission", version: 1, assetId: TOKEN, topic: "tm_color", outpoints: [`${DEPLOY}.0`] } }]);
    // No wallet: discovery only.
    expect((await deployBeef(TOKEN)).from).toBe("discovery");
    await expect(deployBeef(OTHER, fakeWallet())).rejects.toThrow(`no deploy for ${OTHER}: not on discovery and not in this wallet`);
    await expect(deployBeef("nope")).rejects.toThrow(/not a token id/);
  });

  it("tokensToEnable (2026-10-31): discovery's list (A, B) ∪ the wallet's held assets (B, C), minus the swap instance's list (A) → B (both sources) then C (wallet only, its metadata from its deploy); discovery off (404) → the wallet's only", async () => {
    const A = TOKEN;
    const B = `${"b1".repeat(32)}_0`;
    const C = `${"c1".repeat(32)}_0`;
    inst.enabled = [enabledRow(A, "TST", 0, 2)];
    inst.discoveryList = [
      { tokenId: A, topic: `tm_color_${A}`, sym: "TST", dec: 0 },
      { tokenId: B, topic: `tm_color_${B}`, sym: "BBB", dec: 2, icon: "data:image/png;base64,AA" },
    ];
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const heldOf = (tokenId: string, n: number) => ({ outpoint: `${"ee".repeat(32)}.${n}`, satoshis: 1, spendable: true, lockingScript: tokenP2pkhScript(tokenId, 5n, key) });
    connect({ held: [heldOf(B, 0), heldOf(C, 1), heldOf(C, 2)] });
    expect(await tokensToEnable()).toEqual([
      { tokenId: B, sym: "BBB", icon: "data:image/png;base64,AA", onDiscovery: true, inWallet: true },
      { tokenId: C, onDiscovery: false, inWallet: true },
    ]);
    // C's deploy was looked up at the host root (none there: its short id is shown).
    expect(inst.lookups.map((l) => l.query.assetId)).toEqual([C]);
    inst.discoveryList = null;
    expect((await tokensToEnable()).map((t) => [t.tokenId, t.onDiscovery, t.inWallet])).toEqual([
      [B, false, true],
      [C, false, true],
    ]);
  });

  it("tokensToEnable (2026-10-31): a wallet-only token whose deploy is not on discovery takes its metadata from the deploy in the wallet's module basket (no discovery lookup)", async () => {
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
    expect(inst.lookups).toEqual([]);
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
    // 0.21.0: the AMM lookup per asset, the asset id as colorQuery forms it (`_0` added to a bare txid).
    expect(ammLookupOf(`${t}_0`)).toBe(`ls_amm_${t}_0`);
    expect(ammLookupOf(t)).toBe(`ls_amm_${t}_0`);
    expect(ammLookupOf(`${t.toUpperCase()}.2`)).toBe(`ls_amm_${t}_2`);
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
