/**
 * Your tokens: the swap-basket line shows the sats staged for the token, and Move back is offered
 * for tokens OR sats (0.29.6). 0.34.0 (D18, D24): no Unfinished card, no Finish or Dismiss (the
 * silent pass settles the staged legs, src/wallet/swapPayouts.ts; test/swap.test.ts).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WalletToken } from "../src/data/exchange";

let tokens: WalletToken[] = [];
vi.mock("../src/data/exchange", async (orig) => ({
  ...(await orig<typeof import("../src/data/exchange")>()),
  useMyTokens: () => ({ data: tokens, error: null, loading: false, reload: () => {} }),
  useSettleSwaps: () => undefined,
}));
const { YourTokens } = await import("../src/ox/YourTokens");
const session = { status: "connected", identityKey: `03${"a1".repeat(32)}`, connect: () => {}, disconnect: () => {} } as never;
const TOKEN = `${"c1".repeat(32)}_0`;

describe("no Unfinished card (0.34.0)", () => {
  it("the page shows no Unfinished card, no Finish, no Dismiss", () => {
    tokens = [];
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).not.toContain("Unfinished");
    expect(html).not.toContain(">Finish<");
    expect(html).not.toContain(">Dismiss<");
  });
});

describe("the swap-basket line (0.29.6): staged sats, Move back for tokens or sats", () => {
  const t = (inSwaps: bigint, swapSats: number): WalletToken => ({ tokenId: TOKEN, sym: "TST", dec: 0, balance: 0n, outputs: 0, inSwaps, swapSats, onExchange: true });
  it("tokens and sats: both shown, Move back", () => {
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
