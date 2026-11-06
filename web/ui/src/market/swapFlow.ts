/**
 * A prepared swap through the relay to its end (pure over the wallet and
 * AuthFetch, tested with fakes). 0.34.0 (D15, David Case 2026-11-04): the submit's answer is
 * the settled record — the host holds the `/call` request until the relay thread rests (the
 * validator's answer; a dial failure settles `failed` at once) — so nothing polls:
 *
 *   submit (amm.swap.submit) →
 *     accepted: completeSwap (internalizeAction; 0.29.0: no relinquishOutput)
 *     refused / timeout / an error answer to submit (nothing recorded):
 *       nothing to undo: the leg's `amm-swap` outputs stay there
 *     no answer (a network failure, the host's 503 past its bound, a `pending` record, the
 *       relay's transport `failed`): "no answer yet", left alone — the relay may still carry it
 *       (0.40.0: the swap's loop resolves it from the overlay, sends it once more, or races it;
 *       src/client.ts `executeSwap`).
 *
 * The swap's id is the relay's (amm-p2p relay.zig `idOf`): sha256 of the swap as submitted (the
 * validator's slot empty), hex — known to the page, so a lost answer can be checked again.
 */
import { Hash, Utils, type WalletInterface } from "@bsv/sdk";
import type { PoolState } from "@dcasegr/amm-engine";
import { RelayError, submitSwap, type AuthFetchLike, type SwapRecord } from "./relay.js";
import { completeSwap, type CompletedSwap, type PreparedSwap } from "./swapAction.js";

export type SwapOutcome =
  | { status: "accepted"; id: string; txid: string; completed: CompletedSwap }
  | { status: "refused"; id: string; reason: string; pool?: PoolState }
  | { status: "timeout"; id: string }
  | { status: "failed"; reason: string }
  | { status: "unknown"; id: string; reason: string };

export interface RelayContext {
  wallet: WalletInterface;
  authFetch: AuthFetchLike;
  /** The token instance's AMM base. */
  base: string;
}

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
  let record: SwapRecord;
  try {
    record = await submitSwap(c.authFetch, c.base, {
      funding: p.funding.atomicBeef,
      swap: p.swap.toBinary(),
      pool: p.pool,
      validator: p.validator,
      peerId,
      expires: p.expires,
    });
  } catch (err) {
    // The host's bound passed with the relay still out: no answer yet (the swap stands).
    if (err instanceof RelayError && err.httpStatus === 503) return { status: "unknown", id, reason: NO_ANSWER_YET };
    // The relay answered with an error: it recorded nothing and sent nothing on.
    if (err instanceof RelayError) return { status: "failed", reason: `amm.swap.submit: ${err.message}` };
    return { status: "unknown", id, reason: `${NO_ANSWER_YET}: amm.swap.submit: ${errText(err)}` };
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
    case "timeout":
      return { status: "timeout", id: r.id };
    case "failed":
      return { status: "unknown", id: r.id, reason: `the relay could not reach the validator (${r.reason})` };
  }
}
