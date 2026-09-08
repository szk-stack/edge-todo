<script lang="ts">
  import { isLoggedIn } from "../api";
  import { syncStatus } from "../sync";

  const labels: Record<string, string> = {
    idle: "已同步",
    syncing: "同步中",
    offline: "离线",
    error: "同步异常",
  };
  const loggedIn = isLoggedIn();
</script>

<span class="badge {$syncStatus}" class:local={!loggedIn}>
  <i></i>{loggedIn ? labels[$syncStatus] : "仅本地"}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .badge i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #58b368;
  }
  .badge.syncing i {
    background: var(--accent);
  }
  .badge.offline i {
    background: #e0a83c;
  }
  .badge.error i {
    background: var(--danger);
  }
  .badge.local i {
    background: var(--text-secondary);
  }
</style>
