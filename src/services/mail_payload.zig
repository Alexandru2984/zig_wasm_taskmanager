const std = @import("std");
const config = @import("../config/config.zig");
const Aead = std.crypto.aead.chacha_poly.XChaCha20Poly1305;
const context = "taskmanager-mail-outbox-v1";

pub const Payload = struct { kind: []const u8, email: []const u8, name: []const u8, secret: []const u8 };

fn key() ![32]u8 {
    const value = config.get("MAIL_OUTBOX_KEY") orelse return error.MissingMailKey;
    if (value.len != 64) return error.InvalidMailKey;
    var result: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&result, value) catch return error.InvalidMailKey;
    return result;
}

pub fn validateKey() !void {
    _ = try key();
}

/// A non-secret identifier prevents an accidental key replacement from
/// consuming and erasing every queued message as "invalid ciphertext".
pub fn keyFingerprint() ![64]u8 {
    var secret_key = try key();
    defer std.crypto.secureZero(u8, &secret_key);
    var digest: [32]u8 = undefined;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update("taskmanager-mail-key-id-v1");
    hasher.update(&secret_key);
    hasher.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

pub fn seal(a: std.mem.Allocator, payload: Payload) ![]u8 {
    const plain = try std.json.Stringify.valueAlloc(a, payload, .{});
    defer {
        std.crypto.secureZero(u8, plain);
        a.free(plain);
    }
    return sealWithKey(a, plain, try key());
}

fn sealWithKey(a: std.mem.Allocator, plain: []const u8, secret_key: [32]u8) ![]u8 {
    if (plain.len > 16384) return error.MailPayloadTooLarge;
    const envelope = try a.alloc(u8, 40 + plain.len);
    defer a.free(envelope);
    std.crypto.random.bytes(envelope[0..24]);
    Aead.encrypt(envelope[40..], envelope[24..40], plain, context, envelope[0..24].*, secret_key);
    const encoded = try a.alloc(u8, envelope.len * 2);
    const hex = "0123456789abcdef";
    for (envelope, 0..) |byte, i| {
        encoded[i * 2] = hex[byte >> 4];
        encoded[i * 2 + 1] = hex[byte & 15];
    }
    return encoded;
}

pub fn open(a: std.mem.Allocator, encrypted: []const u8) ![]u8 {
    return openWithKey(a, encrypted, try key());
}

fn openWithKey(a: std.mem.Allocator, encrypted: []const u8, secret_key: [32]u8) ![]u8 {
    if (encrypted.len < 80 or encrypted.len > 32848 or encrypted.len % 2 != 0) return error.InvalidMailPayload;
    const envelope = try a.alloc(u8, encrypted.len / 2);
    defer a.free(envelope);
    _ = try std.fmt.hexToBytes(envelope, encrypted);
    const plain = try a.alloc(u8, envelope.len - 40);
    errdefer a.free(plain);
    try Aead.decrypt(plain, envelope[40..], envelope[24..40].*, context, envelope[0..24].*, secret_key);
    return plain;
}

test "mail payload encryption authenticates contents and key" {
    const a = std.testing.allocator;
    const encrypted = try sealWithKey(a, "private fixture token", [_]u8{7} ** 32);
    defer a.free(encrypted);
    const plain = try openWithKey(a, encrypted, [_]u8{7} ** 32);
    defer a.free(plain);
    try std.testing.expectEqualStrings("private fixture token", plain);
    try std.testing.expectError(error.AuthenticationFailed, openWithKey(a, encrypted, [_]u8{8} ** 32));
    encrypted[encrypted.len - 1] = if (encrypted[encrypted.len - 1] == '0') '1' else '0';
    try std.testing.expectError(error.AuthenticationFailed, openWithKey(a, encrypted, [_]u8{7} ** 32));
    try std.testing.expectError(error.InvalidMailPayload, openWithKey(a, "bad", [_]u8{7} ** 32));
}
