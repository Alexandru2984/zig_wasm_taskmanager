const std = @import("std");
const log = @import("../util/log.zig");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const auth = @import("../services/auth.zig");
const http = @import("../util/http.zig");
const rate_limiter = @import("../util/rate_limiter.zig");

pub fn listMailDeliveries(r: zap.Request, a: std.mem.Allocator) !void {
    const user = http.getCurrentUserId(a, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };
    const result = db.impl.listMail(a, user) catch {
        try http.jsonError(r, 500, "Could not load email delivery status");
        return;
    };
    defer a.free(result);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.MailDelivery), a, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    try http.jsonSuccess(r, if (parsed.value.len > 0) parsed.value[0].result else &.{});
}

/// GET /api/sessions — every session for the signed-in user.
///
/// Session tokens are stored hashed and never leave the database, so the
/// response cannot identify a session by its token. It marks the caller's own
/// session by hashing the presented cookie and comparing, which is the same
/// comparison the session lookup already does.
pub fn listSessions(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const db_result = db.listUserSessions(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load sessions");
        return;
    };
    defer req_alloc.free(db_result);

    const Row = struct {
        id: []const u8,
        token: []const u8,
        created_at: []const u8,
        expires_at: []const u8,
    };
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(Row), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0) {
        try http.jsonSuccess(r, [0]models.SessionResponse{});
        return;
    }

    const current_hash: ?[64]u8 = if (http.getSessionTokenFromCookie(r)) |tok|
        db.hashTokenHex(tok)
    else
        null;

    var out = std.ArrayListUnmanaged(models.SessionResponse){};
    defer out.deinit(req_alloc);

    for (parsed.value[0].result) |row| {
        const is_current = if (current_hash) |h| std.mem.eql(u8, &h, row.token) else false;
        try out.append(req_alloc, .{
            .id = row.id,
            .created_at = row.created_at,
            .expires_at = row.expires_at,
            .current = is_current,
        });
    }

    try http.jsonSuccess(r, out.items);
}

/// DELETE /api/sessions — sign out everywhere except here.
pub fn revokeOtherSessions(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    // Keeping the current session requires knowing which one it is. A Bearer
    // client has no cookie, so there is nothing to keep and everything goes —
    // including the token being used, which is the honest outcome of "revoke
    // all others" when the caller cannot be identified among them.
    const keep_hash: ?[64]u8 = if (http.getSessionTokenFromCookie(r)) |tok|
        db.hashTokenHex(tok)
    else
        null;

    if (keep_hash) |h| {
        db.deleteOtherUserSessions(req_alloc, user_id, &h) catch {
            try http.jsonError(r, 500, "Failed to revoke sessions");
            return;
        };
    } else {
        db.deleteUserSessions(req_alloc, user_id) catch {
            try http.jsonError(r, 500, "Failed to revoke sessions");
            return;
        };
    }

    db.logActivity(req_alloc, user_id, "revoke_sessions", "session", "") catch |err| {
        log.warn("Failed to log session revocation: {}", .{err});
    };
    try http.jsonSuccess(r, models.SuccessResponse{ .status = "other sessions revoked" });
}

/// DELETE /api/sessions/:id — revoke one session.
pub fn revokeSession(r: zap.Request, session_id: []const u8, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };
    if (!std.mem.startsWith(u8, session_id, "sessions:")) {
        try http.jsonError(r, 400, "Invalid session ID");
        return;
    }

    const del = db.deleteSessionScoped(req_alloc, session_id, user_id) catch {
        try http.jsonError(r, 500, "Failed to revoke session");
        return;
    };
    defer req_alloc.free(del);

    const Row = struct { id: []const u8 };
    const parsed = std.json.parseFromSlice([]models.SurrealResponse(Row), req_alloc, del, .{ .ignore_unknown_fields = true }) catch {
        try http.jsonError(r, 500, "Failed to revoke session");
        return;
    };
    defer parsed.deinit();
    // Scoped by user_id, so "no rows" covers both a session that never existed
    // and one belonging to somebody else. Both answer 404: distinguishing them
    // would confirm the existence of another user's session.
    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 404, "Session not found");
        return;
    }

    db.logActivity(req_alloc, user_id, "revoke_session", "session", session_id) catch |err| {
        log.warn("Failed to log session revocation: {}", .{err});
    };
    try http.jsonSuccess(r, models.SuccessResponse{ .status = "session revoked" });
}

/// GET /api/export — everything the account holds, as one JSON document.
pub fn exportData(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const user_result = db.getUserById(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load account");
        return;
    };
    defer req_alloc.free(user_result);
    const parsed_user = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, user_result, .{ .ignore_unknown_fields = true });
    defer parsed_user.deinit();
    if (parsed_user.value.len == 0 or parsed_user.value[0].result.len == 0) {
        try http.jsonError(r, 404, "User not found");
        return;
    }
    const user = parsed_user.value[0].result[0];

    const tasks_result = db.exportUserTasks(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load tasks");
        return;
    };
    defer req_alloc.free(tasks_result);
    const parsed_tasks = try std.json.parseFromSlice([]models.SurrealResponse(models.ExportTask), req_alloc, tasks_result, .{ .ignore_unknown_fields = true });
    defer parsed_tasks.deinit();

    const workspaces_result = db.listWorkspacesForUser(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load workspaces");
        return;
    };
    defer req_alloc.free(workspaces_result);
    const parsed_ws = try std.json.parseFromSlice([]models.SurrealResponse(models.WorkspaceResponse), req_alloc, workspaces_result, .{ .ignore_unknown_fields = true });
    defer parsed_ws.deinit();

    const activity_result = db.getActivityByUser(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load activity");
        return;
    };
    defer req_alloc.free(activity_result);
    const parsed_activity = try std.json.parseFromSlice([]models.SurrealResponse(models.ActivityResponse), req_alloc, activity_result, .{ .ignore_unknown_fields = true });
    defer parsed_activity.deinit();

    const mail_result = try db.impl.queryWithVars(req_alloc, "SELECT id, kind, reference_id, status, attempts, created_at, last_error FROM mail_outbox WHERE owner_id = $owner;", .{ .owner = db.impl.rec(user_id) });
    defer req_alloc.free(mail_result);
    const parsed_mail = try std.json.parseFromSlice([]models.SurrealResponse(models.MailDelivery), req_alloc, mail_result, .{ .ignore_unknown_fields = true });
    defer parsed_mail.deinit();

    const export_doc = models.ExportDocument{
        .exported_at = std.time.timestamp(),
        .account = .{
            .id = user.id,
            .email = user.email,
            .name = user.name,
            .email_verified = user.email_verified,
        },
        .tasks = if (parsed_tasks.value.len > 0) parsed_tasks.value[0].result else &.{},
        .workspaces = if (parsed_ws.value.len > 0) parsed_ws.value[0].result else &.{},
        .activity = if (parsed_activity.value.len > 0) parsed_activity.value[0].result else &.{},
        .email_deliveries = if (parsed_mail.value.len > 0) parsed_mail.value[0].result else &.{},
    };

    // Content-Disposition makes the browser save it rather than render it, so
    // the export is one click rather than "view source, select all, paste".
    r.setHeader("Content-Disposition", "attachment; filename=\"zig-tasks-export.json\"") catch {};
    try http.jsonSuccess(r, export_doc);
}

/// DELETE /api/account — irreversible, so it re-authenticates first.
pub fn deleteAccount(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    // Same budget as a password change: this endpoint verifies a password, so
    // it is another place an attacker with a stolen session could guess one.
    if (rate_limiter.password_change_limiter) |*limiter| {
        if (!limiter.isAllowed(user_id)) {
            r.setHeader("Retry-After", "900") catch {};
            try http.jsonError(r, 429, "Too many attempts. Please wait 15 minutes.");
            return;
        }
    }

    const request = http.parseBody(req_alloc, r, models.DeleteAccountRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    const user_result = db.getUserById(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(user_result);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, user_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 404, "User not found");
        return;
    }
    const user = parsed.value[0].result[0];

    // SECURITY: a live session is not enough to destroy an account. An
    // unattended browser or a stolen cookie should not be able to do something
    // with no undo, so the password is required again here.
    const valid = auth.verifyPassword(req_alloc, user.password_hash, request.password) catch false;
    if (!valid) {
        try http.jsonError(r, 403, "Incorrect password");
        return;
    }

    db.deleteUserAccount(req_alloc, user_id, user.password_hash) catch |err| {
        try http.mutationError(r, err, "Failed to delete account");
        return;
    };

    http.clearAuthCookie(r);
    try http.jsonSuccess(r, models.SuccessResponse{ .status = "account deleted" });
}
