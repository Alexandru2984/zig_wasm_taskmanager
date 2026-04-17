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

# Email (Brevo)
BREVO_API_KEY = your-brevo-api-key
SENDER_EMAIL = noreply@yourdomain.com
SENDER_NAME = Task Manager

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

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
sudo nano /etc/nginx/sites-available/taskmanager
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/taskmanager /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com
```

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
cd /opt/taskmanager
sudo git pull
sudo zig build -Doptimize=ReleaseSafe
sudo systemctl restart taskmanager
```
