const std = @import("std");
const mail_payload = @import("../services/mail_payload.zig");
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

/// SHA-256 of a token, hex-encoded. Public as `hashTokenHex` so the HTTP layer
/// can compare a submitted CSRF token against the hash stored on the session
/// row without duplicating the encoding.
pub fn hashTokenHex(token: []const u8) [64]u8 {
    return hashToken(token);
}

/// Letters, digits and underscore only. Used to gate the namespace and
/// database names before they are written into a DEFINE statement, which is
/// the one place this application builds SurrealQL from configuration.
fn isPlainIdentifier(value: []const u8) bool {
    if (value.len == 0 or value.len > 64) return false;
    for (value) |c| {
        const ok = (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or
            (c >= '0' and c <= '9') or c == '_';
        if (!ok) return false;
    }
    return true;
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

/// Mark a bind value as a record id rather than text. Required for every value
/// that names a row: since SurrealDB 3 a plain string is not a record id, and
/// `WHERE link = $string` matches nothing without reporting an error.
pub const rec = http_client.rec;
pub const RecordId = http_client.RecordId;

// These writes are intentional serialization fences. Snapshot reads alone
// cannot prevent a permission change from racing a write to a different row.
// All protected workspace mutations share its fence; account-sensitive writes
// also touch the actor row so account deletion cannot leave new child records.
const actorFence =
    \\LET $actor = (UPDATE users SET security_revision = (security_revision ?? 0) + 1 WHERE id = $actor_id RETURN AFTER);
    \\IF array::len($actor) != 1 { THROW "APP_FORBIDDEN"; };
++ "\n";

// The guard is shared by enqueue transactions so the queue capacity check
// cannot be bypassed by concurrent signups/invites under snapshot isolation.
const insertMail =
    \\UPSERT mail_guard:queue SET revision = (revision ?? 0) + 1;
    \\DELETE mail_outbox WHERE owner_id = $mail_owner AND reference_id = $mail_ref AND kind = $mail_kind AND status INSIDE ["pending", "processing"];
    \\LET $size = (SELECT count() FROM mail_outbox WHERE status INSIDE ["pending", "processing"] GROUP ALL)[0].count ?? 0;
    \\IF $size >= 5000 { THROW "APP_BUSY"; };
    \\CREATE mail_outbox SET owner_id = $mail_owner, reference_id = $mail_ref, kind = $mail_kind, encrypted_payload = $mail_payload, secret_hash = $mail_hash, expires_at = $mail_expires;
++ "\n";
const workspaceFence =
    \\LET $scope = (UPDATE workspaces SET security_revision = (security_revision ?? 0) + 1 WHERE id = $workspace_id RETURN AFTER);
    \\IF array::len($scope) != 1 { THROW "APP_NOT_FOUND"; };
++ "\n";
const workspaceRole =
    \\LET $role = (SELECT VALUE role FROM workspace_members WHERE workspace_id = $workspace_id AND user_id = $actor_id)[0];
++ "\n";
const adminFence = actorFence ++ workspaceFence ++ workspaceRole ++
    \\IF !($role INSIDE ["owner", "admin"]) { THROW "APP_FORBIDDEN"; };
++ "\n";
const taskScopeFence = actorFence ++
    \\LET $before = (SELECT * FROM ONLY $record_id);
    \\IF $before == NONE { THROW "APP_NOT_FOUND"; };
    \\LET $workspace_id = $before.workspace_id;
    \\IF $workspace_id == NONE {
    \\    IF $before.user_id != $actor_id { THROW "APP_FORBIDDEN"; };
    \\} ELSE {
++ "\n" ++ workspaceFence ++ workspaceRole ++
    \\    IF !($role INSIDE ["owner", "admin", "member"]) { THROW "APP_FORBIDDEN"; };
    \\};
++ "\n";
const taskFence = taskScopeFence ++
    \\IF $before.deleted_at != NONE { THROW "APP_NOT_FOUND"; };
++ "\n";

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
pub fn checkSchema(allocator: std.mem.Allocator) !void {
    if (!try migrationApplied(allocator, "013_mail_outbox")) return error.SchemaMigrationRequired;
    if (!try migrationApplied(allocator, "014_task_trash")) return error.SchemaMigrationRequired;
}

pub fn initSchema(allocator: std.mem.Allocator) !void {
    std.debug.print("🗄️ Initializing SurrealDB schema...\n", .{});

    // SurrealDB 1.x created a namespace and database implicitly on first use.
    // 3.x does not: every statement against an unknown namespace fails with
    // "The namespace '…' does not exist", so a fresh deployment could not even
    // run its migrations. These are idempotent, so they cost one statement on
    // every boot and remove a manual setup step.
    {
        const cfg = try getDbConfig();
        const bootstrap = try std.fmt.allocPrint(allocator,
            \\DEFINE NAMESPACE IF NOT EXISTS {s};
            \\USE NS {s};
            \\DEFINE DATABASE IF NOT EXISTS {s};
        , .{ cfg.ns, cfg.ns, cfg.db });
        defer allocator.free(bootstrap);

        // The namespace and database names come from configuration, not from a
        // request, and SurrealQL has no bind form for them — they are part of
        // the statement, not values in it. Refuse anything that is not a plain
        // identifier rather than interpolating it blindly.
        if (!isPlainIdentifier(cfg.ns) or !isPlainIdentifier(cfg.db)) {
            std.debug.print("❌ SURREAL_NS/SURREAL_DB must be plain identifiers\n", .{});
            return error.InvalidDbConfig;
        }

        // Best-effort. SurrealDB 1.x has no `IF NOT EXISTS` on DEFINE NAMESPACE
        // and reports "already exists" as an error, and 1.x creates both
        // implicitly anyway. Treating a failure here as fatal would refuse to
        // boot against exactly the version that does not need this. If the
        // namespace really is missing, the migration statements that follow
        // fail loudly and the retry loop reports it.
        if (query(allocator, bootstrap)) |bootstrap_result| {
            allocator.free(bootstrap_result);
        } else |err| {
            std.debug.print("ℹ️  Namespace bootstrap skipped ({}); continuing\n", .{err});
        }
    }

    // `IF NOT EXISTS` on every DEFINE. SurrealDB 1.x treated a repeated DEFINE
    // as a no-op; 3.x rejects it with "already exists", which made the
    // unguarded bootstrap below fail on every boot after the first. The
    // alternative spelling, `DEFINE TABLE OVERWRITE`, redefines the table
    // rather than leaving it alone, so it is the wrong tool for an idempotent
    // startup path.
    const migrations_schema =
        \\DEFINE TABLE IF NOT EXISTS schema_migrations SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS version ON schema_migrations TYPE string;
        \\DEFINE FIELD IF NOT EXISTS applied_at ON schema_migrations TYPE datetime DEFAULT time::now();
        \\DEFINE INDEX IF NOT EXISTS schema_migrations_version_idx ON schema_migrations COLUMNS version UNIQUE;
    ;
    const migrations_result = try query(allocator, migrations_schema);
    defer allocator.free(migrations_result);

    // Define users table
    try runMigration(allocator, "001_core_schema",
        \\DEFINE TABLE IF NOT EXISTS users SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS email ON users TYPE string;
        \\DEFINE FIELD IF NOT EXISTS password_hash ON users TYPE string;
        \\DEFINE FIELD IF NOT EXISTS name ON users TYPE string;
        \\DEFINE FIELD IF NOT EXISTS avatar ON users TYPE option<string>;
        \\DEFINE FIELD IF NOT EXISTS email_verified ON users TYPE bool DEFAULT false;
        \\DEFINE FIELD IF NOT EXISTS verification_token ON users TYPE option<string>;
        \\DEFINE FIELD IF NOT EXISTS verification_expires ON users TYPE option<int>;
        \\DEFINE FIELD IF NOT EXISTS verification_attempts ON users TYPE int DEFAULT 0;
        \\DEFINE FIELD IF NOT EXISTS reset_token ON users TYPE option<string>;
        \\DEFINE FIELD IF NOT EXISTS reset_expires ON users TYPE option<int>;
        \\DEFINE INDEX IF NOT EXISTS email_idx ON users COLUMNS email UNIQUE;
    );

    // Define tasks table
    try runMigration(allocator, "002_tasks_schema",
        \\DEFINE TABLE IF NOT EXISTS tasks SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS user_id ON tasks TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS title ON tasks TYPE string;
        \\DEFINE FIELD IF NOT EXISTS completed ON tasks TYPE bool DEFAULT false;
        \\DEFINE FIELD IF NOT EXISTS created_at ON tasks TYPE datetime DEFAULT time::now();
        \\DEFINE FIELD IF NOT EXISTS due_date ON tasks TYPE option<datetime> ASSERT $value == NONE OR $value >= created_at;
        \\DEFINE FIELD IF NOT EXISTS priority ON tasks TYPE string DEFAULT "normal";
        \\DEFINE FIELD IF NOT EXISTS reminder_sent ON tasks TYPE bool DEFAULT false;
        \\DEFINE FIELD IF NOT EXISTS reminder_sent_at ON tasks TYPE option<datetime>;
    );

    // Define sessions table for secure token storage
    try runMigration(allocator, "003_sessions_schema",
        \\DEFINE TABLE IF NOT EXISTS sessions SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS token ON sessions TYPE string;
        \\DEFINE FIELD IF NOT EXISTS user_id ON sessions TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS created_at ON sessions TYPE datetime DEFAULT time::now();
        \\DEFINE FIELD IF NOT EXISTS expires_at ON sessions TYPE datetime;
        \\DEFINE INDEX IF NOT EXISTS session_token_idx ON sessions COLUMNS token UNIQUE;
    );

    try runMigration(allocator, "004_activity_schema",
        \\DEFINE TABLE IF NOT EXISTS activity_events SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS user_id ON activity_events TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS action ON activity_events TYPE string;
        \\DEFINE FIELD IF NOT EXISTS entity_type ON activity_events TYPE string;
        \\DEFINE FIELD IF NOT EXISTS entity_id ON activity_events TYPE string DEFAULT "";
        \\DEFINE FIELD IF NOT EXISTS created_at ON activity_events TYPE datetime DEFAULT time::now();
    );

    try runMigration(allocator, "005_workspaces_schema",
        \\DEFINE TABLE IF NOT EXISTS workspaces SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS name ON workspaces TYPE string;
        \\DEFINE FIELD IF NOT EXISTS owner_id ON workspaces TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS created_at ON workspaces TYPE datetime DEFAULT time::now();
        \\DEFINE TABLE IF NOT EXISTS workspace_members SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS workspace_id ON workspace_members TYPE record<workspaces>;
        \\DEFINE FIELD IF NOT EXISTS user_id ON workspace_members TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS role ON workspace_members TYPE string ASSERT $value INSIDE ["owner", "admin", "member", "viewer"];
        \\DEFINE FIELD IF NOT EXISTS created_at ON workspace_members TYPE datetime DEFAULT time::now();
        \\DEFINE INDEX IF NOT EXISTS workspace_members_unique_idx ON workspace_members COLUMNS workspace_id, user_id UNIQUE;
        \\DEFINE FIELD IF NOT EXISTS workspace_id ON tasks TYPE option<record<workspaces>>;
    );

    try runMigration(allocator, "006_workspace_invites_schema",
        \\DEFINE TABLE IF NOT EXISTS workspace_invites SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS workspace_id ON workspace_invites TYPE record<workspaces>;
        \\DEFINE FIELD IF NOT EXISTS email ON workspace_invites TYPE string;
        \\DEFINE FIELD IF NOT EXISTS role ON workspace_invites TYPE string ASSERT $value INSIDE ["admin", "member", "viewer"];
        \\DEFINE FIELD IF NOT EXISTS token ON workspace_invites TYPE string;
        \\DEFINE FIELD IF NOT EXISTS invited_by ON workspace_invites TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS expires_at ON workspace_invites TYPE int;
        \\DEFINE FIELD IF NOT EXISTS accepted_at ON workspace_invites TYPE option<int>;
        \\DEFINE FIELD IF NOT EXISTS created_at ON workspace_invites TYPE datetime DEFAULT time::now();
        \\DEFINE INDEX IF NOT EXISTS workspace_invites_token_idx ON workspace_invites COLUMNS token UNIQUE;
    );

    // SECURITY: the CSRF token used to be a standalone random value that was
    // never stored, so verification could only check "cookie equals header".
    // Any sibling subdomain able to set a cookie on the parent domain could
    // satisfy that. Binding it to the session makes forgery require the
    // session token itself, which is HttpOnly and unreadable from script.
    try runMigration(allocator, "007_session_csrf",
        \\DEFINE FIELD IF NOT EXISTS csrf_hash ON sessions TYPE string DEFAULT "";
    );

    // Bring rows written before email normalisation into the canonical form,
    // so the UNIQUE index and every lookup agree on one spelling. Verified
    // beforehand that no two accounts differ only by case, which this would
    // otherwise collide.
    try runMigration(allocator, "008_lowercase_emails",
        \\UPDATE users SET email = string::lowercase(email) WHERE email != string::lowercase(email);
        \\UPDATE workspace_invites SET email = string::lowercase(email) WHERE email != string::lowercase(email);
    );

    try runMigration(allocator, "011_task_board_and_structure",
        // Kanban column. `completed` stays the source of truth for "is this
        // done" — every existing query and the whole front end already read
        // it — and status is kept consistent with it rather than replacing it.
        \\DEFINE FIELD IF NOT EXISTS status ON tasks TYPE string DEFAULT "todo" ASSERT $value INSIDE ["todo", "doing", "done"];
        // A subtask is a task with a parent, not a different kind of record,
        // so it inherits editing, tags, due dates, reminders and the whole
        // permission model without any of them being written twice.
        \\DEFINE FIELD IF NOT EXISTS parent_id ON tasks TYPE option<record<tasks>>;
        // Who is expected to do it. The handler checks they belong to the
        // task's workspace; the schema only says it is a user.
        \\DEFINE FIELD IF NOT EXISTS assignee_id ON tasks TYPE option<record<users>>;
        // A small vocabulary rather than a cron expression: the next instance
        // is created when one is completed.
        \\DEFINE FIELD IF NOT EXISTS recurrence ON tasks TYPE string DEFAULT "none" ASSERT $value INSIDE ["none", "daily", "weekly", "monthly"];
    );

    // A reminder that cannot be delivered must eventually stop being retried.
    // Without a counter the reminder loop re-attempts the same undeliverable
    // task every minute, forever, three SMTP connections at a time.
    try runMigration(allocator, "010_reminder_attempts",
        \\DEFINE FIELD IF NOT EXISTS reminder_attempts ON tasks TYPE int DEFAULT 0;
    );

    try runMigration(allocator, "009_task_notes_and_tags",
        \\DEFINE FIELD IF NOT EXISTS notes ON tasks TYPE string DEFAULT "";
        \\DEFINE FIELD IF NOT EXISTS tags ON tasks TYPE array<string> DEFAULT [];
        \\DEFINE FIELD IF NOT EXISTS updated_at ON tasks TYPE option<datetime>;
    );

    try runMigration(allocator, "011_recurrence_once",
        \\DEFINE FIELD IF NOT EXISTS recurrence_spawned ON tasks TYPE bool DEFAULT false;
        \\UPDATE tasks SET recurrence_spawned = true WHERE completed = true AND recurrence != "none";
        \\UPDATE tasks SET status = "done" WHERE completed = true AND status != "done";
        \\UPDATE tasks SET status = "todo" WHERE completed = false AND status = "done";
    );

    try runMigration(allocator, "012_authorization_fences",
        \\DEFINE FIELD IF NOT EXISTS security_revision ON users TYPE int DEFAULT 0;
        \\DEFINE FIELD IF NOT EXISTS security_revision ON workspaces TYPE int DEFAULT 0;
    );

    try runMigration(allocator, "013_mail_outbox",
        \\DEFINE TABLE IF NOT EXISTS mail_guard SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS revision ON mail_guard TYPE int DEFAULT 0;
        \\DEFINE FIELD IF NOT EXISTS key_fingerprint ON mail_guard TYPE option<string>;
        \\DEFINE TABLE IF NOT EXISTS mail_outbox SCHEMAFULL;
        \\DEFINE FIELD IF NOT EXISTS owner_id ON mail_outbox TYPE record<users>;
        \\DEFINE FIELD IF NOT EXISTS reference_id ON mail_outbox TYPE record;
        \\DEFINE FIELD IF NOT EXISTS kind ON mail_outbox TYPE string ASSERT $value INSIDE ["confirmation", "password_reset", "workspace_invite"];
        \\DEFINE FIELD IF NOT EXISTS encrypted_payload ON mail_outbox TYPE string;
        \\DEFINE FIELD IF NOT EXISTS secret_hash ON mail_outbox TYPE string;
        \\DEFINE FIELD IF NOT EXISTS status ON mail_outbox TYPE string DEFAULT "pending" ASSERT $value INSIDE ["pending", "processing", "delivered", "failed", "cancelled"];
        \\DEFINE FIELD IF NOT EXISTS attempts ON mail_outbox TYPE int DEFAULT 0;
        \\DEFINE FIELD IF NOT EXISTS available_at ON mail_outbox TYPE int DEFAULT 0;
        \\DEFINE FIELD IF NOT EXISTS expires_at ON mail_outbox TYPE int;
        \\DEFINE FIELD IF NOT EXISTS lease_until ON mail_outbox TYPE int DEFAULT 0;
        \\DEFINE FIELD IF NOT EXISTS lease_token ON mail_outbox TYPE option<string>;
        \\DEFINE FIELD IF NOT EXISTS last_error ON mail_outbox TYPE string DEFAULT "";
        \\DEFINE FIELD IF NOT EXISTS created_at ON mail_outbox TYPE int DEFAULT time::unix();
        \\DEFINE INDEX IF NOT EXISTS mail_ready ON mail_outbox FIELDS status, available_at;
        \\DEFINE INDEX IF NOT EXISTS mail_owner ON mail_outbox FIELDS owner_id;
    );

    try runMigration(allocator, "014_task_trash",
        \\DEFINE FIELD IF NOT EXISTS deleted_at ON tasks TYPE option<int>;
        \\DEFINE FIELD IF NOT EXISTS delete_batch ON tasks TYPE option<string>;
        \\DEFINE INDEX IF NOT EXISTS task_trash_scope ON tasks FIELDS workspace_id, deleted_at;
    );

    std.debug.print("✅ SurrealDB schema initialized\n", .{});
}

// ============== USER OPERATIONS ==============

pub const MailJob = struct {
    id: []const u8,
    owner_id: []const u8,
    reference_id: []const u8,
    kind: []const u8,
    encrypted_payload: []const u8,
    secret_hash: []const u8,
    attempts: u32,
    lease_token: []const u8,
    expires_at: i64,
};

pub fn checkMailKey(allocator: std.mem.Allocator) !void {
    const fingerprint = try mail_payload.keyFingerprint();
    const result = try queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $stored = (SELECT VALUE key_fingerprint FROM mail_guard:queue)[0];
        \\IF $stored = NONE {
        \\    UPSERT mail_guard:queue SET revision = (revision ?? 0) + 1, key_fingerprint = $fingerprint;
        \\} ELSE IF $stored != $fingerprint { THROW "MAIL_KEY_MISMATCH: restore the original private runtime key"; };
        \\COMMIT TRANSACTION;
    , .{ .fingerprint = @as([]const u8, &fingerprint) });
    allocator.free(result);
}

pub fn claimMail(allocator: std.mem.Allocator, lease: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $candidate = (SELECT VALUE id FROM mail_outbox WHERE (status = "pending" AND available_at <= time::unix() OR status = "processing" AND lease_until <= time::unix()) AND expires_at > time::unix() + 35 AND attempts < 5 LIMIT 1)[0];
        \\LET $claimed = (UPDATE mail_outbox SET status = "processing", attempts += 1, lease_token = $lease, lease_until = time::unix() + 120 WHERE id = $candidate RETURN AFTER);
        \\RETURN $claimed;
        \\COMMIT TRANSACTION;
    , .{ .lease = lease });
}

pub fn maintainMail(allocator: std.mem.Allocator) !void {
    const result = try query(allocator,
        \\UPDATE mail_outbox SET status = "cancelled", encrypted_payload = "", secret_hash = "", lease_token = NONE, last_error = "expired" WHERE status INSIDE ["pending", "processing"] AND expires_at <= time::unix() + 35;
        \\UPDATE mail_outbox SET status = "failed", encrypted_payload = "", secret_hash = "", lease_token = NONE, last_error = "attempt_limit" WHERE status = "processing" AND lease_until <= time::unix() AND attempts >= 5;
        \\DELETE mail_outbox WHERE status INSIDE ["delivered", "cancelled", "failed"] AND created_at < time::unix() - 604800;
    );
    allocator.free(result);
}

pub fn mailStillValid(allocator: std.mem.Allocator, job: MailJob) !bool {
    const result = try queryWithVars(allocator,
        \\LET $job = (SELECT * FROM mail_outbox WHERE id = $job_id AND status = "processing" AND lease_token = $lease AND lease_until > time::unix() AND expires_at > time::unix() + 35)[0];
        \\LET $user = (SELECT * FROM ONLY $owner);
        \\LET $invite = IF $kind = "workspace_invite" { (SELECT * FROM workspace_invites WHERE id = $reference AND token = $hash AND accepted_at = NONE AND expires_at > time::unix() + 35)[0]; } ELSE { NONE; };
        \\LET $issuer = IF $invite != NONE { (SELECT VALUE role FROM workspace_members WHERE user_id = $owner AND workspace_id = $invite.workspace_id)[0]; } ELSE { NONE; };
        \\RETURN [{ valid: $job != NONE AND $user != NONE AND (
        \\    $kind = "confirmation" AND !$user.email_verified AND $user.verification_token = $hash AND $user.verification_expires > time::unix() + 35
        \\    OR $kind = "password_reset" AND $user.reset_token = $hash AND $user.reset_expires > time::unix() + 35
        \\    OR $kind = "workspace_invite" AND $invite != NONE AND $invite.invited_by = $owner AND $issuer INSIDE ["owner", "admin"]
        \\) }];
    , .{ .job_id = rec(job.id), .owner = rec(job.owner_id), .reference = rec(job.reference_id), .hash = job.secret_hash, .kind = job.kind, .lease = job.lease_token });
    defer allocator.free(result);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(struct { valid: bool }), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    return parsed.value.len == 1 and parsed.value[0].result.len == 1 and parsed.value[0].result[0].valid;
}

pub fn finishMail(allocator: std.mem.Allocator, job: MailJob, status: []const u8, failure: []const u8) !void {
    const delay: u32 = switch (job.attempts) {
        0, 1 => 30,
        2 => 120,
        3 => 480,
        else => 1800,
    };
    const terminal = !std.mem.eql(u8, status, "pending") or job.attempts >= 5;
    const result = try queryWithVars(allocator,
        \\UPDATE mail_outbox SET status = $status, encrypted_payload = IF $terminal { ""; } ELSE { encrypted_payload; }, secret_hash = IF $terminal { ""; } ELSE { secret_hash; }, last_error = $failure, lease_token = NONE, lease_until = 0, available_at = time::unix() + $delay WHERE id = $job_id AND lease_token = $lease AND status = "processing";
    , .{ .job_id = rec(job.id), .lease = job.lease_token, .status = if (job.attempts >= 5 and std.mem.eql(u8, status, "pending")) "failed" else status, .terminal = terminal, .failure = failure, .delay = delay });
    allocator.free(result);
}

pub fn listMail(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT id, kind, reference_id, status, attempts, created_at, last_error FROM mail_outbox WHERE owner_id = $owner ORDER BY created_at DESC LIMIT 100;
    , .{ .owner = rec(user_id) });
}

pub fn mailStats(allocator: std.mem.Allocator) ![]u8 {
    return query(allocator, "SELECT status, count() AS total, math::min(created_at) AS oldest FROM mail_outbox GROUP BY status;");
}

fn nextDueDate(allocator: std.mem.Allocator, due: []const u8, recurrence: []const u8) !?[]u8 {
    const ts = validation.dueDateToTimestamp(due) orelse return null;
    const now = std.time.timestamp();
    const date = if (std.mem.eql(u8, recurrence, "daily") or std.mem.eql(u8, recurrence, "weekly")) blk: {
        const step: i64 = if (std.mem.eql(u8, recurrence, "daily")) 86400 else 7 * 86400;
        const count = @max(1, @divFloor(now - ts, step) + 1);
        break :blk try validation.timestampToDueDate(allocator, ts + count * step);
    } else if (std.mem.eql(u8, recurrence, "monthly")) blk: {
        const today = try validation.timestampToDueDate(allocator, now);
        defer allocator.free(today);
        const year = try std.fmt.parseInt(i64, today[0..4], 10);
        const month = try std.fmt.parseInt(i64, today[5..7], 10);
        const due_year = try std.fmt.parseInt(i64, due[0..4], 10);
        const due_month = try std.fmt.parseInt(i64, due[5..7], 10);
        var months = @max(1, (year - due_year) * 12 + month - due_month);
        const candidate = try validation.addMonthClamped(allocator, ts, months);
        if ((validation.dueDateToTimestamp(candidate) orelse return error.InvalidDueDate) > now) break :blk candidate;
        allocator.free(candidate);
        months += 1;
        break :blk try validation.addMonthClamped(allocator, ts, months);
    } else return null;
    defer allocator.free(date);
    return try normalizeDueDate(allocator, date);
}

pub fn createUser(allocator: std.mem.Allocator, email: []const u8, password_hash: []const u8, name: []const u8, verification_token: []const u8, verification_expires: i64) ![]u8 {
    const verification_hash = hashToken(verification_token);
    const encrypted = try mail_payload.seal(allocator, .{ .kind = "confirmation", .email = email, .name = name, .secret = verification_token });
    defer allocator.free(encrypted);
    return queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $created = (CREATE users SET email = $email, password_hash = $password_hash, name = $name, email_verified = false, verification_token = $verification_tkn, verification_expires = $expires, verification_attempts = 0);
        \\LET $mail_owner = $created[0].id;
        \\LET $mail_ref = $mail_owner;
    ++ "\n" ++ insertMail ++
        \\RETURN $created;
        \\COMMIT TRANSACTION;
    , .{
        .email = email,
        .password_hash = password_hash,
        .name = name,
        .verification_tkn = verification_hash,
        .expires = verification_expires,
        .mail_kind = @as([]const u8, "confirmation"),
        .mail_payload = encrypted,
        .mail_hash = verification_hash,
        .mail_expires = verification_expires,
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
    , .{ .record_id = rec(id) });
}

pub fn updateUserName(allocator: std.mem.Allocator, user_id: []const u8, name: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\UPDATE $record_id SET name = $name;
    , .{ .record_id = rec(user_id), .name = name });
}

pub fn changePasswordAtomic(allocator: std.mem.Allocator, user_id: []const u8, expected_hash: []const u8, password_hash: []const u8) !NewSession {
    const session = NewSession{ .token = generateSecureToken(), .csrf = generateSecureToken() };
    const result = try queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $changed = (UPDATE users SET password_hash = $password_hash, reset_token = NONE, reset_expires = NONE WHERE id = $record_id AND password_hash = $expected_hash RETURN AFTER);
        \\IF array::len($changed) != 1 { THROW "APP_CONFLICT"; };
        \\DELETE sessions WHERE user_id = $record_id;
        \\CREATE sessions SET user_id = $record_id, token = $session_hash, csrf_hash = $csrf_hash, expires_at = time::now() + 7d;
        \\RETURN [];
        \\COMMIT TRANSACTION;
    , .{ .record_id = rec(user_id), .expected_hash = expected_hash, .password_hash = password_hash, .session_hash = hashToken(&session.token), .csrf_hash = hashToken(&session.csrf) });
    allocator.free(result);
    return session;
}

/// Atomic reset: set new password hash AND clear reset_token/expires in one
/// UPDATE, so the token can never survive a partial failure and be replayed.
pub fn resetUserPasswordAndClearToken(
    allocator: std.mem.Allocator,
    user_id: []const u8,
    password_hash: []const u8,
    token: []const u8,
) !bool {
    const result = try queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $changed = (UPDATE $record_id SET password_hash = $password_hash, reset_token = NONE, reset_expires = NONE WHERE reset_token = $token_hash AND reset_expires != NONE AND reset_expires >= time::unix() RETURN AFTER);
        \\IF array::len($changed) > 0 { DELETE sessions WHERE user_id = $record_id; };
        \\RETURN $changed;
        \\COMMIT TRANSACTION;
    , .{ .record_id = rec(user_id), .password_hash = password_hash, .token_hash = hashToken(token) });
    defer allocator.free(result);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), allocator, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    return parsed.value.len > 0 and parsed.value[0].result.len == 1;
}

pub fn setResetToken(allocator: std.mem.Allocator, user: models.User, token: []const u8, expires: i64) ![]u8 {
    return setCredentialMail(allocator, user, token, expires, false);
}

pub fn clearResetToken(allocator: std.mem.Allocator, user_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET reset_token = NONE, reset_expires = NONE;
    , .{ .record_id = rec(user_id) });
    allocator.free(result);
}

pub fn setVerificationToken(allocator: std.mem.Allocator, user: models.User, token: []const u8, expires: i64) ![]u8 {
    return setCredentialMail(allocator, user, token, expires, true);
}

fn setCredentialMail(allocator: std.mem.Allocator, user: models.User, token: []const u8, expires: i64, verification: bool) ![]u8 {
    const kind: []const u8 = if (verification) "confirmation" else "password_reset";
    const encrypted = try mail_payload.seal(allocator, .{ .kind = kind, .email = user.email, .name = user.name, .secret = token });
    defer allocator.free(encrypted);
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ actorFence ++
        \\IF $verification {
        \\    UPDATE $actor_id SET verification_token = $mail_hash, verification_expires = $mail_expires, verification_attempts = 0;
        \\} ELSE { UPDATE $actor_id SET reset_token = $mail_hash, reset_expires = $mail_expires; };
        \\LET $mail_owner = $actor_id;
        \\LET $mail_ref = $actor_id;
    ++ "\n" ++ insertMail ++
        \\RETURN [];
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(user.id), .verification = verification, .mail_kind = kind, .mail_payload = encrypted, .mail_hash = hashToken(token), .mail_expires = expires });
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
    , .{ .record_id = rec(user_id), .code = code_hash, .now_ts = now_ts });
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
    , .{ .record_id = rec(user_id), .max = @as(i64, @intCast(max_attempts)) });
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
    , .{ .user_id = rec(user_id) });
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

    // Recheck inside the actor fence: concurrent first logins must not both
    // create a default workspace. Legacy task attachment belongs to the same
    // transaction, so failure cannot leave partial initialization behind.
    const initialized = try queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ actorFence ++
        \\LET $existing = (SELECT workspace_id FROM workspace_members WHERE user_id = $actor_id LIMIT 1);
        \\LET $selected = IF array::len($existing) > 0 { $existing; } ELSE {
        \\    LET $created = (CREATE workspaces SET name = $name, owner_id = $actor_id, created_at = time::now());
        \\    CREATE workspace_members SET workspace_id = $created[0].id, user_id = $actor_id, role = "owner", created_at = time::now();
        \\    UPDATE tasks SET workspace_id = $created[0].id WHERE user_id = $actor_id AND workspace_id = NONE;
        \\    [{ workspace_id: $created[0].id }];
        \\};
        \\RETURN $selected;
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(user_id), .name = workspace_name });
    defer allocator.free(initialized);

    const parsed_initialized = try std.json.parseFromSlice([]models.SurrealResponse(ExistingRow), allocator, initialized, .{ .ignore_unknown_fields = true });
    defer parsed_initialized.deinit();
    if (parsed_initialized.value.len == 0 or parsed_initialized.value[0].result.len == 0) return error.WorkspaceCreateFailed;

    return try allocator.dupe(u8, parsed_initialized.value[0].result[0].workspace_id);
}

pub fn createWorkspace(allocator: std.mem.Allocator, owner_id: []const u8, name: []const u8) ![]u8 {
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ actorFence ++
        \\LET $created = (CREATE workspaces SET name = $name, owner_id = $actor_id, created_at = time::now());
        \\CREATE workspace_members SET workspace_id = $created[0].id, user_id = $actor_id, role = "owner", created_at = time::now();
        \\RETURN $created;
        \\COMMIT TRANSACTION;
    , .{ .name = name, .actor_id = rec(owner_id) });
}

pub fn getWorkspaceById(allocator: std.mem.Allocator, workspace_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM $workspace_id;
    , .{ .workspace_id = rec(workspace_id) });
}

pub fn listWorkspacesForUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    // ORDER BY, so the switcher lists workspaces in a stable order. Without it
    // the order came back however the index happened to yield rows, and the
    // selected entry could appear to jump between reloads.
    return queryWithVars(allocator,
        \\SELECT workspace_id.id AS id, workspace_id.name AS name, role, workspace_id.created_at AS created_at FROM workspace_members WHERE user_id = $user_id ORDER BY created_at ASC;
    , .{ .user_id = rec(user_id) });
}

pub fn getWorkspaceRole(allocator: std.mem.Allocator, user_id: []const u8, workspace_id: []const u8) !?[]const u8 {
    const result = try queryWithVars(allocator,
        \\SELECT role FROM workspace_members WHERE user_id = $user_id AND workspace_id = $workspace_id LIMIT 1;
    , .{ .user_id = rec(user_id), .workspace_id = rec(workspace_id) });
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
    , .{ .record_id = rec(user_id) });
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
    , .{ .workspace_id = rec(workspace_id) });
}

pub fn createWorkspaceInvite(
    allocator: std.mem.Allocator,
    workspace_id: []const u8,
    workspace_name: []const u8,
    email: []const u8,
    role: []const u8,
    invited_by: []const u8,
    token: []const u8,
    expires_at: i64,
) ![]u8 {
    const token_hash = hashToken(token);
    const encrypted = try mail_payload.seal(allocator, .{ .kind = "workspace_invite", .email = email, .name = workspace_name, .secret = token });
    defer allocator.free(encrypted);
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ adminFence ++
        \\IF !$actor[0].email_verified { THROW "APP_FORBIDDEN"; };
        \\IF array::len(SELECT id FROM workspace_invites WHERE workspace_id = $workspace_id AND email = $email AND accepted_at = NONE AND expires_at >= time::unix()) > 0 { THROW "APP_INVALID"; };
        \\LET $created = (CREATE workspace_invites SET workspace_id = $workspace_id, email = $email, role = $invite_role, token = $invite_token, invited_by = $actor_id, expires_at = $expires_at, accepted_at = NONE, created_at = time::now());
        \\LET $mail_owner = $actor_id;
        \\LET $mail_ref = $created[0].id;
    ++ "\n" ++ insertMail ++
        \\RETURN $created;
        \\COMMIT TRANSACTION;
    , .{
        .workspace_id = rec(workspace_id),
        .email = email,
        .invite_role = role,
        .invite_token = token_hash,
        .actor_id = rec(invited_by),
        .expires_at = expires_at,
        .mail_kind = @as([]const u8, "workspace_invite"),
        .mail_payload = encrypted,
        .mail_hash = token_hash,
        .mail_expires = expires_at,
    });
}

pub fn hasPendingWorkspaceInvite(allocator: std.mem.Allocator, workspace_id: []const u8, email: []const u8, now_ts: i64) !bool {
    const result = try queryWithVars(allocator,
        \\SELECT id FROM workspace_invites WHERE workspace_id = $workspace_id AND email = $email AND accepted_at = NONE AND expires_at >= $now_ts LIMIT 1;
    , .{ .workspace_id = rec(workspace_id), .email = email, .now_ts = now_ts });
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

pub fn acceptWorkspaceInviteAtomic(allocator: std.mem.Allocator, user_id: []const u8, token: []const u8) !void {
    const result = try queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ actorFence ++
        \\LET $invite = (SELECT * FROM workspace_invites WHERE token = $token_hash)[0];
        \\IF $invite == NONE { THROW "APP_NOT_FOUND"; };
        \\LET $workspace_id = $invite.workspace_id;
    ++ "\n" ++ workspaceFence ++
        \\IF !$actor[0].email_verified OR string::lowercase($actor[0].email) != string::lowercase($invite.email) { THROW "APP_FORBIDDEN"; };
        \\LET $issuer_role = (SELECT VALUE role FROM workspace_members WHERE user_id = $invite.invited_by AND workspace_id = $workspace_id)[0];
        \\IF !($issuer_role INSIDE ["owner", "admin"]) { THROW "APP_FORBIDDEN"; };
        \\IF $invite.accepted_at != NONE OR $invite.expires_at < time::unix() { THROW "APP_INVALID"; };
        \\IF array::len(SELECT id FROM workspace_members WHERE user_id = $actor_id AND workspace_id = $workspace_id) > 0 { THROW "APP_INVALID"; };
        \\UPDATE $invite.id SET accepted_at = time::unix();
        \\CREATE workspace_members SET workspace_id = $workspace_id, user_id = $actor_id, role = $invite.role, created_at = time::now();
        \\RETURN [];
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(user_id), .token_hash = hashToken(token) });
    allocator.free(result);
}

/// Change a member's role. Scoped by workspace_id + user_id and returns the
/// updated row(s), so an empty result means the user wasn't a member.
pub fn updateWorkspaceMemberRole(allocator: std.mem.Allocator, actor_id: []const u8, workspace_id: []const u8, user_id: []const u8, role: []const u8) ![]u8 {
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ adminFence ++
        \\IF $target_role == "owner" { THROW "APP_FORBIDDEN"; };
        \\LET $changed = (UPDATE workspace_members SET role = $target_role WHERE workspace_id = $workspace_id AND user_id = $user_id AND role != "owner" RETURN AFTER);
        \\RETURN $changed;
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(actor_id), .workspace_id = rec(workspace_id), .user_id = rec(user_id), .target_role = role });
}

/// Remove a member from a workspace. RETURN BEFORE yields the deleted row(s),
/// so an empty result means there was nothing to remove.
pub fn removeWorkspaceMember(allocator: std.mem.Allocator, actor_id: []const u8, workspace_id: []const u8, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ adminFence ++
        \\LET $deleted = (DELETE workspace_members WHERE workspace_id = $workspace_id AND user_id = $user_id AND role != "owner" RETURN BEFORE);
        \\IF array::len($deleted) > 0 {
        \\    UPDATE tasks SET assignee_id = NONE WHERE workspace_id = $workspace_id AND assignee_id = $user_id;
        \\    DELETE workspace_invites WHERE workspace_id = $workspace_id AND invited_by = $user_id AND accepted_at = NONE;
        \\};
        \\RETURN $deleted;
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(actor_id), .workspace_id = rec(workspace_id), .user_id = rec(user_id) });
}

pub fn listPendingWorkspaceInvites(allocator: std.mem.Allocator, workspace_id: []const u8, now_ts: i64) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT id, email, role, expires_at, created_at FROM workspace_invites WHERE workspace_id = $workspace_id AND accepted_at = NONE AND expires_at >= $now_ts ORDER BY created_at DESC;
    , .{ .workspace_id = rec(workspace_id), .now_ts = now_ts });
}

/// Revoke a pending invite, scoped to its workspace so an admin can't delete
/// another workspace's invite by guessing its id. RETURN BEFORE reports a match.
pub fn deleteWorkspaceInviteScoped(allocator: std.mem.Allocator, actor_id: []const u8, invite_id: []const u8, workspace_id: []const u8) ![]u8 {
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ adminFence ++
        \\LET $deleted = (DELETE workspace_invites WHERE id = $invite_id AND workspace_id = $workspace_id AND accepted_at = NONE RETURN BEFORE);
        \\RETURN $deleted;
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(actor_id), .invite_id = rec(invite_id), .workspace_id = rec(workspace_id) });
}

// ============== TASK OPERATIONS ==============

/// Everything needed to insert a task. Replaces the createTask /
/// createTaskWithDueDate pair, which duplicated the whole statement to vary
/// one column and left tags and notes with no way in at all.
pub const NewTask = struct {
    user_id: []const u8,
    workspace_id: []const u8,
    title: []const u8,
    priority: []const u8 = "normal",
    notes: []const u8 = "",
    tags: []const []const u8 = &.{},
    due_date: ?[]const u8 = null,
    status: []const u8 = "todo",
    recurrence: []const u8 = "none",
    /// Set to make this task a subtask of another.
    parent_id: ?[]const u8 = null,
    assignee_id: ?[]const u8 = null,
};

pub fn createTask(allocator: std.mem.Allocator, task: NewTask) ![]u8 {
    // Optional columns are appended only when supplied, so an ordinary task is
    // not written with NONE assignments it never asked for. Every fragment
    // below is a compile-time string; only values are bound.
    var sets = std.ArrayListUnmanaged(u8){};
    defer sets.deinit(allocator);
    const w = sets.writer(allocator);

    try w.writeAll("user_id = $user_id, workspace_id = $workspace_id, title = $title, " ++
        "priority = $priority, notes = $notes, tags = $tags, status = $status, " ++
        "recurrence = $recurrence, completed = $completed, reminder_sent = false, " ++
        "reminder_attempts = 0, created_at = time::now()");

    const has_due = task.due_date != null and task.due_date.?.len > 0;
    if (has_due) try w.writeAll(", due_date = <datetime>$due_date");
    if (task.parent_id != null) try w.writeAll(", parent_id = $parent_id");
    if (task.assignee_id != null) try w.writeAll(", assignee_id = $assignee_id");

    const sql = try std.fmt.allocPrint(allocator, "BEGIN TRANSACTION;\n{s}{s}{s}" ++
        \\IF !($role INSIDE ["owner", "admin", "member"]) {{ THROW "APP_FORBIDDEN"; }};
        \\IF $has_parent {{
        \\    LET $parent = (SELECT * FROM ONLY $parent_id);
        \\    IF $parent == NONE OR $parent.deleted_at != NONE OR $parent.workspace_id != $workspace_id OR $parent.parent_id != NONE {{ THROW "APP_INVALID"; }};
        \\}};
        \\IF $has_assignee AND array::len(SELECT id FROM workspace_members WHERE user_id = $assignee_id AND workspace_id = $workspace_id) != 1 {{ THROW "APP_INVALID"; }};
        \\LET $created = (CREATE tasks SET {s});
        \\RETURN $created;
        \\COMMIT TRANSACTION;
    , .{ actorFence, workspaceFence, workspaceRole, sets.items });
    defer allocator.free(sql);

    var due_owned: ?[]u8 = null;
    defer if (due_owned) |d| allocator.free(d);
    var due_bind: []const u8 = "";
    if (has_due) {
        due_owned = try normalizeDueDate(allocator, task.due_date.?);
        due_bind = due_owned.?;
    }

    return queryWithVars(allocator, sql, .{
        .user_id = rec(task.user_id),
        .actor_id = rec(task.user_id),
        .workspace_id = rec(task.workspace_id),
        .title = task.title,
        .priority = task.priority,
        .notes = task.notes,
        .tags = task.tags,
        .status = task.status,
        .recurrence = task.recurrence,
        .completed = std.mem.eql(u8, task.status, "done"),
        .due_date = due_bind,
        // Bound unconditionally because the bind list is comptime, but only
        // referenced by the statement when the caller supplied one.
        .parent_id = rec(task.parent_id orelse "tasks:unset"),
        .assignee_id = rec(task.assignee_id orelse "users:unset"),
        .has_parent = task.parent_id != null,
        .has_assignee = task.assignee_id != null,
    });
}

/// Every task the user can see, subtasks included.
///
/// Subtasks come back in the same list rather than through a separate call:
/// the front end already holds the whole set in memory to filter and sort it,
/// and nesting them there costs one pass over an array instead of a request
/// per parent.
pub fn getTasksByUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM tasks WHERE deleted_at = NONE AND (workspace_id IN (SELECT VALUE workspace_id FROM workspace_members WHERE user_id = $user_id) OR (user_id = $user_id AND workspace_id = NONE)) ORDER BY created_at DESC LIMIT 2000;
    , .{ .user_id = rec(user_id) });
}

/// Delete a task together with anything hanging off it, so completing the
/// parent's removal cannot leave orphaned subtasks that no view will show.
pub fn deleteTaskWithChildren(allocator: std.mem.Allocator, task_id: []const u8, actor_id: []const u8) ![]u8 {
    if (!http_client.validRecordIdFor(task_id, "tasks")) return error.InvalidRecordId;
    const batch = generateSecureToken();
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ taskFence ++
        \\LET $deleted = (UPDATE tasks SET deleted_at = time::unix(), delete_batch = $batch WHERE deleted_at = NONE AND (id = $record_id OR parent_id = $record_id) AND workspace_id = $before.workspace_id AND ($before.workspace_id != NONE OR user_id = $actor_id) RETURN AFTER);
        \\RETURN $deleted;
        \\COMMIT TRANSACTION;
    , .{ .record_id = rec(task_id), .actor_id = rec(actor_id), .batch = @as([]const u8, &batch) });
}

pub fn listTaskTrash(allocator: std.mem.Allocator, actor_id: []const u8, workspace_id: []const u8, cursor: ?[]const u8) ![]u8 {
    return queryWithVars(allocator,
        \\LET $role = (SELECT VALUE role FROM workspace_members WHERE user_id = $actor_id AND workspace_id = $workspace_id)[0];
        \\IF $role = NONE { THROW "APP_FORBIDDEN"; };
        \\SELECT * FROM tasks WHERE workspace_id = $workspace_id AND deleted_at != NONE AND (!$has_cursor OR id < $cursor) ORDER BY id DESC LIMIT 101;
    , .{ .actor_id = rec(actor_id), .workspace_id = rec(workspace_id), .has_cursor = cursor != null, .cursor = rec(cursor orelse "tasks:unset") });
}

pub fn restoreTask(allocator: std.mem.Allocator, task_id: []const u8, actor_id: []const u8, expected_batch: ?[]const u8) ![]u8 {
    if (!http_client.validRecordIdFor(task_id, "tasks")) return error.InvalidRecordId;
    return queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ taskScopeFence ++
        \\IF $before.deleted_at = NONE OR $before.delete_batch = NONE { THROW "APP_INVALID"; };
        \\IF $expected_batch != NONE AND $before.delete_batch != $expected_batch { THROW "APP_CONFLICT"; };
        \\IF $before.parent_id != NONE {
        \\    LET $parent = (SELECT * FROM ONLY $before.parent_id);
        \\    IF $parent = NONE OR $parent.deleted_at != NONE { THROW "APP_PARENT_DELETED"; };
        \\    IF $parent.workspace_id != $workspace_id OR $parent.parent_id != NONE OR ($workspace_id = NONE AND $parent.user_id != $actor_id) { THROW "APP_INVALID"; };
        \\};
        \\LET $restored = (UPDATE tasks SET deleted_at = NONE, delete_batch = NONE WHERE deleted_at != NONE AND delete_batch = $before.delete_batch AND (id = $record_id OR parent_id = $record_id) AND workspace_id = $before.workspace_id AND ($before.workspace_id != NONE OR user_id = $actor_id) RETURN AFTER);
        \\RETURN $restored;
        \\COMMIT TRANSACTION;
    , .{ .record_id = rec(task_id), .actor_id = rec(actor_id), .expected_batch = expected_batch });
}

/// Partial update of a task. Only the fields the caller actually supplied are
/// written; everything else keeps its stored value.
///
/// The SET clause is assembled here rather than written out in full because
/// SurrealQL has no "update only if not null" form. Every fragment appended is
/// a compile-time string from this function — the field names never come from
/// the request — and every value travels as a bound variable, so the assembly
/// adds no injection surface.
pub const TaskPatch = struct {
    title: ?[]const u8 = null,
    priority: ?[]const u8 = null,
    notes: ?[]const u8 = null,
    completed: ?bool = null,
    tags: ?[]const []const u8 = null,
    /// Non-null and non-empty sets a due date; non-null and empty clears it.
    /// Null leaves the stored value alone — which is why this cannot simply be
    /// an optional string with null meaning "clear".
    due_date: ?[]const u8 = null,
    status: ?[]const u8 = null,
    recurrence: ?[]const u8 = null,
    /// Same convention as due_date: empty clears the assignment.
    assignee_id: ?[]const u8 = null,
    toggle: bool = false,
};

pub fn updateTask(allocator: std.mem.Allocator, task_id: []const u8, actor_id: []const u8, patch: TaskPatch) ![]u8 {
    // Read a snapshot to calculate calendar-aware recurrence in Zig. The
    // transaction below rechecks its version and writes the same row, so
    // concurrent mutations conflict at commit under snapshot isolation.
    const snapshot = try getTaskById(allocator, task_id);
    defer allocator.free(snapshot);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), allocator, snapshot, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) return error.NotFound;
    const before = parsed.value[0].result[0];
    const due = patch.due_date orelse before.due_date;
    const recurrence = patch.recurrence orelse before.recurrence;
    const next = if (due) |date| try nextDueDate(allocator, date, recurrence) else null;
    defer if (next) |date| allocator.free(date);

    var sets = std.ArrayListUnmanaged(u8){};
    defer sets.deinit(allocator);
    const w = sets.writer(allocator);

    try w.writeAll("updated_at = time::now()");
    if (patch.title != null) try w.writeAll(", title = $title");
    if (patch.priority != null) try w.writeAll(", priority = $priority");
    if (patch.notes != null) try w.writeAll(", notes = $notes");
    if (patch.completed != null or patch.toggle) try w.writeAll(", completed = $completed");
    if (patch.tags != null) try w.writeAll(", tags = $tags");
    if (patch.recurrence != null) try w.writeAll(", recurrence = $recurrence");
    // Completion and the board column are two views of one fact, so writing
    // either keeps the other consistent. Letting them drift would mean a task
    // shown in the Done column that the task list still counts as outstanding.
    if (patch.status) |st| {
        try w.writeAll(", status = $status");
        if (std.mem.eql(u8, st, "done")) {
            try w.writeAll(", completed = true");
        } else {
            try w.writeAll(", completed = false");
        }
    } else if (if (patch.toggle) @as(?bool, !before.completed) else patch.completed) |done| {
        try w.writeAll(if (done) ", status = \"done\"" else ", status = \"todo\"");
    }
    if (patch.assignee_id) |a| {
        if (a.len == 0) {
            try w.writeAll(", assignee_id = NONE");
        } else {
            try w.writeAll(", assignee_id = $assignee_id");
        }
    }
    if (patch.due_date) |dd| {
        try w.writeAll(", reminder_sent = false, reminder_sent_at = NONE, reminder_attempts = 0");
        if (dd.len == 0) {
            try w.writeAll(", due_date = NONE");
        } else {
            try w.writeAll(", due_date = <datetime>$due_date");
        }
    }

    const sql = try std.fmt.allocPrint(allocator, "BEGIN TRANSACTION;\n{s}" ++
        \\IF $before.updated_at != <option<datetime>>$expected_updated OR $before.completed != $expected_completed {{ THROW "Task changed; retry"; }};
        \\IF $has_assignee AND array::len(SELECT id FROM workspace_members WHERE user_id = $assignee_id AND workspace_id = $workspace_id) != 1 {{ THROW "APP_INVALID"; }};
        \\LET $changed = (UPDATE $record_id SET {s} RETURN AFTER);
        \\LET $task = $changed[0];
        \\IF $task.completed AND !$before.completed AND !$before.recurrence_spawned AND $next_due != NONE {{
        \\    CREATE tasks SET user_id = $task.user_id, workspace_id = $task.workspace_id, title = $task.title,
        \\        priority = $task.priority, notes = $task.notes, tags = $task.tags, recurrence = $task.recurrence,
        \\        assignee_id = $task.assignee_id, parent_id = $task.parent_id,
        \\        due_date = <datetime>$next_due, status = "todo", completed = false;
        \\    UPDATE $record_id SET recurrence_spawned = true;
        \\}};
        \\RETURN $changed;
        \\COMMIT TRANSACTION;
    , .{ taskFence, sets.items });
    defer allocator.free(sql);

    // due_date is normalised to a form SurrealDB accepts before binding.
    // datetime-local gives "2025-12-25T12:00"; the database wants seconds and
    // a zone.
    var due_owned: ?[]u8 = null;
    defer if (due_owned) |d| allocator.free(d);
    var due_bind: []const u8 = "";
    if (patch.due_date) |dd| {
        if (dd.len > 0) {
            due_owned = try normalizeDueDate(allocator, dd);
            due_bind = due_owned.?;
        }
    }

    return queryWithVars(allocator, sql, .{
        .record_id = rec(task_id),
        .actor_id = rec(actor_id),
        .title = patch.title orelse "",
        .priority = patch.priority orelse "normal",
        .notes = patch.notes orelse "",
        .completed = if (patch.toggle) !before.completed else patch.completed orelse false,
        .tags = patch.tags orelse &[_][]const u8{},
        .due_date = due_bind,
        .status = patch.status orelse "todo",
        .recurrence = patch.recurrence orelse "none",
        .assignee_id = rec(if (patch.assignee_id) |a| (if (a.len == 0) "users:unset" else a) else "users:unset"),
        .has_assignee = if (patch.assignee_id) |a| a.len > 0 else false,
        .expected_updated = before.updated_at,
        .expected_completed = before.completed,
        .next_due = next,
    });
}

/// "2025-12-25T12:00" -> "2025-12-25T12:00:00Z". Already-zoned values pass
/// through. Caller owns the result.
fn normalizeDueDate(allocator: std.mem.Allocator, due_date: []const u8) ![]u8 {
    if (std.mem.endsWith(u8, due_date, "Z")) return allocator.dupe(u8, due_date);
    if (std.mem.count(u8, due_date, ":") == 1) {
        return std.fmt.allocPrint(allocator, "{s}:00Z", .{due_date});
    }
    return std.fmt.allocPrint(allocator, "{s}Z", .{due_date});
}

pub fn toggleTask(allocator: std.mem.Allocator, task_id: []const u8, actor_id: []const u8) ![]u8 {
    return updateTask(allocator, task_id, actor_id, .{ .toggle = true });
}

/// Tasks whose deadline is close enough to warrant a reminder.
///
/// `lead_seconds` reaches forward from now, so a reminder arrives before the
/// deadline rather than after it. The previous condition was
/// `due_date <= time::now()`, which only ever fired once a task was already
/// overdue — a reminder that arrives too late to act on is a notification that
/// something has gone wrong, not a reminder.
pub fn getDueTasksForReminders(allocator: std.mem.Allocator, lead_seconds: i64, max_attempts: i64) ![]u8 {
    const lead = try std.fmt.allocPrint(allocator, "{d}s", .{lead_seconds});
    defer allocator.free(lead);

    return queryWithVars(allocator,
        \\SELECT * FROM tasks WHERE deleted_at = NONE AND completed = false AND due_date != NONE AND due_date <= time::now() + type::duration($lead) AND (reminder_sent = false OR reminder_sent = NONE) AND (reminder_attempts OR 0) < $max_attempts LIMIT 25;
    , .{ .lead = lead, .max_attempts = max_attempts });
}

/// Record a failed delivery. Once the count reaches the cap the task drops out
/// of getDueTasksForReminders, so a permanently undeliverable address stops
/// costing an SMTP connection every minute.
pub fn bumpReminderAttempts(allocator: std.mem.Allocator, task_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET reminder_attempts = (reminder_attempts OR 0) + 1 WHERE deleted_at = NONE;
    , .{ .record_id = rec(task_id) });
    allocator.free(result);
}

pub fn markTaskReminderSent(allocator: std.mem.Allocator, task_id: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\UPDATE $record_id SET reminder_sent = true, reminder_sent_at = time::now() WHERE deleted_at = NONE;
    , .{ .record_id = rec(task_id) });
    allocator.free(result);
}

/// Sessions belonging to a user, newest first, for the "where am I signed in"
/// list. The token hash is returned so the caller can mark which row is the
/// request's own session; the token itself is not recoverable.
pub fn listUserSessions(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT id, token, created_at, expires_at FROM sessions WHERE user_id = $user_id ORDER BY created_at DESC LIMIT 100;
    , .{ .user_id = rec(user_id) });
}

/// Revoke one session by record id, scoped to its owner so a valid session
/// cannot be used to delete somebody else's by guessing an id.
pub fn deleteSessionScoped(allocator: std.mem.Allocator, session_id: []const u8, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\DELETE sessions WHERE id = $session_id AND user_id = $user_id RETURN BEFORE;
    , .{ .session_id = rec(session_id), .user_id = rec(user_id) });
}

/// Revoke every session for a user except the one making the request.
pub fn deleteOtherUserSessions(allocator: std.mem.Allocator, user_id: []const u8, keep_token_hash: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\DELETE sessions WHERE user_id = $user_id AND token != $keep;
    , .{ .user_id = rec(user_id), .keep = keep_token_hash });
    allocator.free(result);
}

/// Everything a user owns, for the data export. Kept as one query per table so
/// the caller can stream them into a single JSON document without loading a
/// join result it would only have to take apart again.
pub fn exportUserTasks(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT id, title, notes, tags, completed, priority, due_date, created_at, updated_at, workspace_id, status, recurrence, parent_id, assignee_id, deleted_at, delete_batch FROM tasks WHERE workspace_id IN (SELECT VALUE workspace_id FROM workspace_members WHERE user_id = $user_id) OR (user_id = $user_id AND workspace_id = NONE) ORDER BY created_at DESC;
    , .{ .user_id = rec(user_id) });
}

/// Delete a user and everything that belongs to them.
///
/// Order matters: rows referencing the user go first, so no dangling
/// record<users> link is ever left behind. Workspaces the user owns are
/// removed along with their membership rows and invites — the owner cannot be
/// removed from a workspace by any other route, so deleting the account is the
/// only way a workspace loses its owner, and an ownerless workspace would be
/// unmanageable by anyone.
pub fn deleteUserAccount(allocator: std.mem.Allocator, user_id: []const u8, expected_hash: []const u8) !void {
    const result = try queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $actor = (UPDATE users SET security_revision = (security_revision ?? 0) + 1 WHERE id = $record_id AND password_hash = $expected_hash RETURN AFTER);
        \\IF array::len($actor) != 1 { THROW "APP_CONFLICT"; };
        \\LET $owned = (SELECT VALUE id FROM workspaces WHERE owner_id = $record_id);
        \\LET $removed_invites = (SELECT VALUE id FROM workspace_invites WHERE invited_by = $record_id OR workspace_id IN $owned);
        \\LET $removed_tasks = (SELECT VALUE id FROM tasks WHERE user_id = $record_id OR workspace_id IN $owned);
        \\UPDATE workspaces SET security_revision = (security_revision ?? 0) + 1 WHERE id IN $owned
        \\    OR id IN (SELECT VALUE workspace_id FROM workspace_members WHERE user_id = $record_id)
        \\    OR id IN (SELECT VALUE workspace_id FROM tasks WHERE assignee_id = $record_id OR parent_id IN $removed_tasks OR user_id = $record_id)
        \\    OR id IN (SELECT VALUE workspace_id FROM workspace_invites WHERE invited_by = $record_id);
        \\UPDATE tasks SET assignee_id = NONE WHERE assignee_id = $record_id;
        \\UPDATE tasks SET parent_id = NONE WHERE parent_id IN $removed_tasks;
        \\DELETE tasks WHERE user_id = $record_id OR workspace_id IN $owned;
        \\DELETE workspace_invites WHERE invited_by = $record_id OR workspace_id IN $owned;
        \\DELETE workspace_members WHERE user_id = $record_id OR workspace_id IN $owned;
        \\DELETE workspaces WHERE owner_id = $record_id;
        \\DELETE activity_events WHERE user_id = $record_id;
        \\DELETE mail_outbox WHERE owner_id = $record_id OR reference_id IN $removed_invites;
        \\DELETE sessions WHERE user_id = $record_id;
        \\DELETE $record_id;
        \\RETURN [];
        \\COMMIT TRANSACTION;
    , .{ .record_id = rec(user_id), .expected_hash = expected_hash });
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
    const result = try queryWithVars(allocator, "BEGIN TRANSACTION;\n" ++ actorFence ++
        \\CREATE activity_events SET user_id = $actor_id, action = $action, entity_type = $entity_type, entity_id = <string>$entity_id, created_at = time::now();
        \\RETURN [];
        \\COMMIT TRANSACTION;
    , .{ .actor_id = rec(user_id), .action = action, .entity_type = entity_type, .entity_id = entity_id });
    allocator.free(result);
}

pub fn getActivityByUser(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    return queryWithVars(allocator,
        \\SELECT * FROM activity_events WHERE user_id = $user_id ORDER BY created_at DESC LIMIT 50;
    , .{ .user_id = rec(user_id) });
}

// ============== TASK OWNERSHIP ==============

pub fn getTaskOwner(allocator: std.mem.Allocator, task_id: []const u8) !?[]const u8 {
    const result = try queryWithVars(allocator,
        \\SELECT user_id, workspace_id FROM $record_id;
    , .{ .record_id = rec(task_id) });
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
    if (!http_client.validRecordIdFor(task_id, "tasks")) return false;
    const result = try queryWithVars(allocator,
        \\SELECT user_id, workspace_id FROM $record_id WHERE deleted_at = NONE;
    , .{ .record_id = rec(task_id) });
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

pub fn getTaskById(allocator: std.mem.Allocator, task_id: []const u8) ![]u8 {
    if (!http_client.validRecordIdFor(task_id, "tasks")) return error.InvalidRecordId;
    return queryWithVars(allocator, "SELECT * FROM $record_id WHERE deleted_at = NONE;", .{ .record_id = rec(task_id) });
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

/// A freshly minted session: the opaque token that goes in the HttpOnly
/// cookie, and the CSRF token that goes in the script-readable one. Only
/// hashes of either are stored, so a database read cannot recover them.
pub const NewSession = struct {
    token: [64]u8,
    csrf: [64]u8,
};

/// Create a new session for a user. Session expires in 7 days by default.
pub fn createSession(allocator: std.mem.Allocator, user_id: []const u8, expected_hash: []const u8) !NewSession {
    const token = generateSecureToken();
    const token_hash = hashToken(token[0..]);

    // SECURITY: the CSRF token is minted here and its hash stored on the same
    // row, so it is only valid for this session. Verification recomputes the
    // hash from the submitted header and compares against the row reached via
    // the session cookie — an attacker who can set a cookie but cannot read
    // the HttpOnly session token has nothing to submit.
    const csrf = generateSecureToken();
    const csrf_hash = hashToken(csrf[0..]);

    // Calculate expiration (7 days from now in milliseconds)
    const expires_ms = std.time.milliTimestamp() + (7 * 24 * 60 * 60 * 1000);

    const result = try queryWithVars(allocator,
        \\BEGIN TRANSACTION;
        \\LET $actor = (UPDATE users SET security_revision = (security_revision ?? 0) + 1 WHERE id = $user_id AND password_hash = $expected_hash RETURN AFTER);
        \\IF array::len($actor) != 1 { THROW "APP_CONFLICT"; };
        \\CREATE sessions SET token = $session_token, user_id = $user_id, csrf_hash = $csrf_hash, expires_at = time::from_millis($expires_ms);
        \\RETURN [];
        \\COMMIT TRANSACTION;
    , .{ .session_token = token_hash, .user_id = rec(user_id), .csrf_hash = csrf_hash, .expires_ms = expires_ms, .expected_hash = expected_hash });
    defer allocator.free(result);

    return .{ .token = token, .csrf = csrf };
}

/// A live session as stored: who it belongs to, and the hash of the CSRF
/// token that was issued alongside it.
pub const SessionInfo = struct {
    user_id: []u8,
    csrf_hash: []u8,
};

/// Look up a session token and return the owning user plus the stored CSRF
/// hash, or null when the token is unknown or expired. Caller owns both
/// slices.
pub fn lookupSession(allocator: std.mem.Allocator, token: []const u8) !?SessionInfo {
    const token_hash = hashToken(token);
    const result = try queryWithVars(allocator,
        \\SELECT user_id, csrf_hash, time::unix(expires_at) * 1000 as expires_ms FROM sessions WHERE token = $session_token;
    , .{ .session_token = token_hash });
    defer allocator.free(result);

    const SessionResult = struct {
        user_id: []const u8,
        csrf_hash: []const u8 = "",
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

    const user_id = try allocator.dupe(u8, session.user_id);
    errdefer allocator.free(user_id);
    const csrf_hash = try allocator.dupe(u8, session.csrf_hash);
    return .{ .user_id = user_id, .csrf_hash = csrf_hash };
}

/// Validate a session token and return the user_id if valid
/// Returns null if token is invalid or expired
pub fn validateSession(allocator: std.mem.Allocator, token: []const u8) !?[]u8 {
    const info = try lookupSession(allocator, token) orelse return null;
    allocator.free(info.csrf_hash);
    return info.user_id;
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
    , .{ .user_id = rec(user_id) });
    allocator.free(result);
}

/// Cleanup expired sessions (should be called periodically)
pub fn cleanupExpiredSessions(allocator: std.mem.Allocator) !void {
    const current_ms = std.time.milliTimestamp();
    const result = try queryWithVars(allocator,
        \\DELETE FROM sessions WHERE expires_at < time::from_millis($current_ms);
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
