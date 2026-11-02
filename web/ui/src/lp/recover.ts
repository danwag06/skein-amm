/**
 * Recover a position (skein-amm 0.12.1; 0.13.0: both pool layouts): file the `amm-pools` row of a pool
 * whose deploy left none (the deploy broadcast, its filing did not happen),
 * so the positions list shows it and Close works as for any other row. Pages
 * only: the row is the one a deploy files (src/lp/poolDeploy.ts
 * `poolCustomInstructions`), byte for byte.
 *
 *   1. The pasted outpoint (`<txid>.<vout>` or `<txid>_<vout>`, the deploy's
 *      pool output or a later continuation) followed by the chain state to
 *      the pool's current output (`GET <base>/spends`, as src/lp/positions.ts
 *      does), its BEEF from the token's 1Color lookup (`ls_color {txid,
 *      outputIndex}`, as Close takes it), decoded with `PoolTemplate`: the
 *      asset id, the LpPubKey, the validator and the fees.
 *   2. The LP key. First (0.28.0) the LP keys of the wallet's own deploy
 *      history (`history`: src/lp/positions.ts `historyPoolRows`, the pool
 *      rows of its `amm-pool-deploy` actions, spent ones too), each tried
 *      against the LpPubKey. Then: a pool from 0.13.0 on (layout 2) has a random keyID, on no
 *      chain: the deploy kept it in this browser until its row was filed
 *      (src/lp/poolDeploy.ts `PendingDeployStore`); each kept keyID is tried
 *      (`getPublicKey`, BRC-29 to self) against the LpPubKey. A pool before
 *      0.13.0 (layout 1): a deploy keys it by its input 0 (`lpDerivation`), so the
 *      pool is walked back through the BEEF (each transaction's pool input)
 *      to the deploy, the transaction whose pool output carries the
 *      validator's affirmation; every transaction's input 0 on the way is a
 *      candidate. `getPublicKey({protocolID, keyID, counterparty: "self",
 *      forSelf: true})` must equal the LpPubKey: the BRC-29 LP key
 *      (`lpKeyId`), else the pre-BRC-29 one (`P1SAT_PROTOCOL`,
 *      `legacyLpKeyId`). No match: refused, nothing filed — a row is never
 *      filed for a pool this wallet cannot close.
 *   3. `internalizeAction`: the pool's current output, basket insertion into
 *      `amm-pools`, tag `amm-pool`, customInstructions `poolCustomInstructions`
 *      (symbol and decimals as the deploy takes them: the token list, else
 *      the discovery lookup `ls_color`), label `amm-pool-deploy` (the deploy's own: the
 *      manifest carries no other for it).
 *
 * A pool the wallet already files (the pasted outpoint, its current output,
 * or a row followed to the same current output) is left as it is.
 */
import { P1SAT_PROTOCOL } from "@1sat/actions";
import { PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { PoolTemplate, type Pool } from "../pool";
import type { LookupOutput } from "../lib/overlay";
import type { Spend } from "../lib/skein";
import { parseOutpoint, sdkTokenId, tokenIdOfWire } from "../lib/tokenId";
import { POOLS_BASKET } from "../wallet/color";
import { LP_KEY_PROTOCOL, PendingDeployStore, legacyLpKeyId, lpKeyId, poolCustomInstructions, type BasketFiling, type BasketRow } from "./poolDeploy";
import { POOL_TAG, isPoolRow } from "./poolRows";
import { positionRowsOf } from "./positions";

export class RecoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverError";
  }
}

/** The page's notices (one sentence each). */
export const RECOVER_TEXT = {
  notOutpoint: "Paste a pool outpoint: <txid>.<vout> or <txid>_<vout>.",
  filed: "That pool is already in your positions.",
  closed: "That pool is closed: there is nothing left to recover.",
  spent: "That outpoint is spent and the exchange does not follow it to a pool.",
  notPool: "That outpoint is not a pool.",
  noDeploy: "The overlay's answer does not reach back to this pool's deploy, so its LP key cannot be checked.",
  notMine: "This pool's LP key is not this wallet's.",
  notKept: "This pool's LP key is not kept in this browser (it was deployed elsewhere, or the record is gone), so it cannot be recovered here.",
} as const;

/** How many transactions back the deploy is looked for (one per swap). */
const MAX_HOPS = 1000;

/** An outpoint as written here and in the wallet, `<txid>.<vout>`. */
const dotted = (o: { txid: string; vout: number }) => `${o.txid}.${o.vout}`;

function describe(text: string): string {
  return text.length <= 50 ? text : `${text.slice(0, 49)}…`;
}

/** The pasted outpoint, `<txid>.<vout>`, or null. */
export function parsePoolOutpoint(text: string): string | null {
  const r = parseOutpoint(text);
  return r ? dotted(r) : null;
}

/** The outpoint an input spends, `<txid>.<vout>`. */
function spentBy(tx: Transaction, n: number): string | null {
  const i = tx.inputs[n];
  if (!i) return null;
  const txid = i.sourceTXID ?? i.sourceTransaction?.id("hex");
  return txid ? `${txid}.${i.sourceOutputIndex}` : null;
}

/** A pool of `assetId` at `tx`'s output `vout`, or null. */
function poolAt(tx: Transaction, vout: number, assetId: string): Pool | null {
  const o = tx.outputs[vout];
  const p = o ? PoolTemplate.decode(o.lockingScript) : null;
  return p && p.args.assetId === assetId ? p : null;
}

/**
 * The key-input candidates of the pool created at `tx`'s output `vout`:
 * input 0 of each transaction from `tx` back to the deploy (the one whose
 * pool output carries the affirmation), newest first. `reached`: the deploy
 * was found in the BEEF.
 */
export function keyInputCandidates(tx: Transaction, vout: number, assetId: string): { candidates: string[]; reached: boolean } {
  const candidates: string[] = [];
  let cur: Transaction | undefined = tx;
  let at = vout;
  for (let hop = 0; cur && hop < MAX_HOPS; hop++) {
    const in0 = spentBy(cur, 0);
    if (in0 && !candidates.includes(in0)) candidates.push(in0);
    if (poolAt(cur, at, assetId)?.affirmation) return { candidates, reached: true };
    let next: Transaction | undefined;
    for (const i of cur.inputs) {
      const src = i.sourceTransaction;
      if (src && poolAt(src, i.sourceOutputIndex, assetId)) {
        next = src;
        at = i.sourceOutputIndex;
        break;
      }
    }
    cur = next;
  }
  return { candidates, reached: false };
}

/** The wallet key that is the pool's LpPubKey: BRC-29 (`lpKeyId`) over every candidate first, then the pre-BRC-29 key (`legacyLpKeyId`). */
export async function findLpKey(
  wallet: WalletInterface,
  lpPubKey: string,
  candidates: string[],
): Promise<{ protocolID: WalletProtocol; keyID: string; keyInput: string } | null> {
  const want = PublicKey.fromString(lpPubKey).toString();
  const tries: [WalletProtocol, (o: string) => string][] = [
    [LP_KEY_PROTOCOL, lpKeyId],
    [P1SAT_PROTOCOL as WalletProtocol, legacyLpKeyId],
  ];
  for (const [protocolID, keyOf] of tries) {
    for (const c of candidates) {
      const keyID = keyOf(c);
      const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty: "self", forSelf: true });
      if (PublicKey.fromString(publicKey).toString() === want) return { protocolID, keyID, keyInput: c };
    }
  }
  return null;
}

export interface RecoverInput {
  wallet: WalletInterface;
  /** What was pasted. */
  outpoint: string;
  /** The wallet's `amm-pools` rows. */
  rows: BasketRow[];
  /** `GET <base>/spends` (src/lib/skein.ts `readSpend`). */
  spendOf: (outpoint: string) => Promise<Spend>;
  /** BRC-207 `color-spendability` at `ls_color_<tokenId>` (src/lp/positions.ts `colorOutput`). */
  outputOf: (outpoint: string) => Promise<LookupOutput>;
  /** Symbol and decimals: the token list, else the discovery lookup `ls_color` at the host root. */
  metaOf: (tokenId: string) => Promise<{ sym?: string; dec?: number } | null>;
  /** 0.28.0: the pool rows of the wallet's deploy history (spent ones too), whose LP keys are tried first. */
  history?: BasketRow[];
  /** Layout 2: the LP keyIDs this browser kept (default: `PendingDeployStore`). */
  pending?: PendingDeployStore;
}

export interface RecoveredPosition {
  /** The output filed, the pool's current output, `<txid>.<vout>`. */
  outpoint: string;
  tokenId: string;
  sym?: string;
  lpKey: { protocolID: WalletProtocol; keyID: string; counterparty: "self" };
  /** Layout 1: the deploy's input 0 the LP key is keyed by, `<txid>.<vout>`; layout 2: "". */
  keyInput: string;
  filing: BasketFiling;
  internalizeArgs: Parameters<WalletInterface["internalizeAction"]>[0];
  filed: boolean;
}

/** Steps 1-3 (see the module comment). Throws `RecoverError` with the page's notice; nothing is filed then. */
export async function recoverPosition(i: RecoverInput): Promise<RecoveredPosition> {
  const pasted = parsePoolOutpoint(i.outpoint);
  if (!pasted) throw new RecoverError(RECOVER_TEXT.notOutpoint);
  const filed = new Set(i.rows.filter(isPoolRow).map((r) => parsePoolOutpoint(r.outpoint)).filter((o): o is string => o !== null));
  if (filed.has(pasted)) throw new RecoverError(RECOVER_TEXT.filed);

  // 1. The pool's current output and its BEEF.
  const s = await i.spendOf(pasted);
  if (s.closed) throw new RecoverError(RECOVER_TEXT.closed);
  const current = s.current ?? (s.spentBy ? null : pasted);
  if (!current) throw new RecoverError(RECOVER_TEXT.spent);
  if (filed.has(current)) throw new RecoverError(RECOVER_TEXT.filed);
  for (const row of filed) {
    const r = await i.spendOf(row).catch(() => null);
    if (r && !r.closed && r.current === current) throw new RecoverError(RECOVER_TEXT.filed);
  }
  const output = await i.outputOf(current);
  const tx = Transaction.fromAtomicBEEF(output.beef);
  const op = parseOutpoint(current)!;
  if (tx.id("hex") !== op.txid) throw new RecoverError(RECOVER_TEXT.notPool);
  const o = tx.outputs[op.vout];
  const pool = o ? PoolTemplate.decode(o.lockingScript) : null;
  if (!pool) throw new RecoverError(RECOVER_TEXT.notPool);
  const tokenId = sdkTokenId(tokenIdOfWire(Utils.toArray(pool.args.assetId, "hex")));

  // 2. The LP key.
  let lp: { protocolID: WalletProtocol; keyID: string; keyInput: string } | null = null;
  const want = PublicKey.fromString(pool.state.lpPubKey).toString();
  for (const h of positionRowsOf(i.history ?? [])) {
    if (h.lpKey.counterparty !== "self") continue;
    const { publicKey } = await i.wallet.getPublicKey({ protocolID: h.lpKey.protocolID, keyID: h.lpKey.keyID, counterparty: "self", forSelf: true });
    if (PublicKey.fromString(publicKey).toString() === want) {
      lp = { protocolID: h.lpKey.protocolID, keyID: h.lpKey.keyID, keyInput: "" };
      break;
    }
  }
  if (lp) {
    /* the deploy history's key */
  } else if (pool.version === 2) {
    const pending = i.pending ?? new PendingDeployStore();
    for (const d of pending.list()) {
      const { publicKey } = await i.wallet.getPublicKey({ protocolID: LP_KEY_PROTOCOL, keyID: d.keyID, counterparty: "self", forSelf: true });
      if (PublicKey.fromString(publicKey).toString() === want) {
        lp = { protocolID: LP_KEY_PROTOCOL, keyID: d.keyID, keyInput: "" };
        break;
      }
    }
    if (!lp) throw new RecoverError(RECOVER_TEXT.notKept);
  } else {
    const { candidates, reached } = keyInputCandidates(tx, op.vout, pool.args.assetId);
    lp = await findLpKey(i.wallet, pool.state.lpPubKey, candidates);
    if (!lp) throw new RecoverError(reached ? RECOVER_TEXT.notMine : RECOVER_TEXT.noDeploy);
  }

  // 3. The row.
  const meta = (await i.metaOf(tokenId).catch(() => null)) ?? {};
  const sym = meta.sym;
  const filing: BasketFiling = {
    outputIndex: op.vout,
    basket: POOLS_BASKET,
    tags: [POOL_TAG],
    customInstructions: poolCustomInstructions({
      tokenId,
      ...(sym ? { sym } : {}),
      ...(meta.dec !== undefined ? { dec: meta.dec } : {}),
      protocolID: lp.protocolID,
      keyID: lp.keyID,
      args: pool.args,
      validatorIdentity: pool.state.validatorIdentity,
      ...(pool.state.nonce ? { nonce: pool.state.nonce } : {}),
    }),
  };
  const row: InternalizeOutput = { outputIndex: filing.outputIndex, protocol: "basket insertion", insertionRemittance: { basket: filing.basket, tags: filing.tags, customInstructions: filing.customInstructions } };
  const internalizeArgs = { tx: output.beef, outputs: [row], description: describe(`AMM pool recover: ${sym ?? "token"}`), labels: ["amm-pool-deploy"] };
  const r = await i.wallet.internalizeAction(internalizeArgs);
  if (r.accepted && pool.version === 2) (i.pending ?? new PendingDeployStore()).remove(lp.keyID);
  return {
    outpoint: current,
    tokenId,
    ...(sym ? { sym } : {}),
    lpKey: { protocolID: lp.protocolID, keyID: lp.keyID, counterparty: "self" },
    keyInput: lp.keyInput,
    filing,
    internalizeArgs,
    filed: r.accepted,
  };
}
