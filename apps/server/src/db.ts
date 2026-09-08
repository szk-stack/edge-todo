import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.js";
import { hashPassword } from "./password.js";

// schema 内嵌于此（single source of truth，对应 docs/TECH_DESIGN.md §3.1）
// 约定：时间戳一律 INTEGER 毫秒 epoch；布尔存 INTEGER 0/1；JSON 存 TEXT；
// username 用 COLLATE NOCASE 实现大小写不敏感
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  device_name   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  seq               INTEGER NOT NULL UNIQUE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(title) <= 500),
  done              INTEGER NOT NULL DEFAULT 0,
  done_at           INTEGER,
  sort_order        REAL NOT NULL,
  client_updated_at INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_seq ON tasks(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_user_active ON tasks(user_id) WHERE deleted_at IS NULL;

-- 变更日志（append-only；不参与裁决，用途：历史/撤销/审计）
CREATE TABLE IF NOT EXISTS op_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL,
  change_id   TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oplog_task ON op_log(user_id, task_id, seq);

-- 幂等去重（保留 7 天，服务内定时清理）
CREATE TABLE IF NOT EXISTS processed_changes (
  change_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, change_id)
);
`;

mkdirSync(dirname(env.dbPath), { recursive: true });

export const db = new Database(env.dbPath);
db.pragma("journal_mode = WAL"); // 读写不互斥
db.pragma("foreign_keys = ON"); // SQLite 默认关外键，必须显式打开
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.exec(SCHEMA);

// 初始账号：不存在则创建（用户名/密码可用环境变量覆盖）
const adminExists = db
  .prepare(`SELECT id FROM users WHERE username = ?`)
  .get(env.adminUsername);
if (!adminExists) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), env.adminUsername, hashPassword(env.adminPassword), Date.now());
  console.log(`[seed] 初始账号已创建：${env.adminUsername}`);
}
