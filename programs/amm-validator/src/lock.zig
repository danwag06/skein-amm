//! One swap in flight per pool (0.43.0, agent-env plans/pool-lock-build-2026-11-06.md D3; David
//! Case 2026-11-06: "That seems the logical approach to me"). On ovh two swaps on one NANNER pool
//! were signed seconds apart, both submitted before the chain app held either, both held, neither
//! applied (plans/double-spender-audit-2026-11-06.md). The validator now signs one spend of a pool
//! at a time.
//!
//! **The lock.** When `spend` signs and the signed transaction goes to this instance's overlay
//! (messages.zig `Next.submit`), its pool is locked in the same step: the record names the pool
//! output the transaction spends (the key), its txid, the thread of the step that signed (the
//! direct call's request thread, or the local relay's thread: what a waiter awaits) and the
//! request's hash (sha256 of the transaction as sent, the validator's slot empty). The lock is
//! released in that thread's step that takes the submission's answer (admitted or rejected), and
//! a lock whose thread has come to rest without one (its own bound: the local relay's deadline)
//! holds nothing: awaiting a thread at rest is refused (skein docs/VM.md, "Waiting on a thread"),
//! which is how a lock is found stale.
//!
//! **A request for a locked pool** — whatever output of the pool it names: the lineage is walked
//! forward from it, spender to spender (`validator.newest`'s walk), to the output the lock is
//! keyed at — is not refused and not signed: it awaits the holder's thread (answer `{wait:
//! true}`) and joins the lock's queue. Stepped again when that thread comes to rest (`resolved`),
//! it runs the same check again (`gate`, then `spend`): the transaction admitted → the pool is
//! spent, the existing `pool_spent` answer with the new state; rejected → the first of the queue
//! is checked and signed and takes the lock, the rest wait on it. Locks are per pool.
//!
//! **Order.** The kernel steps the threads awaiting one thread in the order of its `awaits` map:
//! the awaiting thread's origin `at` (its request's stamp, in ms), then the origin's CID — arrival
//! order to the millisecond, not within one. So the queue keeps arrival order itself: a waiter
//! stepped while an earlier waiter of the queue still waits awaits that one instead.
//!
//! The record, the root of the head `<app>/locks`:
//!
//!   {kind: "amm-pool-locks", locks: [{pool: "<txid>_<vout>", txid?: "<hex>", thread?: <cid>,
//!     request?: bytes(32), waiters: [<cid>]}]}
//!
//! `txid`, `thread`, `request` together (the holder), or none (a queue whose holder came to rest).
const std = @import("std");
const w = @import("chain");
const validator = @import("validator.zig");
const view_mod = @import("view.zig");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const Outpoint = view_mod.Outpoint;
const View = view_mod.View;
const eql = std.mem.eql;

pub const record_kind = "amm-pool-locks";

/// The head the record is under: `<app>/locks`.
pub fn headName(a: Allocator, app: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "{s}/locks", .{app});
}

/// The hash a request is known by: sha256 of its transaction as sent (the validator's slot empty).
pub fn requestHash(raw: []const u8) [32]u8 {
    var h: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &h, .{});
    return h;
}

/// The holder: the transaction in flight, and what a waiter awaits.
pub const Holder = struct {
    txid: [32]u8,
    /// The origin CID of the thread whose step signed it.
    thread: []const u8,
    request: [32]u8,
};

pub const Entry = struct {
    /// The pool output the transaction in flight spends.
    pool: Outpoint,
    holder: ?Holder = null,
    /// The threads waiting, in arrival order.
    waiters: std.ArrayList([]const u8) = .empty,
};

/// Whether `t` may be awaited now (`true`: awaited by this step from now on), or is at rest
/// (`false`): main.zig `vm.awaitRecord`; the tests, memory.
pub const Threads = struct {
    ptr: *anyopaque,
    awaitFn: *const fn (ptr: *anyopaque, thread: []const u8) bool,

    pub fn wait(self: Threads, thread: []const u8) bool {
        return self.awaitFn(self.ptr, thread);
    }
};

pub const Locks = struct {
    entries: std.ArrayList(Entry) = .empty,

    /// The record (or no head: none).
    pub fn parse(a: Allocator, v: ?Value) !Locks {
        var out: Locks = .{};
        const rec = v orelse return out;
        const list = rec.getArray("locks") orelse return out;
        for (list) |x| {
            const op = Outpoint.parse(x.getText("pool") orelse continue) orelse continue;
            var e: Entry = .{ .pool = op };
            if (x.getText("txid")) |t| if (x.getCid("thread")) |th| if (x.getBytes("request")) |rq| if (rq.len == 32) {
                e.holder = .{ .txid = w.header.fromHex(t) catch continue, .thread = th, .request = rq[0..32].* };
            };
            if (x.getArray("waiters")) |ws| for (ws) |wv| if (wv == .cid) try e.waiters.append(a, wv.cid);
            try out.entries.append(a, e);
        }
        return out;
    }

    pub fn value(self: Locks, a: Allocator) !Value {
        const list = try a.alloc(Value, self.entries.items.len);
        for (self.entries.items, list) |e, *x| {
            var es: std.ArrayList(cbor.Entry) = .empty;
            try es.append(a, .{ .key = "pool", .value = .{ .text = try e.pool.format(a) } });
            if (e.holder) |h| {
                try es.append(a, .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(h.txid)) } });
                try es.append(a, .{ .key = "thread", .value = .{ .cid = h.thread } });
                try es.append(a, .{ .key = "request", .value = .{ .bytes = try a.dupe(u8, &h.request) } });
            }
            const ws = try a.alloc(Value, e.waiters.items.len);
            for (e.waiters.items, ws) |t, *y| y.* = .{ .cid = t };
            try es.append(a, .{ .key = "waiters", .value = .{ .array = ws } });
            x.* = .{ .map = es.items };
        }
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = record_kind } },
            .{ .key = "locks", .value = .{ .array = list } },
        }) };
    }

    fn at(self: *Locks, op: Outpoint) ?usize {
        for (self.entries.items, 0..) |e, i| if (e.pool.eql(op)) return i;
        return null;
    }

    /// The entry whose queue lists `thread`.
    pub fn waitingIn(self: *Locks, thread: []const u8) ?usize {
        for (self.entries.items, 0..) |e, i| for (e.waiters.items) |t| if (eql(u8, t, thread)) return i;
        return null;
    }

    /// The lock of the pool `from` is an output of: the lineage walked forward from `from`,
    /// spender to spender (each continuation its output 0, as `validator.newest` follows it), to
    /// the first output a lock is keyed at. Null: none (or `from` is no pool we hold).
    pub fn find(self: *Locks, a: Allocator, v: View, from: Outpoint) !?usize {
        if (self.entries.items.len == 0) return null;
        const src = (try v.output(a, from)) orelse return null;
        const id = validator.poolTokenId(src.script) orelse return null;
        const topic = try validator.topicOf(a, id);
        var cur = from;
        var steps: usize = 0;
        while (steps < 100_000) : (steps += 1) {
            if (self.at(cur)) |i| return i;
            const sp = (try v.spender(a, topic, cur)) orelse return null;
            const t = (try v.tx(a, sp)) orelse return null;
            if (t.outputs.len == 0 or validator.poolTokenId(t.outputs[0].locking_script.bytes) == null) return null;
            cur = .{ .txid = sp, .vout = 0 };
        }
        return null;
    }

    fn removeWaiter(e: *Entry, thread: []const u8) void {
        var i: usize = 0;
        while (i < e.waiters.items.len) {
            if (eql(u8, e.waiters.items[i], thread)) _ = e.waiters.orderedRemove(i) else i += 1;
        }
    }

    fn addWaiter(a: Allocator, e: *Entry, thread: []const u8) !void {
        for (e.waiters.items) |t| if (eql(u8, t, thread)) return;
        try e.waiters.append(a, try a.dupe(u8, thread));
    }

    fn dropIfEmpty(self: *Locks, i: usize) void {
        const e = self.entries.items[i];
        if (e.holder == null and e.waiters.items.len == 0) _ = self.entries.orderedRemove(i);
    }

    /// Whether the request in thread `me` (naming the pool output `pool`, its hash `h`) may be
    /// checked now (`proceed`), or waits (`wait`: this step awaits the holder, or the waiter of the
    /// queue ahead of it, and the record lists `me` in the queue). `resolved`: the step is the
    /// thread's again after what it awaited came to rest — a waiter is found by its place in a queue.
    pub fn gate(self: *Locks, a: Allocator, v: View, pool: Outpoint, h: [32]u8, me: []const u8, th: Threads) !Gate {
        const i = self.waitingIn(me) orelse (try self.find(a, v, pool)) orelse return .proceed;
        const e = &self.entries.items[i];
        if (e.holder) |hd| {
            // The request in flight itself, sent again (a retry): today's answer, not a waiter.
            if (eql(u8, &hd.request, &h)) {
                removeWaiter(e, me);
                return .proceed;
            }
            if (!eql(u8, hd.thread, me) and th.wait(hd.thread)) {
                try addWaiter(a, e, me);
                return .wait;
            }
            // Its thread at rest: the lock holds nothing.
            e.holder = null;
        }
        // The queue, in arrival order: a waiter ahead that still waits goes first; one at rest is gone.
        while (e.waiters.items.len > 0) {
            const t = e.waiters.items[0];
            if (eql(u8, t, me)) break;
            if (th.wait(t)) {
                try addWaiter(a, e, me);
                return .wait;
            }
            _ = e.waiters.orderedRemove(0);
        }
        removeWaiter(e, me);
        self.dropIfEmpty(i);
        return .proceed;
    }

    /// The step that signed and submits (`Next.submit`): the pool `pool` locked by thread `me`,
    /// the transaction `txid` in flight; the queue already there kept.
    pub fn take(self: *Locks, a: Allocator, pool: Outpoint, txid: [32]u8, h: [32]u8, me: []const u8) !void {
        if (self.waitingIn(me)) |i| {
            removeWaiter(&self.entries.items[i], me);
            self.dropIfEmpty(i);
        }
        const hd: Holder = .{ .txid = txid, .thread = try a.dupe(u8, me), .request = h };
        if (self.at(pool)) |i| {
            self.entries.items[i].holder = hd;
            return;
        }
        try self.entries.append(a, .{ .pool = pool, .holder = hd });
    }

    /// Thread `me` took its submission's answer: each lock it holds released (its queue kept, to be
    /// stepped when `me` comes to rest). Whether anything changed.
    pub fn release(self: *Locks, me: []const u8) bool {
        var changed = false;
        var i: usize = 0;
        while (i < self.entries.items.len) {
            const e = &self.entries.items[i];
            if (e.holder) |hd| if (eql(u8, hd.thread, me)) {
                e.holder = null;
                changed = true;
                if (e.waiters.items.len == 0) {
                    _ = self.entries.orderedRemove(i);
                    continue;
                }
            };
            i += 1;
        }
        return changed;
    }
};

pub const Gate = enum { proceed, wait };
