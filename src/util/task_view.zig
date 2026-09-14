const std = @import("std");
const search = @import("task_search.zig");
const ids = @import("../db/http_client.zig");

pub const Input = struct {
    query: search.Input,
    parent_id: ?[]const u8 = null,
    focus_id: ?[]const u8 = null,
    active_first: bool = false,
    today: i64,
    tomorrow: i64,
    upcoming: i64,
};
pub const Query = struct { input: Input, search: search.Query };
pub const Counts = struct { total: i64 = 0, done: i64 = 0, overdue: i64 = 0, high: i64 = 0, today: i64 = 0, upcoming: i64 = 0 };
pub const Tag = struct { tag: []const u8, count: i64 };
pub const Child = struct { parent_id: []const u8, total: i64, done: i64 };
pub const Result = struct {
    rows: []search.Row,
    matched: i64,
    counts: ?Counts = null,
    tags: []Tag,
    children: []Child,
};

pub fn parse(a: std.mem.Allocator, user: []const u8, input: Input, now: i64) !Query {
    if (input.query.workspace_id == null or input.query.limit > 50 or
        input.today < 0 or input.today >= input.tomorrow or input.tomorrow >= input.upcoming or
        input.upcoming > 253402300799999 or input.upcoming - input.today > 10 * 86400000) return error.InvalidInput;
    if (input.parent_id) |id| if (!ids.validRecordIdFor(id, "tasks")) return error.InvalidInput;
    if (input.focus_id) |id| if (!ids.validRecordIdFor(id, "tasks")) return error.InvalidInput;
    // Domain separation: finder tokens cannot be reused as parent/child pages.
    // These are positions, never credentials; DB scope is checked independently.
    const context = try std.json.Stringify.valueAlloc(a, .{ .kind = "task-view-v1", .user = user, .parent = input.parent_id, .focus = input.focus_id, .active_first = input.active_first, .today = input.today, .tomorrow = input.tomorrow, .upcoming = input.upcoming }, .{});
    defer a.free(context);
    return .{ .input = input, .search = try search.parse(a, context, input.query, now) };
}

test "task view validates bounds and separates hierarchy and cursor context" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const valid = Input{ .query = .{ .workspace_id = "workspaces:a" }, .today = 1, .tomorrow = 2, .upcoming = 3 };
    const first = try parse(a, "users:a", valid, 1000);
    const token = try search.next(a, first.search, .{ .task = .{ .id = "tasks:a", .user_id = "users:a", .title = "A", .created_at = "" }, .n = 1, .s = "", .b = 1 });
    var next = valid;
    next.query.cursor = token;
    try std.testing.expectEqual(@as(u8, 1), (try parse(a, "users:a", next, 2000)).search.after.?.b);
    next.parent_id = "tasks:a";
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", next, 2000));
    next = valid;
    next.query.workspace_id = null;
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", next, 1000));
    next = valid;
    next.query.limit = 51;
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", next, 1000));
    next = valid;
    next.focus_id = "users:a";
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", next, 1000));
    next = valid;
    next.upcoming = 0;
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", next, 1000));
}
