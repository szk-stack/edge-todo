import type { WSContext } from "hono/ws";

/** userId → 活跃 WS 连接集合 */
const clients = new Map<string, Set<WSContext>>();

export function registerWs(userId: string, ws: WSContext): void {
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(ws);
}

export function unregisterWs(userId: string, ws: WSContext): void {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) clients.delete(userId);
}

/** 事务提交后调用：仅推"有变更"信号，客户端自行增量拉取 */
export function notifyUser(userId: string, seq: number): void {
  const set = clients.get(userId);
  if (!set) return;
  const msg = JSON.stringify({ type: "changed", seq });
  for (const ws of set) {
    try {
      ws.send(msg);
    } catch {
      // 发送失败由客户端重连与轮询兜底
    }
  }
}
