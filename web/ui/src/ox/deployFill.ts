/**
 * The deploy form's two amounts at the market rate: the field the user last
 * typed in is the source, the other follows at `price` (sats per whole token,
 * the "market price now" number). No market price → nothing follows.
 */
import { formatAmount } from "../lp/amounts";
import { parseInput } from "./format";

export type DeploySource = "tokens" | "sats";

/** The other field's text for `text` typed in `source`; null = leave the other as it is (no market). */
export function followAmount(source: DeploySource, text: string, price: number | null, dec: number): string | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const v = parseInput(text, source === "tokens" ? dec : 0);
  if (v === null) return "";
  if (source === "tokens") {
    // tokens × price, whole sats, rounded.
    return BigInt(Math.round((Number(v) / 10 ** dec) * price)).toString();
  }
  // sats ÷ price, in the token's decimals (base units rounded).
  return formatAmount(BigInt(Math.round((Number(v) / price) * 10 ** dec)), dec);
}
