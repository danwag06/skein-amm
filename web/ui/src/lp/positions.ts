/**
 * The connected wallet's positions (skein-amm 0.9.0, David Case 2026-10-09;
 * 0.12.0: the rows in the exchange's basket `amm-pools`, no claim): the pool
 * rows its deploys filed (op `amm-pool`, the LP key in their
 * customInstructions), each read from the CHAIN STATE by outpoint —
 * `GET <base>/spends` (amm-p2p reads.zig, the chain app's `spent` as the
 * overlay reads it): the pool followed from the deploy's output to its
 * current output (each swap's continuation), or closed (by the LP or by the
 * validator, docs/AMM.md "The validator's Close").
 *
 * 0.29.3: the deploy HISTORY is the first source (`historyPoolRows`): 0.29.4,
 * each `amm-pool-deploy` action's pool output names its LP keyID in its
 * description (`… · amm-lp <hex>`) and its script is the pool (no
 * customInstructions needed: BRC-100's listActions does not answer them). 0.28.0: the rows also come from the wallet's HISTORY (`historyPoolRows`):
 * `listOutputs` answers spendable outputs only, so a pool output the wallet
 * itself spent (the LP swapped against its own pool) left no row and the
 * position vanished; the deploys' actions (label `amm-pool-deploy`) still
 * carry the output filed in `amm-pools` with its customInstructions. Both
 * sets, deduped by outpoint, are followed by `/spends` as before.
 *
 * The current output's BEEF comes from the token's 1Color lookup
 * (0.20.1: BRC-207's `color-spendability` at `ls_color_<tokenId>`: the
 * output if admitted and unspent, with its BEEF; `ls_color {txid,
 * outputIndex}` until 0.19.0).
 */
import { Transaction, Utils, type WalletInterface, type WalletProtocol } from "@bsv/sdk";
import { PoolTemplate, type Pool } from "../pool";
import { lookup, lpFeesOf, parseOutputList, type LpFees, type LookupOutput, type SignedFetch } from "../lib/overlay";
import { readSpend, type Spend } from "../lib/skein";
import { colorQuery, parseOutpoint, sdkTokenId, tokenIdOfWire, tokenIdText } from "../lib/tokenId";
import { POOLS_BASKET } from "../wallet/color";
import { POOL_TAG, isPoolRow } from "./poolRows";
import { LP_KEY_PROTOCOL, lpKeyIdOfDescription, poolCustomInstructions, type BasketRow } from "./poolDeploy";

/** The wallet key that is a pool's LpPubKey (a BRC-29 key to self, or a pre-BRC-29 1Sat key). */
export interface LpKeyRef {
  protocolID: WalletProtocol;
  keyID: string;
  counterparty: string;
}

/** A pool row of the wallet: the deploy's pool output as filed. */
export interface PositionRow {
  /** The deploy's pool output, `<txid>.<vout>`. */
  deployOutpoint: string;
  /** `<txid>_<vout>` */
  tokenId: string;
  sym?: string;
  dec?: number;
  lpKey: LpKeyRef;
  validatorIdentity?: string;
  /** 0.32.0: the pool's LpPubKey, from the filed output's script (the pool's state); what the LP fees are asked by. */
  lpPubKey?: string;
}

/** The label a pool deploy (and a Recover) gives its action (src/lp/poolDeploy.ts). */
export const POOL_DEPLOY_LABEL = "amm-pool-deploy";

/**
 * The pool rows of the wallet's deploy actions (0.28.0): every output of an action labelled
 * `amm-pool-deploy` filed in `amm-pools` as a pool row (tag `amm-pool` or op `amm-pool` in its
 * customInstructions), spent or not. `listActions` with `includeOutputs` (and, where the wallet
 * takes it, `includeCustomInstructions`), paged; a wallet that refuses the read: none.
 */
export async function historyPoolRows(wallet: WalletInterface): Promise<BasketRow[]> {
  const out: BasketRow[] = [];
  const limit = 1000;
  try {
    for (let offset = 0; offset < 100_000; offset += limit) {
      const r = await wallet.listActions({ labels: [POOL_DEPLOY_LABEL], includeOutputs: true, includeOutputLockingScripts: true, includeCustomInstructions: true, limit, offset } as Parameters<WalletInterface["listActions"]>[0]);
      for (const a of r.actions ?? []) {
        for (const o of a.outputs ?? []) {
          const outpoint = `${a.txid}.${o.outputIndex}`;
          // 0.29.4: the LP keyID from the pool output's description (`… · amm-lp <hex>`), the pool from its script.
          const keyID = lpKeyIdOfDescription(o.outputDescription);
          const pool = keyID && o.lockingScript ? PoolTemplate.decode(o.lockingScript) : null;
          if (pool && keyID) {
            const tokenId = sdkTokenId(tokenIdOfWire(Utils.toArray(pool.args.assetId, "hex")));
            out.push({
              outpoint,
              satoshis: o.satoshis,
              lockingScript: o.lockingScript!,
              tags: [POOL_TAG],
              customInstructions: poolCustomInstructions({ tokenId, protocolID: LP_KEY_PROTOCOL, keyID, args: pool.args, validatorIdentity: pool.state.validatorIdentity, ...(pool.state.nonce ? { nonce: pool.state.nonce } : {}) }),
            });
            continue;
          }
          // A wallet that answers the output's customInstructions (0.28.0): the filed row as it is.
          if (o.basket !== POOLS_BASKET) continue;
          const row: BasketRow = { outpoint, satoshis: o.satoshis, ...(o.tags ? { tags: o.tags } : {}), ...(o.customInstructions ? { customInstructions: o.customInstructions } : {}) };
          if (isPoolRow(row)) out.push(row);
        }
      }
      if ((r.actions?.length ?? 0) < limit || offset + limit >= (r.totalActions ?? 0)) break;
    }
  } catch {
    /* no history read: the basket's rows alone */
  }
  return out;
}

/** Rows deduped by outpoint (`<txid>.<vout>`), the first kept (the basket's before the history's). */
export function mergePoolRows(...sets: BasketRow[][]): BasketRow[] {
  const seen = new Set<string>();
  const out: BasketRow[] = [];
  for (const r of sets.flat()) {
    const op = parseOutpoint(r.outpoint);
    const k = op ? `${op.txid}.${op.vout}` : r.outpoint;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** The wallet's pool rows (`isPoolRow`). */
export function positionRowsOf(rows: BasketRow[]): PositionRow[] {
  const out: PositionRow[] = [];
  for (const r of rows) {
    if (!isPoolRow(r)) continue;
    const op = parseOutpoint(r.outpoint);
    if (!op) continue;
    try {
      const ci = JSON.parse(r.customInstructions ?? "{}") as {
        id?: string;
        sym?: string;
        dec?: string | number;
        protocolID?: WalletProtocol;
        keyID?: string;
        counterparty?: string;
        amm?: { validatorIdentity?: string };
      };
      if (!Array.isArray(ci.protocolID) || typeof ci.keyID !== "string" || typeof ci.id !== "string") continue;
      const tid = parseOutpoint(ci.id.replace("_", "."));
      const filed = r.lockingScript ? PoolTemplate.decode(r.lockingScript) : null;
      out.push({
        deployOutpoint: `${op.txid}.${op.vout}`,
        tokenId: tid ? tokenIdText(tid) : ci.id,
        ...(ci.sym ? { sym: ci.sym } : {}),
        ...(ci.dec !== undefined ? { dec: Number(ci.dec) } : {}),
        lpKey: { protocolID: ci.protocolID, keyID: ci.keyID, counterparty: typeof ci.counterparty === "string" ? ci.counterparty : "self" },
        ...(typeof ci.amm?.validatorIdentity === "string" ? { validatorIdentity: ci.amm.validatorIdentity } : {}),
        ...(filed ? { lpPubKey: filed.state.lpPubKey } : {}),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** An unspent 1Color output of token `tokenId` with its BEEF: BRC-207 `color-spendability` at `ls_color_<tokenId>`, its instance `base`. */
export async function colorOutput(af: SignedFetch | null, base: string, tokenId: string, outpoint: string): Promise<LookupOutput> {
  const op = parseOutpoint(outpoint);
  if (!op) throw new Error(`not an outpoint: ${outpoint}`);
  const { service, query } = colorQuery("color-spendability", tokenId, [`${op.txid}.${op.vout}`]);
  const outs = parseOutputList(await lookup(af, base, service, query));
  const o = outs.find((x) => x.outputIndex === op.vout) ?? outs[0];
  if (!o) throw new Error(`${service}: no unspent output ${outpoint}`);
  return o;
}

export interface LoadedPosition {
  row: PositionRow;
  /** The pool's current output (`<txid>.<vout>`); null when closed. */
  current: string | null;
  closed: boolean;
  /** The current output, decoded, with its BEEF (absent when closed or not found). */
  output?: LookupOutput;
  pool?: Pool;
  sats?: bigint;
}

/** One row read from the chain state (and, when live, its current output). */
export async function loadPosition(
  af: SignedFetch | null,
  base: string,
  row: PositionRow,
  spendOf: (outpoint: string) => Promise<Spend> = (o) => readSpend(base, o),
  outputOf: (outpoint: string) => Promise<LookupOutput> = (o) => colorOutput(af, base, row.tokenId, o),
): Promise<LoadedPosition> {
  const s = await spendOf(row.deployOutpoint);
  const current = s.closed ? null : (s.current ?? (s.spentBy ? null : row.deployOutpoint));
  const out: LoadedPosition = { row, current, closed: s.closed };
  if (!current) return out;
  const output = await outputOf(current);
  const tx = Transaction.fromAtomicBEEF(output.beef);
  const o = tx.outputs[output.outputIndex];
  const pool = o ? PoolTemplate.decode(o.lockingScript) : null;
  if (!pool || !o) return out;
  return { ...out, output, pool, sats: BigInt(o.satoshis ?? 0) };
}

/**
 * A position's LP fees (0.32.0): `ls_amm_<assetId>`'s `{tokenId, lpPubKey}` at the token's instance,
 * the pool lineage of that LpPubKey (constant along it, one per deploy) totalled by the lookup.
 * Null when the instance does not answer (an older lookup): the page then shows no fees line.
 */
export async function positionFees(
  af: SignedFetch | null,
  base: string,
  tokenId: string,
  lpPubKey: string,
  feesOf: (lpPubKey: string) => Promise<LpFees> = (k) => lpFeesOf(af, base, tokenId, k),
): Promise<{ sats: bigint; tokens: bigint } | null> {
  try {
    const f = await feesOf(lpPubKey);
    return { sats: f.sats, tokens: f.tokens };
  } catch {
    return null;
  }
}

/** One token's positions summed (0.32.0): the Liquidity page's line above the cards. */
export interface TokenFees {
  tokenId: string;
  sym: string;
  dec: number;
  positions: number;
  sats: bigint;
  tokens: bigint;
}

/** Positions (live and closed) summed per token, in the order each token first appears; fees not told count as 0. */
export function feesByToken(ps: { tokenId: string; sym: string; dec: number; feesEarnedSats?: bigint; feesEarnedTokens?: bigint }[]): TokenFees[] {
  const by = new Map<string, TokenFees>();
  for (const p of ps) {
    let t = by.get(p.tokenId);
    if (!t) {
      t = { tokenId: p.tokenId, sym: p.sym, dec: p.dec, positions: 0, sats: 0n, tokens: 0n };
      by.set(p.tokenId, t);
    }
    t.positions += 1;
    t.sats += p.feesEarnedSats ?? 0n;
    t.tokens += p.feesEarnedTokens ?? 0n;
  }
  return [...by.values()];
}
