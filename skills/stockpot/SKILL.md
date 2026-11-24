# Stockpot Agent CLI

Use the installed app binary; neither macOS nor Windows puts it on `PATH`.

## Where the binary and the data are

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Binary | `/Applications/Stockpot.app/Contents/MacOS/stockpot` | `%LOCALAPPDATA%\Stockpot\stockpot.exe` (per-user installer) or `C:\Program Files\Stockpot\stockpot.exe` (machine-wide) | `/usr/bin/stockpot` or `target/release/stockpot` |
| Data | `~/Library/Application Support/com.stockpot.app` | `%APPDATA%\com.stockpot.app` | `$XDG_DATA_HOME/com.stockpot.app` (`~/.local/share/...`) |

`cli doctor` prints the exact `dataDir`, `ledgerFile` and `dataFile` this machine
resolves to, which is the reliable way to confirm you are pointed at the same
folder as the app. `--data-dir DIR` overrides it for tests.

```sh
# macOS (zsh/bash)
BIN="/Applications/Stockpot.app/Contents/MacOS/stockpot"
"$BIN" cli --help
"$BIN" cli doctor
"$BIN" cli skill
```

```powershell
# Windows (PowerShell)
$Bin = "$env:LOCALAPPDATA\Stockpot\stockpot.exe"
& $Bin cli --help
& $Bin cli doctor
& $Bin cli skill
```

```bat
:: Windows (cmd.exe)
"%LOCALAPPDATA%\Stockpot\stockpot.exe" cli doctor
```

## Shell differences that actually bite

**JSON arguments.** macOS/Linux pass inline JSON directly between single quotes.
PowerShell strips the quotes and mangles `{"…"}`, so write the JSON to a file and
pass `@path` — the CLI accepts both forms, on every platform:

```powershell
'{"date":"2026-11-20","kind":"expense","yuan":52,"category":"餐饮"}' |
  Set-Content -Path "$env:TEMP\entry.json" -Encoding utf8 -NoNewline
& $Bin cli entries.add "@$env:TEMP\entry.json"
```

```sh
"$BIN" cli entries.add '{"date":"2026-11-20","kind":"expense","yuan":52,"category":"餐饮"}'
```

Note for Windows: write JSON without a BOM (`-NoNewline` above still adds none in
PowerShell 7; in Windows PowerShell 5.1 use
`[IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))`), or the
CLI rejects it with `invalid-json`.

**Encoding.** The CLI prints UTF-8. To keep Chinese names readable in a Windows
console, run `chcp 65001` once, or in PowerShell:

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
```

**Paths with spaces.** Always quote the binary, both platforms.

Every command below is identical on macOS and Windows. The examples are written
for bash/zsh; on Windows swap `"$BIN"` for `& $Bin` and route JSON through `@file`
as shown above.

## Rules

- Never read or edit JSON files directly. Use the CLI so validation, backups,
  categories, refunds and migrations stay consistent.
- All successful responses are `{"ok":true,"data":...}`. Errors are
  `{"ok":false,"error":...}` with a non-zero exit status.
- Use `--data-dir DIR` for tests or isolated data. Never use the user's real
  ledger for destructive tests.
- Dates are ISO `YYYY-MM-DD`. `from` and `to` are inclusive.
- `yuan` accepts a decimal amount; `amount` and `balance` are integer cents.
- Partial entry updates preserve omitted fields. Unknown settings are rejected.
- The CLI is headless: it does not start the GUI or a network service.
- AI/JEV classification is only performed when explicitly requested in the GUI;
  importing a bill with the CLI does not invoke AI. `ai.classify` is not exposed
  here because its suggestions are meant to be reviewed before they are applied —
  use `entries.recategorize` once the categories are known.
- Window, tray and notification commands are GUI-only by nature (there is no
  window to open or panel to hide in a headless process).

## Read and search

```sh
"$BIN" cli entries.list --limit 20
"$BIN" cli entries.search 瑞幸
"$BIN" cli entries.list --from 2026-10-01 --to 2026-10-31 --limit 1000
"$BIN" cli entries.search 咖啡 --from 2026-10-01 --to 2026-10-31 --limit 1000
"$BIN" cli ledger.show
"$BIN" cli doctor
```

The default limit is 100. `entries.search` searches date, counterparty, note,
category and account. Results are newest first.

stdin accepts either `args` or named filters:

```sh
printf '%s\n' '{"command":"entries.search","query":"咖啡","from":"2026-10-01","to":"2026-10-31","limit":1000}' | "$BIN" cli --stdin
```

## Create and modify

```sh
"$BIN" cli entries.add '{"date":"2026-11-13","kind":"expense","yuan":19.5,"category":"餐饮/咖啡","counterparty":"瑞幸咖啡"}'
"$BIN" cli entries.update ENTRY_ID '{"note":"拿铁"}'
"$BIN" cli entries.delete ENTRY_ID
"$BIN" cli settings.update '{"theme":"dark","language":"en"}'
"$BIN" cli settings.set theme '"light"'
"$BIN" cli settings.show
```

Do not guess an id: read it from the returned entry first. `entries.update`
requires the id and a JSON object of fields to change.

## Projects

A project groups the many rows of one event — a trip, a move, a renovation. It is
a membership layer only: attaching or detaching rows never changes their amount,
category or account, and deleting a project keeps every entry.

```sh
"$BIN" cli projects.list
"$BIN" cli projects.add '{"name":"北海道旅行","note":"7 天","startDate":"2026-01-10","endDate":"2026-01-17"}'
"$BIN" cli projects.update PROJECT_ID '{"archived":true}'
"$BIN" cli projects.delete PROJECT_ID

# Attach at creation time:
"$BIN" cli entries.add '{"date":"2026-01-11","kind":"expense","yuan":128.5,"category":"餐饮","projectId":"PROJECT_ID"}'
# Attach, move or clear existing rows in bulk (comma-separated or a JSON array;
# an empty project id clears the membership):
"$BIN" cli entries.project ID_A,ID_B PROJECT_ID
"$BIN" cli entries.project ID_A ""
```

`projects.update` is a patch: omitted fields keep their current value, so
`{"archived":true}` archives without restating the dates.

## Accounts and categories

```sh
"$BIN" cli wallets.list
"$BIN" cli wallets.add '{"name":"现金","kind":"cash","yuan":20}'
"$BIN" cli wallets.update WALLET_ID '{"yuan":25}'
"$BIN" cli categories.list
"$BIN" cli categories.add '{"name":"咖啡","parent":"餐饮","kind":"expense","description":"咖啡饮品"}'
"$BIN" cli categories.update '餐饮/咖啡' '{"description":"咖啡馆和咖啡饮品"}'
"$BIN" cli rules.add '{"pattern":"瑞幸","category":"餐饮/咖啡"}'
```

Resetting categories restores the built-in tree without deleting entries:

```sh
"$BIN" cli categories.reset
```

## Import and export

```sh
# Parse only — what the app's confirmation dialog shows, nothing is written.
"$BIN" cli ledger.preview /absolute/path/to/bill.xlsx
"$BIN" cli ledger.import /absolute/path/to/bill.xlsx

# The platform is detected from the header columns. When detection is wrong
# (a re-saved export, a trimmed header), name it instead:
"$BIN" cli ledger.import /path/bill.xlsx --source wechat     # wechat | alipay | icost

"$BIN" cli ledger.export --output /absolute/path/to/ledger.json
"$BIN" cli data.export --output /absolute/path/to/stockpot.json
```

`ledger.preview` is the safe first step for any file you have not seen before: it
reports the parsed row count, how many already exist, the ignored count, the date
range, expense/income totals and the first few rows. Import only after the numbers
look right.

Dates may arrive as text (`2026-11-22 10:58:51`) or as Excel serial numbers
(`46348.4575…`), which is what WeChat's newer xlsx export uses; both are handled.

Fund earnings are booked as income even though the platform files them as a
neutral move: a 余额宝/零钱通/理财通 row mentioning 收益, 分红 or 发放 becomes an
income entry. Transfers in and out stay neutral, because the principal only
changes pocket and counting it would double the real totals.

Re-imports are deduplicated by platform transaction id. CLI import does not invoke
AI; use the GUI's optional AI action if that is wanted.

## Tidy-up (整理账单)

Duplicates come from importing overlapping exports. The app never deletes a row
here: it archives the copies and keeps one, and archived rows can be restored.

```sh
# What the 整理账单 page would show: duplicate clusters and pay-later rows.
"$BIN" cli cleanup.report

# Resolve every duplicate cluster at once: keep the row with the most
# information (hand-set category, project, account, note, transaction id; ties
# go to the earliest import) and archive the rest.
"$BIN" cli cleanup.tidy

# Or decide one cluster yourself:
"$BIN" cli cleanup.merge KEEP_ID "ID_A,ID_B"     # keep one, delete the copies
"$BIN" cli cleanup.ignore duplicate "KEY"        # "these two are real purchases"
"$BIN" cli cleanup.restore                        # undo every dismissal
```

`cleanup.tidy` is non-destructive. `cleanup.merge` is the destructive one: the
removed rows are gone, so prefer `cleanup.tidy` or `entries.archive`.

## Flags the GUI toggles per row

```sh
# Excluded: still visible, but out of every total (card repayments, refunds).
"$BIN" cli entries.exclude ID_A,ID_B true
# Archived: set aside by the tidy-up; hidden from the everyday lists.
"$BIN" cli entries.archive ID_A true

# Re-label rows, and re-run the keyword rules over everything.
"$BIN" cli entries.recategorize ID_A,ID_B "餐饮/咖啡"
"$BIN" cli rules.apply

# Link an incoming refund to the purchase it reverses. The refund row is folded
# into the purchase (amount, date), so the purchase's cost drops by that amount.
"$BIN" cli entries.link-refund PURCHASE_ID '{"sourceId":"REFUND_ID","amount":3000,"date":"2026-11-19"}'
```

## Stocks and accounts

```sh
"$BIN" cli stocks.list
"$BIN" cli stocks.add '{"id":"sh600519","code":"600519","name":"贵州茅台","market":"a"}'
"$BIN" cli stocks.update STOCK_ID '{"name":"贵州茅台酒"}'
"$BIN" cli stocks.reorder sh600519,hk00700      # the watchlist order
"$BIN" cli stocks.clear                          # also clears positions
"$BIN" cli stocks.alert STOCK_ID '{"targetPrice":1800,"enabled":true}'
"$BIN" cli stocks.alert STOCK_ID '{"enabled":false}'

"$BIN" cli accounts.list
"$BIN" cli accounts.add '{"name":"主账户"}'
"$BIN" cli accounts.position ACCOUNT_ID STOCK_ID '{"costPrice":1500,"shares":100}'
"$BIN" cli accounts.position ACCOUNT_ID STOCK_ID '{"delete":true}'
```

## Market data

Read-only, straight from the same feeds the app uses.

```sh
"$BIN" cli stocks.search 茅台 --limit 10
"$BIN" cli market.quotes sh600519,hk00700
"$BIN" cli market.chart sh600519                 # intraday minute points
"$BIN" cli market.kline sh600519 week            # day | week | month
"$BIN" cli market.sessions                       # which markets are open now
```

`market.quotes` accepts ids that are not on the watchlist yet, which is the way
to price a candidate before `stocks.add`.

`assets.show` is the 总览 page's net-worth panel: every holding valued at its
live quote, converted into the ledger's display currency, plus the manual
balances. Money fields are integer cents.

```sh
"$BIN" cli assets.show
# {"currency":"CNY","stocks":[...],"stockValue":14857500,"stockCost":14000000,
#  "stockPnl":857500,"walletBalance":500000,"totalAssets":15357500}
```

When in doubt, run `doctor`, then read the relevant collection before changing
anything. Do not infer current month from the machine clock without stating the
actual date range used.
