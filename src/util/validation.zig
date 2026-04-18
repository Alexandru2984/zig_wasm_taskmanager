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
    // SECURITY: `weak` is now load-bearing — previously computed and ignored,
    // which let users sign up with passwords like "aaaaaaaa".
    result.valid = !result.too_short and !result.too_long and !result.weak;

    return result;
}

pub const PasswordValidationResult = struct {
    valid: bool = true,
    too_short: bool = false,
    too_long: bool = false,
    weak: bool = false,
};

/// Validate name (no special SQL characters, reasonable length)
pub fn validateName(name: []const u8) bool {
    if (name.len < 1 or name.len > 100) return false;
    
    // Block dangerous characters. `&` is legitimate in names ("Tom & Jerry"),
    // output escaping is the consumer's job.
    for (name) |c| {
        switch (c) {
            '<', '>', '"', '\'', '\\', ';' => return false,
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

/// Validate an ISO-8601-ish datetime string the frontend is allowed to send.
/// Accepts "YYYY-MM-DDTHH:MM", "YYYY-MM-DDTHH:MM:SS" and their Z-terminated
/// forms. Rejects anything else so arbitrary user strings can't reach the DB.
pub fn validateDueDate(value: []const u8) bool {
    // Minimum: "YYYY-MM-DDTHH:MM" = 16 chars. Maximum with :SSZ = 20 chars.
    if (value.len < 16 or value.len > 20) return false;

    const digit = std.ascii.isDigit;
    // Positional check: YYYY-MM-DDTHH:MM
    if (!digit(value[0]) or !digit(value[1]) or !digit(value[2]) or !digit(value[3])) return false;
    if (value[4] != '-') return false;
    if (!digit(value[5]) or !digit(value[6])) return false;
    if (value[7] != '-') return false;
    if (!digit(value[8]) or !digit(value[9])) return false;
    if (value[10] != 'T') return false;
    if (!digit(value[11]) or !digit(value[12])) return false;
    if (value[13] != ':') return false;
    if (!digit(value[14]) or !digit(value[15])) return false;

    // Optional :SS (positions 16,17,18 if present)
    var idx: usize = 16;
    if (idx < value.len and value[idx] == ':') {
        if (idx + 2 >= value.len) return false;
        if (!digit(value[idx + 1]) or !digit(value[idx + 2])) return false;
        idx += 3;
    }

    // Optional trailing Z
    if (idx < value.len) {
        if (value[idx] != 'Z' or idx + 1 != value.len) return false;
    }

    // Basic range sanity. Parses are guaranteed to succeed because of the
    // digit checks above.
    const month = std.fmt.parseInt(u8, value[5..7], 10) catch return false;
    const day = std.fmt.parseInt(u8, value[8..10], 10) catch return false;
    const hour = std.fmt.parseInt(u8, value[11..13], 10) catch return false;
    const minute = std.fmt.parseInt(u8, value[14..16], 10) catch return false;
    if (month < 1 or month > 12) return false;
    if (day < 1 or day > 31) return false;
    if (hour > 23) return false;
    if (minute > 59) return false;

    return true;
}

test "validateDueDate" {
    try std.testing.expect(validateDueDate("2025-12-25T12:00"));
    try std.testing.expect(validateDueDate("2025-12-25T12:00:30"));
    try std.testing.expect(validateDueDate("2025-12-25T12:00:30Z"));
    try std.testing.expect(validateDueDate("2025-12-25T12:00Z"));
    try std.testing.expect(!validateDueDate("2025-13-25T12:00"));
    try std.testing.expect(!validateDueDate("not-a-date"));
    try std.testing.expect(!validateDueDate(""));
    try std.testing.expect(!validateDueDate("2025-12-25T25:00"));
    try std.testing.expect(!validateDueDate("2025-12-25T12:60"));
    try std.testing.expect(!validateDueDate("2025/12/25T12:00"));
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

    // Weak: letters only, no digit
    const result3 = validatePasswordStrength("aaaaaaaa");
    try std.testing.expect(!result3.valid);
    try std.testing.expect(result3.weak);

    // Weak: digits only, no letter
    const result4 = validatePasswordStrength("12345678");
    try std.testing.expect(!result4.valid);
    try std.testing.expect(result4.weak);
}
