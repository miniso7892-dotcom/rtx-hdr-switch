/* RTX HDR 开关 —— 弹窗 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const I = globalThis.RtxHdrI18n;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 1000;
  const IS_EDGE = /\bEdg\//.test(navigator.userAgent);
  const TAB_KEY = 'popupTab';
  const TABS = ['video', 'nv', 'rules'];
  const HDR_ONLY_KEY = 'hdrOnlyStatus'; // background 写：{active, leased, error?}
  const SDR_LAST_KEY = 'nvLastSdrWhite'; // 跟随 SDR 亮度：上次按它调过中间灰的白电平
  const NV_POLL_MS = 2000;
  const SDR_POLL_MS = 2000;
  const NV_THROTTLE_MS = 200; // 和 NVIDIA App 拖动滑块时一样
  // 下拉框：键盘在收起的下拉框上按方向键时每一步都触发 change，停这么久没再变才写入 / 保存
  const NV_DEBOUNCE_MS = 500;
  const NV_CONFIRM_MS = 4000; // 「删除」按第一次后等确认的时间
  const NV_TIMEOUT_MS = 8000;
  const NV_LAST_PRESET_KEY = 'nvLastPresetId';
  const NV_HOTKEY_ERROR_KEY = 'nvHotkeyError'; // 快捷键切换预设失败、页面上显示不了时 background 留下的提示
  const NV_HOTKEY_ERROR_MAX_AGE = 10 * 60 * 1000;
  const NV_SLIDERS = ['peak', 'middleGrey', 'contrast', 'saturation'];
  // 这些错误说明本地组件或 NVIDIA App 用不了，不再轮询
  const NV_FATAL = new Set(['host-missing', 'host-forbidden', 'no-dll', 'init', 'protocol']);
  // 文字由脚本随状态改写的元素：切换语言时不按 data-i18n 覆盖
  const DYNAMIC_TEXT = new Set(['video-message', 'nv-message', 'sdr-read', 'nv-delete']);

  let uiLanguage = '';
  try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = navigator.language || ''; }
  let lang = 'zh';
  const t = (key, params) => I.t(lang, key, params);

  let tabId = null;
  let tabHost = '';
  let usable = false;
  let isFile = false;
  let frameId = 0;
  let current = null;
  let settings = L.mergeSettings(null);
  let busy = false;
  let epoch = 0; // 每次用户操作 +1，丢弃操作前发出的刷新结果
  let commands = [];
  let hdrOnlyStatus = null;

  let nvMode = 'connecting'; // connecting | missing | error | ready
  let nvError = null;
  let nvState = null; // 最近读到的 State，叠加了还没确认的乐观修改
  let nvCaps = { display: false, hdrLease: false };
  let nvLink = null; // {port, waiters}：弹窗开着时常驻的本地组件进程
  let nvSeq = 0;
  let nvPortFails = 0;
  let nvUseBridge = false; // 端口用不了时改走 background（每次请求起一个进程）
  let nvDraft = null; // 节流期间攒着还没发的修改
  let nvQueued = null; // 等在途的 set 回来后再发的修改
  let nvDraftDone = []; // 随 nvDraft / nvQueued 一起走的回调：写完（或失败）后调用
  let nvQueuedDone = [];
  let nvWriting = false;
  let nvThrottle = 0;
  let nvDrag = null; // {id, start, moved}：正在拖的滑块
  let nvEpoch = 0; // 同 epoch：每次写入 +1，丢弃写入前发出的读取结果
  let nvPolling = false;
  let nvPollTimer = 0;
  let nvMsgTimer = 0;
  let nvSelectedId = null;
  let nvLastPresetId = null;
  let nvDeleteArmed = null; // {id, timer}：「删除」按了第一次，等再按一次确认
  let nvOverwriteName = null; // 已提示过「将覆盖」的同名预设，再保存一次才覆盖
  let saveTimer = 0;
  let accentTimer = 0;

  let sdrDisplays = null; // 本地组件 display 命令读到的显示器（规范化过）
  let sdrBusy = false;
  let sdrPollTimer = 0;
  let sdrLastWhite = null;
  let sdrMsgTimer = 0;

  function noop() {}

  function call(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  function scriptable(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (!/^(https?|file):$/.test(u.protocol)) return false;
    const h = u.hostname;
    if (h === 'chromewebstore.google.com') return false;
    if (h === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
    if (h === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) return false;
    return true;
  }

  function isState(st) {
    return !!st && typeof st === 'object' && st.ok === true;
  }

  // 每秒刷新一次：只在内容真的变了时才写 DOM，免得读屏软件反复朗读
  function setText(id, text) {
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  function setClass(id, cls) {
    const el = $(id);
    if (el.className !== cls) el.className = cls;
  }

  function radios(name) {
    return document.querySelectorAll('input[name="' + name + '"]');
  }

  // ---------- 语言与主题 ----------

  function applyI18n() {
    lang = I.resolve(settings.ui.lang, uiLanguage);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) {
      if (DYNAMIC_TEXT.has(el.id)) continue;
      const s = t(el.dataset.i18n);
      if (el.textContent !== s) el.textContent = s;
    }
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const i = pair.indexOf(':');
        if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      }
    }
    for (const r of radios('lang')) r.checked = r.value === settings.ui.lang;
  }

  function applyTheme(hex) {
    const ink = L.accentInk(hex || settings.ui.accent);
    const st = document.documentElement.style;
    st.setProperty('--accent', ink.accent);
    st.setProperty('--on-accent', ink.on);
    st.setProperty('--accent-fg', ink.fg);
  }

  function checkSvg(color) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M3.5 9.5 L7.5 13 L14.5 5');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '3');
    p.setAttribute('stroke-linecap', 'square');
    svg.appendChild(p);
    return svg;
  }

  function renderTheme() {
    applyTheme();
    const wrap = $('theme-swatches');
    if (!wrap.childElementCount) {
      for (const a of L.ACCENTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.hex = a.hex;
        b.dataset.name = a.id;
        b.style.setProperty('--c', a.hex);
        const svg = checkSvg(L.accentInk(a.hex).on);
        b.appendChild(svg);
        b.addEventListener('click', () => {
          clearTimeout(accentTimer);
          save((s) => { s.ui.accent = a.hex; });
        });
        wrap.appendChild(b);
      }
    }
    const accent = settings.ui.accent;
    let name = t('theme.customName');
    for (const b of wrap.children) {
      const on = b.dataset.hex === accent;
      if (on) name = t('theme.' + b.dataset.name);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', t('theme.' + b.dataset.name));
      b.firstChild.style.visibility = on ? 'visible' : 'hidden';
    }
    setText('theme-name', name);
    setText('theme-hex', accent);
    const input = $('theme-custom');
    if (document.activeElement !== input && input.value.toUpperCase() !== accent) input.value = accent.toLowerCase();
  }

  // ---------- 页签 ----------

  function selectTab(name, focus) {
    const tab = TABS.indexOf(name) >= 0 ? name : 'video';
    for (const b of document.querySelectorAll('[role="tab"]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('panel-' + b.dataset.tab).hidden = !on;
      if (on && focus) b.focus();
    }
    return tab;
  }

  function bindTabs() {
    const list = Array.from(document.querySelectorAll('[role="tab"]'));
    for (const b of list) {
      b.addEventListener('click', () => {
        const tab = selectTab(b.dataset.tab, false);
        call(() => chrome.storage.local.set({ [TAB_KEY]: tab })).catch(noop);
      });
      b.addEventListener('keydown', (e) => {
        const i = list.indexOf(b);
        let j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % list.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = list.length - 1;
        if (j < 0) return;
        e.preventDefault();
        const tab = selectTab(list[j].dataset.tab, true);
        call(() => chrome.storage.local.set({ [TAB_KEY]: tab })).catch(noop);
      });
    }
  }

  // ---------- 当前视频 ----------

  async function askFrame(fid, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg, { frameId: fid });
    } catch (e) {
      return null; // 内容脚本不在、frame 已销毁
    }
  }

  async function bestFrameId() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'popup-get', tabId: tabId });
      return r && Number.isInteger(r.frameId) ? r.frameId : 0;
    } catch (e) {
      return 0;
    }
  }

  async function refresh() {
    if (busy || !usable) return;
    busy = true;
    const startEpoch = epoch;
    try {
      const fid = await bestFrameId();
      let used = fid;
      let st = await askFrame(fid, { type: 'get-state' });
      if (!isState(st) && fid !== 0) {
        used = 0;
        st = await askFrame(0, { type: 'get-state' });
      }
      if (startEpoch !== epoch) return;
      if (isState(st)) frameId = used;
      renderState(isState(st) ? st : null);
    } finally {
      busy = false;
    }
  }

  function showMessage(text, warn) {
    $('video-panel').hidden = true;
    $('video-actions').hidden = true;
    $('video-note').hidden = true;
    $('video-luma').hidden = true;
    const m = setText('video-message', text);
    m.hidden = false;
    m.classList.toggle('warn', !!warn);
  }

  function shortcutOf(name) {
    const c = commands.find((x) => x && x.name === name);
    return (c && c.shortcut) || '';
  }

  function renderState(st) {
    current = st;
    renderGlobalOff();
    if (!usable) return showMessage(t('video.unusable'), false);
    if (!st) return showMessage(isFile ? t('video.fileAccess') : t('video.notConnected'), false);
    if (!st.hasVideo) {
      return showMessage(st.offscreen ? t('video.offscreen') : st.videoCount > 0 ? t('video.notShowing') : t('video.none'), false);
    }
    if (st.drm) return showMessage(t('video.drm'), true);

    $('video-message').hidden = true;
    $('video-panel').hidden = false;
    $('video-actions').hidden = false;

    const pending = st.state !== 'on' && st.state !== 'off';
    const on = st.state === 'on';
    setClass('video-panel', 'state' + (pending ? ' is-pending' : on ? '' : ' is-off'));
    setText('video-host', st.hostname || tabHost || '');
    setText('state-big', pending ? t('video.loading') : on ? 'HDR' : 'SDR');
    setText('state-word', pending ? '' : t(on ? 'video.on' : 'video.off'));
    const key = shortcutOf('toggle-hdr');
    setText('state-key', key).hidden = !key || pending;
    const reason = L.reasonText(st.reason, lang);
    setText('state-reason', reason ? t('video.reason', { reason: reason }) : '');
    // 这个视频是借全局开关关的（超分保留）还是加滤镜关的；旧内容脚本没有 hdrOnly 字段
    const hdrOnly = typeof st.hdrOnly === 'boolean' ? st.hdrOnly : !!(hdrOnlyStatus && hdrOnlyStatus.active);
    setText('state-extra', pending || on ? '' : t(hdrOnly ? 'video.vsrKept' : 'video.vsrOffToo'));

    const note = st.pip ? t('video.pip') : '';
    setText('video-note', note).hidden = !note;

    let luma = L.formatLuma(st.mean, st.white, lang);
    if (!luma && st.auto && st.auto.mode !== 'off') {
      if (st.autoUnknown === 'tainted') luma = t('video.autoTainted');
      else if (st.autoUnknown === 'error') luma = t('video.autoError');
    }
    setText('video-luma', luma).hidden = !luma;

    const btn = $('btn-toggle');
    btn.disabled = pending;
    setText('btn-toggle', on ? t('video.toSdr') : t('video.toHdr'));
    btn.classList.toggle('to-hdr', !pending && !on);
    const forget = $('btn-forget');
    forget.disabled = !(st.manual || st.saved);
    forget.title = forget.disabled ? t('video.forgetDisabled') : '';
  }

  // NVIDIA 全局 HDR 关着或不可用时，在视频页签顶部说明（逐视频的开关这时不起作用）；
  // 「只关 HDR」模式正在借用全局开关时不算
  function renderGlobalOff() {
    let text = '';
    let canTurnOn = false;
    if (nvMode === 'ready' && nvState) {
      const h = nvState.hdr;
      if (!h.supported) text = L.nvErrorText({ code: 'unsupported', field: 'hdr' }, lang);
      else if (h.error) text = L.nvHdrErrorText(h.error, lang);
      else if (!h.enabled && !(hdrOnlyStatus && hdrOnlyStatus.leased)) {
        text = t('video.globalOff');
        canTurnOn = true;
      }
    }
    setText('global-off-text', text);
    $('global-off').hidden = !text;
    $('global-off-on').hidden = !canTurnOn;
  }

  async function sendAction(state) {
    if (!current || !current.hasVideo) return;
    epoch++;
    const st = await askFrame(frameId, { type: 'set-state', state: state });
    epoch++;
    if (isState(st)) renderState(st);
    else refresh();
  }

  // ---------- 设置 ----------

  function setValue(id, v) {
    const el = $(id);
    if (document.activeElement !== el && el.value !== v) el.value = v;
  }

  function setChecked(id, v) {
    $(id).checked = !!v;
  }

  function renderSettings() {
    const s = settings;
    applyI18n();
    setValue('site-rule', (tabHost && s.sites[tabHost]) || '');
    setValue('auto-mode', s.autoDetect);
    for (const r of radios('sensitivity')) {
      r.checked = r.value === s.sensitivity;
      r.disabled = s.autoDetect === 'off';
    }
    setChecked('night-enabled', s.night.enabled);
    setText('night-range', s.night.start + ' – ' + s.night.end);
    setValue('night-start', s.night.start);
    setValue('night-end', s.night.end);
    setValue('eye-minutes', String(s.eye.minutes));
    setText('eye-sub', s.eye.minutes === 0 ? t('video.eyeOffNote') : t(s.eye.autoOff ? 'video.eyeAutoOff' : 'video.eyeRemind'));
    setChecked('eye-autooff', s.eye.autoOff);
    $('eye-autooff').disabled = s.eye.minutes === 0;
    for (const r of radios('default-state')) r.checked = r.value === s.defaultState;
    setChecked('remember-manual', s.rememberManual);
    setChecked('show-osd', s.osd);
    setChecked('player-button', s.playerButton);
    setChecked('hdr-only', s.hdrOnly);
    setChecked('sdr-follow', s.nv.followSdr);
    renderHdrOnlyStatus();
    renderTheme();
    renderNvPresets();
    renderFoot();
    renderShortcuts();
    if (current) renderState(current);
    if (nvState) nvRender();
    renderSdr();
  }

  function renderFoot() {
    const key = shortcutOf('toggle-auto');
    setText('foot-auto-key', key ? t('foot.autoKey', { key: key }) : '');
    let v = '';
    try { v = 'v' + chrome.runtime.getManifest().version; } catch (e) { v = ''; }
    setText('foot-version', v);
  }

  function renderHdrOnlyStatus() {
    let text = '';
    if (settings.hdrOnly) {
      if (nvMode === 'missing') text = t('rules.hdrOnlyNeedsHost');
      else if (nvMode === 'ready' && !nvCaps.hdrLease) text = t('rules.hdrOnlyOldHost');
      else if (hdrOnlyStatus && hdrOnlyStatus.error) text = t('rules.hdrOnlyFailed', { err: L.nvErrorText(hdrOnlyStatus.error, lang) });
    }
    setText('hdr-only-status', text).hidden = !text;
  }

  // delay：过一会儿再写 storage（期间再改会重新计时），界面和 settings 立即更新
  function save(mutate, delay) {
    const next = L.mergeSettings(settings);
    mutate(next);
    settings = L.mergeSettings(next);
    renderSettings();
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (delay) saveTimer = setTimeout(flushSave, delay);
    else flushSave();
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    call(() => chrome.storage.local.set({ settings: settings })).catch(noop);
  }

  function onChange(id, fn) {
    $(id).addEventListener('change', (e) => fn(e.target));
  }

  function openOptions(hash) {
    const url = chrome.runtime.getURL('options.html' + (hash || ''));
    call(() => chrome.tabs.create({ url: url })).catch(noop);
  }

  // 「只关 HDR」模式正借着全局开关：用户亲手改全局 HDR 时先让 background 放手（不再恢复）
  function dropHdrOnlyLease() {
    if (!(hdrOnlyStatus && hdrOnlyStatus.leased)) return;
    call(() => chrome.runtime.sendMessage({ type: 'hdr-only', op: 'drop' })).catch(noop);
  }

  function bind() {
    for (const r of radios('lang')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => { s.ui.lang = r.value; }); });
    }
    onChange('site-rule', (el) => save((s) => {
      if (!tabHost) return;
      if (el.value === 'on' || el.value === 'off') s.sites[tabHost] = el.value;
      else delete s.sites[tabHost];
    }));
    onChange('auto-mode', (el) => save((s) => {
      s.autoDetect = el.value;
      if (el.value !== 'off') s.autoLastMode = el.value;
    }));
    for (const r of radios('sensitivity')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => { s.sensitivity = r.value; }); });
    }
    onChange('night-enabled', (el) => save((s) => { s.night.enabled = el.checked; }));
    for (const which of ['start', 'end']) {
      onChange('night-' + which, (el) => {
        save((s) => { if (L.parseTime(el.value) != null) s.night[which] = el.value; });
        el.value = settings.night[which]; // 清空等非法输入时恢复原值
      });
    }
    onChange('eye-minutes', (el) => {
      save((s) => {
        const n = Number(el.value);
        if (el.value.trim() !== '' && isFinite(n)) s.eye.minutes = n;
      });
      el.value = String(settings.eye.minutes); // 写回规范化后的值（输入框仍有焦点时 renderSettings 不会改它）
    });
    onChange('eye-autooff', (el) => save((s) => { s.eye.autoOff = el.checked; }));
    for (const r of radios('default-state')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => { s.defaultState = r.value; }); });
    }
    onChange('remember-manual', (el) => save((s) => { s.rememberManual = el.checked; }));
    onChange('show-osd', (el) => save((s) => { s.osd = el.checked; }));
    onChange('player-button', (el) => save((s) => { s.playerButton = el.checked; }));
    onChange('hdr-only', (el) => save((s) => { s.hdrOnly = el.checked; }));
    // 停一会儿再保存：background 会马上套用当前时段的预设，键盘浏览途经的预设不应写到显卡上
    onChange('nv-night-preset', (el) => save((s) => { s.nv.nightPresetId = el.value || null; }, NV_DEBOUNCE_MS));
    onChange('nv-day-preset', (el) => save((s) => { s.nv.dayPresetId = el.value || null; }, NV_DEBOUNCE_MS));

    // 自定义主题色：拖动取色器时只预览，停一会儿再保存
    $('theme-custom').addEventListener('input', (e) => {
      applyTheme(e.target.value);
      clearTimeout(accentTimer);
      accentTimer = setTimeout(() => save((s) => { s.ui.accent = e.target.value; }), 400);
    });
    onChange('theme-custom', (el) => {
      clearTimeout(accentTimer);
      save((s) => { s.ui.accent = el.value; });
    });

    $('btn-toggle').addEventListener('click', () => {
      if (current && current.hasVideo) sendAction(current.state === 'off' ? 'on' : 'off');
    });
    $('btn-forget').addEventListener('click', () => sendAction('clear'));
    $('btn-shortcuts').addEventListener('click', () => {
      const url = IS_EDGE ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
      call(() => chrome.tabs.create({ url: url })).catch(noop);
    });
    $('btn-export').addEventListener('click', () => openOptions('#export'));
    $('btn-import').addEventListener('click', () => openOptions('#import'));
    $('global-off-on').addEventListener('click', () => nvWrite({ hdr: { enabled: true } }, true));

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[NV_LAST_PRESET_KEY]) nvLastPresetId = changes[NV_LAST_PRESET_KEY].newValue || null;
        if (changes[SDR_LAST_KEY]) sdrLastWhite = changes[SDR_LAST_KEY].newValue == null ? null : changes[SDR_LAST_KEY].newValue;
        if (changes[HDR_ONLY_KEY]) {
          hdrOnlyStatus = changes[HDR_ONLY_KEY].newValue || null;
          renderHdrOnlyStatus();
          renderGlobalOff();
          if (current) renderState(current);
        }
        if (changes.settings) {
          settings = L.mergeSettings(changes.settings.newValue);
          renderSettings();
          sdrSyncPolling();
        }
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- NVIDIA 设置：与本地组件通信 ----------

  function nvOpenLink() {
    let port;
    try { port = chrome.runtime.connectNative(L.NV_HOST); } catch (e) { return null; }
    const link = { port: port, waiters: [] };
    port.onMessage.addListener((res) => {
      if (!res || typeof res !== 'object') return;
      // 按 id 对应；本地组件没回 id 时按顺序。已超时的请求的迟到回复直接丢掉
      const i = res.id == null ? 0 : link.waiters.findIndex((w) => w.id === res.id);
      if (i < 0 || !link.waiters.length) return;
      link.waiters.splice(i, 1)[0].done(res);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError; // 没安装本地组件时是 "Specified native messaging host not found."
      if (nvLink === link) nvLink = null;
      const fail = L.nvPortError(err && err.message);
      for (const w of link.waiters.splice(0)) w.done(fail);
    });
    return link;
  }

  function nvBridge(msg) {
    const payload = Object.assign({}, msg);
    delete payload.cmd;
    return call(() => chrome.runtime.sendMessage({ type: 'nv', op: msg.cmd, payload: payload })).then(
      (r) => (r && typeof r === 'object' ? r : { ok: false, error: { code: 'host-error' } }),
      (e) => L.nvPortError((e && e.message) || 'error'));
  }

  // 弹窗开着时用自己的端口（本地组件常驻，拖动滑块延迟低，弹窗关掉端口随之关闭）；
  // 端口连续断开 3 次就改走 background
  function nvRequest(msg) {
    if (!nvUseBridge && !nvLink) {
      nvLink = nvOpenLink();
      if (!nvLink) nvUseBridge = true;
    }
    if (nvUseBridge) return nvBridge(msg);
    const link = nvLink;
    const id = ++nvSeq;
    return new Promise((resolve) => {
      const w = { id: id, done: null };
      const timer = setTimeout(() => {
        const i = link.waiters.indexOf(w);
        if (i >= 0) link.waiters.splice(i, 1);
        resolve({ ok: false, error: { code: 'timeout' } });
      }, NV_TIMEOUT_MS);
      w.done = (res) => {
        clearTimeout(timer);
        resolve(res);
      };
      link.waiters.push(w);
      try {
        link.port.postMessage(Object.assign({ id: id }, msg));
      } catch (e) {
        const i = link.waiters.indexOf(w);
        if (i >= 0) link.waiters.splice(i, 1);
        w.done(L.nvPortError((e && e.message) || 'error'));
      }
    }).then((res) => {
      const code = res && res.error && res.error.code;
      if (res && res.ok === true) nvPortFails = 0;
      else if ((code === 'host-exit' || code === 'host-error') && ++nvPortFails >= 3) nvUseBridge = true;
      return res;
    });
  }

  function nvBusy() {
    return nvWriting || !!nvQueued || !!nvDraft || !!nvDrag;
  }

  function nvStopPolling() {
    clearInterval(nvPollTimer);
    nvPollTimer = 0;
  }

  function nvAccept(state) {
    nvState = L.nvNormState(state);
    nvMode = 'ready';
    nvError = null;
    nvRender();
  }

  // 本地组件没装、NVIDIA App 缺失等：整块换成说明；接口偶尔出错：保留上次的状态，只提示一下
  function nvFailed(res) {
    const err = (res && res.error) || { code: 'host-error' };
    if (err.code === 'host-missing') {
      nvMode = 'missing';
    } else if (NV_FATAL.has(err.code) || !nvState) {
      nvMode = 'error';
    } else {
      nvMessage(L.nvErrorText(err, lang), true);
      return;
    }
    nvError = err;
    if (NV_FATAL.has(err.code)) nvStopPolling();
    nvRender();
  }

  async function nvPoll() {
    if (nvPolling || nvBusy() || nvMode === 'missing') return;
    nvPolling = true;
    const startEpoch = nvEpoch;
    try {
      const res = await nvRequest({ cmd: 'get' });
      if (startEpoch !== nvEpoch || nvBusy()) return; // 读的时候用户改过了：这份是旧的
      if (res && res.ok === true && L.nvNormState(res.state)) nvAccept(res.state);
      else nvFailed(res);
    } finally {
      nvPolling = false;
    }
  }

  async function nvStart() {
    nvRender();
    const hello = await nvRequest({ cmd: 'hello' });
    if (!hello || hello.ok !== true) nvFailed(hello);
    else if (hello.protocol !== L.NV_PROTOCOL) nvFailed({ error: { code: 'protocol' } });
    else {
      const caps = Array.isArray(hello.caps) ? hello.caps : [];
      nvCaps = { display: caps.indexOf('display') >= 0, hdrLease: caps.indexOf('hdrLease') >= 0 };
    }
    if (nvMode === 'missing' || (nvError && NV_FATAL.has(nvError.code))) return;
    await nvPoll();
    if (nvMode === 'missing' || (nvError && NV_FATAL.has(nvError.code))) return;
    nvPollTimer = setInterval(nvPoll, NV_POLL_MS);
    // 已经开着「跟随 SDR 亮度」或之前读过：打开弹窗就读一次
    if (nvCaps.display) sdrRead().then(sdrSyncPolling);
    else renderSdr();
  }

  // ---------- NVIDIA 设置：写入 ----------

  // 先乐观更新界面；拖动中 200 ms 节流（commit:false），松手 / 键盘 / 选择时立即发并提交；
  // final 为 'soon'（下拉框）时停 500 ms 没再变才发并提交，途经的选项不写进驱动。
  // done(res)：这次修改写完（或失败）后调用
  function nvWrite(patch, final, done) {
    if (!nvState) return;
    nvEpoch++;
    nvState = L.nvApplyPatch(nvState, patch);
    nvDraft = L.nvMergePatch(nvDraft, patch);
    if (done) nvDraftDone.push(done);
    if (final === 'soon') {
      nvDraft.commit = true;
      clearTimeout(nvThrottle);
      nvThrottle = setTimeout(nvThrottled, NV_DEBOUNCE_MS);
    } else if (final) {
      clearTimeout(nvThrottle);
      nvThrottle = 0;
      nvDraft.commit = true;
      nvFlush();
    } else if (!nvThrottle) {
      nvThrottle = setTimeout(nvThrottled, NV_THROTTLE_MS);
    }
    nvRender();
  }

  function nvThrottled() {
    nvThrottle = 0;
    nvFlush();
  }

  function nvFlush() {
    if (!nvDraft) return;
    nvQueued = L.nvMergePatch(nvQueued, nvDraft);
    if (nvQueued.commit !== true) nvQueued.commit = false;
    nvQueuedDone = nvQueuedDone.concat(nvDraftDone);
    nvDraft = null;
    nvDraftDone = [];
    nvPump();
  }

  function nvDone(fns, res) {
    for (const f of fns) {
      try { f(res); } catch (e) { /* ignore */ }
    }
  }

  // 一次只有一个 set 在途；在途期间的修改合并成下一个
  async function nvPump() {
    if (nvWriting || !nvQueued) return;
    const v = L.nvValidatePatch(nvQueued, nvState);
    const done = nvQueuedDone;
    nvQueued = null;
    nvQueuedDone = [];
    if (!v.ok) {
      nvMessage(L.nvErrorText(v.error, lang), true);
      nvEpoch++;
      nvPoll(); // 读回真实状态，撤销乐观修改
      nvDone(done, v);
      return;
    }
    nvWriting = true;
    let res = null;
    try {
      res = await nvRequest(Object.assign({ cmd: 'set' }, v.patch));
    } finally {
      nvWriting = false;
    }
    nvEpoch++;
    const ok = res && res.ok === true && L.nvNormState(res.state);
    if (!ok) nvFailed(res);
    nvDone(done, ok ? res : Object.assign({ ok: false, error: { code: 'host-error' } }, res, { ok: false }));
    if (nvQueued) {
      nvPump();
      return;
    }
    if (ok) {
      if (!nvBusy()) nvAccept(res.state); // 以本地组件读回的为准（驱动可能修正了数值）
    } else if (nvMode === 'ready') {
      nvPoll();
    }
  }

  // keep：不自动消失（「正在套用…」这类等结果的提示）
  function nvMessage(text, warn, keep) {
    const el = setText('nv-msg', text || '');
    el.classList.toggle('warn', !!warn);
    clearTimeout(nvMsgTimer);
    if (text && !keep) nvMsgTimer = setTimeout(() => setText('nv-msg', ''), warn ? 6000 : 3000);
  }

  // ---------- NVIDIA 设置：界面 ----------

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

  function nvRender() {
    const ready = nvMode === 'ready' && !!nvState;
    $('nv-missing').hidden = nvMode !== 'missing';
    $('nv-panel').hidden = !ready;
    if (nvMode === 'missing') setText('nv-missing-text', L.nvErrorText({ code: 'host-missing' }, lang));
    const m = $('nv-message');
    m.hidden = ready || nvMode === 'missing';
    if (!m.hidden) {
      setText('nv-message', nvMode === 'connecting' ? t('nv.connecting') : L.nvErrorText(nvError, lang));
      m.classList.toggle('warn', nvMode === 'error');
    }
    renderNvPresets();
    renderGlobalOff();
    renderHdrOnlyStatus();
    if (!ready) return;

    const h = nvState.hdr;
    const hdrOk = h.supported && !h.error;
    const reason = !h.supported ? L.nvErrorText({ code: 'unsupported', field: 'hdr' }, lang) : L.nvHdrErrorText(h.error, lang);
    setText('nv-hdr-reason', reason).hidden = !reason;
    const sw = $('nv-hdr');
    sw.checked = h.enabled;
    sw.disabled = !hdrOk;
    setText('nv-hdr-state', !h.enabled ? t('nv.globalOff') : h.active ? t('nv.globalActive') : t('nv.globalInactive'));

    // 和 NVIDIA App 一样：最高亮度上限不超过 400 时不显示这个滑块
    $('nv-peak-wrap').hidden = !(h.peakMax > 400);
    for (const id of ['nv-peak', 'nv-peak-num']) {
      setAttr($(id), 'min', h.peakMin);
      setAttr($(id), 'max', h.peakMax);
    }
    for (const f of NV_SLIDERS) {
      const el = $('nv-' + f);
      el.disabled = !hdrOk;
      if (!(nvDrag && nvDrag.id === el.id)) setNum(el, h[f]);
      sliderFill(el);
      if (f !== 'peak') setText('nv-' + f + '-out', f === 'middleGrey' ? String(h[f]) : signed(h[f]));
    }
    const num = $('nv-peak-num');
    num.disabled = !hdrOk;
    if (document.activeElement !== num) setNum(num, h.peak);
    $('nv-peak-hint').hidden = !(h.peak > 1000);

    const v = nvState.vsr;
    setText('nv-vsr-reason', v.supported ? '' : L.nvErrorText({ code: 'unsupported', field: 'vsr' }, lang)).hidden = v.supported;
    const sel = $('nv-vsr');
    sel.disabled = !v.supported;
    setNum(sel, v.mode);
    const on = v.supported && v.level > 0;
    setText('nv-vsr-state', on ? t('nv.vsrActive', { level: t('vsrLevel.' + v.level) }) : t('nv.vsrInactive'));
    // GPU 优先级只在自动模式下有意义；驱动没有 0x32F / 0x330 时（priority / indicator 为 null）不显示
    $('nv-priority-row').hidden = !(v.supported && v.mode === 5 && v.priority !== null);
    for (const r of radios('nv-priority')) r.checked = Number(r.value) === v.priority;
    $('nv-indicator-row').hidden = nvState.indicator === null;
    $('nv-indicator').checked = nvState.indicator === true;
    renderSdr();
  }

  function renderNvPresets() {
    const presets = settings.nv.presets;
    const ids = presets.map((p) => p.id);
    if (ids.indexOf(nvSelectedId) < 0) nvSelectedId = ids.indexOf(nvLastPresetId) >= 0 ? nvLastPresetId : ids[0] || null;
    const items = presets.length ? presets.map((p) => [p.id, p.name]) : [['', t('nv.noPresets'), true]];
    const sel = $('nv-preset');
    fillSelect(sel, items, nvSelectedId || '');
    sel.disabled = !presets.length;
    const ready = nvMode === 'ready' && !!nvState;
    $('nv-apply').disabled = !ready || !presets.length;
    $('nv-delete').disabled = !presets.length;
    $('nv-save').disabled = !ready;
    if (nvDeleteArmed && nvDeleteArmed.id !== nvSelectedId) nvDisarmDelete();
    if (!nvDeleteArmed) setText('nv-delete', t('nv.delete'));

    const opts = [['', t('nv.noSwitch')]].concat(presets.map((p) => [p.id, p.name]));
    for (const id of ['nv-night-preset', 'nv-day-preset']) {
      fillSelect($(id), opts, settings.nv[id === 'nv-night-preset' ? 'nightPresetId' : 'dayPresetId'] || '');
      $(id).disabled = !presets.length; // 只有「不切换」可选
    }
    const missing = nvMode === 'missing';
    setText('nv-schedule-hint', !presets.length
      ? t(missing ? 'nv.scheduleNeedHost' : 'nv.scheduleNeedPresets')
      : t('nv.scheduleHint') + (missing ? t('nv.scheduleHintMissing') : ''));
  }

  function nvNewId() {
    const ids = new Set(settings.nv.presets.map((p) => p.id));
    let id;
    do id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    while (ids.has(id));
    return id;
  }

  function nvShowSaveForm(show) {
    $('nv-save-form').hidden = !show;
    $('nv-save').setAttribute('aria-expanded', String(show));
    nvOverwriteName = null;
    if (show) {
      const input = $('nv-preset-name');
      input.value = L.nvDefaultPresetName(settings.nv.presets, lang);
      input.focus();
      input.select();
    }
  }

  // 同名的预设先提示，再保存一次才覆盖（保留 id，夜间 / 其余时间的选择不受影响）
  function nvSavePreset() {
    if (!nvState) return;
    const probe = L.nvPresetFromState(nvState, $('nv-preset-name').value, 'probe');
    if (!probe) {
      nvMessage(t('nv.enterName'), true);
      $('nv-preset-name').focus();
      return;
    }
    const same = settings.nv.presets.find((p) => p.name === probe.name);
    if (!same && settings.nv.presets.length >= L.NV_MAX_PRESETS) {
      nvMessage(t('nv.maxPresets', { n: L.NV_MAX_PRESETS }), true);
      return;
    }
    if (same && nvOverwriteName !== probe.name) {
      nvOverwriteName = probe.name;
      nvMessage(t('nv.overwrite', { name: probe.name }), true);
      $('nv-preset-name').focus();
      return;
    }
    nvOverwriteName = null;
    const preset = L.nvPresetFromState(nvState, probe.name, same ? same.id : nvNewId());
    save((s) => {
      const i = s.nv.presets.findIndex((p) => p.id === preset.id);
      if (i >= 0) s.nv.presets[i] = preset;
      else s.nv.presets.push(preset);
    });
    nvSelectedId = preset.id;
    renderNvPresets();
    nvShowSaveForm(false);
    $('nv-save').focus();
    nvMessage(t(same ? 'nv.updated' : 'nv.saved', { name: preset.name }));
  }

  function nvApplyPreset() {
    const p = settings.nv.presets.find((x) => x.id === nvSelectedId);
    if (!p || !nvState) return;
    const patch = L.nvPresetPatch(p, nvState);
    if (!patch) {
      const h = nvState.hdr;
      nvMessage(L.nvErrorText(h.supported && h.error ? { code: 'hdr-error', errorCode: h.error } : { code: 'unsupported' }, lang), true);
      return;
    }
    const partial = patch.hdr ? '' : t('nv.partial');
    nvMessage(t('nv.applying', { name: p.name }), false, true);
    // 本地组件确认写入后才提示成功、记下「上次套用的预设」（快捷键从它的下一个开始轮换）
    nvWrite(patch, true, (res) => {
      if (!res || res.ok !== true) {
        nvMessage(t('nv.applyFailed', { err: L.nvErrorText(res && res.error, lang) }), true);
        return;
      }
      nvLastPresetId = p.id;
      call(() => chrome.storage.local.set({ [NV_LAST_PRESET_KEY]: p.id })).catch(noop);
      nvMessage(t('nv.applied', { name: p.name }) + partial);
    });
  }

  function nvDisarmDelete() {
    if (!nvDeleteArmed) return;
    clearTimeout(nvDeleteArmed.timer);
    nvDeleteArmed = null;
    setText('nv-delete', t('nv.delete'));
  }

  // 删除不能撤销：第一次只把按钮变成「确认删除？」，4 秒内再按一次才删
  function nvDeletePreset() {
    const presets = settings.nv.presets;
    const i = presets.findIndex((x) => x.id === nvSelectedId);
    if (i < 0) return nvDisarmDelete();
    const p = presets[i];
    const uses = [];
    if (settings.nv.nightPresetId === p.id) uses.push(t('nv.useNight'));
    if (settings.nv.dayPresetId === p.id) uses.push(t('nv.useDay'));
    const usesText = uses.join(t('nv.and'));
    if (!nvDeleteArmed || nvDeleteArmed.id !== p.id) {
      nvDisarmDelete();
      const ask = t('nv.deleteAsk', { name: p.name }) + (uses.length ? t('nv.deleteCancels', { uses: usesText }) : '');
      nvDeleteArmed = {
        id: p.id,
        timer: setTimeout(() => {
          if ($('nv-msg').textContent === ask) nvMessage('');
          nvDisarmDelete();
        }, NV_CONFIRM_MS)
      };
      setText('nv-delete', t('nv.confirmDelete'));
      nvMessage(ask, true);
      return;
    }
    nvDisarmDelete();
    const next = presets[i + 1] || presets[i - 1];
    nvSelectedId = next ? next.id : null;
    // mergeSettings 会把指向它的夜间 / 其余时间选择变回「不切换」
    save((s) => { s.nv.presets = s.nv.presets.filter((x) => x.id !== p.id); });
    nvMessage(t('nv.deleted', { name: p.name }) + (uses.length ? t('nv.deletedCancelled', { uses: usesText }) : ''), !!uses.length);
  }

  // 拖回起点时 Chrome 不发 change，松手时照样提交一次
  function nvEndDrag() {
    const d = nvDrag;
    if (!d) return;
    nvDrag = null;
    const el = $(d.id);
    if (d.moved && el.value === d.start) nvWrite({ hdr: { [el.dataset.field]: Number(el.value) } }, true);
  }

  // ---------- Windows SDR 亮度 → 建议值 ----------

  function sdrMessage(text, warn) {
    const el = setText('sdr-msg', text || '');
    el.classList.toggle('warn', !!warn);
    clearTimeout(sdrMsgTimer);
    if (text && !warn) sdrMsgTimer = setTimeout(() => setText('sdr-msg', ''), 4000);
  }

  function sdrCurrent() {
    return sdrDisplays ? L.nvPickDisplay(sdrDisplays, settings.nv.displayId) : null;
  }

  async function sdrRead() {
    if (!nvCaps.display || sdrBusy) return;
    sdrBusy = true;
    renderSdr();
    let res = null;
    try {
      res = await nvRequest({ cmd: 'display' });
    } finally {
      sdrBusy = false;
    }
    if (!res || res.ok !== true || !Array.isArray(res.displays)) {
      sdrMessage(L.nvErrorText((res && res.error) || { code: 'host-error' }, lang), true);
      renderSdr();
      return;
    }
    sdrDisplays = res.displays.map(L.nvNormDisplay).filter(Boolean);
    sdrFollow();
    renderSdr();
  }

  // 跟随 SDR 亮度：白电平和上次调中间灰时不一样就按新的白电平调一次（弹窗开着时由这里做，关着时 background 每 30 秒看一次）
  function sdrFollow() {
    if (!settings.nv.followSdr || !nvState || nvBusy()) return;
    const d = sdrCurrent();
    const sug = d && L.nvSuggest(d, nvState);
    if (!sug || d.sdrWhiteNits === sdrLastWhite) return;
    sdrLastWhite = d.sdrWhiteNits;
    call(() => chrome.storage.local.set({ [SDR_LAST_KEY]: d.sdrWhiteNits })).catch(noop);
    if (sug.middleGrey !== nvState.hdr.middleGrey && nvState.hdr.supported && !nvState.hdr.error) {
      nvWrite({ hdr: { middleGrey: sug.middleGrey } }, true);
    }
  }

  function sdrSyncPolling() {
    const want = settings.nv.followSdr && nvCaps.display && nvMode === 'ready';
    if (want && !sdrPollTimer) sdrPollTimer = setInterval(sdrRead, SDR_POLL_MS);
    else if (!want && sdrPollTimer) {
      clearInterval(sdrPollTimer);
      sdrPollTimer = 0;
    }
  }

  function renderSug(prefix, cur, next, fmt) {
    setText(prefix + '-cur', fmt(cur));
    const el = $(prefix + '-new');
    const same = cur === next;
    setText(prefix + '-new', same ? t('sdr.same') : '→ ' + fmt(next));
    el.className = 'sug-new ' + (same ? 'same' : 'change');
  }

  function renderSdr() {
    const read = $('sdr-read');
    setText('sdr-read', sdrBusy ? t('sdr.reading') : sdrDisplays ? t('sdr.reread') : t('sdr.read'));
    read.disabled = sdrBusy || !nvCaps.display || nvMode !== 'ready';
    const ready = nvMode === 'ready' && !!nvState;
    const list = sdrDisplays || [];
    $('sdr-display-wrap').hidden = list.length < 2;
    if (list.length >= 2) {
      const d0 = sdrCurrent();
      fillSelect($('sdr-display'), list.map((d) => [d.id, d.name || d.id]), d0 ? d0.id : '');
    }
    const d = sdrCurrent();
    const sug = ready && d ? L.nvSuggest(d, nvState) : null;
    $('sdr-empty').hidden = !!sdrDisplays;
    $('sdr-body').hidden = !d;
    $('sdr-actions').hidden = !sug;
    if (!ready) return;
    if (nvMode === 'ready' && !nvCaps.display) {
      if ($('sdr-msg').textContent !== t('nv.err.old-host')) sdrMessage(t('nv.err.old-host'), true);
      return;
    }
    if (!sdrDisplays) return;
    if (!d) {
      setText('sdr-msg', t('sdr.noDisplay'));
      return;
    }
    setText('sdr-nits', d.sdrWhiteNits != null ? String(Math.round(d.sdrWhiteNits)) : '—');
    setText('sdr-sub', t('sdr.sub', { slider: d.sdrSlider != null ? d.sdrSlider : '—' }));
    $('sdr-sugs').hidden = !sug;
    if (!sug) {
      if (!d.hdrEnabled) setText('sdr-msg', t('sdr.hdrOff'));
      return;
    }
    const h = nvState.hdr;
    renderSug('sug-mg', h.middleGrey, sug.middleGrey, String);
    renderSug('sug-peak', h.peak, sug.peak, String);
    renderSug('sug-con', h.contrast, sug.contrast, signed);
    $('sdr-follow').checked = settings.nv.followSdr;
  }

  function sdrSync() {
    const d = sdrCurrent();
    const sug = d && nvState ? L.nvSuggest(d, nvState) : null;
    if (!sug) return;
    const h = nvState.hdr;
    const hdr = {};
    if ($('sug-mg').checked && sug.middleGrey !== h.middleGrey) hdr.middleGrey = sug.middleGrey;
    if ($('sug-peak').checked && sug.peak !== h.peak) hdr.peak = sug.peak;
    if ($('sug-con').checked && sug.contrast !== h.contrast) hdr.contrast = sug.contrast;
    sdrLastWhite = d.sdrWhiteNits;
    call(() => chrome.storage.local.set({ [SDR_LAST_KEY]: d.sdrWhiteNits })).catch(noop);
    if (!Object.keys(hdr).length) {
      sdrMessage(t('sdr.nothing'));
      return;
    }
    nvWrite({ hdr: hdr }, true, (res) => {
      if (res && res.ok === true) sdrMessage(t('sdr.synced'));
      else sdrMessage(L.nvErrorText(res && res.error, lang), true);
    });
  }

  function nvBind() {
    for (const f of NV_SLIDERS) {
      const el = $('nv-' + f);
      el.dataset.field = f;
      el.addEventListener('pointerdown', () => { nvDrag = { id: el.id, start: el.value, moved: false }; });
      el.addEventListener('input', () => {
        if (nvDrag && nvDrag.id === el.id) nvDrag.moved = true;
        sliderFill(el);
        nvWrite({ hdr: { [f]: Number(el.value) } }, false);
      });
      el.addEventListener('change', () => {
        if (nvDrag && nvDrag.id === el.id) nvDrag = null;
        nvWrite({ hdr: { [f]: Number(el.value) } }, true);
      });
    }
    window.addEventListener('pointerup', nvEndDrag);
    window.addEventListener('pointercancel', nvEndDrag);

    onChange('nv-peak-num', (el) => {
      const h = nvState && nvState.hdr;
      const n = Math.round(Number(el.value));
      if (!h || el.value.trim() === '' || !isFinite(n)) {
        if (h) el.value = String(h.peak);
        return;
      }
      const peak = Math.min(h.peakMax, Math.max(h.peakMin, n));
      el.value = String(peak); // 超出范围时写回夹过的值
      nvWrite({ hdr: { peak: peak } }, true);
    });
    onChange('nv-hdr', (el) => {
      dropHdrOnlyLease();
      nvWrite({ hdr: { enabled: el.checked } }, true);
    });
    onChange('nv-vsr', (el) => nvWrite({ vsr: { mode: Number(el.value) } }, 'soon'));
    for (const r of radios('nv-priority')) {
      r.addEventListener('change', () => { if (r.checked) nvWrite({ vsr: { priority: Number(r.value) } }, true); });
    }
    onChange('nv-indicator', (el) => nvWrite({ indicator: el.checked }, true));

    $('sdr-read').addEventListener('click', () => sdrRead());
    $('sdr-sync').addEventListener('click', sdrSync);
    onChange('sdr-display', (el) => save((s) => { s.nv.displayId = el.value || null; }));
    onChange('sdr-follow', (el) => {
      // 第一次打开时立刻按当前白电平调一次
      if (el.checked) {
        sdrLastWhite = null;
        call(() => chrome.storage.local.remove(SDR_LAST_KEY)).catch(noop);
      }
      save((s) => { s.nv.followSdr = el.checked; });
      if (el.checked) sdrRead();
    });

    $('nv-preset').addEventListener('change', (e) => {
      nvSelectedId = e.target.value || null;
      nvDisarmDelete();
    });
    $('nv-apply').addEventListener('click', nvApplyPreset);
    $('nv-delete').addEventListener('click', nvDeletePreset);
    $('nv-save').addEventListener('click', () => nvShowSaveForm($('nv-save-form').hidden));
    $('nv-save-ok').addEventListener('click', nvSavePreset);
    $('nv-save-cancel').addEventListener('click', () => {
      nvShowSaveForm(false);
      $('nv-save').focus();
    });
    $('nv-preset-name').addEventListener('input', () => { nvOverwriteName = null; });
    $('nv-preset-name').addEventListener('keydown', (e) => {
      if (e.isComposing) return; // 输入法选词时的回车不算
      if (e.key === 'Enter') {
        e.preventDefault();
        nvSavePreset();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        nvShowSaveForm(false);
        $('nv-save').focus();
      }
    });
    $('nv-install').addEventListener('click', (e) => {
      e.preventDefault();
      call(() => chrome.tabs.create({ url: e.currentTarget.href })).catch(noop);
    });
    // 弹窗关闭前把还没发出去的修改直接发出去：节流 / 防抖中的和排在在途 set 后面的合并成一次。
    // 不等在途 set 的回复（弹窗关了也收不到）：本地组件按顺序处理同一端口上的请求，
    // 走 background 时它也按队列顺序发；已经发出去的会被本地组件处理完
    window.addEventListener('pagehide', () => {
      clearTimeout(nvThrottle);
      nvThrottle = 0;
      if (accentTimer) {
        clearTimeout(accentTimer);
        accentTimer = 0;
        const v = $('theme-custom').value;
        if (v) {
          settings = L.mergeSettings(Object.assign({}, settings, { ui: Object.assign({}, settings.ui, { accent: v }) }));
          flushSave();
        }
      }
      if (saveTimer) flushSave();
      const pending = L.nvMergePatch(nvQueued, nvDraft);
      nvQueued = null;
      nvDraft = null;
      nvQueuedDone = [];
      nvDraftDone = [];
      if (!pending || !nvState) return;
      pending.commit = true;
      const v = L.nvValidatePatch(pending, nvState);
      if (!v.ok) return;
      const msg = Object.assign({ cmd: 'set' }, v.patch);
      try {
        if (!nvUseBridge && nvLink) nvLink.port.postMessage(Object.assign({ id: ++nvSeq }, msg));
        else nvBridge(msg).catch(noop);
      } catch (e) { /* 弹窗正在关闭 */ }
    });
  }

  // ---------- 快捷键 ----------

  async function loadCommands() {
    try { commands = (await chrome.commands.getAll()) || []; } catch (e) { commands = []; }
  }

  function renderShortcuts() {
    const ul = $('shortcuts');
    ul.textContent = '';
    for (const c of commands) {
      if (c.name === '_execute_action' && !c.shortcut) continue;
      const li = document.createElement('li');
      const desc = document.createElement('span');
      desc.className = 'desc';
      const key = 'cmd.' + c.name;
      const name = t(key);
      desc.textContent = name !== key ? name : c.description || c.name;
      li.appendChild(desc);
      if (c.shortcut) {
        const k = document.createElement('kbd');
        k.textContent = c.shortcut;
        li.appendChild(k);
      } else {
        const u = document.createElement('span');
        u.className = 'unset';
        u.textContent = t('keys.unset');
        li.appendChild(u);
      }
      ul.appendChild(li);
    }
  }

  // ---------- 启动 ----------

  async function init() {
    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0];
    } catch (e) { tab = null; }
    tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
    const url = (tab && (tab.url || tab.pendingUrl)) || '';
    usable = tabId !== null && scriptable(url);
    isFile = /^file:/i.test(url);
    tabHost = usable ? L.normalizeHost(L.hostOf(url)) : '';
    $('site-host').textContent = tabHost || '';
    $('site-rule').disabled = !tabHost;

    let hotkeyError = null;
    let savedTab = 'video';
    try {
      const r = await chrome.storage.local.get(['settings', NV_LAST_PRESET_KEY, NV_HOTKEY_ERROR_KEY, TAB_KEY, HDR_ONLY_KEY, SDR_LAST_KEY]);
      settings = L.mergeSettings(r && r.settings);
      nvLastPresetId = (r && r[NV_LAST_PRESET_KEY]) || null;
      hotkeyError = r && r[NV_HOTKEY_ERROR_KEY];
      savedTab = (r && r[TAB_KEY]) || 'video';
      hdrOnlyStatus = (r && r[HDR_ONLY_KEY]) || null;
      sdrLastWhite = r && typeof r[SDR_LAST_KEY] === 'number' ? r[SDR_LAST_KEY] : null;
    } catch (e) { /* 用默认值 */ }
    await loadCommands();
    selectTab(savedTab, false);
    bindTabs();
    renderSettings();
    bind();
    nvBind();
    // 快捷键切换预设失败时当前页面显示不了提示（chrome:// 页面等）：在这里补一次，只显示一次
    if (hotkeyError) {
      call(() => chrome.storage.local.remove(NV_HOTKEY_ERROR_KEY)).catch(noop);
      const age = Date.now() - (+hotkeyError.at || 0);
      if (typeof hotkeyError.text === 'string' && age >= 0 && age < NV_HOTKEY_ERROR_MAX_AGE) nvMessage(hotkeyError.text.slice(0, 200), true);
    }
    nvStart().catch(() => nvFailed(null)); // NVIDIA 设置与当前页面无关，chrome:// 页面也能用

    if (!usable) {
      renderState(null);
      return;
    }
    await refresh();
    setInterval(refresh, REFRESH_MS);
  }

  init().catch(() => showMessage(t('video.unusable'), false));
})();
