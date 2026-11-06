/**
 * src/ox/Settings.tsx, "Enable a token" (2026-10-31): one list, one click per token — the
 * candidates (discovery's list ∪ the wallet's held assets, minus the swap instance's list) as
 * rows, rendered to markup; a row's Enable calls `enableToken` with its id. No DOM here: the
 * rows component has no state of its own, so its element tree is walked for the button.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const enableToken = vi.fn(async (_tokenId: string) => ({ beefFrom: "discovery" as const }));
vi.mock("../src/data/exchange", async (orig) => ({ ...(await orig<typeof import("../src/data/exchange")>()), enableToken: (id: string) => enableToken(id) }));

const { enableCandidates } = await import("../src/data/exchange");
const { shortTokenId } = await import("../src/lib/tokenId");
const { DISCOVERY_OFF_TEXT, EnableList, NOTHING_TO_ENABLE_TEXT, enableSentText, enablePriceText, exchangeWalletText, priceSats } = await import("../src/ox/Settings");

const A = `${"a1".repeat(32)}_0`;
const B = `${"b1".repeat(32)}_0`;
const C = `${"c1".repeat(32)}_0`;
const listed = [
  { tokenId: A, topic: `tm_color_${A}`, sym: "AAA", dec: 0 },
  { tokenId: B, topic: `tm_color_${B}`, sym: "BBB", dec: 2 },
];
const noop = () => {};

function buttons(node: ReactNode): ReactElement<{ onClick: () => void; "aria-label": string }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode; onClick: () => void; "aria-label": string }>;
  return el.type === "button" ? [el] : buttons(el.props.children);
}

describe("Settings: Enable a token", () => {
  it("the union: discovery A and B, wallet B and C, A already enabled → rows B (both sources) and C (wallet) only, no text input, no textarea", () => {
    const rows = enableCandidates(listed, [B, C], [A]);
    expect(rows).toEqual([
      { tokenId: B, sym: "BBB", onDiscovery: true, inWallet: true },
      { tokenId: C, onDiscovery: false, inWallet: true },
    ]);
    const html = renderToStaticMarkup(<EnableList rows={rows} discoveryOff={false} busy={null} run={noop} onSent={noop} />);
    expect(html).toContain("BBB");
    expect(html).toContain("on discovery · in this wallet");
    expect(html).toContain("in this wallet");
    expect(html).not.toContain("AAA");
    expect(html).not.toMatch(/<input|<textarea/);
    expect(html.match(/<button[^>]*aria-label="Enable [^"]*"/g)).toHaveLength(2);
    expect(html).not.toContain(DISCOVERY_OFF_TEXT);
  });

  it("discovery off: the wallet's rows only, and the muted line", () => {
    const rows = enableCandidates([], [B, C], [A]);
    expect(rows.map((r) => [r.tokenId, r.onDiscovery, r.inWallet])).toEqual([
      [B, false, true],
      [C, false, true],
    ]);
    const html = renderToStaticMarkup(<EnableList rows={rows} discoveryOff={true} busy={null} run={noop} onSent={noop} />);
    expect(html).toContain(DISCOVERY_OFF_TEXT);
    expect(html).not.toContain("on discovery");
  });

  it("nothing left to enable: the empty line (discovery on); the muted line only (discovery off)", () => {
    expect(enableCandidates(listed, [A], [A, B])).toEqual([]);
    expect(renderToStaticMarkup(<EnableList rows={[]} discoveryOff={false} busy={null} run={noop} onSent={noop} />)).toContain(NOTHING_TO_ENABLE_TEXT);
    const off = renderToStaticMarkup(<EnableList rows={[]} discoveryOff={true} busy={null} run={noop} onSent={noop} />);
    expect(off).toContain(DISCOVERY_OFF_TEXT);
    expect(off).not.toContain(NOTHING_TO_ENABLE_TEXT);
  });

  it("clicking a row's Enable calls enableToken with its id; the confirmation says where the deploy came from", async () => {
    const rows = enableCandidates(listed, [B, C], [A]);
    const sent: string[] = [];
    let job: Promise<void> | undefined;
    const tree = EnableList({ rows, discoveryOff: false, busy: null, run: (_id, f) => void (job = f()), onSent: (id, r) => sent.push(enableSentText(id, r)) });
    const bs = buttons(tree);
    // C has no metadata: its short id stands for its symbol.
    expect(bs.map((b) => b.props["aria-label"])).toEqual(["Enable BBB", `Enable ${shortTokenId(C)}`]);
    bs[1]!.props.onClick();
    await job;
    expect(enableToken).toHaveBeenCalledTimes(1);
    expect(enableToken).toHaveBeenCalledWith(C);
    expect(sent).toEqual([expect.stringMatching(/its deploy from discovery/)]);
  });
});

describe("Settings: a token's own terms (0.35.0)", () => {
  it("the row's line: live terms as LP · validator · commission bps, or market only; a note after it", async () => {
    const { TokenTermsLine, tokenTermsText, TERMS_NOT_APPLIED_TEXT } = await import("../src/ox/Settings");
    const live = { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 };
    expect(tokenTermsText(live)).toBe("LP 30 · validator 5 · commission 25 bps");
    expect(tokenTermsText(null)).toBe("market only");
    // 0.40.0: the minimum leg when set (0: none).
    expect(tokenTermsText({ ...live, minLegSats: 2000 })).toBe("LP 30 · validator 5 · commission 25 bps · minimum leg 2000 sats");
    expect(tokenTermsText({ ...live, minLegSats: 0 })).toBe("LP 30 · validator 5 · commission 25 bps");
    expect(renderToStaticMarkup(<TokenTermsLine terms={live} error={null} note={null} />)).toBe(" · LP 30 · validator 5 · commission 25 bps");
    expect(renderToStaticMarkup(<TokenTermsLine terms={null} error={null} note={null} />)).toBe(" · market only");
    expect(renderToStaticMarkup(<TokenTermsLine terms={null} error={null} note={TERMS_NOT_APPLIED_TEXT} />)).toBe(" · market only · sent, not applied yet");
  });

  it("after a send, /terms is re-read until it shows the change (faked answers), else times out", async () => {
    const { untilTermsApplied } = await import("../src/ox/Settings");
    const answers = [{ lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, { lpFeeBps: 40, validatorFeeBps: 6, commissionBps: 3 }];
    let reads = 0;
    const read = async () => answers[Math.min(reads++, answers.length - 1)]!;
    expect(await untilTermsApplied(read, { lpBps: 40, validatorBps: 6, commissionBps: 3 }, 1000, 1)).toEqual({ terms: answers[2], applied: true });
    expect(reads).toBe(3);
    // 0.40.0: the minimum leg is compared too.
    const { termsApplied } = await import("../src/ox/Settings");
    expect(termsApplied({ lpFeeBps: 40, validatorFeeBps: 6, commissionBps: 3, minLegSats: 500 }, { lpBps: 40, validatorBps: 6, commissionBps: 3, minLegSats: 500 })).toBe(true);
    expect(termsApplied({ lpFeeBps: 40, validatorFeeBps: 6, commissionBps: 3, minLegSats: 0 }, { lpBps: 40, validatorBps: 6, commissionBps: 3, minLegSats: 500 })).toBe(false);
    expect(await untilTermsApplied(async () => null, null, 1000, 1)).toEqual({ terms: null, applied: true });
    const late = await untilTermsApplied(async () => answers[0]!, null, 20, 5);
    expect(late).toEqual({ terms: answers[0], applied: false });
  });

  it("the Edit form is the defaults card's fields (0.40.0: and Minimum leg (sats)): Save and Market only", async () => {
    const { TermsFields } = await import("../src/ox/Settings");
    const f = { lp: "40", val: "6", com: "3", min: "", setLp: noop, setVal: noop, setCom: noop, setMin: noop, terms: { lpBps: 40, validatorBps: 6, commissionBps: 3 } };
    const html = renderToStaticMarkup(<TermsFields f={f} idPrefix="tt-x" busy={false} setLabel="Save" clearLabel="Market only" onClear={noop} />);
    expect(html.match(/<input/g)).toHaveLength(4);
    expect(html).toContain("LP fee (bps)");
    expect(html).toContain("Validator fee (bps)");
    expect(html).toContain("Commission (bps)");
    expect(html).toContain("Minimum leg (sats)");
    expect(html).toContain(">Save<");
    expect(html).toContain(">Market only<");
  });
});

describe("Settings: the price to enable a token and the exchange's wallet (0.42.0)", () => {
  it("the price field: empty is off (null); a whole number of sats, 1 or more; anything else refused (undefined)", () => {
    expect(priceSats("")).toBeNull();
    expect(priceSats("  ")).toBeNull();
    expect(priceSats("2000")).toBe(2000);
    for (const bad of ["0", "1.5", "-3", "abc"]) expect(priceSats(bad)).toBeUndefined();
  });
  it("the texts", () => {
    expect(enablePriceText(undefined)).toBe("Off: only you enable tokens.");
    expect(enablePriceText(2000)).toBe("Anyone with a wallet can enable a token for 2000 sats. Only you can disable it.");
    expect(exchangeWalletText({ sats: 2000, outputs: 1, withdrawals: [] })).toBe("Exchange wallet: 2000 sats");
  });
});
