/** Small shared pieces of the Open Exchange pages. */
import { useState, type ReactNode } from "react";
import { Id } from "../components/Id";
import { type Session, type TokenId } from "../data/exchange";

const MARKS = ["#7A6A2E", "#5A66B0", "#3E6B5A", "#3F4F99", "#6B4E7A", "#4F6B7A"];

function markColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return MARKS[h % MARKS.length]!;
}

/** A token's icon, or its initial on a colour from its id. */
export function TokenMark({ tokenId, sym, icon, size = "md" }: { tokenId: TokenId; sym: string; icon?: string; size?: "sm" | "md" }) {
  return (
    <span className={`mark mark-${size}`} style={icon ? undefined : { background: markColor(tokenId) }} aria-hidden="true">
      {icon ? <img src={icon} alt="" /> : sym.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Symbol over the token's id (expandable, with copy). */
export function TokenName({ tokenId, sym, icon, size }: { tokenId: TokenId; sym: string; icon?: string; size?: "sm" | "md" }) {
  return (
    <span className="token-name">
      <TokenMark tokenId={tokenId} sym={sym} {...(icon ? { icon } : {})} {...(size ? { size } : {})} />
      <span className="token-name-text">
        <span className="sym">{sym}</span>
        <Id value={tokenId} kind="token" label={`${sym} token id`} />
      </span>
    </span>
  );
}

/** A page that needs a wallet, shown while none is connected. */
export function NeedWallet({ session, what }: { session: Session; what: string }) {
  return (
    <section className="panel gate">
      <p>Connect a wallet to see {what}.</p>
      <button type="button" className="btn btn-primary" onClick={session.connect} disabled={session.status === "connecting"}>
        {session.status === "connecting" ? "Connecting…" : "Connect a wallet"}
      </button>
    </section>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "bad" | "info"; children: ReactNode }) {
  return (
    <p className={`notice notice-${kind}`} role={kind === "bad" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function LiveDot({ live, label }: { live: boolean; label?: string }) {
  return (
    <span className="live">
      <span className={`dot ${live ? "dot-on" : "dot-off"}`} aria-hidden="true" />
      {label ?? (live ? "live" : "offline")}
    </span>
  );
}

type Theme = "light" | "dark";
/** localStorage key for the header's theme switch; index.html reads it before first paint. */
export const THEME_KEY = "ox-theme";

function currentTheme(): Theme {
  try {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The header's light/dark switch: sets `data-theme` on <html> and remembers the choice. Light by default. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.setAttribute("data-theme", next);
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#1B1A17" : "#FFFFFF");
        document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", next);
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          /* storage blocked: the choice lasts for this page only */
        }
        setTheme(next);
      }}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
