import type {
  ChangeItem,
  ChangeResult,
  PullResponse,
  SyncApi,
} from "@edgetodo/sync-core";

const BASE: string = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
const ACCESS_KEY = "edge_todo_access";
const REFRESH_KEY = "edge_todo_refresh";

export function isLoggedIn(): boolean {
  return localStorage.getItem(ACCESS_KEY) !== null;
}

export function logout(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

interface TokenBundle {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function saveTokens(t: TokenBundle): void {
  localStorage.setItem(ACCESS_KEY, t.access_token);
  localStorage.setItem(REFRESH_KEY, t.refresh_token);
}

export async function requestCode(email: string): Promise<void> {
  const resp = await fetch(`${BASE}/api/v1/auth/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!resp.ok) throw new Error(`发送验证码失败：${resp.status}`);
}

export async function verifyCode(email: string, code: string): Promise<void> {
  const resp = await fetch(`${BASE}/api/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!resp.ok) throw new Error(`验证码错误或已过期：${resp.status}`);
  saveTokens(await resp.json());
}

async function refreshTokens(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;
  const resp = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!resp.ok) return false;
  saveTokens(await resp.json());
  return true;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(ACCESS_KEY);
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
  if (resp.status === 401 && (await refreshTokens())) {
    const retryToken = localStorage.getItem(ACCESS_KEY);
    return fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${retryToken}`,
        ...init?.headers,
      },
    });
  }
  return resp;
}

/** SyncApi 实现：供 SyncEngine 调用；非 2xx 一律抛错交由引擎退避 */
export const syncApi: SyncApi = {
  async pull(since: number, limit: number): Promise<PullResponse> {
    const resp = await authedFetch(`/api/v1/tasks?since=${since}&limit=${limit}`);
    if (!resp.ok) throw new Error(`pull failed: ${resp.status}`);
    return resp.json();
  },
  async push(changes: ChangeItem[]): Promise<ChangeResult[]> {
    const resp = await authedFetch(`/api/v1/tasks/changes`, {
      method: "POST",
      body: JSON.stringify({ changes }),
    });
    if (!resp.ok) throw new Error(`push failed: ${resp.status}`);
    const body = await resp.json();
    return body.results;
  },
};

/** WS 变更通知；断开自动重连（指数退避，上限 30s），返回关闭函数 */
export function connectWs(onChange: () => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const token = localStorage.getItem(ACCESS_KEY);
    if (!token) return;
    const wsBase = BASE.replace(/^http/, "ws");
    ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = () => onChange();
    ws.onopen = () => {
      retry = 0;
    };
    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retry, 30000);
      retry += 1;
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
