import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import { App } from "./App";
import { StoreProvider } from "./store/app-store";
import { tagPlatform } from "./lib/platform";

// The panel window is transparent on macOS, where the OS draws the rounded
// popover, but opaque on Windows (see `src-tauri/tauri.windows.conf.json`).
// Tagging the document lets CSS and the window-chrome components adapt to
// whichever one is in use.
tagPlatform();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </React.StrictMode>,
);
