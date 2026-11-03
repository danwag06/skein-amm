//! amm-setup's decisions, natively (0.22.0, shruggr/skein-amm#5): the deploy read from the event's
//! BEEF (a BRC-162 deploy at output 0, a legacy BRC-161 deploy at output 1), the names derived, the
//! token record, the registrations, the refusals, the /token read, and the manifest's rows.
const std = @import("std");
const w = @import("chain");
const setup = @import("src/setup.zig");
const deploy = @import("deploy");
const vec = @import("vectors");
const manifest = @import("app_manifest").json;

const testing = std.testing;
const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;

fn unhex(a: Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

/// An Atomic BEEF of one raw transaction (no proof: the door's business, not this program's).
fn atomic(a: Allocator, raw: []const u8) ![]u8 {
    const txid = w.beef.txidOf(raw);
    var entries = [_]w.beef.Entry{.{ .txid = txid, .format = .raw, .raw = raw }};
    return w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = txid, .bumps = &.{}, .entries = &entries });
}

/// A bare BEEF V2 of one raw transaction (its subject the last transaction).
fn bare(a: Allocator, raw: []const u8) ![]u8 {
    const txid = w.beef.txidOf(raw);
    var entries = [_]w.beef.Entry{.{ .txid = txid, .format = .raw, .raw = raw }};
    return w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = &entries });
}

fn txidHex(a: Allocator, raw: []const u8) ![]const u8 {
    return a.dupe(u8, &w.header.toHex(w.beef.txidOf(raw)));
}

fn mapOf(a: Allocator, es: []const cbor.Entry) !Value {
    return .{ .map = try a.dupe(cbor.Entry, es) };
}

test "the deploy in the event's BEEF: a BRC-162 deploy at output 0 — the token id, topic, lookups, display fields, txid and vout" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = unhex(a, vec.token_deploy);
    const txid = try txidHex(a, raw);
    for ([_][]const u8{ try atomic(a, raw), try bare(a, raw) }) |b| {
        const d = (try deploy.deployIn(a, b)).ok;
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{txid}), d.token_id);
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_color_{s}_0", .{txid}), d.topic);
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "ls_color_{s}_0", .{txid}), d.lookup);
        try testing.expectEqualStrings(txid, d.txid);
        try testing.expectEqual(@as(u32, 0), d.vout);
        // The same as amm-config's enable reads it by its token id.
        const by_id = (try deploy.deployOf(a, d.token_id, b)).ok;
        try testing.expectEqualStrings(by_id.token_id, d.token_id);
        try testing.expectEqualStrings(by_id.sym, d.sym);
        try testing.expectEqual(by_id.dec, d.dec);
    }
}

test "the deploy in the event's BEEF: a legacy BRC-161 deploy at output 1 (output 0 a plain payment) — <txid>_1" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = unhex(a, vec.legacy_deploy1);
    const txid = try txidHex(a, raw);
    const d = (try deploy.deployIn(a, try atomic(a, raw))).ok;
    try testing.expectEqual(@as(u32, 1), d.vout);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_1", .{txid}), d.token_id);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_color_{s}_1", .{txid}), d.topic);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "ls_color_{s}_1", .{txid}), d.lookup);
    try testing.expect(d.sym.len > 0);
    // A legacy deploy at output 0 too.
    const raw0 = unhex(a, vec.legacy_deploy0);
    const d0 = (try deploy.deployIn(a, try atomic(a, raw0))).ok;
    try testing.expectEqual(@as(u32, 0), d0.vout);
}

test "no deploy: a subject that deploys nothing (the funding, a token transfer), not a BEEF — refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expect((try deploy.deployIn(a, try atomic(a, unhex(a, vec.fund)))) == .refused);
    try testing.expect((try deploy.deployIn(a, try atomic(a, unhex(a, vec.legacy_transfer)))) == .refused);
    try testing.expect((try deploy.deployIn(a, "junk")) == .refused);
}

test "the event: refused when the instance has its token, the record is not a deploy event, or carries no door envelope" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ptr = "\x01\x71\x12\x20" ++ "\x11" ** 32;
    const env = try mapOf(a, &.{ .{ .key = "form", .value = .{ .text = "atomic" } }, .{ .key = "beef", .value = .{ .cid = ptr } } });
    const good = try mapOf(a, &.{ .{ .key = "kind", .value = .{ .text = "deploy" } }, .{ .key = "beef", .value = env } });
    try testing.expect(setup.eventOf(good, false) == .envelope);
    try testing.expectEqualStrings("this instance has its token: amm/token is written once", setup.eventOf(good, true).refused);
    const other = try mapOf(a, &.{ .{ .key = "kind", .value = .{ .text = "transfer" } }, .{ .key = "beef", .value = env } });
    try testing.expect(setup.eventOf(other, false) == .refused);
    const none = try mapOf(a, &.{.{ .key = "kind", .value = .{ .text = "deploy" } }});
    try testing.expectEqualStrings("the deploy event carries no BEEF", setup.eventOf(none, false).refused);
    const raw = try mapOf(a, &.{ .{ .key = "kind", .value = .{ .text = "deploy" } }, .{ .key = "beef", .value = .{ .bytes = "\x01\x00\xbe\xef" } } });
    try testing.expect(setup.eventOf(raw, false) == .refused);
}

test "the token record and the registrations: {tokenId, topic, lookup, ammLookup, sym, dec, txid, vout}; register (seeded), registerLookup ×2 over the topic" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = unhex(a, vec.token_deploy);
    const txid = try txidHex(a, raw);
    const d = (try deploy.deployIn(a, try atomic(a, raw))).ok;
    const rec = try setup.tokenRecord(a, d);
    const keys = [_][]const u8{ "tokenId", "topic", "lookup", "ammLookup", "sym", "dec", "txid", "vout" };
    try testing.expectEqual(keys.len, rec.map.len); // no icon in this deploy
    for (keys, rec.map) |k, e| try testing.expectEqualStrings(k, e.key);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "ls_amm_{s}_0", .{txid}), rec.getText("ammLookup").?);
    try testing.expectEqualStrings(txid, rec.getText("txid").?);
    // With an icon: `icon` after `dec`.
    var di = d;
    di.icon = "data:image/png;base64,AA==";
    const reci = try setup.tokenRecord(a, di);
    try testing.expectEqualStrings("icon", reci.map[6].key);

    const regs = try setup.registrations(a, d);
    try testing.expectEqualStrings("register", regs[0].func);
    try testing.expectEqualStrings(d.topic, regs[0].arg.getText("topic").?);
    try testing.expectEqualStrings("color-topic", regs[0].arg.getText("program").?);
    try testing.expectEqualStrings(txid, regs[0].arg.getArray("seed").?[0].text);
    try testing.expectEqualStrings("registerLookup", regs[1].func);
    try testing.expectEqualStrings(d.lookup, regs[1].arg.getText("service").?);
    try testing.expectEqualStrings("color-lookup", regs[1].arg.getText("program").?);
    try testing.expectEqualStrings(d.topic, regs[1].arg.getArray("topics").?[0].text);
    try testing.expectEqualStrings("registerLookup", regs[2].func);
    try testing.expectEqualStrings(rec.getText("ammLookup").?, regs[2].arg.getText("service").?);
    try testing.expectEqualStrings("amm-lookup", regs[2].arg.getText("program").?);
    try testing.expectEqualStrings(d.topic, regs[2].arg.getArray("topics").?[0].text);
    // Each program a role of the app (the manifest's `programs`).
    var parsed = try std.json.parseFromSlice(std.json.Value, a, manifest, .{});
    defer parsed.deinit();
    for (regs) |r| try testing.expect(parsed.value.object.get("programs").?.object.get(r.arg.getText("program").?) != null);
}

test "the engine's answers: {fn, result} taken, {fn, error} a refusal (the step fails); seeded or not" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const tx = "ab" ** 32;
    const ok = try mapOf(a, &.{ .{ .key = "fn", .value = .{ .text = "register" } }, .{ .key = "result", .value = try mapOf(a, &.{
        .{ .key = "topic", .value = .{ .text = "tm_x" } },
        .{ .key = "active", .value = .{ .boolean = true } },
        .{ .key = "seeded", .value = .{ .array = try a.dupe(Value, &.{.{ .text = tx }}) } },
        .{ .key = "missing", .value = .{ .array = &.{} } },
    }) } });
    try testing.expect((try setup.refusalOf(a, "register", ok)) == null);
    try testing.expect(setup.seeded(ok, tx));
    const missing = try mapOf(a, &.{ .{ .key = "fn", .value = .{ .text = "register" } }, .{ .key = "result", .value = try mapOf(a, &.{
        .{ .key = "seeded", .value = .{ .array = &.{} } },
        .{ .key = "missing", .value = .{ .array = try a.dupe(Value, &.{.{ .text = tx }}) } },
    }) } });
    try testing.expect(!setup.seeded(missing, tx));
    const bad = try mapOf(a, &.{ .{ .key = "fn", .value = .{ .text = "register" } }, .{ .key = "error", .value = try mapOf(a, &.{
        .{ .key = "code", .value = .{ .text = "bad-args" } },
        .{ .key = "message", .value = .{ .text = "register: program nope is not a role in programs" } },
    }) } });
    try testing.expectEqualStrings("register refused by the engine: register: program nope is not a role in programs", (try setup.refusalOf(a, "register", bad)).?);
    // The submission's body, as the validator's.
    const sb = try setup.submitBody(a, "BEEF", "tm_x");
    try testing.expectEqualStrings("submit", sb.getText("fn").?);
    try testing.expectEqualStrings("BEEF", sb.get("args").?.getBytes("beef").?);
    try testing.expectEqualStrings("tm_x", sb.get("args").?.getArray("topics").?[0].text);
}

test "/token: the record as JSON; none before the deploy event" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expect((try setup.tokenJson(a, null)) == null);
    const raw = unhex(a, vec.token_deploy);
    const d = (try deploy.deployIn(a, try atomic(a, raw))).ok;
    const j = (try setup.tokenJson(a, try setup.tokenRecord(a, d))).?;
    var parsed = try std.json.parseFromSlice(std.json.Value, a, j, .{});
    defer parsed.deinit();
    const o = parsed.value.object;
    try testing.expectEqualStrings(d.token_id, o.get("tokenId").?.string);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "ls_amm_{s}", .{d.token_id}), o.get("ammLookup").?.string);
    try testing.expectEqual(@as(i64, 0), o.get("vout").?.integer);
    try testing.expectEqual(@as(i64, d.dec), o.get("dec").?.integer);
}

test "the manifest (0.22.0): the program amm-setup, the event route deploy (kernel.beef → amm-setup.deploy), the read /token; config.overlay {}" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var parsed = try std.json.parseFromSlice(std.json.Value, a, manifest, .{});
    defer parsed.deinit();
    const m = parsed.value.object;
    try testing.expectEqualStrings("0.29.4", m.get("version").?.string);
    try testing.expectEqualStrings("bin/amm-setup.wasm", m.get("programs").?.object.get("amm-setup").?.string);
    try testing.expectEqualStrings("amm-setup.token", m.get("filters").?.object.get("token").?.string);
    try testing.expectEqual(@as(usize, 0), m.get("config").?.object.get("overlay").?.object.count());
    var event = false;
    var read = false;
    for (m.get("routes").?.array.items) |r| {
        const o = r.object;
        const transport = if (o.get("transport")) |t| t.string else "mailbox";
        if (std.mem.eql(u8, transport, "event") and std.mem.eql(u8, o.get("address").?.string, "deploy")) {
            try testing.expectEqualStrings("amm-setup.deploy", o.get("handler").?.string);
            try testing.expectEqual(@as(usize, 1), o.get("filters").?.array.items.len);
            try testing.expectEqualStrings("kernel.beef", o.get("filters").?.array.items[0].string);
            event = true;
        }
        if (std.mem.eql(u8, transport, "http") and std.mem.eql(u8, o.get("address").?.string, "/token")) {
            try testing.expect(o.get("handler") == null);
            try testing.expectEqualStrings("token", o.get("filters").?.array.items[0].string);
            read = true;
        }
    }
    try testing.expect(event and read);
}
