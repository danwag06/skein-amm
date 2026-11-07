/**
 * The LP wallet catches up one hop at a time from the pool output it holds.
 * History is asked with that outpoint. The page's `next` is not read. One
 * internalize files the continuation and, on a swap, the LP fee. Close-shaped
 * output 0 and a transaction that does not spend the held output stop the walk.
 */
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import type { PoolEvent } from "../src/lib/overlay";
import { PoolTemplate, RESCINDED_KEY } from "../src/pool";
import { POOL_TAG, tokenP2pkhScript } from "../src/lp/poolDeploy";
import { FEES_BASKET, collectBasket, syncPool, type SyncIo } from "../src/lp/sync";
import { POOLS_BASKET } from "../src/wallet/color";
import v from "./fixtures/amm-topic-vectors.json";

const tokenDeploy = Transaction.fromHex(v.token_deploy);
const poolDeploy = Transaction.fromHex(v.pool_deploy);
const TOKEN_ID = `${tokenDeploy.id("hex")}_0`;
const POOL_ID = `${poolDeploy.id("hex")}_0`;
const payee = new PrivateKey(11);
const PUB = payee.toPublicKey().toString();
const pool = PoolTemplate.decode(poolDeploy.outputs[0]!.lockingScript)!;
const payout = new P2PKH().lock(payee.toAddress());
const feeLock = new P2PKH().lock(payee.toAddress());

const HELD = {
  id: TOKEN_ID,
  op: "amm-pool",
  protocolID: [1, "openex fees"] as [number, string],
  keyID: Utils.toBase64(Array.from({ length: 16 }, (_, n) => n + 1)),
  counterparty: "self",
};

interface Row {
  outpoint: string;
  satoshis: number;
  lockingScript?: string;
  customInstructions?: string;
  tags?: string[];
}

function deployRow(): Row {
  return {
    outpoint: `${poolDeploy.id("hex")}.0`,
    satoshis: poolDeploy.outputs[0]!.satoshis!,
    lockingScript: poolDeploy.outputs[0]!.lockingScript.toHex(),
    customInstructions: JSON.stringify(HELD),
    tags: [POOL_TAG],
  };
}

function spend(source: Transaction, vout: number, outputs: { satoshis: number; lockingScript: LockingScript | string }[]): Transaction {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: source.id("hex"),
    sourceOutputIndex: vout,
    sourceTransaction: source,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  });
  for (const o of outputs) {
    tx.addOutput({
      satoshis: o.satoshis,
      lockingScript: typeof o.lockingScript === "string" ? LockingScript.fromHex(o.lockingScript) : o.lockingScript,
    });
  }
  return tx;
}

function rawBeef(tx: Transaction, parents: Transaction[]): number[] {
  const b = new Beef();
  for (const p of parents) b.mergeRawTx(p.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinary();
}

function event(tx: Transaction, kind: PoolEvent["kind"], extra: Partial<PoolEvent> = {}): PoolEvent {
  return {
    kind,
    txid: tx.id("hex"),
    poolId: POOL_ID,
    lpPubKey: pool.state.lpPubKey,
    liquidityFeeBps: 30n,
    validationFeeBps: 5n,
    commissionBps: 10n,
    validatorIdentityKey: pool.state.validatorIdentity,
    at: 1,
    swaps: 1,
    ...extra,
  };
}

function continuationScript(sourceScript: LockingScript, state = pool.state): LockingScript {
  const decoded = PoolTemplate.decode(sourceScript)!;
  return PoolTemplate.lockContinuation(decoded, state);
}

interface WalletBag {
  wallet: WalletInterface;
  calls: { method: string; args: unknown }[];
  pools: Row[];
  fees: Row[];
}

function syncWallet(initial: { pools?: Row[]; fees?: Row[]; feeTxs?: Transaction[] } = {}): WalletBag {
  const pools = [...(initial.pools ?? [])];
  const fees = [...(initial.fees ?? [])];
  const feeTxs = initial.feeTxs ?? [];
  const calls: { method: string; args: unknown }[] = [];
  const wallet = {
    async listOutputs(args: { basket?: string; include?: string }) {
      calls.push({ method: "listOutputs", args });
      if (args.include === "entire transactions") {
        const b = new Beef();
        for (const tx of feeTxs) b.mergeRawTx(tx.toBinary());
        return feeTxs.length === 0 ? { outputs: [], totalOutputs: 0 } : { outputs: [], totalOutputs: fees.length, BEEF: b.toBinary() };
      }
      const rows = args.basket === FEES_BASKET ? fees : args.basket === POOLS_BASKET ? pools : [];
      return { outputs: rows, totalOutputs: rows.length };
    },
    async internalizeAction(args: { tx: number[]; outputs: { outputIndex: number; protocol: string; insertionRemittance?: { basket: string; tags?: string[]; customInstructions?: string } }[]; description: string; labels?: string[] }) {
      calls.push({ method: "internalizeAction", args });
      const beef = Beef.fromBinary(args.tx);
      const subject = beef.txs[beef.txs.length - 1];
      const tx = subject?.tx ?? (subject?.rawTx ? Transaction.fromBinary(subject.rawTx) : undefined);
      if (tx) {
        const txid = tx.id("hex");
        for (const o of args.outputs) {
          const rem = o.insertionRemittance;
          if (o.protocol !== "basket insertion" || !rem) continue;
          const out = tx.outputs[o.outputIndex];
          const row: Row = {
            outpoint: `${txid}.${o.outputIndex}`,
            satoshis: out?.satoshis ?? 0,
            lockingScript: out?.lockingScript.toHex(),
            customInstructions: rem.customInstructions,
            ...(rem.tags ? { tags: rem.tags } : {}),
          };
          if (rem.basket === FEES_BASKET) fees.push(row);
          else pools.push(row);
        }
      }
      return { accepted: true };
    },
    async getPublicKey(args: { identityKey?: boolean }) {
      calls.push({ method: "getPublicKey", args });
      return { publicKey: PUB };
    },
    async createAction(args: CreateActionArgs) {
      calls.push({ method: "createAction", args });
      return {};
    },
    async abortAction(args: unknown) {
      calls.push({ method: "abortAction", args });
      return { aborted: true };
    },
  };
  return { wallet: wallet as unknown as WalletInterface, calls, pools, fees };
}

function ioOf(pages: Map<string, PoolEvent[]>, txs: Map<string, number[]>): SyncIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async history(outpoint) {
      asked.push(outpoint);
      return { events: pages.get(outpoint) ?? [] };
    },
    async readTx(txid) {
      return txs.get(txid.toLowerCase()) ?? null;
    },
  };
}

function internalized(bag: WalletBag) {
  return bag.calls.filter((c) => c.method === "internalizeAction").map((c) => c.args as { tx: number[]; outputs: { outputIndex: number; insertionRemittance?: { basket?: string; tags?: string[]; customInstructions?: string } }[]; description: string; labels?: string[] });
}

describe("syncPool", () => {
  const cont = continuationScript(poolDeploy.outputs[0]!.lockingScript);
  const swap = spend(poolDeploy, 0, [
    { satoshis: poolDeploy.outputs[0]!.satoshis!, lockingScript: cont },
    { satoshis: 1000, lockingScript: payout },
    { satoshis: 60, lockingScript: feeLock },
  ]);
  const swapBeef = rawBeef(swap, [poolDeploy]);
  const swapCursor = `${swap.id("hex")}_0`;

  function oneHop() {
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(swap, "swap", { feeLp: 60n })]]]);
    const txs = new Map<string, number[]>([[swap.id("hex"), swapBeef]]);
    return { pages, txs, io: ioOf(pages, txs) };
  }

  it("files the continuation and the satoshi fee in one internalize, then a second walk files nothing", async () => {
    const bag = syncWallet({ pools: [deployRow()] });
    const { io } = oneHop();
    await syncPool(bag.wallet, POOL_ID, io);
    const filed = internalized(bag);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.description).toBe("AMM pool output filed");
    expect(filed[0]!).not.toHaveProperty("labels");
    expect(Beef.fromBinary(filed[0]!.tx).atomicTxid).toBeFalsy();
    const [continuation, fee] = filed[0]!.outputs;
    expect(continuation).toMatchObject({ outputIndex: 0, insertionRemittance: { basket: POOLS_BASKET, tags: [POOL_TAG] } });
    const contCi = JSON.parse(continuation!.insertionRemittance!.customInstructions!);
    expect(contCi).toMatchObject({ ...HELD, poolId: POOL_ID });
    expect(fee).toMatchObject({ outputIndex: 2, insertionRemittance: { basket: FEES_BASKET } });
    expect(fee!.insertionRemittance).not.toHaveProperty("tags");
    const feeCi = JSON.parse(fee!.insertionRemittance!.customInstructions!);
    expect(feeCi).toEqual({ protocolID: HELD.protocolID, keyID: HELD.keyID, counterparty: "self", poolId: POOL_ID, id: TOKEN_ID });
    expect(feeCi).not.toHaveProperty("op");
    expect(io.asked).toEqual([POOL_ID, swapCursor]);

    const before = internalized(bag).length;
    await syncPool(bag.wallet, POOL_ID, io);
    expect(internalized(bag)).toHaveLength(before);
    expect(io.asked.slice(-2)).toEqual([POOL_ID, swapCursor]);
  });

  it("applies a page of two swaps in order and asks next for the last continuation, not a server cursor", async () => {
    const mid = PoolTemplate.decode(cont)!;
    const cont2 = PoolTemplate.lockContinuation(mid, mid.state);
    const swap2 = spend(swap, 0, [
      { satoshis: swap.outputs[0]!.satoshis!, lockingScript: cont2 },
      { satoshis: 900, lockingScript: payout },
      { satoshis: 40, lockingScript: feeLock },
    ]);
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(swap, "swap", { feeLp: 60n }), event(swap2, "swap", { feeLp: 40n, swaps: 2 })]]]);
    const txs = new Map<string, number[]>([
      [swap.id("hex"), swapBeef],
      [swap2.id("hex"), rawBeef(swap2, [swap])],
    ]);
    const io = ioOf(pages, txs);
    const bag = syncWallet({ pools: [deployRow()] });
    await syncPool(bag.wallet, POOL_ID, io);
    expect(internalized(bag)).toHaveLength(2);
    expect(internalized(bag).map((a) => a.outputs.map((o) => o.outputIndex))).toEqual([[0, 2], [0, 2]]);
    expect(io.asked).toEqual([POOL_ID, `${swap2.id("hex")}_0`]);
  });

  it("a rescind hop files output 0 and no fee", async () => {
    const rescinded = PoolTemplate.lockContinuation(pool, { ...pool.state, validatorPubKey: RESCINDED_KEY });
    const tx = spend(poolDeploy, 0, [
      { satoshis: poolDeploy.outputs[0]!.satoshis!, lockingScript: rescinded },
      { satoshis: 1, lockingScript: payout },
      { satoshis: 60, lockingScript: feeLock },
    ]);
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(tx, "rescind", { feeLp: 60n })]]]);
    const txs = new Map([[tx.id("hex"), rawBeef(tx, [poolDeploy])]]);
    const bag = syncWallet({ pools: [deployRow()] });
    await syncPool(bag.wallet, POOL_ID, ioOf(pages, txs));
    const filed = internalized(bag);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.outputs.map((o) => o.outputIndex)).toEqual([0]);
    expect(filed[0]!.outputs[0]!.insertionRemittance!.basket).toBe(POOLS_BASKET);
  });

  it("files a token fee from output 2 and takes the token id off that output", async () => {
    const tokenFee = tokenP2pkhScript(TOKEN_ID, 7n, PUB);
    const tx = spend(poolDeploy, 0, [
      { satoshis: poolDeploy.outputs[0]!.satoshis!, lockingScript: cont },
      { satoshis: 1, lockingScript: payout },
      { satoshis: 1, lockingScript: tokenFee },
    ]);
    const held = { ...HELD, id: "not-the-token" };
    const row = { ...deployRow(), customInstructions: JSON.stringify(held) };
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(tx, "swap", { feeLp: 7n, side: "sell" })]]]);
    const txs = new Map([[tx.id("hex"), rawBeef(tx, [poolDeploy])]]);
    const bag = syncWallet({ pools: [row] });
    await syncPool(bag.wallet, POOL_ID, ioOf(pages, txs));
    const fee = internalized(bag)[0]!.outputs[1]!;
    expect(fee.outputIndex).toBe(2);
    expect(JSON.parse(fee.insertionRemittance!.customInstructions!).id).toBe(TOKEN_ID);
    expect(JSON.parse(fee.insertionRemittance!.customInstructions!)).not.toHaveProperty("op");
  });

  it("stops when the event does not spend the output the wallet holds", async () => {
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(poolDeploy, "deploy"), event(swap, "swap", { feeLp: 60n })]]]);
    const txs = new Map<string, number[]>([
      [poolDeploy.id("hex"), rawBeef(poolDeploy, [])],
      [swap.id("hex"), swapBeef],
    ]);
    const bag = syncWallet({ pools: [deployRow()] });
    const io = ioOf(pages, txs);
    await syncPool(bag.wallet, POOL_ID, io);
    expect(internalized(bag)).toHaveLength(0);
    expect(io.asked).toEqual([POOL_ID]);
  });

  it("stops when output 0 is not a pool", async () => {
    const tx = spend(poolDeploy, 0, [
      { satoshis: 1000, lockingScript: payout },
      { satoshis: 1, lockingScript: payout },
    ]);
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(tx, "swap", { feeLp: 60n })]]]);
    const txs = new Map([[tx.id("hex"), rawBeef(tx, [poolDeploy])]]);
    const bag = syncWallet({ pools: [deployRow()] });
    await syncPool(bag.wallet, POOL_ID, ioOf(pages, txs));
    expect(internalized(bag)).toHaveLength(0);
  });

  it("stops without throwing when the transaction cannot be read", async () => {
    const missing = "ab".repeat(32);
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(swap, "swap", { feeLp: 60n, txid: missing })]]]);
    const bag = syncWallet({ pools: [deployRow()] });
    await expect(syncPool(bag.wallet, POOL_ID, ioOf(pages, new Map()))).resolves.toBeUndefined();
    expect(internalized(bag)).toHaveLength(0);
  });

  it("a swap that names an LP fee and has no output 2 throws before the known-skip", async () => {
    const tx = spend(poolDeploy, 0, [
      { satoshis: poolDeploy.outputs[0]!.satoshis!, lockingScript: cont },
      { satoshis: 1000, lockingScript: payout },
    ]);
    const txid = tx.id("hex");
    const pages = new Map<string, PoolEvent[]>([[POOL_ID, [event(tx, "swap", { feeLp: 60n })]]]);
    const txs = new Map([[txid, rawBeef(tx, [poolDeploy])]]);
    const bag = syncWallet({
      pools: [deployRow(), { outpoint: `${txid}.0`, satoshis: 1, lockingScript: "00", customInstructions: "{}" }],
      fees: [{ outpoint: `${txid}.2`, satoshis: 1, lockingScript: "00", customInstructions: "{}" }],
    });
    await expect(syncPool(bag.wallet, POOL_ID, ioOf(pages, txs))).rejects.toThrow("the swap names an LP fee and has no output 2");
    expect(internalized(bag)).toHaveLength(0);
  });

  it("does nothing when the wallet holds no output of the pool", async () => {
    const bag = syncWallet();
    const io = oneHop().io;
    await syncPool(bag.wallet, POOL_ID, io);
    expect(io.asked).toEqual([]);
    expect(internalized(bag)).toHaveLength(0);
  });
});

describe("collectBasket", () => {
  const script = new P2PKH().lock(payee.toAddress()).toHex();
  const feeTx = new Transaction();
  feeTx.addInput({ sourceTXID: "44".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  feeTx.addOutput({ satoshis: 5000, lockingScript: LockingScript.fromHex(script) });
  const feeOutpoint = `${feeTx.id("hex")}.0`;
  const specs = JSON.stringify({ protocolID: [1, "openex fees"], keyID: HELD.keyID, counterparty: "self", poolId: POOL_ID });

  function feeRow(over: Partial<Row> = {}): Row {
    return { outpoint: feeOutpoint, satoshis: 5000, lockingScript: script, customInstructions: specs, ...over };
  }

  it("an empty basket spends nothing", async () => {
    const bag = syncWallet();
    await expect(collectBasket(bag.wallet)).resolves.toEqual({ sats: 0n, tokens: [] });
    expect(bag.calls.some((c) => c.method === "createAction" || c.method === "getPublicKey")).toBe(false);
  });

  it("a fee output with no key throws before the wallet is asked for a key", async () => {
    const bag = syncWallet({ fees: [feeRow({ customInstructions: "{}" })] });
    await expect(collectBasket(bag.wallet)).rejects.toThrow("the fee output names no key");
    expect(bag.calls.some((c) => c.method === "getPublicKey")).toBe(false);
  });

  it("a fee output with no locking script throws", async () => {
    const bag = syncWallet({ fees: [feeRow({ lockingScript: undefined, satoshis: 0 })] });
    await expect(collectBasket(bag.wallet)).rejects.toThrow("the fee output has no locking script");
  });

  it("a row whose sats and tokens are both zero returns without an action, after the key check", async () => {
    const bag = syncWallet({ fees: [feeRow({ satoshis: 0 })] });
    await expect(collectBasket(bag.wallet)).resolves.toEqual({ sats: 0n, tokens: [] });
    expect(bag.calls.some((c) => c.method === "createAction" || c.method === "getPublicKey")).toBe(false);
    const missing = syncWallet({ fees: [feeRow({ satoshis: 0, customInstructions: "{}" })] });
    await expect(collectBasket(missing.wallet)).rejects.toThrow("the fee output names no key");
    expect(missing.calls.some((c) => c.method === "getPublicKey")).toBe(false);
  });

  it("spends the satoshi fees to one BRC-29 output and stops when the wallet does not hand the transaction back", async () => {
    const bag = syncWallet({ fees: [feeRow()], feeTxs: [feeTx] });
    await expect(collectBasket(bag.wallet)).rejects.toThrow("the wallet did not hand the transaction back for the page's signatures");
    const created = bag.calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(created.description).toBe("Collect pool fees");
    expect(created.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(created).not.toHaveProperty("labels");
    expect(created.inputs).toEqual([{ outpoint: feeOutpoint, unlockingScriptLength: 108, inputDescription: "A pool fee" }]);
    expect(created.outputs).toEqual([{ lockingScript: new P2PKH().lock(payee.toPublicKey().toAddress()).toHex(), satoshis: 5000, outputDescription: "Pool fees in sats" }]);
  });

  it("spends a token fee to one p color output", async () => {
    const tokenScript = tokenP2pkhScript(TOKEN_ID, 7n, PUB);
    const tx = new Transaction();
    tx.addInput({ sourceTXID: "45".repeat(32), sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(tokenScript) });
    const row: Row = {
      outpoint: `${tx.id("hex")}.0`,
      satoshis: 1,
      lockingScript: tokenScript,
      customInstructions: specs,
    };
    const bag = syncWallet({ fees: [row], feeTxs: [tx] });
    await expect(collectBasket(bag.wallet)).rejects.toThrow("the wallet did not hand the transaction back for the page's signatures");
    const created = bag.calls.find((c) => c.method === "createAction")!.args as CreateActionArgs;
    expect(created.description).toBe("Collect pool fees");
    expect(created.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false });
    expect(created.outputs).toEqual([{ lockingScript: tokenP2pkhScript(TOKEN_ID, 7n, PUB), satoshis: 1, outputDescription: "Pool fees in tokens" }]);
    expect(Array.isArray(created.labels)).toBe(true);
    expect(created.inputs?.[0]).toMatchObject({ outpoint: `${tx.id("hex")}.0`, unlockingScriptLength: 108, inputDescription: "A pool fee" });
  });
});
