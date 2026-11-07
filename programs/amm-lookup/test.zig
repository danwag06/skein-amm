//! amm-lookup, natively: the index maintained through the hooks (admitted,
//! spent, rejected) over the real fixtures (src/fixtures/vectors.zig,
//! gen/vectors), the pool checks `admitted` runs (only pools that pass are
//! indexed), the queries, and the answer shape. See README.md.
//!
//! The hooks are called directly (`idx.admitted` / `idx.spent` /
//! `idx.rejected`), as skein's engine would call them (docs/OVERLAY.md, "The
//! lookup contract") but without the submit/step machinery around them —
//! that machinery (parsing a BEEF once, judging topics, persisting only on
//! admission) is skein-overlay's own, already tested there (its test.zig).
//! What is this service's own is the index and the queries, which is what
//! these tests cover.
//!
//! The three-hop follow test holds the hops in a chain state (skein-sdk
//! `chain.state.State`, `putTx`: what the chain app records), whose `spent`
//! the walk reads, and runs the hooks for each hop: a focused unit test of
//! `answerOutpoint`'s walk.
const std = @import("std");
const w = @import("chain");
const lookup = @import("lookup");
const pool = @import("pool");
const vec = @import("vectors");
const idx = @import("src/index.zig");

const bsvz = w.bsvz;
const cbor = w.cbor;
const Value = cbor.Value;
const Entry = cbor.Entry;
const Allocator = std.mem.Allocator;
const testing = std.testing;

fn unhex(a: Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

fn cat(a: Allocator, parts: []const []const u8) ![]u8 {
    return std.mem.concat(a, u8, parts);
}

fn key33(hex: []const u8) [33]u8 {
    var k: [33]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, hex) catch unreachable;
    return k;
}

/// A synthetic (invalid, first-byte-only) compressed key: good enough for
/// pool.parse, which only checks the prefix byte (used for LP keys, which no
/// check derives from).
fn key(tag: u8) [33]u8 {
    var k: [33]u8 = .{0x02} ** 33;
    k[1] = tag;
    return k;
}

const Fixtures = struct {
    txs: std.AutoHashMap([32]u8, bsvz.transaction.Transaction),
    raws: std.StringHashMap([]const u8),
    id: [32]u8,

    fn init(a: Allocator) !Fixtures {
        var f: Fixtures = .{ .txs = .init(a), .raws = .init(a), .id = undefined };
        inline for (.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in", "close", "rescind", "close_rescinded", "pool_deploy_unaffirmed", "pool_deploy_forged", "pool_deploy_own_key", "swap_bad_next" }) |name| {
            const bytes = unhex(a, @field(vec, name));
            try f.raws.put(name, bytes);
            try f.txs.put(w.beef.txidOf(bytes), try bsvz.transaction.Transaction.parse(a, bytes));
        }
        f.id = w.beef.txidOf(f.raws.get("token_deploy").?);
        return f;
    }
    fn raw(self: Fixtures, name: []const u8) []const u8 {
        return self.raws.get(name).?;
    }
    fn tx(self: Fixtures, name: []const u8) bsvz.transaction.Transaction {
        return self.txs.get(w.beef.txidOf(self.raws.get(name).?)).?;
    }
    fn txid(self: Fixtures, name: []const u8) [32]u8 {
        return w.beef.txidOf(self.raws.get(name).?);
    }
    /// Every fixture transaction held as a bitcoin-tx block, as the overlay
    /// holds a submission and its ancestry: what `admitted` reads the
    /// previous coins' sources from.
    fn hold(self: Fixtures, a: Allocator, s: w.store.Store) !void {
        var it = self.raws.valueIterator();
        while (it.next()) |r| _ = try s.putBitcoin(a, .tx, r.*);
    }
};

/// `lookup.Tx`, as a hook receives it (its CID does not matter to this
/// service — it never calls `Service.tx` itself — but must not be a
/// dangling stack pointer).
fn ltx(a: Allocator, txid: [32]u8, t: bsvz.transaction.Transaction) !lookup.Tx {
    const cid = w.store.hashCid(.tx, txid);
    return .{ .cid = try a.dupe(u8, cid[0..]), .txid = txid, .tx = t };
}

fn serviceAndTopic(a: Allocator, id: [32]u8) !struct { service: []const u8, topic: []const u8, token: []const u8 } {
    const token = try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(id)});
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_color_{s}_0", .{&w.header.toHex(id)}), try idx.topicOf(a, token));
    return .{ .service = idx.service_name, .topic = try idx.topicOf(a, token), .token = token };
}

/// A query naming the token `token`, with `rest`.
fn query(a: Allocator, token: []const u8, rest: []const Entry) !Value {
    return .{ .map = try std.mem.concat(a, Entry, &.{ &.{.{ .key = "tokenId", .value = .{ .text = token } }}, rest }) };
}

fn opStr(a: Allocator, txid: [32]u8, vout: u32) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}_{d}", .{ &w.header.toHex(txid), vout });
}

/// `pool_deploy`'s output-0 script, with the state's TokenReserve and keys
/// overwritten and the prefix amount set to the new reserve: a spend's
/// continuation (or an unrelated pool), sharing the real,
/// gen/main.go-compiled Pool template so `pool.parse` still succeeds. The
/// Nonce and Affirmation are kept, unless `attest` names others (0.13.0).
fn withState(a: Allocator, id: [32]u8, script: []const u8, token_reserve: u64, lp: [33]u8, validator: [33]u8, identity: [33]u8) ![]u8 {
    return withStateAttested(a, id, script, token_reserve, lp, validator, identity, null);
}

const Attest = struct { nonce: [32]u8, affirmation: []const u8 };

fn withStateAttested(a: Allocator, id: [32]u8, script: []const u8, token_reserve: u64, lp: [33]u8, validator: [33]u8, identity: [33]u8, attest: ?Attest) ![]u8 {
    const lock = pool.brc162.decode(script).?.lock;
    const p = (try pool.parse(lock)).?;
    var st: [8 + 99 + 32]u8 = undefined;
    std.mem.writeInt(u64, st[0..8], token_reserve, .little);
    @memcpy(st[8..][0..33], &lp);
    @memcpy(st[8 + 33 ..][0..33], &validator);
    @memcpy(st[8 + 66 ..][0..33], &identity);
    @memcpy(st[8 + 99 ..][0..32], if (attest) |t| &t.nonce else &p.nonce);
    const af = if (attest) |t| t.affirmation else p.affirmation;
    var buf: [10]u8 = undefined;
    return cat(a, &.{ &.{0x20}, &id, pool.brc162.pushAmount(&buf, token_reserve), &.{0x6d}, lock[0 .. p.code_len + 1], &st, &.{@intCast(af.len)}, af });
}

/// `script` with the state's ValidatorPubKey replaced.
fn withValidator(a: Allocator, script: []const u8, validator: [33]u8) ![]u8 {
    const c = try a.dupe(u8, script);
    const lock = pool.brc162.decode(script).?.lock;
    const p = (try pool.parse(lock)).?;
    @memcpy(c[script.len - lock.len + p.code_len + 1 + 8 + 33 ..][0..33], &validator);
    return c;
}

/// `t` with output `i`'s script replaced (same txid: the hooks take it as given).
fn withOutput(a: Allocator, t: bsvz.transaction.Transaction, i: usize, script: []const u8) !bsvz.transaction.Transaction {
    const outs = try a.dupe(bsvz.transaction.Output, t.outputs);
    outs[i].locking_script = bsvz.script.Script.init(script);
    var r = t;
    r.outputs = outs;
    return r;
}

const Built = struct { raw: []const u8, txid: [32]u8, tx: bsvz.transaction.Transaction };

/// A transaction spending `prev`'s output `prev_vout` with `unlocking` (a
/// pool spend's method index is its last push: OP_0 Swap, OP_1 Close, OP_2 Rescind),
/// with one output (`script`, `sats`), and a second (`second`, 1 sat) when given.
/// Unsigned: nothing here runs the interpreter.
fn buildSpend(a: Allocator, prev: bsvz.transaction.Transaction, prev_vout: u32, unlocking: []const u8, script: []const u8, sats: i64, second: ?[]const u8) !Built {
    var b = bsvz.transaction.Builder.init(a);
    try b.addInputFromTx(&prev, prev_vout);
    try b.addOutput(.{ .satoshis = sats, .locking_script = bsvz.script.Script.init(script) });
    if (second) |s2| try b.addOutput(.{ .satoshis = 1, .locking_script = bsvz.script.Script.init(s2) });
    var tx = try b.build();
    @constCast(tx.inputs)[0].unlocking_script = bsvz.script.Script.init(unlocking);
    const raw = try tx.serialize(a);
    return .{ .raw = raw, .txid = w.beef.txidOf(raw), .tx = try bsvz.transaction.Transaction.parse(a, raw) };
}

// ---------------------------------------------------------------- tests

const Env = struct {
    ms: w.store.MemStore,
    f: Fixtures,
    service: []const u8,
    topic: []const u8,
    token: []const u8,

    fn init(a: Allocator) !*Env {
        const e = try a.create(Env);
        e.ms = w.store.MemStore.init(testing.allocator);
        e.f = try Fixtures.init(a);
        try e.f.hold(a, e.ms.store());
        const st = try serviceAndTopic(a, e.f.id);
        e.service = st.service;
        e.topic = st.topic;
        e.token = st.token;
        return e;
    }
    fn deinit(self: *Env) void {
        self.ms.deinit();
    }
    fn svc(self: *Env, a: Allocator) !lookup.Service {
        return lookup.Service.load(a, self.ms.store(), self.service, idx.spec.maps, null);
    }
    /// The chain state (empty: what the chain app holds), read by `{outpoint}`'s walk.
    fn chain(self: *Env, a: Allocator) !lookup.Chain {
        return lookup.Chain.load(a, self.ms.store(), null, .regtest);
    }
    fn q(self: *Env, a: Allocator, rest: []const Entry) !Value {
        return query(a, self.token, rest);
    }
    /// `admitted` on fixture `name` (or a variant of it, same txid).
    fn admit(self: *Env, a: Allocator, s: *lookup.Service, name: []const u8, t: ?bsvz.transaction.Transaction, outs: []const u32, coins: []const u32) !void {
        try idx.admitted(a, s, self.topic, try ltx(a, self.f.txid(name), t orelse self.f.tx(name)), outs, coins);
    }
};

test "names: a query's tokenId <txid>, <txid>_0 or <txid>.0 is the topic tm_color_<txid>_0, <txid>_<vout> is tm_color_<txid>_<vout>; other ids are refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const hex = "0102030405060708091011121314151617181920212223242526272829303132";
    // skein-1color 0.4.0 token ids: a 1Color-originated token prints the bare <txid>, a
    // BSV-21-originated one <txid>_<vout>; every form names the same token and topic.
    // The topic is `tm_color_<assetId>` (BRC-207, skein-1color 0.9.0, David Case 2026-10-08).
    try testing.expectEqualStrings("tm_color_" ++ hex ++ "_0", try idx.topicOf(a, hex));
    try testing.expectEqualStrings("tm_color_" ++ hex ++ "_0", try idx.topicOf(a, hex ++ "_0"));
    try testing.expectEqualStrings("tm_color_" ++ hex ++ "_0", try idx.topicOf(a, hex ++ ".0"));
    try testing.expectEqualStrings("tm_color_" ++ hex ++ "_17", try idx.topicOf(a, hex ++ "_17"));
    try testing.expectEqualStrings("tm_color_" ++ hex ++ "_17", try idx.topicOf(a, hex ++ ".17"));
    try testing.expectError(error.BadQuery, idx.topicOf(a, hex ++ "_017"));
    try testing.expectError(error.BadQuery, idx.topicOf(a, "abcd_0"));
    try testing.expectEqual(pool.bsv21.Kind.legacy, idx.tokenIdOf("tm_color_" ++ hex ++ "_17").?.kind);
    try testing.expectEqual(pool.bsv21.Kind.native, idx.tokenIdOf("tm_color_" ++ hex ++ "_0").?.kind);
    try testing.expect(idx.tokenIdOf("tm_color") == null);
    try testing.expect(idx.tokenIdOf("tm_color_" ++ hex) == null);
    try testing.expect(idx.tokenIdOf("tm_" ++ hex ++ "_0") == null); // the old name: no alias
    try testing.expect(idx.tokenIdOf("tm_" ++ hex) == null);
    // The names before BRC-207's wire names (skein-1color 0.10.0, 2026-10-21): no alias.
    try testing.expect(idx.tokenIdOf("tm_mandala_" ++ hex ++ "_0") == null);
    try testing.expectError(error.BadQuery, idx.topicOf(a, "tm_mandala_" ++ hex ++ "_0"));
    // Its index is `<app>/ls_amm` whatever name it is served as (skein-overlay 0.11.0).
    try testing.expectEqualStrings("ls_amm", idx.spec.index.?);
}

test "queries: one service over every token, each query naming its token; a query without one is refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try testing.expectError(error.BadQuery, idx.answer(a, &svc, &ch, .{ .map = &.{} }));
    // Another token: nothing of it is indexed.
    const other = try query(a, "0102030405060708091011121314151617181920212223242526272829303132_0", &.{});
    try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, other)).freeform.array.len);
    try testing.expectEqual(@as(usize, 1), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);
}

test "admitted: a pool deploy that passes the checks is indexed once, and the answer matches the engine's PoolState shape" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_txid = e.f.txid("pool_deploy");
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0}); // a dupe hook call
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());

    // {} — every live pool, in the engine's PoolState shape plus `outpoint`.
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(usize, 1), all.freeform.array.len);
    const entry = all.freeform.array[0];
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), entry.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool0.bsv), entry.get("bsvReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.pool0.tokens), entry.get("tokenReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.lp_fee_bps), entry.get("liquidityFeeBps").?.uint);
    try testing.expectEqual(@as(u64, vec.validator_fee_bps), entry.get("validationFeeBps").?.uint);
    try testing.expectEqual(@as(u64, vec.commission_bps), entry.get("commissionBps").?.uint);
    try testing.expectEqualStrings(vec.identity, entry.getText("validatorIdentityKey").?);
    // 0.34.0: the pool's LpPubKey (its id) in the answer; no `lastSeen` (the liveness join is the host's).
    try testing.expectEqualStrings(vec.lp, entry.getText("lpPubKey").?);
    try testing.expect(entry.get("lastSeen") == null);
    // 0.40.0: its id (the deploy's outpoint) and its swap count.
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), entry.getText("poolId").?);
    try testing.expectEqual(@as(u64, 0), entry.get("swaps").?.uint);
    try testing.expectEqual(@as(usize, 10), entry.map.len);
    // The dupe wrote one deploy event.
    try testing.expectEqual(@as(usize, 1), try svc.map("history").count());

    // {outpoint}: a direct hit is 0 hops.
    const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }});
    const direct = try idx.answer(a, &svc, &ch, q);
    try testing.expectEqual(@as(u64, 0), direct.freeform.get("hops").?.uint);
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), direct.freeform.get("current").?.getText("outpoint").?);

    // {outpoint, beef: true}: the output-list form for a taker's spend.
    const bq = try e.q(a, &.{ .{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }, .{ .key = "beef", .value = .{ .boolean = true } } });
    const beef_ans = try idx.answer(a, &svc, &ch, bq);
    try testing.expectEqual(@as(usize, 1), beef_ans.output_list.len);
    try testing.expectEqualSlices(u8, &pd_txid, &beef_ans.output_list[0].txid);
    try testing.expectEqual(@as(u32, 0), beef_ans.output_list[0].vout);
}

test "admitted: pools the topic admitted but that fail the pool checks are not indexed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const f = e.f;
    const pd = f.tx("pool_deploy");
    const pd_script = pd.outputs[0].locking_script.bytes;

    // The judgement agrees with pool.check on each case.
    const S = struct {
        fn expectNot(al: Allocator, en: *Env, sv: *lookup.Service, name: []const u8, t: bsvz.transaction.Transaction, outs: []const u32, coins: []const u32, want: pool.Violation) !void {
            const got = try idx.judge(al, .{ .txid = en.f.id }, try ltx(al, en.f.txid(name), t), outs);
            try testing.expectEqual(want, got.?);
            try en.admit(al, sv, name, t, outs, coins);
            try testing.expectEqual(@as(usize, 0), try sv.map("pools").count());
        }
    };

    // Prefix amount one lower than the state's TokenReserve.
    var buf: [10]u8 = undefined;
    const low = try cat(a, &.{ &.{0x20}, &f.id, pool.brc162.pushAmount(&buf, vec.pool0.tokens - 1), &.{0x6d}, pool.brc162.decode(pd_script).?.lock });
    try S.expectNot(a, e, &svc, "pool_deploy", try withOutput(a, pd, 0, low), &.{ 0, 1, 2 }, &.{0}, .prefix_mismatch);

    // A pool at output 1 (outputs 0 and 1 swapped).
    var swapped = pd;
    const outs = try a.dupe(bsvz.transaction.Output, pd.outputs);
    std.mem.swap(bsvz.transaction.Output, &outs[0], &outs[1]);
    swapped.outputs = outs;
    try S.expectNot(a, e, &svc, "pool_deploy", swapped, &.{ 0, 1, 2 }, &.{0}, .not_at_output_0);

    // The real ones pass.
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")), &.{ 0, 2, 3, 4 }) == null);
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, f.txid("close"), f.tx("close")), &.{1}) == null);
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, f.txid("rescind"), f.tx("rescind")), &.{0}) == null);
}

test "admitted: a pool's CommissionBps is answered as commissionBps (0: a pool with no commission)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    // The deploy with CommissionBps OP_10 rewritten to OP_0. The lock's
    // commission slot (template offset 723) sits one byte later, after
    // lpFeeBps' two-byte push (the pool test of the slot, test.zig).
    const pd = e.f.tx("pool_deploy");
    const script = try a.dupe(u8, pd.outputs[0].locking_script.bytes);
    const at = script.len - pool.brc162.decode(script).?.lock.len + 724;
    try testing.expectEqual(@as(u8, 0x5a), script[at]);
    script[at] = 0x00;
    // The affirmation signs the pool's fees, so a rewritten script is not affirmed: the pool is
    // not listed (not indexed). The pool still reads the commission as 0.
    try e.admit(a, &svc, "pool_deploy", try withOutput(a, pd, 0, script), &.{ 0, 1, 2 }, &.{0});
    try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);
    const pf = idx.poolAt(e.f.txid("pool_deploy"), 0, script, vec.pool0.bsv).?;
    try testing.expectEqual(@as(i64, 0), pf.commission_bps);
}

test "listing (0.13.0): a continuation is listed only when it is a Swap of a listed pool naming the next key (the spent outpoint's child)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    const f = e.f;
    var ch = try e.chain(a);
    const pd = f.tx("pool_deploy");
    const sw = f.tx("swap_bsv_in");

    // The coins retained do not matter: the affirmation is the pool output's own.
    {
        var sv = try e.svc(a);
        try e.admit(a, &sv, "pool_deploy", pd, &.{ 0, 1, 2 }, &.{});
        try testing.expectEqual(@as(usize, 1), (try idx.answer(a, &sv, &ch, try e.q(a, &.{}))).freeform.array.len);
        try idx.rejected(a, &sv, e.topic, try ltx(a, f.txid("pool_deploy"), pd));
        try testing.expectEqual(@as(usize, 0), try sv.map("pools").count());
    }

    // Not listed: a swap keeping the pre-swap key; the fixture swap naming another next key
    // (the contract took it: the validator signed); a pool-shaped output 0 of a Close (its
    // outputs are free), carrying the next key.
    const next_key = try pool.validatorKey(a, key33(vec.identity), f.txid("pool_deploy"), 0);
    const close_like = try buildSpend(a, pd, 0, &.{0x51}, sw.outputs[0].locking_script.bytes, 900_000, null);
    for ([_]struct { txid: [32]u8, t: bsvz.transaction.Transaction }{
        .{ .txid = f.txid("swap_bsv_in"), .t = try withOutput(a, sw, 0, try withValidator(a, sw.outputs[0].locking_script.bytes, key33(vec.pool0.validator))) },
        .{ .txid = f.txid("swap_bad_next"), .t = f.tx("swap_bad_next") },
        .{ .txid = close_like.txid, .t = close_like.tx },
    }) |c| {
        var sv = try e.svc(a);
        try e.admit(a, &sv, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
        try idx.admitted(a, &sv, e.topic, try ltx(a, c.txid, c.t), &.{0}, &.{0});
        try idx.spent(a, &sv, e.topic, .{ .txid = f.txid("pool_deploy"), .vout = 0 }, try ltx(a, c.txid, c.t));
        try testing.expectEqual(@as(usize, 0), try sv.map("pools").count());
    }
    try testing.expectEqualSlices(u8, &next_key, &pool.poolOfScript(sw.outputs[0].locking_script.bytes).?.validator);

    // Listed: the fixture swap (Swap, the next key); and a pool spend whose unlocking script is
    // a Swap call (its last push OP_0) naming the next key.
    var svc = try e.svc(a);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try testing.expectEqual(@as(usize, 2), try svc.map("pools").count()); // the deploy's is spent below, by `spent`
    try idx.spent(a, &svc, e.topic, .{ .txid = f.txid("pool_deploy"), .vout = 0 }, try ltx(a, f.txid("swap_bsv_in"), sw));
    try testing.expectEqual(@as(usize, 1), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);

    const hop_script = try withValidator(a, sw.outputs[0].locking_script.bytes, try pool.validatorKey(a, key33(vec.identity), f.txid("swap_bsv_in"), 0));
    const hop = try buildSpend(a, sw, 0, &.{0x00}, hop_script, 900_000, null);
    _ = try e.ms.store().putBitcoin(a, .tx, hop.raw);
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, hop.txid, hop.tx), &.{0}) == null);
    try idx.admitted(a, &svc, e.topic, try ltx(a, hop.txid, hop.tx), &.{0}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = f.txid("swap_bsv_in"), .vout = 0 }, try ltx(a, hop.txid, hop.tx));
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(usize, 1), all.freeform.array.len);
    try testing.expectEqualStrings(try opStr(a, hop.txid, 0), all.freeform.array[0].getText("outpoint").?);

    // The record carries the ValidatorPubKey (33 zero bytes means rescinded).
    const cid = (try svc.map("pools").prefixed(try w.store.nameKey(a, e.topic, &.{})))[0].value.cid;
    const rec = try svc.store.getValue(a, cid);
    try testing.expectEqual(@as(usize, 33), (rec.getBytes("validatorPubKey") orelse return error.TestUnexpectedResult).len);
    try testing.expectEqualSlices(u8, &key33(vec.identity), rec.getBytes("validatorIdentityKey").?);
    try testing.expect(rec.get("claim") == null);
}

test "listing (0.13.0): only a self-attesting pool is listed — not one without the affirmation, one another key signed, one under a key of the LP's own, one whose satoshis are not the ones affirmed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var ch = try e.chain(a);
    const pd = e.f.tx("pool_deploy");
    const outs = try a.dupe(bsvz.transaction.Output, pd.outputs);
    outs[0].satoshis += 1;
    var more = pd;
    more.outputs = outs;
    for ([_]struct { name: []const u8, t: ?bsvz.transaction.Transaction }{
        .{ .name = "pool_deploy_unaffirmed", .t = null },
        .{ .name = "pool_deploy_forged", .t = null },
        .{ .name = "pool_deploy_own_key", .t = null },
        .{ .name = "pool_deploy", .t = more },
    }) |c| {
        var svc = try e.svc(a);
        try e.admit(a, &svc, c.name, c.t, &.{ 0, 1, 2 }, &.{0});
        try testing.expectEqual(@as(usize, 0), try svc.map("pools").count());
        try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);
        const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, e.f.txid(c.name), 0) } }});
        try testing.expectError(error.UnknownOutpoint, idx.answer(a, &svc, &ch, q));
    }
    var svc = try e.svc(a);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try testing.expectEqual(@as(usize, 1), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);

    // A swap of an unaffirmed pool: its continuation (spending nothing listed) is not listed.
    var svc2 = try e.svc(a);
    try e.admit(a, &svc2, "pool_deploy_unaffirmed", null, &.{ 0, 1, 2 }, &.{0});
    const sw = e.f.tx("swap_bsv_in");
    const ins = try a.dupe(bsvz.transaction.Input, sw.inputs);
    ins[0].previous_outpoint.txid.bytes = e.f.txid("pool_deploy_unaffirmed");
    var sw_u = sw;
    sw_u.inputs = ins;
    try idx.admitted(a, &svc2, e.topic, try ltx(a, e.f.txid("swap_bsv_in"), sw_u), &.{ 0, 1 }, &.{0});
    try testing.expectEqual(@as(usize, 0), try svc2.map("pools").count());
}

test "listing (0.13.0): the LP's Close and the validator's Rescind end the live listing; a rejected one lists the pool again" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var ch = try e.chain(a);
    const pd_txid = e.f.txid("pool_deploy");
    const sw_txid = e.f.txid("swap_bsv_in");
    const sw2_txid = e.f.txid("swap_tokens_in");
    for ([_]struct { name: []const u8, outs: []const u32 }{ .{ .name = "close", .outs = &.{1} }, .{ .name = "rescind", .outs = &.{0} } }) |c| {
        const nm = c.name;
        var svc = try e.svc(a);
        try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
        try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
        try idx.spent(a, &svc, e.topic, .{ .txid = pd_txid, .vout = 0 }, try ltx(a, sw_txid, e.f.tx("swap_bsv_in")));
        try e.admit(a, &svc, "swap_tokens_in", null, &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
        try idx.spent(a, &svc, e.topic, .{ .txid = sw_txid, .vout = 0 }, try ltx(a, sw2_txid, e.f.tx("swap_tokens_in")));
        const by_validator = try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = vec.identity } }});
        try testing.expectEqual(@as(usize, 1), (try idx.answer(a, &svc, &ch, by_validator)).freeform.array.len);

        // The Close: the pool spent, no continuation (the LP's tokens are not a pool). The
        // Rescind: the output stays in `pools` with a cleared validator key, skipped by a live read.
        const cl = try ltx(a, e.f.txid(nm), e.f.tx(nm));
        try idx.admitted(a, &svc, e.topic, cl, c.outs, &.{0});
        try idx.spent(a, &svc, e.topic, .{ .txid = sw2_txid, .vout = 0 }, cl);
        const stored: usize = if (std.mem.eql(u8, nm, "rescind")) 1 else 0;
        try testing.expectEqual(stored, try svc.map("pools").count());
        try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);
        try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, by_validator)).freeform.array.len);

        // Rejected: the pool it spent is listed again.
        try idx.rejected(a, &svc, e.topic, cl);
        const back = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
        try testing.expectEqual(@as(usize, 1), back.freeform.array.len);
        try testing.expectEqualStrings(try opStr(a, sw2_txid, 0), back.freeform.array[0].getText("outpoint").?);
    }
}

test "beat (0.12.0): the body is this skein's per-token, per-validator totals of its listed pools, kept and handed on only when it changes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const token = e.token;

    // Nothing listed: no tokens.
    try testing.expectEqual(@as(usize, 0), (try idx.beatValue(a, &svc)).get("tokens").?.map.len);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    const v1 = try idx.beatValue(a, &svc);
    const t1 = v1.get("tokens").?.get(token).?.get(vec.identity).?;
    try testing.expectEqual(@as(u64, vec.pool0.bsv), t1.getUint("sats").?);
    try testing.expectEqual(@as(u64, vec.pool0.tokens), t1.getUint("tokens").?);
    try testing.expectEqual(@as(u64, 1), t1.getUint("pools").?);
    // What fn "beat" answers is that body, dag-cbor; the hook kept its record.
    try testing.expectEqualSlices(u8, try cbor.encode(a, v1), try idx.beat(a, &svc));
    const kept1 = (try svc.map("beat").link("body")).?;
    try testing.expectEqualSlices(u8, kept1, try svc.store.putValue(a, v1));
    if (@hasDecl(lookup.Service, "beat")) try testing.expectEqual(@as(usize, 1), svc.beats.items.len);

    // A dupe admission changes nothing: no new beat.
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try testing.expectEqualSlices(u8, kept1, (try svc.map("beat").link("body")).?);
    if (@hasDecl(lookup.Service, "beat")) try testing.expectEqual(@as(usize, 1), svc.beats.items.len);

    // A swap moves the totals.
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("pool_deploy"), .vout = 0 }, try ltx(a, e.f.txid("swap_bsv_in"), e.f.tx("swap_bsv_in")));
    const t2 = (try idx.beatValue(a, &svc)).get("tokens").?.get(token).?.get(vec.identity).?;
    try testing.expectEqual(@as(u64, vec.pool1.bsv), t2.getUint("sats").?);
    try testing.expectEqual(@as(u64, vec.pool1.tokens), t2.getUint("tokens").?);
    try testing.expect(!std.mem.eql(u8, kept1, (try svc.map("beat").link("body")).?));

    // The fixture Rescind spends the second Swap's output. Its record stays in `pools` with a
    // cleared validator key, and the beat skips it.
    try e.admit(a, &svc, "swap_tokens_in", null, &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_bsv_in"), .vout = 0 }, try ltx(a, e.f.txid("swap_tokens_in"), e.f.tx("swap_tokens_in")));
    const cl = try ltx(a, e.f.txid("rescind"), e.f.tx("rescind"));
    try idx.admitted(a, &svc, e.topic, cl, &.{0}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
    try testing.expectEqual(@as(usize, 0), (try idx.beatValue(a, &svc)).get("tokens").?.map.len);
}

test "admitted: another topic's call indexes nothing" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const f = try Fixtures.init(a);
    const st = try serviceAndTopic(a, f.id);
    var svc = try lookup.Service.load(a, ms.store(), st.service, idx.spec.maps, null);
    const pd = try ltx(a, f.txid("pool_deploy"), f.tx("pool_deploy"));

    try idx.admitted(a, &svc, "tm_demo", pd, &.{0}, &.{0});
    try testing.expectEqual(@as(usize, 0), try svc.map("pools").count());
}

test "spent + admitted: a swap's continuation replaces the pool it spent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_txid = e.f.txid("pool_deploy");
    const sw_txid = e.f.txid("swap_bsv_in");
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = pd_txid, .vout = 0 }, try ltx(a, sw_txid, e.f.tx("swap_bsv_in")));

    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(usize, 1), all.freeform.array.len);
    const entry = all.freeform.array[0];
    try testing.expectEqualStrings(try opStr(a, sw_txid, 0), entry.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool1.bsv), entry.get("bsvReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.pool1.tokens), entry.get("tokenReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.commission_bps), entry.get("commissionBps").?.uint);

    // The old outpoint is a spent pool; the chain state (empty here) names no
    // spender for it, so the walk errors rather than silently answering
    // nothing. An outpoint that was never a pool errors the same way.
    const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }});
    try testing.expectError(error.UnknownOutpoint, idx.answer(a, &svc, &ch, q));
    const never = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 1) } }});
    try testing.expectError(error.UnknownOutpoint, idx.answer(a, &svc, &ch, never));
}

test "rejected: drops the rejected transaction's pool and restores the checked one it spent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_txid = e.f.txid("pool_deploy");
    const sw = try ltx(a, e.f.txid("swap_bsv_in"), e.f.tx("swap_bsv_in"));
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = pd_txid, .vout = 0 }, sw);

    try idx.rejected(a, &svc, e.topic, sw);

    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("spentPools").count());
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    const entry = all.freeform.array[0];
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), entry.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool0.tokens), entry.get("tokenReserve").?.uint);

    // A rejection gives back only what was indexed: a pool that failed the
    // checks when admitted stays out.
    var svc2 = try lookup.Service.load(a, e.ms.store(), e.service, idx.spec.maps, null);
    var buf: [10]u8 = undefined;
    const pd = e.f.tx("pool_deploy");
    const low = try cat(a, &.{ &.{0x20}, &e.f.id, pool.brc162.pushAmount(&buf, vec.pool0.tokens - 1), &.{0x6d}, pool.brc162.decode(pd.outputs[0].locking_script.bytes).?.lock });
    try e.admit(a, &svc2, "pool_deploy", try withOutput(a, pd, 0, low), &.{0}, &.{0}); // prefix mismatch: not indexed
    try idx.spent(a, &svc2, e.topic, .{ .txid = pd_txid, .vout = 0 }, sw);
    try idx.rejected(a, &svc2, e.topic, sw);
    try testing.expectEqual(@as(usize, 0), try svc2.map("pools").count());
}

test "answer: {outpoint} follows the spends (the chain state's) to the newest continuation over three hops" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    const identity = key33(vec.identity);

    const pd_tx = e.f.tx("pool_deploy");
    const pd_txid = e.f.txid("pool_deploy");
    const pd_script = pd_tx.outputs[0].locking_script.bytes;
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});
    _ = try ch.putTx(pd_txid, e.f.raw("pool_deploy"));

    var prev_tx = pd_tx;
    var prev_txid = pd_txid;
    const reserves = [_]u64{ 4_000_000, 3_000_000, 2_000_000 };
    var tip_txid: [32]u8 = undefined;
    for (reserves, 0..) |r, i| {
        // A Swap (OP_0): the key rotates to the child of the spent pool's outpoint.
        const validator = try pool.validatorKey(a, identity, prev_txid, 0);
        const script = try withState(a, e.f.id, pd_script, r, key(0xa0), validator, identity);
        const hop = try buildSpend(a, prev_tx, 0, &.{0x00}, script, 900_000 - @as(i64, @intCast(i)) * 1000, null);
        _ = try e.ms.store().putBitcoin(a, .tx, hop.raw);
        try idx.admitted(a, &svc, e.topic, try ltx(a, hop.txid, hop.tx), &.{0}, &.{0});
        try idx.spent(a, &svc, e.topic, .{ .txid = prev_txid, .vout = 0 }, try ltx(a, hop.txid, hop.tx));
        _ = try ch.putTx(hop.txid, hop.raw);
        prev_tx = hop.tx;
        prev_txid = hop.txid;
        tip_txid = hop.txid;
    }

    // Only the tip is indexed.
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());

    const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }});
    const ans = try idx.answer(a, &svc, &ch, q);
    try testing.expectEqual(@as(u64, 3), ans.freeform.get("hops").?.uint);
    const current = ans.freeform.get("current").?;
    try testing.expectEqualStrings(try opStr(a, tip_txid, 0), current.getText("outpoint").?);
    try testing.expectEqual(@as(u64, reserves[2]), current.get("tokenReserve").?.uint);
}

test "answer: {validatorIdentityKey} returns only that validator's pools" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_tx = e.f.tx("pool_deploy");
    const pd_txid = e.f.txid("pool_deploy");
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});

    // A second pool under another validator, a deploy from pool_deploy's token output 1: its
    // key is that validator's child of its nonce, and its affirmation is signed by it (0.13.0).
    const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(.{0x42} ** 32));
    const other_identity = (try kd.identityKey()).toCompressedSec1();
    const nonce_b: [32]u8 = .{0x6b} ** 32;
    const validator_b = try pool.firstValidatorKey(a, other_identity, nonce_b);
    const bare_b = try withStateAttested(a, e.f.id, pd_tx.outputs[0].locking_script.bytes, 777_000, key(0x10), validator_b, other_identity, .{ .nonce = nonce_b, .affirmation = &.{} });
    var kbuf: [64]u8 = undefined;
    const child = try kd.derivePrivateKey(a, pool.validator_protocol, pool.nonceKeyId(&kbuf, nonce_b), .{ .type_ = .anyone });
    const p_b = (try pool.parse(pool.brc162.decode(bare_b).?.lock)).?;
    const sig_b = try child.signDigest(pool.affirmDigest(p_b, 50_000));
    const script_b = try withStateAttested(a, e.f.id, pd_tx.outputs[0].locking_script.bytes, 777_000, key(0x10), validator_b, other_identity, .{ .nonce = nonce_b, .affirmation = sig_b.asSlice() });
    try testing.expect(pool.affirmed(a, script_b, 50_000));
    const pool_b = try buildSpend(a, pd_tx, 1, &.{}, script_b, 50_000, null);
    try idx.admitted(a, &svc, e.topic, try ltx(a, pool_b.txid, pool_b.tx), &.{0}, &.{0});

    try testing.expectEqual(@as(usize, 2), try svc.map("pools").count());

    const ida = try idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = vec.identity } }}));
    try testing.expectEqual(@as(usize, 1), ida.freeform.array.len);
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), ida.freeform.array[0].getText("outpoint").?);

    const hex_b = std.fmt.bytesToHex(other_identity, .lower);
    const idb = try idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = &hex_b } }}));
    try testing.expectEqual(@as(usize, 1), idb.freeform.array.len);
    try testing.expectEqualStrings(try opStr(a, pool_b.txid, 0), idb.freeform.array[0].getText("outpoint").?);
}

// ---------------------------------------------------------------- the fee rows (0.33.0)

/// `swap_bsv_in` with no commission: its continuation's CommissionBps OP_0 (the lock's slot at 724,
/// test.zig "CommissionBps is read under the canonical-number rule") and its commission output
/// (output 4) gone. Same txid as given to the hooks.
fn noCommission(a: Allocator, sw: bsvz.transaction.Transaction) !bsvz.transaction.Transaction {
    const script = try a.dupe(u8, sw.outputs[0].locking_script.bytes);
    const lock = pool.brc162.decode(script).?.lock;
    const at = script.len - lock.len + 724;
    try testing.expectEqual(@as(u8, 0x5a), script[at]);
    script[at] = 0x00;
    var outs: std.ArrayList(bsvz.transaction.Output) = .empty;
    for (sw.outputs, 0..) |o, i| if (i != 4) try outs.append(a, o);
    outs.items[0].locking_script = bsvz.script.Script.init(script);
    var t = sw;
    t.outputs = outs.items;
    return t;
}

/// The fixtures' pool and its two Swaps, admitted: pool_deploy → swap_bsv_in (20,000 sats in: LP 60,
/// validator 10, commission 20 sats) → swap_tokens_in (50,000 tokens in: LP 150, validator 25,
/// commission 50 tokens).
fn twoSwaps(a: Allocator, e: *Env, svc: *lookup.Service) !void {
    const f = e.f;
    try e.admit(a, svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try e.admit(a, svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, svc, e.topic, .{ .txid = f.txid("pool_deploy"), .vout = 0 }, try ltx(a, f.txid("swap_bsv_in"), f.tx("swap_bsv_in")));
    try e.admit(a, svc, "swap_tokens_in", null, &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
    try idx.spent(a, svc, e.topic, .{ .txid = f.txid("swap_bsv_in"), .vout = 0 }, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")));
}

fn listQuery(a: Allocator, e: *Env, field: []const u8, keys: []const []const u8) !Value {
    const vs = try a.alloc(Value, keys.len);
    for (keys, vs) |k, *v| v.* = .{ .text = k };
    return e.q(a, &.{.{ .key = field, .value = .{ .array = vs } }});
}

const unknown33 = "02" ++ "a0" ** 32;
/// A pool id no pool has (0.40.0).
const unknown_pool = "a0" ** 32 ++ "_0";

/// The fixtures' pool id (0.40.0): its deploy's outpoint key, and its text `<txid>_0`.
fn poolId(e: *Env) [36]u8 {
    return w.store.outpointKey(e.f.txid("pool_deploy"), 0);
}
fn poolIdText(a: Allocator, e: *Env) ![]const u8 {
    return opStr(a, e.f.txid("pool_deploy"), 0);
}
const unknown20 = "55" ** 20;

test "fee rows (0.33.0): a Swap's admission writes its row under the pool's LP key (the three fees, the asset, the commission's key hash) and its membership under the key hash; a deploy writes none" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try testing.expectEqual(@as(usize, 0), try svc.map("fees").count());
    try twoSwaps(a, e, &svc);
    try testing.expectEqual(@as(usize, 2), try svc.map("fees").count());
    try testing.expectEqual(@as(usize, 2), try svc.map("byCommission").count());
    const tp = try w.store.nameKey(a, e.topic, &.{});
    const cid = (try svc.map("fees").link(try cat(a, &.{ tp, &poolId(e), &e.f.txid("swap_bsv_in") }))).?;
    const rec = try svc.store.getValue(a, cid);
    try testing.expectEqual(@as(u64, 60), rec.getUint("lp").?);
    try testing.expectEqual(@as(u64, 10), rec.getUint("validator").?);
    try testing.expectEqual(@as(u64, 20), rec.getUint("commission").?);
    try testing.expect(rec.getBool("bsvIn").?);
    try testing.expectEqualSlices(u8, unhex(a, vec.commission_pkh), rec.getBytes("commissionPkh").?);
    try testing.expect((try svc.map("byCommission").link(try cat(a, &.{ unhex(a, vec.commission_pkh), tp, &e.f.txid("swap_bsv_in") }))) != null);
}

test "fee rows (0.33.0): a rejected Swap's row and membership are removed; the other Swap's stay" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    try twoSwaps(a, e, &svc);
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("swap_tokens_in"), e.f.tx("swap_tokens_in")));
    try testing.expectEqual(@as(usize, 1), try svc.map("fees").count());
    try testing.expectEqual(@as(usize, 1), try svc.map("byCommission").count());
    var ch = try e.chain(a);
    const ans = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "poolIds", &.{try poolIdText(a, e)}))).freeform.array[0];
    try testing.expectEqual(@as(u64, 60), ans.get("sats").?.uint);
    try testing.expectEqual(@as(u64, 0), ans.get("tokens").?.uint);
    try testing.expectEqual(@as(u64, 1), ans.get("swaps").?.uint);
}

test "fee rows (0.33.0): a Swap with no commission writes its row (commission 0) and no membership" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try e.admit(a, &svc, "swap_bsv_in", try noCommission(a, e.f.tx("swap_bsv_in")), &.{ 0, 1 }, &.{0});
    try testing.expectEqual(@as(usize, 1), try svc.map("fees").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("byCommission").count());
    const lp = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "poolIds", &.{try poolIdText(a, e)}))).freeform.array[0];
    try testing.expectEqual(@as(u64, 60), lp.get("sats").?.uint);
    const com = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "commissionPkhs", &.{vec.commission_pkh}))).freeform.array[0];
    try testing.expectEqual(@as(u64, 0), com.get("swaps").?.uint);
    // Rejected: its row goes, nothing else to remove.
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("swap_bsv_in"), try noCommission(a, e.f.tx("swap_bsv_in"))));
    try testing.expectEqual(@as(usize, 0), try svc.map("fees").count());
}

test "queries (0.40.0): {poolIds} — one record per pool id, its LP key, the LP fees (sats from sats-in, tokens from token-in), status live with its outpoint and current; closed after the Close; an unknown id closed with zeros" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try twoSwaps(a, e, &svc);
    const ans = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "poolIds", &.{ try poolIdText(a, e), unknown_pool }))).freeform.array;
    try testing.expectEqual(@as(usize, 2), ans.len);
    try testing.expectEqualStrings(try poolIdText(a, e), ans[0].getText("poolId").?);
    try testing.expectEqualStrings(vec.lp, ans[0].getText("lpPubKey").?);
    try testing.expectEqual(@as(u64, 60), ans[0].get("sats").?.uint);
    try testing.expectEqual(@as(u64, 150), ans[0].get("tokens").?.uint);
    try testing.expectEqual(@as(u64, 2), ans[0].get("swaps").?.uint);
    try testing.expectEqualStrings("live", ans[0].getText("status").?);
    try testing.expectEqualStrings(try opStr(a, e.f.txid("swap_tokens_in"), 0), ans[0].getText("outpoint").?);
    try testing.expectEqualStrings(try opStr(a, e.f.txid("swap_tokens_in"), 0), ans[0].get("current").?.getText("outpoint").?);
    try testing.expectEqualStrings(unknown_pool, ans[1].getText("poolId").?);
    try testing.expect(ans[1].get("lpPubKey").? == .null);
    try testing.expectEqualStrings("closed", ans[1].getText("status").?);
    try testing.expect(ans[1].get("outpoint") == null);
    try testing.expectEqual(@as(u64, 0), ans[1].get("sats").?.uint);
    try testing.expectEqual(@as(u64, 0), ans[1].get("tokens").?.uint);
    try testing.expectEqual(@as(u64, 0), ans[1].get("swaps").?.uint);
    try testing.expect(ans[1].get("current") == null);

    // Closed (the LP's Close): the rows stay, no current.
    const cl = try ltx(a, e.f.txid("close"), e.f.tx("close"));
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    const after = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "poolIds", &.{try poolIdText(a, e)}))).freeform.array[0];
    try testing.expectEqual(@as(u64, 2), after.get("swaps").?.uint);
    try testing.expectEqualStrings("closed", after.getText("status").?);
    try testing.expect(after.get("current") == null);

    // Not a list, or a key of the wrong length: refused.
    try testing.expectError(error.BadQuery, idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "poolIds", .value = .{ .text = try poolIdText(a, e) } }})));
    try testing.expectError(error.BadQuery, idx.answer(a, &svc, &ch, try listQuery(a, e, "poolIds", &.{"02ab"})));
    // The LP key is a lookup key nowhere: the old query answers the live pools, as `{tokenId}` does.
    try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, try listQuery(a, e, "lpPubKeys", &.{vec.lp}))).freeform.array.len);
}

test "queries (0.33.0): {validatorIdentityKeys} — the validator fees over its live pools' rows; {commissionPkhs} — the commissions naming each key hash; unknown keys zeros" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try twoSwaps(a, e, &svc);
    const vs = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "validatorIdentityKeys", &.{ vec.identity, unknown33 }))).freeform.array;
    try testing.expectEqualStrings(vec.identity, vs[0].getText("validatorIdentityKey").?);
    try testing.expectEqual(@as(u64, 10), vs[0].get("sats").?.uint);
    try testing.expectEqual(@as(u64, 25), vs[0].get("tokens").?.uint);
    try testing.expectEqual(@as(u64, 2), vs[0].get("swaps").?.uint);
    try testing.expectEqual(@as(u64, 1), vs[0].get("pools").?.uint);
    try testing.expectEqual(@as(u64, 0), vs[1].get("swaps").?.uint);
    try testing.expectEqual(@as(u64, 0), vs[1].get("pools").?.uint);

    const cs = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "commissionPkhs", &.{ vec.commission_pkh, unknown20 }))).freeform.array;
    try testing.expectEqualStrings(vec.commission_pkh, cs[0].getText("commissionPkh").?);
    try testing.expectEqual(@as(u64, 20), cs[0].get("sats").?.uint);
    try testing.expectEqual(@as(u64, 50), cs[0].get("tokens").?.uint);
    try testing.expectEqual(@as(u64, 2), cs[0].get("swaps").?.uint);
    try testing.expectEqualStrings(unknown20, cs[1].getText("commissionPkh").?);
    try testing.expectEqual(@as(u64, 0), cs[1].get("sats").?.uint);
    try testing.expectEqual(@as(u64, 0), cs[1].get("swaps").?.uint);

    // The existing single-key validator query is unchanged: its pools.
    const one = try idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = vec.identity } }}));
    try testing.expectEqual(@as(usize, 1), one.freeform.array.len);
}

test "queries (0.40.0): {poolIds} — a pool the validator rescinded is `rescinded` with the Rescind's output (what the Close acts on), the fees kept; its Close (in the chain state) makes it closed; a rejected Rescind gives the live pool back" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try twoSwaps(a, e, &svc);
    const rs = try ltx(a, e.f.txid("rescind"), e.f.tx("rescind"));
    try idx.admitted(a, &svc, e.topic, rs, &.{0}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, rs);
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
    const q = try listQuery(a, e, "poolIds", &.{try poolIdText(a, e)});
    const r = (try idx.answer(a, &svc, &ch, q)).freeform.array[0];
    try testing.expectEqualStrings("rescinded", r.getText("status").?);
    try testing.expectEqualStrings(try opStr(a, e.f.txid("rescind"), 0), r.getText("outpoint").?);
    try testing.expectEqualStrings(try opStr(a, e.f.txid("rescind"), 0), r.get("current").?.getText("outpoint").?);
    try testing.expectEqual(@as(u64, 3), r.get("current").?.getUint("swaps").?);
    try testing.expectEqual(@as(u64, 2), r.get("swaps").?.uint);

    // The LP's Close of the rescinded output: it leaves `pools`, so the position is closed.
    const cr = try ltx(a, e.f.txid("close_rescinded"), e.f.tx("close_rescinded"));
    try idx.admitted(a, &svc, e.topic, cr, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("rescind"), .vout = 0 }, cr);
    const c = (try idx.answer(a, &svc, &ch, q)).freeform.array[0];
    try testing.expectEqualStrings("closed", c.getText("status").?);
    try testing.expect(c.get("outpoint") == null);

    // A rejected Rescind: the pool it spent is live again, no rescinded record.
    var svc2 = try e.svc(a);
    var ch2 = try e.chain(a);
    try twoSwaps(a, e, &svc2);
    try idx.admitted(a, &svc2, e.topic, rs, &.{0}, &.{0});
    try idx.spent(a, &svc2, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, rs);
    try idx.rejected(a, &svc2, e.topic, rs);
    try testing.expectEqual(@as(usize, 0), try svc2.map("rescinded").count());
    const back = (try idx.answer(a, &svc2, &ch2, q)).freeform.array[0];
    try testing.expectEqualStrings("live", back.getText("status").?);
    try testing.expectEqualStrings(try opStr(a, e.f.txid("swap_tokens_in"), 0), back.getText("outpoint").?);
}

test "byPool (0.40.0): every listed hop of a pool id, live and spent — a spend keeps it, a rejection removes the rejected transaction's" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    const pid = poolId(e);
    const member = struct {
        fn f(al: Allocator, s: *lookup.Service, t: []const u8, k: [36]u8, txid: [32]u8) !bool {
            return s.map("byPool").has(try cat(al, &.{ t, &k, &w.store.outpointKey(txid, 0) }));
        }
    }.f;
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try testing.expect(try member(a, &svc, tp, pid, e.f.txid("pool_deploy")));
    try twoSwaps(a, e, &svc); // re-admits the deploy (a dupe), then the two Swaps and their spends
    try testing.expectEqual(@as(usize, 3), try svc.map("byPool").count());
    try testing.expectEqual(@as(usize, 3), try svc.map("byValidator").count()); // byValidator too: live and spent (0.33.0)
    // Rejected: the token-in Swap's pool leaves; the spent ones stay.
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("swap_tokens_in"), e.f.tx("swap_tokens_in")));
    try testing.expect(!try member(a, &svc, tp, pid, e.f.txid("swap_tokens_in")));
    try testing.expect(try member(a, &svc, tp, pid, e.f.txid("swap_bsv_in")));
    try testing.expect(try member(a, &svc, tp, pid, e.f.txid("pool_deploy")));
    try testing.expectEqual(@as(usize, 2), try svc.map("byPool").count());
    try testing.expectEqual(@as(usize, 2), try svc.map("byValidator").count());
}

test "validator (0.33.0): {validatorIdentityKeys} sums the fee rows of all its pools, closed included; {validatorIdentityKey} still answers its live pools only" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try twoSwaps(a, e, &svc);
    const cl = try ltx(a, e.f.txid("close"), e.f.tx("close"));
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    const vs = (try idx.answer(a, &svc, &ch, try listQuery(a, e, "validatorIdentityKeys", &.{vec.identity}))).freeform.array[0];
    try testing.expectEqual(@as(u64, 10), vs.get("sats").?.uint);
    try testing.expectEqual(@as(u64, 25), vs.get("tokens").?.uint);
    try testing.expectEqual(@as(u64, 2), vs.get("swaps").?.uint);
    try testing.expectEqual(@as(u64, 1), vs.get("pools").?.uint);
    const one = try idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = vec.identity } }}));
    try testing.expectEqual(@as(usize, 0), one.freeform.array.len);
}

// ---------------------------------------------------------------- trade rows and the history reads (0.36.0)

/// The contract's Swap arithmetic (pool/Pool.runar.go Swap): the amount out of `amount_in` against
/// the reserves, the fees taken from the input first (each rounded up).
fn contractOut(amount_in: u64, lp_bps: u64, val_bps: u64, com_bps: u64, reserve_in: u64, reserve_out: u64) u64 {
    const fee = struct {
        fn f(x: u64, bps: u64) u64 {
            return (x * bps + 9999) / 10000;
        }
    }.f;
    const net = amount_in - fee(amount_in, lp_bps) - fee(amount_in, val_bps) - fee(amount_in, com_bps);
    return @intCast(@as(u128, net) * reserve_out / (reserve_in + net));
}

fn poolOf(t: bsvz.transaction.Transaction) idx.PoolFields {
    return idx.poolAt(.{0} ** 32, 0, t.outputs[0].locking_script.bytes, @intCast(t.outputs[0].satoshis)).?;
}

fn tradeRec(a: Allocator, svc: *lookup.Service, tp: []const u8, txid: [32]u8) !Value {
    return svc.store.getValue(a, (try svc.map("fees").link(try cat(a, &.{ tp, &w.store.outpointKey(w.beef.txidOf(unhex(a, vec.pool_deploy)), 0), &txid }))).?);
}

fn atKey(a: Allocator, tp: []const u8, at: u64, txid: [32]u8) ![]u8 {
    var b: [8]u8 = undefined;
    std.mem.writeInt(u64, &b, at, .big);
    return cat(a, &.{ tp, &b, &txid });
}

/// twoSwaps with the step's clock at `t1` for the sats-in Swap and `t2` for the token-in one.
fn twoSwapsAt(a: Allocator, e: *Env, svc: *lookup.Service, t1: u64, t2: u64) !void {
    const f = e.f;
    idx.now_ms = t1 - 1;
    try e.admit(a, svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    idx.now_ms = t1;
    try e.admit(a, svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, svc, e.topic, .{ .txid = f.txid("pool_deploy"), .vout = 0 }, try ltx(a, f.txid("swap_bsv_in"), f.tx("swap_bsv_in")));
    idx.now_ms = t2;
    try e.admit(a, svc, "swap_tokens_in", null, &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
    try idx.spent(a, svc, e.topic, .{ .txid = f.txid("swap_bsv_in"), .vout = 0 }, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")));
}

test "trade rows (0.36.0): a sats-in Swap writes a buy, a token-in Swap a sell — txid, LP key, amounts in and out (the contract's), the three fees, the reserves after, the step's time; under `trades` by time and `fees` by LP key, one record" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    try twoSwapsAt(a, e, &svc, 1_000, 2_000);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try testing.expectEqual(@as(usize, 2), try svc.map("trades").count());

    const p0 = poolOf(e.f.tx("pool_deploy"));
    const p1 = poolOf(e.f.tx("swap_bsv_in"));
    const p2 = poolOf(e.f.tx("swap_tokens_in"));
    const fees = .{ @as(u64, @intCast(p0.liquidity_fee_bps)), @as(u64, @intCast(p0.validation_fee_bps)), @as(u64, @intCast(p0.commission_bps)) };

    const buy = try tradeRec(a, &svc, tp, e.f.txid("swap_bsv_in"));
    try testing.expectEqualStrings("swap", buy.getText("kind").?);
    try testing.expectEqualSlices(u8, &poolId(e), buy.getBytes("poolId").?);
    try testing.expectEqual(@as(u64, 1), buy.getUint("swaps").?);
    try testing.expectEqualSlices(u8, &w.store.outpointKey(e.f.txid("swap_bsv_in"), 0), buy.getBytes("outpoint").?);
    // The call's userPkh: the taker's key hash, where the payout went (output 1, a token output).
    try testing.expectEqualSlices(u8, e.f.tx("swap_bsv_in").outputs[1].locking_script.bytes[e.f.tx("swap_bsv_in").outputs[1].locking_script.bytes.len - 22 ..][0..20], buy.getBytes("payoutPkh").?);
    try testing.expectEqualStrings("buy", buy.getText("side").?);
    try testing.expectEqualSlices(u8, &e.f.txid("swap_bsv_in"), buy.getBytes("txid").?);
    try testing.expectEqualSlices(u8, &key33(vec.lp), buy.getBytes("lpPubKey").?);
    try testing.expectEqual(@as(u64, 20_000), buy.getUint("amountIn").?);
    try testing.expectEqual(contractOut(20_000, fees[0], fees[1], fees[2], p0.bsv_reserve, p0.token_reserve), buy.getUint("amountOut").?);
    try testing.expectEqual(p0.token_reserve - p1.token_reserve, buy.getUint("amountOut").?);
    try testing.expectEqual(@as(u64, 60), buy.getUint("lp").?);
    try testing.expectEqual(@as(u64, 10), buy.getUint("validator").?);
    try testing.expectEqual(@as(u64, 20), buy.getUint("commission").?);
    try testing.expectEqual(p1.bsv_reserve, buy.getUint("bsvReserve").?);
    try testing.expectEqual(p1.token_reserve, buy.getUint("tokenReserve").?);
    try testing.expectEqual(@as(u64, 1_000), buy.getUint("at").?);
    try testing.expectEqualSlices(u8, (try svc.map("fees").link(try cat(a, &.{ tp, &poolId(e), &e.f.txid("swap_bsv_in") }))).?, (try svc.map("trades").link(try atKey(a, tp, 1_000, e.f.txid("swap_bsv_in")))).?);

    const sell = try tradeRec(a, &svc, tp, e.f.txid("swap_tokens_in"));
    try testing.expectEqualStrings("sell", sell.getText("side").?);
    try testing.expectEqual(@as(u64, 50_000), sell.getUint("amountIn").?);
    try testing.expectEqual(contractOut(50_000, fees[0], fees[1], fees[2], p1.token_reserve, p1.bsv_reserve), sell.getUint("amountOut").?);
    try testing.expectEqual(p1.bsv_reserve - p2.bsv_reserve, sell.getUint("amountOut").?);
    try testing.expectEqual(@as(u64, 150), sell.getUint("lp").?);
    try testing.expectEqual(p2.token_reserve, sell.getUint("tokenReserve").?);
    try testing.expectEqual(@as(u64, 2_000), sell.getUint("at").?);
    try testing.expect((try svc.map("trades").link(try atKey(a, tp, 2_000, e.f.txid("swap_tokens_in")))) != null);

    // A re-admission (a dupe hook call, before the spend) at a later time: one row, under the later time.
    var svc2 = try e.svc(a);
    idx.now_ms = 1;
    try e.admit(a, &svc2, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    idx.now_ms = 1_000;
    try e.admit(a, &svc2, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    idx.now_ms = 5_000;
    try e.admit(a, &svc2, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try testing.expectEqual(@as(usize, 1), try svc2.map("trades").count());
    try testing.expect((try svc2.map("trades").link(try atKey(a, tp, 5_000, e.f.txid("swap_bsv_in")))) != null);
}

test "trade rows (0.36.0): a rejected Swap's trade row leaves `trades` with its fee row; the other stays" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    try twoSwapsAt(a, e, &svc, 1_000, 2_000);
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("swap_tokens_in"), e.f.tx("swap_tokens_in")));
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try testing.expectEqual(@as(usize, 1), try svc.map("trades").count());
    try testing.expect((try svc.map("trades").link(try atKey(a, tp, 1_000, e.f.txid("swap_bsv_in")))) != null);
    try testing.expectEqual(@as(usize, 1), try svc.map("fees").count());
}

test "history (0.36.0): trades newest first — the window, the limit and the cursor, one LP key's rows, one Swap by txid" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    try twoSwapsAt(a, e, &svc, 1_000, 2_000);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    const s1 = e.f.txid("swap_bsv_in");
    const s2 = e.f.txid("swap_tokens_in");

    const all = try idx.trades(a, &svc, tp, .{});
    try testing.expectEqual(@as(usize, 2), all.len);
    try testing.expectEqualSlices(u8, &s2, &all[0].txid);
    try testing.expectEqualSlices(u8, &s1, &all[1].txid);
    // Window: from ≤ at < to.
    try testing.expectEqual(@as(usize, 1), (try idx.trades(a, &svc, tp, .{ .from = 1_500 })).len);
    try testing.expectEqual(@as(usize, 1), (try idx.trades(a, &svc, tp, .{ .to = 2_000 })).len);
    try testing.expectEqual(@as(usize, 2), (try idx.trades(a, &svc, tp, .{ .from = 1_000, .to = 2_001 })).len);
    try testing.expectEqual(@as(usize, 0), (try idx.trades(a, &svc, tp, .{ .from = 2_001 })).len);
    // Paging: one row, then the next from its cursor, then none.
    const p1 = try idx.trades(a, &svc, tp, .{ .limit = 1 });
    try testing.expectEqualSlices(u8, &s2, &p1[0].txid);
    const p2 = try idx.trades(a, &svc, tp, .{ .limit = 1, .before = .{ .at = p1[0].at, .txid = p1[0].txid } });
    try testing.expectEqualSlices(u8, &s1, &p2[0].txid);
    try testing.expectEqual(@as(usize, 0), (try idx.trades(a, &svc, tp, .{ .limit = 1, .before = .{ .at = p2[0].at, .txid = p2[0].txid } })).len);
    // One pool's rows (same order and paging; its window); an unknown pool none.
    const mine = try idx.trades(a, &svc, tp, .{ .pool = poolId(e) });
    try testing.expectEqual(@as(usize, 2), mine.len);
    try testing.expectEqualSlices(u8, &s2, &mine[0].txid);
    try testing.expectEqual(@as(usize, 1), (try idx.trades(a, &svc, tp, .{ .pool = poolId(e), .limit = 1, .before = .{ .at = 2_000, .txid = s2 } })).len);
    try testing.expectEqual(@as(usize, 1), (try idx.trades(a, &svc, tp, .{ .pool = poolId(e), .from = 1_500 })).len);
    try testing.expectEqual(@as(usize, 0), (try idx.trades(a, &svc, tp, .{ .pool = .{0xa0} ** 36 })).len);
    // One Swap by txid; a deploy has none.
    try testing.expectEqual(@as(u64, 1_000), (try idx.tradeOf(a, &svc, tp, s1)).?.at);
    try testing.expect((try idx.tradeOf(a, &svc, tp, e.f.txid("pool_deploy"))) == null);
}

/// A trade row written straight into `trades` (the candle and stats reads read only it).
fn putRow(a: Allocator, svc: *lookup.Service, tp: []const u8, at: u64, n: u8, side: []const u8, in: u64, out: u64) !void {
    var txid: [32]u8 = .{0} ** 32;
    txid[0] = n;
    const rec = try svc.store.putValue(a, .{ .map = try a.dupe(Entry, &.{
        .{ .key = "side", .value = .{ .text = side } },
        .{ .key = "amountIn", .value = .{ .uint = in } },
        .{ .key = "amountOut", .value = .{ .uint = out } },
        .{ .key = "at", .value = .{ .uint = at } },
    }) });
    try svc.map("trades").putLink(try atKey(a, tp, at, txid), rec);
}

fn expectPrice(want_sats: u64, want_tokens: u64, p: idx.Price) !void {
    try testing.expectEqual(want_sats, p.sats);
    try testing.expectEqual(want_tokens, p.tokens);
}

test "history (0.36.0): candles from the trade rows — one per non-empty bucket, aligned, open/high/low/close by price, volumes per side, counts; the window's edges; more than 5000 buckets refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    const m: u64 = 60_000;
    // Bucket [0, 1m): a buy at 2 sats/token, a sell at 3, a buy at 1. Bucket [2m, 3m): one sell at 4.
    // At exactly 1m·5 (the window's `to` below): excluded.
    try putRow(a, &svc, tp, 1_000, 1, "buy", 200, 100);
    try putRow(a, &svc, tp, 2_000, 2, "sell", 10, 30);
    try putRow(a, &svc, tp, m - 1, 3, "buy", 50, 50);
    try putRow(a, &svc, tp, 2 * m, 4, "sell", 5, 20);
    try putRow(a, &svc, tp, 5 * m, 5, "buy", 7, 7);

    const cs = try idx.candles(a, &svc, tp, m, 0, 5 * m);
    try testing.expectEqual(@as(usize, 2), cs.len);
    try testing.expectEqual(@as(u64, 0), cs[0].t);
    try expectPrice(200, 100, cs[0].o);
    try expectPrice(30, 10, cs[0].h);
    try expectPrice(50, 50, cs[0].l);
    try expectPrice(50, 50, cs[0].c);
    try testing.expectEqual(@as(u64, 200 + 30 + 50), cs[0].volume_sats);
    try testing.expectEqual(@as(u64, 100 + 10 + 50), cs[0].volume_tokens);
    try testing.expectEqual(@as(u64, 3), cs[0].n);
    try testing.expectEqual(2 * m, cs[1].t); // [1m, 2m) is empty: omitted
    try expectPrice(20, 5, cs[1].o);
    try testing.expectEqual(@as(u64, 1), cs[1].n);
    // `from` inside a bucket: trades before it are out, the bucket still starts aligned.
    const late = try idx.candles(a, &svc, tp, m, 1_500, 6 * m);
    try testing.expectEqual(@as(usize, 3), late.len);
    try testing.expectEqual(@as(u64, 0), late[0].t);
    try testing.expectEqual(@as(u64, 2), late[0].n);
    try testing.expectEqual(5 * m, late[2].t);
    // One resolution up: every row of [0, 1h) in one candle.
    const hour = try idx.candles(a, &svc, tp, 60 * m, 0, 60 * m);
    try testing.expectEqual(@as(usize, 1), hour.len);
    try testing.expectEqual(@as(u64, 5), hour[0].n);
    try expectPrice(7, 7, hour[0].c);
    // 5000 buckets is the most.
    _ = try idx.candles(a, &svc, tp, m, 0, 5000 * m);
    try testing.expectError(error.TooManyBuckets, idx.candles(a, &svc, tp, m, 0, 5000 * m + 1));
    try testing.expectError(error.TooManyBuckets, idx.candles(a, &svc, tp, m, 30_000, 5000 * m + 30_000));
}

test "history (0.36.0; 0.40.0): stats — the last trade's price (lastTradePrice), the changes from the prices at the windows' starts in bps, 24 h volumes and counts, the live pools' TVL; null changes without a trade that old; no trade, no price" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    const now: u64 = 10 * idx.day_ms;

    // Nothing at all: no price, no changes.
    const none = try idx.stats(a, &svc, tp, now);
    try testing.expect(none.last_trade_price == null and none.change1h == null and none.change24h == null and none.last_trade_at == null);
    try testing.expectEqual(@as(u64, 0), none.pools);

    // A live pool, no trade: no last trade price (0.40.0: the host prices from the pools).
    idx.now_ms = 1;
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    const p0 = poolOf(e.f.tx("pool_deploy"));
    const only_pool = try idx.stats(a, &svc, tp, now);
    try testing.expect(only_pool.last_trade_price == null);
    try testing.expectEqual(@as(u64, 1), only_pool.pools);
    try testing.expectEqual(p0.bsv_reserve, only_pool.tvl_sats);
    try testing.expectEqual(p0.token_reserve, only_pool.tvl_tokens);
    try testing.expect(only_pool.change24h == null);

    // Trades within the last hour only: no trade at either window's start.
    try putRow(a, &svc, tp, now - 30 * 60_000, 1, "buy", 200, 100); // 2
    try putRow(a, &svc, tp, now - 10 * 60_000, 2, "sell", 10, 30); // 3
    const recent = try idx.stats(a, &svc, tp, now);
    try expectPrice(30, 10, recent.last_trade_price.?);
    try testing.expect(recent.change1h == null and recent.change24h == null);
    try testing.expectEqual(@as(u64, 230), recent.volume24h_sats);
    try testing.expectEqual(@as(u64, 110), recent.volume24h_tokens);
    try testing.expectEqual(@as(u64, 1), recent.buys24h);
    try testing.expectEqual(@as(u64, 1), recent.sells24h);
    try testing.expectEqual(now - 10 * 60_000, recent.last_trade_at.?);

    // A trade 2 h ago (price 2.4) and one 2 days ago (price 1.5): the changes against them; the
    // 2-day-old one is out of the 24 h volume.
    try putRow(a, &svc, tp, now - 2 * idx.hour_ms, 3, "buy", 24, 10);
    try putRow(a, &svc, tp, now - 2 * idx.day_ms, 4, "sell", 10, 15);
    const s = try idx.stats(a, &svc, tp, now);
    try testing.expectEqual(@as(i64, 2500), s.change1h.?); // 2.4 → 3: +25 %
    try testing.expectEqual(@as(i64, 10000), s.change24h.?); // 1.5 → 3: +100 %
    try testing.expectEqual(@as(u64, 230 + 24), s.volume24h_sats);
    try testing.expectEqual(@as(u64, 2), s.buys24h);
    try testing.expectEqual(@as(u64, 1), s.sells24h);
    // A fall, truncated toward zero.
    try testing.expectEqual(@as(i64, -3333), idx.changeBps(.{ .sats = 3, .tokens = 1 }, .{ .sats = 2, .tokens = 1 }));
}

// ---------------------------------------------------------------- the pool id and the pool history (0.40.0)

/// `pool_deploy` at `t0`, `swap_bsv_in` at `t1`, `swap_tokens_in` at `t2`, each with its spend.
fn threeEvents(a: Allocator, e: *Env, svc: *lookup.Service, t0: u64, t1: u64, t2: u64) !void {
    const f = e.f;
    idx.now_ms = t0;
    try e.admit(a, svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    idx.now_ms = t1;
    try e.admit(a, svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, svc, e.topic, .{ .txid = f.txid("pool_deploy"), .vout = 0 }, try ltx(a, f.txid("swap_bsv_in"), f.tx("swap_bsv_in")));
    idx.now_ms = t2;
    try e.admit(a, svc, "swap_tokens_in", null, &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
    try idx.spent(a, svc, e.topic, .{ .txid = f.txid("swap_bsv_in"), .vout = 0 }, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")));
}

fn kinds(a: Allocator, evs: []const idx.Event) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (evs) |ev| {
        const k: []const u8 = ev.rec.getText("kind") orelse "?";
        try out.append(a, k[0]);
    }
    return out.items;
}

fn recordAt(a: Allocator, svc: *lookup.Service, tp: []const u8, map: []const u8, txid: [32]u8) !Value {
    return svc.store.getValue(a, (try svc.map(map).link(try cat(a, &.{ tp, &w.store.outpointKey(txid, 0) }))).?);
}

test "pool id (0.40.0): the deploy's outpoint, copied forward at each Swap with the swap count; one event per deploy and Swap under `history`, linked with the trade row" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 2_000);
    const pid = poolId(e);
    // The hops: spent ones in spentPools, the live one in pools; each the deploy's id, swaps 0, 1, 2.
    const r0 = try recordAt(a, &svc, tp, "spentPools", e.f.txid("pool_deploy"));
    const r1 = try recordAt(a, &svc, tp, "spentPools", e.f.txid("swap_bsv_in"));
    const r2 = try recordAt(a, &svc, tp, "pools", e.f.txid("swap_tokens_in"));
    for ([_]Value{ r0, r1, r2 }, 0..) |r, n| {
        try testing.expectEqualSlices(u8, &pid, r.getBytes("poolId").?);
        try testing.expectEqual(@as(u64, n), r.getUint("swaps").?);
    }
    try testing.expectEqual(@as(u64, 100), r0.getUint("admittedAt").?);
    try testing.expectEqual(@as(u64, 2_000), r2.getUint("admittedAt").?);
    // history: tp ‖ poolId ‖ at ‖ swaps, in that order: deploy, swap, swap.
    const evs = try histOf(a, &svc, tp, null, null, pid, 500);
    try testing.expectEqualStrings("dss", try kinds(a, evs));
    try testing.expectEqual(@as(u64, 100), evs[0].at);
    try testing.expectEqual(@as(u64, 2), evs[2].seq);
    try testing.expectEqualSlices(u8, &e.f.txid("pool_deploy"), evs[0].rec.getBytes("txid").?);
    try testing.expectEqualSlices(u8, &w.store.outpointKey(e.f.txid("pool_deploy"), 0), evs[0].rec.getBytes("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool0.bsv), evs[0].rec.getUint("bsvReserve").?);
    try testing.expectEqualSlices(u8, &key33(vec.lp), evs[0].rec.getBytes("lpPubKey").?);
    // A Swap's event IS its trade row: one record under history, fees and trades.
    const fee = (try svc.map("fees").link(try cat(a, &.{ tp, &pid, &e.f.txid("swap_bsv_in") }))).?;
    try testing.expectEqualSlices(u8, fee, (try svc.map("history").link(try cat(a, &.{ tp, &pid, &be64t(1_000), &be64t(1) }))).?);
    try testing.expectEqualSlices(u8, fee, (try svc.map("trades").link(try atKey(a, tp, 1_000, e.f.txid("swap_bsv_in")))).?);
    try testing.expectEqual(@as(usize, 0), try svc.map("closes").count());
}

fn be64t(n: u64) [8]u8 {
    var b: [8]u8 = undefined;
    std.mem.writeInt(u64, &b, n, .big);
    return b;
}

test "pool history (0.40.0): a close is written in `spent` when the spender continues nothing — under `history` and `closes`; its rejection removes both and the pool is live again" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 2_000);
    const pid = poolId(e);
    const cl = try ltx(a, e.f.txid("close"), e.f.tx("close"));
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    const evs = try histOf(a, &svc, tp, null, null, pid, 500);
    try testing.expectEqualStrings("dssc", try kinds(a, evs));
    const c = evs[3].rec;
    try testing.expectEqualSlices(u8, &e.f.txid("close"), c.getBytes("txid").?);
    try testing.expectEqual(@as(u64, 2), c.getUint("swaps").?);
    try testing.expect(c.get("outpoint") == null and c.get("bsvReserve") == null);
    try testing.expectEqualSlices(u8, &key33(vec.lp), c.getBytes("lpPubKey").?);
    try testing.expect((try svc.map("closes").link(try cat(a, &.{ tp, &be64t(3_000), &pid }))) != null);
    // Rejected: the close rows go, the pool is live again.
    try idx.rejected(a, &svc, e.topic, cl);
    try testing.expectEqualStrings("dss", try kinds(a, try histOf(a, &svc, tp, null, null, pid, 500)));
    try testing.expectEqual(@as(usize, 0), try svc.map("closes").count());
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
}

test "pool history (0.40.0): a Rescind stores its output in `pools` with swaps the next count and that sequence; the LP's Close of it writes a close; its rejection removes both" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 2_000);
    const pid = poolId(e);
    const rs = try ltx(a, e.f.txid("rescind"), e.f.tx("rescind"));
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc, e.topic, rs, &.{0}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, rs);
    const r = try recordAt(a, &svc, tp, "pools", e.f.txid("rescind"));
    try testing.expectEqualSlices(u8, &pid, r.getBytes("poolId").?);
    try testing.expectEqual(@as(u64, 3), r.getUint("swaps").?);
    try testing.expect(std.mem.allEqual(u8, r.getBytes("validatorPubKey").?, 0));
    try testing.expectEqualSlices(u8, &key33(vec.identity), r.getBytes("validatorIdentityKey").?);
    const evs = try histOf(a, &svc, tp, null, null, pid, 500);
    try testing.expectEqualStrings("dssr", try kinds(a, evs));
    try testing.expectEqual(@as(u64, 3), evs[3].seq);
    try testing.expectEqualSlices(u8, &w.store.outpointKey(e.f.txid("rescind"), 0), evs[3].rec.getBytes("outpoint").?);
    try testing.expectEqual(@as(usize, 1), try svc.map("closes").count());
    // The scan after the spent Swap is the rescind only. After the rescind output, the page is empty.
    const spent = try recordAt(a, &svc, tp, "spentPools", e.f.txid("swap_tokens_in"));
    const after_swap = try idx.poolHistory(a, &svc, tp, null, null, null, 500, try idx.cursorOf(spent));
    try testing.expectEqualStrings("r", try kinds(a, after_swap.events));
    const after_rescind = try idx.poolHistory(a, &svc, tp, null, null, null, 500, try idx.cursorOf(r));
    try testing.expectEqual(@as(usize, 0), after_rescind.events.len);
    // The LP's Close of the rescinded output writes the close.
    const cr = try ltx(a, e.f.txid("close_rescinded"), e.f.tx("close_rescinded"));
    idx.now_ms = 4_000;
    try idx.admitted(a, &svc, e.topic, cr, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("rescind"), .vout = 0 }, cr);
    try testing.expectEqualStrings("dssrc", try kinds(a, try histOf(a, &svc, tp, null, null, pid, 500)));
    // A rejected Rescind (a fresh index): the rescind rows go.
    var svc2 = try e.svc(a);
    try threeEvents(a, e, &svc2, 100, 1_000, 2_000);
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc2, e.topic, rs, &.{0}, &.{0});
    try idx.spent(a, &svc2, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, rs);
    try idx.rejected(a, &svc2, e.topic, rs);
    try testing.expectEqualStrings("dss", try kinds(a, try histOf(a, &svc2, tp, null, null, pid, 500)));
    try testing.expectEqual(@as(usize, 0), try svc2.map("closes").count());
    try testing.expectEqual(@as(usize, 0), try svc2.map("rescinded").count());
}

test "pool history (0.40.0): a rejected Swap's event and a rejected deploy's event go with their pools" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 2_000);
    const pid = poolId(e);
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("swap_tokens_in"), e.f.tx("swap_tokens_in")));
    try testing.expectEqualStrings("ds", try kinds(a, try histOf(a, &svc, tp, null, null, pid, 500)));
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("swap_bsv_in"), e.f.tx("swap_bsv_in")));
    try idx.rejected(a, &svc, e.topic, try ltx(a, e.f.txid("pool_deploy"), e.f.tx("pool_deploy")));
    try testing.expectEqual(@as(usize, 0), try svc.map("history").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("trades").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("fees").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("byPool").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("pools").count());
}

test "pools at t (0.40.0): before the deploy none; at and after the deploy the deploy's state; between the Swaps the first Swap's; at and after the close none — the candidates the live pools and the closes from t on" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 2_000);
    try testing.expectEqual(@as(usize, 0), (try idx.poolsAt(a, &svc, tp, 99)).len);
    const at0 = try idx.poolsAt(a, &svc, tp, 100);
    try testing.expectEqual(@as(usize, 1), at0.len);
    try testing.expectEqualStrings("deploy", at0[0].getText("kind").?);
    try testing.expectEqual(@as(u64, vec.pool0.bsv), at0[0].getUint("bsvReserve").?);
    const mid = try idx.poolsAt(a, &svc, tp, 1_999);
    try testing.expectEqualSlices(u8, &e.f.txid("swap_bsv_in"), mid[0].getBytes("txid").?);
    try testing.expectEqual(@as(u64, vec.pool1.bsv), mid[0].getUint("bsvReserve").?);
    try testing.expectEqual(@as(u64, 1), mid[0].getUint("swaps").?);
    try testing.expectEqual(@as(u64, 2), (try idx.poolsAt(a, &svc, tp, 50_000))[0].getUint("swaps").?);
    // Closed at 3,000: listed at 2,999, not at 3,000 or after; the pool is no longer live, found
    // through `closes`.
    const cl = try ltx(a, e.f.txid("close"), e.f.tx("close"));
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    try testing.expectEqual(@as(usize, 0), try svc.map("pools").count());
    try testing.expectEqual(@as(usize, 1), (try idx.poolsAt(a, &svc, tp, 2_999)).len);
    try testing.expectEqual(@as(usize, 1), (try idx.poolsAt(a, &svc, tp, 150)).len);
    try testing.expectEqual(@as(usize, 0), (try idx.poolsAt(a, &svc, tp, 3_000)).len);
    try testing.expectEqual(@as(usize, 0), (try idx.poolsAt(a, &svc, tp, 9_000)).len);
}

test "pool history (0.40.0): rows at one time sort by the pool's swap count (two Swaps in one ms); the window [from, to), a pool or every pool the window touches, the limit (the oldest)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 1_000);
    const pid = poolId(e);
    const evs = try histOf(a, &svc, tp, null, null, null, 500);
    try testing.expectEqualStrings("dss", try kinds(a, evs));
    try testing.expectEqual(@as(u64, 1), evs[1].seq);
    try testing.expectEqual(@as(u64, 2), evs[2].seq);
    try testing.expectEqualSlices(u8, &e.f.txid("swap_bsv_in"), evs[1].rec.getBytes("txid").?);
    try testing.expectEqualSlices(u8, &e.f.txid("swap_tokens_in"), evs[2].rec.getBytes("txid").?);
    // The window: from ≤ at < to.
    try testing.expectEqualStrings("ss", try kinds(a, try histOf(a, &svc, tp, 101, null, null, 500)));
    try testing.expectEqualStrings("d", try kinds(a, try histOf(a, &svc, tp, null, 1_000, pid, 500)));
    try testing.expectEqualStrings("dss", try kinds(a, try histOf(a, &svc, tp, 100, 1_001, pid, 500)));
    try testing.expectEqual(@as(usize, 0), (try histOf(a, &svc, tp, 1_001, null, null, 500)).len);
    try testing.expectEqual(@as(usize, 0), (try histOf(a, &svc, tp, null, null, .{0xa0} ** 36, 500)).len);
    // The limit keeps the oldest.
    try testing.expectEqualStrings("ds", try kinds(a, try histOf(a, &svc, tp, null, null, null, 2)));
    // The trades of one ms: both, the newest (by txid in `trades`) first.
    try testing.expectEqual(@as(usize, 2), (try idx.trades(a, &svc, tp, .{ .from = 1_000, .to = 1_001 })).len);
}

/// `idx.poolHistory`'s events, from the first page.
fn histOf(a: Allocator, svc: *lookup.Service, tp: []const u8, from: ?u64, to: ?u64, pid: ?[36]u8, limit: usize) ![]const idx.Event {
    return (try idx.poolHistory(a, svc, tp, from, to, pid, limit, null)).events;
}

test "pool history (0.40.0): a Swap and the pool's close at the same ms — both rows, the close after (its sequence the swap count + 1); /pools/at then gives no row; rejecting the close makes the Swap the floor again" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 2_000);
    const pid = poolId(e);
    const cl = try ltx(a, e.f.txid("close"), e.f.tx("close"));
    idx.now_ms = 2_000; // the last Swap's time
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    const evs = try histOf(a, &svc, tp, null, null, pid, 500);
    try testing.expectEqualStrings("dssc", try kinds(a, evs));
    try testing.expectEqual(@as(u64, 2), evs[2].seq);
    try testing.expectEqual(@as(u64, 3), evs[3].seq);
    try testing.expectEqual(@as(u64, 2), evs[3].rec.getUint("swaps").?); // the record's swap count unchanged
    try testing.expect((try svc.map("history").link(try cat(a, &.{ tp, &pid, &be64t(2_000), &be64t(2) }))) != null);
    try testing.expectEqual(@as(usize, 0), (try idx.poolsAt(a, &svc, tp, 2_000)).len);
    try idx.rejected(a, &svc, e.topic, cl);
    const back = try idx.poolsAt(a, &svc, tp, 2_000);
    try testing.expectEqual(@as(usize, 1), back.len);
    try testing.expectEqualSlices(u8, &e.f.txid("swap_tokens_in"), back[0].getBytes("txid").?);
    try testing.expectEqualStrings("dss", try kinds(a, try histOf(a, &svc, tp, null, null, pid, 500)));
}

test "pool history (0.40.0): forward paging — a window larger than the limit, read page by page with `after`, gives every event exactly once, in order; the same over one pool; within from/to" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    try threeEvents(a, e, &svc, 100, 1_000, 1_000);
    const cl = try ltx(a, e.f.txid("close"), e.f.tx("close"));
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = e.f.txid("swap_tokens_in"), .vout = 0 }, cl);
    const all = try histOf(a, &svc, tp, null, null, null, 500);
    try testing.expectEqualStrings("dssc", try kinds(a, all));
    for ([_]?[36]u8{ null, poolId(e) }) |one| for ([_]usize{ 1, 2, 3 }) |limit| {
        var got: std.ArrayList(idx.Event) = .empty;
        var after: ?idx.EventCursor = null;
        var pages: usize = 0;
        while (true) : (pages += 1) {
            const pg = try idx.poolHistory(a, &svc, tp, null, null, one, limit, after);
            try got.appendSlice(a, pg.events);
            if (!pg.more) break;
            const last = pg.events[pg.events.len - 1];
            after = .{ .at = last.at, .pid = last.pid, .seq = last.seq };
            try testing.expect(pages < 10);
        }
        try testing.expectEqual(all.len, got.items.len);
        for (all, got.items) |x, y| {
            try testing.expectEqual(x.at, y.at);
            try testing.expectEqual(x.seq, y.seq);
        }
    };
    // Within the window: after the deploy, to 3,000 — the two Swaps, then no more.
    const first = (try idx.poolHistory(a, &svc, tp, null, 3_000, null, 1, null)).events[0];
    const pg = try idx.poolHistory(a, &svc, tp, null, 3_000, null, 2, .{ .at = first.at, .pid = first.pid, .seq = first.seq });
    try testing.expectEqualStrings("ss", try kinds(a, pg.events));
    try testing.expect(!pg.more);
}

// ---------------------------------------------------------------- pool events (0.41.0)

/// The pool events the hooks asked for since the last call (`Service.emit`), cleared.
fn takeEvents(svc: *lookup.Service) []const Value {
    const out = svc.events.items;
    svc.events = .empty;
    return out;
}

/// An emitted pool event: `{event: "pool", topic: "ls_amm_<tokenId>", tokenId, row}`; → its row.
fn poolEvent(e: *Env, ev: Value) !Value {
    try testing.expectEqualStrings("pool", ev.getText("event").?);
    try testing.expectEqualStrings(e.token, ev.getText("tokenId").?);
    var buf: [128]u8 = undefined;
    try testing.expectEqualStrings(try std.fmt.bufPrint(&buf, "ls_amm_{s}", .{e.token}), ev.getText("topic").?);
    return ev.get("row").?;
}

/// No bytes anywhere in a row: text and numbers only.
fn plainRow(row: Value) !void {
    for (row.map) |en| switch (en.value) {
        .text, .uint, .nint => {},
        else => return error.TestUnexpectedResult,
    };
}

/// The row an event carries is the row `/pools/history` reads (`eventRow` of the history record), byte
/// for byte (dag-cbor).
fn sameAsHistory(a: Allocator, svc: *lookup.Service, tp: []const u8, pid: [36]u8, i: usize, row: Value) !void {
    const evs = try histOf(a, svc, tp, null, null, pid, 500);
    try testing.expectEqualSlices(u8, try cbor.encode(a, try idx.eventRow(a, evs[i].rec)), try cbor.encode(a, row));
}

test "pool events (0.41.0): one event per history row written — deploy, swap, close, rescind — its row the history row; a rejection of each, one revert per pool with the pool after the undo (none for a deploy)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const tp = try w.store.nameKey(a, e.topic, &.{});
    const f = e.f;
    const pid = poolId(e);
    const pid_text = try poolIdText(a, e);

    // The deploy: one event, kind deploy, the row as /pools/history reads it.
    idx.now_ms = 100;
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    var evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    var row = try poolEvent(e, evs[0]);
    try plainRow(row);
    try testing.expectEqualStrings("deploy", row.getText("kind").?);
    try testing.expectEqualStrings(pid_text, row.getText("poolId").?);
    try testing.expectEqualStrings(pid_text, row.getText("outpoint").?);
    try testing.expectEqualStrings(&w.header.toHex(f.txid("pool_deploy")), row.getText("txid").?);
    try testing.expectEqual(@as(u64, 100), row.getUint("at").?);
    try testing.expectEqual(@as(u64, 0), row.getUint("swaps").?);
    try sameAsHistory(a, &svc, tp, pid, 0, row);

    // A Swap: one event (its `spent` writes none: the pool continues), kind swap with the trade fields.
    idx.now_ms = 1_000;
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = f.txid("pool_deploy"), .vout = 0 }, try ltx(a, f.txid("swap_bsv_in"), f.tx("swap_bsv_in")));
    evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try plainRow(row);
    try testing.expectEqualStrings("swap", row.getText("kind").?);
    try testing.expectEqualStrings("buy", row.getText("side").?);
    try testing.expectEqual(@as(u64, 1), row.getUint("swaps").?);
    try testing.expect(row.getText("payoutPkh") != null and row.getText("commissionPkh") != null and row.getUint("amountOut") != null);
    try sameAsHistory(a, &svc, tp, pid, 1, row);
    idx.now_ms = 2_000;
    try e.admit(a, &svc, "swap_tokens_in", null, &.{ 0, 2, 3, 4 }, &.{ 0, 1 });
    try idx.spent(a, &svc, e.topic, .{ .txid = f.txid("swap_bsv_in"), .vout = 0 }, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")));
    evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    try testing.expectEqualStrings("sell", (try poolEvent(e, evs[0])).getText("side").?);

    // A close: one event, no outpoint, no reserves.
    const cl = try ltx(a, f.txid("close"), f.tx("close"));
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc, e.topic, cl, &.{1}, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = f.txid("swap_tokens_in"), .vout = 0 }, cl);
    evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try testing.expectEqualStrings("close", row.getText("kind").?);
    try testing.expect(row.get("outpoint") == null and row.get("bsvReserve") == null);
    try sameAsHistory(a, &svc, tp, pid, 3, row);

    // The close rejected: one revert, the pool as it stands after the undo — live again at the last
    // Swap's output, its reserves and swap count; `at` the step's time.
    idx.now_ms = 3_500;
    try idx.rejected(a, &svc, e.topic, cl);
    evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try plainRow(row);
    try testing.expectEqualStrings("revert", row.getText("kind").?);
    try testing.expectEqualStrings(&w.header.toHex(f.txid("close")), row.getText("txid").?);
    try testing.expectEqualStrings(pid_text, row.getText("poolId").?);
    try testing.expectEqualStrings(try opStr(a, f.txid("swap_tokens_in"), 0), row.getText("outpoint").?);
    try testing.expectEqual(@as(u64, 2), row.getUint("swaps").?);
    try testing.expectEqual(@as(u64, 3_500), row.getUint("at").?);
    const live = try recordAt(a, &svc, tp, "pools", f.txid("swap_tokens_in"));
    try testing.expectEqual(live.getUint("bsvReserve").?, row.getUint("bsvReserve").?);
    try testing.expectEqual(live.getUint("tokenReserve").?, row.getUint("tokenReserve").?);
    try testing.expect(row.getText("lpPubKey") != null and row.getText("validatorIdentityKey") != null and row.get("commissionBps") != null);

    // A Swap rejected: one revert (its continuation gone, the pool it spent live again).
    try idx.rejected(a, &svc, e.topic, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")));
    evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try testing.expectEqualStrings("revert", row.getText("kind").?);
    try testing.expectEqualStrings(try opStr(a, f.txid("swap_bsv_in"), 0), row.getText("outpoint").?);
    try testing.expectEqual(@as(u64, 1), row.getUint("swaps").?);

    // The deploy rejected (its Swap first): the last revert has no pool left — kind, txid, poolId, at only.
    try idx.rejected(a, &svc, e.topic, try ltx(a, f.txid("swap_bsv_in"), f.tx("swap_bsv_in")));
    _ = takeEvents(&svc);
    try idx.rejected(a, &svc, e.topic, try ltx(a, f.txid("pool_deploy"), f.tx("pool_deploy")));
    evs = takeEvents(&svc);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try testing.expectEqualStrings("revert", row.getText("kind").?);
    try testing.expectEqual(@as(usize, 4), row.map.len);
    try testing.expectEqualStrings(pid_text, row.getText("poolId").?);
    try testing.expectEqualStrings(&w.header.toHex(f.txid("pool_deploy")), row.getText("txid").?);

    // A Rescind (a fresh index): one rescind event (none from its `spent`); rejected, one revert with
    // the pool live again.
    var svc2 = try e.svc(a);
    try threeEvents(a, e, &svc2, 100, 1_000, 2_000);
    _ = takeEvents(&svc2);
    const rs = try ltx(a, f.txid("rescind"), f.tx("rescind"));
    idx.now_ms = 3_000;
    try idx.admitted(a, &svc2, e.topic, rs, &.{0}, &.{0});
    try idx.spent(a, &svc2, e.topic, .{ .txid = f.txid("swap_tokens_in"), .vout = 0 }, rs);
    evs = takeEvents(&svc2);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try testing.expectEqualStrings("rescind", row.getText("kind").?);
    try testing.expectEqualStrings(try opStr(a, f.txid("rescind"), 0), row.getText("outpoint").?);
    try sameAsHistory(a, &svc2, tp, pid, 3, row);
    try idx.rejected(a, &svc2, e.topic, rs);
    evs = takeEvents(&svc2);
    try testing.expectEqual(@as(usize, 1), evs.len);
    row = try poolEvent(e, evs[0]);
    try testing.expectEqualStrings("revert", row.getText("kind").?);
    try testing.expectEqualStrings(try opStr(a, f.txid("swap_tokens_in"), 0), row.getText("outpoint").?);
}
