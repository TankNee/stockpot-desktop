/**
 * 流水页的派生数据：合计、按天汇总、按天分组。
 *
 * 挪出来有两个原因：一是这些是纯函数，能直接在 Node 里压测（`scripts/bench-ledger.mjs`）；
 * 二是原来「按天汇总」写成了对每一天再过滤一遍全部行，2000 条 30 天就是六万次比较，
 * 而且每次点击都会重跑——这就是流水页发卡的直接原因。这里一遍扫完。
 */
import type { LedgerEntry } from "./types";
import { effectiveAmount } from "./money";

export type Totals = { expense: number; income: number };

/** 一遍扫出本月支出和收入。 */
export function totalsOf(rows: LedgerEntry[]): Totals {
  let expense = 0;
  let income = 0;
  for (const entry of rows) {
    if (entry.kind === "expense") expense += effectiveAmount(entry);
    else if (entry.kind === "income") income += entry.amount;
  }
  return { expense, income };
}

export type DayPoint = { date: string; value: number };

/** 每天花了多少，按日期升序（画柱状图用）。O(n) 而不是 O(天数 × n)。 */
export function dayTotals(rows: LedgerEntry[]): DayPoint[] {
  const buckets = new Map<string, number>();
  for (const entry of rows) {
    if (entry.kind !== "expense") continue;
    buckets.set(entry.date, (buckets.get(entry.date) ?? 0) + effectiveAmount(entry));
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, value }));
}

export type DayGroup = { date: string; rows: LedgerEntry[]; expense: number; income: number };

/** 按天分组，日期从新到旧（列表用）。同样一遍扫完。 */
export function groupByDay(rows: LedgerEntry[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const row of rows) {
    let bucket = map.get(row.date);
    if (!bucket) {
      bucket = { date: row.date, rows: [], expense: 0, income: 0 };
      map.set(row.date, bucket);
    }
    bucket.rows.push(row);
    if (row.kind === "expense") bucket.expense += effectiveAmount(row);
    else if (row.kind === "income") bucket.income += row.amount;
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}
