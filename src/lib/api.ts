import type {
  Account,
  AgentSkills,
  AppPayload,
  Candle,
  ChartData,
  ChartPoint,
  KlineData,
  Market,
  Period,
  SearchResult,
} from "./types";

/** Placeholder quotes for browser preview. Deliberately plausible: a Taiwanese
 *  ADR with a big move, a quiet bank stock, a Hong Kong laggard. */
const demoQuotes: Record<
  string,
  { name: string; price: number; change: number; extended?: number; extLabel?: "pre" | "post" | "night" }
> = {
  sh600519: { name: "贵州茅台", price: 1437.51, change: -7.48 },
  sz300750: { name: "宁德时代", price: 249.11, change: 0.47 },
  sh513130: { name: "恒生科技ETF华泰柏瑞", price: 0.501, change: 0.001 },
  hk00700: { name: "腾讯控股", price: 418.0, change: -0.4 },
  hk03690: { name: "美团-W", price: 76.2, change: 1.05 },
  usr_aapl: { name: "苹果", price: 350.69, change: 8.32, extended: 350.5, extLabel: "post" },
  usr_nvda: { name: "英伟达", price: 178.67, change: -7.97, extended: 179.4, extLabel: "post" },
  usr_rklb: { name: "Rocket Lab", price: 78.59, change: 7.28, extended: 74.75, extLabel: "night" },
  usr_tsm: { name: "台积电", price: 345.98, change: 6.71, extended: 346.2, extLabel: "night" },
  kr_005930: { name: "三星电子", price: 199700, change: 9800 },
};

function nowMinus(seconds: number): string {
  const d = new Date(Date.now() - seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

const demoData: AppPayload = {
  data: {
    stocks: [
      { id: "sh600519", code: "600519", name: "贵州茅台", market: "a" },
      { id: "sh513130", code: "513130", name: "恒生科技ETF华泰柏瑞", market: "a" },
      {
        id: "hk00700",
        code: "00700",
        name: "腾讯控股",
        market: "hk",
        alert: { targetPrice: 430, direction: "rise", enabled: true },
      },
      { id: "hk03690", code: "03690", name: "美团-W", market: "hk" },
      { id: "usr_rklb", code: "RKLB", name: "Rocket Lab", market: "us" },
      { id: "usr_tsm", code: "TSM", name: "台积电", market: "us" },
      { id: "usr_aapl", code: "AAPL", name: "苹果", market: "us" },
      { id: "kr_005930", code: "005930", name: "三星电子", market: "kr" },
    ],
    settings: {
      menuBarMode: "stock",
      menuBarStockId: "sh600519",
      refreshInterval: 5,
      colorScheme: "chinese",
      currency: "CNY",
      sortRule: "changeDesc",
      usPriceMode: "session",
      groupHoldings: false,
      theme: "system",
      language: "zh",
      launchAtLogin: false,
      showDockIcon: false,
      menuBarPnlFormat: "amount",
      flashDuration: "normal",
      pnlDisplay: "amount",
      updateSource: "server",
      githubToken: "",
      serverUrl: "",
    },
    // Two brokers holding the same names at different costs, which is the case
    // the merged row has to get right.
    accounts: [
      {
        id: "acc-main",
        name: "主账户",
        entries: {
          sh600519: { costPrice: 1512.4, shares: 40 },
          sh513130: { costPrice: 0.472, shares: 120000 },
          hk00700: { costPrice: 402.6, shares: 150 },
          hk03690: { costPrice: 71.2, shares: 300 },
          usr_rklb: { costPrice: 42.1, shares: 40 },
          usr_aapl: { costPrice: 310.0, shares: 8 },
        },
      },
      {
        id: "acc-ibkr",
        name: "IBKR",
        entries: {
          sh600519: { costPrice: 1330.0, shares: 20 },
          hk00700: { costPrice: 355.0, shares: 50 },
          usr_aapl: { costPrice: 296.4, shares: 4 },
        },
      },
      { id: "acc-long", name: "长线观察", entries: {} },
    ],
  },
  snapshot: {
    rates: { usdCny: 6.6708, usdHkd: 7.8428, usdKrw: 1347.37 },
    updatedAt: Math.floor(Date.now() / 1000),
    quotes: {},
  },
  sessions: { a: "open", hk: "open", us: "post", kr: "open" },
  trayLabel: "贵州茅台 1437.51 -0.52%",
  dataFile: "~/Library/Application Support/com.stockpot.app/stockpot.json",
};

const DEMO_KEY = "stockpot.demo.v1";

/** The browser preview keeps its demo data in localStorage so the popover and
 *  the settings window (separate documents) share one state, the way the two
 *  real windows share the Rust store. */
function loadDemo(): AppPayload {
  const seed = () => {
    const fresh = JSON.parse(JSON.stringify(demoData)) as AppPayload;
    // The screenshot harness (and anyone previewing the browser build) can cue
    // a starting theme and language before the first render.
    try {
      const pending = localStorage.getItem("__pending");
      if (pending) {
        const { theme, lang } = JSON.parse(pending) as { theme?: string; lang?: string };
        if (theme) fresh.data.settings.theme = theme as AppPayload["data"]["settings"]["theme"];
        if (lang) fresh.data.settings.language = lang as AppPayload["data"]["settings"]["language"];
      }
    } catch {
      // ignore malformed seed
    }
    return fresh;
  };
  if (typeof localStorage === "undefined") return seed();
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as AppPayload;
    if (!parsed.data?.stocks) return seed();
    return parsed;
  } catch {
    return seed();
  }
}

function saveDemo(payload: AppPayload): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem("__pending");
    localStorage.setItem(DEMO_KEY, JSON.stringify(payload));
  } catch {
    // Quota or private mode: the preview simply does not persist.
  }
}

const demoLive: AppPayload = loadDemo();

function hydrateQuotes(): void {
  const quotes: AppPayload["snapshot"]["quotes"] = {};
  for (const stock of demoLive.data.stocks) {
    const seed = demoQuotes[stock.id];
    if (!seed) continue;
    const prev = seed.price - seed.change;
    quotes[stock.id] = {
      id: stock.id,
      name: seed.name,
      price: seed.price,
      change: seed.change,
      changePercent: (seed.change / prev) * 100,
      prevClose: prev,
      time: nowMinus(18),
      currency: stock.market === "a" ? "CNY" : stock.market === "hk" ? "HKD" : stock.market === "us" ? "USD" : "KRW",
      extendedPrice: seed.extended,
      extendedChangePercent: seed.extended ? ((seed.extended - seed.price) / seed.price) * 100 : undefined,
      extendedLabel: seed.extLabel,
    };
  }
  demoLive.snapshot.quotes = quotes;
  demoLive.snapshot.updatedAt = Math.floor(Date.now() / 1000);
  saveDemo(demoLive);
}

hydrateQuotes();

/** A smooth pseudo-random walk that always starts at the previous close and
 *  ends near the current quote, so the demo chart looks like a real session. */
function demoChart(id: string): ChartData {
  const stock = demoLive.data.stocks.find((s) => s.id === id);
  const quote = demoLive.snapshot.quotes[id];
  const market: Market = stock?.market ?? "a";
  const axisLength = market === "us" ? 961 : market === "hk" ? 331 : market === "kr" ? 391 : 241;
  const start = market === "us" ? 0 : 0;
  const labels =
    market === "us"
      ? [
          { i: 0, label: "04:00" },
          { i: 330, label: "09:30" },
          { i: 570, label: "13:30" },
          { i: 720, label: "16:00" },
          { i: 960, label: "20:00" },
        ]
      : market === "hk"
        ? [
            { i: 0, label: "09:30" },
            { i: 90, label: "11:00" },
            { i: 150, label: "12:00" },
            { i: 210, label: "14:00" },
            { i: 330, label: "16:00" },
          ]
        : market === "kr"
          ? [
              { i: 0, label: "09:00" },
              { i: 90, label: "10:30" },
              { i: 180, label: "12:00" },
              { i: 270, label: "13:30" },
              { i: 390, label: "15:30" },
            ]
          : [
              { i: 0, label: "09:30" },
              { i: 60, label: "10:30" },
              { i: 120, label: "11:30" },
              { i: 181, label: "14:00" },
              { i: 240, label: "15:00" },
            ];
  const prevClose = quote?.prevClose ?? 100;
  const last = quote?.price ?? prevClose;
  const points: ChartPoint[] = [];
  let seed = 0;
  for (let c = 0; c < id.length; c++) seed += id.charCodeAt(c);
  let rng = seed * 9301 + 49297;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };
  const progress = market === "us" ? 0.86 : 0.63;
  const endIndex = Math.floor(axisLength * progress);
  let value = prevClose;
  const drift = (last - prevClose) / Math.max(1, endIndex);
  const vol = prevClose * 0.00055;
  for (let i = start; i <= endIndex; i++) {
    const shock = (random() - 0.5) * 2 * vol;
    const meanPull = (prevClose + drift * i - value) * 0.22;
    value = value + drift + shock + meanPull;
    if (i === endIndex) value = last;
    const minutes = market === "us" ? 4 * 60 + i : market === "kr" ? 9 * 60 + i : 9 * 60 + 30 + i;
    // A-share and HK axes skip the lunch break visually but keep their labels.
    const hh = Math.floor(minutes / 60) % 24;
    const mm = minutes % 60;
    points.push({
      i,
      price: Number(value.toFixed(3)),
      time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    });
  }
  return {
    id,
    points,
    prevClose,
    axisLength,
    labels,
    sessions:
      market === "us"
        ? [
            { key: "pre", label: "pre", start: 0, end: 329 },
            { key: "open", label: "open", start: 330, end: 719 },
            { key: "post", label: "post", start: 720, end: 959 },
          ]
        : [],
    source: "demo",
  };
}

/** Deterministic daily bars ending at today, used by the browser preview and
 *  re-aggregated into weeks/months so all three periods look consistent. */
function demoKline(id: string, period: Period): KlineData {
  const quote = demoLive.snapshot.quotes[id];
  const last = quote?.price ?? 100;
  let seed = 0;
  for (let c = 0; c < id.length; c++) seed += id.charCodeAt(c) * (c + 3);
  let rng = seed * 7919 + 104729;
  const random = () => {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  };
  const days = period === "day" ? 180 : period === "week" ? 160 * 5 : 120 * 21;
  const drifts: number[] = [];
  let price = last * (period === "month" ? 0.55 : period === "week" ? 0.78 : 0.86);
  for (let i = 0; i < days; i++) {
    const swing = (random() - 0.48) * 0.026;
    const trend = (last - price) / Math.max(1, days - i) / price;
    price = Math.max(0.2, price * (1 + swing + trend * 4));
    if (i === days - 1) price = last;
    drifts.push(price);
  }
  const daily: Candle[] = drifts.map((close, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const open = i === 0 ? close : drifts[i - 1];
    const high = Math.max(open, close) * (1 + random() * 0.008);
    const low = Math.min(open, close) * (1 - random() * 0.008);
    return {
      time: d.toISOString().slice(0, 10),
      open: Number(open.toFixed(3)),
      high: Number(high.toFixed(3)),
      low: Number(low.toFixed(3)),
      close: Number(close.toFixed(3)),
      volume: Math.round(1000 + random() * 9000),
    };
  });
  const bucket = (rows: Candle[], size: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      if (chunk.length === 0) continue;
      out.push({
        time: chunk[chunk.length - 1].time,
        open: chunk[0].open,
        close: chunk[chunk.length - 1].close,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        volume: chunk.reduce((sum, c) => sum + c.volume, 0),
      });
    }
    return out;
  };
  const candles =
    period === "day" ? daily.slice(-180) : period === "week" ? bucket(daily, 5).slice(-160) : bucket(daily, 21).slice(-120);
  return { id, period, candles };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const demoSearchPool: SearchResult[] = [
  { id: "sh600519", code: "600519", name: "贵州茅台", market: "a", secid: "1.600519" },
  { id: "sh601318", code: "601318", name: "中国平安", market: "a", secid: "1.601318" },
  { id: "sz000858", code: "000858", name: "五粮液", market: "a", secid: "0.000858" },
  { id: "sz300750", code: "300750", name: "宁德时代", market: "a", secid: "0.300750" },
  { id: "hk00700", code: "00700", name: "腾讯控股", market: "hk", secid: "116.00700" },
  { id: "hk09988", code: "09988", name: "阿里巴巴-W", market: "hk", secid: "116.09988" },
  { id: "usr_aapl", code: "AAPL", name: "苹果", market: "us", secid: "105.AAPL" },
  { id: "usr_tsla", code: "TSLA", name: "特斯拉", market: "us", secid: "105.TSLA" },
  { id: "usr_nvda", code: "NVDA", name: "英伟达", market: "us", secid: "105.NVDA" },
  { id: "kr_005930", code: "005930", name: "三星电子", market: "kr", secid: "177.005930" },
  // A broad query used to overflow the dialog; these keep that case testable.
  { id: "sh601899", code: "601899", name: "紫金矿业", market: "a", secid: "1.601899" },
  { id: "hk02899", code: "02899", name: "紫金矿业", market: "hk", secid: "116.02899" },
  { id: "sh600388", code: "600388", name: "紫金龙净", market: "a", secid: "1.600388" },
  { id: "sh601860", code: "601860", name: "紫金银行", market: "a", secid: "1.601860" },
  { id: "hk02259", code: "02259", name: "紫金黄金国际", market: "hk", secid: "116.02259" },
  { id: "usr_zijmy", code: "ZIJMY", name: "紫金矿业 ADR", market: "us", secid: "105.ZIJMY" },
  { id: "sh600362", code: "600362", name: "江西铜业", market: "a", secid: "1.600362" },
  { id: "sh601168", code: "601168", name: "西部矿业", market: "a", secid: "1.601168" },
  { id: "sh600547", code: "600547", name: "山东黄金", market: "a", secid: "1.600547" },
  { id: "hk01818", code: "01818", name: "招金矿业", market: "hk", secid: "116.01818" },
  { id: "sh600489", code: "600489", name: "中金黄金", market: "a", secid: "1.600489" },
  { id: "usr_gold", code: "GOLD", name: "巴里克黄金", market: "us", secid: "105.GOLD" },
  { id: "usr_nem", code: "NEM", name: "纽蒙特", market: "us", secid: "105.NEM" },
  { id: "kr_010130", code: "010130", name: "高丽亚铅", market: "kr", secid: "177.010130" },
  { id: "hk03330", code: "03330", name: "灵宝黄金", market: "hk", secid: "116.03330" },
];

/**
 * The whole app talks to the backend through this shim. In the Tauri webview it
 * forwards every call to Rust; in a plain browser (design QA, `pnpm dev`) it
 * falls back to an in-memory dataset so the UI can be exercised without a
 * runtime.
 */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(command, args);
}

export const api = {
  isTauri,

  async getApp(): Promise<AppPayload> {
    if (!isTauri) {
      hydrateQuotes();
      return demoLive;
    }
    return invoke<AppPayload>("get_app");
  },

  async refresh(): Promise<AppPayload> {
    if (!isTauri) {
      await sleep(420);
      hydrateQuotes();
      return demoLive;
    }
    return invoke<AppPayload>("refresh");
  },

  async search(keyword: string): Promise<SearchResult[]> {
    if (!isTauri) {
      await sleep(280);
      const needle = keyword.toLowerCase();
      const aliases: Record<string, string> = {
        sh600519: "maotai moutai gzmt",
        sh601318: "pingan pa",
        sz000858: "wuliangye",
        sz300750: "catl ningde",
        hk00700: "tencent tx",
        hk09988: "alibaba ali",
        usr_aapl: "apple",
        usr_tsla: "tesla",
        usr_nvda: "nvidia",
        kr_005930: "samsung",
      };
      return demoSearchPool.filter(
        (r) =>
          r.code.toLowerCase().includes(needle) ||
          r.name.toLowerCase().includes(needle) ||
          r.id.includes(needle) ||
          (aliases[r.id] ?? "").includes(needle),
      );
    }
    return invoke<SearchResult[]>("search", { keyword });
  },

  /** Quote rows for search results that are not on the watchlist yet. */
  async previewQuotes(ids: string[]): Promise<AppPayload | null> {
    if (!isTauri) {
      for (const id of ids) {
        if (!demoLive.snapshot.quotes[id] && demoQuotes[id]) {
          const seed = demoQuotes[id];
          const prev = seed.price - seed.change;
          demoLive.snapshot.quotes[id] = {
            id,
            name: seed.name,
            price: seed.price,
            change: seed.change,
            changePercent: (seed.change / prev) * 100,
            prevClose: prev,
            time: nowMinus(20),
            currency: id.startsWith("hk")
              ? "HKD"
              : id.startsWith("usr_")
                ? "USD"
                : id.startsWith("kr_")
                  ? "KRW"
                  : "CNY",
            extendedPrice: seed.extended,
            extendedChangePercent: seed.extended
              ? ((seed.extended - seed.price) / seed.price) * 100
              : undefined,
            extendedLabel: seed.extLabel,
          };
        }
      }
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("preview_quotes", { ids });
  },

  async addStock(result: SearchResult): Promise<AppPayload> {
    if (!isTauri) {
      if (!demoLive.data.stocks.find((s) => s.id === result.id)) {
        demoLive.data.stocks.push({
          id: result.id,
          code: result.code,
          name: result.name,
          market: result.market,
          secid: result.secid,
        });
        demoQuotes[result.id] ??= {
          name: result.name,
          price: 100 + result.code.length * 11.3,
          change: 0.42,
        };
        hydrateQuotes();
      }
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("add_stock", { result });
  },

  async removeStock(id: string): Promise<AppPayload> {
    if (!isTauri) {
      demoLive.data.stocks = demoLive.data.stocks.filter((s) => s.id !== id);
      delete demoLive.snapshot.quotes[id];
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("remove_stock", { id });
  },

  async reorderStocks(ids: string[]): Promise<AppPayload> {
    if (!isTauri) {
      const map = new Map(demoLive.data.stocks.map((s) => [s.id, s]));
      demoLive.data.stocks = ids.flatMap((id) => {
        const s = map.get(id);
        return s ? [s] : [];
      });
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("reorder_stocks", { ids });
  },

  async setPosition(
    accountId: string,
    stockId: string,
    costPrice: number | null,
    shares: number | null,
  ): Promise<AppPayload> {
    if (!isTauri) {
      const account = demoLive.data.accounts.find((a) => a.id === accountId);
      if (account) {
        if (costPrice != null && costPrice > 0 && shares != null && shares > 0) {
          account.entries[stockId] = { costPrice, shares };
        } else {
          delete account.entries[stockId];
        }
      }
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("set_position", { accountId, stockId, costPrice, shares });
  },

  async updateAlert(id: string, targetPrice: number | null, enabled: boolean): Promise<AppPayload> {
    if (!isTauri) {
      const stock = demoLive.data.stocks.find((s) => s.id === id);
      if (stock) {
        stock.alert = targetPrice
          ? {
              targetPrice,
              direction: (demoLive.snapshot.quotes[id]?.price ?? 0) > targetPrice ? "fall" : "rise",
              enabled,
            }
          : null;
      }
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("update_alert", { id, targetPrice, enabled });
  },

  async updateSettings(patch: Record<string, unknown>): Promise<AppPayload> {
    if (!isTauri) {
      Object.assign(demoLive.data.settings, patch);
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("update_settings", { patch });
  },

  async createAccount(name: string): Promise<AppPayload> {
    if (!isTauri) {
      const account: Account = { id: `acc-${Date.now()}`, name, entries: {} };
      demoLive.data.accounts.push(account);
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("create_account", { name });
  },

  async renameAccount(id: string, name: string): Promise<AppPayload> {
    if (!isTauri) {
      const account = demoLive.data.accounts.find((a) => a.id === id);
      if (account) account.name = name;
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("rename_account", { id, name });
  },

  async deleteAccount(id: string): Promise<AppPayload> {
    if (!isTauri) {
      if (demoLive.data.accounts.length > 1) {
        demoLive.data.accounts = demoLive.data.accounts.filter((a) => a.id !== id);
      }
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("delete_account", { id });
  },

  async kline(id: string, period: Period): Promise<KlineData> {
    if (!isTauri) {
      await sleep(240);
      return demoKline(id, period);
    }
    return invoke<KlineData>("kline", { id, period });
  },

  async chart(id: string): Promise<ChartData> {
    if (!isTauri) {
      await sleep(360);
      return demoChart(id);
    }
    return invoke<ChartData>("chart", { id });
  },

  async setAutostart(enabled: boolean): Promise<boolean> {
    if (!isTauri) return enabled;
    return invoke<boolean>("set_autostart", { enabled });
  },

  async requestNotificationPermission(): Promise<boolean> {
    if (!isTauri) return false;
    return invoke<boolean>("request_notification_permission");
  },

  async notificationStatus(): Promise<boolean> {
    if (!isTauri) return false;
    return invoke<boolean>("notification_status");
  },

  async clearStocks(): Promise<AppPayload> {
    if (!isTauri) {
      demoLive.data.stocks = [];
      demoLive.data.accounts.forEach((a) => (a.entries = {}));
      demoLive.snapshot.quotes = {};
      saveDemo(demoLive);
      return demoLive;
    }
    return invoke<AppPayload>("clear_stocks");
  },

  async testNotification(): Promise<boolean> {
    if (!isTauri) return false;
    return invoke<boolean>("test_notification");
  },

  async clientReady(): Promise<boolean> {
    if (!isTauri) return true;
    return invoke<boolean>("client_ready");
  },

  async openSettings(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("open_settings");
  },

  async closeSettings(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("close_settings");
  },

  async openLedger(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("open_ledger");
  },

  async closeLedger(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("close_ledger");
  },

  async hidePanel(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("hide_panel");
  },

  async sessionsNow(): Promise<Record<string, string>> {
    if (!isTauri) {
      // Demo sessions stay fixed so screenshots are comparable run to run.
      return { a: "open", hk: "open", us: "post", kr: "open" };
    }
    return invoke<Record<string, string>>("sessions_now");
  },

  async quit(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("quit_app");
  },

  async openDataDir(): Promise<void> {
    if (!isTauri) return;
    return invoke<void>("open_data_dir");
  },

  /** The agent handoff page: CLI path, data folder and the bundled skills. */
  async agentSkills(): Promise<AgentSkills> {
    if (!isTauri) {
      // The browser preview has no executable or data folder of its own, so it
      // shows the platform's conventional paths instead.
      const mac = !navigator.userAgent.includes("Windows");
      return {
        binary: mac
          ? "/Applications/Stockpot.app/Contents/MacOS/stockpot"
          : "C:\\Program Files\\Stockpot\\stockpot.exe",
        dataDir: mac
          ? "~/Library/Application Support/com.stockpot.app"
          : "%APPDATA%\\com.stockpot.app",
        skills: [
          {
            name: "stockpot",
            path: "skills/stockpot/SKILL.md",
            title: "Stockpot Agent CLI",
            body: "（浏览器预览不加载 SKILL.md，请在应用中查看）",
          },
        ],
      };
    }
    return invoke<AgentSkills>("agent_skills");
  },
};

export type Api = typeof api;
export { demoChart };
