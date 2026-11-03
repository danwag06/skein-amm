/**
 * The active swap basket (skein-amm 0.12.0, David Case 2026-10-21/22; 0.29.0,
 * 2026-11-02): everything the swap legs spend, held outside the BRC-207 module
 * in the exchange's own basket `amm-swap` (src/wallet/color.ts): the token
 * outputs and each leg's sats.
 *
 *   - **In** (`sendToSwapBasket`): before the legs of a tokens-in swap, ONE
 *     wallet-built send through the module: one 1Color value output per leg
 *     not covered by what `amm-swap` already holds, each exactly the leg's
 *     amount in (the pool takes no token change, so a leg needs inputs that
 *     sum to its amount exactly), locked to a fresh key under `[2, "amm
 *     swap"]` (counterparty self), the plan naming them a transfer out; and
 *     (0.29.0) one P2PKH sats output per leg not covered (the leg's exact
 *     sats, `swapFunding`), to a fresh key of the same protocol, filed in
 *     `amm-swap` by the createAction itself (customInstructions `{sats: true,
 *     protocolID, keyID, counterparty}`). The module passes the sats outputs
 *     through, selects the token inputs, adds change, asks once, signs and
 *     submits to `tm_color_<assetId>`; the wallet funds the sats; the page
 *     submits it to this skein too (a repeat is harmless), then files each
 *     token output in `amm-swap` (basket insertion, customInstructions
 *     `{assetId, amount, protocolID, keyID, counterparty}`). A sats-in swap,
 *     or a tokens-in swap whose tokens are all staged already, sends only the
 *     sats (`sendSatsToSwapBasket`: a plain createAction, no `p color` labels).
 *   - **Spent** by the legs (src/market/swapAction.ts): app-built,
 *     `createSignature` under the key the customInstructions name; the
 *     wallet marks them spent when it takes the accepted swap in (0.29.0: no
 *     relinquishOutput). An output a failed leg did not spend stays for a
 *     later swap.
 *   - **Move back** (`moveBack`, the recovery path; 0.29.0: one wallet
 *     createAction): every `amm-swap` token output of the token as an
 *     explicit input (its source transaction in `inputBEEF`, unlocked by the
 *     page at signAction), one output to a NEW module receiving key (sender:
 *     the user's own identity) carrying the receipt as its customInstructions;
 *     the wallet funds the fee, adds change, broadcasts and records it; then
 *     submitted to this skein's token topic and taken in through the module
 *     (`internalizeAction`, basket insertion into `p color <assetTag>`, the
 *     receipt).
 */
import { Beef, P2PKH, PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface } from "@bsv/sdk";
import { colorReceiptInstructions } from "@1sat/actions";
import { decodeOneColor } from "../pool";
import { sdkTokenId, tokenIdOfWire } from "../lib/tokenId";
import type { SignedFetch } from "../lib/overlay";
import { basketBeef, basketRows } from "../lp/wallet";
import { tokenP2pkhScript } from "../lp/poolDeploy";
import { awaitAdmitted, steakText, submitToOverlay, type Steak } from "../lp/close";
import { SWAP_BASKET, SWAP_PROTOCOL, newReceivingKey, swapInstructions, swapSatsInstructions, receiptOutput, runTokenAction, transferPlanLabels } from "../wallet/color";
import { identityKeyOf } from "../wallet/brc29";
import { inputIndexOf, runAppSignedAction, type Spends } from "../wallet/action";
import { payoutId, type PendingPayoutStore } from "../wallet/pendingPayouts";
import { P2PKH_UNLOCK_LENGTH, satsInputsOf, signP2pkhWithWallet, spendValid, tokenInputsOf, type SatsInput, type TokenInput } from "./swapAction";

/** The keyID prefix of an `amm-swap` key (`SWAP_PROTOCOL`, counterparty self). */
export const SWAP_KEY_PREFIX = "amm-swap-";

function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

function randomHex(bytes = 8): string {
  return Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(bytes))));
}

/** The `amm-swap` outputs of `tokenId` the legs can spend. */
export async function swapHoldings(wallet: WalletInterface, tokenId: string): Promise<TokenInput[]> {
  return tokenInputsOf(await basketRows(wallet, SWAP_BASKET), tokenId);
}

/** The `amm-swap` sats outputs the legs can spend (0.29.0). */
export async function swapSatsHoldings(wallet: WalletInterface): Promise<SatsInput[]> {
  return satsInputsOf(await basketRows(wallet, SWAP_BASKET));
}

/** What `amm-swap` holds, per token id: the amount and the number of outputs (tokens only: the sats rows are no token's). */
export async function swapTotals(wallet: WalletInterface): Promise<Map<string, { amount: bigint; outputs: number }>> {
  const totals = new Map<string, { amount: bigint; outputs: number }>();
  for (const r of await basketRows(wallet, SWAP_BASKET)) {
    if (!r.lockingScript) continue;
    const t = decodeOneColor(Utils.toArray(r.lockingScript, "hex"));
    if (!t || t.role !== "value" || !t.idBytes) continue;
    const id = tokenIdOfWire(t.idBytes);
    const s = totals.get(id) ?? { amount: 0n, outputs: 0 };
    s.amount += t.amount;
    s.outputs++;
    totals.set(id, s);
  }
  return totals;
}

/** The source transactions of `amm-swap`'s outputs (a leg's BEEF), with `extra` merged in. */
export async function swapHoldingBeef(wallet: WalletInterface, extra?: number[]): Promise<Beef> {
  const beef = (await basketBeef(wallet, SWAP_BASKET)) ?? new Beef();
  if (extra) beef.mergeBeef(Beef.fromBinary(extra));
  return beef;
}

export interface SentToSwapBasket {
  txid: string;
  /** The send as the wallet's AtomicBEEF. */
  tx: number[];
  /** The new `amm-swap` token outputs, in the order of `stage.tokens`. */
  holdings: TokenInput[];
  /** The new `amm-swap` sats outputs, in the order of `stage.sats` (0.29.0). */
  sats: SatsInput[];
  filed: boolean;
  submitted: string;
  errors: string[];
}

/** What one send stages: a token output per amount, then a sats output per amount. */
export interface SwapStage {
  tokens: bigint[];
  sats: number[];
}

/** Fresh "amm swap" keys for `sats` and their outputs, filed in `amm-swap` by the createAction itself. */
async function satsOutputs(wallet: WalletInterface, sats: number[], sym: string) {
  return await Promise.all(
    sats.map(async (satoshis) => {
      if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error("nothing to send to the swap basket");
      const keyID = `${SWAP_KEY_PREFIX}${randomHex()}`;
      const { publicKey } = await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", forSelf: true });
      const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex();
      return {
        keyID,
        satoshis,
        lockingScript,
        output: {
          lockingScript,
          satoshis,
          outputDescription: describe(`Sats for a ${sym} swap leg`),
          basket: SWAP_BASKET,
          customInstructions: swapSatsInstructions({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self" }),
        },
      };
    }),
  );
}

/** The send's sats outputs from `first` on, as `SatsInput`s (an output the wallet moved is an error). */
function satsHeld(final: Transaction, txid: string, keys: Awaited<ReturnType<typeof satsOutputs>>, first: number, errors: string[]): SatsInput[] {
  const out: SatsInput[] = [];
  keys.forEach((k, n) => {
    const vout = first + n;
    const o = final.outputs[vout];
    if (!o || o.lockingScript.toHex() !== k.lockingScript || o.satoshis !== k.satoshis) {
      errors.push(`the wallet's send has no output ${vout} to the swap key`);
      return;
    }
    out.push({ outpoint: `${txid}.${vout}`, txid, vout, satoshis: k.satoshis, lockingScript: k.lockingScript, protocolID: SWAP_PROTOCOL, keyID: k.keyID, counterparty: "self" });
  });
  return out;
}

/**
 * "In" (see the module comment): one module send of `stage.tokens` (each one
 * output) to fresh `amm-swap` keys, filed in `amm-swap`, and of `stage.sats`
 * (each one output) after them. Throws when the wallet refuses or fails the
 * send; filing and the page's own submit are reported in `errors`.
 */
export async function sendToSwapBasket(
  wallet: WalletInterface,
  base: string,
  tokenId: string,
  stage: SwapStage,
  meta: { sym?: string } = {},
  submit: (topic: string, beef: number[]) => Promise<{ steak?: Steak }> = (topic, beef) => submitToOverlay(base, topic, beef),
): Promise<SentToSwapBasket> {
  const amounts = stage.tokens;
  if (amounts.length === 0 || amounts.some((a) => a <= 0n)) throw new Error("nothing to send to the swap basket");
  const assetId = sdkTokenId(tokenId);
  const sym = meta.sym ?? "token";
  const keys = await Promise.all(
    amounts.map(async (amount) => {
      const keyID = `${SWAP_KEY_PREFIX}${randomHex()}`;
      const { publicKey } = await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", forSelf: true });
      return { amount, keyID, publicKey, lockingScript: tokenP2pkhScript(assetId, amount, publicKey) };
    }),
  );
  const satsKeys = await satsOutputs(wallet, stage.sats, sym);
  const { txid, tx } = await runTokenAction(wallet, {
    description: describe(`AMM swap: ${sym} into the swap basket`),
    labels: [...transferPlanLabels(assetId), "amm-swap"],
    outputs: [...keys.map((k) => ({ lockingScript: k.lockingScript, satoshis: 1, outputDescription: describe(`${sym} for a swap leg`) })), ...satsKeys.map((k) => k.output)],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  const out: SentToSwapBasket = { txid, tx, holdings: [], sats: [], filed: false, submitted: "not submitted", errors: [] };
  const final = Transaction.fromAtomicBEEF(tx);
  keys.forEach((k, vout) => {
    const o = final.outputs[vout];
    if (!o || o.lockingScript.toHex() !== k.lockingScript) {
      out.errors.push(`the wallet's send has no output ${vout} to the swap key`);
      return;
    }
    out.holdings.push({ outpoint: `${txid}.${vout}`, txid, vout, satoshis: o.satoshis!, lockingScript: k.lockingScript, amount: k.amount, protocolID: SWAP_PROTOCOL, keyID: k.keyID, counterparty: "self" });
  });
  out.sats = satsHeld(final, txid, satsKeys, keys.length, out.errors);
  try {
    out.submitted = steakText(await submit(`tm_color_${assetId}`, tx));
  } catch (err) {
    out.submitted = "the submit failed";
    out.errors.push(`submit: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows: InternalizeOutput[] = out.holdings.map((h) => ({
    outputIndex: h.vout,
    protocol: "basket insertion",
    insertionRemittance: { basket: SWAP_BASKET, customInstructions: swapInstructions({ assetId, amount: h.amount, protocolID: SWAP_PROTOCOL, keyID: h.keyID, counterparty: "self" }) },
  }));
  try {
    const r = await wallet.internalizeAction({ tx, outputs: rows, description: describe(`AMM swap: ${sym} into the swap basket`), labels: ["amm-swap"] });
    out.filed = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

export interface SentSats {
  txid: string;
  /** The send as the wallet's AtomicBEEF. */
  tx: number[];
  /** The new `amm-swap` sats outputs, in the order of `sats`. */
  sats: SatsInput[];
  errors: string[];
}

/**
 * The sats-only send (0.29.0): one plain createAction (no `p color` labels: the module is not in
 * the path) with one P2PKH output per amount to a fresh "amm swap" key, filed in `amm-swap`; the
 * wallet funds it, adds change and broadcasts. Throws when the wallet refuses or fails it.
 */
export async function sendSatsToSwapBasket(wallet: WalletInterface, sats: number[], meta: { sym?: string } = {}): Promise<SentSats> {
  if (sats.length === 0) throw new Error("nothing to send to the swap basket");
  const sym = meta.sym ?? "token";
  const keys = await satsOutputs(wallet, sats, sym);
  const { txid, tx } = await runTokenAction(wallet, {
    description: describe(`AMM swap: sats into the swap basket`),
    labels: ["amm-swap"],
    outputs: keys.map((k) => k.output),
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  const errors: string[] = [];
  return { txid, tx, sats: satsHeld(Transaction.fromAtomicBEEF(tx), txid, keys, 0, errors), errors };
}

export interface MovedBack {
  txid: string;
  amount: bigint;
  /** The transaction as the wallet's AtomicBEEF. */
  beef: number[];
  submitted: string;
  internalized: boolean;
  errors: string[];
}

/** The page's unlocking scripts for the `amm-swap` outputs `holdings` in the wallet's transaction `tx`, each checked with `Spend`. */
export async function swapBasketSpends(wallet: WalletInterface, tx: Transaction, holdings: (TokenInput | SatsInput)[], what: string): Promise<Spends> {
  const spends: Spends = {};
  for (const h of holdings) {
    const n = inputIndexOf(tx, h.txid, h.vout);
    if (n < 0) throw new Error(`the wallet's ${what} does not spend the swap basket output ${h.outpoint}`);
    tx.inputs[n]!.unlockingScript = await signP2pkhWithWallet(wallet, tx, n, h);
    if (!spendValid(tx, n)) throw new Error(`input ${n} of the ${what} does not validate`);
    spends[n] = { unlockingScript: tx.inputs[n]!.unlockingScript!.toHex() };
  }
  return spends;
}

/**
 * "Move back" (see the module comment). Throws before anything is broadcast
 * (no outputs, a wallet refusal, an input that does not validate: the action
 * is aborted); after the wallet's broadcast, errors are collected and an
 * unfiled receipt is kept as a pending payout (src/wallet/pendingPayouts.ts)
 * for a later retry.
 */
export async function moveBack(i: {
  wallet: WalletInterface;
  af: SignedFetch | null;
  base: string;
  tokenId: string;
  meta?: { sym?: string };
  payouts?: PendingPayoutStore;
  submit?: (topic: string, beef: number[]) => Promise<{ steak?: Steak }>;
  admitted?: (txid: string, vout: number) => Promise<boolean>;
}): Promise<MovedBack> {
  const { wallet } = i;
  const assetId = sdkTokenId(i.tokenId);
  const sym = i.meta?.sym ?? "token";
  const topic = `tm_color_${assetId}`;
  const holdings = await swapHoldings(wallet, assetId);
  if (holdings.length === 0) throw new Error(`the swap basket holds no ${sym}`);
  const amount = holdings.reduce((a, h) => a + h.amount, 0n);
  const sources = await swapHoldingBeef(wallet);
  for (const h of holdings) if (!sources.findTxid(h.txid)) throw new Error(`the wallet's BEEF lacks the swap basket output ${h.outpoint}`);

  const me = await identityKeyOf(wallet);
  const key = await newReceivingKey(wallet, assetId, me);
  const lockingScript = tokenP2pkhScript(assetId, amount, key.publicKey);
  const { txid, tx: beef } = await runAppSignedAction(
    wallet,
    {
      description: describe(`AMM move back: ${sym}`),
      inputBEEF: sources.toBinary(),
      inputs: holdings.map((h) => ({ outpoint: h.outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: describe(`${sym} in the swap basket`) })),
      outputs: [{ lockingScript, satoshis: 1, outputDescription: describe(`${sym} back to your wallet`), customInstructions: colorReceiptInstructions(key.receipt) }],
      labels: ["amm-swap"],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    (tx) => swapBasketSpends(wallet, tx, holdings, "move back"),
  );
  const out: MovedBack = { txid, amount, beef, submitted: "not submitted", internalized: false, errors: [] };
  let steak: { steak?: Steak } = {};
  try {
    steak = await (i.submit ?? ((t: string, b: number[]) => submitToOverlay(i.base, t, b)))(topic, beef);
    out.submitted = steakText(steak);
  } catch (err) {
    out.submitted = "the submit failed";
    out.errors.push(`submit: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The module takes in only an admitted, unspent output.
  const took = steak.steak?.[topic]?.outputsToAdmit.includes(0) ?? false;
  const admitted = took || (await (i.admitted ?? ((t: string, v: number) => awaitAdmitted(i.af, i.base, assetId, t, v)))(txid, 0).catch(() => false));
  const pending = {
    id: payoutId(txid, 0),
    kind: "move-back" as const,
    txid,
    vout: 0,
    satoshis: 1,
    lockingScript,
    receipt: key.receipt,
    final: true,
    tokenId: assetId,
    atomicBeef: Utils.toHex(beef),
    description: describe(`AMM move back: ${sym}`),
    createdAt: Date.now(),
  };
  i.payouts?.save(pending);
  if (!admitted) out.errors.push("the token topic has not admitted the move back yet: your wallet takes it in on a retry");
  else {
    try {
      const r = await wallet.internalizeAction({ tx: beef, outputs: [receiptOutput(0, key.receipt)], description: describe(`AMM move back: ${sym}`), labels: ["amm-swap"] });
      out.internalized = r.accepted;
      if (r.accepted) i.payouts?.remove(pending.id);
    } catch (err) {
      out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
