/**
 * public/manifest.json: the W3C manifest's `metanet.groupPermissions`
 * (BRC-73, wallet-toolbox `GroupedPermissions`) declares what the pages use
 * and in the form WalletPermissionsManager matches: level-2 grants by the
 * exact counterparty string ("self" for the BRC-29 keys the page derives),
 * level 1 without one, the action labels as `[1, "action label <label>"]`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import { BRC29_PROTOCOL, brc29PublicKey } from "../src/wallet/brc29";

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8"));
const g = manifest.metanet.groupPermissions;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [readFileSync(p, "utf8")] : [];
  });
}

describe("manifest.json", () => {
  it("a W3C manifest with metanet.groupPermissions: description, protocols, baskets, no certificates, no spending authorization", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe("./");
    expect(Object.keys(g).sort()).toEqual(["basketAccess", "certificateAccess", "description", "protocolPermissions"]);
    expect(g.certificateAccess).toEqual([]);
    // 0.12.0: the exchange's own baskets; no `bsv21`, no `1sat`. 0.27.0: plus `p color assets` (the token list, one grant on
    // first visit, the store the wallet's 1Color module reads); no other `p color` entry (per-token reads and sends the module asks itself).
    expect(g.basketAccess.map((b: { basket: string }) => b.basket)).toEqual(["amm-swap", "amm-pools", "p color assets"]); // 0.29.0: no 1sat-deposit (no funding transaction)
    expect(JSON.stringify(manifest.metanet).match(/p color [a-z0-9]+/g)).toEqual(["p color assets"]);
    expect(JSON.stringify(manifest)).not.toMatch(/spendingAuthorization/);
    for (const e of [...g.protocolPermissions, ...g.basketAccess]) {
      expect(e.description).toMatch(/^[A-Z][^.]*(\.[^.]+)*\.$/); // one sentence
    }
  });

  it("protocols: BRC-29 to self, the exchange's [2, \"amm swap\"] to self, identity key, AuthFetch's two, and every action label the pages use (no onesat: the funding keys are level 0)", () => {
    const used = new Set<string>();
    // Every quoted label in a `labels: [...]` literal (brackets balanced: a plan's labels nest).
    for (const src of sources(join(root, "src"))) {
      for (const m of src.matchAll(/labels: \[/g)) {
        let depth = 1;
        let i = m.index! + m[0].length;
        const from = i;
        for (; i < src.length && depth > 0; i++) depth += src[i] === "[" ? 1 : src[i] === "]" ? -1 : 0;
        const body = src.slice(from, i - 1).replace(/\[[^\[\]]*\]/g, "");
        for (const l of body.matchAll(/"([^"]+)"/g)) used.add(l[1]!);
      }
    }
    expect([...used].sort()).toEqual(["amm-close", "amm-payout", "amm-pool-deploy", "amm-swap"]);
    expect(g.protocolPermissions.map((p: { protocolID: unknown; counterparty?: string }) => [p.protocolID, p.counterparty])).toEqual([
      [[2, "3241645161d8"], "self"],
      [[2, "amm swap"], "self"],
      [[1, "identity key retrieval"], undefined],
      [[2, "server hmac"], "self"],
      // No counterparty: the instance's identity is not known here; the manager groups it per peer at first use.
      [[2, "auth message signature"], undefined],
      ...["amm-swap", "amm-pool-deploy", "amm-close", "amm-payout"].map((l) => [[1, `action label ${l}`], undefined]),
    ]);
  });

  it("the page asks for its BRC-29 keys with counterparty \"self\", the string the grant is keyed by", async () => {
    const asked: unknown[] = [];
    const w = { getPublicKey: async (a: unknown) => (asked.push(a), { publicKey: new PrivateKey(7).toPublicKey().toString() }) } as unknown as WalletInterface;
    await brc29PublicKey(w, { derivationPrefix: "AA==", derivationSuffix: "AQ==" });
    expect(asked).toEqual([{ protocolID: BRC29_PROTOCOL, keyID: "AA== AQ==", counterparty: "self", forSelf: true }]);
    const entry = g.protocolPermissions.find((p: { protocolID: unknown }) => JSON.stringify(p.protocolID) === JSON.stringify(BRC29_PROTOCOL));
    expect(entry.counterparty).toBe("self");
  });
});
