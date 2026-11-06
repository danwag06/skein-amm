# skein-amm

A non-custodial BSV ↔ token AMM over 1Color tokens (BRC-162): the AMM
LIBRARY of the Open Exchange. It holds the **token app** `amm` (this
repository's root: the overlay engine, the 1Color components and the AMM's
programs), run as one instance per token id, and the page library
(`web/ui`). The distributable — the host program, the swap app (formerly
`apps/config` here), the images and the setup — is
[shruggr/open-exchange](https://github.com/shruggr/open-exchange) (0.23.0,
shruggr/open-exchange#1: `apps/config`, `image/config`, `programs/amm-config`
and the pages build moved there). Version **0.33.0** (2026-11-04: fee ROWS in the pool lookup — one per swap, written at admission, removed on rejection; list queries `{lpPubKeys}` (each pool's state live/rescinded/closed and its LP fees), `{validatorIdentityKeys}`, `{commissionPkhs}`; the 0.32.0 single-key query and its walk gone; Positions load with one query per token, nothing per position; fee rows exist only for swaps admitted after 0.33.0). 0.32.0 (2026-11-04: LP fees per position — `ls_amm_<assetId>` answers `{tokenId, lpPubKey}` with the LP fees a pool lineage earned, sats and tokens apart, read by walking the lineage; `{tokenId, outpoint}` carries them too; the Liquidity page shows them per position and per token). 0.31.4 (2026-11-04: the Swap page reads the wallet's sats from wallet-toolbox's balance special operation, granted in the manifest's group permissions, not the `default` basket, which the permissions manager keeps admin-only — the "Wallet: N sats" line and the overspend check work again). 0.31.3 (2026-11-04: on skein-overlay 0.20.2 and skein-1color 0.13.3 — `rebeat` re-declares the configured lookup services' liveness too). 0.31.2 (2026-11-04: on skein-overlay 0.20.1 and skein-1color 0.13.2 — `{fn: "rebeat"}` re-declares each topic's liveness window too, so an instance registered before skein-overlay 0.20.0 drops its 40 s window for the market's window now; the manifest version, left at 0.31.0 by 0.31.1, corrected). 0.31.1 (2026-11-04: a swap leg refused `pool_spent` is repriced against the pool's newest state the validator returns and sent once more while the order's minimum holds). 0.31.0 (2026-11-04: the relay's dialled frame to a validator names the token's topic `tm_color_<assetId>`, so a validator whose host runs several instances on one libp2p node gets the stream; before, such a host answered `topic required` and a cross-host swap timed out). 0.30.0 (2026-11-04: Your tokens — Send gives a token to a BRC-169 handle with @1sat/actions `send1Color`, one wallet createAction through the 1Color module delivered to the handle's messagebox; the recipient's wallet takes it in). 0.29.6 (2026-11-03: Your tokens — an Unfinished swap the validator never signed can be dismissed; the swap-basket line shows the sats staged for a token, and Move back takes them back when no token is staged, one plain wallet createAction with no outputs). 0.29.5 (2026-11-03: the validator's submission carries the pool's transaction with its ancestry back to proven ones, so the kernel's door, which verifies every BEEF with nothing known, admits it; before, every relayed swap was refused `MissingInput` and timed out). 0.29.4 (2026-11-02: the deploy's LP keyID is named in its pool output description `AMM pool: <SYM> / BSV · amm-lp <hex>`, not a label — a per-deploy label prompted every time). 0.29.3 (2026-11-02: Move back and Close are module plans — their output filed by the wallet's 1Color module in the same createAction, no take-in, nothing in the browser; the deploy's LP key named by its action's `amm-lp <hex>` label, Recover and Positions read it first, `PendingDeployStore` gone; the pending-payout store is a to-do list of swap payouts with no key material and a "Finish" card on Your tokens). 0.29.2 (2026-11-02: the `amm-swap` staging keys are derived from each leg's pool outpoint, not random). 0.29.1 (2026-11-02: Close has one path, the wallet createAction, and layout 1 (pre-0.13.0 pools, their LP keys, `bsvFee`) is gone from the pages; Move back sweeps the token's staged sats rows; a swap leg's payout keys are derived from its first staged input). 0.29.0 (2026-11-02: the pages' swap, Move back and Close are wallet-built — the swap-basket send stages each leg's sats in `amm-swap` beside its tokens, no funding transaction and no `1sat-deposit`; Move back and Close are each ONE wallet createAction with explicit inputs the page unlocks at signAction; no relinquishOutput anywhere). 0.28.2 (2026-11-02: the pages keep no liveness window of their own — every validator the token instance's `.live` read returns is live; the instance's window is the one judgement). 0.28.1 (2026-11-02: the Deploy form fills the other side at the market price — typing Tokens fills Sats, typing Sats fills Tokens, the field typed last is the source; no pools, no filling). 0.28.0 (2026-11-02: the claim makes the wallet the exchange's ADMIN, not root — `{fn: "claim"}` in box `amm/claim`, swap's `/admin` read, open-exchange 0.5.0; Positions and Recover also read the deploy history, so a pool whose output the LP's own wallet spent is listed and recoverable). 0.27.1 (2026-11-02: the pages hold one BRC-104 session per instance — the swap instance and each token instance `<origin>/@<tokenId>` — and shake hands with a token instance at `<origin>/@<tokenId>/.well-known/auth`; pool deploy, Recover and Close work again). 0.27.0 (2026-10-30: Your tokens reads one `p color assets` list, each balance summed from its outputs, no per-token `p color balance`; the manifest's group permissions grant `p color assets` on the first visit; the Settings link shows while the exchange is unclaimed). 0.26.0 (2026-10-30: the admin is a CLAIM — while nobody holds root on swap, Settings shows "Claim this exchange" and the claiming wallet becomes root; `isRoot` is real, the host's `/skeins?key=`). 0.25.0 (2026-10-30: Settings "Enable a token" is one list of the tokens on discovery and in the wallet, one Enable per row; no typed id, no pasted BEEF). 0.24.1 (2026-10-30: on skein-overlay 0.20.0 and
skein-1color 0.13.1 — the settled overlay sync design: announce, then fetch; no wants; every
proof published; the receive row the host's own entry, not served to peers). 0.24.0 (2026-10-30: on skein-overlay 0.19.0 and
skein-1color 0.13.0 — undecided is not rejected: a transfer whose token inputs
the instance cannot read pauses, never refused for it). 0.22.0 (2026-10-30, shruggr/skein-amm#5): the
token app takes its token as an event — `{kind: "deploy", beef}` in the box
`amm/deploy` (`kernel.beef`), the program `amm-setup` writes the head
`amm/token` and registers the token's topic and lookups with the engine in
the same step ("The token's setup", below). 0.21.1 (2026-10-29) keeps the token
manifest's `config.overlay`, empty, from which skein derives the engine's
routes; 0.21.0 David: a lookup name is
advertised network-wide, so two providers under one name must answer over
the same data): the AMM lookup is named per token, `ls_amm_<assetId>`,
paired with `tm_color_<assetId>` as `ls_color_<assetId>` is, its beat on
`ls_amm_<assetId>-live`; a token instance's create and start name it in
`topics`; `ls_amm` is served nowhere. 0.20.1 (2026-10-29, David: the lookups in
BRC-207's query form, no shape of ours): a deploy's metadata is BRC-207's
`color-admission` at `ls_color` with `topic: "tm_color"` at the host root;
a token instance's outputs by outpoint `color-spendability` /
`color-admission` at `ls_color_<tokenId>` (skein-1color 0.12.1). 0.20.0
(2026-10-29, David: "There should be
no difference between what these things are looking up. The only
difference is which topic the instance has got access to."): one lookup
name per topic — a token instance serves `ls_color_<tokenId>` over its
topic (and `ls_amm`), no `ls_color`; the discovery instance `ls_color`
over `tm_color`; `ls_color_deploys` gone; a deploy's metadata asked of
`ls_color` at the host root (skein-1color 0.12.0).
0.19.0 (2026-10-29, David Case: the holders'
"request to list a token" is not part of Open Exchange, removed: the box
`amm/requests`, the read `/requests`, the pages' "Add to this exchange"
and Settings' requests list). 0.18.1 (2026-10-29, shruggr/skein#137: the
create/start ask names the topics the host routes to the instance). 0.18.0 (2026-10-28, shruggr/skein#137; David
Case: discovery is its own instance, "the Open Exchange's Settings page gets
an option to turn it on and off"): root's `{fn: "discovery", args: {on}}`
in `amm/admin` creates (or starts) the instance `discovery`, serving the
1Color discovery topic `tm_color` and its lookups, or stops it ("Discovery"
below). 0.17.0 (2026-10-28, shruggr/skein-amm#4; David
Case 2026-10-27/28: "Literally every new skein instance is the topic, which
is the deploy"): root of the config instance enables a token with one
message, `{fn: "enable", args: {tokenId, beef}}` in the box `amm/admin`,
and the config instance asks the host's instance manager for the token's
own instance — handle `<tokenId>`, image `token`, its topic
`tm_color_<tokenId>` and lookups in its config at birth, the config's
default terms and market minimum as its initial values, the deploy's BEEF
delivered into it (skein's `create {…, beef}`); `disable` stops it,
`enable` again starts it; the token app loses the register box and the
pages; the pages are the config instance's and reach each token's instance
at `<url>/amm` ("The config instance" below; docs/AMM.md). 0.16.0 (2026-10-24, shruggr/skein-amm#3; David
Case 2026-10-24: the market half of the validator's terms): the market's
terms are a runtime record root sets — `{fn: "market", args:
{minCommissionBps}}` in the box `amm/amm-p2p` sets a minimum commission,
`args: null` clears it, kept under the head `amm/market` (unset, 0);
`amm.swap.terms` answers it and the Swap page lists only the pools at or
above it ("N pools below this market's minimum commission"); a listing
preference, not a rule: the relay refuses nothing by it. The relay's
commission key is the instance's own, derived (BRC-43 level 1, `amm
commission` / `relay`, counterparty anyone), not `config.amm.commission`
(removed). Settings gains a root-only "Market terms" card. 0.15.0
(2026-10-24, shruggr/skein-amm#2; David Case 2026-10-23: "The configs should not be published in the image. This
will be a dynamic, competitive marketplace."): the validator's terms are a
runtime record root sets — `{fn: "terms", args: {lpFeeBps,
validatorFeeBps, commissionBps}}` in the box `amm/validator` sets them,
`args: null` clears them, kept under the head `amm/terms` — not
`config.amm.ammValidator` (removed, no fallback); set, this skein is a
validator; unset, a market only (`amm.pool.affirm` and the swap signing
refused "no terms: this skein validates nothing", `amm.pool.terms` "no
validator here", the beat without terms; skein-overlay 0.16.0 copies the
record into the beat). Settings gains a root-only "Validator terms" card.
0.14.2 (2026-10-23: on skein-overlay 0.15.1, whose engine
pauses a submission whose parent is held but not yet admitted and resumes
it on the parent's admission, shruggr/skein-overlay#6, and skein-1color
0.11.2). 0.14.1 (2026-10-23: the manifest also declares
the engine's receive row `/skein/overlay/beef/1.0.0`, filter `kernel.beef`,
handler `overlay.submit`, to which the host hands each Atomic BEEF a
catch-up fetches; without it a puller refused them "no route"; on
skein-1color 0.11.1). 0.14.0 (2026-10-23: the manifest declares the
engine's sync filter and the libp2p read row `/skein/overlay/sync/1.0.0`,
no handler, so a peer's catch-up is answered by the engine through the
front door, shruggr/skein#154; on skein-overlay 0.15.0 and skein-1color
0.11.0; a host serves the row once it takes #154). 0.13.2 (2026-10-23):
the pages read the token
list a page at a time, `limit` 100, as skein-1color's route takes it; the
Swap page shows every token's symbol and decimals again). 0.13.1
(2026-10-22): a BEEF out of order — a child before its parent, as a
wallet's ts-sdk writer emits — is sorted parents-first and verified, not
refused, by the chain app (skein-chain 0.6.1, which the image installs),
the engine (skein-overlay 0.14.1) and the validator and relay; skein-sdk
0.11.1. Since **0.13.0** (David Case, 2026-10-22; docs/AMM.md
"The pool rule", "The deploy and the affirmation", "The listing"): the
validator's nonce and affirmation live in every pool's state (Nonce,
Affirmation; message v2, no termsHash), the validator's first key is its
child keyed by the nonce it picks at `amm.pool.affirm {pool, satoshis}` →
`{validatorPubKey, nonce, signature}`, and `ls_amm_<assetId>` lists a pool only when
it derives that key itself and the affirmation verifies (a Swap's
continuation when it names the next key). The pages name no token input:
the deploy is one module-built createAction with the pool as its only
output. `Close(lpSig)` is the LP's alone with free outputs (the tokens go
straight to a module key, the sats to a BRC-29 key); the validator's
`Rescind` writes the pool back with its key cleared, which ends its swaps
and its listing (root's `rescind` replaces `close`). Pools from before
0.13.0 still close and recover in the pages. Since **0.12.1** (pages only):
Liquidity files the position row of a pool whose deploy left none, so Close
works for it. Since **0.12.0** (David Case, 2026-10-21/22; docs/AMM.md
"The pages and the wallet's module"): the pages hold the user's tokens in
the wallet's BRC-207 1Color module — Your tokens reads its assets and
balances (0.27.0: one `p color assets` read, granted with the group permissions on the first visit, each balance summed from its outputs), a pool deploy is the validator's affirmation and then one
module-built createAction, a tokens-in swap first sends its tokens into the
exchange's active swap basket (`amm-swap`) with one module send, token
payouts are locked to module receiving keys and taken in with a receipt,
and Move back returns what the swap basket holds. Since **0.11.0**
(docs/AMM.md "The pool rule", "The deploy and the affirmation", "The
listing", "Prices"): pool deploys move to the BRC-207 wallet module, so the
validator no longer appends a claim to a delivered deploy. Before the LP's
wallet builds the deploy, the page asks this skein's validator
(`amm.pool.affirm`) to affirm the proposed pool: it checks it against its
terms (0.15.0: the record root sets, `amm/terms`, `amm.pool.terms`; the
fees are the validator's, skein-wide) and answers its signature, by the pool's validator
key, over the pool's parameters and the hash of the terms; the deploy's
pool output carries it as its BRC-162 payload, and the deploy reaches the
overlay through the token topic like any token transaction. `ls_amm_<assetId>` lists
a deploy's pool only when that signature verifies, a swap's continuation of
a listed pool with it, and beats its prices (per token, per validator, its
listed pools' totals) on `ls_amm_<assetId>-live`. The contract is Swap and Close
(`Close(sig, bsvFee)`: the LP's with any bsvFee, or the current
validator's with bsvFee 0; everything out to the LP either way); delisting
is the validator's Close (root's `close`, the pool a caller input of the
instance's wallet, shruggr/skein#93). The pages are the Open Exchange
(Landing, Swap, Liquidity, Your tokens, Settings), at the origin root by a
root route. On skein-overlay 0.17.0 and skein-1color 0.12.1
(0.10.0: the 1Color rename, BRC-207's wire names, and the image moved here
from skein, shruggr/skein#152; CHANGELOG.md). Earlier versions are in
CHANGELOG.md. Ported from amm-poc (b-open-io/amm-poc, its `programs/`,
`pool/` and `web/`) in 0.1.0 (shruggr/skein#120).

**Names** (0.10.0, skein-1color 0.10.0; BRC-207's wire names): a token's
topic is `tm_color_<assetId>` (`tm_color_<txid>_0` at output 0), its lookup
`ls_color_<assetId>`, the discovery topic `tm_color` and its lookup
`ls_color` (0.20.0; `ls_color_deploys` until 0.19.0, gone), asked
BRC-207's query with `topic: "tm_color"` (0.20.1); every name of
`color-lookup` reads one index (head `<app>/ls_color`);
the programs are `color-topic` and `color-lookup`; the token list is the
read route `/color/tokens`; the 1Color pages are under `<base>/color/`. No
aliases: the names before 0.10.0 (`tm_mandala_*`, `ls_mandala*`,
`mandala-topic`, `mandala-lookup`, `/mandala/tokens`) are not recognised.
The SDK's own names are unchanged until 1sat-sdk renames them: the pages
import the template as `@1sat/templates/mandala` (the class `Mandala`), and
1sat-sdk files a token's outputs in the basket `mandala <txid> <vout>` under
the label `mandala`. The notes in this repo's docs that tell of earlier
versions are written in the current names; CHANGELOG.md keeps them as they
were.

## What it is

| role | file | what |
|---|---|---|
| `overlay` | `bin/overlay.wasm` | the overlay engine, skein-overlay 0.20.0's build (0.20.0: the `<topic>` mesh carries only `admit` verdicts, the host fetches the BEEF; no `want` events; every proof published; the sync `tail` read; beats every 120 s by default; 0.16.0: a topic's beat carries `terms` from the head `amm/terms`, the record amm-validator writes, none when unset; `{fn: "rebeat"}` from the instance re-declares every topic's beacon, shruggr/skein-overlay#7; 0.15.1: a submission whose parent is held but not yet admitted pauses and resumes on the parent's admission, shruggr/skein-overlay#6; 0.15.0: the sync protocol `/skein/overlay/sync/1.0.0` answered by its filter `sync` on this manifest's libp2p row, `filters.sync = "overlay.sync"`, no handler; its receive row `/skein/overlay/beef/1.0.0`, `kernel.beef` → `overlay.submit`, takes a catch-up's fetched BEEFs (0.14.1); 0.14.0: a topic's beat also carries its tip anchor; the reads `/holds`, `/anchors`, `/admitted` are the engine's, not routed by this manifest): serves the topics and lookups, keeps the registered sets (`register` / `deregister`, `registerLookup` / `deregisterLookup`, only in `amm/register`, root's) and, always (a market and a validator; `config.overlay.market` / `.validator` give the ms, absent here: 40 000 / 30 000), asks liveness of and beacons each registered token's `tm_color_<txid>_0-live` (the body its view digest) and each registered lookup's `<service>-live`, takes submissions by message (box `amm/submit`, answered to the sender's box) and by `POST /submit` (BRC-22: the STEAK) |
| `color-topic` | `bin/color-topic.wasm` | skein-1color 0.10.0's topic manager: one topic per token, `tm_color_<assetId>` (`tm_color_<txid>_0`), judged by the BRC-162 rules alone; the discovery topic `tm_color` |
| `color-lookup` | `bin/color-lookup.wasm` | skein-1color 0.12.1's lookup under a name paired with the topic that feeds it: a token instance's `ls_color_<assetId>` (BRC-207's `color-spendability` / `color-admission` over `tm_color_<assetId>`), the discovery instance's `ls_color` (BRC-207's two with `topic: "tm_color"`: a token's deploy, admission spent or not; and the token-id / outpoint queries over token topics); one index; the token list (the read route `/color/tokens`, its filter `tokens`) |
| `amm-lookup` | `programs/amm-lookup` | `ls_amm_<assetId>` (0.21.0; its index stays `<app>/ls_amm`): the listed pools (an affirmed deploy's pool and its continuations, unspent) of the token topic its instance serves, each query naming its token; its beat on `ls_amm_<assetId>-live`, the prices |
| `amm-validator` | `programs/amm-validator` | the validator, for every registered token (always): signs a taker's swap last and submits it to its own overlay by message, answering on the engine's answer (`swap`, a libp2p direct call); affirms an LP's proposed pool at its terms (`affirm`, called in-VM by amm-p2p, 0.11.0); both only while terms are set (0.15.0); root's `terms` (box `amm/validator`: the record `amm/terms`, set or cleared); root's `close` (box `amm/validator`): the contract's Close on the validator's path, the pool a caller input of the instance's wallet |
| `amm-p2p` | `programs/amm-p2p` | the marketplace relay (`amm.swap/1`, `amm.pool/1` with `terms`: a transaction carried to the validator the caller names), the read `/spends`; the market minimum (`amm/market`, else the config's `config["amm-p2p"].market`, 0.17.0) |
| `amm-setup` | `programs/amm-setup` | the token's setup (0.22.0): the deploy event in `amm/deploy` → the head `amm/token` and the token's `tm_color_<id>`, `ls_color_<id>`, `ls_amm_<id>` registered with the engine by call; the read `/token` |
| | `src/deploy.zig` | a 1Color deploy read from a BEEF (0.22.0; module `deploy`): amm-setup's event, open-exchange's swap app's enable |
| | `src/pool.zig` | the Pool contract as the overlay sees it: recognising a pool, its state, the pool checks (module `pool`, over the `1color` module's parser) |
| | `pool/` | the Rúnar contract (`Pool.runar.go`) and its Go tests |
| | `gen/` | the fixture generators (`src/fixtures/`) |
| | `web/ui`, `web/engine` | the pages (the Open Exchange: Landing, Swap, Liquidity, Your tokens, Settings) and the matching engine; the pages are built by shruggr/open-exchange (its `scripts/www.sh`, into its swap app's `www/`) |
| | `image/token/` | the token image (shruggr/skein#152): the chain app and the token app installed at birth (below, "The images"); Open Exchange installs the token app by tarball from its own `image/token` |

docs/AMM.md has the pieces, the pool rule, the interfaces, the rows and
what is not wired.

## Build

Zig 0.16.0 (`mise.toml`), Go 1.27 for `pool/` and `gen/`, Node 22 or later
and npm for the pages.

```
zig build test     # the pool library and the four programs, natively
zig build bin      # bin/: the token app's four programs, built; overlay.wasm and color-*.wasm, copied
go test ./pool/...
```

**The overlay and 1Color artifacts are fetched, not built here.**
`build.zig.zon` names skein-overlay v0.19.0 and skein-1color v0.13.0 by tag
URL and hash; `zig build bin` copies `bin/overlay.wasm` from the
skein-overlay package and `bin/color-topic.wasm`, `bin/color-lookup.wasm`
from the skein-1color package, byte for byte. skein-1color's pages are
outside its package's `paths`, so `scripts/color-pages.sh` fetches the same
tag's tarball by URL and checks its sha256 before copying its `www/` into
`www/color/`. `bin/` and `www/` are committed: what a skein installs is the
finished tree, and nothing is built on the skein.

The pages need two local checkouts (web/ui/README.md): Rúnar at
`~/Work/bsv/runar` (`RUNAR_DIR`; d207ee8e, the commit go.mod pins) and
1sat-sdk at `~/Work/bsv/1sat-sdk` (`ONESAT_SDK_DIR`), whose
sources are bundled; the committed `www/` (0.10.0, as 0.8.1 to 0.9.1) was built with
`ONESAT_SDK_DIR` at the embedded-icon draft, b-open-io/1sat-sdk#92
(aff025c3, unpublished; web/ui/README.md "The `Mandala` template from the
local 1sat-sdk checkout") and typechecked with the tsconfig paths pointed there (the
default checkout's master, 20947539, has a different icon form and does not
typecheck against these pages), before 0.8.0 with master 183c0ce3. The
template's own imports (`@ipld/dag-cbor`, `cborg`, `cbor2`, `@bsv/sdk`) are
web/ui's dependencies, deduped (vite.config.ts) and mapped (tsconfig.json),
so the checkout needs no `node_modules`. Their tests:

```
cd web/engine && npm ci && npm test
cd web/ui && npm ci && npm test && npm run typecheck
```

Regenerate the fixtures after changing `pool/Pool.runar.go`, from the repo
root: `go run ./gen/vectors` (0.9.0: it also writes the pages' compiled
artifact, `web/ui/src/pool/pool.artifact.json`, and their copy of the
transactions, `web/ui/test/fixtures/amm-topic-vectors.json`;
`gen/addliquidity` is gone with AddLiquidity).

## The token's setup (0.22.0)

shruggr/skein-amm#5 (David 2026-10-29/30): a token instance takes its
token as one event, with no config at birth. The host (shruggr/open-exchange#1's
program) creates the instance from `image/token` born owned (skein #164,
`Router.createInstance(handle, owner, {image, owned: true})`) and admits
`Router.admitEvent(handle, "amm/deploy", {kind: "deploy", beef})`:

1. The door (`kernel.beef` on the event route `deploy`): the BEEF decoded,
   its BUMPs checked against `chain/state`, the bytes replaced by the
   envelope; a bad BUMP or no BEEF: no entry (`DoorAnswered`).
2. `amm-setup.deploy`, one step: the deploy is the subject's first output
   that deploys (output 0 for a BRC-162 deploy; a legacy BRC-161 deploy
   where it is); the head `amm/token` ← `{tokenId, topic, lookup,
   ammLookup, sym, dec, icon?, txid, vout}`; then, called in-VM,
   the engine's `register {topic: tm_color_<id>, program: "color-topic",
   seed: [<txid>]}`, `registerLookup {service: ls_color_<id>, program:
   "color-lookup", topics: [tm_color_<id>]}`, `registerLookup {service:
   ls_amm_<id>, program: "amm-lookup", topics: [tm_color_<id>]}` (with them
   the subscriptions, liveness and beacons on `tm_color_<id>-live`,
   `ls_amm_<id>-live`). A refused registration fails the step: nothing
   is written.
3. The seed judges only what the chain app holds; a freshly delivered
   deploy is not held (the door stores the blocks, the chain app holds what
   is ingested), so the step also sends the deploy to the engine as the
   validator submits: `{fn: "submit", args: {beef, topics:
   [tm_color_<id>]}}` from the instance to itself in `amm/submit`; the
   engine admits it under `tm_color_<id>` once the chain app accepts it.
4. Refused, logged (the step's result record `refused`), nothing written:
   the head `amm/token` exists ("this instance has its token": the token is
   immutable), the record is not a deploy event or has no door envelope,
   the subject deploys no 1Color token.
5. `GET <instance>/amm/token`: the record as JSON (404 before the event).

The config app's create (its configured names, "The config instance"
below) still works and is unchanged; it is superseded by
shruggr/open-exchange#1, where the config app and `apps/config` move.

The event route needs skein main fa8077c or later: there the host takes an
app manifest's event route naming `kernel.beef` (a5c1897's kernel took it,
its host refused it at install: "an event route has no filters").

## The config instance (0.17.0)

The hosted shape (shruggr/skein-amm#4, shruggr/skein#160–#162): a one-key
host (`SKEIN_KEY_FILE`, one libp2p node), `SKEIN_MANAGER_FOR=<config
handle>` (the config instance has the instance manager in its address
book), and `SKEIN_IMAGES_DIR` holding the token image under the name the
config names, `config["amm-config"].tokenImage` (default `amm-token`: this
repository's `image/token`; give the name at the config's create, or hold
the image under that name). Create the config instance from `image/config`;
on a one-key host it is claimed by the shared key, which is then root of it
and of every token instance it creates ("same message, different signer":
on a self-run config a BRC-100 wallet user is granted root with `skein
grant`; no page does that). The flow, each step one message:

1. Root → config, box `amm/admin` (BRC-104-signed; `kernel.beef` on the
   route): `{fn: "enable", args: {tokenId: "<txid>_<vout>", beef}}`, the
   deploy's Atomic BEEF.
2. amm-config: the BEEF's subject must be the token id's transaction and
   its output `<vout>` a deploy (skein-1color's rules: sym, dec, icon);
   a token enabled, creating or starting already is refused. It records
   the token `creating` and asks the manager `create {handle: <tokenId>,
   image: <tokenImage>, config: {amm: {overlay: {topics:
   {tm_color_<tokenId>: "color-topic"}, lookups: {ls_amm_<tokenId>:
   {program: "amm-lookup"}, ls_color_<tokenId>: {program: "color-lookup", topics:
   [tm_color_<tokenId>]}}, terms?}, "amm-p2p": {market?}}}, beef,
   topics: [tm_color_<tokenId>, ls_color_<tokenId>, ls_amm_<tokenId>]}` — `terms` and
   `market` the defaults when set; `topics` (0.18.1) the names the host
   routes to the instance at the bare host. A `stopped` token: `start
   {handle, topics}` instead.
3. The host creates the instance, claims it with the shared key, publishes
   it at `/@<tokenId>`, hands the BEEF into its receive row and answers
   `{handle, identity, url, delivered: {verdict, reason?}}`.
4. amm-config: the token `enabled` (its `url`, `delivered`), or `failed
   {reason}`; root answered in `amm/admin` (`{fn, request, replyTo, result
   | error}`). A delivery that was not accepted leaves the token enabled:
   resubmit the deploy to `/@<tokenId>/amm/submit`.
5. `{fn: "disable", args: {tokenId}}`: `stop {handle}`, the token `stopped`.
6. `{fn: "defaults", args: {terms?: {lpFeeBps, validatorFeeBps,
   commissionBps} | null, market?: {minCommissionBps} | null}}`: the head
   `amm/defaults` (partial; `null` clears one), applied to the creates
   after it.
7. `GET <config>/amm/tokens` (newest first), `/defaults`:
   anyone, nothing logged.

A token instance's terms are its own (`amm/terms`, root's `{fn: "terms"}`
to `/@<tokenId>` in `amm/validator`, exactly as before); the default is
only its initial value (`config.overlay.terms`: the beat and the validator
read the head first — a record, the cleared `null` included, wins — else
the config's). The market minimum likewise (`amm/market`, else
`config["amm-p2p"].market`). The token instance's topic and lookups beat
from its config (skein-overlay 0.17.0) and its validator signs for every
topic the engine serves.

## Discovery (0.18.0)

`tm_color` is the 1Color discovery topic (BRC-207): every token's deploy,
whatever the token, a deploy looked up under `ls_color` by BRC-207's
`color-admission` with `topic: "tm_color"` (0.20.1: `{"type": "color-admission", "version": 1, "assetId": "<txid>_<vout>", "topic": "tm_color", "outpoints": ["<txid>.<vout>"]}`, the token
id `<txid>_<vout>` IS the deploy's outpoint; spent or not;
`ls_color_deploys` gone), so a
wallet or page can find tokens it has never seen. It is served by an
instance of its own (shruggr/skein#137), which root turns on and off from
Settings ("Discovery": one switch), one message each:

1. Root → config, box `amm/admin`: `{fn: "discovery", args: {on: true}}`.
2. amm-config asks the manager `create {handle: "discovery", image:
   <tokenImage>, config: {amm: {overlay: {topics: {tm_color:
   "color-topic"}, lookups: {ls_color: {program: "color-lookup", topics:
   ["tm_color"]}}}}}, topics: ["tm_color", "ls_color"]}` — no BEEF, no
   terms, no
   market — or `start {handle: "discovery", topics}` when it was stopped.
   The create/start ask names the topics the host routes to it (0.18.1). Its record, the head `amm/discovery`: `{on, status:
   creating | enabled | failed | stopping | stopped | starting, since,
   url?, reason?}`, moved by the manager's answer as a token's row is.
3. `{fn: "discovery", args: {on: false}}`: `stop {handle: "discovery"}`.
4. `GET <config>/amm/discovery`: the record, or `{"on": false}`.

Enabling a token does not submit its deploy to discovery: deploys are
submitted on deploy (the 1Color deploy page, `www/color/deploy/`, submits
each new deploy to `tm_color` at the pages' own origin). The host routes a
`POST /submit` with `X-Topics: tm_color`, and a `POST /lookup` for
`ls_color`, to the instance whose create or start named that topic
(skein's router, by the instance's row, whether or not it has run yet;
skein main fef7823 or later); with discovery off nothing here takes
`tm_color` and the answer is the config instance's own refusal. A deploy made before discovery was on
is resubmitted to it once by hand.

## Use (a single instance, 0.16)

A 0.16.3 instance keeps working on the token manifest: what root
registered stays served; the register box is gone in 0.17.0, so a new
token is enabled through a config instance instead (above).

The base URL of the app is `https://<handle>.<host>/amm` (on a host without
wildcard DNS, `<host>/@<handle>/amm`).

1. **Install the chain app, then the AMM**, as root (skein docs/APPS.md
   §3: the management page, or `skein plan install` and `skein send`):

   ```
   skein plan install https://github.com/shruggr/skein-chain#<commit> --origin <instance> --out chain/ && skein send <instance> chain/
   skein plan install https://github.com/shruggr/skein-amm#<commit> --origin <instance> --out amm/ && skein send <instance> amm/
   ```

2. **Deploy a token** at `<base>/color/deploy/` (anyone, with their own
   wallet). The page shows the token's topic, `tm_color_<txid>_0`, and its
   lookup, `ls_color_<txid>_0`.
3. **Register the token** at `<base>/color/tokens/` (root). The page
   sends root's messages to the app's box `register` (`amm/register`,
   shruggr/skein#128), which the route `{address: "register", handler:
   "overlay.register"}` takes to the engine, gated by `roles: {root:
   ["register", "registerLookup", "deregisterLookup", "market",
   "validator"]}` (shruggr/skein#143: any other key's message is recorded
   and runs nothing): its topic, then its lookup (BRC-207); deregistering
   reverses both:

   ```
   box:  amm/register
   body: {"fn": "register", "args": {"topic": "tm_color_<txid>_0", "program": "color-topic", "seed": ["<txid>"]}}
   body: {"fn": "registerLookup", "args": {"service": "ls_color_<txid>_0", "program": "color-lookup", "topics": ["tm_color_<txid>_0"]}}
   body: {"fn": "deregisterLookup", "args": {"service": "ls_color_<txid>_0"}}
   body: {"fn": "deregister", "args": {"topic": "tm_color_<txid>_0"}}
   ```

   `tm_color` (the discovery topic) is registered by `register` alone.
   The Settings page (0.9.0) sends the same, and registers `ls_amm` too —
   `{"fn": "registerLookup", "args": {"service": "ls_amm", "program":
   "amm-lookup"}}`, idempotent — so the AMM lookup's beat, the prices, is
   declared (skein-overlay 0.12: a registered lookup beats on
   `<service>-live` and keeps liveness on it).
4. **Market and validator, always** (0.8.1, skein-overlay 0.12.0; David
   Case, 2026-10-09: "every skein is marketplace AND validator from
   install, always"): no switch (0.6.2's `{fn: "market" | "validator"}`
   and the Token topics page's two switches are gone). The register above
   is the one act that drives both: the engine's `register` also emits
   `{event: "liveness", topic: "tm_color_<txid>_0-live", window}` — the
   runtime's liveness tool subscribes the topic without admitting its
   messages, verifies each beat and keeps the ones within the window in
   memory, served at `GET <base>/.live/tm_color_<txid>_0-live` →
   `[{sender, at, body, from}]` (404 when no liveness is kept; skein
   docs/MESSAGES.md "Liveness (#138)") — and `{event: "beacon", topic:
   "tm_color_<txid>_0-live", every, body}`: the host's node publishes a
   signed beat every `every` ms — the frame carries the instance's identity
   key (`sender`), the gossip message its peer ID (`from`), the body the
   topic's view digest `{view: {count, digest}}`, re-declared when it
   changes — and amm-validator signs swaps and affirms an LP's proposed
   pool for every registered token, refusing any other `not_validating`. A deregister
   reverses both (`unliveness`, `unbeacon`). The ms are
   `config.overlay.market: {window}` / `config.overlay.validator: {every}`
   (e.g. at install, `--config '{"overlay": {"market": {"window": 40000},
   "validator": {"every": 30000}}}'`), else 40 000 / 30 000; this manifest
   sets neither. `config.amm.ammP2p.market`, `heartbeatSeconds` and
   `offlineSeconds` are gone (`validator.every` is the beat,
   `market.window` the offline threshold), and so are `validate` /
   `unvalidate` (the box `amm/validate`), the validated set and amm-p2p's
   start / stop.

   **The validator named** (0.4.0): the Swap page reads each token's
   `.live` read, takes each beat's `sender` (the validator) and `from` (its
   peer ID), plans only over the pools whose validator beat within the window, and sends
   `amm.swap.submit` with that validator's `peerId` beside its `validator`
   key (a deploy names this skein's own validator, `amm.pool.terms`, and
   asks it `amm.pool.affirm`). The relay looks at no liveness: it dials `peerId`, or, when
   `peerId` is its own node's, calls its own `amm-validator` in-VM with the
   same package, as the front door calls the route's handler for a frame.
5. **The terms** (0.9.0, David Case 2026-10-09: "Fees are the
   validator's"; 0.15.0, 2026-10-23: a runtime record root sets, no fee
   numbers in the image): root's message `{fn: "terms", args: {lpFeeBps,
   validatorFeeBps, commissionBps}}` (each an integer, 0 to 10 000) in the
   box `amm/validator` sets them, `{fn: "terms", args: null}` clears them
   (the role `root` gates `terms`); amm-validator keeps them as the root
   of the head `amm/terms` (the record `{lpFeeBps, validatorFeeBps,
   commissionBps}`, or `null` once cleared), answers root, and sends the
   instance itself `{fn: "rebeat"}` in box `amm` so the engine re-declares
   every topic's beat with them. Every pool this skein hosts carries them
   exactly: an LP posting here accepts them, and the validator affirms no
   pool whose fees differ (`fees_unacceptable`). None set: a market only —
   `affirm` and `swap` are refused `not_validating`, "no terms: this skein
   validates nothing", `amm.pool.terms` answers "no validator here", and
   the beat carries no `terms`. `config.amm.ammValidator` (0.9.0 to 0.14.2)
   is gone, with no fallback. The pages read them with `amm.pool.terms`
   and set them from Settings.
   **The market's terms** (0.16.0, shruggr/skein-amm#3): root's message
   `{fn: "market", args: {minCommissionBps}}` (an integer, 0 to 10 000) in
   the box `amm/amm-p2p` sets this market's minimum commission, `{fn:
   "market", args: null}` clears it (the role `root` gates `market`);
   amm-p2p keeps it as the root of the head `amm/market` and answers root.
   Unset, 0. `amm.swap.terms` answers it beside the commission pkh, and
   the Swap page lists and quotes over only the pools whose commission is
   at or above it. A listing preference of this market, not a rule: the
   relay refuses nothing by it. The commission pkh is hash160 of the
   instance's own key (BRC-43 level 1, protocol `amm commission`, key ID
   `relay`, counterparty anyone), not config (`config.amm.commission`, to
   0.15.0, is gone).
6. **The pages** at `<base>/` (and at the origin's root, below), served
   from the app's own tree (`www/`): the Open Exchange — Landing (the
   hosted tokens, their prices from the beats), Swap, Liquidity (deploy a
   position at the terms; close one, one wallet action whose fee the
   wallet pays, 0.29.1), Your tokens, Settings
   (root: the validator's terms, 0.15.0; the market's terms, 0.16.0; register and deregister a token;
   "Enable a token" is one list, one Enable per token, no typed id and no
   pasted BEEF: the tokens on discovery — the discovery instance's
   `<origin>/@discovery/1color/color/tokens` — and the asset ids of the
   connected wallet's held token outputs (`p color assets`), minus every
   token already on the list, enabled or disabled; the deploy's BEEF from
   the wallet's module basket `p color <txid>v<vout>` when it holds it,
   else discovery's `ls_color` `color-admission` answer at the host root,
   else refused "no deploy for <id>: not on discovery and not in this
   wallet"; with discovery off, only the wallet's tokens are listed);
   the 1Color pages
   at `<base>/color/`. They read `<base>/listTopicManagers`,
   `<base>/color/tokens`, `<base>/.live/<topic>` (the beats),
   `<base>/lookup` (`ls_amm_<tokenId>`, `ls_color_<tokenId>`),
   `<base>/spends?outpoint=`, and call `<base>/call` (the relay),
   `<base>/submit` (a Close) and `<origin>/sendMessage` (root's
   registers). Settings is the admin's (its nav link shows to the admin or
   root, and to any wallet while the exchange is unclaimed; 0.28.0: `isRoot` =
   swap's `GET <base>/admin` names the wallet, or the host's
   `GET <origin>/skeins?key=<wallet key>` names swap); while `/admin` names
   nobody it shows the card "Claim this exchange": the wallet's
   `{fn: "claim"}` in box `amm/claim` to swap, and the host grants that
   wallet `amm.admin` (open-exchange 0.5.0: swap is the host's).

   **At the origin's root** (the landing at `/`, shruggr/skein#147): root
   adds a root route to the same filter (skein-overlay README "Root
   routes"; the pages then take `<origin>/amm` as the app's base, 0.8.1):

   ```
   skein routes add --transport http --prefix --filters amm.page --settings '{"root":"www","index":"index.html"}' / <origin>
   ```

7. **Close by the validator** (0.11.0, in place of 0.9.0's rescind): the
   validator delists a pool by the contract's Close — root's message in
   `amm/validator`:

   ```
   box:  amm/validator
   body: {"fn": "close", "args": {"pool": "<txid>.<vout>"}}
   ```

   `pool` is any of the pool's outputs (its deploy's `<txid>.0` too):
   amm-validator follows it to the newest, has the instance's wallet build
   the Close with the pool as a caller input (createAction with the pool's
   unlocking script to come, the contract's two outputs to the LP key; then
   signAction with the Rúnar call, `sig` the pool's current validator key's,
   bsvFee 0, the wallet paying the fee and keeping its change;
   shruggr/skein#93), submits it to the overlay and answers root `{fn:
   "close", request, result}`. The LP gets every sat and every token, as on
   its own Close; `ls_amm_<assetId>` lists the pool no more.

**Submit and look up** (BRC-22, synchronous: skein-overlay 0.9.1; by message instead, answered later to the submitter's box; BRC-24):

```
POST <base>/submit                     → 200, the STEAK (BRC-22; 503 + Retry-After while undecided)
X-Topics: ["tm_color_<txid>_0"]
Content-Type: application/octet-stream
<BEEF>

POST <base>/lookup
{"service": "ls_amm_<txid>_<vout>", "query": {"tokenId": "<txid>"}}                          (listed pools only, 0.9.0; the per-asset name 0.21.0)
{"service": "ls_amm_<txid>_<vout>", "query": {"tokenId": "<txid>", "outpoint": "<txid>_0", "beef": true}}
{"service": "ls_amm_<txid>_<vout>", "query": {"tokenId": "<txid>", "validatorIdentityKey": "<hex>"}}
{"service": "ls_color", "query": {"type": "color-admission", "version": 1, "assetId": "<txid>_<vout>", "topic": "tm_color", "outpoints": ["<txid>.<vout>"]}}   (the discovery instance: a deploy, at the host root, 0.20.1)
{"service": "ls_color_<txid>_0", "query": {"type": "color-spendability", "version": 1, "assetId": "<txid>_0", "topic": "tm_color_<txid>_0", "outpoints": ["<txid>.1"]}}
```

At the skein's origin (the @bsv/sdk clients' form), once root adds the two
root routes (skein-overlay README "Root routes"):

```
skein routes add --transport http --filters kernel.beef --fn submit /submit amm.overlay <origin>
skein routes add --transport http --filters amm.lookup /lookup <origin>
```

## The images

`image/token/` and `image/config/` (0.17.0; until 0.16.3 `image/`) are the
two skein images (shruggr/skein#152: an image carries no apps):

```
skein-host add <h> --image <this repo>/image/config     # the config instance
skein-host add <h> --image <this repo>/image/token      # a token instance (the config's creates do this by name)
```

`image/config/etc/apps.json` installs the chain app (the door's `kernel.beef`
checks an enable's BEEF against the host chain) and `../../apps/config`, and
adds root's route `/` (the pages, the filter `amm.page`). `image/token/`
is as `image/` was, less the pages' root route: its `etc/apps.json` installs, at birth, the chain app (shruggr/skein-chain
v0.7.0 by its release tarball (the host chain, shruggr/skein#156: its state
points at the host's header chain), checked by its tree's git id; this app
requires `chain/1`, and the chain app has no start message, so a genesis can
carry it) and then this app (`../..`, the repo root), and adds root's two
routes: `POST /submit` (`kernel.beef`, the engine's `submit`) and `/lookup`
(the filter `amm.lookup`). A token instance's topic comes from its create's
config. Neither directory may be reached through a symlink (`..` resolves
beside the link).

On skein main ac20aea, `skein-host add --image <dir>` boots a directory as
a whole system tree (it needs `etc/dispatch.json` and the boundary
programs), so `image/` as committed (only `etc/apps.json`, as
shruggr/skein-collection's `image/`) is refused there with
"etc/dispatch.json: missing"; booted over skein's `images/default` (its
files copied beside this `etc/apps.json`) it makes the genesis above.

## Versions

| | |
|---|---|
| this app | 0.42.1 |
| skein | 0.22.0: main fa8077c or later (an event route naming `kernel.beef` in a manifest; the event door and born-owned instances, a5c1897, shruggr/skein#164); main 2eafff1 or later for discovery (a bare-host overlay request routed to the instance that declares its topic, shruggr/skein#137); 61a39e0 or later: the instance manager's `create {…, config, beef}` (shruggr/skein#162; skein-amm#4: the BEEF delivered, `delivered` in the answer), one-key hosts and path-only token-id handles (#160, #161) |
| skein-overlay | v0.20.4 (d9ead8a) by tag URL and hash (`build.zig.zon`): the engine in `bin/` (0.20.4: a lookup hook hands back `events` the engine emits in the same step — amm-lookup's pool events; 0.20.3: a re-pin on skein-sdk 0.13.0, the tree's `floor` and `Map.range` the pool lookup reads with; 0.20.2: the configured lookups' liveness on `rebeat` too; 0.20.1: `rebeat` re-declares the liveness window too; 0.20.0: announce, then fetch, the settled sync design; 0.18.0: register / registerLookup callable in-VM from a program of the instance, skein-overlay#10; 0.17.0: configured topics and lookups beat, `config.overlay.terms` the beat's initial terms, shruggr/skein-overlay#8; chain/state through skein-sdk's `chain.open`, 0.16.1; the beat's terms from `amm/terms`, 0.16.0), its filter `sync` on the libp2p row `/skein/overlay/sync/1.0.0` (0.14.0) and its receive row `/skein/overlay/beef/1.0.0` (0.14.1), the modules `topic` (0.13: a verdict's `ancillary_txids`, empty here), `lookup` (0.12: a lookup's beat, `Spec.beat`, `Service.beat`; 0.20.4: `Service.emit`), `sk`, and its engine sources for amm-validator and amm-p2p |
| skein-1color | v0.15.3 (43fc69b; shruggr/skein-mandala until 0.9.2) by tag URL and hash: `bin/color-*.wasm` (0.15.3: a re-pin on skein-overlay 0.20.4; 0.15.2: a re-pin on skein-overlay 0.20.3; 0.15.1: a supply-holding deploy is a value output, an authority-only deploy an authority — every deploy had been filed as an authority, an error; 0.15.0: the balance table and `/<token>/holders`, the discovery rows' `amount` and `height`; 0.14.0: the discovery read routes; 0.13.3: on skein-overlay 0.20.2; 0.13.2: on skein-overlay 0.20.1; 0.13.0: color-topic's MissingParents; 0.12.0: `color-lookup.wasm` rebuilt, `ls_color_deploys` gone; 0.12.1: `ls_color` answers BRC-207's query over `tm_color`), the module `1color`; its pages by the tag's tarball and sha256 (`scripts/color-pages.sh`) |
| skein-sdk | v0.13.0, through skein-overlay (`files` serves the pages; `sk.peerAt` finds the host's providers; 0.13.0: the tree's `floor` and `Map.range`, the pool lookup's windowed reads) |
| skein | the wallet program's caller inputs (shruggr/skein#93, main 2231398: the validator's Rescind, 0.11.0–0.12.x its Close, createAction / signAction); log format 10, the BEEF envelope beside the pointer record (shruggr/skein#146); routes-roles e3f50fe (format 9: routes, filters, roles, shruggr/skein#143); before, main f45c887 (the liveness tool and `GET /<app>/.live/<topic>`, docs/MESSAGES.md "Liveness (#138)"; the beacon's signed frame, "Beacons"; the node's key from the instance root, signer.ts `peerKey`) |
| requires | `chain/1` (shruggr/skein-chain; the image installs v0.7.1: a reorg broadcasts nothing) |
| Rúnar | d207ee8e (go.mod; the pages' runar-sdk) |
| the pages | `@1sat/actions`, `@1sat/connect`, `@1sat/react`, `@1sat/templates`, `@1sat/types` 0.1.1 (published; `OneColor`); upstream `@bsv/sdk` 4.0.0, `@bsv/templates` 2.1.0, `@bsv/color-permission-module` 0.1.0 and `@bsv/wallet-toolbox-client` 2.15.0 (`overrides`, one copy each; `web/ui/package-lock.json`) |

## Contributing

Work is tracked in shruggr/skein; start at issue
[#31](https://github.com/shruggr/skein/issues/31), this repo's issue is
[#120](https://github.com/shruggr/skein/issues/120). MIT, as skein.
