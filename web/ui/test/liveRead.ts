/**
 * The validators a plan may use (0.34.0): the pools route's rows name them (the host listed only
 * pools whose validator is beating, with its peer ID); `liveFor` makes that answer for test keys.
 */
import type { LiveAnswer } from "../src/lib/overlay";

/** A validator's peer ID (recorded from the v2 instance). */
export const PEER = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";

/** The liveness the plan reads for `keys`, each seen 5 s before `now` from the peer `peerId`. */
export function liveFor(keys: string[], now = 1_000_000, peerId: string = PEER): LiveAnswer {
  return { now, kept: true, validators: keys.map((k) => ({ identityKey: k.toLowerCase(), peerId, at: now - 5_000, ageMs: 5_000, live: true })) };
}
