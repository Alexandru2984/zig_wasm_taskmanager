const std = @import("std");
const zap = @import("zap");
const app = @import("app.zig");
const db = @import("db/db.zig");
const config = @import("config/config.zig");
const http = @import("util/http.zig");
const log = @import("util/log.zig");
const rate_limiter = @import("util/rate_limiter.zig");

// Handlers
const auth_handler = @import("handlers/auth.zig");
const tasks_handler = @import("handlers/tasks.zig");
const profile_handler = @import("handlers/profile.zig");
const system_handler = @import("handlers/system.zig");
const activity_handler = @import("handlers/activity.zig");
const workspaces_handler = @import("handlers/workspaces.zig");
const account_handler = @import("handlers/account.zig");
const reminders = @import("services/reminders.zig");
const email = @import("services/email.zig");

// Test aggregator: `zig build test` runs tests in the root file only, so pull
// in every module that has unit tests. Without this they silently never run.
test {
    _ = @import("config/config.zig");
    _ = @import("util/validation.zig");
    _ = @import("util/rate_limiter.zig");
    _ = @import("db/http_client.zig");
    _ = @import("services/auth.zig");
    _ = @import("util/http.zig");
}

// Global allocator (will use GPA from app module)
var allocator: std.mem.Allocator = undefined;

pub fn main() !void {
    // Initialize app with GPA allocator
    try app.init();
    defer app.deinit(); // Clean shutdown with leak detection

    allocator = app.allocator();

    // Apply the configured log level (defaults to info) before anything noisy.
    if (config.get("LOG_LEVEL")) |lvl| log.setLevelFromString(lvl);

    // Initialize SurrealDB schema, waiting for the DB to accept connections.
    // On a fresh `docker compose up` the database may not be ready the instant
    // the app boots, so retry a bounded number of times before giving up.
    const migrate_only = std.mem.eql(u8, config.getOrDefault("DB_MIGRATE_ONLY", "0"), "1");
    const auto_migrate = !std.mem.eql(u8, config.getOrDefault("DB_AUTO_MIGRATE", "1"), "0");
    {
        const max_attempts: u8 = 20;
        var attempt: u8 = 1;
        while (true) : (attempt += 1) {
            const schema = if (migrate_only or auto_migrate) db.initSchema(allocator) else db.checkSchema(allocator);
            if (schema) |_| break else |err| {
                if (attempt >= max_attempts) {
                    log.err("DB schema init failed after {d} attempts: {}; refusing to serve", .{ attempt, err });
                    return err;
                }
                log.warn("DB not ready ({}); retry {d}/{d}…", .{ err, attempt, max_attempts });
                std.Thread.sleep(1 * std.time.ns_per_s);
            }
        }
    }

    if (migrate_only) return;

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

    reminders.startReminderThread(allocator) catch |err| {
        log.warn("Failed to start reminder thread: {}", .{err});
    };
    defer reminders.stopReminderThread();

    // Background mailer: account emails are enqueued by handlers and sent here
    // so SMTP latency never sits on the request path.
    email.startMailerThread() catch |err| {
        log.warn("Failed to start mailer thread: {}", .{err});
    };
    defer email.stopMailerThread();

    // Read server config from .env (with defaults)
    const port_str = config.get("PORT") orelse "9000";
    const port: u16 = std.fmt.parseInt(u16, port_str, 10) catch 9000;
    const interface = config.get("INTERFACE") orelse "127.0.0.1";

    // SECURITY: warn if CORS_ORIGIN is missing so operators don't accidentally
    // deploy without cross-origin protection (and because our frontend needs
    // the cookie + origin match to work through nginx).
    if (config.get("CORS_ORIGIN")) |cors_origin| {
        if (!validateCorsOrigin(cors_origin)) {
            log.warn("Invalid CORS_ORIGIN in .env: refusing to start", .{});
            return error.InvalidCorsOrigin;
        }
    } else {
        log.warn("CORS_ORIGIN is not set in .env — cross-origin requests will have no ACAO header", .{});
    }

    var listener = zap.HttpListener.init(.{
        .port = port,
        .interface = interface.ptr, // Convert slice to C pointer
        .on_request = handleRequest,
        .log = true,
    });
    try listener.listen();

    log.info("Serving with {d} request threads in 1 worker process", .{serverThreads()});
    log.banner("Task Manager", interface, port);

    zap.start(.{
        .threads = serverThreads(),
        // Deliberately one process, not one per core.
        //
        // Several things in this program are per-process and would misbehave
        // if there were several: the reminder thread would send every due
        // reminder once per worker, the outbound mail queue would be split
        // across processes, and the in-memory rate limiters would each see
        // only a fraction of the traffic. Concurrency comes from threads,
        // which share all of that behind their existing mutexes.
        .workers = 1,
    });
}

/// How many request threads to run.
///
/// The previous fixed value of 2 was the ceiling on this server, not a
/// tuning choice. Hashing a password with Argon2id takes about two seconds
/// by design, and it holds its thread for the whole time — so two people
/// signing in at once occupied both threads, and anything else that arrived
/// meanwhile waited behind them. Measured on this machine: four concurrent
/// logins made an unrelated /api/health take three seconds, against half a
/// millisecond when idle.
///
/// Defaults to the CPU count, capped at 16. The cap is about memory rather
/// than CPU: each concurrent hash allocates its Argon2 memory cost (64 MB at
/// the current settings), so the worst case is threads × 64 MB of transient
/// allocation.
///
/// SERVER_THREADS overrides it for hosts where that default is wrong.
fn serverThreads() i16 {
    const DEFAULT_MAX = 16;

    if (config.get("SERVER_THREADS")) |raw| {
        const parsed = std.fmt.parseInt(i16, raw, 10) catch {
            log.warn("SERVER_THREADS is not a number ({s}); using the default", .{raw});
            return defaultThreads(DEFAULT_MAX);
        };
        if (parsed < 1) {
            log.warn("SERVER_THREADS must be at least 1; using the default", .{});
            return defaultThreads(DEFAULT_MAX);
        }
        return parsed;
    }
    return defaultThreads(DEFAULT_MAX);
}

fn defaultThreads(max: i16) i16 {
    const cpus = std.Thread.getCpuCount() catch 2;
    const clamped = @min(cpus, @as(usize, @intCast(max)));
    return @intCast(@max(clamped, 2));
}

fn validHeaderValue(value: []const u8) bool {
    for (value) |c| {
        switch (c) {
            '\r', '\n', 0 => return false,
            else => {},
        }
    }
    return true;
}

// http://localhost or http://127.0.0.1, optionally followed by ":port" or
// "/path". SECURITY: a bare startsWith would also accept hostile origins like
// http://localhost.attacker.com, so the char after the host must terminate it.
fn isLocalhostHttpOrigin(origin: []const u8) bool {
    const hosts = [_][]const u8{ "http://localhost", "http://127.0.0.1" };
    for (hosts) |host| {
        if (std.mem.startsWith(u8, origin, host)) {
            const rest = origin[host.len..];
            if (rest.len == 0 or rest[0] == ':' or rest[0] == '/') return true;
        }
    }
    return false;
}

fn validateCorsOrigin(origin: []const u8) bool {
    if (!validHeaderValue(origin)) return false;
    if (std.mem.eql(u8, origin, "*")) return false;
    return std.mem.startsWith(u8, origin, "https://") or isLocalhostHttpOrigin(origin);
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

    // SECURITY / CORRECTNESS: catch anything a handler lets escape.
    //
    // zap's default behaviour when the request callback returns an error is to
    // log it and finish the response as it stands — which, for a handler that
    // failed before writing anything, is HTTP 200 with an empty body. A client
    // then reads "200" as success for an operation that did not happen. That
    // was observable: creating a task with a due date the database rejects
    // answered 200 and created nothing.
    //
    // Handlers should still translate their own expected failures into precise
    // status codes. This is the backstop for the ones that do not.
    if (std.mem.startsWith(u8, path, "/api/")) {
        handleApi(r, path, req_alloc) catch |err| {
            log.err("Unhandled error serving {s}: {}", .{ path, err });
            r.setStatus(.internal_server_error);
            r.setHeader("Content-Type", "application/json") catch {};
            r.sendBody("{\"error\": \"Internal server error\"}") catch {};
        };
    } else {
        serveStatic(r, path, req_alloc) catch |err| {
            log.err("Unhandled error serving {s}: {}", .{ path, err });
            r.setStatus(.internal_server_error);
            r.sendBody("500 Internal Server Error") catch {};
        };
    }
}

fn handleApi(r: zap.Request, path: []const u8, req_alloc: std.mem.Allocator) !void {
    r.setHeader("Content-Type", "application/json") catch {};
    r.setHeader("Cache-Control", "no-store") catch {};

    // SECURITY: CORS_ORIGIN must be explicitly set in .env. We refuse to send
    // "*" combined with Allow-Credentials (browsers reject it anyway, but
    // leaving a wildcard would silently disable CORS for our own frontend).
    if (config.get("CORS_ORIGIN")) |cors_origin| {
        if (validateCorsOrigin(cors_origin)) {
            r.setHeader("Access-Control-Allow-Origin", cors_origin) catch {};
            r.setHeader("Access-Control-Allow-Credentials", "true") catch {};
        }
    }
    r.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS") catch {};
    r.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token") catch {};

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

    const req_method = r.method orelse "";
    const unsafe_method = !std.mem.eql(u8, req_method, "GET") and !std.mem.eql(u8, req_method, "HEAD");
    if (unsafe_method) {
        // CORS controls response access, not HTML form submissions. Protect
        // unauthenticated login/signup from cross-site session planting too.
        if (r.getHeader("origin")) |origin| {
            const allowed = config.get("CORS_ORIGIN") orelse "";
            if (!std.mem.eql(u8, origin, allowed)) {
                try http.jsonError(r, 403, "Origin not allowed");
                return;
            }
        }
        if (r.body) |body| {
            if (body.len > 0) {
                const content_type = r.getHeader("content-type") orelse "";
                var parts = std.mem.splitScalar(u8, content_type, ';');
                if (!std.ascii.eqlIgnoreCase(std.mem.trim(u8, parts.first(), " \t"), "application/json")) {
                    try http.jsonError(r, 415, "Content-Type must be application/json");
                    return;
                }
            }
        }
    }
    if (requiresCsrf(req_method, path) and !http.verifyCsrfToken(req_alloc, r)) {
        try http.jsonError(r, 403, "Invalid CSRF token");
        return;
    }

    // Auth routes. Every state-changing endpoint must be POST; /api/auth/me is
    // a read and allows GET. Reject anything else with 405 Method Not Allowed.
    const AuthRoute = struct { path: []const u8, method: []const u8, handler: *const fn (zap.Request, std.mem.Allocator) anyerror!void };
    const auth_routes = [_]AuthRoute{
        .{ .path = "/api/auth/signup", .method = "POST", .handler = auth_handler.handleSignup },
        .{ .path = "/api/auth/login", .method = "POST", .handler = auth_handler.handleLogin },
        .{ .path = "/api/auth/me", .method = "GET", .handler = auth_handler.handleMe },
        .{ .path = "/api/auth/logout", .method = "POST", .handler = auth_handler.handleLogout },
        .{ .path = "/api/auth/forgot-password", .method = "POST", .handler = auth_handler.handleForgotPassword },
        .{ .path = "/api/auth/reset-password", .method = "POST", .handler = auth_handler.handleResetPassword },
        .{ .path = "/api/auth/resend-verification", .method = "POST", .handler = auth_handler.handleResendVerification },
        .{ .path = "/api/auth/verify", .method = "POST", .handler = auth_handler.handleVerifyEmail },
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
            } else {
                r.setHeader("Allow", "GET, PUT") catch {};
                r.setStatus(.method_not_allowed);
                try r.sendBody("{\"error\": \"Method not allowed\"}");
            }
        } else {
            r.setHeader("Allow", "GET, PUT") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
        }
        return;
    } else if (std.mem.eql(u8, path, "/api/profile/password")) {
        if (!std.mem.eql(u8, req_method, "PUT")) {
            r.setHeader("Allow", "PUT") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
            return;
        }
        try profile_handler.changePassword(r, req_alloc);
        return;
    }

    if (std.mem.eql(u8, path, "/api/sessions")) {
        if (std.mem.eql(u8, req_method, "GET")) {
            try account_handler.listSessions(r, req_alloc);
        } else if (std.mem.eql(u8, req_method, "DELETE")) {
            try account_handler.revokeOtherSessions(r, req_alloc);
        } else {
            r.setHeader("Allow", "GET, DELETE") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
        }
        return;
    }

    if (std.mem.startsWith(u8, path, "/api/sessions/")) {
        const session_id = http.decodePathSegment(req_alloc, path["/api/sessions/".len..]) orelse {
            try http.jsonError(r, 400, "Invalid session ID");
            return;
        };
        if (!std.mem.eql(u8, req_method, "DELETE")) {
            r.setHeader("Allow", "DELETE") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
            return;
        }
        try account_handler.revokeSession(r, session_id, req_alloc);
        return;
    }

    if (std.mem.eql(u8, path, "/api/export")) {
        if (!std.mem.eql(u8, req_method, "GET")) {
            r.setHeader("Allow", "GET") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
            return;
        }
        try account_handler.exportData(r, req_alloc);
        return;
    }

    if (std.mem.eql(u8, path, "/api/account")) {
        if (!std.mem.eql(u8, req_method, "DELETE")) {
            r.setHeader("Allow", "DELETE") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
            return;
        }
        try account_handler.deleteAccount(r, req_alloc);
        return;
    }

    if (std.mem.eql(u8, path, "/api/activity")) {
        if (!std.mem.eql(u8, req_method, "GET")) {
            r.setHeader("Allow", "GET") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
            return;
        }
        try activity_handler.getActivity(r, req_alloc);
        return;
    }

    if (std.mem.eql(u8, path, "/api/workspaces")) {
        if (std.mem.eql(u8, req_method, "GET")) {
            try workspaces_handler.listWorkspaces(r, req_alloc);
        } else if (std.mem.eql(u8, req_method, "POST")) {
            try workspaces_handler.createWorkspace(r, req_alloc);
        } else {
            r.setHeader("Allow", "GET, POST") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
        }
        return;
    }

    if (std.mem.eql(u8, path, "/api/workspaces/invites/accept")) {
        if (!std.mem.eql(u8, req_method, "POST")) {
            r.setHeader("Allow", "POST") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
            return;
        }
        try workspaces_handler.acceptInvite(r, req_alloc);
        return;
    }

    if (std.mem.startsWith(u8, path, "/api/workspaces/")) {
        const rest = path["/api/workspaces/".len..];
        const MembersSuffix = "/members";
        const InvitesSuffix = "/invites";

        if (std.mem.endsWith(u8, rest, MembersSuffix)) {
            const workspace_id = http.decodePathSegment(req_alloc, rest[0 .. rest.len - MembersSuffix.len]) orelse {
                try http.jsonError(r, 400, "Invalid workspace ID");
                return;
            };
            if (workspace_id.len == 0 or !std.mem.startsWith(u8, workspace_id, "workspaces:")) {
                try http.jsonError(r, 400, "Invalid workspace ID");
                return;
            }
            if (std.mem.eql(u8, req_method, "GET")) {
                try workspaces_handler.listMembers(r, workspace_id, req_alloc);
            } else if (std.mem.eql(u8, req_method, "PUT")) {
                try workspaces_handler.changeMemberRole(r, workspace_id, req_alloc);
            } else if (std.mem.eql(u8, req_method, "DELETE")) {
                try workspaces_handler.removeMember(r, workspace_id, req_alloc);
            } else {
                r.setHeader("Allow", "GET, PUT, DELETE") catch {};
                r.setStatus(.method_not_allowed);
                try r.sendBody("{\"error\": \"Method not allowed\"}");
            }
            return;
        }

        if (std.mem.endsWith(u8, rest, InvitesSuffix)) {
            const workspace_id = http.decodePathSegment(req_alloc, rest[0 .. rest.len - InvitesSuffix.len]) orelse {
                try http.jsonError(r, 400, "Invalid workspace ID");
                return;
            };
            if (workspace_id.len == 0 or !std.mem.startsWith(u8, workspace_id, "workspaces:")) {
                try http.jsonError(r, 400, "Invalid workspace ID");
                return;
            }
            if (std.mem.eql(u8, req_method, "POST")) {
                try workspaces_handler.createInvite(r, workspace_id, req_alloc);
            } else if (std.mem.eql(u8, req_method, "GET")) {
                try workspaces_handler.listInvites(r, workspace_id, req_alloc);
            } else if (std.mem.eql(u8, req_method, "DELETE")) {
                try workspaces_handler.revokeInvite(r, workspace_id, req_alloc);
            } else {
                r.setHeader("Allow", "GET, POST, DELETE") catch {};
                r.setStatus(.method_not_allowed);
                try r.sendBody("{\"error\": \"Method not allowed\"}");
            }
            return;
        }
    }

    // Task routes
    if (std.mem.eql(u8, path, "/api/tasks")) {
        if (r.method) |method| {
            if (std.mem.eql(u8, method, "GET")) {
                try tasks_handler.getTasks(r, req_alloc);
            } else if (std.mem.eql(u8, method, "POST")) {
                try tasks_handler.createTask(r, req_alloc);
            } else {
                r.setHeader("Allow", "GET, POST") catch {};
                r.setStatus(.method_not_allowed);
                try r.sendBody("{\"error\": \"Method not allowed\"}");
            }
        } else {
            r.setHeader("Allow", "GET, POST") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
        }
    } else if (std.mem.startsWith(u8, path, "/api/tasks/")) {
        const raw_task_id = path["/api/tasks/".len..];
        if (raw_task_id.len == 0) {
            r.setStatus(.bad_request);
            try r.sendBody("{\"error\": \"Invalid ID\"}");
            return;
        }
        const task_id = http.decodePathSegment(req_alloc, raw_task_id) orelse {
            try http.jsonError(r, 400, "Invalid ID");
            return;
        };
        if (!@import("db/http_client.zig").validRecordIdFor(task_id, "tasks")) {
            try http.jsonError(r, 400, "Invalid task ID");
            return;
        }

        if (r.method) |method| {
            if (std.mem.eql(u8, method, "PUT")) {
                try tasks_handler.updateTask(r, task_id, req_alloc);
            } else if (std.mem.eql(u8, method, "DELETE")) {
                try tasks_handler.deleteTask(r, task_id, req_alloc);
            } else {
                r.setHeader("Allow", "PUT, DELETE") catch {};
                r.setStatus(.method_not_allowed);
                try r.sendBody("{\"error\": \"Method not allowed\"}");
            }
        } else {
            r.setHeader("Allow", "PUT, DELETE") catch {};
            r.setStatus(.method_not_allowed);
            try r.sendBody("{\"error\": \"Method not allowed\"}");
        }
    } else {
        r.setStatus(.not_found);
        try r.sendBody("{\"error\": \"Not found\"}");
    }
}

fn requiresCsrf(method: []const u8, path: []const u8) bool {
    if (std.mem.eql(u8, method, "GET") or
        std.mem.eql(u8, method, "HEAD") or
        std.mem.eql(u8, method, "OPTIONS"))
    {
        return false;
    }

    // These endpoints either create an authenticated browser session or are
    // started from an email link, so no CSRF cookie is guaranteed to exist yet.
    return !(std.mem.eql(u8, path, "/api/auth/signup") or
        std.mem.eql(u8, path, "/api/auth/login") or
        std.mem.eql(u8, path, "/api/auth/forgot-password") or
        std.mem.eql(u8, path, "/api/auth/reset-password"));
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
