import * as React from "react";
import { useStore } from "@/store/app-store";
import { cn } from "@/lib/utils";
import {
  formatPercent,
  formatPrice,
  sortableChange,
  sessionTone,
} from "@/lib/format";
import type { Market, Stock } from "@/lib/types";
import { MARKET_ORDER } from "@/lib/types";
import { Bell, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Tooltip } from "@/components/ui/tooltip";

interface Group {
  key: string;
  label: string;
  stocks: Stock[];
  market: Market;
}

export function StockList({
  onSelect,
  onMove,
  onAdd,
}: {
  onSelect: (stock: Stock) => void;
  onMove?: (id: string, direction: -1 | 1) => void;
  onAdd?: () => void;
}) {
  const { t, loading, stocks, settings, quotes, mergedPosition } = useStore();
  const reduce = useReducedMotion();
  const sortRule = settings?.sortRule ?? "changeDesc";
  const usMode = settings?.usPriceMode ?? "session";
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  const groups = React.useMemo(() => {
    const base = useGroupsRaw(stocks, settings?.groupHoldings ?? false, mergedPosition);
    if (sortRule === "manual") return base;
    const dir = sortRule === "changeDesc" ? -1 : 1;
    return base.map((g) => ({
      ...g,
      stocks: [...g.stocks].sort(
        (a, b) =>
          dir *
          (sortableChange(quotes[b.id], b.market, usMode) -
            sortableChange(quotes[a.id], a.market, usMode)),
      ),
    }));
  }, [stocks, settings?.groupHoldings, sortRule, quotes, usMode, mergedPosition]);

  if (loading && stocks.length === 0) {
    return <ListSkeleton />;
  }

  if (stocks.length === 0) {
    return <EmptyList onAdd={onAdd} />;
  }

  return (
    <div
      className="scroll-area flex-1 px-2 pb-1"
      role="list"
      onKeyDown={(event) => handleListKey(event)}
    >
      {groups.map((group) => {
        const isCollapsed = collapsed[group.key] ?? false;
        return (
          <section key={group.key} className="mb-1.5 last:mb-0">
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [group.key]: !isCollapsed }))
              }
              aria-expanded={!isCollapsed}
              className="group/h flex w-full items-center gap-1.5 rounded-[4px] px-1 py-[5px] text-left transition-colors hover:bg-surface/60"
            >
              <ChevronDown
                size={10}
                strokeWidth={2.6}
                className={cn(
                  "text-faint transition-transform duration-200",
                  isCollapsed && "-rotate-90",
                )}
              />
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t(group.label)}
              </span>
              <span className="num text-[9.5px] text-faint">{group.stocks.length}</span>
              <span className="ledger-rule ml-1 flex-1 opacity-50" aria-hidden />
              {group.key === "holdings" ? null : <SessionChip market={group.market} />}
            </button>

            <AnimatePresence initial={false}>
              {!isCollapsed ? (
                <motion.div
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.2, 0.7, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-[2px] pt-[2px]">
                    {group.stocks.map((stock, index) => (
                      <StockRow
                        key={stock.id}
                        stock={stock}
                        onSelect={onSelect}
                        manual={sortRule === "manual"}
                        canUp={index > 0}
                        canDown={index < group.stocks.length - 1}
                        onMove={onMove}
                        isFirst={group === groups[0] && index === 0}
                      />
                    ))}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </section>
        );
      })}
    </div>
  );
}

/** Grouping without sorting; the sort lives in the component so changing the
 *  rule does not recompute the holding split. */
function useGroupsRaw(
  stocks: Stock[],
  groupHoldings: boolean,
  merged: (stock: Stock) => { shares: number; costPrice: number } | null,
): Group[] {
  const holdings = groupHoldings ? stocks.filter((s) => merged(s) != null) : [];
  const holdingIds = new Set(holdings.map((s) => s.id));
  const groups: Group[] = [];
  if (holdings.length > 0) {
    groups.push({ key: "holdings", label: "market.holdings", stocks: holdings, market: "a" });
  }
  for (const market of MARKET_ORDER) {
    const list = stocks.filter(
      (s) => s.market === market && !(groupHoldings && holdingIds.has(s.id)),
    );
    if (list.length === 0) continue;
    groups.push({ key: market, label: `market.${market}`, stocks: list, market });
  }
  return groups;
}

/** Roving focus: arrow keys walk the visible quote rows, PageUp/PageDown jump a
 *  screen, Home/End go to the ends. Space on a group header toggles it. */
function handleListKey(event: React.KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="listitem"]'),
  );
  if (rows.length === 0) return;

  if (event.key === " " && target.getAttribute("aria-expanded") != null) {
    event.preventDefault();
    target.click();
    return;
  }

  if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) return;
  event.preventDefault();
  const active = document.activeElement as HTMLElement | null;
  const index = active ? rows.indexOf(active) : -1;
  let next = index;
  if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(rows.length - 1, index + 1);
  if (event.key === "ArrowUp") next = index < 0 ? 0 : Math.max(0, index - 1);
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = rows.length - 1;
  if (event.key === "PageDown") next = index < 0 ? 0 : Math.min(rows.length - 1, index + 6);
  if (event.key === "PageUp") next = index < 0 ? 0 : Math.max(0, index - 6);
  rows[next]?.focus();
  rows[next]?.scrollIntoView({ block: "nearest" });
}

/** Tooltip body for a merged row: every account's lot and its share of the
 *  total, so the average cost is auditable at a glance. */
function LotBreakdown({
  lots,
}: {
  lots: { account: { name: string }; position: { costPrice: number; shares: number }; weight: number }[];
}) {
  return (
    <span className="flex flex-col gap-1 py-0.5">
      {lots.map((lot) => (
        <span key={lot.account.name} className="flex items-baseline justify-between gap-3">
          <span className="max-w-[96px] truncate text-[10px]">{lot.account.name}</span>
          <span className="num text-[10px] tabular-nums text-muted-foreground">
            {formatPrice(lot.position.costPrice)} × {lot.position.shares}
          </span>
          <span className="num w-8 text-right text-[9.5px] text-faint">
            {Math.round(lot.weight * 100)}%
          </span>
        </span>
      ))}
    </span>
  );
}

function SessionChip({ market }: { market: Market }) {
  const { t, sessions } = useStore();
  const session = sessions?.[market];
  const tone = sessionTone(session);
  if (!session) return null;
  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(
          "size-[4px] rounded-full",
          tone === "live" && "bg-up live-dot",
          tone === "warm" && "bg-amber",
          tone === "idle" && "bg-faint/60",
        )}
      />
      <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-faint">
        {t(`session.${session}`)}
      </span>
    </span>
  );
}

function StockRow({
  stock,
  onSelect,
  manual,
  canUp,
  canDown,
  onMove,
  isFirst,
}: {
  stock: Stock;
  onSelect: (stock: Stock) => void;
  manual?: boolean;
  canUp?: boolean;
  canDown?: boolean;
  onMove?: (id: string, direction: -1 | 1) => void;
  isFirst?: boolean;
}) {
  const { quotes, pnl, t, lang, settings, mergedPosition, lots } = useStore();
  const quote = quotes[stock.id];
  const position = pnl(stock);
  const percentOnly = settings?.pnlDisplay === "percent";
  const merged = mergedPosition(stock);
  const lotsForStock = lots(stock);
  const market = stock.market;
  const priceUp = (quote?.change ?? 0) > 0;
  const priceDown = (quote?.change ?? 0) < 0;

  // A refresh replaces every quote object, so only a real price move should
  // flash. The highlight lives on the price text, never on the row: washing the
  // whole row made the list look like it was blinking on every poll.
  const flashSetting = settings?.flashDuration ?? "normal";
  const flashMs =
    flashSetting === "off" ? 0 : flashSetting === "short" ? 380 : flashSetting === "long" ? 1100 : 620;
  const [flash, setFlash] = React.useState<"up" | "down" | null>(null);
  const prevPrice = React.useRef<number | undefined>(quote?.price);
  React.useEffect(() => {
    if (quote == null || flashMs === 0) {
      prevPrice.current = quote?.price;
      return;
    }
    const previous = prevPrice.current;
    prevPrice.current = quote.price;
    // Ignore sub-tick noise: many feeds jitter in the last decimal.
    if (previous == null || Math.abs(quote.price - previous) < 1e-9) return;
    setFlash(quote.price > previous ? "up" : "down");
    const timer = window.setTimeout(() => setFlash(null), flashMs);
    return () => window.clearTimeout(timer);
  }, [quote?.price, quote, flashMs]);

  const extended = quote?.extendedPrice;
  const extPositive = (quote?.extendedChangePercent ?? 0) >= 0;

  return (
    <div
      role="listitem"
      className={cn(
        "group relative flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[6px] transition-colors duration-150",
        "hover:bg-surface/85",
      )}
      onClick={() => onSelect(stock)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSelect(stock);
        }
      }}
      tabIndex={isFirst ? 0 : -1}
      aria-label={`${stock.name} ${formatPrice(quote?.price, stock.market)} ${formatPercent(quote?.changePercent)}`}
    >
      {manual ? (
        <div className="flex shrink-0 flex-col gap-[1px] opacity-40 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label={t("action.moveUp")}
            disabled={!canUp}
            onClick={(event) => {
              event.stopPropagation();
              onMove?.(stock.id, -1);
            }}
            className="flex h-[9px] w-3 items-center justify-center text-faint hover:text-foreground disabled:opacity-20"
          >
            <ChevronUp size={8} strokeWidth={2.6} />
          </button>
          <button
            type="button"
            aria-label={t("action.moveDown")}
            disabled={!canDown}
            onClick={(event) => {
              event.stopPropagation();
              onMove?.(stock.id, 1);
            }}
            className="flex h-[9px] w-3 items-center justify-center text-faint hover:text-foreground disabled:opacity-20"
          >
            <ChevronDown size={8} strokeWidth={2.6} />
          </button>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate text-[12.5px] font-medium leading-none tracking-[-0.005em]">
          {stock.name || stock.code}
        </span>
        <div className="flex items-center gap-1.5 leading-none">
          <span className="num text-[9.5px] uppercase tracking-[0.03em] text-faint">
            {displayCode(stock)}
          </span>
          {stock.alert?.enabled ? (
            <Tooltip content={alertText(stock, t)} side="top" align="start">
              <span
                className="flex items-center gap-0.5 text-[9px] text-amber"
                aria-label={t("row.alertOn")}
              >
                <Bell size={8} strokeWidth={2.4} className="fill-current" />
                <span className="num">{formatPrice(stock.alert.targetPrice)}</span>
              </span>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-[2px]">
        <div className="flex items-baseline gap-1.5 leading-none">
          <span
            className={cn(
              "num -mx-1 rounded-[3px] px-1 text-[13px] font-medium",
              priceUp && "text-up",
              priceDown && "text-down",
              flash === "up" && "tick-flash-up",
              flash === "down" && "tick-flash-down",
            )}
          >
            {formatPrice(quote?.price, stock.market)}
          </span>
          <span
            className={cn(
              "num w-[46px] text-right text-[10.5px]",
              priceUp && "text-up",
              priceDown && "text-down",
              !priceUp && !priceDown && "text-faint",
            )}
          >
            {formatPercent(quote?.changePercent)}
          </span>
        </div>

        {extended != null ? (
          <div className="flex items-baseline gap-1 leading-none">
            <span className="text-[8.5px] uppercase tracking-[0.06em] text-faint">
              {t(`session.${quote?.extendedLabel ?? "post"}`)}
            </span>
            <span
              className={cn(
                "num text-[9.5px]",
                extPositive ? "text-up" : "text-down",
              )}
            >
              {formatPrice(extended)} {formatPercent(quote?.extendedChangePercent)}
            </span>
          </div>
        ) : merged == null ? (
          <span className="text-[9px] leading-none text-faint">{t("row.unpositioned")}</span>
        ) : lotsForStock.length > 1 ? (
          <Tooltip content={<LotBreakdown lots={lotsForStock} />} side="left">
            <span className="flex items-baseline gap-1 text-[9px] leading-none text-faint">
              <span>{t("row.merged")}</span>
              <span className="num">{lotsForStock.length}</span>
            </span>
          </Tooltip>
        ) : null}

        {position ? (
          percentOnly ? (
            <div className="flex items-baseline gap-1.5 leading-none">
              <span
                className={cn(
                  "num text-[9.5px]",
                  position.dailyPercent >= 0 ? "text-up" : "text-down",
                )}
              >
                {t("row.day")}
                {formatPercent(position.dailyPercent)}
              </span>
              <span
                className={cn(
                  "num text-[9.5px]",
                  position.totalPercent >= 0 ? "text-up" : "text-down",
                )}
              >
                {t("row.float")}
                {formatPercent(position.totalPercent)}
              </span>
            </div>
          ) : (
            <div className="flex items-baseline gap-1.5 leading-none">
              <span
                className={cn(
                  "num text-[9.5px]",
                  position.daily >= 0 ? "text-up" : "text-down",
                )}
              >
                {t("row.day")}
                {signedMoney(position.daily, lang)}
              </span>
              <span
                className={cn(
                  "num text-[9.5px]",
                  position.total >= 0 ? "text-up" : "text-down",
                )}
              >
                {t("row.float")}
                {signedMoney(position.total, lang)}
              </span>
            </div>
          )
        ) : null}
      </div>
      <span className="sr-only">
        {market === "us" && settings?.usPriceMode === "regular"
          ? t("settings.usPrice.regular")
          : undefined}
      </span>
    </div>
  );
}

function signedMoney(value: number, lang: string): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : 2;
  const locale = lang === "en" ? "en-US" : "zh-CN";
  return `${value >= 0 ? "+" : "-"}${abs.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function displayCode(stock: Stock): string {
  if (stock.market === "us") return stock.code.toUpperCase();
  return stock.code;
}

function alertText(stock: Stock, t: (k: string) => string): string {
  const alert = stock.alert;
  if (!alert) return "";
  const dir = alert.direction === "fall" ? t("alert.direction.fall") : t("alert.direction.rise");
  return `${dir} ${formatPrice(alert.targetPrice)}`;
}

function EmptyList({ onAdd }: { onAdd?: () => void }) {
  const { t } = useStore();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="relative mb-1 flex size-12 items-center justify-center rounded-full border border-dashed border-hairline">
        <span className="text-[15px] text-faint" aria-hidden>
          ⊙
        </span>
      </div>
      <h2 className="text-[13px] font-semibold">{t("list.empty.title")}</h2>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("list.empty.body")}</p>
      <Button variant="ghost" size="sm" className="mt-1 text-[11px] text-accent" onClick={onAdd}>
        {t("list.empty.cta")} <span aria-hidden>→</span>
      </Button>
    </div>
  );
}

function ListSkeleton() {
  const { t } = useStore();
  return (
    <div className="flex flex-1 flex-col gap-2 px-3 py-2" aria-busy="true" aria-label={t("list.loading")}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <div
              className="h-[9px] rounded-[2px] bg-surface-strong/80"
              style={{ width: `${64 + ((i * 13) % 40)}px` }}
            />
            <div className="h-[7px] w-12 rounded-[2px] bg-surface/80" />
          </div>
          <div className="h-[9px] w-16 rounded-[2px] bg-surface-strong/70" />
        </div>
      ))}
    </div>
  );
}
