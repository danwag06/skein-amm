//! The direct call's shapes as the catch-up pass and `proofsByBlock` see them (skein docs/MESSAGES.md
//! "libp2p (#51)" and "The providers"): the catch-up's proofs-by-block request through the libp2p
//! provider (`dial`, then `send` and `close` on the stream, the answers answering the dial), and an
//! inbound frame handed to a handler. 0.44.0: the swap relay that dialled the validator is gone
//! (the host carries a swap: open-exchange `POST /@<tokenId>/amm/swap`), and with it the topic
//! verdicts and `publish` nothing here used (was libp2p.zig).
//!
//!   box dial     {peer, protocol}   → {stream}; then each frame read, in box `frame`: {stream, body},
//!                                     and its end {stream, closed: true, error?} — all answering the dial
//!   box send     {stream, body}     → {}
//!   box close    {stream}           → {}
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

/// A peer ID as `dial` takes it: base58btc text.
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

// ---------------------------------------------------------------- outbound: the provider's bodies

/// A body for the provider: its box and the map emitted there.
pub const Request = struct { box: []const u8, body: Value };

/// `peer`: a base58 peer ID or a multiaddr with /p2p/<id>.
pub fn dial(a: Allocator, peer: []const u8, protocol: []const u8) !Request {
    return .{ .box = "dial", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "peer", .value = .{ .text = peer } },
        .{ .key = "protocol", .value = .{ .text = protocol } },
    }) } };
}

pub fn send(a: Allocator, stream: u64, body: []const u8) !Request {
    return .{ .box = "send", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "stream", .value = .{ .uint = stream } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) } };
}

pub fn close(a: Allocator, stream: u64) !Request {
    return .{ .box = "close", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "stream", .value = .{ .uint = stream } },
    }) } };
}

/// What the provider answered a dial with (the reply's box and body).
pub const DialAnswer = union(enum) {
    /// The direct call is open (box `dial`).
    opened: u64,
    /// A frame read from it (box `frame`).
    frame: []const u8,
    /// It ended (box `frame`, `closed`), or the dial failed (`error`).
    closed: []const u8,
};

pub fn dialAnswer(box: []const u8, body: Value) !DialAnswer {
    if (body.getText("error")) |e| return .{ .closed = e };
    if (std.mem.eql(u8, box, "frame")) {
        if (body.getBytes("body")) |b| return .{ .frame = b };
        if (body.get("closed") != null) return .{ .closed = "Closed" };
        return error.BadAnswer;
    }
    if (std.mem.eql(u8, box, "dial")) return .{ .opened = body.getUint("stream") orelse return error.BadAnswer };
    return error.BadAnswer;
}
