// UI 压测：在浏览器预览里塞一份 3200 条的账本，量三件事的耗时——
// 切到流水页、打开编辑弹窗、保存。这三个是用户点下去最直接的等待。
//
// 用法：先 `pnpm dev`，再 `node scripts/bench-window.mjs [条数] [重复次数]`
// 它自己拉起一个 headless Chrome，走 CDP，不需要额外装依赖。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUNT = Number(process.argv[2] ?? 3200);
// SEED_FILE 指向真实的 ledger.json 时，直接拿真账本压：合成数据里每个月都是
// 均分的，真账本却是「有的月两百多条、有的月很空」，量出来的数才对得上体感。
const SEED_FILE = process.env.SEED_FILE ?? "";
// SPREAD=month 时把这 COUNT 笔全塞进当月，用来模拟「一个月就几千条」
const SPREAD = process.env.SPREAD === "month" ? "month" : "year";
const ROUNDS = Number(process.argv[3] ?? 3);
const URL = process.env.BENCH_URL ?? "http://localhost:1700/settings.html#ledger";
const PORT = 9333;

const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

if (!chrome) {
  console.error("找不到 Chrome/Edge");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "stockpot-bench-"));
const proc = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,860",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("连不上 Chrome 的调试端口");
}

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await call("Page.enable");
await call("Runtime.enable");

/** 往预览里塞一份账本。日期铺满最近 13 个月，条数按量级均分。 */
const seed = (count, spread) => `(() => { try {
  const N = ${count};
  const now = new Date();
  const cats = ["餐饮/午餐", "餐饮/咖啡", "交通/打车", "购物", "居住/房租", "娱乐", "医疗", "工资"];
  const accts = ["微信零钱", "支付宝余额", "招商银行", "现金"];
  const shops = ["美团外卖", "滴滴出行", "星巴克", "京东", "房东", "电影院", "社区医院", "某某科技"];
  const entries = [];
  for (let i = 0; i < N; i++) {
    // 13 个月里均匀铺开，最近的月份条数多一点，像真的记了一年账
    const ago = ${JSON.stringify(spread)} === "month" ? 12 : Math.floor((i / N) * 13);
    const d = new Date(now.getFullYear(), now.getMonth() - 12 + ago, 1 + (i % 27));
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const income = i % 40 === 0;
    entries.push({
      id: "seed-" + i,
      date: iso,
      time: String(8 + (i % 12)).padStart(2, "0") + ":" + String((i * 7) % 60).padStart(2, "0"),
      kind: income ? "income" : "expense",
      amount: income ? 1850000 : 1000 + ((i * 137) % 40000),
      category: income ? "工资" : cats[i % (cats.length - 1)],
      account: accts[i % accts.length],
      counterparty: shops[i % shops.length],
      note: "",
      source: "manual",
      externalId: "",
      excluded: false,
      projectId: "",
      refundedAmount: i % 17 === 0 ? 500 : 0,
      refundedAt: i % 17 === 0 ? iso : "",
      createdAt: iso + "T00:00:00",
    });
  }
  entries.sort((a, b) => (a.date === b.date ? b.time.localeCompare(a.time) : b.date.localeCompare(a.date)));
  const ledger = {
    entries,
    projects: [],
    rules: [],
    categories: [
      ["餐饮", "", "expense", "food"], ["午餐", "餐饮", "expense", "food"],
      ["咖啡", "餐饮", "expense", "coffee"], ["交通", "", "expense", "transport"],
      ["打车", "交通", "expense", "taxi"], ["购物", "", "expense", "shopping"],
      ["居住", "", "expense", "home"], ["房租", "居住", "expense", "home"],
      ["娱乐", "", "expense", "fun"], ["医疗", "", "expense", "health"],
      ["工资", "", "income", "salary"],
    ].map(([name, parent, kind, icon]) => ({ name, parent, kind, icon, description: "" })),
    accounts: accts,
    wallets: [],
    imports: [],
  };
  localStorage.setItem("stockpot.ledger.v1", JSON.stringify(ledger));
  localStorage.setItem("__pending", JSON.stringify({ lang: "zh", theme: "light" }));
  window.__seeded = entries.length;
  } catch (e) { window.__seedError = String(e && e.stack || e); }
})()`;

/** 真账本原样塞进去，连当月是几月、哪个月条数多都跟用户机器上一样。 */
const realSeed = SEED_FILE ? readFileSync(SEED_FILE, "utf8") : null;
const realSeedScript = () => {
  const doc = JSON.parse(realSeed);
  return `(() => { try {
  const doc = ${JSON.stringify(doc)};
  localStorage.setItem("stockpot.ledger.v1", JSON.stringify(doc));
  localStorage.setItem("__pending", JSON.stringify({ lang: "zh", theme: "light" }));
  window.__seeded = (doc.entries || []).length;
  } catch (e) { window.__seedError = String(e && e.stack || e); }
})()`;
};

await call("Page.addScriptToEvaluateOnNewDocument", {
  source: realSeed ? realSeedScript() : seed(COUNT, SPREAD),
});

/** 页面里跑的测量脚本：点一下，等到两帧之后再算结束。 */
const probe = `(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const now = () => performance.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 记录这段时间里的长任务，能看出主线程被卡了多久
  const longs = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longs.push(Math.round(e.duration));
  });
  obs.observe({ entryTypes: ["longtask"] });

  const click = async (el) => {
    const t0 = now();
    el.click();
    await raf();
    return now() - t0;
  };
  const text = (el) => (el.textContent || "").trim();
  const navBtn = (name) =>
    [...document.querySelectorAll("nav button")].find((b) => text(b).includes(name));

  const out = {};
  const rows = () => document.querySelectorAll(".entry-row").length;

  // 1. 切到流水页
  const entriesTab = navBtn("流水");
  if (!entriesTab) return { error: "没找到流水页入口", html: document.body.innerText.slice(0, 200) };
  out.entriesTab = await click(entriesTab);
  out.rows = rows();
  const hs = {};
  document.querySelectorAll(".entry-row").forEach((el) => {
    const h = Math.round(el.getBoundingClientRect().height * 10) / 10;
    hs[h] = (hs[h] || 0) + 1;
  });
  out.rowHeights = hs;
  const dayEl = document.querySelector(".entry-row")?.parentElement?.previousElementSibling;
  out.dayHeaderH = dayEl ? Math.round(dayEl.getBoundingClientRect().height * 10) / 10 : null;
  const raw = JSON.parse(localStorage.getItem("stockpot.ledger.v1") || "{}");
  out.total = (raw.entries || []).length;
  out.seeded = window.__seeded ?? null;
  out.seedError = window.__seedError ?? null;
  const mk = new Date();
  const key = mk.getFullYear() + "-" + String(mk.getMonth() + 1).padStart(2, "0");
  out.inMonth = (raw.entries || []).filter((e) => e.date.slice(0, 7) === key).length;
  out.monthKey = key;
  out.firstDates = (raw.entries || []).slice(0, 3).map((e) => e.date);
  await wait(120);

  // 2. 点第一行的编辑按钮
  const editBtn = document.querySelector('.entry-row button[aria-label*="编辑"]');
  out.editBtnFound = !!editBtn;
  if (editBtn) {
    out.openDialog = await click(editBtn);
    await wait(150);
  }

  // 3. 保存
  const saveBtn = [...document.querySelectorAll("button")].find((b) => text(b) === "保存");
  out.saveBtnFound = !!saveBtn;
  if (saveBtn) {
    out.save = await click(saveBtn);
    // 保存是异步的：等弹窗真的关掉，才是用户看到的「保存完」
    const t0 = now();
    for (let i = 0; i < 300; i++) {
      if (!saveBtn.isConnected || saveBtn.offsetParent === null) break;
      await wait(10);
    }
    out.saveDone = now() - t0;
    await wait(120);
  }

  // 4. 滚动：窗口化必须滚得住，且滚到底不能有空白
  const vp = document.querySelector('[class*="overflow-y-auto"]');
  if (vp) {
    out.scrollHeight = vp.scrollHeight;
    out.clientHeight = vp.clientHeight;
    const sweepStart = now();
    const max = vp.scrollHeight - vp.clientHeight;
    for (let i = 1; i <= 24; i++) {
      vp.scrollTop = (max * i) / 24;
      await raf();
    }
    out.scrollSweep = now() - sweepStart;
    vp.scrollTop = vp.scrollHeight;
    await raf();
    await raf();
    const atBottom = [...document.querySelectorAll(".entry-row")];
    out.rowsAtBottom = atBottom.length;
    out.lastRow = atBottom.length ? atBottom[atBottom.length - 1].innerText.replace(/\s+/g, " ").slice(0, 24) : null;
    out.bottomGap = Math.round(max - vp.scrollTop);
    vp.scrollTop = 0;
    await raf();
    await raf();
    const atTop = [...document.querySelectorAll(".entry-row")];
    out.rowsAtTop = atTop.length;
    out.firstRow = atTop.length ? atTop[0].innerText.replace(/\s+/g, " ").slice(0, 24) : null;
    await wait(100);
  }

  // 5. 点一行进详情，再退回列表（这两步会卸载/重挂整张表）
  const row = document.querySelector(".entry-row");
  if (row) {
    out.openDetail = await click(row);
    await wait(120);
    out.detailShown = !!document.querySelector('[aria-label="返回"], button');
    const backBtn = [...document.querySelectorAll("button")].find((b) => text(b).includes("返回"));
    if (backBtn) {
      out.backToList = await click(backBtn);
      await wait(120);
      out.rowsAfterBack = rows();
    }
  }

  // 6. 切回总览再切回来（模拟来回点）
  const overview = navBtn("总览");
  if (overview) {
    out.backToOverview = await click(overview);
    await wait(100);
    out.entriesAgain = await click(entriesTab);
  }

  obs.disconnect();
  out.longTasks = longs.sort((a, b) => b - a).slice(0, 6);
  out.longest = longs.length ? Math.max(...longs) : 0;
  return out;
})()`;

const results = [];
for (let round = 0; round < ROUNDS; round++) {
  await call("Page.navigate", { url: URL });
  await sleep(2500);
  const { result } = await call("Runtime.evaluate", {
    expression: probe,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.value?.error) {
    console.error(result.value.error, result.value.html ?? "");
    break;
  }
  results.push(result.value);
  if (process.env.SHOT && round === 0) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.SHOT, Buffer.from(shot.data, "base64"));
  }
  console.log(`第 ${round + 1} 轮`, JSON.stringify(result.value));
}

const median = (values) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.floor(sorted.length / 2)];
};

if (results.length) {
  const pick = (key) => median(results.map((r) => r[key]));
  console.log("\n=== 中位数（%d 条账本，%d 轮）===", COUNT, results.length);
  console.log("可见行数       ", results[0].rows);
  console.log("切到流水页     ", pick("entriesTab").toFixed(1), "ms");
  console.log("打开编辑弹窗   ", pick("openDialog").toFixed(1), "ms");
  console.log("点保存到响应   ", pick("save").toFixed(1), "ms");
  console.log("保存到弹窗关闭 ", pick("saveDone").toFixed(1), "ms");
  console.log("切回总览       ", pick("backToOverview").toFixed(1), "ms");
  console.log("再切回流水     ", pick("entriesAgain").toFixed(1), "ms");
  console.log("进详情         ", pick("openDetail").toFixed(1), "ms");
  console.log("返回后可见行   ", results[0].rowsAfterBack);
  console.log("最长主线程阻塞 ", pick("longest").toFixed(0), "ms");
  console.log("长任务（前 6） ", results[0].longTasks?.join(", "));
}

ws.close();
proc.kill();
try {
  rmSync(profile, { recursive: true, force: true });
} catch {
  /* windows 上偶尔删不掉，无所谓 */
}
