/**
 * Resolve from the overlay (skein-amm 0.40.0, agent-env plans/swap-balance-build-2026-11-05.md
 * Builder 2 item 5): the overlay is the truth about an `amm-swap` row, not the wallet's own flag.
 * On load, before a swap starts, and after any refused or rejected leg (`resolveFromOverlay`):
 *
 *   1. every `amm-swap` row (src/market/activeSwap.ts) asked in ONE read of the host's
 *      `GET <origin>/amm/spends?outpoint=a,b` (each enabled token's `/spends`, the first naming a
 *      spender);
 *   2. a spender: its transaction, `GET /@<token>/amm/tx?id=` (the BEEF as admitted, every input's
 *      source with it); the payout key tried with the spent row's `order` (when it has one) and with
 *      the transaction's own key input (`legDerivation`; its first token input on a sell, its first
 *      sats input on a buy);
 *   3. a match → the leg's take-in (`legTakeInOf`: the payout, the taker's own commission, the
 *      change — kept in `amm-swap` with the order, or the last leg's to the wallet), ONE
 *      `internalizeAction` (taking in a transaction the wallet already holds is harmless and
 *      re-marks its inputs spent); no match → nothing;
 *   4. again, until no row has a spender the wallet lacks (a take-in's change rows may be spent by
 *      a later leg whose page was lost).
 *
 * Any failed read or take-in: nothing, the next pass tries again. 0.34.0's pool-outpoint grouping
 * of staged rows is gone.
 */
import { Transaction, type InternalizeOutput, type WalletInterface, type WalletOutput } from "@bsv/sdk";
import { WALLET_PAYMENT, brc29PublicKey, identityKeyOf, p2pkhHexOf } from "./brc29.js";
import { SWAP_BASKET, SWAP_PROTOCOL, newReceivingKey, receiptOutput, swapInstructions, swapSatsInstructions } from "./color.js";
import { PoolTemplate, decodeOneColor } from "../pool/index.js";
import { parseOutpoint, sdkTokenId } from "../lib/tokenId.js";
import { changeKeyID, legDerivation, legInputsOf } from "../market/swapAction.js";
import { tokenP2pkhScript } from "../lp/poolDeploy.js";
import { basketRows } from "../lp/wallet.js";
import type { SpendAll } from "../lib/overlay.js";

/** A row's `order` (its customInstructions'), or undefined. */
function orderOf(row: Pick<WalletOutput, "customInstructions">): string | undefined {
  try {
    const ci = JSON.parse(row.customInstructions ?? "{}") as { order?: unknown };
    return typeof ci.order === "string" ? ci.order : undefined;
  } catch {
    return undefined;
  }
}

/** The swap's own key input (`legDerivation`'s): its first token input on a sell, its first sats input on a buy; null without one. */
export function ownKeyInputOf(tx: Transaction): string | null {
  const first = tx.outputs[1];
  if (!first) return null;
  const bsvIn = decodeOneColor(first.lockingScript.toBinary()) !== null;
  const ins = legInputsOf(tx);
  return (bsvIn ? ins.sats[0] : ins.tokens[0]) ?? null;
}

/**
 * The take-in of a swap leg (a pool at input 0 and output 0) under the order `order`: output 1 must
 * pay the order's payout key (else null: another's swap); then each other output that pays one of
 * the order's keys — the taker's own commission, the change kept in `amm-swap` (the keyID of the
 * leg's first input of that kind, the customInstructions with `order`), or the last leg's change to
 * the wallet (`legDerivation(order, "change")`). A 1Color output is a receipt for self (sender the
 * user), a P2PKH one a BRC-29 payment or a basket insertion.
 */
export async function legTakeInOf(wallet: WalletInterface, tx: Transaction, tokenId: string, order: string): Promise<InternalizeOutput[] | null> {
  const pool = tx.outputs[0] ? PoolTemplate.decode(tx.outputs[0].lockingScript) : null;
  if (!pool || tx.outputs.length < 2 || tx.inputs.length < 2) return null;
  const identity = await identityKeyOf(wallet);
  const sdkId = sdkTokenId(tokenId);
  const ins = legInputsOf(tx);
  const keyed = async (vout: number, which: "payout" | "commission" | "change"): Promise<InternalizeOutput | null> => {
    const out = tx.outputs[vout]!;
    const d = legDerivation(order, which);
    const token = decodeOneColor(out.lockingScript.toBinary());
    if (token) {
      const k = await newReceivingKey(wallet, sdkId, identity, d);
      return tokenP2pkhScript(sdkId, token.amount, k.publicKey) === out.lockingScript.toHex() ? receiptOutput(vout, k.receipt) : null;
    }
    const pub = await brc29PublicKey(wallet, d);
    return p2pkhHexOf(pub) === out.lockingScript.toHex() ? { outputIndex: vout, protocol: WALLET_PAYMENT, paymentRemittance: { ...d, senderIdentityKey: identity } } : null;
  };
  const payout = await keyed(1, "payout");
  if (!payout) return null;
  const outs: InternalizeOutput[] = [payout];
  const swapKey = async (keyID: string) => (await wallet.getPublicKey({ protocolID: SWAP_PROTOCOL, keyID, counterparty: "self", forSelf: true })).publicKey;
  const satsChange = ins.sats[0] ? { keyID: changeKeyID(ins.sats[0]), pub: await swapKey(changeKeyID(ins.sats[0])) } : null;
  const tokenChange = ins.tokens[0] ? { keyID: changeKeyID(ins.tokens[0]), pub: await swapKey(changeKeyID(ins.tokens[0])) } : null;
  for (let vout = 2; vout < tx.outputs.length; vout++) {
    const out = tx.outputs[vout]!;
    const script = out.lockingScript.toHex();
    const token = decodeOneColor(out.lockingScript.toBinary());
    if (token && tokenChange && tokenP2pkhScript(sdkId, token.amount, tokenChange.pub) === script) {
      outs.push({ outputIndex: vout, protocol: "basket insertion", insertionRemittance: { basket: SWAP_BASKET, customInstructions: swapInstructions({ assetId: sdkId, amount: token.amount, protocolID: SWAP_PROTOCOL, keyID: tokenChange.keyID, counterparty: "self", order }) } });
      continue;
    }
    if (!token && satsChange && p2pkhHexOf(satsChange.pub) === script) {
      outs.push({ outputIndex: vout, protocol: "basket insertion", insertionRemittance: { basket: SWAP_BASKET, customInstructions: swapSatsInstructions({ protocolID: SWAP_PROTOCOL, keyID: satsChange.keyID, counterparty: "self", order }) } });
      continue;
    }
    const mine = (await keyed(vout, "commission")) ?? (await keyed(vout, "change"));
    if (mine) outs.push(mine);
  }
  return outs;
}

type FetchTx = (tokenId: string, txid: string) => Promise<number[] | null>;

/** A leg the pass took in: its transaction, its token, the outpoints it spends (`<txid>.<vout>`, the pool's first) and its payout output. */
export interface ResolvedLeg {
  txid: string;
  tokenId: string;
  inputs: string[];
  payout: { satoshis: number; tokens?: bigint };
}

/** The pass (see the module comment): → the legs taken in. Never throws. */
export async function resolveFromOverlay(wallet: WalletInterface, reads: { spendsAll: (outpoints: string[]) => Promise<SpendAll[]>; tx: FetchTx }): Promise<ResolvedLeg[]> {
  const taken: ResolvedLeg[] = [];
  const tried = new Set<string>();
  for (let round = 0; round < 64; round++) {
    let rows: WalletOutput[];
    let spends: SpendAll[];
    try {
      rows = await basketRows(wallet, SWAP_BASKET);
      if (rows.length === 0) return taken;
      spends = await reads.spendsAll(rows.map((r) => r.outpoint.replace("_", ".")));
    } catch {
      return taken;
    }
    const byOutpoint = new Map(rows.map((r) => [r.outpoint.replace("_", "."), r]));
    let took = false;
    for (const s of spends) {
      if (!s.spentBy || !s.tokenId || tried.has(s.spentBy)) continue;
      tried.add(s.spentBy);
      try {
        const beef = await reads.tx(s.tokenId, s.spentBy);
        if (!beef) continue;
        const tx = Transaction.fromAtomicBEEF(beef);
        const op = parseOutpoint(s.outpoint);
        const row = op ? byOutpoint.get(`${op.txid}.${op.vout}`) : undefined;
        const orders = [...new Set([row ? orderOf(row) : undefined, ownKeyInputOf(tx) ?? undefined].filter((x): x is string => typeof x === "string"))];
        for (const order of orders) {
          const outputs = await legTakeInOf(wallet, tx, s.tokenId, order);
          if (!outputs) continue;
          const r = await wallet.internalizeAction({ tx: beef, outputs, description: "AMM swap payout", labels: ["amm-swap"] });
          if (r.accepted) {
            const out1 = tx.outputs[1]!;
            const t = decodeOneColor(out1.lockingScript.toBinary());
            taken.push({
              txid: s.spentBy,
              tokenId: s.tokenId,
              inputs: tx.inputs.map((i) => `${i.sourceTXID ?? i.sourceTransaction?.id("hex")}.${i.sourceOutputIndex}`),
              payout: { satoshis: out1.satoshis ?? 0, ...(t ? { tokens: t.amount } : {}) },
            });
            took = true;
          }
          break;
        }
      } catch {
        /* the next pass */
      }
    }
    if (!took) return taken;
  }
  return taken;
}
