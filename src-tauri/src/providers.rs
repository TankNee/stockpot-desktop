use crate::model::Market;
use reqwest::Client;
use std::time::Duration;

pub const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub fn client() -> Client {
    Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .build()
        .expect("failed to build http client")
}

fn decode_gb18030(bytes: &[u8]) -> String {
    let (text, _, _) = encoding_rs::GB18030.decode(bytes);
    text.into_owned()
}

/// Sina wires the id into the URL, so quote ids have to be lowercase and use
/// `$` for class shares (`usr_brk$b`).
fn sina_list(codes: &[String]) -> String {
    codes
        .iter()
        .map(|c| c.to_lowercase().replace('.', "$"))
        .collect::<Vec<_>>()
        .join(",")
}

pub struct RawQuote {
    pub id: String,
    pub name: String,
    pub price: f64,
    pub prev_close: f64,
    pub time: String,
    pub market: Market,
    pub extended_price: Option<f64>,
}

/// Sina ends A-share rows with `date,time,status`, but the number of leading
/// fields varies between exchanges, so locate the date rather than indexing it.
fn sina_a_share_time(fields: &[&str]) -> String {
    let date_at = fields.iter().position(|f| {
        f.len() == 10 && f.as_bytes().get(4) == Some(&b'-') && f.as_bytes().get(7) == Some(&b'-')
    });
    match date_at {
        Some(i) => {
            let time = fields.get(i + 1).copied().unwrap_or("");
            format!("{} {}", fields[i], time).trim().to_string()
        }
        None => String::new(),
    }
}

/// Fetch real-time quotes for A-shares and US stocks from Sina.
pub async fn sina_quotes(client: &Client, ids: &[String], market: Market) -> Vec<RawQuote> {
    if ids.is_empty() {
        return Vec::new();
    }
    let url = format!("https://hq.sinajs.cn/list={}", sina_list(ids));
    let body = match client
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
    {
        Ok(res) => match res.bytes().await {
            Ok(b) => decode_gb18030(&b),
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    parse_sina(&body, market)
}

pub fn parse_sina(body: &str, market: Market) -> Vec<RawQuote> {
    let mut out = Vec::new();
    for line in body.split_inclusive(';') {
        let line = line.trim();
        let Some(start) = line.find("hq_str_") else { continue };
        let Some(eq) = line[start..].find("=\"") else { continue };
        let raw_id = &line[start + "hq_str_".len()..start + eq];
        let id = raw_id.replace('$', ".");
        let Some(open) = line.find("=\"") else { continue };
        let Some(close) = line.rfind('"') else { continue };
        if close <= open + 2 {
            continue;
        }
        let payload = &line[open + 2..close];
        let fields: Vec<&str> = payload.split(',').collect();
        let q = match market {
            Market::A => {
                if fields.len() < 32 {
                    continue;
                }
                let prev = fields[2].parse::<f64>().unwrap_or(0.0);
                let price = fields[3].parse::<f64>().unwrap_or(0.0);
                if price <= 0.0 || prev <= 0.0 {
                    continue;
                }
                RawQuote {
                    id,
                    name: fields[0].to_string(),
                    price,
                    prev_close: prev,
                    time: sina_a_share_time(&fields),
                    market,
                    extended_price: None,
                }
            }
            Market::Us => {
                if fields.len() < 27 {
                    continue;
                }
                let prev = fields[26].parse::<f64>().unwrap_or(0.0);
                let raw = fields[1].parse::<f64>().unwrap_or(0.0);
                let ext = fields[21].parse::<f64>().unwrap_or(0.0);
                let price = if raw > 0.0 { raw } else { ext };
                if price <= 0.0 || prev <= 0.0 {
                    continue;
                }
                RawQuote {
                    id,
                    name: fields[0].to_string(),
                    price,
                    prev_close: prev,
                    time: fields[3].to_string(),
                    market,
                    extended_price: (ext > 0.0).then_some(ext),
                }
            }
            _ => continue,
        };
        out.push(q);
    }
    out
}

/// Hong Kong quotes are served by Tencent with a `r_` prefix per code.
pub async fn tencent_hk_quotes(client: &Client, codes: &[String]) -> Vec<RawQuote> {
    if codes.is_empty() {
        return Vec::new();
    }
    // Tencent wants the `r_hk00700` form; accept plain `00700` too so callers
    // do not have to know the wire format.
    let list = codes
        .iter()
        .map(|c| {
            let lower = c.to_lowercase();
            if lower.starts_with("hk") {
                format!("r_{lower}")
            } else {
                format!("r_hk{lower}")
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let url = format!("https://qt.gtimg.cn/q={list}");
    let body = match client.get(&url).send().await {
        Ok(res) => match res.bytes().await {
            Ok(b) => decode_gb18030(&b),
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    parse_tencent_hk(&body)
}

pub fn parse_tencent_hk(body: &str) -> Vec<RawQuote> {
    let mut out = Vec::new();
    for line in body.split_inclusive(';') {
        let line = line.trim();
        let Some(start) = line.find("v_r_hk") else { continue };
        let Some(eq) = line[start..].find("=\"") else { continue };
        let id = line[start..start + eq].replace("v_r_", "").to_lowercase();
        let Some(open) = line.find("=\"") else { continue };
        let Some(close) = line.rfind('"') else { continue };
        if close <= open + 2 {
            continue;
        }
        let fields: Vec<&str> = line[open + 2..close].split('~').collect();
        if fields.len() < 31 {
            continue;
        }
        let Ok(price) = fields[3].parse::<f64>() else { continue };
        let Ok(prev) = fields[4].parse::<f64>() else { continue };
        if price <= 0.0 || prev <= 0.0 {
            continue;
        }
        out.push(RawQuote {
            id,
            name: fields[1].to_string(),
            price,
            prev_close: prev,
            time: fields[30].to_string(),
            market: Market::Hk,
            extended_price: None,
        });
    }
    out
}

/// Korean quotes come from Tencent, which exposes them as `kr<code>` with the
/// same `~`-separated layout as Hong Kong. Eastmoney used to cover them but its
/// batch endpoint has become unreliable.
pub async fn tencent_kr_quotes(client: &Client, codes: &[String]) -> Vec<RawQuote> {
    if codes.is_empty() {
        return Vec::new();
    }
    let list = codes
        .iter()
        .map(|c| {
            let bare = c.trim_start_matches("kr_").trim_start_matches("kr");
            format!("kr{bare}")
        })
        .collect::<Vec<_>>()
        .join(",");
    let url = format!("https://qt.gtimg.cn/q={list}");
    let body = match client
        .get(&url)
        .header("Referer", "https://gu.qq.com/")
        .send()
        .await
    {
        Ok(res) => match res.bytes().await {
            Ok(b) => decode_gb18030(&b),
            Err(_) => return Vec::new(),
        },
        Err(_) => return Vec::new(),
    };
    parse_tencent_kr(&body)
}

pub fn parse_tencent_kr(body: &str) -> Vec<RawQuote> {
    let mut out = Vec::new();
    for line in body.split_inclusive(';') {
        let line = line.trim();
        let Some(start) = line.find("v_kr") else { continue };
        let Some(eq) = line[start..].find("=\"") else { continue };
        let code = line[start + "v_kr".len()..start + eq].to_string();
        if code.is_empty() {
            continue;
        }
        let Some(open) = line.find("=\"") else { continue };
        let Some(close) = line.rfind('"') else { continue };
        if close <= open + 2 {
            continue;
        }
        let fields: Vec<&str> = line[open + 2..close].split('~').collect();
        if fields.len() < 31 {
            continue;
        }
        let Ok(price) = fields[3].parse::<f64>() else { continue };
        let Ok(prev) = fields[4].parse::<f64>() else { continue };
        if price <= 0.0 || prev <= 0.0 {
            continue;
        }
        out.push(RawQuote {
            id: format!("kr_{code}"),
            name: fields[1].to_string(),
            price,
            prev_close: prev,
            time: fields[30].to_string(),
            market: Market::Kr,
            extended_price: None,
        });
    }
    out
}

/// Eastmoney pushes a single batch endpoint for every market. It is also the
/// primary US source (Sina covers the regular session only).
/// Tencent's kline endpoint, used when Eastmoney's history host is unreachable.
/// Row layout is date, open, close, high, low, volume — note close before high.
pub async fn tencent_kline(
    client: &Client,
    id: &str,
    period: &str,
    limit: u32,
) -> Option<String> {
    // Callers may hand over a `usAAPL` symbol rather than a watchlist id.
    if let Some(ticker) = id.strip_prefix("us")
        && !ticker.is_empty()
    {
        let ticker = ticker.split('.').next().unwrap_or(ticker).to_string();
        return tencent_kline_us(client, &ticker, period, limit).await;
    }
    // US tickers need an exchange suffix on this endpoint; without it Tencent
    // returns a two-row stub. Try the common venues in turn.
    let symbol = if let Some(rest) = id.strip_prefix("usr_") {
        let ticker = rest.replace('_', ".").to_uppercase();
        return tencent_kline_us(client, &ticker, period, limit).await;
    } else if let Some(rest) = id.strip_prefix("kr_") {
        format!("kr{rest}")
    } else {
        id.to_string()
    };
    let url = format!(
        "https://ifzq.gtimg.cn/appstock/app/kline/kline?param={symbol},{period},,,{limit}"
    );
    client
        .get(&url)
        .header("Referer", "https://gu.qq.com/")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()
}

/// US tickers live under `<ticker>.<venue>` on Tencent. The right one is not
/// knowable up front, so ask for the venues in order until the payload has a
/// plausible number of rows.
async fn tencent_kline_us(
    client: &Client,
    ticker: &str,
    period: &str,
    limit: u32,
) -> Option<String> {
    for suffix in ["OQ", "N", "P", ""] {
        let symbol = if suffix.is_empty() {
            format!("us{ticker}")
        } else {
            format!("us{ticker}.{suffix}")
        };
        let url = format!(
            "https://ifzq.gtimg.cn/appstock/app/kline/kline?param={symbol},{period},,,{limit}"
        );
        let Ok(res) = client
            .get(&url)
            .header("Referer", "https://gu.qq.com/")
            .send()
            .await
        else {
            continue;
        };
        let Ok(text) = res.text().await else { continue };
        // A stub (<= 2 rows) means the venue is wrong.
        let rows = text.matches(r#""20"#).count();
        if rows > 3 {
            return Some(text);
        }
    }
    None
}

/// Eastmoney fronts its quote API with several hosts and any of them can return
/// an empty reply for a few seconds. Retrying across hosts keeps Korea (which
/// has no other free batch feed) from dropping out of the list.
const EASTMONEY_HOSTS: [&str; 3] = [
    // The numbered edge host has been the reliable one; the bare domain often
    // answers with an empty body during peak hours.
    "82.push2.eastmoney.com",
    "push2.eastmoney.com",
    "push2delay.eastmoney.com",
];

pub async fn eastmoney_get(client: &Client, path_and_query: &str) -> Option<String> {
    for attempt in 0..2 {
        for host in EASTMONEY_HOSTS {
            let url = format!("https://{host}{path_and_query}");
            let Ok(res) = client
                .get(&url)
                .header("Referer", "https://quote.eastmoney.com/")
                .send()
                .await
            else {
                continue;
            };
            let Ok(text) = res.text().await else { continue };
            // An empty body or a rate-limit page is not a usable answer.
            if text.trim().is_empty() || !text.contains("rc") {
                continue;
            }
            return Some(text);
        }
        if attempt == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    None
}

pub async fn eastmoney_quotes(client: &Client, stocks: &[(String, String, Market)]) -> Vec<RawQuote> {
    if stocks.is_empty() {
        return Vec::new();
    }
    let secids = stocks
        .iter()
        .map(|(_, secid, _)| secid.clone())
        .collect::<Vec<_>>()
        .join(",");
    let path = format!(
        "/api/qt/ulist.np/get?fltt=2&secids={secids}&fields=f2,f3,f4,f12,f13,f14,f15,f16,f17,f18"
    );
    let Some(body) = eastmoney_get(client, &path).await else {
        return Vec::new();
    };
    parse_eastmoney_quotes(&body, stocks)
}

pub fn parse_eastmoney_quotes(
    body: &str,
    stocks: &[(String, String, Market)],
) -> Vec<RawQuote> {
    #[derive(serde::Deserialize)]
    struct Root {
        data: Option<Data>,
    }
    #[derive(serde::Deserialize)]
    struct Data {
        diff: Option<Vec<Row>>,
    }
    #[derive(serde::Deserialize)]
    struct Row {
        f2: Option<f64>,
        f12: Option<String>,
        f13: Option<i64>,
        f14: Option<String>,
        f18: Option<f64>,
    }

    let Ok(root) = serde_json::from_str::<Root>(body) else {
        return Vec::new();
    };
    let Some(rows) = root.data.and_then(|d| d.diff) else {
        return Vec::new();
    };
    // Index the requested secids so each response row maps back to our id.
    let mut lookup: std::collections::HashMap<(String, String), (&String, Market)> =
        std::collections::HashMap::new();
    for (id, secid, market) in stocks {
        if let Some((mid, rest)) = secid.split_once('.') {
            lookup.insert((mid.to_string(), rest.to_uppercase()), (id, *market));
        }
    }

    let mut out = Vec::new();
    for row in rows {
        let (Some(code), Some(market_id), Some(price)) = (row.f12, row.f13, row.f2) else {
            continue;
        };
        if price <= 0.0 {
            continue;
        }
        let Some((id, market)) = lookup
            .get(&(market_id.to_string(), code.to_uppercase()))
            .copied()
            .or_else(|| {
                lookup
                    .iter()
                    .find(|((_, rest), _)| rest.eq_ignore_ascii_case(&code))
                    .map(|(_, v)| *v)
            })
        else {
            continue;
        };
        let prev = row.f18.unwrap_or(0.0);
        out.push(RawQuote {
            id: id.clone(),
            name: row.f14.unwrap_or_default(),
            price,
            prev_close: if prev > 0.0 { prev } else { price },
            time: String::new(),
            market,
            extended_price: None,
        });
    }
    out
}

/// Quotes for an arbitrary set of stocks: one request per market, merged in the
/// order A, US, HK, KR, then the Eastmoney fallback for anything carrying a
/// `secid`. The GUI's preview and the CLI's `market.quotes` both land in the
/// same parsers, so the two can never disagree about a price.
pub async fn quotes(client: &Client, stocks: &[crate::model::Stock]) -> Vec<RawQuote> {
    let a_ids: Vec<String> = stocks
        .iter()
        .filter(|s| s.market == Market::A)
        .map(|s| s.id.clone())
        .collect();
    let us_ids: Vec<String> = stocks
        .iter()
        .filter(|s| s.market == Market::Us)
        .map(|s| s.id.clone())
        .collect();
    let hk_codes: Vec<String> = stocks
        .iter()
        .filter(|s| s.market == Market::Hk)
        .map(|s| s.code.clone())
        .collect();
    let kr_codes: Vec<String> = stocks
        .iter()
        .filter(|s| s.market == Market::Kr)
        .map(|s| s.code.clone())
        .collect();
    let em_targets: Vec<(String, String, Market)> = stocks
        .iter()
        .filter_map(|s| s.secid().map(|secid| (s.id.clone(), secid, s.market)))
        .collect();
    let (sina_a, sina_us, hk, kr, em) = futures::join!(
        sina_quotes(client, &a_ids, Market::A),
        sina_quotes(client, &us_ids, Market::Us),
        tencent_hk_quotes(client, &hk_codes),
        tencent_kr_quotes(client, &kr_codes),
        eastmoney_quotes(client, &em_targets),
    );
    let mut out: Vec<RawQuote> = Vec::new();
    for raw in sina_a
        .into_iter()
        .chain(sina_us)
        .chain(hk)
        .chain(kr)
        .chain(em)
    {
        // The first feed with a real price wins; Eastmoney is the fallback.
        if let Some(existing) = out.iter_mut().find(|q| q.id == raw.id) {
            if existing.price <= 0.0 && raw.price > 0.0 {
                *existing = raw;
            }
            continue;
        }
        out.push(raw);
    }
    out
}

/// Sina FX pairs: USD/CNY, USD/HKD, USD/KRW.
pub async fn sina_rates(client: &Client) -> Option<crate::model::Rates> {
    let url = "https://hq.sinajs.cn/list=fx_susdcny,fx_susdhkd,fx_susdkrw";
    let body = client
        .get(url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .ok()?
        .bytes()
        .await
        .ok()?;
    parse_rates(&decode_gb18030(&body))
}

pub fn parse_rates(body: &str) -> Option<crate::model::Rates> {
    let mut rates = crate::model::Rates::default();
    let mut found = 0;
    for line in body.split_inclusive(';') {
        let pairs = [
            ("fx_susdcny", 0),
            ("fx_susdhkd", 1),
            ("fx_susdkrw", 2),
        ];
        let Some(open) = line.find("=\"") else { continue };
        let Some(close) = line.rfind('"') else { continue };
        if close <= open + 2 {
            continue;
        }
        let payload = &line[open + 2..close];
        // The rate is the first positive float in the payload.
        let value = payload
            .split(',')
            .filter_map(|p| p.trim().parse::<f64>().ok())
            .find(|v| *v > 0.0);
        let Some(value) = value else { continue };
        for (key, idx) in pairs {
            if line.contains(key) {
                match idx {
                    0 => rates.usd_cny = value,
                    1 => rates.usd_hkd = value,
                    _ => rates.usd_krw = value,
                }
                found += 1;
            }
        }
    }
    (found > 0).then_some(rates)
}

/// Symbol search. Tencent covers A-shares and Hong Kong; Eastmoney covers US
/// tickers and Korean listings that Tencent does not know about.
pub async fn tencent_search(client: &Client, keyword: &str) -> Vec<crate::model::SearchResult> {
    let url = format!(
        "https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?q={}&app=stock",
        urlencoding::encode(keyword)
    );
    let Ok(res) = client.get(&url).send().await else {
        return Vec::new();
    };
    let Ok(body) = res.text().await else {
        return Vec::new();
    };
    parse_tencent_search(&body)
}

pub fn parse_tencent_search(body: &str) -> Vec<crate::model::SearchResult> {
    #[derive(serde::Deserialize)]
    struct Root {
        data: Option<Data>,
    }
    #[derive(serde::Deserialize)]
    struct Data {
        stock: Option<Vec<Vec<String>>>,
    }

    let Ok(root) = serde_json::from_str::<Root>(body) else {
        return Vec::new();
    };
    let Some(rows) = root.data.and_then(|d| d.stock) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        if row.len() < 3 {
            continue;
        }
        let (exchange, code, name) = (&row[0], &row[1], &row[2]);
        // Tencent tags derivatives in the last column: GP/GP-A are ordinary
        // shares, QZ/QZ-NX are callable bull/bear contracts (warrants) and CBBC.
        // Those trade at fractions of a cent and would flood every HK search,
        // so they never reach the add list.
        if matches!(row.get(4).map(String::as_str), Some("QZ" | "QZ-NX" | "QZ-L")) {
            continue;
        }
        let (market, id) = match exchange.as_str() {
            "sh" | "sz" | "bj" => (
                Market::A,
                format!("{}{}", exchange, code),
            ),
            "hk" => {
                // HK equities are 5 digits; shorter codes are indices, longer
                // ones are structured products.
                if code.len() != 5 {
                    continue;
                }
                (Market::Hk, format!("hk{code}"))
            }
            "us" => {
                let ticker = code.split('.').next().unwrap_or(code);
                // Preferred shares / ADR duplicates end in .PS and are not tradable here.
                if ticker.is_empty() || ticker.len() > 6 || code.ends_with(".PS") {
                    continue;
                }
                (Market::Us, format!("usr_{}", ticker.to_lowercase()))
            }
            _ => continue,
        };
        out.push(crate::model::SearchResult {
            id,
            code: code.clone(),
            name: name.clone(),
            market,
            secid: String::new(),
        });
    }
    out
}

/// Eastmoney symbol lookup covers all four markets and returns a stable secid.
pub async fn eastmoney_search(client: &Client, keyword: &str) -> Vec<crate::model::SearchResult> {
    let url = format!(
        "https://searchapi.eastmoney.com/api/suggest/get?input={}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8",
        urlencoding::encode(keyword)
    );
    let Ok(res) = client
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = res.text().await else {
        return Vec::new();
    };
    parse_eastmoney_search(&body)
}

/// Every feed at once, merged the way the search box shows it: Eastmoney first
/// because it carries a `secid`, then Tencent, with exact ticker/name matches
/// bubbled to the top. Shared by the GUI search and `stockpot cli stocks.search`
/// so an agent sees exactly the list the app would show.
pub async fn search(client: &Client, keyword: &str) -> Vec<crate::model::SearchResult> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Vec::new();
    }
    let (tencent, eastmoney) = futures::join!(
        tencent_search(client, keyword),
        eastmoney_search(client, keyword)
    );
    let mut merged: Vec<crate::model::SearchResult> = Vec::new();
    for result in eastmoney.into_iter().chain(tencent.into_iter()) {
        if let Some(existing) = merged.iter_mut().find(|r| r.id == result.id) {
            if existing.secid.is_empty() && !result.secid.is_empty() {
                existing.secid = result.secid;
            }
            if existing.name.is_empty() {
                existing.name = result.name;
            }
            continue;
        }
        merged.push(result);
    }
    let needle = keyword.to_uppercase();
    merged.sort_by_key(|r| {
        let exact = r.code.eq_ignore_ascii_case(&needle) || r.name == keyword;
        !exact
    });
    merged.truncate(24);
    merged
}

pub fn parse_eastmoney_search(body: &str) -> Vec<crate::model::SearchResult> {
    #[derive(serde::Deserialize)]
    struct Root {
        #[serde(rename = "QuotationCodeTable")]
        table: Option<Table>,
    }
    #[derive(serde::Deserialize)]
    struct Table {
        #[serde(rename = "Data")]
        data: Option<Vec<Row>>,
    }
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(rename = "Code")]
        code: Option<String>,
        #[serde(rename = "Name")]
        name: Option<String>,
        #[serde(rename = "QuoteID")]
        quote_id: Option<String>,
        #[serde(rename = "Classify")]
        classify: Option<String>,
        #[serde(rename = "SecurityTypeName")]
        kind: Option<String>,
    }

    let Ok(root) = serde_json::from_str::<Root>(body) else {
        return Vec::new();
    };
    let Some(rows) = root.table.and_then(|t| t.data) else {
        return Vec::new();
    };
    let mut out: Vec<crate::model::SearchResult> = Vec::new();
    for row in rows {
        let (Some(code), Some(name), Some(quote_id)) = (row.code, row.name, row.quote_id) else {
            continue;
        };
        let classify = row.classify.unwrap_or_default();
        let kind = row.kind.unwrap_or_default();
        // Only equities and ETFs; ignore bonds, indices, warrants.
        let is_fund = kind.contains("基金");
        let market = match classify.as_str() {
            "AStock" | "NEEQ" => Market::A,
            "HK" => Market::Hk,
            "UsStock" => Market::Us,
            "KRX" => Market::Kr,
            _ if is_fund => Market::A,
            _ => continue,
        };
        if market == Market::Hk && code.len() != 5 {
            continue;
        }
        if market == Market::Us
            && !matches!(quote_id.split('.').next(), Some("105" | "106" | "107"))
        {
            continue;
        }
        let id = match market {
            Market::A => {
                let prefix = quote_id.split('.').next().unwrap_or("0");
                let exchange = match prefix {
                    "1" => "sh",
                    "0" if code.starts_with('9') || code.starts_with('4') || code.starts_with('8') => "bj",
                    "0" => "sz",
                    _ => "sh",
                };
                format!("{exchange}{code}")
            }
            Market::Hk => format!("hk{code}"),
            Market::Us => format!("usr_{}", code.to_lowercase().replace('.', "_")),
            Market::Kr => format!("kr_{code}"),
        };
        let display_code = match market {
            Market::Us => code.clone(),
            _ => code.clone(),
        };
        out.push(crate::model::SearchResult {
            id,
            code: display_code,
            name,
            market,
            secid: quote_id,
        });
    }
    out
}

/// Intraday minute bars from Tencent, used for A-share, HK and Korean charts.
pub struct MinuteSeries {
    pub points: Vec<(i32, f64, String)>,
    pub prev_close: f64,
}

pub async fn tencent_intraday(
    client: &Client,
    id: &str,
    market: Market,
) -> Option<MinuteSeries> {
    let url = format!(
        "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={}",
        urlencoding::encode(id)
    );
    let body = client
        .get(&url)
        .header("Referer", "https://gu.qq.com/")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    parse_tencent_intraday(&body, id, market)
}

pub fn parse_tencent_intraday(body: &str, id: &str, market: Market) -> Option<MinuteSeries> {
    let json = body.split_once('=').map(|(_, rest)| rest).unwrap_or(body);
    let json = json.trim().trim_end_matches(';');
    let root: serde_json::Value = serde_json::from_str(json).ok()?;
    let node = root.get("data")?.get(id)?;
    let inner = node.get("data")?;
    let lines = inner.get("data")?.as_array()?;
    // The minute feed does not carry `preclose` under `data`; the quote block
    // does, at index 4 (`[market, name, code, price, prevClose, open, ...]`).
    let prev_close = inner
        .get("preclose")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v > 0.0)
        .or_else(|| {
            let qt = node.get("qt")?.get(id)?.as_array()?;
            qt.get(4)?.as_str()?.parse::<f64>().ok()
        })
        .unwrap_or(0.0);
    let mut points = Vec::new();
    for line in lines.iter() {
        let Some(text) = line.as_str() else { continue };
        let mut parts = text.split_whitespace();
        let Some(time) = parts.next() else { continue };
        let Some(price) = parts.next().and_then(|p| p.parse::<f64>().ok()) else {
            continue;
        };
        if price <= 0.0 {
            continue;
        }
        // Row numbers are not an axis: the closing auction adds a row after
        // 16:00 that would land past the last column. Map the wall clock
        // instead, which also keeps a missing minute from shifting the series.
        let Some(index) = crate::market::axis_index_for_time(market, time) else {
            continue;
        };
        let label = if time.len() == 4 {
            format!("{}:{}", &time[..2], &time[2..])
        } else {
            time.to_string()
        };
        // Later prints for the same column (the closing auction) win.
        points.retain(|(i, _, _)| *i != index);
        points.push((index, price, label));
    }
    if points.is_empty() {
        return None;
    }
    Some(MinuteSeries { points, prev_close })
}

/// Eastmoney minute trends cover US extended hours and Korean sessions, which
/// Tencent does not expose in a usable form.
pub async fn eastmoney_intraday(
    client: &Client,
    secid: &str,
    market: Market,
) -> Option<MinuteSeries> {
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid={secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0"
    );
    let path = url.split("eastmoney.com").nth(1).unwrap_or_default();
    let body = eastmoney_get(client, path).await?;
    parse_eastmoney_intraday(&body, market)
}

pub fn parse_eastmoney_intraday(body: &str, market: Market) -> Option<MinuteSeries> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    let data = root.get("data")?;
    let prev_close = data
        .get("preClose")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let trends = data.get("trends")?.as_array()?;
    let mut points = Vec::new();
    for row in trends {
        let Some(text) = row.as_str() else { continue };
        let parts: Vec<&str> = text.split(',').collect();
        if parts.len() < 2 {
            continue;
        }
        let Some(price) = parts[1].parse::<f64>().ok() else { continue };
        if price <= 0.0 {
            continue;
        }
        let stamp = parts[0];
        let Some((date, time)) = stamp.split_once(' ') else { continue };
        let Some(idx) = eastmoney_axis_index(market, date, time) else {
            continue;
        };
        points.push((idx, price, time.to_string()));
    }
    if points.is_empty() {
        return None;
    }
    Some(MinuteSeries { points, prev_close })
}

/// Eastmoney stamps US pre/post bars on dates that shift with the ET calendar,
/// so parse the wall clock and feed it through the shared axis helper.
fn eastmoney_axis_index(market: Market, date: &str, time: &str) -> Option<i32> {
    use chrono::{NaiveDateTime, TimeZone, Timelike};
    let dt = NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y-%m-%d %H:%M").ok()?;
    match market {
        Market::A | Market::Hk => {
            let t = chrono_tz::Asia::Shanghai.from_local_datetime(&dt).single()?;
            crate::market::axis_index(market, t)
        }
        Market::Kr => {
            // Korean bars carry the exchange's pre-open ramp starting 08:00.
            let t = chrono_tz::Asia::Seoul.from_local_datetime(&dt).single()?;
            let minutes = t.hour() as i32 * 60 + t.minute() as i32;
            let idx = minutes - 8 * 60;
            (0..=420).contains(&idx).then_some(idx)
        }
        Market::Us => {
            let t = chrono_tz::America::New_York.from_local_datetime(&dt).single()?;
            crate::market::axis_index(market, t)
        }
    }
}

pub fn symbol_for_us(id: &str) -> String {
    id.trim_start_matches("usr_")
        .replace('_', ".")
        .to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sina_a_share_line() {
        let body = "var hq_str_sh600000=\"浦发银行,10.060,10.100,10.150,10.180,10.000,10.150,10.160,21978635,222109276.000,51700,10.150,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-11-10,11:13:18,00,\";\n";
        let quotes = parse_sina(body, Market::A);
        assert_eq!(quotes.len(), 1);
        let q = &quotes[0];
        assert_eq!(q.id, "sh600000");
        assert_eq!(q.name, "浦发银行");
        assert!((q.price - 10.150).abs() < 1e-9);
        assert!((q.prev_close - 10.100).abs() < 1e-9);
        assert_eq!(q.time, "2026-11-10 11:13:18");
    }

    #[test]
    fn parses_sina_us_line_with_extended_price() {
        let body = "var hq_str_usr_aapl=\"苹果,350.6900,2.43,2026-11-10 09:30:10,8.3200,344.9950,352.3300,344.7800,355.3800,242.8900,48753031,56680400,5096317836117,8.30,42.250000,0.00,0.68,0.00,0.00,14532258793,63,350.5000,-0.05,-0.19,Nov 09 07:59PM EST,Nov 09 04:00PM EST,342.3700,8566944,1,2026,17077778235.0000,352.0200,330.3559,3004259468.4064,350.5000,342.3700\";";
        let quotes = parse_sina(body, Market::Us);
        assert_eq!(quotes.len(), 1);
        let q = &quotes[0];
        assert_eq!(q.id, "usr_aapl");
        assert!((q.prev_close - 342.37).abs() < 1e-9);
        assert!((q.price - 350.69).abs() < 1e-9);
        assert_eq!(q.extended_price, Some(350.5));
    }

    #[test]
    fn parses_tencent_hk_line() {
        let body = "v_r_hk00700=\"100~腾讯控股~00700~418.000~418.400~423.000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026/11/10 11:13:18~-0.400~-0.10~424.400~415.400~418.000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~TENCENT~0\";";
        let quotes = parse_tencent_hk(body);
        assert_eq!(quotes.len(), 1);
        assert_eq!(quotes[0].id, "hk00700");
        assert_eq!(quotes[0].name, "腾讯控股");
        assert!((quotes[0].price - 418.0).abs() < 1e-9);
        assert!((quotes[0].prev_close - 418.4).abs() < 1e-9);
    }

    #[test]
    fn parses_sina_rates() {
        let body = concat!(
            "var hq_str_fx_susdcny=\"11:14:02,6.6708000000,6.6709000000,6.6724000000,13.0000000000,6.6711000000\";\n",
            "var hq_str_fx_susdhkd=\"11:14:24,7.842800,7.842900,7.841800,22,7.841600\";\n",
            "var hq_str_fx_susdkrw=\"11:14:21,1347.37,1347.55,1340.200000,7.56e+04,1340.810000\";\n"
        );
        let rates = parse_rates(body).expect("rates");
        assert!((rates.usd_cny - 6.6708).abs() < 1e-9);
        assert!((rates.usd_hkd - 7.8428).abs() < 1e-9);
        assert!((rates.usd_krw - 1347.37).abs() < 1e-9);
    }

    #[test]
    fn parses_tencent_search_payload() {
        let body = r#"{"code":0,"msg":"","data":{"stock":[["hk","00700","腾讯控股","","GP"],["sh","600000","浦发银行","","GP-A"],["us","AAPL.OQ","苹果","","GP"]]}}"#;
        let results = parse_tencent_search(body);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].id, "hk00700");
        assert_eq!(results[1].id, "sh600000");
        assert_eq!(results[2].id, "usr_aapl");
        assert_eq!(results[2].market, Market::Us);
    }

    #[test]
    fn parses_eastmoney_search_payload() {
        let body = r#"{"QuotationCodeTable":{"Data":[
            {"Code":"AAPL","Name":"苹果","QuoteID":"105.AAPL","Classify":"UsStock","SecurityTypeName":"美股"},
            {"Code":"005930","Name":"三星电子","QuoteID":"177.005930","Classify":"KRX","SecurityTypeName":"韩股"},
            {"Code":"00700","Name":"腾讯控股","QuoteID":"116.00700","Classify":"HK","SecurityTypeName":"港股"},
            {"Code":"600000","Name":"浦发银行","QuoteID":"1.600000","Classify":"AStock","SecurityTypeName":"沪A"},
            {"Code":"110059","Name":"浦发转债","QuoteID":"1.110059","Classify":"Bond","SecurityTypeName":"沪可转债"}
        ],"Status":0}}"#;
        let results = parse_eastmoney_search(body);
        assert_eq!(results.len(), 4);
        assert_eq!(results[0].market, Market::Us);
        assert_eq!(results[0].secid, "105.AAPL");
        assert_eq!(results[1].id, "kr_005930");
        assert_eq!(results[2].id, "hk00700");
        assert_eq!(results[3].id, "sh600000");
    }

    #[test]
    fn parses_tencent_intraday_payload() {
        let body = r#"min_data_sh600000={"code":0,"data":{"sh600000":{"data":{"data":["0930 10.06 4753 4781518.00","0931 10.02 22045 22107940.00"],"preclose":"10.10"}}}};"#;
        let series = parse_tencent_intraday(body, "sh600000", Market::A).unwrap();
        assert_eq!(series.points.len(), 2);
        assert_eq!(series.points[0], (0, 10.06, "09:30".to_string()));
        assert!((series.prev_close - 10.10).abs() < 1e-9);
    }

    #[test]
    fn parses_eastmoney_us_intraday_and_maps_axis() {
        let body = r#"{"data":{"preClose":342.37,"trends":["2026-11-09 04:00,345.10","2026-11-09 09:30,350.00","2026-11-09 19:59,351.00"]}}"#;
        let series = parse_eastmoney_intraday(body, Market::Us).unwrap();
        // 04:00 ET maps to index 0, 09:30 to 330 and 19:59 to 959.
        assert_eq!(series.points[0].0, 0);
        assert_eq!(series.points[1].0, 330);
        assert_eq!(series.points[2].0, 959);
        assert!((series.prev_close - 342.37).abs() < 1e-9);
    }

    #[test]
    fn us_symbol_normalisation() {
        assert_eq!(symbol_for_us("usr_aapl"), "AAPL");
        assert_eq!(symbol_for_us("usr_brk_b"), "BRK.B");
    }
}

/// Robinhood's public marketdata endpoint is the only free feed that publishes
/// overnight (24/5) prints. Only prices printed after the current overnight
/// tape began are accepted, otherwise a stale after-hours print would look
/// like a live price.
pub async fn robinhood_overnight(
    client: &Client,
    ids: &[String],
) -> std::collections::HashMap<String, f64> {
    use std::collections::HashMap;
    let out = HashMap::new();
    if ids.is_empty() {
        return out;
    }
    let symbols = ids
        .iter()
        .map(|id| symbol_for_us(id))
        .collect::<Vec<_>>()
        .join(",");
    let url = format!(
        "https://api.robinhood.com/marketdata/quotes/?symbols={symbols}&bounds=24_5"
    );
    let Ok(res) = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
    else {
        return out;
    };
    let Ok(text) = res.text().await else { return out };
    parse_robinhood(&text, ids, crate::market::us_night_start(chrono::Utc::now()))
}

pub fn parse_robinhood(
    body: &str,
    ids: &[String],
    session_start: chrono::DateTime<chrono::Utc>,
) -> std::collections::HashMap<String, f64> {
    use std::collections::HashMap;
    #[derive(serde::Deserialize)]
    struct Root {
        results: Option<Vec<Option<Row>>>,
    }
    #[derive(serde::Deserialize)]
    struct Row {
        symbol: Option<String>,
        last_non_reg_trade_price: Option<String>,
        venue_last_non_reg_trade_time: Option<String>,
    }
    let Ok(root) = serde_json::from_str::<Root>(body) else {
        return HashMap::new();
    };
    let by_symbol: HashMap<String, &String> =
        ids.iter().map(|id| (symbol_for_us(id), id)).collect();
    let mut out = HashMap::new();
    for row in root.results.unwrap_or_default().into_iter().flatten() {
        let (Some(symbol), Some(price)) = (row.symbol, row.last_non_reg_trade_price) else {
            continue;
        };
        let Ok(price) = price.parse::<f64>() else { continue };
        if price <= 0.0 {
            continue;
        }
        let Some(stamp) = row.venue_last_non_reg_trade_time else {
            continue;
        };
        let Some(ts) = parse_rfc3339_loose(&stamp) else { continue };
        if ts < session_start {
            continue;
        }
        if let Some(id) = by_symbol.get(&symbol.to_uppercase()) {
            out.insert((*id).clone(), price);
        }
    }
    out
}

fn parse_rfc3339_loose(stamp: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::{DateTime, Utc};
    // Timestamps carry a variable number of fractional digits.
    let cleaned: String = match stamp.find('.') {
        Some(dot) => {
            let rest = &stamp[dot + 1..];
            let end = rest
                .find(|c: char| !c.is_ascii_digit())
                .map(|i| dot + 1 + i)
                .unwrap_or(stamp.len());
            format!("{}{}", &stamp[..dot], &stamp[end..])
        }
        None => stamp.to_string(),
    };
    let trimmed = cleaned.trim_end_matches('Z');
    DateTime::parse_from_rfc3339(&format!("{trimmed}Z"))
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

#[cfg(test)]
mod robinhood_tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn ignores_prints_before_the_overnight_open() {
        let body = r#"{"results":[
            {"symbol":"AAPL","last_non_reg_trade_price":"360.00","venue_last_non_reg_trade_time":"2026-11-10T02:14:30.773Z"},
            {"symbol":"TSLA","last_non_reg_trade_price":"420.00","venue_last_non_reg_trade_time":"2026-11-09T18:00:00.000000000Z"},
            null
        ]}"#;
        let start = Utc.with_ymd_and_hms(2026, 11, 10, 1, 0, 0).unwrap();
        let ids = vec!["usr_aapl".to_string(), "usr_tsla".to_string()];
        let prices = parse_robinhood(body, &ids, start);
        assert_eq!(prices.get("usr_aapl"), Some(&360.0));
        assert!(!prices.contains_key("usr_tsla"));
    }

    #[test]
    fn normalises_class_share_symbols() {
        let body = r#"{"results":[
            {"symbol":"BRK.B","last_non_reg_trade_price":"575.10","venue_last_non_reg_trade_time":"2026-11-10T02:00:00Z"}
        ]}"#;
        let ids = vec!["usr_brk_b".to_string()];
        let prices = parse_robinhood(body, &ids, Utc.with_ymd_and_hms(2026, 11, 10, 0, 0, 0).unwrap());
        // Robinhood reports dots while our ids use underscores; the symbol
        // normaliser maps both to the dotted form.
        assert_eq!(prices.get("usr_brk_b"), Some(&575.10));
    }
}

#[cfg(test)]
mod search_filter_tests {
    use super::*;

    #[test]
    fn drops_hong_kong_warrants_and_cbbc() {
        let body = r#"{"data":{"stock":[
            ["sh","601860","紫金银行","","GP-A"],
            ["hk","02899","紫金矿业","","GP"],
            ["hk","68628","紫金摩通七一牛F","","QZ-NX"],
            ["hk","60052","紫金瑞银八乙熊S","","QZ-NX"],
            ["hk","57533","紫金瑞银六甲牛B","","QZ"]
        ]}}"#;
        let results = parse_tencent_search(body);
        let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["sh601860", "hk02899"]);
    }

    #[test]
    fn keeps_ordinary_shares_across_markets() {
        let body = r#"{"data":{"stock":[
            ["us","AAPL.OQ","苹果","","GP"],
            ["hk","00700","腾讯控股","","GP"],
            ["bj","920047","诺思兰德","","GP"]
        ]}}"#;
        let results = parse_tencent_search(body);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].id, "usr_aapl");
    }
}

#[cfg(test)]
mod kr_tests {
    use super::*;

    #[test]
    fn parses_tencent_korean_quote() {
        let body = "v_kr005930=\"352~Samsung Electronics Co., Ltd.~005930.KS~198900~189900~199400~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026-11-10 14:30:19~\";";
        let quotes = parse_tencent_kr(body);
        assert_eq!(quotes.len(), 1);
        let q = &quotes[0];
        assert_eq!(q.id, "kr_005930");
        assert!((q.price - 198_900.0).abs() < 1e-6);
        assert!((q.prev_close - 189_900.0).abs() < 1e-6);
        assert_eq!(q.market, Market::Kr);
    }

    #[test]
    fn ignores_unmatched_korean_codes() {
        assert!(parse_tencent_kr("v_pv_none_match=\"1\";").is_empty());
    }
}

#[cfg(test)]
mod intraday_prev_close_tests {
    use super::*;

    #[test]
    fn reads_prev_close_from_the_quote_block() {
        // The minute endpoint omits `preclose` and exposes it in `qt[4]` instead.
        let body = r#"min_data_sh601899={"code":0,"data":{"sh601899":{
            "data":{"data":["0930 28.73 100 1000.00","0931 28.70 120 1200.00"],"date":"20261110"},
            "qt":{"sh601899":["1","紫金矿业","601899","28.18","28.41","28.73","0"]}
        }}};"#;
        let series = parse_tencent_intraday(body, "sh601899", Market::A).unwrap();
        assert!((series.prev_close - 28.41).abs() < 1e-9);
        assert_eq!(series.points.len(), 2);
    }

    #[test]
    fn falls_back_to_zero_without_a_quote_block() {
        let body = r#"{"data":{"sh601899":{"data":{"data":["0930 28.73 1 1"]}}}}"#;
        let series = parse_tencent_intraday(body, "sh601899", Market::A).unwrap();
        assert_eq!(series.prev_close, 0.0);
    }
}
