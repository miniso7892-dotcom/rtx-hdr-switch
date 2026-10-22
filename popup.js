/* RTX HDR 开关 —— 弹窗 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const I = globalThis.RtxHdrI18n;
  const U = globalThis.RtxHdrUi;
  const C = globalThis.RtxHdrNvClient;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 1000;
  const IS_EDGE = /\bEdg\//.test(navigator.userAgent);
  const TAB_KEY = 'popupTab';
  const TABS = ['video', 'nv', 'rules'];
  const HDR_ONLY_KEY = 'hdrOnlyStatus'; // background 写：{active, leased, prevEnabled?, error?}
  const SDR_LAST_KEY = 'nvLastSdrWhite'; // 跟随 SDR 亮度：上次按它调过中间灰的白电平（background 写）
  const NV_POLL_MS = 2000;
  const SDR_POLL_MS = 2000;
  // 同一白电平请 background 跟随一次后，隔这么久才再请（background 自己每 30 秒也看一次）
  const SDR_ASK_MS = 30000;
  // 下拉框：键盘在收起的下拉框上按方向键时每一步都触发 change，停这么久没再变才写入 / 保存
  const NV_DEBOUNCE_MS = 500;
  const NV_CONFIRM_MS = 4000; // 「删除」按第一次后等确认的时间
  const NV_LAST_PRESET_KEY = 'nvLastPresetId'; // background 套用预设成功后写
  const NV_HOTKEY_ERROR_KEY = 'nvHotkeyError'; // 快捷键切换预设失败、页面上显示不了时 background 留下的提示
  const NV_HOTKEY_ERROR_MAX_AGE = 10 * 60 * 1000;
  const NV_SLIDERS = ['peak', 'middleGrey', 'contrast', 'saturation'];
  const PROFILES_KEY = 'profiles'; // background 写：{v, list, activeId}
  const PROFILE_UNDO_KEY = 'profileUndo'; // background 写（storage.session）：10 分钟内可以撤销的配置档切换
  const NV_LOG_KEY = 'nvLog'; // background 写（storage.session）：NVIDIA 修改记录
  const NV_LAST_MS = 10000; // 修改后「上一次：… 撤销」显示这么久
  const UPDATE_KEY = 'updateState'; // background 写：更新检查的结果
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
  let maybeFile = false; // 读不到网址（没有 tabs 权限时本地文件就是这样）且没开「允许访问文件网址」
  let frameId = 0;
  let current = null;
  let settings = L.mergeSettings(null); // 界面上的设置：storage 里的值叠加还没被 background 收下的补丁
  let stored = settings; // storage 里的设置（最近一次读到的）
  let pendingPatch = null; // 防抖中还没发出的设置补丁
  const sentPatches = []; // 已发给 background、还没回复的补丁
  let busy = false;
  let epoch = 0; // 每次用户操作 +1，丢弃操作前发出的刷新结果
  let commands = [];
  let hdrOnlyStatus = null;

  // NVIDIA 设置：本地组件连接、轮询和乐观写入（nv.mode / state / error / caps / drag，见 nv-client.js）
  const nv = C.create({
    pollMs: NV_POLL_MS,
    log: true,
    onChange: () => nvRender(),
    onError: (err) => nvMessage(L.nvErrorText(err, lang), true),
    beforeSet: dropHdrOnlyLease
  });
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
  let sdrAsked = null; // {white, at}：最近一次请 background 跟随的白电平
  let sdrMsgTimer = 0;

  let profiles = L.normProfiles(null); // background 回复的配置档列表
  let pfUndo = null; // {at, id, name}：还能撤销的那次切换
  let pfUndoTimer = 0;
  let pfMsgTimer = 0;
  let pfSig = '';
  let pfDeleteArmed = null; // {id, timer}
  let pfOverwriteName = null; // 已提示过「将覆盖」的同名配置档，再保存一次才覆盖
  let siteListSig = '';

  let nvLastEntry = null; // 修改记录里最新的一条可撤销的修改
  let nvLastTimer = 0;
  let upView = null; // background 回复的更新信息：{dev, enabled, version, notice}

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
    return U.setText($(id), text);
  }

  function setClass(id, cls) {
    U.setClass($(id), cls);
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
    U.applyTheme(document.documentElement, hex || settings.ui.accent);
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
    if (!usable) return showMessage(t(maybeFile ? 'video.unusableFile' : 'video.unusable'), false);
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
    forget.disabled = !(st.manual || st.saved || st.tab);
  }

  // NVIDIA 全局 HDR 关着或不可用时，在视频页签顶部说明（逐视频的开关这时不起作用）；
  // 「只关 HDR」模式正在借用全局开关时不算
  function renderGlobalOff() {
    let text = '';
    let canTurnOn = false;
    if (nv.mode === 'ready' && nv.state) {
      const h = nv.state.hdr;
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
    setChecked('fullscreen-web', s.fullscreenWeb);
    // 只有用到「仅全屏」（没有规则时，或某个网站规则）时才有意义
    $('fullscreen-web').disabled = !usesFullscreen(s);
    setChecked('remember-manual', s.rememberManual);
    setChecked('show-osd', s.osd);
    setChecked('player-button', s.playerButton);
    // 设置面板挂在控制栏按钮上：按钮关着时这一行不能改
    for (const r of radios('player-panel')) {
      r.checked = r.value === s.playerPanel;
      r.disabled = !s.playerButton;
    }
    setChecked('hdr-only', s.hdrOnly);
    setChecked('sdr-follow', s.nv.followSdr);
    renderHdrOnlyStatus();
    renderTheme();
    renderNvPresets();
    renderProfiles();
    renderUpdate();
    renderNvLast();
    renderFoot();
    renderShortcuts();
    if (current) renderState(current);
    if (nv.state) nvRender();
    renderSdr();
  }

  function usesFullscreen(s) {
    if (s.defaultState === 'fullscreen') return true;
    for (const h of Object.keys(s.sites)) if (s.sites[h] === 'fullscreen') return true;
    return false;
  }

  function renderFoot() {
    const key = shortcutOf('toggle-auto');
    setText('foot-auto-key', key ? t('foot.autoKey', { key: key }) : '');
    let v = '';
    try { v = 'v' + chrome.runtime.getManifest().version; } catch (e) { v = ''; }
    setText('foot-version', v).classList.toggle('is-new', !!(upView && upView.notice));
  }

  function renderHdrOnlyStatus() {
    let text = '';
    if (settings.hdrOnly) {
      if (nv.mode === 'missing') text = t('rules.hdrOnlyNeedsHost');
      else if (nv.mode === 'ready' && !nv.caps.hdrLease) text = t('rules.hdrOnlyOldHost');
      else if (hdrOnlyStatus && hdrOnlyStatus.error) text = t('rules.hdrOnlyFailed', { err: L.nvErrorText(hdrOnlyStatus.error, lang) });
    }
    setText('hdr-only-status', text).hidden = !text;
  }

  // 设置只由 background 写：这里把改动变成最小补丁（L.settingsPatchFor）发过去。
  // delay：过一会儿再发（期间再改会重新计时，补丁合并），界面和 settings 立即更新
  function save(mutate, delay) {
    stage(mutate);
    renderSettings();
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (delay) saveTimer = setTimeout(flushSave, delay);
    else flushSave();
  }

  // 只改 settings、记下补丁，不重画也不发
  function stage(mutate) {
    const next = L.mergeSettings(settings);
    mutate(next);
    const merged = L.mergeSettings(next);
    const patch = L.settingsPatchFor(settings, merged);
    settings = merged;
    if (patch) pendingPatch = L.mergeSettingsPatch(pendingPatch, patch);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const patch = pendingPatch;
    pendingPatch = null;
    if (!patch) return;
    const entry = { patch: patch };
    sentPatches.push(entry);
    call(() => chrome.runtime.sendMessage({ type: 'settings-patch', patch: patch })).then(
      (r) => !!r && r.ok === true, () => false
    ).then((ok) => {
      const i = sentPatches.indexOf(entry);
      if (i >= 0) sentPatches.splice(i, 1);
      if (!ok) rebase(); // background 没收下：界面回到 storage 里的值（只保留其他还没回复的修改）
    });
  }

  // 还没被 background 收下的修改：已发出等回复的和防抖中的
  function unsentPatch() {
    let p = null;
    for (const e of sentPatches) p = L.mergeSettingsPatch(p, e.patch);
    return L.mergeSettingsPatch(p, pendingPatch);
  }

  // storage 里的设置变了（别处的修改、自己补丁的回声）：在新值上重新叠加还没收下的修改，用户刚输入的值不会被覆盖
  function rebase() {
    settings = L.applySettingsPatch(stored, unsentPatch()) || stored;
    renderSettings();
  }

  function onChange(id, fn) {
    $(id).addEventListener('change', (e) => fn(e.target));
  }

  function openOptions(hash) {
    const url = chrome.runtime.getURL('options.html' + (hash || ''));
    call(() => chrome.tabs.create({ url: url })).catch(noop);
  }

  // 「只关 HDR」模式正借着全局开关时，自己端口上要改全局 HDR 的写入先让 background 放手（不再恢复）。
  // 全局 HDR 开关和套用预设走 background（nv-op），由它按 suppress / yield 处理借用；这里只是兜底
  function dropHdrOnlyLease(patch) {
    if (!(patch && patch.hdr && typeof patch.hdr.enabled === 'boolean')) return null;
    if (!(hdrOnlyStatus && hdrOnlyStatus.leased)) return null;
    return call(() => chrome.runtime.sendMessage({ type: 'hdr-only', op: 'drop' })).catch(noop);
  }

  // 交给 background 写入服务的 NVIDIA 操作（套用预设、全局 HDR 开关、跟随 SDR）
  function nvOp(msg) {
    return call(() => chrome.runtime.sendMessage(Object.assign({ type: 'nv-op' }, msg))).then(
      (r) => (r && typeof r === 'object' ? r : { ok: false, error: { code: 'host-error' } }),
      (e) => L.nvPortError((e && e.message) || 'error'));
  }

  // 用户亲手拨全局 HDR（开关、「开启」按钮）：经 background，借用按 suppress 处理（这个视频不再借）
  function nvSetEnabled(on) {
    if (!nv.state) return;
    const patch = { hdr: { enabled: on } };
    nv.local(patch);
    nv.exclusive(() => nvOp({ op: 'set', patch: patch, mode: 'suppress' })).then((res) => {
      if (!res || res.ok !== true) nv.failed(res);
    });
  }

  function bind() {
    for (const r of radios('lang')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => { s.ui.lang = r.value; }); });
    }
    onChange('site-rule', (el) => save((s) => {
      if (!tabHost) return;
      if (el.value === 'on' || el.value === 'off' || el.value === 'fullscreen') s.sites[tabHost] = el.value;
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
    onChange('fullscreen-web', (el) => save((s) => { s.fullscreenWeb = el.checked; }));
    onChange('remember-manual', (el) => save((s) => { s.rememberManual = el.checked; }));
    onChange('show-osd', (el) => save((s) => { s.osd = el.checked; }));
    onChange('player-button', (el) => save((s) => { s.playerButton = el.checked; }));
    for (const r of radios('player-panel')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => { s.playerPanel = r.value; }); });
    }
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
    $('global-off-on').addEventListener('click', () => nvSetEnabled(true));

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes[PROFILE_UNDO_KEY]) loadProfiles();
        if (area === 'session' && changes[NV_LOG_KEY]) nvLastAccept(changes[NV_LOG_KEY].newValue);
        if (area !== 'local') return;
        if (changes[UPDATE_KEY]) loadUpdate();
        if (changes[PROFILES_KEY]) loadProfiles();
        if (changes[NV_LAST_PRESET_KEY]) nvLastPresetId = changes[NV_LAST_PRESET_KEY].newValue || null;
        if (changes[SDR_LAST_KEY]) sdrLastWhite = changes[SDR_LAST_KEY].newValue == null ? null : changes[SDR_LAST_KEY].newValue;
        if (changes[HDR_ONLY_KEY]) {
          hdrOnlyStatus = changes[HDR_ONLY_KEY].newValue || null;
          renderHdrOnlyStatus();
          renderGlobalOff();
          if (current) renderState(current);
        }
        if (changes.settings) {
          const prevCheck = stored.updateCheck;
          stored = L.mergeSettings(changes.settings.newValue);
          rebase();
          sdrSyncPolling();
          if (stored.updateCheck !== prevCheck) loadUpdate(); // 关掉检查时不再提醒
        }
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- NVIDIA 设置：连接 ----------

  async function nvStart() {
    await nv.start();
    if (nv.mode === 'missing' || (nv.error && C.FATAL.has(nv.error.code))) return;
    // 已经开着「跟随 SDR 亮度」或之前读过：打开弹窗就读一次
    if (nv.caps.display) sdrRead().then(sdrSyncPolling);
    else renderSdr();
  }

  // keep：不自动消失（「正在套用…」这类等结果的提示）
  function nvMessage(text, warn, keep) {
    const el = setText('nv-msg', text || '');
    el.classList.toggle('warn', !!warn);
    clearTimeout(nvMsgTimer);
    if (text && !keep) nvMsgTimer = setTimeout(() => setText('nv-msg', ''), warn ? 6000 : 3000);
  }

  // ---------- NVIDIA 设置：界面 ----------

  const setNum = U.setNum;
  const setAttr = U.setAttr;
  const sliderFill = U.sliderFill;
  const signed = U.signed;
  const fillSelect = U.fillSelect;

  function nvRender() {
    const ready = nv.mode === 'ready' && !!nv.state;
    $('nv-missing').hidden = nv.mode !== 'missing';
    $('nv-panel').hidden = !ready;
    if (nv.mode === 'missing') setText('nv-missing-text', L.nvErrorText({ code: 'host-missing' }, lang));
    const m = $('nv-message');
    m.hidden = ready || nv.mode === 'missing';
    if (!m.hidden) {
      setText('nv-message', nv.mode === 'connecting' ? t('nv.connecting') : L.nvErrorText(nv.error, lang));
      m.classList.toggle('warn', nv.mode === 'error');
    }
    renderNvPresets();
    renderProfiles();
    renderGlobalOff();
    renderHdrOnlyStatus();
    if (!ready) return;

    const h = nv.state.hdr;
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
      if (!(nv.drag && nv.drag.id === el.id)) setNum(el, h[f]);
      sliderFill(el);
      if (f !== 'peak') setText('nv-' + f + '-out', f === 'middleGrey' ? String(h[f]) : signed(h[f]));
    }
    const num = $('nv-peak-num');
    num.disabled = !hdrOk;
    if (document.activeElement !== num) setNum(num, h.peak);
    $('nv-peak-hint').hidden = !(h.peak > 1000);

    const v = nv.state.vsr;
    setText('nv-vsr-reason', v.supported ? '' : L.nvErrorText({ code: 'unsupported', field: 'vsr' }, lang)).hidden = v.supported;
    const sel = $('nv-vsr');
    sel.disabled = !v.supported;
    setNum(sel, v.mode);
    const on = v.supported && v.level > 0;
    setText('nv-vsr-state', on ? t('nv.vsrActive', { level: t('vsrLevel.' + v.level) }) : t('nv.vsrInactive'));
    // GPU 优先级只在自动模式下有意义；驱动没有 0x32F / 0x330 时（priority / indicator 为 null）不显示
    $('nv-priority-row').hidden = !(v.supported && v.mode === 5 && v.priority !== null);
    for (const r of radios('nv-priority')) r.checked = Number(r.value) === v.priority;
    $('nv-indicator-row').hidden = nv.state.indicator === null;
    $('nv-indicator').checked = nv.state.indicator === true;
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
    const ready = nv.mode === 'ready' && !!nv.state;
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
    const missing = nv.mode === 'missing';
    const hint = !presets.length ? t(missing ? 'nv.scheduleNeedHost' : 'nv.scheduleNeedPresets') : missing ? t('panel.hostMissing') : '';
    setText('nv-schedule-hint', hint);
    $('nv-schedule-hint').hidden = !hint;
    renderSitePresets();
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
    if (!nv.state) return;
    // 「只关 HDR」正借着全局开关时，存借用前的开关（不知道时不存开关），免得以后套用这个预设把 HDR 关掉
    const base = L.nvUnleased(nv.state, hdrOnlyStatus);
    const probe = L.nvPresetFromState(base, $('nv-preset-name').value, 'probe');
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
    const preset = L.nvPresetFromState(base, probe.name, same ? same.id : nvNewId());
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

  // 经 background 套用（借用按 yield 处理：预设的开关和借用前一样时不碰借用，不闪烁）。
  // 本地组件确认写入后才提示成功；background 记下「上次套用的预设」（快捷键从它的下一个开始轮换）
  function nvApplyPreset() {
    const p = settings.nv.presets.find((x) => x.id === nvSelectedId);
    if (!p || !nv.state) return;
    const patch = L.nvPresetPatch(p, nv.state);
    if (!patch) {
      const h = nv.state.hdr;
      nvMessage(L.nvErrorText(h.supported && h.error ? { code: 'hdr-error', errorCode: h.error } : { code: 'unsupported' }, lang), true);
      return;
    }
    nvMessage(t('nv.applying', { name: p.name }), false, true);
    // 先显示预设的值；借用期间开关以 background 回的为准
    const view = L.nvMergePatch(patch, null);
    if (view.hdr && hdrOnlyStatus && hdrOnlyStatus.leased) delete view.hdr.enabled;
    nv.local(view);
    nv.exclusive(() => nvOp({ op: 'apply-preset', id: p.id })).then((res) => {
      if (!res || res.ok !== true) {
        nvMessage(t('nv.applyFailed', { err: L.nvErrorText(res && res.error, lang) }), true);
        return;
      }
      nvLastPresetId = p.id;
      nvMessage(t('nv.applied', { name: p.name }) + (res.hdrSkipped ? t('nv.partial') : ''));
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

  // ---------- 按网站切换 NVIDIA 预设 ----------

  // 本网站的下拉框和其他已绑定的网站（可以取消绑定）；绑定的增删走设置补丁，background 负责套用和恢复
  function renderSitePresets() {
    const presets = settings.nv.presets;
    const map = settings.nv.sitePresets;
    const sel = $('nv-site-preset');
    fillSelect(sel, [['', t('nv.noSwitch')]].concat(presets.map((p) => [p.id, p.name])), (tabHost && map[tabHost]) || '');
    sel.disabled = !tabHost || !presets.length;
    setText('nv-site-host', tabHost);
    // 本网站的绑定已经在下拉框里：列表只列其他网站
    const hosts = Object.keys(map).filter((h) => h !== tabHost).sort();
    const sig = JSON.stringify([hosts.map((h) => [h, map[h]]), presets.map((p) => [p.id, p.name]), lang]);
    if (sig === siteListSig) return;
    siteListSig = sig;
    const ul = $('nv-site-list');
    ul.textContent = '';
    ul.hidden = !hosts.length;
    for (const h of hosts) {
      const p = presets.find((x) => x.id === map[h]);
      const li = document.createElement('li');
      const host = document.createElement('span');
      host.className = 'sb-host';
      host.textContent = h;
      const name = document.createElement('span');
      name.className = 'sb-preset';
      name.textContent = p ? p.name : '';
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', t('site.nvPresetRemove', { host: h }));
      x.addEventListener('click', () => {
        save((s) => { delete s.nv.sitePresets[h]; });
        const next = $('nv-site-list').querySelector('button') || $('nv-site-preset');
        if (next) next.focus();
      });
      li.appendChild(host);
      li.appendChild(name);
      li.appendChild(x);
      ul.appendChild(li);
    }
  }

  // ---------- 配置档（只由 background 写：这里发 profile 消息，按回复里的列表显示） ----------

  function profileMsg(op, extra) {
    return call(() => chrome.runtime.sendMessage(Object.assign({ type: 'profile', op: op }, extra))).then(
      (r) => (r && typeof r === 'object' ? r : { ok: false, code: 'internal' }), () => ({ ok: false, code: 'internal' }));
  }

  // 要读写 NVIDIA 参数的操作：先把弹窗自己端口上的修改发完，期间暂停自己的写入，回来后重新读一次
  function profileNvMsg(op, extra) {
    return nv.mode === 'ready' ? nv.exclusive(() => profileMsg(op, extra)) : profileMsg(op, extra);
  }

  function profileError(r) {
    const key = 'profile.err.' + (r && typeof r.code === 'string' ? r.code : '');
    return Object.prototype.hasOwnProperty.call(I.DICT.zh, key) ? t(key) : L.nvErrorText(r && r.error, lang);
  }

  function pfMessage(text, warn) {
    const el = setText('pf-msg', text || '');
    el.classList.toggle('warn', !!warn);
    clearTimeout(pfMsgTimer);
    if (text) pfMsgTimer = setTimeout(() => setText('pf-msg', ''), warn ? 6000 : 3000);
  }

  // 回复里带着最新的列表和 10 分钟内还能撤销的切换
  function profilesAccept(r) {
    if (!r || r.ok !== true) return;
    profiles = L.normProfiles(r.profiles);
    pfUndo = r.undo && typeof r.undo.at === 'number' ? r.undo : null;
    renderProfiles();
  }

  async function loadProfiles() {
    profilesAccept(await profileMsg('list'));
  }

  // 当前配置档和现在的设置、NVIDIA 参数（借用期间用借用前的开关）不一致时标「已修改」
  function profileModified(p) {
    const live = nv.mode === 'ready' && nv.state ? L.nvUnleased(nv.state, hdrOnlyStatus) : null;
    const d = L.profileDiff(settings, live, p);
    return !!d && d.length > 0;
  }

  function renderProfiles() {
    const left = pfUndo ? pfUndo.at + L.PROFILE_UNDO_MS - Date.now() : 0;
    $('pf-undo').hidden = !(left > 0);
    clearTimeout(pfUndoTimer);
    if (left > 0) pfUndoTimer = setTimeout(renderProfiles, left + 100);
    const list = profiles.list;
    const active = list.find((p) => p.id === profiles.activeId) || null;
    const modified = !!active && profileModified(active);
    const armed = pfDeleteArmed ? pfDeleteArmed.id : '';
    const sig = JSON.stringify([list.map((p) => [p.id, p.name]), profiles.activeId, modified, armed, lang]);
    if (sig === pfSig) return;
    pfSig = sig;
    // 重建列表时焦点留在同一个配置档的同一个按钮上
    const ul = $('pf-list');
    const f = document.activeElement && ul.contains(document.activeElement) ? document.activeElement : null;
    const keep = f ? [f.dataset.id, f.dataset.act] : null;
    ul.textContent = '';
    for (const p of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pf-name';
      b.dataset.id = p.id;
      b.dataset.act = 'apply';
      b.title = p.name;
      b.setAttribute('aria-pressed', p === active ? 'true' : 'false');
      const n = document.createElement('span');
      n.className = 'pf-n';
      n.id = 'pf-n-' + p.id;
      n.textContent = p.name;
      b.appendChild(n);
      if (p === active && modified) {
        const m = document.createElement('span');
        m.className = 'pf-mod';
        m.textContent = t('profile.modified');
        b.appendChild(m);
      }
      b.addEventListener('click', () => applyProfile(p));
      li.appendChild(b);
      for (const [act, text, fn] of [['copy', t('profile.copy'), copyProfile], ['delete', armed === p.id ? t('nv.confirmDelete') : t('profile.delete'), deleteProfile]]) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'link';
        x.dataset.id = p.id;
        x.dataset.act = act;
        x.textContent = text;
        x.setAttribute('aria-describedby', n.id);
        x.addEventListener('click', () => fn(p));
        li.appendChild(x);
      }
      ul.appendChild(li);
    }
    if (keep) {
      const again = Array.from(ul.querySelectorAll('button')).find((x) => x.dataset.id === keep[0] && x.dataset.act === keep[1]);
      if (again) again.focus();
    }
  }

  function profileAppliedText(r) {
    if (r.nvError) return t('bg.profileNvFailed', { name: r.name, err: L.nvErrorText(r.nvError, lang) });
    if (r.hdrSkipped) return t('bg.profilePartial', { name: r.name });
    return t('profile.applied', { name: r.name });
  }

  async function applyProfile(p) {
    pfDisarmDelete();
    flushSave();
    const r = await (p.nv ? profileNvMsg('apply', { id: p.id }) : profileMsg('apply', { id: p.id }));
    if (!r || r.ok !== true) {
      pfMessage(profileError(r), true);
      loadProfiles();
      return;
    }
    profilesAccept(r);
    pfMessage(profileAppliedText(r), !!(r.nvError || r.hdrSkipped));
  }

  async function undoProfile() {
    pfDisarmDelete();
    const r = await profileNvMsg('undo');
    if (!r || r.ok !== true) {
      pfMessage(profileError(r), true);
      loadProfiles();
      return;
    }
    profilesAccept(r);
    if (r.nvError) pfMessage(L.nvErrorText(r.nvError, lang), true);
    else pfMessage(t('profile.undone'));
    ($('pf-list').querySelector('button') || $('pf-save')).focus();
  }

  // 保存表单和粘贴表单同一时间只开一个
  function showPfForm(which) {
    $('pf-form').hidden = which !== 'save';
    $('pf-paste-form').hidden = which !== 'paste';
    $('pf-save').setAttribute('aria-expanded', String(which === 'save'));
    $('pf-paste').setAttribute('aria-expanded', String(which === 'paste'));
    pfOverwriteName = null;
    if (which === 'save') {
      const names = new Set(profiles.list.map((p) => p.name));
      let n = profiles.list.length + 1;
      while (names.has(t('profile.defaultName', { n: n }))) n++;
      const input = $('pf-name');
      input.value = t('profile.defaultName', { n: n });
      const nvOk = nv.mode === 'ready' && !!nv.state;
      $('pf-nv').disabled = !nvOk;
      $('pf-nv').checked = nvOk;
      $('pf-sites').checked = false;
      input.focus();
      input.select();
    } else if (which === 'paste') {
      $('pf-text').value = '';
      $('pf-text').focus();
    }
  }

  // 同名的先提示，再保存一次才覆盖
  async function saveProfile() {
    const name = L.nvName($('pf-name').value);
    if (!name) {
      pfMessage(t('profile.err.name'), true);
      $('pf-name').focus();
      return;
    }
    flushSave();
    const req = { name: name, sites: $('pf-sites').checked, nv: $('pf-nv').checked && !$('pf-nv').disabled, overwrite: pfOverwriteName === name };
    const r = await (req.nv ? profileNvMsg('save', req) : profileMsg('save', req));
    if (!r || r.ok !== true) {
      if (r && r.code === 'exists') {
        pfOverwriteName = name;
        pfMessage(t('profile.overwrite', { name: name }), true);
        $('pf-name').focus();
        return;
      }
      pfMessage(profileError(r), true);
      return;
    }
    profilesAccept(r);
    showPfForm(null);
    $('pf-save').focus();
    pfMessage(t(r.overwrote ? 'profile.updated' : 'profile.saved', { name: name }));
  }

  // 复制为文本：和配置档文件同一个格式（只有一个配置档）
  async function copyProfile(p) {
    pfDisarmDelete();
    let v = '';
    try { v = chrome.runtime.getManifest().version; } catch (e) { v = ''; }
    try {
      await navigator.clipboard.writeText(JSON.stringify(L.makeProfilesFile([p], v)));
      pfMessage(t('profile.copied', { name: p.name }));
    } catch (e) {
      pfMessage((e && e.message) || 'error', true);
    }
  }

  function importResultText(r) {
    const n = r.added.length;
    const renamed = r.added.filter((a) => a.renamed).length;
    let text = renamed ? t('profile.importedRenamed', { n: n, renamed: renamed }) : t('profile.imported', { n: n });
    if (r.dropped) text += (lang === 'en' ? '. ' : '；') + t('profile.dropped', { n: r.dropped });
    return text;
  }

  async function importProfiles() {
    let obj = null;
    try { obj = JSON.parse($('pf-text').value); } catch (e) { obj = null; }
    const v = L.validateProfilesFile(obj);
    if (!v.ok) {
      pfMessage(t('profile.err.' + v.code), true);
      $('pf-text').focus();
      return;
    }
    const r = await profileMsg('import', { profiles: v.profiles });
    if (!r || r.ok !== true) {
      pfMessage(profileError(r), true);
      return;
    }
    profilesAccept(r);
    showPfForm(null);
    $('pf-paste').focus();
    pfMessage(importResultText(r), !!r.dropped);
  }

  function pfDisarmDelete() {
    if (!pfDeleteArmed) return;
    clearTimeout(pfDeleteArmed.timer);
    pfDeleteArmed = null;
    renderProfiles();
  }

  // 删除不能撤销：第一次只把按钮变成「确认删除？」，4 秒内再按一次才删
  async function deleteProfile(p) {
    if (!pfDeleteArmed || pfDeleteArmed.id !== p.id) {
      pfDisarmDelete();
      const ask = t('profile.deleteAsk', { name: p.name });
      pfDeleteArmed = {
        id: p.id,
        timer: setTimeout(() => {
          if ($('pf-msg').textContent === ask) pfMessage('');
          pfDisarmDelete();
        }, NV_CONFIRM_MS)
      };
      renderProfiles();
      pfMessage(ask, true);
      return;
    }
    clearTimeout(pfDeleteArmed.timer);
    pfDeleteArmed = null;
    const r = await profileMsg('delete', { id: p.id });
    if (!r || r.ok !== true) {
      pfMessage(profileError(r), true);
      loadProfiles();
      return;
    }
    profilesAccept(r);
    $('pf-save').focus();
    pfMessage(t('profile.deleted', { name: p.name }));
  }

  function bindProfiles() {
    $('pf-undo').addEventListener('click', undoProfile);
    $('pf-save').addEventListener('click', () => showPfForm($('pf-form').hidden ? 'save' : null));
    $('pf-paste').addEventListener('click', () => showPfForm($('pf-paste-form').hidden ? 'paste' : null));
    $('pf-save-ok').addEventListener('click', saveProfile);
    $('pf-import').addEventListener('click', importProfiles);
    $('pf-save-cancel').addEventListener('click', () => {
      showPfForm(null);
      $('pf-save').focus();
    });
    $('pf-paste-cancel').addEventListener('click', () => {
      showPfForm(null);
      $('pf-paste').focus();
    });
    $('pf-name').addEventListener('input', () => { pfOverwriteName = null; });
    $('pf-name').addEventListener('keydown', (e) => {
      if (e.isComposing) return; // 输入法选词时的回车不算
      if (e.key === 'Enter') {
        e.preventDefault();
        saveProfile();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        showPfForm(null);
        $('pf-save').focus();
      }
    });
    onChange('nv-site-preset', (el) => save((s) => {
      if (!tabHost) return;
      if (el.value) s.nv.sitePresets[tabHost] = el.value;
      else delete s.nv.sitePresets[tabHost];
    }, NV_DEBOUNCE_MS));
  }

  // ---------- 更新提醒（只由 background 检查和写 updateState：这里只显示、发 update 消息） ----------

  function updateMsg(op, extra) {
    return call(() => chrome.runtime.sendMessage(Object.assign({ type: 'update', op: op }, extra))).then(
      (r) => (r && r.ok === true ? r : null), () => null);
  }

  async function loadUpdate() {
    const r = await updateMsg('state');
    if (r) upView = r;
    renderUpdate();
    renderFoot();
  }

  // 规则页签顶部的提醒卡、页签上的小点；「检查新版本」只在解压安装时出现
  function renderUpdate() {
    const n = upView && upView.notice;
    $('up-card').hidden = !n;
    $('tab-rules').classList.toggle('has-dot', !!n);
    if (n) {
      const title = t('update.title', { version: n.version });
      setText('up-title', title);
      $('tab-rules').setAttribute('aria-description', title);
      $('up-zip').hidden = !n.zip;
    } else {
      $('tab-rules').removeAttribute('aria-description');
    }
    $('update-check-row').hidden = !(upView && upView.dev);
    setChecked('update-check', settings.updateCheck);
  }

  // 跳过、7 天内不提醒：卡片先收起，background 改完回复新的状态（图标的小点由它去掉）
  async function dismissUpdate(op) {
    const n = upView && upView.notice;
    if (!n) return;
    upView = Object.assign({}, upView, { notice: null });
    renderUpdate();
    renderFoot();
    $('tab-rules').focus();
    const r = await updateMsg(op, { version: n.version });
    if (r) upView = r;
    renderUpdate();
    renderFoot();
  }

  function openUrl(url) {
    if (url) call(() => chrome.tabs.create({ url: url })).catch(noop);
  }

  function bindUpdate() {
    $('up-backup').addEventListener('click', () => openOptions('#export'));
    $('up-zip').addEventListener('click', () => openUrl(upView && upView.notice && upView.notice.zip));
    $('up-release').addEventListener('click', () => openUrl(upView && upView.notice && upView.notice.url));
    $('up-skip').addEventListener('click', () => dismissUpdate('skip'));
    $('up-snooze').addEventListener('click', () => dismissUpdate('snooze'));
    onChange('update-check', (el) => save((s) => { s.updateCheck = el.checked; }));
    $('foot-diag').addEventListener('click', () => {
      openUrl(chrome.runtime.getURL('diag.html' + (tabId !== null ? '?tab=' + tabId : '')));
    });
  }

  // ---------- NVIDIA 修改记录：「上一次」和撤销 ----------

  // 修改记录（background 写在 storage.session）里最新的一条修改（只关 HDR 的借用不算）：10 秒内显示「上一次：…」和撤销。
  // 最新的是撤销、失败的或已经撤销过的修改时不显示
  function nvLastAccept(raw) {
    const list = L.nvNormLog(raw).list;
    let e = null;
    for (let i = list.length - 1; i >= 0 && !e; i--) if (list[i].source !== 'lease') e = list[i];
    nvLastEntry = e && e.ok && e.undoable && !e.undone && e.source !== 'undo' ? e : null;
    renderNvLast();
  }

  async function loadNvLast() {
    const r = await call(() => chrome.storage.session.get(NV_LOG_KEY)).catch(() => null);
    nvLastAccept(r && r[NV_LOG_KEY]);
  }

  function renderNvLast() {
    clearTimeout(nvLastTimer);
    const e = nvLastEntry;
    const left = e ? e.at + NV_LAST_MS - Date.now() : 0;
    const change = left > 0 ? L.nvChangeText(e, lang) : '';
    $('nv-last').hidden = !change;
    if (!change) return;
    // 自己（弹窗）刚改的不写来源
    setText('nv-last-text', e.source === 'popup' ? t('nv.last', { change: change }) : t('nv.undoLast', { change: change, source: t('nv.source.' + e.source) }));
    nvLastTimer = setTimeout(renderNvLast, left + 50);
  }

  function undoResultText(res) {
    if (res && res.ok === true) {
      const tg = res.target || {};
      return t('nv.undoDone', { change: L.nvChangeText(res.diff, lang) || L.nvChangeText({ before: tg.after, after: tg.before }, lang) });
    }
    if (res && res.code === 'none') return t('nv.undoNone');
    if (res && res.empty && !(res.unavailable && res.unavailable.length) && res.skipped && res.skipped.length) {
      return t('nv.undoSkipped', { fields: res.skipped.map((f) => t('nv.field.' + f)).join(lang === 'en' ? ', ' : '、') });
    }
    return t('nv.undoFailed', { err: L.nvErrorText(res && res.error, lang) });
  }

  // 撤销走 background（nv-op undo，和快捷键同一个服务）：先把自己端口上的修改发完，期间暂停自己的写入
  async function nvUndoLast() {
    const btn = $('nv-undo');
    btn.disabled = true;
    const res = await nv.exclusive(() => nvOp({ op: 'undo' }));
    btn.disabled = false;
    nvMessage(undoResultText(res), !(res && (res.ok === true || res.code === 'none')));
    await loadNvLast();
    if ($('nv-last').hidden) $('tab-nv').focus();
  }

  // 拖回起点时 Chrome 不发 change，松手时照样提交一次
  function nvEndDrag() {
    const d = nv.dragEnd();
    if (!d) return;
    const el = $(d.id);
    if (d.moved && el.value === d.start) nv.write({ hdr: { [el.dataset.field]: Number(el.value) } }, true);
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
    if (!nv.caps.display || sdrBusy) return;
    sdrBusy = true;
    renderSdr();
    let res = null;
    try {
      res = await nv.request({ cmd: 'display' });
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

  // 跟随 SDR 亮度：弹窗开着时每 2 秒读一次白电平，和上次调中间灰时不一样就请 background 调
  // （它读显示器、写中间灰、成功后才记下这个白电平；弹窗关着时它每 30 秒自己看一次）
  function sdrFollow() {
    if (!settings.nv.followSdr || !nv.state || nv.busy()) return;
    const d = sdrCurrent();
    const sug = d && L.nvSuggest(d, nv.state);
    if (!sug || d.sdrWhiteNits === sdrLastWhite) return;
    const now = Date.now();
    if (sdrAsked && sdrAsked.white === d.sdrWhiteNits && now - sdrAsked.at < SDR_ASK_MS) return;
    sdrAsked = { white: d.sdrWhiteNits, at: now };
    nv.exclusive(() => nvOp({ op: 'follow-check' }));
  }

  function sdrSyncPolling() {
    const want = settings.nv.followSdr && nv.caps.display && nv.mode === 'ready';
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
    read.disabled = sdrBusy || !nv.caps.display || nv.mode !== 'ready';
    const ready = nv.mode === 'ready' && !!nv.state;
    const list = sdrDisplays || [];
    $('sdr-display-wrap').hidden = list.length < 2;
    if (list.length >= 2) {
      const d0 = sdrCurrent();
      fillSelect($('sdr-display'), list.map((d) => [d.id, d.name || d.id]), d0 ? d0.id : '');
    }
    const d = sdrCurrent();
    const sug = ready && d ? L.nvSuggest(d, nv.state) : null;
    $('sdr-empty').hidden = !!sdrDisplays;
    $('sdr-body').hidden = !d;
    $('sdr-actions').hidden = !sug;
    if (!ready) return;
    if (nv.mode === 'ready' && !nv.caps.display) {
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
    const h = nv.state.hdr;
    renderSug('sug-mg', h.middleGrey, sug.middleGrey, String);
    renderSug('sug-peak', h.peak, sug.peak, String);
    renderSug('sug-con', h.contrast, sug.contrast, signed);
    $('sdr-follow').checked = settings.nv.followSdr;
  }

  function sdrSync() {
    const d = sdrCurrent();
    const sug = d && nv.state ? L.nvSuggest(d, nv.state) : null;
    if (!sug) return;
    const h = nv.state.hdr;
    const hdr = {};
    if ($('sug-mg').checked && sug.middleGrey !== h.middleGrey) hdr.middleGrey = sug.middleGrey;
    if ($('sug-peak').checked && sug.peak !== h.peak) hdr.peak = sug.peak;
    if ($('sug-con').checked && sug.contrast !== h.contrast) hdr.contrast = sug.contrast;
    // 记下这个白电平，跟随 SDR 不再按它重调；建议值已经一样或写成功了才记
    const white = d.sdrWhiteNits;
    const remember = () => {
      sdrLastWhite = white;
      call(() => chrome.storage.local.set({ [SDR_LAST_KEY]: white })).catch(noop);
    };
    if (!Object.keys(hdr).length) {
      remember();
      sdrMessage(t('sdr.nothing'));
      return;
    }
    nv.write({ hdr: hdr }, true, (res) => {
      if (res && res.ok === true) {
        remember();
        sdrMessage(t('sdr.synced'));
      } else {
        sdrMessage(L.nvErrorText(res && res.error, lang), true);
      }
    });
  }

  function nvBind() {
    for (const f of NV_SLIDERS) {
      const el = $('nv-' + f);
      el.dataset.field = f;
      el.addEventListener('pointerdown', () => nv.dragBegin(el.id, el.value));
      el.addEventListener('input', () => {
        nv.dragMove(el.id);
        sliderFill(el);
        nv.write({ hdr: { [f]: Number(el.value) } }, false);
      });
      el.addEventListener('change', () => {
        nv.dragClear(el.id);
        nv.write({ hdr: { [f]: Number(el.value) } }, true);
      });
    }
    window.addEventListener('pointerup', nvEndDrag);
    window.addEventListener('pointercancel', nvEndDrag);

    onChange('nv-peak-num', (el) => {
      const h = nv.state && nv.state.hdr;
      const n = Math.round(Number(el.value));
      if (!h || el.value.trim() === '' || !isFinite(n)) {
        if (h) el.value = String(h.peak);
        return;
      }
      const peak = Math.min(h.peakMax, Math.max(h.peakMin, n));
      el.value = String(peak); // 超出范围时写回夹过的值
      nv.write({ hdr: { peak: peak } }, true);
    });
    onChange('nv-hdr', (el) => nvSetEnabled(el.checked));
    onChange('nv-vsr', (el) => nv.write({ vsr: { mode: Number(el.value) } }, 'soon'));
    for (const r of radios('nv-priority')) {
      r.addEventListener('change', () => { if (r.checked) nv.write({ vsr: { priority: Number(r.value) } }, true); });
    }
    onChange('nv-indicator', (el) => nv.write({ indicator: el.checked }, true));

    $('sdr-read').addEventListener('click', () => sdrRead());
    $('sdr-sync').addEventListener('click', sdrSync);
    onChange('sdr-display', (el) => save((s) => { s.nv.displayId = el.value || null; }));
    // 打开时 background 清掉上次的白电平，按当前白电平立刻调一次
    onChange('sdr-follow', (el) => {
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
    $('nv-undo').addEventListener('click', nvUndoLast);
    $('nv-install').addEventListener('click', (e) => {
      e.preventDefault();
      call(() => chrome.tabs.create({ url: e.currentTarget.href })).catch(noop);
    });
    // 弹窗关闭前把还没发出去的修改直接发出去：设置补丁（防抖中的、拖动取色器时的）交给 background，
    // NVIDIA 的修改由 nv-client 合并成一次直接发（不等回复，见 flushNow）
    window.addEventListener('pagehide', () => {
      if (accentTimer) {
        clearTimeout(accentTimer);
        accentTimer = 0;
        const v = $('theme-custom').value;
        if (v) stage((s) => { s.ui.accent = v; });
      }
      flushSave();
      nv.flushNow();
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
    // 播放器面板的「完整设置」打不开弹窗时会在新标签页里打开这里，带上视频所在的标签页（?tab=id）
    const asked = /^\?tab=(\d{1,10})$/.exec(location.search);
    try {
      if (asked) {
        tab = await chrome.tabs.get(Number(asked[1]));
      } else {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs && tabs[0];
      }
    } catch (e) { tab = null; }
    tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
    const url = (tab && (tab.url || tab.pendingUrl)) || '';
    usable = tabId !== null && scriptable(url);
    isFile = /^file:/i.test(url);
    if (tabId !== null && !url) {
      try {
        maybeFile = (await chrome.extension.isAllowedFileSchemeAccess()) === false;
      } catch (e) { maybeFile = false; }
    }
    tabHost = usable ? L.normalizeHost(L.hostOf(url)) : '';
    $('site-host').textContent = tabHost || '';
    $('site-rule').disabled = !tabHost;

    let hotkeyError = null;
    let savedTab = 'video';
    try {
      const r = await chrome.storage.local.get(['settings', NV_LAST_PRESET_KEY, NV_HOTKEY_ERROR_KEY, TAB_KEY, HDR_ONLY_KEY, SDR_LAST_KEY]);
      stored = L.mergeSettings(r && r.settings);
      settings = stored;
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
    bindProfiles();
    bindUpdate();
    loadProfiles();
    loadUpdate();
    loadNvLast();
    // 快捷键切换预设失败时当前页面显示不了提示（chrome:// 页面等）：在这里补一次，只显示一次
    if (hotkeyError) {
      call(() => chrome.storage.local.remove(NV_HOTKEY_ERROR_KEY)).catch(noop);
      const age = Date.now() - (+hotkeyError.at || 0);
      if (typeof hotkeyError.text === 'string' && age >= 0 && age < NV_HOTKEY_ERROR_MAX_AGE) nvMessage(hotkeyError.text.slice(0, 200), true);
    }
    nvStart().catch(() => nv.failed(null)); // NVIDIA 设置与当前页面无关，chrome:// 页面也能用

    if (!usable) {
      renderState(null);
      return;
    }
    await refresh();
    setInterval(refresh, REFRESH_MS);
  }

  init().catch(() => showMessage(t('video.unusable'), false));
})();
