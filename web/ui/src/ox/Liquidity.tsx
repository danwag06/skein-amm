/**
 * Liquidity: your positions, and deploying a new one. A position is only
 * deployed or closed: no add, no partial remove (resize = close, then deploy).
 * Closing is one wallet action (0.29.1): the wallet pays the miner fee; nothing to enter. Deploying takes
 * the validator's fees as they are (read-only).
 */
import { useEffect, useState } from "react";
import { Id } from "../components/Id";
import {
  closePosition,
  collectFees,
  deployPosition,
  useMyPositions,
  useMyTokens,
  hasTerms,
  NO_TERMS_TEXT,
  useValidatorTerms,
  type HostedToken,
  type Position,
  type Session,
} from "../data/exchange";
import { fmtAmount, fmtPrice, fmtSats, parseInput } from "./format";
import { followAmount, type DeploySource } from "./deployFill";
import { feesByToken } from "../lp/positions";
import { LiveDot, NeedWallet, Notice, TokenMark } from "./bits";
import { routeHref } from "./route";

function PositionCard({ p, onClosed }: { p: Position; onClosed: (msg: string, txid: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pair = `${p.sym} / BSV`;

  async function close() {
    setBusy(true);
    setError(null);
    try {
      const r = await closePosition({ poolId: p.poolId });
      onClosed(`Closed ${pair}: ${fmtSats(r.sats)} sats and ${fmtAmount(r.tokens, p.dec)} ${p.sym} returned to your wallet.`, r.txid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (confirm) {
    return (
      <article className="panel pos pos-confirm" aria-label={`Close ${pair}`}>
        <h2 className="h2 h2-sm">Close {pair}?</h2>
        <p className="fg2 small">
          Everything in the pool returns to your wallet: {fmtSats(p.sats)} sats and {fmtAmount(p.tokens, p.dec)} {p.sym}. Your wallet pays the miner fee.
        </p>
        {error && <Notice kind="bad">{error}</Notice>}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => void close()} disabled={busy}>
            {busy ? "Closing…" : "Close"}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => setConfirm(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="panel pos" aria-label={pair}>
      <div className="token-name">
        <TokenMark tokenId={p.tokenId} sym={p.sym} {...(p.icon ? { icon: p.icon } : {})} />
        <span className="token-name-text">
          <span className="sym">{pair}</span>
          <Id value={p.outpoint} kind="outpoint" label={`${pair} pool`} />
        </span>
      </div>
      <dl className="kv">
        <dt>In the pool</dt>
        <dd className="num">
          {fmtSats(p.sats)} sats · {fmtAmount(p.tokens, p.dec)} {p.sym}
        </dd>
        {p.feesEarnedSats !== undefined && (
          <>
            <dt>Fees earned</dt>
            <dd className="num">
              {fmtSats(p.feesEarnedSats)} sats · {fmtAmount(p.feesEarnedTokens ?? 0n, p.dec)} {p.sym}
            </dd>
          </>
        )}
        <dt>Validator</dt>
        <dd className="dd-id">
          <LiveDot live={p.validator.live} label="" />
          <span className="sr-only">{p.validator.live ? "live" : "offline"}</span>
          <Id value={p.validator.identityKey} kind="key" label="validator key" />
        </dd>
        {p.rescinded && (
          <>
            <dt>Status</dt>
            <dd className="fg2 pos-status">Rescinded by its validator: no swaps. Close it to take everything back.</dd>
          </>
        )}
      </dl>
      <button type="button" className="btn btn-outline self-start" onClick={() => setConfirm(true)}>
        Close position
      </button>
    </article>
  );
}

function DeployForm({ hosted }: { hosted: HostedToken[] | null }) {
  const mine = useMyTokens(true);
  const usable = mine.data?.filter((t) => t.onExchange && t.balance > 0n) ?? null;
  const [pick, setPick] = useState<string>("");
  const [tokensText, setTokensText] = useState("");
  const [satsText, setSatsText] = useState("");
  const [source, setSource] = useState<DeploySource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ outpoint: string; warnings?: string[] } | null>(null);

  const token = usable?.find((t) => t.tokenId === pick) ?? usable?.[0];
  // 0.17.0: the terms are the token's own instance's.
  const terms = useValidatorTerms(token?.tokenId);
  const dec = token?.dec ?? 0;
  const tokens = parseInput(tokensText, dec);
  const sats = parseInput(satsText, 0);
  const market = hosted?.find((h) => h.tokenId === token?.tokenId)?.marginalPrice ?? null;
  const opening = tokens && sats && tokens > 0n ? Number(sats) / (Number(tokens) / 10 ** dec) : null;
  const tokensBad = tokensText.trim() !== "" && (tokens === null || (token !== undefined && tokens > token.balance));
  const satsBad = satsText.trim() !== "" && sats === null;
  const off = opening !== null && market !== null ? (opening - market) / market : null;

  // 0.28.1: at a market price, the field typed last is the source and the other follows.
  function typed(field: DeploySource, text: string) {
    setSource(field);
    if (field === "tokens") setTokensText(text);
    else setSatsText(text);
    const other = followAmount(field, text, market, dec);
    if (other === null) return;
    if (field === "tokens") setSatsText(other);
    else setTokensText(other);
  }
  // A changed token (or its market price arriving) re-derives from the source field.
  const tokenId = token?.tokenId;
  useEffect(() => {
    if (source === null) return;
    const other = followAmount(source, source === "tokens" ? tokensText : satsText, market, dec);
    if (other === null) return;
    if (source === "tokens") setSatsText(other);
    else setTokensText(other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId, market, dec]);

  async function deploy() {
    if (!token || !tokens || !sats) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await deployPosition({ tokenId: token.tokenId, tokens, sats });
      setDone({ outpoint: r.outpoint, ...(r.warnings ? { warnings: r.warnings } : {}) });
      setTokensText("");
      setSatsText("");
      setSource(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (usable !== null && usable.length === 0) {
    return (
      <section className="panel">
        <p className="fg2">
          Your wallet holds no token that is on this exchange. <a href={routeHref({ page: "tokens" })}>Your tokens</a> lists the ones you hold.
        </p>
      </section>
    );
  }

  return (
    <form
      className="panel deploy"
      onSubmit={(e) => {
        e.preventDefault();
        void deploy();
      }}
    >
      <div className="field narrow">
        <label htmlFor="dep-token">Token</label>
        <select id="dep-token" className="mono" value={token?.tokenId ?? ""} onChange={(e) => setPick(e.target.value)} disabled={!usable}>
          {(usable ?? []).map((t) => (
            <option key={t.tokenId} value={t.tokenId}>
              {t.sym} · {fmtAmount(t.balance, t.dec)} in {t.outputs} output{t.outputs === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        {token && (
          <span className="help">
            <Id value={token.tokenId} kind="token" label={`${token.sym} token id`} />
          </span>
        )}
      </div>
      <div className="two">
        <div className="field">
          <label htmlFor="dep-tokens">Tokens</label>
          <div className="affix">
            <input id="dep-tokens" inputMode="decimal" value={tokensText} onChange={(e) => typed("tokens", e.target.value)} aria-invalid={tokensBad || undefined} aria-describedby="dep-tokens-help" />
            {token && (
              <span className="affix-unit" aria-hidden="true">
                {token.sym}
              </span>
            )}
          </div>
          <span id="dep-tokens-help" className={`help ${tokensBad ? "bad" : ""}`}>
            {token ? `Wallet: ${fmtAmount(token.balance, token.dec)} ${token.sym}` : " "}
          </span>
        </div>
        <div className="field">
          <label htmlFor="dep-sats">Sats</label>
          <input id="dep-sats" inputMode="numeric" value={satsText} onChange={(e) => typed("sats", e.target.value)} aria-invalid={satsBad || undefined} />
        </div>
      </div>
      <p className="fg2 small price-line">
        Opening price <span className="num">{opening === null ? "—" : `${fmtPrice(opening)} sats per ${token?.sym ?? "token"}`}</span>
        {" · market price now "}
        <span className="num">{market === null ? "no pools yet" : `${fmtPrice(market)} sats per ${token?.sym ?? "token"}`}</span>
        {off !== null && Math.abs(off) >= 0.01 && (
          <span className="warn"> · {Math.abs(off * 100).toFixed(1)}% {off > 0 ? "above" : "below"} the market</span>
        )}
      </p>
      <div className="terms">
        {terms.data && !hasTerms(terms.data) ? (
          <span className="muted">{NO_TERMS_TEXT}</span>
        ) : hasTerms(terms.data) ? (
          <>
            <span>
              <strong>Validator:</strong> {terms.data.isThisExchange ? "this exchange's" : "another skein's"},{" "}
              <Id value={terms.data.validator.identityKey} kind="key" label="validator key" />
            </span>
            <span className="muted">
              Fees are the validator&apos;s: LP {terms.data.fees.lpBps} · validator {terms.data.fees.validatorBps}
              {terms.data.fees.commissionBps > 0 ? ` · commission ${terms.data.fees.commissionBps}` : ""} bps. The validator affirms the pool;
              your wallet builds and broadcasts it.
            </span>
          </>
        ) : (
          <span className="muted loading">Reading the validator…</span>
        )}
      </div>
      {error && <Notice kind="bad">The deploy failed: {error}</Notice>}
      {done && (
        <Notice kind="ok">
          Deployed. The new pool is <Id value={done.outpoint} kind="outpoint" label="pool" />.
        </Notice>
      )}
      {done?.warnings && <Notice kind="bad">The deploy is broadcast, but: {done.warnings.join("; ")}</Notice>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !token || !tokens || !sats || tokensBad || satsBad || !hasTerms(terms.data)}>
          {busy ? "Deploying…" : "Deploy"}
        </button>
        <span className="muted small">Your wallet funds it.</span>
      </div>
    </form>
  );
}

export function Liquidity({ session, hosted }: { session: Session; hosted: HostedToken[] | null }) {
  const connected = session.status === "connected";
  const positions = useMyPositions(connected);
  const [closed, setClosed] = useState<{ msg: string; txid: string } | null>(null);
  const [collected, setCollected] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [collecting, setCollecting] = useState(false);
  async function collect() {
    setCollecting(true);
    setCollected(null);
    try {
      const r = await collectFees();
      const text = !r.txid
        ? "No fees to collect."
        : r.sats > 0n && r.tokens.length > 0
          ? `Collected ${fmtSats(r.sats)} sats and your token fees.`
          : r.sats > 0n
            ? `Collected ${fmtSats(r.sats)} sats.`
            : "Collected your token fees.";
      setCollected({ kind: "ok", text });
    } catch (e) {
      setCollected({ kind: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setCollecting(false);
    }
  }
  // 0.32.0: the cards are the live positions; the per-token fees line counts the closed ones too.
  const live = positions.data?.filter((p) => !p.closed) ?? null;
  const byToken = positions.data ? feesByToken(positions.data) : [];
  if (!connected) {
    return (
      <>
        <h1 className="page-title">Your positions</h1>
        <NeedWallet session={session} what="your positions" />
      </>
    );
  }
  return (
    <>
      <section className="stack">
        <div className="title-row">
          <h1 className="page-title">Your positions</h1>
          <span className="muted small">To resize a position, close it and deploy a new one.</span>
        </div>
        {closed && (
          <Notice kind="ok">
            {closed.msg} <Id value={closed.txid} kind="txid" label="transaction id" />
          </Notice>
        )}
        {positions.error && <Notice kind="bad">Could not read your positions: {positions.error}</Notice>}
        {byToken.length > 0 && (
          <div className="fees-summary" aria-label="Fees earned per token">
            {byToken.map((t) => (
              <p key={t.tokenId} className="fg2 small num">
                {t.sym}: {t.positions} position{t.positions === 1 ? "" : "s"} · fees earned {fmtSats(t.sats)} sats · {fmtAmount(t.tokens, t.dec)} {t.sym}
              </p>
            ))}
          </div>
        )}
        <div className="row">
          <button type="button" className="btn btn-outline" onClick={() => void collect()} disabled={collecting}>
            Collect fees
          </button>
        </div>
        {collected && <Notice kind={collected.kind}>{collected.text}</Notice>}
        {live === null ? (
          <p className="muted loading">Loading your positions…</p>
        ) : live.length === 0 ? (
          <p className="muted empty-card">You have no positions on this exchange.</p>
        ) : (
          <div className="cards">
            {live.map((p) => (
              <PositionCard key={p.outpoint} p={p} onClosed={(msg, txid) => setClosed({ msg, txid })} />
            ))}
          </div>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Deploy a position</h2>
        <DeployForm hosted={hosted} />
      </section>
    </>
  );
}
