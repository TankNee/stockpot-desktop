import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import { SettingsWindow } from "./settings-window";
import { TooltipProvider } from "./components/ui/tooltip";
import { LedgerProvider } from "./ledger/store";
import { LedgerWindow } from "./ledger/ledger-window";
import { StoreProvider } from "./store/app-store";
import { tagPlatform } from "./lib/platform";

// Both desktop windows share this entry, so the platform tag is set here too —
// the ledger and settings shells draw their own Windows caption buttons and
// need to know which OS they are on before the first render.
tagPlatform();

/** Both desktop windows share this entry.
 *
 *  A second HTML entry looked tidier but the bookkeeping window never booted in
 *  the native webview while this one always has — and one proven loader beats
 *  two. The window label picks the surface: it is synchronous metadata Tauri
 *  injects into every webview, unlike a URL fragment which the window builder
 *  may drop. */
function currentLabel(): string {
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label;
    if (label) return label;
  } catch {
    /* browser preview */
  }
  // Preview builds have no window metadata; the hash keeps them testable.
  return window.location.hash.replace("#", "") || "settings";
}

// Two independent signals: the window label (authoritative in the app) and the
// URL fragment (which the window builder also sets). Either one is enough, so a
// change in Tauri's metadata shape cannot silently swap the two windows.
const isLedger =
  currentLabel() === "ledger" || window.location.hash.replace("#", "") === "ledger";

function Root() {
  if (isLedger) {
    return (
      // Radix tooltips need a provider; the panel supplies one and the ledger
      // window is its own root.
      <TooltipProvider>
        <LedgerProvider>
          <LedgerWindow />
        </LedgerProvider>
      </TooltipProvider>
    );
  }
  return (
    <StoreProvider>
      <SettingsWindow />
    </StoreProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
