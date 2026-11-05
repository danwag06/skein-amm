/**
 * createClient's swap (0.38.0, D9, D12, D13): the fee rate the client was given reaches every
 * leg's `satsPerKb`; `onProgress` reports staging → relaying → (repricing) → done / failed in that
 * order; a quote gone since the read throws `ClientError` pool_spent. The leg's build and the relay
 * are faked as in swapRetry.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Beef } from "@bsv/sdk";
import type { PoolState } from "@dcasegr/amm-engine";
import type { PlannedLeg, PreparedSwap, SatsInput } from "../src/market/swapAction";
import type { SwapOutcome } from "../src/market/swapFlow";
import { PEER } from "./liveRead";

const outcomes: SwapOutcome[] = [];
const rates: number[] = [];
let poolsRead: () => { pools: unknown[]; beef: number[] };

vi.mock("../src/market/swapFlow", async (orig) => ({
  ...(await orig<typeof import("../src/market/swapFlow")>()),
  relaySwap: vi.fn(async () => outcomes.shift() ?? { status: "failed", reason: "no outcome scripted" }),
}));
vi.mock("../src/market/swapAction", async (orig) => {
  const real = await orig<typeof import("../src/market/swapAction")>();
  return {
    ...real,
    planSwapLeg: vi.fn(async (i: { leg: { outpoint: string }; pool: PoolState; satsPerKb: number }) => {
      rates.push(i.satsPerKb);
      return { pool: i.leg.outpoint, validator: i.pool.validatorIdentityKey, bsvIn: true, funding: { satoshis: 25_000 } } as unknown as PlannedLeg;
    }),
    prepareSwap: vi.fn(async (i: { leg: { outpoint: string }; pool: PoolState; satsPerKb: number }) => {
      rates.push(i.satsPerKb);
      return { pool: i.leg.outpoint, validator: i.pool.validatorIdentityKey, swap: { id: () => "ab".repeat(32), toBinary: () => [1] }, payout: { kind: "brc29", outputIndex: 1 }, commission: { amount: 0n, pkh: "", to: "none" } } as unknown as PreparedSwap;
    }),
  };
});
vi.mock("../src/market/activeSwap", async (orig) => ({
  ...(await orig<typeof import("../src/market/activeSwap")>()),
  swapSatsHoldings: vi.fn(async () => [{ outpoint: `${"77".repeat(32)}.0`, txid: "77".repeat(32), vout: 0, satoshis: 25_000 } as unknown as SatsInput]),
  swapHoldingBeef: vi.fn(async () => new Beef()),
}));
vi.mock("../src/lib/overlay", async (orig) => {
  const real = await orig<typeof import("../src/lib/overlay")>();
  return { ...real, readPoolsBeef: vi.fn(async () => poolsRead()), poolOutputOf: vi.fn(() => ({ beef: [], outputIndex: 0 })) };
});

const { createClient, ClientError } = await import("../src/index");

const ORIGIN = "http://alice.localhost:8300";
const TOKEN = `${"ab".repeat(32)}_0`;
const SKEIN = "02" + "33".repeat(32);
const OLD = `${"c1".repeat(32)}_0`;
const NEW = `${"d2".repeat(32)}_0`;
const LP = "03" + "55".repeat(32);
const pool = (outpoint: string, bsv: bigint, tokens: bigint): PoolState => ({ outpoint, bsvReserve: bsv, tokenReserve: tokens, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: SKEIN });
const held = () => ({ market: { commissionPkh: null, minCommissionBps: 0 }, validators: [{ identity: SKEIN, peerId: PEER }], pools: [{ ...pool(OLD, 1_000_000n, 5_000_000n), lpPubKey: LP, validatorPeerId: PEER }] });
const af = { fetch: async () => new Response("{}", { status: 404 }) };
const client = (feeRateSatsPerKb?: number) => createClient({ origin: `${ORIGIN}/amm`, ...(feeRateSatsPerKb !== undefined ? { feeRateSatsPerKb } : {}), wallet: {} as never, signedFor: () => af as never, identityKey: SKEIN });
const buy = (c: ReturnType<typeof client>) => c.quoteSwap({ tokenId: TOKEN, side: "buy", amountIn: 20_000n, maxSlippageBps: 100, allowPartial: false }, held(), { sym: "TST", dec: 0 });

beforeEach(() => {
  outcomes.length = 0;
  rates.length = 0;
  poolsRead = () => ({ pools: [{ ...pool(OLD, 1_000_000n, 5_000_000n), lpPubKey: LP }], beef: [] });
});

describe("createClient: the swap", () => {
  it("the fee rate given (250 sats/kB) reaches every leg's satsPerKb; none given: 100", async () => {
    const c = client(250);
    outcomes.push({ status: "accepted", id: "r", txid: "ee".repeat(32), completed: { internalized: false } as never });
    await c.executeSwap(buy(c));
    expect(rates).toEqual([250, 250]);
    rates.length = 0;
    const d = client();
    expect(d.feeRateSatsPerKb).toBe(100);
    outcomes.push({ status: "accepted", id: "r", txid: "ee".repeat(32), completed: { internalized: false } as never });
    await d.executeSwap(buy(d));
    expect(rates).toEqual([100, 100]);
  });

  it("onProgress: staging, relaying, done — and with a pool_spent retry: staging, relaying, repricing, done", async () => {
    const c = client();
    const seen: string[] = [];
    outcomes.push({ status: "accepted", id: "r", txid: "ee".repeat(32), completed: { internalized: false } as never });
    const r = await c.executeSwap(buy(c), { onProgress: (p) => seen.push("leg" in p ? `${p.phase} ${p.leg}` : p.phase) });
    const leg = OLD.replace("_", ".");
    expect(r.status).toBe("filled");
    expect(seen).toEqual(["staging", `relaying ${leg}`, "done"]);
    seen.length = 0;
    outcomes.push({ status: "refused", id: "r1", reason: "pool_spent", pool: pool(NEW, 1_000_200n, 4_999_000n) }, { status: "accepted", id: "r2", txid: "ee".repeat(32), completed: { internalized: false } as never });
    await c.executeSwap(buy(c), { onProgress: (p) => seen.push("leg" in p ? `${p.phase} ${p.leg}` : p.phase) });
    expect(seen).toEqual(["staging", `relaying ${leg}`, `repricing ${leg}`, "done"]);
  });

  it("no leg filled: failed with the result, the leg's kind beside its text (D13); a quote whose pool was spent since: failed with a ClientError pool_spent, thrown", async () => {
    const c = client();
    const seen: { phase: string; kind?: string }[] = [];
    outcomes.push({ status: "refused", id: "r1", reason: "fees_unacceptable" });
    const r = await c.executeSwap(buy(c), { onProgress: (p) => seen.push({ phase: p.phase, ...(p.phase === "failed" && p.result ? { kind: p.result.legs[0]!.kind } : {}) }) });
    expect(r.legs[0]).toMatchObject({ status: "failed", error: "refused: fees_unacceptable", kind: "refused" });
    expect(seen.at(-1)).toEqual({ phase: "failed", kind: "refused" });
    outcomes.push({ status: "unknown", id: "r3", reason: "no answer yet" });
    expect((await c.executeSwap(buy(c))).legs[0]).toMatchObject({ error: "no answer yet", kind: "no_answer", checkId: "r3" });

    poolsRead = () => ({ pools: [], beef: [] });
    const errs: unknown[] = [];
    const run = c.executeSwap(buy(c), { onProgress: (p) => p.phase === "failed" && errs.push(p.error) });
    await expect(run).rejects.toBeInstanceOf(ClientError);
    await expect(c.executeSwap(buy(c))).rejects.toMatchObject({ kind: "pool_spent", message: `${OLD.replace("_", ".")} was spent since the quote: quote again` });
    expect(errs).toHaveLength(1);
    expect((errs[0] as InstanceType<typeof ClientError>).kind).toBe("pool_spent");
  });
});
