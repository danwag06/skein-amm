/**
 * One BRC-104 session per instance (0.27.1): the swap instance at `<origin>/amm` and a token
 * instance at `<origin>/@<tokenId>/amm` each get their own AuthFetch, and a prefixed instance's
 * handshake goes to `<prefix>/.well-known/auth` (the router gives `<origin>/.well-known/auth` to the
 * root instance, which a token instance's sessions never see).
 */
import { describe, expect, it } from "vitest";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { authFetchPerInstance, instanceFetch, sessionKey } from "../src/lib/skein";

function recorder() {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("no", { status: 500 });
  }) as typeof fetch;
  return { urls, fetchFn };
}

const wallet = () => new ProtoWallet(PrivateKey.fromRandom()) as never;

describe("instanceFetch", () => {
  it("sends a token instance's handshake under its prefix and its requests as they are", async () => {
    const r = recorder();
    const f = instanceFetch("http://h/@tok/amm", r.fetchFn);
    await f("http://h/.well-known/auth", { method: "POST" });
    await f("http://h/@tok/amm/lookup", { method: "POST" });
    await f(new URL("http://h/.well-known/auth"), { method: "POST" });
    expect(r.urls).toEqual(["http://h/@tok/.well-known/auth", "http://h/@tok/amm/lookup", "http://h/@tok/.well-known/auth"]);
  });

  it("leaves the root instance's handshake at the origin", async () => {
    const r = recorder();
    await instanceFetch("http://h/amm", r.fetchFn)("http://h/.well-known/auth", { method: "POST" });
    await instanceFetch("http://h", r.fetchFn)("http://h/.well-known/auth", { method: "POST" });
    expect(r.urls).toEqual(["http://h/.well-known/auth", "http://h/.well-known/auth"]);
  });

  it("does not rewrite another origin's handshake", async () => {
    const r = recorder();
    await instanceFetch("http://h/@tok/amm", r.fetchFn)("http://other/.well-known/auth", { method: "POST" });
    expect(r.urls).toEqual(["http://other/.well-known/auth"]);
  });
});

describe("authFetchPerInstance", () => {
  it("keys a session by origin + instance prefix", () => {
    expect(sessionKey("http://h/amm")).toBe("http://h");
    expect(sessionKey("http://h")).toBe("http://h");
    expect(sessionKey("http://h/@tok/amm")).toBe("http://h/@tok");
  });

  it("gives two instances two clients and one instance one", () => {
    const signedFor = authFetchPerInstance(wallet(), recorder().fetchFn);
    const root = signedFor("http://h/amm");
    const tok = signedFor("http://h/@tok/amm");
    expect(tok).not.toBe(root);
    expect(signedFor("http://h/@tok/amm")).toBe(tok);
    expect(signedFor("http://h/amm")).toBe(root);
    expect(signedFor("http://h/@other/amm")).not.toBe(tok);
  });

  it("shakes hands at http://h/@tok/.well-known/auth for a token base, at http://h/.well-known/auth for the root", async () => {
    const r = recorder();
    const signedFor = authFetchPerInstance(wallet(), r.fetchFn);
    await signedFor("http://h/@tok/amm").fetch("http://h/@tok/amm/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    await signedFor("http://h/amm").fetch("http://h/amm/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    expect(r.urls.length).toBeGreaterThan(0);
    expect(r.urls).toContain("http://h/@tok/.well-known/auth");
    expect(r.urls).toContain("http://h/.well-known/auth");
    // Nothing went to the bare origin's handshake on the token's behalf: the first handshake is the token's.
    expect(r.urls[0]).toBe("http://h/@tok/.well-known/auth");
  });
});
