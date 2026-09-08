const std = @import("std");
const log = @import("../util/log.zig");
const config = @import("../config/config.zig");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const email = @import("email.zig");

var reminder_thread: ?std.Thread = null;
var reminder_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false);

fn enabled() bool {
    return std.mem.eql(u8, config.getOrDefault("TASK_REMINDERS_ENABLED", "0"), "1");
}

/// How far ahead of a deadline to send the reminder, in minutes.
///
/// An hour by default: long enough to be actionable, short enough that the
/// task is still the thing you are about to do.
fn leadSeconds() i64 {
    const raw = config.getOrDefault("TASK_REMINDER_LEAD_MINUTES", "60");
    const minutes = std.fmt.parseInt(i64, raw, 10) catch {
        log.warn("TASK_REMINDER_LEAD_MINUTES is not a number ({s}); using 60", .{raw});
        return 60 * 60;
    };
    if (minutes < 0) return 0;
    return minutes * 60;
}

/// How many delivery failures before a task's reminder is abandoned.
///
/// Three is enough to ride out a mail server that is briefly unreachable, and
/// few enough that an address which will never accept mail stops being retried
/// within a few minutes rather than for the life of the task.
const MAX_REMINDER_ATTEMPTS: i64 = 3;

fn processDueReminders(allocator: std.mem.Allocator) !void {
    const task_result = try db.getDueTasksForReminders(allocator, leadSeconds(), MAX_REMINDER_ATTEMPTS);
    defer allocator.free(task_result);

    const parsed_tasks = try std.json.parseFromSlice([]models.SurrealResponse(models.Task), allocator, task_result, .{ .ignore_unknown_fields = true });
    defer parsed_tasks.deinit();

    if (parsed_tasks.value.len == 0 or parsed_tasks.value[0].result.len == 0) return;

    for (parsed_tasks.value[0].result) |task| {
        const due_date = task.due_date orelse continue;

        const user_result = db.getUserById(allocator, task.user_id) catch |err| {
            log.warn("Reminder skipped; failed to load user for task {s}: {}", .{ task.id, err });
            continue;
        };
        defer allocator.free(user_result);

        const parsed_users = std.json.parseFromSlice([]models.SurrealResponse(models.User), allocator, user_result, .{ .ignore_unknown_fields = true }) catch |err| {
            log.warn("Reminder skipped; invalid user payload for task {s}: {}", .{ task.id, err });
            continue;
        };
        defer parsed_users.deinit();

        if (parsed_users.value.len == 0 or parsed_users.value[0].result.len == 0) continue;
        const user = parsed_users.value[0].result[0];

        // SECURITY: never mail an address nobody has proven they control.
        // Signing up with someone else's address and filling a workspace with
        // due tasks would otherwise turn this into a way to send them mail.
        // The task keeps its unsent state, so verifying later still works.
        if (!user.email_verified) {
            log.debug("Reminder skipped for task {s}: address not verified", .{task.id});
            continue;
        }

        // A task may have moved to trash after this cycle selected it.
        // Recheck immediately before SMTP; already in-flight mail cannot be recalled.
        if (!try db.canWriteTask(allocator, task.id, task.user_id)) continue;
        email.sendTaskReminderEmail(allocator, user.email, user.name, task.title, due_date) catch |err| {
            log.warn("Reminder email failed for task {s}: {}", .{ task.id, err });
            db.bumpReminderAttempts(allocator, task.id) catch |bump_err| {
                log.warn("Failed to record the reminder attempt for {s}: {}", .{ task.id, bump_err });
            };
            continue;
        };

        db.markTaskReminderSent(allocator, task.id) catch |err| {
            log.warn("Reminder sent but marker update failed for task {s}: {}", .{ task.id, err });
        };
    }
}

fn reminderLoop(allocator: std.mem.Allocator) void {
    while (reminder_running.load(.acquire)) {
        var arena = std.heap.ArenaAllocator.init(allocator);
        processDueReminders(arena.allocator()) catch |err| {
            log.warn("Reminder cycle failed: {}", .{err});
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
    log.info("Task reminder thread started", .{});
}

pub fn stopReminderThread() void {
    if (reminder_thread) |thread| {
        reminder_running.store(false, .release);
        thread.join();
        reminder_thread = null;
        log.info("Task reminder thread stopped", .{});
    }
}
