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
 * | P1 | `GET <origin>/amm/pools` | `[{tokenId, …P2 row}]`, every enabled token's live pools (the host's) |
 * | P2 | `GET <origin>/@<token>/amm/pools` (0.41.0: a plain read only) | `{market: {commissionPkh, minCommissionBps}, validators: [{identity, peerId, minLegSats?}] (0.34.1: beating now; 0.40.0: the minimum leg its terms announce), pools: [{poolId, lpPubKey, outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps, commissionBps, validatorIdentityKey, validatorPeerId, swaps}]}`: only pools whose validator beats now and whose commission is at or above the market's minimum (the host's) |
 * | P3 | `GET /@<token>/amm/pools/beef?pool=id1,id2` (0.40.0: by pool id) | `{pools: [P2 row without validatorPeerId], beef: <base64 BEEF of their transactions>}` |
 * | P4 | `GET /@<token>/amm/positions?pool=id1,id2` (0.40.0) | `[{poolId, lpPubKey, status: live|rescinded|closed, outpoint?, current?, sats, tokens, swaps}]` |
 * | P5 | `GET /@<token>/amm/fees/validator?id=k1,k2` | `[{validatorIdentityKey, sats, tokens, swaps, pools}]` |
 * | P6 | `GET /@<token>/amm/fees/commission?pkh=h1,h2` | `[{commissionPkh, sats, tokens, swaps}]` |
 * | P7 | `GET /@<token>/amm/terms` | `{validator: {identity, peerId, lpFeeBps, validatorFeeBps, commissionBps, minLegSats} | null, market: {commissionPkh, minCommissionBps}}` |
 * | P8 | `GET /@<token>/amm/spends?outpoint=a,b` | `[{outpoint, spentBy?, current?, hops, closed}]` (one outpoint: the object) |
 * | P9 | `GET /@<token>/amm/tx?id=<txid>` | the transaction's BEEF (bytes) |
 * | (P10) | gone in 0.44.0: the host relays a leg (`POST /@<token>/amm/swap`, src/market/relay.ts), nothing is recorded |
 * | P11 | `GET /@<token>/amm/token` | the token's record |
 * | P12 | `GET <origin>/amm/tokens` | the exchange's token list (src/lib/skein.ts `readTokens`) |
 * | P13 | `GET /@discovery/1color/tokens?ids=a,b` (or paged `?limit=&skip=`) | `[{tokenId, topic, sym, dec, iconUrl?, txid, vout}]`; an id not on discovery `{tokenId, listed: false}` |
 * | P14 | `GET /@discovery/1color/<token>` | `{tokenId, topic, sym, dec, txid, vout, iconUrl?}` |
 * | P15 | `GET /@discovery/1color/<token>/icon` | the icon's bytes |
 * | P16 | `GET /@discovery/1color/<token>/deploy` | the deploy's BEEF (bytes) |
 * | P17 | `GET <origin>/.well-known/skein`, `/skeins?key=`, `/amm/admin`, `/amm/defaults`, `/amm/discovery` | as before |
 * | H1 | `GET /@<token>/amm/trades?from=&to=&limit=&before=&pool=` (or `?txid=`) | `{trades: [Trade], next}` newest first (one txid: the row) |
 * | H2 | `GET /@<token>/amm/candles?tf=&from=&to=&series=fill|market` | `[{t, o, h, l, c, volumeSats, volumeTokens, n}]`, one per non-empty bucket (0.40.0: `market`, the host's: the price after each pool event) |
 * | H3 | `GET /@<token>/amm/stats` | `{tokenId, price, buyPrice, sellPrice, lastTradePrice, change1h, change24h, volume24hSats, volume24hTokens, buys24h, sells24h, lastTradeAt, tvlSats, tvlTokens, pools}` |
 * | H4 | `GET <origin>/amm/stats?ids=` | `[H3]`, every enabled token's (the host's) |
 * | H5 | `GET <origin>/amm/positions?pool=` | `[{tokenId, …P4 row}]`, every enabled token's (the host's) |
 * | H7 | `GET /@<token>/amm/pools/at?t=<ms>` (0.40.0) | `[{poolId, outpoint, bsvReserve, tokenReserve, lpPubKey, …the three bps, validatorIdentityKey, at, swaps}]`: every pool listed at `t` |
 * | H8 | `GET /@<token>/amm/pools/history?from=&to=&pool=&limit=&after=` (0.40.0) | `{events: [PoolEvent], next}` oldest first; `next` → `after` |
 * | H9 | `GET <origin>/amm/spends?outpoint=a,b` (0.40.0, the host's) | `[{outpoint, tokenId?, spentBy?}]`: each enabled token's `/spends`, the first that names a spender |
 * | H6 | `GET /@<token>/amm/color/<token>/holders?limit=&skip=` | `{count, rows: [{address, balance}]}` largest first |
 * | E1 | `GET /@<token>/amm/events`, `GET <origin>/amm/events` (0.41.0, the host's) | Server-Sent Events, each `event: pool`, `data: {tokenId, …row}`: the AMM lookup's pool event (a deploy, swap, close or rescind: the H8 row; a `revert`), one token's or every enabled token's; nothing on connect, nothing replayed |
 *
 * 0.41.0 (agent-env plans/swap-balance-build-2026-11-05.md §5): P2's event-stream form is gone
 * (0.39.0's `pools` / `change` events); the pool events are the lookup's, passed through by the
 * host's feeds (E1): signals for display, the pools route the truth.
 *
 * 0.40.0 (agent-env plans/swap-balance-build-2026-11-05.md §0 3): a pool's id is its deploy outpoint
 * `<txid>_<vout>` (`poolId`, copied forward along its swaps); every read by LP key is by pool id
 * now (`?pool=`), the LP key a field. A clean break: no `?lp=` here.
 *
 * Writes stay what they were: `POST <origin>/submit` (BRC-22, plain), `/call` and `/sendMessage`
 * (signed, the wallet's BRC-104 client).
 *
 * Names (skein-1color docs/1COLOR.md "The topic"): a token's topic is `tm_color_<assetId>`
 * (BRC-207), the asset id `<txid>_<vout>`, `_0` included.
 */
import { Beef, Utils } from "@bsv/sdk";
import type { PoolState } from "@dcasegr/amm-engine";
import { parseTokenId, tokenIdText } from "./tokenId.js";

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
  poolId?: string;
  lpPubKey?: string;
  swaps?: number | string;
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

/** A pool of the pools routes: the engine's PoolState, its id (0.40.0: the deploy outpoint `<txid>_<vout>`), its LP key, its swap count, and (P2) its validator's peer ID. */
export interface PoolRow extends PoolState {
  /** The pool's id: its deploy outpoint, `<txid>_<vout>` (0.40.0). */
  poolId: string;
  lpPubKey: string;
  /** The pool's swaps so far (0 at the deploy). */
  swaps: number;
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
    poolId: typeof raw.poolId === "string" ? raw.poolId.toLowerCase() : "",
    lpPubKey: typeof raw.lpPubKey === "string" ? raw.lpPubKey.toLowerCase() : "",
    swaps: Number(raw.swaps ?? 0),
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

/** A validator beating on the token's topic now (P2's `validators`, 0.34.1): its identity key and libp2p peer ID; 0.40.0, the minimum leg its terms announce (sats on the leg's sats side; absent: none). */
export interface BeatingValidator {
  identity: string;
  peerId: string;
  minLegSats?: bigint;
}

/** P2's answer: the market, the pools a swap may use now, and (0.34.1) the validators beating on the token's topic now. */
export interface PoolsAnswer {
  market: Market;
  pools: PoolRow[];
  validators: BeatingValidator[];
}

/** P2's JSON. */
export function parsePools(x: unknown): PoolsAnswer {
  const a = x as { market?: unknown; pools?: unknown; validators?: unknown } | null;
  const validators = (Array.isArray(a?.validators) ? (a!.validators as Record<string, unknown>[]) : [])
    .filter((v) => v && typeof v.identity === "string")
    .map((v) => {
      const min = typeof v.minLegSats === "number" || typeof v.minLegSats === "string" ? BigInt(v.minLegSats) : 0n;
      return { identity: String(v.identity).toLowerCase(), peerId: typeof v.peerId === "string" ? v.peerId : "", ...(min > 0n ? { minLegSats: min } : {}) };
    });
  return { market: toMarket(a?.market), pools: poolRows(a?.pools), validators };
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

/** P2: the token's pools as the host lists them now (0.41.0: a plain read only). */
export async function readPools(base: string, fetchFn?: FetchFn): Promise<PoolsAnswer> {
  return parsePools(await getJson(poolsUrl(base), fetchFn));
}

/** What `watchPoolEvents` needs of the browser's `EventSource` (tests pass a fake). */
export interface EventSourceLike {
  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void;
  close(): void;
  onerror?: ((e: unknown) => void) | null;
}
export type EventSourceCtor = new (url: string) => EventSourceLike;

function eventSourceCtor(): EventSourceCtor | null {
  const g = globalThis as { EventSource?: EventSourceCtor };
  return typeof g.EventSource === "function" ? g.EventSource : null;
}

/** E1's URL: `<base>/events` (a token instance's app base: that token's; the swap app's: every token's). */
export function eventsUrl(base: string): string {
  return `${trim(base)}/events`;
}

/**
 * Listens to a host's pool event feed (E1, 0.41.0): each `pool` message parsed
 * (`parsePoolEventMessage`) to `onEvent`; one it cannot parse is passed over. Reconnecting is the
 * browser's EventSource's. Without an EventSource: nothing. → the unsubscribe.
 */
export function watchPoolEvents(url: string, onEvent: (e: PoolEventMessage) => void, o: { onError?: (e: unknown) => void; EventSource?: EventSourceCtor | null } = {}): () => void {
  const ES = o.EventSource === undefined ? eventSourceCtor() : o.EventSource;
  if (!ES) return () => {};
  let stopped = false;
  const es = new ES(url);
  es.addEventListener("pool", (e) => {
    if (stopped) return;
    let m: PoolEventMessage | null = null;
    try {
      m = parsePoolEventMessage(JSON.parse(String(e.data)));
    } catch {
      m = null;
    }
    if (m) onEvent(m);
  });
  es.onerror = (e) => o.onError?.(e);
  return () => {
    stopped = true;
    es.close();
  };
}

/** P3's answer: the pools' current outputs and one BEEF of their transactions. */
export interface PoolsBeef {
  pools: PoolRow[];
  beef: number[];
}

/** P3: `GET <base>/pools/beef?pool=id1,id2` (0.40.0: by pool id; no `poolIds`: every live pool). */
export async function readPoolsBeef(base: string, poolIds?: string[], fetchFn?: FetchFn): Promise<PoolsBeef> {
  const url = `${trim(base)}/pools/beef${poolIds ? `?pool=${list(poolIds)}` : ""}`;
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

/** One pool's state and fees (P4, 0.40.0: by pool id): `live` (its live output), `rescinded` (the validator's Rescind wrote `outpoint`: the LP's Close takes it back), `closed`. */
export interface LpPool {
  /** The pool's id, `<txid>_<vout>` (its deploy outpoint). */
  poolId: string;
  /** Its LP key (null for an id this instance does not know). */
  lpPubKey: string | null;
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

/** One P4 / H5 record. */
function lpPoolOf(r: Record<string, unknown>, poolId: string): LpPool {
  const status = r.status === "live" || r.status === "rescinded" ? r.status : "closed";
  return {
    poolId: typeof r.poolId === "string" ? r.poolId.toLowerCase() : poolId,
    lpPubKey: typeof r.lpPubKey === "string" ? r.lpPubKey.toLowerCase() : null,
    status,
    outpoint: typeof r.outpoint === "string" ? r.outpoint : null,
    current: isWirePool(r.current) ? toPoolState(r.current) : null,
    sats: wireBig(r.sats),
    tokens: wireBig(r.tokens),
    swaps: Number(r.swaps ?? 0),
  };
}

/** P4: `GET <base>/positions?pool=id1,id2` (0.40.0) → one record per pool id in the same order. */
export async function readPositions(base: string, poolIds: string[], fetchFn?: FetchFn): Promise<LpPool[]> {
  const url = `${trim(base)}/positions?pool=${list(poolIds)}`;
  const a = await getJson(url, fetchFn);
  if (!Array.isArray(a) || a.length !== poolIds.length) throw new Error(`GET ${url}: not one record per pool`);
  return (a as Record<string, unknown>[]).map((r, i) => lpPoolOf(r, poolIds[i]!));
}

/** P7's answer: this instance's validator terms (null: none set, a market only) and its market. */
export interface InstanceTerms {
  /** 0.40.0: `minLegSats` the minimum leg (sats on the leg's sats side), 0 = none. */
  validator: { identity: string; peerId: string | null; lpFeeBps: number; validatorFeeBps: number; commissionBps: number; minLegSats: number } | null;
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
            minLegSats: typeof v.minLegSats === "number" && Number.isInteger(v.minLegSats) ? v.minLegSats : 0,
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

// ---------------------------------------------------------------------------
// History, stats, holders (0.39.0; agent-env plans/history-api-2026-11-05.md D1–D7)
// ---------------------------------------------------------------------------

/** A price, exact (H1–H4): `sats` satoshis per `tokens` token base units (divide in the caller). */
export interface Price {
  sats: bigint;
  tokens: bigint;
}

/** A Swap's trade row (H1; the `swap` change's `trade`): amounts in base units, fees in the input asset, the pool's reserves after it. */
export interface Trade {
  txid: string;
  /** The pool's id, `<txid>_<vout>` (0.40.0). */
  poolId: string;
  lpPubKey: string;
  /** The hash160 (hex) the payout went to (the call's `userPkh`, 0.40.0): an order's legs share it. */
  payoutPkh: string;
  /** `buy`: sats in, tokens out; `sell`: tokens in. */
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  feeLp: bigint;
  feeValidator: bigint;
  feeCommission: bigint;
  bsvReserve: bigint;
  tokenReserve: bigint;
  /** The admitting step's time, ms. */
  at: number;
  /** The block height where the overlay has the transaction placed, else null. */
  height: number | null;
}

/** H1's page: the trades newest first, `next` the cursor of the page after (null: the last page). */
export interface TradesPage {
  trades: Trade[];
  next: string | null;
}

/** One non-empty bucket (H2): its start (ms), the first, highest, lowest and last trade's prices, each side's amounts summed, the trade count. */
export interface Candle {
  t: number;
  o: Price;
  h: Price;
  l: Price;
  c: Price;
  volumeSats: bigint;
  volumeTokens: bigint;
  n: number;
}

/** A candle's resolution (H2). */
export type CandleTf = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** A token at the read's time (H3, H4): the changes in bps (null without a trade at or before the window's start). */
export interface TokenStats {
  tokenId: string;
  /**
   * 0.40.0 (the host's): the midpoint of what a buy and a sell of 1% of the pooled sats would pay
   * now (the engine's `priceOf(listed pools).mid`), null with no pool.
   */
  price: Price | null;
  /** What that buy would pay (sats per tokens), null with no pool. */
  buyPrice: Price | null;
  /** What that sell would pay, null with no pool. */
  sellPrice: Price | null;
  /** The last trade's price, null without one. */
  lastTradePrice: Price | null;
  change1h: number | null;
  change24h: number | null;
  volume24hSats: bigint;
  volume24hTokens: bigint;
  buys24h: number;
  sells24h: number;
  lastTradeAt: number | null;
  tvlSats: bigint;
  tvlTokens: bigint;
  pools: number;
}

/** A token's holders (H6): `count` the addresses with a balance, `rows` largest balance first. */
export interface Holders {
  count: number;
  rows: { address: string; balance: bigint }[];
}

/** One LP key's position on one token (H5): P4's record with its token. */
export interface TokenPosition extends LpPool {
  tokenId: string;
}

const intOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const int = (x: unknown): number => intOrNull(x) ?? 0;

function toPrice(x: unknown): Price | null {
  const p = x as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.sats === undefined || p.tokens === undefined) return null;
  return { sats: wireBig(p.sats), tokens: wireBig(p.tokens) };
}

/** A trade row, or null when it is not one. */
export function toTrade(x: unknown): Trade | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.txid !== "string" || typeof r.lpPubKey !== "string" || (r.side !== "buy" && r.side !== "sell")) return null;
  return {
    txid: r.txid.toLowerCase(),
    poolId: typeof r.poolId === "string" ? r.poolId.toLowerCase() : "",
    lpPubKey: r.lpPubKey.toLowerCase(),
    payoutPkh: typeof r.payoutPkh === "string" ? r.payoutPkh.toLowerCase() : "",
    side: r.side,
    amountIn: wireBig(r.amountIn),
    amountOut: wireBig(r.amountOut),
    feeLp: wireBig(r.feeLp),
    feeValidator: wireBig(r.feeValidator),
    feeCommission: wireBig(r.feeCommission),
    bsvReserve: wireBig(r.bsvReserve),
    tokenReserve: wireBig(r.tokenReserve),
    at: int(r.at),
    height: intOrNull(r.height),
  };
}

function toCandle(x: unknown): Candle | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const [o, h, l, c] = [toPrice(r.o), toPrice(r.h), toPrice(r.l), toPrice(r.c)];
  if (!o || !h || !l || !c || typeof r.t !== "number") return null;
  return { t: r.t, o, h, l, c, volumeSats: wireBig(r.volumeSats), volumeTokens: wireBig(r.volumeTokens), n: int(r.n) };
}

/** A stats record (H3), or null when it is not one. */
export function toStats(x: unknown): TokenStats | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.tokenId !== "string") return null;
  return {
    tokenId: r.tokenId,
    price: toPrice(r.price),
    buyPrice: toPrice(r.buyPrice),
    sellPrice: toPrice(r.sellPrice),
    lastTradePrice: toPrice(r.lastTradePrice),
    change1h: intOrNull(r.change1h),
    change24h: intOrNull(r.change24h),
    volume24hSats: wireBig(r.volume24hSats),
    volume24hTokens: wireBig(r.volume24hTokens),
    buys24h: int(r.buys24h),
    sells24h: int(r.sells24h),
    lastTradeAt: intOrNull(r.lastTradeAt),
    tvlSats: wireBig(r.tvlSats),
    tvlTokens: wireBig(r.tvlTokens),
    pools: int(r.pools),
  };
}

const query = (q: Record<string, string | number | undefined>) => {
  const kv = Object.entries(q).filter(([, x]) => x !== undefined).map(([k, x]) => `${k}=${encodeURIComponent(String(x))}`);
  return kv.length ? `?${kv.join("&")}` : "";
};

/** H1: `GET <base>/trades?from=&to=&limit=&before=&pool=` (0.40.0: `pool` one pool's) → the page, newest first. */
export async function readTrades(base: string, o: { from?: number; to?: number; limit?: number; before?: string; pool?: string } = {}, fetchFn?: FetchFn): Promise<TradesPage> {
  const a = (await getJson(`${trim(base)}/trades${query({ from: o.from, to: o.to, limit: o.limit, before: o.before, pool: o.pool })}`, fetchFn)) as { trades?: unknown; next?: unknown } | null;
  return {
    trades: (Array.isArray(a?.trades) ? a!.trades : []).map(toTrade).filter((t): t is Trade => t !== null),
    next: typeof a?.next === "string" ? a.next : null,
  };
}

/** H1 with `txid`: one Swap's trade row; null when the transaction has none (404). */
export async function readTrade(base: string, txid: string, fetchFn?: FetchFn): Promise<Trade | null> {
  const url = `${trim(base)}/trades?txid=${encodeURIComponent(txid)}`;
  const res = await (fetchFn ?? plain)(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return toTrade(await res.json());
}

/** The candle series (0.40.0): `fill` the trades' prices (the instance's), `market` the price after each pool event (the host's). */
export type CandleSeries = "fill" | "market";

/** H2: `GET <base>/candles?tf=&from=&to=&series=` → one candle per non-empty bucket, oldest first. */
export async function readCandles(base: string, o: { tf: CandleTf; from: number; to: number; series?: CandleSeries }, fetchFn?: FetchFn): Promise<Candle[]> {
  const a = await getJson(`${trim(base)}/candles${query({ tf: o.tf, from: o.from, to: o.to, series: o.series })}`, fetchFn);
  return (Array.isArray(a) ? a : []).map(toCandle).filter((c): c is Candle => c !== null);
}

/** H3: `GET <base>/stats`. */
export async function readStats(base: string, fetchFn?: FetchFn): Promise<TokenStats> {
  const url = `${trim(base)}/stats`;
  const s = toStats(await getJson(url, fetchFn));
  if (!s) throw new Error(`GET ${url}: not a stats record`);
  return s;
}

/** H4: `GET <swap base>/stats` (`ids`: those enabled tokens only, in that order) → every enabled token's stats. */
export async function readAllStats(swapBase: string, ids?: string[], fetchFn?: FetchFn): Promise<TokenStats[]> {
  const a = await getJson(`${trim(swapBase)}/stats${ids ? `?ids=${list(ids)}` : ""}`, fetchFn);
  return (Array.isArray(a) ? a : []).map(toStats).filter((s): s is TokenStats => s !== null);
}

/** H6: `GET <token base>/color/<token>/holders?limit=&skip=` → the count and the rows, largest first. */
export async function readHolders(base: string, tokenId: string, o: { limit?: number; skip?: number } = {}, fetchFn?: FetchFn): Promise<Holders> {
  const a = (await getJson(`${trim(base)}/color/${encodeURIComponent(tokenId)}/holders${query({ limit: o.limit, skip: o.skip })}`, fetchFn)) as { count?: unknown; rows?: unknown } | null;
  return {
    count: int(a?.count),
    rows: (Array.isArray(a?.rows) ? (a!.rows as Record<string, unknown>[]) : []).filter((r) => r && typeof r.address === "string").map((r) => ({ address: String(r.address), balance: wireBig(r.balance) })),
  };
}

/** H5: `GET <swap base>/positions?pool=id1,id2` (0.40.0) → every enabled token's rows for the pools, each with its token. */
export async function readAllPositions(swapBase: string, poolIds: string[], fetchFn?: FetchFn): Promise<TokenPosition[]> {
  if (poolIds.length === 0) return [];
  const a = await getJson(`${trim(swapBase)}/positions?pool=${list(poolIds)}`, fetchFn);
  return (Array.isArray(a) ? (a as Record<string, unknown>[]) : [])
    .filter((r) => r && typeof r.tokenId === "string" && typeof r.poolId === "string")
    .map((r) => ({ tokenId: String(r.tokenId), ...lpPoolOf(r, String(r.poolId)) }));
}

// ---------------------------------------------------------------------------
// The pool history (0.40.0, agent-env plans/swap-balance-build-2026-11-05.md §0 4)
// ---------------------------------------------------------------------------

/** A pool as it was listed at a time (H7): its id, output, reserves, keys, rates, the event's time and its swap count. */
export interface PoolAt extends PoolRow {
  /** The time of the pool's last event at or before the read's `t`, ms. */
  at: number;
}

/** H7: `GET <base>/pools/at?t=<ms>` → every pool listed at `t`. */
export async function readPoolsAt(base: string, t: number, fetchFn?: FetchFn): Promise<PoolAt[]> {
  const a = await getJson(`${trim(base)}/pools/at${query({ t })}`, fetchFn);
  return (Array.isArray(a) ? (a as Record<string, unknown>[]) : []).flatMap((r) => {
    const row = toPoolRow(r);
    return row ? [{ ...row, at: int(r.at) }] : [];
  });
}

/** One event of a pool's history (H8): a deploy, a swap (with its trade fields), a close or a rescind, at the admitting step's time. */
export interface PoolEvent {
  kind: "deploy" | "swap" | "close" | "rescind";
  txid: string;
  poolId: string;
  /** The pool's output after the event (deploy, swap, rescind), `<txid>_<vout>`. */
  outpoint?: string;
  bsvReserve?: bigint;
  tokenReserve?: bigint;
  lpPubKey: string;
  liquidityFeeBps: bigint;
  validationFeeBps: bigint;
  commissionBps: bigint;
  validatorIdentityKey: string;
  at: number;
  swaps: number;
  /** A swap's trade. */
  side?: "buy" | "sell";
  amountIn?: bigint;
  amountOut?: bigint;
  feeLp?: bigint;
  feeValidator?: bigint;
  feeCommission?: bigint;
  commissionPkh?: string;
  payoutPkh?: string;
}

/** H8's page: the events oldest first, `next` the cursor to pass as `after` for the page after (null: none left). */
export interface PoolHistoryPage {
  events: PoolEvent[];
  next: string | null;
}

function toPoolEvent(x: unknown): PoolEvent | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.txid !== "string" || typeof r.poolId !== "string") return null;
  if (r.kind !== "deploy" && r.kind !== "swap" && r.kind !== "close" && r.kind !== "rescind") return null;
  const big = (k: string) => (r[k] === undefined || r[k] === null ? {} : { [k]: wireBig(r[k]) });
  const text = (k: string) => (typeof r[k] === "string" ? { [k]: String(r[k]).toLowerCase() } : {});
  return {
    kind: r.kind,
    txid: r.txid.toLowerCase(),
    poolId: r.poolId.toLowerCase(),
    ...(typeof r.outpoint === "string" ? { outpoint: r.outpoint } : {}),
    ...big("bsvReserve"),
    ...big("tokenReserve"),
    lpPubKey: typeof r.lpPubKey === "string" ? r.lpPubKey.toLowerCase() : "",
    liquidityFeeBps: wireBig(r.liquidityFeeBps),
    validationFeeBps: wireBig(r.validationFeeBps),
    commissionBps: wireBig(r.commissionBps),
    validatorIdentityKey: typeof r.validatorIdentityKey === "string" ? r.validatorIdentityKey.toLowerCase() : "",
    at: int(r.at),
    swaps: int(r.swaps),
    ...(r.side === "buy" || r.side === "sell" ? { side: r.side } : {}),
    ...big("amountIn"),
    ...big("amountOut"),
    ...big("feeLp"),
    ...big("feeValidator"),
    ...big("feeCommission"),
    ...text("commissionPkh"),
    ...text("payoutPkh"),
  } as PoolEvent;
}

/**
 * A revert (0.41.0): an admitted transaction later rejected — `txid` the rejected transaction, `at`
 * the step's time, and the pool as it stands after the undo (its outpoint, reserves, fields,
 * `swaps`), or none of those when the pool no longer exists.
 */
export interface PoolRevert {
  kind: "revert";
  txid: string;
  poolId: string;
  at: number;
  outpoint?: string;
  bsvReserve?: bigint;
  tokenReserve?: bigint;
  lpPubKey?: string;
  liquidityFeeBps?: bigint;
  validationFeeBps?: bigint;
  commissionBps?: bigint;
  validatorIdentityKey?: string;
  swaps?: number;
}

/** One message of a pool event feed (E1, 0.41.0): `{tokenId, …row}`, the row an H8 event or a revert. */
export type PoolEventMessage = { tokenId: string } & (PoolEvent | PoolRevert);

function toPoolRevert(r: Record<string, unknown>): PoolRevert | null {
  if (r.kind !== "revert" || typeof r.txid !== "string" || typeof r.poolId !== "string") return null;
  const base: PoolRevert = { kind: "revert", txid: r.txid.toLowerCase(), poolId: r.poolId.toLowerCase(), at: int(r.at) };
  if (typeof r.outpoint !== "string") return base;
  return {
    ...base,
    outpoint: r.outpoint,
    bsvReserve: wireBig(r.bsvReserve),
    tokenReserve: wireBig(r.tokenReserve),
    lpPubKey: typeof r.lpPubKey === "string" ? r.lpPubKey.toLowerCase() : "",
    liquidityFeeBps: wireBig(r.liquidityFeeBps),
    validationFeeBps: wireBig(r.validationFeeBps),
    commissionBps: wireBig(r.commissionBps),
    validatorIdentityKey: typeof r.validatorIdentityKey === "string" ? r.validatorIdentityKey.toLowerCase() : "",
    swaps: int(r.swaps),
  };
}

/** A pool event feed message's data, or null when it is not one. */
export function parsePoolEventMessage(x: unknown): PoolEventMessage | null {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.tokenId !== "string") return null;
  const row = r.kind === "revert" ? toPoolRevert(r) : toPoolEvent(r);
  return row ? { tokenId: r.tokenId, ...row } : null;
}

/** H8: `GET <base>/pools/history?from=&to=&pool=&limit=&after=` → the page, oldest first. */
export async function readPoolHistory(base: string, o: { from?: number; to?: number; pool?: string; limit?: number; after?: string } = {}, fetchFn?: FetchFn): Promise<PoolHistoryPage> {
  const a = (await getJson(`${trim(base)}/pools/history${query({ from: o.from, to: o.to, pool: o.pool, limit: o.limit, after: o.after })}`, fetchFn)) as { events?: unknown; next?: unknown } | null;
  return {
    events: (Array.isArray(a?.events) ? a!.events : []).map(toPoolEvent).filter((e): e is PoolEvent => e !== null),
    next: typeof a?.next === "string" ? a.next : null,
  };
}

/** One outpoint's spender as the host's H9 answers it: the token whose instance named it. */
export interface SpendAll {
  /** `<txid>.<vout>` */
  outpoint: string;
  tokenId?: string;
  spentBy?: string;
}

/** H9: `GET <swap base>/spends?outpoint=a,b` (the host's: every enabled token's `/spends`, the first naming a spender) → one record per outpoint. */
export async function readSpendsAll(swapBase: string, outpoints: string[], fetchFn?: FetchFn): Promise<SpendAll[]> {
  if (outpoints.length === 0) return [];
  const a = await getJson(`${trim(swapBase)}/spends?outpoint=${list(outpoints)}`, fetchFn);
  return (Array.isArray(a) ? (a as Record<string, unknown>[]) : [a as Record<string, unknown>])
    .filter((r) => r && typeof r.outpoint === "string")
    .map((r) => ({
      outpoint: String(r.outpoint),
      ...(typeof r.tokenId === "string" ? { tokenId: r.tokenId } : {}),
      ...(typeof r.spentBy === "string" ? { spentBy: r.spentBy.toLowerCase() } : {}),
    }));
}
