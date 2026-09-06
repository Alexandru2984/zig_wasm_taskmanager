const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const config = @import("../config/config.zig");

// SECURITY: the `__Host-` prefix is enforced by the browser, not by us. A
// cookie carrying it is refused unless it is Secure, Path=/ and has no Domain
// attribute — which is exactly the property we need here, because it makes the
// cookie unsettable by any other host under micutu.com. Without it, a sibling
// subdomain could write `csrf_token` on the parent domain and have it sent
// along with ours.
//
// The prefix requires Secure, so plain-HTTP local development (COOKIE_INSECURE=1)
// falls back to the unprefixed names. Production always gets the prefixed pair.
const SESSION_COOKIE_SECURE = "__Host-session_token";
const CSRF_COOKIE_SECURE = "__Host-csrf_token";
const SESSION_COOKIE_PLAIN = "session_token";
const CSRF_COOKIE_PLAIN = "csrf_token";

fn cookieSecure() bool {
    return !std.mem.eql(u8, config.getOrDefault("COOKIE_INSECURE", "0"), "1");
}

fn sessionCookieName() []const u8 {
    return if (cookieSecure()) SESSION_COOKIE_SECURE else SESSION_COOKIE_PLAIN;
}

fn csrfCookieName() []const u8 {
    return if (cookieSecure()) CSRF_COOKIE_SECURE else CSRF_COOKIE_PLAIN;
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

/// Set the session pair for a freshly created session.
///
/// The session token is HttpOnly so script can never read it; the CSRF token
/// deliberately is not, because the front end has to echo it back in a header.
/// They are minted together by db.createSession and only their hashes are
/// stored, so the CSRF value is meaningful only for this one session.
pub fn setAuthCookie(r: zap.Request, session: db.NewSession) void {
    r.setCookie(.{
        .name = sessionCookieName(),
        .value = session.token[0..],
        .http_only = true,
        // SECURITY: Mark Secure so the cookie is only sent over HTTPS.
        // All production deployments sit behind nginx+TLS; for pure-local
        // http://127.0.0.1 testing, set COOKIE_INSECURE=1 in .env.
        .secure = cookieSecure(),
        .same_site = .Strict,
        .max_age_s = 7 * 24 * 60 * 60, // 7 days in seconds
        .path = "/",
    }) catch {};

    r.setCookie(.{
        .name = csrfCookieName(),
        .value = session.csrf[0..],
        .http_only = false,
        .secure = cookieSecure(),
        .same_site = .Strict,
        .max_age_s = 7 * 24 * 60 * 60,
        .path = "/",
    }) catch {};
}

/// Clear session cookie (for logout).
/// Clears both the prefixed and unprefixed names: a browser that still holds a
/// cookie issued before the `__Host-` change would otherwise keep sending it.
pub fn clearAuthCookie(r: zap.Request) void {
    const session_names = [_][]const u8{ SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN };
    const csrf_names = [_][]const u8{ CSRF_COOKIE_SECURE, CSRF_COOKIE_PLAIN };

    for (session_names) |name| {
        r.setCookie(.{
            .name = name,
            .value = "",
            .http_only = true,
            .secure = cookieSecure(),
            .max_age_s = 0, // Expire immediately
            .path = "/",
        }) catch {};
    }
    for (csrf_names) |name| {
        r.setCookie(.{
            .name = name,
            .value = "",
            .http_only = false,
            .secure = cookieSecure(),
            .max_age_s = 0,
            .path = "/",
        }) catch {};
    }
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
    return findCookieValue(cookie_header, sessionCookieName());
}

/// Verify CSRF for a cookie-authenticated unsafe request.
///
/// SECURITY: this is no longer a bare double-submit check. The submitted token
/// is hashed and compared against the hash stored on the session row that the
/// session cookie resolves to, so a valid token cannot be minted by anyone who
/// cannot read the session cookie itself. A sibling subdomain writing its own
/// `csrf_token` on the parent domain now fails instead of passing.
///
/// Requests carrying no session cookie are not CSRFable — there is nothing to
/// ride on — and Bearer clients do not send browser cookies at all.
pub fn verifyCsrfToken(allocator: std.mem.Allocator, r: zap.Request) bool {
    // Authentication prefers the cookie, so an additional Bearer header must
    // never exempt that cookie from CSRF validation (even a valid Bearer).
    const session_cookie = getSessionTokenFromCookie(r) orelse return true;
    if (session_cookie.len == 0) return true;

    const csrf_header = r.getHeader("x-csrf-token") orelse r.getHeader("X-CSRF-Token") orelse return false;
    if (csrf_header.len == 0) return false;

    const info = (db.lookupSession(allocator, session_cookie) catch return false) orelse return false;
    defer allocator.free(info.user_id);
    defer allocator.free(info.csrf_hash);

    // A session row predating migration 007 has an empty hash and cannot be
    // verified. Fail closed: the user re-authenticates and gets a bound pair.
    if (info.csrf_hash.len == 0) return false;

    const submitted = db.hashTokenHex(csrf_header);
    if (submitted.len != info.csrf_hash.len) return false;
    var acc: u8 = 0;
    for (submitted, info.csrf_hash) |x, y| acc |= x ^ y;
    return acc == 0;
}

fn hexDigit(c: u8) ?u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => null,
    };
}

/// Percent-decode one path segment.
///
/// Record ids look like `tasks:abc123`, and a colon is a reserved character, so
/// any correct client percent-encodes it — `encodeURIComponent` certainly does.
/// The router slices ids straight out of the raw path, so without this the
/// server compared `tasks%3Aabc123` against the database and found nothing,
/// reporting it as a failure to verify ownership.
///
/// `+` is left alone: it means a space in a query string, never in a path.
/// A malformed escape returns null rather than being passed through, so a
/// truncated or hand-mangled id is rejected instead of silently altered.
pub fn percentDecode(allocator: std.mem.Allocator, input: []const u8) !?[]u8 {
    if (std.mem.indexOfScalar(u8, input, '%') == null) return null;

    var out = try std.ArrayListUnmanaged(u8).initCapacity(allocator, input.len);
    errdefer out.deinit(allocator);

    var i: usize = 0;
    while (i < input.len) {
        if (input[i] == '%') {
            if (i + 2 >= input.len) return error.InvalidEncoding;
            const hi = hexDigit(input[i + 1]) orelse return error.InvalidEncoding;
            const lo = hexDigit(input[i + 2]) orelse return error.InvalidEncoding;
            try out.append(allocator, hi * 16 + lo);
            i += 3;
        } else {
            try out.append(allocator, input[i]);
            i += 1;
        }
    }
    return try out.toOwnedSlice(allocator);
}

/// percentDecode, but returns the original slice when there is nothing to
/// decode, so callers do not have to branch. Returns null on a malformed
/// escape sequence, which callers should surface as a 400.
pub fn decodePathSegment(allocator: std.mem.Allocator, segment: []const u8) ?[]const u8 {
    const decoded = percentDecode(allocator, segment) catch return null;
    return decoded orelse segment;
}

/// Maximum JSON body size accepted by any endpoint.
/// Our largest legitimate body is a few hundred bytes (signup); 64 KB is a
/// generous cap that still stops "POST {10 MB of junk}" DoS attempts.
pub const MAX_BODY_SIZE: usize = 64 * 1024;

/// Parse a JSON body into a struct, allocating into the request arena.
///
/// This used to call parseFromSlice and then `defer parsed.deinit()` before
/// returning parsed.value — freeing everything the parser had allocated and
/// handing back pointers into it. It looked fine only because std.json points
/// simple strings straight at the source buffer, which outlives the call.
/// Anything the parser genuinely had to allocate dangled: a title containing
/// an escape like \" or \n, and every array field.
///
/// parseFromSliceLeaky allocates into the caller's allocator with no arena of
/// its own, which is exactly right here — the request arena already frees the
/// whole allocation at the end of the request.
pub fn parseBody(allocator: std.mem.Allocator, r: zap.Request, comptime T: type) !T {
    const body = r.body orelse return error.NoBody;
    if (body.len > MAX_BODY_SIZE) return error.BodyTooLarge;

    return std.json.parseFromSliceLeaky(T, allocator, body, .{ .ignore_unknown_fields = true });
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

// ---------- Tests ----------

test "percentDecode leaves an unescaped segment alone" {
    const a = std.testing.allocator;
    try std.testing.expectEqual(@as(?[]u8, null), try percentDecode(a, "tasks:abc123"));
}

test "percentDecode restores an encoded record id" {
    const a = std.testing.allocator;
    const out = (try percentDecode(a, "tasks%3Aabc123")).?;
    defer a.free(out);
    try std.testing.expectEqualStrings("tasks:abc123", out);
}

test "percentDecode rejects malformed escapes" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.InvalidEncoding, percentDecode(a, "tasks%3"));
    try std.testing.expectError(error.InvalidEncoding, percentDecode(a, "tasks%zz"));
}

test "percentDecode does not treat + as a space" {
    const a = std.testing.allocator;
    // A path segment is not a query string; `+` is a literal there.
    const out = (try percentDecode(a, "a+b%3Ac")).?;
    defer a.free(out);
    try std.testing.expectEqualStrings("a+b:c", out);
}
