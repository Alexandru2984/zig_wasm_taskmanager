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

    // Start session cleanup thread (deletes expired rows from `sessions` hourly)
    db.startSessionCleanupThread(allocator) catch |err| {
        log.warn("Failed to start session cleanup thread: {}", .{err});
    };
    defer db.stopSessionCleanupThread();

    // Read server config from .env (with defaults)
    const port_str = config.get("PORT") orelse "9000";
    const port: u16 = std.fmt.parseInt(u16, port_str, 10) catch 9000;
    const interface = config.get("INTERFACE") orelse "127.0.0.1";

    // SECURITY: warn if CORS_ORIGIN is missing so operators don't accidentally
    // deploy without cross-origin protection (and because our frontend needs
    // the cookie + origin match to work through nginx).
    if (config.get("CORS_ORIGIN") == null) {
        log.warn("CORS_ORIGIN is not set in .env — cross-origin requests will have no ACAO header", .{});
    }
    
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

    // SECURITY: CORS_ORIGIN must be explicitly set in .env. We refuse to send
    // "*" combined with Allow-Credentials (browsers reject it anyway, but
    // leaving a wildcard would silently disable CORS for our own frontend).
    if (config.get("CORS_ORIGIN")) |cors_origin| {
        r.setHeader("Access-Control-Allow-Origin", cors_origin) catch {};
        r.setHeader("Access-Control-Allow-Credentials", "true") catch {};
    }
    r.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS") catch {};
    r.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization") catch {};
    
    // SECURITY: Additional security headers
    r.setHeader("X-Content-Type-Options", "nosniff") catch {};
    r.setHeader("X-Frame-Options", "DENY") catch {};
    r.setHeader("Referrer-Policy", "strict-origin-when-cross-origin") catch {};
    // Permissions-Policy: deny every powerful browser feature we don't use.
    r.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()") catch {};
    // HSTS. Opt-in via HSTS_MAX_AGE so it's never enabled during pure-HTTP
    // local dev (setting HSTS on http://localhost would poison the browser
    // cache for future HTTPS work on the same host).
    if (config.get("HSTS_MAX_AGE")) |max_age| {
        const hsts_value = std.fmt.allocPrint(req_alloc, "max-age={s}; includeSubDomains", .{max_age}) catch "max-age=31536000; includeSubDomains";
        r.setHeader("Strict-Transport-Security", hsts_value) catch {};
    }

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

    // Auth routes. Every state-changing endpoint must be POST; /api/auth/me is
    // a read and allows GET. Reject anything else with 405 Method Not Allowed.
    const req_method = r.method orelse "";
    const AuthRoute = struct { path: []const u8, method: []const u8, handler: *const fn (zap.Request, std.mem.Allocator) anyerror!void };
    const auth_routes = [_]AuthRoute{
        .{ .path = "/api/auth/signup",              .method = "POST", .handler = auth_handler.handleSignup },
        .{ .path = "/api/auth/login",               .method = "POST", .handler = auth_handler.handleLogin },
        .{ .path = "/api/auth/me",                  .method = "GET",  .handler = auth_handler.handleMe },
        .{ .path = "/api/auth/logout",              .method = "POST", .handler = auth_handler.handleLogout },
        .{ .path = "/api/auth/forgot-password",     .method = "POST", .handler = auth_handler.handleForgotPassword },
        .{ .path = "/api/auth/reset-password",      .method = "POST", .handler = auth_handler.handleResetPassword },
        .{ .path = "/api/auth/resend-verification", .method = "POST", .handler = auth_handler.handleResendVerification },
        .{ .path = "/api/auth/verify",              .method = "POST", .handler = auth_handler.handleVerifyEmail },
    };
    for (auth_routes) |route| {
        if (std.mem.eql(u8, path, route.path)) {
            if (!std.mem.eql(u8, req_method, route.method)) {
                r.setHeader("Allow", route.method) catch {};
                r.setStatus(.method_not_allowed);
                try r.sendBody("{\"error\": \"Method not allowed\"}");
                return;
            }
            try route.handler(r, req_alloc);
            return;
        }
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
        log.warn("Path traversal blocked: {s}", .{path});
        r.setStatus(.forbidden);
        try r.sendBody("403 Forbidden");
        return;
    }

    // SECURITY: Block hidden files and sensitive paths
    if (std.mem.startsWith(u8, path, "/.") or
        std.mem.indexOf(u8, path, "/.") != null or
        std.mem.eql(u8, path, "/db_settings.txt") or
        std.mem.eql(u8, path, "/mail_settings.txt"))
    {
        r.setStatus(.not_found);
        try r.sendBody("404 Not Found");
        return;
    }

    const file_path = if (std.mem.eql(u8, path, "/"))
        "public/index.html"
    else
        try std.fmt.allocPrint(req_alloc, "public{s}", .{path});
    
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
        log.warn("Path escape blocked: {s} not in {s}", .{ real_path, public_base });
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
    r.setHeader("X-Frame-Options", "DENY") catch {};
    r.setHeader("Referrer-Policy", "strict-origin-when-cross-origin") catch {};
    r.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()") catch {};
    if (config.get("HSTS_MAX_AGE")) |max_age| {
        const hsts_value = std.fmt.allocPrint(req_alloc, "max-age={s}; includeSubDomains", .{max_age}) catch "max-age=31536000; includeSubDomains";
        r.setHeader("Strict-Transport-Security", hsts_value) catch {};
    }
    
    // SECURITY: strict CSP. No inline scripts, no inline styles — every HTML
    // file points at style.css / reset-password.js / app.js, so the browser
    // will refuse any injected <script> or style= attribute.
    if (std.mem.eql(u8, ext, ".html")) {
        r.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'") catch {};
    }

    const file = cwd.openFile(file_path, .{}) catch {
        r.setStatus(.not_found);
        try r.sendBody("404 Not Found");
        return;
    };
    defer file.close();

    const stat = try file.stat();
    // SECURITY: cap static file size so an accidentally-huge file in public/
    // can't blow RAM per request. 10 MiB is plenty for HTML/CSS/JS/WASM.
    const MAX_STATIC: u64 = 10 * 1024 * 1024;
    if (stat.size > MAX_STATIC) {
        r.setStatus(.content_too_large);
        try r.sendBody("413 Content Too Large");
        return;
    }
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
