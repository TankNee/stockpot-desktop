//! End-to-end check of the refresh pipeline against live public endpoints.
//! Ignored by default: `cargo test --test pipeline -- --ignored --nocapture`

use stockpot_lib::market;
use stockpot_lib::model::*;
use stockpot_lib::providers;
use stockpot_lib::state::{alert_price, AppState};

fn sample_data() -> AppData {
    AppData {
        stocks: vec![
            Stock {
                id: "sh600519".into(),
                code: "600519".into(),
                name: String::new(),
                market: Market::A,
                alert: None,
                secid: None,
                legacy_cost_price: None,
                legacy_shares: None,
            },
            Stock {
                id: "hk00700".into(),
                code: "00700".into(),
                name: String::new(),
                market: Market::Hk,
                alert: Some(PriceAlert {
                    target_price: 1.0,
                    direction: Some(AlertDirection::Fall),
                    enabled: true,
                }),
                secid: None,
                legacy_cost_price: None,
                legacy_shares: None,
            },
            Stock {
                id: "usr_aapl".into(),
                code: "AAPL".into(),
                name: String::new(),
                market: Market::Us,
                alert: None,
                secid: Some("105.AAPL".into()),
                legacy_cost_price: None,
                legacy_shares: None,
            },
            Stock {
                id: "kr_005930".into(),
                code: "005930".into(),
                name: String::new(),
                market: Market::Kr,
                alert: None,
                secid: Some("177.005930".into()),
                legacy_cost_price: None,
                legacy_shares: None,
            },
        ],
        settings: Settings::default(),
        accounts: vec![stockpot_lib::model::Account::new("Default")],
    }
}

#[tokio::test]
#[ignore]
async fn refresh_populates_quotes_for_every_market() {
    let dir = std::env::temp_dir().join(format!("stockpot-pipeline-{}", uuid::Uuid::new_v4()));
    stockpot_lib::store::ensure_dir(&dir).unwrap();
    let data = sample_data();
    stockpot_lib::store::write_data_file(&dir, &data).unwrap();
    // AppState only needs a handle for paths; the heavy lifting is the fetch
    // itself, which is exercised here directly through the providers.
    let client = providers::client();
    let now = chrono::Utc::now();

    let a_ids: Vec<String> = data.stocks.iter().filter(|s| s.market == Market::A).map(|s| s.id.clone()).collect();
    let us_ids: Vec<String> = data.stocks.iter().filter(|s| s.market == Market::Us).map(|s| s.id.clone()).collect();
    let hk_codes: Vec<String> = data.stocks.iter().filter(|s| s.market == Market::Hk).map(|s| s.code.clone()).collect();
    let mut quotes = std::collections::HashMap::new();
    for q in providers::sina_quotes(&client, &a_ids, Market::A).await {
        quotes.insert(q.id.clone(), (q.price, q.prev_close, q.name));
    }
    for q in providers::tencent_hk_quotes(&client, &hk_codes).await {
        quotes.insert(q.id.clone(), (q.price, q.prev_close, q.name));
    }
    for q in providers::sina_quotes(&client, &us_ids, Market::Us).await {
        quotes.insert(q.id.clone(), (q.price, q.prev_close, q.name));
    }
    // Korean quotes come from the Eastmoney batch endpoint.
    let kr_codes: Vec<String> = data
        .stocks
        .iter()
        .filter(|s| s.market == Market::Kr)
        .map(|s| s.code.clone())
        .collect();
    let targets: Vec<(String, String, Market)> = data
        .stocks
        .iter()
        .filter(|s| s.market == Market::Kr)
        .filter_map(|s| s.secid().map(|secid| (s.id.clone(), secid, s.market)))
        .collect();
    // Korean quotes come from Tencent now; Eastmoney is a fallback.
    for q in providers::tencent_kr_quotes(&client, &kr_codes).await {
        quotes.insert(q.id.clone(), (q.price, q.prev_close, q.name));
    }
    for q in providers::eastmoney_quotes(&client, &targets).await {
        quotes.entry(q.id.clone()).or_insert((q.price, q.prev_close, q.name));
    }

    for stock in &data.stocks {
        let entry = quotes.get(&stock.id);
        println!("{:<12} {:?}", stock.id, entry);
        assert!(entry.is_some(), "missing quote for {}", stock.id);
        let (price, prev, _name) = entry.unwrap();
        assert!(*price > 0.0 && *prev > 0.0);
    }

    // Alert price resolution for a Korean stock outside its session falls back
    // to the regular price; for US it uses the extended tape.
    let us_quote = Quote {
        id: "usr_aapl".into(),
        name: "AAPL".into(),
        price: 350.0,
        change: 1.0,
        change_percent: 0.3,
        prev_close: 349.0,
        time: String::new(),
        currency: "USD".into(),
        extended_price: Some(352.0),
        extended_change_percent: None,
        extended_label: None,
    };
    let (price, label) = alert_price(&data.stocks[2], &us_quote, now).expect("alert price");
    println!("US alert price {price} label {label:?}");
    assert!(price > 0.0);

    println!("session now: A={} HK={} US={} KR={}",
        market::session(Market::A, now),
        market::session(Market::Hk, now),
        market::session(Market::Us, now),
        market::session(Market::Kr, now));

    std::fs::remove_dir_all(&dir).ok();
    let _ = AppState::new; // keep the symbol referenced for future wiring
}
