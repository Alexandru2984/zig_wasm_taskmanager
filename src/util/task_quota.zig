const std = @import("std");
const config = @import("../config/config.zig");

pub const Limits = struct { tasks: i64, text_bytes: i64, workspaces: i64 };

fn number(raw: []const u8, maximum: i64) !i64 {
    if (raw.len == 0 or raw.len > 12 or std.mem.indexOfNone(u8, raw, "0123456789") != null) return error.InvalidQuotaConfig;
    const value = std.fmt.parseInt(i64, raw, 10) catch return error.InvalidQuotaConfig;
    if (value <= 0 or value > maximum) return error.InvalidQuotaConfig;
    return value;
}

pub fn parse(tasks: []const u8, bytes: []const u8, workspaces: []const u8) !Limits {
    return .{ .tasks = try number(tasks, 1000000), .text_bytes = try number(bytes, 10737418240), .workspaces = try number(workspaces, 1000) };
}

pub fn get() !Limits {
    return parse(config.getOrDefault("WORKSPACE_TASK_LIMIT", "10000"), config.getOrDefault("WORKSPACE_TEXT_BYTES_LIMIT", "52428800"), config.getOrDefault("OWNED_WORKSPACE_LIMIT", "25"));
}

// Logical UTF-8 payload, not JSON escaping or physical database/index overhead.
pub fn textBytes(title: []const u8, notes: []const u8, tags: []const []const u8) i64 {
    var size: i64 = @intCast(title.len + notes.len);
    for (tags) |tag| size += @intCast(tag.len);
    return size;
}

test "task quota config is bounded and cannot silently disable limits" {
    const valid = try parse("10000", "52428800", "25");
    try std.testing.expectEqual(@as(i64, 10000), valid.tasks);
    for ([_][]const u8{ "", "0", "-1", "+1", "1.5", "1000001", "999999999999999999" }) |bad|
        try std.testing.expectError(error.InvalidQuotaConfig, parse(bad, "52428800", "25"));
    try std.testing.expectError(error.InvalidQuotaConfig, parse("1", "10737418241", "25"));
    try std.testing.expectError(error.InvalidQuotaConfig, parse("1", "1", "1001"));
}

test "logical task payload counts UTF-8 bytes, including every tag" {
    try std.testing.expectEqual(@as(i64, 11), textBytes("ș😀", "abc", &.{ "x", "y" }));
    try std.testing.expectEqual(@as(i64, 0), textBytes("", "", &.{}));
}
