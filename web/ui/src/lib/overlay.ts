/**
 * The exchange's public read API (skein-amm 0.34.0; agent-env plans/exchange-api-2026-11-04.md §0,
 * D1–D25; docs/AMM.md "The public read API"): plain GETs (D7), JSON unless the row says bytes, list
 * parameters comma-separated, one record per key in query order (D1). The pages read these and
 * nothing else of the overlay: they send `/lookup` nowhere (D8: `/submit` and `/lookup` are the
 * overlay protocol other overlays and the wallet's module speak; the pages submit at the host
 * root, `<origin>/submit` + `X-Topics`, src/lp/close.ts `submitToOverlay`).
 *
 * | # | route | answer |
 * |---|---|---|
 * | P1 | `GET <origin>/amm/pools` (and as an event stream) | `[{tokenId, …P2 row}]`, every enabled token's live pools (the host's) |
 * | P2 | `GET <origin>/@<token>/amm/pools` (and as an event stream) | `{market: {commissionPkh, minCommissionBps}, pools: [{lpPubKey, outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps, commissionBps, validatorIdentityKey, validatorPeerId}]}`: only pools whose validator beats now and whose commission is at or above the market's minimum (the host's) |
 * | P3 | `GET /@<token>/amm/pools/beef?lp=k1,k2` | `{pools: [P2 row without validatorPeerId], beef: <base64 BEEF of their transactions>}` |
 * | P4 | `GET /@<token>/amm/positions?lp=k1,k2` | `[{lpPubKey, status: live|rescinded|closed, outpoint?, current?, sats, tokens, swaps}]` |
 * | P5 | `GET /@<token>/amm/fees/validator?id=k1,k2` | `[{validatorIdentityKey, sats, tokens, swaps, pools}]` |
 * | P6 | `GET /@<token>/amm/fees/commission?pkh=h1,h2` | `[{commissionPkh, sats, tokens, swaps}]` |
 * | P7 | `GET /@<token>/amm/terms` | `{validator: {identity, peerId, lpFeeBps, validatorFeeBps, commissionBps} | null, market: {commissionPkh, minCommissionBps}}` |
 * | P8 | `GET /@<token>/amm/spends?outpoint=a,b` | `[{outpoint, spentBy?, current?, hops, closed}]` (one outpoint: the object) |
 * | P9 | `GET /@<token>/amm/tx?id=<txid>` | the transaction's BEEF (bytes) |
 * | P10 | `GET /@<token>/amm/swaps?id=<id>` | the relay record, as `amm.swap.status` answers it |
 * | P11 | `GET /@<token>/amm/token` | the token's record |
 * | P12 | `GET <origin>/amm/tokens` | the exchange's token list (src/lib/skein.ts `readTokens`) |
 * | P13 | `GET /@discovery/1color/tokens?ids=a,b` (or paged `?limit=&skip=`) | `[{tokenId, topic, sym, dec, iconUrl?, txid, vout}]`; an id not on discovery `{tokenId, listed: false}` |
 * | P14 | `GET /@discovery/1color/<token>` | `{tokenId, topic, sym, dec, txid, vout, iconUrl?}` |
 * | P15 | `GET /@discovery/1color/<token>/icon` | the icon's bytes |
 * | P16 | `GET /@discovery/1color/<token>/deploy` | the deploy's BEEF (bytes) |
 * | P17 | `GET <origin>/.well-known/skein`, `/skeins?key=`, `/amm/admin`, `/amm/defaults`, `/amm/discovery` | as before |
 *
 * Writes stay what they were: `POST <origin>/submit` (BRC-22, plain), `/call` and `/sendMessage`
 * (signed, the wallet's BRC-104 client).
 *
 * Names (skein-1color docs/1COLOR.md "The topic"): a token's topic is `tm_color_<assetId>`
 * (BRC-207), the asset id `<txid>_<vout>`, `_0` included.
 */
import { Beef, Utils } from "@bsv/sdk";
import type { PoolState } from "@amm-poc/matching-engine";
import { parseTokenId, tokenIdText } from "./tokenId";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export interface TokenTopic {
  /** `tm_color_<txid>_<vout>` (`tm_color_<txid>_0` at output 0). */
  topic: string;
  /** Deploy txid, 64 lowercase hex, display order. */
  txid: string;
  vout: number;
  kind: "native" | "legacy";
  /** The token id, `<txid>_<vout>` (src/lib/tokenId.ts, BRC-162 "Token identification"). */
  tokenId: string;
}

/** The AMM pool lookup service of a token (programs/amm-lookup; 0.21.0): `ls_amm_<assetId>`. A name only: the pages send it no query. */
export function ammLookupService(tokenId: string): string {
  const ref = parseTokenId(tokenId);
  if (!ref) throw new Error(`not a token id: ${tokenId}`);
  return `ls_amm_${tokenIdText(ref)}`;
}

const TOPIC = /^tm_color_([0-9a-f]{64})_(0|[1-9]\d*)$/;

/** A token topic name, `tm_color_<txid>_<vout>` (BRC-207), or null for anything else. */
export function parseTokenTopic(name: string): TokenTopic | null {
  const m = TOPIC.exec(name);
  if (!m) return null;
  const txid = m[1]!;
  const vout = Number(m[2]);
  return { topic: name, txid, vout, kind: vout === 0 ? "native" : "legacy", tokenId: tokenIdText({ txid, vout }) };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** A pool row on the wire (P2, P3, P4's `current`): JSON numbers, bigints here. */
interface WirePool {
  lpPubKey?: string;
  outpoint: string;
  bsvReserve: number | string;
  tokenReserve: number | string;
  liquidityFeeBps: number | string;
  validationFeeBps: number | string;
  commissionBps?: number | string;
  validatorIdentityKey: string;
  validatorPeerId?: string;
  tokenId?: string;
}

/** The engine's PoolState from a wire row (the reserves and fees as bigints). */
export function toPoolState(raw: WirePool): PoolState {
  return {
    outpoint: raw.outpoint,
    bsvReserve: BigInt(raw.bsvReserve),
    tokenReserve: BigInt(raw.tokenReserve),
    liquidityFeeBps: BigInt(raw.liquidityFeeBps),
    validationFeeBps: BigInt(raw.validationFeeBps),
    commissionBps: BigInt(raw.commissionBps ?? 0),
    validatorIdentityKey: raw.validatorIdentityKey,
  };
}

/** A pool of the pools routes: the engine's PoolState, its LP key (the pool's id, D2), and (P2) its validator's peer ID. */
export interface PoolRow extends PoolState {
  lpPubKey: string;
  /** P2: the validator's libp2p peer ID, from its beat (what the relay dials). */
  validatorPeerId?: string;
  /** P1: the token. */
  tokenId?: string;
}

function isWirePool(x: unknown): x is WirePool {
  const r = x as Record<string, unknown> | null;
  return !!r && typeof r === "object" && typeof r.outpoint === "string" && typeof r.validatorIdentityKey === "string" && r.bsvReserve !== undefined && r.tokenReserve !== undefined;
}

/** One pool row, or null when it is not one. */
export function toPoolRow(raw: unknown): PoolRow | null {
  if (!isWirePool(raw)) return null;
  return {
    ...toPoolState(raw),
    lpPubKey: typeof raw.lpPubKey === "string" ? raw.lpPubKey.toLowerCase() : "",
    ...(typeof raw.validatorPeerId === "string" && raw.validatorPeerId ? { validatorPeerId: raw.validatorPeerId } : {}),
    ...(typeof raw.tokenId === "string" ? { tokenId: raw.tokenId } : {}),
  };
}

function poolRows(x: unknown): PoolRow[] {
  return (Array.isArray(x) ? x : []).map(toPoolRow).filter((r): r is PoolRow => r !== null);
}

/** The market of a token instance, as P2 carries it: where its relay takes the commission (hash160 hex), its minimum commission. */
export interface Market {
  commissionPkh: string | null;
  minCommissionBps: number;
}

function toMarket(x: unknown): Market {
  const m = x as Record<string, unknown> | null;
  const pkh = typeof m?.commissionPkh === "string" && /^[0-9a-fA-F]{40}$/.test(m.commissionPkh) ? m.commissionPkh.toLowerCase() : null;
  const min = typeof m?.minCommissionBps === "number" && Number.isInteger(m.minCommissionBps) ? m.minCommissionBps : 0;
  return { commissionPkh: pkh, minCommissionBps: min };
}

/** P2's answer: the market and the pools a swap may use now. */
export interface PoolsAnswer {
  market: Market;
  pools: PoolRow[];
}

/** P2's JSON. */
export function parsePools(x: unknown): PoolsAnswer {
  const a = x as { market?: unknown; pools?: unknown } | null;
  return { market: toMarket(a?.market), pools: poolRows(a?.pools) };
}

/** P1's JSON: every enabled token's rows, each naming its `tokenId`. */
export function parseAllPools(x: unknown): PoolRow[] {
  return poolRows(x).filter((r) => typeof r.tokenId === "string");
}

/** A validator seen beating (the pages take it from the pools route's rows: the host joined the beats, D11). */
export interface LiveValidator {
  identityKey: string;
  /** libp2p peer ID, text (base58): what the swap names for the relay to dial. */
  peerId: string;
  /** The beat's time, ms epoch (0: not told). */
  at: number;
  ageMs: number;
  live: boolean;
}

export interface LiveAnswer {
  now: number;
  validators: LiveValidator[];
  /** False when nothing about liveness is known. */
  kept: boolean;
}

/** The validators of the pools route's rows (every one live: the host listed only those), as the plan reads liveness. */
export function liveOfPools(rows: Pick<PoolRow, "validatorIdentityKey" | "validatorPeerId">[], now: number = Date.now()): LiveAnswer {
  const byKey = new Map<string, LiveValidator>();
  for (const r of rows) {
    const k = r.validatorIdentityKey.toLowerCase();
    if (!r.validatorPeerId || byKey.has(k)) continue;
    byKey.set(k, { identityKey: k, peerId: r.validatorPeerId, at: 0, ageMs: 0, live: true });
  }
  return { now, validators: [...byKey.values()], kept: true };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The connected wallet's BRC-104 client (`@bsv/sdk` `AuthFetch`, or a test's fake): the signed writes. */
export interface SignedFetch {
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const plain: FetchFn = (url, init) => fetch(url, init);

async function getJson(url: string, fetchFn: FetchFn = plain): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function getBytes(url: string, fetchFn: FetchFn = plain): Promise<number[] | null> {
  const res = await fetchFn(url, { headers: { accept: "application/octet-stream" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Array.from(new Uint8Array(await res.arrayBuffer()));
}

const trim = (base: string) => base.replace(/\/+$/, "");
const list = (xs: string[]) => xs.map(encodeURIComponent).join(",");

/** P1 / P2's URL: `<base>/pools` (the swap instance's app base: every token; a token instance's: that token). */
export function poolsUrl(base: string): string {
  return `${trim(base)}/pools`;
}

/** P2 once (a one-shot reader; the Swap page holds the stream, `watchPools`). */
export async function readPools(base: string, fetchFn?: FetchFn): Promise<PoolsAnswer> {
  return parsePools(await getJson(poolsUrl(base), fetchFn));
}

/** What `watchPools` needs of the browser's `EventSource` (tests pass a fake). */
export interface EventSourceLike {
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void;
  close(): void;
  onerror?: ((e: unknown) => void) | null;
  onopen?: ((e: unknown) => void) | null;
}
export type EventSourceCtor = new (url: string) => EventSourceLike;

function eventSourceCtor(): EventSourceCtor | null {
  const g = globalThis as { EventSource?: EventSourceCtor };
  return typeof g.EventSource === "function" ? g.EventSource : null;
}

/**
 * Holds a pools route (P1 or P2) as an event stream (D16, D22): `GET <url>` with `Accept:
 * text/event-stream` (the browser's EventSource sends it), the event `pools` carrying the answer,
 * first the current one, then again each time it changes; `onAnswer` gets each. Without an
 * EventSource (an old browser, a test): ONE plain GET, no poll. → the unsubscribe.
 */
export function watchPools<T>(
  url: string,
  parse: (x: unknown) => T,
  onAnswer: (a: T) => void,
  o: { onError?: (e: unknown) => void; onOpen?: () => void; EventSource?: EventSourceCtor | null; fetch?: FetchFn } = {},
): () => void {
  const ES = o.EventSource === undefined ? eventSourceCtor() : o.EventSource;
  let stopped = false;
  if (!ES) {
    getJson(url, o.fetch).then(
      (x) => {
        if (!stopped) onAnswer(parse(x));
      },
      (e: unknown) => {
        if (!stopped) o.onError?.(e);
      },
    );
    return () => {
      stopped = true;
    };
  }
  const es = new ES(url);
  es.addEventListener("pools", (e) => {
    if (stopped) return;
    try {
      onAnswer(parse(JSON.parse(String(e.data))));
    } catch (err) {
      o.onError?.(err);
    }
  });
  es.onopen = () => o.onOpen?.();
  es.onerror = (e) => o.onError?.(e);
  return () => {
    stopped = true;
    es.close();
  };
}

/** P3's answer: the LP keys' current pools and one BEEF of their transactions. */
export interface PoolsBeef {
  pools: PoolRow[];
  beef: number[];
}

/** P3: `GET <base>/pools/beef?lp=k1,k2` (no `lpKeys`: every live pool). */
export async function readPoolsBeef(base: string, lpKeys?: string[], fetchFn?: FetchFn): Promise<PoolsBeef> {
  const url = `${trim(base)}/pools/beef${lpKeys ? `?lp=${list(lpKeys)}` : ""}`;
  const a = (await getJson(url, fetchFn)) as { pools?: unknown; beef?: unknown } | null;
  return { pools: poolRows(a?.pools), beef: typeof a?.beef === "string" && a.beef ? Utils.toArray(a.beef, "base64") : [] };
}

/** One output of a pool transaction with its BEEF (Atomic, the transaction its subject): what a spend of the pool is built from. */
export interface LookupOutput {
  beef: number[];
  outputIndex: number;
}

/** The pool `outpoint` (`<txid>_<vout>`) out of P3's BEEF, as an Atomic BEEF of its transaction; null when the BEEF lacks it. */
export function poolOutputOf(pb: PoolsBeef, outpoint: string): LookupOutput | null {
  const m = /^([0-9a-f]{64})[._](\d+)$/i.exec(outpoint);
  if (!m || pb.beef.length === 0) return null;
  const beef = Beef.fromBinary(pb.beef);
  if (!beef.findTxid(m[1]!.toLowerCase())) return null;
  return { beef: beef.toBinaryAtomic(m[1]!.toLowerCase()), outputIndex: Number(m[2]) };
}

/** One LP key's pool and fees (P4): `live` (its live pool), `rescinded` (the validator's Rescind wrote `outpoint`: the LP's Close takes it back), `closed`. */
export interface LpPool {
  lpPubKey: string;
  status: "live" | "rescinded" | "closed";
  /** The output a Close acts on, `<txid>_<vout>` (live and rescinded). */
  outpoint: string | null;
  /** That output's pool state (live and rescinded). */
  current: PoolState | null;
  /** The LP fees of sats-in swaps. */
  sats: bigint;
  /** The LP fees of token-in swaps, token base units. */
  tokens: bigint;
  swaps: number;
}

const wireBig = (x: unknown): bigint => (typeof x === "number" || typeof x === "string" || typeof x === "bigint" ? BigInt(x) : 0n);

/** P4: `GET <base>/positions?lp=k1,k2` → one record per key in the same order. */
export async function readPositions(base: string, lpPubKeys: string[], fetchFn?: FetchFn): Promise<LpPool[]> {
  const url = `${trim(base)}/positions?lp=${list(lpPubKeys)}`;
  const a = await getJson(url, fetchFn);
  if (!Array.isArray(a) || a.length !== lpPubKeys.length) throw new Error(`GET ${url}: not one record per key`);
  return (a as Record<string, unknown>[]).map((r, i) => {
    const status = r.status === "live" || r.status === "rescinded" ? r.status : "closed";
    return {
      lpPubKey: typeof r.lpPubKey === "string" ? r.lpPubKey : lpPubKeys[i]!,
      status,
      outpoint: typeof r.outpoint === "string" ? r.outpoint : null,
      current: isWirePool(r.current) ? toPoolState(r.current) : null,
      sats: wireBig(r.sats),
      tokens: wireBig(r.tokens),
      swaps: Number(r.swaps ?? 0),
    };
  });
}

/** P7's answer: this instance's validator terms (null: none set, a market only) and its market. */
export interface InstanceTerms {
  validator: { identity: string; peerId: string | null; lpFeeBps: number; validatorFeeBps: number; commissionBps: number } | null;
  market: Market;
}

/** P7: `GET <base>/terms`, unsigned. */
export async function readTerms(base: string, fetchFn?: FetchFn): Promise<InstanceTerms> {
  const url = `${trim(base)}/terms`;
  const a = (await getJson(url, fetchFn)) as { validator?: Record<string, unknown> | null; market?: unknown } | null;
  const v = a?.validator;
  const int = (x: unknown, name: string) => {
    if (typeof x !== "number" || !Number.isInteger(x)) throw new Error(`GET ${url}: no ${name}`);
    return x;
  };
  return {
    validator:
      v && typeof v === "object"
        ? {
            identity: String(v.identity ?? "").toLowerCase(),
            peerId: typeof v.peerId === "string" ? v.peerId : null,
            lpFeeBps: int(v.lpFeeBps, "lpFeeBps"),
            validatorFeeBps: int(v.validatorFeeBps, "validatorFeeBps"),
            commissionBps: int(v.commissionBps, "commissionBps"),
          }
        : null,
    market: toMarket(a?.market),
  };
}

/** The chain state of an outpoint (P8; amm-p2p reads.zig `spendOf`). */
export interface Spend {
  /** `<txid>.<vout>` */
  outpoint: string;
  spentBy?: string;
  /** Followed from a pool output: its current output, `<txid>.<vout>`. */
  current?: string;
  hops: number;
  closed: boolean;
}

/** P8: `GET <base>/spends?outpoint=a,b` → one record per outpoint in query order (one outpoint: its object, wrapped). */
export async function readSpends(base: string, outpoints: string[], fetchFn?: FetchFn): Promise<Spend[]> {
  if (outpoints.length === 0) return [];
  const a = await getJson(`${trim(base)}/spends?outpoint=${list(outpoints)}`, fetchFn);
  return (Array.isArray(a) ? a : [a]) as Spend[];
}

/** P9: `GET <base>/tx?id=<txid>`: the transaction's BEEF (every input's source with it); null when the instance does not hold it. */
export async function readTx(base: string, txid: string, fetchFn?: FetchFn): Promise<number[] | null> {
  return getBytes(`${trim(base)}/tx?id=${encodeURIComponent(txid)}`, fetchFn);
}

/** P10: `GET <base>/swaps?id=<id>`: the relay record (dag-json, as `amm.swap.status` answers it); null when unknown. */
export async function readSwap(base: string, id: string, fetchFn?: FetchFn): Promise<unknown | null> {
  const res = await (fetchFn ?? plain)(`${trim(base)}/swaps?id=${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${trim(base)}/swaps: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** A token on discovery (P13, P14): its metadata; `iconUrl` absolute (P13 gives it relative to the list). */
export interface DiscoveryRow {
  tokenId: string;
  listed: boolean;
  topic?: string;
  sym?: string;
  dec?: number;
  iconUrl?: string;
  txid?: string;
  vout?: number;
}

function discoveryRow(x: Record<string, unknown>, listUrl: string): DiscoveryRow {
  const listed = x.listed !== false;
  const dec = typeof x.dec === "number" ? x.dec : typeof x.dec === "string" && /^\d+$/.test(x.dec) ? Number(x.dec) : undefined;
  const icon = typeof x.iconUrl === "string" && x.iconUrl ? new URL(x.iconUrl, listUrl).href : undefined;
  return {
    tokenId: String(x.tokenId),
    listed,
    ...(typeof x.topic === "string" ? { topic: x.topic } : {}),
    ...(typeof x.sym === "string" ? { sym: x.sym } : {}),
    ...(dec !== undefined ? { dec } : {}),
    ...(icon ? { iconUrl: icon } : {}),
    ...(typeof x.txid === "string" ? { txid: x.txid } : {}),
    ...(typeof x.vout === "number" ? { vout: x.vout } : {}),
  };
}

/** P13 with `ids`: `GET <discovery>/tokens?ids=a,b` → one row per id in query order (`listed: false` for one not on discovery). */
export async function readDiscoveryIds(discovery: string, ids: string[], fetchFn?: FetchFn): Promise<DiscoveryRow[]> {
  if (ids.length === 0) return [];
  const url = `${trim(discovery)}/tokens?ids=${list(ids)}`;
  const a = await getJson(url, fetchFn);
  return (Array.isArray(a) ? (a as Record<string, unknown>[]) : []).filter((t) => typeof t?.tokenId === "string").map((t) => discoveryRow(t, url));
}

/** The route's page size (skein-1color color-lookup `tokens`: `limit` 1 to 100, `skip` up to 100000). */
const PAGE = 100;
const MAX_SKIP = 100_000;

/** P13 paged: discovery's whole token list, newest first, a page at a time. */
export async function readDiscoveryList(discovery: string, fetchFn?: FetchFn): Promise<DiscoveryRow[]> {
  const out: DiscoveryRow[] = [];
  for (let skip = 0; skip <= MAX_SKIP; skip += PAGE) {
    const url = `${trim(discovery)}/tokens?limit=${PAGE}&skip=${skip}`;
    const a = await getJson(url, fetchFn);
    const page = (Array.isArray(a) ? (a as Record<string, unknown>[]) : []).filter((t) => typeof t?.tokenId === "string").map((t) => discoveryRow(t, url));
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** P16: `GET <discovery>/<token>/deploy`: the deploy's BEEF; null when discovery does not hold it. */
export async function readDiscoveryDeploy(discovery: string, tokenId: string, fetchFn?: FetchFn): Promise<number[] | null> {
  return getBytes(`${trim(discovery)}/${encodeURIComponent(tokenId)}/deploy`, fetchFn);
}
