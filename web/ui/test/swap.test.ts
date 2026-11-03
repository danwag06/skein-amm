/**
 * The Swap page's pure parts: market view shaping from the instance's
 * answers (recorded from the v2 instance, test/fixtures/instance-v2), the
 * plan display, races, and the swap itself against a fake BRC-100 wallet and
 * a fake relay: the leg's sats (0.29.0: one `amm-swap` sats output of exactly
 * the planned amount, no funding transaction), the swap's inputs validated
 * with `Spend` (sats in and tokens in, over the amm-topic fixture pools), the
 * relay's call shape and status polling, acceptance (internalize, no
 * relinquish) and refusal / timeout (nothing to undo).
 */
import { colorReceiptInstructions } from "@1sat/actions";
import { colorProtocolID } from "@bsv/color-permission-module";
import { BigNumber, ECDSA, Beef, Hash, LockingScript, P2PKH, PrivateKey, PublicKey, Transaction, UnlockingScript, Utils, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { computeSwap, type Leg, type PoolState } from "@amm-poc/matching-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRC29, brc29Side, isBrc29 } from "./brc29Wallet";
import { PENDING_PAYOUTS_KEY, PendingPayoutStore, internalizeNow, isLegacyPayout, type KV } from "../src/wallet/pendingPayouts";
import { receiptOutput } from "../src/wallet/color";
import { tokenP2pkhScript as tokenP2pkhScriptOf } from "../src/lp/poolDeploy";
import { PoolTemplate, decodeOneColor } from "../src/pool";
import {
  liveTopicOf,
  mergeLive,
  liveUrl,
  noLiveness,
  parseLiveBeats,
  parseLookupAnswer,
  parseOutputList,
  parseTokenTopic,
  type SignedFetch,
} from "../src/lib/overlay";
import { buildMarketView, marginalPrice, validatorStatus } from "../src/market/view";
import { buildPlanRequest, goneFromLookup, livePools, quote, type SwapForm } from "../src/market/plan";
import { PEER, beatEntry, liveFor } from "./liveRead";
import {
  LEG_COMMISSION_PREFIX,
  LEG_PAYOUT_PREFIX,
  assetIdOf,
  legDerivation,
  legKeyInputOf,
  pendingSwapPayouts,
  planSwapLeg,
  prepareSwap,
  selectExactTokenInputs,
  spendValid,
  swapFunding,
  swapTxSize,
  tokenInputsOf,
  type PlanLegInput,
  type PreparedSwap,
  type SatsInput,
} from "../src/market/swapAction";
import { dagBytes, parseSwapTerms, readBytes, swapTerms, toPoolState, type AuthFetchLike } from "../src/market/relay";
import { relaySwap, checkAgain } from "../src/market/swapFlow";
import topics from "./fixtures/instance-v2/listTopicManagers.json";
import lookupAll from "./fixtures/instance-v2/lookup-all.json";
import liveRead from "./fixtures/live-read.json";
import beefAnswer from "./fixtures/instance-v2/lookup-outpoint-beef.json";
import v from "./fixtures/amm-topic-vectors.json";

const TXID = "948b532f1de8f7bb148f77da824544fe47b02079e7514d5b6a42856651c5214c";
// The page's token id and the wallet's filings are the same `<txid>_0` (BRC-162 Token identification, David 2026-10-07).
const TOKEN_ID = `${TXID}_0`;
const SDK_ID = TOKEN_ID;

// ---------------------------------------------------------------------------
// Market view
// ---------------------------------------------------------------------------

describe("market view from the instance's answers", () => {
  const tokenTopics = Object.keys(topics).map(parseTokenTopic).filter((t) => t !== null);
  // The liveness read's shape (skein #138), with the v2 instance's recorded validator and peer, 28 s old.
  const NOW = 1790844766808;
  const live = parseLiveBeats(liveRead, NOW);
  const pools = parseLookupAnswer(lookupAll);

  it("names (BRC-207): tm_color_<txid>_0 is a native token, tm_color_<txid>_<vout> a legacy one, anything else (the old tm_<txid>_0 included) is not a token", () => {
    expect(tokenTopics).toEqual([
      { topic: `tm_color_${TXID}_0`, txid: TXID, vout: 0, kind: "native", tokenId: TOKEN_ID },
    ]);
    expect(parseTokenTopic(`tm_color_${TXID}`)).toBeNull();
    expect(parseTokenTopic(`tm_color_${TXID}_3`)).toMatchObject({ kind: "legacy", tokenId: `${TXID}_3` });
    expect(parseTokenTopic("tm_demo")).toBeNull();
    expect(parseTokenTopic("tm_color")).toBeNull();
    expect(parseTokenTopic(`tm_${TXID}_0`)).toBeNull(); // the old name: no alias
    expect(parseTokenTopic(`tm_color_${TXID}_0-live`)).toBeNull();
  });

  it("pools, prices (display units with decimals, base units without) and validator liveness", () => {
    const view = buildMarketView(tokenTopics, new Map([[TOKEN_ID, pools]]), new Map([[TOKEN_ID, live]]), new Map([[TOKEN_ID, { sym: "TST", dec: 2 }]]));
    expect(view).toHaveLength(1);
    const [row] = view[0]!.pools;
    expect(view[0]!.meta).toEqual({ sym: "TST", dec: 2 });
    expect(row!.pool.bsvReserve).toBe(1019930n);
    // 1,019,930 sats / 4,902,298 base units = 0.20805140… sats per base unit, × 100 per token.
    expect(row!.price).toBe("20.80514077");
    expect(row!.priceUnit).toBe("token");
    // The pool's validator is not the one beating on the token's -live topic.
    expect(row!.validator).toEqual({ identityKey: pools[0]!.validatorIdentityKey, live: false, seen: false });
    expect(view[0]!.live).toBe(live);

    const bare = buildMarketView(tokenTopics, new Map([[TOKEN_ID, pools]]), new Map([[TOKEN_ID, live]]), new Map());
    expect(bare[0]!.meta).toBeUndefined();
    expect(bare[0]!.pools[0]!.price).toBe("0.2080514");
    expect(bare[0]!.pools[0]!.priceUnit).toBe("base unit");

    const failed = buildMarketView(tokenTopics, new Map([[TOKEN_ID, new Error("lookup 500")]]), new Map([[TOKEN_ID, new Error("GET …/.live/…: 500")]]), new Map());
    expect(failed[0]!.error).toBe("lookup 500");
    expect(failed[0]!.live).toBeNull();
    expect(failed[0]!.liveError).toBe("GET …/.live/…: 500");
  });

  it("the liveness read (GET <base>/.live/tm_color_<txid>_0-live): each body decoded to {identityKey, peerId}; every beat the read returns is live", () => {
    expect(liveUrl("http://a.localhost:8100/amm/", liveTopicOf(`tm_color_${TXID}_0`))).toBe(`http://a.localhost:8100/amm/.live/tm_color_${TXID}_0-live`);
    expect(live.kept).toBe(true);
    expect("windowMs" in live).toBe(false);
    expect(live.validators).toEqual([
      { identityKey: "03cdee31ef0446ffb95aeae00353d9ab4c26a8555d597a9930b0ddd4f4cc1ae0d0", peerId: PEER, at: 1790844738661, ageMs: 28147, live: true },
    ]);
    const id = live.validators[0]!.identityKey;
    expect(validatorStatus(id.toUpperCase(), live)).toMatchObject({ live: true, seen: true, peerId: PEER });
    // A beat 200 s old that the read returned: live (the instance's window is the one judgement); its age kept.
    expect(parseLiveBeats(liveRead, 1790844738661 + 200_000).validators[0]).toMatchObject({ live: true, ageMs: 200_000 });
    // The latest beat per identity; newest first.
    const k2 = "02" + "22".repeat(32);
    const two = parseLiveBeats([beatEntry(k2, PEER, 900), beatEntry(id, PEER, 800), beatEntry(id, PEER, 950)], 1000);
    expect(two.validators.map((x) => [x.identityKey, x.at])).toEqual([[id, 950], [k2, 900]]);
    // The identity is the sender, the peer ID `from`; the body is not read (the beat has none).
    expect(parseLiveBeats([{ sender: id.toUpperCase(), at: 900, body: Utils.toBase64([1, 2, 3]), from: PEER }], 1000).validators).toMatchObject([{ identityKey: id, peerId: PEER }]);
    // Skipped: no peer ID, a sender that is not a key, no sender.
    const odd = parseLiveBeats([{ sender: id, at: 900, body: "" }, { sender: "zz", at: 900, from: PEER }, { at: 900, from: PEER }, "junk"], 1000);
    expect(odd.validators).toEqual([]);
    expect(parseLiveBeats({ not: "an array" }, 1000).validators).toEqual([]);
    // 404: the instance keeps no liveness for the topic.
    expect(noLiveness(5)).toEqual({ now: 5, validators: [], kept: false });
    // Several topics' answers as one: the latest beat per identity.
    const merged = mergeLive([parseLiveBeats([beatEntry(id, PEER, 800), beatEntry(k2, PEER, 900)], 1000), parseLiveBeats([beatEntry(id, PEER, 950)], 1000), noLiveness(1000)], 1000);
    expect(merged.kept).toBe(true);
    expect(merged.validators.map((x) => [x.identityKey, x.at, x.live])).toEqual([[id, 950, true], [k2, 900, true]]);
    expect(mergeLive([noLiveness(1000)], 1000).kept).toBe(false);
  });

  it("marginal price is exact bigint arithmetic", () => {
    expect(marginalPrice({ bsvReserve: 1_000_000n, tokenReserve: 5_000_000n }, 0)).toBe("0.2");
    expect(marginalPrice({ bsvReserve: 1n, tokenReserve: 3n }, 8)).toBe("33333333.33333333");
  });
});

// ---------------------------------------------------------------------------
// Plan display and races
// ---------------------------------------------------------------------------

const poolA: PoolState = {
  outpoint: `${"aa".repeat(32)}_0`,
  bsvReserve: 1_000_000n,
  tokenReserve: 5_000_000n,
  liquidityFeeBps: 30n,
  validationFeeBps: 5n,
  commissionBps: 0n,
  validatorIdentityKey: "02" + "11".repeat(32),
};
const poolB: PoolState = { ...poolA, outpoint: `${"bb".repeat(32)}_0`, bsvReserve: 2_000_000n, tokenReserve: 9_000_000n };

describe("plan display", () => {
  const form: SwapForm = { direction: "bsvToToken", amount: "400000", slippageBps: "500", allowPartial: true };
  // poolA and poolB share a validator, live on the token.
  const live = liveFor([poolA.validatorIdentityKey]);

  it("the planner considers only the pools whose validator is in the liveness read", () => {
    const poolC: PoolState = { ...poolA, outpoint: `${"cc".repeat(32)}_0`, validatorIdentityKey: "03" + "33".repeat(32) };
    expect(livePools([poolA, poolB, poolC], live).map((p) => p.outpoint)).toEqual([poolA.outpoint, poolB.outpoint]);
    expect(livePools([poolA], null)).toEqual([]);
    const req = buildPlanRequest(TOKEN_ID, form, [poolA, poolB, poolC], live, 0);
    if (!req.ok) throw new Error(req.error);
    expect(req.request.inventory.map((p) => p.outpoint)).toEqual([poolA.outpoint, poolB.outpoint]);
    expect(req.request.inventory[0]!.lastSeen).toBe(live.validators[0]!.at);
    expect(quote(req.request, live, 0).plan.legs.every((l) => l.outpoint !== poolC.outpoint)).toBe(true);
    // Only poolC: nothing to plan, and why.
    expect(buildPlanRequest(TOKEN_ID, form, [poolC], live, 0)).toEqual({ ok: false, error: "no pool's validator is live on this token" });
    expect(buildPlanRequest(TOKEN_ID, form, [poolA], null, 0)).toEqual({ ok: false, error: "no liveness read for this token: no pool can be planned" });
    expect(buildPlanRequest(TOKEN_ID, form, [poolA], noLiveness(0), 0)).toMatchObject({ ok: false, error: expect.stringMatching(/keeps no liveness/) });
    // A beat 200 s old that the read returned: planned (the pages keep no window of their own).
    const old = parseLiveBeats([beatEntry(poolA.validatorIdentityKey, PEER, 0)], 200_000);
    expect(buildPlanRequest(TOKEN_ID, form, [poolA], old, 0).ok).toBe(true);
    // The leg's validator carries the peer ID the swap names.
    expect(quote(req.request, live, 0).view.legs[0]!.validator).toMatchObject({ live: true, peerId: PEER });
  });

  it("plans across several pools, with per-leg fees and totals", () => {
    const req = buildPlanRequest(TOKEN_ID, form, [poolA, poolB], live, 0);
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const { plan, view } = quote(req.request, live, 0);
    expect(plan.legs.length).toBe(2);
    expect(view.legs.map((l) => l.outpoint).sort()).toEqual([poolA.outpoint, poolB.outpoint].sort());
    expect(view.totalIn).toBe(400_000n);
    expect(view.totalOut).toBe(plan.totalAmountOut);
    for (const l of view.legs) {
      const s = computeSwap(l.pool, "bsvToToken", l.amountIn)!;
      expect([l.lpFee, l.validatorFee, l.amountOut]).toEqual([s.liquidityFee, s.validationFee, s.amountOut]);
      expect(l.commission).toBe(0n);
    }
    expect(view.lpFees).toBe(view.legs[0]!.lpFee + view.legs[1]!.lpFee);
    expect(view.commissions).toBe(0n);
    // poolA: 5 tokens per sat, the better mid (0.2 sats per token).
    expect(view.midPrice).toBe("0.2");
    expect(view.slippageVsMidBps > 0n).toBe(true);
    expect(view.meetsSlippageBound).toBe(true);
    expect(view.unfilled).toBe(0n);
  });

  it("no partial fills: one pool only; the pool's commission is priced as a fee on amount in", () => {
    const withCommission = { ...poolA, commissionBps: 10n };
    const req = buildPlanRequest(TOKEN_ID, { ...form, amount: "40000", allowPartial: false }, [withCommission], live, 0);
    if (!req.ok) throw new Error(req.error);
    expect(req.request.fixedCost).toEqual({ minerFeeSats: expect.any(BigInt) });
    const { view } = quote(req.request, live, 0);
    expect(view.legs).toHaveLength(1);
    const l = view.legs[0]!;
    expect([l.lpFee, l.validatorFee, l.commission]).toEqual([120n, 20n, 40n]);
    expect(view.commissions).toBe(40n);
    expect(l.amountOut).toBe(computeSwap(withCommission, "bsvToToken", 40_000n)!.amountOut);
    // The same order on the same pool without a commission gets more out.
    const bare = buildPlanRequest(TOKEN_ID, { ...form, amount: "40000", allowPartial: false }, [poolA], live, 0);
    if (!bare.ok) throw new Error(bare.error);
    expect(quote(bare.request, live, 0).view.totalOut).toBeGreaterThan(view.totalOut);
  });

  it("token amounts are entered in display units", () => {
    const req = buildPlanRequest(TOKEN_ID, { ...form, direction: "tokenToBsv", amount: "1.5" }, [poolA], live, 2);
    expect(req.ok && req.request.amountIn).toBe(150n);
    expect(buildPlanRequest(TOKEN_ID, { ...form, amount: "1.5" }, [poolA], live, 2)).toEqual({ ok: false, error: "at most 0 decimal place(s)" });
    expect(buildPlanRequest(TOKEN_ID, form, [], live, 0)).toEqual({ ok: false, error: "no pools for this token" });
  });

  it("races: a planned pool missing from a fresh lookup is reported, and replanning drops it", () => {
    const req = buildPlanRequest(TOKEN_ID, form, [poolA, poolB], live, 0);
    if (!req.ok) throw new Error(req.error);
    const { plan } = quote(req.request, live, 0);
    const fresh = [poolB];
    expect(goneFromLookup(plan, fresh)).toEqual([poolA.outpoint]);
    const again = buildPlanRequest(TOKEN_ID, form, fresh, live, 0);
    if (!again.ok) throw new Error(again.error);
    expect(quote(again.request, live, 0).plan.legs.map((l) => l.outpoint)).toEqual([poolB.outpoint]);
  });
});

// The swap: funding, swap transaction, relay, outcome
// ---------------------------------------------------------------------------

const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const taker = key(30); // owns the fixture's funds and token output
const identity = key(0x7f);
const anyone = new PrivateKey(1).toPublicKey();
const validatorKey = (txid: string, vout: number) => identity.deriveChild(anyone, `1-amm pool-${txid}_${vout}`);
const walletRoot = key(31); // the fake wallet's root: identity key and every derived key
const TOKEN_KEY = "k1"; // the fixture token output's keyID (taker)
const RATE = 100;

const fund = Transaction.fromHex(v.fund);
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const swap1 = Transaction.fromHex(v.swap_bsv_in);
const atomic = (tx: Transaction) => {
  const b = new Beef();
  b.mergeTransaction(tx);
  return b.toBinaryAtomic(tx.id("hex"));
};

/**
 * A fake BRC-100 wallet. Keys: a real KeyDeriver over `walletRoot`
 * (./brc29Wallet.ts) for every derivation, `taker` for the fixture token key.
 * createAction (signAndProcess false): input fund:`fundingVout`, the
 * requested outputs in order (or the change first with `moveFunding`), then
 * a P2PKH change; signAction signs fund:vout and returns the AtomicBEEF.
 * listOutputs answers the token inputs' BEEF. Records every call.
 */
function fakeWallet(o: { fundingVout?: number; moveFunding?: boolean } = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const side = brc29Side(walletRoot);
  /** The `amm-swap` sats outputs' transactions (0.29.0), in the swap basket's BEEF. */
  const held: Transaction[] = [];
  type K = { identityKey?: boolean; protocolID?: [0 | 1 | 2, string]; keyID?: string; counterparty?: string; forSelf?: boolean };
  let unsigned: Transaction | undefined;
  const w = {
    async getPublicKey(args: K) {
      calls.push({ method: "getPublicKey", args });
      if (args.identityKey) return { publicKey: side.identityKey };
      if (args.keyID === TOKEN_KEY) return { publicKey: taker.toPublicKey().toString() };
      return { publicKey: side.publicKey(args as never) };
    },
    async createSignature(args: K & { hashToDirectlySign: number[] }) {
      calls.push({ method: "createSignature", args });
      const k = args.keyID === TOKEN_KEY ? taker : side.privateKey(args as never);
      return { signature: ECDSA.sign(new BigNumber(args.hashToDirectlySign), k, true).toDER() as number[] };
    },
    async createAction(args: CreateActionArgs) {
      calls.push({ method: "createAction", args });
      const vout = o.fundingVout ?? 1;
      const tx = new Transaction();
      tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: vout, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      const outs = (args.outputs ?? []).map((x) => ({ satoshis: x.satoshis, lockingScript: LockingScript.fromHex(x.lockingScript) }));
      const change = fund.outputs[vout]!.satoshis! - outs.reduce((a, x) => a + x.satoshis, 0) - 200;
      const ch = { satoshis: change, lockingScript: new P2PKH().lock(taker.toAddress()) };
      for (const x of o.moveFunding ? [ch, ...outs] : [...outs, ch]) tx.addOutput(x);
      unsigned = tx;
      return { signableTransaction: { tx: atomic(tx), reference: "ref-1" } };
    },
    async signAction(args: unknown) {
      calls.push({ method: "signAction", args });
      unsigned!.inputs[0]!.unlockingScript = await new P2PKH().unlock(taker).sign(unsigned!, 0);
      return { txid: unsigned!.id("hex"), tx: atomic(unsigned!) };
    },
    async listOutputs(args: unknown) {
      calls.push({ method: "listOutputs", args });
      const b = new Beef();
      b.mergeTransaction(poolDeploy);
      for (const t of held) b.mergeTransaction(t);
      return { totalOutputs: 1, outputs: [], BEEF: b.toBinary() };
    },
    async abortAction(args: unknown) {
      calls.push({ method: "abortAction", args });
      return { aborted: true };
    },
    async relinquishOutput(args: unknown) {
      calls.push({ method: "relinquishOutput", args });
      return { relinquished: true };
    },
    async internalizeAction(args: never) {
      calls.push({ method: "internalizeAction", args });
      return side.internalizeAction(args);
    },
  };
  return { wallet: w as unknown as WalletInterface, calls, side, held, fundingVout: o.fundingVout ?? 1 };
}

const SWAP_KEYS: [2, string] = [2, "amm swap"];
let satsKeyN = 0;

/** An `amm-swap` sats output of `satoshis` (0.29.0: what the swap-basket send stages), funded from fund:`w.fundingVout`, held by the fake wallet. */
async function stagedSats(w: ReturnType<typeof fakeWallet>, satoshis: number): Promise<SatsInput> {
  const keyID = `amm-swap-s${++satsKeyN}`;
  const pub = w.side.publicKey({ protocolID: SWAP_KEYS, keyID, counterparty: "self", forSelf: true });
  const tx = new Transaction();
  tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: w.fundingVout, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(PublicKey.fromString(pub).toAddress()) });
  tx.addOutput({ satoshis: fund.outputs[w.fundingVout]!.satoshis! - satoshis - 200, lockingScript: new P2PKH().lock(taker.toAddress()) });
  tx.inputs[0]!.unlockingScript = await new P2PKH().unlock(taker).sign(tx, 0);
  w.held.push(tx);
  const txid = tx.id("hex");
  return { outpoint: `${txid}.0`, txid, vout: 0, satoshis, lockingScript: tx.outputs[0]!.lockingScript.toHex(), protocolID: SWAP_KEYS, keyID, counterparty: "self" };
}

/** planSwapLeg, then an `amm-swap` sats output of exactly the planned amount, then prepareSwap (as executeSwap does). */
async function legOf(w: ReturnType<typeof fakeWallet>, i: Omit<PlanLegInput, "wallet"> & { tokenInputs?: ReturnType<typeof tokenInputsOf>; now?: number }) {
  const planned = await planSwapLeg({ ...i, wallet: w.wallet });
  const satsInput = await stagedSats(w, planned.funding.satoshis);
  const prepared = await prepareSwap({ ...i, wallet: w.wallet, planned, satsInput });
  return { planned, satsInput, prepared };
}

const stateOf = (tx: Transaction, validatorIdentityKey: string): PoolState => {
  const pool = PoolTemplate.decode(tx.outputs[0]!.lockingScript)!;
  return {
    outpoint: `${tx.id("hex")}_0`,
    bsvReserve: BigInt(tx.outputs[0]!.satoshis!),
    tokenReserve: pool.state.tokenReserve,
    liquidityFeeBps: pool.args.lpFeeBps,
    validationFeeBps: pool.args.validatorFeeBps,
    commissionBps: pool.args.commissionBps,
    validatorIdentityKey,
  };
};
const legFor = (pool: PoolState, direction: "bsvToToken" | "tokenToBsv", amountIn: bigint): Leg => {
  const s = computeSwap(pool, direction, amountIn)!;
  return { outpoint: pool.outpoint, amountIn, liquidityFee: s.liquidityFee, validationFee: s.validationFee, commission: s.commission, amountOut: s.amountOut, newBsvReserve: s.newBsvReserve, newTokenReserve: s.newTokenReserve };
};

const tokenRow = () => {
  const out = poolDeploy.outputs[1]!;
  return { outpoint: `${poolDeploy.id("hex")}.1`, satoshis: out.satoshis!, lockingScript: out.lockingScript.toHex(), customInstructions: JSON.stringify({ protocolID: [1, "1sat"], keyID: TOKEN_KEY, counterparty: "self" }) };
};

/** Sats in on the fixture's first pool (pool_deploy:0, validator key for token_deploy:0). */
async function satsIn(w = fakeWallet(), commissionPkh: string | null = v.commissionPkh) {
  const pool = stateOf(poolDeploy, v.identity);
  const leg = legFor(pool, "bsvToToken", 20_000n);
  const { prepared, satsInput } = await legOf(w, { tokenId: TOKEN_ID, meta: { sym: "TST", dec: 0 }, direction: "bsvToToken", leg, pool, poolOutput: { beef: atomic(poolDeploy), outputIndex: 0 }, commissionPkh, satsPerKb: RATE, now: 1_000 });
  return { ...w, pool, leg, prepared, satsInput, vkey: identity.deriveChild(anyone, `1-amm pool-${v.nonce}`) }; // 0.13.0: the deploy's key is keyed by the nonce
}

/** Tokens in on the fixture's second pool (swap_bsv_in:0), 50,000 tokens from pool_deploy:1. */
async function tokensIn(w = fakeWallet({ fundingVout: 2 }), commissionPkh: string | null = v.commissionPkh) {
  const pool = stateOf(swap1, v.identity);
  const leg = legFor(pool, "tokenToBsv", 50_000n);
  const inputs = selectExactTokenInputs(tokenInputsOf([tokenRow()], TOKEN_ID), 50_000n)!;
  const { prepared, satsInput } = await legOf(w, { tokenId: TOKEN_ID, direction: "tokenToBsv", leg, pool, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, commissionPkh, tokenInputs: inputs, satsPerKb: RATE, now: 1_000 });
  return { ...w, pool, leg, prepared, satsInput, vkey: validatorKey(poolDeploy.id("hex"), 0) };
}

/** What the validator does: fills its slot (over the raw swap it received). */
async function validatorSigns(p: PreparedSwap, raw: number[], vkey: PrivateKey): Promise<Transaction> {
  const tx = Transaction.fromBinary(raw);
  tx.inputs.forEach((inp, n) => (inp.sourceTransaction = p.swap.inputs[n]!.sourceTransaction));
  await PoolTemplate.signPoolInput({ tx, pool: p.plan.pool, method: "swap", unsigned: ["validator"] }, "validator", vkey);
  return tx;
}

describe("the leg's sats (0.29.0: an amm-swap output)", () => {
  it("the recorded lookup BEEF (v2 instance, before the commission) parses; its pool is the pre-commission template, which no longer decodes", () => {
    // Recorded when the instance ran the previous fixtures (pool_deploy without
    // CommissionBps); the swaps below use the current pool_deploy as the lookup's AtomicBEEF.
    const [out] = parseOutputList(beefAnswer);
    const tx = Transaction.fromAtomicBEEF(out!.beef);
    expect(tx.id("hex")).not.toBe(poolDeploy.id("hex"));
    expect(PoolTemplate.decode(tx.outputs[out!.outputIndex]!.lockingScript)).toBeNull();
    expect(PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)).not.toBeNull();
    expect(assetIdOf(TOKEN_ID)).toBe(Utils.toHex(tokenDeploy.hash() as number[]));
  });

  it("sats in (0.29.0): the leg spends ONE amm-swap sats output of exactly the planned amount — no createAction, no 1sat-deposit; the wallet call sequence", async () => {
    const { calls, prepared, satsInput } = await satsIn();
    const f = prepared.funding;
    // The payout key (the module receiving key: one getPublicKey); the swap basket's BEEF; the sats input's signature.
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "listOutputs", "createSignature", "getPublicKey"]);
    expect(calls.some((c) => c.method === "createAction" || c.method === "signAction")).toBe(false);
    expect(calls[1]!.args).toEqual({ basket: "amm-swap", include: "entire transactions", limit: 10000 });
    expect(f.input).toEqual(satsInput);
    expect(f.outpoint).toBe(satsInput.outpoint);
    expect(f.txid).toBe(satsInput.txid);
    expect(f.satoshis).toBe(satsInput.satoshis);
    // The relay's funding transaction: the sats output's own, as AtomicBEEF.
    expect(Beef.fromBinary(f.atomicBeef).atomicTxid).toBe(satsInput.txid);
    expect(prepared.expires).toBe(1_000 + 120_000);
    // The signature over the sats input uses the key its row names.
    expect(calls[2]!.args).toMatchObject({ protocolID: [2, "amm swap"], keyID: satsInput.keyID, counterparty: "self" });
  });

  it("the amount is exact: amount in + 1 sat for the token payout (the fees and the commission are part of amount in), plus the fee at the rate over the final size", async () => {
    const { prepared, vkey } = await satsIn();
    const f = prepared.funding;
    expect(f.outputs).toBe(20_001);
    expect(f.size).toBe(swapTxSize(prepared.plan, 1));
    expect(f.fee).toBe(Math.ceil((f.size * RATE) / 1000));
    expect(f.satoshis).toBe(20_001 + f.fee);
    // The final swap (validator signed): inputs − outputs is exactly the fee; its size is within the estimate.
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const ins = final.inputs.reduce((a, i) => a + (i.sourceTransaction?.outputs[i.sourceOutputIndex]?.satoshis ?? 0), 0);
    expect(ins - final.outputs.reduce((a, o) => a + o.satoshis!, 0)).toBe(f.fee);
    expect(final.toBinary().length).toBeLessThanOrEqual(f.size);
    expect(f.size - final.toBinary().length).toBeLessThan(20);
    // The commission (20 sats at 10 bps) is output 4, to the relay, out of amount in.
    expect(prepared.commission).toEqual({ amount: 20n, pkh: v.commissionPkh, to: "relay" });
    expect(prepared.plan.outputs[4]).toEqual({ satoshis: 20n, script: `76a914${v.commissionPkh}88ac` });
    expect(swapFunding(prepared.plan, [], 0).satoshis).toBe(20_001);
    // The taker's own commission costs no more funding either.
    const own = await satsIn(fakeWallet(), null);
    expect(own.prepared.funding.outputs).toBe(20_001);
  });

  it("a sats output of another amount, or token inputs other than those planned: refused before anything is signed", async () => {
    const w = fakeWallet();
    const pool = stateOf(poolDeploy, v.identity);
    const leg = legFor(pool, "bsvToToken", 20_000n);
    const i = { tokenId: TOKEN_ID, direction: "bsvToToken" as const, leg, pool, poolOutput: { beef: atomic(poolDeploy), outputIndex: 0 }, commissionPkh: v.commissionPkh, satsPerKb: RATE };
    const planned = await planSwapLeg({ ...i, wallet: w.wallet });
    const off = await stagedSats(w, planned.funding.satoshis + 1);
    const before = w.calls.length;
    await expect(prepareSwap({ ...i, wallet: w.wallet, planned, satsInput: off })).rejects.toThrow(/needs exactly/);
    expect(w.calls.slice(before).some((c) => c.method === "createSignature")).toBe(false);
    // Tokens in: two token inputs where the leg was planned with one (the fee differs).
    const t = fakeWallet({ fundingVout: 2 });
    const tpool = stateOf(swap1, v.identity);
    const tleg = legFor(tpool, "tokenToBsv", 50_000n);
    const ti = { tokenId: TOKEN_ID, direction: "tokenToBsv" as const, leg: tleg, pool: tpool, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, commissionPkh: v.commissionPkh, satsPerKb: RATE };
    const tplanned = await planSwapLeg({ ...ti, wallet: t.wallet, tokenInputs: [{ satoshis: 1, amount: 50_000n }] });
    const [one] = tokenInputsOf([tokenRow()], TOKEN_ID);
    const split = [{ ...one!, amount: 25_000n }, { ...one!, outpoint: `${"ee".repeat(32)}.1`, amount: 25_000n }];
    await expect(prepareSwap({ ...ti, wallet: t.wallet, planned: tplanned, tokenInputs: split, satsInput: await stagedSats(t, tplanned.funding.satoshis) })).rejects.toThrow(/planned with/);
  });

  it("a pool that moved since the plan is refused before the wallet is asked", async () => {
    const pool = { ...stateOf(poolDeploy, v.identity), outpoint: `${"cc".repeat(32)}_0` };
    const { wallet, calls } = fakeWallet();
    await expect(planSwapLeg({ wallet, tokenId: TOKEN_ID, direction: "bsvToToken", leg: legFor(pool, "bsvToToken", 20_000n), pool, poolOutput: { beef: atomic(poolDeploy), outputIndex: 0 }, commissionPkh: null, satsPerKb: RATE })).rejects.toThrow(/the pool moved/);
    expect(calls).toEqual([]);
  });
});

describe("the payout keys (0.29.1): derived from the leg's first staged input, recomputable from the swap alone", () => {
  const b64 = (t: string) => Utils.toBase64(Utils.toArray(t, "utf8"));
  const suffixOf = (outpoint: string) => Utils.toBase64(Hash.sha256(Utils.toArray(outpoint, "utf8")) as number[]);

  it("the rule: prefix base64(\"amm swap\") (payout) or base64(\"amm swap commission\") (own commission), suffix base64(sha256(\"<txid>.<vout>\"))", () => {
    expect(LEG_PAYOUT_PREFIX).toBe(b64("amm swap"));
    expect(LEG_COMMISSION_PREFIX).toBe(b64("amm swap commission"));
    const op = `${"ab".repeat(32)}.3`;
    expect(legDerivation(op, "payout")).toEqual({ derivationPrefix: b64("amm swap"), derivationSuffix: suffixOf(op) });
    expect(legDerivation(op, "commission")).toEqual({ derivationPrefix: b64("amm swap commission"), derivationSuffix: suffixOf(op) });
  });

  it("sats in, own commission: from input 1 (the sats row) alone — the token payout's receipt key (sender the validator) and the commission's BRC-29 key match outputs 1 and 4", async () => {
    const { prepared, satsInput, side } = await satsIn(fakeWallet(), null);
    const tx = Transaction.fromBinary(prepared.swap.toBinary()); // nothing but the transaction
    const keyInput = legKeyInputOf(tx, true);
    expect(keyInput).toBe(satsInput.outpoint);
    const pay = legDerivation(keyInput, "payout");
    if (prepared.payout.kind !== "color") throw new Error("expected a receipt");
    expect(prepared.payout.receipt).toMatchObject(pay);
    const recv = side.publicKey({ protocolID: colorProtocolID(SDK_ID, pay.derivationPrefix, pay.derivationSuffix), keyID: "color", counterparty: v.identity, forSelf: true });
    expect(tx.outputs[1]!.lockingScript.toHex().endsWith(new P2PKH().lock(PublicKey.fromString(recv).toAddress()).toHex())).toBe(true);
    const com = legDerivation(keyInput, "commission");
    const own = side.privateKey({ protocolID: BRC29, keyID: `${com.derivationPrefix} ${com.derivationSuffix}`, counterparty: side.identityKey });
    expect(tx.outputs[4]!.lockingScript.toHex()).toBe(new P2PKH().lock(own.toAddress()).toHex());
    // The unfinished-step entries are still written (0.29.3: no key material in them).
    const recs = pendingSwapPayouts(prepared, TOKEN_ID, "http://x/amm", 1);
    expect(recs.map((r) => [r.vout, r.receipt, r.remittance])).toEqual([[1, undefined, undefined], [4, undefined, undefined]]);
  });

  it("tokens in, own commission: from input 2 (the first token row) alone — the BRC-29 payout (sender the user) and the commission's receipt key match outputs 1 and 4; the same inputs give the same keys", async () => {
    const w = fakeWallet({ fundingVout: 2 });
    const { prepared, side } = await tokensIn(w, null);
    const tx = Transaction.fromBinary(prepared.swap.toBinary());
    const keyInput = legKeyInputOf(tx, false);
    expect(keyInput).toBe(`${poolDeploy.id("hex")}.1`);
    const pay = legDerivation(keyInput, "payout");
    const payKey = side.privateKey({ protocolID: BRC29, keyID: `${pay.derivationPrefix} ${pay.derivationSuffix}`, counterparty: side.identityKey });
    expect(tx.outputs[1]!.lockingScript.toHex()).toBe(new P2PKH().lock(payKey.toAddress()).toHex());
    const com = legDerivation(keyInput, "commission");
    const recv = side.publicKey({ protocolID: colorProtocolID(SDK_ID, com.derivationPrefix, com.derivationSuffix), keyID: "color", counterparty: v.identity, forSelf: true });
    expect(tx.outputs[4]!.lockingScript.toHex().endsWith(new P2PKH().lock(PublicKey.fromString(recv).toAddress()).toHex())).toBe(true);
    // Deterministic: prepared again over the same staged inputs, the same outputs.
    const pool = stateOf(swap1, v.identity);
    const again = await prepareSwap({ wallet: w.wallet, tokenId: TOKEN_ID, direction: "tokenToBsv", leg: legFor(pool, "tokenToBsv", 50_000n), pool, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, commissionPkh: null, tokenInputs: prepared.tokenInputs, satsInput: prepared.funding.input, satsPerKb: RATE, now: 1_000 });
    expect(again.swap.outputs.map((o) => o.lockingScript.toHex())).toEqual(tx.outputs.map((o) => o.lockingScript.toHex()));
  });
});

describe("the swap transaction", () => {
  it("sats in: [pool, the amm-swap sats output] → exactly the contract's outputs; the sats input validates; with the validator's signature every input does", async () => {
    const { prepared, vkey, side } = await satsIn();
    const s = prepared.swap;
    expect(s.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${poolDeploy.id("hex")}.0`, prepared.funding.outpoint]);
    expect(s.outputs.map((o) => [BigInt(o.satoshis!), o.lockingScript.toHex()])).toEqual(prepared.plan.outputs.map((o) => [o.satoshis, o.script]));
    expect(s.outputs[1]!.satoshis).toBe(1); // the token payout
    expect(spendValid(s, 1)).toBe(true);
    expect(spendValid(s, 0)).toBe(false); // the validator's slot is OP_0
    const final = await validatorSigns(prepared, s.toBinary(), vkey);
    for (const i of [0, 1]) expect(spendValid(final, i)).toBe(true);
    // The token payout (0.12.0): locked to a BRC-207 module receiving key whose sender is the pool's validator.
    if (prepared.payout.kind !== "color") throw new Error("expected a module receipt");
    const rc = prepared.payout.receipt;
    expect(rc).toMatchObject({ assetId: SDK_ID, senderIdentityKey: v.identity });
    const recv = side.publicKey({ protocolID: colorProtocolID(rc.assetId, rc.derivationPrefix, rc.derivationSuffix), keyID: "color", counterparty: v.identity, forSelf: true });
    expect(s.outputs[1]!.lockingScript.toHex().endsWith(new P2PKH().lock(PublicKey.fromString(recv).toAddress()).toHex())).toBe(true);
  });

  it("tokens in: [pool, the sats output, token] with their BEEF from the wallet's swap basket; the sats = 1 sat per 1Color fee or commission output − the token input's sat + fee; all valid", async () => {
    const { prepared, calls, vkey, side } = await tokensIn();
    // The identity and the BRC-29 payout key; the swap basket's BEEF; the sats and token inputs' signatures.
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "getPublicKey", "listOutputs", "createSignature", "getPublicKey", "createSignature", "getPublicKey"]);
    // The token inputs' sources: the active swap basket (0.12.0).
    expect(calls[2]!.args).toEqual({ basket: "amm-swap", include: "entire transactions", limit: 10000 });
    expect(prepared.funding.outputs).toBe(2); // LP fee, validator fee, commission: 3 sats − the token input's 1
    expect(prepared.commission).toEqual({ amount: 50n, pkh: v.commissionPkh, to: "relay" });
    const s = prepared.swap;
    expect(s.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${swap1.id("hex")}.0`, prepared.funding.outpoint, `${poolDeploy.id("hex")}.1`]);
    for (const i of [1, 2]) expect(spendValid(s, i)).toBe(true);
    const final = await validatorSigns(prepared, s.toBinary(), vkey);
    for (const i of [0, 1, 2]) expect(spendValid(final, i)).toBe(true);
    // The sats payout: a BRC-29 payment to self, as wallet-toolbox derives it.
    if (prepared.payout.kind !== "brc29") throw new Error("expected a BRC-29 payout");
    const r = prepared.payout.remittance;
    expect(r.senderIdentityKey).toBe(side.identityKey);
    const recipient = side.privateKey({ protocolID: BRC29, keyID: `${r.derivationPrefix} ${r.derivationSuffix}`, counterparty: r.senderIdentityKey });
    expect(s.outputs[1]!.lockingScript.toHex()).toBe(new P2PKH().lock(recipient.toAddress()).toHex());
    expect(isBrc29((calls[1]!.args as { protocolID: unknown }).protocolID)).toBe(true);
  });

  it("token inputs that do not add up exactly are not selected (token split is not built)", () => {
    const candidates = tokenInputsOf([tokenRow(), { ...tokenRow(), outpoint: `${poolDeploy.id("hex")}.0`, customInstructions: "{}" }], TOKEN_ID);
    expect(candidates.map((c) => [c.outpoint, c.amount])).toEqual([[`${poolDeploy.id("hex")}.1`, 50_000n]]);
    expect(selectExactTokenInputs(candidates, 49_999n)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

const ID = "swap-1";
const wirePool = {
  outpoint: `${"dd".repeat(32)}_0`,
  bsvReserve: 1039860,
  tokenReserve: 4808341,
  lpFeeBps: 30,
  validatorFeeBps: 5,
  commissionBps: 10,
  validatorIdentity: v.identity,
};

/** A fake AuthFetch over the app's /call route: answers by fn, records every request. */
function fakeRelay(answer: (fn: string, args: Record<string, unknown>, n: number) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }) {
  const calls: { url: string; method?: string; headers?: Record<string, string>; body: { fn: string; args: Record<string, unknown> } }[] = [];
  const af: AuthFetchLike = {
    async fetch(url, config) {
      const body = JSON.parse(config!.body!);
      calls.push({ url, method: config?.method, headers: config?.headers, body });
      const a = await answer(body.fn, body.args, calls.length);
      return { status: a.status, text: async () => JSON.stringify(a.body) };
    },
  };
  return { af, calls };
}
const ok = (fn: string, result: unknown) => ({ status: 200, body: { fn, result } });
const noSleep = async () => undefined;

describe("relay: amm.swap.submit / amm.swap.status over the app's /call route", () => {
  it("submits {funding (the sats output's transaction), swap, pool, validator, expires} as DAG-JSON bytes, polls while pending, accepts: internalize (basket insertion); no relinquishOutput", async () => {
    const { wallet, calls, prepared, vkey } = await satsIn();
    let final: Transaction | undefined;
    const { af, calls: http } = fakeRelay(async (fn, args, n) => {
      if (fn === "amm.swap.submit") {
        final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
        return ok(fn, { id: ID, status: "pending" });
      }
      return n < 3 ? ok(fn, { id: ID, status: "pending" }) : ok(fn, { id: ID, status: "accepted", tx: dagBytes(final!.toBinary()), txid: final!.id("hex") });
    });
    const seen: string[] = [];
    const before = calls.length;
    const o = await relaySwap({ wallet, authFetch: af, base: "http://amm2.localhost:8300/amm", sleep: noSleep, now: () => 0, onRecord: (r) => seen.push(r.status) }, prepared, PEER);

    expect(http.map((c) => [c.url, c.method, c.headers, c.body.fn])).toEqual([
      ["http://amm2.localhost:8300/amm/call", "POST", { "content-type": "application/json" }, "amm.swap.submit"],
      ["http://amm2.localhost:8300/amm/call", "POST", { "content-type": "application/json" }, "amm.swap.status"],
      ["http://amm2.localhost:8300/amm/call", "POST", { "content-type": "application/json" }, "amm.swap.status"],
    ]);
    expect(http[0]!.body.args).toEqual({
      funding: dagBytes(prepared.funding.atomicBeef),
      swap: dagBytes(prepared.swap.toBinary()),
      pool: `${poolDeploy.id("hex")}_0`,
      validator: dagBytes(Utils.toArray(v.identity, "hex")),
      peerId: PEER,
      expires: 121_000,
    });
    expect((http[0]!.body.args.funding as { "/": { bytes: string } })["/"].bytes).not.toMatch(/=/);
    expect(Beef.fromBinary(readBytes(http[0]!.body.args.funding)!).atomicTxid).toBe(prepared.funding.txid);
    expect(http[1]!.body.args).toEqual({ id: ID });
    expect(seen).toEqual(["pending", "pending", "accepted"]);

    expect(o).toMatchObject({ status: "accepted", id: ID, txid: final!.id("hex"), completed: { internalized: true, errors: [] } });
    const after = calls.slice(before);
    expect(after.map((c) => c.method)).toEqual(["internalizeAction"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[]; description: string };
    expect(Beef.fromBinary(ia.tx).atomicTxid).toBe(final!.id("hex"));
    if (prepared.payout.kind !== "color") throw new Error("expected a module receipt");
    // The module's receive: a basket insertion into `p color <txid>v0` with the receipt JSON (BRC-207).
    expect(ia.outputs).toEqual([
      {
        outputIndex: 1,
        protocol: "basket insertion",
        insertionRemittance: { basket: `p color ${TOKEN_ID.slice(0, 64)}v0`, customInstructions: colorReceiptInstructions(prepared.payout.receipt) },
      },
    ]);
    expect(JSON.parse(colorReceiptInstructions(prepared.payout.receipt))).toEqual({ version: 1, ...prepared.payout.receipt });
    expect(ia.labels).toEqual(["amm-swap"]);
    // The final swap spends the amm-swap sats output: taking it in marks it spent (the wallet's own rule).
    expect(`${final!.inputs[1]!.sourceTXID}.${final!.inputs[1]!.sourceOutputIndex}`).toBe(prepared.funding.outpoint);
    expect(calls.some((c) => c.method === "abortAction" || c.method === "relinquishOutput")).toBe(false);
  });

  it("tokens in, accepted: the payout as a wallet payment; nothing relinquished (0.29.0)", async () => {
    const { wallet, calls, prepared, vkey } = await tokensIn();
    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER);
    if (o.status !== "accepted" || prepared.payout.kind !== "brc29") throw new Error(`expected acceptance, got ${o.status}`);
    expect(o.completed).toEqual({ txid: o.txid, internalized: true, errors: [] });
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([{ outputIndex: 1, protocol: "wallet payment", paymentRemittance: prepared.payout.remittance }]);
    expect(calls.some((c) => c.method === "relinquishOutput")).toBe(false);
  });

  it("a transaction that is not ours is not internalized", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const other = Transaction.fromBinary(prepared.swap.toBinary());
    other.outputs[1]!.satoshis = 2;
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", tx: other.toHex(), txid: other.id("hex") }));
    await expect(relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER)).rejects.toThrow(/not the swap we built/);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("refused: nothing to undo (0.29.0: the leg's outputs stay in amm-swap), and the refusal's pool for the replan", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "refused", reason: "pool_spent", pool: `${poolDeploy.id("hex")}_0`, poolState: wirePool }));
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER);
    expect(o).toEqual({
      status: "refused",
      id: ID,
      reason: "pool_spent",
      pool: { outpoint: wirePool.outpoint, bsvReserve: 1039860n, tokenReserve: 4808341n, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: v.identity },
    });
    expect(calls.some((c) => c.method === "abortAction" || c.method === "internalizeAction" || c.method === "relinquishOutput")).toBe(false);
    // The engine replans against it.
    const req = buildPlanRequest(TOKEN_ID, { direction: "bsvToToken", amount: "20000", slippageBps: "500", allowPartial: true }, [o.status === "refused" ? o.pool! : stateOf(poolDeploy, v.identity)], liveFor([v.identity]), 0);
    if (!req.ok) throw new Error(req.error);
    expect(quote(req.request, liveFor([v.identity]), 0).plan.legs.map((l) => l.outpoint)).toEqual([wirePool.outpoint]);
  });

  it("timeout: nothing to undo", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn, _a, n) => ok(fn, { id: ID, status: n === 1 ? "pending" : "timeout" }));
    expect(await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep, now: () => 0 }, prepared, PEER)).toEqual({ status: "timeout", id: ID });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("an error answer to submit (the instance does not serve the function): nothing recorded, nothing to undo", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn) => ({ status: 404, body: { fn, error: { code: "unknown-fn", message: "amm.swap.submit is not provided" } } }));
    expect(await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER)).toEqual({ status: "failed", reason: "amm.swap.submit: unknown-fn: amm.swap.submit is not provided" });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("no answer: nothing is aborted; still pending past expiry + grace is unknown; Check again settles it", async () => {
    const { wallet, calls, prepared, vkey } = await satsIn();
    const lost: AuthFetchLike = { fetch: async () => { throw new Error("network down"); } };
    expect(await relaySwap({ wallet, authFetch: lost, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "unknown", reason: "amm.swap.submit: network down" });

    let t = 0;
    const pending = fakeRelay((fn) => ok(fn, { id: ID, status: "pending" }));
    const o = await relaySwap({ wallet, authFetch: pending.af, base: "http://x/amm", sleep: async () => void (t += 60_000), now: () => t }, prepared, PEER);
    expect(o).toEqual({ status: "unknown", id: ID, reason: "still pending past the swap's expiry" });
    expect(pending.calls.length).toBe(4); // submit + polls until 121,000 + 30,000
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);

    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const later = fakeRelay((fn) => ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") }));
    expect(await checkAgain({ wallet, authFetch: later.af, base: "http://x/amm", now: () => t }, prepared, ID)).toMatchObject({ status: "accepted", txid: final.id("hex") });
  });

  it("the relay's transport failure is no answer: nothing aborted", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "failed", reason: "dial", detail: "no route" }));
    expect(await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER)).toEqual({ status: "unknown", id: ID, reason: "the relay could not reach the validator (dial: no route)" });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("records: unknown status and missing fields are refused; pools in either naming; a closed pool is none", () => {
    expect(toPoolState({ ...wirePool, closed: true })).toBeUndefined();
    expect(toPoolState({ outpoint: "x_0" })).toBeUndefined();
    expect(toPoolState({ ...wirePool, validatorIdentity: dagBytes(Utils.toArray(v.identity, "hex")) })?.validatorIdentityKey).toBe(v.identity);
    expect(toPoolState({ outpoint: "x_0", bsvReserve: 1, tokenReserve: 2, liquidityFeeBps: 3, validationFeeBps: 4, validatorIdentityKey: "k" })).toEqual({
      outpoint: "x_0", bsvReserve: 1n, tokenReserve: 2n, liquidityFeeBps: 3n, validationFeeBps: 4n, commissionBps: 0n, validatorIdentityKey: "k",
    });
    expect(readBytes("0aff")).toEqual([10, 255]);
    expect(readBytes(dagBytes([1, 2, 3, 4]))).toEqual([1, 2, 3, 4]);
  });
});

describe("unfinished steps (0.29.3): a to-do list, no key material; Finish re-derives the key from the final transaction", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A fake instance over the final transaction: its token's one live pool, that pool's BEEF. */
  const instanceOf = (final: Transaction, asked: unknown[] = []): SignedFetch => {
    const beef = final.toAtomicBEEF(true);
    return { fetch: async (_url, init) => {
      const q = JSON.parse(String(init!.body));
      asked.push(q);
      const body = q.query.beef
        ? { type: "output-list", outputs: [{ beef, outputIndex: 0 }] }
        : { type: "freeform", result: [{ outpoint: `${final.id("hex")}_0`, bsvReserve: "1", tokenReserve: "1", liquidityFeeBps: 30, validationFeeBps: 5, validatorIdentityKey: v.identity }] };
      return new Response(JSON.stringify(body), { status: 200 });
    } };
  };
  const memKVOf = () => {
    const mem = new Map<string, string>();
    return { mem, kv: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, val: string) => void mem.set(k, val) } as KV };
  };

  it("tokens in (BRC-29 payout): the entry {id, kind, txid, vout, tokenId, base, createdAt, final} round-trips; after a reload Finish finds the signed swap in the pool's BEEF, re-derives the key from its input 2, takes it in, clears the entry", async () => {
    const { wallet, calls, prepared, vkey } = await tokensIn();
    const { mem, kv } = memKVOf();
    const service = `ls_amm_${TOKEN_ID}`;
    const [rec] = pendingSwapPayouts(prepared, TOKEN_ID, "http://x/amm", 1);
    expect(Object.keys(rec!).sort()).toEqual(["base", "createdAt", "final", "id", "kind", "tokenId", "txid", "vout"]);
    expect(new PendingPayoutStore(kv).save(rec!)).toBe(true);
    expect(JSON.parse(mem.get(PENDING_PAYOUTS_KEY)!)).toEqual({ [rec!.id]: rec });
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const store = new PendingPayoutStore(kv); // the reload
    expect(store.list()).toEqual([rec]);
    const asked: unknown[] = [];
    const r = await internalizeNow(wallet, store, instanceOf(final, asked), "http://x/amm", store.list()[0]!);
    expect(r).toEqual({ accepted: true, txid: final.id("hex") });
    expect(asked).toEqual([{ service, query: { tokenId: TOKEN_ID } }, { service, query: { tokenId: TOKEN_ID, outpoint: `${final.id("hex")}_0`, beef: true } }]);
    const ia = calls.filter((c) => c.method === "internalizeAction");
    expect(ia).toHaveLength(1);
    if (prepared.payout.kind !== "brc29") throw new Error("expected a BRC-29 payout");
    expect((ia[0]!.args as { outputs: unknown[] }).outputs).toEqual([{ outputIndex: 1, protocol: "wallet payment", paymentRemittance: prepared.payout.remittance }]);
    expect(store.list()).toEqual([]);
  });

  it("sats in (token payout): Finish re-derives the receipt (sender the pool's validator) from input 1 and takes it in through the module's basket", async () => {
    const { wallet, calls, prepared, vkey } = await satsIn();
    const { kv } = memKVOf();
    const store = new PendingPayoutStore(kv);
    const [rec] = pendingSwapPayouts(prepared, TOKEN_ID, "http://x/amm", 1);
    store.save(rec!);
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    expect(await internalizeNow(wallet, store, instanceOf(final), "http://x/amm", rec!)).toEqual({ accepted: true, txid: final.id("hex") });
    if (prepared.payout.kind !== "color") throw new Error("expected a receipt");
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([{ outputIndex: 1, protocol: "basket insertion", insertionRemittance: { basket: `p color ${TOKEN_ID.slice(0, 64)}v0`, customInstructions: colorReceiptInstructions(prepared.payout.receipt) } }]);
    expect(store.list()).toEqual([]);
  });

  it("another wallet's swap in the pool's BEEF is no match: not found, the entry stays", async () => {
    const { prepared, vkey } = await tokensIn();
    const [rec] = pendingSwapPayouts(prepared, TOKEN_ID, "http://x/amm", 1);
    const store = new PendingPayoutStore(memKVOf().kv);
    store.save(rec!);
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const stranger = brc29Side(key(77));
    const otherWallet = { ...fakeWallet().wallet, getPublicKey: async (a: { identityKey?: boolean }) => ({ publicKey: a.identityKey ? stranger.identityKey : stranger.publicKey(a as never) }) } as unknown as WalletInterface;
    await expect(internalizeNow(otherWallet, store, instanceOf(final), "http://x/amm", rec!)).rejects.toThrow(/not on the instance yet/);
    expect(store.list()).toEqual([rec]);
  });

  it("an entry from before 0.29.3 (a move back with its own receipt and AtomicBEEF, as Dan's): listed and finished once with its own bytes, no lookup", async () => {
    const w = fakeWallet();
    const me = w.side.identityKey;
    const derivationPrefix = "cHJlZml4MTIzNDU2Nzg5MA==";
    const derivationSuffix = "c3VmZml4MTIzNDU2Nzg5MA==";
    const receipt = { assetId: SDK_ID, derivationPrefix, derivationSuffix, senderIdentityKey: me };
    const recv = w.side.publicKey({ protocolID: colorProtocolID(SDK_ID, derivationPrefix, derivationSuffix), keyID: "color", counterparty: me, forSelf: true });
    const mb = new Transaction();
    mb.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: 1, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    mb.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenP2pkhScriptOf(SDK_ID, 200n, recv)) });
    mb.inputs[0]!.unlockingScript = await new P2PKH().unlock(taker).sign(mb, 0);
    const txid = mb.id("hex");
    for (const kind of ["move-back", "close"] as const) {
      const old = { id: `${txid}:0`, kind, txid, vout: 0, satoshis: 1, lockingScript: mb.outputs[0]!.lockingScript.toHex(), receipt, final: true, tokenId: SDK_ID, atomicBeef: Utils.toHex(mb.toAtomicBEEF(true)), description: "AMM move back: AMM2", createdAt: 1 };
      const { kv } = memKVOf();
      kv.setItem(PENDING_PAYOUTS_KEY, JSON.stringify({ [old.id]: old })); // as 0.29.2 and before wrote it
      const store = new PendingPayoutStore(kv);
      expect(store.list()).toEqual([old]);
      expect(isLegacyPayout(store.list()[0]!)).toBe(true);
      const none: SignedFetch = { fetch: async () => { throw new Error("no lookup for an entry with its own BEEF"); } };
      expect(await internalizeNow(w.wallet, store, none, "http://x/amm", store.list()[0]!)).toEqual({ accepted: true, txid });
      const ia = w.calls.filter((c) => c.method === "internalizeAction").at(-1)!.args as { outputs: unknown[] };
      expect(ia.outputs).toEqual([receiptOutput(0, receipt)]);
      expect(store.list()).toEqual([]);
    }
  });

  it("an old swap entry not found on the instance: an error, and the entry stays", async () => {
    const store = new PendingPayoutStore(memKVOf().kv);
    const rec = { id: `${"ab".repeat(32)}:1`, kind: "swap" as const, txid: "ab".repeat(32), vout: 1, satoshis: 5, lockingScript: "76a914" + "00".repeat(20) + "88ac", remittance: { derivationPrefix: "AA==", derivationSuffix: "AA==", senderIdentityKey: "02" + "11".repeat(32) }, final: false, tokenId: `${"cd".repeat(32)}_0`, description: "AMM swap payout", createdAt: 1 };
    store.save(rec);
    const af: SignedFetch = { fetch: async () => new Response(JSON.stringify({ type: "freeform", result: [] }), { status: 200 }) };
    await expect(internalizeNow(fakeWallet().wallet, store, af, "http://x/amm", rec)).rejects.toThrow(/not on the instance yet/);
    expect(store.list()).toEqual([rec]);
  });
});

// ---------------------------------------------------------------------------
// The commission: the relay's terms, or the taker's own key
// ---------------------------------------------------------------------------

describe("the commission", () => {
  it("amm.swap.terms: {fn, args: {}} on the app's /call route; commissionPkh as DAG-JSON bytes, or null; minCommissionBps (0.16.0), absent 0", async () => {
    const pkhBytes = Utils.toArray(v.commissionPkh, "hex");
    const { af, calls } = fakeRelay((fn) => ok(fn, { commissionPkh: dagBytes(pkhBytes) }));
    expect(await swapTerms(af, "http://amm2.localhost:8300/amm")).toEqual({ commissionPkh: v.commissionPkh, minCommissionBps: 0 });
    expect(calls.map((c) => [c.url, c.method, c.body])).toEqual([["http://amm2.localhost:8300/amm/call", "POST", { fn: "amm.swap.terms", args: {} }]]);
    const none = fakeRelay((fn) => ok(fn, { commissionPkh: null }));
    expect(await swapTerms(none.af, "http://x/amm")).toEqual({ commissionPkh: null, minCommissionBps: 0 });
    expect(parseSwapTerms({})).toEqual({ commissionPkh: null, minCommissionBps: 0 });
    expect(parseSwapTerms({ commissionPkh: v.commissionPkh })).toEqual({ commissionPkh: v.commissionPkh, minCommissionBps: 0 });
    expect(() => parseSwapTerms({ commissionPkh: dagBytes([1, 2, 3]) })).toThrow(/20 bytes/);
    // 0.16.0: the market's minimum commission (the record amm/market), absent 0.
    expect(parseSwapTerms({ commissionPkh: v.commissionPkh, minCommissionBps: 25 })).toEqual({ commissionPkh: v.commissionPkh, minCommissionBps: 25 });
    for (const bad of [-1, 1.5, 10_001, "1"]) expect(() => parseSwapTerms({ commissionPkh: null, minCommissionBps: bad })).toThrow(/minCommissionBps/);
    const missing = fakeRelay((fn) => ({ status: 404, body: { fn, error: { code: "unknown-fn", message: "amm.swap.terms is not provided" } } }));
    await expect(swapTerms(missing.af, "http://x/amm")).rejects.toThrow(/unknown-fn/);
  });

  it("sats in, no relay address: the commission (sats) is a BRC-29 payment to the taker's own key, recorded pending and internalized with the token payout", async () => {
    const { wallet, calls, prepared, vkey, side } = await satsIn(fakeWallet(), null);
    expect(calls.slice(0, 3).map((c) => c.method)).toEqual(["getPublicKey", "getPublicKey", "getPublicKey"]);
    expect(calls[0]!.args).toEqual({ identityKey: true });
    const c = prepared.commission;
    expect(c).toMatchObject({ amount: 20n, to: "own" });
    if (c.payout?.kind !== "brc29") throw new Error("expected a BRC-29 commission");
    const r = c.payout.remittance;
    const own = side.privateKey({ protocolID: BRC29, keyID: `${r.derivationPrefix} ${r.derivationSuffix}`, counterparty: r.senderIdentityKey });
    expect(c.pkh).toBe(Utils.toHex(own.toPublicKey().toHash() as number[]));
    expect(c.payout.outputIndex).toBe(4);
    expect(prepared.swap.outputs[4]!.satoshis).toBe(20);
    expect(prepared.swap.outputs[4]!.lockingScript.toHex()).toBe(new P2PKH().lock(own.toAddress()).toHex());
    expect(prepared.plan.args[5]).toBe(c.pkh);

    const recs = pendingSwapPayouts(prepared, TOKEN_ID, "http://x/amm", 1);
    // The token payout and the commission are both unfinished-step entries (0.29.3: no receipt or remittance in them).
    const txid0 = prepared.swap.id("hex");
    expect(recs).toEqual([
      { id: `${txid0}:1`, kind: "swap", txid: txid0, vout: 1, tokenId: TOKEN_ID, base: "http://x/amm", createdAt: 1, final: false },
      { id: `${txid0}:4`, kind: "swap", txid: txid0, vout: 4, tokenId: TOKEN_ID, base: "http://x/amm", createdAt: 1, final: false },
    ]);

    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER);
    if (o.status !== "accepted") throw new Error(`expected acceptance, got ${o.status}`);
    expect(o.completed.internalized).toBe(true);
    const ia = calls.find((x) => x.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: expect.objectContaining({ basket: `p color ${TOKEN_ID.slice(0, 64)}v0` }) },
      { outputIndex: 4, protocol: "wallet payment", paymentRemittance: r },
    ]);
  });

  it("tokens in, no relay address: the commission (tokens) is a 1Color output to a module receiving key of the taker's (sender: the validator), taken in through the module", async () => {
    const { wallet, calls, prepared, vkey, side } = await tokensIn(fakeWallet({ fundingVout: 2 }), null);
    const c = prepared.commission;
    expect(c).toMatchObject({ amount: 50n, to: "own" });
    if (c.payout?.kind !== "color") throw new Error("expected a module receipt");
    const rc = c.payout.receipt;
    expect(rc).toMatchObject({ assetId: SDK_ID, senderIdentityKey: v.identity });
    const own = PublicKey.fromString(side.publicKey({ protocolID: colorProtocolID(rc.assetId, rc.derivationPrefix, rc.derivationSuffix), keyID: "color", counterparty: v.identity, forSelf: true }));
    expect(c.payout.outputIndex).toBe(4);
    expect(prepared.swap.outputs[4]!.satoshis).toBe(1);
    const script = prepared.swap.outputs[4]!.lockingScript.toHex();
    expect(script).toBe(prepared.plan.outputs[4]!.script);
    expect(decodeOneColor(Utils.toArray(script, "hex"))).toMatchObject({ role: "value", amount: 50n });
    expect(script.endsWith(new P2PKH().lock(own.toAddress()).toHex())).toBe(true);
    expect(prepared.funding.outputs).toBe(2);
    // Both are pending records: the sats payout (BRC-29), the token commission (its receipt).
    expect(pendingSwapPayouts(prepared, TOKEN_ID, "http://x/amm", 1).map((r) => [r.vout, r.remittance, r.receipt])).toEqual([[1, undefined, undefined], [4, undefined, undefined]]);

    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      for (const i of [0, 1, 2]) expect(spendValid(final, i)).toBe(true);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm", sleep: noSleep }, prepared, PEER);
    if (o.status !== "accepted" || prepared.payout.kind !== "brc29") throw new Error(`expected acceptance, got ${o.status}`);
    const ia = calls.find((x) => x.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([
      { outputIndex: 1, protocol: "wallet payment", paymentRemittance: prepared.payout.remittance },
      { outputIndex: 4, protocol: "basket insertion", insertionRemittance: { basket: `p color ${TOKEN_ID.slice(0, 64)}v0`, customInstructions: colorReceiptInstructions(rc) } },
    ]);
  });

  it("a pool with CommissionBps 0: no commission output, no own key, whatever the relay says", async () => {
    const pool0 = PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)!;
    const zeroTx = new Transaction();
    zeroTx.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    zeroTx.addOutput({ satoshis: v.pool0.bsv, lockingScript: PoolTemplate.lockDeploy({ ...pool0.args, commissionBps: 0n }, pool0.state) });
    const pool = stateOf(zeroTx, v.identity);
    expect(pool.commissionBps).toBe(0n);
    for (const commissionPkh of [null, v.commissionPkh]) {
      const w = fakeWallet();
      const { calls } = w;
      const leg = legFor(pool, "bsvToToken", 20_000n);
      expect(leg.commission).toBe(0n);
      const { prepared } = await legOf(w, { tokenId: TOKEN_ID, direction: "bsvToToken", leg, pool, poolOutput: { beef: atomic(zeroTx), outputIndex: 0 }, commissionPkh, satsPerKb: RATE, now: 1_000 });
      expect(prepared.commission).toEqual({ amount: 0n, pkh: commissionPkh ?? "00".repeat(20), to: "none" });
      expect(prepared.plan.outputs).toHaveLength(4);
      expect(prepared.funding.outputs).toBe(20_001);
      expect(calls.some((c) => (c.args as { identityKey?: boolean }).identityKey)).toBe(false);
    }
  });
});
