export type Market = "a" | "hk" | "us" | "kr" | "fund";
export type SessionKey =
  | "pre"
  | "open"
  | "lunch"
  | "post"
  | "night"
  | "closed"
  | "weekend"
  /** 场外基金：净值每个交易日更新一次，没有盘中 */
  | "nav";
export type ColorScheme = "chinese" | "western";
export type Theme = "system" | "light" | "dark";
export type Lang = "zh" | "en" | "ja";
export type SortRule = "changeDesc" | "changeAsc" | "manual";
export type UsPriceMode = "session" | "regular";
export type PnlDisplay = "amount" | "percent";
export type FlashDuration = "off" | "short" | "normal" | "long";
export type MenuBarPnlFormat = "amount" | "percent" | "both";
export type MenuBarMode = "stock" | "dailyPnl" | "totalPnl" | "bothPnl" | "none";
export type AlertDirection = "rise" | "fall";

export interface PriceAlert {
  targetPrice: number;
  direction: AlertDirection | null;
  enabled: boolean;
}

export interface Stock {
  id: string;
  code: string;
  name: string;
  market: Market;
  alert?: PriceAlert | null;
  secid?: string | null;
}

/** One stock inside one account. */
export interface Position {
  costPrice: number;
  shares: number;
}

export interface Account {
  id: string;
  name: string;
  entries: Record<string, Position>;
}

/** Weighted average of every account's holding in one stock. */
export interface MergedPosition {
  shares: number;
  costPrice: number;
  basis: number;
}

export interface Settings {
  menuBarMode: MenuBarMode;
  menuBarStockId: string;
  refreshInterval: number;
  colorScheme: ColorScheme;
  currency: "CNY" | "HKD" | "USD" | "KRW";
  sortRule: SortRule;
  usPriceMode: UsPriceMode;
  groupHoldings: boolean;
  theme: Theme;
  language: Lang;
  launchAtLogin: boolean;
  showDockIcon: boolean;
  menuBarPnlFormat: MenuBarPnlFormat;
  flashDuration: FlashDuration;
  pnlDisplay: PnlDisplay;
  /** 更新从哪儿拿：自建服务器 server / GitHub release github */
  updateSource: "server" | "github";
  /** GitHub 源访问私有仓库时用的只读令牌，公开仓库留空 */
  githubToken: string;
  /** 自建同步服务器地址，空着用内置的 */
  serverUrl: string;
}

export interface Quote {
  id: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
  time: string;
  currency: string;
  extendedPrice?: number;
  extendedChangePercent?: number;
  extendedLabel?: "pre" | "post" | "night";
}

export interface Rates {
  usdCny: number;
  usdHkd: number;
  usdKrw: number;
}

export interface Snapshot {
  quotes: Record<string, Quote>;
  rates: Rates;
  updatedAt: number;
  error?: string;
}

export interface AppData {
  stocks: Stock[];
  settings: Settings;
  accounts: Account[];
}

export interface AppPayload {
  data: AppData;
  snapshot: Snapshot;
  sessions: Record<Market, SessionKey>;
  trayLabel: string;
  launchAtLogin?: boolean;
  notifyGranted?: boolean;
  dataFile?: string;
}

export interface ChartPoint {
  i: number;
  price: number;
  time: string;
}

export interface ChartLabel {
  i: number;
  label: string;
}

export interface ChartSession {
  key: string;
  label: string;
  start: number;
  end: number;
}

export interface ChartData {
  id: string;
  points: ChartPoint[];
  prevClose: number;
  axisLength: number;
  labels: ChartLabel[];
  sessions: ChartSession[];
  source: string;
}

export type Period = "day" | "week" | "month";

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlineData {
  id: string;
  period: Period;
  candles: Candle[];
}

export interface SearchResult {
  id: string;
  code: string;
  name: string;
  market: Market;
  secid: string;
}

export const MARKET_ORDER: Market[] = ["a", "hk", "us", "kr", "fund"];

/** One agent skill document shipped with the app (`skills/<name>/SKILL.md`). */
export interface AgentSkill {
  name: string;
  /** Repo-relative path, shown so the user knows where it comes from. */
  path: string;
  title: string;
  /** The full markdown, embedded from the same file `cli skill` prints. */
  body: string;
}

/** Everything the Agent settings page renders. */
export interface AgentSkills {
  /** Absolute path of the running executable — the CLI entry point. */
  binary: string;
  /** The folder the CLI and the GUI both read. */
  dataDir: string;
  skills: AgentSkill[];
}
