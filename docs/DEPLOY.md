# VPS Deployment Guide

## Prerequisites

- VPS with Ubuntu 22.04+ (or similar)
- Domain name pointed to VPS IP
- SSH access

## 1. Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Zig (check latest version at ziglang.org)
wget https://ziglang.org/download/0.14.0/zig-linux-x86_64-0.14.0.tar.xz
sudo tar -xf zig-linux-x86_64-0.14.0.tar.xz -C /opt/
sudo ln -s /opt/zig-linux-x86_64-0.14.0/zig /usr/local/bin/zig

# Install Docker (for SurrealDB)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

## 2. Deploy SurrealDB

```bash
# Create data directory
sudo mkdir -p /var/lib/surrealdb

# Run SurrealDB container
docker run -d \
  --name surrealdb \
  --restart always \
  -p 127.0.0.1:8000:8000 \
  -v /var/lib/surrealdb:/data \
  surrealdb/surrealdb:latest \
  start --log info --user YOUR_DB_USER --pass YOUR_DB_PASS file:/data/database.db
```

## 3. Deploy Application

```bash
# Clone repository
cd /opt
sudo git clone https://github.com/YOUR_REPO/zig_testing.git taskmanager
cd taskmanager

# Create .env file
sudo nano .env
```

### .env Configuration

```env
# Database
SURREAL_URL = http://127.0.0.1:8000
SURREAL_NS = taskmanager
SURREAL_DB = main
SURREAL_USER = YOUR_DB_USER
SURREAL_PASS = YOUR_DB_PASS

# Email (SMTP)
SMTP_HOST = smtp.yourdomain.com
SMTP_PORT = 587
SMTP_USER = noreply@yourdomain.com
SMTP_PASS = replace-with-a-real-smtp-password
SMTP_FROM = noreply@yourdomain.com
SMTP_FROM_NAME = Task Manager
FROM_EMAIL = noreply@yourdomain.com
FROM_NAME = Task Manager

# App
APP_URL = https://yourdomain.com
CORS_ORIGIN = https://yourdomain.com
```

### Build Application

```bash
sudo zig build -Doptimize=ReleaseSafe
```

## 4. Systemd Service

```bash
sudo nano /etc/systemd/system/taskmanager.service
```

```ini
[Unit]
Description=Zig Task Manager
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/taskmanager
ExecStart=/opt/taskmanager/zig-out/bin/taskmanager
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable taskmanager
sudo systemctl start taskmanager
sudo systemctl status taskmanager
```

## 5. Nginx Reverse Proxy

The production configuration is versioned in `ops/nginx/` rather than written
by hand on the server, so it can be reviewed, diffed and redeployed:

| File | Installs to | Purpose |
| --- | --- | --- |
| `task.micutu.com` | `sites-available/` | The vhost |
| `task-security.conf` | `snippets/` | Security headers, single source of truth |
| `task-rate-limit.conf` | `conf.d/` | `limit_req` / `limit_conn` zones (http level) |

```bash
sudo cp ops/nginx/task-rate-limit.conf /etc/nginx/conf.d/
sudo cp ops/nginx/task-security.conf   /etc/nginx/snippets/
sudo cp ops/nginx/task.micutu.com      /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/task.micutu.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# TLS
sudo certbot --nginx -d task.micutu.com
```

Four things this configuration does that a plain `proxy_pass` does not:

**Only Cloudflare may reach the origin.** DNS points at Cloudflare, but the
server still answers on its own address, so anyone who learns the origin IP can
send `Host: task.micutu.com` directly and skip the WAF, bot management and DDoS
absorption entirely. The vhost returns 403 unless the peer is a Cloudflare edge
(or loopback, for local health checks), using the `$from_cloudflare_origin` map
from `conf.d/cloudflare-origin-guard.conf`.

**The real visitor IP reaches the app.** `conf.d/cloudflare-realip.conf` runs
the real_ip module over Cloudflare's published ranges, so `$remote_addr` is the
visitor rather than the edge before any rate-limit zone or log line sees it.
`proxy_set_header` then overwrites `X-Real-IP` and clears `CF-Connecting-IP`, so
a client cannot supply its own value; the app only trusts these headers from a
peer listed in `TRUST_PROXY`.

**Rate limits survive a deploy.** The app's own limiters live in process memory
and reset on every restart. The nginx zones do not, and they reject a flood
before it reaches a worker thread or opens a database connection.

**One copy of every security header.** The app used to set its own headers while
the shared `snippets/security-headers.conf` set a second, looser copy — two CSPs,
and `X-Frame-Options: DENY` next to `SAMEORIGIN`. `task-security.conf` strips the
upstream copies with `proxy_hide_header` and emits one authoritative set, which
also covers responses the app never produces (502 during a restart, 413, 429).

Static assets are served from disk by nginx with gzip and ETag revalidation;
only `/api/` is proxied to Zig.

## 6. Verify Deployment

```bash
# Check services
sudo systemctl status taskmanager
sudo systemctl status nginx
docker ps | grep surrealdb

# Test endpoints
curl http://127.0.0.1:9000/api/health
curl https://yourdomain.com/api/health
```

## Troubleshooting

### View logs
```bash
sudo journalctl -u taskmanager -f
docker logs surrealdb -f
```

### Restart services
```bash
sudo systemctl restart taskmanager
docker restart surrealdb
```

### Rebuild after code changes
```bash
cd /home/micu/taskmanager
git pull
zig build -Doptimize=ReleaseSafe
./scripts/stamp-assets.sh          # cache-bust the front-end assets
sudo systemctl restart taskmanager
```

`stamp-assets.sh` is not optional. JS, CSS and WASM are served with
`Cache-Control: no-cache` because their filenames carry no content hash;
Cloudflare honours that at the edge and revalidates, but rewrites what the
*browser* is told to `max-age=14400`. Without the stamp, a returning visitor
can run four-hour-old JavaScript against a freshly deployed API. The script
writes a content hash into the asset URLs in `public/*.html`, so a changed
file is a changed URL. It is idempotent — run it as often as you like.
