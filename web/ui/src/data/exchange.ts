/**
 * The pages' data layer (skein-amm 0.9.0; 0.36.0, D8–D14): ONE client of the exchange
 * (`createClient`, src/client.ts — the package `@dcasegr/amm-client`) bound to the pages' own
 * base and fee rate (src/ox/env.ts: `VITE_AMM_OVERLAY` else the page's directory,
 * `VITE_FEE_RATE`) and the connected wallet, and the React hooks over it. The pages import from
 * here and nowhere else in the data layer; every function below is the client's, called on the
 * client the session holds now (`setExchangeContext`: `useSession` sets the wallet; tests set
 * anything). What the client read and planned stays across a wallet change (`withWallet`); a new
 * base starts a new client.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletInterface } from "@bsv/sdk";
import { useConnectDialog, useWallet } from "../wallet/AppWalletProvider";
import { authFetchPerInstance } from "../lib/skein";
import { AMM_OVERLAY, FEE_RATE_SATS_PER_KB } from "../ox/env";
import { createClient, hostedFrom, type AmmClient, type EnabledToken, type HostedToken, type PoolRow, type PoolsAnswer, type Signed, type TokenId } from "../client";

export * from "../client";

export interface Session {
  status: "disconnected" | "connecting" | "connected";
  identityKey: string | null;
  /** Opens the wallet connect dialog. */
  connect: () => void;
  disconnect: () => void;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * The 1Color deploy page the app carries (www/color/deploy/, skein-1color), at
 * the app's own base (`<origin>/amm/color/deploy/`): those pages take the app's
 * name from their URL, so at the origin's root (`/color/deploy/`) they find none.
 */
export const COLOR_DEPLOY_HREF = `${AMM_OVERLAY}/color/deploy/`;
/** The skein's management site, at its own app path (skein#147). */
export const SITE_HREF = "/site/";

// ---------------------------------------------------------------------------
// The context: the instance, the connected wallet, and the client over them
// ---------------------------------------------------------------------------

interface ExchangeContext {
  /** The swap instance's AMM base URL (src/ox/env.ts): the pages' own. */
  base: string;
  wallet: WalletInterface | null;
  /**
   * The wallet's BRC-104 client for an instance base (0.27.1: one session per instance — the swap
   * instance at `<origin>/amm` and each token instance at `<origin>/@<tokenId>/amm` hold their own
   * sessions; src/lib/skein.ts `authFetchPerInstance`): the signed writes.
   */
  signedFor: ((base: string) => Signed) | null;
  identityKey: string | null;
}

const context: ExchangeContext = { base: AMM_OVERLAY, wallet: null, signedFor: null, identityKey: null };

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

function freshClient(): AmmClient {
  const c = createClient({ origin: context.base, feeRateSatsPerKb: FEE_RATE_SATS_PER_KB, ...bound() });
  c.onDataChange(emit);
  return c;
}

function bound(): { wallet: WalletInterface | null; signedFor?: (base: string) => Signed; identityKey: string | null } {
  return { wallet: context.wallet, ...(context.signedFor ? { signedFor: context.signedFor } : {}), identityKey: context.identityKey };
}

let client: AmmClient = freshClient();

/** The client the pages use now. */
export function exchangeClient(): AmmClient {
  return client;
}

/** Set what the functions below reach (the wallet and its client: `useSession`; a test: anything). A new `base` forgets what was read of the old one. */
export function setExchangeContext(c: Partial<ExchangeContext>): void {
  const before = { ...context };
  Object.assign(context, c);
  if (c.base !== undefined) {
    client = freshClient();
    return;
  }
  if (context.wallet !== before.wallet || context.signedFor !== before.signedFor || context.identityKey !== before.identityKey) {
    const b = bound();
    client = client.withWallet(b.wallet, { ...(b.signedFor ? { signedFor: b.signedFor } : {}), identityKey: b.identityKey });
  }
}

/** Calls `fn` after any action changes data (swap, deploy, close, register…). Returns the unsubscribe. */
export function onDataChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forget what was read this page load (a new base; tests). */
export function forgetReads(): void {
  client.forgetReads();
}

// ---------------------------------------------------------------------------
// The client's functions, on the client held now
// ---------------------------------------------------------------------------

export const enabledList: AmmClient["enabledList"] = () => client.enabledList();
export const tokenBaseOf: AmmClient["tokenBaseOf"] = (...a: Parameters<AmmClient["tokenBaseOf"]>) => (client.tokenBaseOf as (...x: unknown[]) => ReturnType<AmmClient["tokenBaseOf"]>)(...a);
export const deployBeef: AmmClient["deployBeef"] = (...a: Parameters<AmmClient["deployBeef"]>) => (client.deployBeef as (...x: unknown[]) => ReturnType<AmmClient["deployBeef"]>)(...a);
export const claimStatus: AmmClient["claimStatus"] = (...a: Parameters<AmmClient["claimStatus"]>) => (client.claimStatus as (...x: unknown[]) => ReturnType<AmmClient["claimStatus"]>)(...a);
export const isRoot: AmmClient["isRoot"] = (...a: Parameters<AmmClient["isRoot"]>) => (client.isRoot as (...x: unknown[]) => ReturnType<AmmClient["isRoot"]>)(...a);
export const claimExchange: AmmClient["claimExchange"] = (...a: Parameters<AmmClient["claimExchange"]>) => (client.claimExchange as (...x: unknown[]) => ReturnType<AmmClient["claimExchange"]>)(...a);
export const hostedTokens: AmmClient["hostedTokens"] = (...a: Parameters<AmmClient["hostedTokens"]>) => (client.hostedTokens as (...x: unknown[]) => ReturnType<AmmClient["hostedTokens"]>)(...a);
export const watchHostedPools: AmmClient["watchHostedPools"] = (...a: Parameters<AmmClient["watchHostedPools"]>) => (client.watchHostedPools as (...x: unknown[]) => ReturnType<AmmClient["watchHostedPools"]>)(...a);
export const watchTokenPools: AmmClient["watchTokenPools"] = (...a: Parameters<AmmClient["watchTokenPools"]>) => (client.watchTokenPools as (...x: unknown[]) => ReturnType<AmmClient["watchTokenPools"]>)(...a);
export const quoteSwap: AmmClient["quoteSwap"] = (...a: Parameters<AmmClient["quoteSwap"]>) => (client.quoteSwap as (...x: unknown[]) => ReturnType<AmmClient["quoteSwap"]>)(...a);
export const executeSwap: AmmClient["executeSwap"] = (...a: Parameters<AmmClient["executeSwap"]>) => (client.executeSwap as (...x: unknown[]) => ReturnType<AmmClient["executeSwap"]>)(...a);
export const checkSwapAgain: AmmClient["checkSwapAgain"] = (...a: Parameters<AmmClient["checkSwapAgain"]>) => (client.checkSwapAgain as (...x: unknown[]) => ReturnType<AmmClient["checkSwapAgain"]>)(...a);
export const walletSats: AmmClient["walletSats"] = (...a: Parameters<AmmClient["walletSats"]>) => (client.walletSats as (...x: unknown[]) => ReturnType<AmmClient["walletSats"]>)(...a);
export const myPositions: AmmClient["myPositions"] = (...a: Parameters<AmmClient["myPositions"]>) => (client.myPositions as (...x: unknown[]) => ReturnType<AmmClient["myPositions"]>)(...a);
export const validatorTerms: AmmClient["validatorTerms"] = (...a: Parameters<AmmClient["validatorTerms"]>) => (client.validatorTerms as (...x: unknown[]) => ReturnType<AmmClient["validatorTerms"]>)(...a);
export const deployPosition: AmmClient["deployPosition"] = (...a: Parameters<AmmClient["deployPosition"]>) => (client.deployPosition as (...x: unknown[]) => ReturnType<AmmClient["deployPosition"]>)(...a);
export const closePosition: AmmClient["closePosition"] = (...a: Parameters<AmmClient["closePosition"]>) => (client.closePosition as (...x: unknown[]) => ReturnType<AmmClient["closePosition"]>)(...a);
export const rebalancePosition: AmmClient["rebalancePosition"] = (...a: Parameters<AmmClient["rebalancePosition"]>) => (client.rebalancePosition as (...x: unknown[]) => ReturnType<AmmClient["rebalancePosition"]>)(...a);
export const myTokens: AmmClient["myTokens"] = (...a: Parameters<AmmClient["myTokens"]>) => (client.myTokens as (...x: unknown[]) => ReturnType<AmmClient["myTokens"]>)(...a);
export const settleSwaps: AmmClient["settleSwaps"] = (...a: Parameters<AmmClient["settleSwaps"]>) => (client.settleSwaps as (...x: unknown[]) => ReturnType<AmmClient["settleSwaps"]>)(...a);
export const moveBackTokens: AmmClient["moveBackTokens"] = (...a: Parameters<AmmClient["moveBackTokens"]>) => (client.moveBackTokens as (...x: unknown[]) => ReturnType<AmmClient["moveBackTokens"]>)(...a);
export const sendTokens: AmmClient["sendTokens"] = (...a: Parameters<AmmClient["sendTokens"]>) => (client.sendTokens as (...x: unknown[]) => ReturnType<AmmClient["sendTokens"]>)(...a);
export const registeredTokens: AmmClient["registeredTokens"] = (...a: Parameters<AmmClient["registeredTokens"]>) => (client.registeredTokens as (...x: unknown[]) => ReturnType<AmmClient["registeredTokens"]>)(...a);
export const enableToken: AmmClient["enableToken"] = (...a: Parameters<AmmClient["enableToken"]>) => (client.enableToken as (...x: unknown[]) => ReturnType<AmmClient["enableToken"]>)(...a);
export const discoveryBase: AmmClient["discoveryBase"] = (...a: Parameters<AmmClient["discoveryBase"]>) => (client.discoveryBase as (...x: unknown[]) => ReturnType<AmmClient["discoveryBase"]>)(...a);
export const tokensToEnable: AmmClient["tokensToEnable"] = (...a: Parameters<AmmClient["tokensToEnable"]>) => (client.tokensToEnable as (...x: unknown[]) => ReturnType<AmmClient["tokensToEnable"]>)(...a);
export const disableToken: AmmClient["disableToken"] = (...a: Parameters<AmmClient["disableToken"]>) => (client.disableToken as (...x: unknown[]) => ReturnType<AmmClient["disableToken"]>)(...a);
export const defaults: AmmClient["defaults"] = (...a: Parameters<AmmClient["defaults"]>) => (client.defaults as (...x: unknown[]) => ReturnType<AmmClient["defaults"]>)(...a);
export const setDefaultTerms: AmmClient["setDefaultTerms"] = (...a: Parameters<AmmClient["setDefaultTerms"]>) => (client.setDefaultTerms as (...x: unknown[]) => ReturnType<AmmClient["setDefaultTerms"]>)(...a);
export const tokenTerms: AmmClient["tokenTerms"] = (...a: Parameters<AmmClient["tokenTerms"]>) => (client.tokenTerms as (...x: unknown[]) => ReturnType<AmmClient["tokenTerms"]>)(...a);
export const setTokenTerms: AmmClient["setTokenTerms"] = (...a: Parameters<AmmClient["setTokenTerms"]>) => (client.setTokenTerms as (...x: unknown[]) => ReturnType<AmmClient["setTokenTerms"]>)(...a);
export const clearDefaultTerms: AmmClient["clearDefaultTerms"] = (...a: Parameters<AmmClient["clearDefaultTerms"]>) => (client.clearDefaultTerms as (...x: unknown[]) => ReturnType<AmmClient["clearDefaultTerms"]>)(...a);
export const setDefaultMarket: AmmClient["setDefaultMarket"] = (...a: Parameters<AmmClient["setDefaultMarket"]>) => (client.setDefaultMarket as (...x: unknown[]) => ReturnType<AmmClient["setDefaultMarket"]>)(...a);
export const clearDefaultMarket: AmmClient["clearDefaultMarket"] = (...a: Parameters<AmmClient["clearDefaultMarket"]>) => (client.clearDefaultMarket as (...x: unknown[]) => ReturnType<AmmClient["clearDefaultMarket"]>)(...a);
export const discoveryState: AmmClient["discoveryState"] = (...a: Parameters<AmmClient["discoveryState"]>) => (client.discoveryState as (...x: unknown[]) => ReturnType<AmmClient["discoveryState"]>)(...a);
export const setDiscovery: AmmClient["setDiscovery"] = (...a: Parameters<AmmClient["setDiscovery"]>) => (client.setDiscovery as (...x: unknown[]) => ReturnType<AmmClient["setDiscovery"]>)(...a);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * What "Connect a wallet" does: the dialog when providers are configured,
 * otherwise the wallet's auto-detecting connect (an injected BRC-100 wallet
 * such as Yours). With no providers the dialog would list nothing (0.9.1).
 */
export function connectAction(providers: number, openDialog: () => void, connect: () => Promise<void>): "dialog" | "auto" {
  if (providers > 0) { openDialog(); return "dialog"; }
  void connect().catch(() => {});
  return "auto";
}

/** The connected wallet (@1sat/react `useWallet`, `useConnectDialog`); it also sets the context. */
export function useSession(): Session {
  const w = useWallet();
  const { openConnectDialog } = useConnectDialog();
  const status = w.status === "connected" && w.identityKey ? "connected" : w.status === "disconnected" ? "disconnected" : "connecting";
  const wallet = (w.wallet as WalletInterface | null | undefined) ?? null;
  const afRef = useRef<{ wallet: WalletInterface | null; signedFor: ((base: string) => Signed) | null }>({ wallet: null, signedFor: null });
  if (afRef.current.wallet !== wallet) afRef.current = { wallet, signedFor: wallet ? (authFetchPerInstance(wallet) as unknown as (base: string) => Signed) : null };
  const connected = status === "connected";
  setExchangeContext({ wallet: connected ? wallet : null, signedFor: connected ? afRef.current.signedFor : null, identityKey: connected ? w.identityKey : null });
  // Connect as 0.8's <ConnectButton/> did: the wallet's own connect, which
  // auto-detects an injected BRC-100 wallet (Yours). The connect dialog lists
  // only `providers` configured on WalletProvider, and none are, so opening it
  // showed an empty "Choose how to connect." (0.9.1). The dialog is kept for
  // when providers are configured.
  const connect = useCallback(
    () => connectAction(w.availableProviders.length, openConnectDialog, w.connect),
    [w.availableProviders, w.connect, openConnectDialog],
  );
  return { status, identityKey: connected ? w.identityKey : null, connect, disconnect: w.disconnect };
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

/**
 * The hosted tokens with live prices (D16, D22): the token list once, and the host-wide pools route
 * held as an event stream (one connection), each answer repricing the tokens. `rows`: the pools
 * the host lists now (every validator live). `live`: the stream is connected.
 */
export function useHostedTokens(): { tokens: HostedToken[] | null; error: string | null; live: boolean; reload: () => void; rows: PoolRow[] | null } {
  const r = useData(enabledList, []);
  const [rows, setRows] = useState<PoolRow[] | null>(null);
  const [live, setLive] = useState(false);
  useEffect(
    () =>
      watchHostedPools((x) => {
        setRows(x);
        setLive(true);
      }, setLive),
    [],
  );
  return { tokens: r.data ? hostedFrom(r.data, rows) : null, error: r.error, live, reload: r.reload, rows };
}

/**
 * The Swap page's pools (D11, D16): the token's pools route `GET /@<token>/amm/pools` held as an
 * event stream (an EventSource; without one, ONE GET and no poll): the market and the pools a swap
 * may use, renewed whenever the host's answer changes. Null until the first answer.
 */
export function useTokenPools(tokenId: TokenId | undefined): { data: PoolsAnswer | null; error: string | null } {
  const [data, setData] = useState<PoolsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!tokenId) return;
    return watchTokenPools(tokenId, (a) => {
      setData(a);
      setError(null);
    }, (e) => setError(e instanceof Error ? e.message : "the pools stream is interrupted"));
  }, [tokenId]);
  return { data, error };
}

/** Your tokens' load (D18): the silent pass, once per connected wallet. */
export function useSettleSwaps(connected: boolean): void {
  useEffect(() => {
    if (connected) void settleSwaps();
  }, [connected]);
}

// ---------------------------------------------------------------------------
// Hooks over the functions above
// ---------------------------------------------------------------------------

export interface Data<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount, when `deps` change and after any action (`onDataChange`). */
export function useData<T>(load: () => Promise<T>, deps: unknown[], enabled = true): Data<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => onDataChange(reload), [reload]);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    loadRef.current().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, n, enabled]);
  return { data, error, loading, reload };
}

export const useMyPositions = (enabled: boolean) => useData(myPositions, [], enabled);
export const useMyTokens = (enabled: boolean) => useData(myTokens, [], enabled);

/** A token's validator terms (0.17.0: its own instance's), none while no token is picked. */
export const useValidatorTerms = (tokenId: TokenId | undefined) =>
  useData(() => (tokenId ? validatorTerms(tokenId) : Promise.resolve(null)), [tokenId]);
export const useWalletSats = (enabled: boolean) => useData(walletSats, [], enabled);
export const useRegisteredTokens = (enabled: boolean) => useData(registeredTokens, [], enabled);
export const useDefaults = (enabled: boolean) => useData(defaults, [], enabled);
export const useDiscovery = (enabled: boolean) => useData(discoveryState, [], enabled);
export const useClaimStatus = (enabled: boolean) => useData(claimStatus, [], enabled);
export const useTokensToEnable = (enabled: boolean) => useData(tokensToEnable, [], enabled);

/** Whether the session's key is root (`isRoot`), false while disconnected. */
export function useIsRoot(session: Session): boolean {
  const r = useData(() => isRoot(session.identityKey), [session.identityKey], session.status === "connected");
  return session.status === "connected" && r.data === true;
}
