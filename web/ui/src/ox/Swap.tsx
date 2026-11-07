/**
 * Swap one token: you pay / you receive, the quote routed across the token's pools, and the Route
 * panel. 0.34.0 (D11–D16): the page reads the token's pools route (`useTokenPools`; 0.41.0: a plain
 * read, again on each pool event for the token); a quote is computed from it (no request). 0.40.0 (agent-env plans/swap-balance-build-2026-11-05.md
 * Builder 2 item 6): the quote shows what Swap stages (the swap amount, the fee sats with two legs
 * of leeway) and the miner fee per leg; price and impact from the engine's `priceOf`; each leg's
 * fee line from its own pool; while a swap runs, its legs as they fill and Cancel; at the end the
 * summary, what went back to the wallet and why it stopped.
 */
import { useMemo, useRef, useState } from "react";
import { Id } from "../components/Id";
import { sameToken } from "../lib/tokenId";
import {
  executeSwap,
  poolFees,
  poolViews,
  quoteSwap,
  useMyTokens,
  useTokenPools,
  useWalletSats,
  type Fees,
  type HostedToken,
  type LegResult,
  type Quote,
  type Session,
  type Side,
  type SwapResult,
  type SwapStop,
} from "../data/exchange";
import { compactAmount, compactSats, fmtAmount, fmtBps, fmtPrice, fmtSats, parseInput } from "./format";
import { LiveDot, Notice, TokenMark, TokenName } from "./bits";
import { routeHref } from "./route";

const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * The most pools a swap may draw on with "Allow partial fill" checked (0.40.2, David Case: "5 is
 * fine"): this page's choice, not the client's; unchecked is 1, one leg. The fee sats staged
 * cover exactly that many legs.
 */
export const MAX_SOURCES_PARTIAL = 5;

function impactClass(bps: number): string {
  return bps >= 300 ? "bad" : bps >= 50 ? "warn" : "";
}

/** Why a swap stopped, in plain words (0.40.0). */
export function stopText(stop: SwapStop): string {
  switch (stop) {
    case "filled":
      return "Every unit filled.";
    case "cancelled":
      return "Stopped: you cancelled the swap.";
    case "floor":
      return "Stopped: the pools now pay less than your minimum.";
    case "min":
      return "Stopped: what is left is under every pool's minimum leg.";
    case "no_pool":
      return "Stopped: no pool could take the rest.";
    case "fees":
      return "Stopped: the sats set aside for fees ran out.";
  }
}

/** A leg's fee line, from its own pool (0.40.0). */
export function feeText(f: Fees): string {
  return `LP ${f.lpBps} · validator ${f.validatorBps} · commission ${f.commissionBps} bps`;
}

function PickToken({ tokens }: { tokens: HostedToken[] | null }) {
  const open = tokens?.filter((t) => t.pools > 0) ?? null;
  return (
    <>
      <h1 className="page-title">Swap</h1>
      <section className="panel">
        <h2 className="h2">Pick a token</h2>
        {open === null ? (
          <p className="muted loading">Loading the tokens…</p>
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
  const [filling, setFilling] = useState<LegResult[]>([]);
  const [result, setResult] = useState<SwapResult | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const cancel = useRef<AbortController | null>(null);

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
      return { quote: quoteSwap({ tokenId: token.tokenId, side, amountIn, maxSlippageBps: slippageBps, maxSources: allowPartial ? MAX_SOURCES_PARTIAL : 1 }, pools.data, { sym: token.sym, dec: token.dec }), quoteError: null };
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
    setFilling([]);
    const ctl = new AbortController();
    cancel.current = ctl;
    try {
      setResult(
        await executeSwap(quote, {
          signal: ctl.signal,
          onProgress: (x) => {
            if ("filled" in x) setFilling(x.filled);
          },
        }),
      );
      setAmountText("");
    } catch (e) {
      setSwapError(e instanceof Error ? e.message : String(e));
    } finally {
      cancel.current = null;
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
            <dt>Price</dt>
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
          {quote && (
            <p className="help">
              Swap first sets aside {side === "buy" ? `${fmtSats(quote.stage.amount + quote.stage.feeSats)} sats` : `${fmtAmount(quote.stage.amount, token.dec)} ${token.sym} and ${fmtSats(quote.stage.feeSats)} sats`} in the swap basket
              {side === "buy" ? ` (${fmtSats(quote.stage.amount)} to swap, ${fmtSats(quote.stage.feeSats)} for fees)` : " (the sats for fees)"}, enough for{" "}
              {quote.request.maxSources === 1 ? "one leg" : `up to ${quote.request.maxSources} legs`}. Miner fee per leg: about {fmtSats(quote.legMinerFeeSats)} sats. What is left goes back to your wallet.
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
          {busy && (
            <div className="notice" role="status">
              <p>{filling.length === 0 ? "Swapping: the first leg is on its way." : `Swapping: ${filling.length} ${filling.length === 1 ? "leg" : "legs"} filled so far.`}</p>
              <LegList legs={filling} payDec={payDec} recvDec={recvDec} payUnit={payUnit} recvUnit={recvUnit} />
              <button type="button" className="btn btn-outline" onClick={() => cancel.current?.abort()} aria-label="Cancel the swap">
                Cancel
              </button>
            </div>
          )}
          {swapError && <Notice kind="bad">The swap failed: {swapError}</Notice>}
          {result && (
            <div className={`notice notice-${result.status === "failed" ? "bad" : "ok"}`} role="status">
              <p>
                {result.status === "failed" ? "Nothing swapped." : `Swapped ${fmtAmount(result.totalIn, payDec)} ${payUnit} for ${fmtAmount(result.totalOut, recvDec)} ${recvUnit}.`} {stopText(result.stop)}
              </p>
              {result.unfilled > 0n && result.status !== "failed" && (
                <p>
                  Not swapped: {fmtAmount(result.unfilled, payDec)} {payUnit}.
                </p>
              )}
              <LegList legs={result.legs} payDec={payDec} recvDec={recvDec} payUnit={payUnit} recvUnit={recvUnit} />
              {result.stuck && result.stuck.length > 0 && (
                <div>
                  <p>A row in the swap basket was spent, and the wallet could not take that transaction in:</p>
                  <ul>
                    {result.stuck.map((r) => (
                      <li key={r.outpoint}>
                        <Id value={r.outpoint} kind="outpoint" label="swap basket row" /> spent by <Id value={r.spentBy} kind="txid" label="transaction id" />: {r.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.returned &&
                ("txid" in result.returned ? (
                  <p>
                    Back to your wallet: {result.returned.tokens > 0n ? `${fmtAmount(result.returned.tokens, token.dec)} ${token.sym} and ` : ""}the sats left in the swap basket{" "}
                    <Id value={result.returned.txid} kind="txid" label="transaction id" />
                  </p>
                ) : (
                  <p>What is left stays in the swap basket ({result.returned.error}). Move back on Your tokens returns it.</p>
                ))}
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
                    <span className="sub">{feeText(l.fees)}</span>
                  </li>
                ))}
              </ol>
              <p className="muted small">
                Each leg is its own transaction, sent one at a time; a leg a pool refuses goes to another pool. Fees are taken from the amount in.
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
                    {pools.data?.pools.find((x) => x.poolId === p.poolId) && <span className="sub">{feeText(poolFees(pools.data.pools.find((x) => x.poolId === p.poolId)!))}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {pools.error && <p className="muted small">{pools.error}</p>}
        </section>
      </div>
    </>
  );
}

/** The legs of a swap as they fill (0.40.0): each its amounts and its transaction. */
function LegList({ legs, payDec, recvDec, payUnit, recvUnit }: { legs: LegResult[]; payDec: number; recvDec: number; payUnit: string; recvUnit: string }) {
  if (legs.length === 0) return null;
  return (
    <ul className="txids">
      {legs.map((l) => (
        <li key={l.txid}>
          {fmtAmount(l.amountIn, payDec)} {payUnit} → {fmtAmount(l.amountOut, recvDec)} {recvUnit} <Id value={l.txid} kind="txid" label="transaction id" />
        </li>
      ))}
    </ul>
  );
}
