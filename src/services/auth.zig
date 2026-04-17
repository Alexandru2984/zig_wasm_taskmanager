// Authentication module for Task Manager
// SECURITY: Uses Argon2id for password hashing (industry standard)
const std = @import("std");
const config = @import("../config/config.zig");

// Argon2id parameters (OWASP recommendations for password hashing)
const ARGON2_T_COST = 3;          // Time cost (iterations)
const ARGON2_M_COST = 65536;      // Memory cost (64 MB)
const ARGON2_PARALLELISM = 4;     // Parallelism

/// Hash a password using Argon2id with random salt
/// Returns format: "$argon2id$salt_hex$hash_hex"
pub fn hashPassword(allocator: std.mem.Allocator, password: []const u8) ![]u8 {
    // Generate random salt
    var salt: [16]u8 = undefined;
    std.crypto.random.bytes(&salt);
    
    // Derive key using Argon2id
    var derived_key: [32]u8 = undefined;
    std.crypto.pwhash.argon2.kdf(
        allocator,
        &derived_key,
        password,
        &salt,
        .{
            .t = ARGON2_T_COST,
            .m = ARGON2_M_COST,
            .p = ARGON2_PARALLELISM,
        },
        .argon2id,
    ) catch |err| {
        std.debug.print("Argon2 KDF error: {}\n", .{err});
        return error.HashingFailed;
    };
    
    // Convert to hex strings
    const hex_chars = "0123456789abcdef";
    var salt_hex: [32]u8 = undefined;
    var hash_hex: [64]u8 = undefined;
    
    for (salt, 0..) |byte, i| {
        salt_hex[i * 2] = hex_chars[byte >> 4];
        salt_hex[i * 2 + 1] = hex_chars[byte & 0x0F];
    }
    
    for (derived_key, 0..) |byte, i| {
        hash_hex[i * 2] = hex_chars[byte >> 4];
        hash_hex[i * 2 + 1] = hex_chars[byte & 0x0F];
    }
    
    // Return PHC-style format: $argon2id$salt$hash
    return try std.fmt.allocPrint(allocator, "$argon2id${s}${s}", .{ salt_hex, hash_hex });
}

/// Verify a password against a stored hash
/// Supports both new Argon2id format and legacy FNV-1a for soft migration
pub fn verifyPassword(allocator: std.mem.Allocator, stored_hash: []const u8, password: []const u8) !bool {
    // Check if it's new Argon2id format
    if (std.mem.startsWith(u8, stored_hash, "$argon2id$")) {
        return verifyArgon2Password(allocator, stored_hash, password);
    }
    
    // Legacy FNV-1a format (for soft migration)
    return verifyLegacyPassword(allocator, stored_hash, password);
}

fn verifyArgon2Password(allocator: std.mem.Allocator, stored_hash: []const u8, password: []const u8) !bool {
    _ = allocator;
    
    // Parse: $argon2id$salt_hex$hash_hex
    const after_prefix = stored_hash[10..]; // Skip "$argon2id$"
    const dollar_pos = std.mem.indexOf(u8, after_prefix, "$") orelse return false;
    
    const salt_hex = after_prefix[0..dollar_pos];
    const hash_hex = after_prefix[dollar_pos + 1 ..];
    
    if (salt_hex.len != 32 or hash_hex.len != 64) return false;
    
    // Parse salt from hex
    var salt: [16]u8 = undefined;
    for (0..16) |i| {
        salt[i] = std.fmt.parseInt(u8, salt_hex[i * 2 .. i * 2 + 2], 16) catch return false;
    }
    
    // Parse expected hash from hex
    var expected_hash: [32]u8 = undefined;
    for (0..32) |i| {
        expected_hash[i] = std.fmt.parseInt(u8, hash_hex[i * 2 .. i * 2 + 2], 16) catch return false;
    }
    
    // Recompute hash with same salt (use page_allocator for KDF internal memory)
    var computed_hash: [32]u8 = undefined;
    std.crypto.pwhash.argon2.kdf(
        std.heap.page_allocator,
        &computed_hash,
        password,
        &salt,
        .{
            .t = ARGON2_T_COST,
            .m = ARGON2_M_COST,
            .p = ARGON2_PARALLELISM,
        },
        .argon2id,
    ) catch return false;
    
    // Constant-time comparison
    return std.crypto.timing_safe.eql([32]u8, computed_hash, expected_hash);
}

fn verifyLegacyPassword(allocator: std.mem.Allocator, stored_hash: []const u8, password: []const u8) !bool {
    // Legacy FNV-1a hash (for migration only)
    // SECURITY: In production, LEGACY_SECRET MUST be set in .env
    const SECRET = blk: {
        if (config.get("LEGACY_SECRET")) |secret| {
            break :blk secret;
        }
        // Check if we're in debug/development mode
        if (std.debug.runtime_safety) {
            // Dev mode: warn but use fallback
            std.debug.print("⚠️ WARNING: LEGACY_SECRET not set! Using default (DEV ONLY)\n", .{});
            break :blk "zig-task-manager-secret-2024";
        }
        // Production mode: fail fast
        @panic("LEGACY_SECRET environment variable is REQUIRED in production. Set it in your .env file.");
    };
    
    var hash: u64 = 14695981039346656037;
    for (password) |byte| {
        hash ^= byte;
        hash *%= 1099511628211;
    }
    for (SECRET) |byte| {
        hash ^= byte;
        hash *%= 1099511628211;
    }
    const computed = try std.fmt.allocPrint(allocator, "{x}", .{hash});
    defer allocator.free(computed);
    return std.mem.eql(u8, stored_hash, computed);
}

/// Check if a hash is in legacy format (needs migration)
pub fn isLegacyHash(stored_hash: []const u8) bool {
    return !std.mem.startsWith(u8, stored_hash, "$argon2id$");
}

/// Generate a secure random token for password reset
/// Returns a 64-character hex string (32 random bytes)
pub fn generateResetToken(allocator: std.mem.Allocator) ![]u8 {
    var random_bytes: [32]u8 = undefined;
    std.crypto.random.bytes(&random_bytes);
    
    const hex_chars = "0123456789abcdef";
    var token: [64]u8 = undefined;
    
    for (random_bytes, 0..) |byte, i| {
        token[i * 2] = hex_chars[byte >> 4];
        token[i * 2 + 1] = hex_chars[byte & 0x0F];
    }
    
    return try allocator.dupe(u8, &token);
}

// Legacy createToken - now wraps generateResetToken for backwards compatibility
// Session tokens are now handled by db.createSession
pub fn createToken(allocator: std.mem.Allocator, user_id: []const u8) ![]u8 {
    _ = user_id; // Not used - token is stored in DB with user association
    return generateResetToken(allocator);
}

pub fn generateVerificationCode(allocator: std.mem.Allocator) ![]u8 {
    const code = std.crypto.random.intRangeAtMost(u32, 100000, 999999);
    return try std.fmt.allocPrint(allocator, "{d}", .{code});
}
