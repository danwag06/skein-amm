/**
 * Recover a position (0.12.1, src/lp/recover.ts; 0.13.0: both layouts). A
 * layout-1 pool (before 0.13.0): both outpoint forms; the LP key checked
 * against the pool's LpPubKey (BRC-29, else pre-BRC-29, else refused with
 * nothing filed); the row byte for byte a deploy's; a pool already filed left
 * alone; the live testnet pool's lookup answer decoded. A layout-2 pool: the LP
 * keyID kept in this browser by the deploy, else refused.
 */
import { P1SAT_PROTOCOL } from "@1sat/actions";
import { Beef, LockingScript, PrivateKey, Transaction, UnlockingScript, Utils, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { RunarContract, encodePushData } from "runar-sdk";
import { describe, expect, it } from "vitest";
import { PoolTemplate, oneColorValuePrefix, poolArtifactV1 } from "../src/pool";
import { deriveValidatorPubKey } from "../src/lib/keys";
import { PendingDeployStore, legacyLpKeyId, lpKeyId, poolCustomInstructions, type BasketRow } from "../src/lp/poolDeploy";
import { historyPoolRows, mergePoolRows } from "../src/lp/positions";
import { RECOVER_TEXT, keyInputCandidates, parsePoolOutpoint, recoverPosition, type RecoverInput } from "../src/lp/recover";
import type { Spend } from "../src/lib/skein";
import type { LookupOutput } from "../src/lib/overlay";
import { BRC29, brc29Side, type KeyArgs } from "./brc29Wallet";
import v from "./fixtures/amm-topic-vectors.json";
import live from "./fixtures/recover-live-ls_color.json";

const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const P1SAT = P1SAT_PROTOCOL as unknown as WalletProtocol;
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const TOKEN_ID = `${tokenDeploy.id("hex")}_0`;
const KEY_INPUT = `${tokenDeploy.id("hex")}_0`;

const side = brc29Side(key(50));
const other = brc29Side(key(51));

function atomic(tx: Transaction, ancestors: Transaction[]): number[] {
  const b = new Beef();
  for (const a of ancestors) b.mergeRawTx(a.toBinary());
  b.mergeRawTx(tx.toBinary());
  return b.toBinaryAtomic(tx.id("hex"));
}

const ASSET_ID = Utils.toHex(tokenDeploy.hash() as number[]);
const ARGS = { assetId: ASSET_ID, lpFeeBps: 30n, validatorFeeBps: 5n, commissionBps: BigInt(v.commissionBps) };

/**
 * A layout-1 deploy (0.11.0-0.12.x): input 0 the key input, output 0 the pool (LpPubKey `lpPub`,
 * the validator's child of the key input) with the affirmation as its 1Color payload.
 */
function deployTx(lpPub: string) {
  const state = { tokenReserve: 5_000_000n, lpPubKey: lpPub, validatorPubKey: deriveValidatorPubKey(v.identity, { txid: tokenDeploy.id("hex"), vout: 0 }), validatorIdentity: v.identity };
  const contract = new RunarContract(poolArtifactV1, [state.tokenReserve, state.lpPubKey, state.validatorPubKey, state.validatorIdentity, ARGS.assetId, ARGS.lpFeeBps, ARGS.validatorFeeBps, ARGS.commissionBps]);
  const prefix = Utils.toHex(oneColorValuePrefix(Utils.toArray(ASSET_ID, "hex"), state.tokenReserve));
  const lock = LockingScript.fromHex(prefix + encodePushData(v.affirmation) + "75" + contract.getLockingScript());
  const tx = new Transaction();
  tx.addInput({ sourceTXID: tokenDeploy.id("hex"), sourceOutputIndex: 0, sourceTransaction: tokenDeploy, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 1, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis: 1_000_000, lockingScript: lock });
  expect(PoolTemplate.decode(lock)!.version).toBe(1);
  return { tx, plan: { args: ARGS, state } };
}

/** A layout-2 deploy (0.13.0): output 0 the pool with LpPubKey `lpPub`, the fixture's key, nonce and affirmation in state. */
function deployTxV2(lpPub: string) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: tokenDeploy.id("hex"), sourceOutputIndex: 0, sourceTransaction: tokenDeploy, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis: 1_000_000, lockingScript: PoolTemplate.lockDeploy(ARGS, { tokenReserve: 5_000_000n, lpPubKey: lpPub, validatorPubKey: v.pool0.validator, validatorIdentity: v.identity, nonce: v.nonce, affirmation: v.affirmation }) });
  return tx;
}

const memStore = () => {
  const m = new Map<string, string>();
  return new PendingDeployStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, val) => void m.set(k, val) });
};

/** A swap's continuation of `prev`'s pool: input 0 the pool, output 0 the next pool. */
function continuation(prev: Transaction): Transaction {
  const pool = PoolTemplate.decode(prev.outputs[0]!.lockingScript)!;
  const tx = new Transaction();
  tx.addInput({ sourceTXID: prev.id("hex"), sourceOutputIndex: 0, sourceTransaction: prev, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis: 1_000_100, lockingScript: PoolTemplate.lockContinuation(pool, { ...pool.state, tokenReserve: pool.state.tokenReserve - 10n }) });
  return tx;
}

function fakeWallet(s = side) {
  const calls: { method: string; args: unknown }[] = [];
  const wallet = {
    async getPublicKey(a: KeyArgs) {
      calls.push({ method: "getPublicKey", args: a });
      return { publicKey: s.publicKey(a) };
    },
    async internalizeAction(a: never) {
      calls.push({ method: "internalizeAction", args: a });
      return s.internalizeAction(a);
    },
  };
  return { wallet: wallet as unknown as WalletInterface, calls };
}

const brc29Lp = (s = side) => s.publicKey({ protocolID: BRC29, keyID: lpKeyId(KEY_INPUT), counterparty: "self", forSelf: true });
const legacyLp = (s = side) => s.publicKey({ protocolID: P1SAT, keyID: legacyLpKeyId(KEY_INPUT), counterparty: "self", forSelf: true });

/** The chain state and the lookup over `txs` (the last the current pool). */
function chain(txs: Transaction[]) {
  const last = txs[txs.length - 1]!;
  const cur = `${last.id("hex")}.0`;
  const spendOf = async (o: string): Promise<Spend> => ({ outpoint: o, current: cur, hops: 0, closed: false });
  const outputOf = async (o: string): Promise<LookupOutput> => {
    if (o !== cur) throw new Error(`ls_color: no unspent output ${o}`);
    return { beef: atomic(last, txs.slice(0, -1)), outputIndex: 0 };
  };
  return { spendOf, outputOf, cur };
}

function input(w: WalletInterface, outpoint: string, txs: Transaction[], rows: BasketRow[] = []): RecoverInput {
  const { spendOf, outputOf } = chain(txs);
  return { wallet: w, outpoint, rows, spendOf, outputOf, metaOf: async () => ({ sym: "TST", dec: 0 }) };
}

describe("recover a position (0.12.1; a layout-1 pool)", () => {
  it("parses both outpoint forms, and nothing else", () => {
    const t = "Ab".repeat(32);
    expect(parsePoolOutpoint(`${t}.0`)).toBe(`${t.toLowerCase()}.0`);
    expect(parsePoolOutpoint(` ${t}_3 `)).toBe(`${t.toLowerCase()}.3`);
    expect(parsePoolOutpoint(t)).toBeNull();
    expect(parsePoolOutpoint("nope.0")).toBeNull();
  });

  it("a deploy's pool with this wallet's BRC-29 LP key: filed in amm-pools, the row byte for byte the deploy's", async () => {
    const { tx, plan } = deployTx(brc29Lp());
    const { wallet, calls } = fakeWallet();
    const r = await recoverPosition(input(wallet, `${tx.id("hex")}_0`, [tx]));
    expect(r.filed).toBe(true);
    expect(r.outpoint).toBe(`${tx.id("hex")}.0`);
    expect(r.keyInput).toBe(`${tokenDeploy.id("hex")}.0`);
    expect(r.lpKey).toEqual({ protocolID: BRC29, keyID: lpKeyId(KEY_INPUT), counterparty: "self" });
    // What deployPool files for the same pool (src/lp/poolDeploy.ts step 4).
    const deployed = poolCustomInstructions({ tokenId: TOKEN_ID, sym: "TST", dec: 0, protocolID: BRC29, keyID: lpKeyId(KEY_INPUT), args: plan.args, validatorIdentity: plan.state.validatorIdentity });
    expect(r.filing.customInstructions).toBe(deployed);
    expect(JSON.parse(r.filing.customInstructions)).toEqual({
      id: TOKEN_ID,
      op: "amm-pool",
      sym: "TST",
      dec: "0",
      protocolID: BRC29,
      keyID: lpKeyId(KEY_INPUT),
      counterparty: "self",
      amm: { role: "lp", validatorIdentity: v.identity, lpFeeBps: "30", validatorFeeBps: "5", commissionBps: String(v.commissionBps) },
    });
    const ia = calls.find((c) => c.method === "internalizeAction")!.args;
    expect(ia).toEqual({
      tx: atomic(tx, []),
      outputs: [{ outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "amm-pools", tags: ["amm-pool"], customInstructions: deployed } }],
      description: "AMM pool recover: TST",
      labels: ["amm-pool-deploy"],
    });
    expect(side.internalized.at(-1)).toBe(ia);
  });

  it("a continuation: walked back through the BEEF to the deploy's input 0; the current output filed", async () => {
    const { tx } = deployTx(brc29Lp());
    const c1 = continuation(tx);
    const c2 = continuation(c1);
    const found = keyInputCandidates(Transaction.fromAtomicBEEF(atomic(c2, [tx, c1])), 0, PoolTemplate.decode(tx.outputs[0]!.lockingScript)!.args.assetId);
    expect(found).toEqual({ candidates: [`${c1.id("hex")}.0`, `${tx.id("hex")}.0`, `${tokenDeploy.id("hex")}.0`], reached: true });
    const { wallet } = fakeWallet();
    const r = await recoverPosition(input(wallet, `${tx.id("hex")}.0`, [tx, c1, c2]));
    expect(r.outpoint).toBe(`${c2.id("hex")}.0`);
    expect(r.keyInput).toBe(`${tokenDeploy.id("hex")}.0`);
    expect(r.internalizeArgs.outputs[0]!.outputIndex).toBe(0);
  });

  it("a pre-BRC-29 LP key: matched as legacyLpKeyId under P1SAT_PROTOCOL", async () => {
    const { tx } = deployTx(legacyLp());
    const { wallet, calls } = fakeWallet();
    const r = await recoverPosition(input(wallet, `${tx.id("hex")}.0`, [tx]));
    expect(r.lpKey).toEqual({ protocolID: P1SAT, keyID: legacyLpKeyId(KEY_INPUT), counterparty: "self" });
    expect(JSON.parse(r.filing.customInstructions)).toMatchObject({ protocolID: P1SAT, keyID: legacyLpKeyId(KEY_INPUT), counterparty: "self" });
    expect(calls.filter((c) => c.method === "getPublicKey").map((c) => (c.args as KeyArgs).protocolID)).toEqual([BRC29, P1SAT]);
  });

  it("another wallet's pool: refused, nothing filed", async () => {
    const { tx } = deployTx(brc29Lp(other));
    const { wallet, calls } = fakeWallet();
    await expect(recoverPosition(input(wallet, `${tx.id("hex")}.0`, [tx]))).rejects.toThrow(RECOVER_TEXT.notMine);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("a BEEF that stops before the deploy, and no candidate matches: refused as unreachable, nothing filed", async () => {
    const { tx } = deployTx(brc29Lp());
    const c1 = continuation(tx);
    const { wallet, calls } = fakeWallet();
    const { spendOf } = chain([tx, c1]);
    const outputOf = async () => ({ beef: atomic(c1, []), outputIndex: 0 });
    await expect(recoverPosition({ wallet, outpoint: `${c1.id("hex")}.0`, rows: [], spendOf, outputOf, metaOf: async () => null })).rejects.toThrow(RECOVER_TEXT.noDeploy);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("already filed (the pasted outpoint, the current one, or a row followed to it): said so, nothing done", async () => {
    const { tx } = deployTx(brc29Lp());
    const c1 = continuation(tx);
    const row = (o: string): BasketRow => ({ outpoint: o, satoshis: 1, tags: ["amm-pool"], customInstructions: "{}" });
    for (const [pasted, filed] of [
      [`${tx.id("hex")}_0`, `${tx.id("hex")}.0`],
      [`${tx.id("hex")}.0`, `${c1.id("hex")}.0`],
      [`${c1.id("hex")}.0`, `${tx.id("hex")}.0`],
    ] as const) {
      const { wallet, calls } = fakeWallet();
      await expect(recoverPosition(input(wallet, pasted, [tx, c1], [row(filed)]))).rejects.toThrow(RECOVER_TEXT.filed);
      expect(calls).toEqual([]);
    }
  });

  it("refusals before the wallet: not an outpoint, closed, spent and not followed, not a pool", async () => {
    const { wallet, calls } = fakeWallet();
    const base = input(wallet, "", [tokenDeploy]);
    await expect(recoverPosition({ ...base, outpoint: "abc" })).rejects.toThrow(RECOVER_TEXT.notOutpoint);
    const op = `${"12".repeat(32)}.0`;
    await expect(recoverPosition({ ...base, outpoint: op, spendOf: async () => ({ outpoint: op, hops: 1, closed: true }) })).rejects.toThrow(RECOVER_TEXT.closed);
    await expect(recoverPosition({ ...base, outpoint: op, spendOf: async () => ({ outpoint: op, spentBy: "x", hops: 0, closed: false }) })).rejects.toThrow(RECOVER_TEXT.spent);
    const plain = new Transaction();
    plain.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    plain.addOutput({ satoshis: 1, lockingScript: tokenDeploy.outputs[0]!.lockingScript });
    await expect(recoverPosition(input(wallet, `${plain.id("hex")}.0`, [plain]))).rejects.toThrow(RECOVER_TEXT.notPool);
    expect(calls).toEqual([]);
  });

  it("the testnet pool's ls_color answer (swap.skein.nexus, 2026-10-22): an affirmed AMM1 deploy whose input 0 is the token's deploy output", () => {
    const out = live.outputs[0]!;
    const tx = Transaction.fromAtomicBEEF(out.beef);
    expect(tx.id("hex")).toBe("e34c438ad5b1ca28ce95834fc08da5d9b511453b98fb2c1f11338a8534ff8445");
    const pool = PoolTemplate.decode(tx.outputs[out.outputIndex]!.lockingScript)!;
    expect(pool.affirmation).toBeTruthy();
    expect(Utils.toHex(Utils.toArray(pool.args.assetId, "hex").reverse())).toBe("1ad1c0917176341a02c6beb73ecc14512c5188f73cb0d7cfe2425a57f641806f");
    expect(keyInputCandidates(tx, out.outputIndex, pool.args.assetId)).toEqual({
      candidates: ["1ad1c0917176341a02c6beb73ecc14512c5188f73cb0d7cfe2425a57f641806f.0"],
      reached: true,
    });
  });
});

describe("recover a position (0.13.0: a layout-2 pool)", () => {
  const keyID = "YW1tLWxw cmFuZG9tLWtleS1pZA==";
  const lp = side.publicKey({ protocolID: BRC29, keyID, counterparty: "self", forSelf: true });

  it("the LP keyID this browser kept: filed, the row a deploy's (with the nonce), the record dropped", async () => {
    const tx = deployTxV2(lp);
    const pending = memStore();
    pending.save({ keyID: "YW1tLWxw b3RoZXI=", lpPubKey: "x", tokenId: TOKEN_ID, createdAt: 1 });
    pending.save({ keyID, lpPubKey: lp, tokenId: TOKEN_ID, createdAt: 2 });
    const { wallet } = fakeWallet();
    const r = await recoverPosition({ ...input(wallet, `${tx.id("hex")}.0`, [tx]), pending });
    expect(r.filed).toBe(true);
    expect(r.lpKey).toEqual({ protocolID: BRC29, keyID, counterparty: "self" });
    expect(r.keyInput).toBe("");
    expect(JSON.parse(r.filing.customInstructions)).toEqual({
      id: TOKEN_ID,
      op: "amm-pool",
      sym: "TST",
      dec: "0",
      protocolID: BRC29,
      keyID,
      counterparty: "self",
      amm: { role: "lp", validatorIdentity: v.identity, lpFeeBps: "30", validatorFeeBps: "5", commissionBps: String(v.commissionBps), nonce: v.nonce },
    });
    expect(pending.list().map((d) => d.keyID)).toEqual(["YW1tLWxw b3RoZXI="]);
  });

  it("no kept keyID that is the pool's LP key: refused, nothing filed", async () => {
    const tx = deployTxV2(lp);
    const { wallet, calls } = fakeWallet();
    await expect(recoverPosition({ ...input(wallet, `${tx.id("hex")}.0`, [tx]), pending: memStore() })).rejects.toThrow(RECOVER_TEXT.notKept);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });
});

describe("recover a position (0.28.0): the LP key from the wallet's deploy history", () => {
  const keyID = "YW1tLWxwIGtleSBoaXN0";
  const lp = side.publicKey({ protocolID: BRC29, keyID, counterparty: "self", forSelf: true });

  it("listOutputs empty (the wallet spent the pool output), listActions holds the deploy's pool output: its keyID found, nothing kept in this browser needed", async () => {
    const tx = deployTxV2(lp);
    const ci = poolCustomInstructions({ tokenId: TOKEN_ID, sym: "TST", dec: 0, protocolID: BRC29, keyID, args: ARGS, validatorIdentity: v.identity, nonce: v.nonce });
    const { wallet: base, calls } = fakeWallet();
    const wallet = {
      ...base,
      async listOutputs() {
        return { totalOutputs: 0, outputs: [] };
      },
      async listActions(a: { labels?: string[]; includeOutputs?: boolean }) {
        calls.push({ method: "listActions", args: a });
        return {
          totalActions: 1,
          actions: [{ txid: tx.id("hex"), labels: ["amm-pool-deploy"], outputs: [
            { outputIndex: 0, satoshis: 1_000_000, spendable: false, basket: "amm-pools", tags: ["amm-pool"], customInstructions: ci },
            { outputIndex: 1, satoshis: 3, spendable: true, basket: "default", tags: [] },
          ] }],
        };
      },
    } as unknown as WalletInterface;
    const history = await historyPoolRows(wallet);
    expect(history.map((r) => r.outpoint)).toEqual([`${tx.id("hex")}.0`]);
    expect(calls.find((c) => c.method === "listActions")!.args).toMatchObject({ labels: ["amm-pool-deploy"], includeOutputs: true });
    expect(mergePoolRows([{ outpoint: `${tx.id("hex")}_0`, satoshis: 1 }], history)).toHaveLength(1);
    const pending = memStore();
    const r = await recoverPosition({ ...input(wallet, `${tx.id("hex")}.0`, [tx]), history, pending });
    expect(r.filed).toBe(true);
    expect(r.lpKey).toEqual({ protocolID: BRC29, keyID, counterparty: "self" });
    expect(r.keyInput).toBe("");
    expect(JSON.parse(r.filing.customInstructions).keyID).toBe(keyID);
  });

  it("a history row whose key is not the pool's: no match there, then the browser's kept keyIDs (none): refused", async () => {
    const tx = deployTxV2(lp);
    const ci = poolCustomInstructions({ tokenId: TOKEN_ID, protocolID: BRC29, keyID: "b3RoZXIga2V5", args: ARGS, validatorIdentity: v.identity });
    const { wallet } = fakeWallet();
    await expect(recoverPosition({ ...input(wallet, `${tx.id("hex")}.0`, [tx]), history: [{ outpoint: `${"cd".repeat(32)}.0`, satoshis: 1, tags: ["amm-pool"], customInstructions: ci }], pending: memStore() })).rejects.toThrow(RECOVER_TEXT.notKept);
  });

  it("a wallet that refuses listActions: no history rows", async () => {
    const wallet = { async listActions() { throw new Error("denied"); } } as unknown as WalletInterface;
    expect(await historyPoolRows(wallet)).toEqual([]);
  });
});
