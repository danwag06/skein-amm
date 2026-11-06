//! The validator's decisions, independent of how a request arrives (a
//! direct call, skein#51: what libp2p calls a stream): `spend` for the
//! `swap` call, `affirm` for the `affirm` call (0.11.0: a proposed pool checked against the
//! terms and signed before the LP's wallet builds the deploy).
//!
//! A spend is signed only if, in order:
//!   1. the transaction parses and spends the named pool outpoint;
//!   2. the pool is an output this instance's overlay holds, and it is a
//!      pool (the compiled Pool code) whose ValidatorIdentity is ours,
//!      and its token topic is one this instance validates (`Config.validated`,
//!      the engine's registered set with `config.overlay.validator` set;
//!      else `not_validating`, 0.6.0);
//!   3. it is still live in the topic; if a transaction we hold spent it,
//!      the refusal carries the pool's newest state (continuations are
//!      always output 0: followed from spender to spender) — unless that
//!      spender is this very request, signed (a retry after a 503: the
//!      signed transaction is answered again, from the state);
//!   4. the pool input calls the direct call's method (Swap / AddLiquidity), as
//!      Rúnar lays a call out (unlock.zig), with our signature's slot empty
//!      (`OP_0`) and its code push the pool's own code;
//!   5. the next validator key (the call's argument, and the continuation's
//!      state) is the child of the spent pool outpoint;
//!   6. our topic would admit the transaction (1Color's `token.judge`,
//!      the BSV-21 rules alone, with the pool and the taker's token inputs
//!      as previous coins, and the inputs' sources where the topic's own
//!      call reads them: held, else the request's BEEF — the same judgement
//!      `submit.route` asks the topic for, after signing); the pool checks
//!      pass (`pool.check`: the topic `tm_color_<txid>_0` no longer runs
//!      them, decided 2026-10-01, so a malformed continuation would be a
//!      valid token output — the validator refuses to sign it, `bad_pool`;
//!      `pool.check` does not look at the ValidatorPubKey, which is ours to
//!      check, steps 5 and 10); and the pool is its first token input; for
//!      a Swap, the output set is the contract's (`swapOutputs`: the
//!      continuation's reserves, the payout, the LP fee, the validator fee
//!      and the commission to the call's commissionPkh, each in its asset
//!      and only when nonzero, then the token change when the call names
//!      one (0.40.0), then at most Rúnar's change output, nothing
//!      else; for an AddLiquidity, `addLiquidityOutputs`: the continuation
//!      with the reserves increased by addBsv/addTokens and LpPubKey the
//!      call's nextLpPubKey, then at most Rúnar's change; reason `bad_outputs`);
//!      and (0.40.0) the leg's sats side — the amount in on a buy, the payout
//!      on a sell — is at least the terms' `minLegSats` (reason `below_minimum`);
//!   7. the preimage the call pushes is the one we compute (BIP-143,
//!      ALL|FORKID, the pool's scriptCode);
//!   8. every other input carries a signature, verified when it spends a
//!      P2PKH output (token or plain) whose source we have; for
//!      AddLiquidity the LP's signature in the call verifies against the
//!      pool's LpPubKey; and every unproven parent the request's BEEF
//!      carries that we do not hold (the taker's nosend funding
//!      transaction, docs/notes.md 2026-10-02 "Swap funding and signing")
//!      is complete: each of its inputs signed, verified likewise;
//!  10. we can name our current key (`currentKeyId`, 0.13.0): a Swap's
//!      continuation's key is keyed by the pool outpoint that Swap spent; a
//!      deploy's, an affirmed pool's (`pool.affirmedPool`), by its Nonce;
//!      checked against the pool's ValidatorPubKey. A rescinded pool has none.
//! Then the oracle signs the digest, the signature goes into its slot, and
//! the signed transaction is returned with what its submission needs
//! (`Submission`: the topic, the request's ancestry) — not submitted here:
//! messages.zig `finishSpend` hands the signed BEEF to skein's own
//! `submit.route` (submit.zig), and main.zig launches the overlay engine's
//! submission thread on the record it makes.
const std = @import("std");
const w = @import("chain");
const color = @import("1color");
const unlock = @import("unlock.zig");
const view_mod = @import("view.zig");
const Oracle = @import("oracle.zig").Oracle;

const bsvz = w.bsvz;
const beef = w.beef;
const brc162 = color.brc162;
const bsv21 = color.bsv21;
const pool = @import("pool");
const terms_mod = @import("terms");
const token = color.token;
const Transaction = bsvz.transaction.Transaction;
const View = view_mod.View;
pub const Outpoint = view_mod.Outpoint;

/// Which direct call: the route's fn (`libp2p:/amm-validator/1/swap`, or `affirm`, called
/// in-VM by amm-p2p's `amm.pool.affirm`). 0.9.0: `addLiquidity` is gone with the contract's
/// AddLiquidity; 0.11.0: `deploy` (a delivered deploy, claimed) is gone, `affirm` replaces it.
pub const Op = enum {
    swap,
    affirm,

    pub fn name(self: Op) []const u8 {
        return switch (self) {
            .swap => "swap",
            .affirm => "affirm",
        };
    }
    pub fn parse(s: []const u8) ?Op {
        inline for (.{ Op.swap, Op.affirm }) |b| if (std.mem.eql(u8, s, b.name())) return b;
        return null;
    }
    pub fn method(self: Op) ?pool.Method {
        return switch (self) {
            .swap => .swap,
            .affirm => null,
        };
    }
};

/// The validator's terms (0.9.0, David Case 2026-10-09: "Fees are the validator's"; 0.15.0, David
/// 2026-10-23: a runtime record root sets, src/terms.zig, main.zig `termsNow`), the fees every
/// pool it hosts carries. An LP posting here accepts them; a pool whose fees differ is not affirmed
/// (0.11.0). None set: a market only, nothing affirmed or signed (`noTerms`).
pub const Terms = pool.Terms;

pub const Config = struct {
    /// This instance's root identity key: pools naming it are ours.
    identity: [33]u8,
    /// The terms a pool must carry exactly to be affirmed (0.9.0; 0.11.0); null (0.15.0): none set,
    /// this skein validates nothing — an affirm and a swap are refused before anything is checked.
    terms: ?Terms = null,
    now_ms: i64 = 0,
    /// The topics this instance validates: the engine's registered set (the head
    /// `<app>/topics`; main.zig `validatedSet`). A swap or an affirm for a token whose topic is not
    /// in it is refused `not_validating`, before anything is checked or signed. Empty: nothing is
    /// signed.
    validated: []const []const u8 = &.{},
};

/// Whether `topic` is one this instance validates (`Config.validated`).
pub fn validating(cfg: Config, topic: []const u8) bool {
    for (cfg.validated) |t| if (std.mem.eql(u8, t, topic)) return true;
    return false;
}

/// The refusal when no terms are set (0.15.0): `not_validating`, "no terms: this skein validates nothing".
pub fn noTerms() Reply {
    return refuse(.not_validating, terms_mod.no_terms);
}

fn notValidating(a: std.mem.Allocator, topic: []const u8) !Reply {
    return refuse(.not_validating, try std.fmt.allocPrint(a, "this validator does not validate {s}", .{topic}));
}

pub const Reason = enum {
    bad_request,
    bad_transaction,
    pool_not_an_input,
    unknown_pool,
    pool_spent,
    not_a_pool,
    not_our_pool,
    wrong_method,
    bad_call,
    signature_slot_not_empty,
    wrong_next_key,
    topic_refused,
    /// The pool checks (`pool.check`) fail: detail the violation.
    bad_pool,
    pool_not_first_token_input,
    preimage_mismatch,
    missing_signature,
    bad_signature,
    current_key_unknown,
    oracle_failed,
    /// The direct call's frame is not a signed-message package for this
    /// validator (MESSAGES.md "Signed messages (#70)"): detail why.
    unauthenticated,
    /// The answer after the step found no outcome: the signed transaction is
    /// not held, or it is held and neither pending, admitted nor rejected.
    submit_failed,
    /// skein's `submit.route` refused the signed BEEF (it does not decode or
    /// verify: an input neither held nor in the request's BEEF, say).
    submit_refused,
    /// The answer after the step: the submission's thread came to rest with
    /// nothing admitted or rejected (it errored): send the same request again.
    pending,
    /// The answer after the step: the network rejected it (a status
    /// provider's rejection, a competing proof, abandonment); or a
    /// resubmission of a transaction already rejected.
    rejected,
    pool_not_at_output_0,
    /// A proposed pool's fees differ from this validator's terms (0.9.0; 0.11.0 at affirm): detail which.
    fees_unacceptable,
    wrong_validator_key,
    /// A Swap's outputs are not the contract's: detail which.
    bad_outputs,
    /// The pool's token topic is not one this instance validates (`Config.validated`; 0.6.0: registered, with `config.overlay.validator` set): detail the topic;
    /// or (0.15.0) no terms are set, so it validates nothing (`noTerms`).
    not_validating,
    /// The pool was rescinded (0.13.0): its ValidatorPubKey is cleared; nothing signs for it.
    rescinded,
    /// The leg's sats side (the amount in on a buy, the payout on a sell) is under this
    /// validator's minimum leg (0.40.0, the terms' `minLegSats`): detail names the minimum.
    below_minimum,
};

/// A pool's state, as the rejection of a stale request carries it.
pub const PoolState = struct {
    outpoint: Outpoint,
    /// The pool output's satoshis: its BSV reserve.
    satoshis: u64,
    pool: pool.Pool,
};

pub const Newest = union(enum) {
    live: PoolState,
    /// A spend with no pool continuation (Close).
    closed: struct { last: Outpoint, by: [32]u8 },
};

/// An unproven parent the request's BEEF carries and the instance does not
/// hold (the taker's nosend funding transaction). It must be complete (check
/// 8); it travels in the submission's BEEF, and the chain app registers and
/// broadcasts it, parents first, when the engine ingests the submission
/// (shruggr/skein-chain docs/CHAIN.md "Ingest a BEEF"; amm-poc broadcast it
/// from the validator, before #79 made the chain app the one broadcaster).
/// `beef` is its Atomic BEEF (its ancestry in the request).
pub const Parent = struct {
    txid: [32]u8,
    raw: []const u8,
    beef: []const u8,
};

/// What a signed spend's submission needs besides the transaction: the
/// topic it was judged for, the pool it spends (0.29.5: its transaction's BEEF is
/// merged into the submission), the request's ancestry (the signed BEEF is the
/// request's with its subject replaced, submit.zig `submissionBeef`), and the
/// unproven parents it carries.
pub const Submission = struct {
    topic: []const u8,
    pool: Outpoint,
    ancestry: ?beef.Beef = null,
    parents: []const Parent = &.{},
};

pub const Reply = union(enum) {
    /// A spend: the transaction with our signature, and what its submission
    /// needs. From `spend`, `tx`/`txid` mean "signed"; the direct
    /// call's answer (messages.zig `answerFromState`) is read after the
    /// submission's thread came to rest, and there `ok` means admitted.
    /// An affirmation (0.13.0): `signature` (DER), the `validator_pub_key` it is by and the
    /// `nonce` that key is keyed by; the deploy's pool state carries all three. Nothing is
    /// submitted.
    ok: struct { tx: ?[]const u8 = null, txid: ?[32]u8 = null, submission: ?Submission = null, signature: ?[]const u8 = null, validator_pub_key: ?[33]u8 = null, nonce: ?[32]u8 = null },
    /// `txid`: the signed transaction's, when the refusal is about it (after signing).
    refused: struct { reason: Reason, detail: ?[]const u8 = null, newest: ?Newest = null, txid: ?[32]u8 = null },
};

fn refuse(reason: Reason, detail: ?[]const u8) Reply {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

/// A pool's token: always a BRC-162 (native) token, deployed at output 0
/// (a pool's AssetId is the 32-byte deploy txid).
pub fn tokenId(id: [32]u8) bsv21.TokenId {
    return .{ .txid = id };
}

/// The token's topic, `tm_color_<txid>_0` (skein-1color name.zig: `tm_color_<assetId>`, BRC-207, 0.9.0).
pub fn topicOf(a: std.mem.Allocator, id: [32]u8) ![]u8 {
    const buf = try a.create([color.name.max_topic_len]u8);
    return a.dupe(u8, color.name.topicName(buf, .{ .txid = id }));
}

/// The request's transaction: raw bytes, or a BEEF (V1, V2, Atomic) whose
/// subject it is, which brings the parents of inputs we do not hold.
pub const Subject = struct {
    raw: []const u8,
    tx: Transaction,
    ancestry: ?beef.Beef = null,
};

pub fn subjectOf(a: std.mem.Allocator, bytes: []const u8) ?Subject {
    if (bytes.len >= 4) {
        const magic = std.mem.readInt(u32, bytes[0..4], .little);
        if (magic == beef.V1 or magic == beef.V2 or magic == beef.ATOMIC) {
            const b = beef.parse(a, bytes) catch return null;
            const s = b.subject() orelse return null;
            const e = b.find(s) orelse return null;
            const raw = e.raw orelse return null;
            return .{ .raw = raw, .tx = Transaction.parse(a, raw) catch return null, .ancestry = b };
        }
    }
    const tx = Transaction.parse(a, bytes) catch return null;
    // Exactly one transaction, nothing after it.
    if (tx.serializedLen() != bytes.len) return null;
    return .{ .raw = bytes, .tx = tx };
}

/// The output an input spends: from what the overlay holds, else from the
/// request's BEEF (signature checks, and the topic's judgement: previous
/// coins always come from the overlay).
fn sourceOf(a: std.mem.Allocator, v: View, sub: Subject, in: bsvz.transaction.Input) !?bsv21.Output {
    const op: Outpoint = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index };
    if (try v.output(a, op)) |o| return o;
    const b = sub.ancestry orelse return null;
    const e = b.find(op.txid) orelse return null;
    const t = e.tx orelse (Transaction.parse(a, e.raw orelse return null) catch return null);
    if (op.vout >= t.outputs.len) return null;
    return .{ .script = t.outputs[op.vout].locking_script.bytes, .satoshis = @intCast(t.outputs[op.vout].satoshis) };
}

/// Which entries of a BEEF are `subject`'s ancestry (itself included): an
/// entry with its BUMP (or txid-only) ends a branch.
fn ancestryOf(a: std.mem.Allocator, b: beef.Beef, subject: [32]u8) ![]bool {
    const keep = try a.alloc(bool, b.entries.len);
    @memset(keep, false);
    const start = b.indexOf(subject) orelse return keep;
    keep[start] = true;
    var i = start + 1;
    while (i > 0) {
        i -= 1;
        if (!keep[i]) continue;
        const e = b.entries[i];
        if (e.format != .raw) continue;
        const t = e.tx orelse (Transaction.parse(a, e.raw orelse continue) catch continue);
        for (t.inputs) |in| if (b.indexOf(in.previous_outpoint.txid.bytes)) |k| {
            if (k < i) keep[k] = true;
        };
    }
    return keep;
}

/// The unproven parents of the request (raw entries of its BEEF, the
/// subject's ancestry, that the instance does not hold), parents first, each
/// with its Atomic BEEF.
pub fn unprovenParents(a: std.mem.Allocator, v: View, sub: Subject) ![]const Parent {
    const given = sub.ancestry orelse return &.{};
    const subject = given.subject() orelse return &.{};
    // Parents first (skein-sdk beef.sorted: a writer's order sorted, not refused): the walk back
    // from a transaction (`ancestryOf`) reaches every ancestor, and each Atomic BEEF is in order.
    const b = try beef.sorted(a, given);
    const ours = try ancestryOf(a, b, subject);
    var out: std.ArrayList(Parent) = .empty;
    for (b.entries, ours) |e, k| {
        if (!k or e.format != .raw or std.mem.eql(u8, &e.txid, &subject)) continue;
        if ((try v.rawTx(a, e.txid)) != null) continue;
        const keep = try ancestryOf(a, b, e.txid);
        var es: std.ArrayList(beef.Entry) = .empty;
        for (b.entries, keep) |x, kk| if (kk) try es.append(a, x);
        try out.append(a, .{ .txid = e.txid, .raw = e.raw orelse continue, .beef = try beef.serialize(a, .{
            .version = beef.V2,
            .atomic = e.txid,
            .bumps = b.bumps,
            .entries = es.items,
        }) });
    }
    return out.items;
}

/// The transaction as the topic's rules see it: each input's source where
/// the topic's own call reads it (the topic program's `txOf`, skein-1color color_topic.zig: the records
/// `submit.route` decoded — what the overlay holds, and the BEEF).
fn rulesTx(a: std.mem.Allocator, v: View, sub: Subject, txid: [32]u8) !bsv21.Tx {
    const ins = try a.alloc(bsv21.Input, sub.tx.inputs.len);
    for (sub.tx.inputs, ins) |in, *x| {
        x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
        x.source = try sourceOf(a, v, sub, in);
    }
    const outs = try a.alloc(bsv21.Output, sub.tx.outputs.len);
    for (sub.tx.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    return .{ .txid = txid, .inputs = ins, .outputs = outs };
}

/// The topic's judgement (`token.judge`) and the pool checks (`pool.check`)
/// of the transaction: a refusal, or the token's judgement (its inputs and
/// admitted outputs).
const Judged = union(enum) { refused: Reply, ok: struct { verdict: token.Verdict, j: bsv21.Judgement } };

fn judge(a: std.mem.Allocator, id: [32]u8, rtx: bsv21.Tx, previous: []const u32) !Judged {
    const verdict = token.judge(a, tokenId(id), rtx, previous) catch |e| return .{ .refused = refuse(.topic_refused, @errorName(e)) };
    if (verdict.rejected) |r| return .{ .refused = refuse(.topic_refused, @tagName(r)) };
    const j = try bsv21.judge(a, tokenId(id), rtx, previous);
    if (pool.check(j)) |v| return .{ .refused = refuse(.bad_pool, @tagName(v)) };
    return .{ .ok = .{ .verdict = verdict, .j = j } };
}

/// A pool at an output script: the token and the pool (a rescinded one among them), or null.
fn poolAt(script: []const u8) ?struct { token: brc162.Token, pool: pool.Pool } {
    const tok = brc162.decode(script) orelse return null;
    if (tok.role != .value) return null;
    const p = (pool.parse(tok.lock) catch return null) orelse return null;
    return .{ .token = tok, .pool = p };
}

/// The token id of the pool at an output script, or null.
pub fn poolTokenId(script: []const u8) ?[32]u8 {
    return (poolAt(script) orelse return null).pool.asset_id;
}

/// Follow a spent pool to its newest state: each spend's continuation is its
/// output 0 (the topic admits a pool nowhere else).
pub fn newest(a: std.mem.Allocator, v: View, topic: []const u8, from: Outpoint) !?Newest {
    var cur = from;
    var steps: usize = 0;
    while (steps < 100_000) : (steps += 1) {
        const sp = (try v.spender(a, topic, cur)) orelse break;
        const t = (try v.tx(a, sp)) orelse return null;
        if (t.outputs.len == 0) return .{ .closed = .{ .last = cur, .by = sp } };
        _ = poolAt(t.outputs[0].locking_script.bytes) orelse return .{ .closed = .{ .last = cur, .by = sp } };
        cur = .{ .txid = sp, .vout = 0 };
    }
    const o = (try v.output(a, cur)) orelse return null;
    const p = poolAt(o.script) orelse return null;
    return .{ .live = .{ .outpoint = cur, .satoshis = o.satoshis, .pool = p.pool } };
}

/// The key ID of the pool's current validator key (0.13.0), checked against its ValidatorPubKey
/// (public BRC-42 derivation from the identity), so a wrong walk signs nothing; null when it is
/// not ours to name (a rescinded pool among them). A Swap's continuation's key is keyed by the
/// pool outpoint the Swap spent: the transaction creating `pool_op`, its first token input a pool
/// it calls Swap on (`pool.keyId`). Otherwise the pool must attest itself (`pool.affirmedPool`:
/// a deploy, its key the identity's child keyed by its Nonce, its Affirmation verifying), and the
/// key ID is the Nonce (`pool.nonceKeyId`). An output a Close wrote in the shape of a pool
/// (Close's outputs are free) is neither, unless it is an affirmed pool byte for byte.
pub fn currentKeyId(a: std.mem.Allocator, v: View, p: pool.Pool, satoshis: u64, pool_op: Outpoint) !?[]const u8 {
    if (p.rescinded()) return null;
    if (try v.tx(a, pool_op.txid)) |t| for (t.inputs) |in| {
        const src: Outpoint = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index };
        const o = (try v.output(a, src)) orelse continue;
        if ((try bsv21.tokenOf(a, tokenId(p.asset_id), src.txid, src.vout, o.script)) == null) continue;
        // The first token input: a Swap of a pool names this pool's key.
        if (poolAt(o.script) != null and pool.methodOf(in.unlocking_script.bytes) == .swap) {
            const k = try pool.validatorKey(a, p.identity, src.txid, src.vout);
            if (std.mem.eql(u8, &k, &p.validator)) return try keyIdOf(a, src);
        }
        break;
    };
    if (pool.affirmedPool(a, p, satoshis)) {
        const buf = try a.create([64]u8);
        return pool.nonceKeyId(buf, p.nonce);
    }
    return null;
}

fn keyIdOf(a: std.mem.Allocator, op: Outpoint) ![]const u8 {
    const buf = try a.create([64 + 1 + 10]u8);
    return pool.keyId(buf, op.txid, op.vout);
}

pub const SpendRequest = struct {
    tx: []const u8,
    pool: Outpoint,
};

/// A swap request: check and sign. Never submits — see
/// messages.zig `finishSpend`, which routes the signed BEEF through skein's
/// `submit.route`.
pub fn spend(a: std.mem.Allocator, op: Op, req: SpendRequest, cfg: Config, v: View, oracle: Oracle) !Reply {
    const method = op.method() orelse return refuse(.bad_request, "affirm is not a spend");
    if (cfg.terms == null) return noTerms(); // 0.15.0: a market only signs nothing
    // 1. The transaction, and the pool input.
    const sub = subjectOf(a, req.tx) orelse return refuse(.bad_transaction, null);
    const tx = sub.tx;
    const pi = for (tx.inputs, 0..) |in, i| {
        if (in.previous_outpoint.index == req.pool.vout and std.mem.eql(u8, &in.previous_outpoint.txid.bytes, &req.pool.txid)) break i;
    } else return refuse(.pool_not_an_input, null);

    // 2. The pool, as we hold it; ours.
    const src = (try v.output(a, req.pool)) orelse return refuse(.unknown_pool, null);
    const cur = poolAt(src.script) orelse return refuse(.not_a_pool, null);
    if (!std.mem.eql(u8, &cur.pool.identity, &cfg.identity)) return refuse(.not_our_pool, null);
    const id = cur.pool.asset_id;
    const topic = try topicOf(a, id);
    if (!validating(cfg, topic)) return notValidating(a, topic);
    if (cur.pool.rescinded()) return refuse(.rescinded, null);

    // 3. Still live in the topic.
    const previous = try v.previousCoins(a, topic, tx);
    if (std.mem.indexOfScalar(u32, previous, @intCast(pi)) == null) {
        if (try v.spender(a, topic, req.pool)) |sp| {
            // This very request, signed already (held: awaiting the
            // broadcaster, or admitted): a retry. Answered again, not signed
            // again; its submission is routed again and the answer comes
            // from the state (503 while pending, then the transaction).
            if (try signedSpend(a, v, sp, sub, pi, method)) |raw| return .{ .ok = .{ .tx = raw, .txid = sp, .submission = .{
                .topic = topic,
                .pool = req.pool,
                .ancestry = sub.ancestry,
            } } };
            return .{ .refused = .{ .reason = .pool_spent, .newest = try newest(a, v, topic, req.pool) } };
        }
        return refuse(.unknown_pool, "not admitted in the topic");
    }

    // 4. The call's method, laid out as Rúnar calls it, our slot empty.
    const unlocking = tx.inputs[pi].unlocking_script.bytes;
    const m = pool.methodOf(unlocking) orelse return refuse(.bad_call, "no method index");
    if (m != method) return refuse(.wrong_method, @tagName(m));
    const call = (try unlock.parseCall(a, unlocking, m)) orelse return refuse(.bad_call, "not a Rúnar call of this method");
    if (!std.mem.eql(u8, call.code(), unlock.poolCode(cur.token.lock) orelse return refuse(.not_a_pool, null))) return refuse(.bad_call, "the code push is not the pool's code");
    const slot = call.arg(call.layout.validator_sig);
    if (slot.op != brc162.OP_0) return refuse(.signature_slot_not_empty, null);

    // 5. The next validator key: the child of the spent pool outpoint, in
    // the call and in the continuation.
    const next_key = try pool.validatorKey(a, cfg.identity, req.pool.txid, req.pool.vout);
    if (!std.mem.eql(u8, call.arg(call.layout.next_validator.?).data, &next_key)) return refuse(.wrong_next_key, "the call's nextValidatorPubKey");
    const cont = if (tx.outputs.len > 0) poolAt(tx.outputs[0].locking_script.bytes) else null;
    const next = cont orelse return refuse(.wrong_next_key, "no pool continuation at output 0");
    if (!std.mem.eql(u8, &next.pool.validator, &next_key)) return refuse(.wrong_next_key, "the continuation's ValidatorPubKey");

    // 6. Our topic would admit it, the pool checks pass, the pool first
    // among its token inputs.
    const txid = (try tx.txid(a)).bytes;
    const rtx = try rulesTx(a, v, sub, txid);
    const j = switch (try judge(a, id, rtx, previous)) {
        .refused => |r| return r,
        .ok => |x| x.j,
    };
    if (j.inputs.len == 0 or j.inputs[0].index != pi) return refuse(.pool_not_first_token_input, null);
    // The output set is the contract's.
    if (try swapOutputs(a, cur.pool, src.satoshis, call, tx.outputs)) |why| return refuse(.bad_outputs, why);
    // The minimum leg (0.40.0): the leg's sats side, the amount in on a buy, the payout on a sell.
    const min_leg = cfg.terms.?.min_leg_sats;
    if (min_leg > 0) {
        const sa = swapArgs(call).?; // swapOutputs read them
        const q = pool.quoteSwap(cur.pool, src.satoshis, sa.amount_in, sa.bsv_in).?;
        const leg = if (sa.bsv_in) sa.amount_in else q.out;
        if (leg < min_leg) return refuse(.below_minimum, try std.fmt.allocPrint(a, "the leg's {d} sats are under this validator's minimum leg of {d} sats", .{ leg, min_leg }));
    }

    // 7. The preimage the call carries is this input's.
    const script_code = unlock.poolScriptCode(cur.token.lock) orelse return refuse(.not_a_pool, null);
    const pre = try unlock.preimage(a, &tx, pi, script_code, src.satoshis, unlock.sighash_all_forkid);
    if (!std.mem.eql(u8, pre, call.preimage())) return refuse(.preimage_mismatch, null);
    const digest = unlock.sha256d(pre);

    // 8. Everyone else's signatures, and the unproven parents we do not hold (the taker's funding): complete.
    if (try inputsSigned(a, v, sub, tx, pi)) |r| return r;
    const parents = switch (try completeParents(a, v, sub)) {
        .refused => |r| return r,
        .ok => |ps| ps,
    };

    // 10. Our current key, then the signature.
    const key_id = (try currentKeyId(a, v, cur.pool, src.satoshis, req.pool)) orelse return refuse(.current_key_unknown, null);
    const der = oracle.sign(a, key_id, digest) catch |e| return refuse(.oracle_failed, @errorName(e));
    const checksig = try std.mem.concat(a, u8, &.{ der, &.{@as(u8, unlock.sighash_all_forkid)} });
    if (!unlock.verify(checksig, &cur.pool.validator, digest, unlock.sighash_all_forkid)) return refuse(.oracle_failed, "the signature is not the pool's validator key's");

    const inputs = try a.dupe(bsvz.transaction.Input, tx.inputs);
    inputs[pi].unlocking_script = bsvz.script.Script.init(try unlock.withArg(a, call, call.layout.validator_sig, checksig));
    var signed = tx;
    signed.inputs = inputs;
    const raw = try signed.serialize(a);
    return .{ .ok = .{ .tx = raw, .txid = beef.txidOf(raw), .submission = .{
        .topic = topic,
        .pool = req.pool,
        .ancestry = sub.ancestry,
        .parents = parents,
    } } };
}

/// Every input of `tx` but `skip` carries a signature, verified in full where
/// it spends a P2PKH output (plain or under a token prefix) whose source we
/// have (held, or in the request's BEEF): null, or the refusal naming the input.
fn inputsSigned(a: std.mem.Allocator, v: View, sub: Subject, tx: Transaction, skip: ?usize) !?Reply {
    for (tx.inputs, 0..) |in, i| {
        if (skip) |k| if (i == k) continue;
        const s = try sourceOf(a, v, sub, in);
        switch (try unlock.checkInput(a, &tx, i, if (s) |o| o.script else null, if (s) |o| o.satoshis else 0)) {
            .verified, .present => {},
            .missing => return refuse(.missing_signature, try std.fmt.allocPrint(a, "input {d}", .{i})),
            .bad => return refuse(.bad_signature, try std.fmt.allocPrint(a, "input {d}", .{i})),
        }
    }
    return null;
}

/// The request's unproven parents we do not hold (`unprovenParents`: the
/// taker's or the LP's nosend funding transaction), each complete: every
/// input signed, verified likewise. The parents, or the refusal.
fn completeParents(a: std.mem.Allocator, v: View, sub: Subject) !union(enum) { ok: []const Parent, refused: Reply } {
    const parents = try unprovenParents(a, v, sub);
    for (parents) |par| {
        const pt = Transaction.parse(a, par.raw) catch return .{ .refused = refuse(.bad_transaction, "an unproven parent") };
        for (pt.inputs, 0..) |in, i| {
            const s = try sourceOf(a, v, sub, in);
            switch (try unlock.checkInput(a, &pt, i, if (s) |o| o.script else null, if (s) |o| o.satoshis else 0)) {
                .verified, .present => {},
                .missing => return .{ .refused = refuse(.missing_signature, try std.fmt.allocPrint(a, "parent {s} input {d}", .{ &w.header.toHex(par.txid), i })) },
                .bad => return .{ .refused = refuse(.bad_signature, try std.fmt.allocPrint(a, "parent {s} input {d}", .{ &w.header.toHex(par.txid), i })) },
            }
        }
    }
    return .{ .ok = parents };
}

/// A Swap call's args (pool/Pool.runar.go `Swap`): amountIn, bsvIn,
/// userPkh, commissionPkh, tokenChangePkh, tokenChange (0.40.0), as Rúnar pushes them
/// (minimal numbers, 20-byte addresses), and Rúnar's sats change.
pub const SwapArgs = struct {
    amount_in: u64,
    bsv_in: bool,
    user_pkh: [20]u8,
    commission_pkh: [20]u8,
    token_change_pkh: [20]u8,
    token_change: u64,
    change_pkh: []const u8,
    change: u64,
};

fn pkhArg(p: brc162.Push) ?[20]u8 {
    if (p.op != 20 or p.data.len != 20) return null;
    return p.data[0..20].*;
}

pub fn swapArgs(call: unlock.Call) ?SwapArgs {
    const amount = pool.canonicalNum(call.arg(2)) orelse return null;
    const bsv_in = pool.canonicalNum(call.arg(3)) orelse return null;
    const token_change = pool.canonicalNum(call.arg(7)) orelse return null;
    const change = pool.canonicalNum(call.changeAmount()) orelse return null;
    if (amount <= 0 or token_change < 0 or change < 0 or (bsv_in != 0 and bsv_in != 1)) return null;
    return .{
        .amount_in = @intCast(amount),
        .bsv_in = bsv_in == 1,
        .user_pkh = pkhArg(call.arg(4)) orelse return null,
        .commission_pkh = pkhArg(call.arg(5)) orelse return null,
        .token_change_pkh = pkhArg(call.arg(6)) orelse return null,
        .token_change = @intCast(token_change),
        .change_pkh = call.changePkh(),
        .change = @intCast(change),
    };
}

/// A Swap's output set against the contract's (the pool spent holding
/// `satoshis`): 0 the continuation holding the new reserves, 1 the payout to
/// userPkh in the other asset, then the LP fee (to the LpPubKey's hash), the
/// validator fee (to the spent ValidatorPubKey's hash) and the commission
/// (to commissionPkh), each in the input asset and only when nonzero, then
/// (0.40.0) the token change (1 sat, `tokenChange` tokens to tokenChangePkh)
/// exactly when `tokenChange > 0`, then Rúnar's change output (P2PKH to
/// `_changePKH`) when `_changeAmount > 0`, and nothing else. The contract commits to the same set (hashOutputs);
/// this refuses before signing, with the reason. Null when it matches.
pub fn swapOutputs(a: std.mem.Allocator, spent: pool.Pool, satoshis: u64, call: unlock.Call, outs: []const bsvz.transaction.Output) !?[]const u8 {
    const args = swapArgs(call) orelse return "the Swap args (amountIn, bsvIn, userPkh, commissionPkh, tokenChangePkh, tokenChange, change)";
    const q = pool.quoteSwap(spent, satoshis, args.amount_in, args.bsv_in) orelse return "the contract refuses this amountIn (fees, payout or reserves)";
    if (outs.len == 0) return "no continuation";
    const next = poolAt(outs[0].locking_script.bytes) orelse return "output 0 is not a pool";
    if (outs[0].satoshis != q.bsv_reserve) return "the continuation's BSV reserve";
    if (next.pool.token_reserve != q.token_reserve) return "the continuation's TokenReserve";
    const Want = struct { name: []const u8, amount: u64, pkh: [20]u8, is_bsv: bool };
    const lp_pkh = bsvz.crypto.hash.hash160(&spent.lp).bytes;
    const val_pkh = bsvz.crypto.hash.hash160(&spent.validator).bytes;
    var wants: std.ArrayList(Want) = .empty;
    try wants.append(a, .{ .name = "the payout", .amount = q.out, .pkh = args.user_pkh, .is_bsv = !args.bsv_in });
    if (q.lp_fee > 0) try wants.append(a, .{ .name = "the LP fee", .amount = q.lp_fee, .pkh = lp_pkh, .is_bsv = args.bsv_in });
    if (q.validator_fee > 0) try wants.append(a, .{ .name = "the validator fee", .amount = q.validator_fee, .pkh = val_pkh, .is_bsv = args.bsv_in });
    if (q.commission > 0) try wants.append(a, .{ .name = "the commission", .amount = q.commission, .pkh = args.commission_pkh, .is_bsv = args.bsv_in });
    if (args.token_change > 0) try wants.append(a, .{ .name = "the token change", .amount = args.token_change, .pkh = args.token_change_pkh, .is_bsv = false });
    for (wants.items, 1..) |x, i| {
        if (i >= outs.len) return try std.fmt.allocPrint(a, "{s}: no output {d}", .{ x.name, i });
        const script = try pool.payoutScript(a, spent.asset_id, x.amount, x.pkh, x.is_bsv);
        if (outs[i].satoshis != pool.payoutSats(x.amount, x.is_bsv) or !std.mem.eql(u8, outs[i].locking_script.bytes, script))
            return try std.fmt.allocPrint(a, "{s}: output {d} is not the contract's", .{ x.name, i });
    }
    var at = 1 + wants.items.len;
    if (args.change > 0) {
        if (at >= outs.len) return "no change output";
        const pkh = unlock.p2pkhHash(outs[at].locking_script.bytes) orelse return "the change output is not P2PKH";
        if (args.change_pkh.len != 20 or !std.mem.eql(u8, &pkh, args.change_pkh) or outs[at].satoshis != args.change) return "the change output is not the call's";
        at += 1;
    }
    if (outs.len != at) return "outputs past the contract's";
    return null;
}

/// Whether the held transaction `sp` (a spender of the pool) is this request
/// with our signature in its slot: its pool call, the slot emptied again,
/// gives back the request byte for byte. → its bytes, or null.
pub fn signedSpend(a: std.mem.Allocator, v: View, sp: [32]u8, sub: Subject, pi: usize, method: pool.Method) !?[]const u8 {
    const raw = (try v.rawTx(a, sp)) orelse return null;
    const t = Transaction.parse(a, raw) catch return null;
    if (t.inputs.len != sub.tx.inputs.len) return null;
    const u = t.inputs[pi].unlocking_script.bytes;
    if (pool.methodOf(u) != method) return null;
    const call = (try unlock.parseCall(a, u, method)) orelse return null;
    const inputs = try a.dupe(bsvz.transaction.Input, t.inputs);
    inputs[pi].unlocking_script = bsvz.script.Script.init(try unlock.withArg(a, call, call.layout.validator_sig, &.{}));
    var bare = t;
    bare.inputs = inputs;
    return if (std.mem.eql(u8, try bare.serialize(a), sub.raw)) raw else null;
}

/// A proposed pool, as the LP's page asks it affirmed (0.13.0): the pool output's locking script
/// as the deploy will carry it, its ValidatorPubKey, Nonce and Affirmation not yet known (their
/// values are ignored: the page sends 33 zero bytes, 32 zero bytes and an empty Affirmation), and
/// its satoshis. `nonce` is for tests (a fixed nonce); a request never carries one.
pub const AffirmRequest = struct {
    pool: []const u8,
    satoshis: u64,
    nonce: ?[32]u8 = null,
};

/// The affirmation (skein-amm 0.11.0; 0.13.0, David Case 2026-10-22: the validator's nonce;
/// docs/AMM.md "The deploy and the affirmation"). Before the LP's wallet builds the deploy, the
/// validator checks the proposed pool, picks a random 32-byte nonce, derives its key from it
/// (`pool.firstValidatorKey`, the key this validator signs the pool's first swap with) and signs
/// the pool's parameters as they will be (`pool.affirmMessage`, message v2, the key and the nonce
/// in it). Checked, in order: the script is a pool (the Pool code, a 32-byte id at output 0's
/// form, its prefix agreeing with the state) with no payload; its ValidatorIdentity is ours; its
/// token's topic is one this instance validates; its fees are our terms, exactly; its reserves are
/// positive; the signer's key for the nonce is the derived one. Answers `{validatorPubKey, nonce,
/// signature}`; the page finalizes the pool's state with them. Nothing is submitted or recorded:
/// the deploy is the LP's wallet's, submitted to the token topic like any token transaction.
pub fn affirm(a: std.mem.Allocator, req: AffirmRequest, cfg: Config, oracle: Oracle) !Reply {
    const t = cfg.terms orelse return noTerms(); // 0.15.0: a market only affirms nothing
    const tok = brc162.decode(req.pool) orelse return refuse(.not_a_pool, null);
    if (tok.role != .value) return refuse(.not_a_pool, null);
    if (tok.payload != null) return refuse(.bad_request, "the pool script carries a payload");
    var p = (pool.parse(tok.lock) catch return refuse(.bad_pool, "malformed")) orelse return refuse(.not_a_pool, null);
    const id = tok.id orelse return refuse(.bad_pool, "no token id");
    if (id.vout != 0 or !std.mem.eql(u8, &id.txid, &p.asset_id) or tok.amount != p.token_reserve) return refuse(.bad_pool, "prefix_mismatch");
    if (!std.mem.eql(u8, &p.identity, &cfg.identity)) return refuse(.not_our_pool, null);
    const topic = try topicOf(a, p.asset_id);
    if (!validating(cfg, topic)) return notValidating(a, topic);

    // Our terms, exactly (0.9.0: the validator's fees; the LP accepts them).
    if (p.lp_fee_bps != t.lp_fee_bps) return refuse(.fees_unacceptable, try std.fmt.allocPrint(a, "lpFeeBps: the terms are {d}", .{t.lp_fee_bps}));
    if (p.validator_fee_bps != t.validator_fee_bps) return refuse(.fees_unacceptable, try std.fmt.allocPrint(a, "validatorFeeBps: the terms are {d}", .{t.validator_fee_bps}));
    if (p.commission_bps != t.commission_bps) return refuse(.fees_unacceptable, try std.fmt.allocPrint(a, "commissionBps: the terms are {d}", .{t.commission_bps}));
    if (req.satoshis == 0 or p.token_reserve == 0) return refuse(.bad_request, "the pool's reserves must be positive");

    // The nonce (random: in a step, the entry-derived stream; in a call, real entropy), our key
    // keyed by it, and the signer agreeing.
    var nonce: [32]u8 = undefined;
    if (req.nonce) |n| nonce = n else std.Io.Threaded.global_single_threaded.io().randomSecure(&nonce) catch |e| return refuse(.oracle_failed, @errorName(e));
    p.nonce = nonce;
    p.validator = try pool.firstValidatorKey(a, cfg.identity, nonce);
    var kbuf: [64]u8 = undefined;
    const key_id = pool.nonceKeyId(&kbuf, nonce);
    const ours = oracle.publicKey(a, key_id) catch |e| return refuse(.oracle_failed, @errorName(e));
    if (!std.mem.eql(u8, &ours, &p.validator)) return refuse(.wrong_validator_key, "the signer's key differs");

    const der = oracle.sign(a, key_id, pool.affirmDigest(p, req.satoshis)) catch |e| return refuse(.oracle_failed, @errorName(e));
    if (!pool.affirmationVerifies(p, req.satoshis, der)) return refuse(.oracle_failed, "the signature is not the pool's validator key's");
    return .{ .ok = .{ .signature = der, .validator_pub_key = p.validator, .nonce = nonce } };
}
