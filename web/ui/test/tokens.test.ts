/**
 * The swap instance's reads (Open Exchange, shruggr/open-exchange#1): the token
 * list (`GET <swap>/tokens`, each token enabled or disabled: root's decision, a
 * fact), the defaults (`GET <swap>/defaults`) and discovery (`GET
 * <swap>/discovery`, on or off); a token instance's AMM base, computed
 * (`tokenBase`: `<origin>/@<tokenId>/amm`).
 */
import { describe, expect, it } from "vitest";
import { readDefaults, readDiscovery, readTokens } from "../src/lib/skein";
import { tokenBase } from "../src/lib/config";
import { discoveryText } from "../src/ox/Settings";

const CONFIG = "https://ox.example/amm";
const T = `${"ab".repeat(32)}_0`;
const U = `${"cd".repeat(32)}_0`;

const answering = (body: unknown, seen: string[] = []) =>
  (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("the swap instance's reads", () => {
  it("readTokens: GET <swap>/tokens — every row, enabled or disabled; a row of another shape (or a status before Open Exchange) dropped", async () => {
    const seen: string[] = [];
    const rows = [
      { tokenId: T, topic: `tm_color_${T}`, sym: "AMM", dec: 5, icon: "data:image/png;base64,AA==", status: "enabled", since: 20 },
      { tokenId: U, topic: `tm_color_${U}`, sym: "", dec: 0, status: "disabled", since: 10 },
      { tokenId: U, status: "creating" },
      { tokenId: "x", status: "bogus" },
      { status: "enabled" },
    ];
    const ts = await readTokens(CONFIG, answering(rows, seen));
    expect(seen).toEqual([`${CONFIG}/tokens`]);
    expect(ts).toEqual([
      { tokenId: T, topic: `tm_color_${T}`, sym: "AMM", dec: 5, icon: "data:image/png;base64,AA==", status: "enabled", since: 20 },
      { tokenId: U, topic: `tm_color_${U}`, sym: "", dec: 0, status: "disabled", since: 10 },
    ]);
  });

  it("readDefaults: GET <swap>/defaults — terms and market when set, none otherwise", async () => {
    expect(await readDefaults(CONFIG, answering({}))).toEqual({});
    const d = { terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, market: { minCommissionBps: 1 } };
    expect(await readDefaults(CONFIG, answering(d))).toEqual(d);
    expect(await readDefaults(CONFIG, answering({ terms: { lpFeeBps: 30 } }))).toEqual({});
    // 0.42.0: the price to enable a token, when set.
    expect(await readDefaults(CONFIG, answering({ enablePriceSats: null }))).toEqual({});
    expect(await readDefaults(CONFIG, answering({ enablePriceSats: 2000 }))).toEqual({ enablePriceSats: 2000 });
  });

  it("readDiscovery: GET <swap>/discovery — {on, since}; {on: false} with none or another shape", async () => {
    const seen: string[] = [];
    expect(await readDiscovery(CONFIG, answering({ on: false }, seen))).toEqual({ on: false });
    expect(seen).toEqual([`${CONFIG}/discovery`]);
    expect(await readDiscovery(CONFIG, answering({ on: true, since: 5 }))).toEqual({ on: true, since: 5 });
    expect(await readDiscovery(CONFIG, answering({ on: false, since: 7 }))).toEqual({ on: false, since: 7 });
    expect(await readDiscovery(CONFIG, answering({ status: "enabled" }))).toEqual({ on: false });
    expect(await readDiscovery(CONFIG, answering([]))).toEqual({ on: false });
  });

  it("the Discovery card's text: on or off", () => {
    expect(discoveryText({ on: false })).toMatch(/^Off/);
    expect(discoveryText({ on: true, since: 1 })).toMatch(/^On: .*tm_color.*\(ls_color\)/);
  });

  it("tokenBase: a token instance's AMM base, <origin>/@<tokenId>/amm on the swap instance's origin", () => {
    expect(tokenBase(T, CONFIG)).toBe(`https://ox.example/@${T}/amm`);
    expect(tokenBase(T, "http://127.0.0.1:8100/@swap/amm")).toBe(`http://127.0.0.1:8100/@${T}/amm`);
  });
});
