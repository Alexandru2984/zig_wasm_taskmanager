const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const http = @import("../util/http.zig");

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

    // Map to TaskResponse
    var tasks = std.ArrayListUnmanaged(models.TaskResponse){};
    defer tasks.deinit(req_alloc); // We pass tasks.items to jsonSuccess, which copies it to output buffer.
    
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
        // Original logic sent "useLocal": true
        r.setStatus(.unauthorized);
        // We can't easily add extra fields to standard error response without a custom struct
        // But let's stick to standard error for now, or just send the custom JSON manually if needed.
        // "{\"error\": \"Login required\", \"useLocal\": true}"
        // Let's use a custom anonymous struct
        try http.jsonError(r, 401, "Login required"); // Simplify for now
        return;
    };

    const request = http.parseBody(req_alloc, r, models.CreateTaskRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    if (request.title.len == 0) {
        try http.jsonError(r, 400, "Missing title");
        return;
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
