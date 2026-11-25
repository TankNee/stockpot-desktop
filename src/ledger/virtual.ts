/**
 * 长列表的窗口化计算。
 *
 * 流水页原来把当月的每一行都渲染出来：3200 条就是 3200 个 DOM 节点、三万多
 * 个子元素，光挂载就要 600ms 以上，而且点一下行、开一下弹窗、保存一次，
 * 全部要重渲染一遍——用户看到的就是「点一下卡一秒」。
 *
 * 这里只留纯计算：给定每一项的高度，算出哪几项落在视口里。行高是显式写死的
 * （见 ledger-window 的 ROW_H / DAY_H），所以前缀和是精确的，滚动时不会跳。
 */

/** 前缀和，第 i 项是前 i 项的高度和，长度 n+1。 */
export function offsetsOf(heights: number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) offsets[i + 1] = offsets[i] + heights[i];
  return offsets;
}

export interface Window {
  /** 第一条要渲染的下标（含）。 */
  start: number;
  /** 最后一条之后的下标（不含）。 */
  end: number;
  /** 起点以上的总高度，用来把渲染出来的那一截推到正确位置。 */
  padTop: number;
  /** 终点以下的总高度，用来撑住滚动条。 */
  padBottom: number;
}

/** 二分找第一个「底部超过 y」的项。 */
function firstBelow(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 视口里该渲染哪一段。
 *
 * `scrollTop` 是列表容器顶部相对滚动内容的位置（不是滚动条自己的 scrollTop，
 * 因为列表上方还有筛选栏）。`overscan` 是上下各多渲染的像素，用来盖住
 * 快速滚动时的那一两帧白屏。
 */
export function visibleRange(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 320,
): Window {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + viewportHeight + overscan;
  const start = Math.min(count, firstBelow(offsets, top));
  const end = Math.max(start, Math.min(count, firstBelow(offsets, bottom) + 1));
  return {
    start,
    end,
    padTop: offsets[start],
    padBottom: offsets[count] - offsets[end],
  };
}
