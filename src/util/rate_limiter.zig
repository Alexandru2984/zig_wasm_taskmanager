// Rate Limiter Module
// SECURITY: Prevents brute-force attacks on auth endpoints
// Uses sliding window counter per IP

const std = @import("std");

/// Rate limit configuration
pub const RateLimitConfig = struct {
    max_requests: u32 = 5,        // Max requests per window
    window_seconds: u64 = 60,     // Window size in seconds
};

/// Rate limiter state for a single IP
const IpState = struct {
    count: u32,
    window_start: i64,
};

/// Thread-safe rate limiter using HashMap
pub const RateLimiter = struct {
    map: std.StringHashMap(IpState),
    config: RateLimitConfig,
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex,

    pub fn init(allocator: std.mem.Allocator, config: RateLimitConfig) RateLimiter {
        return .{
            .map = std.StringHashMap(IpState).init(allocator),
            .config = config,
            .allocator = allocator,
            .mutex = .{},
        };
    }

    pub fn deinit(self: *RateLimiter) void {
        // Free all keys
        var it = self.map.keyIterator();
        while (it.next()) |key| {
            self.allocator.free(key.*);
        }
        self.map.deinit();
    }

    /// Check if request is allowed for this IP
    /// Returns true if allowed, false if rate limited
    pub fn isAllowed(self: *RateLimiter, ip: []const u8) bool {
        self.mutex.lock();
        defer self.mutex.unlock();

        const now = std.time.timestamp();
        const window_size: i64 = @intCast(self.config.window_seconds);

        if (self.map.get(ip)) |state| {
            // Check if we're in a new window
            if (now - state.window_start >= window_size) {
                // New window - reset
                self.map.put(ip, .{ .count = 1, .window_start = now }) catch return true;
                return true;
            }

            // Same window - check count
            if (state.count >= self.config.max_requests) {
                return false; // Rate limited!
            }

            // Increment count
            self.map.put(ip, .{ .count = state.count + 1, .window_start = state.window_start }) catch return true;
            return true;
        } else {
            // New IP - add to map
            const ip_copy = self.allocator.dupe(u8, ip) catch return true;
            self.map.put(ip_copy, .{ .count = 1, .window_start = now }) catch {
                self.allocator.free(ip_copy);
                return true;
            };
            return true;
        }
    }

    /// Get remaining requests for an IP
    pub fn getRemaining(self: *RateLimiter, ip: []const u8) u32 {
        self.mutex.lock();
        defer self.mutex.unlock();

        const now = std.time.timestamp();
        const window_size: i64 = @intCast(self.config.window_seconds);

        if (self.map.get(ip)) |state| {
            if (now - state.window_start >= window_size) {
                return self.config.max_requests;
            }
            if (state.count >= self.config.max_requests) {
                return 0;
            }
            return self.config.max_requests - state.count;
        }
        return self.config.max_requests;
    }

    /// Clean up old entries (call periodically)
    pub fn cleanup(self: *RateLimiter) void {
        self.mutex.lock();
        defer self.mutex.unlock();

        const now = std.time.timestamp();
        const window_size: i64 = @intCast(self.config.window_seconds);
        const expiry_threshold = now - (window_size * 2); // Keep for 2x window

        var to_remove = std.ArrayListUnmanaged([]const u8){};
        defer to_remove.deinit(self.allocator);

        var it = self.map.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.window_start < expiry_threshold) {
                to_remove.append(self.allocator, entry.key_ptr.*) catch continue;
            }
        }

        for (to_remove.items) |key| {
            _ = self.map.remove(key);
            self.allocator.free(key);
        }
    }
};

// Global rate limiters for different endpoints
pub var login_limiter: ?RateLimiter = null;
pub var signup_limiter: ?RateLimiter = null;
pub var forgot_password_limiter: ?RateLimiter = null;

/// Initialize all rate limiters
pub fn initAll(allocator: std.mem.Allocator) void {
    // Login: 5 attempts per minute
    login_limiter = RateLimiter.init(allocator, .{ .max_requests = 5, .window_seconds = 60 });
    
    // Signup: 3 per minute (prevent account enumeration)
    signup_limiter = RateLimiter.init(allocator, .{ .max_requests = 3, .window_seconds = 60 });
    
    // Forgot password: 3 per minute
    forgot_password_limiter = RateLimiter.init(allocator, .{ .max_requests = 3, .window_seconds = 60 });
    
    std.debug.print("✅ Rate limiters initialized\n", .{});
}

/// Cleanup all rate limiters
pub fn cleanupAll() void {
    if (login_limiter) |*l| l.cleanup();
    if (signup_limiter) |*l| l.cleanup();
    if (forgot_password_limiter) |*l| l.cleanup();
}

var cleanup_thread: ?std.Thread = null;
var cleanup_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(false);

fn cleanupLoop() void {
    while (cleanup_running.load(.acquire)) {
        // Sleep for 60 seconds (check every minute)
        // We sleep in small chunks to allow faster shutdown
        var i: usize = 0;
        while (i < 60 and cleanup_running.load(.acquire)) : (i += 1) {
            std.Thread.sleep(1 * std.time.ns_per_s);
        }
        
        if (cleanup_running.load(.acquire)) {
            cleanupAll();
        }
    }
}

pub fn startCleanupThread() !void {
    if (cleanup_thread != null) return;
    
    cleanup_running.store(true, .release);
    cleanup_thread = try std.Thread.spawn(.{}, cleanupLoop, .{});
    std.debug.print("✅ Rate limiter cleanup thread started\n", .{});
}

pub fn stopCleanupThread() void {
    if (cleanup_thread) |thread| {
        cleanup_running.store(false, .release);
        thread.join();
        cleanup_thread = null;
        std.debug.print("🛑 Rate limiter cleanup thread stopped\n", .{});
    }
}

/// Cleanup all rate limiters
pub fn deinitAll() void {
    stopCleanupThread();

    if (login_limiter) |*l| l.deinit();
    if (signup_limiter) |*l| l.deinit();
    if (forgot_password_limiter) |*l| l.deinit();
    
    login_limiter = null;
    signup_limiter = null;
    forgot_password_limiter = null;
}
