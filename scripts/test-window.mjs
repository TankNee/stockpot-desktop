/**
 * 窗口化计算的自检。
 *
 *   node scripts/test-window.mjs
 *
 * 这部分是纯函数，但错一点用户就会看到「滚到一半空白」或者「滚不动」，
 * 所以把边界都钉死：空列表、正好一屏、屏幕外的位置、高度不均的行。
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { offsetsOf, visibleRange } = jiti("../src/ledger/virtual.ts");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log("\n窗口化");

check("前缀和是逐项累加，长度比行数多一", () => {
  assert.deepEqual(offsetsOf([10, 20, 30]), [0, 10, 30, 60]);
  assert.deepEqual(offsetsOf([]), [0]);
});

check("空列表什么都不渲染", () => {
  assert.deepEqual(visibleRange(offsetsOf([]), 0, 500), {
    start: 0,
    end: 0,
    padTop: 0,
    padBottom: 0,
  });
});

check("一屏装得下就全渲染", () => {
  const offsets = offsetsOf(new Array(10).fill(20)); // 200px
  const win = visibleRange(offsets, 0, 500, 0);
  assert.equal(win.start, 0);
  assert.equal(win.end, 10);
  assert.equal(win.padTop, 0);
  assert.equal(win.padBottom, 0);
});

check("滚到中间只渲染那一截，上下留白补足高度", () => {
  const offsets = offsetsOf(new Array(100).fill(10)); // 1000px，每行 10px
  const win = visibleRange(offsets, 500, 100, 0);
  assert.equal(win.start, 50);
  // 边界上那一行正好贴着视口底边，会多带一行出来；多渲染一行不影响观感
  assert.equal(win.end, 61);
  assert.equal(win.padTop, 500);
  assert.equal(win.padBottom, 390);
});

check("overscan 上下各多渲染一段，盖住快速滚动", () => {
  const offsets = offsetsOf(new Array(100).fill(10));
  const win = visibleRange(offsets, 500, 100, 30);
  assert.equal(win.start, 47);
  assert.equal(win.end, 64);
});

check("行高不一样也准（退款那行要高一点）", () => {
  const heights = [39, 44, 39, 44, 39]; // 共 205
  const offsets = offsetsOf(heights);
  assert.deepEqual(offsets, [0, 39, 83, 122, 166, 205]);
  const win = visibleRange(offsets, 83, 39, 0);
  assert.equal(win.start, 2); // 落在第三行（39+44=83 是它的顶部）
  assert.equal(win.end, 4);
});

check("滚过头不会渲染出界，也不会算出负的高度", () => {
  const offsets = offsetsOf(new Array(5).fill(10));
  const win = visibleRange(offsets, 10_000, 100, 0);
  assert.equal(win.start, 5);
  assert.equal(win.end, 5);
  assert.equal(win.padTop, 50);
  assert.equal(win.padBottom, 0);
});

check("任意位置：渲染出来的那一截必须盖住视口，且留白 + 渲染 + 留白 = 总高", () => {
  const heights = new Array(257).fill(0).map((_, i) => (i % 7 === 0 ? 44 : 39));
  const offsets = offsetsOf(heights);
  const total = offsets[offsets.length - 1];
  const viewport = 673;
  for (let scrollTop = 0; scrollTop < total; scrollTop += 97) {
    const win = visibleRange(offsets, scrollTop, viewport, 0);
    assert.ok(win.start >= 0 && win.end <= heights.length);
    // 第一行必须已经压住视口顶端，否则用户会看到上方空白
    assert.ok(offsets[win.start] <= scrollTop, `顶端露白 @${scrollTop}`);
    // 最后一行必须已经盖住视口底部
    assert.ok(offsets[win.end] >= Math.min(total, scrollTop + viewport), `底端露白 @${scrollTop}`);
    assert.equal(win.padTop + (offsets[win.end] - offsets[win.start]) + win.padBottom, total);
  }
});

console.log(`\n${passed} 项通过\n`);
