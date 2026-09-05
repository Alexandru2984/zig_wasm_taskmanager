const std = @import("std");
const log = @import("../util/log.zig");
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
    // An unauthenticated read used to answer 200 with an empty array, which is
    // indistinguishable from "you are signed in and have no tasks". The front
    // end could not tell an expired session from an empty list, and neither
    // could a monitoring check.
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
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
        try tasks.append(req_alloc, toResponse(task));
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
        if (validation.isDueDateInPast(dd, std.time.timestamp())) {
            try http.jsonError(r, 400, "Due date must be in the future");
            return;
        }
    }

    const priority = request.priority orelse "normal";
    const status = request.status orelse "todo";
    const recurrence = request.recurrence orelse "none";
    if (!try validateTaskFields(r, priority, status, recurrence, request.notes, request.tags)) return;

    const workspace_id = if (request.workspace_id) |workspace|
        workspace
    else
        db.ensurePersonalWorkspace(req_alloc, user_id, "User") catch {
            try http.jsonError(r, 500, "Failed to initialize workspace");
            return;
        };
    const workspace_id_allocated = request.workspace_id == null;
    defer if (workspace_id_allocated) req_alloc.free(workspace_id);

    const writable = db.canWriteWorkspace(req_alloc, user_id, workspace_id) catch {
        try http.jsonError(r, 500, "Failed to verify workspace access");
        return;
    };
    if (!writable) {
        try http.jsonError(r, 403, "Forbidden: workspace is read-only or unavailable");
        return;
    }

    // A subtask must belong to a task the caller can already write to,
    // otherwise the parent link becomes a way to attach rows to someone
    // else's task.
    if (request.parent_id) |parent| {
        if (!std.mem.startsWith(u8, parent, "tasks:")) {
            try http.jsonError(r, 400, "Invalid parent task ID");
            return;
        }
        const parent_writable = db.canWriteTask(req_alloc, parent, user_id) catch false;
        if (!parent_writable) {
            try http.jsonError(r, 403, "Forbidden: parent task is not yours");
            return;
        }
    }

    if (request.assignee_id) |assignee| {
        if (!std.mem.startsWith(u8, assignee, "users:")) {
            try http.jsonError(r, 400, "Invalid assignee ID");
            return;
        }
        if (!try assigneeIsMember(req_alloc, assignee, workspace_id)) {
            try http.jsonError(r, 400, "The assignee is not a member of this workspace");
            return;
        }
    }

    const db_result = db.createTask(req_alloc, .{
        .user_id = user_id,
        .workspace_id = workspace_id,
        .title = request.title,
        .priority = priority,
        .notes = request.notes orelse "",
        .tags = request.tags orelse &.{},
        .due_date = request.due_date,
        .status = status,
        .recurrence = recurrence,
        .parent_id = request.parent_id,
        .assignee_id = request.assignee_id,
    }) catch |err| {
        log.warn("Failed to create task: {}", .{err});
        try http.jsonError(r, 500, "Failed to create task");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to create task");
        return;
    }
    const task = parsed.value[0].result[0];
    db.logActivity(req_alloc, user_id, "create_task", "task", task.id) catch |err| {
        log.warn("Failed to log create task activity: {}", .{err});
    };

    try http.jsonCreated(r, toResponse(task));
}

fn toResponse(task: models.Task) models.TaskResponse {
    return .{
        .id = task.id,
        .workspace_id = task.workspace_id,
        .title = task.title,
        .completed = task.completed,
        .created_at = task.created_at,
        .due_date = task.due_date,
        .priority = task.priority,
        .reminder_sent = task.reminder_sent,
        .notes = task.notes,
        .tags = task.tags,
        .updated_at = task.updated_at,
        .status = task.status,
        .recurrence = task.recurrence,
        .parent_id = task.parent_id,
        .assignee_id = task.assignee_id,
    };
}

/// An assignee has to be someone who can actually see the task. Without this
/// an admin could point a task at any account in the database by id, which
/// both leaks that the account exists and puts a stranger's name on work in a
/// workspace they are not part of.
fn assigneeIsMember(req_alloc: std.mem.Allocator, assignee_id: []const u8, workspace_id: []const u8) !bool {
    const role = db.getWorkspaceRole(req_alloc, assignee_id, workspace_id) catch return false;
    if (role) |r| {
        req_alloc.free(r);
        return true;
    }
    return false;
}

/// Shared validation for the fields create and update have in common.
/// Returns false when a response has already been written.
fn validateTaskFields(
    r: zap.Request,
    priority: ?[]const u8,
    status: ?[]const u8,
    recurrence: ?[]const u8,
    notes: ?[]const u8,
    tags: ?[]const []const u8,
) !bool {
    if (priority) |v| if (!validation.validateTaskPriority(v)) {
        try http.jsonError(r, 400, "Invalid priority");
        return false;
    };
    if (status) |v| if (!validation.validateTaskStatus(v)) {
        try http.jsonError(r, 400, "Invalid status");
        return false;
    };
    if (recurrence) |v| if (!validation.validateRecurrence(v)) {
        try http.jsonError(r, 400, "Invalid recurrence");
        return false;
    };
    if (notes) |v| if (v.len > 5000) {
        try http.jsonError(r, 400, "Notes must be at most 5000 characters");
        return false;
    };
    if (tags) |v| if (!validateTags(v)) {
        try http.jsonError(r, 400, "Tags must be 1-32 characters, at most 12 per task");
        return false;
    };
    return true;
}

/// Tags are free-form labels, so they get their own limits rather than
/// inheriting the title's. Capping both the count and each label's length
/// stops a single task from carrying an unbounded array into the database.
const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;

fn validateTags(tags: []const []const u8) bool {
    if (tags.len > MAX_TAGS) return false;
    for (tags) |tag| {
        if (tag.len == 0 or tag.len > MAX_TAG_LEN) return false;
        for (tag) |c| {
            // Control bytes only; labels are displayed with textContent, so
            // punctuation and non-ASCII are fine and useful.
            if (c < 0x20 or c == 0x7F) return false;
        }
    }
    return true;
}

/// Advance a due date by one recurrence step.
///
/// Month arithmetic clamps rather than overflowing: the 31st of a month
/// followed by a 30-day month lands on the 30th, not the 1st of the month
/// after. Anyone who has had a monthly task quietly drift a day later every
/// other month knows why that matters.
fn nextDueDate(allocator: std.mem.Allocator, due: []const u8, recurrence: []const u8) !?[]u8 {
    const ts = validation.dueDateToTimestamp(due) orelse return null;

    if (std.mem.eql(u8, recurrence, "daily")) {
        return try validation.timestampToDueDate(allocator, ts + 24 * 60 * 60);
    }
    if (std.mem.eql(u8, recurrence, "weekly")) {
        return try validation.timestampToDueDate(allocator, ts + 7 * 24 * 60 * 60);
    }
    if (std.mem.eql(u8, recurrence, "monthly")) {
        return try validation.addMonthClamped(allocator, ts, 1);
    }
    return null;
}

/// Create the next instance of a recurring task.
///
/// Failures here are logged, not surfaced: the user completed a task and that
/// succeeded. Telling them the completion failed because the follow-up could
/// not be created would be both untrue and unhelpful.
fn spawnRecurrence(r: zap.Request, req_alloc: std.mem.Allocator, user_id: []const u8, task: models.Task) void {
    _ = r;
    if (std.mem.eql(u8, task.recurrence, "none")) return;
    if (!task.completed) return;
    const due = task.due_date orelse return;

    const next = nextDueDate(req_alloc, due, task.recurrence) catch |err| {
        log.warn("Could not compute the next due date for {s}: {}", .{ task.id, err });
        return;
    } orelse return;
    defer req_alloc.free(next);

    const workspace_id = task.workspace_id orelse return;
    const created = db.createTask(req_alloc, .{
        .user_id = user_id,
        .workspace_id = workspace_id,
        .title = task.title,
        .priority = task.priority,
        .notes = task.notes,
        .tags = task.tags,
        .due_date = next,
        .status = "todo",
        .recurrence = task.recurrence,
        .assignee_id = task.assignee_id,
    }) catch |err| {
        log.warn("Could not create the next occurrence of {s}: {}", .{ task.id, err });
        return;
    };
    req_alloc.free(created);
    log.info("Created the next occurrence of a {s} task", .{task.recurrence});
}

/// PUT /api/tasks/:id
///
/// A body with fields patches those fields. A body-less PUT toggles
/// completion, which is what the checkbox in the UI has always sent and what
/// this route used to do unconditionally.
pub fn updateTask(r: zap.Request, task_id: []const u8, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Unauthorized");
        return;
    };
    if (!try rateLimitWrite(r, user_id)) return;

    const body = r.body orelse "";
    const has_body = std.mem.trim(u8, body, " \t\r\n").len > 0;
    if (!has_body) {
        try toggleTask(r, task_id, req_alloc);
        return;
    }

    const request = http.parseBody(req_alloc, r, models.UpdateTaskRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    if (request.title) |title| {
        if (!validation.validateTaskTitle(title)) {
            try http.jsonError(r, 400, "Title must be between 1 and 500 characters");
            return;
        }
    }
    if (!try validateTaskFields(r, request.priority, request.status, request.recurrence, request.notes, request.tags)) return;
    // An empty due_date is the documented way to clear one, so it skips the
    // format check that a real value must pass.
    if (request.due_date) |dd| {
        if (dd.len > 0) {
            if (!validation.validateDueDate(dd)) {
                try http.jsonError(r, 400, "Invalid due_date format");
                return;
            }
            if (validation.isDueDateInPast(dd, std.time.timestamp())) {
                try http.jsonError(r, 400, "Due date must be in the future");
                return;
            }
        }
    }
    // SECURITY: authorization before the write, same as toggle and delete. A
    // task in a shared workspace is writable by its members; a personal task
    // only by its owner.
    const can_write = db.canWriteTask(req_alloc, task_id, user_id) catch {
        try http.jsonError(r, 500, "Failed to verify ownership");
        return;
    };
    if (!can_write) {
        try http.jsonError(r, 403, "Forbidden: not your task");
        return;
    }

    const db_result = db.updateTask(req_alloc, task_id, .{
        .title = request.title,
        .priority = request.priority,
        .notes = request.notes,
        .completed = request.completed,
        .tags = request.tags,
        .due_date = request.due_date,
        .status = request.status,
        .recurrence = request.recurrence,
        .assignee_id = request.assignee_id,
    }) catch {
        try http.jsonError(r, 500, "Failed to update task");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 404, "Task not found");
        return;
    }

    const task = parsed.value[0].result[0];
    db.logActivity(req_alloc, user_id, "update_task", "task", task.id) catch |err| {
        log.warn("Failed to log update task activity: {}", .{err});
    };
    spawnRecurrence(r, req_alloc, user_id, task);

    try http.jsonSuccess(r, toResponse(task));
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
    db.logActivity(req_alloc, user_id, "toggle_task", "task", task.id) catch |err| {
        log.warn("Failed to log toggle task activity: {}", .{err});
    };
    spawnRecurrence(r, req_alloc, user_id, task);

    try http.jsonSuccess(r, toResponse(task));
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

    // Subtasks go with the parent. Leaving them behind would strand rows that
    // no view lists, since a subtask is only ever shown under its parent.
    _ = db.deleteTaskWithChildren(req_alloc, task_id) catch {
        try http.jsonError(r, 500, "Failed to delete task");
        return;
    };
    db.logActivity(req_alloc, user_id, "delete_task", "task", task_id) catch |err| {
        log.warn("Failed to log delete task activity: {}", .{err});
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "success" });
}
