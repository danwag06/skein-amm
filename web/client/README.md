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
  and ONE `GET /amm/stats`), `watchTokenPools` (the token's pools route as an event stream: the
  whole answer, then each `change` — `swap`, `deploy`, `close`, `rescind` — applied to it, one it
  cannot apply read again once; sync, returns the unsubscribe; 0.39.0: no host-wide stream),
  `claimStatus`, `isRoot`, `claimExchange`, `discoveryBase` (sync), `onDataChange` (sync);
- history (0.39.0, plain GETs): `trades(tokenId, {from?, to?, limit?, before?, lp?})` →
  `{trades, next}`, `trade(tokenId, txid)` → a `Trade` or null, `candles(tokenId, {tf, from, to})`,
  `stats(tokenId)`, `statsAll({ids?})`, `holders(tokenId, {limit?, skip?})` → `{count, rows}`,
  `positionsAll(lpKeys)` (every enabled token's positions); amounts bigints, prices `{sats,
  tokens}` pairs of bigints (base units both);
- swap: `quoteSwap(request, poolsAnswer, {sym, dec})` (sync: the engine's plan over the pools the
  token's pools stream gave), `executeSwap(quote, {onProgress})`, `checkSwapAgain(leg)`,
  `walletSats`;
- liquidity: `myPositions`, `validatorTerms`, `deployPosition({tokenId, tokens, sats})`,
  `closePosition({outpoint})`, `rebalancePosition({outpoint, tokens, sats})` (the old pool closed
  and a new one deployed in ONE wallet createAction);
- your tokens: `myTokens`, `settleSwaps` (the silent pass over staged swap legs: the txids taken
  in), `moveBackTokens(tokenId)` (what it did: txid, amount, BEEF, submit), `sendTokens`;
- settings (root): `deployBeef`, `enableToken`, `tokensToEnable`, `disableToken`, `defaults`,
  `setDefaultTerms`, `clearDefaultTerms`, `setDefaultMarket`, `clearDefaultMarket`, `tokenTerms`,
  `setTokenTerms`, `discoveryState`, `setDiscovery`.

Pure helpers beside it: `hostedFrom`, `applyPoolChange`, `parseChange`, `poolViews`, `poolFees`, `withLeg`, `hasTerms`,
`enableCandidates`, `topicOf`, `lookupOf`, `ammLookupOf`, `walletDeployBeef`, `exchangeBase`,
`tokenBase`; the types (`Quote`, `SwapResult`, `LegResult`, `Position`, `WalletToken`, …).

## Errors

An error of one of `CLIENT_ERROR_KINDS` is a `ClientError` with `kind` and the message the pages
show: `stale_pool`, `fee_mismatch`, `quote_mismatch`, `slippage`, `pool_spent`, `user_rejected`,
`no_answer`, `refused`, `network`. A swap leg that did not fill carries its `kind` beside its
`error` text. `errorKind(e)` classifies any error; other errors stay plain `Error`s.

## The shared names

What two sites must use to file identical wallet rows: `POOLS_BASKET` (`amm-pools`, the LP's
position rows), `SWAP_BASKET` (`amm-swap`, what swap legs spend), `SWAP_PROTOCOL` (`[2, "amm
swap"]`), `SWAP_KEY_PREFIX` + `swapKeyID` (the staged rows' keyIDs), `swapInstructions` /
`swapSatsInstructions` (their customInstructions), `LP_KEY_PROTOCOL` (BRC-29) + `LP_KEY_MARK` +
`lpKeyDescription` / `lpKeyIdOfDescription` (the deploy's pool output description naming the LP
keyID), `POOL_TAG` / `POOL_OP` / `isPoolRow` / `poolCustomInstructions` (an `amm-pools` row),
`POOL_DEPLOY_LABEL` (`amm-pool-deploy`), `SWAP_TTL_MS` (15 s), `transferPlanLabels` (the `p color
plan` labels), the receipt helpers `newReceivingKey` / `receiptOutput`, and `xTopics` (the BRC-22
`x-topics` header: a JSON array).

## A swap

```ts
import { createClient, ClientError } from "@dcasegr/amm-client";

const client = createClient({ origin: "https://swap.skein.nexus", wallet });
const tokenId = "<txid>_0";

// The token's pools route as an event stream: the pools a swap may use, the market.
const stop = client.watchTokenPools(tokenId, async (pools) => {
  stop();
  const quote = client.quoteSwap({ tokenId, side: "buy", amountIn: 50_000n, maxSlippageBps: 50, allowPartial: false }, pools, { sym: "TOK", dec: 0 });
  try {
    const result = await client.executeSwap(quote, { onProgress: (p) => console.log(p.phase) });
    console.log(result.status, result.legs);
  } catch (e) {
    if (e instanceof ClientError && e.kind === "pool_spent") console.log("quote again");
    else throw e;
  }
});
```

## Build

From skein-amm's `web/`: `npm ci` in `ui` and in `engine`, then `npm pack` here (the build
compiles `../ui/src/index.ts` with `../ui`'s TypeScript into `dist/`, after building the engine).

runar-sdk is vendored inside (`dist/vendor/runar`, MIT: its `LICENSE` and `NOTICE` there): the
runar-sdk the pool template is built on is not published.
