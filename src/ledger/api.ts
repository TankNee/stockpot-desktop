import { invoke } from "@tauri-apps/api/core";
import type {
  AiResult,
  Assets,
  AutoTidyOutcome,
  CleanupReport,
  EntryInput,
  EntrySource,
  ProjectInput,
  RefundLinkInput,
  ImportOutcome,
  ImportPreview,
  Ledger,
  LedgerState,
  Wallet,
  WalletInput,
} from "./types";

/** True inside the Tauri webview. The browser preview path exists so the ledger
 *  can be developed and tested against Playwright without a native build. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEMO_KEY = "stockpot.ledger.v1";

/** Preview builds have no settings command, so read the theme the panel saved.
 *  `__pending` is a one-shot seed that the stock store consumes on boot, hence
 *  the fallback to the persisted demo blob. */
function readDemoTheme(): string {
  try {
    const pending = localStorage.getItem("__pending");
    if (pending) {
      const theme = (JSON.parse(pending) as { theme?: string }).theme;
      if (theme) return theme;
    }
    const saved = localStorage.getItem("stockpot.demo.v1");
    if (saved) {
      const theme = (JSON.parse(saved) as { data?: { settings?: { theme?: string } } }).data
        ?.settings?.theme;
      if (theme) return theme;
    }
  } catch {
    /* default */
  }
  return "light";
}

function readDemoLang(): string {
  try {
    // `__pending` is a one-shot seed the stock store consumes on boot, so fall
    // back to whatever the settings window last saved.
    const pending = localStorage.getItem("__pending");
    if (pending) {
      const lang = (JSON.parse(pending) as { lang?: string }).lang;
      if (lang) return lang;
    }
    const saved = localStorage.getItem("stockpot.demo.v1");
    if (saved) {
      const lang = (JSON.parse(saved) as { data?: { settings?: { language?: string } } }).data
        ?.settings?.language;
      if (lang) return lang;
    }
  } catch {
    /* default */
  }
  return "zh";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** A month of plausible rows, so the overview has something to draw. */
function demoLedger(): Ledger {
  const rows: Array<[number, EntryInput["kind"], number, string, string, string, string]> = [
    [0, "expense", 3850, "餐饮", "微信零钱", "楼下便利店", "早餐+咖啡"],
    [0, "expense", 2680, "交通", "支付宝余额", "滴滴出行", "快车"],
    [1, "expense", 12800, "购物", "招商银行", "京东", "键盘"],
    [1, "income", 1850000, "工资", "招商银行", "某某科技", "月薪"],
    [2, "expense", 45200, "居住", "招商银行", "物业", "水电燃气"],
    [3, "expense", 7800, "餐饮", "微信零钱", "美团外卖", "午饭"],
    [4, "expense", 19900, "娱乐", "支付宝余额", "网易云音乐", "年度会员"],
    [5, "expense", 6300, "医疗", "微信零钱", "社区医院", "感冒药"],
    [6, "expense", 350000, "居住", "招商银行", "房东", "房租"],
    [7, "expense", 2400, "交通", "支付宝余额", "地铁", ""],
    [8, "expense", 15600, "人情", "微信零钱", "红包", "同事婚礼"],
    [9, "expense", 8900, "教育", "招商银行", "某书店", "两本书"],
    [3, "expense", 19900, "购物", "招商银行", "京东", "耳机（已退）"],
    [2, "expense", 8800, "餐饮", "微信零钱", "海底捞火锅", "聚餐"],
    [3, "expense", 8800, "餐饮", "支付宝余额", "海底捞火锅店", "聚餐"],
    [1, "expense", 120000, "其他", "招商银行", "花呗", "花呗还款"],
  ];
  // One demo project, so the browser preview can show the projects page and its
  // two charts without a Tauri backend. Four recent expense rows, three days.
  const demoProjectId = "demo-project-trip";
  const demoProjectRows = new Set([0, 2, 4, 7]);
  const entries = rows.map(([ago, kind, amount, category, account, counterparty, note], i) => {
    const d = daysAgo(ago);
    // The last row is a reversed purchase: full refund three days later.
    const refunded = i === rows.length - 1;
    return {
      id: `demo-${i}`,
      date: isoDate(d),
      time: `${pad(9 + (i % 10))}:${pad((i * 7) % 60)}`,
      kind,
      amount,
      category,
      account,
      counterparty,
      note,
      source: "manual" as const,
      externalId: "",
      excluded: false,
      projectId: demoProjectRows.has(i) ? demoProjectId : "",
      refundedAmount: refunded ? amount : 0,
      refundedAt: refunded ? isoDate(daysAgo(ago - 3)) : "",
      createdAt: `${isoDate(d)}T00:00:00`,
    };
  });
  return {
    entries,
    projects: [
      {
        id: demoProjectId,
        name: "周末短途",
        note: "三天两晚",
        startDate: isoDate(daysAgo(7)),
        endDate: isoDate(daysAgo(0)),
        archived: false,
        createdAt: `${isoDate(daysAgo(7))}T00:00:00`,
      },
    ],
    rules: [
      { id: "seed-0", pattern: "星巴克", category: "餐饮/咖啡" },
      { id: "seed-1", pattern: "瑞幸", category: "餐饮/咖啡" },
      { id: "seed-2", pattern: "滴滴", category: "交通/打车" },
      { id: "seed-3", pattern: "京东", category: "购物" },
    ],
    categories: (
      [
        ["餐饮", "", "expense", "food"],
        ["午餐", "餐饮", "expense", "food"],
        ["晚餐", "餐饮", "expense", "food"],
        ["咖啡", "餐饮", "expense", "coffee"],
        ["外卖", "餐饮", "expense", "takeout"],
        ["交通", "", "expense", "transport"],
        ["打车", "交通", "expense", "taxi"],
        ["地铁公交", "交通", "expense", "bus"],
        ["购物", "", "expense", "shopping"],
        ["居住", "", "expense", "home"],
        ["房租", "居住", "expense", "home"],
        ["水电燃气", "居住", "expense", "bolt"],
        ["娱乐", "", "expense", "fun"],
        ["旅行", "娱乐", "expense", "plane"],
        ["医疗", "", "expense", "health"],
        ["教育", "", "expense", "book"],
        ["通讯", "", "expense", "phone"],
        ["人情", "", "expense", "gift"],
        ["其他", "", "", "dots"],
        ["工资", "", "income", "salary"],
        ["理财", "", "income", "invest"],
      ] as const
    ).map(([name, parent, kind, icon]) => ({ name, parent, kind, icon, description: "" })),
    accounts: ["现金", "微信零钱", "支付宝余额", "招商银行"],
    wallets: [
      { id: "w1", name: "招商银行储蓄卡", kind: "debit", institution: "招商银行", balance: 1284500, note: "", updatedAt: "2026-11-01T09:00:00" },
      { id: "w2", name: "中信信用卡", kind: "credit", institution: "中信银行", balance: -328000, note: "本月待还", updatedAt: "2026-11-01T09:00:00" },
      { id: "w3", name: "沪深300指数基金", kind: "investment", institution: "天天基金", balance: 4560000, note: "", updatedAt: "2026-11-01T09:00:00" },
      { id: "w4", name: "个人养老金", kind: "pension", institution: "招商银行", balance: 1200000, note: "", updatedAt: "2026-11-01T09:00:00" },
      { id: "w5", name: "住房公积金", kind: "provident", institution: "", balance: 8600000, note: "", updatedAt: "2026-11-01T09:00:00" },
      { id: "w6", name: "医保个人账户", kind: "medical", institution: "", balance: 420000, note: "", updatedAt: "2026-11-01T09:00:00" },
    ],
    imports: [
      {
        id: "demo-import",
        file: "微信支付账单(20241001-20241031).csv",
        source: "wechat",
        added: 42,
        skipped: 3,
        importedAt: `${isoDate(daysAgo(3))}T20:14:00`,
      },
    ],
  };
}

function loadDemo(): Ledger {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return JSON.parse(raw) as Ledger;
  } catch {
    /* fall through to a fresh demo */
  }
  const fresh = demoLedger();
  saveDemo(fresh);
  return fresh;
}

function saveDemo(ledger: Ledger): Ledger {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(ledger));
  } catch {
    /* preview only */
  }
  return ledger;
}

function sortEntries(ledger: Ledger): Ledger {
  ledger.entries.sort((a, b) =>
    b.date === a.date ? b.time.localeCompare(a.time) : b.date.localeCompare(a.date),
  );
  return ledger;
}

/** Demo holdings so the asset panel is not empty in the browser preview. */
function demoAssets(): Assets {
  const lines = [
    { id: "sh600519", name: "贵州茅台", market: "a", shares: 100, price: 1437.51, value: 14375100, cost: 16000000 },
    { id: "hk00700", name: "腾讯控股", market: "hk", shares: 200, price: 418, value: 8360000, cost: 8000000 },
  ].map((line) => ({ ...line, pnl: line.value - line.cost }));
  return {
    currency: "CNY",
    lines,
    accounts: [
      { id: "acc-main", name: "主账户", holdings: 2, value: 22735100, cost: 24000000, pnl: -1264900 },
    ],
    marketValue: lines.reduce((sum, l) => sum + l.value, 0),
    cost: lines.reduce((sum, l) => sum + l.cost, 0),
    pnl: lines.reduce((sum, l) => sum + l.pnl, 0),
  };
}

export const ledgerApi = {
  async assets(): Promise<Assets> {
    if (!isTauri) return demoAssets();
    return invoke<Assets>("ledger_assets");
  },

  async state(): Promise<LedgerState> {
    if (!isTauri) {
      return {
        ledger: loadDemo(),
        dataDir: "浏览器预览（数据仅存于 localStorage）",
        theme: readDemoTheme(),
        language: readDemoLang(),
        colorScheme: "chinese",
      };
    }
    return invoke<LedgerState>("ledger_state");
  },

  /** 告诉后端「这批内容窗口已经画出来了」。后端据此跳过「再整份推一遍」。 */
  async ack(): Promise<void> {
    if (!isTauri) return;
    await invoke("ledger_ack");
  },

  async add(input: EntryInput): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.entries.push({
        id: `local-${Date.now()}`,
        date: input.date,
        time: input.time,
        kind: input.kind,
        amount: input.amount,
        category: input.category || "其他",
        account: input.account,
        counterparty: input.counterparty,
        note: input.note,
        source: "manual",
        externalId: "",
        excluded: input.excluded,
        createdAt: new Date().toISOString().slice(0, 19),
      });
      if (input.category && !ledger.categories.some((c) => c.name === input.category)) {
        ledger.categories.push({ name: input.category, parent: "", kind: "", icon: "dots", description: "" });
      }
      return saveDemo(sortEntries(ledger));
    }
    return invoke<Ledger>("ledger_add", { input });
  },

  async update(id: string, input: EntryInput): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      const entry = ledger.entries.find((e) => e.id === id);
      if (!entry) throw new Error("missing-entry");
      Object.assign(entry, input);
      return saveDemo(sortEntries(ledger));
    }
    return invoke<Ledger>("ledger_update", { id, input });
  },

  async remove(id: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.entries = ledger.entries.filter((e) => e.id !== id);
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_delete", { id });
  },

  /** Parse a bill without writing anything, for the confirmation dialog. */
  async previewImport(
    bytes: number[],
    source?: EntrySource,
  ): Promise<ImportPreview> {
    if (!isTauri) {
      // The preview cannot parse bills; an empty result is honest about that.
      return {
        source: source ?? "wechat",
        rows: 0,
        duplicates: 0,
        ignored: 0,
        expense: 0,
        income: 0,
        firstDate: "",
        lastDate: "",
        sample: [],
      };
    }
    return invoke<ImportPreview>("ledger_preview_import", { bytes, source: source ?? null });
  },

  async import(
    file: string,
    bytes: number[],
    ai = false,
    source?: EntrySource,
  ): Promise<ImportOutcome> {
    if (!isTauri) {
      // The preview cannot parse bills; report what would have happened.
      const ledger = loadDemo();
      return { ledger, added: 0, duplicates: 0, ignored: 0, refundsLinked: 0, source: source ?? "wechat" };
    }
    return invoke<ImportOutcome>("ledger_import", { file, bytes, ai, source: source ?? null });
  },

  async linkRefund(input: RefundLinkInput): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      const entry = ledger.entries.find((e) => e.id === input.entryId);
      if (!entry) throw new Error("missing-entry");
      const source = input.sourceId
        ? ledger.entries.find((e) => e.id === input.sourceId)
        : undefined;
      const amount = source ? source.amount : input.amount;
      const date = source ? source.date : input.date;
      if (amount <= 0) {
        entry.refundedAmount = 0;
        entry.refundedAt = "";
      } else {
        entry.refundedAmount = Math.min(entry.amount, (entry.refundedAmount ?? 0) + amount);
        entry.refundedAt = date;
      }
      if (source) ledger.entries = ledger.entries.filter((e) => e.id !== source.id);
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_link_refund", { input });
  },

  async addWallet(input: WalletInput): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.wallets.push({
        id: `local-w-${Date.now()}`,
        ...input,
        updatedAt: new Date().toISOString().slice(0, 19),
      } as Wallet);
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_add_wallet", { input });
  },

  async updateWallet(id: string, input: WalletInput): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      const wallet = ledger.wallets.find((w) => w.id === id);
      if (!wallet) throw new Error("missing-wallet");
      Object.assign(wallet, input);
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_update_wallet", { id, input });
  },

  async removeWallet(id: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.wallets = ledger.wallets.filter((w) => w.id !== id);
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_delete_wallet", { id });
  },

  async updateCategory(input: {
    name: string;
    parent: string;
    newName: string;
    newParent: string;
    icon: string;
    kind: string;
    description: string;
  }): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      const def = ledger.categories.find(
        (c) => c.name === input.name && c.parent === input.parent,
      );
      if (!def) throw new Error("missing-category");
      def.name = input.newName || def.name;
      def.parent = input.newParent;
      if (input.icon) def.icon = input.icon;
      def.description = input.description;
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_update_category", input);
  },

  async addRule(pattern: string, category: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      if (ledger.rules.some((r) => r.pattern === pattern)) throw new Error("duplicate");
      ledger.rules.push({ id: crypto.randomUUID(), pattern, category });
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_add_rule", { pattern, category });
  },

  async updateRule(id: string, pattern: string, category: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      const rule = ledger.rules.find((r) => r.id === id);
      if (rule) {
        rule.pattern = pattern || rule.pattern;
        rule.category = category || rule.category;
      }
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_update_rule", { id, pattern, category });
  },

  async deleteRule(id: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.rules = ledger.rules.filter((r) => r.id !== id);
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_delete_rule", { id });
  },

  async applyRules(): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_apply_rules");
  },

  async aiClassify(ids: string[]): Promise<AiResult> {
    if (!isTauri) return { suggestions: [], batches: 0, errors: [] };
    return invoke<AiResult>("ledger_ai_classify", { ids });
  },

  async aiPreview(ids: string[]): Promise<{ system: string; user: string }> {
    if (!isTauri) return { system: "", user: "" };
    return invoke<{ system: string; user: string }>("ledger_ai_preview", { ids });
  },

  async cleanup(): Promise<CleanupReport> {
    if (!isTauri) return { duplicates: [], repayments: [], total: 0, ignored: 0 };
    return invoke<CleanupReport>("ledger_cleanup");
  },

  /** Un-dismiss everything the user had ignored: one action, easy to reach. */
  async restoreIgnored(): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_restore_ignored");
  },

  async ignoreCleanup(kind: "duplicate" | "repayment", key: string, ignored: boolean): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_ignore_cleanup", { kind, key, ignored });
  },

  async mergeEntries(keep: string, remove: string[]): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_merge_entries", { keep, remove });
  },

  async setExcluded(ids: string[], excluded: boolean): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_set_excluded", { ids, excluded });
  },

  /** Move rows in or out of the archive without deleting anything. */
  async setArchived(ids: string[], archived: boolean): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_set_archived", { ids, archived });
  },

  /** Keep the most complete row of every duplicate cluster, archive the rest. */
  async autoTidy(): Promise<AutoTidyOutcome> {
    if (!isTauri) {
      return { ledger: loadDemo(), groups: 0, archived: 0, kept: [], archivedIds: [] };
    }
    return invoke<AutoTidyOutcome>("ledger_auto_tidy");
  },

  async recategorize(ids: string[], category: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      for (const entry of ledger.entries) {
        if (ids.includes(entry.id)) entry.category = category;
      }
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_recategorize", { ids, category });
  },

  async addCategory(name: string, parent = "", icon = "", kind = "", description = ""): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      if (ledger.categories.some((c) => c.name === name && c.parent === parent)) {
        throw new Error("duplicate");
      }
      ledger.categories.push({ name, parent, icon: icon || "dots", kind: kind as never, description });
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_add_category", { name, parent, icon, kind, description });
  },

  async removeCategory(path: string): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.categories = ledger.categories.filter(
        (c) => `${c.parent ? `${c.parent}/` : ""}${c.name}` !== path && c.parent !== path,
      );
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_delete_category", { path });
  },

  async addProject(input: ProjectInput): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.projects.push({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString().slice(0, 19) });
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_add_project", { input });
  },
  async updateProject(id: string, input: ProjectInput): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_update_project", { id, input });
  },
  async deleteProject(id: string): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_delete_project", { id });
  },
  async setProject(ids: string[], projectId: string): Promise<Ledger> {
    if (!isTauri) return loadDemo();
    return invoke<Ledger>("ledger_set_project", { ids, projectId });
  },

  async resetCategories(): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      // Preview keeps its existing tree; the native reset is tested in Rust.
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_reset_categories");
  },

  async clear(): Promise<Ledger> {
    if (!isTauri) {
      const ledger = loadDemo();
      ledger.entries = [];
      ledger.imports = [];
      return saveDemo(ledger);
    }
    return invoke<Ledger>("ledger_clear");
  },
};
