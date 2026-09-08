import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { mailer } from "../mailer.js";
import { signAccessToken } from "../jwt.js";

const emailSchema = z.object({ email: z.string().email().max(254) });
const verifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
});
const refreshSchema = z.object({ refresh_token: z.string().min(32) });

const CODE_TTL_MS = 10 * 60_000; // 验证码 10 分钟有效
const RATE_LIMIT_MS = 60_000; // 限频：1 分钟内只允许发一次
const SESSION_TTL_MS = 30 * 86_400_000; // 会话 30 天

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---------- 预编译语句 ----------

const stmtRecentCode = db.prepare(
  `SELECT 1 FROM auth_codes WHERE email = ? AND created_at > ? LIMIT 1`,
);
const stmtInsertCode = db.prepare(
  `INSERT INTO auth_codes (email, code, expires_at, created_at) VALUES (?, ?, ?, ?)`,
);
const stmtFindCode = db.prepare(
  `SELECT * FROM auth_codes WHERE email = ? AND code = ? AND expires_at > ?
   ORDER BY created_at DESC LIMIT 1`,
);
const stmtDeleteCodes = db.prepare(`DELETE FROM auth_codes WHERE email = ?`);
const stmtUpsertUser = db.prepare(
  `INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)
   ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
   RETURNING id`,
);
const stmtInsertSession = db.prepare(
  `INSERT INTO sessions (id, user_id, refresh_token, device_name, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const stmtFindSession = db.prepare(
  `SELECT user_id FROM sessions WHERE refresh_token = ? AND expires_at > ?`,
);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE refresh_token = ?`);

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
  .post("/code", async (c) => {
    const parsed = emailSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid email" }, 400);
    const { email } = parsed.data;

    const now = Date.now();
    if (stmtRecentCode.get(email, now - RATE_LIMIT_MS)) {
      return c.json({ error: "too frequent", cooldown_sec: 60 }, 429);
    }

    const code = genCode();
    stmtInsertCode.run(email, code, now + CODE_TTL_MS, now);
    await mailer.sendCode(email, code);
    return c.json({ cooldown_sec: 60 });
  })

  .post("/verify", async (c) => {
    const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { email, code } = parsed.data;

    const record = stmtFindCode.get(email, code, Date.now()) as
      | { email: string; code: string; attempts: number }
      | undefined;
    if (!record || record.attempts >= 5) {
      return c.json({ error: "code invalid or expired" }, 401);
    }

    // 首次登录即注册（email 列 COLLATE NOCASE，大小写不敏感）
    const user = stmtUpsertUser.get(crypto.randomUUID(), email, Date.now()) as { id: string };
    stmtDeleteCodes.run(email);

    const tokens = await issueTokens(user.id);
    return c.json({ ...tokens, user: { id: user.id, email } });
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
