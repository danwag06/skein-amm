/**
 * The Open Exchange client (skein-amm 0.38.0, D8–D14, agent-env plans/history-api-2026-11-05.md):
 * every read and every action the pages make, bound by `createClient` to one exchange, one miner
 * fee rate, one wallet and one fetch — configuration as arguments (D9): nothing here reads
 * `import.meta.env` or `location`. No React; the pages (src/data/exchange.ts) hold a client and
 * wrap it in their hooks. Published as `@dcasegr/amm-client` (src/index.ts; README "The packages").
 *
 * 0.34.0 (agent-env plans/exchange-api-2026-11-04.md §0, D1–D25; docs/AMM.md "The public read
 * API"): every read is a plain GET of the exchange's public read API (src/lib/overlay.ts), and the
 * client sends `/lookup` nowhere. Where each comes from:
 *
 * - **The token list** (`GET <swap>/tokens`): read ONCE per client (D4; `enabledList`), again
 *   only after its own enable or disable changed it.
 * - **Prices** (0.39.0, D3, D7): ONE read of the host-wide stats `GET <origin>/amm/stats`
 *   (`hostedTokens`): each token's price, liquidity (TVL) and pool count; no host-wide stream.
 * - **History** (0.39.0, D1–D6): `trades`, `trade`, `candles`, `stats`, `statsAll`, `holders`,
 *   `positionsAll` — plain GETs of the history routes (H1–H6, src/lib/overlay.ts).
 * - **Swap** (D11–D16): the token's pools route `GET /@<token>/amm/pools` held as an event stream
 *   (`watchTokenPools`; 0.39.0, D7: the whole answer once, then one `change` per pool change,
 *   applied to the held answer): the pools whose validator is beating and whose commission meets the
 *   market's minimum (the host's filter), the market's commission key hash; a quote is the
 *   matching engine's plan over that list (no request); a swap reads ONE `GET
 *   /@<token>/amm/pools/beef?lp=` for its legs (freshness, the pools' BEEF), then each leg's relay
 *   request (`amm.swap.submit`, held by the host until the relay rests; 15 s expiry); a lost answer
 *   is "no answer yet" with "Check again" (`GET /@<token>/amm/swaps?id=`, once).
 * - **Liquidity** (D9, D23): the wallet's pool rows and deploy history, then ONE `GET
 *   /@<token>/amm/positions?lp=` per token; a deploy the history has but the basket lacks is
 *   filed then; Close and Rebalance read their pool's BEEF by LP key (`/pools/beef?lp=`); the
 *   deploy's terms `GET /@<token>/amm/terms`.
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
 */
import { Beef, Transaction, type WalletInterface } from "@bsv/sdk";
import { send1Color, type Send1ColorResult } from "@1sat/actions";
import { computeSwap, type PoolState, type Plan } from "@dcasegr/amm-engine";
import { outpointText, parseOutpoint, parseTokenId, sdkTokenId, tokenIdText } from "./lib/tokenId.js";
import { DEFAULT_FEE_RATE_SATS_PER_KB, appName, exchangeBase, tokenBase } from "./lib/config.js";
import {
  ammLookupService,
  applyPoolChange,
  liveOfPools,
  parsePools,
  parseTokenTopic,
  poolOutputOf,
  poolsUrl,
  readDiscoveryDeploy,
  readDiscoveryIds,
  readDiscoveryList,
  readAllPositions,
  readAllStats,
  readCandles,
  readHolders,
  readPoolsBeef,
  readPools,
  readPositions,
  readStats,
  readTerms,
  readTrade,
  readTrades,
  readTx,
  watchPools,
  type Candle,
  type CandleTf,
  type DiscoveryRow,
  type Holders,
  type TokenPosition,
  type TokenStats,
  type Trade,
  type TradesPage,
  type InstanceTerms,
  type LiveAnswer,
  type LpPool,
  type PoolRow,
  type PoolsAnswer,
  type SignedFetch,
} from "./lib/overlay.js";
import { authFetchPerInstance, instanceBase, readDefaults, readDiscovery, readTokens, sendMessage, type Defaults, type Discovery, type EnabledToken, type ListedToken } from "./lib/skein.js";
import { depthOf } from "./market/prices.js";
import { buildPlanRequest, goneFromLookup, quote as planQuote } from "./market/plan.js";
import { validatorStatus } from "./market/view.js";
import type { AuthFetchLike } from "./market/relay.js";
import { planSwapLeg, prepareSwap, selectExactSatsInput, selectExactTokenInputs, type PlanLegInput, type PlannedLeg, type PreparedSwap, type SatsInput, type TokenInput } from "./market/swapAction.js";
import { moveBack, sendSatsToSwapBasket, sendToSwapBasket, swapHoldingBeef, swapHoldings, swapSatsHoldings, swapTotals, type MovedBack } from "./market/activeSwap.js";
import { checkAgain, relaySwap, swapIdOf, type SwapOutcome } from "./market/swapFlow.js";
import { settleStagedSwaps } from "./wallet/swapPayouts.js";
import { formatAmount } from "./lp/amounts.js";
import { basketRows } from "./lp/wallet.js";
import { buildInventory, decodeTokenRow, deployIcon } from "./lp/inventory.js";
import { imageDataUrl } from "./lp/images.js";
import { deployPool } from "./lp/poolDeploy.js";
import { rebalancePool } from "./lp/rebalance.js";
import { historyPoolRows, mergePoolRows, positionRowsOf, type PositionRow } from "./lp/positions.js";
import { POOLS_BASKET, assetBasket, heldOutputs } from "./wallet/color.js";
import { prepareClose, submitToOverlay } from "./lp/close.js";
import { ClientError, errorKind, kindOfOutcome, toClientError, type ClientErrorKind } from "./errors.js";

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
  /** 0.38.0 (D13): the failure's kind, when it has one (`error` stays the text). */
  kind?: ClientErrorKind;
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

export interface RebalanceRequest {
  /** The position's pool, `<txid>.<vout>`. */
  outpoint: string;
  /** The new pool's tokens, base units. */
  tokens: bigint;
  /** The new pool's sats. */
  sats: bigint;
}

export interface RebalanceResult {
  /** The new pool, `<txid>.0`. */
  outpoint: string;
  txid: string;
  /** The old pool's output the same transaction closed. */
  closed: string;
  /** What did not complete after the broadcast (the new position row's filing, the page's own submit). */
  warnings?: string[];
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

export type { EnabledToken, Defaults, Discovery, PoolRow, PoolsAnswer, Candle, CandleTf, Holders, TokenPosition, TokenStats, Trade, TradesPage };
export type { PoolChange, Price } from "./lib/overlay.js";
export { applyPoolChange, parseChange } from "./lib/overlay.js";

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

/** A token's deploy as `deployBeef` finds it: its Atomic BEEF, its metadata, and where it came from. */
export interface DeployFound {
  beef: number[];
  meta: DeployMeta;
  from: "wallet" | "discovery";
}

function symOf(meta: Map<string, ListedToken>, tokenId: string): string {
  return meta.get(tokenId)?.sym ?? tokenId.slice(0, 8);
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

/**
 * The hosted tokens (the enabled 1Color tokens at output 0), each with its record of the host-wide
 * stats (0.39.0, D3, D7: H4): the price (`price`, sats per whole token), the liquidity (`tvlSats`,
 * `tvlTokens`) and the pool count. `stats` null: not read yet (no prices); a token the stats lack:
 * no price, no pools. Pure.
 */
export function hostedFrom(list: EnabledToken[], stats: TokenStats[] | null): HostedToken[] {
  const out: HostedToken[] = [];
  for (const t of list) {
    if (t.status !== "enabled") continue;
    const topic = parseTokenTopic(t.topic);
    if (!topic || topic.kind !== "native") continue;
    const st = (stats ?? []).find((r) => canonicalId(r.tokenId) === t.tokenId);
    const sats = st?.tvlSats ?? 0n;
    const tokens = st?.tvlTokens ?? 0n;
    const price = st?.price ?? null;
    out.push({
      tokenId: t.tokenId,
      sym: t.sym || t.tokenId.slice(0, 8),
      dec: t.dec,
      ...(t.icon ? { icon: t.icon } : {}),
      marginalPrice: price && price.tokens > 0n ? Number(price.sats) / (Number(price.tokens) / 10 ** t.dec) : null,
      depth: depthOf(sats),
      pools: st?.pools ?? 0,
      reserves: { sats, tokens },
    });
  }
  return out;
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

/** The fees a pool's own record names (D13: the Swap page's fee line), basis points. */
export function poolFees(p: Pick<PoolState, "liquidityFeeBps" | "validationFeeBps" | "commissionBps">): Fees {
  return { lpBps: Number(p.liquidityFeeBps), validatorBps: Number(p.validationFeeBps), commissionBps: Number(p.commissionBps ?? 0n) };
}

function swapResultOf(legs: LegResult[]): SwapResult {
  const filled = legs.filter((l) => l.status === "filled").length;
  return { status: filled === legs.length && legs.length > 0 ? "filled" : filled === 0 ? "failed" : "partial", legs };
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

/** A token Settings offers to enable (2026-10-31): on discovery, in this wallet, or both; not on the list yet. */
export interface EnableCandidate {
  tokenId: TokenId;
  sym?: string;
  icon?: string;
  onDiscovery: boolean;
  inWallet: boolean;
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

/** The three fees root sets (basis points, integers 0 to 10 000). */
export interface TermsInput {
  lpBps: number;
  validatorBps: number;
  commissionBps: number;
}


/** What a quote was planned from: kept for its execution. */
interface Planned {
  plan: Plan;
  pools: PoolRow[];
  live: LiveAnswer;
  market: PoolsAnswer["market"];
  dec: number;
  sym: string;
}


// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** A plain fetch (the reads, the submits, the BRC-104 transport). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The wallet's BRC-104 client for one instance base (src/lib/skein.ts `authFetchPerInstance`). */
export type Signed = SignedFetch & AuthFetchLike;

export interface ClientOptions {
  /**
   * The exchange: its origin (`https://swap.skein.nexus`: the swap app at `<origin>/amm`) or the
   * swap app's base URL with a path (`http://127.0.0.1:8100/@swap/amm`), as the pages compute it.
   */
  origin: string;
  /** The miner fee rate the client sizes a swap leg's staged sats with, sats per 1000 bytes. Default 100. */
  feeRateSatsPerKb?: number;
  /** The connected BRC-100 wallet; null or absent: a client for the reads (actions answer "Connect a wallet first"). */
  wallet?: WalletInterface | null;
  /** The plain fetch for every unsigned request and the BRC-104 transport. Default: the global `fetch`, looked up at each call. */
  fetch?: FetchLike;
  /** The wallet's BRC-104 client per instance base. Default: `authFetchPerInstance(wallet, fetch)` (one session per instance). */
  signedFor?: (base: string) => Signed;
  /** The wallet's identity key, when the caller has it (the claim's check). Default: read from the wallet when needed. */
  identityKey?: string | null;
}

/** Where a swap is (`executeSwap`'s `onProgress`, D12), in this order; `leg` the pool outpoint (`<txid>.<vout>`) of a leg event. */
export type SwapProgress =
  | { phase: "staging" }
  | { phase: "relaying"; leg: string }
  | { phase: "repricing"; leg: string }
  | { phase: "done"; result: SwapResult }
  | { phase: "failed"; result?: SwapResult; error?: ClientError | Error };

export interface SwapOptions {
  /** Called as the swap moves (D12): `staging` (the swap basket is filled for the legs), `relaying` (per leg), `repricing` (a leg refused `pool_spent`, re-quoted), then `done` (a leg filled) or `failed` (none did, or it threw). */
  onProgress?: (p: SwapProgress) => void;
}

/** What a client remembers between calls; shared by `withWallet`'s clients. */
interface Shared {
  /** The token list read by this client (D4: once; again only after its own enable or disable). */
  listRead: Promise<EnabledToken[]> | null;
  /** swap's claim card read by this client (D21: the identity of the recipient of root's messages). */
  claimRead: ClaimStatus | null;
  /** What each quote was planned from: kept for its execution. */
  planned: WeakMap<Quote, Planned>;
  /** The legs whose answer did not come: their prepared swap, for "Check again" (D15). */
  checks: Map<string, { prepared: PreparedSwap; base: string; af: Signed }>;
  /** The positions last loaded, by the output a Close acts on (`<txid>.<vout>`): the wallet's row (its LP key) and the token. */
  loaded: Map<string, PositionRow>;
  /** `onDataChange`'s listeners. */
  listeners: Set<() => void>;
}

const newShared = (): Shared => ({ listRead: null, claimRead: null, planned: new WeakMap(), checks: new Map(), loaded: new Map(), listeners: new Set() });

/**
 * The client of one exchange (D9): its reads over `origin` (src/lib/overlay.ts, src/lib/skein.ts),
 * the swap flow, the pool flows (deploy, close, rebalance, move back, positions) and the wallet
 * pieces, bound to `feeRateSatsPerKb`, `wallet` and `fetch`. Errors of the kinds in
 * `CLIENT_ERROR_KINDS` are `ClientError`s (D13), the message as before.
 */
export function createClient(opts: ClientOptions): AmmClient {
  return makeClient(opts, newShared());
}

export type AmmClient = ReturnType<typeof makeClient>;

function makeClient(opts: ClientOptions, s: Shared) {
  const swapBase = exchangeBase(opts.origin);
  const feeRate = opts.feeRateSatsPerKb ?? DEFAULT_FEE_RATE_SATS_PER_KB;
  const f: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const ff = f as typeof fetch;
  /** The submit at the host root of `base` (BRC-22, src/lp/close.ts `submitToOverlay`) over this client's fetch. */
  const submitAt = (base: string) => (topic: string, beef: number[]) => submitToOverlay(base, topic, beef, f);
  const boundWallet = opts.wallet ?? null;
  const signedFor: ((base: string) => Signed) | null = boundWallet ? (opts.signedFor ?? (authFetchPerInstance(boundWallet, f as typeof fetch) as unknown as (base: string) => Signed)) : null;
  const planned = s.planned;
  const checks = s.checks;
  const loaded = s.loaded;

  function needWallet(): { wallet: WalletInterface; signedFor: (base: string) => Signed } {
    if (!boundWallet || !signedFor) throw new Error("Connect a wallet first");
    return { wallet: boundWallet, signedFor };
  }

  /** The wallet's identity key: as given, else the wallet's (null without a wallet). */
  async function myIdentityKey(): Promise<string | null> {
    if (opts.identityKey !== undefined) return opts.identityKey;
    if (!boundWallet) return null;
    return (await boundWallet.getPublicKey({ identityKey: true })).publicKey;
  }

  /** `fn` with its error of a named kind thrown as a `ClientError` (D13; the message unchanged). */
  function guard<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return async (...a: A) => {
      try {
        return await fn(...a);
      } catch (e) {
        throw toClientError(e);
      }
    };
  }

  function emit(): void {
    for (const l of s.listeners) l();
  }
  /** Calls `fn` after any action changes data (swap, deploy, close, register…). Returns the unsubscribe. */
  function onDataChange(fn: () => void): () => void {
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  }

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** The app's name (its boxes are `<app>/<box>`). */
  function app(): string {
    return appName(swapBase) ?? "amm";
  }


  /** Forget what was read this page load (a new base; tests). */
  function forgetReads(): void {
    s.listRead = null;
    s.claimRead = null;
  }

  /** The swap instance's enable list (`GET <swap>/tokens`, P12), every status: read once per page load. */
  function enabledList(): Promise<EnabledToken[]> {
    if (!s.listRead) {
      const r = readTokens(swapBase, ff).then((ts) =>
        ts.map((t) => {
          const id = parseOutpoint(t.tokenId.replace("_", "."));
          return id ? { ...t, tokenId: tokenIdText(id) } : t;
        }),
      );
      s.listRead = r;
      r.catch(() => {
        if (s.listRead === r) s.listRead = null;
      });
    }
    return s.listRead;
  }

  /** The tokens up on this exchange: enabled on the swap instance's list. */
  async function enabledTokens(): Promise<EnabledToken[]> {
    return (await enabledList()).filter((t) => t.status === "enabled");
  }

  /**
   * A token's own instance's AMM base: `<origin>/@<tokenId>/amm` (Open Exchange: the host makes the
   * instance of every enabled token there). Refused for a token that is not enabled here.
   */
  async function tokenBaseOf(tokenId: TokenId): Promise<string> {
    const t = (await enabledTokens()).find((x) => x.tokenId === tokenId);
    if (!t) throw new Error(`${tokenId.slice(0, 8)}… is not enabled on this exchange`);
    return tokenBase(t.tokenId, swapBase);
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
    return new URL(swapBase).origin;
  }

  /**
   * A token's deploy from discovery (0.34.0, D21: `GET /@discovery/1color/<token>/deploy`, P16, the
   * deploy's BEEF): its bytes and metadata; null when discovery does not hold it or the read fails
   * (discovery off).
   */
  async function discoveryDeploy(tokenId: string): Promise<{ beef: number[]; meta: DeployMeta } | null> {
    try {
      const op = parseOutpoint(tokenId.replace("_", "."));
      const beef = op ? await readDiscoveryDeploy(discoveryBase(), tokenId, f) : null;
      if (!op || !beef) return null;
      const meta = deployMetaOf(beef, op.vout);
      return meta ? { beef, meta } : null;
    } catch {
      return null;
    }
  }

  /**
   * A token's deploy (Settings "Enable a token"): with a wallet, the deploy output in its module
   * basket (`walletDeployBeef`) when it holds it; else discovery's (`GET
   * /@discovery/1color/<token>/deploy`). Refused when neither has it: "no deploy for <id>: not on
   * discovery and not in this wallet".
   */
  async function deployBeef(tokenId: TokenId, wallet?: WalletInterface | null): Promise<DeployFound> {
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
      for (const r of await readDiscoveryIds(discoveryBase(), ids, f)) {
        const id = canonicalId(r.tokenId) ?? r.tokenId;
        if (r.listed) m.set(id, r);
      }
    } catch {
      /* discovery off: none */
    }
    return m;
  }

  /** swap's card (`GET <its origin>/.well-known/skein`) and its claim (`GET <base>/admin`), both unsigned. */
  async function claimStatus(): Promise<ClaimStatus> {
    const url = `${instanceBase(swapBase)}/.well-known/skein`;
    const res = await f(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    const v = (await res.json()) as { claimed?: unknown; identity?: unknown };
    const identity = String(v.identity ?? "").toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(identity)) throw new Error(`GET ${url}: no identity`);
    const a = await f(`${swapBase}/admin`, { headers: { accept: "application/json" } }).catch(() => undefined);
    let out: ClaimStatus;
    if (!a?.ok) out = { claimed: v.claimed === true, identity };
    else {
      const adm = (await a.json().catch(() => ({}))) as { claimant?: unknown };
      const claimant = typeof adm.claimant === "string" && /^0[23][0-9a-f]{64}$/i.test(adm.claimant) ? adm.claimant.toLowerCase() : undefined;
      out = claimant ? { claimed: true, identity, claimant } : { claimed: false, identity };
    }
    s.claimRead = out;
    return out;
  }

  /**
   * swap's identity, the recipient of root's messages (0.34.0, D21: from the claim card already read
   * on load, `claimStatus`; the signed token-list read for its `x-bsv-auth-identity-key`,
   * `instanceIdentity`, is gone); read now when no card was read yet.
   */
  async function swapIdentity(): Promise<string> {
    return (s.claimRead ?? (await claimStatus())).identity;
  }

  /**
   * Whether this identity may configure the exchange (0.28.0; the name kept from 0.26.0): it is swap's
   * claimant (`GET <base>/admin`, granted amm.admin by the host), or it holds root on swap (the host's
   * `GET <host root>/skeins?key=<identityKey>` names swap's identity: the host's key, or a key the host
   * granted root, as on the rack). False when the reads fail.
   */
  async function isRoot(identityKey: string | null): Promise<boolean> {
    if (!identityKey) return false;
    try {
      const { identity, claimant } = await claimStatus();
      if (claimant && claimant === identityKey.toLowerCase()) return true;
      const res = await f(`${hostRoot()}/skeins?key=${encodeURIComponent(identityKey)}`, { headers: { accept: "application/json" } });
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
  async function claimExchange(): Promise<boolean> {
    const { signedFor } = needWallet();
    const { identity } = await claimStatus();
    await sendMessage(signedFor(swapBase), swapBase, identity, `${app()}/claim`, { fn: "claim" });
    const me = await myIdentityKey();
    let root = false;
    for (let i = 0; i < 20 && !root; i++) {
      root = await isRoot(me);
      if (!root) await new Promise((r) => setTimeout(r, 250));
    }
    emit();
    if (!root) throw new Error("The claim was sent, but this wallet is not the admin: someone else may have claimed this exchange first.");
    return root;
  }

  /** The tokens this exchange hosts, priced: the token list (once) and ONE read of the host-wide stats (0.39.0, H4). No wallet needed. */
  async function hostedTokens(): Promise<HostedToken[]> {
    const [list, stats] = await Promise.all([enabledList(), statsAll().catch(() => null)]);
    return hostedFrom(list, stats);
  }

  /**
   * A token's pools route held as an event stream (D16; 0.39.0, D7): the whole answer (`pools`)
   * held, each `change` applied to it (`applyPoolChange`), one it cannot apply → the route read once
   * again; each new answer to `onAnswer`. → the unsubscribe.
   */
  function watchTokenPools(tokenId: TokenId, onAnswer: (a: PoolsAnswer) => void, onError?: (e: unknown) => void): () => void {
    return watchPools(poolsUrl(tokenBase(tokenId, swapBase)), parsePools, onAnswer, { ...(onError ? { onError } : {}), fetch: f, change: applyPoolChange });
  }

  // ---------------------------------------------------------------- history (0.39.0, H1–H6)

  /** H1: a token's trades, newest first (`from ≤ at < to` ms, `limit` 1–500, `before` the cursor `next`, `lp` one LP key's). */
  async function trades(tokenId: TokenId, o: { from?: number; to?: number; limit?: number; before?: string; lp?: string } = {}): Promise<TradesPage> {
    return readTrades(tokenBase(tokenId, swapBase), o, ff);
  }

  /** H1 with `txid`: one Swap's trade row, null when it has none. */
  async function trade(tokenId: TokenId, txid: string): Promise<Trade | null> {
    return readTrade(tokenBase(tokenId, swapBase), txid, ff);
  }

  /** H2: a token's candles, one per non-empty bucket of `tf` over `from ≤ at < to` (ms). */
  async function candles(tokenId: TokenId, o: { tf: CandleTf; from: number; to: number }): Promise<Candle[]> {
    return readCandles(tokenBase(tokenId, swapBase), o, ff);
  }

  /** H3: a token's stats. */
  async function stats(tokenId: TokenId): Promise<TokenStats> {
    return readStats(tokenBase(tokenId, swapBase), ff);
  }

  /** H4: every enabled token's stats (`ids`: those only, in that order). */
  async function statsAll(o: { ids?: TokenId[] } = {}): Promise<TokenStats[]> {
    return readAllStats(swapBase, o.ids, ff);
  }

  /** H6: a token's holders, largest first (`limit` 1–100, `skip`). */
  async function holders(tokenId: TokenId, o: { limit?: number; skip?: number } = {}): Promise<Holders> {
    return readHolders(tokenBase(tokenId, swapBase), tokenId, o, ff);
  }

  /** H5: the LP keys' positions on every enabled token. */
  async function positionsAll(lpKeys: string[]): Promise<TokenPosition[]> {
    return readAllPositions(swapBase, lpKeys, ff);
  }


  /**
   * A quote for one token (D12): the matching engine's plan over the pools the Swap page holds
   * (`held`: the token's pools route's answer — the host listed only pools whose validator is beating
   * and whose commission meets the market's minimum); no request. `meta`: the token's symbol and
   * decimals.
   */
  function quoteSwap(req: QuoteRequest, held: PoolsAnswer | null, meta: { sym: string; dec: number }): Quote {
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
      feeRate,
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

  /** A relay outcome on a leg's result (0.31.1's mapping; 0.34.0: no answer carries its id for "Check again"). */
  function onLeg(result: LegResult, o: SwapOutcome, prepared: PreparedSwap, base: string, af: Signed): void {
    delete result.checkId;
    if (o.status === "accepted") {
      result.status = "filled";
      result.txid = o.txid;
      delete result.error;
      delete result.kind;
      checks.delete(o.id);
      return;
    }
    result.status = "failed";
    const kind = kindOfOutcome(o);
    if (kind) result.kind = kind;
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
  async function executeSwap(quote: Quote, o: SwapOptions = {}): Promise<SwapResult> {
    const progress = (x: SwapProgress) => {
      try {
        o.onProgress?.(x);
      } catch {
        /* the caller's callback: not the swap's failure */
      }
    };
    let result: SwapResult;
    try {
      result = await runSwap(quote, progress);
    } catch (e) {
      const err = toClientError(e);
      progress({ phase: "failed", error: err instanceof Error ? err : new Error(String(err)) });
      throw err;
    }
    progress(result.status === "failed" ? { phase: "failed", result } : { phase: "done", result });
    return result;
  }

  /** A leg failed with `e`: its text, and its kind when it has one (D13). */
  function failLeg(result: LegResult, e: unknown): void {
    result.error = errText(e);
    const kind = errorKind(e);
    if (kind) result.kind = kind;
  }

  async function runSwap(quote: Quote, progress: (x: SwapProgress) => void): Promise<SwapResult> {
    const { wallet, signedFor } = needWallet();
    const p = planned.get(quote);
    if (!p) throw new Error("Quote again: this quote was not planned here");
    const tokenId = quote.request.tokenId;
    const base = tokenBase(tokenId, swapBase);
    const af = signedFor(base);
    const lpOf = (outpoint: string) => p.pools.find((x) => x.outpoint === outpoint)?.lpPubKey ?? "";
    const keys = [...new Set(p.plan.legs.map((l) => lpOf(l.outpoint)).filter((k) => k !== ""))];
    const fresh = await readPoolsBeef(base, keys, freshFetch);
    const gone = goneFromLookup(p.plan, fresh.pools);
    if (gone.length > 0 && !quote.request.allowPartial) throw new ClientError("pool_spent", `${gone.map(outpointText).join(", ")} ${gone.length === 1 ? "was" : "were"} spent since the quote: quote again`);
    const commissionPkh = p.market.commissionPkh;
    const direction = quote.request.side === "buy" ? "bsvToToken" : "tokenToBsv";
    const legs: LegResult[] = [];
    const running: Promise<void>[] = [];
    // The legs that can run: not spent since the quote, their validator live.
    const runnable: { leg: Plan["legs"][number]; result: LegResult; pool: PoolRow; peerId: string }[] = [];
    for (const leg of p.plan.legs) {
      const poolOutpoint = outpointText(leg.outpoint);
      if (gone.includes(leg.outpoint)) {
        legs.push({ poolOutpoint, status: "failed", error: "spent since the quote", kind: "pool_spent" });
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
    if (runnable.length > 0) progress({ phase: "staging" });
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
        const planned = await planSwapLeg({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg: r.leg, pool: r.pool, poolOutput, commissionPkh, ...(tokensIn ? { tokenInputs: tokens ?? [{ satoshis: 1, amount: r.leg.amountIn }] } : {}), satsPerKb: feeRate });
        const sats = selectExactSatsInput(satsCandidates, planned.funding.satoshis);
        if (sats) satsCandidates = satsCandidates.filter((c) => c !== sats);
        staged.push({ r, poolOutput, planned, tokens, sats });
      } catch (e) {
        failLeg(r.result, e);
      }
    }
    const shortTokens = staged.filter((x) => tokensIn && !x.tokens);
    const shortSats = staged.filter((x) => !x.sats);
    let sent: number[] | undefined;
    if (shortTokens.length > 0) {
      const s = await sendToSwapBasket(wallet, base, tokenId, { tokens: shortTokens.map((x) => ({ amount: x.r.leg.amountIn, pool: x.r.leg.outpoint })), sats: shortSats.map((x) => ({ satoshis: x.planned.funding.satoshis, pool: x.r.leg.outpoint })) }, { sym: p.sym }, submitAt(base));
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
        result.kind = "slippage";
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
        const common: PlanLegInput & { tokenInputs?: TokenInput[] } = { wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh, ...(x.tokens ? { tokenInputs: x.tokens } : {}), satsPerKb: feeRate };
        const planned = await planSwapLeg(common);
        const prepared = await prepareSwap({ ...common, satsInput: x.sats, ...(holdingBeef ? { holdingBeef } : {}), planned });
        track.amountOut = amountOut;
        result.repriced = true;
        return { o: await relayLeg(prepared, peerId), prepared };
      } catch (e) {
        failLeg(result, e);
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
        const prepared = await prepareSwap({ wallet, tokenId, meta: { sym: p.sym, dec: p.dec }, direction, leg, pool, poolOutput, commissionPkh, ...(tokens ? { tokenInputs: tokens } : {}), satsInput: sats, ...(holdingBeef ? { holdingBeef } : {}), planned, satsPerKb: feeRate });
        const track = { result, amountOut: leg.amountOut, done: false };
        tracks.push(track);
        running.push(
          (async () => {
            progress({ phase: "relaying", leg: result.poolOutpoint });
            let o = await relayLeg(prepared, peerId);
            let sentAs = prepared;
            // 0.31.1: refused `pool_spent` with the pool's newest state attached → repriced against
            // that state and sent once more (the staged `amm-swap` rows are still there).
            if (o.status === "refused" && o.reason.startsWith("pool_spent") && o.pool) {
              progress({ phase: "repricing", leg: result.poolOutpoint });
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
        failLeg(result, e);
      }
    }
    await Promise.all(running);
    emit();
    return swapResultOf(legs);
  }

  /** A plain GET past the browser's short cache (`state` class: max-age 5): what a swap is about to spend must be read now. */
  const freshFetch = (url: string, init?: RequestInit) => f(url, { ...init, cache: "no-cache" });

  /**
   * "Check again" (D15) for a leg with no answer yet: its record read ONCE (`GET
   * /@<token>/amm/swaps?id=`, plain), acted on (accepted: the payout taken in). → the leg's result
   * now (`poolOutpoint` as given).
   */
  async function checkSwapAgain(leg: LegResult): Promise<LegResult> {
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

  /** The connected wallet's spendable sats: the toolbox's balance special operation (`Wallet.balance()`'s call), its `totalOutputs`; a page may not read the admin-only `default` basket. */
  async function walletSats(): Promise<bigint> {
    const { wallet } = needWallet();
    const r = await wallet.listOutputs({ basket: SPEC_OP_WALLET_BALANCE });
    return BigInt(r.totalOutputs);
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
  async function myPositions(): Promise<Position[]> {
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
      const base = tokenBase(tokenId, swapBase);
      let pools: LpPool[];
      try {
        pools = await readPositions(base, [...keys.keys()], f);
      } catch {
        continue;
      }
      const t = enabled.get(tokenId);
      const meta = { sym: t?.sym ?? tokenId.slice(0, 8), dec: t?.dec ?? 0, ...(t?.icon ? { icon: t.icon } : {}) };
      const beating = new Set((await readPools(base, f).catch(() => null))?.validators.map((x) => x.identity) ?? []);
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
      const beef = await readTx(base, op.txid, f);
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
    return readTerms(await tokenBaseOf(tokenId), f);
  }

  /**
   * The validator a new position is deployed with (this skein), and its fees (read-only: the LP
   * accepts them); `{none: true}` when no terms are set. 0.34.0 (D21): `GET /@<token>/amm/terms`
   * (P7), plain.
   */
  async function validatorTerms(tokenId: TokenId): Promise<ValidatorTerms | NoTerms> {
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
  async function deployPosition(req: DeployRequest): Promise<DeployResult> {
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
      submit: submitAt(base),
    });
    emit();
    return { outpoint: d.outpoint, txid: d.txid, ...(d.errors.length ? { warnings: d.errors } : {}) };
  }

  /**
   * Closes a position (src/lp/close.ts): everything in the pool returns to the wallet (its own action
   * pays the miner fee). 0.34.0: the pool's current output and its BEEF by its LP key (`GET
   * /@<token>/amm/pools/beef?lp=<key>`, D2: the pool's id); the page's submit at the host root (D19).
   */
  async function closePosition(req: CloseRequest): Promise<CloseResult> {
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
    await submitToOverlay(swapBase, prepared.topic, prepared.beef, f).catch(() => undefined);
    loaded.delete(req.outpoint);
    emit();
    return { txid: prepared.txid, sats: prepared.sats, tokens: prepared.tokenAmount };
  }

  /**
   * Rebalances a position (D11, src/lp/rebalance.ts): its pool closed and a new pool of `tokens` and
   * `sats` deployed in ONE wallet createAction — the old pool the explicit input (as Close spends
   * it), the new one output 0 affirmed by the validator at its terms now (`amm.pool.affirm`, as a
   * deploy), the token difference through the wallet's module, the sats difference to or from the
   * wallet's change. The old pool's output and BEEF by its LP key (`GET
   * /@<token>/amm/pools/beef?lp=<key>`); the page's submit at the host root; the new pool's row
   * filed in `amm-pools`.
   */
  async function rebalancePosition(req: RebalanceRequest): Promise<RebalanceResult> {
    const { wallet, signedFor } = needWallet();
    if (req.tokens <= 0n || req.sats <= 0n) throw new Error("Both amounts must be more than 0");
    let row = loaded.get(req.outpoint);
    if (!row) {
      await myPositions();
      row = loaded.get(req.outpoint);
    }
    if (!row || !row.lpPubKey) throw new Error("No such position");
    const [terms, held, meta, base] = await Promise.all([instanceTerms(row.tokenId), heldOutputs(wallet), tokenMeta(), tokenBaseOf(row.tokenId)]);
    const v = terms.validator;
    if (!v) throw new Error(NO_VALIDATOR);
    const m = meta.get(row.tokenId);
    const poolOutput = poolOutputOf(await readPoolsBeef(base, [row.lpPubKey], freshFetch), req.outpoint);
    if (!poolOutput) throw new ClientError("stale_pool", `the pool is no longer at ${req.outpoint}: reload your positions`);
    const r = await rebalancePool({
      wallet,
      af: signedFor(base),
      base,
      tokenId: row.tokenId,
      poolOutput,
      lpKey: row.lpKey,
      tokens: req.tokens,
      sats: req.sats,
      fees: { lpFeeBps: BigInt(v.lpFeeBps), validatorFeeBps: BigInt(v.validatorFeeBps), commissionBps: BigInt(v.commissionBps) },
      validator: { identityKey: v.identity },
      held,
      meta: { ...(m?.sym ? { sym: m.sym } : {}), ...(m?.dec !== undefined ? { dec: m.dec } : {}) },
      submit: submitAt(base),
    });
    loaded.delete(req.outpoint);
    emit();
    return { outpoint: r.outpoint, txid: r.txid, closed: r.closed, ...(r.errors.length ? { warnings: r.errors } : {}) };
  }

  /**
   * The connected wallet's 1Color tokens (0.12.0: the BRC-207 module's): the assets `p color assets`
   * lists, each balance the sum of its held value outputs there (0.27.0), and what the active swap
   * basket (`amm-swap`) holds of each (its tokens and, 0.29.6, the sats staged for its legs).
   * 0.34.0 (D17): symbol, decimals and icon from the exchange's token list (read once), else ONE
   * discovery read for every held token the list lacks (`GET /@discovery/1color/tokens?ids=a,b`),
   * else the wallet's own deploy output. Each marked on this exchange (registered) or not.
   */
  async function myTokens(): Promise<WalletToken[]> {
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
  async function settleSwaps(): Promise<string[]> {
    if (!boundWallet) return [];
    const taken = await settleStagedSwaps(boundWallet, (t) => tokenBase(t, swapBase), f);
    if (taken.length > 0) emit();
    return taken;
  }

  /**
   * "Move back" (src/market/activeSwap.ts; 0.29.3: a module plan): every `amm-swap` row of the
   * token (and its staged sats) spent in one action whose one output the wallet's module files
   * into the token's balance in the same call; 0.34.0 (D19): submitted at the host root (`POST
   * <origin>/submit` + `X-Topics`), no token-list read for an instance base. The recovery path
   * for a swap that got stuck. 0.29.6: with only sats staged for the token, one plain createAction
   * over them with no outputs (the wallet's change takes them).
   */
  async function moveBackTokens(tokenId: TokenId): Promise<MovedBack> {
    const { wallet } = needWallet();
    const meta = await tokenMeta();
    const r = await moveBack({ wallet, base: swapBase, tokenId, meta: { sym: symOf(meta, tokenId) }, submit: submitAt(swapBase) });
    emit();
    return r;
  }

  /**
   * "Send" (0.30.0): gives `amount` (raw units) of a token to a BRC-169 handle (`name@domain` or
   * `@name@domain`) with @1sat/actions `send1Color`: the handle resolved, one wallet createAction
   * through the BRC-207 color module (a BRC-177 noSend handoff), delivered (BRC-232) to the handle's
   * messagebox; the recipient's wallet takes it in. The action's result as is: `{txid, delivered,
   * messageId}`, or `{error}` (nothing built), or `{error, txid}` (built, not delivered).
   */
  async function sendTokens(tokenId: TokenId, handle: string, amount: bigint, memo?: string): Promise<Send1ColorResult> {
    const { wallet } = needWallet();
    const { network } = await wallet.getNetwork({});
    const r = await send1Color.execute(
      { wallet, chain: network === "mainnet" ? "main" : "test", isBaseWallet: false },
      { assetId: tokenId, amount, destination: { handle }, ...(memo ? { memo } : {}) },
    );
    emit();
    return r;
  }

  /**
   * The tokens on this exchange's list (0.17.0: the config instance's enable list, `GET
   * <config>/tokens`), every status, newest first.
   */
  async function registeredTokens(): Promise<RegisteredToken[]> {
    return (await enabledList()).map((t) => ({
      tokenId: t.tokenId,
      sym: t.sym || t.tokenId.slice(0, 8),
      ...(t.icon ? { icon: t.icon } : {}),
      status: t.status,
    }));
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
  async function enableToken(tokenId: TokenId): Promise<EnableSent> {
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
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "enable", args: { tokenId: canonical, ...(beef ? { beef: Uint8Array.from(beef) } : {}) } });
    s.listRead = null; // the list changed: read again
    emit();
    return { beefFrom: from };
  }

  /** The discovery instance's app base (Open Exchange: the fixed handle `discovery`, its 1Color app `1color`). */
  function discoveryBase(): string {
    return `${hostRoot()}/@discovery/1color`;
  }

  /**
   * What Settings' "Enable a token" lists (2026-10-31; 0.34.0, D20): discovery's token list (`GET
   * /@discovery/1color/tokens`, paged; a failed read — discovery off — is an empty list) ∪ the asset
   * ids of the connected wallet's held token outputs (`p color assets`), minus the tokens on the
   * swap instance's list (read once). The wallet-only tokens' metadata: ONE `GET
   * /@discovery/1color/tokens?ids=` for them, else the deploy in the wallet's module basket, else
   * none (the page shows its short id).
   */
  async function tokensToEnable(): Promise<EnableCandidate[]> {
    const { wallet } = needWallet();
    const [listed, held, list] = await Promise.all([readDiscoveryList(discoveryBase(), f).catch(() => [] as DiscoveryRow[]), heldOutputs(wallet), enabledList()]);
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
  async function disableToken(tokenId: TokenId): Promise<void> {
    const { signedFor } = needWallet();
    const me = await swapIdentity();
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "disable", args: { tokenId: sdkTokenId(tokenId) } });
    s.listRead = null; // the list changed: read again
    emit();
  }

  /** The defaults a new token instance is created with (0.17.0, `GET <config>/defaults`). */
  async function defaults(): Promise<Defaults> {
    return readDefaults(swapBase, ff);
  }

  async function sendDefaults(args: Record<string, unknown>): Promise<void> {
    const { signedFor } = needWallet();
    const me = await swapIdentity();
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "defaults", args });
    emit();
  }

  /**
   * Sets the default validator terms (0.17.0): root's `{fn: "defaults", args: {terms: {lpFeeBps,
   * validatorFeeBps, commissionBps}}}` to the config instance's `<app>/admin` — a new token
   * instance's initial terms (its own `amm/terms`, root's message to `/@<tokenId>`, wins once
   * written). Refused here unless each fee is an integer 0 to 10 000.
   */
  async function setDefaultTerms(t: TermsInput): Promise<void> {
    for (const [k, v] of Object.entries(t)) if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${k}: an integer, 0 to 10000 basis points`);
    await sendDefaults({ terms: { lpFeeBps: t.lpBps, validatorFeeBps: t.validatorBps, commissionBps: t.commissionBps } });
  }

  /** One token's validator terms as its instance holds them (0.35.0; P7 `GET /@<token>/amm/terms`, plain): the three fees, or null (a market only). */
  async function tokenTerms(tokenId: TokenId): Promise<InstanceTerms["validator"]> {
    return (await instanceTerms(tokenId)).validator;
  }

  /**
   * Sets one token's validator terms (0.35.0, open-exchange 0.12.0): root's `{fn: "terms", args:
   * {tokenId, terms: {lpFeeBps, validatorFeeBps, commissionBps} | null}}` to the swap instance's
   * `<app>/admin`; swap emits it as a fact and the host sends it to the token's instance as root's
   * `terms` (null: a market only). Nothing answers back: the token's `/terms` shows the result.
   * Refused here unless each fee is an integer 0 to 10 000.
   */
  async function setTokenTerms(tokenId: TokenId, t: TermsInput | null): Promise<void> {
    if (t) for (const [k, v] of Object.entries(t)) if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${k}: an integer, 0 to 10000 basis points`);
    const { signedFor } = needWallet();
    const me = await swapIdentity();
    const terms = t ? { lpFeeBps: t.lpBps, validatorFeeBps: t.validatorBps, commissionBps: t.commissionBps } : null;
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "terms", args: { tokenId: sdkTokenId(tokenId), terms } });
  }

  /** Clears the default validator terms (0.17.0): `{fn: "defaults", args: {terms: null}}`; a new token instance is a market only. */
  async function clearDefaultTerms(): Promise<void> {
    await sendDefaults({ terms: null });
  }

  /** Sets the default market minimum (0.17.0): `{fn: "defaults", args: {market: {minCommissionBps}}}`; a new token instance's initial minimum. */
  async function setDefaultMarket(minCommissionBps: number): Promise<void> {
    if (!Number.isInteger(minCommissionBps) || minCommissionBps < 0 || minCommissionBps > 10_000) throw new Error("minCommissionBps: an integer, 0 to 10000 basis points");
    await sendDefaults({ market: { minCommissionBps } });
  }

  /** Clears the default market minimum (0.17.0): `{fn: "defaults", args: {market: null}}`. */
  async function clearDefaultMarket(): Promise<void> {
    await sendDefaults({ market: null });
  }

  /** The discovery instance's record (0.18.0, shruggr/skein#137; `GET <config>/discovery`): `{on: false}` until root turns it on. */
  async function discoveryState(): Promise<Discovery> {
    return readDiscovery(swapBase, ff);
  }

  /**
   * Turns the 1Color discovery topic on or off: root's `{fn: "discovery", args: {on}}` to the swap
   * instance's `<app>/admin` (Open Exchange: a fact; the host starts or stops the instance
   * `discovery` it made at setup, serving `tm_color` and its lookup `ls_color`); a deploy POSTed to
   * this origin's `/submit` with `X-Topics: tm_color` is routed to it. Enabling a token does not
   * submit its deploy there.
   */
  async function setDiscovery(on: boolean): Promise<void> {
    const { signedFor } = needWallet();
    const me = await swapIdentity();
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "discovery", args: { on } });
    emit();
  }
  /** The same exchange, fee rate and fetch with another wallet (or none); what this client read and planned is kept (its quotes still execute). */
  function withWallet(wallet: WalletInterface | null, o: { signedFor?: (base: string) => Signed; identityKey?: string | null } = {}) {
    const { signedFor: _s, identityKey: _k, ...rest } = opts;
    return makeClient({ ...rest, wallet, ...(o.signedFor ? { signedFor: o.signedFor } : {}), ...(o.identityKey !== undefined ? { identityKey: o.identityKey } : {}) }, s);
  }

  return {
    /** The swap app's base URL (`origin` as given, or `<origin>/amm`). */
    base: swapBase,
    feeRateSatsPerKb: feeRate,
    wallet: boundWallet,
    withWallet,
    onDataChange,
    forgetReads,
    // the exchange
    enabledList: guard(enabledList),
    tokenBaseOf: guard(tokenBaseOf),
    hostRoot,
    discoveryBase,
    claimStatus: guard(claimStatus),
    isRoot,
    claimExchange: guard(claimExchange),
    hostedTokens: guard(hostedTokens),
    watchTokenPools,
    // history (0.39.0)
    trades: guard(trades),
    trade: guard(trade),
    candles: guard(candles),
    stats: guard(stats),
    statsAll: guard(statsAll),
    holders: guard(holders),
    positionsAll: guard(positionsAll),
    registeredTokens: guard(registeredTokens),
    // swap
    quoteSwap,
    executeSwap,
    checkSwapAgain: guard(checkSwapAgain),
    walletSats: guard(walletSats),
    // liquidity
    myPositions: guard(myPositions),
    validatorTerms: guard(validatorTerms),
    deployPosition: guard(deployPosition),
    closePosition: guard(closePosition),
    rebalancePosition: guard(rebalancePosition),
    // your tokens
    myTokens: guard(myTokens),
    settleSwaps: guard(settleSwaps),
    moveBackTokens: guard(moveBackTokens),
    sendTokens: guard(sendTokens),
    // settings
    deployBeef: guard(deployBeef),
    enableToken: guard(enableToken),
    tokensToEnable: guard(tokensToEnable),
    disableToken: guard(disableToken),
    defaults: guard(defaults),
    setDefaultTerms: guard(setDefaultTerms),
    tokenTerms: guard(tokenTerms),
    setTokenTerms: guard(setTokenTerms),
    clearDefaultTerms: guard(clearDefaultTerms),
    setDefaultMarket: guard(setDefaultMarket),
    clearDefaultMarket: guard(clearDefaultMarket),
    discoveryState: guard(discoveryState),
    setDiscovery: guard(setDiscovery),
  };
}
