/**
 * The wallet's BRC-207 `color` module, as the pages use it (skein-amm 0.12.0,
 * David Case 2026-10-21/22). The module runs inside the wallet
 * (Yours, branch 1color; `@bsv/color-permission-module`); the page only
 * names its baskets, keys, plans and receipts, with the module's own helpers:
 *
 *   - reads: `listOutputs` with `p color assets` (every held token output,
 *     `ASSETS_SELECTOR`) and `p color balance <assetTag>` (the exact decimal
 *     balance of one asset), `assetTag` = `<txid>v<vout>`; the asset id is
 *     `<txid>_<vout>`;
 *   - a send: `createAction` with the token outputs, a plan in `p color plan`
 *     labels (`ColorPlan.toLabels`) and `randomizeOutputs: false`; the module
 *     selects the token inputs, adds token change, asks the user, signs and
 *     submits to `tm_color_<assetId>`;
 *   - a receive: an output locked to a module receiving key,
 *     `getPublicKey({protocolID: [2, "p color <assetTag> <prefixHex>
 *     <suffixHex>"], keyID: "color", counterparty: <sender>, forSelf: true})`,
 *     taken in with `internalizeAction` (`basket insertion` into
 *     `p color <assetTag>`, the receipt JSON as customInstructions) once the
 *     transaction is admitted. The sender is whoever builds the output: the
 *     validator for a swap's payout, the user for "move back" (BRC-42: the
 *     sender's key to the receiver is the receiver's key from the sender,
 *     so the page derives it itself; the module checks it the same way,
 *     `assertOwned`).
 *
 * The exchange's own baskets (not `p color`; the module would refuse them):
 * `amm-pools` (the LP's position rows) and `amm-swap` (the active swap
 * basket: tokens sent out of the module for swap legs and, 0.29.0, each leg's
 * sats, under the exchange's protocol `[2, "amm swap"]`, counterparty self, a
 * fresh keyID per output).
 */
import { colorReceiptInstructions, type ColorReceipt } from "@1sat/actions";
import { ASSETS_SELECTOR, COLOR_KEY_ID, ColorPlan, assetBasket, assetTag, colorProtocolID, type ColorRemittance } from "@bsv/color-permission-module";
import { PublicKey, Utils, type CreateActionArgs, type InternalizeOutput, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { randomBase64 } from "./brc29.js";

export { ASSETS_SELECTOR, assetBasket, assetTag, colorProtocolID, type ColorReceipt };

/** The LP's position rows: one pool output per deploy (basket insertion after the deploy). */
export const POOLS_BASKET = "amm-pools";
/** The active swap basket: token outputs the swap legs spend, keyed under `SWAP_PROTOCOL`. */
export const SWAP_BASKET = "amm-swap";
/** The exchange's own key protocol for `amm-swap` outputs (counterparty self, a fresh keyID per output). */
export const SWAP_PROTOCOL: WalletProtocol = [2, "amm swap"];
/** BRC-100's largest `limit`. */
export const LIST_LIMIT = 10000;

/** customInstructions of an `amm-swap` output: the asset, the amount and the key that spends it. */
export function swapInstructions(o: { assetId: string; amount: bigint; protocolID: WalletProtocol; keyID: string; counterparty: string }): string {
  return JSON.stringify({ assetId: o.assetId, amount: String(o.amount), protocolID: o.protocolID, keyID: o.keyID, counterparty: o.counterparty });
}

/**
 * customInstructions of an `amm-swap` SATS output (0.29.0): a swap leg's sats (the miner fee; sats
 * in, also the amount in and the token payout's sat), staged in the swap basket by the same send as
 * the tokens; `sats: true` tells it from a token row; `assetId` (0.29.1) names the token whose swap
 * staged it (Move back sweeps it with that token's rows). The key that spends it, as for a token row.
 */
export function swapSatsInstructions(o: { assetId: string; protocolID: WalletProtocol; keyID: string; counterparty: string }): string {
  return JSON.stringify({ sats: true, assetId: o.assetId, protocolID: o.protocolID, keyID: o.keyID, counterparty: o.counterparty });
}

/** `p color balance <assetTag>`: the selector of one asset's value balance. */
export function balanceSelector(assetId: string): string {
  return `p color balance ${assetTag(assetId)}`;
}

/** One asset's value balance, exact (`p color balance <assetTag>` answers it as a decimal string in `totalOutputs`). */
export async function assetBalance(wallet: WalletInterface, assetId: string): Promise<bigint> {
  const r = await wallet.listOutputs({ basket: balanceSelector(assetId) });
  return BigInt(String(r.totalOutputs));
}

/** One held token output as `p color assets` lists it. */
export interface HeldOutput {
  /** `txid.vout` */
  outpoint: string;
  satoshis: number;
  lockingScript: string;
  /** False when an action in progress holds it (the module's `color_state_reserved`). */
  available: boolean;
}

/** `p color assets`: every token output the module holds, with locking scripts (the page reads asset and amount from them). */
export async function heldOutputs(wallet: WalletInterface): Promise<HeldOutput[]> {
  const r = await wallet.listOutputs({ basket: ASSETS_SELECTOR, include: "locking scripts", limit: LIST_LIMIT });
  return r.outputs
    .filter((o) => typeof o.lockingScript === "string")
    .map((o) => ({ outpoint: o.outpoint, satoshis: o.satoshis, lockingScript: o.lockingScript!, available: o.spendable !== false }));
}

/** A module receiving key for one output of `assetId` from `senderIdentityKey`: its receipt, key and hash160. */
export interface ReceivingKey {
  receipt: ColorReceipt;
  publicKey: string;
  /** hash160 of the key, hex: the P2PKH remainder of the 1Color output. */
  pkh: string;
}

/** A receiving key: random prefix and suffix unless `derivation` names them (0.29.1: a swap leg's, derived from its input). */
export async function newReceivingKey(
  wallet: WalletInterface,
  assetId: string,
  senderIdentityKey: string,
  derivation?: { derivationPrefix: string; derivationSuffix: string },
): Promise<ReceivingKey> {
  const derivationPrefix = derivation?.derivationPrefix ?? randomBase64(16);
  const derivationSuffix = derivation?.derivationSuffix ?? randomBase64(16);
  const { publicKey } = await wallet.getPublicKey({
    protocolID: colorProtocolID(assetId, derivationPrefix, derivationSuffix),
    keyID: COLOR_KEY_ID,
    counterparty: senderIdentityKey,
    forSelf: true,
  });
  return {
    receipt: { assetId, derivationPrefix, derivationSuffix, senderIdentityKey },
    publicKey,
    pkh: Utils.toHex(PublicKey.fromString(publicKey).toHash() as number[]),
  };
}

/** The receipt's `basket insertion` into the asset's value basket, for `internalizeAction`. */
export function receiptOutput(outputIndex: number, receipt: ColorReceipt): InternalizeOutput {
  return {
    outputIndex,
    protocol: "basket insertion",
    insertionRemittance: { basket: assetBasket(receipt.assetId, "value"), customInstructions: colorReceiptInstructions(receipt) },
  };
}

/** The `p color plan` labels of a transfer of `assetId` (BRC-207 plan version 1). */
export function transferPlanLabels(
  assetId: string,
  o: { ownedOutputs?: ColorRemittance[]; inputPositions?: { outpoint: string; index: number }[] } = {},
): string[] {
  return ColorPlan.toLabels({
    version: 1,
    assets: [assetId],
    ownedOutputs: o.ownedOutputs ?? [],
    operations: [{ assetId, operation: "transfer" }],
    inputPositions: o.inputPositions ?? [],
    changePositions: [],
    sighashTypes: [],
  });
}

/**
 * A module token action to its signed transaction: `createAction`, then,
 * when the wallet hands the action back for signing (an explicit input the
 * page names), `signAction` with no spends of the page's own (the module
 * signs its inputs). Aborted on a failure after the action exists.
 */
export async function runTokenAction(wallet: WalletInterface, args: CreateActionArgs): Promise<{ txid: string; tx: number[] }> {
  const created = await wallet.createAction(args);
  if (created.signableTransaction) {
    const reference = created.signableTransaction.reference;
    try {
      const signed = await wallet.signAction({ reference, spends: {}, ...(args.options?.acceptDelayedBroadcast !== undefined ? { options: { acceptDelayedBroadcast: args.options.acceptDelayedBroadcast } } : {}) });
      if (!signed.txid || !signed.tx) throw new Error("the wallet returned no signed transaction");
      return { txid: signed.txid, tx: Array.from(signed.tx) };
    } catch (err) {
      await wallet.abortAction({ reference }).catch(() => undefined);
      throw err;
    }
  }
  if (!created.txid || !created.tx) throw new Error("the wallet returned no transaction");
  return { txid: created.txid, tx: Array.from(created.tx) };
}
