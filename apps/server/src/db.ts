import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.js";

// schema 内嵌于此（single source of truth，对应 docs/TECH_DESIGN.md §3.1）
// 约定：时间戳一律 INTEGER 毫秒 epoch；布尔存 INTEGER 0/1；JSON 存 TEXT；
// email 用 COLLATE NOCASE 实现大小写不敏感（等价原 PG 的 CITEXT）
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  email         TEXT NOT NULL COLLATE NOCASE,
  code          TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (email, code)
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  device_name   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- 注意：seq 为同步游标，必须"每次变更都推进"，故不用自增列（ON CONFLICT DO UPDATE
-- 时自增列不变），由写入语句显式分配 MAX(seq)+1（事务内串行，无并发竞争）
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
