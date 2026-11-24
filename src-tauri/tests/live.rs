//! Live provider checks. Ignored by default because they hit public endpoints.
//! Run with: `cargo test --test live -- --ignored --nocapture`

use stockpot_lib::model::Market;
use stockpot_lib::providers;

#[tokio::test]
#[ignore]
async fn sina_a_share_quote() {
    let client = providers::client();
    let quotes = providers::sina_quotes(&client, &["sh600519".into(), "sz000001".into()], Market::A).await;
    for q in &quotes {
        println!("{} {} {}", q.id, q.name, q.price);
    }
    assert!(!quotes.is_empty(), "sina returned no A-share quotes");
    assert!(quotes.iter().all(|q| q.price > 0.0 && q.prev_close > 0.0));
}

#[tokio::test]
#[ignore]
async fn sina_us_quote() {
    let client = providers::client();
    let quotes = providers::sina_quotes(&client, &["usr_aapl".into()], Market::Us).await;
    assert!(!quotes.is_empty(), "sina returned no US quote");
    println!("{:?}", quotes[0].price);
}

#[tokio::test]
#[ignore]
async fn tencent_hk_quote() {
    let client = providers::client();
    let quotes = providers::tencent_hk_quotes(&client, &["00700".into(), "03690".into()]).await;
    println!("count={} {:?}", quotes.len(), quotes.iter().map(|q| &q.id).collect::<Vec<_>>());
    assert_eq!(quotes.len(), 2, "expected two HK quotes");
    for q in &quotes {
        println!("{} {} {}", q.id, q.name, q.price);
    }
}

#[tokio::test]
#[ignore]
async fn eastmoney_batch_covers_all_markets() {
    let client = providers::client();
    let targets = vec![
        ("sh600519".to_string(), "1.600519".to_string(), Market::A),
        ("hk00700".to_string(), "116.00700".to_string(), Market::Hk),
        ("usr_aapl".to_string(), "105.AAPL".to_string(), Market::Us),
        ("kr_005930".to_string(), "177.005930".to_string(), Market::Kr),
    ];
    let quotes = providers::eastmoney_quotes(&client, &targets).await;
    println!("{:?}", quotes.iter().map(|q| (&q.id, q.price)).collect::<Vec<_>>());
    // Eastmoney's batch host is intermittent; the app falls back to per-market
    // feeds, so a partial or empty answer here is not a failure.
    if quotes.is_empty() {
        println!("eastmoney batch unavailable right now; per-market feeds cover it");
    } else {
        assert!(quotes.iter().any(|q| q.id == "sh600519"));
    }
}

#[tokio::test]
#[ignore]
async fn rates_have_plausible_bounds() {
    let client = providers::client();
    let rates = providers::sina_rates(&client).await.expect("rates");
    println!("{rates:?}");
    assert!(rates.usd_cny > 5.0 && rates.usd_cny < 9.0);
    assert!(rates.usd_hkd > 7.0 && rates.usd_hkd < 8.5);
    assert!(rates.usd_krw > 900.0 && rates.usd_krw < 2000.0);
}

#[tokio::test]
#[ignore]
async fn search_finds_every_market() {
    let client = providers::client();
    let cases = [
        ("600519", Market::A),
        ("腾讯", Market::Hk),
        ("AAPL", Market::Us),
        ("005930", Market::Kr),
    ];
    for (keyword, market) in cases {
        let (tencent, eastmoney) = futures::join!(
            providers::tencent_search(&client, keyword),
            providers::eastmoney_search(&client, keyword)
        );
        let found = tencent
            .iter()
            .chain(eastmoney.iter())
            .any(|r| r.market == market);
        println!("{keyword}: tencent={} eastmoney={} ok={found}", tencent.len(), eastmoney.len());
        assert!(found, "no {market:?} result for {keyword}");
    }
}

#[tokio::test]
#[ignore]
async fn intraday_series_are_ordered() {
    let client = providers::client();
    let a = providers::tencent_intraday(&client, "sh600519", Market::A)
        .await
        .expect("A intraday");
    assert!(a.points.len() > 10);
    assert!(a.points.windows(2).all(|w| w[0].0 <= w[1].0));

    let hk = providers::tencent_intraday(&client, "hk00700", Market::Hk)
        .await
        .expect("HK intraday");
    assert!(hk.points.len() > 10);

    // US and Korean intraday depend on Eastmoney, which is intermittent.
    match providers::eastmoney_intraday(&client, "105.AAPL", Market::Us).await {
        Some(us) => {
            assert!(us.points.len() > 10);
            assert!(us.points.iter().all(|p| (0..=960).contains(&p.0)));
            println!("US intraday: {} points", us.points.len());
        }
        None => println!("US intraday unavailable right now"),
    }
    println!("A={} HK={}", a.points.len(), hk.points.len());
}

#[tokio::test]
#[ignore]
async fn kline_works_for_every_period_and_market() {
    let client = providers::client();
    for (secid, market) in [
        ("1.600519", "A"),
        ("116.00700", "HK"),
        ("105.AAPL", "US"),
        ("177.005930", "KR"),
    ] {
        for period in [
            stockpot_lib::kline::Period::Day,
            stockpot_lib::kline::Period::Week,
            stockpot_lib::kline::Period::Month,
        ] {
            let data = match stockpot_lib::kline::fetch(&client, secid, secid, period).await {
                Ok(data) => data,
                // Korean history lives only on Eastmoney; when that host is
                // rate-limited the endpoint degrades rather than lying.
                Err(e) if market == "KR" => {
                    println!("{market} {:?}: degraded ({e}) — Eastmoney unavailable", period);
                    continue;
                }
                Err(e) => panic!("{market} {:?}: {e}", period),
            };
            println!("{market} {:?}: {} bars from {}, last {}", period, data.candles.len(),
                data.source, data.candles.last().unwrap().time);
            assert!(data.candles.len() > 20);
            assert!(data
                .candles
                .windows(2)
                .all(|w| w[0].time <= w[1].time), "dates must be ascending");
            // OHLC invariants hold for every bar.
            assert!(data.candles.iter().all(|c| c.high >= c.low
                && c.high >= c.open.max(c.close)
                && c.low <= c.open.min(c.close)));
        }
    }
}

#[tokio::test]
#[ignore]
async fn hk_intraday_tail_has_no_axis_gap() {
    let client = providers::client();
    let data = stockpot_lib::chart::intraday(&client, "hk00700", Market::Hk, "116.00700")
        .await
        .expect("HK intraday");
    let last = data.points.last().unwrap();
    println!(
        "points={} prevClose={} last index={} time={} price={}",
        data.points.len(), data.prev_close, last.i, last.time, last.price
    );
    assert!(data.prev_close > 0.0, "previous close must be known");
    // Every point must sit inside the axis, otherwise the series silently skips
    // the closing print and the line jumps.
    assert!(data.points.iter().all(|p| p.i >= 0 && p.i < data.axis_length));
    // The closing auction collapses onto the last column.
    assert_eq!(last.i, data.axis_length - 1);
    // Consecutive samples must never skip more than a minute's worth of columns.
    let mut worst = 0;
    for w in data.points.windows(2) {
        worst = worst.max(w[1].i - w[0].i);
    }
    println!("largest column gap: {worst}");
    assert!(worst <= 2, "unexpected gap of {worst} columns");
}

#[tokio::test]
#[ignore]
async fn hk_tail_is_not_a_spike() {
    let client = providers::client();
    let data = stockpot_lib::chart::intraday(&client, "hk00700", Market::Hk, "116.00700")
        .await
        .expect("HK intraday");
    let n = data.points.len();
    let prev = &data.points[n - 2];
    let last = &data.points[n - 1];
    let jump = (last.price - prev.price).abs() / prev.price * 100.0;
    println!(
        "prev {}@{:.2} -> last {}@{:.2}  ({jump:.2}%)",
        prev.time, prev.price, last.time, last.price
    );
    // A one-column move at the close should be a real tick, not a rendering
    // artefact. (>2% on Tencent at 16:00 would mean a broken series.)
    assert!(jump < 2.0, "suspicious {jump:.2}% jump in the final column");
}

#[tokio::test]
#[ignore]
async fn dump_hk_points_for_visual_check() {
    let client = providers::client();
    let data = stockpot_lib::chart::intraday(&client, "hk00700", Market::Hk, "116.00700")
        .await
        .expect("HK intraday");
    let json = serde_json::to_string(&data).unwrap();
    std::fs::write("/tmp/hk_points.json", &json).unwrap();
    println!("wrote {} bytes", json.len());
}
