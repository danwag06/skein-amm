/**
 * The skein instances the client talks to (Open Exchange, shruggr/open-exchange#1): the SWAP
 * instance whose app base the client is given (`createClient({origin})`, `exchangeBase`: the
 * token list `GET <base>/tokens`, the defaults, root's enable / disable / defaults / discovery
 * messages) and, per enabled token, that token's own instance (`tokenBase`:
 * `<origin>/@<tokenId>/amm`, its pools, prices, liveness, `/call`, `/submit`, `/spends`). Every
 * request goes to one of those (a GET by plain `fetch`; every POST through the connected
 * wallet's BRC-104 `AuthFetch`, since a skein takes no unsigned POST; src/lib/overlay.ts), or to
 * the connected BRC-100 wallet.
 *
 * 0.36.0 (D9): pure — no `import.meta.env`, no `location`. The pages compute their base and fee
 * rate from their URL and env (src/ox/env.ts: `VITE_AMM_OVERLAY`, `VITE_FEE_RATE`, `appBaseOf`)
 * and pass them to `createClient`.
 */

/**
 * The app's base URL from the page's own URL: the directory the page is
 * served from (`https://alice.skein.nexus/amm/` → `https://alice.skein.nexus/amm`,
 * `http://127.0.0.1:8100/@alice/amm/index.html` → `http://127.0.0.1:8100/@alice/amm`).
 * At the origin's root (the instance's root route `/` serving this app's www/,
 * shruggr/skein#147: `https://alice.skein.nexus/`, or a host's dev form
 * `http://127.0.0.1:8100/@alice/`) the page names no app, and the app is the
 * same skein's `amm`: `<origin>/amm` (`…/@alice/amm`).
 */
export function appBaseOf(href: string): string | undefined {
  const u = new URL(href);
  const path = u.pathname.replace(/[^/]*$/, "").replace(/\/+$/, "");
  const segs = path.split("/").filter((x) => x !== "");
  if (segs.length === 0 || (segs.length === 1 && segs[0].startsWith("@"))) return `${u.origin}${path}/${ROOT_APP}`;
  return u.origin + path;
}

/** The app the pages are at the origin's root (skein#147): this one, installed as `amm`. */
export const ROOT_APP = "amm";

/** The app's name: the last segment of its base URL (`…/amm` → `amm`); undefined for an origin. */
export function appName(base: string): string | undefined {
  try {
    const segs = new URL(base).pathname.split("/").filter((x) => x !== "");
    const last = segs[segs.length - 1];
    return last && !last.startsWith("@") ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

/** The miner fee rate a client sizes a swap with when none is given, sats per 1000 bytes (D9: today's value). */
export const DEFAULT_FEE_RATE_SATS_PER_KB = 100;

/**
 * The swap app's base URL of an exchange (`createClient({origin})`): an origin alone
 * (`https://swap.skein.nexus`) is the app at its root, `<origin>/amm` (skein#147, as `appBaseOf`
 * reads a page at the origin's root); a URL with a path is the base as given. No trailing slash.
 */
export function exchangeBase(origin: string): string {
  const u = new URL(origin);
  const path = u.pathname.replace(/\/+$/, "");
  return path === "" ? `${u.origin}/${ROOT_APP}` : `${u.origin}${path}`;
}

/**
 * A token instance's AMM base (Open Exchange, shruggr/open-exchange#1): `<origin>/@<tokenId>/amm` on the
 * origin the swap instance's base is on — the host makes each enabled token's instance at that path
 * (skein#161: a token id is a path-only handle).
 */
export function tokenBase(tokenId: string, from: string): string {
  return `${new URL(from).origin}/@${tokenId}/${ROOT_APP}`;
}
