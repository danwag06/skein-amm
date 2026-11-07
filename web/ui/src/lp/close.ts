/**
 * Close through the user's wallet: the LP's alone, so nothing is relayed (`Close(lpSig)`,
 * outputs free; skein-amm 0.13.0). One path (0.29.0, David Case 2026-11-02: "we should just use
 * create action directly"; 0.29.1: the page-built close and layout 1 gone; 0.29.3: a module plan):
 *
 *   1. The pool output the wallet holds, and its BEEF (`GET /@<token>/amm/tx?id=` of that
 *      output's transaction), after the wallet has caught up to it.
 *   2. The LP's one output (`PoolTemplate.planClose`): every token, one sat, to a NEW module
 *      receiving key of the user's own (`newReceivingKey`, sender the user's identity). The pool's
 *      sats go to the wallet's change: no payout output, no remittance.
 *   3. ONE createAction through the wallet's BRC-207 module: a `p color plan` transfer whose owned
 *      output 0 is that token output (the module checks it pays the remittance's key and files it
 *      in `p color <assetTag>` with its custody in this same call); the pool an explicit input
 *      (its BEEF the lookup's, `unlockingScriptLength` `PoolTemplate.maxCallUnlockLength`) — to the
 *      module a FOREIGN token input, checked admitted and unspent on the token's overlay;
 *      `randomizeOutputs: false`. The wallet pays the miner fee and the token output's sat, its
 *      change takes the pool's sats; the page fills the pool input over the wallet's transaction
 *      (`callUnlock` + the LP's `createSignature`, checked with `Spend`) at signAction; the
 *      module approves and submits, the wallet broadcasts and marks the pool row spent.
 *   4. `POST <origin>/submit` (`x-topics: tm_color_<assetId>`), the close's AtomicBEEF: the page's
 *      own submit. Nothing is taken in afterwards and nothing is kept in the browser.
 */
import { Beef, PublicKey, Transaction, type WalletInterface } from "@bsv/sdk";
import { PoolTemplate, type CallPlan, type PoolUtxo } from "../pool/index.js";
import { poolUtxoFrom, spendValid } from "../market/swapAction.js";
import type { LookupOutput } from "../lib/overlay.js";
import type { LpKeyRef } from "./positions.js";
import { identityKeyOf } from "../wallet/brc29.js";
import { sdkTokenId } from "../lib/tokenId.js";
import { newReceivingKey, transferPlanLabels } from "../wallet/color.js";
import { inputIndexOf, runAppSignedAction } from "../wallet/action.js";
import { tokenP2pkhScript } from "./poolDeploy.js";

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
  /** The pool output the wallet holds (step 1). */
  poolOutput: LookupOutput;
  lpKey: LpKeyRef;
  /** The wallet's listed txid. Used when the BEEF is not atomic, and as the spend's txid. */
  txid?: string;
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
  /** The token output (0), filed by the module. */
  tokenOutput: { outputIndex: number; lockingScript: string };
  /** What returns to the wallet: the pool's sats (into its change, less the fee) and its tokens. */
  sats: bigint;
  tokenAmount: bigint;
}

/** BRC-100 descriptions are 5-50 characters. */
function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** The pool output inside a BEEF: atomic (`/pools/beef`) or parents-first (`GET /tx?id=`). */
function poolFromBeef(beefBytes: number[], outputIndex: number, txid?: string): PoolUtxo {
  const beef = Beef.fromBinary(beefBytes);
  if (beef.atomicTxid) return poolUtxoFrom({ beef: beefBytes, outputIndex });
  if (!txid) throw new CloseShapeError("the transaction is not in the BEEF");
  const found = beef.findTxid(txid) ?? beef.findTxid(txid.toLowerCase());
  const tx = found?.tx ?? (found?.rawTx ? Transaction.fromBinary(found.rawTx) : undefined);
  const out = tx?.outputs[outputIndex];
  if (!tx || !out) throw new CloseShapeError("the transaction is not in the BEEF");
  return { txid, vout: outputIndex, satoshis: out.satoshis ?? 0, script: out.lockingScript, sourceTransaction: tx };
}

/** Steps 2-3 (see the module comment): the wallet's action, broadcast by the wallet. */
export async function prepareClose(i: CloseInput): Promise<PreparedClose> {
  const { wallet } = i;
  const poolUtxo = poolFromBeef(i.poolOutput.beef, i.poolOutput.outputIndex, i.txid);
  const pool = PoolTemplate.decode(poolUtxo.script);
  if (!pool) throw new CloseShapeError("the output is not a pool");
  if (i.lpKey.counterparty !== "self") throw new CloseShapeError(`the wallet key ${i.lpKey.keyID} is not a key to self`);
  const lpArgs = { protocolID: i.lpKey.protocolID, keyID: i.lpKey.keyID, counterparty: i.lpKey.counterparty };
  const { publicKey: lpPub } = await wallet.getPublicKey({ ...lpArgs, forSelf: true });
  if (PublicKey.fromString(lpPub).toString() !== pool.state.lpPubKey) throw new CloseShapeError(`the wallet key ${i.lpKey.keyID} is not this pool's LP key`);

  const sdkId = sdkTokenId(i.tokenId);
  const sym = i.meta?.sym ?? "token";
  const me = await identityKeyOf(wallet);
  const k = await newReceivingKey(wallet, sdkId, me);
  const tokenScript = tokenP2pkhScript(sdkId, pool.state.tokenReserve, k.publicKey);
  const plan = PoolTemplate.planClose({ pool: poolUtxo, outputs: [{ satoshis: 1n, script: tokenScript }] });
  const spendTxid = i.txid ?? poolUtxo.txid;
  const poolOutpoint = `${spendTxid}.${poolUtxo.vout}`;
  const lpSigner = async (sighash: number[]) => (await wallet.createSignature({ ...lpArgs, hashToDirectlySign: sighash })).signature;

  const signed = await runAppSignedAction(
    wallet,
    {
      description: describe(`AMM close: ${sym}`),
      inputBEEF: Beef.fromBinary(i.poolOutput.beef).toBinary(),
      inputs: [{ outpoint: poolOutpoint, unlockingScriptLength: PoolTemplate.maxCallUnlockLength(plan), inputDescription: describe(`The ${sym} pool`) }],
      outputs: [{ lockingScript: tokenScript, satoshis: 1, outputDescription: describe(`${sym} pool tokens to you`) }],
      labels: [...transferPlanLabels(sdkId, { ownedOutputs: [{ outputIndex: 0, ...k.receipt }] }), "amm-close"],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    async (tx) => {
      // The contract reads input 0 (the preimage is input 0's); the wallet places named inputs first.
      if (inputIndexOf(tx, spendTxid, poolUtxo.vout) !== 0) throw new CloseShapeError("the wallet did not place the pool as input 0");
      if (tx.outputs[0]?.lockingScript.toHex() !== tokenScript || tx.outputs[0]?.satoshis !== 1) throw new CloseShapeError("the wallet moved output 0 of the close");
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
    tokenOutput: { outputIndex: 0, lockingScript: tokenScript },
    sats: BigInt(poolUtxo.satoshis),
    tokenAmount: pool.state.tokenReserve,
  };
}

/** The `x-topics` header of a BRC-22 submit (D14): the topics as a JSON array, `["tm_color_<assetId>"]`. */
export function xTopics(topics: string[]): string {
  return JSON.stringify(topics);
}

/** BRC-22's STEAK: per topic, the outputs admitted and the coins retained and removed. */
export type Steak = Record<string, { outputsToAdmit: number[]; coinsToRetain: number[]; coinsRemoved: number[] }>;

/**
 * Submit to the exchange (BRC-22; skein-overlay 0.9.1, docs/OVERLAY.md "Submitting"): 0.34.0 (D19,
 * David Case 2026-11-04): `POST <origin>/submit` at the HOST ROOT of `base` (`x-topics` the token
 * topic, which the host routes to the instance serving it; the body the BEEF) — no token list read
 * for an instance base — waits on the submission and
 * answers the STEAK; 503 with Retry-After when nothing is decided within the host's bound (the
 * submission stands: `steak` absent). Plain `fetch`, unsigned (0.6.3; David 2026-10-08: "We
 * shouldn't be using authfetch for the submit http method."): the front door (shruggr/skein#135)
 * admits an unsigned POST at the overlay's `submit` row (sender `*`, filter `beef`), and
 * `@bsv/sdk`'s AuthFetch refuses the `x-topics` header client-side. 0.38.0 (D14): `x-topics` is
 * the BRC-22 JSON array (`xTopics`), the one form the client sends (the host takes a comma list too).
 */
export async function submitToOverlay(
  base: string,
  topic: string,
  beef: number[],
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ steak?: Steak }> {
  const url = `${new URL(base).origin}/submit`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-topics": xTopics([topic]) },
    body: new Uint8Array(beef),
  });
  const text = await res.text();
  if (res.status === 503) return {};
  if (!res.ok) throw new Error(`POST ${url}: ${res.status} ${text.slice(0, 300)}`);
  let steak: unknown;
  try {
    steak = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!steak || typeof steak !== "object" || Array.isArray(steak)) throw new Error(`POST ${url}: want the STEAK, got ${text.slice(0, 300)}`);
  return { steak: steak as Steak };
}

/** The STEAK in words: the topics that admitted outputs, else "taken by no topic"; no STEAK, "not decided yet". */
export function steakText(r: { steak?: Steak }): string {
  if (!r.steak) return "not decided yet";
  const took = Object.entries(r.steak).filter(([, e]) => e.outputsToAdmit.length > 0).map(([t, e]) => `${t} (outputs ${e.outputsToAdmit.join(", ")})`);
  return took.length ? `admitted under ${took.join("; ")}` : "taken by no topic";
}
