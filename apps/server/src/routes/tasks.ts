import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import { sql } from "../db.js";
import { verifyAccessToken } from "../jwt.js";
import { notifyUser } from "../ws.js";

// ---------- 类型与序列化 ----------

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  done: boolean;
  done_at: Date | null;
  sort_order: number;
  client_updated_at: Date;
  deleted_at: Date | null;
  seq: string | number;
}

function toServerTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    doneAt: row.done_at ? row.done_at.getTime() : null,
    sortOrder: row.sort_order,
    updatedAt: row.client_updated_at.getTime(),
    deletedAt: row.deleted_at ? row.deleted_at.getTime() : null,
    seq: Number(row.seq),
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

    const rows = (await sql`
      SELECT * FROM tasks
      WHERE user_id = ${userId} AND seq > ${since}
      ORDER BY seq ASC
      LIMIT ${limit + 1}
    `) as TaskRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const cursor = page.length > 0 ? Number(page[page.length - 1].seq) : since;
    return c.json({ tasks: page.map(toServerTask), cursor, hasMore });
  })

  // 批量幂等推送：POST /tasks/changes
  .post("/changes", async (c) => {
    const userId = c.get("userId");
    const parsed = pushSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const results: ChangeResultJson[] = [];
    let maxSeq = 0;

    await sql.begin(async (tx) => {
      for (const ch of parsed.data.changes) {
        // 幂等：changeId 已处理过则直接回放结果
        const seen = await tx`
          SELECT result FROM processed_changes
          WHERE user_id = ${userId} AND change_id = ${ch.changeId}
        `;
        if (seen.length > 0) {
          results.push(seen[0].result as ChangeResultJson);
          continue;
        }

        const existingRows = (await tx`
          SELECT * FROM tasks
          WHERE user_id = ${userId} AND id = ${ch.task.id}
          FOR UPDATE
        `) as TaskRow[];
        const existing = existingRows[0];

        let result: ChangeResultJson;
        if (existing?.deleted_at != null) {
          // 墓碑优先：拒绝复活
          result = { changeId: ch.changeId, status: "superseded", serverTask: toServerTask(existing) };
        } else if (
          !existing ||
          ch.op === "delete" ||
          new Date(ch.task.updatedAt).getTime() >= existing.client_updated_at.getTime()
        ) {
          const deletedAt =
            ch.op === "delete"
              ? new Date(ch.task.deletedAt ?? Date.now())
              : ch.task.deletedAt != null
                ? new Date(ch.task.deletedAt)
                : null;
          const applied = (await tx`
            INSERT INTO tasks (id, user_id, title, done, done_at, sort_order, client_updated_at, deleted_at)
            VALUES (
              ${ch.task.id}, ${userId}, ${ch.task.title}, ${ch.task.done},
              ${ch.task.doneAt != null ? new Date(ch.task.doneAt) : null},
              ${ch.task.sortOrder}, ${new Date(ch.task.updatedAt)}, ${deletedAt}
            )
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              done = EXCLUDED.done,
              done_at = EXCLUDED.done_at,
              sort_order = EXCLUDED.sort_order,
              client_updated_at = EXCLUDED.client_updated_at,
              deleted_at = EXCLUDED.deleted_at
            RETURNING *
          `) as TaskRow[];
          const row = applied[0];
          maxSeq = Math.max(maxSeq, Number(row.seq));

          // op_log：同事务追加变更快照
          await tx`
            INSERT INTO op_log (user_id, task_id, change_id, op, payload)
            VALUES (${userId}, ${ch.task.id}, ${ch.changeId}, ${ch.op}, ${tx.json(toServerTask(row))})
          `;
          result = { changeId: ch.changeId, status: "applied" };
        } else {
          // LWW 判负：回传服务端权威版本
          result = { changeId: ch.changeId, status: "superseded", serverTask: toServerTask(existing) };
        }

        await tx`
          INSERT INTO processed_changes (change_id, user_id, result)
          VALUES (${ch.changeId}, ${userId}, ${tx.json(result)})
          ON CONFLICT DO NOTHING
        `;
        results.push(result);
      }
    });

    // 事务提交后广播变更信号
    if (maxSeq > 0) notifyUser(userId, maxSeq);
    return c.json({ results });
  })

  // 任务历史（op_log）
  .get("/:id/history", async (c) => {
    const userId = c.get("userId");
    const taskId = c.req.param("id");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    const rows = await sql`
      SELECT seq, op, payload, created_at FROM op_log
      WHERE user_id = ${userId} AND task_id = ${taskId}
      ORDER BY seq DESC LIMIT ${limit}
    `;
    return c.json({ entries: rows });
  });
