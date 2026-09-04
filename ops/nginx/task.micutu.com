# task.micutu.com — Zig Task Manager
# Deploy: sudo cp ops/nginx/task.micutu.com /etc/nginx/sites-available/
#         sudo nginx -t && sudo systemctl reload nginx
#
# Upstream is the taskmanager systemd unit on 127.0.0.1:9000.
# Static assets are served from disk by nginx; only /api/ reaches the Zig app.

server {
    include snippets/block-dotfiles.conf;
    server_name task.micutu.com;

    # ACME must stay reachable regardless of how the request arrived, so it is
    # declared before the Cloudflare origin guard below and is exempt from it.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
        try_files $uri =404;
    }

    # ---- Cloudflare origin guard -------------------------------------------
    # DNS points at Cloudflare, but the origin also answers on its own address:
    # anyone who learns the server IP can send `Host: task.micutu.com` straight
    # here and skip the edge entirely — no WAF, no bot management, no DDoS
    # absorption, and no CF-Connecting-IP, which means the request is also
    # invisible to the per-visitor rate-limit zones.
    #
    # $from_cloudflare_origin is defined in conf.d/cloudflare-origin-guard.conf
    # and keys off $realip_remote_addr, the peer address captured BEFORE the
    # real_ip module rewrites $remote_addr. Loopback is included in that set so
    # local health checks and smoke tests still work.
    set $task_origin_allowed $from_cloudflare_origin;
    if ($task_origin_allowed = 0) {
        return 403;
    }

    # The app rejects any JSON body over 64 KiB. Enforce the same ceiling here
    # so an oversized upload is refused at the edge instead of being buffered
    # to disk and proxied only to be thrown away.
    client_max_body_size 64k;
    client_body_timeout  15s;
    client_header_timeout 15s;

    limit_conn task_conn 32;

    # nginx.conf enables gzip but leaves gzip_types and gzip_proxied commented,
    # so only text/html was ever compressed and proxied responses not at all.
    # style.css and app.js are ~25 KB each of highly compressible text.
    gzip              on;
    gzip_vary         on;
    gzip_proxied      any;
    gzip_comp_level   6;
    gzip_min_length   512;
    gzip_types        text/plain text/css application/javascript application/json
                      image/svg+xml application/manifest+json application/wasm;

    # ---- API ---------------------------------------------------------------
    location /api/ {
        limit_req zone=task_api burst=60 nodelay;

        include snippets/task-security.conf;

        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The app trusts X-Real-IP from a TRUST_PROXY peer. Both headers are
        # overwritten above, so a client cannot smuggle its own value, but
        # clear the Cloudflare header too: nothing downstream reads it and an
        # unset header cannot be trusted by mistake later.
        proxy_set_header CF-Connecting-IP  "";

        proxy_connect_timeout 5s;
        proxy_read_timeout    30s;
    }

    # Auth endpoints get a tighter bucket than the rest of the API.
    location ~ ^/api/auth/(login|signup|forgot-password|reset-password|resend-verification|verify)$ {
        limit_req zone=task_auth burst=10 nodelay;

        include snippets/task-security.conf;

        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP  "";

        proxy_connect_timeout 5s;
        proxy_read_timeout    30s;
    }

    # ---- Static ------------------------------------------------------------
    # Served straight off disk: sendfile, ETag/If-None-Match revalidation and
    # gzip, none of which the app does. It read every file into a per-request
    # arena and called realpath() twice per hit.
    root /home/micu/taskmanager/public;
    index index.html;

    # No content hashing in asset filenames yet, so a long max-age would pin
    # a stale app.js after a deploy. no-cache still allows a conditional
    # request and a 304 with an empty body — nearly the same saving, with none
    # of the staleness.
    location ~* \.(?:js|css|wasm|webmanifest)$ {
        include snippets/task-security.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri @app;
    }

    location ~* \.(?:svg|png|jpg|jpeg|ico|woff2)$ {
        include snippets/task-security.conf;
        add_header Cache-Control "public, max-age=604800" always;
        try_files $uri @app;
    }

    # `=404`, not a fallback to /index.html. There is no client-side router
    # here, so an SPA-style fallback would answer every unknown URL with 200 and
    # the full app shell — soft 404s, which search engines index as duplicates
    # of the home page and which hide typos from monitoring.
    location / {
        include snippets/task-security.conf;
        add_header Cache-Control "no-cache, must-revalidate" always;
        try_files $uri $uri/ =404;
    }

    error_page 404 /404.html;
    location = /404.html {
        include snippets/task-security.conf;
        internal;
    }

    # Anything not on disk falls through to the app, so adding a route in Zig
    # does not require touching nginx.
    location @app {
        include snippets/task-security.conf;

        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP  "";
    }

    include snippets/robots.conf;

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/task.micutu.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/task.micutu.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    include snippets/block-dotfiles.conf;
    listen 80;
    server_name task.micutu.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
