/**
 * 同步协议共享类型 —— 三端与服务端契约对齐 docs/TECH_DESIGN.md §3/§4。
 * 时间戳一律毫秒 epoch；seq 为服务端分配的严格单调游标。
 */

export interface Task {
  id: string;
  title: string;
  done: boolean;
  doneAt: number | null;
  /** 分数索引：拖拽排序取相邻中值 */
  sortOrder: number;
  /** 客户端本地写入时间，LWW 裁决依据 */
  updatedAt: number;
  /** 软删除墓碑 */
  deletedAt: number | null;
}

export type Op = "create" | "update" | "delete";

export interface OutboxEntry {
  /** 幂等键（等价 commit hash 的角色） */
  changeId: string;
  taskId: string;
  op: Op;
  /** 变更后完整快照 */
  payload: Task;
  createdAt: number;
  retryCount: number;
}

export interface ServerTask extends Task {
  seq: number;
}

export interface ChangeItem {
  changeId: string;
  op: Op;
  task: Task;
}

export interface ChangeResult {
  changeId: string;
  status: "applied" | "superseded";
  /** superseded 时回传服务端权威版本 */
  serverTask?: ServerTask;
}

export interface PullResponse {
  tasks: ServerTask[];
  cursor: number;
  hasMore: boolean;
}

export type SyncStatus = "idle" | "syncing" | "offline" | "error";

/**
 * 平台注入的本地存储适配器（Web=Dexie / 桌面=SQLite / 测试=内存）。
 * 实现必须满足不变式：本地 dirty 行永不被 applyServerTasks 覆盖。
 */
export interface SyncStorage {
  getOutbox(limit: number): Promise<OutboxEntry[]>;
  deleteOutbox(changeIds: string[]): Promise<void>;
  /** push 成功后清除对应任务的 dirty 标志 */
  markSynced(taskIds: string[]): Promise<void>;
  bumpRetry(changeIds: string[]): Promise<void>;
  /**
   * 应用服务端记录。默认跳过 dirty 行；
   * authoritative=true 时强制覆盖（用于 push 被判 superseded 的回写）。
   * deletedAt 非空的记录应物理删除本地行。
   */
  applyServerTasks(tasks: ServerTask[], opts?: { authoritative?: boolean }): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

/** 平台注入的 API 客户端 */
export interface SyncApi {
  pull(since: number, limit: number): Promise<PullResponse>;
  push(changes: ChangeItem[]): Promise<ChangeResult[]>;
}

export interface SyncEngineOptions {
  /** 本地变更防抖毫秒，默认 500 */
  debounceMs?: number;
  /** push 单批上限，默认 100 */
  batchSize?: number;
  /** pull 单页上限，默认 500 */
  pullLimit?: number;
  /** 兜底轮询间隔毫秒，默认 5 分钟 */
  pollIntervalMs?: number;
  /** 单批最大连续失败次数，默认 5 */
  maxRetries?: number;
  now?: () => number;
  onStatus?: (status: SyncStatus) => void;
}
