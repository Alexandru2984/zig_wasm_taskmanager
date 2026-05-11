const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const http = @import("../util/http.zig");

pub fn getActivity(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const db_result = db.getActivityByUser(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to load activity");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.ActivityEvent), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0) {
        try http.jsonSuccess(r, [0]models.ActivityResponse{});
        return;
    }

    var events = std.ArrayListUnmanaged(models.ActivityResponse){};
    defer events.deinit(req_alloc);

    for (parsed.value[0].result) |event| {
        try events.append(req_alloc, .{
            .id = event.id,
            .action = event.action,
            .entity_type = event.entity_type,
            .entity_id = event.entity_id,
            .created_at = event.created_at,
        });
    }

    try http.jsonSuccess(r, events.items);
}
