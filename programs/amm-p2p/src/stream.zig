//! The direct call's shapes as `proofsByBlock` sees them (skein docs/MESSAGES.md "libp2p (#51)"): an
//! inbound frame handed to a handler, its one-frame answer, and this instance's peer ID. 0.44.0: the
//! swap relay that dialled the validator is gone (the host carries a swap: open-exchange
//! `POST /@<tokenId>/amm/swap`); 0.44.1: the catch-up pass and the libp2p provider's bodies it sent
//! (`dial`, `send`, `close`) are gone.
//!
//! The instance's own peer ID: main.zig `selfPeerId` (the signer's key, `peerIdOf`).
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const base58 = w.bsvz.primitives.base58;

/// An inbound topic message or direct-call frame (a handler's call argument).
pub const Inbound = struct {
    topic: ?[]const u8 = null,
    protocol: ?[]const u8 = null,
    /// The sender's peer ID (multihash bytes): the publisher, or the remote peer of a direct call.
    from: []const u8,
    body: []const u8,
};

/// The protocol the instance's keys are derived under (skein src/host/signer.ts `INSTANCE_PROTOCOL`).
pub const instance_protocol = .{ .level = 2, .name = "skein instance" };

/// The peer ID of a compressed secp256k1 key, as js-libp2p makes it: the identity multihash
/// (0x00, length 0x25) of the protobuf PublicKey {1: KeyType = 2 (secp256k1), 2: the 33 bytes}.
pub fn peerIdOf(a: Allocator, key: [33]u8) ![]const u8 {
    return std.mem.concat(a, u8, &.{ &.{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 }, &key });
}

/// A peer ID as text: base58btc (what `amm.pool.terms` answers as `peerId`).
pub fn peerIdText(a: Allocator, id: []const u8) ![]const u8 {
    return base58.encode(a, id);
}

/// A handler's call argument as an inbound message.
pub fn inbound(arg: Value) !Inbound {
    if (!std.mem.eql(u8, arg.getText("transport") orelse "", "libp2p")) return error.NotLibp2p;
    return .{
        .topic = arg.getText("topic"),
        .protocol = arg.getText("protocol"),
        .from = arg.getBytes("from") orelse return error.BadInbound,
        .body = arg.getBytes("body") orelse return error.BadInbound,
    };
}

/// A direct-call handler's answer: `body` written back as one frame.
pub fn directAnswer(a: Allocator, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "verdict", .value = .{ .text = "accept" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}
