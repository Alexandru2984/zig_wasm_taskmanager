// Email module for Task Manager.
// Sends mail through the local mailcow SMTP server with curl.

const std = @import("std");
const config = @import("../config/config.zig");

const MAX_RETRIES: u8 = 3;
const RETRY_DELAYS_MS = [_]u64{ 1000, 2000, 5000 };

const EmailConfig = struct {
    smtp_host: []const u8,
    smtp_port: []const u8,
    smtp_user: []const u8,
    smtp_pass: []const u8,
    from_email: []const u8,
    from_name: []const u8,
};

/// Render an email like "alice@example.com" as "a***e@example.com" for logs.
fn maskEmail(buf: []u8, email: []const u8) []const u8 {
    const at = std.mem.indexOfScalar(u8, email, '@') orelse {
        const n = @min(buf.len, 3);
        @memset(buf[0..n], '*');
        return buf[0..n];
    };
    const local = email[0..at];
    const domain = email[at..];

    var i: usize = 0;
    if (local.len > 0 and i < buf.len) {
        buf[i] = local[0];
        i += 1;
    }
    const stars: usize = if (local.len > 2) 3 else 1;
    var s: usize = 0;
    while (s < stars and i < buf.len) : (s += 1) {
        buf[i] = '*';
        i += 1;
    }
    if (local.len > 1 and i < buf.len) {
        buf[i] = local[local.len - 1];
        i += 1;
    }
    const copy_len = @min(domain.len, buf.len - i);
    @memcpy(buf[i .. i + copy_len], domain[0..copy_len]);
    return buf[0 .. i + copy_len];
}

fn getEmailConfig() !EmailConfig {
    const smtp_user = config.get("SMTP_USER") orelse {
        std.debug.print("Missing SMTP_USER in .env\n", .{});
        return error.MissingEmailConfig;
    };
    const smtp_pass = config.get("SMTP_PASS") orelse {
        std.debug.print("Missing SMTP_PASS in .env\n", .{});
        return error.MissingEmailConfig;
    };

    return .{
        .smtp_host = config.getOrDefault("SMTP_HOST", "mail.micutu.com"),
        .smtp_port = config.getOrDefault("SMTP_PORT", "587"),
        .smtp_user = smtp_user,
        .smtp_pass = smtp_pass,
        .from_email = config.get("SMTP_FROM") orelse config.get("FROM_EMAIL") orelse smtp_user,
        .from_name = config.get("SMTP_FROM_NAME") orelse config.getOrDefault("FROM_NAME", "Task Manager"),
    };
}

fn rejectHeaderValue(value: []const u8) !void {
    for (value) |c| {
        switch (c) {
            '\r', '\n', 0 => return error.InvalidEmailHeader,
            else => {},
        }
    }
}

fn rejectAddress(value: []const u8) !void {
    try rejectHeaderValue(value);
    if (value.len < 5 or value.len > 254) return error.InvalidEmailAddress;
    if (std.mem.indexOfScalar(u8, value, '@') == null) return error.InvalidEmailAddress;
    for (value) |c| {
        switch (c) {
            ' ', '\t', '<', '>', '"', '\'', '\\', ',', ';' => return error.InvalidEmailAddress,
            else => {},
        }
    }
}

fn appendQuotedHeaderValue(out: *std.ArrayListUnmanaged(u8), allocator: std.mem.Allocator, value: []const u8) !void {
    try out.append(allocator, '"');
    for (value) |c| {
        switch (c) {
            '\r', '\n', 0 => return error.InvalidEmailHeader,
            '"', '\\' => {
                try out.append(allocator, '\\');
                try out.append(allocator, c);
            },
            0x01...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F => {},
            else => try out.append(allocator, c),
        }
    }
    try out.append(allocator, '"');
}

fn appendAddressHeader(
    out: *std.ArrayListUnmanaged(u8),
    allocator: std.mem.Allocator,
    name: []const u8,
    email: []const u8,
) !void {
    try rejectAddress(email);
    if (name.len > 0) {
        try appendQuotedHeaderValue(out, allocator, name);
        try out.appendSlice(allocator, " ");
    }
    try out.append(allocator, '<');
    try out.appendSlice(allocator, email);
    try out.append(allocator, '>');
}

fn buildMimeMessage(
    allocator: std.mem.Allocator,
    email_cfg: EmailConfig,
    to_email: []const u8,
    to_name: []const u8,
    subject: []const u8,
    content_type: []const u8,
    body: []const u8,
) ![]u8 {
    try rejectHeaderValue(subject);
    try rejectHeaderValue(content_type);

    var out = std.ArrayListUnmanaged(u8){};
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "From: ");
    try appendAddressHeader(&out, allocator, email_cfg.from_name, email_cfg.from_email);
    try out.appendSlice(allocator, "\r\nTo: ");
    try appendAddressHeader(&out, allocator, to_name, to_email);
    try out.appendSlice(allocator, "\r\nSubject: ");
    try out.appendSlice(allocator, subject);
    try out.appendSlice(allocator, "\r\nMIME-Version: 1.0\r\nContent-Type: ");
    try out.appendSlice(allocator, content_type);
    try out.appendSlice(allocator, "; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n");
    try out.appendSlice(allocator, body);
    try out.appendSlice(allocator, "\r\n");

    return try out.toOwnedSlice(allocator);
}

fn randomHex(buf: []u8) void {
    var bytes: [16]u8 = undefined;
    std.crypto.random.bytes(&bytes);
    const hex = "0123456789abcdef";
    for (bytes, 0..) |b, i| {
        buf[i * 2] = hex[b >> 4];
        buf[i * 2 + 1] = hex[b & 0x0F];
    }
}

fn makeTempPath(allocator: std.mem.Allocator, suffix: []const u8) ![]u8 {
    var hex: [32]u8 = undefined;
    randomHex(&hex);
    return try std.fmt.allocPrint(allocator, "/tmp/taskmanager-email-{s}.{s}", .{ hex[0..], suffix });
}

fn writePrivateFile(path: []const u8, content: []const u8) !void {
    const file = try std.fs.createFileAbsolute(path, .{ .exclusive = true, .mode = 0o600 });
    defer file.close();
    try file.writeAll(content);
}

fn appendCurlConfigLine(
    out: *std.ArrayListUnmanaged(u8),
    allocator: std.mem.Allocator,
    key: []const u8,
    value: []const u8,
) !void {
    try out.appendSlice(allocator, key);
    try out.appendSlice(allocator, " = \"");
    for (value) |c| {
        switch (c) {
            '\r', '\n', 0 => return error.InvalidCurlConfig,
            '"', '\\' => {
                try out.append(allocator, '\\');
                try out.append(allocator, c);
            },
            else => try out.append(allocator, c),
        }
    }
    try out.appendSlice(allocator, "\"\n");
}

fn buildCurlConfig(
    allocator: std.mem.Allocator,
    email_cfg: EmailConfig,
    payload_path: []const u8,
    to_email: []const u8,
) ![]u8 {
    var out = std.ArrayListUnmanaged(u8){};
    errdefer out.deinit(allocator);

    const smtp_url = try std.fmt.allocPrint(allocator, "smtp://{s}:{s}", .{ email_cfg.smtp_host, email_cfg.smtp_port });
    defer allocator.free(smtp_url);
    const smtp_auth = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ email_cfg.smtp_user, email_cfg.smtp_pass });
    defer allocator.free(smtp_auth);

    try appendCurlConfigLine(&out, allocator, "url", smtp_url);
    try out.appendSlice(allocator, "ssl-reqd\n");
    try appendCurlConfigLine(&out, allocator, "user", smtp_auth);
    try appendCurlConfigLine(&out, allocator, "mail-from", email_cfg.from_email);
    try appendCurlConfigLine(&out, allocator, "mail-rcpt", to_email);
    try appendCurlConfigLine(&out, allocator, "upload-file", payload_path);
    try out.appendSlice(allocator, "silent\nshow-error\nfail\n");
    try out.appendSlice(allocator, "max-time = 30\n");

    return try out.toOwnedSlice(allocator);
}

fn runCurlSend(allocator: std.mem.Allocator, curl_config_path: []const u8) !void {
    const result = try std.process.Child.run(.{
        .allocator = allocator,
        .argv = &.{ "/usr/bin/curl", "--config", curl_config_path },
        .max_output_bytes = 4096,
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    switch (result.term) {
        .Exited => |code| {
            if (code == 0) return;
            const preview_len = @min(result.stderr.len, 300);
            std.debug.print("SMTP curl failed with exit {d}: {s}\n", .{ code, result.stderr[0..preview_len] });
            return error.EmailSendFailed;
        },
        else => {
            std.debug.print("SMTP curl terminated unexpectedly\n", .{});
            return error.EmailSendFailed;
        },
    }
}

fn sendEmailRequest(
    allocator: std.mem.Allocator,
    email_cfg: EmailConfig,
    to_email: []const u8,
    payload: []const u8,
) !void {
    const payload_path = try makeTempPath(allocator, "eml");
    defer allocator.free(payload_path);
    defer std.fs.deleteFileAbsolute(payload_path) catch {};

    const config_path = try makeTempPath(allocator, "curlrc");
    defer allocator.free(config_path);
    defer std.fs.deleteFileAbsolute(config_path) catch {};

    try writePrivateFile(payload_path, payload);
    const curl_cfg = try buildCurlConfig(allocator, email_cfg, payload_path, to_email);
    defer allocator.free(curl_cfg);
    try writePrivateFile(config_path, curl_cfg);

    var last_error: ?anyerror = null;
    var attempt: u8 = 0;
    while (attempt < MAX_RETRIES) : (attempt += 1) {
        runCurlSend(allocator, config_path) catch |err| {
            last_error = err;
            std.debug.print("Email attempt {d}/{d} failed: {}\n", .{ attempt + 1, MAX_RETRIES, err });
            if (attempt < MAX_RETRIES - 1) {
                std.Thread.sleep(RETRY_DELAYS_MS[attempt] * std.time.ns_per_ms);
            }
            continue;
        };
        return;
    }

    return last_error orelse error.EmailSendFailed;
}

pub fn sendConfirmationEmail(allocator: std.mem.Allocator, to_email: []const u8, name: []const u8, code: []const u8) !void {
    const subject = "Your Verification Code - Task Manager";

    const html_body = try std.fmt.allocPrint(allocator,
        \\<!DOCTYPE html>
        \\<html>
        \\<head>
        \\  <meta charset="UTF-8">
        \\  <meta name="viewport" content="width=device-width, initial-scale=1.0">
        \\</head>
        \\<body style="margin:0;padding:0;font-family:'Segoe UI',Roboto,Arial,sans-serif;background-color:#1a1a2e;">
        \\  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a2e;padding:40px 20px;">
        \\    <tr>
        \\      <td align="center">
        \\        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:500px;background:#16213e;border-radius:16px;overflow:hidden;">
        \\          <tr>
        \\            <td style="background:#f7931a;padding:30px;text-align:center;">
        \\              <h1 style="margin:0;color:#fff;font-size:24px;font-weight:700;">Task Manager</h1>
        \\            </td>
        \\          </tr>
        \\          <tr>
        \\            <td style="padding:40px 30px;">
        \\              <h2 style="margin:0 0 20px;color:#fff;font-size:20px;">Hello {s}</h2>
        \\              <p style="margin:0 0 25px;color:#a0aec0;font-size:16px;line-height:1.6;">Please use the verification code below to activate your account:</p>
        \\              <div style="background:#0d1117;border:2px solid #f7931a;border-radius:12px;padding:25px;text-align:center;margin:25px 0;">
        \\                <span style="font-family:monospace;font-size:32px;font-weight:700;color:#f7931a;letter-spacing:8px;">{s}</span>
        \\              </div>
        \\              <p style="margin:25px 0 0;color:#718096;font-size:14px;line-height:1.5;">This code will expire in 10 minutes. If you did not create an account, you can safely ignore this email.</p>
        \\            </td>
        \\          </tr>
        \\        </table>
        \\      </td>
        \\    </tr>
        \\  </table>
        \\</body>
        \\</html>
    , .{ name, code });
    defer allocator.free(html_body);

    try sendHtmlEmail(allocator, to_email, name, subject, html_body);
}

pub fn sendPasswordResetEmail(allocator: std.mem.Allocator, to_email: []const u8, token: []const u8) !void {
    const base_url = config.get("APP_BASE_URL") orelse {
        std.debug.print("APP_BASE_URL not set; refusing to send reset email with broken link\n", .{});
        return error.MissingAppBaseUrl;
    };
    const trimmed = std.mem.trimRight(u8, base_url, "/");
    const reset_link = try std.fmt.allocPrint(allocator, "{s}/reset-password.html?token={s}", .{ trimmed, token });
    defer allocator.free(reset_link);

    const subject = "Reset your password - Task Manager";
    const body = try std.fmt.allocPrint(allocator,
        \\Hello,
        \\
        \\You requested a password reset for your Task Manager account.
        \\
        \\Click the link below to reset your password:
        \\{s}
        \\
        \\This link will expire in 1 hour.
        \\
        \\If you did not request this, please ignore this email.
        \\
        \\Best regards,
        \\Task Manager
    , .{reset_link});
    defer allocator.free(body);

    try sendEmail(allocator, to_email, "", subject, body);
}

fn sendEmail(allocator: std.mem.Allocator, to_email: []const u8, to_name: []const u8, subject: []const u8, text_content: []const u8) !void {
    const email_cfg = try getEmailConfig();

    var mask_buf: [128]u8 = undefined;
    std.debug.print("Sending email to: {s} via SMTP\n", .{maskEmail(&mask_buf, to_email)});

    const payload = try buildMimeMessage(allocator, email_cfg, to_email, to_name, subject, "text/plain", text_content);
    defer allocator.free(payload);

    try sendEmailRequest(allocator, email_cfg, to_email, payload);
    std.debug.print("Email sent successfully to: {s}\n", .{maskEmail(&mask_buf, to_email)});
}

fn sendHtmlEmail(allocator: std.mem.Allocator, to_email: []const u8, to_name: []const u8, subject: []const u8, html_content: []const u8) !void {
    const email_cfg = try getEmailConfig();

    var mask_buf: [128]u8 = undefined;
    std.debug.print("Sending HTML email to: {s} via SMTP\n", .{maskEmail(&mask_buf, to_email)});

    const payload = try buildMimeMessage(allocator, email_cfg, to_email, to_name, subject, "text/html", html_content);
    defer allocator.free(payload);

    try sendEmailRequest(allocator, email_cfg, to_email, payload);
    std.debug.print("HTML email sent successfully to: {s}\n", .{maskEmail(&mask_buf, to_email)});
}
