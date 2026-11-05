/**
 * Discovery's token list (0.34.0, P13: `GET /@discovery/1color/tokens`, skein-1color 0.14.0's route,
 * was `/color/tokens`): the route takes `limit` 1..100 and `skip`, so the page reads it 100 at a
 * time until a short page; with `ids`, one row per id in query order.
 */
import { describe, expect, it } from "vitest";
import { readDiscoveryIds, readDiscoveryList } from "../src/lib/overlay";

const BASE = "https://swap.example/@discovery/1color";

function token(i: number) {
  return { tokenId: `${String(i).padStart(64, "0")}_0`, topic: `tm_color_${String(i).padStart(64, "0")}_0`, sym: `T${i}`, dec: 5, iconUrl: `${String(i).padStart(64, "0")}_0/icon` };
}

function instance(total: number) {
  const calls: URL[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    calls.push(u);
    const ids = u.searchParams.get("ids");
    if (ids !== null) {
      const all = Array.from({ length: total }, (_, i) => token(i));
      return new Response(JSON.stringify(ids.split(",").map((id) => all.find((t) => t.tokenId === id) ?? { tokenId: id, listed: false })), { headers: { "content-type": "application/json" } });
    }
    const limit = Number(u.searchParams.get("limit"));
    const skip = Number(u.searchParams.get("skip") ?? 0);
    if (!(limit >= 1 && limit <= 100)) return new Response(JSON.stringify({ status: "error", message: "the query is {limit?: 1..100, skip?: 0..100000}" }), { headers: { "content-type": "application/json" } });
    const rows = Array.from({ length: total }, (_, i) => token(i)).slice(skip, skip + limit);
    return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("readDiscoveryList", () => {
  it("reads one short page with a limit the route accepts; iconUrl made absolute against the list", async () => {
    const inst = instance(2);
    const list = await readDiscoveryList(BASE, inst.fetchFn);
    expect(list.map((t) => t.sym)).toEqual(["T0", "T1"]);
    expect(list[0]).toMatchObject({ dec: 5, topic: token(0).topic, listed: true, iconUrl: `${BASE}/${token(0).tokenId}/icon` });
    expect(inst.calls.map((u) => u.pathname + u.search)).toEqual(["/@discovery/1color/tokens?limit=100&skip=0"]);
  });

  it("pages past 100 tokens until a short page", async () => {
    const inst = instance(230);
    const list = await readDiscoveryList(BASE, inst.fetchFn);
    expect(list).toHaveLength(230);
    expect(list.at(-1)?.sym).toBe("T229");
    expect(inst.calls.map((u) => u.searchParams.get("skip"))).toEqual(["0", "100", "200"]);
  });

  it("stops on a full last page only after the next empty one", async () => {
    const inst = instance(200);
    const list = await readDiscoveryList(BASE, inst.fetchFn);
    expect(list).toHaveLength(200);
    expect(inst.calls).toHaveLength(3);
  });
});

describe("readDiscoveryIds", () => {
  it("ONE read for several ids: one row per id in query order, an id not on discovery {listed: false}; none asked, no read", async () => {
    const inst = instance(3);
    const missing = `${"ff".repeat(32)}_0`;
    const rows = await readDiscoveryIds(BASE, [token(2).tokenId, missing, token(0).tokenId], inst.fetchFn);
    expect(rows.map((r) => [r.tokenId, r.listed])).toEqual([
      [token(2).tokenId, true],
      [missing, false],
      [token(0).tokenId, true],
    ]);
    expect(inst.calls).toHaveLength(1);
    expect(inst.calls[0]!.pathname).toBe("/@discovery/1color/tokens");
    expect(await readDiscoveryIds(BASE, [], inst.fetchFn)).toEqual([]);
    expect(inst.calls).toHaveLength(1);
  });
});
