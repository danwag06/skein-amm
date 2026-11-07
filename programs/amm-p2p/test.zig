//! amm-p2p natively: the proofs-by-block direct call (its serving side), the names, the direct
//! call's shapes, amm.swap/1 terms, the affirmation, the commission key, the reads — over an
//! in-memory store (0.44.0: no relay; 0.44.1: no catch-up pass). The VM wiring (main.zig) is wasm32-wasi only.
const std = @import("std");
const w = @import("chain");
const wire = @import("wallet").wire;
const names = @import("src/names.zig");
const stream = @import("src/stream.zig");
const proofs = @import("src/proofs.zig");
/// js-libp2p's peer ID of the generator point's key (skein src/host/p2p.ts `peerIdOf` of the private key 1).
const PEER_ID_OF_G = "16Uiu2HAm3cuhhRL2msUuLF62KRSfneFDx94RsuouyW25Ho42cFMq";
const views = @import("src/views.zig");

const bsvz = w.bsvz;
const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const testing = std.testing;
const eql = std.mem.eql;

comptime {
    _ = &views.held;
}

fn expectTag(o: anytype, comptime tag: []const u8, reason: ?[]const u8) !void {
    if (!std.mem.eql(u8, @tagName(o), tag)) {
        std.debug.print("expected {s}, got {any}\n", .{ tag, o });
        return error.TestUnexpectedResult;
    }
    if (comptime std.mem.eql(u8, tag, "accept")) return;
    if (reason) |r| {
        const got = @field(o, tag);
        if (!std.mem.eql(u8, got, r)) {
            std.debug.print("expected {s} {s}, got {s}\n", .{ tag, r, got });
            return error.TestUnexpectedResult;
        }
    }
}

/// A value as the host stores it and a program reads it back (dag-cbor).
fn readBack(a: Allocator, v: Value) Value {
    return cbor.decode(a, cbor.encode(a, v) catch @panic("OOM")) catch @panic("bad cbor");
}

// ================================================================ proofs by block

fn parent(l: [32]u8, r: [32]u8) [32]u8 {
    return w.store.dblSha256(&(l ++ r));
}

const PE = std.meta.Elem(std.meta.Elem(@FieldType(w.merkle.MerklePath, "path")));

/// The BUMP of a four-transaction block (t0..t3) for the leaves `which`.
fn bump4(a: Allocator, height: u32, t: [4][32]u8, which: []const usize) ![]const u8 {
    var merged: ?w.merkle.MerklePath = null;
    for (which) |i| {
        const sib = i ^ 1;
        const l0 = try a.alloc(PE, 2);
        const me: PE = .{ .offset = i, .hash = .{ .bytes = t[i] }, .txid = true };
        const other: PE = .{ .offset = sib, .hash = .{ .bytes = t[sib] } };
        l0[0] = if (i < sib) me else other;
        l0[1] = if (i < sib) other else me;
        const up = if (i < 2) parent(t[2], t[3]) else parent(t[0], t[1]);
        const l1 = try a.dupe(PE, &.{.{ .offset = (i >> 1) ^ 1, .hash = .{ .bytes = up } }});
        const levels = try a.dupe([]PE, &.{ l0, l1 });
        const p: w.merkle.MerklePath = .{ .block_height = height, .path = levels };
        if (merged) |*m| try m.combine(&p, a) else merged = p;
    }
    return merged.?.bytes(a);
}

const FakeChain = struct {
    hash: [32]u8,
    root: [32]u8,
    height: u32,
    topic: std.AutoHashMap([32]u8, void),
    paths: std.AutoHashMap([32]u8, w.merkle.MerklePath),

    fn self(ctx: *anyopaque) *FakeChain {
        return @ptrCast(@alignCast(ctx));
    }
    fn heightOf(ctx: *anyopaque, h: [32]u8) anyerror!?u32 {
        return if (std.mem.eql(u8, &h, &self(ctx).hash)) self(ctx).height else null;
    }
    fn inTopic(ctx: *anyopaque, _: []const u8, t: [32]u8) anyerror!bool {
        return self(ctx).topic.contains(t);
    }
    fn provenAt(ctx: *anyopaque, a: Allocator, h: u32) anyerror![]const [32]u8 {
        if (h != self(ctx).height) return &.{};
        var out: std.ArrayList([32]u8) = .empty;
        var it = self(ctx).paths.keyIterator();
        while (it.next()) |k| try out.append(a, k.*);
        std.mem.sort([32]u8, out.items, {}, struct {
            fn lt(_: void, x: [32]u8, y: [32]u8) bool {
                return std.mem.order(u8, &x, &y) == .lt;
            }
        }.lt);
        return out.items;
    }
    fn proofFor(ctx: *anyopaque, _: Allocator, t: [32]u8) anyerror!?w.merkle.MerklePath {
        return self(ctx).paths.get(t);
    }
    fn held(f: *FakeChain) proofs.Held {
        return .{ .ctx = f, .heightOfFn = heightOf, .provenAtFn = provenAt, .inTopicFn = inTopic, .proofForFn = proofFor };
    }
};

test "proofs by block: the direct call's request and reply; one BUMP per block" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const t: [4][32]u8 = .{ .{1} ** 32, .{2} ** 32, .{3} ** 32, .{4} ** 32 };
    const root = parent(parent(t[0], t[1]), parent(t[2], t[3]));
    var f: FakeChain = .{ .hash = .{0xbb} ** 32, .root = root, .height = 100, .topic = .init(a), .paths = .init(a) };
    for ([_]usize{ 1, 2 }) |i| try f.paths.put(t[i], try w.merkle.MerklePath.parse(a, try bump4(a, 100, t, &.{i})));
    try f.topic.put(t[1], {});

    // The whole block (no topic): both paths merged into one BUMP proving both.
    const reply = try proofs.serve(a, f.held(), try proofs.encodeRequest(a, .{ .block_hash = f.hash }));
    const b = (try proofs.decodeReply(a, reply)).?;
    const p = try w.merkle.MerklePath.parse(a, b);
    for ([_]usize{ 1, 2 }) |i| try testing.expectEqualSlices(u8, &root, &(w.beef.rootFor(a, p, t[i]).?));
    try testing.expectEqualSlices(u8, &root, &(switch (try proofs.rootOf(a, b)) {
        .root => |r| r,
        .bad => return error.TestUnexpectedResult,
    }));

    // Restricted to the topic: only t1.
    const rt = (try proofs.decodeReply(a, try proofs.serve(a, f.held(), try proofs.encodeRequest(a, .{ .block_hash = f.hash, .topic = "tm_color_" ++ "ab" ** 32 ++ "_0" })))).?;
    const pt = try w.merkle.MerklePath.parse(a, rt);
    try testing.expect(w.beef.bumpHas(pt, t[1]));
    try testing.expect(!w.beef.bumpHas(pt, t[3]));

    // An unknown block, or a malformed request: missing.
    try testing.expect((try proofs.decodeReply(a, try proofs.serve(a, f.held(), try proofs.encodeRequest(a, .{ .block_hash = .{0xcc} ** 32 })))) == null);
    try testing.expect((try proofs.decodeReply(a, try proofs.serve(a, f.held(), "junk"))) == null);
}

test "names: tm_color_<txid>_0 and tm_color_<txid>_0-live (BRC-207), parsed here" {
    const o = "tm_color_" ++ "ab" ** 32 ++ "_0";
    const t = names.parse(o).?;
    try testing.expectEqual(names.Kind.overlay, t.kind);
    try testing.expectEqualSlices(u8, &([_]u8{0xab} ** 32), &t.id);
    const l = names.parse(o ++ "-live").?;
    try testing.expectEqual(names.Kind.live, l.kind);
    try testing.expectEqualStrings(o, l.overlay);
    var buf: [96]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    try testing.expectEqualStrings(o ++ "-live", try names.live(fba.allocator(), o));
    // Not ours: the engine's own suffixes, the old names, upper case, a suffix, a short id.
    try testing.expect(names.parse(o ++ "-proof") == null);
    try testing.expect(names.parse(o ++ "-admit") == null);
    try testing.expect(names.parse("tm_amm_" ++ "ab" ** 32) == null);
    try testing.expect(names.parse(o ++ "_live") == null);
    try testing.expect(names.parse("tm_color_" ++ "AB" ** 32 ++ "_0") == null);
    try testing.expect(names.parse(o ++ "_0") == null);
    // The old `tm_<txid>_0` is no topic (skein-1color 0.9.0: no alias), nor its `-live`; nor the
    // discovery topic, nor the bare `tm_<txid>`.
    try testing.expect(names.parse("tm_" ++ "ab" ** 32 ++ "_0") == null);
    try testing.expect(names.parse("tm_" ++ "ab" ** 32 ++ "_0-live") == null);
    try testing.expect(names.parse("tm_color") == null);
    try testing.expect(names.parse("tm_color_" ++ "ab" ** 32) == null);
    try testing.expect(names.parse("tm_" ++ "ab" ** 32) == null);
    try testing.expect(names.parse("tm_" ++ "ab" ** 32 ++ "-live") == null);
    try testing.expect(names.parse("tm_abcd-live") == null);
    // The names before BRC-207's wire names (skein-1color 0.10.0, 2026-10-21): no alias.
    try testing.expect(names.parse("tm_mandala_" ++ "ab" ** 32 ++ "_0") == null);
    try testing.expect(names.parse("tm_mandala_" ++ "ab" ** 32 ++ "_0-live") == null);
    try testing.expectEqualStrings("/amm/proofs/1.0.0", names.proofs_protocol);
}

test "the peer ID of a compressed secp256k1 key: the identity multihash of its protobuf PublicKey (js-libp2p's, 16Uiu2…)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var k: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&k, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const id = try stream.peerIdOf(a, k);
    try testing.expectEqual(@as(usize, 39), id.len);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 }, id[0..6]);
    try testing.expectEqualSlices(u8, &k, id[6..]);
    try testing.expectEqualStrings(PEER_ID_OF_G, try stream.peerIdText(a, id));
}

test "the direct call's shapes (stream.zig, 0.44.0): the handler's argument, the direct call's answer (0.44.1: no provider bodies)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const pid = "\x00\x25\x08\x02\x12\x21\x02" ++ "\x55" ** 32;
    // What the front door passes a route's handler.
    const arg: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "transport", .value = .{ .text = "libp2p" } },
        .{ .key = "topic", .value = .{ .text = "tm_x-live" } },
        .{ .key = "from", .value = .{ .bytes = pid } },
        .{ .key = "key", .value = .{ .bytes = pid[6..] } },
        .{ .key = "seqno", .value = .{ .bytes = "\x00\x00\x00\x00\x00\x00\x00\x07" } },
        .{ .key = "signature", .value = .{ .bytes = "sig" } },
        .{ .key = "body", .value = .{ .bytes = "body" } },
    }) };
    const in = try stream.inbound(arg);
    try testing.expectEqualSlices(u8, pid, in.from);
    try testing.expectEqualStrings("tm_x-live", in.topic.?);
    try testing.expectError(error.NotLibp2p, stream.inbound(.{ .map = &.{} }));

    const da = readBack(a, try stream.directAnswer(a, "reply"));
    try testing.expectEqualSlices(u8, "reply", da.getBytes("body").?);

    // The peer ID as text (base58btc), as amm.pool.terms answers it.
    try testing.expect((try stream.peerIdText(a, pid)).len > 0);
}

// ================================================================ amm.swap/1 (0.44.0: terms only; the host relays)

const iface = @import("src/interface.zig");
const app = @import("app");
const sk = @import("sk");
const scbor = @import("sdk_cbor");
const dagjson = @import("dagjson");
const message = @import("message");
const manifest_json = @import("app_manifest").json;
const color = @import("1color");
const pool_lib = @import("pool");
const vec = @import("vectors");
const Transaction = bsvz.transaction.Transaction;
const Script = bsvz.script.Script;

fn unhex(a: Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

fn p2pkhScript(a: Allocator, pkh: []const u8) ![]u8 {
    return std.mem.concat(a, u8, &.{ &.{ 0x76, 0xa9, 0x14 }, pkh, &.{ 0x88, 0xac } });
}

fn pushData(a: Allocator, data: []const u8) ![]u8 {
    if (data.len == 0) return a.dupe(u8, &.{0});
    if (data.len <= 0x4b) return std.mem.concat(a, u8, &.{ &.{@intCast(data.len)}, data });
    if (data.len <= 0xff) return std.mem.concat(a, u8, &.{ &.{ 0x4c, @intCast(data.len) }, data });
    var n: [2]u8 = undefined;
    std.mem.writeInt(u16, &n, @intCast(data.len), .little);
    return std.mem.concat(a, u8, &.{ &.{0x4d}, &n, data });
}

/// A minimal script number push (Rúnar's): OP_0, OP_1..OP_16, else little-endian with a sign byte when needed.
fn pushNum(a: Allocator, n: u64) ![]u8 {
    if (n == 0) return a.dupe(u8, &.{0});
    if (n <= 16) return a.dupe(u8, &.{@intCast(0x50 + n)});
    var b: [9]u8 = undefined;
    var len: usize = 0;
    var x = n;
    while (x > 0) : (x >>= 8) {
        b[len] = @intCast(x & 0xff);
        len += 1;
    }
    if (b[len - 1] & 0x80 != 0) {
        b[len] = 0;
        len += 1;
    }
    return pushData(a, b[0..len]);
}

fn hash160(b: []const u8) [20]u8 {
    return bsvz.crypto.hash.hash160(b).bytes;
}

/// Sign input `i` (P2PKH, ALL|FORKID) as go-sdk's p2pkh.Unlock does: `<DER ‖ 0x41> <pubkey>`.
fn signP2pkh(a: Allocator, tx: *Transaction, i: usize, src: []const u8, sats: u64, priv: [32]u8) !void {
    const k = try bsvz.primitives.ec.PrivateKey.fromBytes(priv);
    const pre = try bsvz.transaction.sighash.formatPreimage(a, tx, i, Script.init(src), @intCast(sats), 0x41);
    const sig = try k.signDigest(bsvz.crypto.hash.hash256(pre).bytes);
    const pubkey = (try k.publicKey()).toCompressedSec1();
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = Script.init(try std.mem.concat(a, u8, &.{ try pushData(a, try std.mem.concat(a, u8, &.{ sig.asSlice(), &.{0x41} })), try pushData(a, &pubkey) }));
    tx.inputs = ins;
}

/// A pair as the page builds it (docs/notes.md 2026-10-02, "Swap funding and
/// signing"), derived from the fixtures: the funding transaction spends the
/// taker's fund:1 and pays one exact output (the swap's input: amount in +
/// miner fee) to the taker, plus change; the swap is `swap_bsv_in` with its
/// other input replaced by that output, no change (`_changeAmount = 0`), its
/// commission (output 4, the pool's 10 bps of 20,000: 20 sats) and the call's
/// commissionPkh both paying `commission` (default: the relay's), the
/// preimage the pool call pushes recomputed, the validator's slot empty, and
/// the funding input signed by the taker. `fee` is the swap's miner fee (a
/// different fee makes a different swap). The fixtures carry no funding
/// parent of this shape (their swap spends fund:1 directly), so it is built
/// here.
// --- the dispatch, by the app's manifest (app/etc/app.json), with the functions over memory ---

const TestEnv = struct {
    commission: iface.Commission = ours,
    market: iface.market.Market = .{},
    seen_writes: ?bool = null,
};
var test_env: TestEnv = undefined;

/// This exchange's commission key hash in the tests: the fixtures' (gen/main.go `key(50)`, vectors' commission_pkh).
const commission_pkh: [20]u8 = blk: {
    @setEvalBranchQuota(10_000);
    var k: [20]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, vec.commission_pkh) catch unreachable;
    break :blk k;
};
const ours: iface.Commission = .{ .pkh = commission_pkh };

fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}
fn testTerms(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    return toSdkV(c.a, try iface.terms(c.a, test_env.commission, test_env.market));
}
fn toSdkV(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}
const test_fns = [_]app.Function{
    .{ .name = iface.fn_terms, .run = testTerms },
};

fn expectErr(o: app.Outcome, code: app.Code, msg_prefix: []const u8) !void {
    switch (o) {
        .ok => return error.TestExpectedError,
        .err => |f| {
            if (f.code != code or !std.mem.startsWith(u8, f.message, msg_prefix)) std.debug.print("expected {s} {s}, got {s} {s}\n", .{ @tagName(code), msg_prefix, @tagName(f.code), f.message });
            try testing.expectEqual(code, f.code);
            try testing.expect(std.mem.startsWith(u8, f.message, msg_prefix));
        },
    }
}

test "amm.swap/1 by the manifest (0.44.0, David Case 2026-11-06: the host relays, the instance logs facts, never attempts): terms only — no submit, no status; no /swaps read, no `swaps` filter, no `expires` anywhere in the manifest" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    test_env = .{};
    const m = try dagjson.decode(a, manifest_json);
    const in: scbor.Value = .{ .map = &.{} };
    try testing.expect((try app.declOf(a, m, "amm.swap.submit")) == null);
    try testing.expect((try app.declOf(a, m, "amm.swap.status")) == null);
    try expectErr(try app.run(a, in, iface.app_name, m, &test_fns, "amm.swap.submit", .{ .map = &.{} }, null), .@"unknown-fn", "amm.swap.submit");
    try testing.expect(m.get("filters").?.get("swaps") == null);
    for (m.get("routes").?.array) |r| try testing.expect(!eql(u8, scbor.Value.str(r.get("address")) orelse "", "/swaps"));
    try testing.expect(std.mem.indexOf(u8, manifest_json, "\"expires\"") == null);
    try testing.expect(std.mem.indexOf(u8, manifest_json, "amm-p2p.swaps") == null);

    // terms: this exchange's commission pkh, read-only as declared; none, null; no args taken.
    try testing.expect(!(try app.declOf(a, m, iface.fn_terms)).?.get("writes").?.bool);
    const t1 = try app.run(a, in, iface.app_name, m, &test_fns, iface.fn_terms, .{ .map = &.{} }, null);
    try testing.expect(t1 == .ok);
    try testing.expectEqual(@as(?bool, false), test_env.seen_writes);
    try testing.expectEqualSlices(u8, &commission_pkh, (try fromSdk(a, t1.ok)).getBytes("commissionPkh").?);
    test_env.commission = .{};
    const t2 = try app.run(a, in, iface.app_name, m, &test_fns, iface.fn_terms, null, null);
    try testing.expect(t2 == .ok);
    try testing.expect((try fromSdk(a, t2.ok)).get("commissionPkh").? == .null);
    test_env.commission = ours;
    // 0.16.0: the market's minimum beside it, 0 when none is set; the record's when set.
    try testing.expectEqual(@as(u64, 0), (try fromSdk(a, t1.ok)).getUint("minCommissionBps").?);
    test_env.market = .{ .min_commission_bps = 1 };
    const t3 = try app.run(a, in, iface.app_name, m, &test_fns, iface.fn_terms, null, null);
    try testing.expectEqual(@as(u64, 1), (try fromSdk(a, t3.ok)).getUint("minCommissionBps").?);
    test_env.market = .{};
    var targs = scbor.MapBuilder.init(a);
    try targs.put("pool", scbor.string("00" ** 32 ++ "_0"));
    try expectErr(try app.run(a, in, iface.app_name, m, &test_fns, iface.fn_terms, targs.value(), null), .@"bad-args", "args.pool: not in the shape");
}

test "the app's root head is <app>/app (skein-sdk 0.3.0 app.headOf)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(try app.headOf(arena.allocator(), iface.app_name), iface.app_head);
}

// ================================================================ the affirmation (amm.pool/1, 0.11.0)

test "affirm (0.13.0): the args {pool, satoshis} become the validator's body; its answer becomes {validatorPubKey, nonce, signature}, or the refusal; the manifest declares amm.pool.affirm (no writes) and no amm.pool.submit or status" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const pd = try Transaction.parse(a, unhex(a, vec.pool_deploy_unaffirmed));
    const script = pd.outputs[0].locking_script.bytes;
    const args: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "pool", .value = .{ .bytes = script } },
        .{ .key = "satoshis", .value = .{ .uint = vec.pool0.bsv } },
    }) };
    const body = (try iface.affirmBody(a, args)).?;
    try testing.expectEqualSlices(u8, script, body.getBytes("pool").?);
    try testing.expectEqual(@as(u64, vec.pool0.bsv), body.getUint("satoshis").?);
    try testing.expect(body.get("keyInput") == null);
    // Missing args: nothing to ask.
    try testing.expect((try iface.affirmBody(a, .{ .map = args.map[0..1] })) == null);
    // The package's nonce is the body's.
    try testing.expectEqualSlices(u8, &try iface.affirmNonce(a, body), &try iface.affirmNonce(a, body));
    const other = (try iface.affirmBody(a, .{ .map = try a.dupe(cbor.Entry, &.{ args.map[0], .{ .key = "satoshis", .value = .{ .uint = 1 } } }) })).?;
    try testing.expect(!std.mem.eql(u8, &try iface.affirmNonce(a, body), &try iface.affirmNonce(a, other)));

    // The validator's answer: {verdict, body: {ok: true, validatorPubKey, nonce, signature}} →
    // {validatorPubKey, nonce, signature}.
    const sig = unhex(a, vec.affirmation);
    const key = unhex(a, vec.pool0.validator);
    const nonce = unhex(a, vec.nonce);
    const frame = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "ok", .value = .{ .boolean = true } },
        .{ .key = "validatorPubKey", .value = .{ .bytes = key } },
        .{ .key = "nonce", .value = .{ .bytes = nonce } },
        .{ .key = "signature", .value = .{ .bytes = sig } },
    }) });
    const ans: Value = .{ .map = try a.dupe(cbor.Entry, &.{ .{ .key = "verdict", .value = .{ .text = "accept" } }, .{ .key = "body", .value = .{ .bytes = frame } } }) };
    const got = iface.affirmAnswer(a, ans);
    try testing.expectEqualSlices(u8, sig, got.ok.getBytes("signature").?);
    try testing.expectEqualSlices(u8, key, got.ok.getBytes("validatorPubKey").?);
    try testing.expectEqualSlices(u8, nonce, got.ok.getBytes("nonce").?);
    try testing.expectEqual(@as(usize, 3), got.ok.map.len);
    // Affirmed without the key or the nonce: a bad reply.
    const short = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{ .{ .key = "ok", .value = .{ .boolean = true } }, .{ .key = "signature", .value = .{ .bytes = sig } } }) });
    try testing.expectEqualStrings("bad_reply", iface.affirmAnswer(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "body", .value = .{ .bytes = short } }}) }).refused.reason);
    // A refusal: its reason and detail, as the function's error text.
    const nframe = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{ .{ .key = "ok", .value = .{ .boolean = false } }, .{ .key = "reason", .value = .{ .text = "fees_unacceptable" } }, .{ .key = "detail", .value = .{ .text = "lpFeeBps: the terms are 30" } } }) });
    const no = iface.affirmAnswer(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "body", .value = .{ .bytes = nframe } }}) });
    try testing.expectEqualStrings("fees_unacceptable: lpFeeBps: the terms are 30", try iface.refusalText(a, no.refused));
    try testing.expectEqualStrings("bad_reply", iface.affirmAnswer(a, .{ .map = &.{} }).refused.reason);

    // The manifest: amm.pool.affirm, no writes, its args; amm.pool.submit and status gone.
    const m = try dagjson.decode(a, manifest_json);
    const decl = (try app.declOf(a, m, iface.fn_pool_affirm)).?;
    try testing.expect(!decl.get("writes").?.bool);
    const dargs = decl.get("args").?;
    for ([_][]const u8{ "pool", "satoshis" }) |k| try testing.expect(dargs.get(k) != null);
    try testing.expect(dargs.get("keyInput") == null);
    for ([_][]const u8{ "validatorPubKey", "nonce", "signature" }) |k| try testing.expect(decl.get("answer").?.get(k) != null);
    try testing.expect((try app.declOf(a, m, "amm.pool.submit")) == null);
    try testing.expect((try app.declOf(a, m, "amm.pool.status")) == null);
    try testing.expect((try app.declOf(a, m, iface.fn_pool_terms)) != null);
}

test "market and validator are the engine's (0.6.0, shruggr/skein#120), root's switch (0.6.2, David 2026-10-07): no validate route, no start or stop, no config.amm.ammP2p.market; config.overlay.market / .validator absent, both off until root turns one on" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try dagjson.decode(a, manifest_json);
    for (m.get("routes").?.array) |row| {
        try testing.expect(!std.mem.eql(u8, scbor.Value.str(row.get("address")) orelse "", "validate"));
    }
    try testing.expect(m.get("start") == null and m.get("stop") == null);
    const config = m.get("config").?;
    if (if (config.get("amm")) |c| c.get("ammP2p") else null) |p2p| {
        try testing.expect(p2p.get("market") == null and p2p.get("heartbeatSeconds") == null and p2p.get("offlineSeconds") == null);
    }
    // "this shouldn't have been a config in the manifest. This should be a setting that the user is
    // configuring": root turns a role on at install (--config) or by the engine's switch.
    const ov_cfg = config.get("overlay").?;
    try testing.expect(ov_cfg.get("market") == null and ov_cfg.get("validator") == null);
}

test "the routes, filters and roles (shruggr/skein#143, 0.7.0; 0.17.0 the token app): no dispatch, reads or senders; the box amm is the engine's (derived), amm-p2p's box amm/amm-p2p; no register, no pages, no requests; the reads read routes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try dagjson.decode(a, manifest_json);
    try testing.expect(m.get("dispatch") == null and m.get("reads") == null);
    const gated = m.get("roles").?.get("root").?.array;
    // 0.17.0 (shruggr/skein-amm#4): no register, registerLookup, deregisterLookup — a token instance's
    // topic is its config's at birth; rescind, the validator's (0.13.0); terms, the validator's (0.15.0:
    // the runtime record); market, the market's (0.16.0: the runtime record).
    try testing.expectEqual(@as(usize, 3), gated.len);
    for ([_][]const u8{ "rescind", "terms", "market" }, gated) |x, g| try testing.expectEqualStrings(x, scbor.Value.str(g).?);
    const filters = m.get("filters").?;
    try testing.expect(filters.get("page") == null and filters.get("requests") == null);
    try testing.expectEqualStrings("color-lookup.tokens", scbor.Value.str(filters.get("tokens")).?);
    try testing.expectEqualStrings("amm-p2p.spends", scbor.Value.str(filters.get("spends")).?);
    var seen: u8 = 0;
    var seen_tokens = false;
    for (m.get("routes").?.array) |r| {
        try testing.expect(r.get("sender") == null and r.get("program") == null);
        const t = scbor.Value.str(r.get("transport")) orelse "mailbox";
        const addr = scbor.Value.str(r.get("address")).?;
        const h = scbor.Value.str(r.get("handler"));
        // No route of the app's own on its box `amm` ("" or "amm"): the engine's, derived.
        if (std.mem.eql(u8, t, "mailbox")) try testing.expect(addr.len > 0 and !std.mem.eql(u8, addr, "amm"));
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "amm-p2p")) {
            try testing.expectEqualStrings("amm-p2p", h.?);
            seen |= 1;
        }
        // 0.17.0: no register box, no pages, no holders' requests (the config app's).
        try testing.expect(!(std.mem.eql(u8, t, "mailbox") and (std.mem.eql(u8, addr, "register") or std.mem.eql(u8, addr, "requests"))));
        try testing.expect(!(std.mem.eql(u8, t, "http") and (std.mem.eql(u8, addr, "/") or std.mem.eql(u8, addr, "/requests"))));
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/call")) {
            try testing.expectEqualStrings("amm-p2p.call", h.?);
            try testing.expectEqualStrings("kernel.brc104", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen |= 2;
        }
        // 0.9.0: the validator's box (root's rescind, 0.13.0) and the read /spends.
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "validator")) {
            try testing.expectEqualStrings("amm-validator", h.?);
            seen |= 4;
        }
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/spends")) {
            try testing.expect(h == null);
            seen |= 8;
        }
        // No addLiquidity (0.9.0), no delivered deploy (0.11.0).
        try testing.expect(!std.mem.eql(u8, addr, "/amm-validator/1/addLiquidity"));
        try testing.expect(!std.mem.eql(u8, addr, "/amm-validator/1/deploy"));
        // The token list is /color/tokens (0.10.0, skein-1color 0.10.0); no /mandala/tokens.
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/color/tokens")) {
            try testing.expectEqualStrings("tokens", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen_tokens = true;
        }
        try testing.expect(!std.mem.eql(u8, addr, "/mandala/tokens"));
    }
    try testing.expectEqual(@as(u8, 15), seen);
    try testing.expect(seen_tokens);
    try testing.expectEqualStrings("amm/amm-p2p", names.own_box);
}

// ================================================================ the reads (0.9.0)

const reads = @import("src/reads.zig");

test "spends (0.9.0): the chain state of an outpoint — a pool followed from the deploy to its current output; closed by Close; unspent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var ch = try w.state.State.load(a, ms.store(), null, .regtest);
    for ([_][]const u8{ vec.fund, vec.token_deploy, vec.pool_deploy, vec.swap_bsv_in, vec.swap_tokens_in }) |h| {
        const raw = unhex(a, h);
        _ = try ch.putTx(w.beef.txidOf(raw), raw);
    }
    const pd = w.beef.txidOf(unhex(a, vec.pool_deploy));
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));
    // Followed: two swaps.
    const at_deploy = try reads.spendOf(a, &ch, .{ .txid = pd, .vout = 0 });
    try testing.expectEqual(@as(u32, 2), at_deploy.hops);
    try testing.expect(!at_deploy.closed);
    try testing.expectEqualSlices(u8, &s2, &at_deploy.current.?.txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(unhex(a, vec.swap_bsv_in)), &at_deploy.spent_by.?);
    // An output that is not a pool (the LP's token change): unspent.
    const change = try reads.spendOf(a, &ch, .{ .txid = pd, .vout = 2 });
    try testing.expect(change.spent_by == null and change.current == null);
    // Closed: the pool's last output spent by Close.
    const cl = unhex(a, vec.close);
    _ = try ch.putTx(w.beef.txidOf(cl), cl);
    const after = try reads.spendOf(a, &ch, .{ .txid = pd, .vout = 0 });
    try testing.expect(after.closed);
    try testing.expect(after.current == null);
    const json = try reads.spendJson(a, after);
    try testing.expect(std.mem.indexOf(u8, json, "\"closed\":true") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"hops\":2") != null);
    // The query.
    const q = reads.queryOutpoint("outpoint=" ++ "ab" ** 32 ++ ".4").?;
    try testing.expectEqual(@as(u32, 4), q.vout);
    try testing.expect(reads.queryOutpoint("x=1") == null);
}

test "amm.pool.terms (0.15.0): the record root set, with this validator's identity and peer; none set, no answer (\"no validator here\"); no fee numbers in the manifest" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const terms = @import("terms");
    const id: [33]u8 = .{2} ++ .{0x11} ** 32;
    const rec = try terms.record(a, .{ .lp_fee_bps = 30, .validator_fee_bps = 5, .commission_bps = 25 });
    const ans = (try iface.poolTerms(a, &id, PEER_ID_OF_G, terms.fromRecord(rec))).?;
    try testing.expectEqualSlices(u8, &id, ans.getBytes("validator").?);
    try testing.expectEqualStrings(PEER_ID_OF_G, ans.getText("peerId").?);
    try testing.expectEqual(@as(u64, 30), ans.getUint("lpFeeBps").?);
    try testing.expectEqual(@as(u64, 5), ans.getUint("validatorFeeBps").?);
    try testing.expectEqual(@as(u64, 25), ans.getUint("commissionBps").?);
    // No peer known: no peerId.
    try testing.expect((try iface.poolTerms(a, &id, null, terms.fromRecord(rec))).?.get("peerId") == null);
    // Unset (no head) or cleared (the record null): no answer; main.zig reports "no validator here".
    try testing.expect((try iface.poolTerms(a, &id, PEER_ID_OF_G, null)) == null);
    try testing.expect((try iface.poolTerms(a, &id, PEER_ID_OF_G, terms.fromRecord(.null))) == null);
    try testing.expectEqualStrings("no validator here", terms.no_validator);
    // The manifest ships no terms: config.amm has no ammValidator; amm.pool.terms is still declared.
    const m = try dagjson.decode(a, manifest_json);
    try testing.expect(m.get("config").?.get("amm") == null); // 0.16.0: no config.amm at all (commission gone too)
    try testing.expect((try app.declOf(a, m, iface.fn_pool_terms)) != null);
}

test "market terms (0.16.0, David 2026-10-24): a runtime record root sets — fn market gated by roles.root in the box amm/amm-p2p, the head amm/market; set, clear, refused shapes; unset 0; no config.amm.commission" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const market = iface.market;

    // The manifest: `market` is root's; the box amm-p2p routes to this program; no commission config.
    const m = try dagjson.decode(a, manifest_json);
    const gated = for (m.get("roles").?.get("root").?.array) |g| {
        if (eql(u8, scbor.Value.str(g).?, market.fn_market)) break true;
    } else false;
    try testing.expect(gated);
    try testing.expect(m.get("config").?.get("amm") == null);
    try testing.expectEqualStrings("amm/amm-p2p", names.own_box);
    try testing.expectEqualStrings("amm/market", try market.headName(a, iface.app_name));

    // Set: {minCommissionBps}, an integer 0 to 10 000.
    const set: Value = .{ .map = &.{.{ .key = "minCommissionBps", .value = .{ .uint = 25 } }} };
    const p = market.parseArgs(set);
    try testing.expect(p == .set);
    try testing.expectEqual(@as(u64, 25), p.set.min_commission_bps);
    try testing.expect(market.parseArgs(.{ .map = &.{.{ .key = "minCommissionBps", .value = .{ .uint = 10_000 } }} }) == .set);
    // Clear: args null, or none.
    try testing.expect(market.parseArgs(.null) == .clear);
    try testing.expect(market.parseArgs(null) == .clear);
    // Refused: over 10 000, negative, text, another key, missing, not a map.
    const bads = [_]Value{
        .{ .map = &.{.{ .key = "minCommissionBps", .value = .{ .uint = 10_001 } }} },
        .{ .map = &.{.{ .key = "minCommissionBps", .value = .{ .nint = 0 } }} },
        .{ .map = &.{.{ .key = "minCommissionBps", .value = .{ .text = "1" } }} },
        .{ .map = &.{ .{ .key = "minCommissionBps", .value = .{ .uint = 1 } }, .{ .key = "tokenId", .value = .{ .text = "x" } } } },
        .{ .map = &.{} },
        .{ .uint = 1 },
    };
    for (bads) |b| try testing.expect(market.parseArgs(b) == .bad);

    // The record round trip; cleared (null), no head or a bad record: 0.
    const rec = try market.record(a, p.set);
    try testing.expectEqualSlices(u8, try cbor.encode(a, set), try cbor.encode(a, rec));
    try testing.expectEqual(@as(u64, 25), market.fromRecord(rec).min_commission_bps);
    try testing.expectEqual(@as(u64, 0), market.fromRecord(.null).min_commission_bps);
    try testing.expectEqual(@as(u64, 0), market.fromRecord(null).min_commission_bps);

}

test "the commission key (0.16.0): the instance's own, BRC-43 level 1 `amm commission` / `relay`, counterparty anyone — the signer's key for it is the one anyone derives from the identity" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const kd_mod = bsvz.primitives.key_deriver;
    const proto: kd_mod.Protocol = .{ .security_level = iface.commission_protocol.level, .name = iface.commission_protocol.name };
    try testing.expectEqual(@as(u8, 1), iface.commission_protocol.level);
    try testing.expectEqualStrings("amm commission", iface.commission_protocol.name);
    try testing.expectEqualStrings("relay", iface.commission_key_id);
    const root = try bsvz.primitives.ec.PrivateKey.fromBytes(.{0x07} ** 32);
    const identity = (try root.publicKey()).toCompressedSec1();
    // The signer's (forSelf, counterparty anyone: getPublicKey's answer to main.zig `commissionKey`).
    const signer = kd_mod.KeyDeriver.init(root);
    const mine = (try signer.derivePublicKey(a, proto, iface.commission_key_id, .{ .type_ = .anyone }, true)).toCompressedSec1();
    // Anyone's, from the identity alone.
    const anyone = kd_mod.KeyDeriver.init(null);
    const theirs = (try anyone.derivePublicKey(a, proto, iface.commission_key_id, .{ .type_ = .other, .public_key = try bsvz.primitives.ec.PublicKey.fromSec1(&identity) }, false)).toCompressedSec1();
    try testing.expectEqualSlices(u8, &mine, &theirs);
    // amm.swap.terms answers its hash160.
    const pkh = hash160(&mine);
    const t = try iface.terms(a, .{ .pkh = pkh }, .{});
    try testing.expectEqualSlices(u8, &pkh, t.getBytes("commissionPkh").?);
}

test {
    _ = iface.market;
}

// ================================================================ the public read API (0.34.0)

const lookup_mod = @import("lookup");
const amm_idx = @import("amm_lookup");
const ov_engine = @import("skein_overlay");

fn ltxOf(a: Allocator, raw: []const u8) !lookup_mod.Tx {
    const txid = w.beef.txidOf(raw);
    const cid = w.store.hashCid(.tx, txid);
    return .{ .cid = try a.dupe(u8, cid[0..]), .txid = txid, .tx = try Transaction.parse(a, raw) };
}

fn mineHeader(prev: [32]u8, merkle_root: [32]u8, time: u32) [80]u8 {
    var h = w.header.Header{ .version = 1, .prev_hash = prev, .merkle_root = merkle_root, .time = time, .bits = 0x207fffff, .nonce = 0 };
    while (true) : (h.nonce += 1) {
        const raw = h.serialize();
        if (w.header.powOk(&raw)) return raw;
    }
}

/// A BUMP for a block holding one transaction: its root is the txid.
fn soloPath(a: Allocator, height: u32, txid: [32]u8) ![]const u8 {
    var path: std.ArrayList(u8) = .empty;
    try path.appendSlice(a, &.{ 0xfd, 0, 0, 0x01, 0x01, 0x00, 0x02 });
    std.mem.writeInt(u16, path.items[1..3], @intCast(height), .little);
    try path.appendSlice(a, &txid);
    return path.items;
}

/// The fixtures' pool and its two Swaps, admitted by the pool lookup's hooks (as amm-lookup's own
/// tests do) over a store holding them; the chain state holding them too, `fund` proven in block 1.
const ReadEnv = struct {
    ms: w.store.MemStore,
    svc: lookup_mod.Service,
    ch: w.state.State,
    token: []const u8,
    topic: []const u8,
    /// The header chain's tip (hash, height) after the fixtures' blocks: the next block builds on it.
    tip: [32]u8 = undefined,
    height: u32 = 0,

    fn init(a: Allocator) !*ReadEnv {
        const e = try a.create(ReadEnv);
        e.ms = w.store.MemStore.init(testing.allocator);
        const s = e.ms.store();
        const id = w.beef.txidOf(unhex(a, vec.token_deploy));
        e.token = try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(id)});
        e.topic = try amm_idx.topicOf(a, e.token);
        e.svc = try reads.loadLookup(a, s, null);
        e.ch = try w.state.State.load(a, s, null, .regtest);
        const all = [_][]const u8{ vec.fund, vec.token_deploy, vec.pool_deploy, vec.swap_bsv_in, vec.swap_tokens_in };
        var held = std.AutoHashMap([32]u8, void).init(a);
        for (all) |h| {
            const raw = unhex(a, h);
            _ = try s.putBitcoin(a, .tx, raw);
            _ = try e.ch.putTx(w.beef.txidOf(raw), raw);
            try held.put(w.beef.txidOf(raw), {});
        }
        // Mined, one block each: every fixture transaction spending one not held (the funding ones),
        // so the chain state's BEEFs reach proven transactions.
        var prev = w.header.hash(&w.chain.Network.regtest.genesis());
        var height: u32 = 0;
        for (all) |h| {
            const t = try Transaction.parse(a, unhex(a, h));
            var roots = false;
            for (t.inputs) |in| roots = roots or !held.contains(in.previous_outpoint.txid.bytes);
            if (!roots) continue;
            const txid = w.beef.txidOf(unhex(a, h));
            height += 1;
            const hd = mineHeader(prev, txid, 1_700_000_000 + height * 600);
            _ = try e.ch.addHeaders(&.{&hd});
            prev = w.header.hash(&hd);
            try e.ch.putProof(txid, try w.merkle.MerklePath.parse(a, try soloPath(a, height, txid)));
        }
        e.tip = prev;
        e.height = height;
        const pd = unhex(a, vec.pool_deploy);
        const s1 = unhex(a, vec.swap_bsv_in);
        const s2 = unhex(a, vec.swap_tokens_in);
        try amm_idx.admitted(a, &e.svc, e.topic, try ltxOf(a, pd), &.{ 0, 1, 2 }, &.{0});
        try amm_idx.admitted(a, &e.svc, e.topic, try ltxOf(a, s1), &.{ 0, 1 }, &.{0});
        try amm_idx.spent(a, &e.svc, e.topic, .{ .txid = w.beef.txidOf(pd), .vout = 0 }, try ltxOf(a, s1));
        try amm_idx.admitted(a, &e.svc, e.topic, try ltxOf(a, s2), &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
        try amm_idx.spent(a, &e.svc, e.topic, .{ .txid = w.beef.txidOf(s1), .vout = 0 }, try ltxOf(a, s2));
        return e;
    }
    fn deinit(self: *ReadEnv) void {
        self.ms.deinit();
    }
};

const unknown_lp = "02" ++ "a0" ** 32;
/// A pool id no pool has, and the fixtures' (its deploy's outpoint, `<txid>_0`; 0.40.0).
const unknown_pool = "a0" ** 32 ++ "_0";
fn poolText(a: Allocator) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(w.beef.txidOf(unhex(a, vec.pool_deploy)))});
}

fn jsonOf(a: Allocator, text: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, a, text, .{});
}

test "read API (0.34.0): the routes and their filters in the manifest — plain reads, no handler; no /pools (the host's)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try dagjson.decode(a, manifest_json);
    const want = [_][2][]const u8{
        .{ "/pools/beef", "poolsBeef" },
        .{ "/positions", "positions" },
        .{ "/fees/validator", "validatorFees" },
        .{ "/fees/commission", "commissionFees" },
        .{ "/terms", "readTerms" },
        .{ "/spends", "spends" },
        .{ "/tx", "tx" },
        .{ "/trades", "trades" },
        .{ "/candles", "candles" },
        .{ "/stats", "stats" },
        .{ "/pools/at", "poolsAt" },
        .{ "/pools/history", "poolsHistory" },
    };
    for (want) |x| {
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "amm-p2p.{s}", .{x[1]}), scbor.Value.str(m.get("filters").?.get(x[1])).?);
        var found = false;
        for (m.get("routes").?.array) |r| {
            if (!eql(u8, scbor.Value.str(r.get("address")).?, x[0])) continue;
            try testing.expectEqualStrings("http", scbor.Value.str(r.get("transport")).?);
            try testing.expect(r.get("handler") == null);
            try testing.expectEqualStrings(x[1], scbor.Value.str(r.get("filters").?.array[0]).?);
            found = true;
        }
        try testing.expect(found);
    }
    for (m.get("routes").?.array) |r| try testing.expect(!eql(u8, scbor.Value.str(r.get("address")).?, "/pools"));
    // 0.37.0: the token's 1Color reads (color-lookup.token: /color/<tokenId>/holders) under one prefix row.
    try testing.expectEqualStrings("color-lookup.token", scbor.Value.str(m.get("filters").?.get("colorToken")).?);
    var prefix_row = false;
    for (m.get("routes").?.array) |r| if (eql(u8, scbor.Value.str(r.get("address")).?, "/color/")) {
        try testing.expect(r.get("handler") == null);
        try testing.expectEqualStrings("colorToken", scbor.Value.str(r.get("filters").?.array[0]).?);
        prefix_row = true;
    };
    try testing.expect(prefix_row);
}

test "read API (0.34.0): list parameters — comma-separated, percent-decoded, in order; absent is null" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const l = (try reads.queryList(a, "?x=1&lp=02aa%2C03bb,,04cc", "lp")).?;
    try testing.expectEqual(@as(usize, 3), l.len);
    try testing.expectEqualStrings("02aa", l[0]);
    try testing.expectEqualStrings("03bb", l[1]);
    try testing.expectEqualStrings("04cc", l[2]);
    try testing.expect((try reads.queryList(a, "lpx=1", "lp")) == null);
    try testing.expectEqual(@as(usize, 0), (try reads.queryList(a, "lp=", "lp")).?.len);
}

test "read API (0.34.0; 0.40.0 by pool id): P4 /positions — the lookup's {poolIds} answer, one record per id in query order, an unknown id closed with zeros; P5, P6 likewise; a bad id refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));

    const v = try reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "poolIds", &.{ unknown_pool, try poolText(a) });
    const j = try jsonOf(a, try reads.valueJson(a, v));
    try testing.expectEqual(@as(usize, 2), j.array.items.len);
    const first = j.array.items[0].object;
    try testing.expectEqualStrings(unknown_pool, first.get("poolId").?.string);
    try testing.expect(first.get("lpPubKey").? == .null);
    try testing.expectEqualStrings("closed", first.get("status").?.string);
    try testing.expectEqual(@as(i64, 0), first.get("sats").?.integer);
    const mine = j.array.items[1].object;
    try testing.expectEqualStrings(try poolText(a), mine.get("poolId").?.string);
    try testing.expectEqualStrings(vec.lp, mine.get("lpPubKey").?.string);
    try testing.expectEqualStrings("live", mine.get("status").?.string);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(s2)}), mine.get("outpoint").?.string);
    try testing.expectEqualStrings(vec.lp, mine.get("current").?.object.get("lpPubKey").?.string);
    try testing.expectEqualStrings(try poolText(a), mine.get("current").?.object.get("poolId").?.string);
    try testing.expectEqual(@as(i64, 2), mine.get("current").?.object.get("swaps").?.integer);
    try testing.expectEqual(@as(i64, 2), mine.get("swaps").?.integer);

    const vf = try jsonOf(a, try reads.valueJson(a, try reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "validatorIdentityKeys", &.{ vec.identity, unknown_lp })));
    try testing.expectEqualStrings(vec.identity, vf.array.items[0].object.get("validatorIdentityKey").?.string);
    try testing.expectEqual(@as(i64, 2), vf.array.items[0].object.get("swaps").?.integer);
    try testing.expectEqual(@as(i64, 0), vf.array.items[1].object.get("swaps").?.integer);

    const unknown_pkh = "55" ** 20;
    const cf = try jsonOf(a, try reads.valueJson(a, try reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "commissionPkhs", &.{unknown_pkh})));
    try testing.expectEqualStrings(unknown_pkh, cf.array.items[0].object.get("commissionPkh").?.string);
    try testing.expectEqual(@as(i64, 0), cf.array.items[0].object.get("swaps").?.integer);

    try testing.expectError(error.BadQuery, reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "poolIds", &.{"02zz"}));
}

test "read API (0.34.0; 0.40.0 by pool id): P3 /pools/beef — the pool ids' current pools (an unknown id none), every live pool with no id; one BEEF of their transactions" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));

    const mine = try reads.currentPools(a, &e.svc, &e.ch, e.token, &.{ unknown_pool, try poolText(a) });
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqualSlices(u8, &s2, &reads.rowOutpoint(mine[0]).?.txid);
    try testing.expectEqualStrings(vec.lp, mine[0].getText("lpPubKey").?);
    try testing.expect(mine[0].get("validatorPeerId") == null);
    try testing.expectEqual(@as(usize, 0), (try reads.currentPools(a, &e.svc, &e.ch, e.token, &.{unknown_pool})).len);
    const all = try reads.currentPools(a, &e.svc, &e.ch, e.token, null);
    try testing.expectEqual(@as(usize, 1), all.len);

    const beef = try ov_engine.state.beefOfMany(&e.ch, &.{s2});
    const j = try jsonOf(a, try reads.poolsBeefJson(a, mine, beef));
    try testing.expectEqual(@as(usize, 1), j.object.get("pools").?.array.items.len);
    const b64 = j.object.get("beef").?.string;
    const back = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(b64));
    try std.base64.standard.Decoder.decode(back, b64);
    try testing.expectEqualSlices(u8, beef, back);
    // The BEEF holds the pool's transaction and its ancestry to the proven funding.
    const parsed = try w.beef.parse(a, back);
    var has = false;
    for (parsed.entries) |en| has = has or eql(u8, &en.txid, &s2);
    try testing.expect(has);
}

test "read API (0.34.0): P8 /spends list form — one record per outpoint in query order" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const pd = w.beef.txidOf(unhex(a, vec.pool_deploy));
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));
    const ss = [_]reads.Spend{
        try reads.spendOf(a, &e.ch, .{ .txid = s2, .vout = 0 }),
        try reads.spendOf(a, &e.ch, .{ .txid = pd, .vout = 0 }),
    };
    const j = try jsonOf(a, try reads.spendsJson(a, &ss));
    try testing.expectEqual(@as(usize, 2), j.array.items.len);
    try testing.expect(j.array.items[0].object.get("spentBy") == null);
    try testing.expectEqual(@as(i64, 0), j.array.items[0].object.get("hops").?.integer);
    try testing.expectEqual(@as(i64, 2), j.array.items[1].object.get("hops").?.integer);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}.0", .{&w.header.toHex(s2)}), j.array.items[1].object.get("current").?.string);
}

test "read API (0.34.0): P9 /tx — the transaction's BEEF; immutable only when proven, else the short cache; unknown none" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const fund = w.beef.txidOf(unhex(a, vec.fund));
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));
    try testing.expectEqual(reads.Cache.imm, try reads.txCache(&e.ch, fund));
    try testing.expectEqual(reads.Cache.state, try reads.txCache(&e.ch, s2));
    try testing.expect((try e.ch.beefOf(s2)) != null);
    try testing.expect((try e.ch.beefOf(.{0x77} ** 32)) == null);
    try testing.expect(reads.parseTxid(&w.header.toHex(s2)) != null);
    try testing.expect(reads.parseTxid("abc") == null);
    const h = try reads.httpCached(a, 200, "application/octet-stream", .imm, "x");
    try testing.expectEqualStrings("public, max-age=31536000, immutable", h.get("headers").?.getText("cache-control").?);
    try testing.expectEqualStrings("application/octet-stream", h.getText("type").?);
    try testing.expectEqualStrings("public, max-age=5", reads.Cache.state.header());
}

/// The door's check over a served BEEF (skein door.zig `spv`: `chain.spv.verify`, nothing known): the
/// fixtures' blocks hold one transaction each, so a block's root is its transaction's txid.
fn doorVerify(a: Allocator, e: *ReadEnv, bytes: []const u8) !w.spv.Result {
    const Ctx = struct {
        e: *ReadEnv,
        a: Allocator,
        fn rootAt(ptr: *anyopaque, height: u32) anyerror!?[32]u8 {
            const c: *@This() = @ptrCast(@alignCast(ptr));
            for ([_][]const u8{ vec.fund, vec.token_deploy, vec.pool_deploy, vec.swap_bsv_in, vec.swap_tokens_in }) |h| {
                const id = w.beef.txidOf(unhex(c.a, h));
                if (try c.e.ch.proofFor(id)) |p| if (p.block_height == height) return id;
            }
            return null;
        }
        fn knownRaw(_: *anyopaque, _: Allocator, _: [32]u8) anyerror!?[]const u8 {
            return null;
        }
    };
    var ctx = Ctx{ .e = e, .a = a };
    return w.spv.verify(a, try w.beef.parse(a, bytes), .{ .ptr = &ctx, .rootAtFn = Ctx.rootAt, .knownRawFn = Ctx.knownRaw });
}

fn expectEverySource(a: Allocator, b: w.beef.Beef, raw: []const u8) !void {
    const tx = try Transaction.parse(a, raw);
    for (tx.inputs) |in| try testing.expect(b.find(in.previous_outpoint.txid.bytes) != null);
}

test "read API (0.44.2): P9 /tx serves every input's source — the swap unmined (sources with their ancestry) and mined (BUMP alone from beefOf, sources added); each passes the door's check" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const raw = unhex(a, vec.swap_tokens_in);
    const s2 = w.beef.txidOf(raw);
    // Unmined: the sources are the pool's transaction (itself unmined, with its own ancestry) and the funding.
    const b1 = try w.beef.parse(a, (try reads.txBeef(a, &e.ch, s2)).?);
    try testing.expectEqualSlices(u8, &s2, &b1.subject().?);
    try expectEverySource(a, b1, raw);
    _ = try doorVerify(a, e, try w.beef.serialize(a, b1));
    // Mined: beefOf is the transaction and its BUMP only; the served BEEF still has every source, and the
    // transaction itself carries no BUMP (an Atomic BEEF cannot carry a proven subject's sources).
    const hd = mineHeader(e.tip, s2, 1_700_100_000);
    _ = try e.ch.addHeaders(&.{&hd});
    try e.ch.putProof(s2, try w.merkle.MerklePath.parse(a, try soloPath(a, e.height + 1, s2)));
    try testing.expectEqual(w.state.Status.proven, try e.ch.status(s2));
    const bare = try w.beef.parse(a, (try e.ch.beefOf(s2)).?);
    try testing.expectEqual(@as(usize, 1), bare.entries.len);
    const b2 = try w.beef.parse(a, (try reads.txBeef(a, &e.ch, s2)).?);
    try testing.expectEqualSlices(u8, &s2, &b2.subject().?);
    try testing.expect(b2.entries.len > 1);
    try testing.expect(b2.find(s2).?.bump == null);
    try expectEverySource(a, b2, raw);
    _ = try doorVerify(a, e, try w.beef.serialize(a, b2));
    // Unknown: none.
    try testing.expect((try reads.txBeef(a, &e.ch, .{0x77} ** 32)) == null);
}

test "read API (0.34.0): P7 /terms — the validator's terms with its identity and peer, and the market's; no terms, validator null" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const id = unhex(a, vec.identity);
    const pkh: [20]u8 = .{0x55} ** 20;
    const j = try jsonOf(a, try reads.termsJson(a, .{ .identity = id, .peer_id = PEER_ID_OF_G, .lp_fee_bps = 30, .validator_fee_bps = 5, .commission_bps = 25, .min_leg_sats = 10_000 }, pkh, 10));
    const v = j.object.get("validator").?.object;
    try testing.expectEqualStrings(vec.identity, v.get("identity").?.string);
    try testing.expectEqualStrings(PEER_ID_OF_G, v.get("peerId").?.string);
    try testing.expectEqual(@as(i64, 30), v.get("lpFeeBps").?.integer);
    try testing.expectEqual(@as(i64, 5), v.get("validatorFeeBps").?.integer);
    try testing.expectEqual(@as(i64, 25), v.get("commissionBps").?.integer);
    try testing.expectEqual(@as(i64, 10_000), v.get("minLegSats").?.integer); // 0.40.0
    const m = j.object.get("market").?.object;
    try testing.expectEqualStrings("55" ** 20, m.get("commissionPkh").?.string);
    try testing.expectEqual(@as(i64, 10), m.get("minCommissionBps").?.integer);
    const none = try jsonOf(a, try reads.termsJson(a, null, pkh, 0));
    try testing.expect(none.object.get("validator").? == .null);
    try testing.expectEqual(@as(i64, 0), none.object.get("market").?.object.get("minCommissionBps").?.integer);
}

fn httpBody(v: Value) []const u8 {
    return v.getBytes("body").?;
}

fn httpStatus(v: Value) u64 {
    return v.getUint("status").?;
}

test "history reads (0.36.0): H1 /trades — newest first, each row's height from the overlay's `placed` (null until the proof lands), limit and cursor, ?pool= (0.40.0), ?txid= (404 none); bad parameters 400" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    amm_idx.now_ms = 7_000;
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const s1 = w.beef.txidOf(unhex(a, vec.swap_bsv_in));
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));
    const maps = try w.store.Maps.create(a, e.ms.store());
    var placed = maps.map(null);
    const tp = try amm_idx.tokenPrefix(a, e.token);

    const r0 = try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "", 0);
    try testing.expectEqual(@as(u64, 200), httpStatus(r0));
    try testing.expectEqualStrings("public, max-age=5", r0.get("headers").?.getText("cache-control").?);
    const j0 = try jsonOf(a, httpBody(r0));
    const rows = j0.object.get("trades").?.array.items;
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expect(rows[0].object.get("height").? == .null);
    try testing.expect(j0.object.get("next").? == .null);
    // Same time: txid order, newest (greatest) first.
    const first: [32]u8 = if (std.mem.order(u8, &s1, &s2) == .gt) s1 else s2;
    try testing.expectEqualStrings(&w.header.toHex(first), rows[0].object.get("txid").?.string);
    for (rows) |r| {
        const o = r.object;
        try testing.expectEqualStrings(vec.lp, o.get("lpPubKey").?.string);
        try testing.expectEqualStrings(try poolText(a), o.get("poolId").?.string);
        try testing.expectEqual(@as(usize, 40), o.get("payoutPkh").?.string.len);
        try testing.expectEqual(@as(i64, 7_000), o.get("at").?.integer);
        const buy = eql(u8, o.get("txid").?.string, &w.header.toHex(s1));
        try testing.expectEqualStrings(if (buy) "buy" else "sell", o.get("side").?.string);
        try testing.expectEqual(@as(i64, if (buy) 20_000 else 50_000), o.get("amountIn").?.integer);
        try testing.expectEqual(@as(i64, if (buy) 60 else 150), o.get("feeLp").?.integer);
        try testing.expectEqual(@as(i64, if (buy) 10 else 25), o.get("feeValidator").?.integer);
        try testing.expectEqual(@as(i64, if (buy) 20 else 50), o.get("feeCommission").?.integer);
        try testing.expect(o.get("amountOut").?.integer > 0);
        try testing.expect(o.get("bsvReserve").?.integer > 0 and o.get("tokenReserve").?.integer > 0);
    }

    // The proof landed for the sats-in Swap: the overlay placed it at height 42.
    var val: [44]u8 = .{0} ** 44;
    std.mem.writeInt(u32, val[0..4], 42, .big);
    try placed.put(try std.mem.concat(a, u8, &.{ tp, &s1 }), .{ .bytes = &val });
    const one = try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, try std.fmt.allocPrint(a, "txid={s}", .{&w.header.toHex(s1)}), 0)));
    try testing.expectEqual(@as(i64, 42), one.object.get("height").?.integer);
    try testing.expectEqualStrings("buy", one.object.get("side").?.string);
    const other = try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, try std.fmt.allocPrint(a, "txid={s}", .{&w.header.toHex(s2)}), 0)));
    try testing.expect(other.object.get("height").? == .null);
    try testing.expectEqual(@as(u64, 404), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, try std.fmt.allocPrint(a, "txid={s}", .{&w.header.toHex(w.beef.txidOf(unhex(a, vec.pool_deploy)))}), 0)));
    try testing.expectEqual(@as(u64, 404), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "txid=" ++ "77" ** 32, 0)));
    try testing.expectEqual(@as(u64, 400), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "txid=abc", 0)));

    // Paging: a full page carries the cursor; the next page from it; then an empty one.
    const pg1 = try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "limit=1", 0)));
    const cur = pg1.object.get("next").?.string;
    try testing.expectEqual(@as(usize, 80), cur.len);
    const pg2 = try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, try std.fmt.allocPrint(a, "limit=1&before={s}", .{cur}), 0)));
    try testing.expect(!eql(u8, pg1.object.get("trades").?.array.items[0].object.get("txid").?.string, pg2.object.get("trades").?.array.items[0].object.get("txid").?.string));
    const pg3 = try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, try std.fmt.allocPrint(a, "limit=1&before={s}", .{pg2.object.get("next").?.string}), 0)));
    try testing.expectEqual(@as(usize, 0), pg3.object.get("trades").?.array.items.len);
    // The window and the pool.
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "from=7001", 0)))).object.get("trades").?.array.items.len);
    try testing.expectEqual(@as(usize, 2), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, try std.fmt.allocPrint(a, "from=7000&to=7001&pool={s}", .{try poolText(a)}), 0)))).object.get("trades").?.array.items.len);
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "pool=" ++ unknown_pool, 0)))).object.get("trades").?.array.items.len);
    for ([_][]const u8{ "limit=501", "limit=0", "limit=x", "from=-1", "before=zz", "pool=02ab" }) |bad|
        try testing.expectEqual(@as(u64, 400), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, bad, 0)));
    try testing.expectEqual(@as(u64, 200), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "limit=500", 0)));
}

test "history reads (0.36.0): H2 /candles — the six resolutions, prices as {sats, tokens}, non-empty buckets only; a window over 5000 buckets, an unknown tf or a missing bound 400; H3 /stats" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    amm_idx.now_ms = 7_000;
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const maps = try w.store.Maps.create(a, e.ms.store());
    var placed = maps.map(null);

    for ([_][]const u8{ "1m", "5m", "15m", "1h", "4h", "1d" }) |tf| {
        const r = try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .candles, try std.fmt.allocPrint(a, "tf={s}&from=0&to=600000", .{tf}), 0);
        try testing.expectEqual(@as(u64, 200), httpStatus(r));
        const cs = (try jsonOf(a, httpBody(r))).array.items;
        try testing.expectEqual(@as(usize, 1), cs.len);
        const c = cs[0].object;
        try testing.expectEqual(@as(i64, 0), c.get("t").?.integer);
        try testing.expectEqual(@as(i64, 2), c.get("n").?.integer);
        try testing.expect(c.get("o").?.object.get("sats").?.integer > 0 and c.get("o").?.object.get("tokens").?.integer > 0);
        try testing.expect(c.get("volumeSats").?.integer > 20_000);
        try testing.expect(c.get("volumeTokens").?.integer > 50_000);
    }
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .candles, "tf=1m&from=7001&to=600000", 0)))).array.items.len);
    try testing.expectEqual(@as(u64, 200), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .candles, "tf=1m&from=0&to=300000000", 0)));
    for ([_][]const u8{ "tf=1m&from=0&to=300000001", "tf=2m&from=0&to=60000", "tf=1m&to=60000", "tf=1m&from=0", "from=0&to=60000", "tf=1m&from=10&to=5" }) |bad|
        try testing.expectEqual(@as(u64, 400), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .candles, bad, 0)));

    const st = (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .stats, "", 8_000)))).object;
    try testing.expectEqualStrings(e.token, st.get("tokenId").?.string);
    try testing.expect(st.get("lastTradePrice").?.object.get("sats").?.integer > 0);
    try testing.expect(st.get("price") == null); // 0.40.0: the host's
    try testing.expect(st.get("change1h").? == .null);
    try testing.expect(st.get("change24h").? == .null);
    try testing.expectEqual(@as(i64, 1), st.get("buys24h").?.integer);
    try testing.expectEqual(@as(i64, 1), st.get("sells24h").?.integer);
    try testing.expectEqual(@as(i64, 7_000), st.get("lastTradeAt").?.integer);
    try testing.expectEqual(@as(i64, 1), st.get("pools").?.integer);
    try testing.expect(st.get("tvlSats").?.integer > 0 and st.get("tvlTokens").?.integer > 0);
    try testing.expect(st.get("volume24hSats").?.integer > 20_000);
}

test "pool history reads (0.40.0): /pools/at?t= — every pool listed at t, its state after its last event at or before t; /pools/history — the window's events oldest first, one pool or all, the limit; bad parameters 400" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    amm_idx.now_ms = 7_000; // the deploy and both Swaps at 7,000 (ReadEnv)
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const maps = try w.store.Maps.create(a, e.ms.store());
    var placed = maps.map(null);
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));

    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsAt, "t=6999", 0)))).array.items.len);
    const at = (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsAt, "t=7000", 0)))).array.items;
    try testing.expectEqual(@as(usize, 1), at.len);
    const row = at[0].object;
    try testing.expectEqualStrings(try poolText(a), row.get("poolId").?.string);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(s2)}), row.get("outpoint").?.string);
    try testing.expectEqual(@as(i64, vec.pool2.bsv), row.get("bsvReserve").?.integer);
    try testing.expectEqual(@as(i64, vec.pool2.tokens), row.get("tokenReserve").?.integer);
    try testing.expectEqualStrings(vec.lp, row.get("lpPubKey").?.string);
    try testing.expectEqual(@as(i64, vec.lp_fee_bps), row.get("liquidityFeeBps").?.integer);
    try testing.expectEqual(@as(i64, vec.validator_fee_bps), row.get("validationFeeBps").?.integer);
    try testing.expectEqual(@as(i64, vec.commission_bps), row.get("commissionBps").?.integer);
    try testing.expectEqualStrings(vec.identity, row.get("validatorIdentityKey").?.string);
    try testing.expectEqual(@as(i64, 7_000), row.get("at").?.integer);
    try testing.expectEqual(@as(i64, 2), row.get("swaps").?.integer);
    try testing.expectEqual(@as(usize, 11), row.count());
    for ([_][]const u8{ "", "t=x", "t=-1" }) |bad|
        try testing.expectEqual(@as(u64, 400), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsAt, bad, 0)));

    const h = (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, "", 0)))).object;
    try testing.expect(h.get("next").? == .null);
    const evs = h.get("events").?.array.items;
    try testing.expectEqual(@as(usize, 3), evs.len);
    try testing.expectEqualStrings("deploy", evs[0].object.get("kind").?.string);
    try testing.expectEqual(@as(i64, 0), evs[0].object.get("swaps").?.integer);
    try testing.expect(evs[0].object.get("side") == null);
    const sw = evs[2].object;
    try testing.expectEqualStrings("swap", sw.get("kind").?.string);
    try testing.expectEqualStrings(&w.header.toHex(s2), sw.get("txid").?.string);
    try testing.expectEqualStrings("sell", sw.get("side").?.string);
    try testing.expectEqual(@as(i64, 50_000), sw.get("amountIn").?.integer);
    try testing.expectEqual(@as(i64, 150), sw.get("feeLp").?.integer);
    try testing.expectEqual(@as(usize, 40), sw.get("payoutPkh").?.string.len);
    try testing.expectEqualStrings(vec.commission_pkh, sw.get("commissionPkh").?.string);
    // Forward paging: limit=1 page by page through `next` (104 hex: at ‖ poolId ‖ seq) gives every event once, in order.
    var seen: std.ArrayList([]const u8) = .empty;
    var q: []const u8 = "limit=1";
    var pages: usize = 0;
    while (true) : (pages += 1) {
        const pg = (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, q, 0)))).object;
        const items = pg.get("events").?.array.items;
        try testing.expectEqual(@as(usize, 1), items.len);
        try seen.append(a, items[0].object.get("kind").?.string);
        if (pg.get("next").? == .null) break;
        const nx = pg.get("next").?.string;
        try testing.expectEqual(@as(usize, 104), nx.len);
        q = try std.fmt.allocPrint(a, "limit=1&after={s}", .{nx});
        try testing.expect(pages < 5);
    }
    try testing.expectEqual(@as(usize, 3), seen.items.len);
    try testing.expectEqualStrings("deploy", seen.items[0]);
    try testing.expectEqualStrings("swap", seen.items[2]);
    try testing.expectEqual(@as(u64, 400), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, "after=zz", 0)));
    try testing.expectEqual(@as(usize, 3), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, try std.fmt.allocPrint(a, "from=7000&to=7001&pool={s}", .{try poolText(a)}), 0)))).object.get("events").?.array.items.len);
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, "pool=" ++ unknown_pool, 0)))).object.get("events").?.array.items.len);
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, "to=7000", 0)))).object.get("events").?.array.items.len);
    for ([_][]const u8{ "limit=501", "limit=0", "from=x", "pool=02ab" }) |bad|
        try testing.expectEqual(@as(u64, 400), httpStatus(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, bad, 0)));
}

test "spends (0.40.0, VERIFY): /spends answers spentBy for a plain sats output a Swap spent — the taker's funding output fund:1, spent by swap_bsv_in, held by the chain state as the overlay's admission leaves it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const fund = w.beef.txidOf(unhex(a, vec.fund));
    const s1 = w.beef.txidOf(unhex(a, vec.swap_bsv_in));
    // fund:1 is a plain P2PKH output (the taker's sats), no token prefix, not a pool.
    const ft = try Transaction.parse(a, unhex(a, vec.fund));
    try testing.expectEqual(@as(usize, 25), ft.outputs[1].locking_script.bytes.len);
    const sp = try reads.spendOf(a, &e.ch, .{ .txid = fund, .vout = 1 });
    try testing.expectEqualSlices(u8, &s1, &sp.spent_by.?);
    try testing.expect(sp.current == null and !sp.closed and sp.hops == 0);
    const j = (try jsonOf(a, try reads.spendJson(a, sp))).object;
    try testing.expectEqualStrings(&w.header.toHex(s1), j.get("spentBy").?.string);
    // An output nobody spent (fund:3): no spentBy.
    try testing.expect((try reads.spendOf(a, &e.ch, .{ .txid = fund, .vout = 3 })).spent_by == null);
}

test "pool events (0.41.0): each emitted event's row is the `/pools/history` row byte for byte — the route's JSON is the events' rows' JSON in order" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    amm_idx.now_ms = 7_000;
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const maps = try w.store.Maps.create(a, e.ms.store());
    var placed = maps.map(null);
    // The deploy and the two Swaps ReadEnv admitted: three pool events, in order.
    const evs = e.svc.events.items;
    try testing.expectEqual(@as(usize, 3), evs.len);
    var want: std.ArrayList(u8) = .empty;
    try want.appendSlice(a, "{\"events\":[");
    for (evs, 0..) |ev, i| {
        try testing.expectEqualStrings("pool", ev.getText("event").?);
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "ls_amm_{s}", .{e.token}), ev.getText("topic").?);
        try testing.expectEqualStrings(e.token, ev.getText("tokenId").?);
        if (i > 0) try want.append(a, ',');
        try want.appendSlice(a, try reads.valueJson(a, ev.get("row").?));
    }
    try want.appendSlice(a, "],\"next\":null}");
    try testing.expectEqualStrings(want.items, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .poolsHistory, "", 0)));
}
