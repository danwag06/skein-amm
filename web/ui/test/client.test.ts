/**
 * The package `@dcasegr/amm-client` (src/index.ts; 0.38.0, D8–D14): `createClient` bound to the
 * origin and fetch it is given (D9: no env, no location), the shared names (D10), the error kinds
 * (D13) and the `x-topics` form (D14).
 */
import { describe, expect, it } from "vitest";
import { PoolBuildError } from "../src/pool";
import { RelayError } from "../src/market/relay";
import * as pkg from "../src/index";

const { createClient, ClientError, errorKind, toClientError, CLIENT_ERROR_KINDS, exchangeBase } = pkg;
const T = `${"ab".repeat(32)}_0`;

/** A fetch that answers every GET from `routes` by path (404 else) and records the URLs. */
function host(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    const body = routes[new URL(url).pathname];
    return body === undefined ? new Response("no", { status: 404 }) : Response.json(body);
  };
  return { f, urls };
}

describe("createClient (D9)", () => {
  it("an origin alone is the swap app at <origin>/amm; a base with a path is kept; every read goes over the fetch given, to that origin", async () => {
    expect(exchangeBase("https://swap.example")).toBe("https://swap.example/amm");
    expect(exchangeBase("https://swap.example/")).toBe("https://swap.example/amm");
    expect(exchangeBase("http://127.0.0.1:8100/@swap/amm/")).toBe("http://127.0.0.1:8100/@swap/amm");
    const { f, urls } = host({ "/amm/tokens": [{ tokenId: T, topic: `tm_color_${T}`, sym: "TST", dec: 2, status: "enabled" }], "/amm/defaults": {}, "/amm/discovery": { on: true } });
    const c = createClient({ origin: "https://swap.example", fetch: f });
    expect([c.base, c.feeRateSatsPerKb, c.wallet]).toEqual(["https://swap.example/amm", 100, null]);
    expect((await c.registeredTokens()).map((t) => [t.tokenId, t.sym, t.status])).toEqual([[T, "TST", "enabled"]]);
    // The token list is read once per client (D4).
    await c.registeredTokens();
    expect(await c.tokenBaseOf(T)).toBe(`https://swap.example/@${T}/amm`);
    await c.discoveryState();
    expect(urls).toEqual(["https://swap.example/amm/tokens", "https://swap.example/amm/discovery"]);
    expect(c.discoveryBase()).toBe("https://swap.example/@discovery/1color");
    // A dev base on another origin: the same reads there.
    const other = host({ "/@swap/amm/tokens": [] });
    await createClient({ origin: "http://127.0.0.1:8100/@swap/amm", fetch: other.f }).registeredTokens();
    expect(other.urls).toEqual(["http://127.0.0.1:8100/@swap/amm/tokens"]);
  });

  it("no wallet: the reads work, the actions say so; withWallet keeps what was read", async () => {
    const { f, urls } = host({ "/amm/tokens": [] });
    const c = createClient({ origin: "https://swap.example", fetch: f, feeRateSatsPerKb: 300 });
    await expect(c.myTokens()).rejects.toThrow("Connect a wallet first");
    await c.registeredTokens();
    const w = c.withWallet({ getPublicKey: async () => ({ publicKey: "02" + "11".repeat(32) }) } as never);
    expect([w.base, w.feeRateSatsPerKb, w.wallet !== null]).toEqual([c.base, 300, true]);
    await w.registeredTokens();
    expect(urls).toEqual(["https://swap.example/amm/tokens"]);
  });
});

describe("the shared names (D10)", () => {
  it("each names the rows the pages file, unchanged", () => {
    expect(pkg.POOLS_BASKET).toBe("amm-pools");
    expect(pkg.SWAP_BASKET).toBe("amm-swap");
    expect(pkg.SWAP_PROTOCOL).toEqual([2, "amm swap"]);
    expect(pkg.SWAP_KEY_PREFIX).toBe("amm-swap-");
    // 0.40.0: a staged row's keyID random; a change row's from the leg's first input of that kind; the stage label and the description mark.
    expect(pkg.newSwapKeyID()).toMatch(/^amm-swap-[0-9a-f]{32}$/);
    expect(pkg.changeKeyID(`${"cd".repeat(32)}.1`)).toBe(`amm-swap-${"cd".repeat(32)}.1:change`);
    expect(pkg.SWAP_STAGE_LABEL).toBe("amm-swap-stage");
    expect(pkg.SWAP_KEY_MARK).toBe(" · amm-swap ");
    expect(pkg.swapKeyIdOfDescription(pkg.swapKeyDescription("TST for a swap", `amm-swap-${"0f".repeat(16)}`))).toBe(`amm-swap-${"0f".repeat(16)}`);
    expect(pkg.legDerivation(`${"cd".repeat(32)}.1`, "change").derivationPrefix).toBe("YW1tIHN3YXAgY2hhbmdl");
    expect(pkg.LP_KEY_PROTOCOL).toEqual([2, "3241645161d8"]);
    expect(pkg.LP_KEY_MARK).toBe(" · amm-lp ");
    expect(pkg.POOL_DEPLOY_LABEL).toBe("amm-pool-deploy");
    expect([pkg.POOL_TAG, pkg.POOL_OP]).toEqual(["amm-pool", "amm-pool"]);
    expect(pkg.LEG_PATIENCE_MS).toBe(15_000);
    expect("SWAP_TTL_MS" in pkg).toBe(false);
    expect(pkg.DEFAULT_FEE_RATE_SATS_PER_KB).toBe(100);
    for (const fn of [pkg.transferPlanLabels, pkg.newReceivingKey, pkg.receiptOutput, pkg.swapInstructions, pkg.swapSatsInstructions, pkg.poolCustomInstructions, pkg.lpKeyDescription, pkg.lpKeyIdOfDescription, pkg.isPoolRow, pkg.createClient]) expect(typeof fn).toBe("function");
    expect(pkg.transferPlanLabels(T).some((l) => l.startsWith("p color plan"))).toBe(true);
  });

  it("x-topics is the BRC-22 JSON array (D14)", () => {
    expect(pkg.xTopics([`tm_color_${T}`])).toBe(`["tm_color_${T}"]`);
  });
});

describe("error kinds (D13)", () => {
  it("the kinds, and what each error is", () => {
    expect([...CLIENT_ERROR_KINDS]).toEqual(["stale_pool", "fee_mismatch", "quote_mismatch", "slippage", "pool_spent", "user_rejected", "no_answer", "below_minimum", "refused", "network"]);
    for (const code of ["stale_pool", "fee_mismatch", "quote_mismatch", "slippage"] as const) expect(errorKind(new PoolBuildError(code, "x"))).toBe(code);
    expect(errorKind(new PoolBuildError("token_mismatch", "x"))).toBeUndefined();
    expect(errorKind(new RelayError("failed", "x", 500))).toBe("refused");
    expect(errorKind(new RelayError("busy", "x", 503))).toBe("no_answer");
    expect(errorKind(Object.assign(new Error("Permission denied."), { code: "ERR_PERMISSION_DENIED" }))).toBe("user_rejected");
    expect(errorKind(new Error("The user has denied the request for permission."))).toBe("user_rejected");
    expect(errorKind(new TypeError("Failed to fetch"))).toBe("network");
    expect(errorKind(new Error("the pool moved: the lookup's tip is a.0, the plan priced b.0"))).toBe("stale_pool");
    expect(errorKind(new Error("Connect a wallet first"))).toBeUndefined();
    const e = toClientError(new TypeError("fetch failed"));
    expect(e).toBeInstanceOf(ClientError);
    expect([(e as InstanceType<typeof ClientError>).kind, (e as Error).message]).toEqual(["network", "fetch failed"]);
    const plain = new Error("Connect a wallet first");
    expect(toClientError(plain)).toBe(plain);
  });

  it("a client action's error of a kind is a ClientError, its message as before", async () => {
    const c = createClient({ origin: "https://swap.example", fetch: async () => { throw new TypeError("Failed to fetch"); } });
    await expect(c.registeredTokens()).rejects.toMatchObject({ name: "ClientError", kind: "network", message: "Failed to fetch" });
  });
});
