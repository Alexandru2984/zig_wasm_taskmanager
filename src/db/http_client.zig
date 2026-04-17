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
            // Success! Return owned slice (only written bytes, not full capacity)
            return response_writer.toOwnedSlice() catch return HttpError.InvalidResponse;
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
            // String: escape and quote
            try writer.writeByte('"');
            for (value) |c| {
                switch (c) {
                    '"' => try writer.writeAll("\\\""),
                    '\\' => try writer.writeAll("\\\\"),
                    '\n' => try writer.writeAll("\\n"),
                    '\r' => try writer.writeAll("\\r"),
                    '\t' => try writer.writeAll("\\t"),
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
            // Optional: write NONE if null, otherwise unwrap
            if (value) |v| {
                // Recursively handle the inner type - for now assume string
                try writer.writeByte('"');
                for (v) |c| {
                    switch (c) {
                        '"' => try writer.writeAll("\\\""),
                        '\\' => try writer.writeAll("\\\\"),
                        else => try writer.writeByte(c),
                    }
                }
                try writer.writeAll("\";\n");
            } else {
                try writer.writeAll("NONE;\n");
            }
        } else if (FieldType == [64]u8) {
            // Fixed-size array (token) - treat as string
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
    
    // Find the last '{' before the final '}]'
    if (raw_response.len < 3 or raw_response[0] != '[') {
        // Not a JSON array, return as-is (shouldn't happen)
        return try allocator.dupe(u8, raw_response);
    }
    
    // Find the last complete object in the array
    var depth: i32 = 0;
    var last_obj_start: ?usize = null;
    var i: usize = raw_response.len;
    while (i > 0) {
        i -= 1;
        const c = raw_response[i];
        if (c == '}') {
            if (depth == 0) {
                // This is the end of the last object
            }
            depth += 1;
        } else if (c == '{') {
            depth -= 1;
            if (depth == 0) {
                // Found the start of the last object
                last_obj_start = i;
                break;
            }
        }
    }
    
    if (last_obj_start) |start| {
        // Extract just the last object, wrapped in an array
        var result = std.ArrayListUnmanaged(u8){};
        try result.append(allocator, '[');
        try result.appendSlice(allocator, raw_response[start..]);
        // raw_response ends with ']', so we need to remove any trailing junk and ensure it's "]"
        // Actually raw_response[start..] should give us "{...}]", we want "[{...}]"
        // So we need to find where the object ends
        var end_idx: usize = 0;
        depth = 0;
        for (raw_response[start..], 0..) |c, j| {
            if (c == '{') depth += 1 else if (c == '}') {
                depth -= 1;
                if (depth == 0) {
                    end_idx = start + j + 1;
                    break;
                }
            }
        }
        
        // Build the result properly
        result.deinit(allocator);
        var final_result = try allocator.alloc(u8, end_idx - start + 2); // "[" + object + "]"
        final_result[0] = '[';
        @memcpy(final_result[1 .. end_idx - start + 1], raw_response[start..end_idx]);
        final_result[end_idx - start + 1] = ']';
        return final_result;
    }
    
    // Fallback: return as-is
    return try allocator.dupe(u8, raw_response);
}
