/** Copy text to the clipboard.
 *
 *  Order matters:
 *
 *  1. The Tauri clipboard plugin writes through the OS, so it works even when
 *     the settings window is not the focused one (Chromium's web API rejects
 *     those with `NotAllowedError: Document is not focused`).
 *  2. Inside a plain browser preview (and anywhere the plugin is unavailable)
 *     fall back to `navigator.clipboard`, then to the legacy textarea +
 *     `execCommand("copy")` path.
 *
 *  Returns whether the copy actually happened, so the caller can say so. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch {
    /* Not in the Tauri webview, or the plugin is missing: try the web APIs. */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
