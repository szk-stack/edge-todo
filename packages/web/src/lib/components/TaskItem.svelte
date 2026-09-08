<script lang="ts">
  import { editTitle, removeTask, toggleTask } from "../store";
  import type { LocalTask } from "../storage/db";

  let { task }: { task: LocalTask } = $props();

  let editing = $state(false);
  let draft = $state("");

  function startEdit() {
    draft = task.title;
    editing = true;
  }

  async function commit() {
    if (!editing) return;
    editing = false;
    await editTitle(task, draft);
  }
</script>

<div class="task-item" class:done={task.done}>
  <button
    class="check"
    aria-label={task.done ? "取消完成" : "完成"}
    onclick={() => void toggleTask(task)}
  >
    {#if task.done}
      <svg viewBox="0 0 12 12" width="10" height="10">
        <path d="M2 6.5 L4.8 9 L10 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    {/if}
  </button>
  {#if editing}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="edit"
      bind:value={draft}
      maxlength="500"
      autofocus
      onblur={() => void commit()}
      onkeydown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") editing = false;
      }}
    />
  {:else}
    <button class="title" onclick={startEdit}>{task.title}</button>
  {/if}
  <button class="delete" aria-label="删除" onclick={() => void removeTask(task)}>×</button>
</div>

<style>
  .task-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .task-item:hover {
    background: var(--surface-hover);
  }
  .check {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1.5px solid var(--text-secondary);
    display: grid;
    place-items: center;
    color: #fff;
  }
  .done .check {
    background: var(--accent);
    border-color: var(--accent);
  }
  .title {
    flex: 1;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .done .title {
    text-decoration: line-through;
    color: var(--text-secondary);
  }
  .edit {
    flex: 1;
    border: none;
    background: transparent;
    outline: none;
    border-bottom: 1px solid var(--accent);
  }
  .delete {
    flex: none;
    color: var(--text-secondary);
    font-size: 16px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .task-item:hover .delete {
    opacity: 1;
  }
  .delete:hover {
    color: var(--danger);
  }
</style>
