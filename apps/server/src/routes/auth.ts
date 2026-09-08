import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../db.js";
import { mailer } from "../mailer.js";
import { signAccessToken } from "../jwt.js";

const emailSchema = z.object({ email: z.string().email().max(254) });
const verifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
});
const refreshSchema = z.object({ refresh_token: z.string().min(32) });

const CODE_TTL_MIN = 10;
const SESSION_TTL_DAYS = 30;

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function issueTokens(userId: string, deviceName?: string) {
  const refreshToken = crypto.randomUUID() + crypto.randomUUID();
  await sql`
    INSERT INTO sessions (user_id, refresh_token, device_name, expires_at)
    VALUES (${userId}, ${refreshToken}, ${deviceName ?? null}, now() + interval '${SESSION_TTL_DAYS} days')
  `;
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

    // 限频：1 分钟内只允许发一次
    const recent = await sql`
      SELECT 1 FROM auth_codes
      WHERE email = ${email} AND created_at > now() - interval '1 minute'
      LIMIT 1
    `;
    if (recent.length > 0) return c.json({ error: "too frequent", cooldown_sec: 60 }, 429);

    const code = genCode();
    await sql`
      INSERT INTO auth_codes (email, code, expires_at)
      VALUES (${email}, ${code}, now() + interval '${CODE_TTL_MIN} minutes')
    `;
    await mailer.sendCode(email, code);
    return c.json({ cooldown_sec: 60 });
  })

  .post("/verify", async (c) => {
    const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { email, code } = parsed.data;

    const rows = await sql`
      SELECT * FROM auth_codes
      WHERE email = ${email} AND code = ${code} AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1
    `;
    const record = rows[0];
    if (!record || record.attempts >= 5) {
      return c.json({ error: "code invalid or expired" }, 401);
    }

    // 首次登录即注册
    const users = await sql`
      INSERT INTO users (email) VALUES (${email})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;
    const userId = users[0].id as string;
    await sql`DELETE FROM auth_codes WHERE email = ${email}`;

    const tokens = await issueTokens(userId);
    return c.json({ ...tokens, user: { id: userId, email } });
  })

  .post("/refresh", async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { refresh_token } = parsed.data;

    const rows = await sql`
      SELECT user_id FROM sessions
      WHERE refresh_token = ${refresh_token} AND expires_at > now()
    `;
    if (rows.length === 0) return c.json({ error: "session expired" }, 401);
    const userId = rows[0].user_id as string;

    // 轮换：旧 refresh token 一次性失效
    await sql`DELETE FROM sessions WHERE refresh_token = ${refresh_token}`;
    const tokens = await issueTokens(userId);
    return c.json(tokens);
  })

  .post("/logout", async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => null));
    if (parsed.success) {
      await sql`DELETE FROM sessions WHERE refresh_token = ${parsed.data.refresh_token}`;
    }
    return c.body(null, 204);
  });
