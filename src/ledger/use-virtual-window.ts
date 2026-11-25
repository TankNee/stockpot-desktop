import * as React from "react";
import { visibleRange, type Window } from "./virtual";

/**
 * 把「滚到哪了」变成渲染窗口。
 *
 * 列表上方还有筛选栏，所以不能直接用 `scrollTop`，得先算出列表容器相对滚动
 * 内容的位置。滚动事件每帧最多量一次——`getBoundingClientRect` 会强制布局，
 * 在用户滚动的时候反复量是最容易把帧率拖垮的做法。
 */
export function useVirtualWindow(
  viewport: HTMLElement | null,
  listRef: React.RefObject<HTMLElement | null>,
  offsets: number[],
  enabled: boolean,
): Window {
  const [frame, setFrame] = React.useState({ scrollTop: 0, listTop: 0, height: 0 });

  const measure = React.useCallback(() => {
    const el = viewport;
    const list = listRef.current;
    if (!el || !list) return;
    const listTop =
      list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    setFrame((prev) =>
      prev.scrollTop === el.scrollTop &&
      prev.height === el.clientHeight &&
      Math.abs(prev.listTop - listTop) < 0.5
        ? prev
        : { scrollTop: el.scrollTop, listTop, height: el.clientHeight },
    );
  }, [viewport, listRef]);

  // 用 layout effect：这一量要在首帧之前完成，否则先画出一屏只有几行的列表
  // 再补满，看起来就是闪了一下。
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const el = viewport;
    if (!el) return;
    measure();
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        measure();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [enabled, viewport, measure]);

  // 行数或筛选变了，列表在内容里的位置也可能变（筛选栏换行）
  React.useLayoutEffect(() => {
    if (!enabled) return;
    measure();
  }, [enabled, measure, offsets.length]);

  if (!enabled) {
    return { start: 0, end: offsets.length - 1, padTop: 0, padBottom: 0 };
  }
  return visibleRange(offsets, frame.scrollTop - frame.listTop, frame.height);
}
