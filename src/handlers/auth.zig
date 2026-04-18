const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const auth = @import("../services/auth.zig");
const email = @import("../services/email.zig");
const validation = @import("../util/validation.zig");
const rate_limiter = @import("../util/rate_limiter.zig");
const http = @import("../util/http.zig");

pub fn handleSignup(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // SECURITY: Rate limiting - 3 signups per minute per IP
    const client_ip = http.getClientIp(r);
    if (rate_limiter.signup_limiter) |*limiter| {
        if (!limiter.isAllowed(client_ip)) {
            r.setHeader("Retry-After", "60") catch {};
            try http.jsonError(r, 429, "Too many signup attempts. Please wait 1 minute.");
            return;
        }
    }

    // Parse request body
    const request = http.parseBody(req_alloc, r, models.SignupRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    // Validate email
    if (!validation.validateEmail(request.email)) {
        try http.jsonError(r, 400, "Invalid email format");
        return;
    }

    // Validate password
    const pwd_result = validation.validatePasswordStrength(request.password);
    if (!pwd_result.valid) {
        if (pwd_result.too_short) {
            try http.jsonError(r, 400, "Password must be at least 8 characters");
        } else if (pwd_result.too_long) {
            try http.jsonError(r, 400, "Password is too long");
        } else {
            try http.jsonError(r, 400, "Password must contain at least one letter and one number");
        }
        return;
    }

    // Validate name
    const name = request.name orelse "User";
    if (!validation.validateName(name)) {
        try http.jsonError(r, 400, "Invalid name format");
        return;
    }

    // Check if email exists
    {
        const db_result = try db.getUserByEmail(req_alloc, request.email);
        defer req_alloc.free(db_result);
        
        const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();

        if (parsed.value.len > 0 and parsed.value[0].result.len > 0) {
            try http.jsonError(r, 400, "Email already exists");
            return;
        }
    }

    // Hash password
    const password_hash = try auth.hashPassword(req_alloc, request.password);

    // Generate verification code
    const verification_code = try auth.generateVerificationCode(req_alloc);
    const verification_expires = std.time.timestamp() + 600; // 10 minutes

    // Create user in DB. SECURITY: the pre-check above has a TOCTOU — two
    // parallel signups for the same email can both pass and then race at the
    // UNIQUE index. When that happens, surface it as 400 "Email already exists"
    // instead of a generic 500.
    const db_result = db.createUser(req_alloc, request.email, password_hash, name, verification_code, verification_expires) catch {
        const dup_check = db.getUserByEmail(req_alloc, request.email) catch {
            try http.jsonError(r, 500, "Failed to create user");
            return;
        };
        defer req_alloc.free(dup_check);
        const dup_parsed = std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, dup_check, .{ .ignore_unknown_fields = true }) catch {
            try http.jsonError(r, 500, "Failed to create user");
            return;
        };
        defer dup_parsed.deinit();
        if (dup_parsed.value.len > 0 and dup_parsed.value[0].result.len > 0) {
            try http.jsonError(r, 400, "Email already exists");
            return;
        }
        try http.jsonError(r, 500, "Failed to create user");
        return;
    };
    defer req_alloc.free(db_result);

    // Parse created user to get ID
    const parsed_created = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed_created.deinit();

    if (parsed_created.value.len == 0 or parsed_created.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to retrieve created user");
        return;
    }
    const user = parsed_created.value[0].result[0];

    // Send confirmation email
    email.sendConfirmationEmail(req_alloc, user.email, user.name, verification_code) catch |err| {
        std.debug.print("Failed to send confirmation email: {}\n", .{err});
    };

    // Create session
    const token = db.createSession(req_alloc, user.id) catch {
        try http.jsonError(r, 500, "Failed to create session");
        return;
    };

    // SECURITY: session is carried ONLY via the HttpOnly cookie — the token is
    // NOT echoed in the response body, so an XSS that reads fetch responses
    // can't exfiltrate it.
    http.setAuthCookie(r, token);

    const response = models.AuthResponse{
        .user = .{
            .id = user.id,
            .email = user.email,
            .name = user.name,
            .email_verified = false,
        },
    };

    try http.jsonCreated(r, response);
}

pub fn handleLogin(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // SECURITY: Rate limiting - 5 attempts per minute per IP
    const client_ip = http.getClientIp(r);
    if (rate_limiter.login_limiter) |*limiter| {
        if (!limiter.isAllowed(client_ip)) {
            r.setHeader("Retry-After", "60") catch {};
            try http.jsonError(r, 429, "Too many login attempts. Please wait 1 minute.");
            return;
        }
    }

    const request = http.parseBody(req_alloc, r, models.LoginRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    // Get user from DB
    const db_result = db.getUserByEmail(req_alloc, request.email) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        // SECURITY: equalize timing with the real-user path so attackers can't
        // probe which emails are registered by measuring response latency.
        auth.burnTime(req_alloc, request.password);
        try http.jsonError(r, 401, "Invalid credentials");
        return;
    }
    const user = parsed.value[0].result[0];

    // Verify password
    const valid = auth.verifyPassword(req_alloc, user.password_hash, request.password) catch false;
    if (!valid) {
        try http.jsonError(r, 401, "Invalid credentials");
        return;
    }

    // Create session
    const token = db.createSession(req_alloc, user.id) catch {
        try http.jsonError(r, 500, "Failed to create session");
        return;
    };

    // SECURITY: session lives in the HttpOnly cookie only (see signup note).
    http.setAuthCookie(r, token);

    const response = models.AuthResponse{
        .user = .{
            .id = user.id,
            .email = user.email,
            .name = user.name,
            .email_verified = user.email_verified,
        },
    };

    try http.jsonSuccess(r, response);
}

pub fn handleMe(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const db_result = db.getUserById(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 404, "User not found");
        return;
    }
    const user = parsed.value[0].result[0];

    const response = models.UserProfile{
        .id = user.id,
        .email = user.email,
        .name = user.name,
        .email_verified = user.email_verified,
    };

    try http.jsonSuccess(r, response);
}

pub fn handleVerifyEmail(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // SECURITY: IP-level brute-force protection (10/min/IP). A global lookup by
    // code is no longer possible — we bind the code to the authenticated user —
    // so 6-digit entropy only needs to resist per-user brute-force.
    const client_ip = http.getClientIp(r);
    if (rate_limiter.verify_limiter) |*limiter| {
        if (!limiter.isAllowed(client_ip)) {
            r.setHeader("Retry-After", "60") catch {};
            try http.jsonError(r, 429, "Too many verification attempts. Please wait 1 minute.");
            return;
        }
    }

    // SECURITY: require the logged-in session. Without this, any anonymous
    // actor could iterate 6-digit codes and verify another user's mailbox.
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const request = http.parseBody(req_alloc, r, struct { code: []const u8 }) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    const code = request.code;
    if (code.len != 6) {
        try http.jsonError(r, 400, "Invalid verification code");
        return;
    }
    for (code) |c| {
        if (!std.ascii.isDigit(c)) {
            try http.jsonError(r, 400, "Invalid verification code");
            return;
        }
    }

    const now_ts = std.time.timestamp();
    const verified = db.verifyUserEmailAtomic(req_alloc, user_id, code, now_ts) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };

    if (!verified) {
        // SECURITY: 5 wrong attempts per user invalidates the current code; the
        // user must resend. This caps per-user brute-force at 5/code regardless
        // of how many IPs the attacker rotates.
        const MAX_ATTEMPTS: u32 = 5;
        const attempts = db.bumpVerificationAttempts(req_alloc, user_id, MAX_ATTEMPTS) catch 0;
        if (attempts >= MAX_ATTEMPTS) {
            try http.jsonError(r, 400, "Too many wrong attempts. Please resend the verification code.");
            return;
        }
        try http.jsonError(r, 400, "Invalid or expired code");
        return;
    }

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "Email verified successfully" });
}

pub fn handleForgotPassword(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // SECURITY: Rate limit to stop forgot-password from being used to spam
    // users or as an oracle. Limiter already exists in rate_limiter.initAll.
    const client_ip = http.getClientIp(r);
    if (rate_limiter.forgot_password_limiter) |*limiter| {
        if (!limiter.isAllowed(client_ip)) {
            r.setHeader("Retry-After", "60") catch {};
            try http.jsonError(r, 429, "Too many password reset requests. Please wait 1 minute.");
            return;
        }
    }

    const request = http.parseBody(req_alloc, r, struct { email: []const u8 }) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    const db_result = db.getUserByEmail(req_alloc, request.email) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len > 0 and parsed.value[0].result.len > 0) {
        const user = parsed.value[0].result[0];
        const token = try auth.generateResetToken(req_alloc);
        const expires = std.time.timestamp() + 3600; // 1 hour

        _ = db.setResetToken(req_alloc, user.id, token, expires) catch {};

        // SECURITY: never log the token (journal readers could lift it) and
        // never log the full email (GDPR / user enumeration via systemd logs).
        email.sendPasswordResetEmail(req_alloc, user.email, token) catch |err| {
            std.debug.print("Failed to send reset email: {}\n", .{err});
        };
    }

    // Always return success to prevent email enumeration
    try http.jsonSuccess(r, models.SuccessResponse{ .status = "If the email exists, a reset link has been sent." });
}

pub fn handleResetPassword(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // SECURITY: rate-limit token guesses. Even though the token is 64 hex chars
    // (256-bit entropy), a per-IP cap defends against pathological cases.
    const client_ip = http.getClientIp(r);
    if (rate_limiter.reset_password_limiter) |*limiter| {
        if (!limiter.isAllowed(client_ip)) {
            r.setHeader("Retry-After", "60") catch {};
            try http.jsonError(r, 429, "Too many reset attempts. Please wait 1 minute.");
            return;
        }
    }

    const Request = struct {
        token: []const u8,
        new_password: []const u8,
    };

    const request = http.parseBody(req_alloc, r, Request) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    // SECURITY: Validate new password strength — previously reset-password
    // would accept any password, bypassing the signup strength rules.
    const pwd_result = validation.validatePasswordStrength(request.new_password);
    if (!pwd_result.valid) {
        if (pwd_result.too_short) {
            try http.jsonError(r, 400, "Password must be at least 8 characters");
        } else if (pwd_result.too_long) {
            try http.jsonError(r, 400, "Password is too long");
        } else {
            try http.jsonError(r, 400, "Password must contain at least one letter and one number");
        }
        return;
    }

    const db_result = db.getUserByResetToken(req_alloc, request.token) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 400, "Invalid or expired token");
        return;
    }
    const user = parsed.value[0].result[0];

    // Check expiration
    if (user.reset_expires) |expires| {
        if (expires < std.time.timestamp()) {
            try http.jsonError(r, 400, "Token expired");
            return;
        }
    }

    // SECURITY: update password AND invalidate the reset token in a single
    // UPDATE so a partial failure can't leave the token reusable.
    const password_hash = try auth.hashPassword(req_alloc, request.new_password);
    const upd = db.resetUserPasswordAndClearToken(req_alloc, user.id, password_hash) catch {
        try http.jsonError(r, 500, "Failed to update password");
        return;
    };
    req_alloc.free(upd);

    // SECURITY: force re-login on all devices after a password reset.
    db.deleteUserSessions(req_alloc, user.id) catch |err| {
        std.debug.print("Failed to invalidate sessions for {s}: {}\n", .{ user.id, err });
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "Password reset successfully" });
}

pub fn handleLogout(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // Try session_token cookie first (preferred), fall back to Authorization: Bearer
    var token_opt: ?[]const u8 = null;

    r.parseCookies(false);
    if (r.getCookieStr(req_alloc, "session_token")) |maybe_cookie| {
        if (maybe_cookie) |t| token_opt = t;
    } else |_| {}

    if (token_opt == null) {
        if (r.getHeader("authorization")) |auth_header| {
            if (std.mem.startsWith(u8, auth_header, "Bearer ")) {
                token_opt = auth_header[7..];
            }
        }
    }

    if (token_opt) |token| {
        db.deleteSession(req_alloc, token) catch |err| {
            std.debug.print("Failed to delete session: {}\n", .{err});
        };
    }

    http.clearAuthCookie(r);
    try http.jsonSuccess(r, models.SuccessResponse{ .status = "logged out" });
}

pub fn handleResendVerification(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    // SECURITY: resend triggers a Brevo API call and sends an email — expensive
    // and abusable to spam a user's inbox. Cap at 3 per 5 minutes per IP.
    const client_ip = http.getClientIp(r);
    if (rate_limiter.resend_verification_limiter) |*limiter| {
        if (!limiter.isAllowed(client_ip)) {
            r.setHeader("Retry-After", "300") catch {};
            try http.jsonError(r, 429, "Too many resend requests. Please wait 5 minutes.");
            return;
        }
    }

    // Require authentication
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    // Get user to check if already verified
    const user_result = db.getUserById(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Failed to get user");
        return;
    };
    defer req_alloc.free(user_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, user_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 404, "User not found");
        return;
    }
    const user = parsed.value[0].result[0];

    // Check if already verified
    if (user.email_verified) {
        try http.jsonError(r, 400, "Email already verified");
        return;
    }

    // Generate new verification code
    const verification_code = try auth.generateVerificationCode(req_alloc);
    const verification_expires = std.time.timestamp() + 600; // 10 minutes

    // Update user with new code
    _ = db.setVerificationToken(req_alloc, user_id, verification_code, verification_expires) catch {
        try http.jsonError(r, 500, "Failed to update verification code");
        return;
    };

    // Send email
    email.sendConfirmationEmail(req_alloc, user.email, user.name, verification_code) catch |err| {
        std.debug.print("Failed to send verification email: {}\n", .{err});
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "Verification code sent" });
}
