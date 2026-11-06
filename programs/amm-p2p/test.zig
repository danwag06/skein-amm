//! amm-p2p natively: the relay naming its validator (dialled, or this node's
//! own, called in-VM), the handler's answer; the proofs-by-block direct
//! call and the catch-up plan; the names, the cron provider's tick and the
//! libp2p provider's bodies and answers — over an in-memory store. The VM wiring (main.zig) is wasm32-wasi only.
const std = @import("std");
const w = @import("chain");
const wire = @import("wallet").wire;
const names = @import("src/names.zig");
const libp2p = @import("src/libp2p.zig");
const schedule = @import("src/schedule.zig");
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
    _ = &views.status;
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

test "catch-up plan" {
    // Nothing unsettled: the cursor follows the tip, nothing asked.
    const idle = proofs.catchupPlan(90, 100, 12, 6, false).?;
    try testing.expect(idle.from > idle.to);
    try testing.expectEqual(@as(u32, 100), idle.cursor);
    try testing.expect(proofs.catchupPlan(100, 100, 12, 6, false) == null);
    // Unsettled: after the cursor, a batch at a time, not past the tip.
    const p = proofs.catchupPlan(90, 100, 12, 6, true).?;
    try testing.expectEqual(@as(u32, 91), p.from);
    try testing.expectEqual(@as(u32, 96), p.to);
    try testing.expectEqual(@as(u32, 96), p.cursor);
    const q = proofs.catchupPlan(96, 100, 12, 6, true).?;
    try testing.expectEqual(@as(u32, 100), q.to);
    try testing.expect(proofs.catchupPlan(100, 100, 12, 6, true) == null);
    // No cursor yet: a window below the tip.
    try testing.expectEqual(@as(u32, 89), proofs.catchupPlan(null, 100, 12, 6, true).?.from);

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

test "the catch-up tick (skein#69, a utility since 0.6.0): the cron provider's tick read back; no heartbeat job" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // A tick as the provider sends it: {...body, kind, name, due}.
    const tick: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = "amm-p2p-tick" } },
        .{ .key = "job", .value = .{ .text = "catchup" } },
        .{ .key = "name", .value = .{ .text = "amm-p2p-catchup" } },
        .{ .key = "due", .value = .{ .uint = 1_790_000_000_000 } },
    }) };
    try testing.expectEqual(schedule.Job.catchup, try schedule.jobOf(tick));
    try testing.expectError(error.NotATick, schedule.jobOf(.{ .map = &.{} }));
    for ([_][]const u8{ "proofs", "heartbeat" }) |job| {
        const bad: Value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "amm-p2p-tick" } },
            .{ .key = "job", .value = .{ .text = job } },
        }) };
        try testing.expectError(error.BadTick, schedule.jobOf(bad));
    }
    try testing.expectEqualStrings("amm/amm-p2p", names.own_box);
}

// selfPeerId (main.zig) asks the signer for [2, "skein instance"] / `libp2p:<handle>` / self and
// takes this multihash of it; the host derives its node's key the same way from the instance's root
// (skein 387e057, src/host/signer.ts `peerKey`), so this is the node's peer ID (the relay's `isSelf`).
test "the peer ID of a compressed secp256k1 key: the identity multihash of its protobuf PublicKey (js-libp2p's, 16Uiu2…)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var k: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&k, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const id = try libp2p.peerIdOf(a, k);
    try testing.expectEqual(@as(usize, 39), id.len);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 }, id[0..6]);
    try testing.expectEqualSlices(u8, &k, id[6..]);
    try testing.expectEqualStrings(PEER_ID_OF_G, try libp2p.peerIdText(a, id));
}

test "libp2p adapter: the handler's argument, answers with admit entries, the direct call's answer, the provider's bodies and answers" {
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
    const in = try libp2p.inbound(arg);
    try testing.expectEqualSlices(u8, pid, in.from);
    try testing.expectEqualStrings("tm_x-live", in.topic.?);
    try testing.expectError(error.NotLibp2p, libp2p.inbound(.{ .map = &.{} }));

    // Accept carries the entries to admit ({event, box}); reject/ignore a reason only.
    const ev0: Value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "kind", .value = .{ .text = "x" } }}) };
    const ok = readBack(a, try libp2p.answer(a, .{ .accept = &.{.{ .box = "b", .event = ev0 }} }));
    try testing.expectEqualStrings("accept", ok.getText("verdict").?);
    try testing.expectEqualStrings("b", ok.getArray("admit").?[0].getText("box").?);
    const rej = try libp2p.answer(a, .{ .reject = "Why" });
    try testing.expectEqualStrings("reject", rej.getText("verdict").?);
    try testing.expectEqualStrings("Why", rej.getText("reason").?);
    try testing.expect(rej.get("admit") == null);
    const da = readBack(a, try libp2p.directAnswer(a, "reply"));
    try testing.expectEqualSlices(u8, "reply", da.getBytes("body").?);

    // Outbound: the provider's boxes and bodies; `dial` takes the peer as text.
    const p = try libp2p.publish(a, "tm_x-live", "b");
    try testing.expectEqualStrings("publish", p.box);
    try testing.expectEqualStrings("tm_x-live", readBack(a, p.body).getText("topic").?);
    const text = try libp2p.peerIdText(a, pid);
    try testing.expectEqualSlices(u8, pid, try libp2p.peerIdBytes(a, .{ .text = text }));
    const d = try libp2p.dial(a, text, names.proofs_protocol);
    try testing.expectEqualStrings("dial", d.box);
    try testing.expectEqualStrings(text, readBack(a, d.body).getText("peer").?);
    try testing.expectEqual(@as(u64, 3), readBack(a, (try libp2p.send(a, 3, "q")).body).getUint("stream").?);
    try testing.expectEqualStrings("close", (try libp2p.close(a, 3)).box);

    // The dial's answers: {stream} (box dial), a frame, its end, an error.
    const m = struct {
        fn of(al: Allocator, es: []const cbor.Entry) Value {
            return .{ .map = al.dupe(cbor.Entry, es) catch @panic("OOM") };
        }
    };
    try testing.expectEqual(@as(u64, 7), (try libp2p.dialAnswer("dial", m.of(a, &.{.{ .key = "stream", .value = .{ .uint = 7 } }}))).opened);
    try testing.expectEqualSlices(u8, "r", (try libp2p.dialAnswer("frame", m.of(a, &.{ .{ .key = "stream", .value = .{ .uint = 7 } }, .{ .key = "body", .value = .{ .bytes = "r" } } }))).frame);
    try testing.expect((try libp2p.dialAnswer("frame", m.of(a, &.{ .{ .key = "stream", .value = .{ .uint = 7 } }, .{ .key = "closed", .value = .{ .boolean = true } } }))) == .closed);
    try testing.expectEqualStrings("refused", (try libp2p.dialAnswer("dial", m.of(a, &.{.{ .key = "error", .value = .{ .text = "refused" } }}))).closed);
    try testing.expectError(error.BadAnswer, libp2p.dialAnswer("send", m.of(a, &.{})));
}

// ================================================================ the marketplace relay (amm.swap/1)

const relay = @import("src/relay.zig");
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

/// The fixtures' taker (gen/main.go `key(30)`), who owns fund:1.
const taker_priv: [32]u8 = .{30} ** 32;
/// The relay's commission key hash: the fixtures' relay (gen/main.go `key(50)`, vectors' commission_pkh).
const commission_pkh: [20]u8 = blk: {
    @setEvalBranchQuota(10_000);
    var k: [20]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, vec.commission_pkh) catch unreachable;
    break :blk k;
};
const relay_priv: [32]u8 = .{0x44} ** 32;

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
const Pair = struct { funding: []const u8, swap: []const u8, pool: []const u8, validator: [33]u8 };

const PairOpts = struct { commission: [20]u8 = commission_pkh, sign_funding: bool = true, fee: u64 = 500 };

fn buildPair(a: Allocator) !Pair {
    return buildPairWith(a, .{});
}

fn buildPairWith(a: Allocator, o: PairOpts) !Pair {
    const fund = try Transaction.parse(a, unhex(a, vec.fund));
    const pd_raw = unhex(a, vec.pool_deploy);
    const pd = try Transaction.parse(a, pd_raw);
    const base = try Transaction.parse(a, unhex(a, vec.swap_bsv_in));
    const taker_pkh = hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(taker_priv)).publicKey()).toCompressedSec1());
    const taker_lock = try p2pkhScript(a, &taker_pkh);

    // The swap's outputs: continuation, payout, LP fee, validator fee, commission (the fixture's, to `commission`).
    const outs = try a.dupe(bsvz.transaction.Output, base.outputs[0..5]);
    try std.testing.expectEqualSlices(u8, try p2pkhScript(a, &commission_pkh), outs[4].locking_script.bytes);
    outs[4].locking_script = Script.init(try p2pkhScript(a, &o.commission));
    var out_sum: u64 = 0;
    for (outs) |x| out_sum += @intCast(x.satoshis);
    const pool_sats: u64 = @intCast(pd.outputs[0].satoshis);
    const exact = out_sum - pool_sats + o.fee;

    // The funding transaction: fund:1 (500,000, the taker's) → exact, change.
    var f = fund;
    f.inputs = try a.dupe(bsvz.transaction.Input, &.{.{
        .previous_outpoint = .{ .txid = .{ .bytes = w.beef.txidOf(unhex(a, vec.fund)) }, .index = 1 },
        .unlocking_script = Script.empty(),
        .sequence = 0xffffffff,
    }});
    f.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = Script.init(taker_lock) },
        .{ .satoshis = @intCast(500_000 - exact - 300), .locking_script = Script.init(taker_lock) },
    });
    if (o.sign_funding) try signP2pkh(a, &f, 0, fund.outputs[1].locking_script.bytes, @intCast(fund.outputs[1].satoshis), taker_priv);
    const f_raw = try f.serialize(a);

    // The swap: the pool, then the funding output.
    var s = base;
    const sins = try a.dupe(bsvz.transaction.Input, &.{ base.inputs[0], .{
        .previous_outpoint = .{ .txid = .{ .bytes = w.beef.txidOf(f_raw) }, .index = 0 },
        .unlocking_script = Script.empty(),
        .sequence = 0xffffffff,
    } });
    s.inputs = sins;
    s.outputs = outs;
    const lock = color.brc162.decode(pd.outputs[0].locking_script.bytes).?.lock;
    const pre = try bsvz.transaction.sighash.formatPreimage(a, &s, 0, Script.init(lock[2..]), @intCast(pool_sats), 0x41);
    // The pool call, push by push (_codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
    // commissionPkh, tokenChangePkh, tokenChange, _changePKH, _changeAmount, txPreimage, methodIndex): the slot
    // empty, the commission's pkh, no token change (the fixture's), no change, the new preimage.
    const u = base.inputs[0].unlocking_script.bytes;
    var pos: usize = 0;
    var i: usize = 0;
    var script: std.ArrayList(u8) = .empty;
    while (pos < u.len) : (i += 1) {
        const p = color.brc162.readPush(u, pos).?;
        const raw = u[pos..p.next];
        try script.appendSlice(a, switch (i) {
            1 => &.{0}, // validatorSig: the slot, empty
            6 => try pushData(a, &o.commission),
            10 => &.{0}, // _changeAmount = 0
            11 => try pushData(a, pre),
            else => raw,
        });
        pos = p.next;
    }
    try std.testing.expectEqual(@as(usize, relay.swap_pushes), i);
    sins[0].unlocking_script = Script.init(script.items);
    try signP2pkh(a, &s, 1, taker_lock, exact, taker_priv);
    const pool_text = try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(w.beef.txidOf(pd_raw))});
    var validator: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&validator, vec.identity);
    return .{ .funding = f_raw, .swap = try s.serialize(a), .pool = pool_text, .validator = validator };
}

fn expectRefusal(c: relay.Checked, reason: []const u8) !void {
    switch (c) {
        .ok => {
            std.debug.print("expected {s}, got ok\n", .{reason});
            return error.TestExpectedRefusal;
        },
        .refused => |r| {
            if (!eql(u8, r.reason, reason)) std.debug.print("expected {s}, got {s} ({s})\n", .{ reason, r.reason, r.detail orelse "" });
            try testing.expectEqualStrings(reason, r.reason);
        },
    }
}

const ours: relay.Commission = .{ .pkh = commission_pkh };
const t_now: u64 = 1_700_000_000_000;
const t_expires: u64 = t_now + 60_000;

test "relay: a pair from the fixtures (the funding transaction pays the swap's input exactly; the swap spends it, its commission paying us) is checked; each refusal" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try buildPair(a);

    const ok = try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_expires, t_now, ours);
    try testing.expect(ok == .ok);
    try testing.expectEqual(@as(u64, 20_000), ok.ok.call.amount_in);
    try testing.expect(ok.ok.call.bsv_in);
    try testing.expectEqualSlices(u8, &commission_pkh, ok.ok.call.commission_pkh);
    try testing.expectEqual(@as(u64, 0), ok.ok.call.change);
    try testing.expectEqual(@as(i64, vec.lp_fee_bps), ok.ok.continuation.lp_fee_bps);
    try testing.expectEqual(@as(i64, vec.commission_bps), ok.ok.continuation.commission_bps);
    // Without a commission pkh configured, any commission payee passes.
    try testing.expect(try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_expires, t_now, .{}) == .ok);
    const other = try buildPairWith(a, .{ .commission = .{0x22} ** 20 });
    try testing.expect(try relay.checkPair(a, other.funding, other.swap, other.pool, &other.validator, t_expires, t_now, .{}) == .ok);

    // Our commission: another's.
    try expectRefusal(try relay.checkPair(a, other.funding, other.swap, other.pool, &other.validator, t_expires, t_now, ours), "commission_missing");
    // A pool charging no commission has no commission output: our check passes.
    {
        var s = try Transaction.parse(a, other.swap);
        const lock = color.brc162.decode(s.outputs[0].locking_script.bytes).?.lock;
        // CommissionBps (template offset 723) sits at 724 in the lock (the pool test of the slot, test.zig), as OP_10.
        const at = s.outputs[0].locking_script.bytes.len - lock.len + 724;
        try testing.expectEqual(@as(u8, 0x5a), s.outputs[0].locking_script.bytes[at]);
        const outs = try a.dupe(bsvz.transaction.Output, s.outputs[0..4]);
        const zero = try a.dupe(u8, s.outputs[0].locking_script.bytes);
        zero[at] = 0x00;
        outs[0].locking_script = Script.init(zero);
        s.outputs = outs;
        const c = try relay.checkPair(a, other.funding, try s.serialize(a), other.pool, &other.validator, t_expires, t_now, ours);
        try testing.expect(c == .ok);
        try testing.expectEqual(@as(i64, 0), c.ok.continuation.commission_bps);
    }

    // The pair itself.
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_now, t_now, ours), "expired");
    try expectRefusal(try relay.checkPair(a, "junk", p.swap, p.pool, &p.validator, t_expires, t_now, ours), "bad_funding");
    try expectRefusal(try relay.checkPair(a, p.funding, "junk", p.pool, &p.validator, t_expires, t_now, ours), "bad_swap");
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, "nope", &p.validator, t_expires, t_now, ours), "bad_pool");
    const wrong_pool = try std.fmt.allocPrint(a, "{s}_1", .{p.pool[0..64]});
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, wrong_pool, &p.validator, t_expires, t_now, ours), "pool_not_input_0");
    try expectRefusal(try relay.checkPair(a, unhex(a, vec.fund), p.swap, p.pool, &p.validator, t_expires, t_now, ours), "funding_not_spent");
    var other_key = p.validator;
    other_key[5] ^= 1;
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, p.pool, &other_key, t_expires, t_now, ours), "wrong_validator");
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, p.pool, p.validator[0..32], t_expires, t_now, ours), "bad_validator");

    // Unsigned: the funding transaction's input, the swap's funding input.
    {
        const u = try buildPairWith(a, .{ .sign_funding = false });
        try expectRefusal(try relay.checkPair(a, u.funding, u.swap, u.pool, &u.validator, t_expires, t_now, ours), "funding_unsigned");
        var s = try Transaction.parse(a, p.swap);
        const ins = try a.dupe(bsvz.transaction.Input, s.inputs);
        ins[1].unlocking_script = Script.empty();
        s.inputs = ins;
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "swap_unsigned");
    }
    // The fixture's own swap: signed by the validator already, and spending fund:1, not a funding output.
    try expectRefusal(try relay.checkPair(a, unhex(a, vec.fund), unhex(a, vec.swap_bsv_in), p.pool, &p.validator, t_expires, t_now, .{}), "signature_slot_not_empty");
    // An output past the contract's (a change output the call does not name).
    {
        var s = try Transaction.parse(a, p.swap);
        s.outputs = try std.mem.concat(a, bsvz.transaction.Output, &.{ s.outputs, &.{s.outputs[4]} });
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        // The commission output dropped while the pool charges one.
        s.outputs = s.outputs[0..4];
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        // The commission one sat short; paying another than the call names.
        const short = try a.dupe(bsvz.transaction.Output, (try Transaction.parse(a, p.swap)).outputs);
        short[4].satoshis -= 1;
        s.outputs = short;
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        const elsewhere = try a.dupe(bsvz.transaction.Output, (try Transaction.parse(a, p.swap)).outputs);
        elsewhere[4].locking_script = Script.init(try p2pkhScript(a, &(.{0x22} ** 20)));
        s.outputs = elsewhere;
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
    }
    // The token change (0.40.0): named in the call (push 8, OP_5) with no output for it; then
    // with its output (after the commission) it passes; a tokenChangePkh not 20 bytes (push 7).
    {
        const S = struct {
            fn withPush(al: Allocator, swap: []const u8, idx: usize, raw: []const u8) ![]const u8 {
                var t = try Transaction.parse(al, swap);
                const u = t.inputs[0].unlocking_script.bytes;
                var out: std.ArrayList(u8) = .empty;
                var pos: usize = 0;
                var i: usize = 0;
                while (pos < u.len) : (i += 1) {
                    const q = color.brc162.readPush(u, pos).?;
                    try out.appendSlice(al, if (i == idx) raw else u[pos..q.next]);
                    pos = q.next;
                }
                const ins = try al.dupe(bsvz.transaction.Input, t.inputs);
                ins[0].unlocking_script = Script.init(out.items);
                t.inputs = ins;
                return t.serialize(al);
            }
        };
        const named = try S.withPush(a, p.swap, 8, &.{0x55});
        try expectRefusal(try relay.checkPair(a, p.funding, named, p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        var s = try Transaction.parse(a, named);
        const pd = try Transaction.parse(a, unhex(a, vec.pool_deploy));
        const asset = color.brc162.decode(pd.outputs[0].locking_script.bytes).?.id.?.txid;
        const ch = (try relay.parseSwapCall(a, s.inputs[0].unlocking_script.bytes)).?;
        s.outputs = try std.mem.concat(a, bsvz.transaction.Output, &.{ s.outputs, &.{.{ .satoshis = 1, .locking_script = Script.init(try pool_lib.payoutScript(a, asset, 5, ch.token_change_pkh[0..20].*, false)) }} });
        const with = try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours);
        try testing.expect(with == .ok);
        try testing.expectEqual(@as(u64, 5), with.ok.call.token_change);
        try expectRefusal(try relay.checkPair(a, p.funding, try S.withPush(a, p.swap, 7, &([_]u8{19} ++ [_]u8{0x55} ** 19)), p.pool, &p.validator, t_expires, t_now, ours), "bad_call");
    }
    // Not a swap: the Rescind fixture's pool input (0.13.0: the validator's, funded by fund:6).
    try expectRefusal(try relay.checkPair(a, unhex(a, vec.fund), unhex(a, vec.rescind), try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(w.beef.txidOf(unhex(a, vec.swap_tokens_in)))}), &p.validator, t_expires, t_now, .{}), "not_a_swap");
}

fn keySigner(a: Allocator, priv: [32]u8) !relay.Signer {
    const k = try a.create([32]u8);
    k.* = priv;
    return .{ .ctx = k, .identityFn = struct {
        fn f(ctx: *anyopaque, _: Allocator) anyerror![33]u8 {
            const p: *[32]u8 = @ptrCast(@alignCast(ctx));
            const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(p.*));
            return (try kd.identityKey()).toCompressedSec1();
        }
    }.f, .signFn = struct {
        fn f(ctx: *anyopaque, al: Allocator, hash: [32]u8) anyerror![]const u8 {
            const p: *[32]u8 = @ptrCast(@alignCast(ctx));
            const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(p.*));
            const child = try kd.derivePrivateKey(al, .{ .security_level = 2, .name = relay.envelope_protocol }, relay.envelope_key_id, .{ .type_ = .anyone });
            const sig = try child.signDigest(hash);
            return al.dupe(u8, sig.asSlice());
        }
    }.f };
}

test "relay: the one BEEF (the funding transaction's ancestry, the funding transaction, the swap) and the signed package the validator opens" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try buildPair(a);
    const pair = (try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_expires, t_now, ours)).ok;

    // A raw funding transaction: [funding, swap].
    const b1 = try w.beef.parse(a, try relay.requestBeef(a, pair));
    try testing.expectEqual(@as(usize, 2), b1.entries.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.funding), &b1.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &b1.subject().?);

    // The funding as a BEEF (createAction's): its parent fund comes along, an unrelated entry does not.
    const fund_raw = unhex(a, vec.fund);
    const fbeef = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = w.beef.txidOf(unhex(a, vec.token_deploy)), .format = .raw, .raw = unhex(a, vec.token_deploy) },
        .{ .txid = w.beef.txidOf(fund_raw), .format = .raw, .raw = fund_raw },
        .{ .txid = w.beef.txidOf(p.funding), .format = .raw, .raw = p.funding },
    }) });
    const pair2 = (try relay.checkPair(a, fbeef, p.swap, p.pool, &p.validator, t_expires, t_now, ours)).ok;
    const b2 = try w.beef.parse(a, try relay.requestBeef(a, pair2));
    try testing.expectEqual(@as(usize, 3), b2.entries.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(fund_raw), &b2.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.funding), &b2.entries[1].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &b2.subject().?);

    // The funding's BEEF out of order (an Atomic BEEF, its parent fund after it): sorted, the same
    // one BEEF (skein-sdk 0.11.1, David 2026-10-22).
    const fback = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = w.beef.txidOf(p.funding), .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = w.beef.txidOf(unhex(a, vec.token_deploy)), .format = .raw, .raw = unhex(a, vec.token_deploy) },
        .{ .txid = w.beef.txidOf(p.funding), .format = .raw, .raw = p.funding },
        .{ .txid = w.beef.txidOf(fund_raw), .format = .raw, .raw = fund_raw },
    }) });
    const pair3 = (try relay.checkPair(a, fback, p.swap, p.pool, &p.validator, t_expires, t_now, ours)).ok;
    const b3 = try w.beef.parse(a, try relay.requestBeef(a, pair3));
    try testing.expectEqual(@as(usize, 3), b3.entries.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(fund_raw), &b3.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.funding), &b3.entries[1].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &b3.subject().?);
    try testing.expect(w.beef.parentsFirst(b3));

    // The package: a mail record signed by this instance (BRC-169), recipient the validator, box `swap`.
    const rec: relay.Record = .{ .id = relay.idOf(p.swap), .funding = fbeef, .swap = p.swap, .pool = p.pool, .validator = p.validator, .expires = t_expires, .created = t_now, .updated = t_now };
    const signer = try keySigner(a, relay_priv);
    const topic = try names.overlayOf(a, "ab" ** 32 ++ "_0");
    try testing.expectEqualStrings("tm_color_" ++ "ab" ** 32 ++ "_0", topic);
    try testing.expect(names.parse(topic).?.kind == .overlay);
    const frame = try relay.packageFor(a, signer, rec, topic);
    const pkg = try scbor.decode(a, frame);
    // 0.31.0: the frame names the token's topic at its top level, what the dialled host's stream
    // routing reads off the first frame (skein p2p.ts streamHandle: dag-cbor {topic, …}).
    try testing.expectEqualStrings(topic, scbor.Value.str(pkg.get("topic")).?);
    // No topic given (the in-VM affirm; an instance before its deploy): none in the frame.
    try testing.expect((try scbor.decode(a, try relay.packageFor(a, signer, rec, null))).get("topic") == null);
    const m = pkg.get("message").?;
    const body = scbor.Value.bytesOf(pkg.get("body")).?;
    try testing.expect((try message.problem(a, m, body)) == null);
    try testing.expectEqualSlices(u8, &p.validator, scbor.Value.bytesOf(m.get("recipient")).?);
    try testing.expectEqualStrings("swap", scbor.Value.str(m.get("box")).?);
    try testing.expectEqualSlices(u8, &(try signer.identityFn(signer.ctx, a)), scbor.Value.bytesOf(m.get("sender")).?);
    const req = try cbor.decode(a, body);
    try testing.expectEqualStrings(p.pool, req.getText("pool").?);
    const sent = try w.beef.parse(a, req.getBytes("tx").?);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &sent.subject().?);
    // Another swap, another nonce (the record is unique to the swap).
    try testing.expect(!eql(u8, &relay.nonceOf(rec.id), &relay.nonceOf(relay.idOf(p.funding))));
}

fn frameOf(a: Allocator, v: Value) ![]const u8 {
    return cbor.encode(a, v);
}

test "relay: the record's lifecycle over the libp2p provider's answers — accepted, refused (with the pool's state), timeout, failed — kept in the app's state" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const p = try buildPair(a);
    const fresh: relay.Record = .{ .id = relay.idOf(p.swap), .funding = p.funding, .swap = p.swap, .pool = p.pool, .validator = p.validator, .expires = t_expires, .created = t_now, .updated = t_now, .peer = "16Uiu2HAmL3ee25zUdPHFTUVToTuzBgBjt8yoxAd952pYyvfbmDT9" };

    // pending → dial → opened (send the package) → the frame {ok: true} → accepted, the stream closed.
    {
        var r = fresh;
        const start = try relay.advance(a, &r, .start, t_now, null);
        try testing.expect(start.rest and !start.done);
        try testing.expectEqual(@as(?usize, 0), start.dial);
        try testing.expectEqualStrings("dial", start.emits[0].box);
        try testing.expectEqualStrings(relay.swap_protocol, start.emits[0].body.getText("protocol").?);
        try testing.expectEqualStrings(fresh.peer.?, start.emits[0].body.getText("peer").?);
        const opened = try relay.advance(a, &r, .{ .answer = .{ .opened = 7 } }, t_now + 10, "the package");
        try testing.expect(opened.rest and !opened.done);
        try testing.expectEqualStrings("send", opened.emits[0].box);
        try testing.expectEqualStrings("the package", opened.emits[0].body.getBytes("body").?);
        try testing.expectEqual(@as(?u64, 7), r.stream);
        const signed = "the signed swap";
        const done = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = &.{
            .{ .key = "ok", .value = .{ .boolean = true } },
            .{ .key = "tx", .value = .{ .bytes = signed } },
            .{ .key = "txid", .value = .{ .text = "ab" ** 32 } },
        } }) } }, t_now + 20, null);
        try testing.expect(done.done);
        try testing.expectEqualStrings("close", done.emits[0].box);
        try testing.expectEqual(relay.Status.accepted, r.status);
        try testing.expectEqualStrings(signed, r.tx.?);
        try testing.expectEqual(t_now + 20, r.updated);
        // Settled: nothing more happens to it.
        try testing.expect((try relay.advance(a, &r, .woke, t_expires + 1, null)).done);
        try testing.expectEqual(relay.Status.accepted, r.status);

        // Kept under the app's state, read back as stored; the answer leaves out the relay's own fields.
        var book = try relay.Book.load(a, ms.store(), null);
        r.dial = &w.store.hashCid(.tx, .{1} ** 32);
        r.thread = &w.store.hashCid(.tx, .{2} ** 32);
        r.request = .{ .message = &w.store.hashCid(.tx, .{3} ** 32), .sender = &p.validator };
        try book.put(a, r);
        const st = readBack(a, try book.state(a));
        try testing.expectEqualStrings(relay.state_kind, st.getText("kind").?);
        var again = try relay.Book.load(a, ms.store(), st);
        const back = (try again.get(a, r.id)).?;
        try testing.expectEqual(relay.Status.accepted, back.status);
        try testing.expectEqualSlices(u8, p.funding, back.funding);
        try testing.expectEqual(@as(?u64, 7), back.stream);
        try testing.expectEqualSlices(u8, r.thread.?, back.thread.?);
        try testing.expectEqualSlices(u8, &p.validator, back.request.?.sender);
        const ans = readBack(a, try back.answer(a));
        try testing.expectEqualStrings("accepted", ans.getText("status").?);
        try testing.expectEqualStrings(&relay.idText(r.id), ans.getText("id").?);
        try testing.expectEqualStrings(signed, ans.getBytes("tx").?);
        try testing.expect(ans.get("thread") == null and ans.get("dial") == null and ans.get("request") == null and ans.get("peer") == null);
        try testing.expect((try again.get(a, relay.idOf(p.funding))) == null);
    }

    // The validator refuses: refused, with its reason and the pool's newest state.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 8 } }, t_now, "pkg");
        const fx = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = &.{
            .{ .key = "ok", .value = .{ .boolean = false } },
            .{ .key = "reason", .value = .{ .text = "pool_spent" } },
            .{ .key = "pool", .value = .{ .map = &.{
                .{ .key = "outpoint", .value = .{ .text = "cd" ** 32 ++ "_0" } },
                .{ .key = "bsvReserve", .value = .{ .uint = 1_019_930 } },
            } } },
        } }) } }, t_now + 5, null);
        try testing.expect(fx.done);
        try testing.expectEqual(relay.Status.refused, r.status);
        try testing.expectEqualStrings("pool_spent", r.reason.?);
        const ans = readBack(a, try r.answer(a));
        try testing.expectEqual(@as(u64, 1_019_930), ans.get("poolState").?.getUint("bsvReserve").?);
    }

    // No answer by `expires`: woken early it rests again; at `expires`, timeout, the stream closed.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 9 } }, t_now, "pkg");
        const early = try relay.advance(a, &r, .woke, t_expires - 1, null);
        try testing.expect(early.rest and !early.done);
        try testing.expectEqual(relay.Status.pending, r.status);
        const late = try relay.advance(a, &r, .woke, t_expires, null);
        try testing.expect(late.done);
        try testing.expectEqual(relay.Status.timeout, r.status);
        try testing.expectEqualStrings("close", late.emits[0].box);
        try testing.expect(relay.Status.timeout.retryable());
        // Launched after it expired: no dial at all.
        var r2 = fresh;
        const fx = try relay.advance(a, &r2, .start, t_expires, null);
        try testing.expect(fx.done and fx.emits.len == 0);
        try testing.expectEqual(relay.Status.timeout, r2.status);
    }

    // The dial fails, or the stream ends without a frame: failed (retryable). A garbled frame: failed.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        try testing.expect((try relay.advance(a, &r, .{ .answer = .{ .closed = "dial failed: no route" } }, t_now, null)).done);
        try testing.expectEqual(relay.Status.failed, r.status);
        try testing.expectEqualStrings("unreachable", r.reason.?);
        var r2 = fresh;
        _ = try relay.advance(a, &r2, .start, t_now, null);
        _ = try relay.advance(a, &r2, .{ .answer = .{ .opened = 1 } }, t_now, "pkg");
        _ = try relay.advance(a, &r2, .{ .answer = .{ .frame = "\xff" } }, t_now, null);
        try testing.expectEqual(relay.Status.failed, r2.status);
        try testing.expectEqualStrings("bad_reply", r2.reason.?);
    }
}

test "relay: the validator named (0.4.0) — submit dials the peer given; this node's own peer is handed to its own validator program in-VM: wait, called again, answered; failed; timeout" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var book = try relay.Book.load(a, ms.store(), null);
    test_env = .{ .book = &book };
    const p = try buildPair(a);
    var dummy: u8 = 0;
    const args = try fromSdk(a, try submitArgs(a, p, null));

    // Another node's peer named: recorded as given, not local; the relay dials it.
    test_env.self_peer = "16Uiu2HAmL3ee25zUdPHFTUVToTuzBgBjt8yoxAd952pYyvfbmDT9";
    const env: relay.Env = .{ .book = &book, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = test_env.self_peer, .launchFn = testLaunch };
    var r = (try relay.submit(a, env, args)).launched;
    try testing.expectEqualStrings(named_peer, r.peer.?);
    try testing.expect(!r.local);
    const start = try relay.advance(a, &r, .start, t_now, null);
    try testing.expectEqualStrings("dial", start.emits[0].box);
    try testing.expectEqualStrings(named_peer, start.emits[0].body.getText("peer").?);
    try testing.expectEqualStrings(relay.swap_protocol, start.emits[0].body.getText("protocol").?);
    // Unknown self (no handle): never local.
    try testing.expect(!relay.isSelf(.{ .book = &book, .now = t_now, .commission = ours, .ctx = &dummy, .launchFn = testLaunch }, named_peer));

    // This node's own peer named: local, kept so in the stored record (not in the answer).
    var book2 = try relay.Book.load(a, ms.store(), null);
    const self_env: relay.Env = .{ .book = &book2, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = named_peer, .launchFn = testLaunch };
    const fresh = (try relay.submit(a, self_env, args)).launched;
    try testing.expect(fresh.local);
    try testing.expectEqualStrings(named_peer, fresh.peer.?);
    const back = (try book2.get(a, fresh.id)).?;
    try testing.expect(back.local);
    try testing.expect((readBack(a, try back.answer(a))).get("local") == null);

    // Launched: call the validator (no dial, nothing emitted). It awaited its submission: rest.
    {
        var l = fresh;
        const fx = relay.advanceLocal(&l, .start, t_now);
        try testing.expect(fx.call and !fx.done and fx.emits.len == 0 and fx.dial == null);
        const waiting = relay.localAnswer(a, &l, readBack(a, .{ .map = &.{.{ .key = "wait", .value = .{ .boolean = true } }} }), "");
        try testing.expect(waiting.rest and !waiting.done);
        try testing.expectEqual(relay.Status.pending, l.status);
        // Stepped by the engine's answer: called again; the handler answers the reply frame.
        const again = relay.advanceLocal(&l, .again, t_now + 10);
        try testing.expect(again.call);
        const signed = "the signed swap";
        const done = relay.localAnswer(a, &l, readBack(a, .{ .map = &.{
            .{ .key = "verdict", .value = .{ .text = "accept" } },
            .{ .key = "body", .value = .{ .bytes = try frameOf(a, .{ .map = &.{
                .{ .key = "ok", .value = .{ .boolean = true } },
                .{ .key = "tx", .value = .{ .bytes = signed } },
                .{ .key = "txid", .value = .{ .text = "ab" ** 32 } },
            } }) } },
        } }), "");
        try testing.expect(done.done and done.emits.len == 0);
        try testing.expectEqual(relay.Status.accepted, l.status);
        try testing.expectEqualStrings(signed, l.tx.?);
        // Settled: nothing more.
        try testing.expect(relay.advanceLocal(&l, .again, t_now + 20).done);
    }
    // A refusal at once: refused with the reason.
    {
        var l = fresh;
        _ = relay.advanceLocal(&l, .start, t_now);
        const fx = relay.localAnswer(a, &l, readBack(a, .{ .map = &.{
            .{ .key = "verdict", .value = .{ .text = "accept" } },
            .{ .key = "body", .value = .{ .bytes = try frameOf(a, .{ .map = &.{
                .{ .key = "ok", .value = .{ .boolean = false } },
                .{ .key = "reason", .value = .{ .text = "not_validating" } },
            } }) } },
        } }), "");
        try testing.expect(fx.done);
        try testing.expectEqual(relay.Status.refused, l.status);
        try testing.expectEqualStrings("not_validating", l.reason.?);
    }
    // The call fails (no validator program, the handler errors): failed, retryable; no body: failed.
    {
        var l = fresh;
        _ = relay.advanceLocal(&l, .start, t_now);
        try testing.expect(relay.localAnswer(a, &l, null, "NoValidatorProgram").done);
        try testing.expectEqual(relay.Status.failed, l.status);
        try testing.expectEqualStrings("validator_failed", l.reason.?);
        try testing.expectEqualStrings("NoValidatorProgram", l.detail.?);
        try testing.expect(l.status.retryable());
        var l2 = fresh;
        _ = relay.localAnswer(a, &l2, readBack(a, .{ .map = &.{.{ .key = "verdict", .value = .{ .text = "accept" } }} }), "");
        try testing.expectEqualStrings("bad_reply", l2.reason.?);
    }
    // Woken before `expires`: rest; at `expires`: timeout. Launched after it: timeout, no call.
    {
        var l = fresh;
        _ = relay.advanceLocal(&l, .start, t_now);
        try testing.expect(relay.advanceLocal(&l, .woke, t_expires - 1).rest);
        const late = relay.advanceLocal(&l, .woke, t_expires);
        try testing.expect(late.done and !late.call);
        try testing.expectEqual(relay.Status.timeout, l.status);
        var l2 = fresh;
        const fx = relay.advanceLocal(&l2, .start, t_expires);
        try testing.expect(fx.done and !fx.call);
        try testing.expectEqual(relay.Status.timeout, l2.status);
    }
}

// --- the dispatch, by the app's manifest (app/etc/app.json), with the functions over memory ---

const TestEnv = struct {
    book: *relay.Book,
    /// This node's own peer ID, as main.zig's `selfPeerText` gives it (null: unknown).
    self_peer: ?[]const u8 = null,
    launched: usize = 0,
    commission: relay.Commission = ours,
    market: relay.market.Market = .{},
    seen_writes: ?bool = null,
    launched_kind: ?relay.Kind = null,
};
var test_env: TestEnv = undefined;

/// The validator's peer ID as the page names it (taken from the runtime's liveness read).
const named_peer = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";

/// `args` with `peerId` set to `peer`, or removed (null).
fn withPeer(a: Allocator, args: scbor.Value, peer: ?[]const u8) !scbor.Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    for ((try fromSdk(a, args)).map) |e| if (!eql(u8, e.key, "peerId")) try es.append(a, e);
    if (peer) |x| try es.append(a, .{ .key = "peerId", .value = .{ .text = x } });
    return toSdk(a, .{ .map = es.items });
}
fn testLaunch(_: *anyopaque, _: Allocator, kind: relay.Kind, _: [32]u8) anyerror![]const u8 {
    test_env.launched += 1;
    test_env.launched_kind = kind;
    return &w.store.hashCid(.tx, .{9} ** 32);
}
fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}
fn toSdk(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}
fn testSubmit(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    var dummy: u8 = 0;
    const env: relay.Env = .{ .book = test_env.book, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = test_env.self_peer, .launchFn = testLaunch };
    return switch (try relay.submit(c.a, env, try fromSdk(c.a, c.args))) {
        .refused => |r| sk.report(try relay.refusalText(c.a, r)),
        .launched, .pending, .settled => |r| toSdk(c.a, try r.answer(c.a)),
    };
}
fn testStatus(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    return switch (try relay.status(c.a, test_env.book, try fromSdk(c.a, c.args))) {
        .found => |r| toSdk(c.a, try r.answer(c.a)),
        .not_found => sk.report("not_found"),
        .bad_id => sk.report("bad_id"),
    };
}
fn testTerms(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    return toSdk(c.a, try relay.terms(c.a, test_env.commission, test_env.market));
}
const test_fns = [_]app.Function{
    .{ .name = relay.fn_submit, .run = testSubmit },
    .{ .name = relay.fn_status, .run = testStatus },
    .{ .name = relay.fn_terms, .run = testTerms },
};

fn submitArgs(a: Allocator, p: Pair, extra: ?cbor.Entry) !scbor.Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "funding", .value = .{ .bytes = p.funding } },
        .{ .key = "swap", .value = .{ .bytes = p.swap } },
        .{ .key = "pool", .value = .{ .text = p.pool } },
        .{ .key = "validator", .value = .{ .bytes = &p.validator } },
        .{ .key = "peerId", .value = .{ .text = named_peer } },
        .{ .key = "expires", .value = .{ .uint = t_expires } },
    });
    if (extra) |e| try es.append(a, e);
    return toSdk(a, .{ .map = es.items });
}

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

test "relay: dispatch by the manifest (app/etc/app.json, amm.swap/1) — submit records and launches, the same swap again answers its record, status reads it; shapes and writes as declared" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var book = try relay.Book.load(a, ms.store(), null);
    test_env = .{ .book = &book };
    const m = try dagjson.decode(a, manifest_json);
    const in: scbor.Value = .{ .map = &.{} };
    const p = try buildPair(a);

    // The declarations.
    try testing.expect((try app.declOf(a, m, relay.fn_submit)).?.get("writes").?.bool);
    try testing.expect(!(try app.declOf(a, m, relay.fn_status)).?.get("writes").?.bool);

    // submit: recorded pending, the relay launched once; the answer is the record.
    const r1 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, null), null);
    try testing.expect(r1 == .ok);
    try testing.expectEqual(@as(?bool, true), test_env.seen_writes);
    const rec = try fromSdk(a, r1.ok);
    try testing.expectEqualStrings("pending", rec.getText("status").?);
    try testing.expectEqualStrings(&relay.idText(relay.idOf(p.swap)), rec.getText("id").?);
    try testing.expectEqual(@as(usize, 1), test_env.launched);
    // The same swap again: its record, no second relay.
    const r2 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, null), null);
    try testing.expect(r2 == .ok);
    try testing.expectEqual(@as(usize, 1), test_env.launched);

    // status: the record; an unknown id, not_found; read-only as declared.
    var sargs = scbor.MapBuilder.init(a);
    try sargs.put("id", scbor.string(rec.getText("id").?));
    const s1 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_status, sargs.value(), null);
    try testing.expect(s1 == .ok);
    try testing.expectEqual(@as(?bool, false), test_env.seen_writes);
    try testing.expectEqualStrings("pending", (try fromSdk(a, s1.ok)).getText("status").?);
    var unknown = scbor.MapBuilder.init(a);
    try unknown.put("id", scbor.string("00" ** 32));
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_status, unknown.value(), null), .failed, "not_found");

    // The declared shapes: a missing arg, an extra one, a wrong type.
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_status, .{ .map = &.{} }, null), .@"bad-args", "args.id: missing");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, .{ .key = "fee", .value = .{ .uint = 1 } }), null), .@"bad-args", "args.fee: not in the shape");
    const bad = try a.dupe(cbor.Entry, (try fromSdk(a, try submitArgs(a, p, null))).map);
    for (bad) |*e| if (eql(u8, e.key, "pool")) {
        e.value = .{ .uint = 0 };
    };
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try toSdk(a, .{ .map = bad }), null), .@"bad-args", "args.pool: want string");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, "amm.swap.cancel", .{ .map = &.{} }, null), .@"unknown-fn", "amm.swap.cancel");

    // A refusal is the function's error, and nothing is recorded or launched.
    const none = try buildPairWith(a, .{ .commission = .{0x22} ** 20 });
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, none, null), null), .failed, "commission_missing");
    // 0.4.0: the caller names the validator's peer; no liveness is looked at. No peerId: the
    // declared shape refuses it; one that is no peer ID text: bad_peer. Nothing recorded or launched.
    const other = try buildPairWith(a, .{ .fee = 600 });
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try withPeer(a, try submitArgs(a, other, null), null), null), .@"bad-args", "args.peerId: missing");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try withPeer(a, try submitArgs(a, other, null), ""), null), .failed, "bad_peer");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try withPeer(a, try submitArgs(a, other, null), "/ip4/1.2.3.4/tcp/1"), null), .failed, "bad_peer");
    try testing.expectEqual(@as(usize, 1), test_env.launched);
    try testing.expect((try book.get(a, relay.idOf(other.swap))) == null);
    // The record dials the peer named, not this node's own.
    const named = (try book.get(a, relay.idOf(p.swap))).?;
    try testing.expectEqualStrings(named_peer, named.peer.?);
    try testing.expect(!named.local);

    // terms: the relay's commission pkh, read-only as declared; none configured, null; no args taken.
    try testing.expect(!(try app.declOf(a, m, relay.fn_terms)).?.get("writes").?.bool);
    const t1 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, .{ .map = &.{} }, null);
    try testing.expect(t1 == .ok);
    try testing.expectEqual(@as(?bool, false), test_env.seen_writes);
    try testing.expectEqualSlices(u8, &commission_pkh, (try fromSdk(a, t1.ok)).getBytes("commissionPkh").?);
    test_env.commission = .{};
    const t2 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, null, null);
    try testing.expect(t2 == .ok);
    try testing.expect((try fromSdk(a, t2.ok)).get("commissionPkh").? == .null);
    test_env.commission = ours;
    // 0.16.0: the market's minimum beside it, 0 when none is set; the record's when set.
    try testing.expectEqual(@as(u64, 0), (try fromSdk(a, t1.ok)).getUint("minCommissionBps").?);
    test_env.market = .{ .min_commission_bps = 1 };
    const t3 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, null, null);
    try testing.expectEqual(@as(u64, 1), (try fromSdk(a, t3.ok)).getUint("minCommissionBps").?);
    test_env.market = .{};
    var targs = scbor.MapBuilder.init(a);
    try targs.put("pool", scbor.string(p.pool));
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, targs.value(), null), .@"bad-args", "args.pool: not in the shape");

    // A swap that timed out is relayed again.
    var r = (try book.get(a, relay.idOf(p.swap))).?;
    r.status = .timeout;
    try book.put(a, r);
    _ = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, null), null);
    try testing.expectEqual(@as(usize, 2), test_env.launched);
    try testing.expectEqual(relay.Status.pending, (try book.get(a, relay.idOf(p.swap))).?.status);
}

test "the relay's head is the app's root head <app>/app (skein-sdk 0.3.0 app.headOf)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(try app.headOf(arena.allocator(), relay.app_name), relay.app_head);
}

test "this program's state head is under the app's name, amm/p2p (#77: an app advances only <app>/…)" {
    try std.testing.expectEqualStrings("amm/p2p", relay.p2p_head);
    try std.testing.expect(std.mem.startsWith(u8, relay.p2p_head, relay.app_name ++ "/"));
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
    const body = (try relay.affirmBody(a, args)).?;
    try testing.expectEqualSlices(u8, script, body.getBytes("pool").?);
    try testing.expectEqual(@as(u64, vec.pool0.bsv), body.getUint("satoshis").?);
    try testing.expect(body.get("keyInput") == null);
    // Missing args: nothing to ask.
    try testing.expect((try relay.affirmBody(a, .{ .map = args.map[0..1] })) == null);
    // The package's nonce is the body's.
    try testing.expectEqualSlices(u8, &try relay.affirmNonce(a, body), &try relay.affirmNonce(a, body));
    const other = (try relay.affirmBody(a, .{ .map = try a.dupe(cbor.Entry, &.{ args.map[0], .{ .key = "satoshis", .value = .{ .uint = 1 } } }) })).?;
    try testing.expect(!std.mem.eql(u8, &try relay.affirmNonce(a, body), &try relay.affirmNonce(a, other)));

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
    const got = relay.affirmAnswer(a, ans);
    try testing.expectEqualSlices(u8, sig, got.ok.getBytes("signature").?);
    try testing.expectEqualSlices(u8, key, got.ok.getBytes("validatorPubKey").?);
    try testing.expectEqualSlices(u8, nonce, got.ok.getBytes("nonce").?);
    try testing.expectEqual(@as(usize, 3), got.ok.map.len);
    // Affirmed without the key or the nonce: a bad reply.
    const short = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{ .{ .key = "ok", .value = .{ .boolean = true } }, .{ .key = "signature", .value = .{ .bytes = sig } } }) });
    try testing.expectEqualStrings("bad_reply", relay.affirmAnswer(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "body", .value = .{ .bytes = short } }}) }).refused.reason);
    // A refusal: its reason and detail, as the function's error text.
    const nframe = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{ .{ .key = "ok", .value = .{ .boolean = false } }, .{ .key = "reason", .value = .{ .text = "fees_unacceptable" } }, .{ .key = "detail", .value = .{ .text = "lpFeeBps: the terms are 30" } } }) });
    const no = relay.affirmAnswer(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "body", .value = .{ .bytes = nframe } }}) });
    try testing.expectEqualStrings("fees_unacceptable: lpFeeBps: the terms are 30", try relay.refusalText(a, no.refused));
    try testing.expectEqualStrings("bad_reply", relay.affirmAnswer(a, .{ .map = &.{} }).refused.reason);

    // The manifest: amm.pool.affirm, no writes, its args; amm.pool.submit and status gone.
    const m = try dagjson.decode(a, manifest_json);
    const decl = (try app.declOf(a, m, relay.fn_pool_affirm)).?;
    try testing.expect(!decl.get("writes").?.bool);
    const dargs = decl.get("args").?;
    for ([_][]const u8{ "pool", "satoshis" }) |k| try testing.expect(dargs.get(k) != null);
    try testing.expect(dargs.get("keyInput") == null);
    for ([_][]const u8{ "validatorPubKey", "nonce", "signature" }) |k| try testing.expect(decl.get("answer").?.get(k) != null);
    try testing.expect((try app.declOf(a, m, "amm.pool.submit")) == null);
    try testing.expect((try app.declOf(a, m, "amm.pool.status")) == null);
    try testing.expect((try app.declOf(a, m, relay.fn_pool_terms)) != null);
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
    const ans = (try relay.poolTerms(a, &id, PEER_ID_OF_G, terms.fromRecord(rec))).?;
    try testing.expectEqualSlices(u8, &id, ans.getBytes("validator").?);
    try testing.expectEqualStrings(PEER_ID_OF_G, ans.getText("peerId").?);
    try testing.expectEqual(@as(u64, 30), ans.getUint("lpFeeBps").?);
    try testing.expectEqual(@as(u64, 5), ans.getUint("validatorFeeBps").?);
    try testing.expectEqual(@as(u64, 25), ans.getUint("commissionBps").?);
    // No peer known: no peerId.
    try testing.expect((try relay.poolTerms(a, &id, null, terms.fromRecord(rec))).?.get("peerId") == null);
    // Unset (no head) or cleared (the record null): no answer; main.zig reports "no validator here".
    try testing.expect((try relay.poolTerms(a, &id, PEER_ID_OF_G, null)) == null);
    try testing.expect((try relay.poolTerms(a, &id, PEER_ID_OF_G, terms.fromRecord(.null))) == null);
    try testing.expectEqualStrings("no validator here", terms.no_validator);
    // The manifest ships no terms: config.amm has no ammValidator; amm.pool.terms is still declared.
    const m = try dagjson.decode(a, manifest_json);
    try testing.expect(m.get("config").?.get("amm") == null); // 0.16.0: no config.amm at all (commission gone too)
    try testing.expect((try app.declOf(a, m, relay.fn_pool_terms)) != null);
}

test "market terms (0.16.0, David 2026-10-24): a runtime record root sets — fn market gated by roles.root in the box amm/amm-p2p, the head amm/market; set, clear, refused shapes; unset 0; no config.amm.commission" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const market = relay.market;

    // The manifest: `market` is root's; the box amm-p2p routes to this program; no commission config.
    const m = try dagjson.decode(a, manifest_json);
    const gated = for (m.get("roles").?.get("root").?.array) |g| {
        if (eql(u8, scbor.Value.str(g).?, market.fn_market)) break true;
    } else false;
    try testing.expect(gated);
    try testing.expect(m.get("config").?.get("amm") == null);
    try testing.expectEqualStrings("amm/amm-p2p", names.own_box);
    try testing.expectEqualStrings("amm/market", try market.headName(a, relay.app_name));

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

    // The relay refuses nothing by it: checkPair takes no market (a listing preference, not a rule).
    const info = @typeInfo(@TypeOf(relay.checkPair)).@"fn";
    inline for (info.params) |prm| try testing.expect(prm.type != market.Market);
}

test "the commission key (0.16.0): the instance's own, BRC-43 level 1 `amm commission` / `relay`, counterparty anyone — the signer's key for it is the one anyone derives from the identity" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const kd_mod = bsvz.primitives.key_deriver;
    const proto: kd_mod.Protocol = .{ .security_level = relay.commission_protocol.level, .name = relay.commission_protocol.name };
    try testing.expectEqual(@as(u8, 1), relay.commission_protocol.level);
    try testing.expectEqualStrings("amm commission", relay.commission_protocol.name);
    try testing.expectEqualStrings("relay", relay.commission_key_id);
    const root = try bsvz.primitives.ec.PrivateKey.fromBytes(.{0x07} ** 32);
    const identity = (try root.publicKey()).toCompressedSec1();
    // The signer's (forSelf, counterparty anyone: getPublicKey's answer to main.zig `commissionKey`).
    const signer = kd_mod.KeyDeriver.init(root);
    const mine = (try signer.derivePublicKey(a, proto, relay.commission_key_id, .{ .type_ = .anyone }, true)).toCompressedSec1();
    // Anyone's, from the identity alone.
    const anyone = kd_mod.KeyDeriver.init(null);
    const theirs = (try anyone.derivePublicKey(a, proto, relay.commission_key_id, .{ .type_ = .other, .public_key = try bsvz.primitives.ec.PublicKey.fromSec1(&identity) }, false)).toCompressedSec1();
    try testing.expectEqualSlices(u8, &mine, &theirs);
    // amm.swap.terms answers its hash160.
    const pkh = hash160(&mine);
    const t = try relay.terms(a, .{ .pkh = pkh }, .{});
    try testing.expectEqualSlices(u8, &pkh, t.getBytes("commissionPkh").?);
}

test {
    _ = relay.market;
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
        .{ "/swaps", "swaps" },
        .{ "/trades", "trades" },
        .{ "/candles", "candles" },
        .{ "/stats", "stats" },
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

test "read API (0.34.0): P4 /positions — the lookup's {lpPubKeys} answer, one record per key in query order, an unknown key closed with zeros; P5, P6 likewise; a bad key refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));

    const v = try reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "lpPubKeys", &.{ unknown_lp, vec.lp });
    const j = try jsonOf(a, try reads.valueJson(a, v));
    try testing.expectEqual(@as(usize, 2), j.array.items.len);
    const first = j.array.items[0].object;
    try testing.expectEqualStrings(unknown_lp, first.get("lpPubKey").?.string);
    try testing.expectEqualStrings("closed", first.get("status").?.string);
    try testing.expectEqual(@as(i64, 0), first.get("sats").?.integer);
    const mine = j.array.items[1].object;
    try testing.expectEqualStrings(vec.lp, mine.get("lpPubKey").?.string);
    try testing.expectEqualStrings("live", mine.get("status").?.string);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(s2)}), mine.get("outpoint").?.string);
    try testing.expectEqualStrings(vec.lp, mine.get("current").?.object.get("lpPubKey").?.string);
    try testing.expectEqual(@as(i64, 2), mine.get("swaps").?.integer);

    const vf = try jsonOf(a, try reads.valueJson(a, try reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "validatorIdentityKeys", &.{ vec.identity, unknown_lp })));
    try testing.expectEqualStrings(vec.identity, vf.array.items[0].object.get("validatorIdentityKey").?.string);
    try testing.expectEqual(@as(i64, 2), vf.array.items[0].object.get("swaps").?.integer);
    try testing.expectEqual(@as(i64, 0), vf.array.items[1].object.get("swaps").?.integer);

    const unknown_pkh = "55" ** 20;
    const cf = try jsonOf(a, try reads.valueJson(a, try reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "commissionPkhs", &.{unknown_pkh})));
    try testing.expectEqualStrings(unknown_pkh, cf.array.items[0].object.get("commissionPkh").?.string);
    try testing.expectEqual(@as(i64, 0), cf.array.items[0].object.get("swaps").?.integer);

    try testing.expectError(error.BadQuery, reads.lookupAnswer(a, &e.svc, &e.ch, e.token, "lpPubKeys", &.{"02zz"}));
}

test "read API (0.34.0): P3 /pools/beef — the LP keys' current pools (an unknown key none), every live pool with no key; one BEEF of their transactions" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try ReadEnv.init(a);
    defer e.deinit();
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));

    const mine = try reads.currentPools(a, &e.svc, &e.ch, e.token, &.{ unknown_lp, vec.lp });
    try testing.expectEqual(@as(usize, 1), mine.len);
    try testing.expectEqualSlices(u8, &s2, &reads.rowOutpoint(mine[0]).?.txid);
    try testing.expectEqualStrings(vec.lp, mine[0].getText("lpPubKey").?);
    try testing.expect(mine[0].get("validatorPeerId") == null);
    try testing.expectEqual(@as(usize, 0), (try reads.currentPools(a, &e.svc, &e.ch, e.token, &.{unknown_lp})).len);
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

test "read API (0.34.0): P7 /terms — the validator's terms with its identity and peer, and the market's; no terms, validator null" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const id = unhex(a, vec.identity);
    const pkh: [20]u8 = .{0x55} ** 20;
    const j = try jsonOf(a, try reads.termsJson(a, .{ .identity = id, .peer_id = PEER_ID_OF_G, .lp_fee_bps = 30, .validator_fee_bps = 5, .commission_bps = 25 }, pkh, 10));
    const v = j.object.get("validator").?.object;
    try testing.expectEqualStrings(vec.identity, v.get("identity").?.string);
    try testing.expectEqualStrings(PEER_ID_OF_G, v.get("peerId").?.string);
    try testing.expectEqual(@as(i64, 30), v.get("lpFeeBps").?.integer);
    try testing.expectEqual(@as(i64, 5), v.get("validatorFeeBps").?.integer);
    try testing.expectEqual(@as(i64, 25), v.get("commissionBps").?.integer);
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

test "history reads (0.36.0): H1 /trades — newest first, each row's height from the overlay's `placed` (null until the proof lands), limit and cursor, ?lp=, ?txid= (404 none); bad parameters 400" {
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
    // The window and the LP key.
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "from=7001", 0)))).object.get("trades").?.array.items.len);
    try testing.expectEqual(@as(usize, 2), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "from=7000&to=7001&lp=" ++ vec.lp, 0)))).object.get("trades").?.array.items.len);
    try testing.expectEqual(@as(usize, 0), (try jsonOf(a, httpBody(try reads.historyRead(a, &e.svc, &e.ch, &placed, e.token, .trades, "lp=" ++ unknown_lp, 0)))).object.get("trades").?.array.items.len);
    for ([_][]const u8{ "limit=501", "limit=0", "limit=x", "from=-1", "before=zz", "lp=02ab" }) |bad|
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
    try testing.expect(st.get("price").?.object.get("sats").?.integer > 0);
    try testing.expect(st.get("change1h").? == .null);
    try testing.expect(st.get("change24h").? == .null);
    try testing.expectEqual(@as(i64, 1), st.get("buys24h").?.integer);
    try testing.expectEqual(@as(i64, 1), st.get("sells24h").?.integer);
    try testing.expectEqual(@as(i64, 7_000), st.get("lastTradeAt").?.integer);
    try testing.expectEqual(@as(i64, 1), st.get("pools").?.integer);
    try testing.expect(st.get("tvlSats").?.integer > 0 and st.get("tvlTokens").?.integer > 0);
    try testing.expect(st.get("volume24hSats").?.integer > 20_000);
}
