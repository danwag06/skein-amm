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
 * `defaults`). Each enabled token's own terms (0.35.0): read once from its
 * `/terms`, edited with the same three fields, sent as root's `terms {tokenId,
 * terms}` to swap (the host forwards them to the token's instance). Topic and
 * lookup names are derived from the token id.
 * Discovery: one switch, root's `discovery {on}` — the 1Color discovery topic
 * `tm_color` served by an instance of its own, started or stopped by the host.
 * The price to enable a token (0.42.0, open-exchange 0.15.0): one field, root's `price {sats}`
 * (empty: off, only the admin enables); any signed sender may then enable a token on
 * `POST /amm/enable` for it. The exchange's wallet: the sats it holds (`GET <swap>/wallet`), one
 * Withdraw (everything, a payment to the admin's wallet, taken in at once; disabled at 0 sats), and
 * the latest withdrawal taken in again on load (`settleWithdrawals`).
 */
import { useEffect, useState } from "react";
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
  setEnablePrice,
  settleWithdrawals,
  withdrawAll,
  setTokenTerms,
  tokenTerms,
  useClaimStatus,
  useDefaults,
  useDiscovery,
  useExchangeWallet,
  useRegisteredTokens,
  useTokensToEnable,
  type Data,
  type Defaults,
  type Discovery,
  type EnableCandidate,
  type ExchangeWallet,
  type EnableSent,
  type RegisteredToken,
  type Session,
  type TermsInput,
} from "../data/exchange";
import { NeedWallet, Notice, TokenName } from "./bits";
import { fmtSats } from "./format";

/** Whole sats with thousands separators, for display. */
const groupSats = (n: number): string => (Number.isSafeInteger(n) ? fmtSats(BigInt(n)) : String(n));

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
        <p className={list.error ? "bad" : "muted loading"}>{list.error ? `Could not read the tokens to enable: ${list.error}` : "Loading…"}</p>
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

/** The minimum leg's text (0.40.0): empty is none (0), else a whole number of sats; null when it is neither. */
function sats(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** The three fee fields' text (0.35.0: one form for the defaults card and each token's terms) and (0.40.0) the minimum leg's. */
export function useTermsFields(): { lp: string; val: string; com: string; min: string; setLp: (v: string) => void; setVal: (v: string) => void; setCom: (v: string) => void; setMin: (v: string) => void; terms: TermsInput | null } {
  const [lp, setLp] = useState("");
  const [val, setVal] = useState("");
  const [com, setCom] = useState("");
  const [min, setMin] = useState("");
  const lpN = bps(lp);
  const valN = bps(val);
  const comN = bps(com);
  const minN = sats(min);
  return {
    lp,
    val,
    com,
    min,
    setLp,
    setVal,
    setCom,
    setMin,
    terms: lpN !== null && valN !== null && comN !== null && minN !== null ? { lpBps: lpN, validatorBps: valN, commissionBps: comN, ...(minN > 0 ? { minLegSats: minN } : {}) } : null,
  };
}

/**
 * The three fee fields and their buttons (0.35.0: shared by the defaults card and a token row's
 * Edit). The caller's `<form>` submits (`setLabel`); `clearLabel` + `onClear` add the second button.
 */
export function TermsFields({ f, idPrefix, busy, setLabel, clearLabel, onClear, onCancel }: { f: ReturnType<typeof useTermsFields>; idPrefix: string; busy: boolean; setLabel: string; clearLabel?: string; onClear?: () => void; onCancel?: () => void }) {
  return (
    <>
      <div className="row row-wrap">
        <div className="field">
          <label htmlFor={`${idPrefix}-lp`}>LP fee (bps)</label>
          <input id={`${idPrefix}-lp`} inputMode="numeric" value={f.lp} onChange={(e) => f.setLp(e.target.value)} aria-invalid={(f.lp !== "" && bps(f.lp) === null) || undefined} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-val`}>Validator fee (bps)</label>
          <input id={`${idPrefix}-val`} inputMode="numeric" value={f.val} onChange={(e) => f.setVal(e.target.value)} aria-invalid={(f.val !== "" && bps(f.val) === null) || undefined} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-com`}>Commission (bps)</label>
          <input id={`${idPrefix}-com`} inputMode="numeric" value={f.com} onChange={(e) => f.setCom(e.target.value)} aria-invalid={(f.com !== "" && bps(f.com) === null) || undefined} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-min`}>Minimum leg (sats)</label>
          <input id={`${idPrefix}-min`} inputMode="numeric" placeholder="none" value={f.min} onChange={(e) => f.setMin(e.target.value)} aria-invalid={sats(f.min) === null || undefined} />
        </div>
      </div>
      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary" disabled={busy || !f.terms}>
          {busy ? "Sending…" : setLabel}
        </button>
        {onClear && (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onClear}>
            {clearLabel}
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </>
  );
}

/** Default validator terms (0.17.0, root only): a new token instance's initial terms; set or clear them. */
function DefaultTermsCard({ defaults }: { defaults: Data<Defaults> }) {
  const terms = defaults;
  const f = useTermsFields();
  const [error, busy, run] = useAct();
  const [done, setDone] = useState<string | null>(null);
  const t = terms.data ? terms.data.terms ?? null : undefined;

  return (
    <form
      className="panel stack-sm"
      aria-labelledby="terms-h"
      onSubmit={(e) => {
        e.preventDefault();
        const ready = f.terms;
        if (!ready) return;
        setDone(null);
        run(async () => {
          await setDefaultTerms(ready);
          setDone("The default terms are sent. They apply to the tokens enabled after this skein has taken the message.");
          terms.reload();
        });
      }}
    >
      <h2 id="terms-h" className="h2">
        Default validator terms
      </h2>
      {t === undefined ? (
        <p className={terms.error ? "bad" : "muted loading"}>{terms.error ? `Could not read the defaults: ${terms.error}` : "Reading the defaults…"}</p>
      ) : t ? (
        <p className="fg2">
          {tokenTermsText(t)}. A token enabled from now on starts validating at these terms.
        </p>
      ) : (
        <p className="fg2">No default terms: a token enabled from now on validates nothing until its own terms are set.</p>
      )}
      <TermsFields
        f={f}
        idPrefix="terms"
        busy={busy}
        setLabel="Set terms"
        clearLabel="Clear terms"
        {...(t
          ? {
              onClear: () => {
                setDone(null);
                run(async () => {
                  await clearDefaultTerms();
                  setDone("Clearing is sent. Once taken, a token enabled after it validates nothing until its own terms are set.");
                  terms.reload();
                });
              },
            }
          : {})}
      />
      <span className="help">
        Each fee is an integer from 0 to 10000 basis points: a new token instance&apos;s initial terms. Each token&apos;s own terms, once set there, win. Minimum leg: the
        smallest leg the validator signs, in sats on the leg&apos;s sats side; empty for none.
      </span>
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
        <p className={market.error ? "bad" : "muted loading"}>{market.error ? `Could not read the defaults: ${market.error}` : "Reading the defaults…"}</p>
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

/** The price field's text (0.42.0): empty is off (null); else a whole number of sats, 1 or more; undefined when it is neither. */
export function priceSats(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** What the price record says (0.42.0). */
export function enablePriceText(sats: number | undefined, fmt: (n: number) => string = String): string {
  return sats ? `Anyone with a wallet can enable a token for ${fmt(sats)} sats. Only you can disable it.` : "Off: only you enable tokens.";
}

/** The price to enable a token (0.42.0, root only): one field; empty turns it off. */
function EnablePriceCard({ defaults }: { defaults: Data<Defaults> }) {
  const [price, setPrice] = useState("");
  const [error, busy, run] = useAct();
  const [done, setDone] = useState<string | null>(null);
  const want = priceSats(price);
  return (
    <form
      className="panel stack-sm"
      aria-labelledby="price-h"
      onSubmit={(e) => {
        e.preventDefault();
        if (want === undefined) return;
        setDone(null);
        run(async () => {
          await setEnablePrice(want);
          setDone(want === null ? "Sent: the paid enable is off once the exchange takes it." : `Sent: the price is ${want} sats once the exchange takes it.`);
          defaults.reload();
        });
      }}
    >
      <h2 id="price-h" className="h2">
        Price to enable a token
      </h2>
      {defaults.data === null ? (
        <p className={defaults.error ? "bad" : "muted loading"}>{defaults.error ? `Could not read the defaults: ${defaults.error}` : "Reading the defaults…"}</p>
      ) : (
        <p className="fg2">{enablePriceText(defaults.data.enablePriceSats, groupSats)}</p>
      )}
      <div className="row row-wrap">
        <div className="field">
          <label htmlFor="enable-price">Price to enable a token (sats)</label>
          <input id="enable-price" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={want === undefined || undefined} />
        </div>
      </div>
      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary" disabled={busy || want === undefined}>
          {busy ? "Sending…" : "Set price"}
        </button>
      </div>
      <span className="help">Empty turns it off. A token enabled this way gets the default terms. A token you disabled can only be enabled again by you.</span>
      {error && <Notice kind="bad">Could not send: {error}</Notice>}
      {done && <Notice kind="ok">{done}</Notice>}
    </form>
  );
}

/** The exchange's wallet line (0.42.0). */
export function exchangeWalletText(w: ExchangeWallet, fmt: (n: number) => string = String): string {
  return `Exchange wallet: ${fmt(w.sats)} sats`;
}

/** What the Withdraw button says once sent (0.42.0). */
export const WITHDRAW_SENT_TEXT = (sats: number) => `Withdrawn: ${sats} sats are in your wallet.`;

/** The exchange's wallet (0.42.0, root only): what the paid enables paid into it, and one Withdraw. */
function ExchangeWalletCard({ wallet }: { wallet: Data<ExchangeWallet> }) {
  const [error, busy, run] = useAct();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    void settleWithdrawals().then((t) => { if (t.length > 0) wallet.reload(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sats = wallet.data?.sats ?? 0;
  return (
    <section className="panel stack-sm" aria-labelledby="wallet-h">
      <h2 id="wallet-h" className="h2">
        Exchange wallet
      </h2>
      {wallet.data === null ? (
        <p className={wallet.error ? "bad" : "muted loading"}>{wallet.error ? `Could not read the exchange's wallet: ${wallet.error}` : "Reading the exchange's wallet…"}</p>
      ) : (
        <p className="fg2">{exchangeWalletText(wallet.data, groupSats)}</p>
      )}
      <div className="row row-wrap">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || sats <= 0}
          onClick={() => {
            setDone(null);
            run(async () => {
              const x = await withdrawAll();
              setDone(WITHDRAW_SENT_TEXT(x.sats));
              wallet.reload();
            });
          }}
        >
          {busy ? "Sending…" : "Withdraw"}
        </button>
      </div>
      <span className="help">Everything in the exchange&apos;s wallet goes to your own wallet, less the network fee.</span>
      {error && <Notice kind="bad">Could not send: {error}</Notice>}
      {done && <Notice kind="ok">{done}</Notice>}
    </section>
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
        <p className={discovery.error ? "bad" : "muted loading"}>{discovery.error ? `Could not read discovery: ${discovery.error}` : "Reading discovery…"}</p>
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

/** A token's terms as its instance holds them (P7's `validator`; 0.40.0 `minLegSats`, 0 or absent: none). */
type LiveTerms = { lpFeeBps: number; validatorFeeBps: number; commissionBps: number; minLegSats?: number } | null;

/** A token's terms, in a few words: `LP <n> · validator <n> · commission <n> bps` (0.40.0: then `· minimum leg <n> sats` when set), or "market only". */
export function tokenTermsText(v: LiveTerms): string {
  return v ? `LP ${v.lpFeeBps} · validator ${v.validatorFeeBps} · commission ${v.commissionBps} bps${v.minLegSats ? ` · minimum leg ${v.minLegSats} sats` : ""}` : "market only";
}

/** The line shown when the token's `/terms` has not followed a sent change within 10 s. */
export const TERMS_NOT_APPLIED_TEXT = "sent, not applied yet";

/** Whether the read terms are the ones sent (null: market only). */
export function termsApplied(v: LiveTerms, want: TermsInput | null): boolean {
  if (!want) return v === null;
  return !!v && v.lpFeeBps === want.lpBps && v.validatorFeeBps === want.validatorBps && v.commissionBps === want.commissionBps && (v.minLegSats ?? 0) === (want.minLegSats ?? 0);
}

/**
 * After a terms change is sent: the token's `/terms` re-read until it shows `want` or `ms` pass
 * (the host forwards swap's event to the token's instance). The last read, and whether it applied.
 */
export async function untilTermsApplied(read: () => Promise<LiveTerms>, want: TermsInput | null, ms = 10_000, every = 500): Promise<{ terms: LiveTerms | undefined; applied: boolean }> {
  const end = Date.now() + ms;
  let last: LiveTerms | undefined;
  for (;;) {
    last = await read().catch(() => last);
    if (last !== undefined && termsApplied(last, want)) return { terms: last, applied: true };
    if (Date.now() >= end) return { terms: last, applied: false };
    await new Promise((r) => setTimeout(r, every));
  }
}

/** An enabled token's terms (0.35.0): read once per page load; Edit opens the three fields. */
export function TokenTermsLine({ terms, error, note }: { terms: LiveTerms | undefined; error: string | null; note: string | null }) {
  return (
    <>
      {" · "}
      {terms === undefined ? (error ? `terms not read: ${error}` : "reading terms…") : tokenTermsText(terms)}
      {note ? ` · ${note}` : ""}
    </>
  );
}

function TokenTermsEdit({ t, onSent, onCancel }: { t: RegisteredToken; onSent: (want: TermsInput | null) => Promise<void>; onCancel: () => void }) {
  const f = useTermsFields();
  const [error, busy, run] = useAct();
  const id = `tt-${t.tokenId.slice(0, 16)}`;
  return (
    <form
      className="stack-sm reg-edit"
      aria-label={`${t.sym} terms`}
      onSubmit={(e) => {
        e.preventDefault();
        const want = f.terms;
        if (!want) return;
        run(async () => {
          await setTokenTerms(t.tokenId, want);
          await onSent(want);
        });
      }}
    >
      <TermsFields
        f={f}
        idPrefix={id}
        busy={busy}
        setLabel="Save"
        clearLabel="Market only"
        onClear={() =>
          run(async () => {
            await setTokenTerms(t.tokenId, null);
            await onSent(null);
          })
        }
        onCancel={onCancel}
      />
      {error && <Notice kind="bad">Could not send: {error}</Notice>}
    </form>
  );
}

function EnabledRow({ t }: { t: RegisteredToken }) {
  const [confirm, setConfirm] = useState(false);
  const [error, busy, run] = useAct();
  const [terms, setTerms] = useState<LiveTerms | undefined>(undefined);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const enabled = t.status === "enabled";
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    tokenTerms(t.tokenId).then(
      (v) => live && setTerms(v),
      (e: unknown) => live && setTermsError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [enabled, t.tokenId]);
  const status = enabled ? "enabled" : "disabled";
  return (
    <li className="reg-row">
      <span className="req-text">
        <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} size="sm" />
        <span className="small muted">
          <span className={`pill pill-${status}`}>{status}</span>
          {enabled && <TokenTermsLine terms={terms} error={termsError} note={note} />}
        </span>
      </span>
      <span className="row row-wrap end">
        {enabled && !editing && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => {
              setNote(null);
              setEditing(true);
            }}
            aria-label={`Edit ${t.sym} terms`}
          >
            Edit
          </button>
        )}
        {t.status === "enabled" ? (
          confirm ? (
            <span className="row row-wrap end">
              <span className="small fg2">Stop {t.sym}&apos;s instance?</span>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(() => disableToken(t.tokenId))}>
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
      </span>
      {enabled && editing && (
        <TokenTermsEdit
          t={t}
          onCancel={() => setEditing(false)}
          onSent={async (want) => {
            const r = await untilTermsApplied(() => tokenTerms(t.tokenId), want);
            if (r.terms !== undefined) {
              setTerms(r.terms);
              setTermsError(null);
            }
            setNote(r.applied ? null : TERMS_NOT_APPLIED_TEXT);
            setEditing(false);
          }}
        />
      )}
      {error && <Notice kind="bad">{error}</Notice>}
    </li>
  );
}

export function Settings({ session, root }: { session: Session; root: boolean }) {
  const connected = session.status === "connected";
  const reg = useRegisteredTokens(connected && root);
  const defs = useDefaults(connected && root);
  const disc = useDiscovery(connected && root);
  const wallet = useExchangeWallet(connected && root);
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
          <EnablePriceCard defaults={defs} />
          <ExchangeWalletCard wallet={wallet} />
          <DiscoveryCard discovery={disc} />
          <EnableCard discovery={disc} />
          <section className="panel stack-sm" aria-labelledby="regd-h">
            <h2 id="regd-h" className="h2">
              Enabled
            </h2>
            {reg.data === null ? (
              <p className="muted loading">Loading…</p>
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
