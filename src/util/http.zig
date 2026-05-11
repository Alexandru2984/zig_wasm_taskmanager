const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const config = @import("../config/config.zig");

const SESSION_COOKIE = "session_token";
const CSRF_COOKIE = "csrf_token";

fn cookieSecure() bool {
    return !std.mem.eql(u8, config.getOrDefault("COOKIE_INSECURE", "0"), "1");
}

// ==========================================
// REQUEST HELPERS
// ==========================================

/// Remote socket peer address, as reported by facil.io (never user-controlled).
fn getPeerIp(r: zap.Request) []const u8 {
    const info = zap.fio.http_peer_addr(r.h);
    if (info.data) |ptr| {
        if (info.len > 0) return ptr[0..info.len];
    }
    return "";
}

/// Returns true if the immediate TCP peer is in the TRUST_PROXY whitelist
/// (comma-separated list of IPs in .env). Only then do we trust client-supplied
/// X-Real-IP / X-Forwarded-For headers.
fn peerIsTrustedProxy(peer: []const u8) bool {
    const trust = config.get("TRUST_PROXY") orelse return false;
    if (trust.len == 0 or peer.len == 0) return false;
    var it = std.mem.splitScalar(u8, trust, ',');
    while (it.next()) |raw| {
        const entry = std.mem.trim(u8, raw, " \t");
        if (entry.len == 0) continue;
        if (std.mem.eql(u8, entry, peer)) return true;
    }
    return false;
}

/// Get client IP for rate limiting.
/// SECURITY: X-Real-IP / X-Forwarded-For are only honored when the TCP peer is
/// in TRUST_PROXY. Otherwise anyone could spoof these headers and bypass
/// per-IP rate limits. Falls back to the socket peer IP, or "unknown" if the
/// peer address is unavailable (all unknowns share one rate-limit bucket).
pub fn getClientIp(r: zap.Request) []const u8 {
    const peer = getPeerIp(r);

    if (peerIsTrustedProxy(peer)) {
        if (r.getHeader("x-real-ip")) |ip| return ip;
        if (r.getHeader("x-forwarded-for")) |forwarded| {
            if (std.mem.indexOf(u8, forwarded, ",")) |comma| {
                return std.mem.trim(u8, forwarded[0..comma], " \t");
            }
            return std.mem.trim(u8, forwarded, " \t");
        }
    }

    if (peer.len > 0) return peer;
    return "unknown";
}

/// Get current user ID from session cookie or Authorization header.
/// Priority: Cookie (more secure) > Authorization header (backwards compatible).
/// Falls through to Bearer if the cookie is present but its session is invalid —
/// previously a stale cookie would cause the Bearer path to never be tried.
pub fn getCurrentUserId(allocator: std.mem.Allocator, r: zap.Request) ?[]const u8 {
    if (getSessionTokenFromCookie(r)) |token| {
        if (db.validateSession(allocator, token) catch null) |uid| return uid;
    }

    const auth_header = r.getHeader("authorization") orelse return null;
    if (!std.mem.startsWith(u8, auth_header, "Bearer ")) return null;
    const token = auth_header[7..];
    return db.validateSession(allocator, token) catch null;
}

/// Set HttpOnly session cookie (secure against XSS)
pub fn setAuthCookie(r: zap.Request, token: []const u8) void {
    r.setCookie(.{
        .name = SESSION_COOKIE,
        .value = token,
        .http_only = true,
        // SECURITY: Mark Secure so the cookie is only sent over HTTPS.
        // All production deployments sit behind nginx+TLS; for pure-local
        // http://127.0.0.1 testing, set COOKIE_INSECURE=1 in .env.
        .secure = cookieSecure(),
        .same_site = .Strict,
        .max_age_s = 7 * 24 * 60 * 60, // 7 days in seconds
        .path = "/",
    }) catch {};

    const csrf_token = db.generateSecureToken();
    r.setCookie(.{
        .name = CSRF_COOKIE,
        .value = csrf_token[0..],
        .http_only = false,
        .secure = cookieSecure(),
        .same_site = .Strict,
        .max_age_s = 7 * 24 * 60 * 60,
        .path = "/",
    }) catch {};
}

/// Clear session cookie (for logout)
pub fn clearAuthCookie(r: zap.Request) void {
    r.setCookie(.{
        .name = SESSION_COOKIE,
        .value = "",
        .http_only = true,
        .max_age_s = 0, // Expire immediately
        .path = "/",
    }) catch {};
    r.setCookie(.{
        .name = CSRF_COOKIE,
        .value = "",
        .http_only = false,
        .max_age_s = 0,
        .path = "/",
    }) catch {};
}

/// Validate double-submit CSRF protection for cookie-authenticated unsafe
/// requests. Bearer clients do not send browser cookies and are not CSRFable.
fn findCookieValue(cookie_header: []const u8, name: []const u8) ?[]const u8 {
    var it = std.mem.splitScalar(u8, cookie_header, ';');
    while (it.next()) |raw| {
        const cookie = std.mem.trim(u8, raw, " \t");
        if (cookie.len <= name.len or cookie[name.len] != '=') continue;
        if (std.mem.eql(u8, cookie[0..name.len], name)) return cookie[name.len + 1 ..];
    }
    return null;
}

pub fn getSessionTokenFromCookie(r: zap.Request) ?[]const u8 {
    const cookie_header = r.getHeader("cookie") orelse return null;
    return findCookieValue(cookie_header, SESSION_COOKIE);
}

pub fn verifyCsrfToken(_: std.mem.Allocator, r: zap.Request) bool {
    if (r.getHeader("authorization")) |auth_header| {
        if (std.mem.startsWith(u8, auth_header, "Bearer ")) return true;
    }

    const cookie_header = r.getHeader("cookie") orelse return true;
    const session_cookie = findCookieValue(cookie_header, SESSION_COOKIE) orelse return true;
    if (session_cookie.len == 0) return true;

    const csrf_cookie = findCookieValue(cookie_header, CSRF_COOKIE) orelse return false;
    const csrf_header = r.getHeader("x-csrf-token") orelse r.getHeader("X-CSRF-Token") orelse return false;

    if (csrf_cookie.len == 0 or csrf_header.len == 0) return false;
    return std.mem.eql(u8, csrf_cookie, csrf_header);
}

/// Maximum JSON body size accepted by any endpoint.
/// Our largest legitimate body is a few hundred bytes (signup); 64 KB is a
/// generous cap that still stops "POST {10 MB of junk}" DoS attempts.
pub const MAX_BODY_SIZE: usize = 64 * 1024;

/// Parse JSON body into a struct. Caller must pass the request arena as
/// `allocator` so all unescaped strings live exactly as long as the request.
pub fn parseBody(allocator: std.mem.Allocator, r: zap.Request, comptime T: type) !T {
    const body = r.body orelse return error.NoBody;
    if (body.len > MAX_BODY_SIZE) return error.BodyTooLarge;

    const parsed = try std.json.parseFromSlice(T, allocator, body, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    return parsed.value;
}

// ==========================================
// RESPONSE HELPERS
// ==========================================

pub fn jsonSuccess(r: zap.Request, data: anytype) !void {
    r.setStatus(.ok);
    r.setHeader("Content-Type", "application/json") catch {};

    var list = std.ArrayListUnmanaged(u8){};
    defer list.deinit(std.heap.page_allocator);

    var w = list.writer(std.heap.page_allocator);
    var buf: [128]u8 = undefined;
    var adapter = w.adaptToNewApi(&buf);
    try std.json.Stringify.value(data, .{}, &adapter.new_interface);
    try adapter.new_interface.flush();
    try r.sendBody(list.items);
}

pub fn jsonCreated(r: zap.Request, data: anytype) !void {
    r.setStatus(.created);
    r.setHeader("Content-Type", "application/json") catch {};

    var list = std.ArrayListUnmanaged(u8){};
    defer list.deinit(std.heap.page_allocator);

    var w = list.writer(std.heap.page_allocator);
    var buf: [128]u8 = undefined;
    var adapter = w.adaptToNewApi(&buf);
    try std.json.Stringify.value(data, .{}, &adapter.new_interface);
    try adapter.new_interface.flush(); // CRITICAL: must flush before sendBody!
    try r.sendBody(list.items);
}

pub fn jsonError(r: zap.Request, status: u32, message: []const u8) !void {
    r.setStatus(@enumFromInt(@as(u16, @intCast(status))));
    r.setHeader("Content-Type", "application/json") catch {};

    // Manual JSON for error to avoid allocation if possible, or just use stringify
    var list = std.ArrayListUnmanaged(u8){};
    defer list.deinit(std.heap.page_allocator);

    const err_obj = models.ApiError{ .@"error" = message };
    var w = list.writer(std.heap.page_allocator);
    var buf: [128]u8 = undefined;
    var adapter = w.adaptToNewApi(&buf);
    try std.json.Stringify.value(err_obj, .{}, &adapter.new_interface);
    try adapter.new_interface.flush();
    try r.sendBody(list.items);
}
