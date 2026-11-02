/**
 * The claim (0.26.0): while nobody holds root on the swap instance, Settings shows ONE card,
 * "Claim this exchange"; its button sends the wallet's own message in box `claim` to swap's
 * identity (what `skein claim` sends); after it the root cards render. `isRoot` is real: the
 * host's `/skeins?key=` names swap's identity. The host's reads are a mocked `fetch`.
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

/** The host: swap's card and /skeins, root held by `roots`. */
function host(roots: string[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/.well-known/skein") return Response.json({ handle: "swap", identity: SWAP, origin: ORIGIN, claimed: roots.length > 0 });
    if (u.pathname === "/skeins") return Response.json(roots.includes(u.searchParams.get("key") ?? "") ? [{ handle: "swap", identity: SWAP, url: ORIGIN }] : []);
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

describe("isRoot (0.26.0: the host's /skeins?key=)", () => {
  it("true when /skeins?key=<me> names swap's identity", async () => {
    vi.stubGlobal("fetch", host([ME]));
    expect(await ex.isRoot(ME)).toBe(true);
  });
  it("false when it does not (another key is root), and with no key", async () => {
    vi.stubGlobal("fetch", host([OTHER]));
    expect(await ex.isRoot(ME)).toBe(false);
    expect(await ex.isRoot(null)).toBe(false);
  });
  it("false when the host's read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })));
    expect(await ex.isRoot(ME)).toBe(false);
  });
});

describe("claimStatus: swap's /.well-known/skein", () => {
  it("unclaimed and claimed, with swap's identity", async () => {
    vi.stubGlobal("fetch", host([]));
    expect(await ex.claimStatus()).toEqual({ claimed: false, identity: SWAP });
    vi.stubGlobal("fetch", host([OTHER]));
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

  it("clicking Claim sends box `claim` to swap's identity; after it this wallet is root", async () => {
    const roots: string[] = [];
    vi.stubGlobal("fetch", host(roots));
    sendMessage.mockImplementationOnce(async () => {
      roots.push(ME); // the kernel grants root to the claim's sender
      return "id";
    });
    let job: Promise<unknown> | undefined;
    const [b] = buttons(ClaimCard({ busy: false, error: null, onClaim: () => void (job = ex.claimExchange()) }));
    b!.props.onClick();
    expect(await job).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, base, recipient, box, body] = sendMessage.mock.calls[0]!;
    expect([base, recipient, box, body]).toEqual([`${ORIGIN}/amm`, SWAP, "claim", {}]);
    expect(await ex.isRoot(ME)).toBe(true);
  });

  it("root: the root cards render, no claim card", () => {
    const html = renderToStaticMarkup(<Settings session={session} root={true} />);
    expect(html).not.toContain("Claim this exchange");
    expect(html).toContain("Enable a token");
    expect(html).toContain("Discovery");
    expect(html).not.toContain("not root on this skein");
  });

  it("not root (claim status not yet read, or claimed by another): today's line, no root cards", () => {
    const html = renderToStaticMarkup(<Settings session={session} root={false} />);
    expect(html).toContain("The connected wallet is not root on this skein. Settings are root&#x27;s.");
    expect(html).not.toContain("Enable a token");
  });
});
