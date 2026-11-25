import * as React from "react";
import type { Lang } from "@/lib/i18n";
import { translate } from "@/lib/i18n";
import { isTauri, ledgerApi } from "./api";
import type {
  Assets,
  AutoTidyOutcome,
  CleanupReport,
  EntryInput,
  EntrySource,
  ProjectInput,
  RefundLinkInput,
  ImportPreview,
  ImportRecord,
  Ledger,
  LedgerEntry,
  Wallet,
  WalletInput,
} from "./types";

// 纯规则搬到 money.ts 了，这里原样转出，老引用不用改
import { countsTowardTotals, effectiveAmount, monthOf } from "./money";

export { countsTowardTotals, effectiveAmount, monthOf };

/** Cents → "1,234.56". Kept separate from `formatMoney` (which deals in yuan and
 *  a display currency) because the ledger is entirely local-currency cents. */
export function formatCents(cents: number, lang: Lang = "zh"): string {
  const locale = lang === "en" ? "en-US" : "zh-CN";
  const abs = Math.abs(cents) / 100;
  return abs.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Cents → a short label for tight spaces: 850, 1.1k, 23k, 1.2m. */
export function formatCompact(cents: number, lang: Lang = "zh"): string {
  const yuan = Math.abs(cents) / 100;
  if (yuan < 1000) {
    return yuan < 10 ? yuan.toFixed(yuan % 1 === 0 ? 0 : 1) : String(Math.round(yuan));
  }
  const locale = lang === "en" ? "en-US" : "zh-CN";
  if (yuan >= 1_000_000) {
    return `${(yuan / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 1 })}m`;
  }
  if (yuan >= 100_000) return `${Math.round(yuan / 1000)}k`;
  return `${(yuan / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}k`;
}

/** Cents → "¥1,234.56", with an explicit sign when asked for. */
export function formatYuan(cents: number, lang: Lang = "zh", signed = false): string {
  const sign = cents < 0 ? "-" : signed ? "+" : "";
  return `${sign}¥${formatCents(Math.abs(cents), lang)}`;
}

/** Shift a `YYYY-MM` key by whole months, crossing year boundaries. */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const index = year * 12 + (mon - 1) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMon = (index % 12) + 1;
  return `${nextYear}-${String(nextMon).padStart(2, "0")}`;
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface CategoryTotal {
  category: string;
  total: number;
  share: number;
}

export interface MonthSummary {
  month: string;
  expense: number;
  income: number;
  net: number;
  /** Expense by category, largest first. */
  byCategory: CategoryTotal[];
  count: number;
}

export function summarize(entries: LedgerEntry[], month: string): MonthSummary {
  const rows = entries.filter((e) => countsTowardTotals(e) && monthOf(e.date) === month);
  let expense = 0;
  let income = 0;
  const buckets = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "expense") {
      // Refunded money never left the account, so it must not be counted.
      const amount = effectiveAmount(row);
      expense += amount;
      buckets.set(row.category, (buckets.get(row.category) ?? 0) + amount);
    } else if (row.kind === "income") {
      income += row.amount;
    }
  }
  const byCategory = [...buckets.entries()]
    .map(([category, total]) => ({
      category,
      total,
      share: expense > 0 ? total / expense : 0,
    }))
    .sort((a, b) => b.total - a.total);
  return { month, expense, income, net: income - expense, byCategory, count: rows.length };
}

/** Balance totals per kind, plus the net across everything. Credit cards are
 *  stored as negative balances, so the net is a plain sum. */
export function walletTotals(wallets: Wallet[]): {
  byKind: Map<string, number>;
  assets: number;
  liabilities: number;
  net: number;
} {
  const byKind = new Map<string, number>();
  let assets = 0;
  let liabilities = 0;
  for (const wallet of wallets) {
    byKind.set(wallet.kind, (byKind.get(wallet.kind) ?? 0) + wallet.balance);
    if (wallet.balance >= 0) assets += wallet.balance;
    else liabilities += wallet.balance;
  }
  return { byKind, assets, liabilities, net: assets + liabilities };
}

/** Top-level category of a path: "餐饮/咖啡" → "餐饮". */
function rootCategory(path: string): string {
  return path.split("/")[0] || "其他";
}

export interface Matrix {
  /** Row labels, largest total first. */
  rows: Array<{ category: string; total: number; cells: number[] }>;
  /** Column totals across every row. */
  columnTotals: number[];
  max: number;
  grand: number;
}

function buildMatrix(
  entries: LedgerEntry[],
  keys: string[],
  keyOf: (entry: LedgerEntry) => string,
  columnOf: (entry: LedgerEntry) => number,
  columns: number,
): Matrix {
  const allowed = new Set(keys);
  const buckets = new Map<string, number[]>();
  const columnTotals = new Array(columns).fill(0);
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (!countsTowardTotals(entry) || entry.kind !== "expense") continue;
    if (!allowed.has(keyOf(entry))) continue;
    const column = columnOf(entry);
    if (column < 0 || column >= columns) continue;
    const amount = effectiveAmount(entry);
    if (amount <= 0) continue;
    const row = buckets.get(keyOf(entry)) ?? new Array(columns).fill(0);
    row[column] += amount;
    buckets.set(keyOf(entry), row);
    columnTotals[column] += amount;
    totals.set(keyOf(entry), (totals.get(keyOf(entry)) ?? 0) + amount);
  }
  const rows = [...buckets.entries()]
    .map(([category, cells]) => ({ category, cells, total: totals.get(category) ?? 0 }))
    .sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.flatMap((row) => row.cells));
  const grand = columnTotals.reduce((sum, value) => sum + value, 0);
  return { rows, columnTotals, max, grand };
}

const MONTH_KEYS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];

/** Category × month spending for one year. */
export function categoryByMonth(entries: LedgerEntry[], year: string, columns: string[]): Matrix {
  const scoped = entries.filter((entry) => entry.date.slice(0, 4) === year);
  return buildMatrix(
    scoped,
    columns,
    (entry) => rootCategory(entry.category),
    (entry) => MONTH_KEYS.indexOf(entry.date.slice(5, 7)),
    12,
  );
}

/** Category × day spending for one month. */
export function categoryByDay(entries: LedgerEntry[], month: string, columns: string[]): Matrix {
  const [year, mon] = month.split("-").map(Number);
  const days = new Date(year, mon, 0).getDate();
  const scoped = entries.filter((entry) => monthOf(entry.date) === month);
  return buildMatrix(
    scoped,
    columns,
    (entry) => rootCategory(entry.category),
    (entry) => Number(entry.date.slice(8, 10)) - 1,
    days,
  );
}

/** Month-by-month totals for a year, for the annual bar chart. */
export function yearMonths(
  entries: LedgerEntry[],
  year: string,
): Array<{ month: number; expense: number; income: number }> {
  const rows = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, expense: 0, income: 0 }));
  for (const entry of entries) {
    if (!countsTowardTotals(entry) || entry.date.slice(0, 4) !== year) continue;
    const slot = rows[Number(entry.date.slice(5, 7)) - 1];
    if (!slot) continue;
    if (entry.kind === "expense") slot.expense += effectiveAmount(entry);
    if (entry.kind === "income") slot.income += entry.amount;
  }
  return rows;
}

/** Per-day expense totals for a month, used by the overview sparkline. */
export function dailyTrend(
  entries: LedgerEntry[],
  month: string,
): Array<{ day: number; expense: number; income: number }> {
  const [year, mon] = month.split("-").map(Number);
  const days = new Date(year, mon, 0).getDate();
  const rows = Array.from({ length: days }, (_, i) => ({ day: i + 1, expense: 0, income: 0 }));
  for (const entry of entries) {
    if (!countsTowardTotals(entry) || monthOf(entry.date) !== month) continue;
    const day = Number(entry.date.slice(8, 10));
    const slot = rows[day - 1];
    if (!slot) continue;
    if (entry.kind === "expense") slot.expense += effectiveAmount(entry);
    if (entry.kind === "income") slot.income += entry.amount;
  }
  return rows;
}

/** Newest month that actually has rows, so the window does not open on an empty
 *  bucket when the user has not logged anything this month. */
export function latestMonth(entries: LedgerEntry[]): string {
  let best = "";
  for (const entry of entries) {
    const m = monthOf(entry.date);
    if (m > best) best = m;
  }
  return best || currentMonth();
}

interface LedgerContext {
  ledger: Ledger | null;
  assets: Assets | null;
  dataDir: string;
  loading: boolean;
  error: string | null;
  lang: Lang;
  theme: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  month: string;
  setMonth: (month: string) => void;
  months: string[];
  summary: MonthSummary | null;
  /** Creates an entry and returns it, so callers can attach the new row to a
   *  project in the same gesture. */
  add: (input: EntryInput) => Promise<LedgerEntry | null>;
  update: (id: string, input: EntryInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  linkRefund: (input: RefundLinkInput) => Promise<void>;
  cleanup: () => Promise<CleanupReport>;
  mergeEntries: (keep: string, remove: string[]) => Promise<void>;
  ignoreCleanup: (kind: "duplicate" | "repayment", key: string, ignored: boolean) => Promise<void>;
  restoreIgnored: () => Promise<void>;
  setExcluded: (ids: string[], excluded: boolean) => Promise<void>;
  /** Move rows in or out of the archive (整理账单 never deletes). */
  setArchived: (ids: string[], archived: boolean) => Promise<void>;
  /** Resolve every duplicate cluster, keeping the most complete row. */
  autoTidy: () => Promise<AutoTidyOutcome>;
  addProject: (input: ProjectInput) => Promise<void>;
  updateProject: (id: string, input: ProjectInput) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setProject: (ids: string[], projectId: string) => Promise<void>;
  addWallet: (input: WalletInput) => Promise<void>;
  updateWallet: (id: string, input: WalletInput) => Promise<void>;
  removeWallet: (id: string) => Promise<void>;
  addCategory: (name: string) => Promise<void>;
  removeCategory: (name: string) => Promise<void>;
  /** Parse without writing, for the import confirmation dialog. */
  previewImport: (bytes: number[], source?: EntrySource) => Promise<ImportPreview>;
  importBill: (
    file: string,
    bytes: number[],
    ai?: boolean,
    /** Force the platform instead of letting the parser detect it. */
    source?: EntrySource,
  ) => Promise<ImportResult>;
  clearAll: () => Promise<void>;
  reload: () => Promise<void>;
  lastImports: ImportRecord[];
}

export interface ImportResult {
  added: number;
  duplicates: number;
  ignored: number;
  source: string;
}

const Ctx = React.createContext<LedgerContext | null>(null);

export function useLedger(): LedgerContext {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("useLedger must be used inside LedgerProvider");
  return ctx;
}

function readPendingLang(): Lang {
  try {
    const raw = localStorage.getItem("__pending");
    if (raw) {
      const parsed = JSON.parse(raw) as { lang?: Lang };
      if (parsed.lang) return parsed.lang;
    }
    const saved = localStorage.getItem("stockpot.demo.v1");
    if (saved) {
      const parsed = JSON.parse(saved) as { data?: { settings?: { language?: Lang } } };
      const lang = parsed.data?.settings?.language;
      if (lang) return lang;
    }
  } catch {
    /* default below */
  }
  return "zh";
}

export function LedgerProvider({ children }: { children: React.ReactNode }) {
  const [ledger, setLedger] = React.useState<Ledger | null>(null);
  const [assets, setAssets] = React.useState<Assets | null>(null);
  const [dataDir, setDataDir] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [month, setMonth] = React.useState(currentMonth());
  const [lang, setLang] = React.useState<Lang>(readPendingLang);
  const [theme, setTheme] = React.useState<string>("light");
  const [colorScheme, setColorScheme] = React.useState<string>("chinese");

  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [state, holdings] = await Promise.all([
        ledgerApi.state(),
        // A failure here must not take the ledger down; the panel just hides.
        ledgerApi.assets().catch(() => null),
      ]);
      setLedger(state.ledger);
      setAssets(holdings);
      if (state.theme) setTheme(state.theme);
      if (state.language) setLang(state.language as Lang);
      if (state.colorScheme) setColorScheme(state.colorScheme);
      setDataDir(state.dataDir);
      setMonth((m) => (state.ledger.entries.some((e) => monthOf(e.date) === m) ? m : latestMonth(state.ledger.entries)));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Apply the app's theme to this window. `system` follows macOS, which is what
  // the stock panel does too.
  React.useEffect(() => {
    const root = document.documentElement;
    const dark =
      theme === "dark" ||
      (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.scheme = colorScheme === "western" ? "western" : "chinese";
  }, [theme, colorScheme]);

  // The panel writes the language into the shared demo blob; follow it so the
  // ledger window is not stuck in a different language.
  React.useEffect(() => {
    const onStorage = () => setLang(readPendingLang());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // The settings window emits this whenever anything is saved; language and
  // theme live there, so the ledger re-reads them instead of caching forever.
  React.useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<Ledger>("ledger-changed", (event) => {
        // 后端要是发了个不完整的文档，宁可先不换：塞进去会让整页渲染炸掉
        const next = event.payload;
        if (!next || !Array.isArray(next.entries)) return;
        setLedger(next);
      });
    })();
    return () => unlisten?.();
  }, []);

  React.useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ data?: { settings?: { language?: string; theme?: string } } }>(
        "settings-changed",
        (event) => {
          const settings = event.payload?.data?.settings;
          if (settings?.language) setLang(settings.language as Lang);
          if (settings?.theme) setTheme(settings.theme);
        },
      );
    })();
    return () => unlisten?.();
  }, []);

  const months = React.useMemo(() => {
    const set = new Set<string>([currentMonth()]);
    for (const entry of ledger?.entries ?? []) set.add(monthOf(entry.date));
    return [...set].sort().reverse();
  }, [ledger]);

  const summary = React.useMemo(
    () => (ledger ? summarize(ledger.entries, month) : null),
    [ledger, month],
  );

  const run = React.useCallback(
    async (op: () => Promise<Ledger>) => {
      try {
        const next = await op();
        setLedger(next);
        setError(null);
      } catch (err) {
        setError(String(err));
        throw err;
      }
    },
    [],
  );

  const value: LedgerContext = {
    ledger,
    assets,
    dataDir,
    loading,
    error,
    lang,
    theme,
    t,
    month,
    setMonth,
    months,
    summary,
    add: async (input) => {
      // Diff the ids so the caller gets the row that was actually inserted,
      // without the backend having to return it separately.
      const before = new Set((ledger?.entries ?? []).map((entry) => entry.id));
      let created: LedgerEntry | null = null;
      await run(async () => {
        const next = await ledgerApi.add(input);
        created = next.entries.find((entry) => !before.has(entry.id)) ?? null;
        return next;
      });
      return created;
    },
    update: (id, input) => run(() => ledgerApi.update(id, input)),
    remove: (id) => run(() => ledgerApi.remove(id)),
    linkRefund: (input) => run(() => ledgerApi.linkRefund(input)),
    cleanup: () => ledgerApi.cleanup(),
    mergeEntries: (keep, remove) => run(() => ledgerApi.mergeEntries(keep, remove)),
    ignoreCleanup: (kind, key, ignored) =>
      run(() => ledgerApi.ignoreCleanup(kind, key, ignored)),
    restoreIgnored: () => run(() => ledgerApi.restoreIgnored()),
    setExcluded: (ids, excluded) => run(() => ledgerApi.setExcluded(ids, excluded)),
    setArchived: (ids, archived) => run(() => ledgerApi.setArchived(ids, archived)),
    autoTidy: async () => {
      const outcome = await ledgerApi.autoTidy();
      // The tidy already returns the new ledger; adopting it skips a round trip.
      setLedger(outcome.ledger);
      return outcome;
    },
    addProject: (input) => run(() => ledgerApi.addProject(input)),
    updateProject: (id, input) => run(() => ledgerApi.updateProject(id, input)),
    deleteProject: (id) => run(() => ledgerApi.deleteProject(id)),
    setProject: (ids, projectId) => run(() => ledgerApi.setProject(ids, projectId)),
    addWallet: (input) => run(() => ledgerApi.addWallet(input)),
    updateWallet: (id, input) => run(() => ledgerApi.updateWallet(id, input)),
    removeWallet: (id) => run(() => ledgerApi.removeWallet(id)),
    addCategory: (name) => run(() => ledgerApi.addCategory(name)),
    removeCategory: (name) => run(() => ledgerApi.removeCategory(name)),
    previewImport: (bytes, source) => ledgerApi.previewImport(bytes, source),
    importBill: async (file, bytes, ai = false, source) => {
      const outcome = await ledgerApi.import(file, bytes, ai, source);
      setLedger(outcome.ledger);
      return {
        added: outcome.added,
        duplicates: outcome.duplicates,
        ignored: outcome.ignored,
        source: outcome.source,
      };
    },
    clearAll: () => run(() => ledgerApi.clear()),
    reload: load,
    lastImports: ledger?.imports ?? [],
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
