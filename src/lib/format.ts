import type { Lang, Market, Quote, Rates, SessionKey } from "./types";
import { locales } from "./i18n";

export const currencySymbol: Record<string, string> = {
  CNY: "¥",
  HKD: "HK$",
  USD: "$",
  KRW: "₩",
};

/** Two decimals above 10, three below. Matches the menu bar and rows so a
 *  price never jumps width when it crosses a round number. */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value).toFixed(digits);
  return value >= 0 ? `+${abs}%` : `-${abs}%`;
}
/** Money in the display currency, always grouped and never abbreviated: the
 *  summary strip is wide enough at panel size and a mixed "12,480 / 1.2万" pair
 *  reads as two different scales. */
export function formatMoney(value: number, currency: string, lang: Lang): string {
  const symbol = currencySymbol[currency] ?? "";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const locale = locales[lang] ?? "en-US";
  const digits = abs >= 100_000 ? 0 : 2;
  return (
    sign +
    symbol +
    abs.toLocaleString(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  );
}


/** Grouped number without a currency symbol, for table cells that already sit
 *  inside a currency-labelled column. */
export function addThousands(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
/** Convert an amount from a market's native currency into the display currency
 *  using the USD cross rates the backend publishes. */
export function convertCurrency(
  amount: number,
  market: Market,
  currency: string,
  rates: Rates,
): number {
  const toCny = (value: number) => {
    switch (market) {
      case "a":
        return value;
      case "hk":
        return value * (rates.usdCny / rates.usdHkd);
      case "us":
        return value * rates.usdCny;
      case "kr":
        return value * (rates.usdCny / rates.usdKrw);
    }
  };
  const cny = toCny(amount);
  switch (currency) {
    case "HKD":
      return cny / (rates.usdCny / rates.usdHkd);
    case "USD":
      return cny / rates.usdCny;
    case "KRW":
      return cny / (rates.usdCny / rates.usdKrw);
    default:
      return cny;
  }
}

/** Effective change used for sorting: US extended prices are compared to the
 *  regular close so pre-market moves rank correctly. */
export function sortableChange(quote: Quote | undefined, market: Market, usMode: string): number {
  if (!quote) return -Infinity;
  if (market === "us" && usMode === "session" && quote.extendedPrice) {
    return quote.extendedChangePercent ?? 0;
  }
  return quote.changePercent;
}

export function sessionTone(session: SessionKey | undefined): "live" | "warm" | "idle" {
  if (session === "open") return "live";
  if (session === "pre" || session === "post" || session === "night" || session === "lunch") return "warm";
  return "idle";
}
