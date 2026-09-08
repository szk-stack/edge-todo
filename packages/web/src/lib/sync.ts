import { writable } from "svelte/store";
import { SyncEngine, type SyncStatus } from "@edgetodo/sync-core";
import { DexieSyncStorage } from "./storage/db";
import { connectWs, isLoggedIn, syncApi } from "./api";

export const syncStatus = writable<SyncStatus>("idle");

let engine: SyncEngine | null = null;
let closeWs: (() => void) | null = null;

/** 登录成功后调用：装配引擎 + WS + 兜底轮询 + 网络/可见性事件 */
export function startSync(): void {
  stopSync();
  if (!isLoggedIn()) return;
  engine = new SyncEngine(new DexieSyncStorage(), syncApi, {
    onStatus: (s) => syncStatus.set(s),
  });
  engine.startPolling();
  void engine.syncNow();
  closeWs = connectWs(() => engine?.notifyRemoteChange());
  window.addEventListener("online", handleOnline);
  document.addEventListener("visibilitychange", handleVisible);
}

export function stopSync(): void {
  engine?.stop();
  engine = null;
  closeWs?.();
  closeWs = null;
  window.removeEventListener("online", handleOnline);
  document.removeEventListener("visibilitychange", handleVisible);
}

/** 本地写入后调用（未登录时为空操作，纯本地模式） */
export function notifyChange(): void {
  engine?.notifyLocalChange();
}

function handleOnline(): void {
  engine?.onOnline();
}

function handleVisible(): void {
  if (!document.hidden) void engine?.syncNow();
}
