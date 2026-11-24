pub mod ai;
pub mod chart;
pub mod cli;
pub mod kline;
pub mod ledger;
pub mod market;
pub mod model;
pub mod notify;
pub mod providers;
pub mod state;
pub mod store;
pub mod sync;
pub mod tray;

use model::*;
use state::AppState;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Prices below 10 need three decimals to stay informative (penny stocks and
/// HK warrants live down there); everything else uses two.
pub fn format_price(value: f64) -> String {
    if value.abs() >= 1000.0 {
        format!("{value:.0}")
    } else if value.abs() >= 10.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.3}")
    }
}

fn with_state<R>(app: &AppHandle, f: impl FnOnce(&AppState) -> R) -> R {
    let state = app.state::<AppState>();
    f(&state)
}

fn broadcast(app: &AppHandle, state: &AppState) {
    let _ = app.emit("snapshot", state.payload());
    tray::set_title(app, &state.tray_label());
}

#[tauri::command]
async fn get_app(app: AppHandle) -> serde_json::Value {
    let payload = with_state(&app, |s| s.payload());
    let launch = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    };
    let notified = notify::is_granted(&app);
    let mut value = payload;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("notifyGranted".into(), serde_json::json!(notified));
        obj.insert("launchAtLogin".into(), serde_json::json!(launch));
        obj.insert(
            "dataFile".into(),
            serde_json::json!(store::data_path(&app).to_string_lossy()),
        );
    }
    value
}

#[tauri::command]
async fn refresh(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    state.refresh(&app).await;
    Ok(state.payload())
}

#[tauri::command]
async fn search(app: AppHandle, keyword: String) -> Result<Vec<SearchResult>, String> {
    let client = with_state(&app, |s| s.http.clone());
    Ok(providers::search(&client, &keyword).await)
}

#[tauri::command]
async fn add_stock(app: AppHandle, result: SearchResult) -> Result<serde_json::Value, String> {
    {
        let state = app.state::<AppState>();
        let mut data = state.data.lock().unwrap();
        if data.stocks.iter().any(|s| s.id == result.id) {
            return Ok(state.payload());
        }
        data.stocks.push(Stock {
            id: result.id.clone(),
            code: result.code.clone(),
            name: result.name.clone(),
            market: result.market,
            alert: None,
            secid: (!result.secid.is_empty()).then_some(result.secid.clone()),
            legacy_cost_price: None,
            legacy_shares: None,
        });
        drop(data);
        state.persist();
    }
    let state = app.state::<AppState>();
    state.refresh(&app).await;
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

/// Fetch quotes for ids that are not on the watchlist (search results). Merged
/// into the snapshot only; nothing is persisted.
#[tauri::command]
async fn preview_quotes(app: AppHandle, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    if ids.is_empty() {
        return Ok(state.payload());
    }
    let (client, wanted) = {
        let data = state.data.lock().unwrap();
        let synthetic: Vec<Stock> = ids
            .iter()
            .filter(|id| !data.stocks.iter().any(|s| &s.id == *id))
            .map(|id| synthetic_stock(id))
            .collect();
        (state.http.clone(), synthetic)
    };
    if wanted.is_empty() {
        return Ok(state.payload());
    }

    let a_ids: Vec<String> = wanted
        .iter()
        .filter(|s| s.market == Market::A)
        .map(|s| s.id.clone())
        .collect();
    let us_ids: Vec<String> = wanted
        .iter()
        .filter(|s| s.market == Market::Us)
        .map(|s| s.id.clone())
        .collect();
    let hk_codes: Vec<String> = wanted
        .iter()
        .filter(|s| s.market == Market::Hk)
        .map(|s| s.code.clone())
        .collect();
    let kr_codes: Vec<String> = wanted
        .iter()
        .filter(|s| s.market == Market::Kr)
        .map(|s| s.code.clone())
        .collect();
    let em_targets: Vec<(String, String, Market)> = Vec::new();

    let (sina_a, sina_us, tencent, tencent_kr, eastmoney) = futures::join!(
        providers::sina_quotes(&client, &a_ids, Market::A),
        providers::sina_quotes(&client, &us_ids, Market::Us),
        providers::tencent_hk_quotes(&client, &hk_codes),
        providers::tencent_kr_quotes(&client, &kr_codes),
        providers::eastmoney_quotes(&client, &em_targets),
    );
    let mut fetched: std::collections::HashMap<String, Quote> = std::collections::HashMap::new();
    for raw in sina_a
        .iter()
        .chain(sina_us.iter())
        .chain(tencent.iter())
        .chain(tencent_kr.iter())
    {
        let Some(stock) = wanted.iter().find(|s| s.id == raw.id) else {
            continue;
        };
        let change = raw.price - raw.prev_close;
        fetched.insert(
            stock.id.clone(),
            Quote {
                id: stock.id.clone(),
                name: raw.name.clone(),
                price: raw.price,
                change,
                change_percent: if raw.prev_close > 0.0 {
                    change / raw.prev_close * 100.0
                } else {
                    0.0
                },
                prev_close: raw.prev_close,
                time: raw.time.clone(),
                currency: stock.market.currency().to_string(),
                extended_price: raw.extended_price,
                extended_change_percent: None,
                extended_label: None,
            },
        );
    }
    for raw in eastmoney.iter() {
        let Some(stock) = wanted.iter().find(|s| s.id == raw.id) else {
            continue;
        };
        if fetched.contains_key(&stock.id) {
            continue;
        }
        let change = raw.price - raw.prev_close;
        fetched.insert(
            stock.id.clone(),
            Quote {
                id: stock.id.clone(),
                name: raw.name.clone(),
                price: raw.price,
                change,
                change_percent: if raw.prev_close > 0.0 {
                    change / raw.prev_close * 100.0
                } else {
                    0.0
                },
                prev_close: raw.prev_close,
                time: String::new(),
                currency: stock.market.currency().to_string(),
                extended_price: None,
                extended_change_percent: None,
                extended_label: None,
            },
        );
    }
    {
        let mut snap = state.snapshot.lock().unwrap();
        for (id, mut quote) in fetched {
            quote.extended_change_percent = match (quote.extended_price, quote.price) {
                (Some(ext), price) if price > 0.0 => Some((ext - price) / price * 100.0),
                _ => None,
            };
            snap.quotes.insert(id, quote);
        }
    }
    Ok(state.payload())
}

/// Build a throw-away stock record from a watchlist id, so previews can reuse
/// the same fetch path without persisting anything.
/// A stock record for an id that is not on the watchlist yet. Previewing a
/// search result and the CLI's `market.quotes` both need this before anything
/// is persisted.
pub(crate) fn synthetic_stock(id: &str) -> Stock {
    let (market, code) = if let Some(rest) = id.strip_prefix("hk") {
        (Market::Hk, rest.to_string())
    } else if let Some(rest) = id.strip_prefix("usr_") {
        (Market::Us, rest.replace('_', ".").to_uppercase())
    } else if let Some(rest) = id.strip_prefix("kr_") {
        (Market::Kr, rest.to_string())
    } else {
        (
            Market::A,
            id.trim_start_matches(|c: char| c.is_ascii_alphabetic()).to_string(),
        )
    };
    Stock {
        id: id.to_string(),
        code,
        name: String::new(),
        market,
        alert: None,
        secid: None,
        legacy_cost_price: None,
        legacy_shares: None,
    }
}

#[tauri::command]
async fn remove_stock(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        data.stocks.retain(|s| s.id != id);
        if data.settings.menu_bar_stock_id == id {
            data.settings.menu_bar_stock_id.clear();
        }
        for account in data.accounts.iter_mut() {
            account.entries.remove(&id);
        }
    }
    {
        let mut snap = state.snapshot.lock().unwrap();
        snap.quotes.remove(&id);
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

#[tauri::command]
async fn reorder_stocks(app: AppHandle, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        let mut reordered = Vec::with_capacity(data.stocks.len());
        for id in &ids {
            if let Some(pos) = data.stocks.iter().position(|s| &s.id == id) {
                reordered.push(data.stocks.remove(pos));
            }
        }
        reordered.append(&mut data.stocks);
        data.stocks = reordered;
    }
    state.persist();
    Ok(state.payload())
}

/// Upsert (or clear) one stock's position inside one account. Passing a null
/// cost or share count removes that lot, which is how "clear position" works
/// without losing the account itself.
#[tauri::command]
async fn set_position(
    app: AppHandle,
    account_id: String,
    stock_id: String,
    cost_price: Option<f64>,
    shares: Option<f64>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        let cost = cost_price.filter(|v| v.is_finite() && *v > 0.0);
        let count = shares.filter(|v| v.is_finite() && *v > 0.0);
        let Some(account) = data.accounts.iter_mut().find(|a| a.id == account_id) else {
            return Err("unknown-account".into());
        };
        match (cost, count) {
            (Some(c), Some(s)) => {
                account.entries.insert(stock_id, Position {
                    cost_price: c,
                    shares: s,
                });
            }
            _ => {
                account.entries.remove(&stock_id);
            }
        }
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

#[tauri::command]
async fn create_account(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("empty-name".into());
    }
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        if data.accounts.iter().any(|a| a.name == name) {
            return Err("duplicate-name".into());
        }
        data.accounts.push(Account::new(name));
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

#[tauri::command]
async fn rename_account(app: AppHandle, id: String, name: String) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("empty-name".into());
    }
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        if data.accounts.iter().any(|a| a.name == name && a.id != id) {
            return Err("duplicate-name".into());
        }
        let Some(account) = data.accounts.iter_mut().find(|a| a.id == id) else {
            return Err("unknown-account".into());
        };
        account.name = name;
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

/// Deleting an account removes only its own lots; the stocks stay on the
/// watchlist and any other account's positions are untouched.
#[tauri::command]
async fn delete_account(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        if data.accounts.len() <= 1 {
            return Err("last-account".into());
        }
        data.accounts.retain(|a| a.id != id);
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

#[tauri::command]
async fn update_alert(
    app: AppHandle,
    id: String,
    target_price: Option<f64>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let now = chrono::Utc::now();
    {
        let snap = state.snapshot.lock().unwrap().clone();
        let mut data = state.data.lock().unwrap();
        let Some(index) = data.stocks.iter().position(|s| s.id == id) else {
            return Err("unknown-stock".into());
        };
        let target = target_price.filter(|v| v.is_finite() && *v > 0.0);
        let stock = &data.stocks[index];
        let current = snap
            .quotes
            .get(&id)
            .and_then(|q| state::alert_price(stock, q, now))
            .map(|(p, _)| p);
        let previous = stock.alert.clone();
        let next = target.map(|target_price| {
            let stays_armed = previous
                .as_ref()
                .map(|a| a.enabled && (a.target_price - target_price).abs() < 1e-9)
                .unwrap_or(false);
            let direction = if enabled && !stays_armed {
                current.map(|price| PriceAlert::direction_for(target_price, price))
            } else {
                previous.as_ref().and_then(|a| a.direction)
            };
            PriceAlert {
                target_price,
                direction,
                enabled,
            }
        });
        data.stocks[index].alert = next;
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

#[tauri::command]
async fn update_settings(app: AppHandle, patch: serde_json::Value) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let (language_changed, dock_changed, show_dock) = {
        let mut data = state.data.lock().unwrap();
        let before_lang = data.settings.language.clone();
        let before_dock = data.settings.show_dock_icon;
        apply_settings_patch(&mut data.settings, &patch);
        (
            before_lang != data.settings.language,
            before_dock != data.settings.show_dock_icon,
            data.settings.show_dock_icon,
        )
    };
    // The Dock tile only exists on macOS; elsewhere these two values are simply
    // unused, so keep them silent rather than warning on every Windows build.
    #[cfg(target_os = "macos")]
    if dock_changed {
        // Toggles the Dock tile immediately; no relaunch needed.
        let _ = app.set_activation_policy(if show_dock {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (dock_changed, show_dock);
    state.persist();
    if language_changed {
        tray::reload_menu(&app);
    }
    let payload = state.payload();
    broadcast(&app, &state);
    // Other windows (the ledger) keep their own React tree; tell them the
    // shared settings moved so language and theme follow immediately.
    let _ = app.emit("settings-changed", payload.clone());
    Ok(payload)
}

fn apply_settings_patch(settings: &mut Settings, patch: &serde_json::Value) {
    let Some(map) = patch.as_object() else { return };
    for (key, value) in map {
        match key.as_str() {
            "menuBarMode" => {
                if let Some(v) = value.as_str() {
                    settings.menu_bar_mode = v.to_string();
                }
            }
            "menuBarStockId" => {
                if let Some(v) = value.as_str() {
                    settings.menu_bar_stock_id = v.to_string();
                }
            }
            "refreshInterval" => {
                if let Some(v) = value.as_u64() {
                    settings.refresh_interval = v.clamp(3, 300);
                }
            }
            "colorScheme" => {
                if let Some(v) = value.as_str() {
                    settings.color_scheme = v.to_string();
                }
            }
            "currency" => {
                if let Some(v) = value.as_str() {
                    settings.currency = v.to_string();
                }
            }
            "sortRule" => {
                if let Some(v) = value.as_str() {
                    settings.sort_rule = v.to_string();
                }
            }
            "usPriceMode" => {
                if let Some(v) = value.as_str() {
                    settings.us_price_mode = v.to_string();
                }
            }
            "groupHoldings" => {
                if let Some(v) = value.as_bool() {
                    settings.group_holdings = v;
                }
            }
            "theme" => {
                if let Some(v) = value.as_str() {
                    settings.theme = v.to_string();
                }
            }
            "language" => {
                if let Some(v) = value.as_str() {
                    settings.language = v.to_string();
                }
            }
            "launchAtLogin" => {
                if let Some(v) = value.as_bool() {
                    settings.launch_at_login = v;
                }
            }
            "pnlDisplay" => {
                if let Some(v) = value.as_str() {
                    settings.pnl_display = v.to_string();
                }
            }
            "aiEndpoint" => {
                if let Some(v) = value.as_str() {
                    settings.ai_endpoint = v.trim().to_string();
                }
            }
            "aiModel" => {
                if let Some(v) = value.as_str() {
                    settings.ai_model = v.trim().to_string();
                }
            }
            "aiApiKey" => {
                if let Some(v) = value.as_str() {
                    settings.ai_api_key = v.trim().to_string();
                }
            }
            "aiBatchSize" => {
                if let Some(v) = value.as_u64() {
                    settings.ai_batch_size = v.clamp(1, 100) as u32;
                }
            }
            "flashDuration" => {
                if let Some(v) = value.as_str() {
                    settings.flash_duration = v.to_string();
                }
            }
            "menuBarPnlFormat" => {
                if let Some(v) = value.as_str() {
                    settings.menu_bar_pnl_format = v.to_string();
                }
            }
            "showDockIcon" => {
                if let Some(v) = value.as_bool() {
                    settings.show_dock_icon = v;
                }
            }
            _ => {}
        }
    }
}

#[tauri::command]
async fn kline(app: AppHandle, id: String, period: String) -> Result<KlineData, String> {
    let (client, stock) = {
        let state = app.state::<AppState>();
        let data = state.data.lock().unwrap();
        let stock = data.stocks.iter().find(|s| s.id == id).cloned();
        (state.http.clone(), stock)
    };
    let Some(stock) = stock else {
        return Err("unknown-stock".into());
    };
    let Some(period) = kline::Period::parse(&period) else {
        return Err("bad-period".into());
    };
    kline::fetch(&client, &stock.id, &kline::secid_for(&stock), period).await
}

#[tauri::command]
async fn chart(app: AppHandle, id: String) -> Result<ChartData, String> {
    let (client, stock) = {
        let state = app.state::<AppState>();
        let data = state.data.lock().unwrap();
        let stock = data.stocks.iter().find(|s| s.id == id).cloned();
        (state.http.clone(), stock)
    };
    let Some(stock) = stock else {
        return Err("unknown-stock".into());
    };
    let secid = stock.secid().unwrap_or_default();
    chart::intraday(&client, &stock.id, stock.market, &secid).await
}

#[tauri::command]
async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| e.to_string())?;
    Ok(manager.is_enabled().unwrap_or(false))
}

#[tauri::command]
fn request_notification_permission(app: AppHandle) -> bool {
    notify::request_permission(&app)
}

#[tauri::command]
fn test_notification(app: AppHandle) -> bool {
    notify::send_test(&app)
}

/// Open (or focus) the wide settings window. It is a separate webview so the
/// menu bar panel keeps its compact layout while preferences get room to
/// breathe — a holdings table with inline cost/share editing needs width.
pub async fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    open_settings(app.clone()).await
}


// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

fn with_ledger<R>(app: &AppHandle, f: impl FnOnce(&ledger::LedgerState) -> R) -> R {
    let state = app.state::<ledger::LedgerState>();
    f(&state)
}

/// Stock holdings, priced for the ledger's asset panel. Money is in cents of the
/// display currency so the ledger can add it to its own numbers.
#[tauri::command]
async fn ledger_assets(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let data = state.data.lock().unwrap().clone();
    let snap = state.snapshot.lock().unwrap().clone();
    let currency = data.settings.currency.clone();
    let mut lines = Vec::new();
    let mut market_value = 0.0f64;
    let mut cost = 0.0f64;
    for stock in data.stocks.iter() {
        let Some(merged) = merge_positions(&data.accounts, &stock.id) else {
            continue;
        };
        let Some(quote) = snap.quotes.get(&stock.id) else {
            continue;
        };
        let value = snap.rates.convert(merged.value(quote.price), stock.market, &currency);
        let basis = snap.rates.convert(merged.basis(), stock.market, &currency);
        market_value += value;
        cost += basis;
        lines.push(serde_json::json!({
            "id": stock.id,
            "name": stock.name,
            "market": stock.market.key(),
            "shares": merged.shares,
            "price": quote.price,
            "value": (value * 100.0).round() as i64,
            "cost": (basis * 100.0).round() as i64,
            "pnl": ((value - basis) * 100.0).round() as i64,
        }));
    }
    // Per-account split, so the ledger's accounts page can show the stock
    // accounts the user already configured instead of asking for them again.
    let mut accounts = Vec::new();
    for account in data.accounts.iter() {
        let mut value = 0.0f64;
        let mut basis = 0.0f64;
        let mut holdings = 0usize;
        for (stock_id, position) in account.entries.iter() {
            let Some(stock) = data.stocks.iter().find(|s| &s.id == stock_id) else {
                continue;
            };
            let Some(quote) = snap.quotes.get(stock_id) else { continue };
            if position.shares <= 0.0 {
                continue;
            }
            value += snap
                .rates
                .convert(position.shares * quote.price, stock.market, &currency);
            basis += snap
                .rates
                .convert(position.shares * position.cost_price, stock.market, &currency);
            holdings += 1;
        }
        accounts.push(serde_json::json!({
            "id": account.id,
            "name": account.name,
            "holdings": holdings,
            "value": (value * 100.0).round() as i64,
            "cost": (basis * 100.0).round() as i64,
            "pnl": ((value - basis) * 100.0).round() as i64,
        }));
    }

    Ok(serde_json::json!({
        "currency": currency,
        "lines": lines,
        "accounts": accounts,
        "marketValue": (market_value * 100.0).round() as i64,
        "cost": (cost * 100.0).round() as i64,
        "pnl": ((market_value - cost) * 100.0).round() as i64,
    }))
}

#[tauri::command]
async fn ledger_state(app: AppHandle) -> serde_json::Value {
    let snapshot = with_ledger(&app, |l| l.snapshot());
    let dir = store::data_dir(&app);
    // QA hook: proves the ledger webview booted and reached IPC.
    if std::env::var("STOCKPOT_DEBUG_DUMP").is_ok() {
        let _ = std::fs::write(
            dir.join("ledger-ready.json"),
            serde_json::json!({ "entries": snapshot.entries.len() }).to_string(),
        );
    }
    // The ledger follows the app's theme and language; both live in the stock
    // settings, so the window does not keep its own copy.
    let settings = with_state(&app, |s| s.settings());
    serde_json::json!({
        "ledger": snapshot,
        "dataDir": dir.to_string_lossy(),
        "theme": settings.theme,
        "language": settings.language,
        "colorScheme": settings.color_scheme,
    })
}

#[tauri::command]
async fn ledger_add(app: AppHandle, input: ledger::EntryInput) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.add(input))
}

#[tauri::command]
async fn ledger_update(
    app: AppHandle,
    id: String,
    input: ledger::EntryInput,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.update(&id, input))
}

#[tauri::command]
async fn ledger_delete(app: AppHandle, id: String) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.delete(&id))
}

/// Parse a bill without importing it: what the confirmation dialog shows.
#[tauri::command]
async fn ledger_preview_import(
    app: AppHandle,
    bytes: Vec<u8>,
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    let forced = source.as_deref().map(str::trim).filter(|value| !value.is_empty());
    with_ledger(&app, |l| l.preview_import(&bytes, forced))
}

#[tauri::command]
async fn ledger_import(
    app: AppHandle,
    file: String,
    bytes: Vec<u8>,
    ai: Option<bool>,
    source: Option<String>,
) -> Result<ledger::ImportOutcome, String> {
    let forced = source.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let outcome = with_ledger(&app, |l| l.import_as(&file, &bytes, forced))?;
    if ai.unwrap_or(false) {
        // Identify the new rows by their external ids, not by list position: the
        // ledger sorts newest-first after every import.
        let ids = outcome.new_ids.clone();
        if !ids.is_empty() {
            let result = classify_with_jev(&app, &ids).await?;
            let suggestions: Vec<(String, String)> = result["suggestions"]
                .as_array().unwrap_or(&Vec::new()).iter()
                .filter_map(|s| Some((s["id"].as_str()?.to_string(), s["category"].as_str()?.to_string())))
                .collect();
            let _ = with_ledger(&app, |l| l.apply_ai_suggestions(&suggestions))?;
            // Return the post-AI snapshot so the UI shows the categories that
            // were actually saved, not the pre-AI import snapshot.
            return with_ledger(&app, |l| {
                let mut refreshed = outcome.clone();
                refreshed.ledger = l.snapshot();
                Ok(refreshed)
            });
        }
    }
    Ok(outcome)
}

/// Rows that look duplicated and rows that look like repayments of earlier
/// purchases, for the tidy-up page.
#[tauri::command]
async fn ledger_add_rule(
    app: AppHandle,
    pattern: String,
    category: String,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.add_rule(&pattern, &category))
}

#[tauri::command]
async fn ledger_update_rule(
    app: AppHandle,
    id: String,
    pattern: String,
    category: String,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.update_rule(&id, &pattern, &category))
}

#[tauri::command]
async fn ledger_delete_rule(app: AppHandle, id: String) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.delete_rule(&id))
}

#[tauri::command]
async fn ledger_apply_rules(app: AppHandle) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.apply_rules_to_all())
}

#[tauri::command]
async fn ledger_cleanup(app: AppHandle) -> Result<serde_json::Value, String> {
    with_ledger(&app, |l| Ok(l.cleanup_report()))
}

#[tauri::command]
async fn ledger_restore_ignored(app: AppHandle) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.restore_ignored())
}

/// Mark a tidy-up finding as "checked, it is fine".
#[tauri::command]
async fn ledger_ignore_cleanup(
    app: AppHandle,
    kind: String,
    key: String,
    ignored: bool,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.ignore_cleanup(&kind, &key, ignored))
}

#[tauri::command]
async fn ledger_merge_entries(
    app: AppHandle,
    keep: String,
    remove: Vec<String>,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.merge_entries(&keep, &remove))
}

#[tauri::command]
async fn ledger_set_excluded(
    app: AppHandle,
    ids: Vec<String>,
    excluded: bool,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.set_excluded(ids, excluded))
}

#[tauri::command]
async fn ledger_set_archived(
    app: AppHandle,
    ids: Vec<String>,
    archived: bool,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.set_archived(ids, archived))
}

/// Resolve every duplicate cluster at once: keep the most complete row of each
/// and archive the rest (nothing is deleted).
#[tauri::command]
async fn ledger_auto_tidy(app: AppHandle) -> Result<ledger::AutoTidyOutcome, String> {
    with_ledger(&app, |l| l.auto_tidy())
}

/// Classify rows with JEV, one group/leaf pair per row. Shared by the manual
/// button and the optional AI pass during import.
async fn classify_with_jev(
    app: &AppHandle,
    ids: &[String],
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let (endpoint, model, key, batch_size) = {
        let data = state.data.lock().unwrap();
        (
            data.settings.ai_endpoint.trim().to_string(),
            data.settings.ai_model.trim().to_string(),
            data.settings.ai_api_key.trim().to_string(),
            data.settings.ai_batch_size.max(1),
        )
    };
    if endpoint.is_empty() || model.is_empty() {
        return Err("ai-not-configured".into());
    }
    let ledger = with_ledger(app, |l| l.snapshot());
    let mut entries: Vec<&ledger::Entry> = ledger
        .entries
        .iter()
        .filter(|e| ids.iter().any(|id| id == &e.id))
        .collect();
    if entries.is_empty() {
        return Ok(serde_json::json!({ "suggestions": [], "batches": 0 }));
    }
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    let kinds: std::collections::HashMap<String, String> = entries
        .iter()
        .map(|e| (e.id.clone(), e.kind.clone()))
        .collect();
    let accepts = |id: &str, category: &str| {
        let Some(kind) = kinds.get(id) else { return false };
        if kind != "expense" && kind != "income" { return true; }
        let target = ledger::category_kind(&ledger.categories, category);
        target.is_empty() || &target == kind
    };
    let categories: Vec<ai::CategoryOption> = ledger
        .categories
        .iter()
        .map(|c| (c.path(), c.kind.clone(), c.description.clone()))
        .collect();
    if categories.is_empty() { return Err("no-categories".into()); }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/systemone", endpoint.trim_end_matches('/'));
    let mut suggestions = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let total = entries.len();
    let mut done = 0usize;
    for chunk in entries.chunks(batch_size as usize) {
        let items: Vec<ai::AiItem> = chunk.iter().map(|entry| ai::AiItem {
            id: entry.id.clone(), date: entry.date.clone(),
            time: entry.time.clone(),
            counterparty: entry.counterparty.clone(),
            note: entry.note.clone(),
            account: entry.account.clone(),
            text: format!("{} {}", entry.counterparty, entry.note),
            amount: format!("{:.2}", entry.amount as f64 / 100.0),
            kind: entry.kind.clone(),
        }).collect();
        let root_options: Vec<ai::CategoryOption> = categories.iter()
            .filter(|(path, _, _)| !path.contains('/')).cloned().collect();
        for item in items {
            let allowed: Vec<ai::CategoryOption> = root_options.iter()
                .filter(|(_, kind, _)| kind.is_empty() || kind == &item.kind).cloned().collect();
            if allowed.is_empty() { errors.push("no-candidates".into()); continue; }
            let body = ai::build_jev_request(&model, &item, &allowed);
            let response = client.post(&url).bearer_auth(&key).json(&body).send().await
                .map_err(|e| format!("ai-request:{e}"))?;
            let status = response.status();
            let text = response.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() { errors.push(format!("{} {}", status.as_u16(), truncate(&text, 200))); continue; }
            match ai::parse_jev_response(&text) {
                Ok((group, group_confidence)) if group == "none" => { let _ = group_confidence; }
                Ok((group, group_confidence)) => {
                    let leaves: Vec<ai::CategoryOption> = categories.iter().filter(|(path, kind, _)| {
                        path.starts_with(&format!("{group}/")) && (kind.is_empty() || kind == &item.kind)
                    }).cloned().collect();
                    let mut choice = group;
                    let mut confidence = group_confidence;
                    if !leaves.is_empty() {
                        let leaf_body = ai::build_jev_request(&model, &item, &leaves);
                        let leaf_response = client.post(&url).bearer_auth(&key).json(&leaf_body).send().await
                            .map_err(|e| format!("ai-request:{e}"))?;
                        let leaf_status = leaf_response.status();
                        let leaf_text = leaf_response.text().await.map_err(|e| e.to_string())?;
                        if leaf_status.is_success() {
                            if let Ok((leaf, leaf_confidence)) = ai::parse_jev_response(&leaf_text) {
                                choice = leaf; confidence = leaf_confidence;
                            }
                        } else { errors.push(format!("{} {}", leaf_status.as_u16(), truncate(&leaf_text, 200))); }
                    }
                    if choice == "none" { done += 1; continue; }
                    if accepts(&item.id, &choice) {
                        suggestions.push(serde_json::json!({"id": item.id, "category": choice, "confidence": confidence, "reason": "JEV choice"}));
                    } else { errors.push(format!("direction-mismatch:{}", choice)); }
                }
                Err(err) => errors.push(err),
            }
            done += 1;
            let _ = app.emit("ai-progress", serde_json::json!({"done": done, "total": total}));
        }
    }
    Ok(serde_json::json!({"suggestions": suggestions, "batches": entries.len().div_ceil(batch_size as usize), "errors": errors}))
}

/// Ask the configured model to file a batch of rows.
///
/// Only the ids are trusted from the caller: the text, date and amount come from
/// the ledger, so a stale UI cannot inject arbitrary data into the request.
#[tauri::command]
async fn ledger_ai_classify(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    classify_with_jev(&app, &ids).await
}

/// The exact prompt that would be sent, for the settings preview.
#[tauri::command]
async fn ledger_ai_preview(app: AppHandle, ids: Vec<String>) -> Result<serde_json::Value, String> {
    let ledger = with_ledger(&app, |l| l.snapshot());
    let categories: Vec<ai::CategoryOption> = ledger
        .categories
        .iter()
        .map(|c| (c.path(), c.kind.clone(), c.description.clone()))
        .collect();
    let items: Vec<ai::AiItem> = ledger
        .entries
        .iter()
        .filter(|e| ids.iter().any(|id| id == &e.id))
        .map(|e| ai::AiItem {
            id: e.id.clone(),
            date: e.date.clone(),
            time: e.time.clone(),
            counterparty: e.counterparty.clone(),
            note: e.note.clone(),
            account: e.account.clone(),
            text: format!("{} {}", e.counterparty, e.note),
            amount: format!("{:.2}", e.amount as f64 / 100.0),
            kind: e.kind.clone(),
        })
        .collect();
    let body = items
        .first()
        .map(|item| ai::build_jev_request("tev1", item, &categories));
    Ok(serde_json::json!({ "request": body }))
}

fn truncate(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[tauri::command]
async fn ledger_link_refund(
    app: AppHandle,
    input: ledger::RefundLinkInput,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.link_refund(input))
}

#[tauri::command]
async fn ledger_add_wallet(
    app: AppHandle,
    input: ledger::WalletInput,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.add_wallet(input))
}

#[tauri::command]
async fn ledger_update_wallet(
    app: AppHandle,
    id: String,
    input: ledger::WalletInput,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.update_wallet(&id, input))
}

#[tauri::command]
async fn ledger_delete_wallet(app: AppHandle, id: String) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.delete_wallet(&id))
}

#[tauri::command]
async fn ledger_add_category(
    app: AppHandle,
    name: String,
    parent: Option<String>,
    icon: Option<String>,
    kind: Option<String>,
    description: Option<String>,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| {
        l.add_category(
            &name,
            parent.as_deref().unwrap_or(""),
            icon.as_deref().unwrap_or(""),
            kind.as_deref().unwrap_or(""),
            description.as_deref().unwrap_or(""),
        )
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ledger_update_category(
    app: AppHandle,
    name: String,
    parent: String,
    new_name: String,
    new_parent: String,
    icon: String,
    kind: String,
    description: String,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| {
        l.update_category(&name, &parent, &new_name, &new_parent, &icon, &kind, &description)
    })
}

#[tauri::command]
async fn ledger_recategorize(
    app: AppHandle,
    ids: Vec<String>,
    category: String,
) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.recategorize(ids, &category))
}

#[tauri::command]
async fn ledger_delete_category(app: AppHandle, path: String) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.delete_category(&path))
}

#[tauri::command]
async fn ledger_reset_categories(app: AppHandle) -> Result<ledger::Ledger, String> {
    let ledger = with_ledger(&app, |l| l.reset_categories())?;
    let _ = app.emit("ledger-changed", ledger.clone());
    Ok(ledger)
}

#[tauri::command]
async fn ledger_add_project(app: AppHandle, input: ledger::ProjectInput) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.add_project(input))
}

#[tauri::command]
async fn ledger_update_project(app: AppHandle, id: String, input: ledger::ProjectInput) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.update_project(&id, input))
}

#[tauri::command]
async fn ledger_delete_project(app: AppHandle, id: String) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.delete_project(&id))
}

#[tauri::command]
async fn ledger_set_project(app: AppHandle, ids: Vec<String>, project_id: String) -> Result<ledger::Ledger, String> {
    with_ledger(&app, |l| l.set_project(ids, &project_id))
}

#[tauri::command]
async fn ledger_clear(app: AppHandle) -> Result<ledger::Ledger, String> {
    let ledger = with_ledger(&app, |l| l.clear())?;
    // A second open ledger window must not keep rendering the deleted rows.
    let _ = app.emit("ledger-changed", ledger.clone());
    Ok(ledger)
}

/// Open (or focus) the bookkeeping window — the app's main surface.
pub async fn open_ledger_window(app: &AppHandle) -> Result<(), String> {
    open_ledger(app.clone()).await
}

/// The ledger is a real desktop window, so it gets a Dock tile; closing it puts
/// the app back to menu-bar-only unless the user asked for a permanent icon.
#[cfg(target_os = "macos")]
fn sync_activation_policy(app: &AppHandle) {
    let ledger_open = app
        .get_webview_window("ledger")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let pinned = with_state(app, |s| s.settings().show_dock_icon);
    let _ = app.set_activation_policy(if ledger_open || pinned {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    });
}

#[cfg(not(target_os = "macos"))]
fn sync_activation_policy(_app: &AppHandle) {}

/// Give a document window the chrome Stockpot draws itself.
///
/// macOS keeps the system frame but makes the title bar an overlay with the
/// title text hidden, so the sidebar colour reaches the top edge while the
/// traffic lights still show. Windows goes further and removes the frame
/// entirely, because the app draws Windows-conventional caption buttons
/// (minimise / maximise / close) and its own resize border in the webview.
/// Other platforms keep a plain OS-drawn frame.
fn style_document_window(builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    #[cfg(target_os = "macos")]
    {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
    }
    #[cfg(target_os = "windows")]
    {
        // `decorations(false)` also implies a resizable window without the
        // native border; `src/components/window-chrome.tsx` restores the resize
        // edges and the caption buttons.
        builder.decorations(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        builder
    }
}

#[tauri::command]
async fn open_ledger(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("ledger") {
        let _ = window.show();
        let _ = window.set_focus();
        sync_activation_policy(&app);
        return Ok(());
    }
    let window = style_document_window(WebviewWindowBuilder::new(
        &app,
        "ledger",
        WebviewUrl::App("settings.html#ledger".into()),
    )
        .title("Stockpot 记账")
        .inner_size(1040.0, 680.0)
        .min_inner_size(860.0, 560.0)
        .resizable(true)
        .visible(false)
        .decorations(true)
        .transparent(false))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    window.show().map_err(|e| e.to_string())?;
    sync_activation_policy(&app);
    Ok(())
}

#[tauri::command]
fn close_ledger(app: AppHandle) {
    if let Some(window) = app.get_webview_window("ledger") {
        let _ = window.hide();
    }
    sync_activation_policy(&app);
}

#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let window = style_document_window(
        WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
            .title("Stockpot Settings")
            .inner_size(880.0, 600.0)
            .min_inner_size(720.0, 480.0)
            .resizable(true)
            .visible(false)
            // A normal window: the system draws the frame and its own window
            // controls. On macOS the title bar is an overlay so the sidebar
            // colour reaches the top edge, and the webview still carries drag
            // regions for the rest of the header.
            .decorations(true)
            .transparent(false),
    )
    .build()
    .map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn notification_status(app: AppHandle) -> bool {
    notify::is_granted(&app)
}

/// Clear the watchlist but keep settings and account definitions.
#[tauri::command]
async fn clear_stocks(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    {
        let mut data = state.data.lock().unwrap();
        data.stocks.clear();
        data.settings.menu_bar_stock_id.clear();
        for account in data.accounts.iter_mut() {
            account.entries.clear();
        }
    }
    {
        let mut snap = state.snapshot.lock().unwrap();
        snap.quotes.clear();
    }
    state.persist();
    let payload = state.payload();
    broadcast(&app, &state);
    Ok(payload)
}

/// Called once by the webview after its first successful render. Writing the
/// marker makes it possible to tell "the window is empty" apart from "the
/// frontend never booted" during smoke tests.
#[tauri::command]
fn client_ready(app: AppHandle) -> bool {
    let marker = store::data_dir(&app).join("client-ready.log");
    let _ = std::fs::write(&marker, chrono::Utc::now().to_rfc3339());
    true
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = store::data_dir(&app);
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Everything the settings window's Agent page needs to hand a task to an
/// external agent: where the CLI lives, which folder it reads, and the skill
/// documents themselves.
///
/// The markdown is embedded with `include_str!` from the same file the CLI
/// prints (`stockpot cli skill`), so the page can never show a stale copy of
/// the guide the agent will follow.
#[tauri::command]
fn agent_skills(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "binary": std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        "dataDir": store::data_dir(&app).display().to_string(),
        "skills": [{
            "name": "stockpot",
            "path": "skills/stockpot/SKILL.md",
            "title": "Stockpot Agent CLI",
            "body": include_str!("../../skills/stockpot/SKILL.md"),
        }],
    })
}

#[tauri::command]
fn tray_title(app: AppHandle) -> String {
    with_state(&app, |s| s.tray_label())
}

/// Session states are time dependent, so the webview polls this lightly instead
/// of reimplementing every exchange calendar in JavaScript.
#[tauri::command]
fn sessions_now() -> serde_json::Value {
    let now = chrono::Utc::now();
    let mut map = serde_json::Map::new();
    for market in Market::all() {
        let key = match market {
            Market::A => "a",
            Market::Hk => "hk",
            Market::Us => "us",
            Market::Kr => "kr",
        };
        map.insert(
            key.into(),
            serde_json::json!(market::session(market, now)),
        );
    }
    serde_json::Value::Object(map)
}

fn start_refresh_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give the webview a moment to attach its listeners, then fetch once.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        loop {
            let interval = {
                let state = app.state::<AppState>();
                state.settings().refresh_interval.max(3)
            };
            let should = market::any_market_open(chrono::Utc::now());
            if should {
                let state = app.state::<AppState>();
                state.refresh(&app).await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Native clipboard: the settings window copies prompts and skill docs,
        // and the web clipboard API refuses to write from an unfocused window.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // 自建服务器的更新：地址和公钥都在 tauri.conf.json 的 plugins.updater 里
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The Dock tile follows the ledger window. Red-button closes and hides
        // both arrive here, so the policy is re-synced after the window settles
        // rather than by polling.
        .on_window_event(|window, event| {
            if window.label() != "ledger" {
                return;
            }
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    sync_activation_policy(&app);
                });
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(&handle);
            state.persist_if_upgraded();
            app.manage(state);

            // The ledger lives beside the quote data but in its own file: a
            // corrupt watchlist must never take the books with it.
            let ledger_dir = store::data_dir(&handle);
            app.manage(ledger::LedgerState::new(ledger_dir.clone()));
            sync::start(&handle);

            // QA hook: dump the tidy-up report for a real ledger.
            if std::env::var("STOCKPOT_CLEANUP").is_ok() {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if let Ok(report) = ledger_cleanup(handle.clone()).await {
                        let _ = std::fs::write(
                            store::data_dir(&handle).join("cleanup.json"),
                            serde_json::to_string_pretty(&report).unwrap_or_default(),
                        );
                    }
                });
            }

            // QA hook: run the whole-ledger re-classification at startup and
            // dump the outcome, so the pipeline can be measured on real data.
                        // Design/QA hook: import a bill at startup and dump the result, so
            // the native parse path can be verified without driving the window.
            if let Ok(path) = std::env::var("STOCKPOT_LEDGER_IMPORT")
                && let Ok(bytes) = std::fs::read(&path)
            {
                let state = app.state::<ledger::LedgerState>();
                let file = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                match state.import(&file, &bytes) {
                    Ok(outcome) => {
                        let dump = serde_json::json!({
                            "added": outcome.added,
                            "duplicates": outcome.duplicates,
                            "ignored": outcome.ignored,
                            "source": outcome.source,
                            "entries": outcome.ledger.entries.len(),
                        });
                        let _ = std::fs::write(
                            ledger_dir.join("last-import.json"),
                            serde_json::to_string_pretty(&dump).unwrap_or_default(),
                        );
                    }
                    Err(err) => {
                        let _ = std::fs::write(
                            ledger_dir.join("last-import.json"),
                            serde_json::json!({ "error": err }).to_string(),
                        );
                    }
                }
            }

            // Startup policy mirrors the saved preference. `LSUIElement` is
            // deliberately not used: it would pin the app to accessory mode and
            // make the Dock toggle impossible.
            #[cfg(target_os = "macos")]
            {
                let show_dock = {
                    let state = app.state::<AppState>();
                    state.settings().show_dock_icon
                };
                app.set_activation_policy(if show_dock {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                });
            }

            tray::create(&handle)?;

            if let Some(window) = app.get_webview_window("main") {
                // The panel is a borderless popover: decorations would paint
                // window controls over the masthead. On Windows the panel is
                // also opaque rather than transparent — see
                // `tauri.windows.conf.json` — because a layered transparent
                // WebView2 window does not always composite there.
                let _ = window.set_always_on_top(true);
                let _ = window.set_decorations(false);
                tray::install_dismiss_handler(&window);
            }

            start_refresh_loop(handle.clone());

            // The ledger is the app's main window now; the menu bar panel is an
            // accessory. `STOCKPOT_NO_LEDGER=1` keeps it closed for tests.
            if std::env::var("STOCKPOT_NO_LEDGER").is_err() {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                    if let Err(err) = open_ledger_window(&handle).await {
                        // Surface a failed build instead of silently showing no
                        // window at all.
                        eprintln!("ledger window failed: {err}");
                        if std::env::var("STOCKPOT_DEBUG_DUMP").is_ok() {
                            let _ = std::fs::write(
                                store::data_dir(&handle).join("ledger-error.txt"),
                                err,
                            );
                        }
                    }
                });
            }

            // Design QA hook: `STOCKPOT_SHOW_ON_LAUNCH=1 pnpm tauri dev` opens the
            // panel immediately instead of waiting for a tray click.
            if std::env::var("STOCKPOT_SHOW_ON_LAUNCH").is_ok() {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                    tray::show_panel(&handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app,
            refresh,
            search,
            add_stock,
            preview_quotes,
            remove_stock,
            reorder_stocks,
            set_position,
            create_account,
            rename_account,
            delete_account,
            update_alert,
            update_settings,
            chart,
            kline,
            set_autostart,
            request_notification_permission,
            test_notification,
            notification_status,
            clear_stocks,
            open_settings,
            close_settings,
            hide_panel,
            quit_app,
            open_data_dir,
            agent_skills,
            ledger_assets,
            ledger_state,
            ledger_add,
            ledger_update,
            ledger_delete,
            ledger_import,
            ledger_preview_import,
            ledger_add_rule,
            ledger_update_rule,
            ledger_delete_rule,
            ledger_apply_rules,
            ledger_cleanup,
            ledger_ignore_cleanup,
            ledger_restore_ignored,
            ledger_merge_entries,
            ledger_set_excluded,
            ledger_set_archived,
            ledger_auto_tidy,
            ledger_ai_classify,
            ledger_ai_preview,
            ledger_link_refund,
            ledger_add_wallet,
            ledger_update_wallet,
            ledger_delete_wallet,
            ledger_add_category,
            ledger_update_category,
            ledger_recategorize,
            ledger_delete_category,
            ledger_reset_categories,
            ledger_add_project,
            ledger_update_project,
            ledger_delete_project,
            ledger_set_project,
            ledger_clear,
            open_ledger,
            close_ledger,
            tray_title,
            sessions_now,
            client_ready,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing either window should not quit the app; the tray owns
                // the process lifetime.
                api.prevent_close();
                let _ = window.hide();
            }
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Stockpot");
}

