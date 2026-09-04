#!/usr/bin/env bash
# Stamp a content hash onto the asset URLs in public/*.html.
#
# Why this exists: the origin sends `Cache-Control: no-cache` for JS, CSS and
# WASM, because the filenames carry no content hash and a long max-age would
# pin a stale app.js after a deploy. Cloudflare honours that at the edge
# (cf-cache-status: REVALIDATED) but rewrites what the *browser* is told to
# `max-age=14400` — so a returning visitor can run four-hour-old JavaScript
# against a freshly deployed API.
#
# Changing the URL sidesteps browser caching entirely: a deploy that changes
# app.js changes its query string, and the browser fetches it as a new
# resource. The HTML itself is never cached (no-cache, and DYNAMIC at the
# edge), so the new URL is seen immediately.
#
# Idempotent: an existing ?v= stamp is replaced, not appended to.
#
# Run after `zig build` and before restarting the service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/public"

stamp_one() {
    local asset="$1"
    [ -f "$asset" ] || return 0
    local hash
    hash="$(sha256sum "$asset" | cut -c1-8)"

    for html in *.html; do
        [ -f "$html" ] || continue
        # Match the asset with or without a previous stamp.
        sed -i -E "s|(\"/?${asset//./\\.})(\?v=[0-9a-f]+)?\"|\1?v=${hash}\"|g" "$html"
    done
    echo "  ${asset} -> ?v=${hash}"
}

echo "==> Stamping asset URLs"
stamp_one app.js
stamp_one style.css
stamp_one reset-password.js

# app.wasm is fetched by app.js rather than referenced from HTML, so its
# freshness follows app.js: any change to the WASM comes with a rebuild that
# also changes the JS bundle's hash only if the JS changed. Fetch it with the
# same stamp so a WASM-only rebuild is not missed.
if [ -f app.wasm ]; then
    wasm_hash="$(sha256sum app.wasm | cut -c1-8)"
    sed -i -E "s|(fetch\('/app\.wasm)(\?v=[0-9a-f]+)?'|\1?v=${wasm_hash}'|" app.js
    echo "  app.wasm -> ?v=${wasm_hash} (referenced from app.js)"
    # app.js changed, so restamp it.
    stamp_one app.js
fi
