use crate::model::{Candle, KlineData, Market};
use reqwest::Client;

/// K-line granularities. `intraday` is handled by `chart.rs`; these three hit
/// Eastmoney's daily-bar endpoint with different `klt` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Day,
    Week,
    Month,
}

impl Period {
    pub fn parse(value: &str) -> Option<Period> {
        match value {
            "day" => Some(Period::Day),
            "week" => Some(Period::Week),
            "month" => Some(Period::Month),
            _ => None,
        }
    }

    fn klt(self) -> u8 {
        match self {
            Period::Day => 101,
            Period::Week => 102,
            Period::Month => 103,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Period::Day => "day",
            Period::Week => "week",
            Period::Month => "month",
        }
    }
}

/// Default window per period: enough to see a trend without turning the axis
/// into confetti at 380px wide.
fn default_limit(period: Period) -> u32 {
    match period {
        Period::Day => 180,
        Period::Week => 160,
        Period::Month => 120,
    }
}

pub async fn fetch(
    client: &Client,
    id: &str,
    secid: &str,
    period: Period,
) -> Result<KlineData, String> {
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}\
         &fields1=f1,f2,f3,f4,f5,f6\
         &fields2=f51,f52,f53,f54,f55,f56\
         &klt={}&\
         &fqt=0&end=20500101&lmt={}",
        period.klt(),
        default_limit(period)
    );
    let path = url.split("eastmoney.com").nth(1).unwrap_or_default();
    if let Some(body) = crate::providers::eastmoney_get(client, path).await
        && let Some(mut data) = parse(&body, id, period)
    {
        data.source = "eastmoney".into();
        return Ok(data);
    }
    // Fallback: Tencent serves the same periods for A/HK/US/KR.
    let key = match period {
        Period::Day => "day",
        Period::Week => "week",
        Period::Month => "month",
    };
    // `id` may arrive as an Eastmoney secid (as in the live tests); Tencent wants
    // the market-prefixed symbol instead.
    let tencent_id = tencent_symbol(id, secid);
    let body = crate::providers::tencent_kline(client, &tencent_id, key, default_limit(period))
        .await
        .ok_or_else(|| "no-data".to_string())?;
    let data = parse_tencent(&body, id, period).ok_or_else(|| "no-data".to_string())?;
    // Korean history only exists on Eastmoney; Tencent serves today's bar alone.
    if data.candles.len() <= 1 {
        return Err("no-data".into());
    }
    Ok(data)
}

pub fn parse(body: &str, id: &str, period: Period) -> Option<KlineData> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    let data = root.get("data")?;
    if data.is_null() {
        return None;
    }
    let rows = data.get("klines")?.as_array()?;
    let mut candles = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(text) = row.as_str() else { continue };
        // date, open, close, high, low, volume
        let parts: Vec<&str> = text.split(',').collect();
        if parts.len() < 6 {
            continue;
        }
        let parse = |i: usize| parts[i].parse::<f64>().ok();
        let (Some(open), Some(close), Some(high), Some(low)) =
            (parse(1), parse(2), parse(3), parse(4))
        else {
            continue;
        };
        if open <= 0.0 || close <= 0.0 || high <= 0.0 || low <= 0.0 {
            continue;
        }
        candles.push(Candle {
            time: parts[0].to_string(),
            open,
            high,
            low,
            close,
            volume: parse(5).unwrap_or(0.0),
        });
    }
    if candles.is_empty() {
        return None;
    }
    Some(KlineData {
        id: id.to_string(),
        period: period.key().to_string(),
        candles,
        source: "eastmoney".to_string(),
    })
}

/// Map a watchlist id or an Eastmoney secid onto the symbol Tencent expects.
fn tencent_symbol(id: &str, secid: &str) -> String {
    if id.starts_with("sh") || id.starts_with("sz") || id.starts_with("bj") {
        return id.to_string();
    }
    if id.starts_with("hk") {
        return id.to_string();
    }
    let (market, code) = secid.split_once('.').unwrap_or(("", ""));
    let code = if code.is_empty() { id } else { code };
    match market {
        "1" => format!("sh{code}"),
        "0" => format!("sz{code}"),
        "116" => format!("hk{code}"),
        "105" | "106" | "107" => format!("us{}", code.replace('_', ".").to_uppercase()),
        "177" => format!("kr{code}"),
        _ => id.to_string(),
    }
}

/// Parse Tencent's kline payload: `data.<symbol>.<period>` is a list of
/// `[date, open, close, high, low, volume]` rows.
pub fn parse_tencent(body: &str, id: &str, period: Period) -> Option<KlineData> {
    parse_tencent_with_source(body, id, period, "tencent")
}

pub fn parse_tencent_with_source(
    body: &str,
    id: &str,
    period: Period,
    source: &str,
) -> Option<KlineData> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    let data = root.get("data")?;
    let symbol = data.as_object()?.keys().next()?.clone();
    let node = data.get(&symbol)?;
    let key = match period {
        Period::Day => "day",
        Period::Week => "week",
        Period::Month => "month",
    };
    let rows = node.get(key)?.as_array()?;
    let mut candles = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(items) = row.as_array() else { continue };
        if items.len() < 6 {
            continue;
        }
        let text = |i: usize| items[i].as_str().unwrap_or_default();
        let (Ok(open), Ok(close), Ok(high), Ok(low)) = (
            text(1).parse::<f64>(),
            text(2).parse::<f64>(),
            text(3).parse::<f64>(),
            text(4).parse::<f64>(),
        ) else {
            continue;
        };
        if open <= 0.0 || close <= 0.0 || high <= 0.0 || low <= 0.0 {
            continue;
        }
        candles.push(Candle {
            time: text(0).to_string(),
            open,
            close,
            high,
            low,
            volume: text(5).parse::<f64>().unwrap_or(0.0),
        });
    }
    if candles.is_empty() {
        return None;
    }
    Some(KlineData {
        id: id.to_string(),
        period: period.key().to_string(),
        candles,
        source: source.to_string(),
    })
}

/// The `secid` used by the daily-bar endpoint is the same one quotes use, so
/// this is only here to keep the call sites readable.
pub fn secid_for(stock: &crate::model::Stock) -> String {
    stock.secid().unwrap_or_else(|| match stock.market {
        Market::A => format!("0.{}", stock.code),
        Market::Hk => format!("116.{}", stock.code),
        Market::Us => format!("105.{}", stock.code.replace('.', "_")),
        Market::Kr => format!("177.{}", stock.code),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_daily_bars() {
        let body = r#"{"data":{"code":"600519","market":1,"klines":[
            "2026-11-07,1440.06,1444.99,1449.99,1435.08,24801",
            "2026-11-10,1438.23,1438.92,1443.66,1431.26,12741"
        ]}}"#;
        let data = parse(body, "sh600519", Period::Day).unwrap();
        assert_eq!(data.period, "day");
        assert_eq!(data.candles.len(), 2);
        let c = &data.candles[1];
        assert_eq!(c.time, "2026-11-10");
        assert!((c.open - 1438.23).abs() < 1e-9);
        assert!((c.high - 1443.66).abs() < 1e-9);
        assert!((c.low - 1431.26).abs() < 1e-9);
        assert!((c.close - 1438.92).abs() < 1e-9);
    }

    #[test]
    fn skips_suspended_rows_with_zero_prices() {
        let body = r#"{"data":{"klines":[
            "2026-11-07,0,0,0,0,0",
            "2026-11-10,10,11,12,9,100"
        ]}}"#;
        let data = parse(body, "sh600000", Period::Day).unwrap();
        assert_eq!(data.candles.len(), 1);
    }

    #[test]
    fn rejects_empty_payload() {
        assert!(parse(r#"{"data":null}"#, "x", Period::Week).is_none());
        assert!(parse(r#"{"data":{"klines":[]}}"#, "x", Period::Week).is_none());
        assert!(parse("not json", "x", Period::Month).is_none());
    }

    #[test]
    fn parses_period_names() {
        assert_eq!(Period::parse("day"), Some(Period::Day));
        assert_eq!(Period::parse("month"), Some(Period::Month));
        assert_eq!(Period::parse("minute"), None);
    }
}

#[cfg(test)]
mod tencent_tests {
    use super::*;

    #[test]
    fn parses_tencent_day_rows() {
        let body = r#"{"code":0,"data":{"sh600519":{"day":[
            ["2026-11-03","1450.000","1480.000","1480.000","1435.100","74121.000"],
            ["2026-11-10","1438.23","1441.86","1444.50","1431.26","22652"]
        ]}}}"#;
        let data = parse_tencent(body, "sh600519", Period::Day).unwrap();
        assert_eq!(data.candles.len(), 2);
        let c = &data.candles[1];
        // Tencent orders open, close, high, low.
        assert!((c.open - 1438.23).abs() < 1e-9);
        assert!((c.close - 1441.86).abs() < 1e-9);
        assert!((c.high - 1444.50).abs() < 1e-9);
        assert!((c.low - 1431.26).abs() < 1e-9);
        assert!(c.high >= c.close && c.low <= c.open);
    }

    #[test]
    fn returns_none_for_empty_payloads() {
        assert!(parse_tencent(r#"{"data":{}}"#, "x", Period::Day).is_none());
        assert!(parse_tencent("not json", "x", Period::Week).is_none());
    }
}
