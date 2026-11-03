/**
 * Unfinished steps (skein-amm 0.29.3, David Case 2026-11-02): a to-do list in the browser, not a
 * key store. One entry per swap payout output the wallet has not taken in yet, written before the
 * swap is relayed and cleared only when the wallet accepted the take-in. It holds no key material:
 * the payout keys are derived from the final transaction's own inputs (`legDerivation`,
 * src/market/swapAction.ts), so "Finish" (`internalizeNow`) finds the transaction on the
 * instance, re-derives the key, checks the output pays it and internalizes (BRC-29 payment, or the
 * module's receipt). Move back and Close write nothing (0.29.3: the module files their output in
 * the same createAction).
 *
 * Entry: `{id, kind: "swap", txid, vout, tokenId, base, createdAt, final}`; `id` = `txid:vout`;
 * `txid` provisional (the validator's signature changes it) until `final`.
 *
 * Entries written before 0.29.3 carry the bytes they were written with (`receipt` or `remittance`,
 * `lockingScript`, `satoshis`, `atomicBeef`; kinds "swap", "move-back", "close",
 * "remove-liquidity"): still listed and finished once with those bytes; nothing writes them now.
 *
 * Storage: `localStorage["amm-poc.pending-payouts.v1"]`, one JSON object `{[txid:vout]: entry}`;
 * every access is guarded (private windows, blocked storage), and tests pass their own `KV`.
 */
import { Beef, PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface } from "@bsv/sdk";
import { lookupPoolOutput, queryPools, type SignedFetch } from "../lib/overlay";
import { WALLET_PAYMENT, brc29PublicKey, identityKeyOf, internalizePayout, p2pkhHexOf, type PaymentRemittance } from "./brc29";
import { newReceivingKey, receiptOutput, type ColorReceipt } from "./color";
import { PoolTemplate, decodeOneColor } from "../pool";
import { sdkTokenId } from "../lib/tokenId";
import { legDerivation, legKeyInputOf } from "../market/swapAction";
import { tokenP2pkhScript } from "../lp/poolDeploy";

export const PENDING_PAYOUTS_KEY = "amm-poc.pending-payouts.v1";

export interface PendingPayout {
  /** `txid:vout` */
  id: string;
  kind: "swap" | "remove-liquidity" | "move-back" | "close";
  txid: string;
  vout: number;
  /** The token (`<txid>_<vout>`): the pools whose BEEF carries the transaction. */
  tokenId: string;
  /** The token instance's base URL (0.29.3); absent on an old entry. */
  base?: string;
  createdAt: number;
  /** false while the txid is provisional (a swap before the validator signs). */
  final: boolean;
  // Before 0.29.3 (read only: an old entry is finished with its own bytes).
  satoshis?: number;
  lockingScript?: string;
  remittance?: PaymentRemittance;
  receipt?: ColorReceipt;
  atomicBeef?: string;
  poolOutpoint?: string;
  reference?: string;
  description?: string;
}

/** Whether an entry carries the key bytes of a pre-0.29.3 record. */
export function isLegacyPayout(p: PendingPayout): boolean {
  return p.receipt !== undefined || p.remittance !== undefined;
}

/** The subset of Storage the store needs. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultKV(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export class PendingPayoutStore {
  constructor(private readonly kv: KV | null = defaultKV()) {}

  private read(): Record<string, PendingPayout> {
    try {
      const raw = this.kv?.getItem(PENDING_PAYOUTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? (parsed as Record<string, PendingPayout>) : {};
    } catch {
      return {};
    }
  }

  private write(all: Record<string, PendingPayout>): boolean {
    try {
      if (!this.kv) return false;
      this.kv.setItem(PENDING_PAYOUTS_KEY, JSON.stringify(all));
      notify();
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the browser can keep records at all (false: private window / blocked storage). */
  get durable(): boolean {
    return this.kv !== null;
  }

  list(): PendingPayout[] {
    return Object.values(this.read()).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PendingPayout | undefined {
    return this.read()[id];
  }

  /** Returns false when the record could not be stored. */
  save(p: PendingPayout): boolean {
    const all = this.read();
    all[p.id] = p;
    return this.write(all);
  }

  remove(id: string): void {
    const all = this.read();
    if (!(id in all)) return;
    delete all[id];
    this.write(all);
  }

  /** Re-key a provisional record to the final txid. */
  finalize(id: string, txid: string): PendingPayout | undefined {
    const all = this.read();
    const p = all[id];
    if (!p) return undefined;
    delete all[id];
    const next: PendingPayout = { ...p, id: payoutId(txid, p.vout), txid, final: true };
    all[next.id] = next;
    this.write(all);
    return next;
  }
}

export function payoutId(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

// Subscribers (the panel) hear every write in this tab; other tabs get the `storage` event.
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
export function onPendingPayoutsChange(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PENDING_PAYOUTS_KEY) fn();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

/** An old entry's output pays its script and amount. */
function pays(tx: { outputs: { satoshis?: number; lockingScript: { toHex(): string } }[] }, p: PendingPayout): boolean {
  const o = tx.outputs[p.vout];
  return !!o && o.satoshis === p.satoshis && o.lockingScript.toHex() === p.lockingScript;
}

/** An old entry, in a BEEF: the transaction (by txid when final, else by the payout script) as AtomicBEEF. */
function findIn(beefBytes: number[], p: PendingPayout): { txid: string; beef: number[] } | null {
  const beef = Beef.fromBinary(beefBytes);
  for (const btx of beef.txs) {
    const tx = btx.tx;
    if (!tx) continue;
    if (p.final ? btx.txid === p.txid && pays(tx, p) : pays(tx, p)) return { txid: btx.txid, beef: beef.toBinaryAtomic(btx.txid) };
  }
  return null;
}

/** The BEEFs the instance answers for the token's pools: the final txid's pool output (and its newest continuation), else every live pool. */
async function* poolBeefs(af: SignedFetch | null, base: string, p: PendingPayout): AsyncGenerator<number[]> {
  const first = p.final ? (p.poolOutpoint ?? `${p.txid}_0`) : null;
  if (first) {
    try {
      yield (await lookupPoolOutput(af, base, p.tokenId, first)).beef;
    } catch {
      /* fall through to the scan */
    }
  }
  for (const pool of await queryPools(af, base, p.tokenId, {})) {
    try {
      yield (await lookupPoolOutput(af, base, p.tokenId, pool.outpoint)).beef;
    } catch {
      /* next pool */
    }
  }
}

/** An old entry's final transaction: its own AtomicBEEF, else the instance's pools. */
export async function findPayoutBeef(af: SignedFetch | null, base: string, p: PendingPayout): Promise<{ txid: string; beef: number[] } | null> {
  if (p.atomicBeef) {
    const hit = findIn(Utils.toArray(p.atomicBeef, "hex"), p);
    if (hit) return hit;
  }
  for await (const b of poolBeefs(af, base, p)) {
    const hit = findIn(b, p);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether output `vout` of `tx` (a swap: the pool at input 0 and output 0) pays this wallet's leg
 * key, re-derived from the transaction's own inputs (`legDerivation`): the take-in for it, or null.
 * A 1Color output is a receipt (sender the pool's validator), a P2PKH one a BRC-29 payment.
 */
export async function swapPayoutOf(wallet: WalletInterface, tx: Transaction, vout: number, tokenId: string): Promise<InternalizeOutput | null> {
  const pool = tx.outputs[0] ? PoolTemplate.decode(tx.outputs[0].lockingScript) : null;
  const out = tx.outputs[vout];
  const first = tx.outputs[1];
  if (!pool || !out || !first || vout < 1 || tx.inputs.length < 2) return null;
  const bsvIn = decodeOneColor(first.lockingScript.toBinary()) !== null;
  let keyInput: string;
  try {
    keyInput = legKeyInputOf(tx, bsvIn);
  } catch {
    return null;
  }
  const d = legDerivation(keyInput, vout === 1 ? "payout" : "commission");
  const script = out.lockingScript.toHex();
  const token = decodeOneColor(out.lockingScript.toBinary());
  if (token) {
    const sdkId = sdkTokenId(tokenId);
    const k = await newReceivingKey(wallet, sdkId, pool.state.validatorIdentity, d);
    return tokenP2pkhScript(sdkId, token.amount, k.publicKey) === script ? receiptOutput(vout, k.receipt) : null;
  }
  const identity = await identityKeyOf(wallet);
  const pub = await brc29PublicKey(wallet, d);
  if (p2pkhHexOf(PublicKey.fromString(pub).toString()) !== script) return null;
  return { outputIndex: vout, protocol: WALLET_PAYMENT, paymentRemittance: { ...d, senderIdentityKey: identity } };
}

/** A swap entry's final transaction on the instance, with its take-in: the final txid's, else any swap in a live pool's BEEF paying this wallet's derived key at `vout`. */
async function findSwapPayout(wallet: WalletInterface, af: SignedFetch | null, base: string, p: PendingPayout): Promise<{ txid: string; beef: number[]; output: InternalizeOutput } | null> {
  const seen = new Set<string>();
  for await (const bytes of poolBeefs(af, base, p)) {
    const beef = Beef.fromBinary(bytes);
    for (const btx of beef.txs) {
      if (!btx.tx || seen.has(btx.txid) || (p.final && btx.txid !== p.txid)) continue;
      seen.add(btx.txid);
      const output = await swapPayoutOf(wallet, btx.tx, p.vout, p.tokenId);
      if (output) return { txid: btx.txid, beef: beef.toBinaryAtomic(btx.txid), output };
    }
  }
  return null;
}

const NOT_FOUND = (p: PendingPayout) =>
  p.final
    ? `the instance's lookup has no transaction ${p.txid.slice(0, 16)}… paying this output (not admitted yet, or no longer in a live pool's BEEF)`
    : "the final transaction is not on the instance yet: the validator has not returned the signed swap yet";

/**
 * "Finish" (the Unfinished card): find the final transaction on the instance, take the output in,
 * and clear the entry only when the wallet accepted. An old entry with its own bytes; a 0.29.3
 * swap entry with its key re-derived from the transaction.
 */
export async function internalizeNow(wallet: WalletInterface, store: PendingPayoutStore, af: SignedFetch | null, base: string, p: PendingPayout): Promise<{ accepted: boolean; txid: string }> {
  const description = (p.description ?? (p.kind === "swap" ? "AMM swap payout" : `AMM ${p.kind}`)).slice(0, 50);
  let found: { txid: string; beef: number[] };
  let output: InternalizeOutput | null;
  if (isLegacyPayout(p)) {
    const hit = await findPayoutBeef(af, base, p);
    if (!hit) throw new Error(NOT_FOUND(p));
    found = hit;
    output = p.receipt ? receiptOutput(p.vout, p.receipt) : null;
    if (!output && p.remittance) {
      const r = await internalizePayout(wallet, found.beef, { outputIndex: p.vout, remittance: p.remittance }, description);
      if (r.accepted) store.remove(p.id);
      return { accepted: r.accepted, txid: found.txid };
    }
  } else {
    const hit = await findSwapPayout(wallet, af, base, p);
    if (!hit) throw new Error(NOT_FOUND(p));
    found = hit;
    output = hit.output;
  }
  if (!output) return { accepted: false, txid: found.txid };
  const r = await wallet.internalizeAction({ tx: found.beef, outputs: [output], description, labels: ["amm-payout"] });
  if (r.accepted) store.remove(p.id);
  return { accepted: r.accepted, txid: found.txid };
}
