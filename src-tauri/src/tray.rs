use crate::state::AppState;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Position, Rect, WebviewWindow};

const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 560.0;
const GAP: f64 = 6.0;

/// Focus-loss events that arrive sooner than this after showing the panel are
/// treated as activation noise rather than a real dismissal.
const FOCUS_GRACE_MS: i64 = 350;

/// When the panel was last shown, in milliseconds since the Unix epoch. Zero
/// means the tray has not shown it yet, so no dismissal is pending.
static SHOWN_AT_MS: AtomicI64 = AtomicI64::new(0);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Is the pointer currently over the panel? A spurious blur while the pointer
/// sits on the panel is a click *on* the panel, not a click away from it.
fn cursor_over_panel(window: &WebviewWindow) -> bool {
    let (Ok(cursor), Ok(origin), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    cursor.x >= origin.x as f64
        && cursor.y >= origin.y as f64
        && cursor.x < origin.x as f64 + size.width as f64
        && cursor.y < origin.y as f64 + size.height as f64
}

/// A 32px monochrome mark: a stock pot silhouette with a rising tick inside.
/// Template rendering lets macOS flip it for light/dark menu bars.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

fn labels(
    lang: &str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
) {
    match lang {
        "en" => (
            "Open Ledger",
            "Stock quotes",
            "Refresh now",
            "Settings…",
            "Quit Stockpot",
        ),
        "ja" => (
            "家計簿を開く",
            "株価パネル",
            "今すぐ更新",
            "設定…",
            "Stockpot を終了",
        ),
        _ => (
            "打开记账本",
            "股票行情",
            "立即刷新",
            "设置…",
            "退出 Stockpot",
        ),
    }
}

fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let (ledger_label, show_label, refresh_label, settings_label, quit_label) = labels(lang);
    let ledger = MenuItem::with_id(app, "ledger", ledger_label, true, None::<&str>)?;
    let show = MenuItem::with_id(app, "toggle", show_label, true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", refresh_label, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", settings_label, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    Menu::with_items(
        app,
        &[&ledger, &sep2, &show, &refresh, &settings, &sep, &quit],
    )
}

/// Rebuild the tray menu after a language switch. Menu labels are baked into
/// native menu items, so they cannot be patched in place.
pub fn reload_menu(app: &AppHandle) {
    let lang = {
                let state = app.state::<AppState>();
        state.settings().language
    };
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), build_menu(app, &lang)) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
        let lang = app.state::<AppState>().settings().language;
    let menu = build_menu(app, &lang)?;

    let image = Image::from_bytes(TRAY_ICON)?;
    let tray = TrayIconBuilder::with_id("main")
        .icon(image)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Stockpot")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "ledger" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::open_ledger_window(&app).await;
                });
            }
            "toggle" => toggle_panel(app),
            "refresh" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    state.refresh(&app).await;
                });
            }
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::open_settings_window(&app).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_panel_at(tray.app_handle(), Some(rect));
            }
        })
        .build(app)?;
    tray.set_icon_as_template(true)?;
    Ok(())
}

pub fn set_title(app: &AppHandle, label: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        // The image and title sit on the same baseline; a hair space keeps them
        // from touching and leaves the same gap on the right edge.
        let title = if label.is_empty() {
            String::new()
        } else {
            format!(" {label} ")
        };
        let _ = tray.set_title(Some(title));
    }
}

pub fn show_panel_at(app: &AppHandle, rect: Option<Rect>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    position(&window, rect);
    // Restart the grace window before the window is shown, so the activation
    // flap that Windows emits a few milliseconds later cannot close it.
    SHOWN_AT_MS.store(now_ms(), Ordering::Relaxed);
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn show_panel(app: &AppHandle) {
    let rect = app
        .tray_by_id("main")
        .and_then(|t| t.rect().ok().flatten());
    show_panel_at(app, rect);
}

pub fn toggle_panel(app: &AppHandle) {
    let rect = app
        .tray_by_id("main")
        .and_then(|t| t.rect().ok().flatten());
    toggle_panel_at(app, rect);
}

fn toggle_panel_at(app: &AppHandle, rect: Option<Rect>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show_panel_at(app, rect);
    }
}

/// Anchor the panel next to the tray icon, clamped to the visible monitor so a
/// tray item near the screen edge never pushes the panel off screen.
///
/// macOS puts the tray in a menu bar along the top, so the panel hangs below
/// it. Windows puts it in the taskbar, normally at the bottom, so the panel has
/// to open upwards instead — otherwise it would be drawn off screen.
fn position(window: &WebviewWindow, rect: Option<Rect>) {
    let scale = window.scale_factor().unwrap_or(2.0);
    let width = PANEL_WIDTH * scale;
    let height = PANEL_HEIGHT * scale;
    // On Windows the taskbar sits at the bottom of the monitor, so the panel is
    // placed above the tray icon rather than below it.
    let above_tray = cfg!(target_os = "windows");

    let Some(rect) = rect else {
        // No tray geometry available: fall back to the corner nearest the tray.
        if let Ok(Some(monitor)) = window.current_monitor() {
            let size = monitor.size();
            let pos = monitor.position();
            let x = pos.x as f64 + size.width as f64 - width - 12.0;
            let y = if above_tray {
                pos.y as f64 + size.height as f64 - height - 48.0
            } else {
                pos.y as f64 + 30.0
            };
            let _ = window.set_position(Position::Physical(tauri::PhysicalPosition::new(
                x as i32, y as i32,
            )));
        }
        return;
    };

    let (rx, ry, rw, rh) = (
        rect.position.to_physical::<f64>(1.0).x,
        rect.position.to_physical::<f64>(1.0).y,
        rect.size.to_physical::<f64>(1.0).width,
        rect.size.to_physical::<f64>(1.0).height,
    );
    let tray_center = rx + rw / 2.0;
    let mut x = tray_center - width / 2.0;
    let mut y = if above_tray {
        ry - height - GAP
    } else {
        ry + rh + GAP
    };

    if let Ok(Some(monitor)) = window.current_monitor() {
        let left = monitor.position().x as f64 + 8.0;
        let right = left + monitor.size().width as f64 - width - 16.0;
        x = x.clamp(left, right.max(left));

        // Keep the panel fully on screen even when the taskbar is docked at the
        // top, or on a monitor with a non-standard work area.
        let top = monitor.position().y as f64 + 8.0;
        let bottom = top + monitor.size().height as f64 - height - 8.0;
        y = y.clamp(top, bottom.max(top));
    }

    let _ = window.set_position(Position::Physical(tauri::PhysicalPosition::new(
        x as i32, y as i32,
    )));
}

/// Hide the panel when it loses focus, the way a native flyout behaves.
///
/// Windows reports a short `focused → blur → focused` flap while the WebView2
/// control is being activated, and it can also report a stray blur when a click
/// lands inside the webview. Reacting to every blur made the panel close the
/// instant it opened, or the moment a row was clicked — which left the panel
/// completely unusable. Three guards keep the dismissal honest:
///
/// * before the tray has ever shown the panel there is nothing to dismiss;
/// * a grace window right after showing absorbs the activation flap;
/// * never closing while the pointer is over the panel, because that blur came
///   from a click on the panel rather than a click away from it.
///
/// Note that focus is deliberately not tracked: re-showing an already-focused
/// window does not emit another `Focused(true)`, so a "has it been focused?"
/// flag would suppress exactly the blur that is supposed to close the panel.
///
/// The trade-off: when focus is moved away with the keyboard while the pointer
/// happens to rest on the panel, the panel stays until the next dismissal. That
/// is the safe direction to fail in — a sticky panel is recoverable (Esc, the
/// tray icon), a vanishing one is not.
pub fn install_dismiss_handler(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(false) => {
            let shown_at = SHOWN_AT_MS.load(Ordering::Relaxed);
            if shown_at == 0 {
                // The panel has never been shown from the tray, so there is
                // nothing to dismiss — this is the window being created hidden.
                return;
            }
            if now_ms() - shown_at < FOCUS_GRACE_MS {
                return;
            }
            if cursor_over_panel(&handle) {
                // The pointer is on the panel, so this blur came from a click
                // inside it. Stay open and take focus back so Esc and the
                // shortcuts keep working.
                let _ = handle.set_focus();
                return;
            }
            let _ = handle.hide();
        }
        _ => {}
    });
}
