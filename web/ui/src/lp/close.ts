/**
 * Close through the user's wallet: the LP's alone, so nothing is relayed (`Close(lpSig)`,
 * outputs free; skein-amm 0.13.0). One path (0.29.0, David Case 2026-11-02: "we should just use
 * create action directly"; 0.29.1: the page-built close and layout 1 are gone):
 *
 *   1. The pool's current output: followed from the position's deploy by the chain state
 *      (`GET <base>/spends`, src/lp/positions.ts), its BEEF from the token's 1Color lookup
 *      (BRC-207 `color-spendability` at `ls_color_<tokenId>`): the listing
 *      (`ls_amm_<assetId>`) answers listed pools only (a rescinded pool too is closed from
 *      here).
 *   2. The LP's outputs (`PoolTemplate.planClose`): every sat of the pool as a BRC-29 wallet
 *      payment to the LP key (to self), every token, one sat, to a NEW module receiving key of
 *      the user's own (`newReceivingKey`, sender the user's identity).
 *   3. ONE wallet createAction: the pool an explicit input (its BEEF the lookup's,
 *      `unlockingScriptLength` `PoolTemplate.maxCallUnlockLength`), the outputs of step 2 with
 *      the payout's remittance (`paymentCustomInstructions`) and the receipt
 *      (`colorReceiptInstructions`) as customInstructions, no baskets, in order. The wallet
 *      pays the miner fee and the token output's sat from its own funds and adds change; the
 *      page fills the pool input over the wallet's transaction (`callUnlock` + the LP's
 *      `createSignature`, checked with `Spend`) at signAction; the wallet broadcasts it,
 *      records it and marks the pool row spent.
 *   4. `POST <base>/submit` (`x-topics: tm_color_<assetId>`), the close's AtomicBEEF: BRC-22's
 *      STEAK; the receipt waits for the topic's admission.
 *   5. `completeClose`: the payout (a BRC-29 wallet payment) and the tokens (the module's
 *      receipt) taken in. No relinquishOutput.
 */
import { colorReceiptInstructions } from "@1sat/actions";
import { Beef, PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface } from "@bsv/sdk";
import { PoolTemplate, type CallPlan } from "../pool";
import { poolUtxoFrom, spendValid } from "../market/swapAction";
import { needSigned, type LookupOutput, type SignedFetch } from "../lib/overlay";
import type { LpKeyRef } from "./positions";
import { WALLET_PAYMENT, identityKeyOf, isBrc29Protocol, paymentCustomInstructions, splitBrc29KeyID, type Brc29Payout, type PaymentRemittance } from "../wallet/brc29";
import { colorQuery, sdkTokenId } from "../lib/tokenId";
import { newReceivingKey, receiptOutput, type ColorReceipt } from "../wallet/color";
import { inputIndexOf, runAppSignedAction } from "../wallet/action";
import { tokenP2pkhScript } from "./poolDeploy";
import { payoutId, type PendingPayoutStore } from "../wallet/pendingPayouts";

export class CloseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseShapeError";
  }
}

export interface CloseInput {
  wallet: WalletInterface;
  /** `<txid>_0` (src/lib/tokenId.ts). */
  tokenId: string;
  meta?: { sym?: string; dec?: number };
  /** The pool's current output (step 1). */
  poolOutput: LookupOutput;
  lpKey: LpKeyRef;
}

export interface PreparedClose {
  plan: CallPlan;
  /** The pool output spent, `txid.vout`. */
  poolOutpoint: string;
  /** Every input signed (the wallet's transaction). */
  tx: Transaction;
  txid: string;
  /** The close's AtomicBEEF: the `/submit` body. */
  beef: number[];
  /** `tm_color_<assetId>` */
  topic: string;
  /** The pool's sats as a BRC-29 payment to the LP key. */
  payout: Brc29Payout;
  /** The tokens to a module receiving key of the user's own, taken in with this receipt. */
  receipt: { outputIndex: number; receipt: ColorReceipt; lockingScript: string };
  /** What returns to the wallet. */
  sats: bigint;
  tokenAmount: bigint;
}

/** The remittance of a payment to the LP key `lpKey` (a BRC-29 key to self), or null. */
export function lpRemittance(lpKey: LpKeyRef, senderIdentityKey: string): PaymentRemittance | null {
  if (!isBrc29Protocol(lpKey.protocolID) || lpKey.counterparty !== "self") return null;
  const parts = splitBrc29KeyID(lpKey.keyID);
  return parts ? { ...parts, senderIdentityKey } : null;
}

/** BRC-100 descriptions are 5-50 characters. */
function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** Steps 2-3 (see the module comment): the wallet's action, broadcast by the wallet. */
export async function prepareClose(i: CloseInput): Promise<PreparedClose> {
  const { wallet } = i;
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  const pool = PoolTemplate.decode(poolUtxo.script);
  if (!pool) throw new CloseShapeError("the output is not a pool");
  const sats = BigInt(poolUtxo.satoshis);
  const me = await identityKeyOf(wallet);
  const remittance = lpRemittance(i.lpKey, me);
  if (!remittance) throw new CloseShapeError(`the LP key ${i.lpKey.keyID} is not a BRC-29 key to self`);
  const lpArgs = { protocolID: i.lpKey.protocolID, keyID: i.lpKey.keyID, counterparty: i.lpKey.counterparty };
  const { publicKey: lpPub } = await wallet.getPublicKey({ ...lpArgs, forSelf: true });
  if (PublicKey.fromString(lpPub).toString() !== pool.state.lpPubKey) throw new CloseShapeError(`the wallet key ${i.lpKey.keyID} is not this pool's LP key`);

  const sdkId = sdkTokenId(i.tokenId);
  const sym = i.meta?.sym ?? "token";
  // The LP's outputs: every sat to the LP key, the tokens to a fresh module key of the user's own.
  const k = await newReceivingKey(wallet, sdkId, me);
  const tokenScript = tokenP2pkhScript(sdkId, pool.state.tokenReserve, k.publicKey);
  const payoutScript = `76a914${Utils.toHex(PublicKey.fromString(lpPub).toHash() as number[])}88ac`;
  const plan = PoolTemplate.planClose({ pool: poolUtxo, outputs: [{ satoshis: sats, script: payoutScript }, { satoshis: 1n, script: tokenScript }] });
  const payout: Brc29Payout = { outputIndex: 0, satoshis: Number(sats), lockingScript: payoutScript, remittance };
  const receipt = { outputIndex: 1, receipt: k.receipt, lockingScript: tokenScript };
  const poolOutpoint = `${poolUtxo.txid}.${poolUtxo.vout}`;
  const lpSigner = async (sighash: number[]) => (await wallet.createSignature({ ...lpArgs, hashToDirectlySign: sighash })).signature;

  const signed = await runAppSignedAction(
    wallet,
    {
      description: describe(`AMM close: ${sym}`),
      inputBEEF: Beef.fromBinary(i.poolOutput.beef).toBinary(),
      inputs: [{ outpoint: poolOutpoint, unlockingScriptLength: PoolTemplate.maxCallUnlockLength(plan), inputDescription: describe(`The ${sym} pool`) }],
      outputs: [
        { lockingScript: payoutScript, satoshis: Number(sats), outputDescription: describe(`${sym} pool sats to you`), customInstructions: paymentCustomInstructions(remittance) },
        { lockingScript: tokenScript, satoshis: 1, outputDescription: describe(`${sym} pool tokens to you`), customInstructions: colorReceiptInstructions(k.receipt) },
      ],
      labels: ["amm-close"],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    async (tx) => {
      // The contract reads input 0 (the preimage is input 0's); the wallet places named inputs first.
      if (inputIndexOf(tx, poolUtxo.txid, poolUtxo.vout) !== 0) throw new CloseShapeError("the wallet did not place the pool as input 0");
      plan.outputs.forEach((o, n) => {
        if (BigInt(tx.outputs[n]?.satoshis ?? -1) !== o.satoshis || tx.outputs[n]!.lockingScript.toHex() !== o.script) throw new CloseShapeError(`the wallet moved output ${n} of the close`);
      });
      // Close's outputs are free: the call's preimage covers the wallet's outputs, change included.
      const callPlan = PoolTemplate.planClose({ pool: poolUtxo, outputs: tx.outputs.map((o) => ({ satoshis: BigInt(o.satoshis!), script: o.lockingScript.toHex() })) });
      tx.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(callPlan, tx, null).unlockingScript;
      await PoolTemplate.signPoolInput({ tx, pool: callPlan.pool, method: "close", unsigned: ["lp"], sourceSatoshis: poolUtxo.satoshis }, "lp", lpSigner);
      if (!spendValid(tx, 0)) throw new CloseShapeError("input 0 of the close does not validate");
      return { 0: { unlockingScript: tx.inputs[0]!.unlockingScript!.toHex() } };
    },
  );
  return {
    plan,
    poolOutpoint,
    tx: Transaction.fromAtomicBEEF(signed.tx),
    txid: signed.txid,
    beef: signed.tx,
    topic: `tm_color_${sdkId}`,
    payout,
    receipt,
    sats,
    tokenAmount: pool.state.tokenReserve,
  };
}

export interface CompletedClose {
  internalized: boolean;
  errors: string[];
}

/**
 * Step 5, after the submit: the payout (a BRC-29 wallet payment) in one `internalizeAction`, the
 * tokens through the module (`receiptOutput`, a second `internalizeAction`: the module takes in
 * only an admitted output; kept in `payouts` when it does not, for a retry). No relinquishOutput:
 * the wallet's own action marks the pool row spent.
 */
export async function completeClose(wallet: WalletInterface, s: PreparedClose, payouts?: PendingPayoutStore): Promise<CompletedClose> {
  const out: CompletedClose = { internalized: false, errors: [] };
  const outputs: InternalizeOutput[] = [{ outputIndex: s.payout.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...s.payout.remittance } }];
  let ok = true;
  try {
    const r = await wallet.internalizeAction({ tx: s.beef, outputs, description: "AMM close", labels: ["amm-close"] });
    ok = r.accepted;
  } catch (err) {
    ok = false;
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pending = {
    id: payoutId(s.txid, s.receipt.outputIndex),
    kind: "close" as const,
    txid: s.txid,
    vout: s.receipt.outputIndex,
    satoshis: 1,
    lockingScript: s.receipt.lockingScript,
    receipt: s.receipt.receipt,
    final: true,
    tokenId: s.receipt.receipt.assetId,
    atomicBeef: Utils.toHex(s.beef),
    description: "AMM close: the tokens",
    createdAt: Date.now(),
  };
  payouts?.save(pending);
  try {
    const r = await wallet.internalizeAction({ tx: s.beef, outputs: [receiptOutput(s.receipt.outputIndex, s.receipt.receipt)], description: "AMM close: the tokens", labels: ["amm-close"] });
    ok = ok && r.accepted;
    if (r.accepted) payouts?.remove(pending.id);
  } catch (err) {
    ok = false;
    out.errors.push(`internalizeAction (the tokens): ${err instanceof Error ? err.message : String(err)}`);
  }
  out.internalized = ok;
  return out;
}

/** BRC-22's STEAK: per topic, the outputs admitted and the coins retained and removed. */
export type Steak = Record<string, { outputsToAdmit: number[]; coinsToRetain: number[]; coinsRemoved: number[] }>;

/**
 * Submit to the instance (BRC-22; skein-overlay 0.9.1, docs/OVERLAY.md "Submitting"): `POST
 * <base>/submit` (`x-topics` the token topic, the body the BEEF) waits on the submission and
 * answers the STEAK; 503 with Retry-After when nothing is decided within the host's bound (the
 * submission stands: `steak` absent). Plain `fetch`, unsigned (0.6.3; David 2026-10-08: "We
 * shouldn't be using authfetch for the submit http method."): the front door (shruggr/skein#135)
 * admits an unsigned POST at the overlay's `submit` row (sender `*`, filter `beef`), and
 * `@bsv/sdk`'s AuthFetch refuses the `x-topics` header client-side.
 */
export async function submitToOverlay(
  base: string,
  topic: string,
  beef: number[],
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ steak?: Steak }> {
  const res = await fetchFn(`${base}/submit`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-topics": topic },
    body: new Uint8Array(beef),
  });
  const text = await res.text();
  if (res.status === 503) return {};
  if (!res.ok) throw new Error(`POST ${base}/submit: ${res.status} ${text.slice(0, 300)}`);
  let steak: unknown;
  try {
    steak = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!steak || typeof steak !== "object" || Array.isArray(steak)) throw new Error(`POST ${base}/submit: want the STEAK, got ${text.slice(0, 300)}`);
  return { steak: steak as Steak };
}

/** The STEAK in words: the topics that admitted outputs, else "taken by no topic"; no STEAK, "not decided yet". */
export function steakText(r: { steak?: Steak }): string {
  if (!r.steak) return "not decided yet";
  const took = Object.entries(r.steak).filter(([, e]) => e.outputsToAdmit.length > 0).map(([t, e]) => `${t} (outputs ${e.outputsToAdmit.join(", ")})`);
  return took.length ? `admitted under ${took.join("; ")}` : "taken by no topic";
}

/**
 * Whether the overlay admitted output `outputIndex` of `txid`: BRC-207's `color-admission` at the
 * token instance's `ls_color_<tokenId>` (0.20.1; `ls_color {txid, outputIndex}` until 0.19.0)
 * asked until it answers the output or `timeoutMs` passes.
 * The engine admits once the chain app accepts the transaction (its broadcast succeeded).
 */
export async function awaitAdmitted(
  af: SignedFetch | null,
  base: string,
  tokenId: string,
  txid: string,
  outputIndex: number,
  o: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const signed = needSigned(af);
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const res = await signed.fetch(`${base}/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(colorQuery("color-admission", tokenId, [`${txid}.${outputIndex}`])),
    });
    if (res.ok) {
      const a = (await res.json()) as { outputs?: unknown[] };
      if (Array.isArray(a.outputs) && a.outputs.length > 0) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 2_000));
  }
}
