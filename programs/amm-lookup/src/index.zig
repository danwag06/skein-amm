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
/// The pool id (0.40.0, David Case 2026-11-05): the deploy's outpoint (36 bytes, txid ‖ vout BE,
/// as the index keys outpoints), assigned here at the deploy and copied forward at each admitted
/// Swap (`poolId` in every pool record, with `swaps`: 0 at the deploy, +1 per Swap); the LP public
/// key is a field, a lookup key nowhere.
/// The fee rows (0.33.0; 0.40.0 by pool id): `fees`: `tp ‖ poolId ‖ swap txid → <the Swap's event
/// record>`, one per Swap admitted; `byCommission`: `commissionPkh ‖ tp ‖ swap txid → <the same
/// record>` when the commission is not 0. `rescinded`: `tp ‖ poolId → <the rescinded pool's
/// record>`, the output a validator's Rescind of a listed pool wrote (not listed: the LP's Close
/// acts on it), removed when the Rescind is rejected.
/// `byPool` (0.40.0, was 0.33.0's `byLp`): `tp ‖ poolId ‖ outpoint → null`, every listed hop of the
/// pool, live or spent, removed only when the transaction that listed it is rejected; `byValidator`
/// likewise (its single-key query still answers the live pools only).
/// The pool history (0.40.0, David Case 2026-11-05): one EVENT RECORD per deploy, Swap, close and
/// rescind, `{kind: "deploy"|"swap"|"close"|"rescind", poolId, txid, at, swaps, outpoint?,
/// bsvReserve?, tokenReserve?, lpPubKey, liquidityFeeBps, validationFeeBps, commissionBps,
/// validatorIdentityKey}` (`at` the admitting step's time in ms; the outpoint and reserves the pool's
/// after the event, none for a close); a Swap's carries its trade fields too (`lp`, `validator`,
/// `commission`, `bsvIn`, `commissionPkh`, `side`, `amountIn`, `amountOut`, `payoutPkh`): ONE record
/// linked from `history`, `fees` and `trades`. `history`: `tp ‖ poolId ‖ at (u64 BE) ‖ swaps (u64
/// BE) → <event>`; `closes`: `tp ‖ at (u64 BE) ‖ poolId → <event>` for a close or a rescind;
/// `trades`: `tp ‖ at (u64 BE) ‖ swap txid → <the Swap's event>`. A rejection removes every row its
/// transaction wrote. Nothing derived is stored.
pub const maps = [_][]const u8{ "pools", "byValidator", "spentPools", "beat", "fees", "byCommission", "rescinded", "byPool", "trades", "history", "closes" };

/// The step's time (ms), the clock of the step whose hook this call runs in: the in-VM call input's
/// `now` (skein docs/VM.md, "call": the time of the entry that drove the step; replay-exact), set by
/// main.zig before the hook runs. A trade row's `at`.
pub var now_ms: u64 = 0;

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
    /// The pool's id (0.40.0): its deploy's outpoint key; `poolAt` sets the output's own, the
    /// caller copies a Swap's from the pool it spent.
    pool_id: [36]u8,
    /// The pool's Swaps: 0 at the deploy, +1 per Swap (0.40.0).
    swaps: u64 = 0,
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
        .pool_id = w.store.outpointKey(txid, vout),
    };
}

fn intValue(v: i64) Value {
    return if (v >= 0) .{ .uint = @intCast(v) } else .{ .nint = @intCast(-1 - v) };
}

/// The record stored under `pools`' value (its own CID, linked from the
/// map): every field pool.zig parses but the ValidatorPubKey, plus (0.40.0) `poolId`, `swaps`
/// and `admittedAt` (the admitting step's time, `now_ms`).
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
        .{ .key = "poolId", .value = .{ .bytes = try a.dupe(u8, &pf.pool_id) } },
        .{ .key = "swaps", .value = .{ .uint = pf.swaps } },
        .{ .key = "admittedAt", .value = .{ .uint = now_ms } },
    }) };
}

fn intOf(v: ?Value) !i64 {
    const x = v orelse return error.BadIndex;
    return switch (x) {
        .uint => |n| std.math.cast(i64, n) orelse error.BadIndex,
        .nint => |n| -1 - (std.math.cast(i64, n) orelse return error.BadIndex),
        else => error.BadIndex,
    };
}

fn bytesN(comptime n: usize, rec: Value, key: []const u8) ![n]u8 {
    const b = rec.getBytes(key) orelse return error.BadIndex;
    if (b.len != n) return error.BadIndex;
    return b[0..n].*;
}

/// A pool record's id (0.40.0).
fn poolIdOf(rec: Value) ![36]u8 {
    return bytesN(36, rec, "poolId");
}

/// A pool record (`recordValue`) read back as its fields.
fn fieldsOf(rec: Value) !PoolFields {
    return .{
        .txid = try bytesN(32, rec, "txid"),
        .vout = std.math.cast(u32, rec.getUint("vout") orelse return error.BadIndex) orelse return error.BadIndex,
        .bsv_reserve = rec.getUint("bsvReserve") orelse return error.BadIndex,
        .token_reserve = rec.getUint("tokenReserve") orelse return error.BadIndex,
        .liquidity_fee_bps = try intOf(rec.get("liquidityFeeBps")),
        .validation_fee_bps = try intOf(rec.get("validationFeeBps")),
        .commission_bps = try intOf(rec.get("commissionBps")),
        .lp = try bytesN(33, rec, "lpPubKey"),
        .identity = try bytesN(33, rec, "validatorIdentityKey"),
        .pool_id = try poolIdOf(rec),
        .swaps = rec.getUint("swaps") orelse return error.BadIndex,
    };
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
    try svc.map("byPool").add(try byPoolKey(a, tp, &try poolIdOf(try svc.store.getValue(a, cid)), txid, vout));
}

/// `byPool`'s key (0.40.0): `tp ‖ poolId ‖ outpoint`.
fn byPoolKey(a: Allocator, tp: []const u8, pid: []const u8, txid: [32]u8, vout: u32) ![]u8 {
    return cat(a, &.{ tp, pid, &w.store.outpointKey(txid, vout) });
}

fn putPool(a: Allocator, svc: *Service, tp: []const u8, pf: PoolFields) !void {
    try linkPool(a, svc, tp, pf.txid, pf.vout, try svc.store.putValue(a, try recordValue(a, pf)));
}

/// Drop a live pool; → its record's CID, when it was indexed. Its `byValidator` and `byPool`
/// memberships stay (0.33.0: a spent pool is still that validator's and that pool's; `rejected` drops them).
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
/// `admitted`) of the same key with the Rescind method. → that listed pool's record (0.40.0: the
/// rescinded record keeps its id).
fn rescindOf(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx, lp: [33]u8) !?Value {
    const p = pool.poolOfScript(tx.tx.outputs[0].locking_script.bytes) orelse return null;
    if (!p.rescinded()) return null;
    for (tx.tx.inputs) |in| {
        if (pool.methodOf(in.unlocking_script.bytes) != .rescind) continue;
        const op = in.previous_outpoint;
        const cid = (try svc.map("pools").link(try poolKey(a, tp, op.txid.bytes, op.index))) orelse continue;
        const rec = try svc.store.getValue(a, cid);
        if (std.mem.eql(u8, rec.getBytes("lpPubKey") orelse continue, &lp)) return rec;
    }
    return null;
}

/// Why a pool output is listed (`listedAt`): an affirmed deploy, or the Swap continuation of the
/// listed pool input `swap` spends.
const Listing = union(enum) { deploy, swap: usize };

// ---------------------------------------------------------------- the events (0.40.0): fee rows, trade rows, the history

fn feeKey(a: Allocator, tp: []const u8, pid: []const u8, txid: [32]u8) ![]u8 {
    return cat(a, &.{ tp, pid, &txid });
}

fn commissionKey(a: Allocator, pkh: []const u8, tp: []const u8, txid: [32]u8) ![]u8 {
    return cat(a, &.{ pkh, tp, &txid });
}

fn be64(n: u64) [8]u8 {
    var b: [8]u8 = undefined;
    std.mem.writeInt(u64, &b, n, .big);
    return b;
}

fn tradeKey(a: Allocator, tp: []const u8, at: u64, txid: [32]u8) ![]u8 {
    return cat(a, &.{ tp, &be64(at), &txid });
}

/// `history`'s key: `tp ‖ poolId ‖ at (u64 BE) ‖ swaps (u64 BE)`.
fn historyKey(a: Allocator, tp: []const u8, pid: []const u8, at: u64, swaps: u64) ![]u8 {
    return cat(a, &.{ tp, pid, &be64(at), &be64(swaps) });
}

/// `closes`' key: `tp ‖ at (u64 BE) ‖ poolId`.
fn closesKey(a: Allocator, tp: []const u8, at: u64, pid: []const u8) ![]u8 {
    return cat(a, &.{ tp, &be64(at), pid });
}

/// The least key above every key starting with `prefix` (a map key here always starts with the
/// topic's length byte, below 0xff, so there is one).
fn above(a: Allocator, prefix: []const u8) ![]const u8 {
    const buf = try a.alloc(u8, prefix.len);
    return w.store.mst.successor(buf, prefix) orelse error.BadIndex;
}

/// An event record's own fields (0.40.0): `{kind, poolId, txid, at, swaps, outpoint?, bsvReserve?,
/// tokenReserve?, lpPubKey, liquidityFeeBps, validationFeeBps, commissionBps,
/// validatorIdentityKey}`, `at` the step's time (`now_ms`), `txid` the event's transaction; `pf` the
/// pool after the event (`with_output`: its outpoint and reserves) or, for a close, the pool it ended.
fn eventFields(a: Allocator, kind: []const u8, pf: PoolFields, txid: [32]u8, with_output: bool) !std.ArrayList(Entry) {
    var es: std.ArrayList(Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = kind } },
        .{ .key = "poolId", .value = .{ .bytes = try a.dupe(u8, &pf.pool_id) } },
        .{ .key = "txid", .value = .{ .bytes = try a.dupe(u8, &txid) } },
        .{ .key = "at", .value = .{ .uint = now_ms } },
        .{ .key = "swaps", .value = .{ .uint = pf.swaps } },
    });
    if (with_output) try es.appendSlice(a, &.{
        .{ .key = "outpoint", .value = .{ .bytes = try a.dupe(u8, &w.store.outpointKey(pf.txid, pf.vout)) } },
        .{ .key = "bsvReserve", .value = .{ .uint = pf.bsv_reserve } },
        .{ .key = "tokenReserve", .value = .{ .uint = pf.token_reserve } },
    });
    try es.appendSlice(a, &.{
        .{ .key = "lpPubKey", .value = .{ .bytes = try a.dupe(u8, &pf.lp) } },
        .{ .key = "liquidityFeeBps", .value = intValue(pf.liquidity_fee_bps) },
        .{ .key = "validationFeeBps", .value = intValue(pf.validation_fee_bps) },
        .{ .key = "commissionBps", .value = intValue(pf.commission_bps) },
        .{ .key = "validatorIdentityKey", .value = .{ .bytes = try a.dupe(u8, &pf.identity) } },
    });
    return es;
}

/// An event record (`cid`) under `history`, and (a close or a rescind) under `closes`.
fn linkEvent(a: Allocator, svc: *Service, tp: []const u8, pf: PoolFields, cid: []const u8, ends: bool) !void {
    try svc.map("history").putLink(try historyKey(a, tp, &pf.pool_id, now_ms, pf.swaps), cid);
    if (ends) try svc.map("closes").putLink(try closesKey(a, tp, now_ms, &pf.pool_id), cid);
}

/// An event that is not a Swap (deploy, close, rescind): written and linked.
fn putEvent(a: Allocator, svc: *Service, tp: []const u8, kind: []const u8, pf: PoolFields, txid: [32]u8, with_output: bool) !void {
    const es = try eventFields(a, kind, pf, txid, with_output);
    const ends = !std.mem.eql(u8, kind, "deploy");
    try linkEvent(a, svc, tp, pf, try svc.store.putValue(a, .{ .map = es.items }), ends);
}

/// The Swap `tx` (its pool input `input`, its continuation `cont` at output 0 with the pool's id and
/// swap count, the listed pool it spent `was`): its EVENT RECORD (0.40.0; 0.36.0's trade row grown)
/// — the event's fields and the trade's: the fees (src/pool.zig `feesOf`'s, read where the relay's
/// pair check lays them out, `feeLayout`), the amount in (the call's), the amount out (the change of
/// the other asset's reserve between `was` and the continuation), `payoutPkh` (the call's
/// `userPkh`) — under `fees` (`tp ‖ poolId ‖ txid`), `trades` (time) and `history`, and (a
/// commission not 0) its membership under the commission's key hash. A Swap whose fee outputs are
/// not the contract's writes nothing.
fn putTrade(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx, input: usize, cont: PoolFields, was: Value) !void {
    const f = (try pool.feesOf(a, tx.tx, input)) orelse return;
    const call = (try pool.parseSwapCall(a, tx.tx.inputs[input].unlocking_script.bytes)) orelse return;
    const before = if (f.bsv_in) was.getUint("tokenReserve") orelse return error.BadIndex else was.getUint("bsvReserve") orelse return error.BadIndex;
    const after = if (f.bsv_in) cont.token_reserve else cont.bsv_reserve;
    if (after > before) return;
    const fkey = try feeKey(a, tp, &cont.pool_id, tx.txid);
    // A re-admission of the same Swap (a dupe hook call): its earlier time rows go, one row stays.
    if (try svc.map("fees").link(fkey)) |old| if ((try svc.store.getValue(a, old)).getUint("at")) |at0| {
        _ = try svc.map("trades").remove(try tradeKey(a, tp, at0, tx.txid));
        _ = try svc.map("history").remove(try historyKey(a, tp, &cont.pool_id, at0, cont.swaps));
    };
    var es = try eventFields(a, "swap", cont, tx.txid, true);
    try es.appendSlice(a, &.{
        .{ .key = "lp", .value = .{ .uint = f.lp } },
        .{ .key = "validator", .value = .{ .uint = f.validator } },
        .{ .key = "commission", .value = .{ .uint = f.commission } },
        .{ .key = "bsvIn", .value = .{ .boolean = f.bsv_in } },
        .{ .key = "commissionPkh", .value = .{ .bytes = try a.dupe(u8, &f.commission_pkh) } },
        .{ .key = "side", .value = .{ .text = if (f.bsv_in) "buy" else "sell" } },
        .{ .key = "amountIn", .value = .{ .uint = call.amount_in } },
        .{ .key = "amountOut", .value = .{ .uint = before - after } },
        .{ .key = "payoutPkh", .value = .{ .bytes = try a.dupe(u8, call.user_pkh) } },
    });
    const rec = try svc.store.putValue(a, .{ .map = es.items });
    try svc.map("fees").putLink(fkey, rec);
    try svc.map("trades").putLink(try tradeKey(a, tp, now_ms, tx.txid), rec);
    try linkEvent(a, svc, tp, cont, rec, false);
    if (f.commission > 0) try svc.map("byCommission").putLink(try commissionKey(a, &f.commission_pkh, tp, tx.txid), rec);
}

/// A rejected Swap's fee row, its time row and its commission membership, gone (the pool id from
/// its continuation's record at output 0, live or spent; the key hash and the time from the row).
/// Its `history` row goes with its continuation's record (`rejected`).
fn removeTrade(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx) !void {
    if (tx.tx.outputs.len == 0) return;
    const k0 = try poolKey(a, tp, tx.txid, 0);
    const pc = (try svc.map("pools").link(k0)) orelse (try svc.map("spentPools").link(k0)) orelse return;
    const pid = try poolIdOf(try svc.store.getValue(a, pc));
    const key = try feeKey(a, tp, &pid, tx.txid);
    const cid = (try svc.map("fees").link(key)) orelse return;
    const rec = try svc.store.getValue(a, cid);
    _ = try svc.map("fees").remove(key);
    if (rec.getUint("at")) |at| _ = try svc.map("trades").remove(try tradeKey(a, tp, at, tx.txid));
    if (rec.getBytes("commissionPkh")) |pkh| _ = try svc.map("byCommission").remove(try commissionKey(a, pkh, tp, tx.txid));
}

/// A pool's last event: the `history` row with the greatest key under `tp ‖ poolId` (one descent).
const LastEvent = struct { key: []const u8, rec: Value };
fn lastEvent(a: Allocator, svc: *Service, tp: []const u8, pid: []const u8) !?LastEvent {
    const prefix = try cat(a, &.{ tp, pid });
    const kv = (try svc.map("history").floor(try cat(a, &.{ prefix, &([_]u8{0xff} ** 16) }))) orelse return null;
    if (!std.mem.startsWith(u8, kv.key, prefix) or kv.value != .cid) return null;
    return .{ .key = kv.key, .rec = try svc.store.getValue(a, kv.value.cid) };
}

// ---------------------------------------------------------------- hooks (#50)

/// A topic admitted `tx`: when its pools pass the pool checks (`judge`),
/// index every admitted output that is a listed pool (`listedAt`: an affirmed deploy's, or the
/// continuation of a listed pool). A pool that fails, or a deploy without a verified
/// affirmation, is not indexed (and so not searchable); it stays a valid token output in the
/// topic. Each listed pool's event (0.40.0): a deploy's (its own outpoint the pool id, 0 swaps), a
/// Swap's (the id copied from the pool it spent, swaps + 1); a validator's Rescind its `rescind`
/// event and the rescinded record (the id of the pool it rescinded). Then the beat, when the listed
/// totals changed.
pub fn admitted(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx, outputs_to_admit: []const u32, _: []const u32) anyerror!void {
    const id = tokenIdOf(topic) orelse return; // not a token topic: nothing of ours
    if (outputs_to_admit.len == 0) return;
    if (try judge(a, id, tx, outputs_to_admit) != null) return;
    const tp = try topicPrefix(a, topic);
    for (outputs_to_admit) |vout| {
        if (vout >= tx.tx.outputs.len) continue;
        const o = tx.tx.outputs[vout];
        var pf = poolAt(tx.txid, vout, o.locking_script.bytes, @intCast(o.satoshis)) orelse continue;
        if (vout == 0) if (try rescindOf(a, svc, tp, tx, pf.lp)) |was| {
            // The rescinded pool's record (`recordValue`: txid, vout, its reserves and fees, the id
            // of the pool it rescinded): what the Close takes back.
            pf.pool_id = try poolIdOf(was);
            pf.swaps = was.getUint("swaps") orelse return error.BadIndex;
            try svc.map("rescinded").putLink(try cat(a, &.{ tp, &pf.pool_id }), try svc.store.putValue(a, try recordValue(a, pf)));
            try putEvent(a, svc, tp, "rescind", pf, tx.txid, true);
            continue;
        };
        const why = (try listedAt(a, svc, tp, tx, vout)) orelse continue;
        switch (why) {
            // The event first: it reads the spent pool's reserves before the continuation is indexed.
            .swap => |i| {
                const op = tx.tx.inputs[i].previous_outpoint;
                const was = try svc.store.getValue(a, (try svc.map("pools").link(try poolKey(a, tp, op.txid.bytes, op.index))).?);
                pf.pool_id = try poolIdOf(was);
                pf.swaps = (was.getUint("swaps") orelse return error.BadIndex) + 1;
                try putTrade(a, svc, tp, tx, i, pf, was);
            },
            .deploy => {
                // A re-admission (a dupe hook call): its earlier event row goes.
                if (try svc.map("pools").link(try poolKey(a, tp, tx.txid, vout))) |old| if ((try svc.store.getValue(a, old)).getUint("admittedAt")) |at0| {
                    _ = try svc.map("history").remove(try historyKey(a, tp, &pf.pool_id, at0, 0));
                };
                try putEvent(a, svc, tp, "deploy", pf, tx.txid, true);
            },
        }
        try putPool(a, svc, tp, pf);
    }
    try beatIfChanged(a, svc);
}

/// A previous coin was consumed: if it was a pool we indexed, it leaves
/// `pools` for `spentPools` (where `rejected` finds it). Its continuation
/// (if the spend admits one: a Swap) arrives through its own `admitted` call —
/// skein does not fold the two (docs/OVERLAY.md, "The lookup contract"). A Close (the LP's) or a
/// Rescind (the validator's, 0.13.0) lists none: the pool leaves the listing. 0.40.0: when the
/// spender lists no continuation of that pool (`admitted` ran first) and is not its Rescind (whose
/// event `admitted` wrote), the pool's `close` event.
pub fn spent(a: Allocator, svc: *Service, topic: []const u8, outpoint: lookup.Outpoint, spender: lookup.Tx) anyerror!void {
    const tp = try topicPrefix(a, topic);
    if (try removePool(a, svc, tp, outpoint.txid, outpoint.vout)) |cid| {
        try svc.map("spentPools").putLink(try poolKey(a, tp, outpoint.txid, outpoint.vout), cid);
        const pf = try fieldsOf(try svc.store.getValue(a, cid));
        const continued = if (try svc.map("pools").link(try poolKey(a, tp, spender.txid, 0))) |c|
            std.mem.eql(u8, &(try poolIdOf(try svc.store.getValue(a, c))), &pf.pool_id)
        else
            false;
        const rescinded = if (try svc.map("rescinded").link(try cat(a, &.{ tp, &pf.pool_id }))) |r|
            std.mem.eql(u8, (try svc.store.getValue(a, r)).getBytes("txid") orelse "", &spender.txid)
        else
            false;
        if (!continued and !rescinded) try putEvent(a, svc, tp, "close", pf, spender.txid, false);
    }
    try beatIfChanged(a, svc);
}

/// A judgement of `topic` was removed by a rejection: `tx`'s own pools are
/// gone (live or spent), and the checked pools `tx` had spent are live
/// again. Skein calls only `rejected(topic, tx)` (docs/OVERLAY.md,
/// "Settlement: `admits` propagates") — it does not re-call `admitted` for
/// the coins a rejection gives back — so they come back from `spentPools`,
/// as indexed (and checked) when first admitted. Every row `tx` wrote goes (0.40.0): its Swap's
/// fee, trade and commission rows, its pools' `byValidator`, `byPool` and `history` rows (a deploy's
/// or a Swap's event), and the end row it wrote for a pool it spent (its close, or its rescind with
/// the rescinded record), from `history` and `closes`.
pub fn rejected(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx) anyerror!void {
    const tp = try topicPrefix(a, topic);
    try removeTrade(a, svc, tp, tx);
    for (0..tx.tx.outputs.len) |vout| {
        const key = try poolKey(a, tp, tx.txid, @intCast(vout));
        const was = (try removePool(a, svc, tp, tx.txid, @intCast(vout))) orelse try svc.map("spentPools").link(key);
        _ = try svc.map("spentPools").remove(key);
        // 0.33.0: the rejected transaction's pools leave `byValidator` and `byPool` (a spend keeps them there).
        if (was) |cid| {
            const rec = try svc.store.getValue(a, cid);
            const pid = try poolIdOf(rec);
            _ = try svc.map("byValidator").remove(try identityKey(a, try identityOf(a, svc, cid), tp, tx.txid, @intCast(vout)));
            _ = try svc.map("byPool").remove(try byPoolKey(a, tp, &pid, tx.txid, @intCast(vout)));
            if (rec.getUint("admittedAt")) |at| _ = try svc.map("history").remove(try historyKey(a, tp, &pid, at, rec.getUint("swaps") orelse 0));
        }
    }
    for (tx.tx.inputs) |in| {
        const txid = in.previous_outpoint.txid.bytes;
        const vout = in.previous_outpoint.index;
        const key = try poolKey(a, tp, txid, vout);
        const cid = (try svc.map("spentPools").link(key)) orelse continue;
        const pid = try poolIdOf(try svc.store.getValue(a, cid));
        if (try lastEvent(a, svc, tp, &pid)) |ev| if (std.mem.eql(u8, ev.rec.getBytes("txid") orelse "", &tx.txid)) {
            const kind = ev.rec.getText("kind") orelse "";
            const is_rescind = std.mem.eql(u8, kind, "rescind");
            if (is_rescind or std.mem.eql(u8, kind, "close")) {
                _ = try svc.map("history").remove(ev.key);
                _ = try svc.map("closes").remove(try closesKey(a, tp, ev.rec.getUint("at") orelse return error.BadIndex, &pid));
                if (is_rescind) _ = try svc.map("rescinded").remove(try cat(a, &.{ tp, &pid }));
            }
        };
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

/// A pool id's text (0.40.0): the deploy's outpoint, `<txid>_<vout>`.
pub fn poolIdText(a: Allocator, pid: []const u8) ![]const u8 {
    const op = try w.store.outpointOf(pid);
    return outpointStr(a, op.txid, op.vout);
}

/// The engine's PoolState shape (amm-poc-engine/web/engine/src/types.ts)
/// plus the outpoint string, the pool's commissionBps, (0.34.0) its LpPubKey (hex) and (0.40.0) its
/// id (`poolId`, `<txid>_<vout>`) and `swaps`, from an indexed record. (0.34.0: no `lastSeen`: the
/// liveness join is the host's, D11.)
fn poolStateValue(a: Allocator, rec: Value, outpoint: []const u8) !Value {
    const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
    const lp = rec.getBytes("lpPubKey") orelse return error.BadIndex;
    var es: std.ArrayList(Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "poolId", .value = .{ .text = try poolIdText(a, &try poolIdOf(rec)) } },
        .{ .key = "lpPubKey", .value = .{ .text = try hexOf(a, lp) } },
        .{ .key = "outpoint", .value = .{ .text = outpoint } },
        .{ .key = "bsvReserve", .value = rec.get("bsvReserve") orelse return error.BadIndex },
        .{ .key = "tokenReserve", .value = rec.get("tokenReserve") orelse return error.BadIndex },
        .{ .key = "liquidityFeeBps", .value = rec.get("liquidityFeeBps") orelse return error.BadIndex },
        .{ .key = "validationFeeBps", .value = rec.get("validationFeeBps") orelse return error.BadIndex },
        .{ .key = "commissionBps", .value = rec.get("commissionBps") orelse return error.BadIndex },
        .{ .key = "validatorIdentityKey", .value = .{ .text = try hexOf(a, identity) } },
        .{ .key = "swaps", .value = .{ .uint = rec.getUint("swaps") orelse return error.BadIndex } },
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

/// A list of pool ids (a query's `poolIds`, 0.40.0): `<txid>_<vout>` each, as outpoint keys.
fn poolIdList(a: Allocator, v: Value) ![]const [36]u8 {
    if (v != .array) return error.BadQuery;
    const out = try a.alloc([36]u8, v.array.len);
    for (v.array, out) |x, *o| {
        if (x != .text) return error.BadQuery;
        const op = try parseOutpoint(x.text);
        o.* = w.store.outpointKey(op.txid, op.vout);
    }
    return out;
}

/// A list of hex keys of `len` bytes (a query's `validatorIdentityKeys`, `commissionPkhs`).
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

/// `{poolIds}` (0.40.0, was `{lpPubKeys}`): per pool id `{poolId, lpPubKey, status, outpoint?,
/// current?, sats, tokens, swaps}` — the LP fees of its Swaps (`fees` under the id) and its state:
/// `live` (its live hop: `outpoint`, `current` the `PoolState`), `rescinded` (the validator's
/// Rescind wrote `outpoint`, unspent in the chain state: the LP's Close acts on it; `current` that
/// output's pool state), else `closed` (spent, or no pool of the id here: an unknown id answers
/// `closed` with zeros and `lpPubKey` null). The live hop is found through `byPool` (the pool's
/// hops, live and spent; the live one in `pools`); with none live, rescinded is told from closed by
/// the `rescinded` record of the id and the chain state: unspent (`spentBy` none) is rescinded,
/// spent (the LP's Close) or no record is closed.
fn answerPools(a: Allocator, svc: *Service, ch: *Chain, tp: []const u8, v: Value) !lookup.Answer {
    const ids = try poolIdList(a, v);
    const out = try a.alloc(Value, ids.len);
    for (ids, out) |*pid, *o| {
        var sum: Sum = .{};
        try sumUnder(a, svc, "fees", try cat(a, &.{ tp, pid }), "lp", &sum);
        var es: std.ArrayList(Entry) = .empty;
        try es.append(a, .{ .key = "poolId", .value = .{ .text = try poolIdText(a, pid) } });
        var lp: Value = .null;
        var status: []const u8 = "closed";
        // The pool's listed hops (`byPool`, live and spent): the live one is in `pools`.
        const prefix = try cat(a, &.{ tp, pid });
        for (try svc.map("byPool").prefixed(prefix)) |kv| {
            const op = try w.store.outpointOf(kv.key[prefix.len..]);
            const pk = try poolKey(a, tp, op.txid, op.vout);
            const cid = (try svc.map("pools").link(pk)) orelse {
                if (lp == .null) if (try svc.map("spentPools").link(pk)) |sc| {
                    lp = .{ .text = try hexOf(a, (try svc.store.getValue(a, sc)).getBytes("lpPubKey") orelse return error.BadIndex) };
                };
                continue;
            };
            const rec = try svc.store.getValue(a, cid);
            const text = try outpointStr(a, op.txid, op.vout);
            status = "live";
            lp = .{ .text = try hexOf(a, rec.getBytes("lpPubKey") orelse return error.BadIndex) };
            try es.appendSlice(a, &.{
                .{ .key = "outpoint", .value = .{ .text = text } },
                .{ .key = "current", .value = try poolStateValue(a, rec, text) },
            });
            break;
        }
        if (std.mem.eql(u8, status, "closed")) if (try svc.map("rescinded").link(prefix)) |rc| {
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
        try es.insert(a, 1, .{ .key = "lpPubKey", .value = lp });
        try es.append(a, .{ .key = "status", .value = .{ .text = status } });
        try es.appendSlice(a, &sumEntries(sum));
        o.* = .{ .map = es.items };
    }
    return .{ .freeform = .{ .array = out } };
}

/// `{validatorIdentityKeys}`: per key `{validatorIdentityKey, sats, tokens, swaps, pools}` — the
/// validator fees over the fee rows of all its pools, closed included (`byValidator`, live and spent
/// → each pool's id → its rows); `pools` the distinct pools counted.
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
            const pid = try a.dupe(u8, &try poolIdOf(try svc.store.getValue(a, cid)));
            // One pool's hops share its id and its rows: summed once.
            if ((try seen.getOrPut(a, pid)).found_existing) continue;
            try sumUnder(a, svc, "fees", try cat(a, &.{ tp, pid }), "validator", &sum);
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

// ---------------------------------------------------------------- the history reads (0.36.0, D1–D3)

/// A trade row as read: its time, its Swap's txid, its record (`putTrade`).
pub const Trade = struct { at: u64, txid: [32]u8, rec: Value };

/// A price: `sats` per `tokens` token units (base units both), exact (no floats in the program).
pub const Price = struct {
    sats: u64,
    tokens: u64,

    /// x < y, by cross multiplication.
    pub fn lt(x: Price, y: Price) bool {
        return @as(u128, x.sats) * y.tokens < @as(u128, y.sats) * x.tokens;
    }
};

/// A trade's price, from its amounts by side: a `buy` (sats in) paid `amountIn` sats for `amountOut`
/// tokens, a `sell` got `amountOut` sats for `amountIn` tokens. Null for a row with no tokens.
pub fn priceOf(rec: Value) ?Price {
    const in = rec.getUint("amountIn") orelse return null;
    const out = rec.getUint("amountOut") orelse return null;
    const buy = std.mem.eql(u8, rec.getText("side") orelse "", "buy");
    const p: Price = if (buy) .{ .sats = in, .tokens = out } else .{ .sats = out, .tokens = in };
    return if (p.tokens == 0) null else p;
}

/// A trade's volume in each asset: what moved on its sats side and on its token side.
fn volumeOf(rec: Value) struct { sats: u64, tokens: u64 } {
    const p = priceOf(rec) orelse return .{ .sats = 0, .tokens = 0 };
    return .{ .sats = p.sats, .tokens = p.tokens };
}

fn tradeAt(a: Allocator, svc: *Service, tp: []const u8, kv: anytype) !Trade {
    if (kv.key.len != tp.len + 40 or kv.value != .cid) return error.BadIndex;
    return .{
        .at = std.mem.readInt(u64, kv.key[tp.len..][0..8], .big),
        .txid = kv.key[tp.len + 8 ..][0..32].*,
        .rec = try svc.store.getValue(a, kv.value.cid),
    };
}

/// The token's (`tp`) trade rows with `from ≤ at < to` (null: unbounded), oldest first (the
/// `trades` map's order: time, then txid): one range read of the window (0.40.0).
fn tradesIn(a: Allocator, svc: *Service, tp: []const u8, from: ?u64, to: ?u64) ![]Trade {
    const lo = try cat(a, &.{ tp, &be64(from orelse 0) });
    const hi = if (to) |t| try cat(a, &.{ tp, &be64(t) }) else try above(a, tp);
    const kvs = try svc.map("trades").range(lo, hi);
    const out = try a.alloc(Trade, kvs.len);
    for (kvs, out) |kv, *o| o.* = try tradeAt(a, svc, tp, kv);
    return out;
}

/// The token's last trade row at or before `at`, or null: one descent (`Map.floor`, 0.40.0).
fn tradeAtOrBefore(a: Allocator, svc: *Service, tp: []const u8, at: u64) !?Trade {
    const kv = (try svc.map("trades").floor(try cat(a, &.{ tp, &be64(at), &([_]u8{0xff} ** 32) }))) orelse return null;
    if (!std.mem.startsWith(u8, kv.key, tp) or kv.key.len != tp.len + 40) return null;
    return try tradeAt(a, svc, tp, kv);
}

/// (at, txid) order.
fn tradeLt(x: Trade, y: Trade) bool {
    if (x.at != y.at) return x.at < y.at;
    return std.mem.order(u8, &x.txid, &y.txid) == .lt;
}

/// A page cursor: the last row's `at ‖ txid`.
pub const Cursor = struct { at: u64, txid: [32]u8 };

pub const TradeQuery = struct {
    /// `from ≤ at < to` (null: unbounded).
    from: ?u64 = null,
    to: ?u64 = null,
    limit: usize = 100,
    /// Rows strictly older than this (at, txid): the next page.
    before: ?Cursor = null,
    /// One pool's rows only (0.40.0, was `lp`): its Swap events in `history`.
    pool: ?[36]u8 = null,
};

/// `/trades`: the token's trade rows, newest first, `q.limit` at most; read from the window alone
/// (0.40.0): the `trades` range `[from, min(to, before))`, or (one pool) its `history` range `[from,
/// to)`, its Swap events.
pub fn trades(a: Allocator, svc: *Service, tp: []const u8, q: TradeQuery) ![]Trade {
    var rows: []Trade = undefined;
    if (q.pool) |pid| {
        const prefix = try cat(a, &.{ tp, &pid });
        const lo = try cat(a, &.{ prefix, &be64(q.from orelse 0) });
        const hi = if (q.to) |t| try cat(a, &.{ prefix, &be64(t) }) else try above(a, prefix);
        var list: std.ArrayList(Trade) = .empty;
        for (try svc.map("history").range(lo, hi)) |kv| {
            if (kv.value != .cid) return error.BadIndex;
            const rec = try svc.store.getValue(a, kv.value.cid);
            if (!std.mem.eql(u8, rec.getText("kind") orelse "", "swap")) continue;
            try list.append(a, .{ .at = rec.getUint("at") orelse return error.BadIndex, .txid = try bytesN(32, rec, "txid"), .rec = rec });
        }
        std.mem.sort(Trade, list.items, {}, struct {
            fn f(_: void, x: Trade, y: Trade) bool {
                return tradeLt(x, y);
            }
        }.f);
        rows = list.items;
    } else {
        var to = q.to;
        if (q.before) |b| to = if (to) |t| @min(t, b.at +| 1) else b.at +| 1;
        rows = try tradesIn(a, svc, tp, q.from, to);
    }
    var out: std.ArrayList(Trade) = .empty;
    var i = rows.len;
    while (i > 0 and out.items.len < q.limit) {
        i -= 1;
        const r = rows[i];
        if (q.before) |b| if (!tradeLt(r, .{ .at = b.at, .txid = b.txid, .rec = .null })) continue;
        try out.append(a, r);
    }
    return out.items;
}

/// `/trades?txid=`: the trade row of the Swap `txid` (its pool id from its continuation's record at
/// output 0, live or spent); null none.
pub fn tradeOf(a: Allocator, svc: *Service, tp: []const u8, txid: [32]u8) !?Trade {
    const k0 = try poolKey(a, tp, txid, 0);
    const pc = (try svc.map("pools").link(k0)) orelse (try svc.map("spentPools").link(k0)) orelse return null;
    const pid = try poolIdOf(try svc.store.getValue(a, pc));
    const cid = (try svc.map("fees").link(try feeKey(a, tp, &pid, txid))) orelse return null;
    const rec = try svc.store.getValue(a, cid);
    return .{ .at = rec.getUint("at") orelse return null, .txid = txid, .rec = rec };
}

/// One candle: the bucket starting at `t` (ms, a multiple of the resolution), its open, high, low and
/// close prices (the first, highest, lowest, last trade's), the volume on each side, the trade count.
pub const Candle = struct { t: u64, o: Price, h: Price, l: Price, c: Price, volume_sats: u64, volume_tokens: u64, n: u64 };

/// The most buckets one `/candles` window may span.
pub const max_buckets = 5000;

/// `/candles` (D2): the token's trade rows with `from ≤ at < to`, one candle per NON-EMPTY bucket of
/// `tf` ms (buckets aligned to multiples of `tf` since the epoch), oldest first, across all pools.
/// `error.TooManyBuckets` when the window spans more than `max_buckets` buckets.
pub fn candles(a: Allocator, svc: *Service, tp: []const u8, tf: u64, from: u64, to: u64) ![]Candle {
    if (tf == 0 or to < from) return error.BadQuery;
    const start = from - from % tf;
    if ((to - start + tf - 1) / tf > max_buckets) return error.TooManyBuckets;
    var out: std.ArrayList(Candle) = .empty;
    for (try tradesIn(a, svc, tp, from, to)) |r| {
        const p = priceOf(r.rec) orelse continue;
        const v = volumeOf(r.rec);
        const t = r.at - r.at % tf;
        if (out.items.len > 0 and out.items[out.items.len - 1].t == t) {
            const c = &out.items[out.items.len - 1];
            if (c.h.lt(p)) c.h = p;
            if (p.lt(c.l)) c.l = p;
            c.c = p;
            c.volume_sats += v.sats;
            c.volume_tokens += v.tokens;
            c.n += 1;
        } else try out.append(a, .{ .t = t, .o = p, .h = p, .l = p, .c = p, .volume_sats = v.sats, .volume_tokens = v.tokens, .n = 1 });
    }
    return out.items;
}

/// `/stats` (D3): the token at `now` (ms), from its trade rows of the last 24 h and its live pools.
pub const Stats = struct {
    /// The last trade's price (0.40.0: `lastTradePrice`; the host sets `price`); null without one.
    last_trade_price: ?Price,
    /// The change from the price at the window's start (the last trade at or before it) to the last
    /// trade's, in bps (truncated toward zero); null without a trade at the window's start.
    change1h: ?i64,
    change24h: ?i64,
    volume24h_sats: u64 = 0,
    volume24h_tokens: u64 = 0,
    buys24h: u64 = 0,
    sells24h: u64 = 0,
    last_trade_at: ?u64,
    tvl_sats: u64 = 0,
    tvl_tokens: u64 = 0,
    /// Live pools.
    pools: u64 = 0,
};

pub const hour_ms: u64 = 3_600_000;
pub const day_ms: u64 = 24 * hour_ms;

/// The change from `then` to `now` in bps, truncated toward zero.
pub fn changeBps(then: Price, now: Price) i64 {
    // now/then − 1 = (now.sats·then.tokens − then.sats·now.tokens) / (then.sats·now.tokens)
    const num = @as(i256, now.sats) * then.tokens - @as(i256, then.sats) * now.tokens;
    const den = @as(i256, then.sats) * now.tokens;
    if (den == 0) return 0;
    const bps = @divTrunc(num * 10_000, den);
    return std.math.cast(i64, bps) orelse (if (bps < 0) std.math.minInt(i64) else std.math.maxInt(i64));
}

/// 0.40.0: read from the windows alone — the last trade at or before `now` and at each window's
/// start (`Map.floor`), the 24 h volumes from that window's range.
pub fn stats(a: Allocator, svc: *Service, tp: []const u8, now: u64) !Stats {
    var st: Stats = .{ .last_trade_price = null, .change1h = null, .change24h = null, .last_trade_at = null };
    const start1h = now -| hour_ms;
    const start24h = now -| day_ms;
    if (try tradeAtOrBefore(a, svc, tp, now)) |r| {
        st.last_trade_price = priceOf(r.rec);
        st.last_trade_at = r.at;
    }
    for (try tradesIn(a, svc, tp, start24h + 1, now +| 1)) |r| {
        if (priceOf(r.rec) == null) continue;
        const v = volumeOf(r.rec);
        st.volume24h_sats += v.sats;
        st.volume24h_tokens += v.tokens;
        if (std.mem.eql(u8, r.rec.getText("side") orelse "", "buy")) st.buys24h += 1 else st.sells24h += 1;
    }
    for (try svc.map("pools").prefixed(tp)) |kv| {
        if (kv.value != .cid) return error.BadIndex;
        const rec = try svc.store.getValue(a, kv.value.cid);
        st.tvl_sats += rec.getUint("bsvReserve") orelse return error.BadIndex;
        st.tvl_tokens += rec.getUint("tokenReserve") orelse return error.BadIndex;
        st.pools += 1;
    }
    if (st.last_trade_price) |p| {
        if (try tradeAtOrBefore(a, svc, tp, start1h)) |t| if (priceOf(t.rec)) |q| {
            st.change1h = changeBps(q, p);
        };
        if (try tradeAtOrBefore(a, svc, tp, start24h)) |t| if (priceOf(t.rec)) |q| {
            st.change24h = changeBps(q, p);
        };
    }
    return st;
}

// ---------------------------------------------------------------- the pool history reads (0.40.0)

/// The pools a read at or from `t` can touch: the live pools and the pools closed (or rescinded) at
/// or after `t` (`closes` from `t` on), their ids in id order.
fn poolsSince(a: Allocator, svc: *Service, tp: []const u8, t: u64) ![]const [36]u8 {
    var ids: std.ArrayList([36]u8) = .empty;
    for (try svc.map("pools").prefixed(tp)) |kv| {
        if (kv.value != .cid) return error.BadIndex;
        try ids.append(a, try poolIdOf(try svc.store.getValue(a, kv.value.cid)));
    }
    for (try svc.map("closes").range(try cat(a, &.{ tp, &be64(t) }), try above(a, tp))) |kv| {
        if (kv.key.len != tp.len + 8 + 36) return error.BadIndex;
        try ids.append(a, kv.key[tp.len + 8 ..][0..36].*);
    }
    std.mem.sort([36]u8, ids.items, {}, struct {
        fn f(_: void, x: [36]u8, y: [36]u8) bool {
            return std.mem.order(u8, &x, &y) == .lt;
        }
    }.f);
    var out: std.ArrayList([36]u8) = .empty;
    for (ids.items) |id| if (out.items.len == 0 or !std.mem.eql(u8, &out.items[out.items.len - 1], &id)) try out.append(a, id);
    return out.items;
}

/// `/pools/at?t=`: every pool listed at `t` — each candidate's (`poolsSince`) last event at or
/// before `t` (`history` floor), a deploy's or a Swap's (a close or a rescind: not listed; none: not
/// yet deployed); the event records, in pool id order.
pub fn poolsAt(a: Allocator, svc: *Service, tp: []const u8, t: u64) ![]const Value {
    var out: std.ArrayList(Value) = .empty;
    for (try poolsSince(a, svc, tp, t)) |*pid| {
        const prefix = try cat(a, &.{ tp, pid });
        const kv = (try svc.map("history").floor(try cat(a, &.{ prefix, &be64(t), &([_]u8{0xff} ** 8) }))) orelse continue;
        if (!std.mem.startsWith(u8, kv.key, prefix) or kv.value != .cid) continue;
        const rec = try svc.store.getValue(a, kv.value.cid);
        const kind = rec.getText("kind") orelse return error.BadIndex;
        if (std.mem.eql(u8, kind, "deploy") or std.mem.eql(u8, kind, "swap")) try out.append(a, rec);
    }
    return out.items;
}

/// One event as read: its record and its key's parts.
pub const Event = struct { pid: [36]u8, at: u64, swaps: u64, rec: Value };

/// The most events one `/pools/history` read answers.
pub const max_events = 500;

/// `/pools/history`: the events with `from ≤ at < to` (null: unbounded) of one pool (`pool_id`) or
/// of every pool the window can touch (`poolsSince(from)`), each pool's `history` range read, oldest
/// first (time, then pool id, then swaps), `limit` at most (the oldest).
pub fn poolHistory(a: Allocator, svc: *Service, tp: []const u8, from: ?u64, to: ?u64, pool_id: ?[36]u8, limit: usize) ![]const Event {
    const ids: []const [36]u8 = if (pool_id) |p| try a.dupe([36]u8, &.{p}) else try poolsSince(a, svc, tp, from orelse 0);
    var out: std.ArrayList(Event) = .empty;
    for (ids) |*pid| {
        const prefix = try cat(a, &.{ tp, pid });
        const lo = try cat(a, &.{ prefix, &be64(from orelse 0) });
        const hi = if (to) |t| try cat(a, &.{ prefix, &be64(t) }) else try above(a, prefix);
        for (try svc.map("history").range(lo, hi)) |kv| {
            if (kv.key.len != prefix.len + 16 or kv.value != .cid) return error.BadIndex;
            try out.append(a, .{
                .pid = pid.*,
                .at = std.mem.readInt(u64, kv.key[prefix.len..][0..8], .big),
                .swaps = std.mem.readInt(u64, kv.key[prefix.len + 8 ..][0..8], .big),
                .rec = try svc.store.getValue(a, kv.value.cid),
            });
        }
    }
    std.mem.sort(Event, out.items, {}, struct {
        fn f(_: void, x: Event, y: Event) bool {
            if (x.at != y.at) return x.at < y.at;
            return switch (std.mem.order(u8, &x.pid, &y.pid)) {
                .lt => true,
                .gt => false,
                .eq => x.swaps < y.swaps,
            };
        }
    }.f);
    return out.items[0..@min(out.items.len, limit)];
}

/// The topic prefix (len ‖ topic) a token's rows are keyed under, from its token id.
pub fn tokenPrefix(a: Allocator, token_id: []const u8) ![]u8 {
    return topicPrefix(a, try topicOf(a, token_id));
}

/// `/lookup` (BRC-24, service `ls_amm_<assetId>`), every query naming its token
/// (`tokenId`, `<txid>_<vout>`): `{tokenId}` every live pool of the token;
/// `{tokenId, outpoint, beef?}` that pool (README, "Queries");
/// `{tokenId, validatorIdentityKey}` that validator's pools of the token; (0.33.0, a list in, one
/// record per key out, from the fee rows) `{tokenId, poolIds}` (0.40.0, was `{lpPubKeys}`),
/// `{tokenId, validatorIdentityKeys}`, `{tokenId, commissionPkhs}`.
pub fn answer(a: Allocator, svc: *Service, ch: *Chain, query: Value) anyerror!lookup.Answer {
    if (query != .map) return error.BadQuery;
    const topic = try topicOf(a, query.getText("tokenId") orelse return error.BadQuery);
    const tp = try topicPrefix(a, topic);
    if (query.getText("outpoint")) |text| {
        return answerOutpoint(a, svc, ch, tp, try parseOutpoint(text), query.getBool("beef") orelse false);
    }
    if (query.getText("validatorIdentityKey")) |hex| return answerValidator(a, svc, tp, hex);
    if (query.get("poolIds")) |v| return answerPools(a, svc, ch, tp, v);
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
