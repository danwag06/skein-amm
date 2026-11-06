/**
 * The swap relay and the app's `/call` functions, as the pages reach them.
 *
 * 0.44.0 (David Case 2026-11-06, "the instance logs facts, never attempts"): the HOST is the relay.
 * A leg is one plain POST to the open-exchange host's route
 *
 *   POST <origin>/@<tokenId>/amm/swap      (`swapUrl(base)`; no BRC-104 session, as /submit is plain)
 *   body    {funding, swap, pool, validator, peerId}   JSON, bytes as DAG-JSON bytes
 *   answer  the validator's reply as it is:  {ok: true, tx, txid, beef?}
 *                                            {ok: false, reason, detail?, pool?, beef?}
 *           or the host's own:               {ok: false, reason: "unreachable", detail}   any break in the call
 *                                            {ok: false, reason: "commission_missing", detail}   the one rule it checks
 *
 *   funding    bytes: the funding transaction as the wallet's AtomicBEEF (0.40.1 `fundingBeef`: every
 *              staged input's source with its ancestry)
 *   swap       bytes: the raw swap, the validator's slot `OP_0`
 *   pool       text `<txid>_<vout>`; validator bytes(33)
 *   peerId     text: the validator's libp2p peer ID, from the pools route's row (`validatorPeerId`)
 *
 * The host checks that the swap's commission pays this exchange's key (amm-p2p README "The
 * commission rule") and nothing else, signs the validator's package with the token instance's key,
 * carries it on one libp2p stream (or to a validator on its own node as an inbound frame), submits a
 * `beef` the reply carries to the token instance's overlay and then answers. Nothing is recorded:
 * no swap id to ask about, no status, no expiry. THE PAGE'S CONNECTION IS THE ONLY TIMER: closing
 * it (`LEG_PATIENCE_MS`, src/market/swapFlow.ts) stops the host — a dial in progress cancelled, a
 * request not yet written never written. Once written, the validator answers on that stream; a
 * signed swap lands on the overlay and the swap loop's settle pass finds it.
 *
 * The app's `/call` route (skein docs/APPS.md §4) stays for `amm.swap.terms`, `amm.pool.terms`
 * and `amm.pool.affirm`: `POST <base>/call`, JSON body `{fn, args}`, answer `{fn, result}` (200) or
 * `{fn, error: {code, message}}`; BRC-104 authenticated (the wallet-backed AuthFetch).
 *
 *   amm.swap.terms   (reads)   {} → {commissionPkh: bytes(20) | null, minCommissionBps}
 *
 * Bytes in bodies are DAG-JSON bytes (`{"/": {"bytes": "<base64, unpadded>"}}`); answers are
 * read as DAG-JSON bytes, hex or a byte array.
 */
import { Utils } from "@bsv/sdk";
import type { PoolState } from "@dcasegr/amm-engine";

export const SWAP_TERMS_FN = "amm.swap.terms";

/** The relay's terms: where it takes the commission (hash160 hex), or null when it names none; this market's minimum commission (bps, 0 when unset). */
export interface SwapTerms {
  commissionPkh: string | null;
  minCommissionBps: number;
}

/** What the relay needs of `AuthFetch` (and what the tests fake). */
export interface AuthFetchLike {
  fetch(url: string, config?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Pick<Response, "status" | "text">>;
}

/** A leg as the host's swap route takes it. */
export interface SwapRequest {
  /** The funding transaction as AtomicBEEF (the swap's unproven parent, with its ancestry). */
  funding: number[];
  /** Raw swap transaction, the validator's slot empty. */
  swap: number[];
  /** The pool outpoint the swap spends, `<txid>_<vout>`. */
  pool: string;
  /** The pool's validator identity key (hex; sent as 33 bytes). */
  validator: string;
  /** The validator's libp2p peer ID (text), as the pools route gave it: what the host dials. */
  peerId: string;
}

/** The host's answer to a leg: the validator's reply, or the host's own refusal / break (`unreachable`). */
export type SwapReply =
  | { ok: true; tx: number[]; txid: string }
  | { ok: false; reason: string; pool?: PoolState }
  /** Any break in the call (dial refused, protocol not served, write failed, stream closed without an answer): no answer, the swap may or may not stand. */
  | { ok: false; unreachable: true; reason: string };

/** What the swap route needs of `fetch` (and what the tests fake): a plain fetch that honours `signal`. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Pick<Response, "status" | "text">>;

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "RelayError";
  }
}

export function dagBytes(bytes: number[]): { "/": { bytes: string } } {
  return { "/": { bytes: Utils.toBase64(bytes).replace(/=+$/, "") } };
}

/** DAG-JSON bytes, hex, or a byte array → bytes; null otherwise. */
export function readBytes(x: unknown): number[] | null {
  if (Array.isArray(x) && x.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return x as number[];
  if (typeof x === "string" && /^([0-9a-f]{2})+$/i.test(x)) return Utils.toArray(x, "hex");
  const b = (x as { "/"?: { bytes?: unknown } } | null)?.["/"]?.bytes;
  if (typeof b === "string") {
    const padded = b + "=".repeat((4 - (b.length % 4)) % 4);
    return Utils.toArray(padded, "base64");
  }
  return null;
}

export function callUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/call`;
}

export const SWAP_ROUTE = "/swap";

/** The host's swap route of a token instance's AMM base (`<origin>/@<tokenId>/amm`). */
export function swapUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}${SWAP_ROUTE}`;
}

export function swapBody(s: SwapRequest): Record<string, unknown> {
  return { funding: dagBytes(s.funding), swap: dagBytes(s.swap), pool: s.pool, validator: dagBytes(Utils.toArray(s.validator, "hex")), peerId: s.peerId };
}

/** One `{fn, args}` call on the app's `/call` route. Throws `RelayError` on an error answer. */
export async function callApp(af: AuthFetchLike, base: string, fn: string, args: unknown): Promise<unknown> {
  const res = await af.fetch(callUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  const text = await res.text();
  let answer: { fn?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
  try {
    answer = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (res.status === 200 && answer && "result" in answer) return answer.result;
  const e = answer?.error;
  throw new RelayError(
    typeof e?.code === "string" ? e.code : `HTTP ${res.status}`,
    typeof e?.message === "string" ? e.message : text.slice(0, 200),
    res.status,
  );
}

/**
 * A refusal's pool, as the validator writes it (messages.zig poolValue:
 * `lpFeeBps`, `validatorFeeBps`, `validatorIdentity`) or as the lookup does
 * (the engine's names), into the engine's PoolState. A closed pool, or one
 * missing a field, is undefined: nothing left to re-price.
 */
export function toPoolState(raw: unknown): PoolState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  if (p.closed) return undefined;
  const num = (...ks: string[]) => ks.map((k) => p[k]).find((v) => typeof v === "number" || typeof v === "string");
  const outpoint = p.outpoint;
  const bsv = num("bsvReserve");
  const tokens = num("tokenReserve");
  const lp = num("liquidityFeeBps", "lpFeeBps");
  const val = num("validationFeeBps", "validatorFeeBps");
  const comm = num("commissionBps");
  const rawId = p.validatorIdentityKey ?? p.validatorIdentity;
  const idBytes = typeof rawId === "string" ? null : readBytes(rawId);
  const identity = typeof rawId === "string" ? rawId : idBytes?.length === 33 ? Utils.toHex(idBytes) : undefined;
  if (typeof outpoint !== "string" || bsv === undefined || tokens === undefined || lp === undefined || val === undefined || typeof identity !== "string") {
    return undefined;
  }
  return {
    outpoint,
    bsvReserve: BigInt(bsv as number),
    tokenReserve: BigInt(tokens as number),
    liquidityFeeBps: BigInt(lp as number),
    validationFeeBps: BigInt(val as number),
    commissionBps: BigInt((comm ?? 0) as number),
    validatorIdentityKey: identity,
  };
}

/** The host's answer (200, JSON) to a leg, as a `SwapReply`; throws when it is no reply. */
export function parseSwapReply(x: unknown): SwapReply {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") throw new Error(`relay: not a swap reply: ${JSON.stringify(x)?.slice(0, 200)}`);
  if (r.ok) {
    const tx = readBytes(r.tx);
    if (!tx || typeof r.txid !== "string") throw new Error("relay: accepted without tx / txid");
    return { ok: true, tx, txid: r.txid };
  }
  const reason = (typeof r.reason === "string" ? r.reason : "refused") + (typeof r.detail === "string" && r.detail ? `: ${r.detail}` : "");
  if (r.reason === "unreachable") return { ok: false, unreachable: true, reason };
  const pool = toPoolState(typeof r.pool === "object" ? r.pool : undefined);
  return pool ? { ok: false, reason, pool } : { ok: false, reason };
}

/** `amm.swap.terms`'s answer: `commissionPkh` as DAG-JSON bytes (or hex, or a byte array) of 20 bytes, or null / absent; `minCommissionBps` an integer 0 to 10 000, absent 0 (0.16.0). */
export function parseSwapTerms(x: unknown): SwapTerms {
  const r = x as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error(`relay: not swap terms: ${JSON.stringify(x)?.slice(0, 200)}`);
  const m = r.minCommissionBps ?? 0;
  if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || m > 10_000) throw new Error("relay: minCommissionBps is not an integer, 0 to 10000");
  if (r.commissionPkh === null || r.commissionPkh === undefined) return { commissionPkh: null, minCommissionBps: m };
  const b = readBytes(r.commissionPkh);
  if (!b || b.length !== 20) throw new Error("relay: commissionPkh is not 20 bytes");
  return { commissionPkh: Utils.toHex(b), minCommissionBps: m };
}

export async function swapTerms(af: AuthFetchLike, base: string): Promise<SwapTerms> {
  return parseSwapTerms(await callApp(af, base, SWAP_TERMS_FN, {}));
}

/**
 * One leg to the host's swap route (a plain POST; `signal` closes the request — the page's patience,
 * the host's only timer). Throws `RelayError` on an answer that is not 200 (the host relayed nothing)
 * and the fetch's own error on a network failure or an abort (no answer: the swap may stand).
 */
export async function postSwap(fetchFn: FetchLike, base: string, s: SwapRequest, signal?: AbortSignal): Promise<SwapReply> {
  const res = await fetchFn(swapUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(swapBody(s)),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  let answer: unknown = null;
  try {
    answer = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (res.status === 200 && answer && typeof answer === "object" && "ok" in answer) return parseSwapReply(answer);
  const e = answer as { code?: unknown; description?: unknown } | null;
  throw new RelayError(typeof e?.code === "string" ? e.code : `HTTP ${res.status}`, typeof e?.description === "string" ? e.description : text.slice(0, 200), res.status);
}
