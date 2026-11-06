/**
 * The active swap basket (skein-amm 0.12.0, David Case 2026-10-21/22; 0.40.0, agent-env
 * plans/swap-balance-build-2026-11-05.md §0 7, Builder 2 item 2): what a swap stages for its legs,
 * held outside the BRC-207 module in the exchange's own basket `amm-swap` (src/wallet/color.ts).
 * No deposit, no withdraw, no balance the user manages.
 *
 *   - **Staging** (`stage`): at Swap, ONE wallet action. Sats only (a buy, or a sell whose tokens
 *     the basket holds): a plain createAction, ONE P2PKH output to a fresh key under `SWAP_PROTOCOL`
 *     (self, keyID random, `amm-swap-<hex>`), filed in `amm-swap` by the action with its
 *     customInstructions (`{sats: true, protocolID, keyID, counterparty}`: no token tag). With
 *     tokens: the module transfer plan — ONE token output to a fresh key and the ONE sats output in
 *     the same action, the token key's id ALSO in that output's description (`… · amm-swap <hex>`,
 *     as the LP key's `amm-lp <hex>`), the action labelled `SWAP_STAGE_LABEL`; the module selects
 *     the token inputs, adds change, signs and submits; the page submits it too, then files the
 *     token output in `amm-swap` (basket insertion, `{assetId, amount, protocolID, keyID,
 *     counterparty}`). A labelled staged token output the basket lacks (the page died before the
 *     filing) is filed on load from the action's description (`unfiledStagedTokens`).
 *   - **Spent** by the legs (src/market/swapAction.ts), their change kept here between legs.
 *   - **Move back** (`moveBack`, as 0.29.3): ONE createAction through the wallet's BRC-207 module,
 *     a `p color plan` transfer: every `amm-swap` token row of the token and every sats row as
 *     explicit inputs (their source transactions in `inputBEEF`), one output — the whole amount to
 *     a NEW module receiving key of the user's own, the plan's owned output 0. The page unlocks its
 *     inputs at signAction; the wallet funds the fee and takes the sats into its change. With no
 *     token row and sats rows staged: one plain createAction, the sats rows as explicit inputs and
 *     no outputs (`moveBackSats`).
 */
import { Beef, P2PKH, PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface } from "@bsv/sdk";
import { decodeOneColor } from "../pool/index.js";
import { parseOutpoint, parseTokenId, sdkTokenId, tokenIdOfWire, tokenIdText } from "../lib/tokenId.js";
import { basketBeef, basketRows } from "../lp/wallet.js";
import { tokenP2pkhScript } from "../lp/poolDeploy.js";
import { steakText, submitToOverlay, type Steak } from "../lp/close.js";
import { SWAP_BASKET, SWAP_PROTOCOL, newReceivingKey, swapInstructions, swapSatsInstructions, runTokenAction, transferPlanLabels } from "../wallet/color.js";
import { identityKeyOf } from "../wallet/brc29.js";
import { inputIndexOf, runAppSignedAction, type Spends } from "../wallet/action.js";
import { P2PKH_UNLOCK_LENGTH, satsInputsOf, signP2pkhWithWallet, spendValid, tokenInputsOf, type SatsInput, type TokenInput } from "./swapAction.js";

/** The keyID prefix of an `amm-swap` key (`SWAP_PROTOCOL`, counterparty self). */
export const SWAP_KEY_PREFIX = "amm-swap-";

/** The label of a staging action that carries tokens (0.40.0): the staged token output's key id is in its output description. */
export const SWAP_STAGE_LABEL = "amm-swap-stage";

/** The marker a staged token output's description ends with (` · amm-swap <hex>`, 0.40.0): it names the key id. */
export const SWAP_KEY_MARK = " · amm-swap ";

function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** A staged row's keyID (0.40.0): `amm-swap-<16 random bytes, hex>`. */
export function newSwapKeyID(): string {
  return `${SWAP_KEY_PREFIX}${Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(16))))}`;
}

/** A staged token output's description: the readable text (at most 50 characters), then `SWAP_KEY_MARK` and the keyID's hex. */
export function swapKeyDescription(readable: string, keyID: string): string {
  const hex = keyID.startsWith(SWAP_KEY_PREFIX) ? keyID.slice(SWAP_KEY_PREFIX.length) : "";
  if (!/^[0-9a-f]{2,128}$/.test(hex)) throw new Error(`not a staged key id: ${keyID}`);
  return `${describe(readable)}${SWAP_KEY_MARK}${hex}`;
}

/** The keyID a staged token output's description names (`swapKeyDescription`), or null. */
export function swapKeyIdOfDescription(description: string | undefined): string | null {
  const m = / · amm-swap ([0-9a-f]{2,128})$/.exec(description ?? "");
  return m && m[1]!.length % 2 === 0 ? `${SWAP_KEY_PREFIX}${m[1]}` : null;
}

/** The `amm-swap` outputs of `tokenId` the legs can spend. */
export async function swapHoldings(wallet: WalletInterface, tokenId: string): Promise<TokenInput[]> {
  return tokenInputsOf(await basketRows(wallet, SWAP_BASKET), tokenId);
}

/** The `amm-swap` sats outputs the legs can spend (0.29.0). */
export async function swapSatsHoldings(wallet: WalletInterface): Promise<SatsInput[]> {
  return satsInputsOf(await basketRows(wallet, SWAP_BASKET));
}

/** What `amm-swap` holds, per token id: the token amount and the number of token outputs (0.40.0: the sats rows are no token's, `swapSatsTotal`). */
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

/** The sats `amm-swap` holds (0.40.0: shown once, not per token). */
export async function swapSatsTotal(wallet: WalletInterface): Promise<number> {
  return (await swapSatsHoldings(wallet)).reduce((a, r) => a + r.satoshis, 0);
}

/** The source transactions of `amm-swap`'s outputs (a leg's BEEF), with `extra` merged in. */
export async function swapHoldingBeef(wallet: WalletInterface, extra?: number[]): Promise<Beef> {
  const beef = (await basketBeef(wallet, SWAP_BASKET)) ?? new Beef();
  if (extra) beef.mergeBeef(Beef.fromBinary(extra));
  return beef;
}

/** What a staging action made (0.40.0): the sats row and, with tokens, the token row. */
export interface Staged {
  txid: string;
  /** The action as the wallet's AtomicBEEF. */
  tx: number[];
  /** The sats row (absent: tokens staged with no sats lacking). */
  sats?: SatsInput;
  tokens?: TokenInput;
  /** The token row filed in `amm-swap` (with tokens). */
  filed: boolean;
  submitted: string;
  errors: string[];
}

/** What one staging action puts into `amm-swap` (0.40.0): sats, and (a sell the basket does not cover) tokens of one token. */
export interface StageRequest {
  sats: number;
  tokens?: { tokenId: string; amount: bigint };
}

/**
 * Staging (see the module comment): ONE wallet action. Throws when the wallet refuses or fails it;
 * the token row's filing and the page's own submit are reported in `errors`.
 */
export async function stage(
  wallet: WalletInterface,
  req: StageRequest,
  o: { sym?: string; submit?: (topic: string, beef: number[]) => Promise<{ steak?: Steak }> } = {},
): Promise<Staged> {
  // The sats output: what the basket lacks of the fee sats (with tokens it may lack none).
  if (!Number.isSafeInteger(req.sats) || req.sats < 0 || (req.sats === 0 && !req.tokens)) throw new Error("nothing to stage in the swap basket");
  const sym = o.sym ?? "token";
  const satsKeyID = newSwapKeyID();
  const satsPub = (await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID: satsKeyID, counterparty: "self", forSelf: true })).publicKey;
  const satsScript = new P2PKH().lock(PublicKey.fromString(satsPub).toAddress()).toHex();
  const satsOutput = {
    lockingScript: satsScript,
    satoshis: req.sats,
    outputDescription: describe(`Sats for a ${sym} swap`),
    basket: SWAP_BASKET,
    customInstructions: swapSatsInstructions({ protocolID: SWAP_PROTOCOL, keyID: satsKeyID, counterparty: "self" }),
  };
  const satsRow = (txid: string, vout: number): SatsInput => ({ outpoint: `${txid}.${vout}`, txid, vout, satoshis: req.sats, lockingScript: satsScript, protocolID: SWAP_PROTOCOL, keyID: satsKeyID, counterparty: "self" });
  if (!req.tokens) {
    const { txid, tx } = await runTokenAction(wallet, {
      description: describe("AMM swap: sats into the swap basket"),
      labels: ["amm-swap"],
      outputs: [satsOutput],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    });
    const final = Transaction.fromAtomicBEEF(tx);
    if (final.outputs[0]?.lockingScript.toHex() !== satsScript) throw new Error("the wallet's action has no output 0 to the swap key");
    return { txid, tx, sats: satsRow(txid, 0), filed: false, submitted: "not submitted (no token moved)", errors: [] };
  }
  const { tokenId, amount } = req.tokens;
  if (amount <= 0n) throw new Error("nothing to stage in the swap basket");
  const assetId = sdkTokenId(tokenId);
  const keyID = newSwapKeyID();
  const pub = (await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", forSelf: true })).publicKey;
  const tokenScript = tokenP2pkhScript(assetId, amount, pub);
  const { txid, tx } = await runTokenAction(wallet, {
    description: describe(`AMM swap: ${sym} into the swap basket`),
    labels: [...transferPlanLabels(assetId), "amm-swap", SWAP_STAGE_LABEL],
    outputs: [{ lockingScript: tokenScript, satoshis: 1, outputDescription: swapKeyDescription(`${sym} for a swap`, keyID) }, ...(req.sats > 0 ? [satsOutput] : [])],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  const final = Transaction.fromAtomicBEEF(tx);
  if (final.outputs[0]?.lockingScript.toHex() !== tokenScript || (req.sats > 0 && final.outputs[1]?.lockingScript.toHex() !== satsScript)) throw new Error("the wallet's action does not have the staged outputs at 0 and 1");
  const out: Staged = {
    txid,
    tx,
    ...(req.sats > 0 ? { sats: satsRow(txid, 1) } : {}),
    tokens: { outpoint: `${txid}.0`, txid, vout: 0, satoshis: 1, lockingScript: tokenScript, amount, protocolID: SWAP_PROTOCOL, keyID, counterparty: "self" },
    filed: false,
    submitted: "not submitted",
    errors: [],
  };
  try {
    if (o.submit) out.submitted = steakText(await o.submit(`tm_color_${assetId}`, tx));
  } catch (err) {
    out.submitted = "the submit failed";
    out.errors.push(`submit: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const r = await wallet.internalizeAction({
      tx,
      outputs: [{ outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: SWAP_BASKET, customInstructions: swapInstructions({ assetId, amount, protocolID: SWAP_PROTOCOL, keyID, counterparty: "self" }) } }],
      description: describe(`AMM swap: ${sym} into the swap basket`),
      labels: ["amm-swap"],
    });
    out.filed = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** A staged token output the basket lacks (0.40.0): its outpoint, token, amount and the key its description names. */
export interface UnfiledStaged {
  txid: string;
  vout: number;
  tokenId: string;
  amount: bigint;
  keyID: string;
}

/**
 * The labelled staging actions' token outputs not in `amm-swap` (0.40.0): every output of an action
 * labelled `SWAP_STAGE_LABEL` whose description names a staged key and whose script is a 1Color
 * value output, its basket not `amm-swap`. A wallet that refuses the read: none.
 */
export async function unfiledStagedTokens(wallet: WalletInterface): Promise<UnfiledStaged[]> {
  const out: UnfiledStaged[] = [];
  try {
    const r = await wallet.listActions({ labels: [SWAP_STAGE_LABEL], includeOutputs: true, includeOutputLockingScripts: true, limit: 1000 } as Parameters<WalletInterface["listActions"]>[0]);
    for (const a of r.actions ?? []) {
      for (const o of a.outputs ?? []) {
        const keyID = swapKeyIdOfDescription(o.outputDescription);
        const t = keyID && o.lockingScript ? decodeOneColor(Utils.toArray(o.lockingScript, "hex")) : null;
        if (!keyID || !t || t.role !== "value" || !t.idBytes || o.basket === SWAP_BASKET) continue;
        out.push({ txid: a.txid, vout: o.outputIndex, tokenId: tokenIdOfWire(t.idBytes), amount: t.amount, keyID });
      }
    }
  } catch {
    /* no history read: none */
  }
  return out;
}

/** One unfiled staged token output filed in `amm-swap` from its transaction's BEEF (basket insertion, as `stage` files it). */
export async function fileStagedToken(wallet: WalletInterface, u: UnfiledStaged, beef: number[]): Promise<boolean> {
  const r = await wallet.internalizeAction({
    tx: beef,
    outputs: [{ outputIndex: u.vout, protocol: "basket insertion", insertionRemittance: { basket: SWAP_BASKET, customInstructions: swapInstructions({ assetId: sdkTokenId(u.tokenId), amount: u.amount, protocolID: SWAP_PROTOCOL, keyID: u.keyID, counterparty: "self" }) } }],
    description: "AMM swap: a staged token filed",
    labels: ["amm-swap"],
  });
  return r.accepted;
}

export interface MovedBack {
  txid: string;
  amount: bigint;
  /** The transaction as the wallet's AtomicBEEF. */
  beef: number[];
  submitted: string;
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
 * "Move back" (see the module comment; 0.29.3: a module plan). Throws before anything is
 * broadcast (no outputs, a wallet or module refusal, an input that does not validate: the action
 * is aborted). The module files the output in `p color <assetTag>` with its custody in the same
 * createAction: no take-in afterwards, nothing kept in the browser. The page's own submit to this
 * skein's token topic (the module submitted at the wallet's overlay too) is reported in `errors`.
 */
export async function moveBack(i: {
  wallet: WalletInterface;
  base: string;
  tokenId: string;
  meta?: { sym?: string };
  submit?: (topic: string, beef: number[]) => Promise<{ steak?: Steak }>;
}): Promise<MovedBack> {
  const { wallet } = i;
  const assetId = sdkTokenId(i.tokenId);
  const sym = i.meta?.sym ?? "token";
  const topic = `tm_color_${assetId}`;
  const rows = await basketRows(wallet, SWAP_BASKET);
  const holdings = tokenInputsOf(rows, assetId);
  // 0.40.0: every sats row goes in too (they are no token's); the wallet's change takes their sats.
  const satsRows = satsInputsOf(rows);
  if (holdings.length === 0 && satsRows.length > 0) return await moveBackSats(wallet, sym, satsRows);
  if (holdings.length === 0) throw new Error(`the swap basket holds no ${sym}`);
  const amount = holdings.reduce((a, h) => a + h.amount, 0n);
  const sources = await swapHoldingBeef(wallet);
  for (const h of [...holdings, ...satsRows]) if (!sources.findTxid(h.txid)) throw new Error(`the wallet's BEEF lacks the swap basket output ${h.outpoint}`);

  // The output: the whole amount to a module receiving key of the user's own, the plan's owned output 0.
  const me = await identityKeyOf(wallet);
  const key = await newReceivingKey(wallet, assetId, me);
  const lockingScript = tokenP2pkhScript(assetId, amount, key.publicKey);
  const { txid, tx: beef } = await runAppSignedAction(
    wallet,
    {
      description: describe(`AMM move back: ${sym}`),
      inputBEEF: sources.toBinary(),
      inputs: [
        ...holdings.map((h) => ({ outpoint: h.outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: describe(`${sym} in the swap basket`) })),
        ...satsRows.map((h) => ({ outpoint: h.outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: describe("Sats in the swap basket") })),
      ],
      outputs: [{ lockingScript, satoshis: 1, outputDescription: describe(`${sym} back to your wallet`) }],
      labels: [...transferPlanLabels(assetId, { ownedOutputs: [{ outputIndex: 0, ...key.receipt }] }), "amm-swap"],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    (tx) => swapBasketSpends(wallet, tx, [...holdings, ...satsRows], "move back"),
  );
  const out: MovedBack = { txid, amount, beef, submitted: "not submitted", errors: [] };
  try {
    out.submitted = steakText(await (i.submit ?? ((t: string, b: number[]) => submitToOverlay(i.base, t, b)))(topic, beef));
  } catch (err) {
    out.submitted = "the submit failed";
    out.errors.push(`submit: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/**
 * Move back with only sats in the swap basket (0.29.6, David Case 2026-11-03; 0.40.0: every sats
 * row, `satsRows` default the basket's): ONE plain wallet createAction (no `p color` labels, the module
 * is not in the path) with the token's `amm-swap` sats rows as explicit inputs (their sources in
 * `inputBEEF`) and NO outputs: the wallet keeps everything as its change and pays the fee from it.
 * The page unlocks the rows at signAction; the wallet broadcasts and marks the rows spent itself
 * (no relinquish, no take-in, nothing kept). Nothing is submitted to an overlay (no token moves).
 */
export async function moveBackSats(wallet: WalletInterface, sym = "the swap", satsRows?: SatsInput[]): Promise<MovedBack> {
  satsRows ??= await swapSatsHoldings(wallet);
  if (satsRows.length === 0) throw new Error("the swap basket holds no sats");
  const sources = await swapHoldingBeef(wallet);
  for (const h of satsRows) if (!sources.findTxid(h.txid)) throw new Error(`the wallet's BEEF lacks the swap basket output ${h.outpoint}`);
  const { txid, tx: beef } = await runAppSignedAction(
    wallet,
    {
      description: describe(`AMM move back: ${sym} sats`),
      inputBEEF: sources.toBinary(),
      inputs: satsRows.map((h) => ({ outpoint: h.outpoint, unlockingScriptLength: P2PKH_UNLOCK_LENGTH, inputDescription: describe("Sats in the swap basket") })),
      outputs: [],
      labels: ["amm-swap"],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    (tx) => swapBasketSpends(wallet, tx, satsRows, "move back"),
  );
  return { txid, amount: 0n, beef, submitted: "not submitted (no token moved)", errors: [] };
}
