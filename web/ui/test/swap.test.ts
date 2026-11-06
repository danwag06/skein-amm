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
import { computeSwap, type Leg, type PoolState } from "@dcasegr/amm-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRC29, brc29Side, isBrc29 } from "./brc29Wallet";
import { legTakeInOf, ownKeyInputOf, resolveFromOverlay } from "../src/wallet/swapPayouts";
import { receiptOutput } from "../src/wallet/color";
import { tokenP2pkhScript as tokenP2pkhScriptOf } from "../src/lp/poolDeploy";
import { PoolTemplate, decodeOneColor } from "../src/pool";
import { parseTokenTopic, toPoolState as poolOfWire, type LiveAnswer } from "../src/lib/overlay";
import { buildMarketView, marginalPrice, validatorStatus } from "../src/market/view";
import { buildPlanRequest, goneFromLookup, livePools, quote, type SwapForm } from "../src/market/plan";
import { PEER, liveFor } from "./liveRead";
import {
  LEG_CHANGE_PREFIX,
  LEG_COMMISSION_PREFIX,
  LEG_PAYOUT_PREFIX,
  assetIdOf,
  changeKeyID,
  legDerivation,
  legNeed,
  prepareSwap,
  selectLegInputs,
  spendValid,
  swapTxSize,
  tokenInputsOf,
  type PlanLegInput,
  type PreparedSwap,
  type SatsInput,
  type TokenInput,
} from "../src/market/swapAction";
import { dagBytes, parseSwapTerms, readBytes, swapTerms, toPoolState, type AuthFetchLike } from "../src/market/relay";
import { relaySwap, swapIdOf } from "../src/market/swapFlow";
import topics from "./fixtures/instance-v2/listTopicManagers.json";
import lookupAll from "./fixtures/instance-v2/lookup-all.json";
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
  // The v2 instance's recorded validator and peer, seen 5 s ago (0.34.0: the pools route's rows name it).
  const NOW = 1790844766808;
  const live = liveFor(["03cdee31ef0446ffb95aeae00353d9ab4c26a8555d597a9930b0ddd4f4cc1ae0d0"], NOW);
  const pools = (lookupAll as { result: Parameters<typeof poolOfWire>[0][] }).result.map(poolOfWire);

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

  it("a validator's status from the liveness the plan reads (0.34.0: the pools route's rows): live with its peer ID, case-insensitive; unknown keys not seen", () => {
    const id = live.validators[0]!.identityKey;
    expect(validatorStatus(id.toUpperCase(), live)).toMatchObject({ live: true, seen: true, peerId: PEER });
    expect(validatorStatus("02" + "99".repeat(32), live)).toEqual({ identityKey: "02" + "99".repeat(32), live: false, seen: false });
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
    expect(buildPlanRequest(TOKEN_ID, form, [poolA], { now: 0, validators: [], kept: false }, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/keeps no liveness/) });
    // A validator seen 200 s ago: planned (the pages keep no window of their own).
    const old: LiveAnswer = { now: 200_000, kept: true, validators: [{ identityKey: poolA.validatorIdentityKey, peerId: PEER, at: 0, ageMs: 200_000, live: true }] };
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

/** An `amm-swap` sats row of `satoshis` (0.40.0: what `stage` makes), funded from fund:`w.fundingVout`, held by the fake wallet. */
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

/** A sats row big enough for any leg, to read a leg's need with (`selectLegInputs` reads only its sats). */
const probe: SatsInput = { outpoint: `${"ff".repeat(32)}.0`, txid: "ff".repeat(32), vout: 0, satoshis: 1_000_000_000, lockingScript: "76a914" + "00".repeat(20) + "88ac", protocolID: SWAP_KEYS, keyID: "probe", counterparty: "self" };

/** The leg's need, then a staged sats row of exactly that much plus `extra`, then the leg built (as executeSwap does). */
async function legOf(w: ReturnType<typeof fakeWallet>, i: Omit<PlanLegInput, "wallet"> & { tokens?: TokenInput[]; extra?: number; last?: boolean; order?: string; now?: number }) {
  const common = { ...i, wallet: w.wallet };
  const need = selectLegInputs(common, [probe], i.tokens ?? [])!.need;
  const satsInput = await stagedSats(w, need.need + (i.extra ?? 0));
  const inputs = selectLegInputs(common, [satsInput], i.tokens ?? [])!;
  const prepared = await prepareSwap({ ...common, inputs, last: i.last ?? false, ...(i.order ? { order: i.order } : {}) });
  return { need, satsInput, inputs, prepared };
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
async function satsIn(w = fakeWallet(), commissionPkh: string | null = v.commissionPkh, o: { extra?: number; last?: boolean; order?: string } = {}) {
  const pool = stateOf(poolDeploy, v.identity);
  const leg = legFor(pool, "bsvToToken", 20_000n);
  const r = await legOf(w, { tokenId: TOKEN_ID, meta: { sym: "TST", dec: 0 }, direction: "bsvToToken", leg, pool, poolOutput: { beef: atomic(poolDeploy), outputIndex: 0 }, commissionPkh, satsPerKb: RATE, now: 1_000, ...o });
  return { ...w, ...r, pool, leg, vkey: identity.deriveChild(anyone, `1-amm pool-${v.nonce}`) }; // 0.13.0: the deploy's key is keyed by the nonce
}

/** Tokens in on the fixture's second pool (swap_bsv_in:0), `amountIn` tokens from pool_deploy:1's 50,000 (0.40.0: the rest is the token change). */
async function tokensIn(w = fakeWallet({ fundingVout: 2 }), commissionPkh: string | null = v.commissionPkh, o: { amountIn?: bigint; extra?: number; last?: boolean; order?: string } = {}) {
  const pool = stateOf(swap1, v.identity);
  const leg = legFor(pool, "tokenToBsv", o.amountIn ?? 50_000n);
  const tokens = tokenInputsOf([tokenRow()], TOKEN_ID);
  const r = await legOf(w, { tokenId: TOKEN_ID, direction: "tokenToBsv", leg, pool, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, commissionPkh, tokens, satsPerKb: RATE, now: 1_000, ...o });
  return { ...w, ...r, pool, leg, vkey: validatorKey(poolDeploy.id("hex"), 0) };
}

/** What the validator does: fills its slot (over the raw swap it received). */
async function validatorSigns(p: PreparedSwap, raw: number[], vkey: PrivateKey): Promise<Transaction> {
  const tx = Transaction.fromBinary(raw);
  tx.inputs.forEach((inp, n) => (inp.sourceTransaction = p.swap.inputs[n]!.sourceTransaction));
  await PoolTemplate.signPoolInput({ tx, pool: p.plan.pool, method: "swap", unsigned: ["validator"] }, "validator", vkey);
  return tx;
}

describe("the leg's sats (0.40.0: the staged rows that cover it, largest first; Rúnar's sats change)", () => {
  it("the recorded lookup BEEF (v2 instance, before the commission) parses; its pool is the pre-commission template, which no longer decodes", () => {
    // Recorded when the instance ran the previous fixtures (pool_deploy without
    // CommissionBps); the swaps below use the current pool_deploy as the lookup's AtomicBEEF.
    const [out] = (beefAnswer as { outputs: { beef: number[]; outputIndex: number }[] }).outputs;
    const tx = Transaction.fromAtomicBEEF(out!.beef);
    expect(tx.id("hex")).not.toBe(poolDeploy.id("hex"));
    expect(PoolTemplate.decode(tx.outputs[out!.outputIndex]!.lockingScript)).toBeNull();
    expect(PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)).not.toBeNull();
    expect(assetIdOf(TOKEN_ID)).toBe(Utils.toHex(tokenDeploy.hash() as number[]));
  });

  it("sats in: the leg spends the amm-swap sats row — no createAction; the wallet call sequence; the relay's funding is that row's transaction", async () => {
    const { calls, prepared, satsInput } = await satsIn();
    // The identity; the payout key (a module receiving key for self); the swap basket's BEEF; the sats input's signature.
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "getPublicKey", "listOutputs", "createSignature", "getPublicKey"]);
    expect(calls.some((c) => c.method === "createAction" || c.method === "signAction")).toBe(false);
    expect(calls[2]!.args).toEqual({ basket: "amm-swap", include: "entire transactions", limit: 10000 });
    expect(prepared.satsInputs).toEqual([satsInput]);
    expect(prepared.funding.txid).toBe(satsInput.txid);
    expect(Beef.fromBinary(prepared.funding.atomicBeef).atomicTxid).toBe(satsInput.txid);
    expect(prepared.expires).toBe(1_000 + 15_000); // 0.34.0 (D15): SWAP_TTL_MS 15 s
    expect(calls[3]!.args).toMatchObject({ protocolID: [2, "amm swap"], keyID: satsInput.keyID, counterparty: "self" });
    // The order's key input: the first leg's own first sats input.
    expect(prepared.order).toBe(satsInput.outpoint);
  });

  it("the need: amount in + 1 sat for the token payout (the fees and the commission are part of amount in), plus the fee at the rate over the final size; a row of exactly that: no change output", async () => {
    const { prepared, vkey, need } = await satsIn();
    expect(need.outputs).toBe(20_001);
    expect(need.fee).toBe(Math.ceil((swapTxSize(prepared.plan, 1) * RATE) / 1000));
    expect(need.need).toBe(20_001 + need.fee);
    expect(need.feeWithChange).toBe(Math.ceil((swapTxSize(prepared.plan, 1, true) * RATE) / 1000));
    expect(prepared.satsChange).toBeUndefined();
    expect(prepared.swap.outputs).toHaveLength(prepared.plan.outputs.length);
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const ins = final.inputs.reduce((a, i) => a + (i.sourceTransaction?.outputs[i.sourceOutputIndex]?.satoshis ?? 0), 0);
    expect(ins - final.outputs.reduce((a, o) => a + o.satoshis!, 0)).toBe(need.fee);
    expect(final.toBinary().length).toBeLessThanOrEqual(swapTxSize(prepared.plan, 1));
    for (const i of [0, 1]) expect(spendValid(final, i)).toBe(true);
    expect(prepared.commission).toEqual({ amount: 20n, pkh: v.commissionPkh, to: "relay" });
    expect(prepared.plan.outputs[4]).toEqual({ satoshis: 20n, script: `76a914${v.commissionPkh}88ac` });
    expect(legNeed(prepared.plan, [], 1, 0).need).toBe(20_001);
  });

  it("a row larger than the need: Rúnar's sats change (row − the need with the change output counted), not the last leg → an amm-swap key of the leg's first sats input, with the order", async () => {
    const { prepared, vkey, need, satsInput, side } = await satsIn(fakeWallet(), v.commissionPkh, { extra: 5_000 });
    const change = need.need + 5_000 - need.needWithChange;
    expect(prepared.satsChange).toMatchObject({ kind: "basket", outputIndex: 5, satoshis: change });
    const keyID = `amm-swap-${satsInput.outpoint}:change`;
    const pub = side.publicKey({ protocolID: SWAP_KEYS, keyID, counterparty: "self", forSelf: true });
    expect(prepared.swap.outputs[5]!.lockingScript.toHex()).toBe(new P2PKH().lock(PublicKey.fromString(pub).toAddress()).toHex());
    expect(JSON.parse((prepared.satsChange as { customInstructions: string }).customInstructions)).toEqual({ sats: true, protocolID: SWAP_KEYS, keyID, counterparty: "self", order: satsInput.outpoint });
    // The contract commits to it: Rúnar's change parameters name it; every input validates once the validator signs.
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    for (const i of [0, 1]) expect(spendValid(final, i)).toBe(true);
  });

  it("the last leg: its sats change to the wallet — a BRC-29 key of the user's, derived from the order with the kind \"change\"", async () => {
    const order = `${"0e".repeat(32)}.4`;
    const { prepared, vkey, side } = await satsIn(fakeWallet(), v.commissionPkh, { extra: 5_000, last: true, order });
    if (prepared.satsChange?.kind !== "brc29") throw new Error("expected a wallet payment");
    expect(prepared.satsChange.remittance).toEqual({ ...legDerivation(order, "change"), senderIdentityKey: side.identityKey });
    const k = side.privateKey({ protocolID: BRC29, keyID: `${LEG_CHANGE_PREFIX} ${legDerivation(order, "change").derivationSuffix}`, counterparty: side.identityKey });
    expect(prepared.swap.outputs[5]!.lockingScript.toHex()).toBe(new P2PKH().lock(k.toAddress()).toHex());
    // The payout too is the order's, not this leg's own input.
    if (prepared.payout.kind !== "color") throw new Error("expected a receipt");
    expect(prepared.payout.receipt).toMatchObject(legDerivation(order, "payout"));
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    for (const i of [0, 1]) expect(spendValid(final, i)).toBe(true);
  });

  it("rows that cannot cover the leg: none selected (the swap stops `fees`); several rows: largest first, as many as cover", async () => {
    const w = fakeWallet();
    const pool = stateOf(poolDeploy, v.identity);
    const leg = legFor(pool, "bsvToToken", 20_000n);
    const i = { wallet: w.wallet, tokenId: TOKEN_ID, direction: "bsvToToken" as const, leg, pool, poolOutput: { beef: atomic(poolDeploy), outputIndex: 0 }, commissionPkh: v.commissionPkh, satsPerKb: RATE };
    const small = await stagedSats(w, 5_000);
    const big = await stagedSats(w, 18_000);
    const extra = await stagedSats(w, 9_000);
    expect(selectLegInputs(i, [small], [])).toBeNull();
    const got = selectLegInputs(i, [small, big, extra], [])!;
    expect(got.sats.map((r) => r.satoshis)).toEqual([18_000, 9_000]);
    const prepared = await prepareSwap({ ...i, inputs: got, last: false });
    expect(prepared.swap.inputs.map((x) => `${x.sourceTXID}.${x.sourceOutputIndex}`)).toEqual([`${poolDeploy.id("hex")}.0`, big.outpoint, extra.outpoint]);
    for (const n of [1, 2]) expect(spendValid(prepared.swap, n)).toBe(true);
    // The order's key input and the change key: the first sats input (the largest).
    expect(prepared.order).toBe(big.outpoint);
    expect((prepared.satsChange as { customInstructions: string }).customInstructions).toContain(`amm-swap-${big.outpoint}:change`);
  });

  it("a pool that moved since the plan is refused before the wallet is asked", async () => {
    const pool = { ...stateOf(poolDeploy, v.identity), outpoint: `${"cc".repeat(32)}_0` };
    const { wallet, calls } = fakeWallet();
    expect(() => selectLegInputs({ wallet, tokenId: TOKEN_ID, direction: "bsvToToken", leg: legFor(pool, "bsvToToken", 20_000n), pool, poolOutput: { beef: atomic(poolDeploy), outputIndex: 0 }, commissionPkh: null, satsPerKb: RATE }, [probe], [])).toThrow(/the pool moved/);
    expect(calls).toEqual([]);
  });
});

describe("the payout keys (0.40.0): ONE derivation per order, from the order's key input; the token receipt for self", () => {
  const b64 = (t: string) => Utils.toBase64(Utils.toArray(t, "utf8"));
  const suffixOf = (outpoint: string) => Utils.toBase64(Hash.sha256(Utils.toArray(outpoint, "utf8")) as number[]);

  it("the rule: prefix base64(\"amm swap\") (payout), \"amm swap commission\" (own commission), \"amm swap change\" (the last leg's change); suffix base64(sha256(\"<txid>.<vout>\"))", () => {
    expect(LEG_PAYOUT_PREFIX).toBe(b64("amm swap"));
    expect(LEG_COMMISSION_PREFIX).toBe(b64("amm swap commission"));
    expect(LEG_CHANGE_PREFIX).toBe(b64("amm swap change"));
    const op = `${"ab".repeat(32)}.3`;
    expect(legDerivation(op, "payout")).toEqual({ derivationPrefix: b64("amm swap"), derivationSuffix: suffixOf(op) });
    expect(legDerivation(op, "commission")).toEqual({ derivationPrefix: b64("amm swap commission"), derivationSuffix: suffixOf(op) });
    expect(legDerivation(op, "change")).toEqual({ derivationPrefix: b64("amm swap change"), derivationSuffix: suffixOf(op) });
    expect(changeKeyID(op)).toBe(`amm-swap-${op}:change`);
  });

  it("sats in, own commission, the first leg: from its own first sats input — the token payout's receipt key (sender the USER: for self) and the commission's BRC-29 key match outputs 1 and 4", async () => {
    const { prepared, satsInput, side } = await satsIn(fakeWallet(), null);
    const tx = Transaction.fromBinary(prepared.swap.toBinary());
    expect(prepared.order).toBe(satsInput.outpoint);
    const pay = legDerivation(satsInput.outpoint, "payout");
    if (prepared.payout.kind !== "color") throw new Error("expected a receipt");
    expect(prepared.payout.receipt).toEqual({ assetId: SDK_ID, ...pay, senderIdentityKey: side.identityKey });
    const recv = side.publicKey({ protocolID: colorProtocolID(SDK_ID, pay.derivationPrefix, pay.derivationSuffix), keyID: "color", counterparty: side.identityKey, forSelf: true });
    expect(tx.outputs[1]!.lockingScript.toHex().endsWith(new P2PKH().lock(PublicKey.fromString(recv).toAddress()).toHex())).toBe(true);
    const com = legDerivation(satsInput.outpoint, "commission");
    const own = side.privateKey({ protocolID: BRC29, keyID: `${com.derivationPrefix} ${com.derivationSuffix}`, counterparty: side.identityKey });
    expect(tx.outputs[4]!.lockingScript.toHex()).toBe(new P2PKH().lock(own.toAddress()).toHex());
  });

  it("a later leg of the order: the same payout key whatever it spends", async () => {
    const order = `${"0d".repeat(32)}.2`;
    const a = await satsIn(fakeWallet(), null, { order });
    const b = await satsIn(fakeWallet(), null, { order, extra: 777 });
    expect(a.prepared.swap.outputs[1]!.lockingScript.toHex()).toBe(b.prepared.swap.outputs[1]!.lockingScript.toHex());
    expect(a.prepared.order).toBe(order);
    expect(a.prepared.satsInputs[0]!.outpoint).not.toBe(b.prepared.satsInputs[0]!.outpoint);
  });

  it("tokens in, own commission: from the first token row — the BRC-29 payout (sender the user) and the commission's receipt (for self) match outputs 1 and 4", async () => {
    const w = fakeWallet({ fundingVout: 2 });
    const { prepared, side } = await tokensIn(w, null);
    const tx = Transaction.fromBinary(prepared.swap.toBinary());
    const keyInput = `${poolDeploy.id("hex")}.1`;
    expect(prepared.order).toBe(keyInput);
    const pay = legDerivation(keyInput, "payout");
    const payKey = side.privateKey({ protocolID: BRC29, keyID: `${pay.derivationPrefix} ${pay.derivationSuffix}`, counterparty: side.identityKey });
    expect(tx.outputs[1]!.lockingScript.toHex()).toBe(new P2PKH().lock(payKey.toAddress()).toHex());
    const com = legDerivation(keyInput, "commission");
    const recv = side.publicKey({ protocolID: colorProtocolID(SDK_ID, com.derivationPrefix, com.derivationSuffix), keyID: "color", counterparty: side.identityKey, forSelf: true });
    expect(tx.outputs[4]!.lockingScript.toHex().endsWith(new P2PKH().lock(PublicKey.fromString(recv).toAddress()).toHex())).toBe(true);
  });
});

describe("the swap transaction", () => {
  it("sats in: [pool, the amm-swap sats row] → exactly the contract's outputs; the sats input validates; with the validator's signature every input does", async () => {
    const { prepared, vkey } = await satsIn();
    const s = prepared.swap;
    expect(s.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${poolDeploy.id("hex")}.0`, prepared.satsInputs[0]!.outpoint]);
    expect(s.outputs.map((o) => [BigInt(o.satoshis!), o.lockingScript.toHex()])).toEqual(prepared.plan.outputs.map((o) => [o.satoshis, o.script]));
    expect(s.outputs[1]!.satoshis).toBe(1); // the token payout
    expect(spendValid(s, 1)).toBe(true);
    expect(spendValid(s, 0)).toBe(false); // the validator's slot is OP_0
    const final = await validatorSigns(prepared, s.toBinary(), vkey);
    for (const i of [0, 1]) expect(spendValid(final, i)).toBe(true);
  });

  it("tokens in, the whole row: [pool, the sats row, the token row]; no token change; all valid; the payout a BRC-29 payment to self", async () => {
    const { prepared, calls, vkey, side, need } = await tokensIn();
    expect(calls[0]!.args).toEqual({ identityKey: true });
    expect(need.outputs).toBe(2); // LP fee, validator fee, commission: 3 sats − the token input's 1
    expect(prepared.commission).toEqual({ amount: 50n, pkh: v.commissionPkh, to: "relay" });
    expect(prepared.tokenChange).toBeUndefined();
    const s = prepared.swap;
    expect(s.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${swap1.id("hex")}.0`, prepared.satsInputs[0]!.outpoint, `${poolDeploy.id("hex")}.1`]);
    for (const i of [1, 2]) expect(spendValid(s, i)).toBe(true);
    const final = await validatorSigns(prepared, s.toBinary(), vkey);
    for (const i of [0, 1, 2]) expect(spendValid(final, i)).toBe(true);
    if (prepared.payout.kind !== "brc29") throw new Error("expected a BRC-29 payout");
    const r = prepared.payout.remittance;
    expect(r.senderIdentityKey).toBe(side.identityKey);
    const recipient = side.privateKey({ protocolID: BRC29, keyID: `${r.derivationPrefix} ${r.derivationSuffix}`, counterparty: r.senderIdentityKey });
    expect(s.outputs[1]!.lockingScript.toHex()).toBe(new P2PKH().lock(recipient.toAddress()).toHex());
  });

  it("tokens in, part of the row: the token change (row − amountIn) after the commission, 1 sat — not the last leg → the amm-swap key of the first token row, with the order; the contract's call names it", async () => {
    const { prepared, vkey, side } = await tokensIn(fakeWallet({ fundingVout: 2 }), v.commissionPkh, { amountIn: 40_000n });
    const tokenRowOp = `${poolDeploy.id("hex")}.1`;
    if (prepared.tokenChange?.kind !== "basket") throw new Error("expected the token change in amm-swap");
    expect(prepared.tokenChange.outputIndex).toBe(5);
    const keyID = `amm-swap-${tokenRowOp}:change`;
    const pub = side.publicKey({ protocolID: SWAP_KEYS, keyID, counterparty: "self", forSelf: true });
    expect(prepared.swap.outputs[5]!.lockingScript.toHex()).toBe(tokenP2pkhScriptOf(SDK_ID, 10_000n, pub));
    expect(prepared.swap.outputs[5]!.satoshis).toBe(1);
    expect(JSON.parse(prepared.tokenChange.customInstructions)).toEqual({ assetId: SDK_ID, amount: "10000", protocolID: SWAP_KEYS, keyID, counterparty: "self", order: tokenRowOp });
    expect(prepared.plan.args.slice(6)).toEqual([Utils.toHex(PublicKey.fromString(pub).toHash() as number[]), 10_000n]);
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    for (const i of [0, 1, 2]) expect(spendValid(final, i)).toBe(true);
  });

  it("tokens in, part of the row, the last leg: the token change to a module receiving key for self (kind \"change\")", async () => {
    const order = `${poolDeploy.id("hex")}.1`;
    const { prepared, vkey, side } = await tokensIn(fakeWallet({ fundingVout: 2 }), v.commissionPkh, { amountIn: 40_000n, last: true });
    if (prepared.tokenChange?.kind !== "color") throw new Error("expected a receipt");
    expect(prepared.tokenChange.receipt).toEqual({ assetId: SDK_ID, ...legDerivation(order, "change"), senderIdentityKey: side.identityKey });
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    for (const i of [0, 1, 2]) expect(spendValid(final, i)).toBe(true);
  });

  it("token rows: largest first, as many as cover amountIn; a token's other rows not taken", () => {
    const candidates = tokenInputsOf([tokenRow(), { ...tokenRow(), outpoint: `${poolDeploy.id("hex")}.0`, customInstructions: "{}" }], TOKEN_ID);
    expect(candidates.map((c) => [c.outpoint, c.amount])).toEqual([[`${poolDeploy.id("hex")}.1`, 50_000n]]);
    const w = fakeWallet({ fundingVout: 2 });
    const pool = stateOf(swap1, v.identity);
    const i = { wallet: w.wallet, tokenId: TOKEN_ID, direction: "tokenToBsv" as const, leg: legFor(pool, "tokenToBsv", 60_000n), pool, poolOutput: { beef: atomic(swap1), outputIndex: 0 }, commissionPkh: null, satsPerKb: RATE };
    expect(selectLegInputs(i, [probe], candidates)).toBeNull();
    const more = [...candidates, { ...candidates[0]!, outpoint: `${"ee".repeat(32)}.1`, txid: "ee".repeat(32), amount: 20_000n }, { ...candidates[0]!, outpoint: `${"ef".repeat(32)}.1`, txid: "ef".repeat(32), amount: 5_000n }];
    expect(selectLegInputs(i, [probe], more)!.tokens.map((t) => t.amount)).toEqual([50_000n, 20_000n]);
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

describe("relay: amm.swap.submit over the app's /call route (0.34.0: held until the relay rests)", () => {
  it("submits {funding (the first sats row's transaction), swap, pool, validator, expires} as DAG-JSON bytes; the held answer is the settled record (0.34.0, D15: no poll); accepts: internalize (basket insertion); no relinquishOutput", async () => {
    const { wallet, calls, prepared, vkey } = await satsIn();
    let final: Transaction | undefined;
    const { af, calls: http } = fakeRelay(async (fn, args) => {
      final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      return ok(fn, { id: ID, status: "accepted", tx: dagBytes(final.toBinary()), txid: final.id("hex") });
    });
    const before = calls.length;
    const o = await relaySwap({ wallet, authFetch: af, base: "http://amm2.localhost:8300/amm" }, prepared, PEER);

    expect(http.map((c) => [c.url, c.method, c.headers, c.body.fn])).toEqual([["http://amm2.localhost:8300/amm/call", "POST", { "content-type": "application/json" }, "amm.swap.submit"]]);
    expect(http[0]!.body.args).toEqual({
      funding: dagBytes(prepared.funding.atomicBeef),
      swap: dagBytes(prepared.swap.toBinary()),
      pool: `${poolDeploy.id("hex")}_0`,
      validator: dagBytes(Utils.toArray(v.identity, "hex")),
      peerId: PEER,
      expires: 16_000, // 0.34.0 (D15): 15 s after the leg was prepared
    });
    expect((http[0]!.body.args.funding as { "/": { bytes: string } })["/"].bytes).not.toMatch(/=/);
    expect(Beef.fromBinary(readBytes(http[0]!.body.args.funding)!).atomicTxid).toBe(prepared.funding.txid);

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
    // The final swap spends the amm-swap sats row: taking it in marks it spent (the wallet's own rule).
    expect(`${final!.inputs[1]!.sourceTXID}.${final!.inputs[1]!.sourceOutputIndex}`).toBe(prepared.satsInputs[0]!.outpoint);
    expect(calls.some((c) => c.method === "abortAction" || c.method === "relinquishOutput")).toBe(false);
  });

  it("0.40.0: accepted, ONE internalizeAction — the payout, and the change kept in amm-swap (basket insertion with its customInstructions)", async () => {
    const { wallet, calls, prepared, vkey } = await tokensIn(fakeWallet({ fundingVout: 2 }), v.commissionPkh, { amountIn: 40_000n, extra: 3_000 });
    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER);
    if (o.status !== "accepted" || prepared.payout.kind !== "brc29" || prepared.tokenChange?.kind !== "basket" || prepared.satsChange?.kind !== "basket") throw new Error("expected acceptance with both changes");
    const ia = calls.filter((c) => c.method === "internalizeAction");
    expect(ia).toHaveLength(1);
    expect((ia[0]!.args as { outputs: unknown[] }).outputs).toEqual([
      { outputIndex: 1, protocol: "wallet payment", paymentRemittance: prepared.payout.remittance },
      { outputIndex: 5, protocol: "basket insertion", insertionRemittance: { basket: "amm-swap", customInstructions: prepared.tokenChange.customInstructions } },
      { outputIndex: 6, protocol: "basket insertion", insertionRemittance: { basket: "amm-swap", customInstructions: prepared.satsChange.customInstructions } },
    ]);
  });

  it("tokens in, accepted: the payout as a wallet payment; nothing relinquished (0.29.0)", async () => {
    const { wallet, calls, prepared, vkey } = await tokensIn();
    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER);
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
    await expect(relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER)).rejects.toThrow(/not the swap we built/);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("refused: nothing to undo (0.29.0: the leg's outputs stay in amm-swap), and the refusal's pool for the replan", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "refused", reason: "pool_spent", pool: `${poolDeploy.id("hex")}_0`, poolState: wirePool }));
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER);
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

  it("timeout: nothing to undo; a pending record (the host let go before the relay rested): no answer yet, its id kept", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const pending = fakeRelay((fn) => ok(fn, { id: ID, status: "pending" }));
    expect(await relaySwap({ wallet, authFetch: pending.af, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "unknown", id: ID, reason: "no answer yet" });
    expect(pending.calls).toHaveLength(1);
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "timeout" }));
    expect(await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "timeout", id: ID });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("an error answer to submit (the instance does not serve the function): nothing recorded, nothing to undo", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn) => ({ status: 404, body: { fn, error: { code: "unknown-fn", message: "amm.swap.submit is not provided" } } }));
    expect(await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "failed", reason: "amm.swap.submit: unknown-fn: amm.swap.submit is not provided" });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("no answer (a network failure, the host's 503 past its bound): nothing is aborted, the swap's id (sha256 of the swap) kept", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const id = swapIdOf(prepared);
    expect(id).toBe(Utils.toHex(Hash.sha256(prepared.swap.toBinary()) as number[]));
    const lost: AuthFetchLike = { fetch: async () => { throw new Error("network down"); } };
    expect(await relaySwap({ wallet, authFetch: lost, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "unknown", id, reason: "no answer yet: amm.swap.submit: network down" });
    const bound = fakeRelay(() => ({ status: 503, body: "the request is still waiting" }));
    expect(await relaySwap({ wallet, authFetch: bound.af, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "unknown", id, reason: "no answer yet" });
    expect(calls.some((c) => c.method === "abortAction")).toBe(false);
  });

  it("the relay's transport failure is no answer: nothing aborted", async () => {
    const { wallet, calls, prepared } = await satsIn();
    const { af } = fakeRelay((fn) => ok(fn, { id: ID, status: "failed", reason: "dial", detail: "no route" }));
    expect(await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER)).toEqual({ status: "unknown", id: ID, reason: "the relay could not reach the validator (dial: no route)" });
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

describe("resolve from the overlay (0.40.0): every amm-swap row's spender (ONE /amm/spends), its /tx, this wallet's leg taken in", () => {
  /** The leg's rows as the wallet lists them in `amm-swap` (`order` on a change row). */
  const rowsOf = (prepared: PreparedSwap) => [
    ...prepared.satsInputs.map((r) => ({ outpoint: r.outpoint, satoshis: r.satoshis, lockingScript: r.lockingScript, customInstructions: JSON.stringify({ sats: true, protocolID: SWAP_KEYS, keyID: r.keyID, counterparty: "self", ...(r.order ? { order: r.order } : {}) }) })),
    ...prepared.tokenInputs.map((r) => ({ outpoint: r.outpoint, satoshis: r.satoshis, lockingScript: r.lockingScript, customInstructions: JSON.stringify({ protocolID: r.protocolID, keyID: r.keyID, counterparty: r.counterparty }) })),
  ];
  /** The wallet with its `amm-swap` rows (taken in once: then none). */
  const withRows = (w: ReturnType<typeof fakeWallet>, rows: unknown[]) => {
    let left = rows;
    return {
      ...w.wallet,
      listOutputs: async (a: { basket?: string }) => (a.basket === "amm-swap" ? { totalOutputs: left.length, outputs: left } : w.wallet.listOutputs(a as never)),
      internalizeAction: async (a: never) => {
        const r = await w.wallet.internalizeAction(a);
        left = [];
        return r;
      },
    } as unknown as WalletInterface;
  };
  /** The host's `/amm/spends` (every row spent by `spentBy`) and the token instance's `/tx`. */
  const readsOf = (spentBy: Transaction | null, asked: string[] = []) => ({
    spendsAll: async (ops: string[]) => {
      asked.push(`spends ${ops.join(",")}`);
      return ops.map((outpoint) => ({ outpoint, ...(spentBy ? { tokenId: TOKEN_ID, spentBy: spentBy.id("hex") } : {}) }));
    },
    tx: async (tokenId: string, txid: string) => {
      asked.push(`tx ${tokenId} ${txid}`);
      return spentBy && txid === spentBy.id("hex") ? spentBy.toAtomicBEEF(true) : null;
    },
  });

  it("a first leg (sats in) landed while the page was lost: ONE /amm/spends over the rows, its /tx, the receipt (for self) and the change taken in with the leg's own key input as the order", async () => {
    const w = fakeWallet();
    const { prepared, vkey } = await satsIn(w, v.commissionPkh, { extra: 4_000 });
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    expect(ownKeyInputOf(final)).toBe(prepared.order);
    const asked: string[] = [];
    const taken = await resolveFromOverlay(withRows(w, rowsOf(prepared)), readsOf(final, asked));
    expect(taken.map((t) => t.txid)).toEqual([final.id("hex")]);
    // Then again: the take-in left no row with a spender, so nothing more is read.
    expect(asked).toEqual([`spends ${prepared.satsInputs[0]!.outpoint}`, `tx ${TOKEN_ID} ${final.id("hex")}`]);
    if (prepared.payout.kind !== "color" || prepared.satsChange?.kind !== "basket") throw new Error("expected a receipt and a change row");
    const ia = w.calls.find((c) => c.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: { basket: `p color ${TOKEN_ID.slice(0, 64)}v0`, customInstructions: colorReceiptInstructions(prepared.payout.receipt) } },
      { outputIndex: 5, protocol: "basket insertion", insertionRemittance: { basket: "amm-swap", customInstructions: prepared.satsChange.customInstructions } },
    ]);
  });

  it("a second leg (tokens in) landed: the payout tried with the row's `order` — the order's key, not the leg's own input", async () => {
    const order = `${"0d".repeat(32)}.2`;
    const w = fakeWallet({ fundingVout: 2 });
    const { prepared, vkey } = await tokensIn(w, v.commissionPkh, { order, last: true, extra: 2_000 });
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const rows = rowsOf(prepared).map((r, n) => (n === 0 ? { ...r, customInstructions: JSON.stringify({ ...JSON.parse(r.customInstructions), order }) } : r));
    expect((await resolveFromOverlay(withRows(w, rows), readsOf(final))).map((t) => t.txid)).toEqual([final.id("hex")]);
    if (prepared.payout.kind !== "brc29" || prepared.satsChange?.kind !== "brc29") throw new Error("expected wallet payments");
    const ia = w.calls.find((c) => c.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([
      { outputIndex: 1, protocol: "wallet payment", paymentRemittance: prepared.payout.remittance },
      { outputIndex: 5, protocol: "wallet payment", paymentRemittance: prepared.satsChange.remittance },
    ]);
  });

  it("another wallet's swap spent the rows: nothing taken in; nothing spent: no /tx read; a failed read: nothing", async () => {
    const { prepared, vkey } = await tokensIn();
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const stranger = brc29Side(key(77));
    const other = fakeWallet({ fundingVout: 2 });
    const strangerWallet = { ...withRows(other, rowsOf(prepared)), getPublicKey: async (a: { identityKey?: boolean }) => ({ publicKey: a.identityKey ? stranger.identityKey : stranger.publicKey(a as never) }) } as unknown as WalletInterface;
    expect(await resolveFromOverlay(strangerWallet, readsOf(final))).toEqual([]);
    expect(other.calls.some((c) => c.method === "internalizeAction")).toBe(false);
    const asked: string[] = [];
    const w = fakeWallet({ fundingVout: 2 });
    expect(await resolveFromOverlay(withRows(w, rowsOf(prepared)), readsOf(null, asked))).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(await resolveFromOverlay(withRows(w, rowsOf(prepared)), { spendsAll: async () => { throw new Error("down"); }, tx: async () => null })).toEqual([]);
    expect(await resolveFromOverlay(withRows(w, []), readsOf(final, asked))).toEqual([]);
    expect(asked).toHaveLength(1); // no rows: no read
    expect(w.calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("legTakeInOf: an output of another's swap is no match; this wallet's under another order is none", async () => {
    const { prepared, vkey } = await tokensIn();
    const final = await validatorSigns(prepared, prepared.swap.toBinary(), vkey);
    const stranger = brc29Side(key(78));
    const otherWallet = { ...fakeWallet().wallet, getPublicKey: async (a: { identityKey?: boolean }) => ({ publicKey: a.identityKey ? stranger.identityKey : stranger.publicKey(a as never) }) } as unknown as WalletInterface;
    expect(await legTakeInOf(otherWallet, final, TOKEN_ID, prepared.order)).toBeNull();
    expect(await legTakeInOf(fakeWallet({ fundingVout: 2 }).wallet, final, TOKEN_ID, `${"aa".repeat(32)}.0`)).toBeNull();
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

  it("sats in, no relay address: the commission (sats) is a BRC-29 payment to the taker's own key, internalized with the token payout", async () => {
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

    // The overlay pass recognizes both as this wallet's (keys re-derived from the order).
    expect((await legTakeInOf(wallet, prepared.swap, TOKEN_ID, prepared.order))?.map((x) => x.outputIndex)).toEqual([1, 4]);

    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER);
    if (o.status !== "accepted") throw new Error(`expected acceptance, got ${o.status}`);
    expect(o.completed.internalized).toBe(true);
    const ia = calls.find((x) => x.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: expect.objectContaining({ basket: `p color ${TOKEN_ID.slice(0, 64)}v0` }) },
      { outputIndex: 4, protocol: "wallet payment", paymentRemittance: r },
    ]);
  });

  it("tokens in, no relay address: the commission (tokens) is a 1Color output to a module receiving key of the taker's (0.40.0: for self), taken in through the module", async () => {
    const { wallet, calls, prepared, vkey, side } = await tokensIn(fakeWallet({ fundingVout: 2 }), null);
    const c = prepared.commission;
    expect(c).toMatchObject({ amount: 50n, to: "own" });
    if (c.payout?.kind !== "color") throw new Error("expected a module receipt");
    const rc = c.payout.receipt;
    expect(rc).toMatchObject({ assetId: SDK_ID, senderIdentityKey: side.identityKey });
    const own = PublicKey.fromString(side.publicKey({ protocolID: colorProtocolID(rc.assetId, rc.derivationPrefix, rc.derivationSuffix), keyID: "color", counterparty: side.identityKey, forSelf: true }));
    expect(c.payout.outputIndex).toBe(4);
    expect(prepared.swap.outputs[4]!.satoshis).toBe(1);
    const script = prepared.swap.outputs[4]!.lockingScript.toHex();
    expect(script).toBe(prepared.plan.outputs[4]!.script);
    expect(decodeOneColor(Utils.toArray(script, "hex"))).toMatchObject({ role: "value", amount: 50n });
    expect(script.endsWith(new P2PKH().lock(own.toAddress()).toHex())).toBe(true);
    // The overlay pass recognizes both: the sats payout (BRC-29), the token commission (its receipt).
    expect((await legTakeInOf(wallet, prepared.swap, TOKEN_ID, prepared.order))?.map((x) => x.outputIndex)).toEqual([1, 4]);

    const { af } = fakeRelay(async (fn, args) => {
      const final = await validatorSigns(prepared, readBytes(args.swap)!, vkey);
      for (const i of [0, 1, 2]) expect(spendValid(final, i)).toBe(true);
      return ok(fn, { id: ID, status: "accepted", tx: final.toHex(), txid: final.id("hex") });
    });
    const o = await relaySwap({ wallet, authFetch: af, base: "http://x/amm" }, prepared, PEER);
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
      const { prepared, need } = await legOf(w, { tokenId: TOKEN_ID, direction: "bsvToToken", leg, pool, poolOutput: { beef: atomic(zeroTx), outputIndex: 0 }, commissionPkh, satsPerKb: RATE, now: 1_000 });
      expect(prepared.commission).toEqual({ amount: 0n, pkh: commissionPkh ?? "00".repeat(20), to: "none" });
      expect(prepared.plan.outputs).toHaveLength(4);
      expect(need.outputs).toBe(20_001);
      void calls;
    }
  });
});
