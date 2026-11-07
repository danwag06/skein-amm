/**
 * createClient's swap (0.40.0, agent-env plans/swap-balance-build-2026-11-05.md Builder 2 item 4):
 * what is staged (what `amm-swap` lacks of the swap amount and the fee sats), the loop one leg at a
 * time (`nextLeg` over the server's pools list read before each leg (0.41.0); the pool's current output read by its id; refused
 * `pool_spent` → the list read again, otherwise → excluded; no answer → the overlay, once more, a race),
 * the stop reasons, the leftovers moved back, the progress order, one swap at a time. The leg's
 * build, the relay, the overlay pass and the swap basket are faked here (their own tests are
 * swap.test.ts and activeSwap.test.ts; the real wallet's are the harness proofs).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Beef } from "@bsv/sdk";
import { computeSwap, type PoolState } from "@dcasegr/amm-engine";
import type { PreparedSwap, SatsInput, TokenInput } from "../src/market/swapAction";
import type { SwapOutcome } from "../src/market/swapFlow";
import type { ResolvedLeg, StuckRow } from "../src/wallet/swapPayouts";
import { PEER } from "./liveRead";

const ORIGIN = "http://alice.localhost:8300";
const TOKEN = `${"ab".repeat(32)}_0`;
const SKEIN = "02" + "33".repeat(32);
const ID_A = `${"a1".repeat(32)}_0`;
const ID_B = `${"b2".repeat(32)}_0`;

/** The pools as they are now, by pool id (what `/pools/beef?pool=` answers). */
let current: Map<string, PoolState>;
const outcomes: SwapOutcome[] = [];
const relayed: { pool: string; order?: string; last: boolean }[] = [];
const prepared: { satsPerKb: number; order?: string; last: boolean; pool: string; amountIn: bigint }[] = [];
const staged: unknown[] = [];
const movedBack: string[] = [];
let resolved: ResolvedLeg[][] = [];
let resolvedStuck: StuckRow[][] = [];
let resolveCalls = 0;
let spentRead: (ops: string[]) => { outpoint: string; spentBy?: string; tokenId?: string }[];
let haveSats = 0;
let haveTokens = 0n;
let covers = true;
let satsRows = 0;
/** Called after each relay with the leg's pool outpoint (a test moves the pools here). */
let afterRelay: ((pool: string) => void) | null = null;
/** Every pool id `/pools/beef?pool=` was asked for. */
const beefReads: string[] = [];
/** 0.41.0: the pool ids the server's pools route lists (the quote's held ones), and how often it was read. */
let listedIds: string[] = [];
let poolsReads = 0;

const satsRow: SatsInput = { outpoint: `${"77".repeat(32)}.0`, txid: "77".repeat(32), vout: 0, satoshis: 1_000_000, lockingScript: "", protocolID: [2, "amm swap"], keyID: "k", counterparty: "self" };

vi.mock("../src/market/swapFlow", async (orig) => ({
  ...(await orig<typeof import("../src/market/swapFlow")>()),
  relaySwap: vi.fn(async (_c: unknown, p: PreparedSwap) => {
    relayed.push({ pool: p.pool, ...(p.order !== "own" ? { order: p.order } : {}), last: p.last });
    const o = outcomes.shift() ?? { status: "failed", reason: "no outcome scripted" };
    afterRelay?.(p.pool);
    return o;
  }),
}));
vi.mock("../src/market/swapAction", async (orig) => {
  const real = await orig<typeof import("../src/market/swapAction")>();
  return {
    ...real,
    selectLegInputs: vi.fn(() => (covers ? { sats: [satsRow], tokens: [], need: { need: 1 } } : null)),
    prepareSwap: vi.fn(async (i: { leg: { outpoint: string; amountIn: bigint }; pool: PoolState; satsPerKb: number; order?: string; last: boolean }) => {
      prepared.push({ satsPerKb: i.satsPerKb, ...(i.order ? { order: i.order } : {}), last: i.last, pool: i.leg.outpoint, amountIn: i.leg.amountIn });
      return { pool: i.leg.outpoint, validator: i.pool.validatorIdentityKey, order: i.order ?? "own", last: i.last, satsInputs: [satsRow], tokenInputs: [], swap: { toBinary: () => [prepared.length] } } as unknown as PreparedSwap;
    }),
  };
});
vi.mock("../src/market/activeSwap", async (orig) => ({
  ...(await orig<typeof import("../src/market/activeSwap")>()),
  stage: vi.fn(async (_w: unknown, req: unknown) => (staged.push(req), {})),
  swapSatsTotal: vi.fn(async () => haveSats),
  swapHoldings: vi.fn(async () => (haveTokens > 0n ? ([{ amount: haveTokens }] as unknown as TokenInput[]) : [])),
  swapSatsHoldings: vi.fn(async () => Array.from({ length: satsRows }, () => satsRow)),
  swapHoldingBeef: vi.fn(async () => new Beef()),
  moveBack: vi.fn(async (i: { tokenId: string }) => (movedBack.push(i.tokenId), { txid: "9b".repeat(32), amount: 0n, beef: [], submitted: "", errors: [] })),
}));
vi.mock("../src/wallet/swapPayouts", async (orig) => ({
  ...(await orig<typeof import("../src/wallet/swapPayouts")>()),
  resolveFromOverlay: vi.fn(async () => ({ taken: (resolveCalls++, resolved.shift() ?? []), stuck: resolvedStuck.shift() ?? [] })),
}));
vi.mock("../src/lib/overlay", async (orig) => {
  const real = await orig<typeof import("../src/lib/overlay")>();
  const row = (id: string, p: PoolState) => ({ ...p, poolId: id, lpPubKey: "", swaps: 0 });
  return {
    ...real,
    readPoolsBeef: vi.fn(async (_b: string, ids?: string[]) => (beefReads.push(...(ids ?? [])), { pools: (ids ?? []).flatMap((id) => (current.has(id) ? [row(id, current.get(id)!)] : [])), beef: [] })),
    // 0.40.2: the host serves a pool output only when it lists the pool there.
    poolOutputOf: vi.fn((pb: { pools: { outpoint: string }[] }, outpoint: string) => (pb.pools.some((x) => x.outpoint === outpoint) ? { beef: [], outputIndex: 0 } : null)),
    readSpendsAll: vi.fn(async (_b: string, ops: string[]) => spentRead(ops)),
    // 0.41.0: the server's pools route, read before each leg: the listed pools as they are now.
    readPools: vi.fn(async () => (poolsReads++, {
      market: { commissionPkh: null, minCommissionBps: 0 },
      validators: [{ identity: SKEIN, peerId: PEER }],
      pools: listedIds.flatMap((id) => (current.has(id) ? [{ ...current.get(id)!, poolId: id, lpPubKey: "", swaps: 0, validatorPeerId: PEER }] : [])),
    })),
  };
});

const { createClient } = await import("../src/index");

const pool = (outpoint: string, bsv: bigint, tokens: bigint): PoolState => ({ outpoint, bsvReserve: bsv, tokenReserve: tokens, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: SKEIN });
const A0 = `${"c1".repeat(32)}_0`;
const B0 = `${"c2".repeat(32)}_0`;
const A1 = `${"d1".repeat(32)}_0`;
/** The Swap page's held answer: pools A (and B), the validator beating. */
const held = (withB = false) => ({
  market: { commissionPkh: null, minCommissionBps: 0 },
  validators: [{ identity: SKEIN, peerId: PEER }],
  pools: [
    { ...pool(A0, 1_000_000n, 5_000_000n), poolId: ID_A, lpPubKey: "", swaps: 0, validatorPeerId: PEER },
    ...(withB ? [{ ...pool(B0, 1_000_000n, 5_000_000n), poolId: ID_B, lpPubKey: "", swaps: 0, validatorPeerId: PEER }] : []),
  ],
});
const af = { fetch: async () => new Response("{}", { status: 404 }) };
// 0.41.0: no stream; the server's pools route (`readPools`, faked above) is read before each leg.
const client = (feeRateSatsPerKb?: number) => createClient({ origin: `${ORIGIN}/amm`, ...(feeRateSatsPerKb !== undefined ? { feeRateSatsPerKb } : {}), wallet: {} as never, signedFor: () => af as never, identityKey: SKEIN, fetch: async () => new Response("{}", { status: 404 }) });
const buy = (c: ReturnType<typeof client>, amountIn = 20_000n, withB = false) => ((listedIds = withB ? [ID_A, ID_B] : [ID_A]), c.quoteSwap({ tokenId: TOKEN, side: "buy", amountIn, maxSlippageBps: 100, maxSources: 5 }, held(withB), { sym: "TST", dec: 0 }));
const accepted = (txid = "ee".repeat(32)): SwapOutcome => ({ status: "accepted", id: "r", txid, completed: { txid, internalized: true, errors: [] } });

beforeEach(() => {
  current = new Map([
    [ID_A, pool(A0, 1_000_000n, 5_000_000n)],
    [ID_B, pool(B0, 1_000_000n, 5_000_000n)],
  ]);
  outcomes.length = 0;
  relayed.length = 0;
  prepared.length = 0;
  staged.length = 0;
  movedBack.length = 0;
  resolved = [];
  resolvedStuck = [];
  resolveCalls = 0;
  spentRead = (ops) => ops.map((outpoint) => ({ outpoint }));
  haveSats = 0;
  haveTokens = 0n;
  covers = true;
  satsRows = 0;
  afterRelay = null;
  beefReads.length = 0;
  listedIds = [];
  poolsReads = 0;
});

describe("the quote (0.40.0)", () => {
  it("what Swap stages: the swap amount exact and the fee sats for maxSources legs; the per-leg miner fee estimate; each leg its own pool's fees; price and impact from priceOf", () => {
    const c = client(250);
    const q = buy(c);
    expect(q.stage.amount).toBe(20_000n);
    expect(q.legMinerFeeSats).toBe(BigInt(Math.ceil(13 * 250)));
    // 0.40.2: exactly maxSources (5) legs' fee sats (a buy: one carrier each, the token payout).
    expect(q.stage.feeSats).toBe(5n * (q.legMinerFeeSats + 1n));
    expect(q.legs[0]).toMatchObject({ poolId: ID_A, fees: { lpBps: 30, validatorBps: 5, commissionBps: 10 } });
    expect(q.marginalPrice).toBeGreaterThan(0);
    expect(q.effectivePrice).toBeGreaterThan(q.marginalPrice);
  });

  it("a validator's minimum leg: a pool under it plans no leg; an order no pool takes is refused below_minimum, naming the smallest amount", () => {
    const c = client();
    const h = { ...held(), validators: [{ identity: SKEIN, peerId: PEER, minLegSats: 50_000n }] };
    expect(() => c.quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, maxSources: 5 }, h, { sym: "TST", dec: 0 })).toThrow(expect.objectContaining({ kind: "below_minimum", message: expect.stringMatching(/^No pool here takes a swap this small: at least \d+ sats\.$/) }));
    expect(c.quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 60_000n, maxSlippageBps: 100, maxSources: 5 }, h, { sym: "TST", dec: 0 }).legs).toHaveLength(1);
  });
});

describe("executeSwap (0.40.0): one swap at a time, legs one at a time", () => {
  it("the basket empty: ONE stage of the swap amount + the fee sats (a buy: sats only); then one leg taking all → last, filled; progress staging, relaying, done; the fee rate reaches the leg", async () => {
    const c = client(250);
    const q = buy(c);
    outcomes.push(accepted());
    const seen: string[] = [];
    const r = await c.executeSwap(q, { onProgress: (p) => seen.push("leg" in p ? `${p.phase} ${p.leg} ${p.amountIn}` : p.phase) });
    expect(staged).toEqual([{ sats: Number(q.stage.amount + q.stage.feeSats) }]);
    expect(prepared).toEqual([{ satsPerKb: 250, last: true, pool: A0, amountIn: 20_000n }]);
    expect(seen).toEqual(["staging", `relaying ${A0.replace("_", ".")} 20000`, "done"]);
    expect(r).toMatchObject({ status: "filled", stop: "filled", totalIn: 20_000n, unfilled: 0n, legs: [{ poolOutpoint: A0.replace("_", "."), poolId: ID_A, amountIn: 20_000n, txid: "ee".repeat(32) }] });
    expect(r.totalOut).toBe(q.amountOut);
    // Filled: nothing moved back; the overlay pass ran before the swap.
    expect(movedBack).toEqual([]);
    expect(resolveCalls).toBe(1);
  });

  it("what the basket already holds is used first: only the lack is staged; a sell stages its tokens with the sats; all held: no stage", async () => {
    const c = client();
    let q = buy(c);
    haveSats = Number(q.stage.amount + q.stage.feeSats) - 1_000;
    outcomes.push(accepted());
    await c.executeSwap(q);
    expect(staged).toEqual([{ sats: 1_000 }]);
    staged.length = 0;
    haveSats = Number(q.stage.amount + q.stage.feeSats);
    outcomes.push(accepted());
    await c.executeSwap(q);
    expect(staged).toEqual([]);
    haveSats = 0;
    haveTokens = 10_000n;
    q = c.quoteSwap({ tokenId: TOKEN, side: "sell", amountIn: 50_000n, maxSlippageBps: 100, maxSources: 5 }, held(), { sym: "TST", dec: 0 });
    outcomes.push(accepted());
    await c.executeSwap(q);
    expect(staged).toEqual([{ sats: Number(q.stage.feeSats), tokens: { tokenId: TOKEN, amount: 40_000n } }]);
  });

  it("two pools: the largest leg first, then the rest — the second leg under the first leg's order, the last one marked last", async () => {
    const c = client();
    const q = buy(c, 400_000n, true);
    expect(q.legs.length).toBe(2);
    outcomes.push(accepted("e1".repeat(32)), accepted("e2".repeat(32)));
    // After the first leg, its pool is gone from the read (closed by its LP, say): the rest goes to the other pool, all of it.
    afterRelay = (spent) => current.delete(spent === A0 ? ID_A : ID_B);
    const r = await c.executeSwap(q);
    expect(r.status).toBe("filled");
    expect(r.legs.map((l) => l.txid)).toEqual(["e1".repeat(32), "e2".repeat(32)]);
    expect(prepared.map((p) => [p.last, p.order])).toEqual([
      [false, undefined],
      [true, "own"],
    ]);
    expect(r.legs.reduce((a, l) => a + l.amountIn, 0n)).toBe(400_000n);
  });

  it("refused pool_spent with the pool's state: its row replaced (repricing), the overlay pass, the leg rebuilt on the new outpoint", async () => {
    const c = client();
    const q = buy(c);
    const newer = pool(A1, 1_000_200n, 4_999_000n);
    current.set(ID_A, newer);
    outcomes.push({ status: "refused", id: "r1", reason: "pool_spent", pool: newer }, accepted());
    const seen: string[] = [];
    // 0.43.0: the refusal moved the pool on the server (A2): the next read lists it there.
    const A2 = `${"d2".repeat(32)}_0`;
    afterRelay = () => current.set(ID_A, pool(A2, 1_000_300n, 4_998_000n));
    // The quote was on A0; A's current output is A1: the read replaces the row before any relay.
    const r = await c.executeSwap(q, { onProgress: (p) => seen.push(p.phase) });
    expect(relayed.map((x) => x.pool)).toEqual([A1, A2]);
    expect(seen).toEqual(["staging", "relaying", "repricing", "relaying", "done"]);
    expect(r.status).toBe("filled");
    expect(resolveCalls).toBe(2);
  });

  it("refused otherwise (below_minimum): that outpoint excluded, the next pool takes the leg; no pool left: stop no_pool, the rows moved back in ONE action", async () => {
    const c = client();
    const q = buy(c, 20_000n, true);
    outcomes.push({ status: "refused", id: "r1", reason: "below_minimum: the leg's 20000 sats are under this validator's minimum leg of 50000 sats" }, accepted());
    const r = await c.executeSwap(q);
    expect(relayed.map((x) => x.pool).sort()).toEqual([A0, B0].sort());
    expect(r.status).toBe("filled");
    outcomes.push({ status: "refused", id: "r2", reason: "below_minimum" }, { status: "refused", id: "r3", reason: "below_minimum" });
    satsRows = 1;
    const seen: string[] = [];
    const r2 = await c.executeSwap(q, { onProgress: (p) => seen.push(p.phase) });
    expect(r2).toMatchObject({ status: "failed", stop: "no_pool", legs: [], unfilled: 20_000n, returned: { txid: "9b".repeat(32), tokens: 0n } });
    expect(seen.slice(-2)).toEqual(["returning", "failed"]);
    expect(movedBack).toEqual([TOKEN]);
  });

  it("no answer: (a) a staged input spent on the overlay → the leg landed, taken in by the pass and counted; (b) nothing spent → sent ONCE more; (c) still none → raced on another pool with the same rows", async () => {
    const c = client();
    const q = buy(c, 20_000n, true);
    // (a)
    spentRead = (ops) => ops.map((outpoint) => (outpoint === satsRow.outpoint ? { outpoint, tokenId: TOKEN, spentBy: "f1".repeat(32) } : { outpoint }));
    resolved = [[], [{ txid: "f1".repeat(32), tokenId: TOKEN, inputs: [A0.replace("_", "."), satsRow.outpoint], payout: { satoshis: 1 } }]];
    outcomes.push({ status: "unknown", id: "u", reason: "no answer yet" });
    const a = await c.executeSwap(q);
    expect(a).toMatchObject({ status: "filled", legs: [{ txid: "f1".repeat(32), amountIn: 20_000n }] });
    expect(relayed).toHaveLength(1);
    // (b)
    relayed.length = 0;
    spentRead = (ops) => ops.map((outpoint) => ({ outpoint }));
    outcomes.push({ status: "unknown", id: "u", reason: "no answer yet" }, accepted("f2".repeat(32)));
    const b = await c.executeSwap(q);
    expect(relayed.map((x) => x.pool)).toEqual([relayed[0]!.pool, relayed[0]!.pool]);
    expect(b.legs.map((l) => l.txid)).toEqual(["f2".repeat(32)]);
    // (c)
    relayed.length = 0;
    outcomes.push({ status: "unknown", id: "u", reason: "no answer yet" }, { status: "unknown", id: "u", reason: "no answer yet: the host could not reach the validator" }, accepted("f3".repeat(32)));
    const r = await c.executeSwap(q);
    expect(relayed).toHaveLength(3);
    expect(relayed[2]!.pool).not.toBe(relayed[0]!.pool);
    expect(r.legs.map((l) => l.txid)).toEqual(["f3".repeat(32)]);
  });

  it("0.44.2: a staged row the pass could not take in is reported — a `stuck` progress and the result's `stuck` — and the swap goes on", async () => {
    const c = client();
    const q = buy(c);
    const row: StuckRow = { outpoint: satsRow.outpoint, spentBy: "f1".repeat(32), error: "BRC-207: transaction input 0 lacks its source or unlocking script" };
    resolvedStuck = [[row]];
    outcomes.push(accepted("f4".repeat(32)));
    const seen: unknown[] = [];
    const r = await c.executeSwap(q, { onProgress: (x) => seen.push(x) });
    expect(r.stuck).toEqual([row]);
    expect(seen).toContainEqual({ phase: "stuck", rows: [row] });
    expect(r.legs.map((l) => l.txid)).toEqual(["f4".repeat(32)]);
    // None stuck: no field.
    outcomes.push(accepted("f5".repeat(32)));
    expect((await c.executeSwap(q)).stuck).toBeUndefined();
  });

  it("the staged rows cannot cover the leg: stop fees; cancelled: stop cancelled before the next leg; both move the rows back", async () => {
    const c = client();
    const q = buy(c);
    covers = false;
    satsRows = 1;
    const r = await c.executeSwap(q);
    expect(r).toMatchObject({ status: "failed", stop: "fees", returned: { txid: "9b".repeat(32) } });
    covers = true;
    const ctl = new AbortController();
    ctl.abort();
    expect(await c.executeSwap(q, { signal: ctl.signal })).toMatchObject({ status: "failed", stop: "cancelled" });
    expect(relayed).toEqual([]);
    expect(movedBack).toEqual([TOKEN, TOKEN]);
  });

  it("the pools now pay under the floor: stop floor (nothing sent); one swap at a time", async () => {
    const c = client();
    const q = buy(c);
    current.set(ID_A, pool(A1, 3_000_000n, 1_000_000n));
    const r = await c.executeSwap(q);
    expect(r).toMatchObject({ status: "failed", stop: "floor" });
    expect(relayed).toEqual([]);
    outcomes.push(accepted());
    current.set(ID_A, pool(A0, 1_000_000n, 5_000_000n));
    const one = c.executeSwap(q);
    await expect(c.executeSwap(q)).rejects.toThrow(/one at a time/);
    await one;
    expect(computeSwap(pool(A0, 1_000_000n, 5_000_000n), "bsvToToken", 20_000n)!.amountOut).toBe(q.amountOut);
  });
});

const C0 = `${"c3".repeat(32)}_0`;
const ID_C = `${"c3".repeat(32)}c3_0`.slice(0, 64) + "_0";
/** The held answer with pools A, B and C. */
const held3 = () => ({
  ...held(true),
  pools: [...held(true).pools, { ...pool(C0, 1_000_000n, 5_000_000n), poolId: ID_C, lpPubKey: "", swaps: 0, validatorPeerId: PEER }],
});
const cap = (c: ReturnType<typeof client>, amountIn: bigint, maxSources: number, h: ReturnType<typeof held3> | ReturnType<typeof held> = held(true)) => {
  // 0.41.0: the server lists the quote's pools.
  listedIds = h.pools.map((p) => p.poolId);
  for (const p of h.pools) if (!current.has(p.poolId)) current.set(p.poolId, pool(p.outpoint, p.bsvReserve, p.tokenReserve));
  return c.quoteSwap({ tokenId: TOKEN, side: "buy", amountIn, maxSlippageBps: 100, maxSources }, h, { sym: "TST", dec: 0 });
};

describe("0.40.2: maxSources — the legs an order may fill", () => {
  it("the quote: the fee sats staged are for EXACTLY maxSources legs — 1: one pool, one leg's; 2: two planned, two legs'; 5: two planned and three more", () => {
    const c = client();
    const one = cap(c, 400_000n, 1);
    expect(one.legs).toHaveLength(1);
    expect(one.stage.feeSats).toBe(one.legMinerFeeSats + 1n);
    const two = cap(c, 400_000n, 2);
    expect(two.legs).toHaveLength(2);
    expect(two.stage.feeSats).toBe(2n * (two.legMinerFeeSats + 1n));
    const five = cap(c, 400_000n, 5);
    expect(five.legs).toHaveLength(2);
    expect(five.stage.feeSats).toBe(5n * (five.legMinerFeeSats + 1n));
  });

  it("maxSources 1: exactly one leg for the whole amount — a refusal (pool_spent repriced, or any other) re-plans ONE leg for the whole amount, never part", async () => {
    const c = client();
    const q = cap(c, 400_000n, 1);
    const newer = pool(A1, 1_000_200n, 4_999_000n);
    outcomes.push({ status: "refused", id: "r1", reason: "below_minimum" }, accepted());
    const r = await c.executeSwap(q);
    expect(r).toMatchObject({ status: "filled", legs: [{ amountIn: 400_000n }] });
    expect(prepared.map((p) => [p.amountIn, p.last])).toEqual([
      [400_000n, true],
      [400_000n, true],
    ]);
    expect(new Set(relayed.map((x) => x.pool)).size).toBe(2); // the refused pool excluded, the other takes it all
    prepared.length = 0;
    current.set(ID_A, newer);
    outcomes.push({ status: "refused", id: "r2", reason: "pool_spent", pool: newer }, accepted());
    const q2 = c.quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, maxSources: 1 }, held(), { sym: "TST", dec: 0 });
    current.set(ID_A, pool(A0, 1_000_000n, 5_000_000n));
    afterRelay = () => current.set(ID_A, newer);
    const r2 = await c.executeSwap(q2);
    expect(r2).toMatchObject({ status: "filled", legs: [{ amountIn: 20_000n }] });
    expect(prepared.map((p) => p.amountIn)).toEqual([20_000n, 20_000n]);
  });

  it("maxSources 2: the budget goes down only by FILLED legs — two filled legs and done; a refused leg does not count; the second single leg under the floor → stop floor, the rows returned", async () => {
    const c = client();
    const q = cap(c, 600_000n, 2, held3());
    outcomes.push({ status: "refused", id: "r1", reason: "below_minimum" }, accepted("a1".repeat(32)), accepted("a2".repeat(32)));
    const r = await c.executeSwap(q);
    expect(r.status).toBe("filled");
    expect(r.legs).toHaveLength(2);
    expect(prepared.at(-1)!.last).toBe(true);
    expect(r.legs[0]!.amountIn + r.legs[1]!.amountIn).toBe(600_000n);
    // After the first fill the other pools pay far less: the one leg left cannot meet the floor.
    prepared.length = 0;
    satsRows = 1;
    afterRelay = () => {
      for (const id of [ID_A, ID_B]) current.set(id, pool(current.get(id)!.outpoint.replace(/^c/, "e"), 3_000_000n, 1_000_000n));
    };
    outcomes.push(accepted("b1".repeat(32)));
    const q2 = cap(c, 400_000n, 2);
    const r2 = await c.executeSwap(q2);
    expect(r2).toMatchObject({ status: "partial", stop: "floor", returned: { txid: "9b".repeat(32) } });
    expect(r2.legs).toHaveLength(1);
    expect(movedBack).toEqual([TOKEN]);
  });
});

describe("0.41.0: the server's pool list, read fresh before each leg; no list of its own", () => {
  it("a leg refused pool_spent: the relaying host took the validator's state in before it answered — the list read again lists the pool there, and the next leg plans on it; no stream opened", async () => {
    const opened: string[] = [];
    vi.stubGlobal("EventSource", class {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener() {}
      close() {}
    });
    try {
      const c = client();
      const q = buy(c); // one pool, A
      const newer = pool(A1, 1_000_200n, 4_999_000n);
      afterRelay = () => current.set(ID_A, newer); // the relaying host now lists A at the validator's newer state
      outcomes.push({ status: "refused", id: "r1", reason: "pool_spent", pool: newer }, accepted());
      const r = await c.executeSwap(q);
      expect(r.status).toBe("filled");
      expect(relayed.map((x) => x.pool)).toEqual([A0, A1]);
      // One read of the list per leg planned (the refused one and the filled one), and one more to see it filled.
      expect(poolsReads).toBe(3);
      expect(opened).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the list is the server's at each leg: a pool the server stops listing is not planned on; the refusal's state is not used", async () => {
    const c = client();
    const q = buy(c, 20_000n, true);
    const first = q.legs[0]!.poolOutpoint.replace(".", "_");
    const id = first === A0 ? ID_A : ID_B;
    // Refused pool_spent with a state the server never lists: the pool is gone from the server's list after the answer.
    afterRelay = () => {
      listedIds = listedIds.filter((x) => x !== id);
    };
    outcomes.push({ status: "refused", id: "r1", reason: "pool_spent", pool: pool(A1, 9n, 9n) }, accepted());
    const r = await c.executeSwap(q);
    expect(r.status).toBe("filled");
    expect(relayed).toHaveLength(2);
    expect(relayed[1]!.pool).not.toBe(first);
    expect(relayed.map((x) => x.pool)).not.toContain(A1);
  });
});

describe("0.43.0 (D4): a pool_spent refusal the server's list does not reflect", () => {
  it("the fresh list still shows the pool at the outpoint the leg spent: that pool excluded for the rest of the swap — the next pool takes the leg; none left: stop no_pool, the rows moved back; no timer, no retry count", async () => {
    const c = client();
    const q = buy(c, 20_000n, true);
    const first = q.legs[0]!.poolOutpoint.replace(".", "_");
    // Refused pool_spent, and the server still lists the pool where it was (nothing moved).
    outcomes.push({ status: "refused", id: "r1", reason: "pool_spent", pool: pool(A1, 9n, 9n) }, accepted());
    const r = await c.executeSwap(q);
    expect(r.status).toBe("filled");
    expect(relayed).toHaveLength(2);
    expect(relayed[0]!.pool).toBe(first);
    expect(relayed[1]!.pool).not.toBe(first);
    // One pool only: refused pool_spent, unchanged → excluded, nothing left → no_pool, moved back.
    relayed.length = 0;
    satsRows = 1;
    const q1 = buy(c, 20_000n);
    outcomes.push({ status: "refused", id: "r2", reason: "pool_spent", pool: pool(A1, 9n, 9n) });
    const r1 = await c.executeSwap(q1);
    expect(relayed.map((x) => x.pool)).toEqual([A0]);
    expect(r1).toMatchObject({ status: "failed", stop: "no_pool", legs: [] });
    expect(movedBack).toEqual([TOKEN]);
  });

  it("the list changed (the pool at a new outpoint): repriced and asked again, as before", async () => {
    const c = client();
    const q = buy(c);
    const newer = pool(A1, 1_000_200n, 4_999_000n);
    afterRelay = () => current.set(ID_A, newer);
    outcomes.push({ status: "refused", id: "r1", reason: "pool_spent", pool: newer }, accepted());
    const r = await c.executeSwap(q);
    expect(r.status).toBe("filled");
    expect(relayed.map((x) => x.pool)).toEqual([A0, A1]);
  });
});
