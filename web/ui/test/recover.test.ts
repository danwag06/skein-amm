/**
 * Recover a position (0.12.1, src/lp/recover.ts; 0.29.1: layout 2 only).
 * Both outpoint forms; the LP keyID from the wallet's deploy history or kept
 * in this browser by the deploy, else refused with nothing filed; the row
 * byte for byte a deploy's; a pool already filed left alone; a pre-0.13.0
 * (layout-1) pool, the live testnet AMM1 one included, is no pool.
 */
import { Beef, PrivateKey, Transaction, UnlockingScript, Utils, type WalletInterface } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { PoolTemplate } from "../src/pool";
import { lpKeyDescription, poolCustomInstructions, type BasketRow } from "../src/lp/poolDeploy";
import { historyPoolRows, mergePoolRows } from "../src/lp/positions";
import { RECOVER_TEXT, parsePoolOutpoint, recoverPosition, type RecoverInput } from "../src/lp/recover";
import type { Spend } from "../src/lib/skein";
import type { LookupOutput } from "../src/lib/overlay";
import { BRC29, brc29Side, type KeyArgs } from "./brc29Wallet";
import v from "./fixtures/amm-topic-vectors.json";
import v1 from "./fixtures/amm-topic-vectors-v1.json";
import live from "./fixtures/recover-live-ls_color.json";

const key = (n: number) => new PrivateKey(n.toString(16).padStart(2, "0").repeat(32), 16);
const tokenDeploy = Transaction.fromHex(v.token_deploy);
const TOKEN_ID = `${tokenDeploy.id("hex")}_0`;

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

/** A layout-2 deploy (0.13.0): output 0 the pool with LpPubKey `lpPub`, the fixture's key, nonce and affirmation in state. */
function deployTxV2(lpPub: string) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: tokenDeploy.id("hex"), sourceOutputIndex: 0, sourceTransaction: tokenDeploy, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  tx.addOutput({ satoshis: 1_000_000, lockingScript: PoolTemplate.lockDeploy(ARGS, { tokenReserve: 5_000_000n, lpPubKey: lpPub, validatorPubKey: v.pool0.validator, validatorIdentity: v.identity, nonce: v.nonce, affirmation: v.affirmation }) });
  return tx;
}


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

/** The LP keyID this wallet's deploy used (0.29.4: named by the deploy's pool output description), and its key. */
const KEPT = "YW1tLWxw a2VwdC1rZXktaWQ=";
const keptLp = (s = side) => s.publicKey({ protocolID: BRC29, keyID: KEPT, counterparty: "self", forSelf: true });

/** The deploy history as the wallet's listActions answers it (through the manager: descriptions decrypted): the pool output's description (the LP key mark) and its script — no customInstructions (BRC-100 listActions answers none). */
async function labelledHistory(deploy: Transaction, keyID = KEPT): Promise<BasketRow[]> {
  const wallet = {
    async listActions(a: { labels?: string[]; includeLabels?: boolean; includeOutputLockingScripts?: boolean }) {
      expect(a).toMatchObject({ labels: ["amm-pool-deploy"], includeOutputs: true, includeOutputLockingScripts: true });
      return { totalActions: 1, actions: [{ txid: deploy.id("hex"), outputs: deploy.outputs.map((o, n) => ({ outputIndex: n, satoshis: o.satoshis, spendable: false, lockingScript: o.lockingScript.toHex(), outputDescription: n === 0 ? lpKeyDescription("AMM pool: TST / BSV", keyID) : "change", tags: [] })) }] };
    },
  } as unknown as WalletInterface;
  return await historyPoolRows(wallet);
}

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

async function input(w: WalletInterface, outpoint: string, txs: Transaction[], rows: BasketRow[] = []): Promise<RecoverInput> {
  const { spendOf, outputOf } = chain(txs);
  return { wallet: w, outpoint, rows, spendOf, outputOf, metaOf: async () => ({ sym: "TST", dec: 0 }), history: await labelledHistory(txs[0]!) };
}

describe("recover a position (0.12.1; 0.29.1: layout 2 only)", () => {
  it("parses both outpoint forms, and nothing else", () => {
    const t = "Ab".repeat(32);
    expect(parsePoolOutpoint(`${t}.0`)).toBe(`${t.toLowerCase()}.0`);
    expect(parsePoolOutpoint(` ${t}_3 `)).toBe(`${t.toLowerCase()}.3`);
    expect(parsePoolOutpoint(t)).toBeNull();
    expect(parsePoolOutpoint("nope.0")).toBeNull();
  });

  it("a deploy's pool, its LP keyID named by the deploy's pool output description: filed in amm-pools, the row byte for byte the deploy's", async () => {
    const tx = deployTxV2(keptLp());
    const { wallet, calls } = fakeWallet();
    const r = await recoverPosition(await input(wallet, `${tx.id("hex")}_0`, [tx]));
    expect(r.filed).toBe(true);
    expect(r.outpoint).toBe(`${tx.id("hex")}.0`);
    expect(r.lpKey).toEqual({ protocolID: BRC29, keyID: KEPT, counterparty: "self" });
    const deployed = poolCustomInstructions({ tokenId: TOKEN_ID, sym: "TST", dec: 0, protocolID: BRC29, keyID: KEPT, args: ARGS, validatorIdentity: v.identity, nonce: v.nonce });
    expect(r.filing.customInstructions).toBe(deployed);
    const ia = calls.find((c) => c.method === "internalizeAction")!.args;
    expect(ia).toEqual({
      tx: atomic(tx, []),
      outputs: [{ outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: "amm-pools", tags: ["amm-pool"], customInstructions: deployed } }],
      description: "AMM pool recover: TST",
      labels: ["amm-pool-deploy"],
    });
    expect(side.internalized.at(-1)).toBe(ia);
  });

  it("a continuation: the current output filed", async () => {
    const tx = deployTxV2(keptLp());
    const c1 = continuation(tx);
    const c2 = continuation(c1);
    const { wallet } = fakeWallet();
    const r = await recoverPosition(await input(wallet, `${tx.id("hex")}.0`, [tx, c1, c2]));
    expect(r.outpoint).toBe(`${c2.id("hex")}.0`);
    expect(r.internalizeArgs.outputs[0]!.outputIndex).toBe(0);
  });

  it("another wallet's pool: the history's key is not its LP key, refused, nothing filed", async () => {
    const tx = deployTxV2(keptLp(other));
    const { wallet, calls } = fakeWallet();
    await expect(recoverPosition(await input(wallet, `${tx.id("hex")}.0`, [tx]))).rejects.toThrow(RECOVER_TEXT.notKept);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });

  it("already filed (the pasted outpoint, the current one, or a row followed to it): said so, nothing done", async () => {
    const tx = deployTxV2(keptLp());
    const c1 = continuation(tx);
    const row = (o: string): BasketRow => ({ outpoint: o, satoshis: 1, tags: ["amm-pool"], customInstructions: "{}" });
    for (const [pasted, filed] of [
      [`${tx.id("hex")}_0`, `${tx.id("hex")}.0`],
      [`${tx.id("hex")}.0`, `${c1.id("hex")}.0`],
      [`${c1.id("hex")}.0`, `${tx.id("hex")}.0`],
    ] as const) {
      const { wallet, calls } = fakeWallet();
      await expect(recoverPosition(await input(wallet, pasted, [tx, c1], [row(filed)]))).rejects.toThrow(RECOVER_TEXT.filed);
      expect(calls).toEqual([]);
    }
  });

  it("refusals before the wallet: not an outpoint, closed, spent and not followed, not a pool (a layout-1 pool included)", async () => {
    const { wallet, calls } = fakeWallet();
    const base = await input(wallet, "", [tokenDeploy]);
    await expect(recoverPosition({ ...base, outpoint: "abc" })).rejects.toThrow(RECOVER_TEXT.notOutpoint);
    const op = `${"12".repeat(32)}.0`;
    await expect(recoverPosition({ ...base, outpoint: op, spendOf: async () => ({ outpoint: op, hops: 1, closed: true }) })).rejects.toThrow(RECOVER_TEXT.closed);
    await expect(recoverPosition({ ...base, outpoint: op, spendOf: async () => ({ outpoint: op, spentBy: "x", hops: 0, closed: false }) })).rejects.toThrow(RECOVER_TEXT.spent);
    const plain = new Transaction();
    plain.addInput({ sourceTXID: "77".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    plain.addOutput({ satoshis: 1, lockingScript: tokenDeploy.outputs[0]!.lockingScript });
    await expect(recoverPosition(await input(wallet, `${plain.id("hex")}.0`, [plain]))).rejects.toThrow(RECOVER_TEXT.notPool);
    const old = Transaction.fromHex(v1.pool_deploy);
    await expect(recoverPosition(await input(wallet, `${old.id("hex")}.0`, [old]))).rejects.toThrow(RECOVER_TEXT.notPool);
    expect(calls).toEqual([]);
  });

  it("the testnet's pre-0.13.0 AMM1 pool (ls_color answer, swap.skein.nexus, 2026-10-22): no pool any more (0.29.1)", () => {
    const out = live.outputs[0]!;
    const tx = Transaction.fromAtomicBEEF(out.beef);
    expect(tx.id("hex")).toBe("e34c438ad5b1ca28ce95834fc08da5d9b511453b98fb2c1f11338a8534ff8445");
    expect(PoolTemplate.decode(tx.outputs[out.outputIndex]!.lockingScript)).toBeNull();
  });
});

describe("recover a position (0.29.4): the LP key from the deploy's pool output description, nothing in the browser", () => {
  const keyID = "YW1tLWxw cmFuZG9tLWtleS1pZA==";
  const lp = side.publicKey({ protocolID: BRC29, keyID, counterparty: "self", forSelf: true });

  it("recomputes the LP key for a deploy from its action's pool output description alone (`… · amm-lp <hex>`), the pool from its output script: filed, the row a deploy's (with the nonce)", async () => {
    const tx = deployTxV2(lp);
    const history = await labelledHistory(tx, keyID);
    expect(history.map((r) => r.outpoint)).toEqual([`${tx.id("hex")}.0`]);
    expect(JSON.parse(history[0]!.customInstructions!)).toMatchObject({ id: TOKEN_ID, keyID, protocolID: BRC29, amm: { nonce: v.nonce } });
    const { wallet, calls } = fakeWallet();
    const r = await recoverPosition({ ...(await input(wallet, `${tx.id("hex")}.0`, [tx])), history });
    expect(r.filed).toBe(true);
    expect(r.lpKey).toEqual({ protocolID: BRC29, keyID, counterparty: "self" });
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
    expect((calls.find((c) => c.method === "internalizeAction")!.args as { labels: string[] }).labels).toEqual(["amm-pool-deploy"]);
  });

  it("no deploy history naming the pool's LP key: refused, nothing filed", async () => {
    const tx = deployTxV2(lp);
    const { wallet, calls } = fakeWallet();
    await expect(recoverPosition({ ...(await input(wallet, `${tx.id("hex")}.0`, [tx])), history: [] })).rejects.toThrow(RECOVER_TEXT.notKept);
    expect(calls.some((c) => c.method === "internalizeAction")).toBe(false);
  });
});

describe("recover a position (0.28.0): the LP key from the wallet's deploy history", () => {
  const keyID = "YW1tLWxwIGtleSBoaXN0";
  const lp = side.publicKey({ protocolID: BRC29, keyID, counterparty: "self", forSelf: true });

  it("a wallet whose listActions answers customInstructions (0.28.0): the filed row's keyID found the same way", async () => {
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
    const r = await recoverPosition({ ...(await input(wallet, `${tx.id("hex")}.0`, [tx])), history });
    expect(r.filed).toBe(true);
    expect(r.lpKey).toEqual({ protocolID: BRC29, keyID, counterparty: "self" });
    expect(JSON.parse(r.filing.customInstructions).keyID).toBe(keyID);
  });

  it("a history row whose key is not the pool's: refused", async () => {
    const tx = deployTxV2(lp);
    const ci = poolCustomInstructions({ tokenId: TOKEN_ID, protocolID: BRC29, keyID: "b3RoZXIga2V5", args: ARGS, validatorIdentity: v.identity });
    const { wallet } = fakeWallet();
    await expect(recoverPosition({ ...(await input(wallet, `${tx.id("hex")}.0`, [tx])), history: [{ outpoint: `${"cd".repeat(32)}.0`, satoshis: 1, tags: ["amm-pool"], customInstructions: ci }] })).rejects.toThrow(RECOVER_TEXT.notKept);
  });

  it("a wallet that refuses listActions: no history rows", async () => {
    const wallet = { async listActions() { throw new Error("denied"); } } as unknown as WalletInterface;
    expect(await historyPoolRows(wallet)).toEqual([]);
  });
});
