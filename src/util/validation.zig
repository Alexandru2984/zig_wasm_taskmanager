// Input Validation Module
// SECURITY: Validates and sanitizes all user input to prevent injection attacks
const std = @import("std");

/// Validate email format (basic validation)
pub fn validateEmail(email: []const u8) bool {
    if (email.len < 5 or email.len > 254) return false;
    
    // Must contain exactly one @
    var at_count: usize = 0;
    var at_pos: usize = 0;
    for (email, 0..) |c, i| {
        if (c == '@') {
            at_count += 1;
            at_pos = i;
        }
    }
    if (at_count != 1) return false;
    
    // @ can't be first or last
    if (at_pos == 0 or at_pos == email.len - 1) return false;
    
    // Must have a dot after @ (but not immediately after)
    const domain = email[at_pos + 1 ..];
    const dot_pos = std.mem.indexOf(u8, domain, ".") orelse return false;
    if (dot_pos == 0) return false; // Can't be test@.com
    if (dot_pos == domain.len - 1) return false; // Can't end with dot
    
    // No spaces allowed
    if (std.mem.indexOf(u8, email, " ") != null) return false;
    
    return true;
}

/// Validate password strength
pub fn validatePasswordStrength(password: []const u8) PasswordValidationResult {
    var result = PasswordValidationResult{};
    
    if (password.len < 8) {
        result.too_short = true;
    }
    if (password.len > 128) {
        result.too_long = true;
    }
    
    // Check for at least one letter and one number (optional but recommended)
    var has_letter = false;
    var has_number = false;
    for (password) |c| {
        if (std.ascii.isAlphabetic(c)) has_letter = true;
        if (std.ascii.isDigit(c)) has_number = true;
    }
    
    result.weak = !has_letter or !has_number;
    result.valid = !result.too_short and !result.too_long;
    
    return result;
}

pub const PasswordValidationResult = struct {
    valid: bool = true,
    too_short: bool = false,
    too_long: bool = false,
    weak: bool = false,
};

/// Sanitize string for SurrealQL to prevent injection attacks
/// Returns a new allocated string with dangerous characters escaped
pub fn sanitizeForSurrealQL(allocator: std.mem.Allocator, input: []const u8) ![]u8 {
    // Calculate required length
    var extra_len: usize = 0;
    for (input) |c| {
        switch (c) {
            '"', '\\', '\'' => extra_len += 1,
            else => {},
        }
    }
    
    var result = try allocator.alloc(u8, input.len + extra_len);
    var i: usize = 0;
    
    for (input) |c| {
        switch (c) {
            '"' => {
                result[i] = '\\';
                result[i + 1] = '"';
                i += 2;
            },
            '\\' => {
                result[i] = '\\';
                result[i + 1] = '\\';
                i += 2;
            },
            '\'' => {
                result[i] = '\\';
                result[i + 1] = '\'';
                i += 2;
            },
            else => {
                result[i] = c;
                i += 1;
            },
        }
    }
    
    return result[0..i];
}

/// Validate name (no special SQL characters, reasonable length)
pub fn validateName(name: []const u8) bool {
    if (name.len < 1 or name.len > 100) return false;
    
    // Block dangerous characters
    for (name) |c| {
        switch (c) {
            '<', '>', '"', '\'', '\\', ';', '&' => return false,
            else => {},
        }
    }
    
    return true;
}

/// Validate task title
pub fn validateTaskTitle(title: []const u8) bool {
    if (title.len < 1 or title.len > 500) return false;
    return true;
}

// Tests
test "validateEmail" {
    try std.testing.expect(validateEmail("test@example.com"));
    try std.testing.expect(validateEmail("user.name@domain.org"));
    try std.testing.expect(!validateEmail("invalid"));
    try std.testing.expect(!validateEmail("no@dot"));
    try std.testing.expect(!validateEmail("@example.com"));
    try std.testing.expect(!validateEmail("test@.com"));
}

test "validatePasswordStrength" {
    const result1 = validatePasswordStrength("short");
    try std.testing.expect(!result1.valid);
    try std.testing.expect(result1.too_short);
    
    const result2 = validatePasswordStrength("password123");
    try std.testing.expect(result2.valid);
}
