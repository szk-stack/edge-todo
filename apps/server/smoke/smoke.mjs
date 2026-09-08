/**
 * 服务端冒烟测试：起真实进程 + 真实 SQLite 文件，走完整同步链路。
 * 用法：node smoke/smoke.mjs（在 apps/server 目录下）
 *
 * 覆盖：auth 全流程 → 限频 → push(create) → 幂等重发 → LWW superseded
 *       → 墓碑拒绝复活 → 增量拉取游标 → op_log 历史
 */
import { spawn } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:8799";
const DB = join(root, "data", "smoke-test.db");

let passed = 0;
function ok(cond, name) {
  if (!cond) {
    console.error(`FAIL  ${name}`);
    process.exitCode = 1;
  } else {
    passed++;
    console.log(`ok    ${name}`);
  }
}

const uuid = () => crypto.randomUUID();
const api = async (path, { method = "GET", token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) };
};

// 干净环境
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
mkdirSync(join(root, "data"), { recursive: true });

// 起服务（tsx 直跑 TS）
const nodeExe = process.execPath;
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const srv = spawn(nodeExe, [tsxCli, "src/index.ts"], {
  cwd: root,
  env: { ...process.env, PORT: "8799", DB_PATH: DB, JWT_SECRET: "smoke-test-secret" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
srv.stdout.on("data", (d) => (serverLog += d));
srv.stderr.on("data", (d) => (serverLog += d));

try {
  // 等就绪
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) { up = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("server did not start\n" + serverLog);
  ok(true, "server up / healthz");

  // ---- auth ----
  const email = "Smoke@Test.com"; // 故意混大小写，验证 NOCASE
  const r1 = await api("/api/v1/auth/code", { method: "POST", body: { email } });
  ok(r1.status === 200 && r1.json.cooldown_sec === 60, "auth/code 发送验证码");

  const r2 = await api("/api/v1/auth/code", { method: "POST", body: { email } });
  ok(r2.status === 429, "auth/code 1 分钟内重发被限频");

  const m = serverLog.match(/验证码 → \S+: (\d{6})/);
  if (!m) throw new Error("console mailer 未打印验证码\n" + serverLog);
  const code = m[1];

  const r3 = await api("/api/v1/auth/verify", { method: "POST", body: { email: email.toLowerCase(), code } });
  ok(r3.status === 200 && r3.json.access_token && r3.json.refresh_token, "auth/verify 首次登录即注册（大小写不敏感）");
  const token = r3.json.access_token;
  const refreshToken = r3.json.refresh_token;

  const r4 = await api("/api/v1/tasks", { token: "bad-token" });
  ok(r4.status === 401, "无 token 访问 tasks 被 401");

  // ---- push / pull ----
  const taskId = uuid();
  const t0 = Date.now() - 1000;
  const mkChange = (changeId, op, over = {}) => ({
    changeId, op,
    task: {
      id: taskId, title: "冒烟任务", done: false, doneAt: null,
      sortOrder: 1, updatedAt: t0, deletedAt: null, ...over,
    },
  });

  const c1 = mkChange(uuid(), "create");
  const p1 = await api("/api/v1/tasks/changes", { method: "POST", token, body: { changes: [c1] } });
  ok(p1.status === 200 && p1.json.results[0].status === "applied", "push create → applied");

  const p2 = await api("/api/v1/tasks/changes", { method: "POST", token, body: { changes: [c1] } });
  ok(p2.status === 200 && p2.json.results[0].status === "applied", "同 changeId 重发 → 幂等回放 applied");

  const g1 = await api("/api/v1/tasks?since=0", { token });
  ok(g1.json.tasks.length === 1 && g1.json.tasks[0].title === "冒烟任务", "pull since=0 拿到 1 个任务");
  const seq1 = g1.json.cursor;

  const g2 = await api(`/api/v1/tasks?since=${seq1}`, { token });
  ok(g2.json.tasks.length === 0 && g2.json.hasMore === false, "游标后无增量（重发未产生新 seq）");

  // LWW：旧时间戳的 update 应判负
  const c2 = mkChange(uuid(), "update", { title: "旧更新", updatedAt: t0 - 5000 });
  const p3 = await api("/api/v1/tasks/changes", { method: "POST", token, body: { changes: [c2] } });
  ok(p3.json.results[0].status === "superseded" && p3.json.results[0].serverTask.title === "冒烟任务",
     "LWW：旧 updatedAt 的 update → superseded 并回传权威版本");

  // 新时间戳的 update 应胜出
  const c3 = mkChange(uuid(), "update", { title: "新标题", done: true, doneAt: t0 + 1000, updatedAt: t0 + 1000 });
  const p4 = await api("/api/v1/tasks/changes", { method: "POST", token, body: { changes: [c3] } });
  ok(p4.json.results[0].status === "applied", "LWW：新 updatedAt 的 update → applied");

  // 删除 → 墓碑（真实客户端发 delete 时携带本地行当前快照，故 title 用"新标题"）
  const c4 = mkChange(uuid(), "delete", { title: "新标题", deletedAt: t0 + 2000, updatedAt: t0 + 2000 });
  const p5 = await api("/api/v1/tasks/changes", { method: "POST", token, body: { changes: [c4] } });
  ok(p5.json.results[0].status === "applied", "push delete → applied");

  // 墓碑拒绝复活（用更新的时间戳也没用）
  const c5 = mkChange(uuid(), "create", { title: "复活", updatedAt: t0 + 9999 });
  const p6 = await api("/api/v1/tasks/changes", { method: "POST", token, body: { changes: [c5] } });
  ok(p6.json.results[0].status === "superseded" && p6.json.results[0].serverTask.deletedAt != null,
     "墓碑优先：删除后同 id create → superseded");

  const g3 = await api(`/api/v1/tasks?since=${seq1}`, { token });
  const last = g3.json.tasks[g3.json.tasks.length - 1];
  ok(last.id === taskId && last.deletedAt != null && last.title === "新标题", "增量拉取反映最终态（已删除+新标题）");

  // op_log 历史
  const h1 = await api(`/api/v1/tasks/${taskId}/history`, { token });
  ok(h1.json.entries.length === 3 && h1.json.entries[0].op === "delete",
     "op_log 历史 3 条（create/update/delete），倒序返回");

  // refresh 轮换
  const r5 = await api("/api/v1/auth/refresh", { method: "POST", body: { refresh_token: refreshToken } });
  ok(r5.status === 200 && r5.json.refresh_token !== refreshToken, "refresh 轮换签发新 token");
  const r6 = await api("/api/v1/auth/refresh", { method: "POST", body: { refresh_token: refreshToken } });
  ok(r6.status === 401, "旧 refresh token 一次性失效");

  console.log(`\n${passed} 项通过${process.exitCode ? "（有失败）" : ""}`);
} finally {
  srv.kill();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
}
