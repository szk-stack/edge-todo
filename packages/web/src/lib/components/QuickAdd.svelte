<script lang="ts">
  import { addTask } from "../store";

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state();
  let error = $state("");
  let composing = $state(false); // 中文输入法组合中：回车是上屏，不提交

  async function submit() {
    const v = value.trim();
    if (!v) return;
    error = "";
    try {
      await addTask(v);
      value = "";
      inputEl?.focus(); // 连续录入
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<form
  class="quick-add"
  onsubmit={(e) => {
    e.preventDefault();
    if (!composing) void submit();
  }}
>
  <input
    bind:this={inputEl}
    bind:value
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => (composing = false)}
    placeholder="回车快速添加任务…"
    maxlength="500"
    autocomplete="off"
  />
  <button type="submit" class="add-btn" title="添加">＋</button>
</form>
{#if error}
  <p class="error">写入失败：{error}</p>
{/if}

<style>
  .quick-add {
    display: flex;
    gap: 8px;
  }
  .quick-add input {
    flex: 1;
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
  .add-btn {
    width: 46px;
    border-radius: 12px;
    background: var(--accent);
    color: #fff;
    font-size: 20px;
    line-height: 1;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    margin: 0;
  }
</style>
