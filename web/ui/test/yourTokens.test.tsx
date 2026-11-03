/**
 * Your tokens (0.29.6): Dismiss on an Unfinished entry that is not final (a swap the validator never
 * signed) — removes the entry and nothing else; a final entry and an old-shape one (its own receipt
 * or remittance bytes) get no Dismiss. The swap-basket line shows the sats staged for the token, and
 * Move back is offered for tokens OR sats.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PendingPayoutStore, type KV, type PendingPayout } from "../src/wallet/pendingPayouts";
import type { WalletToken } from "../src/data/exchange";

let tokens: WalletToken[] = [];
vi.mock("../src/data/exchange", async (orig) => ({
  ...(await orig<typeof import("../src/data/exchange")>()),
  useMyTokens: () => ({ data: tokens, error: null, loading: false, reload: () => {} }),
}));
const { YourTokens } = await import("../src/ox/YourTokens");
const { dismissUnfinished, setExchangeContext, unfinished } = await import("../src/data/exchange");
const session = { status: "connected", identityKey: `03${"a1".repeat(32)}`, connect: () => {}, disconnect: () => {} } as never;

function memKV(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
const TOKEN = `${"c1".repeat(32)}_0`;
const entry = (txid: string, final: boolean, extra: Partial<PendingPayout> = {}): PendingPayout => ({ id: `${txid}:1`, kind: "swap", txid, vout: 1, tokenId: TOKEN, base: "http://x/@t", createdAt: Date.now() - 60_000, final, ...extra });
const DISMISS = "Dismiss: forget this unsigned swap; nothing was paid to you";

function withEntries(...ps: PendingPayout[]): PendingPayoutStore {
  const store = new PendingPayoutStore(memKV());
  for (const p of ps) store.save(p);
  setExchangeContext({ payouts: store });
  return store;
}

describe("Unfinished: Dismiss (0.29.6)", () => {
  const unsigned = entry("aa".repeat(32), false);
  const signed = entry("bb".repeat(32), true);
  const oldShape = entry("cc".repeat(32), false, { kind: "move-back", lockingScript: "76a914" + "00".repeat(20) + "88ac", satoshis: 1, remittance: { derivationPrefix: "p", derivationSuffix: "s", senderIdentityKey: `02${"11".repeat(32)}` } });
  const oldReceipt = entry("dd".repeat(32), true, { receipt: { assetId: TOKEN } as never });

  it("only the unsigned (not final) entry is dismissable; final and old-shape entries are not", () => {
    withEntries(unsigned, signed, oldShape, oldReceipt);
    expect(Object.fromEntries(unfinished().map((u) => [u.id, u.dismissable]))).toEqual({ [unsigned.id]: true, [signed.id]: false, [oldShape.id]: false, [oldReceipt.id]: false });
  });

  it("the card: one Dismiss (beside its Finish) for the unsigned entry, none for the others; every Finish kept", () => {
    tokens = [];
    withEntries(unsigned, signed, oldShape);
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html.match(/>Finish</g)).toHaveLength(3);
    expect(html.match(/>Dismiss</g)).toHaveLength(1);
    expect(html).toContain(`aria-label="${DISMISS}"`);
    const row = html.split("<li").find((r) => r.includes(unsigned.txid.slice(0, 12)))!;
    expect(row).toContain("(not signed yet)");
    expect(row).toContain(">Dismiss<");
    for (const p of [signed, oldShape]) expect(html.split("<li").find((r) => r.includes(p.txid.slice(0, 12)))!).not.toContain(">Dismiss<");
  });

  it("dismissUnfinished removes the unsigned entry and nothing else; refuses a final or old-shape entry", () => {
    const store = withEntries(unsigned, signed, oldShape);
    dismissUnfinished(unsigned.id);
    expect(store.list().map((p) => p.id).sort()).toEqual([signed.id, oldShape.id].sort());
    expect(() => dismissUnfinished(signed.id)).toThrow(/cannot be dismissed/);
    expect(() => dismissUnfinished(oldShape.id)).toThrow(/cannot be dismissed/);
    expect(store.list()).toHaveLength(2);
  });
});

describe("the swap-basket line (0.29.6): staged sats, Move back for tokens or sats", () => {
  const t = (inSwaps: bigint, swapSats: number): WalletToken => ({ tokenId: TOKEN, sym: "TST", dec: 0, balance: 0n, outputs: 0, inSwaps, swapSats, onExchange: true });
  it("tokens and sats: both shown, Move back", () => {
    withEntries();
    tokens = [t(42n, 5_000)];
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).toContain("In the swap basket 42 · 5,000 sats staged");
    expect(html).toContain(">Move back<");
  });
  it("only sats: the row renders, Move back offered", () => {
    tokens = [t(0n, 2_500)];
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).toContain("In the swap basket 0 · 2,500 sats staged");
    expect(html).toContain(">Move back<");
  });
  it("only tokens: the line as before, no sats text", () => {
    tokens = [t(42n, 0)];
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).toContain("In the swap basket 42");
    expect(html).not.toContain("sats staged");
  });
  it("nothing staged: no line, no Move back", () => {
    tokens = [{ ...t(0n, 0), balance: 10n }];
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).not.toContain("In the swap basket");
    expect(html).not.toContain("Move back<");
  });
});
