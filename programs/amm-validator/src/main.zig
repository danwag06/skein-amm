//! amm-validator: the AMM validator as a skein program (wasm32-wasi). The
//! thin VM adapter around messages.zig and validator.zig; the decisions are
//! there.
//!
//! **A direct call** (what libp2p calls a stream, skein#51). The app asks
//! for one route (docs/APPS.md §2: libp2p protocols are routes
//! `libp2p:<protocol>`, not namespaced): `libp2p:/amm-validator/1/swap` →
//! fn `swap` (0.11.0: `.../deploy` is gone; fn `affirm` is called in-VM by amm-p2p's
//! `amm.pool.affirm`, below, and answered at once). Each frame on one of them is a `p2p-frame` request the front
//! door steps on, and calls the handler with in its step (skein docs/MESSAGES.md,
//! "libp2p (#51)", "Streams"; "Route handlers: the program-facing contract
//! (#68, #66)"): `arg` is `{transport: "libp2p", protocol, from, key, body,
//! request, resolved?, …}`.
//!
//! The frame's body is a signed-message package `{message, body}` (MESSAGES
//! "Signed messages (#70)"): the taker (or LP) authenticates by its wallet
//! identity, the package checked with the SDK's verifier (messages.zig
//! `open`). Then the checks and the oracle's signature (validator.zig), and
//! the signed BEEF submitted to this instance's own overlay by message
//! (submit.zig; skein-overlay 0.7.2+: a submission is a message, answered to
//! the sender's box). The handler answers:
//!
//! - `{verdict: "accept", body: <reply>}` at once: a refusal; a transaction
//!   judged or rejected before (from the state);
//! - `{verdict: "accept", body: <the affirmation>}` at once for an `affirm` (0.11.0);
//! - `{wait: true}` for a signed spend, after sending
//!   `{fn: "submit", args: {beef, topics: [tm_color_<txid>_0]}}` to this instance,
//!   box `<app>/submit`, and `await`ing that message — or, for a resubmission while
//!   the first one is with the chain app, after `await`ing that submission's
//!   thread (the overlay's `pending` record names it: the engine answers a
//!   resubmission with nothing);
//! - called again with `reply`, the engine's first answer to the message
//!   (`admitted`, `proven` or `rejected`, or an error): `{verdict: "accept",
//!   body: <reply>}` (messages.zig `answerFromSubmit`); or with `resolved`,
//!   the awaited thread at rest: read from the state (`answerFromState`). The
//!   front door writes that body back on the stream as the frame's answer
//!   ("Streams": "the frame's answer is written back when the request's
//!   thread comes to rest"). Later answers (each proof) find nothing
//!   awaiting them.
//!
//! **Local** (0.4.0): when a taker names this node as the validator to its own relay, amm-p2p
//! cannot dial itself; its relay thread calls this program's fn in-VM, from its step, with the
//! argument the front door gives a frame's handler (`transport: "local"`, `protocol`, `body`: the
//! same package, `match`, and `reply` / `resolved` when called again). Everything else is as above:
//! the `{wait: true}` and its `await` are the relay thread's.
//!
//! The validator role (0.6.0, shruggr/skein#120, David 2026-10-06 evening; 0.8.1, skein-overlay
//! 0.12.0, David 2026-10-09: "every skein is marketplace AND validator from install, always" — the
//! owner's switch of 0.6.2 is gone): a swap is signed, or a pool affirmed, only when the token's
//! topic `tm_color_<txid>_0` is in the engine's registered set (the head `<app>/topics`, written by the
//! owner's `register` / `deregister`); else refused `not_validating`. "The validator program signs
//! for any registered token." (0.3.2–0.5.0: amm-p2p's validated set,
//! `validate` / `unvalidate` in box `amm/validate`; gone.)
//!
//! The terms (0.15.0, David Case 2026-10-23: "The configs should not be published in the image.
//! This will be a dynamic, competitive marketplace."): root's message `{fn: "terms", args:
//! {lpFeeBps, validatorFeeBps, commissionBps}}` in the box `amm/validator` sets them, `{fn: "terms",
//! args: null}` clears them (the role `root` gates `terms`); the record is the head `<app>/terms`
//! (src/terms.zig), and the step sends the instance itself `{fn: "rebeat"}` in box `<app>` so the
//! engine re-declares every topic's beacon with them (skein-overlay 0.16.0). Set: a validator;
//! unset: a market only — an affirm and a swap are refused `not_validating`, "no terms: this skein
//! validates nothing" (`config.amm.ammValidator`, 0.9.0 to 0.14.2, is gone; no fallback).
//!
//! Config: the overlay's own configuration as the engine reads it
//! from the app record (skein-overlay `engine_vm.configured`: the served
//! topics, the ones registered with the engine (`<app>/topics`) among them, the app's roles,
//! `app`; the submission goes to the box `<app>/submit`).
const std = @import("std");
const w = @import("chain");
const ov = @import("skein_overlay");
const vm = @import("overlay_sk");
const wire = @import("wallet").wire;
const validator = @import("validator.zig");
const messages = @import("messages.zig");
const submit = @import("submit.zig");
const view_mod = @import("view.zig");
const launch = @import("launch.zig");
const rescind = @import("rescind.zig");
const lock = @import("lock.zig");
const Oracle = @import("oracle.zig").Oracle;
const terms = @import("terms");

const cbor = w.cbor;
const Value = cbor.Value;

pub const program_name = "amm-validator";

const imports = struct {
    extern "skein" fn wallet(frame: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
};

var oracle_dummy: u8 = 0;
fn oracleCall(_: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8 {
    const res = try vm.result(a, imports.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
    if (wire.errorMessage(res)) |m| std.log.err("signer: {s}", .{m});
    return res;
}

/// The validator's terms now (0.15.0, David Case 2026-10-23: a runtime record root sets; no fee
/// numbers in the image): the record of the head `<app>/terms` (src/terms.zig), or null — no head,
/// the record `null` (cleared): a market only, nothing affirmed or signed. No fallback.
///
/// (0.17.0, shruggr/skein-amm#4) No head yet: the app record's `config.overlay.terms`, the initial
/// value a token instance's create gives (src/terms.zig `current`; the engine's beat reads the same).
fn termsNow(a: std.mem.Allocator, in: Value) !?validator.Terms {
    const app = ov.calls.appOf(in);
    const s = vm.store();
    const head: ?Value = if (try vm.head(a, try terms.headName(a, app))) |rc| try s.getValue(a, rc) else null;
    const rec: ?Value = if (try vm.head(a, try std.fmt.allocPrint(a, "{s}/app", .{app}))) |rc| try s.getValue(a, rc) else null;
    return terms.current(head, rec);
}

/// The topics this instance signs for (0.6.0, shruggr/skein#120; 0.8.1, David 2026-10-09: every
/// skein is a validator, always): every topic the engine serves — the ones registered with it (the
/// head `<app>/topics`) and (0.17.0, shruggr/skein-amm#4: a token instance's topic comes from its
/// config at birth) the ones `config.overlay.topics` names; any other refused `not_validating`.
fn validatedSet(a: std.mem.Allocator, in: Value) ![]const []const u8 {
    return ov.calls.servedTopics(a, in);
}

/// The app's overlay state (`<app>/state`) over the chain app's (`chain/state`), as the step sees them.
fn overlayState(a: std.mem.Allocator, in: Value) !*ov.state.State {
    const st = try a.create(ov.state.State);
    st.* = (try ov.engine_vm.load(a, in)).st;
    st.now = @intCast(in.getUint("now") orelse 0);
    return st;
}

fn identityOf(a: std.mem.Allocator, in: Value, oracle: Oracle) ![33]u8 {
    const k = (if (in.get("self")) |me| me.getBytes("identity") else null) orelse return oracle.identity(a);
    return if (k.len == 33) k[0..33].* else error.BadInput;
}

fn run(a: std.mem.Allocator) anyerror!void {
    const raw_in = try vm.input(a);
    // A step: root's message in the box `<app>/validator` — the terms (0.15.0), answered at once,
    // or the Rescind (0.13.0) — and the Rescind thread's later steps (the wallet threads it
    // launched at rest, the engine's answer).
    if (!std.mem.eql(u8, raw_in.getText("kind") orelse "", "call")) {
        // 0.17.0: this program's own answer to root, looped back when root is the instance's own key
        // (a one-key host, shruggr/skein#160): an answer (it names its `request`), not a request.
        if (try isOwnAnswer(a, raw_in)) return finishAnswer(a);
        if (try isTermsMessage(a, raw_in)) return termsStep(a, raw_in);
        return rescindStep(a, raw_in);
    }
    const op = validator.Op.parse(raw_in.getText("fn") orelse "") orelse return error.UnknownFunction;
    const arg = try vm.callArg(a, raw_in);
    // The configuration as the engine reads it: the app this program was installed in (the
    // matched row's program record names it), its `config.overlay`, its roles.
    const in = try ov.engine_vm.configured(a, raw_in, arg);
    // 0.43.0: the thread this call's step is (the front door's request thread, or the local relay's):
    // what a request waiting on a pool's lock awaits (lock.zig).
    const me = (raw_in.get("step") orelse return error.BadInput).getCid("thread") orelse return error.BadInput;
    return directCall(a, in, arg, op, me);
}

/// Launch the genesis wallet program on `body` (launch.zig `launchArgs`): a thread of its own,
/// which this step's thread is then waiting on beside whatever it awaits.
fn launchWallet(a: std.mem.Allocator, raw_in: Value, body: Value) !void {
    const prog = launch.walletProgram(raw_in) orelse return error.NoWalletProgram;
    _ = try vm.launch(a, prog, try launch.launchArgs(a, vm.store(), body));
}

fn answerBody(a: std.mem.Allocator, r: validator.Reply) !void {
    try vm.answer(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "verdict", .value = .{ .text = "accept" } },
        .{ .key = "body", .value = .{ .bytes = try cbor.encode(a, try messages.replyValue(a, r)) } },
    }) });
}

fn answerWait(a: std.mem.Allocator) !void {
    try vm.answer(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "wait", .value = .{ .boolean = true } }}) });
}

// ---------------------------------------------------------------- the pool locks (0.43.0)

fn awaitThread(_: *anyopaque, thread: []const u8) bool {
    vm.awaitRecord(thread) catch return false; // at rest: its state is there to read
    return true;
}

const threads: lock.Threads = .{ .ptr = &oracle_dummy, .awaitFn = awaitThread };

fn loadLocks(a: std.mem.Allocator, app: []const u8) !lock.Locks {
    const s = vm.store();
    const rec: ?Value = if (try vm.head(a, try lock.headName(a, app))) |rc| try s.getValue(a, rc) else null;
    return lock.Locks.parse(a, rec);
}

fn saveLocks(a: std.mem.Allocator, app: []const u8, locks: lock.Locks) !void {
    const rc = try vm.store().putValue(a, try locks.value(a));
    try vm.advance(try lock.headName(a, app), rc);
}

/// fn `swap`, `affirm`: a frame of a direct call, or amm-p2p's local call (above). `me`: this step's thread.
fn directCall(a: std.mem.Allocator, in: Value, arg: Value, op: validator.Op, me: []const u8) !void {
    // A frame on a direct call (the front door's), or (0.4.0) the same package handed in-VM by this
    // instance's own relay when the validator the caller named is this node (amm-p2p `callValidator`).
    const transport = arg.getText("transport") orelse "";
    if (!std.mem.eql(u8, transport, "libp2p") and !std.mem.eql(u8, transport, "local")) return error.NotADirectCall;
    const oracle: Oracle = .{ .ptr = &oracle_dummy, .callFn = oracleCall };
    const identity = try identityOf(a, in, oracle);
    const body = switch (try messages.open(a, arg.getBytes("body") orelse "", identity, op)) {
        .refused => |r| return answerBody(a, r),
        .ok => |o| o.body,
    };

    const st = try overlayState(a, in);
    const ovv = try a.create(view_mod.OverlayView);
    ovv.* = .{ .st = st };

    const app = ov.calls.appOf(in);
    // Called again (#66): the engine's answer to the submission this frame awaited. 0.43.0: the
    // pool's lock this thread holds is released (its queue is stepped when this thread comes to rest).
    if (arg.get("reply")) |r| if (r == .map) {
        const ans = try vm.store().getValue(a, r.getCid("body") orelse return error.BadInput);
        var locks = try loadLocks(a, app);
        if (locks.release(me)) try saveLocks(a, app, locks);
        return answerBody(a, try messages.answerFromSubmit(a, st, ovv.view(), op, body, ans));
    };
    // 0.43.0: a swap waits while its pool is locked (lock.zig): a fresh request, or one waiting in a
    // lock's queue stepped again.
    var locks = try loadLocks(a, app);
    const before = try cbor.encode(a, try locks.value(a));
    const resolved = arg.get("resolved") != null;
    const queued = op == .swap and locks.waitingIn(me) != null;
    // Called again (#66): the submission's thread this frame waited on (a resubmission's) has come
    // to rest.
    if (resolved and !queued) return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));
    const now: i64 = if (in.getUint("now")) |n| @intCast(n) else 0;
    const served = (try messages.respondLocked(a, op, body, .{
        .config = .{ .identity = identity, .terms = try termsNow(a, in), .now_ms = now, .validated = try validatedSet(a, in) },
        .view = ovv.view(),
        .oracle = oracle,
        .st = st,
    }, &locks, me, threads)) orelse {
        try saveLocks(a, app, locks);
        return answerWait(a);
    };
    if (!std.mem.eql(u8, before, try cbor.encode(a, try locks.value(a)))) try saveLocks(a, app, locks);
    switch (served.next) {
        .answer => return answerBody(a, served.reply),
        .from_state => return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body)),
        .submit => |sub| {
            // A submission is a message (skein-overlay 0.7.2+): to this instance, in the submissions
            // box `<app>/submit`, which the row `submit` from `*` takes to the engine (0.7.5, #128). The engine hands the BEEF to the chain
            // app, which registers and broadcasts every unproven transaction in it, the taker's nosend
            // funding parent with the swap (shruggr/skein-chain docs/CHAIN.md "Ingest a BEEF";
            // `served.broadcast` names them), and answers this message when it is admitted or rejected.
            const m = try vm.send(a, &identity, try submit.box(a, ov.calls.appOf(in)), try submit.body(a, sub.beef, sub.topic));
            try vm.awaitRecord(m);
            return answerWait(a);
        },
        .wait_on => |txid| {
            // Resubmitted while the first submission's thread awaits the chain app: wait on that thread.
            const rec = (try st.pendingRecord(txid)) orelse return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));
            const thread = rec.getCid("thread") orelse return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));
            vm.awaitRecord(thread) catch return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body)); // at rest already
            return answerWait(a);
        },
    }
}

// ---------------------------------------------------------------- the terms (0.15.0)

/// Whether the step is a message that answers a request (`{fn, request, result | error}`: this
/// program's answer to root, delivered back when root's key is the instance's own) — its first step.
fn isOwnAnswer(a: std.mem.Allocator, raw_in: Value) !bool {
    if (raw_in.get("reply") != null or raw_in.get("resolved") != null) return false;
    const args = raw_in.get("args") orelse return false;
    const bc = args.getCid("body") orelse return false;
    const body = try vm.store().getValue(a, bc);
    return body.get("request") != null or body.get("replyTo") != null;
}

/// An answer delivered back: nothing to do; the thread ends.
fn finishAnswer(a: std.mem.Allocator) !void {
    _ = try vm.finish(a, vm.store(), .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = "amm-answer" } },
        .{ .key = "stage", .value = .{ .text = "ignored" } },
    }) });
}

/// Whether the step is root's message `{fn: "terms", …}` (its first step: no reply, nothing resolved).
fn isTermsMessage(a: std.mem.Allocator, raw_in: Value) !bool {
    if (raw_in.get("reply") != null or raw_in.get("resolved") != null) return false;
    const args = raw_in.get("args") orelse return false;
    const bc = args.getCid("body") orelse return false;
    return std.mem.eql(u8, (try vm.store().getValue(a, bc)).getText("fn") orelse "", terms.fn_terms);
}

/// Root's `{fn: "terms", args}` (the role `root` gates it; src/terms.zig): set (`args` the three
/// fees) or clear (`args: null`) the record under `<app>/terms`, tell the engine (`{fn: "rebeat"}`
/// to the instance itself in box `<app>`: it re-declares every topic's beacon with the terms, or
/// none), and answer `{fn: "terms", request, result: <the terms> | null}` — or `error: {code:
/// "bad-args", message}`, nothing written — to the sender in the box it wrote to.
fn termsStep(a: std.mem.Allocator, raw_in: Value) !void {
    const args = raw_in.get("args") orelse return error.BadInput;
    const in = try ov.engine_vm.configured(a, raw_in, null);
    const s = vm.store();
    const body = try s.getValue(a, args.getCid("body") orelse return error.BadInput);
    const rec: Value = switch (terms.parseArgs(body.get("args"))) {
        .bad => |why| return rootAnswer(a, args, terms.fn_terms, "error", .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "code", .value = .{ .text = "bad-args" } },
            .{ .key = "message", .value = .{ .text = why } },
        }) }, "amm-terms"),
        .set => |t| try terms.record(a, t),
        .clear => .null,
    };
    const app = ov.calls.appOf(in);
    const rc = try s.putValue(a, rec);
    try vm.advance(try terms.headName(a, app), rc);
    const oracle: Oracle = .{ .ptr = &oracle_dummy, .callFn = oracleCall };
    const identity = try identityOf(a, in, oracle);
    _ = try vm.send(a, &identity, app, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "fn", .value = .{ .text = "rebeat" } }}) });
    return rootAnswer(a, args, terms.fn_terms, "result", rec, "amm-terms");
}

/// Answer root's message: `{fn, request: <the message>, <field>: v}` to its sender, in the box it
/// wrote to; then the thread ends, its result record `{kind, stage: "answered", answer}`.
fn rootAnswer(a: std.mem.Allocator, args: Value, func: []const u8, field: []const u8, v: Value, kind: []const u8) !void {
    const answer: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = if (args.getCid("message")) |m| .{ .cid = m } else .null },
        .{ .key = field, .value = v },
    }) };
    if (args.getBytes("sender")) |sender| if (args.getText("box")) |box| {
        _ = vm.send(a, sender, box, answer) catch |e| std.log.err("{s}: the answer is not sent: {s}", .{ func, @errorName(e) });
    };
    _ = try vm.finish(a, vm.store(), .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = kind } },
        .{ .key = "stage", .value = .{ .text = "answered" } },
        .{ .key = "answer", .value = answer },
    }) });
}

// ---------------------------------------------------------------- the Rescind (0.13.0)

fn resultRecord(a: std.mem.Allocator, stage: []const u8, fields: []const cbor.Entry) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-rescind" } },
        .{ .key = "stage", .value = .{ .text = stage } },
    });
    try es.appendSlice(a, fields);
    return .{ .map = es.items };
}

/// Answer root's message: `{fn: "rescind", request: <the message>, result | error}` to its sender,
/// in the box it wrote to; then the thread ends.
fn rescindAnswer(a: std.mem.Allocator, args: Value, field: []const u8, v: Value) !void {
    const answer: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = "rescind" } },
        .{ .key = "request", .value = if (args.getCid("message")) |m| .{ .cid = m } else .null },
        .{ .key = field, .value = v },
    }) };
    if (args.getBytes("sender")) |sender| if (args.getText("box")) |box| {
        _ = vm.send(a, sender, box, answer) catch |e| std.log.err("rescind: the answer is not sent: {s}", .{@errorName(e)});
    };
    _ = try vm.finish(a, vm.store(), try resultRecord(a, "answered", &.{.{ .key = "answer", .value = answer }}));
}

fn rescindError(a: std.mem.Allocator, args: Value, why: []const u8) !void {
    return rescindAnswer(a, args, "error", .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "code", .value = .{ .text = "refused" } },
        .{ .key = "message", .value = .{ .text = why } },
    }) });
}

/// One step of a Rescind's thread (rescind.zig): root's message `{fn: "rescind", args: {pool:
/// "<txid>.<vout>"}}` launches the wallet's createAction (the pool a caller input, the contract's
/// one output); its draft at rest, the pool input's call is written over it and signed by the
/// pool's validator key, and the wallet's signAction launched; signed, the Rescind is submitted to
/// this overlay by message; the engine's answer is root's answer.
fn rescindStep(a: std.mem.Allocator, raw_in: Value) !void {
    const args = raw_in.get("args") orelse return error.BadInput;
    const in = try ov.engine_vm.configured(a, raw_in, null);
    const oracle: Oracle = .{ .ptr = &oracle_dummy, .callFn = oracleCall };
    const identity = try identityOf(a, in, oracle);
    const s = vm.store();

    // The engine's answer to the submission: root's answer.
    if (raw_in.get("reply")) |r| if (r == .map) {
        const ans = try s.getValue(a, r.getCid("body") orelse return error.BadInput);
        if (ans.get("error")) |e| return rescindError(a, args, e.getText("message") orelse "the overlay refused the Rescind");
        return rescindAnswer(a, args, "result", ans.get("result") orelse .null);
    };
    // A wallet thread at rest: the draft, or the signed Rescind.
    if (raw_in.get("resolved")) |rs| {
        const items = if (rs == .array) rs.array else return error.BadInput;
        if (items.len == 0) return error.BadInput;
        const res = items[items.len - 1];
        if (!std.mem.eql(u8, res.getText("state") orelse "", "finished")) return rescindError(a, args, "the wallet errored");
        const rc = (try rescind.resultCid(a, res.get("result") orelse .null)) orelse return rescindError(a, args, "the wallet answered nothing");
        switch (rescind.stageOf(try s.getValue(a, rc))) {
            .failed => |why| return rescindError(a, args, why),
            .draft => |d| {
                const l = (try rescind.locate(a, identity, d.tx)) orelse return rescindError(a, args, "the draft spends no pool of ours");
                const st = try overlayState(a, in);
                const ovv = try a.create(view_mod.OverlayView);
                ovv.* = .{ .st = st };
                const key_id = (try rescind.keyIdOf(a, ovv.view(), l)) orelse return rescindError(a, args, "the pool's current validator key is not ours to name");
                const u = rescind.unlockRescind(a, l, key_id, oracle) catch |e| return rescindError(a, args, @errorName(e));
                try launchWallet(a, raw_in, try rescind.signBody(a, d.reference, l.index, u));
                _ = try vm.finish(a, s, try resultRecord(a, "signing", &.{}));
                return;
            },
            .signed => |tx| {
                const l = (try rescind.locate(a, identity, tx)) orelse return rescindError(a, args, "the Rescind spends no pool of ours");
                // 0.29.5: the same rule as a swap's submission — the pool's transaction with its
                // ancestry back to proven ones is in the BEEF (the door verifies with nothing known).
                const st = try overlayState(a, in);
                const pool_beef = ov.state.beefFor(st.ch, l.op.txid) catch return rescindError(a, args, "the chain state has no BEEF of the pool's transaction");
                const full = submit.withPool(a, tx, pool_beef) catch |e| return rescindError(a, args, @errorName(e));
                const m = try vm.send(a, &identity, try submit.box(a, ov.calls.appOf(in)), try submit.body(a, full, try rescind.topicOf(a, l.pool)));
                try vm.awaitRecord(m);
                _ = try vm.finish(a, s, try resultRecord(a, "submitted", &.{}));
                return;
            },
        }
    }
    // Root's message.
    const bc = args.getCid("body") orelse return error.BadInput;
    const body = try s.getValue(a, bc);
    if (!std.mem.eql(u8, body.getText("fn") orelse "", "rescind")) return rescindError(a, args, "want {fn: \"rescind\", args: {pool: \"<txid>.<vout>\"}}");
    const text = (body.get("args") orelse return rescindError(a, args, "want args {pool}")).getText("pool") orelse return rescindError(a, args, "want args {pool}");
    const norm = try a.dupe(u8, text);
    if (std.mem.indexOfScalar(u8, norm, '.')) |i| norm[i] = '_';
    const op = view_mod.Outpoint.parse(norm) orelse return rescindError(a, args, "pool: <txid>.<vout>");
    const st = try overlayState(a, in);
    const ovv = try a.create(view_mod.OverlayView);
    ovv.* = .{ .st = st };
    const t = switch (try rescind.targetOf(a, ovv.view(), identity, op)) {
        .refused => |why| return rescindError(a, args, why),
        .ok => |t| t,
    };
    const input_beef = (try st.ch.beefOf(t.op.txid)) orelse return rescindError(a, args, "the chain state has no BEEF of the pool's transaction");
    try launchWallet(a, raw_in, try rescind.createBody(a, t, input_beef));
    _ = try vm.finish(a, s, try resultRecord(a, "drafting", &.{}));
}

pub fn main() u8 {
    return vm.main(program_name, run);
}
