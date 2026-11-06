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
 * - **Swap** (D11–D16; 0.40.0; 0.41.0): the token's pools route `GET /@<token>/amm/pools`, a plain
 *   read (`tokenPools`): the pools whose validator is beating and whose commission meets the
 *   market's minimum (the host's filter), each validator's minimum leg, the market's commission key
 *   hash; a quote is the matching engine's plan over that list (no request); a swap (`executeSwap`)
 *   stages what the swap basket lacks by ONE wallet action, then per leg the pools route read fresh,
 *   ONE `GET /@<token>/amm/pools/beef?pool=` and the leg's relay request (`amm.swap.submit`, held by
 *   the host until the relay rests; 15 s expiry); no answer → the host's `GET /amm/spends`, once
 *   more, a race. The pool events (`watchPoolEvents`, 0.41.0: the host's feeds) are signals for
 *   display: a page reads the route again on one.
 * - **Liquidity** (D9, D23; 0.40.0: by pool id): the wallet's pool rows and deploy history, then
 *   ONE `GET /@<token>/amm/positions?pool=` per token; a deploy the history has but the basket
 *   lacks is filed then; Close and Rebalance read their pool's BEEF by its id (`/pools/beef?pool=`);
 *   the deploy's terms `GET /@<token>/amm/terms`.
 * - **Your tokens** (D17, D18, D19, D24): the wallet's module and the swap basket; the token list
 *   once and ONE discovery `GET /@discovery/1color/tokens?ids=` for held tokens the list lacks; the
 *   pass over the swap basket (0.40.0: ONE `GET /amm/spends` over every row,
 *   src/wallet/swapPayouts.ts); Move back submits at the host root.
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
import { WALLET_PAYMENT } from "./wallet/brc29.js";
import { send1Color, type Send1ColorResult } from "@1sat/actions";
import { nextLeg, priceOf, type Leg, type PoolState, type Plan, type PricePair } from "@dcasegr/amm-engine";
import { outpointText, parseOutpoint, parseTokenId, sdkTokenId, tokenIdText } from "./lib/tokenId.js";
import { DEFAULT_FEE_RATE_SATS_PER_KB, appName, exchangeBase, tokenBase } from "./lib/config.js";
import {
  ammLookupService,
  liveOfPools,
  parseTokenTopic,
  poolOutputOf,
  readDiscoveryDeploy,
  readDiscoveryIds,
  readDiscoveryList,
  readAllPositions,
  readAllStats,
  readCandles,
  readHolders,
  readPoolHistory,
  readPoolsAt,
  readPoolsBeef,
  readPools,
  readPositions,
  readSpendsAll,
  readStats,
  readTerms,
  readTrade,
  readTrades,
  readTx,
  eventsUrl,
  watchPoolEvents as watchFeed,
  type Candle,
  type CandleSeries,
  type CandleTf,
  type PoolAt,
  type PoolHistoryPage,
  type SpendAll,
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
  type PoolEventMessage,
  type SignedFetch,
} from "./lib/overlay.js";
import { authFetchPerInstance, instanceBase, readDefaults, readDiscovery, readTokens, readWallet, sendMessage, type Defaults, type Discovery, type EnabledToken, type ExchangeWallet, type ListedToken } from "./lib/skein.js";
import { depthOf } from "./market/prices.js";
import { buildPlanRequest, legMinerFeeSats, quote as planQuote } from "./market/plan.js";
import { validatorStatus } from "./market/view.js";
import type { AuthFetchLike } from "./market/relay.js";
import { prepareSwap, selectLegInputs, type PlanLegInput, type PreparedSwap } from "./market/swapAction.js";
import { fileStagedToken, moveBack, moveBackSats, stage, swapHoldingBeef, swapHoldings, swapSatsHoldings, swapSatsTotal, swapTotals, unfiledStagedTokens, type MovedBack } from "./market/activeSwap.js";
import { relaySwap, swapIdOf, type SwapOutcome } from "./market/swapFlow.js";
import { resolveFromOverlay, type ResolvedLeg } from "./wallet/swapPayouts.js";
import { formatAmount } from "./lp/amounts.js";
import { basketRows } from "./lp/wallet.js";
import { buildInventory, decodeTokenRow, deployIcon } from "./lp/inventory.js";
import { imageDataUrl } from "./lp/images.js";
import { deployPool } from "./lp/poolDeploy.js";
import { rebalancePool } from "./lp/rebalance.js";
import { historyPoolRows, mergePoolRows, positionRowsOf, type PositionRow } from "./lp/positions.js";
import { POOLS_BASKET, assetBasket, heldOutputs } from "./wallet/color.js";
import { prepareClose, submitToOverlay } from "./lp/close.js";
import { ClientError, toClientError } from "./errors.js";

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
  /**
   * Sats per whole token (0.40.0: the stats' `price`, the midpoint of what a buy and a sell of 1% of
   * the pooled sats would pay now). Null with no open pool.
   */
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
  /** The pool's id (0.40.0): its deploy outpoint, `<txid>_<vout>`. */
  poolId: string;
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
  /**
   * 0.40.2: the most pools the order may draw on, filled legs counted — a positive integer the
   * caller always gives; the fee sats staged are for exactly that many legs. 1: exactly one leg
   * for the whole amount. Replaces `allowPartial` (`false` was 1).
   */
  maxSources: number;
}

export interface QuoteLeg {
  /** The pool, `<txid>.<vout>`. */
  poolOutpoint: string;
  /** The pool's id (0.40.0). */
  poolId: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Share of the amount in, basis points (the legs sum to 10000). */
  shareBps: number;
  /** The pool's reserves before the leg. */
  reserves: { sats: bigint; tokens: bigint };
  validator: ValidatorRef;
  /** The leg's own pool's fees (0.40.0: the fee line per leg). */
  fees: Fees;
}

/** What Swap stages into the swap basket before its first leg (0.40.0): the swap amount exact, and the fee sats. */
export interface QuoteStage {
  /** The swap amount: sats on a buy, token base units on a sell. */
  amount: bigint;
  /** The sats for the carriers and miner fees of `maxSources` legs (0.40.2). */
  feeSats: bigint;
}

export interface Quote {
  request: QuoteRequest;
  legs: QuoteLeg[];
  amountOut: bigint;
  /** The least amount out the swap accepts (the floor): the route's amount out less max slippage. */
  minAmountOut: bigint;
  /** Sats per whole token this swap pays (fees included). */
  effectivePrice: number;
  /**
   * Sats per whole token now (0.40.0: the engine's `priceOf` over the pools the page holds — what a
   * buy of 1% of the pooled sats would pay on a buy, a sell of 1% of the pooled tokens on a sell).
   */
  marginalPrice: number;
  /** |effective − marginal| / marginal, basis points. */
  impactBps: number;
  /** What Swap stages (0.40.0). */
  stage: QuoteStage;
  /** The miner fee estimate of one leg, sats. */
  legMinerFeeSats: bigint;
}

/** One leg of a swap that filled (0.40.0). */
export interface LegResult {
  /** The pool output it spent, `<txid>.<vout>`. */
  poolOutpoint: string;
  poolId: string;
  amountIn: bigint;
  amountOut: bigint;
  txid: string;
}

/** Why a swap stopped (0.40.0). */
export type SwapStop = "filled" | "cancelled" | "floor" | "min" | "no_pool" | "fees";

export interface SwapResult {
  /** "filled": every unit filled; "partial": some; "failed": none. */
  status: "filled" | "partial" | "failed";
  stop: SwapStop;
  /** The legs that filled, in order. */
  legs: LegResult[];
  totalIn: bigint;
  totalOut: bigint;
  /** The swap amount not filled. */
  unfilled: bigint;
  /** What went back to the wallet when the swap stopped early (the Move back's), or why it did not. */
  returned?: { txid: string; tokens: bigint } | { error: string };
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
  /** The validator's minimum leg, sats on the leg's sats side (0.40.0; 0: none). */
  minLegSats: number;
}

/** One of the user's pools. A position is only deployed or closed (no add, no partial remove). */
export interface Position {
  /** The pool, `<txid>.<vout>`. */
  outpoint: string;
  /** The pool's id (0.40.0): its deploy outpoint, `<txid>_<vout>`. */
  poolId: string;
  /** The pool's swaps so far. */
  swaps: number;
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

export type { EnabledToken, Defaults, Discovery, ExchangeWallet, PoolRow, PoolsAnswer, Candle, CandleSeries, CandleTf, Holders, PoolAt, PoolHistoryPage, SpendAll, TokenPosition, TokenStats, Trade, TradesPage };
export type { PoolEvent, PoolEventMessage, PoolRevert } from "./lib/overlay.js";
export type { Price } from "./lib/overlay.js";
export { parsePoolEventMessage } from "./lib/overlay.js";

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
    poolId: p.poolId,
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

/**
 * A pools answer's rows as the planner takes them (0.40.0): each pool with its validator's
 * minimum leg (`validators[].minLegSats`, the validator's announced terms).
 */
export function poolsWithMinimums(answer: PoolsAnswer): PoolRow[] {
  const min = new Map(answer.validators.map((v) => [v.identity, v.minLegSats]));
  return answer.pools.map((p) => {
    const m = min.get(p.validatorIdentityKey.toLowerCase());
    return m ? { ...p, minLegSats: m } : p;
  });
}

/** Sats per whole token of an exact pair (`sats` per `tokens` base units), 0 when `tokens` is 0. */
export function pairPrice(p: PricePair, dec: number): number {
  return p.tokens > 0n ? Number(p.sats) / (Number(p.tokens) / 10 ** dec) : 0;
}

/**
 * A leg's sats beyond its amount in (0.40.0, the stage's fee sats): the miner fee estimate plus its
 * 1-sat carriers — on a buy the token payout; on a sell the token fee and commission outputs that
 * are not zero, and the token change.
 */
export function legCarrySats(leg: Pick<Leg, "liquidityFee" | "validationFee" | "commission">, buy: boolean, minerFeeSats: bigint): bigint {
  const carriers = buy ? 1n : BigInt([leg.liquidityFee, leg.validationFee, leg.commission].filter((x) => x > 0n).length + 1);
  return minerFeeSats + carriers;
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

/** The three fees root sets (basis points, integers 0 to 10 000), and (0.40.0) the minimum leg in sats (absent or 0: none). */
export interface TermsInput {
  lpBps: number;
  validatorBps: number;
  commissionBps: number;
  minLegSats?: number;
}


/** The terms as root's messages carry them (0.40.0: `minLegSats` only when above 0). Refused unless each fee is an integer 0 to 10 000 and the minimum a whole number of sats. */
function termsArgs(t: TermsInput): Record<string, number> {
  for (const [k, v] of Object.entries({ lpBps: t.lpBps, validatorBps: t.validatorBps, commissionBps: t.commissionBps })) if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`${k}: an integer, 0 to 10000 basis points`);
  const min = t.minLegSats ?? 0;
  if (!Number.isSafeInteger(min) || min < 0) throw new Error("minLegSats: a whole number of sats, 0 for none");
  return { lpFeeBps: t.lpBps, validatorFeeBps: t.validatorBps, commissionBps: t.commissionBps, ...(min > 0 ? { minLegSats: min } : {}) };
}

/** What a quote was planned from: kept for its execution. */
interface Planned {
  plan: Plan;
  answer: PoolsAnswer;
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

/**
 * Where a swap is (`executeSwap`'s `onProgress`, D12; 0.40.0): `staging` (what the swap basket
 * lacks is staged), `relaying` (a leg sent: its pool outpoint `<txid>.<vout>` and amounts, and the
 * legs filled so far), `repricing` (a leg refused `pool_spent`, the pool's row replaced),
 * `returning` (a swap that stopped early moves its rows back), then `done` or `failed`.
 */
export type SwapProgress =
  | { phase: "staging"; sats: bigint; tokens: bigint }
  | { phase: "relaying"; leg: string; amountIn: bigint; amountOut: bigint; filled: LegResult[] }
  | { phase: "repricing"; leg: string; amountIn: bigint; amountOut: bigint; filled: LegResult[] }
  | { phase: "returning"; filled: LegResult[] }
  | { phase: "done"; result: SwapResult }
  | { phase: "failed"; result?: SwapResult; error?: ClientError | Error };

export interface SwapOptions {
  /** Called as the swap moves (see `SwapProgress`). */
  onProgress?: (p: SwapProgress) => void;
  /** Aborted: the swap stops before its next leg (`cancelled`). */
  signal?: AbortSignal;
}

/** What a client remembers between calls; shared by `withWallet`'s clients. */
interface Shared {
  /** The token list read by this client (D4: once; again only after its own enable or disable). */
  listRead: Promise<EnabledToken[]> | null;
  /** swap's claim card read by this client (D21: the identity of the recipient of root's messages). */
  claimRead: ClaimStatus | null;
  /** What each quote was planned from: kept for its execution. */
  planned: WeakMap<Quote, Planned>;
  /** A swap is running (0.40.0: one at a time). */
  swapping: boolean;
  /** The positions last loaded, by the output a Close acts on (`<txid>.<vout>`): the wallet's row (its LP key) and the token. */
  loaded: Map<string, PositionRow>;
  /** `onDataChange`'s listeners. */
  listeners: Set<() => void>;
}

const newShared = (): Shared => ({ listRead: null, claimRead: null, planned: new WeakMap(), swapping: false, loaded: new Map(), listeners: new Set() });

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

  /** P2 (0.41.0): a token's pools as the host lists them now, read past the browser's cache (`freshFetch`). */
  async function tokenPools(tokenId: TokenId): Promise<PoolsAnswer> {
    return readPools(tokenBase(tokenId, swapBase), freshFetch);
  }

  /**
   * The host's pool event feed (E1, 0.41.0): one token's (`GET /@<token>/amm/events`) or, with
   * `"all"`, every enabled token's (`GET <origin>/amm/events`); each message `{tokenId, …row}` to
   * `onEvent`. Signals for display: the pools route is the truth. → the unsubscribe.
   */
  function watchPoolEvents(tokenId: TokenId | "all", onEvent: (e: PoolEventMessage) => void, onError?: (e: unknown) => void): () => void {
    return watchFeed(eventsUrl(tokenId === "all" ? swapBase : tokenBase(tokenId, swapBase)), onEvent, onError ? { onError } : {});
  }

  // ---------------------------------------------------------------- history (0.39.0, H1–H6)

  /** H1: a token's trades, newest first (`from ≤ at < to` ms, `limit` 1–500, `before` the cursor `next`, 0.40.0 `pool` one pool's by id). */
  async function trades(tokenId: TokenId, o: { from?: number; to?: number; limit?: number; before?: string; pool?: string } = {}): Promise<TradesPage> {
    return readTrades(tokenBase(tokenId, swapBase), o, ff);
  }

  /** H1 with `txid`: one Swap's trade row, null when it has none. */
  async function trade(tokenId: TokenId, txid: string): Promise<Trade | null> {
    return readTrade(tokenBase(tokenId, swapBase), txid, ff);
  }

  /** H2: a token's candles, one per non-empty bucket of `tf` over `from ≤ at < to` (ms); 0.40.0 `series`: `fill` (the trades', default) or `market` (the price after each pool event, the host's). */
  async function candles(tokenId: TokenId, o: { tf: CandleTf; from: number; to: number; series?: CandleSeries }): Promise<Candle[]> {
    return readCandles(tokenBase(tokenId, swapBase), o, ff);
  }

  /** H7 (0.40.0): every pool of the token listed at `t` (ms). */
  async function poolsAt(tokenId: TokenId, t: number): Promise<PoolAt[]> {
    return readPoolsAt(tokenBase(tokenId, swapBase), t, ff);
  }

  /** H8 (0.40.0): the token's pool events in `from ≤ at < to`, oldest first (`pool` one pool's; forward paging: the page's `next` as `after`). */
  async function poolHistory(tokenId: TokenId, o: { from?: number; to?: number; pool?: string; limit?: number; after?: string } = {}): Promise<PoolHistoryPage> {
    return readPoolHistory(tokenBase(tokenId, swapBase), o, ff);
  }

  /** H9 (0.40.0): each outpoint's spender as the host's `/amm/spends` answers it (every enabled token's `/spends`). */
  async function spendsAll(outpoints: string[]): Promise<SpendAll[]> {
    return readSpendsAll(swapBase, outpoints, ff);
  }

  /** H3: a token's stats. */
  async function stats(tokenId: TokenId): Promise<TokenStats> {
    return readStats(tokenBase(tokenId, swapBase), ff);
  }

  /** H4: every enabled token's stats (`ids`: those only, in that order). */
  async function statsAll(o: { ids?: TokenId[]; fresh?: boolean } = {}): Promise<TokenStats[]> {
    return readAllStats(swapBase, o.ids, o.fresh ? freshFetch : ff);
  }

  /** H6: a token's holders, largest first (`limit` 1–100, `skip`). */
  async function holders(tokenId: TokenId, o: { limit?: number; skip?: number } = {}): Promise<Holders> {
    return readHolders(tokenBase(tokenId, swapBase), tokenId, o, ff);
  }

  /** H5: the pools' positions on every enabled token (0.40.0: by pool id). */
  async function positionsAll(poolIds: string[]): Promise<TokenPosition[]> {
    return readAllPositions(swapBase, poolIds, ff);
  }


  /**
   * A quote for one token (D12): the matching engine's plan over the pools the Swap page holds
   * (`held`: the token's pools route's answer — the host listed only pools whose validator is beating
   * and whose commission meets the market's minimum), each pool with its validator's minimum leg
   * (0.40.0); no request. `meta`: the token's symbol and decimals. 0.40.0: the price and impact from
   * the engine's `priceOf` over the same pools (the buy side for a buy, the sell side for a sell);
   * each leg's own fees; what Swap will stage (the swap amount exact, 0.40.2: the fee sats of
   * `maxSources` legs) and the per-leg miner fee estimate.
   */
  function quoteSwap(req: QuoteRequest, held: PoolsAnswer | null, meta: { sym: string; dec: number }): Quote {
    if (req.amountIn <= 0n) throw new Error("Enter an amount");
    if (!held || held.pools.length === 0) throw new Error("No pool to swap against");
    const pools = poolsWithMinimums(held);
    const live = liveOfPools(pools);
    const dec = meta.dec;
    const buy = req.side === "buy";
    const r = buildPlanRequest(
      req.tokenId,
      { direction: buy ? "bsvToToken" : "tokenToBsv", amount: formatAmount(req.amountIn, buy ? 0 : dec), slippageBps: String(req.maxSlippageBps), maxSources: req.maxSources },
      pools,
      live,
      dec,
      feeRate,
    );
    if (!r.ok) throw new Error(r.error);
    const { plan, view } = planQuote(r.request, live, dec);
    if (plan.unfillable === "min") throw new ClientError("below_minimum", `No pool here takes a swap this small: at least ${formatAmount(plan.minAmountIn ?? 0n, buy ? 0 : dec)} ${buy ? "sats" : meta.sym}.`);
    const used = view.legs.filter((l) => l.amountIn > 0n);
    if (used.length === 0 || view.totalOut === 0n) throw new Error("The amount is too small to receive anything");
    const price = priceOf(pools);
    const marginal = price ? pairPrice(buy ? price.buy : price.sell, dec) : 0;
    const totalIn = used.reduce((a, l) => a + l.amountIn, 0n);
    const sats = buy ? totalIn : view.totalOut;
    const tokens = buy ? view.totalOut : totalIn;
    const effective = Number(sats) / (Number(tokens) / 10 ** dec);
    const minerFee = legMinerFeeSats(feeRate);
    const carry = plan.legs.map((l) => legCarrySats(l, buy, minerFee));
    // 0.40.2: the fee sats for EXACTLY maxSources legs — the planned legs' own, each further leg at the largest of theirs.
    const more = BigInt(Math.max(0, req.maxSources - carry.length));
    const feeSats = carry.reduce((a, x) => a + x, 0n) + more * carry.reduce((a, x) => (x > a ? x : a), 0n);
    const q: Quote = {
      request: req,
      legs: used.map((l) => ({
        poolOutpoint: outpointText(l.outpoint),
        poolId: (l.pool as PoolRow).poolId,
        amountIn: l.amountIn,
        amountOut: l.amountOut,
        shareBps: Number((l.amountIn * 10_000n) / req.amountIn),
        reserves: { sats: l.pool.bsvReserve, tokens: l.pool.tokenReserve },
        validator: { identityKey: l.pool.validatorIdentityKey, live: l.validator.live },
        fees: poolFees(l.pool),
      })),
      amountOut: view.totalOut,
      minAmountOut: view.minAmountOut,
      effectivePrice: effective,
      marginalPrice: marginal,
      impactBps: marginal ? Math.round((Math.abs(effective - marginal) / marginal) * 10_000) : 0,
      stage: { amount: req.amountIn, feeSats },
      legMinerFeeSats: minerFee,
    };
    planned.set(q, { plan, answer: held, dec, sym: meta.sym });
    return q;
  }

  /** The overlay pass over the swap basket (item 5, src/wallet/swapPayouts.ts): ONE `/amm/spends`, each spender's `/tx`, this wallet's legs taken in. */
  function resolve(wallet: WalletInterface): Promise<ResolvedLeg[]> {
    return resolveFromOverlay(wallet, { spendsAll: (ops) => readSpendsAll(swapBase, ops, freshFetch), tx: (tokenId, txid) => readTx(tokenBase(tokenId, swapBase), txid, freshFetch) });
  }

  /**
   * Runs a quoted swap with the connected wallet (0.40.0, agent-env plans/swap-balance-build-2026-11-05.md
   * §0 7, Builder 2 item 4): ONE swap at a time, legs ONE AT A TIME.
   *
   *   1. The overlay pass (`resolve`); then what `amm-swap` lacks of what the plan needs — the swap
   *      amount exact, the sats for the carriers and miner fees of `maxSources` legs —
   *      staged by ONE `stage` (`staging`).
   *   2. The loop: cancelled → `cancelled`; the SERVER's pool list read fresh (`GET
   *      /@<token>/amm/pools`, no cache; 0.41.0: before EACH leg, no list of its own kept);
   *      `nextLeg` over it minus the excluded outpoints, `minOut` the quote's floor less what has
   *      filled, `maxSources` (0.40.2) the request's less the legs filled → its stop ends the swap;
   *      the pool's current output read by its id (`GET /pools/beef?pool=`; moved → the list read
   *      again); the staged rows that cover the leg, else `fees`; built, signed, relayed
   *      (`relaying`):
   *      - accepted → taken in (ONE internalizeAction) before the next leg;
   *      - refused `pool_spent` (`repricing`) → the list read again: the relaying host took the
   *        validator's state in before it answered (0.41.0);
   *      - refused otherwise (`below_minimum` included) → that outpoint excluded;
   *      - no answer → (a) the overlay: a staged input spent → the leg landed (taken in by the
   *        pass), the pool spent by another's swap → continue with the same rows; (b) else the
   *        same leg sent ONCE more to the same validator; (c) still none → that outpoint excluded
   *        (the next leg races it with the same rows);
   *      - after any refusal: the overlay pass.
   *   3. Filled completely: the last leg's change went to the wallet, nothing left. Stopped early with
   *      rows left: `moveBack` (one wallet action, `returning`); declined or failed → the rows stay.
   */
  async function executeSwap(quote: Quote, o: SwapOptions = {}): Promise<SwapResult> {
    const progress = (x: SwapProgress) => {
      try {
        o.onProgress?.(x);
      } catch {
        /* the caller's callback: not the swap's failure */
      }
    };
    if (s.swapping) throw new Error("A swap is already running: one at a time");
    s.swapping = true;
    let result: SwapResult;
    try {
      result = await runSwap(quote, progress, o.signal);
    } catch (e) {
      const err = toClientError(e);
      progress({ phase: "failed", error: err instanceof Error ? err : new Error(String(err)) });
      throw err;
    } finally {
      s.swapping = false;
    }
    emit();
    progress(result.status === "failed" ? { phase: "failed", result } : { phase: "done", result });
    return result;
  }

  async function runSwap(quote: Quote, progress: (x: SwapProgress) => void, signal?: AbortSignal): Promise<SwapResult> {
    const { wallet, signedFor } = needWallet();
    const p = planned.get(quote);
    if (!p) throw new Error("Quote again: this quote was not planned here");
    const tokenId = quote.request.tokenId;
    const base = tokenBase(tokenId, swapBase);
    const af = signedFor(base);
    const buy = quote.request.side === "buy";
    const direction = buy ? "bsvToToken" : "tokenToBsv";
    const minerFee = legMinerFeeSats(feeRate);
    const meta = { sym: p.sym, dec: p.dec };

    // 0.41.0: the server's list, read fresh before each leg; the outpoints excluded (a pool that refused other than pool_spent, or did not answer).
    const excluded = new Set<string>();
    /** 0.40.2: the legs the order may still fill (the request's maxSources less the legs filled). */
    let budget = quote.request.maxSources;

    const legs: LegResult[] = [];
    let filledIn = 0n;
    let filledOut = 0n;
    let order: string | undefined;
    /** Legs sent with no answer yet: what they spend, to account a later take-in by the overlay pass. */
    const pending: { prepared: PreparedSwap; leg: Leg; poolId: string }[] = [];
    const accountResolved = (taken: ResolvedLeg[]) => {
      for (const t of taken) {
        const i = pending.findIndex((x) => x.prepared.satsInputs.some((r) => t.inputs.includes(r.outpoint)));
        if (i < 0) continue;
        const [x] = pending.splice(i, 1);
        order ??= x!.prepared.order;
        budget -= 1;
        filledIn += x!.leg.amountIn;
        filledOut += x!.leg.amountOut;
        legs.push({ poolOutpoint: outpointText(x!.leg.outpoint), poolId: x!.poolId, amountIn: x!.leg.amountIn, amountOut: x!.leg.amountOut, txid: t.txid });
      }
    };

    accountResolved(await resolve(wallet));
    // 1. Stage what the basket lacks.
    const needTokens = buy ? 0n : quote.stage.amount;
    const needSats = (buy ? quote.stage.amount : 0n) + quote.stage.feeSats;
    const haveSats = BigInt(await swapSatsTotal(wallet));
    const haveTokens = buy ? 0n : (await swapHoldings(wallet, tokenId)).reduce((a, t) => a + t.amount, 0n);
    const lackSats = needSats > haveSats ? needSats - haveSats : 0n;
    const lackTokens = needTokens > haveTokens ? needTokens - haveTokens : 0n;
    if (lackSats > 0n || lackTokens > 0n) {
      progress({ phase: "staging", sats: lackSats, tokens: lackTokens });
      await stage(wallet, { sats: Number(lackSats), ...(lackTokens > 0n ? { tokens: { tokenId, amount: lackTokens } } : {}) }, { sym: p.sym, submit: submitAt(base) });
    }

    // 2. The loop.
    let why: SwapStop = "filled";
    for (;;) {
      if (signal?.aborted) {
        why = "cancelled";
        break;
      }
      const remaining = quote.request.amountIn - filledIn;
      const answer = await tokenPools(tokenId);
      const pools = poolsWithMinimums(answer).filter((r) => !excluded.has(r.outpoint));
      const minOut = quote.minAmountOut > filledOut ? quote.minAmountOut - filledOut : 0n;
      const next = nextLeg({ pools, direction, remaining, fixedCost: { minerFeeSats: minerFee }, minOut, maxSources: budget });
      if ("stop" in next) {
        why = next.stop;
        break;
      }
      const leg = next.leg;
      const row = pools.find((x) => x.outpoint === leg.outpoint)!;
      const fresh = await readPoolsBeef(base, [row.poolId], freshFetch);
      const now = fresh.pools.find((x) => x.poolId === row.poolId);
      if (!now) {
        excluded.add(row.outpoint);
        continue;
      }
      // Moved since the list was read: read the list again.
      if (now.outpoint !== row.outpoint) continue;
      const poolOutput = poolOutputOf(fresh, leg.outpoint);
      const peerId = row.validatorPeerId ?? answer.validators.find((v) => v.identity === row.validatorIdentityKey.toLowerCase())?.peerId;
      if (!poolOutput || !peerId) {
        excluded.add(row.outpoint);
        continue;
      }
      const common: PlanLegInput = { wallet, tokenId, meta, direction, leg, pool: row, poolOutput, commissionPkh: answer.market.commissionPkh, satsPerKb: feeRate };
      const inputs = selectLegInputs(common, await swapSatsHoldings(wallet), buy ? [] : await swapHoldings(wallet, tokenId));
      if (!inputs) {
        why = "fees";
        break;
      }
      const prepared = await prepareSwap({ ...common, inputs, ...(order ? { order } : {}), last: leg.amountIn === remaining, holdingBeef: await swapHoldingBeef(wallet) });
      const at = { leg: outpointText(leg.outpoint), amountIn: leg.amountIn, amountOut: leg.amountOut };
      progress({ phase: "relaying", ...at, filled: [...legs] });
      let outcome = await relayLeg(wallet, af, base, prepared, peerId);
      if (outcome.status === "unknown" || outcome.status === "timeout") {
        // (a) The overlay: what the leg spends.
        const spent = await readSpendsAll(swapBase, [outpointText(leg.outpoint), ...inputs.sats.map((r) => r.outpoint), ...inputs.tokens.map((r) => r.outpoint)], freshFetch).catch(() => [] as SpendAll[]);
        const ours = spent.find((x) => x.spentBy && x.outpoint !== outpointText(leg.outpoint));
        if (ours) {
          pending.push({ prepared, leg, poolId: row.poolId });
          accountResolved(await resolve(wallet));
          continue;
        }
        if (spent.some((x) => x.spentBy && x.outpoint === outpointText(leg.outpoint))) continue;
        // (b) Once more to the same validator.
        outcome = await relayLeg(wallet, af, base, prepared, peerId);
        if (outcome.status === "unknown" || outcome.status === "timeout") {
          // (c) Race: the next leg to another pool with the same rows.
          pending.push({ prepared, leg, poolId: row.poolId });
          excluded.add(row.outpoint);
          continue;
        }
      }
      if (outcome.status === "accepted") {
        if (!outcome.completed.internalized) {
          pending.push({ prepared, leg, poolId: row.poolId });
          accountResolved(await resolve(wallet));
          continue;
        }
        order ??= prepared.order;
        budget -= 1;
        filledIn += leg.amountIn;
        filledOut += leg.amountOut;
        legs.push({ poolOutpoint: at.leg, poolId: row.poolId, amountIn: leg.amountIn, amountOut: leg.amountOut, txid: outcome.txid });
        continue;
      }
      if (outcome.status === "refused" && outcome.reason.startsWith("pool_spent")) {
        // The relaying host took the validator's state in before it answered: the next read lists it.
        progress({ phase: "repricing", ...at, filled: [...legs] });
      } else {
        excluded.add(row.outpoint);
      }
      accountResolved(await resolve(wallet));
    }

    // 3. The end.
    const out: SwapResult = { status: filledIn >= quote.request.amountIn ? "filled" : legs.length > 0 ? "partial" : "failed", stop: why, legs, totalIn: filledIn, totalOut: filledOut, unfilled: quote.request.amountIn - filledIn };
    if (why !== "filled" && pending.length === 0) {
      const left = (await swapSatsHoldings(wallet)).length + (await swapHoldings(wallet, tokenId)).length;
      if (left > 0) {
        progress({ phase: "returning", filled: [...legs] });
        try {
          const m = await moveBack({ wallet, base: swapBase, tokenId, meta: { sym: p.sym }, submit: submitAt(swapBase) });
          out.returned = { txid: m.txid, tokens: m.amount };
        } catch (e) {
          out.returned = { error: errText(e) };
        }
      }
    }
    return out;
  }

  /** One relay of a prepared leg (0.34.0: no browser note); a thrown error is no answer. */
  function relayLeg(wallet: WalletInterface, af: Signed, base: string, prepared: PreparedSwap, peerId: string): Promise<SwapOutcome> {
    return relaySwap({ wallet, authFetch: af, base }, prepared, peerId).catch((e): SwapOutcome => ({ status: "unknown", id: swapIdOf(prepared), reason: errText(e) }));
  }

  /** A plain GET past the browser's short cache (`state` class: max-age 5): what a swap is about to spend must be read now. */
  const freshFetch = (url: string, init?: RequestInit) => f(url, { ...init, cache: "no-cache" });

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
    // The rows by token, one per pool id (0.40.0: the deploy outpoint is the pool's id).
    const byToken = new Map<string, Map<string, PositionRow>>();
    for (const row of positionRowsOf(mergePoolRows(history, poolRows))) {
      if (!row.lpPubKey || !enabled.has(row.tokenId)) continue;
      const ids = byToken.get(row.tokenId) ?? new Map<string, PositionRow>();
      const poolId = row.deployOutpoint.replace(".", "_");
      if (!ids.has(poolId)) ids.set(poolId, row);
      byToken.set(row.tokenId, ids);
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
        const row = keys.get(p.poolId);
        const fees = { feesEarnedSats: p.sats, feesEarnedTokens: p.tokens };
        if (!row) continue;
        if (p.status === "closed" || !p.outpoint || !p.current) {
          closed.push({ outpoint: row.deployOutpoint, poolId: p.poolId, swaps: p.swaps, tokenId, ...meta, sats: 0n, tokens: 0n, validator: { identityKey: row.validatorIdentity ?? "", live: false }, closed: true, ...fees });
          continue;
        }
        const outpoint = p.outpoint.replace("_", ".");
        loaded.set(outpoint, row);
        // D23: the deploy's row, filed from the wallet's record while the pool is still at the deploy's output.
        if (p.status === "live" && outpoint === row.deployOutpoint && !filed.has(outpoint)) await fileDeployRow(wallet, base, history, outpoint, meta);
        out.push({
          outpoint,
          poolId: p.poolId,
          swaps: p.swaps,
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
    return { validator: { identityKey: t.identity, live: Boolean(t.peerId) }, isThisExchange: true, fees: { lpBps: t.lpFeeBps, validatorBps: t.validatorFeeBps, commissionBps: t.commissionBps }, minLegSats: t.minLegSats };
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
   * pays the miner fee). 0.40.0: the pool's current output and its BEEF by its pool id (`GET
   * /@<token>/amm/pools/beef?pool=<deploy outpoint>`); the page's submit at the host root (D19).
   */
  async function closePosition(req: CloseRequest): Promise<CloseResult> {
    const { wallet } = needWallet();
    let row = loaded.get(req.outpoint);
    if (!row) {
      await myPositions();
      row = loaded.get(req.outpoint);
    }
    if (!row) throw new Error("No such position");
    const [meta, base] = await Promise.all([tokenMeta(), tokenBaseOf(row.tokenId)]);
    const m = meta.get(row.tokenId);
    const poolOutput = poolOutputOf(await readPoolsBeef(base, [row.deployOutpoint.replace(".", "_")], freshFetch), req.outpoint);
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
   * wallet's change. The old pool's output and BEEF by its pool id (`GET
   * /@<token>/amm/pools/beef?pool=<id>`); the page's submit at the host root; the new pool's row
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
    if (!row) throw new Error("No such position");
    const [terms, held, meta, base] = await Promise.all([instanceTerms(row.tokenId), heldOutputs(wallet), tokenMeta(), tokenBaseOf(row.tokenId)]);
    const v = terms.validator;
    if (!v) throw new Error(NO_VALIDATOR);
    const m = meta.get(row.tokenId);
    const poolOutput = poolOutputOf(await readPoolsBeef(base, [row.deployOutpoint.replace(".", "_")], freshFetch), req.outpoint);
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
      swapTotals(wallet).catch(() => new Map<string, { amount: bigint; outputs: number }>()),
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
        onExchange: registered.has(tokenId),
      };
    });
    return out.filter((t) => t.balance > 0n || t.inSwaps > 0n).sort((a, b) => a.sym.localeCompare(b.sym) || a.tokenId.localeCompare(b.tokenId));
  }

  /**
   * The pass on load (0.40.0, src/wallet/swapPayouts.ts, src/market/activeSwap.ts): a labelled
   * staged token output the swap basket lacks filed from its action's description (its BEEF `GET
   * /@<token>/amm/tx?id=`), then the overlay pass over every `amm-swap` row (ONE `/amm/spends`, each
   * spender's `/tx`, this wallet's legs taken in). Nothing shown; a take-in reloads the pages' data.
   * Never throws. → the txids taken in.
   */
  async function settleSwaps(): Promise<string[]> {
    if (!boundWallet) return [];
    let filed = false;
    try {
      for (const u of await unfiledStagedTokens(boundWallet)) {
        const beef = await readTx(tokenBase(u.tokenId, swapBase), u.txid, freshFetch).catch(() => null);
        if (beef && (await fileStagedToken(boundWallet, u, beef).catch(() => false))) filed = true;
      }
    } catch {
      /* the next load */
    }
    const taken = (await resolve(boundWallet)).map((t) => t.txid);
    if (filed || taken.length > 0) emit();
    return taken;
  }

  /** The sats in the swap basket (0.40.0: shown once, not per token). */
  async function swapBasketSats(): Promise<number> {
    const { wallet } = needWallet();
    return swapSatsTotal(wallet);
  }

  /** "Move back" of the swap basket's sats alone (0.40.0, src/market/activeSwap.ts `moveBackSats`): one plain createAction, the sats rows its inputs, no outputs. */
  async function moveBackStagedSats(): Promise<MovedBack> {
    const { wallet } = needWallet();
    const r = await moveBackSats(wallet);
    emit();
    return r;
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
   * validatorFeeBps, commissionBps, minLegSats?}}}` to the config instance's `<app>/admin` — a new
   * token instance's initial terms (its own `amm/terms`, root's message to `/@<tokenId>`, wins once
   * written). Refused here unless each fee is an integer 0 to 10 000 (0.40.0: and the minimum leg a
   * whole number of sats; 0 or absent is none and is not sent).
   */
  async function setDefaultTerms(t: TermsInput): Promise<void> {
    await sendDefaults({ terms: termsArgs(t) });
  }

  /** One token's validator terms as its instance holds them (0.35.0; P7 `GET /@<token>/amm/terms`, plain): the three fees, or null (a market only). */
  async function tokenTerms(tokenId: TokenId): Promise<InstanceTerms["validator"]> {
    return (await instanceTerms(tokenId)).validator;
  }

  /**
   * Sets one token's validator terms (0.35.0, open-exchange 0.12.0): root's `{fn: "terms", args:
   * {tokenId, terms: {lpFeeBps, validatorFeeBps, commissionBps, minLegSats?} | null}}` to the swap instance's
   * `<app>/admin`; swap emits it as a fact and the host sends it to the token's instance as root's
   * `terms` (null: a market only). Nothing answers back: the token's `/terms` shows the result.
   * Refused here unless each fee is an integer 0 to 10 000.
   */
  async function setTokenTerms(tokenId: TokenId, t: TermsInput | null): Promise<void> {
    const terms = t ? termsArgs(t) : null;
    const { signedFor } = needWallet();
    const me = await swapIdentity();
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

  /**
   * Sets the price to enable a token (0.42.0, open-exchange 0.15.0): the admin's `{fn: "price", args: {sats}}`
   * to swap's `<app>/admin`; the host sets it as the price of `POST /amm/enable` (any signed sender enables a
   * token for it). `null` turns the paid enable off. Refused here unless a whole number of sats, 1 or more.
   */
  async function setEnablePrice(sats: number | null): Promise<void> {
    if (sats !== null && (!Number.isSafeInteger(sats) || sats < 1)) throw new Error("sats: a whole number, 1 or more (or null: off)");
    const { signedFor } = needWallet();
    const me = await swapIdentity();
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "price", args: { sats } });
    emit();
  }

  /** The exchange's wallet (0.42.0, open-exchange 0.15.0; `GET <swap>/wallet`, the host's read): the sats swap's wallet holds and its coin count. */
  async function exchangeWallet(): Promise<ExchangeWallet> {
    return readWallet(swapBase, ff);
  }

  /** A withdrawal's payment taken in by the admin's wallet: `internalizeAction`, output `outputIndex` as a wallet payment from swap (BRC-29, ts-stack's recipient side). */
  async function takeInWithdrawal(wallet: WalletInterface, x: ExchangeWallet["withdrawals"][number], tx: number[]): Promise<boolean> {
    const r = await wallet.internalizeAction({
      tx,
      outputs: [{ outputIndex: x.outputIndex, protocol: WALLET_PAYMENT, paymentRemittance: { derivationPrefix: x.derivationPrefix, derivationSuffix: x.derivationSuffix, senderIdentityKey: x.senderIdentityKey } }],
      description: `Open Exchange withdraw ${x.n}`,
    });
    return r.accepted;
  }

  /** Withdrawal `n`'s Atomic BEEF (`GET <swap>/wallet/tx?n=`). */
  async function withdrawalTx(n: number): Promise<number[]> {
    const res = await freshFetch(`${swapBase}/wallet/tx?n=${n}`);
    if (!res.ok) throw new Error(`GET ${swapBase}/wallet/tx?n=${n}: ${res.status}`);
    return Array.from(new Uint8Array(await res.arrayBuffer()));
  }

  /**
   * Withdraws everything in the exchange's wallet to the admin's own (0.42.1, open-exchange 0.15.2): the admin's
   * `{fn: "withdraw"}` to swap's `<app>/admin`. swap's program pays every coin to a BRC-29 key derived for the
   * sender and hands the transaction over unsent; this function waits for the read to list it (`GET <swap>/wallet`,
   * at most 10 s — the message's answer reaches no page), then takes it in (`internalizeAction`, a wallet payment:
   * that is what sends it). → the withdrawal.
   */
  async function withdrawAll(): Promise<ExchangeWallet["withdrawals"][number]> {
    const { wallet, signedFor } = needWallet();
    const w = await readWallet(swapBase, freshFetch as typeof fetch);
    if (w.sats <= 0) throw new Error("the exchange's wallet holds nothing to withdraw");
    const me = await swapIdentity();
    await sendMessage(signedFor(swapBase), swapBase, me, `${app()}/admin`, { fn: "withdraw" });
    let x: ExchangeWallet["withdrawals"][number] | undefined;
    for (let i = 0; i < 40 && !x; i++) {
      await new Promise((r) => setTimeout(r, 250));
      x = (await readWallet(swapBase, freshFetch as typeof fetch)).withdrawals.find((y) => y.n > w.withdrawals.length);
    }
    if (!x) throw new Error("the exchange has not answered the withdraw yet: Settings takes it in when it does");
    if (!(await takeInWithdrawal(wallet, x, await withdrawalTx(x.n)))) throw new Error("the wallet did not accept the withdrawal");
    emit();
    return x;
  }

  /**
   * The latest withdrawal taken in again (0.42.1; on Settings load): for a page lost between the withdraw's answer
   * and its take-in (taking in a payment the wallet holds is harmless). Never throws. → its txid, or none.
   */
  async function settleWithdrawals(): Promise<string[]> {
    if (!boundWallet) return [];
    try {
      const w = await readWallet(swapBase, freshFetch as typeof fetch);
      const x = w.withdrawals.at(-1);
      if (!x) return [];
      return (await takeInWithdrawal(boundWallet, x, await withdrawalTx(x.n))) ? [x.txid] : [];
    } catch {
      return [];
    }
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
    tokenPools: guard(tokenPools),
    watchPoolEvents,
    // history (0.39.0)
    trades: guard(trades),
    trade: guard(trade),
    candles: guard(candles),
    poolsAt: guard(poolsAt),
    poolHistory: guard(poolHistory),
    spendsAll: guard(spendsAll),
    stats: guard(stats),
    statsAll: guard(statsAll),
    holders: guard(holders),
    positionsAll: guard(positionsAll),
    registeredTokens: guard(registeredTokens),
    // swap
    quoteSwap,
    executeSwap,
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
    swapBasketSats: guard(swapBasketSats),
    moveBackStagedSats: guard(moveBackStagedSats),
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
    setEnablePrice: guard(setEnablePrice),
    exchangeWallet: guard(exchangeWallet),
    withdrawAll: guard(withdrawAll),
    settleWithdrawals,
  };
}
