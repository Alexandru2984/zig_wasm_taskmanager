const std = @import("std");
const config = @import("../config/config.zig");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const email = @import("email.zig");

var reminder_thread: ?std.Thread = null;
var reminder_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false);

fn enabled() bool {
    return std.mem.eql(u8, config.getOrDefault("TASK_REMINDERS_ENABLED", "0"), "1");
}

fn processDueReminders(allocator: std.mem.Allocator) !void {
    const task_result = try db.getDueTasksForReminders(allocator);
    defer allocator.free(task_result);

    const parsed_tasks = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), allocator, task_result, .{ .ignore_unknown_fields = true });
    defer parsed_tasks.deinit();

    if (parsed_tasks.value.len == 0 or parsed_tasks.value[0].result.len == 0) return;

    for (parsed_tasks.value[0].result) |task| {
        const due_date = task.due_date orelse continue;

        const user_result = db.getUserById(allocator, task.user_id) catch |err| {
            std.debug.print("Reminder skipped; failed to load user for task {s}: {}\n", .{ task.id, err });
            continue;
        };
        defer allocator.free(user_result);

        const parsed_users = std.json.parseFromSlice([]models.SurrealResponse(models.User), allocator, user_result, .{ .ignore_unknown_fields = true }) catch |err| {
            std.debug.print("Reminder skipped; invalid user payload for task {s}: {}\n", .{ task.id, err });
            continue;
        };
        defer parsed_users.deinit();

        if (parsed_users.value.len == 0 or parsed_users.value[0].result.len == 0) continue;
        const user = parsed_users.value[0].result[0];

        email.sendTaskReminderEmail(allocator, user.email, user.name, task.title, due_date) catch |err| {
            std.debug.print("Reminder email failed for task {s}: {}\n", .{ task.id, err });
            continue;
        };

        db.markTaskReminderSent(allocator, task.id) catch |err| {
            std.debug.print("Reminder sent but marker update failed for task {s}: {}\n", .{ task.id, err });
        };
    }
}

fn reminderLoop(allocator: std.mem.Allocator) void {
    while (reminder_running.load(.acquire)) {
        var arena = std.heap.ArenaAllocator.init(allocator);
        processDueReminders(arena.allocator()) catch |err| {
            std.debug.print("Reminder cycle failed: {}\n", .{err});
        };
        arena.deinit();

        var i: usize = 0;
        while (i < 60 and reminder_running.load(.acquire)) : (i += 1) {
            std.Thread.sleep(1 * std.time.ns_per_s);
        }
    }
}

pub fn startReminderThread(allocator: std.mem.Allocator) !void {
    if (!enabled() or reminder_thread != null) return;
    reminder_running.store(true, .release);
    reminder_thread = try std.Thread.spawn(.{}, reminderLoop, .{allocator});
    std.debug.print("✅ Task reminder thread started\n", .{});
}

pub fn stopReminderThread() void {
    if (reminder_thread) |thread| {
        reminder_running.store(false, .release);
        thread.join();
        reminder_thread = null;
        std.debug.print("🛑 Task reminder thread stopped\n", .{});
    }
}
