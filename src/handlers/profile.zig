const std = @import("std");
const zap = @import("zap");
const db = @import("../db/db.zig");
const models = @import("../domain/models.zig");
const auth = @import("../services/auth.zig");
const validation = @import("../util/validation.zig");
const http = @import("../util/http.zig");

pub fn getProfile(r: zap.Request, req_alloc: std.mem.Allocator) !void {
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

pub fn updateProfile(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const request = http.parseBody(req_alloc, r, models.UpdateProfileRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    if (!validation.validateName(request.name)) {
        try http.jsonError(r, 400, "Invalid name format");
        return;
    }

    _ = db.updateUserName(req_alloc, user_id, request.name) catch {
        try http.jsonError(r, 500, "Failed to update profile");
        return;
    };

    // Return updated profile
    // We could fetch it again, or just construct it if we trust the update
    // Let's fetch it to be sure and consistent
    const db_result = db.getUserById(req_alloc, user_id) catch {
        try http.jsonError(r, 500, "Database error");
        return;
    };
    defer req_alloc.free(db_result);

    const parsed = try std.json.parseFromSlice([]models.SurrealResponse(models.User), req_alloc, db_result, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();

    if (parsed.value.len == 0 or parsed.value[0].result.len == 0) {
        try http.jsonError(r, 500, "Failed to retrieve updated profile");
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

pub fn changePassword(r: zap.Request, req_alloc: std.mem.Allocator) !void {
    const user_id = http.getCurrentUserId(req_alloc, r) orelse {
        try http.jsonError(r, 401, "Not authenticated");
        return;
    };

    const request = http.parseBody(req_alloc, r, models.ChangePasswordRequest) catch {
        try http.jsonError(r, 400, "Invalid JSON body");
        return;
    };

    // Verify old password
    // Need to fetch user first to get hash
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

    const valid = auth.verifyPassword(req_alloc, user.password_hash, request.old_password) catch false;
    if (!valid) {
        try http.jsonError(r, 403, "Invalid old password");
        return;
    }

    // SECURITY: Prevent reusing same password
    if (std.mem.eql(u8, request.new_password, request.old_password)) {
        try http.jsonError(r, 400, "New password must be different from current password");
        return;
    }

    // Validate new password
    const pwd_result = validation.validatePasswordStrength(request.new_password);
    if (!pwd_result.valid) {
        if (pwd_result.too_short) {
            try http.jsonError(r, 400, "New password must be at least 8 characters");
        } else {
            try http.jsonError(r, 400, "New password is too long");
        }
        return;
    }

    // Update password
    const new_hash = try auth.hashPassword(req_alloc, request.new_password);
    _ = db.updateUserPassword(req_alloc, user_id, new_hash) catch {
        try http.jsonError(r, 500, "Failed to update password");
        return;
    };

    try http.jsonSuccess(r, models.SuccessResponse{ .status = "Password updated successfully" });
}
