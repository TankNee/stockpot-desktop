import * as React from "react";
import { useStore } from "@/store/app-store";
import type { SearchResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatPercent, formatPrice } from "@/lib/format";
import { Check, Loader2, Plus, Search as SearchIcon, X } from "lucide-react";

const marketLabel: Record<string, string> = {
  a: "market.a",
  hk: "market.hk",
  us: "market.us",
  kr: "market.kr",
};

/** Symbol lookup. Results are rows you click to add; anything already on the
 *  watchlist says so instead of silently disabling the row. */
export function SearchView({
  onDone,
  autoFocus = true,
}: {
  onDone: () => void;
  autoFocus?: boolean;
}) {
  const { t, search, searching, addStock, stocks, quotes, pushToast, previewQuotes } = useStore();
  const [keyword, setKeyword] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [touched, setTouched] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [adding, setAdding] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const requestId = React.useRef(0);

  React.useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  React.useEffect(() => {
    const term = keyword.trim();
    if (term.length === 0) {
      setResults([]);
      setTouched(false);
      setFailed(false);
      return;
    }
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      search(term)
        .then((found) => {
          if (id !== requestId.current) return;
          setResults(found);
          setFailed(false);
          setTouched(true);
          // Give the rows a price where the feed allows it; failure is silent.
          void previewQuotes(found.slice(0, 30).map((r) => r.id));
        })
        .catch(() => {
          if (id !== requestId.current) return;
          setResults([]);
          setFailed(true);
          setTouched(true);
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [keyword, search]);

  const addedIds = React.useMemo(() => new Set(stocks.map((s) => s.id)), [stocks]);

  const onPick = async (result: SearchResult) => {
    if (addedIds.has(result.id)) {
      pushToast(t("toast.exists", { name: result.name }));
      return;
    }
    setAdding(result.id);
    try {
      await addStock(result);
    } finally {
      setAdding(null);
    }
  };

  const runSearch = () => {
    const term = keyword.trim();
    if (!term) return;
    setTouched(false);
    search(term)
      .then((found) => {
        setResults(found);
        setTouched(true);
      })
      .catch(() => {
        setFailed(true);
        setTouched(true);
      });
  };

  const hasQuery = keyword.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-3.5 pb-2 pt-3.5">
        <div className="relative">
          <SearchIcon
            size={12}
            strokeWidth={2.2}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (results.length > 0 && touched) void onPick(results[0]);
                else runSearch();
              }
              if (e.key === "Escape") onDone();
            }}
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
            spellCheck={false}
            autoComplete="off"
            className="num h-8 w-full rounded-[5px] border border-hairline bg-panel pl-8 pr-8 text-[12.5px] text-foreground placeholder:font-sans placeholder:text-faint focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-[color-mix(in_oklch,var(--accent)_40%,transparent)]"
          />
          {hasQuery ? (
            <button
              type="button"
              onClick={() => {
                setKeyword("");
                inputRef.current?.focus();
              }}
              aria-label={t("action.clear")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint transition-colors hover:text-foreground"
            >
              <X size={11} strokeWidth={2.4} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="scroll-area h-full overflow-y-auto px-2.5 pb-6">
        {searching && results.length === 0 ? (
          <div className="flex flex-col gap-1 px-1 py-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between rounded-[5px] px-2 py-2">
                <div className="flex flex-col gap-1.5">
                  <div className="h-[9px] w-24 rounded-[2px] bg-surface-strong/70" />
                  <div className="h-[7px] w-16 rounded-[2px] bg-surface/80" />
                </div>
                <div className="h-[9px] w-10 rounded-[2px] bg-surface/70" />
              </div>
            ))}
          </div>
        ) : failed ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <span className="text-[11.5px] font-medium">{t("search.offline")}</span>
            <Button variant="ghost" size="sm" className="text-[10.5px]" onClick={runSearch}>
              {t("action.retry")}
            </Button>
          </div>
        ) : touched && results.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <span className="text-[11.5px] font-medium text-foreground">{t("search.empty")}</span>
            <p className="text-[10.5px] leading-relaxed text-faint">
              {t("search.emptyHint", { query: keyword.trim() })}
            </p>
          </div>
        ) : touched ? (
          <div className="flex flex-col">
            <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
              <span className="eyebrow">{t("search.matches")}</span>
              <span className="num text-[9.5px] text-faint">
                {t("search.results", { n: results.length })}
              </span>
            </div>
            <div className="flex flex-col gap-[1px] pb-1">
              {results.map((result) => {
                const added = addedIds.has(result.id);
                const busy = adding === result.id;
                const q = quotes[result.id];
                return (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => void onPick(result)}
                    aria-label={
                      added
                        ? `${result.name} ${t("search.added")}`
                        : `${t("action.add")} ${result.name}`
                    }
                    aria-busy={busy}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors",
                      added
                        ? "cursor-default opacity-55"
                        : "hover:bg-surface/80 active:bg-surface-strong/60",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-[12px] font-medium leading-tight text-foreground">
                          {result.name}
                        </span>
                        <span className="num shrink-0 text-[9px] uppercase tracking-[0.03em] text-faint">
                          {result.code}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 leading-none">
                        <span className="text-[9px] font-medium uppercase tracking-[0.09em] text-accent">
                          {t(marketLabel[result.market] ?? "market.a")}
                        </span>
                        {q ? (
                          <span className="flex items-baseline gap-1">
                            <span className="num text-[9.5px] text-muted-foreground">
                              {formatPrice(q.price)}
                            </span>
                            <span
                              className={cn(
                                "num text-[9px]",
                                q.changePercent >= 0 ? "text-up" : "text-down",
                              )}
                            >
                              {formatPercent(q.changePercent)}
                            </span>
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {busy ? (
                      <Loader2 size={11} className="shrink-0 animate-spin text-faint" />
                    ) : added ? (
                      <span className="flex shrink-0 items-center gap-0.5 text-[9px] text-faint">
                        <Check size={9} strokeWidth={2.8} />
                        {t("search.added")}
                      </span>
                    ) : (
                      <Plus
                        size={11}
                        strokeWidth={2.4}
                        className="shrink-0 text-faint transition-colors group-hover:text-accent"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-2 py-3">
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">{t("search.quickPicks")}</span>
              <div className="flex flex-wrap gap-1">
                {["600519", "00700", "AAPL", "NVDA", "005930"].map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    onClick={() => setKeyword(hint)}
                    className="num rounded-[4px] border border-hairline bg-panel px-1.5 py-[3px] text-[10px] text-muted-foreground transition-colors hover:border-accent/50 hover:text-foreground"
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
              <span className="eyebrow">{t("search.marketsTitle")}</span>
              <p className="text-[10.5px] leading-relaxed text-faint">{t("search.marketsBody")}</p>
            </div>
          </div>
        )}
      </div>

        {/* Fade hints that the list continues past the fold. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-panel to-transparent"
        />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3.5 py-2">
        <span className="flex items-center gap-1 text-[9.5px] text-faint">
          <kbd className="rounded-[3px] border border-hairline bg-surface px-1 font-mono text-[8.5px] leading-[13px]">
            ↵
          </kbd>
          {t("search.enterHint")}
        </span>
        <Button variant="ghost" size="sm" className="text-[10.5px]" onClick={onDone}>
          {t("action.done")}
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {touched ? t("search.results", { n: results.length }) : ""}
      </span>
    </div>
  );
}
