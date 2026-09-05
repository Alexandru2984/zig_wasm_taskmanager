// Authentication module for Task Manager
// SECURITY: Uses Argon2id for password hashing (industry standard)
const std = @import("std");
const config = @import("../config/config.zig");
const log = @import("../util/log.zig");

// Argon2id parameters (OWASP recommendations for password hashing).
//
// These are the values used for NEW hashes. They are also written into each
// hash, so they can be changed later without invalidating anything already
// stored — see the note on the hash format below.
const ARGON2_T_COST = 3; // Time cost (iterations)
const ARGON2_M_COST = 65536; // Memory cost (64 MB)
const ARGON2_PARALLELISM = 4; // Parallelism

/// Parameters assumed for a hash written before the format carried them.
/// Every such hash was produced with exactly these values, so verification
/// stays correct; new hashes record their own.
const LEGACY_PARAMS = Argon2Params{ .t = 3, .m = 65536, .p = 4 };

const Argon2Params = struct {
    t: u32,
    m: u32,
    p: u24,
};

// SECURITY: fixed decoy hash used by login when the email is unknown, so that
// response time matches the real-user path and timing can't be used to probe
// which accounts exist. Salt is all zeros / hash value doesn't matter — we only
// care that verifyPassword does the full Argon2 derivation.
const DUMMY_ARGON2_HASH: []const u8 =
    "$argon2id$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";

/// Hash a password using Argon2id with a random salt.
///
/// Returns `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt_hex>$<hash_hex>`.
///
/// The parameters are part of the string. The previous format was
/// `$argon2id$<salt>$<hash>` with the cost baked into the binary, which meant
/// raising or lowering the cost would have silently failed to verify every
/// password already stored — a change nobody could make without forcing a
/// reset for every account. Recording them turns that into an ordinary
/// migration: old hashes keep verifying with the parameters they were made
/// with, and new ones use whatever is configured now.
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
        log.err("Argon2 KDF error: {}", .{err});
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

    return try std.fmt.allocPrint(
        allocator,
        "$argon2id$v=19$m={d},t={d},p={d}${s}${s}",
        .{ ARGON2_M_COST, ARGON2_T_COST, ARGON2_PARALLELISM, salt_hex, hash_hex },
    );
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

/// Read `m=<n>,t=<n>,p=<n>` out of a parameter segment.
fn parseParams(segment: []const u8) ?Argon2Params {
    var m: ?u32 = null;
    var t: ?u32 = null;
    var p: ?u24 = null;

    var it = std.mem.splitScalar(u8, segment, ',');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse return null;
        const key = pair[0..eq];
        const value = pair[eq + 1 ..];
        if (std.mem.eql(u8, key, "m")) {
            m = std.fmt.parseInt(u32, value, 10) catch return null;
        } else if (std.mem.eql(u8, key, "t")) {
            t = std.fmt.parseInt(u32, value, 10) catch return null;
        } else if (std.mem.eql(u8, key, "p")) {
            p = std.fmt.parseInt(u24, value, 10) catch return null;
        } else return null;
    }

    return Argon2Params{ .t = t orelse return null, .m = m orelse return null, .p = p orelse return null };
}

fn verifyArgon2Password(allocator: std.mem.Allocator, stored_hash: []const u8, password: []const u8) !bool {
    _ = allocator;

    // Two shapes: the current one carries its parameters, the older one does
    // not and was always produced with LEGACY_PARAMS.
    //   $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
    //   $argon2id$<salt>$<hash>
    var rest = stored_hash[10..]; // skip "$argon2id$"
    var params = LEGACY_PARAMS;

    if (std.mem.startsWith(u8, rest, "v=")) {
        const after_version = std.mem.indexOfScalar(u8, rest, '$') orelse return false;
        // The version is fixed; a hash claiming another one was not written by
        // this code and must not be verified with these assumptions.
        if (!std.mem.eql(u8, rest[0..after_version], "v=19")) return false;
        rest = rest[after_version + 1 ..];

        const after_params = std.mem.indexOfScalar(u8, rest, '$') orelse return false;
        params = parseParams(rest[0..after_params]) orelse return false;
        rest = rest[after_params + 1 ..];
    }

    const dollar_pos = std.mem.indexOfScalar(u8, rest, '$') orelse return false;
    const salt_hex = rest[0..dollar_pos];
    const hash_hex = rest[dollar_pos + 1 ..];

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
        .{ .t = params.t, .m = params.m, .p = params.p },
        .argon2id,
    ) catch return false;

    // Constant-time comparison
    return std.crypto.timing_safe.eql([32]u8, computed_hash, expected_hash);
}

fn verifyLegacyPassword(allocator: std.mem.Allocator, stored_hash: []const u8, password: []const u8) !bool {
    // Legacy FNV-1a hash kept only for users migrating from pre-Argon2 installs.
    // SECURITY: LEGACY_SECRET has no default. If it is not set, any legacy hash
    // that might still exist simply fails to verify — the user must reset their
    // password. This is safer than silently falling back to a well-known secret.
    const SECRET = config.get("LEGACY_SECRET") orelse {
        log.warn("LEGACY_SECRET not set — legacy hash verification disabled", .{});
        return false;
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
    // SECURITY: constant-time compare — std.mem.eql short-circuits on mismatch
    // and would leak how many leading bytes matched via timing.
    if (stored_hash.len != computed.len) return false;
    var acc: u8 = 0;
    for (stored_hash, computed) |x, y| acc |= x ^ y;
    return acc == 0;
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

/// Equalize login response time when the user doesn't exist. Runs Argon2 over a
/// fixed decoy hash so timing leaks don't distinguish "no such user" from
/// "wrong password". Return value is ignored; only the elapsed time matters.
pub fn burnTime(allocator: std.mem.Allocator, password: []const u8) void {
    _ = verifyPassword(allocator, DUMMY_ARGON2_HASH, password) catch {};
}

// ---------- Tests ----------

test "hashPassword produces a verifiable Argon2id hash" {
    const a = std.testing.allocator;
    const hash = try hashPassword(a, "correct horse battery staple");
    defer a.free(hash);

    try std.testing.expect(std.mem.startsWith(u8, hash, "$argon2id$"));
    try std.testing.expect(!isLegacyHash(hash));
    try std.testing.expect(try verifyPassword(a, hash, "correct horse battery staple"));
    try std.testing.expect(!try verifyPassword(a, hash, "wrong password"));
}

test "a new hash records its parameters" {
    const a = std.testing.allocator;
    const hash = try hashPassword(a, "correct horse battery staple");
    defer a.free(hash);

    try std.testing.expect(std.mem.startsWith(u8, hash, "$argon2id$v=19$m="));
    try std.testing.expect(std.mem.indexOf(u8, hash, ",t=") != null);
    try std.testing.expect(std.mem.indexOf(u8, hash, ",p=") != null);
}

test "a hash written before the format carried parameters still verifies" {
    const a = std.testing.allocator;

    // Built the way the old code did: no parameter segment, and produced with
    // what are now LEGACY_PARAMS. If this ever fails, every account created
    // before the format change can no longer log in.
    var salt: [16]u8 = undefined;
    std.crypto.random.bytes(&salt);
    var derived: [32]u8 = undefined;
    try std.crypto.pwhash.argon2.kdf(
        a,
        &derived,
        "old password 1",
        &salt,
        .{ .t = LEGACY_PARAMS.t, .m = LEGACY_PARAMS.m, .p = LEGACY_PARAMS.p },
        .argon2id,
    );

    const hex = "0123456789abcdef";
    var salt_hex: [32]u8 = undefined;
    var hash_hex: [64]u8 = undefined;
    for (salt, 0..) |b, i| {
        salt_hex[i * 2] = hex[b >> 4];
        salt_hex[i * 2 + 1] = hex[b & 0x0F];
    }
    for (derived, 0..) |b, i| {
        hash_hex[i * 2] = hex[b >> 4];
        hash_hex[i * 2 + 1] = hex[b & 0x0F];
    }

    const legacy = try std.fmt.allocPrint(a, "$argon2id${s}${s}", .{ salt_hex, hash_hex });
    defer a.free(legacy);

    try std.testing.expect(try verifyPassword(a, legacy, "old password 1"));
    try std.testing.expect(!try verifyPassword(a, legacy, "wrong password 1"));
}

test "parseParams reads and rejects" {
    const ok = parseParams("m=65536,t=3,p=4").?;
    try std.testing.expectEqual(@as(u32, 65536), ok.m);
    try std.testing.expectEqual(@as(u32, 3), ok.t);
    try std.testing.expectEqual(@as(u24, 4), ok.p);

    // Missing a field, an unknown field, and a non-numeric value all fail
    // closed rather than silently defaulting.
    try std.testing.expect(parseParams("m=65536,t=3") == null);
    try std.testing.expect(parseParams("m=65536,t=3,p=4,x=1") == null);
    try std.testing.expect(parseParams("m=abc,t=3,p=4") == null);
}

test "a hash claiming an unknown version is refused" {
    const a = std.testing.allocator;
    const forged = "$argon2id$v=99$m=65536,t=3,p=4$" ++ ("0" ** 32) ++ "$" ++ ("0" ** 64);
    try std.testing.expect(!try verifyPassword(a, forged, "anything"));
}

test "isLegacyHash flags non-Argon2 hashes" {
    try std.testing.expect(isLegacyHash("deadbeefcafef00d"));
    try std.testing.expect(!isLegacyHash("$argon2id$abc$def"));
}

test "generateResetToken returns 64 lowercase hex chars" {
    const a = std.testing.allocator;
    const tok = try generateResetToken(a);
    defer a.free(tok);

    try std.testing.expectEqual(@as(usize, 64), tok.len);
    for (tok) |c| {
        try std.testing.expect((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f'));
    }
}
