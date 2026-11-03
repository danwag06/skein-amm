/**
 * Recover a position (skein-amm 0.12.1; 0.29.1: layout 2 only): file the `amm-pools` row of a pool
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
 *      history (`history`: src/lp/positions.ts `historyPoolRows`: 0.29.4, the
 *      `… · amm-lp <hex>` description of each `amm-pool-deploy` action's pool
 *      output, written by the deploy itself), each tried (`getPublicKey`, BRC-29 to self) against the
 *      LpPubKey. No match: refused, nothing filed — a row is never filed for a
 *      pool this wallet cannot close. Nothing is kept in the browser.
 *   3. `internalizeAction`: the pool's current output, basket insertion into
 *      `amm-pools`, tag `amm-pool`, customInstructions `poolCustomInstructions`
 *      (symbol and decimals as the deploy takes them: the token list, else
 *      the discovery lookup `ls_color`), label `amm-pool-deploy` (the deploy's own: the
 *      manifest carries no other for it).
 *
 * A pool the wallet already files (the pasted outpoint, its current output,
 * or a row followed to the same current output) is left as it is.
 */
import { PublicKey, Transaction, Utils, type InternalizeOutput, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { PoolTemplate } from "../pool";
import type { LookupOutput } from "../lib/overlay";
import type { Spend } from "../lib/skein";
import { parseOutpoint, sdkTokenId, tokenIdOfWire } from "../lib/tokenId";
import { POOLS_BASKET } from "../wallet/color";
import { poolCustomInstructions, type BasketFiling, type BasketRow } from "./poolDeploy";
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
  notKept: "This pool's LP key is not in this wallet's deploy history (it was deployed from another wallet), so it cannot be recovered here.",
} as const;

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
}

export interface RecoveredPosition {
  /** The output filed, the pool's current output, `<txid>.<vout>`. */
  outpoint: string;
  tokenId: string;
  sym?: string;
  lpKey: { protocolID: WalletProtocol; keyID: string; counterparty: "self" };
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
  let lp: { protocolID: WalletProtocol; keyID: string } | null = null;
  const want = PublicKey.fromString(pool.state.lpPubKey).toString();
  for (const h of positionRowsOf(i.history ?? [])) {
    if (h.lpKey.counterparty !== "self") continue;
    const { publicKey } = await i.wallet.getPublicKey({ protocolID: h.lpKey.protocolID, keyID: h.lpKey.keyID, counterparty: "self", forSelf: true });
    if (PublicKey.fromString(publicKey).toString() === want) {
      lp = { protocolID: h.lpKey.protocolID, keyID: h.lpKey.keyID };
      break;
    }
  }
  if (!lp) throw new RecoverError(RECOVER_TEXT.notKept);

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
  return {
    outpoint: current,
    tokenId,
    ...(sym ? { sym } : {}),
    lpKey: { protocolID: lp.protocolID, keyID: lp.keyID, counterparty: "self" },
    filing,
    internalizeArgs,
    filed: r.accepted,
  };
}
