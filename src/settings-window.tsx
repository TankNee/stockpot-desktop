import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { useStore } from "@/store/app-store";
import { languageNames, type Lang } from "@/lib/i18n";
import type {
  Account,
  FlashDuration,
  MenuBarMode,
  MenuBarPnlFormat,
  SortRule,
  Stock,
  Theme,
  UsPriceMode,
  AgentSkills,
} from "@/lib/types";
import { MARKET_ORDER } from "@/lib/types";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  CaptionButtons,
  ResizeHandles,
  handleTitleBarDoubleClick,
} from "@/components/window-chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { FieldRow, Section } from "@/components/ui/section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchView } from "@/components/search-view";
import { ledgerApi } from "@/ledger/api";
import {
  CategoryIcon,
  CategoryIconPicker,
  categoryIconKey,
  categoryPath,
  guessCategoryIcon,
  orderedCategories,
} from "@/ledger/categories";
import type { Ledger } from "@/ledger/types";
import { addThousands, formatMoney, formatPercent, formatPrice } from "@/lib/format";
import {
  Bell,
  BellOff,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Sparkles,
  X,
  FolderOpen,
  Keyboard,
  LayoutList,
  Palette,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  TriangleAlert,
  Wallet,
  Bot,
  Copy,
} from "lucide-react";

type Tab =
  | "portfolio"
  | "stocks"
  | "appearance"
  | "menubar"
  | "ledger"
  | "ledgerAi"
  | "shortcuts"
  | "agent"
  | "about";

/** Sidebar grouping: the ledger is its own world, the stock tabs share one, and
 *  everything about the app itself sits apart. */
const TAB_GROUPS: Array<{ key: string; labelKey: string; tabs: Tab[] }> = [
  { key: "general", labelKey: "settings.group.general", tabs: ["stocks", "appearance"] },
  { key: "stocks", labelKey: "settings.group.stocks", tabs: ["portfolio", "menubar", "shortcuts"] },
  { key: "ledger", labelKey: "settings.group.ledger", tabs: ["ledger", "ledgerAi"] },
  { key: "app", labelKey: "settings.group.app", tabs: ["agent", "about"] },
];

const TABS: { id: Tab; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { id: "portfolio", icon: Wallet },
  { id: "stocks", icon: LayoutList },
  { id: "appearance", icon: Palette },
  { id: "menubar", icon: Settings2 },
  { id: "ledger", icon: BookOpen },
  { id: "ledgerAi", icon: Sparkles },
  { id: "shortcuts", icon: Keyboard },
  { id: "agent", icon: Bot },
  { id: "about", icon: FolderOpen },
];

export function SettingsWindow() {
  const { t, settings, loading, stocks, accounts, quit } = useStore();
  const [tab, setTab] = React.useState<Tab>("portfolio");
  const [searchOpen, setSearchOpen] = React.useState(false);
  // The sidebar's version chip reads the real bundle version instead of a
  // hardcoded string, so it cannot drift from tauri.conf.json again.
  const [version, setVersion] = React.useState("");
  React.useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  const reduce = useReducedMotion();

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "w") {
        event.preventDefault();
        void import("@/lib/api").then((m) => m.api.closeSettings());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading && !settings) {
    return (
      <div className="window-shell items-center justify-center">
        <span className="text-[13px] text-faint">{t("list.loading")}</span>
      </div>
    );
  }

  return (
    <div
      className="window-shell relative rounded-[12px] border border-border/70"
      onDoubleClick={handleTitleBarDoubleClick}
    >
      {/* Windows runs this window frameless with self-drawn caption buttons and
          resize edges; on macOS both render nothing and the system traffic
          lights stay in charge. */}
      <ResizeHandles />
      <CaptionButtons onClose={() => void import("@/lib/api").then((m) => m.api.closeSettings())} />
      <aside className="flex w-[210px] shrink-0 flex-col border-r border-border/70 bg-surface/40 pb-2 pl-3 pr-2">
        {/* Empty strip beside the traffic lights: the only draggable part of the
            sidebar. It keeps clear of the system buttons at top-left. */}
        <div
          data-tauri-drag-region
          className="drag-region h-[38px] shrink-0"
          aria-hidden
        />
        <div className="mb-3 flex items-center gap-2 px-1">
          <div className="flex size-6 items-center justify-center rounded-[5px] bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]">
            <span className="text-[13px] font-semibold text-accent">S</span>
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[13px] font-semibold tracking-[-0.01em]">Stockpot</span>
            <span className="mt-[2px] text-[10.5px] text-faint">{t("settings.title")}</span>
          </div>
        </div>

        <nav
          className="no-drag flex flex-col gap-3"
          aria-label={t("settings.title")}
        >
          {TAB_GROUPS.map((group) => (
            <div key={group.key} className="flex flex-col gap-[1px]">
              <span className="px-2 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-faint">
                {t(group.labelKey)}
              </span>
              {TABS.filter((entry) => group.tabs.includes(entry.id)).map(
                ({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className="sidebar-item"
                    data-active={tab === id}
                    aria-current={tab === id ? "page" : undefined}
                    onClick={() => setTab(id)}
                  >
                    <Icon size={13} strokeWidth={2} />
                    <span className="flex-1 text-left">{t(`settings.tab.${id}`)}</span>
                    {id === "stocks" ? (
                      <span className="num text-[11px] text-faint">{stocks.length}</span>
                    ) : null}
                    {id === "portfolio" && accounts.length > 1 ? (
                      <span className="num text-[11px] text-faint">{accounts.length}</span>
                    ) : null}
                  </button>
                ),
              )}
            </div>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1 px-1">
          <Button
            variant="ghost"
            size="sm"
            className="no-drag justify-start gap-1.5 px-1 text-[11.5px] text-faint"
            onClick={() => setTab("about")}
          >
            <span className="num">v{version || "1.0.3"}</span>
            <span className="truncate">{t("settings.versionShort")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="no-drag justify-start gap-1.5 px-1 text-[11.5px] text-faint hover:text-down"
            onClick={quit}
          >
            <Power size={10} strokeWidth={2.2} />
            {t("action.quit")}
          </Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-panel">
        {/* `deep` matters: a bare data-tauri-drag-region only drags when the
            click lands on that exact element, so the header's padding and the
            space beside the buttons were dead. With `deep` the whole band drags
            while buttons still win, because the Tauri drag script treats
            clickable elements as non-draggable unless they opt in. */}
        <header
          data-tauri-drag-region="deep"
          className="drag-region caption-inset flex h-[50px] shrink-0 items-end justify-between gap-3 border-b border-border/60 px-5 pb-2.5"
        >
          <div
            data-tauri-drag-region
            className="drag-region flex min-w-0 flex-1 items-baseline gap-2 self-stretch pt-6"
          >
            <h1
              data-tauri-drag-region
              className="truncate text-[14px] font-semibold tracking-[-0.015em]"
            >
              {t(`settings.tab.${tab}`)}
            </h1>
            <p data-tauri-drag-region className="truncate text-[11.5px] text-faint">
              {t(`settings.tab.${tab}.hint`)}
            </p>
          </div>
          <div className="no-drag flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5 text-[12px]"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={11} strokeWidth={2.2} />
              {t("search.title")}
              <kbd className="ml-1 rounded-[3px] border border-hairline px-1 font-mono text-[10px] leading-[13px] text-faint">
                ⌘K
              </kbd>
            </Button>
          </div>
        </header>

        <div className="scroll-area flex-1 px-5 py-4">
          <motion.div
            key={tab}
            initial={reduce ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: [0.25, 0.7, 0.3, 1] }}
          >
            {tab === "portfolio" ? <PortfolioTab /> : null}
            {tab === "stocks" ? <StocksTab /> : null}
            {tab === "appearance" ? <AppearanceTab /> : null}
            {tab === "menubar" ? <MenuBarTab /> : null}
            {tab === "shortcuts" ? <ShortcutsTab /> : null}
            {tab === "ledger" ? <LedgerSettingsTab /> : null}
            {tab === "ledgerAi" ? <LedgerAiTab /> : null}
            {tab === "agent" ? <AgentTab /> : null}
            {tab === "about" ? <AboutTab /> : null}
          </motion.div>
        </div>
      </main>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="flex max-h-[min(560px,calc(100vh-64px))] w-[min(440px,calc(100vw-48px))] flex-col overflow-hidden p-0">
          <DialogTitle className="sr-only">{t("search.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("search.hint")}</DialogDescription>
          <SearchView onDone={() => setSearchOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Portfolio: holdings + watchlists, editable inline                    */
/* ------------------------------------------------------------------ */

function PortfolioTab() {
  const {
    t,
    accounts,
    settings,
    totals,
    lang,
    selPosition,
    createAccount,
    renameAccount,
    deleteAccount,
    mergedPosition,
    updateAlert,
  } = useStore();
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [newName, setNewName] = React.useState("");
  const [nameError, setNameError] = React.useState(false);
  const [accountError, setAccountError] = React.useState<"failed" | "dup" | null>(null);
  const currency = settings?.currency ?? "CNY";
  const summary = totals();

  // Fall back to the first account whenever the selected one disappears.
  const active =
    accounts.find((a) => a.id === activeId) ?? accounts[0] ?? null;

  React.useEffect(() => {
    if (!active && accounts.length > 0) setActiveId(accounts[0].id);
  }, [active, accounts]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[8px] border border-border/70 bg-border/60">
        <SummaryCell
          label={t("summary.total")}
          value={formatMoney(summary.total, currency, lang)}
          percent={summary.percent}
          tone={summary.total}
          signed
        />
        <SummaryCell
          label={t("summary.daily")}
          value={formatMoney(summary.daily, currency, lang)}
          percent={summary.dailyPercent}
          tone={summary.daily}
          signed
        />
        <SummaryCell
          label={t("portfolio.cost")}
          value={formatMoney(summary.cost, currency, lang)}
          tone={0}
        />
      </div>

      <Section
        title={t("account.title")}
        hint={t("account.tabsHint")}
        action={
          <form
            className="flex items-center gap-1"
            onSubmit={async (event) => {
              event.preventDefault();
              const name = newName.trim();
              if (!name) {
                setNameError(true);
                return;
              }
              try {
                await createAccount(name);
                setNewName("");
                setNameError(false);
                setAccountError(null);
              } catch (err) {
                setNameError(true);
                setAccountError(String(err).includes("duplicate") ? "dup" : "failed");
              }
            }}
          >
            <Input
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setNameError(false);
                setAccountError(null);
              }}
              placeholder={t("account.placeholder")}
              aria-label={t("account.new")}
              aria-invalid={nameError}
              className="h-6 w-[150px] text-[12px]"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11.5px]"
            >
              <Plus size={10} strokeWidth={2.6} />
              {t("action.add")}
            </Button>
          </form>
        }
      >
        <div
          role="tablist"
          aria-label={t("account.title")}
          className="flex flex-wrap items-center gap-1 border-b border-border/60 pb-2"
        >
          {accounts.map((account) => {
            const isActive = active?.id === account.id;
            const count = Object.values(account.entries).filter((p) => p.shares > 0).length;
            return (
              <button
                key={account.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveId(account.id)}
                className={cn(
                  "-mb-2 flex items-center gap-1.5 border-b-2 px-2.5 pb-2 pt-1 text-[12.5px] transition-colors",
                  isActive
                    ? "border-accent font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-hairline hover:text-foreground",
                )}
              >
                <span className="max-w-[140px] truncate">{account.name}</span>
                <span className="num text-[10.5px] text-faint">{count}</span>
              </button>
            );
          })}
        </div>
        {accountError ? (
          <p role="alert" className="text-[11px] text-down">
            {t(accountError === "dup" ? "account.duplicate" : "account.failed")}
          </p>
        ) : null}
        {active ? (
          <AccountTools
            account={active}
            canDelete={accounts.length > 1}
            onRename={(name) => void renameAccount(active.id, name)}
            onDelete={() => {
              void deleteAccount(active.id);
              setActiveId(null);
            }}
          />
        ) : null}
      </Section>

      {active ? (
        <Section
          title={t("account.positionsIn", { name: active.name })}
          hint={t("account.positionsHint")}
          action={
            <span className="text-[11px] text-faint">
              {t("settings.stocks.count", {
                n: Object.values(active.entries).filter((p) => p.shares > 0).length,
              })}
            </span>
          }
        >
          <AccountPositions
            account={active}
            onSave={selPosition}
            onAlert={updateAlert}
            mergedPosition={mergedPosition}
          />
        </Section>
      ) : null}

      <Section title={t("portfolio.formula")}>
        <div className="grid grid-cols-2 gap-3 rounded-[6px] border border-dashed border-hairline/80 px-3 py-2">
          <Formula
            label={t("summary.total")}
            expression={t("portfolio.formulaTotal")}
            result={formatMoney(summary.total, currency, lang)}
            tone={summary.total}
          />
          <Formula
            label={t("summary.daily")}
            expression={t("portfolio.formulaDaily")}
            result={formatMoney(summary.daily, currency, lang)}
            tone={summary.daily}
          />
        </div>
      </Section>
    </div>
  );
}

/** Rename / delete controls for the account selected by the tab strip. */
function AccountTools({
  account,
  canDelete,
  onRename,
  onDelete,
}: {
  account: Account;
  canDelete: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const { t } = useStore();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(account.name);
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      {editing ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.trim();
            if (name && name !== account.name) onRename(name);
            setEditing(false);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label={t("account.rename")}
            className="h-6 w-[160px] rounded-[4px] border border-accent bg-panel px-1.5 text-[12px] focus:outline-none"
          />
          <Button type="submit" variant="secondary" size="sm" className="h-6 px-1.5 text-[11.5px]">
            {t("action.save")}
          </Button>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 px-1 text-[11.5px] text-faint hover:text-foreground"
          onClick={() => {
            setDraft(account.name);
            setEditing(true);
          }}
        >
          <Pencil size={9} strokeWidth={2.2} />
          {t("account.rename")}
        </Button>
      )}
      {canDelete ? (
        confirming ? (
          <span className="flex items-center gap-1 text-[11.5px]">
            <span className="text-muted-foreground">{t("account.deleteConfirm")}</span>
            <button
              type="button"
              className="rounded px-1 font-medium text-down"
              onClick={onDelete}
            >
              {t("action.confirm")}
            </button>
            <button
              type="button"
              className="rounded px-1 text-faint"
              onClick={() => setConfirming(false)}
            >
              {t("action.cancel")}
            </button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 px-1 text-[11.5px] text-faint hover:text-down"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={9} strokeWidth={2.2} />
            {t("action.delete")}
          </Button>
        )
      ) : null}
    </div>
  );
}

/** One account's positions: a compact editable list plus an "add a stock"
 *  picker scoped to this account. */
function AccountPositions({
  account,
  onSave,
  onAlert,
  mergedPosition,
}: {
  account: Account;
  onSave: (accountId: string, stockId: string, cost: number | null, shares: number | null) => Promise<void>;
  onAlert: (id: string, target: number | null, enabled: boolean) => Promise<void>;
  mergedPosition: (stock: Stock) => { shares: number; costPrice: number } | null;
}) {
  const { t, stocks, quotes, settings } = useStore();
  const currency = settings?.currency ?? "CNY";
  const [pending, setPending] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const held = stocks.filter((s) => (account.entries[s.id]?.shares ?? 0) > 0);
  const available = stocks.filter((s) => (account.entries[s.id]?.shares ?? 0) <= 0);

  if (stocks.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[6px] border border-dashed border-hairline/80 px-3 py-4">
        <Wallet size={13} strokeWidth={1.8} className="text-faint" />
        <span className="text-[12px] text-muted-foreground">{t("portfolio.empty")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-[6px] border border-border/70">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-surface/60 text-[10.5px] uppercase tracking-[0.08em] text-faint">
              <th className="px-2.5 py-1.5 text-left font-medium">{t("table.stock")}</th>
              <th className="w-[92px] px-2 py-1.5 text-right font-medium">
                {t("table.price")}
              </th>
              <th className="w-[86px] px-2 py-1.5 text-right font-medium">{t("table.cost")}</th>
              <th className="w-[86px] px-2 py-1.5 text-right font-medium">
                {t("table.shares")}
              </th>
              <th className="w-[80px] px-2 py-1.5 text-right font-medium">{t("table.pnl")}</th>
              <th className="w-[84px] px-2 py-1.5 text-right font-medium">{t("table.merged")}</th>
              <th className="w-[64px] px-1 py-1.5 text-center font-medium">
                {t("table.alert")}
              </th>
              <th className="w-[32px] px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {held.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-5 text-center text-[12px] text-faint">
                  {t("account.empty")}
                </td>
              </tr>
            ) : (
              held.map((stock, index) => {
                const entry = account.entries[stock.id];
                const quote = quotes[stock.id];
                const merged = mergedPosition(stock);
                const pnlValue =
                  quote && entry
                    ? {
                        total: (quote.price - entry.costPrice) * entry.shares,
                        percent: ((quote.price - entry.costPrice) / entry.costPrice) * 100,
                      }
                    : null;
                return (
                  <tr
                    key={stock.id}
                    className={cn(
                      "group transition-colors hover:bg-surface/30",
                      index > 0 && "border-t border-border/50",
                    )}
                  >
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center gap-1">
                        <div className="flex min-w-0 flex-col leading-tight">
                          <span className="truncate font-medium">{stock.name}</span>
                          <span className="num text-[10px] uppercase text-faint">{stock.code}</span>
                        </div>
                        {pending === stock.id ? (
                          <span className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              className="rounded px-1 text-[11px] font-medium text-down"
                              onClick={() => {
                                void onSave(account.id, stock.id, null, null);
                                setPending(null);
                              }}
                            >
                              {t("action.confirm")}
                            </button>
                            <button
                              type="button"
                              className="rounded px-0.5 text-[11px] text-faint"
                              onClick={() => setPending(null)}
                            >
                              ✕
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-label={`${t("action.delete")} ${stock.name}`}
                            onClick={() => setPending(stock.id)}
                            className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-down group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <X size={9} strokeWidth={2.2} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      <div className="flex flex-col items-end leading-tight">
                        <span
                          className={cn(
                            "num",
                            (quote?.changePercent ?? 0) > 0
                              ? "text-up"
                              : (quote?.changePercent ?? 0) < 0
                                ? "text-down"
                                : "",
                          )}
                        >
                          {formatPrice(quote?.price, stock.market)}
                        </span>
                        <span className="num text-[10px] text-faint">
                          {formatPercent(quote?.changePercent)}
                        </span>
                      </div>
                    </td>
                    <PositionField
                      value={entry?.costPrice}
                      label={`${stock.name} ${t("edit.cost")}`}
                      onCommit={(value) =>
                        void onSave(account.id, stock.id, value, entry?.shares ?? null)
                      }
                    />
                    <PositionField
                      value={entry?.shares}
                      label={`${stock.name} ${t("edit.shares")}`}
                      onCommit={(value) =>
                        void onSave(account.id, stock.id, entry?.costPrice ?? null, value)
                      }
                    />
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {pnlValue ? (
                        <div className="flex flex-col items-end leading-tight">
                          <span
                            className={cn(
                              "num",
                              pnlValue.total >= 0 ? "text-up" : "text-down",
                            )}
                          >
                            {pnlValue.total >= 0 ? "+" : "−"}
                            {addThousands(Math.abs(pnlValue.total), 0)}
                          </span>
                          <span
                            className={cn(
                              "num text-[10px]",
                              pnlValue.percent >= 0 ? "text-up" : "text-down",
                            )}
                          >
                            {formatPercent(pnlValue.percent)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[11px] text-faint">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {merged ? (
                        <div className="flex flex-col items-end leading-tight">
                          <span className="num text-muted-foreground">
                            {formatPrice(merged.costPrice, stock.market)}
                          </span>
                          <span className="num text-[10px] text-faint">
                            ×{merged.shares.toLocaleString("en-US")}
                          </span>
                        </div>
                      ) : null}
                    </td>
                    <td className="px-1 py-1.5">
                      <AlertCell stock={stock} onAlert={onAlert} />
                    </td>
                    <td className="px-1 py-1.5">
                      <span className="sr-only">{currency}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {adding ? (
        <div className="flex flex-wrap gap-1.5 rounded-[6px] border border-dashed border-hairline/80 p-2">
          {available.length === 0 ? (
            <span className="text-[11.5px] text-faint">{t("account.noMore")}</span>
          ) : (
            available.map((stock) => (
              <button
                key={stock.id}
                type="button"
                onClick={() => {
                  const price = quotes[stock.id]?.price ?? null;
                  void onSave(account.id, stock.id, price, 100);
                  setAdding(false);
                }}
                className="group flex items-center gap-1.5 rounded-[5px] border border-hairline bg-panel px-2 py-1 text-left transition-colors hover:border-accent/60 hover:bg-surface"
                title={t("portfolio.quickAddHint")}
              >
                <span className="text-[12px] font-medium">{stock.name}</span>
                <span className="num text-[10.5px] uppercase text-faint">{stock.code}</span>
                <Plus
                  size={9}
                  strokeWidth={2.6}
                  className="text-faint transition-colors group-hover:text-accent"
                />
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-[11.5px]"
            onClick={() => setAdding(true)}
            disabled={available.length === 0}
          >
            <Plus size={10} strokeWidth={2.4} />
            {t("account.addPosition")}
          </Button>
          <span className="text-[11px] text-faint">{t("account.scopeHint", { name: account.name })}</span>
        </div>
      )}
    </div>
  );
}

/** Target-price alert per stock. Alerts belong to the stock, not to an account. */
function AlertCell({
  stock,
  onAlert,
}: {
  stock: Stock;
  onAlert: (id: string, target: number | null, enabled: boolean) => Promise<void>;
}) {
  const { t, quotes } = useStore();
  const [draft, setDraft] = React.useState(stock.alert ? String(stock.alert.targetPrice) : "");

  React.useEffect(() => {
    setDraft(stock.alert ? String(stock.alert.targetPrice) : "");
  }, [stock.alert?.targetPrice, stock.alert]);

  const commit = () => {
    const target = clampNumber(draft);
    if (target === (stock.alert?.targetPrice ?? null)) return;
    void onAlert(stock.id, target, target != null && (stock.alert?.enabled ?? false));
  };

  return (
    <div className="flex items-center justify-center gap-[2px]">
      <button
        type="button"
        aria-label={`${t("edit.alert")} ${stock.name}`}
        aria-pressed={stock.alert?.enabled ?? false}
        onClick={() => {
          if (stock.alert?.enabled) {
            void onAlert(stock.id, stock.alert.targetPrice, false);
            return;
          }
          const price = quotes[stock.id]?.price;
          const target =
            clampNumber(draft) ?? (price != null ? Number((price * 1.05).toFixed(2)) : null);
          if (target == null) return;
          setDraft(String(target));
          void onAlert(stock.id, target, true);
        }}
        className={cn(
          "rounded p-0.5 transition-colors",
          stock.alert?.enabled ? "text-amber" : "text-faint hover:text-foreground",
        )}
      >
        {stock.alert?.enabled ? (
          <Bell size={10} strokeWidth={2.2} className="fill-current" />
        ) : (
          <BellOff size={10} strokeWidth={2} />
        )}
      </button>
      <input
        className="cell-input w-[46px] text-right text-[11px]"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(stock.alert ? String(stock.alert.targetPrice) : "");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="—"
        aria-label={`${stock.name} ${t("table.target")}`}
      />
    </div>
  );
}

/** A single editable number cell that reverts bad input instead of clearing. */
function PositionField({
  value,
  label,
  onCommit,
}: {
  value: number | undefined;
  label: string;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = React.useState(value != null ? String(value) : "");

  React.useEffect(() => {
    setDraft(value != null ? String(value) : "");
  }, [value]);

  const commit = () => {
    if (!draft.trim()) {
      if (value != null) onCommit(null);
      return;
    }
    const parsed = clampNumber(draft);
    if (parsed == null || parsed <= 0) {
      setDraft(value != null ? String(value) : "");
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <td className="px-1 py-1.5">
      <input
        className="cell-input w-full text-right"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value != null ? String(value) : "");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="—"
        aria-label={label}
      />
    </td>
  );
}

function SummaryCell({
  label,
  value,
  percent,
  tone,
  signed,
}: {
  label: string;
  value: string;
  percent?: number;
  tone: number;
  signed?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 bg-panel px-3 py-2.5">
      <span className="eyebrow leading-none">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "num text-[17px] font-medium leading-none tracking-[-0.02em]",
            tone > 0 && "text-up",
            tone < 0 && "text-down",
          )}
        >
          {signed && tone > 0 ? "+" : ""}
          {value}
        </span>
        {percent != null ? (
          <span
            className={cn(
              "num text-[11.5px] leading-none",
              tone > 0 ? "text-up" : tone < 0 ? "text-down" : "text-faint",
            )}
          >
            {formatPercent(percent)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Formula({
  label,
  expression,
  result,
  tone,
}: {
  label: string;
  expression: string;
  result: string;
  tone: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] uppercase tracking-[0.09em] text-faint">{label}</span>
      <span className="text-[11.5px] leading-snug text-muted-foreground">{expression}</span>
      <span
        className={cn(
          "num text-[12px]",
          tone > 0 ? "text-up" : tone < 0 ? "text-down" : "text-foreground",
        )}
      >
        = {result}
      </span>
    </div>
  );
}
function clampNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/* ------------------------------------------------------------------ */
/* Stocks: full list management                                         */
/* ------------------------------------------------------------------ */

function StocksTab() {
  const {
    t,
    stocks,
    settings,
    quotes,
    removeStock,
    mergedPosition,
    clearStocks,
    sessions,
  } = useStore();
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const filtered = stocks.filter(
    (s) =>
      !query.trim() ||
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.code.toLowerCase().includes(query.toLowerCase()),
  );

  const grouped = MARKET_ORDER.map((market) => ({
    market,
    rows: filtered.filter((s) => s.market === market),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={12}
            strokeWidth={2.2}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("stocks.searchPlaceholder")}
            aria-label={t("stocks.searchPlaceholder")}
            className="h-7 pl-7 text-[13px]"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-[11.5px] text-faint hover:text-down"
          onClick={() => setConfirmClear(true)}
          disabled={stocks.length === 0}
        >
          <Trash2 size={10} strokeWidth={2} />
          {t("settings.removeAll")}
        </Button>
      </div>

      {grouped.length === 0 ? (
        <div className="flex items-center gap-2 rounded-[6px] border border-dashed border-hairline/80 px-3 py-6">
          <span className="text-[12px] text-muted-foreground">{t("list.empty.title")}</span>
        </div>
      ) : null}

      {grouped.map((group) => (
        <div key={group.market} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="eyebrow">{t(`market.${group.market}`)}</span>
            <span className="num text-[10.5px] text-faint">{group.rows.length}</span>
            <span className="ledger-rule flex-1 opacity-50" aria-hidden />
          </div>
          <div className="overflow-hidden rounded-[6px] border border-border/70">
            <table className="w-full border-collapse text-[12.5px]">
              <tbody>
                {group.rows.map((stock, index) => {
                  const quote = quotes[stock.id];
                  const positioned = mergedPosition(stock) != null;
                  return (
                    <tr
                      key={stock.id}
                      className={cn(
                        "group transition-colors hover:bg-surface/40",
                        index > 0 && "border-t border-border/50",
                      )}
                    >
                      <td className="px-2.5 py-2">
                        <div className="flex flex-col leading-tight">
                          <span className="font-medium">{stock.name}</span>
                          <span className="num text-[10px] uppercase text-faint">
                            {stock.code}
                            {positioned ? ` · ${t("stocks.positioned")}` : ""}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span className="num">{formatPrice(quote?.price, stock.market)}</span>
                        <span
                          className={cn(
                            "num ml-2 text-[11px]",
                            (quote?.changePercent ?? 0) >= 0 ? "text-up" : "text-down",
                          )}
                        >
                          {formatPercent(quote?.changePercent)}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[10.5px]",
                            sessions?.[stock.market] === "open"
                              ? "border-[color-mix(in_oklch,var(--up)_30%,var(--border))] text-foreground"
                              : "border-hairline text-muted-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "size-[3px] rounded-full",
                              sessions?.[stock.market] === "open"
                                ? "bg-up live-dot"
                                : sessions?.[stock.market] === "closed" ||
                                    sessions?.[stock.market] === "weekend"
                                  ? "bg-faint"
                                  : "bg-amber",
                            )}
                            aria-hidden
                          />
                          {t(`session.${sessions?.[stock.market] ?? "closed"}`)}
                        </span>
                      </td>
                      <td className="w-[70px] px-2 py-2 text-right">
                        {pending === stock.id ? (
                          <span className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              className="rounded px-1 text-[11px] text-down"
                              onClick={() => {
                                void removeStock(stock.id);
                                setPending(null);
                              }}
                            >
                              {t("action.confirm")}
                            </button>
                            <button
                              type="button"
                              className="rounded px-1 text-[11px] text-faint"
                              onClick={() => setPending(null)}
                            >
                              {t("action.cancel")}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-label={`${t("action.delete")} ${stock.name}`}
                            onClick={() => setPending(stock.id)}
                            className="rounded p-1.5 text-faint opacity-0 transition-opacity hover:text-down group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <Trash2 size={10} strokeWidth={2} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <p className="text-[11px] text-faint">
        {t("stocks.footer", {
          mode: t(`settings.menubar.${settings?.menuBarMode ?? "stock"}`),
        })}
      </p>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="p-4">
          <DialogTitle className="sr-only">{t("settings.removeAll")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("settings.removeAllConfirm")}
          </DialogDescription>
          <div className="flex items-start gap-2">
            <TriangleAlert size={14} strokeWidth={2.2} className="mt-px shrink-0 text-down" />
            <div className="flex flex-col gap-1">
              <span className="text-[14px] font-semibold tracking-[-0.01em]">
                {t("settings.removeAll")}
              </span>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                {t("settings.removeAllConfirm")}
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void clearStocks();
                setConfirmClear(false);
              }}
            >
              {t("action.confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

function AppearanceTab() {
  const { t, settings, updateSettings } = useStore();
  if (!settings) return null;
  return (
    <div className="flex flex-col gap-5">
      <Section title={t("settings.theme")}>
        <div className="grid grid-cols-3 gap-2">
          {(["system", "light", "dark"] as Theme[]).map((theme) => (
            <ThemeCard
              key={theme}
              theme={theme}
              active={settings.theme === theme}
              label={t(`settings.theme.${theme}`)}
              onClick={() => void updateSettings({ theme })}
            />
          ))}
        </div>
      </Section>

      <Section title={t("settings.language")}>
        <Segmented<Lang>
          ariaLabel={t("settings.language")}
          value={settings.language}
          onChange={(value) => void updateSettings({ language: value })}
          options={(Object.keys(languageNames) as Lang[]).map((key) => ({
            value: key,
            label: languageNames[key],
          }))}
        />
      </Section>

      <Section title={t("appearance.preview")}>
        <PreviewRow />
      </Section>

      <Section title={t("settings.colors")} hint={t("appearance.colorsHint")}>
        <div className="grid grid-cols-2 gap-2">
          {(["chinese", "western"] as const).map((scheme) => {
            const active = settings.colorScheme === scheme;
            const upIsRed = scheme === "chinese";
            return (
              <button
                key={scheme}
                type="button"
                onClick={() => void updateSettings({ colorScheme: scheme })}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-3 rounded-[6px] border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-accent/70 bg-accent-soft/40"
                    : "border-hairline bg-panel hover:bg-surface",
                )}
              >
                <span
                  className="num flex size-8 items-center justify-center rounded-[4px] text-[12px] font-semibold"
                  style={{
                    color: upIsRed ? "var(--red)" : "var(--green)",
                    background: `color-mix(in oklch, ${upIsRed ? "var(--red)" : "var(--green)"} 10%, transparent)`,
                  }}
                >
                  +
                </span>
                <span
                  className="num flex size-8 items-center justify-center rounded-[4px] text-[12px] font-semibold"
                  style={{
                    color: upIsRed ? "var(--green)" : "var(--red)",
                    background: `color-mix(in oklch, ${upIsRed ? "var(--green)" : "var(--red)"} 10%, transparent)`,
                  }}
                >
                  −
                </span>
                <span className="flex flex-1 flex-col leading-tight">
                  <span className="text-[12.5px] font-medium">
                    {t(`settings.colors.${scheme}`)}
                  </span>
                  <span className="text-[10.5px] text-faint">
                    {t(`appearance.${scheme}Hint`)}
                  </span>
                </span>
                {active ? <Check size={12} strokeWidth={2.6} className="text-accent" /> : null}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

/** A miniature of a watchlist row using the live tokens, so the palette and
 *  the gain/loss direction can be judged before leaving the tab. */
function PreviewRow() {
  const { t, quotes, stocks } = useStore();
  const stock = stocks.find((s) => quotes[s.id]) ?? null;
  const quote = stock ? quotes[stock.id] : null;
  const up = (quote?.change ?? 0) >= 0;
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/70">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="truncate text-[13px] font-medium">
            {stock?.name ?? t("preview.sampleName")}
          </span>
          <span className="num text-[10px] uppercase text-faint">
            {stock?.code ?? "600519"} · {t(`market.${stock?.market ?? "a"}`)}
          </span>
        </div>
        <div className="flex flex-col items-end gap-[2px]">
          <span className={cn("num text-[14px]", up ? "text-up" : "text-down")}>
            {formatPrice(quote?.price ?? 1437.51)}
          </span>
          <span className={cn("num text-[11px]", up ? "text-up" : "text-down")}>
            {formatPercent(quote?.changePercent ?? 0.82)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-surface/40 px-3 py-1.5">
        <span className="text-[10.5px] text-faint">{t("preview.caption")}</span>
        <div className="flex items-center gap-2">
          <span className="num text-[10.5px] text-up">+2.4%</span>
          <span className="num text-[10.5px] text-down">−1.1%</span>
          <span className="h-3 w-px bg-hairline" aria-hidden />
          <span className="text-[10.5px] font-medium text-accent">{t("preview.accent")}</span>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  theme,
  active,
  label,
  onClick,
}: {
  theme: Theme;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group overflow-hidden rounded-[6px] border text-left transition-colors",
        active ? "border-accent/70" : "border-hairline hover:border-accent/40",
      )}
    >
      <div
        className={cn(
          "flex h-[54px] flex-col justify-center gap-1 px-2.5",
          theme === "system"
            ? "bg-[linear-gradient(110deg,#f7f5f0_50%,#1c1c1b_50%)]"
            : dark
              ? "bg-[#1c1c1b]"
              : "bg-[#f7f5f0]",
        )}
      >
        <div className="flex items-center gap-1">
          <span
            className={cn(
              "h-[3px] w-8 rounded-full",
              dark ? "bg-white/25" : "bg-black/20",
            )}
          />
          <span className={cn("h-[3px] w-3 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
        </div>
        <div className="flex items-center gap-1">
          <span className={cn("h-[3px] w-5 rounded-full", dark ? "bg-white/18" : "bg-black/15")} />
          <span
            className="h-[3px] w-5 rounded-full"
            style={{ background: "oklch(0.62 0.15 28)" }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between bg-panel px-2.5 py-1.5">
        <span className="text-[12px]">{label}</span>
        {active ? <Check size={10} strokeWidth={2.6} className="text-accent" /> : null}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Menu bar                                                            */
/* ------------------------------------------------------------------ */

function MenuBarTab() {
  const { t, stocks, settings, updateSettings, launchAtLogin, setLaunchAtLogin } = useStore();
  if (!settings) return null;
  const modes: { value: MenuBarMode; label: string; example: string }[] = [
    { value: "stock", label: t("settings.menubar.stock"), example: "贵州茅台 1437.51 −0.52%" },
    { value: "dailyPnl", label: t("settings.menubar.daily"), example: "日+2,479.63" },
    { value: "totalPnl", label: t("settings.menubar.total"), example: "浮+15,876.10" },
    { value: "bothPnl", label: t("settings.menubar.both"), example: "日+2,479 浮+15,876" },
    { value: "none", label: t("settings.menubar.none"), example: "◉" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Section title={t("settings.menubarMode")} hint={t("menubar.hint")}>
        <div className="flex flex-col gap-1">
          {modes.map((mode) => {
            const active = settings.menuBarMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                onClick={() => void updateSettings({ menuBarMode: mode.value })}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-3 rounded-[6px] border px-2.5 py-1.5 text-left transition-colors",
                  active
                    ? "border-accent/70 bg-accent-soft/40"
                    : "border-hairline bg-panel hover:bg-surface",
                )}
              >
                <span className="flex w-[132px] shrink-0 items-center gap-1.5 overflow-hidden">
                  <span className="inline-block size-[3px] shrink-0 rounded-full bg-faint" />
                  <span className="num truncate whitespace-nowrap text-[11.5px] text-muted-foreground">
                    {mode.example}
                  </span>
                </span>
                <span className="flex-1 text-[12.5px] font-medium">{mode.label}</span>
                {active ? <Check size={11} strokeWidth={2.6} className="text-accent" /> : null}
              </button>
            );
          })}
        </div>
      </Section>

      {settings.menuBarMode !== "stock" && settings.menuBarMode !== "none" ? (
        <Section title={t("settings.menubarPnlFormat")} hint={t("settings.menubarPnlFormatHint")}>
          <Segmented<MenuBarPnlFormat>
            ariaLabel={t("settings.menubarPnlFormat")}
            value={settings.menuBarPnlFormat ?? "amount"}
            onChange={(value) => void updateSettings({ menuBarPnlFormat: value })}
            options={[
              { value: "amount", label: t("menubar.pnl.amount") },
              { value: "percent", label: t("menubar.pnl.percent") },
              { value: "both", label: t("menubar.pnl.both") },
            ]}
          />
          <MenuBarPreview mode={settings.menuBarMode} format={settings.menuBarPnlFormat ?? "amount"} />
        </Section>
      ) : null}

      {settings.menuBarMode === "stock" ? (
        <Section title={t("settings.menubarStock")}>
          <select
            value={settings.menuBarStockId}
            onChange={(e) => void updateSettings({ menuBarStockId: e.target.value })}
            aria-label={t("settings.menubarStock")}
            className="h-7 w-full max-w-[280px] rounded-[5px] border border-hairline bg-panel px-1.5 text-[12.5px] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-[color-mix(in_oklch,var(--accent)_45%,transparent)]"
          >
            <option value="">
              {t("settings.menubarStockFirst", { name: stocks[0]?.name ?? "—" })}
            </option>
            {stocks.map((stock) => (
              <option key={stock.id} value={stock.id}>
                {stock.name} · {stock.code}
              </option>
            ))}
          </select>
        </Section>
      ) : null}

      <Section title={t("settings.data")}>
        <FieldRow label={t("settings.refresh")} hint={t("settings.refreshHint")}>
          <Segmented
            ariaLabel={t("settings.refresh")}
            value={String(settings.refreshInterval)}
            onChange={(value) => void updateSettings({ refreshInterval: Number(value) })}
            options={["3", "5", "10", "30"].map((v) => ({
              value: v,
              label: `${v}${t("unit.second")}`,
            }))}
          />
        </FieldRow>
        <FieldRow label={t("settings.currency")}>
          <Segmented
            ariaLabel={t("settings.currency")}
            value={settings.currency}
            onChange={(value) =>
              void updateSettings({ currency: value as typeof settings.currency })
            }
            options={[
              { value: "CNY", label: "¥ CNY" },
              { value: "HKD", label: "HK$ HKD" },
              { value: "USD", label: "$ USD" },
              { value: "KRW", label: "₩ KRW" },
            ]}
          />
        </FieldRow>
        <FieldRow label={t("settings.sort")}>
          <Segmented<SortRule>
            ariaLabel={t("settings.sort")}
            value={settings.sortRule}
            onChange={(value) => void updateSettings({ sortRule: value })}
            options={[
              { value: "changeDesc", label: t("settings.sort.desc") },
              { value: "changeAsc", label: t("settings.sort.asc") },
              { value: "manual", label: t("settings.sort.manual") },
            ]}
          />
        </FieldRow>
        <FieldRow label={t("settings.usPrice")}>
          <Segmented<UsPriceMode>
            ariaLabel={t("settings.usPrice")}
            value={settings.usPriceMode}
            onChange={(value) => void updateSettings({ usPriceMode: value })}
            options={[
              { value: "session", label: t("settings.usPrice.session") },
              { value: "regular", label: t("settings.usPrice.regular") },
            ]}
          />
        </FieldRow>
      </Section>

      <Section title={t("settings.startup")}>
        <div className="flex flex-col gap-2">
          <ToggleRow
            label={t("settings.groupHoldings")}
            hint={t("settings.groupHoldingsHint")}
            checked={settings.groupHoldings}
            onChange={(value) => void updateSettings({ groupHoldings: value })}
          />
          <ToggleRow
            label={t("settings.startup")}
            hint={t("settings.startupHint")}
            checked={launchAtLogin}
            onChange={(value) => void setLaunchAtLogin(value)}
          />
          <FieldRow label={t("settings.flashDuration")} hint={t("settings.flashDurationHint")}>
            <Segmented<FlashDuration>
              ariaLabel={t("settings.flashDuration")}
              value={settings.flashDuration ?? "normal"}
              onChange={(value) => void updateSettings({ flashDuration: value })}
              options={[
                { value: "off", label: t("flash.off") },
                { value: "short", label: t("flash.short") },
                { value: "normal", label: t("flash.normal") },
                { value: "long", label: t("flash.long") },
              ]}
              size="sm"
            />
          </FieldRow>
          <ToggleRow
            label={t("settings.dockIcon")}
            hint={t("settings.dockIconHint")}
            checked={settings.showDockIcon}
            onChange={(value) => void updateSettings({ showDockIcon: value })}
          />
        </div>
      </Section>
    </div>
  );
}

/** Shows the exact string the tray will render for the chosen mode+format. */
function MenuBarPreview({ mode, format }: { mode: MenuBarMode; format: MenuBarPnlFormat }) {
  const { t, totals, settings, lang } = useStore();
  const sum = totals();
  const symbol = { CNY: "¥", HKD: "HK$", USD: "$", KRW: "₩" }[settings?.currency ?? "CNY"];
  const money = (v: number) => {
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "+";
    return abs >= 10_000 ? `${sign}${symbol}${(abs / 10_000).toFixed(1)}w` : `${sign}${symbol}${abs.toFixed(0)}`;
  };
  const pct = (v: number) => {
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "+";
    if (abs >= 100) return `${sign}${abs.toFixed(0)}%`;
    if (abs >= 10) return `${sign}${abs.toFixed(1)}%`;
    return `${sign}${abs.toFixed(2)}%`;
  };
  const unit = (v: number, p: number) =>
    format === "percent" ? pct(p) : format === "both" ? `${money(v)} ${pct(p)}` : money(v);
  const prefix = lang === "en" ? ["D", "T"] : lang === "ja" ? ["日", "含"] : ["日", "浮"];
  const parts: string[] = [];
  if (mode !== "totalPnl") parts.push(`${prefix[0]}${unit(sum.daily, sum.dailyPercent)}`);
  if (mode !== "dailyPnl") parts.push(`${prefix[1]}${unit(sum.total, sum.percent)}`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 rounded-[6px] border border-border/70 bg-surface/60 px-2.5 py-1.5">
        <span className="flex size-4 items-center justify-center rounded-[3px] bg-foreground/80" aria-hidden />
        <span className="num truncate text-[12px] text-foreground">
          {parts.join("  ") || t("menubar.previewEmpty")}
        </span>
      </div>
      <span className="text-[10.5px] text-faint">{t("menubar.previewHint")}</span>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[6px] border border-hairline bg-panel px-2.5 py-2">
      <div className="flex flex-col gap-[1px]">
        <span className="text-[12.5px] font-medium">{label}</span>
        <span className="text-[11px] text-faint">{hint}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                           */
/* ------------------------------------------------------------------ */

function ShortcutsTab() {
  const { t } = useStore();
  const rows = [
    ["/", "shortcut.focusSearch"],
    ["⌘R", "shortcut.refresh"],
    ["⌘,", "shortcut.settings"],
    ["⌘K", "shortcut.quickAdd"],
    ["Esc", "shortcut.close"],
    ["Enter", "shortcut.openRow"],
    ["↑ ↓", "shortcut.moveRow"],
    ["Space", "shortcut.toggleGroup"],
  ];
  return (
    <div className="flex flex-col">
      {rows.map(([keys, label]) => (
        <div
          key={keys}
          className="flex items-center justify-between border-b border-border/50 py-2 last:border-0"
        >
          <span className="text-[12.5px] text-muted-foreground">{t(label)}</span>
          <kbd className="num rounded-[4px] border border-hairline bg-surface px-1.5 py-0.5 text-[11.5px]">
            {keys}
          </kbd>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* About                                                               */
/* ------------------------------------------------------------------ */

/** Bookkeeping settings live here rather than in the ledger window: one place
 *  to configure the app, whether a control belongs to the books or the quotes. */
/** One proposed re-label, editable before it is saved. */
interface Proposal {
  id: string;
  date: string;
  counterparty: string;
  note: string;
  amount: number;
  kind: string;
  from: string;
  to: string;
  confidence: number;
  accepted: boolean;
}


function AgentTab() {
  const { t } = useStore();
  const [data, setData] = React.useState<AgentSkills | null>(null);
  // Which button was copied last, so the label can flip to a check for a moment.
  const [copied, setCopied] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void api
      .agentSkills()
      .then((value) => {
        if (alive) setData(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const copy = React.useCallback(
    async (key: string, text: string) => {
      const ok = await copyText(text);
      setFailed(!ok);
      if (!ok) return;
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
    },
    [],
  );

  // The handoff text is generated from the live paths, so an agent never has to
  // guess where the binary or the ledger sits on this machine.
  const prompt = React.useMemo(() => {
    if (!data) return "";
    return t("settings.agent.promptBody", {
      bin: data.binary || "stockpot",
      dataDir: data.dataDir,
    });
  }, [data, t]);

  const copyButton = (key: string, text: string, label: string) => (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void copy(key, text)}
      disabled={!text}
      className="gap-1.5"
    >
      {copied === key ? <Check size={11} strokeWidth={2.4} /> : <Copy size={11} strokeWidth={2} />}
      {copied === key ? t("settings.agent.copied") : label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <Section title={t("settings.agent.title")} hint={t("settings.agent.hint")}>
        <div className="flex flex-col gap-2 rounded-[8px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <div className="flex flex-col gap-[3px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t("settings.agent.cli")}
            </span>
            <code className="break-all font-mono text-[11.5px] text-foreground">
              {data?.binary || "…"}
            </code>
          </div>
          <div className="flex flex-col gap-[3px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t("settings.agent.dataDir")}
            </span>
            <code className="break-all font-mono text-[11.5px] text-muted-foreground">
              {data?.dataDir || "…"}
            </code>
          </div>
          {failed ? (
            <span className="text-[11px] text-[color:var(--red)]">
              {t("settings.agent.copyFailed")}
            </span>
          ) : null}
        </div>
      </Section>

      <Section
        title={t("settings.agent.prompt")}
        hint={t("settings.agent.promptHint")}
        action={copyButton("prompt", prompt, t("settings.agent.copyPrompt"))}
      >
        <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-hairline/70 bg-surface/50 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {prompt || "…"}
        </pre>
      </Section>

      <Section title={t("settings.agent.skills")} hint={t("settings.agent.skillsHint")}>
        {(data?.skills ?? []).map((skill) => (
          <div
            key={skill.name}
            className="flex flex-col gap-2 rounded-[8px] border border-hairline/70 bg-panel/60 px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-medium">{skill.title}</span>
              <code className="rounded-[3px] border border-hairline px-1 text-[10px] text-faint">
                {skill.path}
              </code>
              <span className="flex-1" />
              {copyButton(`skill-${skill.name}`, skill.body, t("settings.agent.copySkill"))}
            </div>
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-hairline/60 bg-surface/40 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
              {skill.body}
            </pre>
          </div>
        ))}
      </Section>
    </div>
  );
}

function LedgerAiTab() {
  const { t } = useStore();
  const [note, setNote] = React.useState<string | null>(null);
  const [ledger, setLedger] = React.useState<Ledger | null>(null);
  const [aiRunning, setAiRunning] = React.useState(false);
  const [aiProgress, setAiProgress] = React.useState({ done: 0, total: 0 });
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [proposals, setProposals] = React.useState<Proposal[] | null>(null);
  const [scope, setScope] = React.useState("all");
  React.useEffect(() => {
    ledgerApi.state().then((state) => setLedger(state.ledger)).catch(() => {});
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ done: number; total: number }>("ai-progress", (event) => setAiProgress(event.payload)).then((fn) => { unlisten = fn; }));
    return () => unlisten?.();
  }, []);
  const runAi = async () => {
    const ids = (ledger?.entries ?? [])
      .filter((entry) => scope === "all" || entry.category === scope || entry.category.startsWith(`${scope}/`))
      .map((entry) => entry.id);
    setAiRunning(true); setAiError(null);
    setAiProgress({ done: 0, total: Math.ceil(ids.length / 12) });
    try {
      const result = await ledgerApi.aiClassify(ids);
      if (result.errors.length) setAiError(result.errors.join(" · "));
      const byId = new Map((ledger?.entries ?? []).map((entry) => [entry.id, entry]));
      const changes: Proposal[] = [];
      for (const suggestion of result.suggestions) {
        const entry = byId.get(suggestion.id); if (!entry) continue;
        changes.push({ id: suggestion.id, date: entry.date, counterparty: entry.counterparty, note: entry.note, amount: entry.amount, kind: entry.kind, from: entry.category, to: suggestion.category, confidence: suggestion.confidence, accepted: entry.category !== suggestion.category });
      }
      setProposals(changes);
    } catch (err) { setAiError(String(err)); } finally { setAiRunning(false); }
  };
  const applyProposals = async () => {
    if (!proposals) return;
    const byCategory = new Map<string, string[]>();
    for (const proposal of proposals.filter((p) => p.accepted && p.to.trim())) byCategory.set(proposal.to, [...(byCategory.get(proposal.to) ?? []), proposal.id]);
    let next = ledger;
    for (const [category, ids] of byCategory) next = await ledgerApi.recategorize(ids, category);
    setLedger(next); setProposals(null); setNote(t("settings.ledger.classifySaved", { n: proposals.filter((p) => p.accepted).length }));
  };
  return (
    <div className="flex flex-col gap-6">
      <Section title={t("settings.ledger.ai")} hint={t("settings.ledger.aiHint")}>
        <AiSettings onChange={setNote} />
        {note ? <p className="text-[11px] text-faint">{note}</p> : null}
      </Section>
      <div className="flex flex-wrap items-center gap-2">
        <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label={t("settings.ledger.aiScope")} className="h-[28px] rounded-[5px] border border-border bg-surface px-1.5 text-[11px]">
          <option value="all">{t("settings.ledger.aiAll")}</option>
          {orderedCategories(ledger?.categories ?? []).map((def) => <option key={categoryPath(def)} value={categoryPath(def)}>{categoryPath(def)}</option>)}
        </select>
        <Button variant="primary" size="sm" disabled={aiRunning} onClick={() => void runAi()}><Sparkles size={11} strokeWidth={2.2} />{aiRunning ? t("settings.ledger.aiRunning") : t("settings.ledger.aiRun")}</Button>
        {aiRunning ? (
          <div className="flex min-w-[200px] flex-1 items-center gap-2">
            <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-surface-strong/70" role="progressbar" aria-label={t("settings.ledger.aiProgress")} aria-valuenow={aiProgress.done} aria-valuemax={aiProgress.total || 1}>
              <div className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-200" style={{ width: `${aiProgress.total ? (aiProgress.done / aiProgress.total) * 100 : 0}%` }} />
            </div>
            <span className="num text-[11px] text-faint">{aiProgress.done}/{aiProgress.total || "—"}</span>
          </div>
        ) : null}
        {aiError ? <span className="text-[11px] text-[color:var(--red)]">{aiError}</span> : null}
      </div>
      <Section title={t("settings.ledger.aiCategories")} hint={t("settings.ledger.aiCategoriesHint")}>
        <CategoryDescriptionEditor />
      </Section>
      <ReclassifyReview proposals={proposals} t={t} onClose={() => setProposals(null)} onChange={setProposals} onApply={() => void applyProposals()} />
    </div>
  );
}

function CategoryDescriptionEditor() {
  const { t } = useStore();
  const [ledger, setLedger] = React.useState<Ledger | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    ledgerApi.state().then((state) => setLedger(state.ledger)).catch(() => {});
  }, []);
  const categories = orderedCategories(ledger?.categories ?? []);
  const groups = categories.filter((def) => !def.parent);
  const matches = (def: (typeof categories)[number]) => {
    const text = `${categoryPath(def)} ${def.description}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  };
  const visible = (def: (typeof categories)[number]) =>
    !query.trim() || matches(def) || categories.some((child) => child.parent === def.name && matches(child));
  return (
    <div className="flex flex-col gap-2">
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.ledger.aiSearch")} aria-label={t("settings.ledger.aiSearch")} className="h-[28px] text-[12px]" />
      <div className="flex flex-col gap-1.5">
        {groups.filter(visible).map((group) => {
          const children = categories.filter((def) => def.parent === group.name && (!query.trim() || matches(def) || matches(group)));
          const isCollapsed = !query.trim() && collapsed[group.name];
          return (
            <div key={group.name} className="rounded-[5px] border border-hairline/60">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button type="button" aria-label={t("settings.ledger.aiToggle", { name: group.name })} aria-expanded={!isCollapsed} onClick={() => setCollapsed((prev) => ({ ...prev, [group.name]: !prev[group.name] }))} className="flex size-5 items-center justify-center rounded-[3px] text-muted-foreground hover:bg-surface">
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <CategoryIcon icon={categoryIconKey(group)} size={12} className="text-muted-foreground" />
                <span className="flex-1 text-[12px] font-medium">{group.name}</span>
                <span className="num text-[10px] text-faint">{children.length}</span>
              </div>
              {!isCollapsed ? (
                <div className="flex flex-col gap-1.5 border-t border-hairline/40 px-2 py-1.5">
                  {[group, ...children].map((def) => {
                    const path = categoryPath(def);
                    const description = drafts[path] ?? def.description;
                    return (
                      <div key={path} className={cn("flex flex-col gap-1 rounded-[4px] px-2 py-1.5", def.parent && "ml-5 border-l border-hairline/60")}>
                        <div className="flex items-center gap-2 text-[11.5px]">
                          <CategoryIcon icon={categoryIconKey(def)} size={11} className="text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{def.name}</span>
                          <Button variant="ghost" size="sm" className="h-[22px] px-1.5 text-[10px]" onClick={() => void ledgerApi.updateCategory({ name: def.name, parent: def.parent, newName: def.name, newParent: def.parent, icon: def.icon, kind: def.kind, description }).then(setLedger).catch((err: unknown) => setError(String(err)))}>
                            <Check size={10} strokeWidth={2.6} />
                            {t("action.save")}
                          </Button>
                        </div>
                        <textarea value={description} onChange={(event) => setDrafts((prev) => ({ ...prev, [path]: event.target.value }))} aria-label={t("settings.ledger.aiDescription", { name: path })} rows={2} className="w-full resize-none rounded-[4px] border border-border bg-surface px-2 py-1 text-[11px] leading-snug" />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <p className="text-[11px] text-[color:var(--red)]">{error}</p> : null}
    </div>
  );
}

function LedgerSettingsTab() {
  const { t, lang } = useStore();
  const [ledger, setLedger] = React.useState<Ledger | null>(null);
  const [dataDir, setDataDir] = React.useState("");
  const [name, setName] = React.useState("");
  const [parent, setParent] = React.useState("");
  const [kind, setKind] = React.useState<"" | "expense" | "income">("");
  const [icon, setIcon] = React.useState("");
  /** 用户有没有亲自挑过图标；没挑就跟分类名自动配的那个走 */
  const [iconTouched, setIconTouched] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [clearing, setClearing] = React.useState(false);
  const [clearMessage, setClearMessage] = React.useState<string | null>(null);
  const [resettingCategories, setResettingCategories] = React.useState(false);
  /** Path of the category being edited inline. */
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({ name: "", parent: "", icon: "dots", kind: "", description: "" });

  const [rulePattern, setRulePattern] = React.useState("");
  const [ruleCategory, setRuleCategory] = React.useState("");
  const [ruleError, setRuleError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    ledgerApi
      .state()
      .then((state) => {
        if (!alive) return;
        setLedger(state.ledger);
        setDataDir(state.dataDir);
      })
      .catch((err: unknown) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const categories = ledger?.categories ?? [];
  const ordered = React.useMemo(() => orderedCategories(categories), [categories]);
  const groups = categories.filter((c) => !c.parent);

  const addRule = async () => {
    if (!rulePattern.trim() || !ruleCategory) return;
    try {
      setLedger(await ledgerApi.addRule(rulePattern.trim(), ruleCategory));
      setRulePattern(""); setRuleError(null);
    } catch (err) {
      setRuleError(String(err).includes("duplicate") ? t("ledger.categories.duplicate") : String(err));
    }
  };

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of ledger?.entries ?? []) {
      map.set(entry.category, (map.get(entry.category) ?? 0) + 1);
    }
    return map;
  }, [ledger]);

  /** A group's count includes its leaves. */
  const countFor = (def: typeof categories[number]) => {
    const path = categoryPath(def);
    let total = counts.get(path) ?? 0;
    if (!def.parent) {
      for (const [category, count] of counts) {
        if (category.startsWith(`${path}/`)) total += count;
      }
    }
    return total;
  };

  const addCategory = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const picked = iconTouched ? icon : icon || guessCategoryIcon(trimmed);
      setLedger(await ledgerApi.addCategory(trimmed, parent, picked, kind, description));
      setName("");
      setDescription("");
      setError(null);
    } catch (err) {
      setError(String(err).includes("duplicate") ? t("ledger.categories.duplicate") : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Section title={t("settings.ledger.categories")} hint={t("settings.ledger.categoriesHint")}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addCategory();
              }
            }}
            placeholder={t("ledger.categories.placeholder")}
            className="h-[27px] w-[168px] text-[12.5px]"
            aria-label={t("ledger.categories.placeholder")}
          />
          <select
            value={parent}
            onChange={(event) => setParent(event.target.value)}
            aria-label={t("ledger.categories.parent")}
            className="h-[27px] rounded-[5px] border border-border bg-surface px-1.5 text-[12px]"
          >
            <option value="">{t("ledger.categories.topLevel")}</option>
            {groups.map((group) => (
              <option key={group.name} value={group.name}>
                {group.name}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as "" | "expense" | "income")}
            aria-label={t("ledger.categories.kind")}
            className="h-[27px] rounded-[5px] border border-border bg-surface px-1.5 text-[12px]"
          >
            <option value="">{t("ledger.categories.kindAny")}</option>
            <option value="expense">{t("ledger.kind.expense")}</option>
            <option value="income">{t("ledger.kind.income")}</option>
          </select>
          <CategoryIconPicker
            value={iconTouched ? icon : icon || guessCategoryIcon(name) || "dots"}
            onChange={(key) => {
              setIcon(key);
              setIconTouched(true);
            }}
            t={t}
          />
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("settings.ledger.categoryDescription")}
            aria-label={t("settings.ledger.categoryDescription")}
            className="h-[27px] w-[240px] text-[11.5px]"
          />
          <Button variant="secondary" size="sm" onClick={() => void addCategory()}>
            <Plus size={11} strokeWidth={2.4} />
            {t("ledger.categories.add")}
          </Button>
          {error ? <span className="text-[11.5px] text-[color:var(--red)]">{error}</span> : null}
        </div>

        <div className="mt-1 flex flex-col gap-1">
          {ordered.map((def) => {
            const path = categoryPath(def);
            const isEditing = editing === path;
            if (isEditing) {
              return (
                <div
                  key={path}
                  className="flex flex-wrap items-center gap-1.5 rounded-[5px] border border-accent/50 bg-accent-soft/40 px-2 py-[5px] text-[12px]"
                >
                  <Input
                    value={draft.name}
                    onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
                    aria-label={t("ledger.categories.name")}
                    className="h-[24px] w-[112px] text-[12px]"
                  />
                  <select
                    value={draft.parent}
                    onChange={(event) => setDraft((d) => ({ ...d, parent: event.target.value }))}
                    aria-label={t("ledger.categories.parent")}
                    className="h-[24px] rounded-[4px] border border-border bg-panel px-1 text-[11.5px]"
                  >
                    <option value="">{t("ledger.categories.topLevel")}</option>
                    {groups
                      .filter((group) => group.name !== path)
                      .map((group) => (
                        <option key={group.name} value={group.name}>
                          {group.name}
                        </option>
                      ))}
                  </select>
                  <select
                    value={draft.kind}
                    onChange={(event) => setDraft((d) => ({ ...d, kind: event.target.value }))}
                    aria-label={t("ledger.categories.kind")}
                    className="h-[24px] rounded-[4px] border border-border bg-panel px-1 text-[11.5px]"
                  >
                    <option value="">{t("ledger.categories.kindAny")}</option>
                    <option value="expense">{t("ledger.kind.expense")}</option>
                    <option value="income">{t("ledger.kind.income")}</option>
                  </select>
                  <CategoryIconPicker
                    value={draft.icon || guessCategoryIcon(draft.name) || "dots"}
                    onChange={(key) => setDraft((d) => ({ ...d, icon: key }))}
                    t={t}
                  />
                  <span className="flex-1" />
                  <Button
                    variant="primary"
                    size="sm"
                    className="h-[22px] px-1.5 text-[11px]"
                    onClick={() =>
                      void ledgerApi
                        .updateCategory({
                          name: def.name,
                          parent: def.parent,
                          newName: draft.name.trim(),
                          newParent: draft.parent,
                          icon: draft.icon || guessCategoryIcon(draft.name),
                          kind: draft.kind,
                          description: draft.description,
                        })
                        .then((next) => {
                          setLedger(next);
                          setEditing(null);
                        })
                        .catch((err: unknown) =>
                          setError(
                            String(err).includes("duplicate")
                              ? t("ledger.categories.duplicate")
                              : String(err),
                          ),
                        )
                    }
                  >
                    <Check size={10} strokeWidth={2.8} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-[22px] px-1.5 text-[11px]"
                    onClick={() => setEditing(null)}
                  >
                    <X size={10} strokeWidth={2.6} />
                  </Button>
                </div>
              );
            }
            return (
              <div
                key={path}
                className="flex items-center gap-2 rounded-[5px] border border-hairline/60 bg-surface/40 px-2 py-[4px] text-[12px]"
              >
                {def.parent ? (
                  <span className="w-3 shrink-0 text-faint" aria-hidden>
                    └
                  </span>
                ) : null}
                <CategoryIcon icon={categoryIconKey(def)} size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{def.name}</span>
                {def.parent ? (
                  <span className="shrink-0 text-[10px] text-faint">{def.parent}</span>
                ) : null}
                {def.kind ? (
                  <span className="shrink-0 text-[10px] text-faint">
                    {t(`ledger.kind.${def.kind}`)}
                  </span>
                ) : null}
                <span className="num w-8 shrink-0 text-right text-[10.5px] text-faint">
                  {countFor(def)}
                </span>
                <button
                  type="button"
                  aria-label={t("ledger.action.edit")}
                  onClick={() => {
                    setEditing(path);
                    setDraft({
                      name: def.name,
                      parent: def.parent,
                      icon: def.icon || "dots",
                      kind: def.kind,
                      description: def.description,
                    });
                  }}
                  className="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-faint hover:bg-panel hover:text-foreground"
                >
                  <Pencil size={9} strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  aria-label={t("ledger.categories.remove", { name: path })}
                  onClick={() =>
                    void ledgerApi.removeCategory(path).then(setLedger).catch(() => {})
                  }
                  className="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-faint hover:bg-panel hover:text-[color:var(--red)]"
                >
                  <X size={9} strokeWidth={2.6} />
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-faint">{t("ledger.categories.removeHint")}</p>
      </Section>

      <Section title={t("settings.ledger.rules")} hint={t("settings.ledger.rulesHint")}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={rulePattern}
            onChange={(event) => setRulePattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addRule();
              }
            }}
            placeholder={t("settings.ledger.ruleKeyword")}
            aria-label={t("settings.ledger.ruleKeyword")}
            className="h-[27px] w-[160px] text-[12.5px]"
          />
          <span className="text-[12px] text-faint">→</span>
          <select
            value={ruleCategory}
            onChange={(event) => setRuleCategory(event.target.value)}
            aria-label={t("settings.ledger.ruleCategory")}
            className="h-[27px] w-[160px] rounded-[5px] border border-border bg-surface px-1.5 text-[12px]"
          >
            <option value="">{t("settings.ledger.rulePick")}</option>
            {orderedCategories(categories)
              .filter((def) => def.parent)
              .map((def) => (
                <option key={categoryPath(def)} value={categoryPath(def)}>
                  {categoryPath(def)}
                </option>
              ))}
          </select>
          <Button variant="secondary" size="sm" onClick={() => void addRule()}>
            <Plus size={11} strokeWidth={2.4} />
            {t("settings.ledger.ruleAdd")}
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void ledgerApi.applyRules().then((next) => {
                setLedger(next);
                setRuleError(null);
              })
            }
          >
            <RotateCcw size={11} strokeWidth={2.2} />
            {t("settings.ledger.rulesApply")}
          </Button>
        </div>
        {ruleError ? (
          <span className="text-[11.5px] text-[color:var(--red)]">{ruleError}</span>
        ) : null}
        <div className="flex max-h-[220px] flex-col overflow-y-auto rounded-[6px] border border-hairline/70">
          {(ledger?.rules ?? []).map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 border-b border-hairline/40 px-2.5 py-[4px] text-[12px] last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate">{rule.pattern}</span>
              <span className="text-faint">→</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{rule.category}</span>
              <button
                type="button"
                aria-label={t("ledger.action.delete")}
                onClick={() =>
                  void ledgerApi
                    .deleteRule(rule.id)
                    .then(setLedger)
                    .catch(() => {})
                }
                className="flex size-4 shrink-0 items-center justify-center rounded-[3px] text-faint hover:bg-panel hover:text-[color:var(--red)]"
              >
                <X size={9} strokeWidth={2.6} />
              </button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-faint">{t("settings.ledger.rulesOrder")}</p>
      </Section>

      <Section title={t("settings.ledger.data")} hint={t("ledger.about.dataHint")}>
        <div className="flex flex-col gap-1.5 rounded-[6px] border border-hairline/70 bg-surface/40 px-3 py-2">
          <span className="break-all text-[11.5px] text-muted-foreground">{dataDir || "—"}</span>
          <span className="text-[11px] text-faint">
            {t("ledger.about.summary", {
              entries: ledger?.entries.length ?? 0,
              total: ((ledger?.entries ?? []).reduce(
                (sum, entry) =>
                  sum + (entry.kind === "expense" ? entry.amount - (entry.refundedAmount ?? 0) : 0),
                0,
              ) / 100
              ).toLocaleString(lang === "en" ? "en-US" : "zh-CN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
            })}
          </span>
        </div>
      </Section>

      <Section title={t("settings.ledger.resetCategories")} hint={t("settings.ledger.resetCategoriesHint")}>
        <div className="flex items-center gap-2">
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (!resettingCategories) {
                setResettingCategories(true);
                return;
              }
              void ledgerApi.resetCategories().then((next) => {
                setLedger(next);
                setResettingCategories(false);
                setClearMessage(t("settings.ledger.categoriesReset"));
              }).catch((err: unknown) => {
                setResettingCategories(false);
                setClearMessage(String(err));
              });
            }}
          >
            <RotateCcw size={11} strokeWidth={2.2} />
            {resettingCategories ? t("ledger.action.confirmDelete") : t("settings.ledger.resetCategoriesAction")}
          </Button>
          {resettingCategories ? (
            <Button variant="ghost" size="sm" onClick={() => setResettingCategories(false)}>{t("action.cancel")}</Button>
          ) : null}
        </div>
      </Section>

      <Section title={t("ledger.about.danger")} hint={t("ledger.about.dangerHint")}>
        {clearMessage ? <p className="text-[11px] text-faint">{clearMessage}</p> : null}
        <div className="flex items-center gap-2">
          {clearing ? (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  void ledgerApi
                    .clear()
                    .then(async () => {
                      // Re-read after the write so the summary cannot retain a
                      // stale in-memory snapshot from the settings window.
                      const state = await ledgerApi.state();
                      setLedger(state.ledger);
                      setClearing(false);
                      setClearMessage(t("ledger.about.cleared"));
                    })
                    .catch((err: unknown) => {
                      setClearing(false);
                      setClearMessage(String(err));
                    });
                }}
              >
                <Check size={11} strokeWidth={2.6} />
                {t("ledger.action.confirmDelete")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setClearing(false)}>
                {t("action.cancel")}
              </Button>
            </>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setClearing(true)}>
              <Trash2 size={11} strokeWidth={2.2} />
              {t("ledger.about.clear")}
            </Button>
          )}
        </div>
      </Section>
    </div>
  );
}

/** Endpoint, model and key for AI classification. Kept in the shared settings
 *  file; nothing is sent anywhere until the user presses the button. */
function AiSettings({ onChange }: { onChange: (note: string | null) => void }) {
  const { t, settings, updateSettings } = useStore();
  const value = (settings as unknown as Record<string, string>) ?? {};
  const [endpoint, setEndpoint] = React.useState(String(value.aiEndpoint ?? "http://localhost:11434/v1"));
  const [model, setModel] = React.useState(String(value.aiModel ?? "tev1:4b"));
  const [key, setKey] = React.useState(String(value.aiApiKey ?? ""));
  const [batch, setBatch] = React.useState(String(value.aiBatchSize ?? "12"));

  const save = (patch: Record<string, string | number>) => {
    void updateSettings(patch as never).then(() => onChange(t("settings.ledger.aiSaved")));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.ledger.aiEndpoint")}
          </span>
          <Input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            onBlur={() => save({ aiEndpoint: endpoint })}
            placeholder="http://localhost:11434/v1"
            className="h-[27px] text-[12px]"
            aria-label={t("settings.ledger.aiEndpoint")}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.ledger.aiModel")}
          </span>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            onBlur={() => save({ aiModel: model })}
            placeholder="tev1:4b"
            className="h-[27px] text-[12px]"
            aria-label={t("settings.ledger.aiModel")}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.ledger.aiKey")}
          </span>
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onBlur={() => save({ aiApiKey: key })}
            type="password"
            placeholder="sk-…"
            className="h-[27px] text-[12px]"
            aria-label={t("settings.ledger.aiKey")}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t("settings.ledger.aiBatch")}
          </span>
          <Input
            value={batch}
            onChange={(event) => setBatch(event.target.value)}
            onBlur={() => save({ aiBatchSize: Number(batch) || 20 })}
            inputMode="numeric"
            className="num h-[27px] text-[12px]"
            aria-label={t("settings.ledger.aiBatch")}
          />
        </label>
      </div>
      <p className="text-[11px] text-faint">{t("settings.ledger.aiKeyHint")}</p>
    </div>
  );
}

/** Confirmation step for 智能分类: every proposal can be vetoed, re-pointed or
 *  accepted wholesale before anything is written. */
function ReclassifyReview({
  proposals,
  t,
  onClose,
  onChange,
  onApply,
}: {
  proposals: Proposal[] | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
  onChange: (next: Proposal[]) => void;
  onApply: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  if (!proposals) return null;
  const accepted = proposals.filter((proposal) => proposal.accepted).length;
  const groupsMap = new Map<string, { key: string; from: string; to: string; rows: Proposal[] }>();
  for (const proposal of proposals) {
    const key = `${proposal.from}\u0000${proposal.to}`;
    const group = groupsMap.get(key) ?? {
      key,
      from: proposal.from,
      to: proposal.to,
      rows: [],
    };
    group.rows.push(proposal);
    groupsMap.set(key, group);
  }
  // Biggest groups first: those are the decisions worth the attention.
  const groups = [...groupsMap.values()]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => b.confidence - a.confidence),
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
  const visibleGroups = groups.filter((group) => {
    const q = query.trim().toLowerCase();
    return !q || `${group.from} ${group.to}`.toLowerCase().includes(q) || group.rows.some((row) => `${row.counterparty} ${row.note}`.toLowerCase().includes(q));
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[min(560px,calc(100vh-48px))] w-[620px] flex-col p-5">
        <DialogTitle className="text-[14px] font-semibold">
          {t("settings.ledger.reviewTitle", { n: proposals.length })}
        </DialogTitle>
        <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
          {t("settings.ledger.reviewHint")}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.ledger.aiSearch")} aria-label={t("settings.ledger.aiSearch")} className="h-[26px] w-[180px] text-[11px]" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(proposals.map((p) => ({ ...p, accepted: true })))}
          >
            {t("settings.ledger.selectAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(proposals.map((p) => ({ ...p, accepted: false })))}
          >
            {t("settings.ledger.selectNone")}
          </Button>
          <span className="flex-1" />
          <span className="num text-[11.5px] text-faint">
            {t("settings.ledger.reviewAccepted", { n: accepted })}
          </span>
        </div>

        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
          {visibleGroups.map((group) => {
            const allOn = group.rows.every((row) => row.accepted);
            const isCollapsed = collapsed[group.key];
            return (
              <div key={group.key} className="rounded-[6px] border border-hairline/70">
                <div className="flex items-center gap-2 bg-surface/50 px-2.5 py-[5px] text-[11.5px]">
                  <button type="button" aria-label={t("settings.ledger.reviewToggle", { from: group.from, to: group.to })} aria-expanded={!isCollapsed} onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))} className="flex size-5 items-center justify-center text-muted-foreground">
                    {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  </button>
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={() =>
                      onChange(
                        proposals.map((p) =>
                          group.rows.some((row) => row.id === p.id)
                            ? { ...p, accepted: !allOn }
                            : p,
                        ),
                      )
                    }
                    aria-label={t("settings.ledger.reviewGroupToggle", {
                      from: group.from,
                      to: group.to,
                    })}
                    className="size-3 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="text-faint line-through">{group.from}</span>
                  <span className="text-faint">→</span>
                  <span className="font-semibold">{group.to}</span>
                  <span className="num text-faint">{group.rows.length}</span>
                  <span className="flex-1" />
                  <span className="num text-[10.5px] text-faint">
                    {Math.round(
                      (group.rows.reduce((sum, row) => sum + row.confidence, 0) /
                        group.rows.length) *
                        100,
                    )}
                    %
                  </span>
                </div>
                {!isCollapsed ? group.rows.map((row) => (
                  <label
                    key={row.id}
                    className="flex cursor-pointer items-center gap-2 border-t border-hairline/40 px-2.5 py-[4px] text-[11.5px] hover:bg-surface/40"
                  >
                    <input
                      type="checkbox"
                      checked={row.accepted}
                      onChange={() =>
                        onChange(
                          proposals.map((p) =>
                            p.id === row.id ? { ...p, accepted: !p.accepted } : p,
                          ),
                        )
                      }
                      aria-label={t("settings.ledger.reviewAccept")}
                      className="size-3 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="num w-[56px] shrink-0 text-[10.5px] text-faint">
                      {row.date.slice(5)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {row.counterparty || row.note || t("ledger.entries.untitled")}
                    </span>
                    <span className="num w-[74px] shrink-0 text-right text-[11px]">
                      {(row.amount / 100).toFixed(2)}
                    </span>
                  </label>
                )) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-hairline/60 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("action.cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={accepted === 0} onClick={onApply}>
            <Check size={11} strokeWidth={2.6} />
            {t("settings.ledger.reviewApply", { n: accepted })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

type AccountState = { signedIn: boolean; email: string; name: string; server: string };

/**
 * 账号：登录之后才知道是谁在同步。令牌存在本地库里，退出就删干净。
 *
 * 不登录也能用——这个应用本来就是个本地行情工具，账号只关系到「换一台机器
 * 还能把自选股带过去」。
 */
function AccountPanel() {
  const { t, pushToast } = useStore();
  const [state, setState] = React.useState<AccountState | null>(null);
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [syncing, setSyncing] = React.useState(false);
  const [syncNote, setSyncNote] = React.useState("");
  // 两边都有数据时停下来问一句，别默默替人做决定
  const [ask, setAsk] = React.useState<{ entries: number; stocks: number } | null>(null);

  React.useEffect(() => {
    if (!isTauri()) return;
    void call<AccountState>("account_state")
      .then(setState)
      .catch(() => undefined);
  }, []);

  async function runSync(mode: "merge" | "remote" | "push") {
    setSyncing(true);
    setAsk(null);
    try {
      const result = await call<{ summary: { entries: number; stocks: number } }>("sync_run", { mode });
      const note = t("sync.done", {
        entries: result.summary.entries,
        stocks: result.summary.stocks,
      });
      setSyncNote(note);
      pushToast(note);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSyncNote(message);
      pushToast(message);
    } finally {
      setSyncing(false);
    }
  }

  /** 登录后立刻看一眼云端：空就直接推，本地空就直接拉，两边都有才问。 */
  async function afterLogin() {
    try {
      const preview = await call<{
        remote: { entries: number; stocks: number };
        remoteEmpty: boolean;
        localHasData: boolean;
      }>("sync_preview");
      if (preview.remoteEmpty && !preview.localHasData) return;
      if (preview.remoteEmpty) {
        await runSync("push");
        return;
      }
      if (!preview.localHasData) {
        await runSync("remote");
        return;
      }
      setAsk({ entries: preview.remote.entries, stocks: preview.remote.stocks });
    } catch {
      // 同步没走通不该挡住登录本身，静默算了
    }
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next =
        mode === "login"
          ? await call<AccountState>("account_login", { email, password })
          : await call<AccountState>("account_register", { email, password, name });
      setState(next);
      setPassword("");
      pushToast(t("account.welcome", { name: next.name || next.email }));
      void afterLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      const next = await call<AccountState>("account_logout");
      setState(next);
      pushToast(t("account.signedOut"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (state?.signedIn) {
    return (
      <Section title={t("account.title")}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-[2px]">
              <span className="truncate text-[12.5px]">{state.name || state.email}</span>
              <span className="truncate text-[11px] text-faint">{state.email}</span>
              <span className="truncate text-[11px] text-faint">
                {t("account.server", { server: state.server })}
              </span>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 text-[11.5px]" disabled={busy} onClick={() => void logout()}>
              {t("account.logout")}
            </Button>
          </div>

          {/* 同步：账单、自选股、券商账户一起走 */}
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2">
            <span className="min-w-0 truncate text-[11px] text-faint" title={syncNote}>
              {syncNote || t("sync.hint")}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 text-[11.5px]"
              disabled={syncing}
              onClick={() => void runSync("merge")}
            >
              {syncing ? t("sync.working") : t("sync.now")}
            </Button>
          </div>

          {ask ? (
            <div className="flex flex-col gap-1.5 rounded-[6px] border border-hairline bg-surface/60 px-2.5 py-2">
              <span className="text-[11.5px]">
                {t("sync.ask", { entries: ask.entries, stocks: ask.stocks })}
              </span>
              <div className="flex items-center gap-1.5">
                <Button variant="secondary" size="sm" className="text-[11.5px]" onClick={() => void runSync("merge")}>
                  {t("sync.merge")}
                </Button>
                <Button variant="outline" size="sm" className="text-[11.5px]" onClick={() => void runSync("remote")}>
                  {t("sync.useRemote")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[11.5px] text-faint"
                  onClick={() => setAsk(null)}
                >
                  {t("sync.later")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Section>
    );
  }

  return (
    <Section title={t("account.title")}>
      <div className="flex flex-col gap-2">
        <p className="text-[11px] leading-relaxed text-faint">
          {mode === "login" ? t("account.hintLogin") : t("account.hintRegister")}
        </p>
        {mode === "register" ? (
          <input
            className="w-full rounded-[6px] border border-hairline bg-panel px-2 py-1.5 text-[12px] outline-none"
            placeholder={t("account.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        <input
          className="w-full rounded-[6px] border border-hairline bg-panel px-2 py-1.5 text-[12px] outline-none"
          placeholder={t("account.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded-[6px] border border-hairline bg-panel px-2 py-1.5 text-[12px] outline-none"
          type="password"
          placeholder={t("account.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {error ? <span className="text-[11px] text-down">{error}</span> : null}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" className="text-[11.5px]" disabled={busy} onClick={() => void submit()}>
            {busy ? t("account.working") : mode === "login" ? t("account.login") : t("account.register")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-[11.5px] text-faint"
            onClick={() => {
              setError("");
              setMode(mode === "login" ? "register" : "login");
            }}
          >
            {mode === "login" ? t("account.toRegister") : t("account.toLogin")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/**
 * 一块更新：先选源，再点检查。
 *
 * macOS 默认走 GitHub（自建服务器拉不到 GitHub 的包，但客户端能直连），
 * Windows 默认走自己的服务器。两边都留了切换，谁的网络更顺就用哪边。
 */
function UpdatePanel() {
  const { t, settings, updateSettings } = useStore();
  const [status, setStatus] = React.useState<
    "idle" | "checking" | "latest" | "found" | "downloading" | "installing" | "failed"
  >("idle");
  const [found, setFound] = React.useState("");
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState("");

  const source = settings?.updateSource ?? (navigator.platform.includes("Mac") ? "github" : "server");

  React.useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ chunk: number; total: number | null }>("update-progress", (event) => {
        const { chunk, total } = event.payload;
        if (total && total > 0) setProgress(Math.min(1, chunk / total));
      });
    })();
    return () => unlisten?.();
  }, []);

  async function checkNow() {
    setStatus("checking");
    setError("");
    try {
      const result = await call<{ available: boolean; version?: string }>("check_update");
      if (result.available && result.version) {
        setFound(result.version);
        setStatus("found");
      } else {
        setStatus("latest");
      }
    } catch (e) {
      setStatus("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function installNow() {
    setStatus("downloading");
    setProgress(0);
    try {
      const installed = await call<boolean>("install_update");
      // 真正装完，macOS 上车自己重启、Windows 交给安装器接管，都走不到下一行；
      // 能回来只说明这一次没找到更新，别拿「已是最新」盖过去
      setStatus(installed ? "installing" : "latest");
    } catch (e) {
      setStatus("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pct = Math.round(progress * 100);

  const hint = (() => {
    switch (status) {
      case "checking":
        return t("update.checking");
      case "latest":
        return t("update.latest");
      case "found":
        return t("update.found", { version: found });
      case "downloading":
        return pct > 0
          ? t("update.downloading", { pct })
          : t("update.downloadingUnknown");
      case "installing":
        return t("update.installing");
      case "failed":
        return t("update.failed", { error });
      default:
        return source === "github" ? t("update.hintGithub") : t("update.hintServer");
    }
  })();

  const busy = status === "checking" || status === "downloading" || status === "installing";

  return (
    <Section title={t("update.title")}>
      <div className="flex flex-col gap-2">
        <Segmented<"server" | "github">
          ariaLabel={t("update.source")}
          value={source}
          onChange={(value) => {
            setStatus("idle");
            void updateSettings({ updateSource: value as "server" | "github" });
          }}
          options={[
            { value: "server", label: t("update.sourceServer") },
            { value: "github", label: t("update.sourceGithub") },
          ]}
        />
        {source === "github" ? (
          <input
            className="w-full rounded-[6px] border border-hairline bg-panel px-2 py-1.5 text-[12px] outline-none"
            placeholder={t("update.tokenHint")}
            value={settings?.githubToken ?? ""}
            onChange={(e) => void updateSettings({ githubToken: e.target.value })}
          />
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span
            className={cn("min-w-0 truncate text-[11px]", status === "failed" ? "text-down" : "text-faint")}
            title={hint}
          >
            {hint}
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 text-[11.5px]"
            disabled={busy}
            onClick={() => void (status === "found" ? installNow() : checkNow())}
          >
            {status === "downloading" || status === "installing"
              ? status === "installing"
                ? t("update.installing")
                : pct > 0
                  ? t("update.downloading", { pct })
                  : t("update.downloadingUnknown")
              : status === "found"
                ? t("update.install")
                : t("update.check")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** 存储：路径 + 一键清空。清空是不可逆的，所以要按两下。 */
function StoragePanel() {
  const { t, dataFile, openDataDir, pushToast } = useStore();
  const [armed, setArmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function clearAll() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await call("clear_storage");
      pushToast(t("storage.cleared"));
      // 设置、自选、账本都回到出厂状态，直接重载最干净
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <Section title={t("storage.title")}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <code className="num flex-1 truncate rounded-[5px] border border-hairline bg-surface/60 px-2 py-1.5 text-[11px] text-muted-foreground">
            {dataFile}
          </code>
          <Button variant="secondary" size="sm" className="text-[11.5px]" onClick={openDataDir}>
            <FolderOpen size={10} strokeWidth={2.2} />
            {t("settings.openDataDir")}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2">
          <span className="text-[11px] leading-relaxed text-faint">
            {armed ? t("storage.confirm") : t("storage.hint")}
          </span>
          <Button
            variant={armed ? "danger" : "outline"}
            size="sm"
            className="shrink-0 text-[11.5px]"
            disabled={busy}
            onClick={() => void clearAll()}
            onMouseLeave={() => setArmed(false)}
          >
            {busy ? t("storage.working") : armed ? t("storage.confirmAction") : t("storage.clear")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function AboutTab() {
  const {
    t,
    notifyGranted,
    notifyChecked,
    requestNotifications,
    testNotification,
    pushToast,
    stocks,
    settings,
  } = useStore();
  const [version, setVersion] = React.useState("0.1.0");

  React.useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <AccountPanel />

      <Section title={t("settings.alerts")}>
        <div className="flex items-center justify-between gap-3 rounded-[6px] border border-hairline bg-panel px-2.5 py-2">
          <div className="flex items-center gap-2">
            <Bell
              size={13}
              strokeWidth={2}
              className={notifyGranted ? "text-up" : "text-faint"}
            />
            <div className="flex flex-col gap-[1px]">
              <span className="text-[12.5px] font-medium">
                {t("settings.notifications")}
              </span>
              <span
                className={cn(
                  "text-[11px]",
                  notifyGranted ? "text-up" : "text-muted-foreground",
                )}
              >
                {!notifyChecked
                  ? t("settings.notifications.unknown")
                  : notifyGranted
                    ? t("settings.notifications.granted")
                    : t("settings.notifications.denied")}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {!notifyGranted ? (
              <Button
                variant="secondary"
                size="sm"
                className="text-[11.5px]"
                onClick={() => void requestNotifications()}
              >
                {t("settings.notifications.enable")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="text-[11.5px]"
              onClick={() =>
                void testNotification().then(() => pushToast(t("settings.notifications.testSent")))
              }
            >
              {t("settings.notifications.test")}
            </Button>
          </div>
        </div>
      </Section>

      <StoragePanel />

      <UpdatePanel />

      <Section title={t("settings.about")}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px]">Stockpot</span>
            <span className="num text-[11.5px] text-faint">
              {t("settings.version", { version })}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-faint">{t("about.sources")}</p>
          <p className="text-[11px] leading-relaxed text-faint">{t("about.disclaimer")}</p>
          <div className="flex items-center gap-3 border-t border-border/60 pt-2 text-[11px] text-faint">
            <span>{t("settings.stocks.count", { n: stocks.length })}</span>
            <span className="size-[2px] rounded-full bg-faint/60" aria-hidden />
            <span>{t(`settings.menubar.${settings?.menuBarMode ?? "stock"}`)}</span>
            <span className="size-[2px] rounded-full bg-faint/60" aria-hidden />
            <span>{t(`settings.colors.${settings?.colorScheme ?? "chinese"}`)}</span>
          </div>
        </div>
      </Section>
    </div>
  );
}
