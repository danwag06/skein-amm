/**
 * Your tokens: Send (0.30.0) — a token to a BRC-169 handle with @1sat/actions `send1Color` (stubbed
 * here: the module mock). `sendTokens`'s input shape; the form's amount check (never reaches the
 * action on a bad amount); the three results as the row shows them.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletInterface } from "@bsv/sdk";
import type { WalletToken } from "../src/data/exchange";

const execute = vi.fn();
vi.mock("@1sat/actions", async (orig) => {
  const m = await orig<typeof import("@1sat/actions")>();
  return { ...m, send1Color: { ...m.send1Color, execute: (...a: unknown[]) => execute(...a) } };
});
let tokens: WalletToken[] = [];
vi.mock("../src/data/exchange", async (orig) => ({
  ...(await orig<typeof import("../src/data/exchange")>()),
  useMyTokens: () => ({ data: tokens, error: null, loading: false, reload: () => {} }),
}));
const { onDataChange, sendTokens, setExchangeContext } = await import("../src/data/exchange");
const { YourTokens, SendFormView, SendNoteLine, checkSendAmount, runSend, sendOutcome } = await import("../src/ox/YourTokens");

const TOKEN = `${"c1".repeat(32)}_0`;
const TXID = "ab".repeat(32);
const session = { status: "connected", identityKey: `03${"a1".repeat(32)}`, connect: () => {}, disconnect: () => {} } as never;
const token = (balance: bigint, dec = 2): WalletToken => ({ tokenId: TOKEN, sym: "TST", dec, balance, outputs: 1, inSwaps: 0n, swapSats: 0, onExchange: true });
function useWallet(network: "mainnet" | "testnet"): WalletInterface {
  const wallet = { getNetwork: async () => ({ network }) } as unknown as WalletInterface;
  setExchangeContext({ wallet, signedFor: () => ({}) as never });
  return wallet;
}

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ txid: TXID, delivered: "envelope", messageId: "m1" });
});

describe("sendTokens", () => {
  it("calls send1Color with the asset id, the bigint amount, the handle, the chain from getNetwork; no memo when none; returns the result as is", async () => {
    const wallet = useWallet("testnet");
    let changed = 0;
    const off = onDataChange(() => changed++);
    const r = await sendTokens(TOKEN, "bob@example.com", 1234n);
    off();
    expect(r).toEqual({ txid: TXID, delivered: "envelope", messageId: "m1" });
    expect(execute).toHaveBeenCalledTimes(1);
    const [ctx, input] = execute.mock.calls[0]!;
    expect(ctx).toEqual({ wallet, chain: "test", isBaseWallet: false });
    expect(input).toEqual({ assetId: TOKEN, amount: 1234n, destination: { handle: "bob@example.com" } });
    expect(typeof input.amount).toBe("bigint");
    expect("memo" in input).toBe(false);
    expect(changed).toBe(1);
  });

  it("mainnet → chain main; the memo when given", async () => {
    useWallet("mainnet");
    await sendTokens(TOKEN, "@bob@example.com", 5n, "for lunch");
    const [ctx, input] = execute.mock.calls[0]!;
    expect(ctx.chain).toBe("main");
    expect(input).toEqual({ assetId: TOKEN, amount: 5n, destination: { handle: "@bob@example.com" }, memo: "for lunch" });
  });

  it("no wallet: refused before the action", async () => {
    setExchangeContext({ wallet: null, signedFor: null });
    await expect(sendTokens(TOKEN, "bob@example.com", 1n)).rejects.toThrow(/Connect a wallet/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("the form's amount check: a bad amount never reaches the action", () => {
  const t = token(10_000n); // 100.00 TST
  it.each([
    ["not a number", "abc", /Not an amount/],
    ["empty", "", /Not an amount/],
    ["too many decimals", "1.001", /Not an amount/],
    ["zero", "0", /more than 0/],
    ["over the balance", "100.01", /More than your balance \(100\)/],
  ])("%s", async (_n, amount, msg) => {
    const send = vi.fn();
    const o = await runSend(t, { handle: "bob@example.com", amount, memo: "" }, send);
    expect(o).toEqual({ formError: expect.stringMatching(msg) });
    expect(send).not.toHaveBeenCalled();
  });
  it("a good amount: raw units, handle and memo trimmed, an empty memo dropped", async () => {
    expect(checkSendAmount("1,000", 2, 100_000n)).toEqual({ amount: 100_000n });
    const send = vi.fn().mockResolvedValue({ txid: TXID, delivered: "envelope", messageId: "m" });
    await runSend(t, { handle: " bob@example.com ", amount: "100", memo: "  " }, send);
    expect(send).toHaveBeenCalledWith(TOKEN, "bob@example.com", 10_000n, undefined);
    await runSend(t, { handle: "bob@example.com", amount: "0.5", memo: " hi " }, send);
    expect(send).toHaveBeenLastCalledWith(TOKEN, "bob@example.com", 50n, "hi");
  });
});

describe("the three results", () => {
  const t = token(10_000n);
  it("delivered: the form closes, the row says Sent <amount> <sym> to <handle> with the txid (8 chars, full in title)", async () => {
    const o = await runSend(t, { handle: "bob@example.com", amount: "12.5", memo: "" }, vi.fn().mockResolvedValue({ txid: TXID, delivered: "envelope", messageId: "m" }));
    expect(o).toEqual({ note: { kind: "sent", amount: 1250n, handle: "bob@example.com", txid: TXID } });
    const html = renderToStaticMarkup(<SendNoteLine note={(o as { note: never }).note} t={t} />);
    expect(html).toContain("Sent 12.5 TST to bob@example.com");
    expect(html).toContain(`title="${TXID}">${TXID.slice(0, 8)}<`);
  });

  it("error without txid: the SDK's text in the form, which stays open with its inputs enabled", async () => {
    const o = await runSend(t, { handle: "bob@nowhere", amount: "1", memo: "" }, vi.fn().mockResolvedValue({ error: "handle not found" }));
    expect(o).toEqual({ formError: "handle not found" });
    const html = renderToStaticMarkup(<SendFormView t={t} s={{ handle: "bob@nowhere", amount: "1", memo: "", busy: false, error: "handle not found" }} set={() => {}} onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain('<span class="bad small">handle not found</span>');
    expect(html).not.toContain("disabled");
    expect(html).toContain(">Send<");
    expect(html).toContain(">Cancel<");
  });

  it("error with txid (delivery failed): the form closes, the row says built but not delivered; no retry, no abort", async () => {
    const o = await runSend(t, { handle: "bob@example.com", amount: "1", memo: "" }, vi.fn().mockResolvedValue({ txid: TXID, tx: [1], error: "delivery-failed: 503 Service Unavailable" }));
    expect(o).toEqual({ note: { kind: "undelivered", txid: TXID, text: "503 Service Unavailable" } });
    const html = renderToStaticMarkup(<SendNoteLine note={(o as { note: never }).note} t={t} />);
    expect(html.replace(/<[^>]+>/g, "")).toBe(`The send was built (${TXID.slice(0, 8)}) but could not be delivered: 503 Service Unavailable. The tokens are in the pending send until it expires.`);
    expect(html).not.toMatch(/Retry|Abort/i);
  });

  it("a thrown error stays in the form; a result with neither error nor delivery is an error", async () => {
    expect(await runSend(t, { handle: "b@x", amount: "1", memo: "" }, vi.fn().mockRejectedValue(new Error("user denied")))).toEqual({ formError: "user denied" });
    expect(sendOutcome({}, 1n, "b@x")).toEqual({ formError: "The send returned no transaction." });
  });

  it("while sending: Sending…, every input and button disabled", () => {
    const html = renderToStaticMarkup(<SendFormView t={t} s={{ handle: "b@x", amount: "1", memo: "", busy: true, error: null }} set={() => {}} onSubmit={() => {}} onCancel={() => {}} />);
    expect(html).toContain(">Sending…<");
    expect(html.match(/<input[^>]* disabled=""/g)).toHaveLength(3);
    expect(html.match(/<button[^>]* disabled=""/g)).toHaveLength(2);
    expect(html).toContain('placeholder="name@domain"');
  });
});

describe("Your tokens: the Send button", () => {
  it("on a row with a balance, beside Status; none without one; the lead says what Send does; existing texts kept", () => {
    tokens = [token(5n), { ...token(0n), tokenId: `${"d2".repeat(32)}_0`, sym: "ZZZ", inSwaps: 3n }];
    const html = renderToStaticMarkup(<YourTokens session={session} />);
    expect(html.match(/>Send</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Send TST to a BRC-169 handle"');
    expect(html).not.toContain('aria-label="Send ZZZ');
    expect(html).toContain("Send gives a token to a BRC-169 handle; the recipient&#x27;s wallet takes it in.");
    expect(html).toContain("The swap basket holds tokens on their way into a swap; Move back");
    expect(html).toContain(">Move back<");
    expect(html).toContain("On this exchange");
    expect(html).not.toContain("<form"); // the form opens only on Send
  });
});
