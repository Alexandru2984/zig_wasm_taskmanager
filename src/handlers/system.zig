const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const app = @import("../app.zig");
const models = @import("../domain/models.zig");
const http = @import("../util/http.zig");
const config = @import("../config/config.zig");

pub fn handleHealth(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    _ = req_alloc;
    try http.jsonSuccess(r, models.HealthResponse{ .status = "healthy" });
}

pub fn handleReady(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // Check DB connectivity
    const db_ok = blk: {
        const res = db.query(req_alloc, "INFO FOR DB;") catch break :blk false;
        req_alloc.free(res);
        break :blk true;
    };

    // Check config
    const config_ok = app.isConfigLoaded();

    const ready = db_ok and config_ok;
    const db_status = if (db_ok) "connected" else "disconnected";

    const response = models.ReadyResponse{
        .status = if (ready) "ready" else "not_ready",
        .database = db_status,
        .config_loaded = config_ok,
    };

    if (ready) {
        try http.jsonSuccess(r, response);
        return;
    }

    r.setStatus(.service_unavailable);
    r.setHeader("Content-Type", "application/json") catch {};
    var list = std.ArrayListUnmanaged(u8){};
    defer list.deinit(req_alloc);
    var w = list.writer(req_alloc);
    var buf: [128]u8 = undefined;
    var adapter = w.adaptToNewApi(&buf);
    try std.json.Stringify.value(response, .{}, &adapter.new_interface);
    try r.sendBody(list.items);
}

/// Constant-time slice compare. We can't use std.crypto.timing_safe.eql here
/// because it only accepts fixed-size arrays.
fn constantTimeEql(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var acc: u8 = 0;
    for (a, b) |x, y| acc |= x ^ y;
    return acc == 0;
}

pub fn handleMetrics(r: zap.Request, req_alloc: std.mem.Allocator) !void {

    // SECURITY: /api/metrics leaks app internals (uptime, version). Gate it
    // behind METRICS_TOKEN: if set, require Authorization: Bearer <token>.
    // If METRICS_TOKEN is unset, the endpoint is disabled entirely.
    const expected = config.get("METRICS_TOKEN") orelse {
        r.setStatus(.not_found);
        try r.sendBody("404 Not Found");
        return;
    };
    const auth_hdr = r.getHeader("authorization") orelse {
        r.setStatus(.unauthorized);
        try r.sendBody("401 Unauthorized");
        return;
    };
    if (!std.mem.startsWith(u8, auth_hdr, "Bearer ") or !constantTimeEql(auth_hdr[7..], expected)) {
        r.setStatus(.unauthorized);
        try r.sendBody("401 Unauthorized");
        return;
    }

    const uptime = std.time.timestamp() - app.start_time;

    var metrics_buf: [1024]u8 = undefined;
    const metrics = std.fmt.bufPrint(&metrics_buf,
        \\# HELP app_uptime_seconds Application uptime in seconds
        \\# TYPE app_uptime_seconds counter
        \\app_uptime_seconds {d}
        \\
        \\# HELP app_info Application info
        \\# TYPE app_info gauge
        \\app_info{{version="1.0.0"}} 1
        \\
    , .{uptime}) catch {
        try r.sendBody("# Error generating metrics");
        return;
    };

    const result = db.impl.mailStats(req_alloc) catch {
        try http.jsonError(r, 503, "Metrics temporarily unavailable");
        return;
    };
    defer req_alloc.free(result);
    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(struct { status: []const u8, total: u64, oldest: i64 }), req_alloc, result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    var output = std.ArrayListUnmanaged(u8){};
    defer output.deinit(req_alloc);
    try output.appendSlice(req_alloc, metrics);
    const writer = output.writer(req_alloc);
    for ([_][]const u8{ "pending", "processing", "delivered", "failed", "cancelled" }) |status| {
        var count: u64 = 0;
        var age: i64 = 0;
        if (parsed.value.len > 0) for (parsed.value[0].result) |row| {
            if (std.mem.eql(u8, row.status, status)) {
                count = row.total;
                age = @max(0, std.time.timestamp() - row.oldest);
            }
        };
        try writer.print("mail_outbox_jobs{{status=\"{s}\"}} {d}\nmail_outbox_oldest_seconds{{status=\"{s}\"}} {d}\n", .{ status, count, status, age });
    }
    r.setHeader("Content-Type", "text/plain; version=0.0.4") catch {};
    r.setStatus(.ok);
    try r.sendBody(output.items);
}
