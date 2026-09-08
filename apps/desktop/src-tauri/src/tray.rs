//! 系统托盘：打开面板 / 暂停贴边 / 退出。
//! 注意：未配置 bundle icon 时 Windows 托盘显示空白图标，打包阶段在
//! tauri.conf.json 配齐 icons 后此处加 .icon(...)（M0 验证阶段不影响功能）。

use crate::edge_dock;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App,
};

pub fn setup(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开面板", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停 / 恢复贴边", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &pause, &quit])?;

    TrayIconBuilder::new()
        .tooltip("Edge Todo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => edge_dock::show_panel(app),
            "pause" => {
                edge_dock::toggle_enabled();
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
