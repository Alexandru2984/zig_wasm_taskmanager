// SurrealDB HTTP Client for Zig
const std = @import("std");

pub const SurrealClient = struct {
    allocator: std.mem.Allocator,
    endpoint: []const u8,
    namespace: []const u8,
    database: []const u8,
    username: []const u8,
    password: []const u8,

    pub fn init(allocator: std.mem.Allocator) SurrealClient {
        return .{
            .allocator = allocator,
            .endpoint = "http://127.0.0.1:8000",
            .namespace = "taskapp",
            .database = "main",
            .username = "root",
            .password = "root",
        };
    }

    pub fn query(self: *SurrealClient, sql: []const u8) ![]u8 {
        var client = std.http.Client{ .allocator = self.allocator };
        defer client.deinit();

        const uri = std.Uri.parse(self.endpoint ++ "/sql") catch unreachable;

        var headers = std.http.Client.Request.Headers{};
        headers.content_type = .{ .override = "application/json" };
        headers.accept = .{ .override = "application/json" };

        var request = try client.open(.POST, uri, .{
            .server_header_buffer = try self.allocator.alloc(u8, 8192),
            .extra_headers = &.{
                .{ .name = "NS", .value = self.namespace },
                .{ .name = "DB", .value = self.database },
                .{ .name = "Accept", .value = "application/json" },
            },
        });
        defer request.deinit();

        // Set basic auth
        const auth = try std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ self.username, self.password });
        defer self.allocator.free(auth);
        const encoded = try encodeBase64(self.allocator, auth);
        defer self.allocator.free(encoded);
        
        request.headers.authorization = .{ .override = try std.fmt.allocPrint(self.allocator, "Basic {s}", .{encoded}) };

        try request.send();
        try request.writer().writeAll(sql);
        try request.finish();
        try request.wait();

        var body = std.ArrayList(u8).init(self.allocator);
        try request.reader().readAllArrayList(&body, 1024 * 1024);
        
        return body.toOwnedSlice();
    }
};

fn encodeBase64(allocator: std.mem.Allocator, input: []const u8) ![]u8 {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const output_len = ((input.len + 2) / 3) * 4;
    var output = try allocator.alloc(u8, output_len);
    
    var i: usize = 0;
    var j: usize = 0;
    while (i < input.len) {
        const a = input[i];
        const b = if (i + 1 < input.len) input[i + 1] else 0;
        const c = if (i + 2 < input.len) input[i + 2] else 0;
        
        output[j] = alphabet[a >> 2];
        output[j + 1] = alphabet[((a & 0x03) << 4) | (b >> 4)];
        output[j + 2] = if (i + 1 < input.len) alphabet[((b & 0x0f) << 2) | (c >> 6)] else '=';
        output[j + 3] = if (i + 2 < input.len) alphabet[c & 0x3f] else '=';
        
        i += 3;
        j += 4;
    }
    
    return output;
}
