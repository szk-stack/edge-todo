# Edge Todo 服务端部署指南（小内存 Linux 服务器）

目标形态：**单个 Node 进程 + 一个 SQLite 文件**，无 Docker、无独立数据库进程。
预期内存占用：**< 100MB**（Node 运行时 + 应用，SQLite 内嵌）。

```
公网 → nginx（TLS 终止 + WS 反代）→ 127.0.0.1:8787（node，systemd 托管）→ /var/lib/edgetodo/edgetodo.db
                                                                        ↘ cron 每日 .backup + gzip，保留 14 天
```

## 前置条件

- Node.js ≥ 22（推荐用 [nvm](https://github.com/nvm-sh/nvm) 或发行版仓库安装）
- nginx 或 caddy（已跑别的服务的话共用即可）
- `sqlite3` CLI（备份脚本用，几乎所有发行版自带或 `apt install sqlite3`）

## 部署步骤

```bash
# 1. 专用用户与目录
sudo useradd -r -s /usr/sbin/nologin edgetodo
sudo mkdir -p /opt/edgetodo/server /var/lib/edgetodo
sudo chown edgetodo:edgetodo /var/lib/edgetodo

# 2. 拷贝代码并构建（在本机或 CI 构建后 rsync 上来也行）
git clone https://github.com/szk-stack/edge-todo.git /tmp/edge-todo
cd /tmp/edge-todo
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @edgetodo/server build
sudo cp -r apps/server/dist apps/server/node_modules /opt/edgetodo/server/
# better-sqlite3 是原生模块：若服务器架构/ libc 与构建机不同，
# 需在服务器上重新 pnpm install（x64 glibc 有预编译包，通常无需编译）

# 3. 配置
sudo cp apps/server/.env.example /opt/edgetodo/server/.env
sudoedit /opt/edgetodo/server/.env   # 必须改 JWT_SECRET（openssl rand -hex 32）
sudo chown -R edgetodo:edgetodo /opt/edgetodo/server

# 4. systemd
sudo cp deploy/edgetodo-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now edgetodo-server
systemctl status edgetodo-server     # 确认 active
curl http://127.0.0.1:8787/healthz   # {"ok":true}

# 5. nginx 反代 + HTTPS
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/edgetodo
sudoedit /etc/nginx/sites-available/edgetodo   # 改 server_name
sudo ln -s /etc/nginx/sites-available/edgetodo /etc/nginx/sites-enabled/
sudo certbot --nginx -d todo.example.com
sudo nginx -t && sudo systemctl reload nginx

# 6. 每日备份
sudo cp deploy/backup.sh /opt/edgetodo/ && sudo chmod +x /opt/edgetodo/backup.sh
sudo crontab -e
# 加入：0 3 * * * DB_PATH=/var/lib/edgetodo/edgetodo.db /opt/edgetodo/backup.sh >> /var/log/edgetodo-backup.log 2>&1
```

## 升级

```bash
cd /tmp/edge-todo && git pull
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @edgetodo/server build
sudo cp -r apps/server/dist /opt/edgetodo/server/
sudo systemctl restart edgetodo-server
```

schema 变更随服务启动自动应用（`CREATE ... IF NOT EXISTS`），无需手动迁移。

## 恢复备份

```bash
sudo systemctl stop edgetodo-server
gunzip -k /var/backups/edgetodo/edgetodo-YYYYMMDD-HHMMSS.db.gz
sudo cp edgetodo-YYYYMMDD-HHMMSS.db /var/lib/edgetodo/edgetodo.db
sudo chown edgetodo:edgetodo /var/lib/edgetodo/edgetodo.db
sudo systemctl start edgetodo-server
```

## 回退到 PostgreSQL 版

PG 版完整保留在仓库的 `postgres` 分支（含 docker-compose.yml 与 Dockerfile），
`git checkout postgres -- apps/server` 即可取回。
