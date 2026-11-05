/**
 * Swap one token: you pay / you receive, the quote routed across the token's pools, and the Route
 * panel. 0.34.0 (D11–D16): the page holds the token's pools route as a stream (`useTokenPools`);
 * a quote is computed from it (no request); the fee line is the pool's own; a leg with no answer
 * yet offers "Check again".
 */
import { useMemo, useState } from "react";
import { Id } from "../components/Id";
import { sameToken } from "../lib/tokenId";
import {
  checkSwapAgain,
  executeSwap,
  poolFees,
  poolViews,
  quoteSwap,
  useMyTokens,
  useTokenPools,
  useWalletSats,
  withLeg,
  type HostedToken,
  type Quote,
  type Session,
  type Side,
  type SwapResult,
} from "../data/exchange";
import { compactAmount, compactSats, fmtAmount, fmtBps, fmtPrice, fmtSats, parseInput } from "./format";
import { LiveDot, Notice, TokenMark, TokenName } from "./bits";
import { routeHref } from "./route";

const DEFAULT_SLIPPAGE_BPS = 50;

function impactClass(bps: number): string {
  return bps >= 300 ? "bad" : bps >= 50 ? "warn" : "";
}

function PickToken({ tokens }: { tokens: HostedToken[] | null }) {
  const open = tokens?.filter((t) => t.pools > 0) ?? null;
  return (
    <>
      <h1 className="page-title">Swap</h1>
      <section className="panel">
        <h2 className="h2">Pick a token</h2>
        {open === null ? (
          <p className="muted">Loading the tokens…</p>
        ) : open.length === 0 ? (
          <p className="muted">No token on this exchange has an open pool.</p>
        ) : (
          <ul className="pick">
            {open.map((t) => (
              <li key={t.tokenId}>
                <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} />
                <span className="num">{t.marginalPrice === null ? "—" : `${fmtPrice(t.marginalPrice)} sats`}</span>
                <a className="btn btn-outline" href={routeHref({ page: "swap", tokenId: t.tokenId })} aria-label={`Swap ${t.sym}`}>
                  Swap
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function SwapPage({ session, tokenId, tokens }: { session: Session; tokenId?: string; tokens: HostedToken[] | null }) {
  const token = tokenId ? tokens?.find((t) => sameToken(t.tokenId, tokenId)) : undefined;
  if (!tokenId) return <PickToken tokens={tokens} />;
  if (!token) {
    return (
      <>
        <a className="back" href={routeHref({ page: "landing" })}>
          ← All tokens
        </a>
        <p className="muted">{tokens === null ? "Loading…" : "This exchange does not host that token."}</p>
      </>
    );
  }
  return <SwapForm key={token.tokenId} session={session} token={token} />;
}

function SwapForm({ session, token }: { session: Session; token: HostedToken }) {
  const connected = session.status === "connected";
  const [side, setSide] = useState<Side>("buy");
  const [amountText, setAmountText] = useState("");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [editSlippage, setEditSlippage] = useState(false);
  const [slippageText, setSlippageText] = useState((DEFAULT_SLIPPAGE_BPS / 100).toString());
  const [allowPartial, setAllowPartial] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  const sats = useWalletSats(connected);
  const mine = useMyTokens(connected);
  const pools = useTokenPools(token.tokenId);
  const views = poolViews(pools.data, token.tokenId);
  const mineToken = mine.data?.find((t) => t.tokenId === token.tokenId);
  // A sell spends the swap basket's outputs first, then what the wallet sends into it (0.12.0).
  const inSwaps = mineToken?.inSwaps ?? 0n;
  const held = (mineToken?.balance ?? 0n) + inSwaps;

  const payDec = side === "buy" ? 0 : token.dec;
  const recvDec = side === "buy" ? token.dec : 0;
  const payUnit = side === "buy" ? "sats" : token.sym;
  const recvUnit = side === "buy" ? token.sym : "sats";
  const amountIn = parseInput(amountText, payDec);
  const badAmount = amountText.trim() !== "" && amountIn === null;

  // The quote, computed from the pools the page holds (D12: no request), as the amount, side, options or pools change.
  const { quote, quoteError } = useMemo((): { quote: Quote | null; quoteError: string | null } => {
    if (amountIn === null || amountIn === 0n || pools.data === null) return { quote: null, quoteError: null };
    try {
      return { quote: quoteSwap({ tokenId: token.tokenId, side, amountIn, maxSlippageBps: slippageBps, allowPartial }, pools.data, { sym: token.sym, dec: token.dec }), quoteError: null };
    } catch (e) {
      return { quote: null, quoteError: e instanceof Error ? e.message : String(e) };
    }
  }, [token.tokenId, token.sym, token.dec, side, amountIn, slippageBps, allowPartial, pools.data]);

  function flip() {
    setSide(side === "buy" ? "sell" : "buy");
    setAmountText("");
    setResult(null);
  }

  function saveSlippage() {
    const pct = Number(slippageText);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 50) setSlippageBps(Math.round(pct * 100));
    else setSlippageText((slippageBps / 100).toString());
    setEditSlippage(false);
  }

  async function swap() {
    if (!quote) return;
    setBusy(true);
    setSwapError(null);
    setResult(null);
    try {
      setResult(await executeSwap(quote));
      setAmountText("");
    } catch (e) {
      setSwapError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const balanceLine = connected
    ? side === "buy"
      ? sats.data !== null
        ? `Wallet: ${fmtSats(sats.data)} sats`
        : "Wallet: …"
      : `Wallet: ${fmtAmount(held - inSwaps, token.dec)} ${token.sym}${inSwaps > 0n ? ` (and ${fmtAmount(inSwaps, token.dec)} in the swap basket)` : ""}`
    : "Connect a wallet to swap.";
  const tooMuch = connected && amountIn !== null && (side === "buy" ? sats.data !== null && amountIn > sats.data : amountIn > held);

  return (
    <>
      <a className="back" href={routeHref({ page: "landing" })}>
        ← All tokens
      </a>
      <div className="swap-grid">
        <form
          className="panel swap-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (connected) void swap();
            else session.connect();
          }}
        >
          <h1 className="h1-sm">Swap {token.sym}</h1>
          <div className="leg-box">
            <label htmlFor="pay" className="leg-label">
              You pay
            </label>
            <div className="leg-line">
              <input
                id="pay"
                className="amount-input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={amountText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  setResult(null);
                }}
                aria-invalid={badAmount || tooMuch || undefined}
                aria-describedby="pay-help"
              />
              <span className="unit-tag">
                {side === "sell" && <TokenMark tokenId={token.tokenId} sym={token.sym} size="sm" />}
                {payUnit}
              </span>
            </div>
            <span id="pay-help" className={`help ${badAmount || tooMuch ? "bad" : ""}`}>
              {badAmount ? `Not an amount (at most ${payDec} decimal places).` : tooMuch ? `More than your wallet holds. ${balanceLine}` : balanceLine}
            </span>
          </div>
          <button type="button" className="flip" onClick={flip} aria-label={`Swap direction: pay ${recvUnit} instead`} title="Swap direction">
            ⇅
          </button>
          <div className="leg-box">
            <span className="leg-label" id="recv-label">
              You receive (quote)
            </span>
            <div className="leg-line">
              <output className="amount-out" aria-labelledby="recv-label">
                {quote ? fmtAmount(quote.amountOut, recvDec) : "—"}
              </output>
              <span className="unit-tag">
                {side === "buy" && <TokenMark tokenId={token.tokenId} sym={token.sym} size="sm" />}
                {recvUnit}
              </span>
            </div>
          </div>
          <dl className="kv">
            <dt>Effective price</dt>
            <dd className="num">{quote ? `${fmtPrice(quote.effectivePrice)} sats per ${token.sym}` : "—"}</dd>
            <dt>Marginal price</dt>
            <dd className="num">{quote ? fmtPrice(quote.marginalPrice) : token.marginalPrice === null ? "—" : fmtPrice(token.marginalPrice)}</dd>
            <dt>Price impact</dt>
            <dd className={`num ${quote ? impactClass(quote.impactBps) : ""}`}>{quote ? fmtBps(quote.impactBps) : "—"}</dd>
            <dt>Max slippage</dt>
            <dd className="num">
              {editSlippage ? (
                <span className="inline-edit">
                  <input
                    id="slip"
                    aria-label="Max slippage, percent"
                    className="small-input"
                    inputMode="decimal"
                    value={slippageText}
                    onChange={(e) => setSlippageText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveSlippage();
                      }
                    }}
                    autoFocus
                  />
                  %
                  <button type="button" className="btn-link" onClick={saveSlippage}>
                    Done
                  </button>
                </span>
              ) : (
                <>
                  {(slippageBps / 100).toFixed(1)} %{" "}
                  <button type="button" className="btn-link" onClick={() => setEditSlippage(true)} aria-label="Change max slippage">
                    change
                  </button>
                </>
              )}
            </dd>
            <dt>
              <label htmlFor="partial">Allow partial fill</label>
            </dt>
            <dd>
              <input id="partial" type="checkbox" className="check" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
            </dd>
          </dl>
          {quote && (
            <p className="help">
              You receive at least {fmtAmount(quote.minAmountOut, recvDec)} {recvUnit}, or the swap stops.
            </p>
          )}
          {quoteError && <Notice kind="bad">{quoteError}</Notice>}
          {connected ? (
            <button type="submit" className="btn btn-primary btn-lg" disabled={!quote || busy || tooMuch}>
              {busy ? "Swapping…" : "Swap"}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-lg" disabled={session.status === "connecting"}>
              Connect a wallet to swap
            </button>
          )}
          {swapError && <Notice kind="bad">The swap failed: {swapError}</Notice>}
          {result && (
            <div className={`notice notice-${result.status === "failed" ? "bad" : "ok"}`} role="status">
              <p>
                {result.status === "filled" ? "Swapped. Every leg filled." : result.status === "partial" ? "Partly swapped: some legs failed." : "No leg filled."}
              </p>
              {result.legs.some((l) => l.repriced) && <p>One leg was repriced after another swap moved the pool.</p>}
              <ul className="txids">
                {result.legs.map((l) => (
                  <li key={l.poolOutpoint}>
                    {l.txid ? <Id value={l.txid} kind="txid" label="transaction id" /> : <span>{l.error}</span>}
                    {l.checkId && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="btn-link"
                          disabled={checking === l.poolOutpoint}
                          onClick={() => {
                            setChecking(l.poolOutpoint);
                            checkSwapAgain(l).then(
                              (next) => {
                                setResult((r) => (r ? withLeg(r, next) : r));
                                setChecking(null);
                              },
                              (e: unknown) => {
                                setResult((r) => (r ? withLeg(r, { ...l, error: e instanceof Error ? e.message : String(e) }) : r));
                                setChecking(null);
                              },
                            );
                          }}
                        >
                          {checking === l.poolOutpoint ? "Checking…" : "Check again"}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>

        <section className="panel route" aria-labelledby="route-h">
          <h2 id="route-h" className="h2">
            Route
          </h2>
          {quote ? (
            <>
              <p className="muted small">
                The quote splits your amount across {token.sym}&apos;s pools for the best effective price.
              </p>
              <ol className="legs">
                {quote.legs.map((l) => (
                  <li key={l.poolOutpoint} className="leg">
                    <Id value={l.poolOutpoint} kind="outpoint" label="pool" />
                    <span className="num leg-amt">
                      {fmtAmount(l.amountIn, payDec)} {payUnit} → {fmtAmount(l.amountOut, recvDec)} {recvUnit}
                    </span>
                    <span className="sub">
                      reserves {compactSats(l.reserves.sats)} sats · {compactAmount(l.reserves.tokens, token.dec)} {token.sym} ·{" "}
                      <LiveDot live={l.validator.live} label={l.validator.live ? "validator live" : "validator offline"} />
                    </span>
                    <span className="sub r">{Math.round(l.shareBps / 100)} %</span>
                  </li>
                ))}
              </ol>
              <p className="muted small">
                Each leg is its own transaction.{" "}
                {allowPartial ? "With partial fill allowed, a leg that fails leaves the others standing." : "Without partial fill, a leg that fails stops the swap."}
              </p>
            </>
          ) : (
            <>
              <p className="muted small">Enter an amount to see how the quote splits it across {token.sym}&apos;s pools.</p>
              <ul className="legs">
                {views.map((p) => (
                  <li key={p.outpoint} className="leg">
                    <Id value={p.outpoint} kind="outpoint" label="pool" />
                    <span className="num leg-amt">
                      {compactSats(p.sats)} sats · {compactAmount(p.tokens, token.dec)} {token.sym}
                    </span>
                    <span className="sub">
                      <LiveDot live={p.validator.live} label={p.validator.live ? "validator live" : "validator offline"} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {pools.error && <p className="muted small">{pools.error}</p>}
          {(() => {
            // D13: the fee line from the pool's own record.
            const first = pools.data?.pools[0];
            const fees = quote?.fees ?? (first ? poolFees(first) : undefined);
            if (!fees) return null;
            return (
              <p className="muted small">
                Fees per leg: LP {fees.lpBps} · validator {fees.validatorBps} bps, taken from the amount in.
              </p>
            );
          })()}
        </section>
      </div>
    </>
  );
}
