//! amm-p2p: the AMM app's functions (amm.swap.terms, amm.pool.terms, amm.pool.affirm), its read
//! routes, its pages and the market record, as one skein program (Zig, wasm32-wasi). 0.44.0 (David
//! Case 2026-11-06): no relay here — the open-exchange host carries a swap to its validator
//! (`POST /@<tokenId>/amm/swap`); the instance logs facts, never attempts.
//! The standard overlay gossip — submissions on `<topic>`, STEAKs on
//! `<topic>-admit`, proofs on `<topic>-proof` — is skein's overlay engine's
//! (skein#74), not this program's.
//!
//! The proofs-by-block bodies are in proofs.zig (pure, tested natively); the direct call's shapes
//! are stream.zig, the functions' interface.zig. This file wires them to the VM. 0.44.1 (David Case
//! 2026-11-06): the catch-up pass (a cron-ticked pull of proofs from configured peers, with its own
//! reply deadline, from before the overlay sync) is gone with its tick, config and cursor.
//!
//! **Market and validator** (0.6.0, shruggr/skein#120, David 2026-10-06 evening) are the overlay
//! engine's, not this program's: "a skein runs as a market and/or a validator by two settings in
//! the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator:
//! {every}`), and registering a token's topic is the one act that drives both" — the engine emits
//! `liveness` / `beacon` on `tm_color_<txid>_0-live` at `register` (skein-overlay 0.9.0). The page reads
//! `GET /<app>/.live/<topic>` and names the validator (its identity key and peer ID) in the swap;
//! the host dials the peer it is given. This program keeps no validated set, no beacons, no
//! liveness, and takes no start or stop.
//!
//! **Called** (input kind "call"; `fn`):
//!
//!   proofsByBlock   a /amm/proofs/1.0.0 frame → {verdict: accept, body: {bump} | {missing: true}}
//!                   (a utility: no row routes it since 0.2.0; sync is shruggr/skein#112's `want`)
//!   serve           the read route `/` (prefix; the filter `page`, shruggr/skein#143: anyone, signed
//!                   or not, nothing logged; called as a filter it answers `{answer: <the page>}`):
//!                   the app's pages, `www/` of the app's own tree (skein-sdk `files.serve`,
//!                   shruggr/skein#125); it reads only
//!   call            route /amm/call (APPS.md §4; kernel.brc104: the caller is the signed request's key,
//!                   who may call is the kernel's gate, 0.7.0): {fn, args} → {fn, result} | {fn, error}, at once
//!   spends          the read route `/spends?outpoint=<txid>.<vout>` (filter `spends`, 0.9.0): the chain
//!                   state of an outpoint, a pool followed to its current output (reads.zig); 0.34.0:
//!                   `?outpoint=a,b` one record per outpoint in query order (P8)
//!   poolsBeef, positions, validatorFees, commissionFees, readTerms, tx
//!                   the public read routes (0.34.0, reads.zig; docs/AMM.md "The public read API"):
//!                   /pools/beef (P3), /positions (P4), /fees/validator (P5), /fees/commission (P6),
//!                   /terms (P7), /tx (P9); plain GETs, cache headers per class (0.44.0: /swaps, P10, gone)
//!   trades, candles, stats
//!                   the history reads (0.36.0, reads.zig `historyRead`): /trades (H1), /candles
//!                   (H2), /stats (H3), over the pool lookup's trade rows
//!   poolsAt, poolsHistory
//!                   the pool history reads (0.40.0): /pools/at?t= (every pool listed at t), /pools/history
//!                   (the events of a window), over the lookup's `history` and `closes`
//!   amm.swap.terms  an in-VM call of the interface amm.swap/1 (interface.zig; 0.44.0: submit and status gone)
//!   amm.pool.terms, amm.pool.affirm   an in-VM call of the interface amm.pool/1 (the validator's terms,
//!                   0.9.0; the affirmation of a proposed pool, 0.11.0: amm-validator's fn `affirm`
//!                   called in-VM, answered at once)
//!
//! **Stepped** (the `mailbox` route on the box `amm/amm-p2p`; since 0.7.0, shruggr/skein#143, the
//! app's box `amm` is the overlay engine's alone):
//!
//!   message {fn, args} in box `amm/amm-p2p`            this program's box (APPS.md §4): amm.swap.terms,
//!                                                     amm.pool.terms | affirm,
//!                                                     answered to the sender in that box
//!   message {fn: "market", args} in box `amm/amm-p2p`  root's market record (0.16.0, market.zig; `roles.root`
//!                                                     gates it): {minCommissionBps} sets, null clears, the head
//!                                                     `amm/market`; answered to root in that box
//!
//! Nothing of this program's is kept in state (0.44.1: the catch-up cursor under `amm/p2p` is gone; a
//! record an earlier version wrote is not read). 0.44.0: nothing under the head `amm/app` (the relay's `swaps` map,
//! `{kind: "amm-app-state", swaps}`, is gone; a record an earlier version wrote is not read).
//!
//! Config: none of its own (0.44.1: `config.amm.ammP2p` / genesis `defaults.ammP2p`, the catch-up's,
//! gone; 0.16.0: no `commission`, the commission key is the instance's own, `commissionKey`); the
//! functions' declarations: the app record's `provides`, else genesis `defaults.ammProvides`
//! (JSON) (README.md).
const std = @import("std");
const w = @import("chain");
const ov = @import("skein_overlay");
const vm = @import("overlay_sk");
const wire = @import("wallet").wire;
const names = @import("names.zig");
const stream = @import("stream.zig");
const proofs = @import("proofs.zig");
const views = @import("views.zig");
const iface = @import("interface.zig");
const terms = @import("terms");
const reads = @import("reads.zig");
const lookup = @import("lookup");
const amm_lookup = @import("amm_lookup");
const app = @import("app");
const sk = @import("sk");
const files = @import("files");
const scbor = @import("sdk_cbor");
const dagjson = @import("dagjson");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

/// The imports skein-overlay's `sk` module does not declare: the signer.
const ext = struct {
    extern "skein" fn wallet(frame: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
};

pub fn main() u8 {
    return vm.main("amm-p2p", run);
}

/// The input as the overlay engine reads its configuration (skein-overlay `engine_vm.configured`:
/// the app this program was installed in, its served topics with the registered ones in (the
/// engine's head `<app>/topics`), its roles), for the topics this program works on (`config`).
var overlay_in: ?Value = null;

fn run(a: Allocator) anyerror!void {
    const in = try vm.input(a);
    const is_call = eql(u8, in.getText("kind") orelse "", "call");
    overlay_in = ov.engine_vm.configured(a, in, if (is_call) vm.callArg(a, in) catch null else null) catch null;
    if (is_call) return call(a, in);
    return step(a, in);
}

// ---------------------------------------------------------------- the overlay state

/// The app's overlay state (`<app>/state`) over the chain app's (`chain/state`, read only), as the
/// step or call sees them (skein-overlay `engine_vm.load`).
fn loadState(a: Allocator, in: Value) !*ov.state.State {
    const st = try a.create(ov.state.State);
    st.* = (try ov.engine_vm.load(a, overlay_in orelse in)).st;
    st.now = @intCast(in.getUint("now") orelse in.getUint("at") orelse 0);
    return st;
}

// ---------------------------------------------------------------- calls

fn call(a: Allocator, in: Value) !void {
    const func = in.getText("fn") orelse return error.BadInput;
    const arg = try vm.callArg(a, in);
    if (eql(u8, func, "call") and arg.get("match") != null) return vm.answer(a, try appRoute(a, in, arg));
    // The read route `/` (shruggr/skein#143): its filter `page`, answering `{answer: <the page>}`.
    if (eql(u8, func, "serve")) {
        const page = try servePages(a, arg);
        return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, page) else page);
    }
    // The read (0.9.0): the chain state of an outpoint. (The holders' listing requests moved to the
    // config app, amm-config, 0.17.0.)
    if (eql(u8, func, "spends")) {
        const ans = try spendsRead(a, in, arg);
        return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, ans) else ans);
    }
    // The public read API (0.34.0): plain GETs over the pool lookup's answers, the chain state and
    // the terms.
    if (std.meta.stringToEnum(Read, func)) |r| {
        const ans = try publicRead(a, in, arg, r);
        return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, ans) else ans);
    }
    if (isAppFn(func)) return vm.answer(a, try appCall(a, in, func, arg));
    if (eql(u8, func, "proofsByBlock")) return vm.answer(a, try proofsByBlock(a, in, arg));
    return error.UnknownFunction;
}

fn headRecord(a: Allocator, name: []const u8) !?Value {
    const c = (try vm.head(a, name)) orelse return null;
    return try vm.store().getValue(a, c);
}

/// The head amm-setup writes the token record under (amm-setup `setup.token_head`).
const token_head = iface.app_name ++ "/token";

/// The read `/spends?outpoint=<txid>.<vout>` (filter `spends`): the chain state of an outpoint
/// (reads.zig `spendOf`). 0.34.0 (P8): `?outpoint=a,b` (a comma in it) answers one record per
/// outpoint in query order; one outpoint answers the single object, as before.
fn spendsRead(a: Allocator, in: Value, arg: Value) !Value {
    const q = arg.getText("query") orelse "";
    const want = "want ?outpoint=<txid>.<vout>[,<txid>.<vout>…]";
    const text = (try reads.queryParam(a, q, "outpoint")) orelse return reads.httpError(a, 400, want);
    const list = (try reads.queryList(a, q, "outpoint")).?;
    if (list.len == 0) return reads.httpError(a, 400, want);
    const st = try loadState(a, in);
    if (std.mem.indexOfScalar(u8, text, ',') == null) {
        const op = reads.parseOutpoint(list[0]) orelse return reads.httpError(a, 400, want);
        return reads.httpCached(a, 200, "application/json", .state, try reads.spendJson(a, try reads.spendOf(a, st.ch, op)));
    }
    const ss = try a.alloc(reads.Spend, list.len);
    for (list, ss) |t, *o| o.* = try reads.spendOf(a, st.ch, reads.parseOutpoint(t) orelse return reads.httpError(a, 400, want));
    return reads.httpCached(a, 200, "application/json", .state, try reads.spendsJson(a, ss));
}

/// The public read routes' functions (0.34.0; the manifest's filters name them).
const Read = enum { poolsBeef, positions, validatorFees, commissionFees, readTerms, tx, trades, candles, stats, poolsAt, poolsHistory };

/// One public read (reads.zig): P3 to P7, P9 (0.44.0: P10 `/swaps` gone with the relay records).
fn publicRead(a: Allocator, in: Value, arg: Value, r: Read) !Value {
    const q = arg.getText("query") orelse "";
    switch (r) {
        .readTerms => return termsRead(a, in),
        .tx => return txRead(a, in, q),
        else => {},
    }
    const rec = (try headRecord(a, token_head)) orelse return reads.httpError(a, 404, "no token yet: this instance has had no deploy");
    const token = rec.getText("tokenId") orelse return reads.httpError(a, 404, "no token yet: this instance has had no deploy");
    const st = try loadState(a, in);
    var svc = try reads.loadLookup(a, vm.store(), try vm.head(a, try lookup.headName(a, iface.app_name, amm_lookup.service_name)));
    // The history reads (0.36.0): the trade rows, each trade's height from the overlay's `placed`.
    const hist: ?reads.History = switch (r) {
        .trades => .trades,
        .candles => .candles,
        .stats => .stats,
        .poolsAt => .poolsAt,
        .poolsHistory => .poolsHistory,
        else => null,
    };
    if (hist) |h| return reads.historyRead(a, &svc, st.ch, st.map("placed"), token, h, q, @intCast(st.now));
    const list = switch (r) {
        .poolsBeef => "pool",
        .positions => "pool",
        .validatorFees => "id",
        .commissionFees => "pkh",
        else => unreachable,
    };
    const keys = try reads.queryList(a, q, list);
    if (r == .poolsBeef) {
        const pools = reads.currentPools(a, &svc, st.ch, token, keys) catch |e| return badQuery(a, e);
        const txids = try a.alloc([32]u8, pools.len);
        for (pools, txids) |p, *t| t.* = (reads.rowOutpoint(p) orelse return error.BadIndex).txid;
        const beef = try ov.state.beefOfMany(st.ch, txids);
        return reads.httpCached(a, 200, "application/json", .state, try reads.poolsBeefJson(a, pools, beef));
    }
    const ks = keys orelse return reads.httpError(a, 400, try std.fmt.allocPrint(a, "want ?{s}=k1,k2", .{list}));
    const field = switch (r) {
        .positions => "poolIds",
        .validatorFees => "validatorIdentityKeys",
        .commissionFees => "commissionPkhs",
        else => unreachable,
    };
    const v = reads.lookupAnswer(a, &svc, st.ch, token, field, ks) catch |e| return badQuery(a, e);
    return reads.httpCached(a, 200, "application/json", .state, try reads.valueJson(a, v));
}

/// A lookup's refusal of a query (a key that is not hex of its length) as 400.
fn badQuery(a: Allocator, e: anyerror) !Value {
    if (e == error.BadQuery) return reads.httpError(a, 400, "a key that is not hex of its length");
    return e;
}

/// P7 `/terms`: `amm.pool.terms` and `amm.swap.terms` in one, unsigned (reads.zig `termsJson`).
fn termsRead(a: Allocator, in: Value) !Value {
    const t = try validatorTerms(a);
    const identity: ?[]const u8 = if (in.get("self")) |me| me.getBytes("identity") else null;
    const v: ?reads.ValidatorTerms = if (t) |tt| .{
        .identity = identity,
        .peer_id = selfPeerText(a, in),
        .lp_fee_bps = @intCast(tt.lp_fee_bps),
        .validator_fee_bps = @intCast(tt.validator_fee_bps),
        .commission_bps = @intCast(tt.commission_bps),
        .min_leg_sats = tt.min_leg_sats,
    } else null;
    const com = try commissionKey(a);
    const m = try marketNow(a);
    return reads.httpCached(a, 200, "application/json", .state, try reads.termsJson(a, v, com.pkh, m.min_commission_bps));
}

/// P9 `/tx?id=<txid>`: the transaction's Atomic BEEF from the chain state with EVERY input's source in
/// it, mined or not, the transaction itself without a BUMP (0.44.2, `reads.txBeef`), `application/octet-stream`; `imm` only when it is
/// proven; 404 unknown, or when the chain lacks an input's source.
fn txRead(a: Allocator, in: Value, q: []const u8) !Value {
    const id = (try reads.queryParam(a, q, "id")) orelse return reads.httpError(a, 400, "want ?id=<txid>");
    const txid = reads.parseTxid(id) orelse return reads.httpError(a, 400, "want ?id=<txid>: 64 hex characters");
    const st = try loadState(a, in);
    const beef = (reads.txBeef(a, st.ch, txid) catch |e| switch (e) {
        error.MissingAncestor => return reads.httpError(a, 404, "the chain state lacks an input's source transaction"),
        else => return e,
    }) orelse return reads.httpError(a, 404, "unknown transaction");
    return reads.httpCached(a, 200, "application/octet-stream", try reads.txCache(st.ch, txid), beef);
}

/// The serving side of the direct call: one request frame, one reply frame. A utility since 0.2.0:
/// no row routes `/amm/proofs/1.0.0` (sync is shruggr/skein#112's `want`).
fn proofsByBlock(a: Allocator, in: Value, arg: Value) !Value {
    const msg = try stream.inbound(arg);
    return stream.directAnswer(a, try proofs.serve(a, views.held(try loadState(a, in)), msg.body));
}

// ---------------------------------------------------------------- outbound: emit

/// Emit `body` to `to` in `box` (docs/MESSAGES.md "emit"): → the message's CID. It goes out when the step ends without error.
fn emit(a: Allocator, to: []const u8, box: []const u8, body: Value) ![]const u8 {
    const msg = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "to", .value = .{ .bytes = to } },
        .{ .key = "box", .value = .{ .text = box } },
        .{ .key = "body", .value = .{ .bytes = try cbor.encode(a, body) } },
    }) });
    return vm.result(a, vm.sk.emit, .{ msg.ptr, @as(u32, @intCast(msg.len)) });
}

fn walletCall(a: Allocator, frame: []const u8) ![]const u8 {
    return vm.result(a, ext.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
}

/// This instance's libp2p peer ID (David, 2026-10-05): the signer's public key for protocol
/// `[2, "skein instance"]` (skein src/host/signer.ts `INSTANCE_PROTOCOL`), key ID
/// `libp2p:<handle>`, counterparty self, as an identity multihash (stream.zig `peerIdOf`).
/// The host derives its node's key the same way, from the instance's root (skein 387e057,
/// src/host/signer.ts `peerKey`: `[2, "skein instance"]` / `libp2p:<handle>` / self), so this
/// is the peer ID the node runs.
fn selfPeerId(a: Allocator, in: Value) ![]const u8 {
    const me = in.get("self") orelse return error.NoSelf;
    const handle = me.getText("handle") orelse return error.NoHandle;
    const key_id = try std.fmt.allocPrint(a, "libp2p:{s}", .{handle});
    const pk = try wire.publicKeyResult(try walletCall(a, try wire.getPublicKeyFrameFor(a, stream.instance_protocol.level, stream.instance_protocol.name, key_id, .self, null)));
    return stream.peerIdOf(a, pk);
}

// ---------------------------------------------------------------- steps

fn step(a: Allocator, in: Value) !void {
    const s = vm.store();
    const args = in.get("args") orelse return error.BadInput;
    // A message in this program's box `amm/amm-p2p`: a call {fn, args} (APPS.md §4). (Before
    // 0.7.0 the app's box `amm`, shared with the overlay engine by sender; since shruggr/skein#143 a
    // box has one route, and `amm` is the engine's: its own watch, resume and wait.)
    if (eql(u8, args.getText("box") orelse "", names.own_box)) {
        if (args.getCid("body")) |bc| {
            const body = try s.getValue(a, bc);
            // Root's market record (0.16.0; `roles.root` gates `market`).
            if (eql(u8, body.getText("fn") orelse "", iface.market.fn_market)) return marketStep(a, args, body);
            if (body.get("fn") != null) return appMessage(a, in, args, body);
        }
    }
    // 0.44.1 (David Case 2026-11-06): nothing else steps this program. The catch-up pass (a cron-ticked
    // pull of proofs by block, a placeholder from before the overlay sync, with its own reply deadline)
    // is gone, and with it the tick, its config and the cursor under `amm/p2p`.
    return error.BadInput;
}

/// Whether this call is a filter's: the input's `filter: true` (skein docs/APPS.md §2 "Filters").
fn isFilter(in: Value) bool {
    const f = in.get("filter") orelse return false;
    return f == .boolean and f.boolean;
}

/// An http answer `{status, type?, headers?, body}` as a filter's `{answer: …}`.
fn asFilterAnswer(a: Allocator, http: Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "answer", .value = http }}) };
}

/// The read `/` (`{address: "/", prefix: true, program: "amm-p2p", fn: "serve", root: "www", index:
/// "index.html"}` in the manifest's `reads[]`, shruggr/skein#135; the read is the request's `match`):
/// the app's pages from its own tree, the installed app record's `tree` (skein-sdk `files.serve`,
/// shruggr/skein#125). It reads only: the head `amm/app` and the tree's blobs.
fn servePages(a: Allocator, arg: Value) !Value {
    const req = try toSdk(a, arg);
    const m = try app.manifestOf(a, iface.app_name);
    return fromSdk(a, try files.serve(a, req, scbor.Value.cidOf(m.get("tree")), files.rowOptions(req)));
}

// ---------------------------------------------------------------- the app: amm.swap/1 and amm.pool/1

/// The SDK's dag-cbor and the wallet library's are the same encoding; values cross by bytes.
fn toSdk(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}

fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}

/// The installed app record (the head `amm/app`'s root, `kind: "app"`), or null.
fn appRecord(a: Allocator) !?Value {
    const c = (try vm.head(a, iface.app_head)) orelse return null;
    const v = try vm.store().getValue(a, c);
    return if (eql(u8, v.getText("kind") orelse "", "app")) v else null;
}

/// The manifest the dispatch reads `provides` from: the installed app record,
/// else (wired by the genesis) `{kind: "app", name: "amm", provides}` with
/// `provides` from genesis `defaults.ammProvides` (the manifest's, as JSON).
fn manifest(a: Allocator, in: Value) !scbor.Value {
    if (try appRecord(a)) |rec| return toSdk(a, rec);
    const d = in.get("defaults") orelse return sk.report("no app record (head amm/app) and no defaults.ammProvides");
    const text = d.getText("ammProvides") orelse return sk.report("no app record (head amm/app) and no defaults.ammProvides");
    const provides = dagjson.decode(a, text) catch return sk.report("defaults.ammProvides is not JSON");
    var m = scbor.MapBuilder.init(a);
    try m.put("kind", scbor.string("app"));
    try m.put("name", scbor.string(iface.app_name));
    try m.put("provides", provides);
    return m.value();
}

/// How the function was reached (the in-VM functions read the step's input from it).
const Ctx = struct {
    in: Value,
    mode: enum { route, message, call },
};
var ctx: Ctx = undefined;

const fns = [_]app.Function{
    .{ .name = iface.fn_terms, .run = termsFn },
    .{ .name = iface.fn_pool_terms, .run = poolTermsFn },
    .{ .name = iface.fn_pool_affirm, .run = poolAffirmFn },
};

fn isAppFn(name: []const u8) bool {
    for (fns) |f| if (eql(u8, f.name, name)) return true;
    return false;
}

/// A function's failure with the VM import's message when it has one.
fn failure(a: Allocator, e: anyerror) anyerror {
    if (e == error.Reported or e == error.OutOfMemory) return e;
    return sk.report(std.fmt.allocPrint(a, "{s}{s}{s}", .{ @errorName(e), if (vm.lastError().len > 0) ": " else "", vm.lastError() }) catch "failed");
}

fn poolAffirmFn(c: *app.Call) anyerror!scbor.Value {
    return poolAffirm(c) catch |e| failure(c.a, e);
}

/// amm.pool.affirm {pool, satoshis} → {validatorPubKey, nonce, signature} (0.11.0, David Case
/// 2026-10-21; 0.13.0, 2026-10-22: the validator's nonce, no keyInput): the
/// proposed pool to this instance's own validator — the package (box `affirm`, from this
/// instance to itself) handed to amm-validator's fn `affirm` in-VM — which checks it against the terms and answers its signature at once, or the refusal
/// (`<reason>[: <detail>]`). Nothing is recorded.
fn poolAffirm(c: *app.Call) !scbor.Value {
    const a = c.a;
    const args = try fromSdk(a, c.args);
    const body = (try iface.affirmBody(a, args)) orelse return sk.report("bad_request: want {pool: bytes, satoshis: int}");
    const me = try signerIdentity(&signer_dummy, a);
    const pkg = try iface.package(a, signer(), &me, iface.affirm_box, body, try iface.affirmNonce(a, body), null); // in-VM: no stream to route
    const ans = try callValidator(a, ctx.in, iface.affirm_protocol, iface.affirm_box, pkg);
    return switch (iface.affirmAnswer(a, ans)) {
        .ok => |v| toSdk(a, v),
        .refused => |r| sk.report(try iface.refusalText(a, r)),
    };
}

/// The validator's terms (0.9.0, David Case 2026-10-09: "Fees are the validator's"; 0.15.0, David
/// 2026-10-23: a runtime record root sets, no fee numbers in the image): the record of the head
/// `amm/terms` `{lpFeeBps, validatorFeeBps, commissionBps}` (src/terms.zig; amm-validator writes it
/// on root's `terms` and reads the same), or null — none set: a market only. No fallback
/// (`config.amm.ammValidator`, 0.9.0 to 0.14.2, is gone).
///
/// (0.17.0, shruggr/skein-amm#4) No head yet: the app record's `config.overlay.terms`, the initial
/// value (src/terms.zig `current`), as amm-validator and the engine's beat read them.
fn validatorTerms(a: Allocator) !?terms.Terms {
    const head: ?Value = if (try vm.head(a, try terms.headName(a, iface.app_name))) |rc| try vm.store().getValue(a, rc) else null;
    return terms.current(head, try appRecord(a));
}

/// amm.pool.terms {} → {validator: <identity, bytes 33>, peerId?: text, lpFeeBps, validatorFeeBps,
/// commissionBps}: the terms with this instance's identity and peer ID (the validator a pool here
/// names: `amm.pool.affirm` asks it, in-VM); none set, the error "no validator here".
fn poolTermsFn(c: *app.Call) anyerror!scbor.Value {
    const a = c.a;
    const t = validatorTerms(a) catch |e| return failure(a, e);
    const identity: ?[]const u8 = if (ctx.in.get("self")) |me| me.getBytes("identity") else null;
    const answer = (try iface.poolTerms(a, identity, selfPeerText(a, ctx.in), t)) orelse return sk.report(terms.no_validator);
    return toSdk(a, answer);
}

/// This exchange's commission key (0.16.0, the agent's call, "David to review"): hash160 of this
/// instance's own key for the commission, through the signer: BRC-43 level 1, protocol `amm
/// commission`, key ID `relay`, counterparty anyone, forSelf (interface.zig `commission_protocol`; as
/// the validator's keys are derived, amm-validator oracle.zig). No config (`config.amm.commission`,
/// to 0.15.0, is gone).
fn commissionKey(a: Allocator) !iface.Commission {
    const pk = try wire.publicKeyResult(try walletCall(a, try wire.getPublicKeyFrameFor(a, iface.commission_protocol.level, iface.commission_protocol.name, iface.commission_key_id, .anyone, true)));
    return .{ .pkh = w.bsvz.crypto.hash.hash160(&pk).bytes };
}

/// The market record now (0.16.0): the root of the head `amm/market` (market.zig), or the default
/// (a minimum of 0) when none is set or it was cleared.
///
/// (0.17.0, shruggr/skein-amm#4) No head yet: the app record's `config["amm-p2p"].market`, the
/// initial value a token instance's create gives (market.zig `current`).
fn marketNow(a: Allocator) !iface.market.Market {
    const head: ?Value = if (try vm.head(a, try iface.market.headName(a, iface.app_name))) |rc| try vm.store().getValue(a, rc) else null;
    return iface.market.current(head, try appRecord(a));
}

/// amm.swap.terms {} → {commissionPkh: bytes(20) | null, minCommissionBps}: what the page names as
/// Swap's commissionPkh before it builds the swap, and (0.16.0) this market's minimum commission,
/// the pools the Swap page lists.
fn termsFn(c: *app.Call) anyerror!scbor.Value {
    const a = c.a;
    const com = commissionKey(a) catch |e| return failure(a, e);
    const m = marketNow(a) catch |e| return failure(a, e);
    return toSdk(a, iface.terms(a, com, m) catch |e| return failure(a, e));
}

/// Root's `{fn: "market", args}` in this program's box (0.16.0; the role `root` gates it, the
/// kernel's gate, before the step; market.zig): set (`args` `{minCommissionBps}`) or clear (`args:
/// null`) the record under `amm/market`, and answer `{fn: "market", request, replyTo, result: <the
/// record> | null}` — or `error: {code: "bad-args", message}`, nothing written — to the sender in
/// this box. Nothing refuses by it: a listing preference, not a rule.
fn marketStep(a: Allocator, args: Value, body: Value) !void {
    const s = vm.store();
    const message = args.getCid("message") orelse return error.BadInput;
    const func = iface.market.fn_market;
    const rec: ?Value = switch (iface.market.parseArgs(body.get("args"))) {
        .bad => null,
        .set => |m| try iface.market.record(a, m),
        .clear => .null,
    };
    const answer = if (rec) |r| blk: {
        try vm.advance(try iface.market.headName(a, iface.app_name), try s.putValue(a, r));
        break :blk try iface.answerMessage(a, func, message, r);
    } else try iface.errorMessage(a, func, message, "bad-args", iface.market.parseArgs(body.get("args")).bad);
    const sent = try answerSender(a, args.getBytes("sender"), answer);
    _ = try vm.finish(a, s, try resultRecord(a, func, &.{
        .{ .key = "answer", .value = answer },
        .{ .key = "sent", .value = .{ .boolean = sent } },
    }));
}

/// This node's own peer ID (base58), or null when it cannot be had (no handle): a caller naming it
/// names this instance's own validator (amm.pool.terms answers it as `peerId`).
fn selfPeerText(a: Allocator, in: Value) ?[]const u8 {
    const id = selfPeerId(a, in) catch return null;
    return stream.peerIdText(a, id) catch null;
}

fn dispatch(a: Allocator, in: Value, name: []const u8, args: ?scbor.Value, sender: ?[]const u8) !app.Outcome {
    return app.run(a, try toSdk(a, in), iface.app_name, try manifest(a, in), &fns, name, args, sender);
}

/// An in-VM call of amm.swap.*: the result, or the call's error.
fn appCall(a: Allocator, in: Value, func: []const u8, arg: Value) !Value {
    ctx = .{ .in = in, .mode = .call };
    return switch (try dispatch(a, in, func, try toSdk(a, arg), null)) {
        .ok => |v| fromSdk(a, v),
        .err => |f| {
            std.Io.File.stderr().writeStreamingAll(sk.io(), try std.fmt.allocPrint(a, "{s}: {s}: {s}\n", .{ func, @tagName(f.code), f.message })) catch {};
            return error.CallFailed;
        },
    };
}

fn routeAnswer(a: Allocator, status_code: u16, body: scbor.Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status_code } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = try dagjson.encode(a, body) } },
    }) };
}

fn failureValue(a: Allocator, f: app.Failure) !scbor.Value {
    var e = scbor.MapBuilder.init(a);
    try e.put("code", scbor.string(@tagName(f.code)));
    try e.put("message", scbor.string(f.message));
    return e.value();
}

/// The `/call` route (APPS.md §4; the SDK's `app` route): the body is `{fn, args}` (JSON /
/// dag-json, or dag-cbor as application/cbor); the answer `{fn, result}` (200) or `{fn, error}`
/// (400, 403, 404, 409, 500). Every function answers at once (0.44.0: `amm.swap.submit`, the one
/// that waited on a relay thread, is gone).
fn appRoute(a: Allocator, in: Value, arg: Value) !Value {
    ctx = .{ .in = in, .mode = .route };
    const caller = arg.getBytes("caller");
    var name: []const u8 = "";
    const outcome: app.Outcome = blk: {
        if (!eql(u8, arg.getText("method") orelse "", "POST")) break :blk .{ .err = .{ .code = .@"bad-request", .message = "POST {fn, args}" } };
        const raw = arg.getBytes("body") orelse "";
        const ct = arg.getText("contentType") orelse "";
        const body = (if (eql(u8, ct, "application/cbor")) scbor.decode(a, raw) else dagjson.decode(a, raw)) catch
            break :blk .{ .err = .{ .code = .@"bad-request", .message = "the body is not {fn, args} (JSON, or dag-cbor as application/cbor)" } };
        if (body != .map) break :blk .{ .err = .{ .code = .@"bad-request", .message = "the body is not {fn, args}" } };
        name = scbor.Value.str(body.get("fn")) orelse break :blk .{ .err = .{ .code = .@"bad-request", .message = "fn is not text" } };
        break :blk try dispatch(a, in, name, body.get("args"), caller);
    };
    var ans = scbor.MapBuilder.init(a);
    try ans.put("fn", scbor.string(name));
    var code: u16 = 200;
    switch (outcome) {
        .ok => |v| try ans.put("result", v),
        .err => |f| {
            code = f.code.status();
            try ans.put("error", try failureValue(a, f));
        },
    }
    return routeAnswer(a, code, ans.value());
}

/// Whether the address book reaches `key` (an answer goes out only then).
fn reachable(a: Allocator, key: []const u8) !bool {
    const s = vm.store();
    const root = (try vm.head(a, "peers")) orelse return false;
    const book = try s.getValue(a, root);
    for (book.getArray("peers") orelse return false) |e| {
        const p = try s.getValue(a, e.getCid("peer") orelse continue);
        if (p.getBytes("key")) |k| if (eql(u8, k, key)) return true;
    }
    return false;
}

fn resultRecord(a: Allocator, op: []const u8, fields: []const cbor.Entry) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-p2p-result" } },
        .{ .key = "op", .value = .{ .text = op } },
    });
    try es.appendSlice(a, fields);
    return .{ .map = es.items };
}

/// Answer a message's sender in the app's box, when the address book reaches it (APPS.md §4).
fn answerSender(a: Allocator, sender: ?[]const u8, answer: Value) !bool {
    const s = sender orelse return false;
    if (!try reachable(a, s)) return false;
    _ = try emit(a, s, names.own_box, answer);
    return true;
}

/// A message `{fn, args}` in box `amm/amm-p2p`: the call, answered to the sender (in that box) now.
fn appMessage(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message") orelse return error.BadInput;
    const sender = args.getBytes("sender");
    ctx = .{ .in = in, .mode = .message };
    const sbody = try toSdk(a, body);
    const name = scbor.Value.str(sbody.get("fn"));
    const outcome: app.Outcome = if (name) |n|
        try dispatch(a, in, n, sbody.get("args"), sender)
    else
        .{ .err = .{ .code = .@"bad-request", .message = "fn is not text" } };
    const func = name orelse "";
    const answer = switch (outcome) {
        .ok => |v| try iface.answerMessage(a, func, message, try fromSdk(a, v)),
        .err => |f| try iface.errorMessage(a, func, message, @tagName(f.code), f.message),
    };
    const sent = try answerSender(a, sender, answer);
    _ = try vm.finish(a, vm.store(), try resultRecord(a, func, &.{
        .{ .key = "answer", .value = answer },
        .{ .key = "sent", .value = .{ .boolean = sent } },
    }));
}

// ---------------------------------------------------------------- the affirm package's signer

var signer_dummy: u8 = 0;

fn signerIdentity(_: *anyopaque, a: Allocator) anyerror![33]u8 {
    return wire.publicKeyResult(try walletCall(a, try wire.identityKeyFrame(a)));
}

fn signerSign(_: *anyopaque, a: Allocator, hash: [32]u8) anyerror![]const u8 {
    return wire.signatureResult(try walletCall(a, try wire.createSignatureFrame(a, 2, iface.envelope_protocol, iface.envelope_key_id, .anyone, hash)));
}

/// This instance's identity, signing the package through the `wallet` import (BRC-169's message signature).
fn signer() iface.Signer {
    return .{ .ctx = &signer_dummy, .identityFn = signerIdentity, .signFn = signerSign };
}

/// The validator program's record: the installed app record's `programs["amm-validator"]`, else
/// the genesis's `programs["amm-validator"]`.
fn validatorProgram(a: Allocator, in: Value) ![]const u8 {
    if (try appRecord(a)) |rec| if (rec.get("programs")) |ps| if (ps.getCid("amm-validator")) |p| return p;
    if (in.get("programs")) |ps| if (ps.getCid("amm-validator")) |p| return p;
    return error.NoValidatorProgram;
}

/// amm-validator's fn `func` (`affirm`, 0.11.0: called in-VM only; the package's box), called in-VM
/// with the argument the front door gives a frame's handler: `{transport: "local", protocol, body:
/// <the package>, match: {program, fn, app}}` (`transport` "local": no stream, no remote peer; the
/// package carries who sent it). 0.44.0: the local swap relay that also called `swap` this way is
/// gone (the host hands a swap to a validator on its own node as an inbound frame).
fn callValidator(a: Allocator, in: Value, protocol: []const u8, func: []const u8, pkg: []const u8) !Value {
    const prog = try validatorProgram(a, in);
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "transport", .value = .{ .text = "local" } },
        .{ .key = "protocol", .value = .{ .text = protocol } },
        .{ .key = "body", .value = .{ .bytes = pkg } },
        .{ .key = "match", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "program", .value = .{ .cid = prog } },
            .{ .key = "fn", .value = .{ .text = func } },
            .{ .key = "app", .value = .{ .text = iface.app_name } },
        }) } },
    });
    return vm.call(a, prog, func, .{ .map = es.items });
}
