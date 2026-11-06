//! The app's functions this program answers (the interfaces `amm.swap/1` and `amm.pool/1`, in-VM
//! and on the route `/call`): `amm.swap.terms` (this exchange's commission key and the market's
//! minimum), `amm.pool.terms` (the validator's terms) and `amm.pool.affirm` (a proposed pool to this
//! instance's own validator, in-VM, answered at once). Pure: no VM imports (main.zig wires it).
//!
//! 0.44.0 (David Case 2026-11-06, "the instance logs facts, never attempts"): the marketplace relay
//! is gone from the instance — `amm.swap.submit`, `amm.swap.status`, the `swaps` records, the relay
//! thread and its libp2p dial. The open-exchange HOST relays a swap (its route `POST
//! /@<tokenId>/amm/swap`): it checks the one rule that is the exchange's (the commission, README
//! "The commission rule"), signs the package with the token instance's key outside any step,
//! carries it to the validator on one libp2p stream and answers the page. Nothing is logged on the
//! taker's side but the overlay submission of the transaction the validator returned.
//!
//! **The affirmation** (`amm.pool/1`'s `affirm`, skein-amm 0.11.0, David Case 2026-10-21): the
//! LP's page asks this skein's validator to affirm a proposed pool before its wallet builds the
//! deploy. Nothing is recorded or relayed over libp2p: `affirmBody` checks the args, main.zig
//! packages them (box `affirm`, from this instance to itself) and calls amm-validator's fn
//! `affirm` in-VM, which answers at once (`affirmAnswer`): `{validatorPubKey, nonce, signature}`
//! (0.13.0: the validator picks the nonce and its key), or the refusal.
const std = @import("std");
const w = @import("chain");
const scbor = @import("sdk_cbor");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const terms_mod = @import("terms");
pub const market = @import("market.zig");
const eql = std.mem.eql;

/// The app (its box, and the prefix of its heads) and the interface's functions.
pub const app_name = "amm";
/// The app's root head (skein-sdk 0.3.0 `app.headOf`, shruggr/skein#77: an
/// app's heads are `<app>/…`, its root `<app>/app`).
pub const app_head = app_name ++ "/app";
/// This program's own state (the catch-up cursor; 0.6.0),
/// under the app's name too: under #77 an installed app advances only heads
/// named `<app>/…`.
pub const p2p_head = app_name ++ "/p2p";
pub const fn_terms = "amm.swap.terms";
/// The validator's terms (0.9.0): what a pool here must carry.
pub const fn_pool_terms = "amm.pool.terms";
/// The affirmation (0.11.0): a proposed pool, checked against the terms and signed.
pub const fn_pool_affirm = "amm.pool.affirm";
/// The affirm call (0.11.0): amm-validator's fn `affirm`, called in-VM only (no libp2p route).
pub const affirm_protocol = "/amm-validator/1/affirm";
pub const affirm_box = "affirm";

/// This exchange's commission: a swap the host relays must pay its commission output to `pkh` (a
/// pool whose CommissionBps is 0 has none, and passes; README "The commission rule": the host's
/// check, 0.44.0). The page learns `pkh` from `amm.swap.terms` and names it as Swap's
/// commissionPkh. 0.16.0: hash160 of this instance's own key for the commission,
/// `commission_protocol` / `commission_key_id`, counterparty anyone (main.zig `commissionKey`);
/// null only when the signer gives no key.
pub const Commission = struct {
    pkh: ?[20]u8 = null,
};

/// The relay's commission key (0.16.0, the agent's call, "David to review"): BRC-43 security
/// level 1, protocol `amm commission`, key ID `relay`, counterparty `anyone`, the child of the
/// instance's root identity key, as the validator's keys are (`amm pool`, level 1, anyone:
/// src/pool.zig `validator_protocol`): anyone can derive the public key from the identity, only
/// the instance can sign for it.
pub const commission_protocol = .{ .level = 1, .name = "amm commission" };
pub const commission_key_id = "relay";

/// amm.swap.terms `{}` → `{commissionPkh: bytes(20) | null, minCommissionBps}` (0.16.0: the
/// market record root sets, market.zig; unset, 0).
pub fn terms(a: Allocator, c: Commission, m: market.Market) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "commissionPkh", .value = if (c.pkh) |p| .{ .bytes = try a.dupe(u8, &p) } else .null },
        .{ .key = "minCommissionBps", .value = .{ .uint = m.min_commission_bps } },
    }) };
}

/// amm.pool.terms's answer (0.9.0; 0.15.0: the record root sets, src/terms.zig): `{validator?:
/// <identity, bytes 33>, peerId?: text, lpFeeBps, validatorFeeBps, commissionBps}`; null when no
/// terms are set (a market only: the caller answers the error "no validator here").
pub fn poolTerms(a: Allocator, identity: ?[]const u8, peer: ?[]const u8, t: ?terms_mod.Terms) !?Value {
    const tt = t orelse return null;
    var es: std.ArrayList(cbor.Entry) = .empty;
    if (identity) |k| try es.append(a, .{ .key = "validator", .value = .{ .bytes = k } });
    if (peer) |p| try es.append(a, .{ .key = "peerId", .value = .{ .text = p } });
    try es.appendSlice(a, &.{
        .{ .key = "lpFeeBps", .value = .{ .uint = @intCast(tt.lp_fee_bps) } },
        .{ .key = "validatorFeeBps", .value = .{ .uint = @intCast(tt.validator_fee_bps) } },
        .{ .key = "commissionBps", .value = .{ .uint = @intCast(tt.commission_bps) } },
    });
    return .{ .map = es.items };
}


pub const Refusal = struct { reason: []const u8, detail: ?[]const u8 = null };


/// Who signs the package: this instance's identity and its BRC-42 child for
/// [2, "metanet handles envelope"], key ID "send", counterparty anyone (the
/// `wallet` import in the program; a key in the tests).
pub const Signer = struct {
    ctx: *anyopaque,
    identityFn: *const fn (ctx: *anyopaque, a: Allocator) anyerror![33]u8,
    /// DER signature of `hash` (sha256 of the record without `signature`).
    signFn: *const fn (ctx: *anyopaque, a: Allocator, hash: [32]u8) anyerror![]const u8,
};

pub const envelope_protocol = "metanet handles envelope";
pub const envelope_key_id = "send";

/// The direct call's frame: a signed-message package `{message, body, topic?}`
/// (skein docs/MESSAGES.md "Signed messages (#70)"; the shape amm-validator's
/// `messages.open` checks with skein-sdk's `message.problem`, reading `message`
/// and `body` by name). `nonce` makes the record unique to this swap.
/// `topic` (0.31.0): the token's overlay topic `tm_color_<assetId>`, at the
/// frame's top level, where a host running several instances on one libp2p
/// node reads it to pick the instance a stream is for (skein `p2p.ts`
/// `streamHandle`: a first frame naming no topic, with several instances
/// declaring the protocol, is answered `topic required` and closed). Outside
/// the signed record: it routes, it authenticates nothing.
pub fn package(a: Allocator, signer: Signer, recipient: []const u8, box: []const u8, body: Value, nonce: [16]u8, topic: ?[]const u8) ![]u8 {
    const body_bytes = try cbor.encode(a, body);
    const blk = try scbor.block(a, try scbor.decode(a, body_bytes));
    if (!eql(u8, blk.bytes, body_bytes)) return error.NotCanonical;
    const sender = try signer.identityFn(signer.ctx, a);
    var es: std.ArrayList(scbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .string = "mail" } },
        .{ .key = "op", .value = .{ .string = "put" } },
        .{ .key = "sender", .value = .{ .bytes = try a.dupe(u8, &sender) } },
        .{ .key = "recipient", .value = .{ .bytes = recipient } },
        .{ .key = "box", .value = .{ .string = box } },
        .{ .key = "body", .value = .{ .cid = blk.cid } },
        .{ .key = "nonce", .value = .{ .bytes = try a.dupe(u8, &nonce) } },
    });
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(try scbor.encode(a, .{ .map = es.items }), &digest, .{});
    const sig = try signer.signFn(signer.ctx, a, digest);
    try es.append(a, .{ .key = "signature", .value = .{ .bytes = sig } });
    var top: std.ArrayList(scbor.Entry) = .empty;
    try top.appendSlice(a, &.{
        .{ .key = "message", .value = .{ .map = es.items } },
        .{ .key = "body", .value = .{ .bytes = body_bytes } },
    });
    if (topic) |t| try top.append(a, .{ .key = "topic", .value = .{ .string = t } });
    return scbor.encode(a, .{ .map = top.items });
}

// ---------------------------------------------------------------- the affirmation (amm.pool/1, 0.13.0)

/// The validator's affirm request body from `amm.pool.affirm`'s args `{pool, satoshis}`: `{pool:
/// <the pool output's locking script, its ValidatorPubKey, Nonce and Affirmation to come>,
/// satoshis}` (amm-validator README, "Protocol"), or null when an arg is missing or malformed
/// (the validator checks the pool itself). 0.13.0: no `keyInput` (the validator picks a nonce).
pub fn affirmBody(a: Allocator, args: Value) !?Value {
    const script = args.getBytes("pool") orelse return null;
    const sats = args.getUint("satoshis") orelse return null;
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "pool", .value = .{ .bytes = script } },
        .{ .key = "satoshis", .value = .{ .uint = sats } },
    }) };
}

/// The nonce of an affirm's package: the first 16 bytes of sha256("amm-pool-affirm" ‖ the body).
pub fn affirmNonce(a: Allocator, body: Value) ![16]u8 {
    var d: [32]u8 = undefined;
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update("amm-pool-affirm");
    h.update(try cbor.encode(a, body));
    h.final(&d);
    return d[0..16].*;
}

pub const Affirmed = union(enum) { ok: Value, refused: Refusal };

/// The validator handler's answer to the in-VM affirm call (`{verdict, body}`, `body` the reply
/// frame: `{ok: true, validatorPubKey, nonce, signature}` or `{ok: false, reason, detail?}`) →
/// `{validatorPubKey, nonce, signature}`, or the refusal.
pub fn affirmAnswer(a: Allocator, ans: Value) Affirmed {
    const frame = ans.getBytes("body") orelse return .{ .refused = .{ .reason = "bad_reply", .detail = "the validator answered no body" } };
    const v = cbor.decode(a, frame) catch return .{ .refused = .{ .reason = "bad_reply", .detail = "the validator's answer is not dag-cbor" } };
    const ok = v.getBool("ok") orelse return .{ .refused = .{ .reason = "bad_reply", .detail = "the validator's answer has no ok" } };
    if (!ok) return .{ .refused = .{ .reason = v.getText("reason") orelse "refused", .detail = v.getText("detail") } };
    const sig = v.getBytes("signature") orelse return .{ .refused = .{ .reason = "bad_reply", .detail = "affirmed without a signature" } };
    const key = v.getBytes("validatorPubKey") orelse return .{ .refused = .{ .reason = "bad_reply", .detail = "affirmed without a validatorPubKey" } };
    const nonce = v.getBytes("nonce") orelse return .{ .refused = .{ .reason = "bad_reply", .detail = "affirmed without a nonce" } };
    if (key.len != 33 or nonce.len != 32) return .{ .refused = .{ .reason = "bad_reply", .detail = "a validatorPubKey of 33 bytes and a nonce of 32 expected" } };
    const out = a.dupe(cbor.Entry, &.{
        .{ .key = "validatorPubKey", .value = .{ .bytes = key } },
        .{ .key = "nonce", .value = .{ .bytes = nonce } },
        .{ .key = "signature", .value = .{ .bytes = sig } },
    }) catch return .{ .refused = .{ .reason = "bad_reply", .detail = "out of memory" } };
    return .{ .ok = .{ .map = out } };
}


/// The answer message to a caller who sent `{fn, args}` in the app's box
/// (APPS.md §4): `{fn, request, replyTo, result}`.
pub fn answerMessage(a: Allocator, func: []const u8, message: []const u8, result: Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = .{ .cid = message } },
        .{ .key = "replyTo", .value = .{ .cid = message } },
        .{ .key = "result", .value = result },
    }) };
}

/// The same with `error: {code, message}`.
pub fn errorMessage(a: Allocator, func: []const u8, message: []const u8, code: []const u8, text: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = .{ .cid = message } },
        .{ .key = "replyTo", .value = .{ .cid = message } },
        .{ .key = "error", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "code", .value = .{ .text = code } },
            .{ .key = "message", .value = .{ .text = text } },
        }) } },
    }) };
}

/// A refusal as the function's error message: `<reason>[: <detail>]`.
pub fn refusalText(a: Allocator, r: Refusal) ![]const u8 {
    return if (r.detail) |d| std.fmt.allocPrint(a, "{s}: {s}", .{ r.reason, d }) else r.reason;
}
