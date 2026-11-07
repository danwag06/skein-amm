# amm-p2p

The AMM app's **functions** (interfaces `amm.swap/1`: `terms`; `amm.pool/1`: `terms`, `affirm`), its **read routes**, the **market record** and the app's pages, with the proofs-by-block direct call and the catch-up pass as utilities nothing routes or schedules (#2, the pull half of proof sync), as one [skein](https://github.com/shruggr/skein) program (Zig 0.16.0, wasm32-wasi), the `amm-p2p` program of the `amm` app (`etc/app.json`). 0.44.0: **no swap relay** here — the open-exchange host relays (below). The design notes cited below are amm-poc's docs/notes.md.

```
zig build test-amm-p2p   # from the repo root: the proofs-by-block direct call's serving side, the names, the
                         # direct call's shapes (stream.zig); amm.swap/1 by the manifest (terms only); the
                         # affirmation's body and answer; the commission key; the reads, natively
```

## 0.44.1 (no catch-up pass, David Case 2026-11-06)

This section supersedes what the rest of this file says where they differ. The **catch-up pass** — the pull half of proof sync, a cron-ticked job (`{kind: "amm-p2p-tick", job: "catchup"}` in box `amm/amm-p2p`) that dialled configured peers on `/amm/proofs/1.0.0` with its own reply deadline, a placeholder from before the overlay sync that nothing scheduled and no install configured peers for — is **gone, whole**: the job and its tick (src/schedule.zig), its config (`config.amm.ammP2p` / genesis `defaults.ammP2p`: `topics`, `peers`, `window`, `batch`, `replyTimeoutMs`), its cursor state under `amm/p2p` (a record an earlier version wrote is not read), the provider bodies it sent (`dial`, `send`, `close` and their answers, stream.zig), the plan (`proofs.catchupPlan`) and its tests. What it shared and what stays: the **serving side of proofs by block** (`proofsByBlock`, a direct-call handler no row routes: proofs.zig's codec and `serve`, views.zig's `held`, stream.zig's `inbound` / `directAnswer`). This program received no gossip of its own (the overlay engine's), so nothing else changed. The program now steps only on messages in its box (`{fn, args}` calls and root's `market`).

## 0.44.0 (the host is the relay, David Case 2026-11-06)

This section supersedes what the rest of this file says where they differ: every older section below that describes the relay, its records, `expires` or `/swaps` describes what is gone.

"The instance logs FACTS, never ATTEMPTS." A swap being forwarded is an attempt, so nothing of it is in this program any more. **Gone:** `amm.swap.submit` and `amm.swap.status` (the manifest declares neither), the swap records and the app state's `swaps` map (`{kind: "amm-app-state", swaps}` under `amm/app`: a record an earlier version wrote is not read), the relay thread (`{kind: "amm-swap-relay", id}`: its dial, its frame, its deadline), the local relay to this instance's own validator, the read `/swaps` (P10) and its filter, every `expires`. relay.zig is gone; what the remaining functions use of it is `src/interface.zig`; the direct call's shapes the catch-up and `proofsByBlock` use are `src/stream.zig` (libp2p.zig, less the topic verdicts and `publish`, which nothing used).

**Who relays now.** The open-exchange host (TS) serves `POST /@<tokenId>/amm/swap` (plain, no BRC-104 session): it checks the commission rule below and nothing else, signs the package with the token instance's key outside any step, carries it to the validator over libp2p on one stream (one request frame, one answer frame) — or hands it to a validator on its own node as that node's inbound frame — submits a `beef` the answer carries to the token instance's overlay, and answers the page. The validator (amm-validator) is unchanged: its protocol, checks, lock and answers.

### The commission rule (the host's one check; was `checkPair`'s `commission_missing`)

This exchange takes its commission at `pkh` = **hash160 of the token instance's own key** for the commission: the signer's public key for **BRC-43 security level 1, protocol `amm commission`, key ID `relay`, counterparty `anyone`, forSelf** (interface.zig `commission_protocol` / `commission_key_id`; main.zig `commissionKey`; `amm.swap.terms` answers it as `commissionPkh`). Anyone can derive the same public key from the instance's identity key (BRC-42 with the anyone key as the counterparty; test.zig "the commission key"); only the instance can sign for it.

A swap (the raw transaction the page sends) is relayed only when:

1. input 0's unlocking script is a Rúnar call of the pool's **Swap** (src/pool.zig `parseSwapCall`: exactly 13 pushes, the last the method index 0) — the pushes `_codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh, commissionPkh, tokenChangePkh, tokenChange, _changePKH, _changeAmount, txPreimage, methodIndex`;
2. output 0 is the pool's continuation (a 1Color value output whose lock src/pool.zig `parse` reads as the Pool code) — its **CommissionBps** is the pool's (the contract keeps the rate along a lineage);
3. the commission `feeOf(amountIn, CommissionBps)` = ⌈amountIn · CommissionBps / 10 000⌉ is nonzero exactly when CommissionBps > 0 (amountIn > 0); then the call's **`commissionPkh` (push 6) must equal `pkh`**. The contract itself pays the commission output (src/pool.zig `feeLayout`: output 2 + one per nonzero LP and validator fee) to that `commissionPkh` in the input asset, and the validator checks the whole transaction, so naming the key is the whole rule.

A pool with CommissionBps 0 has no commission: any `commissionPkh` passes. A swap whose call or continuation does not read as above is refused too (the rule cannot be shown); everything else is the validator's to judge. A refusal is answered to the page with nothing logged anywhere.

## 0.13.0 (the validator's nonce, David Case 2026-10-22)

- **`amm.pool.affirm`**: `{pool: bytes, satoshis: int}` → `{validatorPubKey: bytes, nonce: bytes, signature: bytes}`. No `keyInput` (the validator picks a nonce and derives its key from it); `relay.affirmAnswer` refuses an affirmation without a 33-byte key and a 32-byte nonce (`bad_reply`).
- Root's `close` in `amm/validator` is `rescind` (amm-validator README, 0.13.0).

## 0.11.0 (the affirmation, David Case 2026-10-21)

This section supersedes "The pool deploy through the relay" below. Pool deploys move to the BRC-207 wallet module: the deploy is the LP's wallet's, so nothing carries it to a validator.

- **`amm.pool.affirm`** (`writes: false`): `{pool: bytes, satoshis: int, keyInput: string}` → `{signature: bytes}`. `relay.affirmBody` checks the args (a `keyInput` in either outpoint form, normalised to `<txid>_<vout>`); main.zig packages the body (box `affirm`, from this instance to itself, nonce sha256("amm-pool-affirm" ‖ body)[0..16]) and calls its own amm-validator's fn `affirm` in-VM (`callValidator`, `transport: "local"`, protocol `/amm-validator/1/affirm`, which no route serves); `relay.affirmAnswer` turns the handler's `{verdict, body}` into `{signature}` or the function's error `<reason>[: <detail>]`. Nothing is recorded; no libp2p dial (the page asks this skein's own validator, `amm.pool.terms`).
- **Gone:** `amm.pool.submit` and `amm.pool.status`, the kind `pool` (records `amm-pool`, the relay thread `amm-pool-relay`, the state's `pools` map, dropped at the next write), `checkDeploy`, `deployBeef`, `deployBody`, `claimedOf`, `deployId`, `submitDeploy`, and the call on `/amm-validator/1/deploy`.

## 0.9.0 (the Open Exchange, David Case 2026-10-09)

This section supersedes what the rest of this file says where they differ.

- **No `amm.liquidity/1`** (gone with the contract's AddLiquidity): the kind `liquidity`, `checkAdd`, `submitAdd`, the box `addLiquidity` on the validator and the state's `liquidity` map. `amm.pool/1` gains **`terms`**: `{validator: <this instance's identity>, peerId?: <its node>, lpFeeBps, validatorFeeBps, commissionBps}`, the validator's terms from `config.amm.ammValidator` (the Liquidity page deploys at them, to this skein's own validator); since skein-amm 0.15.0 the record `amm/terms` root sets (src/terms.zig, `relay.poolTerms`), or the error "no validator here" when none is set.
- **A deploy is delivered** (the LP's every input SIGHASH_SINGLE over its own output, one token unit left for the claim; relay.zig unchanged in its checks) and **accepted with the claimed deploy**: `applyReply` takes the validator's `tx` only when it is the delivered deploy with one output appended (`claimedOf`: the same version, inputs, lock time and outputs, one more after them); the record's `tx` / `txid` are the claimed deploy's and its `pool` the claimed deploy's output 0. An answer without `tx`, with the deploy unclaimed or another transaction, fails (`bad_reply`).
- **Listing requests** (reads.zig): the box `amm/requests` (`{"address": "requests", "handler": "amm-p2p"}`, anyone): `{fn: "request", args: {tokenId}}` recorded under the head `amm/requests` (`{kind: "amm-requests", requests: <map tokenId → {tokenId, from, at}>}`, the latest per token); the read route `/requests` (filter `requests`) answers them newest first, less the tokens registered (the engine's `amm/topics`), JSON `[{tokenId, from, at}]`.
- **Spends** (reads.zig): the read route `/spends?outpoint=<txid>.<vout>` (filter `spends`) answers the chain state of an outpoint (`chain/state`'s `spent`, read only): `{outpoint, spentBy?, current?, hops, closed}`, a pool followed from its output to its current one (each spender's output 0 while it is a pool; `closed` once a spender did not continue it). The LP's page reads its claim (spent: rescinded) and its pool (to Close) from it.

## 0.7.0 (skein's routes, filters and roles, shruggr/skein#143)

This section supersedes what the rest of this file says where they differ.

- **The message path is this program's box `amm/amm-p2p`** (`names.own_box`), not the app's box `amm`: a box has one route now (no sender to tell two apart), and `amm` is the overlay engine's (its derived mailbox route: its own watch, resume and wait). A `{fn, args}` message in `amm/amm-p2p` is the call, answered to the sender in that same box (`answerSender`; was `amm`); the cron ticks share the box as before. Read "box `amm`" below as `amm/amm-p2p` for the relay's interfaces.
- **`/call`**: the route lists `kernel.brc104`, so the caller is the signed request's key; `app.admitted` (the dispatch rows' senders) is no longer consulted (there are none): who may call is the kernel's gate, and `call` is gated by no role.
- **The pages**: the read route `/` (prefix, `root: "www"`, `index: "index.html"`) with the filter `page` → `amm-p2p.serve`; called as a filter (the input's `filter: true`) `serve` answers `{answer: <the page>}`, otherwise the same.
- No `owner` was read here; the manifest's `"amm-p2p"` route is `{"address": "amm-p2p", "handler": "amm-p2p"}`.

## 0.6.0 (market and validator are the engine's, shruggr/skein#120)

This section supersedes what the rest of this file says where they differ: every section below on liveness, the beacon, validation, the market role, start / stop and the heartbeat describes what is gone. Decided by David, 2026-10-06 evening: "a skein runs as a market and/or a validator by two settings in the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator: {every}`), and registering a token's topic is the one act that drives both." The engine (skein-overlay 0.9.0) emits `liveness` / `beacon` on `tm_color_<txid>_0-live` at `register` and `unliveness` / `unbeacon` at `deregister`; the beat has no body (the frame carries the instance's identity key, the gossip message its peer ID).

- **Gone from this program:** `validate` / `unvalidate` (and `names.mayValidate`, the box `amm/validate`), the validated set, the `beacon` / `unbeacon` and `liveness` / `unliveness` / 0.3.x `unsubscribe` emits and their bookkeeping (the maps `beacons`, `subscriptions`, the record's `validated` and `liveness`), the start / stop messages `{kind: "amm-p2p-start" | "amm-p2p-stop"}` (the manifest has no `start` / `stop`; such a message now errors `BadMessage`), the cron fallback's scheduling and its heartbeat job, and `src/liveness.zig`. Config: `ammP2p.market`, `heartbeatSeconds`, `offlineSeconds` and `catchupSeconds` are not read (the manifest has no `ammP2p`; `validator.every` is the beat, `market.window` the offline threshold, both `config.overlay`).
- **What remains:** the relay (box `amm`, `/call`, the relay thread, this node's own validator in-VM), the pages (`serve`), and two utilities nothing routes or schedules: `proofsByBlock` and the catch-up pass, still run by a cron provider's tick `{kind: "amm-p2p-tick", job: "catchup"}` in box `amm/amm-p2p` (its sender must be the cron provider) and its thread; `ammP2p.topics`, `peers`, `window`, `batch` and `replyTimeoutMs` configure it.
- **State.** `amm/p2p` is `{kind: "amm-p2p-state", maps: {cursor}}` (the catch-up cursor). A record 0.5.0 or earlier wrote loads (its other fields are not read) and is rewritten without them at the next commit.
- **The validator's signing** follows the engine's settings and registered set (programs/amm-validator/README.md "0.6.0").

## Port

Ported from amm-poc `programs/amm-p2p` (skein-overlay 0.2.0, skein-sdk 0.3.0) onto skein-overlay 0.6.0 and skein-1color 0.4.0:

- **State reads.** The chain state is the chain app's (`chain/state`, read only) and the overlay's is the app's (`<app>/state`), loaded as the engine loads them (`engine_vm.load`); amm-poc read both from the wallet library's head `wallet`.
- **Topics.** `ammP2p.topics` defaults to every `tm_color_<txid>_0` the overlay serves, as the engine reads its configuration (`engine_vm.configured`: `config.overlay.topics` and the topics registered with the engine under `<app>/topics`); amm-poc read genesis `overlayTopics`.
- **The token library.** `1color` (skein-1color 0.4.0) for the parser and the rules, `pool` (`src/pool.zig`) for the pool.
- **The signer.** Unchanged: the `wallet` import.
- **STOP: catch-up cannot record a proof.** amm-poc's pass applied each BUMP it fetched to the chain core under the head `wallet` (the transitional `wallet` grant), called the `rejected` hooks and advanced that head. The chain state is the chain app's alone since skein #79, and this program writes only `amm/…`. `takeReply` (src/main.zig) errors `CatchupCannotRecordProofs` when a reply proves a held unproven transaction, and `finishCatchup` records nothing. How a fetched proof reaches the chain app is not decided.
- **STOP: the heartbeat topic is not routed.** The heartbeat is still published on `tm_color_<txid>_0-live` for each served token topic, and `validateLive` still judges it, but no row in the app routes `tm_color_<txid>_0-live` to it: amm-poc's manifest had one libp2p row per token (`tm_{{TXID}}-live`), templated per instance, and a dynamic overlay's manifest names no token. How validator liveness per token is addressed is not decided (`liveVerdict`, src/main.zig).
- **The peer ID.** amm-poc filled `ammP2p.peerId` per instance (`{{PEER_ID}}`). skein gives a program no way to learn its own peer ID (a step's input has `self.identity`, no peer ID; the host derives the libp2p key from the master secret, `[2, "skein instance"]`, key ID `libp2p:<handle>`), so the manifest carries none; without it `amm-p2p-start` schedules no heartbeat (catch-up only).

## 0.5.0 (reads, shruggr/skein#135)

- **The pages are a read.** fn `serve` is the manifest's read `/` (prefix, `root: "www"`, `index: "index.html"`; was the http row `/`): the host serves it by a call over the current state, any method, signed or not, no entry. It reads only (the head `amm/app`, the tree's blobs), so nothing changed in it.
- **fn `live` is gone**, and its http row `/live` with it (0.4.0 answered 410 there). The validators live on a token are the runtime's read, `GET /<app>/.live/tm_color_<txid>_0-live`.

## 0.4.0 (liveness is the runtime's; the caller names the validator)

This section supersedes what the rest of this file says where they differ (0.3.0's market role, 0.2.1's `liveness.judge` and `amm-live` entry, "Liveness — `tm_color_<txid>_0-live`" below, the relay's `validator_offline`, and the catch-up's peers from the live map). Decided with David 2026-10-06 (shruggr/skein#120, last comment; the host side is shruggr/skein#138, skein main f45c887).

- **The market asks the runtime.** On a market host (`ammP2p.market`) a start emits, once per served token topic, `{event: "liveness", topic: "tm_color_<txid>_0-live", window: offlineSeconds × 1000}` (`liveness.livenessEvent`), and `{event: "unliveness", topic}` for a topic asked before and no longer served; a stop, or a start with the role off, ends every one. Only a topic in the standing set is ended. The set is the map `subscriptions` in `amm/p2p`, now the topics with a standing liveness; the record carries `liveness: true`. The step's result lists `market`, `liveness` and `unliveness`. `offlineSeconds` defaults to 40 (`heartbeatSeconds` 30): a margin over the beat, both config.
- **The runtime keeps it.** The liveness tool subscribes the topic at the node without admitting its messages, verifies each beat's signature against `sender`, keeps the beats newer than the window (the latest per sender, the node's own included) in memory, and serves them at `GET /<app>/.live/<topic>` → `[{sender, at, body: <base64>, from: <peer ID>}]` newest first; 404 when no liveness is kept (skein docs/MESSAGES.md "Liveness (#138)"). Nothing of it is in the log or this program's state.
- **Gone from this program:** `validateLive`, the `amm-live` entries and their step, the last-seen map `live` (dropped from `amm/p2p` at the next commit), `liveness.judge` / `apply` / `live`, the consumer API `live`, and the relay's validator selection. `liveness.zig` keeps the beacon's body `{identityKey, peerId}`, the frame and its signature: the validator side, and what the page decodes. fn `live` (the http row `/live`, kept until the manifest's `reads[]` entries arrive, #135) answers 410.
- **Upgrade from 0.3.x.** A state without `liveness: true` held `subscribe`s to `validateLive`: the first start or stop emits `unsubscribe` for each (a refused one is passed over), clears the set, then asks liveness as above (the result lists `unsubscribed`).
- **The caller names the validator.** `amm.swap.submit`, `amm.pool.submit` and `amm.liquidity.submit` take `peerId` (text, the validator's libp2p peer ID) beside `validator` (`provides` in etc/app.json); missing, it is refused by the declared shape (`bad-args`); not a peer ID's text (empty, a space, a `/`), `bad_peer`. The relay looks at no liveness: the record keeps `peer` as given, and the relay thread dials it. `validator_offline` is gone.
- **This node's own validator** (`local`). When `peerId` is this node's own (`selfPeerId`, the signer's `[2, "skein instance"]` / `libp2p:<handle>` key), the record is `local` and the relay does not dial (a node does not dial itself). It does what the front door does with a frame on `/amm-validator/1/<call>` (skein programs/frontdoor libp2p.zig `stepped`): it calls the route's handler, amm-validator's fn `swap` / `deploy` / `addLiquidity` (the app record's `programs["amm-validator"]`), in-VM from the relay thread's step, with `{transport: "local", protocol, body: <the same signed package>, match: {program, fn, app}}` (`callValidator`). `{verdict, body}` settles the record from the reply frame; `{wait: true}` means the handler sent its submission and awaited it in this step, so the thread rests on that (and on `expires`); stepped again by the engine's answer (`reply`) or the awaited thread at rest (`resolved`), the relay calls the handler again with it, as the front door does; a failed call is `failed` `validator_failed` (retryable); woken at `expires`, `timeout`. `relay.advanceLocal` / `localAnswer` are the pure steps (tested natively). amm-validator takes `transport: "local"` beside `libp2p`.
- **Catch-up peers** are the configured `ammP2p.peers` only (no map to add the validators heard from).

## 0.3.2 (one setting; validate gated by a row)

This section supersedes what the rest of this file says where they differ.

- **One setting** (David 2026-10-06): "If I'm validating, I'm pinging, I'm taking on new liquidity, and I'm validating." The validated set (`validated` under `amm/p2p`) is the one switch: for a topic in it the node beacons `tm_color_<txid>_0-live`, and amm-validator signs its swaps and takes on its new liquidity (signs an LP's `addLiquidity`, consents to an LP's pool `deploy`: liquidity received, not the node's own funds); for any other token amm-validator refuses all three calls `not_validating`. amm-validator reads this program's record for it; nothing else writes the set.
- **Gated by a row, not by code.** `validate` / `unvalidate` are taken in box `amm/validate` only (`names.mayValidate`; in any other box, `amm/amm-p2p` included, the step errors `NotTakenHere`), which the manifest's row `{"address": "validate", "sender": "$owner", "program": "amm-p2p"}` admits the owner into: the row is the permission, as the engine's `register` in `amm/register`. The `in.owner` check is gone for them. The answer still goes to the sender's box `amm`. Start / stop are unchanged (box `amm` or `amm/amm-p2p`, the owner or the cron provider, `NotTheOwner` otherwise).
- **The 0.3.1 STOP is gone**: amm-validator's signing is gated on the set (programs/amm-validator/README.md "0.3.2").

## 0.3.1 (validation per topic)

This section supersedes what the rest of this file says where they differ.

- **Beaconing is not a role** (David 2026-10-06): a node beacons `tm_color_<txid>_0-live` for the topics its owner has set up validation for, set up per topic like a registration. In box `amm/amm-p2p`: `{fn: "validate", args: {topic: "tm_color_<txid>_0"}}` adds the topic to the validated set and, when it is not already beaconed, emits `{event: "beacon", topic: "tm_color_<txid>_0-live", every, body}`; `{fn: "unvalidate", args: {topic}}` removes it and emits `{event: "unbeacon", topic}` when it is beaconed. Both are idempotent and answered `{fn, request, replyTo, result: {topic, validating}}` to the sender's box `amm` (`answerSender`, when the address book reaches it); the step's result lists `validated`, `beacons`, `unbeacons`, `answer`, `sent`. The topic must be a token topic `tm_color_<txid>_0` (`BadTopic`).
- **Gated by the sender.** Row 5 (`amm-p2p` from `*`) admits anyone; amm-p2p acts only when the message's sender is `in.owner` (the step errors `NotTheOwner`, as for start/stop; the cron provider is not admitted here).
- **Start / stop.** A start (without `jobs`) beacons every validated topic and unbeacons any beacon outside the set (0.3.0's beacons on every served topic end at the first start); a stop unbeacons every one and keeps the set, so the next start beacons it again. The cron fallback's heartbeat publishes on the validated topics. `liveness.validation` is the plan (tested natively); `ammP2p.topics` no longer decides the beacons.
- **State.** `amm/p2p` is `{kind: "amm-p2p-state", maps: {live, cursor, beacons, subscriptions}, validated: ["tm_color_<txid>_0", …]}`: the set inline, so the owner's Validator page reads it with the explorer (`/explore/head/amm/p2p`, then the record), as the token topics page reads `amm/topics`.
- **The market role** (0.3.0) is untouched and independent: a node may validate, host a market, or both.
- **STOP: amm-validator has no per-topic switch.** It signs for any topic its overlay admits and reads nothing of amm-p2p's state; gating its signatures on the validated set is not built (not decided how: a read of `amm/p2p`, or a set of its own).

## 0.3.0 (the market role)

This section supersedes what the rest of this file says where they differ (the Port STOP "the heartbeat topic is not routed" and 0.2.0's "Not routed: `tm_color_<txid>_0-live`" included).

- **Validator liveness by role** (shruggr/skein#120, David 2026-10-06). `ammP2p.market` (boolean, default `false`). On a market host a start — with or without `jobs` — emits, for every served token topic not yet subscribed (`ammP2p.topics`, else every registered or declared `tm_color_<txid>_0`), `{event: "subscribe", topic: "tm_color_<txid>_0-live", program: "amm-p2p", fn: "validateLive"}` (shruggr/skein#119; `liveness.subscribeEvent`), and `{event: "unsubscribe", topic}` for one subscribed before and no longer served; a stop, or a start with the role off, unsubscribes every one. The standing set is the map `subscriptions` in `amm/p2p` (`{kind: "amm-p2p-state", maps: {live, cursor, beacons, subscriptions}}`); the step's result lists `market`, `subscribed` and `unsubscribed`. The kernel delivers each beat to `validateLive` through the door, as a row's handler; an accepted beat's `amm-live` entry is stepped into the map `live` as before, and the relay picks the validator's peer from it (unchanged). Off a market host nothing is subscribed, the map stays empty and the relay refuses `validator_offline`.
- **Registrations are not seen.** The owner's `register` / `deregister` goes to the engine (box `amm/register`); nothing steps amm-p2p then. The set is reconciled at each start (the manifest's `start`, which the owner sends again after a register or deregister, as for the beacons).

## 0.2.1 (skein-overlay 0.7.5; skein 387e057)

This section supersedes what the rest of this file says where they differ.

- **The beat is the host's signed frame** (skein docs/MESSAGES.md "Beacons"). The declared body is `{identityKey, peerId}` (no `at`, no `sig`); the host publishes dag-cbor `{body, at, sender, signature}` every beat — `at` the beat's time, `sender` the instance's identity key, `signature` the instance's under `[2, "metanet handles envelope"]`, key ID `send`, counterparty anyone, over sha2-256 of dag-cbor `{kind: "beacon", topic, body, at, sender}`. `liveness.judge(topic, frame, from, now, offline)` decodes the frame, checks the signature (the anyone-derived child of `sender`, over the topic it was heard on) and `at`, then the body: `identityKey` must be `sender` (`WrongIdentity`) and `peerId` the GossipSub publisher (`WrongPeer`). The `amm-live` entry is `{kind: "amm-live", topic, body, at, sender, signature}`, re-verified when applied. The cron fallback signs the same frame itself, through the signer. The 0.2.0 STOP on freshness is gone: each beat is fresh.
- **The peer ID is the node's.** The host derives the node's key from the instance's root (`[2, "skein instance"]`, `libp2p:<handle>`, self; signer.ts `peerKey`), the key `selfPeerId` asks the signer for. The 0.2.0 STOP is gone.

## 0.2.0 (skein-overlay 0.7.4, skein-sdk 0.7.1)

This section supersedes what the rest of this file says where they differ.

- **The beacon** (shruggr/skein#126). A start without `jobs` — the manifest's `start`, `{kind: "amm-p2p-start"}` in box `amm`, or the same in box `amm/amm-p2p` — emits one `{event: "beacon", topic: "tm_color_<txid>_0-live", every: heartbeatSeconds × 1000, body}` per served token topic (the host publishes `body` every `every` ms; no tick, no step per beat) and `{event: "unbeacon", topic}` for a topic beaconed before and no longer served; a stop without `jobs` unbeacons every one. The standing set is the map `beacons` in `amm/p2p` (`{kind: "amm-p2p-state", maps: {live, cursor, beacons}}`). A start or stop naming `jobs` is the cron fallback (`schedule.zig`, the cron provider at `local` `cron`). **STOP:** the body is the start's (`at` and signature); the host re-sends it unchanged, so receivers ignore it once older than the offline threshold. How a beat carries freshness is David's call.
- **The peer ID** (`selfPeerId`, src/main.zig): the signer's public key for `[2, "skein instance"]`, key ID `libp2p:<handle>` (the step's `self.handle`), counterparty self, as the identity multihash of the compressed key (`libp2p.peerIdOf`, checked against js-libp2p's). `ammP2p.peerId` is gone. **STOP:** skein's host derives the node's key from the master secret (src/host/signer.ts `peerKey`), not from the instance root the signer holds, so this is not the node's peer ID until one side changes.
- **Not routed:** `tm_color_<txid>_0-live` (the node never subscribes `-live`; matchmaking is the client's), and `/amm/proofs/1.0.0` (its row is gone; sync is shruggr/skein#112's `want`). `validateLive`, `proofsByBlock` and the catch-up pass stay as code, scheduled by nothing.
- **Providers by address** (skein-sdk 0.7: no roles): the libp2p and cron providers are the address book's entries at (`local`, `libp2p`) and (`local`, `cron`) (`sk.peerAt`).
- **Boxes** (shruggr/skein#128): this program's own box is `amm/amm-p2p` (the manifest's `"amm-p2p"`); heartbeat admits and cron ticks name it.
- **The pages**: fn `serve`, the manifest's http row `/` (prefix, `root: "www"`, `index: "index.html"`), answers from the installed app record's `tree` with skein-sdk's `files.serve` (shruggr/skein#125).

## What moved into skein's overlay engine (skein #74)

Per overlay topic `tm_color_<txid>_0` the engine now runs the standard gossip itself: it publishes the raw submission on `<topic>` after admission (unless it arrived there), the STEAK on `<topic>-admit` and proofs (BUMPs, reorg re-proofs included) on `<topic>-proof`, and subscribes to all three; the install handler derives those routes from `config.overlay` (docs/APPS.md §6). So this program no longer publishes submissions (the `admitted` lookup hook, its echo check and the outbound BEEF are gone), no longer runs a proof topic (the republish job, the proof verdict and its marker are gone), and is no longer a lookup service (`ls_amm_p2p` and its `admitted`/`spent`/`rejected`/`lookup` hooks are gone).

What is left:

- **the liveness heartbeat**: a validator publishes "I am validator X, my peer ID is Y" on `<topic>-live`, and every node judges what arrives there and keeps a last-seen map (the consumer API `live`);
- **proofs by block**, a direct call (`/amm/proofs/1.0.0`): it serves a block's BUMP to a peer that asks, and a periodic catch-up pass asks peers for the blocks it is missing proofs for;
- **the marketplace relay** (below): `amm.swap.submit`, `amm.swap.status` and `amm.swap.terms`, the pool deploy's `amm.pool.submit` and `amm.pool.status`, and AddLiquidity's `amm.liquidity.submit` and `amm.liquidity.status`, on the app's box `amm` and route `/amm/call`.

**Deferred: the pull half of sync.** #74 defers catch-up (a node that was offline recovering proofs and transactions) to a walk-through with David. The proofs-by-block direct call is a **placeholder** for it, kept as it was (ported to the provider contract, not extended); GASP-style transaction catch-up is not built.

## Layout

| file | what |
|---|---|
| `src/names.zig` | Topic, protocol, box and schedule names; parses `tm_color_<txid>_0` and `tm_color_<txid>_0-live` itself. |
| `src/stream.zig` | The direct call's shapes (0.44.0; 0.44.1: the provider's bodies gone): the handler's argument, the direct-call answer, the peer ID. |
| `src/proofs.zig` | Proofs by block: one BUMP per block (merge), the request and reply (0.44.1: no catch-up plan). Pure. |
| `src/views.zig` | The views over the chain state (`chain/state`) and the app's overlay state (`<app>/state`). No VM imports. |
| `src/interface.zig` | (0.44.0) The functions' shapes: `amm.swap.terms` (the commission key's protocol, `terms`), `amm.pool.terms` (`poolTerms`), the affirmation (`affirmBody`, `affirmNonce`, `affirmAnswer`, the signed package `package`), the answer messages. Pure. |
| `src/main.zig` | The program: the route handlers, the steps (the app's box), the app dispatch (skein-sdk `app`), the signer (`wallet`), `emit`. |
| `test.zig` | Tests. |

Dependencies (`build.zig`): skein-overlay 0.6.0 by URL + hash (its `sk` VM helpers, and its engine sources as the module `skein_overlay`, as amm-validator takes them), skein-sdk 0.5.1 through it (`chain`, `wallet`, `app`, `sk`, `cbor`, `dagjson`, `message`), skein-1color 0.4.0 (`1color`) and `pool`. The tests read `etc/app.json` (the functions' declarations).

## Routes and protocols

| route (libp2p) | program fn | what |
|---|---|---|
| `libp2p:tm_color_<txid>_0-live` (GossipSub topic) | none (0.4.0) | the runtime's liveness tool on a market host (`liveness`), read at `GET /amm/.live/tm_color_<txid>_0-live`; this program judges no beat |
| `libp2p:/amm/proofs/1.0.0` (direct call) | `proofsByBlock` | answer one request frame with one reply frame |
| `/amm/` (a read route, prefix, its filter `page`, shruggr/skein#143) | `serve` | the pages, `www/` of the app's tree; a filter's answer, anyone, signed or not, nothing logged |
| `/amm/call` (HTTP row, APPS.md §4: a signed request) | `call` | `{fn, args}` → `{fn, result}` / `{fn, error}`, at once (0.44.0: `amm.swap.submit` gone; 0.11.0: `amm.pool.submit` gone) |

`<txid>` is the token's deploy txid, 64 lowercase hex characters in display order; the topic name is `tm_color_<txid>_0` (skein-1color 0.8.2: `tm_color_<assetId>`, `_0` included; until skein-amm 0.7.1 it had no suffix), and the liveness topic adds `-live`, in skein's `-admit`/`-proof` style. Bodies are dag-cbor; hashes and txids are 32 bytes in internal byte order.

### Liveness — `tm_color_<txid>_0-live`

```
frame: {body: bytes, at: uint, sender: bytes(33), signature: bytes}      (the host's beat, 0.2.1)
body:  {identityKey: bytes(33), peerId: bytes}
```

"I am validator `identityKey` and my peer ID is `peerId`." `at` is milliseconds since the Unix epoch, the beat's time on the publishing host. `signature` is a DER ECDSA signature by the instance — BRC-100 `createSignature` under `[2, "metanet handles envelope"]`, key ID `send`, counterparty `anyone` (invoice `2-metanet handles envelope-send`), which anyone can derive from `sender` — over sha256 of dag-cbor `{kind: "beacon", topic, body, at, sender}` (the topic is signed, not carried).

| case | verdict |
|---|---|
| the frame or the body does not decode | reject `Malformed` |
| `identityKey` is not the frame's `sender` | reject `WrongIdentity` |
| the signature does not verify against `sender`'s derived key, over this topic | reject `BadSignature` |
| `peerId` is not the GossipSub sender (`from`) | reject `WrongPeer` |
| `at` more than 60 s ahead of this node's clock | ignore `FromTheFuture` |
| `at` older than the offline threshold | ignore `Stale` |
| our own failure to evaluate (bad config, not a `-live` topic) | ignore `<error>` |
| otherwise | accept |

On accept the handler answers with one `admit` entry, which the front door admits after the message's own `p2p` entry (docs/MESSAGES.md "libp2p (#51)"):

```
{event: {kind: "amm-live", topic, body, at, sender, signature}, box: "amm-p2p"}
```

Stepped on it, the program re-verifies the signature and records it in its last-seen map `live` (identity key → `at` ‖ peer ID) under its head `amm/p2p`; a later `at` replaces an earlier one, never the reverse. Staleness is the consumer's question, so a log replayed later records the same map.

**Consumer API.** Gone in 0.4.0 (above): the runtime's `GET /amm/.live/tm_color_<txid>_0-live` replaces it, and fn `live` answers 410.

**Publisher (job `heartbeat`).** On each heartbeat tick a validator signs through the `wallet` import (getPublicKey identity; createSignature with the digest above, protocol `[1, "amm live"]`, key ID `1`, counterparty anyone) and emits `{topic: "<topic>-live", body}` to the libp2p provider (box `publish`) for each topic; the provider's answer is recorded and nothing awaits it. The peer ID is configuration (`ammP2p.peerId`, what `skein-host identity <handle> --peer` prints): skein gives a program no way to learn its own (known limitation, recorded).

### Proofs by block — direct call `/amm/proofs/1.0.0`

```
request  {blockHash: bytes(32), topic?: text}
reply    {bump: bytes} | {missing: true}
```

**Serving.** The front door calls `proofsByBlock` with the request frame; it answers `{verdict: "accept", body}` and the front door writes the body back as one frame. The reply's BUMP merges every proof this node holds in that block (only the topic's transactions when `topic` is given); `missing` when the block is not on its best chain, it holds nothing there, or the request does not decode.

**Requesting (job `catchup`).** While a topic has unsettled transactions (the wallet's `unproven` index joined to the topic's `applied`), a pass asks for the blocks after a per-topic cursor (starting `window` below the tip), `batch` at a time, from the configured `peers`, then the validators live in the last-seen map (up to three per block). Outbound is the libp2p provider (docs/MESSAGES.md "The providers"), so the pass is a thread resting on the provider's answers to its dial:

```
tick step    emit dial {peer, protocol: "/amm/proofs/1.0.0"}; await it; deadline replyTimeoutMs
answer       {stream} (box dial)       → emit send {stream, body: request}; rest again
answer       {stream, body} (box frame) → emit close; check the BUMP's root against our header; one that
                                         proves a held unproven transaction errors the pass (Port, STOP: amm-poc
                                         applied it to the head `wallet`); next block, emit the next dial
answer       {stream, closed} | {error}; or the deadline → the next peer
```

The pass is carried from step to step in the thread's result record (`catchup: {topic, height, to, peers, peer, dial, stream, until}`). At the batch's end the cursor moves; with nothing unsettled the cursor follows the tip. It is not exercised natively (it needs the kernel and the provider); the plan, the bodies and the answers are.

## The functions (`amm.swap/1`, `amm.pool/1`)

Declared in `etc/app.json` (`provides`), dispatched with skein-sdk's `app` helper (args checked against the shapes, `writes` enforced), reachable as a message `{fn, args}` in box `amm/amm-p2p` (answered with a message in that box), on the route `/call` (signed, `kernel.brc104`) and in-VM.

```
amm.swap.terms    writes: false
  args    {}
  answer  {commissionPkh?: bytes,         this exchange's commission pkh (20 bytes; hash160 of the instance's own key,
           minCommissionBps?: int}        BRC-43 level 1 `amm commission` / `relay`, counterparty anyone; null only when
                                          the signer gives none), for the page to name as Swap's commissionPkh; and
                                          (0.16.0) this market's minimum commission (0 when unset): the pools the Swap
                                          page lists
amm.pool.terms    writes: false           the validator's terms with this instance's identity and peer ID
amm.pool.affirm   writes: false           a proposed pool to this instance's own validator, in-VM (0.13.0, above)
```

### The market record (0.16.0)

Root's message `{fn: "market", args: {minCommissionBps}}` (an integer, 0 to 10 000) in this program's box `amm/amm-p2p` sets the market's minimum commission; `{fn: "market", args: null}` clears it (`roles.root` gates `market`; src/market.zig). Kept as the root of the head `amm/market` (`{minCommissionBps}`, or `null` once cleared); answered to root in the box, `{fn: "market", request, replyTo, result: <the record> | null}` or `error: {code: "bad-args", message}` with nothing written. Unset: 0. `amm.swap.terms` answers it; the relay reads nothing of it (a listing preference of this market, not a rule: it refuses nothing by it).

### Configuration

```
(0.16.0: no config.amm.commission / genesis defaults.ammCommission: the commission key is derived, above)
config.amm.ammP2p (app record)  |  genesis defaults.ammP2p (JSON text)        (as below)
the functions' declarations:  the app record's `provides`  |  genesis defaults.ammProvides (JSON text: the manifest's `provides`)
box amm      {address: "amm", sender: "*", program: "amm-p2p"} (manifest; after the owner's, the events' and $self's rows to the engine)
http /call   {transport: "http", address: "/call", sender: "*", program: "amm-p2p", fn: "call"} (manifest)
```

The `/call` route admits the caller as a message would be (skein-sdk 0.3.0 `app.admitted`: a `mailbox` row in the call input's `dispatch` for (caller, `amm`) or (anyone, `amm`)); an open row (sender `*`) has no caller, so the box must be open to anyone.

## Configuration (a genesis-wired node)

The program also runs wired by a genesis, with no app record (amm-poc's deploy). Installed as an app, its configuration is the manifest's `config.amm`.

```
etc/config.json  defaults:
  "overlayTopics":  "{\"tm_color_<txid>_0\": \"color-topic\"}"
  "ammP2p":         "{\"heartbeatSeconds\": 30, \"offlineSeconds\": 90, \"catchupSeconds\": 600, \"window\": 12, \"batch\": 6,
                      \"peers\": [\"16Uiu2…\" | \"/ip4/…/p2p/16Uiu2…\"], \"topics\": [\"tm_color_<txid>_0\"],
                      \"peerId\": \"16Uiu2…\", \"replyTimeoutMs\": 30000}"
  "scopes":         {"amm-p2p": ["amm/p2p", "amm/app"]}     (the heads this genesis-wired program may advance)
etc/dispatch.json  {transport: "libp2p", address: "tm_color_<txid>_0-live",    sender: "*", program: "amm-p2p", fn: "validateLive"}
                   {transport: "libp2p", address: "/amm/proofs/1.0.0", sender: "*", program: "amm-p2p", fn: "proofsByBlock"}
                   {address: "amm-p2p", sender: "*", program: "amm-p2p"}   (the admitted heartbeats, the ticks, the start message)
                   {address: "amm", sender: "*", program: "amm-p2p"}       (the app's box, amm.swap/1; the relay above)
address book     the `libp2p` and `cron` providers (the node host seeds them)
```

The write scope: `amm/p2p` (this state) and `amm/app`; an installed app advances only heads named `amm/…`. The state head is `amm/p2p` (`interface.p2p_head`). `ammP2p.topics` defaults to every served `tm_color_<txid>_0` topic. `peerId` is needed only for the heartbeat (a validator); a mistyped value makes every heartbeat `WrongPeer` at the receivers. State under the head `amm/p2p`: `{kind: "amm-p2p-state", maps: {live, cursor}}`.

## Open

The end-to-end runs below are amm-poc's (its deploy/README.md); this port is tested natively only.

- **The SDK's dispatch helper answers in the step** (`app.serve`: the `/call` route answers at once, a message is answered at the end of its step). A function whose answer depends on later steps (a peer's reply) is outside it, so this program runs its own `/call` and message wrappers around `app.run` (the same checks, codes and answer shapes) with one addition: `amm.swap.submit` waits on its relay thread.
- **No app record under a genesis-wired node**: the declarations come from `defaults.ammProvides` and the state is the head `amm/app`'s root itself (above).

