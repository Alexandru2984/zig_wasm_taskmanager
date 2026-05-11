const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
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
