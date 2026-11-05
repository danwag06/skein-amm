//! The AMM pool liquidity index (served as `ls_amm_<assetId>`, 0.21.0): unspent pool outputs that pass
//! the pool checks, maintained through skein-overlay's lookup hooks
//! (skein-overlay docs/OVERLAY.md, the `lookup` module), and its queries. One
//! service over every 1Color token topic the overlay serves (`config.overlay`
//! names it with no `topics` list, so it listens to every topic, declared or
//! registered with the engine; shruggr/skein#120: "AMM keeps only its lookup"):
//! the topic (`tm_color_<txid>_<vout>`, skein-1color's topic manager) is the token's and
//! admits any output the BSV-21 rules allow; which of those outputs are pools
//! worth indexing is this service's judgement (decided 2026-10-01): `admitted`
//! runs `pool.check` and indexes only the pools that pass. Every map key
//! starts with the topic (`tp` = len ‖ topic), so the index is per token; a
//! query names its token (`tokenId`). See README.md for the map layout, the
//! query shapes.
//!
//! The listing (skein-amm 0.13.0, David Case 2026-10-22; docs/AMM.md "The listing"): a pool
//! output is listed when
//!   (a) it attests itself (pool.zig `affirmed`): not rescinded, its ValidatorPubKey the
//!       ValidatorIdentity's child keyed by its Nonce (derived here, not trusted), and its
//!       Affirmation that key's signature of the pool's parameters (message v2) — a deploy; or
//!   (b) its transaction calls Swap on a listed pool of this token (the pool input's method, the
//!       unlocking script's last push) and its ValidatorPubKey is the identity's child keyed by
//!       that spent outpoint (pool.zig `nextKeyOf`) — a Swap's continuation.
//! Anything else is never listed: a rescinded pool (ValidatorPubKey 33 zero bytes; Rescind's
//! continuation), an output a Close wrote (Close's outputs are free), a continuation naming
//! another next key. Only listed pools are indexed, so every query answers listed pools only. A
//! listed pool leaves the listing when its output is spent with no listed continuation: the LP's
//! Close, or the validator's Rescind.
//!
//! The beat (skein-overlay 0.12.0, David Case 2026-10-09: beats are libp2p service discovery):
//! this service's beat body on `ls_amm_<assetId>-live` carries, per token, this skein's per-validator
//! totals of its listed pools, `{tokens: {<assetId>: {<validator identity hex>: {sats, tokens,
//! pools}}}}` (dag-cbor), re-declared by a hook whenever it changes (`Service.beat`). The page
//! combines the beats it holds, live validators only.
const std = @import("std");
const w = @import("chain");
const lookup = @import("lookup");
const pool = @import("pool");
const color = @import("1color");

const brc162 = pool.brc162;
const bsv21 = pool.bsv21;
const names = color.name;
const cbor = w.cbor;
const Value = cbor.Value;
const Entry = cbor.Entry;
const Allocator = std.mem.Allocator;
const Service = lookup.Service;
const Chain = lookup.Chain;

/// The program's INDEX name: the head `<app>/ls_amm`, whatever name the service is served as
/// (skein-overlay 0.11.0). Not the service's name on the wire: that is `config.overlay.lookups`'
/// key, `ls_amm_<assetId>` (0.21.0, amm-config `tokens.ammLookupName`). Kept as is: no migration.
pub const service_name = "ls_amm";

/// `pools`: the live (unspent) listed pools: checked, and an affirmed deploy's or the
/// continuation of a listed pool. `spentPools`: the listed pools a spend consumed, kept so
/// `rejected` can give back exactly what was indexed before, without re-judging it. `beat`:
/// `body → <the last beat body's record>`, so a hook beats only when the body changes. (0.9.0's
/// `claims` and `spentClaims` are gone with the claim, 0.11.0.)
/// The fee rows (0.33.0, David Case 2026-11-04): `fees`: `tp ‖ LpPubKey ‖ swap txid → <record
/// {kind: "amm-swap-fees", lp, validator, commission, bsvIn, commissionPkh}>`, one per Swap admitted
/// (the pool's LP key is its id: constant along its continuations, one per deploy); `byCommission`:
/// `commissionPkh ‖ tp ‖ swap txid → <the same record>` when the commission is not 0. Written by
/// `admitted`, removed by `rejected`; rows exist for Swaps admitted from 0.33.0 on. `rescinded`
/// (0.33.0): `tp ‖ LpPubKey → <outpoint record {txid, vout}>`, the output a validator's Rescind of a
/// listed pool wrote (not listed: the LP's Close acts on it; its pool record, as `pools` keeps one),
/// removed when the Rescind is rejected.
/// `byLp` (0.33.0): `LpPubKey ‖ tp ‖ outpoint → null`, every listed pool of that LP key, live or
/// spent (the hops of its lineage), removed only when the transaction that listed it is rejected;
/// `byValidator` likewise from 0.33.0 (its single-key query still answers the live pools only).
pub const maps = [_][]const u8{ "pools", "byValidator", "spentPools", "beat", "fees", "byCommission", "rescinded", "byLp" };

fn cat(a: Allocator, parts: []const []const u8) ![]u8 {
    return std.mem.concat(a, u8, parts);
}

/// The topic a query's token id names (skein-1color's name.zig `tokenIdOfString`: `<txid>`,
/// `<txid>_<vout>` or `<txid>.<vout>`; the topic `tm_color_<txid>_<vout>` (BRC-207),
/// `tm_color_<txid>_0` for output 0 in any form).
pub fn topicOf(a: Allocator, token_id: []const u8) ![]const u8 {
    const id = names.tokenIdOfString(token_id) orelse return error.BadQuery;
    var buf: [names.max_topic_len]u8 = undefined;
    return a.dupe(u8, names.topicName(&buf, id));
}

/// The token a topic name carries, as the rules take it (skein-1color's token.zig); null for
/// a topic that is not a token's (`tm_color`, `tm_demo`).
pub fn tokenIdOf(topic: []const u8) ?bsv21.TokenId {
    return color.token.tokenIdOf(topic);
}

/// The key prefix of a topic's entries: len ‖ topic (the engine's convention, skein-sdk `store.nameKey`).
fn topicPrefix(a: Allocator, topic: []const u8) ![]u8 {
    return w.store.nameKey(a, topic, &.{});
}

// ---------------------------------------------------------------- recognising a pool output

/// A pool output's fields, as pool.zig parses them, plus where it is. Not
/// the ValidatorPubKey: the overlay does not check it (the validator's own
/// convention) and nothing here is found by it.
pub const PoolFields = struct {
    txid: [32]u8,
    vout: u32,
    bsv_reserve: u64,
    token_reserve: u64,
    liquidity_fee_bps: i64,
    validation_fee_bps: i64,
    /// The relay's commission (Pool's CommissionBps): markets filter pools
    /// by the commission they offer.
    commission_bps: i64,
    lp: [33]u8,
    identity: [33]u8,
};

/// Whether output `vout`'s script is a pool: a BRC-162 value output whose
/// lock parses as the Pool template. Recognition only: whether it passes
/// the pool checks is `judge`'s.
pub fn poolAt(txid: [32]u8, vout: u32, script: []const u8, satoshis: u64) ?PoolFields {
    const tok = brc162.decode(script) orelse return null;
    if (tok.role != .value) return null;
    const p = (pool.parse(tok.lock) catch return null) orelse return null;
    return .{
        .txid = txid,
        .vout = vout,
        .bsv_reserve = satoshis,
        .token_reserve = p.token_reserve,
        .liquidity_fee_bps = p.lp_fee_bps,
        .validation_fee_bps = p.validator_fee_bps,
        .commission_bps = p.commission_bps,
        .lp = p.lp,
        .identity = p.identity,
    };
}

fn intValue(v: i64) Value {
    return if (v >= 0) .{ .uint = @intCast(v) } else .{ .nint = @intCast(-1 - v) };
}

/// The record stored under `pools`' value (its own CID, linked from the
/// map): every field pool.zig parses but the ValidatorPubKey, plus
/// `admittedAt` (see README —
/// always null: a lookup hook carries no wall-clock or block time).
fn recordValue(a: Allocator, pf: PoolFields) !Value {
    return .{ .map = try a.dupe(Entry, &.{
        .{ .key = "kind", .value = .{ .text = "amm-pool" } },
        .{ .key = "txid", .value = .{ .bytes = try a.dupe(u8, &pf.txid) } },
        .{ .key = "vout", .value = .{ .uint = pf.vout } },
        .{ .key = "bsvReserve", .value = .{ .uint = pf.bsv_reserve } },
        .{ .key = "tokenReserve", .value = .{ .uint = pf.token_reserve } },
        .{ .key = "liquidityFeeBps", .value = intValue(pf.liquidity_fee_bps) },
        .{ .key = "validationFeeBps", .value = intValue(pf.validation_fee_bps) },
        .{ .key = "commissionBps", .value = intValue(pf.commission_bps) },
        .{ .key = "lpPubKey", .value = .{ .bytes = try a.dupe(u8, &pf.lp) } },
        .{ .key = "validatorIdentityKey", .value = .{ .bytes = try a.dupe(u8, &pf.identity) } },
        .{ .key = "admittedAt", .value = .null },
    }) };
}

// ---------------------------------------------------------------- the pool checks (this service's judgement)

/// The pool checks (`pool.check`) on the hook's arguments:
/// the transaction's admitted outputs of this token (`outputs_to_admit`).
/// The checks read only those outputs, so the token's spent coins are not
/// read. Null when the pools in `tx` pass (or there are none); the
/// violation otherwise.
pub fn judge(a: Allocator, id: bsv21.TokenId, tx: lookup.Tx, outputs_to_admit: []const u32) !?pool.Violation {
    var j_outs: std.ArrayList(bsv21.Indexed) = .empty;
    for (outputs_to_admit) |vout| {
        if (vout >= tx.tx.outputs.len) return error.BadHook;
        const t = (try bsv21.tokenOf(a, id, tx.txid, vout, tx.tx.outputs[vout].locking_script.bytes)) orelse continue;
        try j_outs.append(a, .{ .index = vout, .token = t });
    }
    return pool.check(.{ .ok = true, .inputs = &.{}, .outputs = j_outs.items });
}

// ---------------------------------------------------------------- the maps

fn poolKey(a: Allocator, tp: []const u8, txid: [32]u8, vout: u32) ![]u8 {
    return cat(a, &.{ tp, &w.store.outpointKey(txid, vout) });
}

fn identityKey(a: Allocator, identity: []const u8, tp: []const u8, txid: [32]u8, vout: u32) ![]u8 {
    return cat(a, &.{ identity, tp, &w.store.outpointKey(txid, vout) });
}

fn identityOf(a: Allocator, svc: *Service, cid: []const u8) ![]const u8 {
    const rec = try svc.store.getValue(a, cid);
    const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
    if (identity.len != 33) return error.BadIndex;
    return identity;
}

/// Index a pool record (`cid`) as live at `key`.
fn linkPool(a: Allocator, svc: *Service, tp: []const u8, txid: [32]u8, vout: u32, cid: []const u8) !void {
    // A re-admission of the same outpoint (a dupe hook call): replace, not duplicate.
    _ = try removePool(a, svc, tp, txid, vout);
    try svc.map("pools").putLink(try poolKey(a, tp, txid, vout), cid);
    try svc.map("byValidator").add(try identityKey(a, try identityOf(a, svc, cid), tp, txid, vout));
    try svc.map("byLp").add(try identityKey(a, try lpOf(a, svc, cid), tp, txid, vout));
}

fn lpOf(a: Allocator, svc: *Service, cid: []const u8) ![]const u8 {
    const rec = try svc.store.getValue(a, cid);
    const lp = rec.getBytes("lpPubKey") orelse return error.BadIndex;
    if (lp.len != 33) return error.BadIndex;
    return lp;
}

fn putPool(a: Allocator, svc: *Service, tp: []const u8, pf: PoolFields) !void {
    try linkPool(a, svc, tp, pf.txid, pf.vout, try svc.store.putValue(a, try recordValue(a, pf)));
}

/// Drop a live pool; → its record's CID, when it was indexed. Its `byValidator` and `byLp`
/// memberships stay (0.33.0: a spent pool is still that validator's and that LP's; `rejected` drops them).
fn removePool(a: Allocator, svc: *Service, tp: []const u8, txid: [32]u8, vout: u32) !?[]const u8 {
    const key = try poolKey(a, tp, txid, vout);
    const cid = (try svc.map("pools").link(key)) orelse return null;
    _ = try svc.map("pools").remove(key);
    return cid;
}

// ---------------------------------------------------------------- the listing (0.11.0)

/// Whether the pool output at `vout` of `tx` is listed (the module's doc, rules (a) and (b)):
/// a Swap's continuation of a listed pool (`tx` calls Swap on an output in `pools` — `spent` runs
/// after `admitted`, so it is still there — and names its next key), or a pool that attests
/// itself (pool.zig `affirmed`). Anything else is never listed.
fn listedAt(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx, vout: u32) !?Listing {
    const o = tx.tx.outputs[vout];
    const p = pool.poolOfScript(o.locking_script.bytes) orelse return null;
    if (p.rescinded()) return null;
    for (tx.tx.inputs, 0..) |in, i| {
        const op = in.previous_outpoint;
        const cid = (try svc.map("pools").link(try poolKey(a, tp, op.txid.bytes, op.index))) orelse continue;
        if (pool.methodOf(in.unlocking_script.bytes) != .swap) continue;
        const identity = try identityOf(a, svc, cid);
        if (vout == 0 and pool.nextKeyOf(a, p, identity[0..33].*, op.txid.bytes, op.index)) return .{ .swap = i };
    }
    return if (pool.affirmed(a, o.locking_script.bytes, @intCast(o.satoshis))) .deploy else null;
}

/// Whether `tx` is a validator's Rescind of a listed pool of LpPubKey `lp` (0.33.0): output 0 a
/// rescinded pool of that key, an input spending a listed pool (`pools`: `spent` runs after
/// `admitted`) of the same key with the Rescind method.
fn rescindOf(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx, lp: [33]u8) !bool {
    const p = pool.poolOfScript(tx.tx.outputs[0].locking_script.bytes) orelse return false;
    if (!p.rescinded()) return false;
    for (tx.tx.inputs) |in| {
        if (pool.methodOf(in.unlocking_script.bytes) != .rescind) continue;
        const op = in.previous_outpoint;
        const cid = (try svc.map("pools").link(try poolKey(a, tp, op.txid.bytes, op.index))) orelse continue;
        const rec = try svc.store.getValue(a, cid);
        if (std.mem.eql(u8, rec.getBytes("lpPubKey") orelse continue, &lp)) return true;
    }
    return false;
}

/// Why a pool output is listed (`listedAt`): an affirmed deploy, or the Swap continuation of the
/// listed pool input `swap` spends.
const Listing = union(enum) { deploy, swap: usize };

// ---------------------------------------------------------------- the fee rows (0.33.0)

fn feeKey(a: Allocator, tp: []const u8, lp: []const u8, txid: [32]u8) ![]u8 {
    return cat(a, &.{ tp, lp, &txid });
}

fn commissionKey(a: Allocator, pkh: []const u8, tp: []const u8, txid: [32]u8) ![]u8 {
    return cat(a, &.{ pkh, tp, &txid });
}

/// The Swap `tx` (its pool input `input`, its continuation of LpPubKey `lp` at output 0): its fee row
/// under the LP key, and (a commission not 0) its membership under the commission's key hash. The
/// fees are src/pool.zig `feesOf`'s, read where the relay's pair check lays them out (`feeLayout`);
/// a Swap whose fee outputs are not the contract's writes nothing.
fn putFees(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx, input: usize, lp: []const u8) !void {
    const f = (try pool.feesOf(a, tx.tx, input)) orelse return;
    const rec = try svc.store.putValue(a, .{ .map = try a.dupe(Entry, &.{
        .{ .key = "kind", .value = .{ .text = "amm-swap-fees" } },
        .{ .key = "lp", .value = .{ .uint = f.lp } },
        .{ .key = "validator", .value = .{ .uint = f.validator } },
        .{ .key = "commission", .value = .{ .uint = f.commission } },
        .{ .key = "bsvIn", .value = .{ .boolean = f.bsv_in } },
        .{ .key = "commissionPkh", .value = .{ .bytes = try a.dupe(u8, &f.commission_pkh) } },
    }) });
    try svc.map("fees").putLink(try feeKey(a, tp, lp, tx.txid), rec);
    if (f.commission > 0) try svc.map("byCommission").putLink(try commissionKey(a, &f.commission_pkh, tp, tx.txid), rec);
}

/// A rejected transaction's fee row and its commission membership, gone (the keys from the
/// transaction: its continuation's LpPubKey at output 0, its txid; the key hash from the row).
fn removeFees(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx) !void {
    if (tx.tx.outputs.len == 0) return;
    const p = pool.poolOfScript(tx.tx.outputs[0].locking_script.bytes) orelse return;
    // A rejected Rescind: its output was never the pool's (0.33.0).
    const rk = try cat(a, &.{ tp, &p.lp });
    if (try svc.map("rescinded").link(rk)) |rc| {
        const r = try svc.store.getValue(a, rc);
        if (std.mem.eql(u8, r.getBytes("txid") orelse "", &tx.txid)) _ = try svc.map("rescinded").remove(rk);
    }
    const key = try feeKey(a, tp, &p.lp, tx.txid);
    const cid = (try svc.map("fees").link(key)) orelse return;
    const rec = try svc.store.getValue(a, cid);
    _ = try svc.map("fees").remove(key);
    if (rec.getBytes("commissionPkh")) |pkh| _ = try svc.map("byCommission").remove(try commissionKey(a, pkh, tp, tx.txid));
}

// ---------------------------------------------------------------- hooks (#50)

/// A topic admitted `tx`: when its pools pass the pool checks (`judge`),
/// index every admitted output that is a listed pool (`listedAt`: an affirmed deploy's, or the
/// continuation of a listed pool). A pool that fails, or a deploy without a verified
/// affirmation, is not indexed (and so not searchable); it stays a valid token output in the
/// topic. Then the beat, when the listed totals changed.
pub fn admitted(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx, outputs_to_admit: []const u32, _: []const u32) anyerror!void {
    const id = tokenIdOf(topic) orelse return; // not a token topic: nothing of ours
    if (outputs_to_admit.len == 0) return;
    if (try judge(a, id, tx, outputs_to_admit) != null) return;
    const tp = try topicPrefix(a, topic);
    for (outputs_to_admit) |vout| {
        if (vout >= tx.tx.outputs.len) continue;
        const o = tx.tx.outputs[vout];
        const pf = poolAt(tx.txid, vout, o.locking_script.bytes, @intCast(o.satoshis)) orelse continue;
        if (vout == 0 and try rescindOf(a, svc, tp, tx, pf.lp)) {
            // The rescinded pool's record (`recordValue`: txid, vout, its reserves and fees): what the Close takes back.
            try svc.map("rescinded").putLink(try cat(a, &.{ tp, &pf.lp }), try svc.store.putValue(a, try recordValue(a, pf)));
            continue;
        }
        const why = (try listedAt(a, svc, tp, tx, vout)) orelse continue;
        try putPool(a, svc, tp, pf);
        switch (why) {
            .swap => |i| try putFees(a, svc, tp, tx, i, &pf.lp),
            .deploy => {},
        }
    }
    try beatIfChanged(a, svc);
}

/// A previous coin was consumed: if it was a pool we indexed, it leaves
/// `pools` for `spentPools` (where `rejected` finds it). Its continuation
/// (if the spend admits one: a Swap) arrives through its own `admitted` call —
/// skein does not fold the two (docs/OVERLAY.md, "The lookup contract"). A Close (the LP's) or a
/// Rescind (the validator's, 0.13.0) lists none: the pool leaves the listing.
pub fn spent(a: Allocator, svc: *Service, topic: []const u8, outpoint: lookup.Outpoint, _: lookup.Tx) anyerror!void {
    const tp = try topicPrefix(a, topic);
    if (try removePool(a, svc, tp, outpoint.txid, outpoint.vout)) |cid|
        try svc.map("spentPools").putLink(try poolKey(a, tp, outpoint.txid, outpoint.vout), cid);
    try beatIfChanged(a, svc);
}

/// A judgement of `topic` was removed by a rejection: `tx`'s own pools are
/// gone (live or spent), and the checked pools `tx` had spent are live
/// again. Skein calls only `rejected(topic, tx)` (docs/OVERLAY.md,
/// "Settlement: `admits` propagates") — it does not re-call `admitted` for
/// the coins a rejection gives back — so they come back from `spentPools`,
/// as indexed (and checked) when first admitted.
pub fn rejected(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx) anyerror!void {
    const tp = try topicPrefix(a, topic);
    try removeFees(a, svc, tp, tx);
    for (0..tx.tx.outputs.len) |vout| {
        const key = try poolKey(a, tp, tx.txid, @intCast(vout));
        const was = (try removePool(a, svc, tp, tx.txid, @intCast(vout))) orelse try svc.map("spentPools").link(key);
        _ = try svc.map("spentPools").remove(key);
        // 0.33.0: the rejected transaction's pools leave `byValidator` and `byLp` (a spend keeps them there).
        if (was) |cid| {
            _ = try svc.map("byValidator").remove(try identityKey(a, try identityOf(a, svc, cid), tp, tx.txid, @intCast(vout)));
            _ = try svc.map("byLp").remove(try identityKey(a, try lpOf(a, svc, cid), tp, tx.txid, @intCast(vout)));
        }
    }
    for (tx.tx.inputs) |in| {
        const txid = in.previous_outpoint.txid.bytes;
        const vout = in.previous_outpoint.index;
        const key = try poolKey(a, tp, txid, vout);
        const cid = (try svc.map("spentPools").link(key)) orelse continue;
        _ = try svc.map("spentPools").remove(key);
        try linkPool(a, svc, tp, txid, vout, cid);
    }
    try beatIfChanged(a, svc);
}

// ---------------------------------------------------------------- the beat (0.12.0)

/// One validator's listed pools of one token, summed.
pub const Totals = struct { sats: u64 = 0, tokens: u64 = 0, pools: u64 = 0 };

/// The beat body over the listed pools: dag-cbor `{tokens: {<assetId `<txid>_<vout>`>:
/// {<validator identity, hex>: {sats, tokens, pools}}}}`, every listed pool of every token this
/// skein serves, per validator. Its record (`beatRecord`) is what `beat` keeps.
pub fn beatValue(a: Allocator, svc: *Service) !Value {
    var tokens: std.ArrayList(Entry) = .empty;
    var cur_tp: ?[]const u8 = null;
    var vals: std.StringArrayHashMapUnmanaged(Totals) = .empty;
    const flush = struct {
        fn f(al: Allocator, out: *std.ArrayList(Entry), tp: []const u8, vs: *std.StringArrayHashMapUnmanaged(Totals)) !void {
            if (vs.count() == 0) return;
            const topic = tp[1..];
            const id = tokenIdOf(topic) orelse return;
            const es = try al.alloc(Entry, vs.count());
            for (vs.keys(), vs.values(), es) |k, t, *e| e.* = .{ .key = k, .value = .{ .map = try al.dupe(Entry, &.{
                .{ .key = "sats", .value = .{ .uint = t.sats } },
                .{ .key = "tokens", .value = .{ .uint = t.tokens } },
                .{ .key = "pools", .value = .{ .uint = t.pools } },
            }) } };
            try out.append(al, .{ .key = try std.fmt.allocPrint(al, "{s}_{d}", .{ &w.header.toHex(id.txid), id.vout }), .value = .{ .map = es } });
            vs.clearRetainingCapacity();
        }
    }.f;
    for (try svc.map("pools").prefixed(&.{})) |kv| {
        if (kv.key.len < 1 + 36 or kv.value != .cid) continue;
        const tp = kv.key[0 .. 1 + @as(usize, kv.key[0])];
        if (cur_tp == null or !std.mem.eql(u8, cur_tp.?, tp)) {
            if (cur_tp) |c| try flush(a, &tokens, c, &vals);
            cur_tp = tp;
        }
        const rec = try svc.store.getValue(a, kv.value.cid);
        const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
        const gop = try vals.getOrPut(a, try hexOf(a, identity));
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.sats += rec.getUint("bsvReserve") orelse 0;
        gop.value_ptr.tokens += rec.getUint("tokenReserve") orelse 0;
        gop.value_ptr.pools += 1;
    }
    if (cur_tp) |c| try flush(a, &tokens, c, &vals);
    return .{ .map = try a.dupe(Entry, &.{.{ .key = "tokens", .value = .{ .map = tokens.items } }}) };
}

/// The beat body's bytes (dag-cbor), for fn "beat" at the beacon's declaration.
pub fn beat(a: Allocator, svc: *Service) anyerror![]const u8 {
    return cbor.encode(a, try beatValue(a, svc));
}

/// After a hook: when the body changed since the last beat, keep it (`beat` map) and hand it to
/// the engine (`Service.beat`, skein-overlay 0.12.0), which re-declares `<service>-live`'s beacon (`ls_amm_<assetId>-live`).
fn beatIfChanged(a: Allocator, svc: *Service) !void {
    const v = try beatValue(a, svc);
    const rec = try svc.store.putValue(a, v);
    if (try svc.map("beat").link("body")) |prev| if (std.mem.eql(u8, prev, rec)) return;
    try svc.map("beat").putLink("body", rec);
    if (comptime @hasDecl(Service, "beat")) try svc.beat(svc.name, try cbor.encode(a, v));
}

// ---------------------------------------------------------------- rendering an answer

fn hexOf(a: Allocator, bytes: []const u8) ![]const u8 {
    const digits = "0123456789abcdef";
    const out = try a.alloc(u8, bytes.len * 2);
    for (bytes, 0..) |byte, i| {
        out[i * 2] = digits[byte >> 4];
        out[i * 2 + 1] = digits[byte & 0xf];
    }
    return out;
}

fn outpointStr(a: Allocator, txid: [32]u8, vout: u32) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}_{d}", .{ &w.header.toHex(txid), vout });
}

const ParsedOutpoint = struct { txid: [32]u8, vout: u32 };

fn parseOutpoint(text: []const u8) !ParsedOutpoint {
    const at = std.mem.indexOfScalar(u8, text, '_') orelse return error.BadQuery;
    return .{
        .txid = w.header.fromHex(text[0..at]) catch return error.BadQuery,
        .vout = std.fmt.parseInt(u32, text[at + 1 ..], 10) catch return error.BadQuery,
    };
}

/// The engine's PoolState shape (amm-poc-engine/web/engine/src/types.ts)
/// plus the outpoint string, the pool's commissionBps and (0.34.0) its LpPubKey (hex: the pool's id,
/// D2), from an indexed record. (0.34.0: no `lastSeen`: the liveness join is the host's, D11.)
fn poolStateValue(a: Allocator, rec: Value, outpoint: []const u8) !Value {
    const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
    const lp = rec.getBytes("lpPubKey") orelse return error.BadIndex;
    var es: std.ArrayList(Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "lpPubKey", .value = .{ .text = try hexOf(a, lp) } },
        .{ .key = "outpoint", .value = .{ .text = outpoint } },
        .{ .key = "bsvReserve", .value = rec.get("bsvReserve") orelse return error.BadIndex },
        .{ .key = "tokenReserve", .value = rec.get("tokenReserve") orelse return error.BadIndex },
        .{ .key = "liquidityFeeBps", .value = rec.get("liquidityFeeBps") orelse return error.BadIndex },
        .{ .key = "validationFeeBps", .value = rec.get("validationFeeBps") orelse return error.BadIndex },
        .{ .key = "commissionBps", .value = rec.get("commissionBps") orelse return error.BadIndex },
        .{ .key = "validatorIdentityKey", .value = .{ .text = try hexOf(a, identity) } },
    });
    return .{ .map = es.items };
}

fn poolsUnder(a: Allocator, svc: *Service, prefix: []const u8, key_off: usize) ![]Value {
    var out: std.ArrayList(Value) = .empty;
    for (try svc.map("pools").prefixed(prefix)) |kv| {
        if (kv.value != .cid) return error.BadIndex;
        const rec = try svc.store.getValue(a, kv.value.cid);
        const op = try w.store.outpointOf(kv.key[key_off..]);
        try out.append(a, try poolStateValue(a, rec, try outpointStr(a, op.txid, op.vout)));
    }
    return out.items;
}

fn answerAll(a: Allocator, svc: *Service, tp: []const u8) !lookup.Answer {
    return .{ .freeform = .{ .array = try poolsUnder(a, svc, tp, tp.len) } };
}

/// `byValidator`'s values are membership-only (`.null`): resolve each hit
/// back through `pools` for the record.
fn poolsForValidator(a: Allocator, svc: *Service, tp: []const u8, prefix: []const u8) ![]Value {
    var out: std.ArrayList(Value) = .empty;
    for (try svc.map("byValidator").prefixed(prefix)) |kv| {
        const op = try w.store.outpointOf(kv.key[prefix.len..]);
        const cid = (try svc.map("pools").link(try poolKey(a, tp, op.txid, op.vout))) orelse continue;
        const rec = try svc.store.getValue(a, cid);
        try out.append(a, try poolStateValue(a, rec, try outpointStr(a, op.txid, op.vout)));
    }
    return out.items;
}

fn answerValidator(a: Allocator, svc: *Service, tp: []const u8, hex: []const u8) !lookup.Answer {
    if (hex.len == 0 or hex.len % 2 != 0) return error.BadQuery;
    const identity = try a.alloc(u8, hex.len / 2);
    _ = std.fmt.hexToBytes(identity, hex) catch return error.BadQuery;
    const prefix = try cat(a, &.{ identity, tp });
    return .{ .freeform = .{ .array = try poolsForValidator(a, svc, tp, prefix) } };
}

/// `{outpoint}`: that pool, or its newest continuation, found by following
/// the spends forward from any pool outpoint this service indexed — the
/// continuation is always output 0 of the spend (pool.check: a pool is
/// indexed at output 0). A hop is a checked pool a spend consumed
/// (`spentPools`, this topic's own record of it), and its spender is the
/// chain state's (`spentBy`: the first held spender not rejected).
/// `want_beef`: the `output-list` form (the BEEF a taker builds a spend
/// from), instead of the freeform `{current, hops}`.
fn answerOutpoint(a: Allocator, svc: *Service, ch: *Chain, tp: []const u8, start: ParsedOutpoint, want_beef: bool) !lookup.Answer {
    var txid = start.txid;
    var vout = start.vout;
    var hops: u64 = 0;
    var rec: ?Value = null;
    if (try svc.map("pools").link(try poolKey(a, tp, txid, vout))) |cid| rec = try svc.store.getValue(a, cid);
    // Follow the spends until a pools-map hit (an intermediate hop is spent
    // and was moved from `pools` to `spentPools` — only the tip is live,
    // README, "Index"). An outpoint in neither is not one of this topic's
    // pools; a spent pool whose spender did not recreate one (a pool closed)
    // ends the trail.
    while (rec == null) {
        if (!try svc.map("spentPools").has(try poolKey(a, tp, txid, vout))) return error.UnknownOutpoint;
        const sp = (try ch.spentBy(txid, vout)) orelse return error.UnknownOutpoint;
        txid = sp;
        vout = 0;
        hops += 1;
        if (try svc.map("pools").link(try poolKey(a, tp, txid, vout))) |cid| rec = try svc.store.getValue(a, cid);
    }
    if (want_beef) return .{ .output_list = try a.dupe(lookup.Output, &.{.{ .txid = txid, .vout = vout }}) };
    const current = try poolStateValue(a, rec.?, try outpointStr(a, txid, vout));
    return .{ .freeform = .{ .map = try a.dupe(Entry, &.{
        .{ .key = "current", .value = current },
        .{ .key = "hops", .value = .{ .uint = hops } },
    }) } };
}

// ---------------------------------------------------------------- the fee queries (0.33.0): a set in, a set out

/// A list of hex keys of `len` bytes (a query's `lpPubKeys`, `validatorIdentityKeys`, `commissionPkhs`).
fn hexList(a: Allocator, v: Value, len: usize) ![]const []const u8 {
    if (v != .array) return error.BadQuery;
    const out = try a.alloc([]const u8, v.array.len);
    for (v.array, out) |x, *o| {
        if (x != .text or x.text.len != len * 2) return error.BadQuery;
        const b = try a.alloc(u8, len);
        _ = std.fmt.hexToBytes(b, x.text) catch return error.BadQuery;
        o.* = b;
    }
    return out;
}

/// A sum of fee rows: one amount of each row (`field`), into `sats` (sats-in Swaps) or `tokens`
/// (token-in Swaps), and the rows counted.
const Sum = struct {
    sats: u64 = 0,
    tokens: u64 = 0,
    swaps: u64 = 0,
    fn add(self: *Sum, rec: Value, field: []const u8) void {
        const amt = rec.getUint(field) orelse 0;
        if (rec.getBool("bsvIn") orelse false) self.sats += amt else self.tokens += amt;
        self.swaps += 1;
    }
};

fn sumUnder(a: Allocator, svc: *Service, map_name: []const u8, prefix: []const u8, field: []const u8, sum: *Sum) !void {
    for (try svc.map(map_name).prefixed(prefix)) |kv| {
        if (kv.value != .cid) return error.BadIndex;
        sum.add(try svc.store.getValue(a, kv.value.cid), field);
    }
}

fn sumEntries(s: Sum) [3]Entry {
    return .{
        .{ .key = "sats", .value = .{ .uint = s.sats } },
        .{ .key = "tokens", .value = .{ .uint = s.tokens } },
        .{ .key = "swaps", .value = .{ .uint = s.swaps } },
    };
}

/// `{lpPubKeys}`: per key `{lpPubKey, status, outpoint?, current?, sats, tokens, swaps}` — the LP
/// fees of its pool's Swaps (`fees` under the key) and the pool's state: `live` (its live pool:
/// `outpoint`, `current` the `PoolState`), `rescinded` (the validator's Rescind wrote `outpoint`,
/// unspent in the chain state: the LP's Close acts on it; `current` that output's pool state), else `closed` (spent, or no pool of the
/// key here: an unknown key answers `closed` with zeros). The live pool is found through `byLp` (the
/// key's pools, live and spent; the live one in `pools`); with none live, rescinded is told from
/// closed by the `rescinded` record of the key (the Rescind's output) and the chain state: unspent
/// (`spentBy` none) is rescinded, spent (the LP's Close) or no record is closed.
fn answerLps(a: Allocator, svc: *Service, ch: *Chain, tp: []const u8, v: Value) !lookup.Answer {
    const keys = try hexList(a, v, 33);
    const out = try a.alloc(Value, keys.len);
    for (keys, out) |k, *o| {
        var sum: Sum = .{};
        try sumUnder(a, svc, "fees", try cat(a, &.{ tp, k }), "lp", &sum);
        var es: std.ArrayList(Entry) = .empty;
        try es.append(a, .{ .key = "lpPubKey", .value = .{ .text = try hexOf(a, k) } });
        var status: []const u8 = "closed";
        // The key's listed pools (`byLp`, live and spent): the live one is in `pools`.
        const prefix = try cat(a, &.{ k, tp });
        for (try svc.map("byLp").prefixed(prefix)) |kv| {
            const op = try w.store.outpointOf(kv.key[prefix.len..]);
            const cid = (try svc.map("pools").link(try poolKey(a, tp, op.txid, op.vout))) orelse continue;
            const rec = try svc.store.getValue(a, cid);
            const text = try outpointStr(a, op.txid, op.vout);
            status = "live";
            try es.appendSlice(a, &.{
                .{ .key = "outpoint", .value = .{ .text = text } },
                .{ .key = "current", .value = try poolStateValue(a, rec, text) },
            });
            break;
        }
        if (std.mem.eql(u8, status, "closed")) if (try svc.map("rescinded").link(try cat(a, &.{ tp, k }))) |rc| {
            const r = try svc.store.getValue(a, rc);
            const txid = (r.getBytes("txid") orelse return error.BadIndex)[0..32].*;
            const vout: u32 = @intCast(r.getUint("vout") orelse return error.BadIndex);
            if ((try ch.spentBy(txid, vout)) == null) {
                status = "rescinded";
                const text = try outpointStr(a, txid, vout);
                try es.appendSlice(a, &.{
                    .{ .key = "outpoint", .value = .{ .text = text } },
                    .{ .key = "current", .value = try poolStateValue(a, r, text) },
                });
            }
        };
        try es.append(a, .{ .key = "status", .value = .{ .text = status } });
        try es.appendSlice(a, &sumEntries(sum));
        o.* = .{ .map = es.items };
    }
    return .{ .freeform = .{ .array = out } };
}

/// `{validatorIdentityKeys}`: per key `{validatorIdentityKey, sats, tokens, swaps, pools}` — the
/// validator fees over the fee rows of all its pools, closed included (`byValidator`, live and spent
/// → each pool's LpPubKey → its rows); `pools` the distinct pools (LP keys) counted.
fn answerValidators(a: Allocator, svc: *Service, tp: []const u8, v: Value) !lookup.Answer {
    const keys = try hexList(a, v, 33);
    const out = try a.alloc(Value, keys.len);
    for (keys, out) |k, *o| {
        var sum: Sum = .{};
        var pools: u64 = 0;
        var seen: std.StringHashMapUnmanaged(void) = .empty;
        const prefix = try cat(a, &.{ k, tp });
        for (try svc.map("byValidator").prefixed(prefix)) |kv| {
            const op = try w.store.outpointOf(kv.key[prefix.len..]);
            const pk = try poolKey(a, tp, op.txid, op.vout);
            const cid = (try svc.map("pools").link(pk)) orelse (try svc.map("spentPools").link(pk)) orelse continue;
            const lp = try lpOf(a, svc, cid);
            // One lineage's pools share its LP key and its rows: summed once.
            if ((try seen.getOrPut(a, lp)).found_existing) continue;
            try sumUnder(a, svc, "fees", try cat(a, &.{ tp, lp }), "validator", &sum);
            pools += 1;
        }
        const se = sumEntries(sum);
        o.* = .{ .map = try a.dupe(Entry, &.{ .{ .key = "validatorIdentityKey", .value = .{ .text = try hexOf(a, k) } }, se[0], se[1], se[2], .{ .key = "pools", .value = .{ .uint = pools } } }) };
    }
    return .{ .freeform = .{ .array = out } };
}

/// `{commissionPkhs}`: per key hash `{commissionPkh, sats, tokens, swaps}` — the commissions the
/// Swaps naming it paid (`byCommission`).
fn answerCommissions(a: Allocator, svc: *Service, tp: []const u8, v: Value) !lookup.Answer {
    const keys = try hexList(a, v, 20);
    const out = try a.alloc(Value, keys.len);
    for (keys, out) |k, *o| {
        var sum: Sum = .{};
        try sumUnder(a, svc, "byCommission", try cat(a, &.{ k, tp }), "commission", &sum);
        const se = sumEntries(sum);
        o.* = .{ .map = try a.dupe(Entry, &.{ .{ .key = "commissionPkh", .value = .{ .text = try hexOf(a, k) } }, se[0], se[1], se[2] }) };
    }
    return .{ .freeform = .{ .array = out } };
}

/// `/lookup` (BRC-24, service `ls_amm_<assetId>`), every query naming its token
/// (`tokenId`, `<txid>_<vout>`): `{tokenId}` every live pool of the token;
/// `{tokenId, outpoint, beef?}` that pool (README, "Queries");
/// `{tokenId, validatorIdentityKey}` that validator's pools of the token; (0.33.0, a list in, one
/// record per key out, from the fee rows) `{tokenId, lpPubKeys}`, `{tokenId, validatorIdentityKeys}`,
/// `{tokenId, commissionPkhs}`.
pub fn answer(a: Allocator, svc: *Service, ch: *Chain, query: Value) anyerror!lookup.Answer {
    if (query != .map) return error.BadQuery;
    const topic = try topicOf(a, query.getText("tokenId") orelse return error.BadQuery);
    const tp = try topicPrefix(a, topic);
    if (query.getText("outpoint")) |text| {
        return answerOutpoint(a, svc, ch, tp, try parseOutpoint(text), query.getBool("beef") orelse false);
    }
    if (query.getText("validatorIdentityKey")) |hex| return answerValidator(a, svc, tp, hex);
    if (query.get("lpPubKeys")) |v| return answerLps(a, svc, ch, tp, v);
    if (query.get("validatorIdentityKeys")) |v| return answerValidators(a, svc, tp, v);
    if (query.get("commissionPkhs")) |v| return answerCommissions(a, svc, tp, v);
    return answerAll(a, svc, tp);
}

/// The service: its maps, its index, the queries, the hooks, and (skein-overlay 0.12.0) its beat
/// body at the beacon's declaration — wired only where the engine's lookup module has it.
pub const spec: lookup.Spec = if (@hasField(lookup.Spec, "beat")) .{
    .maps = &maps,
    // Its index, whatever name it is served as (skein-overlay 0.11.0): the head `<app>/ls_amm`, as before.
    .index = service_name,
    .answer = answer,
    .admitted = admitted,
    .spent = spent,
    .rejected = rejected,
    .beat = beat,
} else .{
    .maps = &maps,
    .index = service_name,
    .answer = answer,
    .admitted = admitted,
    .spent = spent,
    .rejected = rejected,
};
