/**
 * A prepared swap through the host's relay to its end (pure over the wallet and fetch, tested with
 * fakes). 0.44.0 (David Case 2026-11-06): the host is the relay — one plain POST per leg to
 * `<origin>/@<tokenId>/amm/swap`, answered with the validator's reply (src/market/relay.ts); no
 * record, no status, no expiry:
 *
 *   POST /swap →
 *     {ok: true, tx, txid}: completeSwap (internalizeAction; 0.29.0: no relinquishOutput) → accepted
 *     {ok: false, reason, pool?} (the validator's refusal, or the host's commission rule): refused —
 *       nothing to undo: the leg's `amm-swap` outputs stay there
 *     {ok: false, reason: "unreachable"} (any break in the host's call), a network failure, or no
 *       answer within LEG_PATIENCE_MS (the request is closed: the host stops): unknown, "no answer
 *       yet" — the swap may stand (0.40.0: the swap's loop resolves it from the overlay, asks once
 *       more, or races it; src/client.ts `executeSwap`)
 *     an answer that is not 200 (a bad request, an unknown token): failed — the host relayed nothing
 *
 * The page's patience is the only timer: the AbortController's signal closes the request, and with
 * it the host's attempt (a plain fetch honours `signal`; AuthFetch does not, which is why the leg is
 * a plain fetch). The swap's id is sha256 of the swap as sent (the validator's slot empty), hex: the
 * page's own name for a leg.
 */
import { Hash, Utils, type WalletInterface } from "@bsv/sdk";
import type { PoolState } from "@dcasegr/amm-engine";
import { RelayError, postSwap, type FetchLike, type SwapReply } from "./relay.js";
import { completeSwap, type CompletedSwap, type PreparedSwap } from "./swapAction.js";

export type SwapOutcome =
  | { status: "accepted"; id: string; txid: string; completed: CompletedSwap }
  | { status: "refused"; id: string; reason: string; pool?: PoolState }
  | { status: "failed"; reason: string }
  | { status: "unknown"; id: string; reason: string };

/** How long the page waits for one leg's answer before it closes the request (the host then stops), ms. */
export const LEG_PATIENCE_MS = 15_000;

export interface RelayContext {
  wallet: WalletInterface;
  /** A plain fetch (it must honour `signal`). Default: the global fetch. */
  fetch?: FetchLike;
  /** The token instance's AMM base, `<origin>/@<tokenId>/amm`. */
  base: string;
  /** The page's patience for this leg (default LEG_PATIENCE_MS). */
  patienceMs?: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A prepared swap's id: sha256 of the swap's bytes as sent, hex. */
export function swapIdOf(p: PreparedSwap): string {
  return Utils.toHex(Hash.sha256(p.swap.toBinary()) as number[]);
}

/** "no answer yet": what a leg that came back without the validator's reply means. */
export const NO_ANSWER_YET = "no answer yet";

/** `peerId`: the chosen validator's libp2p peer ID, from the pools route's row (the host dials it). */
export async function relaySwap(c: RelayContext, p: PreparedSwap, peerId: string): Promise<SwapOutcome> {
  const id = swapIdOf(p);
  const patience = c.patienceMs ?? LEG_PATIENCE_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`no answer within ${patience} ms`)), patience);
  let reply: SwapReply;
  try {
    reply = await postSwap(c.fetch ?? (globalThis.fetch as unknown as FetchLike), c.base, {
      funding: p.funding.atomicBeef,
      swap: p.swap.toBinary(),
      pool: p.pool,
      validator: p.validator,
      peerId,
    }, ac.signal);
  } catch (err) {
    // An answer that is not 200: the host relayed nothing.
    if (err instanceof RelayError) return { status: "failed", reason: `swap: ${err.message}` };
    // A network failure, or the page's patience ran out (the request closed: the host stopped).
    return { status: "unknown", id, reason: `${NO_ANSWER_YET}: ${ac.signal.aborted ? errText(ac.signal.reason) : errText(err)}` };
  } finally {
    clearTimeout(timer);
  }
  if (reply.ok) return { status: "accepted", id, txid: reply.txid, completed: await completeSwap(c.wallet, p, reply.tx, reply.txid) };
  if ("unreachable" in reply) return { status: "unknown", id, reason: `${NO_ANSWER_YET}: the host could not reach the validator (${reply.reason})` };
  return reply.pool ? { status: "refused", id, reason: reply.reason, pool: reply.pool } : { status: "refused", id, reason: reply.reason };
}
