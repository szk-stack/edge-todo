import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { env } from "./env.js";
import { db } from "./db.js";
import { verifyAccessToken } from "./jwt.js";
import { authRoutes } from "./routes/auth.js";
import { taskRoutes } from "./routes/tasks.js";
import { registerWs, unregisterWs } from "./ws.js";

const app = new Hono();

// 定期清理：processed_changes 保留 7 天，op_log 保留 90 天
setInterval(() => {
  try {
    const now = Date.now();
    db.prepare(`DELETE FROM processed_changes WHERE created_at < ?`).run(now - 7 * 86_400_000);
    db.prepare(`DELETE FROM op_log WHERE created_at < ?`).run(now - 90 * 86_400_000);
  } catch (err) {
    console.error("cleanup failed:", err);
  }
}, 86_400_000).unref();

app.use("*", cors());
app.get("/healthz", (c) => c.json({ ok: true }));
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/tasks", taskRoutes);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  "/ws",
  upgradeWebSocket(async (c) => {
    const token = c.req.query("token");
    const userId = token ? await verifyAccessToken(token) : null;
    return {
      onOpen(_evt, ws) {
        if (!userId) {
          ws.close(4401, "unauthorized");
          return;
        }
        registerWs(userId, ws);
      },
      onClose(_evt, ws) {
        if (userId) unregisterWs(userId, ws);
      },
    };
  }),
);

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`edge-todo server listening on :${info.port}`);
});
injectWebSocket(server);
