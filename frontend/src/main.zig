// Frontend WASM - Task Manager Logic
const std = @import("std");

// Task storage
const MAX_TASKS = 100;
const MAX_TITLE_LEN = 256;

const Task = struct {
    id: u32,
    title: [MAX_TITLE_LEN]u8,
    title_len: usize,
    completed: bool,
    active: bool,
};

var tasks: [MAX_TASKS]Task = undefined;
var task_count: u32 = 0;
var next_id: u32 = 1;
var initialized: bool = false;

// Extern functions - implemented in JavaScript
extern fn js_log(ptr: [*]const u8, len: usize) void;
extern fn js_renderTasks() void;
extern fn js_alert(ptr: [*]const u8, len: usize) void;

fn log(msg: []const u8) void {
    js_log(msg.ptr, msg.len);
}

// Exported functions for JavaScript to call
export fn init() void {
    if (initialized) return;

    for (&tasks) |*task| {
        task.active = false;
        task.completed = false;
        task.title_len = 0;
        task.id = 0;
    }
    task_count = 0;
    next_id = 1;
    initialized = true;

    log("WASM initialized successfully!");
}

export fn addTask(title_ptr: [*]const u8, title_len: usize) u32 {
    if (task_count >= MAX_TASKS) {
        log("Max tasks reached!");
        return 0;
    }

    const len = @min(title_len, MAX_TITLE_LEN - 1);

    // Find empty slot
    for (&tasks) |*task| {
        if (!task.active) {
            task.id = next_id;
            next_id += 1;
            task.active = true;
            task.completed = false;
            task.title_len = len;
            @memcpy(task.title[0..len], title_ptr[0..len]);
            task_count += 1;

            js_renderTasks();
            return task.id;
        }
    }

    return 0;
}

export fn toggleTask(id: u32) bool {
    for (&tasks) |*task| {
        if (task.active and task.id == id) {
            task.completed = !task.completed;
            js_renderTasks();
            return true;
        }
    }
    return false;
}

export fn deleteTask(id: u32) bool {
    for (&tasks) |*task| {
        if (task.active and task.id == id) {
            task.active = false;
            task_count -= 1;
            js_renderTasks();
            return true;
        }
    }
    return false;
}

export fn getTaskCount() u32 {
    return task_count;
}

// Get task at index (for iteration)
export fn getTaskId(index: u32) u32 {
    var count: u32 = 0;
    for (tasks) |task| {
        if (task.active) {
            if (count == index) {
                return task.id;
            }
            count += 1;
        }
    }
    return 0;
}

export fn getTaskCompleted(id: u32) bool {
    for (tasks) |task| {
        if (task.active and task.id == id) {
            return task.completed;
        }
    }
    return false;
}

// Returns pointer and length to task title
var title_buffer: [MAX_TITLE_LEN]u8 = undefined;

export fn getTaskTitle(id: u32) [*]const u8 {
    for (tasks) |task| {
        if (task.active and task.id == id) {
            @memcpy(title_buffer[0..task.title_len], task.title[0..task.title_len]);
            title_buffer[task.title_len] = 0; // null terminate
            return &title_buffer;
        }
    }
    title_buffer[0] = 0;
    return &title_buffer;
}

export fn getTaskTitleLen(id: u32) usize {
    for (tasks) |task| {
        if (task.active and task.id == id) {
            return task.title_len;
        }
    }
    return 0;
}

// String allocation for JS interop
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
