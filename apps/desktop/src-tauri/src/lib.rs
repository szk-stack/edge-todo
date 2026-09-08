mod edge_dock;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：重复启动时聚焦已有面板
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            tray::setup(app)?;
            edge_dock::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![edge_dock::set_dock_enabled])
        .run(tauri::generate_context!())
        .expect("error while running edge-todo");
}
