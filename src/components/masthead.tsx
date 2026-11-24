import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { useStore } from "@/store/app-store";
import { cn } from "@/lib/utils";
import { formatMoney, formatPercent } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ChevronLeft, Percent, RefreshCw, SlidersHorizontal, Power } from "lucide-react";

/** The masthead doubles as the window's title bar: on macOS the webview is
 *  drag-able here, and the live clock is the app's heartbeat. */
export function Masthead({
  view,
  showSummary = true,
  onBack,
  onOpenSettings,
  title,
  subtitle,
}: {
  view: "list" | "settings" | "chart";
  showSummary?: boolean;
  onBack?: () => void;
  onOpenSettings?: () => void;
  title?: string;
  subtitle?: string;
}) {
  const {
    t,
    lang,
    refresh,
    refreshing,
    totals,
    hasHoldings,
    settings,
    snapshot,
    stocks,
    updateSettings,
  } = useStore();
  const [clock, setClock] = React.useState(() => new Date());
  const reduce = useReducedMotion();

  React.useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const currency = settings?.currency ?? "CNY";
  const summary = totals();
  const summaryVisible = view === "list" && showSummary && hasHoldings;
  const quoteCount = stocks.length;
  const feedDown = snapshot?.error === "feed";

  const time = clock.toLocaleTimeString(lang === "en" ? "en-US" : lang === "ja" ? "ja-JP" : "zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <header
      data-tauri-drag-region
      className="drag-region shrink-0 select-none px-3 pb-2 pt-2.5"
    >
      <div className="flex items-center gap-2">
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-baseline gap-2">
          {view !== "list" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="no-drag -ml-1 h-5 w-5 text-muted-foreground"
              onClick={onBack}
              aria-label={t("action.back")}
            >
              <ChevronLeft size={14} strokeWidth={2.2} />
            </Button>
          ) : null}
          <div data-tauri-drag-region className="min-w-0">
            <h1
              data-tauri-drag-region
              className="truncate text-[13px] font-semibold leading-tight tracking-[-0.015em]"
            >
              {title ?? (view === "settings" ? t("settings.title") : t("app.name"))}
            </h1>
            {subtitle ? (
              <p
              data-tauri-drag-region
              className="mt-[1px] truncate text-[10.5px] leading-tight text-faint"
            >
              {subtitle}
            </p>
            ) : view === "list" ? (
              <p
                data-tauri-drag-region
                className="mt-[1px] flex items-center gap-1.5 text-[10.5px] leading-tight text-faint"
              >
                <span
                  className={cn(
                    "inline-block size-[5px] rounded-full transition-colors",
                    feedDown ? "bg-amber" : quoteCount > 0 ? "bg-accent live-dot" : "bg-faint",
                  )}
                />
                {feedDown ? t("error.feed") : t("app.tagline")}
              </p>
            ) : null}
          </div>
        </div>

        <div className="no-drag flex shrink-0 items-center gap-0.5">
          <span className="num mr-1 text-[10.5px] tabular-nums text-faint">{time}</span>
          {view === "list" && hasHoldings ? (
            <Tooltip
              content={
                settings?.pnlDisplay === "percent"
                  ? t("action.showAmounts")
                  : t("action.showPercents")
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  void updateSettings({
                    pnlDisplay: settings?.pnlDisplay === "percent" ? "amount" : "percent",
                  })
                }
                aria-label={
                  settings?.pnlDisplay === "percent"
                    ? t("action.showAmounts")
                    : t("action.showPercents")
                }
                aria-pressed={settings?.pnlDisplay === "percent"}
                className={cn(
                  settings?.pnlDisplay === "percent" && "text-accent",
                )}
              >
                <Percent size={13} strokeWidth={2.2} />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={t("action.refresh")}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void refresh()}
              aria-label={t("action.refresh")}
              disabled={refreshing}
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={cn(refreshing && !reduce && "animate-spin")}
              />
            </Button>
          </Tooltip>
          {view !== "settings" ? (
            <Tooltip content={t("action.settings")}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onOpenSettings}
                aria-label={t("action.settings")}
              >
                <SlidersHorizontal size={13} strokeWidth={2} />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={t("action.quit")}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void import("@/lib/api").then((m) => m.api.quit())}
              aria-label={t("action.quit")}
            >
              <Power size={13} strokeWidth={2} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {summaryVisible ? (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.2, 0.7, 0.3, 1] }}
          className="mt-2 flex items-end gap-2 rounded-[6px] border border-hairline/70 bg-surface/70 px-2 py-1.5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[9px] font-semibold uppercase leading-none tracking-[0.1em] text-muted-foreground">
              {t("summary.titleShort")}
            </span>
            <span
              className="mt-1 flex items-center gap-1 text-[10px] leading-none text-faint"
              title={t("summary.updated", { time })}
            >
              <span
                className={cn(
                  "inline-block size-[4px] shrink-0 rounded-full",
                  feedDown ? "bg-amber" : "bg-up/70 live-dot",
                )}
                aria-hidden
              />
              <span className="num tabular-nums">{time}</span>
            </span>
          </div>
          <div className="flex shrink-0 items-end gap-2.5">
            <SummaryStat
              label={t("summary.dailyShort")}
              value={formatMoney(summary.daily, currency, lang)}
              percent={summary.dailyPercent}
              tone={summary.daily}
              animate
            />
            <span className="mb-1 h-6 w-px bg-hairline/80" aria-hidden />
            <SummaryStat
              label={t("summary.totalShort")}
              value={formatMoney(summary.total, currency, lang)}
              percent={summary.percent}
              tone={summary.total}
              animate
            />
          </div>
        </motion.div>
      ) : null}
    </header>
  );
}


/** Split-flap style digits: each character slides up and is replaced, so a
 *  refresh reads like a mechanical counter rather than a hard swap. Only the
 *  digits that actually changed move. */
function Odometer({ text }: { text: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{text}</>;

  // Each slot is a clipping window for one glyph. The window sizes itself to the
  // glyph (via an invisible copy) and sits on the baseline, so the run keeps the
  // same rhythm as plain text — fixed-width slots made the digits look spaced
  // out. Only the digits that changed re-animate.
  return (
    <span className="inline-flex items-baseline whitespace-nowrap">
      {Array.from(text).map((char, index) => {
        const isDigit = /[0-9]/.test(char);
        if (!isDigit) {
          return (
            <span key={`sep-${index}-${char}`} className="inline-block">
              {char}
            </span>
          );
        }
        return (
          <span
            key={`d-${index}`}
            aria-hidden
            className="relative inline-block overflow-hidden align-baseline"
          >
            <span className="invisible">{char}</span>
            <motion.span
              key={char}
              initial={{ y: "-100%" }}
              animate={{ y: "0%" }}
              transition={{ duration: 0.28, ease: [0.22, 0.68, 0.3, 1] }}
              className="absolute inset-0 flex items-baseline justify-center"
            >
              {char}
            </motion.span>
          </span>
        );
      })}
      <span className="sr-only">{text}</span>
    </span>
  );
}

function SummaryStat({
  label,
  value,
  percent,
  tone,
  animate,
}: {
  label: string;
  value: string;
  percent: number;
  tone: number;
  animate?: boolean;
}) {
  return (
    <div className="flex flex-col items-end">
      <span className="eyebrow leading-none">{label}</span>
      <span className="mt-[3px] flex items-baseline gap-1 whitespace-nowrap">
        <span
          className={cn(
            "num text-[13px] font-medium leading-none",
            tone > 0 && "text-up",
            tone < 0 && "text-down",
          )}
        >
          {value.startsWith("-") ? "" : tone > 0 ? "+" : ""}
          <span className="tabular-nums">
            {animate ? <Odometer text={value} /> : value}
          </span>
        </span>
        <span
          className={cn(
            "num text-[10px] leading-none",
            tone > 0 ? "text-up" : tone < 0 ? "text-down" : "text-faint",
          )}
        >
          {formatPercent(percent)}
        </span>
      </span>
    </div>
  );
}
