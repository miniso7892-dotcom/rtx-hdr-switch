/*
 * RTX HDR 开关 —— 播放器内设置面板（panel.html，内容脚本插进播放器的扩展 iframe）。
 * 只和插入它的内容脚本通过 tabs.connect 端口通信（握手核对 frameId 和 nonce），不收也不发 window message；
 * 设置经 background 的 settings-patch，全局 HDR 开关、套用预设、还原经 nv-op，滑块走自己的本地组件端口（nv-client）。
 * 所有写入只在用户的可信事件里发出
 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const I = globalThis.RtxHdrI18n;
  const U = globalThis.RtxHdrUi;
  const C = globalThis.RtxHdrNvClient;
  const $ = (id) => document.getElementById(id);
  const PORT_NAME = 'rtxhdr-panel';
  const TAB_KEY = 'panelTab';
  const TABS = ['video', 'nv', 'profiles'];
  const HDR_ONLY_KEY = 'hdrOnlyStatus'; // background 写：{active, leased, prevEnabled?, error?}
  const NV_LAST_PRESET_KEY = 'nvLastPresetId';
  const PROFILES_KEY = 'profiles';
  const NV_POLL_MS = 2000;
  const NV_IDLE_MS = 20000; // 面板收起这么久后断开本地组件端口
  const ACTIVITY_MS = 500;
  const NV_SLIDERS = ['peak', 'middleGrey', 'contrast', 'saturation'];
  const PRESETS_MAX = 20;
  const PROFILES_MAX = 20;

  let uiLanguage = '';
  try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = navigator.language || ''; }
  let lang = 'zh';
  const t = (key, params) => I.t(lang, key, params);

  let port = null;
  let ownTab = null; // 面板所在的标签页
  let ready = false; // 收到了内容脚本的 init
  let open = false; // 内容脚本让面板显示着
  let pinned = false; // 这次打开后发过 pin
  let topHost = ''; // 顶层页面的域名（规范化过）：「本网站」改的就是它
  let vstate = null; // 内容脚本推来的视频状态
  let stored = L.mergeSettings(null); // storage 里的设置
  let settings = stored; // 界面上的设置：stored 叠加还没被 background 收下的补丁
  const pending = []; // 已发给 background、还没回复的设置补丁
  let hdrOnlyStatus = null;
  let nvLastPresetId = null;
  let nvStarted = false;
  let nvIdleTimer = 0;
  let openSnap = null; // 打开面板时的 NVIDIA 设置（借用前的值），「还原到打开时」用
  let openSeq = 0;
  let profilesOn = false; // background 支持配置档（profile list 有回复）
  let profiles = null; // {list, activeId}
  let tab = 'video';
  let activityAt = 0;
  let peekOn = false;
  let dragHold = false; // 拖滑块期间告诉内容脚本别按「离开」收起
  let langSig = '';
  let presetSig = '';
  let profileSig = '';
  const msgTimers = {};
  const sliders = {}; // field → {row, input, out}

  // NVIDIA 设置：自己的本地组件端口（滑块低延迟）；全局 HDR 开关、预设、还原交给 background（nv-op）。
  // 端口用不了时滑块也改走 nv-op（面板不能用 nv 桥写入）
  const nv = C.create({
    pollMs: NV_POLL_MS,
    log: true,
    onChange: () => renderNv(),
    onError: (err) => message('nv-msg', L.nvErrorText(err, lang), true),
    bridgeSet: (payload) => nvOp({ op: 'set', patch: payload, mode: 'yield' })
  });

  function noop() {}

  function call(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  function radios(name) {
    return document.querySelectorAll('input[name="' + name + '"]');
  }

  function setText(id, text) {
    return U.setText($(id), text);
  }

  // 用户在显示着的面板里的可信操作才算。收起以后焦点还留在面板里时的按键不算，界面撤回原样
  function act(e) {
    if (!e.isTrusted) return false;
    if (open) return true;
    renderAll();
    return false;
  }

  function post(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (e) { /* 端口已断开 */ }
  }

  // 状态提示：过几秒自己消失（warn 的久一点）
  function message(id, text, warn) {
    const el = setText(id, text || '');
    el.classList.toggle('warn', !!warn);
    clearTimeout(msgTimers[id]);
    if (text) msgTimers[id] = setTimeout(() => setText(id, ''), warn ? 6000 : 3000);
  }

  // ---------- 只在播放器网页里的 iframe 中工作 ----------

  // 顶层打开、或者嵌在别的网站里时什么都不显示
  function embeddedInPlayer() {
    let top = true;
    try { top = window.top === window; } catch (e) { top = false; }
    if (top) return false;
    let ao = null;
    try { ao = location.ancestorOrigins; } catch (e) { ao = null; }
    if (!ao || !ao.length) return false;
    let u;
    try { u = new URL(ao[0]); } catch (e) { return false; }
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!L.playerSite(u.hostname, '/');
  }

  // 连上插入我们的内容脚本：标签页来自 tabs.getCurrent，父 frame 的 id 和 nonce 在 hash 里（内容脚本经 location.replace
  // 交给这个 iframe，网页读不到；扩展页面拿不到 frameId）；第一条消息是带 nonce 的 hello
  async function connect() {
    let tabId = null;
    try {
      const tab0 = await chrome.tabs.getCurrent();
      tabId = tab0 && Number.isInteger(tab0.id) ? tab0.id : null;
    } catch (e) { tabId = null; }
    const hash = new URLSearchParams(location.hash.slice(1));
    const parent = /^\d+$/.test(hash.get('f') || '') ? Number(hash.get('f')) : -1;
    const nonce = hash.get('n') || '';
    if (tabId === null || !(parent >= 0) || !nonce) return;
    ownTab = tabId;
    // 先向 background 认领自己（它从 sender 知道本 iframe 的 frameId），内容脚本握手后凭同一个 nonce 登记
    const claim = await call(() => chrome.runtime.sendMessage({ type: 'panel-claim', nonce: nonce })).catch(() => null);
    if (!claim || claim.ok !== true) return;
    try {
      port = chrome.tabs.connect(tabId, { frameId: parent, name: PORT_NAME });
    } catch (e) {
      port = null;
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(onPortGone);
    post({ type: 'hello', nonce: nonce });
  }

  // 内容脚本发来的只有 init、state、open、close：面板不会因为它们写任何东西
  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
      if (ready) return;
      ready = true;
      topHost = L.normalizeHost(typeof msg.topHost === 'string' ? msg.topHost : '');
      vstate = msg.state && typeof msg.state === 'object' ? msg.state : null;
      $('panel').hidden = false;
      renderAll();
      selectTab(tab, false);
      watchSize();
      loadProfiles();
      return;
    }
    if (!ready) return;
    if (msg.type === 'state') {
      vstate = msg.state && typeof msg.state === 'object' ? msg.state : null;
      renderVideo();
    } else if (msg.type === 'open') {
      onOpen(msg.focus === true);
    } else if (msg.type === 'close') {
      onClose();
    }
  }

  // 内容脚本那边拆掉了面板（或者扩展失效）：不再显示任何东西
  function onPortGone() {
    port = null;
    ready = false;
    $('panel').hidden = true;
    onClose();
  }

  function onOpen(focus) {
    if (!open) {
      open = true;
      pinned = false;
      openSnap = null;
      clearTimeout(nvIdleTimer);
      nvIdleTimer = 0;
      nvRefresh(++openSeq);
      loadProfiles();
    }
    if (focus) focusFirst();
  }

  function onClose() {
    open = false;
    try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch (e) { /* ignore */ }
    endPeek();
    showProfileForm(false);
    clearTimeout(nvIdleTimer);
    nvIdleTimer = setTimeout(nvIdle, NV_IDLE_MS);
  }

  // 打开时读一次最新的 NVIDIA 设置，记下「打开时的值」（借用期间用借用前的开关）
  function nvRefresh(seq) {
    let p;
    if (nvStarted) {
      p = nv.poll();
    } else {
      nvStarted = true;
      p = nv.start();
    }
    Promise.resolve(p).catch(noop).then(() => {
      if (seq !== openSeq || !open || openSnap || nv.mode !== 'ready' || !nv.state) return;
      openSnap = L.nvUnleased(nv.state, hdrOnlyStatus);
      renderNv();
    });
  }

  // 收起 20 秒后断开本地组件端口（还有修改没写完就再等等）
  function nvIdle() {
    nvIdleTimer = 0;
    if (open || !nvStarted) return;
    if (nv.busy()) {
      nvIdleTimer = setTimeout(nvIdle, 1000);
      return;
    }
    nv.stop();
    nvStarted = false;
  }

  // ---------- 语言、主题、尺寸 ----------

  function applyLang() {
    const next = I.resolve(settings.ui.lang, uiLanguage);
    if (next === langSig) return;
    langSig = next;
    lang = next;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const s = t(el.dataset.i18n);
      if (el.textContent !== s) el.textContent = s;
    }
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const i = pair.indexOf(':');
        if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      }
    }
    for (const f of NV_SLIDERS) if (sliders[f]) sliders[f].row.firstChild.textContent = t('nv.' + f);
    presetSig = '';
    profileSig = '';
  }

  // 高度报给内容脚本，它按这个高度定位（放不下时在面板里滚动）
  function watchSize() {
    const el = $('panel');
    const send = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) post({ type: 'size', h: h });
    };
    try { new ResizeObserver(send).observe(el); } catch (e) { /* ignore */ }
    send();
  }

  function selectTab(name, focus) {
    if (TABS.indexOf(name) < 0 || (name === 'profiles' && !profilesOn)) name = 'video';
    tab = name;
    for (const n of TABS) {
      const b = $('tab-' + n);
      const on = n === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      $('pane-' + n).hidden = !on;
    }
    if (focus) $('tab-' + name).focus();
  }

  function focusFirst() {
    try { $('tab-' + tab).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  // ---------- 本视频 ----------

  function renderVideo() {
    const st = vstate || {};
    const has = !!st.hasVideo;
    const known = has && (st.state === 'on' || st.state === 'off');
    const off = known && st.state === 'off';
    setText('v-state', !known ? '—' : off ? 'SDR' : 'HDR').classList.toggle('sdr', off);
    // 原因直接跟在大字后面，不加「原因：」
    setText('v-reason', known ? L.reasonText(st.reason, lang) : '');
    let note = '';
    if (!has) note = t('panel.noVideo');
    else if (st.drm) note = t('panel.drm');
    else if (st.pip) note = t('panel.pip');
    else if (off && st.hdrOnly) note = t('video.vsrKept');
    const n = setText('v-note', note);
    n.hidden = !note;
    n.classList.toggle('warn', !has || !!st.drm);
    const locked = !has || !!st.drm;
    const choice = L.panelVideoChoice(st);
    for (const r of radios('v-mode')) {
      r.checked = r.value === choice;
      r.disabled = locked;
    }
    const tabBox = $('v-tab');
    tabBox.checked = st.tab === 'on' || st.tab === 'off';
    tabBox.disabled = locked && !tabBox.checked;
    $('v-peek').disabled = locked || !known;
    if (!$('v-peek').disabled) $('v-peek').setAttribute('aria-pressed', st.peek ? 'true' : 'false');
  }

  function renderSettings() {
    applyLang();
    U.applyTheme(document.documentElement, settings.ui.accent);
    // 屏幕上只写域名；读屏软件读「本网站：域名」
    setText('site-host', topHost || '—');
    U.setAttr($('site-rule'), 'aria-label', t('panel.thisSite', { host: topHost || '—' }));
    const rule = (topHost && settings.sites[topHost]) || '';
    for (const r of radios('site-rule')) {
      r.checked = r.value === rule;
      r.disabled = !topHost;
    }
    for (const r of radios('auto-mode')) r.checked = r.value === settings.autoDetect;
    for (const r of radios('sensitivity')) {
      r.checked = r.value === settings.sensitivity;
      r.disabled = settings.autoDetect === 'off';
    }
  }

  function renderAll() {
    renderSettings();
    renderVideo();
    renderNv();
    renderProfiles();
  }

  // 设置只由 background 写：发补丁（它再检查一遍：只能改白名单字段和本网站那一条），界面先按补丁显示
  function patchSettings(patch) {
    const entry = { patch: patch };
    pending.push(entry);
    rebase();
    call(() => chrome.runtime.sendMessage({ type: 'settings-patch', patch: patch })).then(
      (r) => !!r && r.ok === true, () => false
    ).then((ok) => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      if (!ok) message('v-msg', t('panel.saveFailed'), true);
      rebase();
    });
  }

  function rebase() {
    let p = null;
    for (const e of pending) p = L.mergeSettingsPatch(p, e.patch);
    settings = (p && L.applySettingsPatch(stored, p)) || stored;
    renderSettings();
    renderPresets();
  }

  // 按住对比：按下开始、松开结束（拖出按钮、面板收起也结束）
  function startPeek() {
    if (peekOn || $('v-peek').disabled) return;
    peekOn = true;
    post({ type: 'hold', on: true });
    post({ type: 'peek', on: true });
  }

  function endPeek() {
    if (!peekOn) return;
    peekOn = false;
    post({ type: 'peek', on: false });
    if (!dragHold) post({ type: 'hold', on: false });
  }

  function bindVideo() {
    for (const r of radios('v-mode')) {
      r.addEventListener('change', (e) => {
        if (!act(e) || !r.checked) return;
        post({ type: 'video', op: r.value === 'follow' ? 'clear' : r.value });
      });
    }
    $('v-tab').addEventListener('change', (e) => {
      if (act(e)) post({ type: 'tab', on: e.target.checked });
    });
    const pk = $('v-peek');
    pk.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0 || !act(e)) return;
      try { pk.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      startPeek();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pk.addEventListener(type, endPeek);
    pk.addEventListener('keydown', (e) => {
      if (e.repeat || (e.key !== ' ' && e.key !== 'Enter') || !act(e)) return;
      e.preventDefault();
      startPeek();
    });
    pk.addEventListener('keyup', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      endPeek();
    });
    pk.addEventListener('blur', endPeek);

    for (const r of radios('site-rule')) {
      r.addEventListener('change', (e) => {
        if (!act(e) || !r.checked || !topHost) return;
        patchSettings({ sites: { [topHost]: r.value || null } });
      });
    }
    for (const r of radios('auto-mode')) {
      r.addEventListener('change', (e) => {
        if (!act(e) || !r.checked) return;
        const patch = { autoDetect: r.value };
        if (r.value !== 'off') patch.autoLastMode = r.value;
        patchSettings(patch);
      });
    }
    for (const r of radios('sensitivity')) {
      r.addEventListener('change', (e) => {
        if (act(e) && r.checked) patchSettings({ sensitivity: r.value });
      });
    }
  }

  // ---------- NVIDIA ----------

  function nvOp(msg) {
    return call(() => chrome.runtime.sendMessage(Object.assign({ type: 'nv-op' }, msg))).then(
      (r) => (r && typeof r === 'object' ? r : { ok: false, error: { code: 'host-error' } }),
      (e) => L.nvPortError((e && e.message) || 'error'));
  }

  function leased() {
    return !!(hdrOnlyStatus && hdrOnlyStatus.leased);
  }

  function buildSliders() {
    const box = $('nv-sliders');
    for (const f of NV_SLIDERS) {
      const r = U.sliderRow({ id: 'nv-' + f, field: f, label: t('nv.' + f), step: f === 'peak' ? 10 : 1 });
      sliders[f] = r;
      box.appendChild(r.row);
    }
  }

  function renderNv() {
    const ok = nv.mode === 'ready' && !!nv.state;
    const missing = nv.mode === 'missing';
    const fatal = nv.mode === 'error';
    // 本地组件缺失、NVIDIA App 出错：整页只剩一行说明和「安装方法」
    $('nv-missing').hidden = !(missing || fatal);
    if (missing) setText('nv-missing-text', t('panel.hostMissing'));
    else if (fatal) setText('nv-missing-text', L.nvErrorText(nv.error, lang));
    $('nv-message').hidden = ok || missing || fatal;
    $('nv-body').hidden = !ok;
    if (!ok) return;

    const h = nv.state.hdr;
    const hdrOk = h.supported && !h.error;
    // 「只关 HDR」借着全局开关时：开关按借用前的值显示
    const lease = leased();
    const prev = lease && typeof hdrOnlyStatus.prevEnabled === 'boolean' ? hdrOnlyStatus.prevEnabled : h.enabled;
    const sw = $('nv-hdr');
    sw.checked = lease ? prev : h.enabled;
    sw.disabled = !hdrOk;
    // 开关下面只在出错、或者「只关 HDR」借着开关（开关显示的是借用前的值）时写一行
    const err = !h.supported ? L.nvErrorText({ code: 'unsupported', field: 'hdr' }, lang) : L.nvHdrErrorText(h.error, lang);
    const note = err || (lease ? t('panel.leased') : '');
    const hn = setText('nv-hdr-reason', note);
    hn.hidden = !note;
    hn.classList.toggle('warn', !!err);

    // 和 NVIDIA App 一样：最高亮度上限不超过 400 时不显示这个滑块
    sliders.peak.row.hidden = !(h.peakMax > 400);
    U.setAttr(sliders.peak.input, 'min', h.peakMin);
    U.setAttr(sliders.peak.input, 'max', h.peakMax);
    for (const f of NV_SLIDERS) {
      const s = sliders[f];
      s.input.disabled = !hdrOk;
      if (!(nv.drag && nv.drag.id === s.input.id)) U.setNum(s.input, h[f]);
      U.sliderFill(s.input);
      U.setText(s.out, f === 'contrast' || f === 'saturation' ? U.signed(Number(s.input.value)) : String(s.input.value));
    }

    const v = nv.state.vsr;
    for (const r of radios('nv-vsr')) {
      r.checked = Number(r.value) === v.mode;
      r.disabled = !v.supported;
    }
    const vsrErr = v.supported ? '' : L.nvErrorText({ code: 'unsupported', field: 'vsr' }, lang);
    setText('nv-vsr-reason', vsrErr).hidden = !vsrErr;
    // GPU 优先级只在自动模式下有意义；驱动没有对应的值时不显示
    $('nv-priority-row').hidden = !(v.supported && v.mode === 5 && v.priority !== null);
    for (const r of radios('nv-priority')) r.checked = Number(r.value) === v.priority;
    renderPresets();
    $('nv-revert').disabled = !revertPatch();
  }

  // 预设标签：点一下就套用；上次套用的那个高亮
  function renderPresets() {
    const box = $('nv-presets');
    const list = settings.nv.presets.slice(0, PRESETS_MAX);
    const ok = nv.mode === 'ready' && !!nv.state;
    const sig = JSON.stringify([list.map((p) => [p.id, p.name]), nvLastPresetId, ok, lang]);
    if (sig === presetSig) return;
    presetSig = sig;
    box.textContent = '';
    if (!list.length) {
      const e = document.createElement('span');
      e.className = 'empty';
      e.textContent = t('nv.noPresets');
      box.appendChild(e);
      return;
    }
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.name;
      b.title = p.name;
      b.disabled = !ok;
      b.setAttribute('aria-pressed', p.id === nvLastPresetId ? 'true' : 'false');
      b.addEventListener('click', (e) => { if (act(e)) applyPreset(p.id); });
      box.appendChild(b);
    }
  }

  function applyPreset(id) {
    const p = settings.nv.presets.find((x) => x.id === id);
    if (!p || !nv.state) return;
    const patch = L.nvPresetPatch(p, nv.state);
    if (!patch) {
      const h = nv.state.hdr;
      message('nv-msg', L.nvErrorText(h.supported && h.error ? { code: 'hdr-error', errorCode: h.error } : { code: 'unsupported' }, lang), true);
      return;
    }
    message('nv-msg', t('nv.applying', { name: p.name }));
    // 先显示预设的值；借用期间开关以 background 回的为准
    const view = L.nvMergePatch(patch, null);
    if (view.hdr && leased()) delete view.hdr.enabled;
    nv.local(view);
    nv.exclusive(() => nvOp({ op: 'apply-preset', id: p.id })).then((res) => {
      if (!res || res.ok !== true) {
        message('nv-msg', t('nv.applyFailed', { err: L.nvErrorText(res && res.error, lang) }), true);
        return;
      }
      message('nv-msg', t('nv.applied', { name: p.name }) + (res.hdrSkipped ? t('nv.partial') : ''));
    });
  }

  // 用户亲手拨全局 HDR：经 background，借用按 suppress 处理
  function setEnabled(on) {
    if (!nv.state) return;
    const patch = { hdr: { enabled: on } };
    nv.local(patch);
    nv.exclusive(() => nvOp({ op: 'set', patch: patch, mode: 'suppress' })).then((res) => {
      if (!res || res.ok !== true) nv.failed(res);
    });
  }

  // 「还原到打开时」：和打开时的快照比（两边都用借用前的开关），只写有差异的字段
  function revertPatch() {
    if (!openSnap || !nv.state) return null;
    return L.nvRevertPatch(L.nvUnleased(nv.state, hdrOnlyStatus) || nv.state, openSnap);
  }

  function revert() {
    const patch = revertPatch();
    if (!patch) {
      message('nv-msg', t('panel.nothingToRevert'));
      return;
    }
    const view = L.nvMergePatch(patch, null);
    if (view.hdr && leased()) delete view.hdr.enabled;
    nv.local(view);
    nv.exclusive(() => nvOp({ op: 'set', patch: patch, mode: 'yield' })).then((res) => {
      if (!res || res.ok !== true) message('nv-msg', L.nvErrorText(res && res.error, lang), true);
      else message('nv-msg', t('panel.reverted'));
    });
  }

  // 拖回起点时 Chrome 不发 change，松手时照样提交一次
  function endDrag() {
    if (dragHold) {
      dragHold = false;
      if (!peekOn) post({ type: 'hold', on: false });
    }
    const d = nv.dragEnd();
    if (!d) return;
    const el = $(d.id);
    if (d.moved && el.value === d.start) nv.write({ hdr: { [el.dataset.field]: Number(el.value) } }, true);
  }

  function bindNv() {
    for (const f of NV_SLIDERS) {
      const el = sliders[f].input;
      el.addEventListener('pointerdown', (e) => {
        if (!act(e)) return;
        nv.dragBegin(el.id, el.value);
        dragHold = true;
        post({ type: 'hold', on: true }); // 拖出面板也不按「离开」收起
      });
      el.addEventListener('input', (e) => {
        if (!act(e)) return;
        nv.dragMove(el.id);
        U.sliderFill(el);
        U.setText(sliders[f].out, f === 'contrast' || f === 'saturation' ? U.signed(Number(el.value)) : el.value);
        nv.write({ hdr: { [f]: Number(el.value) } }, false);
      });
      el.addEventListener('change', (e) => {
        if (!act(e)) return;
        nv.dragClear(el.id);
        nv.write({ hdr: { [f]: Number(el.value) } }, true);
      });
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    $('nv-hdr').addEventListener('change', (e) => {
      if (act(e)) setEnabled(e.target.checked);
      else renderNv();
    });
    for (const r of radios('nv-vsr')) {
      r.addEventListener('change', (e) => {
        if (act(e) && r.checked) nv.write({ vsr: { mode: Number(r.value) } }, true);
      });
    }
    for (const r of radios('nv-priority')) {
      r.addEventListener('change', (e) => {
        if (act(e) && r.checked) nv.write({ vsr: { priority: Number(r.value) } }, true);
      });
    }
    $('nv-revert').addEventListener('click', (e) => { if (act(e)) revert(); });
  }

  // ---------- 配置档（background 的 profile 服务；没有回复时隐藏这个页签） ----------

  function profileMsg(op, extra) {
    return call(() => chrome.runtime.sendMessage(Object.assign({ type: 'profile', op: op }, extra))).then(
      (r) => (r && typeof r === 'object' ? r : null), () => null);
  }

  function profileError(r) {
    const key = 'profile.err.' + (r && typeof r.code === 'string' ? r.code : '');
    return Object.prototype.hasOwnProperty.call(I.DICT.zh, key) ? t(key) : L.nvErrorText(r && r.error, lang);
  }

  async function loadProfiles() {
    const r = await profileMsg('list');
    const src = r && r.ok === true ? (r.profiles && typeof r.profiles === 'object' ? r.profiles : r) : null;
    const list = src && Array.isArray(src.list) ? src.list : null;
    profilesOn = !!list;
    profiles = list ? {
      list: list.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string').slice(0, PROFILES_MAX),
      activeId: typeof src.activeId === 'string' ? src.activeId : null
    } : null;
    $('tab-profiles').hidden = !profilesOn;
    if (!profilesOn && tab === 'profiles') selectTab('video', false);
    renderProfiles();
  }

  function renderProfiles() {
    const box = $('pf-list');
    const list = profiles ? profiles.list : [];
    const sig = JSON.stringify([list.map((p) => [p.id, p.name]), profiles && profiles.activeId, lang]);
    if (sig === profileSig) return;
    profileSig = sig;
    box.textContent = '';
    if (!list.length) {
      const e = document.createElement('span');
      e.className = 'empty';
      e.textContent = t('profile.none');
      box.appendChild(e);
    }
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.name;
      b.title = p.name;
      b.setAttribute('aria-pressed', profiles.activeId === p.id ? 'true' : 'false');
      b.addEventListener('click', (e) => { if (act(e)) applyProfile(p); });
      box.appendChild(b);
    }
  }

  async function applyProfile(p) {
    const r = await profileMsg('apply', { id: p.id });
    if (!r || r.ok !== true) message('pf-msg', profileError(r), true);
    else message('pf-msg', t('profile.applied', { name: p.name }));
    loadProfiles();
  }

  function showProfileForm(show) {
    $('pf-form').hidden = !show;
    $('pf-save').setAttribute('aria-expanded', String(show));
    if (!show) return;
    const input = $('pf-name');
    input.value = t('profile.defaultName', { n: (profiles ? profiles.list.length : 0) + 1 });
    input.focus();
    input.select();
  }

  async function saveProfile() {
    const name = $('pf-name').value.trim();
    if (!name) {
      message('pf-msg', t('profile.err.name'), true);
      return;
    }
    const r = await profileMsg('save', { name: name });
    if (!r || r.ok !== true) {
      message('pf-msg', profileError(r), true);
      return;
    }
    showProfileForm(false);
    message('pf-msg', t(r.overwrote ? 'profile.updated' : 'profile.saved', { name: name }));
    loadProfiles();
  }

  function bindProfiles() {
    $('pf-save').addEventListener('click', (e) => { if (act(e)) showProfileForm($('pf-form').hidden); });
    $('pf-ok').addEventListener('click', (e) => { if (act(e)) saveProfile(); });
    $('pf-name').addEventListener('keydown', (e) => {
      if (e.isComposing || !act(e)) return; // 输入法选词时的回车不算
      if (e.key === 'Enter') {
        e.preventDefault();
        saveProfile();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        showProfileForm(false);
        $('pf-save').focus();
      }
    });
  }

  // ---------- 面板外框：页签、关闭、键盘、指针 ----------

  // 打不开弹窗时（Chrome 127 之前普通安装的扩展不能调 openPopup）在新标签页里打开，带上本标签页，弹窗按它显示
  function openFullSettings() {
    const url = chrome.runtime.getURL('popup.html') + (ownTab !== null ? '?tab=' + ownTab : '');
    const fallback = () => call(() => chrome.tabs.create({ url: url })).catch(noop);
    let p = null;
    try { p = chrome.action && typeof chrome.action.openPopup === 'function' ? chrome.action.openPopup() : null; } catch (e) { p = null; }
    if (p && typeof p.then === 'function') p.catch(fallback);
    else fallback();
    post({ type: 'close', reason: 'done' });
  }

  function focusables() {
    return Array.from(document.querySelectorAll('button, input, a[href]')).filter((el) =>
      !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[hidden]') &&
      !(el.type === 'radio' && !el.checked && document.querySelector('input[name="' + el.name + '"]:checked')));
  }

  function bindFrame() {
    for (const n of TABS) {
      $('tab-' + n).addEventListener('click', (e) => {
        if (!act(e)) return;
        selectTab(n, false);
        call(() => chrome.storage.local.set({ [TAB_KEY]: n })).catch(noop);
      });
    }
    // 页签之间用左右方向键切换
    document.querySelector('.tabs').addEventListener('keydown', (e) => {
      if (!e.isTrusted || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      const shown = TABS.filter((n) => !$('tab-' + n).hidden);
      const i = shown.indexOf(tab);
      const next = shown[(i + (e.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length];
      e.preventDefault();
      selectTab(next, true);
      call(() => chrome.storage.local.set({ [TAB_KEY]: next })).catch(noop);
    });
    $('btn-close').addEventListener('click', (e) => { if (e.isTrusted) post({ type: 'close', reason: 'done' }); });
    $('btn-full').addEventListener('click', (e) => { if (act(e)) openFullSettings(); });

    // Esc 收起；Tab 从最后一个控件往后（或 Shift+Tab 从第一个往前）移出面板时收起，焦点回到按钮
    document.addEventListener('keydown', (e) => {
      if (!e.isTrusted || !open) return;
      if (!pinned) {
        pinned = true;
        post({ type: 'pin' });
      }
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        post({ type: 'close', reason: 'esc' });
      } else if (e.key === 'Tab') {
        const list = focusables();
        const a = document.activeElement;
        if (list.length && ((e.shiftKey && a === list[0]) || (!e.shiftKey && a === list[list.length - 1]))) {
          e.preventDefault();
          post({ type: 'close', reason: 'tab' });
        }
      }
    });
    // 面板里有了第一次操作：不再随指针离开收起
    document.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || !open || pinned) return;
      pinned = true;
      post({ type: 'pin' });
    }, true);
    // 指针在面板上：告诉内容脚本（唤醒网站的控制栏、取消离开计时），每 500 ms 最多一次
    document.addEventListener('pointermove', (e) => {
      if (!e.isTrusted || !open) return;
      const now = Date.now();
      if (now - activityAt < ACTIVITY_MS) return;
      activityAt = now;
      post({ type: 'activity', x: Math.round(e.clientX), y: Math.round(e.clientY) });
    });
    document.documentElement.addEventListener('mouseleave', (e) => {
      if (e.isTrusted && open) {
        activityAt = 0;
        post({ type: 'hover', on: false });
      }
    });
    document.documentElement.addEventListener('mouseenter', (e) => {
      if (e.isTrusted && open) post({ type: 'hover', on: true });
    });
    window.addEventListener('pagehide', () => nv.flushNow());
  }

  function bindStorage() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[HDR_ONLY_KEY]) {
          hdrOnlyStatus = changes[HDR_ONLY_KEY].newValue || null;
          renderNv();
        }
        if (changes[NV_LAST_PRESET_KEY]) {
          nvLastPresetId = changes[NV_LAST_PRESET_KEY].newValue || null;
          renderPresets();
        }
        if (changes.settings) {
          stored = L.mergeSettings(changes.settings.newValue);
          rebase();
          renderVideo();
          renderNv();
        }
        if (changes[PROFILES_KEY] && ready && profilesOn) loadProfiles();
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- 启动 ----------

  async function init() {
    if (!embeddedInPlayer()) return;
    try {
      const r = await chrome.storage.local.get(['settings', HDR_ONLY_KEY, NV_LAST_PRESET_KEY, TAB_KEY]);
      stored = L.mergeSettings(r && r.settings);
      settings = stored;
      hdrOnlyStatus = (r && r[HDR_ONLY_KEY]) || null;
      nvLastPresetId = (r && r[NV_LAST_PRESET_KEY]) || null;
      if (r && TABS.indexOf(r[TAB_KEY]) >= 0) tab = r[TAB_KEY];
    } catch (e) { /* 用默认值 */ }
    applyLang();
    buildSliders();
    bindVideo();
    bindNv();
    bindProfiles();
    bindFrame();
    bindStorage();
    await connect();
  }

  init().catch(noop);
})();
