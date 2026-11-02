/**
 * Settings, the exchange's admin (or root on swap) only (Open Exchange, shruggr/open-exchange#1)
 * (0.28.0: swap is born owned by the host's key; while nobody has claimed it, the card Claim this
 * exchange — above the admin cards for root, alone for anyone else; the claimant becomes the admin):
 * Enable a token — one list of the tokens on discovery and in the connected
 * wallet not on this exchange's list yet, one Enable per token; the deploy's
 * BEEF from the wallet's module basket, else from discovery (2026-10-31: no
 * typed id, no paste): root's `enable` to `<app>/admin`, recorded as a fact (the host makes the token's
 * own instance at `/@<tokenId>`); the list, each enabled or disabled, with
 * Disable, and Enable again for a disabled one; and the defaults a new token
 * instance is given — its initial validator terms and market minimum (root's
 * `defaults`). A token's own terms are root's message to `/@<tokenId>` (not on
 * this page). Topic and lookup names are derived from the token id.
 * Discovery: one switch, root's `discovery {on}` — the 1Color discovery topic
 * `tm_color` served by an instance of its own, started or stopped by the host.
 */
import { useState } from "react";
import { shortTokenId } from "../lib/tokenId";
import {
  claimExchange,
  clearDefaultMarket,
  clearDefaultTerms,
  disableToken,
  enableToken,
  setDefaultMarket,
  setDefaultTerms,
  setDiscovery,
  useClaimStatus,
  useDefaults,
  useDiscovery,
  useRegisteredTokens,
  useTokensToEnable,
  type Data,
  type Defaults,
  type Discovery,
  type EnableCandidate,
  type EnableSent,
  type RegisteredToken,
  type Session,
} from "../data/exchange";
import { NeedWallet, Notice, TokenName } from "./bits";

/** The claim card's sentence (0.26.0). */
export const CLAIM_TEXT = "Nobody has claimed this exchange yet. The wallet that claims it becomes its admin: it enables tokens and sets terms.";
/** The line a connected wallet that is not the admin sees. */
export const NOT_ADMIN_TEXT = "The connected wallet is not this exchange's admin. Settings are the admin's.";

/** "Claim this exchange" (0.26.0; 0.28.0: while swap's /admin names nobody): one button. */
export function ClaimCard({ busy, error, onClaim }: { busy: boolean; error: string | null; onClaim: () => void }) {
  return (
    <section className="panel stack-sm" aria-labelledby="claim-h">
      <h2 id="claim-h" className="h2">
        Claim this exchange
      </h2>
      <p className="fg2">{CLAIM_TEXT}</p>
      <div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onClaim} aria-label="Claim">
          {busy ? "Claiming…" : "Claim"}
        </button>
      </div>
      {error && <Notice kind="bad">{error}</Notice>}
    </section>
  );
}

function ClaimSection() {
  const [error, busy, run] = useAct();
  return <ClaimCard busy={busy} error={error} onClaim={() => run(async () => void (await claimExchange()))} />;
}

function useAct(): [string | null, boolean, (f: () => Promise<void>) => void] {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    f()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return [error, busy, run];
}

/** Where a candidate's deploy can come from, in a few words. */
export function sourceText(c: EnableCandidate): string {
  return c.onDiscovery && c.inWallet ? "on discovery · in this wallet" : c.onDiscovery ? "on discovery" : "in this wallet";
}

/** The muted line shown while discovery is off. */
export const DISCOVERY_OFF_TEXT = "Discovery is off: only the tokens this wallet holds are listed.";
/** The empty list's line. */
export const NOTHING_TO_ENABLE_TEXT = "Nothing to enable: every token on discovery and in this wallet is already enabled.";

/** What the confirmation says once an enable is sent. */
export function enableSentText(tokenId: string, r: EnableSent): string {
  return `Enabling ${shortTokenId(tokenId)} is sent (its deploy from ${r.beefFrom === "wallet" ? "this wallet" : "discovery"}). The list shows it once this skein has taken it; its instance is at /@${tokenId}.`;
}

/**
 * The candidate rows (no state of its own): each token's name, id, source and ONE Enable button.
 * `run` runs the action (the card's busy/error handling); `onSent` gets what was sent.
 */
export function EnableList({
  rows,
  discoveryOff,
  busy,
  run,
  onSent,
}: {
  rows: EnableCandidate[];
  discoveryOff: boolean;
  busy: string | null;
  run: (tokenId: string, f: () => Promise<void>) => void;
  onSent: (tokenId: string, r: EnableSent) => void;
}) {
  return (
    <>
      {discoveryOff && <p className="muted">{DISCOVERY_OFF_TEXT}</p>}
      {rows.length === 0 ? (
        discoveryOff ? null : <p className="muted">{NOTHING_TO_ENABLE_TEXT}</p>
      ) : (
        <ul className="regs">
          {rows.map((c) => {
            const sym = c.sym ?? shortTokenId(c.tokenId);
            return (
              <li key={c.tokenId} className="reg-row">
                <span className="req-text">
                  <TokenName tokenId={c.tokenId} sym={sym} {...(c.icon ? { icon: c.icon } : {})} size="sm" />
                  <span className="small muted">{sourceText(c)}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => run(c.tokenId, async () => onSent(c.tokenId, await enableToken(c.tokenId)))}
                  aria-label={`Enable ${sym}`}
                >
                  {busy === c.tokenId ? "Enabling…" : "Enable"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function EnableCard({ discovery }: { discovery: Data<Discovery> }) {
  const list = useTokensToEnable(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = (tokenId: string, f: () => Promise<void>) => {
    setBusy(tokenId);
    setError(null);
    setDone(null);
    f()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <section className="panel stack-sm" aria-labelledby="en-h">
      <h2 id="en-h" className="h2">
        Enable a token
      </h2>
      {list.data === null ? (
        <p className="muted">{list.error ? `Could not read the tokens to enable: ${list.error}` : "Loading…"}</p>
      ) : (
        <EnableList rows={list.data} discoveryOff={discovery.data?.on === false} busy={busy} run={run} onSent={(id, r) => setDone(enableSentText(id, r))} />
      )}
      <span className="help">The tokens on discovery and in this wallet that are not on this exchange yet. Each gets its own instance, created with its deploy (from this wallet&apos;s tokens, else from discovery). Topic and lookup names are derived from the token id.</span>
      {error && <Notice kind="bad">Could not enable: {error}</Notice>}
      {done && <Notice kind="ok">{done}</Notice>}
    </section>
  );
}

/** A fee field's text as basis points (an integer 0 to 10 000), or null. */
function bps(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n <= 10_000 ? n : null;
}

/** Default validator terms (0.17.0, root only): a new token instance's initial terms; set or clear them. */
function DefaultTermsCard({ defaults }: { defaults: Data<Defaults> }) {
  const terms = defaults;
  const [lp, setLp] = useState("");
  const [val, setVal] = useState("");
  const [com, setCom] = useState("");
  const [error, busy, run] = useAct();
  const [done, setDone] = useState<string | null>(null);
  const t = terms.data ? terms.data.terms ?? null : undefined;
  const lpN = bps(lp);
  const valN = bps(val);
  const comN = bps(com);
  const ready = lpN !== null && valN !== null && comN !== null;

  return (
    <form
      className="panel stack-sm"
      aria-labelledby="terms-h"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setDone(null);
        run(async () => {
          await setDefaultTerms({ lpBps: lpN, validatorBps: valN, commissionBps: comN });
          setDone("The default terms are sent. They apply to the tokens enabled after this skein has taken the message.");
          terms.reload();
        });
      }}
    >
      <h2 id="terms-h" className="h2">
        Default validator terms
      </h2>
      {t === undefined ? (
        <p className="muted">{terms.error ? `Could not read the defaults: ${terms.error}` : "Reading the defaults…"}</p>
      ) : t ? (
        <p className="fg2">
          LP {t.lpFeeBps} · validator {t.validatorFeeBps} · commission {t.commissionBps} bps. A token enabled from now on starts validating at these terms.
        </p>
      ) : (
        <p className="fg2">No default terms: a token enabled from now on validates nothing until its own terms are set.</p>
      )}
      <div className="row row-wrap">
        <div className="field">
          <label htmlFor="terms-lp">LP fee (bps)</label>
          <input id="terms-lp" inputMode="numeric" value={lp} onChange={(e) => setLp(e.target.value)} aria-invalid={(lp !== "" && lpN === null) || undefined} />
        </div>
        <div className="field">
          <label htmlFor="terms-val">Validator fee (bps)</label>
          <input id="terms-val" inputMode="numeric" value={val} onChange={(e) => setVal(e.target.value)} aria-invalid={(val !== "" && valN === null) || undefined} />
        </div>
        <div className="field">
          <label htmlFor="terms-com">Commission (bps)</label>
          <input id="terms-com" inputMode="numeric" value={com} onChange={(e) => setCom(e.target.value)} aria-invalid={(com !== "" && comN === null) || undefined} />
        </div>
      </div>
      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy ? "Sending…" : "Set terms"}
        </button>
        {t && (
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy}
            onClick={() => {
              setDone(null);
              run(async () => {
                await clearDefaultTerms();
                setDone("Clearing is sent. Once taken, a token enabled after it validates nothing until its own terms are set.");
                terms.reload();
              });
            }}
          >
            Clear terms
          </button>
        )}
      </div>
      <span className="help">Each fee is an integer from 0 to 10000 basis points: a new token instance&apos;s initial terms. Each token&apos;s own terms, once set there, win.</span>
      {error && <Notice kind="bad">Could not send: {error}</Notice>}
      {done && <Notice kind="ok">{done}</Notice>}
    </form>
  );
}

/** Default market minimum (0.17.0, root only): a new token instance's initial minimum commission; set or clear it. */
function DefaultMarketCard({ defaults }: { defaults: Data<Defaults> }) {
  const market = defaults;
  const [min, setMin] = useState("");
  const [error, busy, run] = useAct();
  const [done, setDone] = useState<string | null>(null);
  const m = market.data ? market.data.market?.minCommissionBps ?? 0 : null;
  const minN = bps(min);

  return (
    <form
      className="panel stack-sm"
      aria-labelledby="market-h"
      onSubmit={(e) => {
        e.preventDefault();
        if (minN === null) return;
        setDone(null);
        run(async () => {
          await setDefaultMarket(minN);
          setDone("The default minimum is sent. It applies to the tokens enabled after this skein has taken the message.");
          market.reload();
        });
      }}
    >
      <h2 id="market-h" className="h2">
        Default market minimum
      </h2>
      {m === null ? (
        <p className="muted">{market.error ? `Could not read the defaults: ${market.error}` : "Reading the defaults…"}</p>
      ) : m > 0 ? (
        <p className="fg2">Minimum commission {m} bps. A token enabled from now on lists only pools at or above it on the Swap page.</p>
      ) : (
        <p className="fg2">No default minimum commission: a token enabled from now on lists every pool.</p>
      )}
      <div className="row row-wrap">
        <div className="field">
          <label htmlFor="market-min">Minimum commission (bps)</label>
          <input id="market-min" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} aria-invalid={(min !== "" && minN === null) || undefined} />
        </div>
      </div>
      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary" disabled={busy || minN === null}>
          {busy ? "Sending…" : "Set minimum"}
        </button>
        {m !== null && m > 0 && (
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy}
            onClick={() => {
              setDone(null);
              run(async () => {
                await clearDefaultMarket();
                setDone("Clearing is sent. Once taken, a token enabled after it lists every pool.");
                market.reload();
              });
            }}
          >
            Clear minimum
          </button>
        )}
      </div>
      <span className="help">An integer from 0 to 10000 basis points: a new token instance&apos;s initial minimum, a listing preference (anyone can still swap against any pool elsewhere). Each token&apos;s own minimum, once set there, wins.</span>
      {error && <Notice kind="bad">Could not send: {error}</Notice>}
      {done && <Notice kind="ok">{done}</Notice>}
    </form>
  );
}

/** What the discovery record says, in a few words. */
export function discoveryText(d: Discovery): string {
  return d.on
    ? "On: deploys submitted to this exchange under tm_color are kept and looked up by their outpoint (ls_color)."
    : "Off: the discovery instance is stopped.";
}

/** Discovery (root only): the 1Color discovery topic `tm_color`, its own instance; one switch. */
function DiscoveryCard({ discovery }: { discovery: Data<Discovery> }) {
  const [error, busy, run] = useAct();
  const d = discovery.data;
  const on = d?.on === true;
  return (
    <section className="panel stack-sm" aria-labelledby="disc-h">
      <div className="row row-wrap">
        <h2 id="disc-h" className="h2 grow">
          Discovery
        </h2>
        <label className="row" htmlFor="disc-on">
          <input
            id="disc-on"
            type="checkbox"
            role="switch"
            checked={on}
            disabled={busy || d === null}
            aria-checked={on}
            onChange={(e) => {
              const want = e.target.checked;
              run(async () => {
                await setDiscovery(want);
                discovery.reload();
              });
            }}
          />
          <span className="small">{on ? "On" : "Off"}</span>
        </label>
      </div>
      {d === null ? (
        <p className="muted">{discovery.error ? `Could not read discovery: ${discovery.error}` : "Reading discovery…"}</p>
      ) : (
        <p className="fg2">{discoveryText(d)}</p>
      )}
      <span className="help">
        The 1Color discovery topic (tm_color): every token&apos;s deploy, looked up by its outpoint under ls_color, in an instance of its own. Enabling a token does not submit its deploy here; the 1Color deploy page submits each new deploy.
      </span>
      {error && <Notice kind="bad">Could not send: {error}</Notice>}
    </section>
  );
}

function EnabledRow({ t }: { t: RegisteredToken }) {
  const [confirm, setConfirm] = useState(false);
  const [error, busy, run] = useAct();
  const status = t.status === "enabled" ? "enabled" : "disabled";
  return (
    <li className="reg-row">
      <span className="req-text">
        <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} size="sm" />
        <span className="small muted">
          {status}
          {t.status === "enabled" ? " · its own terms are root's message to its instance, /@<tokenId>" : ""}
        </span>
      </span>
      {t.status === "enabled" ? (
        confirm ? (
          <span className="row row-wrap end">
            <span className="small fg2">Stop {t.sym}&apos;s instance?</span>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => disableToken(t.tokenId))}>
              {busy ? "Disabling…" : "Disable"}
            </button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-outline" onClick={() => setConfirm(true)} aria-label={`Disable ${t.sym}`}>
            Disable
          </button>
        )
      ) : t.status === "disabled" ? (
        <button type="button" className="btn btn-outline" disabled={busy} onClick={() => run(async () => void (await enableToken(t.tokenId)))} aria-label={`Enable ${t.sym} again`}>
          {busy ? "Enabling…" : "Enable again"}
        </button>
      ) : null}
      {error && <Notice kind="bad">{error}</Notice>}
    </li>
  );
}

export function Settings({ session, root }: { session: Session; root: boolean }) {
  const connected = session.status === "connected";
  const reg = useRegisteredTokens(connected && root);
  const defs = useDefaults(connected && root);
  const disc = useDiscovery(connected && root);
  const claim = useClaimStatus(connected);
  const unclaimed = claim.data?.claimed === false;
  return (
    <>
      <div className="stack-xs">
        <h1 className="page-title">Settings</h1>
        <p className="lead lead-tight">The exchange&apos;s admin only. Each token enabled here runs as its own instance: a market, and a validator once it has terms.</p>
      </div>
      {!connected ? (
        <NeedWallet session={session} what="this exchange's settings" />
      ) : !root && unclaimed ? (
        <ClaimSection />
      ) : !root ? (
        <section className="panel">
          <p className="fg2">{NOT_ADMIN_TEXT}</p>
        </section>
      ) : (
        <>
          {unclaimed && <ClaimSection />}
          <DefaultTermsCard defaults={defs} />
          <DefaultMarketCard defaults={defs} />
          <DiscoveryCard discovery={disc} />
          <EnableCard discovery={disc} />
          <section className="panel stack-sm" aria-labelledby="regd-h">
            <h2 id="regd-h" className="h2">
              Enabled
            </h2>
            {reg.data === null ? (
              <p className="muted">Loading…</p>
            ) : reg.data.length === 0 ? (
              <p className="muted">No token is enabled.</p>
            ) : (
              <ul className="regs">
                {reg.data.map((t) => (
                  <EnabledRow key={t.tokenId} t={t} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
