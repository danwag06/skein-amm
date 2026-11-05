// ---------------------------------------------------------------------------
// runar-sdk/calling.ts — Transaction construction for method invocation
// ---------------------------------------------------------------------------

import { Transaction, LockingScript, UnlockingScript } from '@bsv/sdk';
import type { RunarArtifact } from '../../../../pool/runar-ir-schema.js';
import type { UTXO } from './types.js';
import { buildP2PKHScript } from './script-utils.js';

/**
 * Build a transaction that spends a contract UTXO (method call).
 *
 * The transaction:
 * - Input 0: the current contract UTXO with the given unlocking script.
 * - Additional inputs: funding UTXOs if provided.
 * - Output 0 (optional): new contract UTXO with updated locking script
 *   (for stateful contracts).
 * - Last output (optional): change.
 *
 * Returns the Transaction object (with unlocking script for input 0
 * already placed) and the total input count.
 */
export function buildCallTransaction(
  currentUtxo: UTXO,
  unlockingScript: string,
  newLockingScript?: string,
  newSatoshis?: number,
  changeAddress?: string,
  changeScript?: string,
  additionalUtxos?: UTXO[],
  feeRate: number = 100,
  options?: {
    /** Multiple contract outputs (replaces single newLockingScript). */
    contractOutputs?: Array<{ script: string; satoshis: number }>;
    /** Additional contract inputs with their own unlocking scripts (for merge). */
    additionalContractInputs?: Array<{ utxo: UTXO; unlockingScript: string }>;
    /** Data outputs declared via `this.addDataOutput(...)` in the method
     * body. Emitted between contract (state) outputs and the change output,
     * in declaration order — matching the compile-time continuation-hash
     * layout. */
    dataOutputs?: Array<{ script: string; satoshis: number }>;
    /** Override the call tx's nLockTime. Unset → defaults to 0 (legacy).
     * Set to a non-zero value for contracts that assert
     * `extractLocktime(preimage) >= deadline` (e.g. auction close/claim). */
    locktime?: number;
    /** Override the nSequence written onto every input (issue #131). Unset →
     * 0xfffffffe when a non-zero locktime is set (so nLockTime is consensus-
     * enforced), else 0xffffffff (final, legacy). */
    sequence?: number;
  },
): { tx: Transaction; inputCount: number; changeAmount: number } {
  const extraContractInputs = options?.additionalContractInputs ?? [];
  const dataOutputs = options?.dataOutputs ?? [];
  const allUtxos = [currentUtxo, ...extraContractInputs.map((i) => i.utxo), ...(additionalUtxos ?? [])];

  const totalInput = allUtxos.reduce((sum, u) => sum + u.satoshis, 0);

  // Determine contract outputs: multi-output takes priority over single
  const contractOutputs: Array<{ script: string; satoshis: number }> =
    options?.contractOutputs ??
    (newLockingScript
      ? [{ script: newLockingScript, satoshis: newSatoshis ?? currentUtxo.satoshis }]
      : []);

  const contractOutputSats =
    contractOutputs.reduce((sum, o) => sum + o.satoshis, 0)
    + dataOutputs.reduce((sum, o) => sum + o.satoshis, 0);

  // Estimate fee using actual script sizes
  const input0Size = 32 + 4 + varIntByteSize(unlockingScript.length / 2) +
    unlockingScript.length / 2 + 4;
  let extraContractInputsSize = 0;
  for (const ci of extraContractInputs) {
    extraContractInputsSize += 32 + 4 +
      varIntByteSize(ci.unlockingScript.length / 2) +
      ci.unlockingScript.length / 2 + 4;
  }
  const p2pkhInputsSize = (additionalUtxos?.length ?? 0) * 148;
  const inputsSize = input0Size + extraContractInputsSize + p2pkhInputsSize;

  let outputsSize = 0;
  for (const co of contractOutputs) {
    outputsSize += 8 + varIntByteSize(co.script.length / 2) + co.script.length / 2;
  }
  for (const do_ of dataOutputs) {
    outputsSize += 8 + varIntByteSize(do_.script.length / 2) + do_.script.length / 2;
  }
  if (changeAddress || changeScript) {
    outputsSize += 34; // P2PKH change
  }
  const estimatedSize = 10 + inputsSize + outputsSize;
  const fee = Math.ceil(estimatedSize * feeRate / 1000);

  const change = totalInput - contractOutputSats - fee;

  // Fail closed on a genuinely underfunded call (finding C3): if the inputs
  // cannot even cover the (non-change) contract + data outputs, the tx spends
  // more than it takes in — it can never confirm and a covenant would strand
  // the funds. Do NOT throw merely because `change < 0`: an exact-cover
  // continuation (issue #116) keeps the full input value in the continuation
  // output and adds no funding, so `change === -fee` (negative) even though
  // `totalInput === contractOutputSats` and the resulting zero-fee tx is valid
  // (the covenant accepts a no-change spend). Guard on the only value-invalid
  // case — `totalInput < contractOutputSats` (contractOutputSats already
  // includes data outputs) — and keep the existing clamp (change output
  // omitted when `change <= 0`). Mirrors Java's fail-closed selection loop.
  if (totalInput < contractOutputSats) {
    throw new Error(
      `buildCallTransaction: insufficient funds. Need ${contractOutputSats + fee} sats, have ${totalInput}`,
    );
  }

  // Build Transaction object
  const tx = new Transaction();

  // Locktime: default 0 (legacy); overridable via options.locktime for
  // contracts asserting `extractLocktime(preimage) >= deadline`.
  tx.lockTime = options?.locktime ?? 0;

  // Sequence (issue #131): an all-0xffffffff input set makes nLockTime a
  // consensus no-op. When a non-zero locktime is set, default every input to
  // 0xfffffffe (non-final) so the locktime is actually enforced. Explicit
  // options.sequence always wins.
  const inputSequence = resolveInputSequence(options?.locktime, options?.sequence);

  // Input 0: primary contract UTXO with unlocking script
  tx.addInput({
    sourceTXID: currentUtxo.txid,
    sourceOutputIndex: currentUtxo.outputIndex,
    unlockingScript: UnlockingScript.fromHex(unlockingScript),
    sequence: inputSequence,
  });

  // Additional contract inputs (with their own unlocking scripts)
  for (const ci of extraContractInputs) {
    tx.addInput({
      sourceTXID: ci.utxo.txid,
      sourceOutputIndex: ci.utxo.outputIndex,
      unlockingScript: UnlockingScript.fromHex(ci.unlockingScript),
      sequence: inputSequence,
    });
  }

  // P2PKH funding inputs (unsigned)
  if (additionalUtxos) {
    for (const utxo of additionalUtxos) {
      tx.addInput({
        sourceTXID: utxo.txid,
        sourceOutputIndex: utxo.outputIndex,
        unlockingScript: new UnlockingScript(),
        sequence: inputSequence,
      });
    }
  }

  // Contract outputs
  for (const co of contractOutputs) {
    tx.addOutput({
      satoshis: co.satoshis,
      lockingScript: LockingScript.fromHex(co.script),
    });
  }

  // Data outputs (from this.addDataOutput in method body). Emitted after
  // state outputs and before change to match the continuation hash.
  for (const do_ of dataOutputs) {
    tx.addOutput({
      satoshis: do_.satoshis,
      lockingScript: LockingScript.fromHex(do_.script),
    });
  }

  // Change output
  if (change > 0 && (changeAddress || changeScript)) {
    const actualChangeScript =
      changeScript || buildP2PKHScript(changeAddress!);
    tx.addOutput({
      satoshis: change,
      lockingScript: LockingScript.fromHex(actualChangeScript),
    });
  }

  return { tx, inputCount: allUtxos.length, changeAmount: change > 0 ? change : 0 };
}

/**
 * Resolve the nSequence for a call tx's inputs (issue #131).
 *
 * An all-0xffffffff input set makes nLockTime a consensus no-op, so a
 * locktime-gated method would be script-enforced (via extractLocktime) yet
 * NOT consensus-enforced. When a non-zero locktime is set we therefore default
 * every input to 0xfffffffe (non-final, enforceable). Explicit `sequence`
 * always wins; with no/zero locktime we keep the legacy 0xffffffff.
 *
 * Shared by `buildCallTransaction` and the terminal-path tx builder so both
 * sites stay byte-consistent.
 */
export function resolveInputSequence(
  locktime: number | undefined,
  sequence: number | undefined,
): number {
  if (sequence !== undefined) return sequence;
  if (locktime !== undefined && locktime !== 0) return 0xfffffffe;
  return 0xffffffff;
}

// ---------------------------------------------------------------------------
// Fee estimation
// ---------------------------------------------------------------------------

const P2PKH_INPUT_SIZE = 148;
const P2PKH_OUTPUT_SIZE = 34;
const TX_OVERHEAD = 10;

/**
 * Estimate the fee for a method call transaction.
 *
 * @param lockingScriptByteLen   - Byte length of the (single) contract
 *   continuation output's locking script.
 * @param unlockingScriptByteLen - Byte length of the primary contract input's
 *   unlocking script.
 * @param numFundingInputs       - Number of P2PKH funding inputs (~148 bytes
 *   each), NOT continuation outputs. Use `extraOutputBytes` to size
 *   additional continuation/data outputs.
 * @param feeRate                - Sat/KB (default 100).
 * @param extraOutputBytes       - Serialized byte size of any outputs BEYOND
 *   the single `lockingScriptByteLen` one already counted (additional
 *   continuation outputs, data outputs) — mirrors `estimateDeployFee`'s
 *   `extraOutputBytes` in deployment.ts (finding C15). Defaults to 0.
 */
export function estimateCallFee(
  lockingScriptByteLen: number,
  unlockingScriptByteLen: number,
  numFundingInputs: number,
  feeRate: number = 100,
  extraOutputBytes: number = 0,
): number {
  const contractInputSize = 32 + 4 + varIntByteSize(unlockingScriptByteLen) + unlockingScriptByteLen + 4;
  const fundingInputsSize = numFundingInputs * P2PKH_INPUT_SIZE;
  const contractOutputSize = 8 + varIntByteSize(lockingScriptByteLen) + lockingScriptByteLen;
  const changeOutputSize = P2PKH_OUTPUT_SIZE;
  const txSize =
    TX_OVERHEAD + contractInputSize + fundingInputsSize + contractOutputSize + extraOutputBytes + changeOutputSize;
  return Math.ceil(txSize * feeRate / 1000);
}

export interface EstimateFeeForArtifactOpts {
  /** Sat/byte. Default 0.1. */
  feeRate?: number;
  /** Number of continuation outputs, each assumed the same byte size as the
   * artifact's own locking script (homogeneous multi-output fan-out).
   * Default 1. Fixed under finding C4: previously this value was fed
   * directly into `estimateCallFee`'s `numFundingInputs` slot (each priced
   * at ~148 bytes, a P2PKH input) instead of sizing extra continuation
   * OUTPUTS — silently mispricing every caller of this helper. */
  outputCount?: number;
  /** Unlocking-script byte length. Default: ceil(artifact.script.length / 4). */
  unlockingScriptLen?: number;
}

/**
 * Estimate the fee for a single call against a deployed contract built
 * from the given artifact. Wraps {@link estimateCallFee} with defaults
 * derived from the artifact and accepts `feeRate` in sat/byte (vs the
 * sat/kilobyte unit `estimateCallFee` itself takes).
 */
export function estimateFeeForArtifact(
  artifact: RunarArtifact,
  opts: EstimateFeeForArtifactOpts = {},
): number {
  const satPerByte = opts.feeRate ?? 0.1;
  const outputs = opts.outputCount ?? 1;
  const lockingLen = artifact.script.length / 2;
  const unlockingLen = opts.unlockingScriptLen ?? Math.ceil(artifact.script.length / 4);
  // estimateCallFee already prices ONE continuation output of lockingLen
  // bytes; extraOutputBytes covers any additional outputs beyond that one
  // (finding C4 — outputCount used to be smuggled into numFundingInputs).
  const perOutputSize = 8 + varIntByteSize(lockingLen) + lockingLen;
  const extraOutputBytes = Math.max(0, outputs - 1) * perOutputSize;
  return estimateCallFee(lockingLen, unlockingLen, 0, satPerByte * 1000, extraOutputBytes);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function varIntByteSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}
