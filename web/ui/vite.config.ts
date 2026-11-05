import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = fileURLToPath(new URL(".", import.meta.url));

// runar-sdk is vendored (src/vendor/runar, README.md "runar-sdk, vendored"): no alias, no
// checkout. The engine and the client package's sources are this directory's own and
// ../engine/src (the workspace; README.md "The packages").
// Build output (`npm run build` -> dist/, not committed; 0.23.0): the pages are
// served by shruggr/open-exchange's swap app, whose scripts/www.sh builds them
// from this library at a tag into its apps/swap/www/ (--outDir) and copies the
// 1Color pages beside them. Relative base so the pages work under
// /<app>/ on any instance, and under a host's "/@<handle>/<app>/" dev form.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      // @1sat/actions lazily imports xdelta3-wasm (OrdFS patches, unused
      // here), whose package.json names a "module" file that is not in the
      // package (dist/xdelta3.esm.js; the file is dist/xdelta3-wasm.esm.js).
      // Point at the file that exists so the bundler can resolve it.
      { find: /^xdelta3-wasm$/, replacement: resolve(here, "node_modules/xdelta3-wasm/dist/xdelta3-wasm.esm.js") },
    ],
    // One copy of each (@bsv/sdk 4, package.json overrides).
    dedupe: ["@bsv/sdk", "cbor2", "@ipld/dag-cbor", "cborg"],
  },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    assetsDir: "assets",
  },
  test: {
    environment: "node",
    globals: true,
  },
});
