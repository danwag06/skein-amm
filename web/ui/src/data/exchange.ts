/**
 * Open Exchange: every read and every action the pages make, in one typed
 * module (shruggr/skein#147; wired in skein-amm 0.9.0). The pages import from
 * here and nowhere else in the data layer.
 *
 * Where each comes from (0.17.0, shruggr/skein-amm#4): the pages are served by
 * the CONFIG instance (`context.base`): its token list (`GET <config>/tokens`:
 * each enabled token with its own instance's url), its defaults and root's
 * enable / disable / defaults messages. Everything per
 * token — pools, prices, liveness, `/call`, `/submit`, `/spends` — goes to
 * that token's own instance (`tokenBaseOf`: `<url>/amm`). No read crosses
 * instances.
 *
 * - **Prices** (`hostedTokens`, `subscribePrices`): the AMM lookup's beats
 *   (skein-overlay 0.12.0, David Case 2026-10-09: "Pricing lives in the AMM
 *   LOOKUP's own beacon"): `GET <base>/.live/ls_amm_<assetId>-live`, each live skin's
 *   per-token, per-validator totals of its listed pools, combined here over
 *   the live validators (src/market/prices.ts); a token no beat reports
 *   falls back to this skein's own listing (`ls_amm_<assetId>`) and liveness. Polled
 *   every `REFRESH_MS` (the beats live in the host's liveness, not in the
 *   log: no event stream carries them).
 * - **Swap** (`quoteSwap`, `executeSwap`): the matching engine's plan over
 *   this skein's listed pools whose validator is live (src/market/plan.ts)
 *   and (0.16.0) whose commission is at or above this market's minimum
 *   (`amm.swap.terms` `minCommissionBps`, the record root sets; `swapPools`
 *   counts the ones it hides),
 *   each leg built, relayed and settled as before (src/market/swapAction.ts,
 *   swapFlow.ts; `amm.swap.submit` on `/call`). A tokens-in swap first
 *   tops up the active swap basket `amm-swap` with one module send
 *   (src/market/activeSwap.ts, 0.12.0); its legs spend from there.
 * - **Liquidity**: `myPositions` from the wallet's pool rows (`amm-pools`)
 *   and the chain state by outpoint (src/lp/positions.ts: the pool followed
 *   to its current output); `deployPosition` asks this skein's validator to
 *   affirm the pool (`amm.pool.terms`, `amm.pool.affirm`) and has the
 *   wallet's BRC-207 module build, sign and broadcast the deploy in one
 *   createAction (src/lp/poolDeploy.ts, 0.12.0); `closePosition` closes it
 *   (src/lp/close.ts, `POST /submit`).
 * - **Your tokens**: the wallet's BRC-207 module (`p color assets`, the
 *   balance summed from its outputs; src/wallet/color.ts) and the active swap basket
 *   (`moveBackTokens`).
 * - **Settings** (root of the config instance, 0.17.0): the enable list
 *   (`GET <config>/tokens`) with Disable / Enable again; Enable a token —
 *   root's `{fn: "enable", args: {tokenId, beef}}` to `<app>/admin`, the
 *   deploy's BEEF from the wallet's module basket or pasted; the defaults a
 *   new token instance is
 *   created with (`GET <config>/defaults`; root's `{fn: "defaults"}`): its
 *   initial validator terms and market minimum (a token's own terms are root's
 *   message to `/@<tokenId>`: not on this page). `isRoot` (0.26.0): the host's
 *   `/skeins?key=` names swap; while nobody holds root, Settings offers the
 *   claim (`claimStatus`, `claimExchange`).
 * - **The instance's identity** (0.15.0, `instanceIdentity`): the key its
 *   signed answers carry, the recipient of root's messages (a market-only
 *   skein refuses `amm.pool.terms`, which named it
 *   before).
 *
 * Ids (David, 2026-10-09): every token id is the BRC-207 assetId
 * `<txid>_<vout>`, `_0` included for a 1Color token (src/lib/tokenId.ts);
 * an outpoint is `<txid>.<vout>`. Amounts are bigints in base units; prices
 * are numbers: sats per whole token.
 *
 * The connected wallet (and its BRC-104 client) reach these functions
 * through `useSession` (`setExchangeContext`); tests set the context
 * themselves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Beef, Transaction, Utils, type WalletInterface } from "@bsv/sdk";
import { send1Color, type Send1ColorResult } from "@1sat/actions";
import { computeSwap, type PoolState, type Plan } from "@amm-poc/matching-engine";
import { useConnectDialog, useWallet } from "../wallet/AppWalletProvider";
import { deployQuery, outpointText, parseOutpoint, parseTokenId, sdkTokenId, tokenIdText } from "../lib/tokenId";
import { AMM_OVERLAY, FEE_RATE_SATS_PER_KB, REFRESH_MS, appName, tokenBase } from "../lib/config";
import { ammLookupService, fetchLive, lookup, lookupPoolOutput, parseOutputList, parseTokenTopic, queryPools, type LiveAnswer, type SignedFetch, type TokenTopic } from "../lib/overlay";
import { authFetchPerInstance, instanceBase, readBeats, readDefaults, readDiscovery, readSpend, readTokenList, readTokens, sendMessage, type Beat, type Defaults, type Discovery, type EnabledToken, type ListedToken } from "../lib/skein";
import { liveSenders, pricesFromBeats, depthOf, type TokenPrice } from "../market/prices";
import { buildPlanRequest, goneFromLookup, quote as planQuote } from "../market/plan";
import { validatorStatus } from "../market/view";
import { RelayError, SWAP_TERMS_FN, callApp, callUrl, readBytes, swapTerms, type AuthFetchLike } from "../market/relay";
import { pendingSwapPayouts, planSwapLeg, prepareSwap, selectExactSatsInput, selectExactTokenInputs, type PlanLegInput, type PlannedLeg, type SatsInput, type TokenInput } from "../market/swapAction";
import { moveBack, sendSatsToSwapBasket, sendToSwapBasket, swapHoldingBeef, swapHoldings, swapSatsHoldings, swapTotals } from "../market/activeSwap";
import { relaySwap, type SwapOutcome } from "../market/swapFlow";
import { PendingPayoutStore, internalizeNow, isLegacyPayout, onPendingPayoutsChange, type PendingPayout } from "../wallet/pendingPayouts";
import { formatAmount } from "../lp/amounts";
import { basketRows } from "../lp/wallet";
import { buildInventory, decodeTokenRow, deployIcon } from "../lp/inventory";
import { imageDataUrl } from "../lp/images";
import { deployPool } from "../lp/poolDeploy";
import { PoolTemplate } from "../pool";
import { colorOutput, historyPoolRows, mergePoolRows, positionRowsOf, loadPosition, type LoadedPosition } from "../lp/positions";
import { recoverPosition as recoverPoolRow } from "../lp/recover";
import { POOLS_BASKET, assetBasket, heldOutputs } from "../wallet/color";
import { prepareClose, submitToOverlay } from "../lp/close";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A token id: the BRC-207 assetId `<txid>_<vout>`, `_0` included (src/lib/tokenId.ts). */
export type TokenId = string;

/** What a swap of 2% of the price costs: the sats a buy needs to move the marginal price up by `bps`. */
export interface Depth {
  bps: number;
  sats: bigint;
}

/** A token this overlay hosts (registered here), with its pools summed. */
export interface HostedToken {
  tokenId: TokenId;
  sym: string;
  dec: number;
  /** An image URL (a data: URL of the deploy's embedded icon, or an ORDFS URL). */
  icon?: string;
  /** Sats per whole token across the token's pools: what the next small swap pays. Null with no open pool. */
  marginalPrice: number | null;
  depth: Depth | null;
  /** Number of open pools. */
  pools: number;
  /** All pools summed. */
  reserves: { sats: bigint; tokens: bigint };
  /** Price change over 24 h, a fraction (0.018 = +1.8%). Absent when not known. */
  change24h?: number;
}

/** One open pool of a token, as a quote routes over it. */
export interface PoolView {
  /** `<txid>.<vout>` */
  outpoint: string;
  tokenId: TokenId;
  sats: bigint;
  tokens: bigint;
  validator: ValidatorRef;
}

export interface ValidatorRef {
  identityKey: string;
  live: boolean;
}

/** A price push from the host's subscription (skein#148). */
export interface PriceUpdate {
  tokenId: TokenId;
  marginalPrice: number | null;
  depth: Depth | null;
  pools: number;
  reserves: { sats: bigint; tokens: bigint };
  at: number;
}

/** "buy": pay sats, receive the token. "sell": pay the token, receive sats. */
export type Side = "buy" | "sell";

export interface QuoteRequest {
  tokenId: TokenId;
  side: Side;
  /** Base units of what is paid (sats on a buy, token base units on a sell). */
  amountIn: bigint;
  /** Max slippage against the quoted amount out, basis points. */
  maxSlippageBps: number;
  allowPartial: boolean;
}

export interface QuoteLeg {
  /** The pool, `<txid>.<vout>`. */
  poolOutpoint: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Share of the amount in, basis points (the legs sum to 10000). */
  shareBps: number;
  /** The pool's reserves before the leg. */
  reserves: { sats: bigint; tokens: bigint };
  validator: ValidatorRef;
}

export interface Quote {
  request: QuoteRequest;
  legs: QuoteLeg[];
  amountOut: bigint;
  /** The least amount out the swap accepts: amountOut less max slippage. */
  minAmountOut: bigint;
  /** Sats per whole token this swap pays (fees included). */
  effectivePrice: number;
  /** Sats per whole token before the swap. */
  marginalPrice: number;
  /** |effective − marginal| / marginal, basis points. */
  impactBps: number;
  /** The validator's fees applied to every leg. */
  fees: Fees;
}

export interface LegResult {
  poolOutpoint: string;
  status: "filled" | "failed";
  txid?: string;
  error?: string;
  /** 0.31.1: the leg was refused `pool_spent`, repriced against the pool's newest state and sent again. */
  repriced?: true;
}

export interface SwapResult {
  status: "filled" | "partial" | "failed";
  legs: LegResult[];
}

/** The validator's fees, basis points of the amount in. The LP accepts them; there is no fee input. */
export interface Fees {
  lpBps: number;
  validatorBps: number;
  /** The relay's commission (the pool's CommissionBps); 0: none. */
  commissionBps: number;
}

/**
 * `amm.pool.terms`'s refusal when no terms are set (0.15.0, David Case
 * 2026-10-23: terms are a runtime record root sets; unset, a market only).
 */
export const NO_VALIDATOR = "no validator here";
/** What the pages show in place of the terms when none are set. */
export const NO_TERMS_TEXT = "This exchange validates nothing: no terms are set.";

/** No terms are set on this skein (`amm.pool.terms` answered "no validator here"): a market only. */
export interface NoTerms {
  none: true;
}

/** Whether `t` is a validator's terms (not "none set"). */
export function hasTerms(t: ValidatorTerms | NoTerms | null | undefined): t is ValidatorTerms {
  return !!t && !("none" in t);
}

/** The validator a new position is deployed with, and its fees (read-only on the page). */
export interface ValidatorTerms {
  validator: ValidatorRef;
  /** "this exchange's" when the validator is this skein. */
  isThisExchange: boolean;
  fees: Fees;
}

/** One of the user's pools. A position is only deployed or closed (no add, no partial remove). */
export interface Position {
  /** The pool, `<txid>.<vout>`. */
  outpoint: string;
  tokenId: TokenId;
  sym: string;
  dec: number;
  icon?: string;
  sats: bigint;
  tokens: bigint;
  /** Fees the pool has earned the LP, when it can be told. */
  feesEarnedSats?: bigint;
  validator: ValidatorRef;
  /** The validator rescinded the pool (0.13.0): no swaps; the LP closes it. */
  rescinded?: boolean;
}

export interface DeployRequest {
  tokenId: TokenId;
  /** Token base units. */
  tokens: bigint;
  sats: bigint;
}

export interface DeployResult {
  /** The new pool, `<txid>.<vout>`. */
  outpoint: string;
  txid: string;
  /** What did not complete after the broadcast (the position row's filing, the page's own submit). */
  warnings?: string[];
}

export interface RecoverResult {
  /** The pool filed, `<txid>.<vout>` (its current output). */
  outpoint: string;
  sym: string;
  /** False when the wallet did not accept the filing. */
  filed: boolean;
}

export interface CloseRequest {
  outpoint: string;
}

export interface CloseResult {
  txid: string;
  /** Returned to the wallet. */
  sats: bigint;
  tokens: bigint;
}

/** One of the user's own 1Color tokens. */
export interface WalletToken {
  tokenId: TokenId;
  sym: string;
  dec: number;
  icon?: string;
  /** The wallet's balance: the sum of the token's held value outputs in `p color assets` (0.27.0; was the module's `p color balance`). */
  balance: bigint;
  /** How many wallet outputs hold it. */
  outputs: number;
  /** Held in the exchange's active swap basket (`amm-swap`): spent by swap legs, or moved back. */
  inSwaps: bigint;
  /** Sats staged in `amm-swap` for the token's swap legs (0.29.6): spent by swap legs, or moved back. */
  swapSats: number;
  /** Registered on this exchange. */
  onExchange: boolean;
}

/** A token seen on the discovery topic (`tm_color`). */
export interface DiscoveryToken {
  tokenId: TokenId;
  sym: string;
  dec: number;
  icon?: string;
  /** When discovery first saw it, ms. */
  seenAt?: number;
}

/** A token on this exchange's list (the swap instance's enable list), as Settings lists it. */
export interface RegisteredToken {
  tokenId: TokenId;
  sym: string;
  icon?: string;
  status: EnabledToken["status"];
}

export type { EnabledToken, Defaults, Discovery };

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
// The context: the instance and the connected wallet
// ---------------------------------------------------------------------------

type Signed = SignedFetch & AuthFetchLike;

interface ExchangeContext {
  /** The config instance's AMM base URL (src/lib/config.ts): the pages' own. */
  base: string;
  wallet: WalletInterface | null;
  /**
   * The wallet's BRC-104 client for an instance base (0.27.1: one session per instance — the swap
   * instance at `<origin>/amm` and each token instance at `<origin>/@<tokenId>/amm` hold their own
   * sessions; src/lib/skein.ts `authFetchPerInstance`).
   */
  signedFor: ((base: string) => Signed) | null;
  identityKey: string | null;
  /** The pending payouts' store (localStorage). */
  payouts: PendingPayoutStore;
}

const context: ExchangeContext = { base: AMM_OVERLAY, wallet: null, signedFor: null, identityKey: null, payouts: new PendingPayoutStore() };

/** Set what the functions below reach (the wallet and its client: `useSession`; a test: anything). */
export function setExchangeContext(c: Partial<ExchangeContext>): void {
  Object.assign(context, c);
}

function needWallet(): { wallet: WalletInterface; signedFor: (base: string) => Signed } {
  if (!context.wallet || !context.signedFor) throw new Error("Connect a wallet first");
  return { wallet: context.wallet, signedFor: context.signedFor };
}

/** The connected wallet's client for `base`'s instance; null with no wallet (reads then go unsigned). */
function signed(base: string): Signed | null {
  return context.signedFor ? context.signedFor(base) : null;
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
/** Calls `fn` after any action changes data (swap, deploy, close, register…). Returns the unsubscribe. */
export function onDataChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The app's name (its boxes are `<app>/<box>`). */
function app(): string {
  return appName(context.base) ?? "amm";
}

/** The config instance's enable list (0.17.0, `GET <config>/tokens`), every status. */
async function enabledList(): Promise<EnabledToken[]> {
  return (await readTokens(context.base)).map((t) => {
    const id = parseOutpoint(t.tokenId.replace("_", "."));
    return id ? { ...t, tokenId: tokenIdText(id) } : t;
  });
}

/** The tokens up on this exchange: enabled on the swap instance's list. */
async function enabledTokens(): Promise<EnabledToken[]> {
  return (await enabledList()).filter((t) => t.status === "enabled");
}

/**
 * A token's own instance's AMM base: `<origin>/@<tokenId>/amm` (Open Exchange: the host makes the
 * instance of every enabled token there). Refused for a token that is not enabled here.
 */
export async function tokenBaseOf(tokenId: TokenId): Promise<string> {
  const t = (await enabledTokens()).find((x) => x.tokenId === tokenId);
  if (!t) throw new Error(`${tokenId.slice(0, 8)}… is not enabled on this exchange`);
  return tokenBase(t.tokenId, context.base);
}

/** The token list's metadata by token id (0.17.0: the config instance's list); empty when the read fails. */
async function tokenMeta(): Promise<Map<string, ListedToken>> {
  const m = new Map<string, ListedToken>();
  try {
    for (const t of await enabledList()) m.set(t.tokenId, { tokenId: t.tokenId, topic: t.topic, sym: t.sym, dec: t.dec, ...(t.icon ? { icon: t.icon } : {}) });
  } catch {
    /* no metadata: ids only */
  }
  return m;
}

/**
 * The host root (0.20.0): the pages' origin, where the host routes a bare `/lookup` by its service to
 * the instance that declares it (skein#137) — `ls_color` to the discovery instance.
 */
function hostRoot(): string {
  return new URL(context.base).origin;
}

/** A token's symbol, decimals and icon, read off its deploy output. */
export interface DeployMeta {
  sym?: string;
  dec?: number;
  icon?: string;
}

/** The metadata of the deploy output `vout` of an Atomic BEEF's subject; null when that output is no 1Color deploy. */
function deployMetaOf(beef: number[], vout: number): DeployMeta | null {
  const tx = Transaction.fromAtomicBEEF(beef);
  const t = decodeTokenRow({ outpoint: `${tx.id("hex")}.${vout}`, lockingScript: tx.outputs[vout]?.lockingScript.toHex() });
  if (!t || t.role !== "deploy") return null;
  const icon = deployIcon(t)?.image;
  return { ...(t.metadata?.sym !== undefined ? { sym: t.metadata.sym } : {}), ...(t.metadata?.dec !== undefined ? { dec: t.metadata.dec } : {}), ...(icon ? { icon: imageDataUrl(icon) } : {}) };
}

/**
 * A token's deploy from discovery (0.20.1: the discovery lookup `ls_color`, BRC-207's
 * `color-admission` of the deploy's outpoint over `tm_color` — the token id `<txid>_<vout>` IS it
 * (`deployQuery`) — POSTed to the HOST ROOT, plain `fetch`): the deploy output's Atomic BEEF and its
 * metadata; null when the lookup has none or fails (discovery off).
 */
async function discoveryDeploy(tokenId: string): Promise<{ beef: number[]; meta: DeployMeta } | null> {
  try {
    const { service, query } = deployQuery(tokenId);
    const out = parseOutputList(await lookup(null, hostRoot(), service, query))[0];
    if (!out) return null;
    const meta = deployMetaOf(out.beef, out.outputIndex);
    return meta ? { beef: out.beef, meta } : null;
  } catch {
    return null;
  }
}

/** A token's deploy as `deployBeef` finds it: its Atomic BEEF, its metadata, and where it came from. */
export interface DeployFound {
  beef: number[];
  meta: DeployMeta;
  from: "wallet" | "discovery";
}

/**
 * A token's deploy (Settings "Enable a token", 2026-10-31): with a wallet, the deploy output in its
 * module basket (`walletDeployBeef`) when it holds it; else the HOST ROOT discovery lookup
 * (`discoveryDeploy`). Refused when neither has it: "no deploy for <id>: not on discovery and not
 * in this wallet". With no wallet, discovery only (`deployMeta`).
 */
export async function deployBeef(tokenId: TokenId, wallet?: WalletInterface | null): Promise<DeployFound> {
  const op = parseOutpoint(sdkTokenId(tokenId).replace("_", "."));
  if (!op) throw new Error(`not a token id: ${tokenId}`);
  const canonical = tokenIdText(op);
  if (wallet) {
    const beef = await walletDeployBeef(wallet, canonical);
    if (beef) return { beef, meta: deployMetaOf(beef, op.vout) ?? {}, from: "wallet" };
  }
  const found = await discoveryDeploy(canonical);
  if (found) return { ...found, from: "discovery" };
  throw new Error(`no deploy for ${canonical}: not on discovery and not in this wallet`);
}

/**
 * A token's metadata from its deploy (`deployBeef` with no wallet: the discovery lookup at the
 * host root), for a token the list does not carry; null when the lookup has none. Until 0.19.0 it
 * asked `ls_color_deploys {tokenId}` at the token's own instance, which a token not enabled here
 * does not have.
 */
async function deployMeta(tokenId: string): Promise<DeployMeta | null> {
  if (!parseTokenId(tokenId)) return null;
  try {
    return (await deployBeef(tokenId)).meta;
  } catch {
    return null;
  }
}

function symOf(meta: Map<string, ListedToken>, tokenId: string): string {
  return meta.get(tokenId)?.sym ?? tokenId.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Session and root
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

/**
 * Whether the exchange is claimed, its admin, and swap's identity (0.28.0: swap is born owned by the
 * host's key, so `/.well-known/skein`'s `claimed` is always true; the claim is the swap app's own record,
 * `GET <base>/admin` → `{claimant?, since?}`). `identity` from `/.well-known/skein` (the claim's recipient).
 * A swap with no `/admin` read (pages older than open-exchange 0.5.0): `claimed` as `/.well-known/skein` says.
 */
export interface ClaimStatus {
  claimed: boolean;
  identity: string;
  claimant?: string;
}

/** swap's card (`GET <its origin>/.well-known/skein`) and its claim (`GET <base>/admin`), both unsigned. */
export async function claimStatus(): Promise<ClaimStatus> {
  const url = `${instanceBase(context.base)}/.well-known/skein`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const v = (await res.json()) as { claimed?: unknown; identity?: unknown };
  const identity = String(v.identity ?? "").toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(identity)) throw new Error(`GET ${url}: no identity`);
  const a = await fetch(`${context.base}/admin`, { headers: { accept: "application/json" } }).catch(() => undefined);
  if (!a?.ok) return { claimed: v.claimed === true, identity };
  const adm = (await a.json().catch(() => ({}))) as { claimant?: unknown };
  const claimant = typeof adm.claimant === "string" && /^0[23][0-9a-f]{64}$/i.test(adm.claimant) ? adm.claimant.toLowerCase() : undefined;
  return claimant ? { claimed: true, identity, claimant } : { claimed: false, identity };
}

/**
 * Whether this identity may configure the exchange (0.28.0; the name kept from 0.26.0): it is swap's
 * claimant (`GET <base>/admin`, granted amm.admin by the host), or it holds root on swap (the host's
 * `GET <host root>/skeins?key=<identityKey>` names swap's identity: the host's key, or a key the host
 * granted root, as on the rack). False when the reads fail.
 */
export async function isRoot(identityKey: string | null): Promise<boolean> {
  if (!identityKey) return false;
  try {
    const { identity, claimant } = await claimStatus();
    if (claimant && claimant === identityKey.toLowerCase()) return true;
    const res = await fetch(`${hostRoot()}/skeins?key=${encodeURIComponent(identityKey)}`, { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const held = (await res.json()) as Array<{ identity?: string }>;
    return Array.isArray(held) && held.some((x) => String(x.identity ?? "").toLowerCase() === identity);
  } catch {
    return false;
  }
}

/**
 * Claims the exchange with the connected wallet (0.28.0): the wallet's message `{fn: "claim"}` in the
 * swap app's box `amm/claim` to swap's identity; the first claim is recorded (swap's `/admin` names
 * its sender) and the host grants it the role amm.admin; a later one is refused. Then reads `isRoot`
 * again (a few reads until it shows) and tells the pages.
 */
export async function claimExchange(): Promise<boolean> {
  const { signedFor } = needWallet();
  const { identity } = await claimStatus();
  await sendMessage(signedFor(context.base), context.base, identity, `${app()}/claim`, { fn: "claim" });
  let root = false;
  for (let i = 0; i < 20 && !root; i++) {
    root = await isRoot(context.identityKey);
    if (!root) await new Promise((r) => setTimeout(r, 250));
  }
  emit();
  if (!root) throw new Error("The claim was sent, but this wallet is not the admin: someone else may have claimed this exchange first.");
  return root;
}

// ---------------------------------------------------------------------------
// Landing: hosted tokens and live prices
// ---------------------------------------------------------------------------

/** A token topic with its own instance's AMM base (0.17.0). */
type HostedTopic = TokenTopic & { base: string };

/** The token topics up on this exchange (0.17.0: enabled on the config instance's list, each with its instance's base). */
async function hostedTopics(): Promise<HostedTopic[]> {
  const out: HostedTopic[] = [];
  for (const t of await enabledTokens()) {
    const topic = parseTokenTopic(t.topic);
    if (topic) out.push({ ...topic, base: tokenBase(t.tokenId, context.base) });
  }
  return out;
}

/** One token instance's `ls_amm_<assetId>` beats and its token topic's: their live senders (0.17.0: one read per token instance; 0.21.0: the per-asset name). */
async function liveFor(t: HostedTopic): Promise<{ beats: Beat[]; live: Set<string> }> {
  const [beats, tokenBeats] = await Promise.all([
    readBeats(t.base, `${ammLookupOf(t.tokenId)}-live`).catch(() => [] as Beat[]),
    readBeats(t.base, `${t.topic}-live`).catch(() => [] as Beat[]),
  ]);
  return { beats, live: liveSenders(beats, tokenBeats) };
}

/** This skein's own listing of a token, its live pools summed: the fallback when no beat reports the token. */
async function localPrice(t: HostedTopic, dec: number): Promise<TokenPrice> {
  const [pools, live] = await Promise.all([queryPools(signed(t.base), t.base, t.tokenId), fetchLive(t.base, t.topic)]);
  const usable = pools.filter((p) => validatorStatus(p.validatorIdentityKey, live).live);
  const sats = usable.reduce((a, p) => a + p.bsvReserve, 0n);
  const tokens = usable.reduce((a, p) => a + p.tokenReserve, 0n);
  return {
    tokenId: t.tokenId,
    marginalPrice: tokens > 0n ? Number(sats) / (Number(tokens) / 10 ** dec) : null,
    depth: depthOf(sats),
    pools: usable.length,
    reserves: { sats, tokens },
    validators: [...new Set(usable.map((p) => p.validatorIdentityKey))],
  };
}

/** Every hosted token's price: its instance's beats first, its instance's listing when no beat reports it. */
async function pricesNow(topics: HostedTopic[], meta: Map<string, ListedToken>): Promise<Map<string, TokenPrice>> {
  const out = new Map<string, TokenPrice>();
  await Promise.all(
    topics.map(async (t) => {
      const { beats, live } = await liveFor(t);
      const b = pricesFromBeats(beats, live, (id) => meta.get(id)?.dec ?? 0).get(t.tokenId);
      if (b && b.validators.length > 0) return out.set(t.tokenId, b);
      try {
        out.set(t.tokenId, await localPrice(t, meta.get(t.tokenId)?.dec ?? 0));
      } catch {
        out.set(t.tokenId, { tokenId: t.tokenId, marginalPrice: null, depth: null, pools: 0, reserves: { sats: 0n, tokens: 0n }, validators: [] });
      }
    }),
  );
  return out;
}

/** The tokens this overlay hosts (registered here: 1Color tokens at output 0), each priced. No wallet needed. */
export async function hostedTokens(): Promise<HostedToken[]> {
  const [topics, meta] = await Promise.all([hostedTopics(), tokenMeta()]);
  const native = topics.filter((t) => t.kind === "native");
  const prices = await pricesNow(native, meta);
  return native.map((t) => {
    const m = meta.get(t.tokenId);
    const p = prices.get(t.tokenId)!;
    return {
      tokenId: t.tokenId,
      sym: m?.sym ?? t.tokenId.slice(0, 8),
      dec: m?.dec ?? 0,
      ...(m?.icon ? { icon: m.icon } : {}),
      marginalPrice: p.marginalPrice,
      depth: p.depth,
      pools: p.pools,
      reserves: p.reserves,
    };
  });
}

/** Live prices: polls the beats every `REFRESH_MS` and calls `onUpdate` per registered token. Returns the unsubscribe. */
export function subscribePrices(onUpdate: (u: PriceUpdate) => void): () => void {
  let stopped = false;
  const tick = async () => {
    try {
      const [topics, meta] = await Promise.all([hostedTopics(), tokenMeta()]);
      const prices = await pricesNow(topics.filter((t) => t.kind === "native"), meta);
      if (stopped) return;
      for (const p of prices.values()) onUpdate({ tokenId: p.tokenId, marginalPrice: p.marginalPrice, depth: p.depth, pools: p.pools, reserves: p.reserves, at: Date.now() });
    } catch {
      /* the next tick */
    }
  };
  const timer = setInterval(() => void tick(), REFRESH_MS);
  const off = onDataChange(() => void tick());
  return () => {
    stopped = true;
    clearInterval(timer);
    off();
  };
}

/** The hosted tokens with live prices merged in: `hostedTokens()` once, then `subscribePrices()`. */
export function useHostedTokens(): { tokens: HostedToken[] | null; error: string | null; live: boolean; reload: () => void } {
  const r = useData(hostedTokens, []);
  const [prices, setPrices] = useState<Map<TokenId, PriceUpdate>>(new Map());
  const [live, setLive] = useState(false);
  useEffect(() => {
    setLive(true);
    const off = subscribePrices((u) => setPrices((m) => new Map(m).set(u.tokenId, u)));
    return () => {
      setLive(false);
      off();
    };
  }, []);
  const tokens = r.data?.map((t) => {
    const u = prices.get(t.tokenId);
    return u ? { ...t, marginalPrice: u.marginalPrice, depth: u.depth, pools: u.pools, reserves: u.reserves } : t;
  }) ?? null;
  return { tokens, error: r.error, live, reload: r.reload };
}

/** A token's listed pools on this skein, each with its validator's liveness. */
export async function tokenPools(tokenId: TokenId): Promise<PoolView[]> {
  const topic = `tm_color_${sdkTokenId(tokenId)}`;
  const base = await tokenBaseOf(tokenId);
  const [pools, live] = await Promise.all([queryPools(signed(base), base, tokenId), fetchLive(base, topic)]);
  return pools.map((p) => ({
    outpoint: outpointText(p.outpoint),
    tokenId,
    sats: p.bsvReserve,
    tokens: p.tokenReserve,
    validator: { identityKey: p.validatorIdentityKey, live: validatorStatus(p.validatorIdentityKey, live).live },
  }));
}

/**
 * A token's market minimum commission (0.16.0, bps; 0.17.0: the token instance's own): `amm.swap.terms`'s
 * `minCommissionBps`, the record root sets there (`amm/market`; else its initial value, the
 * config's default at its create; unset, 0). Null
 * when it cannot be read here: no wallet is connected (`amm.swap.terms` is a
 * signed call), and then no pool is hidden.
 */
export async function marketMinimum(tokenId: TokenId): Promise<number | null> {
  if (!context.signedFor) return null;
  const base = await tokenBaseOf(tokenId);
  return (await swapTerms(context.signedFor(base), base)).minCommissionBps;
}

/**
 * The pools this market lists (0.16.0, David Case 2026-10-24): those whose
 * commission is at or above `min` (null: unknown, every pool), and how many
 * it hides. A listing preference of this market, not a rule: the relay
 * refuses nothing by it.
 */
export function atMarketMinimum<T extends Pick<PoolState, "commissionBps">>(pools: T[], min: number | null): { listed: T[]; hidden: number } {
  if (min === null || min <= 0) return { listed: pools, hidden: 0 };
  const listed = pools.filter((p) => p.commissionBps >= BigInt(min));
  return { listed, hidden: pools.length - listed.length };
}

/** "N pools below this market's minimum commission" (0.16.0). */
export function belowMinimumText(n: number): string {
  return `${n} ${n === 1 ? "pool" : "pools"} below this market's minimum commission`;
}

/** The pools the Swap page lists for a token (0.16.0): `tokenPools` at or above this market's minimum commission, and how many are hidden. */
export async function swapPools(tokenId: TokenId): Promise<{ pools: PoolView[]; hidden: number }> {
  const topic = `tm_color_${sdkTokenId(tokenId)}`;
  const base = await tokenBaseOf(tokenId);
  const [pools, live, min] = await Promise.all([queryPools(signed(base), base, tokenId), fetchLive(base, topic), marketMinimum(tokenId)]);
  const { listed, hidden } = atMarketMinimum(pools, min);
  return {
    pools: listed.map((p) => ({
      outpoint: outpointText(p.outpoint),
      tokenId,
      sats: p.bsvReserve,
      tokens: p.tokenReserve,
      validator: { identityKey: p.validatorIdentityKey, live: validatorStatus(p.validatorIdentityKey, live).live },
    })),
    hidden,
  };
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

/** What a quote was planned from: kept for its execution. */
interface Planned {
  plan: Plan;
  pools: PoolState[];
  live: LiveAnswer;
  dec: number;
  sym: string;
}
const planned = new WeakMap<Quote, Planned>();

/** A quote for one token: the matching engine's plan over this skein's listed pools whose validator is live and (0.16.0) whose commission is at or above this market's minimum. */
export async function quoteSwap(req: QuoteRequest): Promise<Quote> {
  if (req.amountIn <= 0n) throw new Error("Enter an amount");
  const topic = `tm_color_${sdkTokenId(req.tokenId)}`;
  const base = await tokenBaseOf(req.tokenId);
  const [all, live, meta, min] = await Promise.all([queryPools(signed(base), base, req.tokenId), fetchLive(base, topic), tokenMeta(), marketMinimum(req.tokenId)]);
  const { listed: pools, hidden } = atMarketMinimum(all, min);
  if (pools.length === 0 && hidden > 0) throw new Error(`No pool to swap against: ${belowMinimumText(hidden)}`);
  const dec = meta.get(req.tokenId)?.dec ?? 0;
  const buy = req.side === "buy";
  const r = buildPlanRequest(
    req.tokenId,
    { direction: buy ? "bsvToToken" : "tokenToBsv", amount: formatAmount(req.amountIn, buy ? 0 : dec), slippageBps: String(req.maxSlippageBps), allowPartial: req.allowPartial },
    pools,
    live,
    dec,
  );
  if (!r.ok) throw new Error(r.error);
  const { plan, view } = planQuote(r.request, live, dec);
  const used = view.legs.filter((l) => l.amountIn > 0n);
  if (used.length === 0 || view.totalOut === 0n) throw new Error("The amount is too small to receive anything");
  const usable = pools.filter((p) => validatorStatus(p.validatorIdentityKey, live).live);
  const sumSats = usable.reduce((a, p) => a + p.bsvReserve, 0n);
  const sumTokens = usable.reduce((a, p) => a + p.tokenReserve, 0n);
  const marginal = sumTokens > 0n ? Number(sumSats) / (Number(sumTokens) / 10 ** dec) : 0;
  const totalIn = used.reduce((a, l) => a + l.amountIn, 0n);
  const sats = buy ? totalIn : view.totalOut;
  const tokens = buy ? view.totalOut : totalIn;
  const effective = Number(sats) / (Number(tokens) / 10 ** dec);
  const first = used[0]!.pool;
  const q: Quote = {
    request: req,
    legs: used.map((l) => ({
      poolOutpoint: outpointText(l.outpoint),
      amountIn: l.amountIn,
      amountOut: l.amountOut,
      shareBps: Number((l.amountIn * 10_000n) / req.amountIn),
      reserves: { sats: l.pool.bsvReserve, tokens: l.pool.tokenReserve },
      validator: { identityKey: l.pool.validatorIdentityKey, live: l.validator.live },
    })),
    amountOut: view.totalOut,
    minAmountOut: view.minAmountOut,
    effectivePrice: effective,
    marginalPrice: marginal,
    impactBps: marginal ? Math.round((Math.abs(effective - marginal) / marginal) * 10_000) : 0,
    fees: { lpBps: Number(first.liquidityFeeBps), validatorBps: Number(first.validationFeeBps), commissionBps: Number(first.commissionBps ?? 0n) },
  };
  planned.set(q, { plan, pools, live, dec, sym: meta.get(req.tokenId)?.sym ?? "token" });
  return q;
}

/**
 * Runs a quoted swap with the connected wallet: one transaction per leg,
 * relayed to the leg's validator (`amm.swap.submit`), each payout kept as a
 * pending payout until the wallet takes it in. A planned pool gone from a
 * fresh lookup stops the swap unless partial fills are allowed.
 */
export async function executeSwap(quote: Quote): Promise<SwapResult> {
  const { wallet, signedFor } = needWallet();
  const p = planned.get(quote);
  if (!p) throw new Error("Quote again: this quote was not planned here");
  const tokenId = quote.request.tokenId;
  const base = await tokenBaseOf(tokenId);
  const af = signedFor(base);
  const fresh = await queryPools(af, base, tokenId);
  const gone = goneFromLookup(p.plan, fresh);
  if (gone.length > 0 && !quote.request.allowPartial) throw new Error(`${gone.map(outpointText).join(", ")} ${gone.length === 1 ? "was" : "were"} spent since the quote: quote again`);
  const terms = await swapTerms(af, base);
  const direction = quote.request.side === "buy" ? "bsvToToken" : "tokenToBsv";
  const legs: LegResult[] = [];
  const running: Promise<void>[] = [];
  // The legs that can run: not spent since the quote, their validator live.
  const runnable: { leg: Plan["legs"][number]; result: LegResult; pool: PoolState; peerId: string }[] = [];
  for (const leg of p.plan.legs) {
    const poolOutpoint = outpointText(leg.outpoint);
    if (gone.includes(leg.outpoint)) {
      legs.push({ poolOutpoint, status: "failed", error: "spent since the quote" });
      continue;
    }
    const pool = p.pools.find((x) => x.outpoint === leg.outpoint)!;
    const validator = validatorStatus(pool.validatorIdentityKey, p.live);
    if (!validator.live || !validator.peerId) {
      legs.push({ poolOutpoint, status: "failed", error: "the pool's validator is no longer live" });
      continue;
    }
    const result: LegResult = { poolOutpoint, status: "failed" };
    legs.push(result);
    runnable.push({ leg, result, pool, peerId: validator.peerId });
  }
  // 0.29.0: every leg spends only `amm-swap` outputs — tokens in, outputs carrying exactly its
  // amount in (0.12.0); and one sats output of exactly the leg's sats. What the basket does not
  // cover is staged by ONE send (tokens missing: the module send, the sats with it; else a plain
  // sats send), then each leg is built from the basket.
  const tokensIn = direction === "tokenToBsv";
  let tokenCandidates = tokensIn && runnable.length > 0 ? await swapHoldings(wallet, tokenId) : [];
  let satsCandidates = runnable.length > 0 ? await swapSatsHoldings(wallet) : [];
  const staged: { r: (typeof runnable)[number]; poolOutput: Awaited<ReturnType<typeof lookupPoolOutput>>; planned: PlannedLeg; tokens: TokenInput[] | null; sats: SatsInput | null }[] = [];
  for (const r of runnable) {
    try {
      const poolOutput = await lookupPoolOutput(af, base, tokenId, r.leg.outpoint);
      let tokens: TokenInput[] | null = null;
      if (tokensIn) {
        tokens = selectExactTokenInputs(tokenCandidates, r.leg.amountIn);
        if (tokens) tokenCandidates = tokenCandidates.filter((c) => !tokens!.includes(c));
      }
      // A leg whose tokens are still to be staged gets one output of 1 sat (sendToSwapBasket).
      const planned = await planSwapLeg({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg: r.leg, pool: r.pool, poolOutput, commissionPkh: terms.commissionPkh, ...(tokensIn ? { tokenInputs: tokens ?? [{ satoshis: 1, amount: r.leg.amountIn }] } : {}), satsPerKb: FEE_RATE_SATS_PER_KB });
      const sats = selectExactSatsInput(satsCandidates, planned.funding.satoshis);
      if (sats) satsCandidates = satsCandidates.filter((c) => c !== sats);
      staged.push({ r, poolOutput, planned, tokens, sats });
    } catch (e) {
      r.result.error = errText(e);
    }
  }
  const shortTokens = staged.filter((x) => tokensIn && !x.tokens);
  const shortSats = staged.filter((x) => !x.sats);
  let sent: number[] | undefined;
  if (shortTokens.length > 0) {
    const s = await sendToSwapBasket(wallet, base, tokenId, { tokens: shortTokens.map((x) => ({ amount: x.r.leg.amountIn, pool: x.r.leg.outpoint })), sats: shortSats.map((x) => ({ satoshis: x.planned.funding.satoshis, pool: x.r.leg.outpoint })) }, { sym: p.sym });
    sent = s.tx;
    const why = s.errors.length ? ` (${s.errors.join("; ")})` : "";
    shortTokens.forEach((x, n) => {
      const h = s.holdings[n];
      if (h) x.tokens = [h];
      else x.r.result.error = `the swap basket send has no output for this leg${why}`;
    });
    shortSats.forEach((x, n) => {
      const h = s.sats[n];
      if (h) x.sats = h;
      else x.r.result.error ??= `the swap basket send has no sats output for this leg${why}`;
    });
  } else if (shortSats.length > 0) {
    const s = await sendSatsToSwapBasket(wallet, tokenId, shortSats.map((x) => ({ satoshis: x.planned.funding.satoshis, pool: x.r.leg.outpoint })), { sym: p.sym });
    sent = s.tx;
    const why = s.errors.length ? ` (${s.errors.join("; ")})` : "";
    shortSats.forEach((x, n) => {
      const h = s.sats[n];
      if (h) x.sats = h;
      else x.r.result.error = `the swap basket send has no sats output for this leg${why}`;
    });
  }
  const holdingBeef = staged.length > 0 ? await swapHoldingBeef(wallet, sent) : undefined;
  // The legs sent to the relay: their expected amountOut, and whether their outcome is known.
  const tracks: { result: LegResult; amountOut: bigint; done: boolean }[] = [];
  /** Saves the leg's pending payouts, relays it, and keeps or drops the payouts by the outcome (as before 0.31.1). */
  const relayLeg = async (prepared: Awaited<ReturnType<typeof prepareSwap>>, peerId: string): Promise<SwapOutcome> => {
    const pending = pendingSwapPayouts(prepared, tokenId, base);
    for (const x of pending) context.payouts.save(x);
    const o = await relaySwap({ wallet, authFetch: af, base }, prepared, peerId).catch((e): SwapOutcome => ({ status: "unknown", reason: errText(e) }));
    for (const x of pending) {
      if (o.status === "accepted") {
        if (o.completed.internalized) context.payouts.remove(x.id);
        else context.payouts.finalize(x.id, o.txid);
      } else if (o.status !== "unknown") context.payouts.remove(x.id);
    }
    return o;
  };
  /**
   * 0.31.1: one retry of a leg refused `pool_spent` — re-quoted alone against the validator's
   * newest pool state (the engine's single-pool math, same side and amountIn), sent only while
   * the order's bound holds (filled legs + this one + the legs still out ≥ the plan's
   * resolvedMinAmountOut), rebuilt on the new pool output with the same staged rows. Null: the
   * leg failed here (its error set); else the second relay's outcome.
   */
  const retryLeg = async (x: { leg: Plan["legs"][number]; track: (typeof tracks)[number]; was: PoolState; pool: PoolState; peerId: string; tokens: TokenInput[] | null; sats: SatsInput }): Promise<SwapOutcome | null> => {
    const { track, pool } = x;
    const result = track.result;
    const priced = computeSwap(pool, direction, x.leg.amountIn);
    const amountOut = priced?.amountOut ?? 0n;
    const others = tracks.filter((t) => t !== track).reduce((a, t) => a + (t.result.status === "filled" || !t.done ? t.amountOut : 0n), 0n);
    if (!priced || others + amountOut < p.plan.resolvedMinAmountOut) {
      result.error = `repriced below your minimum: ${formatAmount(amountOut, direction === "bsvToToken" ? p.dec : 0)} for this leg`;
      return null;
    }
    let peerId = x.peerId;
    if (pool.validatorIdentityKey !== x.was.validatorIdentityKey) {
      const v = validatorStatus(pool.validatorIdentityKey, p.live);
      if (!v.live || !v.peerId) {
        result.error = "the pool's validator changed";
        return null;
      }
      peerId = v.peerId;
    }
    const leg: Plan["legs"][number] = { outpoint: pool.outpoint, amountIn: x.leg.amountIn, ...priced };
    try {
      const poolOutput = await lookupPoolOutput(af, base, tokenId, pool.outpoint);
      const common: PlanLegInput & { tokenInputs?: TokenInput[] } = { wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh: terms.commissionPkh, ...(x.tokens ? { tokenInputs: x.tokens } : {}), satsPerKb: FEE_RATE_SATS_PER_KB };
      const planned = await planSwapLeg(common);
      const prepared = await prepareSwap({ ...common, satsInput: x.sats, ...(holdingBeef ? { holdingBeef } : {}), planned });
      track.amountOut = amountOut;
      result.repriced = true;
      return await relayLeg(prepared, peerId);
    } catch (e) {
      result.error = errText(e);
      return null;
    }
  };
  for (const { r, poolOutput, planned, tokens, sats } of staged) {
    const { leg, result, pool, peerId } = r;
    if (tokensIn && !tokens) {
      result.error ??= `no ${p.sym} in the swap basket for exactly ${formatAmount(leg.amountIn, p.dec)}`;
      continue;
    }
    if (!sats) {
      result.error ??= `no sats in the swap basket for this leg`;
      continue;
    }
    try {
      const prepared = await prepareSwap({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh: terms.commissionPkh, ...(tokens ? { tokenInputs: tokens } : {}), satsInput: sats, ...(holdingBeef ? { holdingBeef } : {}), planned, satsPerKb: FEE_RATE_SATS_PER_KB });
      const track = { result, amountOut: leg.amountOut, done: false };
      tracks.push(track);
      running.push(
        (async () => {
          let o = await relayLeg(prepared, peerId);
          // 0.31.1: refused `pool_spent` with the pool's newest state attached → repriced against
          // that state and sent once more (the staged `amm-swap` rows are still there).
          if (o.status === "refused" && o.reason.startsWith("pool_spent") && o.pool) {
            const again = await retryLeg({ leg, track, was: pool, pool: o.pool, peerId, tokens, sats });
            if (!again) {
              track.done = true;
              return;
            }
            o = again;
          }
          track.done = true;
          if (o.status === "accepted") {
            result.status = "filled";
            result.txid = o.txid;
          } else result.error = o.status === "refused" ? `refused: ${o.reason}` : o.status === "unknown" ? `no answer yet: ${o.reason}` : o.status;
        })(),
      );
    } catch (e) {
      result.error = errText(e);
    }
  }
  await Promise.all(running);
  emit();
  const filled = legs.filter((l) => l.status === "filled").length;
  return { status: filled === legs.length && legs.length > 0 ? "filled" : filled === 0 ? "failed" : "partial", legs };
}

/** The connected wallet's spendable sats (its default basket). */
export async function walletSats(): Promise<bigint> {
  const { wallet } = needWallet();
  const r = await wallet.listOutputs({ basket: "default", limit: 10_000 });
  return r.outputs.filter((o) => o.spendable !== false).reduce((a, o) => a + BigInt(o.satoshis), 0n);
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

/** The positions last loaded, by the pool's current outpoint (`<txid>.<vout>`): what `closePosition` closes. */
const loaded = new Map<string, LoadedPosition>();

/** The connected wallet's open positions: its pool rows (`amm-pools`, and 0.28.0 its deploy history's, spent ones too) read from the chain state (src/lp/positions.ts). */
export async function myPositions(): Promise<Position[]> {
  const { wallet, signedFor } = needWallet();
  const [poolRows, history, meta] = await Promise.all([basketRows(wallet, POOLS_BASKET), historyPoolRows(wallet), tokenMeta()]);
  const rows = positionRowsOf(mergePoolRows(history, poolRows));
  const out: Position[] = [];
  loaded.clear();
  const lives = new Map<string, Promise<LiveAnswer | null>>();
  for (const row of rows) {
    let pos: LoadedPosition;
    let base: string;
    try {
      base = await tokenBaseOf(row.tokenId);
      pos = await loadPosition(signedFor(base), base, row);
    } catch {
      continue;
    }
    if (!pos.current || !pos.pool || pos.sats === undefined) continue;
    if (loaded.has(pos.current)) continue; // two rows followed to the same pool (a filed row and a history row)
    loaded.set(pos.current, pos);
    const topic = `tm_color_${sdkTokenId(row.tokenId)}`;
    if (!lives.has(topic)) lives.set(topic, fetchLive(base, topic).catch(() => null));
    const live = await lives.get(topic)!;
    const m = meta.get(row.tokenId);
    const identity = pos.pool.state.validatorIdentity;
    out.push({
      outpoint: pos.current,
      tokenId: row.tokenId,
      sym: m?.sym ?? row.sym ?? row.tokenId.slice(0, 8),
      dec: m?.dec ?? row.dec ?? 0,
      ...(m?.icon ? { icon: m.icon } : {}),
      sats: pos.sats,
      tokens: pos.pool.state.tokenReserve,
      validator: { identityKey: identity, live: live ? validatorStatus(identity, live).live : false },
      ...(PoolTemplate.rescinded(pos.pool) ? { rescinded: true } : {}),
    });
  }
  return out;
}

interface RawTerms {
  validator: string;
  peerId?: string;
  fees: Fees;
}

/** A fee `amm.pool.terms` answered (0.15.0: no defaults; the record carries all three). */
function fee(x: unknown, name: string): number {
  const n = Number(x);
  if (x === undefined || x === null || !Number.isInteger(n)) throw new Error(`amm.pool.terms: no ${name}`);
  return n;
}

/** `amm.pool.terms` of a token's instance (0.17.0): its validator, its peer ID and its terms (an error "no validator here" when none are set). */
async function rawTerms(tokenId: TokenId): Promise<RawTerms> {
  const { signedFor } = needWallet();
  const base = await tokenBaseOf(tokenId);
  const t = (await callApp(signedFor(base), base, "amm.pool.terms", {})) as Record<string, unknown>;
  const bytes = readBytes(t.validator);
  const hex = bytes ? Utils.toHex(bytes) : "";
  if (!/^[0-9a-f]{66}$/.test(hex)) throw new Error("amm.pool.terms: no validator identity");
  return {
    validator: hex,
    ...(typeof t.peerId === "string" ? { peerId: t.peerId } : {}),
    fees: { lpBps: fee(t.lpFeeBps, "lpFeeBps"), validatorBps: fee(t.validatorFeeBps, "validatorFeeBps"), commissionBps: fee(t.commissionBps, "commissionBps") },
  };
}

/**
 * The validator a new position is deployed with (this skein), and its fees (read-only: the LP
 * accepts them); `{none: true}` when no terms are set (0.15.0: `amm.pool.terms` answers "no
 * validator here").
 */
export async function validatorTerms(tokenId: TokenId): Promise<ValidatorTerms | NoTerms> {
  let t: RawTerms;
  try {
    t = await rawTerms(tokenId);
  } catch (e) {
    if (e instanceof RelayError && e.message.endsWith(NO_VALIDATOR)) return { none: true };
    throw e;
  }
  return { validator: { identityKey: t.validator, live: Boolean(t.peerId) }, isThisExchange: true, fees: t.fees };
}

/**
 * An instance's identity (hex, 0.15.0): the key its signed answers carry
 * (`x-bsv-auth-identity-key`), as skein-1color's tokens page reads it
 * (web/src/tokens/instance.ts `identity`). A token instance's (`base` a token
 * base) off a signed `amm.swap.terms`, which every token instance answers,
 * validator or market only; the config instance's (0.17.0, no `base`) off a
 * signed read of its token list. The recipient of root's messages.
 */
export async function instanceIdentity(base?: string): Promise<string> {
  const { signedFor } = needWallet();
  const af = signedFor(base ?? context.base);
  const res = base
    ? await af.fetch(callUrl(base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fn: SWAP_TERMS_FN, args: {} }),
      })
    : await af.fetch(`${context.base}/tokens`, { method: "GET" });
  const key = (res.headers.get("x-bsv-auth-identity-key") ?? "").toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(key)) throw new Error("the skein's answer carries no identity key (x-bsv-auth-identity-key)");
  return key;
}

/**
 * Deploys a new position (src/lp/poolDeploy.ts, 0.13.0): this skein's
 * validator affirms the proposed pool at its terms (`amm.pool.affirm`: its
 * key, its nonce, its signature, written into the pool's state), then the
 * wallet's BRC-207 module selects the token inputs, builds, signs and
 * broadcasts the deploy in one createAction; the pool output is filed as a
 * position row (`amm-pools`).
 */
export async function deployPosition(req: DeployRequest): Promise<DeployResult> {
  const { wallet, signedFor } = needWallet();
  if (req.tokens <= 0n || req.sats <= 0n) throw new Error("Both amounts must be more than 0");
  const [terms, held, meta, base] = await Promise.all([rawTerms(req.tokenId), heldOutputs(wallet), tokenMeta(), tokenBaseOf(req.tokenId)]);
  const m = meta.get(req.tokenId) ?? (await deployMeta(req.tokenId));
  const d = await deployPool({
    wallet,
    af: signedFor(base),
    base,
    tokenId: req.tokenId,
    tokens: req.tokens,
    sats: req.sats,
    fees: { lpFeeBps: BigInt(terms.fees.lpBps), validatorFeeBps: BigInt(terms.fees.validatorBps), commissionBps: BigInt(terms.fees.commissionBps) },
    validator: { identityKey: terms.validator },
    held,
    meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
  });
  emit();
  return { outpoint: d.outpoint, txid: d.txid, ...(d.errors.length ? { warnings: d.errors } : {}) };
}

/**
 * Closes a position (src/lp/close.ts): everything in the pool returns to the
 * wallet (its own action pays the miner fee); submitted to this skein's overlay.
 */
export async function closePosition(req: CloseRequest): Promise<CloseResult> {
  const { wallet } = needWallet();
  let pos = loaded.get(req.outpoint);
  if (!pos) {
    await myPositions();
    pos = loaded.get(req.outpoint);
  }
  if (!pos || !pos.output) throw new Error("No such position");
  const meta = await tokenMeta();
  const m = meta.get(pos.row.tokenId);
  const prepared = await prepareClose({
    wallet,
    tokenId: pos.row.tokenId,
    meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
    poolOutput: pos.output,
    lpKey: pos.row.lpKey,
  });
  // The page's own submit (the wallet's module submitted at its overlay too; its failure does not undo the close).
  await submitToOverlay(await tokenBaseOf(pos.row.tokenId), prepared.topic, prepared.beef).catch(() => undefined);
  loaded.delete(req.outpoint);
  emit();
  return { txid: prepared.txid, sats: prepared.sats, tokens: prepared.tokenAmount };
}

/**
 * Recovers a position whose deploy filed no row (src/lp/recover.ts, 0.12.1):
 * the pool at `outpoint` (the deploy's or a later one), checked to be this
 * wallet's by its LP key, filed in `amm-pools` as a deploy files it. Close
 * then works as for any position.
 */
export async function recoverPosition(outpoint: string): Promise<RecoverResult> {
  const { wallet, signedFor } = needWallet();
  const [rows, history, meta] = await Promise.all([basketRows(wallet, POOLS_BASKET), historyPoolRows(wallet), tokenMeta()]);
  const { base, tokenId } = await baseHolding(outpoint);
  const r = await recoverPoolRow({
    wallet,
    outpoint,
    rows,
    history,
    spendOf: (o) => readSpend(base, o),
    outputOf: (o) => colorOutput(signedFor(base), base, tokenId, o),
    metaOf: async (tokenId) => meta.get(tokenId) ?? (await deployMeta(tokenId)),
  });
  emit();
  return { outpoint: r.outpoint, sym: r.sym ?? r.tokenId.slice(0, 8), filed: r.filed };
}

/**
 * The token instance that knows a pool outpoint (0.17.0: a pasted outpoint names no token): the first
 * enabled token's instance whose chain state follows it as a pool (`/spends`: a current output, a
 * spender or a close); refused when none does.
 */
async function baseHolding(outpoint: string): Promise<{ base: string; tokenId: string }> {
  for (const t of await enabledTokens()) {
    const base = tokenBase(t.tokenId, context.base);
    const s = await readSpend(base, outpoint).catch(() => null);
    if (s && (s.current || s.spentBy || s.closed)) return { base, tokenId: t.tokenId };
  }
  throw new Error(`no token instance on this exchange knows ${outpoint}`);
}

// ---------------------------------------------------------------------------
// Your tokens
// ---------------------------------------------------------------------------

/**
 * The connected wallet's 1Color tokens (0.12.0: the BRC-207 module's): the
 * assets `p color assets` lists, each balance the sum of its held value
 * outputs there (0.27.0: one read for the whole list, granted once by the
 * pages' group permissions; no per-token `p color balance` here), and what the active swap basket (`amm-swap`) holds of each
 * (its tokens and, 0.29.6, the sats staged for its legs: a token with only sats staged is listed too); symbol,
 * decimals and icon from the token list, else the token's deploy
 * (the discovery lookup `ls_color`, BRC-207 `color-admission`, at the host root, 0.20.1), else a deploy the wallet holds. Each marked on this
 * exchange (registered) or not.
 */
export async function myTokens(): Promise<WalletToken[]> {
  const { wallet } = needWallet();
  const [held, swaps, topics, meta] = await Promise.all([
    heldOutputs(wallet),
    swapTotals(wallet).catch(() => new Map<string, { amount: bigint; outputs: number; sats: number }>()),
    enabledTokens().catch(() => [] as EnabledToken[]),
    tokenMeta(),
  ]);
  const inv = buildInventory(held.filter((h) => h.available));
  const ids = [...new Set([...inv.tokens.filter((t) => t.valueOutputs > 0).map((t) => t.tokenId), ...swaps.keys()])];
  const registered = new Set(topics.map((t) => t.tokenId));
  const out = await Promise.all(
    ids.map(async (tokenId): Promise<WalletToken> => {
      const t = inv.tokens.find((x) => x.tokenId === tokenId);
      const balance = t && t.valueOutputs > 0 ? t.balance : 0n;
      const fromDeploy = meta.has(tokenId) ? null : await deployMeta(tokenId);
      const m = meta.get(tokenId) ?? fromDeploy ?? {};
      const icon = m.icon ?? (t?.icon?.image ? imageDataUrl(t.icon.image) : undefined);
      return {
        tokenId,
        sym: m.sym ?? t?.sym ?? tokenId.slice(0, 8),
        dec: m.dec ?? t?.dec ?? 0,
        ...(icon ? { icon } : {}),
        balance,
        outputs: t?.valueOutputs ?? 0,
        inSwaps: swaps.get(tokenId)?.amount ?? 0n,
        swapSats: swaps.get(tokenId)?.sats ?? 0,
        onExchange: registered.has(tokenId),
      };
    }),
  );
  return out.filter((t) => t.balance > 0n || t.inSwaps > 0n || t.swapSats > 0).sort((a, b) => a.sym.localeCompare(b.sym) || a.tokenId.localeCompare(b.tokenId));
}

/**
 * "Move back" (src/market/activeSwap.ts; 0.29.3: a module plan): every `amm-swap` row of the
 * token (and its staged sats) spent in one action whose one output the wallet's module files
 * into the token's balance in the same call; submitted to this skein's token topic too. The
 * recovery path for a swap that got stuck. 0.29.6: with only sats staged for the token, one plain
 * createAction over them with no outputs (the wallet's change takes them).
 */
export async function moveBackTokens(tokenId: TokenId): Promise<{ txid: string; amount: bigint; errors: string[] }> {
  const { wallet } = needWallet();
  const meta = await tokenMeta();
  const base = await tokenBaseOf(tokenId);
  const r = await moveBack({ wallet, base, tokenId, meta: { sym: symOf(meta, tokenId) } });
  emit();
  return { txid: r.txid, amount: r.amount, errors: r.errors };
}

/**
 * "Send" (0.30.0): gives `amount` (raw units) of a token to a BRC-169 handle (`name@domain` or
 * `@name@domain`) with @1sat/actions `send1Color`: the handle resolved, one wallet createAction
 * through the BRC-207 color module (a BRC-177 noSend handoff), delivered (BRC-232) to the handle's
 * messagebox; the recipient's wallet takes it in. The action's result as is: `{txid, delivered,
 * messageId}`, or `{error}` (nothing built), or `{error, txid}` (built, not delivered).
 */
export async function sendTokens(tokenId: TokenId, handle: string, amount: bigint, memo?: string): Promise<Send1ColorResult> {
  const { wallet } = needWallet();
  const { network } = await wallet.getNetwork({});
  const r = await send1Color.execute(
    { wallet, chain: network === "mainnet" ? "main" : "test", isBaseWallet: false },
    { assetId: tokenId, amount, destination: { handle }, ...(memo ? { memo } : {}) },
  );
  emit();
  return r;
}

// ---------------------------------------------------------------------------
// Settings (root)
// ---------------------------------------------------------------------------

/**
 * The tokens on this exchange's list (0.17.0: the config instance's enable list, `GET
 * <config>/tokens`), every status, newest first.
 */
export async function registeredTokens(): Promise<RegisteredToken[]> {
  return (await enabledList()).map((t) => ({
    tokenId: t.tokenId,
    sym: t.sym || t.tokenId.slice(0, 8),
    ...(t.icon ? { icon: t.icon } : {}),
    status: t.status,
  }));
}

/** The topic a token's pools are admitted under (BRC-207; skein-amm 0.8.0): derived, never typed. */
export function topicOf(tokenId: TokenId): string {
  return `tm_color_${sdkTokenId(tokenId)}`;
}

/** The lookup service of a token (BRC-207): derived, never typed. */
export function lookupOf(tokenId: TokenId): string {
  return `ls_color_${sdkTokenId(tokenId)}`;
}

/** The AMM lookup's service of a token, `ls_amm_<assetId>` (0.21.0): a token instance's config names it, so it beats its prices on `ls_amm_<assetId>-live` (skein-overlay 0.17.0: a configured lookup beats). */
export function ammLookupOf(tokenId: TokenId): string {
  return ammLookupService(tokenId);
}

/**
 * A token deploy's BEEF from the connected wallet (0.17.0), as the 1Color tokens page gets it
 * (skein-1color web/src/overlay.ts `walletDeployBeef`): the deploy output in the module's basket
 * `p color <txid>v<vout>` (then its `authority` basket), its transaction as BEEF (`include: "entire
 * transactions"`), as an Atomic BEEF of the deploy. Undefined when the wallet holds it in neither
 * (not the deployer's, or the output spent).
 */
export async function walletDeployBeef(wallet: WalletInterface, tokenId: TokenId): Promise<number[] | undefined> {
  const op = parseOutpoint(sdkTokenId(tokenId).replace("_", "."));
  if (!op) throw new Error(`not a token id: ${tokenId}`);
  const assetId = `${op.txid}_${op.vout}`;
  for (const basket of [assetBasket(assetId, "value"), assetBasket(assetId, "authority")]) {
    const r = await wallet.listOutputs({ basket, include: "entire transactions", limit: 100 });
    const held = r.outputs.some((o) => o.outpoint === `${op.txid}.${op.vout}`);
    if (held && r.BEEF && r.BEEF.length > 0) return Beef.fromBinary(Array.from(r.BEEF)).toBinaryAtomic(op.txid);
  }
  return undefined;
}

/** What enabling a token reports: where the deploy's BEEF came from (2026-10-31: the wallet's basket or discovery; no paste). */
export interface EnableSent {
  beefFrom: "wallet" | "discovery";
}

/**
 * Enables a token (Open Exchange, shruggr/open-exchange#1): root's message `{fn: "enable", args:
 * {tokenId, beef}}` to the swap instance's `<app>/admin`. The deploy's BEEF from `deployBeef`: the
 * connected wallet's module basket, else the discovery lookup at the host root; with neither,
 * refused here ("no deploy for <id>: not on discovery and not in this wallet"). The swap instance
 * records the token enabled (a fact) and the host makes its instance at `<origin>/@<tokenId>`. A
 * token already on the list (disabled) is enabled again with no BEEF (the swap instance keeps its
 * deploy).
 */
export async function enableToken(tokenId: TokenId): Promise<EnableSent> {
  const { signedFor, wallet } = needWallet();
  const id = parseOutpoint(sdkTokenId(tokenId).replace("_", "."));
  if (!id) throw new Error(`not a token id: ${tokenId}`);
  const canonical = tokenIdText(id);
  const row = (await enabledList().catch(() => [] as EnabledToken[])).find((t) => t.tokenId === canonical);
  let beef: number[] | undefined;
  let from: EnableSent["beefFrom"] = "wallet";
  if (row?.status !== "disabled") {
    const d = await deployBeef(canonical, wallet);
    beef = d.beef;
    from = d.from;
  }
  const me = await instanceIdentity();
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "enable", args: { tokenId: canonical, ...(beef ? { beef: Uint8Array.from(beef) } : {}) } });
  emit();
  return { beefFrom: from };
}

/** A token Settings offers to enable (2026-10-31): on discovery, in this wallet, or both; not on the list yet. */
export interface EnableCandidate {
  tokenId: TokenId;
  sym?: string;
  icon?: string;
  onDiscovery: boolean;
  inWallet: boolean;
}

/** The discovery instance's app base (Open Exchange: the fixed handle `discovery`, its 1Color app `1color`). */
export function discoveryBase(): string {
  return `${hostRoot()}/@discovery/1color`;
}

const canonicalId = (tokenId: string): string | null => {
  const ref = parseTokenId(tokenId);
  return ref ? tokenIdText(ref) : null;
};

/**
 * The candidates to enable: discovery's token list (its order, newest first, with its metadata),
 * then the tokens only this wallet holds (in the order held); every token already on the swap
 * instance's list (enabled or disabled) left out. Pure: the reads are `tokensToEnable`'s.
 */
export function enableCandidates(listed: ListedToken[], walletIds: string[], onList: string[]): EnableCandidate[] {
  const skip = new Set(onList.map((t) => canonicalId(t) ?? t));
  const held = new Set(walletIds.map((t) => canonicalId(t) ?? t));
  const out: EnableCandidate[] = [];
  const seen = new Set<string>();
  for (const t of listed) {
    const id = canonicalId(t.tokenId);
    if (!id || skip.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ tokenId: id, ...(t.sym ? { sym: t.sym } : {}), ...(t.icon ? { icon: t.icon } : {}), onDiscovery: true, inWallet: held.has(id) });
  }
  for (const w of walletIds) {
    const id = canonicalId(w);
    if (!id || skip.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ tokenId: id, onDiscovery: false, inWallet: true });
  }
  return out;
}

/**
 * What Settings' "Enable a token" lists (2026-10-31): discovery's token list (`GET
 * <discoveryBase>/color/tokens`; a failed read — discovery off — is an empty list) ∪ the asset ids
 * of the connected wallet's held token outputs (`p color assets`, each locking script decoded),
 * minus the tokens on the swap instance's list. A wallet-only token's metadata from its deploy:
 * the one in the wallet's module basket (`deployBeef` with the wallet), else discovery's
 * (`deployMeta`), else none (the page shows its short id).
 */
export async function tokensToEnable(): Promise<EnableCandidate[]> {
  const { wallet } = needWallet();
  const [listed, held, list] = await Promise.all([readTokenList(discoveryBase()).catch(() => [] as ListedToken[]), heldOutputs(wallet), enabledList()]);
  const walletIds = [...new Set(held.map((h) => decodeTokenRow(h)?.tokenId).filter((t): t is string => typeof t === "string"))];
  const rows = enableCandidates(listed, walletIds, list.map((t) => t.tokenId));
  return Promise.all(
    rows.map(async (r) => {
      if (r.onDiscovery) return r;
      const d = await deployBeef(r.tokenId, wallet).catch(() => null);
      const fromWallet = d?.from === "wallet" && (d.meta.sym !== undefined || d.meta.icon !== undefined) ? d.meta : null;
      // d null: neither had it (deployBeef asked discovery already). A wallet deploy with no display fields: discovery's.
      const m = !d ? null : fromWallet ?? (d.from === "discovery" ? d.meta : await deployMeta(r.tokenId));
      return { ...r, ...(m?.sym !== undefined ? { sym: m.sym } : {}), ...(m?.icon ? { icon: m.icon } : {}) };
    }),
  );
}

/** Disables a token (0.17.0): root's `{fn: "disable", args: {tokenId}}` to `<app>/admin`; its instance stopped. */
export async function disableToken(tokenId: TokenId): Promise<void> {
  const { signedFor } = needWallet();
  const me = await instanceIdentity();
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "disable", args: { tokenId: sdkTokenId(tokenId) } });
  emit();
}

/** The three fees root sets (basis points, integers 0 to 10 000). */
export interface TermsInput {
  lpBps: number;
  validatorBps: number;
  commissionBps: number;
}

/** The defaults a new token instance is created with (0.17.0, `GET <config>/defaults`). */
export async function defaults(): Promise<Defaults> {
  return readDefaults(context.base);
}

async function sendDefaults(args: Record<string, unknown>): Promise<void> {
  const { signedFor } = needWallet();
  const me = await instanceIdentity();
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "defaults", args });
  emit();
}

/**
 * Sets the default validator terms (0.17.0): root's `{fn: "defaults", args: {terms: {lpFeeBps,
 * validatorFeeBps, commissionBps}}}` to the config instance's `<app>/admin` — a new token
 * instance's initial terms (its own `amm/terms`, root's message to `/@<tokenId>`, wins once
 * written). Refused here unless each fee is an integer 0 to 10 000.
 */
export async function setDefaultTerms(t: TermsInput): Promise<void> {
  for (const [k, v] of Object.entries(t)) if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${k}: an integer, 0 to 10000 basis points`);
  await sendDefaults({ terms: { lpFeeBps: t.lpBps, validatorFeeBps: t.validatorBps, commissionBps: t.commissionBps } });
}

/** Clears the default validator terms (0.17.0): `{fn: "defaults", args: {terms: null}}`; a new token instance is a market only. */
export async function clearDefaultTerms(): Promise<void> {
  await sendDefaults({ terms: null });
}

/** Sets the default market minimum (0.17.0): `{fn: "defaults", args: {market: {minCommissionBps}}}`; a new token instance's initial minimum. */
export async function setDefaultMarket(minCommissionBps: number): Promise<void> {
  if (!Number.isInteger(minCommissionBps) || minCommissionBps < 0 || minCommissionBps > 10_000) throw new Error("minCommissionBps: an integer, 0 to 10000 basis points");
  await sendDefaults({ market: { minCommissionBps } });
}

/** Clears the default market minimum (0.17.0): `{fn: "defaults", args: {market: null}}`. */
export async function clearDefaultMarket(): Promise<void> {
  await sendDefaults({ market: null });
}

/** The discovery instance's record (0.18.0, shruggr/skein#137; `GET <config>/discovery`): `{on: false}` until root turns it on. */
export async function discoveryState(): Promise<Discovery> {
  return readDiscovery(context.base);
}

/**
 * Turns the 1Color discovery topic on or off: root's `{fn: "discovery", args: {on}}` to the swap
 * instance's `<app>/admin` (Open Exchange: a fact; the host starts or stops the instance
 * `discovery` it made at setup, serving `tm_color` and its lookup `ls_color`); a deploy POSTed to
 * this origin's `/submit` with `X-Topics: tm_color` is routed to it. Enabling a token does not
 * submit its deploy there.
 */
export async function setDiscovery(on: boolean): Promise<void> {
  const { signedFor } = needWallet();
  const me = await instanceIdentity();
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "discovery", args: { on } });
  emit();
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

// ---------------------------------------------------------------------------
// Unfinished steps (0.29.3)
// ---------------------------------------------------------------------------

/** One unfinished step as the Your tokens page lists it. */
export interface Unfinished {
  id: string;
  kind: PendingPayout["kind"];
  tokenId: TokenId;
  txid: string;
  /** false while the swap's txid is provisional. */
  final: boolean;
  /** 0.29.6: whether Dismiss may drop it — a swap never signed (not final), not an entry with its own bytes (pre-0.29.3). */
  dismissable: boolean;
  createdAt: number;
}

/** Whether an entry may be dismissed (0.29.6): not final and carrying no key bytes of its own. A final entry or an old-shape one is the only pointer to money. */
function dismissable(p: PendingPayout): boolean {
  return p.final === false && !isLegacyPayout(p);
}

/** The browser's unfinished steps (src/wallet/pendingPayouts.ts), oldest first. */
export function unfinished(): Unfinished[] {
  return context.payouts.list().map((p) => ({ id: p.id, kind: p.kind, tokenId: p.tokenId, txid: p.txid, final: p.final, dismissable: dismissable(p), createdAt: p.createdAt }));
}

/** The unfinished steps, kept current as entries are written and cleared (this tab and others). */
export function useUnfinished(): Unfinished[] {
  const [list, setList] = useState<Unfinished[]>(() => unfinished());
  useEffect(() => onPendingPayoutsChange(() => setList(unfinished())), []);
  return list;
}

/**
 * "Finish" one step: the final transaction from the token's instance, the key re-derived (or, for an
 * entry from before 0.29.3, its own bytes), the wallet's take-in; the entry cleared only when the
 * wallet accepted. Throws the reason otherwise (the entry stays).
 */
/**
 * "Dismiss" (0.29.6, David Case 2026-11-03): forget an unsigned swap's entry — a leg the validator
 * never signed (timed out or refused) paid nothing to the user. Removes the entry and nothing else;
 * refuses a final entry and an old-shape one (the only pointer to money).
 */
export function dismissUnfinished(id: string): void {
  const p = context.payouts.get(id);
  if (!p) return;
  if (!dismissable(p)) throw new Error("This step cannot be dismissed: it points to an output paid to you");
  context.payouts.remove(id);
}

export async function finishUnfinished(id: string): Promise<{ accepted: boolean; txid: string }> {
  const { wallet, signedFor } = needWallet();
  const p = context.payouts.get(id);
  if (!p) throw new Error("Already finished");
  const base = p.base ?? (await tokenBaseOf(p.tokenId));
  const r = await internalizeNow(wallet, context.payouts, signedFor(base), base, p);
  if (!r.accepted) throw new Error("The wallet did not accept the output");
  emit();
  return r;
}
/** A token's validator terms (0.17.0: its own instance's), none while no token is picked. */
export const useValidatorTerms = (tokenId: TokenId | undefined) =>
  useData(() => (tokenId ? validatorTerms(tokenId) : Promise.resolve(null)), [tokenId]);
export const useWalletSats = (enabled: boolean) => useData(walletSats, [], enabled);
export const useRegisteredTokens = (enabled: boolean) => useData(registeredTokens, [], enabled);
export const useDefaults = (enabled: boolean) => useData(defaults, [], enabled);
export const useDiscovery = (enabled: boolean) => useData(discoveryState, [], enabled);
export const useClaimStatus = (enabled: boolean) => useData(claimStatus, [], enabled);
export const useTokensToEnable = (enabled: boolean) => useData(tokensToEnable, [], enabled);
/** The pools the Swap page lists (0.16.0: `swapPools`), read again when the wallet connects (the market's minimum is a signed read). */
export const useTokenPools = (tokenId: TokenId | undefined, connected: boolean) =>
  useData(() => (tokenId ? swapPools(tokenId) : Promise.resolve({ pools: [], hidden: 0 })), [tokenId, connected]);

/** Whether the session's key is root (`isRoot`), false while disconnected. */
export function useIsRoot(session: Session): boolean {
  const r = useData(() => isRoot(session.identityKey), [session.identityKey], session.status === "connected");
  return session.status === "connected" && r.data === true;
}
