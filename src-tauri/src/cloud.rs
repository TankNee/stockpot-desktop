//! 和服务器对账本。
//!
//! 两端的「账本」是同一份文档形状：账单、分类、钱包、项目、规则，外加自选股
//! 和券商账户（Android 那边也读这两个字段，所以桌面端推上去的东西它能直接用）。
//!
//! 只有一处单位对不上：桌面端持仓存的是「元 + 股数」两个 f64，Android 存的是
//! `costE4`（万分之一元）和整数股数。推之前换过去，拉回来换回来。
//!
//! 合并策略是「按 id 取并集，同 id 远端优先」：拉取嘛，云端那份说明别的设备
//! 更新过它；本地独有的行原样留着，不会因为同步就丢东西。

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::ledger;
use crate::model::Account;
use crate::state::AppState;
use crate::store;

/// 直接按数组处理的那几栏，元素靠 `id`（分类靠 `path`）认人。
const ARRAY_KEYS: [&str; 6] = [
    "entries",
    "categories",
    "imports",
    "wallets",
    "projects",
    "rules",
];

fn key_of(value: &Value) -> String {
    value
        .get("id")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("path").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

/// 本地整份文档。账本从 ledger.json 来，自选股和券商账户从 SQLite 那边来。
pub fn local_document(app: &AppHandle) -> Value {
    let state = app.state::<AppState>();
    let ledger = ledger::load(&state.dir);
    let mut doc = serde_json::to_value(&ledger).unwrap_or_else(|_| json!({}));

    let (stocks, accounts) = {
        let data = state.data.lock().unwrap();
        (
            serde_json::to_value(&data.stocks).unwrap_or_else(|_| json!([])),
            serde_json::to_value(&data.accounts).unwrap_or_else(|_| json!([])),
        )
    };

    if let Some(map) = doc.as_object_mut() {
        map.insert("stocks".into(), stocks);
        map.insert("stockAccounts".into(), to_wire_accounts(&accounts));
    }
    doc
}

/// 桌面端的持仓是「元」，Android 认的是「万分之一元」。
fn to_wire_accounts(accounts: &Value) -> Value {
    let Some(list) = accounts.as_array() else {
        return json!([]);
    };
    let out: Vec<Value> = list
        .iter()
        .map(|account| {
            let mut entries = Map::new();
            if let Some(map) = account.get("entries").and_then(|v| v.as_object()) {
                for (stock_id, position) in map {
                    let cost = position
                        .get("costPrice")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let shares = position.get("shares").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    entries.insert(
                        stock_id.clone(),
                        json!({
                            "costE4": (cost * 10_000.0).round() as i64,
                            "shares": shares.round() as i64,
                        }),
                    );
                }
            }
            json!({
                "id": account.get("id").cloned().unwrap_or(json!("")),
                "name": account.get("name").cloned().unwrap_or(json!("")),
                "note": "",
                "updatedAt": "",
                "entries": entries,
            })
        })
        .collect();
    Value::Array(out)
}

/// 反过来：万分之一元 → 元。
fn from_wire_accounts(value: &Value) -> Vec<Account> {
    let Some(list) = value.as_array() else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|account| {
            let id = account.get("id").and_then(|v| v.as_str())?.to_string();
            let name = account
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut entries = std::collections::HashMap::new();
            if let Some(map) = account.get("entries").and_then(|v| v.as_object()) {
                for (stock_id, position) in map {
                    let cost_e4 = position.get("costE4").and_then(|v| v.as_i64()).unwrap_or(0);
                    let shares = position.get("shares").and_then(|v| v.as_i64()).unwrap_or(0);
                    entries.insert(
                        stock_id.clone(),
                        crate::model::Position {
                            cost_price: cost_e4 as f64 / 10_000.0,
                            shares: shares as f64,
                        },
                    );
                }
            }
            Some(Account { id, name, entries })
        })
        .collect()
}

/// 把远端文档落到本地：账本写 ledger.json，自选股和持仓写回 SQLite。
pub fn apply_document(app: &AppHandle, doc: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();

    // 1) 账本那部分：把 stocks / stockAccounts 摘掉再反序列化，
    //    不然两份结构混在一起容易漏字段
    let mut ledger_value = doc.clone();
    if let Some(map) = ledger_value.as_object_mut() {
        map.remove("stocks");
        map.remove("stockAccounts");
    }
    let next: ledger::Ledger = serde_json::from_value(ledger_value)
        .map_err(|error| format!("云端账本读不出来：{error}"))?;
    ledger::save(&state.dir, &next)?;

    // 2) 自选股 / 券商账户
    let stocks: Vec<crate::model::Stock> = doc
        .get("stocks")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let accounts = from_wire_accounts(doc.get("stockAccounts").unwrap_or(&json!([])));

    {
        let mut data = state.data.lock().unwrap();
        data.stocks = stocks;
        data.accounts = accounts;
    }
    state.persist();

    Ok(summary(doc))
}

/// 文档有多大：设置页要拿它显示「云端 12 笔账、3 只自选股」。
pub fn summary(doc: &Value) -> Value {
    let count = |key: &str| {
        doc.get(key)
            .and_then(|v| v.as_array())
            .map(|list| list.len())
            .unwrap_or(0)
    };
    json!({
        "entries": count("entries"),
        "stocks": count("stocks"),
        "accounts": count("stockAccounts"),
        "wallets": count("wallets"),
    })
}

fn merge_arrays(local: Option<&Value>, remote: Option<&Value>) -> Option<Value> {
    let local_list = local.and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let remote_list = remote
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if local_list.is_empty() && remote_list.is_empty() {
        return None;
    }

    let mut out: Vec<Value> = Vec::with_capacity(local_list.len() + remote_list.len());
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for item in local_list {
        let key = key_of(&item);
        if key.is_empty() {
            out.push(item);
            continue;
        }
        index.insert(key, out.len());
        out.push(item);
    }
    // 远端同 id 的直接盖掉本地那条
    for item in remote_list {
        let key = key_of(&item);
        if key.is_empty() {
            out.push(item);
            continue;
        }
        match index.get(&key) {
            Some(&slot) => out[slot] = item,
            None => {
                index.insert(key, out.len());
                out.push(item);
            }
        }
    }
    Some(Value::Array(out))
}

/// 合并两份文档：本地打底，远端按 id 覆盖，本地独有的一律留着。
pub fn merge_documents(local: &Value, remote: &Value) -> Value {
    let mut out = local.clone();
    if !out.is_object() {
        out = json!({});
    }
    let Some(map) = out.as_object_mut() else {
        return out;
    };

    for key in ARRAY_KEYS {
        if let Some(merged) = merge_arrays(local.get(key), remote.get(key)) {
            map.insert(key.to_string(), merged);
        }
    }

    // 自选股按 id 并；券商账户整体用远端的（持仓是整张表，拆开合容易算出重复成本）
    if let Some(merged) = merge_arrays(local.get("stocks"), remote.get("stocks")) {
        map.insert("stocks".into(), merged);
    }
    if let Some(remote_accounts) = remote.get("stockAccounts") {
        if remote_accounts.as_array().is_some_and(|list| !list.is_empty()) {
            map.insert("stockAccounts".into(), remote_accounts.clone());
        }
    }

    // 几个忽略名单是字符串数组，直接并集
    for key in ["ignoredDuplicates", "ignoredRepayments"] {
        let mut seen: Vec<String> = Vec::new();
        for source in [local.get(key), remote.get(key)] {
            if let Some(list) = source.and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(text) = item.as_str() {
                        if !seen.iter().any(|existing| existing == text) {
                            seen.push(text.to_string());
                        }
                    }
                }
            }
        }
        if !seen.is_empty() {
            map.insert(key.into(), json!(seen));
        }
    }

    out
}

/// 空文档：云端没有东西、本地也没有东西时用它占位。
pub fn empty_document() -> Value {
    json!({
        "entries": [],
        "categories": [],
        "accounts": [],
        "imports": [],
        "wallets": [],
        "projects": [],
        "rules": [],
        "ignoredDuplicates": [],
        "ignoredRepayments": [],
        "schemaVersion": 0,
        "stocks": [],
        "stockAccounts": [],
    })
}

/// 本地有没有值得同步的东西——空账本 + 没自选股就别问了。
pub fn has_local_data(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let ledger = ledger::load(&state.dir);
    if !ledger.entries.is_empty() || !ledger.wallets.is_empty() || !ledger.projects.is_empty() {
        return true;
    }
    let data = state.data.lock().unwrap();
    !data.stocks.is_empty() || !data.accounts.is_empty()
}

/// 桌面端设置里那个服务器地址，和账号那块保持一致。
pub fn server_base(app: &AppHandle) -> String {
    const DEFAULT_SERVER: &str = "https://api.stockpot.neeto.cn";
    let state = app.state::<AppState>();
    let url = state.data.lock().unwrap().settings.server_url.clone();
    let trimmed = url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        DEFAULT_SERVER.to_string()
    } else {
        trimmed
    }
}

/// 本机存的会话令牌。
pub fn token(app: &AppHandle) -> Option<String> {
    let dir = store::data_dir(app);
    let value = store::kv_get(&dir, "auth.token").unwrap_or_default();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_local_only_rows_and_lets_remote_win_on_same_id() {
        let local = json!({
            "entries": [
                { "id": "a", "amount": 100 },
                { "id": "b", "amount": 200 }
            ],
            "stocks": [{ "id": "sh600000", "name": "浦发" }]
        });
        let remote = json!({
            "entries": [
                { "id": "a", "amount": 999 },
                { "id": "c", "amount": 300 }
            ],
            "stocks": [{ "id": "hk00700", "name": "腾讯" }]
        });
        let merged = merge_documents(&local, &remote);
        let entries = merged["entries"].as_array().unwrap();
        let ids: Vec<&str> = entries.iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // 同 id 用云端的
        assert_eq!(entries[0]["amount"], json!(999));
        // 自选股并集
        assert_eq!(merged["stocks"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn positions_convert_between_yuan_and_e4() {
        let desktop = json!([{
            "id": "acc1",
            "name": "主账户",
            "entries": { "sh600000": { "costPrice": 9.55, "shares": 100.0 } }
        }]);
        let wire = to_wire_accounts(&desktop);
        let position = &wire[0]["entries"]["sh600000"];
        assert_eq!(position["costE4"], json!(95_500));
        assert_eq!(position["shares"], json!(100));

        let back = from_wire_accounts(&wire);
        assert_eq!(back.len(), 1);
        let held = back[0].entries.get("sh600000").unwrap();
        assert!((held.cost_price - 9.55).abs() < 0.0001);
        assert!((held.shares - 100.0).abs() < 0.0001);
    }

    #[test]
    fn summary_counts_what_the_ui_shows() {
        let doc = json!({
            "entries": [{}, {}, {}],
            "stocks": [{}],
            "stockAccounts": [{}, {}],
            "wallets": []
        });
        let s = summary(&doc);
        assert_eq!(s["entries"], json!(3));
        assert_eq!(s["stocks"], json!(1));
        assert_eq!(s["accounts"], json!(2));
    }
}
