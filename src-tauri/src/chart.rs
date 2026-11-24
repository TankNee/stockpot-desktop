use crate::market;
use crate::model::{ChartData, ChartLabel, ChartPoint, ChartSession, Market};
use crate::providers;
use reqwest::Client;
use std::collections::BTreeMap;

/// Build a minute chart for a stock. Tencent is used for A-shares and Hong
/// Kong; Eastmoney covers Korean and US extended-hours sessions. The axis is
/// normalised on the Rust side so the frontend only has to plot numbers.
pub async fn intraday(
    client: &Client,
    id: &str,
    market: Market,
    secid: &str,
) -> Result<ChartData, String> {
    let series = match market {
        Market::A | Market::Hk => match providers::tencent_intraday(client, id, market).await {
            Some(s) => s,
            None => providers::eastmoney_intraday(client, secid, market)
                .await
                .ok_or_else(|| "no-data".to_string())?,
        },
        Market::Us | Market::Kr => providers::eastmoney_intraday(client, secid, market)
            .await
            .ok_or_else(|| "no-data".to_string())?,
    };

    let axis = market::axis(market);
    let mut by_index: BTreeMap<i32, (f64, String)> = BTreeMap::new();
    for (idx, price, time) in series.points {
        by_index.insert(idx, (price, time));
    }
    let mut points: Vec<ChartPoint> = by_index
        .into_iter()
        .map(|(i, (price, time))| ChartPoint { i, price, time })
        .collect();

    // Korean feeds start at the 08:00 pre-open ramp; drop the flat pre-market
    // block so the first visible point is the 09:00 open.
    if market == Market::Kr
        && let Some(first_trade) = points.iter().position(|p| p.i >= 60)
    {
        points = points.split_off(first_trade);
    }

    let labels = axis
        .labels
        .iter()
        .map(|(i, label)| ChartLabel {
            i: *i,
            label: (*label).to_string(),
        })
        .collect();
    let sessions = axis
        .sessions
        .iter()
        .map(|(key, start, end)| ChartSession {
            key: (*key).to_string(),
            label: (*key).to_string(),
            start: *start,
            end: *end,
        })
        .collect();

    Ok(ChartData {
        id: id.to_string(),
        points,
        prev_close: series.prev_close,
        axis_length: axis.length,
        labels,
        sessions,
        source: "live".into(),
    })
}
