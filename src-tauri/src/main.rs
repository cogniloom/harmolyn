// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Tauri/WebKit can fall back to Linux rendering paths that produce a
        // blank window on some systems. On Wayland, keep the native backend
        // and disable WebKit's DMABUF renderer. On non-Wayland sessions,
        // prefer X11 unless the caller has explicitly chosen a backend.
        if is_wayland_session() {
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
            if std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
                std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
            }
        } else if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }

    harmolyn_lib::run()
}

#[cfg(target_os = "linux")]
fn is_wayland_session() -> bool {
    matches!(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        Some("wayland")
    ) || std::env::var_os("WAYLAND_DISPLAY").is_some()
}
