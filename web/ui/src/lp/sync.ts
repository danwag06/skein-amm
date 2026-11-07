/**
 * The LP wallet catches up one hop at a time from the pool output it holds.
 * Each hop files that transaction's continuation into `amm-pools` and, on a
 * swap, its LP fee into `openex fees`. Close and collect run the same walk,
 * then spend what the wallet holds.
 */
import { Beef, Transaction, Utils, type CreateActionOutput, type InternalizeOutput, type WalletInterface, type WalletOutput, type WalletProtocol } from "@bsv/sdk";
import { ColorPlan } from "@bsv/color-permission-module";
import type { PoolEvent } from "../lib/overlay.js";
import { parseOutpoint, sdkTokenId, tokenIdOfWire } from "../lib/tokenId.js";
import { PoolTemplate } from "../pool/index.js";
import { decodeOneColor } from "../pool/oneColor.js";
import { signP2pkhWithWallet } from "../market/swapAction.js";
import { inputIndexOf, runAppSignedAction } from "../wallet/action.js";
import { FEES_BASKET, POOLS_BASKET, newReceivingKey } from "../wallet/color.js";
import { identityKeyOf, internalizePayout, newBrc29Payout } from "../wallet/brc29.js";
import { POOL_TAG, tokenP2pkhScript } from "./poolDeploy.js";
import { basketBeef, basketRows } from "./wallet.js";

export { FEES_BASKET };

/** A P2PKH unlock is a signature push and a public-key push (BIP-143, 107–108 bytes). */
const P2PKH_UNLOCK_LENGTH = 108;

export interface SyncIo {
  /** History strictly after this outpoint (`txid_vout`). The page's `next` is not read. */
  history: (outpoint: string) => Promise<{ events: PoolEvent[] }>;
  readTx: (txid: string) => Promise<number[] | null>;
}

export interface CollectResult {
  /** Absent when the basket had nothing to spend. */
  txid?: string;
  sats: bigint;
  tokens: { tokenId: string; amount: bigint }[];
}

/** The key a filed output's customInstructions names, or null. */
export function storedKey(customInstructions: string | undefined): { protocolID: WalletProtocol; keyID: string; counterparty: string; poolId?: string; id?: string } | null {
  try {
    const ci = JSON.parse(customInstructions ?? "") as { protocolID?: unknown; keyID?: unknown; counterparty?: unknown; poolId?: unknown; id?: unknown };
    if (!Array.isArray(ci.protocolID) || ci.protocolID.length < 2 || typeof ci.protocolID[1] !== "string" || typeof ci.keyID !== "string") return null;
    const level = Number(ci.protocolID[0]);
    if (!Number.isInteger(level)) return null;
    return {
      protocolID: [level, ci.protocolID[1]] as WalletProtocol,
      keyID: ci.keyID,
      counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self",
      ...(typeof ci.poolId === "string" ? { poolId: ci.poolId } : {}),
      ...(typeof ci.id === "string" ? { id: ci.id } : {}),
    };
  } catch {
    return null;
  }
}

/** `<txid>_<vout>`, txid lowercased, or null. */
export function serverOutpoint(text: string): string | null {
  const op = parseOutpoint(text);
  return op ? `${op.txid}_${op.vout}` : null;
}

function pointKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}.${vout}`;
}

function rowKey(row: { outpoint: string }): string | null {
  const op = parseOutpoint(row.outpoint);
  return op ? `${op.txid}.${op.vout}` : null;
}

/**
 * The `amm-pools` row of `poolId`. A row that names `poolId` matches that.
 * A row with no pool id matches when its own outpoint is that id (still the deploy).
 */
export function heldPoolRow(rows: WalletOutput[], poolId: string): WalletOutput | undefined {
  const want = serverOutpoint(poolId) ?? poolId.toLowerCase();
  for (const row of rows) {
    let named: string | null = null;
    try {
      const ci = JSON.parse(row.customInstructions ?? "") as { poolId?: unknown };
      if (typeof ci.poolId === "string") named = serverOutpoint(ci.poolId) ?? ci.poolId.toLowerCase();
    } catch {
      /* not JSON: match by outpoint only */
    }
    const self = serverOutpoint(row.outpoint);
    if (named ? named === want : self === want) return row;
  }
  return undefined;
}

function withPoolId(customInstructions: string | undefined, poolId: string): string {
  let ci: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(customInstructions ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ci = parsed as Record<string, unknown>;
  } catch {
    ci = {};
  }
  if (typeof ci.poolId !== "string") ci.poolId = poolId;
  return JSON.stringify(ci);
}

function txOf(beef: Beef, txid: string): Transaction | undefined {
  const found = beef.findTxid(txid) ?? beef.findTxid(txid.toLowerCase());
  if (!found) return undefined;
  if (found.tx) return found.tx;
  return found.rawTx ? Transaction.fromBinary(found.rawTx) : undefined;
}

function spendsHeld(tx: Transaction, held: WalletOutput): boolean {
  const op = parseOutpoint(held.outpoint);
  if (!op) return false;
  return tx.inputs.some((i) => {
    const id = (i.sourceTXID ?? i.sourceTransaction?.id("hex") ?? "").toLowerCase();
    return id === op.txid && i.sourceOutputIndex === op.vout;
  });
}

function continuationOf(held: WalletOutput, tx: Transaction, poolId: string): WalletOutput {
  const out = tx.outputs[0]!;
  return {
    ...held,
    outpoint: `${tx.id("hex")}.0`,
    satoshis: out.satoshis ?? 0,
    lockingScript: out.lockingScript.toHex(),
    customInstructions: withPoolId(held.customInstructions, poolId),
  };
}

/**
 * Walk `poolId` from the output the wallet holds. One internalize per hop that
 * still has a continuation or a fee to file. Stops when the next event does
 * not spend that output, when output 0 is not a pool, or when the transaction
 * cannot be read. Does not throw for a missing transaction.
 */
export async function syncPool(wallet: WalletInterface, poolId: string, io: SyncIo): Promise<void> {
  const [pools, fees] = await Promise.all([basketRows(wallet, POOLS_BASKET), basketRows(wallet, FEES_BASKET)]);
  const opening = heldPoolRow(pools, poolId);
  if (!opening) return;
  let current: WalletOutput = opening;
  const knownPools = new Set(pools.map(rowKey).filter((k): k is string => k !== null));
  const knownFees = new Set(fees.map(rowKey).filter((k): k is string => k !== null));
  let cursor = serverOutpoint(current.outpoint);
  if (!cursor) return;

  const apply = async (event: PoolEvent): Promise<"stop" | string> => {
    const raw = await io.readTx(event.txid);
    if (!raw) return "stop";
    let beef: Beef;
    try {
      beef = Beef.fromBinary(raw);
    } catch {
      return "stop";
    }
    const tx = txOf(beef, event.txid);
    if (!tx || !spendsHeld(tx, current)) return "stop";
    const out0 = tx.outputs[0];
    const pool = out0?.lockingScript ? PoolTemplate.decode(out0.lockingScript) : null;
    if (!pool) return "stop";
    const rescind = event.kind === "rescind" || PoolTemplate.rescinded(pool);
    const wantFee = event.kind === "swap" && (event.feeLp ?? 0n) > 0n && !rescind;
    if (wantFee && !tx.outputs[2]) throw new Error("the swap names an LP fee and has no output 2");
    const txid = tx.id("hex").toLowerCase();
    const contKnown = knownPools.has(pointKey(txid, 0));
    const feeKnown = !wantFee || knownFees.has(pointKey(txid, 2));
    if (!contKnown || !feeKnown) {
      const outputs: InternalizeOutput[] = [];
      if (!contKnown) {
        outputs.push({
          outputIndex: 0,
          protocol: "basket insertion",
          insertionRemittance: { basket: POOLS_BASKET, tags: [POOL_TAG], customInstructions: withPoolId(current.customInstructions, poolId) },
        });
      }
      if (wantFee && !feeKnown) {
        const key = storedKey(current.customInstructions);
        if (!key) throw new Error("the pool output names no key");
        const feeOut = tx.outputs[2]!;
        const color = decodeOneColor(feeOut.lockingScript.toBinary());
        const tokenId = color?.idBytes && color.role !== "deploy" ? tokenIdOfWire(color.idBytes) : key.id;
        outputs.push({
          outputIndex: 2,
          protocol: "basket insertion",
          insertionRemittance: {
            basket: FEES_BASKET,
            customInstructions: JSON.stringify({
              protocolID: key.protocolID,
              keyID: key.keyID,
              counterparty: key.counterparty,
              poolId,
              ...(tokenId ? { id: tokenId } : {}),
            }),
          },
        });
      }
      await wallet.internalizeAction({ tx: beef.toBinary(), outputs, description: "AMM pool output filed" });
      if (!contKnown) knownPools.add(pointKey(txid, 0));
      if (wantFee && !feeKnown) knownFees.add(pointKey(txid, 2));
    }
    current = continuationOf(current, tx, poolId);
    return `${txid}_0`;
  };

  for (;;) {
    const page = await io.history(cursor);
    if (page.events.length === 0) break;
    const start: string = cursor;
    for (const event of page.events) {
      const next = await apply(event);
      if (next === "stop") return;
      cursor = next;
    }
    if (cursor === start) break;
  }
}

interface FeeInput {
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
  kind: "sats" | "token";
  tokenId?: string;
  amount?: bigint;
}

/** Spend every output in `openex fees`: sats to one BRC-29 address, each token's sum to one `p color` output. */
export async function collectBasket(wallet: WalletInterface): Promise<CollectResult> {
  const rows = await basketRows(wallet, FEES_BASKET);
  if (rows.length === 0) return { sats: 0n, tokens: [] };
  const fees: FeeInput[] = [];
  for (const row of rows) {
    if (!row.lockingScript) throw new Error("the fee output has no locking script");
    const key = storedKey(row.customInstructions);
    if (!key) throw new Error("the fee output names no key");
    if (!Number.isSafeInteger(row.satoshis) || row.satoshis < 0) throw new Error("the fee output's satoshis are not a safe integer");
    const listed = /^([0-9a-fA-F]{64})[._](\d+)$/.exec(row.outpoint);
    if (!listed) throw new Error("the fee output names no outpoint");
    const color = decodeOneColor(Utils.toArray(row.lockingScript, "hex"));
    const token = Boolean(color?.idBytes && color.role !== "deploy");
    fees.push({
      txid: listed[1]!,
      vout: Number(listed[2]),
      satoshis: row.satoshis,
      lockingScript: row.lockingScript,
      protocolID: key.protocolID,
      keyID: key.keyID,
      counterparty: key.counterparty,
      kind: token ? "token" : "sats",
      ...(token ? { tokenId: tokenIdOfWire(color!.idBytes!), amount: color!.amount } : {}),
    });
  }
  let sats = 0n;
  const byToken = new Map<string, bigint>();
  for (const fee of fees) {
    if (fee.kind === "sats") sats += BigInt(fee.satoshis);
    else if ((fee.amount ?? 0n) > 0n && fee.tokenId) byToken.set(fee.tokenId, (byToken.get(fee.tokenId) ?? 0n) + fee.amount!);
  }
  const tokens = [...byToken.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([tokenId, amount]) => ({ tokenId, amount }));
  if (sats === 0n && tokens.length === 0) return { sats: 0n, tokens: [] };
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("the fee sats are not a safe integer");
  const beef = await basketBeef(wallet, FEES_BASKET);
  if (!beef) throw new Error("the fee outputs' transactions are not in the wallet");

  const outputs: CreateActionOutput[] = [];
  let payout: Awaited<ReturnType<typeof newBrc29Payout>> | undefined;
  if (sats > 0n) {
    payout = await newBrc29Payout(wallet);
    outputs.push({ lockingScript: payout.lockingScript, satoshis: Number(sats), outputDescription: "Pool fees in sats" });
  }
  const owned: { outputIndex: number; assetId: string; derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string }[] = [];
  if (tokens.length > 0) {
    const me = await identityKeyOf(wallet);
    for (const token of tokens) {
      const assetId = sdkTokenId(token.tokenId);
      const k = await newReceivingKey(wallet, assetId, me);
      owned.push({ outputIndex: outputs.length, ...k.receipt });
      outputs.push({ lockingScript: tokenP2pkhScript(assetId, token.amount, k.publicKey), satoshis: 1, outputDescription: "Pool fees in tokens" });
    }
  }
  const labels = tokens.length > 0
    ? ColorPlan.toLabels({
        version: 1,
        assets: tokens.map((t) => sdkTokenId(t.tokenId)),
        ownedOutputs: owned,
        operations: tokens.map((t) => ({ assetId: sdkTokenId(t.tokenId), operation: "transfer" as const })),
        inputPositions: [],
        changePositions: [],
        sighashTypes: [],
      })
    : undefined;
  const signed = await runAppSignedAction(
    wallet,
    {
      description: "Collect pool fees",
      inputBEEF: beef.toBinary(),
      inputs: fees.map((fee) => ({ outpoint: `${fee.txid}.${fee.vout}`, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: "A pool fee" })),
      outputs,
      ...(labels ? { labels } : {}),
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    async (tx) => {
      const spends: Record<number, { unlockingScript: string }> = {};
      for (const fee of fees) {
        const n = inputIndexOf(tx, fee.txid, fee.vout);
        if (n < 0) throw new Error("the wallet did not place a fee input");
        const unlock = await signP2pkhWithWallet(wallet, tx, n, fee);
        spends[n] = { unlockingScript: unlock.toHex() };
      }
      return spends;
    },
  );
  if (payout) await internalizePayout(wallet, signed.tx, { outputIndex: 0, remittance: payout.remittance }, "Pool fees in sats");
  return { txid: signed.txid, sats, tokens };
}
