import * as React from "react";
import { cn } from "@/lib/utils";

/** 滚动视口本身。长列表要拿它算「现在滚到哪了」，所以挂到 context 上，
 *  免得每个页面自己去 `parentElement` 里瞎猜。 */
const ViewportContext = React.createContext<HTMLDivElement | null>(null);

export function useScrollViewport(): HTMLDivElement | null {
  return React.useContext(ViewportContext);
}

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
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);
  const [thumb, setThumb] = React.useState<{ top: number; height: number } | null>(null);
  const [active, setActive] = React.useState(false);
  const hideTimer = React.useRef<number | null>(null);
  // 上一次画出来的滚动条形状。内容一多，MutationObserver 会在一次提交里
  // 连发好几批；形状没变就别 setState，否则每批都要多渲染一轮。
  const drawn = React.useRef("");

  const measure = React.useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) {
      if (drawn.current !== "none") {
        drawn.current = "none";
        setThumb(null);
      }
      return;
    }
    const height = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = clientHeight - height;
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    // 半像素以下的变化看不出来，不值得重新渲染
    const next = `${Math.round(top * 2)}:${Math.round(height * 2)}`;
    if (next === drawn.current) return;
    drawn.current = next;
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

  const queued = React.useRef(false);
  const onScroll = () => {
    // 滚动事件比帧还密；每帧最多量一次，别在用户手指底下反复强制布局
    if (!queued.current) {
      queued.current = true;
      requestAnimationFrame(() => {
        queued.current = false;
        measure();
      });
    }
    setActive(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setActive(false), 900);
  };

  React.useEffect(() => {
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  const attach = React.useCallback((node: HTMLDivElement | null) => {
    viewport.current = node;
    setElement(node);
  }, []);

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={attach}
        onScroll={onScroll}
        className={cn(
          "h-full overflow-y-auto overflow-x-hidden",
          // Hide the native bar in both engines; the thumb below replaces it.
          "[scrollbar-width:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0",
          contentClassName,
        )}
      >
        <ViewportContext.Provider value={element}>{children}</ViewportContext.Provider>
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
