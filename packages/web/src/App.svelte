<script lang="ts">
  import { onMount } from "svelte";
  import { isLoggedIn } from "./lib/api";
  import { startSync } from "./lib/sync";
  import QuickAdd from "./lib/components/QuickAdd.svelte";
  import TaskList from "./lib/components/TaskList.svelte";
  import DoneSection from "./lib/components/DoneSection.svelte";
  import SyncBadge from "./lib/components/SyncBadge.svelte";
  import AuthGate from "./lib/components/AuthGate.svelte";

  let entered = $state(false);

  onMount(() => {
    if (isLoggedIn()) {
      entered = true;
      startSync();
    }
  });

  function handleEntered(withSync: boolean) {
    entered = true;
    if (withSync) startSync();
  }
</script>

{#if entered}
  <main class="shell">
    <header>
      <h1>待办</h1>
      <SyncBadge />
    </header>
    <QuickAdd />
    <TaskList />
    <DoneSection />
  </main>
{:else}
  <AuthGate onDone={handleEntered} />
{/if}

<style>
  .shell {
    max-width: 520px;
    margin: 0 auto;
    padding: 24px 16px 64px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 100%;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h1 {
    font-size: 20px;
    font-weight: 500;
    margin: 0;
  }
</style>
