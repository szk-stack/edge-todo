import type {
  ChangeItem,
  SyncApi,
  SyncEngineOptions,
  SyncStatus,
  SyncStorage,
} from "./types";

/**
 * 同步引擎（平台无关）—— docs/TECH_DESIGN.md §5 状态机实现。
 *
 * 写入路径（平台侧完成）：本地库事务内更新 + outbox 入队 → notifyLocalChange()。
 * flush：批量推送 outbox，applied/superseded 都出队，superseded 回写权威版本。
 * pull：游标增量拉取，dirty 行跳过，墓碑物理删除。
 * 失败：指数退避重试，超 maxRetries 挂起，待 online/手动 syncNow 恢复。
 */
export class SyncEngine {
  private readonly storage: SyncStorage;
  private readonly api: SyncApi;
  private readonly debounceMs: number;
  private readonly batchSize: number;
  private readonly pullLimit: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly onStatus?: (status: SyncStatus) => void;

  private status: SyncStatus = "idle";
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private pulling = false;
  private failStreak = 0;
  private suspended = false;

  constructor(storage: SyncStorage, api: SyncApi, options: SyncEngineOptions = {}) {
    this.storage = storage;
    this.api = api;
    this.debounceMs = options.debounceMs ?? 500;
    this.batchSize = options.batchSize ?? 100;
    this.pullLimit = options.pullLimit ?? 500;
    this.pollIntervalMs = options.pollIntervalMs ?? 5 * 60 * 1000;
    this.maxRetries = options.maxRetries ?? 5;
    this.onStatus = options.onStatus;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** 本地写入后调用；防抖合并后触发 flush */
  notifyLocalChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** WS 变更通知 / 前后台切换时调用 */
  notifyRemoteChange(): void {
    void this.pull();
  }

  /** 启动兜底轮询（WS 断开时也靠它收敛） */
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.syncNow(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = this.retryTimer = this.pollTimer = undefined;
  }

  /** 网络恢复事件 */
  onOnline(): void {
    this.suspended = false;
    this.failStreak = 0;
    void this.syncNow();
  }

  async syncNow(): Promise<void> {
    await this.flush();
    await this.pull();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.suspended) return;
    this.flushing = true;
    this.setStatus("syncing");
    try {
      for (;;) {
        const batch = await this.storage.getOutbox(this.batchSize);
        if (batch.length === 0) break;
        const changes: ChangeItem[] = batch.map((e) => ({
          changeId: e.changeId,
          op: e.op,
          task: e.payload,
        }));
        let results;
        try {
          results = await this.api.push(changes);
        } catch {
          await this.storage.bumpRetry(batch.map((e) => e.changeId));
          this.onPushFailure();
          return;
        }
        const done = results.map((r) => r.changeId);
        const syncedTaskIds = batch
          .filter((e) => done.includes(e.changeId))
          .map((e) => e.taskId);
        const superseded = results
          .filter((r) => r.status === "superseded" && r.serverTask)
          .map((r) => r.serverTask!);
        // 先回写权威版本（强制覆盖 dirty 行），再清 dirty + 出队，保证崩溃一致性
        if (superseded.length > 0) {
          await this.storage.applyServerTasks(superseded, { authoritative: true });
        }
        await this.storage.markSynced(syncedTaskIds);
        await this.storage.deleteOutbox(done);
        this.onSuccess();
      }
    } finally {
      this.flushing = false;
      // 失败路径的状态（offline/error）由 onPushFailure 设置，此处不覆盖
      if (this.failStreak === 0 && !this.suspended) this.setStatus("idle");
    }
  }

  async pull(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    this.setStatus("syncing");
    try {
      for (;;) {
        const since = await this.storage.getCursor();
        const resp = await this.api.pull(since, this.pullLimit);
        await this.storage.applyServerTasks(resp.tasks);
        await this.storage.setCursor(resp.cursor);
        if (!resp.hasMore) break;
      }
      this.onSuccess();
    } catch {
      this.onPushFailure();
    } finally {
      this.pulling = false;
      if (this.failStreak === 0 && !this.suspended) this.setStatus("idle");
    }
  }

  private onSuccess(): void {
    this.failStreak = 0;
    this.suspended = false;
  }

  private onPushFailure(): void {
    this.failStreak += 1;
    this.setStatus("offline");
    if (this.failStreak >= this.maxRetries) {
      this.suspended = true;
      this.setStatus("error");
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.failStreak - 1), 16000);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.syncNow(), delay);
  }

  private setStatus(s: SyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }
}
