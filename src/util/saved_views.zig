const std = @import("std");
const models = @import("../domain/models.zig");
const ids = @import("../db/http_client.zig");

fn choice(value: []const u8, choices: []const []const u8) bool {
    for (choices) |item| if (std.mem.eql(u8, value, item)) return true;
    return false;
}

fn safeText(value: []const u8, max: usize) bool {
    if (value.len > max or !std.unicode.utf8ValidateSlice(value)) return false;
    for (value) |byte| if (byte < 32 or byte == 127) return false;
    return true;
}

pub fn valid(input: models.SaveViewsRequest) bool {
    if (!ids.validRecordIdFor(input.expected_membership, "workspace_members") or input.expected_version < 0 or input.expected_version >= 9007199254740991 or input.items.len > 12) return false;
    for (input.items, 0..) |item, index| {
        if (item.id.len == 0 or item.id.len > 64) return false;
        for (item.id) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '-' and byte != '_') return false;
        if (!safeText(item.name, 192) or std.mem.trim(u8, item.name, " ").len == 0 or
            (std.unicode.utf8CountCodepoints(item.name) catch return false) > 48 or
            !safeText(item.search, 500) or !safeText(item.tagFilter orelse "", 128)) return false;
        if (!choice(item.filter, &.{ "all", "active", "completed", "overdue", "high", "today", "upcoming" }) or
            !choice(item.sort, &.{ "created_desc", "created_asc", "due_asc", "priority", "title" }) or
            !choice(item.view, &.{ "list", "board" })) return false;
        for (input.items[0..index]) |previous| if (std.mem.eql(u8, item.id, previous.id)) return false;
    }
    return true;
}

test "saved views validate scope, revision, limits, enums and unique opaque IDs" {
    var item = models.SavedView{ .id = "view_1", .name = "Focus <work>", .search = "", .filter = "today", .tagFilter = null, .sort = "priority", .view = "board" };
    var input = models.SaveViewsRequest{ .expected_membership = "workspace_members:one", .expected_version = 0, .items = &.{item} };
    try std.testing.expect(valid(input));
    input.items = &.{ item, item };
    try std.testing.expect(!valid(input));
    input.items = &.{};
    try std.testing.expect(valid(input));
    input.expected_version = 9007199254740991;
    try std.testing.expect(!valid(input));
    input.expected_version = 0;
    input.expected_membership = "users:one";
    try std.testing.expect(!valid(input));
    input.expected_membership = "workspace_members:one";
    item.search = "x" ** 501;
    input.items = &.{item};
    try std.testing.expect(!valid(input));
    item.search = "";
    item.filter = "sql";
    input.items = &.{item};
    try std.testing.expect(!valid(input));
    item.filter = "all";
    item.name = "\n";
    input.items = &.{item};
    try std.testing.expect(!valid(input));
}
