// Reports t() keys that are missing from one or more dictionaries.
//
// Two sources of keys are checked:
//   1. literal t("…") calls, extracted from the source;
//   2. key families built from a template such as `ledger.tab.${tab}`, expanded
//      against the value sets the app actually uses.
//
// The second half matters: a missing literal key shows up as raw text on screen,
// and so does a missing templated one — which is how `ledger.subtitle.projects`
// slipped through once already.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const i18n = readFileSync("src/lib/i18n.ts", "utf8");
const langs = ["zh", "en", "ja"];

const blocks = {};
for (const lang of langs) {
  const start = i18n.indexOf(`const ${lang}: Dict = {`);
  const next = langs
    .map((l) => i18n.indexOf(`const ${l}: Dict = {`))
    .filter((i) => i > start)
    .sort((a, b) => a - b)[0];
  blocks[lang] = i18n.slice(start, next === -1 ? i18n.indexOf("export const dictionaries") : next);
}

const keysOf = (block) => {
  const keys = new Set();
  for (const m of block.matchAll(/^\s*"([^"]+)":/gm)) keys.add(m[1]);
  return keys;
};
const dict = Object.fromEntries(langs.map((l) => [l, keysOf(blocks[l])]));

// ---- 1. literal keys -------------------------------------------------------
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
};
walk("src");

const used = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], file);
  }
}

// ---- 2. templated key families --------------------------------------------
// Value sets copied from the domain types; keep them in sync when a variant is
// added, otherwise the check silently stops covering the new value.
const ledgerTabs = ["overview", "entries", "projects", "wallets", "cleanup", "import"];
const settingsTabs = ["portfolio", "stocks", "appearance", "menubar", "ledger", "ledgerAi", "shortcuts", "about"];
const walletKinds = ["debit", "credit", "cash", "investment", "pension", "provident", "medical", "other"];
const entryKinds = ["expense", "income", "transfer"];
const entrySources = ["manual", "wechat", "alipay"];
const menuBarModes = ["stock", "dailyPnl", "totalPnl", "bothPnl", "none"];
const themes = ["system", "light", "dark"];
const colorSchemes = ["chinese", "western"];
const markets = ["a", "hk", "us", "kr"];
const sessions = ["pre", "open", "lunch", "post", "night", "closed", "weekend"];

const templated = [];
const addFamily = (prefix, values, suffix = "") => {
  for (const value of values) templated.push([`${prefix}.${value}${suffix}`, "templated"]);
};
addFamily("ledger.tab", ledgerTabs);
addFamily("ledger.subtitle", ledgerTabs);
addFamily("ledger.kind", entryKinds);
addFamily("ledger.source", entrySources);
addFamily("ledger.walletKind", walletKinds);
addFamily("settings.tab", settingsTabs);
addFamily("settings.tab", settingsTabs, ".hint");
addFamily("settings.menubar", menuBarModes);
addFamily("settings.theme", themes);
addFamily("settings.colors", colorSchemes);
addFamily("market", markets);
addFamily("session", sessions);

for (const [key, file] of templated) {
  if (!used.has(key)) used.set(key, file);
}

// ---- report ---------------------------------------------------------------
let failed = false;
console.log("keys checked:", used.size);
for (const lang of langs) {
  const missing = [...used].filter(([key]) => !dict[lang].has(key));
  console.log(`\n== missing in ${lang}: ${missing.length}`);
  for (const [key, file] of missing) {
    console.log(`  ${key}  (${file})`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
