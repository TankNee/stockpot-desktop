use crate::model::AppData;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};

/// Stockpot 的数据落在一个 SQLite 库里，路径跟以前一样在每用户的应用目录下：
///
/// - macOS: `~/Library/Application Support/com.stockpot.app/stockpot.db`
/// - Windows: `%APPDATA%\com.stockpot.app\stockpot.db`
/// - Linux: `~/.local/share/com.stockpot.app/stockpot.db`
///
/// 表只有三张：`app_document` 存当前这份文档（一行 JSON，读进内存后照旧用
/// `AppData` 那个结构），`document_history` 留最近五份快照顶替以前的滚动备份，
/// `kv` 放账号令牌这类零碎。
///
/// 为什么不拆成「股票一张表、账户一张表」：这份文档只有几十 KB，读写都在内存里
/// 完成，拆表除了多几百行映射代码没有别的好处。换成 SQLite 要的是原子写入和
/// 一个不会因为半截写入就整个读不出来的文件。
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

pub fn db_path(dir: &Path) -> PathBuf {
    dir.join("stockpot.db")
}

/// 设置页显示的那个路径：现在是库文件，不再是那份 JSON。
pub fn data_path(app: &tauri::AppHandle) -> PathBuf {
    db_path(&data_dir(app))
}

pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

fn open_db(dir: &Path) -> std::io::Result<Connection> {
    ensure_dir(dir)?;
    let conn = Connection::open(db_path(dir)).map_err(io_err)?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(io_err)?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(io_err)?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(io_err)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_document (
             id TEXT PRIMARY KEY,
             json TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS document_history (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             json TEXT NOT NULL,
             at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS kv (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )
    .map_err(io_err)?;
    Ok(conn)
}

fn io_err(error: rusqlite::Error) -> std::io::Error {
    std::io::Error::other(error)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn read_data_file(dir: &Path) -> AppData {
    read_data_file_with_status(dir).0
}

/// Same as [`read_data_file`], but also reports whether the on-disk document
/// was in an older shape and should be rewritten straight away.
pub fn read_data_file_with_status(dir: &Path) -> (AppData, bool) {
    // 1) 新格式：库里有文档就直接用
    if let Some(raw) = read_document(dir) {
        return (decode(&raw, dir), false);
    }

    // 2) 老版本留下的 stockpot.json：读进来写进库，原文件改名留个档，
    //    不删——万一迁移逻辑有漏，人还能手动找回原来的东西
    let legacy = dir.join("stockpot.json");
    if let Ok(raw) = fs::read_to_string(&legacy) {
        let data = decode(&raw, dir);
        let _ = write_data_file(dir, &data);
        let _ = fs::rename(&legacy, dir.join("stockpot.json.migrated"));
        log::info!("已把 stockpot.json 迁移进 SQLite");
        return (data, true);
    }

    (AppData::default(), false)
}

fn decode(raw: &str, dir: &Path) -> AppData {
    match serde_json::from_str::<AppData>(raw) {
        Ok(mut data) => {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
            crate::model::migrate(&mut data, &value);
            data
        }
        Err(err) => {
            log::warn!("库里的文档坏了（{err}），试一下快照");
            let mut recovered = read_latest_snapshot(dir).unwrap_or_default();
            crate::model::migrate(&mut recovered, &serde_json::Value::Null);
            recovered
        }
    }
}

fn read_document(dir: &Path) -> Option<String> {
    let conn = open_db(dir).ok()?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT json FROM app_document WHERE id = 'current'",
            [],
            |row| row.get(0),
        )
        .ok();
    raw
}

fn read_latest_snapshot(dir: &Path) -> Option<AppData> {
    let conn = open_db(dir).ok()?;
    let mut stmt = conn
        .prepare("SELECT json FROM document_history ORDER BY seq DESC LIMIT 1")
        .ok()?;
    let raw: Option<String> = stmt.query_row([], |row| row.get(0)).ok();
    raw.and_then(|text| serde_json::from_str::<AppData>(&text).ok())
}

pub fn write_data_file(dir: &Path, data: &AppData) -> std::io::Result<()> {
    let json = serde_json::to_string(data)?;
    let at = now();
    let mut conn = open_db(dir)?;
    let tx = conn.transaction().map_err(io_err)?;
    // 旧的那份先躺进历史表，只留最近五条——够救命，不至于把库撑大
    tx.execute(
        "INSERT INTO document_history (json, at)
         SELECT json, updated_at FROM app_document WHERE id = 'current'",
        [],
    )
    .map_err(io_err)?;
    tx.execute(
        "DELETE FROM document_history
         WHERE seq NOT IN (SELECT seq FROM document_history ORDER BY seq DESC LIMIT 5)",
        [],
    )
    .map_err(io_err)?;
    tx.execute(
        "INSERT OR REPLACE INTO app_document (id, json, updated_at) VALUES ('current', ?1, ?2)",
        params![json, at],
    )
    .map_err(io_err)?;
    tx.commit().map_err(io_err)?;
    Ok(())
}

/// 一键清空：文档、快照、令牌全删，表留着。调用方负责把内存里的状态也重置。
pub fn clear_all(dir: &Path) -> std::io::Result<()> {
    let conn = open_db(dir)?;
    conn.execute_batch(
        "DELETE FROM app_document;
         DELETE FROM document_history;
         DELETE FROM kv;",
    )
    .map_err(io_err)?;
    // WAL 里可能还留着旧页，清完顺手收缩一下
    let _ = conn.execute_batch("VACUUM;");
    Ok(())
}

/* ------------------------------- 零碎键值 ------------------------------- */

pub fn kv_set(dir: &Path, key: &str, value: &str) -> std::io::Result<()> {
    let conn = open_db(dir)?;
    conn.execute(
        "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(io_err)?;
    Ok(())
}

pub fn kv_get(dir: &Path, key: &str) -> Option<String> {
    let conn = open_db(dir).ok()?;
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| {
        row.get(0)
    })
    .ok()
}

pub fn kv_remove(dir: &Path, key: &str) -> std::io::Result<()> {
    let conn = open_db(dir)?;
    conn.execute("DELETE FROM kv WHERE key = ?1", params![key])
        .map_err(io_err)?;
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

    fn sample() -> AppData {
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
        data
    }

    #[test]
    fn round_trips_through_sqlite() {
        let dir = temp_dir("roundtrip");
        let data = sample();
        write_data_file(&dir, &data).unwrap();
        assert!(db_path(&dir).exists());
        let loaded = read_data_file(&dir);
        assert_eq!(loaded.stocks.len(), 1);
        assert_eq!(loaded.stocks[0].name, "浦发银行");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_a_few_snapshots() {
        let dir = temp_dir("snapshots");
        for i in 0..8 {
            let mut data = sample();
            data.stocks[0].name = format!("版本{i}");
            write_data_file(&dir, &data).unwrap();
        }
        // 连接用完立刻放掉：Windows 上文件还被占着时删目录会失败
        let count: i64 = {
            let conn = open_db(&dir).unwrap();
            conn.query_row("SELECT COUNT(*) FROM document_history", [], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(count, 5);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn migrates_legacy_json_once() {
        let dir = temp_dir("legacy");
        let raw = serde_json::to_string(&sample()).unwrap();
        fs::write(dir.join("stockpot.json"), raw).unwrap();

        let (data, upgraded) = read_data_file_with_status(&dir);
        assert_eq!(data.stocks.len(), 1);
        assert!(upgraded);
        assert!(dir.join("stockpot.json.migrated").exists());
        // 第二次读就从库里来，不会重复迁移
        let again = read_data_file(&dir);
        assert_eq!(again.stocks.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn clears_everything() {
        let dir = temp_dir("clear");
        write_data_file(&dir, &sample()).unwrap();
        kv_set(&dir, "token", "abc").unwrap();
        clear_all(&dir).unwrap();
        assert!(read_data_file(&dir).stocks.is_empty());
        assert!(kv_get(&dir, "token").is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}
