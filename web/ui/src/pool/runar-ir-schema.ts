/**
 * `runar-ir-schema`, minus its Ajv validators: what the vendored runar-sdk modules
 * (src/vendor/runar, their `runar-ir-schema` import rewritten to this file) read. See
 * README.md "runar-sdk, vendored".
 *
 * runar-ir-schema's own `index.ts` re-exports `validators.ts`, which reads its
 * JSON schemas from disk at import time (`node:fs`, `fileURLToPath(import.meta.url)`)
 * and imports `ajv`. Neither works in a browser bundle, and runar-sdk never
 * calls the validators. Every other value export of that barrel (and the
 * artifact, ANF and stack IR types runar-sdk uses) is re-exported
 * here from the vendored copy of its sources (src/vendor/runar/runar-ir-schema).
 */
export * from "../vendor/runar/runar-ir-schema/src/state-layout.js";
export * from "../vendor/runar/runar-ir-schema/src/abi-type-encoding.js";
export * from "../vendor/runar/runar-ir-schema/src/canonical-json.js";
export * from "../vendor/runar/runar-ir-schema/src/input-limits.js";
export * from "../vendor/runar/runar-ir-schema/src/unknown-anf-kind-error.js";
export { MERGED_LOCAL_TEMP_PREFIX } from "../vendor/runar/runar-ir-schema/src/anf-ir.js";
export type * from "../vendor/runar/runar-ir-schema/src/artifact.js";
export type * from "../vendor/runar/runar-ir-schema/src/anf-ir.js";
export type * from "../vendor/runar/runar-ir-schema/src/stack-ir.js";
