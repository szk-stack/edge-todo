<script lang="ts">
  import { addTask } from "../store";

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state();

  async function submit() {
    if (!value.trim()) return;
    const v = value;
    value = "";
    await addTask(v);
    inputEl?.focus(); // 连续录入
  }
</script>

<form
  class="quick-add"
  onsubmit={(e) => {
    e.preventDefault();
    void submit();
  }}
>
  <input
    bind:this={inputEl}
    bind:value
    placeholder="回车快速添加任务…"
    maxlength="500"
    autocomplete="off"
  />
</form>

<style>
  .quick-add input {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    outline: none;
    font-size: 15px;
  }
  .quick-add input:focus {
    border-color: var(--accent);
  }
</style>
