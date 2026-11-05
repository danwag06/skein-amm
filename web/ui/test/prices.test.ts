/**
 * The depth (src/market/prices.ts; 0.34.0: prices come from the pools route, D6 — no beat prices),
 * the skein's doors (src/lib/skein.ts) and the pool rows of the positions (src/lp/positions.ts)
 * — skein-amm 0.9.0.
 */
import { describe, expect, it } from "vitest";
import { encode, decode } from "cbor2";
import { Utils } from "@bsv/sdk";
import { depthOf } from "../src/market/prices";
import { dagCbor, instanceBase, sendMessage } from "../src/lib/skein";
import { readSpends } from "../src/lib/overlay";
import { positionRowsOf } from "../src/lp/positions";

const A = "02" + "aa".repeat(32);
const B = "03" + "bb".repeat(32);
const C = "02" + "cc".repeat(32);
const T = `${"11".repeat(32)}_0`;
const U = `${"22".repeat(32)}_0`;

describe("the depth", () => {
  it("the sats a buy needs to move the price up 2%: x·(√1.02 − 1); none with no sats", () => {
    expect(depthOf(1_000_000n)).toEqual({ bps: 200, sats: 9950n });
    expect(depthOf(0n)).toBeNull();
  });
});

describe("the skein's doors", () => {
  it("a message: POST <instance>/sendMessage, BRC-231 CBOR {message: {recipient, messageBox, body: dag-cbor}}", async () => {
    expect(instanceBase("https://alice.skein.nexus/amm")).toBe("https://alice.skein.nexus");
    expect(instanceBase("http://127.0.0.1:8100/@alice/amm")).toBe("http://127.0.0.1:8100/@alice");
    const seen: { url: string; init: { headers?: Record<string, string>; body?: unknown } }[] = [];
    const af = { fetch: async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => (seen.push({ url, init: init! }), new Response(encode({ id: "m1" }) as BodyInit, { status: 200 })) };
    expect(await sendMessage(af, "https://alice.skein.nexus/amm", A, "amm/admin", { fn: "disable", args: { tokenId: T } })).toBe("m1");
    expect(seen[0]!.url).toBe("https://alice.skein.nexus/sendMessage");
    expect(seen[0]!.init.headers).toEqual({ "content-type": "application/cbor" });
    const m = (decode(seen[0]!.init.body as Uint8Array) as { message: { recipient: Uint8Array; messageBox: string; body: Uint8Array } }).message;
    expect(Utils.toHex(Array.from(m.recipient))).toBe(A);
    expect(m.messageBox).toBe("amm/admin");
    expect(Array.from(m.body)).toEqual(Array.from(dagCbor({ fn: "disable", args: { tokenId: T } })));
    const no = { fetch: async () => new Response(encode({ code: "ERR_DENIED", description: "not root" }) as BodyInit, { status: 403 }) };
    await expect(sendMessage(no, "https://x/amm", A, "amm/register", {})).rejects.toThrow(/403 ERR_DENIED not root/);
  });

  it("the reads (0.34.0): spends of several outpoints in one GET, one record each in query order; one outpoint's object wrapped", async () => {
    const asked: string[] = [];
    const op1 = `${"11".repeat(32)}.0`;
    const op2 = `${"22".repeat(32)}.1`;
    const f = (async (url: string) => {
      asked.push(url);
      const u = new URL(url);
      const ops = (u.searchParams.get("outpoint") ?? "").split(",");
      const rec = (o: string) => ({ outpoint: o, ...(o === op1 ? { spentBy: "ab".repeat(32) } : {}), hops: 0, closed: false });
      return new Response(JSON.stringify(ops.length > 1 ? ops.map(rec) : rec(ops[0]!)));
    }) as typeof fetch;
    const two = await readSpends("http://x/@t/amm", [op1, op2], f);
    expect(two.map((s) => s.outpoint)).toEqual([op1, op2]);
    expect(two[0]).toMatchObject({ spentBy: "ab".repeat(32) });
    expect(asked).toEqual([`http://x/@t/amm/spends?outpoint=${op1},${op2}`]);
    expect(await readSpends("http://x/@t/amm", [op1], f)).toMatchObject([{ outpoint: op1, spentBy: "ab".repeat(32) }]);
    expect(await readSpends("http://x/@t/amm", [], f)).toEqual([]);
    expect(asked).toHaveLength(2);
  });
});

describe("the positions' pool rows", () => {
  it("a pool row (amm-pools, 0.12.0: no claim): its deploy outpoint, the token, the LP key; other rows passed over", () => {
    const rows = positionRowsOf([
      { outpoint: `${"33".repeat(32)}.0`, satoshis: 1, tags: ["amm-pool"], customInstructions: JSON.stringify({ id: T, op: "amm-pool", sym: "TST", dec: "2", protocolID: [2, "3241645161d8"], keyID: "k", counterparty: "self", amm: { validatorIdentity: A } }) },
      { outpoint: `${"44".repeat(32)}.0`, satoshis: 1, tags: ["amm-pool"], customInstructions: JSON.stringify({ id: U, op: "amm-pool", protocolID: [0, "onesat"], keyID: "old" }) },
      { outpoint: `${"55".repeat(32)}.1`, satoshis: 1, tags: [], customInstructions: JSON.stringify({ id: T, amt: "5" }) },
    ]);
    expect(rows).toEqual([
      { deployOutpoint: `${"33".repeat(32)}.0`, tokenId: T, sym: "TST", dec: 2, lpKey: { protocolID: [2, "3241645161d8"], keyID: "k", counterparty: "self" }, validatorIdentity: A },
      { deployOutpoint: `${"44".repeat(32)}.0`, tokenId: U, lpKey: { protocolID: [0, "onesat"], keyID: "old", counterparty: "self" } },
    ]);
  });
});
