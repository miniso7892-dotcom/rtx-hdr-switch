/*
 * RTX HDR 开关 —— 诊断页：本地组件、NVIDIA 原始状态、显示器、借用、指定标签页（?tab=<id>）各 frame 的报告、
 * 修改记录、闹钟、存储用量、更新检查和设置。数据由 background 拼好（diag snapshot）。
 * 页面上显示的就是「复制诊断信息」复制的内容：默认经 L.diagRedact 脱敏，勾选「包含网址和设备名」才用原文
 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const I = globalThis.RtxHdrI18n;
  const $ = (id) => document.getElementById(id);
  // 显示和复制时换成本地时间的时间戳字段
  const TIME_KEYS = new Set(['at', 'ts', 'checkedAt', 'retryAt', 'snoozeUntil', 'savedAt', 'seenAt', 'scheduledTime', 'exportedAt']);

  let uiLanguage = '';
  try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = navigator.language || ''; }
  let lang = 'zh';
  let settings = L.mergeSettings(null);
  let snap = null; // background 回复的快照（原文）
  let loading = false;
  const msgTimers = {};
  const t = (key, params) => I.t(lang, key, params);
  const asked = /^\?tab=(\d{1,10})$/.exec(location.search);
  const tabId = asked ? Number(asked[1]) : null;

  function call(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  function applyI18n() {
    lang = I.resolve(settings.ui.lang, uiLanguage);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    const ink = L.accentInk(settings.ui.accent);
    const st = document.documentElement.style;
    st.setProperty('--accent', ink.accent);
    st.setProperty('--on-accent', ink.on);
    st.setProperty('--accent-fg', ink.fg);
  }

  function message(id, text, warn, fade) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('warn', !!warn);
    clearTimeout(msgTimers[id]);
    if (text && fade) msgTimers[id] = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function localTime(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // 时间戳换成本地时间（新对象）
  function readable(v, key) {
    if (typeof v === 'number' && TIME_KEYS.has(key) && v > 1e12 && v < 1e14) return localTime(v);
    if (Array.isArray(v)) return v.map((x) => readable(x, key));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const k of Object.keys(v)) out[k] = readable(v[k], k);
    return out;
  }

  // 显示和复制的内容：默认脱敏
  function view() {
    if (!snap) return null;
    const data = Object.assign({ browser: navigator.userAgent }, snap);
    return readable($('raw').checked ? data : L.diagRedact(data), '');
  }

  function json(v) {
    return v === undefined ? '' : JSON.stringify(v, null, 2);
  }

  function setPre(id, v) {
    $(id).textContent = json(v);
  }

  // 本地组件的结论：正常、过旧、协议不匹配、缺 NVIDIA App、连不上（没装时另给一行重新安装的办法）
  function renderHost(check) {
    const c = check || { status: 'error', code: 'host-error', missingCaps: [] };
    let text;
    let hint = '';
    if (c.status === 'ok') text = t('diag.hostOk', { version: c.version });
    else if (c.status === 'old') {
      text = t('diag.hostOld', { version: c.version || '?' });
      if (c.missingCaps.length) hint = t('diag.missingCaps', { caps: c.missingCaps.join(', ') });
    } else if (c.status === 'protocol') text = t('diag.hostProtocol');
    else if (c.status === 'no-dll') text = t('diag.hostNoDll');
    else if (c.code === 'host-missing') {
      text = L.nvErrorText({ code: 'host-missing' }, lang);
      hint = t('diag.hostMoved');
    } else text = t('diag.hostError', { err: L.nvErrorText({ code: c.code || 'host-error' }, lang) });
    const v = $('host-verdict');
    v.textContent = text;
    v.classList.toggle('warn', c.status !== 'ok');
    $('host-hint').textContent = hint;
    $('host-hint').hidden = !hint;
  }

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  // 修改记录：新的在上。每条：时间、来源、名称（预设、配置档、网站）、改了什么；撤销过的划掉，失败的写原因
  function renderLog(list, rawList) {
    const ol = $('log-list');
    ol.textContent = '';
    const items = Array.isArray(list) ? list.slice().reverse() : [];
    const raws = Array.isArray(rawList) ? rawList.slice().reverse() : [];
    if (!items.length) {
      const li = document.createElement('li');
      li.appendChild(span('lbl', '—'));
      ol.appendChild(li);
      return;
    }
    items.forEach((e, i) => {
      const raw = raws[i] || {};
      const li = document.createElement('li');
      if (raw.undone) li.className = 'undone';
      li.appendChild(span('time', typeof raw.at === 'number' ? localTime(raw.at).slice(11) : ''));
      li.appendChild(span('src', t('nv.source.' + raw.source)));
      // 撤销条目的 label 是发起撤销的来源（快捷键、弹窗、面板）；离开网站时恢复设置的 label 是内部标记 restore
      const label = raw.source === 'undo' && L.NV_SOURCES.indexOf(e.label) >= 0 ? t('nv.source.' + e.label)
        : raw.source === 'site' && raw.label === 'restore' ? t('bg.siteRestore') : e.label;
      if (label) li.appendChild(span('lbl', label));
      const change = L.nvChangeText(raw.after ? raw : { before: raw.before, after: raw.want }, lang);
      if (change) li.appendChild(span('chg', change));
      if (raw.error) li.appendChild(span('err', L.nvErrorText(raw.error, lang)));
      ol.appendChild(li);
    });
  }

  function renderUpdate(v) {
    const u = (snap && snap.update) || {};
    $('update-line').textContent = t('diag.version', { version: u.version || '', type: u.installType || '?' }) +
      (u.notice ? (lang === 'en' ? '. ' : '；') + t('update.title', { version: u.notice.version }) : '');
    $('btn-check').hidden = !(u.installType === 'development' && u.enabled);
    setPre('update-raw', v && v.update ? v.update.state : null);
  }

  function render() {
    const v = view();
    if (!v) return;
    $('sections').hidden = false;
    renderHost(snap.host && snap.host.check);
    setPre('host-raw', v.host);
    setPre('state-raw', v.state);
    setPre('displays-raw', v.displays);
    setPre('lease-raw', v.hdrOnly);
    $('sec-frames').hidden = !snap.tab;
    setPre('frames-raw', v.tab);
    renderLog(v.log, snap.log);
    setPre('alarms-raw', { alarms: v.alarms, schedule: v.schedule, site: v.site });
    const s = snap.storage || {};
    $('storage-line').textContent = t('diag.storageLine', {
      local: s.local == null ? '?' : s.local, session: s.session == null ? '?' : s.session, videos: s.videos, max: s.maxVideos
    });
    renderUpdate(v);
    setPre('settings-raw', { settings: v.settings, profiles: v.profiles });
  }

  async function load() {
    if (loading) return;
    loading = true;
    $('btn-refresh').disabled = true;
    message('msg', t('diag.loading'));
    try {
      const r = await chrome.runtime.sendMessage(Object.assign({ type: 'diag', op: 'snapshot' }, tabId !== null ? { tabId: tabId } : {}));
      if (!r || r.ok !== true) throw new Error((r && ((r.error && r.error.code) || r.code)) || 'error');
      snap = r;
      settings = L.mergeSettings(r.settings);
      applyI18n();
      render();
      message('msg', '');
    } catch (e) {
      message('msg', t('diag.failed', { err: (e && e.message) || '' }), true);
    } finally {
      loading = false;
      $('btn-refresh').disabled = false;
    }
  }

  async function copy() {
    const v = view();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(json(v));
      message('msg', t('diag.copied'), false, true);
    } catch (e) {
      message('msg', (e && e.message) || 'error', true);
    }
  }

  function updateText(res) {
    const r = res && res.result;
    if (r && r.ok === true) return res.notice ? t('update.title', { version: res.notice.version }) : t('update.upToDate');
    // 还在退避期（wait）：按上次的错误说原因（限流或服务器出错），没有记录时按限流说
    const e = res && res.state && res.state.lastError;
    const code = r && r.code === 'wait' ? (e && e.code === 'http' ? 'http' : 'rate') : r && r.code;
    if (code === 'http') {
      return t('update.err.http', { status: (e && e.status) || '?' });
    }
    const key = 'update.err.' + code;
    return Object.prototype.hasOwnProperty.call(I.DICT.zh, key) ? t(key) : t('diag.failed', { err: code || 'error' });
  }

  async function checkNow() {
    const btn = $('btn-check');
    btn.disabled = true;
    btn.textContent = t('update.checking');
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'update', op: 'check' });
    } catch (e) {
      res = null;
    }
    btn.disabled = false;
    btn.textContent = t('update.checkNow');
    const ok = !!(res && res.result && res.result.ok === true);
    message('update-msg', updateText(res), !ok);
    await load();
  }

  async function init() {
    try {
      const r = await chrome.storage.local.get('settings');
      settings = L.mergeSettings(r && r.settings);
    } catch (e) { /* 用默认值 */ }
    applyI18n();
    $('btn-refresh').addEventListener('click', load);
    $('btn-copy').addEventListener('click', copy);
    $('btn-check').addEventListener('click', checkNow);
    $('raw').addEventListener('change', render);
    await load();
  }

  init();
})();
