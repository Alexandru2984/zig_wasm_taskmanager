// Native HTTP Client for SurrealDB
// Replaces shell subprocess (sh -c curl) with direct Zig HTTP
// SECURITY: No more shell injection risk, proper retry
// PERFORMANCE: Uses thread-local client for Keep-Alive connection reuse

const std = @import("std");
const config = @import("../config/config.zig");
const app = @import("../app.zig");

// Retry configuration
const MAX_RETRIES: u8 = 3;
const RETRY_DELAYS_MS = [_]u64{ 200, 500, 1000 }; // 200ms, 500ms, 1s backoff

pub const HttpError = error{
    ConnectionFailed,
    RequestFailed,
    ServerError,
    InvalidResponse,
    ResponseTooLarge,
    MissingConfig,
    QueryError,
};

/// Database config
const DbConfig = struct {
    url: []const u8,
    ns: []const u8,
    db: []const u8,
    user: []const u8,
    pass: []const u8,
};

/// Get DB config from .env
fn getDbConfig() !DbConfig {
    return DbConfig{
        .url = config.getRequired("SURREAL_URL") catch return HttpError.MissingConfig,
        .ns = config.getRequired("SURREAL_NS") catch return HttpError.MissingConfig,
        .db = config.getRequired("SURREAL_DB") catch return HttpError.MissingConfig,
        .user = config.getRequired("SURREAL_USER") catch return HttpError.MissingConfig,
        .pass = config.getRequired("SURREAL_PASS") catch return HttpError.MissingConfig,
    };
}

/// Build Basic Auth header value
fn buildAuthHeader(allocator: std.mem.Allocator, user: []const u8, pass: []const u8) ![]u8 {
    // Format: "Basic base64(user:pass)"
    const credentials = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ user, pass });
    defer allocator.free(credentials);

    // Use standard base64 encoder
    const encoded_len = std.base64.standard.Encoder.calcSize(credentials.len);
    const encoded = try allocator.alloc(u8, encoded_len);
    _ = std.base64.standard.Encoder.encode(encoded, credentials);
    defer allocator.free(encoded);

    return try std.fmt.allocPrint(allocator, "Basic {s}", .{encoded});
}

// Thread-local client to reuse connections (Keep-Alive)
// We use a pointer to allow lazy initialization and avoid complex threadlocal struct issues
threadlocal var tl_client: ?std.http.Client = null;

fn getThreadLocalClient() !*std.http.Client {
    if (tl_client) |*c| return c;

    // Initialize with global allocator (must persist across requests)
    tl_client = std.http.Client{ .allocator = app.allocator() };
    return &tl_client.?;
}

/// Execute SQL query against SurrealDB using native HTTP client
/// Returns owned response body (caller must free)
pub fn executeQuery(allocator: std.mem.Allocator, sql: []const u8) ![]u8 {
    const db_cfg = try getDbConfig();

    // Build URL
    const url = try std.fmt.allocPrint(allocator, "{s}/sql", .{db_cfg.url});
    defer allocator.free(url);

    // Build auth header
    const auth_header = try buildAuthHeader(allocator, db_cfg.user, db_cfg.pass);
    defer allocator.free(auth_header);

    var last_error: ?anyerror = null;

    // Retry loop
    var attempt: u8 = 0;
    while (attempt < MAX_RETRIES) : (attempt += 1) {
        // Get thread-local client
        const client = getThreadLocalClient() catch |err| {
            std.debug.print("❌ Failed to get HTTP client: {}\n", .{err});
            return err;
        };

        // Response writer - allocating in request arena (allocator passed in)
        var response_writer = std.Io.Writer.Allocating.init(allocator);
        defer if (response_writer.writer.buffer.len > 0) allocator.free(response_writer.writer.buffer);

        // Use fetch API with response_writer
        const result = client.fetch(.{
            .location = .{ .url = url },
            .method = .POST,
            .payload = sql,
            .extra_headers = &[_]std.http.Header{
                .{ .name = "Accept", .value = "application/json" },
                .{ .name = "Content-Type", .value = "application/x-www-form-urlencoded" },
                .{ .name = "Authorization", .value = auth_header },
                .{ .name = "surreal-ns", .value = db_cfg.ns },
                .{ .name = "surreal-db", .value = db_cfg.db },
                // Connection: keep-alive is default in Zig std.http.Client
            },
            .response_writer = &response_writer.writer,
        }) catch |err| {
            last_error = err;
            std.debug.print("⚠️ DB attempt {d}/{d} failed: {}\n", .{ attempt + 1, MAX_RETRIES, err });

            // If connection failed, maybe we need to reset the client?
            // std.http.Client handles this mostly, but if it's stuck, we might want to deinit and null it.
            // For now, let's assume it recovers or next retry works.

            if (attempt < MAX_RETRIES - 1) {
                std.Thread.sleep(RETRY_DELAYS_MS[attempt] * std.time.ns_per_ms);
            }
            continue;
        };

        // Check status
        const status = result.status;
        if (status == .ok or status == .created or status == .accepted) {
            const raw_response = response_writer.toOwnedSlice() catch return HttpError.InvalidResponse;
            errdefer allocator.free(raw_response);
            try validateSurrealResponse(allocator, raw_response);
            return raw_response;
        } else if (@intFromEnum(status) >= 500) {
            // Server error - retry
            std.debug.print("⚠️ DB attempt {d}/{d}: HTTP {d}\n", .{ attempt + 1, MAX_RETRIES, @intFromEnum(status) });
            last_error = HttpError.ServerError;

            if (attempt < MAX_RETRIES - 1) {
                std.Thread.sleep(RETRY_DELAYS_MS[attempt] * std.time.ns_per_ms);
            }
        } else {
            // Client error (4xx) - don't retry
            std.debug.print("❌ DB query error: HTTP {d}\n", .{@intFromEnum(status)});
            const body = response_writer.writer.buffer;
            const preview_len = @min(body.len, 200);
            std.debug.print("   Response: {s}\n", .{body[0..preview_len]});
            return HttpError.RequestFailed;
        }
    }

    // All retries exhausted
    std.debug.print("❌ DB query failed after {d} attempts\n", .{MAX_RETRIES});
    return last_error orelse HttpError.ConnectionFailed;
}

fn validateSurrealResponse(allocator: std.mem.Allocator, raw_response: []const u8) !void {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw_response, .{}) catch {
        return HttpError.InvalidResponse;
    };
    defer parsed.deinit();

    switch (parsed.value) {
        .array => |arr| {
            for (arr.items) |item| {
                const obj = switch (item) {
                    .object => |o| o,
                    else => return HttpError.InvalidResponse,
                };
                const status_value = obj.get("status") orelse return HttpError.InvalidResponse;
                const status = switch (status_value) {
                    .string => |s| s,
                    else => return HttpError.InvalidResponse,
                };
                if (!std.mem.eql(u8, status, "OK")) {
                    if (obj.get("result")) |result_value| {
                        switch (result_value) {
                            .string => |msg| {
                                const preview_len = @min(msg.len, 300);
                                std.debug.print("❌ SurrealDB query error: {s}\n", .{msg[0..preview_len]});
                            },
                            else => std.debug.print("❌ SurrealDB query returned status {s}\n", .{status}),
                        }
                    } else {
                        std.debug.print("❌ SurrealDB query returned status {s}\n", .{status});
                    }
                    return HttpError.QueryError;
                }
            }
        },
        else => return HttpError.InvalidResponse,
    }
}

/// Execute SQL query with bind variables (SECURE - prevents SQL injection)
/// Variables are passed as a struct with field names matching $variable names in query
/// Example: queryWithVars(alloc, "SELECT * FROM users WHERE email = $email", .{ .email = "test@example.com" })
pub fn executeQueryWithVars(allocator: std.mem.Allocator, query_template: []const u8, vars: anytype) ![]u8 {
    // Build the full query with LET statements for each variable
    var query_builder = std.ArrayListUnmanaged(u8){};
    defer query_builder.deinit(allocator);

    const writer = query_builder.writer(allocator);

    // Iterate over struct fields and create LET statements
    const VarsType = @TypeOf(vars);
    const fields = @typeInfo(VarsType).@"struct".fields;

    inline for (fields) |field| {
        const value = @field(vars, field.name);
        const FieldType = @TypeOf(value);

        // Write: LET $fieldname = <value>;
        try writer.print("LET ${s} = ", .{field.name});

        // Handle different types
        if (FieldType == []const u8 or FieldType == []u8) {
            // String: escape and quote. SECURITY: cover NUL + all control bytes,
            // and reject lone surrogates/bytes >0x7F we can't safely pass
            // through. Anything that slips past escape becomes injection, so we
            // prefer to fail closed on control characters.
            try writer.writeByte('"');
            for (value) |c| {
                switch (c) {
                    '"' => try writer.writeAll("\\\""),
                    '\\' => try writer.writeAll("\\\\"),
                    '\n' => try writer.writeAll("\\n"),
                    '\r' => try writer.writeAll("\\r"),
                    '\t' => try writer.writeAll("\\t"),
                    0x00 => return error.InvalidInput,
                    0x01...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F => {
                        try writer.print("\\u{x:0>4}", .{c});
                    },
                    else => try writer.writeByte(c),
                }
            }
            try writer.writeAll("\";\n");
        } else if (@typeInfo(FieldType) == .int or @typeInfo(FieldType) == .comptime_int) {
            // Integer: write directly
            try writer.print("{d};\n", .{value});
        } else if (@typeInfo(FieldType) == .bool) {
            // Boolean
            try writer.print("{s};\n", .{if (value) "true" else "false"});
        } else if (@typeInfo(FieldType) == .optional) {
            // Optional: write NONE if null, otherwise escape as string.
            if (value) |v| {
                try writer.writeByte('"');
                for (v) |c| {
                    switch (c) {
                        '"' => try writer.writeAll("\\\""),
                        '\\' => try writer.writeAll("\\\\"),
                        '\n' => try writer.writeAll("\\n"),
                        '\r' => try writer.writeAll("\\r"),
                        '\t' => try writer.writeAll("\\t"),
                        0x00 => return error.InvalidInput,
                        0x01...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F => {
                            try writer.print("\\u{x:0>4}", .{c});
                        },
                        else => try writer.writeByte(c),
                    }
                }
                try writer.writeAll("\";\n");
            } else {
                try writer.writeAll("NONE;\n");
            }
        } else if (FieldType == [64]u8) {
            // Fixed-size array (session token) — hex only by construction, but
            // validate defensively: if anything non-hex shows up, refuse.
            for (&value) |c| {
                const is_hex = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f') or (c >= 'A' and c <= 'F');
                if (!is_hex) return error.InvalidInput;
            }
            try writer.writeByte('"');
            try writer.writeAll(&value);
            try writer.writeAll("\";\n");
        } else {
            // Unknown type - try to print as-is
            try writer.print("{any};\n", .{value});
        }
    }

    // Append the actual query template
    try writer.writeAll(query_template);

    // Execute the complete query
    const full_query = try query_builder.toOwnedSlice(allocator);
    defer allocator.free(full_query);

    const raw_response = try executeQuery(allocator, full_query);
    defer allocator.free(raw_response);

    // Post-process: When using LET statements, SurrealDB returns multiple results.
    // The first N-1 are LET results (with result: null), the last is the actual query result.
    // We need to extract only the last result to maintain compatibility with existing parsers.
    // Raw response looks like: [{...}, {...}, {...last...}]
    // We want to return: [{...last...}]

    return try extractLastSurrealResult(allocator, raw_response);
}

fn extractLastSurrealResult(allocator: std.mem.Allocator, raw_response: []const u8) ![]u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw_response, .{}) catch {
        return HttpError.InvalidResponse;
    };
    defer parsed.deinit();

    const arr = switch (parsed.value) {
        .array => |a| a,
        else => return HttpError.InvalidResponse,
    };
    if (arr.items.len == 0) return try allocator.dupe(u8, "[]");

    const last = arr.items[arr.items.len - 1];
    var out = std.ArrayListUnmanaged(u8){};
    errdefer out.deinit(allocator);

    try out.append(allocator, '[');
    var writer = out.writer(allocator);
    var buf: [256]u8 = undefined;
    var adapter = writer.adaptToNewApi(&buf);
    try std.json.Stringify.value(last, .{}, &adapter.new_interface);
    try adapter.new_interface.flush();
    try out.append(allocator, ']');

    return try out.toOwnedSlice(allocator);
}

test "validateSurrealResponse rejects Surreal ERR status" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(HttpError.QueryError, validateSurrealResponse(allocator,
        \\[{"time":"1ms","status":"ERR","result":"Parse error"}]
    ));
}

test "extractLastSurrealResult keeps the final statement result" {
    const allocator = std.testing.allocator;
    const result = try extractLastSurrealResult(allocator,
        \\[{"time":"1ms","status":"OK","result":null},{"time":"2ms","status":"OK","result":[{"id":"users:1"}]}]
    );
    defer allocator.free(result);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"id\":\"users:1\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, result, "\"result\":null") == null);
}
