// Native HTTP Client for SurrealDB
// Replaces shell subprocess (sh -c curl) with direct Zig HTTP
// SECURITY: No more shell injection risk, proper retry
// PERFORMANCE: Uses thread-local client for Keep-Alive connection reuse

const std = @import("std");
const log = @import("../util/log.zig");
const config = @import("../config/config.zig");

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

    // The pooled connections live for the whole life of the worker thread, not
    // for any single request. Back them with the process-wide smp allocator
    // (thread-safe, reclaimed by the OS at exit) instead of the request-tracking
    // GPA, so the keep-alive pool isn't flagged as a leak on shutdown.
    tl_client = std.http.Client{ .allocator = std.heap.smp_allocator };
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
            log.warn("❌ Failed to get HTTP client: {}", .{err});
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
            log.warn("⚠️ DB attempt {d}/{d} failed: {}", .{ attempt + 1, MAX_RETRIES, err });

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
            log.warn("⚠️ DB attempt {d}/{d}: HTTP {d}", .{ attempt + 1, MAX_RETRIES, @intFromEnum(status) });
            last_error = HttpError.ServerError;

            if (attempt < MAX_RETRIES - 1) {
                std.Thread.sleep(RETRY_DELAYS_MS[attempt] * std.time.ns_per_ms);
            }
        } else {
            // Client error (4xx) - don't retry
            log.warn("❌ DB query error: HTTP {d}", .{@intFromEnum(status)});
            const body = response_writer.writer.buffer;
            const preview_len = @min(body.len, 200);
            log.warn("   Response: {s}", .{body[0..preview_len]});
            return HttpError.RequestFailed;
        }
    }

    // All retries exhausted
    log.warn("❌ DB query failed after {d} attempts", .{MAX_RETRIES});
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
                                log.warn("❌ SurrealDB query error: {s}", .{msg[0..preview_len]});
                            },
                            else => log.warn("❌ SurrealDB query returned status {s}", .{status}),
                        }
                    } else {
                        log.warn("❌ SurrealDB query returned status {s}", .{status});
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
/// Append a SurrealQL double-quoted string literal, escaping everything that
/// could break out of the quotes. SECURITY: this is the core anti-injection
/// step — control bytes are \u-encoded and NUL is rejected (fail closed).
fn writeEscapedString(writer: anytype, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            0x00 => return error.InvalidInput,
            0x01...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F => try writer.print("\\u{x:0>4}", .{c}),
            else => try writer.writeByte(c),
        }
    }
    try writer.writeAll("\";\n");
}

/// Same escaping as writeEscapedString, but without the trailing `;\n` that
/// terminates a LET statement — used for elements inside an array literal.
fn writeEscapedElement(writer: anytype, value: []const u8) !void {
    try writer.writeByte('"');
    for (value) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            0x00 => return error.InvalidInput,
            0x01...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F => try writer.print("\\u{x:0>4}", .{c}),
            else => try writer.writeByte(c),
        }
    }
    try writer.writeByte('"');
}

/// Build the full SurrealQL string for a parameterized query: a `LET $x = ...`
/// prefix per bind variable, followed by the template. Kept separate from
/// execution so the escaping can be unit-tested without a live database.
fn buildVarsQuery(allocator: std.mem.Allocator, query_template: []const u8, vars: anytype) ![]u8 {
    var query_builder = std.ArrayListUnmanaged(u8){};
    defer query_builder.deinit(allocator);

    const writer = query_builder.writer(allocator);

    const VarsType = @TypeOf(vars);
    const fields = @typeInfo(VarsType).@"struct".fields;

    inline for (fields) |field| {
        const value = @field(vars, field.name);
        const FieldType = @TypeOf(value);

        try writer.print("LET ${s} = ", .{field.name});

        if (FieldType == []const u8 or FieldType == []u8) {
            try writeEscapedString(writer, value);
        } else if (@typeInfo(FieldType) == .int or @typeInfo(FieldType) == .comptime_int) {
            try writer.print("{d};\n", .{value});
        } else if (@typeInfo(FieldType) == .bool) {
            try writer.print("{s};\n", .{if (value) "true" else "false"});
        } else if (@typeInfo(FieldType) == .optional) {
            if (value) |v| {
                const Child = @TypeOf(v);
                if (Child == []const u8 or Child == []u8) {
                    try writeEscapedString(writer, v);
                } else if (@typeInfo(Child) == .int) {
                    try writer.print("{d};\n", .{v});
                } else if (@typeInfo(Child) == .bool) {
                    try writer.print("{s};\n", .{if (v) "true" else "false"});
                } else {
                    @compileError("queryWithVars: unsupported optional bind type " ++ @typeName(Child));
                }
            } else {
                try writer.writeAll("NONE;\n");
            }
        } else if (FieldType == []const []const u8) {
            // Array of strings (task tags). Each element goes through the same
            // escaper as a scalar string, so an element cannot terminate its
            // own literal and break out into the surrounding query.
            try writer.writeByte('[');
            for (value, 0..) |item, i| {
                if (i > 0) try writer.writeAll(", ");
                try writeEscapedElement(writer, item);
            }
            try writer.writeAll("];\n");
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
            // SECURITY: refuse to bind any type we don't have an explicit,
            // escaped encoding for. A silent fallback could emit an unescaped
            // value straight into the query. Fires at compile time only if a
            // call site actually uses such a type.
            @compileError("queryWithVars: unsupported bind type " ++ @typeName(FieldType));
        }
    }

    try writer.writeAll(query_template);
    return try query_builder.toOwnedSlice(allocator);
}

/// Execute SQL query with bind variables (SECURE - prevents SQL injection).
/// Variables are passed as a struct with field names matching $variable names.
/// Example: queryWithVars(alloc, "SELECT * FROM users WHERE email = $email", .{ .email = "a@b.c" })
pub fn executeQueryWithVars(allocator: std.mem.Allocator, query_template: []const u8, vars: anytype) ![]u8 {
    const full_query = try buildVarsQuery(allocator, query_template, vars);
    defer allocator.free(full_query);

    const raw_response = try executeQuery(allocator, full_query);
    defer allocator.free(raw_response);

    // With LET prefixes SurrealDB returns one result per statement; keep only
    // the last (the actual query), matching what the callers' parsers expect.
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

test "buildVarsQuery escapes injection attempts in string values" {
    const allocator = std.testing.allocator;
    const payload: []const u8 = "x\" OR true; --";
    const q = try buildVarsQuery(allocator, "SELECT * FROM users WHERE email = $email;", .{ .email = payload });
    defer allocator.free(q);
    // The closing quote in the payload must be escaped so it can't end the literal.
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $email = \"x\\\" OR true; --\";") != null);
    // The template is appended verbatim after the LET prefix.
    try std.testing.expect(std.mem.endsWith(u8, q, "SELECT * FROM users WHERE email = $email;"));
}

test "buildVarsQuery rejects NUL bytes (fail closed)" {
    const allocator = std.testing.allocator;
    const nul: []const u8 = "a\x00b";
    try std.testing.expectError(error.InvalidInput, buildVarsQuery(allocator, "X", .{ .v = nul }));
}

test "buildVarsQuery escapes control bytes" {
    const allocator = std.testing.allocator;
    const ctrl: []const u8 = "a\x01b";
    const q = try buildVarsQuery(allocator, "Q", .{ .v = ctrl });
    defer allocator.free(q);
    try std.testing.expect(std.mem.indexOf(u8, q, "\\u0001") != null);
}

test "buildVarsQuery escapes string array elements" {
    const allocator = std.testing.allocator;
    const tags: []const []const u8 = &.{ "work", "a\" OR true --" };
    const q = try buildVarsQuery(allocator, "Q", .{ .tags = tags });
    defer allocator.free(q);
    // The quote inside the second element must be escaped so it cannot close
    // its literal and let the rest of the element become query text.
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $tags = [\"work\", \"a\\\" OR true --\"];") != null);
}

test "buildVarsQuery emits an empty array literal, not NONE" {
    const allocator = std.testing.allocator;
    const tags: []const []const u8 = &.{};
    const q = try buildVarsQuery(allocator, "Q", .{ .tags = tags });
    defer allocator.free(q);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $tags = [];") != null);
}

test "buildVarsQuery rejects NUL inside an array element" {
    const allocator = std.testing.allocator;
    const tags: []const []const u8 = &.{"a\x00b"};
    try std.testing.expectError(error.InvalidInput, buildVarsQuery(allocator, "Q", .{ .tags = tags }));
}

test "buildVarsQuery encodes optional bools and ints" {
    const allocator = std.testing.allocator;
    const q = try buildVarsQuery(allocator, "Q", .{
        .done = @as(?bool, true),
        .n = @as(?i64, 7),
        .missing = @as(?bool, null),
    });
    defer allocator.free(q);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $done = true;") != null);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $n = 7;") != null);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $missing = NONE;") != null);
}

test "buildVarsQuery encodes ints, bools and NONE optionals" {
    const allocator = std.testing.allocator;
    const q = try buildVarsQuery(allocator, "Q", .{ .n = @as(i64, 42), .b = true, .opt = @as(?[]const u8, null) });
    defer allocator.free(q);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $n = 42;") != null);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $b = true;") != null);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $opt = NONE;") != null);
}
