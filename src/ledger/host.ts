import { invoke } from "@tauri-apps/api/core";

/** The bookkeeping window's entire host surface.
 *
 *  Deliberately separate from `@/lib/api`: that module pulls in the stock
 *  window's notification and opener plugins, and importing it here made the
 *  whole page fail to evaluate under the ledger window's (correctly) narrower
 *  capabilities. A window should only be able to do what it needs. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function openSettingsWindow(): void {
  if (!isTauri) return;
  void invoke("open_settings").catch(() => {});
}

export function closeLedgerWindow(): void {
  if (!isTauri) return;
  void invoke("close_ledger").catch(() => {});
}

export function quitApp(): void {
  if (!isTauri) return;
  void invoke("quit_app").catch(() => {});
}
