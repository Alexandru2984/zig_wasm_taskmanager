const std = @import("std");

pub fn parse(value: []const u8) !i64 {
    if (value.len < 4 or value.len > 19 or !std.mem.startsWith(u8, value, "\"v") or value[value.len - 1] != '"') return error.InvalidVersion;
    const digits = value[2 .. value.len - 1];
    if (std.mem.indexOfNone(u8, digits, "0123456789") != null or (digits.len > 1 and digits[0] == '0')) return error.InvalidVersion;
    const number = std.fmt.parseInt(i64, digits, 10) catch return error.InvalidVersion;
    if (number > 9007199254740991) return error.InvalidVersion;
    return number;
}

test "task version requires one exact strong tag with a safe integer" {
    try std.testing.expectEqual(@as(i64, 0), try parse("\"v0\""));
    try std.testing.expectEqual(@as(i64, 9007199254740991), try parse("\"v9007199254740991\""));
    for ([_][]const u8{ "", "*", "v1", "\"v\"", "W/\"v1\"", "\"v01\"", "\"v-1\"", "\"v1\", \"v2\"", "\"v9007199254740992\"" }) |value|
        try std.testing.expectError(error.InvalidVersion, parse(value));
}
