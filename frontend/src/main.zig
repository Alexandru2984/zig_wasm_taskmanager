// Frontend WASM — anonymous task store.
// SECURITY/DESIGN: this module is the source of truth for tasks created while
// logged out. app.js mirrors a snapshot to localStorage for persistence, but
// all create/toggle/delete logic lives here in Zig.
const std = @import("std");

const MAX_TASKS = 200;
const MAX_TITLE_LEN = 256;
const MAX_DATE_LEN = 32;
const MAX_NOTES_LEN = 1024;
/// Tags are held as one comma-separated string rather than an array. The
/// boundary to JavaScript is raw pointers and lengths, so every extra field is
/// another pair of exports; one string that JS splits on commas is the same
/// data with a fraction of the surface.
const MAX_TAGS_LEN = 256;

const Task = struct {
    id: u32,
    title: [MAX_TITLE_LEN]u8,
    title_len: usize,
    due: [MAX_DATE_LEN]u8,
    due_len: usize,
    notes: [MAX_NOTES_LEN]u8,
    notes_len: usize,
    tags: [MAX_TAGS_LEN]u8,
    tags_len: usize,
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
        task.notes_len = 0;
        task.tags_len = 0;
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
    notes_ptr: [*]const u8,
    notes_len: usize,
    tags_ptr: [*]const u8,
    tags_len: usize,
) u32 {
    if (task_count >= MAX_TASKS) {
        log("Max tasks reached");
        return 0;
    }
    const t_len = @min(title_len, MAX_TITLE_LEN - 1);
    if (t_len == 0) return 0;

    for (&tasks) |*task| {
        if (!task.active) {
            task.id = next_id;
            next_id += 1;
            task.active = true;
            task.completed = false;
            task.title_len = t_len;
            @memcpy(task.title[0..t_len], title_ptr[0..t_len]);
            setField(&task.due, &task.due_len, due_ptr, due_len);
            setField(&task.notes, &task.notes_len, notes_ptr, notes_len);
            setField(&task.tags, &task.tags_len, tags_ptr, tags_len);
            task.priority = if (priority <= 2) priority else 0;
            task_count += 1;
            js_renderTasks();
            return task.id;
        }
    }
    return 0;
}

/// Copy a JS-supplied string into a fixed field, truncating rather than
/// overflowing. Every incoming length is attacker-adjacent only in the sense
/// that it comes from the page, but a wrong length here would be a memory
/// safety bug, so the clamp is not optional.
fn setField(dest: []u8, dest_len: *usize, src: [*]const u8, src_len: usize) void {
    const n = @min(src_len, dest.len - 1);
    dest_len.* = n;
    if (n > 0) @memcpy(dest[0..n], src[0..n]);
}

/// Edit an existing task in place. Without this, editing a task while signed
/// out had nowhere to go: the page sent the change to the API, which answered
/// 401 because there is no session, and the edit was lost.
export fn updateTask(
    id: u32,
    title_ptr: [*]const u8,
    title_len: usize,
    due_ptr: [*]const u8,
    due_len: usize,
    priority: u8,
    notes_ptr: [*]const u8,
    notes_len: usize,
    tags_ptr: [*]const u8,
    tags_len: usize,
) bool {
    const task = findById(id) orelse return false;
    const t_len = @min(title_len, MAX_TITLE_LEN - 1);
    if (t_len == 0) return false;

    task.title_len = t_len;
    @memcpy(task.title[0..t_len], title_ptr[0..t_len]);
    setField(&task.due, &task.due_len, due_ptr, due_len);
    setField(&task.notes, &task.notes_len, notes_ptr, notes_len);
    setField(&task.tags, &task.tags_len, tags_ptr, tags_len);
    task.priority = if (priority <= 2) priority else 0;

    js_renderTasks();
    return true;
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
var notes_buffer: [MAX_NOTES_LEN]u8 = undefined;
var tags_buffer: [MAX_TAGS_LEN]u8 = undefined;

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

export fn getTaskNotes(id: u32) [*]const u8 {
    if (findById(id)) |task| {
        @memcpy(notes_buffer[0..task.notes_len], task.notes[0..task.notes_len]);
    }
    return &notes_buffer;
}

export fn getTaskNotesLen(id: u32) usize {
    if (findById(id)) |task| return task.notes_len;
    return 0;
}

/// Comma-separated; JS splits it back into a list.
export fn getTaskTags(id: u32) [*]const u8 {
    if (findById(id)) |task| {
        @memcpy(tags_buffer[0..task.tags_len], task.tags[0..task.tags_len]);
    }
    return &tags_buffer;
}

export fn getTaskTagsLen(id: u32) usize {
    if (findById(id)) |task| return task.tags_len;
    return 0;
}

// Scratch buffer JS uses to hand strings (titles, dates) into WASM.
var string_buffer: [8192]u8 = undefined;
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
