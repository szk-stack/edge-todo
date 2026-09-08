import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { verifyPassword } from "../password.js";
import { signAccessToken } from "../jwt.js";

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
const refreshSchema = z.object({ refresh_token: z.string().min(32) });

const SESSION_TTL_MS = 30 * 86_400_000; // 会话 30 天

// ---------- 预编译语句 ----------

const stmtFindUser = db.prepare(`SELECT * FROM users WHERE username = ?`);
const stmtInsertSession = db.prepare(
  `INSERT INTO sessions (id, user_id, refresh_token, device_name, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const stmtFindSession = db.prepare(
  `SELECT user_id FROM sessions WHERE refresh_token = ? AND expires_at > ?`,
);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE refresh_token = ?`);

// ---------- 防爆破：同用户名 1 分钟内最多 5 次失败（内存计数，重启清零） ----------

const attempts = new Map<string, { count: number; windowStart: number }>();
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_MAX = 5;

function tooManyAttempts(username: string): boolean {
  const now = Date.now();
  const rec = attempts.get(username);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) return false;
  return rec.count >= ATTEMPT_MAX;
}
function recordFailure(username: string): void {
  const now = Date.now();
  const rec = attempts.get(username);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) {
    attempts.set(username, { count: 1, windowStart: now });
  } else {
    rec.count += 1;
  }
}

// ---------- 路由 ----------

async function issueTokens(userId: string, deviceName?: string) {
  const refreshToken = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  stmtInsertSession.run(
    crypto.randomUUID(),
    userId,
    refreshToken,
    deviceName ?? null,
    now,
    now + SESSION_TTL_MS,
  );
  return {
    access_token: await signAccessToken(userId),
    refresh_token: refreshToken,
    expires_in: 7200,
  };
}

export const authRoutes = new Hono()
  .post("/login", async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { username, password } = parsed.data;

    if (tooManyAttempts(username)) {
      return c.json({ error: "too many attempts, try later" }, 429);
    }

    const user = stmtFindUser.get(username) as
      | { id: string; username: string; password_hash: string }
      | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFailure(username);
      return c.json({ error: "wrong username or password" }, 401);
    }

    const tokens = await issueTokens(user.id);
    return c.json({ ...tokens, user: { id: user.id, username: user.username } });
  })

  .post("/refresh", async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { refresh_token } = parsed.data;

    const session = stmtFindSession.get(refresh_token, Date.now()) as
      | { user_id: string }
      | undefined;
    if (!session) return c.json({ error: "session expired" }, 401);

    // 轮换：旧 refresh token 一次性失效
    stmtDeleteSession.run(refresh_token);
    const tokens = await issueTokens(session.user_id);
    return c.json(tokens);
  })

  .post("/logout", async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (parsed.success) {
      stmtDeleteSession.run(parsed.data.refresh_token);
    }
    return c.body(null, 204);
  });
