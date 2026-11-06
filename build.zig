// skein-amm (shruggr/skein#120): the AMM as a skein overlay app over the 1Color components.
// Zig 0.16.0, wasm32-wasi. The app's tree carries the overlay engine and the 1Color topic
// manager and lookup service, copied from their tagged builds (URL+hash dependencies; nothing is
// built on the skein), and this repo's own programs:
//
//   amm-lookup      ls_amm_<assetId>: the listed pools of a token instance; the prices beat programs/amm-lookup
//   amm-validator   the validator: swap (a libp2p direct call), affirm; root's close         programs/amm-validator
//   amm-p2p         the relay (amm.swap/1; amm.pool/1: terms, affirm), the read routes       programs/amm-p2p
//                   (0.34.0: /pools/beef, /positions, /fees/*, /terms, /spends, /tx, /swaps)
//   amm-setup       the token's setup (0.22.0, shruggr/skein-amm#5): the deploy event       programs/amm-setup
//                   (box amm/deploy) → the head amm/token and the token's topic and lookups
//                   registered with the engine by call; the read /token
//   (the config app, amm-config, moved to shruggr/open-exchange as its swap app: 0.23.0)
//
// over the pool library (src/pool.zig: the Pool contract as the overlay sees it, over the
// `1color` module's parser and rules) and its generated fixtures (src/fixtures, gen/).
//
//   zig build              → zig-out/bin/{amm-lookup,amm-validator,amm-p2p,amm-setup}.wasm
//   zig build bin          the four, written to bin/, with bin/overlay.wasm (skein-overlay v0.20.3)
//                          and bin/color-{topic,lookup}.wasm (skein-1color v0.15.2) copied beside
//   zig build test         the pool library and the programs' tests, natively
//
// The pages are built from the page library web/ui by shruggr/open-exchange (its scripts/www.sh), whose swap app serves them.
const std = @import("std");

/// The modules a program or a test imports, for one target.
const Mods = struct {
    chain: *std.Build.Module,
    wallet: *std.Build.Module,
    message: *std.Build.Module,
    cbor: *std.Build.Module,
    sk: *std.Build.Module,
    app: *std.Build.Module,
    files: *std.Build.Module,
    dagjson: *std.Build.Module,
    topic: *std.Build.Module,
    lookup: *std.Build.Module,
    overlay_sk: *std.Build.Module,
    color: *std.Build.Module,
    pool: *std.Build.Module,
    /// The validator's terms record (0.15.0, src/terms.zig, over the pool library's Terms).
    terms: *std.Build.Module,
    /// A 1Color deploy read from a BEEF (0.22.0, src/deploy.zig): amm-setup's deploy event (and open-exchange's swap app).
    deploy: *std.Build.Module,
    /// amm-lookup's index (0.34.0, programs/amm-lookup/src/index.zig): amm-p2p's read routes answer
    /// from the lookup's own answers (P3-P6), the same code, over the same index.
    amm_lookup: *std.Build.Module,
    /// amm-validator's submission message (0.41.0, programs/amm-validator/src/submit.zig): amm-p2p's
    /// relay submits the validator's answered BEEF to its own overlay with the same message.
    amm_submit: *std.Build.Module,
    /// skein-overlay's engine sources (src/state.zig, src/submit.zig, src/engine_vm.zig, …), which
    /// it does not export as modules: the validator submits through the engine's own
    /// `submit.route` and reads its state, as amm-poc did with skein-overlay 0.2.0.
    engine: *std.Build.Module,
};

fn mods(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) Mods {
    const ov = b.dependency("skein_overlay", .{ .target = target, .optimize = optimize });
    const sdk = ov.builder.dependency("skein_sdk", .{ .target = target, .optimize = optimize });
    const cd = b.dependency("skein_1color", .{ .target = target, .optimize = optimize });
    const chain = sdk.module("chain");
    const color = cd.module("1color");
    const wf = b.addWriteFiles();
    _ = wf.addCopyDirectory(ov.path("src"), "skein_overlay", .{});
    const engine = b.createModule(.{
        .root_source_file = wf.add("skein_overlay/lib.zig",
            \\pub const state = @import("state.zig");
            \\pub const submit = @import("submit.zig");
            \\pub const calls = @import("calls.zig");
            \\pub const config = @import("config.zig");
            \\pub const topics = @import("topics.zig");
            \\pub const engine_vm = @import("engine_vm.zig");
            \\
        ),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "chain", .module = chain },
            .{ .name = "topic", .module = ov.module("topic") },
            .{ .name = "sk", .module = ov.module("sk") },
        },
    });
    const pool_mod = b.createModule(.{
        .root_source_file = b.path("src/pool.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "chain", .module = chain }, .{ .name = "1color", .module = color } },
    });
    const terms_mod = b.createModule(.{
        .root_source_file = b.path("src/terms.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "chain", .module = chain }, .{ .name = "pool", .module = pool_mod } },
    });
    const deploy_mod = b.createModule(.{
        .root_source_file = b.path("src/deploy.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "chain", .module = chain }, .{ .name = "1color", .module = color } },
    });
    const amm_lookup = b.createModule(.{
        .root_source_file = b.path("programs/amm-lookup/src/index.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "chain", .module = chain },
            .{ .name = "lookup", .module = ov.module("lookup") },
            .{ .name = "pool", .module = pool_mod },
            .{ .name = "1color", .module = color },
        },
    });
    const amm_submit = b.createModule(.{
        .root_source_file = b.path("programs/amm-validator/src/submit.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "chain", .module = chain }},
    });
    return .{
        .amm_submit = amm_submit,
        .chain = chain,
        .wallet = sdk.module("wallet"),
        .message = sdk.module("message"),
        .cbor = sdk.module("cbor"),
        .sk = sdk.module("sk"),
        .app = sdk.module("app"),
        .files = sdk.module("files"),
        .dagjson = sdk.module("dagjson"),
        .topic = ov.module("topic"),
        .lookup = ov.module("lookup"),
        .overlay_sk = ov.module("sk"),
        .color = color,
        .pool = pool_mod,
        .terms = terms_mod,
        .deploy = deploy_mod,
        .amm_lookup = amm_lookup,
        .engine = engine,
    };
}

/// One program's (or its tests') imports.
fn imports(b: *std.Build, m: Mods, program: []const u8) []const std.Build.Module.Import {
    const common = [_]std.Build.Module.Import{
        .{ .name = "chain", .module = m.chain },
        .{ .name = "1color", .module = m.color },
        .{ .name = "pool", .module = m.pool },
        .{ .name = "terms", .module = m.terms },
        .{ .name = "deploy", .module = m.deploy },
    };
    const more: []const std.Build.Module.Import = if (std.mem.eql(u8, program, "amm-lookup")) &.{
        .{ .name = "lookup", .module = m.lookup },
        .{ .name = "overlay_sk", .module = m.overlay_sk },
    } else if (std.mem.eql(u8, program, "amm-validator")) &.{
        .{ .name = "wallet", .module = m.wallet },
        .{ .name = "message", .module = m.message },
        .{ .name = "sdk_cbor", .module = m.cbor },
        .{ .name = "topic", .module = m.topic },
        .{ .name = "overlay_sk", .module = m.overlay_sk },
        .{ .name = "skein_overlay", .module = m.engine },
    } else if (std.mem.eql(u8, program, "amm-setup")) &.{
        .{ .name = "overlay_sk", .module = m.overlay_sk },
    } else &.{
        .{ .name = "wallet", .module = m.wallet },
        .{ .name = "message", .module = m.message },
        .{ .name = "sdk_cbor", .module = m.cbor },
        .{ .name = "sk", .module = m.sk },
        .{ .name = "app", .module = m.app },
        .{ .name = "files", .module = m.files },
        .{ .name = "dagjson", .module = m.dagjson },
        .{ .name = "overlay_sk", .module = m.overlay_sk },
        .{ .name = "skein_overlay", .module = m.engine },
        .{ .name = "lookup", .module = m.lookup },
        .{ .name = "amm_lookup", .module = m.amm_lookup },
        .{ .name = "amm_submit", .module = m.amm_submit },
    };
    return std.mem.concat(b.allocator, std.Build.Module.Import, &.{ &common, more }) catch @panic("OOM");
}

const programs = [_][]const u8{ "amm-lookup", "amm-validator", "amm-p2p", "amm-setup" };

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    _ = optimize;

    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wm = mods(b, wasi, .ReleaseSafe);
    const bin = b.addUpdateSourceFiles();
    for (programs) |p| {
        const exe = b.addExecutable(.{
            .name = p,
            .root_module = b.createModule(.{
                .root_source_file = b.path(b.fmt("programs/{s}/src/main.zig", .{p})),
                .target = wasi,
                .optimize = .ReleaseSafe,
                .strip = true,
                .imports = imports(b, wm, p),
            }),
        });
        b.installArtifact(exe);
        bin.addCopyFileToSource(exe.getEmittedBin(), b.fmt("bin/{s}.wasm", .{p}));
    }
    // The engine and the 1Color components, as their tags built them (not rebuilt here).
    const ov = b.dependency("skein_overlay", .{ .target = wasi, .optimize = .ReleaseSafe });
    const cd = b.dependency("skein_1color", .{ .target = wasi, .optimize = .ReleaseSafe });
    bin.addCopyFileToSource(ov.path("bin/overlay.wasm"), "bin/overlay.wasm");
    bin.addCopyFileToSource(cd.path("bin/color-topic.wasm"), "bin/color-topic.wasm");
    bin.addCopyFileToSource(cd.path("bin/color-lookup.wasm"), "bin/color-lookup.wasm");
    b.step("bin", "write the app's modules into bin/: this repo's four, and the engine and the 1Color components copied from their tags").dependOn(&bin.step);

    const nm = mods(b, target, .Debug);
    const test_step = b.step("test", "The pool library and the programs' tests, natively");
    const roots = [_][2][]const u8{
        .{ "pool", "test.zig" },
        .{ "amm-lookup", "programs/amm-lookup/test.zig" },
        .{ "amm-validator", "programs/amm-validator/test.zig" },
        .{ "amm-p2p", "programs/amm-p2p/test.zig" },
        .{ "amm-setup", "programs/amm-setup/test.zig" },
    };
    for (roots) |r| {
        const m = b.createModule(.{
            .root_source_file = b.path(r[1]),
            .target = target,
            .optimize = .Debug,
            .imports = imports(b, nm, r[0]),
        });
        m.addImport("vectors", b.createModule(.{ .root_source_file = b.path("src/fixtures/vectors.zig"), .target = target, .optimize = .Debug }));
        // The manifest, for the dispatch tests: the functions' declarations as an installed app's are read.
        const wf = b.addWriteFiles();
        _ = wf.addCopyFile(b.path("etc/app.json"), "app.json");
        m.addImport("app_manifest", b.createModule(.{
            .root_source_file = wf.add("app_manifest.zig", "pub const json = @embedFile(\"app.json\");\n"),
            .target = target,
            .optimize = .Debug,
        }));
        const t = b.addTest(.{ .root_module = m, .name = r[0] });
        const run = b.addRunArtifact(t);
        test_step.dependOn(&run.step);
        b.step(b.fmt("test-{s}", .{r[0]}), b.fmt("{s}'s tests alone", .{r[0]})).dependOn(&run.step);
    }
}
