//! Getting a signed transaction into this instance's own overlay: the
//! validator only adds its signature; the submission is the overlay engine's
//! (skein-overlay 0.7.5 docs/OVERLAY.md "Submitting", shruggr/skein#112). A
//! submission is a message: the validator sends `{fn: "submit", args: {beef,
//! topics: [tm_color_<txid>_0]}}` from this instance to itself, in the submissions
//! box `<app>/submit` (the manifest's row `submit` from `*` takes it to the
//! engine; shruggr/skein#128: one box per function class), with the
//! signed BEEF — the request's BEEF (the taker's ancestry and BUMPs) with its
//! subject replaced by the signed transaction, and the pool's transaction with
//! its ancestry back to proven ones merged in (`submissionBeef`, 0.29.5: the
//! kernel's door verifies every BEEF with nothing known). The engine
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

/// The signed BEEF, what a submission carries: the request's with its
/// subject replaced by the signed transaction (same place, parents first,
/// its BUMPs kept), or a V1 BEEF of the signed transaction alone (a raw
/// request) — merged with `pool`, the Atomic BEEF of the transaction whose
/// output the signed transaction spends as its pool (0.29.5: the chain
/// state's, `beefOf`, back to proven transactions), when given.
///
/// 0.29.5 (David 2026-11-03, "So fix it"): the kernel's door (skein
/// door.zig, since c6dbbb0) verifies every BEEF with skein-sdk
/// `chain.spv.verify` and no known transactions — every input of every
/// transaction no BUMP proves must have its source inside the BEEF. The
/// relay's request carries the taker's ancestry, never the pool's
/// transaction, so the submission carries the pool's too (`merged`).
pub fn submissionBeef(a: std.mem.Allocator, signed: []const u8, ancestry: ?beef.Beef, pool: ?[]const u8) ![]u8 {
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
    if (pool) |p| out = try merged(a, out, try beef.parse(a, p));
    // The signed transaction stays the subject: an Atomic BEEF names it, a bare one ends with it.
    if ((out.subject() == null) or !std.mem.eql(u8, &out.subject().?, &txid)) return error.InvalidBeef;
    return beef.serialize(a, out);
}

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
