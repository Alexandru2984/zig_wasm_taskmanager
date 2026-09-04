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

/// Passwords that satisfy "8+ characters, a letter and a digit" while being
/// among the first things any credential-stuffing list tries. The composition
/// rule alone accepted every one of these.
///
/// This is a deliberately short list, not a breach corpus: it costs one linear
/// scan and removes the passwords that actually show up in automated attacks.
/// A real deployment should check against Have I Been Pwned's range API, which
/// needs an outbound request per signup and is left as a follow-up.
const COMMON_PASSWORDS = [_][]const u8{
    "password",   "password1",  "password12", "password123",   "password1234",
    "passw0rd",   "p@ssword",   "p@ssw0rd",   "qwerty123",     "qwerty1234",
    "qwertyui",   "1qaz2wsx",   "1q2w3e4r",   "1q2w3e4r5t",    "zaq12wsx",
    "abc12345",   "abcd1234",   "a1b2c3d4",   "12345678",      "123456789",
    "1234567890", "11111111",   "00000000",   "iloveyou1",     "letmein1",
    "welcome1",   "welcome123", "admin123",   "administrator", "football1",
    "baseball1",  "monkey123",  "dragon123",  "sunshine1",     "princess1",
    "trustno1",   "master123",  "shadow123",  "superman1",     "batman123",
    "michael1",   "jordan23",   "starwars1",  "computer1",     "internet1",
    "samsung1",   "changeme1",  "secret123",  "test1234",      "demo1234",
};

fn isCommonPassword(password: []const u8) bool {
    for (COMMON_PASSWORDS) |common| {
        if (password.len != common.len) continue;
        var same = true;
        for (password, common) |a, b| {
            if (std.ascii.toLower(a) != b) {
                same = false;
                break;
            }
        }
        if (same) return true;
    }
    return false;
}

/// True when the password is a single character repeated, or a straight
/// ascending/descending run ("abcdefgh", "87654321"). Both pass a naive
/// letter-and-digit check when padded, and both are trivially guessable.
fn isTrivialSequence(password: []const u8) bool {
    if (password.len < 2) return true;

    var all_same = true;
    for (password[1..]) |c| {
        if (c != password[0]) {
            all_same = false;
            break;
        }
    }
    if (all_same) return true;

    var ascending = true;
    var descending = true;
    for (password[1..], 0..) |c, i| {
        const prev = password[i];
        if (c != prev +% 1) ascending = false;
        if (c != prev -% 1) descending = false;
    }
    return ascending or descending;
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

    // SECURITY: composition rules are a poor proxy for guessability.
    // "password1" satisfies every one of them and is among the first guesses
    // any credential-stuffing run makes, so reject the obvious cases outright.
    if (!result.too_short and !result.too_long) {
        result.common = isCommonPassword(password) or isTrivialSequence(password);
    }

    result.valid = !result.too_short and !result.too_long and !result.weak and !result.common;

    return result;
}

pub const PasswordValidationResult = struct {
    valid: bool = true,
    too_short: bool = false,
    too_long: bool = false,
    weak: bool = false,
    common: bool = false,
};

/// Validate name (reasonable length, no markup).
///
/// The apostrophe used to be rejected here as an "SQL metacharacter", which
/// locked out every O'Brien, D'Angelo and N'Diaye. It was never load-bearing:
/// values reach SurrealDB through the escaping bind helper, and they reach the
/// browser through textContent. Rejecting a letter that belongs in real names
/// bought nothing and broke signup for people whose names contain it.
///
/// `<` and `>` stay rejected — not because the app would render them, but
/// because a name is also interpolated into the HTML confirmation email, and
/// keeping markup out at the door is cheaper than auditing every consumer.
pub fn validateName(name: []const u8) bool {
    if (name.len < 1 or name.len > 100) return false;

    for (name) |c| {
        switch (c) {
            '<', '>' => return false,
            // Control bytes have no place in a display name and would break
            // the email headers the name is interpolated into.
            0x00...0x1F, 0x7F => return false,
            else => {},
        }
    }

    return true;
}

/// Lowercase an email for storage and lookup.
///
/// The domain part of an address is case-insensitive by definition, and every
/// mail provider anyone actually uses treats the local part that way too.
/// Storing the raw casing meant `Alice@example.com` and `alice@example.com`
/// were two different rows as far as the UNIQUE index was concerned: a second
/// account could be registered for the same mailbox, and a login with the
/// "wrong" capitalisation would fail against an account that plainly exists.
///
/// Caller owns the returned slice.
pub fn normalizeEmail(allocator: std.mem.Allocator, email: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, email.len);
    for (email, 0..) |c, i| out[i] = std.ascii.toLower(c);
    return out;
}

/// Validate task title
pub fn validateTaskTitle(title: []const u8) bool {
    if (title.len < 1 or title.len > 500) return false;
    return true;
}

pub fn validateWorkspaceName(name: []const u8) bool {
    if (name.len < 1 or name.len > 120) return false;
    for (name) |c| {
        switch (c) {
            '<', '>' => return false,
            0x00...0x1F, 0x7F => return false,
            else => {},
        }
    }
    return true;
}

pub fn validateWorkspaceInviteRole(role: []const u8) bool {
    return std.mem.eql(u8, role, "admin") or
        std.mem.eql(u8, role, "member") or
        std.mem.eql(u8, role, "viewer");
}

pub fn validateTaskPriority(priority: []const u8) bool {
    return std.mem.eql(u8, priority, "low") or
        std.mem.eql(u8, priority, "normal") or
        std.mem.eql(u8, priority, "high");
}

pub fn validateHexToken64(token: []const u8) bool {
    if (token.len != 64) return false;
    for (token) |c| {
        const is_hex = (c >= '0' and c <= '9') or
            (c >= 'a' and c <= 'f') or
            (c >= 'A' and c <= 'F');
        if (!is_hex) return false;
    }
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

/// Days since the Unix epoch for a civil date. Howard Hinnant's days_from_civil,
/// which is exact for any proleptic Gregorian date and needs no leap-year
/// special cases at the call site.
fn daysFromCivil(y: i64, m: i64, d: i64) i64 {
    const y_adj = y - @as(i64, if (m <= 2) 1 else 0);
    const era = @divFloor(if (y_adj >= 0) y_adj else y_adj - 399, 400);
    const yoe = y_adj - era * 400;
    const mp = @mod(m + 9, 12);
    const doy = @divTrunc(153 * mp + 2, 5) + d - 1;
    const doe = yoe * 365 + @divTrunc(yoe, 4) - @divTrunc(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

/// Unix timestamp for a due date already accepted by validateDueDate.
/// The value is treated as UTC, matching how it is stored.
pub fn dueDateToTimestamp(value: []const u8) ?i64 {
    if (!validateDueDate(value)) return null;
    const year = std.fmt.parseInt(i64, value[0..4], 10) catch return null;
    const month = std.fmt.parseInt(i64, value[5..7], 10) catch return null;
    const day = std.fmt.parseInt(i64, value[8..10], 10) catch return null;
    const hour = std.fmt.parseInt(i64, value[11..13], 10) catch return null;
    const minute = std.fmt.parseInt(i64, value[14..16], 10) catch return null;
    return daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60;
}

/// The database asserts due_date >= created_at, so a past date is refused at
/// the storage layer. Catching it here turns what was an opaque write failure
/// into a message that says what to change.
///
/// The allowance is generous on purpose: a client's clock can differ from the
/// server's, and "now" moves between the user picking a time and the request
/// arriving.
pub fn isDueDateInPast(value: []const u8, now: i64) bool {
    const ts = dueDateToTimestamp(value) orelse return false;
    return ts < now - 300;
}

test "dueDateToTimestamp matches known epochs" {
    // 1970-01-01T00:00 is the epoch itself.
    try std.testing.expectEqual(@as(?i64, 0), dueDateToTimestamp("1970-01-01T00:00"));
    // 2000-03-01T00:00 — just past a leap day in a leap century.
    try std.testing.expectEqual(@as(?i64, 951868800), dueDateToTimestamp("2000-03-01T00:00"));
    try std.testing.expectEqual(@as(?i64, 1735689600), dueDateToTimestamp("2025-01-01T00:00Z"));
    try std.testing.expectEqual(@as(?i64, null), dueDateToTimestamp("not-a-date"));
}

test "isDueDateInPast tolerates small clock skew" {
    const now: i64 = 1735689600; // 2025-01-01T00:00Z
    try std.testing.expect(isDueDateInPast("2024-12-31T00:00Z", now));
    try std.testing.expect(!isDueDateInPast("2025-06-01T00:00Z", now));
    // Inside the 5-minute allowance, so not treated as past.
    try std.testing.expect(!isDueDateInPast("2024-12-31T23:58Z", now));
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

    // "password123" used to pass here: it satisfies length, a letter and a
    // digit. It is also one of the most-guessed passwords in existence, and is
    // now rejected by the common-password check.
    const result2 = validatePasswordStrength("password123");
    try std.testing.expect(!result2.valid);
    try std.testing.expect(result2.common);

    const result2b = validatePasswordStrength("marmalade7bridge");
    try std.testing.expect(result2b.valid);

    // Weak: letters only, no digit
    const result3 = validatePasswordStrength("aaaaaaaa");
    try std.testing.expect(!result3.valid);
    try std.testing.expect(result3.weak);

    // Weak: digits only, no letter
    const result4 = validatePasswordStrength("12345678");
    try std.testing.expect(!result4.valid);
    try std.testing.expect(result4.weak);
}

test "validateHexToken64" {
    try std.testing.expect(validateHexToken64("a" ** 64));
    try std.testing.expect(validateHexToken64("0123456789abcdef" ** 4));
    try std.testing.expect(!validateHexToken64("a" ** 63)); // too short
    try std.testing.expect(!validateHexToken64("g" ** 64)); // non-hex char
}

test "validateName accepts real names and rejects markup" {
    try std.testing.expect(validateName("Jane Doe"));
    try std.testing.expect(validateName("Tom & Jerry"));
    // Apostrophes and hyphens belong in names and must not be rejected.
    try std.testing.expect(validateName("O'Brien"));
    try std.testing.expect(validateName("N'Diaye"));
    try std.testing.expect(validateName("Anne-Marie"));
    try std.testing.expect(validateName("Ștefan Ionuț"));
    try std.testing.expect(!validateName(""));
    try std.testing.expect(!validateName("<script>"));
    try std.testing.expect(!validateName("a\nb"));
}

test "normalizeEmail lowercases the whole address" {
    const a = std.testing.allocator;
    const out = try normalizeEmail(a, "Alice.Smith@Example.COM");
    defer a.free(out);
    try std.testing.expectEqualStrings("alice.smith@example.com", out);
}

test "validatePasswordStrength rejects common and trivial passwords" {
    // Passes the letter+digit rule but is a top credential-stuffing guess.
    const common = validatePasswordStrength("password1");
    try std.testing.expect(!common.valid);
    try std.testing.expect(common.common);

    // Case-insensitive, so capitalising does not evade the list.
    try std.testing.expect(!validatePasswordStrength("Password1").valid);
    try std.testing.expect(!validatePasswordStrength("qwerty123").valid);

    // Straight runs and single repeated characters.
    try std.testing.expect(!validatePasswordStrength("abcdefgh").valid);
    try std.testing.expect(!validatePasswordStrength("87654321").valid);

    // A password that is none of the above still passes.
    try std.testing.expect(validatePasswordStrength("tr0ubad0ur-horse").valid);
}

test "role and priority validators are allow-lists" {
    try std.testing.expect(validateTaskPriority("low"));
    try std.testing.expect(validateTaskPriority("high"));
    try std.testing.expect(!validateTaskPriority("urgent"));

    try std.testing.expect(validateWorkspaceInviteRole("member"));
    try std.testing.expect(validateWorkspaceInviteRole("viewer"));
    // "owner" must not be assignable via an invite.
    try std.testing.expect(!validateWorkspaceInviteRole("owner"));
}
