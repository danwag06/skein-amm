/**
 * The wallet reads of the exchange's own baskets (skein-amm 0.12.0): the
 * LP's position rows (`amm-pools`) and the active swap basket (`amm-swap`),
 * src/wallet/color.ts. The user's tokens themselves are the BRC-207
 * module's (`p color assets`, `p color balance <assetTag>`), read there.
 * Nothing here talks to an overlay.
 */
import { Beef, type WalletInterface, type WalletOutput } from "@bsv/sdk";
import { LIST_LIMIT } from "../wallet/color.js";

/** A basket's outputs with locking scripts, tags and customInstructions. */
export async function basketRows(wallet: WalletInterface, basket: string): Promise<WalletOutput[]> {
  const r = await wallet.listOutputs({ basket, include: "locking scripts", includeTags: true, includeCustomInstructions: true, limit: LIST_LIMIT });
  return r.outputs;
}

/** A basket's source transactions (for a spend's BEEF), or null when the wallet answers none. */
export async function basketBeef(wallet: WalletInterface, basket: string): Promise<Beef | null> {
  const r = await wallet.listOutputs({ basket, include: "entire transactions", limit: LIST_LIMIT });
  return r.BEEF ? Beef.fromBinary(Array.from(r.BEEF)) : null;
}
