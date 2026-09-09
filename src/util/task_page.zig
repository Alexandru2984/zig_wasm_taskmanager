const std = @import("std");
const ids = @import("../db/http_client.zig");

pub const Query = struct {
    paged: bool,
    workspace: ?[]const u8,
    cursor: ?[]const u8,
    limit: usize,
    as_of: i64,
};

pub fn parse(page: ?[]const u8, workspace: ?[]const u8, cursor: ?[]const u8, limit: ?[]const u8, as_of: ?[]const u8, now: i64) !Query {
    if (page != null and !std.mem.eql(u8, page.?, "1")) return error.InvalidInput;
    if (workspace != null and !ids.validRecordIdFor(workspace.?, "workspaces")) return error.InvalidInput;
    if (cursor != null and !ids.validRecordIdFor(cursor.?, "tasks")) return error.InvalidInput;
    if (page == null and (cursor != null or limit != null or as_of != null)) return error.InvalidInput;
    if (cursor != null and as_of == null) return error.InvalidInput;
    const size = if (limit) |value| try decimal(usize, value) else 100;
    const cutoff = if (as_of) |value| try decimal(i64, value) else now;
    if (size == 0 or size > 100 or cutoff <= 0 or cutoff > now) return error.InvalidInput;
    return .{ .paged = page != null, .workspace = workspace, .cursor = cursor, .limit = size, .as_of = cutoff };
}

fn decimal(comptime T: type, value: []const u8) !T {
    if (value.len == 0 or value.len > 19 or std.mem.indexOfNone(u8, value, "0123456789") != null) return error.InvalidInput;
    return std.fmt.parseInt(T, value, 10) catch error.InvalidInput;
}

test "task page defaults and scoped cursor" {
    const first = try parse("1", null, null, null, null, 12345);
    try std.testing.expectEqual(@as(usize, 100), first.limit);
    try std.testing.expectEqual(@as(i64, 12345), first.as_of);
    const next = try parse("1", "workspaces:abc", "tasks:def", "25", "12345", 12346);
    try std.testing.expectEqual(@as(usize, 25), next.limit);
    try std.testing.expectEqualStrings("tasks:def", next.cursor.?);
    try std.testing.expect(!(try parse(null, null, null, null, null, 12345)).paged);
}

test "task page rejects unbounded and ambiguous input" {
    for ([_][]const u8{ "0", "101", "-1", "+1", "1.5", "", "999999999999999999999999" }) |limit|
        try std.testing.expectError(error.InvalidInput, parse("1", null, null, limit, null, 12345));
    try std.testing.expectError(error.InvalidInput, parse("2", null, null, null, null, 12345));
    try std.testing.expectError(error.InvalidInput, parse("1", "users:abc", null, null, null, 12345));
    try std.testing.expectError(error.InvalidInput, parse("1", null, "users:abc", null, "12345", 12345));
    try std.testing.expectError(error.InvalidInput, parse("1", null, "tasks:abc", null, null, 12345));
    try std.testing.expectError(error.InvalidInput, parse(null, null, null, "10", null, 12345));
    try std.testing.expectError(error.InvalidInput, parse("1", null, null, null, "12346", 12345));
    try std.testing.expectError(error.InvalidInput, parse("1", null, null, null, "0", 12345));
}
