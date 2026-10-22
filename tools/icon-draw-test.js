/*
 * icon-draw.js 自测，由 tools/icon-draw-test.html 加载；同一个文件也被页面当作 Worker 脚本启动，
 * 在 Worker 里用 importScripts 加载 icon-draw.js（与 service worker 的加载方式相同）再跑一遍。
 */
(function () {
  'use strict';

  const DEFAULT = [0xA9, 0x8B, 0xFF];
  const BG = [10, 10, 10], FG = [250, 250, 250], RING = [58, 58, 58];

  function px(img, x, y) {
    const i = (y * img.width + x) * 4;
    return Array.prototype.slice.call(img.data, i, i + 4);
  }

  // 公共检查：页面和 Worker 都跑。返回 [{ ok, name, detail }]
  function coreChecks(I) {
    const out = [];
    function check(name, ok, detail) { out.push({ ok: !!ok, name: name, detail: detail || '' }); }
    function rgbIs(name, img, x, y, rgb) {
      const p = px(img, x, y);
      check(name, p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2] && p[3] === 255, 'got ' + p.join(','));
    }

    check('RtxHdrIcon 已定义且冻结', I && Object.isFrozen(I) && typeof I.draw === 'function' &&
      typeof I.imageDataSet === 'function' && typeof I.normalizeAccent === 'function');
    check('DEFAULT_ACCENT', I.DEFAULT_ACCENT === '#A98BFF', I.DEFAULT_ACCENT);

    [['#a98bff', '#A98BFF'], ['#abc', '#AABBCC'], ['abc', '#AABBCC'], [' #123456 ', '#123456'],
      ['red', '#A98BFF'], ['#12345', '#A98BFF'], ['#ggg', '#A98BFF'], ['', '#A98BFF'],
      [null, '#A98BFF'], [undefined, '#A98BFF'], [{}, '#A98BFF']].forEach(function (c) {
      check('normalizeAccent(' + JSON.stringify(c[0]) + ')', I.normalizeAccent(c[0]) === c[1], I.normalizeAccent(c[0]));
    });

    [16, 24, 32, 48, 64, 128].forEach(function (n) {
      const img = I.draw(n);
      check('draw(' + n + ') 尺寸', img instanceof ImageData && img.width === n && img.height === n);
    });
    [0, -1, 16.5, 'abc', NaN, 2000].forEach(function (n) {
      let err = null;
      try { I.draw(n); } catch (e) { err = e; }
      check('draw(' + String(n) + ') 抛 RangeError', err instanceof RangeError);
    });

    const i16 = I.draw(16);
    const a = px(i16, 0, 0)[3];
    check('16px 圆角处半透明', a > 0 && a < 255, 'alpha ' + a);
    rgbIs('16px 左半是白色', i16, 4, 6, FG);
    rgbIs('16px 右半挖空是底色', i16, 10, 7, BG);
    rgbIs('16px 分隔条是默认主题色', i16, 7, 7, DEFAULT);

    const i128 = I.draw(128, '#FF0000');
    rgbIs('128px 外圈描边', i128, 1, 64, RING);
    rgbIs('128px 描边内侧是底色', i128, 5, 64, BG);
    rgbIs('128px 左半白色', i128, 40, 64, FG);
    rgbIs('128px 分隔条用传入的主题色', i128, 64, 64, [255, 0, 0]);
    rgbIs('128px 右半挖空', i128, 90, 64, BG);
    rgbIs('128px 屏幕右边框', i128, 107, 64, FG);
    rgbIs('不合法主题色退回默认', I.draw(128, 'nope'), 64, 64, DEFAULT);
    rgbIs('32px 没有外圈描边', I.draw(32), 0, 16, BG);

    const set = I.imageDataSet('#0f0');
    check('imageDataSet 只有 16/32', Object.keys(set).join(',') === '16,32', Object.keys(set).join(','));
    check('imageDataSet 尺寸', set[16].width === 16 && set[32].width === 32);
    rgbIs('imageDataSet 用传入的主题色', set[32], 15, 16, [0, 255, 0]);
    const dotted = I.imageDataSet('#0f0', { dot: true });
    rgbIs('dot：右上角主题色小点（32）', dotted[32], 25, 7, [0, 255, 0]);
    rgbIs('dot：右上角主题色小点（16）', dotted[16], 12, 3, [0, 255, 0]);
    rgbIs('dot：小点外圈是底色（压住屏幕边框）', dotted[32], 19, 8, BG);
    rgbIs('没有 dot 时这里是屏幕边框', set[32], 19, 8, FG);
    rgbIs('dot：分隔条不受影响', dotted[32], 15, 16, [0, 255, 0]);
    rgbIs('没有 dot 时右上角是屏幕边框', set[32], 25, 7, FG);
    return out;
  }

  // ---------- Worker ----------
  if (typeof document === 'undefined') {
    let results;
    try {
      importScripts('../icon-draw.js');
      results = coreChecks(self.RtxHdrIcon);
    } catch (e) {
      results = [{ ok: false, name: 'Worker 里加载/运行 icon-draw.js', detail: String(e && e.stack || e) }];
    }
    self.postMessage(results);
    return;
  }

  // ---------- 页面 ----------
  // 和 icons/*.png 逐像素比较（按预乘 alpha 比，避免半透明像素反预乘的舍入误差）。
  // 底板四角的像素单独统计：Chrome 画弧线的抗锯齿与精确面积略有出入
  async function compareWithPng(I, n) {
    const res = await fetch('../icons/icon' + n + '.png');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
    c.drawImage(bmp, 0, 0);
    const png = c.getImageData(0, 0, n, n).data;
    const got = I.draw(n).data;
    const zone = Math.ceil(14 * n / 128) + 1;
    let body = 0, corner = 0;
    for (let i = 0; i < got.length; i += 4) {
      let d = Math.abs(got[i + 3] - png[i + 3]);
      for (let ch = 0; ch < 3; ch++) d = Math.max(d, Math.abs(got[i + ch] * got[i + 3] - png[i + ch] * png[i + 3]) / 255);
      const x = (i / 4) % n, y = Math.floor(i / 4 / n);
      const inCorner = (x < zone || x >= n - zone) && (y < zone || y >= n - zone);
      if (inCorner) corner = Math.max(corner, d); else body = Math.max(body, d);
    }
    return { body: Math.round(body * 10) / 10, corner: Math.round(corner * 10) / 10 };
  }

  function preview(I) {
    const box = document.getElementById('preview');
    ['#A98BFF', '#4FC3F7', '#FF5252', '#FFD54F', '#FAFAFA'].forEach(function (accent) {
      [['dark', '#202124'], ['light', '#F1F3F4']].forEach(function (bg) {
        const row = document.createElement('div');
        row.className = 'row';
        row.style.background = bg[1];
        row.title = accent + ' on ' + bg[0];
        [16, 32, 48, 128].forEach(function (n) {
          const img = I.draw(n, accent);
          const cv = document.createElement('canvas');
          cv.width = cv.height = n;
          cv.getContext('2d').putImageData(img, 0, 0);
          row.appendChild(cv);
          if (n <= 32) { // 放大 4 倍看像素
            const z = cv.cloneNode();
            z.getContext('2d').putImageData(img, 0, 0);
            z.className = 'zoom';
            z.style.width = z.style.height = n * 4 + 'px';
            row.appendChild(z);
          }
        });
        box.appendChild(row);
      });
    });
  }

  async function run() {
    const I = window.RtxHdrIcon;
    const results = coreChecks(I);
    const skipped = [];

    for (const n of [16, 32, 48, 128]) {
      try {
        const r = await compareWithPng(I, n);
        results.push({ ok: r.body <= 4 && r.corner <= 64, name: 'draw(' + n + ') 与 icons/icon' + n + '.png 一致',
          detail: '圆角以外最大差 ' + r.body + '（应 ≤4），圆角处最大差 ' + r.corner + '（应 ≤64）' });
      } catch (e) {
        skipped.push('与 icons/icon' + n + '.png 比较（' + e.message + '；用 http:// 或扩展页面打开才能比较）');
      }
    }

    try {
      const worker = new Worker('icon-draw-test.js');
      const wr = await new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error('timeout')); }, 5000);
        worker.onmessage = function (e) { clearTimeout(t); resolve(e.data); };
        worker.onerror = function (e) { clearTimeout(t); e.preventDefault(); reject(new Error(e.message || 'worker error')); };
      });
      worker.terminate();
      wr.forEach(function (r) { results.push({ ok: r.ok, name: '[Worker] ' + r.name, detail: r.detail }); });
    } catch (e) {
      skipped.push('Worker + importScripts（' + e.message + '）');
    }

    preview(I);
    const failed = results.filter(function (r) { return !r.ok; });
    const lines = [(failed.length ? 'FAIL ' + failed.length + '/' : 'PASS ') + results.length + ' checks' +
      (skipped.length ? '，跳过 ' + skipped.length : '')];
    results.forEach(function (r) { lines.push((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? '  — ' + r.detail : '')); });
    skipped.forEach(function (s) { lines.push('skip ' + s); });
    document.getElementById('result').textContent = lines.join('\n');
    document.getElementById('result').className = failed.length ? 'fail' : 'pass';
    document.title = lines[0];
  }

  run().catch(function (e) {
    document.getElementById('result').textContent = 'FAIL ' + (e && e.stack || e);
    document.title = 'FAIL';
  });
})();
