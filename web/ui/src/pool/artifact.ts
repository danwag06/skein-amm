import type { RunarArtifact } from "../vendor/runar/runar-sdk.js";
import poolArtifactJson from "./pool.artifact.json";

/**
 * The compiled Pool contract (pool/Pool.runar.go), as the Go compiler writes
 * it (`compiler.ArtifactToJSON`; see README.md "pool.artifact.json"). Its
 * `script` is byte-identical to the template in src/fixtures/pool_artifact.zig
 * (there with its codeSepIndex slots resolved); both are written by
 * `go run ./gen/vectors` (0.9.0).
 *
 * 0.13.0 (layout 2): state TokenReserve, LpPubKey, ValidatorPubKey,
 * ValidatorIdentity, Nonce, Affirmation; methods Swap, Close (the LP's, outputs
 * free), Rescind.
 */
export const poolArtifact = resolveCodeSepSlots(poolArtifactJson as unknown as RunarArtifact);

/**
 * The artifact with its codeSepIndex slots resolved in `script` (layout 2: its variable-length
 * state makes each method push its OP_CODESEPARATOR's index). The separator is the code's
 * byte 1, before every constructor slot, so each slot is OP_1 in every pool — as gen/vectors
 * resolves them for src/pool.zig. runar-sdk's matcher (`matchesArtifact`,
 * `extractConstructorArgs`) knows only constructor slots; its builder overwrites the resolved
 * byte with the same OP_1.
 */
function resolveCodeSepSlots(a: RunarArtifact): RunarArtifact {
  const slots = (a as { codeSepIndexSlots?: { byteOffset: number; codeSepIndex: number }[] }).codeSepIndexSlots ?? [];
  if (slots.length === 0) return a;
  let script = a.script;
  for (const s of slots) {
    if (s.codeSepIndex !== 1 || script.slice(s.byteOffset * 2, s.byteOffset * 2 + 2) !== "00") throw new Error("pool artifact: a codeSepIndex slot not at byte 1");
    script = script.slice(0, s.byteOffset * 2) + "51" + script.slice(s.byteOffset * 2 + 2);
  }
  return { ...a, script };
}

/** A pool's layout: 2, the only one (0.29.1: layout 1, the 0.9.0-0.12.x contract, is dropped). */
export type PoolVersion = 2;

export function artifactOf(_version: PoolVersion): RunarArtifact {
  return poolArtifact;
}

/** Public method indices (the method selector pushed last in a call). */
export const METHOD_INDEX = { swap: 0, close: 1, rescind: 2 } as const;
export type PoolMethod = keyof typeof METHOD_INDEX;
