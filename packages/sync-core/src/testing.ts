import type {
  ChangeItem,
  ChangeResult,
  Op,
  OutboxEntry,
  PullResponse,
  ServerTask,
  SyncApi,
  SyncStorage,
  Task,
} from "./types";

/**
 * 内存版 SyncStorage：单测与平台适配器的参考实现。
 * 同时演示平台写入路径 upsertLocal：本地行置 dirty + outbox 入队。
 */
export class InMemoryStorage implements SyncStorage {
  readonly tasks = new Map<string, Task & { dirty: boolean }>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private cursor = 0;

  /** 平台写入路径参考实现（应在真实存储的事务内完成） */
  async upsertLocal(task: Task, op: Op, changeId: string): Promise<void> {
    this.tasks.set(task.id, { ...task, dirty: true });
    this.outbox.set(changeId, {
      changeId,
      taskId: task.id,
      op,
      payload: task,
      createdAt: task.updatedAt,
      retryCount: 0,
    });
  }

  getTask(id: string): (Task & { dirty: boolean }) | undefined {
    return this.tasks.get(id);
  }

  outboxSize(): number {
    return this.outbox.size;
  }

  async getOutbox(limit: number): Promise<OutboxEntry[]> {
    return [...this.outbox.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  async deleteOutbox(changeIds: string[]): Promise<void> {
    for (const id of changeIds) this.outbox.delete(id);
  }

  async markSynced(taskIds: string[]): Promise<void> {
    for (const id of taskIds) {
      const t = this.tasks.get(id);
      if (t) this.tasks.set(id, { ...t, dirty: false });
    }
  }

  async bumpRetry(changeIds: string[]): Promise<void> {
    for (const id of changeIds) {
      const e = this.outbox.get(id);
      if (e) this.outbox.set(id, { ...e, retryCount: e.retryCount + 1 });
    }
  }

  async applyServerTasks(
    tasks: ServerTask[],
    opts?: { authoritative?: boolean },
  ): Promise<void> {
    for (const st of tasks) {
      const local = this.tasks.get(st.id);
      if (local?.dirty && !opts?.authoritative) continue; // 不变式：dirty 行不被覆盖
      if (st.deletedAt != null) {
        this.tasks.delete(st.id); // 墓碑 → 物理删除
        continue;
      }
      const { seq: _seq, ...task } = st;
      this.tasks.set(st.id, { ...task, dirty: false });
    }
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(cursor: number): Promise<void> {
    this.cursor = cursor;
  }
}

/**
 * 内存版服务端：实现真实裁决逻辑（LWW + seq 分配 + changeId 幂等去重），
 * 用于多客户端收敛测试。
 */
export class FakeServer implements SyncApi {
  private readonly tasks = new Map<string, ServerTask>();
  private readonly seen = new Map<string, ChangeResult>();
  private seq = 0;
  failNextPush = false;

  async push(changes: ChangeItem[]): Promise<ChangeResult[]> {
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error("network error");
    }
    const results: ChangeResult[] = [];
    for (const c of changes) {
      const dup = this.seen.get(c.changeId);
      if (dup) {
        results.push(dup);
        continue;
      }
      const existing = this.tasks.get(c.task.id);
      let result: ChangeResult;
      if (existing?.deletedAt != null) {
        // 墓碑优先：已删除的任务拒绝复活
        result = { changeId: c.changeId, status: "superseded", serverTask: existing };
      } else if (
        !existing ||
        c.op === "delete" ||
        c.task.updatedAt >= existing.updatedAt
      ) {
        const serverTask: ServerTask = {
          ...c.task,
          deletedAt: c.op === "delete" ? c.task.deletedAt ?? Date.now() : null,
          seq: ++this.seq,
        };
        this.tasks.set(c.task.id, serverTask);
        result = { changeId: c.changeId, status: "applied" };
      } else {
        result = { changeId: c.changeId, status: "superseded", serverTask: existing };
      }
      this.seen.set(c.changeId, result);
      results.push(result);
    }
    return results;
  }

  async pull(since: number, limit: number): Promise<PullResponse> {
    const all = [...this.tasks.values()]
      .filter((t) => t.seq > since)
      .sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    return {
      tasks: page,
      cursor: page.length > 0 ? page[page.length - 1].seq : since,
      hasMore: all.length > page.length,
    };
  }

  serverTask(id: string): ServerTask | undefined {
    return this.tasks.get(id);
  }
}
