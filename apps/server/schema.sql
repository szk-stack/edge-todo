-- Edge Todo 数据库结构（对应 docs/TECH_DESIGN.md §3.1）
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_codes (
  email         CITEXT NOT NULL,
  code          CHAR(6) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      SMALLINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (email, code)
);

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  device_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                UUID PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (char_length(title) <= 500),
  done              BOOLEAN NOT NULL DEFAULT false,
  done_at           TIMESTAMPTZ,
  sort_order        DOUBLE PRECISION NOT NULL,
  client_updated_at TIMESTAMPTZ NOT NULL,
  deleted_at        TIMESTAMPTZ,
  seq               BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_seq ON tasks(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_user_active ON tasks(user_id) WHERE deleted_at IS NULL;

-- 变更日志（append-only；不参与裁决，用途：历史/撤销/审计）
CREATE TABLE IF NOT EXISTS op_log (
  seq         BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL,
  change_id   UUID NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oplog_task ON op_log(user_id, task_id, seq);

-- 幂等去重（保留 7 天，定时清理）
CREATE TABLE IF NOT EXISTS processed_changes (
  change_id   UUID NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, change_id)
);
