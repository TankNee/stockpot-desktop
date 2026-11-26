// 截一张「分类管理 / 图标选择器」的图，用来核对网格版式。
//   node scripts/shot-categories.mjs
// 前提：`pnpm dev` 已经在 1700 跑着。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = process.env.SHOT_URL ?? "http://localhost:1700/settings.html#ledger";
const OUT = process.env.SHOT_OUT ?? "C:/Users/tanknee/WorkBuddy/spaces/2026_11_23_09-48-32/category-icons.png";
const PORT = 9334;

const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!chrome) throw new Error("找不到 Chrome/Edge");

const profile = mkdtempSync(join(tmpdir(), "stockpot-shot-"));
const proc = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up */
    }
    await sleep(200);
  }
  throw new Error("连不上调试端口");
}

const ws = new WebSocket(await wsUrl());
let nextId = 1;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
  else slot.resolve(msg.result);
});
await new Promise((r) => ws.addEventListener("open", r));

const evaluate = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? "eval failed");
  return res.result.value;
};

await call("Page.enable");
await call("Runtime.enable");
await call("Page.navigate", { url: URL });
await sleep(3500);

// 设置窗口的左侧导航：先点进「账本」，分类管理在那一段里
const nav = process.env.SHOT_NAV ?? "";
if (nav) {
  const clicked = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, a, [role="tab"], li')];
    const hit = nodes.find((n) => n.textContent.trim() === ${JSON.stringify(nav)});
    if (!hit) return "no-nav";
    hit.click();
    return "ok";
  })()`);
  console.log("导航:", nav, clicked);
  await sleep(1200);
}

if (process.env.SHOT_FLOW === "1") {
  // 在名称框里打「咖啡」，看图标按钮会不会跟着变
  const flow = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === '例如：宠物');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '咖啡');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(400);
  const label = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="图标"]');
    return btn ? btn.textContent.trim() : 'no-button';
  })()`);
  console.log("输入咖啡后图标按钮显示:", flow, "->", label);
}

if (process.env.SHOT_DEBUG === "1") {
  const info = await evaluate(`(() => {
    const svgs = [...document.querySelectorAll('svg')].slice(0, 14);
    return svgs.map((s) => (s.getAttribute('class') || '').split(' ').find((c) => c.startsWith('lucide-')) || '?');
  })()`);
  console.log("前几个图标:", info);
  const cats = await evaluate(`(() => {
    const names = ["餐饮", "咖啡", "外卖", "打车", "房贷", "宠物"];
    return names.map((n) => {
      const el = [...document.querySelectorAll('span,div')].find((e) => e.children.length === 0 && e.textContent.trim() === n);
      const svg = el?.parentElement?.querySelector('svg');
      const cls = (svg?.getAttribute('class') || '').split(' ').find((c) => c.startsWith('lucide-'));
      return n + ' -> ' + (cls || 'no-svg');
    });
  })()`);
  console.log("分类行图标:", cats);
}

// 打开图标选择器，滚到能看见的位置
const opened = await evaluate(`(() => {
  const btn = document.querySelector('[aria-label="图标"]');
  if (!btn) return "no-button";
  btn.scrollIntoView({ block: "center" });
  btn.click();
  return "ok";
})()`);
console.log("打开选择器:", opened);
await sleep(600);

// SHOT_DARK=1 时切深色再看一遍对比度
if (process.env.SHOT_DARK === "1") {
  await evaluate(`(() => {
    document.documentElement.classList.add("dark");
    return document.documentElement.className;
  })()`);
  await sleep(400);
}

const shot = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("已保存", OUT);

ws.close();
proc.kill();
