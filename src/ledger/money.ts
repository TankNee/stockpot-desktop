/**
 * 金额和归属的纯规则：一行算多少、算不算、属于哪个月。
 *
 * 从 store.tsx 里挪出来的——那边是 React 组件文件，压测脚本想在 Node 里
 * 直接算这些数字，一 import 就把 React 和 DOM 全带进来了。
 */
import type { LedgerEntry } from "./types";

/** `2026-11` for the month buckets. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** What a row actually cost after any linked refund. */
export function effectiveAmount(entry: LedgerEntry): number {
  if (entry.kind !== "expense") return entry.amount;
  return Math.max(0, entry.amount - (entry.refundedAmount ?? 0));
}

/** Whether a row belongs in the numbers.
 *
 *  `excluded` rows are visible but ignored (refunds, card repayments);
 *  `archived` rows were set aside by 整理账单 and are hidden from the everyday
 *  lists altogether. Neither counts toward a total, so every aggregate goes
 *  through this one predicate instead of repeating the rule. */
export function countsTowardTotals(entry: LedgerEntry): boolean {
  return !entry.excluded && !entry.archived;
}
