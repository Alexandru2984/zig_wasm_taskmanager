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
    workspace_id: ?[]const u8 = null,
    title: []const u8,
    completed: bool = false,
    created_at: []const u8, // SurrealDB returns datetime as string in JSON
    due_date: ?[]const u8 = null,
    priority: []const u8 = "normal",
    reminder_sent: bool = false,
    reminder_attempts: i64 = 0,
    notes: []const u8 = "",
    tags: []const []const u8 = &.{},
    updated_at: ?[]const u8 = null,
    status: []const u8 = "todo",
    recurrence: []const u8 = "none",
    parent_id: ?[]const u8 = null,
    assignee_id: ?[]const u8 = null,
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
    workspace_id: ?[]const u8 = null,
    due_date: ?[]const u8 = null,
    priority: ?[]const u8 = null,
    notes: ?[]const u8 = null,
    tags: ?[]const []const u8 = null,
    status: ?[]const u8 = null,
    recurrence: ?[]const u8 = null,
    parent_id: ?[]const u8 = null,
    assignee_id: ?[]const u8 = null,
};

pub const TaskResponse = struct {
    id: []const u8,
    workspace_id: ?[]const u8 = null,
    title: []const u8,
    completed: bool,
    created_at: []const u8,
    due_date: ?[]const u8 = null,
    priority: []const u8 = "normal",
    reminder_sent: bool = false,
    notes: []const u8 = "",
    tags: []const []const u8 = &.{},
    updated_at: ?[]const u8 = null,
    status: []const u8 = "todo",
    recurrence: []const u8 = "none",
    parent_id: ?[]const u8 = null,
    assignee_id: ?[]const u8 = null,
};

/// Partial task update. Every field is optional; omitting one leaves the
/// stored value untouched. `due_date: ""` clears the date, which is why it is
/// a string rather than a nullable date.
pub const UpdateTaskRequest = struct {
    title: ?[]const u8 = null,
    priority: ?[]const u8 = null,
    notes: ?[]const u8 = null,
    completed: ?bool = null,
    tags: ?[]const []const u8 = null,
    due_date: ?[]const u8 = null,
    status: ?[]const u8 = null,
    recurrence: ?[]const u8 = null,
    /// Empty string clears the assignment, matching due_date's convention.
    assignee_id: ?[]const u8 = null,
};

pub const Workspace = struct {
    id: []const u8,
    name: []const u8,
    owner_id: []const u8,
    created_at: []const u8,
};

pub const WorkspaceMembership = struct {
    id: []const u8,
    workspace_id: []const u8,
    user_id: []const u8,
    role: []const u8,
    created_at: []const u8,
};

pub const WorkspaceInvite = struct {
    id: []const u8,
    workspace_id: []const u8,
    email: []const u8,
    role: []const u8,
    token: []const u8,
    invited_by: []const u8,
    expires_at: i64,
    accepted_at: ?i64 = null,
    created_at: []const u8,
};

pub const WorkspaceResponse = struct {
    id: []const u8,
    name: []const u8,
    role: []const u8,
    created_at: []const u8,
};

pub const CreateWorkspaceRequest = struct {
    name: []const u8,
};

pub const WorkspaceMemberResponse = struct {
    id: []const u8,
    user_id: []const u8,
    email: []const u8,
    name: []const u8,
    role: []const u8,
    created_at: []const u8,
};

pub const CreateWorkspaceInviteRequest = struct {
    email: []const u8,
    role: []const u8,
};

pub const ChangeMemberRoleRequest = struct {
    user_id: []const u8,
    role: []const u8,
};

pub const RemoveMemberRequest = struct {
    user_id: []const u8,
};

pub const RevokeInviteRequest = struct {
    invite_id: []const u8,
};

pub const PendingInviteResponse = struct {
    id: []const u8,
    email: []const u8,
    role: []const u8,
    expires_at: i64,
    created_at: []const u8,
};

pub const AcceptWorkspaceInviteRequest = struct {
    token: []const u8,
};

pub const WorkspaceInviteResponse = struct {
    id: []const u8,
    workspace_id: []const u8,
    email: []const u8,
    role: []const u8,
    expires_at: i64,
    accepted_at: ?i64 = null,
    created_at: []const u8,
};

pub const ActivityEvent = struct {
    id: []const u8,
    user_id: []const u8,
    action: []const u8,
    entity_type: []const u8,
    entity_id: []const u8 = "",
    created_at: []const u8,
};

pub const ActivityResponse = struct {
    id: []const u8,
    action: []const u8,
    entity_type: []const u8,
    entity_id: []const u8 = "",
    created_at: []const u8,
};

// --- Account & data ---

pub const SessionResponse = struct {
    id: []const u8,
    created_at: []const u8,
    expires_at: []const u8,
    /// True for the session making the request, so the UI can label it and
    /// refuse to offer "revoke" for the device you are holding.
    current: bool = false,
};

pub const DeleteAccountRequest = struct {
    password: []const u8,
};

pub const ExportTask = struct {
    status: []const u8 = "todo",
    recurrence: []const u8 = "none",
    parent_id: ?[]const u8 = null,
    assignee_id: ?[]const u8 = null,
    id: []const u8,
    title: []const u8,
    notes: []const u8 = "",
    tags: []const []const u8 = &.{},
    completed: bool = false,
    priority: []const u8 = "normal",
    due_date: ?[]const u8 = null,
    created_at: []const u8,
    updated_at: ?[]const u8 = null,
    workspace_id: ?[]const u8 = null,
};

pub const MailDelivery = struct {
    id: []const u8,
    kind: []const u8,
    reference_id: []const u8,
    status: []const u8,
    attempts: u32,
    created_at: i64,
    last_error: []const u8,
};

pub const ExportDocument = struct {
    exported_at: i64,
    account: UserProfile,
    tasks: []const ExportTask,
    workspaces: []const WorkspaceResponse,
    activity: []const ActivityResponse,
    email_deliveries: []const MailDelivery = &.{},
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
