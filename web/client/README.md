# @dcasegr/amm-client

The Open Exchange client (skein-amm): every read and every action the Open Exchange pages make —
the token list, prices, quotes and swaps, pool deploy / close / rebalance, Move back, positions,
the root's settings — over a BRC-100 wallet, bound by `createClient` to one exchange. ESM with
type declarations; no React, no styles, no wallet provider (connect the wallet yourself and pass
it in). The source is skein-amm's `web/ui/src` (the pages' own); the matching engine is
[`@dcasegr/amm-engine`](../engine). Versions follow the skein-amm release.

## Install

```
npm install @dcasegr/amm-client @bsv/sdk @1sat/templates @bsv/color-permission-module
```

`@bsv/sdk` (4), `@1sat/templates` and `@bsv/color-permission-module` are peer dependencies: one
copy, the wallet's. The wallet must carry the BRC-207 1Color module (`@bsv/color-permission-module`)
for the token actions.

## createClient

```ts
import { createClient } from "@dcasegr/amm-client";

const client = createClient({
  origin: "https://swap.skein.nexus", // the exchange: an origin (the swap app at <origin>/amm) or the app's base URL
  feeRateSatsPerKb: 100,              // the miner fee rate a swap leg's staged sats are sized with (default 100)
  wallet,                             // a BRC-100 WalletInterface; null or absent: reads only
  fetch,                              // optional: the plain fetch (default the global one)
});
```

`createClient(opts: ClientOptions): AmmClient`, where `ClientOptions` is `{ origin: string;
feeRateSatsPerKb?: number; wallet?: WalletInterface | null; fetch?: FetchLike; signedFor?: (base)
=> Signed; identityKey?: string | null }` (`signedFor`: the wallet's BRC-104 client per instance,
default one `AuthFetch` session per instance; `identityKey`: default read from the wallet when
needed). Nothing reads `import.meta.env` or `location`. `client.withWallet(wallet)` is the same
exchange with another wallet, keeping what was read and quoted.

The client (each an async function unless noted):

- the exchange: `enabledList`, `registeredTokens`, `tokenBaseOf`, `hostedTokens` (the token list
  and ONE `GET /amm/stats`), `tokenPools(tokenId)` (0.41.0: the token's pools route, a plain
  read past the browser's cache), `watchPoolEvents(tokenId | "all", onEvent)` (0.41.0: the host's
  pool event feed, `/@<token>/amm/events` or `<origin>/amm/events`; each message `{tokenId, …row}`,
  a `/pools/history` row or a `revert`; signals for display, the pools route the truth; sync,
  returns the unsubscribe; reconnect is the browser EventSource's),
  `claimStatus`, `isRoot`, `claimExchange`, `discoveryBase` (sync), `onDataChange` (sync);
- history (plain GETs; 0.40.0: by pool id, `poolId` = the pool's deploy outpoint `<txid>_<vout>`):
  `trades(tokenId, {from?, to?, limit?, before?, pool?})` → `{trades, next}` (each row its
  `poolId` and `payoutPkh`), `trade(tokenId, txid)` → a `Trade` or null, `candles(tokenId, {tf,
  from, to, series?})` (`series` `fill`, the default, or `market`), `stats(tokenId)` /
  `statsAll({ids?, fresh?})` (`price` = the midpoint of what a buy and a sell of 1% of the pooled sats
  would pay now, `buyPrice`, `sellPrice`, `lastTradePrice`), `holders(tokenId, {limit?, skip?})` →
  `{count, rows}`, `positionsAll(poolIds)`, `poolsAt(tokenId, t)` (every pool listed at `t`),
  `poolHistory(tokenId, {from?, to?, pool?, limit?, after?})` → `{events, next}` (oldest first;
  forward paging: `next` as `after`), `spendsAll(outpoints)` (the host's `/amm/spends`); amounts
  bigints, prices `{sats, tokens}` pairs of bigints (base units both);
- swap: `quoteSwap(request, poolsAnswer, {sym, dec})` (sync: the engine's plan over the pools the
  token's pools route gave, each pool with its validator's `minLegSats`; the quote's price and
  impact from the engine's `priceOf`, each leg's own `fees`, `stage` = what Swap sets aside
  (`amount`, `feeSats`: 0.40.2, exactly `maxSources` legs), `legMinerFeeSats`); the request's
  `maxSources` (required, 0.40.2; replaces `allowPartial`) is the most pools the swap may draw on —
  1 is exactly one leg; the Open Exchange pages send 1 or 5,
  `executeSwap(quote, {onProgress, signal})` (below), `walletSats`;
- liquidity: `myPositions`, `validatorTerms`, `deployPosition({tokenId, tokens, sats})`,
  `closePosition({outpoint})`, `rebalancePosition({outpoint, tokens, sats})` (the old pool closed
  and a new one deployed in ONE wallet createAction);
- your tokens: `myTokens`, `settleSwaps` (the pass over the swap basket: a staged token output the
  basket lacks filed from its action's description; then every row's spender, this wallet's legs
  taken in: the txids), `swapBasketSats`, `moveBackTokens(tokenId)` (every row of the token and
  every sats row: txid, amount, BEEF, submit), `moveBackStagedSats` (the sats alone), `sendTokens`;
- settings (root): `deployBeef`, `enableToken`, `tokensToEnable`, `disableToken`, `defaults`,
  `setDefaultTerms`, `clearDefaultTerms`, `setDefaultMarket`, `clearDefaultMarket`, `tokenTerms`,
  `setTokenTerms` (0.40.0: the terms `{lpBps, validatorBps, commissionBps, minLegSats?}`), `discoveryState`, `setDiscovery`,
  `setEnablePrice`, `exchangeWallet`, `withdrawAll`, `settleWithdrawals` (0.42.x);
- the paid enable (0.42.2, anyone signed; open-exchange 0.15.3): `enableTokenPaid(tokenId, {deployBeef?})` — the price
  from `/amm/defaults`, a BRC-29 payment to the exchange built as a protected noSend (0.42.3: BRC-177, `p nosend expiry seconds 600`; not sent: the exchange's take-in sends it),
  ONE BEEF with the deploy and the payment, `POST /amm/enable?tokenId=&paymentTxid=&paymentVout=&derivationPrefix=
  &derivationSuffix=` signed; the enabled row back; on any refusal or failure the unsent payment is aborted
  (`abortAction`). Refusals are `ClientError` kind `refused`, the exchange's code first in the message.

Pure helpers beside it: `hostedFrom`, `parsePoolEventMessage`, `poolViews`, `poolFees`, `poolsWithMinimums`, `pairPrice`, `legCarrySats`, `hasTerms`,
`enableCandidates`, `topicOf`, `lookupOf`, `ammLookupOf`, `walletDeployBeef`, `exchangeBase`,
`tokenBase`; the types (`Quote`, `SwapResult`, `LegResult`, `Position`, `WalletToken`, …).

## Errors

An error of one of `CLIENT_ERROR_KINDS` is a `ClientError` with `kind` and the message the pages
show: `stale_pool`, `fee_mismatch`, `quote_mismatch`, `slippage`, `pool_spent`, `user_rejected`,
`no_answer`, `below_minimum` (0.40.0: under a validator's minimum leg; a quote no pool takes),
`refused`, `network`. `errorKind(e)` classifies any error; other errors stay plain `Error`s.

## The shared names

What two sites must use to file identical wallet rows: `POOLS_BASKET` (`amm-pools`, the LP's
position rows), `SWAP_BASKET` (`amm-swap`, what swap legs spend), `SWAP_PROTOCOL` (`[2, "amm
swap"]`), `SWAP_KEY_PREFIX` + `newSwapKeyID` (a staged row's random keyID), `changeKeyID` (a leg's
change row: `amm-swap-<txid>.<vout>:change` of its first input of that kind), `SWAP_STAGE_LABEL`
(`amm-swap-stage`) + `SWAP_KEY_MARK` + `swapKeyDescription` / `swapKeyIdOfDescription` (a staged
token output's description naming its key), `legDerivation` (an order's payout, own commission and
last-leg change keys), `swapInstructions` / `swapSatsInstructions` (their customInstructions, a
change row's with `order`), `LP_KEY_PROTOCOL` (BRC-29) + `LP_KEY_MARK` +
`lpKeyDescription` / `lpKeyIdOfDescription` (the deploy's pool output description naming the LP
keyID), `POOL_TAG` / `POOL_OP` / `isPoolRow` / `poolCustomInstructions` (an `amm-pools` row),
`POOL_DEPLOY_LABEL` (`amm-pool-deploy`), `LEG_PATIENCE_MS` (15 s: how long a swap leg waits for the host's answer before closing the request; 0.44.0, was the swap's expiry), `transferPlanLabels` (the `p color
plan` labels), the receipt helpers `newReceivingKey` / `receiptOutput`, and `xTopics` (the BRC-22
`x-topics` header: a JSON array).

## A swap

```ts
import { createClient, ClientError } from "@dcasegr/amm-client";

const client = createClient({ origin: "https://swap.skein.nexus", wallet });
const tokenId = "<txid>_0";

// The token's pools route: the pools a swap may use, the market (read again on a pool event).
const pools = await client.tokenPools(tokenId);
const quote = client.quoteSwap({ tokenId, side: "buy", amountIn: 50_000n, maxSlippageBps: 50, maxSources: 1 }, pools, { sym: "TOK", dec: 0 });
try {
  const cancel = new AbortController();
  const result = await client.executeSwap(quote, { signal: cancel.signal, onProgress: (p) => console.log(p.phase) });
  console.log(result.status, result.stop, result.legs, result.returned);
} catch (e) {
  if (e instanceof ClientError) console.log(e.kind, e.message);
  else throw e;
}
```

`executeSwap` (0.40.0; 0.40.2: at most `maxSources` legs, the budget down by one per FILLED leg —
a refused or unanswered leg does not count, the last leg takes all that remains): ONE swap at a time. First the pass over the swap basket, then ONE wallet
action stages what `amm-swap` lacks of `quote.stage` (sats only: a plain createAction; a sell's
tokens: the module transfer). Then legs one at a time: the SERVER's pool list read fresh (0.41.0:
`GET /@<token>/amm/pools` before EACH leg; the client keeps no list of its own), the engine's
`nextLeg` over it (`minOut` = the quote's floor less what has filled), the pool's current output by
its id (`/pools/beef?pool=`), the staged rows that cover the leg (largest first), built, signed,
relayed; accepted → taken in (payout, own commission, change) before the next leg; refused
`pool_spent` → the list read again (the relaying host took the validator's state in before it
answered, 0.41.0); refused otherwise → that pool output excluded; no answer → the overlay
(a staged input spent: the leg landed), else sent once more, else raced on another pool. It stops
`filled | cancelled | floor | min | no_pool | fees`. Filled: the last leg's change went to the
wallet. Stopped early with rows left: `moveBack` runs itself (`result.returned`). Progress phases:
`staging`, `relaying` / `repricing` (the leg's pool, amounts and the legs filled so far),
`returning`, `done` / `failed`. The result: `{status, stop, legs: [{poolOutpoint, poolId,
amountIn, amountOut, txid}], totalIn, totalOut, unfilled, returned?}`.

## Build

From skein-amm's `web/`: `npm ci` in `ui` and in `engine`, then `npm pack` here (the build
compiles `../ui/src/index.ts` with `../ui`'s TypeScript into `dist/`, after building the engine).

runar-sdk is vendored inside (`dist/vendor/runar`, MIT: its `LICENSE` and `NOTICE` there): the
runar-sdk the pool template is built on is not published.
