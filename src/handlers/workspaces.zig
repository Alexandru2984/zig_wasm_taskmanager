const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const email = @import("../services/email.zig");
const http = @import("../util/http.zig");
const validation = @import("../util/validation.zig");

pub fn listWorkspaces(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const db_result = db.listWorkspacesForUser(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load workspaces");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.WorkspaceResponse), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0) {
        try http.jsonSuccess(r, [0]models.WorkspaceResponse{});
        return;
    }

    try http.jsonSuccess(r, parsed.value[0].result);
}

pub fn createWorkspace(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const request = http.parseBody(req_alloc, r, models.CreateWorkspaceRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    if (!validation.validateWorkspaceName(request.name)) {
        try http.jsonError(r, 400, "Invalid workspace name");
        return;
    }

    const db_result = db.createWorkspace(req_alloc, user_id, request.name) catch {
        try http.jsonError(r, 500, "Failed to create workspace");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Workspace), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to create workspace");
        return;
    }

    const workspace = parsed.value[0].result[0];
    db.logActivity(req_alloc, user_id, "create_workspace", "workspace", workspace.id) catch |err| {
        std.debug.print("Failed to log workspace activity: {}\n", .{err});
    };

    try http.jsonCreated(r, models.WorkspaceResponse{
        .id = workspace.id,
        .name = workspace.name,
        .role = "owner",
        .created_at = workspace.created_at,
    });
}

pub fn listMembers(r: zap.Request, workspace_id: []const u8, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    if (!try db.canAdminWorkspace(req_alloc, user_id, workspace_id)) {
        try http.jsonError(r, 403, "Forbidden");
        return;
    }

    const db_result = db.listWorkspaceMembers(req_alloc, workspace_id) catch {
        try http.jsonError(r, 500, "Failed to load members");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.WorkspaceMemberResponse), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0) {
        try http.jsonSuccess(r, [0]models.WorkspaceMemberResponse{});
        return;
    }

    try http.jsonSuccess(r, parsed.value[0].result);
}

pub fn createInvite(r: zap.Request, workspace_id: []const u8, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    if (!try db.canAdminWorkspace(req_alloc, user_id, workspace_id)) {
        try http.jsonError(r, 403, "Forbidden");
        return;
    }

    const request = http.parseBody(req_alloc, r, models.CreateWorkspaceInviteRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    if (!validation.validateEmail(request.email)) {
        try http.jsonError(r, 400, "Invalid email format");
        return;
    }
    if (!validation.validateWorkspaceInviteRole(request.role)) {
        try http.jsonError(r, 400, "Invalid role");
        return;
    }

    const workspace_result = db.getWorkspaceById(req_alloc, workspace_id) catch {
        try http.jsonError(r, 500, "Failed to load workspace");
        return;
    };
    defer req_alloc.free(workspace_result);

    const parsed_workspace = try std.json.parseFromSlice([]models.SurrealResponse(models.Workspace), req_alloc, workspace_result, .{ .ignore_unknown_fields = true });
    defer parsed_workspace.deinit();
    if (parsed_workspace.value.len == 0 or parsed_workspace.value[0].result.len == 0) {
        try http.jsonError(r, 404, "Workspace not found");
        return;
    }
    const workspace = parsed_workspace.value[0].result[0];

    const token = db.generateSecureToken();
    const expires_at = std.time.timestamp() + (7 * 24 * 60 * 60);
    const invite_result = db.createWorkspaceInvite(req_alloc, workspace_id, request.email, request.role, user_id, token[0..], expires_at) catch {
        try http.jsonError(r, 500, "Failed to create invite");
        return;
    };
    defer req_alloc.free(invite_result);

    const parsed_invite = try std.json.parseFromSlice([]models.SurrealResponse(models.WorkspaceInvite), req_alloc, invite_result, .{ .ignore_unknown_fields = true });
    defer parsed_invite.deinit();
    if (parsed_invite.value.len == 0 or parsed_invite.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to create invite");
        return;
    }
    const invite = parsed_invite.value[0].result[0];

    email.sendWorkspaceInviteEmail(req_alloc, request.email, workspace.name, token[0..]) catch |err| {
        std.debug.print("Failed to send workspace invite: {}\n", .{err});
    };
    db.logActivity(req_alloc, user_id, "invite_workspace_member", "workspace", workspace_id) catch |err| {
        std.debug.print("Failed to log invite activity: {}\n", .{err});
    };

    try http.jsonCreated(r, models.WorkspaceInviteResponse{
        .id = invite.id,
        .workspace_id = invite.workspace_id,
        .email = invite.email,
        .role = invite.role,
        .expires_at = invite.expires_at,
        .accepted_at = invite.accepted_at,
        .created_at = invite.created_at,
    });
}

pub fn acceptInvite(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const request = http.parseBody(req_alloc, r, models.AcceptWorkspaceInviteRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    const invite_result = db.getWorkspaceInviteByToken(req_alloc, request.token) catch {
        try http.jsonError(r, 500, "Failed to load invite");
        return;
    };
    defer req_alloc.free(invite_result);

    const parsed_invite = try std.json.parseFromSlice([]models.SurrealResponse(models.WorkspaceInvite), req_alloc, invite_result, .{ .ignore_unknown_fields = true });
    defer parsed_invite.deinit();
    if (parsed_invite.value.len == 0 or parsed_invite.value[0].result.len == 0) {
        try http.jsonError(r, 404, "Invite not found");
        return;
    }
    const invite = parsed_invite.value[0].result[0];

    if (invite.accepted_at != null) {
        try http.jsonError(r, 400, "Invite already accepted");
        return;
    }
    const now = std.time.timestamp();
    if (invite.expires_at < now) {
        try http.jsonError(r, 400, "Invite expired");
        return;
    }

    const user_result = db.getUserById(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load user");
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

    if (!std.ascii.eqlIgnoreCase(user.email, invite.email)) {
        try http.jsonError(r, 403, "Invite belongs to a different email");
        return;
    }

    if (try db.canReadWorkspace(req_alloc, user_id, invite.workspace_id)) {
        try http.jsonError(r, 400, "Already a workspace member");
        return;
    }

    db.addWorkspaceMember(req_alloc, invite.workspace_id, user_id, invite.role) catch {
        try http.jsonError(r, 500, "Failed to join workspace");
        return;
    };
    db.markWorkspaceInviteAccepted(req_alloc, invite.id, now) catch |err| {
        std.debug.print("Failed to mark invite accepted: {}\n", .{err});
    };
    db.logActivity(req_alloc, user_id, "accept_workspace_invite", "workspace", invite.workspace_id) catch |err| {
        std.debug.print("Failed to log accept invite activity: {}\n", .{err});
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "invite accepted" });
}
