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
        } else {
            try http.jsonError(r, 400, "Password is too long");
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

    // Create user in DB
    const db_result = db.createUser(req_alloc, request.email, password_hash, name, verification_code, verification_expires) catch {
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

    // SECURITY: Set HttpOnly cookie (prevents XSS token theft)
    http.setAuthCookie(r, token);

    // Return response (still includes token for backwards compatibility)
    const response = models.AuthResponse{
        .token = token,
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

    // SECURITY: Set HttpOnly cookie (prevents XSS token theft)
    http.setAuthCookie(r, token);

    // Return response (still includes token for backwards compatibility)
    const response = models.AuthResponse{
        .token = token,
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
    // Accept POST with JSON body containing { "code": "123456" }
    const request = http.parseBody(req_alloc, r, struct { code: []const u8 }) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    const code = request.code;
    if (code.len == 0) {
        try http.jsonError(r, 400, "Missing verification code");
        return;
    }

    // Verify code in DB
    const db_result = db.getUserByVerificationToken(req_alloc, code) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 400, "Invalid or expired code");
        return;
    }
    const user = parsed.value[0].result[0];

    // Check expiration
    if (user.verification_expires) |expires| {
        if (expires < std.time.timestamp()) {
            try http.jsonError(r, 400, "Verification code expired");
            return;
        }
    }

    // Mark verified
    _ = db.updateUserVerified(req_alloc, user.id) catch {
        try http.jsonError(r, 500, "Failed to update user");
        return;
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "Email verified successfully" });
}

pub fn handleForgotPassword(r: zap.Request, req_alloc: std.mem.Allocator) !void {
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
        
        // Send email
        email.sendPasswordResetEmail(req_alloc, user.email, token) catch |err| {
            std.debug.print("Failed to send reset email: {}\n", .{err});
        };
        std.debug.print("Reset token for {s}: {s}\n", .{user.email, token});
    }

    // Always return success to prevent email enumeration
    try http.jsonSuccess(r, models.SuccessResponse{ .status = "If the email exists, a reset link has been sent." });
}

pub fn handleResetPassword(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const Request = struct {
        token: []const u8,
        new_password: []const u8,
    };
    
    const request = http.parseBody(req_alloc, r, Request) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

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

    // Update password
    const password_hash = try auth.hashPassword(req_alloc, request.new_password);
    _ = db.updateUserPassword(req_alloc, user.id, password_hash) catch {
        try http.jsonError(r, 500, "Failed to update password");
        return;
    };

    // Clear reset token (optional, but good practice)
    // db.clearResetToken(req_alloc, user.id) ...

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "Password reset successfully" });
}

pub fn handleResendVerification(r: zap.Request, req_alloc: std.mem.Allocator) !void {
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
