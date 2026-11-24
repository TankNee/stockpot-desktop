use crate::model::Market;
use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::{Asia::Shanghai, Asia::Seoul, America::New_York, Tz};

/// Trading session helpers. All calculations take an explicit instant so the
/// behaviour is testable and so the frontend never has to duplicate rules.
///
/// Session ids are stable strings the UI translates:
///   a/pre/open/lunch/close/holiday
pub const SESSION_CLOSED: &str = "closed";
pub const SESSION_PRE: &str = "pre";
pub const SESSION_OPEN: &str = "open";
pub const SESSION_LUNCH: &str = "lunch";
pub const SESSION_POST: &str = "post";
pub const SESSION_NIGHT: &str = "night";
pub const SESSION_WEEKEND: &str = "weekend";

fn is_weekend(date: &DateTime<Tz>) -> bool {
    matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

fn minutes(dt: &DateTime<Tz>) -> i32 {
    dt.hour() as i32 * 60 + dt.minute() as i32
}

/// Current session for a market. The returned value is one of the SESSION_*
/// constants. A-share/HK/KR do not model public holidays (the quote feed
/// simply stops moving), but the US helper does respect the daily pattern.
pub fn session(market: Market, at: DateTime<Utc>) -> &'static str {
    match market {
        Market::A => cn_session(at),
        Market::Hk => hk_session(at),
        Market::Us => us_session(at),
        Market::Kr => kr_session(at),
    }
}

fn cn_session(at: DateTime<Utc>) -> &'static str {
    let t = at.with_timezone(&Shanghai);
    if is_weekend(&t) {
        return SESSION_WEEKEND;
    }
    let m = minutes(&t);
    if (9 * 60 + 15..=9 * 60 + 30).contains(&m) {
        return "pre"; // call auction
    }
    if (9 * 60 + 30..=11 * 60 + 30).contains(&m) || (13 * 60..=15 * 60).contains(&m) {
        return SESSION_OPEN;
    }
    if (11 * 60 + 30..13 * 60).contains(&m) {
        return SESSION_LUNCH;
    }
    SESSION_CLOSED
}

fn hk_session(at: DateTime<Utc>) -> &'static str {
    let t = at.with_timezone(&Shanghai);
    if is_weekend(&t) {
        return SESSION_WEEKEND;
    }
    let m = minutes(&t);
    if (9 * 60..9 * 60 + 30).contains(&m) {
        return SESSION_PRE;
    }
    if (9 * 60 + 30..=12 * 60).contains(&m) || (13 * 60..=16 * 60).contains(&m) {
        return SESSION_OPEN;
    }
    if (12 * 60..13 * 60).contains(&m) {
        return SESSION_LUNCH;
    }
    SESSION_CLOSED
}

fn us_session(at: DateTime<Utc>) -> &'static str {
    let t = at.with_timezone(&New_York);
    let m = minutes(&t);
    let wd = t.weekday();

    // Overnight (Blue Ocean ATS) runs Sunday–Thursday 20:00–04:00 ET.
    if (20 * 60..24 * 60).contains(&m) {
        return match wd {
            Weekday::Sun | Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu => SESSION_NIGHT,
            _ => SESSION_CLOSED,
        };
    }
    if m < 4 * 60 {
        return match wd {
            // The night tape started the previous evening.
            Weekday::Mon | Weekday::Tue | Weekday::Wed | Weekday::Thu | Weekday::Fri => SESSION_NIGHT,
            _ => SESSION_CLOSED,
        };
    }
    if wd == Weekday::Sat || wd == Weekday::Sun {
        return SESSION_WEEKEND;
    }
    if (4 * 60..9 * 60 + 30).contains(&m) {
        return SESSION_PRE;
    }
    if (9 * 60 + 30..16 * 60).contains(&m) {
        return SESSION_OPEN;
    }
    if (16 * 60..20 * 60).contains(&m) {
        return SESSION_POST;
    }
    SESSION_CLOSED
}

fn kr_session(at: DateTime<Utc>) -> &'static str {
    let t = at.with_timezone(&Seoul);
    if is_weekend(&t) {
        return SESSION_WEEKEND;
    }
    let m = minutes(&t);
    if (8 * 60 + 30..9 * 60).contains(&m) {
        return SESSION_PRE;
    }
    if (9 * 60..=15 * 60 + 30).contains(&m) {
        return SESSION_OPEN;
    }
    SESSION_CLOSED
}

/// True when any of the user's markets may produce fresh ticks. Used to skip
/// polling overnight; manual refresh always overrides this.
pub fn any_market_open(at: DateTime<Utc>) -> bool {
    Market::all().iter().any(|m| {
        matches!(session(*m, at), SESSION_OPEN | SESSION_PRE | SESSION_NIGHT | SESSION_LUNCH)
    })
}

/// Stock-price timezone for a market, used to render quote timestamps.
pub fn market_tz(market: Market) -> Tz {
    match market {
        Market::A | Market::Hk => Shanghai,
        Market::Us => New_York,
        Market::Kr => Seoul,
    }
}

/// Axis layout for an intraday chart.
pub struct Axis {
    pub length: i32,
    pub labels: Vec<(i32, &'static str)>,
    pub sessions: Vec<(&'static str, i32, i32)>,
}

pub fn axis(market: Market) -> Axis {
    match market {
        Market::A => Axis {
            length: 241,
            labels: vec![(0, "09:30"), (60, "10:30"), (120, "11:30"), (181, "14:00"), (240, "15:00")],
            sessions: vec![],
        },
        Market::Hk => Axis {
            // 09:30–12:00 (150) + lunch column (1) + 13:00–16:00 (180) = 331
            // columns, so the valid index range is 0..=330.
            length: 331,
            // Lunch collapses to one column, so afternoon ticks are offset by
            // the 150 morning minutes: 13:00 → 150, 14:00 → 210, 15:00 → 270.
            labels: vec![(0, "09:30"), (90, "11:00"), (150, "12:00"), (210, "14:00"), (330, "16:00")],
            sessions: vec![],
        },
        Market::Kr => Axis {
            length: 391,
            labels: vec![(0, "09:00"), (90, "10:30"), (180, "12:00"), (270, "13:30"), (390, "15:30")],
            sessions: vec![],
        },
        Market::Us => Axis {
            length: 961,
            labels: vec![(0, "04:00"), (330, "09:30"), (570, "13:30"), (720, "16:00"), (960, "20:00")],
            sessions: vec![("pre", 0, 329), ("open", 330, 719), ("post", 720, 959)],
        },
    }
}

/// Convert a wall-clock time on a given trading day to an axis index.
/// US charts use 04:00 ET as index 0; the others use their opening bell.
pub fn axis_index(market: Market, datetime: DateTime<Tz>) -> Option<i32> {
    let m = minutes(&datetime);
    let idx = match market {
        Market::A => {
            // Squeeze the lunch break so 11:30 and 13:00 share one column.
            if m < 11 * 60 + 30 {
                m - (9 * 60 + 30)
            } else if m >= 13 * 60 {
                (m - 13 * 60 + 120).min(240)
            } else {
                120
            }
        }
        Market::Hk => {
            // Morning is 09:30–12:00 (150 minutes) and the afternoon resumes at
            // 13:00; the axis closes the 12:00–13:00 break at one column so the
            // two halves sit next to each other. The closing auction prints
            // after 16:00 and belongs in the last column, not beyond the axis.
            if m < 12 * 60 {
                m - (9 * 60 + 30)
            } else if m >= 13 * 60 {
                (m - 13 * 60 + 150).min(331 - 1)
            } else {
                150
            }
        }
        Market::Us => m - 4 * 60,
        Market::Kr => (m - 9 * 60).min(390),
    };
    if idx >= 0 && idx < axis(market).length {
        Some(idx)
    } else {
        None
    }
}

/// Map an `HHMM` (or `HH:MM`) wall-clock string onto an axis index.
pub fn axis_index_for_time(market: Market, stamp: &str) -> Option<i32> {
    let digits: String = stamp.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 3 {
        return None;
    }
    let minutes_of_day: u32 = if digits.len() == 4 {
        let h: u32 = digits[..2].parse().ok()?;
        let m: u32 = digits[2..4].parse().ok()?;
        h * 60 + m
    } else {
        return None;
    };
    let idx = match market {
        Market::A => {
            if minutes_of_day < 11 * 60 + 30 {
                minutes_of_day as i32 - (9 * 60 + 30)
            } else if minutes_of_day >= 13 * 60 {
                (minutes_of_day as i32 - 13 * 60 + 120).min(240)
            } else {
                120
            }
        }
        Market::Hk => {
            if minutes_of_day < 12 * 60 {
                minutes_of_day as i32 - (9 * 60 + 30)
            } else if minutes_of_day >= 13 * 60 {
                (minutes_of_day as i32 - 13 * 60 + 150).min(330)
            } else {
                150
            }
        }
        Market::Kr => (minutes_of_day as i32 - 9 * 60).min(390),
        Market::Us => (minutes_of_day as i32 - 4 * 60).min(960),
    };
    (idx >= 0 && idx < axis(market).length).then_some(idx)
}

/// Start of the current (or most recent) overnight tape: the last 20:00 ET
/// that is not in the future.
pub fn us_night_start(at: DateTime<Utc>) -> DateTime<Utc> {
    let et = at.with_timezone(&New_York);
    let today = New_York
        .with_ymd_and_hms(et.year(), et.month(), et.day(), 20, 0, 0)
        .single()
        .unwrap_or(et);
    if today <= et {
        today.with_timezone(&Utc)
    } else {
        (today - Duration::days(1)).with_timezone(&Utc)
    }
}

/// Previous trading day for daily change fallbacks.
pub fn previous_weekday(at: DateTime<Utc>, tz: Tz) -> DateTime<Utc> {
    let mut d = at.with_timezone(&tz) - Duration::days(1);
    while matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
        d -= Duration::days(1);
    }
    d.with_timezone(&Utc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn sh(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Shanghai
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
    }

    fn et(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        New_York
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_share_sessions() {
        // 2026-11-10 is a Tuesday.
        assert_eq!(cn_session(sh(2026, 11, 10, 9, 20)), "pre");
        assert_eq!(cn_session(sh(2026, 11, 10, 10, 0)), SESSION_OPEN);
        assert_eq!(cn_session(sh(2026, 11, 10, 12, 0)), SESSION_LUNCH);
        assert_eq!(cn_session(sh(2026, 11, 10, 14, 0)), SESSION_OPEN);
        assert_eq!(cn_session(sh(2026, 11, 10, 15, 1)), SESSION_CLOSED);
        // Weekend
        assert_eq!(cn_session(sh(2026, 11, 14, 10, 0)), SESSION_WEEKEND);
    }

    #[test]
    fn hk_lunch_and_close() {
        assert_eq!(hk_session(sh(2026, 11, 10, 9, 10)), SESSION_PRE);
        assert_eq!(hk_session(sh(2026, 11, 10, 12, 30)), SESSION_LUNCH);
        assert_eq!(hk_session(sh(2026, 11, 10, 15, 59)), SESSION_OPEN);
        assert_eq!(hk_session(sh(2026, 11, 10, 16, 1)), SESSION_CLOSED);
    }

    #[test]
    fn us_sessions_across_midnight() {
        // Tuesday 03:00 ET is still Monday's overnight tape.
        assert_eq!(us_session(et(2026, 11, 10, 3, 0)), SESSION_NIGHT);
        assert_eq!(us_session(et(2026, 11, 10, 8, 0)), SESSION_PRE);
        assert_eq!(us_session(et(2026, 11, 10, 12, 0)), SESSION_OPEN);
        assert_eq!(us_session(et(2026, 11, 10, 18, 0)), SESSION_POST);
        assert_eq!(us_session(et(2026, 11, 10, 21, 0)), SESSION_NIGHT);
        // Friday evening has no overnight tape.
        assert_eq!(us_session(et(2026, 11, 13, 21, 0)), SESSION_CLOSED);
        // Saturday afternoon is closed.
        assert_eq!(us_session(et(2026, 11, 14, 12, 0)), SESSION_WEEKEND);
        // Sunday 21:00 ET opens the Monday tape.
        assert_eq!(us_session(et(2026, 11, 15, 21, 0)), SESSION_NIGHT);
    }

    #[test]
    fn kr_sessions() {
        let kst = Seoul.with_ymd_and_hms(2026, 11, 10, 10, 0, 0).unwrap();
        assert_eq!(kr_session(kst.with_timezone(&Utc)), SESSION_OPEN);
        let kst = Seoul.with_ymd_and_hms(2026, 11, 10, 15, 45, 0).unwrap();
        assert_eq!(kr_session(kst.with_timezone(&Utc)), SESSION_CLOSED);
    }

    #[test]
    fn a_share_axis_compresses_lunch() {
        let t = Shanghai.with_ymd_and_hms(2026, 11, 10, 11, 30, 0).unwrap();
        assert_eq!(axis_index(Market::A, t), Some(120));
        let t = Shanghai.with_ymd_and_hms(2026, 11, 10, 13, 0, 0).unwrap();
        assert_eq!(axis_index(Market::A, t), Some(120));
        let t = Shanghai.with_ymd_and_hms(2026, 11, 10, 14, 0, 0).unwrap();
        assert_eq!(axis_index(Market::A, t), Some(180));
    }

    #[test]
    fn us_axis_spans_extended_hours() {
        let t = New_York.with_ymd_and_hms(2026, 11, 9, 4, 0, 0).unwrap();
        assert_eq!(axis_index(Market::Us, t), Some(0));
        let t = New_York.with_ymd_and_hms(2026, 11, 9, 9, 30, 0).unwrap();
        assert_eq!(axis_index(Market::Us, t), Some(330));
        // 20:00 is the last printable minute of the extended session.
        let t = New_York.with_ymd_and_hms(2026, 11, 9, 20, 0, 0).unwrap();
        assert_eq!(axis_index(Market::Us, t), Some(960));
        let t = New_York.with_ymd_and_hms(2026, 11, 9, 19, 59, 0).unwrap();
        assert_eq!(axis_index(Market::Us, t), Some(959));
    }

    #[test]
    fn night_start_is_last_8pm_eastern() {
        // 2026-11-10 02:00 ET (during the overnight tape) → the 20:00 before.
        let at = et(2026, 11, 10, 2, 0);
        let start = us_night_start(at).with_timezone(&New_York);
        assert_eq!(start.hour(), 20);
        // 19:00 the previous day.
        assert_eq!(start.day(), 9);
    }

    #[test]
    fn previous_weekday_skips_weekend() {
        // Monday 2026-11-09 → Friday 2026-11-06.
        let at = sh(2026, 11, 9, 10, 0);
        let prev = previous_weekday(at, Shanghai).with_timezone(&Shanghai);
        assert_eq!(prev.weekday(), Weekday::Fri);
        assert_eq!(prev.day(), 6);
    }
}

#[cfg(test)]
mod hk_axis_tests {
    use super::*;
    use chrono::TimeZone;

    fn hk(h: u32, mi: u32) -> DateTime<Tz> {
        chrono_tz::Asia::Shanghai
            .with_ymd_and_hms(2026, 11, 10, h, mi, 0)
            .single()
            .unwrap()
    }

    #[test]
    fn lunch_sits_at_the_morning_close() {
        // 11:59 is the last morning minute, 12:00 the shared lunch column and
        // 13:00 the first afternoon minute — they must be contiguous.
        assert_eq!(axis_index(Market::Hk, hk(11, 59)), Some(149));
        assert_eq!(axis_index(Market::Hk, hk(12, 0)), Some(150));
        assert_eq!(axis_index(Market::Hk, hk(12, 30)), Some(150));
        assert_eq!(axis_index(Market::Hk, hk(13, 0)), Some(150));
        assert_eq!(axis_index(Market::Hk, hk(13, 1)), Some(151));
    }

    #[test]
    fn close_and_closing_auction_share_the_last_column() {
        assert_eq!(axis_index(Market::Hk, hk(15, 59)), Some(329));
        assert_eq!(axis_index(Market::Hk, hk(16, 0)), Some(330));
        // The 16:00–16:10 auction print must not fall outside the axis.
        assert_eq!(axis_index(Market::Hk, hk(16, 4)), Some(330));
        assert_eq!(axis_index(Market::Hk, hk(16, 10)), Some(330));
    }

    #[test]
    fn a_share_closing_auction_is_clamped() {
        let t = chrono_tz::Asia::Shanghai
            .with_ymd_and_hms(2026, 11, 10, 15, 0, 0)
            .single()
            .unwrap();
        assert_eq!(axis_index(Market::A, t), Some(240));
    }
}
