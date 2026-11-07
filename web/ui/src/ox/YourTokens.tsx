/**
 * Your tokens: the wallet's own 1Color tokens with balance (the BRC-207 module's), each marked on
 * this exchange or not; beside the balance, what the swap basket holds of it,
 * with "Move back" (0.12.0: the recovery path for a stuck swap). 0.34.0 (D18, D24): no
 * "Unfinished" card: on load a silent pass settles the swap basket's staged legs (a payout this
 * wallet's swap left is taken in; nothing is shown). 0.40.0: the sats in the swap basket are shown
 * once, above the list, with their own Move back (they are no token's); a token's swap-basket line
 * shows its tokens. 0.30.0: "Send" on a token with a balance — an inline form (handle, amount, memo)
 * under the row, one open at a time; @1sat/actions `send1Color` builds the send through the wallet's
 * 1Color module and delivers it to the handle's messagebox (BRC-232); the row then says what happened.
 */
import { useState } from "react";
import type { Send1ColorResult } from "@1sat/actions";
import { COLOR_DEPLOY_HREF, moveBackStagedSats, moveBackTokens, sendTokens, useMyTokens, useSettleSwaps, useSwapBasketSats, type Session, type WalletToken } from "../data/exchange";
import { fmtAmount, fmtSats, parseInput } from "./format";
import { NeedWallet, Notice, TokenName } from "./bits";

function Status({ t }: { t: WalletToken }) {
  if (t.onExchange) return <span className="ok small pill pill-enabled">On this exchange</span>;
  return <span className="muted small pill pill-disabled">Not on this exchange</span>;
}

function SwapBasket({ t, onStart }: { t: WalletToken; onStart?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.inSwaps === 0n) return null;
  return (
    <span className="status-cell">
      <span className="muted small">
        In the swap basket {fmtAmount(t.inSwaps, t.dec)}{" "}
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy}
          onClick={() => {
            onStart?.();
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

/** What a send left on its row: sent, or built but not delivered. */
export type SendNote = { kind: "sent"; amount: bigint; handle: string; txid: string } | { kind: "undelivered"; txid: string; text: string };

/** The send's outcome: a note on the row (the form closes), or the SDK's text in the form (it stays open). */
export type SendOutcome = { note: SendNote } | { formError: string };

/** The amount typed, checked before any wallet call: the raw units, or one line why not. */
export function checkSendAmount(text: string, dec: number, balance: bigint): { amount: bigint } | { error: string } {
  const amount = parseInput(text, dec);
  if (amount === null) return { error: `Not an amount (up to ${dec} decimal${dec === 1 ? "" : "s"}).` };
  if (amount <= 0n) return { error: "The amount must be more than 0." };
  if (amount > balance) return { error: `More than your balance (${fmtAmount(balance, dec)}).` };
  return { amount };
}

/** The action's result as the row shows it. */
export function sendOutcome(r: Send1ColorResult, amount: bigint, handle: string): SendOutcome {
  if (r.error !== undefined) {
    if (r.txid) return { note: { kind: "undelivered", txid: r.txid, text: r.error.replace(/^delivery-failed: /, "") } };
    return { formError: r.error };
  }
  if (r.delivered && r.txid) return { note: { kind: "sent", amount, handle, txid: r.txid } };
  return { formError: "The send returned no transaction." };
}

/** Checks what was typed, then sends (`send`: sendTokens; a test: a spy). Never calls `send` on a bad amount. */
export async function runSend(
  t: Pick<WalletToken, "tokenId" | "dec" | "balance">,
  input: { handle: string; amount: string; memo: string },
  send: typeof sendTokens = sendTokens,
): Promise<SendOutcome> {
  const checked = checkSendAmount(input.amount, t.dec, t.balance);
  if ("error" in checked) return { formError: checked.error };
  const handle = input.handle.trim();
  const memo = input.memo.trim();
  try {
    return sendOutcome(await send(t.tokenId, handle, checked.amount, memo || undefined), checked.amount, handle);
  } catch (e: unknown) {
    return { formError: e instanceof Error ? e.message : String(e) };
  }
}

export function SendNoteLine({ note, t }: { note: SendNote; t: Pick<WalletToken, "sym" | "dec"> }) {
  const tx = (
    <span className="mono" title={note.txid}>
      {note.txid.slice(0, 8)}
    </span>
  );
  if (note.kind === "sent")
    return (
      <p className="send-note ok small" role="status">
        Sent {fmtAmount(note.amount, t.dec)} {t.sym} to {note.handle} · {tx}
      </p>
    );
  return (
    <p className="send-note bad small" role="status">
      The send was built ({tx}) but could not be delivered: {note.text}. The tokens are in the pending send until it expires.
    </p>
  );
}

export interface SendFormState {
  handle: string;
  amount: string;
  memo: string;
  busy: boolean;
  error: string | null;
}

/** The send form as drawn (state from SendForm). */
export function SendFormView({ t, s, set, onSubmit, onCancel }: { t: WalletToken; s: SendFormState; set: (p: Partial<SendFormState>) => void; onSubmit: () => void; onCancel: () => void }) {
  const id = (f: string) => `send-${f}-${t.tokenId}`;
  return (
    <form
      className="send-form stack-sm"
      aria-label={`Send ${t.sym}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!s.busy) onSubmit();
      }}
    >
      <div className="row row-wrap">
        <div className="field">
          <label htmlFor={id("handle")}>Handle</label>
          <input id={id("handle")} placeholder="name@domain" value={s.handle} disabled={s.busy} onChange={(e) => set({ handle: e.target.value })} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={id("amount")}>Amount</label>
          <div className="affix">
            <input id={id("amount")} inputMode="decimal" value={s.amount} disabled={s.busy} onChange={(e) => set({ amount: e.target.value })} />
            <span className="affix-unit" aria-hidden="true">
              {t.sym}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor={id("memo")}>Memo</label>
          <input id={id("memo")} placeholder="Optional" value={s.memo} disabled={s.busy} onChange={(e) => set({ memo: e.target.value })} />
        </div>
      </div>
      <div className="row row-wrap">
        <button type="submit" className="btn btn-primary" disabled={s.busy || s.handle.trim() === ""}>
          {s.busy ? "Sending…" : "Send"}
        </button>
        <button type="button" className="btn btn-outline" disabled={s.busy} onClick={onCancel}>
          Cancel
        </button>
        {s.error && <span className="bad small">{s.error}</span>}
      </div>
    </form>
  );
}

function SendForm({ t, onDone, onCancel }: { t: WalletToken; onDone: (n: SendNote) => void; onCancel: () => void }) {
  const [s, setS] = useState<SendFormState>({ handle: "", amount: "", memo: "", busy: false, error: null });
  const set = (p: Partial<SendFormState>) => setS((x) => ({ ...x, ...p }));
  return (
    <SendFormView
      t={t}
      s={s}
      set={set}
      onCancel={onCancel}
      onSubmit={() => {
        set({ busy: true, error: null });
        void runSend(t, s).then((o) => {
          if ("note" in o) onDone(o.note);
          else set({ busy: false, error: o.formError });
        });
      }}
    />
  );
}

function TokenRow({ t, sending, setSending }: { t: WalletToken; sending: boolean; setSending: (open: boolean) => void }) {
  const [note, setNote] = useState<SendNote | null>(null);
  return (
    <li className="ttable-row">
      <TokenName tokenId={t.tokenId} sym={t.sym} {...(t.icon ? { icon: t.icon } : {})} />
      <span className="num r">
        <span className="lbl">Balance </span>
        {fmtAmount(t.balance, t.dec)}
        <SwapBasket t={t} onStart={() => setNote(null)} />
      </span>
      <span className="r">
        <Status t={t} />
        {t.balance > 0n && (
          <>
            {" "}
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                setNote(null);
                setSending(true);
              }}
              aria-label={`Send ${t.sym} to a BRC-169 handle`}
            >
              Send
            </button>
          </>
        )}
      </span>
      {sending && (
        <SendForm
          t={t}
          onCancel={() => setSending(false)}
          onDone={(n) => {
            setNote(n);
            setSending(false);
          }}
        />
      )}
      {note && <SendNoteLine note={note} t={t} />}
    </li>
  );
}

/** The sats in the swap basket (0.40.0): one line, with Move back (one plain wallet action, no outputs: the wallet's change takes them). */
function StagedSats({ sats }: { sats: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sats === 0) return null;
  return (
    <p className="muted small basket-line">
      {fmtSats(BigInt(sats))} sats in the swap basket{" "}
      <button
        type="button"
        className="btn btn-outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          moveBackStagedSats().then(
            () => setBusy(false),
            (e: unknown) => {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            },
          );
        }}
        aria-label="Move the sats in the swap basket back into your wallet"
      >
        {busy ? "Moving…" : "Move back"}
      </button>
      {error && <span className="bad small"> {error}</span>}
    </p>
  );
}

export function YourTokens({ session }: { session: Session }) {
  const connected = session.status === "connected";
  const mine = useMyTokens(connected);
  const staged = useSwapBasketSats(connected);
  useSettleSwaps(connected);
  const [sending, setSending] = useState<string | null>(null);
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
        returns them to your wallet. Send gives a token to a BRC-169 handle; the recipient's wallet takes it in.
      </p>
      {!connected ? (
        <NeedWallet session={session} what="your tokens" />
      ) : (
        <>
          {mine.error && <Notice kind="bad">Could not read your tokens: {mine.error}</Notice>}
          <StagedSats sats={staged.data ?? 0} />
          <section className="panel ttable" aria-label="Your tokens">
            <div className="ttable-head" aria-hidden="true">
              <span>Token</span>
              <span className="r">Balance</span>
              <span />
            </div>
            {mine.data === null ? (
              <p className="empty loading">Loading your tokens…</p>
            ) : mine.data.length === 0 ? (
              <p className="empty">Your wallet holds no 1Color tokens.</p>
            ) : (
              <ul className="ttable-rows">
                {mine.data.map((t) => (
                  <TokenRow key={t.tokenId} t={t} sending={sending === t.tokenId} setSending={(open) => setSending(open ? t.tokenId : null)} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
