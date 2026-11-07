/**
 * `@dcasegr/amm-client` (skein-amm 0.38.0, D8): the Open Exchange client without the pages —
 * `createClient` (src/client.ts) and the names two sites must share to file identical wallet rows
 * (D10). ESM + types, no React, no styles, no wallet provider: the caller connects a BRC-100 wallet
 * and passes it in. README "The packages".
 */

// The client (D9, D11–D13).
export * from "./client.js";
export { CLIENT_ERROR_KINDS, ClientError, errorKind, toClientError, type ClientErrorKind } from "./errors.js";
export { DEFAULT_FEE_RATE_SATS_PER_KB, exchangeBase, tokenBase } from "./lib/config.js";
/** A swap-basket row whose spender the swap's overlay pass could not take in (`SwapResult.stuck`, 0.44.2). */
export type { StuckRow } from "./wallet/swapPayouts.js";

// The shared names (D10): what each names in the wallet.

/** The basket of the LP's position rows (`amm-pools`): one pool output per deploy, filed by basket insertion. */
export { POOLS_BASKET } from "./wallet/color.js";
/** The active swap basket (`amm-swap`): the token outputs and the sats each swap leg spends. */
export { SWAP_BASKET } from "./wallet/color.js";
/** The key protocol of every `amm-swap` row (`[2, "amm swap"]`, counterparty self). */
export { SWAP_PROTOCOL } from "./wallet/color.js";
/** The keyID prefix of an `amm-swap` row's key (`amm-swap-`). */
export { SWAP_KEY_PREFIX } from "./market/activeSwap.js";
/** A staged `amm-swap` row's keyID (0.40.0): `amm-swap-<16 random bytes, hex>`. */
export { newSwapKeyID } from "./market/activeSwap.js";
/** The label of a staging action that carries tokens (`amm-swap-stage`, 0.40.0). */
export { SWAP_STAGE_LABEL } from "./market/activeSwap.js";
/** The marker a staged token output's description ends with (` · amm-swap <hex>`): it names the key id. */
export { SWAP_KEY_MARK } from "./market/activeSwap.js";
/** A staged token output's description: the readable text, then `SWAP_KEY_MARK` and the keyID's hex. */
export { swapKeyDescription } from "./market/activeSwap.js";
/** The keyID a staged token output's description names, or null. */
export { swapKeyIdOfDescription } from "./market/activeSwap.js";
/** The keyID of a leg's change kept in `amm-swap`: `amm-swap-<txid>.<vout>:change`, the leg's first input of that kind. */
export { changeKeyID } from "./market/swapAction.js";
/** An order's payout, own-commission and last-leg change derivation: from the order's key input. */
export { legDerivation } from "./market/swapAction.js";
/** customInstructions of an `amm-swap` token row (asset, amount, the key that spends it; a change row's `order`). */
export { swapInstructions } from "./wallet/color.js";
/** customInstructions of an `amm-swap` sats row (`sats: true`, its key; a change row's `order`). */
export { swapSatsInstructions } from "./wallet/color.js";
/** The LP's fee rows (`openex fees`): filed on catch-up, spent when the LP collects. */
export { FEES_BASKET } from "./wallet/color.js";
/** The key protocol of a new pool's LP key (`[1, "openex fees"]`, to self). An older pool keeps its BRC-29 key. */
export { LP_KEY_PROTOCOL } from "./lp/poolDeploy.js";
/** The marker an older pool output description ends with (` · amm-lp <hex>`). */
export { LP_KEY_MARK } from "./lp/poolDeploy.js";
/** The marker a new pool output description ends with (` · openex fees <hex>`). */
export { FEES_KEY_MARK } from "./lp/poolDeploy.js";
/** A pool output description: the readable text, then the marker of the key it names. */
export { lpKeyDescription } from "./lp/poolDeploy.js";
/** The LP keyID a pool output description names, or null. */
export { lpKeyIdOfDescription } from "./lp/poolDeploy.js";
/** The protocol a pool output description names, or null. */
export { lpProtocolOfDescription } from "./lp/poolDeploy.js";
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
/** How long the page waits for one swap leg's answer before it closes the request (0.44.0: the host's relay stops with it), ms. */
export { LEG_PATIENCE_MS } from "./market/swapFlow.js";
/** The `p color plan` labels of a transfer of one asset (BRC-207 plan version 1): every token action's. */
export { transferPlanLabels } from "./wallet/color.js";
/** A module receiving key for one output of an asset from a sender: its receipt, key and hash160. */
export { newReceivingKey, type ReceivingKey } from "./wallet/color.js";
/** A receipt's `basket insertion` into the asset's value basket (`p color <assetTag>`), for `internalizeAction`. */
export { receiptOutput } from "./wallet/color.js";
/** The `x-topics` header of a BRC-22 submit: the topics as a JSON array (D14). */
export { xTopics } from "./lp/close.js";
