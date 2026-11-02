/**
 * The claim (0.26.0; 0.28.0: swap is born owned by the host's key, the claim is the swap app's): while
 * swap's `GET <base>/admin` names nobody, Settings shows the card "Claim this exchange"; its button sends
 * `{fn: "claim"}` in the swap app's box `amm/claim` to swap's identity; the host grants the claimant
 * amm.admin and `/admin` names it; after it the admin cards render. `isRoot` (may configure) = the
 * claimant, or root on swap by the host's `/skeins?key=`. The host's reads are a mocked `fetch`.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn(async (..._args: unknown[]) => "id");
vi.mock("../src/lib/skein", async (orig) => ({ ...(await orig<typeof import("../src/lib/skein")>()), sendMessage: (...a: unknown[]) => sendMessage(...a) }));

const ex = await import("../src/data/exchange");
const { CLAIM_TEXT, ClaimCard, Settings } = await import("../src/ox/Settings");

const SWAP = `02${"5a".repeat(32)}`;
const ME = `03${"a1".repeat(32)}`;
const OTHER = `02${"b2".repeat(32)}`;
const ORIGIN = "https://ox.test";

/** The host: swap's card (claimed: the host's key holds root), its /amm/admin (`st.claimant`), and /skeins (root held by `st.roots`). `st.noAdmin`: a swap older than 0.5.0 (no /admin read). */
function host(st: { roots: string[]; claimant?: string; noAdmin?: boolean }) {
  return vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/.well-known/skein") return Response.json({ handle: "swap", identity: SWAP, origin: ORIGIN, claimed: st.noAdmin ? st.roots.length > 0 : true });
    if (u.pathname === "/amm/admin" && !st.noAdmin) return Response.json(st.claimant ? { claimant: st.claimant, since: 1 } : {});
    if (u.pathname === "/skeins") return Response.json(st.roots.includes(u.searchParams.get("key") ?? "") ? [{ handle: "swap", identity: SWAP, url: ORIGIN }] : []);
    return new Response("not found", { status: 404 });
  });
}

const session = { status: "connected", identityKey: ME, connect: () => {}, disconnect: () => {} } as unknown as import("../src/data/exchange").Session;

function buttons(node: ReactNode): ReactElement<{ onClick: () => void; "aria-label": string }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode; onClick: () => void; "aria-label": string }>;
  return el.type === "button" ? [el] : buttons(el.props.children);
}

beforeEach(() => {
  ex.setExchangeContext({ base: `${ORIGIN}/amm`, wallet: {} as never, signedFor: () => ({ fetch: vi.fn() }) as never, identityKey: ME });
  sendMessage.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("isRoot (0.28.0: swap's claimant, or root by the host's /skeins?key=)", () => {
  it("true when /skeins?key=<me> names swap's identity (root: the host's key, the rack's granted key)", async () => {
    vi.stubGlobal("fetch", host({ roots: [ME] }));
    expect(await ex.isRoot(ME)).toBe(true);
  });
  it("true when swap's /admin names me (the claimant, granted amm.admin; not root)", async () => {
    vi.stubGlobal("fetch", host({ roots: [OTHER], claimant: ME }));
    expect(await ex.isRoot(ME)).toBe(true);
  });
  it("false when neither (another key is root and the claimant), and with no key", async () => {
    vi.stubGlobal("fetch", host({ roots: [OTHER], claimant: OTHER }));
    expect(await ex.isRoot(ME)).toBe(false);
    expect(await ex.isRoot(null)).toBe(false);
  });
  it("false when the host's read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    expect(await ex.isRoot(ME)).toBe(false);
  });
});

describe("claimStatus: swap's /amm/admin (its identity from /.well-known/skein)", () => {
  it("unclaimed and claimed (the claimant named), with swap's identity", async () => {
    vi.stubGlobal("fetch", host({ roots: [OTHER] }));
    expect(await ex.claimStatus()).toEqual({ claimed: false, identity: SWAP });
    vi.stubGlobal("fetch", host({ roots: [OTHER], claimant: ME }));
    expect(await ex.claimStatus()).toEqual({ claimed: true, identity: SWAP, claimant: ME });
  });
  it("a swap with no /admin read (older pages): claimed as /.well-known/skein says", async () => {
    vi.stubGlobal("fetch", host({ roots: [], noAdmin: true }));
    expect(await ex.claimStatus()).toEqual({ claimed: false, identity: SWAP });
    vi.stubGlobal("fetch", host({ roots: [OTHER], noAdmin: true }));
    expect(await ex.claimStatus()).toEqual({ claimed: true, identity: SWAP });
  });
});

describe("Settings: Claim this exchange", () => {
  it("the card: its sentence and ONE button, Claim", () => {
    const html = renderToStaticMarkup(<ClaimCard busy={false} error={null} onClaim={() => {}} />);
    expect(html).toContain("Claim this exchange");
    expect(html).toContain(CLAIM_TEXT);
    expect(buttons(ClaimCard({ busy: false, error: null, onClaim: () => {} })).map((b) => b.props["aria-label"])).toEqual(["Claim"]);
  });

  it("clicking Claim sends {fn: \"claim\"} in box amm/claim to swap's identity; after it this wallet may configure (not root)", async () => {
    const st: { roots: string[]; claimant?: string } = { roots: [OTHER] };
    vi.stubGlobal("fetch", host(st));
    sendMessage.mockImplementationOnce(async () => {
      st.claimant = ME; // swap records the claim; the host grants amm.admin
      return "id";
    });
    let job: Promise<unknown> | undefined;
    const [b] = buttons(ClaimCard({ busy: false, error: null, onClaim: () => void (job = ex.claimExchange()) }));
    b!.props.onClick();
    expect(await job).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, base, recipient, box, body] = sendMessage.mock.calls[0]!;
    expect([base, recipient, box, body]).toEqual([`${ORIGIN}/amm`, SWAP, "amm/claim", { fn: "claim" }]);
    expect(await ex.isRoot(ME)).toBe(true);
  });

  it("root: the root cards render, no claim card", () => {
    const html = renderToStaticMarkup(<Settings session={session} root={true} />);
    expect(html).not.toContain("Claim this exchange");
    expect(html).toContain("Enable a token");
    expect(html).toContain("Discovery");
    expect(html).not.toContain("not this exchange");
  });

  it("not the admin (claim status not yet read, or claimed by another): the not-admin line, no admin cards", () => {
    const html = renderToStaticMarkup(<Settings session={session} root={false} />);
    expect(html).toContain("The connected wallet is not this exchange&#x27;s admin. Settings are the admin&#x27;s.");
    expect(html).not.toContain("Enable a token");
  });
});
