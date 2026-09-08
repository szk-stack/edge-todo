<script lang="ts">
  import { login } from "../api";

  let { onDone }: { onDone: (withSync: boolean) => void } = $props();

  let username = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit() {
    if (!username.trim() || !password) {
      error = "请输入账号和密码";
      return;
    }
    busy = true;
    error = "";
    try {
      await login(username.trim(), password);
      onDone(true);
    } catch (e) {
      error = e instanceof Error ? e.message : "登录失败";
    } finally {
      busy = false;
    }
  }
</script>

<div class="gate">
  <div class="card">
    <h1>Edge Todo</h1>
    <p class="sub">极简待办，三端云同步</p>
    <form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input bind:value={username} placeholder="账号" autocomplete="username" />
      <input
        bind:value={password}
        type="password"
        placeholder="密码"
        autocomplete="current-password"
      />
      <button class="primary" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
    </form>
    {#if error}
      <p class="error">{error}</p>
    {/if}
    <button class="skip" onclick={() => onDone(false)}>暂不登录，仅本地使用</button>
  </div>
</div>

<style>
  .gate {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 340px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h1 {
    font-size: 18px;
    font-weight: 500;
    margin: 0;
  }
  .sub {
    color: var(--text-secondary);
    margin: 0 0 8px;
    font-size: 13px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  input {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg);
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
  }
  .primary {
    padding: 10px;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
  }
  .primary:disabled {
    opacity: 0.6;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    margin: 0;
  }
  .skip {
    color: var(--text-secondary);
    font-size: 12px;
    align-self: center;
  }
</style>
