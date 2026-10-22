/*
 * RTX HDR 开关 —— 运行时画工具栏图标（方案 C · 高反差信号），分隔条用当前主题色。
 * 经典脚本（不是 ES module）：service worker 里 importScripts('icon-draw.js')，页面里 <script src="icon-draw.js">。
 *
 *   self.RtxHdrIcon.draw(size, accent, opts)         → ImageData（size×size，size 为 1..1024 的整数，否则抛 RangeError）
 *   self.RtxHdrIcon.imageDataSet(accent, opts)       → { 16: ImageData, 32: ImageData }，可直接给 chrome.action.setIcon({ imageData })
 *     opts.dot：右上角加一个主题色小点（有新版本），外面一圈底色把它和屏幕边框隔开；不占用角标文字
 *   self.RtxHdrIcon.normalizeAccent(accent) → '#RRGGBB'（不合法时退回 DEFAULT_ACCENT）
 *   self.RtxHdrIcon.DEFAULT_ACCENT          → '#A98BFF'
 *
 * accent 接受 #RGB / #RRGGBB（与 lib.js 的 normAccent 相同：# 可省略、不分大小写、两端空白忽略），其它值一律用 #A98BFF。
 * 几何与 tools/make_icons.py 相同：128×128 viewBox；16/32/48 px 用各自微调过的版本，其它尺寸按 128 的几何缩放；
 * 48 px 及以上在外圈加一道 #3A3A3A 描边。改几何时两边一起改。
 * 矩形全部用 fillRect 画（Chrome 对单个矩形按精确面积抗锯齿），所以默认主题色的结果与 icons/*.png 逐像素一致，
 * 只有底板圆角上的几个像素因 Chrome 的弧线抗锯齿略有出入。
 */
(function (root) {
  'use strict';

  const DEFAULT_ACCENT = '#A98BFF';
  const BG = '#0A0A0A';
  const RING = '#3A3A3A';
  const FG = '#FAFAFA';
  const VIEW = 128;
  const CORNER = 14;
  const MAX_SIZE = 1024;

  // screen=[x, y, w, h] 是屏幕外框（描边居中，宽 stroke），fill 是实心的左半，bar 是主题色分隔条
  const BASE = { stroke: 6, screen: [21, 33, 86, 62], fill: [18, 30, 46, 68], bar: [60, 18, 9, 92] };
  // 提醒小点：圆心、半径、底色外圈的半径（128 的 viewBox）
  const DOT = { cx: 100, cy: 28, r: 19, ring: 28 };
  const VARIANTS = {
    16: { stroke: 14, screen: [20, 32, 88, 64], fill: [13, 25, 51, 78], bar: [56, 10, 17, 108] },
    32: { stroke: 10, screen: [21, 33, 86, 62], fill: [16, 28, 48, 72], bar: [58, 14, 13, 100] },
    48: { stroke: 6, screen: [21, 33, 86, 62], fill: [18, 30, 46, 68], bar: [59, 16, 11, 96] }
  };

  function normalizeAccent(v) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v == null ? '' : v).trim());
    if (!m) return DEFAULT_ACCENT;
    const h = m[1].length === 3 ? m[1].replace(/./g, function (c) { return c + c; }) : m[1];
    return '#' + h.toUpperCase();
  }

  // 外圈描边宽度（px）：48 px 时 1 px，128 px 时 3 px；更小的尺寸不加
  function ringWidth(size) {
    return size >= 48 ? Math.max(1, Math.round(size * 3 / VIEW)) : 0;
  }

  function fillRoundRect(ctx, x, y, w, h, r, color) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function fillCircle(ctx, cx, cy, r, color) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function draw(size, accent, opts) {
    const n = Number(size);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SIZE) {
      throw new RangeError('RtxHdrIcon.draw: size must be an integer in 1..' + MAX_SIZE + ', got ' + size);
    }
    const g = VARIANTS[n] || BASE;
    const k = n / VIEW;
    // willReadFrequently：走 CPU 光栅，结果不随 GPU 变化，getImageData 也快
    const ctx = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
    const ring = ringWidth(n);
    const radius = CORNER * k;

    // 底板；有外圈时先整块铺描边色，再在里面铺底色
    fillRoundRect(ctx, 0, 0, n, n, radius, ring ? RING : BG);
    if (ring) fillRoundRect(ctx, ring, ring, n - 2 * ring, n - 2 * ring, Math.max(0, radius - ring), BG);

    // 屏幕：先按描边外沿铺满白色，再用底色把「描边内沿里、实心左半以右」的部分挖回来。
    // 实心左半的左/上/下边正好是描边外沿，分开画会在这些边上叠两遍抗锯齿；挖空区与外沿不共用像素，所以这样画是精确的
    const sw = g.stroke, s = g.screen, f = g.fill, b = g.bar;
    ctx.fillStyle = FG;
    ctx.fillRect((s[0] - sw / 2) * k, (s[1] - sw / 2) * k, (s[2] + sw) * k, (s[3] + sw) * k);
    const hx0 = Math.max(s[0] + sw / 2, f[0] + f[2]);
    const hx1 = s[0] + s[2] - sw / 2;
    ctx.fillStyle = BG;
    ctx.fillRect(hx0 * k, (s[1] + sw / 2) * k, (hx1 - hx0) * k, (s[3] - sw) * k);

    // 主题色分隔条
    ctx.fillStyle = normalizeAccent(accent);
    ctx.fillRect(b[0] * k, b[1] * k, b[2] * k, b[3] * k);

    if (opts && opts.dot) {
      fillCircle(ctx, DOT.cx * k, DOT.cy * k, DOT.ring * k, BG);
      fillCircle(ctx, DOT.cx * k, DOT.cy * k, DOT.r * k, normalizeAccent(accent));
    }

    return ctx.getImageData(0, 0, n, n);
  }

  function imageDataSet(accent, opts) {
    const a = normalizeAccent(accent);
    const o = { dot: !!(opts && opts.dot) };
    return { 16: draw(16, a, o), 32: draw(32, a, o) };
  }

  const api = Object.freeze({
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    normalizeAccent: normalizeAccent,
    draw: draw,
    imageDataSet: imageDataSet
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RtxHdrIcon = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
