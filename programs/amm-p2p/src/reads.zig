//! The pages' reads (skein-amm 0.9.0, David Case 2026-10-09). Pure: over a store, the chain state
//! (main.zig wires the VM). (The holders' listing requests moved to the config app in 0.17.0
//! and were removed in 0.19.0.)
//!
//! - **Spends** (`/spends?outpoint=<txid>.<vout>`, filter `spends`): what the chain state says of
//!   an outpoint — the LP page follows its pool from the deploy's outpoint to the current pool
//!   output, or to the Close that ended it (the LP's or, 0.11.0, the validator's) (each spender's
//!   output 0 while it is a pool) — `{outpoint, spentBy?, current?, hops, closed}`. The chain
//!   app's `chain/state` (its `spent` map), read only, as the overlay reads it. 0.34.0: a list
//!   (`?outpoint=a,b`) answers one record per outpoint in query order (P8).
//!
//! **The public read API** (0.34.0, docs/AMM.md "The public read API"; David Case 2026-11-04,
//! D1/D7/D8): plain GETs, JSON unless the row says bytes, list parameters comma-separated, one
//! record per key in query order, cache headers per class (`state`: `public, max-age=5`; `imm`:
//! `public, max-age=31536000, immutable`, only for the bytes of a proven transaction). The pool
//! routes answer from the pool lookup's own answers (amm-lookup index.zig `answer`, the same code
//! over the same index, the head `amm/ls_amm`):
//!
//! - P3 `/pools/beef?pool=id1,id2` (0.40.0: by pool id, `<txid>_<vout>`; `?lp=` gone): `{pools:
//!   [<the lookup's PoolState rows>], beef: <base64 BEEF of their transactions>}`; no `pool`, every
//!   live pool;
//! - P4 `/positions?pool=`, P5 `/fees/validator?id=`, P6 `/fees/commission?pkh=`: the lookup's
//!   `{poolIds}`, `{validatorIdentityKeys}`, `{commissionPkhs}` answers as JSON;
//! - (0.40.0) `/pools/at?t=<ms>` and `/pools/history?from=&to=&pool=&limit=&after=`: the pool history
//!   (`historyRead`);
//! - P7 `/terms`: the validator's terms and the market's, in one (`termsJson`);
//! - P9 `/tx?id=`: a transaction's BEEF (`imm` when proven);
const std = @import("std");
const w = @import("chain");
const color = @import("1color");
const pool = @import("pool");
const lookup = @import("lookup");
const idx = @import("amm_lookup");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const Chain = w.state.State;
const Transaction = w.bsvz.transaction.Transaction;
const eql = std.mem.eql;

// ---------------------------------------------------------------- spends

pub const Outpoint = struct { txid: [32]u8, vout: u32 };

/// `<txid>.<vout>` or `<txid>_<vout>`.
pub fn parseOutpoint(text: []const u8) ?Outpoint {
    if (text.len < 66 or (text[64] != '.' and text[64] != '_')) return null;
    const txid = w.header.fromHex(text[0..64]) catch return null;
    const vout = std.fmt.parseInt(u32, text[65..], 10) catch return null;
    return .{ .txid = txid, .vout = vout };
}

/// A query string's `outpoint` value.
pub fn queryOutpoint(query: []const u8) ?Outpoint {
    var it = std.mem.splitScalar(u8, std.mem.trimStart(u8, query, "?"), '&');
    while (it.next()) |kv| {
        if (std.mem.startsWith(u8, kv, "outpoint=")) return parseOutpoint(kv["outpoint=".len..]);
    }
    return null;
}

/// A query string's parameter `name`, percent-decoded; null when absent.
pub fn queryParam(a: Allocator, query: []const u8, name: []const u8) !?[]const u8 {
    var it = std.mem.splitScalar(u8, std.mem.trimStart(u8, query, "?"), '&');
    while (it.next()) |kv| {
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        if (!eql(u8, kv[0..eq], name)) continue;
        return try percentDecode(a, kv[eq + 1 ..]);
    }
    return null;
}

fn percentDecode(a: Allocator, s: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '%' and i + 2 < s.len) {
            const b = std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch {
                try out.append(a, s[i]);
                continue;
            };
            try out.append(a, b);
            i += 2;
        } else try out.append(a, if (s[i] == '+') ' ' else s[i]);
    }
    return out.items;
}

/// A list parameter (D1: comma-separated values in one parameter, `?lp=02aa…,02bb…`): its values in
/// order, empty ones skipped; null when the parameter is absent.
pub fn queryList(a: Allocator, query: []const u8, name: []const u8) !?[]const []const u8 {
    const v = (try queryParam(a, query, name)) orelse return null;
    var out: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, v, ',');
    while (it.next()) |x| {
        const t = std.mem.trim(u8, x, " ");
        if (t.len > 0) try out.append(a, t);
    }
    return out.items;
}

pub const Spend = struct {
    outpoint: Outpoint,
    spent_by: ?[32]u8,
    /// Following pool spends: the current pool output (the outpoint itself when unspent).
    current: ?Outpoint,
    hops: u32,
    /// A pool spent by a transaction that did not continue it (Close).
    closed: bool,
};

fn isPool(script: []const u8) bool {
    const tok = color.brc162.decode(script) orelse return false;
    if (tok.role != .value) return false;
    return (pool.parse(tok.lock) catch null) != null;
}

/// What the chain state says of `op`: its spender, and (when `op` is a pool output) the pool's
/// current output, followed spender to spender while each spender's output 0 is a pool.
pub fn spendOf(a: Allocator, ch: *Chain, op: Outpoint) !Spend {
    var out: Spend = .{ .outpoint = op, .spent_by = try ch.spentBy(op.txid, op.vout), .current = null, .hops = 0, .closed = false };
    const raw = (try ch.txRaw(op.txid)) orelse return out;
    const t = Transaction.parse(a, raw) catch return out;
    if (op.vout >= t.outputs.len or !isPool(t.outputs[op.vout].locking_script.bytes)) return out;
    var cur = op;
    var steps: u32 = 0;
    while (steps < 100_000) : (steps += 1) {
        const sp = (try ch.spentBy(cur.txid, cur.vout)) orelse {
            out.current = cur;
            return out;
        };
        const sraw = (try ch.txRaw(sp)) orelse return out;
        const st = Transaction.parse(a, sraw) catch return out;
        if (st.outputs.len == 0 or !isPool(st.outputs[0].locking_script.bytes)) {
            out.closed = true;
            return out;
        }
        cur = .{ .txid = sp, .vout = 0 };
        out.hops += 1;
    }
    return out;
}

/// The `/spends` answer's JSON: `{outpoint, spentBy?, current?, hops, closed}`, outpoints `<txid>.<vout>`.
pub fn spendJson(a: Allocator, s: Spend) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("outpoint");
    try jw.write(try std.fmt.allocPrint(a, "{s}.{d}", .{ &w.header.toHex(s.outpoint.txid), s.outpoint.vout }));
    if (s.spent_by) |sb| {
        try jw.objectField("spentBy");
        try jw.write(&w.header.toHex(sb));
    }
    if (s.current) |c| {
        try jw.objectField("current");
        try jw.write(try std.fmt.allocPrint(a, "{s}.{d}", .{ &w.header.toHex(c.txid), c.vout }));
    }
    try jw.objectField("hops");
    try jw.write(s.hops);
    try jw.objectField("closed");
    try jw.write(s.closed);
    try jw.endObject();
    return out.written();
}

/// An http answer `{status, type, body}`.
pub fn httpJson(a: Allocator, status: u16, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}

// ---------------------------------------------------------------- the public read API (0.34.0)

/// The cache classes (the route table's): `state` a short public cache; `imm` immutable, only for
/// the bytes of a proven transaction.
pub const Cache = enum {
    state,
    imm,

    pub fn header(c: Cache) []const u8 {
        return switch (c) {
            .state => "public, max-age=5",
            .imm => "public, max-age=31536000, immutable",
        };
    }
};

/// An http answer `{status, type, headers: {cache-control}, body}`.
pub fn httpCached(a: Allocator, status: u16, content_type: []const u8, cache: Cache, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status } },
        .{ .key = "type", .value = .{ .text = content_type } },
        .{ .key = "headers", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "cache-control", .value = .{ .text = cache.header() } }}) } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}

/// `{"error": <text>}` with `status` (no cache header).
pub fn httpError(a: Allocator, status: u16, text: []const u8) !Value {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("error");
    try jw.write(text);
    try jw.endObject();
    return httpJson(a, status, out.written());
}

/// A value (maps, lists, text, numbers, booleans, null) as JSON: the lookup's freeform answers.
pub fn writeValue(jw: *std.json.Stringify, v: Value) !void {
    switch (v) {
        .map => |es| {
            try jw.beginObject();
            for (es) |e| {
                try jw.objectField(e.key);
                try writeValue(jw, e.value);
            }
            try jw.endObject();
        },
        .array => |xs| {
            try jw.beginArray();
            for (xs) |x| try writeValue(jw, x);
            try jw.endArray();
        },
        .text => |t| try jw.write(t),
        .boolean => |b| try jw.write(b),
        .uint => |n| try jw.write(n),
        .nint => |n| try jw.write(-1 - @as(i128, n)),
        .null => try jw.write(null),
        else => return error.BadValue,
    }
}

/// Lowercase hex of `bytes`.
pub fn hexAlloc(a: Allocator, bytes: []const u8) ![]const u8 {
    const digits = "0123456789abcdef";
    const out = try a.alloc(u8, bytes.len * 2);
    for (bytes, 0..) |b, i| {
        out[i * 2] = digits[b >> 4];
        out[i * 2 + 1] = digits[b & 0xf];
    }
    return out;
}

pub fn valueJson(a: Allocator, v: Value) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try writeValue(&jw, v);
    return out.written();
}

/// The pool lookup's index (amm-lookup's head `<app>/ls_amm`'s record `state`, null: none yet), as
/// amm-lookup loads it.
pub fn loadLookup(a: Allocator, s: w.store.Store, state: ?[]const u8) !lookup.Service {
    return lookup.Service.loadIndex(a, s, idx.service_name, idx.service_name, &idx.maps, state);
}

/// The pool lookup's freeform answer to `{tokenId, <field>: keys}` (`field` null: `{tokenId}`, every
/// live pool) — amm-lookup's `answer`, the code `/lookup` runs.
pub fn lookupAnswer(a: Allocator, svc: *lookup.Service, ch: *Chain, token: []const u8, field: ?[]const u8, keys: []const []const u8) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.append(a, .{ .key = "tokenId", .value = .{ .text = token } });
    if (field) |f| {
        const vs = try a.alloc(Value, keys.len);
        for (keys, vs) |k, *v| v.* = .{ .text = k };
        try es.append(a, .{ .key = f, .value = .{ .array = vs } });
    }
    const ans = try idx.answer(a, svc, ch, .{ .map = es.items });
    return switch (ans) {
        .freeform => |v| v,
        .output_list => error.BadQuery,
    };
}

/// The pools a P3 answer carries: the current pools of the pool ids `ids` (the lookup's `{poolIds}`
/// records whose status is live or rescinded: their `current`, the output a Swap or a Close spends;
/// an id with neither, nothing), in query order; `ids` null, every live pool (`{tokenId}`).
pub fn currentPools(a: Allocator, svc: *lookup.Service, ch: *Chain, token: []const u8, ids: ?[]const []const u8) ![]const Value {
    const keys = ids orelse return (try lookupAnswer(a, svc, ch, token, null, &.{})).array;
    const recs = try lookupAnswer(a, svc, ch, token, "poolIds", keys);
    var out: std.ArrayList(Value) = .empty;
    for (recs.array) |r| if (r.get("current")) |c| if (c == .map) try out.append(a, c);
    return out.items;
}

/// A pool row's outpoint (`<txid>_<vout>`), parsed.
pub fn rowOutpoint(row: Value) ?Outpoint {
    return parseOutpoint(row.getText("outpoint") orelse return null);
}

/// P3's JSON: `{pools, beef}` — `beef` the base64 of `beef_bytes` (one BEEF of the pools'
/// transactions, `beefOfMany`).
pub fn poolsBeefJson(a: Allocator, pools: []const Value, beef_bytes: []const u8) ![]const u8 {
    const b64 = try a.alloc(u8, std.base64.standard.Encoder.calcSize(beef_bytes.len));
    _ = std.base64.standard.Encoder.encode(b64, beef_bytes);
    return valueJson(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "pools", .value = .{ .array = @constCast(pools) } },
        .{ .key = "beef", .value = .{ .text = b64 } },
    }) });
}

/// P8's JSON over several outpoints: one record per outpoint in query order (`spendJson` each).
pub fn spendsJson(a: Allocator, ss: []const Spend) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(a, '[');
    for (ss, 0..) |s, i| {
        if (i > 0) try out.append(a, ',');
        try out.appendSlice(a, try spendJson(a, s));
    }
    try out.append(a, ']');
    return out.items;
}

/// The validator's side of P7: this instance's identity and peer ID with its terms.
pub const ValidatorTerms = struct {
    identity: ?[]const u8,
    peer_id: ?[]const u8,
    lp_fee_bps: u64,
    validator_fee_bps: u64,
    commission_bps: u64,
    /// The validator's minimum leg, sats (0.40.0): 0, none.
    min_leg_sats: u64 = 0,
};

/// P7's JSON: `{validator: {identity, peerId, lpFeeBps, validatorFeeBps, commissionBps, minLegSats} | null, market:
/// {commissionPkh, minCommissionBps}}` — `amm.pool.terms` and `amm.swap.terms` in one, unsigned
/// (`validator` null: no terms set, a market only; `identity`/`peerId`/`commissionPkh` null when the
/// signer gives none).
pub fn termsJson(a: Allocator, v: ?ValidatorTerms, commission_pkh: ?[20]u8, min_commission_bps: u64) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("validator");
    if (v) |t| {
        try jw.beginObject();
        try jw.objectField("identity");
        if (t.identity) |k| try jw.write(try hexAlloc(a, k)) else try jw.write(null);
        try jw.objectField("peerId");
        try jw.write(t.peer_id);
        try jw.objectField("lpFeeBps");
        try jw.write(t.lp_fee_bps);
        try jw.objectField("validatorFeeBps");
        try jw.write(t.validator_fee_bps);
        try jw.objectField("commissionBps");
        try jw.write(t.commission_bps);
        try jw.objectField("minLegSats");
        try jw.write(t.min_leg_sats);
        try jw.endObject();
    } else try jw.write(null);
    try jw.objectField("market");
    try jw.beginObject();
    try jw.objectField("commissionPkh");
    if (commission_pkh) |p| try jw.write(try hexAlloc(a, &p)) else try jw.write(null);
    try jw.objectField("minCommissionBps");
    try jw.write(min_commission_bps);
    try jw.endObject();
    try jw.endObject();
    return out.written();
}

/// A txid in display hex (64 characters), parsed.
pub fn parseTxid(text: []const u8) ?[32]u8 {
    if (text.len != 64) return null;
    return w.header.fromHex(text) catch null;
}

/// P9's cache class: `imm` only when the transaction is proven in the chain state (mined, its BUMP
/// against the chain's headers), else `state`.
pub fn txCache(ch: *Chain, txid: [32]u8) !Cache {
    return if ((try ch.status(txid)) == .proven) .imm else .state;
}

// ---------------------------------------------------------------- the history reads (0.36.0, D1–D3, D6)

/// Where the overlay has `txid` mined for the token's topic: its `placed` map (skein-overlay
/// state.zig: `tp ‖ txid → height (u32 BE) ‖ offset (u64 BE) ‖ block hash`, written once the proof
/// landed), read here as the overlay state the reads load holds it; null while not mined.
pub fn placedHeight(placed: *w.store.Map, tp: []const u8, txid: [32]u8) !?u32 {
    const v = (try placed.get(try std.mem.concat(placed.maps.arena, u8, &.{ tp, &txid }))) orelse return null;
    if (v != .bytes or v.bytes.len < 4) return error.BadIndex;
    return std.mem.readInt(u32, v.bytes[0..4], .big);
}

/// The history reads' functions (0.40.0: the pool history, `/pools/at` and `/pools/history`).
pub const History = enum { trades, candles, stats, poolsAt, poolsHistory };

/// The resolutions `/candles` takes, in ms.
pub fn timeframe(text: []const u8) ?u64 {
    const tfs = [_]struct { []const u8, u64 }{
        .{ "1m", 60_000 },          .{ "5m", 300_000 },
        .{ "15m", 900_000 },        .{ "1h", 3_600_000 },
        .{ "4h", 14_400_000 },      .{ "1d", 86_400_000 },
    };
    for (tfs) |t| if (eql(u8, t[0], text)) return t[1];
    return null;
}

pub const max_trades = 500;

fn writePrice(jw: *std.json.Stringify, p: idx.Price) !void {
    try jw.beginObject();
    try jw.objectField("sats");
    try jw.write(p.sats);
    try jw.objectField("tokens");
    try jw.write(p.tokens);
    try jw.endObject();
}

fn writeTrade(a: Allocator, jw: *std.json.Stringify, t: idx.Trade, height: ?u32) !void {
    const r = t.rec;
    try jw.beginObject();
    try jw.objectField("txid");
    try jw.write(&w.header.toHex(t.txid));
    try jw.objectField("poolId");
    try jw.write(try idx.poolIdText(a, r.getBytes("poolId") orelse return error.BadIndex));
    try jw.objectField("lpPubKey");
    try jw.write(try hexAlloc(a, r.getBytes("lpPubKey") orelse return error.BadIndex));
    try jw.objectField("side");
    try jw.write(r.getText("side") orelse return error.BadIndex);
    inline for (.{ .{ "amountIn", "amountIn" }, .{ "amountOut", "amountOut" }, .{ "feeLp", "lp" }, .{ "feeValidator", "validator" }, .{ "feeCommission", "commission" }, .{ "bsvReserve", "bsvReserve" }, .{ "tokenReserve", "tokenReserve" } }) |f| {
        try jw.objectField(f[0]);
        try jw.write(r.getUint(f[1]) orelse return error.BadIndex);
    }
    try jw.objectField("payoutPkh");
    try jw.write(try hexAlloc(a, r.getBytes("payoutPkh") orelse return error.BadIndex));
    try jw.objectField("at");
    try jw.write(t.at);
    try jw.objectField("height");
    try jw.write(height);
    try jw.endObject();
}

/// A cursor's text: hex of `at (u64 BE) ‖ txid` (40 bytes).
pub fn cursorText(a: Allocator, c: idx.Cursor) ![]const u8 {
    var b: [40]u8 = undefined;
    std.mem.writeInt(u64, b[0..8], c.at, .big);
    @memcpy(b[8..], &c.txid);
    return hexAlloc(a, &b);
}

pub fn parseCursor(text: []const u8) ?idx.Cursor {
    if (text.len != 80) return null;
    var b: [40]u8 = undefined;
    _ = std.fmt.hexToBytes(&b, text) catch return null;
    return .{ .at = std.mem.readInt(u64, b[0..8], .big), .txid = b[8..].* };
}

/// `/pools/history`'s cursor text (0.40.0): hex of `at (u64 BE) ‖ poolId (36) ‖ seq (u64 BE)` (52
/// bytes, 104 hex characters), opaque to a client.
pub fn eventCursorText(a: Allocator, c: idx.EventCursor) ![]const u8 {
    var b: [52]u8 = undefined;
    std.mem.writeInt(u64, b[0..8], c.at, .big);
    @memcpy(b[8..44], &c.pid);
    std.mem.writeInt(u64, b[44..52], c.seq, .big);
    return hexAlloc(a, &b);
}

pub fn parseEventCursor(text: []const u8) ?idx.EventCursor {
    if (text.len != 104) return null;
    var b: [52]u8 = undefined;
    _ = std.fmt.hexToBytes(&b, text) catch return null;
    return .{ .at = std.mem.readInt(u64, b[0..8], .big), .pid = b[8..44].*, .seq = std.mem.readInt(u64, b[44..52], .big) };
}

/// A query's `pool` parameter (0.40.0): one pool id `<txid>_<vout>`, as its outpoint key; null absent.
fn poolParam(a: Allocator, q: []const u8) !?[36]u8 {
    const text = (try queryParam(a, q, "pool")) orelse return null;
    if (text.len < 66 or text[64] != '_') return error.BadParam;
    const op = parseOutpoint(text) orelse return error.BadParam;
    return w.store.outpointKey(op.txid, op.vout);
}

fn intParam(a: Allocator, q: []const u8, name: []const u8) !?u64 {
    const t = (try queryParam(a, q, name)) orelse return null;
    return std.fmt.parseInt(u64, t, 10) catch error.BadParam;
}

/// One history read (H1 `/trades`, H2 `/candles`, H3 `/stats`; 0.40.0 `/pools/at`, `/pools/history`) over the pool lookup's index
/// `svc`, the overlay's `placed` map (each trade's `height`), the token `token`, the query `q`, at
/// `now` (ms, the read's clock: `/stats`' windows). JSON, cache `state`.
pub fn historyRead(a: Allocator, svc: *lookup.Service, _: *Chain, placed: *w.store.Map, token: []const u8, h: History, q: []const u8, now: u64) !Value {
    const tp = try idx.tokenPrefix(a, token);
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    switch (h) {
        .trades => {
            // ?txid=: one row (its pool id from the Swap's continuation's record, 0.40.0).
            if (try queryParam(a, q, "txid")) |text| {
                const txid = parseTxid(text) orelse return httpError(a, 400, "want ?txid=<txid>: 64 hex characters");
                const tr = (try idx.tradeOf(a, svc, tp, txid)) orelse return httpError(a, 404, "no trade for this txid");
                try writeTrade(a, &jw, tr, try placedHeight(placed, tp, txid));
                return httpCached(a, 200, "application/json", .state, out.written());
            }
            var tq: idx.TradeQuery = .{};
            const bad = "want ?from=<ms>&to=<ms>&limit=<n≤500>&before=<cursor>&pool=<txid>_<vout>";
            tq.from = intParam(a, q, "from") catch return httpError(a, 400, bad);
            tq.to = intParam(a, q, "to") catch return httpError(a, 400, bad);
            if (intParam(a, q, "limit") catch return httpError(a, 400, bad)) |n| {
                if (n == 0 or n > max_trades) return httpError(a, 400, bad);
                tq.limit = @intCast(n);
            }
            if (try queryParam(a, q, "before")) |c| tq.before = parseCursor(c) orelse return httpError(a, 400, bad);
            tq.pool = poolParam(a, q) catch return httpError(a, 400, bad);
            const rows = try idx.trades(a, svc, tp, tq);
            try jw.beginObject();
            try jw.objectField("trades");
            try jw.beginArray();
            for (rows) |r| try writeTrade(a, &jw, r, try placedHeight(placed, tp, r.txid));
            try jw.endArray();
            // The next page's cursor: the last row's, when the page is full.
            try jw.objectField("next");
            if (rows.len == tq.limit) try jw.write(try cursorText(a, .{ .at = rows[rows.len - 1].at, .txid = rows[rows.len - 1].txid })) else try jw.write(null);
            try jw.endObject();
        },
        .candles => {
            const bad = "want ?tf=1m|5m|15m|1h|4h|1d&from=<ms>&to=<ms>";
            const tf = timeframe((try queryParam(a, q, "tf")) orelse return httpError(a, 400, bad)) orelse return httpError(a, 400, bad);
            const from = (intParam(a, q, "from") catch return httpError(a, 400, bad)) orelse return httpError(a, 400, bad);
            const to = (intParam(a, q, "to") catch return httpError(a, 400, bad)) orelse return httpError(a, 400, bad);
            if (to < from) return httpError(a, 400, bad);
            const cs = idx.candles(a, svc, tp, tf, from, to) catch |e| switch (e) {
                error.TooManyBuckets => return httpError(a, 400, "the window spans more than 5000 buckets"),
                else => return e,
            };
            try jw.beginArray();
            for (cs) |c| {
                try jw.beginObject();
                try jw.objectField("t");
                try jw.write(c.t);
                inline for (.{ "o", "h", "l", "c" }) |f| {
                    try jw.objectField(f);
                    try writePrice(&jw, @field(c, f));
                }
                try jw.objectField("volumeSats");
                try jw.write(c.volume_sats);
                try jw.objectField("volumeTokens");
                try jw.write(c.volume_tokens);
                try jw.objectField("n");
                try jw.write(c.n);
                try jw.endObject();
            }
            try jw.endArray();
        },
        .stats => {
            const s = try idx.stats(a, svc, tp, now);
            try jw.beginObject();
            try jw.objectField("tokenId");
            try jw.write(token);
            // 0.40.0: the last fill's price as `lastTradePrice` (the host sets `price`).
            try jw.objectField("lastTradePrice");
            if (s.last_trade_price) |p| try writePrice(&jw, p) else try jw.write(null);
            try jw.objectField("change1h");
            try jw.write(s.change1h);
            try jw.objectField("change24h");
            try jw.write(s.change24h);
            try jw.objectField("volume24hSats");
            try jw.write(s.volume24h_sats);
            try jw.objectField("volume24hTokens");
            try jw.write(s.volume24h_tokens);
            try jw.objectField("buys24h");
            try jw.write(s.buys24h);
            try jw.objectField("sells24h");
            try jw.write(s.sells24h);
            try jw.objectField("lastTradeAt");
            try jw.write(s.last_trade_at);
            try jw.objectField("tvlSats");
            try jw.write(s.tvl_sats);
            try jw.objectField("tvlTokens");
            try jw.write(s.tvl_tokens);
            try jw.objectField("pools");
            try jw.write(s.pools);
            try jw.endObject();
        },
        .poolsAt => {
            const bad = "want ?t=<ms>";
            const t = (intParam(a, q, "t") catch return httpError(a, 400, bad)) orelse return httpError(a, 400, bad);
            try jw.beginArray();
            // A `/pools/at` row: `{poolId, outpoint, bsvReserve, tokenReserve, lpPubKey, the three
            // rates, validatorIdentityKey, at, swaps}` (amm-lookup `poolAtRow`).
            for (try idx.poolsAt(a, svc, tp, t)) |r| try writeValue(&jw, try idx.poolAtRow(a, r));
            try jw.endArray();
        },
        .poolsHistory => {
            const bad = "want ?from=<ms>&to=<ms>&pool=<txid>_<vout>&limit=<n≤500>&after=<cursor>";
            const from = intParam(a, q, "from") catch return httpError(a, 400, bad);
            const to = intParam(a, q, "to") catch return httpError(a, 400, bad);
            const one = poolParam(a, q) catch return httpError(a, 400, bad);
            var limit: usize = idx.max_events;
            if (intParam(a, q, "limit") catch return httpError(a, 400, bad)) |n| {
                if (n == 0 or n > idx.max_events) return httpError(a, 400, bad);
                limit = @intCast(n);
            }
            const after: ?idx.EventCursor = if (try queryParam(a, q, "after")) |c| parseEventCursor(c) orelse return httpError(a, 400, bad) else null;
            const page = try idx.poolHistory(a, svc, tp, from, to, one, limit, after);
            try jw.beginObject();
            try jw.objectField("events");
            try jw.beginArray();
            // THE history row (amm-lookup `eventRow`): the pool event's `row` is the same (0.41.0).
            for (page.events) |ev| try writeValue(&jw, try idx.eventRow(a, ev.rec));
            try jw.endArray();
            // Forward paging: the last row's position when more rows remain in the window, else null.
            try jw.objectField("next");
            if (page.more) {
                const last = page.events[page.events.len - 1];
                try jw.write(try eventCursorText(a, .{ .at = last.at, .pid = last.pid, .seq = last.seq }));
            } else try jw.write(null);
            try jw.endObject();
        },
    }
    return httpCached(a, 200, "application/json", .state, out.written());
}
