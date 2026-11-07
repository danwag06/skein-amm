# The AMM on a skein

A constant-product AMM between BSV and one 1Color token per pool, served by
a skein overlay app. Decided in shruggr/skein#120: 1Color is components (a
topic manager and a lookup service, shruggr/skein-1color); the AMM is an
app that carries them with its own pool lookup, validator and relay; one
topic per token, registered by root at runtime.

## The pieces

| role | source | what it does |
|---|---|---|
| `overlay` | skein-overlay 0.16.0 (`bin/overlay.wasm`, copied; 0.16.0: the beat's `terms` from the head `amm/terms`) | a submission by message in box `amm/submit`, answered to the submitter's box, or by `POST /submit` (BRC-22, the STEAK); `/lookup`, gossip, the listing and documentation reads; `register` / `deregister` a topic (and `registerLookup` / `deregisterLookup` its lookup), and with it the market's liveness and the validator's beacon on `tm_color_<txid>_0-live` (below, "Market and validator"), and each registered lookup's beacon and liveness on `<service>-live`; hands every admitted BEEF to the chain app |
| `color-topic` | skein-1color 0.10.0 (copied) | judges `tm_color_<txid>_0` (`tm_color_<assetId>`, `_<vout>` always) by the BRC-162 rules; `tm_color` admits every deploy |
| `color-lookup` | skein-1color 0.10.0 (copied) | a token instance's `ls_color_<assetId>` (BRC-207: `color-spendability`, `color-admission`), the discovery instance's `ls_color` (a deploy by BRC-207's `color-admission` with `topic: "tm_color"`; 0.20.1, skein-1color 0.12.1: `ls_color_deploys` gone), one index; its fn `tokens`, the token list, the read route `/color/tokens` (0.6.0: the token list is a read of the components) |
| `amm-lookup` | `programs/amm-lookup` | `ls_amm_<assetId>` (0.21.0; `ls_amm` before, its index still `<app>/ls_amm`): the listed pools (below, "The listing"), per token; its beat on `ls_amm_<assetId>-live`, the prices ("Prices") |
| `amm-validator` | `programs/amm-validator` | the validator, for every registered token (always, 0.8.1): `swap` (a libp2p direct call; it submits by message to its own overlay), `affirm` (0.11.0; 0.13.0: it picks the nonce; called in-VM by `amm.pool.affirm`), root's `rescind` (0.13.0; 0.11.0–0.12.x: `close`) |
| `amm-setup` | `programs/amm-setup` | the token's setup (0.22.0): the deploy event in `amm/deploy` (`kernel.beef`) → the head `amm/token`, the token's topic and lookups registered with the engine by call (skein-overlay 0.18.0), the deploy submitted when the seed did not take it; the read `/token` ("The token's setup", below) |
| `amm-p2p` | `programs/amm-p2p` | `amm.swap/1` terms (0.44.0: the relay is the open-exchange host's); `amm.pool/1`: `terms`, `affirm`; the read `/spends` and (0.34.0) the public read API, the pages (`www/` from the app's tree); the catch-up utility, unscheduled |
| | `src/pool.zig` | the pool library (module `pool`), over `1color`'s parser and rules |
| | `pool/Pool.runar.go` | the contract |
| | `web/ui` → `www/` | the AMM pages; `www/color/` the 1Color pages |

The topic knows no application: a pool output is a token output like any
other and is admitted exactly when the BRC-162 rules admit it. Which of
those outputs are pools is the lookup's judgement, and whether one may be
spent is the validator's.

## The pool rule

A pool is a BRC-162 value output at output 0 whose lock is the compiled
Pool code, `OP_RETURN`, and the state (0.13.0, layout 2; David Case
2026-10-22, agent-env plans/validator-signoff-2026-10-22.md §9):

| bytes | state field |
|---|---|
| 8 | TokenReserve (little-endian sign-magnitude, Rúnar's bigint) |
| 33 | LpPubKey |
| 33 | ValidatorPubKey (33 zero bytes once rescinded) |
| 33 | ValidatorIdentity |
| 32 | Nonce (Rúnar's fixed 32-byte type, raw) |
| 1 + n | Affirmation: one length byte, then the validator's DER signature (n ≤ 72; `OP_0` when empty) |

The BSV reserve is the output's satoshis; the token reserve is the prefix's
amount, duplicated in state. There is no payload (0.11.0–0.12.x carried the
affirmation as the deploy's BRC-162 payload). Nonce and Affirmation are
never assigned, so Rúnar carries them into every continuation: every pool
output attests itself (below, "The deploy and the affirmation"). The
compiled template is 3,568 bytes (0.12.x: 2,657), a pool output 4,011 bytes
with its args and a 71-byte DER (0.12.x: 2,996): the variable-length
Affirmation costs each method a state parser, and Rescind its own copy of
the continuation writer. A pool deployed before 0.13.0 (layout 1: the first
four state fields, `Close(sig, bsvFee)`) is no pool to the pages since
0.29.1 (David: dropped, every testnet pool is layout 2); amm-lookup and
amm-validator know layout 2 only (below, "Not wired").

- **Indexed** (amm-lookup, `pool.check`): at output 0; the prefix's id and
  amount equal the AssetId and TokenReserve the code and state carry (the
  contract writes the prefix from its copies and never reads it). The id is
  32 bytes, so only a token deployed at output 0 has pools.
- **Methods** (the contract; 0.13.0, David Case 2026-10-22, three):
  `Swap(validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
  commissionPkh, tokenChangePkh, tokenChange)`, the validator's (0.40.0,
  David Case 2026-11-05: `tokenChange ≥ 0`; when nonzero, one more output
  after the commission and before Rúnar's sats change, 1 sat,
  `tokenChange` tokens to `tokenChangePkh`; otherwise unchanged); `Close(lpSig)`, the LP's
  alone: a plain `OP_CHECKSIG` against the LP key, the **outputs free** (no
  output covenant: the LP spends the LP's own funds, its wallet decides
  where they go; the method writes no state and adds no output, so Rúnar
  checks no hashOutputs and takes no change parameters); `Rescind(
  validatorSig)`, the validator's: `OP_CHECKSIG` against the current
  ValidatorPubKey, exactly one continuation at output 0 — the same sats,
  TokenReserve, LpPubKey, ValidatorIdentity, Nonce and Affirmation — with
  ValidatorPubKey 33 zero bytes, then Rúnar's change output (the validator
  pays the fee from an input of its own; nothing is taken from the pool).
  After a Rescind no Swap can be signed (no key matches the zero key) and no
  second Rescind; the LP closes the pool as any. Fees are fixed at deploy,
  in basis points of the input, rounded up, paid in the input asset:
  LpFeeBps to the LP, ValidatorFeeBps to the validator, CommissionBps to
  whoever relays the swap — the validator's terms. A swap carries only the
  contract's outputs. (0.11.0–0.12.x: `Close(sig, bsvFee)`, the LP's or
  the validator's, everything to the LP key.)
- **Keys rotate.** The validator's key is the BRC-42 child of its
  ValidatorIdentity, protocol `[1, "amm pool"]`, counterparty anyone: a
  pool's first key (its deploy's) keyed by the Nonce, as 64 lowercase hex
  digits; each Swap's next key keyed by the pool outpoint that Swap spends,
  `<txid>_<vout>` (0.9.0's convention, kept). The LP's key is the pool's
  for its life. amm-lookup checks both derivations (below, "The listing");
  the validator derives its key before signing (`currentKeyId`).
- **The validator signs last** (amm-validator README "What is checked"):
  the pool is ours, live and not rescinded, the call is the method's, the
  next key is our child of the spent outpoint, the topic would admit the
  transaction, the pool checks pass, the outputs are the contract's, every
  other input (and every unproven parent) is signed. Then it signs the pool
  input through the signer and submits the transaction to its own overlay
  by message — `{fn: "submit", args: {beef, topics: [tm_color_<txid>_0]}}`
  from the instance to itself, box `amm/submit` — and answers the direct
  call on the engine's first answer (`admitted`, `rejected`).

## The deploy and the affirmation (0.13.0)

David Case, 2026-10-09: "Fees are the validator's"; 2026-10-21: pool
deploys move to the BRC-207 wallet module; 2026-10-22: the validator's
nonce, the attestation in state, no input named by the page.

- **The terms** (0.15.0, shruggr/skein-amm#2; David Case 2026-10-23:
  "The configs should not be published in the image. This will be a
  dynamic, competitive marketplace."). The validator's fees are a runtime
  record root sets, skein-wide: root's message `{fn: "terms", args:
  {lpFeeBps, validatorFeeBps, commissionBps}}` (each an integer, 0 to
  10 000) in the box `amm/validator` sets them, `{fn: "terms", args:
  null}` clears them, gated by `roles: {root: [..., "terms"]}`.
  amm-validator keeps them as the root of the head `amm/terms` (the record
  `{lpFeeBps, validatorFeeBps, commissionBps}`, or `null` once cleared;
  src/terms.zig), answers root `{fn: "terms", request, result}` (or
  `error: {code: "bad-args", message}`, nothing written), and sends the
  instance itself `{fn: "rebeat"}` in box `amm`: the engine (skein-overlay
  0.16.0) re-declares every registered topic's beat, whose `terms` is the
  record. Terms set: this skein is a validator. Unset: a market only —
  `affirm` and the swap signing are refused `not_validating`, "no terms:
  this skein validates nothing", `amm.pool.terms` answers "no validator
  here", and the beat carries no `terms`. No fee numbers ship in the
  manifest or the image (`config.amm.ammValidator`, 0.9.0 to 0.14.2, is
  gone, with no fallback). An LP posting here accepts the terms: the page
  has no fee inputs and reads them with `amm.pool.terms`. The three fees
  are the terms (no termsHash).
- **The market's terms** (0.16.0, shruggr/skein-amm#3; David Case
  2026-10-24: the market half of the validator's terms). One record for
  the whole skein for now (per-token overrides keyed by token id are the
  release shape, not built): root's message `{fn: "market", args:
  {minCommissionBps}}` (an integer, 0 to 10 000) in the box `amm/amm-p2p`
  (the relay's own box) sets it, `{fn: "market", args: null}` clears it,
  gated by `roles: {root: [..., "market"]}`. amm-p2p keeps it as the root
  of the head `amm/market` (the record `{minCommissionBps}`, or `null` once
  cleared; programs/amm-p2p/src/market.zig) and answers root `{fn:
  "market", request, replyTo, result}` (or `error: {code: "bad-args",
  message}`, nothing written) in that box. Unset or cleared: a minimum of
  0. `amm.swap.terms` answers it as `minCommissionBps` beside the
  commission pkh, and the Swap page lists (and quotes over) only the pools
  whose CommissionBps is at or above it, saying how many it hid ("N pools
  below this market's minimum commission"). It is a listing preference of
  this market, not a rule: anyone can swap against any pool through their
  own skein or straight to the validator, so the relay refuses nothing by
  it (David 2026-10-24: "Are you putting in work to limit things you
  shouldn't be?").
- **The commission key** (0.16.0). The relay's commission payout key is
  the instance's own, derived, not configured: hash160 of its BRC-43 key
  at security level 1, protocol `amm commission`, key ID `relay`,
  counterparty `anyone` (relay.zig `commission_protocol`; derived as the
  validator's keys are, `amm pool` / anyone), so anyone can compute it from
  the instance's identity and only the instance signs for it.
  `amm.swap.terms` answers it as `commissionPkh`; the page names it as
  Swap's commissionPkh, and the relay passes a swap of a pool that charges
  a commission only when that output pays it (`commission_missing`
  otherwise, as before). `config.amm.commission` (to 0.15.0) is gone.
- **The affirmation.** Before the LP's wallet builds the deploy, the page
  asks this skein's validator, `amm.pool.affirm {pool, satoshis}` (below,
  "Interfaces"): `pool` the pool output's locking script as the deploy will
  carry it, its ValidatorPubKey, Nonce and Affirmation still to come (the
  page sends 33 zero bytes, 32 zero bytes and an empty Affirmation; the
  validator ignores those three), `satoshis` its BSV reserve. amm-validator
  checks it — a pool (the Pool code; prefix id and amount the asset id and
  TokenReserve the code and state carry; no payload), its
  ValidatorIdentity ours, its token's topic registered, its fees our terms
  exactly (`fees_unacceptable`, the field and the term in `detail`), its
  reserves positive — then picks a random 32-byte nonce, derives its key
  from it, has the signer agree (`wrong_validator_key`), and signs the
  message below. It answers `{validatorPubKey, nonce, signature}`. Nothing
  is recorded or submitted.
- **The message v2** (src/pool.zig `affirmMessage`, web/ui
  `PoolTemplate.affirmationMessage`, gen/vectors `affirmMessage`; 221
  bytes):

  | bytes | field |
  |---|---|
  | 18 | `"skein-amm affirm 2"`, ASCII: the tag (a domain separator, the layout's version) |
  | 32 | AssetId: the bytes the pool script pushes (the token's deploy txid, internal byte order) |
  | 8 × 3 | LpFeeBps, ValidatorFeeBps, CommissionBps: int64, little-endian |
  | 8 | TokenReserve: uint64, little-endian |
  | 8 | the pool output's satoshis (the BSV reserve): uint64, little-endian |
  | 33 × 3 | LpPubKey, ValidatorPubKey, ValidatorIdentity: compressed |
  | 32 | Nonce |

  The signature is ECDSA by the ValidatorPubKey over sha256(message), DER
  (the signer signs that digest as is: BRC-100 `createSignature`
  `hashToDirectlySign`; `@bsv/sdk`'s `PublicKey.verify(message, sig)`
  hashes the message itself). ValidatorPubKey = the anyone-child of
  ValidatorIdentity, `[1, "amm pool"]`, key ID the nonce's 64 hex digits.
- **The deploy.** The page checks the answer (the key is the validator's
  child of the nonce; the pool with the three in its state attests itself)
  and writes ValidatorPubKey, Nonce and Affirmation into the pool's state.
  The LP's wallet builds, signs and broadcasts the deploy as one
  createAction naming **no input**: outputs [the pool], the `p color plan`
  a transfer with no `inputPositions` and no owned outputs; the BRC-207
  module selects the token inputs and adds the token change, and supplies
  the input BEEF of its own selected inputs (agent-env
  plans/validator-signoff-2026-10-22.md §10: `@bopen-io/color-permission-module`
  0.1.1, the module paging its asset basket; not the toolbox). The module
  submits to the token topic `tm_color_<assetId>`; the page submits it too.
  The validator's part at deploy time ends with the affirmation. The pages'
  side is below, "The pages and the wallet's module".

## The pages and the wallet's module (0.12.0; 0.13.0)

David Case, 2026-10-21/22; 0.13.0, 2026-10-22 (deploy, Close, Recover). The pages (`web/ui`, the Open Exchange) hold the
user's tokens in the wallet's BRC-207 `color` module (`@bsv/color-permission-module`;
Yours, branch `1color`, registers it, its overlay on testnet this skein,
`https://swap.skein.nexus`). The module's names are the page's
(`src/wallet/color.ts`): the asset id `<txid>_<vout>`, its tag
`<txid>v<vout>`; the reads `p color assets` and `p color balance <tag>`; a
send is a `createAction` with a `p color plan` (`ColorPlan.toLabels`) and
`randomizeOutputs: false`, the module selecting token inputs, adding token
change, asking the user, signing and submitting; a receive is an output
locked to a module receiving key, `[2, "p color <tag> <prefixHex>
<suffixHex>"]`, keyID `color`, counterparty the sender, taken in with
`internalizeAction` (`basket insertion` into `p color <tag>`, the receipt
`{version: 1, assetId, derivationPrefix, derivationSuffix,
senderIdentityKey}`) once the overlay admits it. The exchange's own
baskets: `amm-pools` (the LP's position rows) and `amm-swap` (the active
swap basket, keys `[2, "amm swap"]`, counterparty self, a fresh keyID per
output; customInstructions `{assetId, amount, protocolID, keyID,
counterparty}`).

- **Your tokens.** The assets `p color assets` lists, each balance the sum
  of its held value outputs there (0.27.0: one read for the whole list,
  granted once by the pages' group permissions, `basketAccess` `p color
  assets`; no per-token `p color balance <tag>` in the list); symbol, decimals and icon from
  the token list (`/color/tokens`), else `ls_color` BRC-207 `color-admission` (`topic: "tm_color"`) at the host root (0.20.1), else
  a deploy the wallet holds. Beside it, what `amm-swap` holds, with Move
  back.
- **Deploy a position** (0.13.0). At a market price (0.28.1), the
  amount typed last (Tokens or Sats) is the source and the other follows
  at the "market price now" rate: sats = tokens × price rounded to whole
  sats, tokens = sats ÷ price in the token's decimals; no pools, no
  filling. The LP key: a BRC-29 key to self under a
  fresh random keyID (derivationPrefix base64("amm-lp"), derivationSuffix
  16 random bytes), named in the deploy's pool output description: `AMM pool:
  <SYM> / BSV · amm-lp <the suffix's 16 bytes, lowercase hex>` (0.29.4; 0.29.3
  used a label, which prompted on every deploy), nothing kept in the browser. `amm.pool.terms`;
  `amm.pool.affirm {pool, satoshis}` → `{validatorPubKey, nonce,
  signature}`, checked and written into the pool's state; one
  `createAction`: outputs [the pool] (a transfer to a foreign script), no
  inputs, no `inputPositions`, `randomizeOutputs: false`; the module selects
  the token inputs and adds the change. The wallet funds the sats (one spend
  prompt, one module prompt). The page submits the deploy to
  `tm_color_<assetId>` too, then files output 0 in `amm-pools`
  (customInstructions `{id, op: "amm-pool", sym, dec, protocolID, keyID,
  counterparty, amm: {role, validatorIdentity, lpFeeBps, validatorFeeBps,
  commissionBps, nonce}}`). (0.12.x: the page named a key input, input 0,
  and keyed the LP key by it.)
- **Swap, sats in.** The leg built here, the relay. 0.29.0: the leg's sats
  (amount in + 1 sat for the token payout + the miner fee) are ONE
  `amm-swap` output, staged by one plain createAction (no `p color` labels;
  a P2PKH to an `amm swap` key, filed in `amm-swap` with `{sats: true,
  assetId, protocolID, keyID, counterparty}`) before the legs; no funding transaction,
  no `1sat-deposit`. The token payout is locked to a module receiving key
  whose sender is the pool's ValidatorIdentity; accepted, the page takes it
  in through the module with its receipt.
- **Swap, tokens in.** Each leg spends `amm-swap` outputs carrying exactly
  its amount in (the contract takes no token change). The legs those do
  not cover get one output each, of exactly their amount, from ONE module
  send before the legs (a transfer out to `amm swap` keys; one module
  prompt; the page submits it to the token topic too and files the outputs
  in `amm-swap`); 0.29.0: the same send carries each uncovered leg's sats
  (one P2PKH output per leg of exactly its miner fee, filed in `amm-swap` by
  the createAction itself; the module passes a non-token output through).
  The legs are built and signed as before (`createSignature` under each
  output's key) and relayed; taking an accepted swap in marks its
  `amm-swap` inputs spent (no relinquishOutput); an output a failed leg did
  not spend stays there for a later swap (a sats output is reused by a leg
  needing exactly its amount).
- **Recover a position** (0.12.1, `src/lp/recover.ts`). A deploy whose
  `amm-pools` row was never filed (the deploy broadcast, the filing did
  not happen) is not in the positions list, so it cannot be closed there.
  Liquidity's Recover takes the pool's outpoint (`<txid>.<vout>` or
  `<txid>_<vout>`, the deploy's or a later continuation), follows it to its
  current output (`GET <base>/spends`), reads that output's BEEF from
  BRC-207's `color-spendability` at `ls_color_<tokenId>` (0.20.1; `ls_color {txid, outputIndex}` before) and decodes the pool. Its LP keyID is random and on no
  chain, so the keyIDs of the wallet's deploy history are tried (0.29.4: the
  `… · amm-lp <hex>` description of each `amm-pool-deploy` action's pool
  output, read through the manager with `listActions({labels:
  ["amm-pool-deploy"], includeOutputs, includeOutputLockingScripts})`, the pool from the output's script; the
  first source for Positions too); none: "not in this wallet's deploy
  history", nothing filed. Each candidate is checked with
  `getPublicKey` against the pool's LpPubKey. On a match it files the
  current output in `amm-pools` with `internalizeAction` (basket
  insertion, tag `amm-pool`, the deploy's `poolCustomInstructions`, label
  `amm-pool-deploy`). A pool the wallet already files is left alone.
  (0.29.1: the pre-0.13.0 LP keys, `lpKeyId` / `legacyLpKeyId`, are gone.)
  The row is then an ordinary position: Close as below.
- **Close** (0.13.0: `Close(lpSig)`, outputs free; 0.29.1: ONE path; 0.29.3: a
  module plan). ONE createAction through the wallet's BRC-207 module: a `p
  color plan` transfer whose owned output 0 is every token, one sat, to a NEW
  module receiving key of the user's own (`newReceivingKey`, sender the
  user's identity) — the module checks it pays the remittance's key and files
  it in `p color <assetTag>` with its custody in the same call; the pool an
  explicit input (`inputBEEF` the lookup's, `unlockingScriptLength` the
  call's), to the module a FOREIGN token input checked admitted and unspent
  on the token's overlay. No payout output: the pool's sats go to the
  wallet's change. The page fills the pool input (`callUnlock` + the LP's
  `createSignature` over the wallet's transaction) at signAction; the module
  approves and submits, the wallet broadcasts and marks the pool row spent.
  Nothing is taken in afterwards, nothing kept in the browser. A rescinded
  pool is shown as such and closes as any.
- **Move back** (Your tokens; 0.29.3: a module plan, the same shape). Every
  `amm-swap` token row of the token and the sats rows staged for its legs
  (their `assetId`) explicit FOREIGN inputs (`inputBEEF` from the basket,
  the page's unlocks at signAction); one output, the whole amount to a module
  receiving key of the user's own, the plan's owned output 0, filed by the
  module; the wallet's change takes the sats. Then the page's own submit to
  `tm_color_<assetId>`. A swap that got stuck comes back this way.
- **Payout keys** (0.29.1): a swap leg's payout key (the BRC-29 sats payment,
  or the BRC-207 receipt for tokens) and the taker's own commission key are
  derived from the leg's first staged `amm-swap` input `<txid>.<vout>`
  (tokens in: its first token row; sats in: its sats row):
  derivationSuffix = base64(sha256(UTF-8 of that text)), derivationPrefix =
  base64("amm swap") for the payout, base64("amm swap commission") for the
  commission.
- **Unfinished steps** (`wallet/pendingPayouts.ts`, 0.29.3): a to-do list in
  the browser, no key material. Only swaps write it, one entry per payout
  output: `{id, kind: "swap", txid (provisional until final), vout, tokenId,
  base, createdAt, final}`, written before the relay, cleared when the wallet
  accepted the take-in. Your tokens shows an "Unfinished" card while the list
  is not empty, one "Finish" per entry: the final transaction from the token
  instance's pools, the key re-derived from its inputs and checked against
  the output, the take-in; on failure the error inline, the entry kept; no
  automatic retry. Entries from before 0.29.3 (with their receipt or
  remittance, script and AtomicBEEF) are listed and finished once with their
  own bytes.
- **Manifest** (`www/manifest.json`, `web/ui/public/manifest.json`):
  baskets `amm-swap`, `amm-pools`, `p color assets` (0.29.0: no `1sat-deposit`); protocols BRC-29 to self,
  `[2, "amm swap"]` to self, identity, AuthFetch's two, the action labels;
  no spending authorization; no `p color` entry (the module asks for those).
  0.13.0 adds nothing (the deploy, Close and Recover use the labels
  `amm-pool-deploy` and `amm-close` as before).

## The listing (0.13.0)

`ls_amm_<assetId>` (programs/amm-lookup `listedAt`) lists a pool output when

- **(a) it attests itself** (src/pool.zig `affirmed`): not rescinded; its
  ValidatorPubKey equals the ValidatorIdentity's child keyed by its Nonce,
  derived by the lookup (not trusted); and its Affirmation verifies over
  message v2 under that key — a deploy; or
- **(b) it is a Swap's continuation of a listed pool** (`nextKeyOf`): the
  transaction spends a pool of this token in `pools` (`spent` runs after
  `admitted`, so it is still there) with an unlocking script whose last
  push selects Swap (`methodOf`), the output is at 0, not rescinded, carries
  the same ValidatorIdentity, and its ValidatorPubKey is the identity's
  child keyed by that spent outpoint (David Case 2026-10-22: the lookup
  checks the next key).

Nothing else is listed: a rescinded pool (ValidatorPubKey 33 zero bytes:
Rescind's continuation), a pool-shaped output a Close wrote (Close's
outputs are free; it is no Swap), a continuation naming another next key,
a deploy under a key of the LP's own (v0.11.0's defect: its signature
verified but the key was not derived). Only listed pools are indexed, and
every query answers listed pools only. A listed pool leaves the listing
when its output is spent with no listed continuation: the LP's Close, or
the validator's Rescind.

**The validator's Rescind** (0.13.0; it replaces 0.11.0's validator Close,
which replaced 0.9.0's rescind of the claim): root's message `{fn:
"rescind", args: {pool: "<txid>.<vout>"}}` in the box `amm/validator`,
gated by `roles: {root: ["rescind"]}`. amm-validator follows `pool` (any of
the pool's outputs, its deploy's among them) to its newest output (refused
when it is closed, or rescinded already) and has the instance's wallet
build the Rescind with the pool as a caller input (shruggr/skein#93):
`createAction` with the pool (`unlockingScriptLength` the longest the call
can be, its transaction's BEEF), the contract's one output (the pool's
sats, its script with the ValidatorPubKey zeroed), label `amm-rescind`,
`noSend` — the wallet adds its funding input and its change after it — a
draft; it writes the pool input's Rúnar call of Rescind over the draft
(`validatorSig` the pool's current validator key's, through the signer,
over the draft's BIP-143 preimage; the wallet's change as Rúnar's
`_changePKH` / `_changeAmount`); `signAction {reference, spends}`; then
submits it to its overlay for the token topic (the topic admits the
rescinded pool; `ls_amm_<assetId>` drops it) and answers root `{fn: "rescind",
request, result | error}`. Each wallet call is a thread of the genesis
wallet program (amm-validator `rescind.zig`).

**The LP's view** comes from the chain state by outpoint, not the listing:
the read `GET <base>/spends?outpoint=<txid>.<vout>` (amm-p2p, the chain
app's `spent` as the overlay reads it) follows the pool from its deploy to
its current output (each spender's output 0 while it is a pool — a
Rescind's included; `closed` once a Close spent it). The current output's BEEF comes from BRC-207's
`color-spendability` at `ls_color_<tokenId>` (0.20.1; `ls_color {txid, outputIndex}` before).


## Fees (0.33.0)

Each Swap pays three fees in the input asset (sats on a sats-in Swap, a 1Color value output on a
token-in Swap), each its own output (pool/Pool.runar.go `Swap`): the LP's to Hash160 of the pool's
LpPubKey, the validator's to Hash160 of its key, the commission to the call's `commissionPkh`.
Nobody sweeps them yet; a Close leaves them on chain.

`ls_amm_<assetId>` keeps a fee ROW per Swap, written when it admits the Swap's continuation and
removed when a rejection takes it back: under the pool's LpPubKey (the pool's id: constant along its
continuations, one per deploy) `{lp, validator, commission, bsvIn, commissionPkh}`, read by
src/pool.zig `feesOf` where the relay's pair check finds them (`feeLayout`); and, a commission not
0, a membership row under the commission's key hash. Queries are prefix scans and sums.

**Fee rows exist for Swaps admitted after 0.33.0 was installed.** Earlier Swaps have none: nothing
is backfilled or migrated.

The queries, every one naming its token (`tokenId`; programs/amm-lookup README, "Queries"):

| query | answer |
|---|---|
| `{tokenId}` | every live pool, `PoolState` shape plus `outpoint` |
| `{tokenId, outpoint, beef?}` | that pool or its newest continuation, `{current, hops}`; with `beef: true` the output-list form |
| `{tokenId, validatorIdentityKey}` | that validator's live pools |
| `{tokenId, poolIds: ["<txid>_<vout>"]}` (0.40.0, replaces `{lpPubKeys}`) | `[{poolId, lpPubKey, status, outpoint?, current?, sats, tokens, swaps}]`: the LP fees per pool (sats from sats-in Swaps, tokens from token-in) and its state: `live` (`outpoint`, `current` the `PoolState`), `rescinded` (`outpoint` and `current`: the Rescind's output and its pool state, what the Close takes back), `closed` |
| `{tokenId, validatorIdentityKeys: [<hex 33>]}` | `[{validatorIdentityKey, sats, tokens, swaps, pools}]`: the validator fees over all its pools' rows, closed included |
| `{tokenId, commissionPkhs: [<hex 20>]}` | `[{commissionPkh, sats, tokens, swaps}]`: the commissions paid to each key hash |

A list query answers one record per key, in order; an unknown key answers zeros (`status: "closed"`,
`pools` 0). Every one is prefix scans over the lookup's indexes (`byPool`, `byValidator`,
`byCommission`, `fees`), no scan of all pools. The pages (Liquidity) load the positions with
`{poolIds}` (0.40.0), once per token with all the wallet's pool ids for it: the state and the fees of each,
nothing read per position until the LP acts on one (Close, Recover).

## Prices (0.9.0)

David Case, 2026-10-09: "Pricing lives in the AMM LOOKUP's own beacon";
"beats are libp2p service discovery". `ls_amm_<assetId>`, configured at the
token instance's create (skein-overlay 0.17.0: a configured lookup beats on
`<service>-live` and keeps liveness on it), beats on `ls_amm_<assetId>-live` a body (dag-cbor) carrying, per token, this
skein's per-validator totals of its listed pools:

```
{tokens: {"<assetId>": {"<validator identity, hex>": {sats, tokens, pools}}}}
```

re-declared by a hook whenever it changes (the lookup keeps the last body's
record, `beat`; `Service.beat`) and answered by fn `beat` at the beacon's
declaration. The page reads `GET <base>/.live/ls_amm_<assetId>-live` (each live
skein's latest beat) and combines them: a token's price is Σsats / Σtokens
across the live validators (a validator is live when its own beat is held,
on `ls_amm_<assetId>-live` or the token's topic); one report per validator (its own
beat's, else the newest naming it). Polled every `REFRESH_MS`. A token no
beat reports is priced from this skein's own listing and liveness. The
topic manager's beat carries no prices.

0.34.0 (D6): the pages read no beats. A token's price comes from its pool list, the pools route
(`GET /@<token>/amm/pools`, the host's, held as an event stream; the landing page holds the
host-wide `GET /amm/pools`); the beat is the validator liveness filter only, applied by the host.

0.39.0 (D7): the landing page reads the host-wide stats `GET /amm/stats` once per load and every
30 s while the tab is visible (price, TVL, pools; no host-wide stream); the token's pools stream
sends the whole answer once, then one `change` per pool change, applied by the page to the answer
it holds.

## The public read API (0.34.0)

David Case, 2026-11-04 (agent-env plans/exchange-api-2026-11-04.md §0, D1–D25): the exchange's
public API is plain HTTP reads over the same index the overlay protocol (`/submit`, `/lookup`)
populates; nothing is removed from `/submit` or `/lookup` (D8). The route table, verbatim from the
build brief (agent-env plans/exchange-api-build-2026-11-04.md):

**The routes** (the whole public API after this build; cache classes: `state` = `Cache-Control: public, max-age=5`; `imm` = `public, max-age=31536000, immutable` ONLY when the bytes are of a proven (mined,
BUMP in chain state) transaction, else `state`; `stream` = `text/event-stream`, no cache)

| # | route | answered by | answer | class |
|---|---|---|---|---|
| P1 | `GET <origin>/amm/pools` | HOST (A) | `[{tokenId, …P2 row}]` over every enabled token | state + stream |
| P2 | `GET <origin>/@<token>/amm/pools` | HOST (A) | `[{lpPubKey, outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps, commissionBps, validatorIdentityKey, validatorPeerId}]` — ONLY pools whose validator is beating on `tm_color_<token>-live` now (peer ID from the beat's `from`) AND whose `commissionBps` ≥ the instance's market minimum; plus top-level `market: {commissionPkh, minCommissionBps}` and (0.34.1, David) `validators: [{identity, peerId}]` = the validators beating on the token's topic now (the pools filter unchanged) → answer shape `{market, validators, pools: [...]}` | state + stream |
| P3 | `GET /@<token>/amm/pools/beef?pool=id1,id2` (0.40.0: by pool id, `?lp=` gone) | amm-p2p (B) | `{pools: [{…P2 row without validatorPeerId}], beef: <base64 BEEF of the current pool txs>}`; no `pool` = every live pool | state |
| P4 | `GET /@<token>/amm/positions?pool=id1,id2` (0.40.0) | amm-p2p (B) via the lookup's `{poolIds}` answer | `[{poolId, lpPubKey, status: live\|rescinded\|closed, outpoint?, current?: {…P2 row}, sats, tokens, swaps}]` one per id in query order | state |
| P5 | `GET /@<token>/amm/fees/validator?id=k1,k2` | amm-p2p (B) via `{validatorIdentityKeys}` | `[{validatorIdentityKey, sats, tokens, swaps, pools}]` | state |
| P6 | `GET /@<token>/amm/fees/commission?pkh=h1,h2` | amm-p2p (B) via `{commissionPkhs}` | `[{commissionPkh, sats, tokens, swaps}]` | state |
| P7 | `GET /@<token>/amm/terms` | amm-p2p (B) | `{validator: {identity, peerId, lpFeeBps, validatorFeeBps, commissionBps, minLegSats} \| null, market: {commissionPkh, minCommissionBps}}` (the two `/call` answers in one, unsigned; 0.40.0: `minLegSats` the validator's minimum leg, sats, 0 none) | state |
| P8 | `GET /@<token>/amm/spends?outpoint=a,b` | amm-p2p (B) | `[{outpoint, spentBy?, current?, hops, closed}]` one per outpoint in query order (today's single form kept working) | state |
| P9 | `GET /@<token>/amm/tx?id=<txid>` | amm-p2p (B) | the transaction's Atomic BEEF with EVERY input's source in it, mined or not, the transaction itself without a BUMP (0.44.2, `txBeef`), `application/octet-stream`; 404 unknown or an input's source missing | imm |
| P10 | (0.44.0: gone — no swap records: the host relays, the instance logs facts, never attempts) | | | |
| P11 | `GET /@<token>/amm/token` | unchanged | | state |
| P12 | `GET <origin>/amm/tokens` | swap app (D) | rows gain `iconUrl` = `/@discovery/1color/<token>/icon` (origin-relative), the data-URL `icon` field GOES | state |
| P13 | `GET /@discovery/1color/tokens?ids=a,b` and paged `?limit=&skip=` | color-lookup (C) | rows `{tokenId, topic, sym, dec, iconUrl?, txid, vout}`; with `ids`: one row per id in query order, unknown = `{tokenId, listed: false}`; `iconUrl` RELATIVE to the list (`<token>/icon`) | state |
| P14 | `GET /@discovery/1color/<token>` | color-lookup (C) | `{tokenId, topic, sym, dec, txid, vout, iconUrl?}` | state |
| P15 | `GET /@discovery/1color/<token>/icon` | color-lookup (C) | the icon bytes with the deploy's media type; BRC-161 JSON deploy (icon = a string): 404 and the list/detail carry `iconUrl` = that string only when it is an http(s) URL | imm |
| P16 | `GET /@discovery/1color/<token>/deploy` | color-lookup (C) | the deploy's BEEF bytes, `application/octet-stream` | imm |
| P17 | `GET <origin>/.well-known/skein`, `/skeins?key=`, `/amm/admin`, `/amm/defaults`, `/amm/discovery` | unchanged | | state |
| P18 | `GET <origin>/api/openapi.json`, `<origin>/api/` | files in swap www (D) | the OpenAPI 3.1 document; the reference page | state |

List parameters are comma-separated; answers list one record per key in query order (D1). `/submit`,
`/lookup`, `/sendMessage`, `/call` (writes) and the `.live`/`.events` host reads stay as they are.

This app answers P3–P10 (amm-p2p, reads.zig; filters `poolsBeef`, `positions`, `validatorFees`,
`commissionFees`, `readTerms`, `spends`, `tx`, `swaps`); P4–P6 are the pool lookup's own list
answers (amm-lookup `answer`, the same code `/lookup` runs), P3's pools its `{poolIds}` records'
`current` (live, or a rescinded pool's output the LP's Close takes back) or, with no `lp`, its
`{tokenId}` rows. P1 and P2 (`/pools`) are the HOST's (it joins its liveness and the market's
minimum to the lookup's rows; D11, D13): no route of this app. The pages (web/ui) read only these
routes and the wallet; they send `/lookup` nowhere.

## The history reads (0.36.0)

David Case, 2026-11-05 (agent-env plans/history-api-2026-11-05.md, D1–D3, D6; build brief
plans/history-api-build-2026-11-05.md): the pool lookup writes ONE TRADE ROW per admitted Swap and
three plain reads answer from those rows, computed on read (nothing precomputed, no backfill: Swaps
admitted before 0.36.0 have no row).

**The trade row** (amm-lookup `putTrade`, where the 0.33.0 fee row was written; the fee row grew
into it): `{kind: "amm-trade", txid, lpPubKey, side, amountIn, amountOut, lp, validator,
commission, bsvIn, commissionPkh, bsvReserve, tokenReserve, at}` — `side` `buy` (sats in) or
`sell` (tokens in); `amountIn` the call's (the fees included), `amountOut` what the pool paid out
(the other asset's reserve before minus after); the three fees in the input asset; the reserves the
continuation holds after the Swap; `at` the admitting step's time in ms (the in-VM call input's
`now`, the time of the entry that drove the step: per host, replay-exact). Keys: `trades: tp ‖ at
(u64 BE) ‖ swap txid`, and the 0.33.0 `fees` / `byCommission` keys, all linking the one record. A
rejection removes it.

**The routes** (amm-p2p, filters `trades`, `candles`, `stats`; JSON; cache `state`; amounts integers
in base units; a price is `{sats, tokens}`: `sats` per `tokens` token units, exact, from one trade's
amounts — a buy `amountIn / amountOut`, a sell `amountOut / amountIn`):

| # | route | answer |
|---|---|---|
| H1 | `GET /@<token>/amm/trades?from=<ms>&to=<ms>&limit=<n≤500>&before=<cursor>&pool=<txid>_<vout>` | `{trades: [<row>], next: <cursor> \| null}` newest first, `from ≤ at < to` (both optional), `limit` default 100, `next` the last row's cursor when the page is full (hex of `at (u64 BE) ‖ txid`), `pool` one pool's rows (0.40.0, was `lp`); a row `{txid, poolId, lpPubKey, side, amountIn, amountOut, feeLp, feeValidator, feeCommission, bsvReserve, tokenReserve, payoutPkh, at, height}` (0.40.0: `poolId`, `payoutPkh` the call's `userPkh`), `height` where the overlay has the txid `placed` (its `<app>/state` map `placed`, written once the proof landed), else null |
| H1 | `GET /@<token>/amm/trades?txid=<txid>` | the one row; 404 none |
| H2 | `GET /@<token>/amm/candles?tf=1m\|5m\|15m\|1h\|4h\|1d&from=<ms>&to=<ms>` | `[{t, o, h, l, c, volumeSats, volumeTokens, n}]` one per NON-EMPTY bucket, oldest first, across all pools: `t` the bucket's start (a multiple of `tf` since the epoch), `o`/`h`/`l`/`c` prices, the volumes each side's amounts summed, `n` the trades; `from ≤ at < to`, both required; more than 5000 buckets, 400 |
| H3 | `GET /@<token>/amm/stats` | `{tokenId, lastTradePrice, change1h, change24h, volume24hSats, volume24hTokens, buys24h, sells24h, lastTradeAt, tvlSats, tvlTokens, pools}` at the read's time: `lastTradePrice` (0.40.0, was `price`; the host sets `price`) the last trade's, else null; the changes in bps (integers, truncated toward zero) from the last trade at or before the window's start, null without one; volumes and counts over the trades of the last 24 h; TVL the live pools' reserves summed; `pools` the live pool count |

## The pool id and the pool history (0.40.0)

David Case, 2026-11-05 (agent-env plans/swap-balance-build-2026-11-05.md §0 items 3, 4): a pool's
id is its deploy's outpoint, assigned by the pool lookup and copied forward at each admitted Swap;
the LP public key is a field on the pool and a lookup key nowhere. The lookup keeps the raw history
in the core index: one EVENT per deploy, Swap, close and rescind (`history`: `tp ‖ poolId ‖ at ‖
seq`, seq the pool's swap count for a deploy or a Swap and the swap count + 1 for a close or a rescind, so an end sorts after the last Swap at any time; `closes`: `tp ‖ at ‖ poolId` for the ends), each stamped with the admitting step's time; a
Swap's event is its trade row. Nothing derived is stored; the reads read only the window asked for
(skein-sdk 0.13.0's `Map.range` and `Map.floor`).

| route | answer |
|---|---|
| `GET /@<token>/amm/pools/at?t=<ms>` | `[{poolId, outpoint, bsvReserve, tokenReserve, lpPubKey, liquidityFeeBps, validationFeeBps, commissionBps, validatorIdentityKey, at, swaps}]`: every pool listed at `t` (candidates the live pools and the `closes` from `t` on; each pool's row its last event at or before `t`, a deploy's or a Swap's; a close or rescind there, or no event yet, no row), in pool id order; cache `state` |
| `GET /@<token>/amm/pools/history?from=&to=&pool=&limit=&after=` | `{events: [<event>], next}`: the events with `from ≤ at < to` (both optional) of one pool (`pool=<txid>_<vout>`) or of every pool the window touches, oldest first (time, then pool id, then event sequence), `limit` 1 to 500 (default 500); forward paging: `after=<cursor>` the rows strictly after that position, `next` the last returned row's cursor (opaque: 104 hex characters, `at (u64 BE) ‖ poolId (36) ‖ seq (u64 BE)`) when more rows remain in the window, else null; an event `{kind, txid, poolId, outpoint?, bsvReserve?, tokenReserve?, lpPubKey, liquidityFeeBps, validationFeeBps, commissionBps, validatorIdentityKey, at, swaps}`, a Swap's also `{side, amountIn, amountOut, feeLp, feeValidator, feeCommission, commissionPkh, payoutPkh}`; cache `state` |

## Interfaces

**Overlay** (base URL `<handle>.<host>/amm`):

| route | what |
|---|---|
| `POST /submit` | BRC-22 (`X-Topics` a registered topic): the request waits on the submission and answers the STEAK; 400 for a BEEF that does not verify or a rejected transaction; 503 + Retry-After while undecided (skein-overlay 0.9.1; 0.7.3–0.9.0 answered `{id}`) |
| `POST /lookup` | BRC-24: `ls_amm_<assetId>` (0.21.0) `{tokenId}`, `{tokenId, outpoint, beef?}`, `{tokenId, validatorIdentityKey}` (listed pools only); 0.33.0: `{tokenId, poolIds}` (0.40.0, was `{lpPubKeys}`), `{tokenId, validatorIdentityKeys}`, `{tokenId, commissionPkhs}` (the fee rows, "Fees" below); a token instance's `ls_color_<assetId>`; the discovery instance's `ls_color` (skein-1color README; 0.20.0) |
| `GET /requests` | amm-p2p `requests` (0.9.0): the holders' listing requests not yet registered, newest first, `[{tokenId, from, at}]`; a read. The config app's in 0.17.0; removed in 0.19.0 |
| `GET /spends?outpoint=<txid>.<vout>` | amm-p2p `spends` (0.9.0): the chain state of an outpoint, a pool followed to its current output, `{outpoint, spentBy?, current?, hops, closed}`; a read |
| `GET /listTopicManagers`, `/listLookupServiceProviders`, `/getDocumentationFor…` | the listings (each program's `metadata` / `documentation`); reads since 0.5.0 |
| `GET /.live/tm_color_<txid>_0-live` | the runtime's liveness read (skein #138, no program): `[{sender, at, body, from}]` newest first, the beats within the window (`body` the topic's view digest; the validator is `sender`, its peer ID `from`); 404 when the app keeps no liveness for the topic (the topic not registered) |
| `GET /color/tokens` | color-lookup `tokens`: the token list, `{limit?, skip?}` → `[{tokenId, topic, sym, dec, icon?, txid, vout}]` (`icon` a 1Color deploy's embedded image as a data URL, skein-1color 0.9.0); a read (0.6.0) |
| `POST /call` | amm-p2p: `{fn, args}` for the two interfaces below |
| `GET /…` (prefix `/`) | amm-p2p `serve`: the pages, `www/` of the app's own tree (skein-sdk `files.serve`); a read since 0.5.0 |

A token id in a query is any form (`<txid>`, `<txid>_<vout>`, `<txid>.<vout>`); the pages write every token id as `<txid>_<vout>`, 1Color and legacy BSV-21 alike, `_0` included (BRC-162 "Token identification"; 0.7.1, David 2026-10-07), and show outpoints as `<txid>.<vout>` (0.6.3, David 2026-10-08), while `ls_amm_<assetId>`'s `outpoint` and the relay's take `<txid>_<vout>`.

Which of these is a read and which a route with a handler is "Read routes",
below. `GET /live` is gone (0.5.0; it answered 410 from 0.4.0).

**Box `amm/register`** (the manifest's `"register"`, relative to the app,
shruggr/skein#128): the engine's `register {topic, program}`, `deregister
{topic}`, `registerLookup {service, program, topics?}`, `deregisterLookup
{service}` (skein-overlay 0.11.0: a token is its topic `tm_color_<assetId>`
and its lookup `ls_color_<assetId>`, BRC-207), from root (`roles`, 0.7.0). skein-overlay 0.7.7+ takes them in this box only
(0.7.5–0.7.6: `amm/overlay`).

**Box `amm/submit`** (the manifest's `"submit"`, `kernel.beef`): the
engine's `submit {beef, topics, offChainValues?}` from anyone (the
validator's own submissions among them) and `POST /submit`'s submission
event (skein-overlay 0.7.6), answered to the sender in this box; `register` / `deregister` here are refused (`bad-args`).

**Box `amm/amm-p2p`** (a message `{fn, args}`, skein docs/APPS.md §4; the
box `amm` before 0.7.0), and the route `/call` (a signed request):

| interface | functions | from |
|---|---|---|
| `amm.swap/1` | `submit` (writes), `status`, `terms` (`{commissionPkh, minCommissionBps}`; 0.16.0: the pkh derived, the minimum the record `amm/market`, 0 when unset) | anyone (root too) |
| `amm.pool/1` | `terms` (0.9.0: `{validator, peerId?, lpFeeBps, validatorFeeBps, commissionBps}`, this skein's validator and its terms; 0.15.0: the record `amm/terms`, or the error "no validator here" when none is set), `affirm` (0.13.0: `{pool: bytes, satoshis: int}` → `{validatorPubKey: bytes, nonce: bytes, signature: bytes}`, or the refusal `<reason>[: <detail>]`; no writes; 0.11.0–0.12.x: `{pool, satoshis, keyInput}` → `{signature}`) | anyone |

`amm.liquidity/1` is gone (0.9.0, with AddLiquidity); `amm.pool.submit` and
`amm.pool.status` (0.9.0's delivered deploy) are gone (0.11.0).

**Box `amm/validator`** (0.11.0): root's `{fn: "rescind", args: {pool:
"<txid>.<vout>"}}` (0.13.0; `close` before) → amm-validator (above, "The
validator's Rescind"), answered `{fn: "rescind", request, result | error}`
to the sender in this box.

**Box `amm/requests`** (0.9.0): a holder's listing request, `{fn:
"request", args: {tokenId}}` from anyone → amm-p2p, recorded under the head
`amm/requests` (the latest per token); nothing else runs. Settings reads
them with `GET /requests`; registering the token settles its request.
Removed in 0.19.0 (David Case 2026-10-29: a holder's request to list a
token is not part of Open Exchange; a marketplace host adds its own).

**Box `amm`** (derived): the engine's own `watch`, `resume`, `wait` (from
the instance itself) and, as an event route, the libp2p routes' admits.

**The swap relay is the HOST's** (0.44.0, David Case 2026-11-06: "the
instance logs facts, never attempts"; `amm.swap.submit`, `amm.swap.status`,
the swap records under `amm/app` and `/swaps` are gone). The page posts the
funding transaction and the swap, the pool, and the validator it names
(`validator`, its identity key, and `peerId`) to the open-exchange host's
plain route `POST /@<token>/amm/swap`. The host checks one rule, the
exchange's commission (amm-p2p README "The commission rule"), signs the
validator's package with the token instance's key outside any step, carries
it on one libp2p stream (one request frame, one answer frame) — or, when
`peerId` is its own node, hands it in as that node's inbound frame — and
answers the page with the validator's reply, after submitting a `beef` it
carries to the token instance's overlay. Any break fails the request at
once, named; when the page's request closes the host stops (no dial
continued, nothing unwritten written). Nothing is logged on the taker's side
but that overlay submission.

`amm.pool.affirm` is not relayed: amm-p2p packages the request (box
`affirm`, from this instance to itself) and calls its own amm-validator's
fn `affirm` in-VM, which answers at once.

**libp2p**: `/amm-validator/1/swap` (0.9.0: `/addLiquidity` gone; 0.11.0:
`/deploy` gone) (amm-validator; one signed-message package per frame); the engine's
`<topic>` (the engine's `admit` verdicts, read by the host, which fetches the
BEEF from the announcer: skein-overlay 0.20.0; submit and admit messages
before) and `-proof` (every proof, a reorg's too) for each registered topic; `tm_color_<txid>_0-live`,
beaconed by a validator's host and subscribed, without admitting anything,
by a market's liveness tool (below); `ls_amm_<assetId>-live`, the AMM lookup's beat
(the prices, above), its name configured at the create (0.21.0); `/skein/overlay/sync/1.0.0`,
the overlay sync protocol, answered by the engine's filter `sync` (0.14.0);
`/skein/overlay/beef/1.0.0`, the engine's receive row, the BEEFs the host
fetches (0.14.1; 0.24.1: the host's own entry, never served to peers).

**Box `amm/amm-p2p`** (also, until 0.44.0): the cron provider's ticks for the catch-up pass — gone in 0.44.1 (no tick, no pass, no `config.amm.ammP2p`).

**Market and validator, always** (0.6.0, shruggr/skein#120; 0.8.1,
skein-overlay 0.12.0). David, 2026-10-09: "every skein is marketplace AND
validator from install, always". Two roles of the engine, never off; the
owner's switch of 0.6.2 (skein-overlay 0.9.2, `{fn: "market" |
"validator"}` in `amm/register`, kept in `amm/topics`) and the Token topics
page's Market and Validator switches are gone. `config.overlay.market:
{window}` / `.validator: {every}` give the ms (this manifest sets neither:
40 000 / 30 000). (0.8.1's Validator page is gone with the 0.9.0 pages.)

The engine, on `register {topic: "tm_color_<txid>_0", program: "color-topic", seed: ["<txid>"]}`
(box `amm/register`, from root): subscribes the topic and seeds; emits
`{event: "liveness", topic: "tm_color_<txid>_0-live", window}` and
`{event: "beacon", topic: "tm_color_<txid>_0-live", every, body}` — the
frame carries the sender's identity key and the gossip message the peer
id; the body is the topic's view digest `{view: {count, digest}}`
(skein-overlay 0.12.0), re-declared when it changes. `deregister` reverses
both (`unliveness`, `unbeacon`). A start or a re-read emits nothing: the
intents stand in the log.

- **The validator.** amm-validator signs swaps and affirms an LP's
  proposed pool at its terms (above, "The deploy and the affirmation")
  — for any token whose topic is in the engine's registered set (the head
  `amm/topics`; always, 0.8.1); otherwise every
  `swap` and `affirm` is refused `{ok: false, reason:
  "not_validating", detail}` before anything is checked or signed. It reads
  the set at each call. Each beat is the host's signed
  frame (docs/MESSAGES.md "Beacons"): dag-cbor `{body, at, sender,
  signature}`, `body` the topic's view digest, `sender` the instance's identity key; the
  gossip message's peer is the node's peer ID, derived from the instance's
  root (`[2, "skein instance"]`, key ID `libp2p:<handle>`, counterparty
  self; skein signer.ts `peerKey`).
- **The market.** The runtime's liveness tool subscribes `tm_color_<txid>_0-live`
  without admitting its messages (no entry, nothing logged), verifies each
  beat's signature against `sender`, and keeps the beats newer than
  `window`, the latest per sender, with the node's own published beats, in
  memory; it serves them at `GET <base>/.live/tm_color_<txid>_0-live` → `[{sender,
  at, body: <base64>, from: <peer ID>}]` newest first (404 when no liveness
  is kept). The window is a margin over the beat (40 s against 30 s).
- **The page** reads that endpoint per token, takes each beat's `sender`
  (the validator) and `from` (its peer ID), plans (`market/plan.ts`) only
  over the pools whose validator is there, and names the chosen one in the
  swap (`validator` and `peerId`); the prices combine the `ls_amm_<assetId>-live`
  beats over the live validators (above, "Prices").

Gone in 0.6.0: `validate` / `unvalidate` (the box `amm/validate` and its
row), amm-p2p's validated set (the record's `validated` under `amm/p2p`),
its `beacon` / `liveness` emits and their bookkeeping (the maps `beacons`,
`subscriptions`), its start / stop and the cron fallback's heartbeat, and
`config.amm.ammP2p` (`market`, `heartbeatSeconds`, `offlineSeconds`:
`validator.every` is the beat, `market.window` the offline threshold).
Per-token permissioning is a later refinement: "if we needed that kind of
split, we would split it across multiple skeins".

## The manifest

0.17.0 (shruggr/skein-amm#4): two apps, both `amm`. `etc/app.json` is the
**token app**, run as one instance per token id (its topic, lookups and
initial values in its config at birth, "The config instance" below);
`apps/config/etc/app.json` the **config app** (below). The token app as of
0.17.0: no `register` box and no `roles.root` `register`,
`registerLookup`, `deregisterLookup` (the engine's functions remain; no
route reaches them; topics registered by an earlier version stay served);
no pages (the `/` read, the filter `page`); no holders' requests (the box
`requests`, the read `/requests`, the filter `requests`: the config app's
in 0.17.0, removed in 0.19.0).
`config.overlay.topics` and the per-token lookups (`ls_amm_<assetId>`,
`ls_color_<assetId>`) come from the create's config; 0.21.0: the manifest
declares no lookup (`config.overlay` is `{}`: skein derives the engine's
routes — the box `amm` as event and mailbox, `/submit`, `/lookup` — from
the manifest's own `config.overlay`, so it stays, empty, 0.21.1; `ls_amm`
was its default lookup until 0.20.1); `config.overlay.terms` (skein-overlay 0.17.0) and
`config["amm-p2p"].market` are the initial terms and market minimum, read
when the heads `amm/terms` / `amm/market` are unset (a record there, its
`null` included, wins). amm-validator signs for every topic the engine
serves, configured or registered.

Until 0.16.3, `etc/app.json`: the six programs; `config.overlay` with no topics and the
lookups `ls_color`, `ls_color_deploys` (both `color-lookup`) and
`ls_amm` (`amm-lookup`), none with a `topics` list, so each listens to every
topic served; gossip on (the default); no `market` or `validator` (0.8.1:
both always on, at the defaults 40 000 / 30 000 ms; 0.6.0–0.6.1 set
`market: {window: 40000}` and `validator: {every: 30000}`, 0.6.2–0.8.0 had
root's switch); no `config.amm` (0.16.0: `commission`, the relay's
commission pkh, is gone, the key derived, "The commission key" above; 0.9.0
to 0.14.2 also `ammValidator`, the validator's terms, and before 0.9.0 the
bounds `minValidatorFeeBps`, `maxLpFeeBps`, `maxCommissionBps`: 0.15.0
moved the terms to the runtime record `amm/terms`, "The terms" above); `provides` the two `amm.*` interfaces (`amm.swap.terms`; 0.44.0: no
`amm.swap.submit` / `status`; `amm.pool.terms`, 0.9.0;
`amm.pool.affirm`, 0.11.0, in place of `amm.pool.submit` / `status`;
0.13.0: `{pool, satoshis}` → `{validatorPubKey, nonce, signature}`);
`requires: ["chain/1"]`; no `start` / `stop` (0.6.0). No
`config.overlay.terms` (skein-overlay 0.16.0 no longer reads it: the beat's
`terms` is the record `amm/terms`); `roles.root` `register`,
`registerLookup`, `deregisterLookup`, `rescind`, (0.15.0) `terms` and
(0.16.0) `market` (0.17.0: `rescind`, `terms`, `market`).

### Routes

shruggr/skein#143 (0.7.0): a route names a transport, an address, its
filters and a handler; no sender. Mailbox addresses are relative to the app
(shruggr/skein#128: `"x"` is the box `amm/x`); one route per box. Who may
run a function is `roles`: `{"root": ["register", "registerLookup", "deregisterLookup", "rescind"]}`.

1. `register` → `overlay.register` (register / deregister and
   registerLookup / deregisterLookup; root's: any other key's message is recorded and runs nothing) — gone in 0.17.0
2. `submit`, `kernel.beef` → `overlay.submit` (submissions by message from
   anyone whose BEEF validates; the validator's own among them; skein-overlay 0.7.6)
3. `amm-p2p` → `amm-p2p` (the relay's interfaces by message, `{fn, args}`,
   answered to the sender in that box; the cron provider's ticks). Before
   0.7.0 the relay's message path was the app's box `amm` (a row from `*`
   after the engine's `event` and `$self` rows); since #143 a box has one
   route, and `amm` is the engine's (its own watch, resume and wait), so the
   relay took its own box.
4. `validator` → `amm-validator` (0.13.0: root's `rescind`, and the steps
   of its thread; 0.11.0–0.12.x: `close`; 0.9.0–0.10.2: the claim's `rescind`)
5. `requests` → `amm-p2p` (0.9.0: a holder's listing request, anyone) — the config app's in 0.17.0, removed in 0.19.0
6. http `/call`, `kernel.brc104` → `amm-p2p.call` (a signed request; the
   caller is its key)
7. libp2p `/amm-validator/1/swap` → `amm-validator.swap` (refused
   `not_validating` for a topic not registered; `/addLiquidity` gone, 0.9.0;
   `/deploy` gone, 0.11.0: `affirm` is called in-VM only)
8. libp2p `/skein/overlay/sync/1.0.0`, no handler, the filter `sync` →
   `overlay.sync` (0.14.0, skein-overlay 0.15.0, shruggr/skein#154): a
   peer's catch-up frames (the locator, the admitted lists by height
   range, a transaction's Atomic BEEF), answered by the engine through the
   front door, a read, nothing logged
9. libp2p `/skein/overlay/beef/1.0.0`, `kernel.beef` → `overlay.submit`
   (0.14.1, as in skein-overlay's own manifest): the host hands each
   Atomic BEEF it fetches (on a peer's admit, from a peer's tail list, in a
   pull) to this row, as from the peer it came from; it is the host's own
   entry, not served to peers (0.24.1, skein-overlay 0.20.0); without it
   the host refused every one ("no route for
   libp2p:/skein/overlay/beef/1.0.0")
10. event `deploy`, `kernel.beef` → `amm-setup.deploy` (0.22.0,
    shruggr/skein-amm#5, skein #164): the token's deploy, the door's
    envelope in the record ("The token's setup")
11. the read routes, below

then, derived by the install from `config.overlay`: the box `amm` as an
`event` route and a `mailbox` route → `overlay` (gossiped submissions,
peers' admits; the engine's own watch, resume, wait), http `/submit`
(`kernel.beef`) → `overlay.submit`, and the read route `/lookup` (the
filter `lookup`, `overlay.lookup`).

### Read routes

An http route with no handler is a **read**: its filters run over the
request and the last one answers (`{answer: {status, type, body}}`), any
method, signed or not, **no entry, nothing logged** (a function that
writes fails inside the call). Exact paths match before a prefix, so
`/call`, `/submit` and `/lookup` are taken before the read `/`.

| path under `/amm/` | route | filter → program, fn | since |
|---|---|---|---|
| `/submit` | handler (derived), `kernel.beef` | → `overlay.submit` | |
| `/call` | handler, `kernel.brc104` | → `amm-p2p.call` | |
| `/lookup` | read (derived) | `lookup` → `overlay.lookup` | skein #135 |
| `/listTopicManagers`, `/listLookupServiceProviders` | read | `listTopicManagers`, `listLookupServiceProviders` → `overlay.<the same>` | 0.5.0 (http rows before) |
| `/getDocumentationForTopicManager`, `/getDocumentationForLookupServiceProvider` | read | `topicDocumentation`, `lookupDocumentation` → `overlay.<the same>` | 0.5.0 (http rows before) |
| `/` (prefix) | read, `root: "www"`, `index: "index.html"` | `page` → `amm-p2p.serve` | 0.5.0 (an http row before); the config app's in 0.17.0 |
| `/color/tokens` | read | `tokens` → `color-lookup.tokens` | 0.6.0 |
| `/requests` | read | `requests` → `amm-p2p.requests` | 0.9.0; the config app's in 0.17.0; removed in 0.19.0 |
| `/spends` | read | `spends` → `amm-p2p.spends` | 0.9.0 |
| `/token` | read | `token` → `amm-setup.token` | 0.22.0 |
| `/pools/beef`, `/positions`, `/fees/validator`, `/fees/commission`, `/terms`, `/tx` | read | `poolsBeef`, `positions`, `validatorFees`, `commissionFees`, `readTerms`, `tx` → `amm-p2p.<the same>` | 0.34.0 ("The public read API"; 0.44.0: `/swaps` gone) |
| `/trades`, `/candles`, `/stats` | read | `trades`, `candles`, `stats` → `amm-p2p.<the same>` | 0.36.0 ("The history reads") |
| `/color/` (prefix) | read | `colorToken` → `color-lookup.token` (skein-1color 0.15.0: `/color/<tokenId>/holders?limit=&skip=` → `{count, rows: [{address, balance}]}`, the token's holders from color-lookup's balance table) | 0.37.0 |
| `/.live/tm_color_<txid>_0-live`, `/.live/ls_amm_<txid>_0-live` | the runtime's liveness read (no program, skein #138) | | |
| `/live` | gone | | 0.5.0 (410 in 0.4.0) |

amm-p2p's `serve` reads only (the head `amm/app` and the tree's blobs);
called as a filter it answers `{answer: <the page>}` (0.7.0).

**At the origin's root** (0.9.0: the landing at `/`, shruggr/skein#147):
root adds a root route to the same filter (skein-overlay README "Root
routes": root's own route, no `app`, outside `/<app>/`); the pages served
there take `<origin>/amm` as the app's base (0.8.1). No skein change is
needed:

```
skein routes add --transport http --prefix --filters amm.page --settings '{"root":"www","index":"index.html"}' / <origin>
```

## The token's setup (0.22.0)

shruggr/skein-amm#5 (David 2026-10-29/30): the token instance's token is
an event, not a config at birth. The event route `deploy` (box
`amm/deploy`) names `kernel.beef`, so the record `{kind: "deploy", beef}`
enters only if its BEEF checks against `chain/state` (skein #164, docs/VM.md
"The door"); the step reads the bytes back from the envelope
(`chain.record.wireOf`).

`amm-setup.deploy`, in one step:

| | |
|---|---|
| the deploy | the subject's first output that deploys (`src/deploy.zig` `deployIn`, over `color.bsv21.tokenOf`): output 0 for a BRC-162 deploy, the first deploying inscription for a BRC-161 one |
| `amm/token` | `{tokenId, topic, lookup, ammLookup, sym, dec, icon?, txid, vout}`, written once |
| the registrations | the engine called in-VM: `register {topic: tm_color_<id>, program: "color-topic", seed: [<txid>]}`, `registerLookup {service: ls_color_<id>, program: "color-lookup", topics: [tm_color_<id>]}`, `registerLookup {service: ls_amm_<id>, program: "amm-lookup", topics: [tm_color_<id>]}`; a refused one fails the step |
| the deploy admitted | the seed judges what the chain app holds; a deploy not held (`missing`) is sent to the engine, `{fn: "submit", args: {beef, topics: [tm_color_<id>]}}` in `amm/submit`, from the instance to itself |
| refused, nothing written | `amm/token` exists; not a deploy event; no door envelope; no deploy in the subject |

`GET /amm/token` answers the record (404 before the event).

## The config instance (0.17.0)

**0.23.0: moved.** The config app (`apps/config`, `programs/amm-config`,
`image/config`) is now shruggr/open-exchange's swap app, changed there:
root's decisions are facts emitted as events the Open Exchange host reacts
to (shruggr/open-exchange#1, shruggr/skein#164); no instance manager. This
section describes 0.17.0–0.22.1 as they were.

shruggr/skein-amm#4 (David Case 2026-10-27/28): one token instance per
token id, from one token image, all on one one-key host (one key, one
libp2p node); the handle is the token id (`/@<tokenId>`), its topic
`tm_color_<tokenId>`, its lookup `ls_color_<tokenId>`. Standing one up is
one `create` of the host's instance manager carrying the deploy's BEEF
(skein's `create {handle, image, config, beef}` → `{handle, identity, url,
delivered}`). The config instance owns the enable list, emits the creates,
starts and stops, holds the defaults, and serves the pages. (The holders'
listing requests it held in 0.17.0–0.18.x are removed in 0.19.0.)

`apps/config/etc/app.json`: the program `amm-config`
(`programs/amm-config`, Zig over skein-overlay's `sk`, as the other
programs; `apps/config/bin/amm-config.wasm`); `requires: ["chain/1"]` (the
door's `kernel.beef` on `admin` reads `chain/state`); `config["amm-config"]
.tokenImage` (default `amm-token`); `roles.root` `enable`, `disable`,
`defaults`.

| route | what |
|---|---|
| mailbox `admin`, `kernel.beef` → `amm-config` | root's `enable {tokenId, beef}`, `disable {tokenId}`, `defaults {terms?, market?}`, (0.35.0 pages; open-exchange 0.12.0's swap app) `terms {tokenId, terms: {lpFeeBps, validatorFeeBps, commissionBps} \| null}` → the event `token-terms {tokenId, terms}`, which the host sends to the token's instance as root's `terms` in `amm/validator`, each answered in `amm/admin` `{fn, request, replyTo, result \| error}` |
| http `/tokens`, read (`tokens`) | the enable list `[{tokenId, topic, sym, dec, icon?, status, url?, since, reason?, delivered?}]`, newest first |
| http `/defaults`, read (`defaults`) | `{terms?, market?}` |
| http `/` prefix, read (`page`), `root: "www"` | the pages |

State: `amm/tokens` (`{kind: "amm-tokens", tokens: [<row>]}`, status
`creating` → `enabled` / `failed`; `stopped`; `starting`), `amm/defaults`
(`{kind: "amm-defaults", terms?, market?}`).
A message whose body names a `request` or `replyTo` is an answer (amm-config's
own, looped back when root's key is the instance's own on a one-key host):
nothing runs. amm-validator does the same with its answers to root (0.17.0).

The pages (served by the config instance): the token list from `GET
<config>/amm/tokens`; everything per token at `<url>/amm` of that token's
row (`tokenBase`): its pools, prices (one `ls_amm_<assetId>-live` read per token
instance), liveness, `/call`, `/submit`, `/spends`. No read crosses
instances. Settings: Enable a token (2026-10-31: one list, one Enable per token — the tokens on
discovery and in the connected wallet not on the list yet; the deploy's BEEF from the wallet's
module basket, else discovery's `ls_color` `color-admission` lookup at the host root), the enabled list with Disable / Enable again, the
Default validator terms and Default market minimum cards; a token's own
terms (0.35.0): each enabled row reads its `GET /@<tokenId>/amm/terms` (P7) once
on load and shows `LP <n> · validator <n> · commission <n> bps` or "market
only"; Edit opens the defaults card's three fields with Save (`terms
{tokenId, terms}` to swap's `amm/admin`) and Market only (`terms: null`), then
re-reads `/terms` until it shows the change or 10 s pass ("sent, not applied
yet").

## Not wired

- **The enable's BEEF is not checked at the config instance's door when
  root posts it by HTTP `/sendMessage`** (0.17.0, found in the acceptance):
  skein's front door admits such a message without running the `admin`
  route's filters (`kernel.beef` runs for a carried `local` message); the
  BEEF reaches amm-config as bytes. The token instance's door (its libp2p
  receive row) checks it when the host delivers it: a BEEF it turns away
  is reported in the row (`delivered`).

- **Pools deployed before 0.13.0, on chain.** amm-lookup and
  amm-validator know layout 2 only: a layout-1 pool still listed stays in
  `pools` until it is spent (the spend drops it), its Swap continuations
  are not listed, and the validator does not sign its swaps (`not_a_pool`)
  or rescind it. The pages close and recover it (the contract's own Close,
  the LP key from its deploy's input 0).
- **Recovering a 0.13.0 pool from another wallet.** Its LP keyID is random
  and named only in the deploying wallet (its row, and since 0.29.3 its
  deploy's pool output description): another wallet cannot recover it. The
  validator can still Rescind it.

- **A paused submission asks nobody** (skein-overlay 0.20.0, the settled
  sync design): it resumes when its parent arrives by any path — a later
  submission, a BEEF the host fetched on a peer's admit or from a peer's
  tail, a pull of mined history.
- **`tm_color_<txid>_0-live` for an unregistered token.** Liveness is
  kept for a registered topic (every skein a market, 0.8.1); for a token
  not registered here the `.live` read answers 404 and its Swap page plans
  nothing.
- **Catch-up and proofs by block.** Never specified; sync is the host's
  announce-then-fetch, pull and tail reconcile (skein-overlay 0.20.0). The `/amm/proofs/1.0.0` row is gone and no
  start schedules a catch-up pass; 0.44.1: the pass is gone, the serving side
  (`proofsByBlock`) stays as a utility.
- **A setting changed after a register.** The roles' events are emitted at
  `register` / `deregister` only (the
  intents stand in the log; root's switch is gone, 0.8.1): a market window or a beat changed by a
  reinstall applies to the topics registered after it; a topic registered
  before keeps its standing liveness and beacon (deregister and register it
  again). An instance upgraded from 0.5.0 keeps
  the beacons and liveness amm-p2p emitted then (keyed by app and topic, as
  the engine's are; a register of a topic registered already emits nothing,
  so deregister and register it to replace them). Their beats still carry
  0.5.0's body, which the page no longer reads.
- **Governance per token** (#120 item 4) and the other 1Color queries:
  skein-1color docs/1COLOR.md "Not built".
- **The AMM lookup's beat** (0.21.0): `ls_amm_<assetId>` is named in the
  token instance's create, a configured lookup, and beats on
  `ls_amm_<assetId>-live` (skein-overlay 0.17.0). A token instance created
  before 0.21.0 serves `ls_amm` until its config names the new name (an
  install with `--config`, then a disable and enable for its `topics`); a
  token no beat reports is priced from this skein's own listing.
- **The admin, as the page sees it** (0.28.0; open-exchange 0.5.0). swap is
  born owned by the host's key (root). `isRoot` (the name kept): the
  wallet is swap's claimant (`GET <swap>/amm/admin` → `{claimant, since}`)
  or holds root on swap (the host's `GET <origin>/skeins?key=<wallet key>`
  names swap's identity). While `/amm/admin` names nobody, Settings shows
  the card "Claim this exchange" (alone for a non-admin, above the admin
  cards for root): the wallet's `{fn: "claim"}` in box `amm/claim` to swap;
  swap records the first claim and the host grants its sender the role
  `amm.admin` (not root); a later claim is refused. A swap with no
  `/amm/admin` (pages before open-exchange 0.5.0): claimed as its
  `/.well-known/skein` says.
- **Positions from the deploy history** (0.28.0). `listOutputs` answers
  spendable outputs only, so a pool output the LP's own wallet spent (a swap
  against its own pool) left no row: Positions also read the wallet's
  `listActions({labels: ["amm-pool-deploy"], includeOutputs: true})` and
  take every output filed in `amm-pools` as a pool row, deduped with the
  basket's, each followed by `/spends` as before; Recover tries those rows'
  LP keys (0.29.4: from the pool output's description; nothing in the browser).
- **Unfinished steps.** A swap payout the wallet did not take in at once is
  listed in the browser (`wallet/pendingPayouts.ts`, no key material since
  0.29.3) and finished from Your tokens' "Unfinished" card.
- **Spends the chain app records of a transaction never submitted to the
  topic** (a pool spent by a transaction that bypassed the overlay): the
  listing does not fold them out (skein-overlay 0.12.1 "Beats"); the LP's
  page reads them (`/spends`).
- **Run end to end.** The programs are tested natively and the pages
  against fakes. 0.13.0's deploy depends on the BRC-207 module supplying the
  input BEEF of the token inputs it selects (color-permission-module 0.1.1,
  in progress), not tested here against a live wallet.
