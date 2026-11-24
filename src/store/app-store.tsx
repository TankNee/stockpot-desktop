import * as React from "react";
import { api } from "@/lib/api";
import { translate, languageNames, type Lang } from "@/lib/i18n";
import type {
  Account,
  AppPayload,
  ChartData,
  KlineData,
  Market,
  MergedPosition,
  Period,
  Position,
  Quote,
  SearchResult,
  SessionKey,
  Settings,
  Stock,
} from "@/lib/types";
import { convertCurrency } from "@/lib/format";
import { lotsFor, mergePosition } from "@/lib/portfolio";

interface Toast {
  id: number;
  message: string;
  tone: "neutral" | "up" | "down";
}

interface Ctx {
  ready: boolean;
  data: AppPayload["data"] | null;
  quotes: Record<string, Quote>;
  snapshot: AppPayload["snapshot"] | null;
  sessions: Record<Market, SessionKey> | null;
  trayLabel: string;
  dataFile: string;
  launchAtLogin: boolean;
  settings: Settings | null;
  stocks: Stock[];
  accounts: Account[];
  /** Merged (weighted-average) holding for a stock across all accounts. */
  mergedPosition: (stock: Stock) => MergedPosition | null;
  /** Per-account lots behind a merged position, largest first. */
  lots: (stock: Stock) => { account: Account; position: Position; weight: number }[];
  loading: boolean;
  searching: boolean;
  refreshing: boolean;
  error: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: Lang;
  refresh: () => Promise<void>;
  search: (keyword: string) => Promise<SearchResult[]>;
  /** One-off quote lookup for search results that are not on the watchlist. */
  previewQuotes: (ids: string[]) => Promise<void>;
  addStock: (result: SearchResult) => Promise<void>;
  removeStock: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  setPosition: (
    accountId: string,
    stockId: string,
    cost: number | null,
    shares: number | null,
  ) => Promise<void>;
  /** Position edits from the settings table; same command, shorter name. */
  selPosition: (
    accountId: string,
    stockId: string,
    cost: number | null,
    shares: number | null,
  ) => Promise<void>;
  createAccount: (name: string) => Promise<void>;
  renameAccount: (id: string, name: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  updateAlert: (id: string, target: number | null, enabled: boolean) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  clearStocks: () => Promise<void>;
  loadChart: (id: string) => Promise<ChartData>;
  loadKline: (id: string, period: Period) => Promise<KlineData>;
  pnl: (stock: Stock) => {
    total: number;
    daily: number;
    percent: number;
    /** Daily P&L as a percentage of cost basis, not of today's move. */
    dailyPercent: number;
    totalPercent: number;
  } | null;
  totals: () => { total: number; daily: number; cost: number; percent: number; dailyPercent: number };
  notifyGranted: boolean;
  notifyChecked: boolean;
  requestNotifications: () => Promise<boolean>;
  testNotification: () => Promise<void>;
  toasts: Toast[];
  pushToast: (message: string, tone?: Toast["tone"]) => void;
  setLaunchAtLogin: (on: boolean) => Promise<void>;
  quit: () => void;
  openSettings: () => void;
  openDataDir: () => void;
  hasHoldings: boolean;
}

const StoreContext = React.createContext<Ctx | null>(null);

export function useStore(): Ctx {
  const ctx = React.useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [payload, setPayload] = React.useState<AppPayload | null>(null);
  const [dataFile, setDataFile] = React.useState("");
  const [launchAtLogin, setLaunchState] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const [notifyGranted, setNotifyGranted] = React.useState(false);
  const [notifyChecked, setNotifyChecked] = React.useState(false);
  const [sessions, setSessions] = React.useState<Record<Market, string> | null>(null);
  const toastId = React.useRef(0);

  const pushToast = React.useCallback((message: string, tone: Toast["tone"] = "neutral") => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2600);
  }, []);

  const applyPayload = React.useCallback((next: AppPayload) => {
    setPayload(next);
    if (next.sessions) setSessions(next.sessions);
    if (next.dataFile) setDataFile(next.dataFile);
    if (typeof next.launchAtLogin === "boolean") setLaunchState(next.launchAtLogin);
    if (typeof next.notifyGranted === "boolean") {
      setNotifyGranted(next.notifyGranted);
      setNotifyChecked(true);
    }
    setError(null);
  }, []);

  React.useEffect(() => {
    let alive = true;
    api
      .getApp()
      .then((next) => {
        if (!alive) return;
        applyPayload(next);
        void api.clientReady();
      })
      .catch((err) => {
        if (alive) setError(String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [applyPayload]);

  // Session badges change on wall-clock boundaries, not on quote ticks.
  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .sessionsNow()
        .then((next) => {
          if (alive) setSessions(next as Record<Market, string>);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // The backend pushes a fresh snapshot after every scheduler tick.
  React.useEffect(() => {
    if (!api.isTauri) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<AppPayload>("snapshot", (event) => {
        applyPayload(event.payload);
      }).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
      listen<AppPayload>("app-payload", (event) => {
        applyPayload(event.payload);
      });
      listen("open-settings", () => {
        window.dispatchEvent(new CustomEvent("stockpot:open-settings"));
      });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyPayload]);

  // Theme resolution: "system" follows macOS, and the scheme attribute swaps
  // the gain/loss colours without touching the rest of the palette.
  const settings = payload?.data.settings ?? null;
  const lang = (settings?.language ?? "zh") as Lang;
  const theme = settings?.theme ?? "system";
  const colorScheme = settings?.colorScheme ?? "chinese";

  React.useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      root.classList.toggle("dark", dark);
      root.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  React.useEffect(() => {
    document.documentElement.dataset.scheme = colorScheme;
  }, [colorScheme]);

  React.useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "ja" ? "ja-JP" : "en";
    document.title = translate(lang, "app.name");
  }, [lang]);

  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.refresh();
      applyPayload(next);
    } catch (err) {
      setError(String(err));
      pushToast(translate(lang, "toast.refreshFailed"), "down");
    } finally {
      setRefreshing(false);
    }
  }, [applyPayload, lang, pushToast]);

  const search = React.useCallback(async (keyword: string) => {
    setSearching(true);
    try {
      return await api.search(keyword);
    } finally {
      setSearching(false);
    }
  }, []);

  const previewQuotes = React.useCallback(async (ids: string[]) => {
    const missing = ids.filter((id) => !payload?.snapshot.quotes[id]);
    if (missing.length === 0) return;
    try {
      const next = await api.previewQuotes(missing);
      if (next) applyPayload(next);
    } catch {
      // A failed preview is harmless: the row simply shows no price.
    }
  }, [applyPayload, payload]);

  const addStock = React.useCallback(
    async (result: SearchResult) => {
      const exists = payload?.data.stocks.some((s) => s.id === result.id);
      if (exists) {
        pushToast(translate(lang, "toast.exists", { name: result.name }));
        return;
      }
      const next = await api.addStock(result);
      applyPayload(next);
      pushToast(translate(lang, "toast.added", { name: result.name }), "up");
    },
    [applyPayload, lang, payload, pushToast],
  );

  const removeStock = React.useCallback(
    async (id: string) => {
      const name = payload?.data.stocks.find((s) => s.id === id)?.name ?? "";
      const next = await api.removeStock(id);
      applyPayload(next);
      pushToast(translate(lang, "toast.removed", { name }), "down");
    },
    [applyPayload, lang, payload, pushToast],
  );

  const reorder = React.useCallback(
    async (ids: string[]) => {
      const next = await api.reorderStocks(ids);
      applyPayload(next);
    },
    [applyPayload],
  );

  const setPosition = React.useCallback(
    async (accountId: string, stockId: string, cost: number | null, shares: number | null) => {
      const next = await api.setPosition(accountId, stockId, cost, shares);
      applyPayload(next);
    },
    [applyPayload],
  );

  const createAccount = React.useCallback(
    async (name: string) => {
      const next = await api.createAccount(name);
      applyPayload(next);
    },
    [applyPayload],
  );

  const renameAccount = React.useCallback(
    async (id: string, name: string) => {
      const next = await api.renameAccount(id, name);
      applyPayload(next);
    },
    [applyPayload],
  );

  const deleteAccount = React.useCallback(
    async (id: string) => {
      const next = await api.deleteAccount(id);
      applyPayload(next);
    },
    [applyPayload],
  );

  const updateAlert = React.useCallback(
    async (id: string, target: number | null, enabled: boolean) => {
      const next = await api.updateAlert(id, target, enabled);
      applyPayload(next);
    },
    [applyPayload],
  );

  const updateSettings = React.useCallback(
    async (patch: Partial<Settings>) => {
      // Optimistic: theme and language must switch without waiting on disk.
      setPayload((prev) =>
        prev
          ? { ...prev, data: { ...prev.data, settings: { ...prev.data.settings, ...patch } } }
          : prev,
      );
      const next = await api.updateSettings(patch as Record<string, unknown>);
      applyPayload(next);
    },
    [applyPayload],
  );

  const clearStocks = React.useCallback(async () => {
    const next = await api.clearStocks();
    applyPayload(next);
  }, [applyPayload]);

  const loadChart = React.useCallback((id: string) => api.chart(id), []);
  const loadKline = React.useCallback(
    (id: string, period: Period) => api.kline(id, period),
    [],
  );

  const setLaunchAtLogin = React.useCallback(async (on: boolean) => {
    const actual = await api.setAutostart(on);
    setLaunchState(actual);
  }, []);

  const requestNotifications = React.useCallback(async () => {
    const granted = await api.requestNotificationPermission();
    setNotifyGranted(granted);
    setNotifyChecked(true);
    return granted;
  }, []);

  const testNotification = React.useCallback(async () => {
    const ok = await api.testNotification();
    setNotifyGranted(ok);
  }, []);

  const stocks = payload?.data.stocks ?? [];
  const accounts = payload?.data.accounts ?? [];
  const quotes = payload?.snapshot.quotes ?? {};
  const rates = payload?.snapshot.rates;
  const currency = settings?.currency ?? "CNY";

  const mergedPosition = React.useCallback(
    (stock: Stock) => mergePosition(accounts, stock.id),
    [accounts],
  );

  const lots = React.useCallback(
    (stock: Stock) => lotsFor(accounts, stock.id),
    [accounts],
  );

  const pnl = React.useCallback(
    (stock: Stock) => {
      const merged = mergePosition(accounts, stock.id);
      const quote = quotes[stock.id];
      if (!quote || !merged) return null;
      // Percentages are relative to cost basis, so daily and total are directly
      // comparable and match the summary strip's definition.
      const basis = merged.costPrice * merged.shares;
      return {
        total: (quote.price - merged.costPrice) * merged.shares,
        daily: quote.change * merged.shares,
        percent: basis > 0 ? ((quote.price - merged.costPrice) / merged.costPrice) * 100 : 0,
        dailyPercent: basis > 0 ? (quote.change * merged.shares) / basis * 100 : 0,
        totalPercent: basis > 0 ? ((quote.price - merged.costPrice) * merged.shares) / basis * 100 : 0,
      };
    },
    [accounts, quotes],
  );

  const totals = React.useCallback(() => {
    let total = 0;
    let daily = 0;
    let cost = 0;
    if (!rates) return { total, daily, cost, percent: 0, dailyPercent: 0 };
    for (const stock of stocks) {
      const merged = mergePosition(accounts, stock.id);
      const quote = quotes[stock.id];
      if (!merged || !quote) continue;
      total += convertCurrency(
        (quote.price - merged.costPrice) * merged.shares,
        stock.market,
        currency,
        rates,
      );
      daily += convertCurrency(quote.change * merged.shares, stock.market, currency, rates);
      cost += convertCurrency(merged.basis, stock.market, currency, rates);
    }
    return {
      total,
      daily,
      cost,
      percent: cost > 0 ? (total / cost) * 100 : 0,
      dailyPercent: cost > 0 ? (daily / cost) * 100 : 0,
    };
  }, [accounts, currency, quotes, rates, stocks]);

  const hasHoldings = React.useMemo(
    () => stocks.some((s) => mergePosition(accounts, s.id) != null),
    [accounts, stocks],
  );

  const value: Ctx = {
    ready: payload != null,
    data: payload?.data ?? null,
    quotes,
    snapshot: payload?.snapshot ?? null,
    sessions: sessions as Record<Market, SessionKey> | null,
    trayLabel: payload?.trayLabel ?? "",
    dataFile,
    launchAtLogin,
    settings,
    stocks,
    accounts,
    mergedPosition,
    lots,
    loading,
    searching,
    refreshing,
    error,
    t,
    lang,
    refresh,
    search,
    previewQuotes,
    addStock,
    removeStock,
    reorder,
    setPosition,
    selPosition: setPosition,
    createAccount,
    renameAccount,
    deleteAccount,
    updateAlert,
    updateSettings,
    clearStocks,
    loadChart,
    loadKline,
    pnl,
    totals,
    notifyGranted,
    notifyChecked,
    requestNotifications,
    testNotification,
    toasts,
    pushToast,
    setLaunchAtLogin,
    quit: () => void api.quit(),
    openSettings: () => void api.openSettings(),
    openDataDir: () => void api.openDataDir(),
    hasHoldings,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export { languageNames };
