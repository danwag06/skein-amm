# Changelog

Released versions of skein-amm. 0.10.0 is the first entry here; the notes
on earlier versions are below as the README carried them at 0.9.1, in the
names of their time, and each release commit names what changed.

## 0.29.1 (2026-11-02)

Pages only (web/ui). David's corrections to 0.29.0, decided 2026-11-02.

- **Close has ONE path: the wallet createAction**, for every pool. The
  page-built close (`bsvFee` > 0, the fee left from the pool) is gone, and
  with it the `bsvFee` number, the Close card's fee field and its help text
  (the card now says the wallet pays the miner fee), `CloseRequest.bsvFee`,
  `CloseResult.tokensTo`, `PreparedClose.walletBuilt` / `version` / `tokens`,
  `CloseInput.satsPerKb`, `LEGACY_FEE` and `LEGACY_LP_KEY` (a non-BRC-29 LP
  key is refused as "not a BRC-29 key to self"). Every sat of the pool goes
  to the LP's BRC-29 payout; the tokens to a module receiving key.
- **Layout 1 (pools before 0.13.0) is dropped** (decided 2026-10-22; every
  testnet pool is layout 2). `src/pool`: the v1 artifact
  (`pool.v1.artifact.json`, `poolArtifactV1`) is deleted, `PoolVersion` is
  `2`, `decode` matches layout 2 only (a layout-1 script, the testnet's
  AMM1 pool included, is no pool), `Pool.affirmation` (the v1 payload) is
  gone, `planClose` / `close` take the LP's `outputs` only (no `bsvFee`, no
  `Close(sig, bsvFee)` arguments). `src/lp/recover.ts`: the walk back to a
  v1 deploy's input 0 (`keyInputCandidates`, `findLpKey`), the pre-0.13.0 LP
  keys (`lpDerivation`, `lpKeyId`, `legacyLpKeyId`, `LP_KEY_PREFIX`, the
  `P1SAT_PROTOCOL` keys), `keyInput` and the `notMine` / `noDeploy` notices
  are gone: the deploy history's keys, then the browser's kept keys.
  Positions: no `legacy` flag; the Close card's "tokens land in the swap
  basket" text is gone.
- **Move back sweeps the token's sats rows.** Sats rows now name the token
  whose swap staged them (`{sats: true, assetId, …}`; `sendSatsToSwapBasket`
  takes the token id); Move back's createAction takes every `amm-swap` row
  of the token, the token rows and its sats rows, as explicit inputs; the one
  token output is unchanged and the wallet's change absorbs the sats. The
  legs still select any sats row of the exact amount.
- **Deterministic payout keys for swap legs.** A leg's payout key (the
  BRC-29 sats payment, or the BRC-207 receipt) and the taker's own
  commission key are derived from the leg's first staged `amm-swap` input,
  `<txid>.<vout>` (display hex): tokens in, its first token row (the swap's
  input 2); sats in, its sats row (input 1). derivationSuffix =
  base64(sha256(UTF-8 of that text)); derivationPrefix = base64("amm swap")
  for the payout, base64("amm swap commission") for the commission
  (`legDerivation`, `legKeyInputOf`). The receipt's sender is still the
  pool's validator; the BRC-29 sender the user. `planSwapLeg` sizes the leg
  with placeholder addresses and makes no wallet call; `prepareSwap` derives
  the keys and re-plans (the sats must match). The pending-payout records
  are written exactly as before (David: "just because it is deterministic
  doesn't mean we will know that we didn't complete the internalization").
- vitest 203; zig 79.

## 0.29.0 (2026-11-02)

Pages only (web/ui). Decided with David after walking the swap, deploy and
close call by call (plans/wallet-built-flows-2026-11-02.md); the browser
stores (pending payouts, pending deploys) are unchanged.

- **The swap-basket send carries the legs' sats.** One send per swap stages
  everything the legs spend in `amm-swap`: tokens in, the module send
  (`sendToSwapBasket`, `{tokens, sats}`) has the per-leg token outputs and
  after them ONE P2PKH sats output per leg not covered (exactly the leg's
  `swapFunding` amount) to a fresh `[2, "amm swap"]` key, filed in
  `amm-swap` by the createAction itself (customInstructions `{sats: true,
  protocolID, keyID, counterparty}`; the module passes a non-token output
  through); sats in, or tokens already staged, a plain createAction
  (`sendSatsToSwapBasket`, no `p color` labels). A leg's input 1 is its sats
  output (`SatsInput`, `satsInputsOf`, `selectExactSatsInput`: exact amounts
  only), signed with `createSignature` like the token inputs; the relay's
  `funding` is that output's transaction (AtomicBEEF). `prepareSwap` is split:
  `planSwapLeg` (plan, payout keys, the exact sats) then `prepareSwap`
  (`planned`, `satsInput`, `holdingBeef`). `createFunding`, the funding
  noSend action, `abandonSwap`'s abortAction, `1sat-deposit`, the hold tag
  and `amm-funding` are gone; a refused or timed-out leg leaves its outputs
  in `amm-swap` for a later swap. `swapTotals` (Your tokens) counts tokens
  only; the sats rows are shown nowhere.
- **Move back = ONE wallet createAction** (`moveBack`): `inputBEEF` = the
  basket's BEEF, `inputs` = every `amm-swap` token output of the token
  (`unlockingScriptLength` 108), one output to a NEW module receiving key
  with the receipt as its customInstructions (no basket), labels
  `["amm-swap"]`, `randomizeOutputs: false`; the page's unlocks go to
  `signAction` (`src/wallet/action.ts` `runAppSignedAction`, aborted on any
  failure before the signatures); the wallet funds the fee, adds change,
  broadcasts. Then the submit, the admission wait and the module take-in as
  before. A failed submit after the wallet's broadcast is reported, not
  thrown, so the receipt is kept as a pending payout.
- **Close = ONE wallet createAction** (layout 2, `bsvFee` 0): the pool an
  explicit input (`inputBEEF` the lookup's, `unlockingScriptLength`
  `PoolTemplate.maxCallUnlockLength`), outputs `planClose`'s with the
  payout's `paymentCustomInstructions` and the receipt; the page fills input
  0 over the wallet's transaction (its change included: Close(lpSig)'s
  outputs are free) at signAction. `closePosition` waits for the topic's
  admission of the token output before the take-in. `bsvFee` > 0: unchanged
  (the fee from the pool, page-built). A layout-1 pool now needs `bsvFee` > 0
  (no funding transaction to pay its fee).
- **No relinquishOutput anywhere** (David: "Anything we internalize should
  relinquish outputs itself"): `completeSwap`, `moveBack`, `completeClose`
  call none; `CompletedSwap` / `CompletedClose` / `MovedBack` have no
  `relinquished`.
- Manifest: `1sat-deposit` leaves `basketAccess`.
- Proven against the real wallet-toolbox 2.15.0 (Wallet + StorageKnex/SQLite
  + WalletPermissionsManager, the class Yours's LocalWalletPermissionsManager
  extends; MockServices as the network, which verifies every input script)
  and the real @bsv/color-permission-module 0.1.0, outside this repository
  (the toolbox is not a dependency here): the toolbox takes `amm-swap` rows
  and a pool (held or foreign) as explicit inputs with the page's unlocking
  scripts, marks them spent (`spentBy` the action), and an internalized
  foreign swap marks its `amm-swap` input spent; customInstructions on an
  output with no basket are in storage when the transaction is broadcast;
  the manager routes no createAction or signAction of these flows to the
  color module; the module's `planOutput` returns a sats output with basket
  `amm-swap` unchanged.
- vitest 205 (new: the swap-basket send's tokens + sats output set, the
  sats-only send, Move back's and Close's createAction / signAction shapes
  against fake wallets that place explicit inputs first, a sats-in
  `executeSwap`), zig 79.

## 0.28.2 (2026-11-02)

- The pages keep no liveness window of their own (David, 2026-11-02:
  one judgement, made by the instance). The token instance's
  `GET <base>/.live/<topic>` already returns only the beats inside its
  window (`config.overlay.market.window`); the pages re-filtered that list
  against a hardcoded 40 s (`LIVE_WINDOW_MS`, from the 30 s beat days), so
  with the 2-minute beat the Swap page said no validator had beaten though
  the instance reported it live. `LIVE_WINDOW_MS` and every `windowMs`
  parameter are gone (`parseLiveBeats`, `noLiveness`, `mergeLive`,
  `fetchLive`, `fetchLiveByToken`); `LiveAnswer` has no `windowMs`; every
  beat the read returns is `live` (`at`, `ageMs` kept for "seen N s ago").
  The planner's message is "no pool's validator is live on this token".
  `src/lib/overlay.ts`, `src/market/plan.ts`, `test/swap.test.ts`.

## 0.28.1 (2026-11-02)

- Deploy a position fills the other side at the market rate (David,
  2026-11-02). With a market price for the token (the "market price now"
  number), typing in Tokens fills Sats = tokens × price (whole sats,
  rounded) and typing in Sats fills Tokens = sats ÷ price (the token's
  decimals, rounded at the last place). The field typed last is the
  source; both stay editable. Changing the token (or the market price
  arriving) re-derives from the source. No pools: no filling, as before.
  `src/ox/deployFill.ts`, `test/deployFill.test.ts`.

## 0.28.0 (2026-11-02)

- The claim grants the configure right, not root (David, 2026-11-02: "The
  end user, the one connecting with their wallet, is the one who is able to
  configure and enable. The host is the host."; open-exchange 0.5.0: swap
  is born owned by the host's key). `claimStatus` reads swap's
  `GET <base>/admin` (`{claimant?, since?}`; a swap without it: its
  `/.well-known/skein` `claimed`, as before); `claimExchange` sends
  `{fn: "claim"}` in the swap app's box `amm/claim` to swap's identity (was
  the kernel's box `claim`, `{}`); `isRoot` (name kept) = the wallet is the
  claimant, or the host's `/skeins?key=` lists swap. Settings: the claim
  card while `/admin` names nobody — alone for anyone else, above the admin
  cards for root; the not-admin line and the lead say admin, not root.
- Positions and Recover see pools whose output the wallet already marked
  spent (the LP swapped against its own pool): `historyPoolRows` reads
  `listActions({labels: ["amm-pool-deploy"], includeOutputs: true})` and
  takes every output filed in `amm-pools` as a pool row, deduped with the
  basket's (`mergePoolRows`), each followed by `/spends` as before (closed
  pools stay out; two rows that reach the same pool list it once). Recover
  tries those rows' LP keys before the keyIDs kept in this browser. Pages
  only.

## 0.27.1 (2026-11-02)

- One BRC-104 session per instance (David, 2026-11-02: "fix the page").
  The pages built ONE `AuthFetch` and used it for every base; the SDK's
  AuthFetch keeps one session per origin and shakes hands at
  `<origin>/.well-known/auth`, which the router gives to the root instance
  (swap), so every signed request to a token instance
  (`<origin>/@<tokenId>/amm/...`: lookup, the pool's output, `amm.pool.terms`,
  `amm.pool.affirm`, `amm.swap.terms`, the relay) came back unsigned and the
  wallet refused it ("without valid BSV authentication"). Pool deploy,
  Recover and Close were broken on every exchange since tokens became their
  own instances (0.17.0). Now `src/lib/skein.ts` `authFetchPerInstance`
  keeps one AuthFetch per instance (origin + `/@<handle>` prefix), and a
  prefixed instance's handshake goes to `<origin>/@<handle>/.well-known/auth`
  (the fetch wrapper copied from skein's `src/client/raw.ts`; no skein
  dependency). Every token-instance call takes its own instance's client;
  swap's (claim, admin messages, its token list) its own. Pages only.

## 0.27.0 (2026-10-30)

- Your tokens: one first-visit approval covers the list (David,
  2026-10-30). `myTokens` takes each token's balance from the one `p color
  assets` read, the sum of its held value outputs (`buildInventory`); it no
  longer reads `p color balance <assetTag>` per token (one "Grant Item
  View" prompt per token on first visit). `assetBalance` stays in
  `src/wallet/color.ts` for a per-token page; nothing calls it today (the
  Swap page's "you hold" line reads the list's balance, as before).
- `public/manifest.json` `metanet.groupPermissions.basketAccess` lists
  `p color assets` (the wallet grants it with the group in one popup, into
  the store its 1Color module reads); the group description no longer says
  the module "asks you each time".
- The Settings nav link shows to root and, while the exchange is unclaimed
  (`claimStatus` → `claimed: false`), to any connected wallet: since 0.26.0
  made `isRoot` real, a non-root wallet never saw the link and could not
  reach the claim card. Hidden while that read is pending, as before. The
  Settings page itself is unchanged. Pages only.

## 0.26.0 (2026-10-30)

- The Open Exchange admin is a claim (David, 2026-10-30): swap is set up
  unclaimed, and Settings, while nobody holds root on it (`claimStatus`:
  skein 0.1.2's `GET <swap>/.well-known/skein` → `claimed: false`), shows
  ONE card, "Claim this exchange", with one button: `claimExchange` sends
  the wallet's own message in box `claim` to swap's identity (what `skein
  claim` sends) and reads `isRoot` again. `isRoot` is real: the host's
  `GET <origin>/skeins?key=<wallet key>` names swap's identity (was a
  stub: every connected wallet). Claimed by another key: the not-root
  line. Pages only.

## 0.25.0 (2026-10-30)

- Settings, "Enable a token" (David, 2026-10-31: "One list, one click per
  token"): the typed token id and the pasted BEEF are gone; the card lists
  the tokens on discovery (`<origin>/@discovery/1color/color/tokens`) and in
  the connected wallet (`p color assets`) that are not on this exchange's
  list yet, each with one Enable. `enableToken(tokenId)` takes the deploy's
  BEEF from the wallet's module basket, else from discovery's `ls_color`
  lookup at the host root (`deployBeef`, which `deployMeta` uses too), else
  refuses naming both; `EnableSent.beefFrom` is `"wallet" | "discovery"`.
  Pages only.

## 0.24.1 (2026-10-30)

The settled overlay sync design (David, 2026-10-30): skein-overlay v0.20.0
and skein-1color v0.13.1 (were v0.19.0 and v0.13.0).

- `bin/overlay.wasm` (skein-overlay 0.20.0): announce, then fetch — the
  `<topic>` mesh carries only the engine's `admit` verdicts and the host
  fetches the BEEF from the announcer; a paused submission asks nobody (no
  `want` events); every proof the chain app takes is published (a reorg's
  too); the sync protocol's `tail` read; beat defaults 120 s / 300 s (this
  app's manifest sets none).
- `bin/color-topic.wasm`, `bin/color-lookup.wasm` from skein-1color 0.13.1
  (byte-identical to 0.13.0's). `bin/amm-p2p.wasm` and
  `bin/amm-validator.wasm` rebuilt on the new contract modules (no source
  change).
- The receive row `/skein/overlay/beef/1.0.0` stays in the manifest: it is
  the host's own entry, not served to peers (skein's host never handles it
  inbound); the manifest's description says so.
- `image/token` installs skein-chain v0.7.1 (a reorg broadcasts nothing).
- Manifest version 0.24.1. Pages (`web/ui`) unchanged.

## 0.24.0 (2026-10-30)

Undecided is not rejected (David, 2026-10-30): skein-overlay v0.19.0 and
skein-1color v0.13.0 (were v0.18.0 and v0.12.1).

- `bin/overlay.wasm` (skein-overlay 0.19.0): a topic manager's
  `MissingParents` failure is no verdict — the submission pauses, wants the
  named sources (not in the BEEF, not held) from the peers that announced
  it, and is judged again as each arrives; nothing is recorded as rejected.
  The topic-call carries `unheld`.
- `bin/color-topic.wasm` (skein-1color 0.13.0): a token transfer whose token
  inputs' sources cannot be read fails `MissingParents`; a deploy needs no
  parents. `bin/color-lookup.wasm` rebuilt there.
- The AMM's four programs rebuilt on the new contract modules (no source
  change). Manifest version 0.24.0. No page, route or image change.
- zig: 79; vitest unchanged.

## 0.23.0 (2026-10-30)

The config app leaves (shruggr/open-exchange#1): skein-amm is the AMM
library, Open Exchange the distributable.

- Removed: `apps/config` (its manifest, `bin/amm-config.wasm`, `www/`),
  `programs/amm-config`, `image/config`, `scripts/www.sh`,
  `scripts/color-pages.sh`. The swap app (shruggr/open-exchange `apps/swap`,
  program `config`) is amm-config 0.22.0 moved and changed there; its pages
  are built there from this repository's `web/ui` at a tag.
- `web/ui`'s build writes `dist/` (not committed); `--outDir` for a caller.
- The token app's tree no longer carries the config app's pages (about
  4.6 MB less in each token instance installed from this tag).
- zig: 79 (the pool library and four programs); vitest 159.

## 0.22.1 (2026-10-30)

The page library (`web/ui`) reads the Open Exchange's swap instance
(shruggr/open-exchange#1; skein #164; skein-amm#5): root's decisions are
facts, the host makes the instances. The pages themselves are built by
shruggr/open-exchange (its `apps/swap/www`); the token app is unchanged.

- `/tokens` rows: `status` is `enabled` or `disabled`; no `url`, `reason`
  or `delivered`. A token's instance is computed: `tokenBase(tokenId,
  base)` = `<origin>/@<tokenId>/amm` (`src/lib/config.ts`).
- `/discovery`: `{on, since?}`; no status machine, no `url`.
- Settings: each token enabled or disabled (Disable; Enable again for a
  disabled one, with no BEEF: the swap instance keeps its deploy); the
  Discovery switch on or off; the "being created…", "starting…" and
  "failed" texts gone.
- `apps/config` (still here, with its 0.22.0 pages) is left as it was; it
  goes in the next release, now that open-exchange carries the swap app.
- vitest: 159.

## 0.22.0 (2026-10-30)

The token app's setup on the deploy event (shruggr/skein-amm#5; David
2026-10-29/30; skein #164; plan amm-setup-on-deploy-2026-10-30).

- New program `amm-setup` (programs/amm-setup): the step on the event
  route `deploy` (box `amm/deploy`, filter `kernel.beef`, handler
  `amm-setup.deploy`). The event `{kind: "deploy", beef}` after the door:
  the BEEF read back from the envelope (`chain.record.wireOf`), the deploy
  its subject's first output that deploys (`src/deploy.zig` `deployIn`:
  output 0 for a BRC-162 deploy, the first deploying inscription for a
  legacy BRC-161 one). In one step: the head `amm/token` = `{tokenId,
  topic, lookup, ammLookup, sym, dec, icon?, txid, vout}`; the engine
  called in-VM (skein-overlay 0.18.0): `register {topic: tm_color_<id>,
  program: "color-topic", seed: [<txid>]}`, `registerLookup {service:
  ls_color_<id>, program: "color-lookup", topics: [tm_color_<id>]}`,
  `registerLookup {service: ls_amm_<id>, program: "amm-lookup", topics:
  [tm_color_<id>]}`; a refused registration fails the step. A deploy the
  seed does not take (the register's `missing`: the door stores the
  blocks, the chain app holds only what is ingested) is submitted to the
  engine by message, `{fn: "submit", args: {beef, topics:
  [tm_color_<id>]}}` from the instance to itself in `amm/submit` (the
  validator's form). Refused, logged, nothing written: the head
  `amm/token` exists ("this instance has its token"), not a deploy event,
  no door envelope, no deploy in the subject.
- The read `GET /amm/token` (filter `token` → `amm-setup.token`): the
  record as JSON, 404 before the event.
- `src/deploy.zig`: the deploy read from a BEEF, moved out of
  programs/amm-config/src/tokens.zig (`deployOf`, `canonicalId`,
  `dataUrlOf`, `ammLookupName`, re-exported there; behaviour unchanged) and
  `deployIn` added; `Deploy` carries `txid` and `vout`.
- skein-overlay v0.18.0 (f66ee73) by tag URL and hash; `bin/overlay.wasm`
  copied from it. `config.overlay` stays `{}`.
- The config app (amm-config, apps/config) unchanged in behaviour: its
  create still passes the configured names; that path is superseded by
  shruggr/open-exchange#1.
- Needs skein main fa8077c or later (an event route may name `kernel.beef`
  in an app manifest and a dispatch row; a5c1897's host refused it at
  install).

## 0.21.1 (2026-10-29)

0.21.0's token manifest dropped `config` entirely; skein derives the
overlay engine's routes (the box `amm` as `event` and `mailbox`,
`/submit`, `/lookup`) from the MANIFEST's own `config.overlay` (skein
`src/host/manifest.ts` `overlayWiring`; an install's `--config` is merged
after), so an in-place install of 0.21.0 removed those four rows from the
instance. `etc/app.json` carries `config: {overlay: {}}` again (no lookup,
no topic); the amm-p2p/amm-validator manifest tests back as in 0.20.1
(they read `config.overlay`). Manifests 0.21.1.

## 0.21.0 (2026-10-29)

The AMM lookup named per asset (David, 2026-10-29: a lookup service name is
advertised network-wide, so two providers under one name must answer over
the same data; each token instance's AMM lookup indexes a different token's
pools; plan ls-amm-per-asset-2026-10-29).

- amm-config: a token's create names the lookups `{ls_amm_<id>: {program:
  amm-lookup}, ls_color_<id>: {program: color-lookup, topics:
  [tm_color_<id>]}}` (`tokens.ammLookupName`; `manifest_lookups` gone); the
  create's and start's `topics` are `[tm_color_<id>, ls_color_<id>,
  ls_amm_<id>]`. Discovery unchanged.
- Token app `etc/app.json`: no `config` (its default lookup `ls_amm`
  removed: a token instance's lookups are its create's; 0.21.1 puts
  `config.overlay: {}` back); descriptions of
  both manifests; version 0.21.0.
- amm-lookup: comments and `documentation` name `ls_amm_<assetId>` and its
  beat `ls_amm_<assetId>-live`; the INDEX name stays `ls_amm` (the head
  `<app>/ls_amm`, no migration).
- Pages: `ammLookupService(tokenId)` (lib/overlay.ts) / `ammLookupOf`
  (data/exchange.ts) in place of `AMM_LOOKUP_SERVICE` / `AMM_LOOKUP`, the
  asset id as `colorQuery` forms it; prices read `ls_amm_<assetId>-live`
  per token instance; query bodies unchanged.
- A token instance created before 0.21.0 keeps `ls_amm` until its config
  names the new lookups (`install --config`) and a disable/enable gives its
  row the new `topics`.

## 0.20.1 (2026-10-29)

The lookups in BRC-207's query form, no shape of ours (David, 2026-10-29,
correcting 0.20.0).

- skein-1color v0.12.0 → v0.12.1 (tag URL and hash; `bin/color-lookup.wasm`
  copied from it: `ls_color` answers BRC-207's query with `topic:
  "tm_color"`; 0.12.0's `{txid, outputIndex}` deploy answer and the
  per-asset name's extra queries withdrawn); `scripts/color-pages.sh` at
  v0.12.1 (sha256 7d55df85…3674).
- Pages: `deployMeta` asks the host root `{"service": "ls_color", "query":
  {"type": "color-admission", "version": 1, "assetId": "<txid>_<vout>", "topic": "tm_color", "outpoints": ["<txid>.<vout>"]}}` (`deployQuery`). A token instance's outputs by outpoint ask
  `ls_color_<tokenId>` BRC-207's `color-spendability` (positions, recover:
  `colorOutput`) or `color-admission` (the move back's admission wait,
  `awaitAdmitted`), topic `tm_color_<tokenId>` (`colorQuery`).
- zig build test 79; vitest 159; `apps/config/www/` rebuilt; manifests
  0.20.1.

## 0.20.0 (2026-10-29)

One lookup name per topic (David, 2026-10-29: "There should be no
difference between what these things are looking up. The only difference
is which topic the instance has got access to."; plan
ls-color-rename-2026-10-29).

- skein-1color v0.11.4 → v0.12.0 (tag URL and hash; `bin/color-lookup.wasm`
  copied from it: `ls_color_deploys` gone, `ls_color` answers a deploy
  `tm_color` admitted at its outpoint `{txid, outputIndex}`, spent or not,
  and `ls_color_<assetId>` answers `ls_color`'s queries besides BRC-207's);
  `scripts/color-pages.sh` at v0.12.0 (sha256 8b0bc80c…39ec), the 1Color
  pages in `apps/config/www/color/`.
- amm-config: a token's create names the lookups `{ls_amm,
  ls_color_<id>: {program: color-lookup, topics: [tm_color_<id>]}}` (no
  `ls_color`, no `ls_color_deploys`); create/start `topics` unchanged.
  Discovery's create: `{topics: {tm_color: color-topic}, lookups:
  {ls_color: {program: color-lookup, topics: [tm_color]}}}`, create/start
  `topics: [tm_color, ls_color]`.
- Token app `etc/app.json`: `config.overlay.lookups` is `ls_amm` alone;
  descriptions of both manifests; version 0.20.0.
- Pages: a deploy's metadata (`deployMeta`, Your tokens for a token the list
  does not carry) asks `ls_color {txid, outputIndex}` at the HOST ROOT (the
  pages' origin, plain fetch), not `/@<tokenId>` (a token not enabled here
  has no instance: the lookup threw and Your tokens showed ids only). A
  token instance's outputs by outpoint (positions, recover, the move back's
  admission wait) ask `ls_color_<tokenId>` there instead of `ls_color`
  (`colorLookupOf`). The Discovery card's text.
- zig build test 79; vitest 159; `apps/config/bin/amm-config.wasm`,
  `bin/color-lookup.wasm` and `apps/config/www/` rebuilt.
- Running instances keep the lookups their create named until their config
  is reinstalled (README "Discovery").

## 0.19.0 (2026-10-29)

The holders' "request to list a token" is removed (David Case 2026-10-29:
it is not part of Open Exchange as a product; a marketplace host adds its
own mechanism).

- amm-config: the box `amm/requests` (`{fn: "request"}` from anyone), the
  head `amm/requests`, the read route `/requests` (filter `requests`) and
  `programs/amm-config/src/requests.zig` are gone. A request recorded by
  an earlier version stays in the instance's state, unread.
- Pages: Your tokens drops "Add to this exchange" (`requestListing`) and
  the "Requested" mark; a token not on the list reads "Not on this
  exchange". Settings drops "Requests to list" and its "Enable…" pick;
  Enable a token takes a typed token id. `listingRequests`,
  `useListingRequests`, `readRequests`, `WireRequest` gone.
- zig build test 79 (amm-config 8); vitest 157; `apps/config/bin/amm-config.wasm`
  and `apps/config/www/` rebuilt.

## 0.18.1 (2026-10-29)

The create/start ask names the topics the host routes to the instance
(shruggr/skein#137; David Case 2026-10-29: "This is a host routing rule.
Why does the instance care at all?").

- amm-config: a token's `create` gains `topics: [tm_color_<tokenId>,
  ls_color_<tokenId>]`, and a stopped token's `start` (re-enable) carries
  the same; discovery's `create` and `start` gain `topics: ["tm_color",
  "ls_color_deploys"]`. `stop` unchanged. skein main fef7823 or later
  routes a bare-host `/submit` / `/lookup` by them.
- zig build test 80 (amm-config 9); vitest 158 (pages unchanged).

## 0.18.0 (2026-10-28)

The discovery toggle (shruggr/skein#137; David Case 2026-10-28: discovery is
its own instance, and the Settings page turns it on and off).

- amm-config: root's `{fn: "discovery", args: {on: true | false}}` in
  `amm/admin` (role root): on, the manager's `create {handle: "discovery",
  image: <tokenImage>, config: {amm: {overlay: {topics: {tm_color:
  color-topic}, lookups: {ls_color, ls_color_deploys: {topics:
  [tm_color]}}}}}}` (no beef, no terms, no market), or `start` when it was
  stopped; off, `stop`. The record under `amm/discovery` (`{on, status,
  since, url?, reason?}`, src/discovery.zig); the read `/discovery`.
- The pages: Settings "Discovery", one switch with its status and url
  (root only). Enabling a token does not submit its deploy to discovery;
  the 1Color deploy page submits each deploy to `tm_color` at the pages'
  origin, routed by skein (main 2eafff1) to the instance that declares it.
- zig build test 80 (amm-config 9); vitest 158.

## 0.17.0 (2026-10-28)

The Open Exchange as a config instance and one token instance per token id
(shruggr/skein-amm#4; David Case 2026-10-27/28). Two apps, both `amm`; two
images, `image/token/` and `image/config/` (`image/` is gone).

- The token app (`etc/app.json`, 0.17.0): no `register` box, no
  `roles.root` `register` / `registerLookup` / `deregisterLookup`
  (`[rescind, terms, market]`), no pages, no holders' requests. Its topic
  and lookups come from its create's config. `config.overlay.terms` is the
  initial validator terms and `config["amm-p2p"].market` the initial market
  minimum (src/terms.zig `current`, market.zig `current`: the head first, a
  record or its `null`, else the config's); amm-validator signs for every
  topic the engine serves (configured or registered); amm-validator ignores
  its own answer to root looped back (root is the instance's own key on a
  one-key host).
- The config app (`apps/config/`, program `amm-config`): root's `enable
  {tokenId, beef}` (the deploy checked, the manager's `create` with the
  token's config and the BEEF), `disable` (`stop`), `enable` of a stopped
  token (`start`), `defaults {terms?, market?}`; the reads `/tokens`,
  `/defaults`, `/requests`; the holders' requests (moved from amm-p2p);
  the pages.
- The pages (served by the config instance): the token list from
  `/tokens`, every per-token read and call at that token's instance
  (`tokenBase`); Settings: Enable a token (BEEF from the wallet's module
  basket or pasted), the enabled list with Disable / Enable again, Default
  validator terms, Default market minimum. Pages built into
  `apps/config/www/`; the 1Color pages copied beside them.
- Engine skein-overlay v0.17.0 (configured topics and lookups beat;
  `config.overlay.terms`, shruggr/skein-overlay#8). Needs skein with the
  manager's `create {…, beef}` (skein main 61a39e0).
- zig build test 78 (pool 11, amm-lookup 15, amm-validator 23, amm-p2p 22,
  amm-config 7); vitest 155.

## 0.16.3 (2026-10-27)

The host chain (shruggr/skein#156): the image installs skein-chain **v0.7.0**
(tree a0b7e769), whose chain state points at the host chain's record instead
of copying headers (the host sends a `chain` event at install, at each start
and once per block; a fresh host bootstraps its chain from the image). Engine
skein-overlay v0.16.1 and skein-1color v0.11.4: chain/state read through
skein-sdk v0.12.0's one opener `chain.open` (shruggr/skein-sdk#1). amm-p2p,
amm-validator and amm-lookup read the chain state through the engine
(`engine_vm.load`, the lookup handler) and change no source; `bin/` rebuilt
(the engine and the 1Color components copied from their tags). No behaviour
change in this app; the pages and `www/` are unchanged.

## 0.16.2 (2026-10-27)

The pages depend on the published packages directly: `@1sat/*` 0.1.1 and the
upstream `@bsv/sdk` 4.0.0, `@bsv/templates` 2.1.0,
`@bsv/color-permission-module` 0.1.0 and `@bsv/wallet-toolbox-client` 2.15.0
(released 2026-10-23). The interim `@bopen-io` repack aliases and their
`overrides` are gone; `npm ls @bsv/sdk` shows one upstream copy. No page
behaviour changes.

## 0.16.1 (2026-10-26)

The Settings page's register seeds the token's topic with its deploy
(`seed: [<deploy txid>]`, skein-overlay 0.7.8), as the 1Color pages do.
Without the seed the topic started empty: the wallet module's deploy check
(BRC-207 `admission` on `ls_color_<assetId>`) then refused every pool
deploy of that token ("the overlay has no admitted deploy for …", AMM3 on
swap, David Case 2026-10-26). Registering again fills an existing topic.
`etc/app.json` 0.16.1; www/ rebuilt, www/color unchanged. vitest 152.

## 0.16.0 (2026-10-24)

Market terms are a runtime record root sets: a minimum commission the
market lists by; the commission key derived, not configured
(shruggr/skein-amm#3; David Case 2026-10-24: the market half of the
validator's terms, one record for the whole skein for now, per-token
overrides the release shape, not built).

- amm-p2p: root's message `{fn: "market", args: {minCommissionBps}}` in
  the box `amm/amm-p2p` sets the market record (an integer, 0 to 10 000;
  any other shape refused `bad-args`, nothing written), `{fn: "market",
  args: null}` clears it; kept as the root of the head `amm/market`
  (src/market.zig: `{minCommissionBps}`, or `null` once cleared). Answered
  to root `{fn: "market", request, replyTo, result: <the record> | null}`
  in that box. Unset: 0. `roles.root` gains `market`.
- amm-p2p: `amm.swap.terms` answers `{commissionPkh, minCommissionBps}`.
  The commission pkh is hash160 of the instance's own key for the relay:
  BRC-43 security level 1, protocol `amm commission`, key ID `relay`,
  counterparty anyone, through the signer (`commissionKey`), as the
  validator's keys are derived. The relay is otherwise unchanged: it
  passes a commission-charging swap only when the commission pays that key
  (`commission_missing`), and refuses nothing by the minimum (a listing
  preference of this market, not a rule: David 2026-10-24, "Are you
  putting in work to limit things you shouldn't be?").
- `config.amm.commission` (and genesis `defaults.ammCommission`) is
  removed from `etc/app.json`, the code and the docs; `etc/app.json` has
  no `config.amm` now.
- Pages: Swap lists, and quotes over, only the pools whose commission is
  at or above `amm.swap.terms`'s `minCommissionBps`, and says "N pools
  below this market's minimum commission" when it hides any (nothing when
  none; with no wallet connected the minimum is not read and nothing is
  hidden). Settings gains a root-only "Market terms" card beside
  "Validator terms": the minimum, Set / Clear through the connected wallet
  (root's BRC-104 message into `amm/amm-p2p`). www/ rebuilt; www/color
  unchanged.
- Tests: zig pool 10, amm-lookup 15, amm-validator 23, amm-p2p 21 (69);
  vitest 152.

## 0.15.0 (2026-10-24)

Validator terms are a runtime record root sets; no fee numbers in the
image (shruggr/skein-amm#2; David Case 2026-10-23: "The configs should not
be published in the image. This will be a dynamic, competitive
marketplace."). Terms set: this skein is a validator; unset: a market
only.

- amm-validator: root's message `{fn: "terms", args: {lpFeeBps,
  validatorFeeBps, commissionBps}}` in the box `amm/validator` sets the
  terms (each an integer, 0 to 10 000; any other shape refused
  `bad-args`, nothing written), `{fn: "terms", args: null}` clears them;
  kept as the root of the head `amm/terms` (src/terms.zig: the record
  `{lpFeeBps, validatorFeeBps, commissionBps}`, or `null` once cleared:
  the kernel has no head delete). The step answers root `{fn: "terms",
  request, result: <the record> | null}` in the box it wrote to and sends
  the instance itself `{fn: "rebeat"}` in box `amm`, so the engine
  re-declares every topic's beat with the new terms. `affirm` and the swap
  signing read the record: none set, both refused `not_validating`, "no
  terms: this skein validates nothing", before anything is checked or
  signed. Root's `rescind` is unchanged (it does not need terms).
- amm-p2p: `amm.pool.terms` answers the record with this validator's
  identity and peer ID, or the error "no validator here" when none is set.
  `amm.swap.terms` (the relay's commission pkh) is unchanged.
- `config.amm.ammValidator` is removed from `etc/app.json`, the code (no
  fallback to genesis `defaults.ammValidator` or to 30/5/0) and the docs.
  `roles.root` gains `terms`.
- Engine: skein-overlay v0.15.1 → v0.16.0 (shruggr/skein-overlay#7: the
  beat's `terms` from the head `amm/terms`, not `config.overlay.terms`;
  `rebeat`); `bin/overlay.wasm` is the tag's (sha256 bb2f16fe…0022).
  skein-1color v0.11.2 → v0.11.3 (the same engine pin; `bin/color-*.wasm`
  the same bytes; `scripts/color-pages.sh` pins the v0.11.3 tarball, sha256
  9b706994…0372, `www/color/` unchanged).
- Pages: Settings gains a root-only "Validator terms" card — the terms
  `amm.pool.terms` answers, "This exchange validates nothing: no terms are
  set." when none, and Set / Clear through the connected wallet (root's
  BRC-104 message into `amm/validator`). Liquidity's deploy shows that
  sentence in place of the terms and disables Deploy; Swap shows it in
  place of the fee line when there is no quote. The recipient of root's
  messages and of a listing request is now the key the instance's signed
  answer carries (`x-bsv-auth-identity-key`, off `amm.swap.terms`, as the
  1Color tokens page reads it), since a market only refuses
  `amm.pool.terms`. The unused `DEFAULT_LP_FEE_BPS` /
  `DEFAULT_VALIDATOR_FEE_BPS` and the pages' 30/5/0 fallbacks are gone.
- Tests: zig pool 10, amm-lookup 15, amm-validator 23, amm-p2p 19; vitest
  150.

## 0.14.2 (2026-10-23)

Engine 0.15.1: pending-parent pause (shruggr/skein-overlay#6). A
submission whose parent is held but not yet admitted now pauses and
resumes on the parent's admission. Nothing else changes in behaviour; the
pages, the contract, the manifest's rows and the image are unchanged.

- skein-overlay v0.15.0 → v0.15.1 (tag URL and hash; skein-sdk v0.11.1
  through it, unchanged): `bin/overlay.wasm` is the tag's engine (sha256
  2b11a447…6f02).
- skein-1color v0.11.1 → v0.11.2 (tag URL and hash; the same engine pin):
  `bin/color-*.wasm` the same bytes; `scripts/color-pages.sh` pins the
  v0.11.2 tarball (sha256 5be817d2…40a1) and `www/color/` is unchanged.
- `etc/app.json`: version 0.14.2; the description names both pins.

## 0.14.1 (2026-10-23)

The receive row (shruggr/skein#154). A local node catching up from the
rack's `swap` pulled the ranges and fetched the transactions over libp2p,
then refused every fetched BEEF: "no route for
libp2p:/skein/overlay/beef/1.0.0". The host hands each Atomic BEEF a
catch-up fetches to the engine's receive row, as from the serving peer,
and the manifest did not declare it. Nothing else changes in behaviour;
the pages, the contract and the image are unchanged.

- `etc/app.json`: the route `{"transport": "libp2p", "address":
  "/skein/overlay/beef/1.0.0", "filters": ["kernel.beef"], "handler":
  "overlay.submit"}`, as in skein-overlay's own manifest, beside the sync
  row; the description names it and the new pin.
- skein-1color v0.11.0 → v0.11.1 (tag URL and hash; the same row in its
  own manifest): `bin/color-*.wasm` the same bytes;
  `scripts/color-pages.sh` pins the v0.11.1 tarball (sha256
  0b49e277…14af4) and `www/color/` is unchanged.

## 0.14.0 (2026-10-23)

The sync row (shruggr/skein-overlay#5, shruggr/skein#154; David,
2026-10-23: each app declares the engine's sync filter and the libp2p read
row in its own manifest, no handler). A peer's catch-up from an amm
instance failed at the locator (`/amm/anchors`: not found): the host
answered sync frames through the app's http table, which has no such
reads. Now the engine answers them through the front door. Nothing else
changes in behaviour; the pages, the contract and the image are unchanged.

- `etc/app.json`: `filters.sync = "overlay.sync"` and the route
  `{"transport": "libp2p", "address": "/skein/overlay/sync/1.0.0",
  "filters": ["sync"]}`; the description names it and the new pins.
- skein-overlay v0.14.1 → v0.15.0 (tag URL and hash): `bin/overlay.wasm`
  is its build (sha256 45a2d8f1…dc267, the tag's committed bytes).
  amm-lookup, amm-validator and amm-p2p rebuilt against it: the same bytes.
- skein-1color v0.10.1 → v0.11.0 (tag URL and hash; its sync row and the
  same engine): `bin/color-*.wasm` the same bytes; `scripts/color-pages.sh`
  pins the v0.11.0 tarball (sha256 865113dd…15e58) and `www/color/` is
  unchanged.
- A host serves the row once it takes shruggr/skein#154 (until then its
  kernel refuses a libp2p row with no handler): do not install 0.14.0 on a
  host without it.

## 0.13.2 (2026-10-23)

The Swap page showed tokens without symbol or decimals. The pages asked
the token list (`GET <base>/color/tokens`, skein-1color's `color-lookup`
`tokens`) with `limit=1000`; the route takes `limit` 1 to 100 and answered
an error the pages read as an empty list. `readTokenList` now reads 100 at
a time (`skip`) until a short page. Contract, programs, manifest and image
unchanged.

## 0.13.1 (2026-10-22)

A BEEF out of order is sorted, not refused (David Case, 2026-10-22). A
wallet's Atomic BEEF (ts-sdk's writer: a proven child before its proven
parent) was refused `NotParentsFirst` by the chain app's ingest on swap.

- **The image** installs shruggr/skein-chain **v0.6.1** (tree a3e1f859):
  its ingest sorts the BEEF parents-first, then runs the same SPV
  (skein-sdk 0.11.1 `beef.sorted`).
- **The engine**: `bin/overlay.wasm` is skein-overlay **0.14.1**'s (its
  decode, the door's envelope and the per-transaction Atomic BEEFs sorted).
- **amm-validator**: `unprovenParents` walks the request's BEEF sorted, so
  every parent is found and each parent's Atomic BEEF is parents first.
- **amm-p2p**: the relay's one BEEF takes the funding's ancestry from its
  BEEF sorted.
- Nothing else changes: the pages, the contract and the manifest are
  0.13.0's.

## 0.13.0 (2026-10-22)

The validator sign-off redesign (David Case, 2026-10-22; agent-env
plans/validator-signoff-2026-10-22.md §1, §2, §7, §9; docs/AMM.md).

- **Contract** (pool/Pool.runar.go): state gains `Nonce` (32 bytes) and
  `Affirmation` (the validator's DER signature), never assigned, carried by
  every continuation; no BRC-162 payload any more. `Close(lpSig)`: a plain
  signature by the LP key, outputs free. `Rescind(validatorSig)`: the pool
  written back at output 0 with ValidatorPubKey 33 zero bytes, everything
  else kept, the validator's change after it; Swap (unchanged) is impossible
  after it. The template grows from 2,657 to 3,568 bytes (a pool output from
  2,996 to 4,011).
- **The affirmation**: message v2 (`"skein-amm affirm 2"`, no termsHash, the
  nonce last; 221 bytes); the first validator key is the identity's child
  keyed by the nonce (64 hex digits); `amm.pool.affirm {pool, satoshis}` →
  `{validatorPubKey, nonce, signature}` (no `keyInput`; the validator picks a
  random nonce).
- **ls_amm**: lists a pool that attests itself (the key derived from
  identity + nonce, compared, the affirmation verified) or a Swap's
  continuation of a listed pool naming the next key (the identity's child of
  the spent outpoint); a rescinded pool, a Close's output and any other key
  are not listed.
- **amm-validator**: root's `close` → `rescind` (rescind.zig); the current
  key: a Swap's continuation by the spent outpoint, else a self-attesting
  pool by its nonce.
- **Pages**: the deploy names no input (outputs [pool], no `inputPositions`;
  the module selects the token inputs); the LP key a fresh random BRC-29
  keyID kept in the row (and in the browser until the row is filed); the
  Close pays the tokens to a new module receiving key and the sats as a
  BRC-29 payment (no `amm-swap`, no Move back); Recover takes both layouts;
  pools before 0.13.0 decode, close (their covenant outputs) and recover.
- Fixtures regenerated (`pool_deploy_own_key`, `swap_bad_next`, `rescind`,
  `close_rescinded`; `close_fee` and `close_validator` gone); the 0.12.x
  artifact and vectors kept for the pages' layout-1 path.
- Tests: Go 8 (73 with subtests), `zig build test` 63, web/ui 144, web/engine 35.

## 0.12.1 (2026-10-22)

Pages only (`web/ui`, `www/`): no contract, validator, lookup or manifest
change.

- **Recover a position** (Liquidity, src/lp/recover.ts): paste a pool
  outpoint (`<txid>.<vout>` or `<txid>_<vout>`, the deploy's or a later
  one); the pool is followed to its current output (`/spends`), read from
  `ls_color`, walked back through its BEEF to the deploy, and its LpPubKey
  checked against the wallet's LP key for the deploy's input 0 (BRC-29,
  else pre-BRC-29). A match is filed in `amm-pools` as a deploy files it
  (`poolCustomInstructions`, label `amm-pool-deploy`); no match files
  nothing. A pool already filed is left alone. Close is unchanged.

## 0.12.0 (2026-10-22)

The pages (`web/ui`, `www/`) move onto the wallet's BRC-207 1Color module
(David Case, 2026-10-21/22; docs/AMM.md "The pages and the wallet's
module"). Nothing outside the pages changed: `bin/`, the contract, the
fixtures and `www/color/` are 0.11.0's.

- **Dependencies**: `@1sat/*` 0.1.0 (published), `@bsv/sdk` 4.0.1,
  `@bsv/templates` 2.1.0, `@bsv/color-permission-module` 0.1.0 and
  `@bsv/wallet-toolbox-client` 2.15.0 through the interim `@bopen-io`
  repacks (npm aliases and `overrides`; one copy of `@bsv/sdk`). The
  template is 1sat-sdk's `OneColor` (was `Mandala`; `src/pool/oneColor.ts`).
  The local 1sat-sdk checkout alias (`ONESAT_SDK_DIR`, aff025c3) is gone.
  The `mandala <txid> <vout>` and `bsv21` baskets and their custom
  instructions are gone.
- **Your tokens**: the module's assets (`p color assets`) and balances
  (`p color balance <assetTag>`, exact); metadata from the token list, else
  `ls_color_deploys`, else a held deploy; what the active swap basket holds,
  with Move back.
- **Pool deploy**: `amm.pool.affirm`, then ONE createAction (key input at
  index 0, the affirmed pool at output 0 as a transfer to a foreign script,
  the key input's rest to a fresh module key, `randomizeOutputs: false`);
  the module funds the tokens and submits; the page submits too and files
  the pool in `amm-pools`. Gone: the funding transaction, SIGHASH_SINGLE,
  the claim, `amm.pool.submit` (`lp/deployFlow.ts`, `lp/poolRelay.ts`),
  `completePoolDeploy`, `abandonPoolDeploy`, a position's "rescinded".
- **Swaps**: tokens in, the legs spend the active swap basket `amm-swap`
  (keys `[2, "amm swap"]`, counterparty self); the legs it does not cover
  get an output each from ONE module send before the legs. Token payouts
  (and the taker's own token commission) go to a module receiving key, the
  pool's validator the sender, taken in with a receipt. Pending payouts
  keep receipts as well as BRC-29 remittances.
- **Close**: the tokens (paid by the contract to the LP key) are filed in
  `amm-swap`; Move back takes them into the wallet.
- **Move back**: every `amm-swap` output of a token, with a broadcast
  funding for the fee, to one module receiving key of the user's own;
  submitted to the token topic; taken in through the module.
- **Manifest**: baskets `amm-swap`, `amm-pools`, `1sat-deposit`; protocol
  `[2, "amm swap"]` (self) added; `bsv21`, `1sat` and `[0, "onesat"]`
  dropped; no spending authorization; no `p color` entry.

## 0.11.0 (2026-10-22)

Pool deploys move to the BRC-207 wallet module (David Case, 2026-10-21):
the LP's wallet builds, signs and broadcasts the deploy as one action and
the module submits it to the token topic, so the validator can no longer
append its claim to a delivered deploy. The claim, as a token unit paid to
the validator, is gone; the validator's consent is recorded at deploy in the
pool output itself, and delisting is the contract's Close. A contract
change: the Pool script, its artifact and every fixture are new.

- **The contract** (`pool/Pool.runar.go`): `Close(sig, bsvFee)` takes the
  LP key or the current validator key. The payout is always the LP's (the
  pool's sats less bsvFee, then every token in one BRC-162 value output). On
  the validator's path bsvFee must be 0: bsvFee > 0 checks `sig` against the
  LP key alone; bsvFee 0 checks it as one of the two keys (a 1-of-2
  `OP_CHECKMULTISIG`, so a validator's signature is never a failed
  `OP_CHECKSIG`, which NULLFAIL forbids). Swap is unchanged.
- **The affirmation** (docs/AMM.md "The deploy and the affirmation"):
  `amm.pool.affirm {pool, satoshis, keyInput}` → `{signature}` (amm-p2p,
  `writes: false`; it calls amm-validator's new fn `affirm` in-VM). The
  validator checks the proposed pool against its terms and its key, and
  signs, by the pool's validator key, sha256 of the 221-byte message
  `"skein-amm affirm 1" ‖ AssetId ‖ the three fees ‖ TokenReserve ‖ the
  pool's satoshis ‖ LpPubKey ‖ ValidatorPubKey ‖ ValidatorIdentity ‖
  termsHash`. The deploy's pool output carries the signature as its BRC-162
  payload (`<push sig> OP_DROP` after the prefix; the contract never reads
  it; continuations carry none). src/pool.zig `affirmMessage`, `affirmed`,
  `withAffirmation`; web/ui `PoolTemplate.affirmationMessage`, `affirmed`,
  `lockDeploy(args, state, affirmation)`.
- **The listing** (`ls_amm`): a deploy's pool is listed only when its
  affirmation verifies against its parameters and the ValidatorPubKey in its
  state; a Swap's continuation of a listed pool is listed; a Close (the LP's
  or the validator's) ends it. Only listed pools are indexed. The claim rule
  (`claims`, `spentClaims`, `NotListed`) is gone.
- **The validator's Close** replaces the rescind: root's `{fn: "close",
  args: {pool: "<txid>.<vout>"}}` in the box `amm/validator` (roles: root's
  `close`). amm-validator follows the pool to its newest output and has the
  instance's wallet build the Close with the pool as a caller input
  (createAction, then signAction with the Rúnar call: the pool's current
  validator key's signature, bsvFee 0, the wallet's change as Rúnar's), the
  wallet paying the fee; submits it to the token topic and answers root.
- **Gone:** `amm.pool.submit` and `amm.pool.status` (the delivered deploy,
  SIGHASH_SINGLE pairs, the unassigned unit), libp2p
  `/amm-validator/1/deploy`, the claim's filing in the wallet (`amm-claims`),
  root's `rescind`.
- **Fixtures** (`go run ./gen/vectors`): `pool_deploy` is a plain wallet
  deploy (token input and funding, ALL|FORKID) whose pool carries the
  affirmation; `pool_deploy_unaffirmed` and `pool_deploy_forged` must not
  list; `close_validator` (the validator's Close of pool 2, its own funding)
  replaces `rescind`; `pool_deploy_delivered`, `pool_deploy_wrong_key` and
  `claim_vout` are gone. Zig and the pages reproduce the affirmation and the
  validator's Close byte for byte.

**Not in this version:** the pages. The Liquidity page still builds 0.9.0's
delivered deploy and calls `amm.pool.submit`, which no longer exists; its
move to the wallet's BRC-207 module and `amm.pool.affirm` is the next build
(docs/AMM.md "Not wired"). `www/` is rebuilt for the template only.

## 0.10.2 (2026-10-21)

The Exchange's "Deploy a new token" link points at the app's own base
(`<origin>/amm/color/deploy/`) instead of `color/deploy/`, which at the
skein's root resolved to `/color/deploy/`, where the 1Color pages find no
app name in their URL and skip the overlay submit. `www/` rebuilt; nothing
else changed (`bin/`, `www/color/` as in 0.10.1).

## 0.10.1 (2026-10-21)

Re-pinned onto shruggr/skein-1color 0.10.1 (d7348cf, tree 7342c1df): its
pages, copied into `www/color/` by `scripts/color-pages.sh`, deploy through
the wallet's BRC-207 `color` module (`@1sat/actions` 0.1.0 `deploy1Color`,
the basket `p color <txid>v0`) instead of `deployMandala` and the basket
`mandala <txid> 0`. skein-1color's programs are unchanged, so `bin/` is
unchanged. The AMM's own pages (`web/ui`) are as in 0.10.0.

`web/ui/test/manifest.test.ts` follows 690e754 (the manifest asks for no
`spendingAuthorization` on connect, David Case 2026-10-21): the test still
expected it. The manifest itself is as 690e754 left it.

## 0.10.0 (2026-10-21)

Re-pinned onto shruggr/skein-1color 0.10.0 (the 1Color rename; BRC-162
retitled 1Color) and shruggr/skein-overlay 0.14.0; the image moved here from
skein (shruggr/skein#152). Decided with David Case, 2026-10-21. The
Open Exchange's flows are as in 0.9.1.

**Pins** (`build.zig.zon`): `skein_1color` v0.10.0 (3de96c4, tree
b51ad172) in place of `skein_mandala` v0.9.2; `skein_overlay` v0.14.0
(385e1b9). `bin/color-topic.wasm` and `bin/color-lookup.wasm` are
skein-1color 0.10.0's, `bin/overlay.wasm` skein-overlay 0.14.0's (the same
bytes as skein-1color 0.10.0's engine); `bin/amm-*.wasm` rebuilt (a clean
rebuild, fresh caches, gives the same bytes). The programs compiled against
0.14.0's engine sources and contracts unchanged: amm-validator's topic
judgement names no ancillary txids (0.13.0's verdict field stays empty),
and 0.14.0's beat fields and its reads `/holds`, `/anchors`, `/admitted` are
the engine's (this manifest routes none of them, as skein-1color's does
not).

**BRC-207's wire names**, no aliases:

| until 0.9.1 | 0.10.0 |
|---|---|
| `tm_mandala_<assetId>`, `tm_mandala_<txid>_0-live` | `tm_color_<assetId>`, `tm_color_<txid>_0-live` |
| `tm_mandala` (discovery) | `tm_color` |
| `ls_mandala_<assetId>` | `ls_color_<assetId>` |
| `ls_mandala`, `ls_mandala_deploys` | `ls_color`, `ls_color_deploys` (index head `<app>/ls_color`) |
| `mandala-spendability`, `mandala-admission` | `color-spendability`, `color-admission` |
| programs `mandala-topic`, `mandala-lookup` | `color-topic`, `color-lookup` |
| read `/mandala/tokens`, filter `mandala-lookup.tokens` | `/color/tokens`, `color-lookup.tokens` |
| pages `www/mandala/` (`<base>/mandala/`) | `www/color/` (`<base>/color/`) |
| Zig module `mandala` | `1color` (`@import("1color")`) |
| `scripts/mandala-pages.sh` | `scripts/color-pages.sh` (skein-1color v0.10.0's tarball, sha256 9211e792…) |

The asset id stays `<txid>_<vout>`, `_0` included. The pages say 1Color
where they said Mandala. The SDK's names are unchanged: the template is
still imported as `@1sat/templates/mandala` (`Mandala`), and 1sat-sdk's
basket `mandala <txid> <vout>` and label `mandala` are what it files.

**After upgrading a running skein from 0.9.1**: the 1Color lookup's index
head is now `<app>/ls_color` (it was `<app>/ls_mandala`), so it starts
empty; the registrations under `tm_mandala_*` / `ls_mandala_*` are not
recognised by the new programs (`color-topic` and `color-lookup` take only
`tm_color_*` / `ls_color_*`, and amm-lookup, amm-validator and amm-p2p only
`tm_color_*`). Root registers each token again under the new names (its
topic, its lookup, and `ls_amm`), and drops the old ones.

**The image** (`image/etc/apps.json`, shruggr/skein#152: skein's
`images/open-exchange` removed): the chain app (shruggr/skein-chain v0.6.0
by release tarball and tree id 13a517e9…) then this app (`..`), and root's
routes `/submit`, `/lookup` and `/`, as the old image had them (README.md
"The image").

**The pages** (`www/`) were built from the same 1sat-sdk source as 0.9.1's
(the embedded-icon draft, aff025c3): the bundle is 0.9.1's with only the
names and the words changed. web/ui gains `@ipld/dag-cbor` and `cborg` as
dependencies, deduped and mapped like `cbor2`, because the template's
sources import them and the checkout has no `node_modules`.

Tests: `zig build test` 70/70 (as 0.9.1: the names, the manifest's
`/color/tokens` route, and the old names refused); web/ui 133/133; web/engine
35/35.

## Before 0.10.0

The README's notes, as they stood at 0.9.1 (0.9.1: on skein-overlay 0.12.1
and skein-mandala 0.9.2):

0.8.1: on skein-overlay 0.12.0 and skein-mandala
0.9.1 (skein-sdk v0.11.0, skein log format 10: the BEEF envelope beside the
pointer record, shruggr/skein#146), every skein a market and a validator
from install, always (David Case, 2026-10-09: no switch; the Validator
page shows both always on), the token topic's gossip one mesh for submit
and admit messages with `-proof` and `-live` separate, each registered
topic's beat body its view digest; the pages at the origin root (`/`,
shruggr/skein#147) take `<origin>/amm` as the app's base. 0.8.0: on
skein-overlay 0.11.0 and skein-mandala
0.9.0 (BRC-207; David Case, 2026-10-08), a token's topic is
`tm_mandala_<assetId>` and its lookup `ls_mandala_<assetId>`, the asset id
`<txid>_<vout>` (a Mandala token's `tm_mandala_<txid>_0`, its liveness topic
`tm_mandala_<txid>_0-live`); 0.7.2's `tm_<txid>_0` is no topic (no alias).
Registering a token is two engine calls, its topic then its lookup (the
Token topics page, `mandala/tokens/`, skein-mandala 0.9.0's); the lookup
answers BRC-207's `mandala-spendability` and `mandala-admission`. A Mandala
deploy's icon is embedded in it (BRC-162 draft bsv-blockchain/BRCs#308:
`[mediaType, bytes]`, the pointer forms gone): the Tokens page shows it and
the deploy form embeds it (no icon output). `ls_amm` keeps its index at
`amm/ls_amm` (skein-overlay 0.11.0: one index per lookup program). 0.7.2:
on skein-mandala 0.8.2, a token's topic was `tm_<tokenId>`, `_<vout>` always: a Mandala token's `tm_<txid>_0`, its
liveness topic `tm_<txid>_0-live`; the bare `tm_<txid>` is no topic
(David, 2026-10-08: "that was the decision all along"). 0.7.1: on
skein-overlay 0.10.0 and skein-mandala 0.8.1, every token id is `<txid>_<vout>`, Mandala and legacy
BSV-21 alike, `_0` included, as BRC-162 "Token identification" writes it
(David, 2026-10-07, shruggr/skein#120; supersedes 0.6.3's bare txid).
0.7.0: skein's routes, filters and roles
(shruggr/skein#143), on skein-overlay 0.10.0 and skein-mandala 0.8.0 — the
manifest's `dispatch` and `reads` are `routes` (no senders): the box
`amm/register` is root's (`roles: {root: ["register", "market",
"validator"]}`), the reads are read routes whose filters answer (the pages:
the filter `page`, amm-p2p's `serve`), `/call` lists `kernel.brc104`, and
the box `amm` is the engine's alone, so amm-p2p's message path moved to its
own box `amm/amm-p2p` (docs/AMM.md "Routes"). 0.6.3: the pages wrote a Mandala token's id as the bare
`<txid>` (superseded by 0.7.1), show outpoints as
`<txid>.<vout>`, let every id shown be expanded and copied, and send
`POST /submit` unsigned, with plain `fetch` (David, 2026-10-08). 0.6.2: market and validator are the owner's switch, both
off in the manifest (David, 2026-10-07: "this shouldn't have been a config
in the manifest. This should be a setting that the user is configuring";
"Use it", item 4). 0.6.1: `POST /submit` is BRC-22 again (it answers the
STEAK, and the pages read it; shruggr/skein#112). Market and validator are the engine's two settings
(0.6.0, shruggr/skein#120; David, 2026-10-06 evening: "a skein runs as a market and/or a validator by two settings in the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator: {every}`), and registering a token's topic is the one act that drives both"): with
`config.overlay.market` the engine's `register` asks the runtime's liveness
tool for the token's `tm_<txid>_0-live`, with `config.overlay.validator` it
beacons it, and amm-validator signs for every registered token; amm-p2p's
`validate` / `unvalidate`, its validated set, its beacons, its liveness and
its start / stop are gone. The listings, the documentation, the pages and
the token list (`/mandala/tokens`) are reads (0.5.0, shruggr/skein#135:
docs/AMM.md "Rows and reads"). The page reads `GET
<base>/.live/tm_<txid>_0-live`, plans over the pools whose validator is there
and names that validator (identity key and peer ID) in the swap, and the
relay dials the peer it is given — or, when it is its own node, hands the
request to its own validator program in-VM. Ported from amm-poc (b-open-io/amm-poc, its
`programs/`, `pool/` and `web/`) in 0.1.0 (shruggr/skein#120).
