/**
 * executeSwap (0.31.1): a leg the validator refuses `pool_spent` with the pool's newest state is
 * repriced against that state (the engine's single-pool math) and sent ONCE more while the order's
 * bound holds; anything else is as before. The leg's build and the relay are faked here (their own
 * tests are swap.test.ts / exchange.test.ts): this is the order of calls and the leg's result.
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
    lookupPoolOutput: vi.fn(async (_af: unknown, _b: string, _t: string, outpoint: string) => {
      lookedUp.push(outpoint);
      return { beef: [], outputIndex: 0 };
    }),
  };
});

const { executeSwap, quoteSwap, setExchangeContext } = await import("../src/data/exchange");
const { PendingPayoutStore } = await import("../src/wallet/pendingPayouts");

const ORIGIN = "http://alice.localhost:8300";
const TOKEN = `${"ab".repeat(32)}_0`;
const TOPIC = `tm_color_${TOKEN}`;
const SKEIN = "02" + "33".repeat(32);
const ME = "02" + "11".repeat(32);
const OLD = `${"c1".repeat(32)}_0`;
const NEW = `${"d2".repeat(32)}_0`;
const pool = (outpoint: string, bsv: bigint, tokens: bigint, validator = SKEIN): PoolState => ({ outpoint, bsvReserve: bsv, tokenReserve: tokens, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: validator });
const wire = (p: PoolState) => ({ outpoint: p.outpoint, bsvReserve: Number(p.bsvReserve), tokenReserve: Number(p.tokenReserve), liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: p.validatorIdentityKey });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-bsv-auth-identity-key": SKEIN } });
async function route(url: string, init?: { body?: unknown }): Promise<Response> {
  const path = new URL(url).pathname.replace(/^\/@[^/]+/, "").replace(/^\/amm/, "");
  if (path === "/tokens") return json([{ tokenId: TOKEN, topic: TOPIC, sym: "TST", dec: 0, status: "enabled", since: 1 }]);
  if (path === `/.live/${TOPIC}-live`) return json([{ sender: SKEIN, at: Date.now(), from: PEER, body: "" }]);
  if (path === "/lookup") return json({ type: "freeform", result: [wire(pool(OLD, 1_000_000n, 5_000_000n))] });
  if (path === "/call") {
    const b = JSON.parse(String(init!.body)) as { fn: string };
    if (b.fn === "amm.swap.terms") return json({ fn: b.fn, result: { commissionPkh: null, minCommissionBps: 0 } });
  }
  return json({ error: `no route ${url}` }, 404);
}
const af = { fetch: (url: string, init?: { body?: unknown }) => route(url, init) };

const mem = new Map<string, string>();
const store = new PendingPayoutStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
const accepted = (txid: string): SwapOutcome => ({ status: "accepted", id: "r2", txid, completed: { internalized: false } as never });
const spent = (p?: PoolState): SwapOutcome => ({ status: "refused", id: "r1", reason: "pool_spent", ...(p ? { pool: p } : {}) });

beforeEach(() => {
  relayed.length = 0;
  outcomes.length = 0;
  lookedUp.length = 0;
  mem.clear();
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => route(url, init as never));
  setExchangeContext({ base: `${ORIGIN}/amm`, wallet: {} as never, signedFor: () => af as never, identityKey: ME, payouts: store });
});
afterEach(() => vi.unstubAllGlobals());

const buy = () => quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false });

describe("executeSwap: a leg refused pool_spent (0.31.1)", () => {
  it("with the pool's newest state: repriced, rebuilt on the new outpoint, relayed once more to the same validator → filled; the old pending entry gone, the new one there", async () => {
    const q = await buy();
    const moved = pool(NEW, 1_000_200n, 4_999_000n);
    expect(computeSwap(moved, "bsvToToken", 20_000n)!.amountOut).toBeGreaterThanOrEqual(q.minAmountOut);
    outcomes.push(spent(moved), accepted("ee".repeat(32)));
    let during: string[] = [];
    const r = await executeSwap(q);
    expect(relayed).toEqual([{ pool: OLD, peerId: PEER }, { pool: NEW, peerId: PEER }]);
    expect(lookedUp).toEqual([OLD, NEW]);
    expect(r.status).toBe("filled");
    expect(r.legs).toEqual([{ poolOutpoint: OLD.replace("_", "."), status: "filled", txid: "ee".repeat(32), repriced: true }]);
    during = store.list().map((x) => x.id);
    expect(during).toEqual([`${"ee".repeat(32)}:1`]);
    expect(during.some((id) => id.startsWith("c1f"))).toBe(false);
  });

  it("repriced below the order's minimum: the leg fails with the new amountOut, nothing relayed the second time", async () => {
    const q = await buy();
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
    expect(store.list()).toEqual([]);
  });

  it("refused again on the retry: the leg fails as before, no third relay", async () => {
    const q = await buy();
    outcomes.push(spent(pool(NEW, 1_000_200n, 4_999_000n)), spent(pool(`${"e3".repeat(32)}_0`, 1_000_400n, 4_998_000n)));
    const r = await executeSwap(q);
    expect(relayed.map((x) => x.pool)).toEqual([OLD, NEW]);
    expect(r.status).toBe("failed");
    expect(r.legs[0]!.error).toBe("refused: pool_spent");
    expect(store.list()).toEqual([]);
  });

  it("refused pool_spent without a state: unchanged (fails, no retry)", async () => {
    const q = await buy();
    outcomes.push(spent());
    const r = await executeSwap(q);
    expect(relayed).toHaveLength(1);
    expect(r.legs[0]).toEqual({ poolOutpoint: OLD.replace("_", "."), status: "failed", error: "refused: pool_spent" });
    expect(store.list()).toEqual([]);
  });

  it("the newest state names a validator that is not live: the leg fails \"the pool's validator changed\", nothing relayed again", async () => {
    const q = await buy();
    outcomes.push(spent(pool(NEW, 1_000_200n, 4_999_000n, "03" + "44".repeat(32))));
    const r = await executeSwap(q);
    expect(relayed).toHaveLength(1);
    expect(r.legs[0]!.error).toBe("the pool's validator changed");
  });
});
