// 0.45.0 (David 2026-11-07): the swap's funding BEEF — raw outside the token's topic, txid-only inside (skein 0.3.3's
// door admits a txid-only entry for a transaction the instance holds).
import { Beef, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from "@bsv/sdk";
import { describe, expect, it } from "vitest";
import { PoolTemplate } from "../src/pool";
import { fundingBeef, topicAdmitted } from "../src/market/swapAction";

const ASSET = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const k = PrivateKey.fromRandom();
const pay = new P2PKH().lock(k.toPublicKey().toAddress());
const poolScript = (asset: string) =>
  PoolTemplate.lockDeploy({ assetId: asset, lpFeeBps: 30n, validatorFeeBps: 5n, commissionBps: 10n }, { tokenReserve: 1000n, lpPubKey: k.toPublicKey().toString(), validatorPubKey: k.toPublicKey().toString(), validatorIdentity: k.toPublicKey().toString(), nonce: "00".repeat(32), affirmation: "" });

function tx(srcs: [Transaction | string, number][], outs: { lockingScript: ReturnType<typeof poolScript> | typeof pay; satoshis: number }[]): Transaction {
  const t = new Transaction();
  for (const [s, i] of srcs) {
    if (typeof s === "string") t.addInput({ sourceTXID: s, sourceOutputIndex: i, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
    else t.addInput({ sourceTransaction: s, sourceOutputIndex: i, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  }
  for (const o of outs) t.addOutput(o);
  return t;
}
function entries(bytes: number[]) {
  const b = Beef.fromBinary(bytes);
  return { atomic: Utils.toHex(bytes.slice(4, 36).reverse()), txs: b.txs.map((t) => ({ txid: t.txid, txidOnly: t.isTxidOnly })) };
}

describe("fundingBeef (0.45.0)", () => {
  // root (mined elsewhere: txid only) → deploy (a pool of ASSET) → swap1 (pool + sats change) → the leg spends swap1's
  // pool output and its change; a plain sats transaction (outside the topic) funds it too; another token's swap is outside.
  const root = "11".repeat(32);
  const deploy = tx([[root, 0]], [{ lockingScript: poolScript(ASSET), satoshis: 1_000_000 }]);
  const swap1 = tx([[deploy, 0], [root, 1]], [{ lockingScript: poolScript(ASSET), satoshis: 1_000_100 }, { lockingScript: pay, satoshis: 5_000 }]);
  const plain = tx([[root, 2]], [{ lockingScript: pay, satoshis: 9_000 }]);
  const otherSwap = tx([[root, 3]], [{ lockingScript: poolScript(OTHER), satoshis: 1 }, { lockingScript: pay, satoshis: 7_000 }]);
  const wallet = new Beef();
  wallet.mergeTxidOnly(root);
  for (const t of [deploy, swap1, plain, otherSwap]) wallet.mergeRawTx(t.toBinary());

  it("a swap the page took in and the pool's transaction are txid-only; their ancestry goes; a plain transaction stays raw", () => {
    const pool = swap1.id("hex");
    const got = entries(fundingBeef(wallet, plain.id("hex"), [plain.id("hex"), swap1.id("hex")], { poolTxid: pool, admitted: topicAdmitted(ASSET, pool) }));
    expect(got.atomic).toBe(plain.id("hex"));
    const by = new Map(got.txs.map((t) => [t.txid, t.txidOnly]));
    expect(by.get(swap1.id("hex"))).toBe(true);
    expect(by.get(plain.id("hex"))).toBe(false);
    expect(by.get(root)).toBe(true);
    expect(by.has(deploy.id("hex"))).toBe(false); // only swap1 needed it
  });

  it("another token's swap is outside this topic: raw with its ancestry; the pool's transaction is added by txid when absent", () => {
    const pool = deploy.id("hex");
    const got = entries(fundingBeef(wallet, otherSwap.id("hex"), [otherSwap.id("hex")], { poolTxid: pool, admitted: topicAdmitted(ASSET, pool) }));
    const by = new Map(got.txs.map((t) => [t.txid, t.txidOnly]));
    expect(by.get(otherSwap.id("hex"))).toBe(false);
    expect(by.get(pool)).toBe(true);
    expect(by.get(root)).toBe(true);
  });

  it("no predicate: every source raw with its ancestry (0.44 shape)", () => {
    const got = entries(fundingBeef(wallet, plain.id("hex"), [plain.id("hex"), swap1.id("hex")]));
    expect(got.txs.filter((t) => !t.txidOnly).map((t) => t.txid).sort()).toEqual([deploy.id("hex"), swap1.id("hex"), plain.id("hex")].sort());
  });
});
