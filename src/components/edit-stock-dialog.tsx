import * as React from "react";
import { useStore } from "@/store/app-store";
import type { Stock } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMoney, formatPercent, formatPrice } from "@/lib/format";
import { Bell, BellOff, Trash2 } from "lucide-react";

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return value;
}

export function EditStockDialog({
  stock,
  open,
  onOpenChange,
}: {
  stock: Stock | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    t,
    lang,
    quotes,
    accounts,
    mergedPosition,
    setPosition,
    updateAlert,
    removeStock,
    settings,
    requestNotifications,
  } = useStore();
  const quote = stock ? quotes[stock.id] : undefined;

  // One editable row per account; drafts are keyed by account id so saving one
  // lot never clobbers another.
  const [drafts, setDrafts] = React.useState<Record<string, { cost: string; shares: string }>>({});
  const [target, setTarget] = React.useState("");
  const [enabled, setEnabled] = React.useState(false);
  const [notifyState, setNotifyState] = React.useState<"unknown" | "on" | "off">("unknown");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!stock) return;
    const next: Record<string, { cost: string; shares: string }> = {};
    for (const account of accounts) {
      const entry = account.entries[stock.id];
      next[account.id] = {
        cost: entry ? String(entry.costPrice) : "",
        shares: entry ? String(entry.shares) : "",
      };
    }
    setDrafts(next);
    setTarget(stock.alert ? String(stock.alert.targetPrice) : "");
    setEnabled(stock.alert?.enabled ?? false);
    setError(null);
    setNotifyState("unknown");
  }, [stock, accounts]);

  const merged = stock ? mergedPosition(stock) : null;
  const targetValue = parseNumber(target);
  const preview =
    quote && merged
      ? {
          total: (quote.price - merged.costPrice) * merged.shares,
          percent: ((quote.price - merged.costPrice) / merged.costPrice) * 100,
        }
      : null;

  const direction =
    targetValue != null && quote
      ? targetValue >= quote.price
        ? t("alert.direction.rise")
        : t("alert.direction.fall")
      : null;

  const save = async () => {
    if (!stock) return;
    setSaving(true);
    setError(null);
    try {
      for (const account of accounts) {
        const draft = drafts[account.id] ?? { cost: "", shares: "" };
        const costValue = parseNumber(draft.cost);
        const sharesValue = parseNumber(draft.shares);
        const entry = account.entries[stock.id];
        const same =
          (entry?.costPrice ?? null) === (costValue && costValue > 0 ? costValue : null) &&
          (entry?.shares ?? null) === (sharesValue && sharesValue > 0 ? sharesValue : null);
        if (same) continue;
        await setPosition(
          account.id,
          stock.id,
          costValue != null && costValue > 0 ? costValue : null,
          sharesValue != null && sharesValue > 0 ? sharesValue : null,
        );
      }
      await updateAlert(
        stock.id,
        targetValue != null && targetValue > 0 ? targetValue : null,
        enabled && targetValue != null && targetValue > 0,
      );
      onOpenChange(false);
    } catch {
      setError(t("toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const clearHolding = async () => {
    if (!stock) return;
    setDrafts(Object.fromEntries(accounts.map((a) => [a.id, { cost: "", shares: "" }])));
    for (const account of accounts) {
      if (account.entries[stock.id]) {
        await setPosition(account.id, stock.id, null, null);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-48px)] overflow-y-auto p-0">
        {stock ? (
          <>
            <div className="flex items-start justify-between gap-2 px-3.5 pb-2 pt-3">
              <div className="min-w-0">
                <DialogTitle className="truncate">{stock.name}</DialogTitle>
                <DialogDescription className="num mt-0.5 text-[10px] uppercase tracking-[0.06em]">
                  {stock.code} · {t(`market.${stock.market}`)}
                  {quote ? ` · ${formatPrice(quote.price)}` : ""}
                </DialogDescription>
              </div>
              {quote ? (
                <span
                  className={cn(
                    "num shrink-0 rounded-[4px] px-1.5 py-1 text-[11px] font-medium",
                    quote.change >= 0
                      ? "bg-[color-mix(in_oklch,var(--up)_12%,transparent)] text-up"
                      : "bg-[color-mix(in_oklch,var(--down)_12%,transparent)] text-down",
                  )}
                >
                  {formatPercent(quote.changePercent)}
                </span>
              ) : null}
            </div>

            <div className="space-y-3 px-3.5 pb-3">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="eyebrow">{t("edit.accounts")}</span>
                  {merged ? (
                    <span className="num text-[9.5px] text-faint">
                      {t("edit.mergedAt", {
                        shares: merged.shares,
                        price: formatPrice(merged.costPrice),
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  {accounts.map((account) => {
                    const draft = drafts[account.id] ?? { cost: "", shares: "" };
                    const filled = draft.cost.trim() !== "" && draft.shares.trim() !== "";
                    return (
                      <div
                        key={account.id}
                        className={cn(
                          "flex items-end gap-1.5 rounded-[5px] border px-2 py-1.5",
                          filled
                            ? "border-hairline bg-surface/50"
                            : "border-dashed border-hairline/60 bg-transparent",
                        )}
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                          <span className="truncate text-[10.5px] font-medium text-muted-foreground">
                            {account.name}
                          </span>
                          <span className="num text-[9px] text-faint">
                            {filled ? (
                              <>
                                {formatPrice(Number(draft.cost))} × {draft.shares}
                              </>
                            ) : (
                              t("edit.accountEmpty")
                            )}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Input
                            inputMode="decimal"
                            value={draft.cost}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [account.id]: { ...draft, cost: e.target.value },
                              }))
                            }
                            placeholder={t("edit.costPlaceholder")}
                            aria-label={`${account.name} ${t("edit.cost")}`}
                            className="num h-6 w-[68px] text-[11px]"
                          />
                          <span className="text-[10px] text-faint" aria-hidden>
                            ×
                          </span>
                          <Input
                            inputMode="decimal"
                            value={draft.shares}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [account.id]: { ...draft, shares: e.target.value },
                              }))
                            }
                            placeholder={t("edit.sharesPlaceholder")}
                            aria-label={`${account.name} ${t("edit.shares")}`}
                            className="num h-6 w-[68px] text-[11px]"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div
                className={cn(
                  "rounded-[6px] border border-dashed px-2 py-1.5 transition-colors",
                  preview
                    ? "border-hairline bg-surface/60"
                    : "border-hairline/60 bg-transparent",
                )}
              >
                {preview ? (
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-faint">{t("edit.pnlPreview")}</span>
                    <span className="flex items-baseline gap-1.5">
                      <span
                        className={cn(
                          "num text-[12px] font-medium",
                          preview.total >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {preview.total >= 0 ? "+" : ""}
                        {formatMoney(preview.total, settings?.currency ?? "CNY", lang)}
                      </span>
                      <span
                        className={cn(
                          "num text-[10px]",
                          preview.percent >= 0 ? "text-up" : "text-down",
                        )}
                      >
                        {formatPercent(preview.percent)}
                      </span>
                    </span>
                  </div>
                ) : (
                  <span className="text-[10px] text-faint">{t("summary.empty")}</span>
                )}
              </div>

              <div className="ledger-rule my-0.5 opacity-60" aria-hidden />

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {enabled ? (
                    <Bell size={11} strokeWidth={2.2} className="text-amber" />
                  ) : (
                    <BellOff size={11} strokeWidth={2} className="text-faint" />
                  )}
                  <Label htmlFor="alert" className="normal-case tracking-[0.01em] text-[11.5px]">
                    {t("edit.alert")}
                  </Label>
                </div>
                <Switch
                  id="alert"
                  checked={enabled}
                  onCheckedChange={(next) => {
                    setEnabled(next);
                    if (next) {
                      void requestNotifications().then((granted) => {
                        setNotifyState(granted ? "on" : "off");
                      });
                    }
                  }}
                  disabled={!target.trim()}
                />
              </div>

              <div className="flex flex-col gap-1">
                <Input
                  inputMode="decimal"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder={t("edit.alertPlaceholder")}
                  aria-label={t("edit.alert")}
                  className="num h-7 text-[12px]"
                />
                <p className="text-[10px] leading-snug text-faint">
                  {direction && quote
                    ? t("edit.alertHint", {
                        price: formatPrice(quote.price),
                        direction,
                      })
                    : t("edit.alertNeedTarget")}
                </p>
                {notifyState === "off" ? (
                  <p className="flex items-center justify-between gap-2 rounded-[4px] bg-[color-mix(in_oklch,var(--amber)_12%,transparent)] px-1.5 py-1 text-[10px] text-foreground">
                    <span>{t("edit.notifyOff")}</span>
                    <button
                      type="button"
                      className="font-medium text-accent underline-offset-2 hover:underline"
                      onClick={() => {
                        void requestNotifications().then((granted) =>
                          setNotifyState(granted ? "on" : "off"),
                        );
                      }}
                    >
                      {t("edit.notifyGrant")}
                    </button>
                  </p>
                ) : null}
              </div>

              {error ? <p className="text-[10.5px] text-down">{error}</p> : null}
            </div>

            <div className="flex items-center justify-between gap-1.5 border-t border-border/60 px-3.5 py-2">
              <div className="flex items-center gap-0.5">
                <Button
                  variant="danger"
                  size="sm"
                  className="text-[10.5px]"
                  onClick={() => {
                    void clearHolding();
                  }}
                >
                  {t("edit.removeHolding")}
                </Button>
                <Button
                  variant="quiet"
                  size="icon-sm"
                  className="text-faint hover:text-down"
                  aria-label={t("action.delete")}
                  onClick={() => {
                    void removeStock(stock.id);
                    onOpenChange(false);
                  }}
                >
                  <Trash2 size={12} strokeWidth={2} />
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  {t("action.cancel")}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
                  {t("action.save")}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
