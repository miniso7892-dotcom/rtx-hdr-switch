/* RTX HDR 开关 —— 界面小工具（弹窗和播放器面板共用）：只操作 DOM，不访问扩展接口 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;

  // 每秒刷新一次的界面：只在内容真的变了时才写 DOM，免得读屏软件反复朗读
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  function setClass(el, cls) {
    if (el.className !== cls) el.className = cls;
    return el;
  }

  function setNum(el, v) {
    const s = String(v);
    if (el.value !== s) el.value = s;
  }

  function setAttr(el, name, v) {
    const s = String(v);
    if (el.getAttribute(name) !== s) el.setAttribute(name, s);
  }

  // 滑块轨道上的填充：单向的从左端到滑块，正负对称的（对比度、饱和度）从中点到滑块
  function sliderFill(el) {
    const min = Number(el.min), max = Number(el.max), v = Number(el.value);
    const pct = max > min ? Math.min(100, Math.max(0, (v - min) / (max - min) * 100)) : 0;
    const bipolar = min < 0 && max > 0;
    el.style.setProperty('--a', (bipolar ? Math.min(50, pct) : 0) + '%');
    el.style.setProperty('--b', (bipolar ? Math.max(50, pct) : pct) + '%');
  }

  function signed(n) {
    return n > 0 ? '+' + n : String(n);
  }

  // items: [[value, text, disabled?]]；选项变了才重建，免得打断正在用的下拉框
  function fillSelect(el, items, value) {
    const sig = JSON.stringify(items);
    if (el.dataset.sig !== sig) {
      el.textContent = '';
      for (const it of items) {
        const o = document.createElement('option');
        o.value = it[0];
        o.textContent = it[1];
        if (it[2]) o.disabled = true;
        el.appendChild(o);
      }
      el.dataset.sig = sig;
    }
    if (el.value !== value) el.value = value;
  }

  /**
   * 分段按钮（一组 radio）。items: [[value, text]]；
   * opts: {className?, label?（aria-label）, labelledBy?, value?（选中的值）}。返回 .seg 元素
   */
  function segment(name, items, opts) {
    const o = opts || {};
    const seg = document.createElement('span');
    seg.className = 'seg' + (o.className ? ' ' + o.className : '');
    seg.setAttribute('role', 'radiogroup');
    if (o.labelledBy) seg.setAttribute('aria-labelledby', o.labelledBy);
    else if (o.label) seg.setAttribute('aria-label', o.label);
    for (const it of items) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = String(it[0]);
      if (o.value !== undefined && String(o.value) === input.value) input.checked = true;
      const span = document.createElement('span');
      span.textContent = it[1];
      label.appendChild(input);
      label.appendChild(span);
      seg.appendChild(label);
    }
    return seg;
  }

  /**
   * 一行 NVIDIA 滑块：标签 | 滑块 | 读数。范围默认取 L.NV_RANGES.hdr[field]（最高亮度用实时范围时由调用方改 min/max）。
   * opts: {id, field, label, min?, max?, step?, numLabel?}。给了 numLabel 时读数是可输入的数字框（id + '-num'，
   * numLabel 是它的 aria-label），否则是 <output>（id + '-out'）。返回 {row, input, out}
   */
  function sliderRow(opts) {
    const r = L.NV_RANGES.hdr[opts.field] || { min: 0, max: 100 };
    const row = document.createElement('div');
    row.className = 'slider-row';
    const label = document.createElement('label');
    label.htmlFor = opts.id;
    label.textContent = opts.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = opts.id;
    input.min = String(opts.min !== undefined ? opts.min : r.min);
    input.max = String(opts.max !== undefined ? opts.max : r.max);
    input.step = String(opts.step || 1);
    input.dataset.field = opts.field;
    let out;
    if (opts.numLabel) {
      out = document.createElement('input');
      out.type = 'number';
      out.className = 'val';
      out.id = opts.id + '-num';
      out.min = input.min;
      out.max = input.max;
      out.step = '1';
      out.inputMode = 'numeric';
      out.setAttribute('aria-label', opts.numLabel);
    } else {
      out = document.createElement('output');
      out.className = 'val';
      out.id = opts.id + '-out';
      out.htmlFor = opts.id;
      out.setAttribute('aria-hidden', 'true');
    }
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(out);
    return { row: row, input: input, out: out };
  }

  // 主题色写进 CSS 变量（--accent 背景、--on-accent 背景上的字、--accent-fg 深色底上的字）
  function applyTheme(rootEl, hex) {
    const ink = L.accentInk(hex);
    const st = rootEl.style;
    st.setProperty('--accent', ink.accent);
    st.setProperty('--on-accent', ink.on);
    st.setProperty('--accent-fg', ink.fg);
  }

  globalThis.RtxHdrUi = Object.freeze({
    setText: setText,
    setClass: setClass,
    setNum: setNum,
    setAttr: setAttr,
    sliderFill: sliderFill,
    signed: signed,
    fillSelect: fillSelect,
    segment: segment,
    sliderRow: sliderRow,
    applyTheme: applyTheme
  });
})();
