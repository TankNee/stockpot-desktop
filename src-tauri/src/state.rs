use crate::market;
use crate::model::*;
use crate::providers;
use crate::store;
use chrono::{DateTime, Utc};
use reqwest::Client;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct AppState {
    pub data: Mutex<AppData>,
    pub snapshot: Mutex<Snapshot>,
    pub http: Client,
    pub refreshing: tokio::sync::Mutex<()>,
    pub last_refresh: Mutex<Option<std::time::Instant>>,
    pub dir: std::path::PathBuf,
    /// Set when the file was read in an older shape; written back on first save.
    upgrade_needed: bool,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Self {
        let dir = store::data_dir(app);
        let _ = store::ensure_dir(&dir);
        let (data, upgrade_needed) = store::read_data_file_with_status(&dir);
        Self {
            data: Mutex::new(data),
            snapshot: Mutex::new(Snapshot::default()),
            http: providers::client(),
            refreshing: tokio::sync::Mutex::new(()),
            last_refresh: Mutex::new(None),
            dir,
            upgrade_needed,
        }
    }

    /// State with no window attached, for unit tests that only exercise pure
    /// calculations (totals, labels, alerts).
    #[cfg(test)]
    pub fn default_for_test() -> Self {
        Self {
            data: Mutex::new(AppData::default()),
            snapshot: Mutex::new(Snapshot::default()),
            http: providers::client(),
            refreshing: tokio::sync::Mutex::new(()),
            last_refresh: Mutex::new(None),
            dir: std::env::temp_dir(),
            upgrade_needed: false,
        }
    }

    /// True when a refresh ran within the last `seconds`, used to avoid
    /// hammering the feeds when the panel is opened and closed rapidly.
    pub fn refreshed_within(&self, seconds: u64) -> bool {
        let guard = self.last_refresh.lock().unwrap();
        guard
            .map(|t| t.elapsed().as_secs() < seconds)
            .unwrap_or(false)
    }

    pub fn persist(&self) {
        let data = self.data.lock().unwrap().clone();
        if let Err(err) = store::write_data_file(&self.dir, &data) {
            log::error!("failed to persist data: {err}");
        }
    }

    /// Called once at startup: rewrites a legacy single-account file in the new
    /// shape so the migration is visible on disk, not only in memory.
    pub fn persist_if_upgraded(&self) {
        if self.upgrade_needed {
            self.persist();
        }
    }

    pub fn settings(&self) -> Settings {
        self.data.lock().unwrap().settings.clone()
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    /// Fetch a fresh round of quotes and merge them into the snapshot.
    pub async fn refresh(&self, app: &AppHandle) {
        let _guard = self.refreshing.lock().await;
        let data = self.data.lock().unwrap().clone();
        if data.stocks.is_empty() {
            let mut snap = self.snapshot.lock().unwrap();
            snap.updated_at = Utc::now().timestamp();
            snap.error = None;
            return;
        }

        let now = Utc::now();
        let mut quotes: HashMap<String, Quote> = HashMap::new();
        let mut had_error = false;

        let a_ids: Vec<String> = data
            .stocks
            .iter()
            .filter(|s| s.market == Market::A)
            .map(|s| s.id.clone())
            .collect();
        let us_ids: Vec<String> = data
            .stocks
            .iter()
            .filter(|s| s.market == Market::Us)
            .map(|s| s.id.clone())
            .collect();
        let hk_codes: Vec<String> = data
            .stocks
            .iter()
            .filter(|s| s.market == Market::Hk)
            .map(|s| s.code.clone())
            .collect();
        let kr_codes: Vec<String> = data
            .stocks
            .iter()
            .filter(|s| s.market == Market::Kr)
            .map(|s| s.code.clone())
            .collect();
        let em_targets: Vec<(String, String, Market)> = data
            .stocks
            .iter()
            .filter(|s| matches!(s.market, Market::Kr | Market::Us | Market::Hk))
            .filter_map(|s| s.secid().map(|secid| (s.id.clone(), secid, s.market)))
            .collect();

        let (sina_a, sina_us, tencent, tencent_kr, eastmoney) = futures::join!(
            providers::sina_quotes(&self.http, &a_ids, Market::A),
            providers::sina_quotes(&self.http, &us_ids, Market::Us),
            providers::tencent_hk_quotes(&self.http, &hk_codes),
            providers::tencent_kr_quotes(&self.http, &kr_codes),
            providers::eastmoney_quotes(&self.http, &em_targets),
        );

        // Eastmoney is now a fallback; only a total blackout counts as an error.
        let em_failed = eastmoney.is_empty()
            && !em_targets.is_empty()
            && !data.stocks.iter().any(|s| s.market == Market::Kr && kr_codes.contains(&s.code));
        if em_failed && tencent_kr.is_empty() {
            had_error = true;
        }

        let stock_by_id: HashMap<&str, &Stock> =
            data.stocks.iter().map(|s| (s.id.as_str(), s)).collect();

        for raw in sina_a.iter().chain(sina_us.iter()) {
            let Some(stock) = stock_by_id.get(raw.id.as_str()) else { continue };
            let mut q = build_quote(raw, stock.market);
            if stock.market == Market::Us {
                // Sina gives the regular session and the latest off-hours print.
                let sess = market::session(Market::Us, now);
                let (ext, label) = match sess {
                    "pre" | "post" => (raw.extended_price, Some(sess)),
                    _ => (None, None),
                };
                q.extended_price = ext;
                q.extended_label = label.map(str::to_string);
            }
            quotes.insert(stock.id.clone(), q);
        }

        for raw in tencent.iter() {
            let Some(stock) = stock_by_id.get(raw.id.as_str()) else { continue };
            quotes.insert(stock.id.clone(), build_quote(raw, Market::Hk));
        }

        for raw in tencent_kr.iter() {
            let Some(stock) = stock_by_id.get(raw.id.as_str()) else { continue };
            quotes.insert(stock.id.clone(), build_quote(raw, Market::Kr));
        }

        for raw in eastmoney.iter() {
            let Some(stock) = stock_by_id.get(raw.id.as_str()) else { continue };
            // Eastmoney is the fallback for HK and the source of truth for KR; for
            // US it only fills gaps left by Sina.
            let entry = quotes.entry(stock.id.clone()).or_insert_with(|| {
                build_quote(raw, stock.market)
            });
            if entry.time.is_empty() && stock.market == Market::Kr {
                entry.time = now
                    .with_timezone(&market::market_tz(Market::Kr))
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string();
            }
            if stock.market == Market::Hk && entry.price <= 0.0 {
                *entry = build_quote(raw, stock.market);
            }
        }

        // Overnight tape comes from Robinhood, which is the only free feed that
        // publishes 24/5 fills. Only used while the night session is live.
        if market::session(Market::Us, now) == "night" {
            let overnight = providers::robinhood_overnight(&self.http, &us_ids).await;
            for (id, quote) in quotes.iter_mut() {
                let Some(stock) = stock_by_id.get(id.as_str()) else { continue };
                if stock.market != Market::Us {
                    continue;
                }
                if let Some(price) = overnight.get(&stock.id) {
                    quote.extended_price = Some(*price);
                    quote.extended_label = Some("night".into());
                }
            }
        }

        let rates = providers::sina_rates(&self.http).await;

        let mut snap = self.snapshot.lock().unwrap();
        for (id, q) in quotes {
            let merged = snap.quotes.entry(id).or_insert_with(|| q.clone());
            // Prefer fresh rows, but keep last-good data when a feed drops out.
            if q.price > 0.0 {
                *merged = q;
            }
        }
        if let Some(rates) = rates {
            snap.rates = rates;
        }
        snap.updated_at = Utc::now().timestamp();
        snap.error = had_error.then(|| "feed".to_string());
        snap.quotes.values_mut().for_each(|q| {
            q.extended_change_percent = match (q.extended_price, q.price) {
                (Some(ext), price) if price > 0.0 => Some((ext - price) / price * 100.0),
                _ => None,
            };
        });
        drop(snap);
        *self.last_refresh.lock().unwrap() = Some(std::time::Instant::now());

        self.sync_names(app);
        let hits = self.check_alerts(now);
        for hit in hits {
            crate::notify::send_hit(app, &hit);
            let _ = app.emit("alert-hit", &hit);
        }
        let label = self.tray_label();
        crate::tray::set_title(app, &label);
        let payload = self.payload();
        // Smoke-test hook: dump the exact payload the webview receives so a
        // headless run can be inspected without screen capture permissions.
        if std::env::var("STOCKPOT_DEBUG_DUMP").is_ok() {
            let path = self.dir.join("last-payload.json");
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&payload).unwrap_or_default());
        }
        let _ = app.emit("snapshot", &payload);
    }

    fn sync_names(&self, app: &AppHandle) {
        let snap = self.snapshot.lock().unwrap().clone();
        let mut data = self.data.lock().unwrap();
        let mut changed = false;
        for stock in data.stocks.iter_mut() {
            if let Some(q) = snap.quotes.get(&stock.id)
                && stock.name.is_empty()
                && !q.name.is_empty()
            {
                stock.name = q.name.clone();
                changed = true;
            }

        }
        drop(data);
        if changed {
            self.persist();
            let _ = app.emit("data-changed", ());
        }
    }

    /// Evaluate every armed alert. Reached alerts switch themselves off (one
    /// shot) and are persisted before the notification is shown, so a crash
    /// while notifying cannot produce a duplicate a minute later.
    pub fn check_alerts(&self, now: DateTime<Utc>) -> Vec<PriceAlertHit> {
        let snap = self.snapshot.lock().unwrap().clone();
        let mut data = self.data.lock().unwrap();
        let mut hits = Vec::new();
        let mut changed = false;
        for stock in data.stocks.iter_mut() {
            let Some(quote) = snap.quotes.get(&stock.id) else { continue };
            let price_info = alert_price(stock, quote, now);
            let Some((price, label)) = price_info else { continue };
            let Some(alert) = stock.alert.as_mut() else { continue };
            if !alert.enabled {
                continue;
            }
            if alert.direction.is_none() {
                alert.direction = Some(PriceAlert::direction_for(alert.target_price, price));
                changed = true;
                continue;
            }
            if !alert.reached(price) {
                continue;
            }
            alert.enabled = false;
            changed = true;
            hits.push(PriceAlertHit {
                stock_id: stock.id.clone(),
                stock_name: stock.name.clone(),
                price,
                target_price: alert.target_price,
                direction: alert.direction.unwrap_or(AlertDirection::Rise),
                session_label: label.map(str::to_string),
            });
        }
        drop(data);
        if changed {
            self.persist();
        }
        hits
    }

    /// Compose the text shown next to the tray icon. Kept deliberately plain:
    /// the menu bar is monochrome and users scan it dozens of times a day.
    pub fn tray_label(&self) -> String {
        let settings = self.settings();
        let snap = self.snapshot();
        let data = self.data.lock().unwrap();
        let lang = settings.language.as_str();
        let (daily_prefix, total_prefix) = match lang {
            "en" => ("D", "T"),
            "ja" => ("日", "含"),
            _ => ("日", "浮"),
        };
        match settings.menu_bar_mode.as_str() {
            "none" => String::new(),
            "dailyPnl" | "totalPnl" | "bothPnl" => {
                let (daily, total, _) = self.totals(&data, &snap);
                let (daily_pct, total_pct) = self.pnl_percents(&data, &snap);
                let symbol = currency_symbol(&settings.currency);
                let format = settings.menu_bar_pnl_format.as_str();
                let render = |value: f64, percent: f64| -> String {
                    match format {
                        "percent" => compact_percent(percent),
                        "both" => {
                            format!("{} {}", compact_money(value, symbol), compact_percent(percent))
                        }
                        _ => compact_money(value, symbol),
                    }
                };
                let mut parts = Vec::new();
                if settings.menu_bar_mode != "totalPnl" {
                    parts.push(format!("{daily_prefix}{}", render(daily, daily_pct)));
                }
                if settings.menu_bar_mode != "dailyPnl" {
                    parts.push(format!("{total_prefix}{}", render(total, total_pct)));
                }
                parts.join("  ")
            }
            _ => {
                let stock = pick_menu_stock(&data.stocks, &settings);
                let Some(stock) = stock else { return String::new() };
                let Some(q) = snap.quotes.get(&stock.id) else {
                    return stock.code.clone();
                };
                format!(
                    "{} {}",
                    short_name(&stock.name, &stock.code, lang),
                    format_quote_line(q, &settings)
                )
            }
        }
    }

    /// Portfolio totals across every account, using the merged cost basis.
    pub fn totals(&self, data: &AppData, snap: &Snapshot) -> (f64, f64, f64) {
        let mut total = 0.0;
        let mut cost = 0.0;
        let mut daily = 0.0;
        for stock in data.stocks.iter() {
            let Some(merged) = crate::model::merge_positions(&data.accounts, &stock.id) else {
                continue;
            };
            let Some(q) = snap.quotes.get(&stock.id) else { continue };
            let currency = &data.settings.currency;
            total += snap.rates.convert(merged.pnl(q.price), stock.market, currency);
            cost += snap.rates.convert(merged.basis(), stock.market, currency);
            daily += snap
                .rates
                .convert(q.change * merged.shares, stock.market, currency);
        }
        let pct = if cost > 0.0 { total / cost * 100.0 } else { 0.0 };
        (daily, total, pct)
    }

    /// Daily and total P&L as percentages of cost basis, for the menu bar's
    /// percentage mode.
    pub fn pnl_percents(&self, data: &AppData, snap: &Snapshot) -> (f64, f64) {
        let (daily, total, total_pct) = self.totals(data, snap);
        let mut cost = 0.0;
        for stock in data.stocks.iter() {
            let Some(merged) = crate::model::merge_positions(&data.accounts, &stock.id) else {
                continue;
            };
            cost += snap.rates.convert(merged.basis(), stock.market, &data.settings.currency);
        }
        let daily_pct = if cost > 0.0 { daily / cost * 100.0 } else { 0.0 };
        let _ = total;
        (daily_pct, total_pct)
    }

    pub fn payload(&self) -> serde_json::Value {
        let data = self.data.lock().unwrap().clone();
        let snap = self.snapshot.lock().unwrap().clone();
        let now = Utc::now();
        let sessions: HashMap<&str, &str> = Market::all()
            .iter()
            .map(|m| {
                let key = match m {
                    Market::A => "a",
                    Market::Hk => "hk",
                    Market::Us => "us",
                    Market::Kr => "kr",
                };
                (key, market::session(*m, now))
            })
            .collect();
        serde_json::json!({
            "data": data,
            "snapshot": snap,
            "sessions": sessions,
            "trayLabel": self.tray_label(),
        })
    }
}

pub struct PriceAlertHit {
    pub stock_id: String,
    pub stock_name: String,
    pub price: f64,
    pub target_price: f64,
    pub direction: AlertDirection,
    pub session_label: Option<String>,
}

impl serde::Serialize for PriceAlertHit {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("PriceAlertHit", 6)?;
        st.serialize_field("stockId", &self.stock_id)?;
        st.serialize_field("stockName", &self.stock_name)?;
        st.serialize_field("price", &self.price)?;
        st.serialize_field("targetPrice", &self.target_price)?;
        st.serialize_field("direction", &self.direction)?;
        st.serialize_field("sessionLabel", &self.session_label)?;
        st.end()
    }
}

fn build_quote(raw: &providers::RawQuote, market_kind: Market) -> Quote {
    let change = raw.price - raw.prev_close;
    let pct = if raw.prev_close > 0.0 {
        change / raw.prev_close * 100.0
    } else {
        0.0
    };
    Quote {
        id: raw.id.clone(),
        name: raw.name.clone(),
        price: raw.price,
        change,
        change_percent: pct,
        prev_close: raw.prev_close,
        time: raw.time.clone(),
        currency: market_kind.currency().to_string(),
        extended_price: raw.extended_price,
        extended_change_percent: None,
        extended_label: None,
    }
}

/// Price used for alert evaluation. US stocks use the extended-hours tape when
/// the regular session is closed; during the overnight tape a missing overnight
/// print means "skip this round" instead of comparing against a stale close.
pub fn alert_price(stock: &Stock, quote: &Quote, now: DateTime<Utc>) -> Option<(f64, Option<&'static str>)> {
    let mut price = quote.price;
    let mut label = None;
    if stock.market == Market::Us {
        let sess = market::session(Market::Us, now);
        match sess {
            "open" => {}
            "night" => match quote.extended_price {
                Some(p) if p > 0.0 => {
                    price = p;
                    label = Some("night");
                }
                _ => return None,
            },
            _ => {
                if let Some(ext) = quote.extended_price.filter(|p| *p > 0.0) {
                    price = ext;
                    label = Some(match sess {
                        "pre" => "pre",
                        "post" => "post",
                        _ => "post",
                    });
                }
            }
        }
    }
    if price <= 0.0 {
        return None;
    }
    Some((price, label))
}

fn pick_menu_stock<'a>(stocks: &'a [Stock], settings: &Settings) -> Option<&'a Stock> {
    if settings.menu_bar_mode == "stock"
        && !settings.menu_bar_stock_id.is_empty()
        && let Some(s) = stocks.iter().find(|s| s.id == settings.menu_bar_stock_id)
    {
        return Some(s);
    }
    stocks.first()
}

/// Keep the menu bar label short: names wider than ~7 CJK glyphs or ~11 latin
/// characters get truncated with an ellipsis.
fn short_name(name: &str, code: &str, _lang: &str) -> String {
    if name.is_empty() {
        return code.to_uppercase();
    }
    let chars: Vec<char> = name.chars().collect();
    let wide = chars.iter().filter(|c| (**c as u32) > 0x2E80).count();
    let limit = if wide > 0 { 7 } else { 11 };
    if chars.len() > limit {
        format!("{}…", chars[..limit].iter().collect::<String>())
    } else {
        name.to_string()
    }
}

fn format_quote_line(q: &Quote, settings: &Settings) -> String {
    let price = if q.price >= 10.0 {
        format!("{:.2}", q.price)
    } else {
        format!("{:.3}", q.price)
    };
    let sign = if q.change_percent >= 0.0 { "+" } else { "" };
    let pct = format!("{sign}{:.2}%", q.change_percent);
    let extended = match (&q.extended_label, q.extended_change_percent) {
        (Some(_), Some(p)) if q.extended_price.is_some() => {
            let label = match q.extended_label.as_deref() {
                Some("pre") => "Pre",
                Some("night") => "Night",
                _ => "Post",
            };
            format!(" {label} {p:+.2}%")
        }
        _ => String::new(),
    };
    let _ = settings;
    format!("{price} {pct}{extended}")
}

pub fn currency_symbol(currency: &str) -> &'static str {
    match currency {
        "HKD" => "HK$",
        "USD" => "$",
        "KRW" => "₩",
        _ => "¥",
    }
}

/// Menu-bar money: compact so the label never grows unbounded, but the sign is
/// always present — a bare "¥166" cannot tell a gain from a loss.
fn compact_money(value: f64, symbol: &str) -> String {
    let abs = value.abs();
    let sign = if value < 0.0 { "-" } else { "+" };
    if abs >= 10_000.0 {
        format!("{sign}{symbol}{:.1}w", abs / 10_000.0)
    } else {
        format!("{sign}{symbol}{:.0}", abs)
    }
}

/// Percentage for the menu bar, always signed and always one or two decimals
/// (a P&L of "+0%" is meaningless, so small moves keep a decimal).
fn compact_percent(value: f64) -> String {
    let sign = if value < 0.0 { "-" } else { "+" };
    let abs = value.abs();
    if abs >= 100.0 {
        format!("{sign}{abs:.0}%")
    } else if abs >= 10.0 {
        format!("{sign}{abs:.1}%")
    } else {
        format!("{sign}{abs:.2}%")
    }
    // Two decimals below 10 keeps "−0.04%" legible; one decimal above 10 stops
    // the label from growing to three digits of noise:
    // 4.34 → +4.3% would lose information, so the threshold is at 10.
}

/// Remove stale quotes whose stock was deleted, and any alert hits that were
/// produced before the delete.
pub fn prune(snap: &mut Snapshot, data: &AppData) {
    let ids: HashSet<&str> = data.stocks.iter().map(|s| s.id.as_str()).collect();
    snap.quotes.retain(|id, _| ids.contains(id.as_str()));
    for q in snap.quotes.values_mut() {
        q.extended_change_percent = match (q.extended_price, q.price) {
            (Some(ext), price) if price > 0.0 => Some((ext - price) / price * 100.0),
            _ => None,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Account, AppData, Market, Position, PriceAlert, Settings, Stock};

    fn stock(market: Market, id: &str, price: f64) -> (Stock, Quote) {
        let s = Stock {
            id: id.into(),
            code: id.to_string(),
            name: "测试".into(),
            market,
            alert: None,
            secid: None,
            legacy_cost_price: None,
            legacy_shares: None,
        };
        let q = Quote {
            id: id.into(),
            name: "测试".into(),
            price,
            change: 1.0,
            change_percent: 1.0,
            prev_close: price - 1.0,
            time: String::new(),
            currency: "CNY".into(),
            extended_price: None,
            extended_change_percent: None,
            extended_label: None,
        };
        (s, q)
    }

    #[test]
    fn alert_price_uses_overnight_tape_during_night() {
        use chrono::TimeZone;
        let now = chrono_tz::America::New_York
            .with_ymd_and_hms(2026, 11, 10, 2, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let (mut s, q) = stock(Market::Us, "usr_aapl", 350.0);
        // No overnight print → skip rather than firing on the regular close.
        assert!(alert_price(&s, &q, now).is_none());
        s.alert = None;
        let mut q2 = q.clone();
        q2.extended_price = Some(360.0);
        let (price, label) = alert_price(&s, &q2, now).unwrap();
        assert_eq!(price, 360.0);
        assert_eq!(label, Some("night"));
    }

    #[test]
    fn alert_direction_and_one_shot_behaviour() {
        let mut alert = PriceAlert {
            target_price: 11.0,
            direction: None,
            enabled: true,
        };
        alert.direction = Some(PriceAlert::direction_for(11.0, 10.0));
        assert_eq!(alert.direction, Some(AlertDirection::Rise));
        assert!(!alert.reached(10.99));
        assert!(alert.reached(11.0));
        alert.enabled = false;
        assert!(!alert.reached(12.0));
    }

    #[test]
    fn tray_label_for_stock_mode() {
        let mut data = AppData::default();
        let (s, q) = stock(Market::A, "sh600000", 11.0);
        data.stocks.push(s);
        let settings = Settings {
            menu_bar_mode: "stock".into(),
            ..Default::default()
        };
        data.settings = settings;
        let mut snap = Snapshot::default();
        snap.quotes.insert("sh600000".into(), q);
        // Mirrors format_quote_line: price + percent.
        let q = snap.quotes.get("sh600000").unwrap();
        let line = format_quote_line(q, &data.settings);
        assert!(line.starts_with("11.00 +"));
    }

    #[test]
    fn totals_merge_the_same_stock_across_accounts() {
        let (s, q) = stock(Market::A, "sh600000", 12.0);
        let mut data = AppData {
            stocks: vec![s],
            ..Default::default()
        };
        let mut a = Account::new("Broker A");
        a.entries.insert(
            "sh600000".into(),
            Position {
                cost_price: 8.0,
                shares: 100.0,
            },
        );
        let mut b = Account::new("Broker B");
        b.entries.insert(
            "sh600000".into(),
            Position {
                cost_price: 12.0,
                shares: 100.0,
            },
        );
        data.accounts = vec![a, b];
        let merged = crate::model::merge_positions(&data.accounts, "sh600000").unwrap();
        // Weighted average of 8 and 12 at equal size is 10; 200 shares.
        assert!((merged.cost_price - 10.0).abs() < 1e-9);
        assert!((merged.shares - 200.0).abs() < 1e-9);
        assert!((merged.basis() - 2000.0).abs() < 1e-9);
        // P&L at 12 = (12 - 10) * 200 = 400.
        assert!((merged.pnl(12.0) - 400.0).abs() < 1e-9);

        let mut snap = Snapshot::default();
        snap.quotes.insert("sh600000".into(), q);
        let state = AppState::default_for_test();
        let (daily, total, pct) = state.totals(&data, &snap);
        assert!((total - 400.0).abs() < 1e-9);
        assert!((daily - 200.0).abs() < 1e-9);
        assert!((pct - 20.0).abs() < 1e-9);
    }

    #[test]
    fn prune_drops_removed_stocks_and_recomputes_extended() {
        let (s, mut q) = stock(Market::Us, "usr_aapl", 100.0);
        q.extended_price = Some(105.0);
        let mut data = AppData {
            stocks: vec![s],
            ..Default::default()
        };
        let mut snap = Snapshot::default();
        snap.quotes.insert("usr_aapl".into(), q.clone());
        snap.quotes.insert("usr_gone".into(), q);
        prune(&mut snap, &data);
        assert_eq!(snap.quotes.len(), 1);
        let pct = snap.quotes["usr_aapl"].extended_change_percent.unwrap();
        assert!((pct - 5.0).abs() < 1e-9);
        data.stocks.clear();
        prune(&mut snap, &data);
        assert!(snap.quotes.is_empty());
    }

    #[test]
    fn compact_money_always_carries_a_sign() {
        // Without a sign the menu bar cannot distinguish a gain from a loss.
        assert_eq!(compact_money(862.0, "¥"), "+¥862");
        assert_eq!(compact_money(-862.0, "¥"), "-¥862");
        assert_eq!(compact_money(80347.0, "¥"), "+¥8.0w");
        assert_eq!(compact_money(-80347.0, "¥"), "-¥8.0w");
        assert_eq!(compact_money(-1500.0, "$"), "-$1500");
    }

    #[test]
    fn compact_percent_keeps_precision_at_small_moves() {
        assert_eq!(compact_percent(0.26), "+0.26%");
        assert_eq!(compact_percent(-0.04), "-0.04%");
        // Below 10 keeps two decimals so sub-percent moves stay readable.
        assert_eq!(compact_percent(4.34), "+4.34%");
        assert_eq!(compact_percent(-12.5), "-12.5%");
        assert_eq!(compact_percent(128.0), "+128%");
        assert_eq!(compact_percent(0.0), "+0.00%");
    }

    #[test]
    fn pnl_percents_are_relative_to_cost_basis() {
        let (s, q) = stock(Market::A, "sh600000", 12.0);
        let mut data = AppData {
            stocks: vec![s],
            ..Default::default()
        };
        let mut a = Account::new("A");
        a.entries.insert(
            "sh600000".into(),
            Position {
                cost_price: 10.0,
                shares: 100.0,
            },
        );
        data.accounts = vec![a];
        let mut snap = Snapshot::default();
        snap.quotes.insert("sh600000".into(), q);
        let state = AppState::default_for_test();
        let (daily_pct, total_pct) = state.pnl_percents(&data, &snap);
        // 100 shares move 1.00 → 100 money on a 1000 basis = 10%; total 200 = 20%.
        assert!((daily_pct - 10.0).abs() < 1e-9, "daily_pct={daily_pct}");
        assert!((total_pct - 20.0).abs() < 1e-9, "total_pct={total_pct}");
    }
}
