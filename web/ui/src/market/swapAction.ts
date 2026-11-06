/**
 * One swap leg through the user's BRC-100 wallet (docs/notes.md, "Swap funding and signing";
 * 0.40.0, agent-env plans/swap-balance-build-2026-11-05.md §0 7, Builder 2 item 3). The page holds
 * no keys: every key and signature comes from the wallet (`getPublicKey`, `createSignature`).
 *
 *   1. **The leg's inputs** (`selectLegInputs`): every one an `amm-swap` row (src/market/activeSwap.ts)
 *      — the pool, then as many sats rows as cover the leg's sats (largest first), then (a sell) as
 *      many token rows as cover `amountIn` (largest first). The leg's sats (`legNeed`): what the
 *      contract's outputs take beyond the pool's and the token inputs' sats, plus the miner fee of
 *      the final transaction at the rate (`swapTxSize`, the sats change output counted).
 *   2. **The outputs**: the contract's (pool, payout, LP fee, validator fee, commission, then the
 *      token change = token inputs − `amountIn` when > 0), then Rúnar's sats change = sats inputs −
 *      the need when ≥ 1 (`_changePKH`, `_changeAmount`); under 1, no change output.
 *   3. **The keys** (`prepareSwap`): the payout (and the taker's own commission) under ONE
 *      derivation per ORDER (`legDerivation` of the order's key input: the first leg's first token
 *      input on a sell, its first sats input on a buy), every leg of the order the same; a token
 *      payout to a module receiving key for SELF (sender the user's identity). The change: a leg
 *      that is not the order's last → keys under `SWAP_PROTOCOL` (self), keyID
 *      `amm-swap-<txid>.<vout>:change` of the leg's first input of that kind (`changeKeyID`), taken
 *      into `amm-swap` with the order's key input in its customInstructions; the LAST leg (it takes
 *      all that remains) → the WALLET: sats to a BRC-29 key of the user's, tokens to a module
 *      receiving key for self, both `legDerivation(order, "change")`.
 *   4. The host's relay (src/market/relay.ts, `POST /@<tokenId>/amm/swap`, 0.44.0) carries it to the validator with the first sats input's
 *      transaction as the swap's funding transaction: ONE BEEF of every staged input's source,
 *      its subject that transaction (0.40.1, `fundingBeef`).
 *   5. Accepted: `completeSwap` takes in, in ONE `internalizeAction`, the payout, the commission
 *      when it is the taker's own, and the change. No relinquishOutput: taking the swap in marks the
 *      `amm-swap` rows it spends spent.
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
import type { Direction, Leg, PoolState } from "@dcasegr/amm-engine";
import { PoolTemplate, decodeOneColor, type CallPlan, type PoolUtxo } from "../pool/index.js";
import type { LookupOutput } from "../lib/overlay.js";
import { isPoolRow } from "../lp/poolRows.js";
import { basketBeef } from "../lp/wallet.js";
import { outpointText, parseOutpoint, parseTokenId, sdkTokenId } from "../lib/tokenId.js";
import { WALLET_PAYMENT, identityKeyOf, newBrc29Payout, p2pkhHexOf, type PaymentRemittance } from "../wallet/brc29.js";
import { SWAP_BASKET, SWAP_PROTOCOL, newReceivingKey, receiptOutput, swapInstructions, swapSatsInstructions, type ColorReceipt } from "../wallet/color.js";

/** A P2PKH unlocking script's upper bound: push(DER ≤ 72 + sighash byte) + push(33-byte key). */
export const P2PKH_UNLOCK_LENGTH = 108;

const toHex = (b: number[]) => Utils.toHex(b);

export class LegShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegShapeError";
  }
}

// ---------------------------------------------------------------------------
// The swap basket's rows
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
  /** 0.40.0: the order whose change it is (its key input, `<txid>.<vout>`); a staged row has none. */
  order?: string;
}

/** The token's 32-byte wire id (internal byte order) for a token with a 32-byte id (`<txid>_0`; `<txid>` and `<txid>.0` read the same). */
export function assetIdOf(tokenId: string): string {
  const r = parseTokenId(tokenId);
  if (!r || r.vout !== 0) throw new Error(`pools exist only for 32-byte ids (<txid>_0), not ${tokenId}`);
  return toHex(Utils.toArray(r.txid, "hex").reverse());
}

type Row = { outpoint: string; satoshis: number; lockingScript?: string; tags?: string[]; customInstructions?: string };

function keyOf(r: Row): { protocolID: WalletProtocol; keyID: string; counterparty: string; order?: string; sats?: boolean } | null {
  let ci: { protocolID?: unknown; keyID?: unknown; counterparty?: unknown; order?: unknown; sats?: unknown } = {};
  try {
    ci = JSON.parse(r.customInstructions ?? "{}");
  } catch {
    return null;
  }
  if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string") return null;
  return {
    protocolID: ci.protocolID as WalletProtocol,
    keyID: ci.keyID,
    counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self",
    ...(typeof ci.order === "string" ? { order: ci.order } : {}),
    ...(ci.sats === true ? { sats: true } : {}),
  };
}

/**
 * The basket rows usable as token inputs for `tokenId`: 1Color value outputs
 * with this 32-byte id (the pool template counts only those) whose
 * customInstructions name the key (protocolID, keyID).
 */
export function tokenInputsOf(rows: Row[], tokenId: string): TokenInput[] {
  const assetId = assetIdOf(tokenId);
  const out: TokenInput[] = [];
  for (const r of rows) {
    // A pool the wallet holds as LP carries the same 1Color prefix; it is not a token input.
    if (!r.lockingScript || isPoolRow(r)) continue;
    const t = decodeOneColor(Utils.toArray(r.lockingScript, "hex"));
    if (!t || t.role !== "value" || !t.idBytes || toHex(Array.from(t.idBytes)) !== assetId) continue;
    const k = keyOf(r);
    const op = parseOutpoint(r.outpoint);
    if (!k || !op) continue;
    out.push({
      outpoint: `${op.txid}.${op.vout}`,
      txid: op.txid,
      vout: op.vout,
      satoshis: r.satoshis,
      lockingScript: r.lockingScript,
      amount: t.amount,
      protocolID: k.protocolID,
      keyID: k.keyID,
      counterparty: k.counterparty,
      ...(k.order ? { order: k.order } : {}),
    });
  }
  return out;
}

/** An `amm-swap` sats output (customInstructions `{sats: true, protocolID, keyID, counterparty, order?}`): a plain P2PKH to an "amm swap" key. */
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
  /** 0.40.0: the order whose change it is (its key input); a staged row has none. */
  order?: string;
}

const P2PKH_RE = /^76a914[0-9a-f]{40}88ac$/i;

/** The basket rows usable as a leg's sats: plain P2PKH outputs whose customInstructions say `sats: true` and name the key. */
export function satsInputsOf(rows: Row[]): SatsInput[] {
  const out: SatsInput[] = [];
  for (const r of rows) {
    if (!r.lockingScript || !P2PKH_RE.test(r.lockingScript)) continue;
    const k = keyOf(r);
    const op = parseOutpoint(r.outpoint);
    if (!k || !k.sats || !op) continue;
    out.push({
      outpoint: `${op.txid}.${op.vout}`,
      txid: op.txid,
      vout: op.vout,
      satoshis: r.satoshis,
      lockingScript: r.lockingScript,
      protocolID: k.protocolID,
      keyID: k.keyID,
      counterparty: k.counterparty,
      ...(k.order ? { order: k.order } : {}),
    });
  }
  return out;
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

/** A P2PKH output's size: 8 (sats) + 1 (length) + 25. */
const P2PKH_OUTPUT_SIZE = 34;

/**
 * The final swap's size in bytes: the pool input at `maxCallUnlockLength`
 * (validator's signature in), `takerInputs` P2PKH inputs (the sats, tokens)
 * at 108 bytes of unlocking script, the contract's outputs, and (0.40.0) the
 * sats change output when `withChange`.
 */
export function swapTxSize(plan: CallPlan, takerInputs: number, withChange = false): number {
  const poolUnlock = PoolTemplate.maxCallUnlockLength(plan);
  let size = 4 + varIntSize(1 + takerInputs);
  size += 36 + varIntSize(poolUnlock) + poolUnlock + 4;
  size += takerInputs * (36 + varIntSize(P2PKH_UNLOCK_LENGTH) + P2PKH_UNLOCK_LENGTH + 4);
  const outs = plan.outputs.length + (withChange ? 1 : 0);
  size += varIntSize(outs);
  for (const o of plan.outputs) {
    const len = o.script.length / 2;
    size += 8 + varIntSize(len) + len;
  }
  if (withChange) size += P2PKH_OUTPUT_SIZE;
  return size + 4;
}

/** What a leg's sats inputs must cover (0.40.0). */
export interface LegNeed {
  /** What the contract's outputs take beyond the pool's and the token inputs' sats. */
  outputs: number;
  /** The miner fee with no change output, and its need (outputs + fee): what the sats inputs must cover. */
  fee: number;
  need: number;
  /** The miner fee and need with the sats change output counted. */
  feeWithChange: number;
  needWithChange: number;
  satsPerKb: number;
}

/**
 * A leg's sats need: Σ contract outputs − pool sats − token inputs' sats, plus ceil(size × rate /
 * 1000) for the final swap with `inputs` taker inputs (sats and tokens), without and with the sats
 * change output.
 */
export function legNeed(plan: CallPlan, tokenInputs: { satoshis: number }[], inputs: number, satsPerKb: number): LegNeed {
  const outSum = plan.outputs.reduce((a, o) => a + o.satoshis, 0n);
  const tokenSats = tokenInputs.reduce((a, t) => a + BigInt(t.satoshis), 0n);
  const outputs = Number(outSum - BigInt(plan.poolUtxo.satoshis) - tokenSats);
  const fee = Math.ceil((swapTxSize(plan, inputs) * satsPerKb) / 1000);
  const feeWithChange = Math.ceil((swapTxSize(plan, inputs, true) * satsPerKb) / 1000);
  return { outputs, fee, need: outputs + fee, feeWithChange, needWithChange: outputs + feeWithChange, satsPerKb };
}

// ---------------------------------------------------------------------------
// The keys
// ---------------------------------------------------------------------------

/** BRC-29 / BRC-207 derivationPrefix of a leg's payout (0.29.1): base64 of the UTF-8 text "amm swap". */
export const LEG_PAYOUT_PREFIX = Utils.toBase64(Utils.toArray("amm swap", "utf8"));
/** derivationPrefix of the taker's own commission output (0.29.1): base64 of "amm swap commission". */
export const LEG_COMMISSION_PREFIX = Utils.toBase64(Utils.toArray("amm swap commission", "utf8"));
/** derivationPrefix of an order's last leg's change to the wallet (0.40.0): base64 of "amm swap change". */
export const LEG_CHANGE_PREFIX = Utils.toBase64(Utils.toArray("amm swap change", "utf8"));

/**
 * The derivation of an order's payout keys (0.29.1; 0.40.0: ONE per ORDER). `keyInput` is the
 * order's key input, `<txid>.<vout>` (txid in display hex, lowercase): the first leg's first token
 * input on a sell, its first sats input on a buy. derivationSuffix = base64(sha256(UTF-8 of that
 * text)); derivationPrefix `LEG_PAYOUT_PREFIX` for the payout, `LEG_COMMISSION_PREFIX` for the
 * taker's own commission, `LEG_CHANGE_PREFIX` for the last leg's change to the wallet. The same
 * pair keys the BRC-29 payment (keyID "<prefix> <suffix>", sender the user) and the BRC-207 receipt
 * (`p color <assetTag> <prefixHex> <suffixHex>`, sender the user: a receipt for self).
 */
export function legDerivation(keyInput: string, which: "payout" | "commission" | "change"): { derivationPrefix: string; derivationSuffix: string } {
  return {
    derivationPrefix: which === "payout" ? LEG_PAYOUT_PREFIX : which === "commission" ? LEG_COMMISSION_PREFIX : LEG_CHANGE_PREFIX,
    derivationSuffix: Utils.toBase64(Hash.sha256(Utils.toArray(keyInput, "utf8")) as number[]),
  };
}

/** The keyID of a leg's change kept in `amm-swap` (0.40.0): `amm-swap-<txid>.<vout>:change`, the leg's first input of that kind. */
export function changeKeyID(firstInput: string): string {
  const op = parseOutpoint(firstInput);
  if (!op) throw new LegShapeError(`not an outpoint: ${firstInput}`);
  return `amm-swap-${op.txid}.${op.vout}:change`;
}

/** A swap transaction's taker inputs (every input after the pool's), each told sats or tokens by its source output (0.40.0). */
export function legInputsOf(tx: Transaction): { sats: string[]; tokens: string[] } {
  const sats: string[] = [];
  const tokens: string[] = [];
  for (const inp of tx.inputs.slice(1)) {
    const txid = inp.sourceTXID ?? inp.sourceTransaction?.id("hex");
    const src = inp.sourceTransaction?.outputs[inp.sourceOutputIndex];
    if (!txid || !src) continue;
    (decodeOneColor(src.lockingScript.toBinary()) ? tokens : sats).push(`${txid}.${inp.sourceOutputIndex}`);
  }
  return { sats, tokens };
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
  /** The pools read's `{beef, outputIndex}` for `leg.outpoint`. */
  poolOutput: LookupOutput;
  /**
   * The relay's commission address (hash160 hex), or null when the relay names none: a pool with
   * a nonzero CommissionBps then pays the commission to a key of the taker's own.
   */
  commissionPkh: string | null;
  /** sats per 1000 bytes (`VITE_FEE_RATE`). */
  satsPerKb: number;
}

const ZERO_PKH = "00".repeat(20);

/** The plan with the given payout, commission and token change addresses (`planSwap`, the leg's quote as the expectation). */
function legPlan(i: PlanLegInput, poolUtxo: PoolUtxo, userPkh: string, commissionPkh: string, tokenChange: bigint, tokenChangePkh: string) {
  const { leg, pool } = i;
  return PoolTemplate.planSwap({
    pool: poolUtxo,
    amountIn: leg.amountIn,
    bsvIn: i.direction === "bsvToToken",
    userPkh,
    commissionPkh,
    tokenChange,
    tokenChangePkh,
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
}

/** The leg's inputs (`selectLegInputs`): its sats rows and token rows, and what the sats cover. */
export interface LegInputs {
  sats: SatsInput[];
  tokens: TokenInput[];
  need: LegNeed;
}

const largestFirst = <T extends { outpoint: string }>(xs: T[], size: (x: T) => bigint): T[] =>
  [...xs].sort((a, b) => {
    const d = size(b) - size(a);
    return d > 0n ? 1 : d < 0n ? -1 : a.outpoint.localeCompare(b.outpoint);
  });

/**
 * Item 3's inputs: (a sell) as many token rows as cover `leg.amountIn`, largest first; then as many
 * sats rows as cover the leg's sats need, largest first (each sats row added grows the size). Null
 * when the rows cannot cover the leg (the staged sats or tokens ran out). The need is planned with
 * placeholder addresses (20 bytes each: the sizes are the same).
 */
export function selectLegInputs(i: PlanLegInput, sats: SatsInput[], tokens: TokenInput[]): LegInputs | null {
  const bsvIn = i.direction === "bsvToToken";
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  if (`${poolUtxo.txid}_${poolUtxo.vout}` !== i.leg.outpoint) {
    throw new LegShapeError(`the pool moved: the read's tip is ${poolUtxo.txid}.${poolUtxo.vout}, the plan priced ${outpointText(i.leg.outpoint)}`);
  }
  const pickedTokens: TokenInput[] = [];
  if (!bsvIn) {
    let held = 0n;
    for (const t of largestFirst(tokens, (x) => x.amount)) {
      if (held >= i.leg.amountIn) break;
      pickedTokens.push(t);
      held += t.amount;
    }
    if (held < i.leg.amountIn) return null;
  }
  const tokenChange = pickedTokens.reduce((a, t) => a + t.amount, 0n) - (bsvIn ? 0n : i.leg.amountIn);
  const plan = legPlan(i, poolUtxo, ZERO_PKH, i.commissionPkh ?? ZERO_PKH, tokenChange, ZERO_PKH);
  const pickedSats: SatsInput[] = [];
  let held = 0;
  for (const s of largestFirst(sats, (x) => BigInt(x.satoshis))) {
    pickedSats.push(s);
    held += s.satoshis;
    const need = legNeed(plan, pickedTokens, pickedSats.length + pickedTokens.length, i.satsPerKb);
    if (held >= need.need) return { sats: pickedSats, tokens: pickedTokens, need };
  }
  return null;
}

export interface PrepareSwapInput extends PlanLegInput {
  /** The leg's `amm-swap` rows (`selectLegInputs`). */
  inputs: LegInputs;
  /** The order's key input (`<txid>.<vout>`); absent: this is the order's first leg, its own key input. */
  order?: string;
  /** This leg takes all that remains of the order: its change goes to the wallet. */
  last: boolean;
  /** The swap basket's source transactions: the rows' (default: `amm-swap`'s, from the wallet). */
  holdingBeef?: Beef;
}

export type SwapPayout =
  | { kind: "color"; outputIndex: number; satoshis: number; lockingScript: string; receipt: ColorReceipt }
  | { kind: "brc29"; outputIndex: number; satoshis: number; lockingScript: string; remittance: PaymentRemittance }
  /** 0.40.0: a change output kept in `amm-swap` (basket insertion with its customInstructions). */
  | { kind: "basket"; outputIndex: number; satoshis: number; lockingScript: string; customInstructions: string };

export interface PreparedSwap {
  /** The pool outpoint `<txid>_<vout>`. */
  pool: string;
  validator: string;
  bsvIn: boolean;
  plan: CallPlan;
  /** The order's key input (`<txid>.<vout>`): what the payout keys are derived from. */
  order: string;
  /** Whether this leg's change went to the wallet. */
  last: boolean;
  funding: {
    /** What the relay is sent as `funding` (0.40.1, `fundingBeef`): every staged input's source with its ancestry, the subject the first sats input's transaction. */
    atomicBeef: number[];
    txid: string;
    fee: number;
    need: number;
  };
  /** Every input signed except the pool's validator slot. */
  swap: Transaction;
  satsInputs: SatsInput[];
  tokenInputs: TokenInput[];
  payout: SwapPayout;
  commission: SwapCommission;
  /** The token change output (a sell whose token rows exceed amountIn). */
  tokenChange?: SwapPayout;
  /** The sats change output (≥ 1 sat). */
  satsChange?: SwapPayout;
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

const pkhOfKey = (publicKey: string) => toHex(PublicKey.fromString(publicKey).toHash() as number[]);

/** The leg's own key input: its first token input on a sell, its first sats input on a buy. */
export function keyInputOf(inputs: Pick<LegInputs, "sats" | "tokens">, bsvIn: boolean): string {
  const k = bsvIn ? inputs.sats[0] : inputs.tokens[0];
  if (!k) throw new LegShapeError("the leg has no staged input to key its payout by");
  return k.outpoint;
}

/** BRC-95's Atomic BEEF prefix (the sdk's `ATOMIC_BEEF`), little-endian. */
const ATOMIC_BEEF_PREFIX = [0x01, 0x01, 0x01, 0x01];

/**
 * The relay's `funding` (0.40.1): ONE BEEF holding the source transaction of every staged input
 * the leg spends (sats and token rows alike, each with its ancestry as the wallet gives it), its
 * subject the funding transaction (the first sats input's). The form: an Atomic BEEF envelope
 * (the prefix and the subject's txid, as the sdk writes one) around the sdk's V2 BEEF of them all
 * — the relay's `given()` reads the envelope's subject and keeps every transaction in it; the
 * sdk's own `toBinaryAtomic` would drop the sources the subject does not descend from. The
 * relay's request BEEF to the validator is its own V2 (relay.zig `requestBeef`).
 */
export function fundingBeef(beef: Beef, fundingTxid: string, sources: string[]): number[] {
  const all = new Beef();
  for (const txid of new Set([fundingTxid, ...sources])) all.mergeBeef(beef.toBinaryAtomic(txid));
  return [...ATOMIC_BEEF_PREFIX, ...Utils.toArray(fundingTxid, "hex").reverse(), ...all.toBinary()];
}

/** Builds and signs the leg (see the module comment). Throws `PoolBuildError` / `LegShapeError`; the wallet is left as it was. */
export async function prepareSwap(i: PrepareSwapInput): Promise<PreparedSwap> {
  const { wallet, inputs } = i;
  const bsvIn = i.direction === "bsvToToken";
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  if (`${poolUtxo.txid}_${poolUtxo.vout}` !== i.leg.outpoint) throw new LegShapeError(`the pool moved: the read's tip is ${poolUtxo.txid}.${poolUtxo.vout}`);
  const tokensIn = inputs.tokens.reduce((a, t) => a + t.amount, 0n);
  if (bsvIn ? inputs.tokens.length > 0 : tokensIn < i.leg.amountIn) throw new LegShapeError(`token inputs carry ${tokensIn}, the leg needs ${bsvIn ? 0n : i.leg.amountIn}`);
  if (inputs.sats.length === 0) throw new LegShapeError("the leg has no sats row");
  const tokenChange = tokensIn - (bsvIn ? 0n : i.leg.amountIn);

  const order = i.order ?? keyInputOf(inputs, bsvIn);
  const decoded = PoolTemplate.decode(poolUtxo.script);
  if (!decoded) throw new LegShapeError(`${outpointText(i.leg.outpoint)} is not a pool output`);
  const commissionAmount = (i.leg.amountIn * decoded.args.commissionBps + 9999n) / 10000n;
  const commissionTo: SwapCommission["to"] = commissionAmount === 0n ? "none" : i.commissionPkh ? "relay" : "own";
  const identity = await identityKeyOf(wallet);
  const sdkId = sdkTokenId(i.tokenId);

  // The payout (one derivation per order; a token payout is a receipt for self).
  const pay = legDerivation(order, "payout");
  const payBrc29 = bsvIn ? null : await newBrc29Payout(wallet, identity, pay);
  const payToken = bsvIn ? await newReceivingKey(wallet, sdkId, identity, pay) : null;
  const userPkh = pkhOfKey(payBrc29 ? payBrc29.publicKey : payToken!.publicKey);
  let own: { brc29: Awaited<ReturnType<typeof newBrc29Payout>> | null; token: Awaited<ReturnType<typeof newReceivingKey>> | null; pkh: string } | null = null;
  if (commissionTo === "own") {
    const com = legDerivation(order, "commission");
    const b = bsvIn ? await newBrc29Payout(wallet, identity, com) : null;
    const t = bsvIn ? null : await newReceivingKey(wallet, sdkId, identity, com);
    own = { brc29: b, token: t, pkh: pkhOfKey(b ? b.publicKey : t!.publicKey) };
  }
  const commissionPkh = own?.pkh ?? i.commissionPkh ?? ZERO_PKH;

  // The change keys: kept in amm-swap (not the last leg) or the wallet's (the last).
  const change = legDerivation(order, "change");
  const swapKey = async (keyID: string) => (await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", forSelf: true })).publicKey;
  let tokenChangeKey: { pkh: string; out: (vout: number, script: string) => SwapPayout } | null = null;
  if (tokenChange > 0n) {
    if (i.last) {
      const k = await newReceivingKey(wallet, sdkId, identity, change);
      tokenChangeKey = { pkh: k.pkh, out: (outputIndex, lockingScript) => ({ kind: "color", outputIndex, satoshis: 1, lockingScript, receipt: k.receipt }) };
    } else {
      const keyID = changeKeyID(inputs.tokens[0]!.outpoint);
      const pub = await swapKey(keyID);
      const ci = swapInstructions({ assetId: sdkId, amount: tokenChange, protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", order });
      tokenChangeKey = { pkh: pkhOfKey(pub), out: (outputIndex, lockingScript) => ({ kind: "basket", outputIndex, satoshis: 1, lockingScript, customInstructions: ci }) };
    }
  }
  const plan = legPlan(i, poolUtxo, userPkh, commissionPkh, tokenChange, tokenChangeKey?.pkh ?? ZERO_PKH);

  // The sats change: sats inputs − the need with the change output counted, when ≥ 1.
  const held = inputs.sats.reduce((a, s) => a + s.satoshis, 0);
  const need = legNeed(plan, inputs.tokens, inputs.sats.length + inputs.tokens.length, i.satsPerKb);
  if (held < need.need) throw new LegShapeError(`the swap basket's sats rows hold ${held} sats, the leg needs ${need.need}`);
  const changeSats = held - need.needWithChange;
  let satsChange: { pkh: string; satoshis: number; payout: SwapPayout } | null = null;
  if (changeSats >= 1) {
    const at = plan.outputs.length;
    if (i.last) {
      const b = await newBrc29Payout(wallet, identity, change);
      satsChange = { pkh: pkhOfKey(b.publicKey), satoshis: changeSats, payout: { kind: "brc29", outputIndex: at, satoshis: changeSats, lockingScript: b.lockingScript, remittance: b.remittance } };
    } else {
      const keyID = changeKeyID(inputs.sats[0]!.outpoint);
      const pub = await swapKey(keyID);
      satsChange = {
        pkh: pkhOfKey(pub),
        satoshis: changeSats,
        payout: { kind: "basket", outputIndex: at, satoshis: changeSats, lockingScript: p2pkhHexOf(pub), customInstructions: swapSatsInstructions({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", order }) },
      };
    }
  }

  const payout: SwapPayout = payBrc29
    ? { kind: "brc29", outputIndex: 1, satoshis: Number(plan.outputs[1]!.satoshis), lockingScript: plan.outputs[1]!.script, remittance: payBrc29.remittance }
    : { kind: "color", outputIndex: 1, satoshis: Number(plan.outputs[1]!.satoshis), lockingScript: plan.outputs[1]!.script, receipt: payToken!.receipt };
  const commission: SwapCommission = { amount: commissionAmount, pkh: commissionPkh, to: commissionTo };
  // The commission is the last fee output when there is one (Pool.runar.go Swap), before the token change.
  if (own) {
    const at = plan.outputs.length - 1 - (tokenChange > 0n ? 1 : 0);
    const out = plan.outputs[at]!;
    commission.payout = own.brc29
      ? { kind: "brc29", outputIndex: at, satoshis: Number(out.satoshis), lockingScript: out.script, remittance: own.brc29.remittance }
      : { kind: "color", outputIndex: at, satoshis: Number(out.satoshis), lockingScript: out.script, receipt: own.token!.receipt };
  }
  const tokenChangeOut = tokenChangeKey ? tokenChangeKey.out(plan.outputs.length - 1, plan.outputs[plan.outputs.length - 1]!.script) : undefined;

  // The inputs' source transactions: the active swap basket's.
  const beef = i.holdingBeef ?? (await basketBeef(wallet, SWAP_BASKET));
  if (!beef) throw new LegShapeError("the wallet returned no BEEF for the swap basket");
  for (const t of [...inputs.sats, ...inputs.tokens]) if (!beef.findTxid(t.txid)) throw new LegShapeError(`the wallet's BEEF lacks the swap basket output ${t.outpoint}`);
  const sourceOf = (txid: string) => beef.findAtomicTransaction(txid) ?? beef.findTxid(txid)!.tx!;

  // The swap transaction.
  const swap = new Transaction();
  swap.version = 1;
  swap.lockTime = 0;
  swap.addInput({ sourceTXID: poolUtxo.txid, sourceOutputIndex: poolUtxo.vout, sourceTransaction: poolUtxo.sourceTransaction, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const t of [...inputs.sats, ...inputs.tokens]) swap.addInput({ sourceTXID: t.txid, sourceOutputIndex: t.vout, sourceTransaction: sourceOf(t.txid), unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  for (const o of plan.outputs) swap.addOutput({ satoshis: Number(o.satoshis), lockingScript: LockingScript.fromHex(o.script) });
  if (satsChange) swap.addOutput({ satoshis: satsChange.satoshis, lockingScript: LockingScript.fromHex(`76a914${satsChange.pkh}88ac`) });

  swap.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(plan, swap, satsChange ? { pkh: satsChange.pkh, satoshis: satsChange.satoshis } : null).unlockingScript;
  const rows = [...inputs.sats, ...inputs.tokens];
  for (const [n, t] of rows.entries()) swap.inputs[n + 1]!.unlockingScript = await signP2pkhWithWallet(wallet, swap, n + 1, t);
  for (let n = 1; n < swap.inputs.length; n++) {
    if (!spendValid(swap, n)) throw new LegShapeError(`input ${n} of the swap does not validate`);
  }

  const funding = inputs.sats[0]!;
  return {
    pool: i.leg.outpoint,
    validator: i.pool.validatorIdentityKey,
    bsvIn,
    plan,
    order,
    last: i.last,
    funding: { atomicBeef: fundingBeef(beef, funding.txid, [...inputs.sats, ...inputs.tokens].map((r) => r.txid)), txid: funding.txid, fee: satsChange ? need.feeWithChange : need.fee, need: need.need },
    swap,
    satsInputs: inputs.sats,
    tokenInputs: inputs.tokens,
    payout,
    commission,
    ...(tokenChangeOut ? { tokenChange: tokenChangeOut } : {}),
    ...(satsChange ? { satsChange: satsChange.payout } : {}),
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

/** The leg's outputs the wallet takes in (0.40.0): the payout, the taker's own commission, the token change, the sats change. */
export function takeInOutputs(p: Pick<PreparedSwap, "payout" | "commission" | "tokenChange" | "satsChange">): InternalizeOutput[] {
  const outs: InternalizeOutput[] = [internalizeOutputOf(p.payout)];
  if (p.commission.payout) outs.push(internalizeOutputOf(p.commission.payout));
  if (p.tokenChange) outs.push(internalizeOutputOf(p.tokenChange));
  if (p.satsChange) outs.push(internalizeOutputOf(p.satsChange));
  return outs;
}

/**
 * Accepted: the wallet takes the leg in, ONE `internalizeAction` (0.40.0: the payout, the taker's
 * own commission, the change). No relinquishOutput (0.29.0, David Case 2026-11-02: "Anything we
 * internalize should relinquish outputs itself"): taking the swap in marks the wallet's outputs
 * it spends — the `amm-swap` sats and token rows — spent (wallet-toolbox `markUserInputsSpent`).
 */
export async function completeSwap(wallet: WalletInterface, p: PreparedSwap, raw: number[], txid?: string): Promise<CompletedSwap> {
  const final = finalSwapOf(p, raw, txid);
  const out: CompletedSwap = { txid: final.id("hex"), internalized: false, errors: [] };
  try {
    const r = await wallet.internalizeAction({
      tx: final.toAtomicBEEF(true),
      outputs: takeInOutputs(p),
      description: p.payout.kind === "brc29" ? "AMM swap payout" : "AMM swap tokens",
      labels: ["amm-swap"],
    });
    out.internalized = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

export function internalizeOutputOf(o: SwapPayout): InternalizeOutput {
  if (o.kind === "brc29") return { outputIndex: o.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { ...o.remittance } };
  if (o.kind === "basket") return { outputIndex: o.outputIndex, protocol: "basket insertion", insertionRemittance: { basket: SWAP_BASKET, customInstructions: o.customInstructions } };
  return receiptOutput(o.outputIndex, o.receipt);
}
