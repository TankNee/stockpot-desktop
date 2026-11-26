//! Bookkeeping: a personal ledger fed by manual entry and by the CSV bills that
//! WeChat and Alipay export.
//!
//! Money is kept in **cents** (`i64`). Floating point cents drift once you sum a
//! few thousand rows, and a ledger that is off by ¥0.01 is a ledger nobody
//! trusts. All formatting back to yuan happens in the UI.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One transaction. `amount` is always positive; `kind` says which way it went.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    /// `HH:MM`, empty for date-only manual rows.
    #[serde(default)]
    pub time: String,
    /// `expense` | `income` | `transfer`
    pub kind: String,
    /// Cents, always positive.
    pub amount: i64,
    pub category: String,
    /// Where the money moved: a card, WeChat balance, cash…
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub counterparty: String,
    #[serde(default)]
    pub note: String,
    /// `manual` | `wechat` | `alipay`
    #[serde(default = "default_source")]
    pub source: String,
    /// Merchant or platform transaction number, used to dedupe re-imports.
    #[serde(default)]
    pub external_id: String,
    /// Kept out of totals — refunds and account-to-account moves.
    #[serde(default)]
    pub excluded: bool,
    /// Set aside by 整理账单's automatic tidy: the row stays in the file as a
    /// record (nothing is deleted) but drops out of totals and of the everyday
    /// lists, leaving one copy of each duplicated bill in view.
    #[serde(default)]
    pub archived: bool,
    /// Cents already returned against this row. An expense's effective cost is
    /// `amount - refunded_amount`, so a partial refund does not need its own row.
    #[serde(default)]
    pub refunded_amount: i64,
    /// `YYYY-MM-DD` of the latest matched refund, empty when none.
    #[serde(default)]
    pub refunded_at: String,
    /// A human set this category. Automatic re-labelling leaves it alone, so
    /// the model only ever second-guesses labels it produced itself.
    #[serde(default)]
    pub category_locked: bool,
    /// Optional project this transaction belongs to (a trip, a move, etc.).
    #[serde(default)]
    pub project_id: String,
    pub created_at: String,
}

fn default_source() -> String {
    "manual".into()
}

/// One balance the user tracks by hand: a card, a fund, a pension pot. Kept
/// separate from `Entry`, which records movement rather than what is sitting in
/// an account.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wallet {
    pub id: String,
    pub name: String,
    /// `debit` | `credit` | `investment` | `pension` | `provident` | `medical` | `cash` | `other`
    pub kind: String,
    #[serde(default)]
    pub institution: String,
    /// Cents. Credit cards store what is owed as a **negative** number so the
    /// net total needs no special case.
    pub balance: i64,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub updated_at: String,
}

/// A keyword → category rule. Matching is plain substring, longest pattern
/// first, so "星巴克" can beat the generic "咖啡".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub pattern: String,
    pub category: String,
}

/// Seed rules: the keyword table that used to be hard-coded, now editable.
const DEFAULT_RULES: [(&str, &str); 42] = [
    ("星巴克", "餐饮/咖啡"),
    ("瑞幸", "餐饮/咖啡"),
    ("咖啡", "餐饮/咖啡"),
    ("麦当劳", "餐饮"),
    ("肯德基", "餐饮"),
    ("美团外卖", "餐饮/外卖"),
    ("饿了么", "餐饮/外卖"),
    ("外卖", "餐饮/外卖"),
    ("餐厅", "餐饮"),
    ("火锅", "餐饮"),
    ("滴滴", "交通/打车"),
    ("出租", "交通/打车"),
    ("打车", "交通/打车"),
    ("地铁", "交通/地铁公交"),
    ("公交", "交通/地铁公交"),
    ("高铁", "交通"),
    ("机票", "交通"),
    ("航空", "交通"),
    ("加油", "交通/加油"),
    ("停车", "交通"),
    ("通行费", "交通"),
    ("淘宝", "购物"),
    ("天猫", "购物"),
    ("京东", "购物"),
    ("拼多多", "购物"),
    ("超市", "购物"),
    ("便利店", "购物"),
    ("房租", "居住/房租"),
    ("物业", "居住"),
    ("水费", "居住/水电燃气"),
    ("电费", "居住/水电燃气"),
    ("燃气", "居住/水电燃气"),
    ("电影", "娱乐/影音"),
    ("游戏", "娱乐"),
    ("会员", "娱乐"),
    ("旅游", "娱乐/旅行"),
    ("医院", "医疗/门诊"),
    ("药房", "医疗"),
    ("学费", "教育"),
    ("书", "教育"),
    ("话费", "通讯"),
    ("工资", "工资"),
];

fn default_rules() -> Vec<Rule> {
    DEFAULT_RULES
        .iter()
        .enumerate()
        .map(|(index, (pattern, category))| Rule {
            id: format!("seed-{index}"),
            pattern: (*pattern).to_string(),
            category: (*category).to_string(),
        })
        .collect()
}

/// A group of transactions with a shared purpose. Projects never change the
/// category or account totals; they are a second way to read the ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
    /// Optional bounds used to suggest the period; membership is explicit.
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub archived: bool,
    pub created_at: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub archived: bool,
}

/// A ledger snapshot as the UI needs it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    #[serde(default)]
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub categories: Vec<CategoryDef>,
    #[serde(default)]
    pub accounts: Vec<String>,
    #[serde(default)]
    pub imports: Vec<ImportRecord>,
    /// Manually maintained balances.
    #[serde(default)]
    pub wallets: Vec<Wallet>,
    /// Explicit transaction groupings such as a trip or a move.
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Keyword rules applied when a bill is imported.
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Duplicate groups the user says are two real purchases. Keyed by the
    /// group signature so the detection stays deterministic.
    #[serde(default)]
    pub ignored_duplicates: Vec<String>,
    /// Repayment rows the user says are ordinary spending.
    #[serde(default)]
    pub ignored_repayments: Vec<String>,
    /// Bumped when the built-in category tree changes, so the migration runs
    /// once per ledger instead of on every load.
    #[serde(default)]
    pub schema_version: u32,
}

/// Current category-tree version. Bump when [`DEFAULT_TREE`] changes.
const SCHEMA_VERSION: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub id: String,
    pub file: String,
    /// `wechat` | `alipay`
    pub source: String,
    pub added: usize,
    pub skipped: usize,
    pub imported_at: String,
}

/// A category is two levels at most: a group and an optional leaf. The path is
/// stored on entries as `group/leaf`, which keeps old flat values readable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDef {
    pub name: String,
    /// Empty for a top-level category.
    #[serde(default)]
    pub parent: String,
    /// `expense` | `income` | empty when it fits both.
    #[serde(default)]
    pub kind: String,
    /// Icon key the UI maps to a glyph.
    #[serde(default)]
    pub icon: String,
    /// What belongs here, sent to JEV as the option's description.
    #[serde(default)]
    pub description: String,
}

impl CategoryDef {
    pub fn path(&self) -> String {
        if self.parent.is_empty() {
            self.name.clone()
        } else {
            format!("{}/{}", self.parent, self.name)
        }
    }
}

/// Accepts both the old flat string and the new object, so an existing
/// `ledger.json` keeps opening.
impl<'de> Deserialize<'de> for CategoryDef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Flat(String),
            Full {
                name: String,
                #[serde(default)]
                parent: String,
                #[serde(default)]
                kind: String,
                #[serde(default)]
                icon: String,
                #[serde(default)]
                description: String,
            },
        }
        Ok(match Raw::deserialize(deserializer)? {
            Raw::Flat(name) => CategoryDef {
                name,
                parent: String::new(),
                kind: String::new(),
                icon: String::new(),
                description: String::new(),
            },
            Raw::Full {
                name,
                parent,
                kind,
                icon,
                description,
            } => CategoryDef {
                name,
                parent,
                kind,
                icon,
                description,
            },
        })
    }
}

/// Icon for each built-in top-level name, so a ledger that predates the icon
/// field still gets one.
/// `income` for money coming in, `expense` for money going out, `None` when the
/// name is neither (其他, 转账 and anything the user invented).
fn builtin_kind(name: &str) -> Option<&'static str> {
    Some(match name {
        "工资" | "奖金" | "理财收益" | "理财" | "利息" | "分红" => "income",
        "餐饮" | "交通" | "购物" | "居住" | "娱乐" | "医疗" | "教育" | "通讯" | "人情" => "expense",
        _ => return None,
    })
}

fn builtin_icon(name: &str) -> Option<&'static str> {
    Some(match name {
        "餐饮" => "food",
        "交通" => "transport",
        "购物" => "shopping",
        "居住" => "home",
        "娱乐" => "fun",
        "医疗" => "health",
        "教育" => "book",
        "通讯" => "phone",
        "人情" => "gift",
        "其他" => "dots",
        "工资" => "salary",
        "理财" => "invest",
        "转账" => "transfer",
        _ => return None,
    })
}

/// Leaves added under a built-in group by the v1 upgrade.
const DEFAULT_TREE: [(&str, &[(&str, &str)]); 11] = [
    (
        "餐饮",
        &[
            ("早餐", "coffee"),
            ("午餐", "food"),
            ("晚餐", "food"),
            ("咖啡", "coffee"),
            ("外卖", "takeout"),
        ],
    ),
    (
        "交通",
        &[("地铁公交", "bus"), ("打车", "taxi"), ("加油", "fuel")],
    ),
    (
        "购物",
        &[("日用", "basket"), ("服饰", "shirt"), ("数码", "device")],
    ),
    ("居住", &[("房租", "home"), ("水电燃气", "bolt")]),
    ("娱乐", &[("影音", "film"), ("旅行", "plane")]),
    ("医疗", &[("门诊", "health"), ("药品", "health")]),
    ("教育", &[("课程", "book"), ("书籍", "book")]),
    ("通讯", &[("话费", "phone"), ("宽带", "phone")]),
    ("人情", &[("红包", "gift"), ("礼品", "gift")]),
    ("工资", &[("基本工资", "salary"), ("奖金", "bonus")]),
    ("理财", &[("利息", "invest"), ("分红", "invest")]),
];

/// Move rows whose category contradicts their direction, and apply the rules.
/// Shared by the schema migration and the "re-file by rules" action.
fn refile_unlocked(entries: &mut [Entry], rules: &[Rule], categories: &[CategoryDef]) -> usize {
    let mut changed = 0usize;
    for entry in entries.iter_mut() {
        if entry.category_locked {
            continue;
        }
        let haystack = format!("{} {} {}", entry.counterparty, entry.note, entry.account);
        let current_kind = category_kind(categories, &entry.category);
        // Only income and spending have a direction. A transfer is money moving
        // between the user's own accounts, so any category is legitimate.
        let directional = entry.kind == "expense" || entry.kind == "income";
        let wrong_direction = directional && !current_kind.is_empty() && current_kind != entry.kind;
        let matched = match_rule_for(rules, categories, &haystack, &entry.kind)
            .map(|rule| rule.category.clone());
        let next = match (matched, wrong_direction) {
            (Some(category), _) => Some(category),
            (None, true) => Some(guess_category(&haystack, &entry.kind, "")),
            (None, false) => None,
        };
        if let Some(category) = next
            && category != entry.category
        {
            entry.category = category;
            changed += 1;
        }
    }
    changed
}

/// Give every built-in category its icon and a starter set of leaves.
///
/// A ledger migrated from the old flat string list has names but no icons and
/// no children; this fills both in once, and leaves anything the user has
/// already customised untouched.
fn upgrade_category_tree(categories: &mut Vec<CategoryDef>) {
    for def in categories.iter_mut() {
        if def.icon.is_empty()
            && let Some(icon) = builtin_icon(&def.name)
        {
            def.icon = icon.to_string();
        }
        // Direction is what stops an incoming transfer from being filed as
        // shopping; a tree migrated from strings has none, so fill it in.
        if def.kind.is_empty()
            && let Some(kind) = builtin_kind(&def.name)
        {
            def.kind = kind.to_string();
        }
        if def.description.is_empty()
            && let Some(description) = builtin_description(&def.path())
        {
            def.description = description.to_string();
        }
    }
    for (parent, leaves) in DEFAULT_TREE {
        if !categories.iter().any(|c| c.name == parent && c.parent.is_empty()) {
            continue;
        }
        for (name, icon) in leaves {
            let exists = categories
                .iter()
                .any(|c| c.name == *name && c.parent == parent);
            if !exists {
                categories.push(CategoryDef {
                    name: (*name).to_string(),
                    parent: parent.to_string(),
                    kind: "expense".to_string(),
                    icon: (*icon).to_string(),
                description: String::new(),
                });
            }
        }
    }
}


/// Default option descriptions for JEV. These are deliberately about what
/// belongs in the bucket, not about the icon or the display name.
fn builtin_description(path: &str) -> Option<&'static str> {
    Some(match path {
        "餐饮" => "堂食、餐馆、正餐、小吃、饮料等日常饮食消费。",
        "餐饮/早餐" => "早餐、早点、包子、豆浆、早餐店等。",
        "餐饮/午餐" => "午餐、工作日正餐、午市套餐等。",
        "餐饮/晚餐" => "晚餐、夜间正餐、夜宵等。",
        "餐饮/咖啡" => "咖啡馆、咖啡店、咖啡饮品，如星巴克、瑞幸等。",
        "餐饮/外卖" => "外卖平台或商家送餐，如美团外卖、饿了么。",
        "交通" => "公共交通、火车、机票、停车等出行相关支出。",
        "交通/地铁公交" => "地铁、公交、公共交通乘车费用。",
        "交通/打车" => "出租车、网约车、代驾，如滴滴出行。",
        "交通/加油" => "汽油、柴油、充电等车辆能源费用。",
        "购物" => "商品购买、商场、电商、超市和便利店消费。",
        "购物/日用" => "日用品、清洁用品、纸巾、厨房用品等日常消耗品。",
        "购物/服饰" => "衣服、鞋帽、箱包、饰品等穿戴用品。",
        "购物/数码" => "手机、电脑、耳机、充电器等电子产品。",
        "居住" => "住房、物业、家居和居住相关服务支出。",
        "居住/房租" => "房屋租金、住房租赁费用。",
        "居住/水电燃气" => "水费、电费、燃气费、供暖等家庭公用事业费用。",
        "娱乐" => "休闲、游戏、影视、演出、运动等娱乐支出。",
        "娱乐/影音" => "电影、视频会员、音乐、演出等影音娱乐。",
        "娱乐/旅行" => "旅游、酒店、景点、度假等旅行相关支出。",
        "医疗" => "医院、诊所、药品、体检等医疗健康支出。",
        "医疗/门诊" => "医院挂号、门诊、检查、治疗等医疗服务。",
        "医疗/药品" => "药房、药品、保健品等购买费用。",
        "教育" => "课程、培训、学习、书籍等教育支出。",
        "教育/课程" => "线上或线下课程、培训、辅导费用。",
        "教育/书籍" => "纸质书、电子书、教材等书籍购买费用。",
        "通讯" => "手机、网络、通信服务相关费用。",
        "通讯/话费" => "手机话费、充值、套餐费用。",
        "通讯/宽带" => "家庭宽带、网络安装和月租费用。",
        "人情" => "红包、礼物、请客、社交往来等支出。",
        "人情/红包" => "给亲友或他人发送红包、礼金。",
        "人情/礼品" => "购买礼物、礼品、伴手礼等。",
        "工资" => "工作收入、薪资、劳务报酬等。",
        "工资/基本工资" => "固定工资、月度薪资、基本劳动报酬。",
        "工资/奖金" => "绩效奖金、年终奖、项目奖金等。",
        "理财" => "利息、基金、投资收益等理财收入。",
        "理财/利息" => "存款、账户或债券产生的利息收入。",
        "理财/分红" => "股票、基金或投资产品的分红收入。",
        "其他" => "无法明确归入其他分类的收入或支出。",
        "转账" => "本人账户之间的转账、资金调拨，不是消费或收入。",
        "退款" => "商家退回的款项、退款收入，需与原始消费对应。",
        _ => return None,
    })
}

/// Default tree: a group per area of spending, with the leaves people actually
/// use. Kept small on purpose — a taxonomy nobody maintains is worse than none.
const DEFAULT_CATEGORIES: [(&str, &str, &str, &str); 30] = [
    ("餐饮", "", "expense", "food"),
    ("早餐", "餐饮", "expense", "coffee"),
    ("午餐", "餐饮", "expense", "food"),
    ("晚餐", "餐饮", "expense", "food"),
    ("咖啡", "餐饮", "expense", "coffee"),
    ("外卖", "餐饮", "expense", "takeout"),
    ("交通", "", "expense", "transport"),
    ("地铁公交", "交通", "expense", "bus"),
    ("打车", "交通", "expense", "taxi"),
    ("加油", "交通", "expense", "fuel"),
    ("购物", "", "expense", "shopping"),
    ("日用", "购物", "expense", "basket"),
    ("服饰", "购物", "expense", "shirt"),
    ("数码", "购物", "expense", "device"),
    ("居住", "", "expense", "home"),
    ("房租", "居住", "expense", "home"),
    ("水电燃气", "居住", "expense", "bolt"),
    ("娱乐", "", "expense", "fun"),
    ("影音", "娱乐", "expense", "film"),
    ("旅行", "娱乐", "expense", "plane"),
    ("医疗", "", "expense", "health"),
    ("教育", "", "expense", "book"),
    ("通讯", "", "expense", "phone"),
    ("人情", "", "expense", "gift"),
    ("其他", "", "", "dots"),
    ("工资", "", "income", "salary"),
    ("奖金", "", "income", "bonus"),
    ("理财收益", "", "income", "invest"),
    ("退款", "", "income", "refund"),
    ("转账", "", "", "transfer"),
];

fn default_categories() -> Vec<CategoryDef> {
    DEFAULT_CATEGORIES
        .iter()
        .map(|(name, parent, kind, icon)| CategoryDef {
            name: name.to_string(),
            parent: parent.to_string(),
            kind: kind.to_string(),
            icon: icon.to_string(),
            description: builtin_description(&if parent.is_empty() {
                name.to_string()
            } else {
                format!("{parent}/{name}")
            })
            .unwrap_or_default()
            .to_string(),
        })
        .collect()
}

impl Ledger {
    pub fn with_defaults() -> Self {
        Self {
            entries: Vec::new(),
            categories: default_categories(),
            accounts: vec!["现金".into(), "微信零钱".into(), "支付宝余额".into()],
            imports: Vec::new(),
            wallets: Vec::new(),
            projects: Vec::new(),
            rules: default_rules(),
            ignored_duplicates: Vec::new(),
            ignored_repayments: Vec::new(),
            schema_version: SCHEMA_VERSION,
        }
    }

    /// Newest first; rows without a time sort after timed rows on the same day.
    pub fn sort(&mut self) {
        self.entries.sort_by(|a, b| {
            b.date
                .cmp(&a.date)
                .then_with(|| b.time.cmp(&a.time))
        });
    }

    /// Fill in missing defaults so an older or hand-edited file still opens.
    pub fn normalize(&mut self) {
        if self.categories.is_empty() {
            self.categories = default_categories();
        }
        if self.accounts.is_empty() {
            self.accounts = vec!["现金".into()];
        }
        if self.categories.iter().all(|c| c.name != "其他") {
            self.categories.push(CategoryDef {
                name: "其他".into(),
                parent: String::new(),
                kind: String::new(),
                icon: "dots".into(),
                description: String::new(),
            });
        }
        for entry in self.entries.iter_mut() {
            if entry.id.is_empty() {
                entry.id = uuid::Uuid::new_v4().to_string();
            }
            if entry.amount < 0 {
                entry.amount = entry.amount.abs();
            }
            if entry.created_at.is_empty() {
                entry.created_at = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
            }
            if entry.category.is_empty() {
                entry.category = "其他".into();
            }
        }
        if self.schema_version < SCHEMA_VERSION {
            upgrade_category_tree(&mut self.categories);
            // v2 added the editable rule table; a ledger written before it has
            // no keywords at all, so seed them once.
            if self.rules.is_empty() {
                self.rules = default_rules();
            }
            // v3 gave the tree its directions; rows filed before that can now be
            // seen to contradict them, so put them right once.
            let rules = self.rules.clone();
            let categories = self.categories.clone();
            refile_unlocked(&mut self.entries, &rules, &categories);
            self.schema_version = SCHEMA_VERSION;
        }
        for wallet in self.wallets.iter_mut() {
            if wallet.id.is_empty() {
                wallet.id = uuid::Uuid::new_v4().to_string();
            }
            if wallet.kind.is_empty() {
                wallet.kind = "other".into();
            }
        }
    }
}

pub fn ledger_path(dir: &Path) -> PathBuf {
    dir.join("ledger.json")
}

pub fn load(dir: &Path) -> Ledger {
    load_with_status(dir).0
}

/// Loads the ledger and reports whether the on-disk copy was older, so the
/// caller can write the upgraded shape back immediately instead of waiting for
/// the next edit.
pub fn load_with_status(dir: &Path) -> (Ledger, bool) {
    let path = ledger_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Ledger>(&raw) {
            Ok(mut ledger) => {
                let before = ledger.schema_version;
                ledger.normalize();
                let upgraded = ledger.schema_version != before;
                (ledger, upgraded)
            }
            Err(_) => (Ledger::with_defaults(), false),
        },
        Err(_) => (Ledger::with_defaults(), false),
    }
}

/// Write through a temp file so a crash mid-save cannot truncate the ledger.
///
/// 落盘后把内容的指纹一起返回。文件监听器靠它分辨「这次改动是我们自己写的」，
/// 从而不去把整份账本重新解析一遍再推给前端——一次保存白干两回的根源就在那。
pub fn save(dir: &Path, ledger: &Ledger) -> Result<u64, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = ledger_path(dir);
    let tmp = path.with_extension("json.tmp");
    // 紧凑格式：三千多条时缩进能多占近三分之一体积，而这份文件谁也不看，
    // 省下来的都是每次保存的序列化时间和磁盘写入。
    let body = serde_json::to_string(ledger).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    // Keep one rolling backup; a ledger is small and losing it is expensive.
    let backup = path.with_extension("json.bak");
    let _ = std::fs::copy(&path, &backup);
    Ok(hash_bytes(body.as_bytes()))
}

/// FNV-1a：只用来判断「还是不是同一份内容」，不走加密用途。
pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

// ---------------------------------------------------------------------------
// CSV reading
// ---------------------------------------------------------------------------

/// Decode bill bytes. WeChat exports UTF-8 (often with a BOM), Alipay exports
/// GBK — both are handled by sniffing the BOM and falling back to GB18030,
/// which is a superset of GBK.
pub fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GB18030.decode(bytes);
            decoded.into_owned()
        }
    }
}

/// Split one CSV record, honouring double quotes and escaped `""`.
pub fn split_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            }
            '"' => quoted = true,
            ',' if !quoted => out.push(std::mem::take(&mut field)),
            _ => field.push(c),
        }
    }
    out.push(field);
    out.into_iter().map(|f| f.trim().to_string()).collect()
}

/// `/` and empty cells mean "no direction" in both exports.
fn parse_kind(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "支出" | "支" => Some("expense"),
        "收入" | "收" => Some("income"),
        // Neutral rows: WeChat writes `/`, Alipay writes 不计收支. Both are
        // moves between the user's own accounts, so they are kept out of the
        // income/spending totals but stay visible in the ledger.
        "不计收支" | "/" | "-" | "" => Some("transfer"),
        _ => None,
    }
}

/// `¥1,234.50` / `1234.50` → 123450 cents.
pub fn parse_amount_cents(raw: &str) -> Option<i64> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let value: f64 = cleaned.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    // Round, not truncate: 0.1 + 0.2 style drift must not eat a cent.
    Some((value * 100.0).round() as i64)
}

/// A row that never moved money: cancelled, failed or revoked. Refunds are
/// **not** in this group — they are kept and linked to the purchase they reverse.
fn status_is_closed(raw: &str) -> bool {
    let s = raw.trim();
    s.contains("交易关闭")
        || s.contains("已关闭")
        || s.contains("失败")
        || s.contains("已撤销")
        || s.contains("已取消")
}

/// Money came back against an earlier payment.
fn status_is_refund(raw: &str) -> bool {
    let s = raw.trim();
    s.contains("退款") || s.contains("已退还")
}

/// Keyword → category. Deliberately small and predictable; the user can always
/// re-file a row, and a wrong guess is worse than a generic one.
/// Longest matching rule wins; returns `None` when nothing matches.
pub fn match_rule<'a>(rules: &'a [Rule], text: &str) -> Option<&'a Rule> {
    match_rule_for(rules, &[], text, "")
}

/// Effective direction of a category path: its own kind, else its group's.
pub fn category_kind(categories: &[CategoryDef], path: &str) -> String {
    let direct = categories
        .iter()
        .find(|c| c.path() == path)
        .map(|c| c.kind.clone())
        .unwrap_or_default();
    if !direct.is_empty() {
        return direct;
    }
    match path.split_once('/') {
        Some((group, _)) => categories
            .iter()
            .find(|c| c.name == group && c.parent.is_empty())
            .map(|c| c.kind.clone())
            .unwrap_or_default(),
        None => String::new(),
    }
}

/// Longest matching rule that is allowed for this direction.
///
/// An income row must not land in an expense category — "超爱喝茶" is a shop, but
/// as an incoming transfer it is not shopping. Neutral categories match either
/// way; an empty `kind` means "no direction known", which allows everything.
pub fn match_rule_for<'a>(
    rules: &'a [Rule],
    categories: &[CategoryDef],
    text: &str,
    kind: &str,
) -> Option<&'a Rule> {
    let haystack = text.to_lowercase();
    rules
        .iter()
        .filter(|rule| {
            if rule.pattern.is_empty() || rule.category.is_empty() {
                return false;
            }
            if !haystack.contains(&rule.pattern.to_lowercase()) {
                return false;
            }
            // Transfers and unknown kinds are not directional.
            if kind != "expense" && kind != "income" {
                return true;
            }
            let target = category_kind(categories, &rule.category);
            target.is_empty() || target == kind
        })
        .max_by_key(|rule| rule.pattern.chars().count())
}

pub fn guess_category(text: &str, kind: &str, platform_hint: &str) -> String {
    // The platform's own classification is a better signal than keywords when
    // it maps onto one of ours (Alipay writes 交通出行, 餐饮美食 …).
    let hinted = match platform_hint.trim() {
        h if h.contains("交通") => Some("交通"),
        h if h.contains("餐饮") || h.contains("美食") => Some("餐饮"),
        h if h.contains("购物") || h.contains("日用") => Some("购物"),
        h if h.contains("居住") || h.contains("生活") => Some("居住"),
        h if h.contains("娱乐") || h.contains("文化") => Some("娱乐"),
        h if h.contains("医疗") || h.contains("健康") => Some("医疗"),
        h if h.contains("教育") || h.contains("学习") => Some("教育"),
        h if h.contains("通讯") || h.contains("通信") => Some("通讯"),
        h if h.contains("转账") || h.contains("红包") || h.contains("人情") => Some("人情"),
        h if h.contains("美容") => Some("其他"),
        _ => None,
    };
    if let Some(category) = hinted {
        return category.to_string();
    }
    let t = text;
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    if kind == "income" {
        if has(&["工资", "薪资", "代发", "劳务"]) {
            return "工资".into();
        }
        if has(&["退款", "报销", "红包", "转入"]) {
            return "其他".into();
        }
        if has(&["利息", "基金", "理财", "收益", "余额宝"]) {
            return "理财".into();
        }
    }
    // Past this point every branch names an expense category, which an income
    // row must never take.
    if kind == "income" {
        return "其他".into();
    }
    if has(&[
        "餐", "饭", "美食", "咖啡", "coffee", "luckin", "奶茶", "星巴克", "麦当劳", "肯德基",
        "外卖", "饿了么", "美团", "小吃", "烧烤", "火锅", "茶", "饼", "堂食", "面馆",
    ]) {
        return "餐饮".into();
    }
    if has(&[
        "地铁", "公交", "出租", "滴滴", "高铁", "火车", "机票", "航空", "加油", "停车",
        "充电", "通行费", "高速", "先乘后付", "打车", "ETC",
    ]) {
        return "交通".into();
    }
    if has(&["淘宝", "天猫", "京东", "拼多多", "超市", "便利店", "商场", "购物", "小米", "苹果", "商店"]) {
        return "购物".into();
    }
    if has(&["房租", "水费", "电费", "燃气", "物业", "宽带", "话费", "通讯"]) {
        return if has(&["话费", "宽带", "通讯"]) { "通讯".into() } else { "居住".into() };
    }
    if has(&["电影", "游戏", "视频", "音乐", "会员", "Steam", "演出", "门票", "景区", "Q币"]) {
        return "娱乐".into();
    }
    if has(&["医院", "药", "诊所", "体检", "医保"]) {
        return "医疗".into();
    }
    if has(&["学费", "培训", "课程", "书店", "图书", "教育"]) {
        return "教育".into();
    }
    if has(&["红包", "转账", "礼金", "份子"]) {
        return "人情".into();
    }
    "其他".into()
}

fn normalize_date(raw: &str) -> Option<String> {
    // A whole bill can arrive with Excel date serials instead of text: WeChat's
    // newer export stores 交易时间 as a number (`46348.4575…` = 2026-11-22
    // 10:58). Treating those as text made every row unparsable, and the import
    // then reported the entire file as skipped.
    if let Some(stamp) = excel_date_serial(raw) {
        return Some(stamp);
    }
    // WeChat: `2024-03-01 12:30:00`, Alipay: `2024-03-01 12:30:00` too, but be
    // tolerant of `2024/03/01` and `2024年03月01日`.
    let cleaned = raw.replace(['/', '年', '月'], "-").replace('日', "");
    let cleaned = cleaned.trim();
    let (date, time) = match cleaned.split_once(' ') {
        Some((d, t)) => (d, t),
        None => (cleaned, ""),
    };
    let parts: Vec<&str> = date.split('-').filter(|p| !p.is_empty()).collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let d: u32 = parts[2].parse().ok()?;
    let time = if time.len() >= 5 { &time[..5] } else { time };
    Some(format!("{y:04}-{m:02}-{d:02} {time}").trim().to_string())
}

/// `46348.45753472222` → `2026-11-22 10:58`.
///
/// Excel's 1900 date system counts days from 1899-12-30, with the time of day as
/// the fractional part. Only plausible serials are converted (roughly 1955 to
/// 2173) so an ordinary number — a year, a quantity — is never mistaken for a
/// date.
fn excel_date_serial(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty()
        || !text
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
        || text.matches('.').count() > 1
    {
        return None;
    }
    let value: f64 = text.replace(',', ".").parse().ok()?;
    if !value.is_finite() || !(20000.0..=100000.0).contains(&value) {
        return None;
    }
    let days = value.trunc() as i64;
    // Round to whole seconds first, then drop the seconds: 10:58:51 must not
    // round up to 10:59 and break same-minute duplicate detection.
    let seconds = ((value - value.trunc()) * 86400.0).round() as i64;
    let minutes = (seconds / 60).clamp(0, 1439);
    let date = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)? + chrono::Duration::days(days);
    Some(format!(
        "{} {:02}:{:02}",
        date.format("%Y-%m-%d"),
        minutes / 60,
        minutes % 60
    ))
}

fn split_datetime(stamp: &str) -> (String, String) {
    match stamp.split_once(' ') {
        Some((d, t)) => (d.to_string(), t.to_string()),
        None => (stamp.to_string(), String::new()),
    }
}

/// Result of parsing one bill file.
#[derive(Debug, Default)]
pub struct ParsedBill {
    pub source: String,
    pub entries: Vec<ParsedRow>,
    /// Rows present in the file but not imported (refunds, neutral, malformed).
    pub ignored: usize,
    pub detected: bool,
}

#[derive(Debug, Clone)]
pub struct ParsedRow {
    pub date: String,
    pub time: String,
    pub kind: String,
    pub amount: i64,
    pub category: String,
    pub account: String,
    pub counterparty: String,
    pub note: String,
    pub external_id: String,
    /// The row *is* the original purchase, now reversed: the refund belongs to
    /// this row itself.
    pub self_refunded: bool,
    /// The row is money coming back and needs matching to an earlier purchase.
    pub refund_incoming: bool,
    /// Counterparty + product + note + platform label, for rule matching.
    pub haystack: String,
    /// The platform's own classification, used as a last resort.
    pub hint: String,
    /// Amount returned against this row, when the export provides it.
    pub refunded_amount: i64,
}

/// Split plain text into CSV rows, respecting quoted fields that contain
/// commas. Blank lines and the `----------` rules are dropped.
pub fn csv_rows(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty())
        .map(split_csv)
        .filter(|row| !row.is_empty())
        .collect()
}

/// Read the first worksheet of an .xlsx workbook into string rows.
fn xlsx_rows(bytes: &[u8]) -> Option<Vec<Vec<String>>> {
    use calamine::{Data, Reader};
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut workbook =
        calamine::open_workbook_from_rs::<calamine::Xlsx<_>, _>(cursor).ok()?;
    let sheet_name = workbook.sheet_names().first()?.clone();
    let range = workbook.worksheet_range(&sheet_name).ok()?;
    let mut rows = Vec::new();
    for row in range.rows() {
        let cells: Vec<String> = row
            .iter()
            .map(|cell| match cell {
                Data::Empty => String::new(),
                Data::String(text) => text.trim().to_string(),
                Data::Float(value) => {
                    // Excel stores dates as serials; only plain numbers matter
                    // here (amounts arrive as text like "¥15.00").
                    if value.fract() == 0.0 {
                        format!("{value:.0}")
                    } else {
                        format!("{value}")
                    }
                }
                Data::Int(value) => value.to_string(),
                Data::Bool(value) => value.to_string(),
                other => other.to_string(),
            })
            .collect();
        rows.push(cells);
    }
    Some(rows)
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

/// Parse a bill of either format. WeChat ships `.xlsx`; Alipay ships `.csv`
/// (GBK). The extension is not trusted — the bytes decide.
pub fn parse_bill(bytes: &[u8]) -> ParsedBill {
    parse_bill_as(bytes, None)
}

/// Parse a bill, optionally forcing which platform it came from.
///
/// Auto-detection reads the header names, which fails for exports whose header
/// row lost a marker column, and for files that were re-saved by another tool.
/// The import UI therefore lets the user name the source; this is where that
/// choice is applied. A forced source also unblocks parsing when detection
/// found nothing, because the column layout is otherwise the same.
pub fn parse_bill_as(bytes: &[u8], forced: Option<&str>) -> ParsedBill {
    let forced = forced.map(str::trim).filter(|value| !value.is_empty());
    if is_zip(bytes) {
        if let Some(rows) = xlsx_rows(bytes) {
            let bill = parse_rows_as(rows, forced);
            if bill.detected {
                return bill;
            }
        }
        return ParsedBill::default();
    }
    parse_rows_as(csv_rows(&decode(bytes)), forced)
}

/// Column positions resolved from the header row by name. Both platforms have
/// shipped more than one layout, so nothing is looked up by position.
#[derive(Debug, Default, Clone)]
pub struct ColumnIndex {
    date: usize,
    paid_at: usize,
    kind: usize,
    amount: usize,
    account: usize,
    counterparty: usize,
    product: usize,
    note: usize,
    status: usize,
    external_id: usize,
    category_hint: usize,
}

impl ColumnIndex {
    /// An absent column reads as an empty string rather than panicking.
    fn get<'a>(&self, cols: &'a [String], index: usize) -> &'a str {
        if index == usize::MAX {
            return "";
        }
        cols.get(index).map(|s| s.as_str()).unwrap_or("")
    }

    fn find(cols: &[String], needles: &[&str]) -> usize {
        cols.iter()
            .position(|c| needles.iter().any(|n| c.contains(n)))
            .unwrap_or(usize::MAX)
    }

    fn from_header(cols: &[String]) -> Self {
        Self {
            // WeChat exports 交易时间; the older Alipay export has 交易创建时间
            // and a separate 付款时间 that is the one we want.
            date: Self::find(cols, &["交易创建时间", "交易时间"]),
            paid_at: Self::find(cols, &["付款时间"]),
            kind: Self::find(cols, &["收/支"]),
            amount: Self::find(cols, &["金额"]),
            account: Self::find(cols, &["收/付款方式", "支付方式"]),
            counterparty: Self::find(cols, &["交易对方"]),
            product: Self::find(cols, &["商品名称", "商品说明", "商品"]),
            note: Self::find(cols, &["备注"]),
            status: Self::find(cols, &["当前状态", "交易状态"]),
            external_id: Self::find(cols, &["交易单号", "交易订单号", "交易号"]),
            category_hint: Self::find(cols, &["交易分类", "交易类型"]),
        }
    }

    /// A header row has both a date-ish column and an amount column.
    fn is_header(cols: &[String]) -> bool {
        let idx = Self::from_header(cols);
        idx.date != usize::MAX && idx.amount != usize::MAX
    }
}

/// Which platform produced a set of rows, judged from the header names alone.
fn detect_source(header: &[String]) -> Option<&'static str> {
    let has = |needle: &str| header.iter().any(|c| c.contains(needle));
    if has("商户单号") || has("当前状态") || has("微信") {
        return Some("wechat");
    }
    if has("交易订单号") || has("收/付款方式") || has("交易分类") || has("对方账号") || has("交易号") {
        return Some("alipay");
    }
    if has("支付方式") {
        return Some("wechat");
    }
    None
}

/// iCost exports a workbook with 日期/类型/金额/一级分类/二级分类/账户1/账户2.
/// Its own categories are retained as a two-level path, so importing does not
/// throw away the user's existing bookkeeping taxonomy.
fn parse_icost(rows: Vec<Vec<String>>) -> ParsedBill {
    let mut bill = ParsedBill { source: "icost".into(), detected: true, ..ParsedBill::default() };
    let header = &rows[0];
    let find = |name: &str| header.iter().position(|c| c == name).unwrap_or(usize::MAX);
    let get = |row: &[String], index: usize| {
        if index == usize::MAX { String::new() } else { row.get(index).cloned().unwrap_or_default() }
    };
    let date_idx = find("日期");
    let kind_idx = find("类型");
    let amount_idx = find("金额");
    let group_idx = find("一级分类");
    let leaf_idx = find("二级分类");
    let account_idx = find("账户1");
    let note_idx = find("备注");
    let refund_idx = find("退款");
    for row in rows.iter().skip(1) {
        let Some(kind) = parse_kind(&get(row, kind_idx)) else {
            bill.ignored += 1;
            continue;
        };
        let Some(stamp) = normalize_date(&get(row, date_idx)) else {
            bill.ignored += 1;
            continue;
        };
        let Some(amount) = parse_amount_cents(&get(row, amount_idx)) else {
            bill.ignored += 1;
            continue;
        };
        if amount == 0 {
            bill.ignored += 1;
            continue;
        }
        let group = get(row, group_idx);
        let leaf = get(row, leaf_idx);
        let category = if !leaf.is_empty() && !group.is_empty() {
            format!("{group}/{leaf}")
        } else if !group.is_empty() { group.clone() } else { "其他".into() };
        let note = get(row, note_idx);
        let counterparty = note.clone();
        let refund = get(row, refund_idx);
        let refunded_amount = parse_amount_cents(&refund).unwrap_or(0).abs();
        let self_refunded = kind == "expense" && refunded_amount > 0;
        let (date, time) = split_datetime(&stamp);
        bill.entries.push(ParsedRow {
            date: date.clone(),
            time: time.clone(),
            kind: kind.into(),
            amount: amount.abs(),
            category: category.clone(),
            account: get(row, account_idx),
            counterparty: counterparty.clone(),
            note,
            external_id: format!("icost:{}", row.join("\u{1f}")),
            self_refunded,
            refund_incoming: false,
            refunded_amount,
            haystack: format!("{} {}", counterparty, group),
            hint: String::new(),
        });
    }
    bill
}

/// Rows → entries. Shared by the CSV and XLSX readers so both formats behave
/// identically once the cells are strings.
pub fn parse_rows(rows: Vec<Vec<String>>) -> ParsedBill {
    parse_rows_as(rows, None)
}

/// `parse_rows`, with the platform either detected or dictated by the user.
pub fn parse_rows_as(rows: Vec<Vec<String>>, forced: Option<&str>) -> ParsedBill {
    // iCost has its own layout (a header row of 日期/类型/金额/一级分类…), so it
    // is recognized by its columns. When the user forces iCost, find that header
    // instead of assuming it is row 1 — exports are often re-saved with a title.
    let icost_layout = |row: &Vec<String>| {
        row.iter().any(|c| c == "一级分类") && row.iter().any(|c| c == "二级分类")
    };
    if rows.first().map(icost_layout) == Some(true) {
        return parse_icost(rows);
    }
    if forced == Some("icost") {
        if let Some(index) = rows.iter().position(icost_layout) {
            return parse_icost(rows[index..].to_vec());
        }
    }
    let mut bill = ParsedBill::default();
    let Some((header_index, header)) = rows
        .iter()
        .enumerate()
        .find(|(_, row)| ColumnIndex::is_header(row))
    else {
        return bill;
    };
    let Some(source) = forced.or_else(|| detect_source(header)) else {
        return bill;
    };
    bill.source = source.to_string();
    bill.detected = true;
    let idx = ColumnIndex::from_header(header);

    for row in rows.iter().skip(header_index + 1) {
        if row.len() < 4 {
            continue;
        }
        let kind_raw = idx.get(row, idx.kind);
        // The merchant/product text decides whether a "neutral" row is actually
        // earnings, so it has to be read before the direction is settled.
        let counterparty = clean_cell(idx.get(row, idx.counterparty));
        let product = clean_cell(idx.get(row, idx.product));
        let note = clean_cell(idx.get(row, idx.note));
        let hint = clean_cell(idx.get(row, idx.category_hint));
        let haystack = format!("{counterparty} {product} {note} {hint}");
        // `/` is WeChat's marker for a neutral move (top-up, withdrawal,
        // wealth product). It is real money movement worth keeping, but it is
        // neither income nor spending — except fund earnings, which are income
        // that Alipay and WeChat both file as a neutral move.
        let Some(kind) = parse_kind(kind_raw).map(|kind| {
            if kind == "transfer" && is_fund_earning(&haystack) {
                "income"
            } else {
                kind
            }
        }) else {
            bill.ignored += 1;
            continue;
        };
        let status = idx.get(row, idx.status);
        if status_is_closed(status) {
            bill.ignored += 1;
            continue;
        }
        let refunded = status_is_refund(status);
        let Some(amount) = parse_amount_cents(idx.get(row, idx.amount)) else {
            bill.ignored += 1;
            continue;
        };
        if amount == 0 {
            bill.ignored += 1;
            continue;
        }
        let paid = idx.get(row, idx.paid_at);
        let raw_stamp = if paid.trim().is_empty() {
            idx.get(row, idx.date)
        } else {
            paid
        };
        let Some(normalized) = normalize_date(raw_stamp) else {
            bill.ignored += 1;
            continue;
        };
        let (date, time) = split_datetime(&normalized);
        bill.entries.push(ParsedRow {
            date,
            time,
            kind: kind.to_string(),
            amount,
            category: String::new(),
            haystack,
            hint,
            account: clean_cell(idx.get(row, idx.account)),
            counterparty,
            note: if product.is_empty() {
                note
            } else {
                format!("{product} {note}").trim().to_string()
            },
            external_id: clean_cell(idx.get(row, idx.external_id)),
            // WeChat rewrites the original purchase row's status when it is
            // reversed; Alipay adds a separate neutral refund row.
            self_refunded: refunded && kind == "expense",
            refund_incoming: refunded && kind != "expense",
            refunded_amount: 0,
        });
    }
    bill
}

/// `/` in a cell means "nothing here" in both exports; tabs trail some IDs.
fn clean_cell(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('\t').trim();
    if trimmed == "/" || trimmed == "-" {
        String::new()
    } else {
        trimmed.trim_matches('\t').trim().to_string()
    }
}

/// Fund earnings are income, even though the platform files them as a neutral
/// move: 余额宝 / 零钱通 / 理财通 pay them as a "收益发放" row with 收/支 = 不计收支.
///
/// Transfers in and out are deliberately **not** matched — the principal only
/// changes pocket, and counting it as income would double the real salary and
/// spending numbers the app already tracks.
fn is_fund_earning(text: &str) -> bool {
    let fund = text.contains("余额宝")
        || text.contains("零钱通")
        || text.contains("理财通")
        || text.contains("基金");
    fund && (text.contains("收益") || text.contains("分红") || text.contains("发放"))
}

/// Ledger held in memory by the app and mirrored to `ledger.json`.
pub struct LedgerState {
    pub ledger: std::sync::Mutex<Ledger>,
    pub dir: PathBuf,
    /// 每次成功落盘 +1。自动上行拿它当「本地到底动了没有」的判据：
    /// 没动就一个字节都不序列化，动了才去算指纹。
    rev: std::sync::atomic::AtomicU64,
    /// 最近一次自己写出去的内容指纹。文件监听器比一下就知道这次改动是不是自己写的。
    saved: std::sync::atomic::AtomicU64,
    /// 账本窗口盖过的章：它已经把这批内容画出来了。
    ack: std::sync::atomic::AtomicU64,
}

impl LedgerState {
    pub fn new(dir: PathBuf) -> Self {
        let (mut ledger, upgraded) = load_with_status(&dir);
        ledger.normalize();
        if upgraded {
            // Write the migrated tree straight away, so a crash before the next
            // edit cannot leave the ledger half-upgraded.
            let _ = save(&dir, &ledger);
        }
        Self {
            ledger: std::sync::Mutex::new(ledger),
            dir,
            rev: std::sync::atomic::AtomicU64::new(0),
            saved: std::sync::atomic::AtomicU64::new(0),
            ack: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn snapshot(&self) -> Ledger {
        self.ledger.lock().unwrap().clone()
    }

    /// 本地账本被改过多少次。只增不减，只用来比「有没有变」。
    pub fn revision(&self) -> u64 {
        self.rev.load(std::sync::atomic::Ordering::Acquire)
    }

    /// 自己最后一次写出去的内容指纹；0 表示还没写过。
    pub fn last_saved(&self) -> u64 {
        self.saved.load(std::sync::atomic::Ordering::Acquire)
    }

    /// 账本窗口说「这批内容我已经画出来了」。
    pub fn acknowledge(&self) {
        self.ack
            .store(self.last_saved(), std::sync::atomic::Ordering::Release);
    }

    /// 盘上这份内容要不要推给窗口。
    ///
    /// 自己点保存的那条路，命令的返回值已经把新账本交给窗口了，窗口随后盖章；
    /// 盖过章就不必再把几 MB 的 JSON 解析一遍、推一遍、整页重渲染一遍。
    /// 没盖章说明是别的窗口（设置页改分类、规则）写的、或者同步从云端换下来的，
    /// 那就得推。
    pub fn needs_broadcast(&self, file_hash: u64) -> bool {
        let saved = self.last_saved();
        if saved == 0 || file_hash != saved {
            return true;
        }
        saved != self.ack.load(std::sync::atomic::Ordering::Acquire)
    }

    fn persist(&self, ledger: &Ledger) -> Result<(), String> {
        let hash = save(&self.dir, ledger)?;
        self.saved.store(hash, std::sync::atomic::Ordering::Release);
        self.rev.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Ok(())
    }

    /// 整份换掉：同步把云端那份合并下来时用。
    ///
    /// 只写盘是不够的——内存里那份不跟着换，下一次编辑就会拿旧的覆盖回去，
    /// 刚同步进来的账全没了。所以落盘成功之后立刻换内存。
    ///
    /// 记的指纹清成 0：这份内容是从云端来的，界面还没见过，文件监听器得照常
    /// 通知窗口刷新。（自己点保存的那条路走 `persist`，窗口本来就拿到了新账本。）
    pub fn replace(&self, ledger: Ledger) -> Result<(), String> {
        save(&self.dir, &ledger)?;
        *self.ledger.lock().unwrap() = ledger;
        self.saved.store(0, std::sync::atomic::Ordering::Release);
        self.rev.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Ok(())
    }
}

fn now_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Fields the UI may send when creating or editing a row.
/// A manual refund link, optionally sourced from an unmatched refund row.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundLinkInput {
    pub entry_id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub amount: i64,
    #[serde(default)]
    pub date: String,
}

/// Fields the UI may send when creating or editing a balance.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInput {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub institution: String,
    #[serde(default)]
    pub balance: i64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub date: String,
    #[serde(default)]
    pub time: String,
    pub kind: String,
    pub amount: i64,
    pub category: String,
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub counterparty: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub excluded: bool,
}

impl LedgerState {
    pub fn add(&self, input: EntryInput) -> Result<Ledger, String> {
        if input.date.trim().is_empty() {
            return Err("missing-date".into());
        }
        if input.amount <= 0 {
            return Err("missing-amount".into());
        }
        let mut ledger = self.ledger.lock().unwrap();
        let entry = Entry {
            id: uuid::Uuid::new_v4().to_string(),
            date: input.date.clone(),
            time: input.time.clone(),
            kind: if input.kind.is_empty() { "expense".into() } else { input.kind },
            amount: input.amount,
            category: if input.category.is_empty() { "其他".into() } else { input.category },
            account: input.account,
            counterparty: input.counterparty,
            note: input.note,
            source: "manual".into(),
            external_id: String::new(),
            excluded: input.excluded,
            archived: false,
            refunded_amount: 0,
            refunded_at: String::new(),
            category_locked: true,
            project_id: String::new(),
            created_at: now_stamp(),
        };
        // New categories and accounts are learned from manual entry.
        learn_category(&mut ledger.categories, &entry.category);
        if !entry.account.is_empty() && !ledger.accounts.iter().any(|a| a == &entry.account) {
            ledger.accounts.push(entry.account.clone());
        }
        ledger.entries.push(entry);
        ledger.sort();
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn update(&self, id: &str, input: EntryInput) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let Some(entry) = ledger.entries.iter_mut().find(|e| e.id == id) else {
            return Err("missing-entry".into());
        };
        if !input.date.trim().is_empty() {
            entry.date = input.date;
        }
        entry.time = input.time;
        if !input.kind.is_empty() {
            entry.kind = input.kind;
        }
        if input.amount > 0 {
            entry.amount = input.amount;
        }
        if !input.category.is_empty() {
            entry.category = input.category.clone();
            entry.category_locked = true;
        }
        entry.account = input.account;
        entry.counterparty = input.counterparty;
        entry.note = input.note;
        entry.excluded = input.excluded;
        learn_category(&mut ledger.categories, &input.category);
        ledger.sort();
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn delete(&self, id: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let before = ledger.entries.len();
        ledger.entries.retain(|e| e.id != id);
        if ledger.entries.len() == before {
            return Err("missing-entry".into());
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Import a bill, skipping rows already present (same platform id, or the
    /// same date+amount+counterparty when the export has no id).
    pub fn import(&self, file: &str, bytes: &[u8]) -> Result<ImportOutcome, String> {
        self.import_as(file, bytes, None)
    }

    /// Parse a bill without touching the ledger, so the import dialog can show
    /// what would happen — row count, date range, samples, how many duplicates —
    /// and the user decides whether to commit.
    pub fn preview_import(
        &self,
        bytes: &[u8],
        forced: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let bill = parse_bill_as(bytes, forced);
        if !bill.detected {
            return Err("unrecognised-bill".into());
        }
        let ledger = self.ledger.lock().unwrap();
        // The same key the importer dedupes on, so the count matches the real run.
        let seen: std::collections::HashSet<String> = ledger
            .entries
            .iter()
            .map(|e| duplicate_key(&e.source, &e.external_id, &e.date, e.amount, &e.counterparty))
            .collect();
        let mut duplicates = 0usize;
        let mut fresh_keys = std::collections::HashSet::new();
        let mut dates: Vec<&str> = Vec::new();
        let mut sample = Vec::new();
        let mut expense = 0i64;
        let mut income = 0i64;
        for row in &bill.entries {
            let key = duplicate_key(&bill.source, &row.external_id, &row.date, row.amount, &row.counterparty);
            if seen.contains(&key) || !fresh_keys.insert(key) {
                duplicates += 1;
                continue;
            }
            if row.kind == "expense" {
                expense += row.amount;
            } else if row.kind == "income" {
                income += row.amount;
            }
            if !row.date.is_empty() {
                dates.push(row.date.as_str());
            }
            if sample.len() < 6 {
                sample.push(serde_json::json!({
                    "date": row.date,
                    "time": row.time,
                    "kind": row.kind,
                    "amount": row.amount,
                    "counterparty": row.counterparty,
                    "account": row.account,
                    "note": row.note,
                }));
            }
        }
        dates.sort_unstable();
        Ok(serde_json::json!({
            "source": bill.source,
            "rows": bill.entries.len(),
            "duplicates": duplicates,
            "ignored": bill.ignored,
            "expense": expense,
            "income": income,
            "firstDate": dates.first().copied().unwrap_or_default(),
            "lastDate": dates.last().copied().unwrap_or_default(),
            "sample": sample,
        }))
    }

    /// Import with the platform either detected or chosen by the user.
    pub fn import_as(
        &self,
        file: &str,
        bytes: &[u8],
        forced: Option<&str>,
    ) -> Result<ImportOutcome, String> {
        let bill = parse_bill_as(bytes, forced);
        if !bill.detected {
            return Err("unrecognised-bill".into());
        }
        let mut ledger = self.ledger.lock().unwrap();
        let mut seen: std::collections::HashSet<String> = ledger
            .entries
            .iter()
            .map(|e| duplicate_key(&e.source, &e.external_id, &e.date, e.amount, &e.counterparty))
            .collect();
        let mut added = 0usize;
        let mut new_ids: Vec<String> = Vec::new();
        let mut duplicates = 0usize;
        let mut refunds_linked = 0usize;

        // Refund rows are collected first so that a refund appearing earlier in
        // the file than its purchase still finds it, then linked in one pass.
        let mut pending_refunds: Vec<ParsedRow> = Vec::new();

        for row in bill.entries {
            let key = duplicate_key(&bill.source, &row.external_id, &row.date, row.amount, &row.counterparty);
            if row.refund_incoming {
                if !seen.insert(key) {
                    duplicates += 1;
                } else {
                    pending_refunds.push(row);
                }
                continue;
            }
            if !seen.insert(key) {
                duplicates += 1;
                continue;
            }
            let refunded = if row.self_refunded {
                if row.refunded_amount > 0 { row.refunded_amount.min(row.amount) } else { row.amount }
            } else { 0 };
            let refunded_at = if row.self_refunded { row.date.clone() } else { String::new() };
            // Keep an imported label only when it already exists in the user's
            // tree. Unknown iCost labels fall back to rules/其他 instead of
            // creating dozens of one-off categories.
            let category = if bill.source == "icost" && !row.category.is_empty()
                && ledger.categories.iter().any(|c| c.path() == row.category)
            {
                row.category.clone()
            } else if bill.source == "icost" {
                match_rule_for(&ledger.rules, &ledger.categories, &row.haystack, &row.kind)
                    .map(|rule| rule.category.clone())
                    .unwrap_or_else(|| {
                        if row.kind == "income" || row.kind == "expense" { "其他".into() } else { "转账".into() }
                    })
            } else {
                match_rule_for(&ledger.rules, &ledger.categories, &row.haystack, &row.kind)
                    .map(|rule| rule.category.clone())
                    .unwrap_or_else(|| guess_category(&row.haystack, &row.kind, &row.hint))
            };
            let id = uuid::Uuid::new_v4().to_string();
            new_ids.push(id.clone());
            ledger.entries.push(Entry {
                id,
                date: row.date,
                time: row.time,
                kind: row.kind,
                amount: row.amount,
                category,
                account: row.account,
                counterparty: row.counterparty,
                note: row.note,
                source: bill.source.clone(),
                external_id: row.external_id,
                excluded: false,
                archived: false,
                refunded_amount: refunded,
                refunded_at,
                // An import guess is exactly what re-labelling is for.
                category_locked: false,
                project_id: String::new(),
                created_at: now_stamp(),
            });
            added += 1;
        }

        for refund in pending_refunds {
            match find_refund_target(&mut ledger.entries, &bill.source, &refund) {
                Some(entry) => {
                    entry.refunded_amount = (entry.refunded_amount + refund.amount).min(entry.amount);
                    entry.refunded_at = refund.date.clone();
                    refunds_linked += 1;
                }
                None => {
                    // No purchase could be identified. Keep the movement visible
                    // but out of the totals rather than inventing a match.
                    ledger.entries.push(Entry {
                        id: uuid::Uuid::new_v4().to_string(),
                        date: refund.date,
                        time: refund.time,
                        kind: "transfer".into(),
                        amount: refund.amount,
                        category: refund.category,
                        account: refund.account,
                        counterparty: refund.counterparty,
                        note: refund.note,
                        source: bill.source.clone(),
                        external_id: refund.external_id,
                        excluded: true,
                        archived: false,
                        refunded_amount: 0,
                        refunded_at: String::new(),
                        category_locked: false,
                        project_id: String::new(),
                        created_at: now_stamp(),
                    });
                    added += 1;
                }
            }
        }
        ledger.sort();
        // Imported rows can introduce labels that are not in the tree yet.
        let learned: Vec<String> = ledger
            .entries
            .iter()
            .map(|e| e.category.clone())
            .collect();
        for path in learned {
            learn_category(&mut ledger.categories, &path);
        }
        ledger.imports.insert(0, ImportRecord {
            id: uuid::Uuid::new_v4().to_string(),
            file: file.to_string(),
            source: bill.source.clone(),
            added,
            skipped: duplicates + bill.ignored,
            imported_at: now_stamp(),
        });
        ledger.imports.truncate(20);
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(ImportOutcome {
            ledger: snapshot,
            new_ids,
            added,
            duplicates,
            ignored: bill.ignored,
            refunds_linked,
            source: bill.source,
        })
    }

    /// Apply AI suggestions to freshly imported rows without locking them:
    /// these are still machine decisions and can be revisited later.
    pub fn apply_ai_suggestions(&self, suggestions: &[(String, String)]) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        for entry in ledger.entries.iter_mut() {
            if let Some((_, category)) = suggestions.iter().find(|(id, _)| id == &entry.id) {
                entry.category = category.clone();
                entry.category_locked = false;
            }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Attach a refund to a purchase by hand.
    ///
    /// `source_id` names an existing unmatched refund row: its amount and date
    /// are used and the row disappears, because the money is now represented by
    /// the purchase's refunded amount. Without `source_id` the caller supplies
    /// the figures directly. A zero amount clears the link.
    pub fn link_refund(&self, input: RefundLinkInput) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let source = input.source_id.as_deref().and_then(|id| {
            ledger
                .entries
                .iter()
                .find(|e| e.id == id)
                .map(|e| (e.amount, e.date.clone(), e.id.clone()))
        });
        let amount = source.as_ref().map(|(a, _, _)| *a).unwrap_or(input.amount);
        let date = source
            .as_ref()
            .map(|(_, d, _)| d.clone())
            .unwrap_or(input.date.clone());
        let Some(entry) = ledger.entries.iter_mut().find(|e| e.id == input.entry_id) else {
            return Err("missing-entry".into());
        };
        if entry.kind != "expense" {
            return Err("not-an-expense".into());
        }
        if amount <= 0 {
            entry.refunded_amount = 0;
            entry.refunded_at = String::new();
        } else {
            entry.refunded_amount = (entry.refunded_amount + amount).min(entry.amount);
            entry.refunded_at = date;
        }
        if let Some((_, _, id)) = source {
            ledger.entries.retain(|e| e.id != id);
        }
        ledger.sort();
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Remove the given rows, keeping one. Used by the duplicate cleaner.
    pub fn merge_entries(&self, keep: &str, remove: &[String]) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        if !ledger.entries.iter().any(|e| e.id == keep) {
            return Err("missing-entry".into());
        }
        ledger
            .entries
            .retain(|e| e.id == keep || !remove.iter().any(|id| id == &e.id));
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Keep rows visible but out of the totals — what a credit-card or 花呗
    /// repayment should be, since the purchases it settles are already counted.
    pub fn set_excluded(&self, ids: Vec<String>, excluded: bool) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        for entry in ledger.entries.iter_mut() {
            if ids.iter().any(|id| id == &entry.id) {
                entry.excluded = excluded;
            }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Move rows in or out of the archive. Nothing is deleted: an archived row
    /// keeps every field, stops counting toward totals and stays out of the
    /// everyday lists until it is restored.
    pub fn set_archived(&self, ids: Vec<String>, archived: bool) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        for entry in ledger.entries.iter_mut() {
            if ids.iter().any(|id| id == &entry.id) {
                entry.archived = archived;
            }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// The findings behind the 整理账单 page: duplicate clusters that are still
    /// live, pay-later/repayment rows that still count as spending, and how many
    /// findings the user already dismissed.
    ///
    /// Shared by the GUI command and `stockpot cli cleanup.report`, so an agent
    /// tidying the books sees exactly what the page shows.
    pub fn cleanup_report(&self) -> serde_json::Value {
        let ledger = self.snapshot();
        let duplicates: Vec<DuplicateGroup> = find_duplicates(&ledger.entries)
            .into_iter()
            .filter(|group| !ledger.ignored_duplicates.contains(&group.key))
            .collect();
        let repayments: Vec<&Entry> = ledger
            .entries
            .iter()
            .filter(|e| !e.excluded && !e.archived && is_repayment(e))
            .filter(|e| !ledger.ignored_repayments.contains(&e.id))
            .collect();
        serde_json::json!({
            "duplicates": duplicates,
            "repayments": repayments,
            "total": ledger.entries.len(),
            "ignored": ledger.ignored_duplicates.len() + ledger.ignored_repayments.len(),
        })
    }

    /// Resolve every duplicate cluster in one click: keep the row that carries
    /// the most information and archive the rest.
    ///
    /// "Most information" is deliberately mechanical so the result is
    /// predictable: a hand-set category, an account, a note or counterparty, a
    /// project, a linked refund and a platform transaction id all count, and the
    /// earliest import wins ties (it is the row the later copies were imported
    /// over). Nothing is deleted — the archived rows can be restored, and
    /// because `find_duplicates` skips archived rows the clusters disappear
    /// without having to record them as ignored.
    pub fn auto_tidy(&self) -> Result<AutoTidyOutcome, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let mut groups = find_duplicates(&ledger.entries);
        groups.retain(|group| !ledger.ignored_duplicates.contains(&group.key));

        let mut archived = 0usize;
        let mut kept: Vec<String> = Vec::new();
        let mut archived_ids: Vec<String> = Vec::new();
        for group in &groups {
            // `find_duplicates` returns clones, so the group is stable even
            // while the ledger below is being mutated.
            let Some(best) = group
                .entries
                .iter()
                .max_by(|a, b| tidy_rank(a).cmp(&tidy_rank(b)))
            else {
                continue;
            };
            kept.push(best.id.clone());
            for entry in group.entries.iter() {
                if entry.id == best.id {
                    continue;
                }
                if let Some(row) = ledger.entries.iter_mut().find(|row| row.id == entry.id) {
                    if !row.archived {
                        row.archived = true;
                        archived += 1;
                        archived_ids.push(row.id.clone());
                    }
                }
            }
        }
        ledger.sort();
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(AutoTidyOutcome {
            ledger: snapshot,
            groups: groups.len(),
            archived,
            kept,
            archived_ids,
        })
    }

    pub fn add_wallet(&self, input: WalletInput) -> Result<Ledger, String> {
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err("missing-name".into());
        }
        let mut ledger = self.ledger.lock().unwrap();
        ledger.wallets.push(Wallet {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            kind: if input.kind.is_empty() { "other".into() } else { input.kind },
            institution: input.institution,
            balance: input.balance,
            note: input.note,
            updated_at: now_stamp(),
        });
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn update_wallet(&self, id: &str, input: WalletInput) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let Some(wallet) = ledger.wallets.iter_mut().find(|w| w.id == id) else {
            return Err("missing-wallet".into());
        };
        if !input.name.trim().is_empty() {
            wallet.name = input.name.trim().to_string();
        }
        if !input.kind.is_empty() {
            wallet.kind = input.kind;
        }
        wallet.institution = input.institution;
        wallet.balance = input.balance;
        wallet.note = input.note;
        wallet.updated_at = now_stamp();
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn delete_wallet(&self, id: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let before = ledger.wallets.len();
        ledger.wallets.retain(|w| w.id != id);
        if ledger.wallets.len() == before {
            return Err("missing-wallet".into());
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Hide a duplicate group or a repayment row from the tidy-up page. Nothing
    /// is deleted: it is an "I looked at this and it is fine" record.
    pub fn ignore_cleanup(&self, kind: &str, key: &str, ignored: bool) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let list = match kind {
            "duplicate" => &mut ledger.ignored_duplicates,
            "repayment" => &mut ledger.ignored_repayments,
            _ => return Err("bad-kind".into()),
        };
        if ignored {
            if !list.iter().any(|entry| entry == key) {
                list.push(key.to_string());
            }
        } else {
            list.retain(|entry| entry != key);
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Bring every dismissed finding back.
    pub fn restore_ignored(&self) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        ledger.ignored_duplicates.clear();
        ledger.ignored_repayments.clear();
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn add_rule(&self, pattern: &str, category: &str) -> Result<Ledger, String> {
        let pattern = pattern.trim();
        if pattern.is_empty() || category.trim().is_empty() {
            return Err("missing-name".into());
        }
        let mut ledger = self.ledger.lock().unwrap();
        if ledger
            .rules
            .iter()
            .any(|r| r.pattern.eq_ignore_ascii_case(pattern))
        {
            return Err("duplicate".into());
        }
        ledger.rules.push(Rule {
            id: uuid::Uuid::new_v4().to_string(),
            pattern: pattern.to_string(),
            category: category.trim().to_string(),
        });
        learn_category(&mut ledger.categories, category);
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn update_rule(&self, id: &str, pattern: &str, category: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let Some(rule) = ledger.rules.iter_mut().find(|r| r.id == id) else {
            return Err("missing-rule".into());
        };
        if !pattern.trim().is_empty() {
            rule.pattern = pattern.trim().to_string();
        }
        if !category.trim().is_empty() {
            rule.category = category.trim().to_string();
        }
        learn_category(&mut ledger.categories, category);
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn delete_rule(&self, id: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let before = ledger.rules.len();
        ledger.rules.retain(|r| r.id != id);
        if ledger.rules.len() == before {
            return Err("missing-rule".into());
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Re-file every unlocked row using the current rules. Cheap and
    /// deterministic — no model involved.
    pub fn apply_rules_to_all(&self) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let rules = ledger.rules.clone();
        let categories = ledger.categories.clone();
        let changed = refile_unlocked(&mut ledger.entries, &rules, &categories);
        if changed > 0 {
            let snapshot = ledger.clone();
            self.persist(&snapshot)?;
        }
        let snapshot = ledger.clone();
        Ok(snapshot)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_category(
        &self,
        name: &str,
        parent: &str,
        icon: &str,
        kind: &str,
        description: &str,
    ) -> Result<Ledger, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("missing-name".into());
        }
        let mut ledger = self.ledger.lock().unwrap();
        if ledger
            .categories
            .iter()
            .any(|c| c.name == name && c.parent == parent)
        {
            return Err("duplicate".into());
        }
        ledger.categories.push(CategoryDef {
            name: name.to_string(),
            parent: parent.to_string(),
            kind: kind.to_string(),
            icon: if icon.is_empty() { "dots".into() } else { icon.to_string() },
            description: description.trim().to_string(),
        });
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn delete_category(&self, path: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        // Rows keep their label; the category simply stops being offered. A
        // group takes its leaves with it.
        ledger.categories.retain(|c| {
            let own = c.path();
            own != path && c.parent != path
        });
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Restore the built-in category tree. Rows keep their labels; rules whose
    /// target disappeared are pointed at the neutral fallback.
    pub fn reset_categories(&self) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        ledger.categories = default_categories();
        let paths: Vec<String> = ledger.categories.iter().map(|c| c.path()).collect();
        for rule in ledger.rules.iter_mut() {
            if !paths.iter().any(|path| path == &rule.category) {
                rule.category = "其他".into();
            }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn add_project(&self, input: ProjectInput) -> Result<Ledger, String> {
        let name = input.name.trim();
        if name.is_empty() { return Err("missing-name".into()); }
        let mut ledger = self.ledger.lock().unwrap();
        ledger.projects.push(Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            note: input.note,
            start_date: input.start_date,
            end_date: input.end_date,
            archived: input.archived,
            created_at: now_stamp(),
        });
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn update_project(&self, id: &str, input: ProjectInput) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let Some(project) = ledger.projects.iter_mut().find(|p| p.id == id) else {
            return Err("missing-project".into());
        };
        if !input.name.trim().is_empty() { project.name = input.name.trim().into(); }
        project.note = input.note;
        project.start_date = input.start_date;
        project.end_date = input.end_date;
        project.archived = input.archived;
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn delete_project(&self, id: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let before = ledger.projects.len();
        ledger.projects.retain(|p| p.id != id);
        if ledger.projects.len() == before { return Err("missing-project".into()); }
        // Deleting a project must not delete any financial records.
        for entry in ledger.entries.iter_mut() {
            if entry.project_id == id { entry.project_id.clear(); }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Assign a project to several entries, or clear it with an empty id.
    pub fn set_project(&self, ids: Vec<String>, project_id: &str) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        if !project_id.is_empty() && !ledger.projects.iter().any(|p| p.id == project_id) {
            return Err("missing-project".into());
        }
        for entry in ledger.entries.iter_mut() {
            if ids.iter().any(|id| id == &entry.id) {
                entry.project_id = project_id.to_string();
            }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    pub fn clear(&self) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        ledger.entries.clear();
        ledger.imports.clear();
        // Balances are hand-maintained and independent of the transaction log.
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }
}

/// Find the purchase an incoming refund most likely reverses.
///
/// Both platforms only give us the amount and the date, so the rule is: same
/// platform, an expense that still has room for this refund, refund not before
/// the purchase, and within a 45-day window. Exact amount beats a partial one,
/// then the closest date wins.
fn find_refund_target<'a>(
    entries: &'a mut [Entry],
    source: &str,
    refund: &ParsedRow,
) -> Option<&'a mut Entry> {
    let refund_date = chrono::NaiveDate::parse_from_str(&refund.date, "%Y-%m-%d").ok()?;
    let mut best: Option<(usize, i64, i64)> = None; // (index, exact_rank, day_gap)
    for (index, entry) in entries.iter().enumerate() {
        if entry.source != source || entry.kind != "expense" || entry.excluded {
            continue;
        }
        let remaining = entry.amount - entry.refunded_amount;
        if remaining < refund.amount || remaining <= 0 {
            continue;
        }
        let Ok(entry_date) = chrono::NaiveDate::parse_from_str(&entry.date, "%Y-%m-%d") else {
            continue;
        };
        let days = (refund_date - entry_date).num_days();
        if !(0..=45).contains(&days) {
            continue;
        }
        // 0 = the refund covers the row exactly, 1 = partial.
        let exact = if remaining == refund.amount { 0 } else { 1 };
        let candidate = (index, exact, days);
        let better = match best {
            None => true,
            Some((_, best_exact, best_days)) => {
                exact < best_exact || (exact == best_exact && days < best_days)
            }
        };
        if better {
            best = Some(candidate);
        }
    }
    best.map(|(index, _, _)| &mut entries[index])
}

/// Register a category (or a `group/leaf` path) that the user typed, creating
/// any missing parent on the way.
fn learn_category(categories: &mut Vec<CategoryDef>, path: &str) {
    let path = path.trim();
    if path.is_empty() {
        return;
    }
    let (parent, leaf) = match path.split_once('/') {
        Some((p, l)) => (p.trim().to_string(), l.trim().to_string()),
        None => (String::new(), path.to_string()),
    };
    let exists = |cats: &Vec<CategoryDef>, parent: &str, leaf: &str| {
        cats.iter().any(|c| c.name == leaf && c.parent == parent)
    };
    if !parent.is_empty() && !exists(categories, "", &parent) {
        categories.push(CategoryDef {
            name: parent.clone(),
            parent: String::new(),
            kind: String::new(),
            icon: "dots".into(),
                description: String::new(),
        });
    }
    if !exists(categories, &parent, &leaf) {
        categories.push(CategoryDef {
            name: leaf,
            parent,
            kind: String::new(),
            icon: "dots".into(),
                description: String::new(),
        });
    }
}

/// Move a set of entries to another category — the bulk "re-classify" action.
impl LedgerState {
    pub fn recategorize(&self, ids: Vec<String>, category: &str) -> Result<Ledger, String> {
        let category = category.trim();
        if category.is_empty() {
            return Err("missing-category".into());
        }
        let mut ledger = self.ledger.lock().unwrap();
        for entry in ledger.entries.iter_mut() {
            if ids.iter().any(|id| id == &entry.id) {
                entry.category = category.to_string();
                // A human decision: stop the model from revisiting it.
                entry.category_locked = true;
            }
        }
        learn_category(&mut ledger.categories, category);
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }

    /// Change one category definition, including moving it under another group.
    #[allow(clippy::too_many_arguments)]
    pub fn update_category(
        &self,
        name: &str,
        parent: &str,
        new_name: &str,
        new_parent: &str,
        icon: &str,
        kind: &str,
        description: &str,
    ) -> Result<Ledger, String> {
        let mut ledger = self.ledger.lock().unwrap();
        let old_path = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        // 改名撞上已有分类就拒掉：两个同名同级分类会让手机端的列表 key 重复，
        // LazyColumn 一滑到第二条就抛 "Key was already used" 崩掉。
        let next_name = if new_name.trim().is_empty() { name } else { new_name.trim() };
        let next_path = if new_parent.is_empty() {
            next_name.to_string()
        } else {
            format!("{new_parent}/{next_name}")
        };
        if next_path != old_path
            && ledger
                .categories
                .iter()
                .any(|c| c.parent == new_parent && c.name == next_name)
        {
            return Err("duplicate".into());
        }

        let Some(def) = ledger
            .categories
            .iter_mut()
            .find(|c| c.name == name && c.parent == parent)
        else {
            return Err("missing-category".into());
        };
        if !new_name.trim().is_empty() {
            def.name = new_name.trim().to_string();
        }
        def.parent = new_parent.to_string();
        if !icon.is_empty() {
            def.icon = icon.to_string();
        }
        if !kind.is_empty() {
            def.kind = kind.to_string();
        }
        def.description = description.trim().to_string();
        let new_path = def.path();
        if new_path != old_path {
            for entry in ledger.entries.iter_mut() {
                if entry.category == old_path {
                    entry.category = new_path.clone();
                } else if let Some(rest) = entry.category.strip_prefix(&format!("{old_path}/")) {
                    // A renamed group carries its leaves' paths with it.
                    entry.category = format!("{new_path}/{rest}");
                }
            }
            for child in ledger.categories.iter_mut() {
                if child.parent == old_path {
                    child.parent = new_path.clone();
                }
            }
        }
        let snapshot = ledger.clone();
        self.persist(&snapshot)?;
        Ok(snapshot)
    }
}

/// Words that mark a payment as settling an earlier purchase rather than being
/// one itself. Credit cards, 花呗, 白条 and the various 先用后付 products all
/// show up as a repayment row plus the original merchant rows.
const REPAYMENT_HINTS: [&str; 12] = [
    "花呗",
    "白条",
    "信用卡还款",
    "还款",
    "月付",
    "先享后付",
    "先用后付",
    "分期",
    "借款",
    "信用购",
    "花呗分期",
    "自动扣款",
];

pub fn is_repayment(entry: &Entry) -> bool {
    let haystack = format!("{} {} {}", entry.counterparty, entry.note, entry.category);
    REPAYMENT_HINTS.iter().any(|hint| haystack.contains(hint))
}

/// Strip the noise that differs between two exports of the same purchase.
fn merchant_key(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// A row that may be the same bill as another one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub key: String,
    pub amount: i64,
    pub entries: Vec<Entry>,
    /// `exact` when the merchant names match, `loose` when only the amount and
    /// a nearby date do.
    pub confidence: String,
}

/// Rows that look like the same purchase billed twice — the usual cause is
/// importing overlapping exports, or the same bill from two platforms.
pub fn find_duplicates(entries: &[Entry]) -> Vec<DuplicateGroup> {
    // Archived rows are already resolved: two rows describing one purchase are
    // exactly what the archive is for, so only the live ones are compared.
    let candidates: Vec<&Entry> = entries.iter().filter(|e| !e.excluded && !e.archived).collect();
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    let mut used = std::collections::HashSet::new();
    for (index, entry) in candidates.iter().enumerate() {
        if used.contains(&entry.id) {
            continue;
        }
        let mut matches: Vec<&Entry> = Vec::new();
        for other in candidates.iter().skip(index + 1) {
            if used.contains(&other.id) || other.kind != entry.kind {
                continue;
            }
            if other.amount != entry.amount {
                continue;
            }
            // A duplicate is one transaction recorded twice, so it shares the
            // day, the minute, the amount and the merchant. Anything looser
            // flags shared bikes and repeat coffees, which are real spending.
            if other.date != entry.date || other.time != entry.time {
                continue;
            }
            let a = merchant_key(&entry.counterparty);
            let b = merchant_key(&other.counterparty);
            if a.is_empty() || b.is_empty() {
                continue;
            }
            let same = a == b || a.contains(&b) || b.contains(&a);
            if !same {
                continue;
            }
            matches.push(other);
        }
        if matches.is_empty() {
            continue;
        }
        used.insert(entry.id.clone());
        let mut group: Vec<Entry> = vec![(*entry).clone()];
        for matched in matches {
            used.insert(matched.id.clone());
            group.push(matched.clone());
        }
        groups.push(DuplicateGroup {
            key: format!("{}:{}:{}", entry.date, entry.time, entry.amount),
            amount: entry.amount,
            entries: group,
            confidence: "exact".into(),
        });
    }
    groups
}

fn duplicate_key(source: &str, external_id: &str, date: &str, amount: i64, counterparty: &str) -> String {
    if !external_id.is_empty() {
        // The platform's transaction number alone. Prefixing it with the source
        // label meant that re-importing the same file after changing the source
        // (or after a wrong auto-detection) looked like a whole new bill; the
        // ids themselves never collide across platforms.
        format!("id:{external_id}")
    } else {
        format!("{source}:{date}:{amount}:{counterparty}")
    }
}

/// How much a row is worth keeping when several rows describe the same
/// purchase. Higher wins; ties go to the earliest import, then the smaller id,
/// so running the tidy twice always picks the same row.
fn tidy_rank(entry: &Entry) -> (i32, std::cmp::Reverse<String>, std::cmp::Reverse<String>) {
    let mut score = 0i32;
    // A category the user set by hand beats an automatic label.
    if entry.category_locked {
        score += 4;
    }
    // A project is expensive to re-attach, so it outweighs the free fields.
    if !entry.project_id.is_empty() {
        score += 3;
    }
    if !entry.account.is_empty() {
        score += 2;
    }
    if !entry.note.is_empty() {
        score += 2;
    }
    if entry.refunded_amount > 0 {
        score += 2;
    }
    if !entry.counterparty.is_empty() {
        score += 1;
    }
    if !entry.external_id.is_empty() {
        score += 1;
    }
    (
        score,
        std::cmp::Reverse(entry.created_at.clone()),
        std::cmp::Reverse(entry.id.clone()),
    )
}

/// What `auto_tidy` did, so the UI can report it without re-scanning.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoTidyOutcome {
    pub ledger: Ledger,
    /// Duplicate clusters that were resolved.
    pub groups: usize,
    /// Rows moved into the archive.
    pub archived: usize,
    /// The row kept from each cluster.
    pub kept: Vec<String>,
    pub archived_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
pub struct ImportOutcome {
    pub ledger: Ledger,
    /// Ids created by this import, used by the optional AI pass.
    #[serde(default)]
    pub new_ids: Vec<String>,
    pub added: usize,
    pub duplicates: usize,
    pub ignored: usize,
    /// Incoming refunds matched to the purchase they reverse.
    pub refunds_linked: usize,
    pub source: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sanitised copy of a real WeChat export: same 17 metadata rows, same
    /// header names, `.xlsx` because that is what WeChat ships today.
    const WECHAT_XLSX: &[u8] = include_bytes!("../tests/fixtures/wechat-sample.xlsx");
    /// A sanitised Alipay export, GB18030, with the newer header set.
    const ALIPAY_CSV: &[u8] = include_bytes!("../tests/fixtures/alipay-sample.csv");

    #[test]
    fn parses_the_current_wechat_xlsx_export() {
        let bill = parse_bill(WECHAT_XLSX);
        assert!(bill.detected);
        assert_eq!(bill.source, "wechat");
        // 4 spending/income rows + 1 neutral withdrawal + the reversed purchase.
        assert_eq!(bill.entries.len(), 6, "entries={:?}", bill.entries);
        assert_eq!(bill.ignored, 0);

        // WeChat rewrites the original row's status, so the refund belongs to
        // that row rather than to a separate match.
        let reversed = bill
            .entries
            .iter()
            .find(|e| e.external_id == "WX005")
            .expect("reversed row");
        assert!(reversed.self_refunded);
        assert_eq!(reversed.amount, 5000);

        let coffee = bill
            .entries
            .iter()
            .find(|e| e.external_id == "WX002")
            .expect("shop row");
        assert_eq!(coffee.date, "2025-08-03");
        assert_eq!(coffee.time, "12:12");
        assert_eq!(coffee.amount, 990);
        assert_eq!(coffee.kind, "expense");
        assert_eq!(coffee.account, "零钱");

        let withdrawal = bill
            .entries
            .iter()
            .find(|e| e.external_id == "WXTX001")
            .expect("withdrawal row");
        // `/` in 收/支 is a neutral move, not spending.
        assert_eq!(withdrawal.kind, "transfer");
        assert_eq!(withdrawal.amount, 248216);

        let transfer = bill
            .entries
            .iter()
            .find(|e| e.external_id == "WX004")
            .expect("income row");
        assert_eq!(transfer.kind, "income");
        assert_eq!(transfer.amount, 150000);
    }

    #[test]
    fn parses_icost_with_its_own_categories_and_refunds() {
        let rows = vec![
            vec!["日期", "类型", "金额", "一级分类", "二级分类", "账户1", "账户2", "备注", "货币", "标签", "账本", "退款"]
                .into_iter().map(str::to_string).collect(),
            vec!["2025/01/01 07:42", "支出", "-118.00", "文化休闲", "影音", "银行卡", "", "App Store", "CNY", "", "默认账本", "18.00"]
                .into_iter().map(str::to_string).collect(),
        ];
        let bill = parse_rows(rows);
        assert_eq!(bill.source, "icost");
        assert!(bill.detected);
        let row = &bill.entries[0];
        assert_eq!(row.category, "文化休闲/影音");
        assert_eq!(row.amount, 11800);
        assert!(row.self_refunded);
        assert_eq!(row.refunded_amount, 1800);
    }

    #[test]
    fn repeated_icost_import_does_not_add_rows() {
        let (state, dir) = temp_state();
        let path = "/Users/tongkeni/Documents/账单/（仅供查看，不用于数据恢复）iCost_20261113131558.xlsx";
        let Ok(bytes) = std::fs::read(path) else { return };
        let first = state.import("icost.xlsx", &bytes).unwrap();
        let second = state.import("icost.xlsx", &bytes).unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.ledger.entries.len(), first.ledger.entries.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_the_current_alipay_csv_export() {
        let bill = parse_bill(ALIPAY_CSV);
        assert!(bill.detected);
        assert_eq!(bill.source, "alipay");
        assert_eq!(bill.entries.len(), 4);

        let flight = bill
            .entries
            .iter()
            .find(|e| e.external_id == "AL002")
            .expect("flight row");
        assert_eq!(flight.kind, "expense");
        assert_eq!(flight.amount, 143100);
        // Classification happens at import time, when the rule list is known;
        // the parsed row carries the text it will be matched against.
        assert!(flight.haystack.contains("交通出行"), "{}", flight.haystack);

        let lunch = bill
            .entries
            .iter()
            .find(|e| e.external_id == "AL003")
            .expect("lunch row");
        assert!(lunch.haystack.contains("餐饮美食"), "{}", lunch.haystack);

        let neutral = bill
            .entries
            .iter()
            .find(|e| e.external_id == "AL004")
            .expect("neutral row");
        assert_eq!(neutral.kind, "transfer");
    }

    fn temp_state() -> (LedgerState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("stockpot-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (LedgerState::new(dir.clone()), dir)
    }

    #[test]
    fn import_adds_rows_and_dedupes_a_reimport() {
        let (state, dir) = temp_state();
        let first = state.import("wechat.xlsx", WECHAT_XLSX).unwrap();
        assert_eq!(first.added, 6);
        assert_eq!(first.source, "wechat");

        let second = state.import("wechat.xlsx", WECHAT_XLSX).unwrap();
        assert_eq!(second.added, 0);
        assert_eq!(second.duplicates, 6);
        assert_eq!(second.ledger.entries.len(), 6);

        // The reversed purchase keeps its row but carries the refund amount, so
        // it cannot be counted as spending.
        let reversed = first
            .ledger
            .entries
            .iter()
            .find(|e| e.external_id == "WX005")
            .expect("reversed row");
        assert_eq!(reversed.refunded_amount, reversed.amount);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn incoming_refund_is_linked_to_its_purchase() {
        let (state, dir) = temp_state();
        // A purchase, then a separate refund row 3 days later (Alipay shape).
        let bill = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n\
2025-07-01 10:00:00,购物,某店,耳机,支出,199.00,余额,交易成功,P1\n\
2025-07-04 09:00:00,退款,某店,退款-耳机,不计收支,199.00,余额,退款成功,R1\n";
        let outcome = state.import("alipay.csv", bill.as_bytes()).unwrap();
        assert_eq!(outcome.added, 1, "the refund is folded into the purchase");
        assert_eq!(outcome.refunds_linked, 1);
        let entry = &outcome.ledger.entries[0];
        assert_eq!(entry.kind, "expense");
        assert_eq!(entry.refunded_amount, 19900);
        assert_eq!(entry.refunded_at, "2025-07-04");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refund_without_a_purchase_is_kept_but_excluded() {
        let (state, dir) = temp_state();
        let bill = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n\
2025-07-04 09:00:00,退款,某店,退款-旧订单,不计收支,88.00,余额,退款成功,R9\n";
        let outcome = state.import("alipay.csv", bill.as_bytes()).unwrap();
        assert_eq!(outcome.refunds_linked, 0);
        let entry = &outcome.ledger.entries[0];
        assert_eq!(entry.kind, "transfer");
        assert!(entry.excluded, "an unmatched refund must not touch totals");
        assert_eq!(entry.amount, 8800);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refund_matching_prefers_the_exact_amount() {
        let (state, dir) = temp_state();
        let bill = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n\
2025-07-01 10:00:00,购物,甲店,大件,支出,500.00,余额,交易成功,P1\n\
2025-07-01 11:00:00,购物,乙店,小件,支出,199.00,余额,交易成功,P2\n\
2025-07-03 09:00:00,退款,乙店,退款,不计收支,199.00,余额,退款成功,R1\n";
        let outcome = state.import("alipay.csv", bill.as_bytes()).unwrap();
        assert_eq!(outcome.refunds_linked, 1);
        let exact = outcome
            .ledger
            .entries
            .iter()
            .find(|e| e.external_id == "P2")
            .unwrap();
        assert_eq!(exact.refunded_amount, 19900, "the 199 refund belongs to P2");
        let other = outcome
            .ledger
            .entries
            .iter()
            .find(|e| e.external_id == "P1")
            .unwrap();
        assert_eq!(other.refunded_amount, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_two_platforms_do_not_collide() {
        let (state, dir) = temp_state();
        state.import("wechat.xlsx", WECHAT_XLSX).unwrap();
        let after = state.import("alipay.csv", ALIPAY_CSV).unwrap();
        assert_eq!(after.added, 4);
        assert_eq!(after.ledger.entries.len(), 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_survives_a_restart() {
        let (state, dir) = temp_state();
        state.import("alipay.csv", ALIPAY_CSV).unwrap();
        drop(state);
        let reopened = LedgerState::new(dir.clone());
        assert_eq!(reopened.snapshot().entries.len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejected_files_report_a_reason() {
        let (state, dir) = temp_state();
        let err = state
            .import("notes.csv", b"just,some,words\n1,2,3")
            .unwrap_err();
        assert_eq!(err, "unrecognised-bill");
        // A zip that is not a workbook must not be mistaken for one.
        let err = state.import("bundle.zip", b"PK\x03\x04nonsense").unwrap_err();
        assert_eq!(err, "unrecognised-bill");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refund_can_be_linked_by_hand() {
        let (state, dir) = temp_state();
        let purchase = state
            .add(EntryInput {
                date: "2025-07-01".into(),
                time: "10:00".into(),
                kind: "expense".into(),
                amount: 19900,
                category: "购物".into(),
                account: "现金".into(),
                counterparty: "某店".into(),
                note: String::new(),
                excluded: false,
            })
            .unwrap();
        let entry_id = purchase.entries[0].id.clone();

        // A partial refund typed in directly.
        let linked = state
            .link_refund(RefundLinkInput {
                entry_id: entry_id.clone(),
                source_id: None,
                amount: 5000,
                date: "2025-07-03".into(),
            })
            .unwrap();
        assert_eq!(linked.entries[0].refunded_amount, 5000);
        assert_eq!(linked.entries[0].refunded_at, "2025-07-03");

        // Linking the rest caps at the purchase amount.
        let capped = state
            .link_refund(RefundLinkInput {
                entry_id: entry_id.clone(),
                source_id: None,
                amount: 99900,
                date: "2025-07-04".into(),
            })
            .unwrap();
        assert_eq!(capped.entries[0].refunded_amount, 19900);

        // Zero clears the link.
        let cleared = state
            .link_refund(RefundLinkInput {
                entry_id: entry_id.clone(),
                source_id: None,
                amount: 0,
                date: String::new(),
            })
            .unwrap();
        assert_eq!(cleared.entries[0].refunded_amount, 0);
        assert!(cleared.entries[0].refunded_at.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn linking_an_unmatched_refund_row_consumes_it() {
        let (state, dir) = temp_state();
        let purchase = state
            .add(EntryInput {
                date: "2025-07-01".into(),
                time: "10:00".into(),
                kind: "expense".into(),
                amount: 8800,
                category: "购物".into(),
                account: "现金".into(),
                counterparty: "甲店".into(),
                note: String::new(),
                excluded: false,
            })
            .unwrap();
        let entry_id = purchase.entries[0].id.clone();
        let refund = state
            .add(EntryInput {
                date: "2025-07-05".into(),
                time: "09:00".into(),
                kind: "transfer".into(),
                amount: 8800,
                category: "其他".into(),
                account: "现金".into(),
                counterparty: "甲店".into(),
                note: "退款".into(),
                excluded: true,
            })
            .unwrap();
        let refund_id = refund.entries[0].id.clone();

        let linked = state
            .link_refund(RefundLinkInput {
                entry_id: entry_id.clone(),
                source_id: Some(refund_id),
                amount: 0,
                date: String::new(),
            })
            .unwrap();
        assert_eq!(linked.entries.len(), 1, "the refund row is folded in");
        assert_eq!(linked.entries[0].refunded_amount, 8800);
        assert_eq!(linked.entries[0].refunded_at, "2025-07-05");

        // Only expenses can carry a refund.
        let other = state
            .add(EntryInput {
                date: "2025-07-06".into(),
                kind: "income".into(),
                amount: 1000,
                category: "其他".into(),
                ..Default::default()
            })
            .unwrap();
        let income_id = other.entries.iter().find(|e| e.kind == "income").unwrap().id.clone();
        assert_eq!(
            state
                .link_refund(RefundLinkInput {
                    entry_id: income_id,
                    source_id: None,
                    amount: 100,
                    date: "2025-07-06".into(),
                })
                .unwrap_err(),
            "not-an-expense"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manual_entries_validate_and_learn_categories() {
        let (state, dir) = temp_state();
        let ledger = state
            .add(EntryInput {
                date: "2024-05-01".into(),
                time: "08:00".into(),
                kind: "expense".into(),
                amount: 2500,
                category: "宠物".into(),
                account: "现金".into(),
                counterparty: "宠物店".into(),
                note: String::new(),
                excluded: false,
            })
            .unwrap();
        assert_eq!(ledger.entries.len(), 1);
        assert!(ledger.categories.iter().any(|c| c.name == "宠物"));

        let bad = EntryInput {
            date: "2024-05-01".into(),
            amount: 0,
            kind: "expense".into(),
            category: "其他".into(),
            ..Default::default()
        };
        assert_eq!(state.add(bad).unwrap_err(), "missing-amount");

        let id = state.snapshot().entries[0].id.clone();
        let updated = state
            .update(
                &id,
                EntryInput {
                    date: "2024-05-02".into(),
                    amount: 3000,
                    kind: "expense".into(),
                    category: "宠物".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.entries[0].amount, 3000);
        assert_eq!(updated.entries[0].date, "2024-05-02");

        assert_eq!(state.delete(&id).unwrap().entries.len(), 0);
        assert_eq!(state.delete(&id).unwrap_err(), "missing-entry");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rules_beat_the_builtin_keywords_and_can_be_re_applied() {
        let (state, dir) = temp_state();
        // A user rule that outranks the seeded "咖啡" rule by length.
        let ledger = state.add_rule("瑞幸咖啡门店", "餐饮/外卖").unwrap();
        assert!(ledger.rules.iter().any(|r| r.pattern == "瑞幸咖啡门店"));

        let bill = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n\
2025-07-01 10:00:00,餐饮美食,瑞幸咖啡门店,拿铁,支出,19.00,余额,交易成功,R1\n";
        let outcome = state.import("alipay.csv", bill.as_bytes()).unwrap();
        assert_eq!(outcome.ledger.entries[0].category, "餐饮/外卖");

        // Changing the rule and re-applying moves unlocked rows only.
        let rule_id = outcome
            .ledger
            .rules
            .iter()
            .find(|r| r.pattern == "瑞幸咖啡门店")
            .unwrap()
            .id
            .clone();
        state
            .update_rule(&rule_id, "瑞幸咖啡门店", "餐饮/咖啡")
            .unwrap();
        let reapplied = state.apply_rules_to_all().unwrap();
        assert_eq!(reapplied.entries[0].category, "餐饮/咖啡");

        assert_eq!(
            state.delete_rule(&rule_id).unwrap().rules.len(),
            ledger.rules.len() - 1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_income_row_never_takes_an_expense_category() {
        let categories = vec![
            CategoryDef {
                name: "购物".into(),
                parent: String::new(),
                kind: "expense".into(),
                icon: "shopping".into(),
                description: String::new(),
            },
            CategoryDef {
                name: "工资".into(),
                parent: String::new(),
                kind: "income".into(),
                icon: "salary".into(),
                description: String::new(),
            },
            CategoryDef {
                name: "其他".into(),
                parent: String::new(),
                kind: String::new(),
                icon: "dots".into(),
                description: String::new(),
            },
        ];
        let rules = vec![
            Rule {
                id: "a".into(),
                pattern: "超爱喝茶".into(),
                category: "购物".into(),
            },
            Rule {
                id: "b".into(),
                pattern: "工资".into(),
                category: "工资".into(),
            },
        ];
        // The shop rule is expense-only, so an incoming transfer misses it.
        assert_eq!(
            match_rule_for(&rules, &categories, "超爱喝茶", "income").map(|r| r.id.as_str()),
            None
        );
        assert_eq!(
            match_rule_for(&rules, &categories, "超爱喝茶", "expense").map(|r| r.id.as_str()),
            Some("a")
        );
        // An income rule still matches.
        assert_eq!(
            match_rule_for(&rules, &categories, "工资代发", "income").map(|r| r.id.as_str()),
            Some("b")
        );
        // A neutral category is allowed in both directions.
        let neutral = vec![Rule {
            id: "c".into(),
            pattern: "转账".into(),
            category: "其他".into(),
        }];
        assert!(match_rule_for(&neutral, &categories, "转账", "income").is_some());

        // The keyword fallback obeys the same rule.
        assert_eq!(guess_category("超爱喝茶", "income", ""), "其他");
        assert_eq!(guess_category("超爱喝茶", "expense", ""), "餐饮");
    }

    #[test]
    fn reapplying_rules_repairs_rows_filed_against_their_direction() {
        let (state, dir) = temp_state();
        // An income row sitting in an expense category, as an old import left it.
        state
            .add(EntryInput {
                date: "2025-07-01".into(),
                kind: "income".into(),
                amount: 2700,
                category: "餐饮".into(),
                counterparty: "超爱喝茶".into(),
                ..Default::default()
            })
            .unwrap();
        let mut entries = state.snapshot();
        let id = entries.entries[0].id.clone();
        // `add` locks the category; unlock it so a rule pass is allowed to move it.
        state.set_excluded(vec![id.clone()], false).unwrap();
        let _ = id;
        let mut ledger = state.snapshot();
        for entry in ledger.entries.iter_mut() {
            entry.category_locked = false;
        }
        save(&dir, &ledger).unwrap();

        let (state, dir) = {
            let state = LedgerState::new(dir.clone());
            (state, dir)
        };
        let fixed = state.apply_rules_to_all().unwrap();
        assert_eq!(fixed.entries[0].category, "其他", "income row leaves 餐饮");
        entries = fixed;
        assert!(!entries.entries.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_longest_matching_rule_wins() {
        let rules = vec![
            Rule {
                id: "a".into(),
                pattern: "咖啡".into(),
                category: "餐饮".into(),
            },
            Rule {
                id: "b".into(),
                pattern: "星巴克咖啡".into(),
                category: "餐饮/咖啡".into(),
            },
        ];
        assert_eq!(
            match_rule(&rules, "星巴克咖啡门店").map(|r| r.category.as_str()),
            Some("餐饮/咖啡")
        );
        assert_eq!(
            match_rule(&rules, "某家咖啡店").map(|r| r.category.as_str()),
            Some("餐饮")
        );
        assert!(match_rule(&rules, "超市").is_none());
    }

    #[test]
    fn ignored_cleanup_entries_stay_hidden() {
        let (state, dir) = temp_state();
        state
            .ignore_cleanup("duplicate", "2025-07-01:10:00:3500", true)
            .unwrap();
        let ledger = state
            .ignore_cleanup("repayment", "row-1", true)
            .unwrap();
        assert_eq!(ledger.ignored_duplicates.len(), 1);
        assert_eq!(ledger.ignored_repayments.len(), 1);
        assert_eq!(
            state.ignore_cleanup("nonsense", "x", true).unwrap_err(),
            "bad-kind"
        );
        let cleared = state
            .ignore_cleanup("duplicate", "2025-07-01:10:00:3500", false)
            .unwrap();
        assert!(cleared.ignored_duplicates.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_tidy_keeps_one_row_per_cluster_and_archives_the_rest() {
        let (state, dir) = temp_state();
        // Two rows for one purchase: same day, minute, amount and merchant.
        // The second one carries an account, so it is the one worth keeping.
        for (id, account, note) in [("a", "", ""), ("b", "招商银行", "")] {
            state
                .add(EntryInput {
                    date: "2025-07-01".into(),
                    time: "10:00".into(),
                    kind: "expense".into(),
                    amount: 3500,
                    category: "餐饮/咖啡".into(),
                    account: account.into(),
                    counterparty: "星巴克".into(),
                    note: note.into(),
                    excluded: false,
                })
                .unwrap();
            let _ = id;
        }
        let before = state.snapshot();
        assert_eq!(find_duplicates(&before.entries).len(), 1, "one cluster to resolve");

        let outcome = state.auto_tidy().unwrap();
        assert_eq!(outcome.groups, 1);
        assert_eq!(outcome.archived, 1, "one copy archived, none deleted");
        assert_eq!(outcome.ledger.entries.len(), 2, "both rows still exist");

        let kept = outcome
            .ledger
            .entries
            .iter()
            .find(|e| !e.archived)
            .expect("one row stays live");
        assert_eq!(kept.account, "招商银行", "the richer row wins");
        assert_eq!(kept.id, outcome.kept[0]);
        assert_eq!(outcome.archived_ids, vec![
            outcome
                .ledger
                .entries
                .iter()
                .find(|e| e.archived)
                .unwrap()
                .id
                .clone()
        ]);

        // Resolved clusters no longer show up, so a second click does nothing.
        let again = state.auto_tidy().unwrap();
        assert_eq!(again.groups, 0);
        assert_eq!(again.archived, 0);

        // Restoring puts the row back in circulation.
        let restored = state
            .set_archived(outcome.archived_ids.clone(), false)
            .unwrap();
        assert!(restored.entries.iter().all(|e| !e.archived));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_icost_categories_are_not_added_and_can_be_reset() {
        let (state, dir) = temp_state();
        let path = "/Users/tongkeni/Documents/账单/（仅供查看，不用于数据恢复）iCost_20261113131558.xlsx";
        let Ok(bytes) = std::fs::read(path) else { return };
        let outcome = state.import("icost.xlsx", &bytes).unwrap();
        let known: std::collections::HashSet<String> = outcome
            .ledger.categories.iter().map(|c| c.path()).collect();
        assert!(outcome.ledger.entries.iter().all(|e| known.contains(&e.category)));
        let custom = state.add_category("临时分类", "", "dots", "expense", "临时说明").unwrap();
        assert!(custom.categories.iter().any(|c| c.name == "临时分类"));
        let reset = state.reset_categories().unwrap();
        assert!(reset.categories.iter().all(|c| c.name != "临时分类"));
        assert_eq!(reset.categories.len(), default_categories().len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn excel_date_serials_parse_like_text_dates() {
        // WeChat's newer xlsx export stores 交易时间 as a day count, so this is
        // the difference between importing a whole bill and skipping all of it.
        assert_eq!(
            normalize_date("46348.45753472222").as_deref(),
            Some("2026-11-22 10:58")
        );
        // Whole days (no time part) stay valid.
        assert_eq!(normalize_date("46348").as_deref(), Some("2026-11-22 00:00"));
        // Text dates and impossible numbers keep working as before.
        assert_eq!(
            normalize_date("2026-11-22 10:58:51").as_deref(),
            Some("2026-11-22 10:58")
        );
        assert_eq!(normalize_date("20240301"), None);
    }

    #[test]
    fn fund_earnings_become_income_but_transfers_do_not() {
        // Alipay files both as 不计收支; only the earnings are real income.
        assert_eq!(
            parse_kind("不计收支").map(|kind| if is_fund_earning("余额宝 收益发放") { "income" } else { kind }),
            Some("income")
        );
        assert!(!is_fund_earning("余额宝 转入"));
        assert!(!is_fund_earning("余额宝 转出"));
        assert!(is_fund_earning("零钱通 收益"));
        assert!(!is_fund_earning("超市"));
    }

    #[test]
    fn forced_source_parses_a_bill_whose_header_lost_the_markers() {
        // No 商户单号 / 当前状态 / 微信 marker, so detection alone would refuse it.
        let rows = vec![
            vec![
                "交易时间".to_string(),
                "收/支".to_string(),
                "金额(元)".to_string(),
                "交易对方".to_string(),
            ],
            vec![
                "2026-11-01 09:00:00".to_string(),
                "支出".to_string(),
                "12.50".to_string(),
                "早餐店".to_string(),
            ],
        ];
        assert!(!parse_rows_as(rows.clone(), None).detected, "auto-detection fails");
        let bill = parse_rows_as(rows, Some("alipay"));
        assert!(bill.detected);
        assert_eq!(bill.source, "alipay");
        assert_eq!(bill.entries.len(), 1);
        assert_eq!(bill.entries[0].amount, 1250);
    }

    #[test]
    fn the_same_bill_is_not_reimported_under_another_source() {
        // Re-importing a file after changing the source label must still count
        // as duplicates: the platform transaction number identifies the row.
        let key_wechat = duplicate_key("wechat", "4200001234567890", "2026-11-01", 1250, "早餐店");
        let key_alipay = duplicate_key("alipay", "4200001234567890", "2026-11-01", 1250, "早餐店");
        assert_eq!(key_wechat, key_alipay);
        // Rows without an id still fall back to the inferred signature.
        let a = duplicate_key("wechat", "", "2026-11-01", 1250, "早餐店");
        let b = duplicate_key("alipay", "", "2026-11-01", 1250, "早餐店");
        assert_ne!(a, b);
    }

    #[test]
    fn finds_the_same_bill_imported_twice() {
        let mut entries = Vec::new();
        for (id, date, source, merchant) in [
            ("a", "2025-07-01", "wechat", "星巴克咖啡"),
            ("b", "2025-07-01", "alipay", "星巴克咖啡门店"),
            ("c", "2025-07-01", "wechat", "星巴克咖啡"),
        ] {
            entries.push(Entry {
                id: id.into(),
                date: date.into(),
                time: "10:00".into(),
                kind: "expense".into(),
                amount: 3500,
                category: "餐饮/咖啡".into(),
                account: "零钱".into(),
                counterparty: merchant.into(),
                note: String::new(),
                source: source.into(),
                external_id: id.into(),
                excluded: false,
                archived: false,
                refunded_amount: 0,
                refunded_at: String::new(),
                category_locked: false,
                project_id: String::new(),
                created_at: "2025-07-01T00:00:00".into(),
            });
        }
        let groups = find_duplicates(&entries);
        assert_eq!(groups.len(), 1, "one cluster of three rows");
        assert_eq!(groups[0].entries.len(), 3);
        assert_eq!(groups[0].amount, 3500);

        // Different merchants at the same price are not duplicates.
        let mut unrelated = entries.clone();
        unrelated[1].counterparty = "完全不同的商户".into();
        let groups = find_duplicates(&unrelated);
        assert_eq!(groups[0].entries.len(), 2);

        // The same shop on another day, or even a minute later, is a repeat
        // purchase rather than a duplicate.
        let mut later = entries.clone();
        later[1].date = "2025-07-03".into();
        later[2].date = "2025-07-05".into();
        assert!(find_duplicates(&later).is_empty());

        let mut a_minute = entries.clone();
        a_minute[1].time = "10:01".into();
        a_minute[2].time = "10:02".into();
        assert!(find_duplicates(&a_minute).is_empty());
    }

    #[test]
    fn recognises_buy_now_pay_later_repayments() {
        let repayment = Entry {
            id: "r".into(),
            date: "2025-07-10".into(),
            time: String::new(),
            kind: "transfer".into(),
            amount: 12000,
            category: "其他".into(),
            account: "银行卡".into(),
            counterparty: "花呗".into(),
            note: "花呗还款".into(),
            source: "alipay".into(),
            external_id: "r".into(),
            excluded: false,
            archived: false,
            refunded_amount: 0,
            refunded_at: String::new(),
            category_locked: false,
            project_id: String::new(),
            created_at: "2025-07-10T00:00:00".into(),
        };
        assert!(is_repayment(&repayment));
        let mut normal = repayment.clone();
        normal.counterparty = "星巴克".into();
        normal.note = String::new();
        assert!(!is_repayment(&normal));
    }

    #[test]
    fn a_legacy_flat_ledger_gets_icons_and_children_once() {
        let dir = std::env::temp_dir().join(format!("stockpot-upgrade-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // The old shape: bare strings, no schema version.
        let legacy = r#"{
            "entries": [],
            "categories": ["餐饮", "交通", "其他"],
            "accounts": ["现金"],
            "imports": []
        }"#;
        std::fs::write(ledger_path(&dir), legacy).unwrap();

        let ledger = load(&dir);
        let names: Vec<&str> = ledger.categories.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"咖啡"), "leaves are added");
        assert!(
            ledger
                .categories
                .iter()
                .any(|c| c.name == "餐饮" && c.icon == "food"),
            "icons are filled in"
        );
        assert!(ledger.schema_version >= 3);
        assert!(
            ledger
                .categories
                .iter()
                .any(|c| c.name == "餐饮" && c.kind == "expense"),
            "directions are filled in"
        );
        assert!(!ledger.rules.is_empty(), "seed rules are installed");

        // Re-running must not duplicate anything, even if the user deleted a leaf.
        let mut trimmed = ledger.clone();
        trimmed.categories.retain(|c| c.name != "咖啡");
        save(&dir, &trimmed).unwrap();
        let again = load(&dir);
        assert!(
            !again.categories.iter().any(|c| c.name == "咖啡"),
            "the upgrade does not run twice"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn categories_are_two_levels_and_rename_carries_its_leaves() {
        let (state, dir) = temp_state();
        state
            .add_category("宠物", "", "basket", "expense", "宠物用品和宠物服务")
            .unwrap();
        let ledger = state
            .add_category("猫粮", "宠物", "", "expense", "猫粮、猫砂等猫用品")
            .unwrap();
        let leaf = ledger
            .categories
            .iter()
            .find(|c| c.name == "猫粮")
            .expect("leaf");
        assert_eq!(leaf.path(), "宠物/猫粮");

        // An entry filed under the leaf keeps its path when the group is renamed.
        let with_entry = state
            .add(EntryInput {
                date: "2024-06-01".into(),
                kind: "expense".into(),
                amount: 5000,
                category: "宠物/猫粮".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(with_entry.entries[0].category, "宠物/猫粮");

        let renamed = state
            .update_category("宠物", "", "宠物用品", "", "", "", "宠物相关消费")
            .unwrap();
        assert!(renamed.categories.iter().any(|c| c.path() == "宠物用品/猫粮"));
        assert_eq!(renamed.entries[0].category, "宠物用品/猫粮");

        // Deleting a group takes its leaves with it.
        let after = state.delete_category("宠物用品").unwrap();
        assert!(after.categories.iter().all(|c| !c.path().starts_with("宠物用品")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renaming_onto_an_existing_name_is_rejected() {
        // 两个同名同级分类会让手机端列表 key 重复（LazyColumn 直接崩），源头拦住
        let (state, dir) = temp_state();
        // 默认账本里有餐饮/交通这些，挑两个不在默认表里的名字
        state.add_category("宠物", "", "pet", "expense", "").unwrap();
        state.add_category("装修", "", "repair", "expense", "").unwrap();

        let err = state
            .update_category("装修", "", "宠物", "", "", "", "")
            .unwrap_err();
        assert_eq!(err, "duplicate");
        // 只是改描述不算撞名，照常放行
        let ok = state
            .update_category("装修", "", "装修", "", "", "", "刷墙、换地板")
            .unwrap();
        assert_eq!(
            ok.categories.iter().find(|c| c.name == "装修").unwrap().description,
            "刷墙、换地板"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_can_be_reclassified_in_bulk() {
        let (state, dir) = temp_state();
        for _ in 0..3 {
            state
                .add(EntryInput {
                    date: "2024-06-01".into(),
                    kind: "expense".into(),
                    amount: 1000,
                    category: "其他".into(),
                    ..Default::default()
                })
                .unwrap();
        }
        let ids: Vec<String> = state.snapshot().entries.iter().map(|e| e.id.clone()).collect();
        let moved = state
            .recategorize(vec![ids[0].clone(), ids[1].clone()], "餐饮/外卖")
            .unwrap();
        let count = moved
            .entries
            .iter()
            .filter(|e| e.category == "餐饮/外卖")
            .count();
        assert_eq!(count, 2);
        // The new path is registered, parents included.
        assert!(moved.categories.iter().any(|c| c.path() == "餐饮/外卖"));
        assert_eq!(
            state.recategorize(ids, "").unwrap_err(),
            "missing-category"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn money_parses_to_exact_cents() {
        assert_eq!(parse_amount_cents("¥1,234.56"), Some(123456));
        assert_eq!(parse_amount_cents("0.10"), Some(10));
        assert_eq!(parse_amount_cents("19.99"), Some(1999));
        assert_eq!(parse_amount_cents("100"), Some(10000));
        assert_eq!(parse_amount_cents("¥2482.16"), Some(248216));
        assert_eq!(parse_amount_cents(""), None);
    }

    #[test]
    fn csv_split_handles_quotes_and_commas() {
        let cols = split_csv(r#"a,"b,c","d""e",f"#);
        assert_eq!(cols, vec!["a", "b,c", "d\"e", "f"]);
    }

    #[test]
    fn categories_come_from_keywords_and_hints() {
        assert_eq!(guess_category("美团外卖", "expense", ""), "餐饮");
        assert_eq!(guess_category("地铁出行", "expense", ""), "交通");
        assert_eq!(guess_category("某某公司 工资", "income", ""), "工资");
        assert_eq!(guess_category("不明支出", "expense", ""), "其他");
        // The platform label wins when it maps.
        assert_eq!(guess_category("机票订单", "expense", "交通出行"), "交通");
        assert_eq!(guess_category("某店", "expense", "餐饮美食"), "餐饮");
    }

    #[test]
    fn dates_accept_several_shapes() {
        assert_eq!(normalize_date("2024-03-01 12:30:00").unwrap(), "2024-03-01 12:30");
        assert_eq!(normalize_date("2024/03/01").unwrap(), "2024-03-01");
        assert_eq!(normalize_date("2024年03月01日 08:05").unwrap(), "2024-03-01 08:05");
        assert!(normalize_date("not a date").is_none());
    }

    #[test]
    fn replace_swaps_disk_and_memory_together() {
        // 同步合并下来的那份必须同时进内存，否则下一次编辑会拿旧的盖回去
        let dir = std::env::temp_dir().join(format!("stockpot-replace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = LedgerState::new(dir.clone());
        assert_eq!(state.snapshot().entries.len(), 0);

        let mut next = Ledger::with_defaults();
        for (index, id) in ["a", "b"].iter().enumerate() {
            next.entries.push(Entry {
                id: (*id).into(),
                date: "2024-03-01".into(),
                time: String::new(),
                kind: "expense".into(),
                amount: 100 + index as i64,
                category: "餐饮".into(),
                account: "现金".into(),
                counterparty: "面馆".into(),
                note: String::new(),
                source: "manual".into(),
                external_id: String::new(),
                excluded: false,
                archived: false,
                refunded_amount: 0,
                refunded_at: String::new(),
                category_locked: false,
                project_id: String::new(),
                created_at: "2024-03-01T12:00:00".into(),
            });
        }
        state.replace(next).unwrap();

        assert_eq!(state.snapshot().entries.len(), 2, "内存没跟着换");
        assert_eq!(load(&dir).entries.len(), 2, "盘上没写进去");
        // replace 是从云端来的内容：界面还没见过，监听器得照常通知
        assert_eq!(state.last_saved(), 0, "同步写进来的不该被当成「自己写的」");
        assert!(
            state.needs_broadcast(hash_bytes(&std::fs::read(ledger_path(&dir)).unwrap())),
            "云端换下来的账本要推给窗口"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revision_moves_only_when_something_is_written() {
        let (state, dir) = temp_state();
        let before = state.revision();
        assert_eq!(state.last_saved(), 0);

        state
            .add(EntryInput {
                date: "2026-11-01".into(),
                kind: "expense".into(),
                amount: 1200,
                category: "餐饮".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(state.revision(), before + 1, "改一次账要 +1");

        // 自己写的这份，指纹要和盘上的字节对得上——监听器就靠这个跳过回推
        let bytes = std::fs::read(ledger_path(&dir)).unwrap();
        let written = hash_bytes(&bytes);
        assert_eq!(written, state.last_saved());
        // 窗口还没盖章：这时候还得推一次，不然别的窗口看不到
        assert!(state.needs_broadcast(written));
        state.acknowledge();
        assert!(!state.needs_broadcast(written), "盖过章的内容不该再推一遍");
        // 盘上换了别的内容（比如 CLI 改的），盖不盖章都得推
        assert!(state.needs_broadcast(written ^ 0xff));

        // 没改就不会动；自动上行靠这个「不动」判断要不要序列化
        let steady = state.revision();
        let _ = state.snapshot();
        assert_eq!(state.revision(), steady);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_copy_is_compact_but_still_reads_back() {
        let (state, dir) = temp_state();
        state
            .add(EntryInput {
                date: "2026-11-02".into(),
                kind: "expense".into(),
                amount: 990,
                category: "餐饮".into(),
                ..Default::default()
            })
            .unwrap();
        let raw = std::fs::read_to_string(ledger_path(&dir)).unwrap();
        // 缩进没了，体积省下来；内容还是原来那份
        assert!(!raw.contains("\n  "), "还在写缩进版：{}", &raw[..raw.len().min(80)]);
        assert_eq!(load(&dir).entries.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("stockpot-ledger-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut ledger = Ledger::with_defaults();
        ledger.entries.push(Entry {
            id: "e1".into(),
            date: "2024-03-01".into(),
            time: "12:00".into(),
            kind: "expense".into(),
            amount: 1234,
            category: "餐饮".into(),
            account: "现金".into(),
            counterparty: "面馆".into(),
            note: String::new(),
            source: "manual".into(),
            external_id: String::new(),
            excluded: false,
            archived: false,
            refunded_amount: 0,
            refunded_at: String::new(),
            category_locked: false,
            project_id: String::new(),
            created_at: "2024-03-01T12:00:00".into(),
        });
        save(&dir, &ledger).unwrap();
        let back = load(&dir);
        assert_eq!(back.entries.len(), 1);
        assert_eq!(back.entries[0].amount, 1234);
        assert!(ledger_path(&dir).with_extension("json.bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拿真实账本量一遍各条路的开销。默认不跑：
    /// `cargo test --lib big_ledger_costs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn big_ledger_costs() {
        let path = std::env::var("STOCKPOT_LEDGER").unwrap_or_else(|_| {
            format!(
                "{}/com.stockpot.app/ledger.json",
                std::env::var("APPDATA").unwrap_or_default()
            )
        });
        let raw = std::fs::read_to_string(&path).expect("real ledger");
        println!("file {} KB", raw.len() / 1024);

        let t = std::time::Instant::now();
        let ledger: Ledger = serde_json::from_str(&raw).unwrap();
        println!("from_str   {:?}  ({} 条)", t.elapsed(), ledger.entries.len());

        let t = std::time::Instant::now();
        let compact = serde_json::to_string(&ledger).unwrap();
        println!("to_string  {:?}  ({} KB)", t.elapsed(), compact.len() / 1024);

        let t = std::time::Instant::now();
        let pretty = serde_json::to_string_pretty(&ledger).unwrap();
        println!("pretty     {:?}  ({} KB)", t.elapsed(), pretty.len() / 1024);

        let t = std::time::Instant::now();
        let value = serde_json::to_value(&ledger).unwrap();
        println!("to_value   {:?}", t.elapsed());

        let t = std::time::Instant::now();
        let text = value.to_string();
        println!("value→str  {:?}  ({} KB)", t.elapsed(), text.len() / 1024);

        let t = std::time::Instant::now();
        let cloned = ledger.clone();
        println!("clone      {:?}  ({} 条)", t.elapsed(), cloned.entries.len());

        let t = std::time::Instant::now();
        let _ = serde_json::to_vec(&serde_json::json!({ "rev": 1, "ledger": value })).unwrap();
        println!("包一层再序列化 {:?}", t.elapsed());
    }
}
