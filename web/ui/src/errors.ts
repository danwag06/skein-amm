/**
 * The client's named error kinds (0.38.0, D13): a `ClientError` carries one of `CLIENT_ERROR_KINDS`
 * and the message the pages showed before (unchanged: the pages keep their texts). Thrown by the
 * client's functions where the error is of one of these kinds; a swap leg's result carries the
 * kind beside its text (`LegResult.kind`). Other errors (a missing wallet, a malformed answer…)
 * stay plain `Error`s.
 *
 *   stale_pool      the pool moved since the quote or the read (the builder's `stale_pool`; a leg
 *                   whose lookup tip is not the planned outpoint)
 *   fee_mismatch    the pool's fees are not the ones quoted (the builder's `fee_mismatch`)
 *   quote_mismatch  the pool's math does not give the quoted amounts (the builder's `quote_mismatch`)
 *   slippage        the amount out fell below the order's minimum (the builder's `slippage`; a
 *                   repriced leg below the order's bound)
 *   pool_spent      the pool was spent since the quote (the quote's freshness read; the validator's
 *                   `pool_spent` refusal)
 *   user_rejected   the user declined in the wallet (the wallet's `ERR_PERMISSION_DENIED`, "denied")
 *   no_answer       the relay gave no settled answer yet ("no answer yet"; the page's patience per leg run out)
 *   below_minimum   (0.40.0) under a validator's minimum leg (its `below_minimum` refusal; a quote no
 *                   pool takes for its size)
 *   refused         the validator, the relay or the host refused it (a refusal other than pool_spent
 *                   and below_minimum)
 *   network         the request did not get through (fetch threw)
 */
import { PoolBuildError } from "./pool/index.js";
import { RelayError } from "./market/relay.js";
import type { SwapOutcome } from "./market/swapFlow.js";

/** Every kind a `ClientError` names (D13). */
export const CLIENT_ERROR_KINDS = ["stale_pool", "fee_mismatch", "quote_mismatch", "slippage", "pool_spent", "user_rejected", "no_answer", "below_minimum", "refused", "network"] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** An error of a named kind; `message` is the text the pages show. */
export class ClientError extends Error {
  constructor(
    readonly kind: ClientErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ClientError";
  }
}

const BUILD_KINDS = new Set<string>(["stale_pool", "fee_mismatch", "quote_mismatch", "slippage"]);

/** The kind of `e`, when it is one of `CLIENT_ERROR_KINDS`; undefined otherwise. */
export function errorKind(e: unknown): ClientErrorKind | undefined {
  if (e instanceof ClientError) return e.kind;
  if (e instanceof PoolBuildError) return BUILD_KINDS.has(e.code) ? (e.code as ClientErrorKind) : undefined;
  if (e instanceof RelayError) return e.httpStatus === 503 ? "no_answer" : "refused";
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const code = e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : "";
  if (code === "ERR_PERMISSION_DENIED" || /user has denied|permission denied|user rejected|denied by the user/i.test(msg)) return "user_rejected";
  if (e instanceof TypeError && /fetch|network/i.test(msg)) return "network";
  if (/^the pool moved\b/.test(msg)) return "stale_pool";
  if (/^no answer yet\b/.test(msg)) return "no_answer";
  return undefined;
}

/** `e` as a `ClientError` of its kind (its message unchanged, `e` the cause) when it has one; else `e` itself. */
export function toClientError(e: unknown): unknown {
  if (e instanceof ClientError) return e;
  const kind = errorKind(e);
  return kind ? new ClientError(kind, e instanceof Error ? e.message : String(e), { cause: e }) : e;
}

/** The kind of a relay outcome that did not fill (D13): undefined for an accepted one. */
export function kindOfOutcome(o: SwapOutcome): ClientErrorKind | undefined {
  switch (o.status) {
    case "accepted":
      return undefined;
    case "refused":
      return o.reason.startsWith("pool_spent") ? "pool_spent" : o.reason.startsWith("below_minimum") ? "below_minimum" : "refused";
    case "unknown":
      return "no_answer";
    case "failed":
      return "refused";
  }
}
