/**
 * executeSwap (0.31.1): a leg the validator refuses `pool_spent` with the pool's newest state is
 * repriced against that state (the engine's single-pool math) and sent ONCE more while the order's
 * bound holds; anything else is as before. The leg's build and the relay are faked here (their own
 * tests are swap.test.ts / exchange.test.ts): this is the order of calls and the leg's result.
 * 0.34.0: the pools come from the pools route the page holds, the pools' BEEF from ONE `GET
 * /pools/beef?lp=` (the retry: its LP key again); no browser note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Beef } from "@bsv/sdk";
import { computeSwap, type PoolState } from "@amm-poc/matching-engine";
import type { PlannedLeg, PreparedSwap, SatsInput } from "../src/market/swapAction";
import type { SwapOutcome } from "../src/market/swapFlow";
import { PEER } from "./liveRead";

const relayed: { pool: string; peerId: string }[] = [];
const outcomes: SwapOutcome[] = [];
const lookedUp: string[] = [];
const askedKeys: string[][] = [];
let funding = 25_000;

vi.mock("../src/market/swapFlow", async (orig) => ({
  ...(await orig<typeof import("../src/market/swapFlow")>()),
  relaySwap: vi.fn(async (_c: unknown, p: PreparedSwap, peerId: string) => {
    relayed.push({ pool: p.pool, peerId });
    return outcomes.shift() ?? { status: "failed", reason: "no outcome scripted" };
  }),
}));
vi.mock("../src/market/swapAction", async (orig) => {
  const real = await orig<typeof import("../src/market/swapAction")>();
  return {
    ...real,
    planSwapLeg: vi.fn(async (i: { leg: { outpoint: string }; pool: PoolState }) => ({ pool: i.leg.outpoint, validator: i.pool.validatorIdentityKey, bsvIn: true, funding: { satoshis: funding } }) as unknown as PlannedLeg),
    prepareSwap: vi.fn(async (i: { leg: { outpoint: string }; pool: PoolState }) => {
      const txid = (i.leg.outpoint.slice(0, 2) + "f").padEnd(64, "0");
      return { pool: i.leg.outpoint, validator: i.pool.validatorIdentityKey, swap: { id: () => txid }, payout: { kind: "brc29", outputIndex: 1 }, commission: { amount: 0n, pkh: "", to: "none" } } as unknown as PreparedSwap;
    }),
  };
});
vi.mock("../src/market/activeSwap", async (orig) => ({
  ...(await orig<typeof import("../src/market/activeSwap")>()),
  swapSatsHoldings: vi.fn(async () => [{ outpoint: `${"77".repeat(32)}.0`, txid: "77".repeat(32), vout: 0, satoshis: funding } as unknown as SatsInput]),
  swapHoldingBeef: vi.fn(async () => new Beef()),
}));
vi.mock("../src/lib/overlay", async (orig) => {
  const real = await orig<typeof import("../src/lib/overlay")>();
  return {
    ...real,
    readPoolsBeef: vi.fn(async (_b: string, keys?: string[]) => {
      askedKeys.push(keys ?? []);
      return { pools: [{ ...pool(OLD, 1_000_000n, 5_000_000n), lpPubKey: LP }], beef: [] };
    }),
    poolOutputOf: vi.fn((_pb: unknown, outpoint: string) => {
      lookedUp.push(outpoint);
      return { beef: [], outputIndex: 0 };
    }),
  };
});

const { executeSwap, quoteSwap, setExchangeContext } = await import("../src/data/exchange");

const ORIGIN = "http://alice.localhost:8300";
const TOKEN = `${"ab".repeat(32)}_0`;
const TOPIC = `tm_color_${TOKEN}`;
const SKEIN = "02" + "33".repeat(32);
const ME = "02" + "11".repeat(32);
const OLD = `${"c1".repeat(32)}_0`;
const NEW = `${"d2".repeat(32)}_0`;
const LP = "03" + "55".repeat(32);
const pool = (outpoint: string, bsv: bigint, tokens: bigint, validator = SKEIN): PoolState => ({ outpoint, bsvReserve: bsv, tokenReserve: tokens, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: validator });
const wire = (p: PoolState) => ({ outpoint: p.outpoint, bsvReserve: Number(p.bsvReserve), tokenReserve: Number(p.tokenReserve), liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: p.validatorIdentityKey });

const af = { fetch: async () => new Response("{}", { status: 404 }) };
/** The pools route's answer the Swap page holds (P2): the one pool, its LP key, its validator's peer. */
const held = () => ({ market: { commissionPkh: null, minCommissionBps: 0 }, validators: [{ identity: SKEIN, peerId: PEER }], pools: [{ ...pool(OLD, 1_000_000n, 5_000_000n), lpPubKey: LP, validatorPeerId: PEER }] });
const accepted = (txid: string): SwapOutcome => ({ status: "accepted", id: "r2", txid, completed: { internalized: false } as never });
const spent = (p?: PoolState): SwapOutcome => ({ status: "refused", id: "r1", reason: "pool_spent", ...(p ? { pool: p } : {}) });

beforeEach(() => {
  relayed.length = 0;
  outcomes.length = 0;
  lookedUp.length = 0;
  askedKeys.length = 0;
  setExchangeContext({ base: `${ORIGIN}/amm`, wallet: {} as never, signedFor: () => af as never, identityKey: ME });
});

const buy = () => quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, held(), { sym: "TST", dec: 0 });

describe("executeSwap: a leg refused pool_spent (0.31.1)", () => {
  it("with the pool's newest state: repriced, rebuilt on the new outpoint (its BEEF by the pool's LP key), relayed once more to the same validator → filled", async () => {
    const q = buy();
    const moved = pool(NEW, 1_000_200n, 4_999_000n);
    expect(computeSwap(moved, "bsvToToken", 20_000n)!.amountOut).toBeGreaterThanOrEqual(q.minAmountOut);
    outcomes.push(spent(moved), accepted("ee".repeat(32)));
    const r = await executeSwap(q);
    expect(relayed).toEqual([{ pool: OLD, peerId: PEER }, { pool: NEW, peerId: PEER }]);
    expect(lookedUp).toEqual([OLD, NEW]);
    expect(askedKeys).toEqual([[LP], [LP]]);
    expect(r.status).toBe("filled");
    expect(r.legs).toEqual([{ poolOutpoint: OLD.replace("_", "."), status: "filled", txid: "ee".repeat(32), repriced: true }]);
  });

  it("repriced below the order's minimum: the leg fails with the new amountOut, nothing relayed the second time", async () => {
    const q = buy();
    const moved = pool(NEW, 2_000_000n, 2_500_000n);
    const out = computeSwap(moved, "bsvToToken", 20_000n)!.amountOut;
    expect(out).toBeLessThan(q.minAmountOut);
    outcomes.push(spent(moved));
    const r = await executeSwap(q);
    expect(relayed).toHaveLength(1);
    expect(lookedUp).toEqual([OLD]);
    expect(r.status).toBe("failed");
    expect(r.legs[0]!.error).toBe(`repriced below your minimum: ${out} for this leg`);
    expect(r.legs[0]!.repriced).toBeUndefined();
  });

  it("refused again on the retry: the leg fails as before, no third relay", async () => {
    const q = buy();
    outcomes.push(spent(pool(NEW, 1_000_200n, 4_999_000n)), spent(pool(`${"e3".repeat(32)}_0`, 1_000_400n, 4_998_000n)));
    const r = await executeSwap(q);
    expect(relayed.map((x) => x.pool)).toEqual([OLD, NEW]);
    expect(r.status).toBe("failed");
    expect(r.legs[0]!.error).toBe("refused: pool_spent");
  });

  it("refused pool_spent without a state: unchanged (fails, no retry)", async () => {
    const q = buy();
    outcomes.push(spent());
    const r = await executeSwap(q);
    expect(relayed).toHaveLength(1);
    expect(r.legs[0]).toEqual({ poolOutpoint: OLD.replace("_", "."), status: "failed", error: "refused: pool_spent" });
  });

  it("the newest state names a validator that is not live: the leg fails \"the pool's validator changed\", nothing relayed again", async () => {
    const q = buy();
    outcomes.push(spent(pool(NEW, 1_000_200n, 4_999_000n, "03" + "44".repeat(32))));
    const r = await executeSwap(q);
    expect(relayed).toHaveLength(1);
    expect(r.legs[0]!.error).toBe("the pool's validator changed");
  });
});
