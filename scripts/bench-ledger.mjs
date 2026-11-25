/**
 * 流水页派生逻辑的压测。
 *
 *   pnpm bench
 *
 * 造一份几万条的账本，比较「按天汇总」的旧写法（对每一天再过滤一遍全部行）
 * 和新写法（一遍扫完），顺便量一下合计、分组和搜索过滤。
 */
import { createJiti } from "jiti";

// jiti 能直接吃 .ts，省得为压测单独配一套构建（项目里已经有它了）
const jiti = createJiti(import.meta.url);
const { dayTotals, groupByDay, totalsOf } = jiti("../src/ledger/derive.ts");

const cost = (entry) =>
  entry.kind === "expense" ? Math.max(0, entry.amount - (entry.refundedAmount ?? 0)) : entry.amount;

/** 优化前：每一天都要把全部行过一遍。 */
function legacyDayTotals(rows) {
  const dates = [...new Set(rows.map((entry) => entry.date))].sort();
  return dates.map((date) => ({
    date,
    value: rows
      .filter((entry) => entry.date === date && entry.kind === "expense")
      .reduce((sum, entry) => sum + cost(entry), 0),
  }));
}

/** 优化前：合计也是一次遍历，但每次渲染都重跑（没有缓存）。这里只量算法本身。 */
function legacyTotals(rows) {
  return rows.reduce(
    (acc, row) => {
      if (row.kind === "expense") acc.expense += cost(row);
      if (row.kind === "income") acc.income += row.amount;
      return acc;
    },
    { expense: 0, income: 0 },
  );
}

function makeEntries(count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const day = new Date(2024, 0, 1 + (i % 700));
    out[i] = {
      id: `e${i}`,
      date: day.toISOString().slice(0, 10),
      kind: i % 11 === 0 ? "income" : "expense",
      amount: 1000 + ((i * 37) % 90_000),
      category: "餐饮/午餐",
      account: i % 3 === 0 ? "微信" : "招商银行",
      counterparty: `店${i % 57}`,
      note: i % 5 === 0 ? "晚饭" : "",
      source: "manual",
      excluded: false,
      archived: false,
      refundedAmount: i % 17 === 0 ? 200 : 0,
      createdAt: "2026-11-01T00:00:00Z",
    };
  }
  return out;
}

function timeIt(fn, rounds = 5) {
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const started = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const pad = (value, width) => String(value).padStart(width);
const fmt = (ms) => `${ms.toFixed(1)} ms`;

console.log("\n账本规模      按天汇总(旧)   按天汇总(新)   加速   合计   分组   搜索过滤");
console.log("─".repeat(84));

for (const count of [1000, 5000, 20000, 50000]) {
  const rows = makeEntries(count);
  const oldMs = timeIt(() => legacyDayTotals(rows));
  const newMs = timeIt(() => dayTotals(rows));
  const totalsMs = timeIt(() => totalsOf(rows));
  const groupsMs = timeIt(() => groupByDay(rows));
  const filterMs = timeIt(() =>
    rows.filter((entry) =>
      `${entry.counterparty} ${entry.note} ${entry.category} ${entry.account}`.toLowerCase().includes("晚饭"),
    ),
  );
  const speedup = oldMs / Math.max(newMs, 0.001);
  console.log(
    `${pad(count, 8)} 条  ${pad(fmt(oldMs), 12)}  ${pad(fmt(newMs), 12)}  ${pad(speedup.toFixed(1) + "×", 6)}  ` +
      `${pad(fmt(totalsMs), 5)}  ${pad(fmt(groupsMs), 5)}  ${pad(fmt(filterMs), 8)}`,
  );
}

console.log("\n（中位数，5 轮；「旧」= 对每一天重新过滤全部行）");
