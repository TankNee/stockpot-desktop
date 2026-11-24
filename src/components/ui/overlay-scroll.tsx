import * as React from "react";
import { cn } from "@/lib/utils";

/** A scroll area with an overlay scrollbar.
 *
 *  The native bar on macOS takes layout width when permanent scrollbars are
 *  enabled in System Settings, and is always-on otherwise — both wrong for a
 *  dense ledger. This hides the native bar and draws a thin thumb that only
 *  appears while the user is scrolling, then fades out. It never affects layout
 *  because it is absolutely positioned over the content. */
export function OverlayScroll({
  children,
  className,
  contentClassName,
}: {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = React.useState<{ top: number; height: number } | null>(null);
  const [active, setActive] = React.useState(false);
  const hideTimer = React.useRef<number | null>(null);

  const measure = React.useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) {
      setThumb(null);
      return;
    }
    const height = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = clientHeight - height;
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setThumb({ top, height });
  }, []);

  React.useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Children change height without a resize of the viewport itself.
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [measure]);

  const onScroll = () => {
    measure();
    setActive(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setActive(false), 900);
  };

  React.useEffect(() => {
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={viewport}
        onScroll={onScroll}
        className={cn(
          "h-full overflow-y-auto overflow-x-hidden",
          // Hide the native bar in both engines; the thumb below replaces it.
          "[scrollbar-width:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0",
          contentClassName,
        )}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-0 top-0 z-20 w-[6px] pr-[2px] transition-opacity duration-300",
          active && thumb ? "opacity-100" : "opacity-0",
        )}
        style={{ height: "100%" }}
      >
        {thumb ? (
          <div
            className="w-[3px] rounded-full bg-[color-mix(in_oklch,var(--foreground)_26%,transparent)]"
            style={{ marginTop: thumb.top, height: thumb.height }}
          />
        ) : null}
      </div>
    </div>
  );
}
