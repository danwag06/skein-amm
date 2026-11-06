//! The marketplace relay (docs/notes.md 2026-10-02, "Marketplace relay"):
//! the taker's own skein takes the pair a page built — the nosend funding
//! transaction and the swap spending its output — checks it, records the
//! swap in flight under the app's head, and carries it to the pool's
//! validator over a libp2p direct call, so the browser never needs libp2p.
//! Pure: no VM imports (main.zig wires it).
//!
//! **The pair** (`checkPair`):
//!
//!   funding  the taker's funding transaction: raw, or a BEEF (V1, V2, Atomic:
//!            BRC-100 createAction's `tx`) whose subject it is and which carries
//!            its ancestry. The validator's overlay verifies every unproven
//!            transaction's inputs against a parent in the BEEF or one it holds
//!            (skein-overlay `verifyDecoded`), so a raw funding transaction
//!            verifies only where the validator holds its parents.
//!   swap     the raw swap: input 0 the pool with its Rúnar call (the
//!            validator's signature slot `OP_0`), another input an output of the
//!            funding transaction, every other input signed; outputs as the Pool
//!            contract's Swap writes them: 0 the continuation, 1 the payout, then
//!            the LP fee, the validator fee and the commission (the pool's
//!            CommissionBps of amountIn, in the input asset, to the call's
//!            commissionPkh), each only when nonzero, then at most one change
//!            output. The commission must pay this relay's pkh (0.16.0: its
//!            own derived key, `commission_protocol`) when the pool charges one.
//!
//! **The record** (one per swap, keyed by `id` = sha256 of the swap's bytes,
//! the validator's slot still empty), in the app's state map `swaps`:
//!
//!   {kind: "amm-swap", id: <hex>, status: "pending" | "accepted" | "refused" | "timeout" | "failed",
//!    funding: bytes, swap: bytes, pool: "<txid>_<vout>", validator: bytes(33), expires: ms,
//!    created: ms, updated: ms,
//!    tx?: bytes, txid?: text                          accepted: the validator's signed swap
//!    reason?: text, detail?: text, poolState?: map    refused (the validator's), timeout, failed
//!    peer?, local?, dial?, stream?, thread?, request?} the relay's own: not in the answer
//!
//! **The validator named** (0.4.0, shruggr/skein#120, David 2026-10-06): the
//! caller names the validator, its identity key (`validator`) and its libp2p
//! peer ID (`peerId`, text: what the page read from the runtime's liveness
//! endpoint, the beat's body). The relay looks at no liveness: it dials the
//! peer it was given, or — when `peerId` is this node's own (`Env.self_peer`)
//! — hands the request to its own validator program in-VM (`local`).
//!
//! **The relay** (`advance`): a thread resting on the libp2p provider's
//! answers to one dial (docs/MESSAGES.md "The providers", "Awaiting the
//! answer"), bounded by `expires` (the waker, `deadline`):
//!
//!   start                  emit dial {peer, protocol: /amm-validator/1/swap}; rest
//!   {stream} (box dial)    emit send {stream, body: the package, naming the token's topic}; rest
//!   {stream, body} (frame) the validator's answer: accepted | refused; emit close; done — or
//!                          (0.41.0) when it carries a `beef` (accepted: what the validator
//!                          submitted to its own overlay; `pool_spent`: the newest pool's
//!                          transaction), emit close and submit that BEEF to THIS instance's own
//!                          overlay (the token topic, the message amm-validator's submit.zig sends);
//!                          rest on that submission
//!   the overlay's answer   (0.41.0) the validator's answer applied: accepted | refused (a refusal
//!                          by this overlay said in `detail`; the validator's verdict stands); done
//!   closed | error         failed; done
//!   woke at/after expires  timeout (close the stream if open); done — while the overlay has not
//!                          answered (0.41.0): the validator's answer applied, `detail` saying so
//!
//! **Local** (`advanceLocal`, `localAnswer`): the validator is this instance.
//! A node does not dial itself, so the relay does what the front door does
//! with a frame on `/amm-validator/1/swap` (skein programs/frontdoor
//! libp2p.zig `stepped`): it calls the route's handler, amm-validator's fn
//! `swap`, in-VM with the same package as the
//! frame's body, from the relay thread's step. The handler answers `{verdict,
//! body}` (the reply: accepted | refused; done) or `{wait: true}` after
//! awaiting its submission (the thread rests on it); stepped again by the
//! engine's answer (`reply`) or the awaited thread at rest (`resolved`), the
//! relay calls the handler again with it, as the front door does; woke
//! at/after `expires`: timeout.
//!
//! The package is the signed-message package the validator's protocol reads
//! (amm-validator README, "A direct call"): `{message, body, topic}`, the mail
//! record signed BRC-169's way by this instance's identity, recipient the
//! validator, box `swap`, and the body `{tx: <BEEF: the funding transaction's
//! ancestry, the funding transaction, the swap>, pool}`. `topic` (0.31.0) is
//! this instance's token topic `tm_color_<assetId>` (head `amm/token`): the
//! validator's host runs several instances on one libp2p node and routes the
//! stream by the first frame's top-level `topic` (skein `p2p.ts`
//! `streamHandle`); unsigned, it routes only.
//!
//! **The affirmation** (`amm.pool/1`'s `affirm`, skein-amm 0.11.0, David Case 2026-10-21): the
//! LP's page asks this skein's validator to affirm a proposed pool before its wallet builds the
//! deploy. Nothing is recorded or relayed over libp2p: `affirmBody` checks the args, main.zig
//! packages them (box `affirm`, from this instance to itself) and calls amm-validator's fn
//! `affirm` in-VM, which answers at once (`affirmAnswer`): `{validatorPubKey, nonce, signature}`
//! (0.13.0: the validator picks the nonce and its key), or the refusal. The
//! deploy itself is the LP's wallet's (BRC-207), submitted to the token topic like any token
//! transaction. (0.9.0's delivered deploy — `amm.pool.submit` / `amm.pool.status`, a record of
//! kind `amm-pool`, relayed on `/amm-validator/1/deploy` and accepted with the validator's claim
//! appended — is gone; so is AddLiquidity, `amm.liquidity/1`.)
const std = @import("std");
const w = @import("chain");
const color = @import("1color");
const scbor = @import("sdk_cbor");
const libp2p = @import("libp2p.zig");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const Transaction = w.bsvz.transaction.Transaction;
const beef = w.beef;
const brc162 = color.brc162;
const pool = @import("pool");
const terms_mod = @import("terms");
pub const market = @import("market.zig");
const eql = std.mem.eql;

/// The app (its box, and the prefix of its heads) and the interface's functions.
pub const app_name = "amm";
/// The app's root head (skein-sdk 0.3.0 `app.headOf`, shruggr/skein#77: an
/// app's heads are `<app>/…`, its root `<app>/app`), where the relay keeps
/// its state.
pub const app_head = app_name ++ "/app";
/// This program's own state (the catch-up cursor; 0.6.0),
/// under the app's name too: under #77 an installed app advances only heads
/// named `<app>/…`.
pub const p2p_head = app_name ++ "/p2p";
pub const fn_submit = "amm.swap.submit";
pub const fn_status = "amm.swap.status";
pub const fn_terms = "amm.swap.terms";
/// The validator's terms (0.9.0): what a pool here must carry.
pub const fn_pool_terms = "amm.pool.terms";
/// The affirmation (0.11.0): a proposed pool, checked against the terms and signed.
pub const fn_pool_affirm = "amm.pool.affirm";
/// The validator's direct calls, and the boxes their packages name.
pub const swap_protocol = "/amm-validator/1/swap";
pub const swap_box = "swap";
/// The affirm call (0.11.0): amm-validator's fn `affirm`, called in-VM only (no libp2p route).
pub const affirm_protocol = "/amm-validator/1/affirm";
pub const affirm_box = "affirm";
/// The launched relay thread's argument record: `{kind, id}`.
pub const relay_kind = "amm-swap-relay";
pub const record_kind = "amm-swap";
pub const state_kind = "amm-app-state";

/// What a record relays: a swap (`amm.swap/1`). (0.11.0: the pool deploy, `amm.pool.submit`,
/// is gone: the deploy is the LP's wallet's.) Kept as a kind so the records, the relay thread
/// and the validator's call stay named as they were.
pub const Kind = enum {
    swap,

    pub fn recordKind(_: Kind) []const u8 {
        return record_kind;
    }
    pub fn relayKind(_: Kind) []const u8 {
        return relay_kind;
    }
    pub fn protocol(_: Kind) []const u8 {
        return swap_protocol;
    }
    pub fn box(_: Kind) []const u8 {
        return swap_box;
    }
    /// The submit function whose answer a message caller waits for.
    pub fn submitFn(_: Kind) []const u8 {
        return fn_submit;
    }
    /// The record's field holding what was relayed: the raw swap.
    pub fn subjectKey(_: Kind) []const u8 {
        return "swap";
    }
    /// The status function of the kind.
    pub fn statusFn(_: Kind) []const u8 {
        return fn_status;
    }
    pub fn ofRelay(s: []const u8) ?Kind {
        return if (eql(u8, s, relay_kind)) .swap else null;
    }
    pub fn ofRecord(s: []const u8) ?Kind {
        return if (eql(u8, s, record_kind)) .swap else null;
    }
    /// The kind whose submit function is `name`.
    pub fn ofSubmit(name: []const u8) ?Kind {
        return if (eql(u8, name, fn_submit)) .swap else null;
    }
};

/// The relay's commission: a swap is relayed only if its commission output pays `pkh` (a pool
/// whose CommissionBps is 0 has none, and passes). The page learns `pkh` from `amm.swap.terms` and
/// names it as Swap's commissionPkh. 0.16.0: `pkh` is no longer config (`config.amm.commission`,
/// genesis `defaults.ammCommission`, gone): it is hash160 of this instance's own key for the relay,
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

// ---------------------------------------------------------------- the pair

pub const Refusal = struct { reason: []const u8, detail: ?[]const u8 = null };

/// A swap's call to the pool and its parser: src/pool.zig's (0.32.0: moved there so amm-lookup's
/// LP fee totals read a swap as this check does).
pub const SwapCall = pool.SwapCall;
pub const swap_pushes = pool.swap_pushes;
pub const parseSwapCall = pool.parseSwapCall;

/// The validator's signature slot (the call's first argument) is `OP_0`.
pub fn slotEmpty(script: []const u8) bool {
    const code = brc162.readPush(script, 0) orelse return false;
    const slot = brc162.readPush(script, code.next) orelse return false;
    return slot.op == brc162.OP_0;
}

/// An outpoint, BRC-162's text form `<txid, display hex>_<vout>`.
pub const Outpoint = struct {
    txid: [32]u8,
    vout: u32,

    pub fn parse(text: []const u8) ?Outpoint {
        if (text.len < 66 or text[64] != '_') return null;
        for (text[0..64]) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return null;
        const txid = w.header.fromHex(text[0..64]) catch return null;
        const digits = text[65..];
        if (digits.len == 0 or digits.len > 10 or (digits.len > 1 and digits[0] == '0')) return null;
        return .{ .txid = txid, .vout = std.fmt.parseInt(u32, digits, 10) catch return null };
    }
};

/// A transaction given as raw bytes or as a BEEF whose subject it is.
pub const Given = struct {
    raw: []const u8,
    tx: Transaction,
    txid: [32]u8,
    beef: ?beef.Beef = null,
};

pub fn given(a: Allocator, bytes: []const u8) ?Given {
    if (bytes.len >= 4) {
        const magic = std.mem.readInt(u32, bytes[0..4], .little);
        if (magic == beef.V1 or magic == beef.V2 or magic == beef.ATOMIC) {
            const b = beef.parse(a, bytes) catch return null;
            const s = b.subject() orelse return null;
            const e = b.find(s) orelse return null;
            const raw = e.raw orelse return null;
            return .{ .raw = raw, .tx = Transaction.parse(a, raw) catch return null, .txid = s, .beef = b };
        }
    }
    const tx = Transaction.parse(a, bytes) catch return null;
    if (tx.serializedLen() != bytes.len) return null;
    return .{ .raw = bytes, .tx = tx, .txid = beef.txidOf(bytes) };
}

pub const Pair = struct {
    funding: Given,
    swap: Given,
    pool: Outpoint,
    call: SwapCall,
    continuation: pool.Pool,
};

pub const Checked = union(enum) { ok: Pair, refused: Refusal };

fn refused(reason: []const u8, detail: ?[]const u8) Checked {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

fn p2pkhHash(lock: []const u8) ?[]const u8 {
    if (lock.len != 25 or lock[0] != 0x76 or lock[1] != 0xa9 or lock[2] != 0x14 or lock[23] != 0x88 or lock[24] != 0xac) return null;
    return lock[3..23];
}

/// Check a pair before anything is written (`amm.swap.submit`'s first step).
/// `now` is the step's clock; `validator` the identity the caller names.
pub fn checkPair(a: Allocator, funding_bytes: []const u8, swap_bytes: []const u8, pool_text: []const u8, validator: []const u8, expires: u64, now: u64, commission: Commission) !Checked {
    if (validator.len != 33 or (validator[0] != 2 and validator[0] != 3)) return refused("bad_validator", "an identity key: 33 bytes, compressed");
    if (expires <= now) return refused("expired", null);
    const funding = given(a, funding_bytes) orelse return refused("bad_funding", "not a transaction, or a BEEF whose subject is one");
    const swap_g = given(a, swap_bytes) orelse return refused("bad_swap", "not a transaction");
    if (swap_g.beef != null) return refused("bad_swap", "the swap is the raw transaction");
    const swap = swap_g.tx;
    const op = Outpoint.parse(pool_text) orelse return refused("bad_pool", "want <txid>_<vout>");

    // The swap spends the pool (input 0) and an output of the funding transaction.
    if (swap.inputs.len < 2) return refused("bad_swap", "a swap has the pool and the funding as inputs");
    const p0 = swap.inputs[0].previous_outpoint;
    if (p0.index != op.vout or !eql(u8, &p0.txid.bytes, &op.txid)) return refused("pool_not_input_0", null);
    const spends_funding = for (swap.inputs[1..]) |in| {
        if (eql(u8, &in.previous_outpoint.txid.bytes, &funding.txid) and in.previous_outpoint.index < funding.tx.outputs.len) break true;
    } else false;
    if (!spends_funding) return refused("funding_not_spent", null);

    // Complete: every funding input and every swap input but the pool's carries its unlocking script.
    for (funding.tx.inputs, 0..) |in, i| if (in.unlocking_script.bytes.len == 0) return refused("funding_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));
    for (swap.inputs[1..], 1..) |in, i| if (in.unlocking_script.bytes.len == 0) return refused("swap_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));

    // The pool call: Swap, laid out as Rúnar calls it, the validator's slot empty.
    const unlocking = swap.inputs[0].unlocking_script.bytes;
    if (pool.methodOf(unlocking) != .swap) return refused("not_a_swap", null);
    const call = (try parseSwapCall(a, unlocking)) orelse return refused("bad_call", "not a Rúnar call of Swap");
    if (!slotEmpty(unlocking)) return refused("signature_slot_not_empty", null);
    if (call.amount_in == 0) return refused("bad_call", "amountIn");
    if (call.user_pkh.len != 20) return refused("bad_call", "userPkh");
    if (call.commission_pkh.len != 20) return refused("bad_call", "commissionPkh");
    if (call.token_change_pkh.len != 20) return refused("bad_call", "tokenChangePkh");

    // The outputs, as the contract writes them.
    if (swap.outputs.len < 2) return refused("bad_outputs", "no continuation and payout");
    const tok = brc162.decode(swap.outputs[0].locking_script.bytes) orelse return refused("bad_outputs", "output 0 is not a pool");
    if (tok.role != .value) return refused("bad_outputs", "output 0 is not a pool");
    const cont = (pool.parse(tok.lock) catch return refused("bad_outputs", "output 0: a malformed pool")) orelse return refused("bad_outputs", "output 0 is not a pool");
    if (!eql(u8, &cont.identity, validator)) return refused("wrong_validator", "the pool's ValidatorIdentity is another");
    // Where the fees go (src/pool.zig `feeLayout`, the one layout amm-lookup reads the LP's fee by).
    const fl = pool.feeLayout(call, cont) catch |e| return refused("bad_outputs", switch (e) {
        error.LpFeeBps => "lpFeeBps",
        error.ValidatorFeeBps => "validatorFeeBps",
        error.CommissionBps => "commissionBps",
    });
    const com = fl.commission;
    if (fl.commission_at) |at| {
        // The commission: in the input asset, to the call's commissionPkh.
        if (at > swap.outputs.len) return refused("bad_outputs", "the fee outputs");
        if (at >= swap.outputs.len) return refused("bad_outputs", "the commission: no output");
        const o = swap.outputs[at];
        const want = try pool.payoutScript(a, cont.asset_id, com, call.commission_pkh[0..20].*, call.bsv_in);
        if (o.satoshis != pool.payoutSats(com, call.bsv_in) or !eql(u8, o.locking_script.bytes, want)) return refused("bad_outputs", "the commission: not the contract's");
    } else if (fl.end > swap.outputs.len) return refused("bad_outputs", "the fee outputs");
    // The token change (0.40.0): an output after the fees exactly when the call names one.
    if (fl.token_change_at) |at| if (at >= swap.outputs.len) return refused("bad_outputs", "the token change: no output");
    if (swap.outputs.len > fl.end + @intFromBool(call.change > 0)) return refused("bad_outputs", "outputs past the contract's");

    // Our commission: the swap pays it to us (none when the pool charges none).
    if (commission.pkh) |ours| if (com > 0 and !eql(u8, call.commission_pkh, &ours))
        return refused("commission_missing", try std.fmt.allocPrint(a, "the commission pays {s}, not {s}", .{ &std.fmt.bytesToHex(call.commission_pkh[0..20].*, .lower), &std.fmt.bytesToHex(ours, .lower) }));
    return .{ .ok = .{ .funding = funding, .swap = swap_g, .pool = op, .call = call, .continuation = cont } };
}

/// The swap's id: sha256 of its bytes (the validator's slot empty), hex.
pub fn idOf(swap: []const u8) [32]u8 {
    var d: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(swap, &d, .{});
    return d;
}

pub fn idText(id: [32]u8) [64]u8 {
    return std.fmt.bytesToHex(id, .lower);
}

pub fn idParse(text: []const u8) ?[32]u8 {
    if (text.len != 64) return null;
    var id: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&id, text) catch return null;
    return id;
}

// ---------------------------------------------------------------- the BEEF and the package

/// The ancestry of `subject` within a BEEF (itself included), parents first, in the BEEF's order.
fn ancestry(a: Allocator, b: beef.Beef, subject: [32]u8) ![]bool {
    const keep = try a.alloc(bool, b.entries.len);
    @memset(keep, false);
    const start = b.indexOf(subject) orelse return keep;
    keep[start] = true;
    var i = start + 1;
    while (i > 0) {
        i -= 1;
        if (!keep[i]) continue;
        const e = b.entries[i];
        if (e.format != .raw) continue; // proven (with its BUMP) or txid-only: no further ancestry needed
        const t = e.tx orelse (Transaction.parse(a, e.raw orelse continue) catch continue);
        for (t.inputs) |in| if (b.indexOf(in.previous_outpoint.txid.bytes)) |k| {
            if (k < i) keep[k] = true;
        };
    }
    return keep;
}

/// The one BEEF the validator gets: the ancestry (its BEEF's, when the funding
/// came as one) of every input of the swap whose source transaction that BEEF
/// holds (0.40.1: a leg may spend rows of unrelated transactions; before, the
/// funding transaction's alone), the funding transaction (unproven) among them,
/// then the swap as the subject. V2, parents first.
pub fn requestBeef(a: Allocator, p: Pair) ![]u8 {
    var entries: std.ArrayList(beef.Entry) = .empty;
    var bumps: []w.merkle.MerklePath = &.{};
    if (p.funding.beef) |given_b| {
        // Parents first (skein-sdk beef.sorted: a writer's order sorted, not refused).
        const b = try beef.sorted(a, given_b);
        const keep = try ancestry(a, b, p.funding.txid);
        for (p.swap.tx.inputs) |in| {
            const src = in.previous_outpoint.txid.bytes;
            if (b.indexOf(src) == null) continue;
            for (try ancestry(a, b, src), keep) |x, *k| k.* = k.* or x;
        }
        // Keep the BUMPs as they are (indices stay valid); only the entries are filtered.
        bumps = b.bumps;
        for (b.entries, keep) |e, k| if (k) try entries.append(a, e);
    } else {
        try entries.append(a, .{ .txid = p.funding.txid, .format = .raw, .raw = p.funding.raw, .tx = p.funding.tx });
    }
    try entries.append(a, .{ .txid = p.swap.txid, .format = .raw, .raw = p.swap.raw, .tx = p.swap.tx });
    return beef.serialize(a, .{ .version = beef.V2, .bumps = bumps, .entries = entries.items });
}

/// The validator's request body: `{tx: <the BEEF>, pool}` (amm-validator README, "Protocol").
pub fn requestBody(a: Allocator, tx: []const u8, pool_text: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tx", .value = .{ .bytes = tx } },
        .{ .key = "pool", .value = .{ .text = pool_text } },
    }) };
}

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

/// The nonce of a swap's package: the first 16 bytes of sha256("amm-swap-relay" ‖ id).
pub fn nonceOf(id: [32]u8) [16]u8 {
    return nonceFor(.swap, id);
}

/// The nonce of a record's package: the first 16 bytes of sha256(<its relay kind> ‖ id)
/// ("amm-swap-relay").
pub fn nonceFor(kind: Kind, id: [32]u8) [16]u8 {
    var d: [32]u8 = undefined;
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update(kind.relayKind());
    h.update(&id);
    h.final(&d);
    return d[0..16].*;
}

/// The package for a record, to the validator: a swap's request BEEF (from
/// the pair the record keeps) and the pool in box `swap`; `topic` the token's
/// overlay topic the dialled host routes the stream by (`package`).
pub fn packageFor(a: Allocator, signer: Signer, rec: Record, topic: ?[]const u8) ![]u8 {
    const f = given(a, rec.funding) orelse return error.BadRecord;
    const s = given(a, rec.swap) orelse return error.BadRecord;
    const pair: Pair = .{ .funding = f, .swap = s, .pool = Outpoint.parse(rec.pool) orelse return error.BadRecord, .call = undefined, .continuation = undefined };
    const body = try requestBody(a, try requestBeef(a, pair), rec.pool);
    return package(a, signer, &rec.validator, rec.kind.box(), body, nonceFor(rec.kind, rec.id), topic);
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

// ---------------------------------------------------------------- the record

pub const Status = enum {
    pending,
    accepted,
    refused,
    timeout,
    failed,

    pub fn parse(s: []const u8) ?Status {
        inline for (.{ Status.pending, Status.accepted, Status.refused, Status.timeout, Status.failed }) |x| if (eql(u8, s, @tagName(x))) return x;
        return null;
    }
    /// A record in this state may be submitted again (the relay never reached the validator's answer).
    pub fn retryable(s: Status) bool {
        return s == .timeout or s == .failed;
    }
};

pub const Request = struct { message: []const u8, sender: []const u8 };

pub const Record = struct {
    kind: Kind = .swap,
    id: [32]u8,
    status: Status = .pending,
    funding: []const u8,
    /// What is relayed: the raw swap.
    swap: []const u8,
    /// The pool: the outpoint spent.
    pool: []const u8,
    validator: [33]u8,
    expires: u64,
    created: u64,
    updated: u64,
    /// The validator's peer ID (base58), as the caller named it (`peerId`).
    peer: ?[]const u8 = null,
    /// The peer is this node: the validator is this instance's own program, called in-VM.
    local: bool = false,
    /// The dial message whose answers the relay thread awaits, and the stream once open.
    dial: ?[]const u8 = null,
    stream: ?u64 = null,
    /// The relay thread (its origin), what a waiting `/call` request awaits.
    thread: ?[]const u8 = null,
    /// A message caller: answered by the relay thread when the record settles.
    request: ?Request = null,
    tx: ?[]const u8 = null,
    txid: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    detail: ?[]const u8 = null,
    pool_state: ?Value = null,
    /// The validator's answer frame (0.41.0), kept while this instance's overlay takes its `beef`;
    /// applied when that submission answers (`caughtUp`).
    reply: ?[]const u8 = null,
    /// The submission of that `beef` to this instance's overlay (0.41.0): the message the relay
    /// thread awaits.
    submission: ?[]const u8 = null,

    fn put(es: *std.ArrayList(cbor.Entry), a: Allocator, k: []const u8, v: Value) !void {
        try es.append(a, .{ .key = k, .value = v });
    }

    /// What the caller is answered: the record without the relay's own fields.
    pub fn answer(r: Record, a: Allocator) !Value {
        var es: std.ArrayList(cbor.Entry) = .empty;
        try put(&es, a, "id", .{ .text = try a.dupe(u8, &idText(r.id)) });
        try put(&es, a, "status", .{ .text = @tagName(r.status) });
        try put(&es, a, "funding", .{ .bytes = r.funding });
        try put(&es, a, r.kind.subjectKey(), .{ .bytes = r.swap });
        try put(&es, a, "pool", .{ .text = r.pool });
        try put(&es, a, "validator", .{ .bytes = try a.dupe(u8, &r.validator) });
        try put(&es, a, "expires", .{ .uint = r.expires });
        try put(&es, a, "created", .{ .uint = r.created });
        try put(&es, a, "updated", .{ .uint = r.updated });
        if (r.tx) |x| try put(&es, a, "tx", .{ .bytes = x });
        if (r.txid) |x| try put(&es, a, "txid", .{ .text = x });
        if (r.reason) |x| try put(&es, a, "reason", .{ .text = x });
        if (r.detail) |x| try put(&es, a, "detail", .{ .text = x });
        if (r.pool_state) |x| try put(&es, a, "poolState", x);
        return .{ .map = es.items };
    }

    /// The stored record: the answer plus the relay's own fields.
    pub fn value(r: Record, a: Allocator) !Value {
        const ans = try r.answer(a);
        var es: std.ArrayList(cbor.Entry) = .empty;
        try put(&es, a, "kind", .{ .text = r.kind.recordKind() });
        try es.appendSlice(a, ans.map);
        if (r.peer) |x| try put(&es, a, "peer", .{ .text = x });
        if (r.local) try put(&es, a, "local", .{ .boolean = true });
        if (r.dial) |x| try put(&es, a, "dial", .{ .cid = x });
        if (r.stream) |x| try put(&es, a, "stream", .{ .uint = x });
        if (r.thread) |x| try put(&es, a, "thread", .{ .cid = x });
        if (r.reply) |x| try put(&es, a, "reply", .{ .bytes = x });
        if (r.submission) |x| try put(&es, a, "submission", .{ .cid = x });
        if (r.request) |q| try put(&es, a, "request", .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "message", .value = .{ .cid = q.message } },
            .{ .key = "sender", .value = .{ .bytes = q.sender } },
        }) });
        return .{ .map = es.items };
    }

    pub fn of(v: Value) !Record {
        const kind = Kind.ofRecord(v.getText("kind") orelse "") orelse return error.BadRecord;
        const val = v.getBytes("validator") orelse return error.BadRecord;
        if (val.len != 33) return error.BadRecord;
        var r: Record = .{
            .kind = kind,
            .id = idParse(v.getText("id") orelse return error.BadRecord) orelse return error.BadRecord,
            .status = Status.parse(v.getText("status") orelse "") orelse return error.BadRecord,
            .funding = v.getBytes("funding") orelse return error.BadRecord,
            .swap = v.getBytes(kind.subjectKey()) orelse return error.BadRecord,
            .pool = v.getText("pool") orelse return error.BadRecord,
            .validator = val[0..33].*,
            .expires = v.getUint("expires") orelse return error.BadRecord,
            .created = v.getUint("created") orelse return error.BadRecord,
            .updated = v.getUint("updated") orelse return error.BadRecord,
            .peer = v.getText("peer"),
            .local = v.getBool("local") orelse false,
            .dial = v.getCid("dial"),
            .stream = v.getUint("stream"),
            .thread = v.getCid("thread"),
            .tx = v.getBytes("tx"),
            .txid = v.getText("txid"),
            .reason = v.getText("reason"),
            .detail = v.getText("detail"),
            .pool_state = v.get("poolState"),
            .reply = v.getBytes("reply"),
            .submission = v.getCid("submission"),
        };
        if (v.get("request")) |q| r.request = .{
            .message = q.getCid("message") orelse return error.BadRecord,
            .sender = q.getBytes("sender") orelse return error.BadRecord,
        };
        return r;
    }
};

/// The app's state: `{kind: "amm-app-state", swaps: <the MST of swap records
/// by id>}` (0.9.0: the AddLiquidity records' `liquidity` is no longer kept; 0.11.0: nor the
/// deploy records' `pools`, dropped at the next write).
pub const Book = struct {
    s: w.store.Store,
    swaps: w.store.Map,

    pub fn load(a: Allocator, s: w.store.Store, saved: ?Value) !Book {
        const maps = try w.store.Maps.create(a, s);
        var swaps: ?[]const u8 = null;
        if (saved) |st| {
            if (!eql(u8, st.getText("kind") orelse "", state_kind)) return error.BadState;
            swaps = st.getCid("swaps");
        }
        return .{ .s = s, .swaps = maps.map(swaps) };
    }

    fn mapOf(b: *Book, _: Kind) *w.store.Map {
        return &b.swaps;
    }

    /// A swap's record.
    pub fn get(b: *Book, a: Allocator, id: [32]u8) !?Record {
        return b.getKind(a, .swap, id);
    }

    pub fn getKind(b: *Book, a: Allocator, kind: Kind, id: [32]u8) !?Record {
        const c = (try b.mapOf(kind).link(&id)) orelse return null;
        const r = try Record.of(try b.s.getValue(a, c));
        if (r.kind != kind) return error.BadRecord;
        return r;
    }

    pub fn put(b: *Book, a: Allocator, r: Record) !void {
        try b.mapOf(r.kind).putLink(&r.id, try b.s.putValue(a, try r.value(a)));
    }

    /// The state record to keep under the app's head (flushes the maps).
    pub fn state(b: *Book, a: Allocator) !Value {
        try b.swaps.flush();
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = state_kind } },
            .{ .key = "swaps", .value = if (b.swaps.root) |r| .{ .cid = r } else .null },
        }) };
    }
};

// ---------------------------------------------------------------- the relay thread

/// What stepped the relay thread: its launch, an answer to its dial (the
/// libp2p provider's, libp2p.zig `dialAnswer`), or the deadline.
pub const Input = union(enum) {
    start,
    answer: libp2p.DialAnswer,
    /// The engine's answer to the submission of the validator's `beef` (0.41.0): `{fn: "submit",
    /// request, replyTo, result | error}`.
    overlay: Value,
    woke,
};

pub const Effect = struct {
    /// Requests for the libp2p provider, in order.
    emits: []const libp2p.Request = &.{},
    /// The index in `emits` of a new dial (its message CID becomes `dial`).
    dial: ?usize = null,
    /// Rest again on the dial's answers until `expires` (local: on what the validator awaited).
    rest: bool = false,
    /// Local: call this instance's validator program in-VM now (main.zig `callValidator`).
    call: bool = false,
    /// The record settled: answer the caller.
    done: bool = false,
    /// (0.41.0) Submit this BEEF (the validator's answer's) to this instance's own overlay and rest on
    /// that submission (main.zig: its message becomes `submission`).
    catchup: ?[]const u8 = null,
};

/// The `beef` a validator's answer frame carries (0.41.0: an accepted spend's, a `pool_spent`
/// refusal's), or null.
pub fn replyBeef(a: Allocator, frame: []const u8) ?[]const u8 {
    const v = cbor.decode(a, frame) catch return null;
    return v.getBytes("beef");
}

/// This instance's overlay answered the submission of the validator's `beef` (0.41.0): the
/// validator's answer (`reply`) applied; a refusal by this overlay (`rejected`, or an error) said in
/// `detail`, the validator's verdict standing.
pub fn caughtUp(a: Allocator, r: *Record, ans: Value) void {
    applyReply(a, r, r.reply orelse return settle(r, .failed, "bad_record", "no validator answer kept"));
    if (r.status == .failed) return;
    const why: ?[]const u8 = if (ans.get("error")) |e|
        e.getText("message") orelse e.getText("code") orelse "error"
    else if (ans.get("result")) |res|
        (if (eql(u8, res.getText("state") orelse "", "rejected")) res.getText("reason") orelse "rejected" else null)
    else
        "no result";
    if (why) |y| r.detail = std.fmt.allocPrint(a, "this host's overlay refused the validator's transaction: {s}", .{y}) catch "this host's overlay refused the validator's transaction";
}

/// The validator's answer frame (amm-validator README, "Protocol"):
/// `{ok: true, tx, txid}` → accepted; `{ok: false, reason, detail?, txid?, pool?}` → refused.
pub fn applyReply(a: Allocator, r: *Record, frame: []const u8) void {
    const v = cbor.decode(a, frame) catch return settle(r, .failed, "bad_reply", "the validator's answer is not dag-cbor");
    const ok = v.getBool("ok") orelse return settle(r, .failed, "bad_reply", "the validator's answer has no ok");
    if (ok) {
        r.status = .accepted;
        r.tx = v.getBytes("tx");
        r.txid = v.getText("txid");
        if (r.tx == null) return settle(r, .failed, "bad_reply", "accepted without the transaction");
        return;
    }
    r.status = .refused;
    r.reason = v.getText("reason") orelse "refused";
    r.detail = v.getText("detail");
    r.txid = v.getText("txid");
    r.pool_state = v.get("pool");
}

fn settle(r: *Record, s: Status, reason: []const u8, detail: ?[]const u8) void {
    r.status = s;
    r.reason = reason;
    r.detail = detail;
}

/// One step of the relay thread over the record (the caller saves it, emits
/// `emits` to the libp2p provider, sets `dial` from the dial's message, and
/// rests or answers). `package` is the frame to send once the stream is open.
pub fn advance(a: Allocator, r: *Record, in: Input, now: u64, pkg: ?[]const u8) !Effect {
    if (r.status != .pending) return .{ .done = true };
    r.updated = now;
    var emits: std.ArrayList(libp2p.Request) = .empty;
    switch (in) {
        .start => {
            if (now >= r.expires) {
                settle(r, .timeout, "expired", "before the validator was dialled");
                return .{ .done = true };
            }
            try emits.append(a, try libp2p.dial(a, r.peer orelse return error.NoPeer, r.kind.protocol()));
            r.stream = null;
            return .{ .emits = emits.items, .dial = 0, .rest = true };
        },
        .answer => |ans| switch (ans) {
            .opened => |sid| {
                r.stream = sid;
                if (now >= r.expires) {
                    settle(r, .timeout, "expired", "before the request was sent");
                    try emits.append(a, try libp2p.close(a, sid));
                    return .{ .emits = emits.items, .done = true };
                }
                try emits.append(a, try libp2p.send(a, sid, pkg orelse return error.NoPackage));
                return .{ .emits = emits.items, .rest = true };
            },
            .frame => |body| {
                if (r.stream) |sid| try emits.append(a, try libp2p.close(a, sid));
                // 0.41.0: the BEEF it carries goes into this instance's overlay first.
                if (replyBeef(a, body)) |b| {
                    r.reply = body;
                    return .{ .emits = emits.items, .catchup = b, .rest = true };
                }
                applyReply(a, r, body);
                return .{ .emits = emits.items, .done = true };
            },
            .closed => |why| {
                settle(r, .failed, "unreachable", why);
                return .{ .done = true };
            },
        },
        .overlay => |ans| {
            caughtUp(a, r, ans);
            return .{ .done = true };
        },
        .woke => {
            if (now < r.expires) return .{ .rest = true };
            if (r.reply) |body| {
                // 0.41.0: the validator answered; this overlay did not take its BEEF in time.
                applyReply(a, r, body);
                if (r.status != .failed) r.detail = "this host's overlay did not answer before expires";
                return .{ .done = true };
            }
            settle(r, .timeout, "no_answer", "the validator did not answer before expires");
            if (r.stream) |sid| try emits.append(a, try libp2p.close(a, sid));
            return .{ .emits = emits.items, .done = true };
        },
    }
}

/// What stepped a local relay's thread: its launch, the engine's answer or the awaited thread at
/// rest (`again`: the validator called again with it), or the deadline.
pub const LocalInput = enum { start, again, woke };

/// One step of a relay to this instance's own validator (`local`): call it, rest, or time out.
pub fn advanceLocal(r: *Record, in: LocalInput, now: u64) Effect {
    if (r.status != .pending) return .{ .done = true };
    r.updated = now;
    switch (in) {
        .start => if (now >= r.expires) {
            settle(r, .timeout, "expired", "before the validator was called");
            return .{ .done = true };
        },
        .again => {},
        .woke => {
            if (now < r.expires) return .{ .rest = true };
            settle(r, .timeout, "no_answer", "the validator did not answer before expires");
            return .{ .done = true };
        },
    }
    return .{ .call = true };
}

/// The validator handler's answer to the relay's in-VM call (as the front door reads a frame's:
/// `{wait: true}`, or `{verdict, body}` whose `body` is the reply frame), or null when the call
/// failed (`why`).
pub fn localAnswer(a: Allocator, r: *Record, ans: ?Value, why: []const u8) Effect {
    const v = ans orelse {
        settle(r, .failed, "validator_failed", why);
        return .{ .done = true };
    };
    if (v.getBool("wait") orelse false) return .{ .rest = true };
    const body = v.getBytes("body") orelse {
        settle(r, .failed, "bad_reply", "the validator answered no body");
        return .{ .done = true };
    };
    applyReply(a, r, body);
    return .{ .done = true };
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

// ---------------------------------------------------------------- the functions

/// What `submit` needs of the instance (main.zig: the VM; the tests: memory).
pub const Env = struct {
    book: *Book,
    now: u64,
    commission: Commission,
    /// A message caller, answered by the relay thread when the record settles.
    request: ?Request = null,
    ctx: *anyopaque,
    /// This node's own peer ID (base58), or null when it is not known: a `peerId` equal to it is
    /// this instance's own validator (`local`).
    self_peer: ?[]const u8 = null,
    /// Launch the relay thread for the record `id` of `kind` → the thread (its origin's CID).
    launchFn: *const fn (ctx: *anyopaque, a: Allocator, kind: Kind, id: [32]u8) anyerror![]const u8,
};

pub const Submitted = union(enum) {
    /// Recorded `pending` and the relay launched (the caller saves the book).
    launched: Record,
    /// Already pending: the relay thread under way (a route waits on it).
    pending: Record,
    /// Already settled: its record, as it stands.
    settled: Record,
    refused: Refusal,
};

/// amm.swap.submit `{funding, swap, pool, validator, peerId, expires}` (the args
/// already checked against the declared shape): the record, or why not.
/// Check first, write last: nothing is written for a refusal.
pub fn submit(a: Allocator, env: Env, args: Value) !Submitted {
    const funding = args.getBytes("funding") orelse return .{ .refused = .{ .reason = "bad_funding" } };
    const swap = args.getBytes("swap") orelse return .{ .refused = .{ .reason = "bad_swap" } };
    const pool_text = args.getText("pool") orelse return .{ .refused = .{ .reason = "bad_pool" } };
    const validator = args.getBytes("validator") orelse return .{ .refused = .{ .reason = "bad_validator" } };
    const expires = args.getUint("expires") orelse return .{ .refused = .{ .reason = "expired" } };
    const id = idOf(swap);
    if (try env.book.get(a, id)) |rec| {
        if (rec.status == .pending) return .{ .pending = rec };
        if (!rec.status.retryable()) return .{ .settled = rec };
    }
    switch (try checkPair(a, funding, swap, pool_text, validator, expires, env.now, env.commission)) {
        .refused => |r| return .{ .refused = r },
        .ok => {},
    }
    const peer = peerArg(args) orelse return .{ .refused = .{ .reason = "bad_peer", .detail = "peerId: the validator's libp2p peer ID, text" } };
    var rec: Record = .{
        .id = id,
        .funding = funding,
        .swap = swap,
        .pool = pool_text,
        .validator = validator[0..33].*,
        .expires = expires,
        .created = env.now,
        .updated = env.now,
        .peer = peer,
        .local = isSelf(env, peer),
        .request = env.request,
    };
    rec.thread = try env.launchFn(env.ctx, a, .swap, id);
    try env.book.put(a, rec);
    return .{ .launched = rec };
}

/// The validator's peer ID as the caller named it (`peerId`, base58 text), or null.
pub fn peerArg(args: Value) ?[]const u8 {
    const p = args.getText("peerId") orelse return null;
    if (p.len == 0 or p.len > 128) return null;
    for (p) |c| if (c <= ' ' or c == '/') return null;
    return p;
}

/// Whether `peer` is this node (the relay hands the request to its own validator program).
pub fn isSelf(env: Env, peer: []const u8) bool {
    const me = env.self_peer orelse return false;
    return eql(u8, me, peer);
}

pub const Found = union(enum) { found: Record, not_found, bad_id };

/// amm.swap.status `{id}`: the record, or null (`not_found`).
pub fn status(a: Allocator, book: *Book, args: Value) !Found {
    return statusOf(a, book, .swap, args);
}

/// amm.swap.status `{id}`: the record of that kind, or null (`not_found`).
pub fn statusOf(a: Allocator, book: *Book, kind: Kind, args: Value) !Found {
    const id = idParse(args.getText("id") orelse "") orelse return .bad_id;
    return if (try book.getKind(a, kind, id)) |r| .{ .found = r } else .not_found;
}

/// A refusal as the function's error message: `<reason>[: <detail>]`.
pub fn refusalText(a: Allocator, r: Refusal) ![]const u8 {
    return if (r.detail) |d| std.fmt.allocPrint(a, "{s}: {s}", .{ r.reason, d }) else r.reason;
}
