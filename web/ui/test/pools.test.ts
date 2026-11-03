/**
 * The LP page's pool half: the pool deploy plan against amm-topic's fixture
 * pool deploy; the deploy (0.13.0: the validator's affirmation — its key, its
 * nonce, its signature, in the pool's state — then ONE createAction through
 * the wallet's BRC-207 module naming no input, the pool filed in `amm-pools`)
 * against a fake wallet and a fake `/call`; and Close (layout 2: the LP's
 * outputs, the tokens to a module key; layout 1: the contract's, the tokens to
 * `amm-swap`; 0.29.0: bsvFee 0, ONE wallet createAction with the pool as an
 * explicit input and the page's Close unlock at signAction; bsvFee > 0, the
 * fee from the pool, page-built; validated against the fixture pool, submit,
 * internalize, no relinquish).
 */
import {
  BigNumber,
  Beef,
  ECDSA,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
  type CreateActionArgs,
  type WalletInterface,
} from "@bsv/sdk";
import { P1SAT_PROTOCOL, colorReceiptInstructions } from "@1sat/actions";
import { ColorPlan, colorProtocolID } from "@bsv/color-permission-module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolTemplate, RESCINDED_KEY } from "../src/pool";
import { type SignedFetch } from "../src/lib/overlay";
import {
  POOL_TAG,
  PendingDeployStore,
  assetIdHex,
  deployPool,
  isPoolRow,
  legacyLpKeyId,
  lpKeyId,
  planPoolDeploy,
  tokenP2pkhScript,
  valueOutputsOf,
  type BasketRow,
} from "../src/lp/poolDeploy";
import { LEGACY_FEE, LEGACY_LP_KEY, awaitAdmitted, completeClose, prepareClose, steakText, submitToOverlay } from "../src/lp/close";
import { dagBytes, readBytes, type AuthFetchLike } from "../src/market/relay";
import { BRC29, brc29Side, isBrc29, type KeyArgs } from "./brc29Wallet";
import { tokenInputsOf } from "../src/market/swapAction";
import v from "./fixtures/amm-topic-vectors.json";
import v1 from "./fixtures/amm-topic-vectors-v1.json";

// Keys and transactions of programs/amm-topic/gen/main.go.
const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const lpKey = key(10);
const pub = (k: PrivateKey) => k.toPublicKey().toString();
const fund = Transaction.fromHex(v.fund);
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
/** The pool output as `amm.pool.affirm` is asked about it: the deploy's, its ValidatorPubKey, Nonce and Affirmation still to come. */
const fixturePool = PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)!;
const proposedPool = PoolTemplate.lockDeploy(fixturePool.args, { ...fixturePool.state, validatorPubKey: RESCINDED_KEY, nonce: "00".repeat(32), affirmation: "" }).toHex();
/** An in-memory PendingDeployStore. */
const memStore = () => {
  const m = new Map<string, string>();
  return new PendingDeployStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, val) => void m.set(k, val) });
};
const swap2 = Transaction.fromHex(v.swap_tokens_in);
const DEPLOY_TXID = tokenDeploy.id("hex");
// The page's token id and the module's asset id are the same `<txid>_0` (BRC-162 Token identification, David 2026-10-07).
const TOKEN_ID = `${DEPLOY_TXID}_0`;
const SDK_ID = TOKEN_ID;
const P1SAT = P1SAT_PROTOCOL as unknown as [number, string];
const walletRoot = key(50); // the fake wallet's root: identity key and honest derivations

afterEach(() => vi.unstubAllGlobals());

/** The wallet's held deploy output, as `p color assets` lists it (10,000,000 units). */
const heldDeploy = { outpoint: `${DEPLOY_TXID}.0`, satoshis: 1, lockingScript: tokenDeploy.outputs[0]!.lockingScript.toHex(), available: true };

describe("pool deploy: plan", () => {
  it("the plan is the fixture's pool as proposed, byte for byte; with the validator's key, nonce and affirmation, the fixture's pool output", () => {
    const outs = valueOutputsOf([heldDeploy], TOKEN_ID);
    expect(outs).toEqual([{ outpoint: `${DEPLOY_TXID}.0`, txid: DEPLOY_TXID, vout: 0, amount: 10_000_000n }]);
    const plan = planPoolDeploy({
      tokenId: TOKEN_ID,
      tokens: 5_000_000n,
      sats: 1_000_000n,
      lpFeeBps: BigInt(v.lpFeeBps),
      validatorFeeBps: BigInt(v.validatorFeeBps),
      commissionBps: BigInt(v.commissionBps),
      lpPubKey: pub(lpKey),
      lpKeyId: "YW1tLWxw abc=",
      validator: { identityKey: v.identity },
    });
    expect(plan.lockingScript).toBe(proposedPool);
    expect(plan.state.validatorPubKey).toBe(RESCINDED_KEY);
    expect(PoolTemplate.lockDeploy(plan.args, { ...plan.state, validatorPubKey: v.pool0.validator, nonce: v.nonce, affirmation: v.affirmation }).toHex()).toBe(poolDeploy.outputs[0]!.lockingScript.toHex());
    expect(plan.lpKeyId).toBe("YW1tLWxw abc=");
    // Pools before 0.13.0: the LP key keyed by the deploy's key input (BRC-29), or the pre-BRC-29 key.
    expect(lpKeyId(`${DEPLOY_TXID}_0`)).toBe(`YW1tLWxw ${Utils.toBase64(Utils.toArray(`${DEPLOY_TXID}_0`, "utf8"))}`);
    expect(legacyLpKeyId(`${DEPLOY_TXID}.0`)).toBe(`amm-lp-${DEPLOY_TXID}_0`);
    expect(plan.args.assetId).toBe(Utils.toHex(tokenDeploy.hash() as number[]));
    expect(plan.topic).toBe(`tm_color_${DEPLOY_TXID}_0`);
    expect(plan.price).toBe("0.2");
    expect(PoolTemplate.decode(plan.lockingScript)!.state).toEqual(plan.state);
  });

  it("refusals: legacy id, zero deposits, fees", () => {
    expect(() => assetIdHex(`${DEPLOY_TXID}_1`)).toThrow(/32-byte id/);
    const base = { tokenId: TOKEN_ID, tokens: 1n, sats: 1n, lpFeeBps: 30n, validatorFeeBps: 5n, lpPubKey: pub(lpKey), lpKeyId: "k", validator: { identityKey: v.identity } };
    expect(() => planPoolDeploy({ ...base, tokens: 0n })).toThrow(/token deposit/);
    expect(() => planPoolDeploy({ ...base, sats: 0n })).toThrow(/sats deposit/);
    expect(() => planPoolDeploy({ ...base, lpFeeBps: 10_000n })).toThrow(/LP fee/);
    expect(() => planPoolDeploy({ ...base, commissionBps: -1n })).toThrow(/commission/);
    expect(() => planPoolDeploy({ ...base, lpFeeBps: 5_000n, commissionBps: 5_000n })).toThrow(/below 100%/);
    // Commission defaults to 0.
    expect(planPoolDeploy(base).args.commissionBps).toBe(0n);
    expect(PoolTemplate.decode(planPoolDeploy({ ...base, commissionBps: 25n }).lockingScript)!.args.commissionBps).toBe(25n);
  });

  it("the wallet's tokens: only available value outputs of the token (what the module selects from)", () => {
    const pool = { outpoint: `${poolDeploy.id("hex")}.0`, satoshis: 1_000_000, lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(), available: true };
    const other = { ...heldDeploy, outpoint: `${"cd".repeat(32)}.0`, lockingScript: tokenP2pkhScript(`${"ef".repeat(32)}_0`, 9n, pub(lpKey)) };
    expect(valueOutputsOf([{ ...heldDeploy, available: false }, other], TOKEN_ID)).toEqual([]);
    expect(valueOutputsOf([pool], TOKEN_ID)).toEqual([]);
  });

  it("pool rows (amm-pools) are never token inputs", () => {
    const poolRow: BasketRow = {
      outpoint: `${poolDeploy.id("hex")}.0`,
      satoshis: 1_000_000,
      lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(),
      tags: [POOL_TAG],
      customInstructions: JSON.stringify({ id: SDK_ID, op: "amm-pool", protocolID: BRC29, keyID: lpKeyId(`${DEPLOY_TXID}_0`), counterparty: "self" }),
    };
    expect(isPoolRow(poolRow)).toBe(true);
    expect(tokenInputsOf([poolRow], TOKEN_ID)).toEqual([]);
  });
});

/**
 * A fake BRC-100 wallet over the fixture keys. getPublicKey / createSignature:
 * a funding key (`amm-funding-…`) is derived with a real KeyDeriver over
 * `walletRoot` (./brc29Wallet.ts); any other key is the one `keys` names
 * (default lpKey; `honest` derives BRC-29 keys the same real way). The
 * identity key is walletRoot's; internalizeAction checks a wallet payment as
 * wallet-toolbox does. createAction: one input fund:`fundVout` (lpKey's), the
 * requested outputs in order, then a P2PKH change (200 sats of fee); with
 * `signAndProcess: false` it waits for signAction, otherwise it signs and
 * "broadcasts" at once. listOutputs answers the token deploy's BEEF. Records
 * every call.
 */
const side = brc29Side(walletRoot);
/** BRC-29 keys as the wallet derives them; any other request gets `other`. */
const honest = (other: (a: KeyArgs) => PrivateKey = () => key(99)) => (a: KeyArgs) => (isBrc29(a.protocolID) ? side.privateKey(a) : other(a));

function fakeWallet(fundVout: number, keys: (a: KeyArgs) => PrivateKey = () => lpKey) {
  const calls: { method: string; args: unknown }[] = [];
  const keyOf = (a: KeyArgs) => (a.keyID.startsWith("amm-funding-") ? side.privateKey(a) : keys(a));
  let pending: Transaction | undefined;
  const signFunding = async (tx: Transaction, skip: Set<number> = new Set()) => {
    for (let n = 0; n < tx.inputs.length; n++) if (!skip.has(n)) tx.inputs[n]!.unlockingScript = await new P2PKH().unlock(lpKey).sign(tx, n);
    return { txid: tx.id("hex"), tx: tx.toAtomicBEEF(true) };
  };
  const w = {
    async getPublicKey(args: KeyArgs & { identityKey?: boolean }) {
      calls.push({ method: "getPublicKey", args });
      if (args.identityKey) return { publicKey: side.identityKey };
      return { publicKey: pub(keyOf(args)) };
    },
    async createSignature(args: KeyArgs & { hashToDirectlySign: number[] }) {
      calls.push({ method: "createSignature", args });
      return { signature: ECDSA.sign(new BigNumber(args.hashToDirectlySign), keyOf(args), true).toDER() as number[] };
    },
    async createAction(args: CreateActionArgs) {
      calls.push({ method: "createAction", args });
      const tx = new Transaction();
      // The caller's explicit inputs first (as wallet-toolbox places them), then the funding.
      const inputBeef = args.inputBEEF ? Beef.fromBinary(Array.from(args.inputBEEF)) : null;
      for (const i of args.inputs ?? []) {
        const [txid, vout] = i.outpoint.split(".");
        tx.addInput({ sourceTXID: txid!, sourceOutputIndex: Number(vout), sourceTransaction: inputBeef?.findTxid(txid!)?.tx ?? sources.get(txid!) ?? tokenDeploy, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      }
      tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: fundVout, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      for (const o of args.outputs ?? []) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) });
      const outSats = tx.outputs.reduce((a, o) => a + o.satoshis!, 0);
      tx.addOutput({ satoshis: Math.max(1, fund.outputs[fundVout]!.satoshis! - outSats - 200), lockingScript: new P2PKH().lock(lpKey.toAddress()) });
      if (args.options?.signAndProcess === false || (args.inputs ?? []).length > 0) {
        pending = tx;
        return { signableTransaction: { tx: tx.toAtomicBEEF(true), reference: "ref-1" } };
      }
      return signFunding(tx);
    },
    async signAction(args: { spends?: Record<number, { unlockingScript: string }> }) {
      calls.push({ method: "signAction", args });
      // The caller's unlocks in (0.29.0: the close's pool input); the wallet signs the rest.
      const spends = Object.entries(args.spends ?? {});
      for (const [n, sp] of spends) pending!.inputs[Number(n)]!.unlockingScript = UnlockingScript.fromHex(sp.unlockingScript);
      return signFunding(pending!, new Set(spends.map(([n]) => Number(n))));
    },
    async listOutputs(args: unknown) {
      calls.push({ method: "listOutputs", args });
      const b = new Beef();
      b.mergeTransaction(tokenDeploy);
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
  return { wallet: w as unknown as WalletInterface, calls };
}

function verify(tx: Transaction, i: number): boolean {
  const inp = tx.inputs[i]!;
  const src = inp.sourceTransaction!.outputs[inp.sourceOutputIndex]!;
  return new Spend({
    sourceTXID: inp.sourceTXID!,
    sourceOutputIndex: inp.sourceOutputIndex,
    sourceSatoshis: src.satoshis!,
    lockingScript: src.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== i),
    outputs: tx.outputs,
    inputIndex: i,
    unlockingScript: inp.unlockingScript!,
    inputSequence: inp.sequence!,
    lockTime: tx.lockTime,
  }).validate();
}

const RATE = 100;

/** Source transactions of explicit inputs the fake wallet holds besides the token deploy. */
const sources = new Map<string, Transaction>();

function atomic(tx: Transaction, ancestors: Transaction[]): number[] {
  const b = new Beef();
  for (const a of ancestors) b.mergeRawTx(a.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinaryAtomic(tx.id("hex"));
}

/** The wallet's honest keys, the fixture's LP key for a new pool's BRC-29 LP keyID (prefix base64("amm-lp"), so the pool output is the fixture's byte for byte). */
const deployKeys = (a: KeyArgs) => (isBrc29(a.protocolID) && a.keyID.startsWith("YW1tLWxw ") ? lpKey : side.privateKey(a));

/**
 * A fake `/call` for `amm.pool.affirm`: answers the fixture's affirmation for the fixture's
 * proposed pool (or `answer`), records every request.
 */
function fakeAffirm(answer?: (args: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const af: AuthFetchLike = {
    async fetch(_url, config) {
      const b = JSON.parse(config!.body!) as { fn: string; args: Record<string, unknown> };
      calls.push(b);
      const a = answer
        ? answer(b.args)
        : { status: 200, body: { fn: b.fn, result: { validatorPubKey: dagBytes(Utils.toArray(v.pool0.validator, "hex")), nonce: dagBytes(Utils.toArray(v.nonce, "hex")), signature: dagBytes(Utils.toArray(v.affirmation, "hex")) } } };
      return { status: a.status, text: async () => JSON.stringify(a.body) };
    },
  };
  return { af, calls };
}

async function deploy(w = fakeWallet(0, deployKeys), af = fakeAffirm().af, submitted: { topic: string; beef: number[] }[] = [], pending = memStore()) {
  const d = await deployPool({
    wallet: w.wallet,
    af,
    base: "http://x/amm",
    tokenId: TOKEN_ID,
    tokens: 5_000_000n,
    sats: 1_000_000n,
    fees: { lpFeeBps: 30n, validatorFeeBps: 5n, commissionBps: BigInt(v.commissionBps) },
    validator: { identityKey: v.identity },
    held: [heldDeploy],
    meta: { sym: "TST", dec: 0 },
    submit: async (topic, beef) => (submitted.push({ topic, beef }), { steak: { [topic]: { outputsToAdmit: [0, 1], coinsToRetain: [], coinsRemoved: [0] } } }),
    pending,
  });
  return { ...w, d, submitted, pending };
}

describe("pool deploy (0.13.0): the validator's affirmation, then one createAction through the wallet's BRC-207 module, no input named", () => {
  it("amm.pool.affirm {pool: the proposed script, satoshis}; the pool with the validator's key, nonce and signature at output 0, alone; a p color plan with no input positions; filed in amm-pools with the nonce; submitted to the token topic", async () => {
    const { af, calls: http } = fakeAffirm();
    const submitted: { topic: string; beef: number[] }[] = [];
    const pending = memStore();
    const { d, calls } = await deploy(fakeWallet(0, deployKeys), af, submitted, pending);
    expect(http).toEqual([{ fn: "amm.pool.affirm", args: { pool: dagBytes(Utils.toArray(proposedPool, "hex")), satoshis: 1_000_000 } }]);
    expect(d.affirmation).toMatchObject({ validatorPubKey: v.pool0.validator, nonce: v.nonce, signature: v.affirmation });

    // The wallet sequence: the LP key; the action (signed and broadcast by the wallet); the filing.
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "createAction", "internalizeAction"]);
    const lpReq = calls[0]!.args as KeyArgs;
    expect(lpReq.protocolID).toEqual(BRC29);
    expect(lpReq.keyID).toMatch(/^YW1tLWxw [A-Za-z0-9+/]{22}==$/); // base64("amm-lp"), 16 random bytes
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.inputs).toBeUndefined();
    expect(create.outputs).toEqual([{ lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(), satoshis: 1_000_000, outputDescription: "AMM pool: TST / BSV" }]);
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.labels!.at(-1)).toBe("amm-pool-deploy");
    const plan = ColorPlan.fromLabels(create.labels)!;
    expect(plan).toMatchObject({ version: 1, assets: [SDK_ID], operations: [{ assetId: SDK_ID, operation: "transfer" }], inputPositions: [], ownedOutputs: [], changePositions: [], sighashTypes: [] });

    // The broadcast deploy: output 0 the affirmed pool; listed (amm-lookup's rule).
    expect(PoolTemplate.affirmed(Transaction.fromAtomicBEEF(d.tx).outputs[0]!.lockingScript, 1_000_000n)).toBe(true);
    expect(d.outpoint).toBe(`${d.txid}.0`);
    expect(d.errors).toEqual([]);
    expect(submitted.map((x) => x.topic)).toEqual([`tm_color_${SDK_ID}`]);
    expect(d.submitted).toBe(`admitted under tm_color_${SDK_ID} (outputs 0, 1)`);

    // The position row: output 0 into amm-pools, the LP key, the validator's terms and nonce.
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { tx: number[]; outputs: { insertionRemittance: { basket: string; tags: string[]; customInstructions: string } }[]; labels: string[] };
    expect(ia.tx).toEqual(d.tx);
    expect(ia.labels).toEqual(["amm-pool-deploy"]);
    expect(ia.outputs).toEqual([{ outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "amm-pools", tags: ["amm-pool"], customInstructions: d.filing.customInstructions } }]);
    expect(JSON.parse(d.filing.customInstructions)).toEqual({
      id: SDK_ID,
      op: "amm-pool",
      sym: "TST",
      dec: "0",
      protocolID: BRC29,
      keyID: lpReq.keyID,
      counterparty: "self",
      amm: { role: "lp", validatorIdentity: v.identity, lpFeeBps: "30", validatorFeeBps: "5", commissionBps: String(v.commissionBps), nonce: v.nonce },
    });
    expect(d.filed).toBe(true);
    // The LP keyID was kept in the browser until the row was filed.
    expect(pending.list()).toEqual([]);
    expect(calls.some((c) => c.method === "abortAction" || c.method === "relinquishOutput")).toBe(false);
  });

  it("a validator signing with its own nonce: affirmed; an answer whose key is not the child of its nonce, or whose signature does not affirm the pool, is refused before the wallet's action", async () => {
    // The validator's identity of gen/vectors: it affirms any proposed pool with its child of a nonce of its own.
    const identity = key(0x7f);
    expect(pub(identity)).toBe(v.identity);
    const nonce = "5a".repeat(32);
    const child = identity.deriveChild(new PrivateKey(1).toPublicKey(), `1-amm pool-${nonce}`);
    const signing = fakeAffirm((args) => {
      const pool = PoolTemplate.decode(readBytes(args.pool)!)!;
      const filled = { ...pool, state: { ...pool.state, validatorPubKey: pub(child), nonce } };
      const sig = child.sign(PoolTemplate.affirmationMessage(filled, BigInt(args.satoshis as number)));
      return { status: 200, body: { fn: "amm.pool.affirm", result: { validatorPubKey: dagBytes(Utils.toArray(pub(child), "hex")), nonce: dagBytes(Utils.toArray(nonce, "hex")), signature: dagBytes(sig.toDER() as number[]) } } };
    });
    const w = fakeWallet(0, deployKeys);
    const pending = memStore();
    const d = await deployPool({ wallet: w.wallet, af: signing.af, base: "http://x/amm", tokenId: TOKEN_ID, tokens: 5_000_000n, sats: 1_000_000n, fees: { lpFeeBps: 30n, validatorFeeBps: 5n, commissionBps: 0n }, validator: { identityKey: v.identity }, held: [heldDeploy], submit: async () => ({}), pending });
    expect(PoolTemplate.decode(Transaction.fromAtomicBEEF(d.tx).outputs[0]!.lockingScript)!.state).toMatchObject({ validatorPubKey: pub(child), nonce });
    expect(d.errors).toEqual([]);
    expect(d.submitted).toBe("not decided yet");

    // The fixture's signature over another deposit (900,000 sats): does not affirm this pool.
    const w2 = fakeWallet(0, deployKeys);
    const refused = deployPool({ wallet: w2.wallet, af: fakeAffirm().af, base: "http://x/amm", tokenId: TOKEN_ID, tokens: 5_000_000n, sats: 900_000n, fees: { lpFeeBps: 30n, validatorFeeBps: 5n, commissionBps: BigInt(v.commissionBps) }, validator: { identityKey: v.identity }, held: [heldDeploy], pending });
    await expect(refused).rejects.toThrow(/does not affirm this pool/);
    expect(w2.calls.some((c) => c.method === "createAction")).toBe(false);
    // A key that is not the validator's child of the nonce.
    const wrongKey = fakeAffirm(() => ({ status: 200, body: { fn: "amm.pool.affirm", result: { validatorPubKey: dagBytes(Utils.toArray(v.pool1.validator, "hex")), nonce: dagBytes(Utils.toArray(v.nonce, "hex")), signature: dagBytes(Utils.toArray(v.affirmation, "hex")) } } }));
    const w3 = fakeWallet(0, deployKeys);
    await expect(deploy(w3, wrongKey.af)).rejects.toThrow(/not the validator's child of its nonce/);
    expect(w3.calls.some((c) => c.method === "createAction")).toBe(false);
    // An answer without the key and the nonce (0.11.0's shape).
    const old = fakeAffirm(() => ({ status: 200, body: { fn: "amm.pool.affirm", result: { signature: dagBytes(Utils.toArray(v.affirmation, "hex")) } } }));
    await expect(deploy(fakeWallet(0, deployKeys), old.af)).rejects.toThrow(/no validatorPubKey/);
  });

  it("the validator's refusal (fees_unacceptable, …) stops the deploy before the wallet's action", async () => {
    const w = fakeWallet(0, deployKeys);
    const { af } = fakeAffirm(() => ({ status: 500, body: { fn: "amm.pool.affirm", error: { code: "failed", message: "fees_unacceptable: lpFeeBps 30 is not 25" } } }));
    await expect(deploy(w, af)).rejects.toThrow(/fees_unacceptable/);
    expect(w.calls.some((c) => c.method === "createAction")).toBe(false);
  });

  it("a wallet that refuses the action: the error, nothing filed, the LP keyID kept in the browser; a refused signing aborts the action", async () => {
    const w = fakeWallet(0, deployKeys);
    (w.wallet as unknown as { createAction: () => Promise<never> }).createAction = async () => {
      w.calls.push({ method: "createAction", args: {} });
      throw new Error("BRC-207: the user declined the color_send request");
    };
    const pending = memStore();
    await expect(deploy(w, undefined, [], pending)).rejects.toThrow(/declined the color_send/);
    expect(w.calls.some((c) => c.method === "internalizeAction")).toBe(false);
    expect(pending.list()).toHaveLength(1);
    // The wallet hands the action back for signing and the user declines: aborted.
    const w2 = fakeWallet(0, deployKeys);
    const ca = w2.wallet.createAction.bind(w2.wallet);
    (w2.wallet as unknown as { createAction: (a: CreateActionArgs) => unknown }).createAction = (a: CreateActionArgs) => ca({ ...a, options: { ...a.options, signAndProcess: false } });
    (w2.wallet as unknown as { signAction: () => Promise<never> }).signAction = async () => {
      w2.calls.push({ method: "signAction", args: {} });
      throw new Error("BRC-207: the user declined the color_send request");
    };
    await expect(deploy(w2)).rejects.toThrow(/declined the color_send/);
    expect(w2.calls.map((c) => c.method).slice(-2)).toEqual(["signAction", "abortAction"]);
  });
});

// ---------------------------------------------------------------------------
// Close (0.9.0)
// ---------------------------------------------------------------------------

describe("close (0.13.0, layout 2): the LP's outputs — the sats to the LP key, the tokens to a module key of the user's own; the fee from the pool, or (0.29.0) the wallet's own action; submit, internalize", () => {
  // A pool like the fixture's after swap2, whose LP key is the wallet's BRC-29 LP key for some deposit outpoint.
  const depositOp = `${"33".repeat(32)}_0`;
  const lpRef = { protocolID: BRC29 as never, keyID: lpKeyId(depositOp), counterparty: "self" };
  const lpPub = side.publicKey({ ...lpRef, forSelf: true });
  const base = PoolTemplate.decode(swap2.outputs[0]!.lockingScript)!;
  const poolTx = new Transaction();
  poolTx.addInput({ sourceTXID: "44".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  poolTx.addOutput({ satoshis: swap2.outputs[0]!.satoshis!, lockingScript: PoolTemplate.lockContinuation(base, { ...base.state, lpPubKey: lpPub }) });
  const poolOutput = () => ({ beef: atomic(poolTx, []), outputIndex: 0 });
  const sats = BigInt(poolTx.outputs[0]!.satoshis!);
  const [derivationPrefix, derivationSuffix] = lpRef.keyID.split(" ") as [string, string];

  it("bsvFee 0 (0.29.0): ONE wallet createAction — the pool an explicit input (its BEEF, the call's unlock size), the LP's outputs with the payout's remittance and the receipt as customInstructions, no baskets; the page's Close unlock over the wallet's transaction (its funding and change included) at signAction; both inputs validate; completeClose takes in the payment and, through the module, the tokens; no relinquishOutput", async () => {
    const { wallet, calls } = fakeWallet(3, honest((a) => side.privateKey(a)));
    const s = await prepareClose({ wallet, tokenId: TOKEN_ID, meta: { sym: "TST", dec: 0 }, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 0n, satsPerKb: RATE });
    // The identity and the LP key; the module receiving key (the identity, then the key); the wallet's action; the LP's signature.
    expect(calls.map((c) => c.method)).toEqual(["getPublicKey", "getPublicKey", "getPublicKey", "getPublicKey", "createAction", "createSignature", "signAction"]);
    expect(s.walletBuilt).toBe(true);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.labels).toEqual(["amm-close"]);
    expect(create.inputs).toEqual([{ outpoint: `${poolTx.id("hex")}.0`, unlockingScriptLength: PoolTemplate.maxCallUnlockLength(s.plan), inputDescription: "The TST pool" }]);
    expect(Beef.fromBinary(Array.from(create.inputBEEF!)).findTxid(poolTx.id("hex"))).toBeTruthy();
    expect(create.outputs!.map((o) => [o.satoshis, o.basket])).toEqual([[Number(sats), undefined], [1, undefined]]);
    expect(JSON.parse(create.outputs![0]!.customInstructions!)).toEqual({ protocol: "wallet payment", derivationPrefix, derivationSuffix, senderIdentityKey: side.identityKey });
    const sa = calls.find((c) => c.method === "signAction")!.args as { spends: Record<number, { unlockingScript: string }> };
    expect(Object.keys(sa.spends)).toEqual(["0"]);
    const tx = s.tx;
    expect(tx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${poolTx.id("hex")}.0`, `${fund.id("hex")}.3`]);
    // The LP's two outputs, then the wallet's change: Close(lpSig)'s outputs are free, the preimage covers them all.
    expect(tx.outputs.map((o) => o.satoshis).slice(0, 2)).toEqual([Number(sats), 1]);
    expect(tx.outputs).toHaveLength(3);
    expect(tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(PublicKey.fromString(lpPub).toAddress()).toHex());
    expect(tx.inputs[0]!.unlockingScript!.toHex()).toBe(sa.spends[0]!.unlockingScript);
    expect(tx.inputs[0]!.unlockingScript!.toHex().length / 2).toBeLessThanOrEqual(PoolTemplate.maxCallUnlockLength(s.plan));
    for (const i of [0, 1]) expect(verify(tx, i)).toBe(true);
    expect(s.sats).toBe(sats);
    expect(s.tokenAmount).toBe(base.state.tokenReserve);
    expect(s.payout).toEqual({ outputIndex: 0, satoshis: Number(sats), lockingScript: tx.outputs[0]!.lockingScript.toHex(), remittance: { derivationPrefix, derivationSuffix, senderIdentityKey: side.identityKey } });
    // The tokens (0.13.0): to a fresh module receiving key of the user's own (sender the user), no amm-swap.
    expect(s.version).toBe(2);
    expect(s.tokens).toBeNull();
    const r = s.receipt!;
    expect(r.outputIndex).toBe(1);
    expect(r.receipt).toMatchObject({ assetId: SDK_ID, senderIdentityKey: side.identityKey });
    expect(create.outputs![1]!.customInstructions).toBe(colorReceiptInstructions(r.receipt));
    const moduleKey = side.publicKey({ protocolID: colorProtocolID(SDK_ID, r.receipt.derivationPrefix, r.receipt.derivationSuffix), keyID: "color", counterparty: side.identityKey, forSelf: true });
    expect(tx.outputs[1]!.lockingScript.toHex()).toBe(tokenP2pkhScript(SDK_ID, base.state.tokenReserve, moduleKey));
    expect(s.topic).toBe(`tm_color_${DEPLOY_TXID}_0`);

    const before = calls.length;
    const kept = new Map<string, string>();
    const { PendingPayoutStore } = await import("../src/wallet/pendingPayouts");
    const payouts = new PendingPayoutStore({ getItem: (k) => kept.get(k) ?? null, setItem: (k, val) => void kept.set(k, val) });
    const c = await completeClose(wallet, s, payouts);
    expect(c).toEqual({ internalized: true, errors: [] });
    expect(payouts.list()).toEqual([]);
    const after = calls.slice(before);
    expect(after.map((x) => x.method)).toEqual(["internalizeAction", "internalizeAction"]);
    const ia = after[0]!.args as { tx: number[]; outputs: unknown[]; labels: string[] };
    expect(ia.tx).toEqual(s.beef);
    expect(ia.labels).toEqual(["amm-close"]);
    expect(ia.outputs).toEqual([{ outputIndex: 0, protocol: "wallet payment", paymentRemittance: s.payout!.remittance }]);
    const ib = after[1]!.args as { outputs: { insertionRemittance: { basket: string } }[] };
    expect(ib.outputs[0]!.insertionRemittance.basket).toBe(`p color ${DEPLOY_TXID}v0`);
  });

  it("bsvFee 0: a wallet transaction that moves the pool off input 0 is aborted before signing", async () => {
    const { wallet, calls } = fakeWallet(3, honest((a) => side.privateKey(a)));
    const real = wallet.createAction.bind(wallet);
    (wallet as unknown as { createAction: typeof real }).createAction = async (args) => {
      const r = await real(args);
      const tx = Transaction.fromAtomicBEEF(r.signableTransaction!.tx);
      const moved = new Transaction();
      moved.addInput(tx.inputs[1]!);
      moved.addInput(tx.inputs[0]!);
      for (const o of tx.outputs) moved.addOutput(o);
      return { signableTransaction: { tx: moved.toAtomicBEEF(true), reference: "ref-1" } };
    };
    await expect(prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 0n, satsPerKb: RATE })).rejects.toThrow(/input 0/);
    expect(calls.map((c) => c.method).filter((m) => m === "signAction" || m === "abortAction")).toEqual(["abortAction"]);
  });

  it("bsvFee > 0: no funding (the wallet makes no action); [pool] → [sats − bsvFee, every token]; validates; a fee too small for the miner and the token's sat, or over the pool, is refused", async () => {
    const { wallet, calls } = fakeWallet(3, honest((a) => side.privateKey(a)));
    const s = await prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 1_000n, satsPerKb: RATE });
    expect(s.walletBuilt).toBe(false);
    expect(calls.some((c) => c.method === "createAction")).toBe(false);
    expect(s.tx.inputs).toHaveLength(1);
    expect(s.tx.outputs.map((o) => o.satoshis)).toEqual([Number(sats) - 1_000, 1]);
    expect(verify(s.tx, 0)).toBe(true);
    await expect(prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 2n, satsPerKb: RATE })).rejects.toThrow(/at least/);
    await expect(prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: sats + 1n, satsPerKb: RATE })).rejects.toThrow(/0 to the pool's/);
    // bsvFee = every sat: the tokens only, no wallet payment.
    const all = await prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: sats, satsPerKb: RATE });
    expect(all.payout).toBeNull();
    expect(all.tx.outputs).toHaveLength(1);
    expect(all.receipt!.outputIndex).toBe(0);
  });

  it("a layout-1 pool (before 0.13.0): the contract's outputs, everything to the LP key; the tokens into amm-swap (Move back), as 0.12.x; 0.29.0: the fee from the pool (bsvFee 0 refused: no funding transaction)", async () => {
    const swap2v1 = Transaction.fromHex(v1.swap_tokens_in);
    const b1 = PoolTemplate.decode(swap2v1.outputs[0]!.lockingScript)!;
    expect(b1.version).toBe(1);
    const t1 = new Transaction();
    t1.addInput({ sourceTXID: "44".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    t1.addOutput({ satoshis: swap2v1.outputs[0]!.satoshis!, lockingScript: PoolTemplate.lockContinuation(b1, { ...b1.state, lpPubKey: lpPub }) });
    const { wallet, calls } = fakeWallet(3, honest());
    const tokenId1 = `${Transaction.fromHex(v1.token_deploy).id("hex")}_0`;
    await expect(prepareClose({ wallet, tokenId: tokenId1, poolOutput: { beef: atomic(t1, []), outputIndex: 0 }, lpKey: lpRef, bsvFee: 0n, satsPerKb: RATE })).rejects.toThrow(LEGACY_FEE);
    expect(calls.some((c) => c.method === "createAction")).toBe(false);
    const s = await prepareClose({ wallet, tokenId: tokenId1, poolOutput: { beef: atomic(t1, []), outputIndex: 0 }, lpKey: lpRef, bsvFee: 1_000n, satsPerKb: RATE });
    expect(s.version).toBe(1);
    expect(s.receipt).toBeNull();
    const sats1 = BigInt(t1.outputs[0]!.satoshis!);
    expect(s.tx.outputs.map((o) => o.satoshis)).toEqual([Number(sats1) - 1_000, 1]);
    expect(s.tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(PublicKey.fromString(lpPub).toAddress()).toHex());
    expect(s.tx.outputs[1]!.lockingScript.toHex()).toBe(tokenP2pkhScript(tokenId1, b1.state.tokenReserve, lpPub));
    expect(verify(s.tx, 0)).toBe(true);
    expect(JSON.parse(s.tokens!.customInstructions)).toEqual({ assetId: tokenId1, amount: String(b1.state.tokenReserve), protocolID: BRC29, keyID: lpRef.keyID, counterparty: "self" });
    const before = calls.length;
    const c = await completeClose(wallet, s);
    expect(c.internalized).toBe(true);
    const ia = calls.slice(before)[0]!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([
      { outputIndex: 0, protocol: "wallet payment", paymentRemittance: s.payout!.remittance },
      { outputIndex: 1, protocol: "basket insertion", insertionRemittance: { basket: "amm-swap", tags: [], customInstructions: s.tokens!.customInstructions } },
    ]);
    // The close's tokens are an amm-swap input the legs and Move back can spend (the LP key signs).
    const row = { outpoint: `${s.txid}.1`, satoshis: 1, lockingScript: s.tx.outputs[1]!.lockingScript.toHex(), customInstructions: s.tokens!.customInstructions };
    expect(tokenInputsOf([row], tokenId1)).toEqual([expect.objectContaining({ amount: b1.state.tokenReserve, protocolID: BRC29, keyID: lpRef.keyID, counterparty: "self" })]);
  });

  it("refuses a wallet key that is not the pool's LP key, and a pre-BRC-29 LP key with a payout, before any funding", async () => {
    const a = fakeWallet(3, () => key(99));
    await expect(prepareClose({ wallet: a.wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: { protocolID: P1SAT as never, keyID: "x", counterparty: "self" }, bsvFee: sats, satsPerKb: RATE })).rejects.toThrow(/not this pool's LP key/);
    expect(a.calls.some((c) => c.method === "createAction")).toBe(false);
    const b = fakeWallet(3);
    await expect(prepareClose({ wallet: b.wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: { protocolID: P1SAT as never, keyID: "lp", counterparty: "self" }, bsvFee: 0n, satsPerKb: RATE })).rejects.toThrow(LEGACY_LP_KEY);
    expect(b.calls).toEqual([]);
  });

  it("the submit (BRC-22, plain fetch): the STEAK, or nothing decided (503); awaitAdmitted asks the token instance's ls_color_<tokenId> BRC-207 color-admission (0.20.1)", async () => {
    const { wallet } = fakeWallet(3, honest((a) => side.privateKey(a)));
    const s = await prepareClose({ wallet, tokenId: TOKEN_ID, poolOutput: poolOutput(), lpKey: lpRef, bsvFee: 1_000n, satsPerKb: RATE });
    const STEAK = { [s.topic]: { outputsToAdmit: [1], coinsToRetain: [], coinsRemoved: [0] } };
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith("/submit")) return new Response(JSON.stringify(STEAK), { status: 200 });
      const q = JSON.parse(init.body as string) as { service: string; query: { type: string; topic: string; outpoints: string[] } };
      const found = q.service === `ls_color_${TOKEN_ID}` && q.query.type === "color-admission" && q.query.topic === `tm_color_${TOKEN_ID}` && q.query.outpoints[0] === `${s.txid}.1` && seen.length > 2;
      return new Response(JSON.stringify({ type: "output-list", outputs: found ? [{ beef: [], outputIndex: 1 }] : [] }), { status: 200 });
    }) as unknown as SignedFetch["fetch"];
    const r = await submitToOverlay("http://x/amm", s.topic, s.beef, fetchFn as never);
    expect(seen[0]!.url).toBe("http://x/amm/submit");
    expect(seen[0]!.init.headers).toEqual({ "content-type": "application/octet-stream", "x-topics": s.topic });
    expect(r).toEqual({ steak: STEAK });
    expect(steakText(r)).toBe(`admitted under ${s.topic} (outputs 1)`);
    const later = (async () => new Response('{"status":"error"}', { status: 503 })) as unknown as SignedFetch["fetch"];
    expect(await submitToOverlay("http://x/amm", s.topic, s.beef, later as never)).toEqual({});
    expect(await awaitAdmitted({ fetch: fetchFn }, "http://x/amm", TOKEN_ID, s.txid, 1, { intervalMs: 1 })).toBe(true);
  });
});

