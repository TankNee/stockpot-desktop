//! AI-assisted classification.
//!
//! The app never ships a model and never calls an API on its own: the user
//! configures a local JEV endpoint, presses a button, and reviews the result
//! before anything is written. The request builder and response parser live
//! here so they can be tested without a network.

/// One row handed to the model.
pub struct AiItem {
    pub id: String,
    pub date: String,
    /// HH:MM when the source supplies a time.
    pub time: String,
    pub counterparty: String,
    pub note: String,
    pub account: String,
    pub text: String,
    pub amount: String,
    /// expense | income | transfer
    pub kind: String,
}

/// A JEV choice option: the path is the answer, the text is the criterion.
pub type CategoryOption = (String, String, String);

/// Build a JEV `/v1/systemone` request. JEV does not use chat messages: the
/// state is the bill and the question is a choice among the supplied criteria.
/// At most 26 options are allowed per question, so the caller uses this once for
/// the top-level groups and again for the selected group's leaves.
pub fn build_jev_request(
    model: &str,
    item: &AiItem,
    options: &[CategoryOption],
) -> serde_json::Value {
    let mut options = options.to_vec();
    if options.len() == 1 {
        // JEV requires 2–26 candidates. A direction can leave only one
        // meaningful category; the sentinel keeps that a valid question and is
        // discarded by the caller if selected.
        options.push((
            "none".into(),
            String::new(),
            "None of the listed categories fits this bill.".into(),
        ));
    }
    let criteria: serde_json::Map<String, serde_json::Value> = options
        .iter()
        .map(|(path, _kind, description)| {
            (
                path.clone(),
                serde_json::Value::String(if description.trim().is_empty() {
                    // JEV rejects empty criteria; a path is still a useful
                    // description for custom categories without notes.
                    path.clone()
                } else {
                    description.clone()
                }),
            )
        })
        .collect();
    serde_json::json!({
        "model": model,
        "state": {
            "date": item.date,
            "time": item.time,
            "counterparty": item.counterparty,
            "note": item.note,
            "amount": item.amount,
            "kind": item.kind,
            "account": item.account,
            "text": item.text,
        },
        "questions": {
            "category": {
                "type": "choice",
                "instructions": "Choose the single most specific category for this bill. Use the transaction text, not the amount. If none fits, choose none.",
                "criteria": criteria,
            }
        }
    })
}

/// Parse the `answers.category` object returned by Ollama's JEV endpoint.
pub fn parse_jev_response(body: &str) -> Result<(String, f32), String> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let answer = value
        .get("answers")
        .and_then(|answers| answers.get("category"))
        .ok_or("no-category")?;
    let choice = answer
        .get("choice")
        .and_then(|v| v.as_str())
        .ok_or("no-choice")?
        .to_string();
    let confidence = answer
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0) as f32;
    Ok((choice, confidence.clamp(0.0, 1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items() -> Vec<AiItem> {
        vec![
            AiItem {
                id: "e1".into(),
                date: "2025-07-01".into(),
                time: "10:00".into(),
                counterparty: "瑞幸咖啡".into(),
                note: "拿铁".into(),
                account: "零钱".into(),
                text: "瑞幸咖啡 拿铁".into(),
                amount: "19.00".into(),
                kind: "expense".into(),
            },
            AiItem {
                id: "e2".into(),
                date: "2025-07-02".into(),
                time: "18:00".into(),
                counterparty: "滴滴出行".into(),
                note: "快车".into(),
                account: "银行卡".into(),
                text: "滴滴出行 快车".into(),
                amount: "28.50".into(),
                kind: "expense".into(),
            },
        ]
    }

    #[test]
    fn builds_a_jev_choice_request() {
        let item = &items()[0];
        let options = vec![("餐饮".into(), "expense".into(), "餐饮消费".into())];
        let request = build_jev_request("tev1", item, &options);
        assert_eq!(request["model"], "tev1");
        assert!(request["state"]["text"].as_str().unwrap().contains("瑞幸"));
        assert_eq!(request["questions"]["category"]["criteria"]["餐饮"], "餐饮消费");
    }

    #[test]
    fn empty_descriptions_fall_back_to_the_category_path() {
        let request = build_jev_request("tev1", &items()[0], &[("其他".into(), "".into(), "".into())]);
        let criteria = request["questions"]["category"]["criteria"].as_object().unwrap();
        assert_eq!(criteria["其他"], "其他");
        assert_eq!(criteria["none"], "None of the listed categories fits this bill.");
    }

    #[test]
    fn parses_the_jev_answer() {
        let response = r#"{"answers":{"category":{"choice":"餐饮/咖啡","confidence":0.87}}}"#;
        let (category, confidence) = parse_jev_response(response).unwrap();
        assert_eq!(category, "餐饮/咖啡");
        assert!((confidence - 0.87).abs() < 1e-6);
    }


    #[test]
    fn single_candidate_gets_a_no_match_option() {
        let request = build_jev_request("tev1", &items()[0], &[("工资".into(), "income".into(), "工资收入".into())]);
        let criteria = request["questions"]["category"]["criteria"].as_object().unwrap();
        assert_eq!(criteria.len(), 2);
        assert!(criteria.contains_key("none"));
    }
}
