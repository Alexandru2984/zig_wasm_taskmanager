// Database Repository Interface
// Abstract interface for database operations - allows swapping implementations
// Currently implemented by surreal.zig, can later add postgres.zig

const std = @import("std");

/// Error types for database operations
pub const DbError = error{
    ConnectionFailed,
    QueryFailed,
    NotFound,
    DuplicateEntry,
    InvalidData,
    MissingConfig,
};

/// User record structure
pub const User = struct {
    id: []const u8,
    email: []const u8,
    password_hash: []const u8,
    name: []const u8,
    email_verified: bool,
    verification_token: ?[]const u8,
    reset_token: ?[]const u8,
    reset_expires: ?i64,
};

/// Task record structure
pub const Task = struct {
    id: []const u8,
    user_id: []const u8,
    title: []const u8,
    completed: bool,
    due_date: ?[]const u8,
};

/// Session record structure
pub const Session = struct {
    token: []const u8,
    user_id: []const u8,
    expires_at: i64,
};

// Re-export the current implementation
// When we switch to Postgres, we change this import
pub const impl = @import("surreal.zig");

// Convenience wrappers that delegate to implementation
pub const query = impl.query;
pub const initSchema = impl.initSchema;

// User operations
pub const createUser = impl.createUser;
pub const getUserByEmail = impl.getUserByEmail;
pub const getUserById = impl.getUserById;
pub const updateUserVerified = impl.updateUserVerified;
pub const updateUserName = impl.updateUserName;
pub const updateUserPassword = impl.updateUserPassword;
pub const setResetToken = impl.setResetToken;
pub const setVerificationToken = impl.setVerificationToken;
pub const getUserByResetToken = impl.getUserByResetToken;
pub const getUserByVerificationToken = impl.getUserByVerificationToken;

// Task operations
pub const createTask = impl.createTask;
pub const createTaskWithDueDate = impl.createTaskWithDueDate;
pub const getTasksByUser = impl.getTasksByUser;
pub const toggleTask = impl.toggleTask;
pub const deleteTask = impl.deleteTask;
pub const getTaskOwner = impl.getTaskOwner;
pub const verifyTaskOwnership = impl.verifyTaskOwnership;

// Session operations
pub const generateSecureToken = impl.generateSecureToken;
pub const createSession = impl.createSession;
pub const validateSession = impl.validateSession;
pub const deleteSession = impl.deleteSession;
pub const deleteUserSessions = impl.deleteUserSessions;
pub const cleanupExpiredSessions = impl.cleanupExpiredSessions;
