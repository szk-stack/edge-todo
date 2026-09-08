# Edge Todo

极简待办，三端云同步：网页端完整管理，Windows 端贴边速记，安卓端（规划中）桌面组件速览。

- 产品需求：`docs/PRD.md`
- 技术方案：`docs/TECH_DESIGN.md`（数据模型 / API 契约 / 同步协议 / 风险清单）

## 架构

```
                 apps/server (Hono + PostgreSQL)
                ┌──────────────┴──────────────┐
          HTTPS/WS                       HTTPS/WS
        packages/web                  apps/android (规划中)
     (Svelte + Dexie)
                │
        apps/desktop (Tauri 2 复用 Web UI + Rust 贴边交互)

packages/sync-core：平台无关同步引擎（outbox + 游标增量 + LWW + 幂等）
```

## 目录

| 路径 | 说明 |
|---|---|
| `packages/web` | 网页端 PWA（Svelte 5 + Vite + Dexie），同时是桌面端 UI 源 |
| `packages/sync-core` | 同步引擎 + 内存参考实现 + 双端收敛单测（vitest） |
| `apps/server` | 后端：邮箱验证码认证、增量拉取、批量幂等推送、op_log、WS 通知 |
| `apps/desktop` | Windows 桌面端（Tauri 2），贴边弹出状态机 + 托盘 |

## 快速开始

```bash
pnpm install

# 网页端（纯本地即可用，IndexedDB 存储）
pnpm --filter @edgetodo/web dev        # http://localhost:5173

# 后端（需要 Docker）
cd apps/server
cp .env.example .env                   # 改 JWT_SECRET
docker compose up -d postgres          # 首次启动自动执行 schema.sql
pnpm --filter @edgetodo/server dev     # http://localhost:8787
# 开发模式验证码直接打印在 server 控制台

# Web 端接入同步：packages/web/.env 写入
# VITE_API_URL=http://localhost:8787 然后刷新页面登录

# 桌面端（需要 Rust 工具链 + Tauri 环境，仅 Windows 验证贴边）
pnpm --filter @edgetodo/desktop dev
```

## 测试与检查

```bash
pnpm --filter @edgetodo/sync-core test      # 同步协议单测（并发冲突/幂等/墓碑/断网恢复）
pnpm --filter @edgetodo/server typecheck
pnpm --filter @edgetodo/web build
```

## 同步协议要点

- 本地优先：UI 只读写本地库，写入 = 本地行(dirty) + outbox 入队（同一事务）
- 推送：防抖 500ms 批量 POST，`change_id` 幂等去重；`superseded` 回写服务端权威版本
- 拉取：`seq` 游标增量（不信客户端时钟），墓碑物理删除，dirty 行不被覆盖
- 裁决：LWW（client_updated_at），删除优先；op_log 全量留痕（预留历史/撤销）

## 路线图

- [x] M1 网页端 MVP（本地优先）
- [x] M2 后端 + 同步协议
- [ ] M0/M3 桌面端贴边交互实机验证（代码就绪，待 Rust 环境编译验证）
- [ ] M4 安卓端（Kotlin Compose + Room）
- [ ] M5 安卓桌面组件 + 上架
