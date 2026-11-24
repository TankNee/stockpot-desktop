import type { Account, MergedPosition, Position, Stock } from "./types";

/** Weighted-average merge of every account's holding in one stock.
 *  Returns null when nobody holds it. */
export function mergePosition(
  accounts: Account[],
  stockId: string,
): MergedPosition | null {
  let shares = 0;
  let basis = 0;
  for (const account of accounts) {
    const entry = account.entries[stockId];
    if (!entry || entry.shares <= 0 || entry.costPrice <= 0) continue;
    shares += entry.shares;
    basis += entry.costPrice * entry.shares;
  }
  if (shares <= 0) return null;
  return { shares, costPrice: basis / shares, basis };
}

export interface Lot {
  account: Account;
  position: Position;
  /** Share of the merged position, 0–1. */
  weight: number;
}

/** The individual lots behind a merged position, largest first, for the
 *  "where does this average come from" breakdown. */
export function lotsFor(accounts: Account[], stockId: string): Lot[] {
  const merged = mergePosition(accounts, stockId);
  if (!merged) return [];
  return accounts
    .map((account) => ({ account, position: account.entries[stockId] }))
    .filter((lot): lot is { account: Account; position: Position } =>
      Boolean(lot.position && lot.position.shares > 0),
    )
    .map((lot) => ({
      ...lot,
      weight: lot.position.shares / merged.shares,
    }))
    .sort((a, b) => b.position.shares - a.position.shares);
}

/** Total shares held across every account (used by the footer and summaries). */
export function totalShares(accounts: Account[], stocks: Stock[]): number {
  let shares = 0;
  for (const stock of stocks) {
    shares += mergePosition(accounts, stock.id)?.shares ?? 0;
  }
  return shares;
}

/** How many distinct stocks have at least one lot in the given account. */
export function accountHoldingCount(account: Account): number {
  return Object.values(account.entries).filter((p) => p.shares > 0).length;
}
