/**
 * Your tokens: the swap-basket line shows the token's tokens, and (0.40.0) the sats in the swap
 * basket once, with their own Move back. 0.34.0 (D18, D24): no Unfinished card, no Finish or Dismiss (the
 * silent pass settles the staged legs, src/wallet/swapPayouts.ts; test/swap.test.ts).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WalletToken } from "../src/data/exchange";

let tokens: WalletToken[] = [];
let stagedSats = 0;
vi.mock("../src/data/exchange", async (orig) => ({
  ...(await orig<typeof import("../src/data/exchange")>()),
  useMyTokens: () => ({ data: tokens, error: null, loading: false, reload: () => {} }),
  useSwapBasketSats: () => ({ data: stagedSats, error: null, loading: false, reload: () => {} }),
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

describe("the swap basket (0.40.0): a token's line shows its tokens; the sats once, above the list, with their own Move back", () => {
  const t = (inSwaps: bigint): WalletToken => ({ tokenId: TOKEN, sym: "TST", dec: 0, balance: 0n, outputs: 0, inSwaps, onExchange: true });
  it("tokens and sats: the token's line, and the sats line once", () => {
    tokens = [t(42n)];
    stagedSats = 5_000;
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).toContain("In the swap basket 42");
    expect(html).toContain("5,000 sats in the swap basket");
    expect(html.match(/>Move back</g)).toHaveLength(2);
  });
  it("only sats: no token line, the sats line with Move back", () => {
    tokens = [];
    stagedSats = 2_500;
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).not.toContain("In the swap basket");
    expect(html).toContain("2,500 sats in the swap basket");
    expect(html).toContain(">Move back<");
  });
  it("only tokens: the line as before, no sats line", () => {
    tokens = [t(42n)];
    stagedSats = 0;
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).toContain("In the swap basket 42");
    expect(html).not.toContain("sats in the swap basket");
  });
  it("nothing staged: no line, no Move back", () => {
    tokens = [{ ...t(0n), balance: 10n }];
    stagedSats = 0;
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html).not.toContain("In the swap basket");
    expect(html).not.toContain("Move back<");
  });
});
