/**
 * One swap leg through the user's BRC-100 wallet (docs/notes.md, "Swap
 * funding and signing"). The page holds no keys: every key and signature
 * comes from the wallet (`getPublicKey`, `createAction`, `createSignature`).
 *
 *   1. `planSwapLeg` (`PoolTemplate.planSwap`): the outputs the contract
 *      requires (pool, payout, LP fee, validator fee, commission) and the
 *      method arguments. The commission goes to the relay's `amm.swap.terms`
 *      address; when the relay names none and the pool's CommissionBps is
 *      nonzero, to a key of the taker's own (see "the commission" below). The
 *      leg's sats are exact: what the contract's outputs take beyond the
 *      pool's and the token inputs' sats (amount in + 1 sat per 1Color output
 *      the taker pays for), plus the miner fee of the final swap
 *      (`swapFunding`).
 *   2. **The leg's inputs** (0.29.0, David Case 2026-11-02): every one an
 *      output of the active swap basket `amm-swap` (src/market/activeSwap.ts):
 *      ONE sats output of exactly that amount (`SatsInput`) and, token → sats,
 *      the token outputs carrying exactly the amount in (`TokenInput`), staged
 *      there by one wallet send before the legs (no funding transaction, no
 *      `1sat-deposit`).
 *   3. **Swap transaction**, built here (`prepareSwap`): inputs pool
 *      (`callUnlock`, the validator's slot `OP_0`, `_changeAmount = 0`), the
 *      sats output, the token outputs; outputs exactly the contract's, no
 *      change. The sats and token inputs are signed with `createSignature`
 *      (SIGHASH_ALL|FORKID over the BIP-143 sighash computed here, under the
 *      key each input's customInstructions name) and every input but the
 *      pool's is checked with `Spend`.
 *   4. The relay (src/market/relay.ts) carries it to the validator, with the
 *      sats output's transaction as the swap's funding transaction (its
 *      AtomicBEEF, from the wallet).
 *   5. Accepted: `completeSwap` internalizes the payout (sats: BRC-29 wallet
 *      payment; tokens, 0.12.0: the output is locked to a BRC-207 module
 *      receiving key whose sender is the pool's validator, taken in with a
 *      basket insertion into `p color <assetTag>` and the receipt,
 *      src/wallet/color.ts), and the commission when it is the taker's own
 *      (same two forms). No relinquishOutput (0.29.0): the wallet marks the
 *      `amm-swap` outputs the swap spends spent when it takes the swap in.
 *      Refused / timed out: nothing to undo; the leg's outputs stay in
 *      `amm-swap` for a later swap.
 */
import {
  Beef,
  Hash,
  LockingScript,
  PublicKey,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type InternalizeOutput,
  type WalletInterface,
  type WalletProtocol,
} from "@bsv/sdk";
import type { Direction, Leg, PoolState } from "@amm-poc/matching-engine";
import { PoolTemplate, decodeOneColor, type CallPlan, type PoolUtxo } from "../pool";
import type { LookupOutput } from "../lib/overlay";
import { isPoolRow } from "../lp/poolRows";
import { basketBeef } from "../lp/wallet";
import { outpointText, parseOutpoint, parseTokenId, sdkTokenId } from "../lib/tokenId";
import { payoutId, type PendingPayout } from "../wallet/pendingPayouts";
import { WALLET_PAYMENT, identityKeyOf, newBrc29Payout, type Brc29Payout } from "../wallet/brc29";
import { SWAP_BASKET, newReceivingKey, receiptOutput, type ColorReceipt } from "../wallet/color";

/** A P2PKH unlocking script's upper bound: push(DER ≤ 72 + sighash byte) + push(33-byte key). */
export const P2PKH_UNLOCK_LENGTH = 108;
/** How long the relay may take (the swap's `expires`). */
export const SWAP_TTL_MS = 2 * 60_000;

/** BRC-100 descriptions are 5-50 characters. */
function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

const toHex = (b: number[]) => Utils.toHex(b);

export class LegShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegShapeError";
  }
}

// ---------------------------------------------------------------------------
// Token inputs (token → sats)
// ---------------------------------------------------------------------------

/** An `amm-swap` basket output the wallet can sign: a 1Color value output of the token, with its key. */
export interface TokenInput {
  /** `txid.vout` (BRC-100 outpoint form). */
  outpoint: string;
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
  amount: bigint;
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
}

/** The token's 32-byte wire id (internal byte order) for a token with a 32-byte id (`<txid>_0`; `<txid>` and `<txid>.0` read the same). */
export function assetIdOf(tokenId: string): string {
  const r = parseTokenId(tokenId);
  if (!r || r.vout !== 0) throw new Error(`pools exist only for 32-byte ids (<txid>_0), not ${tokenId}`);
  return toHex(Utils.toArray(r.txid, "hex").reverse());
}

/**
 * The basket rows usable as token inputs for `tokenId`: 1Color value outputs
 * with this 32-byte id (the pool template counts only those) whose
 * customInstructions name the key (protocolID, keyID).
 */
export function tokenInputsOf(
  rows: { outpoint: string; satoshis: number; lockingScript?: string; tags?: string[]; customInstructions?: string }[],
  tokenId: string,
): TokenInput[] {
  const assetId = assetIdOf(tokenId);
  const out: TokenInput[] = [];
  for (const r of rows) {
    // A pool the wallet holds as LP carries the same 1Color prefix; it is not a token input.
    if (!r.lockingScript || isPoolRow(r)) continue;
    const t = decodeOneColor(Utils.toArray(r.lockingScript, "hex"));
    if (!t || t.role !== "value" || !t.idBytes || toHex(Array.from(t.idBytes)) !== assetId) continue;
    let ci: { protocolID?: unknown; keyID?: unknown; counterparty?: unknown } = {};
    try {
      ci = JSON.parse(r.customInstructions ?? "{}");
    } catch {
      continue;
    }
    if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string") continue;
    const op = parseOutpoint(r.outpoint);
    if (!op) continue;
    out.push({
      outpoint: `${op.txid}.${op.vout}`,
      txid: op.txid,
      vout: op.vout,
      satoshis: r.satoshis,
      lockingScript: r.lockingScript,
      amount: t.amount,
      protocolID: ci.protocolID as WalletProtocol,
      keyID: ci.keyID,
      counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self",
    });
  }
  return out;
}

/**
 * Token outputs summing to exactly `amount`, or null. The pool contract has
 * no token change output (Pool.runar.go Swap: the token inputs are the
 * amountIn), so an inexact selection cannot be spent into a swap. Fewest
 * outputs first; a bounded search.
 */
export function selectExactTokenInputs(candidates: TokenInput[], amount: bigint): TokenInput[] | null {
  const sorted = [...candidates].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)).slice(0, 24);
  for (let size = 1; size <= Math.min(sorted.length, 6); size++) {
    const pick: TokenInput[] = [];
    const walk = (from: number, left: bigint): boolean => {
      if (pick.length === size) return left === 0n;
      for (let i = from; i < sorted.length; i++) {
        if (sorted[i]!.amount > left) continue;
        pick.push(sorted[i]!);
        if (walk(i + 1, left - sorted[i]!.amount)) return true;
        pick.pop();
      }
      return false;
    };
    if (walk(0, amount)) return pick;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sats inputs (0.29.0)
// ---------------------------------------------------------------------------

/** An `amm-swap` sats output (customInstructions `{sats: true, protocolID, keyID, counterparty}`): a plain P2PKH to an "amm swap" key. */
export interface SatsInput {
  /** `txid.vout` */
  outpoint: string;
  txid: string;
  vout: number;
  satoshis: number;
  lockingScript: string;
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
}

const P2PKH_RE = /^76a914[0-9a-f]{40}88ac$/i;

/** The basket rows usable as a leg's sats: plain P2PKH outputs whose customInstructions say `sats: true` and name the key. */
export function satsInputsOf(rows: { outpoint: string; satoshis: number; lockingScript?: string; customInstructions?: string }[]): SatsInput[] {
  const out: SatsInput[] = [];
  for (const r of rows) {
    if (!r.lockingScript || !P2PKH_RE.test(r.lockingScript)) continue;
    let ci: { sats?: unknown; protocolID?: unknown; keyID?: unknown; counterparty?: unknown } = {};
    try {
      ci = JSON.parse(r.customInstructions ?? "{}");
    } catch {
      continue;
    }
    if (ci.sats !== true || !Array.isArray(ci.protocolID) || typeof ci.keyID !== "string") continue;
    const op = parseOutpoint(r.outpoint);
    if (!op) continue;
    out.push({
      outpoint: `${op.txid}.${op.vout}`,
      txid: op.txid,
      vout: op.vout,
      satoshis: r.satoshis,
      lockingScript: r.lockingScript,
      protocolID: ci.protocolID as WalletProtocol,
      keyID: ci.keyID,
      counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self",
    });
  }
  return out;
}

/** The sats twin of `selectExactTokenInputs`: one output of exactly `satoshis` (the leg has no change), or null. */
export function selectExactSatsInput(candidates: SatsInput[], satoshis: number): SatsInput | null {
  return candidates.find((c) => c.satoshis === satoshis) ?? null;
}

/** The pool output from the lookup's BEEF, as the template's PoolUtxo. */
export function poolUtxoFrom(poolOutput: LookupOutput): PoolUtxo {
  const tx = Transaction.fromAtomicBEEF(poolOutput.beef);
  const out = tx.outputs[poolOutput.outputIndex];
  if (!out) throw new LegShapeError(`the lookup's BEEF has no output ${poolOutput.outputIndex}`);
  return { txid: tx.id("hex"), vout: poolOutput.outputIndex, satoshis: out.satoshis!, script: out.lockingScript, sourceTransaction: tx };
}

/**
 * A P2PKH (or 1Color-on-P2PKH) input signed by the wallet: BIP-143 over
 * the finished transaction under `scope` (ALL|FORKID), `createSignature` with `hashToDirectlySign`
 * (1sat-sdk's `signP2PKHInputWallet`).
 */
export async function signP2pkhWithWallet(
  wallet: WalletInterface,
  tx: Transaction,
  inputIndex: number,
  src: { satoshis: number; lockingScript: string; protocolID: WalletProtocol; keyID: string; counterparty: string },
  scope: number = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID,
): Promise<UnlockingScript> {
  const input = tx.inputs[inputIndex]!;
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID!,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: src.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, n) => n !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: LockingScript.fromHex(src.lockingScript),
    lockTime: tx.lockTime,
    scope,
  });
  const sighash = Hash.sha256(Hash.sha256(Array.from(preimage)));
  const args = { protocolID: src.protocolID, keyID: src.keyID, counterparty: src.counterparty };
  const { signature } = await wallet.createSignature({ ...args, hashToDirectlySign: Array.from(sighash) });
  const { publicKey } = await wallet.getPublicKey({ ...args, forSelf: true });
  return new UnlockingScript().writeBin([...signature, scope]).writeBin(Utils.toArray(publicKey, "hex"));
}

// ---------------------------------------------------------------------------
// The leg's sats
// ---------------------------------------------------------------------------

function varIntSize(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

/**
 * The final swap's size in bytes: the pool input at `maxCallUnlockLength`
 * (validator's signature in), `takerInputs` P2PKH inputs (the sats, tokens)
 * at 108 bytes of unlocking script, the contract's outputs, no change.
 */
export function swapTxSize(plan: CallPlan, takerInputs: number): number {
  const poolUnlock = PoolTemplate.maxCallUnlockLength(plan);
  let size = 4 + varIntSize(1 + takerInputs);
  size += 36 + varIntSize(poolUnlock) + poolUnlock + 4;
  size += takerInputs * (36 + varIntSize(P2PKH_UNLOCK_LENGTH) + P2PKH_UNLOCK_LENGTH + 4);
  size += varIntSize(plan.outputs.length);
  for (const o of plan.outputs) {
    const len = o.script.length / 2;
    size += 8 + varIntSize(len) + len;
  }
  return size + 4;
}

export interface SwapFunding {
  /** The leg's sats output's exact amount (0.29.0: an `amm-swap` output). */
  satoshis: number;
  /** What the contract's outputs take beyond the pool's and the token inputs' sats. */
  outputs: number;
  fee: number;
  size: number;
  satsPerKb: number;
}

/**
 * The leg's exact sats: Σ contract outputs − pool sats − token inputs' sats
 * (sats in: amount in + 1 for the token payout, the fees and the commission
 * being part of amount in; tokens in: 1 per 1Color fee or commission output
 * − the token inputs' sats), plus
 * ceil(size × rate / 1000) for the final swap.
 */
export function swapFunding(plan: CallPlan, tokenInputs: { satoshis: number }[], satsPerKb: number): SwapFunding {
  const outSum = plan.outputs.reduce((a, o) => a + o.satoshis, 0n);
  const tokenSats = tokenInputs.reduce((a, t) => a + BigInt(t.satoshis), 0n);
  const outputs = Number(outSum - BigInt(plan.poolUtxo.satoshis) - tokenSats);
  const size = swapTxSize(plan, 1 + tokenInputs.length);
  const fee = Math.ceil((size * satsPerKb) / 1000);
  return { satoshis: Math.max(1, outputs + fee), outputs, fee, size, satsPerKb };
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

export interface PlanLegInput {
  wallet: WalletInterface;
  /** `<txid>_0` (src/lib/tokenId.ts). */
  tokenId: string;
  meta?: { sym?: string; dec?: number };
  direction: Direction;
  leg: Leg;
  pool: PoolState;
  /** The lookup's `{outpoint, beef: true}` answer for `leg.outpoint`. */
  poolOutput: LookupOutput;
  /**
   * The relay's commission address (`amm.swap.terms`, hash160 hex), or null
   * when the relay names none: a pool with a nonzero CommissionBps then pays
   * the commission to a fresh key of the taker's own.
   */
  commissionPkh: string | null;
  /**
   * token → sats: the token inputs carrying exactly `leg.amountIn`, or (0.29.0) what they will be
   * once staged: one output of 1 sat per leg (`sendToSwapBasket`). Their count and sats size the
   * leg's sats.
   */
  tokenInputs?: Pick<TokenInput, "satoshis" | "amount">[];
  /** sats per 1000 bytes (`VITE_FEE_RATE`). */
  satsPerKb: number;
}

/** Step 1: the leg's plan, payout keys and exact sats (`funding.satoshis`: the `amm-swap` sats output the leg spends). */
export interface PlannedLeg {
  /** The pool outpoint `<txid>_<vout>`. */
  pool: string;
  validator: string;
  bsvIn: boolean;
  poolUtxo: PoolUtxo;
  plan: CallPlan;
  funding: SwapFunding;
  payout: SwapPayout;
  commission: SwapCommission;
}

export interface PrepareSwapInput extends PlanLegInput {
  /** token → sats: `amm-swap` outputs carrying exactly `leg.amountIn`. */
  tokenInputs?: TokenInput[];
  /** The leg's `amm-swap` sats output: exactly the planned `funding.satoshis` (0.29.0). */
  satsInput: SatsInput;
  /** The swap basket's source transactions: the sats and token inputs' (default: `amm-swap`'s, from the wallet). */
  holdingBeef?: Beef;
  /** Step 1 already done (`planSwapLeg` over the same input); planned here when absent. */
  planned?: PlannedLeg;
  now?: number;
  ttlMs?: number;
}

export type SwapPayout =
  | { kind: "color"; outputIndex: number; satoshis: number; lockingScript: string; receipt: ColorReceipt }
  | ({ kind: "brc29" } & Brc29Payout);

export interface PreparedSwap {
  /** The pool outpoint `<txid>_<vout>`. */
  pool: string;
  validator: string;
  expires: number;
  plan: CallPlan;
  funding: SwapFunding & {
    /** The leg's `amm-swap` sats output (input 1). */
    input: SatsInput;
    /** Its transaction as the wallet's AtomicBEEF: the swap's funding transaction, what the relay is sent. */
    atomicBeef: number[];
    txid: string;
    /** `txid.vout` */
    outpoint: string;
  };
  /** Every input signed except the pool's validator slot. */
  swap: Transaction;
  tokenInputs: TokenInput[];
  payout: SwapPayout;
  commission: SwapCommission;
}

/** The leg's commission (the pool's CommissionBps of amount in, in the input asset). */
export interface SwapCommission {
  /** 0 when the pool's CommissionBps is 0: no output. */
  amount: bigint;
  /** Swap's `commissionPkh` (pushed even when there is no output). */
  pkh: string;
  /** "relay": the relay's address; "own": the taker's key, internalized with the payout; "none": no output. */
  to: "relay" | "own" | "none";
  /** "own" only: the wallet's record of the commission output. */
  payout?: SwapPayout;
}

const ZERO_PKH = "00".repeat(20);

/** Step 1 (see the module comment). Throws `PoolBuildError` / `LegShapeError`; nothing is created in the wallet but payout keys. */
export async function planSwapLeg(i: PlanLegInput): Promise<PlannedLeg> {
  const { wallet, leg, pool } = i;
  const bsvIn = i.direction === "bsvToToken";
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  if (`${poolUtxo.txid}_${poolUtxo.vout}` !== leg.outpoint) {
    throw new LegShapeError(`the pool moved: the lookup's tip is ${poolUtxo.txid}.${poolUtxo.vout}, the plan priced ${outpointText(leg.outpoint)}`);
  }
  const tokenInputs = i.tokenInputs ?? [];
  const tokensIn = tokenInputs.reduce((a, t) => a + t.amount, 0n);
  if (bsvIn ? tokenInputs.length > 0 : tokensIn !== leg.amountIn) {
    throw new LegShapeError(`token inputs carry ${tokensIn}, the leg needs exactly ${bsvIn ? 0n : leg.amountIn}`);
  }

  const decoded = PoolTemplate.decode(poolUtxo.script);
  const poolArgs = decoded?.args;
  if (!decoded || !poolArgs) throw new LegShapeError(`${outpointText(leg.outpoint)} is not a pool output`);
  const commissionAmount = (leg.amountIn * poolArgs.commissionBps + 9999n) / 10000n;
  const commissionTo: SwapCommission["to"] = commissionAmount === 0n ? "none" : i.commissionPkh ? "relay" : "own";

  // The payout key: tokens to a module receiving key from the pool's validator (0.12.0), sats as a BRC-29 payment to self.
  // The taker's own commission (in the input asset) is keyed the same way, the other way round.
  const identity = !bsvIn || commissionTo === "own" ? await identityKeyOf(wallet) : "";
  // The module's asset id form, `<txid>_0`.
  const sdkId = sdkTokenId(i.tokenId);
  const validatorIdentity = decoded.state.validatorIdentity;
  const brc29 = bsvIn ? null : await newBrc29Payout(wallet, identity);
  const tokenKey = bsvIn ? await newReceivingKey(wallet, sdkId, validatorIdentity) : null;
  const payoutKey = brc29 ? brc29.publicKey : tokenKey!.publicKey;
  const userPkh = toHex(PublicKey.fromString(payoutKey).toHash() as number[]);

  let ownCommission: { brc29: Awaited<ReturnType<typeof newBrc29Payout>> | null; token: Awaited<ReturnType<typeof newReceivingKey>> | null; pkh: string } | null = null;
  if (commissionTo === "own") {
    const own = bsvIn ? await newBrc29Payout(wallet, identity) : null;
    const token = bsvIn ? null : await newReceivingKey(wallet, sdkId, validatorIdentity);
    const key = own ? own.publicKey : token!.publicKey;
    ownCommission = { brc29: own, token, pkh: toHex(PublicKey.fromString(key).toHash() as number[]) };
  }
  const commissionPkh = ownCommission?.pkh ?? i.commissionPkh ?? ZERO_PKH;

  const plan = PoolTemplate.planSwap({
    pool: poolUtxo,
    amountIn: leg.amountIn,
    bsvIn,
    userPkh,
    commissionPkh,
    expect: {
      bsvReserve: pool.bsvReserve,
      tokenReserve: pool.tokenReserve,
      lpFeeBps: pool.liquidityFeeBps,
      validatorFeeBps: pool.validationFeeBps,
      commissionBps: pool.commissionBps,
      lpFee: leg.liquidityFee,
      validatorFee: leg.validationFee,
      commission: leg.commission,
      amountOut: leg.amountOut,
    },
  });

  const payout: SwapPayout = brc29
    ? { kind: "brc29", outputIndex: 1, satoshis: Number(plan.outputs[1]!.satoshis), lockingScript: plan.outputs[1]!.script, remittance: brc29.remittance }
    : { kind: "color", outputIndex: 1, satoshis: Number(plan.outputs[1]!.satoshis), lockingScript: plan.outputs[1]!.script, receipt: tokenKey!.receipt };

  // The commission is the last output when there is one (Pool.runar.go Swap).
  const commission: SwapCommission = { amount: commissionAmount, pkh: commissionPkh, to: commissionTo };
  if (ownCommission) {
    const at = plan.outputs.length - 1;
    const out = plan.outputs[at]!;
    commission.payout = ownCommission.brc29
      ? { kind: "brc29", outputIndex: at, satoshis: Number(out.satoshis), lockingScript: out.script, remittance: ownCommission.brc29.remittance }
      : { kind: "color", outputIndex: at, satoshis: Number(out.satoshis), lockingScript: out.script, receipt: ownCommission.token!.receipt };
  }

  return { pool: leg.outpoint, validator: pool.validatorIdentityKey, bsvIn, poolUtxo, plan, funding: swapFunding(plan, tokenInputs, i.satsPerKb), payout, commission };
}

/** Steps 1 (unless `planned` is given) and 3 (see the module comment). Throws `PoolBuildError` / `LegShapeError`; the wallet is left as it was. */
export async function prepareSwap(i: PrepareSwapInput): Promise<PreparedSwap> {
  const { wallet } = i;
  const planned = i.planned ?? (await planSwapLeg(i));
  const { plan, poolUtxo } = planned;
  const tokenInputs = i.tokenInputs ?? [];
  const tokensIn = tokenInputs.reduce((a, t) => a + t.amount, 0n);
  if (planned.bsvIn ? tokenInputs.length > 0 : tokensIn !== i.leg.amountIn) {
    throw new LegShapeError(`token inputs carry ${tokensIn}, the leg needs exactly ${planned.bsvIn ? 0n : i.leg.amountIn}`);
  }
  // The leg's sats were sized for these token inputs: the same count and sats, or the fee is off.
  const amounts = swapFunding(plan, tokenInputs, i.satsPerKb);
  if (amounts.satoshis !== planned.funding.satoshis) throw new LegShapeError(`the token inputs need ${amounts.satoshis} sats with the leg, it was planned with ${planned.funding.satoshis}`);
  const sats = i.satsInput;
  if (sats.satoshis !== amounts.satoshis) throw new LegShapeError(`the swap basket's sats output ${sats.outpoint} holds ${sats.satoshis} sats, the leg needs exactly ${amounts.satoshis}`);

  // The inputs' source transactions: the active swap basket's.
  const beef = i.holdingBeef ?? (await basketBeef(wallet, SWAP_BASKET));
  if (!beef) throw new LegShapeError("the wallet returned no BEEF for the swap basket");
  for (const t of [sats, ...tokenInputs]) if (!beef.findTxid(t.txid)) throw new LegShapeError(`the wallet's BEEF lacks the swap basket output ${t.outpoint}`);
  const sourceOf = (txid: string) => beef.findAtomicTransaction(txid) ?? beef.findTxid(txid)!.tx!;

  // Step 3: the swap transaction.
  const swap = new Transaction();
  swap.version = 1;
  swap.lockTime = 0;
  swap.addInput({ sourceTXID: poolUtxo.txid, sourceOutputIndex: poolUtxo.vout, sourceTransaction: poolUtxo.sourceTransaction, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  swap.addInput({ sourceTXID: sats.txid, sourceOutputIndex: sats.vout, sourceTransaction: sourceOf(sats.txid), unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const t of tokenInputs) swap.addInput({ sourceTXID: t.txid, sourceOutputIndex: t.vout, sourceTransaction: sourceOf(t.txid), unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const o of plan.outputs) swap.addOutput({ satoshis: Number(o.satoshis), lockingScript: LockingScript.fromHex(o.script) });

  swap.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(plan, swap, null).unlockingScript;
  swap.inputs[1]!.unlockingScript = await signP2pkhWithWallet(wallet, swap, 1, sats);
  for (const [n, t] of tokenInputs.entries()) swap.inputs[n + 2]!.unlockingScript = await signP2pkhWithWallet(wallet, swap, n + 2, t);
  for (let n = 1; n < swap.inputs.length; n++) {
    if (!spendValid(swap, n)) throw new LegShapeError(`input ${n} of the swap does not validate`);
  }

  return {
    pool: planned.pool,
    validator: planned.validator,
    expires: (i.now ?? Date.now()) + (i.ttlMs ?? SWAP_TTL_MS),
    plan,
    funding: { ...amounts, input: sats, atomicBeef: beef.toBinaryAtomic(sats.txid), txid: sats.txid, outpoint: sats.outpoint },
    swap,
    tokenInputs,
    payout: planned.payout,
    commission: planned.commission,
  };
}

/** @bsv/sdk's `Spend` over input `n` of `tx` (its source output from `sourceTransaction`). */
export function spendValid(tx: Transaction, n: number): boolean {
  const inp = tx.inputs[n]!;
  const src = inp.sourceTransaction?.outputs[inp.sourceOutputIndex];
  if (!src) return false;
  try {
    return new Spend({
      sourceTXID: inp.sourceTXID ?? inp.sourceTransaction!.id("hex"),
      sourceOutputIndex: inp.sourceOutputIndex,
      sourceSatoshis: src.satoshis!,
      lockingScript: src.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== n),
      outputs: tx.outputs,
      inputIndex: n,
      unlockingScript: inp.unlockingScript!,
      inputSequence: inp.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// After the relay's answer
// ---------------------------------------------------------------------------

/**
 * The validator's final transaction, checked against ours: same inputs (in
 * order, the taker's unlocking scripts unchanged), same outputs; only input
 * 0's unlocking script (the validator's slot) differs. Its inputs get our
 * source transactions, so it serializes as AtomicBEEF.
 */
export function finalSwapOf(p: PreparedSwap, raw: number[], txid?: string): Transaction {
  return finalCallOf(p.swap, raw, txid, "the swap we built");
}

/**
 * A validator-signed pool call checked against the one we built (`ours`):
 * same inputs in order with our unlocking scripts on every input but the
 * pool's (input 0), same outputs. Shared by the swap and AddLiquidity.
 */
export function finalCallOf(ours: Transaction, raw: number[], txid: string | undefined, what: string): Transaction {
  let tx: Transaction;
  try {
    tx = Transaction.fromBinary(raw);
  } catch {
    tx = Transaction.fromBEEF(raw);
  }
  if (txid && tx.id("hex") !== txid) throw new LegShapeError(`the relay's transaction is ${tx.id("hex")}, not ${txid}`);
  const same =
    tx.inputs.length === ours.inputs.length &&
    tx.outputs.length === ours.outputs.length &&
    tx.inputs.every((inp, n) => {
      const o = ours.inputs[n]!;
      const src = inp.sourceTXID ?? inp.sourceTransaction?.id("hex");
      return src === o.sourceTXID && inp.sourceOutputIndex === o.sourceOutputIndex && (n === 0 || inp.unlockingScript?.toHex() === o.unlockingScript!.toHex());
    }) &&
    tx.outputs.every((out, n) => out.satoshis === ours.outputs[n]!.satoshis && out.lockingScript.toHex() === ours.outputs[n]!.lockingScript.toHex());
  if (!same) throw new LegShapeError(`the relay's transaction is not ${what}`);
  tx.inputs.forEach((inp, n) => {
    inp.sourceTransaction = ours.inputs[n]!.sourceTransaction;
    inp.sourceTXID = ours.inputs[n]!.sourceTXID;
  });
  return tx;
}

export interface CompletedSwap {
  txid: string;
  internalized: boolean;
  /** Internalize errors (the swap itself is final). */
  errors: string[];
}

/**
 * Accepted: the wallet takes the payout in (`internalizeAction`). No
 * relinquishOutput (0.29.0, David Case 2026-11-02: "Anything we internalize
 * should relinquish outputs itself"): taking the swap in marks the wallet's
 * outputs it spends — the `amm-swap` sats and token inputs — spent
 * (wallet-toolbox `markUserInputsSpent`).
 */
export async function completeSwap(wallet: WalletInterface, p: PreparedSwap, raw: number[], txid?: string): Promise<CompletedSwap> {
  const final = finalSwapOf(p, raw, txid);
  const out: CompletedSwap = { txid: final.id("hex"), internalized: false, errors: [] };
  const outputs: InternalizeOutput[] = [internalizeOutputOf(p.payout)];
  if (p.commission.payout) outputs.push(internalizeOutputOf(p.commission.payout));
  try {
    const r = await wallet.internalizeAction({
      tx: final.toAtomicBEEF(true),
      outputs,
      description: p.payout.kind === "brc29" ? "AMM swap payout" : "AMM swap tokens",
      labels: ["amm-swap"],
    });
    out.internalized = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

function internalizeOutputOf(o: SwapPayout): InternalizeOutput {
  return o.kind === "brc29" ? { outputIndex: o.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...o.remittance } } : receiptOutput(o.outputIndex, o.receipt);
}

/**
 * The pending-payout records of the swap's outputs to the taker (the payout,
 * and the taker's own commission): sats with their BRC-29 remittance, tokens
 * with their module receipt (0.12.0). Written before the swap is submitted;
 * their txid is provisional: the validator's signature changes it.
 */
export function pendingSwapPayouts(p: PreparedSwap, tokenId: string, now = Date.now()): PendingPayout[] {
  const txid = p.swap.id("hex");
  const out: PendingPayout[] = [];
  for (const [o, description] of [[p.payout, "AMM swap payout"], [p.commission.payout, "AMM swap commission"]] as const) {
    if (!o) continue;
    out.push({
      id: payoutId(txid, o.outputIndex),
      kind: "swap",
      txid,
      vout: o.outputIndex,
      satoshis: o.satoshis,
      lockingScript: o.lockingScript,
      ...(o.kind === "brc29" ? { remittance: o.remittance } : { receipt: o.receipt }),
      final: false,
      tokenId,
      description,
      createdAt: now,
    });
  }
  return out;
}
