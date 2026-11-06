//! The validator's terms as a runtime record (0.15.0, David Case 2026-10-23: "The configs should
//! not be published in the image. This will be a dynamic, competitive marketplace."). A shared
//! library of this app's programs: amm-validator writes the record, amm-validator and amm-p2p read
//! it, the overlay engine copies it into each topic's beat (skein-overlay 0.16.0, `<app>/terms`).
//!
//! Root sets them with the message `{fn: "terms", args: {lpFeeBps, validatorFeeBps,
//! commissionBps, minLegSats?}}` in the box `amm/validator` and clears them with `{fn: "terms",
//! args: null}` (the role `root` gates `terms`). The record is the root of the head `<app>/terms`:
//!
//!   {lpFeeBps: uint, validatorFeeBps: uint, commissionBps: uint, minLegSats?: uint}   set
//!   null                                                                               cleared (no head delete)
//!
//! `minLegSats` (0.40.0, David Case 2026-11-05): the validator's minimum leg in sats, on the leg's
//! sats side (the amount in on a buy, the payout on a sell); absent or 0, none. The validator
//! refuses to sign a leg under it (`below_minimum`); the record carries it only when nonzero, so
//! the beat announces it with the fees.
//!
//! Terms set: this skein is a validator (amm.pool.affirm and the swap signing take them; its beat
//! carries them). Unset (no head, or the record `null`): a market only — the validator refuses
//! both ("no terms: this skein validates nothing"), amm.pool.terms answers "no validator here",
//! the beat carries no `terms`. There are no defaults in the manifest
//! (`config.amm.ammValidator`, 0.9.0 to 0.14.2, is gone).
//!
//! The initial value (0.17.0, shruggr/skein-amm#4): a token instance is created with its admin's
//! default terms in its config, `config.overlay.terms` (the app record's: given at the create, not
//! the image's). Until root writes the head, they are the terms (`current`): the head first — a
//! record, the cleared `null` included, wins — else `config.overlay.terms`, else none. The overlay
//! engine's beat reads the same (skein-overlay 0.17.0 `termsOf`), so the beat and the validator
//! read one value.
const std = @import("std");
const c = @import("chain");
const pool = @import("pool");

const cbor = c.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;

pub const Terms = pool.Terms;

/// The head the record is under: `<app>/terms` (the engine reads the same name).
pub fn headName(a: Allocator, app: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "{s}/terms", .{app});
}

/// The function root's message names (gated by `roles.root`).
pub const fn_terms = "terms";

/// The validator's refusal when no terms are set (affirm, swap).
pub const no_terms = "no terms: this skein validates nothing";
/// amm.pool.terms's refusal when no terms are set.
pub const no_validator = "no validator here";

/// A fee is basis points: 0 to 10 000.
pub const max_bps: u64 = 10_000;

const fields = [_][]const u8{ "lpFeeBps", "validatorFeeBps", "commissionBps" };
/// The optional field (0.40.0): the minimum leg, sats, any uint; absent or 0, none.
const field_min_leg = "minLegSats";

pub const Parsed = union(enum) {
    set: Terms,
    clear,
    /// Not the shape: why.
    bad: []const u8,
};

/// Root's `args`: `null` (or absent) clears; a map of the three fees, each an integer 0 to 10 000,
/// and optionally `minLegSats` (an integer, sats), sets (other keys refused); anything else is
/// refused.
pub fn parseArgs(args: ?Value) Parsed {
    const v = args orelse return .clear;
    if (v == .null) return .clear;
    if (v != .map) return .{ .bad = "want args {lpFeeBps, validatorFeeBps, commissionBps} (integers, 0 to 10000), or null to clear" };
    for (v.map) |e| {
        const known = for (fields) |f| {
            if (std.mem.eql(u8, f, e.key)) break true;
        } else std.mem.eql(u8, field_min_leg, e.key);
        if (!known) return .{ .bad = "want args {lpFeeBps, validatorFeeBps, commissionBps, minLegSats?} only" };
    }
    var out: [3]i64 = undefined;
    for (fields, &out) |f, *o| {
        const x = v.get(f) orelse return .{ .bad = "want args {lpFeeBps, validatorFeeBps, commissionBps} (integers, 0 to 10000), or null to clear" };
        if (x != .uint or x.uint > max_bps) return .{ .bad = "each fee is an integer, 0 to 10000 basis points" };
        o.* = @intCast(x.uint);
    }
    var min_leg: u64 = 0;
    if (v.get(field_min_leg)) |x| {
        if (x != .uint) return .{ .bad = "minLegSats is an integer, sats" };
        min_leg = x.uint;
    }
    return .{ .set = .{ .lp_fee_bps = out[0], .validator_fee_bps = out[1], .commission_bps = out[2], .min_leg_sats = min_leg } };
}

/// The record for `t`: `{lpFeeBps, validatorFeeBps, commissionBps}`, and `minLegSats` when it is
/// not 0.
pub fn record(a: Allocator, t: Terms) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "lpFeeBps", .value = .{ .uint = @intCast(t.lp_fee_bps) } },
        .{ .key = "validatorFeeBps", .value = .{ .uint = @intCast(t.validator_fee_bps) } },
        .{ .key = "commissionBps", .value = .{ .uint = @intCast(t.commission_bps) } },
    });
    if (t.min_leg_sats > 0) try es.append(a, .{ .key = field_min_leg, .value = .{ .uint = t.min_leg_sats } });
    return .{ .map = es.items };
}

/// The terms a record holds, or null: the record `null` (cleared), or not the shape.
pub fn fromRecord(v: Value) ?Terms {
    return switch (parseArgs(v)) {
        .set => |t| t,
        .clear, .bad => null,
    };
}

/// The app record's `config.overlay.terms` (0.17.0: the initial value a create's config gives), or
/// null: no app record, no such field, or not the shape.
pub fn fromConfig(app: ?Value) ?Terms {
    const cf = (app orelse return null).get("config") orelse return null;
    const ov = cf.get("overlay") orelse return null;
    const t = ov.get("terms") orelse return null;
    if (t != .map) return null;
    return fromRecord(t);
}

/// The terms now (0.17.0): the head `<app>/terms`'s record when there is one (`head`: its root;
/// the record `null` is "cleared" and wins), else the app record's `config.overlay.terms`, else none.
pub fn current(head: ?Value, app: ?Value) ?Terms {
    if (head) |h| return fromRecord(h);
    return fromConfig(app);
}

test "terms: the head wins, its null too; else config.overlay.terms; else none" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const t: Terms = .{ .lp_fee_bps = 30, .validator_fee_bps = 5, .commission_bps = 25 };
    const app: Value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "config", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "overlay", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "terms", .value = try record(a, t) }}) } }}) } }}) };
    try std.testing.expectEqual(@as(i64, 25), current(null, app).?.commission_bps);
    try std.testing.expect(current(.null, app) == null);
    const other: Terms = .{ .lp_fee_bps = 10, .validator_fee_bps = 1, .commission_bps = 0 };
    try std.testing.expectEqual(@as(i64, 10), current(try record(a, other), app).?.lp_fee_bps);
    try std.testing.expect(current(null, null) == null);
    try std.testing.expect(current(null, .{ .map = &.{} }) == null);
}
