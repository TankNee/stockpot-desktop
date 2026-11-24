//! Keep open windows in sync with edits made by the CLI or another process.
//!
//! The watcher observes the two JSON documents rather than sharing mutable
//! state between processes. A short debounce absorbs the temporary-file rename
//! and the backup writes that accompany one save.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::ledger;
use crate::state::AppState;
use crate::store;

struct DataWatcher {
    last_emit: Mutex<Instant>,
}

/// Watch ledger.json and stockpot.json. The watcher lives for the app's life;
/// events are emitted to every webview, which then re-reads the document.
pub fn start(app: &AppHandle) {
    let dir = store::data_dir(app);
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log::warn!("cannot watch data directory: {err}");
        return;
    }
    let app_for_events = app.clone();
    let dir_for_events = dir.clone();
    let watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        let Ok(event) = result else { return };
        if !matches!(event.kind, notify::EventKind::Modify(_) | notify::EventKind::Create(_)) {
            return;
        }
        let ledger_changed = event.paths.iter().any(|path| path.file_name().is_some_and(|name| name == "ledger.json"));
        let data_changed = event.paths.iter().any(|path| path.file_name().is_some_and(|name| name == "stockpot.json"));
        if !ledger_changed && !data_changed { return; }
        let app = app_for_events.clone();
        let dir = dir_for_events.clone();
        tauri::async_runtime::spawn(async move {
            // Writes are atomic renames followed by backup rotation. Wait for
            // the complete document before loading it.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let state = app.state::<DataWatcher>();
            let mut last = state.last_emit.lock().unwrap();
            if last.elapsed() < Duration::from_millis(180) { return; }
            *last = Instant::now();
            drop(last);
            if ledger_changed {
                let ledger = ledger::load(&dir);
                let _ = app.emit("ledger-changed", ledger);
            }
            if data_changed {
                let data = store::read_data_file(&dir);
                let app_state = app.state::<AppState>();
                *app_state.data.lock().unwrap() = data;
                let payload = app_state.payload();
                let _ = app.emit("app-payload", payload.clone());
                let _ = app.emit("settings-changed", payload);
            }
        });
    });
    match watcher {
        Ok(mut watcher) => {
            use notify::Watcher;
            if let Err(err) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
                log::warn!("cannot watch {}: {err}", dir.display());
                return;
            }
            app.manage(watcher);
        }
        Err(err) => log::warn!("cannot create data watcher: {err}"),
    }
}

/// The paths observed by the watcher, kept small and testable.
pub fn watched_paths(dir: &Path) -> Vec<PathBuf> {
    vec![dir.join("ledger.json"), dir.join("stockpot.json")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watches_both_documents() {
        let dir = Path::new("/tmp/stockpot");
        let paths = watched_paths(dir);
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().any(|p| p.ends_with("ledger.json")));
        assert!(paths.iter().any(|p| p.ends_with("stockpot.json")));
    }
}
