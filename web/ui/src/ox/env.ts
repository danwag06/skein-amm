/**
 * What the pages take from their URL and env (0.38.0, D9: the client takes these as arguments,
 * src/lib/config.ts and src/client.ts; before, src/lib/config.ts read them itself):
 *
 *   AMM_OVERLAY        the AMM app's base URL: `https://<handle>.<host>/<app>`
 *                      or a host's dev form `<host>/@<handle>/<app>` (0.34.0: the
 *                      public read API's GETs, src/lib/overlay.ts; POST call and
 *                      sendMessage, signed; POST submit at the host root). The pages are the app's `www/`, served at
 *                      `<base>/` (index.html), so the base is the page's own
 *                      directory (`appBaseOf`; at the origin's root, `<origin>/amm`);
 *                      `VITE_AMM_OVERLAY` overrides
 *                      it (a dev server on another origin)
 *   VITE_AMM_PEER_OVERLAY  another instance's AMM base URL (no default): the
 *                      Validator page reads this instance's liveness (and
 *                      peer ID) from the peer's liveness read of its token
 *                      topics (GET .live/tm_color_<txid>_0-live, kept where the peer
 *                      is a market for the token)
 *   VITE_FEE_RATE      the miner fee rate, sats per 1000 bytes, the Swap page
 *                      applies to the swap transaction it builds (default
 *                      100). The swap's fee is paid from the leg's exact sats
 *                      output, so the rate is fixed here, not by the wallet
 *
 * From a dev server (serve.sh) the instance is called cross-origin: it sends
 * permissive CORS headers.
 */
import { DEFAULT_FEE_RATE_SATS_PER_KB, appBaseOf } from "../lib/config";

const env = (import.meta as { env?: Record<string, string | undefined> }).env;

function pageHref(): string | undefined {
  try {
    return typeof location === "undefined" ? undefined : location.href;
  } catch {
    return undefined;
  }
}

/** No trailing slash. `VITE_AMM_OVERLAY`, else the page's own directory, else a local host's dev form. */
export const AMM_OVERLAY = (
  env?.VITE_AMM_OVERLAY ?? (pageHref() ? appBaseOf(pageHref()!) : undefined) ?? "http://127.0.0.1:8100/@amm/amm"
).replace(/\/+$/, "");

/** The peer instance whose liveness read (`GET .live/tm_color_<txid>_0-live`) tells us whether our heartbeat is heard. `VITE_AMM_PEER_OVERLAY`; unset or "" disables. */
export const AMM_PEER_OVERLAY = (env?.VITE_AMM_PEER_OVERLAY ?? "").replace(/\/+$/, "");

/**
 * Miner fee rate for the swap transaction the page builds, sats per 1000
 * bytes (`VITE_FEE_RATE`, default 100). The leg's sats output (`amm-swap`) is sized to the
 * swap's inputs and outputs plus this fee over the swap's size with the pool
 * input at `PoolTemplate.maxCallUnlockLength`; the contract allows no change.
 */
export const FEE_RATE_SATS_PER_KB = Number(env?.VITE_FEE_RATE ?? DEFAULT_FEE_RATE_SATS_PER_KB);
