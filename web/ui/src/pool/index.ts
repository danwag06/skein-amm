/**
 * The AMM Pool script template (pool/Pool.runar.go) over runar-sdk, from the
 * local Rúnar checkout (README.md, "runar-sdk from the local checkout").
 * Independent of React.
 */
export {
  PoolTemplate,
  PoolBuildError,
  RESCINDED_KEY,
  p2pkhUnlock,
  type Pool,
  type PoolArgs,
  type PoolFields,
  type PoolUtxo,
  type BuilderInput,
  type FeeSpec,
  type SwapParams,
  type SwapExpectation,
  type SwapAmounts,
  type SwapPlanParams,
  type CallPlan,
  type CloseParams,
  type PoolCall,
  type PoolSigner,
  type SigSlot,
  type PoolBuildErrorCode,
} from "./template";
export { poolArtifact, artifactOf, METHOD_INDEX, type PoolMethod, type PoolVersion } from "./artifact";
export { decodeOneColor, oneColorValuePrefix, type OneColorPrefix, type OneColorRole } from "./oneColor";
