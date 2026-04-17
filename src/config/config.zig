// Unified Configuration Module (dotenv-ish)
// Parse .env files and provide typed getters for all app settings

const std = @import("std");

pub const StringHashMap = std.StringHashMap([]const u8);

var config: ?StringHashMap = null;
var config_allocator: ?std.mem.Allocator = null;

// ---------- Internal helpers ----------

fn trimWS(s: []const u8) []const u8 {
    return std.mem.trim(u8, s, " \t\r");
}

fn stripOptionalExport(key_raw: []const u8) []const u8 {
    const k = trimWS(key_raw);
    if (std.mem.startsWith(u8, k, "export")) {
        // Accept: "export KEY=VAL" (with any whitespace after export)
        const rest = trimWS(k["export".len..]);
        return rest;
    }
    return k;
}

// Remove inline comment starting with '#' only if '#' is outside quotes.
// Supports simple single/double quote toggling (doesn't fully parse escapes).
fn stripInlineComment(line: []const u8) []const u8 {
    var in_single = false;
    var in_double = false;

    var i: usize = 0;
    while (i < line.len) : (i += 1) {
        const c = line[i];
        if (c == '\'' and !in_double) {
            in_single = !in_single;
            continue;
        }
        if (c == '"' and !in_single) {
            in_double = !in_double;
            continue;
        }
        if (c == '#' and !in_single and !in_double) {
            return line[0..i];
        }
    }
    return line;
}

fn stripQuotes(value_raw: []const u8) []const u8 {
    var v = trimWS(value_raw);
    if (v.len >= 2) {
        const first = v[0];
        const last = v[v.len - 1];
        if ((first == '"' and last == '"') or (first == '\'' and last == '\'')) {
            v = v[1 .. v.len - 1];
        }
    }
    return v;
}

fn freeMapDeep(allocator: std.mem.Allocator, map: *StringHashMap) void {
    var it = map.iterator();
    while (it.next()) |entry| {
        allocator.free(entry.key_ptr.*);
        allocator.free(entry.value_ptr.*);
    }
    map.deinit();
}

// Put key/value (already owned) into map, freeing old entry if replaced.
// NOTE: fetchPut returns the replaced KV, but we must free both old key+value
// because we allocate a new key every time we parse.
fn putOwned(map: *StringHashMap, allocator: std.mem.Allocator, owned_key: []u8, owned_value: []u8) !void {
    if (try map.fetchPut(owned_key, owned_value)) |old| {
        allocator.free(old.key);
        allocator.free(old.value);
    }
}

// ---------- Parser ----------

pub fn parseEnvContent(allocator: std.mem.Allocator, content: []const u8) !StringHashMap {
    var map = StringHashMap.init(allocator);

    // If later we error mid-parse, free everything we already inserted
    errdefer freeMapDeep(allocator, &map);

    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |raw_line| {
        var line = trimWS(raw_line);
        if (line.len == 0) continue;
        if (line[0] == '#') continue;

        // Remove inline comments outside quotes
        line = trimWS(stripInlineComment(line));
        if (line.len == 0) continue;
        if (line[0] == '#') continue;

        const eq_pos = std.mem.indexOfScalar(u8, line, '=') orelse continue;

        const key_part = stripOptionalExport(line[0..eq_pos]);
        if (key_part.len == 0) continue;

        const value_part = line[eq_pos + 1 ..];
        const value_clean = stripQuotes(value_part);

        const owned_key = try allocator.dupe(u8, key_part);
        const owned_value = try allocator.dupe(u8, value_clean);

        try putOwned(&map, allocator, owned_key, owned_value);
    }

    return map;
}

pub fn parseEnvFile(allocator: std.mem.Allocator, filename: []const u8) !StringHashMap {
    const file = std.fs.cwd().openFile(filename, .{}) catch |err| {
        std.debug.print("❌ Cannot open {s}: {}\n", .{ filename, err });
        return err;
    };
    defer file.close();

    // Read entire file (bounded to avoid accidental huge allocations)
    // Adjust max_bytes if you expect large .env files.
    const max_bytes: usize = 1024 * 1024; // 1 MiB
    const content = try file.readToEndAlloc(allocator, max_bytes);
    defer allocator.free(content);

    return parseEnvContent(allocator, content);
}

// ---------- Public API ----------

pub fn load(allocator: std.mem.Allocator) !void {
    if (config != null) return; // Already loaded
    config = try parseEnvFile(allocator, ".env");
    config_allocator = allocator;
    std.debug.print("✅ Config loaded from .env\n", .{});
}

pub fn reload(allocator: std.mem.Allocator) !void {
    deinit();
    config = try parseEnvFile(allocator, ".env");
    config_allocator = allocator;
    std.debug.print("🔄 Config reloaded from .env\n", .{});
}

pub fn deinit() void {
    if (config) |*cfg| {
        const a = config_allocator orelse return;
        freeMapDeep(a, cfg);
        config = null;
        config_allocator = null;
    }
}

pub fn isLoaded() bool {
    return config != null;
}

pub fn get(key: []const u8) ?[]const u8 {
    if (config) |cfg| return cfg.get(key);
    return null;
}

pub fn getRequired(key: []const u8) ![]const u8 {
    if (get(key)) |value| return value;
    std.debug.print("❌ Missing required config: {s}\n", .{key});
    return error.MissingRequiredConfig;
}

pub fn getOrDefault(key: []const u8, default_value: []const u8) []const u8 {
    return get(key) orelse default_value;
}

// ---------- Tests ----------

test "parseEnvContent basic" {
    const allocator = std.testing.allocator;
    const content = "# Comment\nKEY1=value1\nKEY2=\"quoted value\"\nKEY3='single'\n  KEY4 = spaced  \nexport KEY5=hello\nKEY6=value # inline\n";

    var map = try parseEnvContent(allocator, content);
    defer freeMapDeep(allocator, &map);

    try std.testing.expectEqualStrings("value1", map.get("KEY1").?);
    try std.testing.expectEqualStrings("quoted value", map.get("KEY2").?);
    try std.testing.expectEqualStrings("single", map.get("KEY3").?);
    try std.testing.expectEqualStrings("spaced", map.get("KEY4").?);
    try std.testing.expectEqualStrings("hello", map.get("KEY5").?);
    try std.testing.expectEqualStrings("value", map.get("KEY6").?);
}

