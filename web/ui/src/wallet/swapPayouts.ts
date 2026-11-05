/**
 * Swap legs left in the wallet, settled silently (skein-amm 0.34.0; D18, D24, David Case
 * 2026-11-04). No browser store: the leg's staged rows in the `amm-swap` basket ARE the note — each
 * row's keyID names the pool outpoint the leg was quoted on (`amm-swap-<txid>.<vout>` /
 * `…:sats`, src/market/activeSwap.ts `swapKeyID`). On Your tokens load (`settleStagedSwaps`),
 * reads only, no resend, nothing shown:
 *
 *   1. the rows grouped by token and pool outpoint;
 *   2. per token, ONE `GET /@<token>/amm/spends?outpoint=a,b` (P8): each pool's spender;
 *   3. a spender: its transaction, `GET /@<token>/amm/tx?id=` (P9: the BEEF as admitted, every
 *      input's source with it); an output paying this wallet's leg key (`swapPayoutOf`, re-derived
 *      from the transaction's own inputs) → the wallet takes it in (`internalizeAction`, which also
 *      marks the staged rows it spends spent); no such output (another's swap) → nothing, the rows
 *      stay the user's;
 *   4. a pool not spent → nothing (the validator checks no expiry: the leg may still land).
 *
 * Any failed read or take-in: nothing, the next load tries again.
 */
import { PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface, type WalletOutput } from "@bsv/sdk";
import { WALLET_PAYMENT, brc29PublicKey, identityKeyOf, p2pkhHexOf } from "./brc29";
import { SWAP_BASKET, newReceivingKey, receiptOutput } from "./color";
import { PoolTemplate, decodeOneColor } from "../pool";
import { parseTokenId, sdkTokenId, tokenIdOfWire, tokenIdText } from "../lib/tokenId";
import { legDerivation, legKeyInputOf } from "../market/swapAction";
import { tokenP2pkhScript } from "../lp/poolDeploy";
import { basketRows } from "../lp/wallet";
import { readSpends, readTx } from "../lib/overlay";

/**
 * Whether output `vout` of `tx` (a swap: the pool at input 0 and output 0) pays this wallet's leg
 * key, re-derived from the transaction's own inputs (`legDerivation`): the take-in for it, or null.
 * A 1Color output is a receipt (sender the pool's validator), a P2PKH one a BRC-29 payment.
 */
export async function swapPayoutOf(wallet: WalletInterface, tx: Transaction, vout: number, tokenId: string): Promise<InternalizeOutput | null> {
  const pool = tx.outputs[0] ? PoolTemplate.decode(tx.outputs[0].lockingScript) : null;
  const out = tx.outputs[vout];
  const first = tx.outputs[1];
  if (!pool || !out || !first || vout < 1 || tx.inputs.length < 2) return null;
  const bsvIn = decodeOneColor(first.lockingScript.toBinary()) !== null;
  let keyInput: string;
  try {
    keyInput = legKeyInputOf(tx, bsvIn);
  } catch {
    return null;
  }
  const d = legDerivation(keyInput, vout === 1 ? "payout" : "commission");
  const script = out.lockingScript.toHex();
  const token = decodeOneColor(out.lockingScript.toBinary());
  if (token) {
    const sdkId = sdkTokenId(tokenId);
    const k = await newReceivingKey(wallet, sdkId, pool.state.validatorIdentity, d);
    return tokenP2pkhScript(sdkId, token.amount, k.publicKey) === script ? receiptOutput(vout, k.receipt) : null;
  }
  const identity = await identityKeyOf(wallet);
  const pub = await brc29PublicKey(wallet, d);
  if (p2pkhHexOf(PublicKey.fromString(pub).toString()) !== script) return null;
  return { outputIndex: vout, protocol: WALLET_PAYMENT, paymentRemittance: { ...d, senderIdentityKey: identity } };
}

/** The pool outpoint (`<txid>.<vout>`) an `amm-swap` row was staged for, from its keyID; null for another row. */
export function stagedPoolOf(row: Pick<WalletOutput, "customInstructions">): string | null {
  let ci: { keyID?: unknown } = {};
  try {
    ci = JSON.parse(row.customInstructions ?? "{}");
  } catch {
    return null;
  }
  const m = typeof ci.keyID === "string" ? /^amm-swap-([0-9a-f]{64})\.(\d+)(:sats)?$/.exec(ci.keyID) : null;
  return m ? `${m[1]}.${m[2]}` : null;
}

/** The token an `amm-swap` row is staged for: its 1Color script's, else (a sats row) its customInstructions' `assetId`. */
export function stagedTokenOf(row: Pick<WalletOutput, "lockingScript" | "customInstructions">): string | null {
  if (row.lockingScript) {
    const t = decodeOneColor(Utils.toArray(row.lockingScript, "hex"));
    if (t && t.role === "value" && t.idBytes) return tokenIdOfWire(t.idBytes);
  }
  try {
    const ci = JSON.parse(row.customInstructions ?? "{}") as { assetId?: unknown };
    const ref = typeof ci.assetId === "string" ? parseTokenId(ci.assetId) : null;
    return ref ? tokenIdText(ref) : null;
  } catch {
    return null;
  }
}

/** The staged legs: token → the pool outpoints its rows were staged for. */
export function stagedLegs(rows: Pick<WalletOutput, "lockingScript" | "customInstructions">[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const pool = stagedPoolOf(r);
    const token = pool ? stagedTokenOf(r) : null;
    if (!pool || !token) continue;
    const s = out.get(token) ?? new Set<string>();
    s.add(pool);
    out.set(token, s);
  }
  return out;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The silent pass (see the module comment): → the txids taken in. Never throws. */
export async function settleStagedSwaps(wallet: WalletInterface, baseOf: (tokenId: string) => string, fetchFn?: FetchFn): Promise<string[]> {
  const taken: string[] = [];
  let rows: WalletOutput[];
  try {
    rows = await basketRows(wallet, SWAP_BASKET);
  } catch {
    return taken;
  }
  for (const [tokenId, pools] of stagedLegs(rows)) {
    try {
      const base = baseOf(tokenId);
      const spends = await readSpends(base, [...pools], fetchFn);
      const spenders = [...new Set(spends.map((s) => s.spentBy).filter((t): t is string => typeof t === "string"))];
      for (const txid of spenders) {
        try {
          const beef = await readTx(base, txid, fetchFn);
          if (!beef) continue;
          const tx = Transaction.fromAtomicBEEF(beef);
          const outputs: InternalizeOutput[] = [];
          for (let vout = 1; vout < tx.outputs.length; vout++) {
            const o = await swapPayoutOf(wallet, tx, vout, tokenId);
            if (o) outputs.push(o);
          }
          if (outputs.length === 0) continue;
          const r = await wallet.internalizeAction({ tx: beef, outputs, description: "AMM swap payout", labels: ["amm-swap"] });
          if (r.accepted) taken.push(txid);
        } catch {
          /* the next load */
        }
      }
    } catch {
      /* the next load */
    }
  }
  return taken;
}
