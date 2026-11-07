//! Views over the chain state (the chain app's `chain/state`, skein-sdk
//! `chain.state.State`, read only) and the app's overlay state
//! (`<app>/state`, skein-overlay's `State`: which topic admitted what) for the
//! proofs-by-block direct call (0.44.1: the catch-up pass gone): no VM imports, so the tests run
//! them over an in-memory store.
const std = @import("std");
const w = @import("chain");
const ov = @import("skein_overlay");
const proofs = @import("proofs.zig");

const State = ov.state.State;
const Allocator = std.mem.Allocator;

fn stOf(ctx: *anyopaque) *State {
    return @ptrCast(@alignCast(ctx));
}

const fns = struct {
    fn heightOf(ctx: *anyopaque, hash: [32]u8) anyerror!?u32 {
        return stOf(ctx).ch.chain().heightOf(hash);
    }
    fn inTopic(ctx: *anyopaque, topic: []const u8, txid: [32]u8) anyerror!bool {
        return stOf(ctx).isApplied(topic, txid);
    }
    fn provenAt(ctx: *anyopaque, a: Allocator, height: u32) anyerror![]const [32]u8 {
        const kvs = try stOf(ctx).ch.map("proofHeights").prefixed(&w.store.be32(height));
        const out = try a.alloc([32]u8, kvs.len);
        for (kvs, out) |kv, *o| o.* = kv.key[4..36].*;
        return out;
    }
    fn proofFor(ctx: *anyopaque, _: Allocator, txid: [32]u8) anyerror!?w.merkle.MerklePath {
        return stOf(ctx).ch.proofFor(txid);
    }
};

pub fn held(st: *State) proofs.Held {
    return .{ .ctx = st, .heightOfFn = fns.heightOf, .provenAtFn = fns.provenAt, .inTopicFn = fns.inTopic, .proofForFn = fns.proofFor };
}
