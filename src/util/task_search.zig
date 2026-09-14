const std = @import("std");
const ids = @import("../db/http_client.zig");
const models = @import("../domain/models.zig");

pub const Input = struct {
    workspace_id: ?[]const u8 = null,
    q: []const u8 = "",
    status: []const u8 = "all",
    priority: []const u8 = "all",
    tag: []const u8 = "",
    assignee: []const u8 = "any",
    due: []const u8 = "any",
    due_from: ?i64 = null,
    due_before: ?i64 = null,
    sort: []const u8 = "created_desc",
    limit: usize = 50,
    as_of: ?i64 = null,
    cursor: ?[]const u8 = null,
};
pub const Cursor = struct { v: u8 = 1, id: []const u8, n: i64, s: []const u8, b: u8 = 0, as_of: i64, binding: []const u8 };
pub const Query = struct { input: Input, as_of: i64, after: ?Cursor, binding: []const u8 };
pub const Row = struct { task: models.Task, n: i64, s: []const u8, b: u8 = 0 };

fn choice(value: []const u8, choices: []const []const u8) bool {
    for (choices) |item| if (std.mem.eql(u8, value, item)) return true;
    return false;
}

fn safeText(value: []const u8, max: usize) bool {
    if (value.len > max or !std.unicode.utf8ValidateSlice(value)) return false;
    for (value) |byte| if (byte < 32 or byte == 127) return false;
    return true;
}

/// A positional token, not an access credential. Binding prevents accidental
/// cross-query reuse; authorization is independently checked on every page.
pub fn parse(a: std.mem.Allocator, user: []const u8, raw: Input, now: i64) !Query {
    var input = raw;
    input.q = std.mem.trim(u8, raw.q, " ");
    input.tag = std.mem.trim(u8, raw.tag, " ");
    if (input.workspace_id) |ws| if (!ids.validRecordIdFor(ws, "workspaces")) return error.InvalidInput;
    if (input.as_of) |cutoff| if (cutoff <= 0 or cutoff > now) return error.InvalidInput;
    if (!safeText(input.q, 500) or !safeText(input.tag, 128) or input.limit == 0 or input.limit > 100 or
        !choice(input.status, &.{ "all", "active", "todo", "doing", "done" }) or
        !choice(input.priority, &.{ "all", "high", "normal", "low" }) or
        !choice(input.assignee, &.{ "any", "me", "unassigned" }) or
        !choice(input.due, &.{ "any", "overdue", "none", "range" }) or
        !choice(input.sort, &.{ "created_desc", "created_asc", "due_asc", "priority", "title" })) return error.InvalidInput;
    if (std.mem.eql(u8, input.due, "range")) {
        if (input.due_from == null or input.due_before == null or input.due_from.? < 0 or
            input.due_before.? > 253402300799999 or input.due_from.? >= input.due_before.?) return error.InvalidInput;
    } else if (input.due_from != null or input.due_before != null) return error.InvalidInput;

    input.cursor = null;
    input.as_of = null;
    const context = try std.json.Stringify.valueAlloc(a, .{ .user = user, .query = input }, .{});
    defer a.free(context);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(context, &digest, .{});
    const binding = try a.dupe(u8, &std.fmt.bytesToHex(digest, .lower));
    errdefer a.free(binding);
    var after: ?Cursor = null;
    if (raw.cursor) |encoded| {
        if (encoded.len == 0 or encoded.len > 8192) return error.InvalidInput;
        const decoder = std.base64.url_safe_no_pad.Decoder;
        const bytes = try a.alloc(u8, decoder.calcSizeForSlice(encoded) catch return error.InvalidInput);
        defer a.free(bytes);
        decoder.decode(bytes, encoded) catch return error.InvalidInput;
        // Request arena owns parsed strings through query completion.
        const parsed = std.json.parseFromSlice(Cursor, a, bytes, .{ .allocate = .alloc_always }) catch return error.InvalidInput;
        const c = parsed.value;
        if (c.v != 1 or c.b > 1 or !ids.validRecordIdFor(c.id, "tasks") or !safeText(c.s, 2048) or
            c.n < -9007199254740991 or c.n > 9007199254740991 or c.as_of <= 0 or c.as_of > now or
            !std.mem.eql(u8, c.binding, binding) or (raw.as_of != null and raw.as_of.? != c.as_of)) return error.InvalidInput;
        after = c;
    }
    return .{ .input = input, .as_of = if (after) |c| c.as_of else raw.as_of orelse now, .after = after, .binding = binding };
}

pub fn next(a: std.mem.Allocator, query: Query, row: Row) ![]const u8 {
    const json = try std.json.Stringify.valueAlloc(a, Cursor{ .id = row.task.id, .n = row.n, .s = row.s, .b = row.b, .as_of = query.as_of, .binding = query.binding }, .{});
    defer a.free(json);
    const encoder = std.base64.url_safe_no_pad.Encoder;
    const encoded = try a.alloc(u8, encoder.calcSize(json.len));
    return encoder.encode(encoded, json);
}

test "search validates scope, enums, text and date windows" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const q = try parse(a, "users:a", .{ .q = " Needle ", .due = "range", .due_from = 1, .due_before = 2 }, 1000);
    try std.testing.expectEqualStrings("Needle", q.input.q);
    for ([_]Input{ .{ .workspace_id = "users:a" }, .{ .status = "bad" }, .{ .priority = "bad" }, .{ .assignee = "users:a" }, .{ .sort = "id;DELETE users" }, .{ .limit = 0 }, .{ .limit = 101 }, .{ .q = "\x00" }, .{ .q = "\xff" }, .{ .q = "x" ** 501 }, .{ .due = "range" }, .{ .due_from = 1 }, .{ .due = "range", .due_from = 2, .due_before = 1 } }) |invalid|
        try std.testing.expectError(error.InvalidInput, parse(a, "users:a", invalid, 1000));
}

test "search continuation binds actor, filters, sort and cutoff" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const first = try parse(a, "users:a", .{}, 1000);
    const token = try next(a, first, .{ .task = .{ .id = "tasks:a", .user_id = "users:a", .title = "A", .created_at = "" }, .n = -100, .s = "" });
    const second = try parse(a, "users:a", .{ .cursor = token }, 2000);
    try std.testing.expectEqual(@as(i64, 1000), second.as_of);
    try std.testing.expectEqualStrings("tasks:a", second.after.?.id);
    try std.testing.expectEqual(@as(i64, 1000), (try parse(a, "users:a", .{ .as_of = 1000 }, 2000)).as_of);
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", .{ .cursor = token, .as_of = 1001 }, 2000));
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", .{ .as_of = 2001 }, 2000));
    try std.testing.expectError(error.InvalidInput, parse(a, "users:b", .{ .cursor = token }, 2000));
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", .{ .cursor = token, .q = "new" }, 2000));
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", .{ .cursor = token, .sort = "title" }, 2000));
    try std.testing.expectError(error.InvalidInput, parse(a, "users:a", .{ .cursor = token }, 999));
    for ([_][]const u8{ "", "bad!", "e30", "a" ** 8193 }) |bad|
        try std.testing.expectError(error.InvalidInput, parse(a, "users:a", .{ .cursor = bad }, 2000));
}
