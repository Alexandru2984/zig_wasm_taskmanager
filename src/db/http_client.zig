// Native HTTP Client for SurrealDB
// Replaces shell subprocess (sh -c curl) with direct Zig HTTP
// SECURITY: No more shell injection risk, proper retry
// PERFORMANCE: Uses thread-local client for Keep-Alive connection reuse

const std = @import("std");
const log = @import("../util/log.zig");
const config = @import("../config/config.zig");

pub const HttpError = error{
    ConnectionFailed,
    RequestFailed,
    ServerError,
    InvalidResponse,
    ResponseTooLarge,
    MissingConfig,
    QueryError,
    Conflict,
    PermissionDenied,
    InvalidOperation,
    NotFound,
    CapacityExceeded,
    ParentDeleted,
};

/// Database config
const DbConfig = struct {
    url: []const u8,
    ns: []const u8,
    db: []const u8,
    user: []const u8,
    pass: []const u8,
    database_auth: bool,
};

/// Get DB config from .env
fn getDbConfig() !DbConfig {
    const level = config.getOrDefault("SURREAL_AUTH_LEVEL", "root");
    if (!std.mem.eql(u8, level, "root") and !std.mem.eql(u8, level, "database")) return error.InvalidDbConfig;
    return DbConfig{
        .url = config.getRequired("SURREAL_URL") catch return HttpError.MissingConfig,
        .ns = config.getRequired("SURREAL_NS") catch return HttpError.MissingConfig,
        .db = config.getRequired("SURREAL_DB") catch return HttpError.MissingConfig,
        .user = config.getRequired("SURREAL_USER") catch return HttpError.MissingConfig,
        .pass = config.getRequired("SURREAL_PASS") catch return HttpError.MissingConfig,
        .database_auth = std.mem.eql(u8, level, "database"),
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

    const client = try getThreadLocalClient();
    var response_writer = std.Io.Writer.Allocating.init(allocator);
    defer response_writer.deinit();
    const headers = [_]std.http.Header{
        .{ .name = "Accept", .value = "application/json" },
        .{ .name = "Content-Type", .value = "application/surrealql" },
        .{ .name = "Authorization", .value = auth_header },
        .{ .name = "surreal-ns", .value = db_cfg.ns },
        .{ .name = "surreal-db", .value = db_cfg.db },
        .{ .name = "surreal-auth-ns", .value = db_cfg.ns },
        .{ .name = "surreal-auth-db", .value = db_cfg.db },
    };

    // A failed response can follow a committed write. Replaying arbitrary SQL
    // would duplicate creates or reverse toggles, so only the caller may retry
    // an operation whose idempotency it can establish.
    const result = try client.fetch(.{
        .location = .{ .url = url },
        .method = .POST,
        .payload = sql,
        .extra_headers = headers[0..if (db_cfg.database_auth) @as(usize, 7) else 5],
        .response_writer = &response_writer.writer,
    });
    if (result.status != .ok and result.status != .created and result.status != .accepted) {
        log.warn("Database request failed: HTTP {d}", .{@intFromEnum(result.status)});
        return HttpError.RequestFailed;
    }
    const raw = try response_writer.toOwnedSlice();
    errdefer allocator.free(raw);
    try validateSurrealResponse(allocator, raw);
    return raw;
}

fn validateSurrealResponse(allocator: std.mem.Allocator, raw_response: []const u8) !void {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw_response, .{}) catch {
        return HttpError.InvalidResponse;
    };
    defer parsed.deinit();

    switch (parsed.value) {
        .array => |arr| {
            // A rolled-back transaction contains generic failure rows before
            // its useful error. Classify conflicts without replaying the SQL.
            for (arr.items) |item| {
                if (item != .object) continue;
                const status = item.object.get("status") orelse continue;
                if (status != .string or !std.mem.eql(u8, status.string, "ERR")) continue;
                const result = item.object.get("result") orelse continue;
                if (result != .string) continue;
                if (std.mem.indexOf(u8, result.string, "APP_PARENT_DELETED") != null) return HttpError.ParentDeleted;
                if (std.mem.indexOf(u8, result.string, "APP_BUSY") != null) return HttpError.CapacityExceeded;
                if (std.mem.indexOf(u8, result.string, "APP_FORBIDDEN") != null) return HttpError.PermissionDenied;
                if (std.mem.indexOf(u8, result.string, "APP_INVALID") != null) return HttpError.InvalidOperation;
                if (std.mem.indexOf(u8, result.string, "APP_NOT_FOUND") != null) return HttpError.NotFound;
                if (std.mem.indexOf(u8, result.string, "Task changed; retry") != null or
                    std.mem.indexOf(u8, result.string, "APP_CONFLICT") != null or
                    std.mem.indexOf(u8, result.string, "This transaction can be retried") != null)
                    return HttpError.Conflict;
            }
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

/// A value that names a database record rather than being ordinary text.
///
/// SurrealDB 1.x coerced a plain string into a record id almost anywhere one
/// was expected. 3.x does so only in `SELECT ... FROM $x`; everywhere else a
/// string stays a string. `UPDATE $id` and `SET link = $id` raise an error,
/// which is at least loud — but `WHERE link = $id` simply matches nothing and
/// reports success, which is not. An authorization check written that way
/// fails closed and an ownership query returns an empty list, so the symptom
/// is "everything is gone", not "something is wrong".
///
/// Wrapping the value in this type makes the distinction explicit at the call
/// site and emits `type::record("…")`, so the database is told what the value
/// means instead of being left to guess.
pub const RecordId = struct { value: []const u8 };

/// Mark a bind value as a record id. See RecordId.
pub fn rec(id: []const u8) RecordId {
    return .{ .value = id };
}

/// A record id is `table:key`. Anything else is refused before it reaches the
/// database: `type::record()` would reject it anyway, but failing here keeps a
/// malformed id from costing a round trip and gives a single place to reason
/// about what shapes are accepted.
pub fn validRecordId(value: []const u8) bool {
    const colon = std.mem.indexOfScalar(u8, value, ':') orelse return false;
    if (colon == 0 or colon + 1 >= value.len) return false;

    for (value[0..colon]) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '_';
        if (!ok) return false;
    }
    // The key half is far more permissive in SurrealQL (it can be quoted, or a
    // number, or a ULID), but every id this application creates or accepts is
    // alphanumeric with underscores and dashes.
    for (value[colon + 1 ..]) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '_' or c == '-';
        if (!ok) return false;
    }
    return true;
}

pub fn validRecordIdFor(value: []const u8, table: []const u8) bool {
    return validRecordId(value) and std.mem.startsWith(u8, value, table) and
        value.len > table.len and value[table.len] == ':';
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

        if (FieldType == RecordId) {
            if (!validRecordId(value.value)) return error.InvalidRecordId;
            try writer.writeAll("type::record(");
            try writeEscapedElement(writer, value.value);
            try writer.writeAll(");\n");
        } else if (FieldType == ?RecordId) {
            if (value) |v| {
                if (!validRecordId(v.value)) return error.InvalidRecordId;
                try writer.writeAll("type::record(");
                try writeEscapedElement(writer, v.value);
                try writer.writeAll(");\n");
            } else {
                try writer.writeAll("NONE;\n");
            }
        } else if (FieldType == []const u8 or FieldType == []u8) {
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
    // SurrealDB 3 emits a null result for COMMIT after the explicit RETURN.
    const transaction = std.mem.endsWith(u8, std.mem.trim(u8, query_template, " \t\r\n"), "COMMIT TRANSACTION;");
    return try extractSurrealResult(allocator, raw_response, if (transaction) 2 else 1);
}

fn extractLastSurrealResult(allocator: std.mem.Allocator, raw_response: []const u8) ![]u8 {
    return extractSurrealResult(allocator, raw_response, 1);
}

fn extractSurrealResult(allocator: std.mem.Allocator, raw_response: []const u8, from_end: usize) ![]u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, raw_response, .{}) catch {
        return HttpError.InvalidResponse;
    };
    defer parsed.deinit();

    const arr = switch (parsed.value) {
        .array => |a| a,
        else => return HttpError.InvalidResponse,
    };
    if (arr.items.len == 0) return try allocator.dupe(u8, "[]");

    if (arr.items.len < from_end) return HttpError.InvalidResponse;
    const last = arr.items[arr.items.len - from_end];
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

test "transaction result is RETURN before COMMIT, including empty replay result" {
    const result = try extractSurrealResult(std.testing.allocator,
        \\[{"status":"OK","result":null},{"status":"OK","result":[]},{"status":"OK","result":null}]
    , 2);
    defer std.testing.allocator.free(result);
    try std.testing.expectEqualStrings("[{\"status\":\"OK\",\"result\":[]}]", result);
}

test "task references reject other tables and ranges" {
    try std.testing.expect(validRecordIdFor("tasks:abc_123", "tasks"));
    try std.testing.expect(!validRecordIdFor("workspace_members:abc", "tasks"));
    try std.testing.expect(!validRecordIdFor("tasks:abc..zzz", "tasks"));
    try std.testing.expect(!validRecordIdFor("tasks:", "tasks"));
}

test "validateSurrealResponse rejects Surreal ERR status" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(HttpError.QueryError, validateSurrealResponse(allocator,
        \\[{"time":"1ms","status":"ERR","result":"Parse error"}]
    ));
}

test "transaction conflicts are classified without treating user content as errors" {
    try std.testing.expectError(HttpError.Conflict, validateSurrealResponse(std.testing.allocator,
        \\[{"status":"ERR","result":"Transaction failed"},{"status":"ERR","result":"Task changed; retry"}]
    ));
    try validateSurrealResponse(std.testing.allocator,
        \\[{"status":"OK","result":"Task changed; retry"}]
    );
    try std.testing.expectError(HttpError.Conflict, validateSurrealResponse(std.testing.allocator,
        \\[{"status":"ERR","result":"The query was not executed due to a failed transaction"},{"status":"ERR","result":"Cannot COMMIT: Transaction conflict: Write conflict, retry the transaction. This transaction can be retried"}]
    ));
}

test "transaction authorization errors are classified past rollback rows" {
    try std.testing.expectError(HttpError.PermissionDenied, validateSurrealResponse(std.testing.allocator,
        \\[{"status":"ERR","result":"Transaction failed"},{"status":"ERR","result":"An error occurred: APP_FORBIDDEN"}]
    ));
    try std.testing.expectError(HttpError.InvalidOperation, validateSurrealResponse(std.testing.allocator,
        \\[{"status":"ERR","result":"APP_INVALID"}]
    ));
    try std.testing.expectError(HttpError.NotFound, validateSurrealResponse(std.testing.allocator,
        \\[{"status":"ERR","result":"APP_NOT_FOUND"}]
    ));
    try std.testing.expectError(HttpError.Conflict, validateSurrealResponse(std.testing.allocator,
        \\[{"status":"ERR","result":"APP_CONFLICT"}]
    ));
    try validateSurrealResponse(std.testing.allocator,
        \\[{"status":"OK","result":"APP_FORBIDDEN APP_INVALID APP_NOT_FOUND APP_CONFLICT"}]
    );
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

test "buildVarsQuery binds a record id as type::record" {
    const allocator = std.testing.allocator;
    const q = try buildVarsQuery(allocator, "SELECT * FROM $id;", .{ .id = rec("users:abc123") });
    defer allocator.free(q);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $id = type::record(\"users:abc123\");") != null);
}

test "buildVarsQuery refuses a malformed record id" {
    const allocator = std.testing.allocator;
    // No table part, no key part, and a table name that is not an identifier.
    try std.testing.expectError(error.InvalidRecordId, buildVarsQuery(allocator, "Q", .{ .id = rec("users") }));
    try std.testing.expectError(error.InvalidRecordId, buildVarsQuery(allocator, "Q", .{ .id = rec("users:") }));
    try std.testing.expectError(error.InvalidRecordId, buildVarsQuery(allocator, "Q", .{ .id = rec(":abc") }));
    try std.testing.expectError(error.InvalidRecordId, buildVarsQuery(allocator, "Q", .{ .id = rec("us\"ers:abc") }));
    // A record range would let one statement touch many rows.
    try std.testing.expectError(error.InvalidRecordId, buildVarsQuery(allocator, "Q", .{ .id = rec("tasks:a..z") }));
}

test "buildVarsQuery binds an optional record id" {
    const allocator = std.testing.allocator;
    const q = try buildVarsQuery(allocator, "Q", .{
        .some = @as(?RecordId, rec("tasks:t1")),
        .none = @as(?RecordId, null),
    });
    defer allocator.free(q);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $some = type::record(\"tasks:t1\");") != null);
    try std.testing.expect(std.mem.indexOf(u8, q, "LET $none = NONE;") != null);
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
