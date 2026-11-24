use crate::model::AppData;
use std::fs;
use std::path::{Path, PathBuf};

/// Stockpot keeps its data as a single human-readable JSON document plus a
/// rolling set of backups. Everything lives under the platform's per-user
/// application data folder:
///
/// - macOS: `~/Library/Application Support/com.stockpot.app/`
/// - Windows: `%APPDATA%\com.stockpot.app\`
/// - Linux: `~/.local/share/com.stockpot.app/`
pub fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    // An explicit override keeps test runs and portable installs out of the real
    // application data folder.
    if let Ok(dir) = std::env::var("STOCKPOT_DATA_DIR")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn data_path(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("stockpot.json")
}

pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

pub fn read_data_file(dir: &Path) -> AppData {
    read_data_file_with_status(dir).0
}

/// Same as [`read_data_file`], but also reports whether the on-disk document
/// was in an older shape and should be rewritten straight away.
pub fn read_data_file_with_status(dir: &Path) -> (AppData, bool) {
    let path = dir.join("stockpot.json");
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let before = serde_json::from_str::<AppData>(&raw).ok();
            let upgraded = before
                .as_ref()
                .map(|d| d.accounts.is_empty())
                .unwrap_or(true);
            let mut data = load_and_migrate(&raw, dir);
            crate::model::migrate(&mut data, &serde_json::Value::Null);
            (data, upgraded)
        }
        Err(_) => (AppData::default(), false),
    }
}

/// Parse, then fold older file shapes into the current one. Returns a default
/// document only when every candidate (live file, then backups) is unusable.
fn load_and_migrate(raw: &str, dir: &Path) -> AppData {
    match serde_json::from_str::<AppData>(raw) {
        Ok(mut data) => {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
            crate::model::migrate(&mut data, &value);
            data
        }
        Err(err) => {
            log::warn!("stockpot.json is malformed ({err}); trying backups");
            let mut recovered = read_latest_backup(dir).unwrap_or_default();
            crate::model::migrate(&mut recovered, &serde_json::Value::Null);
            recovered
        }
    }
}

fn read_latest_backup(dir: &Path) -> Option<AppData> {
    for i in 1..=10 {
        let p = dir.join(format!("stockpot.{i}.json"));
        if let Ok(raw) = fs::read_to_string(&p)
            && let Ok(data) = serde_json::from_str::<AppData>(&raw)
        {
            return Some(data);
        }
    }
    None
}

/// Rotate stockpot.1..10 before overwriting the live file. Keeps up to ten
/// snapshots so a bad edit or crashed write never destroys the watchlist.
fn rotate_backups(dir: &Path) {
    let live = dir.join("stockpot.json");
    if !live.exists() {
        return;
    }
    for i in (1..10).rev() {
        let from = dir.join(format!("stockpot.{i}.json"));
        let to = dir.join(format!("stockpot.{}.json", i + 1));
        if from.exists() {
            let _ = fs::remove_file(&to);
            let _ = fs::rename(&from, &to);
        }
    }
    let _ = fs::remove_file(dir.join("stockpot.1.json"));
    let _ = fs::copy(&live, dir.join("stockpot.1.json"));
}

pub fn write_data_file(dir: &Path, data: &AppData) -> std::io::Result<()> {
    ensure_dir(dir)?;
    rotate_backups(dir);
    let json = serde_json::to_vec_pretty(data)?;
    let tmp = dir.join("stockpot.json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(tmp, dir.join("stockpot.json"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Market, Stock};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stockpot-test-{tag}-{}", uuid::Uuid::new_v4()));
        ensure_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_and_rotates_backups() {
        let dir = temp_dir("roundtrip");
        let mut data = AppData::default();
        data.stocks.push(Stock {
            id: "sh600000".into(),
            code: "600000".into(),
            name: "浦发银行".into(),
            market: Market::A,
            alert: None,
            secid: None,
            legacy_cost_price: Some(9.5),
            legacy_shares: Some(100.0),
        });
        write_data_file(&dir, &data).unwrap();
        assert!(dir.join("stockpot.json").exists());
        let loaded = read_data_file(&dir);
        assert_eq!(loaded.stocks.len(), 1);
        assert_eq!(loaded.stocks[0].name, "浦发银行");

        // A second write rotates the previous document into stockpot.1.json.
        data.accounts.push(crate::model::Account::new("Broker"));
        write_data_file(&dir, &data).unwrap();
        assert!(dir.join("stockpot.1.json").exists());
        let backup = fs::read_to_string(dir.join("stockpot.1.json")).unwrap();
        assert!(backup.contains("100.0"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recovers_from_corrupt_document() {
        let dir = temp_dir("corrupt");
        write_data_file(&dir, &AppData::default()).unwrap();
        write_data_file(&dir, &AppData::default()).unwrap();
        fs::write(dir.join("stockpot.json"), "{not json").unwrap();
        // Falls back to the backup rather than exploding.
        let loaded = read_data_file(&dir);
        assert!(loaded.stocks.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
