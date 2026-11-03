/**
 * Your tokens: the wallet's own 1Color tokens with balance (the BRC-207 module's), each marked on
 * this exchange or not; beside the balance, what the swap basket holds of it,
 * with "Move back" (0.12.0: the recovery path for a stuck swap). 0.29.3: an "Unfinished" card, shown
 * only while the browser lists unfinished steps (a swap payout the wallet has not taken in), one
 * "Finish" per step; no automatic retry. 0.29.6: a swap never signed gets "Dismiss" too (drops the
 * entry only); the swap-basket line shows the sats staged for the token, Move back offered for
 * tokens or sats.
 */
import { useState } from "react";
import { COLOR_DEPLOY_HREF, dismissUnfinished, finishUnfinished, moveBackTokens, useMyTokens, useUnfinished, type Session, type Unfinished, type WalletToken } from "../data/exchange";
import { ago, fmtAmount, fmtSats } from "./format";
import { NeedWallet, Notice, TokenName } from "./bits";

function Status({ t }: { t: WalletToken }) {
  if (t.onExchange) return <span className="ok small">On this exchange</span>;
  return <span className="muted small">Not on this exchange</span>;
}

function SwapBasket({ t }: { t: WalletToken }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.inSwaps === 0n && t.swapSats === 0) return null;
  return (
    <span className="status-cell">
      <span className="muted small">
        In the swap basket {fmtAmount(t.inSwaps, t.dec)}
        {t.swapSats > 0 ? ` · ${fmtSats(BigInt(t.swapSats))} sats staged` : ""}{" "}
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            moveBackTokens(t.tokenId).then(
              (r) => {
                if (r.errors.length > 0) setError(r.errors.join("; "));
                setBusy(false);
              },
              (e: unknown) => {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              },
            );
          }}
          aria-label={`Move ${t.sym} back from the swap basket into your wallet`}
        >
          {busy ? "Moving…" : "Move back"}
        </button>
      </span>
      {error && <span className="bad small">{error}</span>}
    </span>
  );
}

const KIND_TEXT: Record<Unfinished["kind"], string> = { swap: "Swap payout", "move-back": "Move back", close: "Close", "remove-liquidity": "Remove liquidity" };

function UnfinishedRow({ u }: { u: Unfinished }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="ttable-row">
      <span>
        {KIND_TEXT[u.kind]} <span className="muted small">{u.tokenId.slice(0, 8)}…</span>
      </span>
      <span className="r muted small">
        <span className="mono">{u.txid.slice(0, 12)}…</span>
        {u.final ? "" : " (not signed yet)"} · {ago(u.createdAt)} ago
      </span>
      <span className="r">
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            finishUnfinished(u.id).then(
              () => setBusy(false),
              (e: unknown) => {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              },
            );
          }}
          aria-label={`Finish: take the ${KIND_TEXT[u.kind].toLowerCase()} into your wallet`}
        >
          {busy ? "Finishing…" : "Finish"}
        </button>
        {u.dismissable && (
          <>
            {" "}
            <button
              type="button"
              className="btn btn-outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                try {
                  dismissUnfinished(u.id);
                } catch (e: unknown) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              aria-label="Dismiss: forget this unsigned swap; nothing was paid to you"
            >
              Dismiss
            </button>
          </>
        )}
        {error && <span className="bad small"> {error}</span>}
      </span>
    </li>
  );
}

function UnfinishedCard() {
  const list = useUnfinished();
  if (list.length === 0) return null;
  return (
    <section className="panel ttable" aria-label="Unfinished">
      <h2 className="h2 h2-sm">Unfinished</h2>
      <p className="fg2 small">Outputs paid to you that your wallet has not taken in yet. Finish takes one in.</p>
      <ul className="ttable-rows">
        {list.map((u) => (
          <UnfinishedRow key={u.id} u={u} />
        ))}
      </ul>
    </section>
  );
}

export function YourTokens({ session }: { session: Session }) {
  const connected = session.status === "connected";
  const mine = useMyTokens(connected);
  return (
    <>
      <div className="title-row">
        <h1 className="page-title">Your tokens</h1>
        <a href={COLOR_DEPLOY_HREF} className="link-strong">
          Deploy a new token
        </a>
      </div>
      <p className="lead lead-tight">
        1Color tokens in your wallet. The swap basket holds tokens on their way into a swap; Move back
        returns them to your wallet.
      </p>
      {!connected ? (
        <NeedWallet session={session} what="your tokens" />
      ) : (
        <>
          <UnfinishedCard />
          {mine.error && <Notice kind="bad">Could not read your tokens: {mine.error}</Notice>}
          <section className="panel ttable" aria-label="Your tokens">
            <div className="ttable-head" aria-hidden="true">
              <span>Token</span>
              <span className="r">Balance</span>
              <span />
            </div>
            {mine.data === null ? (
              <p className="empty">Loading your tokens…</p>
            ) : mine.data.length === 0 ? (
              <p className="empty">Your wallet holds no 1Color tokens.</p>
            ) : (
              <ul className="ttable-rows">
                {mine.data.map((t) => (
                  <li key={t.tokenId} className="ttable-row">
                    <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} />
                    <span className="num r">
                      <span className="lbl">Balance </span>
                      {fmtAmount(t.balance, t.dec)}
                      <SwapBasket t={t} />
                    </span>
                    <span className="r">
                      <Status t={t} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
