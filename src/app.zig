// Application State - central container for all app resources
// Eliminates global mutable state and provides clear ownership
const std = @import("std");
const config = @import("config/config.zig");

// Global GPA - must be at module level to have stable address
var gpa: std.heap.GeneralPurposeAllocator(.{}) = .{};

// App start time
pub var start_time: i64 = 0;

/// Get the application allocator (GPA-backed)
pub fn allocator() std.mem.Allocator {
    return gpa.allocator();
}

/// Initialize application - load config
pub fn init() !void {
    start_time = std.time.timestamp();
    const alloc = allocator();
    
    // Load config
    config.load(alloc) catch |err| {
        std.debug.print("⚠️ Config load failed: {} - using defaults\n", .{err});
    };
    
    std.debug.print("✅ AppState initialized with GPA\n", .{});
}

/// Create a request-scoped arena allocator
/// Caller must call arena.deinit() when request is complete
pub fn createRequestArena() std.heap.ArenaAllocator {
    return std.heap.ArenaAllocator.init(allocator());
}

/// Clean shutdown - release all resources and check for leaks
pub fn deinit() void {
    // Deinit config
    config.deinit();

    // Check for leaks
    const check = gpa.deinit();
    if (check == .leak) {
        std.debug.print("⚠️ Memory leak detected!\n", .{});
    } else {
        std.debug.print("✅ Clean shutdown - no leaks\n", .{});
    }
}

/// Check if config was loaded successfully
pub fn isConfigLoaded() bool {
    return config.isLoaded();
}
