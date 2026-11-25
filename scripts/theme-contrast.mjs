// 桌面端深色纸的对比度体检。色值抄自 src/index.css 的 .dark 块，
// 改完 CSS 记得同步这里，然后 `node scripts/theme-contrast.mjs`。
//
// 为什么不用 CSS 变量直接读：这份脚本要能在 CI / 无浏览器环境跑，
// oklch -> sRGB 的换算在这里自己算，避免依赖构建产物。

function oklch2hex(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (v) => {
    v = Math.max(0, Math.min(1, v));
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(v * 255);
  };
  return '#' + [enc(r), enc(g), enc(bb)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

const token = (L, C, h) => oklch2hex(L, C, h);

const dark = {
  paper: token(0.235, 0.007, 65),
  panel: token(0.285, 0.008, 65),
  surface: token(0.335, 0.009, 65),
  surfaceStrong: token(0.385, 0.01, 65),
  foreground: token(0.93, 0.008, 85),
  mutedForeground: token(0.76, 0.01, 80),
  faint: token(0.71, 0.01, 75),
  border: token(0.43, 0.01, 68),
  hairline: token(0.475, 0.01, 68),
  accent: token(0.755, 0.078, 235),
  accentSoft: token(0.335, 0.028, 240),
  red: token(0.71, 0.15, 28),
  green: token(0.745, 0.105, 158),
  amber: token(0.8, 0.11, 78),
};

const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
const lum = (h) => {
  const [r, g, b] = rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const checks = [
  ['foreground / panel', dark.foreground, dark.panel, 4.5, '正文'],
  ['foreground / surface', dark.foreground, dark.surface, 4.5, '悬停行正文'],
  ['muted / panel', dark.mutedForeground, dark.panel, 4.5, '次要文字'],
  ['muted / surface', dark.mutedForeground, dark.surface, 4.5, '次要文字'],
  ['faint / panel', dark.faint, dark.panel, 4.5, '占位符、标签'],
  ['faint / surface', dark.faint, dark.surface, 4.5, '占位符、标签'],
  ['accent / panel', dark.accent, dark.panel, 3.0, '链接、图标'],
  ['accent / accent-soft', dark.accent, dark.accentSoft, 3.0, '选中行'],
  ['red / panel', dark.red, dark.panel, 4.5, '下跌/支出'],
  ['green / panel', dark.green, dark.panel, 4.5, '上涨/收入'],
  ['amber / panel', dark.amber, dark.panel, 4.5, '提示'],
  ['border / paper', dark.border, dark.paper, 1.8, '面板描边'],
  ['hairline / panel', dark.hairline, dark.panel, 1.8, '分隔线'],
  ['panel / paper', dark.panel, dark.paper, 1.12, '纸面抬升'],
  ['surface / panel', dark.surface, dark.panel, 1.15, '层级抬升'],
];

console.log('dark palette:', dark);
let bad = 0;
for (const [label, fg, bg, min, note] of checks) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) bad++;
  console.log(
    `${ok ? 'OK ' : 'BAD'} ${label.padEnd(24)} ${r.toFixed(2)}:1  (>=${min})  ${note}`,
  );
}
console.log(`\n不合格组合：${bad}`);
process.exitCode = bad ? 1 : 0;
