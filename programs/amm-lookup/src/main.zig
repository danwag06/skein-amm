//! amm-lookup: the AMM pool liquidity lookup service, served as `ls_amm_<assetId>` (skein-overlay's
//! lookup contract, the `lookup` module), over every 1Color token topic the
//! overlay serves. Its metadata and documentation answer the overlay's listing and
//! documentation routes (skein-overlay#2). See README.md.
const std = @import("std");
const idx = @import("index.zig");
const lookup = @import("lookup");
const vm = @import("overlay_sk");

pub const version = "0.1.0";

pub fn metadata(_: std.mem.Allocator, _: []const u8) anyerror!lookup.Metadata {
    return .{
        .short_description = "AMM pools (the Pool contract over 1Color tokens): the listed pools of a token (a self-attesting pool and its Swap continuations, unspent), one pool or its newest continuation, a validator's pools; its beat, the prices.",
        .version = version,
        .information_url = "https://github.com/shruggr/skein-amm",
    };
}

pub fn documentation(_: std.mem.Allocator, _: []const u8) anyerror![]const u8 {
    return
    \\# AMM pools (ls_amm_<assetId>)
    \\
    \\Served per token as `ls_amm_<assetId>`, paired with the token topic `tm_color_<assetId>`.
    \\
    \\The listed pools of the AMM's Pool contract, over every 1Color token topic this
    \\overlay serves (`tm_color_<txid>_<vout>`). A pool is a BRC-162 value output at output 0 whose
    \\lock is the compiled Pool code followed by its state, its prefix agreeing with the asset id and
    \\the TokenReserve its code and state carry. A pool is listed when it attests itself: its
    \\ValidatorPubKey is the ValidatorIdentity's child keyed by the Nonce in its state (derived by
    \\this lookup), and the Affirmation in its state is that key's signature of the pool's
    \\parameters. A Swap's continuation of a listed pool is listed when its ValidatorPubKey is the
    \\identity's child keyed by the spent pool outpoint. The LP's Close and the validator's Rescind
    \\(which clears the ValidatorPubKey) end the listing.
    \\
    \\Every query names its token, `tokenId` (`<txid>`, `<txid>_<vout>` or `<txid>.<vout>`,
    \\the deploy outpoint):
    \\
    \\- `{tokenId}`: every live pool of the token, as
    \\  `{lpPubKey, outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps,
    \\  commissionBps, validatorIdentityKey}` (freeform);
    \\- `{tokenId, outpoint}`: that pool, or its newest continuation,
    \\  `{current, hops}` (freeform); with `beef: true`, the pool output and its
    \\  transaction's BEEF (output-list);
    \\- `{tokenId, validatorIdentityKey}`: that validator's listed pools of the token;
    \\- `{tokenId, lpPubKeys: [hex]}`: per LpPubKey `{lpPubKey, sats, tokens, swaps, current}`, the LP
    \\  fees its pool's Swaps paid (sats on sats-in Swaps, tokens on token-in), `current` its live pool
    \\  or null;
    \\- `{tokenId, validatorIdentityKeys: [hex]}`: per identity `{validatorIdentityKey, sats, tokens,
    \\  swaps, pools}`, the validator fees over its live pools' Swaps;
    \\- `{tokenId, commissionPkhs: [hex]}`: per key hash `{commissionPkh, sats, tokens, swaps}`, the
    \\  commissions paid to it.
    \\
    \\The fees are rows written as each Swap is admitted (removed on a rejection), from this lookup's
    \\0.33.0 on: Swaps admitted before have none. An unknown key answers zeros.
    \\
    \\Its beat on `ls_amm_<assetId>-live` (dag-cbor): `{tokens: {<assetId>: {<validator identity>: {sats, tokens,
    \\pools}}}}`, this overlay's listed pools summed per token and validator: the prices.
    \\
    ;
}

pub fn main() u8 {
    stepTime();
    return lookup.main(idx.spec);
}

/// The step's time for the hooks (0.36.0, a trade row's `at`): the in-VM call input's `now`, the time
/// of the entry that drove the step (skein docs/VM.md, "call"; replay-exact). The input is read
/// again by `lookup.main`.
fn stepTime() void {
    var arena_state = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    defer arena_state.deinit();
    const in = vm.input(arena_state.allocator()) catch return;
    idx.now_ms = in.getUint("now") orelse 0;
}
