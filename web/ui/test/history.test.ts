/**
 * The history reads and the pools stream's `change` (skein-amm 0.39.0; agent-env
 * plans/history-api-2026-11-05.md D1–D7; open-exchange api/openapi.json H1–H6, Change): each
 * client reader's URL and its decode of a faked answer (amounts bigints, prices `{sats, tokens}`
 * pairs), and the token stream's reader applying each `change` kind to the held answer — with the
 * one re-read when it cannot.
 */
import { describe, expect, it } from "vitest";
import { createClient, type PoolsAnswer } from "../src/client";
import { applyPoolChange, parsePools, watchPools, type EventSourceLike } from "../src/lib/overlay";

const ORIGIN = "https://ex.example";
const T = `${"ab".repeat(32)}_0`;
const K = "03142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9";
const LP1 = "02" + "aa".repeat(32);
const LP2 = "03" + "bb".repeat(32);
const PEER = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Each LP key's pool id (0.40.0: the deploy outpoint), for the fixtures. */
const idOf = (lp: string) => `${lp.slice(2, 66)}_0`;
const pool = (lp: string, outpoint: string, bsv = 1_000_000, tokens = 5_000_000) => ({ poolId: idOf(lp), lpPubKey: lp, swaps: 0, outpoint, bsvReserve: bsv, tokenReserve: tokens, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: K, validatorPeerId: PEER });
const tradeRow = (lp: string, txid: string) => ({ txid, poolId: idOf(lp), lpPubKey: lp, payoutPkh: "ee".repeat(20), side: "buy", amountIn: 20000, amountOut: 97606, feeLp: 60, feeValidator: 10, feeCommission: 50, bsvReserve: 1019910, tokenReserve: 4902394, at: 1793000000000, height: null });
const statsRow = (tokenId: string) => ({ tokenId, price: { sats: 20000, tokens: 97606 }, buyPrice: { sats: 20100, tokens: 97606 }, sellPrice: { sats: 19900, tokens: 97606 }, lastTradePrice: { sats: 20000, tokens: 97000 }, change1h: 125, change24h: -310, volume24hSats: 41230, volume24hTokens: 200811, buys24h: 3, sells24h: 1, lastTradeAt: 1793000000000, tvlSats: 2019910, tvlTokens: 9902394, pools: 2 });

/** A client over a fetch that answers `answer(url)` and records each URL. */
function clientOver(answer: (u: URL) => Response) {
  const asked: string[] = [];
  const c = createClient({
    origin: ORIGIN,
    fetch: async (url: string) => {
      const u = new URL(url);
      asked.push(`${u.pathname}${u.search}`);
      return answer(u);
    },
  });
  return { c, asked };
}

describe("the history readers (H1–H6)", () => {
  it("trades: GET /@<token>/amm/trades with the given parameters (0.40.0: `pool` a pool id); rows decoded, amounts bigints, the pool id and payout key hash (0.40.0); next the cursor", async () => {
    const { c, asked } = clientOver(() => json({ trades: [tradeRow(LP1.toUpperCase(), "cd".repeat(32)), { junk: 1 }], next: "00ff" }));
    const page = await c.trades(T, { from: 1, to: 2, limit: 50, before: "0a", pool: idOf(LP1) });
    expect(asked).toEqual([`/@${T}/amm/trades?from=1&to=2&limit=50&before=0a&pool=${idOf(LP1)}`]);
    expect(page.next).toBe("00ff");
    expect(page.trades).toEqual([
      { txid: "cd".repeat(32), poolId: idOf(LP1).toLowerCase(), lpPubKey: LP1, payoutPkh: "ee".repeat(20), side: "buy", amountIn: 20000n, amountOut: 97606n, feeLp: 60n, feeValidator: 10n, feeCommission: 50n, bsvReserve: 1019910n, tokenReserve: 4902394n, at: 1793000000000, height: null },
    ]);
    await c.trades(T);
    expect(asked[1]).toBe(`/@${T}/amm/trades`);
  });

  it("trade: GET /@<token>/amm/trades?txid=; the row; 404 → null", async () => {
    const { c, asked } = clientOver((u) => (u.searchParams.get("txid") === "cd".repeat(32) ? json({ ...tradeRow(LP1, "cd".repeat(32)), height: 1766600 }) : json({ error: "none" }, 404)));
    expect((await c.trade(T, "cd".repeat(32)))?.height).toBe(1766600);
    expect(await c.trade(T, "ee".repeat(32))).toBeNull();
    expect(asked).toEqual([`/@${T}/amm/trades?txid=${"cd".repeat(32)}`, `/@${T}/amm/trades?txid=${"ee".repeat(32)}`]);
  });

  it("candles: GET /@<token>/amm/candles?tf=&from=&to=; prices pairs of bigints, volumes bigints", async () => {
    const { c, asked } = clientOver(() => json([{ t: 1792998000000, o: { sats: 2, tokens: 10 }, h: { sats: 3, tokens: 10 }, l: { sats: 2, tokens: 10 }, c: { sats: 5, tokens: 20 }, volumeSats: 41230, volumeTokens: 200811, n: 4 }]));
    const cs = await c.candles(T, { tf: "1h", from: 10, to: 20 });
    await c.candles(T, { tf: "1h", from: 10, to: 20, series: "market" });
    expect(asked).toEqual([`/@${T}/amm/candles?tf=1h&from=10&to=20`, `/@${T}/amm/candles?tf=1h&from=10&to=20&series=market`]);
    expect(cs).toEqual([{ t: 1792998000000, o: { sats: 2n, tokens: 10n }, h: { sats: 3n, tokens: 10n }, l: { sats: 2n, tokens: 10n }, c: { sats: 5n, tokens: 20n }, volumeSats: 41230n, volumeTokens: 200811n, n: 4 }]);
  });

  it("stats: GET /@<token>/amm/stats; statsAll: GET /amm/stats (ids comma-separated); a null price kept null", async () => {
    const { c, asked } = clientOver((u) => (u.pathname === "/amm/stats" ? json([statsRow(T), { ...statsRow(`${"cd".repeat(32)}_0`), price: null, change1h: null }]) : json(statsRow(T))));
    const one = await c.stats(T);
    expect(one).toEqual({ tokenId: T, price: { sats: 20000n, tokens: 97606n }, buyPrice: { sats: 20100n, tokens: 97606n }, sellPrice: { sats: 19900n, tokens: 97606n }, lastTradePrice: { sats: 20000n, tokens: 97000n }, change1h: 125, change24h: -310, volume24hSats: 41230n, volume24hTokens: 200811n, buys24h: 3, sells24h: 1, lastTradeAt: 1793000000000, tvlSats: 2019910n, tvlTokens: 9902394n, pools: 2 });
    const all = await c.statsAll();
    expect(all[1]).toMatchObject({ price: null, change1h: null });
    await c.statsAll({ ids: [T] });
    expect(asked).toEqual([`/@${T}/amm/stats`, "/amm/stats", `/amm/stats?ids=${T}`]);
  });

  it("holders: GET /@<token>/amm/color/<token>/holders?limit=&skip=; balances bigints", async () => {
    const { c, asked } = clientOver(() => json({ count: 2, rows: [{ address: "1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY", balance: 4900000 }, { address: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb", balance: 97606 }] }));
    const h = await c.holders(T, { limit: 2, skip: 0 });
    expect(asked).toEqual([`/@${T}/amm/color/${T}/holders?limit=2&skip=0`]);
    expect(h).toEqual({ count: 2, rows: [{ address: "1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY", balance: 4900000n }, { address: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb", balance: 97606n }] });
  });

  it("positionsAll (0.40.0): GET /amm/positions?pool=id1,id2; each row with its token, P4's shape", async () => {
    const { c, asked } = clientOver(() => json([{ tokenId: T, poolId: idOf(LP1), lpPubKey: LP1, status: "live", outpoint: `${"0d".repeat(32)}_0`, current: pool(LP1, `${"0d".repeat(32)}_0`), sats: 60, tokens: 150, swaps: 2 }, { tokenId: T, poolId: idOf(LP2), lpPubKey: LP2, status: "closed", sats: 0, tokens: 0, swaps: 0 }]));
    const ps = await c.positionsAll([idOf(LP1), idOf(LP2)]);
    expect(asked).toEqual([`/amm/positions?pool=${idOf(LP1)},${idOf(LP2)}`]);
    expect(ps[0]).toMatchObject({ tokenId: T, poolId: idOf(LP1), lpPubKey: LP1, status: "live", sats: 60n, tokens: 150n, swaps: 2 });
    expect(ps[0]!.current?.bsvReserve).toBe(1_000_000n);
    expect(ps[1]).toMatchObject({ status: "closed", outpoint: null, current: null });
    expect(await c.positionsAll([])).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("0.40.0: poolsAt GET /@<token>/amm/pools/at?t=; poolHistory GET /@<token>/amm/pools/history (forward paging: next → after); spendsAll GET /amm/spends?outpoint=a,b", async () => {
    const ev = { kind: "swap", txid: "cd".repeat(32), poolId: idOf(LP1), outpoint: `${"cd".repeat(32)}_0`, bsvReserve: 1019910, tokenReserve: 4902394, lpPubKey: LP1, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 10, validatorIdentityKey: K, at: 7, swaps: 1, side: "buy", amountIn: 20000, amountOut: 97606, feeLp: 60, feeValidator: 10, feeCommission: 20, commissionPkh: "55".repeat(20), payoutPkh: "ee".repeat(20) };
    const { c, asked } = clientOver((u) =>
      u.pathname.endsWith("/pools/at")
        ? json([{ ...pool(LP1, `${"0d".repeat(32)}_0`), at: 5, swaps: 4 }, { junk: 1 }])
        : u.pathname.endsWith("/pools/history")
          ? json({ events: [ev, { kind: "merge" }], next: u.searchParams.get("after") ? null : "ab".repeat(52) })
          : json([{ outpoint: "aa.1", tokenId: T, spentBy: "BB".repeat(32) }, { outpoint: "cc.0" }]),
    );
    const at = await c.poolsAt(T, 1234);
    expect(at).toEqual([{ ...(await import("../src/lib/overlay")).toPoolRow(pool(LP1, `${"0d".repeat(32)}_0`))!, swaps: 4, at: 5 }]);
    const p1 = await c.poolHistory(T, { from: 1, to: 9, pool: idOf(LP1), limit: 2 });
    expect(p1.next).toBe("ab".repeat(52));
    expect(p1.events).toEqual([
      { kind: "swap", txid: "cd".repeat(32), poolId: idOf(LP1), outpoint: `${"cd".repeat(32)}_0`, bsvReserve: 1019910n, tokenReserve: 4902394n, lpPubKey: LP1, liquidityFeeBps: 30n, validationFeeBps: 5n, commissionBps: 10n, validatorIdentityKey: K, at: 7, swaps: 1, side: "buy", amountIn: 20000n, amountOut: 97606n, feeLp: 60n, feeValidator: 10n, feeCommission: 20n, commissionPkh: "55".repeat(20), payoutPkh: "ee".repeat(20) },
    ]);
    const p2 = await c.poolHistory(T, { after: p1.next! });
    expect(p2.next).toBeNull();
    const sp = await c.spendsAll(["aa.1", "cc.0"]);
    expect(sp).toEqual([{ outpoint: "aa.1", tokenId: T, spentBy: "bb".repeat(32) }, { outpoint: "cc.0" }]);
    expect(asked).toEqual([`/@${T}/amm/pools/at?t=1234`, `/@${T}/amm/pools/history?from=1&to=9&pool=${idOf(LP1)}&limit=2`, `/@${T}/amm/pools/history?after=${"ab".repeat(52)}`, "/amm/spends?outpoint=aa.1,cc.0"]);
  });
});

describe("the token stream's `change` (D7)", () => {
  const held = (): PoolsAnswer => parsePools({ market: { commissionPkh: null, minCommissionBps: 0 }, validators: [{ identity: K, peerId: PEER }], pools: [pool(LP1, `${"11".repeat(32)}_0`), pool(LP2, `${"22".repeat(32)}_0`)] });

  it("swap (0.40.0: by pool id): the row of `poolId` replaced by `pool` (its outpoint moved), in place; the market and validators kept", () => {
    const h = held();
    const next = applyPoolChange(h, { kind: "swap", poolId: idOf(LP1), outpoint: `${"33".repeat(32)}_0`, pool: pool(LP1, `${"33".repeat(32)}_0`, 1_019_910, 4_902_394), trade: tradeRow(LP1, "33".repeat(32)) })!;
    expect(next.pools.map((p) => [p.lpPubKey, p.outpoint, p.bsvReserve])).toEqual([
      [LP1, `${"33".repeat(32)}_0`, 1_019_910n],
      [LP2, `${"22".repeat(32)}_0`, 1_000_000n],
    ]);
    expect(next.market).toBe(h.market);
    expect(next.validators).toBe(h.validators);
    expect(h.pools[0]!.outpoint).toBe(`${"11".repeat(32)}_0`);
  });

  it("deploy: `pool` added; close and rescind: the row of `poolId` removed", () => {
    const LP3 = "02" + "cc".repeat(32);
    expect(applyPoolChange(held(), { kind: "deploy", poolId: idOf(LP3), outpoint: `${"44".repeat(32)}_0`, pool: pool(LP3, `${"44".repeat(32)}_0`) })!.pools.map((p) => p.lpPubKey)).toEqual([LP1, LP2, LP3]);
    expect(applyPoolChange(held(), { kind: "close", poolId: idOf(LP1), outpoint: `${"11".repeat(32)}_0` })!.pools.map((p) => p.lpPubKey)).toEqual([LP2]);
    expect(applyPoolChange(held(), { kind: "rescind", poolId: idOf(LP2), outpoint: `${"22".repeat(32)}_0` })!.pools.map((p) => p.lpPubKey)).toEqual([LP1]);
  });

  it("one it cannot apply → null: an unknown kind, no pool id, a swap of a pool not held, a close of a pool not held, a deploy without its pool", () => {
    expect(applyPoolChange(held(), { kind: "merge", poolId: idOf(LP1), outpoint: "x_0" })).toBeNull();
    expect(applyPoolChange(held(), { kind: "close", outpoint: `${"11".repeat(32)}_0` })).toBeNull();
    expect(applyPoolChange(held(), { kind: "swap", poolId: idOf("02" + "dd".repeat(32)), outpoint: `${"55".repeat(32)}_0`, pool: pool("02" + "dd".repeat(32), `${"55".repeat(32)}_0`), trade: tradeRow("02" + "dd".repeat(32), "55".repeat(32)) })).toBeNull();
    expect(applyPoolChange(held(), { kind: "close", poolId: idOf("02" + "66".repeat(32)), outpoint: `${"66".repeat(32)}_0` })).toBeNull();
    expect(applyPoolChange(held(), { kind: "deploy", poolId: idOf("02" + "77".repeat(32)), outpoint: `${"77".repeat(32)}_0` })).toBeNull();
  });

  it("the reader: `pools` replaces the held answer, each `change` applied and handed on; one it cannot apply (or one before any answer) → ONE plain GET of the route, its answer held", async () => {
    let es: FakeES | null = null;
    class FakeES implements EventSourceLike {
      fns = new Map<string, (e: { data?: unknown }) => void>();
      onerror: ((e: unknown) => void) | null = null;
      onopen: ((e: unknown) => void) | null = null;
      constructor(readonly url: string) {
        es = this;
      }
      addEventListener(t: string, fn: (e: { data?: unknown }) => void) {
        this.fns.set(t, fn);
      }
      close() {}
      fire(t: string, x: unknown) {
        this.fns.get(t)!({ data: JSON.stringify(x) });
      }
    }
    const asked: string[] = [];
    const got: PoolsAnswer[] = [];
    const URL_ = `${ORIGIN}/@${T}/amm/pools`;
    const reread = { market: {}, validators: [], pools: [pool(LP2, `${"99".repeat(32)}_0`)] };
    const off = watchPools(URL_, parsePools, (a) => got.push(a), {
      EventSource: FakeES,
      change: applyPoolChange,
      fetch: async (url: string) => {
        asked.push(url);
        return json(reread);
      },
    });
    const e = es as unknown as FakeES;
    // A change before any answer: re-read.
    e.fire("change", { kind: "close", poolId: idOf(LP1), outpoint: `${"11".repeat(32)}_0` });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([URL_]);
    expect(got.map((a) => a.pools.map((p) => p.outpoint))).toEqual([[`${"99".repeat(32)}_0`]]);
    // The whole answer replaces it.
    e.fire("pools", { market: {}, validators: [], pools: [pool(LP1, `${"11".repeat(32)}_0`), pool(LP2, `${"22".repeat(32)}_0`)] });
    e.fire("change", { kind: "swap", poolId: idOf(LP1), outpoint: `${"33".repeat(32)}_0`, pool: pool(LP1, `${"33".repeat(32)}_0`), trade: tradeRow(LP1, "33".repeat(32)) });
    e.fire("change", { kind: "close", poolId: idOf(LP2), outpoint: `${"22".repeat(32)}_0` });
    expect(got.slice(1).map((a) => a.pools.map((p) => p.outpoint))).toEqual([
      [`${"11".repeat(32)}_0`, `${"22".repeat(32)}_0`],
      [`${"33".repeat(32)}_0`, `${"22".repeat(32)}_0`],
      [`${"33".repeat(32)}_0`],
    ]);
    expect(asked).toHaveLength(1);
    // One it cannot apply: ONE re-read; a change while it is read is dropped.
    e.fire("change", { kind: "rescind", poolId: idOf("02" + "88".repeat(32)), outpoint: `${"88".repeat(32)}_0` });
    e.fire("change", { kind: "close", poolId: idOf(LP1), outpoint: `${"33".repeat(32)}_0` });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([URL_, URL_]);
    expect(got).toHaveLength(5);
    expect(got[4]!.pools.map((p) => p.outpoint)).toEqual([`${"99".repeat(32)}_0`]);
    off();
  });
});
