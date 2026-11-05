/**
 * Open Exchange: every read and every action the pages make, in one typed
 * module (shruggr/skein#147; wired in skein-amm 0.9.0). The pages import from
 * here and nowhere else in the data layer.
 *
 * 0.34.0 (agent-env plans/exchange-api-2026-11-04.md §0, D1–D25; docs/AMM.md "The public read
 * API"): every read is a plain GET of the exchange's public read API (src/lib/overlay.ts), and the
 * pages send `/lookup` nowhere. Where each comes from:
 *
 * - **The token list** (`GET <swap>/tokens`): read ONCE per page load (D4; `enabledList`), again
 *   only after Settings' own enable or disable changed it.
 * - **Prices** (`useHostedTokens`, D6, D22): the host-wide pools route `GET <origin>/amm/pools`
 *   held as an event stream; a token's price is Σsats / Σtokens over its listed pools.
 * - **Swap** (D11–D16): the token's pools route `GET /@<token>/amm/pools` held as an event stream
 *   (`useTokenPools`): the pools whose validator is beating and whose commission meets the
 *   market's minimum (the host's filter), the market's commission key hash; a quote is the
 *   matching engine's plan over that list (no request); a swap reads ONE `GET
 *   /@<token>/amm/pools/beef?lp=` for its legs (freshness, the pools' BEEF), then each leg's relay
 *   request (`amm.swap.submit`, held by the host until the relay rests; 15 s expiry); a lost answer
 *   is "no answer yet" with "Check again" (`GET /@<token>/amm/swaps?id=`, once).
 * - **Liquidity** (D9, D23): the wallet's pool rows and deploy history, then ONE `GET
 *   /@<token>/amm/positions?lp=` per token; a deploy the history has but the basket lacks is
 *   filed then; Close reads its pool's BEEF by LP key (`/pools/beef?lp=`); the deploy form's terms
 *   `GET /@<token>/amm/terms`.
 * - **Your tokens** (D17, D18, D19, D24): the wallet's module and the swap basket; the token list
 *   once and ONE discovery `GET /@discovery/1color/tokens?ids=` for held tokens the list lacks; a
 *   silent pass over the swap basket's staged legs (src/wallet/swapPayouts.ts); Move back submits
 *   at the host root.
 * - **Settings** (D20, D21): the claim card (`claimStatus`: swap's identity, the recipient of
 *   root's messages), the token list once, discovery's list and ONE `?ids=` read; Enable's deploy
 *   BEEF from the wallet's basket else `GET /@discovery/1color/<token>/deploy`.
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
import { Beef, Transaction, type WalletInterface } from "@bsv/sdk";
import { send1Color, type Send1ColorResult } from "@1sat/actions";
import { computeSwap, type PoolState, type Plan } from "@dcasegr/amm-engine";
import { useConnectDialog, useWallet } from "../wallet/AppWalletProvider";
import { outpointText, parseOutpoint, parseTokenId, sdkTokenId, tokenIdText } from "../lib/tokenId";
import { AMM_OVERLAY, FEE_RATE_SATS_PER_KB, appName, tokenBase } from "../lib/config";
import {
  ammLookupService,
  liveOfPools,
  parseAllPools,
  parsePools,
  parseTokenTopic,
  poolOutputOf,
  poolsUrl,
  readDiscoveryDeploy,
  readDiscoveryIds,
  readDiscoveryList,
  readPoolsBeef,
  readPools,
  readPositions,
  readTerms,
  readTx,
  watchPools,
  type DiscoveryRow,
  type InstanceTerms,
  type LiveAnswer,
  type LpPool,
  type PoolRow,
  type PoolsAnswer,
  type SignedFetch,
} from "../lib/overlay";
import { authFetchPerInstance, instanceBase, readDefaults, readDiscovery, readTokens, sendMessage, type Defaults, type Discovery, type EnabledToken, type ListedToken } from "../lib/skein";
import { depthOf } from "../market/prices";
import { buildPlanRequest, goneFromLookup, quote as planQuote } from "../market/plan";
import { validatorStatus } from "../market/view";
import type { AuthFetchLike } from "../market/relay";
import { planSwapLeg, prepareSwap, selectExactSatsInput, selectExactTokenInputs, type PlanLegInput, type PlannedLeg, type PreparedSwap, type SatsInput, type TokenInput } from "../market/swapAction";
import { moveBack, sendSatsToSwapBasket, sendToSwapBasket, swapHoldingBeef, swapHoldings, swapSatsHoldings, swapTotals } from "../market/activeSwap";
import { checkAgain, relaySwap, swapIdOf, type SwapOutcome } from "../market/swapFlow";
import { settleStagedSwaps } from "../wallet/swapPayouts";
import { formatAmount } from "../lp/amounts";
import { basketRows } from "../lp/wallet";
import { buildInventory, decodeTokenRow, deployIcon } from "../lp/inventory";
import { imageDataUrl } from "../lp/images";
import { deployPool } from "../lp/poolDeploy";
import { historyPoolRows, mergePoolRows, positionRowsOf, type PositionRow } from "../lp/positions";
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
  /** 0.34.0 (D15): no answer yet — the swap's id, for "Check again" (`checkSwapAgain`). */
  checkId?: string;
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
  /** Fees the pool has earned the LP, when it can be told (0.32.0: the sats-in swaps' LP fees, `ls_amm_<assetId>` `{tokenId, lpPubKey}`). */
  feesEarnedSats?: bigint;
  /** 0.32.0: the token-in swaps' LP fees, token base units; told with `feesEarnedSats`. */
  feesEarnedTokens?: bigint;
  /** 0.32.0: the pool is closed (the LP's Close or a rescind's); kept for its fees, not listed as a card. */
  closed?: boolean;
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

export type { EnabledToken, Defaults, Discovery, PoolRow, PoolsAnswer };

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
  /** The swap instance's AMM base URL (src/lib/config.ts): the pages' own. */
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

/** Set what the functions below reach (the wallet and its client: `useSession`; a test: anything). A new `base` forgets what was read of the old one. */
export function setExchangeContext(c: Partial<ExchangeContext>): void {
  if (c.base !== undefined) forgetReads();
  Object.assign(context, c);
}

function needWallet(): { wallet: WalletInterface; signedFor: (base: string) => Signed } {
  if (!context.wallet || !context.signedFor) throw new Error("Connect a wallet first");
  return { wallet: context.wallet, signedFor: context.signedFor };
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

/** The token list read this page load (D4: once; again only after Settings' enable or disable). */
let listRead: Promise<EnabledToken[]> | null = null;
/** swap's claim card read this page load (D21: the identity of the recipient of root's messages). */
let claimRead: ClaimStatus | null = null;

/** Forget what was read this page load (a new base; tests). */
export function forgetReads(): void {
  listRead = null;
  claimRead = null;
}

/** The swap instance's enable list (`GET <swap>/tokens`, P12), every status: read once per page load. */
function enabledList(): Promise<EnabledToken[]> {
  if (!listRead) {
    const r = readTokens(context.base).then((ts) =>
      ts.map((t) => {
        const id = parseOutpoint(t.tokenId.replace("_", "."));
        return id ? { ...t, tokenId: tokenIdText(id) } : t;
      }),
    );
    listRead = r;
    r.catch(() => {
      if (listRead === r) listRead = null;
    });
  }
  return listRead;
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

/** The token list's metadata by token id (every status); empty when the read fails. */
async function tokenMeta(): Promise<Map<string, ListedToken>> {
  const m = new Map<string, ListedToken>();
  try {
    for (const t of await enabledList()) m.set(t.tokenId, { tokenId: t.tokenId, topic: t.topic, sym: t.sym, dec: t.dec, ...(t.icon ? { icon: t.icon } : {}) });
  } catch {
    /* no metadata: ids only */
  }
  return m;
}

/** The host root: the pages' origin. */
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
 * A token's deploy from discovery (0.34.0, D21: `GET /@discovery/1color/<token>/deploy`, P16, the
 * deploy's BEEF): its bytes and metadata; null when discovery does not hold it or the read fails
 * (discovery off).
 */
async function discoveryDeploy(tokenId: string): Promise<{ beef: number[]; meta: DeployMeta } | null> {
  try {
    const op = parseOutpoint(tokenId.replace("_", "."));
    const beef = op ? await readDiscoveryDeploy(discoveryBase(), tokenId) : null;
    if (!op || !beef) return null;
    const meta = deployMetaOf(beef, op.vout);
    return meta ? { beef, meta } : null;
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
 * A token's deploy (Settings "Enable a token"): with a wallet, the deploy output in its module
 * basket (`walletDeployBeef`) when it holds it; else discovery's (`GET
 * /@discovery/1color/<token>/deploy`). Refused when neither has it: "no deploy for <id>: not on
 * discovery and not in this wallet".
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

/** Discovery's rows for `ids` (P13 `?ids=`, ONE read), by token id; empty when the read fails. */
async function discoveryRows(ids: string[]): Promise<Map<string, DiscoveryRow>> {
  const m = new Map<string, DiscoveryRow>();
  if (ids.length === 0) return m;
  try {
    for (const r of await readDiscoveryIds(discoveryBase(), ids)) {
      const id = canonicalId(r.tokenId) ?? r.tokenId;
      if (r.listed) m.set(id, r);
    }
  } catch {
    /* discovery off: none */
  }
  return m;
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
  let out: ClaimStatus;
  if (!a?.ok) out = { claimed: v.claimed === true, identity };
  else {
    const adm = (await a.json().catch(() => ({}))) as { claimant?: unknown };
    const claimant = typeof adm.claimant === "string" && /^0[23][0-9a-f]{64}$/i.test(adm.claimant) ? adm.claimant.toLowerCase() : undefined;
    out = claimant ? { claimed: true, identity, claimant } : { claimed: false, identity };
  }
  claimRead = out;
  return out;
}

/**
 * swap's identity, the recipient of root's messages (0.34.0, D21: from the claim card already read
 * on load, `claimStatus`; the signed token-list read for its `x-bsv-auth-identity-key`,
 * `instanceIdentity`, is gone); read now when no card was read yet.
 */
async function swapIdentity(): Promise<string> {
  return (claimRead ?? (await claimStatus())).identity;
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

/**
 * The hosted tokens (the enabled 1Color tokens at output 0), each priced from its rows of the
 * host-wide pools route (D6, D22: P1, the pools whose validator is beating): Σsats / Σtokens.
 * `rows` null: not read yet (no prices). Pure.
 */
export function hostedFrom(list: EnabledToken[], rows: PoolRow[] | null): HostedToken[] {
  const out: HostedToken[] = [];
  for (const t of list) {
    if (t.status !== "enabled") continue;
    const topic = parseTokenTopic(t.topic);
    if (!topic || topic.kind !== "native") continue;
    const mine = (rows ?? []).filter((r) => r.tokenId !== undefined && canonicalId(r.tokenId) === t.tokenId);
    const sats = mine.reduce((a, p) => a + p.bsvReserve, 0n);
    const tokens = mine.reduce((a, p) => a + p.tokenReserve, 0n);
    out.push({
      tokenId: t.tokenId,
      sym: t.sym || t.tokenId.slice(0, 8),
      dec: t.dec,
      ...(t.icon ? { icon: t.icon } : {}),
      marginalPrice: tokens > 0n ? Number(sats) / (Number(tokens) / 10 ** t.dec) : null,
      depth: depthOf(sats),
      pools: mine.length,
      reserves: { sats, tokens },
    });
  }
  return out;
}

/** The tokens this exchange hosts, priced: the token list (once) and ONE read of the host-wide pools route. No wallet needed. */
export async function hostedTokens(): Promise<HostedToken[]> {
  const [list, rows] = await Promise.all([enabledList(), readAllPools().catch(() => null)]);
  return hostedFrom(list, rows);
}

async function readAllPools(): Promise<PoolRow[]> {
  const res = await fetch(poolsUrl(context.base), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${poolsUrl(context.base)}: ${res.status}`);
  return parseAllPools(await res.json());
}

/** The host-wide pools route held as an event stream (D22: one connection): each answer's rows to `onRows`; `onLive` the connection's state. → the unsubscribe. */
export function watchHostedPools(onRows: (rows: PoolRow[]) => void, onLive?: (live: boolean) => void): () => void {
  return watchPools(poolsUrl(context.base), parseAllPools, onRows, { onError: () => onLive?.(false), onOpen: () => onLive?.(true) });
}

/** A token's pools route held as an event stream (D16): each answer to `onAnswer`. → the unsubscribe. */
export function watchTokenPools(tokenId: TokenId, onAnswer: (a: PoolsAnswer) => void, onError?: (e: unknown) => void): () => void {
  return watchPools(poolsUrl(tokenBase(tokenId, context.base)), parsePools, onAnswer, { ...(onError ? { onError } : {}) });
}

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

/** The pools the Swap page lists (D11, D13): the token's pools route's rows, every validator live (the host lists no other). */
export function poolViews(answer: PoolsAnswer | null, tokenId: TokenId): PoolView[] {
  return (answer?.pools ?? []).map((p) => ({
    outpoint: outpointText(p.outpoint),
    tokenId,
    sats: p.bsvReserve,
    tokens: p.tokenReserve,
    validator: { identityKey: p.validatorIdentityKey, live: true },
  }));
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

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

/** What a quote was planned from: kept for its execution. */
interface Planned {
  plan: Plan;
  pools: PoolRow[];
  live: LiveAnswer;
  market: PoolsAnswer["market"];
  dec: number;
  sym: string;
}
const planned = new WeakMap<Quote, Planned>();

/**
 * A quote for one token (D12): the matching engine's plan over the pools the Swap page holds
 * (`held`: the token's pools route's answer — the host listed only pools whose validator is beating
 * and whose commission meets the market's minimum); no request. `meta`: the token's symbol and
 * decimals.
 */
export function quoteSwap(req: QuoteRequest, held: PoolsAnswer | null, meta: { sym: string; dec: number }): Quote {
  if (req.amountIn <= 0n) throw new Error("Enter an amount");
  const pools = held?.pools ?? [];
  if (pools.length === 0) throw new Error("No pool to swap against");
  const live = liveOfPools(pools);
  const dec = meta.dec;
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
  const sumSats = pools.reduce((a, p) => a + p.bsvReserve, 0n);
  const sumTokens = pools.reduce((a, p) => a + p.tokenReserve, 0n);
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
  planned.set(q, { plan, pools, live, market: held!.market, dec, sym: meta.sym });
  return q;
}

/** The fees a pool's own record names (D13: the Swap page's fee line), basis points. */
export function poolFees(p: Pick<PoolState, "liquidityFeeBps" | "validationFeeBps" | "commissionBps">): Fees {
  return { lpBps: Number(p.liquidityFeeBps), validatorBps: Number(p.validationFeeBps), commissionBps: Number(p.commissionBps ?? 0n) };
}

/** The legs whose answer did not come: their prepared swap, for "Check again" (D15). */
const checks = new Map<string, { prepared: PreparedSwap; base: string; af: Signed }>();

/** A relay outcome on a leg's result (0.31.1's mapping; 0.34.0: no answer carries its id for "Check again"). */
function onLeg(result: LegResult, o: SwapOutcome, prepared: PreparedSwap, base: string, af: Signed): void {
  delete result.checkId;
  if (o.status === "accepted") {
    result.status = "filled";
    result.txid = o.txid;
    delete result.error;
    checks.delete(o.id);
    return;
  }
  result.status = "failed";
  const rest = o.status === "unknown" ? o.reason.replace(/^no answer yet:? ?/, "") : "";
  result.error = o.status === "refused" ? `refused: ${o.reason}` : o.status === "unknown" ? `no answer yet${rest ? `: ${rest}` : ""}` : o.status;
  if (o.status === "unknown") {
    result.checkId = o.id;
    checks.set(o.id, { prepared, base, af });
  } else if ("id" in o) checks.delete(o.id);
}

/**
 * Runs a quoted swap with the connected wallet (D14, D15): ONE `GET /@<token>/amm/pools/beef?lp=`
 * for the legs' LP keys — a leg whose key is missing or whose outpoint moved is gone since the
 * quote (as before 0.34.0) — the commission key hash and each validator's peer ID from the pools
 * the page holds; then one transaction per leg, relayed to the leg's validator (`amm.swap.submit`,
 * its answer the settled record), the payout taken in on acceptance. A planned pool gone stops the
 * swap unless partial fills are allowed.
 */
export async function executeSwap(quote: Quote): Promise<SwapResult> {
  const { wallet, signedFor } = needWallet();
  const p = planned.get(quote);
  if (!p) throw new Error("Quote again: this quote was not planned here");
  const tokenId = quote.request.tokenId;
  const base = tokenBase(tokenId, context.base);
  const af = signedFor(base);
  const lpOf = (outpoint: string) => p.pools.find((x) => x.outpoint === outpoint)?.lpPubKey ?? "";
  const keys = [...new Set(p.plan.legs.map((l) => lpOf(l.outpoint)).filter((k) => k !== ""))];
  const fresh = await readPoolsBeef(base, keys, freshFetch);
  const gone = goneFromLookup(p.plan, fresh.pools);
  if (gone.length > 0 && !quote.request.allowPartial) throw new Error(`${gone.map(outpointText).join(", ")} ${gone.length === 1 ? "was" : "were"} spent since the quote: quote again`);
  const commissionPkh = p.market.commissionPkh;
  const direction = quote.request.side === "buy" ? "bsvToToken" : "tokenToBsv";
  const legs: LegResult[] = [];
  const running: Promise<void>[] = [];
  // The legs that can run: not spent since the quote, their validator live.
  const runnable: { leg: Plan["legs"][number]; result: LegResult; pool: PoolRow; peerId: string }[] = [];
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
  const staged: { r: (typeof runnable)[number]; poolOutput: NonNullable<ReturnType<typeof poolOutputOf>>; planned: PlannedLeg; tokens: TokenInput[] | null; sats: SatsInput | null }[] = [];
  for (const r of runnable) {
    try {
      const poolOutput = poolOutputOf(fresh, r.leg.outpoint);
      if (!poolOutput) throw new Error("the pools read has no transaction for this pool");
      let tokens: TokenInput[] | null = null;
      if (tokensIn) {
        tokens = selectExactTokenInputs(tokenCandidates, r.leg.amountIn);
        if (tokens) tokenCandidates = tokenCandidates.filter((c) => !tokens!.includes(c));
      }
      // A leg whose tokens are still to be staged gets one output of 1 sat (sendToSwapBasket).
      const planned = await planSwapLeg({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg: r.leg, pool: r.pool, poolOutput, commissionPkh, ...(tokensIn ? { tokenInputs: tokens ?? [{ satoshis: 1, amount: r.leg.amountIn }] } : {}), satsPerKb: FEE_RATE_SATS_PER_KB });
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
  /** Relays the leg (0.34.0: no browser note; the staged rows are the leg's record, D24). */
  const relayLeg = (prepared: PreparedSwap, peerId: string): Promise<SwapOutcome> =>
    relaySwap({ wallet, authFetch: af, base }, prepared, peerId).catch((e): SwapOutcome => ({ status: "unknown", id: swapIdOf(prepared), reason: errText(e) }));
  /**
   * 0.31.1: one retry of a leg refused `pool_spent` — re-quoted alone against the validator's
   * newest pool state (the engine's single-pool math, same side and amountIn), sent only while
   * the order's bound holds (filled legs + this one + the legs still out ≥ the plan's
   * resolvedMinAmountOut), rebuilt on the new pool output with the same staged rows (0.34.0: its
   * BEEF from `GET /pools/beef?lp=<the pool's LP key>`, constant along its continuations). Null:
   * the leg failed here (its error set); else the second relay's outcome.
   */
  const retryLeg = async (x: { leg: Plan["legs"][number]; track: (typeof tracks)[number]; was: PoolRow; pool: PoolState; peerId: string; tokens: TokenInput[] | null; sats: SatsInput }): Promise<{ o: SwapOutcome; prepared: PreparedSwap } | null> => {
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
      const poolOutput = poolOutputOf(await readPoolsBeef(base, [x.was.lpPubKey], freshFetch), pool.outpoint);
      if (!poolOutput) throw new Error("the pool moved again: quote again");
      const common: PlanLegInput & { tokenInputs?: TokenInput[] } = { wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh, ...(x.tokens ? { tokenInputs: x.tokens } : {}), satsPerKb: FEE_RATE_SATS_PER_KB };
      const planned = await planSwapLeg(common);
      const prepared = await prepareSwap({ ...common, satsInput: x.sats, ...(holdingBeef ? { holdingBeef } : {}), planned });
      track.amountOut = amountOut;
      result.repriced = true;
      return { o: await relayLeg(prepared, peerId), prepared };
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
      const prepared = await prepareSwap({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh, ...(tokens ? { tokenInputs: tokens } : {}), satsInput: sats, ...(holdingBeef ? { holdingBeef } : {}), planned, satsPerKb: FEE_RATE_SATS_PER_KB });
      const track = { result, amountOut: leg.amountOut, done: false };
      tracks.push(track);
      running.push(
        (async () => {
          let o = await relayLeg(prepared, peerId);
          let sentAs = prepared;
          // 0.31.1: refused `pool_spent` with the pool's newest state attached → repriced against
          // that state and sent once more (the staged `amm-swap` rows are still there).
          if (o.status === "refused" && o.reason.startsWith("pool_spent") && o.pool) {
            const again = await retryLeg({ leg, track, was: pool, pool: o.pool, peerId, tokens, sats });
            if (!again) {
              track.done = true;
              return;
            }
            o = again.o;
            sentAs = again.prepared;
          }
          track.done = true;
          onLeg(result, o, sentAs, base, af);
        })(),
      );
    } catch (e) {
      result.error = errText(e);
    }
  }
  await Promise.all(running);
  emit();
  return swapResultOf(legs);
}

function swapResultOf(legs: LegResult[]): SwapResult {
  const filled = legs.filter((l) => l.status === "filled").length;
  return { status: filled === legs.length && legs.length > 0 ? "filled" : filled === 0 ? "failed" : "partial", legs };
}

/** A plain GET past the browser's short cache (`state` class: max-age 5): what a swap is about to spend must be read now. */
const freshFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, cache: "no-cache" });

/**
 * "Check again" (D15) for a leg with no answer yet: its record read ONCE (`GET
 * /@<token>/amm/swaps?id=`, plain), acted on (accepted: the payout taken in). → the leg's result
 * now (`poolOutpoint` as given).
 */
export async function checkSwapAgain(leg: LegResult): Promise<LegResult> {
  const { wallet } = needWallet();
  const id = leg.checkId;
  const c = id ? checks.get(id) : undefined;
  if (!id || !c) throw new Error("Nothing to check: this leg is not waiting on an answer here");
  const o = await checkAgain({ wallet, authFetch: c.af, base: c.base, fetch: freshFetch }, c.prepared, id);
  const next: LegResult = { poolOutpoint: leg.poolOutpoint, status: "failed", ...(leg.repriced ? { repriced: true as const } : {}) };
  onLeg(next, o, c.prepared, c.base, c.af);
  if (next.status === "filled") emit();
  return next;
}

/** A swap's result with one leg replaced (after "Check again"). */
export function withLeg(r: SwapResult, leg: LegResult): SwapResult {
  return swapResultOf(r.legs.map((l) => (l.poolOutpoint === leg.poolOutpoint ? leg : l)));
}

/**
 * wallet-toolbox's `specOpWalletBalance` (`sdk.specOpWalletBalance`, @bsv/wallet-toolbox-client): the listOutputs "basket" of its
 * balance special operation. Written out, not imported: the client package exports it only inside its `sdk` namespace, which
 * pulls ~560 kB into the bundle; test/exchange.test.ts checks it equals the toolbox's.
 */
export const SPEC_OP_WALLET_BALANCE = "893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8";

/** The connected wallet's spendable sats: the toolbox's balance special operation (`Wallet.balance()`'s call), its `totalOutputs`; a page may not read the admin-only `default` basket. */
export async function walletSats(): Promise<bigint> {
  const { wallet } = needWallet();
  const r = await wallet.listOutputs({ basket: SPEC_OP_WALLET_BALANCE });
  return BigInt(r.totalOutputs);
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

/** The positions last loaded, by the output a Close acts on (`<txid>.<vout>`): the wallet's row (its LP key) and the token. */
const loaded = new Map<string, PositionRow>();

/** A filed row's customInstructions with the token's symbol and decimals in (as a deploy files them), unless they are there. */
function withMeta(customInstructions: string | undefined, sym: string | undefined, dec: number | undefined): string | undefined {
  if (!customInstructions) return customInstructions;
  try {
    const ci = JSON.parse(customInstructions) as Record<string, unknown>;
    if (ci.sym !== undefined || (sym === undefined && dec === undefined)) return customInstructions;
    const { id, op, ...rest } = ci;
    return JSON.stringify({ id, op, ...(sym ? { sym } : {}), ...(dec !== undefined ? { dec: String(dec) } : {}), ...rest });
  } catch {
    return customInstructions;
  }
}

/**
 * The connected wallet's positions (0.34.0, D9): its pool rows (`amm-pools`, and its deploy
 * history's, spent ones too), grouped by token, each token's LP keys asked in ONE `GET
 * /@<token>/amm/positions?lp=k1,k2` (P4): each pool's state (live, rescinded, closed) and the LP fees
 * its swaps paid (`feesEarnedSats`, `feesEarnedTokens`). The token list is read once. D23: a
 * deploy in the history whose pool output has no `amm-pools` row, its pool still at that output,
 * is filed then (`internalizeAction` basket insertion, as the deploy files it; its BEEF `GET
 * /@<token>/amm/tx?id=`). Closed ones are marked `closed`, kept for their fees. `validator.live`
 * (0.34.1, David): the validator is live when it is in the token's pools route's `validators` (the
 * validators beating on the token's topic now): ONE plain `GET /@<token>/amm/pools` per token.
 */
export async function myPositions(): Promise<Position[]> {
  const { wallet } = needWallet();
  const [poolRows, history, list] = await Promise.all([basketRows(wallet, POOLS_BASKET), historyPoolRows(wallet), enabledList().catch(() => [] as EnabledToken[])]);
  const enabled = new Map(list.filter((t) => t.status === "enabled").map((t) => [t.tokenId, t]));
  const filed = new Set(poolRows.map((r) => r.outpoint.replace("_", ".")));
  // The rows by token, one per LP key (the pool's key for its life: a filed row and a history row of one pool are one).
  const byToken = new Map<string, Map<string, PositionRow>>();
  for (const row of positionRowsOf(mergePoolRows(history, poolRows))) {
    if (!row.lpPubKey || !enabled.has(row.tokenId)) continue;
    const keys = byToken.get(row.tokenId) ?? new Map<string, PositionRow>();
    if (!keys.has(row.lpPubKey)) keys.set(row.lpPubKey, row);
    byToken.set(row.tokenId, keys);
  }
  const out: Position[] = [];
  const closed: Position[] = [];
  loaded.clear();
  for (const [tokenId, keys] of byToken) {
    const base = tokenBase(tokenId, context.base);
    let pools: LpPool[];
    try {
      pools = await readPositions(base, [...keys.keys()]);
    } catch {
      continue;
    }
    const t = enabled.get(tokenId);
    const meta = { sym: t?.sym ?? tokenId.slice(0, 8), dec: t?.dec ?? 0, ...(t?.icon ? { icon: t.icon } : {}) };
    const beating = new Set((await readPools(base).catch(() => null))?.validators.map((x) => x.identity) ?? []);
    for (const p of pools) {
      const row = keys.get(p.lpPubKey)!;
      const fees = { feesEarnedSats: p.sats, feesEarnedTokens: p.tokens };
      if (p.status === "closed" || !p.outpoint || !p.current) {
        closed.push({ outpoint: row.deployOutpoint, tokenId, ...meta, sats: 0n, tokens: 0n, validator: { identityKey: row.validatorIdentity ?? "", live: false }, closed: true, ...fees });
        continue;
      }
      const outpoint = p.outpoint.replace("_", ".");
      loaded.set(outpoint, row);
      // D23: the deploy's row, filed from the wallet's record while the pool is still at the deploy's output.
      if (p.status === "live" && outpoint === row.deployOutpoint && !filed.has(outpoint)) await fileDeployRow(wallet, base, history, outpoint, meta);
      out.push({
        outpoint,
        tokenId,
        ...meta,
        sats: p.current.bsvReserve,
        tokens: p.current.tokenReserve,
        validator: { identityKey: p.current.validatorIdentityKey, live: beating.has(p.current.validatorIdentityKey.toLowerCase()) },
        ...(p.status === "rescinded" ? { rescinded: true } : {}),
        ...fees,
      });
    }
  }
  return [...out, ...closed];
}

/** D23: the history's row of the deploy output `outpoint` into `amm-pools` (basket insertion over the deploy's BEEF, `GET /tx?id=`). A failure: nothing, the next load. */
async function fileDeployRow(wallet: WalletInterface, base: string, history: Awaited<ReturnType<typeof historyPoolRows>>, outpoint: string, meta: { sym: string; dec: number }): Promise<void> {
  const h = history.find((r) => r.outpoint.replace("_", ".") === outpoint);
  const op = parseOutpoint(outpoint);
  if (!h || !op) return;
  try {
    const beef = await readTx(base, op.txid);
    if (!beef) return;
    const customInstructions = withMeta(h.customInstructions, meta.sym, meta.dec);
    await wallet.internalizeAction({
      tx: beef,
      outputs: [{ outputIndex: op.vout, protocol: "basket insertion", insertionRemittance: { basket: POOLS_BASKET, ...(h.tags ? { tags: h.tags } : {}), ...(customInstructions ? { customInstructions } : {}) } }],
      description: `AMM pool deploy: ${meta.sym}`.slice(0, 50),
      labels: ["amm-pool-deploy"],
    });
  } catch {
    /* the next load */
  }
}

/** A token instance's terms (P7: `GET /@<token>/amm/terms`, unsigned). */
async function instanceTerms(tokenId: TokenId): Promise<InstanceTerms> {
  return readTerms(await tokenBaseOf(tokenId));
}

/**
 * The validator a new position is deployed with (this skein), and its fees (read-only: the LP
 * accepts them); `{none: true}` when no terms are set. 0.34.0 (D21): `GET /@<token>/amm/terms`
 * (P7), plain.
 */
export async function validatorTerms(tokenId: TokenId): Promise<ValidatorTerms | NoTerms> {
  const t = (await instanceTerms(tokenId)).validator;
  if (!t) return { none: true };
  return { validator: { identityKey: t.identity, live: Boolean(t.peerId) }, isThisExchange: true, fees: { lpBps: t.lpFeeBps, validatorBps: t.validatorFeeBps, commissionBps: t.commissionBps } };
}

/**
 * Deploys a new position (src/lp/poolDeploy.ts, 0.13.0): this skein's
 * validator affirms the proposed pool at its terms (`amm.pool.affirm`: its
 * key, its nonce, its signature, written into the pool's state), then the
 * wallet's BRC-207 module selects the token inputs, builds, signs and
 * broadcasts the deploy in one createAction; the pool output is filed as a
 * position row (`amm-pools`); the page's own submit at the host root (D19).
 */
export async function deployPosition(req: DeployRequest): Promise<DeployResult> {
  const { wallet, signedFor } = needWallet();
  if (req.tokens <= 0n || req.sats <= 0n) throw new Error("Both amounts must be more than 0");
  const [terms, held, meta, base] = await Promise.all([instanceTerms(req.tokenId), heldOutputs(wallet), tokenMeta(), tokenBaseOf(req.tokenId)]);
  const v = terms.validator;
  if (!v) throw new Error(NO_VALIDATOR);
  const m = meta.get(req.tokenId);
  const d = await deployPool({
    wallet,
    af: signedFor(base),
    base,
    tokenId: req.tokenId,
    tokens: req.tokens,
    sats: req.sats,
    fees: { lpFeeBps: BigInt(v.lpFeeBps), validatorFeeBps: BigInt(v.validatorFeeBps), commissionBps: BigInt(v.commissionBps) },
    validator: { identityKey: v.identity },
    held,
    meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
  });
  emit();
  return { outpoint: d.outpoint, txid: d.txid, ...(d.errors.length ? { warnings: d.errors } : {}) };
}

/**
 * Closes a position (src/lp/close.ts): everything in the pool returns to the wallet (its own action
 * pays the miner fee). 0.34.0: the pool's current output and its BEEF by its LP key (`GET
 * /@<token>/amm/pools/beef?lp=<key>`, D2: the pool's id); the page's submit at the host root (D19).
 */
export async function closePosition(req: CloseRequest): Promise<CloseResult> {
  const { wallet } = needWallet();
  let row = loaded.get(req.outpoint);
  if (!row) {
    await myPositions();
    row = loaded.get(req.outpoint);
  }
  if (!row || !row.lpPubKey) throw new Error("No such position");
  const [meta, base] = await Promise.all([tokenMeta(), tokenBaseOf(row.tokenId)]);
  const m = meta.get(row.tokenId);
  const poolOutput = poolOutputOf(await readPoolsBeef(base, [row.lpPubKey], freshFetch), req.outpoint);
  if (!poolOutput) throw new Error(`the pool is no longer at ${req.outpoint}: reload your positions`);
  const prepared = await prepareClose({
    wallet,
    tokenId: row.tokenId,
    meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
    poolOutput,
    lpKey: row.lpKey,
  });
  // The page's own submit (the wallet's module submitted at its overlay too; its failure does not undo the close).
  await submitToOverlay(context.base, prepared.topic, prepared.beef).catch(() => undefined);
  loaded.delete(req.outpoint);
  emit();
  return { txid: prepared.txid, sats: prepared.sats, tokens: prepared.tokenAmount };
}

// ---------------------------------------------------------------------------
// Your tokens
// ---------------------------------------------------------------------------

/**
 * The connected wallet's 1Color tokens (0.12.0: the BRC-207 module's): the assets `p color assets`
 * lists, each balance the sum of its held value outputs there (0.27.0), and what the active swap
 * basket (`amm-swap`) holds of each (its tokens and, 0.29.6, the sats staged for its legs).
 * 0.34.0 (D17): symbol, decimals and icon from the exchange's token list (read once), else ONE
 * discovery read for every held token the list lacks (`GET /@discovery/1color/tokens?ids=a,b`),
 * else the wallet's own deploy output. Each marked on this exchange (registered) or not.
 */
export async function myTokens(): Promise<WalletToken[]> {
  const { wallet } = needWallet();
  const [held, swaps, meta] = await Promise.all([
    heldOutputs(wallet),
    swapTotals(wallet).catch(() => new Map<string, { amount: bigint; outputs: number; sats: number }>()),
    tokenMeta(),
  ]);
  const registered = new Set((await enabledTokens().catch(() => [] as EnabledToken[])).map((t) => t.tokenId));
  const inv = buildInventory(held.filter((h) => h.available));
  const ids = [...new Set([...inv.tokens.filter((t) => t.valueOutputs > 0).map((t) => t.tokenId), ...swaps.keys()])];
  const disc = await discoveryRows(ids.filter((id) => !meta.has(id)));
  const out = ids.map((tokenId): WalletToken => {
    const t = inv.tokens.find((x) => x.tokenId === tokenId);
    const balance = t && t.valueOutputs > 0 ? t.balance : 0n;
    const d = disc.get(tokenId);
    const m: DeployMeta = meta.get(tokenId) ?? (d ? { ...(d.sym !== undefined ? { sym: d.sym } : {}), ...(d.dec !== undefined ? { dec: d.dec } : {}), ...(d.iconUrl ? { icon: d.iconUrl } : {}) } : {});
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
  });
  return out.filter((t) => t.balance > 0n || t.inSwaps > 0n || t.swapSats > 0).sort((a, b) => a.sym.localeCompare(b.sym) || a.tokenId.localeCompare(b.tokenId));
}

/**
 * The silent pass over the swap basket's staged legs (0.34.0, D18, D24; src/wallet/swapPayouts.ts):
 * per token ONE `GET /spends?outpoint=` over the pools its rows were staged for, the spenders'
 * transactions, this wallet's payouts taken in. Nothing shown; a payout taken in reloads the
 * pages' data. Never throws.
 */
export async function settleSwaps(): Promise<string[]> {
  if (!context.wallet) return [];
  const taken = await settleStagedSwaps(context.wallet, (t) => tokenBase(t, context.base));
  if (taken.length > 0) emit();
  return taken;
}

/** Your tokens' load (D18): the silent pass, once per connected wallet. */
export function useSettleSwaps(connected: boolean): void {
  useEffect(() => {
    if (connected) void settleSwaps();
  }, [connected]);
}

/**
 * "Move back" (src/market/activeSwap.ts; 0.29.3: a module plan): every `amm-swap` row of the
 * token (and its staged sats) spent in one action whose one output the wallet's module files
 * into the token's balance in the same call; 0.34.0 (D19): submitted at the host root (`POST
 * <origin>/submit` + `X-Topics`), no token-list read for an instance base. The recovery path
 * for a swap that got stuck. 0.29.6: with only sats staged for the token, one plain createAction
 * over them with no outputs (the wallet's change takes them).
 */
export async function moveBackTokens(tokenId: TokenId): Promise<{ txid: string; amount: bigint; errors: string[] }> {
  const { wallet } = needWallet();
  const meta = await tokenMeta();
  const r = await moveBack({ wallet, base: context.base, tokenId, meta: { sym: symOf(meta, tokenId) } });
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
  const me = await swapIdentity();
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "enable", args: { tokenId: canonical, ...(beef ? { beef: Uint8Array.from(beef) } : {}) } });
  listRead = null; // the list changed: read again
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
 * What Settings' "Enable a token" lists (2026-10-31; 0.34.0, D20): discovery's token list (`GET
 * /@discovery/1color/tokens`, paged; a failed read — discovery off — is an empty list) ∪ the asset
 * ids of the connected wallet's held token outputs (`p color assets`), minus the tokens on the
 * swap instance's list (read once). The wallet-only tokens' metadata: ONE `GET
 * /@discovery/1color/tokens?ids=` for them, else the deploy in the wallet's module basket, else
 * none (the page shows its short id).
 */
export async function tokensToEnable(): Promise<EnableCandidate[]> {
  const { wallet } = needWallet();
  const [listed, held, list] = await Promise.all([readDiscoveryList(discoveryBase()).catch(() => [] as DiscoveryRow[]), heldOutputs(wallet), enabledList()]);
  const walletIds = [...new Set(held.map((h) => decodeTokenRow(h)?.tokenId).filter((t): t is string => typeof t === "string"))];
  const asListed: ListedToken[] = listed.map((r) => ({ tokenId: r.tokenId, topic: r.topic ?? `tm_color_${r.tokenId}`, ...(r.sym !== undefined ? { sym: r.sym } : {}), ...(r.dec !== undefined ? { dec: r.dec } : {}), ...(r.iconUrl ? { icon: r.iconUrl } : {}) }));
  const rows = enableCandidates(asListed, walletIds, list.map((t) => t.tokenId));
  const disc = await discoveryRows(rows.filter((r) => !r.onDiscovery).map((r) => r.tokenId));
  return Promise.all(
    rows.map(async (r) => {
      if (r.onDiscovery) return r;
      const d = disc.get(r.tokenId);
      if (d) return { ...r, ...(d.sym !== undefined ? { sym: d.sym } : {}), ...(d.iconUrl ? { icon: d.iconUrl } : {}) };
      const beef = await walletDeployBeef(wallet, r.tokenId).catch(() => undefined);
      const op = parseOutpoint(r.tokenId.replace("_", "."));
      const m = beef && op ? deployMetaOf(beef, op.vout) : null;
      return { ...r, ...(m?.sym !== undefined ? { sym: m.sym } : {}), ...(m?.icon ? { icon: m.icon } : {}) };
    }),
  );
}

/** Disables a token (0.17.0): root's `{fn: "disable", args: {tokenId}}` to `<app>/admin`; its instance stopped. */
export async function disableToken(tokenId: TokenId): Promise<void> {
  const { signedFor } = needWallet();
  const me = await swapIdentity();
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "disable", args: { tokenId: sdkTokenId(tokenId) } });
  listRead = null; // the list changed: read again
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
  const me = await swapIdentity();
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

/** One token's validator terms as its instance holds them (0.35.0; P7 `GET /@<token>/amm/terms`, plain): the three fees, or null (a market only). */
export async function tokenTerms(tokenId: TokenId): Promise<InstanceTerms["validator"]> {
  return (await instanceTerms(tokenId)).validator;
}

/**
 * Sets one token's validator terms (0.35.0, open-exchange 0.12.0): root's `{fn: "terms", args:
 * {tokenId, terms: {lpFeeBps, validatorFeeBps, commissionBps} | null}}` to the swap instance's
 * `<app>/admin`; swap emits it as a fact and the host sends it to the token's instance as root's
 * `terms` (null: a market only). Nothing answers back: the token's `/terms` shows the result.
 * Refused here unless each fee is an integer 0 to 10 000.
 */
export async function setTokenTerms(tokenId: TokenId, t: TermsInput | null): Promise<void> {
  if (t) for (const [k, v] of Object.entries(t)) if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${k}: an integer, 0 to 10000 basis points`);
  const { signedFor } = needWallet();
  const me = await swapIdentity();
  const terms = t ? { lpFeeBps: t.lpBps, validatorFeeBps: t.validatorBps, commissionBps: t.commissionBps } : null;
  await sendMessage(signedFor(context.base), context.base, me, `${app()}/admin`, { fn: "terms", args: { tokenId: sdkTokenId(tokenId), terms } });
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
  const me = await swapIdentity();
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
