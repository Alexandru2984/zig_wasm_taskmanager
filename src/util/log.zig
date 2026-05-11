// Unified Logger Module
// Replaces scattered std.debug.print calls with leveled logging
const std = @import("std");

pub const Level = enum {
    debug,
    info,
    warn,
    err,
};

// Current minimum log level (can be made configurable)
var min_level: Level = .info;

pub fn setLevel(level: Level) void {
    min_level = level;
}

fn shouldLog(level: Level) bool {
    return @intFromEnum(level) >= @intFromEnum(min_level);
}

fn levelPrefix(level: Level) []const u8 {
    return switch (level) {
        .debug => "[DEBUG]",
        .info => "[INFO] ",
        .warn => "[WARN] ",
        .err => "[ERROR]",
    };
}

fn levelEmoji(level: Level) []const u8 {
    return switch (level) {
        .debug => "🔍",
        .info => "ℹ️ ",
        .warn => "⚠️ ",
        .err => "❌",
    };
}

pub fn log(level: Level, comptime fmt: []const u8, args: anytype) void {
    if (!shouldLog(level)) return;

    const prefix = levelEmoji(level);
    std.debug.print("{s} " ++ fmt ++ "\n", .{prefix} ++ args);
}

// Convenience functions
pub fn debug(comptime fmt: []const u8, args: anytype) void {
    log(.debug, fmt, args);
}

pub fn info(comptime fmt: []const u8, args: anytype) void {
    log(.info, fmt, args);
}

pub fn warn(comptime fmt: []const u8, args: anytype) void {
    log(.warn, fmt, args);
}

pub fn err(comptime fmt: []const u8, args: anytype) void {
    log(.err, fmt, args);
}

// Startup banner
pub fn banner(app_name: []const u8, interface: []const u8, port: u16) void {
    std.debug.print("\n", .{});
    std.debug.print("╔══════════════════════════════════════╗\n", .{});
    std.debug.print("║  🦎 {s: <30} ║\n", .{app_name});
    std.debug.print("║  Running on http://{s}:{d: <5}  ║\n", .{ interface, port });
    std.debug.print("╚══════════════════════════════════════╝\n", .{});
    std.debug.print("\n", .{});
}
