// Frontend WASM — anonymous task store.
// SECURITY/DESIGN: this module is the source of truth for tasks created while
// logged out. app.js mirrors a snapshot to localStorage for persistence, but
// all create/toggle/delete logic lives here in Zig.
const std = @import("std");

const MAX_TASKS = 200;
const MAX_TITLE_LEN = 256;
const MAX_DATE_LEN = 32;

const Task = struct {
    id: u32,
    title: [MAX_TITLE_LEN]u8,
    title_len: usize,
    due: [MAX_DATE_LEN]u8,
    due_len: usize,
    priority: u8, // 0 = normal, 1 = high, 2 = low
    completed: bool,
    active: bool,
};

var tasks: [MAX_TASKS]Task = undefined;
var task_count: u32 = 0;
var next_id: u32 = 1;
var initialized: bool = false;

// Extern functions implemented in JavaScript.
extern fn js_log(ptr: [*]const u8, len: usize) void;
extern fn js_renderTasks() void;

fn log(msg: []const u8) void {
    js_log(msg.ptr, msg.len);
}

fn findById(id: u32) ?*Task {
    for (&tasks) |*task| {
        if (task.active and task.id == id) return task;
    }
    return null;
}

export fn init() void {
    if (initialized) return;
    for (&tasks) |*task| {
        task.active = false;
        task.completed = false;
        task.title_len = 0;
        task.due_len = 0;
        task.priority = 0;
        task.id = 0;
    }
    task_count = 0;
    next_id = 1;
    initialized = true;
    log("WASM task store initialized");
}

/// Wipe every task. Used by app.js before replaying a localStorage snapshot so
/// the WASM store and the page never drift apart.
export fn clearAll() void {
    for (&tasks) |*task| task.active = false;
    task_count = 0;
}

export fn addTask(
    title_ptr: [*]const u8,
    title_len: usize,
    due_ptr: [*]const u8,
    due_len: usize,
    priority: u8,
) u32 {
    if (task_count >= MAX_TASKS) {
        log("Max tasks reached");
        return 0;
    }
    const t_len = @min(title_len, MAX_TITLE_LEN - 1);
    if (t_len == 0) return 0;
    const d_len = @min(due_len, MAX_DATE_LEN - 1);

    for (&tasks) |*task| {
        if (!task.active) {
            task.id = next_id;
            next_id += 1;
            task.active = true;
            task.completed = false;
            task.priority = if (priority <= 2) priority else 0;
            task.title_len = t_len;
            @memcpy(task.title[0..t_len], title_ptr[0..t_len]);
            task.due_len = d_len;
            if (d_len > 0) @memcpy(task.due[0..d_len], due_ptr[0..d_len]);
            task_count += 1;
            js_renderTasks();
            return task.id;
        }
    }
    return 0;
}

export fn toggleTask(id: u32) bool {
    if (findById(id)) |task| {
        task.completed = !task.completed;
        js_renderTasks();
        return true;
    }
    return false;
}

export fn deleteTask(id: u32) bool {
    if (findById(id)) |task| {
        task.active = false;
        task_count -= 1;
        js_renderTasks();
        return true;
    }
    return false;
}

export fn getTaskCount() u32 {
    return task_count;
}

export fn getTaskId(index: u32) u32 {
    var count: u32 = 0;
    for (tasks) |task| {
        if (task.active) {
            if (count == index) return task.id;
            count += 1;
        }
    }
    return 0;
}

export fn getTaskCompleted(id: u32) bool {
    if (findById(id)) |task| return task.completed;
    return false;
}

export fn getTaskPriority(id: u32) u8 {
    if (findById(id)) |task| return task.priority;
    return 0;
}

// Shared output buffers. JS reads each immediately after the matching call, so
// reusing one buffer per field is safe.
var title_buffer: [MAX_TITLE_LEN]u8 = undefined;
var due_buffer: [MAX_DATE_LEN]u8 = undefined;

export fn getTaskTitle(id: u32) [*]const u8 {
    if (findById(id)) |task| {
        @memcpy(title_buffer[0..task.title_len], task.title[0..task.title_len]);
        return &title_buffer;
    }
    return &title_buffer;
}

export fn getTaskTitleLen(id: u32) usize {
    if (findById(id)) |task| return task.title_len;
    return 0;
}

export fn getTaskDue(id: u32) [*]const u8 {
    if (findById(id)) |task| {
        @memcpy(due_buffer[0..task.due_len], task.due[0..task.due_len]);
        return &due_buffer;
    }
    return &due_buffer;
}

export fn getTaskDueLen(id: u32) usize {
    if (findById(id)) |task| return task.due_len;
    return 0;
}

// Scratch buffer JS uses to hand strings (titles, dates) into WASM.
var string_buffer: [4096]u8 = undefined;
var string_offset: usize = 0;

export fn allocString(len: usize) [*]u8 {
    if (string_offset + len > string_buffer.len) {
        string_offset = 0;
    }
    const ptr = string_buffer[string_offset..].ptr;
    string_offset += len;
    return ptr;
}

export fn freeString() void {
    string_offset = 0;
}
