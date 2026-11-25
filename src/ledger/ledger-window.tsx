import * as React from "react";
import { dayTotals, groupByDay, totalsOf } from "./derive";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileUp,
  CreditCard,
  LayoutDashboard,
  Pencil,
  RotateCcw,
  Rows3,
  FolderKanban,
  FolderMinus,
  Wand2,
  Archive,
  Sparkles,
  Landmark,
  Settings2,
  Power,
  Plus,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { Tooltip } from "@/components/ui/tooltip";
import { TrendChart, CategoryPie, chartPalette } from "./recharts-charts";
import { OverlayScroll, useScrollViewport } from "@/components/ui/overlay-scroll";
import { offsetsOf } from "./virtual";
import { useVirtualWindow } from "./use-virtual-window";
import {
  CategoryIcon,
  CategorySelect,
  categoryMatches,
  categoryPath,
  orderedCategories,
} from "./categories";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import type { Lang } from "@/lib/i18n";
import { closeLedgerWindow, openSettingsWindow, quitApp } from "./host";
import {
  CaptionButtons,
  ResizeHandles,
  handleTitleBarDoubleClick,
} from "@/components/window-chrome";
import {
  currentMonth,
  dailyTrend,
  yearMonths,
  walletTotals,
  countsTowardTotals,
  effectiveAmount,
  formatCents,
  formatCompact,
  formatYuan,
  monthOf,
  shiftMonth,
  useLedger,
} from "./store";
import type {
  CategoryDef,
  CleanupReport,
  Project,
  ProjectInput,
  EntryInput,
  EntryKind,
  EntrySource,
  ImportPreview,
  LedgerEntry,
  RefundLinkInput,
  Wallet as WalletAccount,
  WalletInput,
  WalletKind,
} from "./types";

gsap.registerPlugin(useGSAP);

/** One entry in the in-window history: which tab, which filters, whether a row
 *  is open. `key` remounts the entries list when a new drill-down arrives. */
interface ViewState {
  tab: Tab;
  day?: string;
  category?: string;
  selectedId?: string;
  projectId?: string;
  key: number;
}

const SIDEBAR_KEY = "stockpot.ledger.sidebar";
const SIDEBAR_DEFAULT = 212;
const SIDEBAR_MAX = 320;
/** The collapsed state is a deliberate rail rather than a squeezed sidebar, so
 *  it has one width and the drag snaps to it instead of leaving narrow gaps. */
const SIDEBAR_RAIL = 76;
/** Below this width the labels stop fitting and are replaced by icons. */
const SIDEBAR_COMPACT_AT = 158;
/** The rail is also the floor, so a drag can never leave a sliver. */
const SIDEBAR_MIN = SIDEBAR_RAIL;

type Tab = "overview" | "entries" | "projects" | "wallets" | "cleanup" | "import";

// Categories and the data/clear controls now live in the settings window, so
// the app has one place to configure things rather than two.
const TABS: Array<{ id: Tab; icon: typeof LayoutDashboard }> = [
  { id: "overview", icon: LayoutDashboard },
  { id: "entries", icon: Rows3 },
  { id: "projects", icon: FolderKanban },
  { id: "wallets", icon: CreditCard },
  { id: "cleanup", icon: Wand2 },
  { id: "import", icon: FileUp },
];

const KIND_TONE: Record<EntryKind, string> = {
  expense: "text-[color:var(--red)]",
  income: "text-[color:var(--green)]",
  transfer: "text-faint",
};

/** Fund money: 余额宝 interest, 零钱通 transfers, 理财通 redemptions.
 *
 *  These are never refunds — the fund pays interest every day — so they are kept
 *  out of the refund picker. The keywords mirror `is_fund_earning` in the Rust
 *  parser, which is what decides their direction on import. */
function isFundRow(entry: LedgerEntry): boolean {
  const text = `${entry.counterparty} ${entry.note} ${entry.category}`;
  const fund =
    text.includes("余额宝") ||
    text.includes("零钱通") ||
    text.includes("理财通") ||
    text.includes("基金") ||
    text.includes("收益");
  return fund;
}

/** Filters of the entries page, kept outside the component.
 *
 *  Opening a row's detail page unmounts the table, so local state would be lost
 *  and "返回流水" would land on an unfiltered month. One ledger window exists at
 *  a time, so a module-level copy is enough to make back-navigation feel like a
 *  browser's. */
interface EntriesViewState {
  kind: "all" | EntryKind;
  query: string;
  category: string;
  day: string | null;
  refundedOnly: boolean;
  showArchived: boolean;
  grouped: boolean;
  sort: "date" | "amount-desc" | "amount-asc";
}

let entriesViewState: EntriesViewState | null = null;

/** Outline/fill pairs for the summary cells, fixed for the same reason. */
const TONE_TEXT = {
  expense: "text-[color:var(--red)]",
  income: "text-[color:var(--green)]",
} as const;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function monthLabel(month: string, lang: string): string {
  const [y, m] = month.split("-");
  if (lang === "en") {
    return `${y}-${m}`;
  }
  return `${y} 年 ${Number(m)} 月`;
}

export function LedgerWindow() {
  const { t, ledger, loading, error, month, setMonth, summary, lang } = useLedger();
  // One view of the ledger at a time, but with a real history stack so the
  // mouse's back/forward buttons behave the way they do in a browser.
  const [history, setHistory] = React.useState<ViewState[]>([{ tab: "overview", key: 0 }]);
  const [cursor, setCursor] = React.useState(0);
  const view = history[cursor];
  const tab = view.tab;
  const [composer, setComposer] = React.useState<{ open: boolean; entry?: LedgerEntry }>({
    open: false,
  });
  const [walletEditor, setWalletEditor] = React.useState<{
    open: boolean;
    wallet?: WalletAccount;
  }>({ open: false });
  const selected = view.selectedId
    ? ((ledger?.entries ?? []).find((entry) => entry.id === view.selectedId) ?? null)
    : null;
  // 侧栏那个数字：每次渲染都过一遍几千条，纯属白算
  const entryCount = React.useMemo(
    () => (ledger ? ledger.entries.filter(countsTowardTotals).length : null),
    [ledger],
  );
  // 这两个回调要稳：它们一变，整张流水表（几十上百行）就得跟着重渲染。
  // 打开编辑弹窗、保存，都会让本组件重渲染，稳不住就白等。
  const openEditor = React.useCallback((entry: LedgerEntry) => {
    setComposer({ open: true, entry });
  }, []);

  const navigate = React.useCallback((next: Omit<ViewState, "key">) => {
    setHistory((prev) => {
      const trimmed = prev.slice(0, cursor + 1);
      trimmed.push({ ...next, key: (prev[cursor]?.key ?? 0) + 1 });
      setCursor(trimmed.length - 1);
      return trimmed;
    });
  }, [cursor]);

  const goBack = React.useCallback(() => setCursor((c) => Math.max(0, c - 1)), []);
  const goForward = React.useCallback(
    () => setCursor((c) => Math.min(history.length - 1, c + 1)),
    [history.length],
  );

  const openEntries = React.useCallback(
    (filter: { day?: string; category?: string; month?: string }) => {
      // A year-chart bar carries a month, not a day: move the window there so
      // the entries page shows the month that was clicked.
      if (filter.month) setMonth(filter.month);
      navigate({ tab: "entries", day: filter.day, category: filter.category });
    },
    [navigate, setMonth],
  );
  const openEntry = React.useCallback(
    (entry: LedgerEntry) => navigate({ ...view, selectedId: entry.id }),
    [navigate, view],
  );

  // Mouse buttons 3 and 4 are back/forward; both `auxclick` and `mouseup` fire
  // depending on the platform, so listen to both and ignore repeats.
  React.useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        goForward();
      }
    };
    window.addEventListener("mouseup", handler);
    window.addEventListener("auxclick", handler);
    return () => {
      window.removeEventListener("mouseup", handler);
      window.removeEventListener("auxclick", handler);
    };
  }, [goBack, goForward]);

  // Sidebar width is the user's choice; past a threshold the labels are dropped
  // and only the icons remain, so the ledger itself gets the width back.
  const [sidebar, setSidebar] = React.useState(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN ? saved : SIDEBAR_DEFAULT;
  });
  const compact = sidebar < SIDEBAR_COMPACT_AT;
  const railWidth = compact ? SIDEBAR_RAIL : sidebar;
  const resizing = React.useRef(false);
  const [draggingSidebar, setDraggingSidebar] = React.useState(false);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sidebarTransition = reduceMotion || draggingSidebar
    ? "none"
    : "width 180ms cubic-bezier(0.22, 0.8, 0.24, 1)";

  React.useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebar));
  }, [sidebar]);

  React.useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizing.current) return;
      const raw = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_RAIL, event.clientX));
      // Snap into the rail once the labels would no longer fit, and back out to
      // the label threshold so the two states never blur together.
      setSidebar(raw < SIDEBAR_COMPACT_AT ? SIDEBAR_RAIL : Math.max(raw, SIDEBAR_COMPACT_AT));
    };
    const onUp = () => {
      resizing.current = false;
      setDraggingSidebar(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        setComposer({ open: true });
      }
      if (event.key === "Escape" && !composer.open) {
        closeLedgerWindow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composer.open]);

  if (loading && !ledger) {
    return (
      <div className="window-shell items-center justify-center">
        <span className="text-[13px] text-faint">{t("ledger.loading")}</span>
      </div>
    );
  }

  return (
    <div
      className="window-shell relative rounded-[12px] border border-border/70"
      onDoubleClick={handleTitleBarDoubleClick}
    >
      {/* Windows runs this window frameless and draws the caption buttons and
          resize border itself; on macOS both components render nothing and the
          native traffic lights stay in charge. */}
      <ResizeHandles />
      <CaptionButtons onClose={closeLedgerWindow} />
      <aside
        className={cn(
          "relative flex shrink-0 flex-col border-r border-border/70 bg-surface/40 pb-2",
          compact ? "sidebar-rail items-center px-3" : "pr-2 pl-3",
          draggingSidebar && "is-dragging",
        )}
        style={{ width: railWidth, transition: sidebarTransition }}
      >
        {/* Keeps clear of the traffic lights; the only draggable patch of the
            sidebar so nav clicks are never swallowed. */}
        <div data-tauri-drag-region className="drag-region h-[38px] shrink-0" aria-hidden />
        <div className={cn("mb-4 flex items-center gap-2 px-1", compact && "w-full justify-center px-0")}>
          <div
            className={cn(
              "sidebar-brand-icon flex shrink-0 items-center justify-center rounded-[5px]",
              compact ? "size-9" : "size-6 bg-[color-mix(in_oklch,var(--accent)_16%,transparent)]",
            )}
          >
            <Wallet size={13} strokeWidth={2} className="text-accent" />
          </div>
          <div
            className={cn("sidebar-label flex min-w-0 flex-col leading-none", compact && "is-collapsed")}
            aria-hidden={compact}
          >
              <span className="truncate text-[13px] font-semibold tracking-[-0.01em]">
                Stockpot
              </span>
              <span className="mt-[2px] truncate text-[10.5px] text-faint">{t("ledger.title")}</span>
          </div>
        </div>

        <nav
          className={cn("no-drag flex w-full flex-col", compact ? "gap-[3px]" : "gap-[1px]")}
          aria-label={t("ledger.title")}
        >
          {TABS.map(({ id, icon: Icon }) => {
            const item = (
              <button
                key={id}
                type="button"
                className="sidebar-item"
                data-active={tab === id}
                aria-current={tab === id ? "page" : undefined}
                aria-label={compact ? t(`ledger.tab.${id}`) : undefined}
                onClick={() => navigate({ tab: id })}
              >
                <Icon size={13} strokeWidth={compact ? 1.8 : 2} className="shrink-0" />
                <span className={cn("sidebar-label min-w-0 flex-1 truncate text-left", compact && "is-collapsed")}>
                  {t(`ledger.tab.${id}`)}
                </span>
                {id === "entries" && entryCount !== null ? (
                  <span className={cn("sidebar-label num shrink-0 text-[11px] text-faint", compact && "is-collapsed")}>
                    {entryCount}
                  </span>
                ) : null}
              </button>
            );
            return compact ? (
              <Tooltip key={id} content={t(`ledger.tab.${id}`)} side="right">
                {item}
              </Tooltip>
            ) : (
              item
            );
          })}
        </nav>

        <div
          className={cn(
            "mt-auto flex flex-col",
            compact ? "w-full items-center gap-[3px]" : "gap-1 px-1",
          )}
        >
          <span className={cn("sidebar-label px-1 text-[10.5px] leading-tight text-faint", compact && "is-collapsed")} aria-hidden={compact}>
              {t("ledger.localOnly")}
          </span>
          <Tooltip content={t("ledger.action.settings")} side="right">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "no-drag gap-1.5 text-[11.5px] text-faint hover:text-foreground",
                compact ? "h-[34px] w-full justify-center px-0" : "justify-start px-1",
              )}
              aria-label={t("ledger.action.settings")}
              onClick={openSettingsWindow}
            >
              <Settings2 size={11} strokeWidth={2.2} />
              <span className={cn("sidebar-label", compact && "is-collapsed")}>{t("ledger.action.settings")}</span>
            </Button>
          </Tooltip>
          <Tooltip content={t("action.quit")} side="right">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "no-drag gap-1.5 text-[11.5px] text-faint hover:text-[color:var(--red)]",
                compact ? "h-[34px] w-full justify-center px-0" : "justify-start px-1",
              )}
              aria-label={t("action.quit")}
              onClick={quitApp}
            >
              <Power size={10} strokeWidth={2.2} />
              <span className={cn("sidebar-label", compact && "is-collapsed")}>{t("action.quit")}</span>
            </Button>
          </Tooltip>
        </div>

        {/* Drag handle: 5px hit area on the seam, no visible chrome until hover. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ledger.sidebar.resize")}
          tabIndex={0}
          onPointerDown={(event) => {
            resizing.current = true;
            setDraggingSidebar(true);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 12 : -12;
              setSidebar((w) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w + delta)));
            }
          }}
          className="no-drag absolute -right-[3px] top-0 z-10 h-full w-[5px] cursor-col-resize hover:bg-[color-mix(in_oklch,var(--accent)_35%,transparent)]"
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* `deep` so the whole header band drags, including the padding the
            caption strip needs; buttons still work (see scripts/drag.js). */}
        <header
          data-tauri-drag-region="deep"
          className="drag-region caption-inset flex shrink-0 items-center gap-3 border-b border-border/70 px-5 pb-2.5 pt-6"
        >
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-semibold tracking-[-0.01em]">
              {selected ? t("ledger.detail.title") : t(`ledger.tab.${tab}`)}
            </h1>
            <p className="mt-[2px] truncate text-[11.5px] text-faint">
              {selected
                ? selected.counterparty || selected.note || selected.category
                : tab === "overview" && summary
                  ? t("ledger.subtitle.overview", { month: monthLabel(month, lang) })
                  : t(`ledger.subtitle.${tab}`)}
            </p>
          </div>

          {!selected && tab === "wallets" ? (
            <div data-tauri-drag-region className="no-drag flex items-center gap-1.5">
              <Button variant="primary" size="sm" onClick={() => setWalletEditor({ open: true })}>
                <Plus size={12} strokeWidth={2.6} />
                {t("ledger.wallets.add")}
              </Button>
            </div>
          ) : null}

          {!selected && (tab === "overview" || tab === "entries") ? (
            <div data-tauri-drag-region className="no-drag flex items-center gap-1.5">
              <MonthPicker value={month} onChange={setMonth} lang={lang} t={t} />
              <Button variant="primary" size="sm" onClick={() => setComposer({ open: true })}>
                <Plus size={12} strokeWidth={2.6} />
                {t("ledger.action.add")}
              </Button>
            </div>
          ) : null}
        </header>

        {error ? (
          <div className="mx-5 mt-3 flex items-center gap-2 rounded-[6px] border border-[color-mix(in_oklch,var(--red)_35%,var(--border))] bg-[color-mix(in_oklch,var(--red)_8%,var(--panel))] px-2.5 py-1.5 text-[12px]">
            <CircleAlert size={12} strokeWidth={2.2} className="text-[color:var(--red)]" />
            <span className="truncate">{error}</span>
          </div>
        ) : null}

        <OverlayScroll className="flex-1" contentClassName="px-5 pb-5 pt-4">
          {selected ? (
            <EntryDetail
              entry={selected}
              onBack={goBack}
              onEdit={(entry) => setComposer({ open: true, entry })}
            />
          ) : (
            <>
              {tab === "overview" ? (
                <OverviewTab
                  onOpenDay={(date) => openEntries({ day: date })}
                  onOpenCategory={(category) => openEntries({ category })}
                  onOpenEntry={openEntry}
                  onOpenCell={(filter) => openEntries(filter)}
                />
              ) : null}
              {tab === "entries" ? (
                <EntriesTab
                  key={view.key}
                  initialDay={view.day}
                  initialCategory={view.category}
                  onEdit={openEditor}
                  onSelect={openEntry}
                />
              ) : null}
              {tab === "projects" ? <ProjectsTab projectId={view.projectId} onOpen={(id) => navigate({ tab: "projects", projectId: id })} onEdit={(entry) => setComposer({ open: true, entry })} onSelect={openEntry} /> : null}
              {tab === "cleanup" ? <CleanupTab /> : null}
              {tab === "wallets" ? (
                <WalletsTab
                  onEditWallet={(wallet) => setWalletEditor({ open: true, wallet })}
                />
              ) : null}
              {tab === "import" ? <ImportTab /> : null}
            </>
          )}
        </OverlayScroll>
      </main>

      <WalletDialog
        open={walletEditor.open}
        wallet={walletEditor.wallet}
        onOpenChange={(open) => setWalletEditor(open ? walletEditor : { open: false })}
      />

      <EntryDialog
        open={composer.open}
        entry={composer.entry}
        onOpenChange={(open) => setComposer(open ? composer : { open: false })}
        onSaved={(entry) => {
          // Keep the detail page in sync after an edit.
          if (entry && selected?.id === entry.id) {
            // The entry object is re-read from the ledger by id, so a no-op
            // here is correct; navigate only to refresh the history snapshot.
            navigate({ ...view, selectedId: entry.id });
          }
        }}
      />
    </div>
  );
}


/** Balance kinds, in the order the page groups them: money you have, money you
 *  owe, then the pots you rarely touch. */
const WALLET_KINDS: WalletKind[] = [
  "debit",
  "cash",
  "investment",
  "pension",
  "provident",
  "medical",
  "credit",
  "other",
];


/** Tidy-up page: bills that appear twice, and repayments that would otherwise
 *  count as fresh spending. */
function CleanupTab() {
  const {
    t,
    lang,
    ledger,
    cleanup,
    mergeEntries,
    setExcluded,
    ignoreCleanup,
    restoreIgnored,
    autoTidy,
    setArchived,
  } = useLedger();
  const [report, setReport] = React.useState<CleanupReport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [chosen, setChosen] = React.useState<Record<string, string>>({});
  const [note, setNote] = React.useState<string | null>(null);
  const archived = React.useMemo(
    () => (ledger?.entries ?? []).filter((entry) => entry.archived),
    [ledger],
  );

  const load = React.useCallback(() => {
    setBusy(true);
    cleanup()
      .then((next) => {
        setReport(next);
        // Default to keeping the earliest row of each cluster.
        const defaults: Record<string, string> = {};
        for (const group of next.duplicates) {
          const first = [...group.entries].sort((a, b) => a.date.localeCompare(b.date))[0];
          if (first) defaults[group.key] = first.id;
        }
        setChosen(defaults);
      })
      .catch((err: unknown) => setNote(String(err)))
      .finally(() => setBusy(false));
  }, [cleanup]);

  React.useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            autoTidy()
              .then((outcome) => {
                setNote(
                  outcome.archived > 0
                    ? t("ledger.cleanup.autoTidyDone", {
                        groups: outcome.groups,
                        n: outcome.archived,
                      })
                    : t("ledger.cleanup.autoTidyNone"),
                );
                load();
              })
              .catch((err: unknown) => setNote(String(err)))
              .finally(() => setBusy(false));
          }}
        >
          <Sparkles size={11} strokeWidth={2.2} />
          {t("ledger.cleanup.autoTidy")}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={load}>
          <RotateCcw size={11} strokeWidth={2.2} />
          {t("ledger.cleanup.rescan")}
        </Button>
        <span className="text-[11.5px] text-faint">
          {note ?? t("ledger.cleanup.hint", { n: report?.total ?? 0 })}
        </span>
        {report && report.ignored > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void restoreIgnored().then(load)}
          >
            {t("ledger.cleanup.restore", { n: report.ignored })}
          </Button>
        ) : null}
      </div>
      <p className="-mt-3 text-[11px] text-faint">{t("ledger.cleanup.autoTidyHint")}</p>

      {archived.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[7px] border border-dashed border-hairline/70 px-3 py-2 text-[11.5px] text-muted-foreground">
          <Archive size={11} strokeWidth={2.2} className="text-faint" />
          <span>{t("ledger.cleanup.archivedCount", { n: archived.length })}</span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void setArchived(
                archived.map((entry) => entry.id),
                false,
              ).then(() => {
                setNote(t("ledger.cleanup.restoredArchived"));
                load();
              })
            }
          >
            {t("ledger.cleanup.restoreArchived", { n: archived.length })}
          </Button>
        </div>
      ) : null}

      <Section title={t("ledger.cleanup.duplicates")} hint={t("ledger.cleanup.duplicatesHint")}>
        {!report || report.duplicates.length === 0 ? (
          <p className="rounded-[7px] border border-dashed border-hairline/70 px-4 py-6 text-center text-[12px] text-faint">
            {busy ? t("ledger.cleanup.scanning") : t("ledger.cleanup.noDuplicates")}
          </p>
        ) : (
          report.duplicates.map((group) => (
            <div
              key={group.key}
              className="flex flex-col overflow-hidden rounded-[7px] border border-hairline/70"
            >
              <div className="flex items-center gap-2 bg-surface/50 px-2.5 py-[5px] text-[11.5px]">
                <span className="num">{formatCents(group.amount, lang)}</span>
                <span className="text-faint">
                  {t("ledger.cleanup.groupSize", { n: group.entries.length })}
                </span>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-[20px] px-1.5 text-[11px]"
                  onClick={() =>
                    void ignoreCleanup("duplicate", group.key, true).then(load)
                  }
                >
                  {t("ledger.cleanup.ignore")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-[20px] px-1.5 text-[11px]"
                  onClick={() => {
                    const keep = chosen[group.key] ?? group.entries[0]?.id;
                    if (!keep) return;
                    void mergeEntries(
                      keep,
                      group.entries.filter((e) => e.id !== keep).map((e) => e.id),
                    ).then(() => {
                      setNote(t("ledger.cleanup.merged"));
                      load();
                    });
                  }}
                >
                  <Check size={10} strokeWidth={2.8} />
                  {t("ledger.cleanup.keepOne")}
                </Button>
              </div>
              {group.entries.map((entry) => {
                const active = (chosen[group.key] ?? group.entries[0]?.id) === entry.id;
                return (
                  <label
                    key={entry.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 border-t border-hairline/40 px-2.5 py-[5px] text-[12px]",
                      active && "bg-accent-soft",
                    )}
                  >
                    <input
                      type="radio"
                      name={group.key}
                      checked={active}
                      onChange={() =>
                        setChosen((prev) => ({ ...prev, [group.key]: entry.id }))
                      }
                      aria-label={t("ledger.cleanup.keepThis")}
                      className="size-3 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="num w-[64px] shrink-0 text-[11px] text-faint">
                      {entry.date.slice(5)} {entry.time}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {entry.counterparty || entry.note || t("ledger.entries.untitled")}
                    </span>
                    <span className="shrink-0 rounded-[3px] border border-hairline px-1 text-[9.5px] text-faint">
                      {t(`ledger.source.${entry.source}`)}
                    </span>
                    <span className="num w-[70px] shrink-0 text-right text-[11.5px] text-faint">
                      {entry.account || "—"}
                    </span>
                  </label>
                );
              })}
            </div>
          ))
        )}
      </Section>

      <Section title={t("ledger.cleanup.repayments")} hint={t("ledger.cleanup.repaymentsHint")}>
        {!report || report.repayments.length === 0 ? (
          <p className="rounded-[7px] border border-dashed border-hairline/70 px-4 py-6 text-center text-[12px] text-faint">
            {busy ? t("ledger.cleanup.scanning") : t("ledger.cleanup.noRepayments")}
          </p>
        ) : (
          <>
            <div className="flex flex-col overflow-hidden rounded-[7px] border border-hairline/70">
              {report.repayments.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 border-b border-hairline/40 px-2.5 py-[5px] text-[12px] last:border-b-0"
                >
                  <span className="num w-[64px] shrink-0 text-[11px] text-faint">
                    {entry.date.slice(5)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {entry.counterparty || entry.note}
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{entry.category}</span>
                  <span className="num w-[80px] shrink-0 text-right text-[12px]">
                    {formatCents(entry.amount, lang)}
                  </span>
                  <button
                    type="button"
                    aria-label={t("ledger.cleanup.ignore")}
                    onClick={() => void ignoreCleanup("repayment", entry.id, true).then(load)}
                    className="shrink-0 text-[11px] text-faint hover:text-foreground"
                  >
                    {t("ledger.cleanup.ignore")}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  void setExcluded(
                    report.repayments.map((entry) => entry.id),
                    true,
                  ).then(() => {
                    setNote(t("ledger.cleanup.excluded"));
                    load();
                  })
                }
              >
                <Check size={11} strokeWidth={2.6} />
                {t("ledger.cleanup.excludeAll", { n: report.repayments.length })}
              </Button>
              <span className="text-[11px] text-faint">{t("ledger.cleanup.excludeHint")}</span>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

/** Project list and detail. A project is an explicit membership layer over
 *  ordinary entries, so it never changes category or account totals. */
function ProjectsTab({ projectId, onOpen, onEdit, onSelect }: { projectId?: string; onOpen: (id: string) => void; onEdit: (entry: LedgerEntry) => void; onSelect: (entry: LedgerEntry) => void }) {
  const { t, lang, ledger, addProject, updateProject, deleteProject, setProject } = useLedger();
  const [creating, setCreating] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const projects = ledger?.projects ?? [];
  const project = projects.find((p) => p.id === projectId);

  if (project) {
    return (
      <>
        <ProjectDetail
          project={project}
          onBack={() => onOpen("")}
          onAttach={() => setAttaching(true)}
          onArchive={async () => {
            await updateProject(project.id, {
              name: project.name,
              note: project.note,
              startDate: project.startDate,
              endDate: project.endDate,
              archived: !project.archived,
            });
          }}
          onDelete={async () => {
            await deleteProject(project.id);
            onOpen("");
          }}
          onEdit={onEdit}
          onSelect={onSelect}
        />
        <ProjectAttachDialog
          open={attaching}
          project={project}
          onOpenChange={setAttaching}
          onAssign={async (ids) => {
            await setProject(ids, project.id);
            setAttaching(false);
          }}
        />
      </>
    );
  }

  const visible = projects.filter((p) => showArchived || !p.archived);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus size={11} strokeWidth={2.4} />{t("ledger.projects.new")}</Button>
        <Button variant="ghost" size="sm" onClick={() => setShowArchived((value) => !value)}>{showArchived ? t("ledger.projects.hideArchived") : t("ledger.projects.showArchived")}</Button>
      </div>
      {error ? <p className="text-[12px] text-[color:var(--red)]">{error}</p> : null}
      {visible.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-hairline/70 px-4 py-10 text-center text-[12px] text-faint">{t("ledger.projects.empty")}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {visible.map((project) => {
            const rows = (ledger?.entries ?? []).filter((entry) => entry.projectId === project.id && countsTowardTotals(entry));
            const expense = rows.filter((entry) => entry.kind === "expense").reduce((sum, entry) => sum + effectiveAmount(entry), 0);
            const income = rows.filter((entry) => entry.kind === "income").reduce((sum, entry) => sum + entry.amount, 0);
            return (
              <button key={project.id} type="button" onClick={() => onOpen(project.id)} className="rounded-[8px] border border-hairline/70 bg-panel/60 px-3 py-3 text-left transition-colors hover:bg-surface/60">
                <div className="flex items-center gap-2">
                  <FolderKanban size={14} className="text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
                  {project.archived ? <span className="text-[10px] text-faint">{t("ledger.projects.archived")}</span> : null}
                </div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="num text-[16px] text-[color:var(--red)]">-{formatCents(expense, lang)}</span>
                  <span className="num text-[11px] text-faint">{t("ledger.projects.count", { n: rows.length })}</span>
                </div>
                <div className="mt-1 text-[11px] text-faint">{project.startDate || project.endDate ? `${project.startDate || "…"} — ${project.endDate || "…"}` : t("ledger.projects.noPeriod")}</div>
                {income > 0 ? <div className="num mt-1 text-[11px] text-[color:var(--green)]">+{formatCents(income, lang)}</div> : null}
              </button>
            );
          })}
        </div>
      )}
      <ProjectDialog open={creating} onOpenChange={setCreating} onSave={async (input) => { try { await addProject(input); setCreating(false); } catch (err) { setError(String(err)); } }} />
    </div>
  );
}

function ProjectDialog({ open, project, onOpenChange, onSave }: { open: boolean; project?: Project; onOpenChange: (open: boolean) => void; onSave: (input: ProjectInput) => Promise<void> }) {
  const { t } = useLedger();
  const [name, setName] = React.useState("");
  const [note, setNote] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setName(project?.name ?? ""); setNote(project?.note ?? ""); setStartDate(project?.startDate ?? ""); setEndDate(project?.endDate ?? ""); setError(null);
  }, [open, project]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px] p-5">
        <DialogTitle className="text-[14px] font-semibold">{project ? t("ledger.projects.edit") : t("ledger.projects.new")}</DialogTitle>
        <div className="mt-4 flex flex-col gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ledger.projects.name")} aria-label={t("ledger.projects.name")} />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ledger.projects.note")} aria-label={t("ledger.projects.note")} />
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label={t("ledger.projects.start")} />
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label={t("ledger.projects.end")} />
          </div>
          {error ? <span className="text-[12px] text-[color:var(--red)]">{error}</span> : null}
          <div className="flex justify-end gap-2 border-t border-hairline/60 pt-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t("action.cancel")}</Button>
            <Button variant="primary" size="sm" onClick={() => { if (!name.trim()) { setError(t("ledger.projects.needName")); return; } void onSave({ name: name.trim(), note, startDate, endDate, archived: project?.archived ?? false }).catch((err: unknown) => setError(String(err))); }}>{t("action.save")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectDetail({ project, onBack, onAttach, onArchive, onDelete, onEdit, onSelect }: { project: Project; onBack: () => void; onAttach: () => void; onArchive: () => Promise<void>; onDelete: () => Promise<void>; onEdit: (entry: LedgerEntry) => void; onSelect: (entry: LedgerEntry) => void }) {
  const { t, lang, ledger } = useLedger();
  // Deleting a project drops the grouping for every attached row, which cannot
  // be undone, so it takes a second click like the row delete does.
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  React.useEffect(() => setConfirmDelete(false), [project.id]);
  const rows = React.useMemo(
    () => (ledger?.entries ?? []).filter((entry) => entry.projectId === project.id && countsTowardTotals(entry)),
    [ledger, project.id],
  );
  // 原来这里对每一天又过滤一遍全部行，项目里几百上千条时每次点击都要跑好几万次比较
  const sums = React.useMemo(() => totalsOf(rows), [rows]);
  const expense = sums.expense;
  const income = sums.income;
  const daily = React.useMemo(() => dayTotals(rows), [rows]);
  const days = daily.length;
  const max = Math.max(1, ...daily.map((day) => day.value));
  // About eight labels fit across the plot before they collide.
  const labelStep = Math.max(1, Math.ceil(daily.length / 8));
  // Grouped by top-level category: a trip can easily touch a dozen leaves, and
  // a donut with a dozen slices reads worse than one with four.
  const byCategory = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const entry of rows) {
      if (entry.kind !== "expense") continue;
      const top = entry.category.split("/")[0] || entry.category;
      totals.set(top, (totals.get(top) ?? 0) + effectiveAmount(entry));
    }
    const sum = [...totals.values()].reduce((acc, value) => acc + value, 0);
    return [...totals.entries()]
      .map(([category, total]) => ({ category, total, share: sum ? total / sum : 0 }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);
  const palette = React.useMemo(() => chartPalette(), []);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={12} />{t("ledger.detail.back")}</Button>
        <span className="flex-1" />
        <Button variant="primary" size="sm" onClick={onAttach}>{t("ledger.projects.attach")}</Button>
        <Button variant="secondary" size="sm" onClick={() => void onArchive()}>{project.archived ? t("ledger.projects.unarchive") : t("ledger.projects.archive")}</Button>
        {confirmDelete ? (
          <>
            <Button variant="danger" size="sm" onClick={() => void onDelete()}>{t("ledger.action.confirmDelete")}</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>{t("action.cancel")}</Button>
          </>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>{t("ledger.projects.delete")}</Button>
        )}
      </div>
      <div>
        <h2 className="text-[20px] font-semibold">{project.name}</h2>
        {project.note ? <p className="mt-1 text-[12px] text-muted-foreground">{project.note}</p> : null}
        <p className="mt-1 text-[11px] text-faint">{project.startDate || project.endDate ? `${project.startDate || "…"} — ${project.endDate || "…"}` : t("ledger.projects.noPeriod")}</p>
      </div>
      <div className="grid grid-cols-4 gap-2.5">
        <StatCell label={t("ledger.stat.expense")} value={formatYuan(expense, lang)} tone="expense" />
        <StatCell label={t("ledger.stat.income")} value={formatYuan(income, lang)} tone="income" />
        <StatCell label={t("ledger.stat.net")} value={formatYuan(income - expense, lang, true)} tone={income >= expense ? "income" : "expense"} />
        <StatCell label={t("ledger.projects.dailyAverage")} value={formatCents(days ? Math.round(expense / days) : 0, lang)} />
      </div>
      {/* Two panels side by side: how the spend is spread over the days, and
          where it went. A single full-width bar chart turns four days into four
          floor-to-ceiling slabs, so the bars are capped and given a plot to sit
          in instead. */}
      <div className="grid grid-cols-12 gap-2.5">
        <section className="col-span-7 rounded-[8px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[11px] font-semibold text-muted-foreground">{t("ledger.projects.daily")}</h3>
            <span className="flex-1" />
            <span className="num text-[10.5px] text-faint">{formatCompact(max, lang)}</span>
          </div>
          {daily.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-faint">{t("ledger.projects.emptyDetail")}</p>
          ) : (
            <div className="relative mt-2">
              {/* Gridlines give the empty space above short bars a purpose. */}
              {[0, 0.5, 1].map((ratio) => (
                <div
                  key={ratio}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-dashed border-hairline/45"
                  style={{ top: `${108 - ratio * 96}px` }}
                />
              ))}
              <div
                className={cn(
                  "relative flex h-[120px] items-end justify-around",
                  // A month-long project packs 30 slots into the same width, so
                  // the gutter shrinks with the bars instead of eating them.
                  daily.length > 12 ? "gap-[2px]" : "gap-2",
                )}
              >
                {daily.map((day, index) => (
                  <div
                    key={day.date}
                    className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                    title={`${day.date} · ${formatCents(day.value, lang)}`}
                  >
                    {/* Reserved height keeps bars from shifting on hover. */}
                    <span className="num mb-[3px] h-[11px] text-[9.5px] leading-[11px] text-transparent transition-colors group-hover:text-faint">
                      {formatCompact(day.value, lang)}
                    </span>
                    <div
                      className="w-full max-w-[30px] rounded-t-[3px] bg-[color:var(--red)]/80 transition-[background-color] group-hover:bg-[color:var(--red)]"
                      style={{ height: `${Math.max(2, Math.round((day.value / max) * 88))}px` }}
                    />
                    {/* A month-long project has more days than labels fit, so
                        only every nth date is drawn. The slot keeps its height
                        either way, so the bars stay aligned. */}
                    <span className="num mt-[5px] h-[11px] text-[9px] leading-[11px] text-faint">
                      {index % labelStep === 0 ? day.date.slice(5) : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="col-span-5 flex flex-col rounded-[8px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <h3 className="text-[11px] font-semibold text-muted-foreground">{t("ledger.projects.byCategory")}</h3>
          {byCategory.length === 0 ? (
            <p className="flex-1 py-10 text-center text-[12px] text-faint">{t("ledger.projects.emptyDetail")}</p>
          ) : (
            <div className="mt-1 flex flex-1 items-center gap-3">
              <div className="relative w-[126px] shrink-0">
                <CategoryPie rows={byCategory} lang={lang} formatCents={formatCents} height={148} />
                <span className="num pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
                  {formatCompact(expense, lang)}
                </span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                {byCategory.slice(0, 5).map((row, index) => (
                  <div key={row.category} className="flex items-center gap-1.5 text-[11px]">
                    <span
                      aria-hidden
                      className="size-[7px] shrink-0 rounded-[2px]"
                      style={{
                        background: [palette.accent, palette.red, palette.green, palette.amber]
                          [index % 4],
                        opacity: index < 4 ? 1 : 0.55,
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.category}</span>
                    <span className="num shrink-0 text-faint">{Math.round(row.share * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      {/* The project's rows are the ordinary flow-of-money table, not a second
          simplified list: filtering, searching and opening a row's detail all
          come along for free, and there is only one place to fix a bug in it. */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold text-muted-foreground">
          {t("ledger.projects.entries", { n: rows.length })}
        </h3>
        <EntriesTab projectId={project.id} onEdit={onEdit} onSelect={onSelect} />
      </section>
    </div>
  );
}

/** Picks existing entries to move into a project.
 *
 *  A trip or a move is dozens of ordinary rows that already exist; retyping
 *  them is not an option, so membership is assigned in bulk here. When the
 *  project has dates, the list starts narrowed to that window, which is usually
 *  exactly the set the user wants. */
function ProjectAttachDialog({
  open,
  project,
  onOpenChange,
  onAssign,
}: {
  open: boolean;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onAssign: (ids: string[]) => Promise<void>;
}) {
  const { t, lang, ledger } = useLedger();
  const [picked, setPicked] = React.useState<string[]>([]);
  const [onlyPeriod, setOnlyPeriod] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const hasPeriod = Boolean(project.startDate || project.endDate);

  React.useEffect(() => {
    if (!open) return;
    setPicked([]);
    setOnlyPeriod(true);
    setBusy(false);
    setError(null);
  }, [open]);

  const candidates = React.useMemo(() => {
    const loose = (ledger?.entries ?? []).filter(
      (entry) => !entry.excluded && entry.projectId !== project.id,
    );
    const scoped =
      hasPeriod && onlyPeriod
        ? loose.filter(
            (entry) =>
              (!project.startDate || entry.date >= project.startDate) &&
              (!project.endDate || entry.date <= project.endDate),
          )
        : loose;
    // Newest first: the rows a user wants are usually the recent ones.
    return [...scoped].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  }, [ledger, project.id, project.startDate, project.endDate, hasPeriod, onlyPeriod]);

  const projectName = (id?: string) =>
    id ? (ledger?.projects ?? []).find((item) => item.id === id)?.name ?? "" : "";

  const allPicked = candidates.length > 0 && picked.length === candidates.length;
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));

  const assign = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      await onAssign(picked);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[560px] p-5">
        <DialogTitle className="text-[14px] font-semibold">
          {t("ledger.projects.attach")} · {project.name}
        </DialogTitle>
        <p className="mt-1 text-[11.5px] text-muted-foreground">{t("ledger.projects.attachHint")}</p>

        <div className="mt-3 flex items-center gap-3 text-[11.5px]">
          {hasPeriod ? (
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <input
                type="checkbox"
                checked={onlyPeriod}
                onChange={(event) => {
                  setOnlyPeriod(event.target.checked);
                  setPicked([]);
                }}
              />
              {`${project.startDate || "…"} — ${project.endDate || "…"}`}
            </label>
          ) : null}
          <span className="flex-1" />
          {candidates.length > 0 ? (
            <button
              type="button"
              className="text-accent underline-offset-2 hover:underline"
              onClick={() => setPicked(allPicked ? [] : candidates.map((entry) => entry.id))}
            >
              {allPicked ? t("action.deselectAll") : t("action.selectAll")}
            </button>
          ) : null}
        </div>

        <div className="mt-2 max-h-[320px] overflow-y-auto rounded-[6px] border border-hairline/70">
          {candidates.length === 0 ? (
            <p className="px-3 py-8 text-center text-[12px] text-faint">
              {t("ledger.projects.attachEmpty")}
            </p>
          ) : (
            candidates.map((entry) => {
              const checked = picked.includes(entry.id);
              const other = entry.projectId ? projectName(entry.projectId) : "";
              return (
                <label
                  key={entry.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 border-b border-hairline/40 px-2.5 py-[6px] text-[12px] last:border-b-0",
                    checked ? "bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]" : "hover:bg-surface/60",
                  )}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(entry.id)} />
                  <span className="num w-[76px] shrink-0 text-faint">{entry.date.slice(5)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {entry.counterparty || entry.note || t("ledger.entries.untitled")}
                  </span>
                  {other ? (
                    <span className="shrink-0 rounded-[3px] border border-hairline px-1 text-[9.5px] text-faint">
                      {other}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[11px] text-faint">
                    {entry.category.split("/").pop()}
                  </span>
                  <span className={cn("num w-[76px] shrink-0 text-right", KIND_TONE[entry.kind])}>
                    {entry.kind === "income" ? "+" : "-"}
                    {formatCents(entry.amount, lang)}
                  </span>
                </label>
              );
            })
          )}
        </div>

        {error ? <span className="mt-2 block text-[11.5px] text-down">{error}</span> : null}

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-hairline/60 pt-3">
          <span className="flex-1 text-[11.5px] text-faint">
            {t("ledger.projects.count", { n: picked.length })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("action.cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={picked.length === 0 || busy} onClick={() => void assign()}>
            {t("ledger.projects.assign")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WalletsTab({ onEditWallet }: { onEditWallet: (wallet: WalletAccount) => void }) {  const { t, ledger, lang, removeWallet, assets } = useLedger();
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const wallets = ledger?.wallets ?? [];
  const totals = walletTotals(wallets);
  // Stock accounts come from the settings window; they are part of the balance
  // sheet but are edited there, so this page only reads them.
  const stockAccounts = assets?.accounts ?? [];
  const stockTotal = stockAccounts.reduce((sum, account) => sum + account.value, 0);
  const netWithStocks = totals.net + stockTotal;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2.5">
        <StatCell
          label={t("ledger.wallets.total")}
          value={formatYuan(netWithStocks, lang)}
          tone={netWithStocks >= 0 ? "income" : "expense"}
        />
        <StatCell
          label={t("ledger.wallets.assets")}
          value={formatYuan(totals.assets + stockTotal, lang)}
        />
        <StatCell
          label={t("ledger.wallets.liabilities")}
          value={formatYuan(Math.abs(totals.liabilities), lang)}
          tone="expense"
        />
      </div>

      {stockAccounts.length > 0 ? (
        <section className="flex flex-col overflow-hidden rounded-[7px] border border-hairline/70">
          <div className="flex items-baseline gap-2 bg-surface/50 px-3 py-[6px]">
            <Landmark size={11} strokeWidth={2} className="self-center text-accent" />
            <span className="text-[11.5px] font-semibold">{t("ledger.wallets.stockAccounts")}</span>
            <span className="rounded-[3px] border border-accent/40 px-1 text-[9.5px] text-accent">
              {t("ledger.wallets.auto")}
            </span>
            <span className="flex-1" />
            <span className="num text-[12px]">{formatYuan(stockTotal, lang)}</span>
          </div>
          {stockAccounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-2 border-t border-hairline/40 px-3 py-[7px]"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{account.name}</span>
              <span className="num w-[120px] shrink-0 text-[11.5px] text-faint">
                {t("ledger.wallets.holdings", { n: account.holdings })}
              </span>
              <span
                className={cn(
                  "num w-[110px] shrink-0 text-right text-[11.5px]",
                  account.pnl >= 0 ? "text-[color:var(--green)]" : "text-[color:var(--red)]",
                )}
              >
                {account.pnl >= 0 ? "+" : "-"}
                {formatCents(Math.abs(account.pnl), lang)}
              </span>
              <span className="num w-[110px] shrink-0 text-right text-[13px]">
                {formatYuan(account.value, lang)}
              </span>
              <span className="w-[56px] shrink-0" />
            </div>
          ))}
          <div className="flex items-center gap-2 border-t border-hairline/40 bg-surface/30 px-3 py-[5px]">
            <span className="text-[11px] text-faint">{t("ledger.wallets.stockHint")}</span>
            <span className="flex-1" />
            <Button
              variant="quiet"
              size="sm"
              className="h-[20px] px-1 text-[11px] text-accent"
              onClick={openSettingsWindow}
            >
              {t("ledger.wallets.openSettings")}
            </Button>
          </div>
        </section>
      ) : null}

      {wallets.length === 0 && stockAccounts.length === 0 ? (
        <p className="rounded-[7px] border border-dashed border-hairline/70 px-4 py-10 text-center text-[12px] text-faint">
          {t("ledger.wallets.empty")}
        </p>
      ) : wallets.length === 0 ? null : (
        WALLET_KINDS.filter((kind) => wallets.some((w) => w.kind === kind)).map((kind) => {
          const rows = wallets.filter((w) => w.kind === kind);
          const subtotal = rows.reduce((sum, w) => sum + w.balance, 0);
          return (
            <section
              key={kind}
              className="flex flex-col overflow-hidden rounded-[7px] border border-hairline/70"
            >
              <div className="flex items-baseline gap-2 bg-surface/50 px-3 py-[6px]">
                <Landmark size={11} strokeWidth={2} className="self-center text-faint" />
                <span className="text-[11.5px] font-semibold">{t(`ledger.walletKind.${kind}`)}</span>
                <span className="num text-[10.5px] text-faint">
                  {t("ledger.wallets.count", { n: rows.length })}
                </span>
                <span className="flex-1" />
                <span
                  className={cn(
                    "num text-[12px]",
                    subtotal >= 0 ? "text-foreground" : "text-[color:var(--red)]",
                  )}
                >
                  {formatYuan(subtotal, lang)}
                </span>
              </div>
              {rows.map((wallet) => (
                <div
                  key={wallet.id}
                  className="group flex items-center gap-2 border-t border-hairline/40 px-3 py-[7px] transition-colors duration-150 hover:bg-surface/50"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{wallet.name}</span>
                  <span className="w-[120px] shrink-0 truncate text-[11.5px] text-faint">
                    {wallet.institution || "—"}
                  </span>
                  <span className="w-[110px] shrink-0 truncate text-[11px] text-faint">
                    {wallet.updatedAt ? t("ledger.wallets.updated", { date: wallet.updatedAt.slice(0, 10) }) : ""}
                  </span>
                  <span
                    className={cn(
                      "num w-[110px] shrink-0 text-right text-[13px]",
                      wallet.balance < 0 && "text-[color:var(--red)]",
                    )}
                  >
                    {formatYuan(wallet.balance, lang)}
                  </span>
                  <span className="flex w-[56px] shrink-0 items-center justify-end gap-0.5">
                    <Button
                      variant="quiet"
                      size="icon-sm"
                      aria-label={t("ledger.action.edit")}
                      onClick={() => onEditWallet(wallet)}
                    >
                      <Pencil size={11} strokeWidth={2} />
                    </Button>
                    {confirmId === wallet.id ? (
                      <Button
                        variant="danger"
                        size="icon-sm"
                        aria-label={t("ledger.action.confirmDelete")}
                        onClick={() => {
                          setConfirmId(null);
                          void removeWallet(wallet.id);
                        }}
                      >
                        <Check size={11} strokeWidth={2.6} />
                      </Button>
                    ) : (
                      <Button
                        variant="quiet"
                        size="icon-sm"
                        aria-label={t("ledger.action.delete")}
                        onClick={() => setConfirmId(wallet.id)}
                      >
                        <Trash2 size={11} strokeWidth={2} />
                      </Button>
                    )}
                  </span>
                </div>
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}

/** Add or edit one balance. The balance is typed in yuan and stored in cents. */
function WalletDialog({
  open,
  wallet,
  onOpenChange,
}: {
  open: boolean;
  wallet?: WalletAccount;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, addWallet, updateWallet } = useLedger();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<WalletKind>("debit");
  const [institution, setInstitution] = React.useState("");
  const [balance, setBalance] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    if (wallet) {
      setName(wallet.name);
      setKind(wallet.kind);
      setInstitution(wallet.institution);
      setBalance((wallet.balance / 100).toFixed(2));
      setNote(wallet.note);
    } else {
      setName("");
      setKind("debit");
      setInstitution("");
      setBalance("");
      setNote("");
    }
  }, [open, wallet]);

  const save = async () => {
    if (!name.trim()) {
      setError(t("ledger.wallets.needName"));
      return;
    }
    const yuan = Number(balance.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(yuan)) {
      setError(t("ledger.wallets.needBalance"));
      return;
    }
    const input: WalletInput = {
      name: name.trim(),
      kind,
      institution,
      // Credit cards are stored negative regardless of how the user types it.
      balance: Math.round((kind === "credit" ? -Math.abs(yuan) : yuan) * 100),
      note,
    };
    try {
      if (wallet) await updateWallet(wallet.id, input);
      else await addWallet(input);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[430px] p-5">
        <DialogTitle className="text-[14px] font-semibold">
          {wallet ? t("ledger.wallets.edit") : t("ledger.wallets.add")}
        </DialogTitle>
        <div className="mt-4 flex flex-col gap-3.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.wallets.name")}
            </span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("ledger.wallets.namePlaceholder")}
              autoFocus
              className="h-7"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.wallets.kind")}
            </span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as WalletKind)}
              className="h-7 rounded-[5px] border border-hairline bg-panel px-1.5 text-[13px]"
            >
              {WALLET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`ledger.walletKind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("ledger.wallets.institution")}
              </span>
              <Input
                value={institution}
                onChange={(event) => setInstitution(event.target.value)}
                className="h-7"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("ledger.wallets.balance")}
              </span>
              <Input
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="num h-7"
              />
            </label>
          </div>
          <p className="text-[11px] text-faint">{t("ledger.wallets.balanceHint")}</p>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.wallets.note")}
            </span>
            <Input value={note} onChange={(event) => setNote(event.target.value)} className="h-7" />
          </label>
          {error ? <span className="text-[11.5px] text-[color:var(--red)]">{error}</span> : null}
          <div className="mt-2 flex items-center justify-end gap-2 border-t border-hairline/60 pt-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("action.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()}>
              {t("action.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MonthPicker({
  value,
  onChange,
  lang,
  t,
}: {
  value: string;
  onChange: (month: string) => void;
  lang: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  // Free navigation across calendar months: an empty month is a legitimate
  // thing to look at, and gating on "months with data" stranded the user.
  const canForward = value < currentMonth();
  return (
    <div className="flex items-center gap-0.5 rounded-[5px] border border-border bg-surface px-1 py-[2px]">
      <button
        type="button"
        aria-label={t("ledger.month.prev")}
        onClick={() => onChange(shiftMonth(value, -1))}
        className="flex size-5 items-center justify-center rounded-[3px] text-faint hover:bg-panel hover:text-foreground disabled:opacity-30"
      >
        <ChevronLeft size={11} strokeWidth={2.4} />
      </button>
      <span className="num min-w-[74px] text-center text-[12px]">
        {monthLabel(value, lang)}
      </span>
      <button
        type="button"
        aria-label={t("ledger.month.next")}
        disabled={!canForward}
        onClick={() => canForward && onChange(shiftMonth(value, 1))}
        className="flex size-5 items-center justify-center rounded-[3px] text-faint hover:bg-panel hover:text-foreground disabled:opacity-30"
      >
        <ChevronRight size={11} strokeWidth={2.4} />
      </button>
    </div>
  );
}

function StatCell({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "income" | "expense" | "neutral";
  hint?: string;
}) {
  return (
    <div className="lg-stat flex flex-col gap-1 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "num text-[17px] font-medium leading-none",
          tone === "income" && TONE_TEXT.income,
          tone === "expense" && TONE_TEXT.expense,
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-[10.5px] text-faint">{hint}</span> : null}
    </div>
  );
}

function OverviewTab({
  onOpenDay,
  onOpenCategory,
  onOpenEntry,
  onOpenCell,
}: {
  onOpenDay: (date: string) => void;
  onOpenCategory: (category: string) => void;
  onOpenEntry: (entry: LedgerEntry) => void;
  onOpenCell: (filter: { category?: string; day?: string; month?: string }) => void;
}) {
  const { t, summary, ledger, lang, month, assets } = useLedger();

  const [range, setRange] = React.useState<"month" | "year">("month");
  const year = month.slice(0, 4);
  if (!summary) return null;

  const entries = (ledger?.entries ?? []).filter(
    (e) => countsTowardTotals(e) && monthOf(e.date) === month,
  );
  const trend = dailyTrend(ledger?.entries ?? [], month);
  const activeDays = trend.filter((d) => d.expense > 0).length;
  const dailyAverage = activeDays > 0 ? Math.round(summary.expense / activeDays) : 0;
  const recent = entries.slice(0, 5);
  // The donut card is as tall as the calendar next to it, so it carries the
  // month's headline numbers instead of padding the gap with nothing.
  const biggestDay = trend.reduce(
    (best, day) => (day.expense > best.expense ? day : best),
    { day: 0, expense: 0, income: 0 },
  );

  const yearRows = yearMonths(ledger?.entries ?? [], year);
  const yearExpense = yearRows.reduce((sum, row) => sum + row.expense, 0);
  const yearIncome = yearRows.reduce((sum, row) => sum + row.income, 0);
  const activeMonths = yearRows.filter((row) => row.expense > 0).length;
  const monthCount = activeMonths || 1;


  // Entrance choreography, scoped to this tab. Replayed when the month or the
  // figures change; skipped entirely for anyone who asked for less motion.
  //
  // Deliberately transform-only: an opacity tween that starts at 0 is undone by
  // `revertOnUpdate` on the next render, and a fast month switch could leave a
  // card at its start value — invisible, with no way back. Sliding a few pixels
  // reads the same and cannot hide data if it is interrupted.
  const scope = React.useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(
          ".lg-stat",
          { y: 10 },
          { y: 0, duration: 0.4, stagger: 0.06, ease: "power2.out", overwrite: "auto" },
        );
        gsap.fromTo(
          ".lg-panel",
          { y: 14 },
          { y: 0, duration: 0.45, stagger: 0.07, delay: 0.08, ease: "power2.out", overwrite: "auto" },
        );
        // Bars grow from 60% rather than 0, so an interrupted tween still shows
        // the data instead of a blank plot.
        gsap.fromTo(
          ".lg-bar",
          { scaleY: 0.6 },
          {
            scaleY: 1,
            transformOrigin: "bottom center",
            duration: 0.55,
            stagger: { each: 0.012, from: "start" },
            delay: 0.18,
            ease: "power3.out",
            overwrite: "auto",
          },
        );
        gsap.fromTo(
          ".lg-donut-seg",
          { rotate: -18 },
          {
            rotate: 0,
            transformOrigin: "50% 50%",
            duration: 0.6,
            stagger: 0.045,
            delay: 0.2,
            ease: "power2.out",
            overwrite: "auto",
          },
        );
        gsap.fromTo(
          ".lg-row",
          { x: -6 },
          { x: 0, duration: 0.35, stagger: 0.04, delay: 0.26, ease: "power2.out", overwrite: "auto" },
        );
      });
      return () => mm.revert();
    },
    { scope, dependencies: [month, summary?.expense, summary?.income, assets?.marketValue], revertOnUpdate: true },
  );

  // All-time cash movement from the tracked ledger; holdings come from the
  // stock side. Kept separate from the monthly summary on purpose.
  const allTimeNet = (ledger?.entries ?? []).reduce((sum, entry) => {
    if (!countsTowardTotals(entry)) return sum;
    if (entry.kind === "income") return sum + entry.amount;
    if (entry.kind === "expense") return sum - effectiveAmount(entry);
    return sum;
  }, 0);
  const holdingsValue = assets?.marketValue ?? 0;
  const manualWallets = (ledger?.wallets ?? []).reduce((sum, w) => sum + w.balance, 0);
  // Balance sheet: what is in the accounts (stock accounts included) rather
  // than cash flow. The ledger's running net is shown but not added — salary
  // that was invested would otherwise be counted twice.
  const totalAssets = holdingsValue + manualWallets;

  return (
    <div ref={scope} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="w-[132px]">
          <Segmented<"month" | "year">
            ariaLabel={t("ledger.range.title")}
            size="sm"
            value={range}
            onChange={setRange}
            options={[
              { value: "month", label: t("ledger.range.month") },
              { value: "year", label: t("ledger.range.year") },
            ]}
          />
        </div>
        <span className="text-[11.5px] text-faint">
          {range === "month"
            ? monthLabel(month, lang)
            : t("ledger.range.yearLabel", { year })}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2.5">
        <StatCell
          label={range === "month" ? t("ledger.stat.expense") : t("ledger.stat.expenseYear")}
          value={formatYuan(range === "month" ? summary.expense : yearExpense, lang)}
          tone="expense"
          hint={
            range === "month"
              ? t("ledger.stat.dailyAverage", { value: formatCents(dailyAverage, lang) })
              : t("ledger.stat.monthlyAverage", {
                  value: formatCents(Math.round(yearExpense / monthCount), lang),
                })
          }
        />
        <StatCell
          label={range === "month" ? t("ledger.stat.income") : t("ledger.stat.incomeYear")}
          value={formatYuan(range === "month" ? summary.income : yearIncome, lang)}
          tone="income"
        />
        <StatCell
          label={t("ledger.stat.net")}
          value={
            range === "month"
              ? formatYuan(summary.net, lang, true)
              : formatYuan(yearIncome - yearExpense, lang, true)
          }
          tone={
            (range === "month" ? summary.net : yearIncome - yearExpense) >= 0
              ? "income"
              : "expense"
          }
        />
        <StatCell
          label={range === "month" ? t("ledger.stat.count") : t("ledger.stat.activeMonths")}
          value={String(range === "month" ? summary.count : activeMonths)}
          hint={
            range === "month"
              ? t("ledger.stat.activeDays", { days: activeDays })
              : t("ledger.stat.yearHint", { year })
          }
        />
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <section className="lg-panel col-span-7 flex flex-col gap-2 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <h3 className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {t("ledger.assets.title")}
            </h3>
            <span className="num text-[15px] font-medium">
              {formatYuan(holdingsValue, lang)}
            </span>
          </div>
          {assets && assets.lines.length > 0 ? (
            <>
              <div className="flex items-center gap-3 text-[11px] text-faint">
                <span>
                  {t("ledger.assets.cost")}{" "}
                  <span className="num text-muted-foreground">{formatCents(assets.cost, lang)}</span>
                </span>
                <span>
                  {t("ledger.assets.pnl")}{" "}
                  <span className={cn("num", assets.pnl >= 0 ? TONE_TEXT.income : TONE_TEXT.expense)}>
                    {assets.pnl >= 0 ? "+" : "-"}
                    {formatCents(Math.abs(assets.pnl), lang)}
                  </span>
                </span>
              </div>
              <div className="mt-0.5 flex flex-col">
                {assets.lines.slice(0, 4).map((line) => (
                  <div
                    key={line.id}
                    className="flex items-center gap-2 border-b border-hairline/40 py-[3px] text-[11.5px] last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate">{line.name}</span>
                    <span className="num w-[56px] shrink-0 text-right text-faint">
                      {line.shares.toLocaleString(lang === "en" ? "en-US" : "zh-CN")}
                    </span>
                    <span className="num w-[78px] shrink-0 text-right">
                      {formatCents(line.value, lang)}
                    </span>
                    <span
                      className={cn(
                        "num w-[70px] shrink-0 text-right",
                        line.pnl >= 0 ? TONE_TEXT.income : TONE_TEXT.expense,
                      )}
                    >
                      {line.pnl >= 0 ? "+" : "-"}
                      {formatCents(Math.abs(line.pnl), lang)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-[12px] text-faint">{t("ledger.assets.empty")}</p>
          )}
        </section>

        <section className="lg-panel col-span-5 flex flex-col gap-1.5 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t("ledger.assets.total")}
          </h3>
          <span className="num text-[17px] font-medium leading-none">
            {formatYuan(totalAssets, lang, true)}
          </span>
          <div className="mt-1 flex flex-col gap-[3px] text-[11px] text-faint">
            <span className="flex items-baseline justify-between">
              <span>{t("ledger.assets.title")}</span>
              <span className="num text-muted-foreground">{formatCents(holdingsValue, lang)}</span>
            </span>
            <span className="flex items-baseline justify-between">
              <span>{t("ledger.wallets.manualAccounts")}</span>
              <span className="num text-muted-foreground">{formatCents(manualWallets, lang)}</span>
            </span>
            <span className="flex items-baseline justify-between border-t border-hairline/50 pt-[3px]">
              <span>{t("ledger.assets.allTimeNet")}</span>
              <span
                className={cn(
                  "num",
                  allTimeNet >= 0 ? TONE_TEXT.income : TONE_TEXT.expense,
                )}
              >
                {allTimeNet >= 0 ? "+" : "-"}
                {formatCents(Math.abs(allTimeNet), lang)}
              </span>
            </span>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <CategoryTrendCard
          range={range}
          month={month}
          year={year}
          entries={(ledger?.entries ?? []).filter(countsTowardTotals)}
          categories={ledger?.categories ?? []}
          lang={lang}
          t={t}
          onPickCategory={(category) => onOpenCell({ category })}
          onPickPeriod={(filter) => onOpenCell(filter)}
        />
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <section className="lg-panel col-span-5 flex flex-col gap-2 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t("ledger.overview.byCategory")}
          </h3>
          {summary.byCategory.length === 0 ? (
            <p className="text-[12px] text-faint">{t("ledger.overview.empty")}</p>
          ) : (
            <>
              <div className="flex flex-1 flex-col justify-center">
                <CategoryDonut
                  rows={summary.byCategory}
                  total={summary.expense}
                  lang={lang}
                  onSelect={onOpenCategory}
                />
              </div>
              <dl className="mt-1 grid grid-cols-3 gap-2 border-t border-hairline/50 pt-2">
                <div className="flex flex-col gap-[1px]">
                  <dt className="text-[10px] text-faint">{t("ledger.stat.dailyAverageShort")}</dt>
                  <dd className="num text-[12px]">{formatCents(dailyAverage, lang)}</dd>
                </div>
                <div className="flex flex-col gap-[1px]">
                  <dt className="text-[10px] text-faint">{t("ledger.stat.biggestDay")}</dt>
                  <dd className="num text-[12px]">{formatCents(biggestDay.expense, lang)}</dd>
                </div>
                <div className="flex flex-col gap-[1px]">
                  <dt className="text-[10px] text-faint">{t("ledger.stat.activeDaysShort")}</dt>
                  <dd className="num text-[12px]">{activeDays}</dd>
                </div>
              </dl>
            </>
          )}
        </section>
        <MonthCalendar
          month={month}
          trend={trend}
          lang={lang}
          t={t}
          onOpenDay={onOpenDay}
        />
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <section className="lg-panel col-span-12 flex flex-col gap-1.5 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t("ledger.overview.recent")}
          </h3>
          {recent.length === 0 ? (
            <p className="text-[12px] text-faint">{t("ledger.overview.empty")}</p>
          ) : (
            recent.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onOpenEntry(entry)}
                aria-label={t("ledger.detail.open", {
                  name: entry.counterparty || entry.note || entry.category,
                })}
                className="lg-row flex items-center gap-2 rounded-[3px] px-1 py-[2px] text-left text-[12px] transition-colors duration-150 hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <span className="num w-[32px] shrink-0 text-[10.5px] text-faint">
                  {entry.date.slice(5)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {entry.counterparty || entry.note || entry.category}
                </span>
                <span className={cn("num shrink-0", KIND_TONE[entry.kind])}>
                  {entry.kind === "income" ? "+" : entry.kind === "expense" ? "-" : ""}
                  {formatCents(entry.amount, lang)}
                </span>
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

/** Fixed hue ramp for the donut. Derived from the two accent families so the
 *  chart never introduces a colour the rest of the app does not use. */

/** Spending over time with a chart-type switch, a metric switch and a category
 *  filter. ECharts draws it, so hover, axis tooltips and resizing come for free
 *  and the card stays thin. */
function CategoryTrendCard({
  range,
  month,
  year,
  entries,
  categories,
  lang,
  t,
  onPickCategory,
  onPickPeriod,
}: {
  range: "month" | "year";
  month: string;
  year: string;
  entries: LedgerEntry[];
  categories: CategoryDef[];
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onPickCategory: (category: string) => void;
  onPickPeriod: (filter: { day?: string; month?: string }) => void;
}) {
  const [kind, setKind] = React.useState<"bar" | "line">("bar");
  const [metric, setMetric] = React.useState<"expense" | "income" | "net">("expense");
  const [category, setCategory] = React.useState("all");

  const columnCount =
    range === "year"
      ? 12
      : new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();

  const values = React.useMemo(() => {
    const out: number[] = new Array(columnCount).fill(0);
    for (const entry of entries) {
      if (entry.excluded) continue;
      if (entry.kind !== "expense" && entry.kind !== "income") continue;
      if (category !== "all" && !categoryMatches(entry.category, category)) continue;
      let slot: number;
      if (range === "year") {
        if (entry.date.slice(0, 4) !== year) continue;
        slot = Number(entry.date.slice(5, 7)) - 1;
      } else {
        if (monthOf(entry.date) !== month) continue;
        slot = Number(entry.date.slice(8, 10)) - 1;
      }
      if (slot < 0 || slot >= out.length) continue;
      const amount = entry.kind === "expense" ? effectiveAmount(entry) : entry.amount;
      if (metric === "expense" && entry.kind === "expense") out[slot] += amount;
      if (metric === "income" && entry.kind === "income") out[slot] += amount;
      if (metric === "net") out[slot] += entry.kind === "income" ? amount : -amount;
    }
    return out;
  }, [entries, category, range, month, year, columnCount, metric]);

  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    <section className="lg-panel col-span-12 flex flex-col gap-2 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {range === "year" ? t("ledger.stats.byMonth") : t("ledger.stats.byDay")}
        </h3>
        <div className="w-[104px]">
          <Segmented<"bar" | "line">
            ariaLabel={t("ledger.stats.chartType")}
            size="sm"
            value={kind}
            onChange={setKind}
            options={[
              { value: "bar", label: t("ledger.stats.bar") },
              { value: "line", label: t("ledger.stats.line") },
            ]}
          />
        </div>
        <div className="w-[124px]">
          <Segmented<"expense" | "income" | "net">
            ariaLabel={t("ledger.chart.metric")}
            size="sm"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "expense", label: t("ledger.metric.expense") },
              { value: "income", label: t("ledger.metric.income") },
              { value: "net", label: t("ledger.metric.net") },
            ]}
          />
        </div>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-label={t("ledger.stats.category")}
          className="h-[24px] w-[148px] rounded-[5px] border border-border bg-surface px-1.5 text-[11.5px]"
        >
          <option value="all">{t("ledger.stats.allCategories")}</option>
          {orderedCategories(categories).map((def) => {
            const path = categoryPath(def);
            return (
              <option key={path} value={path}>
                {path}
              </option>
            );
          })}
        </select>
        <span className="flex-1" />
        <span className="num text-[12px]">{formatYuan(total, lang)}</span>
        <button
          type="button"
          className="text-[11px] text-accent hover:underline"
          onClick={() => onPickCategory(category)}
        >
          {t("ledger.stats.open")}
        </button>
      </div>

      <TrendChart
        values={values}
        kind={kind}
        range={range}
        lang={lang}
        formatCents={formatCents}
        formatCompact={(value) => formatCompact(value)}
        onSelect={(index) => {
          if (range === "year") {
            onPickPeriod({ month: `${year}-${String(index + 1).padStart(2, "0")}` });
          } else {
            onPickPeriod({ day: `${month}-${String(index + 1).padStart(2, "0")}` });
          }
        }}
      />
    </section>
  );
}

/** Category split. ECharts owns the ring, the legend and the hover so the card
 *  can stay compact and the numbers line up. */
function CategoryDonut({
  rows,
  total,
  lang,
  onSelect,
}: {
  rows: Array<{ category: string; total: number; share: number }>;
  total: number;
  lang: Lang;
  onSelect: (category: string) => void;
}) {
  const palette = React.useMemo(() => chartPalette(), []);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2">
      <div className="relative w-[190px] shrink-0">
        <CategoryPie rows={rows} lang={lang} formatCents={formatCents} onSelect={onSelect} />
        <span className="num pointer-events-none absolute inset-0 flex items-center justify-center text-[13px]">
          {formatCompact(total)}
        </span>
      </div>
      <div className="flex w-full flex-col gap-[1px]">
        {rows
          .filter((row) => row.total > 0)
          .slice(0, 6)
          .map((row, index) => (
            <button
              key={row.category}
              type="button"
              onClick={() => onSelect(row.category)}
              className="flex items-center gap-2 rounded-[4px] px-1.5 py-[4px] text-left text-[11.5px] transition-colors duration-150 hover:bg-surface/60"
            >
              <span
                className="size-[7px] shrink-0 rounded-[2px]"
                style={{
                  background: [
                    palette.accent,
                    palette.red,
                    palette.green,
                    palette.amber,
                    "var(--accent)",
                    "var(--red)",
                  ][index % 6],
                  opacity: index < 4 ? 1 : 0.55,
                }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{row.category}</span>
              <span className="num shrink-0 text-muted-foreground">
                {formatCents(row.total, lang)}
              </span>
              <span className="num w-[34px] shrink-0 text-right text-faint">
                {Math.round(row.share * 100)}%
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}

function MonthCalendar({
  month,
  trend,
  lang,
  t,
  onOpenDay,
}: {
  month: string;
  trend: Array<{ day: number; expense: number; income: number }>;
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenDay: (date: string) => void;
}) {
  const [year, mon] = month.split("-").map(Number);
  const firstWeekday = (new Date(year, mon - 1, 1).getDay() + 6) % 7; // Monday-first
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === mon;
  // The cell colour answers one question: did this day cost more than it
  // earned? Red when spending dominated, green when income did.
  //
  // Scaling against the single largest day would flatten everything else once a
  // salary lands, so the ramp is normalised to the 90th percentile and run
  // through a square root: small days still differ from each other.
  const magnitudes = trend
    .map((d) => Math.abs(d.income - d.expense))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const scale =
    magnitudes.length === 0
      ? 1
      : magnitudes[Math.min(magnitudes.length - 1, Math.floor(magnitudes.length * 0.9))];

  return (
    <section className="lg-panel col-span-7 flex flex-col gap-1.5 rounded-[7px] border border-hairline/70 bg-panel/60 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {t("ledger.overview.calendar")}
        </h3>
        <span className="text-[10px] text-faint">{t("ledger.overview.calendarHint")}</span>
      </div>
      <div className="grid grid-cols-7 gap-[2px] text-[9.5px] text-faint">
        {t("ledger.overview.weekdays")
          .split(",")
          .map((day) => (
            <span key={day} className="text-center">
              {day}
            </span>
          ))}
      </div>
      <div className="grid grid-cols-7 gap-[2px]">
        {Array.from({ length: firstWeekday }, (_, i) => (
          <span key={`pad-${i}`} />
        ))}
        {trend.map((row) => {
          // One hue per day: the sign of the day's balance. Intensity follows
          // the size of that balance, not the size of either side.
          const net = row.income - row.expense;
          const ratio = scale > 0 ? Math.min(1, Math.sqrt(Math.abs(net) / scale)) : 1;
          const depth = net === 0 ? 0 : 0.12 + ratio * 0.48;
          const tone = net < 0 ? "red" : "green";
          const background =
            net === 0 ? "transparent" : `color-mix(in oklch, var(--${tone}) ${Math.round(depth * 100)}%, transparent)`;
          const deep = depth > 0.3;
          const labelColor = deep ? "var(--paper)" : `var(--${tone})`;
          const isToday = isCurrentMonth && today.getDate() === row.day;
          const hasAnything = row.expense > 0 || row.income > 0;
          const date = `${month}-${String(row.day).padStart(2, "0")}`;
          return (
            <button
              key={row.day}
              type="button"
              onClick={() => onOpenDay(date)}
              aria-label={`${t("ledger.overview.openDay")}: ${date}`}
              title={[
                `${month}-${String(row.day).padStart(2, "0")}`,
                row.expense > 0 ? `${t("ledger.kind.expense")} ${formatCents(row.expense, lang)}` : "",
                row.income > 0 ? `${t("ledger.kind.income")} ${formatCents(row.income, lang)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              className={cn(
                "lg-cal-cell flex aspect-square cursor-pointer flex-col items-center justify-center rounded-[4px] border text-[10px] leading-[11px]",
                "transition-[filter,box-shadow] duration-150 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                isToday ? "border-accent" : "border-transparent",
              )}
              style={{ background }}
              data-deep={deep ? "true" : undefined}
            >
              <span className="num">{row.day}</span>
              {hasAnything ? (
                // Both directions stack: side by side they overflowed the square.
                <span
                  className={cn(
                    "flex flex-col items-center leading-[9px]",
                    row.expense > 0 && row.income > 0 ? "gap-[1px]" : null,
                  )}
                >
                  {/* The balance is the headline; the two sides stay in the
                      tooltip so the cell never needs two numbers. */}
                  <span className="num text-[8.5px]" style={{ color: labelColor }}>
                    {net > 0 ? "+" : net < 0 ? "-" : ""}
                    {formatCompact(Math.abs(net), lang)}
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 行高。窗口化按这三个数算位置，改动要同步改 EntryRow / 日期头里的 style。 */
const ROW_H = 39;
/** 带退款的那行金额下面多一行小字。 */
const ROW_TALL_H = 44;
const DAY_H = 27;
/** 归档块不做窗口化（它是另开的一段，跟主表共用滚动），所以封顶。 */
const ARCHIVED_CAP = 200;
/** 退款候选同理：挑一条就够，没必要把几千行都塞进那个小弹窗。 */
const REFUND_CAP = 50;

function EntriesTab({
  onEdit,
  onSelect,
  initialDay,
  initialCategory,
  projectId,
}: {
  onEdit: (entry: LedgerEntry) => void;
  onSelect: (entry: LedgerEntry) => void;
  /** Set when the user drilled in from the calendar, chart or donut. */
  initialDay?: string;
  initialCategory?: string;
  /** When set, the page lists a project's rows across every month instead of
   *  the current month — the same table, filters and detail view. */
  projectId?: string;
}) {
  const { t, ledger, lang, remove, month, setMonth } = useLedger();
  const categories = ledger?.categories ?? [];
  // Restore the filters when coming back from a row's detail page; a project's
  // own table always starts clean so the two never bleed into each other.
  const seed = projectId ? null : entriesViewState;
  const [kind, setKind] = React.useState<"all" | EntryKind>(seed?.kind ?? "all");
  const [query, setQuery] = React.useState(seed?.query ?? "");
  const [category, setCategory] = React.useState(initialCategory ?? seed?.category ?? "all");
  const [day, setDay] = React.useState<string | null>(initialDay ?? seed?.day ?? null);
  const [refundedOnly, setRefundedOnly] = React.useState(seed?.refundedOnly ?? false);
  const [showArchived, setShowArchived] = React.useState(seed?.showArchived ?? false);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [grouped, setGrouped] = React.useState(seed?.grouped ?? true);
  // Sorting by amount is a different way of reading the month than grouping by
  // day, so the two are mutually exclusive: choosing an amount order flattens
  // the table and disables the day toggle.
  const [sort, setSort] = React.useState<"date" | "amount-desc" | "amount-asc">(
    seed?.sort ?? "date",
  );

  // Keep the module-level copy in step, so returning from a detail page restores
  // exactly what was on screen.
  React.useEffect(() => {
    if (projectId) return;
    entriesViewState = { kind, query, category, day, refundedOnly, showArchived, grouped, sort };
  }, [projectId, kind, query, category, day, refundedOnly, showArchived, grouped, sort]);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (ledger?.entries ?? []).filter((entry) => {
      // A project's page is about that project, not about one month.
      if (projectId) {
        if (entry.projectId !== projectId) return false;
      } else if (monthOf(entry.date) !== month) {
        return false;
      }
      if (day && entry.date !== day) return false;
      if (refundedOnly && !((entry.refundedAmount ?? 0) > 0)) return false;
      if (kind !== "all" && entry.kind !== kind) return false;
      if (category !== "all" && !categoryMatches(entry.category, category)) return false;
      if (!q) return true;
      return `${entry.counterparty} ${entry.note} ${entry.category} ${entry.account}`
        .toLowerCase()
        .includes(q);
    });
  }, [ledger, month, kind, category, query, day, refundedOnly, projectId]);

  // Archived rows are kept out of the table, its day totals and its summary —
  // they are context you can inspect and restore, not spending. When the toggle
  // is on they get their own block underneath, so no number ever mixes the two.
  const live = React.useMemo(() => rows.filter(countsTowardTotals), [rows]);
  const archivedRows = React.useMemo(() => rows.filter((entry) => entry.archived), [rows]);

  const ordered = React.useMemo(() => {
    if (sort === "date") return live;
    const sign = sort === "amount-desc" ? -1 : 1;
    const value = (entry: LedgerEntry) =>
      entry.kind === "expense" ? effectiveAmount(entry) : entry.amount;
    // Big amounts first (or last); ties keep the newest date on top so the
    // order is stable and readable.
    return [...live].sort(
      (a, b) => sign * (value(a) - value(b)) || b.date.localeCompare(a.date),
    );
  }, [live, sort]);

  const archivedCount = React.useMemo(
    () =>
      (ledger?.entries ?? []).filter(
        (entry) => entry.archived && (!projectId || entry.projectId === projectId),
      ).length,
    [ledger, projectId],
  );

  // Drilling into a day from another month has to move the month window too,
  // otherwise the filter would hide everything.
  React.useEffect(() => {
    if (!initialDay) return;
    const target = initialDay.slice(0, 7);
    if (target !== month) setMonth(target);
  }, [initialDay, month, setMonth]);

  const total = React.useMemo(() => totalsOf(live), [live]);

  // Day buckets, newest first — the fastest way to read a month is a running
  // total per day, not one long list.
  const groups = React.useMemo(() => groupByDay(live), [live]);

  // 行上要的图标和项目名，一次查好。原来每一行自己去 categories / projects 里
  // find，3200 行就是 3200 次线性查找，纯属白花时间。
  const iconByPath = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const def of categories) map.set(categoryPath(def), def.icon);
    return map;
  }, [categories]);
  const projectNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const project of ledger?.projects ?? []) map.set(project.id, project.name);
    return map;
  }, [ledger]);

  // 把「日期头 + 行」摊平成一串，窗口化才有东西可算。分组和按金额排序是互斥的，
  // 所以两条路径各自摊一份。
  type Item =
    | { kind: "day"; date: string; group: (typeof groups)[number] }
    | { kind: "row"; entry: LedgerEntry };
  const items = React.useMemo<Item[]>(() => {
    if (sort === "date" && grouped) {
      const out: Item[] = [];
      for (const bucket of groups) {
        out.push({ kind: "day", date: bucket.date, group: bucket });
        for (const entry of bucket.rows) out.push({ kind: "row", entry });
      }
      return out;
    }
    return ordered.map((entry) => ({ kind: "row", entry }));
  }, [groups, ordered, sort, grouped]);

  const listRef = React.useRef<HTMLDivElement>(null);
  const viewport = useScrollViewport();
  // 行高必须和 EntryRow / 日期头里写死的 style.height 一致，否则滚到后面会越算越偏。
  const heights = React.useMemo(
    () =>
      items.map((item) =>
        item.kind === "day" ? DAY_H : (item.entry.refundedAmount ?? 0) > 0 ? ROW_TALL_H : ROW_H,
      ),
    [items],
  );
  const offsets = React.useMemo(() => offsetsOf(heights), [heights]);
  // 几十行的时候窗口化只会添乱，直接全渲染
  const windowed = useVirtualWindow(viewport, listRef, offsets, items.length > 80);
  const shown = windowed.end > windowed.start ? items.slice(windowed.start, windowed.end) : [];
  const listHeight = offsets.length ? offsets[offsets.length - 1] : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("ledger.filter.search")}
          className="h-[26px] w-[170px] text-[12px]"
          aria-label={t("ledger.filter.search")}
        />
        <div className="w-[176px]">
          <Segmented<"all" | EntryKind>
            ariaLabel={t("ledger.filter.kind")}
            size="sm"
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: t("ledger.kind.all") },
              { value: "expense", label: t("ledger.kind.expense") },
              { value: "income", label: t("ledger.kind.income") },
            ]}
          />
        </div>
        <CategorySelect
          categories={ledger?.categories ?? []}
          value={category}
          onChange={setCategory}
          ariaLabel={t("ledger.filter.category")}
          includeAll
          allLabel={t("ledger.filter.allCategories")}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={refundedOnly}
          aria-label={t("ledger.entries.onlyRefunded")}
          onClick={() => setRefundedOnly((v) => !v)}
          className={cn(
            "h-[26px] gap-1 px-1.5 text-[11.5px]",
            refundedOnly && "text-[color:var(--green)]",
          )}
        >
          <RotateCcw size={11} strokeWidth={2.2} />
          {t("ledger.entries.onlyRefunded")}
        </Button>
        {archivedCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showArchived}
            aria-label={t("ledger.entries.includeArchived")}
            onClick={() => setShowArchived((value) => !value)}
            className={cn("h-[26px] gap-1 px-1.5 text-[11.5px]", showArchived && "text-accent")}
          >
            <Archive size={11} strokeWidth={2.2} />
            {t("ledger.entries.includeArchived")}
            <span className="num text-[10.5px] text-faint">{archivedCount}</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={grouped}
          aria-label={t("ledger.entries.groupByDay")}
          disabled={sort !== "date"}
          onClick={() => setGrouped((v) => !v)}
          className={cn("h-[26px] gap-1 px-1.5 text-[11.5px]", grouped && sort === "date" && "text-accent")}
        >
          <Rows3 size={11} strokeWidth={2.2} />
          {t("ledger.entries.groupByDay")}
        </Button>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          aria-label={t("ledger.entries.sort")}
          className="h-[26px] rounded-[5px] border border-border bg-surface px-1.5 text-[11.5px]"
        >
          <option value="date">{t("ledger.entries.sortDate")}</option>
          <option value="amount-desc">{t("ledger.entries.sortAmountDesc")}</option>
          <option value="amount-asc">{t("ledger.entries.sortAmountAsc")}</option>
        </select>
        {day ? (
          <button
            type="button"
            onClick={() => setDay(null)}
            title={t("ledger.dash.clearDay")}
            className="flex items-center gap-1 rounded-[5px] border border-accent/50 bg-accent-soft px-1.5 py-[2px] text-[11.5px] text-foreground"
          >
            {t("ledger.dash.filteredDay", { date: day.slice(5) })}
            <X size={9} strokeWidth={2.6} />
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="num text-[11.5px] text-faint">
          {t("ledger.filter.summary", {
            count: live.length,
            expense: formatCents(total.expense, lang),
            income: formatCents(total.income, lang),
          })}
        </span>
      </div>

      <div className="overflow-hidden rounded-[7px] border border-hairline/70">
        <div className="grid grid-cols-[92px_1fr_84px_96px_104px_76px] items-center gap-2 border-b border-hairline/70 bg-surface/60 px-3 py-[6px] text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <span>{t("ledger.col.date")}</span>
          <span>{t("ledger.col.detail")}</span>
          <span>{t("ledger.col.category")}</span>
          <span>{t("ledger.col.account")}</span>
          <span className="text-right">{t("ledger.col.amount")}</span>
          <span className="text-right">{t("ledger.col.actions")}</span>
        </div>
        {live.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-faint">{t("ledger.entries.empty")}</p>
        ) : (
          // 只渲染视口里那几十行。总数靠外层这个 height 撑住，滚动条才不会跳。
          <div ref={listRef} style={{ height: listHeight }}>
            <div style={{ transform: `translateY(${windowed.padTop}px)` }}>
              {shown.map((item) =>
                item.kind === "day" ? (
                  <div
                    key={`d-${item.date}`}
                    style={{ height: DAY_H }}
                    className="flex items-center gap-2 border-b border-hairline/40 bg-surface/40 px-3 text-[11px]"
                  >
                    <span className="num font-semibold text-foreground">
                      {item.date.slice(5)}
                    </span>
                    <span className="text-faint">
                      {t("ledger.entries.dayCount", { n: item.group.rows.length })}
                    </span>
                    <span className="flex-1" />
                    {item.group.expense > 0 ? (
                      <span className="num text-[color:var(--red)]">
                        -{formatCents(item.group.expense, lang)}
                      </span>
                    ) : null}
                    {item.group.income > 0 ? (
                      <span className="num text-[color:var(--green)]">
                        +{formatCents(item.group.income, lang)}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <EntryRow
                    key={item.entry.id}
                    entry={item.entry}
                    lang={lang}
                    t={t}
                    icon={iconByPath.get(item.entry.category) ?? "dots"}
                    projectName={
                      item.entry.projectId ? (projectNameById.get(item.entry.projectId) ?? "") : ""
                    }
                    confirmId={confirmId}
                    setConfirmId={setConfirmId}
                    onEdit={onEdit}
                    onSelect={onSelect}
                    onRemove={remove}
                  />
                ),
              )}
            </div>
          </div>
        )}
      </div>

      {/* Archived rows get their own block: they are out of every total above,
          and the header makes that explicit so the two never look mixed. */}
      {showArchived && archivedRows.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Archive size={11} strokeWidth={2.2} className="text-faint" />
            <span>{t("ledger.entries.archivedOnly", { n: archivedRows.length })}</span>
          </div>
          <div className="overflow-hidden rounded-[7px] border border-dashed border-hairline/70 opacity-80">
            {archivedRows.slice(0, ARCHIVED_CAP).map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                lang={lang}
                t={t}
                icon={iconByPath.get(entry.category) ?? "dots"}
                projectName={entry.projectId ? (projectNameById.get(entry.projectId) ?? "") : ""}
                confirmId={confirmId}
                setConfirmId={setConfirmId}
                onEdit={onEdit}
                onSelect={onSelect}
                onRemove={remove}
              />
            ))}
          </div>
          {archivedRows.length > ARCHIVED_CAP ? (
            <p className="text-[11px] text-faint">
              {t("ledger.entries.archivedTruncated", { n: ARCHIVED_CAP })}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-[11px] text-faint">
        {projectId
          ? t("ledger.entries.hintProject", { n: live.length })
          : t("ledger.entries.hintMonth", { month })}
      </p>
    </div>
  );
}

/** One table row. Clicking anywhere opens the detail page; the action buttons
 *  stop the event so an edit never doubles as a navigation. */
function EntryRow({
  entry,
  lang,
  t,
  icon,
  projectName,
  confirmId,
  setConfirmId,
  onEdit,
  onSelect,
  onRemove,
}: {
  entry: LedgerEntry;
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** 图标和项目名由调用方查好：一行一次 find，几千行就是几千次。 */
  icon: string;
  projectName: string;
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
  onEdit: (entry: LedgerEntry) => void;
  onSelect: (entry: LedgerEntry) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  // 高度写死，窗口化才能算准；带退款的那行金额下面多一行小字，所以高一点。
  const tall = (entry.refundedAmount ?? 0) > 0;
  return (
    <div
      onClick={() => onSelect(entry)}
      style={{ height: tall ? ROW_TALL_H : ROW_H }}
      className={cn(
        "entry-row group grid cursor-pointer grid-cols-[92px_1fr_84px_96px_104px_76px] items-center gap-2 px-3",
        "border-b border-hairline/40 transition-colors duration-150 last:border-b-0",
        "hover:bg-[color-mix(in_oklch,var(--surface)_75%,transparent)]",
      )}
    >
      <span className="num whitespace-nowrap text-[11.5px] text-faint">
        {entry.date.slice(5)}
        {entry.time ? <span className="ml-1 opacity-70">{entry.time}</span> : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-label={t("ledger.detail.open", {
            name: entry.counterparty || entry.note || entry.category,
          })}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(entry);
          }}
          className="flex min-w-0 items-center gap-1.5 rounded-[3px] text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
        {entry.kind === "expense" ? (
          <ArrowUpRight size={11} strokeWidth={2.2} className="shrink-0 text-[color:var(--red)]" />
        ) : entry.kind === "income" ? (
          <ArrowDownLeft size={11} strokeWidth={2.2} className="shrink-0 text-[color:var(--green)]" />
        ) : (
          <span className="size-[11px] shrink-0" />
        )}
        <span className="min-w-0 truncate text-[12.5px]">
          {entry.counterparty || entry.note || t("ledger.entries.untitled")}
        </span>
        {projectName ? (
          <span
            title={projectName}
            className="max-w-[92px] shrink-0 truncate rounded-[3px] border border-[color-mix(in_oklch,var(--accent)_45%,var(--border))] px-1 text-[9.5px] text-accent"
          >
            {projectName}
          </span>
        ) : null}
        {(entry.refundedAmount ?? 0) > 0 ? (
          <Tooltip
            content={
              entry.refundedAt
                ? t("ledger.refund.linked", { date: entry.refundedAt })
                : t("ledger.refund.linkedUnknown")
            }
            side="top"
          >
            <span className="shrink-0 rounded-[3px] border border-[color-mix(in_oklch,var(--green)_45%,var(--border))] px-1 text-[9.5px] text-[color:var(--green)]">
              {t("ledger.refund.badge")}
            </span>
          </Tooltip>
        ) : null}
        {entry.archived ? (
          <span className="shrink-0 rounded-[3px] border border-dashed border-hairline px-1 text-[9.5px] text-faint">
            {t("ledger.entries.archivedBadge")}
          </span>
        ) : null}
        </button>
      </span>
      <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground">
        <CategoryIcon icon={icon} size={11} className="shrink-0 text-faint" />
        <span className="truncate">{entry.category.split("/").pop()}</span>
      </span>
      <span className="truncate text-[11.5px] text-faint">{entry.account || "—"}</span>
      <span className="flex flex-col items-end leading-tight">
        <span
          className={cn(
            "num text-[13px]",
            KIND_TONE[entry.kind],
            (entry.refundedAmount ?? 0) > 0 && "line-through opacity-55",
          )}
        >
          {entry.kind === "income" ? "+" : entry.kind === "expense" ? "-" : ""}
          {formatCents(entry.amount, lang)}
        </span>
        {(entry.refundedAmount ?? 0) > 0 ? (
          <span className="num text-[10px] text-[color:var(--green)]">
            {t("ledger.refund.net", { value: formatCents(effectiveAmount(entry), lang) })}
          </span>
        ) : null}
      </span>
      <span className="flex items-center justify-end gap-0.5">
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={t("ledger.action.edit")}
          onClick={(event) => {
            event.stopPropagation();
            onEdit(entry);
          }}
        >
          <Pencil size={11} strokeWidth={2} />
        </Button>
        {confirmId === entry.id ? (
          <Button
            variant="danger"
            size="icon-sm"
            aria-label={t("ledger.action.confirmDelete")}
            onClick={(event) => {
              event.stopPropagation();
              setConfirmId(null);
              void onRemove(entry.id);
            }}
          >
            <Check size={11} strokeWidth={2.6} />
          </Button>
        ) : (
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={t("ledger.action.delete")}
            onClick={(event) => {
              event.stopPropagation();
              setConfirmId(entry.id);
            }}
          >
            <Trash2 size={11} strokeWidth={2} />
          </Button>
        )}
      </span>
    </div>
  );
}

/** Full-page detail view. The dialog could not show a long payee, the note and
 *  the refund link at once without feeling cramped, so reading a row gets its
 *  own page and the dialog stays for editing. */
function EntryDetail({
  entry,
  onBack,
  onEdit,
}: {
  entry: LedgerEntry;
  onBack: () => void;
  onEdit: (entry: LedgerEntry) => void;
}) {
  const { t, lang, ledger, linkRefund, setProject } = useLedger();
  const refunded = entry.refundedAmount ?? 0;
  const [linker, setLinker] = React.useState(false);
  // Which import brought this row in. The list stays quiet about sources, but
  // the detail page is where "where did this come from" belongs: the platform
  // and, when it can be identified, the file and its import time.
  const batch = React.useMemo(() => {
    if (entry.source === "manual") return null;
    const candidates = (ledger?.imports ?? []).filter((record) => record.source === entry.source);
    if (candidates.length === 0) return null;
    const stamp = entry.createdAt ?? "";
    // The import that ran just before the row was created is the one that
    // produced it; fall back to the most recent import of that platform.
    const before = candidates
      .filter((record) => !stamp || record.importedAt <= stamp)
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    return before[0] ?? candidates.sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
  }, [ledger?.imports, entry.source, entry.createdAt]);
  const fields: Array<[string, React.ReactNode]> = [
    [t("ledger.col.date"), `${entry.date}${entry.time ? ` ${entry.time}` : ""}`],
    [t("ledger.col.category"), entry.category],
    [t("ledger.col.account"), entry.account || "—"],
    [t("ledger.detail.counterparty"), entry.counterparty || "—"],
    [t("ledger.form.note"), entry.note || "—"],
    [t("ledger.detail.source"), t(`ledger.source.${entry.source}`)],
    batch
      ? [
          t("ledger.detail.importBatch"),
          `${batch.file}${batch.importedAt ? ` · ${batch.importedAt.replace("T", " ").slice(0, 16)}` : ""}`,
        ]
      : [t("ledger.detail.importBatch"), "—"],
    [
      t("ledger.detail.created"),
      entry.createdAt ? entry.createdAt.replace("T", " ").slice(0, 19) : "—",
    ],
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 px-1.5">
          <ArrowLeft size={12} strokeWidth={2.2} />
          {t("ledger.detail.back")}
        </Button>
        <span className="flex-1" />
        {entry.kind === "expense" ? (
          <Button variant="secondary" size="sm" onClick={() => setLinker(true)}>
            <RotateCcw size={11} strokeWidth={2} />
            {refunded > 0 ? t("ledger.refund.relink") : t("ledger.refund.link")}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => onEdit(entry)}>
          <Pencil size={11} strokeWidth={2} />
          {t("ledger.action.edit")}
        </Button>
        {entry.projectId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void setProject([entry.id], "")}
          >
            <FolderMinus size={11} strokeWidth={2} />
            {t("ledger.projects.detach")}
          </Button>
        ) : null}
      </div>

      <RefundLinkDialog
        open={linker}
        entry={entry}
        candidates={(ledger?.entries ?? []).filter(
          (e) =>
            e.id !== entry.id &&
            (e.kind === "transfer" || e.kind === "income") &&
            e.amount <= entry.amount &&
            e.amount > 0 &&
            // Fund earnings and fund moves are not refunds: 余额宝 pays interest
            // daily, and those rows would otherwise crowd out — and be picked
            // ahead of — the real refund.
            !isFundRow(e),
        )}
        onOpenChange={setLinker}
        onLink={async (input) => {
          await linkRefund(input);
          setLinker(false);
        }}
      />

      <div className="flex flex-col gap-1 rounded-[8px] border border-hairline/70 bg-panel/60 px-4 py-4">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {t(`ledger.kind.${entry.kind === "transfer" ? "transfer" : entry.kind}`)}
        </span>
        <span
          className={cn("num text-[30px] font-medium leading-tight", KIND_TONE[entry.kind])}
        >
          {entry.kind === "income" ? "+" : entry.kind === "expense" ? "-" : ""}¥
          {formatCents(entry.amount, lang)}
        </span>
        {refunded > 0 ? (
          <span className="mt-1 flex flex-wrap items-baseline gap-2 text-[12px]">
            <span className="rounded-[3px] border border-[color-mix(in_oklch,var(--green)_45%,var(--border))] px-1 text-[11px] text-[color:var(--green)]">
              {t("ledger.refund.badge")}
            </span>
            <span className="num text-[color:var(--green)]">
              {t("ledger.refund.net", { value: `¥${formatCents(effectiveAmount(entry), lang)}` })}
            </span>
            {entry.refundedAt ? (
              <span className="text-faint">
                {t("ledger.detail.refundedAt", { date: entry.refundedAt })}
              </span>
            ) : null}
            {/* Name the linked refund explicitly: after linking, the source row
                is folded into this one, so this line is the only place that says
                which transaction was absorbed. */}
            <span className="num text-faint">
              {t("ledger.refund.linkedAmount", {
                value: `+${formatCents(refunded, lang)}`,
              })}
            </span>
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-[8px] border border-hairline/70 bg-panel/60 px-4 py-3.5">
        {fields.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-[3px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {label}
            </span>
            <span className="break-words text-[13px] leading-snug">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The body of the import confirmation dialog: counts, range, samples, warnings. */
function PreviewBody({
  preview,
  source,
  onSourceChange,
  t,
  lang,
}: {
  preview: ImportPreview;
  source: "auto" | EntrySource;
  onSourceChange: (next: "auto" | EntrySource) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: Lang;
}) {
  const fresh = Math.max(0, preview.rows - preview.duplicates);
  const stats: Array<[string, string]> = [
    [t("ledger.import.confirmRows"), String(preview.rows)],
    [t("ledger.import.confirmNew"), String(fresh)],
    [t("ledger.import.confirmDuplicates"), String(preview.duplicates)],
    [t("ledger.import.confirmIgnored"), String(preview.ignored)],
  ];
  return (
    <div className="mt-3.5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-muted-foreground">{t("ledger.import.source")}</span>
        <select
          value={source}
          onChange={(event) => onSourceChange(event.target.value as "auto" | EntrySource)}
          aria-label={t("ledger.import.source")}
          className="h-[26px] rounded-[5px] border border-border bg-surface px-1.5 text-[11.5px]"
        >
          <option value="auto">{t("ledger.import.sourceAuto")}</option>
          <option value="wechat">{t("ledger.import.sourceWechat")}</option>
          <option value="alipay">{t("ledger.import.sourceAlipay")}</option>
          <option value="icost">{t("ledger.import.sourceIcost")}</option>
        </select>
        <span className="rounded-[3px] border border-hairline px-1 text-[10px] text-faint">
          {t(`ledger.source.${preview.source}`)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-[6px] border border-hairline/70 bg-surface/40 px-2 py-1.5">
            <div className="text-[10px] text-faint">{label}</div>
            <div className="num text-[15px] font-medium">{value}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <span>
          {t("ledger.import.confirmRange")}：
          <span className="num">
            {preview.firstDate || "—"} ~ {preview.lastDate || "—"}
          </span>
        </span>
        <span className="num text-[color:var(--red)]">-{formatCents(preview.expense, lang)}</span>
        <span className="num text-[color:var(--green)]">+{formatCents(preview.income, lang)}</span>
      </div>

      {preview.rows === 0 ? (
        <p className="rounded-[6px] border border-[color-mix(in_oklch,var(--red)_35%,var(--border))] bg-[color-mix(in_oklch,var(--red)_8%,var(--panel))] px-2.5 py-2 text-[11.5px] text-[color:var(--red)]">
          {t("ledger.import.confirmEmpty")}
        </p>
      ) : fresh === 0 ? (
        <p className="rounded-[6px] border border-hairline bg-surface/50 px-2.5 py-2 text-[11.5px] text-muted-foreground">
          {t("ledger.import.confirmAllDuplicate")}
        </p>
      ) : preview.duplicates > 0 ? (
        <p className="text-[11.5px] text-muted-foreground">
          {t("ledger.import.confirmSkipped", { n: preview.duplicates })}
        </p>
      ) : null}

      {preview.sample.length > 0 ? (
        <div className="overflow-hidden rounded-[6px] border border-hairline/70">
          <div className="border-b border-hairline/60 bg-surface/50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t("ledger.import.confirmSample")}
          </div>
          {preview.sample.map((row, index) => (
            <div
              key={`${row.date}-${index}`}
              className="flex items-center gap-2 border-b border-hairline/40 px-2.5 py-[5px] text-[11.5px] last:border-b-0"
            >
              <span className="num w-[74px] shrink-0 text-faint">
                {row.date.slice(5)}
                {row.time ? ` ${row.time}` : ""}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.counterparty || row.note || "—"}</span>
              <span className="w-[70px] shrink-0 truncate text-[10.5px] text-faint">
                {row.account}
              </span>
              <span className={cn("num w-[80px] shrink-0 text-right", KIND_TONE[row.kind])}>
                {row.kind === "income" ? "+" : row.kind === "expense" ? "-" : ""}
                {formatCents(row.amount, lang)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ImportTab() {
  const { t, lang, importBill, previewImport, lastImports } = useLedger();
  const [result, setResult] = React.useState<{ added: number; duplicates: number; ignored: number } | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [useAi, setUseAi] = React.useState(false);
  // Which platform the file came from. "auto" keeps the header sniffing; picking
  // one is the escape hatch for exports whose header lost a marker column.
  const [source, setSource] = React.useState<"auto" | EntrySource>("auto");
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  // A chosen file is parsed first and held here until the user confirms, so a
  // mis-detected export never touches the ledger.
  const [pending, setPending] = React.useState<{
    file: File;
    bytes: number[];
    preview: ImportPreview;
  } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<{ done: number; total: number }>("ai-progress", (event) => setProgress(event.payload)).then((fn) => { unlisten = fn; }));
    return () => unlisten?.();
  }, []);

  /** Parse the file and open the confirmation dialog — nothing is written yet. */
  const previewFile = React.useCallback(
    async (file: File, bytes: number[], forced: "auto" | EntrySource) => {
      setFailure(null);
      try {
        const preview = await previewImport(bytes, forced === "auto" ? undefined : forced);
        setPending({ file, bytes, preview });
      } catch (err) {
        setFailure(
          String(err).includes("unrecognised-bill")
            ? t("ledger.import.unrecognised")
            : String(err),
        );
      }
    },
    [previewImport, t],
  );

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setResult(null);
    setFailure(null);
    try {
      const buffer = await file.arrayBuffer();
      await previewFile(file, Array.from(new Uint8Array(buffer)), source);
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  /** Commit the pending preview. */
  const confirmImport = async () => {
    if (!pending) return;
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      const outcome = await importBill(
        pending.file.name,
        pending.bytes,
        useAi,
        source === "auto" ? undefined : source,
      );
      setResult(outcome);
      setPending(null);
    } catch (err) {
      setFailure(String(err).includes("unrecognised-bill") ? t("ledger.import.unrecognised") : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Section title={t("ledger.import.title")} hint={t("ledger.import.hint")}>
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void handleFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border bg-surface/40 px-4 py-7 text-center transition-colors",
            "hover:border-accent hover:bg-accent-soft/40",
            busy && "pointer-events-none opacity-60",
          )}
        >
          <FileUp size={20} strokeWidth={1.7} className="text-accent" />
          <span className="text-[13px] font-medium">
            {busy ? t("ledger.import.reading") : t("ledger.import.drop")}
          </span>
          <span className="text-[11px] text-faint">{t("ledger.import.formats")}</span>
          {busy ? (
            <div className="mt-1 flex w-full flex-col items-center gap-1">
              <div className="h-[6px] w-full overflow-hidden rounded-full bg-surface-strong/70" role="progressbar" aria-label={t("ledger.import.progress")} aria-valuenow={progress.done} aria-valuemax={progress.total || 1}>
                <div className={cn("h-full rounded-full bg-[color:var(--accent)]", progress.total ? "transition-[width] duration-200" : "animate-pulse")} style={{ width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 100}%` }} />
              </div>
              <span className="text-[11px] text-faint">
                {progress.total ? t("ledger.import.progressCount", { done: progress.done, total: progress.total }) : t("ledger.import.parsing")}
              </span>
            </div>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,text/csv"
            className="sr-only"
            onChange={(e) => void handleFiles(e.target.files)}
            aria-label={t("ledger.import.drop")}
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} className="size-3 accent-[var(--accent)]" />
          {t("ledger.import.useAi")}
        </label>
        <p className="-mt-1 text-[11px] text-faint">{t("ledger.import.useAiHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] text-muted-foreground">{t("ledger.import.source")}</span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as "auto" | EntrySource)}
            disabled={busy}
            aria-label={t("ledger.import.source")}
            className="h-[26px] rounded-[5px] border border-border bg-surface px-1.5 text-[11.5px]"
          >
            <option value="auto">{t("ledger.import.sourceAuto")}</option>
            <option value="wechat">{t("ledger.import.sourceWechat")}</option>
            <option value="alipay">{t("ledger.import.sourceAlipay")}</option>
            <option value="icost">{t("ledger.import.sourceIcost")}</option>
          </select>
          <span className="text-[11px] text-faint">{t("ledger.import.sourceHint")}</span>
        </div>
      </Section>

      {failure ? (
        <div className="flex items-center gap-2 rounded-[6px] border border-[color-mix(in_oklch,var(--red)_35%,var(--border))] bg-[color-mix(in_oklch,var(--red)_8%,var(--panel))] px-2.5 py-2 text-[12px]">
          <X size={12} strokeWidth={2.4} className="text-[color:var(--red)]" />
          {failure}
        </div>
      ) : null}

      {/* Nothing is imported until this dialog is confirmed: the file has only
          been parsed, so a wrong source or a half-understood export is still a
          no-op on the ledger. */}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent className="w-[560px] p-5">
          <DialogTitle className="text-[14px] font-semibold">
            {t("ledger.import.confirmTitle")}
          </DialogTitle>
          <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
            {t("ledger.import.confirmHint")}
          </p>
          {pending ? (
            <PreviewBody
              preview={pending.preview}
              source={source}
              onSourceChange={(next) => {
                setSource(next);
                void previewFile(pending.file, pending.bytes, next);
              }}
              t={t}
              lang={lang}
            />
          ) : null}
          <div className="mt-4 flex items-center gap-2 border-t border-hairline/60 pt-3">
            <span className="flex-1" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(null)}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !pending || pending.preview.rows - pending.preview.duplicates <= 0}
              onClick={() => void confirmImport()}
            >
              {t("ledger.import.confirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {result ? (
        <div className="flex items-center gap-3 rounded-[6px] border border-[color-mix(in_oklch,var(--green)_30%,var(--border))] bg-[color-mix(in_oklch,var(--green)_8%,var(--panel))] px-3 py-2 text-[12px]">
          <Check size={13} strokeWidth={2.6} className="text-[color:var(--green)]" />
          <span>{t("ledger.import.done", { added: result.added })}</span>
          <span className="text-faint">
            {t("ledger.import.skipped", { count: result.duplicates + result.ignored })}
          </span>
        </div>
      ) : null}

      <Section title={t("ledger.import.history")}>
        {lastImports.length === 0 ? (
          <p className="text-[12px] text-faint">{t("ledger.import.noHistory")}</p>
        ) : (
          <div className="flex flex-col">
            {lastImports.map((record) => (
              <div
                key={record.id}
                className="flex items-center gap-2 border-b border-hairline/50 py-[6px] text-[12px] last:border-b-0"
              >
                <span className="w-[42px] shrink-0 rounded-[3px] border border-hairline px-1 text-center text-[9.5px] uppercase tracking-wide text-faint">
                  {record.source}
                </span>
                <span className="min-w-0 flex-1 truncate">{record.file}</span>
                <span className="num shrink-0 text-[11.5px] text-muted-foreground">
                  +{record.added}
                </span>
                <span className="num w-[38px] shrink-0 text-right text-[11px] text-faint">
                  {record.skipped}
                </span>
                <span className="num w-[92px] shrink-0 text-right text-[11px] text-faint">
                  {record.importedAt.slice(0, 10)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-faint">{t("ledger.import.historyHint")}</p>
      </Section>
    </div>
  );
}


/** Attach a refund to a purchase by hand.
 *
 *  The list is the point: a refund can be any earlier row of similar size, so
 *  the dialog ranks candidates by how close they are in date and amount, and
 *  still lets the user search or simply type a figure. */
function RefundLinkDialog({
  open,
  entry,
  candidates,
  onOpenChange,
  onLink,
}: {
  open: boolean;
  entry: LedgerEntry;
  candidates: LedgerEntry[];
  onOpenChange: (open: boolean) => void;
  onLink: (input: RefundLinkInput) => Promise<void>;
}) {
  const { t, lang } = useLedger();
  const [mode, setMode] = React.useState<"list" | "manual">("list");
  const [filter, setFilter] = React.useState<"smart" | "all">("smart");
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setMode(candidates.length > 0 ? "list" : "manual");
    setFilter("smart");
    setQuery("");
    // Leave the choice empty so the first row of the sorted list wins.
    setPicked(null);
    setAmount(((entry.amount - (entry.refundedAmount ?? 0)) / 100).toFixed(2));
    setDate(new Date().toISOString().slice(0, 10));
  }, [open, entry, candidates]);

  const entryDate = new Date(entry.date).getTime();
  // What is still refundable on this purchase.
  const remaining = Math.max(0, entry.amount - (entry.refundedAmount ?? 0));

  /**
   * How alike two texts are, 0..1. Refund rows rarely repeat the merchant name
   * exactly, so this compares normalised strings and then character bigrams —
   * cheap, predictable, and enough to order the list sensibly.
   */
  const textSimilarity = (left: string, right: string): number => {
    const clean = (value: string) =>
      value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const a = clean(left);
    const b = clean(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.85;
    const grams = (value: string) => {
      const set = new Set<string>();
      for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
      return set;
    };
    const ga = grams(a);
    const gb = grams(b);
    if (ga.size === 0 || gb.size === 0) return 0;
    let shared = 0;
    for (const gram of ga) if (gb.has(gram)) shared += 1;
    return (2 * shared) / (ga.size + gb.size);
  };

  /**
   * Candidate order is the same promise the dialog makes in its hint: an exact
   * amount first, then the same day, then the most similar merchant/note. The
   * day gap only breaks remaining ties, so a matching amount a week later still
   * outranks a same-day row for a different sum.
   */
  const scored = React.useMemo(
    () =>
      candidates
        .map((candidate) => {
          const days = Math.round(
            Math.abs(new Date(candidate.date).getTime() - entryDate) / 86_400_000,
          );
          const sameAmount =
            candidate.amount === entry.amount || candidate.amount === remaining;
          const sameDay = candidate.date === entry.date;
          const similarity = textSimilarity(
            `${entry.counterparty} ${entry.note}`,
            `${candidate.counterparty} ${candidate.note}`,
          );
          return { candidate, days, sameAmount, sameDay, similarity };
        })
        .sort(
          (a, b) =>
            Number(b.sameAmount) - Number(a.sameAmount) ||
            Number(b.sameDay) - Number(a.sameDay) ||
            b.similarity - a.similarity ||
            a.days - b.days ||
            b.candidate.amount - a.candidate.amount,
        ),
    [candidates, entry, entryDate, remaining],
  );

  const visible = scored.filter(({ candidate, days }) => {
    if (filter === "smart") {
      // Within a plausible window and at most the purchase amount.
      if (days > 45) return false;
    }
    if (!query.trim()) return true;
    const hay = `${candidate.counterparty} ${candidate.note} ${candidate.category}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });

  // The row that will be linked if the user just hits save: the list is sorted,
  // so the first visible one is the best suggestion.
  const activeId = picked ?? visible[0]?.candidate.id ?? null;

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "list" && activeId) {
        await onLink({ entryId: entry.id, sourceId: activeId, amount: 0, date: "" });
        return;
      }
      const yuan = Number(amount.replace(/[^\d.]/g, ""));
      if (!Number.isFinite(yuan) || yuan <= 0) {
        setError(t("ledger.refund.needAmount"));
        return;
      }
      await onLink({ entryId: entry.id, amount: Math.round(yuan * 100), date });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[520px] p-5">
        <DialogTitle className="text-[14px] font-semibold">{t("ledger.refund.link")}</DialogTitle>
        <p className="mt-1.5 text-[11.5px] leading-snug text-faint">{t("ledger.refund.linkHint")}</p>

        <div className="mt-3.5 flex flex-col gap-3">
          <div className="w-[200px]">
            <Segmented<"list" | "manual">
              ariaLabel={t("ledger.refund.mode")}
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "list", label: t("ledger.refund.fromList") },
                { value: "manual", label: t("ledger.refund.manual") },
              ]}
            />
          </div>

          {mode === "list" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("ledger.refund.search")}
                  aria-label={t("ledger.refund.search")}
                  className="h-[26px] w-[190px] text-[12px]"
                />
                <div className="w-[150px]">
                  <Segmented<"smart" | "all">
                    ariaLabel={t("ledger.refund.filter")}
                    size="sm"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "smart", label: t("ledger.refund.smart") },
                      { value: "all", label: t("ledger.filter.allCategories") },
                    ]}
                  />
                </div>
                <span className="flex-1" />
                <span className="num text-[11px] text-faint">
                  {t("settings.ledger.reclassifyCount", { n: visible.length })}
                </span>
              </div>

              <div className="flex max-h-[220px] flex-col overflow-y-auto rounded-[6px] border border-hairline/70">
                {visible.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[11.5px] text-faint">
                    {t("ledger.refund.noCandidates")}
                  </p>
                ) : (
                  visible.slice(0, REFUND_CAP).map(({ candidate, days, sameAmount }) => {
                    const active = activeId === candidate.id;
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        onClick={() => setPicked(candidate.id)}
                        aria-pressed={active}
                        className={cn(
                          "flex items-center gap-2 border-b border-hairline/40 px-2.5 py-[6px] text-left text-[12px] last:border-b-0",
                          "transition-colors duration-150 hover:bg-surface/60",
                          active && "bg-accent-soft",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-3 shrink-0 items-center justify-center rounded-full border",
                            active ? "border-accent bg-accent" : "border-hairline",
                          )}
                          aria-hidden
                        >
                          {active ? <Check size={8} strokeWidth={3} className="text-[var(--paper)]" /> : null}
                        </span>
                        {/* Full date plus the time: refund rows often repeat on
                            several days, so MM-DD alone cannot identify one. */}
                        <span className="num w-[104px] shrink-0 text-[11px] text-faint">
                          {candidate.date}
                          {candidate.time ? ` ${candidate.time}` : ""}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {candidate.counterparty || candidate.note || t("ledger.entries.untitled")}
                        </span>
                        <span className="shrink-0 text-[10px] text-faint">
                          {days === 0
                            ? t("ledger.refund.sameDay")
                            : t("ledger.refund.daysApart", { n: days })}
                        </span>
                        {sameAmount ? (
                          <span className="shrink-0 rounded-[3px] border border-[color-mix(in_oklch,var(--green)_45%,var(--border))] px-1 text-[9.5px] text-[color:var(--green)]">
                            {t("ledger.refund.sameAmount")}
                          </span>
                        ) : null}
                        {/* Refund candidates are incoming money, so the sign and
                            colour have to say so — an unmarked 520 looks like
                            another expense. */}
                        <span
                          className={cn(
                            "num w-[84px] shrink-0 text-right",
                            KIND_TONE[candidate.kind],
                          )}
                        >
                          {candidate.kind === "expense" ? "-" : "+"}
                          {formatCents(candidate.amount, lang)}
                        </span>
                      </button>
                    );
                  })
                )}
                {visible.length > REFUND_CAP ? (
                  <p className="px-3 py-2 text-center text-[11px] text-faint">
                    {t("ledger.entries.archivedTruncated", { n: REFUND_CAP })}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("ledger.refund.amount")}
                </span>
                <Input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  className="num h-7"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("ledger.col.date")}
                </span>
                <Input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className="h-7"
                />
              </label>
            </div>
          )}

          {error ? <span className="text-[11.5px] text-[color:var(--red)]">{error}</span> : null}

          <div className="mt-1 flex items-center gap-2 border-t border-hairline/60 pt-3">
            {(entry.refundedAmount ?? 0) > 0 ? (
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void clearLink()}>
                {t("ledger.refund.unlink")}
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || (mode === "list" && !activeId)}
              onClick={() => void submit()}
            >
              {t("action.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  async function clearLink() {
    setBusy(true);
    try {
      await onLink({ entryId: entry.id, amount: 0, date: "" });
    } finally {
      setBusy(false);
    }
  }
}

function EntryDialog({
  open,
  entry,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  entry?: LedgerEntry;
  onOpenChange: (open: boolean) => void;
  /** Lets the detail page refresh itself after an edit. */
  onSaved?: (entry: LedgerEntry | null) => void;
}) {
  const { t, add, update, ledger, setProject } = useLedger();
  const [projectId, setProjectId] = React.useState("");
  const [kind, setKind] = React.useState<EntryKind>("expense");
  const [date, setDate] = React.useState(todayISO());
  const [time, setTime] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [category, setCategory] = React.useState("餐饮");
  const [account, setAccount] = React.useState("");
  const [counterparty, setCounterparty] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // 只在「打开」和「打开的是哪一行」变化时灌表单。依赖里放 ledger 是个坑：
  // 保存会换掉 ledger，正在编辑的表单就会被重置；后台同步落地时更糟，
  // 用户输了一半的内容会凭空被抹掉。默认值用 ref 读，不进依赖。
  const ledgerRef = React.useRef(ledger);
  ledgerRef.current = ledger;

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    if (entry) {
      setKind(entry.kind);
      setDate(entry.date);
      setTime(entry.time);
      setAmount((entry.amount / 100).toFixed(2));
      setCategory(entry.category);
      setAccount(entry.account);
      setCounterparty(entry.counterparty);
      setNote(entry.note);
      setProjectId(entry.projectId ?? "");
    } else {
      setKind("expense");
      setDate(todayISO());
      setTime("");
      setAmount("");
      const current = ledgerRef.current;
      setCategory(
        (current?.categories.find((c) => !c.parent && c.kind !== "income")?.name as string) ??
          "其他",
      );
      setAccount(current?.accounts[0] ?? "");
      setCounterparty("");
      setNote("");
      setProjectId("");
    }
  }, [open, entry]);

  const save = async () => {
    const yuan = Number(amount.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(yuan) || yuan <= 0) {
      setError(t("ledger.form.needAmount"));
      return;
    }
    if (!date) {
      setError(t("ledger.form.needDate"));
      return;
    }
    const input: EntryInput = {
      date,
      time,
      kind,
      amount: Math.round(yuan * 100),
      category,
      account,
      counterparty,
      note,
      excluded: false,
    };
    try {
      if (entry) {
        await update(entry.id, input);
        // Membership is separate from the financial edit, including clearing it.
        // 没变就别再往返一次：那一趟要把整份账本传回来，几千条时很贵。
        if ((entry.projectId ?? "") !== projectId) await setProject([entry.id], projectId);
      } else {
        const created = await add(input);
        // A brand-new row can already belong to a project — that is the whole
        // point when you are logging the third taxi of a trip.
        if (created && projectId) await setProject([created.id], projectId);
      }
      onSaved?.(
        entry
          ? {
              ...entry,
              ...input,
              kind: input.kind,
              amount: input.amount,
              category: input.category,
            }
          : null,
      );
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[430px] p-5">
        <DialogTitle className="text-[14px] font-semibold">
          {entry ? t("ledger.form.editTitle") : t("ledger.form.addTitle")}
        </DialogTitle>

        <div className="mt-4 flex flex-col gap-3.5">
          <Segmented<EntryKind>
            ariaLabel={t("ledger.col.detail")}
            value={kind}
            size="sm"
            onChange={setKind}
            options={[
              { value: "expense", label: t("ledger.kind.expense") },
              { value: "income", label: t("ledger.kind.income") },
              { value: "transfer", label: t("ledger.kind.transfer") },
            ]}
          />

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.form.amount")}
            </span>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
              inputMode="decimal"
              placeholder="0.00"
              autoFocus
              className="num h-8 text-[16px]"
            />
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("ledger.col.date")}
              </span>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-7" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("ledger.form.time")}
              </span>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-7" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("ledger.col.category")}
              </span>
              <CategorySelect
                categories={ledger?.categories ?? []}
                value={category}
                onChange={setCategory}
                ariaLabel={t("ledger.col.category")}
                kind={kind === "income" ? "income" : "expense"}
                className="h-7 w-full text-[13px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("ledger.col.account")}
              </span>
              <Input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                list="ledger-accounts"
                className="h-7"
              />
              <datalist id="ledger-accounts">
                {(ledger?.accounts ?? []).map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.form.counterparty")}
            </span>
            <Input
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder={t("ledger.form.counterpartyPlaceholder")}
              className="h-7"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.form.note")}
            </span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-7" />
          </label>

          {/* Membership is independent of category and account, so a trip can
              collect rows from every category. Archived projects stay selectable
              for the entry that is already in them. */}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("ledger.form.project")}
            </span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label={t("ledger.form.project")}
              className="h-7 w-full rounded-[4px] border border-hairline bg-transparent px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <option value="">{t("ledger.projects.none")}</option>
              {(ledger?.projects ?? [])
                .filter((project) => !project.archived || project.id === projectId)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                    {project.archived ? ` · ${t("ledger.projects.archived")}` : ""}
                  </option>
                ))}
            </select>
          </label>

          {error ? <span className="text-[11.5px] text-down">{error}</span> : null}

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-hairline/60 pt-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("action.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void save()}>
              {t("action.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { formatYuan };
