import { liveQuery } from "dexie";
import { readable } from "svelte/store";
import type { Task } from "@edgetodo/sync-core";
import { db, writeLocal, type LocalTask } from "./storage/db";
import { notifyChange } from "./sync";

/** 未完成任务（按 sortOrder 升序） */
export const pendingTasks = readable<LocalTask[]>([], (set) => {
  const sub = liveQuery(() =>
    db.tasks
      .filter((t) => t.deletedAt == null && !t.done)
      .sortBy("sortOrder"),
  ).subscribe({ next: set, error: (e) => console.error(e) });
  return () => sub.unsubscribe();
});

/** 已完成（按完成时间倒序） */
export const doneTasks = readable<LocalTask[]>([], (set) => {
  const sub = liveQuery(() =>
    db.tasks
      .filter((t) => t.deletedAt == null && t.done)
      .reverse()
      .sortBy("doneAt"),
  ).subscribe({
    next: (rows) => set(rows.reverse()),
    error: (e) => console.error(e),
  });
  return () => sub.unsubscribe();
});

function strip(t: LocalTask): Task {
  const { dirty: _dirty, ...task } = t;
  return task;
}

/** 分数索引中值；精度耗尽时由 normalize 兜底（P1） */
export function midpoint(before?: number, after?: number): number {
  if (before == null && after == null) return 1000;
  if (before == null) return after! - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

/** 新任务置顶 */
export async function addTask(title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  // orderBy 只能在 Table 上调（走索引），filter 后只能 sortBy；先索引序再 filter 取首个
  const first = await db.tasks
    .orderBy("sortOrder")
    .filter((t) => t.deletedAt == null && !t.done)
    .first();
  const now = Date.now();
  await writeLocal(
    {
      id: crypto.randomUUID(),
      title: trimmed,
      done: false,
      doneAt: null,
      sortOrder: midpoint(undefined, first?.sortOrder),
      updatedAt: now,
      deletedAt: null,
    },
    "create",
  );
  notifyChange();
}

export async function toggleTask(t: LocalTask): Promise<void> {
  const now = Date.now();
  const done = !t.done;
  await writeLocal(
    { ...strip(t), done, doneAt: done ? now : null, updatedAt: now },
    "update",
  );
  notifyChange();
}

export async function editTitle(t: LocalTask, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed || trimmed === t.title) return;
  await writeLocal({ ...strip(t), title: trimmed, updatedAt: Date.now() }, "update");
  notifyChange();
}

/** 软删除（墓碑） */
export async function removeTask(t: LocalTask): Promise<void> {
  const now = Date.now();
  await writeLocal({ ...strip(t), deletedAt: now, updatedAt: now }, "delete");
  notifyChange();
}

/** 拖拽落点：取前后邻居的中值 */
export async function reorderTask(
  id: string,
  before: number | undefined,
  after: number | undefined,
): Promise<void> {
  const t = await db.tasks.get(id);
  if (!t) return;
  await writeLocal(
    { ...strip(t), sortOrder: midpoint(before, after), updatedAt: Date.now() },
    "update",
  );
  notifyChange();
}
