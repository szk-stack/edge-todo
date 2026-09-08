import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { verifyAccessToken } from "../jwt.js";
import { notifyUser } from "../ws.js";

// ---------- 类型与序列化 ----------
// SQLite 行：时间戳为毫秒 INTEGER，done 为 0/1

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  done: number;
  done_at: number | null;
  sort_order: number;
  client_updated_at: number;
  deleted_at: number | null;
  seq: number;
}

function toServerTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    done: row.done !== 0,
    doneAt: row.done_at,
    sortOrder: row.sort_order,
    updatedAt: row.client_updated_at,
    deletedAt: row.deleted_at,
    seq: row.seq,
  };
}

// ---------- 校验 ----------

const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(500),
  done: z.boolean(),
  doneAt: z.number().nullable(),
  sortOrder: z.number().finite(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
});

const changeSchema = z.object({
  changeId: z.string().uuid(),
  op: z.enum(["create", "update", "delete"]),
  task: taskSchema,
});

const pushSchema = z.object({
  changes: z.array(changeSchema).min(1).max(100),
});

type ChangeInput = z.infer<typeof changeSchema>;

// ---------- 鉴权中间件 ----------

type AppEnv = { Variables: { userId: string } };

async function authed(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("authorization");
  const token = header?.replace(/^Bearer\s+/i, "");
  const userId = token ? await verifyAccessToken(token) : null;
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", userId);
  await next();
}

// ---------- 预编译语句 ----------

const stmtPull = db.prepare(
  `SELECT * FROM tasks WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
);
const stmtSeenChange = db.prepare(
  `SELECT result FROM processed_changes WHERE user_id = ? AND change_id = ?`,
);
const stmtGetTask = db.prepare(`SELECT * FROM tasks WHERE user_id = ? AND id = ?`);
const stmtUpsertTask = db.prepare(
  // seq 显式分配 MAX+1：INSERT 与 UPDATE 两种路径都推进游标，增量拉取才能看到更新
  `INSERT INTO tasks (seq, id, user_id, title, done, done_at, sort_order, client_updated_at, deleted_at)
   VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (id) DO UPDATE SET
     title = EXCLUDED.title,
     done = EXCLUDED.done,
     done_at = EXCLUDED.done_at,
     sort_order = EXCLUDED.sort_order,
     client_updated_at = EXCLUDED.client_updated_at,
     deleted_at = EXCLUDED.deleted_at,
     seq = EXCLUDED.seq
   RETURNING *`,
);
const stmtInsertOp = db.prepare(
  `INSERT INTO op_log (user_id, task_id, change_id, op, payload, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const stmtMarkProcessed = db.prepare(
  `INSERT INTO processed_changes (change_id, user_id, result, created_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT DO NOTHING`,
);
const stmtHistory = db.prepare(
  `SELECT seq, op, payload, created_at FROM op_log
   WHERE user_id = ? AND task_id = ? ORDER BY seq DESC LIMIT ?`,
);

// ---------- 路由 ----------

type ChangeResultJson =
  | { changeId: string; status: "applied" }
  | { changeId: string; status: "superseded"; serverTask: ReturnType<typeof toServerTask> };

export const taskRoutes = new Hono<AppEnv>()
  .use("*", authed)

  // 增量拉取：GET /tasks?since=<cursor>&limit=500
  .get("/", async (c) => {
    const userId = c.get("userId");
    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500), 1), 1000);

    const rows = stmtPull.all(userId, since, limit + 1) as TaskRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const cursor = page.length > 0 ? page[page.length - 1].seq : since;
    return c.json({ tasks: page.map(toServerTask), cursor, hasMore });
  })

  // 批量幂等推送：POST /tasks/changes
  .post("/changes", async (c) => {
    const userId = c.get("userId");
    const parsed = pushSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const results: ChangeResultJson[] = [];
    let maxSeq = 0;

    // BEGIN IMMEDIATE 直接拿写锁；better-sqlite3 同步执行，事务内裁决逻辑与 PG 版逐行等价
    const applyAll = db.transaction((changes: ChangeInput[]) => {
      for (const ch of changes) {
        // 幂等：changeId 已处理过则直接回放结果
        const seen = stmtSeenChange.get(userId, ch.changeId) as
          | { result: string }
          | undefined;
        if (seen) {
          results.push(JSON.parse(seen.result) as ChangeResultJson);
          continue;
        }

        const existing = stmtGetTask.get(userId, ch.task.id) as TaskRow | undefined;

        let result: ChangeResultJson;
        if (existing && existing.deleted_at != null) {
          // 墓碑优先：拒绝复活
          result = { changeId: ch.changeId, status: "superseded", serverTask: toServerTask(existing) };
        } else if (
          !existing ||
          ch.op === "delete" ||
          ch.task.updatedAt >= existing.client_updated_at
        ) {
          const deletedAt =
            ch.op === "delete" ? (ch.task.deletedAt ?? Date.now()) : ch.task.deletedAt;
          const row = stmtUpsertTask.get(
            ch.task.id,
            userId,
            ch.task.title,
            ch.task.done ? 1 : 0,
            ch.task.doneAt,
            ch.task.sortOrder,
            ch.task.updatedAt,
            deletedAt,
          ) as TaskRow;
          maxSeq = Math.max(maxSeq, row.seq);

          // op_log：同事务追加变更快照
          stmtInsertOp.run(
            userId,
            ch.task.id,
            ch.changeId,
            ch.op,
            JSON.stringify(toServerTask(row)),
            Date.now(),
          );
          result = { changeId: ch.changeId, status: "applied" };
        } else {
          // LWW 判负：回传服务端权威版本
          result = { changeId: ch.changeId, status: "superseded", serverTask: toServerTask(existing) };
        }

        stmtMarkProcessed.run(ch.changeId, userId, JSON.stringify(result), Date.now());
        results.push(result);
      }
    });
    applyAll.immediate(parsed.data.changes);

    // 事务提交后广播变更信号
    if (maxSeq > 0) notifyUser(userId, maxSeq);
    return c.json({ results });
  })

  // 任务历史（op_log）
  .get("/:id/history", async (c) => {
    const userId = c.get("userId");
    const taskId = c.req.param("id");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    const rows = stmtHistory.all(userId, taskId, limit) as {
      seq: number;
      op: string;
      payload: string;
      created_at: number;
    }[];
    return c.json({
      entries: rows.map((r) => ({
        seq: r.seq,
        op: r.op,
        payload: JSON.parse(r.payload),
        createdAt: r.created_at,
      })),
    });
  });
