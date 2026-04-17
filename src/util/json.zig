// JSON Parsing Helper Module
// SECURITY: Uses std.json for proper parsing instead of string search
// Handles: spaces, escaped quotes, field order, different types
const std = @import("std");

/// Generic JSON value type for flexible field access
pub const JsonValue = union(enum) {
    string: []const u8,
    integer: i64,
    float: f64,
    boolean: bool,
    null_value: void,
    object: std.json.ObjectMap,
    array: std.json.Array,
};

/// Parse a JSON string and extract a string field by name
/// Returns null if field doesn't exist or isn't a string
pub fn getString(allocator: std.mem.Allocator, json_str: []const u8, field_name: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, json_str, .{}) catch return null;
    defer parsed.deinit();
    
    return getStringFromValue(allocator, parsed.value, field_name);
}

/// Extract string from parsed JSON value
fn getStringFromValue(allocator: std.mem.Allocator, value: std.json.Value, field_name: []const u8) ?[]const u8 {
    switch (value) {
        .object => |obj| {
            if (obj.get(field_name)) |field_value| {
                switch (field_value) {
                    .string => |s| return allocator.dupe(u8, s) catch null,
                    else => return null,
                }
            }
        },
        .array => |arr| {
            // For SurrealDB results which are arrays of [{"result": [...]}]
            if (arr.items.len > 0) {
                // Check first item
                return getStringFromValue(allocator, arr.items[0], field_name);
            }
        },
        else => {},
    }
    return null;
}

/// Parse request body JSON and extract fields
/// If the JSON has a "result" array (SurrealDB format), extracts from first result
pub fn parseRequestBody(allocator: std.mem.Allocator, body: []const u8, field_name: []const u8) ?[]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, body, .{}) catch {
        return null;
    };
    defer parsed.deinit();
    
    return extractField(allocator, parsed.value, field_name);
}

fn extractField(allocator: std.mem.Allocator, value: std.json.Value, field_name: []const u8) ?[]const u8 {
    switch (value) {
        .object => |obj| {
            // Direct field access
            if (obj.get(field_name)) |field_value| {
                return valueToString(allocator, field_value);
            }
            // Check for "result" array (SurrealDB format)
            if (obj.get("result")) |result| {
                return extractField(allocator, result, field_name);
            }
        },
        .array => |arr| {
            if (arr.items.len > 0) {
                return extractField(allocator, arr.items[0], field_name);
            }
        },
        else => {
        },
    }
    return null;
}

fn valueToString(allocator: std.mem.Allocator, value: std.json.Value) ?[]const u8 {
    switch (value) {
        .string => |s| return allocator.dupe(u8, s) catch null,
        .integer => |i| return std.fmt.allocPrint(allocator, "{d}", .{i}) catch null,
        .float => |f| return std.fmt.allocPrint(allocator, "{d}", .{f}) catch null,
        .bool => |b| return if (b) allocator.dupe(u8, "true") catch null else allocator.dupe(u8, "false") catch null,
        else => return null,
    }
}

/// Check if a boolean field is true
pub fn getBool(allocator: std.mem.Allocator, json_str: []const u8, field_name: []const u8) ?bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, json_str, .{}) catch return null;
    defer parsed.deinit();
    
    return getBoolFromValue(parsed.value, field_name);
}

fn getBoolFromValue(value: std.json.Value, field_name: []const u8) ?bool {
    switch (value) {
        .object => |obj| {
            if (obj.get(field_name)) |field_value| {
                switch (field_value) {
                    .bool => |b| return b,
                    else => return null,
                }
            }
        },
        .array => |arr| {
            if (arr.items.len > 0) {
                return getBoolFromValue(arr.items[0], field_name);
            }
        },
        else => {},
    }
    return null;
}

// Tests
test "getString basic" {
    const allocator = std.testing.allocator;
    const result = getString(allocator, "{\"email\":\"test@example.com\"}", "email");
    defer if (result) |r| allocator.free(r);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("test@example.com", result.?);
}

test "getString with spaces" {
    const allocator = std.testing.allocator;
    const result = getString(allocator, "{ \"email\" : \"test@example.com\" }", "email");
    defer if (result) |r| allocator.free(r);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("test@example.com", result.?);
}

test "getString missing field" {
    const allocator = std.testing.allocator;
    const result = getString(allocator, "{\"name\":\"Test\"}", "email");
    try std.testing.expect(result == null);
}

test "getString with escaped quotes" {
    const allocator = std.testing.allocator;
    const result = getString(allocator, "{\"msg\":\"He said \\\"hello\\\"\"}", "msg");
    defer if (result) |r| allocator.free(r);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("He said \"hello\"", result.?);
}

test "getBool true" {
    const allocator = std.testing.allocator;
    const result = getBool(allocator, "{\"active\":true}", "active");
    try std.testing.expect(result != null);
    try std.testing.expect(result.? == true);
}

test "getBool false" {
    const allocator = std.testing.allocator;
    const result = getBool(allocator, "{\"active\":false}", "active");
    try std.testing.expect(result != null);
    try std.testing.expect(result.? == false);
}

test "parseRequestBody nested result array" {
    const allocator = std.testing.allocator;
    // SurrealDB-style response format
    const json = "{\"result\":[{\"id\":\"users:123\",\"name\":\"Alex\"}]}";
    const id = parseRequestBody(allocator, json, "id");
    defer if (id) |r| allocator.free(r);
    try std.testing.expect(id != null);
    try std.testing.expectEqualStrings("users:123", id.?);
}

test "invalid JSON returns null" {
    const allocator = std.testing.allocator;
    const result = getString(allocator, "not valid json", "field");
    try std.testing.expect(result == null);
}

