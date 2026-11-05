// ---------------------------------------------------------------------------
// runar-sdk/deployment.ts -- Transaction construction for contract deployment
// ---------------------------------------------------------------------------

import { Transaction, LockingScript, UnlockingScript } from '@bsv/sdk';
import type { UTXO } from './types.js';
import { buildP2PKHScript } from './script-utils.js';

/**
 * Build a transaction that creates an output with the given locking script.
 * The transaction consumes the provided UTXOs, places the contract output
 * first, and sends any remaining value (minus fees) to a change address.
 *
 * Returns the unsigned Transaction object and the number of inputs (needed
 * so the caller knows how many inputs to sign).
 */
export function buildDeployTransaction(
  lockingScript: string,
  utxos: UTXO[],
  satoshis: number,
  changeAddress: string,
  changeScript: string,
  feeRate: number = 100,
): { tx: Transaction; inputCount: number } {
  if (utxos.length === 0) {
    throw new Error('buildDeployTransaction: no UTXOs provided');
  }

  const totalInput = utxos.reduce((sum, u) => sum + u.satoshis, 0);
  const fee = estimateDeployFee(utxos.length, lockingScript.length / 2, feeRate);
  const change = totalInput - satoshis - fee;

  if (change < 0) {
    throw new Error(
      `buildDeployTransaction: insufficient funds. Need ${satoshis + fee} sats, have ${totalInput}`,
    );
  }

  const tx = new Transaction();

  // Inputs (unsigned — no unlocking script)
  for (const utxo of utxos) {
    tx.addInput({
      sourceTXID: utxo.txid,
      sourceOutputIndex: utxo.outputIndex,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    });
  }

  // Output 0: contract locking script
  tx.addOutput({
    satoshis,
    lockingScript: LockingScript.fromHex(lockingScript),
  });

  // Output 1: change (if any)
  if (change > 0) {
    const actualChangeScript = changeScript || buildP2PKHScript(changeAddress);
    tx.addOutput({
      satoshis: change,
      lockingScript: LockingScript.fromHex(actualChangeScript),
    });
  }

  return { tx, inputCount: utxos.length };
}

// ---------------------------------------------------------------------------
// Fee estimation
// ---------------------------------------------------------------------------

/** Estimated size of a P2PKH input (prevTxid + index + sig + pubkey + seq). */
const P2PKH_INPUT_SIZE = 148;
/** Estimated size of a P2PKH output (satoshis + varint + 25-byte script). */
const P2PKH_OUTPUT_SIZE = 34;
/** Transaction overhead: version(4) + input varint(1) + output varint(1) + locktime(4). */
const TX_OVERHEAD = 10;

function varIntByteSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/**
 * Estimate the fee for a deploy transaction given the number of P2PKH
 * inputs and the contract locking script byte length. Includes a P2PKH
 * change output.
 *
 * @param numInputs              - Number of P2PKH inputs.
 * @param lockingScriptByteLen   - Byte length of the contract locking script.
 * @param feeRate                - Fee rate in satoshis per KB (default: 100).
 * @param extraInputBytes        - Serialized byte size of any NON-P2PKH inputs
 *   that this fee must also cover (e.g. a contract/covenant input being spent
 *   in the same tx). Defaults to 0 — pure-deploy and funding-only selection
 *   are unaffected. Used by `prepareCall` so funding coin-selection sizes the
 *   fee against the real contract-input unlock bytes (which can be tens of KB
 *   for a MERGE that embeds both parent txs) instead of ignoring them.
 */
export function estimateDeployFee(
  numInputs: number,
  lockingScriptByteLen: number,
  feeRate: number = 100,
  extraInputBytes: number = 0,
  extraOutputBytes: number = 0,
): number {
  const inputsSize = numInputs * P2PKH_INPUT_SIZE + extraInputBytes;
  const contractOutputSize =
    8 + varIntByteSize(lockingScriptByteLen) + lockingScriptByteLen;
  // extraOutputBytes carries the serialized framing (8 + varint + scriptLen) of
  // every output BEYOND the single `lockingScriptByteLen` one counted above —
  // additional multi-outputs, raw outputs (finding G1), and data outputs. A
  // call-path selection that ignored them under-provisioned funding on
  // multi-output / large-dataOutput calls, so it would stop one UTXO short and
  // the built tx's change would go negative (finding C15). Deploy passes 0.
  const changeOutputSize = P2PKH_OUTPUT_SIZE;
  const txSize =
    TX_OVERHEAD + inputsSize + contractOutputSize + extraOutputBytes + changeOutputSize;
  return Math.ceil(txSize * feeRate / 1000);
}

/**
 * Select the minimum set of UTXOs needed to fund a deployment, using a
 * largest-first strategy. Returns the selected subset (possibly all UTXOs
 * if the total is still insufficient -- the caller should check).
 */
export function selectUtxos(
  utxos: UTXO[],
  targetSatoshis: number,
  lockingScriptByteLen: number,
  feeRate: number = 100,
  extraInputBytes: number = 0,
  extraOutputBytes: number = 0,
): UTXO[] {
  const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis);
  const selected: UTXO[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.satoshis;

    // extraInputBytes carries the serialized size of any non-P2PKH inputs the
    // same tx spends (the contract/covenant input); extraOutputBytes carries the
    // framing of any outputs beyond the single continuation (multi-output / raw /
    // data outputs). Both keep the fee — and therefore how much funding we
    // select — from being under-provisioned (findings C2 / C15).
    const fee = estimateDeployFee(
      selected.length, lockingScriptByteLen, feeRate, extraInputBytes, extraOutputBytes,
    );
    if (total >= targetSatoshis + fee) {
      return selected;
    }
  }

  // Return all UTXOs; buildDeployTransaction will throw if still insufficient
  return selected;
}
