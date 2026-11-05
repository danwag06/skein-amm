/**
 * The runar-sdk names the Pool template uses (src/pool/template.ts, src/pool/artifact.ts), from
 * the vendored modules beside this file (`runar-sdk/src`, runar d207ee8e; NOTICE). runar-sdk's
 * own barrel also re-exports its providers, signers and codegen, which are not vendored.
 */
export { EMPTY_SIG, RunarContract, encodeArg, encodePushData, encodeScriptNumber } from "./runar-sdk/src/contract.js";
export { extractConstructorArgs, matchesArtifact } from "./runar-sdk/src/script-utils.js";
export { extractStateFromScript, findLastOpReturn, serializeState } from "./runar-sdk/src/state.js";
export type { RunarArtifact } from "../../pool/runar-ir-schema.js";
