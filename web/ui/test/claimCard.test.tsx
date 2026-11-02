/** Settings while swap is unclaimed (0.26.0; 0.28.0: swap's /admin names nobody): the claim card alone for a non-admin; above the admin cards for root. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let claimed: boolean | null = false;
vi.mock("../src/data/exchange", async (orig) => ({
  ...(await orig<typeof import("../src/data/exchange")>()),
  useClaimStatus: () => ({ data: claimed === null ? null : { claimed, identity: `02${"5a".repeat(32)}` }, error: null, loading: false, reload: () => {} }),
}));
const { CLAIM_TEXT, Settings } = await import("../src/ox/Settings");
const session = { status: "connected", identityKey: `03${"a1".repeat(32)}`, connect: () => {}, disconnect: () => {} } as never;

describe("Settings by claim status", () => {
  it("claimed:false → ONE card, Claim this exchange; no not-root line, no root cards", () => {
    claimed = false;
    const html = renderToStaticMarkup(<Settings session={session} root={false} />);
    expect(html).toContain("Claim this exchange");
    expect(html).toContain(CLAIM_TEXT);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("not this exchange");
    expect(html).not.toContain("Enable a token");
  });
  it("claimed:false and root (the host's key, the rack's granted key) → the claim card above the admin cards", () => {
    claimed = false;
    const html = renderToStaticMarkup(<Settings session={session} root={true} />);
    expect(html).toContain("Claim this exchange");
    expect(html).toContain("Enable a token");
    expect(html.indexOf("Claim this exchange")).toBeLessThan(html.indexOf("Enable a token"));
  });
  it("claimed:true and root/admin → the admin cards, no claim card", () => {
    claimed = true;
    const html = renderToStaticMarkup(<Settings session={session} root={true} />);
    expect(html).not.toContain("Claim this exchange");
    expect(html).toContain("Enable a token");
  });
  it("claimed:true and not the admin → the not-admin line, no claim card", () => {
    claimed = true;
    const html = renderToStaticMarkup(<Settings session={session} root={false} />);
    expect(html).toContain("not this exchange");
    expect(html).not.toContain("Claim this exchange");
  });
});
