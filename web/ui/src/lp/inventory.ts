/**
 * The token inventory from the wallet's BRC-207 module (skein-amm 0.12.0):
 * `p color assets`' outputs (src/wallet/color.ts `heldOutputs`), decoded
 * from their locking scripts with 1sat-sdk's `OneColor` (BRC-162), grouped
 * by asset id. The script is the authority for which asset an output holds;
 * the balance the page shows is the module's own (`p color balance
 * <assetTag>`, src/client.ts `myTokens`).
 *
 * Metadata (sym/dec/icon) comes from the overlay (the token list, else the
 * deploy lookup) and, for a deploy output the wallet holds, from the deploy
 * itself: a 1Color deploy's icon is the image embedded in it (BRC-162,
 * BRCs#308: `[mediaType, bytes]`).
 */
import { OneColor, type OneColorIcon } from "@1sat/templates";
import { Script } from "@bsv/sdk";
import type { ImageContent } from "./images.js";
import { parseOutpoint, tokenIdOfWire, tokenIdText } from "../lib/tokenId.js";

export type TokenRole = "deploy" | "value" | "authority";

export interface TokenMetadata {
  sym?: string;
  dec?: number;
  /** The image embedded in the deploy. */
  icon?: OneColorIcon;
}

export interface TokenOutput {
  /** `txid_vout` */
  outpoint: string;
  /** `<txid>_<vout>` for every token, `_0` included (src/lib/tokenId.ts). */
  tokenId: string;
  role: TokenRole;
  /** Base units; 0n on an authority (or an authority deploy). */
  amount: bigint;
  /** Deploys only. */
  metadata?: TokenMetadata;
}

export interface IconRef {
  /** The deploy the icon is embedded in, `txid_vout`. */
  outpoint: string;
  /** The bytes, when the deploy embeds an image. */
  image?: ImageContent;
}

export interface TokenSummary {
  tokenId: string;
  /** Sum of value outputs and a fixed-supply deploy, base units, as the scripts carry them. */
  balance: bigint;
  valueOutputs: number;
  /** Authority outputs, an authority deploy included. */
  authorities: number;
  deployInWallet: boolean;
  sym?: string;
  dec?: number;
  icon?: IconRef;
}

export interface Inventory {
  tokens: TokenSummary[];
  /** Outputs `OneColor` does not decode. */
  unrecognized: string[];
}

/** One held output → its token output, or undefined. */
export function decodeTokenRow(row: { outpoint: string; lockingScript?: string }): TokenOutput | undefined {
  if (!row.lockingScript) return undefined;
  const op = parseOutpoint(row.outpoint);
  if (!op) return undefined;
  const outpoint = `${op.txid}_${op.vout}`;
  let script: Script;
  try {
    script = Script.fromHex(row.lockingScript);
  } catch {
    return undefined;
  }
  const bin = OneColor.decode(script);
  if (!bin) return undefined;
  if (bin.role === "deploy") return { outpoint, tokenId: tokenIdText(op), role: "deploy", amount: bin.amount, metadata: bin.metadata ?? {} };
  // A 32-byte id is `<txid>_0`, a 36-byte one `<txid>_<vout>`.
  return { outpoint, tokenId: tokenIdOfWire(bin.idBytes!), role: bin.role, amount: bin.amount };
}

/** The icon embedded in a deploy (an image only; another media type shows no picture). */
export function deployIcon(deploy: TokenOutput): IconRef | undefined {
  const icon = deploy.metadata?.icon;
  if (icon === undefined) return undefined;
  if (!/^image\//i.test(icon.mediaType.trim()) || icon.bytes.length === 0) return { outpoint: deploy.outpoint };
  return { outpoint: deploy.outpoint, image: { contentType: icon.mediaType, bytes: Uint8Array.from(icon.bytes), via: "embedded" } };
}

/** Group decoded rows by token, its id `<txid>_<vout>`. */
export function buildInventory(rows: { outpoint: string; lockingScript?: string }[]): Inventory {
  const byId = new Map<string, TokenSummary>();
  const unrecognized: string[] = [];
  for (const row of rows) {
    const t = decodeTokenRow(row);
    if (!t) {
      unrecognized.push(row.outpoint.replace(".", "_"));
      continue;
    }
    let s = byId.get(t.tokenId);
    if (!s) {
      s = { tokenId: t.tokenId, balance: 0n, valueOutputs: 0, authorities: 0, deployInWallet: false };
      byId.set(t.tokenId, s);
    }
    if (t.amount === 0n) s.authorities++;
    else {
      s.balance += t.amount;
      s.valueOutputs++;
    }
    if (t.role === "deploy") {
      s.deployInWallet = true;
      const m = t.metadata ?? {};
      if (m.sym !== undefined) s.sym = m.sym;
      if (m.dec !== undefined) s.dec = m.dec;
      const icon = deployIcon(t);
      if (icon) s.icon = icon;
    }
  }
  const tokens = [...byId.values()].sort(
    (a, b) => (a.sym ?? "￿").localeCompare(b.sym ?? "￿") || a.tokenId.localeCompare(b.tokenId),
  );
  return { tokens, unrecognized };
}
