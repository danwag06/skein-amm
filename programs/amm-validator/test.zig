//! The validator, natively: the direct call's package, the protocol's
//! bodies, the refusals, the signing path against the Go fixtures, and the
//! submission through the overlay engine's own submit (the route, the
//! submission thread, the chain app's answers) with the answer read from the
//! state after it. The swaps and the deploy are gen/vectors' (src/fixtures);
//! each pool spend was run through the go-sdk interpreter with the validator's
//! signature in place. A request is that transaction with the validator's
//! slot emptied (`OP_0`), as a taker sends it; the validator, signing through a mock oracle
//! holding the fixtures' identity key, must give back the fixture byte for
//! byte (RFC 6979 signatures on both sides). Then the affirmation (0.13.0): the
//! deploy's pool output as proposed, signed with the fixtures' nonce, the fixture's Affirmation
//! byte for byte; and the validator's Rescind (0.13.0), with a mocked wallet, gen/vectors'
//! `rescind` byte for byte.
const std = @import("std");
const w = @import("chain");
const wire = @import("wallet").wire;
const color = @import("1color");
const validator = @import("src/validator.zig");
const messages = @import("src/messages.zig");
const unlock = @import("src/unlock.zig");
const view_mod = @import("src/view.zig");
const submit = @import("src/submit.zig");
const submit_mod = submit;
const scbor = @import("sdk_cbor");
const ov = @import("skein_overlay");
const sktopic = @import("topic");
const Oracle = @import("src/oracle.zig").Oracle;
const rescind = @import("src/rescind.zig");

const bsvz = w.bsvz;
const cbor = w.cbor;
const Value = cbor.Value;
const Transaction = bsvz.transaction.Transaction;
const vec = @import("vectors");
const pool = @import("pool");
const brc162 = color.brc162;
const Outpoint = view_mod.Outpoint;
const testing = std.testing;

fn unhex(a: std.mem.Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

fn key20(h: []const u8) [20]u8 {
    var k: [20]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, h) catch unreachable;
    return k;
}

fn key33(h: []const u8) [33]u8 {
    var k: [33]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, h) catch unreachable;
    return k;
}

const identity_priv: [32]u8 = .{0x7f} ** 32;

// --- a mock overlay: what the topic admitted, and who spent what ---

const MemView = struct {
    a: std.mem.Allocator,
    id: [32]u8,
    txs: std.AutoHashMap([32]u8, []const u8),
    admitted: std.AutoHashMap([36]u8, void),
    spent: std.AutoHashMap([36]u8, [32]u8),

    fn init(a: std.mem.Allocator, id: [32]u8) MemView {
        return .{ .a = a, .id = id, .txs = .init(a), .admitted = .init(a), .spent = .init(a) };
    }

    fn key(op: Outpoint) [36]u8 {
        return w.store.outpointKey(op.txid, op.vout);
    }

    /// Hold a transaction as the overlay does after a submit: what the
    /// topic (amm-topic's judge) admits, and the spends of every input. →
    /// its txid.
    fn hold(self: *MemView, raw: []const u8) ![32]u8 {
        const tx = try Transaction.parse(self.a, raw);
        const txid = w.beef.txidOf(raw);
        const prev = try self.coins(tx, txid);
        const ins = try self.a.alloc(color.bsv21.Input, tx.inputs.len);
        for (tx.inputs, ins) |in, *x| {
            x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
            if (self.txs.get(x.txid)) |src| {
                const s = try Transaction.parse(self.a, src);
                x.source = .{ .script = s.outputs[x.vout].locking_script.bytes, .satoshis = @intCast(s.outputs[x.vout].satoshis) };
            }
        }
        const outs = try self.a.alloc(color.bsv21.Output, tx.outputs.len);
        for (tx.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
        const v = try color.token.judge(self.a, validator.tokenId(self.id), .{ .txid = txid, .inputs = ins, .outputs = outs }, prev);
        try testing.expect(v.rejected == null);
        for (v.outputs_to_admit) |o| try self.admitted.put(key(.{ .txid = txid, .vout = o }), {});
        for (tx.inputs) |in| try self.spent.put(key(.{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index }), txid);
        try self.txs.put(txid, raw);
        return txid;
    }

    fn coins(self: *MemView, tx: Transaction, txid: [32]u8) ![]const u32 {
        var out: std.ArrayList(u32) = .empty;
        for (tx.inputs, 0..) |in, i| {
            const k = key(.{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index });
            if (!self.admitted.contains(k)) continue;
            if (self.spent.get(k)) |sp| if (!std.mem.eql(u8, &sp, &txid)) continue;
            try out.append(self.a, @intCast(i));
        }
        return out.items;
    }

    fn rawTxImpl(ptr: *anyopaque, _: std.mem.Allocator, txid: [32]u8) anyerror!?[]const u8 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        return self.txs.get(txid);
    }
    fn previousCoinsImpl(ptr: *anyopaque, a: std.mem.Allocator, _: []const u8, tx: Transaction) anyerror![]const u32 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        return self.coins(tx, (try tx.txid(a)).bytes);
    }
    fn spenderImpl(ptr: *anyopaque, _: std.mem.Allocator, _: []const u8, op: Outpoint) anyerror!?[32]u8 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        if (!self.admitted.contains(key(op))) return null;
        return self.spent.get(key(op));
    }
    fn spendersImpl(ptr: *anyopaque, a: std.mem.Allocator, op: Outpoint) anyerror![]const [32]u8 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        var out: std.ArrayList([32]u8) = .empty;
        var it = self.txs.iterator();
        while (it.next()) |e| {
            const t = try Transaction.parse(a, e.value_ptr.*);
            for (t.inputs) |in| if (in.previous_outpoint.index == op.vout and std.mem.eql(u8, &in.previous_outpoint.txid.bytes, &op.txid)) try out.append(a, e.key_ptr.*);
        }
        return out.items;
    }
    fn view(self: *MemView) view_mod.View {
        return .{ .ptr = self, .rawTxFn = rawTxImpl, .previousCoinsFn = previousCoinsImpl, .spenderFn = spenderImpl, .spendersFn = spendersImpl };
    }
};

// --- a mock oracle: a root key answering the BRC-100 wire frames ---

const KeyOracle = struct {
    root: [32]u8,
    calls: usize = 0,
    /// A signature recorded from a Go fixture for this digest: answered
    /// instead of signing here, if it verifies under the key the frame names
    /// (so a wrong key ID still fails). bsvz's own signatures are valid but
    /// its nonce is not go-sdk's RFC 6979 one, so only a recorded signature
    /// can reproduce a fixture byte for byte.
    recorded: ?struct { hash: [32]u8, der: []const u8 } = null,

    /// Record the validator's signature in a fixture's pool call.
    fn record(self: *KeyOracle, a: std.mem.Allocator, fixture: []const u8, slot: usize) !void {
        const tx = try Transaction.parse(a, fixture);
        const u = tx.inputs[0].unlocking_script.bytes;
        const c = (try unlock.parseCall(a, u, pool.methodOf(u).?)).?;
        const sig = c.arg(slot).data;
        self.recorded = .{ .hash = unlock.sha256d(c.preimage()), .der = sig[0 .. sig.len - 1] };
    }

    /// Record the validator's affirmation in an affirmed deploy (0.13.0): its pool's state, over
    /// the affirmation digest.
    fn recordAffirmation(self: *KeyOracle, a: std.mem.Allocator, deploy: []const u8) !void {
        const tx = try Transaction.parse(a, deploy);
        const p = pool.poolOfScript(tx.outputs[0].locking_script.bytes).?;
        self.recorded = .{ .hash = pool.affirmDigest(p, @intCast(tx.outputs[0].satoshis)), .der = p.affirmation };
    }

    fn varstr(frame: []const u8, pos: *usize) []const u8 {
        const n = frame[pos.*];
        std.debug.assert(n < 0xfd);
        const s = frame[pos.* + 1 ..][0..n];
        pos.* += 1 + n;
        return s;
    }

    fn call(ptr: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8 {
        const self: *KeyOracle = @ptrCast(@alignCast(ptr));
        self.calls += 1;
        const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(self.root));
        var pos: usize = 2 + frame[1]; // call, originator
        const op = frame[0];
        if (op == wire.call_get_public_key) {
            if (frame[pos] == 1) return std.mem.concat(a, u8, &.{ &.{0}, &(try kd.identityKey()).toCompressedSec1() });
            pos += 1;
        }
        const level = frame[pos];
        pos += 1;
        const proto = varstr(frame, &pos);
        const key_id = varstr(frame, &pos);
        if (frame[pos] != 12) return error.NotAnyone; // the validator's keys are anyone-counterparty
        pos += 1 + 2; // counterparty, privileged, privilegedReason (none)
        const p: bsvz.primitives.key_deriver.Protocol = .{ .security_level = level, .name = proto };
        switch (op) {
            wire.call_get_public_key => {
                const k = try kd.derivePublicKey(a, p, key_id, .{ .type_ = .anyone }, frame[pos] == 1);
                return std.mem.concat(a, u8, &.{ &.{0}, &k.toCompressedSec1() });
            },
            wire.call_create_signature => {
                if (frame[pos] != 2) return error.NotAHash;
                const hash = frame[pos + 1 ..][0..32].*;
                const priv = try kd.derivePrivateKey(a, p, key_id, .{ .type_ = .anyone });
                if (self.recorded) |r| if (std.mem.eql(u8, &r.hash, &hash)) {
                    const der = try bsvz.crypto.DerSignature.fromDer(r.der);
                    if (!try (try priv.publicKey()).verifyDigest(hash, der)) return &.{ 1, 0 }; // a wallet error: not this key's
                    return std.mem.concat(a, u8, &.{ &.{0}, r.der });
                };
                const sig = try priv.signDigest(hash);
                return std.mem.concat(a, u8, &.{ &.{0}, sig.asSlice() });
            },
            else => return error.UnknownCall,
        }
    }
    fn oracle(self: *KeyOracle) Oracle {
        return .{ .ptr = self, .callFn = call };
    }
};

// --- the fixture chain ---

const Fx = struct {
    a: std.mem.Allocator,
    id: [32]u8,
    mem: MemView,
    oracle: KeyOracle = .{ .root = identity_priv },
    cfg: validator.Config,

    fn raw(self: *Fx, name: []const u8) []const u8 {
        inline for (.{ "fund", "token_deploy", "pool_deploy", "pool_deploy_unaffirmed", "pool_deploy_forged", "pool_deploy_own_key", "swap_bsv_in", "swap_bad_next", "swap_tokens_in", "swap_token_change", "close", "rescind", "close_rescinded" }) |n| {
            if (std.mem.eql(u8, n, name)) return unhex(self.a, @field(vec, n));
        }
        @panic("no fixture");
    }

    /// The overlay after holding `names`, in order.
    fn init(a: std.mem.Allocator, names: []const []const u8) !*Fx {
        const f = try a.create(Fx);
        const id = w.beef.txidOf(unhex(a, vec.token_deploy));
        // Validating the fixture token's topic (registered: 0.8.1, every skein validates every registered token).
        const validated = try a.dupe([]const u8, &.{try validator.topicOf(a, id)});
        f.* = .{ .a = a, .id = id, .mem = MemView.init(a, id), .cfg = .{
            .identity = key33(vec.identity),
            .terms = .{ .lp_fee_bps = vec.lp_fee_bps, .validator_fee_bps = vec.validator_fee_bps, .commission_bps = vec.commission_bps },
            .validated = validated,
        } };
        for (names) |n| _ = try f.mem.hold(f.raw(n));
        return f;
    }

    fn spend(self: *Fx, which: validator.Op, tx: []const u8, op: Outpoint) !validator.Reply {
        return validator.spend(self.a, which, .{ .tx = tx, .pool = op }, self.cfg, self.mem.view(), self.oracle.oracle());
    }

    /// An affirm with the fixtures' nonce (a request never names one: the validator picks it).
    fn affirm(self: *Fx, script: []const u8, satoshis: u64) !validator.Reply {
        return validator.affirm(self.a, .{ .pool = script, .satoshis = satoshis, .nonce = nonce() }, self.cfg, self.oracle.oracle());
    }

    /// The pool as the LP proposes it (0.13.0): pool_deploy's pool output with its
    /// ValidatorPubKey (33 zero bytes), Nonce (32 zero bytes) and Affirmation (empty) still to
    /// come, and its sats.
    fn proposed(self: *Fx) !struct { script: []const u8, satoshis: u64 } {
        const t = try Transaction.parse(self.a, self.raw("pool_deploy_unaffirmed"));
        const s = try self.a.dupe(u8, t.outputs[0].locking_script.bytes);
        const lock = brc162.decode(s).?.lock;
        const p = (try pool.parse(lock)).?;
        const at = s.len - lock.len + p.code_len + 1 + 8 + 33;
        @memset(s[at..][0..33], 0);
        @memset(s[at + 66 ..][0..32], 0);
        return .{ .script = s, .satoshis = @intCast(t.outputs[0].satoshis) };
    }
};

fn txidOf(raw: []const u8) [32]u8 {
    return w.beef.txidOf(raw);
}

fn nonce() [32]u8 {
    var n: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&n, vec.nonce) catch unreachable;
    return n;
}

/// A transaction with input 0's pool call rewritten: argument `arg` replaced by `data`.
fn withPoolArg(a: std.mem.Allocator, raw: []const u8, arg: usize, data: []const u8) ![]const u8 {
    const tx = try Transaction.parse(a, raw);
    const u = tx.inputs[0].unlocking_script.bytes;
    const call = (try unlock.parseCall(a, u, pool.methodOf(u).?)).?;
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[0].unlocking_script = bsvz.script.Script.init(try unlock.withArg(a, call, arg, data));
    var t = tx;
    t.inputs = ins;
    return t.serialize(a);
}

/// A request: the fixture with the validator's slot emptied.
fn request(a: std.mem.Allocator, raw: []const u8, slot: usize) ![]const u8 {
    return withPoolArg(a, raw, slot, &.{});
}

fn withOutput(a: std.mem.Allocator, raw: []const u8, i: usize, script: []const u8) ![]const u8 {
    const tx = try Transaction.parse(a, raw);
    const outs = try a.dupe(bsvz.transaction.Output, tx.outputs);
    outs[i].locking_script = bsvz.script.Script.init(script);
    var t = tx;
    t.outputs = outs;
    return t.serialize(a);
}

fn withUnlocking(a: std.mem.Allocator, raw: []const u8, i: usize, script: []const u8) ![]const u8 {
    const tx = try Transaction.parse(a, raw);
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = bsvz.script.Script.init(script);
    var t = tx;
    t.inputs = ins;
    return t.serialize(a);
}

/// An affirm request body (0.13.0): `{pool, satoshis}`.
fn affirmBody(a: std.mem.Allocator, script: []const u8, satoshis: u64) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "pool", .value = .{ .bytes = script } },
        .{ .key = "satoshis", .value = .{ .uint = satoshis } },
    }) };
}

/// A swap request body: `{tx, pool}`.
fn spendBody(a: std.mem.Allocator, tx: []const u8, op: Outpoint) !Value {
    const op_text = try op.format(a);
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tx", .value = .{ .bytes = tx } },
        .{ .key = "pool", .value = .{ .text = op_text } },
    }) };
}

fn expectRefused(r: validator.Reply, reason: validator.Reason) !void {
    switch (r) {
        .ok => {
            std.debug.print("expected refusal {s}, got ok\n", .{@tagName(reason)});
            return error.TestExpectedRefusal;
        },
        .refused => |f| {
            if (f.reason != reason) std.debug.print("expected {s}, got {s} ({s})\n", .{ @tagName(reason), @tagName(f.reason), f.detail orelse "" });
            try testing.expectEqual(reason, f.reason);
        },
    }
}

// --- the overlay engine's own submit, for real: a mined chain, the route, the thread ---

fn readBack(a: std.mem.Allocator, v: Value) Value {
    return cbor.decode(a, cbor.encode(a, v) catch @panic("OOM")) catch @panic("bad cbor");
}

/// The transactions a submit event's BEEF carries (its `beef`: the bytes the route was handed), in order.
fn txsOf(a: std.mem.Allocator, ev: Value) ![]const []const u8 {
    const b = try w.beef.parse(a, ev.getBytes("beef").?);
    const out = try a.alloc([]const u8, b.entries.len);
    for (b.entries, out) |e, *o| o.* = e.raw.?;
    return out;
}

/// 1Color's own `identify` (skein-1color src/color_topic.zig), over the
/// topic contract: the judgement `submit.route` asks the topic's program for
/// (the BSV-21 rules alone, `token.judge`).
fn tokenIdentify(a: std.mem.Allocator, call: sktopic.Call) anyerror!sktopic.Instructions {
    const id = color.token.tokenIdOf(call.topic) orelse return error.UnknownTopic;
    const ins = try a.alloc(color.bsv21.Input, call.tx.inputs.len);
    for (call.tx.inputs, ins, 0..) |in, *x, i| {
        x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
        if (call.sourceOutput(i)) |o| x.source = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    }
    const outs = try a.alloc(color.bsv21.Output, call.tx.outputs.len);
    for (call.tx.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    const v = try color.token.judge(a, id, .{ .txid = call.txid, .inputs = ins, .outputs = outs }, call.previous_coins);
    return .{ .outputs_to_admit = v.outputs_to_admit, .coins_to_retain = v.coins_to_retain };
}

const topic_program = "cid:color-topic";
/// The submission thread's origin, as the engine's step names it (`Ctx.thread`).
const submission_thread = "cid:submission-thread";

/// Messages to the instance itself (the engine's ingest to the chain app):
/// recorded, each a fresh CID.
const Sent = struct {
    n: usize = 0,
    /// The engine's answers to submitters (shruggr/skein#112), in order: `{to, box, body}`.
    answers: std.ArrayListUnmanaged(struct { to: []const u8, box: []const u8, body: Value }) = .empty,
    fn send(ctx: *anyopaque, a: std.mem.Allocator, _: []const u8, _: Value) anyerror![]const u8 {
        const self: *Sent = @ptrCast(@alignCast(ctx));
        self.n += 1;
        return a.dupe(u8, &cbor.cidOf(try std.fmt.allocPrint(a, "message {d}", .{self.n})));
    }
    fn answer(ctx: *anyopaque, a: std.mem.Allocator, to: []const u8, box: []const u8, body: Value) anyerror!void {
        const self: *Sent = @ptrCast(@alignCast(ctx));
        try self.answers.append(a, .{ .to = to, .box = box, .body = readBack(a, body) });
    }
    /// The last answer's body.
    fn last(self: *Sent) Value {
        return self.answers.items[self.answers.items.len - 1].body;
    }
};

/// This instance's identity, the validator's submission's sender (the fixtures' validator identity is not needed: any key).
const self_key: [33]u8 = .{0x02} ++ .{0x5a} ** 32;

/// Where a submission's thread came to (the chain app's answers to its ingest, as the engine acted on them).
const Gated = enum { pending, mined, accepted, rejected };
const Stepped = struct { gate: Gated, admitted: bool, applied: []const ov.state.Applied };

/// One instance's overlay state (`<app>/state`) over its chain state
/// (`chain/state`), in an in-memory store, with the overlay engine's own
/// submit (skein-overlay 0.6.0 src/submit.zig): the route's half (decode,
/// verify, judge through the topic's program) and the submission thread's
/// steps (`begin`: the BEEF to the chain app; `answered`: admitted on the
/// chain app's first `accepted` or `proven`). The chain app is stood in for
/// by the chain state itself (`ingest`, `applyStatus`): what it records,
/// registers and broadcasts. The validator's view of it is
/// `view.OverlayView`, as in main.zig.
const Node = struct {
    a: std.mem.Allocator,
    ms: *w.store.MemStore,
    chain_root: ?[]const u8 = null,
    ov_root: ?[]const u8 = null,
    in: Value,
    sent: Sent = .{},
    /// Transactions the chain app registered and broadcast (`Ingested.registered`).
    posts: usize = 0,
    threads: std.AutoHashMapUnmanaged([32]u8, struct { ev: Value, ingest: []const u8 }) = .empty,

    fn init(a: std.mem.Allocator, ms: *w.store.MemStore, topic: []const u8) !Node {
        const in: Value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "defaults", .value = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "walletNetwork", .value = .{ .text = "regtest" } },
                .{ .key = "overlayTopics", .value = .{ .text = try std.fmt.allocPrint(a, "{{\"{s}\":\"color-topic\"}}", .{topic}) } },
            }) } },
            .{ .key = "programs", .value = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "color-topic", .value = .{ .cid = topic_program } },
            }) } },
            .{ .key = "app", .value = .{ .text = "amm" } },
        }) };
        return .{ .a = a, .ms = ms, .in = in };
    }
    fn chain(n: *Node) !*w.state.State {
        const ch = try n.a.create(w.state.State);
        ch.* = try w.state.State.load(n.a, n.ms.store(), n.chain_root, .regtest);
        ch.now = 1000;
        return ch;
    }
    /// The overlay's state over the chain state, as a step or a call loads them.
    fn state(n: *Node) !*ov.state.State {
        const st = try n.a.create(ov.state.State);
        st.* = try ov.state.State.load(n.a, n.ms.store(), n.ov_root, try n.chain());
        st.now = 1000;
        return st;
    }
    fn caller(n: *Node) ov.calls.Caller {
        return .{ .ctx = n, .callFn = callFn };
    }
    fn callFn(ctx: *anyopaque, a: std.mem.Allocator, program: []const u8, func: []const u8, arg: Value) anyerror!Value {
        const n: *Node = @ptrCast(@alignCast(ctx));
        if (std.mem.eql(u8, program, topic_program) and std.mem.eql(u8, func, "identify")) return sktopic.judge(a, n.ms.store(), tokenIdentify, arg);
        return error.UnexpectedCall;
    }
    fn cx(n: *Node, st: *ov.state.State) ov.submit.Ctx {
        return .{ .a = n.a, .caller = n.caller(), .wire = .{ .ctx = &n.sent, .sendFn = Sent.send, .answerFn = Sent.answer }, .st = st, .in = n.in, .thread = submission_thread };
    }
    fn headers(n: *Node, raws: []const []const u8) !void {
        const ch = try n.chain();
        _ = try ch.addHeaders(raws);
        n.chain_root = try ch.save();
    }
    /// The submission thread's first step on the submit event (the thread main.zig launches): the
    /// BEEF to the chain app, which ingests it (registering and broadcasting what is unproven); a
    /// subject that arrives proven is answered `proven` at once and admitted.
    fn step(n: *Node, event: Value) !Stepped {
        const ev = readBack(n.a, event);
        const txid = try ov.submit.txidOf(ev);
        const st = try n.state();
        const m = try ov.submit.begin(n.cx(st), ev);
        n.ov_root = try st.save();
        try n.threads.put(n.a, txid, .{ .ev = ev, .ingest = m.ingests[m.ingests.len - 1] });
        const ch = try n.chain();
        const got = try ch.ingest(ev.getBytes("beef").?);
        n.posts += got.registered.len;
        n.chain_root = try ch.save();
        if (got.status == .proven) return n.answer(txid, .{ .proven = .{} }, .mined);
        return .{ .gate = .pending, .admitted = false, .applied = &.{} };
    }
    fn answer(n: *Node, txid: [32]u8, ans: ov.submit.Answer, gate: Gated) !Stepped {
        const t = n.threads.get(txid).?;
        const st = try n.state();
        const done = try ov.submit.answered(n.cx(st), t.ev, t.ingest, ans);
        n.ov_root = try st.save();
        return .{ .gate = gate, .admitted = done.admitted, .applied = done.applied };
    }
    /// A status provider's message about the transaction reaching the chain app, and the chain
    /// app's answer to the submission's thread.
    fn status(n: *Node, event: Value, tx_status: []const u8) !Stepped {
        const txid = try ov.submit.txidOf(readBack(n.a, event));
        const ch = try n.chain();
        const o = try ch.applyStatus(txid, tx_status, null);
        n.chain_root = try ch.save();
        return switch (o) {
            .accepted => n.answer(txid, .accepted, .accepted),
            .proven => n.answer(txid, .{ .proven = .{} }, .mined),
            .rejected => n.answer(txid, .{ .rejected = tx_status }, .rejected),
            .pending => .{ .gate = .pending, .admitted = false, .applied = &.{} },
        };
    }
    /// The validator's submission message (messages.zig `Next.submit`), as the engine's step on it
    /// takes it (skein-overlay `submit.received`): from this instance, in box `amm`.
    fn received(n: *Node, sub: anytype) !ov.submit.Resumed {
        const msg = try submit_mod.body(n.a, sub.beef, sub.topic);
        const source: Value = .{ .map = try n.a.dupe(cbor.Entry, &.{
            .{ .key = "transport", .value = .{ .text = "mailbox" } },
            .{ .key = "box", .value = .{ .text = "amm" } },
            .{ .key = "sender", .value = .{ .bytes = &self_key } },
            .{ .key = "request", .value = .{ .cid = try n.a.dupe(u8, &cbor.cidOf(try std.fmt.allocPrint(n.a, "submission {d}", .{n.sent.answers.items.len + n.sent.n}))) } },
        }) };
        const st = try n.state();
        const r = try ov.submit.received(n.cx(st), msg.get("args").?, source);
        n.ov_root = try st.save();
        return r;
    }
    /// The submission message routed whole: the submit event the engine launches its thread on.
    fn launched(n: *Node, served: messages.Served) !Value {
        return switch (try n.received(served.next.submit)) {
            .launch => |ev| ev,
            else => error.NotLaunched,
        };
    }
    /// A BEEF through the overlay's submit: the route, then the thread's first step on its event.
    fn submit(n: *Node, topic: []const u8, b: []const u8) !Stepped {
        const routed = try ov.submit.route(n.a, n.caller(), try n.state(), n.in, .{ .bytes = b }, &.{topic}, null, null);
        return n.step(routed.admit.event);
    }
};

fn merkleParent(l: [32]u8, r: [32]u8) [32]u8 {
    return w.store.dblSha256(&(l ++ r));
}

fn mine(prev: [32]u8, root: [32]u8, time: u32) [80]u8 {
    var h = w.header.Header{ .version = 1, .prev_hash = prev, .merkle_root = root, .time = time, .bits = 0x207fffff, .nonce = 0 };
    while (true) : (h.nonce += 1) {
        const raw = h.serialize();
        if (w.header.powOk(&raw)) return raw;
    }
}

const PE = std.meta.Elem(std.meta.Elem(@FieldType(w.merkle.MerklePath, "path")));

/// The BUMP of a four-transaction block (t0..t3) for the leaves `which` (amm-p2p's test).
fn bump4(a: std.mem.Allocator, height: u32, t: [4][32]u8, which: []const usize) ![]const u8 {
    var merged: ?w.merkle.MerklePath = null;
    for (which) |i| {
        const sib = i ^ 1;
        const l0 = try a.alloc(PE, 2);
        const me: PE = .{ .offset = i, .hash = .{ .bytes = t[i] }, .txid = true };
        const other: PE = .{ .offset = sib, .hash = .{ .bytes = t[sib] } };
        l0[0] = if (i < sib) me else other;
        l0[1] = if (i < sib) other else me;
        const up = if (i < 2) merkleParent(t[2], t[3]) else merkleParent(t[0], t[1]);
        const l1 = try a.dupe(PE, &.{.{ .offset = (i >> 1) ^ 1, .hash = .{ .bytes = up } }});
        const levels = try a.dupe([]PE, &.{ l0, l1 });
        const p: w.merkle.MerklePath = .{ .block_height = height, .path = levels };
        if (merged) |*m| try m.combine(&p, a) else merged = p;
    }
    return merged.?.bytes(a);
}

/// The Go fixtures' chain, mined: block 1 holds fund, token_deploy,
/// pool_deploy (and a filler), so each is proven by a BUMP against a real
/// header, and a BEEF of any of them verifies with no further ancestry (the
/// fixtures' own funding inputs are placeholder txids). A node that has
/// taken token_deploy and pool_deploy through the overlay's submit holds the
/// pool, but never saw fund: the taker's funding is known to it only from
/// the request's BEEF.
const Mined = struct {
    f: *Fx,
    node: Node,
    blk: [80]u8,
    leaves: [4][32]u8,
    topic: []const u8,
    pool_op: Outpoint,

    fn init(a: std.mem.Allocator, ms: *w.store.MemStore) !*Mined {
        const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
        const m = try a.create(Mined);
        const leaves: [4][32]u8 = .{ txidOf(f.raw("fund")), txidOf(f.raw("token_deploy")), txidOf(f.raw("pool_deploy")), .{9} ** 32 };
        const root = merkleParent(merkleParent(leaves[0], leaves[1]), merkleParent(leaves[2], leaves[3]));
        const topic = try validator.topicOf(a, f.id);
        m.* = .{
            .f = f,
            .node = try Node.init(a, ms, topic),
            .blk = mine(w.header.hash(&w.chain.Network.regtest.genesis()), root, 1_700_000_000),
            .leaves = leaves,
            .topic = topic,
            .pool_op = .{ .txid = leaves[2], .vout = 0 },
        };
        try m.node.headers(&.{&m.blk});
        const td = try m.node.submit(topic, try m.beef(a, &.{"token_deploy"}, null));
        try testing.expectEqual(Gated.mined, td.gate);
        try testing.expectEqualSlices(u32, &.{0}, td.applied[0].outputs_to_admit);
        const pd = try m.node.submit(topic, try m.beef(a, &.{"pool_deploy"}, null));
        try testing.expectEqual(Gated.mined, pd.gate);
        try testing.expect(pd.applied[0].outputs_to_admit.len > 0);
        try testing.expectEqual(@as(usize, 0), m.node.posts); // mined: nothing broadcast
        return m;
    }

    /// A V2 BEEF of the mined fixtures `proven` (with their BUMP), then `subject` (unproven), if any.
    fn beef(m: *Mined, a: std.mem.Allocator, proven: []const []const u8, subject: ?[]const u8) ![]const u8 {
        const which = try a.alloc(usize, proven.len);
        const entries = try a.alloc(w.beef.Entry, proven.len + @intFromBool(subject != null));
        for (proven, which, entries[0..proven.len]) |name, *i, *e| {
            const raw = m.f.raw(name);
            i.* = for (m.leaves, 0..) |l, k| {
                if (std.mem.eql(u8, &l, &txidOf(raw))) break k;
            } else unreachable;
            e.* = .{ .txid = txidOf(raw), .format = .raw_with_bump, .bump = 0, .raw = raw };
        }
        if (subject) |s| entries[proven.len] = .{ .txid = txidOf(s), .format = .raw, .raw = s };
        const bumps = try a.alloc(w.merkle.MerklePath, 1);
        bumps[0] = try w.merkle.MerklePath.parse(a, try bump4(a, 1, m.leaves, which));
        return w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = bumps, .entries = entries });
    }

    /// The request the taker sends: the sats-in swap with the validator's
    /// slot empty, as a BEEF carrying its funding (fund, proven), and the
    /// oracle primed to reproduce the fixture's signature.
    fn swapRequest(m: *Mined, a: std.mem.Allocator) ![]const u8 {
        try m.f.oracle.record(a, m.f.raw("swap_bsv_in"), 0);
        return m.beef(a, &.{"fund"}, try request(a, m.f.raw("swap_bsv_in"), 0));
    }

    /// What main.zig gives a direct call: the view over the instance's
    /// state, and the same state (the step's).
    fn deps(m: *Mined) !messages.Deps {
        const st = try m.node.state();
        const ovv = try m.node.a.create(view_mod.OverlayView);
        ovv.* = .{ .st = st };
        return .{
            .config = m.f.cfg,
            .view = ovv.view(),
            .oracle = m.f.oracle.oracle(),
            .st = st,
        };
    }

    /// The answer read from the state once the thread a call waited on has come to rest.
    fn fromState(m: *Mined, a: std.mem.Allocator, op: validator.Op, body: Value) !validator.Reply {
        const st = try m.node.state();
        const ovv = try a.create(view_mod.OverlayView);
        ovv.* = .{ .st = st };
        return messages.answerFromState(a, st, ovv.view(), op, body);
    }

    /// The request through `messages.respond` as the direct call's first step makes it (main.zig `directCall`).
    fn respond(m: *Mined, a: std.mem.Allocator, req: []const u8) !messages.Served {
        return messages.respond(a, .swap, try spendBody(a, req, m.pool_op), try m.deps());
    }

    /// The direct call's answer on the engine's answer to its submission (called again with `reply`).
    fn fromSubmit(m: *Mined, a: std.mem.Allocator, op: validator.Op, body: Value, ans: Value) !validator.Reply {
        const st = try m.node.state();
        const ovv = try a.create(view_mod.OverlayView);
        ovv.* = .{ .st = st };
        return messages.answerFromSubmit(a, st, ovv.view(), op, body, ans);
    }

    /// The direct call's answer once the thread it waited on has come to rest (called again with `resolved`).
    fn answer(m: *Mined, a: std.mem.Allocator, req: []const u8) !validator.Reply {
        return m.fromState(a, .swap, try spendBody(a, req, m.pool_op));
    }
};

// --- signing ---

test "sign: a sats-in swap comes back as the Go fixture, byte for byte; submitted by message to the engine, launched as its submission, admitted on the network's word, and the direct call's answer from the engine's answer is the signed transaction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const want = f.raw("swap_bsv_in");
    const req = try request(a, want, 0);
    try testing.expect(!std.mem.eql(u8, req, want));
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // Signed here by bsvz (valid under the pool's key: spend checks that):
    // the same transaction but for the signature's bytes.
    const local = try f.spend(.swap, req, op);
    try testing.expect(local == .ok);
    try testing.expect(!std.mem.eql(u8, want, local.ok.tx.?));
    try testing.expectEqualSlices(u8, req, try request(a, local.ok.tx.?, 0));
    f.oracle.calls = 0;

    try f.oracle.record(a, want, 0);
    const r = try f.spend(.swap, req, op);
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want, r.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(want), &r.ok.txid.?);
    try testing.expectEqual(@as(usize, 1), f.oracle.calls); // one signature, nothing else
    // Not submitted here (spend never routes): what the submission needs.
    try testing.expectEqualStrings(try validator.topicOf(a, f.id), r.ok.submission.?.topic);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_color_{s}_0", .{&w.header.toHex(f.id)}), r.ok.submission.?.topic);
    try testing.expect(r.ok.submission.?.pool.eql(op));

    // The same request as the direct call's step makes it, on a real node
    // (the mined chain): checked, signed, and the signed BEEF submitted by
    // message ({fn: "submit", args: {beef, topics}} to the instance itself);
    // the engine's step on it asks the topic's judgement and makes the submit
    // record — to launch its submission thread on.
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const sreq = try m.swapRequest(a);
    const served = try m.respond(a, sreq);
    try testing.expect(served.reply == .ok);
    try testing.expectEqualSlices(u8, want, served.reply.ok.tx.?);
    try testing.expectEqualStrings(m.topic, served.next.submit.topic);
    const ev = readBack(a, try m.node.launched(served));
    try testing.expectEqualStrings("submit", ev.getText("kind").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(want)), ev.getText("txid").?);
    // The BEEF the event carries (0.29.5): fund (with its BUMP, the request's), the pool's transaction
    // (pool_deploy, with its BUMP: the chain state's BEEF of it; it spends fund, so after it), then the
    // signed transaction; one BUMP, the block's, both leaves in it.
    const txs = try txsOf(a, ev);
    try testing.expectEqual(@as(usize, 3), txs.len);
    try testing.expectEqualSlices(u8, f.raw("fund"), txs[0]);
    try testing.expectEqualSlices(u8, f.raw("pool_deploy"), txs[1]);
    try testing.expectEqualSlices(u8, want, txs[2]);
    const eb = try w.beef.parse(a, ev.getBytes("beef").?);
    try testing.expectEqual(@as(usize, 1), eb.bumps.len);
    try testing.expectEqual(w.beef.Format.raw_with_bump, eb.entries[0].format);
    try testing.expectEqual(w.beef.Format.raw_with_bump, eb.entries[1].format);
    const j = ev.getArray("topics").?[0];
    try testing.expectEqualStrings(m.topic, j.getText("topic").?);
    try testing.expectEqual(@as(usize, 1), j.getArray("previousCoins").?.len); // the pool
    try testing.expectEqual(@as(u64, 0), j.getArray("previousCoins").?[0].uint);

    // The submission thread: the BEEF to the chain app, which registers and
    // broadcasts the swap (fund arrives proven); pending (nothing admitted),
    // then the status provider's RECEIVED (the chain app's `accepted`) admits
    // it — the continuation (0) and the taker's token payout (1).
    const first = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first.gate);
    try testing.expect(!first.admitted);
    try testing.expectEqual(@as(usize, 1), m.node.posts);
    try expectRefused(try m.answer(a, sreq), .pending); // were the thread to rest now (errored)
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expectEqual(Gated.accepted, done.gate);
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, done.applied[0].outputs_to_admit);
    try testing.expectEqualSlices(u32, &.{0}, done.applied[0].coins_to_retain); // the pool coin, carried on

    // The engine answered the sender (this instance, box amm): admitted, pending, with the STEAK.
    try testing.expectEqual(@as(usize, 1), m.node.sent.answers.items.len);
    try testing.expectEqualSlices(u8, &self_key, m.node.sent.answers.items[0].to);
    try testing.expectEqualStrings("amm", m.node.sent.answers.items[0].box);
    const res = m.node.sent.last().get("result").?;
    try testing.expectEqualStrings("admitted", res.getText("state").?);
    try testing.expectEqualStrings("pending", res.getText("status").?);
    try testing.expect(res.get("steak").?.get(m.topic) != null);
    // The direct call's answer on it.
    const via = try m.fromSubmit(a, .swap, try spendBody(a, sreq, m.pool_op), m.node.sent.last());
    try testing.expectEqualSlices(u8, want, via.ok.tx.?);
    // The same, from the state (a resubmission's wait on the thread).
    const ans = try m.answer(a, sreq);
    try testing.expect(ans == .ok);
    try testing.expectEqualSlices(u8, want, ans.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(want), &ans.ok.txid.?);
    const body = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(true, body.getBool("ok").?);
    try testing.expectEqualSlices(u8, want, body.getBytes("tx").?);
}

test "submission: a request BEEF whose funding the node never held, proven in the BEEF, is accepted; as raw bytes, the engine pauses it on the missing parent (skein-overlay 0.7.2: every missing parent pauses)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const fund = txidOf(m.f.raw("fund"));
    try testing.expect((try (try m.node.chain()).txRaw(fund)) == null); // unknown to the node

    // The raw request: every check passes (the funding input's signature is
    // only "present" without its source), it is signed and submitted, and the
    // engine pauses it: an input neither held nor in the BEEF. Nothing is
    // answered yet (the pause is internal); the call waits.
    const raw_req = try request(a, m.f.raw("swap_bsv_in"), 0);
    try m.f.oracle.record(a, m.f.raw("swap_bsv_in"), 0);
    const r = try m.respond(a, raw_req);
    try testing.expect(r.next == .submit);
    const paused = try m.node.received(r.next.submit);
    try testing.expect(paused == .paused);
    try testing.expectEqual(@as(usize, 0), m.node.sent.answers.items.len);

    // The same request as a BEEF carrying fund with its BUMP (on a node that saw no pause): launched, and admitted.
    var ms2 = w.store.MemStore.init(testing.allocator);
    defer ms2.deinit();
    const m2 = try Mined.init(a, &ms2);
    const ok = try m2.respond(a, try m2.swapRequest(a));
    const okev = try m2.node.launched(ok);
    _ = try m2.node.step(okev);
    const done = try m2.node.status(okev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expect((try (try m2.node.chain()).status(fund)) == .proven); // held now, with its proof
}

test "submission: the gate, answered from the state — a rejection admits nothing (rejected, and the same request again is refused at once); a resubmission while pending waits on the first submission's thread, then the answer is the signed transaction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The network rejects it: nothing admitted; the answer is `rejected`, the pool live again (no `pool`).
    {
        var ms = w.store.MemStore.init(testing.allocator);
        defer ms.deinit();
        const m = try Mined.init(a, &ms);
        const req = try m.swapRequest(a);
        const r = try m.respond(a, req);
        const ev = try m.node.launched(r);
        _ = try m.node.step(ev);
        const done = try m.node.status(ev, "REJECTED");
        try testing.expectEqual(Gated.rejected, done.gate);
        try testing.expect(!done.admitted);
        // The engine's answer: rejected; the direct call's answer on it.
        try testing.expectEqualStrings("rejected", m.node.sent.last().get("result").?.getText("state").?);
        const ans = try m.fromSubmit(a, .swap, try spendBody(a, req, m.pool_op), m.node.sent.last());
        try expectRefused(ans, .rejected);
        try testing.expectEqualStrings("REJECTED", ans.refused.detail.?);
        try testing.expect(ans.refused.newest == null);
        const body = readBack(a, try messages.replyValue(a, ans));
        try testing.expectEqualStrings("rejected", body.getText("reason").?);
        try testing.expectEqualStrings(&w.header.toHex(r.reply.ok.txid.?), body.getText("txid").?);
        // The same request again: rejected before, answered from the state at once (nothing submitted).
        const again = try m.respond(a, req);
        try testing.expect(again.next == .from_state);
        try expectRefused(try m.answer(a, req), .rejected);
    }
    // Pending: the same request again is recognised (not re-signed) and waits on the first thread.
    {
        var ms = w.store.MemStore.init(testing.allocator);
        defer ms.deinit();
        const m = try Mined.init(a, &ms);
        const req = try m.swapRequest(a);
        const r = try m.respond(a, req);
        const ev = try m.node.launched(r);
        const first = try m.node.step(ev);
        try testing.expectEqual(Gated.pending, first.gate);

        m.f.oracle.calls = 0;
        const again = try m.respond(a, req);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls); // not signed again
        try testing.expectEqualSlices(u8, &r.reply.ok.txid.?, &again.next.wait_on);
        // The thread it waits on: the one the broadcast record names (main.zig awaits it).
        const rec = (try (try m.node.state()).pendingRecord(again.next.wait_on)).?;
        try testing.expectEqualSlices(u8, submission_thread, rec.getCid("thread").?);

        // The network's word admits it; the thread rests; both waiting calls answer the same.
        _ = try m.node.status(ev, "SEEN_ON_NETWORK");
        const ans = try m.answer(a, req);
        try testing.expectEqualSlices(u8, r.reply.ok.tx.?, ans.ok.tx.?);
        // Sent once more, after: judged before, answered from the state at once.
        const last = try m.respond(a, req);
        try testing.expect(last.next == .from_state);
    }
}

test "sign: a tokens-in swap (the key rotated once already)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in" });
    const want = f.raw("swap_tokens_in");
    try f.oracle.record(a, want, 0);
    const r = try f.spend(.swap, try request(a, want, 0), .{ .txid = txidOf(f.raw("swap_bsv_in")), .vout = 0 });
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want, r.ok.tx.?);
}

test "sign (0.40.0): a tokens-in swap with token change — the change output after the fees, exactly the call's amount to the call's key, 1 sat; refused bad_outputs when it is not" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in" });
    const want = f.raw("swap_token_change");
    const op: Outpoint = .{ .txid = txidOf(f.raw("swap_bsv_in")), .vout = 0 };
    const req = try request(a, want, 0);
    const tx = try Transaction.parse(a, req);
    // pool, payout, LP fee, validator fee, commission, the token change, the sats change
    try testing.expectEqual(@as(usize, 7), tx.outputs.len);
    const tc = brc162.decode(tx.outputs[5].locking_script.bytes).?;
    try testing.expectEqual(@as(u64, vec.swap_token_change_tokens), tc.amount);
    try testing.expectEqual(@as(i64, 1), tx.outputs[5].satoshis);
    const call = (try unlock.parseCall(a, tx.inputs[0].unlocking_script.bytes, .swap)).?;
    const args = validator.swapArgs(call).?;
    try testing.expectEqual(@as(u64, vec.swap_token_change_tokens), args.token_change);
    try testing.expectEqual(@as(u64, vec.swap_token_change_amount_in), args.amount_in);

    try f.oracle.record(a, want, 0);
    const r = try f.spend(.swap, req, op);
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want, r.ok.tx.?);
    f.oracle.calls = 0;

    const S = struct {
        fn expectBad(fx: *Fx, raw: []const u8, o: Outpoint, detail: []const u8) !void {
            const rr = try fx.spend(.swap, raw, o);
            try expectRefused(rr, .bad_outputs);
            try testing.expect(std.mem.indexOf(u8, rr.refused.detail.?, detail) != null);
        }
    };
    // The call names another amount (9,999) than output 5 holds.
    try S.expectBad(f, try withPoolArg(a, req, 7, &.{ 0x0f, 0x27 }), op, "the token change");
    // The call names another key than output 5 pays.
    try S.expectBad(f, try withPoolArg(a, req, 6, &(.{0xc0} ** 20)), op, "the token change");
    // The token change output with 2 sats.
    var outs = try a.dupe(bsvz.transaction.Output, tx.outputs);
    outs[5].satoshis = 2;
    var t2 = tx;
    t2.outputs = outs;
    try S.expectBad(f, try t2.serialize(a), op, "the token change");
    // The call names no token change (0) while output 5 is there: past the contract's (the sats change is not output 5).
    const r0 = try f.spend(.swap, try withPoolArg(a, req, 7, &.{}), op);
    try expectRefused(r0, .bad_outputs);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "sign: the current key (0.13.0): a deploy's keyed by its nonce (it attests itself), a Swap's continuation's by the pool outpoint the Swap spent; none for a pool that is neither, or rescinded" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in", "rescind" });
    var kb: [64 + 1 + 10]u8 = undefined;
    for ([_]struct { name: []const u8, want: ?[]const u8 }{
        .{ .name = "pool_deploy", .want = vec.nonce },
        .{ .name = "swap_bsv_in", .want = pool.keyId(&kb, txidOf(f.raw("pool_deploy")), 0) },
        .{ .name = "rescind", .want = null },
    }) |c| {
        const op: Outpoint = .{ .txid = txidOf(f.raw(c.name)), .vout = 0 };
        const t = try Transaction.parse(a, f.raw(c.name));
        const p = pool.poolOfScript(t.outputs[0].locking_script.bytes).?;
        const kid = try validator.currentKeyId(a, f.mem.view(), p, @intCast(t.outputs[0].satoshis), op);
        if (c.want) |want| try testing.expectEqualStrings(want, kid.?) else try testing.expect(kid == null);
        // Another key in the pool's state: none.
        var q = p;
        q.validator = key33(vec.pool2.validator);
        if (!p.rescinded()) try testing.expect((try validator.currentKeyId(a, f.mem.view(), q, @intCast(t.outputs[0].satoshis), op)) == null);
    }
    // The own-key and forged deploys: not affirmed, so no key of ours to name.
    const g = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy_own_key" });
    const ot = try Transaction.parse(a, g.raw("pool_deploy_own_key"));
    try testing.expect((try validator.currentKeyId(a, g.mem.view(), pool.poolOfScript(ot.outputs[0].locking_script.bytes).?, @intCast(ot.outputs[0].satoshis), .{ .txid = txidOf(g.raw("pool_deploy_own_key")), .vout = 0 })) == null);
}

test "sign: a request as a BEEF: an unheld parent's source verifies the taker's signature, and the signed BEEF is the request's with its subject signed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // fund not held: the request's own ancestry is the only way to it.
    const want = try Fx.init(a, &.{ "token_deploy", "pool_deploy" });
    const req = try request(a, want.raw("swap_bsv_in"), 0);
    try want.oracle.record(a, want.raw("swap_bsv_in"), 0);
    const parent = want.raw("fund");
    const b = try w.beef.serialize(a, .{ .version = w.beef.V1, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(parent), .format = .raw, .raw = parent },
        .{ .txid = txidOf(req), .format = .raw, .raw = req },
    }) });
    const r = try want.spend(.swap, b, .{ .txid = txidOf(want.raw("pool_deploy")), .vout = 0 });
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want.raw("swap_bsv_in"), r.ok.tx.?);
    const sub = r.ok.submission.?;
    try testing.expect(sub.ancestry != null);
    // What goes to skein's submit.route: the request's BEEF, parents first,
    // its subject now the signed transaction.
    const sb = try w.beef.parse(a, try submit.submissionBeef(a, r.ok.tx.?, sub.ancestry, null));
    try testing.expectEqual(@as(usize, 2), sb.entries.len);
    try testing.expectEqualSlices(u8, parent, sb.entries[0].raw.?);
    try testing.expectEqualSlices(u8, want.raw("swap_bsv_in"), sb.entries[1].raw.?);
    try testing.expectEqualSlices(u8, &txidOf(want.raw("swap_bsv_in")), &sb.subject().?);
    // A raw request: a V1 BEEF of the signed transaction alone.
    const rb = try w.beef.parse(a, try submit.submissionBeef(a, r.ok.tx.?, null, null));
    try testing.expectEqual(@as(usize, 1), rb.entries.len);
    // It goes to the submissions box `<app>/submit` (skein-overlay 0.7.5, shruggr/skein#128).
    try testing.expectEqualStrings("amm/submit", try submit.box(a, "amm"));

    // The taker's funding input's signature is verified in full from the
    // BEEF's parent: a bad one is refused (it is only "present" without it).
    const tx = try Transaction.parse(a, req);
    const u = try a.dupe(u8, tx.inputs[1].unlocking_script.bytes);
    u[u[0] - 1] ^= 0x01;
    const bad = try withUnlocking(a, req, 1, u);
    const bb = try w.beef.serialize(a, .{ .version = w.beef.V1, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(parent), .format = .raw, .raw = parent },
        .{ .txid = txidOf(bad), .format = .raw, .raw = bad },
    }) });
    try expectRefused(try want.spend(.swap, bb, .{ .txid = txidOf(want.raw("pool_deploy")), .vout = 0 }), .bad_signature);
}

// --- refusals ---

test "refused: not our pool, not a pool input, unknown pool, wrong method, slot taken" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // Another validator's instance.
    var other = f.cfg;
    other.identity = key33(vec.pool0.validator);
    try expectRefused(try validator.spend(a, .swap, .{ .tx = req, .pool = op }, other, f.mem.view(), f.oracle.oracle()), .not_our_pool);
    // The named pool is not spent by the transaction.
    try expectRefused(try f.spend(.swap, req, .{ .txid = op.txid, .vout = 1 }), .pool_not_an_input);
    // A pool this overlay does not hold.
    const g = try Fx.init(a, &.{ "fund", "token_deploy" });
    try expectRefused(try g.spend(.swap, req, op), .unknown_pool);
    // A Close or a Rescind in the swap box (the validator rescinds by root's message, not a direct call).
    {
        const h = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in" });
        const r = try h.spend(.swap, h.raw("close"), .{ .txid = txidOf(h.raw("swap_tokens_in")), .vout = 0 });
        try expectRefused(r, .wrong_method);
        try testing.expectEqualStrings("close", r.refused.detail.?);
        const rr = try h.spend(.swap, h.raw("rescind"), .{ .txid = txidOf(h.raw("swap_tokens_in")), .vout = 0 });
        try expectRefused(rr, .wrong_method);
        try testing.expectEqualStrings("rescind", rr.refused.detail.?);
        try expectRefused(try h.spend(.affirm, req, op), .bad_request);
    }
    // Already signed (the slot is not OP_0).
    try expectRefused(try f.spend(.swap, f.raw("swap_bsv_in"), op), .signature_slot_not_empty);
    // Not a transaction.
    try expectRefused(try f.spend(.swap, "nonsense", op), .bad_transaction);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "the validated topics (0.3.2; 0.8.1: the registered set, always): in it, a swap is signed and a pool affirmed; not in it, each is refused not_validating, nothing signed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    const topic = try validator.topicOf(a, f.id);

    // In the set: signed.
    try testing.expect(validator.validating(f.cfg, topic));
    try testing.expect((try f.spend(.swap, req, op)) == .ok);
    const calls = f.oracle.calls;

    // Not in it (nothing validated; another token's topic only): refused, the oracle not asked.
    var none = f.cfg;
    none.validated = &.{};
    var other = f.cfg;
    other.validated = &.{"tm_color_" ++ "00" ** 32 ++ "_0"};
    for ([_]validator.Config{ none, other }) |cfg| {
        const r = try validator.spend(a, .swap, .{ .tx = req, .pool = op }, cfg, f.mem.view(), f.oracle.oracle());
        try expectRefused(r, .not_validating);
        try testing.expect(std.mem.indexOf(u8, r.refused.detail.?, topic) != null);
    }
    try testing.expectEqual(calls, f.oracle.calls);

    // An affirm: signed in the set; refused out of it.
    const g = try Fx.init(a, &.{});
    const pr = try g.proposed();
    for ([_]validator.Config{ none, other }) |cfg| {
        try expectRefused(try validator.affirm(a, .{ .pool = pr.script, .satoshis = pr.satoshis }, cfg, g.oracle.oracle()), .not_validating);
    }
    try testing.expectEqual(@as(usize, 0), g.oracle.calls);
    try testing.expect((try g.affirm(pr.script, pr.satoshis)) == .ok);

    // Through the protocol: the refusal's reply body.
    const body = try messages.replyValue(a, try validator.spend(a, .swap, .{ .tx = req, .pool = op }, none, f.mem.view(), f.oracle.oracle()));
    try testing.expectEqualStrings("not_validating", body.getText("reason").?);
}

test "refused: the topic would not admit it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // The taker's token payout one higher: tokens out exceed tokens in.
    const tx = try Transaction.parse(a, req);
    var buf: [10]u8 = undefined;
    const payout = brc162.decode(tx.outputs[1].locking_script.bytes).?;
    const more = try std.mem.concat(a, u8, &.{ &.{0x20}, &f.id, brc162.pushAmount(&buf, payout.amount + 1), &.{0x6d}, payout.lock });
    const r = try f.spend(.swap, try withOutput(a, req, 1, more), op);
    try expectRefused(r, .topic_refused);
    try testing.expectEqualStrings("inflation", r.refused.detail.?);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: a swap's outputs not the contract's (bad_outputs): the commission elsewhere, missing, short; an LP fee short; an extra output" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    const S = struct {
        fn outs(al: std.mem.Allocator, raw: []const u8, list: []const bsvz.transaction.Output) ![]const u8 {
            var t = try Transaction.parse(al, raw);
            t.outputs = list;
            return t.serialize(al);
        }
        fn expectBad(fx: *Fx, raw: []const u8, o: Outpoint, detail: []const u8) !void {
            const r = try fx.spend(.swap, raw, o);
            try expectRefused(r, .bad_outputs);
            try testing.expect(std.mem.indexOf(u8, r.refused.detail.?, detail) != null);
        }
    };
    const tx = try Transaction.parse(a, req);
    try testing.expectEqual(@as(usize, 6), tx.outputs.len); // pool, payout, LP fee, validator fee, commission, change

    // The call names another commissionPkh than output 4 pays.
    try S.expectBad(f, try withPoolArg(a, req, 5, &(.{0xc0} ** 20)), op, "the commission");
    // Output 4 pays another pkh than the call names.
    try S.expectBad(f, try withOutput(a, req, 4, try p2pkhLock(a, &(.{0xc0} ** 20))), op, "the commission");
    // No commission output (the change moves up to 4).
    try S.expectBad(f, try S.outs(a, req, &.{ tx.outputs[0], tx.outputs[1], tx.outputs[2], tx.outputs[3], tx.outputs[5] }), op, "the commission");
    // The commission one sat short.
    var short = try a.dupe(bsvz.transaction.Output, tx.outputs);
    short[4].satoshis -= 1;
    try S.expectBad(f, try S.outs(a, req, short), op, "the commission");
    // The LP fee one sat short.
    short = try a.dupe(bsvz.transaction.Output, tx.outputs);
    short[2].satoshis -= 1;
    try S.expectBad(f, try S.outs(a, req, short), op, "the LP fee");
    // An output past the change.
    try S.expectBad(f, try S.outs(a, req, try std.mem.concat(a, bsvz.transaction.Output, &.{ tx.outputs, &.{tx.outputs[4]} })), op, "outputs past");
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: the wrong next validator key, in the call or in the continuation" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // The call carries the current key over instead of rotating it.
    try expectRefused(try f.spend(.swap, try withPoolArg(a, req, 1, &key33(vec.pool0.validator)), op), .wrong_next_key);
    // The continuation's state names another key.
    const tx = try Transaction.parse(a, req);
    const s = try a.dupe(u8, tx.outputs[0].locking_script.bytes);
    const lock = brc162.decode(s).?.lock;
    @memcpy(s[s.len - lock.len + (try pool.parse(lock)).?.code_len + 1 + 8 + 33 ..][0..33], &key33(vec.pool2.validator));
    try expectRefused(try f.spend(.swap, try withOutput(a, req, 0, s), op), .wrong_next_key);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: signatures missing or bad; a preimage that is not this input's" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in" });
    const req = try request(a, f.raw("swap_tokens_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("swap_bsv_in")), .vout = 0 };

    // The taker's token input unsigned.
    try expectRefused(try f.spend(.swap, try withUnlocking(a, req, 1, &.{}), op), .missing_signature);
    // A signature byte flipped (still DER-shaped: flip the last byte of s).
    const tx = try Transaction.parse(a, req);
    const u = try a.dupe(u8, tx.inputs[1].unlocking_script.bytes);
    u[u[0] - 1] ^= 0x01; // the byte before the sighash flag
    try expectRefused(try f.spend(.swap, try withUnlocking(a, req, 1, u), op), .bad_signature);
    // The call's preimage from another transaction.
    const other = (try unlock.parseCall(a, (try Transaction.parse(a, f.raw("swap_bsv_in"))).inputs[0].unlocking_script.bytes, .swap)).?;
    const call = (try unlock.parseCall(a, tx.inputs[0].unlocking_script.bytes, .swap)).?;
    const pre_at = call.pushes[call.pushes.len - 2];
    const swapped = try std.mem.concat(a, u8, &.{ call.script[0..pre_at.start], try unlock.pushData(a, other.preimage()), call.script[pre_at.p.next..] });
    try expectRefused(try f.spend(.swap, try withUnlocking(a, req, 0, swapped), op), .preimage_mismatch);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: the pool was already spent; the reply carries its newest state (unless the spender is this very request: a retry, answered again)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in" });
    const pool_op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    // The request whose signed transaction spent the pool, sent again (a
    // retry after a 503): recognised, answered with the held transaction,
    // not signed again.
    const retry = try f.spend(.swap, try request(a, f.raw("swap_bsv_in"), 0), pool_op);
    try testing.expect(retry == .ok);
    try testing.expectEqualSlices(u8, f.raw("swap_bsv_in"), retry.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(f.raw("swap_bsv_in")), &retry.ok.txid.?);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);

    // Two swaps landed: another taker's stale request for the first pool is
    // refused with the pool after both.
    const stale = try withUnlocking(a, try request(a, f.raw("swap_bsv_in"), 0), 1, &.{0x00});
    const r = try f.spend(.swap, stale, pool_op);
    try expectRefused(r, .pool_spent);
    const s = r.refused.newest.?.live;
    try testing.expect(s.outpoint.eql(.{ .txid = txidOf(f.raw("swap_tokens_in")), .vout = 0 }));
    try testing.expectEqual(@as(u64, vec.pool2.bsv), s.satoshis);
    try testing.expectEqual(@as(u64, vec.pool2.tokens), s.pool.token_reserve);
    try testing.expectEqualSlices(u8, &key33(vec.pool2.validator), &s.pool.validator);

    // As the reply body has it.
    const body = try messages.replyValue(a, r);
    const back = try cbor.decode(a, try cbor.encode(a, body));
    try testing.expectEqual(false, back.getBool("ok").?);
    try testing.expectEqualStrings("pool_spent", back.getText("reason").?);
    const p = back.get("pool").?;
    try testing.expectEqualStrings(try s.outpoint.format(a), p.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool2.bsv), p.getUint("bsvReserve").?);
    try testing.expectEqual(@as(u64, vec.pool2.tokens), p.getUint("tokenReserve").?);
    try testing.expectEqual(@as(u64, vec.lp_fee_bps), p.getUint("lpFeeBps").?);
    try testing.expectEqual(@as(u64, vec.commission_bps), p.getUint("commissionBps").?);
    try testing.expectEqualSlices(u8, &key33(vec.identity), p.getBytes("validatorIdentity").?);

    // Past the LP's Close: the pool is closed, by it.
    _ = try f.mem.hold(f.raw("close"));
    const r2 = try f.spend(.swap, stale, .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 });
    const closed = r2.refused.newest.?.closed;
    try testing.expect(closed.last.eql(.{ .txid = txidOf(f.raw("swap_tokens_in")), .vout = 0 }));
    try testing.expectEqualSlices(u8, &txidOf(f.raw("close")), &closed.by);
}

// --- the affirmation (0.13.0) ---

test "affirm (0.13.0): the proposed pool, checked against the terms; the nonce picked, the key derived from it, the pool signed — gen/vectors' affirmation byte for byte; the deploy carrying them is affirmed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{});
    const pr = try f.proposed();
    try f.oracle.recordAffirmation(a, f.raw("pool_deploy"));
    const r = try f.affirm(pr.script, pr.satoshis);
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, unhex(a, vec.affirmation), r.ok.signature.?);
    try testing.expectEqualSlices(u8, &key33(vec.pool0.validator), &r.ok.validator_pub_key.?);
    try testing.expectEqualSlices(u8, &nonce(), &r.ok.nonce.?);
    try testing.expect(r.ok.tx == null and r.ok.submission == null); // nothing to submit
    // The deploy's pool output: the proposed one with the three filled in, byte for byte.
    const pd = try Transaction.parse(a, f.raw("pool_deploy"));
    const got = try a.dupe(u8, pd.outputs[0].locking_script.bytes);
    const p = pool.poolOfScript(got).?;
    try testing.expectEqualSlices(u8, &r.ok.validator_pub_key.?, &p.validator);
    try testing.expectEqualSlices(u8, &r.ok.nonce.?, &p.nonce);
    try testing.expectEqualSlices(u8, r.ok.signature.?, p.affirmation);
    try testing.expect(pool.affirmed(a, got, pr.satoshis));
    // The signer was asked the key, then the signature.
    try testing.expectEqual(@as(usize, 2), f.oracle.calls);

    // A random nonce (no fixed one): another key, another signature, still affirmed.
    const rr = try validator.affirm(a, .{ .pool = pr.script, .satoshis = pr.satoshis }, f.cfg, f.oracle.oracle());
    try testing.expect(!std.mem.eql(u8, &rr.ok.nonce.?, &nonce()));
    try testing.expectEqualSlices(u8, &(try pool.firstValidatorKey(a, f.cfg.identity, rr.ok.nonce.?)), &rr.ok.validator_pub_key.?);
    var q = p;
    q.validator = rr.ok.validator_pub_key.?;
    q.nonce = rr.ok.nonce.?;
    try testing.expect(pool.affirmationVerifies(q, pr.satoshis, rr.ok.signature.?));

    // Through the protocol: {ok: true, validatorPubKey, nonce, signature}.
    const body = readBack(a, try messages.replyValue(a, r));
    try testing.expectEqual(@as(usize, 4), body.map.len);
    try testing.expectEqualSlices(u8, unhex(a, vec.affirmation), body.getBytes("signature").?);
    try testing.expectEqualSlices(u8, &key33(vec.pool0.validator), body.getBytes("validatorPubKey").?);
    try testing.expectEqualSlices(u8, &nonce(), body.getBytes("nonce").?);
}

test "affirm (0.13.0) refused: fees not the terms, another validator's pool, a script with a payload, not a pool, a prefix not the state's, no reserves — nothing signed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{});
    const pr = try f.proposed();

    // The terms: each fee exactly.
    var cfg = f.cfg;
    cfg.terms.?.lp_fee_bps += 1;
    const r1 = try validator.affirm(a, .{ .pool = pr.script, .satoshis = pr.satoshis }, cfg, f.oracle.oracle());
    try expectRefused(r1, .fees_unacceptable);
    try testing.expect(std.mem.startsWith(u8, r1.refused.detail.?, "lpFeeBps"));
    cfg = f.cfg;
    cfg.terms.?.commission_bps = 0;
    try expectRefused(try validator.affirm(a, .{ .pool = pr.script, .satoshis = pr.satoshis }, cfg, f.oracle.oracle()), .fees_unacceptable);
    // Another validator's pool (our identity differs).
    cfg = f.cfg;
    cfg.identity = key33(vec.pool0.validator);
    try expectRefused(try validator.affirm(a, .{ .pool = pr.script, .satoshis = pr.satoshis }, cfg, f.oracle.oracle()), .not_our_pool);
    // A payload after the prefix, a token payout, nonsense.
    const lock = brc162.decode(pr.script).?.lock;
    var buf: [10]u8 = undefined;
    const with_payload = try std.mem.concat(a, u8, &.{ &.{0x20}, &f.id, brc162.pushAmount(&buf, vec.pool0.tokens), &.{0x6d}, &.{ 0x01, 0x00, 0x75 }, lock });
    try expectRefused(try f.affirm(with_payload, pr.satoshis), .bad_request);
    const pd = try Transaction.parse(a, f.raw("pool_deploy"));
    try expectRefused(try f.affirm(pd.outputs[1].locking_script.bytes, pr.satoshis), .not_a_pool);
    try expectRefused(try f.affirm("nonsense", pr.satoshis), .not_a_pool);
    // The prefix amount not the TokenReserve.
    const low = try std.mem.concat(a, u8, &.{ &.{0x20}, &f.id, brc162.pushAmount(&buf, vec.pool0.tokens - 1), &.{0x6d}, lock });
    try expectRefused(try f.affirm(low, pr.satoshis), .bad_pool);
    // No sats.
    try expectRefused(try f.affirm(pr.script, 0), .bad_request);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

// --- the protocol ---

const sender_priv: [32]u8 = .{0x31} ** 32;

/// A direct call's frame: a signed-message package `{message, body}`, the
/// mail record signed BRC-169's way by `priv` (its anyone-child for
/// [2, "metanet handles envelope"], key ID "send", over sha256 of the record
/// without `signature`), as a taker's wallet signs it.
fn package(a: std.mem.Allocator, priv: [32]u8, recipient: [33]u8, box: []const u8, body: Value) ![]const u8 {
    const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(priv));
    const sender = (try kd.identityKey()).toCompressedSec1();
    const body_bytes = try cbor.encode(a, body);
    const blk = try scbor.block(a, try scbor.decode(a, body_bytes));
    try testing.expectEqualSlices(u8, body_bytes, blk.bytes); // the same canonical dag-cbor either side
    var es: std.ArrayList(scbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .string = "mail" } },
        .{ .key = "op", .value = .{ .string = "put" } },
        .{ .key = "sender", .value = .{ .bytes = try a.dupe(u8, &sender) } },
        .{ .key = "recipient", .value = .{ .bytes = try a.dupe(u8, &recipient) } },
        .{ .key = "box", .value = .{ .string = box } },
        .{ .key = "body", .value = .{ .cid = blk.cid } },
        .{ .key = "nonce", .value = .{ .bytes = &(.{7} ** 16) } },
    });
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(try scbor.encode(a, .{ .map = es.items }), &digest, .{});
    const child = try kd.derivePrivateKey(a, .{ .security_level = 2, .name = "metanet handles envelope" }, "send", .{ .type_ = .anyone });
    const sig = try child.signDigest(digest);
    try es.append(a, .{ .key = "signature", .value = .{ .bytes = try a.dupe(u8, sig.asSlice()) } });
    return scbor.encode(a, .{ .map = try a.dupe(scbor.Entry, &.{
        .{ .key = "message", .value = .{ .map = es.items } },
        .{ .key = "body", .value = .{ .bytes = body_bytes } },
    }) });
}

fn expectUnauthenticated(o: messages.Opened) !void {
    switch (o) {
        .ok => return error.TestExpectedRefusal,
        .refused => |r| try expectRefused(r, .unauthenticated),
    }
}

test "direct call: the frame is a signed-message package for this validator and this call; anything else is refused unauthenticated" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const me = key33(vec.identity);
    const body = try spendBody(a, "tx bytes", .{ .txid = .{1} ** 32, .vout = 0 });

    const frame = try package(a, sender_priv, me, "swap", body);
    const opened = try messages.open(a, frame, me, .swap);
    const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(sender_priv));
    try testing.expectEqualSlices(u8, &(try kd.identityKey()).toCompressedSec1(), &opened.ok.sender);
    try testing.expectEqualSlices(u8, "tx bytes", opened.ok.body.getBytes("tx").?);

    // For another validator; for another call; not a package; tampered.
    try expectUnauthenticated(try messages.open(a, frame, key33(vec.pool0.validator), .swap));
    try expectUnauthenticated(try messages.open(a, frame, me, .affirm));
    try expectUnauthenticated(try messages.open(a, try cbor.encode(a, body), me, .swap));
    try expectUnauthenticated(try messages.open(a, "nonsense", me, .swap));
    const other = try package(a, sender_priv, me, "swap", try spendBody(a, "other bytes", .{ .txid = .{1} ** 32, .vout = 0 }));
    const pkg = try scbor.decode(a, frame);
    const swapped = try scbor.encode(a, .{ .map = try a.dupe(scbor.Entry, &.{
        .{ .key = "message", .value = pkg.get("message").? },
        .{ .key = "body", .value = (try scbor.decode(a, other)).get("body").? },
    }) });
    try expectUnauthenticated(try messages.open(a, swapped, me, .swap)); // a body the message does not name

    // skein-amm 0.31.0: the relay's frame names the token's topic at its top level (the dialled host
    // routes the stream by it); `open` reads `message` and `body` by name, the extra key changes nothing.
    const with_topic = try scbor.encode(a, .{ .map = try a.dupe(scbor.Entry, &.{
        .{ .key = "message", .value = pkg.get("message").? },
        .{ .key = "body", .value = pkg.get("body").? },
        .{ .key = "topic", .value = .{ .string = "tm_color_" ++ "ab" ** 32 ++ "_0" } },
    }) });
    const opened2 = try messages.open(a, with_topic, me, .swap);
    try testing.expectEqualSlices(u8, "tx bytes", opened2.ok.body.getBytes("tx").?);
}

test "protocol: request bodies parse; bad ones are refused; replies encode" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const op = m.pool_op;
    const op_text = try op.format(a);
    try testing.expectEqual(@as(usize, 66), op_text.len);
    try testing.expect(Outpoint.parse(op_text).?.eql(op));
    try testing.expect(Outpoint.parse("ab_0") == null);
    try testing.expect(Outpoint.parse(try std.mem.concat(a, u8, &.{ op_text[0..64], "_01" })) == null);
    try testing.expect(Outpoint.parse(try std.mem.concat(a, u8, &.{ op_text[0..64], "_" })) == null);

    // Through the bytes a taker sends, packaged and opened as the handler opens them.
    const req = try m.swapRequest(a);
    const frame = try package(a, sender_priv, m.f.cfg.identity, "swap", try spendBody(a, req, op));
    const body = (try messages.open(a, frame, m.f.cfg.identity, .swap)).ok.body;
    const r = try messages.respond(a, .swap, body, try m.deps());
    try testing.expect(r.reply == .ok and r.next == .submit);
    const reply = try cbor.decode(a, try cbor.encode(a, try messages.replyValue(a, r.reply)));
    try testing.expectEqual(true, reply.getBool("ok").?);
    try testing.expectEqualSlices(u8, m.f.raw("swap_bsv_in"), reply.getBytes("tx").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(m.f.raw("swap_bsv_in"))), reply.getText("txid").?);

    // Missing fields, a numeric pool for a spend, a text pool for an affirm, no satoshis.
    const d = try m.deps();
    try expectRefused((try messages.respond(a, .swap, .{ .map = &.{.{ .key = "tx", .value = .{ .bytes = req } }} }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .swap, .{ .map = &.{ .{ .key = "tx", .value = .{ .bytes = req } }, .{ .key = "pool", .value = .{ .uint = 0 } } } }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .affirm, .{ .map = &.{ .{ .key = "pool", .value = .{ .text = op_text } }, .{ .key = "satoshis", .value = .{ .uint = 1 } } } }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .affirm, .{ .map = &.{.{ .key = "pool", .value = .{ .bytes = req } }} }, d)).reply, .bad_request);
    // An affirm through the protocol: answered at once, nothing to submit.
    const pr = try m.f.proposed();
    const ar = try messages.respond(a, .affirm, try affirmBody(a, pr.script, pr.satoshis), d);
    try testing.expect(ar.reply == .ok and ar.next == .answer);
    try testing.expect(ar.reply.ok.signature != null and ar.reply.ok.nonce != null and ar.reply.ok.validator_pub_key != null);
    try expectRefused((try messages.respond(a, .swap, .{ .text = "hi" }, d)).reply, .bad_request);

    // A refusal: {ok: false, reason, detail}.
    const refused = try messages.replyValue(a, .{ .refused = .{ .reason = .not_our_pool, .detail = "x" } });
    try testing.expectEqual(@as(usize, 3), refused.map.len);
    try testing.expectEqualStrings("not_our_pool", refused.getText("reason").?);

    try testing.expectEqual(validator.Op.affirm, validator.Op.parse("affirm").?);
    try testing.expect(validator.Op.parse("deploy") == null); // 0.11.0: gone
    try testing.expect(validator.Op.parse("addLiquidity") == null); // 0.9.0: gone
    try testing.expect(validator.Op.parse("removeLiquidity") == null);
}

// --- the marketplace relay's request: a swap with its funding as an unproven parent ---

/// The fixtures' taker (gen/main.go `key(30)`), who owns fund:1.
const taker_priv: [32]u8 = .{30} ** 32;

fn pushNum(a: std.mem.Allocator, n: u64) ![]u8 {
    if (n == 0) return a.dupe(u8, &.{0});
    if (n <= 16) return a.dupe(u8, &.{@intCast(0x50 + n)});
    var b: [9]u8 = undefined;
    var len: usize = 0;
    var x = n;
    while (x > 0) : (x >>= 8) {
        b[len] = @intCast(x & 0xff);
        len += 1;
    }
    if (b[len - 1] & 0x80 != 0) {
        b[len] = 0;
        len += 1;
    }
    return unlock.pushData(a, b[0..len]);
}

fn p2pkhLock(a: std.mem.Allocator, pkh: []const u8) ![]u8 {
    return std.mem.concat(a, u8, &.{ &.{ 0x76, 0xa9, 0x14 }, pkh, &.{ 0x88, 0xac } });
}

/// Sign input `i` (P2PKH, ALL|FORKID): `<DER ‖ 0x41> <pubkey>`.
fn signP2pkh(a: std.mem.Allocator, tx: *Transaction, i: usize, src: []const u8, sats: u64, priv: [32]u8) !void {
    return signP2pkhScope(a, tx, i, src, sats, priv, unlock.sighash_all_forkid);
}

/// Sign input `i` (P2PKH) under sighash `scope`: `<DER ‖ scope> <pubkey>`.
fn signP2pkhScope(a: std.mem.Allocator, tx: *Transaction, i: usize, src: []const u8, sats: u64, priv: [32]u8, scope: u32) !void {
    const k = try bsvz.primitives.ec.PrivateKey.fromBytes(priv);
    const sig = try k.signDigest(unlock.sha256d(try unlock.preimage(a, tx, i, src, sats, scope)));
    const pubkey = (try k.publicKey()).toCompressedSec1();
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = bsvz.script.Script.init(try std.mem.concat(a, u8, &.{ try unlock.pushData(a, try std.mem.concat(a, u8, &.{ sig.asSlice(), &.{@as(u8, @intCast(scope))} })), try unlock.pushData(a, &pubkey) }));
    tx.inputs = ins;
}

/// The pair the relay forwards (docs/notes.md 2026-10-02, "Swap funding and
/// signing"), derived from the fixtures: `funding` spends the taker's fund:1
/// and pays one exact output (the swap's input) plus change; `swap` is
/// `swap_bsv_in` with its other input that output and no change output
/// (`_changeAmount = 0`), its contract outputs as they are (the commission
/// at output 4 to the fixtures' relay, `commission_pkh`), the preimage the
/// pool call pushes recomputed, the validator's slot empty, the funding
/// input signed by the taker. `funding_sig` leaves the funding transaction's
/// own input signed, unsigned, or with a bad signature.
const RelayPair = struct { funding: []const u8, swap: []const u8 };

const FundingSig = enum { signed, unsigned, bad };

fn relayPair(a: std.mem.Allocator, f: *Fx, funding_sig: FundingSig) !RelayPair {
    const fund = try Transaction.parse(a, f.raw("fund"));
    const pd = try Transaction.parse(a, f.raw("pool_deploy"));
    const base = try Transaction.parse(a, f.raw("swap_bsv_in"));
    const taker_pkh = bsvz.crypto.hash.hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(taker_priv)).publicKey()).toCompressedSec1()).bytes;
    const taker_lock = try p2pkhLock(a, &taker_pkh);

    // The contract's outputs: pool, payout, LP fee, validator fee, commission.
    const outs = base.outputs[0..5];
    var out_sum: u64 = 0;
    for (outs) |o| out_sum += @intCast(o.satoshis);
    const pool_sats: u64 = @intCast(pd.outputs[0].satoshis);
    const exact = out_sum - pool_sats + 500;

    var ft = fund;
    ft.inputs = try a.dupe(bsvz.transaction.Input, &.{.{
        .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f.raw("fund")) }, .index = 1 },
        .unlocking_script = bsvz.script.Script.empty(),
        .sequence = 0xffffffff,
    }});
    ft.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = bsvz.script.Script.init(taker_lock) },
        .{ .satoshis = @intCast(500_000 - exact - 300), .locking_script = bsvz.script.Script.init(taker_lock) },
    });
    if (funding_sig != .unsigned) try signP2pkh(a, &ft, 0, fund.outputs[1].locking_script.bytes, @intCast(fund.outputs[1].satoshis), taker_priv);
    if (funding_sig == .bad) {
        const u = try a.dupe(u8, ft.inputs[0].unlocking_script.bytes);
        u[u[0] - 1] ^= 0x01; // the DER signature's last byte
        const fins = try a.dupe(bsvz.transaction.Input, ft.inputs);
        fins[0].unlocking_script = bsvz.script.Script.init(u);
        ft.inputs = fins;
    }
    const f_raw = try ft.serialize(a);

    var s = base;
    const ins = try a.dupe(bsvz.transaction.Input, &.{ base.inputs[0], .{
        .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f_raw) }, .index = 0 },
        .unlocking_script = bsvz.script.Script.empty(),
        .sequence = 0xffffffff,
    } });
    s.inputs = ins;
    s.outputs = outs;
    const lock = brc162.decode(pd.outputs[0].locking_script.bytes).?.lock;
    const pre = try unlock.preimage(a, &s, 0, unlock.poolScriptCode(lock).?, pool_sats, unlock.sighash_all_forkid);
    const call = (try unlock.parseCall(a, base.inputs[0].unlocking_script.bytes, .swap)).?;
    // _codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
    // commissionPkh, tokenChangePkh, tokenChange, _changePKH, _changeAmount, txPreimage, methodIndex.
    try testing.expectEqualSlices(u8, &key20(vec.commission_pkh), call.arg(5).data);
    var script: std.ArrayList(u8) = .empty;
    for (call.pushes, 0..) |p, i| try script.appendSlice(a, switch (i) {
        1 => &.{0}, // validatorSig: the slot, empty
        10 => &.{0}, // _changeAmount = 0: no change output
        11 => try unlock.pushData(a, pre),
        else => call.script[p.start..p.p.next],
    });
    ins[0].unlocking_script = bsvz.script.Script.init(script.items);
    try signP2pkh(a, &s, 1, taker_lock, exact, taker_priv);
    return .{ .funding = f_raw, .swap = try s.serialize(a) };
}

/// The relay's request BEEF: fund (proven in the mined block), the funding transaction (unproven), the swap.
fn relayBeef(a: std.mem.Allocator, m: *Mined, p: RelayPair) ![]const u8 {
    const fund = m.f.raw("fund");
    const bumps = try a.alloc(w.merkle.MerklePath, 1);
    bumps[0] = try w.merkle.MerklePath.parse(a, try bump4(a, 1, m.leaves, &.{0}));
    return w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = bumps, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(fund), .format = .raw_with_bump, .bump = 0, .raw = fund },
        .{ .txid = txidOf(p.funding), .format = .raw, .raw = p.funding },
        .{ .txid = txidOf(p.swap), .format = .raw, .raw = p.swap },
    }) });
}

test "relay request: a swap with its funding transaction as an unproven parent, one BEEF — the funding checked complete, the pool input signed last, both submitted (the parent for the validator to broadcast, the swap through skein's submit), admitted" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const p = try relayPair(a, m.f, .signed);
    const req = try relayBeef(a, m, p);

    const served = try m.respond(a, req);
    try testing.expect(served.reply == .ok);
    try testing.expectEqual(@as(usize, 1), m.f.oracle.calls); // one signature: the pool input's
    const signed = served.reply.ok.tx.?;
    // Signed last: the signed swap is the request with the validator's signature in its slot, every other byte as sent;
    // the taker's signature over it still verifies (SIGHASH_ALL does not cover the pool input's unlocking script).
    try testing.expectEqualSlices(u8, p.swap, try request(a, signed, 0));
    const st = try Transaction.parse(a, signed);
    const ft = try Transaction.parse(a, p.funding);
    try testing.expectEqual(unlock.InputCheck.verified, try unlock.checkInput(a, &st, 1, ft.outputs[0].locking_script.bytes, @intCast(ft.outputs[0].satoshis)));
    const spent = (try pool.parse(brc162.decode((try Transaction.parse(a, m.f.raw("pool_deploy"))).outputs[0].locking_script.bytes).?.lock)).?;
    const sc = (try unlock.parseCall(a, st.inputs[0].unlocking_script.bytes, .swap)).?;
    try testing.expect(unlock.verify(sc.arg(0).data, &spent.validator, unlock.sha256d(sc.preimage()), unlock.sighash_all_forkid));

    // The parent to broadcast: the funding transaction (fund is proven in the BEEF), with its Atomic BEEF.
    try testing.expectEqual(@as(usize, 1), served.broadcast.len);
    try testing.expectEqualSlices(u8, &txidOf(p.funding), &served.broadcast[0].txid);
    try testing.expectEqualSlices(u8, p.funding, served.broadcast[0].raw);
    const ab = try w.beef.parse(a, served.broadcast[0].beef);
    try testing.expectEqualSlices(u8, &txidOf(p.funding), &ab.atomic.?);
    try testing.expectEqual(@as(usize, 2), ab.entries.len); // fund (with its BUMP), the funding transaction
    try testing.expectEqualSlices(u8, &txidOf(m.f.raw("fund")), &ab.entries[0].txid);

    // The swap's submission: the engine's route verified the BEEF (the pool contract and both P2PKH spends
    // run), which carries the pool's transaction (0.29.5), fund, the funding transaction, the signed swap;
    // the chain app ingests it, registering and broadcasting the funding transaction and the swap, parents
    // first (pool_deploy arrives proven: nothing to broadcast); RECEIVED admits it.
    const ev = readBack(a, try m.node.launched(served));
    const txs = try txsOf(a, ev);
    try testing.expectEqual(@as(usize, 4), txs.len);
    try testing.expectEqualSlices(u8, m.f.raw("fund"), txs[0]);
    try testing.expectEqualSlices(u8, m.f.raw("pool_deploy"), txs[1]);
    try testing.expectEqualSlices(u8, p.funding, txs[2]);
    try testing.expectEqualSlices(u8, signed, txs[3]);
    const first = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first.gate);
    try testing.expectEqual(@as(usize, 2), m.node.posts); // the funding transaction and the swap, by the chain app
    try testing.expect((try (try m.node.chain()).txRaw(txidOf(p.funding))) != null); // held now
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, done.applied[0].outputs_to_admit);
    const ans = try m.answer(a, req);
    try testing.expect(ans == .ok);
    try testing.expectEqualSlices(u8, signed, ans.ok.tx.?);

    // Sent again (pending → admitted now): answered from the state, nothing broadcast again.
    const again = try m.respond(a, req);
    try testing.expect(again.next == .from_state);
    try testing.expectEqual(@as(usize, 0), again.broadcast.len);
}

/// The door's check (skein kernel-zig/src/door.zig `spv`): skein-sdk `chain.spv.verify` over the
/// BEEF, `rootAt` the mined block's merkle root at height 1, `knownRaw` none — the BEEF stands alone.
fn doorVerify(a: std.mem.Allocator, m: *Mined, bytes: []const u8) !w.spv.Result {
    const Ctx = struct {
        blk: [80]u8,
        fn rootAt(ptr: *anyopaque, height: u32) anyerror!?[32]u8 {
            const c: *@This() = @ptrCast(@alignCast(ptr));
            return if (height == 1) c.blk[36..68].* else null;
        }
        fn knownRaw(_: *anyopaque, _: std.mem.Allocator, _: [32]u8) anyerror!?[]const u8 {
            return null;
        }
    };
    var ctx = Ctx{ .blk = m.blk };
    return w.spv.verify(a, try w.beef.parse(a, bytes), .{ .ptr = &ctx, .rootAtFn = Ctx.rootAt, .knownRawFn = Ctx.knownRaw });
}

test "submission BEEF (0.29.5): a relay request without the pool's transaction — the submission carries it with its proof and passes the door's check (chain.spv.verify, nothing known); a request that carries it already is not duplicated" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const pool_txid = txidOf(m.f.raw("pool_deploy"));

    // As the relay sends it: fund (proven), the taker's funding, the swap — no pool_deploy.
    const p = try relayPair(a, m.f, .signed);
    const req = try relayBeef(a, m, p);
    try testing.expect((try w.beef.parse(a, req)).find(pool_txid) == null);

    const served = try m.respond(a, req);
    try testing.expect(served.reply == .ok);
    const signed = served.reply.ok.tx.?;
    // Before 0.29.5 (the request's ancestry alone): the door refuses it, MissingInput (ovh, 2026-11-03).
    const old = try submit.submissionBeef(a, signed, try w.beef.parse(a, req), null);
    try testing.expectError(error.MissingInput, doorVerify(a, m, old));
    const out = served.next.submit.beef;
    const ob = try w.beef.parse(a, out);
    // (a) the pool's transaction is in it, with its BUMP; the swap is still the subject, last.
    const pe = ob.find(pool_txid) orelse return error.TestPoolMissing;
    try testing.expectEqual(w.beef.Format.raw_with_bump, pe.format);
    try testing.expect(w.beef.bumpHas(ob.bumps[pe.bump.?], pool_txid));
    try testing.expectEqualSlices(u8, m.f.raw("pool_deploy"), pe.raw.?);
    try testing.expectEqualSlices(u8, &txidOf(signed), &ob.subject().?);
    try testing.expectEqualSlices(u8, &txidOf(signed), &ob.entries[ob.entries.len - 1].txid);
    try testing.expectEqual(@as(usize, 4), ob.entries.len); // fund, pool_deploy, funding, swap
    try testing.expectEqual(@as(usize, 1), ob.bumps.len); // one block: one BUMP, both leaves
    // (b) the door's exact check passes: every input's source inside the BEEF, scripts verified.
    const r = try doorVerify(a, m, out);
    for (ob.entries, r.proven) |e, proven| try testing.expectEqual(e.format == .raw_with_bump, proven);

    // (c) a request that carries the pool's transaction already: once, one BUMP, and it verifies.
    const with = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = ob.bumps, .entries = try a.dupe(w.beef.Entry, &.{
        ob.entries[0], ob.entries[1], ob.entries[2],
        .{ .txid = txidOf(p.swap), .format = .raw, .raw = p.swap },
    }) });
    var ms2 = w.store.MemStore.init(testing.allocator);
    defer ms2.deinit();
    const m2 = try Mined.init(a, &ms2);
    const served2 = try m2.respond(a, with);
    try testing.expect(served2.reply == .ok);
    const ob2 = try w.beef.parse(a, served2.next.submit.beef);
    try testing.expectEqual(@as(usize, 4), ob2.entries.len);
    try testing.expectEqual(@as(usize, 1), ob2.bumps.len);
    for (ob2.entries, 0..) |e, i| for (ob2.entries[0..i]) |x| try testing.expect(!std.mem.eql(u8, &e.txid, &x.txid));
    _ = try doorVerify(a, m2, served2.next.submit.beef);
    // The Rescind's path (submit.withPool): a BEEF that holds the pool already is unchanged.
    const again = try w.beef.parse(a, try submit.withPool(a, out, try ov.state.beefFor((try m.node.state()).ch, pool_txid)));
    try testing.expectEqual(ob.entries.len, again.entries.len);
    try testing.expectEqual(ob.bumps.len, again.bumps.len);
}

test "relay request refused: an unsigned funding input, a bad funding signature, a pool already spent — nothing signed, nothing to broadcast" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);

    // The funding transaction's input unsigned.
    {
        const p = try relayPair(a, m.f, .unsigned);
        const r = try m.respond(a, try relayBeef(a, m, p));
        try expectRefused(r.reply, .missing_signature);
        try testing.expect(std.mem.startsWith(u8, r.reply.refused.detail.?, "parent "));
        try testing.expect(r.next == .answer);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
    // Its signature bad (verified against fund:1, which the BEEF carries).
    {
        const p = try relayPair(a, m.f, .bad);
        const r = try m.respond(a, try relayBeef(a, m, p));
        try expectRefused(r.reply, .bad_signature);
        try testing.expect(std.mem.startsWith(u8, r.reply.refused.detail.?, "parent "));
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
    // The pool already spent (another swap admitted first): refused with its newest state, nothing broadcast.
    {
        const first = try m.respond(a, try m.swapRequest(a));
        const fev = try m.node.launched(first);
        _ = try m.node.step(fev);
        _ = try m.node.status(fev, "RECEIVED");
        m.f.oracle.calls = 0;
        const p = try relayPair(a, m.f, .signed);
        const r = try m.respond(a, try relayBeef(a, m, p));
        try expectRefused(r.reply, .pool_spent);
        try testing.expect(r.reply.refused.newest != null);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
}

// --- the marketplace relay's deploy: the LP's deploy with its funding as an unproven parent ---

// --- the validator's Rescind (0.13.0): the pool as the wallet's caller input, with a mocked wallet ---

/// The validator wallet's coin (gen/vectors `validatorWallet`, key(0x77)): fund:6.
const wallet_priv: [32]u8 = .{0x77} ** 32;

/// A mocked wallet (skein's wallet program, #93: createAction with a caller input, signAction with
/// its spends): the draft spends the caller's inputs first, then its own coin fund:6, its outputs the
/// caller's and its change after them, a 600 sats' fee — gen/vectors' `rescind` exactly.
const MockWallet = struct {
    f: *Fx,
    draft: ?Transaction = null,
    declared: u64 = 0,

    fn createAction(self: *MockWallet, a: std.mem.Allocator, body: Value) !Value {
        try testing.expectEqualStrings("createAction", body.getText("op").?);
        const in0 = body.getArray("inputs").?[0];
        self.declared = in0.getUint("unlockingScriptLength").?;
        try testing.expect(in0.get("unlockingScript") == null);
        try testing.expect(body.get("options").?.getBool("noSend").?);
        const op = in0.getText("outpoint").?;
        const ib = try w.beef.parse(a, body.getBytes("inputBEEF").?);
        const src_txid = w.header.fromHex(op[0..64]) catch unreachable;
        try testing.expect(ib.find(src_txid) != null);
        const vout = try std.fmt.parseInt(u32, op[65..], 10);
        const fund = try Transaction.parse(a, self.f.raw("fund"));
        const outs = body.getArray("outputs").?;
        try testing.expectEqual(@as(usize, 1), outs.len);
        var t = fund;
        t.version = 1;
        t.lock_time = 0;
        t.inputs = try a.dupe(bsvz.transaction.Input, &.{
            .{ .previous_outpoint = .{ .txid = .{ .bytes = src_txid }, .index = vout }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
            .{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(self.f.raw("fund")) }, .index = 6 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
        });
        const wl = try p2pkhLock(a, &bsvz.crypto.hash.hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(wallet_priv)).publicKey()).toCompressedSec1()).bytes);
        t.outputs = try a.dupe(bsvz.transaction.Output, &.{
            .{ .satoshis = @intCast(outs[0].getUint("satoshis").?), .locking_script = bsvz.script.Script.init(outs[0].getBytes("lockingScript").?) },
            .{ .satoshis = 50_000 - 600, .locking_script = bsvz.script.Script.init(wl) },
        });
        self.draft = t;
        const raw = try t.serialize(a);
        // The draft as Atomic BEEF, its inputBEEF the ancestry.
        var entries: std.ArrayList(w.beef.Entry) = .empty;
        try entries.appendSlice(a, ib.entries);
        if (ib.find(txidOf(self.f.raw("fund"))) == null) try entries.append(a, .{ .txid = txidOf(self.f.raw("fund")), .format = .raw, .raw = self.f.raw("fund") });
        try entries.append(a, .{ .txid = txidOf(raw), .format = .raw, .raw = raw });
        const atomic = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = txidOf(raw), .bumps = ib.bumps, .entries = entries.items });
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "wallet-result" } },
            .{ .key = "op", .value = .{ .text = "createAction" } },
            .{ .key = "txid", .value = .{ .text = &w.header.toHex(txidOf(raw)) } },
            .{ .key = "tx", .value = .{ .bytes = atomic } },
            .{ .key = "reference", .value = .{ .cid = "cid:draft" } },
        }) };
    }

    fn signAction(self: *MockWallet, a: std.mem.Allocator, body: Value) !Value {
        try testing.expectEqualStrings("signAction", body.getText("op").?);
        try testing.expectEqualStrings("cid:draft", body.getCid("reference").?);
        var t = self.draft.?;
        const sp = body.get("spends").?;
        try testing.expectEqual(@as(usize, 1), sp.map.len);
        const i = try std.fmt.parseInt(usize, sp.map[0].key, 10);
        const u = sp.map[0].value.getBytes("unlockingScript").?;
        try testing.expect(u.len <= self.declared); // the wallet refuses a longer one (UnlockingScriptTooLong)
        const ins = try a.dupe(bsvz.transaction.Input, t.inputs);
        ins[i].unlocking_script = bsvz.script.Script.init(u);
        t.inputs = ins;
        // The wallet signs its own input (the fixture's signature: go-sdk's RFC 6979 nonce, which
        // bsvz's signing does not reproduce); it must verify over this very transaction.
        const fixture = try Transaction.parse(a, self.f.raw("rescind"));
        const own = try a.dupe(bsvz.transaction.Input, t.inputs);
        own[1].unlocking_script = fixture.inputs[1].unlocking_script;
        t.inputs = own;
        const fund = try Transaction.parse(a, self.f.raw("fund"));
        try testing.expectEqual(unlock.InputCheck.verified, try unlock.checkInput(a, &t, 1, fund.outputs[6].locking_script.bytes, @intCast(fund.outputs[6].satoshis)));
        const raw = try t.serialize(a);
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "wallet-result" } },
            .{ .key = "op", .value = .{ .text = "signAction" } },
            .{ .key = "txid", .value = .{ .text = &w.header.toHex(txidOf(raw)) } },
            .{ .key = "tx", .value = .{ .bytes = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = txidOf(raw), .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{.{ .txid = txidOf(raw), .format = .raw, .raw = raw }}) }) } },
        }) };
    }
};

test "rescind (0.13.0): the pool, followed from its deploy to its newest output; the wallet's createAction with it as a caller input (its unlock to come, the contract's one output: the pool, its key cleared; noSend); the draft's pool input written as Rescind (the wallet's change as Rúnar's) and signed by the pool's current validator key; the wallet's signAction — gen/vectors' rescind byte for byte" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in" });
    var wallet: MockWallet = .{ .f = f };

    // From the deploy (root names the pool it knows), to its newest output: swap_tokens_in:0.
    const deploy_txid = txidOf(f.raw("pool_deploy"));
    const t = switch (try rescind.targetOf(a, f.mem.view(), f.cfg.identity, .{ .txid = deploy_txid, .vout = 0 })) {
        .ok => |t| t,
        .refused => |why| {
            std.debug.print("{s}\n", .{why});
            return error.TestUnexpectedRefusal;
        },
    };
    const sw2 = txidOf(f.raw("swap_tokens_in"));
    try testing.expect(t.op.eql(.{ .txid = sw2, .vout = 0 }));
    try testing.expectEqual(@as(u64, vec.pool2.bsv), t.satoshis);
    try testing.expectEqualSlices(u8, &key33(vec.pool2.validator), &t.pool.validator);
    try testing.expectEqualStrings(try validator.topicOf(a, f.id), try rescind.topicOf(a, t.pool));

    // The contract's output: the pool written back, the same sats, its key cleared.
    const fx = try Transaction.parse(a, f.raw("rescind"));
    const o = try rescind.rescindOutput(a, t.script, t.satoshis);
    try testing.expectEqualSlices(u8, fx.outputs[0].locking_script.bytes, o.script);
    try testing.expectEqual(@as(u64, vec.pool2.bsv), o.satoshis);
    try testing.expect(pool.poolOfScript(o.script).?.rescinded());

    // The input BEEF: the pool's transaction with its ancestry.
    const input_beef = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(f.raw("fund")), .format = .raw, .raw = f.raw("fund") },
        .{ .txid = txidOf(f.raw("token_deploy")), .format = .raw, .raw = f.raw("token_deploy") },
        .{ .txid = deploy_txid, .format = .raw, .raw = f.raw("pool_deploy") },
        .{ .txid = txidOf(f.raw("swap_bsv_in")), .format = .raw, .raw = f.raw("swap_bsv_in") },
        .{ .txid = sw2, .format = .raw, .raw = f.raw("swap_tokens_in") },
    }) });
    const body = try rescind.createBody(a, t, input_beef);
    try testing.expectEqualStrings("amm-rescind", body.getArray("labels").?[0].text);
    const draft = try wallet.createAction(a, body);
    const stage = rescind.stageOf(draft);
    try testing.expect(stage == .draft);
    const l = (try rescind.locate(a, f.cfg.identity, stage.draft.tx)).?;
    try testing.expectEqual(@as(usize, 0), l.index);
    const key_id = (try rescind.keyIdOf(a, f.mem.view(), l)).?;
    var kb: [64 + 1 + 10]u8 = undefined;
    try testing.expectEqualStrings(pool.keyId(&kb, txidOf(f.raw("swap_bsv_in")), 0), key_id); // the pool input of the swap that made it
    // The oracle reproduces the Go fixture's signature of the pool input.
    // (Rescind's call: code, sig, _changePKH, _changeAmount, preimage, method: six pushes.)
    const fu = fx.inputs[0].unlocking_script.bytes;
    var pushes: [6]brc162.Push = undefined;
    var pos: usize = 0;
    for (&pushes) |*p| {
        p.* = brc162.readPush(fu, pos).?;
        pos = p.next;
    }
    try testing.expectEqual(fu.len, pos);
    try testing.expectEqual(@as(u8, 0x52), pushes[5].op); // Rescind
    f.oracle.recorded = .{ .hash = unlock.sha256d(pushes[4].data), .der = pushes[1].data[0 .. pushes[1].data.len - 1] };
    const u = try rescind.unlockRescind(a, l, key_id, f.oracle.oracle());
    try testing.expectEqualSlices(u8, fu, u);
    try testing.expect(u.len <= try rescind.maxUnlockLen(l.script));
    const signed = try wallet.signAction(a, try rescind.signBody(a, stage.draft.reference, l.index, u));
    const fin = rescind.stageOf(signed);
    try testing.expect(fin == .signed);
    const fb = try w.beef.parse(a, fin.signed);
    try testing.expectEqualSlices(u8, f.raw("rescind"), fb.find(fb.atomic.?).?.raw.?);
    // The topic takes it: the pool a coin consumed, the rescinded pool admitted at output 0.
    _ = try f.mem.hold(f.raw("rescind"));
    try testing.expect(f.mem.spent.contains(MemView.key(.{ .txid = sw2, .vout = 0 })));
    try testing.expect(f.mem.admitted.contains(MemView.key(.{ .txid = txidOf(f.raw("rescind")), .vout = 0 })));

    // A draft whose output 0 is not the contract's (the key kept): refused.
    var bad = l;
    const changed = try a.dupe(bsvz.transaction.Output, l.tx.outputs);
    changed[0].locking_script = bsvz.script.Script.init(t.script);
    bad.tx.outputs = changed;
    try testing.expectError(error.NotTheContractsOutputs, rescind.unlockRescind(a, bad, key_id, f.oracle.oracle()));

    // Rescinded now: refused (no second Rescind); no swap is signed for it. Not ours: another
    // identity. Not held.
    try testing.expect((try rescind.targetOf(a, f.mem.view(), f.cfg.identity, .{ .txid = deploy_txid, .vout = 0 })) == .refused);
    const rop: Outpoint = .{ .txid = txidOf(f.raw("rescind")), .vout = 0 };
    const rs_tx = try Transaction.parse(a, f.raw("rescind"));
    try testing.expect((try validator.currentKeyId(a, f.mem.view(), pool.poolOfScript(rs_tx.outputs[0].locking_script.bytes).?, @intCast(rs_tx.outputs[0].satoshis), rop)) == null);
    try expectRefused(try f.spend(.swap, try request(a, f.raw("swap_tokens_in"), 0), rop), .pool_not_an_input);
    const g = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    try testing.expect((try rescind.targetOf(a, g.mem.view(), key33(vec.pool0.validator), .{ .txid = deploy_txid, .vout = 0 })) == .refused);
    try testing.expect((try rescind.targetOf(a, g.mem.view(), g.cfg.identity, .{ .txid = .{3} ** 32, .vout = 0 })) == .refused);
    // A wallet answer that is no draft or signed Rescind.
    try testing.expect(rescind.stageOf(.{ .map = &.{} }) == .failed);
    // A resolved thread's result: its stdout, the record's CID in hex (a newline after it).
    const res: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "exitCode", .value = .{ .uint = 0 } },
        .{ .key = "stdout", .value = .{ .bytes = "01711220aa\n" } },
    }) };
    try testing.expectEqualSlices(u8, &.{ 0x01, 0x71, 0x12, 0x20, 0xaa }, (try rescind.resultCid(a, res)).?);
    try testing.expect((try rescind.resultCid(a, .null)) == null);
}

/// A transaction with one input (`prev`:0, no script) and one output: its raw bytes.
fn chained(a: std.mem.Allocator, prev: [32]u8) ![]const u8 {
    var raw: std.ArrayList(u8) = .empty;
    try raw.appendSlice(a, &.{ 1, 0, 0, 0, 1 });
    try raw.appendSlice(a, &prev);
    try raw.appendSlice(a, &.{ 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1, 0x10, 0x27, 0, 0, 0, 0, 0, 0, 1, 0x51, 0, 0, 0, 0 });
    return raw.items;
}

test "unproven parents of a request whose BEEF is out of order (skein-sdk 0.11.1, David 2026-10-22): sorted, each parent's Atomic BEEF parents first" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ra = try chained(a, .{0x72} ** 32);
    const rb = try chained(a, w.beef.txidOf(ra));
    const rc = try chained(a, w.beef.txidOf(rb));
    const e = struct {
        fn of(al: std.mem.Allocator, raw: []const u8) !w.beef.Entry {
            return .{ .txid = w.beef.txidOf(raw), .format = .raw, .raw = raw, .tx = try Transaction.parse(al, raw) };
        }
    }.of;
    // Wire order: the subject, its parent, its grandparent.
    const bytes = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = w.beef.txidOf(rc), .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{ try e(a, rc), try e(a, rb), try e(a, ra) }) });
    const sub = validator.subjectOf(a, bytes).?;
    var mem = MemView.init(a, .{0} ** 32);
    const parents = try validator.unprovenParents(a, mem.view(), sub);
    try testing.expectEqual(@as(usize, 2), parents.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(ra), &parents[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(rb), &parents[1].txid);
    const pb = try w.beef.parse(a, parents[1].beef);
    try testing.expectEqual(@as(usize, 2), pb.entries.len);
    try testing.expect(w.beef.parentsFirst(pb));
    try testing.expectEqualSlices(u8, &w.beef.txidOf(rb), &pb.atomic.?);
}

test "terms (0.15.0, David 2026-10-23): a runtime record root sets — root's fn terms gated by roles.root, no config.amm.ammValidator; set, clear, refused shapes; the record round trip" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const terms = @import("terms");

    // The manifest: `terms` is root's (the kernel's gate: a non-root sender is refused before the
    // step), the box `validator` routes to amm-validator, and no fee numbers ship in it.
    const m = try std.json.parseFromSliceLeaky(std.json.Value, a, @import("app_manifest").json, .{});
    const root_fns = m.object.get("roles").?.object.get("root").?.array.items;
    const gated = for (root_fns) |f| {
        if (std.mem.eql(u8, f.string, terms.fn_terms)) break true;
    } else false;
    try testing.expect(gated);
    const routed = for (m.object.get("routes").?.array.items) |r| {
        if (std.mem.eql(u8, r.object.get("address").?.string, "validator") and std.mem.eql(u8, r.object.get("handler").?.string, "amm-validator")) break true;
    } else false;
    try testing.expect(routed);
    try testing.expect(m.object.get("config").?.object.get("amm") == null); // 0.16.0: no config.amm at all

    // The head.
    try testing.expectEqualStrings("amm/terms", try terms.headName(a, "amm"));

    // Set: the three fees, integers 0 to 10 000.
    const set: Value = .{ .map = &.{
        .{ .key = "lpFeeBps", .value = .{ .uint = 30 } },
        .{ .key = "validatorFeeBps", .value = .{ .uint = 5 } },
        .{ .key = "commissionBps", .value = .{ .uint = 25 } },
    } };
    const p = terms.parseArgs(set);
    try testing.expect(p == .set);
    try testing.expectEqual(@as(i64, 30), p.set.lp_fee_bps);
    try testing.expectEqual(@as(i64, 5), p.set.validator_fee_bps);
    try testing.expectEqual(@as(i64, 25), p.set.commission_bps);
    // Clear: args null, or none.
    try testing.expect(terms.parseArgs(.null) == .clear);
    try testing.expect(terms.parseArgs(null) == .clear);
    // Refused: a fee missing, a key not a fee, a fee over 10 000, negative, not an integer, not a map.
    const bads = [_]Value{
        .{ .map = &.{ .{ .key = "lpFeeBps", .value = .{ .uint = 30 } }, .{ .key = "validatorFeeBps", .value = .{ .uint = 5 } } } },
        .{ .map = &.{ .{ .key = "lpFeeBps", .value = .{ .uint = 30 } }, .{ .key = "validatorFeeBps", .value = .{ .uint = 5 } }, .{ .key = "commissionBps", .value = .{ .uint = 0 } }, .{ .key = "x", .value = .{ .uint = 1 } } } },
        .{ .map = &.{ .{ .key = "lpFeeBps", .value = .{ .uint = 10_001 } }, .{ .key = "validatorFeeBps", .value = .{ .uint = 5 } }, .{ .key = "commissionBps", .value = .{ .uint = 0 } } } },
        .{ .map = &.{ .{ .key = "lpFeeBps", .value = .{ .nint = 0 } }, .{ .key = "validatorFeeBps", .value = .{ .uint = 5 } }, .{ .key = "commissionBps", .value = .{ .uint = 0 } } } },
        .{ .map = &.{ .{ .key = "lpFeeBps", .value = .{ .text = "30" } }, .{ .key = "validatorFeeBps", .value = .{ .uint = 5 } }, .{ .key = "commissionBps", .value = .{ .uint = 0 } } } },
        .{ .text = "30/5/0" },
    };
    for (bads) |b| try testing.expect(terms.parseArgs(b) == .bad);

    // The record: what was set, read back; the cleared record (null) holds none.
    const rec = try terms.record(a, p.set);
    try testing.expectEqualSlices(u8, try cbor.encode(a, set), try cbor.encode(a, rec));
    try testing.expectEqual(p.set, terms.fromRecord(rec).?);
    try testing.expect(terms.fromRecord(.null) == null);
}

test "no terms (0.15.0): a market only — a swap and an affirm refused not_validating, \"no terms: this skein validates nothing\", before anything is checked or signed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const terms = @import("terms");
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    // Set: signed (the fixtures' terms).
    try testing.expect((try f.spend(.swap, req, op)) == .ok);
    const calls = f.oracle.calls;

    // Unset: refused, the oracle not asked.
    f.cfg.terms = null;
    const r = try f.spend(.swap, req, op);
    try expectRefused(r, .not_validating);
    try testing.expectEqualStrings(terms.no_terms, r.refused.detail.?);
    const body = try messages.replyValue(a, r);
    try testing.expectEqualStrings("not_validating", body.getText("reason").?);
    try testing.expectEqualStrings("no terms: this skein validates nothing", body.getText("detail").?);
    try testing.expectEqual(calls, f.oracle.calls);

    const g = try Fx.init(a, &.{});
    const pr = try g.proposed();
    g.cfg.terms = null;
    const ra = try g.affirm(pr.script, pr.satoshis);
    try expectRefused(ra, .not_validating);
    try testing.expectEqualStrings(terms.no_terms, ra.refused.detail.?);
    try testing.expectEqual(@as(usize, 0), g.oracle.calls);
}
