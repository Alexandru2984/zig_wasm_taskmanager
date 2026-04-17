const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const app = @import("../app.zig");
const models = @import("../domain/models.zig");
const http = @import("../util/http.zig");

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
    } else {
        // Use jsonError or jsonSuccess with 503?
        // jsonError takes a message string, but we want to return the structured response.
        // So we use jsonSuccess but set status manually before?
        // http.jsonSuccess sets status to .ok.
        // Let's manually send it or add a helper.
        // Or just use jsonSuccess and let the client check the status field.
        // But standard practice is 503.
        
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
}

pub fn handleMetrics(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    _ = req_alloc;
    
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
    
    r.setHeader("Content-Type", "text/plain; version=0.0.4") catch {};
    r.setStatus(.ok);
    try r.sendBody(metrics);
}
