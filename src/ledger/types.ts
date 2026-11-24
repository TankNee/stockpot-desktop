/** Shared shapes for the bookkeeping window. Money crosses the IPC boundary as
 *  integer cents so sums never drift. */
export type EntryKind = "expense" | "income" | "transfer";
export type EntrySource = "manual" | "wechat" | "alipay" | "icost";

export interface LedgerEntry {
  id: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:MM`, empty when the row is date-only. */
  time: string;
  kind: EntryKind;
  /** Cents, always positive. */
  amount: number;
  category: string;
  account: string;
  counterparty: string;
  note: string;
  source: EntrySource;
  externalId: string;
  excluded: boolean;
  /** Set aside by 整理账单's automatic tidy: the row is kept on disk but no
   *  longer counts toward totals or appears in the everyday lists. */
  archived?: boolean;
  /** Cents already returned against this row. */
  refundedAmount?: number;
  /** `YYYY-MM-DD` of the latest linked refund. */
  refundedAt?: string;
  /** A human chose this category; automatic re-labelling skips it. */
  categoryLocked?: boolean;
  createdAt: string;
  /** Optional project grouping, independent of category. */
  projectId?: string;
}

export interface ImportRecord {
  id: string;
  file: string;
  source: EntrySource;
  added: number;
  skipped: number;
  importedAt: string;
}

/** `debit` | `credit` | `cash` | `investment` | `pension` | `provident` | `medical` | `other` */
export type WalletKind =
  | "debit"
  | "credit"
  | "cash"
  | "investment"
  | "pension"
  | "provident"
  | "medical"
  | "other";

export interface Wallet {
  id: string;
  name: string;
  kind: WalletKind;
  institution: string;
  /** Cents; credit cards store what is owed as a negative number. */
  balance: number;
  note: string;
  updatedAt: string;
}

export interface RefundLinkInput {
  entryId: string;
  /** An unmatched refund row to consume, if the user picked one. */
  sourceId?: string;
  /** Cents; ignored when sourceId is set. Zero clears the link. */
  amount: number;
  date: string;
}

export interface WalletInput {
  name: string;
  kind: WalletKind;
  institution: string;
  balance: number;
  note: string;
}

/** A category is a group plus an optional leaf; entries store `group/leaf`. */
export interface CategoryDef {
  name: string;
  parent: string;
  kind: "" | "expense" | "income";
  icon: string;
  description: string;
}

/** A keyword → category rule, applied when a bill is imported. */
export interface Rule {
  id: string;
  pattern: string;
  category: string;
}

export interface Project {
  id: string;
  name: string;
  note: string;
  startDate: string;
  endDate: string;
  archived: boolean;
  createdAt: string;
}

export interface ProjectInput {
  name: string;
  note: string;
  startDate: string;
  endDate: string;
  archived: boolean;
}

export interface Ledger {
  entries: LedgerEntry[];
  projects: Project[];
  rules: Rule[];
  categories: CategoryDef[];
  accounts: string[];
  imports: ImportRecord[];
  wallets: Wallet[];
}

export interface LedgerState {
  ledger: Ledger;
  dataDir: string;
  /** `light` | `dark` | `system` — shared with the stock settings. */
  theme?: string;
  language?: string;
  colorScheme?: string;
}

export interface EntryInput {
  date: string;
  time: string;
  kind: EntryKind;
  amount: number;
  category: string;
  account: string;
  counterparty: string;
  note: string;
  excluded: boolean;
}

export interface ImportOutcome {
  ledger: Ledger;
  added: number;
  duplicates: number;
  ignored: number;
  refundsLinked: number;
  source: EntrySource;
}

/** One parsed row, as shown in the import confirmation dialog. */
export interface ImportPreviewRow {
  date: string;
  time: string;
  kind: EntryKind;
  /** Cents. */
  amount: number;
  counterparty: string;
  account: string;
  note: string;
}

/** What `ledger_preview_import` reports before anything is written. */
export interface ImportPreview {
  source: EntrySource;
  /** Rows the parser understood. */
  rows: number;
  /** Of those, rows that already exist and would be skipped. */
  duplicates: number;
  /** Rows in the file the parser had to skip (unparsable or closed). */
  ignored: number;
  /** Cents, over the new rows only. */
  expense: number;
  income: number;
  firstDate: string;
  lastDate: string;
  sample: ImportPreviewRow[];
}

/** Stock holdings priced for the asset panel. All money in cents. */
export interface AssetLine {
  id: string;
  name: string;
  market: string;
  shares: number;
  price: number;
  value: number;
  cost: number;
  pnl: number;
}

/** One stock account from the app settings, valued at current prices. */
export interface AssetAccount {
  id: string;
  name: string;
  holdings: number;
  value: number;
  cost: number;
  pnl: number;
}

export interface Assets {
  currency: string;
  lines: AssetLine[];
  accounts: AssetAccount[];
  marketValue: number;
  cost: number;
  pnl: number;
}

/** One cluster of rows that look like the same bill. */
export interface DuplicateGroup {
  key: string;
  amount: number;
  entries: LedgerEntry[];
  confidence: string;
}

export interface CleanupReport {
  duplicates: DuplicateGroup[];
  repayments: LedgerEntry[];
  total: number;
  /** How many findings the user has already dismissed. */
  ignored: number;
}

/** Result of resolving every duplicate cluster in one click. */
export interface AutoTidyOutcome {
  ledger: Ledger;
  /** Clusters that were resolved. */
  groups: number;
  /** Rows moved into the archive. */
  archived: number;
  /** The row kept from each cluster. */
  kept: string[];
  archivedIds: string[];
}

/** One row the model filed, waiting for review. */
export interface AiSuggestion {
  id: string;
  category: string;
  confidence: number;
  reason: string;
}

export interface AiResult {
  suggestions: AiSuggestion[];
  batches: number;
  errors: string[];
}
