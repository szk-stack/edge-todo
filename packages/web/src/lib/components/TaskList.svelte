<script lang="ts">
  import { dndzone, type DndEvent } from "svelte-dnd-action";
  import { flip } from "svelte/animate";
  import { pendingTasks, reorderTask } from "../store";
  import type { LocalTask } from "../storage/db";
  import TaskItem from "./TaskItem.svelte";

  let items = $state<LocalTask[]>([]);

  // 镜像 store 到本地可拖拽副本；外部数据变化（同步/本地写）时重置
  $effect(() => {
    items = $pendingTasks;
  });

  function handleConsider(e: CustomEvent<DndEvent<LocalTask>>) {
    items = e.detail.items;
  }

  function handleFinalize(e: CustomEvent<DndEvent<LocalTask>>) {
    items = e.detail.items;
    const id = e.detail.info.id as string;
    const idx = items.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const before = idx > 0 ? items[idx - 1].sortOrder : undefined;
    const after = idx < items.length - 1 ? items[idx + 1].sortOrder : undefined;
    void reorderTask(id, before, after);
  }
</script>

<section
  class="list"
  use:dndzone={{ items, flipDurationMs: 150 }}
  onconsider={handleConsider}
  onfinalize={handleFinalize}
>
  {#each items as task (task.id)}
    <div animate:flip={{ duration: 150 }}>
      <TaskItem {task} />
    </div>
  {/each}
</section>
{#if items.length === 0}
  <p class="empty">没有待办，享受当下。</p>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    outline: none;
  }
  .empty {
    color: var(--text-secondary);
    text-align: center;
    margin-top: 48px;
  }
</style>
