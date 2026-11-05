/**
 * `@dcasegr/amm-client` (skein-amm 0.36.0, D8): the Open Exchange client without the pages —
 * `createClient` (src/client.ts) and the names two sites must share to file identical wallet rows
 * (D10). ESM + types, no React, no styles, no wallet provider: the caller connects a BRC-100 wallet
 * and passes it in. README "The packages".
 */

// The client (D9, D11–D13).
export * from "./client.js";
export { CLIENT_ERROR_KINDS, ClientError, errorKind, toClientError, type ClientErrorKind } from "./errors.js";
export { DEFAULT_FEE_RATE_SATS_PER_KB, exchangeBase, tokenBase } from "./lib/config.js";

// The shared names (D10): what each names in the wallet.

/** The basket of the LP's position rows (`amm-pools`): one pool output per deploy, filed by basket insertion. */
export { POOLS_BASKET } from "./wallet/color.js";
/** The active swap basket (`amm-swap`): the token outputs and the sats each swap leg spends. */
export { SWAP_BASKET } from "./wallet/color.js";
/** The key protocol of every `amm-swap` row (`[2, "amm swap"]`, counterparty self). */
export { SWAP_PROTOCOL } from "./wallet/color.js";
/** The keyID prefix of an `amm-swap` row's key (`amm-swap-`). */
export { SWAP_KEY_PREFIX } from "./market/activeSwap.js";
/** The keyID of a staged `amm-swap` row: `amm-swap-<pool txid>.<vout>` (token row) or `…:sats` (its sats row). */
export { swapKeyID } from "./market/activeSwap.js";
/** customInstructions of an `amm-swap` token row (asset, amount and the key that spends it). */
export { swapInstructions } from "./wallet/color.js";
/** customInstructions of an `amm-swap` sats row (`sats: true`, the token it was staged for, its key). */
export { swapSatsInstructions } from "./wallet/color.js";
/** The key protocol of a pool's LP key (BRC-29, to self): the `amm-pools` row's protocolID. */
export { LP_KEY_PROTOCOL } from "./lp/poolDeploy.js";
/** The marker a deploy's pool output description ends with (` · amm-lp <hex>`): it names the LP keyID. */
export { LP_KEY_MARK } from "./lp/poolDeploy.js";
/** A deploy's pool output description: the readable text, then `LP_KEY_MARK` and the LP keyID's suffix. */
export { lpKeyDescription } from "./lp/poolDeploy.js";
/** The LP keyID a deploy's pool output description names, or null. */
export { lpKeyIdOfDescription } from "./lp/poolDeploy.js";
/** The tag (`amm-pool`) of an `amm-pools` row. */
export { POOL_TAG } from "./lp/poolDeploy.js";
/** The `op` (`amm-pool`) in an `amm-pools` row's customInstructions. */
export { POOL_OP } from "./lp/poolDeploy.js";
/** Whether a basket row is an `amm-pools` position row (its tag or its customInstructions `op`). */
export { isPoolRow } from "./lp/poolDeploy.js";
/** customInstructions of an `amm-pools` row: the token, the LP key, the validator, its fees and nonce. */
export { poolCustomInstructions } from "./lp/poolDeploy.js";
/** The label of a pool deploy's action (`amm-pool-deploy`): the positions reader's history. */
export { POOL_DEPLOY_LABEL } from "./lp/positions.js";
/** How long the relay may take a swap leg (the swap's `expires`), ms. */
export { SWAP_TTL_MS } from "./market/swapAction.js";
/** The `p color plan` labels of a transfer of one asset (BRC-207 plan version 1): every token action's. */
export { transferPlanLabels } from "./wallet/color.js";
/** A module receiving key for one output of an asset from a sender: its receipt, key and hash160. */
export { newReceivingKey, type ReceivingKey } from "./wallet/color.js";
/** A receipt's `basket insertion` into the asset's value basket (`p color <assetTag>`), for `internalizeAction`. */
export { receiptOutput } from "./wallet/color.js";
/** The `x-topics` header of a BRC-22 submit: the topics as a JSON array (D14). */
export { xTopics } from "./lp/close.js";
