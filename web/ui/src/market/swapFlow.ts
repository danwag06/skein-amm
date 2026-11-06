/**
 * A prepared swap through the relay to its end (pure over the wallet and
 * AuthFetch, tested with fakes). 0.34.0 (D15, David Case 2026-11-04): the submit's answer is
 * the settled record — the host holds the `/call` request until the relay thread rests (the
 * validator's answer; 0.44.0: the host's error for the relay's `call` — dial refused, stream
 * closed without a frame — settles `failed` at once) — so nothing polls. 0.44.0: the page keeps its
 * own patience per leg (`LEG_PATIENCE_MS`): past it, it stops waiting and the leg is "no answer
 * yet", the same path as any other:
 *
 *   submit (amm.swap.submit) →
 *     accepted: completeSwap (internalizeAction; 0.29.0: no relinquishOutput)
 *     refused / an error answer to submit (nothing recorded):
 *       nothing to undo: the leg's `amm-swap` outputs stay there
 *     no answer (a network failure, the host's 503 past its bound, a `pending` record, the
 *       relay's transport `failed`, the page's patience run out): "no answer yet", left alone — the relay may still carry it
 *       (0.40.0: the swap's loop resolves it from the overlay, sends it once more, or races it;
 *       src/client.ts `executeSwap`).
 *
 * The swap's id is the relay's (amm-p2p relay.zig `idOf`): sha256 of the swap as submitted (the
 * validator's slot empty), hex — known to the page, so a lost answer can be checked again.
 */
import { Hash, Utils, type WalletInterface } from "@bsv/sdk";
import type { PoolState } from "@dcasegr/amm-engine";
import { RelayAborted, RelayError, submitSwap, type AuthFetchLike, type SwapRecord } from "./relay.js";
import { completeSwap, type CompletedSwap, type PreparedSwap } from "./swapAction.js";

export type SwapOutcome =
  | { status: "accepted"; id: string; txid: string; completed: CompletedSwap }
  | { status: "refused"; id: string; reason: string; pool?: PoolState }
  | { status: "failed"; reason: string }
  | { status: "unknown"; id: string; reason: string };

export interface RelayContext {
  wallet: WalletInterface;
  authFetch: AuthFetchLike;
  /** The token instance's AMM base. */
  base: string;
  /** How long to wait on the relay's answer before taking the no-answer path, ms (default `LEG_PATIENCE_MS`). */
  patienceMs?: number;
}

/**
 * The page's own patience per leg (0.44.0, David Case 2026-11-06, D3): the relay keeps no deadline
 * and its host waits on the validator's open stream as long as it lives; a stream that stays open
 * and silent is the page's to give up on. Past this, the leg is "no answer yet": the swap's loop
 * reads the overlay, asks the same validator once more, or races another pool (src/client.ts).
 */
export const LEG_PATIENCE_MS = 15_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The relay's id of a prepared swap: sha256 of the swap's bytes as submitted, hex. */
export function swapIdOf(p: PreparedSwap): string {
  return Utils.toHex(Hash.sha256(p.swap.toBinary()) as number[]);
}

/** "no answer yet": what a held request that came back without the settled record means. */
export const NO_ANSWER_YET = "no answer yet";

/** `peerId`: the chosen validator's libp2p peer ID, from the pools route's row (the relay dials it). */
export async function relaySwap(c: RelayContext, p: PreparedSwap, peerId: string): Promise<SwapOutcome> {
  const id = swapIdOf(p);
  const patience = c.patienceMs ?? LEG_PATIENCE_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), patience);
  let record: SwapRecord;
  try {
    record = await submitSwap(
      c.authFetch,
      c.base,
      {
        funding: p.funding.atomicBeef,
        swap: p.swap.toBinary(),
        pool: p.pool,
        validator: p.validator,
        peerId,
      },
      ctl.signal,
    );
  } catch (err) {
    // The page's patience ran out: no answer yet (a late answer is not read; the overlay is).
    if (err instanceof RelayAborted) return { status: "unknown", id, reason: `${NO_ANSWER_YET}: no answer within ${patience / 1000} s` };
    // The host's bound passed with the relay still out: no answer yet (the swap stands).
    if (err instanceof RelayError && err.httpStatus === 503) return { status: "unknown", id, reason: NO_ANSWER_YET };
    // The relay answered with an error: it recorded nothing and sent nothing on.
    if (err instanceof RelayError) return { status: "failed", reason: `amm.swap.submit: ${err.message}` };
    return { status: "unknown", id, reason: `${NO_ANSWER_YET}: amm.swap.submit: ${errText(err)}` };
  } finally {
    clearTimeout(timer);
  }
  return act(c, p, record);
}

/** A record's outcome, acted on (accepted: the wallet takes the payout in). */
async function act(c: RelayContext, p: PreparedSwap, r: SwapRecord): Promise<SwapOutcome> {
  switch (r.status) {
    case "pending":
      return { status: "unknown", id: r.id, reason: NO_ANSWER_YET };
    case "accepted":
      return { status: "accepted", id: r.id, txid: r.txid, completed: await completeSwap(c.wallet, p, r.tx, r.txid) };
    case "refused":
      return r.pool ? { status: "refused", id: r.id, reason: r.reason, pool: r.pool } : { status: "refused", id: r.id, reason: r.reason };
    case "failed":
      return { status: "unknown", id: r.id, reason: `the relay could not reach the validator (${r.reason})` };
  }
}
