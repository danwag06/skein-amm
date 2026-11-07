/**
 * Rebalance (skein-amm 0.38.0, D11, David Case 2026-11-05): a position's pool closed and a new
 * one deployed in ONE wallet createAction — what Close (src/lp/close.ts) and the deploy
 * (src/lp/poolDeploy.ts) do, in the same transaction. A position is still only deployed or
 * closed (the pool A's Close, a new pool B with a new LP key); wallet-built, so nothing is
 * broadcast-then-taken-in (that is the page-built swap's).
 *
 *   1. The old pool A's current output and its BEEF (the caller's: `GET
 *      /@<token>/amm/pools/beef?lp=<A's LP key>`), A's LP key checked against the wallet's.
 *   2. The new pool B as the deploy makes it: a new LP key (`newLpKey`), the proposed pool
 *      (`planPoolDeploy`), the validator's affirmation (`amm.pool.affirm`, `affirmPool`: the same
 *      call a deploy makes, with B's sats and tokens).
 *   3. ONE createAction through the wallet's BRC-207 module, a `p color plan` transfer:
 *      - input 0: A, explicit (its BEEF in `inputBEEF`, `unlockingScriptLength`
 *        `PoolTemplate.maxCallUnlockLength`) — to the module a FOREIGN token input, checked
 *        admitted and unspent on the token's overlay, its tokens counted;
 *      - output 0: B (a foreign script to the module; its description the deploy's, naming B's
 *        LP keyID: `lpKeyDescription`);
 *      - the token difference through the module: B holding MORE tokens than A — the module
 *        selects the wallet's token inputs for the rest and adds token change (the deploy's
 *        path); FEWER — output 1, the rest to a NEW module receiving key of the user's own, the
 *        plan's owned output 1 (the Close's path; the module files it in `p color <assetTag>`);
 *      - the sats difference: the wallet funds what B needs beyond A's sats, its change takes
 *        what A had beyond B's (and pays the fee);
 *      - labels: the plan's, `amm-pool-deploy` (the deploy's: the positions reader finds B in the
 *        history) and `amm-close` (the Close's); `randomizeOutputs: false`.
 *      The page fills A's input over the wallet's transaction at signAction (`callUnlock` + the
 *      LP's `createSignature`, checked with `Spend`; Close's outputs are free, so the preimage
 *      covers B and every output the module and the wallet added); the module signs its inputs,
 *      approves and submits; the wallet broadcasts.
 *   4. The page's own submit at the host root (`tm_color_<assetId>`), then B's position row filed
 *      in `amm-pools` (basket insertion, as the deploy files it).
 */
import { Beef, PublicKey, Transaction, type CreateActionOutput, type InternalizeOutput, type WalletInterface } from "@bsv/sdk";
import { PoolTemplate } from "../pool/index.js";
import { poolUtxoFrom, spendValid } from "../market/swapAction.js";
import type { LookupOutput } from "../lib/overlay.js";
import type { AuthFetchLike } from "../market/relay.js";
import type { LpKeyRef } from "./positions.js";
import { identityKeyOf } from "../wallet/brc29.js";
import { sdkTokenId } from "../lib/tokenId.js";
import { POOLS_BASKET, newReceivingKey, transferPlanLabels, type HeldOutput } from "../wallet/color.js";
import { inputIndexOf, runAppSignedAction } from "../wallet/action.js";
import { submitToOverlay, steakText } from "./close.js";
import { POOL_TAG, PoolDeployError, affirmPool, lpKeyDescription, newLpKey, planPoolDeploy, poolCustomInstructions, tokenP2pkhScript, valueOutputsOf, type Affirmation, type BasketFiling, type PoolDeployPlan, type ValidatorChoice } from "./poolDeploy.js";
import { POOL_DEPLOY_LABEL } from "./positions.js";

export class RebalanceShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebalanceShapeError";
  }
}

export interface RebalanceInput {
  wallet: WalletInterface;
  /** The wallet's BRC-104 client for the token instance (`amm.pool.affirm` on `/call`). */
  af: AuthFetchLike;
  /** The token instance's AMM base URL. */
  base: string;
  tokenId: string;
  /** The old pool A's current output (step 1). */
  poolOutput: LookupOutput;
  /** A's LP key in the wallet. */
  lpKey: LpKeyRef;
  /** The new pool B's reserves: token base units and sats. */
  tokens: bigint;
  sats: bigint;
  /** B's fees: the validator's terms now, as a deploy takes them. */
  fees: { lpFeeBps: bigint; validatorFeeBps: bigint; commissionBps: bigint };
  validator: ValidatorChoice;
  /** The wallet's held token outputs (`p color assets`): B holding more than A needs the rest there. */
  held: HeldOutput[];
  meta?: { sym?: string; dec?: number };
  /** The submit to this skein (default: `POST <origin>/submit`, plain fetch). */
  submit?: (topic: string, beef: number[]) => Promise<{ steak?: unknown }>;
}

export interface RebalancedPool {
  /** A's output spent, `txid.vout`. */
  closed: string;
  plan: PoolDeployPlan;
  lpKey: Awaited<ReturnType<typeof newLpKey>>;
  affirmation: Affirmation;
  /** The createAction arguments the wallet was given. */
  createArgs: Parameters<WalletInterface["createAction"]>[0];
  txid: string;
  /** The transaction as the wallet's AtomicBEEF. */
  tx: number[];
  /** B, `<txid>.0`. */
  outpoint: string;
  /** B's token difference against A: positive, taken from the wallet; negative, returned to it (output 1). */
  tokenDelta: bigint;
  /** B's sats difference against A: positive, funded by the wallet; negative, into its change. */
  satsDelta: bigint;
  /** B's position row (`amm-pools`). */
  filing: BasketFiling;
  filed: boolean;
  /** The page's own submit, in words (src/lp/close.ts `steakText`), or its error. */
  submitted: string;
  /** Filing or submit errors (the transaction itself is broadcast). */
  errors: string[];
}

function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** Steps 1-4 (see the module comment). Throws before the wallet's action exists or when it is refused; after the broadcast, errors are collected. */
export async function rebalancePool(i: RebalanceInput): Promise<RebalancedPool> {
  const { wallet } = i;
  const meta = i.meta ?? {};
  const sdkId = sdkTokenId(i.tokenId);
  const sym = meta.sym ?? "token";

  // 1. A, and its LP key.
  const poolUtxo = poolUtxoFrom(i.poolOutput);
  const old = PoolTemplate.decode(poolUtxo.script);
  if (!old) throw new RebalanceShapeError("the output is not a pool");
  if (i.lpKey.counterparty !== "self") throw new RebalanceShapeError(`the wallet key ${i.lpKey.keyID} is not a key to self`);
  const lpArgs = { protocolID: i.lpKey.protocolID, keyID: i.lpKey.keyID, counterparty: i.lpKey.counterparty };
  const { publicKey: lpPub } = await wallet.getPublicKey({ ...lpArgs, forSelf: true });
  if (PublicKey.fromString(lpPub).toString() !== old.state.lpPubKey) throw new RebalanceShapeError(`the wallet key ${i.lpKey.keyID} is not this pool's LP key`);
  const tokenDelta = i.tokens - old.state.tokenReserve;
  const satsDelta = i.sats - BigInt(poolUtxo.satoshis);
  if (tokenDelta > 0n) {
    const held = valueOutputsOf(i.held, i.tokenId).reduce((a, o) => a + o.amount, 0n);
    if (held < tokenDelta) throw new PoolDeployError(`Your wallet holds fewer than ${tokenDelta} base units of that token`);
  }

  // 2. B: a new LP key, the proposed pool, the validator's affirmation.
  const lpKey = await newLpKey(wallet);
  const plan = planPoolDeploy({
    tokenId: i.tokenId,
    tokens: i.tokens,
    sats: i.sats,
    ...i.fees,
    lpPubKey: lpKey.publicKey,
    lpKeyId: lpKey.keyID,
    validator: i.validator,
    ...(meta.dec !== undefined ? { dec: meta.dec } : {}),
  });
  const affirmation = await affirmPool(i.af, i.base, plan);
  const poolScript = affirmation.lockingScript;

  // 3. The one action: A in, B at output 0, the token difference through the module.
  const outputs: CreateActionOutput[] = [{ lockingScript: poolScript, satoshis: Number(plan.sats), outputDescription: lpKeyDescription(describe(`AMM pool: ${sym} / BSV`), lpKey.keyID) }];
  let owned: Parameters<typeof transferPlanLabels>[1] = {};
  if (tokenDelta < 0n) {
    const me = await identityKeyOf(wallet);
    const k = await newReceivingKey(wallet, sdkId, me);
    outputs.push({ lockingScript: tokenP2pkhScript(sdkId, -tokenDelta, k.publicKey), satoshis: 1, outputDescription: describe(`${sym} pool tokens to you`) });
    owned = { ownedOutputs: [{ outputIndex: 1, ...k.receipt }] };
  }
  const first = PoolTemplate.planClose({ pool: poolUtxo, outputs: outputs.map((o) => ({ satoshis: BigInt(o.satoshis), script: o.lockingScript })) });
  const poolOutpoint = `${poolUtxo.txid}.${poolUtxo.vout}`;
  const lpSigner = async (sighash: number[]) => (await wallet.createSignature({ ...lpArgs, hashToDirectlySign: sighash })).signature;
  const createArgs = {
    description: describe(`AMM close + pool deploy: ${sym}`),
    inputBEEF: Beef.fromBinary(i.poolOutput.beef).toBinary(),
    inputs: [{ outpoint: poolOutpoint, unlockingScriptLength: PoolTemplate.maxCallUnlockLength(first), inputDescription: describe(`The ${sym} pool`) }],
    outputs,
    labels: [...transferPlanLabels(sdkId, owned), POOL_DEPLOY_LABEL, "amm-close"],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  };
  const signed = await runAppSignedAction(wallet, createArgs, async (tx) => {
    // The contract reads input 0 (the preimage is input 0's); the wallet places named inputs first.
    if (inputIndexOf(tx, poolUtxo.txid, poolUtxo.vout) !== 0) throw new RebalanceShapeError("the wallet did not place the pool as input 0");
    outputs.forEach((o, n) => {
      if (tx.outputs[n]?.lockingScript.toHex() !== o.lockingScript || tx.outputs[n]?.satoshis !== o.satoshis) throw new RebalanceShapeError(`the wallet moved output ${n} of the rebalance`);
    });
    // Close's outputs are free: the call's preimage covers B and every output the wallet added.
    const callPlan = PoolTemplate.planClose({ pool: poolUtxo, outputs: tx.outputs.map((o) => ({ satoshis: BigInt(o.satoshis!), script: o.lockingScript.toHex() })) });
    tx.inputs[0]!.unlockingScript = PoolTemplate.callUnlock(callPlan, tx, null).unlockingScript;
    await PoolTemplate.signPoolInput({ tx, pool: callPlan.pool, method: "close", unsigned: ["lp"], sourceSatoshis: poolUtxo.satoshis }, "lp", lpSigner);
    if (!spendValid(tx, 0)) throw new RebalanceShapeError("input 0 of the rebalance does not validate");
    return { 0: { unlockingScript: tx.inputs[0]!.unlockingScript!.toHex() } };
  });

  const out: RebalancedPool = {
    closed: poolOutpoint,
    plan,
    lpKey,
    affirmation,
    createArgs,
    txid: signed.txid,
    tx: signed.tx,
    outpoint: `${signed.txid}.0`,
    tokenDelta,
    satsDelta,
    filing: {
      outputIndex: 0,
      basket: POOLS_BASKET,
      tags: [POOL_TAG],
      customInstructions: poolCustomInstructions({ tokenId: sdkId, ...meta, protocolID: lpKey.protocolID, keyID: lpKey.keyID, args: plan.args, validatorIdentity: plan.state.validatorIdentity, nonce: affirmation.nonce, poolId: `${signed.txid}_0` }),
    },
    filed: false,
    submitted: "not submitted",
    errors: [],
  };
  if (Transaction.fromAtomicBEEF(signed.tx).outputs[0]?.lockingScript.toHex() !== poolScript) out.errors.push("the wallet's transaction has another output 0 than the affirmed pool");

  // 4. The page's own submit, then B's position row.
  try {
    const submit = i.submit ?? ((topic: string, beef: number[]) => submitToOverlay(i.base, topic, beef));
    out.submitted = steakText((await submit(plan.topic, signed.tx)) as never);
  } catch (err) {
    out.submitted = "the submit failed";
    out.errors.push(`submit: ${err instanceof Error ? err.message : String(err)}`);
  }
  const row: InternalizeOutput = { outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: out.filing.basket, tags: out.filing.tags, customInstructions: out.filing.customInstructions } };
  try {
    const r = await wallet.internalizeAction({ tx: signed.tx, outputs: [row], description: describe(`AMM pool deploy: ${sym}`), labels: [POOL_DEPLOY_LABEL] });
    out.filed = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
