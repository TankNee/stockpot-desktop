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
    // 用内存里那份，不要每次重新读盘：这个函数在自动同步的循环里每 2.5 秒调一次，
    // 几千条账本读 + 解析一次就是十几毫秒，纯属白烧。也不先 clone 一份，
    // 直接在锁里序列化——克隆同样要把每条账的三个字符串都复制一遍。
    let ledger_state = app.state::<crate::ledger::LedgerState>();
    let mut doc = {
        let ledger = ledger_state.ledger.lock().unwrap();
        serde_json::to_value(&*ledger).unwrap_or_else(|_| json!({}))
    };

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
    // 落盘 + 换掉内存里那份。只写盘的话，下一次编辑会拿旧的内存覆盖回来。
    app.state::<crate::ledger::LedgerState>().replace(next)?;

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

    #[test]
    fn fingerprint_is_stable_and_sensitive() {
        let a = json!({ "entries": [{ "id": "x" }], "stocks": [] });
        let b = json!({ "entries": [{ "id": "x" }], "stocks": [] });
        let c = json!({ "entries": [{ "id": "x" }, { "id": "y" }], "stocks": [] });
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    #[test]
    fn should_push_needs_sign_in_and_a_change() {
        // 没登录：怎么变都不推
        assert!(!should_push(1, 2, false));
        // 内容没变：不推
        assert!(!should_push(7, 7, true));
        // 登录了、内容变了：推
        assert!(should_push(7, 8, true));
    }

    #[test]
    fn merge_handles_empty_and_keyless_rows() {
        // 远端是空的：本地原样保留
        let local = json!({ "entries": [{ "id": "a" }] });
        let merged = merge_documents(&local, &json!({ "entries": [] }));
        assert_eq!(merged["entries"].as_array().unwrap().len(), 1);

        // 没有 id 的行不参与去重，两边都留着
        let local = json!({ "entries": [{ "date": "2026-11-01" }] });
        let remote = json!({ "entries": [{ "date": "2026-11-02" }] });
        let merged = merge_documents(&local, &remote);
        assert_eq!(merged["entries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn ignore_lists_are_unioned_without_duplicates() {
        let local = json!({ "ignoredDuplicates": ["a", "b"], "entries": [] });
        let remote = json!({ "ignoredDuplicates": ["b", "c"], "entries": [] });
        let merged = merge_documents(&local, &remote);
        let list: Vec<&str> = merged["ignoredDuplicates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(list, vec!["a", "b", "c"]);
    }

    #[test]
    fn wire_accounts_tolerate_missing_and_empty_bits() {
        // 空数组进去，空数组出来
        assert_eq!(to_wire_accounts(&json!([])).as_array().unwrap().len(), 0);
        // 缺 entries 的账户不该把整批搞崩
        let ruined = json!([{ "id": "a1", "name": "空账户" }]);
        let wire = to_wire_accounts(&ruined);
        assert_eq!(wire[0]["entries"], json!({}));
        let back = from_wire_accounts(&wire);
        assert_eq!(back.len(), 1);
        assert!(back[0].entries.is_empty());
    }

    #[test]
    fn empty_document_has_every_field_the_server_expects() {
        let doc = empty_document();
        assert!(doc["entries"].as_array().is_some());
        assert!(doc["stocks"].as_array().is_some());
        assert!(doc["stockAccounts"].as_array().is_some());
        // 服务器 PUT 的时候会检查 entries 是数组，别让它 400
        assert_eq!(summary(&doc)["entries"], json!(0));
    }
}

/* ------------------------------ 上行的通道 ------------------------------ */

use std::hash::{Hash, Hasher};

/// 要不要推：登录了、并且内容和上次推上去的不一样。
pub fn should_push(previous: u64, current: u64, signed_in: bool) -> bool {
    signed_in && previous != current
}

/// 文档指纹：内容一样就算没变过，避免每两秒都往服务器推一遍。
pub fn fingerprint(doc: &Value) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    doc.to_string().hash(&mut hasher);
    hasher.finish()
}

pub async fn fetch(app: &AppHandle) -> Result<Value, String> {
    let token = token(app).ok_or("先登录再同步")?;
    let base = server_base(app);
    let response = reqwest::Client::new()
        .get(format!("{base}/api/v1/ledger"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("连不上服务器：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("服务器没给账本（{}）", response.status().as_u16()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("账本读不出来：{error}"))
}

async fn put(app: &AppHandle, base_rev: u64, body: &str) -> Result<Option<Value>, String> {
    let token = token(app).ok_or("先登录再同步")?;
    let base = server_base(app);
    // body 已经是序列化好的账本文档，这里只在外面包一层 {baseRev, ledger}。
    // 原来是先拼一个 json!({..., "ledger": doc})：那会把整份账本深拷贝一遍，
    // 再整体序列化一次，三千多条时白白多花几十毫秒。
    let payload = format!("{{\"baseRev\":{base_rev},\"ledger\":{body}}}");
    let response = reqwest::Client::new()
        .put(format!("{base}/api/v1/ledger"))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .map_err(|error| format!("推不上去：{error}"))?;
    if response.status().is_success() {
        return Ok(None);
    }
    if response.status().as_u16() == 409 {
        // 服务器把手上那份一起带回来了，直接拿去合
        let remote = response
            .json::<Value>()
            .await
            .map_err(|error| format!("云端账本读不出来：{error}"))?;
        return Ok(Some(remote));
    }
    Err(format!("服务器拒收（{}）", response.status().as_u16()))
}

/// 把一份文档推上去。撞上别的设备改过（409）就拉下来合一次再推，
/// 最多来回两轮——再纠缠下去说明两台机器在互相顶，交给下次改动。
pub async fn push_document(app: &AppHandle, doc: Value) -> Result<Value, String> {
    let body = serde_json::to_string(&doc).map_err(|error| format!("账本序列化失败：{error}"))?;
    let mut current = doc;
    let mut json = body;
    for attempt in 0..2 {
        let remote = fetch(app).await?;
        let rev = remote.get("rev").and_then(|v| v.as_u64()).unwrap_or(0);
        match put(app, rev, &json).await {
            Ok(None) => return Ok(current),
            Ok(Some(remote_doc)) if attempt == 0 => {
                let remote_ledger = remote_doc.get("ledger").cloned().filter(|v| !v.is_null());
                if let Some(remote_ledger) = remote_ledger {
                    current = merge_documents(&current, &remote_ledger);
                    apply_document(app, &current)?;
                    json = serde_json::to_string(&current)
                        .map_err(|error| format!("账本序列化失败：{error}"))?;
                }
            }
            Ok(Some(_)) => return Err("同步一直在打架，下次改动再试".into()),
            Err(error) => return Err(error),
        }
    }
    Ok(current)
}

/// 本地文档「动没动」的便宜判据。
///
/// 账本三千多条时，把它摊成 `Value` 再转成字符串要几十毫秒；自动上行原来每
/// 2.5 秒就这么干一次，等于一直在后台烧 CPU，还占着账本的锁——界面正要点开
/// 列表或者保存，就得排队等它。现在先看改动计数器：没动就直接跳过，一个字节
/// 都不序列化。
fn local_stamp(app: &AppHandle) -> (u64, u64) {
    let rev = app.state::<crate::ledger::LedgerState>().revision();
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap();
    // 自选股和券商账户就这么点，序列化一次不到 1 KB
    let small = serde_json::to_vec(&(&data.stocks, &data.accounts)).unwrap_or_default();
    (rev, fingerprint_bytes(&small))
}

fn fingerprint_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// 后台自动上行。
///
/// 每 2.5 秒看一眼本地文档有没有变：变了就推，没变什么都不做。没有去挂钩每一个
/// 保存入口，是因为账本、自选股、CLI 三条路都能改数据，挂在保存点上总会漏一条；
/// 盯住「最后推上去的那份内容」反而不会漏。
///
/// 启动时先把当前内容记成「已推过」，不然一开 App 就把本地覆盖到云端。
pub fn start_autosync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut stamp = local_stamp(&app);
        let mut last = fingerprint(&local_document(&app));
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
            let now = local_stamp(&app);
            if token(&app).is_none() {
                // 退出登录后重新登录，应该以登录时的合并结果为准
                if now != stamp {
                    stamp = now;
                    last = fingerprint(&local_document(&app));
                }
                continue;
            }
            if now == stamp {
                // 这 2.5 秒里什么都没改：连指纹都不用算
                continue;
            }
            stamp = now;
            let doc = local_document(&app);
            let current = fingerprint(&doc);
            if !should_push(last, current, true) {
                last = current;
                continue;
            }
            match push_document(&app, doc).await {
                Ok(_) => {
                    last = current;
                    log::info!("[cloud] 本地改动已同步");
                }
                Err(error) => log::warn!("[cloud] 自动同步没成功：{error}"),
            }
        }
    });
}
