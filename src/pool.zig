//! The Pool contract (pool/Pool.runar.go) as the overlay sees it:
//! recognising a pool, parsing its readonly args and state, and the pool
//! checks. A shared library of this app's programs (shruggr/skein#120: it
//! moved here from amm-poc's amm-topic, whose token rules became
//! skein-1color's topic manager). The 1Color topic does NOT run these checks
//! (decided 2026-10-01: the topic is the token's topic, and a malformed pool
//! is still a valid token output, admitted when the BSV-21 rules allow it).
//! amm-lookup runs `check` in its `admitted` hook and indexes only the
//! pools that pass; amm-validator runs it before signing; amm-p2p's relay
//! checks a pair with it. The parser and the rules (`brc162`, `bsv21`) are
//! skein-1color's `1color` module, re-exported below.
//!
//! A pool is a BRC-162 value output whose lock (the script after the prefix)
//! is the compiled Pool code followed by `OP_RETURN` and the state (0.13.0):
//!
//!   code (fixtures/pool_artifact.zig, readonly args spliced in at the slots:
//!         assetId as `0x20 <32 bytes>`, lpFeeBps, validatorFeeBps and
//!         commissionBps as script numbers) || OP_RETURN ||
//!   TokenReserve (8 bytes, LE sign-magnitude) || LpPubKey || ValidatorPubKey
//!   || ValidatorIdentity (33 bytes each) || Nonce (32 bytes) || Affirmation
//!   (one length byte, then the validator's DER signature; `OP_0` when empty)
//!
//! A rescinded pool's ValidatorPubKey is 33 zero bytes (`Pool.rescinded`).
//!
//! Checks (a transaction failing one has no pool indexed):
//! - a pool is at output 0, so there is at most one per transaction;
//! - its prefix id and amount equal the asset id and TokenReserve the code
//!   and state carry (the contract writes the prefix from those copies and
//!   never reads it; it hard-codes the 0x20 push, so a pool exists only
//!   for a token whose binary id is 32 bytes: native, or legacy deployed
//!   at output 0); JSON outputs are never pools.
//!
//! Not checked here (decided 2026-10-01): the ValidatorPubKey in state. A
//! pool with any validator key is a pool to `check`. Whether a pool is
//! listed is `affirmed` (a deploy: the key derived from ValidatorIdentity and
//! Nonce, the Affirmation verifying) and `nextKeyOf` (a Swap's continuation,
//! 0.13.0), run by amm-lookup; amm-validator derives and checks its own key
//! with `validatorKey`, `firstValidatorKey`, `keyId`, `nonceKeyId`,
//! `validator_protocol` and `methodOf`.
const std = @import("std");
const c = @import("chain");
const color = @import("1color");
const artifact = @import("fixtures/pool_artifact.zig");

/// The decoder and the rules this file is written over (skein-1color's `1color` module).
pub const brc162 = color.brc162;
pub const bsv21 = color.bsv21;

const bsvz = c.bsvz;

/// Decided 2026-09-29, the validator's convention: the BRC-43 protocol of the validator's
/// rotating signing key, counterparty anyone. Two key IDs (0.13.0, David Case 2026-10-22):
/// a pool's first key (its deploy's) is keyed by the Nonce in its state, 64 lowercase hex
/// digits (`nonceKeyId`, invoice `1-amm pool-<nonce hex>`); each Swap's next key by the pool
/// outpoint the Swap spends, `<txid, 64 hex, display order>_<vout, decimal>` (`keyId`, invoice
/// `1-amm pool-<txid>_<vout>`). gen/vectors must match.
pub const validator_protocol = bsvz.primitives.key_deriver.Protocol{ .security_level = 1, .name = "amm pool" };

/// The state's fixed part: TokenReserve, three keys, the Nonce. The Affirmation follows, one
/// length byte then the DER (`state_len_max` with a 72-byte DER, the longest a low-S DER is).
pub const state_fixed_len = 8 + 33 * 3 + 32;
pub const state_len_max = state_fixed_len + 1 + 72;
const OP_RETURN = 0x6a;

pub const Pool = struct {
    asset_id: [32]u8,
    lp_fee_bps: i64,
    validator_fee_bps: i64,
    /// The relay's commission (constructor param 7), in basis points of
    /// amountIn, paid in the input asset to Swap's per-call commissionPkh.
    commission_bps: i64,
    token_reserve: u64,
    lp: [33]u8,
    /// 33 zero bytes once rescinded (`rescinded`).
    validator: [33]u8,
    identity: [33]u8,
    /// The validator's nonce (0.13.0): keys the pool's first validator key.
    nonce: [32]u8,
    /// The validator's affirmation (0.13.0): its DER signature over `affirmMessage`; empty when
    /// the pool carries none. A slice of the parsed lock.
    affirmation: []const u8,
    /// The code's length (the lock before `OP_RETURN` and the state): what a call pushes as
    /// `_codePart`.
    code_len: usize,

    /// Whether the validator rescinded the pool (0.13.0): its ValidatorPubKey is 33 zero bytes.
    pub fn rescinded(self: Pool) bool {
        return std.mem.allEqual(u8, &self.validator, 0);
    }
};

const template: [artifact.script_hex.len / 2]u8 = blk: {
    @setEvalBranchQuota(100_000);
    var out: [artifact.script_hex.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, artifact.script_hex) catch unreachable;
    break :blk out;
};

/// The minimal script-number push Rúnar writes for a bigint constructor arg
/// (and for a method's bigint and bool args).
pub fn canonicalNum(p: brc162.Push) ?i64 {
    switch (p.op) {
        brc162.OP_0 => return 0,
        brc162.OP_1NEGATE => return -1,
        brc162.OP_1...brc162.OP_16 => return p.op - (brc162.OP_1 - 1),
        0x01...0x08 => {},
        else => return null,
    }
    const b = p.data;
    const last = b[b.len - 1];
    if (last & 0x7f == 0 and (b.len == 1 or b[b.len - 2] & 0x80 == 0)) return null; // non-minimal
    var mag: u64 = 0;
    for (b, 0..) |x, i| mag |= @as(u64, if (i == b.len - 1) x & 0x7f else x) << @intCast(8 * i);
    if (mag > std.math.maxInt(i63)) return null;
    const v: i64 = @intCast(mag);
    const neg = last & 0x80 != 0;
    // OP_1..OP_16 and OP_1NEGATE are the minimal forms of those values.
    if ((!neg and v >= 1 and v <= 16) or (neg and v == 1)) return null;
    return if (neg) -v else v;
}

/// pool/Pool.runar.go's methods, in declaration order (its ABI's method
/// index): Swap = 0 (validator-signed), Close = 1 (the LP's alone, outputs
/// free, 0.13.0), Rescind = 2 (the validator's, 0.13.0; skein-amm 0.9.0,
/// David Case 2026-10-09: AddLiquidity and RemoveLiquidity are gone).
pub const Method = enum(u2) { swap = 0, close = 1, rescind = 2 };

/// The method a pool input's unlocking script selects. gen/main.go's
/// `unlockPool` (mirroring how the Rúnar SDK builds a call) writes the
/// unlocking script as a sequence of pushes only — the method's args, then
/// Rúnar's change output and preimage — and pushes the method index last, so
/// it is the script's final push, minimally encoded (OP_0, OP_1, OP_2 here).
/// Null when the script cannot be walked as all pushes, is empty, or its
/// last push is not 0, 1 or 2.
pub fn methodOf(script: []const u8) ?Method {
    var pos: usize = 0;
    var last: ?brc162.Push = null;
    while (pos < script.len) {
        const p = brc162.readPush(script, pos) orelse return null;
        last = p;
        pos = p.next;
    }
    const v = canonicalNum(last orelse return null) orelse return null;
    return switch (v) {
        0 => .swap,
        1 => .close,
        2 => .rescind,
        else => null,
    };
}

/// A fee at `bps` basis points of `amount`, rounded up as the contract does
/// (`(amount*bps + 9999)/10000`): a nonzero rate always takes at least 1.
/// Null for a negative rate (the contract's arithmetic is not defined here
/// for one) or an overflow.
pub fn feeOf(amount: u64, bps: i64) ?u64 {
    if (bps < 0) return null;
    const f = (@as(u128, amount) * @as(u128, @intCast(bps)) + 9999) / 10000;
    return std.math.cast(u64, f);
}

/// What `Swap(amountIn, bsvIn)` does to a pool holding `bsv_reserve` sats
/// (pool/Pool.runar.go): the three fees, taken in the input asset, the net
/// that enters the pool, the payout `out` in the other asset, and the new
/// reserves.
pub const SwapQuote = struct {
    lp_fee: u64,
    validator_fee: u64,
    commission: u64,
    net: u64,
    out: u64,
    bsv_reserve: u64,
    token_reserve: u64,
};

/// The contract's arithmetic; null where it asserts (net or out not
/// positive, a reserve not positive) or a rate is negative.
pub fn quoteSwap(p: Pool, bsv_reserve: u64, amount_in: u64, bsv_in: bool) ?SwapQuote {
    if (amount_in == 0) return null;
    const lp = feeOf(amount_in, p.lp_fee_bps) orelse return null;
    const val = feeOf(amount_in, p.validator_fee_bps) orelse return null;
    const com = feeOf(amount_in, p.commission_bps) orelse return null;
    const fees = @as(u128, lp) + val + com;
    if (fees >= amount_in) return null;
    const net: u64 = amount_in - @as(u64, @intCast(fees));
    const r_in: u128 = if (bsv_in) bsv_reserve else p.token_reserve;
    const r_out: u128 = if (bsv_in) p.token_reserve else bsv_reserve;
    const out: u64 = @intCast(@as(u128, net) * r_out / (r_in + net));
    if (out == 0 or out >= r_out) return null;
    const new_in = std.math.cast(u64, r_in + net) orelse return null;
    const new_out: u64 = @intCast(r_out - out);
    return .{
        .lp_fee = lp,
        .validator_fee = val,
        .commission = com,
        .net = net,
        .out = out,
        .bsv_reserve = if (bsv_in) new_in else new_out,
        .token_reserve = if (bsv_in) new_out else new_in,
    };
}

/// A plain P2PKH lock.
pub fn p2pkh(pkh: [20]u8) [25]u8 {
    return [3]u8{ 0x76, 0xa9, 0x14 } ++ pkh ++ [2]u8{ 0x88, 0xac };
}

/// The contract's `payoutScript`: `amount` to `pkh`, as BSV (P2PKH) or as
/// the pool's token (a BRC-162 value output, `0x20 <assetId> <amount>
/// OP_2DROP` then P2PKH).
pub fn payoutScript(a: std.mem.Allocator, asset_id: [32]u8, amount: u64, pkh: [20]u8, is_bsv: bool) ![]u8 {
    const lock = p2pkh(pkh);
    if (is_bsv) return a.dupe(u8, &lock);
    var buf: [10]u8 = undefined;
    return std.mem.concat(a, u8, &.{ &.{0x20}, &asset_id, brc162.pushAmount(&buf, amount), &.{0x6d}, &lock });
}

/// The contract's `payoutSats`: the amount for BSV, 1 sat for a token output.
pub fn payoutSats(amount: u64, is_bsv: bool) u64 {
    return if (is_bsv) amount else 1;
}

pub const ParseError = error{BadPool};

/// The pool a lock (the script after the token prefix) is, null when it is
/// not the Pool code, error.BadPool when it is the Pool code with malformed
/// args or state.
pub fn parse(lock: []const u8) ParseError!?Pool {
    var asset_id: ?[32]u8 = null;
    var fees: [3]?i64 = .{ null, null, null };
    var tpos: usize = 0;
    var pos: usize = 0;
    for (artifact.slots) |s| {
        const seg = template[tpos..s.offset];
        if (lock.len - pos < seg.len or !std.mem.eql(u8, lock[pos .. pos + seg.len], seg)) return null;
        pos += seg.len;
        tpos = s.offset + 1;
        const p = brc162.readPush(lock, pos) orelse return null;
        pos = p.next;
        switch (s.param) {
            artifact.param_asset_id => {
                if (p.op != 0x20) return error.BadPool;
                const id = p.data[0..32].*;
                if (asset_id) |prev| if (!std.mem.eql(u8, &prev, &id)) return error.BadPool;
                asset_id = id;
            },
            artifact.param_lp_fee_bps, artifact.param_validator_fee_bps, artifact.param_commission_bps => {
                const v = canonicalNum(p) orelse return error.BadPool;
                const f = &fees[
                    switch (s.param) {
                        artifact.param_lp_fee_bps => 0,
                        artifact.param_validator_fee_bps => 1,
                        else => 2,
                    }
                ];
                if (f.*) |prev| if (prev != v) return error.BadPool;
                f.* = v;
            },
            else => return error.BadPool,
        }
    }
    const tail = template[tpos..];
    if (lock.len - pos < tail.len or !std.mem.eql(u8, lock[pos .. pos + tail.len], tail)) return null;
    pos += tail.len;
    const code_len = pos;
    if (lock.len - pos < 1 + state_fixed_len + 1 or lock[pos] != OP_RETURN) return error.BadPool;
    const st = lock[pos + 1 ..];

    if (st[7] & 0x80 != 0) return error.BadPool; // negative reserve
    const reserve = std.mem.readInt(u64, st[0..8], .little);
    var keys: [3][33]u8 = undefined;
    for (&keys, 0..) |*k, i| {
        k.* = st[8 + 33 * i ..][0..33].*;
        // The ValidatorPubKey (i = 1) is 33 zero bytes once rescinded (0.13.0).
        if (k[0] != 0x02 and k[0] != 0x03 and !(i == 1 and std.mem.allEqual(u8, k, 0))) return error.BadPool;
    }
    // The Affirmation: Rúnar's state framing, one length byte (0..75) or `OP_0`, then exactly
    // the rest of the script.
    const af_len = st[state_fixed_len];
    if (af_len > 0x4b or st.len != state_fixed_len + 1 + @as(usize, af_len)) return error.BadPool;
    return .{
        .asset_id = asset_id orelse return error.BadPool,
        .lp_fee_bps = fees[0] orelse return error.BadPool,
        .validator_fee_bps = fees[1] orelse return error.BadPool,
        .commission_bps = fees[2] orelse return error.BadPool,
        .token_reserve = reserve,
        .lp = keys[0],
        .validator = keys[1],
        .identity = keys[2],
        .nonce = st[8 + 99 ..][0..32].*,
        .affirmation = st[state_fixed_len + 1 ..],
        .code_len = code_len,
    };
}

/// The pool's code as a call pushes it (`_codePart`): its lock up to the `OP_RETURN` before the
/// state. Null when the lock is not a pool.
pub fn codeOf(lock: []const u8) ?[]const u8 {
    const p = (parse(lock) catch return null) orelse return null;
    return lock[0..p.code_len];
}

/// The key ID for an outpoint: `<txid display hex>_<vout>`.
pub fn keyId(buf: *[64 + 1 + 10]u8, txid: [32]u8, vout: u32) []const u8 {
    return std.fmt.bufPrint(buf, "{s}_{d}", .{ &c.header.toHex(txid), vout }) catch unreachable;
}

/// The key ID for a nonce (a pool's first key, 0.13.0): 64 lowercase hex digits.
pub fn nonceKeyId(buf: *[64]u8, nonce: [32]u8) []const u8 {
    buf.* = std.fmt.bytesToHex(nonce, .lower);
    return buf;
}

/// The validator's public child key under `key_id`: BRC-42, the identity key as the (public)
/// parent and the anyone key (private key 1) as the counterparty, which anyone can compute.
pub fn childKey(a: std.mem.Allocator, identity: [33]u8, key_id: []const u8) ![33]u8 {
    const kd = bsvz.primitives.key_deriver.KeyDeriver.init(null); // the anyone key
    const child = try kd.derivePublicKey(a, validator_protocol, key_id, .{
        .type_ = .other,
        .public_key = try bsvz.primitives.ec.PublicKey.fromSec1(&identity),
    }, false);
    return child.toCompressedSec1();
}

/// The validator signing key a Swap of the pool output txid:vout names next (`keyId`).
pub fn validatorKey(a: std.mem.Allocator, identity: [33]u8, txid: [32]u8, vout: u32) ![33]u8 {
    var buf: [64 + 1 + 10]u8 = undefined;
    return childKey(a, identity, keyId(&buf, txid, vout));
}

/// A pool's first validator key (0.13.0): keyed by its Nonce (`nonceKeyId`).
pub fn firstValidatorKey(a: std.mem.Allocator, identity: [33]u8, nonce: [32]u8) ![33]u8 {
    var buf: [64]u8 = undefined;
    return childKey(a, identity, nonceKeyId(&buf, nonce));
}

// ---------------------------------------------------------------- the affirmation (0.13.0)

/// The affirmation (skein-amm 0.11.0; 0.13.0, David Case 2026-10-22: the validator's nonce, the
/// attestation in state; docs/AMM.md "The deploy and the affirmation"). Before the LP's wallet
/// builds a deploy, the validator checks the proposed pool against its terms, picks a 32-byte
/// nonce, derives its key from it (`firstValidatorKey`) and signs, with that key, the pool's
/// canonical parameters (`affirmMessage`). The pool's state carries the key, the nonce and the
/// DER signature; every continuation carries the nonce and the signature unchanged. amm-lookup
/// lists a deploy's pool only when it is `affirmed`; a Swap's continuation when the pool it
/// spends was listed and its key is `nextKeyOf` it.
///
/// The terms, as the validator holds them (0.15.0: the record `amm/terms` root sets, src/terms.zig) and a pool carries them.
pub const Terms = struct {
    lp_fee_bps: i64 = 30,
    validator_fee_bps: i64 = 5,
    commission_bps: i64 = 0,
};

/// The affirmation message's tag (its first bytes): a domain separator and the layout's version.
pub const affirm_tag = "skein-amm affirm 2";

/// The affirmation message's length: the tag, the asset id, three fees, two reserves, three keys
/// and the nonce (221 bytes).
pub const affirm_len = affirm_tag.len + 32 + 8 * 3 + 8 * 2 + 33 * 3 + 32;

fn le64(out: []u8, v: u64) void {
    std.mem.writeInt(u64, out[0..8], v, .little);
}

/// The bytes the affirmation signs (docs/AMM.md "The deploy and the affirmation"), message v2:
///
///   "skein-amm affirm 2" (18 bytes, ASCII)
///   ‖ AssetId (32: the bytes the pool script pushes, the token's deploy txid in internal order)
///   ‖ LpFeeBps ‖ ValidatorFeeBps ‖ CommissionBps (int64 LE each)
///   ‖ TokenReserve ‖ the pool output's satoshis (uint64 LE each)
///   ‖ LpPubKey ‖ ValidatorPubKey ‖ ValidatorIdentity (33 each, compressed)
///   ‖ Nonce (32)
///
/// 221 bytes; the signature is ECDSA (DER) by the ValidatorPubKey over sha256 of them. No
/// termsHash (v1's): the three fees are the terms.
pub fn affirmMessage(p: Pool, satoshis: u64) [affirm_len]u8 {
    var m: [affirm_len]u8 = undefined;
    var at: usize = 0;
    const put = struct {
        fn f(buf: []u8, pos: *usize, bytes: []const u8) void {
            @memcpy(buf[pos.* .. pos.* + bytes.len], bytes);
            pos.* += bytes.len;
        }
    }.f;
    var n: [8]u8 = undefined;
    put(&m, &at, affirm_tag);
    put(&m, &at, &p.asset_id);
    for ([_]i64{ p.lp_fee_bps, p.validator_fee_bps, p.commission_bps }) |f| {
        le64(&n, @bitCast(f));
        put(&m, &at, &n);
    }
    le64(&n, p.token_reserve);
    put(&m, &at, &n);
    le64(&n, satoshis);
    put(&m, &at, &n);
    put(&m, &at, &p.lp);
    put(&m, &at, &p.validator);
    put(&m, &at, &p.identity);
    put(&m, &at, &p.nonce);
    std.debug.assert(at == affirm_len);
    return m;
}

/// sha256 of `affirmMessage`: what the validator's key signs (the signer signs it as is).
pub fn affirmDigest(p: Pool, satoshis: u64) [32]u8 {
    var out: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(&affirmMessage(p, satoshis), &out, .{});
    return out;
}

/// Whether `sig` (DER) is the pool's ValidatorPubKey's signature of its affirmation.
pub fn affirmationVerifies(p: Pool, satoshis: u64, sig: []const u8) bool {
    const der = bsvz.crypto.DerSignature.fromDer(sig) catch return false;
    const pk = bsvz.primitives.ec.PublicKey.fromSec1(&p.validator) catch return false;
    return pk.verifyDigest(affirmDigest(p, satoshis), der) catch false;
}

/// The pool at an output script (a BRC-162 value output whose lock is a pool), or null.
pub fn poolOfScript(script: []const u8) ?Pool {
    const tok = brc162.decode(script) orelse return null;
    if (tok.role != .value) return null;
    return (parse(tok.lock) catch return null) orelse null;
}

/// Whether the pool `p` (an output holding `satoshis`) attests itself (0.13.0, the lookup's
/// deploy rule): not rescinded; its ValidatorPubKey is the ValidatorIdentity's child keyed by its
/// Nonce (`firstValidatorKey`, the derivation done here, not trusted); and its Affirmation is
/// that key's signature of `affirmMessage`. A pool with a key of the LP's own (v0.11.0's defect)
/// or any field changed since it was signed is not.
pub fn affirmedPool(a: std.mem.Allocator, p: Pool, satoshis: u64) bool {
    if (p.rescinded()) return false;
    const want = firstValidatorKey(a, p.identity, p.nonce) catch return false;
    if (!std.mem.eql(u8, &want, &p.validator)) return false;
    return affirmationVerifies(p, satoshis, p.affirmation);
}

/// `affirmedPool` of the pool at an output script.
pub fn affirmed(a: std.mem.Allocator, script: []const u8, satoshis: u64) bool {
    const p = poolOfScript(script) orelse return false;
    return affirmedPool(a, p, satoshis);
}

/// Whether `next` is the continuation a Swap of the pool output `spent` (txid:vout) names
/// (0.13.0, David Case 2026-10-22: the lookup checks the next key): not rescinded, the same
/// ValidatorIdentity, and its ValidatorPubKey the identity's child keyed by `spent` (`keyId`).
pub fn nextKeyOf(a: std.mem.Allocator, next: Pool, identity: [33]u8, spent_txid: [32]u8, spent_vout: u32) bool {
    if (next.rescinded() or !std.mem.eql(u8, &next.identity, &identity)) return false;
    const want = validatorKey(a, identity, spent_txid, spent_vout) catch return false;
    return std.mem.eql(u8, &want, &next.validator);
}

pub const Violation = enum {
    malformed,
    not_at_output_0,
    prefix_mismatch,
};

/// Check every pool among a transaction's admitted token outputs
/// (`j.outputs`). Null when they pass. Run by amm-lookup and amm-validator,
/// not by the topic.
pub fn check(j: bsv21.Judgement) ?Violation {
    for (j.outputs) |o| {
        // A pool is a binary value output; JSON outputs are never pools.
        const b = o.token.binary orelse continue;
        if (b.role != .value) continue;
        const p = (parse(b.lock) catch return .malformed) orelse continue;
        if (o.index != 0) return .not_at_output_0;
        // The contract hard-codes a 32-byte id push (vout 0); a 36-byte
        // legacy id cannot match it.
        if (b.id.?.vout != 0 or !std.mem.eql(u8, &p.asset_id, &b.id.?.txid) or p.token_reserve != b.amount) return .prefix_mismatch;
    }
    return null;
}

// ---------------------------------------------------------------- a Swap's call and its fee outputs (0.32.0)

/// A swap's call to the pool, as Rúnar lays it out (amm-validator unlock.zig):
/// `_codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
/// commissionPkh, _changePKH, _changeAmount, txPreimage, methodIndex`:
/// pushes only. (Moved from amm-p2p's relay.zig in 0.32.0: the relay's pair check and
/// amm-lookup's LP fee totals read a swap with this one parser.)
pub const SwapCall = struct {
    amount_in: u64,
    bsv_in: bool,
    user_pkh: []const u8,
    commission_pkh: []const u8,
    change: u64,
};

pub const swap_pushes = 1 + 6 + 4;

/// A script number push (minimal or not), non-negative, as a u64.
fn numOf(p: brc162.Push) ?u64 {
    return switch (p.op) {
        brc162.OP_0 => 0,
        brc162.OP_1...brc162.OP_16 => p.op - (brc162.OP_1 - 1),
        0x01...0x09 => blk: {
            // Rúnar writes minimal numbers; read any non-negative encoding.
            const b = p.data;
            if (b[b.len - 1] & 0x80 != 0) break :blk null;
            if (b.len > 8 and b[8] != 0) break :blk null;
            var v: u64 = 0;
            for (b[0..@min(b.len, 8)], 0..) |x, i| v |= @as(u64, x) << @intCast(8 * i);
            break :blk v;
        },
        else => null,
    };
}

fn boolOf(p: brc162.Push) ?bool {
    const n = numOf(p) orelse return null;
    return n != 0;
}

/// The Swap call an unlocking script carries; null when it is not one laid out as Rúnar calls it.
pub fn parseSwapCall(a: std.mem.Allocator, script: []const u8) !?SwapCall {
    var pushes: std.ArrayList(brc162.Push) = .empty;
    var pos: usize = 0;
    while (pos < script.len) {
        const p = brc162.readPush(script, pos) orelse return null;
        try pushes.append(a, p);
        pos = p.next;
    }
    if (pushes.items.len != swap_pushes) return null;
    const arg = pushes.items[1..];
    return .{
        .amount_in = numOf(arg[2]) orelse return null,
        .bsv_in = boolOf(arg[3]) orelse return null,
        .user_pkh = arg[4].data,
        .commission_pkh = arg[5].data,
        .change = numOf(arg[7]) orelse return null,
    };
}

/// Where a Swap writes its fees (pool/Pool.runar.go Swap): output 0 the continuation, output 1
/// the payout, then the LP's fee output when `lp_fee > 0`, then the validator's when
/// `validator_fee > 0`, then the commission when `commission > 0`; each `feeOf(amountIn, bps)`
/// of the continuation's rate, in the input asset. `end` is the index after the fee outputs
/// (the change, if any, is there).
pub const FeeLayout = struct {
    lp_fee: u64,
    validator_fee: u64,
    commission: u64,
    lp_at: ?usize,
    validator_at: ?usize,
    commission_at: ?usize,
    end: usize,
};

/// The layout of `call`'s fees against the continuation `cont`; the error names the rate the
/// contract's arithmetic is not defined for.
pub fn feeLayout(call: SwapCall, cont: Pool) error{ LpFeeBps, ValidatorFeeBps, CommissionBps }!FeeLayout {
    const lp_fee = feeOf(call.amount_in, cont.lp_fee_bps) orelse return error.LpFeeBps;
    const val_fee = feeOf(call.amount_in, cont.validator_fee_bps) orelse return error.ValidatorFeeBps;
    const com = feeOf(call.amount_in, cont.commission_bps) orelse return error.CommissionBps;
    var at: usize = 2;
    var l: FeeLayout = .{ .lp_fee = lp_fee, .validator_fee = val_fee, .commission = com, .lp_at = null, .validator_at = null, .commission_at = null, .end = 0 };
    if (lp_fee > 0) {
        l.lp_at = at;
        at += 1;
    }
    if (val_fee > 0) {
        l.validator_at = at;
        at += 1;
    }
    if (com > 0) {
        l.commission_at = at;
        at += 1;
    }
    l.end = at;
    return l;
}

/// What a Swap paid (0.33.0): its three fees, each in the input asset (sats when `bsv_in`, else token
/// units), and the commission's key hash (the call's `commissionPkh`).
pub const SwapFees = struct {
    lp: u64,
    validator: u64,
    commission: u64,
    bsv_in: bool,
    commission_pkh: [20]u8,
};

/// The fees a Swap transaction paid: the call on input `pool_input` (`parseSwapCall`), the
/// continuation at output 0, the fee outputs where `feeLayout` puts them, each checked to hold the
/// contract's amount (`payoutSats`) and the LP's and the commission's their payout script
/// (`payoutScript` to Hash160 of the continuation's LpPubKey, to the call's commissionPkh); a zero
/// fee has no output. Null when the transaction is not such a Swap (no call, no continuation, a fee
/// output missing or not the contract's).
pub fn feesOf(a: std.mem.Allocator, tx: c.bsvz.transaction.Transaction, pool_input: usize) !?SwapFees {
    if (pool_input >= tx.inputs.len or tx.outputs.len < 2) return null;
    const call = (try parseSwapCall(a, tx.inputs[pool_input].unlocking_script.bytes)) orelse return null;
    if (call.commission_pkh.len != 20) return null;
    const cont = poolOfScript(tx.outputs[0].locking_script.bytes) orelse return null;
    const l = feeLayout(call, cont) catch return null;
    if (l.end > tx.outputs.len) return null;
    const pkh = call.commission_pkh[0..20].*;
    const checks = [_]struct { at: ?usize, amount: u64, to: ?[20]u8 }{
        .{ .at = l.lp_at, .amount = l.lp_fee, .to = bsvz.crypto.hash.hash160(&cont.lp).bytes },
        .{ .at = l.validator_at, .amount = l.validator_fee, .to = null },
        .{ .at = l.commission_at, .amount = l.commission, .to = pkh },
    };
    for (checks) |k| {
        const at = k.at orelse continue;
        const o = tx.outputs[at];
        if (o.satoshis < 0 or @as(u64, @intCast(o.satoshis)) != payoutSats(k.amount, call.bsv_in)) return null;
        if (k.to) |to| if (!std.mem.eql(u8, o.locking_script.bytes, try payoutScript(a, cont.asset_id, k.amount, to, call.bsv_in))) return null;
    }
    return .{ .lp = l.lp_fee, .validator = l.validator_fee, .commission = l.commission, .bsv_in = call.bsv_in, .commission_pkh = pkh };
}
