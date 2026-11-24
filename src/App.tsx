import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useStore } from "@/store/app-store";
import { StockList } from "@/components/stock-list";
import { StockChart } from "@/components/stock-chart";
import { SearchView } from "@/components/search-view";
import { EditStockDialog } from "@/components/edit-stock-dialog";
import { Masthead } from "@/components/masthead";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Stock } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AlertTriangle, ListOrdered, Plus, Settings2, Wallet } from "lucide-react";

type View = "list" | "chart" | "search";

export function App() {
  const {
    t,
    stocks,
    settings,
    updateSettings,
    loading,
    toasts,
    refresh,
    reorder,
    openSettings,
    notifyGranted,
    requestNotifications,
    error,
    snapshot,
  } = useStore();
  const [view, setView] = React.useState<View>("list");
  const [selected, setSelected] = React.useState<Stock | null>(null);
  const [editing, setEditing] = React.useState<Stock | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const reduce = useReducedMotion();

  const openPrefs = React.useCallback(() => {
    void openSettings();
    void import("@/lib/api").then((m) => m.api.hidePanel());
    if (!notifyGranted) void requestNotifications();
  }, [openSettings, notifyGranted, requestNotifications]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editOpen) {
        if (view === "search" || view === "chart") setView("list");
        else void import("@/lib/api").then((m) => m.api.hidePanel());
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void refresh();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openPrefs();
      }
      if (event.key === "/" && view === "list" && !event.metaKey) {
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        event.preventDefault();
        setView("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editOpen, view, refresh, openPrefs]);

  const openEditor = (stock: Stock) => {
    setEditing(stock);
    setEditOpen(true);
  };

  const sorted = settings?.sortRule !== "manual";
  const hasStocks = stocks.length > 0;

  const chartTitle =
    view === "chart" && selected ? selected.name || selected.code : undefined;
  const chartSubtitle =
    view === "chart" && selected
      ? `${t(`market.${selected.market}`)} · ${selected.code}`
      : undefined;

  const flashMs =
    settings?.flashDuration === "off"
      ? 0
      : settings?.flashDuration === "short"
        ? 380
        : settings?.flashDuration === "long"
          ? 1100
          : 620;

  return (
    <TooltipProvider>
      <div
        className="shell"
        style={{ "--tick-flash-ms": `${flashMs}ms` } as React.CSSProperties}
      >
        <div className="panel flex flex-col">
          <Masthead
            view={view === "search" ? "list" : view}
            showSummary={view === "list"}
            title={view === "search" ? t("search.title") : chartTitle}
            subtitle={chartSubtitle}
            onBack={() => {
              if (view === "chart") setView("list");
              else setView("list");
            }}
            onOpenSettings={openPrefs}
          />

          {error || snapshot?.error ? (
            <div
              role="alert"
              className="mx-2 mb-1 flex items-center gap-1.5 rounded-[4px] border border-[color-mix(in_oklch,var(--amber)_35%,var(--border))] bg-[color-mix(in_oklch,var(--amber)_12%,var(--panel))] px-2 py-1 text-[10px]"
            >
              <AlertTriangle size={10} strokeWidth={2.2} className="shrink-0 text-amber" />
              <span className="truncate">
                {snapshot?.error === "feed" ? t("error.feed") : t("error.refresh")}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="ml-auto shrink-0 font-medium text-accent underline-offset-2 hover:underline"
              >
                {t("action.retry")}
              </button>
            </div>
          ) : null}

          <div className="relative flex min-h-0 flex-1 flex-col">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={view}
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: [0.25, 0.7, 0.3, 1] }}
                className="flex min-h-0 flex-1 flex-col"
              >
                {view === "list" ? (
                  loading && !hasStocks ? (
                    <div className="flex flex-1 items-center justify-center text-[11px] text-faint">
                      {t("list.loading")}
                    </div>
                  ) : (
                    <StockList
                      onSelect={(stock) => {
                        setSelected(stock);
                        setView("chart");
                      }}
                      onAdd={() => setView("search")}
                      onMove={(id, direction) => {
                        const ids = stocks.map((s) => s.id);
                        const index = ids.indexOf(id);
                        const target = index + direction;
                        if (index < 0 || target < 0 || target >= ids.length) return;
                        [ids[index], ids[target]] = [ids[target], ids[index]];
                        void reorder(ids);
                      }}
                    />
                  )
                ) : view === "chart" && selected ? (
                  <StockChart stock={selected} />
                ) : (
                  <SearchView onDone={() => setView("list")} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <AppFooter
            sorted={sorted}
            onToggleSort={() =>
              void updateSettings({
                sortRule: sorted ? "manual" : "changeDesc",
              })
            }
            onAdd={() => setView("search")}
            onSettings={openPrefs}
            onManage={() => {
              // Edit whichever stock is open (chart view), else the first one;
              // a single hard-coded stock made the button look broken.
              const target = (view === "chart" && selected) || stocks[0];
              if (target) openEditor(target);
              else setView("search");
            }}
          />

          <Toasts toasts={toasts} />
        </div>
      </div>
      <EditStockDialog stock={editing} open={editOpen} onOpenChange={setEditOpen} />
    </TooltipProvider>
  );
}

function AppFooter({
  sorted,
  onToggleSort,
  onAdd,
  onSettings,
  onManage,
}: {
  sorted: boolean;
  onToggleSort: () => void;
  onAdd: () => void;
  onSettings: () => void;
  onManage: () => void;
}) {
  const { t, stocks } = useStore();

  return (
    <footer className="flex items-center gap-0.5 border-t border-border/70 px-2 py-1.5">
      <FooterButton
        icon={<Plus size={13} strokeWidth={2.4} />}
        label={t("nav.search")}
        onClick={onAdd}
      />
      <FooterButton
        icon={<ListOrdered size={13} strokeWidth={2.3} />}
        label={t("action.sort")}
        active={sorted}
        onClick={onToggleSort}
      />
      <FooterButton
        icon={<Settings2 size={13} strokeWidth={2.3} />}
        label={t("action.settings")}
        onClick={onSettings}
      />
      <FooterButton
        icon={<Wallet size={13} strokeWidth={2.2} />}
        label={t("action.manage")}
        onClick={onManage}
      />
      <span className="flex-1" />
      <span className="num pr-1 text-[9px] tabular-nums text-faint">
        {stocks.length ? t("settings.stocks.count", { n: stocks.length }) : ""}
      </span>
    </footer>
  );
}

function FooterButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-[25px] items-center gap-1 px-1.5 text-[10.5px] leading-none",
        active ? "text-accent" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {/* Both children have the same fixed line box and are centred by the same
          flex rule. No hand-tuned offsets: that is what kept the glyphs
          visually off-centre despite looking right in DOM measurements. */}
      <span className="flex h-5 shrink-0 items-center leading-none">{icon}</span>
      <span className="flex h-5 shrink-0 items-center leading-none">{label}</span>
    </Button>
  );
}

function Toasts({ toasts }: { toasts: { id: number; message: string; tone: string }[] }) {
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-10 z-40 flex flex-col items-center gap-1">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.2, 0.7, 0.3, 1] }}
            role="status"
            aria-live="polite"
            className={cn(
              "rounded-[5px] border px-2 py-1 text-[10.5px] shadow-[0_10px_24px_-12px_oklch(0_0_0/0.5)] backdrop-blur",
              toast.tone === "up"
                ? "border-[color-mix(in_oklch,var(--up)_35%,var(--border))] bg-[color-mix(in_oklch,var(--up)_10%,var(--panel))] text-foreground"
                : toast.tone === "down"
                  ? "border-[color-mix(in_oklch,var(--down)_35%,var(--border))] bg-[color-mix(in_oklch,var(--down)_10%,var(--panel))] text-foreground"
                  : "border-border bg-panel/95 text-foreground",
            )}
          >
            {toast.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
