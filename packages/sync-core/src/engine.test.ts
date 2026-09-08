import { describe, expect, it } from "vitest";
import { SyncEngine } from "./engine";
import { FakeServer, InMemoryStorage } from "./testing";
import type { Task } from "./types";

let n = 0;
function makeTask(partial: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: partial.id ?? `task-${n}`,
    title: partial.title ?? `任务 ${n}`,
    done: partial.done ?? false,
    doneAt: partial.doneAt ?? null,
    sortOrder: partial.sortOrder ?? n * 1000,
    updatedAt: partial.updatedAt ?? Date.now(),
    deletedAt: partial.deletedAt ?? null,
  };
}

function makeClient(server: FakeServer) {
  const storage = new InMemoryStorage();
  const engine = new SyncEngine(storage, server, { debounceMs: 1 });
  return { storage, engine };
}

describe("SyncEngine", () => {
  it("本地创建 → flush 后 outbox 清空、服务端可见、本地 dirty 清除", async () => {
    const server = new FakeServer();
    const { storage, engine } = makeClient(server);
    const task = makeTask({ title: "买牛奶" });
    await storage.upsertLocal(task, "create", "c-1");

    await engine.flush();

    expect(storage.outboxSize()).toBe(0);
    expect(storage.getTask(task.id)?.dirty).toBe(false);
    expect(server.serverTask(task.id)?.title).toBe("买牛奶");
    expect(server.serverTask(task.id)?.seq).toBe(1);
  });

  it("双端收敛：A 创建 → B 拉取 → B 改标题 → A 看到新标题", async () => {
    const server = new FakeServer();
    const a = makeClient(server);
    const b = makeClient(server);

    const task = makeTask({ title: "v1" });
    await a.storage.upsertLocal(task, "create", "c-a1");
    await a.engine.syncNow();
    await b.engine.pull();
    expect(b.storage.getTask(task.id)?.title).toBe("v1");

    const edited = { ...task, title: "v2", updatedAt: task.updatedAt + 1000 };
    await b.storage.upsertLocal(edited, "update", "c-b1");
    await b.engine.syncNow();
    await a.engine.pull();

    expect(a.storage.getTask(task.id)?.title).toBe("v2");
    expect(a.storage.getTask(task.id)?.dirty).toBe(false);
  });

  it("LWW：离线并发改同一任务，updatedAt 晚者赢，负方被权威版覆盖", async () => {
    const server = new FakeServer();
    const a = makeClient(server);
    const b = makeClient(server);
    const base = makeTask({ title: "base", updatedAt: 1000 });
    await a.storage.upsertLocal(base, "create", "c-0");
    await a.engine.syncNow();
    await b.engine.pull();

    // 两端"离线"各自修改；B 的 updatedAt 更晚
    await a.storage.upsertLocal({ ...base, title: "A 版", updatedAt: 2000 }, "update", "c-a2");
    await b.storage.upsertLocal({ ...base, title: "B 版", updatedAt: 3000 }, "update", "c-b2");

    await a.engine.flush(); // A 先推，applied
    await b.engine.flush(); // B 后推，updatedAt 更晚仍 applied（覆盖）
    await a.engine.pull();

    expect(a.storage.getTask(base.id)?.title).toBe("B 版");
    expect(server.serverTask(base.id)?.title).toBe("B 版");

    // 反向顺序：B 先推（晚），A 后推（早）→ A 被 superseded 回写
    const server2 = new FakeServer();
    const c = makeClient(server2);
    const d = makeClient(server2);
    await c.storage.upsertLocal(base, "create", "c-00");
    await c.engine.syncNow();
    await d.engine.pull();
    await c.storage.upsertLocal({ ...base, title: "C 版", updatedAt: 2000 }, "update", "c-c2");
    await d.storage.upsertLocal({ ...base, title: "D 版", updatedAt: 3000 }, "update", "c-d2");
    await d.engine.flush();
    await c.engine.flush();
    expect(c.storage.getTask(base.id)?.title).toBe("D 版");
    expect(c.storage.getTask(base.id)?.dirty).toBe(false);
    expect(server2.serverTask(base.id)?.title).toBe("D 版");
  });

  it("网络失败：outbox 保留、retryCount 增加，恢复后同步成功", async () => {
    const server = new FakeServer();
    const { storage, engine } = makeClient(server);
    const task = makeTask();
    await storage.upsertLocal(task, "create", "c-x");
    server.failNextPush = true;

    await engine.flush();
    expect(storage.outboxSize()).toBe(1);
    expect((await storage.getOutbox(10))[0].retryCount).toBe(1);
    expect(engine.getStatus()).toBe("offline");

    await engine.syncNow();
    expect(storage.outboxSize()).toBe(0);
    expect(server.serverTask(task.id)).toBeDefined();
  });

  it("幂等：同一 changeId 重复 push 只应用一次", async () => {
    const server = new FakeServer();
    const task = makeTask();
    const change = { changeId: "dup-1", op: "create" as const, task };
    await server.push([change]);
    const again = await server.push([change]);
    expect(again[0].status).toBe("applied");
    expect(server.serverTask(task.id)?.seq).toBe(1);
  });

  it("墓碑：删除同步到对端物理删除，且已删任务不能复活", async () => {
    const server = new FakeServer();
    const a = makeClient(server);
    const b = makeClient(server);
    const task = makeTask();
    await a.storage.upsertLocal(task, "create", "c-1");
    await a.engine.syncNow();
    await b.engine.pull();
    expect(b.storage.getTask(task.id)).toBeDefined();

    const tomb = { ...task, deletedAt: Date.now(), updatedAt: Date.now() };
    await a.storage.upsertLocal(tomb, "delete", "c-2");
    await a.engine.syncNow();
    await b.engine.pull();
    expect(b.storage.getTask(task.id)).toBeUndefined();

    // B 离线期间的旧修改后推，被墓碑拒绝
    await b.storage.upsertLocal({ ...task, title: "复活", updatedAt: Date.now() + 1 }, "update", "c-3");
    await b.engine.flush();
    expect(b.storage.getTask(task.id)).toBeUndefined(); // authoritative 回写即删除
    expect(server.serverTask(task.id)?.deletedAt).not.toBeNull();
  });

  it("不变式：pull 不覆盖本地 dirty 行", async () => {
    const server = new FakeServer();
    const a = makeClient(server);
    const b = makeClient(server);
    const task = makeTask({ title: "base" });
    await a.storage.upsertLocal(task, "create", "c-1");
    await a.engine.syncNow();
    await b.engine.pull();

    // B 离线修改（dirty 未推），A 在线改另一版并同步
    await b.storage.upsertLocal({ ...task, title: "B 本地版", updatedAt: task.updatedAt + 500 }, "update", "c-b");
    await a.storage.upsertLocal({ ...task, title: "A 在线版", updatedAt: task.updatedAt + 900 }, "update", "c-a");
    await a.engine.syncNow();
    await b.engine.pull();

    expect(b.storage.getTask(task.id)?.title).toBe("B 本地版");
    expect(b.storage.getTask(task.id)?.dirty).toBe(true);
  });

  it("notifyLocalChange 防抖后自动 flush", async () => {
    const server = new FakeServer();
    const { storage, engine } = makeClient(server);
    const task = makeTask();
    await storage.upsertLocal(task, "create", "c-1");
    engine.notifyLocalChange();
    await new Promise((r) => setTimeout(r, 30));
    expect(storage.outboxSize()).toBe(0);
    expect(server.serverTask(task.id)).toBeDefined();
    engine.stop();
  });
});
