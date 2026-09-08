# 技术方案 — 极简待办（三端云同步）

- 版本：v0.1（对应 PRD v0.1）
- 日期：2026-09-07
- 技术路线：Web 优先 + Tauri 桌面 + 原生安卓 + 自建轻后端

---

## 1. 总体架构

```
┌────────────────────────────────────────────────┐
│         云端（单 VPS，裸机单进程，无 Docker）       │
│  Hono API (REST+WS) ── SQLite 内嵌 ── nginx      │
└───────┬──────────────┬──────────────┬──────────┘
        │ HTTPS/WS     │ HTTPS/WS     │ HTTPS/WS
┌───────▼─────┐ ┌──────▼──────┐ ┌─────▼───────────┐
│ 网页端 PWA   │ │ Windows 端   │ │ 安卓端           │
│ Svelte+Vite │ │ Tauri 2      │ │ Kotlin Compose  │
│ Dexie(IDB)  │ │ WebView+SQLite│ │ Room           │
└─────────────┘ └─────────────┘ └────┬────────────┘
                                     │ 共享 Room 数据层
                              ┌──────▼──────┐
                              │ AppWidget    │
                              │ (RemoteViews)│
                              └─────────────┘
```

**核心原则：本地优先（Local-first）**。每端本地数据库是唯一真相源，UI 只读写本地库，同步引擎在后台独立运行。任何网络状态下 UI 响应路径不经过网络。

## 2. 技术栈清单

| 层 | 选型 | 备注 |
|---|---|---|
| Web 前端 | Svelte 5 + Vite + TypeScript | 体积小、响应式语法适合极简 UI |
| Web 本地存储 | Dexie 4（IndexedDB） | 事务、索引、observable 查询 |
| PWA | vite-plugin-pwa | Workbox 预缓存，离线可用 |
| Windows 端 | Tauri 2 + 同一套 Web 前端 | Rust 侧实现贴边交互 |
| 桌面本地存储 | SQLite（tauri-plugin-sql） | 与 Web 共用同一套同步逻辑（TS 侧），仅存储适配层不同 |
| 安卓端 | Kotlin + Jetpack Compose + Room | Material 3 / Material You |
| 安卓后台 | WorkManager + DataStore | 同步调度、配置存储 |
| 安卓组件 | AppWidgetProvider + RemoteViewsService | 标准小部件 |
| 后端 | Node 22 + Hono + postgres.js + zod + jose | 轻量、TypeScript 全栈类型复用 |
| 数据库 | PostgreSQL 16 | — |
| 实时推送 | WebSocket（Hono ws） | 仅推"有变更"通知，不走数据 |
| 部署 | 单 VPS + docker-compose（app/postgres/caddy） | Caddy 自动 HTTPS |

## 3. 数据模型

### 3.1 服务端（SQLite 内嵌，schema 以 `apps/server/src/db.ts` 内嵌定义为准）

约定：时间戳一律 `INTEGER` 毫秒 epoch；布尔存 `INTEGER` 0/1；JSON 存 `TEXT`；
email 用 `COLLATE NOCASE` 实现大小写不敏感。

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,        -- 应用层生成 UUID
  email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
  created_at    INTEGER NOT NULL
);

-- 邮箱验证码
CREATE TABLE auth_codes (
  email         TEXT NOT NULL COLLATE NOCASE,
  code          TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (email, code)
);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,             -- 客户端生成 UUID
  seq               INTEGER NOT NULL UNIQUE,      -- 同步游标（服务端权威，手动分配 MAX+1）
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(title) <= 500),
  done              INTEGER NOT NULL DEFAULT 0,
  done_at           INTEGER,
  sort_order        REAL NOT NULL,                -- 分数索引，拖拽取中值
  client_updated_at INTEGER NOT NULL,             -- LWW 判定依据
  deleted_at        INTEGER                       -- 软删除墓碑
);
CREATE INDEX idx_tasks_user_seq ON tasks(user_id, seq);
CREATE INDEX idx_tasks_user_active ON tasks(user_id) WHERE deleted_at IS NULL;

-- 设备/会话
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  device_name   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

-- 变更日志（append-only，借鉴 Git 提交历史；不参与同步裁决）
CREATE TABLE op_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL,
  change_id   TEXT NOT NULL,          -- 对应客户端幂等键
  op          TEXT NOT NULL,          -- create | update | delete
  payload     TEXT NOT NULL,          -- JSON 字符串，变更后完整快照
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_oplog_task ON op_log(user_id, task_id, seq);
```

**设计要点**：
- `seq` 作为同步游标，不用时间戳 —— 客户端时钟不可信，`seq` 严格单调
- **`seq` 不用自增列，由写入语句显式分配 `(SELECT COALESCE(MAX(seq),0)+1 FROM tasks)`**：
  自增列（PG BIGSERIAL / SQLite AUTOINCREMENT  alike）在 `ON CONFLICT DO UPDATE` 的 UPDATE 分支不会推进，
  会导致更新/删除的行游标不变、增量拉取永远漏掉这条变更。此坑由真实库冒烟测试抓出（内存 FakeServer 测不出来）。
  事务内串行分配，无并发竞争；`MAX(seq)` 走唯一索引尾部，开销 O(log n)
- `sort_order REAL`：拖拽排序时取相邻两项的中值（如 1.0 与 2.0 之间插入 1.5），避免全表重排；精度耗尽（连续 ~50 次中值切分）后后台批量重排归一化
- 墓碑保留 30 天，定时任务物理清除
- `op_log` 仅追加不修改，随每次 applied 变更同事务写入。用途：任务历史、跨设备撤销（按快照回滚后作为一条新 update 推送）、问题审计回放。**它不替代 LWW 裁决，同步协议主干不变**；保留 90 天后由服务内定时任务清除
- SQLite 需显式 `PRAGMA foreign_keys = ON`（默认关闭），否则 `ON DELETE CASCADE` 静默失效

### 3.2 客户端（Web Dexie / 桌面 SQLite / 安卓 Room，结构一致）

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  sort_order REAL NOT NULL,
  updated_at INTEGER NOT NULL,      -- 本地写入时间（ms epoch）
  deleted_at INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0  -- 1 = 有未推送变更
);

CREATE TABLE outbox (
  change_id TEXT PRIMARY KEY,       -- UUID，幂等键
  task_id TEXT NOT NULL,
  op TEXT NOT NULL,                 -- create | update | delete
  payload TEXT NOT NULL,            -- JSON 快照
  created_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL DEFAULT 0 -- 已应用的最大服务端 seq
);
```

## 4. API 契约

Base URL：`https://api.<domain>/api/v1`。除 auth 外全部需要 `Authorization: Bearer <access_token>`。

### 4.1 认证

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | /auth/code | `{email}` | `{cooldown_sec: 60}` |
| POST | /auth/verify | `{email, code}` | `{access_token, refresh_token, expires_in, user: {id, email}}` |
| POST | /auth/refresh | `{refresh_token}` | 同上，refresh_token 轮换（旧的一次性失效） |
| POST | /auth/logout | `{refresh_token}` | 204 |

- access_token：JWT，2 小时有效，claims = `{sub: user_id}`
- refresh_token：随机 256-bit，30 天有效，轮换制
- 验证码：6 位数字，10 分钟有效，错误 5 次作废，发送限频 1 次/分钟、5 次/天/邮箱

### 4.2 任务同步

**拉取（增量）**
```
GET /tasks?since=<cursor>&limit=500
→ {
    "tasks": [ {id, title, done, done_at, sort_order,
                client_updated_at, deleted_at, seq} ],
    "cursor": 18423,       // 当前最大 seq，客户端存下
    "has_more": false
  }
```
- `since=0` 表示全量拉取（首次登录/本地库重建）
- 返回含 `deleted_at` 非空的墓碑记录，客户端据此删除本地行

**推送（批量，幂等）**
```
POST /tasks/changes
{
  "changes": [
    {
      "change_id": "uuid",              // 幂等键，服务端去重
      "op": "create" | "update" | "delete",
      "task": {id, title, done, done_at, sort_order, client_updated_at}
    }
  ]
}
→ {
    "results": [
      {"change_id": "uuid", "status": "applied"},
      {"change_id": "uuid", "status": "superseded",
       "server_task": {...}}            // LWW 判负，回传服务端权威版本
    ]
  }
```
- 服务端对每个 change：`deleted_at` 优先；否则比较 `client_updated_at`，客户端较新则写入（applied），否则回传服务端版本（superseded）
- `change_id` 去重表保留 7 天，重试/重复提交安全

**实时通知**
```
WS /ws  (连接时带 access_token)
服务端 → 客户端: {"type": "changed", "seq": 18423}
```
- 仅作 pull 触发信号，不携带数据；客户端收到后执行增量拉取
- WS 断开时退化为 5 分钟轮询兜底

### 4.3 任务历史（预留，P1 实现）

```
GET /tasks/{task_id}/history?limit=50
→ {"entries": [{seq, op, payload, created_at}]}
```
- 数据源为 `op_log`；撤销 = 客户端取某条历史快照，构造一条新的 update 变更走正常 push 流程（保证所有端收敛一致，不产生"影子状态"）

## 5. 同步协议（客户端引擎）

三端各实现同一状态机，伪代码：

```
写入路径（所有 UI 操作）:
  1. 事务内：更新本地 tasks（dirty=1）+ outbox 入队
  2. 触发 flush（防抖 500ms，合并同任务变更）

flush():
  1. 取 outbox 全部记录（按时间序，上限 100 条/批）
  2. POST /tasks/changes
  3. applied → 删 outbox 记录，清 dirty
     superseded → 删 outbox 记录，用 server_task 覆盖本地（UI 无感刷新）
  4. 网络失败 → 指数退避（1s/2s/4s/8s/16s），5 次后挂起等网络恢复事件

pull():
  1. GET /tasks?since=<本地 cursor>
  2. 对每条记录：
     - 本地无此行 → 插入
     - 本地 dirty=1（有未推送变更）→ 跳过，等 push 裁决
     - 否则 → 以服务端为准覆盖
  3. 更新 cursor；has_more 则继续拉
  4. 墓碑行：本地物理删除

触发时机: App 启动 / WS 通知 / 每 5 分钟轮询 / 前后台切换
```

**不变式**：本地 dirty 行永远不被 pull 覆盖；服务端 seq 是唯一排序依据；任何一条变更在 outbox 删除前至少成功送达一次（at-least-once + 服务端幂等 = 恰好一次效果）。

## 6. 各端模块拆分

### 6.1 网页端 / 桌面端共享前端包（`packages/web`）

```
src/
├─ ui/            # Svelte 组件：TaskList / TaskItem / QuickAdd / DoneSection
├─ store/         # Svelte store，订阅 Dexie liveQuery
├─ sync/          # 同步引擎（平台无关，注入 storage 适配器）
├─ storage/
│  ├─ dexie.ts    # 网页端实现
│  └─ tauri-sql.ts# 桌面端实现（SQL 与 Dexie schema 对齐）
└─ api/           # REST/WS 客户端，zod 校验，token 自动刷新
```

- Monorepo（pnpm workspace）：`packages/web` 为单一 UI 源，`apps/desktop` 仅注入不同 storage 适配器与 Tauri 桥
- 设计令牌（颜色/间距/圆角）抽为 CSS 变量，三端视觉对齐

### 6.2 Tauri 桌面端（`apps/desktop`）

```
src-tauri/
├─ main.rs
├─ edge_dock/
│  ├─ mod.rs        # 状态机：Collapsed → Triggered → Visible → Hiding
│  ├─ mouse_hook.rs # WH_MOUSE_LL 全局钩子（主），GetCursorPos 50ms 轮询（备）
│  ├─ window.rs     # 无边框/透明/置顶/skip_taskbar 窗口创建与滑动画
│  └─ monitor.rs    # 多显示器枚举、DPI 缩放换算、全屏应用检测
└─ tray.rs          # 托盘菜单 + 单实例锁
```

关键实现：
- **收起态**：窗口 reposition 到屏幕右缘外侧，仅留 4px 触发条可见（非隐藏窗口，避免显示闪烁）
- **滑出**：`SetWindowPos` 按 60Hz 步进位移 + ease-out 曲线（200ms）
- **收起判定**：`TrackMouseEvent` 监听鼠标离开窗口矩形 + 窗口失焦事件，500ms 防抖
- **全屏抑制**：轮询前台窗口，若 `SM_CXSCREEN` 全覆盖则暂停触发
- 自启动：tauri-plugin-autostart；单实例：tauri-plugin-single-instance

### 6.3 安卓端（`apps/android`）

```
:app
├─ ui/          # Compose 屏幕：任务列表 / 编辑 / 设置
├─ data/
│  ├─ TaskDatabase (Room)     # tasks / outbox / sync_state
│  ├─ TaskRepository          # UI 与小组件的唯一入口
│  └─ SyncEngine              # 同 §5 状态机，OkHttp + kotlinx-serialization
├─ sync/
│  ├─ SyncWorker              # WorkManager 周期任务（15min 约束最小值）+ 即时触发
│  └─ NetworkMonitor
└─ widget/
   ├─ TodoWidgetProvider      # onUpdate/onReceive（勾选广播）
   ├─ TodoWidgetService       # RemoteViewsService + Factory 读 Room
   └─ WidgetActions           # 勾选 PendingIntent → Repository 完成 → notifyAppWidgetViewDataChanged
```

**小组件数据通路（关键约束）**：小组件、App UI、同步引擎**全部直连 Room**。组件勾选 → 广播 → Repository 写 Room（dirty=1）→ 触发 SyncWorker → `notifyAppWidgetViewDataChanged` 刷新组件。不经过任何 Web 层。

**MIUI 保活**：首次添加组件时弹引导（自启动 + 关闭电池优化，跳系统设置页 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）；组件提供手动刷新按钮兜底。

### 6.4 后端（`apps/server`）

```
src/
├─ routes/
│  ├─ auth.ts       # code / verify / refresh / logout
│  └─ tasks.ts      # GET /tasks, POST /tasks/changes
├─ ws.ts            # 连接管理，按 user_id 分组广播 changed 事件
├─ services/
│  ├─ sync.ts       # LWW 裁决、seq 分配、幂等去重
│  └─ mailer.ts     # 验证码邮件（腾讯 SES / Resend，可插拔）
└─ db.ts            # better-sqlite3（WAL + 外键 PRAGMA），schema 内嵌，启动时自动应用
```

- 单进程即可支撑 MVP 量级；`seq` 分配与变更广播在同一事务提交后触发
- better-sqlite3 为同步 API：本场景查询全是索引小结果集（亚毫秒），事件循环阻塞可忽略；
  批量推送用 `db.transaction(fn).immediate()`（BEGIN IMMEDIATE 直接拿写锁）
- 全局限流：100 req/min/IP；同步接口按 user 限流 30 req/min

## 7. 部署

裸机单进程，无 Docker（面向小内存服务器；Docker/PG 方案见 `postgres` 分支）：

```
nginx（TLS 终止 + WS 反代）→ 127.0.0.1:8787（node，systemd 托管）→ SQLite 文件
```

- systemd unit：`deploy/edgetodo-server.service`（MemoryMax=256M 保护）
- nginx 站点示例：`deploy/nginx.conf.example`（含 WS 升级头与长连接超时）
- 备份：cron 每日 `sqlite3 .backup`（在线备份 API，WAL 下不停服）+ gzip，保留 14 天，见 `deploy/backup.sh`
- 升级：`git pull → build → systemctl restart`，schema 随启动自动应用（IF NOT EXISTS）
- 完整步骤：`deploy/README.md`
- 监控：/healthz 探活 + 简单 uptime 告警（Uptime Kuma 或第三方）

## 8. 风险清单与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 贴边交互在多显示器/高 DPI/全屏游戏下误触发或失效 | 核心卖点受损 | M0 先做独立验证 Demo，通过后再立项开发 |
| R2 | MIUI 省电策略冻结后台，小组件不刷新、同步中断 | 安卓体验崩盘 | 保活引导 + WorkManager 兜底 + 组件手动刷新 + 小米实机回归 |
| R3 | 同步逻辑 bug 导致丢任务 | 信任崩盘 | outbox at-least-once + 服务端幂等 + 墓碑机制 + 三端同步集成测试（模拟断网/并发） |
| R4 | 邮箱验证码送达率/进垃圾箱 | 登录失败 | 选企业级邮件服务，监控送达率；P2 加微信扫码 |
| R5 | 三端 sort_order 精度漂移 | 排序错乱 | 中值插入 + 阈值后台归一化重排 |
| R6 | 单 VPS 宕机 | 同步暂停（本地功能不受影响） | 本地优先架构天然容错；每日备份可快速重建 |

## 9. 测试策略

- 同步引擎：平台无关 TS 核心 + Kotlin 实现，各自配单元测试（模拟乱序/重复/冲突报文）
- 集成测试：脚本化"双客户端并发操作 → 断言最终一致"
- 安卓：Room 迁移测试 + 小组件 Factory 测试；小米澎湃OS 实机冒烟清单
- 桌面端：M0 Demo 即交互验证载体

## 10. 下一步行动

1. **M0**：Tauri 贴边弹出 Demo（验证 R1）
2. M0 通过 → 搭 monorepo 骨架 → M1 网页端 MVP
3. 同步协议先行实现 + 测试，再接入真实 UI
