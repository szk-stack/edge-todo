import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

// 全局错误可见化：任何未捕获异常/未处理 Promise 拒绝都显示在页面顶部红条，
// 避免"静默没反应"（尤其 preview iframe 里 IndexedDB 被禁这类环境性故障）
function showFatal(msg: string) {
  let bar = document.getElementById("fatal-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "fatal-bar";
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;background:#c0392b;color:#fff;" +
      "padding:8px 14px;font-size:13px;font-family:monospace;white-space:pre-wrap;word-break:break-all";
    document.body.prepend(bar);
  }
  bar.textContent = `⚠ ${msg}`;
}
window.addEventListener("error", (e) => showFatal(e.message || "unknown error"));
window.addEventListener("unhandledrejection", (e) =>
  showFatal(e.reason instanceof Error ? e.reason.message : String(e.reason)),
);

export default mount(App, { target: document.getElementById("app")! });
