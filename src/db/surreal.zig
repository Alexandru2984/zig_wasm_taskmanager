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

fn hashToken(token: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &digest, .{});

    const hex = "0123456789abcdef";
    var out: [64]u8 = undefined;
    for (digest, 0..) |byte, i| {
        out[i * 2] = hex[byte >> 4];
        out[i * 2 + 1] = hex[byte & 0x0F];
    }
    return out;
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

const MigrationRow = struct {
    version: []const u8,
};

fn migrationApplied(allocator: std.mem.Allocator, version: []const u8) !bool {
    const result = try queryWithVars(allocator,
        \\SELECT version FROM schema_migrations WHERE version = $version;
    , .{ .version = version });
    defer allocator.free(result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(MigrationRow), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    return parsed.value.len > 0 and parsed.value[0].result.len > 0;
}

fn recordMigration(allocator: std.mem.Allocator, version: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\CREATE schema_migrations SET version = $version, applied_at = time::now();
    , .{ .version = version });
    allocator.free(result);
}

fn runMigration(allocator: std.mem.Allocator, version: []const u8, sql: []const u8) !void {
    if (try migrationApplied(allocator, version)) return;
    const result = try query(allocator, sql);
    defer allocator.free(result);
    try recordMigration(allocator, version);
}

// Initialize database schema
pub fn initSchema(allocator: std.mem.Allocator) !void {
    std.debug.print("🗄️ Initializing SurrealDB schema...\n", .{});

    const migrations_schema =
        \\DEFINE TABLE schema_migrations SCHEMAFULL;
        \\DEFINE FIELD version ON schema_migrations TYPE string;
        \\DEFINE FIELD applied_at ON schema_migrations TYPE datetime DEFAULT time::now();
        \\DEFINE INDEX schema_migrations_version_idx ON schema_migrations COLUMNS version UNIQUE;
    ;
    const migrations_result = try query(allocator, migrations_schema);
    defer allocator.free(migrations_result);

    // Define users table
    try runMigration(allocator, "001_core_schema",
        \\DEFINE TABLE users SCHEMAFULL;
        \\DEFINE FIELD email ON users TYPE string;
        \\DEFINE FIELD password_hash ON users TYPE string;
        \\DEFINE FIELD name ON users TYPE string;
        \\DEFINE FIELD avatar ON users TYPE option<string>;
        \\DEFINE FIELD email_verified ON users TYPE bool DEFAULT false;
        \\DEFINE FIELD verification_token ON users TYPE option<string>;
        \\DEFINE FIELD verification_expires ON users TYPE option<int>;
        \\DEFINE FIELD verification_attempts ON users TYPE int DEFAULT 0;
        \\DEFINE FIELD reset_token ON users TYPE option<string>;
        \\DEFINE FIELD reset_expires ON users TYPE option<int>;
        \\DEFINE INDEX email_idx ON users COLUMNS email UNIQUE;
    );

    // Define tasks table
    try runMigration(allocator, "002_tasks_schema",
        \\DEFINE TABLE tasks SCHEMAFULL;
        \\DEFINE FIELD user_id ON tasks TYPE record<users>;
        \\DEFINE FIELD title ON tasks TYPE string;
        \\DEFINE FIELD completed ON tasks TYPE bool DEFAULT false;
        \\DEFINE FIELD created_at ON tasks TYPE datetime DEFAULT time::now();
        \\DEFINE FIELD due_date ON tasks TYPE option<datetime> ASSERT $value == NONE OR $value >= created_at;
        \\DEFINE FIELD priority ON tasks TYPE string DEFAULT "normal";
        \\DEFINE FIELD reminder_sent ON tasks TYPE bool DEFAULT false;
        \\DEFINE FIELD reminder_sent_at ON tasks TYPE option<datetime>;
    );

    // Define sessions table for secure token storage
    try runMigration(allocator, "003_sessions_schema",
        \\DEFINE TABLE sessions SCHEMAFULL;
        \\DEFINE FIELD token ON sessions TYPE string;
        \\DEFINE FIELD user_id ON sessions TYPE record<users>;
        \\DEFINE FIELD created_at ON sessions TYPE datetime DEFAULT time::now();
        \\DEFINE FIELD expires_at ON sessions TYPE datetime;
        \\DEFINE INDEX session_token_idx ON sessions COLUMNS token UNIQUE;
    );

    try runMigration(allocator, "004_activity_schema",
        \\DEFINE TABLE activity_events SCHEMAFULL;
        \\DEFINE FIELD user_id ON activity_events TYPE record<users>;
        \\DEFINE FIELD action ON activity_events TYPE string;
        \\DEFINE FIELD entity_type ON activity_events TYPE string;
        \\DEFINE FIELD entity_id ON activity_events TYPE string DEFAULT "";
        \\DEFINE FIELD created_at ON activity_events TYPE datetime DEFAULT time::now();
    );

    try runMigration(allocator, "005_workspaces_schema",
        \\DEFINE TABLE workspaces SCHEMAFULL;
        \\DEFINE FIELD name ON workspaces TYPE string;
        \\DEFINE FIELD owner_id ON workspaces TYPE record<users>;
        \\DEFINE FIELD created_at ON workspaces TYPE datetime DEFAULT time::now();
        \\DEFINE TABLE workspace_members SCHEMAFULL;
        \\DEFINE FIELD workspace_id ON workspace_members TYPE record<workspaces>;
        \\DEFINE FIELD user_id ON workspace_members TYPE record<users>;
        \\DEFINE FIELD role ON workspace_members TYPE string ASSERT $value INSIDE ["owner", "admin", "member", "viewer"];
        \\DEFINE FIELD created_at ON workspace_members TYPE datetime DEFAULT time::now();
        \\DEFINE INDEX workspace_members_unique_idx ON workspace_members COLUMNS workspace_id, user_id UNIQUE;
        \\DEFINE FIELD workspace_id ON tasks TYPE option<record<workspaces>>;
    );

    try runMigration(allocator, "006_workspace_invites_schema",
        \\DEFINE TABLE workspace_invites SCHEMAFULL;
        \\DEFINE FIELD workspace_id ON workspace_invites TYPE record<workspaces>;
        \\DEFINE FIELD email ON workspace_invites TYPE string;
        \\DEFINE FIELD role ON workspace_invites TYPE string ASSERT $value INSIDE ["admin", "member", "viewer"];
        \\DEFINE FIELD token ON workspace_invites TYPE string;
        \\DEFINE FIELD invited_by ON workspace_invites TYPE record<users>;
        \\DEFINE FIELD expires_at ON workspace_invites TYPE int;
        \\DEFINE FIELD accepted_at ON workspace_invites TYPE option<int>;
        \\DEFINE FIELD created_at ON workspace_invites TYPE datetime DEFAULT time::now();
        \\DEFINE INDEX workspace_invites_token_idx ON workspace_invites COLUMNS token UNIQUE;
    );

    std.debug.print("✅ SurrealDB schema initialized\n", .{});
}

// ============== USER OPERATIONS ==============

pub fn createUser(allocator: std.mem.Allocator, email: []const u8, password_hash: []const u8, name: []const u8, verification_token: []const u8, verification_expires: i64) ![]u8 {
    const verification_hash = hashToken(verification_token);
    return queryWithVars(allocator,
        \\CREATE users SET email = $email, password_hash = $password_hash, name = $name, email_verified = false, verification_token = $verification_tkn, verification_expires = $expires, verification_attempts = 0;
    , .{
        .email = email,
        .password_hash = password_hash,
        .name = name,
        .verification_tkn = verification_hash,
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
        \\SELECT * FROM $record_id;
    , .{ .record_id = id });
}

pub fn updateUserName(allocator: std.mem.Allocator, user_id: []const u8, name: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE $record_id SET name = $name;
    , .{ .record_id = user_id, .name = name });
}

pub fn updateUserPassword(allocator: std.mem.Allocator, user_id: []const u8, password_hash: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE $record_id SET password_hash = $password_hash;
    , .{ .record_id = user_id, .password_hash = password_hash });
}

/// Atomic reset: set new password hash AND clear reset_token/expires in one
/// UPDATE, so the token can never survive a partial failure and be replayed.
pub fn resetUserPasswordAndClearToken(
    allocator: std.mem.Allocator,
    user_id: []const u8,
    password_hash: []const u8,
) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE $record_id SET password_hash = $password_hash, reset_token = NONE, reset_expires = NONE;
    , .{ .record_id = user_id, .password_hash = password_hash });
}

pub fn setResetToken(allocator: std.mem.Allocator, user_id: []const u8, token: []const u8, expires: i64) ![]u8 {
    const token_hash = hashToken(token);
    return queryWithVars(allocator,
        \\UPDATE $record_id SET reset_token = $reset_tkn, reset_expires = $expires;
    , .{ .record_id = user_id, .reset_tkn = token_hash, .expires = expires });
}

pub fn clearResetToken(allocator: std.mem.Allocator, user_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET reset_token = NONE, reset_expires = NONE;
    , .{ .record_id = user_id });
    allocator.free(result);
}

pub fn setVerificationToken(allocator: std.mem.Allocator, user_id: []const u8, token: []const u8, expires: i64) ![]u8 {
    // SECURITY: reset the attempt counter so a fresh code gets a fresh budget.
    const token_hash = hashToken(token);
    return queryWithVars(allocator,
        \\UPDATE $record_id SET verification_token = $verification_tkn, verification_expires = $expires, verification_attempts = 0;
    , .{ .record_id = user_id, .verification_tkn = token_hash, .expires = expires });
}

pub fn getUserByResetToken(allocator: std.mem.Allocator, token: []const u8) ![]u8 {
    const token_hash = hashToken(token);
    return queryWithVars(allocator,
        \\SELECT * FROM users WHERE reset_token = $reset_tkn;
    , .{ .reset_tkn = token_hash });
}

/// Atomic verify: marks email as verified ONLY if user_id + code + not-expired match.
/// Returns true if verified, false if code was wrong or expired.
/// Also clears the verification token on success so it can't be replayed.
pub fn verifyUserEmailAtomic(
    allocator: std.mem.Allocator,
    user_id: []const u8,
    code: []const u8,
    now_ts: i64,
) !bool {
    const code_hash = hashToken(code);
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET email_verified = true, verification_token = NONE, verification_expires = NONE, verification_attempts = 0 WHERE verification_token = $code AND (verification_expires = NONE OR verification_expires >= $now_ts) RETURN AFTER;
    , .{ .record_id = user_id, .code = code_hash, .now_ts = now_ts });
    defer allocator.free(result);

    // If no row updated, UPDATE returns []. Parse and check.
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return false;
    return true;
}

/// Increment failed-attempts counter and invalidate token if threshold reached.
/// Returns the number of attempts AFTER increment (so caller can decide messaging).
pub fn bumpVerificationAttempts(
    allocator: std.mem.Allocator,
    user_id: []const u8,
    max_attempts: u32,
) !u32 {
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET verification_attempts = (verification_attempts OR 0) + 1, verification_token = IF (verification_attempts OR 0) + 1 >= $max THEN NONE ELSE verification_token END, verification_expires = IF (verification_attempts OR 0) + 1 >= $max THEN NONE ELSE verification_expires END RETURN AFTER;
    , .{ .record_id = user_id, .max = @as(i64, @intCast(max_attempts)) });
    defer allocator.free(result);

    const parsed = std.json.parseFromSlice(
        []models.SurrealResponse(struct { verification_attempts: ?i64 = null }),
        allocator,
        result,
        .{ .ignore_unknown_fields = true },
    ) catch return 0;
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return 0;
    const attempts = parsed.value[0].result[0].verification_attempts orelse 0;
    return @intCast(@max(attempts, 0));
}

// ============== WORKSPACE OPERATIONS ==============

const WorkspaceListRow = struct {
    id: []const u8,
    name: []const u8,
    role: []const u8,
    created_at: []const u8,
};

pub fn ensurePersonalWorkspace(allocator: std.mem.Allocator, user_id: []const u8, user_name: []const u8) ![]const u8 {
    const existing = try queryWithVars(allocator,
        \\SELECT workspace_id FROM workspace_members WHERE user_id = $user_id LIMIT 1;
    , .{ .user_id = user_id });
    defer allocator.free(existing);

    const ExistingRow = struct { workspace_id: []const u8 };
    const parsed_existing = try std.json.parseFromSlice([]models.SurrealResponse(ExistingRow), allocator, existing, .{ .ignore_unknown_fields = true });
    defer parsed_existing.deinit();

    if (parsed_existing.value.len > 0 and parsed_existing.value[0].result.len > 0) {
        return try allocator.dupe(u8, parsed_existing.value[0].result[0].workspace_id);
    }

    const workspace_name = if (user_name.len > 0)
        try std.fmt.allocPrint(allocator, "{s}'s Workspace", .{user_name})
    else
        try allocator.dupe(u8, "Personal Workspace");
    defer allocator.free(workspace_name);

    const created = try createWorkspace(allocator, user_id, workspace_name);
    defer allocator.free(created);

    const parsed_created = try std.json.parseFromSlice([]models.SurrealResponse(models.Workspace), allocator, created, .{ .ignore_unknown_fields = true });
    defer parsed_created.deinit();

    if (parsed_created.value.len == 0 or parsed_created.value[0].result.len == 0) return error.WorkspaceCreateFailed;
    const workspace_id = parsed_created.value[0].result[0].id;

    const update_tasks = try queryWithVars(allocator,
        \\UPDATE tasks SET workspace_id = $workspace_id WHERE user_id = $user_id AND workspace_id = NONE;
    , .{ .workspace_id = workspace_id, .user_id = user_id });
    allocator.free(update_tasks);

    return try allocator.dupe(u8, workspace_id);
}

pub fn createWorkspace(allocator: std.mem.Allocator, owner_id: []const u8, name: []const u8) ![]u8 {
    const workspace_result = try queryWithVars(allocator,
        \\CREATE workspaces SET name = $name, owner_id = $owner_id, created_at = time::now();
    , .{ .name = name, .owner_id = owner_id });
    errdefer allocator.free(workspace_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Workspace), allocator, workspace_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return error.WorkspaceCreateFailed;
    const workspace = parsed.value[0].result[0];

    const member_result = try queryWithVars(allocator,
        \\CREATE workspace_members SET workspace_id = $workspace_id, user_id = $owner_id, role = "owner", created_at = time::now();
    , .{ .workspace_id = workspace.id, .owner_id = owner_id });
    allocator.free(member_result);

    return workspace_result;
}

pub fn getWorkspaceById(allocator: std.mem.Allocator, workspace_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM $workspace_id;
    , .{ .workspace_id = workspace_id });
}

pub fn listWorkspacesForUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT workspace_id.id AS id, workspace_id.name AS name, role, workspace_id.created_at AS created_at FROM workspace_members WHERE user_id = $user_id;
    , .{ .user_id = user_id });
}

pub fn getWorkspaceRole(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8) !?[]const u8 {
    const result = try queryWithVars(allocator,
        \\SELECT role FROM workspace_members WHERE user_id = $user_id AND workspace_id = $workspace_id LIMIT 1;
    , .{ .user_id = user_id, .workspace_id = workspace_id });
    defer allocator.free(result);

    const RoleRow = struct { role: []const u8 };
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(RoleRow), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return null;
    return try allocator.dupe(u8, parsed.value[0].result[0].role);
}

pub fn isUserEmailVerified(allocator: std.mem.Allocator, user_id: []const u8) !bool {
    const result = try queryWithVars(allocator,
        \\SELECT email_verified FROM $record_id;
    , .{ .record_id = user_id });
    defer allocator.free(result);

    const VerificationRow = struct { email_verified: bool = false };
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(VerificationRow), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return false;
    return parsed.value[0].result[0].email_verified;
}

fn roleCanWrite(role: []const u8) bool {
    return std.mem.eql(u8, role, "owner") or
        std.mem.eql(u8, role, "admin") or
        std.mem.eql(u8, role, "member");
}

fn roleCanAdmin(role: []const u8) bool {
    return std.mem.eql(u8, role, "owner") or std.mem.eql(u8, role, "admin");
}

pub fn canReadWorkspace(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8) !bool {
    const role = try getWorkspaceRole(allocator, user_id, workspace_id);
    if (role) |r| {
        allocator.free(r);
        return true;
    }
    return false;
}

pub fn canWriteWorkspace(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8) !bool {
    const role = try getWorkspaceRole(allocator, user_id, workspace_id);
    if (role) |r| {
        defer allocator.free(r);
        return roleCanWrite(r);
    }
    return false;
}

pub fn canAdminWorkspace(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8) !bool {
    const role = try getWorkspaceRole(allocator, user_id, workspace_id);
    if (role) |r| {
        defer allocator.free(r);
        return roleCanAdmin(r);
    }
    return false;
}

pub fn listWorkspaceMembers(allocator: std.mem.Allocator, workspace_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT id, user_id.id AS user_id, user_id.email AS email, user_id.name AS name, role, created_at FROM workspace_members WHERE workspace_id = $workspace_id;
    , .{ .workspace_id = workspace_id });
}

pub fn createWorkspaceInvite(
    allocator: std.mem.Allocator,
    workspace_id: []const u8,
    email: []const u8,
    role: []const u8,
    invited_by: []const u8,
    token: []const u8,
    expires_at: i64,
) ![]u8 {
    const token_hash = hashToken(token);
    return queryWithVars(allocator,
        \\CREATE workspace_invites SET workspace_id = $workspace_id, email = $email, role = $role, token = $invite_token, invited_by = $invited_by, expires_at = $expires_at, accepted_at = NONE, created_at = time::now();
    , .{
        .workspace_id = workspace_id,
        .email = email,
        .role = role,
        .invite_token = token_hash,
        .invited_by = invited_by,
        .expires_at = expires_at,
    });
}

pub fn hasPendingWorkspaceInvite(allocator: std.mem.Allocator, workspace_id: []const u8, email: []const u8, now_ts: i64) !bool {
    const result = try queryWithVars(allocator,
        \\SELECT id FROM workspace_invites WHERE workspace_id = $workspace_id AND email = $email AND accepted_at = NONE AND expires_at >= $now_ts LIMIT 1;
    , .{ .workspace_id = workspace_id, .email = email, .now_ts = now_ts });
    defer allocator.free(result);

    const ExistingInvite = struct { id: []const u8 };
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(ExistingInvite), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    return parsed.value.len > 0 and parsed.value[0].result.len > 0;
}

pub fn getWorkspaceInviteByToken(allocator: std.mem.Allocator, token: []const u8) ![]u8 {
    const token_hash = hashToken(token);
    return queryWithVars(allocator,
        \\SELECT * FROM workspace_invites WHERE token = $invite_token LIMIT 1;
    , .{ .invite_token = token_hash });
}

pub fn deleteWorkspaceInviteById(allocator: std.mem.Allocator, invite_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\DELETE $invite_id;
    , .{ .invite_id = invite_id });
    allocator.free(result);
}

pub fn addWorkspaceMember(allocator: std.mem.Allocator, workspace_id: []const u8, user_id: []const u8, role: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\CREATE workspace_members SET workspace_id = $workspace_id, user_id = $user_id, role = $role, created_at = time::now();
    , .{ .workspace_id = workspace_id, .user_id = user_id, .role = role });
    allocator.free(result);
}

pub fn markWorkspaceInviteAccepted(allocator: std.mem.Allocator, invite_id: []const u8, accepted_at: i64) !void {
    const result = try queryWithVars(allocator,
        \\UPDATE $invite_id SET accepted_at = $accepted_at;
    , .{ .invite_id = invite_id, .accepted_at = accepted_at });
    allocator.free(result);
}

// ============== TASK OPERATIONS ==============

pub fn createTask(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8, title: []const u8, priority: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\CREATE tasks SET user_id = $user_id, workspace_id = $workspace_id, title = $title, priority = $priority, completed = false, reminder_sent = false, created_at = time::now();
    , .{ .user_id = user_id, .workspace_id = workspace_id, .title = title, .priority = priority });
}

pub fn createTaskWithDueDate(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8, title: []const u8, due_date: []const u8, priority: []const u8) ![]u8 {
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
        \\CREATE tasks SET user_id = $user_id, workspace_id = $workspace_id, title = $title, priority = $priority, completed = false, reminder_sent = false, created_at = time::now(), due_date = <datetime>$due_date;
    , .{ .user_id = user_id, .workspace_id = workspace_id, .title = title, .priority = priority, .due_date = formatted_date });
}

pub fn getTasksByUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM tasks WHERE workspace_id IN (SELECT VALUE workspace_id FROM workspace_members WHERE user_id = $user_id) OR (user_id = $user_id AND workspace_id = NONE);
    , .{ .user_id = user_id });
}

pub fn toggleTask(allocator: std.mem.Allocator, task_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE $record_id SET completed = !completed;
    , .{ .record_id = task_id });
}

pub fn deleteTask(allocator: std.mem.Allocator, task_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\DELETE $record_id;
    , .{ .record_id = task_id });
}

pub fn getDueTasksForReminders(allocator: std.mem.Allocator) ![]u8 {
    return query(allocator,
        \\SELECT * FROM tasks WHERE completed = false AND due_date != NONE AND due_date <= time::now() AND (reminder_sent = false OR reminder_sent = NONE) LIMIT 25;
    );
}

pub fn markTaskReminderSent(allocator: std.mem.Allocator, task_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET reminder_sent = true, reminder_sent_at = time::now();
    , .{ .record_id = task_id });
    allocator.free(result);
}

// ============== ACTIVITY LOG ==============

pub fn logActivity(
    allocator: std.mem.Allocator,
    user_id: []const u8,
    action: []const u8,
    entity_type: []const u8,
    entity_id: []const u8,
) !void {
    const result = try queryWithVars(allocator,
        \\CREATE activity_events SET user_id = $user_id, action = $action, entity_type = $entity_type, entity_id = <string>$entity_id, created_at = time::now();
    , .{ .user_id = user_id, .action = action, .entity_type = entity_type, .entity_id = entity_id });
    allocator.free(result);
}

pub fn getActivityByUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM activity_events WHERE user_id = $user_id ORDER BY created_at DESC LIMIT 50;
    , .{ .user_id = user_id });
}

// ============== TASK OWNERSHIP ==============

pub fn getTaskOwner(allocator: std.mem.Allocator, task_id: []const u8) !?[]const u8 {
    const result = try queryWithVars(allocator,
        \\SELECT user_id, workspace_id FROM $record_id;
    , .{ .record_id = task_id });
    defer allocator.free(result);

    const TaskOwner = struct {
        user_id: []const u8,
        workspace_id: ?[]const u8 = null,
    };

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(TaskOwner), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        return null;
    }

    return try allocator.dupe(u8, parsed.value[0].result[0].user_id);
}

pub fn canWriteTask(allocator: std.mem.Allocator, task_id: []const u8, user_id: []const u8) !bool {
    const result = try queryWithVars(allocator,
        \\SELECT user_id, workspace_id FROM $record_id;
    , .{ .record_id = task_id });
    defer allocator.free(result);

    const TaskAccess = struct {
        user_id: []const u8,
        workspace_id: ?[]const u8 = null,
    };

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(TaskAccess), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return false;
    const task = parsed.value[0].result[0];

    if (task.workspace_id) |workspace_id| {
        return try canWriteWorkspace(allocator, user_id, workspace_id);
    }

    return std.mem.eql(u8, task.user_id, user_id);
}

pub fn verifyTaskOwnership(allocator: std.mem.Allocator, task_id: []const u8, user_id: []const u8) !bool {
    return canWriteTask(allocator, task_id, user_id);
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
    const token_hash = hashToken(token[0..]);

    // Calculate expiration (7 days from now in milliseconds)
    const expires_ms = std.time.milliTimestamp() + (7 * 24 * 60 * 60 * 1000);

    const result = try queryWithVars(allocator,
        \\CREATE sessions SET token = $session_token, user_id = $user_id, expires_at = time::from::millis($expires_ms);
    , .{ .session_token = token_hash, .user_id = user_id, .expires_ms = expires_ms });
    defer allocator.free(result);

    // Return a copy of the token
    return try allocator.dupe(u8, &token);
}

/// Validate a session token and return the user_id if valid
/// Returns null if token is invalid or expired
pub fn validateSession(allocator: std.mem.Allocator, token: []const u8) !?[]u8 {
    const token_hash = hashToken(token);
    const result = try queryWithVars(allocator,
        \\SELECT user_id, time::unix(expires_at) * 1000 as expires_ms FROM sessions WHERE token = $session_token;
    , .{ .session_token = token_hash });
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
    const token_hash = hashToken(token);
    const result = try queryWithVars(allocator,
        \\DELETE FROM sessions WHERE token = $session_token;
    , .{ .session_token = token_hash });
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

// ============== BACKGROUND SESSION CLEANUP ==============

var session_cleanup_thread: ?std.Thread = null;
var session_cleanup_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false);

fn sessionCleanupLoop(allocator: std.mem.Allocator) void {
    // Run once on startup to drop stale rows left over from a previous process.
    cleanupExpiredSessions(allocator) catch |err| {
        std.debug.print("⚠️ Initial session cleanup failed: {}\n", .{err});
    };

    // Then every hour. Sleep in 1s chunks so shutdown stays responsive.
    while (session_cleanup_running.load(.acquire)) {
        var i: usize = 0;
        while (i < 3600 and session_cleanup_running.load(.acquire)) : (i += 1) {
            std.Thread.sleep(1 * std.time.ns_per_s);
        }
        if (!session_cleanup_running.load(.acquire)) break;
        cleanupExpiredSessions(allocator) catch |err| {
            std.debug.print("⚠️ Session cleanup failed: {}\n", .{err});
        };
    }
}

pub fn startSessionCleanupThread(allocator: std.mem.Allocator) !void {
    if (session_cleanup_thread != null) return;
    session_cleanup_running.store(true, .release);
    session_cleanup_thread = try std.Thread.spawn(.{}, sessionCleanupLoop, .{allocator});
    std.debug.print("✅ Session cleanup thread started\n", .{});
}

pub fn stopSessionCleanupThread() void {
    if (session_cleanup_thread) |thread| {
        session_cleanup_running.store(false, .release);
        thread.join();
        session_cleanup_thread = null;
        std.debug.print("🛑 Session cleanup thread stopped\n", .{});
    }
}
