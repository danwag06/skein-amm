/**
 * The skein's own doors the Open Exchange pages use beside the AMM's routes
 * (skein-amm 0.9.0):
 *
 * - **A message to a box** (`sendMessage`): the BRC-104-signed `POST
 *   <instance>/sendMessage`, BRC-231 CBOR `{message: {recipient, messageBox,
 *   body}}` — what `skein send`, skein-1color's Token topics page and any
 *   BRC-100 wallet send (skein docs/MESSAGES.md "The messagebox"). `body` is
 *   dag-cbor. The instance is the AMM base's origin (or its `/@<handle>`
 *   prefix); the recipient its identity key. Root's register messages
 *   (`amm/register`).
 * - **The token list** (0.17.0, shruggr/skein-amm#4: `readTokens`): `GET
 *   <config>/tokens`, the config instance's enable list — each token's id,
 *   topic, metadata, status and its own instance's `url`; and the defaults a
 *   new token instance is created with (`readDefaults`, `GET <config>/defaults`).
 * - The public read API (0.34.0: the pools, positions, terms, spends, transactions, swaps, and
 *   discovery's token reads) is src/lib/overlay.ts.
 */
import { encode, decode } from "cbor2";
import { AuthFetch, Utils, type WalletInterface } from "@bsv/sdk";
import { appName } from "./config.js";

export interface SignedPost {
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response>;
}

/** The instance's base under which `/sendMessage` lives: the AMM base without its app segment. */
export function instanceBase(base: string): string {
  const name = appName(base);
  return name ? base.replace(new RegExp(`/${name}/?$`), "") : base;
}

/**
 * The fetch an instance's BRC-104 client uses (skein `src/client/raw.ts`, copied: the pages do not
 * depend on the skein package). `@bsv/sdk`'s AuthFetch keeps one session per ORIGIN and shakes
 * hands at `<origin>/.well-known/auth`, which the router gives to the root instance; an instance
 * under a path prefix (`<origin>/@<handle>`) takes its handshake at `<prefix>/.well-known/auth`
 * (each instance holds its own sessions). So for a base with a prefix the handshake is sent there;
 * every other request goes as it is. `fetchFn`: the browser's fetch, bound (it must be called on
 * the window), unless a test passes its own.
 */
export function instanceFetch(base: string, fetchFn?: typeof fetch): typeof fetch {
  const u = new URL(instanceBase(base));
  const prefix = u.pathname.replace(/\/+$/, "");
  const f = fetchFn ?? (((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch);
  if (!prefix) return f;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const s = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const w = new URL(s);
    if (w.origin === u.origin && w.pathname === "/.well-known/auth") w.pathname = `${prefix}/.well-known/auth`;
    return f(input instanceof Request ? new Request(w, input) : w.href, init);
  }) as typeof fetch;
}

/** The instance's key for its BRC-104 session: its origin and path prefix (`instanceBase`). */
export function sessionKey(base: string): string {
  return instanceBase(base).replace(/\/+$/, "");
}

/**
 * The wallet's BRC-104 clients, one per instance (its origin + path prefix): `<origin>/amm` and
 * `<origin>/@<tokenId>/amm` are two instances with two sessions. The same instance gets the same
 * client back.
 */
export function authFetchPerInstance(wallet: WalletInterface, fetchFn?: typeof fetch): (base: string) => AuthFetch {
  const clients = new Map<string, AuthFetch>();
  return (base) => {
    const key = sessionKey(base);
    let af = clients.get(key);
    if (!af) {
      af = new AuthFetch(wallet, undefined, undefined, undefined, {}, instanceFetch(base, fetchFn));
      clients.set(key, af);
    }
    return af;
  };
}

/** dag-cbor (CDE: canonical key order, shortest forms) of a plain value. */
export function dagCbor(v: unknown): Uint8Array {
  return encode(v, { cde: true });
}

/**
 * A message from the connected wallet's key to the instance's `box` (`<app>/<box>`): its id. The
 * instance's identity is `recipient` (hex).
 */
export async function sendMessage(af: SignedPost, base: string, recipient: string, box: string, body: unknown): Promise<string> {
  const url = `${instanceBase(base)}/sendMessage`;
  const res = await af.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/cbor" },
    body: dagCbor({ message: { recipient: Uint8Array.from(Utils.toArray(recipient, "hex") as number[]), messageBox: box, body: dagCbor(body) } }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let v: Record<string, unknown> = {};
  try {
    v = decode(bytes) as Record<string, unknown>;
  } catch {
    v = { description: new TextDecoder().decode(bytes) };
  }
  if (res.status !== 200) throw new Error(`sendMessage ${box}: HTTP ${res.status} ${String(v.code ?? "")} ${String(v.description ?? "")}`.trim());
  return String(v.id ?? v.messageId ?? "");
}

async function getJson(url: string, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** A token's id, topic and metadata, as a token list names it. */
export interface ListedToken {
  tokenId: string;
  topic: string;
  sym?: string;
  dec?: number;
  icon?: string;
}

/**
 * A token on the swap instance's enable list (`GET <swap>/tokens`; Open Exchange, shruggr/open-exchange#1:
 * root's decision as a fact, enabled or disabled; the host makes its instance, `<origin>/@<tokenId>`).
 */
export interface EnabledToken {
  tokenId: string;
  topic: string;
  sym: string;
  dec: number;
  icon?: string;
  status: "enabled" | "disabled";
  /** When root last enabled or disabled it, ms. */
  since: number;
}

const STATUSES = new Set(["enabled", "disabled"]);

/**
 * The config instance's enable list, newest first as the read lists it. A row's icon: its `icon`
 * (a data URL, open-exchange before 0.11.0), else its `iconUrl` (0.34.0, P12: origin-relative,
 * `/@discovery/1color/<token>/icon`) made absolute against the list's URL.
 */
export async function readTokens(base: string, fetchFn: typeof fetch = fetch): Promise<EnabledToken[]> {
  const url = `${base}/tokens`;
  const a = await getJson(url, fetchFn);
  return (Array.isArray(a) ? (a as Record<string, unknown>[]) : [])
    .filter((t) => typeof t.tokenId === "string" && typeof t.status === "string" && STATUSES.has(t.status))
    .map((t) => ({
      tokenId: String(t.tokenId),
      topic: typeof t.topic === "string" ? t.topic : `tm_color_${String(t.tokenId)}`,
      sym: typeof t.sym === "string" ? t.sym : "",
      dec: typeof t.dec === "number" ? t.dec : 0,
      ...(typeof t.icon === "string" ? { icon: t.icon } : typeof t.iconUrl === "string" && t.iconUrl ? { icon: new URL(t.iconUrl, url).href } : {}),
      status: t.status as EnabledToken["status"],
      since: typeof t.since === "number" ? t.since : 0,
    }));
}

/** The defaults a new token instance is created with (0.17.0, `GET <config>/defaults`): each absent when unset. */
export interface Defaults {
  terms?: { lpFeeBps: number; validatorFeeBps: number; commissionBps: number };
  market?: { minCommissionBps: number };
}

/** Discovery (`GET <swap>/discovery`): root's last decision, on or off, and since when (ms); the host starts or stops the discovery instance. */
export interface Discovery {
  on: boolean;
  since?: number;
}

/** `GET <swap>/discovery`: `{on, since?}`, or `{on: false}` (none, or another shape). */
export async function readDiscovery(base: string, fetchFn: typeof fetch = fetch): Promise<Discovery> {
  const a = (await getJson(`${base}/discovery`, fetchFn)) as Record<string, unknown> | null;
  if (!a || typeof a.on !== "boolean") return { on: false };
  return { on: a.on, ...(typeof a.since === "number" ? { since: a.since } : {}) };
}

export async function readDefaults(base: string, fetchFn: typeof fetch = fetch): Promise<Defaults> {
  const a = (await getJson(`${base}/defaults`, fetchFn)) as Record<string, unknown> | null;
  const out: Defaults = {};
  const t = a?.terms as Record<string, unknown> | undefined;
  if (t && typeof t.lpFeeBps === "number" && typeof t.validatorFeeBps === "number" && typeof t.commissionBps === "number") out.terms = { lpFeeBps: t.lpFeeBps, validatorFeeBps: t.validatorFeeBps, commissionBps: t.commissionBps };
  const m = a?.market as Record<string, unknown> | undefined;
  if (m && typeof m.minCommissionBps === "number") out.market = { minCommissionBps: m.minCommissionBps };
  return out;
}
