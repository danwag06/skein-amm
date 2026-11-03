/**
 * A wallet-built action whose inputs the page unlocks (skein-amm 0.29.0, David Case 2026-11-02:
 * Move back and Close are wallet createActions). The page names the inputs it spends (an
 * `amm-swap` output, a pool), their source transactions (`inputBEEF`) and the outputs; the wallet
 * adds its own inputs for the miner fee and its change, and hands the transaction back for
 * signing (BRC-100: an input with `unlockingScriptLength` and no `unlockingScript`). The page
 * computes its unlocking scripts over that transaction (`createSignature` under the key each
 * input's row names) and passes them to `signAction`; the wallet signs its own inputs,
 * broadcasts, and records the action, every output with the customInstructions the page gave it.
 * Aborted when anything fails before the wallet has the signatures.
 */
import { Transaction, type CreateActionArgs, type WalletInterface } from "@bsv/sdk";

export type Spends = Record<number, { unlockingScript: string }>;

export interface SignedAction {
  txid: string;
  /** The signed transaction as the wallet's AtomicBEEF. */
  tx: number[];
}

/**
 * `createAction(args)` → `sign(the wallet's transaction)` → `signAction({reference, spends})`.
 * `sign` gets the unsigned transaction with every input's source transaction linked (the
 * signable BEEF) and answers the page's unlocking scripts by input index.
 */
export async function runAppSignedAction(
  wallet: WalletInterface,
  args: CreateActionArgs,
  sign: (tx: Transaction) => Promise<Spends>,
): Promise<SignedAction> {
  const created = await wallet.createAction(args);
  const signable = created.signableTransaction;
  if (!signable) throw new Error("the wallet did not hand the transaction back for the page's signatures");
  const reference = signable.reference;
  try {
    const tx = Transaction.fromAtomicBEEF(Array.from(signable.tx));
    for (const input of tx.inputs) input.sourceTXID ??= input.sourceTransaction?.id("hex");
    const spends = await sign(tx);
    const signed = await wallet.signAction({ reference, spends, ...(args.options?.acceptDelayedBroadcast !== undefined ? { options: { acceptDelayedBroadcast: args.options.acceptDelayedBroadcast } } : {}) });
    if (!signed.txid || !signed.tx) throw new Error("the wallet returned no signed transaction");
    return { txid: signed.txid, tx: Array.from(signed.tx) };
  } catch (err) {
    await wallet.abortAction({ reference }).catch(() => undefined);
    throw err;
  }
}

/** The index of the input spending `txid.vout` in `tx`, or -1. */
export function inputIndexOf(tx: Transaction, txid: string, vout: number): number {
  return tx.inputs.findIndex((i) => (i.sourceTXID ?? i.sourceTransaction?.id("hex")) === txid && i.sourceOutputIndex === vout);
}
