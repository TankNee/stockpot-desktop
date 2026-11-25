//! A scriptable interface for agents and automation.
//!
//! `stockpot cli ...` reads and writes the same JSON documents as the GUI, but
//! never creates a window or starts a Tokio runtime. Every response is a single
//! JSON object on stdout; diagnostics and help go to stderr.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::ledger::{self, EntryInput, Ledger, LedgerState, ProjectInput, WalletInput};
use crate::model::{Account, AppData, Market, Position, Stock};
use crate::store;

#[derive(Debug, Clone, Default)]
struct Options {
    data_dir: Option<PathBuf>,
    ledger_file: Option<PathBuf>,
    data_file: Option<PathBuf>,
    output: Option<PathBuf>,
    command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct FieldUpdate {
    value: Option<Value>,
}

fn help() -> &'static str {
    r#"Stockpot CLI — read and modify the app's local data without opening the GUI.

Usage:
  stockpot cli [--data-dir DIR] COMMAND [ARGS]
  echo '{"command":"entries.search","query":"咖啡"}' | stockpot cli --stdin

Where the binary and data live:
  macOS    /Applications/Stockpot.app/Contents/MacOS/stockpot
           ~/Library/Application Support/com.stockpot.app
  Windows  %LOCALAPPDATA%\Stockpot\stockpot.exe   (per-user installer)
           %APPDATA%\com.stockpot.app
  Linux    /usr/bin/stockpot  (or target/release/stockpot)
           $XDG_DATA_HOME/com.stockpot.app  (~/.local/share/...)
  `cli doctor` prints the paths this machine actually resolves to.

Shell notes:
  Windows PowerShell cannot pass inline JSON reliably: write it to a file and
  pass `@C:\path\to\args.json`. Console output is UTF-8; run `chcp 65001`
  (cmd) or `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()` so Chinese
  names survive the pipe.
  macOS zsh/bash can pass inline JSON, but single-quote it: '{"a":1}'.

Commands:
  doctor
  skill                         print the complete agent guide
  ledger.show | ledger.export [--output FILE]
  entries.list [--limit N] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  entries.search QUERY [--limit N]
  entries.add JSON | entries.update ID JSON | entries.delete ID
  entries.clear
  entries.project IDS PROJECT_ID   (IDS: "a,b" or a JSON array; empty PROJECT_ID clears)
  entries.exclude IDS true|false   count or skip a row in the totals
  entries.archive IDS true|false   set aside / restore a row (nothing is deleted)
  entries.recategorize IDS CATEGORY
  entries.link-refund ENTRY_ID JSON   JSON: {"sourceId":"ID","amount":cents,"date":"YYYY-MM-DD"}
  projects.list | projects.add JSON | projects.update ID JSON
  projects.delete ID
  wallets.list | wallets.add JSON | wallets.update ID JSON | wallets.delete ID
  categories.list | categories.add JSON | categories.update PATH JSON
  categories.delete PATH | categories.reset
  rules.list | rules.add JSON | rules.update ID JSON | rules.delete ID
  rules.apply                   re-label every entry with the current rules
  ledger.preview FILE [--source wechat|alipay|icost]   parse only, no changes
  ledger.import FILE [--source wechat|alipay|icost]
  cleanup.report | cleanup.tidy
  cleanup.merge KEEP_ID REMOVE_IDS
  cleanup.ignore KIND KEY [true|false]
  cleanup.restore               undo every dismissal
  data.show | data.export [--output FILE]
  settings.show | settings.update JSON | settings.set KEY VALUE
  stocks.list | stocks.add JSON | stocks.update ID JSON | stocks.delete ID
  stocks.reorder IDS | stocks.clear
  stocks.alert ID JSON          JSON: {"targetPrice":12.5,"enabled":true,"direction":"rise"}
  stocks.search QUERY [--limit N]
  accounts.list | accounts.add JSON | accounts.update ID JSON | accounts.delete ID
  accounts.position ACCOUNT_ID STOCK_ID JSON
  market.quotes IDS             latest price for watchlist or ad-hoc ids
  market.chart ID               intraday minute series
  market.kline ID [PERIOD]      PERIOD: day | week | month (default day)
  market.sessions               which markets are open right now
  assets.show                   holdings valued at live quotes + manual balances

JSON arguments may be inline JSON or @file. Use --data-dir to select a portable
or test directory. Default: the app's normal per-user data directory.
Responses are {"ok":true,"data":...} or {"ok":false,"error":...}.
"#
}

/// The CLI must resolve the same folder the GUI writes to, so an agent and the
/// app never disagree about where the data lives.
fn default_dir() -> PathBuf {
    if let Ok(value) = std::env::var("STOCKPOT_DATA_DIR")
        && !value.is_empty()
    {
        return PathBuf::from(value);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library/Application Support/com.stockpot.app");
    }
    // Tauri maps `app_data_dir()` to `%APPDATA%` on Windows, i.e.
    // `C:\Users\<user>\AppData\Roaming\com.stockpot.app`.
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("com.stockpot.app");
    }
    // Other Unix desktops (Linux/BSD): match `dirs::data_dir()`.
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(data) = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    {
        return data.join("com.stockpot.app");
    }
    PathBuf::from(".")
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--data-dir" => {
                index += 1;
                let value = args.get(index).ok_or("missing-data-dir")?;
                options.data_dir = Some(PathBuf::from(value));
            }
            "--ledger-file" => {
                index += 1;
                options.ledger_file = Some(PathBuf::from(args.get(index).ok_or("missing-ledger-file")?));
            }
            "--data-file" => {
                index += 1;
                options.data_file = Some(PathBuf::from(args.get(index).ok_or("missing-data-file")?));
            }
            "--output" => {
                index += 1;
                options.output = Some(PathBuf::from(args.get(index).ok_or("missing-output")?));
            }
            "--stdin" => options.command.push("--stdin".into()),
            // Global options are recognized anywhere; command-specific flags
            // (from/to/limit/source) stay in the command tail for its own parser.
            "--from" | "--to" | "--limit" | "--source" => {
                options.command.push(args[index].clone());
                if index + 1 < args.len() {
                    options.command.push(args[index + 1].clone());
                    index += 1;
                }
            }
            value if value.starts_with('-') => return Err(format!("unknown-option:{value}")),
            _ => options.command.push(args[index].clone()),
        }
        index += 1;
    }
    Ok(options)
}

fn parse_json(text: &str) -> Result<Value, String> {
    if let Some(path) = text.strip_prefix('@') {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("read-json:{e}"))?;
        return serde_json::from_str(&raw).map_err(|e| format!("invalid-json:{e}"));
    }
    serde_json::from_str(text).map_err(|e| format!("invalid-json:{e}"))
}

fn argument(command: &[String], index: usize, name: &str) -> Result<String, String> {
    command.get(index).cloned().ok_or_else(|| format!("missing-{name}"))
}

fn object_argument(command: &[String], index: usize) -> Result<serde_json::Map<String, Value>, String> {
    match parse_json(&argument(command, index, "json")?)? {
        Value::Object(map) => Ok(map),
        _ => Err("expected-json-object".into()),
    }
}

/// A positional on/off flag. Accepts the spellings a person or an agent is
/// likely to type, so `entries.exclude IDS false` reads the same as JSON `false`.
fn parse_bool(raw: &str) -> Result<bool, String> {
    match raw.to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "include" => Ok(true),
        "false" | "0" | "no" | "off" | "clear" => Ok(false),
        _ => Err(format!("invalid-bool:{raw}")),
    }
}

fn bool_argument(command: &[String], index: usize) -> Result<bool, String> {
    parse_bool(&argument(command, index, "value")?)
}

fn optional_bool_argument(command: &[String], index: usize) -> Result<Option<bool>, String> {
    match command.get(index) {
        None => Ok(None),
        Some(raw) => Ok(Some(parse_bool(raw)?)),
    }
}

fn field(map: &serde_json::Map<String, Value>, key: &str) -> FieldUpdate {
    FieldUpdate { value: map.get(key).cloned() }
}

fn string_value(map: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    match field(map, key).value {
        Some(Value::String(value)) => Ok(value),
        Some(_) => Err(format!("invalid-field:{key}")),
        None => Ok(String::new()),
    }
}

fn optional_cents(map: &serde_json::Map<String, Value>, key: &str) -> Result<Option<i64>, String> {
    let Some(value) = field(map, key).value else { return Ok(None) };
    match value {
        Value::Number(number) => Ok(number.as_i64()),
        Value::String(text) => text
            .parse::<i64>()
            .map(Some)
            .map_err(|_| format!("invalid-cents:{key}")),
        _ => Err(format!("invalid-cents:{key}")),
    }
}

fn optional_bool(map: &serde_json::Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match field(map, key).value {
        Some(Value::Bool(value)) => Ok(Some(value)),
        Some(Value::String(text)) => text
            .parse::<bool>()
            .map(Some)
            .map_err(|_| format!("invalid-bool:{key}")),
        Some(_) => Err(format!("invalid-bool:{key}")),
        None => Ok(None),
    }
}

fn cents_from_yuan(map: &serde_json::Map<String, Value>) -> Result<Option<i64>, String> {
    if let Some(value) = field(map, "amount").value {
        return match value {
            Value::Number(number) => number.as_i64().ok_or("invalid-amount".into()).map(Some),
            Value::String(text) => text.parse::<i64>().map(Some).map_err(|_| "invalid-amount".into()),
            _ => Err("invalid-amount".into()),
        };
    }
    let Some(value) = field(map, "yuan").value else { return Ok(None) };
    let yuan = match value {
        Value::Number(number) => number.as_f64().ok_or("invalid-yuan")?,
        Value::String(text) => text.parse::<f64>().map_err(|_| "invalid-yuan")?,
        _ => return Err("invalid-yuan".into()),
    };
    if !yuan.is_finite() { return Err("invalid-yuan".into()); }
    Ok(Some((yuan.abs() * 100.0).round() as i64))
}

fn entry_input(map: &serde_json::Map<String, Value>) -> Result<EntryInput, String> {
    let date = string_value(map, "date")?;
    if date.is_empty() { return Err("missing-date".into()); }
    if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err("invalid-date".into());
    }
    let amount = cents_from_yuan(map)?.ok_or("missing-amount")?;
    if amount <= 0 { return Err("missing-amount".into()); }
    let kind = string_value(map, "kind")?;
    if !kind.is_empty() && !["expense", "income", "transfer"].contains(&kind.as_str()) {
        return Err("invalid-kind".into());
    }
    Ok(EntryInput {
        date,
        time: string_value(map, "time")?,
        kind,
        amount,
        category: string_value(map, "category")?,
        account: string_value(map, "account")?,
        counterparty: string_value(map, "counterparty")?,
        note: string_value(map, "note")?,
        excluded: optional_bool(map, "excluded")?.unwrap_or(false),
    })
}

fn wallet_input(map: &serde_json::Map<String, Value>) -> Result<WalletInput, String> {
    let balance = optional_cents(map, "balance")?.unwrap_or(cents_from_yuan(map)?.unwrap_or(0));
    Ok(WalletInput {
        name: string_value(map, "name")?,
        kind: string_value(map, "kind")?,
        institution: string_value(map, "institution")?,
        balance,
        note: string_value(map, "note")?,
    })
}

/// Reads an optional `projectId` from a JSON payload. Absent means "leave
/// membership alone"; an empty string means "clear it".
fn optional_project(map: &serde_json::Map<String, Value>) -> Option<String> {
    map.get("projectId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn project_input(map: &serde_json::Map<String, Value>) -> Result<ProjectInput, String> {    Ok(ProjectInput {
        name: string_value(map, "name")?,
        note: string_value(map, "note")?,
        start_date: string_value(map, "startDate")?,
        end_date: string_value(map, "endDate")?,
        archived: map.get("archived").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// A patch keeps the fields the caller did not mention, so
/// `{"archived":true}` archives a project without restating its dates.
fn project_patch(
    map: &serde_json::Map<String, Value>,
    project: &ledger::Project,
) -> Result<ProjectInput, String> {
    let field = |key: &str, current: &str| -> Result<String, String> {
        match map.get(key) {
            Some(Value::String(value)) => Ok(value.clone()),
            Some(Value::Null) => Ok(String::new()),
            Some(_) => Err(format!("invalid-{key}")),
            None => Ok(current.to_string()),
        }
    };
    Ok(ProjectInput {
        name: field("name", &project.name)?,
        note: field("note", &project.note)?,
        start_date: field("startDate", &project.start_date)?,
        end_date: field("endDate", &project.end_date)?,
        archived: map
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(project.archived),
    })
}

/// `entries.project` takes either a JSON array or a comma-separated list, because
/// both are natural to type in a shell.
fn id_list(value: &str) -> Result<Vec<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("missing-ids".into());
    }
    if trimmed.starts_with('[') {
        let ids: Vec<String> = serde_json::from_str(trimmed).map_err(|_| "invalid-ids")?;
        return Ok(ids.into_iter().filter(|id| !id.is_empty()).collect());
    }
    Ok(trimmed
        .split(',')
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect())
}

fn entry_patch(map: &serde_json::Map<String, Value>, entry: &ledger::Entry) -> Result<EntryInput, String> {
    let mut input = EntryInput {
        date: entry.date.clone(),
        time: entry.time.clone(),
        kind: entry.kind.clone(),
        amount: entry.amount,
        category: entry.category.clone(),
        account: entry.account.clone(),
        counterparty: entry.counterparty.clone(),
        note: entry.note.clone(),
        excluded: entry.excluded,
    };
    if let Some(value) = map.get("date").and_then(Value::as_str) { input.date = value.to_string(); }
    if let Some(value) = map.get("time").and_then(Value::as_str) { input.time = value.to_string(); }
    if let Some(value) = map.get("kind").and_then(Value::as_str) { input.kind = value.to_string(); }
    if let Some(value) = cents_from_yuan(map)? { input.amount = value; }
    if let Some(value) = map.get("category").and_then(Value::as_str) { input.category = value.to_string(); }
    if let Some(value) = map.get("account").and_then(Value::as_str) { input.account = value.to_string(); }
    if let Some(value) = map.get("counterparty").and_then(Value::as_str) { input.counterparty = value.to_string(); }
    if let Some(value) = map.get("note").and_then(Value::as_str) { input.note = value.to_string(); }
    if let Some(value) = optional_bool(map, "excluded")? { input.excluded = value; }
    if !map.contains_key("date") { input.date = entry.date.clone(); }
    if !map.contains_key("kind") { input.kind = entry.kind.clone(); }
    if !map.contains_key("amount") && !map.contains_key("yuan") { input.amount = entry.amount; }
    if !map.contains_key("time") { input.time = entry.time.clone(); }
    if !map.contains_key("category") { input.category = entry.category.clone(); }
    if !map.contains_key("account") { input.account = entry.account.clone(); }
    if !map.contains_key("counterparty") { input.counterparty = entry.counterparty.clone(); }
    if !map.contains_key("note") { input.note = entry.note.clone(); }
    if !map.contains_key("excluded") { input.excluded = entry.excluded; }
    if input.amount <= 0 { return Err("missing-amount".into()); }
    if chrono::NaiveDate::parse_from_str(&input.date, "%Y-%m-%d").is_err() {
        return Err("invalid-date".into());
    }
    Ok(input)
}

fn wallet_patch(map: &serde_json::Map<String, Value>, wallet: &ledger::Wallet) -> Result<WalletInput, String> {
    let mut input = wallet_input(map)?;
    if !map.contains_key("name") { input.name = wallet.name.clone(); }
    if !map.contains_key("kind") { input.kind = wallet.kind.clone(); }
    if !map.contains_key("institution") { input.institution = wallet.institution.clone(); }
    if !map.contains_key("note") { input.note = wallet.note.clone(); }
    if !map.contains_key("balance") && !map.contains_key("yuan") { input.balance = wallet.balance; }
    Ok(input)
}

fn entries_filtered(ledger: &Ledger, args: &[String]) -> Result<Vec<ledger::Entry>, String> {
    let mut from = "";
    let mut to = "";
    let mut limit = 100usize;
    let mut query: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--from" => { index += 1; from = args.get(index).ok_or("missing-from")?; }
            "--to" => { index += 1; to = args.get(index).ok_or("missing-to")?; }
            "--limit" => { index += 1; limit = args.get(index).ok_or("missing-limit")?.parse().map_err(|_| "invalid-limit")?; }
            value => query = Some(value.to_string()),
        }
        index += 1;
    }
    let query = query.map(|q| q.to_lowercase());
    let mut entries: Vec<ledger::Entry> = ledger.entries.iter().filter(|entry| {
        if !from.is_empty() && entry.date.as_str() < from { return false; }
        if !to.is_empty() && entry.date.as_str() > to { return false; }
        if let Some(query) = &query {
            let text = format!("{} {} {} {} {}", entry.date, entry.counterparty, entry.note, entry.category, entry.account).to_lowercase();
            if !text.contains(query) { return false; }
        }
        true
    }).cloned().collect();
    entries.truncate(limit);
    Ok(entries)
}

fn apply_ledger_command(options: &Options, command: &[String]) -> Result<Value, String> {
    let dir = options.data_dir.clone().unwrap_or_else(default_dir);
    if let Some(path) = &options.ledger_file {
        let state = LedgerState::new(path.parent().unwrap_or(Path::new(".")).to_path_buf());
        // The custom file is copied into an isolated directory rather than
        // silently overwriting ledger.json under the selected directory.
        if path.exists() && *path != state.dir.join("ledger.json") {
            std::fs::copy(path, state.dir.join("ledger.json")).map_err(|e| e.to_string())?;
        }
        let _ = state;
    }
    let state = LedgerState::new(dir);
    let name = command.first().map(String::as_str).unwrap_or("");
    match name {
        "ledger.show" | "ledger.export" => Ok(json!(state.snapshot())),
        "entries.list" | "entries.search" => Ok(json!(entries_filtered(&state.snapshot(), &command[1..])?)),
        "entries.add" => {
            let map = object_argument(command, 1)?;
            let project_id = optional_project(&map);
            let before = state.snapshot();
            let mut ledger = state.add(entry_input(&map)?)?;
            let created_id = ledger
                .entries
                .iter()
                .find(|e| !before.entries.iter().any(|old| old.id == e.id))
                .map(|e| e.id.clone());
            // `projectId` in the payload attaches the new row in the same call.
            if let (Some(pid), Some(id)) = (&project_id, &created_id) {
                ledger = state.set_project(vec![id.clone()], pid)?;
            }
            // Read the entry back from the final ledger so the response shows the
            // membership it now has, not the state right after the insert.
            let entry = created_id.and_then(|id| ledger.entries.iter().find(|e| e.id == id).cloned());
            Ok(json!({"ledger": ledger, "entry": entry}))
        }
        "entries.update" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let project_id = optional_project(&map);
            let entry = state.snapshot().entries.into_iter().find(|e| e.id == id).ok_or("missing-entry")?;
            let mut ledger = state.update(&id, entry_patch(&map, &entry)?)?;
            if let Some(pid) = project_id {
                ledger = state.set_project(vec![id], &pid)?;
            }
            Ok(json!(ledger))
        }
        "entries.delete" => Ok(json!(state.delete(&argument(command, 1, "id")?)?)),
        "entries.clear" => Ok(json!(state.clear()?)),
        // Assign or clear project membership for one or many rows at once.
        "entries.project" => {
            let ids = id_list(&argument(command, 1, "ids")?)?;
            let project_id = command.get(2).cloned().unwrap_or_default();
            Ok(json!(state.set_project(ids, &project_id)?))
        }
        // Flags the GUI toggles from the row menu: excluded (counted nowhere)
        // and archived (set aside by 整理账单, restorable).
        "entries.exclude" => {
            let ids = id_list(&argument(command, 1, "ids")?)?;
            let excluded = bool_argument(command, 2)?;
            Ok(json!(state.set_excluded(ids, excluded)?))
        }
        "entries.archive" => {
            let ids = id_list(&argument(command, 1, "ids")?)?;
            let archived = bool_argument(command, 2)?;
            Ok(json!(state.set_archived(ids, archived)?))
        }
        // Re-label rows in bulk; this is the GUI's "move to category" action.
        "entries.recategorize" => {
            let ids = id_list(&argument(command, 1, "ids")?)?;
            let category = argument(command, 2, "category")?;
            Ok(json!(state.recategorize(ids, &category)?))
        }
        // Link an incoming refund to the purchase it reverses.
        "entries.link-refund" => {
            let entry_id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let input = ledger::RefundLinkInput {
                entry_id,
                source_id: map
                    .get("sourceId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                amount: optional_cents(&map, "amount")?
                    .or(cents_from_yuan(&map)?)
                    .unwrap_or(0),
                date: string_value(&map, "date")?,
            };
            Ok(json!(state.link_refund(input)?))
        }
        "rules.apply" => Ok(json!(state.apply_rules_to_all()?)),
        // 整理账单, one command per action the page offers.
        "cleanup.report" => Ok(state.cleanup_report()),
        "cleanup.merge" => {
            let keep = argument(command, 1, "keep-id")?;
            let remove = id_list(&argument(command, 2, "remove-ids")?)?;
            Ok(json!(state.merge_entries(&keep, &remove)?))
        }
        "cleanup.ignore" => {
            let kind = argument(command, 1, "kind")?;
            let key = argument(command, 2, "key")?;
            let ignored = optional_bool_argument(command, 3)?.unwrap_or(true);
            Ok(json!(state.ignore_cleanup(&kind, &key, ignored)?))
        }
        "cleanup.restore" => Ok(json!(state.restore_ignored()?)),
        "cleanup.tidy" => Ok(serde_json::to_value(state.auto_tidy()?).map_err(|e| e.to_string())?),
        "projects.list" => Ok(json!(state.snapshot().projects)),
        "projects.add" => {
            let before = state.snapshot();
            let ledger = state.add_project(project_input(&object_argument(command, 1)?)?)?;
            let project = ledger.projects.iter().find(|p| !before.projects.iter().any(|old| old.id == p.id));
            Ok(json!({"ledger": ledger, "project": project}))
        }
        "projects.update" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let project = state.snapshot().projects.into_iter().find(|p| p.id == id).ok_or("missing-project")?;
            Ok(json!(state.update_project(&id, project_patch(&map, &project)?)?))
        }
        "projects.delete" => Ok(json!(state.delete_project(&argument(command, 1, "id")?)?)),
        "wallets.list" => Ok(json!(state.snapshot().wallets)),
        "wallets.add" => {
            let before = state.snapshot();
            let ledger = state.add_wallet(wallet_input(&object_argument(command, 1)?)?)?;
            let wallet = ledger.wallets.iter().find(|w| !before.wallets.iter().any(|old| old.id == w.id));
            Ok(json!({"ledger": ledger, "wallet": wallet}))
        }
        "wallets.update" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let wallet = state.snapshot().wallets.into_iter().find(|w| w.id == id).ok_or("missing-wallet")?;
            Ok(json!(state.update_wallet(&id, wallet_patch(&map, &wallet)?)?))
        }
        "wallets.delete" => Ok(json!(state.delete_wallet(&argument(command, 1, "id")?)?)),
        "categories.list" => Ok(json!(state.snapshot().categories)),
        "categories.add" => {
            let map = object_argument(command, 1)?;
            Ok(json!(state.add_category(&string_value(&map, "name")?, &string_value(&map, "parent")?, &string_value(&map, "icon")?, &string_value(&map, "kind")?, &string_value(&map, "description")?)?))
        }
        "categories.update" => {
            let path = argument(command, 1, "path")?;
            let map = object_argument(command, 2)?;
            let current = state.snapshot().categories.into_iter().find(|c| c.path() == path).ok_or("missing-category")?;
            let name = string_value(&map, "name")?;
            let parent = string_value(&map, "parent")?;
            let icon = string_value(&map, "icon")?;
            let kind = string_value(&map, "kind")?;
            let description = string_value(&map, "description")?;
            Ok(json!(state.update_category(&current.name, &current.parent, if name.is_empty() { &current.name } else { &name }, &parent, &icon, &kind, &description)?))
        }
        "categories.delete" => Ok(json!(state.delete_category(&argument(command, 1, "path")?)?)),
        "categories.reset" => Ok(json!(state.reset_categories()?)),
        "rules.list" => Ok(json!(state.snapshot().rules)),
        "rules.add" => {
            let map = object_argument(command, 1)?;
            Ok(json!(state.add_rule(&string_value(&map, "pattern")?, &string_value(&map, "category")?)?))
        }
        "rules.update" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            Ok(json!(state.update_rule(&id, &string_value(&map, "pattern")?, &string_value(&map, "category")?)?))
        }
        "rules.delete" => Ok(json!(state.delete_rule(&argument(command, 1, "id")?)?)),
        // Parse without importing: the same preview the GUI's confirm dialog
        // shows, so an agent can check a file before committing it.
        "ledger.preview" => {
            let path = argument(command, 1, "file")?;
            let bytes = std::fs::read(&path).map_err(|e| format!("read-bill:{e}"))?;
            let forced = data_arg(command, "--source");
            Ok(state.preview_import(&bytes, forced.as_deref())?)
        }
        "ledger.import" => {
            let path = argument(command, 1, "file")?;
            let bytes = std::fs::read(&path).map_err(|e| format!("read-bill:{e}"))?;
            // `--source wechat|alipay|icost` overrides auto-detection, the same
            // choice the import page offers.
            let forced = data_arg(command, "--source");
            Ok(serde_json::to_value(state.import_as(&path, &bytes, forced.as_deref())?)
                .map_err(|e| e.to_string())?)
        }
        _ => Err(format!("unknown-command:{name}")),
    }
}

fn market(value: &str) -> Result<Market, String> {
    match value.to_lowercase().as_str() {
        "a" => Ok(Market::A),
        "hk" => Ok(Market::Hk),
        "us" => Ok(Market::Us),
        "kr" => Ok(Market::Kr),
        _ => Err("invalid-market".into()),
    }
}

fn apply_data_command(options: &Options, command: &[String]) -> Result<Value, String> {
    let dir = options.data_dir.clone().unwrap_or_else(default_dir);
    let data_path = options.data_file.clone().unwrap_or_else(|| dir.join("stockpot.json"));
    let mut data = if data_path.exists() {
        let raw = std::fs::read_to_string(&data_path).map_err(|e| e.to_string())?;
        serde_json::from_str::<AppData>(&raw).map_err(|e| format!("invalid-data:{e}"))?
    } else { AppData::default() };
    let name = command.first().map(String::as_str).unwrap_or("");
    match name {
        "data.show" | "data.export" => Ok(serde_json::to_value(data).map_err(|e| e.to_string())?),
        "settings.show" => Ok(json!(data.settings)),
        "settings.update" => {
            let patch = object_argument(command, 1)?;
            let mut value = serde_json::to_value(&data.settings).map_err(|e| e.to_string())?;
            let target = value.as_object_mut().ok_or("invalid-settings")?;
            for (key, value) in patch { target.insert(key, value); }
            data.settings = serde_json::from_value(value).map_err(|e| format!("invalid-settings:{e}"))?;
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.settings))
        }
        "settings.set" => {
            let key = argument(command, 1, "key")?;
            let value = parse_json(&argument(command, 2, "value")?)?;
            let mut settings = serde_json::to_value(&data.settings).map_err(|e| e.to_string())?;
            settings.as_object_mut().ok_or("invalid-settings")?.insert(key, value);
            data.settings = serde_json::from_value(settings).map_err(|e| format!("invalid-settings:{e}"))?;
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.settings))
        }
        "stocks.list" => Ok(json!(data.stocks)),
        "stocks.add" => {
            let map = object_argument(command, 1)?;
            let stock = Stock {
                id: string_value(&map, "id")?,
                code: string_value(&map, "code")?,
                name: string_value(&map, "name")?,
                market: market(&string_value(&map, "market")?)?,
                alert: None,
                secid: field(&map, "secid").value.and_then(|v| v.as_str().map(str::to_string)),
                legacy_cost_price: None,
                legacy_shares: None,
            };
            if stock.id.is_empty() || stock.code.is_empty() || stock.name.is_empty() { return Err("missing-stock".into()); }
            if data.stocks.iter().any(|s| s.id == stock.id) { return Err("duplicate".into()); }
            data.stocks.push(stock);
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.stocks))
        }
        "stocks.update" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let stock = data.stocks.iter_mut().find(|s| s.id == id).ok_or("missing-stock")?;
            let code = string_value(&map, "code")?;
            let name = string_value(&map, "name")?;
            let market_name = string_value(&map, "market")?;
            if !code.is_empty() { stock.code = code; }
            if !name.is_empty() { stock.name = name; }
            if !market_name.is_empty() { stock.market = market(&market_name)?; }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.stocks))
        }
        "stocks.delete" => {
            let id = argument(command, 1, "id")?;
            let before = data.stocks.len();
            data.stocks.retain(|s| s.id != id);
            if data.stocks.len() == before { return Err("missing-stock".into()); }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.stocks))
        }
        "accounts.list" => Ok(json!(data.accounts)),
        "accounts.add" => {
            let map = object_argument(command, 1)?;
            let name = string_value(&map, "name")?;
            if name.is_empty() { return Err("missing-name".into()); }
            let account = Account::new(name);
            data.accounts.push(account.clone());
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(account))
        }
        "accounts.update" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let account = data.accounts.iter_mut().find(|a| a.id == id).ok_or("missing-account")?;
            let name = string_value(&map, "name")?;
            if !name.is_empty() { account.name = name; }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.accounts))
        }
        "accounts.delete" => {
            let id = argument(command, 1, "id")?;
            let before = data.accounts.len();
            data.accounts.retain(|a| a.id != id);
            if data.accounts.len() == before { return Err("missing-account".into()); }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.accounts))
        }
        "accounts.position" => {
            let account_id = argument(command, 1, "account-id")?;
            let stock_id = argument(command, 2, "stock-id")?;
            let map = object_argument(command, 3)?;
            let account = data.accounts.iter_mut().find(|a| a.id == account_id).ok_or("missing-account")?;
            let remove = optional_bool(&map, "delete")?.unwrap_or(false);
            if remove { account.entries.remove(&stock_id); }
            else {
                let cost = map.get("costPrice").and_then(Value::as_f64).ok_or("missing-cost-price")?;
                let shares = map.get("shares").and_then(Value::as_f64).ok_or("missing-shares")?;
                if cost < 0.0 || shares <= 0.0 { return Err("invalid-position".into()); }
                account.entries.insert(stock_id, Position { cost_price: cost, shares });
            }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.accounts))
        }
        // Drag order / sort rule from the watchlist, expressed as the full list.
        "stocks.reorder" => {
            let ids = id_list(&argument(command, 1, "ids")?)?;
            let mut reordered = Vec::with_capacity(data.stocks.len());
            for id in &ids {
                if let Some(pos) = data.stocks.iter().position(|s| &s.id == id) {
                    reordered.push(data.stocks.remove(pos));
                }
            }
            // Anything not named keeps its relative order at the end, so a
            // partial list is an ordering hint rather than a delete.
            reordered.append(&mut data.stocks);
            data.stocks = reordered;
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.stocks))
        }
        // Price alert: same fields the GUI's alert editor writes, including the
        // rise/fall direction it derives from the current price when it can.
        "stocks.alert" => {
            let id = argument(command, 1, "id")?;
            let map = object_argument(command, 2)?;
            let stock = data.stocks.iter_mut().find(|s| s.id == id).ok_or("missing-stock")?;
            let enabled = optional_bool(&map, "enabled")?.unwrap_or(false);
            if !enabled {
                stock.alert = None;
            } else {
                let target = map
                    .get("targetPrice")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .ok_or("missing-target-price")?;
                // Without a live quote there is no "current price" to compare
                // against, so the direction stays unset unless the caller names
                // it; the app fills it in on the next refresh.
                let direction = match map.get("direction").and_then(Value::as_str) {
                    Some("rise") => Some(crate::model::AlertDirection::Rise),
                    Some("fall") => Some(crate::model::AlertDirection::Fall),
                    _ => stock.alert.as_ref().and_then(|alert| alert.direction),
                };
                stock.alert = Some(crate::model::PriceAlert {
                    target_price: target,
                    direction,
                    enabled: true,
                });
            }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.stocks))
        }
        // The GUI's "clear all" also drops positions and the menu-bar pick, so
        // the CLI must do the same or the app would show stale holdings.
        "stocks.clear" => {
            data.stocks.clear();
            data.settings.menu_bar_stock_id.clear();
            for account in data.accounts.iter_mut() {
                account.entries.clear();
            }
            store::write_data_file(&dir, &data).map_err(|e| e.to_string())?;
            Ok(json!(data.stocks))
        }
        "stocks.search" => {
            let query = argument(command, 1, "query")?;
            let limit = optional_usize(&data_arg(command, "--limit"))?.unwrap_or(24);
            let client = crate::providers::client();
            let mut found = block_on(crate::providers::search(&client, &query))?;
            found.truncate(limit);
            Ok(serde_json::to_value(found).map_err(|e| e.to_string())?)
        }
        // Live market data, for an agent that needs to read a quote or a chart
        // without opening the app.
        "market.quotes" => {
            let ids = id_list(&argument(command, 1, "ids")?)?;
            let mut wanted: Vec<Stock> = Vec::new();
            for id in &ids {
                match data.stocks.iter().find(|s| &s.id == id) {
                    Some(stock) => wanted.push(stock.clone()),
                    None => wanted.push(crate::synthetic_stock(id)),
                }
            }
            let client = crate::providers::client();
            let raw = block_on(crate::providers::quotes(&client, &wanted))?;
            let quotes: Vec<Value> = wanted
                .iter()
                .map(|stock| {
                    let found = raw.iter().find(|r| r.id == stock.id);
                    json!({
                        "id": stock.id,
                        "name": found.map(|r| r.name.clone()).unwrap_or_else(|| stock.name.clone()),
                        "market": stock.market.key(),
                        "currency": stock.market.currency(),
                        "price": found.map(|r| r.price),
                        "prevClose": found.map(|r| r.prev_close),
                        "changePercent": found.and_then(|r| (r.prev_close > 0.0).then(|| (r.price - r.prev_close) / r.prev_close * 100.0)),
                        "time": found.map(|r| r.time.clone()),
                    })
                })
                .collect();
            Ok(json!(quotes))
        }
        "market.chart" => {
            let id = argument(command, 1, "id")?;
            let stock = data.stocks.iter().find(|s| s.id == id).cloned().unwrap_or_else(|| crate::synthetic_stock(&id));
            let client = crate::providers::client();
            let secid = stock.secid().unwrap_or_default();
            // `block_on` adds one Result layer and the fetch adds another.
            let series = block_on(crate::chart::intraday(&client, &stock.id, stock.market, &secid))??;
            Ok(serde_json::to_value(series).map_err(|e| e.to_string())?)
        }
        "market.kline" => {
            let id = argument(command, 1, "id")?;
            let period = command.get(2).cloned().unwrap_or_else(|| "day".into());
            let stock = data.stocks.iter().find(|s| s.id == id).cloned().unwrap_or_else(|| crate::synthetic_stock(&id));
            let Some(period) = crate::kline::Period::parse(&period) else {
                return Err("bad-period".into());
            };
            let client = crate::providers::client();
            let series = block_on(crate::kline::fetch(&client, &stock.id, &crate::kline::secid_for(&stock), period))??;
            Ok(serde_json::to_value(series).map_err(|e| e.to_string())?)
        }
        // Which markets are open right now, computed locally.
        "market.sessions" => {
            let now = chrono::Utc::now();
            let mut map = serde_json::Map::new();
            for market in Market::all() {
                map.insert(
                    market.key().to_string(),
                    json!(crate::market::session(market, now)),
                );
            }
            Ok(Value::Object(map))
        }
        // The net-worth view from the 总览 page: holdings valued at live quotes,
        // converted into the ledger's display currency, plus the manual balances.
        "assets.show" => {
            let ledger = ledger::load(&dir);
            let currency = data.settings.currency.clone();
            let client = crate::providers::client();
            let raw = block_on(crate::providers::quotes(&client, &data.stocks))?;
            let rates = block_on(crate::providers::sina_rates(&client))?.unwrap_or_default();
            let mut lines = Vec::new();
            let mut market_value = 0.0f64;
            let mut cost = 0.0f64;
            for stock in data.stocks.iter() {
                let Some(merged) = crate::model::merge_positions(&data.accounts, &stock.id) else {
                    continue;
                };
                let Some(quote) = raw.iter().find(|r| r.id == stock.id) else {
                    continue;
                };
                let value = rates.convert(merged.value(quote.price), stock.market, &currency);
                let basis = rates.convert(merged.basis(), stock.market, &currency);
                market_value += value;
                cost += basis;
                lines.push(json!({
                    "id": stock.id,
                    "name": stock.name,
                    "market": stock.market.key(),
                    "shares": merged.shares,
                    "price": quote.price,
                    "currency": currency,
                    "value": (value * 100.0).round() as i64,
                    "cost": (basis * 100.0).round() as i64,
                    "pnl": ((value - basis) * 100.0).round() as i64,
                }));
            }
            let wallets: i64 = ledger.wallets.iter().map(|wallet| wallet.balance).sum();
            let stock_value = (market_value * 100.0).round() as i64;
            let stock_cost = (cost * 100.0).round() as i64;
            Ok(json!({
                "currency": currency,
                "stocks": lines,
                "stockValue": stock_value,
                "stockCost": stock_cost,
                "stockPnl": stock_value - stock_cost,
                "walletBalance": wallets,
                "totalAssets": stock_value + wallets,
            }))
        }
        _ => Err(format!("unknown-command:{name}")),
    }
}

/// Run one async fetch from the headless CLI. The CLI deliberately keeps no
/// long-lived runtime, so each network command builds a single-threaded one and
/// drops it again; that also keeps the GUI's Tokio pool out of this process.
fn block_on<F: std::future::Future>(future: F) -> Result<F::Output, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("runtime:{e}"))?;
    Ok(runtime.block_on(future))
}

/// Read a `--flag value` pair out of the command words.
fn data_arg(command: &[String], flag: &str) -> Option<String> {
    command
        .iter()
        .position(|word| word == flag)
        .and_then(|index| command.get(index + 1).cloned())
}

fn optional_usize(raw: &Option<String>) -> Result<Option<usize>, String> {
    match raw {
        None => Ok(None),
        Some(text) => text
            .parse::<usize>()
            .map(Some)
            .map_err(|_| format!("invalid-number:{text}")),
    }
}

fn doctor(options: &Options) -> Result<Value, String> {
    let dir = options.data_dir.clone().unwrap_or_else(default_dir);
    let ledger = ledger::load(&dir);
    let data = store::read_data_file(&dir);
    let ollama_url = format!("{}/systemone", data.settings.ai_endpoint.trim_end_matches('/'));
    Ok(json!({
        "dataDir": dir,
        "entries": ledger.entries.len(),
        "categories": ledger.categories.len(),
        "wallets": ledger.wallets.len(),
        "stocks": data.stocks.len(),
        "accounts": data.accounts.len(),
        "ai": {"endpoint": ollama_url, "model": data.settings.ai_model, "configured": !data.settings.ai_endpoint.is_empty() && !data.settings.ai_model.is_empty()},
        "ledgerFile": ledger::ledger_path(&dir),
        "dataFile": dir.join("stockpot.json"),
    }))
}

/// Run one CLI invocation. This function performs no GUI or network startup.
pub fn run(args: &[String]) -> i32 {
    match run_inner(args) {
        Ok(value) => {
            match serde_json::to_string_pretty(&json!({"ok": true, "data": value})) {
                Ok(text) => println!("{text}"),
                Err(err) => { eprintln!("{err}"); return 2; }
            }
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn run_inner(args: &[String]) -> Result<Value, String> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", help());
        return Ok(json!({"help": true}));
    }
    let options = parse_options(args)?;
    let command = if options.command.first().map(String::as_str) == Some("--stdin") {
        let mut input = String::new();
        use std::io::Read;
        std::io::stdin().read_to_string(&mut input).map_err(|e| e.to_string())?;
        let value = parse_json(input.trim())?;
        let object = value.as_object().ok_or("expected-json-object")?;
        let name = object.get("command").and_then(Value::as_str).ok_or("missing-command")?;
        let mut command = vec![name.to_string()];
        if let Some(args) = object.get("args").and_then(Value::as_array) {
            for arg in args { command.push(arg.as_str().ok_or("invalid-args")?.to_string()); }
        }
        // Also accept named filters, so agents need not construct argv arrays.
        for (field, flag) in [("query", "query"), ("from", "--from"), ("to", "--to"), ("limit", "--limit")] {
            if let Some(value) = object.get(field) {
                let value = value.as_str().map(str::to_string).or_else(|| value.as_i64().map(|n| n.to_string())).ok_or("invalid-filter")?;
                if flag == "query" { command.push(value); } else { command.extend([flag.to_string(), value]); }
            }
        }
        command
    } else { options.command.clone() };
    if command.first().map(String::as_str) == Some("skill") {
        println!("{}", include_str!("../../skills/stockpot/SKILL.md"));
        return Ok(json!({"skill": "stockpot", "path": "skills/stockpot/SKILL.md"}));
    }
    if command.first().map(String::as_str) == Some("doctor") { return doctor(&options); }
    // Ledger commands share the bookkeeping file; everything else (settings,
    // stocks, accounts, market data) works on stockpot.json or the network.
    let ledger_command = command
        .first()
        .map(String::as_str)
        .map(|name| {
            [
                "entries.",
                "ledger.",
                "wallets.",
                "categories.",
                "rules.",
                "projects.",
                "cleanup.",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        })
        .unwrap_or(false);
    let value = if ledger_command {
        apply_ledger_command(&options, &command)?
    } else {
        apply_data_command(&options, &command)?
    };
    if let Some(output) = options.output {
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(&output, text).map_err(|e| e.to_string())?;
        return Ok(json!({"output": output, "bytes": std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0)}));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stockpot-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn args(dir: &Path, values: &[&str]) -> Vec<String> {
        let mut out = vec!["--data-dir".into(), dir.to_string_lossy().to_string()];
        out.extend(values.iter().map(|s| s.to_string()));
        out
    }

    #[test]
    fn cli_supports_entry_crud_and_search() {
        let dir = temp_dir();
        println!("created test");
        let created = run_inner(&args(&dir, &["entries.add", r#"{"date":"2025-07-01","kind":"expense","yuan":19.5,"category":"餐饮/咖啡","counterparty":"瑞幸咖啡"}"#])).unwrap();
        println!("created {}", created);
        let id = created["entry"]["id"].as_str().unwrap().to_string();
        let found = run_inner(&args(&dir, &["entries.search", "瑞幸"])).unwrap();
        assert_eq!(found.as_array().unwrap().len(), 1);
        let updated = run_inner(&args(&dir, &["entries.update", &id, r#"{"note":"拿铁"}"#])).unwrap();
        assert_eq!(updated["entries"][0]["note"], "拿铁");
        assert_eq!(updated["entries"][0]["amount"], 1950);
        run_inner(&args(&dir, &["entries.delete", &id])).unwrap();
        assert!(run_inner(&args(&dir, &["entries.search", "瑞幸"])).unwrap().as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_groups_entries_into_a_project() {
        let dir = temp_dir();
        // A project is a membership layer: creating one must not touch entries.
        let created = run_inner(&args(&dir, &["projects.add", r#"{"name":"北海道旅行","startDate":"2026-01-10","endDate":"2026-01-18"}"#])).unwrap();
        let project_id = created["project"]["id"].as_str().unwrap().to_string();

        // `projectId` in the payload attaches the row as it is created.
        let attached = run_inner(&args(&dir, &[
            "entries.add",
            &format!(r#"{{"date":"2026-01-11","kind":"expense","yuan":128.5,"category":"餐饮","projectId":"{project_id}"}}"#),
        ])).unwrap();
        assert_eq!(attached["entry"]["projectId"], project_id);

        // Bulk assignment takes a comma-separated list.
        let loose = run_inner(&args(&dir, &["entries.add", r#"{"date":"2026-01-12","kind":"expense","yuan":320,"category":"交通"}"#])).unwrap();
        let loose_id = loose["entry"]["id"].as_str().unwrap().to_string();
        let grouped = run_inner(&args(&dir, &["entries.project", &loose_id, &project_id])).unwrap();
        assert_eq!(grouped["entries"].as_array().unwrap().iter().filter(|e| e["projectId"] == project_id).count(), 2);

        // Clearing membership keeps the money fields.
        let cleared = run_inner(&args(&dir, &["entries.project", &loose_id, ""])).unwrap();
        assert_eq!(cleared["entries"].as_array().unwrap().iter().filter(|e| e["projectId"] == project_id).count(), 1);

        // Deleting the project keeps every entry and just drops the grouping.
        let deleted = run_inner(&args(&dir, &["projects.delete", &project_id])).unwrap();
        let entries = deleted["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e["projectId"] == ""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_updates_settings_and_wallets() {
        let dir = temp_dir();
        let settings = run_inner(&args(&dir, &["settings.update", r#"{"theme":"dark","language":"en"}"#])).unwrap();
        assert_eq!(settings["theme"], "dark");
        let wallet = run_inner(&args(&dir, &["wallets.add", r#"{"name":"现金","kind":"cash","balance":1200}"#])).unwrap();
        let id = wallet["wallet"]["id"].as_str().unwrap().to_string();
        let updated = run_inner(&args(&dir, &["wallets.update", &id, r#"{"yuan":20}"#])).unwrap();
        assert_eq!(updated["wallets"][0]["balance"], 2000);
        assert_eq!(updated["wallets"][0]["kind"], "cash");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn date_filters_work_in_argv_and_stdin() {
        // 这一条要靠「stdin 读到 EOF」才会返回。在终端里直接跑 cargo test 时
        // stdin 是控制台，读下去就永远不返回，整个测试套件会挂在这儿。
        // CI 里 stdin 是 /dev/null，所以只有本机会中招——不是代码的毛病。
        use std::io::IsTerminal;
        if std::io::stdin().is_terminal() {
            eprintln!("stdin 是终端，跳过：这条要有 EOF 才走得到");
            return;
        }
        let dir = temp_dir();
        for (date, merchant) in [("2026-10-01", "十月"), ("2026-10-31", "月末"), ("2026-11-01", "十一月")] {
            let input = format!(r#"{{"date":"{date}","kind":"expense","yuan":1,"category":"其他","counterparty":"{merchant}"}}"#);
            run_inner(&args(&dir, &["entries.add", &input])).unwrap();
        }
        let filtered = run_inner(&args(&dir, &["entries.list", "--from", "2026-10-01", "--to", "2026-10-31", "--limit", "1000"])).unwrap();
        assert_eq!(filtered.as_array().unwrap().len(), 2);
        let stdin = run_inner(&args(&dir, &["--stdin"])).unwrap_err();
        assert!(stdin.contains("read") || stdin.contains("invalid") || stdin.contains("expected"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_reject_unknown_keys() {
        let dir = temp_dir();
        let err = run_inner(&args(&dir, &["settings.set", "notASetting", "true"])).unwrap_err();
        assert!(err.contains("invalid-settings"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_commands_fail() {
        let dir = temp_dir();
        assert!(run_inner(&args(&dir, &["entries.add", "{}"])).is_err());
        assert!(run_inner(&args(&dir, &["unknown.command"])).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
