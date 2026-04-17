const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Get the zap dependency
    const zap = b.dependency("zap", .{
        .target = target,
        .optimize = optimize,
    });

    // Backend executable
    const exe = b.addExecutable(.{
        .name = "taskmanager",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    // Add zap module to backend
    exe.root_module.addImport("zap", zap.module("zap"));

    b.installArtifact(exe);

    // Run step
    const run_step = b.step("run", "Run the server");
    const run_cmd = b.addRunArtifact(exe);
    run_step.dependOn(&run_cmd.step);
    run_cmd.step.dependOn(b.getInstallStep());

    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    // WASM step for frontend
    const wasm = b.addExecutable(.{
        .name = "app",
        .root_module = b.createModule(.{
            .root_source_file = b.path("frontend/src/main.zig"),
            .target = b.resolveTargetQuery(.{
                .cpu_arch = .wasm32,
                .os_tag = .freestanding,
            }),
            .optimize = .ReleaseSmall,
        }),
    });
    wasm.entry = .disabled;
    wasm.root_module.export_symbol_names = &.{
        "init",
        "addTask",
        "toggleTask",
        "deleteTask",
        "getTaskCount",
        "getTaskTitle",
        "getTaskTitleLen",
        "getTaskCompleted",
        "getTaskId",
        "allocString",
        "freeString",
    };

    // Install WASM to public folder
    const install_wasm = b.addInstallArtifact(wasm, .{
        .dest_dir = .{ .override = .{ .custom = "../public" } },
    });
    b.getInstallStep().dependOn(&install_wasm.step);

    // Tests
    const test_step = b.step("test", "Run tests");
    const exe_tests = b.addTest(.{
        .root_module = exe.root_module,
    });
    const run_exe_tests = b.addRunArtifact(exe_tests);
    test_step.dependOn(&run_exe_tests.step);
}
