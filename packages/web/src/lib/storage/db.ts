import Dexie, { type Table } from "dexie";
import type {
  Op,
  OutboxEntry,
  ServerTask,
  SyncStorage,
  Task,
} from "@edgetodo/sync-core";

export interface LocalTask extends Task {
  /** IndexedDB 不便索引 boolean，用 0/1 */
  dirty: number;
}

interface SyncStateRow {
  id: number;
  cursor: number;
}

class TodoDB extends Dexie {
  tasks!: Table<LocalTask, string>;
  outbox!: Table<OutboxEntry, string>;
  syncState!: Table<SyncStateRow, number>;

  constructor() {
    super("edge-todo");
    this.version(1).stores({
      tasks: "id, done, sortOrder",
      outbox: "changeId, createdAt",
      syncState: "id",
    });
  }
}

export const db = new TodoDB();

/**
 * 平台写入路径：本地行置 dirty + outbox 入队，同一事务。
 * 所有 UI 操作必须经过这里，保证任何变更都进入同步管道。
 */
export async function writeLocal(task: Task, op: Op): Promise<void> {
  const changeId = crypto.randomUUID();
  await db.transaction("rw", db.tasks, db.outbox, async () => {
    await db.tasks.put({ ...task, dirty: 1 });
    await db.outbox.put({
      changeId,
      taskId: task.id,
      op,
      payload: task,
      createdAt: task.updatedAt,
      retryCount: 0,
    });
  });
}

/** SyncStorage 的 Dexie 实现，供 SyncEngine 使用 */
export class DexieSyncStorage implements SyncStorage {
  async getOutbox(limit: number): Promise<OutboxEntry[]> {
    return db.outbox.orderBy("createdAt").limit(limit).toArray();
  }

  async deleteOutbox(changeIds: string[]): Promise<void> {
    await db.outbox.bulkDelete(changeIds);
  }

  async markSynced(taskIds: string[]): Promise<void> {
    await db.transaction("rw", db.tasks, async () => {
      for (const id of taskIds) {
        const t = await db.tasks.get(id);
        if (t) await db.tasks.put({ ...t, dirty: 0 });
      }
    });
  }

  async bumpRetry(changeIds: string[]): Promise<void> {
    await db.transaction("rw", db.outbox, async () => {
      for (const id of changeIds) {
        const e = await db.outbox.get(id);
        if (e) await db.outbox.put({ ...e, retryCount: e.retryCount + 1 });
      }
    });
  }

  async applyServerTasks(
    tasks: ServerTask[],
    opts?: { authoritative?: boolean },
  ): Promise<void> {
    await db.transaction("rw", db.tasks, async () => {
      for (const st of tasks) {
        const local = await db.tasks.get(st.id);
        if (local?.dirty === 1 && !opts?.authoritative) continue; // dirty 行永不被覆盖
        if (st.deletedAt != null) {
          await db.tasks.delete(st.id); // 墓碑 → 物理删除
          continue;
        }
        const { seq: _seq, ...task } = st;
        await db.tasks.put({ ...task, dirty: 0 });
      }
    });
  }

  async getCursor(): Promise<number> {
    return (await db.syncState.get(1))?.cursor ?? 0;
  }

  async setCursor(cursor: number): Promise<void> {
    await db.syncState.put({ id: 1, cursor });
  }
}
