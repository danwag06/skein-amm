/**
 * The active swap basket (0.12.0, src/market/activeSwap.ts; 0.29.0): the one
 * send into `amm-swap` before a swap's legs (the module send with the tokens
 * and the legs' sats, or a plain sats send), and "Move back" as ONE wallet
 * createAction to a module receiving key, against a fake wallet whose keys
 * are a real KeyDeriver (./brc29Wallet.ts), whose createAction places the
 * caller's explicit inputs first and hands such an action back for signing
 * (as wallet-toolbox does), and whose internalizeAction checks a `p color`
 * receipt as the BRC-207 module does. (That the real wallet-toolbox 2.15.0
 * takes the amm-swap rows as explicit inputs, marks them spent and stores the
 * receipt before broadcast is proven against the real classes outside this
 * suite: see the 0.29.0 CHANGELOG entry.)
 */
import { BigNumber, Beef, ECDSA, LockingScript, P2PKH, PrivateKey, PublicKey, Transaction, UnlockingScript, Utils, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { ColorPlan, colorProtocolID } from "@bsv/color-permission-module";
import { describe, expect, it } from "vitest";
import { brc29Side, type KeyArgs } from "./brc29Wallet";
import { SWAP_STAGE_LABEL, fileStagedToken, moveBack, moveBackSats, stage, swapKeyDescription, swapKeyIdOfDescription, swapSatsHoldings, swapSatsTotal, swapTotals, unfiledStagedTokens } from "../src/market/activeSwap";
import { spendValid, tokenInputsOf } from "../src/market/swapAction";
import { tokenP2pkhScript } from "../src/lp/poolDeploy";
import v from "./fixtures/amm-topic-vectors.json";

const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const fund = Transaction.fromHex(v.fund);
const fundKey = key(10); // the fixture's funds (output 0)
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const TOKEN = `${tokenDeploy.id("hex")}_0`;
const TOPIC = `tm_color_${TOKEN}`;
const side = brc29Side(key(60));
const SWAP: [2, string] = [2, "amm swap"];

/** An `amm-swap` row of `amount`, its source transaction, under keyID `keyID`. */
function swapRow(amount: bigint, keyID: string) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenP2pkhScript(TOKEN, amount, side.publicKey({ protocolID: SWAP, keyID, counterparty: "self", forSelf: true }))) });
  return {
    tx,
    row: {
      outpoint: `${tx.id("hex")}.0`,
      satoshis: 1,
      spendable: true,
      lockingScript: tx.outputs[0]!.lockingScript.toHex(),
      customInstructions: JSON.stringify({ assetId: TOKEN, amount: String(amount), protocolID: SWAP, keyID, counterparty: "self" }),
    },
  };
}

/**
 * A fake wallet: honest keys; `amm-swap` holds `rows`. createAction: the caller's explicit inputs
 * first (their sources from `inputBEEF`), then the funding (fund:0), the requested outputs in
 * order, then 500 sats of change; with explicit inputs (an `unlockingScriptLength`, no script) it
 * hands the action back (`signableTransaction`) and signAction puts the caller's spends in and
 * signs the funding; otherwise it signs and "broadcasts" at once.
 */
function fakeWallet(rows: { tx: Transaction; row: Record<string, unknown> }[] = []) {
  const calls: { method: string; args: unknown }[] = [];
  let pending: Transaction | undefined;
  const signFunding = async (tx: Transaction) => {
    const n = tx.inputs.findIndex((i) => i.sourceTXID === fund.id("hex"));
    tx.inputs[n]!.unlockingScript = await new P2PKH().unlock(fundKey).sign(tx, n);
    return { txid: tx.id("hex"), tx: tx.toAtomicBEEF(true) };
  };
  const w = {
    async getPublicKey(a: KeyArgs & { identityKey?: boolean }) {
      calls.push({ method: "getPublicKey", args: a });
      return { publicKey: a.identityKey ? side.identityKey : side.publicKey(a) };
    },
    async createSignature(a: KeyArgs & { hashToDirectlySign: number[] }) {
      calls.push({ method: "createSignature", args: a });
      return { signature: ECDSA.sign(new BigNumber(a.hashToDirectlySign), side.privateKey(a), true).toDER() as number[] };
    },
    async createAction(args: CreateActionArgs) {
      calls.push({ method: "createAction", args });
      const tx = new Transaction();
      const beef = args.inputBEEF ? Beef.fromBinary(Array.from(args.inputBEEF)) : null;
      for (const i of args.inputs ?? []) {
        const [txid, vout] = i.outpoint.split(".");
        tx.addInput({ sourceTXID: txid!, sourceOutputIndex: Number(vout), sourceTransaction: beef!.findTxid(txid!)!.tx!, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      }
      tx.addInput({ sourceTXID: fund.id("hex"), sourceOutputIndex: 0, sourceTransaction: fund, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
      for (const o of args.outputs ?? []) tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) });
      tx.addOutput({ satoshis: 500, lockingScript: new P2PKH().lock(fundKey.toAddress()) });
      if ((args.inputs ?? []).length > 0) {
        pending = tx;
        return { signableTransaction: { tx: tx.toAtomicBEEF(true), reference: "ref-mb" } };
      }
      return signFunding(tx);
    },
    async signAction(args: { reference: string; spends: Record<number, { unlockingScript: string }> }) {
      calls.push({ method: "signAction", args });
      for (const [n, sp] of Object.entries(args.spends)) pending!.inputs[Number(n)]!.unlockingScript = UnlockingScript.fromHex(sp.unlockingScript);
      return signFunding(pending!);
    },
    async listOutputs(args: { basket: string; include?: string }) {
      calls.push({ method: "listOutputs", args });
      if (args.basket !== "amm-swap") return { totalOutputs: 0, outputs: [] };
      const b = new Beef();
      for (const r of rows) b.mergeTransaction(r.tx);
      return { totalOutputs: rows.length, outputs: rows.map((r) => r.row), ...(args.include === "entire transactions" ? { BEEF: b.toBinary() } : {}) };
    },
    async internalizeAction(args: never) {
      calls.push({ method: "internalizeAction", args });
      return side.internalizeAction(args);
    },
    async relinquishOutput(args: unknown) {
      calls.push({ method: "relinquishOutput", args });
      return { relinquished: true };
    },
    async abortAction(args: unknown) {
      calls.push({ method: "abortAction", args });
      return { aborted: true };
    },
  };
  return { wallet: w as unknown as WalletInterface, calls };
}

/** An `amm-swap` sats row of `satoshis` under keyID `keyID` (0.40.0: no token tag). */
function satsRow(satoshis: number, keyID: string) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "78".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(PublicKey.fromString(side.publicKey({ protocolID: SWAP, keyID, counterparty: "self", forSelf: true })).toAddress()) });
  return {
    tx,
    row: { outpoint: `${tx.id("hex")}.0`, satoshis, spendable: true, lockingScript: tx.outputs[0]!.lockingScript.toHex(), customInstructions: JSON.stringify({ sats: true, protocolID: SWAP, keyID, counterparty: "self" }) },
  };
}


describe("staging (0.40.0): ONE wallet action — sats only a plain createAction; with tokens the module transfer, one token output and one sats output", () => {
  it("sats only: ONE P2PKH output to a fresh random key under [2, \"amm swap\"] (self), filed in amm-swap by the action with its customInstructions (no token tag); no p color labels; nothing submitted, nothing internalized", async () => {
    const { wallet, calls } = fakeWallet();
    const submitted: string[] = [];
    const s = await stage(wallet, { sats: 20_123 }, { sym: "TST", submit: async (t) => (submitted.push(t), {}) });
    const keys = calls.filter((c) => c.method === "getPublicKey").map((c) => c.args as KeyArgs);
    expect(keys.map((k) => [k.protocolID, k.counterparty, k.forSelf])).toEqual([[SWAP, "self", true]]);
    expect(keys[0]!.keyID).toMatch(/^amm-swap-[0-9a-f]{32}$/);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.labels).toEqual(["amm-swap"]);
    expect(create.inputs).toBeUndefined();
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.outputs).toHaveLength(1);
    const o = create.outputs![0]!;
    expect([o.satoshis, o.basket, o.lockingScript]).toEqual([20_123, "amm-swap", new P2PKH().lock(PublicKey.fromString(side.publicKey(keys[0]!)).toAddress()).toHex()]);
    expect(JSON.parse(o.customInstructions!)).toEqual({ sats: true, protocolID: SWAP, keyID: keys[0]!.keyID, counterparty: "self" });
    expect(s.sats).toEqual({ outpoint: `${s.txid}.0`, txid: s.txid, vout: 0, satoshis: 20_123, lockingScript: o.lockingScript, protocolID: SWAP, keyID: keys[0]!.keyID, counterparty: "self" });
    expect(s.tokens).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(calls.some((c) => c.method === "internalizeAction" || c.method === "signAction")).toBe(false);
    // The legs find it.
    const tx = Transaction.fromAtomicBEEF(s.tx);
    expect(await swapSatsHoldings(fakeWallet([{ tx, row: { outpoint: s.sats.outpoint, satoshis: 20_123, spendable: true, lockingScript: o.lockingScript, customInstructions: o.customInstructions! } }]).wallet)).toEqual([s.sats]);
  });

  it("with tokens: the plan a transfer out; output 0 the token output to a fresh key, its description naming the key (… · amm-swap <hex>), output 1 the sats output filed by the action; labelled amm-swap-stage; the page's submit; the token output filed by basket insertion", async () => {
    const { wallet, calls } = fakeWallet();
    const submitted: string[] = [];
    const s = await stage(wallet, { sats: 9_000, tokens: { tokenId: TOKEN, amount: 42n } }, { sym: "TST", submit: async (t) => (submitted.push(t), {}) });
    const keys = calls.filter((c) => c.method === "getPublicKey").map((c) => (c.args as KeyArgs).keyID);
    expect(keys).toHaveLength(2);
    const [satsKey, tokenKey] = keys as [string, string];
    expect(satsKey).not.toBe(tokenKey);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.inputs).toBeUndefined();
    expect(create.labels!.slice(-2)).toEqual(["amm-swap", SWAP_STAGE_LABEL]);
    expect(SWAP_STAGE_LABEL).toBe("amm-swap-stage");
    expect(ColorPlan.fromLabels(create.labels)).toEqual({ version: 1, assets: [TOKEN], ownedOutputs: [], operations: [{ assetId: TOKEN, operation: "transfer" }], inputPositions: [], changePositions: [], sighashTypes: [] });
    expect(create.outputs!.map((o) => [o.satoshis, o.basket])).toEqual([[1, undefined], [9_000, "amm-swap"]]);
    expect(create.outputs![0]!.lockingScript).toBe(tokenP2pkhScript(TOKEN, 42n, side.publicKey({ protocolID: SWAP, keyID: tokenKey, counterparty: "self", forSelf: true })));
    expect(create.outputs![0]!.outputDescription).toBe(`TST for a swap · amm-swap ${tokenKey.slice("amm-swap-".length)}`);
    expect(swapKeyIdOfDescription(create.outputs![0]!.outputDescription)).toBe(tokenKey);
    expect(submitted).toEqual([TOPIC]);
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: { outputIndex: number; insertionRemittance: { basket: string; customInstructions: string } }[]; labels: string[] };
    expect(ia.labels).toEqual(["amm-swap"]);
    expect(ia.outputs.map((o) => [o.outputIndex, o.insertionRemittance.basket])).toEqual([[0, "amm-swap"]]);
    expect(JSON.parse(ia.outputs[0]!.insertionRemittance.customInstructions)).toEqual({ assetId: TOKEN, amount: "42", protocolID: SWAP, keyID: tokenKey, counterparty: "self" });
    expect(s).toMatchObject({ filed: true, errors: [], sats: { outpoint: `${s.txid}.1`, satoshis: 9_000, keyID: satsKey }, tokens: { outpoint: `${s.txid}.0`, amount: 42n, keyID: tokenKey } });
    // Filed, the token row reads back as a leg's token input.
    const tx = Transaction.fromAtomicBEEF(s.tx);
    const row = { outpoint: `${s.txid}.0`, satoshis: 1, lockingScript: tx.outputs[0]!.lockingScript.toHex(), customInstructions: ia.outputs[0]!.insertionRemittance.customInstructions };
    expect(tokenInputsOf([row], TOKEN).map((t) => [t.amount, t.keyID])).toEqual([[42n, tokenKey]]);
    expect(await swapTotals(fakeWallet([{ tx, row: { ...row, spendable: true } }]).wallet)).toEqual(new Map([[TOKEN, { amount: 42n, outputs: 1 }]]));
  });

  it("a labelled staged token output the basket lacks is found from its action's description and filed by basket insertion over its BEEF", async () => {
    const { wallet, calls } = fakeWallet();
    const keyID = `amm-swap-${"3c".repeat(16)}`;
    const script = tokenP2pkhScript(TOKEN, 42n, side.publicKey({ protocolID: SWAP, keyID, counterparty: "self", forSelf: true }));
    const w = {
      ...wallet,
      listActions: async (a: { labels: string[] }) => (
        calls.push({ method: "listActions", args: a }),
        {
          totalActions: 1,
          actions: [
            {
              txid: "5e".repeat(32),
              outputs: [
                { outputIndex: 0, satoshis: 1, lockingScript: script, outputDescription: swapKeyDescription("TST for a swap", keyID) },
                { outputIndex: 1, satoshis: 9_000, lockingScript: "76a914" + "00".repeat(20) + "88ac", outputDescription: "Sats for a TST swap", basket: "amm-swap" },
                { outputIndex: 2, satoshis: 1, lockingScript: script, outputDescription: swapKeyDescription("TST for a swap", keyID), basket: "amm-swap" },
              ],
            },
          ],
        }
      ),
    } as unknown as WalletInterface;
    const found = await unfiledStagedTokens(w);
    expect((calls.find((c) => c.method === "listActions")!.args as { labels: string[] }).labels).toEqual([SWAP_STAGE_LABEL]);
    expect(found).toEqual([{ txid: "5e".repeat(32), vout: 0, tokenId: TOKEN, amount: 42n, keyID }]);
    const t = new Transaction();
    t.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    t.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(script) });
    expect(await fileStagedToken(w, found[0]!, t.toAtomicBEEF(true))).toBe(true);
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: { outputIndex: number; insertionRemittance: { basket: string; customInstructions: string } }[] };
    expect(ia.outputs.map((o) => [o.outputIndex, o.insertionRemittance.basket, JSON.parse(o.insertionRemittance.customInstructions)])).toEqual([[0, "amm-swap", { assetId: TOKEN, amount: "42", protocolID: SWAP, keyID, counterparty: "self" }]]);
  });

  it("nothing to stage, or a wallet that refuses: an error, nothing filed", async () => {
    const { wallet, calls } = fakeWallet();
    await expect(stage(wallet, { sats: 0 })).rejects.toThrow(/nothing to stage/);
    await expect(stage(wallet, { sats: 5, tokens: { tokenId: TOKEN, amount: 0n } })).rejects.toThrow(/nothing to stage/);
    (wallet as unknown as { createAction: () => Promise<never> }).createAction = async () => {
      throw new Error("BRC-207: the user declined the color_send request");
    };
    await expect(stage(wallet, { sats: 3, tokens: { tokenId: TOKEN, amount: 5n } }, { submit: async () => ({}) })).rejects.toThrow(/declined/);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });
});

describe("move back (0.29.3; 0.40.0: with every sats row): ONE module plan — every amm-swap row of the token and every sats row a (foreign) explicit input, one output to a module receiving key of the user's own as the plan's owned output", () => {
  it("createAction {p color plan transfer with ownedOutputs [0 → the receipt's remittance], inputBEEF, inputs (108-byte unlocks), one 1Color output, no basket, no customInstructions} → signAction with the page's unlocks; the wallet funds it; submitted; no take-in, nothing kept", async () => {
    const a = swapRow(30n, "amm-swap-a");
    const b = swapRow(12n, "amm-swap-b");
    const mine = satsRow(77, "amm-swap-s");
    const more = satsRow(66, "amm-swap-o");
    const other = swapRow(5n, "amm-swap-x");
    const otherToken = { ...other, row: { ...other.row, lockingScript: other.row.lockingScript.replace(Utils.toHex(tokenDeploy.hash() as number[]), "ab".repeat(32)) } };
    const { wallet, calls } = fakeWallet([a, b, mine, more, otherToken]);
    const submitted: { topic: string; beef: number[] }[] = [];
    const r = await moveBack({
      wallet,
      base: "http://x/amm",
      tokenId: TOKEN,
      meta: { sym: "TST" },
      submit: async (topic, beef) => (submitted.push({ topic, beef }), { steak: { [topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [0, 1] } } }),
    });
    expect(r.amount).toBe(42n);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    // The token's rows (not another token's) and (0.40.0) every sats row, each an explicit input the page unlocks; their sources in inputBEEF.
    expect(create.inputs).toEqual([
      { outpoint: a.row.outpoint, unlockingScriptLength: 108, inputDescription: "TST in the swap basket" },
      { outpoint: b.row.outpoint, unlockingScriptLength: 108, inputDescription: "TST in the swap basket" },
      { outpoint: mine.row.outpoint, unlockingScriptLength: 108, inputDescription: "Sats in the swap basket" },
      { outpoint: more.row.outpoint, unlockingScriptLength: 108, inputDescription: "Sats in the swap basket" },
    ]);
    const ib = Beef.fromBinary(Array.from(create.inputBEEF!));
    expect(ib.findTxid(a.tx.id("hex"))).toBeTruthy();
    expect(ib.findTxid(b.tx.id("hex"))).toBeTruthy();
    expect(ib.findTxid(mine.tx.id("hex"))).toBeTruthy();
    expect(create.labels!.at(-1)).toBe("amm-swap");
    const plan = ColorPlan.fromLabels(create.labels)!;
    expect(plan).toMatchObject({ version: 1, assets: [TOKEN], operations: [{ assetId: TOKEN, operation: "transfer" }], inputPositions: [], changePositions: [] });
    expect(plan.ownedOutputs).toHaveLength(1);
    const receipt = plan.ownedOutputs[0]!;
    expect(receipt).toMatchObject({ outputIndex: 0, assetId: TOKEN, senderIdentityKey: side.identityKey });
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.outputs).toHaveLength(1);
    const o = create.outputs![0]!;
    expect(o.satoshis).toBe(1);
    expect(o.basket).toBeUndefined(); // the module files it
    expect(o.customInstructions).toBeUndefined(); // the module writes the custody
    const recv = side.publicKey({ protocolID: colorProtocolID(TOKEN, receipt.derivationPrefix, receipt.derivationSuffix), keyID: "color", counterparty: side.identityKey, forSelf: true });
    expect(o.lockingScript).toBe(tokenP2pkhScript(TOKEN, 42n, recv));

    // signAction: the page's unlocks for inputs 0-2 (the wallet's funding is its own).
    const sa = calls.find((c) => c.method === "signAction")!.args as { reference: string; spends: Record<number, { unlockingScript: string }>; options?: unknown };
    expect(sa.reference).toBe("ref-mb");
    expect(Object.keys(sa.spends)).toEqual(["0", "1", "2", "3"]);
    expect(sa.options).toEqual({ acceptDelayedBroadcast: false });
    const tx = Transaction.fromAtomicBEEF(r.beef);
    expect(tx.id("hex")).toBe(r.txid);
    expect(tx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([a.row.outpoint, b.row.outpoint, mine.row.outpoint, more.row.outpoint, `${fund.id("hex")}.0`]);
    for (let n = 0; n < 5; n++) expect(spendValid(tx, n)).toBe(true);
    // The sats are absorbed by the wallet's change: the only page output is the 1-sat token output.
    expect(create.outputs).toHaveLength(1);
    for (const n of [0, 1, 2, 3]) expect(tx.inputs[n]!.unlockingScript!.toHex()).toBe(sa.spends[n]!.unlockingScript);
    expect(submitted.map((x) => x.topic)).toEqual([TOPIC]);
    expect(submitted[0]!.beef).toEqual(r.beef);
    expect(r.submitted).toBe(`admitted under ${TOPIC} (outputs 0)`);

    expect(calls.some((c) => c.method === "internalizeAction" || c.method === "relinquishOutput")).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it("an unlock that does not validate: the action is aborted, nothing signed or broadcast", async () => {
    const a = swapRow(5n, "amm-swap-d");
    // The row names a key that is not the one its output is locked to.
    const bad = { ...a, row: { ...a.row, customInstructions: JSON.stringify({ assetId: TOKEN, amount: "5", protocolID: SWAP, keyID: "amm-swap-other", counterparty: "self" }) } };
    const { wallet, calls } = fakeWallet([bad]);
    await expect(moveBack({ wallet, base: "http://x/amm", tokenId: TOKEN, submit: async () => ({}) })).rejects.toThrow(/does not validate/);
    expect(calls.map((c) => c.method).filter((m) => ["createAction", "signAction", "abortAction", "internalizeAction"].includes(m))).toEqual(["createAction", "abortAction"]);
  });

  it("the page's submit fails after the wallet's broadcast: reported, nothing else to do (the module filed the output)", async () => {
    const a = swapRow(4n, "amm-swap-e");
    const { wallet } = fakeWallet([a]);
    const r = await moveBack({ wallet, base: "http://x/amm", tokenId: TOKEN, submit: async () => { throw new Error("502"); } });
    expect(r.submitted).toBe("the submit failed");
    expect(r.errors[0]).toMatch(/submit: 502/);
  });

  it("0.29.6 (0.40.0: every sats row), no token row: ONE plain createAction — the sats rows the explicit inputs (108-byte unlocks, sources in inputBEEF), NO outputs, labels [amm-swap], no p color plan — then signAction with the page's unlocks; nothing submitted, nothing taken in", async () => {
    const s1 = satsRow(5_000, "amm-swap-s1");
    const s2 = satsRow(2_500, "amm-swap-s2");
    const { wallet, calls } = fakeWallet([s1, s2]);
    const submitted: string[] = [];
    const r = await moveBack({ wallet, base: "http://x/amm", tokenId: TOKEN, meta: { sym: "TST" }, submit: async (topic) => (submitted.push(topic), {}) });
    expect(r.amount).toBe(0n);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.inputs).toEqual([
      { outpoint: s1.row.outpoint, unlockingScriptLength: 108, inputDescription: "Sats in the swap basket" },
      { outpoint: s2.row.outpoint, unlockingScriptLength: 108, inputDescription: "Sats in the swap basket" },
    ]);
    expect(create.outputs).toEqual([]);
    expect(create.labels).toEqual(["amm-swap"]);
    expect(ColorPlan.fromLabels(create.labels)).toBeFalsy();
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    const ib = Beef.fromBinary(Array.from(create.inputBEEF!));
    expect(ib.findTxid(s1.tx.id("hex"))).toBeTruthy();
    expect(ib.findTxid(s2.tx.id("hex"))).toBeTruthy();
    const sa = calls.find((c) => c.method === "signAction")!.args as { reference: string; spends: Record<number, { unlockingScript: string }> };
    expect(sa.reference).toBe("ref-mb");
    expect(Object.keys(sa.spends)).toEqual(["0", "1"]);
    const tx = Transaction.fromAtomicBEEF(r.beef);
    expect(tx.id("hex")).toBe(r.txid);
    for (let n = 0; n < tx.inputs.length; n++) expect(spendValid(tx, n)).toBe(true);
    expect(tx.outputs).toHaveLength(1); // the fake wallet's change only
    expect(submitted).toEqual([]);
    expect(calls.some((c) => c.method === "internalizeAction" || c.method === "relinquishOutput")).toBe(false);
    expect(r.errors).toEqual([]);
    // The sats are no token's (0.40.0): swapTotals lists none; swapSatsTotal sums them, shown once.
    expect(await swapTotals(fakeWallet([s1, s2]).wallet)).toEqual(new Map());
    expect(await swapSatsTotal(fakeWallet([s1, s2]).wallet)).toBe(7_500);
    // moveBackSats on its own (Your tokens' line): the same one action over every sats row.
    const alone = fakeWallet([s1, s2]);
    const m = await moveBackSats(alone.wallet);
    expect((alone.calls.find((c) => c.method === "createAction")!.args as CreateActionArgs).inputs!.map((i) => i.outpoint)).toEqual([s1.row.outpoint, s2.row.outpoint]);
    expect(m.amount).toBe(0n);
    await expect(moveBackSats(fakeWallet([]).wallet)).rejects.toThrow(/holds no sats/);
  });

  it("nothing in the swap basket: an error before any action", async () => {
    const { wallet, calls } = fakeWallet([]);
    await expect(moveBack({ wallet, base: "http://x/amm", tokenId: TOKEN })).rejects.toThrow(/holds no token/);
    expect(calls.some((c) => c.method === "createAction")).toBe(false);
  });
});
