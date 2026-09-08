import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { env } from "./env.js";
import { verifyAccessToken } from "./jwt.js";
import { authRoutes } from "./routes/auth.js";
import { taskRoutes } from "./routes/tasks.js";
import { registerWs, unregisterWs } from "./ws.js";

const app = new Hono();

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
