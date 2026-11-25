import * as React from "react";
import { useStore } from "@/store/app-store";
import { cn } from "@/lib/utils";
import { formatPercent, formatPrice } from "@/lib/format";
import type { Candle, ChartData, KlineData, Period, Stock } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";

interface Plot {
  w: number;
  h: number;
  x: (i: number) => number;
  y: (price: number) => number;
  min: number;
  max: number;
  path: string;
  area: string;
  ticks: { price: number; label: string; y: number }[];
  first: number;
  last: number;
}

const PAD = { top: 10, right: 44, bottom: 18, left: 6 };
/** Candle plot insets, shared so a brush in container pixels can be mapped back
 *  to bar indices without guessing. */
const CANDLE_PAD = { left: 6, right: 44 };
/** Fewest candles the brush or the wheel may leave on screen. */
const MIN_CANDLES = 3;

/** A hand-drawn-looking chart beats a stock library here: minute series are
 *  dense (up to 961 points) and the only decoration we want is a hairline grid,
 *  a previous-close rule and soft session bands. */
function buildPlot(data: ChartData, width: number, height: number, schemeUp: boolean): Plot | null {
  if (data.points.length === 0) return null;
  const prices = data.points.map((p) => p.price);
  const minRaw = Math.min(...prices, data.prevClose || Infinity);
  const maxRaw = Math.max(...prices, data.prevClose || -Infinity);
  const span = Math.max(maxRaw - minRaw, (data.prevClose || maxRaw) * 0.004);
  const mid = (maxRaw + minRaw) / 2;
  const min = mid - span * 0.62;
  const max = mid + span * 0.62;

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const lastIndex = Math.max(data.axisLength - 1, 1);
  const x = (i: number) => PAD.left + (i / lastIndex) * innerW;
  const y = (price: number) => PAD.top + (1 - (price - min) / (max - min)) * innerH;

  let path = "";
  for (let i = 0; i < data.points.length; i++) {
    const p = data.points[i];
    path += `${i === 0 ? "M" : "L"}${x(p.i).toFixed(2)} ${y(p.price).toFixed(2)}`;
  }
  const first = data.points[0];
  const last = data.points[data.points.length - 1];
  const area = `${path}L${x(last.i).toFixed(2)} ${(PAD.top + innerH).toFixed(2)}L${x(first.i).toFixed(
    2,
  )} ${(PAD.top + innerH).toFixed(2)}Z`;

  const tickCount = 4;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const price = max - ((max - min) * i) / (tickCount - 1);
    return { price, label: formatPrice(price), y: y(price) };
  });
  void schemeUp;
  return { w: width, h: height, x, y, min, max, path, area, ticks, first: first.price, last: last.price };
}

export function StockChart({ stock }: { stock: Stock }) {
  const { t, loadChart, quotes, settings, loadKline } = useStore();
  const isFund = stock.market === "fund";
  const [period, setPeriod] = React.useState<Period | "intraday">("intraday");
  const [data, setData] = React.useState<ChartData | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [size, setSize] = React.useState({ width: 340, height: 176 });
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const quote = quotes[stock.id];
  /** Cursor position in plot coordinates; null when the pointer is away. */
  const [hover, setHover] = React.useState<{ x: number; y: number } | null>(null);
  /** Visible slice of the candle series (zoom lives here so the wheel handler,
   *  the brush and the chart share one source of truth). */
  const [view, setView] = React.useState({ start: 0, count: 0 });
  /** Brush selection in container pixels; null when not dragging. */
  const [brush, setBrush] = React.useState<{ x0: number; x1: number } | null>(null);
  const brushRef = React.useRef<{ x0: number; x1: number } | null>(null);

  const [kline, setKline] = React.useState<KlineData | null>(null);
  const [klineStatus, setKlineStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [klineNote, setKlineNote] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    // 场外基金没有分时，净值一天一个数，不去打那个接口
    if (isFund) return;
    setStatus("loading");
    loadChart(stock.id)
      .then((d) => {
        setData(d);
        setStatus(d.points.length > 0 ? "ready" : "error");
      })
      .catch(() => setStatus("error"));
  }, [loadChart, stock.id, isFund]);

  React.useEffect(load, [load]);

  // Bars are fetched lazily: the intraday view is the default and most visits
  // never look at a weekly chart.
  React.useEffect(() => {
    if (period === "intraday" || isFund) return;
    let alive = true;
    setKlineStatus("loading");
    loadKline(stock.id, period)
      .then((d) => {
        if (!alive) return;
        setKline(d);
        setKlineStatus(d.candles.length > 0 ? "ready" : "error");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setKlineStatus("error");
        // Korean history only exists on one feed; say so rather than showing a
        // generic failure.
        const reason = String(err ?? "");
        if (stock.market === "kr" && reason.includes("no-data")) {
          setKlineNote(t("chart.krHistoryUnavailable"));
        } else {
          setKlineNote(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [period, stock.id, loadKline]);

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rising = (quote?.change ?? 0) >= 0;
  const chartUp = data ? data.points[data.points.length - 1].price >= data.prevClose : rising;
  const plot = data ? buildPlot(data, size.width, size.height, chartUp) : null;
  const lineColor = chartUp ? "var(--up)" : "var(--down)";
  const bars = kline?.candles ?? [];
  const lastBar = bars[bars.length - 1];
  const visibleCount = Math.max(
    Math.min(MIN_CANDLES, bars.length),
    Math.min(view.count || bars.length, bars.length),
  );

  // Human-readable span for the active brush, e.g. "08-03 → 09-12".
  const brushSpanLabel = React.useMemo(() => {
    if (!brush || bars.length === 0) return "";
    const plotW = Math.max(1, size.width - CANDLE_PAD.left - CANDLE_PAD.right);
    const current = Math.max(MIN_CANDLES, Math.min(view.count || bars.length, bars.length));
    const currentStart = Math.max(0, Math.min(view.start, bars.length - current));
    const toIndex = (px: number) => {
      const ratio = Math.min(1, Math.max(0, (px - CANDLE_PAD.left) / plotW));
      return currentStart + ratio * current;
    };
    const a = Math.max(0, Math.min(bars.length - 1, Math.round(toIndex(Math.min(brush.x0, brush.x1)))));
    const b = Math.max(0, Math.min(bars.length - 1, Math.round(toIndex(Math.max(brush.x0, brush.x1)))));
    const total = b - a + 1;
    const fmt = (t: string) => (t.length >= 10 ? t.slice(5) : t);
    return `${fmt(bars[a].time)} → ${fmt(bars[b].time)} · ${total}`;
  }, [brush, bars, size.width, view]);

  // React's onWheel is passive in some engines, so zoom + preventDefault are
  // wired directly with { passive: false }.
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (period === "intraday" || bars.length === 0) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(
        1,
        Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)),
      );
      // Relative step feels linear across scales; the floor is small enough that
      // every wheel notch lands on a new count instead of snapping to one end.
      const factor = event.deltaY > 0 ? 1.12 : 0.89;
      setView((v) => {
        const floor = Math.min(MIN_CANDLES, bars.length);
        const current = Math.max(floor, Math.min(v.count || bars.length, bars.length));
        const nextCount = Math.round(
          Math.max(floor, Math.min(bars.length, current * factor)),
        );
        if (nextCount === current) return v;
        const anchor = v.start + ratio * current;
        const start = Math.round(anchor - ratio * nextCount);
        return {
          count: nextCount,
          start: Math.max(0, Math.min(start, Math.max(0, bars.length - nextCount))),
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [period, bars.length]);


  // Reset the window whenever the series changes; zoom keeps the same slice size
  // across refreshes so a poll does not zoom the chart back out.
  React.useEffect(() => {
    if (bars.length === 0) return;
    // Keyed on the series length, not the payload object: a poll must not undo
    // the user's zoom.
    setView((v) => ({
      start: 0,
      count: v.count > 0 && v.count <= bars.length ? v.count : bars.length,
    }));
  }, [period, bars.length]);

  const stats = React.useMemo(() => {
    if (!data || data.points.length === 0) return null;
    const prices = data.points.map((p) => p.price);
    return {
      prevClose: data.prevClose,
      open: data.points[0].price,
      high: Math.max(...prices),
      low: Math.min(...prices),
      last: data.points[data.points.length - 1].price,
    };
  }, [data]);

  // 场外基金：只报净值和涨跌，没有分时/K 线可画。
  if (isFund) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-end justify-between gap-2 px-3 pb-1.5">
          <div className="flex flex-col gap-[2px]">
            <span className="eyebrow leading-none">{t("chart.title")}</span>
            <span className="num text-[9.5px] leading-none text-faint">
              {quote?.time ? shortStamp(quote.time) : t("chart.loading")}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                "num text-[17px] font-medium leading-none",
                rising ? "text-up" : "text-down",
              )}
            >
              {formatPrice(quote?.price, "fund")}
            </span>
            <span
              className={cn(
                "num text-[10.5px] leading-tight",
                rising ? "text-up" : "text-down",
              )}
            >
              {formatPercent(quote?.changePercent)}
            </span>
          </div>
        </div>
        <div className="mx-2 mb-2 flex flex-1 flex-col items-center justify-center gap-2 rounded-[6px] border border-hairline/70 bg-surface/45 px-6 text-center">
          <span className="text-[11px] text-muted-foreground">{t("chart.fundNote")}</span>
          <span className="text-[10px] text-faint">{t("chart.fundNoteHint")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-end justify-between gap-2 px-3 pb-1.5">
        <div className="flex flex-col gap-[2px]">
          <span className="eyebrow leading-none">{t("chart.title")}</span>
          <span className="num text-[9.5px] leading-none text-faint">
            {quote?.time ? shortStamp(quote.time) : t("chart.loading")}
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span
            className={cn(
              "num text-[17px] font-medium leading-none",
              rising ? "text-up" : "text-down",
            )}
          >
            {formatPrice(quote?.price)}
          </span>
          <span
            className={cn(
              "num text-[10.5px] leading-tight",
              rising ? "text-up" : "text-down",
            )}
          >
            {formatPercent(quote?.changePercent)}
          </span>
        </div>
      </div>

      <div className="mx-2 mb-1.5 flex items-center gap-0.5" role="radiogroup" aria-label={t("chart.granularity")}>
        {(["intraday", "day", "week", "month"] as const).map((key) => {
          const active = period === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setPeriod(key)}
              className={cn(
                "num rounded-[4px] px-1.5 py-[3px] text-[10px] transition-colors",
                active
                  ? "bg-surface text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.12)]"
                  : "text-faint hover:text-foreground",
              )}
            >
              {t(`chart.period.${key}`)}
            </button>
          );
        })}
        <span className="ledger-rule ml-1 flex-1 opacity-40" aria-hidden />
        {period !== "intraday" && lastBar ? (
          <span className="num flex items-center gap-1 text-[9px] text-faint">
            {visibleCount < bars.length ? (
              <span title={t("chart.zoomHint")}>
                {visibleCount}/{bars.length}
              </span>
            ) : (
              <span>{bars.length}</span>
            )}
            {t("chart.bars")}
          </span>
        ) : null}
      </div>

      <div
        ref={wrapRef}
        className="relative mx-2 flex-1 overflow-hidden rounded-[6px] border border-hairline/70 bg-surface/45"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          setHover({ x, y: event.clientY - rect.top });
          if (brushRef.current) {
            const next = { x0: brushRef.current.x0, x1: x };
            brushRef.current = next;
            setBrush(next);
          }
        }}
        onPointerLeave={() => {
          setHover(null);
          brushRef.current = null;
          setBrush(null);
        }}
        onPointerCancel={() => {
          setHover(null);
          brushRef.current = null;
          setBrush(null);
        }}
        onPointerDown={(event) => {
          if (period === "intraday" || bars.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          brushRef.current = { x0: x, x1: x };
          setBrush({ x0: x, x1: x });
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={() => {
          const selection = brushRef.current;
          brushRef.current = null;
          setBrush(null);
          if (!selection || period === "intraday" || bars.length === 0) return;
          const left = Math.min(selection.x0, selection.x1);
          const right = Math.max(selection.x0, selection.x1);
          // A tap (or a sliver) is not a zoom; it just leaves the view alone.
          if (right - left < 10) return;
          const plotW = Math.max(1, size.width - CANDLE_PAD.left - CANDLE_PAD.right);
          const current = Math.max(MIN_CANDLES, Math.min(view.count || bars.length, bars.length));
          const currentStart = Math.max(0, Math.min(view.start, bars.length - current));
          const toIndex = (px: number) => {
            const ratio = Math.min(1, Math.max(0, (px - CANDLE_PAD.left) / plotW));
            return currentStart + ratio * current;
          };
          const from = toIndex(left);
          const to = toIndex(right);
          const count = Math.max(MIN_CANDLES, Math.min(bars.length, Math.round(to - from)));
          const start = Math.max(0, Math.min(Math.round(from), bars.length - count));
          setView({ start, count });
        }}
        onDoubleClick={() => setView({ start: 0, count: bars.length })}
        style={{ touchAction: period === "intraday" ? undefined : "pan-y" }}
      >
        {period !== "intraday" ? (
          klineStatus === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[11px] text-faint">{t("chart.loading")}</span>
            </div>
          ) : klineStatus === "error" || bars.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="text-[11px] text-muted-foreground">
                {klineNote ?? t("chart.failed")}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPeriod(period === "day" ? "week" : "day")}
              >
                {t("action.retry")}
              </Button>
            </div>
          ) : (
            <CandleChart
              bars={bars}
              width={size.width}
              height={size.height}
              period={period}
              t={t}
              hover={brush ? null : hover}
              view={view}
            />
          )
        ) : status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[11px] text-faint">{t("chart.loading")}</span>
          </div>
        ) : status === "error" || !plot ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t("chart.failed")}
            </span>
            <Button variant="secondary" size="sm" onClick={load}>
              <RotateCw size={10} strokeWidth={2.2} />
              {t("action.retry")}
            </Button>
          </div>
        ) : (
          <ChartSvg
            data={data!}
            plot={plot}
            lineColor={lineColor}
            t={t}
            preferSession={settings?.usPriceMode ?? "session"}
            hover={hover}
          />
        )}

        {/* W&B-style brush: the shaded band is the region that becomes the new
            visible window on release. Drawn after the series so it reads as an
            overlay rather than part of the plot. */}
        {brush && Math.abs(brush.x1 - brush.x0) >= 1 ? (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 z-10 border-x border-dashed border-accent/70 bg-accent/12"
              style={{
                left: Math.min(brush.x0, brush.x1),
                width: Math.abs(brush.x1 - brush.x0),
              }}
              aria-hidden
            />
            {/* Clamped to the plot so the span chip never runs off an edge. */}
            <span
              className="num pointer-events-none absolute top-0 z-20 whitespace-nowrap rounded-b-[3px] bg-accent/90 px-1 py-[1px] text-[8.5px] leading-[12px] text-white"
              style={{ left: Math.max(0, Math.min(Math.min(brush.x0, brush.x1), size.width - 112)) }}
              aria-hidden
            >
              {brushSpanLabel}
            </span>
          </>
        ) : null}
      </div>

      <div className="mx-2 mb-1 flex items-start justify-between gap-1 px-1 pt-1.5">
        {period !== "intraday" && lastBar ? (
          <>
            <Stat label={t("chart.date")} value={lastBar.time.slice(5)} />
            <Stat label={t("chart.open")} value={formatPrice(lastBar.open)} />
            <Stat label={t("chart.high")} value={formatPrice(lastBar.high)} tone="up" />
            <Stat label={t("chart.low")} value={formatPrice(lastBar.low)} tone="down" />
            <Stat label={t("chart.close")} value={formatPrice(lastBar.close)} />
          </>
        ) : stats ? (
          <>
            <Stat label={t("chart.prevClose")} value={formatPrice(stats.prevClose)} />
            <Stat label={t("chart.open")} value={formatPrice(stats.open)} />
            <Stat label={t("chart.high")} value={formatPrice(stats.high)} tone="up" />
            <Stat label={t("chart.low")} value={formatPrice(stats.low)} tone="down" />
            <Stat label={t("chart.last")} value={formatPrice(stats.last)} />
          </>
        ) : (
          <div className="h-8 w-full" />
        )}
      </div>
      <p className="sr-only">
        {t("chart.announce", {
          name: stock.name,
          price: formatPrice(quote?.price),
          pct: formatPercent(quote?.changePercent),
        })}
      </p>
    </div>
  );
}

/** Strip the year from a quote timestamp: the panel never needs it and the
 *  full string wraps at 380px wide. */
function shortStamp(stamp: string): string {
  const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.*)$/);
  if (!match) return stamp;
  return `${match[2]}/${match[3]} ${match[4]}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <span className="text-[8.5px] uppercase tracking-[0.09em] text-faint">{label}</span>
      <span
        className={cn(
          "num text-[10.5px] font-medium leading-none",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function ChartSvg({
  data,
  plot,
  lineColor,
  t,
  preferSession,
  hover,
}: {
  data: ChartData;
  plot: Plot;
  lineColor: string;
  t: (key: string) => string;
  preferSession: string;
  hover: { x: number; y: number } | null;
}) {
  const lastPoint = data.points[data.points.length - 1];
  // Snap to the nearest sample so the readout is a real price, not an
  // interpolation between two minutes.
  const active = React.useMemo(() => {
    if (!hover) return null;
    const lastIndex = Math.max(data.axisLength - 1, 1);
    const innerW = plot.w - PAD.left - PAD.right;
    if (hover.x < PAD.left || hover.x > PAD.left + innerW) return null;
    const index = Math.round(((hover.x - PAD.left) / innerW) * lastIndex);
    let best: (typeof data.points)[number] | null = null;
    let bestDelta = Infinity;
    for (const point of data.points) {
      const delta = Math.abs(point.i - index);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = point;
      }
    }
    return best;
  }, [hover, data, plot.w]);
  const activeIndex = active?.i ?? null;
  const sessionLabels: Record<string, string> = {
    pre: t("chart.pre"),
    open: t("chart.openSession"),
    post: t("chart.post"),
  };
  return (
    <svg
      width={plot.w}
      height={plot.h}
      viewBox={`0 0 ${plot.w} ${plot.h}`}
      role="img"
      aria-label={t("chart.title")}
      className="block"
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id={`fill-${data.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {/* Session bands: US pre/open/post, softly tinted so the eye can find the bell. */}
      {data.sessions.map((session) => {
        const x0 = plot.x(session.start);
        const x1 = plot.x(session.end);
        const highlighted = preferSession !== "regular" && session.key !== "open";
        return (
          <g key={session.key}>
            <rect
              x={x0}
              y={PAD.top}
              width={Math.max(x1 - x0, 0)}
              height={plot.h - PAD.top - PAD.bottom}
              fill={
                session.key === "pre"
                  ? "var(--accent)"
                  : session.key === "post"
                    ? "var(--amber)"
                    : "transparent"
              }
              opacity={session.key === "open" ? 0 : highlighted ? 0.05 : 0.07}
            />
            <line
              x1={x1}
              x2={x1}
              y1={PAD.top}
              y2={plot.h - PAD.bottom}
              stroke="var(--hairline)"
              strokeDasharray="2 3"
              opacity="0.7"
            />
            <text
              x={(x0 + x1) / 2}
              y={PAD.top + 8}
              textAnchor="middle"
              fontSize="7.5"
              letterSpacing="0.08em"
              fill="var(--faint)"
              style={{ textTransform: "uppercase", fontWeight: 600 }}
            >
              {sessionLabels[session.key] ?? session.label}
            </text>
          </g>
        );
      })}

      {/* Horizontal grid + price labels on the right, the way a printed table
          puts its scale outside the plotting area. */}
      {plot.ticks.map((tick) => (
        <g key={tick.price}>
          <line
            x1={PAD.left}
            x2={plot.w - PAD.right}
            y1={tick.y}
            y2={tick.y}
            stroke="var(--hairline)"
            strokeDasharray="1 3"
            opacity="0.55"
          />
          <text
            x={plot.w - PAD.right + 5}
            y={tick.y + 2.5}
            fontSize="7.5"
            fill="var(--faint)"
            fontFamily="var(--font-mono)"
          >
            {tick.label}
          </text>
        </g>
      ))}

      {data.prevClose > 0 ? (
        <line
          x1={PAD.left}
          x2={plot.w - PAD.right}
          y1={plot.y(data.prevClose)}
          y2={plot.y(data.prevClose)}
          stroke="var(--muted-foreground)"
          strokeDasharray="4 3"
          strokeWidth="0.8"
          opacity="0.6"
        />
      ) : null}

      <path d={plot.area} fill={`url(#fill-${data.id})`} />
      <path
        d={plot.path}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.35"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* Live head: a filled dot with a soft halo where the series ends. */}
      <circle
        cx={plot.x(lastPoint.i)}
        cy={plot.y(lastPoint.price)}
        r="5"
        fill={lineColor}
        opacity="0.14"
      />
      <circle
        cx={plot.x(lastPoint.i)}
        cy={plot.y(lastPoint.price)}
        r="1.9"
        fill={lineColor}
        stroke="var(--panel)"
        strokeWidth="1"
      />

      {/* Hover crosshair: a vertical rule, a dot on the series, and a readout
          pinned away from the edges so it never leaves the plot. */}
      {active && activeIndex != null ? (
        <g pointerEvents="none">
          <line
            x1={plot.x(activeIndex)}
            x2={plot.x(activeIndex)}
            y1={PAD.top}
            y2={plot.h - PAD.bottom}
            stroke="var(--muted-foreground)"
            strokeWidth="0.8"
            strokeDasharray="2 2"
            opacity="0.75"
          />
          <line
            x1={PAD.left}
            x2={plot.w - PAD.right}
            y1={plot.y(active.price)}
            y2={plot.y(active.price)}
            stroke="var(--muted-foreground)"
            strokeWidth="0.8"
            strokeDasharray="2 2"
            opacity="0.35"
          />
          <circle
            cx={plot.x(activeIndex)}
            cy={plot.y(active.price)}
            r="2.6"
            fill="var(--panel)"
            stroke={lineColor}
            strokeWidth="1.6"
          />
          <HoverBadge
            x={plot.x(activeIndex)}
            y={plot.y(active.price)}
            width={plot.w}
            time={active.time}
            price={active.price}
            prevClose={data.prevClose}
          />
        </g>
      ) : null}

      {/* Time axis */}
      {data.labels.map((label) => {
        const lx = plot.x(label.i);
        const anchor =
          label.i === 0 ? "start" : label.i >= data.axisLength - 1 ? "end" : "middle";
        return (
          <text
            key={`${label.i}-${label.label}`}
            x={lx}
            y={plot.h - 5}
            textAnchor={anchor}
            fontSize="7.5"
            fill="var(--faint)"
            fontFamily="var(--font-mono)"
            letterSpacing="-0.02em"
          >
            {label.label}
          </text>
        );
      })}

    </svg>
  );
}

/** Candlesticks with a shared y-axis and a light volume gutter. At 380px the
 *  body width has to stay above 2px or the chart reads as noise, so the whole
 *  series is compressed rather than scrolled. */
/** Floating readout for a hovered point. Flips sides near the right edge so it
 *  does not get clipped by the plot bounds. */
function HoverBadge({
  x,
  y,
  width,
  time,
  price,
  prevClose,
}: {
  x: number;
  y: number;
  width: number;
  time: string;
  price: number;
  prevClose: number;
}) {
  const pct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null;
  const tone = pct == null ? "var(--foreground)" : pct >= 0 ? "var(--up)" : "var(--down)";
  const flip = x > width - 104;
  const boxW = 92;
  const boxH = 32;
  const bx = flip ? x - boxW - 8 : x + 8;
  const by = Math.min(Math.max(y - boxH - 8, 4), 240);
  return (
    <g pointerEvents="none">
      <rect
        x={bx}
        y={by}
        width={boxW}
        height={boxH}
        rx="4"
        fill="var(--panel)"
        stroke="var(--border)"
        strokeWidth="0.8"
      />
      <rect x={bx} y={by} width={boxW} height={boxH} rx="4" fill="var(--panel)" />
      {/* Time on its own line: with the price beside it the two ran into each
          other at this width. */}
      <text
        x={bx + 6}
        y={by + 10}
        fontSize="7.5"
        fill="var(--faint)"
        fontFamily="var(--font-mono)"
        letterSpacing="0.02em"
      >
        {time}
      </text>
      <text
        x={bx + 6}
        y={by + 23}
        fontSize="10"
        fill={tone}
        fontFamily="var(--font-mono)"
        fontWeight="500"
      >
        {formatPrice(price)}
      </text>
      <text
        x={bx + boxW - 6}
        y={by + 23}
        textAnchor="end"
        fontSize="8"
        fill={tone}
        fontFamily="var(--font-mono)"
      >
        {pct == null ? "" : formatPercent(pct)}
      </text>
    </g>
  );
}

/** OHLC readout for a hovered candle. */
function CandleBadge({
  x,
  width,
  bar,
  period,
  t,
}: {
  x: number;
  width: number;
  bar: Candle;
  period: Period;
  t: (key: string) => string;
}) {
  const up = bar.close >= bar.open;
  const tone = up ? "var(--up)" : "var(--down)";
  const stamp = period === "day" ? bar.time.slice(5) : bar.time.slice(0, 7);
  const rows: [string, string][] = [
    // "今开" reads as today's open, which is wrong for an arbitrary bar.
    [t("chart.openCandle"), formatPrice(bar.open)],
    [t("chart.high"), formatPrice(bar.high)],
    [t("chart.low"), formatPrice(bar.low)],
    [t("chart.close"), formatPrice(bar.close)],
  ];
  // Derive the box from its content: a fixed height clipped the last row.
  const HEADER = 13;
  const ROW = 10;
  const PAD_BOTTOM = 5;
  const boxW = 132;
  const boxH = HEADER + rows.length * ROW + PAD_BOTTOM;
  const flip = x > width - boxW - 8;
  const bx = flip ? x - boxW - 8 : x + 8;
  // Always at the top of the plot so it never covers the candles it describes.
  const by = 4;
  return (
    <g pointerEvents="none">
      <rect
        x={bx}
        y={by}
        width={boxW}
        height={boxH}
        rx="4"
        fill="var(--panel)"
        stroke="var(--border)"
        strokeWidth="0.8"
      />
      <rect x={bx} y={by} width={boxW} height={boxH} rx="4" fill="var(--panel)" />
      <text x={bx + 6} y={by + 11} fontSize="8" fill="var(--faint)" fontFamily="var(--font-mono)">
        {stamp}
      </text>
      <text
        x={bx + boxW - 6}
        y={by + 11}
        textAnchor="end"
        fontSize="8.5"
        fill={tone}
        fontFamily="var(--font-mono)"
      >
        {formatPrice(bar.close)}
      </text>
      {rows.map(([label, value], i) => (
        <g key={label}>
          <text
            x={bx + 6}
            y={by + HEADER + 8 + i * ROW}
            fontSize="7.5"
            fill="var(--faint)"
          >
            {label}
          </text>
          <text
            x={bx + boxW - 6}
            y={by + HEADER + 8 + i * ROW}
            textAnchor="end"
            fontSize="8"
            fill="var(--foreground)"
            fontFamily="var(--font-mono)"
          >
            {value}
          </text>
        </g>
      ))}
    </g>
  );
}

function CandleChart({
  bars,
  width,
  height,
  period,
  t,
  hover,
  view,
}: {
  bars: Candle[];
  width: number;
  height: number;
  period: Period;
  t: (key: string) => string;
  hover: { x: number; y: number } | null;
  view: { start: number; count: number };
}) {
  const PADL = CANDLE_PAD.left;
  const PADR = CANDLE_PAD.right;
  const PADT = 10;
  const PADB = 16;
  const VOL = 26;
  const plotH = height - PADT - PADB - VOL;
  const innerW = width - PADL - PADR;
  const n = bars.length;

  // The parent owns the zoom window; clamp it here so a stale value can never
  // index past the series.
  const minCount = Math.min(MIN_CANDLES, n);
  const count = Math.max(minCount, Math.min(view.count || n, n));
  const start = Math.max(0, Math.min(view.start, n - count));
  const visible = bars.slice(start, start + count);

  const highs = visible.map((b) => b.high);
  const lows = visible.map((b) => b.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = Math.max(max - min, max * 0.01);
  const top = max + span * 0.06;
  const bottom = min - span * 0.06;
  const slot = innerW / Math.max(visible.length, 1);
  const bodyW = Math.max(1, Math.min(9, slot * 0.62));
  const y = (price: number) => PADT + (1 - (price - bottom) / (top - bottom)) * plotH;
  const ticks = Array.from({ length: 4 }, (_, i) => {
    const price = top - ((top - bottom) * i) / 3;
    return { price, y: y(price), label: formatPrice(price) };
  });
  const labelEvery = Math.max(1, Math.floor(visible.length / 4));
  const locale = period === "day" ? "day" : period === "week" ? "week" : "month";
  // Snap the crosshair to a bar so the readout is an actual OHLC row.
  const activeIndex =
    hover && hover.x >= PADL && hover.x <= width - PADR && visible.length > 0
      ? Math.min(visible.length - 1, Math.max(0, Math.round((hover.x - PADL) / slot - 0.5)))
      : null;
  const activeBar = activeIndex != null ? visible[activeIndex] : null;
  const maxVol = Math.max(...visible.map((b) => b.volume), 1);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${t("chart.title")} ${t(`chart.period.${locale}`)}`}
      className="block"
    >
      {ticks.map((tick) => (
        <g key={tick.price}>
          <line
            x1={PADL}
            x2={width - PADR}
            y1={tick.y}
            y2={tick.y}
            stroke="var(--hairline)"
            strokeDasharray="1 3"
            opacity="0.5"
          />
          <text
            x={width - PADR + 5}
            y={tick.y + 2.5}
            fontSize="7.5"
            fill="var(--faint)"
            fontFamily="var(--font-mono)"
          >
            {tick.label}
          </text>
        </g>
      ))}

      <g>
        {visible.map((bar, i) => {
          const x = PADL + slot * i + slot / 2;
          const up = bar.close >= bar.open;
          const color = up ? "var(--up)" : "var(--down)";
          const yOpen = y(bar.open);
          const yClose = y(bar.close);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(1, Math.abs(yClose - yOpen));
          const volH = Math.max(0.6, (bar.volume / maxVol) * VOL * 0.8);
          return (
            <g key={bar.time}>
              <line
                x1={x}
                x2={x}
                y1={y(bar.high)}
                y2={y(bar.low)}
                stroke={color}
                strokeWidth="0.9"
                opacity="0.85"
              />
              <rect
                x={x - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyH}
                fill={up ? "transparent" : color}
                stroke={color}
                strokeWidth="0.9"
              />
              <rect
                x={x - bodyW / 2}
                y={height - PADB - volH}
                width={bodyW}
                height={volH}
                fill={color}
                opacity="0.22"
              />
            </g>
          );
        })}
      </g>

      {activeBar && activeIndex != null ? (
        <g pointerEvents="none">
          <line
            x1={PADL + slot * activeIndex + slot / 2}
            x2={PADL + slot * activeIndex + slot / 2}
            y1={PADT}
            y2={height - PADB}
            stroke="var(--muted-foreground)"
            strokeWidth="0.8"
            strokeDasharray="2 2"
            opacity="0.7"
          />
          <rect
            x={PADL + slot * activeIndex + slot / 2 - bodyW / 2 - 0.5}
            y={Math.min(y(activeBar.open), y(activeBar.close)) - 0.5}
            width={bodyW + 1}
            height={Math.max(1.5, Math.abs(y(activeBar.close) - y(activeBar.open))) + 1}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth="0.7"
            opacity="0.5"
          />
          <CandleBadge
            x={PADL + slot * activeIndex + slot / 2}
            width={width}
            bar={activeBar}
            period={period}
            t={t}
          />
        </g>
      ) : null}

      {/* Date axis: four evenly spaced labels is the most that fits legibly. */}
      {visible.map((bar, i) => {
        const last = visible.length - 1;
        if (i % labelEvery !== 0 && i !== last) return null;
        if (i === last && i % labelEvery < labelEvery * 0.4) return null;
        const x = PADL + slot * i + slot / 2;
        const anchor = i === 0 ? "start" : i >= visible.length - 1 ? "end" : "middle";
        const label = period === "day" ? bar.time.slice(5) : bar.time.slice(0, 7);
        return (
          <text
            key={`label-${bar.time}`}
            x={x}
            y={height - 4}
            textAnchor={anchor}
            fontSize="7.5"
            fill="var(--faint)"
            fontFamily="var(--font-mono)"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}
