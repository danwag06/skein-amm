//! Getting a signed transaction into this instance's own overlay: the
//! validator only adds its signature; the submission is the overlay engine's
//! (skein-overlay 0.7.5 docs/OVERLAY.md "Submitting", shruggr/skein#112). A
//! submission is a message: the validator sends `{fn: "submit", args: {beef,
//! topics: [tm_color_<txid>_0]}}` from this instance to itself, in the submissions
//! box `<app>/submit` (the manifest's row `submit` from `*` takes it to the
//! engine; shruggr/skein#128: one box per function class), with the
//! signed BEEF — the request's BEEF (the taker's ancestry and BUMPs) with its
//! subject replaced by the signed transaction, every transaction this instance
//! the token's topic admitted (the pool's among them) named by txid alone
//! (`submissionBeef`, 0.45.0:
//! skein 0.3.3's door admits a txid-only entry for a held transaction). The engine
//! routes it in its step on the message (decoded, checked against the chain
//! app's headers and SPV, judged by the topic's program; lacking a parent,
//! paused until one comes) and answers the sender, in the box it wrote to,
//! by message: `{fn: "submit", request, replyTo, result}` — `admitted`
//! (status `pending`, the STEAK) once the chain app accepts it, then each
//! `proven`, or `rejected` — or `error` for a body not that shape.
//!
//! main.zig awaits the message and answers the direct call `{wait: true}`;
//! called again with the engine's first answer (`reply`), it answers from
//! that (messages.zig `answerFromSubmit`).
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const beef = w.beef;

/// The box a submission goes to: `<app>/submit` (the manifest's mailbox address `submit`).
pub fn box(a: std.mem.Allocator, app: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "{s}/submit", .{app});
}

/// The submission message's body: `{fn: "submit", args: {beef: <bytes>, topics: [topic]}}`.
pub fn body(a: std.mem.Allocator, signed_beef: []const u8, topic: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = "submit" } },
        .{ .key = "args", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "beef", .value = .{ .bytes = signed_beef } },
            .{ .key = "topics", .value = .{ .array = try a.dupe(Value, &.{.{ .text = topic }}) } },
        }) } },
    }) };
}

/// The signed BEEF, what a submission carries (0.45.0, David 2026-11-07): the request's with its
/// subject replaced by the signed transaction (same place, parents first), or the signed transaction
/// alone (a raw request) — every transaction the token's topic admitted (`topic.has`: the pool's
/// transaction, a swap before it) named by txid alone, the pool's (`pool_txid`) added so when absent,
/// and nothing left that only those needed: the taker's raw funding with its ancestry back to proven
/// (its BUMPs) is what stays raw. The topic admitted them, so this instance holds them, and skein
/// 0.3.3's door admits a txid-only entry for a held transaction (`kernel.beef`'s `knownRaw` the held
/// set); no `beefFor` merge, no ancestry walk of the chain state. The signed transaction stays the
/// subject: an Atomic BEEF names it, a bare one ends with it.
pub fn submissionBeef(a: std.mem.Allocator, signed: []const u8, ancestry: ?beef.Beef, pool_txid: ?[32]u8, topic: anytype) ![]u8 {
    const txid = beef.txidOf(signed);
    const parsed = try w.bsvz.transaction.Transaction.parse(a, signed);
    var out: beef.Beef = if (ancestry) |b| blk: {
        const subject = b.subject() orelse return error.InvalidBeef;
        const entries = try a.dupe(beef.Entry, b.entries);
        const i = b.indexOf(subject) orelse return error.InvalidBeef;
        entries[i] = .{ .txid = txid, .format = .raw, .raw = signed, .tx = parsed };
        var o = b;
        o.entries = entries;
        if (o.atomic != null) o.atomic = txid;
        break :blk o;
    } else .{
        .version = beef.V1,
        .bumps = &.{},
        .entries = try a.dupe(beef.Entry, &.{.{ .txid = txid, .format = .raw, .raw = signed, .tx = parsed }}),
    };
    out = try topicByTxid(a, out, txid, pool_txid, topic);
    if ((out.subject() == null) or !std.mem.eql(u8, &out.subject().?, &txid)) return error.InvalidBeef;
    return beef.serialize(a, out);
}

/// Whether the instance holds `txid` (the chain state's `txs`, not rejected): what a BEEF may name by
/// txid alone at this instance's door (skein 0.3.3).
pub fn holds(ch: anytype, txid: [32]u8) !bool {
    return (try ch.holds(txid)) and (try ch.status(txid)) != .rejected;
}

/// `b` (its subject `subject`) with every transaction but the subject that the topic admitted a
/// txid-only entry, `extra` added as one when absent, then only what the subject's raw ancestry
/// reaches (a txid-only or a BUMP-proven entry ends a branch) and the BUMPs those keep; txid-only
/// entries first, then parents first (skein-sdk `beef.sorted`); V2 when any entry is txid-only.
fn topicByTxid(a: std.mem.Allocator, b: beef.Beef, subject: [32]u8, extra: ?[32]u8, topic: anytype) !beef.Beef {
    var entries: std.ArrayList(beef.Entry) = .empty;
    for (b.entries) |e| {
        if (!std.mem.eql(u8, &e.txid, &subject) and e.format != .txid_only and try topic.has(e.txid)) {
            try entries.append(a, .{ .txid = e.txid, .format = .txid_only });
        } else try entries.append(a, e);
    }
    if (extra) |x| {
        const have = for (entries.items) |*e| {
            if (std.mem.eql(u8, &e.txid, &x)) {
                e.* = .{ .txid = x, .format = .txid_only };
                break true;
            }
        } else false;
        if (!have) try entries.append(a, .{ .txid = x, .format = .txid_only });
    }
    // What the subject reaches: raw entries' inputs, back to txid-only or proven ones.
    const keep = try a.alloc(bool, entries.items.len);
    @memset(keep, false);
    var stack: std.ArrayList([32]u8) = .empty;
    try stack.append(a, subject);
    while (stack.pop()) |t| {
        const k = for (entries.items, 0..) |e, i| {
            if (std.mem.eql(u8, &e.txid, &t)) break i;
        } else continue;
        if (keep[k]) continue;
        keep[k] = true;
        const e = entries.items[k];
        if (e.format != .raw) continue;
        const tx = e.tx orelse try w.bsvz.transaction.Transaction.parse(a, e.raw orelse continue);
        for (tx.inputs) |in| try stack.append(a, in.previous_outpoint.txid.bytes);
    }
    // The pool's transaction stays named.
    if (extra) |x| for (entries.items, 0..) |e, i| {
        if (std.mem.eql(u8, &e.txid, &x)) keep[i] = true;
    };
    var bumps: std.ArrayList(w.bsvz.spv.MerklePath) = .empty;
    const remap = try a.alloc(?usize, b.bumps.len);
    @memset(remap, null);
    var txid_only: std.ArrayList(beef.Entry) = .empty;
    var rest: std.ArrayList(beef.Entry) = .empty;
    for (entries.items, keep) |e, k| {
        if (!k) continue;
        var n = e;
        if (e.bump) |bi| {
            if (remap[bi] == null) {
                remap[bi] = bumps.items.len;
                try bumps.append(a, b.bumps[bi]);
            }
            n.bump = remap[bi];
        }
        if (e.format == .txid_only) try txid_only.append(a, n) else try rest.append(a, n);
    }
    var o = b;
    if (txid_only.items.len > 0) o.version = beef.V2;
    o.bumps = bumps.items;
    o.entries = try std.mem.concat(a, beef.Entry, &.{ txid_only.items, rest.items });
    return beef.sorted(a, o);
}

/// The `beef` a `pool_spent` refusal carries (0.45.0): the transaction of the pool's newest state
/// (`txid`) in the same shape as a submission — every transaction the topic admitted (the pool's
/// transaction before it, a swap) named by txid, the others (the other taker's funding) raw with
/// their ancestry back to proven (their BUMPs, from the chain state `ch`), the newest itself raw (with
/// its BUMP once mined). An Atomic BEEF V2.
pub fn newestBeef(a: std.mem.Allocator, ch: anytype, txid: [32]u8, topic: anytype) ![]const u8 {
    var acc = Acc{ .a = a };
    try acc.visit(ch, topic, txid, txid);
    for (acc.entries.items) |e| {
        const bi = e.bump orelse continue;
        for (acc.bumps.items[bi].path[0]) |*l| if (l.hash) |h| if (std.mem.eql(u8, &h.bytes, &e.txid)) {
            l.txid = true;
        };
    }
    return beef.serialize(a, .{ .version = beef.V2, .atomic = txid, .bumps = acc.bumps.items, .entries = acc.entries.items });
}

const Acc = struct {
    a: std.mem.Allocator,
    entries: std.ArrayList(beef.Entry) = .empty,
    bumps: std.ArrayList(w.bsvz.spv.MerklePath) = .empty,

    fn visit(acc: *Acc, ch: anytype, topic: anytype, subject: [32]u8, txid: [32]u8) anyerror!void {
        const a = acc.a;
        for (acc.entries.items) |e| if (std.mem.eql(u8, &e.txid, &txid)) return;
        if (!std.mem.eql(u8, &txid, &subject) and try topic.has(txid)) {
            try acc.entries.append(a, .{ .txid = txid, .format = .txid_only });
            return;
        }
        const raw = (try ch.txRaw(txid)) orelse return error.MissingAncestor;
        const tx = try w.bsvz.transaction.Transaction.parse(a, raw);
        if ((try ch.status(txid)) == .proven) {
            const p = (try ch.proofFor(txid)) orelse return error.MissingProof;
            const idx = for (acc.bumps.items, 0..) |*q, i| {
                if (q.block_height != p.block_height) continue;
                q.combine(&p, a) catch continue;
                break i;
            } else blk: {
                try acc.bumps.append(a, p);
                break :blk acc.bumps.items.len - 1;
            };
            try acc.entries.append(a, .{ .txid = txid, .format = .raw_with_bump, .bump = idx, .raw = raw, .tx = tx });
            return;
        }
        for (tx.inputs) |in| try acc.visit(ch, topic, subject, in.previous_outpoint.txid.bytes);
        try acc.entries.append(a, .{ .txid = txid, .format = .raw, .raw = raw, .tx = tx });
    }
};

/// A signed BEEF (the wallet's Atomic BEEF of a Rescind, 0.29.5) merged with `pool`, the Atomic
/// BEEF of the pool's transaction (`merged`): the subject unchanged.
pub fn withPool(a: std.mem.Allocator, signed_beef: []const u8, pool: []const u8) ![]u8 {
    const b = try beef.parse(a, signed_beef);
    const subject = b.subject() orelse return error.InvalidBeef;
    const out = try merged(a, b, try beef.parse(a, pool));
    if ((out.subject() == null) or !std.mem.eql(u8, &out.subject().?, &subject)) return error.InvalidBeef;
    return beef.serialize(a, out);
}

/// `b` with every transaction of `x` it lacks (0.29.5): `x`'s BUMPs combined with `b`'s per block
/// (as the chain state's BEEF writer does), a transaction both carry kept once (`x`'s when only it
/// has a BUMP), then parents first (skein-sdk `beef.sorted`), each proven transaction's leaf
/// flagged in its BUMP. `b`'s envelope (version, atomic subject) is kept.
pub fn merged(a: std.mem.Allocator, b: beef.Beef, x: beef.Beef) !beef.Beef {
    var bumps: std.ArrayList(w.bsvz.spv.MerklePath) = .empty;
    try bumps.appendSlice(a, b.bumps);
    const entries = try a.dupe(beef.Entry, b.entries);
    var added: std.ArrayList(beef.Entry) = .empty;
    for (x.entries) |e| {
        const have = b.indexOf(e.txid);
        if (have) |i| if (entries[i].format == .raw_with_bump or e.format != .raw_with_bump) continue;
        var n = e;
        if (e.bump) |bi| n.bump = try addBump(a, &bumps, x.bumps[bi]);
        if (n.tx == null) if (n.raw) |raw| {
            n.tx = try w.bsvz.transaction.Transaction.parse(a, raw);
        };
        if (have) |i| entries[i] = n else try added.append(a, n);
    }
    var out = b;
    out.bumps = bumps.items;
    out.entries = try std.mem.concat(a, beef.Entry, &.{ added.items, entries });
    for (out.entries) |e| {
        const bi = e.bump orelse continue;
        for (out.bumps[bi].path[0]) |*l| if (l.hash) |h| if (std.mem.eql(u8, &h.bytes, &e.txid)) {
            l.txid = true;
        };
    }
    return beef.sorted(a, out);
}

fn addBump(a: std.mem.Allocator, bumps: *std.ArrayList(w.bsvz.spv.MerklePath), p: w.bsvz.spv.MerklePath) !usize {
    for (bumps.items, 0..) |*q, i| {
        if (q.block_height != p.block_height) continue;
        q.combine(&p, a) catch continue;
        return i;
    }
    try bumps.append(a, p);
    return bumps.items.len - 1;
}
