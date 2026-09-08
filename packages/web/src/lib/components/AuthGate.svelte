<script lang="ts">
  import { requestCode, verifyCode } from "../api";

  let { onDone }: { onDone: (withSync: boolean) => void } = $props();

  let email = $state("");
  let code = $state("");
  let step = $state<"email" | "code">("email");
  let busy = $state(false);
  let error = $state("");

  async function sendCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      error = "请输入有效邮箱";
      return;
    }
    busy = true;
    error = "";
    try {
      await requestCode(email);
      step = "code";
    } catch (e) {
      error = e instanceof Error ? e.message : "发送失败";
    } finally {
      busy = false;
    }
  }

  async function verify() {
    busy = true;
    error = "";
    try {
      await verifyCode(email, code.trim());
      onDone(true);
    } catch (e) {
      error = e instanceof Error ? e.message : "验证失败";
    } finally {
      busy = false;
    }
  }
</script>

<div class="gate">
  <div class="card">
    <h1>Edge Todo</h1>
    <p class="sub">极简待办，三端云同步</p>
    {#if step === "email"}
      <form onsubmit={(e) => { e.preventDefault(); void sendCode(); }}>
        <input bind:value={email} type="email" placeholder="邮箱" autocomplete="email" />
        <button class="primary" disabled={busy}>{busy ? "发送中…" : "发送验证码"}</button>
      </form>
    {:else}
      <form onsubmit={(e) => { e.preventDefault(); void verify(); }}>
        <p class="hint">验证码已发送至 {email}</p>
        <input bind:value={code} placeholder="6 位验证码" maxlength="6" inputmode="numeric" autocomplete="one-time-code" />
        <button class="primary" disabled={busy}>{busy ? "验证中…" : "登录"}</button>
      </form>
    {/if}
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
  .hint {
    font-size: 12px;
    color: var(--text-secondary);
    margin: 0;
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
