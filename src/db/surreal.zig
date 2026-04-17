const std = @import("std");
const config = @import("../config/config.zig");
const validation = @import("../util/validation.zig");
const http_client = @import("http_client.zig");
const models = @import("../domain/models.zig");

// Database config struct (kept for compatibility)
const DbConfig = struct {
    url: []const u8,
    ns: []const u8,
    db: []const u8,
    user: []const u8,
    pass: []const u8,
};

// Get DB config from unified .env config (kept for schema init logging)
fn getDbConfig() !DbConfig {
    return DbConfig{
        .url = config.getRequired("SURREAL_URL") catch return error.MissingDbConfig,
        .ns = config.getRequired("SURREAL_NS") catch return error.MissingDbConfig,
        .db = config.getRequired("SURREAL_DB") catch return error.MissingDbConfig,
        .user = config.getRequired("SURREAL_USER") catch return error.MissingDbConfig,
        .pass = config.getRequired("SURREAL_PASS") catch return error.MissingDbConfig,
    };
}

// Execute a SurrealQL query using native HTTP client (no variables)
// SECURITY: Use queryWithVars for user input to prevent SQL injection
pub fn query(allocator: std.mem.Allocator, sql: []const u8) ![]u8 {
    return http_client.executeQuery(allocator, sql);
}

// Execute a SurrealQL query with bind variables (SECURE)
// Variables are passed as a struct with field names matching $variable names in query
// Example: queryWithVars(alloc, "SELECT * FROM users WHERE email = $email", .{ .email = user_email })
pub fn queryWithVars(allocator: std.mem.Allocator, sql: []const u8, vars: anytype) ![]u8 {
    return http_client.executeQueryWithVars(allocator, sql, vars);
}

// Initialize database schema
pub fn initSchema(allocator: std.mem.Allocator) !void {
    std.debug.print("🗄️ Initializing SurrealDB schema...\n", .{});

    // Define users table
    const users_schema =
        \\DEFINE TABLE users SCHEMAFULL;
        \\DEFINE FIELD email ON users TYPE string;
        \\DEFINE FIELD password_hash ON users TYPE string;
        \\DEFINE FIELD name ON users TYPE string;
        \\DEFINE FIELD avatar ON users TYPE option<string>;
        \\DEFINE FIELD email_verified ON users TYPE bool DEFAULT false;
        \\DEFINE FIELD verification_token ON users TYPE option<string>;
        \\DEFINE FIELD reset_token ON users TYPE option<string>;
        \\DEFINE FIELD reset_expires ON users TYPE option<int>;
        \\DEFINE INDEX email_idx ON users COLUMNS email UNIQUE;
    ;

    const users_result = try query(allocator, users_schema);
    defer allocator.free(users_result);

    // Define tasks table
    const tasks_schema =
        \\DEFINE TABLE tasks SCHEMAFULL;
        \\DEFINE FIELD user_id ON tasks TYPE string;
        \\DEFINE FIELD title ON tasks TYPE string;
        \\DEFINE FIELD completed ON tasks TYPE bool DEFAULT false;
        \\DEFINE FIELD created_at ON tasks TYPE datetime DEFAULT time::now();
        \\DEFINE FIELD due_date ON tasks TYPE option<datetime> ASSERT $value == NONE OR $value >= created_at;
    ;

    const tasks_result = try query(allocator, tasks_schema);
    defer allocator.free(tasks_result);

    // Define sessions table for secure token storage
    const sessions_schema =
        \\DEFINE TABLE sessions SCHEMAFULL;
        \\DEFINE FIELD token ON sessions TYPE string;
        \\DEFINE FIELD user_id ON sessions TYPE string;
        \\DEFINE FIELD created_at ON sessions TYPE datetime DEFAULT time::now();
        \\DEFINE FIELD expires_at ON sessions TYPE datetime;
        \\DEFINE INDEX session_token_idx ON sessions COLUMNS token UNIQUE;
    ;

    const sessions_result = try query(allocator, sessions_schema);
    defer allocator.free(sessions_result);

    std.debug.print("✅ SurrealDB schema initialized\n", .{});
}

// ============== USER OPERATIONS ==============

pub fn createUser(allocator: std.mem.Allocator, email: []const u8, password_hash: []const u8, name: []const u8, verification_token: []const u8, verification_expires: i64) ![]u8 {
    return queryWithVars(allocator,
        \\CREATE users SET email = $email, password_hash = $password_hash, name = $name, email_verified = false, verification_token = $verification_tkn, verification_expires = $expires;
    , .{
        .email = email,
        .password_hash = password_hash,
        .name = name,
        .verification_tkn = verification_token,
        .expires = verification_expires,
    });
}

pub fn getUserByEmail(allocator: std.mem.Allocator, email: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM users WHERE email = $email;
    , .{ .email = email });
}

pub fn getUserById(allocator: std.mem.Allocator, id: []const u8) ![]u8 {
    // id is a full SurrealDB record ID like "users:abc123"
    return queryWithVars(allocator,
        \\SELECT * FROM type::record($record_id);
    , .{ .record_id = id });
}

pub fn updateUserVerified(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE type::record($record_id) SET email_verified = true, verification_token = NONE;
    , .{ .record_id = user_id });
}

pub fn updateUserName(allocator: std.mem.Allocator, user_id: []const u8, name: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE type::record($record_id) SET name = $name;
    , .{ .record_id = user_id, .name = name });
}

pub fn updateUserPassword(allocator: std.mem.Allocator, user_id: []const u8, password_hash: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE type::record($record_id) SET password_hash = $password_hash;
    , .{ .record_id = user_id, .password_hash = password_hash });
}

pub fn setResetToken(allocator: std.mem.Allocator, user_id: []const u8, token: []const u8, expires: i64) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE type::record($record_id) SET reset_token = $reset_tkn, reset_expires = $expires;
    , .{ .record_id = user_id, .reset_tkn = token, .expires = expires });
}

pub fn setVerificationToken(allocator: std.mem.Allocator, user_id: []const u8, token: []const u8, expires: i64) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE type::record($record_id) SET verification_token = $verification_tkn, verification_expires = $expires;
    , .{ .record_id = user_id, .verification_tkn = token, .expires = expires });
}

pub fn getUserByResetToken(allocator: std.mem.Allocator, token: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM users WHERE reset_token = $reset_tkn;
    , .{ .reset_tkn = token });
}

pub fn getUserByVerificationToken(allocator: std.mem.Allocator, token: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM users WHERE verification_token = $verification_tkn;
    , .{ .verification_tkn = token });
}

// ============== TASK OPERATIONS ==============

pub fn createTask(allocator: std.mem.Allocator, user_id: []const u8, title: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\CREATE tasks SET user_id = $user_id, title = $title, completed = false, created_at = time::now();
    , .{ .user_id = user_id, .title = title });
}

pub fn createTaskWithDueDate(allocator: std.mem.Allocator, user_id: []const u8, title: []const u8, due_date: []const u8) ![]u8 {
    // Ensure due_date has proper format (add :00Z if needed for SurrealDB)
    // HTML datetime-local gives "2025-12-25T12:00" but SurrealDB needs "2025-12-25T12:00:00Z"
    var formatted_date: []const u8 = due_date;
    var needs_free = false;
    
    if (!std.mem.endsWith(u8, due_date, "Z")) {
        if (std.mem.count(u8, due_date, ":") == 1) {
            formatted_date = try std.fmt.allocPrint(allocator, "{s}:00Z", .{due_date});
            needs_free = true;
        } else {
            formatted_date = try std.fmt.allocPrint(allocator, "{s}Z", .{due_date});
            needs_free = true;
        }
    }
    defer if (needs_free) allocator.free(formatted_date);
    
    return queryWithVars(allocator,
        \\CREATE tasks SET user_id = $user_id, title = $title, completed = false, created_at = time::now(), due_date = <datetime>$due_date;
    , .{ .user_id = user_id, .title = title, .due_date = formatted_date });
}

pub fn getTasksByUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM tasks WHERE user_id = $user_id;
    , .{ .user_id = user_id });
}

pub fn toggleTask(allocator: std.mem.Allocator, task_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE type::record($record_id) SET completed = !completed;
    , .{ .record_id = task_id });
}

pub fn deleteTask(allocator: std.mem.Allocator, task_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\DELETE type::record($record_id);
    , .{ .record_id = task_id });
}

// ============== TASK OWNERSHIP ==============

pub fn getTaskOwner(allocator: std.mem.Allocator, task_id: []const u8) !?[]const u8 {
    const result = try queryWithVars(allocator,
        \\SELECT user_id FROM type::record($record_id);
    , .{ .record_id = task_id });
    defer allocator.free(result);

    const TaskOwner = struct {
        user_id: []const u8,
    };

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(TaskOwner), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        return null;
    }

    return try allocator.dupe(u8, parsed.value[0].result[0].user_id);
}

pub fn verifyTaskOwnership(allocator: std.mem.Allocator, task_id: []const u8, user_id: []const u8) !bool {
    const owner = try getTaskOwner(allocator, task_id);
    if (owner) |task_owner| {
        defer allocator.free(task_owner);
        return std.mem.eql(u8, task_owner, user_id);
    }
    return false; // Task doesn't exist or has no owner
}

// ============== SESSION MANAGEMENT ==============
// Secure token-based authentication stored in database

/// Generate a cryptographically secure random token (32 bytes = 64 hex chars)
pub fn generateSecureToken() [64]u8 {
    var random_bytes: [32]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    
    const hex_chars = "0123456789abcdef";
    var hex_token: [64]u8 = undefined;
    
    for (random_bytes, 0..) |byte, i| {
        hex_token[i * 2] = hex_chars[byte >> 4];
        hex_token[i * 2 + 1] = hex_chars[byte & 0x0F];
    }
    
    return hex_token;
}

/// Create a new session for a user, returns the session token
/// Session expires in 7 days by default
pub fn createSession(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    const token = generateSecureToken();
    
    // Calculate expiration (7 days from now in milliseconds)
    const expires_ms = std.time.milliTimestamp() + (7 * 24 * 60 * 60 * 1000);
    
    const result = try queryWithVars(allocator,
        \\CREATE sessions SET token = $session_token, user_id = $user_id, expires_at = time::from::millis($expires_ms);
    , .{ .session_token = token, .user_id = user_id, .expires_ms = expires_ms });
    defer allocator.free(result);
    
    // Return a copy of the token
    return try allocator.dupe(u8, &token);
}

/// Validate a session token and return the user_id if valid
/// Returns null if token is invalid or expired
pub fn validateSession(allocator: std.mem.Allocator, token: []const u8) !?[]u8 {
    const result = try queryWithVars(allocator,
        \\SELECT user_id, time::unix(expires_at) * 1000 as expires_ms FROM sessions WHERE token = $session_token;
    , .{ .session_token = token });
    defer allocator.free(result);

    const SessionResult = struct {
        user_id: []const u8,
        expires_ms: i64,
    };

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(SessionResult), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        return null;
    }

    const session = parsed.value[0].result[0];

    // Check expiration
    const now = std.time.milliTimestamp();
    if (session.expires_ms < now) {
        return null;
    }

    return try allocator.dupe(u8, session.user_id);
}

/// Delete a specific session (logout)
pub fn deleteSession(allocator: std.mem.Allocator, token: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\DELETE FROM sessions WHERE token = $session_token;
    , .{ .session_token = token });
    allocator.free(result);
}

/// Delete all sessions for a user (logout all devices)
pub fn deleteUserSessions(allocator: std.mem.Allocator, user_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\DELETE FROM sessions WHERE user_id = $user_id;
    , .{ .user_id = user_id });
    allocator.free(result);
}

/// Cleanup expired sessions (should be called periodically)
pub fn cleanupExpiredSessions(allocator: std.mem.Allocator) !void {
    const current_ms = std.time.milliTimestamp();
    const result = try queryWithVars(allocator,
        \\DELETE FROM sessions WHERE expires_at < time::from::millis($current_ms);
    , .{ .current_ms = current_ms });
    allocator.free(result);
}
