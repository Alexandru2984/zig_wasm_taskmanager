// Test script for config parser
const std = @import("std");
const config = @import("config.zig");

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    
    std.debug.print("\n=== Testing Config Parser ===\n\n", .{});
    
    // Load .env
    config.load(allocator) catch |err| {
        std.debug.print("❌ Failed to load .env: {}\n", .{err});
        return;
    };
    
    // Test all expected keys
    const keys = [_][]const u8{
        "SURREAL_URL",
        "SURREAL_NS", 
        "SURREAL_DB",
        "SURREAL_USER",
        "SURREAL_PASS",
        "API_KEY",
        "BREVO_API_KEY",
        "SEND_FROM",
        "FROM_EMAIL",
        "FROM_NAME",
        "CORS_ORIGIN",
    };
    
    for (keys) |key| {
        if (config.get(key)) |value| {
            // Mask sensitive values
            if (std.mem.indexOf(u8, key, "KEY") != null or 
                std.mem.indexOf(u8, key, "PASS") != null) {
                std.debug.print("{s} = {s}...***\n", .{key, value[0..@min(8, value.len)]});
            } else {
                std.debug.print("{s} = {s}\n", .{key, value});
            }
        } else {
            std.debug.print("{s} = (not found)\n", .{key});
        }
    }
    
    std.debug.print("\n✅ Parser test complete!\n", .{});
}
