<script lang="ts">
  import { doneTasks } from "../store";
  import TaskItem from "./TaskItem.svelte";

  let open = $state(false);
</script>

{#if $doneTasks.length > 0}
  <section class="done">
    <button class="toggle" onclick={() => (open = !open)}>
      <span class:rot={open}>▸</span> 已完成 {$doneTasks.length}
    </button>
    {#if open}
      <div class="rows">
        {#each $doneTasks as task (task.id)}
          <TaskItem {task} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .done {
    margin-top: 8px;
  }
  .toggle {
    color: var(--text-secondary);
    padding: 6px 4px;
  }
  .toggle span {
    display: inline-block;
    transition: transform 0.15s;
  }
  .toggle span.rot {
    transform: rotate(90deg);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }
</style>
