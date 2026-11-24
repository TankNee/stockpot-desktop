/** Which desktop we are running on.
 *
 *  The Rust side already knows the answer, but the webview needs it
 *  synchronously during the first render, so the entry module tags
 *  `<html data-platform="…">` before React mounts and everything else reads it
 *  from there. Keeping one attribute means CSS selectors, layout tweaks and the
 *  window-control components all agree on the platform. */
export type Platform = "windows" | "macos" | "linux";

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac OS X")) return "macos";
  return "linux";
}

export function tagPlatform(): Platform {
  const value = detectPlatform();
  document.documentElement.dataset.platform = value;
  return value;
}

export function platform(): Platform {
  const tagged = document.documentElement.dataset.platform;
  if (tagged === "windows" || tagged === "macos" || tagged === "linux") {
    return tagged;
  }
  return detectPlatform();
}

export const isWindows = () => platform() === "windows";
