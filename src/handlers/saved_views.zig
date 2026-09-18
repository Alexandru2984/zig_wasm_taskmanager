const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const http = @import("../util/http.zig");
const limits = @import("../util/rate_limiter.zig");
const validation = @import("../util/saved_views.zig");

pub fn handle(r: zap.Request, workspace_id: []const u8, a: std.mem.Allocator) !void {
    const user = http.getCurrentUserId(a, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };
    const writing = std.mem.eql(u8, r.method orelse "", "PUT");
    const limiter = if (writing) &limits.task_write_limiter else &limits.task_search_limiter;
    if (limiter.*) |*budget| if (!budget.isAllowed(user)) {
        r.setHeader("Retry-After", "60") catch {};
        try http.jsonError(r, 429, "Too many requests. Wait 1 minute before refreshing views.");
        return;
    };
    const raw = if (writing) blk: {
        if (r.body) |body| if (body.len > 32768) {
            try http.jsonError(r, 400, "Saved views request exceeds 32 KiB");
            return;
        };
        const input = http.parseBody(a, r, models.SaveViewsRequest) catch {
            try http.jsonError(r, 400, "Views, membership and expected version are required");
            return;
        };
        if (!validation.valid(input)) {
            try http.jsonError(r, 400, "Invalid saved views; at most 12 valid views with unique IDs are allowed");
            return;
        }
        break :blk db.impl.saveWorkspaceViews(a, user, workspace_id, input) catch |err| {
            try http.mutationError(r, err, "Save outcome could not be confirmed. Refresh views before retrying.");
            return;
        };
    } else db.impl.getWorkspaceViews(a, user, workspace_id) catch |err| {
        try http.mutationError(r, err, "Could not load saved views. Refresh to retry.");
        return;
    };
    defer a.free(raw);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.SavedViewSet), a, raw, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    if (parsed.value.len != 1 or parsed.value[0].result.len != 1) return error.InvalidResponse;
    try http.jsonSuccess(r, parsed.value[0].result[0]);
}
