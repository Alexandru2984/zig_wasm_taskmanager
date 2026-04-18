const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const http = @import("../util/http.zig");
const validation = @import("../util/validation.zig");
const rate_limiter = @import("../util/rate_limiter.zig");

/// 60 writes/min/user. Applied before DB access so a rogue client can't chew
/// through SurrealDB with runaway POST/PUT/DELETE.
fn rateLimitWrite(r: zap.Request, user_id: []const u8) !bool {
    if (rate_limiter.task_write_limiter) |*limiter| {
        if (!limiter.isAllowed(user_id)) {
            r.setHeader("Retry-After", "60") catch {};
            try http.jsonError(r, 429, "Too many requests. Please wait 1 minute.");
            return false;
        }
    }
    return true;
}

pub fn getTasks(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        // Return empty list if not logged in (as per original logic, though weird)
        // Original logic: if not logged in, return []
        try http.jsonSuccess(r, [0]models.TaskResponse{});
        return;
    };

    const db_result = db.getTasksByUser(req_alloc, user_id) catch {
        try http.jsonSuccess(r, [0]models.TaskResponse{});
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0) {
        try http.jsonSuccess(r, [0]models.TaskResponse{});
        return;
    }

    var tasks = std.ArrayListUnmanaged(models.TaskResponse){};
    defer tasks.deinit(req_alloc);

    for (parsed.value[0].result) |task| {
        try tasks.append(req_alloc, .{
            .id = task.id,
            .title = task.title,
            .completed = task.completed,
            .created_at = task.created_at,
            .due_date = task.due_date,
        });
    }

    try http.jsonSuccess(r, tasks.items);
}

pub fn createTask(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Login required");
        return;
    };
    if (!try rateLimitWrite(r, user_id)) return;

    const request = http.parseBody(req_alloc, r, models.CreateTaskRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    if (!validation.validateTaskTitle(request.title)) {
        try http.jsonError(r, 400, "Title must be between 1 and 500 characters");
        return;
    }

    if (request.due_date) |dd| {
        if (!validation.validateDueDate(dd)) {
            try http.jsonError(r, 400, "Invalid due_date format");
            return;
        }
    }

    const db_result = if (request.due_date) |dd|
        try db.createTaskWithDueDate(req_alloc, user_id, request.title, dd)
    else
        try db.createTask(req_alloc, user_id, request.title);
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to create task");
        return;
    }
    const task = parsed.value[0].result[0];

    const response = models.TaskResponse{
        .id = task.id,
        .title = task.title,
        .completed = task.completed,
        .created_at = task.created_at,
        .due_date = task.due_date,
    };

    try http.jsonCreated(r, response);
}

pub fn toggleTask(r: zap.Request, task_id: []const u8, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Unauthorized");
        return;
    };
    if (!try rateLimitWrite(r, user_id)) return;

    const is_owner = db.verifyTaskOwnership(req_alloc, task_id, user_id) catch {
        try http.jsonError(r, 500, "Failed to verify ownership");
        return;
    };

    if (!is_owner) {
        try http.jsonError(r, 403, "Forbidden: not your task");
        return;
    }

    const db_result = db.toggleTask(req_alloc, task_id) catch {
        try http.jsonError(r, 500, "Failed to toggle task");
        return;
    };
    defer req_alloc.free(db_result);

    // Parse result to return updated task
    // toggleTask returns the updated records
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to toggle task");
        return;
    }
    const task = parsed.value[0].result[0];

    const response = models.TaskResponse{
        .id = task.id,
        .title = task.title,
        .completed = task.completed,
        .created_at = task.created_at,
        .due_date = task.due_date,
    };

    try http.jsonSuccess(r, response);
}

pub fn deleteTask(r: zap.Request, task_id: []const u8, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Unauthorized");
        return;
    };
    if (!try rateLimitWrite(r, user_id)) return;

    const is_owner = db.verifyTaskOwnership(req_alloc, task_id, user_id) catch {
        try http.jsonError(r, 500, "Failed to verify ownership");
        return;
    };

    if (!is_owner) {
        try http.jsonError(r, 403, "Forbidden: not your task");
        return;
    }

    _ = db.deleteTask(req_alloc, task_id) catch {
        try http.jsonError(r, 500, "Failed to delete task");
        return;
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "success" });
}
