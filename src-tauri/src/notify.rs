use crate::state::PriceAlertHit;
use tauri::{AppHandle, Manager};

/// Localise the notification using the app's own language setting. Keeping
/// this in Rust avoids needing notification permissions from the webview the
/// first time an alert fires.
pub fn send_hit(app: &AppHandle, hit: &PriceAlertHit) {
    use tauri_plugin_notification::NotificationExt;
    let settings = {
        use crate::state::AppState;
        let state = app.state::<AppState>();
        state.settings()
    };
    let lang = settings.language.as_str();
    let (title, body) = compose(hit, lang);
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

fn compose(hit: &PriceAlertHit, lang: &str) -> (String, String) {
    let price = crate::format_price(hit.price);
    let target = crate::format_price(hit.target_price);
    match lang {
        "en" => {
            let verb = match hit.direction {
                crate::model::AlertDirection::Rise => "rose to",
                crate::model::AlertDirection::Fall => "fell to",
            };
            let session = match hit.session_label.as_deref() {
                Some("pre") => "Pre-market ",
                Some("post") => "After-hours ",
                Some("night") => "Overnight ",
                _ => "",
            };
            (
                format!("{} price alert", hit.stock_name),
                format!("{session}price {price} {verb} your target {target}."),
            )
        }
        "ja" => {
            let verb = match hit.direction {
                crate::model::AlertDirection::Rise => "まで上昇",
                crate::model::AlertDirection::Fall => "まで下落",
            };
            let session = match hit.session_label.as_deref() {
                Some("pre") => "プレマーケット ",
                Some("post") => "アフターマーケット ",
                Some("night") => "ナイトセッション ",
                _ => "現在値 ",
            };
            (
                format!("{} 目標価格に到達", hit.stock_name),
                format!("{session}{price} が目標値 {target} {verb}しました。"),
            )
        }
        _ => {
            let verb = match hit.direction {
                crate::model::AlertDirection::Rise => "涨到",
                crate::model::AlertDirection::Fall => "跌到",
            };
            let session = match hit.session_label.as_deref() {
                Some("pre") => "盘前价 ",
                Some("post") => "盘后价 ",
                Some("night") => "夜盘价 ",
                _ => "现价 ",
            };
            (
                format!("{} 到价提醒", hit.stock_name),
                format!("{session}{price}，已{verb}目标价 {target}"),
            )
        }
    }
}

pub fn request_permission(app: &AppHandle) -> bool {
    use tauri_plugin_notification::NotificationExt;
    let result = app.notification().request_permission();
    matches!(
        result,
        Ok(tauri_plugin_notification::PermissionState::Granted)
    )
}

pub fn is_granted(app: &AppHandle) -> bool {
    use tauri_plugin_notification::NotificationExt;
    matches!(
        app.notification().permission_state(),
        Ok(tauri_plugin_notification::PermissionState::Granted)
    )
}

pub fn send_test(app: &AppHandle) -> bool {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("Stockpot")
        .body("Notifications are working. 到价提醒已就绪。")
        .show()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AlertDirection;

    fn hit(direction: AlertDirection) -> PriceAlertHit {
        PriceAlertHit {
            stock_id: "sh600000".into(),
            stock_name: "浦发银行".into(),
            price: 11.5,
            target_price: 11.0,
            direction,
            session_label: None,
        }
    }

    #[test]
    fn english_copy_reads_naturally() {
        let (title, body) = compose(&hit(AlertDirection::Rise), "en");
        assert_eq!(title, "浦发银行 price alert");
        assert!(body.contains("rose to"));
    }

    #[test]
    fn chinese_copy_matches_reference_app() {
        let (title, body) = compose(&hit(AlertDirection::Fall), "zh");
        assert!(title.contains("到价提醒"));
        assert!(body.contains("跌到目标价"));
    }

    #[test]
    fn session_labels_are_localised() {
        let mut h = hit(AlertDirection::Rise);
        h.session_label = Some("night".into());
        let (_, body) = compose(&h, "zh");
        assert!(body.starts_with("夜盘价"));
        let (_, body) = compose(&h, "en");
        assert!(body.starts_with("Overnight"));
    }
}
