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
import { BigNumber, Beef, ECDSA, LockingScript, P2PKH, PrivateKey, PublicKey, Transaction, UnlockingScript, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { colorReceiptInstructions } from "@1sat/actions";
import { ColorPlan, colorProtocolID } from "@bsv/color-permission-module";
import { describe, expect, it } from "vitest";
import { brc29Side, type KeyArgs } from "./brc29Wallet";
import { moveBack, sendSatsToSwapBasket, sendToSwapBasket, swapSatsHoldings, swapTotals } from "../src/market/activeSwap";
import { satsInputsOf, selectExactSatsInput, spendValid, tokenInputsOf } from "../src/market/swapAction";
import { tokenP2pkhScript } from "../src/lp/poolDeploy";
import { PendingPayoutStore, internalizeNow, type KV } from "../src/wallet/pendingPayouts";
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

/** An `amm-swap` sats row of `satoshis` under keyID `keyID`, staged for `assetId`'s swap (0.29.0; 0.29.1 the assetId). */
function satsRow(satoshis: number, keyID: string, assetId = TOKEN) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: "78".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(PublicKey.fromString(side.publicKey({ protocolID: SWAP, keyID, counterparty: "self", forSelf: true })).toAddress()) });
  return {
    tx,
    row: { outpoint: `${tx.id("hex")}.0`, satoshis, spendable: true, lockingScript: tx.outputs[0]!.lockingScript.toHex(), customInstructions: JSON.stringify({ sats: true, assetId, protocolID: SWAP, keyID, counterparty: "self" }) },
  };
}

const memKV = (): KV => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, val) => void m.set(k, val) };
};

describe("into the swap basket (0.29.0): ONE send per swap — the module send with the tokens AND the legs' sats, or a plain sats send", () => {
  it("tokens + sats: keys under [2, \"amm swap\"] (self, a fresh keyID each); the plan a transfer out; the sats outputs after the tokens, filed in amm-swap by the createAction (sats: true); the page's submit; each token output filed with its key", async () => {
    const { wallet, calls } = fakeWallet();
    const submitted: string[] = [];
    const s = await sendToSwapBasket(wallet, "http://x/amm", TOKEN, { tokens: [30n, 12n], sats: [41, 37] }, { sym: "TST" }, async (topic) => (submitted.push(topic), {}));
    const keys = calls.filter((c) => c.method === "getPublicKey").map((c) => c.args as KeyArgs);
    expect(keys.map((k) => [k.protocolID, k.counterparty, k.forSelf])).toEqual(Array(4).fill([SWAP, "self", true]));
    expect(new Set(keys.map((k) => k.keyID)).size).toBe(4);
    for (const k of keys) expect(k.keyID).toMatch(/^amm-swap-[0-9a-f]{16}$/);

    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.inputs).toBeUndefined(); // the module selects the token inputs; the wallet funds the sats
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.labels!.at(-1)).toBe("amm-swap");
    expect(ColorPlan.fromLabels(create.labels)).toEqual({ version: 1, assets: [TOKEN], ownedOutputs: [], operations: [{ assetId: TOKEN, operation: "transfer" }], inputPositions: [], changePositions: [], sighashTypes: [] });
    const p2pkh = (k: KeyArgs) => new P2PKH().lock(PublicKey.fromString(side.publicKey({ ...k })).toAddress()).toHex();
    expect(create.outputs!.map((o) => [o.satoshis, o.lockingScript])).toEqual([
      [1, tokenP2pkhScript(TOKEN, 30n, side.publicKey({ ...keys[0]! }))],
      [1, tokenP2pkhScript(TOKEN, 12n, side.publicKey({ ...keys[1]! }))],
      [41, p2pkh(keys[2]!)],
      [37, p2pkh(keys[3]!)],
    ]);
    // Token outputs: destinations (no basket; filed after, by insertion). Sats outputs: filed in amm-swap by the createAction.
    expect(create.outputs!.map((o) => o.basket)).toEqual([undefined, undefined, "amm-swap", "amm-swap"]);
    expect(JSON.parse(create.outputs![2]!.customInstructions!)).toEqual({ sats: true, assetId: TOKEN, protocolID: SWAP, keyID: keys[2]!.keyID, counterparty: "self" });
    expect(submitted).toEqual([TOPIC]);

    expect(s.holdings.map((h) => [h.outpoint, h.amount, h.keyID])).toEqual([
      [`${s.txid}.0`, 30n, keys[0]!.keyID],
      [`${s.txid}.1`, 12n, keys[1]!.keyID],
    ]);
    expect(s.sats.map((h) => [h.outpoint, h.satoshis, h.keyID])).toEqual([
      [`${s.txid}.2`, 41, keys[2]!.keyID],
      [`${s.txid}.3`, 37, keys[3]!.keyID],
    ]);
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { tx: number[]; outputs: { outputIndex: number; insertionRemittance: { basket: string; customInstructions: string } }[]; labels: string[] };
    expect(ia.tx).toEqual(s.tx);
    expect(ia.labels).toEqual(["amm-swap"]);
    // Only the token outputs are filed by insertion (the sats are already in amm-swap).
    expect(ia.outputs.map((o) => [o.outputIndex, o.insertionRemittance.basket])).toEqual([[0, "amm-swap"], [1, "amm-swap"]]);
    expect(JSON.parse(ia.outputs[1]!.insertionRemittance.customInstructions)).toEqual({ assetId: TOKEN, amount: "12", protocolID: SWAP, keyID: keys[1]!.keyID, counterparty: "self" });
    expect(s).toMatchObject({ filed: true, submitted: "not decided yet", errors: [] });

    // Filed rows read back as the legs' token inputs, the sats rows as their sats, and the page's totals count tokens only.
    const tx = Transaction.fromAtomicBEEF(s.tx);
    const rows = ia.outputs.map((o) => ({ outpoint: `${s.txid}.${o.outputIndex}`, satoshis: 1, lockingScript: tx.outputs[o.outputIndex]!.lockingScript.toHex(), customInstructions: o.insertionRemittance.customInstructions }));
    const satsRows = [2, 3].map((n) => ({ outpoint: `${s.txid}.${n}`, satoshis: tx.outputs[n]!.satoshis!, lockingScript: tx.outputs[n]!.lockingScript.toHex(), customInstructions: create.outputs![n]!.customInstructions! }));
    expect(tokenInputsOf([...rows, ...satsRows], TOKEN).map((t) => [t.amount, t.protocolID, t.keyID])).toEqual([[30n, SWAP, keys[0]!.keyID], [12n, SWAP, keys[1]!.keyID]]);
    expect(satsInputsOf([...rows, ...satsRows]).map((t) => [t.outpoint, t.satoshis, t.keyID])).toEqual([[`${s.txid}.2`, 41, keys[2]!.keyID], [`${s.txid}.3`, 37, keys[3]!.keyID]]);
    expect(await swapTotals(fakeWallet([{ tx, row: { ...rows[0]!, spendable: true } }, { tx, row: { ...satsRows[0]!, spendable: true } }]).wallet)).toEqual(new Map([[TOKEN, { amount: 30n, outputs: 1 }]]));
  });

  it("sats only (a sats-in swap, or tokens already staged): a plain createAction, no p color labels, the sats outputs filed in amm-swap; nothing submitted, nothing internalized", async () => {
    const { wallet, calls } = fakeWallet();
    const s = await sendSatsToSwapBasket(wallet, TOKEN, [20_123, 9], { sym: "TST" });
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(create.labels).toEqual(["amm-swap"]);
    expect(create.inputs).toBeUndefined();
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.outputs!.map((o) => [o.satoshis, o.basket, JSON.parse(o.customInstructions!).sats])).toEqual([[20_123, "amm-swap", true], [9, "amm-swap", true]]);
    expect(s.sats.map((h) => [h.outpoint, h.satoshis])).toEqual([[`${s.txid}.0`, 20_123], [`${s.txid}.1`, 9]]);
    expect(s.errors).toEqual([]);
    expect(calls.some((c) => c.method === "internalizeAction" || c.method === "signAction")).toBe(false);
    // The legs find them (exact amounts only: a leg has no change).
    const tx = Transaction.fromAtomicBEEF(s.tx);
    const rows = [0, 1].map((n) => ({ tx, row: { outpoint: `${s.txid}.${n}`, satoshis: tx.outputs[n]!.satoshis!, spendable: true, lockingScript: tx.outputs[n]!.lockingScript.toHex(), customInstructions: create.outputs![n]!.customInstructions! } }));
    const held = await swapSatsHoldings(fakeWallet(rows).wallet);
    expect(selectExactSatsInput(held, 9)?.outpoint).toBe(`${s.txid}.1`);
    expect(selectExactSatsInput(held, 10)).toBeNull();
  });

  it("nothing to send, or a wallet that refuses: an error, nothing filed", async () => {
    const { wallet, calls } = fakeWallet();
    await expect(sendToSwapBasket(wallet, "http://x/amm", TOKEN, { tokens: [], sats: [] })).rejects.toThrow(/nothing to send/);
    await expect(sendSatsToSwapBasket(wallet, TOKEN, [])).rejects.toThrow(/nothing to send/);
    (wallet as unknown as { createAction: () => Promise<never> }).createAction = async () => {
      throw new Error("BRC-207: the user declined the color_send request");
    };
    await expect(sendToSwapBasket(wallet, "http://x/amm", TOKEN, { tokens: [5n], sats: [3] }, {}, async () => ({}))).rejects.toThrow(/declined/);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });
});

describe("move back (0.29.0): ONE wallet createAction — every amm-swap output of the token an explicit input, one output to a module receiving key of the user's own", () => {
  it("createAction {inputBEEF, inputs (108-byte unlocks), one 1Color output carrying the receipt, no basket} → signAction with the page's unlocks; the wallet funds it; submitted; taken in with the receipt; no relinquishOutput", async () => {
    const a = swapRow(30n, "amm-swap-a");
    const b = swapRow(12n, "amm-swap-b");
    const mine = satsRow(77, "amm-swap-s");
    const others = satsRow(66, "amm-swap-o", `${"ab".repeat(32)}_0`);
    const { wallet, calls } = fakeWallet([a, b, mine, others]);
    const store = new PendingPayoutStore(memKV());
    const submitted: { topic: string; beef: number[] }[] = [];
    const r = await moveBack({
      wallet,
      af: null,
      base: "http://x/amm",
      tokenId: TOKEN,
      meta: { sym: "TST" },
      payouts: store,
      submit: async (topic, beef) => (submitted.push({ topic, beef }), { steak: { [topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [0, 1] } } }),
    });
    expect(r.amount).toBe(42n);
    const create = calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    // The token's rows and (0.29.1) the sats row staged for its legs — not another token's — each an explicit input the page unlocks; their sources in inputBEEF.
    expect(create.inputs).toEqual([
      { outpoint: a.row.outpoint, unlockingScriptLength: 108, inputDescription: "TST in the swap basket" },
      { outpoint: b.row.outpoint, unlockingScriptLength: 108, inputDescription: "TST in the swap basket" },
      { outpoint: mine.row.outpoint, unlockingScriptLength: 108, inputDescription: "Sats staged for a TST swap" },
    ]);
    const ib = Beef.fromBinary(Array.from(create.inputBEEF!));
    expect(ib.findTxid(a.tx.id("hex"))).toBeTruthy();
    expect(ib.findTxid(b.tx.id("hex"))).toBeTruthy();
    expect(ib.findTxid(mine.tx.id("hex"))).toBeTruthy();
    expect(create.labels).toEqual(["amm-swap"]); // no p color labels: the module is not in the path
    expect(create.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(create.outputs).toHaveLength(1);
    const o = create.outputs![0]!;
    expect(o.satoshis).toBe(1);
    expect(o.basket).toBeUndefined();
    const receipt = JSON.parse(o.customInstructions!) as { assetId: string; derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string };
    expect(o.customInstructions).toBe(colorReceiptInstructions({ assetId: TOKEN, derivationPrefix: receipt.derivationPrefix, derivationSuffix: receipt.derivationSuffix, senderIdentityKey: side.identityKey }));
    const recv = side.publicKey({ protocolID: colorProtocolID(TOKEN, receipt.derivationPrefix, receipt.derivationSuffix), keyID: "color", counterparty: side.identityKey, forSelf: true });
    expect(o.lockingScript).toBe(tokenP2pkhScript(TOKEN, 42n, recv));

    // signAction: the page's unlocks for inputs 0-2 (the wallet's funding is its own).
    const sa = calls.find((c) => c.method === "signAction")!.args as { reference: string; spends: Record<number, { unlockingScript: string }>; options?: unknown };
    expect(sa.reference).toBe("ref-mb");
    expect(Object.keys(sa.spends)).toEqual(["0", "1", "2"]);
    expect(sa.options).toEqual({ acceptDelayedBroadcast: false });
    const tx = Transaction.fromAtomicBEEF(r.beef);
    expect(tx.id("hex")).toBe(r.txid);
    expect(tx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([a.row.outpoint, b.row.outpoint, mine.row.outpoint, `${fund.id("hex")}.0`]);
    for (let n = 0; n < 4; n++) expect(spendValid(tx, n)).toBe(true);
    // The sats are absorbed by the wallet's change: the only page output is the 1-sat token output.
    expect(create.outputs).toHaveLength(1);
    for (const n of [0, 1, 2]) expect(tx.inputs[n]!.unlockingScript!.toHex()).toBe(sa.spends[n]!.unlockingScript);
    expect(submitted.map((x) => x.topic)).toEqual([TOPIC]);
    expect(submitted[0]!.beef).toEqual(r.beef);
    expect(r.submitted).toBe(`admitted under ${TOPIC} (outputs 0)`);

    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: unknown[] };
    expect(ia.outputs).toEqual([{ outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: `p color ${TOKEN.slice(0, 64)}v0`, customInstructions: o.customInstructions } }]);
    expect(r.internalized).toBe(true);
    expect(calls.some((c) => c.method === "relinquishOutput")).toBe(false);
    expect(r.errors).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("an unlock that does not validate: the action is aborted, nothing signed or broadcast", async () => {
    const a = swapRow(5n, "amm-swap-d");
    // The row names a key that is not the one its output is locked to.
    const bad = { ...a, row: { ...a.row, customInstructions: JSON.stringify({ assetId: TOKEN, amount: "5", protocolID: SWAP, keyID: "amm-swap-other", counterparty: "self" }) } };
    const { wallet, calls } = fakeWallet([bad]);
    await expect(moveBack({ wallet, af: null, base: "http://x/amm", tokenId: TOKEN, submit: async () => ({}) })).rejects.toThrow(/does not validate/);
    expect(calls.map((c) => c.method).filter((m) => ["createAction", "signAction", "abortAction", "internalizeAction"].includes(m))).toEqual(["createAction", "abortAction"]);
  });

  it("not admitted yet: kept as a pending payout (its receipt and the BEEF), taken in on a retry", async () => {
    const a = swapRow(9n, "amm-swap-c");
    const { wallet, calls } = fakeWallet([a]);
    const store = new PendingPayoutStore(memKV());
    const r = await moveBack({ wallet, af: null, base: "http://x/amm", tokenId: TOKEN, payouts: store, submit: async () => ({}), admitted: async () => false });
    expect(r.internalized).toBe(false);
    expect(r.errors).toEqual(["the token topic has not admitted the move back yet: your wallet takes it in on a retry"]);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
    const [rec] = store.list();
    expect(rec).toMatchObject({ kind: "move-back", txid: r.txid, vout: 0, final: true, tokenId: TOKEN, receipt: { assetId: TOKEN, senderIdentityKey: side.identityKey } });
    expect(rec!.remittance).toBeUndefined();
    // The retry: the BEEF the record holds, no lookup; the module's receive with the receipt.
    expect(await internalizeNow(wallet, store, null, "http://x/amm", rec!)).toEqual({ accepted: true, txid: r.txid });
    const ia = calls.find((c) => c.method === "internalizeAction")!.args as { outputs: { insertionRemittance: { customInstructions: string } }[] };
    expect(ia.outputs[0]!.insertionRemittance.customInstructions).toBe(colorReceiptInstructions(rec!.receipt!));
    expect(store.list()).toEqual([]);
  });

  it("the submit fails after the wallet's broadcast: the receipt is kept, the error reported", async () => {
    const a = swapRow(4n, "amm-swap-e");
    const { wallet } = fakeWallet([a]);
    const store = new PendingPayoutStore(memKV());
    const r = await moveBack({ wallet, af: null, base: "http://x/amm", tokenId: TOKEN, payouts: store, submit: async () => { throw new Error("502"); }, admitted: async () => false });
    expect(r.submitted).toBe("the submit failed");
    expect(r.errors[0]).toMatch(/submit: 502/);
    expect(store.list()).toHaveLength(1);
  });

  it("nothing in the swap basket: an error before any action", async () => {
    const { wallet, calls } = fakeWallet([]);
    await expect(moveBack({ wallet, af: null, base: "http://x/amm", tokenId: TOKEN })).rejects.toThrow(/holds no token/);
    expect(calls.some((c) => c.method === "createAction")).toBe(false);
  });
});
