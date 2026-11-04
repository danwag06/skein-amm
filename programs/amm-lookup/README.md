# amm-lookup

The AMM pool liquidity lookup service, served as `ls_amm_<assetId>` (skein-amm
0.21.0, paired with `tm_color_<assetId>` as `ls_color_<assetId>` is): a lookup service on
skein-overlay 0.6.0's lookup contract (the `lookup` module). One service over
every 1Color token topic the overlay serves (`tm_color_<txid>_<vout>`, judged by
skein-1color's topic manager: plain BRC-162 rules, no AMM knowledge). It
judges which admitted outputs are pools worth indexing by running the pool
checks (`src/pool.zig`, the `pool` module), keeps an index of the unspent
ones that pass, per token, and answers the matching engine's inventory
queries from it.

Ported from amm-poc `programs/amm-lookup`, where it was one service per token
(`ls_amm_<txid>`, its own head per token, a `topics` list in the manifest).
Here `config.overlay` names it with no `topics` list, so it listens to every
topic the overlay serves, declared or registered with the engine
(shruggr/skein#120), and every query names its token. Since skein-amm 0.21.0
the name is per token again, `ls_amm_<assetId>`, given in a token instance's
create (one token topic per instance); the index stays one head,
`<app>/ls_amm`, whatever name it is served as.

```
zig build test-amm-lookup    # from the repo root: the checks, the index, the queries, natively
```

## 0.13.0: the pool attests itself; the next key; Rescind (David Case, 2026-10-22)

This supersedes 0.11.0 below (docs/AMM.md "The listing"). The validator's nonce and affirmation are in every pool's state (no payload). A pool output is **listed** when (a) it attests itself (src/pool.zig `affirmed`: not rescinded; its ValidatorPubKey is the ValidatorIdentity's child keyed by its Nonce, derived here with bsvz, not trusted; its Affirmation is that key's signature of message v2), or (b) its transaction calls Swap (the pool input's last push, `methodOf`) on a listed pool of the token and its ValidatorPubKey is the identity's child keyed by that spent outpoint (`nextKeyOf`). Never listed: a rescinded pool (ValidatorPubKey 33 zero bytes, the validator's Rescind), a pool-shaped output of a Close (whose outputs are free), a continuation naming another key, a deploy under a key of the LP's own (v0.11.0's defect: its signature verified, its key was not derived). A listed pool leaves the listing on the LP's Close or the validator's Rescind.

## 0.11.0: the affirmation is the listing (David Case, 2026-10-21)

This supersedes 0.9.0's claim below. A deploy's pool is **listed** only when its pool output carries the validator's affirmation as its BRC-162 payload and it verifies (src/pool.zig `affirmed`: the ValidatorPubKey in the pool's state signed `affirmDigest` of the pool's parameters, its satoshis and the hash of the terms its fees are; docs/AMM.md "The deploy and the affirmation"). A transaction spending a listed pool (`pools`; `spent` runs after `admitted`) lists its continuation (a Swap's output 0, which carries no payload). Only listed pools are indexed: an unaffirmed deploy, a forged affirmation or a field changed since it was signed is not in `pools` at all, so `{tokenId, outpoint}` of it is `UnknownOutpoint` (0.9.0's `NotListed` is gone). A Close (the LP's or the validator's) spends the pool with no continuation: it leaves the listing. The maps `claims` and `spentClaims` and the record's `claim` are gone; `coinsRetained` is not read.

## 0.9.0: the claim and the listing; the beat (David Case, 2026-10-09)

A pool is **listed** only while both its contract output and its claim output are unspent, and only if the claim verifies (src/pool.zig `verifiedClaim`: one unit of the token after output 0, its payload the pool's ValidatorPubKey's signature over the pool's script and the first token input — the topic's first retained coin, else input 0 — that key `validatorKey(ValidatorIdentity, first token input)`, the claim P2PKH to it). Two more maps: `claims` (`tp ‖ claim outpoint → null`, the live verified claims) and `spentClaims` (a claim a spend consumed, for `rejected`). A deploy's pool is indexed with its claim (`claimFor`); a continuation carries the claim of the pool it spends (in `pools` still: `spent` runs after `admitted`); a deploy with no verified claim is not indexed. `spent` of a claim (the validator's rescind) moves it to `spentClaims`: every pool of that deploy is unlisted; `rejected` gives it back. **Every query answers listed pools only** (`{tokenId}`, `{tokenId, validatorIdentityKey}`; `{tokenId, outpoint}` a pool not listed: `NotListed`).

**The beat** (skein-overlay 0.12): the service's body on `<service>-live` (`ls_amm_<assetId>-live`, 0.21.0) is dag-cbor `{tokens: {<assetId>: {<validator identity, hex>: {sats, tokens, pools}}}}`, this skein's per-token, per-validator totals of its listed pools (`beatValue`); fn `beat` answers it at the beacon's declaration (`Spec.beat`), and a hook hands a new one to the engine (`Service.beat`) only when it changed (the last body's record kept in the map `beat`). The engine declares a lookup's beacon for a **registered** service: root registers `ls_amm` (`registerLookup {service: "ls_amm", program: "amm-lookup"}`) beside its manifest declaration (0.9.0; since skein-overlay 0.17.0 a configured lookup beats too, and skein-amm 0.21.0 configures `ls_amm_<assetId>` at the create).

## Layout

| file | what |
|---|---|
| `src/index.zig` | The pool checks as this service's judgement (`judge`), the index (the hooks) and the queries (`answer`), independent of the VM. |
| `src/main.zig` | `metadata` and `documentation` (skein-overlay#2: the listing and documentation routes), and `lookup.main(idx.spec)`. |
| `test.zig` | Tests over the generated fixtures (`src/fixtures/vectors.zig`, from `pool/Pool.runar.go`). |
| `fixtures/pool-state-answer.json`, `fixtures/outpoint-answer.json` | The wire shape of a `{tokenId}` and a `{tokenId, outpoint}` answer ("The engine's PoolState shape" below). |

## Names

A query names its token with `tokenId`, in any of skein-1color 0.4.0's forms
(the `1color` module's `name.tokenIdOfString`): `<txid>`, `<txid>_<vout>` or
`<txid>.<vout>`. `<txid>`, `<txid>_0` and `<txid>.0` all name the token at
output 0 and its topic `tm_color_<txid>_0` (skein-1color 0.8.2: the topic is
`tm_color_<assetId>`, `_0` included); `<txid>_<vout>` with a non-zero vout
names `tm_color_<txid>_<vout>` (a BRC-161 token). Any other id is refused. A hook
for a topic that is not a token's (`tm_color`) does nothing. A pool
exists only for a token whose binary id is 32 bytes (a token deployed at
output 0): the Pool contract hard-codes a 32-byte id push.

## The pool checks (`judge`, run by `admitted`)

The checks `pool.check` runs, unchanged: a pool is at output 0; its prefix
id and amount equal the asset id and TokenReserve its code and state carry.
A transaction whose pools fail has none of them indexed; they stay valid
token outputs in the topic, not searchable here.

The ValidatorPubKey is not checked (decided 2026-10-01): a pool with any
validator key is a pool to the overlay and is indexed. How a validator
derives its signing key is its own convention (amm-validator checks its own
key before signing).

The checks read only the admitted token outputs (`outputsToAdmit`);
`coinsRetained` and the spent coins' sources are not read.

## The index

Under the service's own head, `<app>/ls_amm` (the engine keeps it; the app
writes only under its own name), three maps. `tp` = len ‖ topic (skein-sdk
`store.nameKey`), so every key is per token; an outpoint = txid (internal
order) ‖ vout, big-endian u32:

| map | key → value | |
|---|---|---|
| `pools` | `tp ‖ outpoint → record` (a CID link) | an unspent listed pool output the topic admitted (0.13.0: a self-attesting pool, or a Swap's continuation of a listed pool naming the next key) |
| `byValidator` | `validatorIdentityKey (33 bytes) ‖ tp ‖ outpoint → null` | a set index for the validator queries; from 0.33.0 a spent pool keeps its row (only `rejected` removes it), `{validatorIdentityKey}` filtering to the live ones |
| `byLp` (0.33.0) | `lpPubKey (33 bytes) ‖ tp ‖ outpoint → null` | every listed pool of an LP key, live and spent; only `rejected` removes it |
| `rescinded` (0.33.0) | `tp ‖ lpPubKey → pool record` (a CID link, as `pools`) | the output a validator's Rescind of a listed pool of that key wrote (not listed); removed when the Rescind is rejected |
| `spentPools` | `tp ‖ outpoint → record` (a CID link) | a checked pool a spend consumed, kept for `rejected` to give back and for `{outpoint}` to follow |
| `fees` (0.33.0) | `tp ‖ lpPubKey (33 bytes) ‖ swap txid → fee row` (a CID link) | one row per Swap admitted, under its pool's LP key: `{kind: "amm-swap-fees", lp, validator, commission, bsvIn, commissionPkh}`, the three fees in the input asset (src/pool.zig `feesOf`, the outputs where the relay's pair check finds them) |
| `byCommission` (0.33.0) | `commissionPkh (20 bytes) ‖ tp ‖ swap txid → the same fee row` | the Swaps that paid a commission (not 0) to that key hash |

The fee rows exist for Swaps admitted from 0.33.0 on: a Swap admitted
before has none (no backfill). `admitted` writes them for a listed Swap
continuation; `rejected` removes them.

The record (`{kind: "amm-pool", txid, vout, bsvReserve, tokenReserve,
liquidityFeeBps, validationFeeBps, commissionBps, lpPubKey,
validatorIdentityKey, admittedAt}`) carries every field `pool.zig` parses
but the rotating ValidatorPubKey. `admittedAt` is always `null`: a hook has
no time source.

**The hooks**:
- `admitted`: run the pool checks; when they pass, index each output in
  `outputsToAdmit` that is a pool. When they fail, index nothing (the
  reason has no place in the contract: a hook returns `void`).
- `spent`: move the spent pool from `pools` to `spentPools`. The
  continuation arrives through its own `admitted` call.
- `rejected`: drop the transaction's own pools (live or spent) and move
  each pool it had spent from `spentPools` back to `pools`, as it was
  indexed when first admitted.

## Queries (`/lookup`, service `ls_amm_<assetId>`)

Every query names its token (`tokenId`, above); a query without one is
refused.

- `{tokenId}`: every live pool of the token, a freeform list in the
  engine's `PoolState` shape plus `outpoint: "<txid>_<vout>"`.
- `{tokenId, outpoint}`: that pool, or its newest continuation, `{current,
  hops}`. From an outpoint that is not live, the walk follows the spends
  forward: a hop is a checked pool this topic indexed and a spend consumed
  (`spentPools`), its spender is the chain state's (`spentBy`, the chain
  app's `chain/state`, read only), and the continuation is output 0 of the
  spend. An outpoint in neither map, or a spend that did not recreate a
  pool, is `UnknownOutpoint`. (amm-poc followed the wallet library's
  topic-aware `spender` join over the head `wallet`; that state is gone since
  skein #79.)
- `{tokenId, outpoint, beef: true}`: the `output-list` form of the same
  outpoint, whose BEEF the engine builds from the chain state.
- `{tokenId, validatorIdentityKey}`: that validator's live pools of the
  token, via `byValidator`.

The fee queries (0.33.0) take a list and answer one record per key, in the
list's order; an unknown key answers zeros. From the fee rows only, so for
Swaps admitted from 0.33.0 on:

- `{tokenId, lpPubKeys: [<hex 33>]}` → `[{lpPubKey, status, outpoint?,
  current?, sats, tokens, swaps}]`: the LP fees of the pool of that LpPubKey
  (`sats` from sats-in Swaps, `tokens` from token-in) and its state:
  `status: "live"` with `outpoint` and `current` (`PoolState` shape), found
  through `byLp` (its pools, the live one in `pools`); `"rescinded"` with
  `outpoint` and `current` (the Rescind's output and its pool state, what
  the LP's Close takes back) when the
  key's `rescinded` record names an output the chain state has unspent;
  else `"closed"` (the Close spent it, or no pool of the key here);
- `{tokenId, validatorIdentityKeys: [<hex 33>]}` →
  `[{validatorIdentityKey, sats, tokens, swaps, pools}]`: the validator fees
  over the rows of all its pools, closed included (`byValidator` → each
  pool's LpPubKey → its rows); `pools` the distinct pools (LP keys) counted;
- `{tokenId, commissionPkhs: [<hex 20>]}` → `[{commissionPkh, sats, tokens,
  swaps}]`: the commissions the Swaps naming that key hash paid
  (`byCommission`).

### The engine's `PoolState` shape

```ts
interface PoolState {
  outpoint: string;
  bsvReserve: bigint;
  tokenReserve: bigint;
  liquidityFeeBps: bigint;
  validationFeeBps: bigint;
  commissionBps: bigint;   // the Pool's CommissionBps (the relay's commission)
  validatorIdentityKey: string;
  lastSeen?: number;
}
```

The `/lookup` route renders a dag-cbor integer as a plain JSON number, so a
reserve above 2^53 - 1 loses precision in a client's `JSON.parse`. That is
the route's encoding, not this service's. `validatorIdentityKey` is
lowercase hex text.

## Liveness join

`setLiveJoin` / `liveOf` merge `lastSeen` from a `live` map
(`identityKey → {peerId, at}`) when one is wired; nothing wires one in
`main.zig` (since skein-amm 0.4.0 liveness is the runtime's read, `GET
/amm/.live/tm_color_<txid>_0-live`, which the page joins itself; no map is kept in
the graph). Without a join, `lastSeen` is left out.

## Tests

Over the generated fixtures (held in a `MemStore`) and hand-built spends
sharing the compiled Pool template:

- names: every token id form to its topic; other ids refused; a query
  without a token refused;
- a pool deploy that passes is indexed once, and the answers match the
  engine's shape; `commissionBps` answered;
- pools that fail a check are not indexed (prefix amount ≠ TokenReserve, a
  pool at output 1);
- a pool with any validator key is indexed;
- another topic's call indexes nothing;
- a swap replaces the pool it spent; a rejection restores it from
  `spentPools`;
- `{outpoint}` follows three hops to the newest continuation over the
  chain state's spends;
- `{validatorIdentityKey}` returns only that validator's pools;
- the liveness join.
