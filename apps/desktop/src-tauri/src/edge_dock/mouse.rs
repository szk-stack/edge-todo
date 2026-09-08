//! 全局鼠标监听：50ms 轮询 GetCursorPos。
//! 备注：轮询一次 GetCursorPos 的开销可忽略，实现远比 WH_MOUSE_LL
//! 全局钩子简单可靠（无需独立消息循环线程）；若 M0 验证发现耗电问题再换钩子。

use super::window;
use super::{is_enabled, state, DockState};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const TRIGGER_CONFIRM: Duration = Duration::from_millis(300);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || watch(app));
}

#[cfg(windows)]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = POINT::default();
        GetCursorPos(&mut pt).ok().map(|_| (pt.x, pt.y))
    }
}

#[cfg(not(windows))]
fn cursor_pos() -> Option<(i32, i32)> {
    None
}

fn watch(app: AppHandle) {
    let mut entered_at: Option<Instant> = None;
    loop {
        std::thread::sleep(POLL_INTERVAL);

        // 已暂停或面板已展开时不检测
        if !is_enabled() || state() == DockState::Visible {
            entered_at = None;
            continue;
        }
        let Some((x, _y)) = cursor_pos() else {
            continue;
        };
        // 前台全屏应用（游戏/视频）时抑制触发
        if window::fullscreen_active() {
            entered_at = None;
            continue;
        }

        if window::in_trigger_zone(&app, x) {
            let t = entered_at.get_or_insert_with(Instant::now);
            if t.elapsed() >= TRIGGER_CONFIRM {
                window::slide_in(&app);
                entered_at = None;
            }
        } else {
            entered_at = None;
        }
    }
}
