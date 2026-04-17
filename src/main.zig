const std = @import("std");
const zap = @import("zap");
const app = @import("app.zig");
const db = @import("db/db.zig");
const config = @import("config/config.zig");
const log = @import("util/log.zig");
const rate_limiter = @import("util/rate_limiter.zig");

// Handlers
const auth_handler = @import("handlers/auth.zig");
const tasks_handler = @import("handlers/tasks.zig");
const profile_handler = @import("handlers/profile.zig");
const system_handler = @import("handlers/system.zig");

// Global allocator (will use GPA from app module)
var allocator: std.mem.Allocator = undefined;

pub fn main() !void {
    // Initialize app with GPA allocator
    try app.init();
    defer app.deinit(); // Clean shutdown with leak detection
    
    allocator = app.allocator();

    // Initialize SurrealDB schema
    db.initSchema(allocator) catch |err| {
        log.warn("Could not initialize DB schema: {} (continuing anyway)", .{err});
    };
    
    // Initialize rate limiters
    rate_limiter.initAll(allocator);
    defer rate_limiter.deinitAll();
    
    // Start cleanup thread
    rate_limiter.startCleanupThread() catch |err| {
        log.warn("Failed to start rate limiter cleanup thread: {}", .{err});
    };

    // Read server config from .env (with defaults)
    const port_str = config.get("PORT") orelse "9000";
    const port: u16 = std.fmt.parseInt(u16, port_str, 10) catch 9000;
    const interface = config.get("INTERFACE") orelse "127.0.0.1";
    
    var listener = zap.HttpListener.init(.{
        .port = port,
        .interface = interface.ptr, // Convert slice to C pointer
        .on_request = handleRequest,
        .log = true,
    });
    try listener.listen();

    log.banner("Task Manager", interface, port);

    zap.start(.{
        .threads = 2,
        .workers = 1,
    });
}

fn handleRequest(r: zap.Request) anyerror!void {
    // Create request-scoped arena - automatically cleaned up at end of request
    var arena = app.createRequestArena();
    defer arena.deinit();
    const req_alloc = arena.allocator();
    
    // Generate unique request ID for tracing
    var request_id_buf: [16]u8 = undefined;
    std.crypto.random.bytes(&request_id_buf);
    const hex_chars = "0123456789abcdef";
    var request_id: [32]u8 = undefined;
    for (request_id_buf, 0..) |byte, i| {
        request_id[i * 2] = hex_chars[byte >> 4];
        request_id[i * 2 + 1] = hex_chars[byte & 0x0F];
    }
    r.setHeader("X-Request-ID", &request_id) catch {};
    
    const path = r.path orelse "/";

    if (std.mem.startsWith(u8, path, "/api/")) {
        try handleApi(r, path, req_alloc);
    } else {
        try serveStatic(r, path, req_alloc);
    }
}

fn handleApi(r: zap.Request, path: []const u8, req_alloc: std.mem.Allocator) !void {
    r.setHeader("Content-Type", "application/json") catch {};
    
    // SECURITY: CORS origin from .env config (defaults to * for development)
    const cors_origin = config.getOrDefault("CORS_ORIGIN", "*");
    r.setHeader("Access-Control-Allow-Origin", cors_origin) catch {};
    r.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS") catch {};
    r.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization") catch {};
    r.setHeader("Access-Control-Allow-Credentials", "true") catch {};
    
    // SECURITY: Additional security headers
    r.setHeader("X-Content-Type-Options", "nosniff") catch {};
    r.setHeader("X-Frame-Options", "DENY") catch {};
    r.setHeader("Referrer-Policy", "strict-origin-when-cross-origin") catch {};
    r.setHeader("X-XSS-Protection", "1; mode=block") catch {};

    if (r.method) |method| {
        if (std.mem.eql(u8, method, "OPTIONS")) {
            r.setStatus(.ok);
            r.sendBody("") catch {};
            return;
        }
    }

    // System routes
    if (std.mem.eql(u8, path, "/api/health")) {
        try system_handler.handleHealth(r, req_alloc);
        return;
    }
    if (std.mem.eql(u8, path, "/api/ready")) {
        try system_handler.handleReady(r, req_alloc);
        return;
    }
    if (std.mem.eql(u8, path, "/api/metrics")) {
        try system_handler.handleMetrics(r, req_alloc);
        return;
    }

    // Auth routes
    if (std.mem.eql(u8, path, "/api/auth/signup")) {
        try auth_handler.handleSignup(r, req_alloc);
        return;
    } else if (std.mem.eql(u8, path, "/api/auth/login")) {
        try auth_handler.handleLogin(r, req_alloc);
        return;
    } else if (std.mem.eql(u8, path, "/api/auth/me")) {
        try auth_handler.handleMe(r, req_alloc);
        return;
    } else if (std.mem.eql(u8, path, "/api/auth/forgot-password")) {
        try auth_handler.handleForgotPassword(r, req_alloc);
        return;
    } else if (std.mem.eql(u8, path, "/api/auth/reset-password")) {
        try auth_handler.handleResetPassword(r, req_alloc);
        return;
    } else if (std.mem.eql(u8, path, "/api/auth/resend-verification")) {
        try auth_handler.handleResendVerification(r, req_alloc);
        return;
    } else if (std.mem.startsWith(u8, path, "/api/auth/verify")) {
        try auth_handler.handleVerifyEmail(r, req_alloc);
        return;
    }

    // Profile routes
    if (std.mem.eql(u8, path, "/api/profile")) {
        if (r.method) |method| {
            if (std.mem.eql(u8, method, "GET")) {
                try profile_handler.getProfile(r, req_alloc);
            } else if (std.mem.eql(u8, method, "PUT")) {
                try profile_handler.updateProfile(r, req_alloc);
            }
        }
        return;
    } else if (std.mem.eql(u8, path, "/api/profile/password")) {
        try profile_handler.changePassword(r, req_alloc);
        return;
    }

    // Task routes
    if (std.mem.eql(u8, path, "/api/tasks")) {
        if (r.method) |method| {
            if (std.mem.eql(u8, method, "GET")) {
                try tasks_handler.getTasks(r, req_alloc);
            } else if (std.mem.eql(u8, method, "POST")) {
                try tasks_handler.createTask(r, req_alloc);
            }
        }
    } else if (std.mem.startsWith(u8, path, "/api/tasks/")) {
        const task_id = path[11..];
        if (task_id.len == 0) {
            r.setStatus(.bad_request);
            try r.sendBody("{\"error\": \"Invalid ID\"}");
            return;
        }

        if (r.method) |method| {
            if (std.mem.eql(u8, method, "PUT")) {
                try tasks_handler.toggleTask(r, task_id, req_alloc);
            } else if (std.mem.eql(u8, method, "DELETE")) {
                try tasks_handler.deleteTask(r, task_id, req_alloc);
            }
        }
    } else {
        r.setStatus(.not_found);
        try r.sendBody("{\"error\": \"Not found\"}");
    }
}

fn serveStatic(r: zap.Request, path: []const u8, req_alloc: std.mem.Allocator) !void {
    // SECURITY: Block path traversal attacks
    if (std.mem.indexOf(u8, path, "..") != null) {
        std.debug.print("🚫 Path traversal blocked: {s}\n", .{path});
        r.setStatus(.forbidden);
        try r.sendBody("403 Forbidden");
        return;
    }
    
    // SECURITY: Block hidden files and sensitive paths
    if (std.mem.startsWith(u8, path, "/.") or 
        std.mem.indexOf(u8, path, "/.") != null or
        std.mem.eql(u8, path, "/db_settings.txt") or
        std.mem.eql(u8, path, "/mail_settings.txt")) {
        std.debug.print("🚫 Hidden/sensitive file blocked: {s}\n", .{path});
        r.setStatus(.not_found);
        try r.sendBody("404 Not Found");
        return;
    }

    const file_path = if (std.mem.eql(u8, path, "/"))
        "public/index.html"
    else blk: {
        var buf: [256]u8 = undefined;
        const p = std.fmt.bufPrint(&buf, "public{s}", .{path}) catch "public/index.html";
        break :blk p;
    };
    
    // SECURITY: Verify resolved path stays within public directory
    const cwd = std.fs.cwd();
    const real_path = cwd.realpathAlloc(req_alloc, file_path) catch {
        r.setStatus(.not_found);
        try r.sendBody("404 Not Found");
        return;
    };
    
    const public_base = cwd.realpathAlloc(req_alloc, "public") catch {
        r.setStatus(.internal_server_error);
        try r.sendBody("500 Server Error");
        return;
    };
    
    // Ensure file is within public directory
    if (!std.mem.startsWith(u8, real_path, public_base)) {
        std.debug.print("🚫 Path escape blocked: {s} not in {s}\n", .{real_path, public_base});
        r.setStatus(.forbidden);
        try r.sendBody("403 Forbidden");
        return;
    }

    const ext = std.fs.path.extension(file_path);
    const content_type = if (std.mem.eql(u8, ext, ".html"))
        "text/html"
    else if (std.mem.eql(u8, ext, ".css"))
        "text/css"
    else if (std.mem.eql(u8, ext, ".js"))
        "application/javascript"
    else if (std.mem.eql(u8, ext, ".wasm"))
        "application/wasm"
    else if (std.mem.eql(u8, ext, ".png"))
        "image/png"
    else if (std.mem.eql(u8, ext, ".jpg") or std.mem.eql(u8, ext, ".jpeg"))
        "image/jpeg"
    else if (std.mem.eql(u8, ext, ".svg"))
        "image/svg+xml"
    else if (std.mem.eql(u8, ext, ".ico"))
        "image/x-icon"
    else
        "application/octet-stream";

    r.setHeader("Content-Type", content_type) catch {};
    
    // SECURITY: Add security headers for static files
    r.setHeader("X-Content-Type-Options", "nosniff") catch {};
    r.setHeader("X-Frame-Options", "SAMEORIGIN") catch {};
    r.setHeader("Referrer-Policy", "strict-origin-when-cross-origin") catch {};
    
    // Add CSP for HTML pages only
    if (std.mem.eql(u8, ext, ".html")) {
        r.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://task.micutu.com") catch {};
    }

    const file = cwd.openFile(file_path, .{}) catch {
        r.setStatus(.not_found);
        try r.sendBody("404 Not Found");
        return;
    };
    defer file.close();

    const stat = try file.stat();
    // Use req_alloc (Arena) instead of global allocator to avoid leaks
    const content = try req_alloc.alloc(u8, stat.size);

    _ = try file.readAll(content);

    // Cache-Control: no-cache for HTML, 1 hour for assets
    if (std.mem.eql(u8, ext, ".html")) {
        r.setHeader("Cache-Control", "no-cache, must-revalidate") catch {};
    } else {
        r.setHeader("Cache-Control", "public, max-age=3600") catch {};
    }

    r.setStatus(.ok);
    try r.sendBody(content);
}
