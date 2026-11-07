/**
 * Creating a pool from a token in the wallet (skein-amm 0.13.0, David Case
 * 2026-10-22, plans/validator-signoff §2): ONE wallet-built createAction,
 * affirmed first by this skein's validator. The page holds no keys and names
 * no token input: the wallet's BRC-207 module selects the token inputs and
 * adds token change; every key and signature comes from the wallet.
 *
 *   1. The LP key: security level 1, protocol `[1, "openex fees"]`, counterparty
 *      self, keyID 16 random bytes base64 (`newLpKey`). Kept in the position
 *      row and in the pool output's description: `AMM pool: <SYM> / BSV ·
 *      openex fees <the keyID's bytes, hex>`. A keyID with a space is an older
 *      BRC-29 key (` · amm-lp <suffix hex>`). The deploy history gives either
 *      back. Nothing is kept in the browser.
 *   2. `amm.pool.terms` (the validator and its fees), then `amm.pool.affirm
 *      {pool, satoshis}`: the proposed pool output, its ValidatorPubKey,
 *      Nonce and Affirmation still to come (33 zero bytes, 32 zero bytes,
 *      empty) → `{validatorPubKey, nonce, signature}`. The page checks the
 *      key is the validator's child of the nonce and the signature affirms
 *      the pool (`PoolTemplate.affirmed`), then writes the three into the
 *      pool's state (`PoolTemplate.lockDeploy`).
 *   3. `createAction`: outputs [the pool] (the deposit's tokens to a foreign
 *      script: a transfer in the `p color plan`, no `inputPositions`, no
 *      owned outputs), `randomizeOutputs: false`. The module selects the token
 *      inputs and adds the token change; the wallet funds the sats, signs and
 *      broadcasts; the module submits to `tm_color_<assetId>`. The page submits
 *      it there too (plain fetch, a repeat is harmless). The input BEEF of the
 *      module's own inputs is the module's (BRC-207 module 0.1.1; the
 *      validator-signoff record §10).
 *   4. The position row: output 0 filed in the exchange's own basket
 *      `amm-pools` (basket insertion; customInstructions the LP key, the
 *      validator, its fees and its nonce).
 *
 * Keys:
 *  - LP key: as above (0.29.1: the pre-0.13.0 LP keys, keyed by the deploy's
 *    first token input or under `P1SAT_PROTOCOL`, are gone with layout 1).
 *  - Validator key: the anyone-child of the validator's identity keyed by
 *    the nonce (src/lib/keys.ts `deriveFirstValidatorPubKey`), a public
 *    derivation the page checks.
 */
import { P2PKH, PublicKey, Transaction, Utils, type CreateActionOutput, type InternalizeOutput, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { PoolTemplate, RESCINDED_KEY, decodeOneColor, oneColorValuePrefix, type PoolArgs, type PoolFields } from "../pool/index.js";
import { deriveFirstValidatorPubKey } from "../lib/keys.js";
import { priceOf } from "../market/view.js";
import { callApp, dagBytes, readBytes, type AuthFetchLike } from "../market/relay.js";
import { BRC29_PROTOCOL, randomBase64 } from "../wallet/brc29.js";
import { POOLS_BASKET, runTokenAction, transferPlanLabels, type HeldOutput } from "../wallet/color.js";
import { POOL_OP, POOL_TAG, isPoolRow } from "./poolRows.js";
import { parseOutpoint, parseTokenId, sdkTokenId, tokenIdOfWire, tokenIdText } from "../lib/tokenId.js";
import { submitToOverlay, steakText } from "./close.js";

export { POOL_OP, POOL_TAG, isPoolRow };

/** The validator a pool names: its identity key (compressed, lowercase hex). */
export interface ValidatorChoice {
  identityKey: string;
}

/** The LP key's protocol for a new pool: level 1, `[1, "openex fees"]`. */
export const LP_KEY_PROTOCOL: WalletProtocol = [1, "openex fees"];
const LP_DERIVATION_PREFIX = Utils.toBase64(Utils.toArray("amm-lp", "utf8"));
/** `amm.pool.affirm` (amm-p2p, 0.11.0; 0.13.0: `{pool, satoshis}` → `{validatorPubKey, nonce, signature}`). */
export const POOL_AFFIRM_FN = "amm.pool.affirm";

const toHex = (b: number[] | Uint8Array) => Utils.toHex(Array.from(b));

function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** The marker an older BRC-29 pool output description ends with: ` · amm-lp <hex>`. */
export const LP_KEY_MARK = " · amm-lp ";
/** The marker a new pool output description ends with: ` · openex fees <hex>`. */
export const FEES_KEY_MARK = " · openex fees ";

/**
 * The pool output's description: the readable text (`AMM pool: <SYM> / BSV`) then the key.
 * A keyID with a space is the older BRC-29 key (` · amm-lp ` and the suffix bytes, hex).
 * One base64 token is the `openex fees` key (` · openex fees ` and those bytes, hex).
 */
export function lpKeyDescription(readable: string, keyID: string): string {
  const space = keyID.indexOf(" ");
  if (space > 0) {
    const suffix = keyID.slice(space + 1);
    if (keyID.slice(0, space) !== LP_DERIVATION_PREFIX || !suffix) throw new PoolDeployError(`not a deploy LP keyID: ${keyID}`);
    return `${readable}${LP_KEY_MARK}${toHex(Utils.toArray(suffix, "base64"))}`;
  }
  let bytes: number[];
  try {
    bytes = Utils.toArray(keyID, "base64");
  } catch {
    throw new PoolDeployError(`not a deploy LP keyID: ${keyID}`);
  }
  if (bytes.length === 0) throw new PoolDeployError(`not a deploy LP keyID: ${keyID}`);
  return `${readable}${FEES_KEY_MARK}${toHex(bytes)}`;
}

/** The LP keyID an output description names (`lpKeyDescription`), or null. */
export function lpKeyIdOfDescription(description: string | undefined): string | null {
  const legacy = / · amm-lp ([0-9a-f]{2,128})$/.exec(description ?? "");
  if (legacy && legacy[1]!.length % 2 === 0) return `${LP_DERIVATION_PREFIX} ${Utils.toBase64(Utils.toArray(legacy[1]!, "hex"))}`;
  const fees = / · openex fees ([0-9a-f]{2,128})$/.exec(description ?? "");
  if (fees && fees[1]!.length % 2 === 0) return Utils.toBase64(Utils.toArray(fees[1]!, "hex"));
  return null;
}

/** The protocol an output description names, or null when it names no key. */
export function lpProtocolOfDescription(description: string | undefined): WalletProtocol | null {
  if (/ · openex fees ([0-9a-f]{2,128})$/.test(description ?? "")) return LP_KEY_PROTOCOL;
  if (/ · amm-lp ([0-9a-f]{2,128})$/.test(description ?? "")) return BRC29_PROTOCOL;
  return null;
}

/** A new pool's LP key derivation (0.13.0): derivationPrefix base64("amm-lp"), derivationSuffix 16 random bytes, base64. */
export function newLpDerivation(): { derivationPrefix: string; derivationSuffix: string } {
  return { derivationPrefix: LP_DERIVATION_PREFIX, derivationSuffix: randomBase64(16) };
}

/** A basket row as the wallet lists it. */
export interface BasketRow {
  outpoint: string;
  satoshis: number;
  lockingScript?: string;
  tags?: string[];
  customInstructions?: string;
}

// ---------------------------------------------------------------------------
// The wallet's tokens
// ---------------------------------------------------------------------------

/** One of the wallet's own value outputs of a token, as the module holds it. */
export interface HeldValue {
  /** `txid.vout` */
  outpoint: string;
  txid: string;
  vout: number;
  amount: bigint;
}

/** The wallet's available value outputs of `tokenId` (a fixed-supply deploy output among them), from `p color assets`: what the module selects from. */
export function valueOutputsOf(held: HeldOutput[], tokenId: string): HeldValue[] {
  const want = tokenIdText(parseTokenId(tokenId) ?? { txid: "", vout: -1 });
  const out: HeldValue[] = [];
  for (const h of held) {
    if (!h.available) continue;
    const op = parseOutpoint(h.outpoint);
    if (!op) continue;
    // A pool output carries the same 1Color prefix; it is never a token input.
    if (PoolTemplate.decode(h.lockingScript)) continue;
    const t = decodeOneColor(Utils.toArray(h.lockingScript, "hex"));
    if (!t || t.amount <= 0n) continue;
    const id = t.role === "deploy" ? tokenIdText(op) : t.role === "value" && t.idBytes ? tokenIdOfWire(t.idBytes) : null;
    if (id !== want) continue;
    out.push({ outpoint: `${op.txid}.${op.vout}`, txid: op.txid, vout: op.vout, amount: t.amount });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

export interface PoolDeployForm {
  tokenId: string;
  tokens: bigint;
  sats: bigint;
  lpFeeBps: bigint;
  validatorFeeBps: bigint;
  /** The relay's commission (the contract's CommissionBps), fixed at deploy. Default 0. */
  commissionBps?: bigint;
  lpPubKey: string;
  /** The LP key's keyID (BRC-29, `newLpDerivation`). */
  lpKeyId: string;
  validator: ValidatorChoice;
  dec?: number;
}

export interface PoolDeployPlan {
  tokenId: string;
  /** `tm_color_<assetId>`, `tm_color_<txid>_0`: the token's topic (BRC-207). */
  topic: string;
  args: PoolArgs;
  /** The pool's state as proposed: its ValidatorPubKey (33 zero bytes), Nonce and Affirmation still to come. */
  state: PoolFields;
  /** Output 0's script as proposed, hex: what `amm.pool.affirm` is asked about. */
  lockingScript: string;
  lpKeyId: string;
  sats: bigint;
  /** Initial marginal price, sats per token (display units when `dec` is known). */
  price: string;
}

export class PoolDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolDeployError";
  }
}

/** A token with a 32-byte id (`<txid>_0`; `<txid>` / `<txid>.0` read the same) → the wire id (internal byte order), hex. */
export function assetIdHex(tokenId: string): string {
  const r = parseTokenId(tokenId);
  if (!r || r.vout !== 0) throw new PoolDeployError(`pools exist only for 1Color tokens with a 32-byte id (<txid>_0), not ${tokenId}`);
  return toHex((Utils.toArray(r.txid, "hex") as number[]).reverse());
}

export function planPoolDeploy(f: PoolDeployForm): PoolDeployPlan {
  const assetId = assetIdHex(f.tokenId);
  if (f.tokens <= 0n) throw new PoolDeployError("the token deposit must be positive");
  if (f.sats <= 0n || f.sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new PoolDeployError("the sats deposit must be positive");
  const commissionBps = f.commissionBps ?? 0n;
  for (const [name, bps] of [["LP fee", f.lpFeeBps], ["validator fee", f.validatorFeeBps], ["commission", commissionBps]] as const) {
    if (bps < 0n || bps >= 10_000n) throw new PoolDeployError(`${name}: 0-9999 bps`);
  }
  if (f.lpFeeBps + f.validatorFeeBps + commissionBps >= 10_000n) throw new PoolDeployError("the fees together must stay below 100%");
  const args: PoolArgs = { assetId, lpFeeBps: f.lpFeeBps, validatorFeeBps: f.validatorFeeBps, commissionBps };
  const state: PoolFields = {
    tokenReserve: f.tokens,
    lpPubKey: PublicKey.fromString(f.lpPubKey).toString(),
    validatorPubKey: RESCINDED_KEY, // to come: the validator's
    validatorIdentity: PublicKey.fromString(f.validator.identityKey).toString(),
    nonce: "00".repeat(32),
    affirmation: "",
  };
  return {
    tokenId: f.tokenId,
    topic: `tm_color_${sdkTokenId(f.tokenId)}`,
    args,
    state,
    lockingScript: PoolTemplate.lockDeploy(args, state).toHex(),
    lpKeyId: f.lpKeyId,
    sats: f.sats,
    price: priceOf(f.sats, f.tokens, f.dec),
  };
}

/** A 1Color value output of `amount` to `pubKeyHash` (P2PKH), as Pool.runar.go's `tokenP2pkh` writes it. */
export function tokenP2pkhScript(tokenId: string, amount: bigint, pubKey: string): string {
  const prefix = oneColorValuePrefix(Utils.toArray(assetIdHex(tokenId), "hex"), amount);
  return toHex(prefix) + new P2PKH().lock(PublicKey.fromString(pubKey).toAddress()).toHex();
}

/** customInstructions of a pool output the wallet holds as LP (`amm-pools`). */
export function poolCustomInstructions(o: {
  tokenId: string;
  sym?: string;
  dec?: number;
  protocolID: WalletProtocol;
  keyID: string;
  args: PoolArgs;
  validatorIdentity: string;
  /** The validator's nonce (0.13.0), hex; absent for a pool before it. */
  nonce?: string;
  /** The deploy outpoint, `<txid>_<vout>`. Copied onto each continuation the wallet files. */
  poolId?: string;
}): string {
  return JSON.stringify({
    id: o.tokenId,
    op: POOL_OP,
    ...(o.sym ? { sym: o.sym } : {}),
    ...(o.dec !== undefined ? { dec: String(o.dec) } : {}),
    protocolID: o.protocolID,
    keyID: o.keyID,
    counterparty: "self",
    ...(o.poolId ? { poolId: o.poolId } : {}),
    amm: { role: "lp", validatorIdentity: o.validatorIdentity, lpFeeBps: String(o.args.lpFeeBps), validatorFeeBps: String(o.args.validatorFeeBps), commissionBps: String(o.args.commissionBps), ...(o.nonce ? { nonce: o.nonce } : {}) },
  });
}

// ---------------------------------------------------------------------------
// The affirmation
// ---------------------------------------------------------------------------

/** The validator's affirmation (0.13.0): its key, its nonce, its signature; and the pool's state with them. */
export interface Affirmation {
  validatorPubKey: string;
  nonce: string;
  signature: string;
  state: PoolFields;
  lockingScript: string;
}

/**
 * `amm.pool.affirm {pool, satoshis}` (docs/AMM.md "The deploy and the affirmation") →
 * `{validatorPubKey, nonce, signature}`, checked before it is used: the key is the validator's
 * child of the nonce, and the pool with the three in its state attests itself.
 */
export async function affirmPool(af: AuthFetchLike, base: string, plan: PoolDeployPlan): Promise<Affirmation> {
  const r = (await callApp(af, base, POOL_AFFIRM_FN, {
    pool: dagBytes(Utils.toArray(plan.lockingScript, "hex")),
    satoshis: Number(plan.sats),
  })) as Record<string, unknown> | null;
  const sig = readBytes(r?.signature);
  const key = readBytes(r?.validatorPubKey);
  const nonce = readBytes(r?.nonce);
  if (!sig || sig.length === 0) throw new PoolDeployError(`${POOL_AFFIRM_FN}: no signature in the answer`);
  if (!key || key.length !== 33 || !nonce || nonce.length !== 32) throw new PoolDeployError(`${POOL_AFFIRM_FN}: no validatorPubKey (33 bytes) and nonce (32 bytes) in the answer`);
  const validatorPubKey = toHex(key);
  if (deriveFirstValidatorPubKey(plan.state.validatorIdentity, toHex(nonce)) !== validatorPubKey) throw new PoolDeployError(`${POOL_AFFIRM_FN}: the key is not the validator's child of its nonce`);
  const state: PoolFields = { ...plan.state, validatorPubKey, nonce: toHex(nonce), affirmation: toHex(sig) };
  const lockingScript = PoolTemplate.lockDeploy(plan.args, state).toHex();
  if (!PoolTemplate.affirmed(lockingScript, plan.sats)) throw new PoolDeployError(`${POOL_AFFIRM_FN}: the signature does not affirm this pool (not the ValidatorPubKey's over its parameters)`);
  return { validatorPubKey, nonce: toHex(nonce), signature: toHex(sig), state, lockingScript };
}

// ---------------------------------------------------------------------------
// The wallet sequence
// ---------------------------------------------------------------------------

/** A new pool's LP key: `[1, "openex fees"]`, counterparty self, keyID 16 random bytes, base64. */
export async function newLpKey(wallet: WalletInterface): Promise<{ protocolID: WalletProtocol; keyID: string; publicKey: string }> {
  const protocolID = LP_KEY_PROTOCOL;
  const keyID = randomBase64(16);
  const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty: "self", forSelf: true });
  return { protocolID, keyID, publicKey };
}

export class DeployShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployShapeError";
  }
}

/** How an output of ours is taken into a basket after the fact (`internalizeAction` basket insertion). */
export interface BasketFiling {
  outputIndex: number;
  basket: string;
  tags: string[];
  customInstructions: string;
}

export interface DeployPoolInput {
  wallet: WalletInterface;
  /** The wallet's BRC-104 client (`amm.pool.affirm` on `/call`). */
  af: AuthFetchLike;
  /** The AMM app's base URL. */
  base: string;
  tokenId: string;
  tokens: bigint;
  sats: bigint;
  fees: { lpFeeBps: bigint; validatorFeeBps: bigint; commissionBps: bigint };
  validator: ValidatorChoice;
  /** The wallet's held token outputs (`p color assets`). */
  held: HeldOutput[];
  meta?: { sym?: string; dec?: number };
  /** The submit to this skein (default: `POST <base>/submit`, plain fetch). */
  submit?: (topic: string, beef: number[]) => Promise<{ steak?: unknown }>;
}

export interface DeployedPool {
  plan: PoolDeployPlan;
  lpKey: { protocolID: WalletProtocol; keyID: string; publicKey: string };
  /** The validator's affirmation and the deployed pool's state. */
  affirmation: Affirmation;
  /** The createAction arguments the wallet was given. */
  createArgs: Parameters<WalletInterface["createAction"]>[0];
  txid: string;
  /** The deploy as the wallet's AtomicBEEF. */
  tx: number[];
  /** `<txid>.0` */
  outpoint: string;
  /** The position row (`amm-pools`). */
  filing: BasketFiling;
  filed: boolean;
  /** The page's own submit, in words (src/lp/close.ts `steakText`), or its error. */
  submitted: string;
  /** Filing or submit errors (the deploy itself is broadcast). */
  errors: string[];
}

/** Steps 1-4 (see the module comment). Throws before the wallet's action exists; after it, errors are collected. */
export async function deployPool(i: DeployPoolInput): Promise<DeployedPool> {
  const { wallet } = i;
  const meta = i.meta ?? {};
  const sdkId = sdkTokenId(i.tokenId);
  assetIdHex(i.tokenId);
  const held = valueOutputsOf(i.held, i.tokenId).reduce((a, o) => a + o.amount, 0n);
  if (held < i.tokens) throw new PoolDeployError(`Your wallet holds fewer than ${i.tokens} base units of that token`);
  // 1. The LP key.
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

  // 2. The affirmation.
  const affirmation = await affirmPool(i.af, i.base, plan);
  const { lockingScript } = affirmation;

  // 3. The deploy: the pool alone; the module selects the token inputs and adds their change.
  const sym = meta.sym ?? "token";
  const outputs: CreateActionOutput[] = [{ lockingScript, satoshis: Number(plan.sats), outputDescription: lpKeyDescription(describe(`AMM pool: ${sym} / BSV`), lpKey.keyID) }];
  const createArgs = {
    description: describe(`AMM pool deploy: ${sym}`),
    labels: [...transferPlanLabels(sdkId), "amm-pool-deploy"],
    outputs,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  };
  const { txid, tx } = await runTokenAction(wallet, createArgs);

  const out: DeployedPool = {
    plan,
    lpKey,
    affirmation,
    createArgs,
    txid,
    tx,
    outpoint: `${txid}.0`,
    filing: {
      outputIndex: 0,
      basket: POOLS_BASKET,
      tags: [POOL_TAG],
      customInstructions: poolCustomInstructions({ tokenId: sdkId, ...meta, protocolID: lpKey.protocolID, keyID: lpKey.keyID, args: plan.args, validatorIdentity: plan.state.validatorIdentity, nonce: affirmation.nonce, poolId: `${txid}_0` }),
    },
    filed: false,
    submitted: "not submitted",
    errors: [],
  };
  const final = Transaction.fromAtomicBEEF(tx);
  if (final.outputs[0]?.lockingScript.toHex() !== lockingScript) out.errors.push("the wallet's deploy has another output 0 than the affirmed pool");

  // The page's own submit to this skein (the module submitted at the wallet's overlay).
  try {
    const submit = i.submit ?? ((topic: string, beef: number[]) => submitToOverlay(i.base, topic, beef));
    out.submitted = steakText((await submit(plan.topic, tx)) as never);
  } catch (err) {
    out.submitted = "the submit failed";
    out.errors.push(`submit: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. The position row.
  const row: InternalizeOutput = { outputIndex: 0, protocol: "basket insertion", insertionRemittance: { basket: out.filing.basket, tags: out.filing.tags, customInstructions: out.filing.customInstructions } };
  try {
    const r = await wallet.internalizeAction({ tx, outputs: [row], description: describe(`AMM pool deploy: ${sym}`), labels: ["amm-pool-deploy"] });
    out.filed = r.accepted;
  } catch (err) {
    out.errors.push(`internalizeAction: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
