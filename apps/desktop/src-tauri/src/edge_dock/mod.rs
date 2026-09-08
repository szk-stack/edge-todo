//! 贴边停靠状态机 —— docs/TECH_DESIGN.md §6.2。
//! Collapsed：窗口贴屏幕右缘，仅留 4px 触发条；
//! Visible：面板完整滑出。鼠标进入触发区 300ms 确认后滑出；
//! 失焦 500ms 后自动收起。前台全屏应用时抑制触发。

mod mouse;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DockState {
    Collapsed,
    Visible,
}

static STATE: Mutex<DockState> = Mutex::new(DockState::Collapsed);

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn state() -> DockState {
    *STATE.lock().unwrap()
}

pub fn set_state(s: DockState) {
    *STATE.lock().unwrap() = s;
}

/// 前端/托盘可调用：暂停或恢复贴边触发
#[tauri::command]
pub fn set_dock_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn start(app: AppHandle) {
    window::dock_collapsed(&app);
    mouse::spawn_watcher(app.clone());

    // 失焦延迟收起
    if let Some(win) = app.get_webview_window("main") {
        let app2 = app.clone();
        win.on_window_event(move |evt| {
            if let tauri::WindowEvent::Focused(false) = evt {
                let app3 = app2.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    if state() == DockState::Visible {
                        window::slide_out(&app3);
                    }
                });
            }
        });
    }
}

/// 托盘"打开面板"
pub fn show_panel(app: &AppHandle) {
    window::slide_in(app);
}

/// 托盘"暂停 / 恢复贴边"，返回新状态
pub fn toggle_enabled() -> bool {
    let next = !is_enabled();
    ENABLED.store(next, Ordering::Relaxed);
    next
}
