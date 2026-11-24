use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Market {
    A,
    Hk,
    Us,
    Kr,
}

impl Market {
    pub fn currency(self) -> &'static str {
        match self {
            Market::A => "CNY",
            Market::Hk => "HKD",
            Market::Us => "USD",
            Market::Kr => "KRW",
        }
    }

    pub fn all() -> [Market; 4] {
        [Market::A, Market::Hk, Market::Us, Market::Kr]
    }

    /// Short key used on the wire (`a`, `hk`, `us`, `kr`).
    pub fn key(self) -> &'static str {
        match self {
            Market::A => "a",
            Market::Hk => "hk",
            Market::Us => "us",
            Market::Kr => "kr",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertDirection {
    Rise,
    Fall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceAlert {
    pub target_price: f64,
    #[serde(default)]
    pub direction: Option<AlertDirection>,
    #[serde(default)]
    pub enabled: bool,
}

impl PriceAlert {
    pub fn reached(&self, price: f64) -> bool {
        if !self.enabled || price <= 0.0 {
            return false;
        }
        match self.direction {
            Some(AlertDirection::Rise) => price >= self.target_price,
            Some(AlertDirection::Fall) => price <= self.target_price,
            None => false,
        }
    }

    pub fn direction_for(target: f64, current: f64) -> AlertDirection {
        if target >= current {
            AlertDirection::Rise
        } else {
            AlertDirection::Fall
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stock {
    pub id: String,
    pub code: String,
    pub name: String,
    pub market: Market,
    #[serde(default)]
    pub alert: Option<PriceAlert>,
    /// Eastmoney secid captured when the stock is added via search (US tickers can
    /// live on several exchanges, so the exchange id matters).
    #[serde(default)]
    pub secid: Option<String>,
    /// Single-position fields from before multi-account support. They keep their
    /// original JSON names so old files load, are folded into an account on the
    /// first run, and are cleared afterwards.
    #[serde(default, rename = "costPrice", skip_serializing_if = "Option::is_none")]
    pub legacy_cost_price: Option<f64>,
    #[serde(default, rename = "shares", skip_serializing_if = "Option::is_none")]
    pub legacy_shares: Option<f64>,
}

impl Stock {
    pub fn secid(&self) -> Option<String> {
        if let Some(s) = &self.secid
            && !s.is_empty()
        {
            return Some(s.clone());
        }
        match self.market {
            Market::A => {
                let prefix = if self.code.starts_with('6')
                    || self.code.starts_with('5')
                    || self.code.starts_with('9') && !self.code.starts_with("92")
                    || self.code.starts_with("68")
                {
                    "1"
                } else {
                    "0"
                };
                Some(format!("{prefix}.{}", self.code))
            }
            Market::Hk => Some(format!("116.{}", self.code)),
            Market::Us => Some(format!("105.{}", self.code.replace('.', "_"))),
            Market::Kr => Some(format!("177.{}", self.code)),
        }
    }
}

/// One stock inside one account. The same stock can be held in several
/// accounts at different costs; the list view merges them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub cost_price: f64,
    pub shares: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub entries: HashMap<String, Position>,
}

impl Account {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            entries: HashMap::new(),
        }
    }
}

/// Merged view of one stock across every account: total shares, weighted
/// average cost, and the resulting cost basis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Merged {
    pub shares: f64,
    pub cost_price: f64,
}

impl Merged {
    /// Market value at `price`.
    pub fn value(&self, price: f64) -> f64 {
        price * self.shares
    }

    pub fn basis(&self) -> f64 {
        self.cost_price * self.shares
    }

    pub fn pnl(&self, price: f64) -> f64 {
        (price - self.cost_price) * self.shares
    }
}

/// Weighted-average merge of every account's position in `stock_id`.
/// Returns `None` when no account holds it.
pub fn merge_positions(accounts: &[Account], stock_id: &str) -> Option<Merged> {
    let mut shares = 0.0;
    let mut basis = 0.0;
    for account in accounts {
        if let Some(entry) = account.entries.get(stock_id) {
            if entry.shares <= 0.0 || entry.cost_price <= 0.0 {
                continue;
            }
            shares += entry.shares;
            basis += entry.cost_price * entry.shares;
        }
    }
    if shares <= 0.0 {
        return None;
    }
    Some(Merged {
        shares,
        cost_price: basis / shares,
    })
}

/// Every account that holds `stock_id`, in account order. Used by the merged
/// row to explain where the average came from.
pub fn lots_for<'a>(accounts: &'a [Account], stock_id: &str) -> Vec<(&'a Account, &'a Position)> {
    accounts
        .iter()
        .filter_map(|account| {
            account
                .entries
                .get(stock_id)
                .filter(|entry| entry.shares > 0.0)
                .map(|entry| (account, entry))
        })
        .collect()
}

/// Fold legacy `costPrice`/`shares` on each stock into a "Default" account, and
/// adopt any `watchlists` from the pre-account file shape. Idempotent: once the
/// legacy fields are cleared this does nothing.
pub fn migrate(data: &mut AppData, raw: &serde_json::Value) {
    // Older builds stored positions per "watchlist"; bring those across so no
    // holding is lost.
    if data.accounts.is_empty()
        && let Some(lists) = raw.get("watchlists").and_then(|v| v.as_array())
    {
        for list in lists {
            let Some(name) = list.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let mut account = Account::new(name);
            if let Some(entries) = list.get("entries").and_then(|v| v.as_object()) {
                for (stock_id, entry) in entries {
                    let cost = entry.get("costPrice").and_then(|v| v.as_f64());
                    let shares = entry.get("shares").and_then(|v| v.as_f64());
                    if let (Some(cost_price), Some(shares)) = (cost, shares)
                        && cost_price > 0.0
                        && shares > 0.0
                    {
                        account
                            .entries
                            .insert(stock_id.clone(), Position { cost_price, shares });
                    }
                }
            }
            if !account.entries.is_empty() {
                data.accounts.push(account);
            }
        }
    }

    let mut moved = false;
    let mut default_account: Option<usize> = None;
    for stock in data.stocks.iter_mut() {
        let (Some(cost), Some(shares)) = (stock.legacy_cost_price, stock.legacy_shares) else {
            continue;
        };
        if cost > 0.0 && shares > 0.0 {
            let index = *default_account.get_or_insert_with(|| {
                data.accounts
                    .iter()
                    .position(|a| a.name == DEFAULT_ACCOUNT)
                    .unwrap_or_else(|| {
                        data.accounts.push(Account::new(DEFAULT_ACCOUNT));
                        data.accounts.len() - 1
                    })
            });
            data.accounts[index]
                .entries
                .insert(stock.id.clone(), Position { cost_price: cost, shares });
            moved = true;
        }
        stock.legacy_cost_price = None;
        stock.legacy_shares = None;
    }
    let _ = moved;

    if data.accounts.is_empty() {
        data.accounts.push(Account::new(DEFAULT_ACCOUNT));
    }
}

/// Name given to the account created when an old single-position file is opened.
pub const DEFAULT_ACCOUNT: &str = "Default";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// none | stock | dailyPnl | totalPnl | bothPnl
    pub menu_bar_mode: String,
    pub menu_bar_stock_id: String,
    pub refresh_interval: u64,
    /// chinese (red up) | western (green up)
    pub color_scheme: String,
    pub currency: String,
    /// changeDesc | changeAsc | manual
    pub sort_rule: String,
    /// session | regular
    pub us_price_mode: String,
    pub group_holdings: bool,
    /// light | dark | system
    pub theme: String,
    /// zh | en | ja
    pub language: String,
    pub launch_at_login: bool,
    /// Show a Dock tile (and ⌘Tab entry). Off by default; the app is a menu bar
    /// extra, but some people like having the window in the Dock.
    pub show_dock_icon: bool,
    /// Menu bar P&L units: amount | percent | both
    pub menu_bar_pnl_format: String,
    /// Quote-tick highlight: off | short | normal | long
    pub flash_duration: String,
    /// List density: show P&L as amounts, or percentages only.
    pub pnl_display: String,
    /// 更新从哪儿拿：server（自建）/ github（release）。
    /// 默认 macOS 走 github——这台服务器拉不到 GitHub 的包，但 macOS 客户端能直连。
    #[serde(default = "default_update_source")]
    pub update_source: String,
    /// GitHub 更新源要访问私有仓库时填一个只读令牌，公开仓库留空即可。
    #[serde(default)]
    pub github_token: String,
    /// 自建同步服务器的地址，空了就用内置的。
    #[serde(default)]
    pub server_url: String,
    /// Ollama JEV endpoint for AI classification, e.g.
    /// `http://localhost:11434/v1`. Empty means the feature is off.
    #[serde(default)]
    pub ai_endpoint: String,
    #[serde(default)]
    pub ai_model: String,
    /// Stored in plain text in the app's own data file; the app never sends it
    /// anywhere except the endpoint above.
    #[serde(default)]
    pub ai_api_key: String,
    /// Bills per request. Long batches are cheaper but more likely to be cut off.
    #[serde(default = "default_ai_batch")]
    pub ai_batch_size: u32,
}

fn default_ai_batch() -> u32 {
    12
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            menu_bar_mode: "stock".into(),
            menu_bar_stock_id: String::new(),
            refresh_interval: 5,
            color_scheme: "chinese".into(),
            currency: "CNY".into(),
            sort_rule: "changeDesc".into(),
            us_price_mode: "session".into(),
            group_holdings: false,
            theme: "system".into(),
            language: "zh".into(),
            launch_at_login: false,
            show_dock_icon: false,
            menu_bar_pnl_format: "amount".into(),
            flash_duration: "normal".into(),
            pnl_display: "amount".into(),
            ai_endpoint: "http://localhost:11434/v1".into(),
            ai_model: "tev1:4b".into(),
            ai_api_key: String::new(),
            ai_batch_size: 12,
            update_source: default_update_source(),
            github_token: String::new(),
            server_url: String::new(),
        }
    }
}

fn default_update_source() -> String {
    if cfg!(target_os = "macos") {
        "github".to_string()
    } else {
        "server".to_string()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    #[serde(default)]
    pub stocks: Vec<Stock>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub accounts: Vec<Account>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub id: String,
    pub name: String,
    pub price: f64,
    pub change: f64,
    pub change_percent: f64,
    pub prev_close: f64,
    /// Local time of the quote, `YYYY-MM-DD HH:MM:SS`
    pub time: String,
    pub currency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_change_percent: Option<f64>,
    /// pre | post | night
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended_label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub usd_cny: f64,
    pub usd_hkd: f64,
    pub usd_krw: f64,
}

impl Default for Rates {
    fn default() -> Self {
        Self {
            usd_cny: 7.10,
            usd_hkd: 7.80,
            usd_krw: 1400.0,
        }
    }
}

impl Rates {
    /// Convert an amount in a market's currency into CNY.
    pub fn to_cny(&self, amount: f64, market: Market) -> f64 {
        match market {
            Market::A => amount,
            Market::Hk => amount * (self.usd_cny / self.usd_hkd),
            Market::Us => amount * self.usd_cny,
            Market::Kr => amount * (self.usd_cny / self.usd_krw),
        }
    }

    pub fn from_cny(&self, amount_cny: f64, currency: &str) -> f64 {
        match currency {
            "HKD" => amount_cny / (self.usd_cny / self.usd_hkd),
            "USD" => amount_cny / self.usd_cny,
            "KRW" => amount_cny / (self.usd_cny / self.usd_krw),
            _ => amount_cny,
        }
    }

    pub fn convert(&self, amount: f64, market: Market, currency: &str) -> f64 {
        self.from_cny(self.to_cny(amount, market), currency)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub quotes: HashMap<String, Quote>,
    pub rates: Rates,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartPoint {
    pub i: i32,
    pub price: f64,
    pub time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSession {
    pub key: String,
    pub label: String,
    pub start: i32,
    pub end: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartLabel {
    pub i: i32,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartData {
    pub id: String,
    pub points: Vec<ChartPoint>,
    pub prev_close: f64,
    pub axis_length: i32,
    pub labels: Vec<ChartLabel>,
    pub sessions: Vec<ChartSession>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candle {
    /// `YYYY-MM-DD` for day/week/month bars.
    pub time: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KlineData {
    pub id: String,
    /// day | week | month
    pub period: String,
    pub candles: Vec<Candle>,
    /// Which feed answered: `eastmoney` or `tencent`.
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub code: String,
    pub name: String,
    pub market: Market,
    pub secid: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(name: &str, lots: &[(&str, f64, f64)]) -> Account {
        let mut a = Account::new(name);
        for (id, cost, shares) in lots {
            a.entries.insert(
                (*id).to_string(),
                Position {
                    cost_price: *cost,
                    shares: *shares,
                },
            );
        }
        a
    }

    #[test]
    fn merges_same_stock_across_accounts_at_weighted_cost() {
        let accounts = vec![
            account("A", &[("sh600519", 1500.0, 100.0)]),
            account("B", &[("sh600519", 1800.0, 300.0)]),
            account("C", &[("hk00700", 400.0, 200.0)]),
        ];
        let merged = merge_positions(&accounts, "sh600519").unwrap();
        assert_eq!(merged.shares, 400.0);
        // (1500*100 + 1800*300) / 400 = 1725
        assert!((merged.cost_price - 1725.0).abs() < 1e-9);
        assert!((merged.basis() - 690_000.0).abs() < 1e-9);
        assert!((merged.pnl(1900.0) - ((1900.0 - 1725.0) * 400.0)).abs() < 1e-9);
    }

    #[test]
    fn merge_ignores_empty_and_zero_lots() {
        let accounts = vec![
            account("A", &[("sh600519", 10.0, 0.0)]),
            account("B", &[]),
            account("C", &[("sh600519", 20.0, 100.0)]),
        ];
        let merged = merge_positions(&accounts, "sh600519").unwrap();
        assert_eq!(merged.shares, 100.0);
        assert!((merged.cost_price - 20.0).abs() < 1e-9);
        assert!(merge_positions(&accounts, "nope").is_none());
    }

    #[test]
    fn lots_report_every_account_holding_the_stock() {
        let accounts = vec![
            account("A", &[("sh600519", 1500.0, 100.0)]),
            account("B", &[("sh600519", 1800.0, 300.0), ("hk00700", 400.0, 1.0)]),
        ];
        let lots = lots_for(&accounts, "sh600519");
        assert_eq!(lots.len(), 2);
        assert_eq!(lots[1].0.name, "B");
        assert!((lots[1].1.cost_price - 1800.0).abs() < 1e-9);
    }

    #[test]
    fn migrates_legacy_single_position_into_default_account() {
        let raw = serde_json::json!({
            "stocks": [
                {"id":"sh600519","code":"600519","name":"贵州茅台","market":"a",
                 "costPrice": 1512.4, "shares": 60}
            ],
            "settings": {},
            "watchlists": [
                {"id":"w1","name":"长线","entries":{
                    "hk00700":{"costPrice":402.6,"shares":200}
                }}
            ]
        });
        let mut data: AppData = serde_json::from_value(raw.clone()).unwrap();
        // Legacy fields arrive under their original JSON names.
        assert_eq!(data.stocks[0].legacy_cost_price, Some(1512.4));
        migrate(&mut data, &raw);

        assert_eq!(data.accounts.len(), 2);
        let names: Vec<&str> = data.accounts.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"长线"));
        assert!(names.contains(&DEFAULT_ACCOUNT));

        let merged = merge_positions(&data.accounts, "sh600519").unwrap();
        assert_eq!(merged.shares, 60.0);
        assert!((merged.cost_price - 1512.4).abs() < 1e-9);

        // The old fields are cleared so a second save cannot duplicate the lot.
        assert!(data.stocks[0].legacy_cost_price.is_none());
        assert!(data.stocks[0].legacy_shares.is_none());
    }

    #[test]
    fn migration_is_idempotent_and_seeds_one_account() {
        let mut data = AppData::default();
        migrate(&mut data, &serde_json::Value::Null);
        assert_eq!(data.accounts.len(), 1);
        migrate(&mut data, &serde_json::Value::Null);
        assert_eq!(data.accounts.len(), 1);
        assert_eq!(data.accounts[0].name, DEFAULT_ACCOUNT);
    }

    #[test]
    fn stock_json_survives_a_round_trip_without_legacy_keys() {
        let stock = Stock {
            id: "sh600519".into(),
            code: "600519".into(),
            name: "贵州茅台".into(),
            market: Market::A,
            alert: None,
            secid: None,
            legacy_cost_price: None,
            legacy_shares: None,
        };
        let json = serde_json::to_string(&stock).unwrap();
        assert!(!json.contains("costPrice"));
        assert!(!json.contains("legacy"));
        let back: Stock = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, stock.id);
    }
}
