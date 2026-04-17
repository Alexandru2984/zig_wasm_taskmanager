

const std = @import("std");

// ==========================================
// DOMAIN ENTITIES
// ==========================================

pub const User = struct {
    id: []const u8,
    email: []const u8,
    password_hash: []const u8,
    name: []const u8,
    avatar: ?[]const u8 = null,
    email_verified: bool = false,
    verification_token: ?[]const u8 = null,
    verification_expires: ?i64 = null,
    reset_token: ?[]const u8 = null,
    reset_expires: ?i64 = null,
};

pub const Task = struct {
    id: []const u8,
    user_id: []const u8,
    title: []const u8,
    completed: bool = false,
    created_at: []const u8, // SurrealDB returns datetime as string in JSON
    due_date: ?[]const u8 = null,
};

pub const Session = struct {
    token: []const u8,
    user_id: []const u8,
    expires_at: []const u8,
};

// ==========================================
// API REQUEST/RESPONSE MODELS
// ==========================================

// --- Auth ---

pub const LoginRequest = struct {
    email: []const u8,
    password: []const u8,
};

pub const SignupRequest = struct {
    email: []const u8,
    password: []const u8,
    name: ?[]const u8 = null,
};

pub const AuthResponse = struct {
    token: []const u8,
    user: UserProfile,
};

pub const UserProfile = struct {
    id: []const u8,
    email: []const u8,
    name: []const u8,
    email_verified: bool = false,
};

pub const UpdateProfileRequest = struct {
    name: []const u8,
    // avatar: ?[]const u8 = null, // Not implemented in DB yet fully?
};

pub const ChangePasswordRequest = struct {
    old_password: []const u8,
    new_password: []const u8,
};

// --- Tasks ---

pub const CreateTaskRequest = struct {
    title: []const u8,
    due_date: ?[]const u8 = null,
};

pub const TaskResponse = struct {
    id: []const u8,
    title: []const u8,
    completed: bool,
    created_at: []const u8,
    due_date: ?[]const u8 = null,
};

// --- Common ---

pub const ErrorResponse = struct {
    error_message: []const u8,
    
    // Custom JSON serialization to map "error_message" to "error" key
    // or we just use "error" as field name, but "error" is a keyword in Zig.
    // We can use @"" syntax or just use a different name and rely on custom stringify if needed.
    // For simplicity, let's use a wrapper or just `error_msg` and hope we can customize key.
    // std.json doesn't support custom keys easily without custom stringify.
    // Let's use `err` or just build a struct with `error` field using @"" syntax.
};

pub const ApiError = struct {
    @"error": []const u8,
};

pub const SuccessResponse = struct {
    status: []const u8 = "success",
};

pub const HealthResponse = struct {
    status: []const u8,
};

pub const ReadyResponse = struct {
    status: []const u8,
    database: []const u8,
    config_loaded: bool,
};

// ==========================================
// DB RESPONSE MODELS
// ==========================================

pub fn SurrealResponse(comptime T: type) type {
    return struct {
        time: []const u8,
        status: []const u8,
        result: []T,
    };
}
