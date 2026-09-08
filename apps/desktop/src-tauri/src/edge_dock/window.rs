//! 窗口定位与滑入滑出动画。
//! 收起态：窗口主体移出屏幕右缘外，仅留 TRIGGER_WIDTH 像素触发条可见。
//! M0 简化：触发区按"窗口当前所在显示器"计算；多显示器跟随鼠标所在屏在 M0 验证后细化。

use super::{set_state, state, DockState};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const PANEL_WIDTH: i32 = 320;
pub const PANEL_HEIGHT_RATIO: f64 = 0.8;
pub const TRIGGER_WIDTH: i32 = 4;
const SLIDE_MS: u128 = 200;
const FRAME_MS: u64 = 16;

struct Geom {
    x_shown: i32,
    x_hidden: i32,
    y: i32,
    h: u32,
    panel_w: u32,
}

fn geometry(app: &AppHandle) -> Option<Geom> {
    let win = app.get_webview_window("main")?;
    let monitor = win.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let pos = monitor.position();
    let h = (size.height as f64 * PANEL_HEIGHT_RATIO) as u32;
    let y = pos.y + (size.height as i32 - h as i32) / 2;
    let panel_w = (PANEL_WIDTH as f64 * scale) as u32;
    let x_shown = pos.x + size.width as i32 - panel_w as i32;
    let x_hidden = pos.x + size.width as i32 - (TRIGGER_WIDTH as f64 * scale) as i32;
    Some(Geom { x_shown, x_hidden, y, h, panel_w })
}

/// 启动时调用：尺寸就位并贴到右缘收起位
pub fn dock_collapsed(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Some(g) = geometry(app) else { return };
    let _ = win.set_size(PhysicalSize::new(g.panel_w, g.h));
    let _ = win.set_position(PhysicalPosition::new(g.x_hidden, g.y));
    set_state(DockState::Collapsed);
}

pub fn in_trigger_zone(app: &AppHandle, cursor_x: i32) -> bool {
    match geometry(app) {
        Some(g) => cursor_x >= g.x_hidden,
        None => false,
    }
}

pub fn slide_in(app: &AppHandle) {
    if state() == DockState::Visible {
        return;
    }
    let Some(win) = app.get_webview_window("main") else { return };
    let Some(g) = geometry(app) else { return };
    set_state(DockState::Visible);
    animate(win, g.x_hidden, g.x_shown, g.y);
}

pub fn slide_out(app: &AppHandle) {
    if state() == DockState::Collapsed {
        return;
    }
    let Some(win) = app.get_webview_window("main") else { return };
    let Some(g) = geometry(app) else { return };
    set_state(DockState::Collapsed);
    animate(win, g.x_shown, g.x_hidden, g.y);
}

/// 60Hz ease-out 位移动画（移动窗口本体，而非 Webview 内 CSS）
fn animate(win: WebviewWindow, from: i32, to: i32, y: i32) {
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        loop {
            let t = (start.elapsed().as_millis().min(SLIDE_MS)) as f64 / SLIDE_MS as f64;
            let eased = 1.0 - (1.0 - t) * (1.0 - t);
            let x = from as f64 + (to - from) as f64 * eased;
            let _ = win.set_position(PhysicalPosition::new(x as i32, y));
            if t >= 1.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(FRAME_MS));
        }
    });
}

/// 前台窗口全屏检测（主屏近似判定，M0 够用）
#[cfg(windows)]
pub fn fullscreen_active() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetSystemMetrics, GetWindowRect, SM_CXSCREEN, SM_CYSCREEN,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut rc = RECT::default();
        if GetWindowRect(hwnd, &mut rc).is_err() {
            return false;
        }
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        rc.left <= 0 && rc.top <= 0 && rc.right >= w && rc.bottom >= h
    }
}

#[cfg(not(windows))]
pub fn fullscreen_active() -> bool {
    false
}
