/* RTX HDR 开关 —— 弹窗 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 1000;
  const IS_EDGE = /\bEdg\//.test(navigator.userAgent);
  const COMMAND_NAMES = {
    'toggle-hdr': '切换当前视频的 RTX HDR',
    'toggle-auto': '开/关 自动检测白底视频',
    'forget-video': '清除当前视频的记忆',
    'nv-next-preset': '切换到下一个 NVIDIA 预设',
    _execute_action: '打开此弹窗'
  };
  const NV_POLL_MS = 2000;
  const NV_THROTTLE_MS = 200; // 和 NVIDIA App 拖动滑块时一样
  // 下拉框：键盘在收起的下拉框上按方向键时每一步都触发 change，停这么久没再变才写入 / 保存
  const NV_DEBOUNCE_MS = 500;
  const NV_CONFIRM_MS = 4000; // 「删除」按第一次后等确认的时间
  const NV_TIMEOUT_MS = 8000;
  const NV_LAST_PRESET_KEY = 'nvLastPresetId';
  const NV_HOTKEY_ERROR_KEY = 'nvHotkeyError'; // 快捷键切换预设失败、页面上显示不了时 background 留下的提示
  const NV_HOTKEY_ERROR_MAX_AGE = 10 * 60 * 1000;
  const NV_SLIDERS = ['peak', 'middleGrey', 'contrast', 'saturation'];
  const NV_LEVEL_TEXT = ['', '非常低', '低', '中', '高'];
  // 这些错误说明本地组件或 NVIDIA App 用不了，不再轮询
  const NV_FATAL = new Set(['host-missing', 'host-forbidden', 'no-dll', 'init', 'protocol']);

  let tabId = null;
  let tabHost = '';
  let usable = false;
  let isFile = false;
  let frameId = 0;
  let current = null;
  let settings = L.mergeSettings(null);
  let busy = false;
  let epoch = 0; // 每次用户操作 +1，丢弃操作前发出的刷新结果

  let nvMode = 'connecting'; // connecting | missing | error | ready
  let nvError = null;
  let nvState = null; // 最近读到的 State，叠加了还没确认的乐观修改
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

  // ---------- 当前视频 ----------

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

  function showMessage(text, warn) {
    $('video-panel').hidden = true;
    const m = setText('video-message', text);
    m.hidden = false;
    m.classList.toggle('warn', !!warn);
  }

  function renderState(st) {
    current = st;
    if (!usable) return showMessage('此页面无法使用', false);
    if (!st) {
      return showMessage(isFile
        ? '无法连接到此页面。本地文件需要在扩展详情页开启「允许访问文件网址」，然后刷新页面。'
        : '还没有连接到此页面，请刷新页面后重试。', false);
    }
    if (!st.hasVideo) {
      return showMessage(st.offscreen ? '视频不在可见区域内'
        : st.videoCount > 0 ? '此页面没有检测到正在显示的视频' : '此页面没有检测到视频', false);
    }
    if (st.drm) return showMessage('受版权保护的视频，无法控制', true);

    $('video-message').hidden = true;
    $('video-panel').hidden = false;

    const pending = st.state !== 'on' && st.state !== 'off';
    const on = st.state === 'on';
    setText('state-big', pending ? '读取中…' : on ? 'HDR 开' : 'HDR 关');
    setClass('state-big', 'big ' + (pending ? '' : on ? 'on' : 'off'));
    setClass('state-dot', 'dot' + (on ? ' on' : ''));
    const reason = [];
    if (st.reasonText) reason.push('原因：' + st.reasonText);
    const nvNote = on ? nvGlobalHdrNote() : '';
    if (nvNote) reason.push(nvNote);
    setText('state-reason', reason.join('；'));

    const note = st.pip ? '画中画窗口里可能无法关闭 HDR（浏览器限制），回到页面内播放后生效。' : '';
    setText('video-note', note).hidden = !note;

    const key = setText('video-key', st.key || '');
    if (key.title !== (st.key || '')) key.title = st.key || '';

    let luma = L.formatLuma(st.mean, st.white);
    if (!luma && st.auto && st.auto.mode !== 'off') {
      if (st.autoUnknown === 'tainted') luma = '自动检测：跨域视频，无法读取画面亮度';
      else if (st.autoUnknown === 'error') luma = '自动检测：无法读取画面亮度';
    }
    setText('video-luma', luma);

    $('btn-toggle').disabled = pending;
    const forget = $('btn-forget');
    forget.disabled = !(st.manual || st.saved);
    forget.title = forget.disabled ? '此视频没有手动切换或记忆' : '';
  }

  // 「HDR 开」只表示扩展没有阻止；NVIDIA 全局 HDR 关着或不可用时在原因行说明，免得和下面的 NVIDIA 面板矛盾
  function nvGlobalHdrNote() {
    if (nvMode !== 'ready' || !nvState) return '';
    const h = nvState.hdr;
    if (!h.supported) return L.nvErrorText({ code: 'unsupported', field: 'hdr' });
    if (h.error) return 'NVIDIA 全局 HDR 不可用：' + L.nvHdrErrorText(h.error);
    return h.enabled ? '' : 'NVIDIA 全局 HDR 已关闭';
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
    setValue('site-rule', (tabHost && s.sites[tabHost]) || '');
    setValue('auto-mode', s.autoDetect);
    setValue('sensitivity', s.sensitivity);
    $('sensitivity').disabled = s.autoDetect === 'off';
    setChecked('night-enabled', s.night.enabled);
    setValue('night-start', s.night.start);
    setValue('night-end', s.night.end);
    setValue('eye-minutes', String(s.eye.minutes));
    setChecked('eye-autooff', s.eye.autoOff);
    $('eye-autooff').disabled = s.eye.minutes === 0;
    for (const r of document.querySelectorAll('input[name="default-state"]')) r.checked = r.value === s.defaultState;
    setChecked('remember-manual', s.rememberManual);
    setChecked('show-osd', s.osd);
    renderNvPresets();
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

  function bind() {
    onChange('site-rule', (el) => save((s) => {
      if (!tabHost) return;
      if (el.value === 'on' || el.value === 'off') s.sites[tabHost] = el.value;
      else delete s.sites[tabHost];
    }));
    onChange('auto-mode', (el) => save((s) => {
      s.autoDetect = el.value;
      if (el.value !== 'off') s.autoLastMode = el.value;
    }));
    onChange('sensitivity', (el) => save((s) => { s.sensitivity = el.value; }));
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
    for (const r of document.querySelectorAll('input[name="default-state"]')) {
      r.addEventListener('change', () => { if (r.checked) save((s) => { s.defaultState = r.value; }); });
    }
    onChange('remember-manual', (el) => save((s) => { s.rememberManual = el.checked; }));
    onChange('show-osd', (el) => save((s) => { s.osd = el.checked; }));
    // 停一会儿再保存：background 会马上套用当前时段的预设，键盘浏览途经的预设不应写到显卡上
    onChange('nv-night-preset', (el) => save((s) => { s.nv.nightPresetId = el.value || null; }, NV_DEBOUNCE_MS));
    onChange('nv-day-preset', (el) => save((s) => { s.nv.dayPresetId = el.value || null; }, NV_DEBOUNCE_MS));

    $('btn-toggle').addEventListener('click', () => {
      if (current && current.hasVideo) sendAction(current.state === 'off' ? 'on' : 'off');
    });
    $('btn-forget').addEventListener('click', () => sendAction('clear'));
    $('btn-shortcuts').addEventListener('click', () => {
      const url = IS_EDGE ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
      call(() => chrome.tabs.create({ url: url })).catch(noop);
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[NV_LAST_PRESET_KEY]) nvLastPresetId = changes[NV_LAST_PRESET_KEY].newValue || null;
        if (changes.settings) {
          settings = L.mergeSettings(changes.settings.newValue);
          renderSettings();
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
      let i = res.id == null ? 0 : link.waiters.findIndex((w) => w.id === res.id);
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
      nvMessage(L.nvErrorText(err), true);
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
    if (nvMode === 'missing' || (nvError && NV_FATAL.has(nvError.code))) return;
    await nvPoll();
    if (nvMode === 'missing' || (nvError && NV_FATAL.has(nvError.code))) return;
    nvPollTimer = setInterval(nvPoll, NV_POLL_MS);
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
      nvMessage(L.nvErrorText(v.error), true);
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
    // 没装本地组件时说明也写在这个 aria-live 区域里（安装链接在它下面），读屏软件会播报状态变化
    const m = $('nv-message');
    m.hidden = ready;
    if (!m.hidden) {
      setText('nv-message', nvMode === 'connecting' ? '正在连接本地组件…'
        : L.nvErrorText(nvMode === 'missing' ? { code: 'host-missing' } : nvError));
      m.classList.toggle('warn', nvMode === 'error' || nvMode === 'missing');
    }
    renderNvPresets();
    if (current) renderState(current); // 视频卡片原因行里的「NVIDIA 全局 HDR 已关闭」
    if (!ready) return;

    const h = nvState.hdr;
    const hdrOk = h.supported && !h.error;
    const reason = !h.supported ? L.nvErrorText({ code: 'unsupported', field: 'hdr' }) : L.nvHdrErrorText(h.error);
    setText('nv-hdr-reason', reason).hidden = !reason;
    const sw = $('nv-hdr');
    sw.checked = h.enabled;
    sw.disabled = !hdrOk;
    setText('nv-hdr-state', '状态：' + (h.active ? '已激活' : '未激活'));
    setClass('nv-hdr-dot', 'dot' + (h.active ? ' on' : ''));

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
      if (f !== 'peak') setText('nv-' + f + '-out', String(h[f]));
    }
    const num = $('nv-peak-num');
    num.disabled = !hdrOk;
    if (document.activeElement !== num) setNum(num, h.peak);
    $('nv-peak-hint').hidden = !(h.peak > 1000);

    const v = nvState.vsr;
    setText('nv-vsr-reason', v.supported ? '' : L.nvErrorText({ code: 'unsupported', field: 'vsr' })).hidden = v.supported;
    const sel = $('nv-vsr');
    sel.disabled = !v.supported;
    setNum(sel, v.mode);
    const on = v.supported && v.level > 0;
    setText('nv-vsr-state', '状态：' + (on ? '已激活（' + (NV_LEVEL_TEXT[v.level] || v.level) + '）' : '未激活'));
    setClass('nv-vsr-dot', 'dot' + (on ? ' on' : ''));
    // GPU 优先级只在自动模式下有意义；驱动没有 0x32F / 0x330 时（priority / indicator 为 null）不显示
    $('nv-priority-row').hidden = !(v.supported && v.mode === 5 && v.priority !== null);
    for (const r of document.querySelectorAll('input[name="nv-priority"]')) r.checked = Number(r.value) === v.priority;
    $('nv-indicator-row').hidden = nvState.indicator === null;
    $('nv-indicator').checked = nvState.indicator === true;
  }

  function renderNvPresets() {
    const presets = settings.nv.presets;
    const ids = presets.map((p) => p.id);
    if (ids.indexOf(nvSelectedId) < 0) nvSelectedId = ids.indexOf(nvLastPresetId) >= 0 ? nvLastPresetId : ids[0] || null;
    const items = presets.length ? presets.map((p) => [p.id, p.name]) : [['', '还没有预设', true]];
    const sel = $('nv-preset');
    fillSelect(sel, items, nvSelectedId || '');
    sel.disabled = !presets.length;
    const ready = nvMode === 'ready' && !!nvState;
    $('nv-apply').disabled = !ready || !presets.length;
    $('nv-delete').disabled = !presets.length;
    $('nv-save').disabled = !ready;

    if (nvDeleteArmed && nvDeleteArmed.id !== nvSelectedId) nvDisarmDelete();

    const opts = [['', '不切换']].concat(presets.map((p) => [p.id, p.name]));
    for (const id of ['nv-night-preset', 'nv-day-preset']) {
      fillSelect($(id), opts, settings.nv[id === 'nv-night-preset' ? 'nightPresetId' : 'dayPresetId'] || '');
      $(id).disabled = !presets.length; // 只有「不切换」可选
    }
    const missing = nvMode === 'missing';
    setText('nv-schedule-hint', !presets.length
      ? (missing ? '需要先安装本地组件，并在上方 NVIDIA 视频设置里保存预设' : '先在上方 NVIDIA 视频设置里保存预设')
      : '按上面的时段自动切换，与夜间护眼开关无关' + (missing ? '（需要先安装本地组件）' : ''));
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
      input.value = L.nvDefaultPresetName(settings.nv.presets);
      input.focus();
      input.select();
    }
  }

  // 同名的预设先提示，再保存一次才覆盖（保留 id，夜间 / 其余时间的选择不受影响）
  function nvSavePreset() {
    if (!nvState) return;
    const probe = L.nvPresetFromState(nvState, $('nv-preset-name').value, 'probe');
    if (!probe) {
      nvMessage('请输入预设名称', true);
      $('nv-preset-name').focus();
      return;
    }
    const same = settings.nv.presets.find((p) => p.name === probe.name);
    if (!same && settings.nv.presets.length >= L.NV_MAX_PRESETS) {
      nvMessage('最多 ' + L.NV_MAX_PRESETS + ' 个预设，请先删除不用的', true);
      return;
    }
    if (same && nvOverwriteName !== probe.name) {
      nvOverwriteName = probe.name;
      nvMessage('将覆盖预设「' + probe.name + '」：再按一次回车或「保存」确认', true);
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
    nvMessage((same ? '已更新预设：' : '已保存预设：') + preset.name);
  }

  function nvApplyPreset() {
    const p = settings.nv.presets.find((x) => x.id === nvSelectedId);
    if (!p || !nvState) return;
    const patch = L.nvPresetPatch(p, nvState);
    if (!patch) {
      const h = nvState.hdr;
      nvMessage(L.nvErrorText(h.supported && h.error ? { code: 'hdr-error', errorCode: h.error } : { code: 'unsupported' }), true);
      return;
    }
    const partial = patch.hdr ? '' : '（HDR 当前不可用，只套用了超分辨率）';
    nvMessage('正在套用预设：' + p.name + '…', false, true);
    // 本地组件确认写入后才提示成功、记下「上次套用的预设」（快捷键从它的下一个开始轮换）
    nvWrite(patch, true, (res) => {
      if (!res || res.ok !== true) {
        nvMessage('套用预设失败：' + L.nvErrorText(res && res.error), true);
        return;
      }
      nvLastPresetId = p.id;
      call(() => chrome.storage.local.set({ [NV_LAST_PRESET_KEY]: p.id })).catch(noop);
      nvMessage('已套用预设：' + p.name + partial);
    });
  }

  function nvDisarmDelete() {
    if (!nvDeleteArmed) return;
    clearTimeout(nvDeleteArmed.timer);
    nvDeleteArmed = null;
    setText('nv-delete', '删除');
  }

  // 删除不能撤销：第一次只把按钮变成「确认删除？」，4 秒内再按一次才删
  function nvDeletePreset() {
    const presets = settings.nv.presets;
    const i = presets.findIndex((x) => x.id === nvSelectedId);
    if (i < 0) return nvDisarmDelete();
    const p = presets[i];
    const uses = [];
    if (settings.nv.nightPresetId === p.id) uses.push('夜间');
    if (settings.nv.dayPresetId === p.id) uses.push('其余时间');
    const cancels = uses.length ? '，' + uses.join('和') + '的自动切换也会取消' : '';
    if (!nvDeleteArmed || nvDeleteArmed.id !== p.id) {
      nvDisarmDelete();
      const ask = '再按一次删除预设「' + p.name + '」' + cancels;
      nvDeleteArmed = {
        id: p.id,
        timer: setTimeout(() => {
          if ($('nv-msg').textContent === ask) nvMessage('');
          nvDisarmDelete();
        }, NV_CONFIRM_MS)
      };
      setText('nv-delete', '确认删除？');
      nvMessage(ask, true);
      return;
    }
    nvDisarmDelete();
    const next = presets[i + 1] || presets[i - 1];
    nvSelectedId = next ? next.id : null;
    // mergeSettings 会把指向它的夜间 / 其余时间选择变回「不切换」
    save((s) => { s.nv.presets = s.nv.presets.filter((x) => x.id !== p.id); });
    nvMessage('已删除预设：' + p.name + (uses.length ? '，已同时取消' + uses.join('和') + '的自动切换' : ''), !!uses.length);
  }

  // 拖回起点时 Chrome 不发 change，松手时照样提交一次
  function nvEndDrag() {
    const d = nvDrag;
    if (!d) return;
    nvDrag = null;
    const el = $(d.id);
    if (d.moved && el.value === d.start) nvWrite({ hdr: { [el.dataset.field]: Number(el.value) } }, true);
  }

  function nvBind() {
    for (const f of NV_SLIDERS) {
      const el = $('nv-' + f);
      el.dataset.field = f;
      el.addEventListener('pointerdown', () => { nvDrag = { id: el.id, start: el.value, moved: false }; });
      el.addEventListener('input', () => {
        if (nvDrag && nvDrag.id === el.id) nvDrag.moved = true;
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
    onChange('nv-hdr', (el) => nvWrite({ hdr: { enabled: el.checked } }, true));
    onChange('nv-vsr', (el) => nvWrite({ vsr: { mode: Number(el.value) } }, 'soon'));
    for (const r of document.querySelectorAll('input[name="nv-priority"]')) {
      r.addEventListener('change', () => { if (r.checked) nvWrite({ vsr: { priority: Number(r.value) } }, true); });
    }
    onChange('nv-indicator', (el) => nvWrite({ indicator: el.checked }, true));

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

  async function renderShortcuts() {
    const ul = $('shortcuts');
    let cmds = [];
    try { cmds = await chrome.commands.getAll(); } catch (e) { cmds = []; }
    ul.textContent = '';
    for (const c of cmds || []) {
      if (c.name === '_execute_action' && !c.shortcut) continue;
      const li = document.createElement('li');
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = c.description || COMMAND_NAMES[c.name] || c.name;
      li.appendChild(desc);
      if (c.shortcut) {
        const k = document.createElement('kbd');
        k.textContent = c.shortcut;
        li.appendChild(k);
      } else {
        const u = document.createElement('span');
        u.className = 'unset';
        u.textContent = '未设置';
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
    $('site-host').textContent = tabHost ? '（' + tabHost + '）' : '';
    $('site-rule').disabled = !tabHost;

    let hotkeyError = null;
    try {
      const r = await chrome.storage.local.get(['settings', NV_LAST_PRESET_KEY, NV_HOTKEY_ERROR_KEY]);
      settings = L.mergeSettings(r && r.settings);
      nvLastPresetId = (r && r[NV_LAST_PRESET_KEY]) || null;
      hotkeyError = r && r[NV_HOTKEY_ERROR_KEY];
    } catch (e) { /* 用默认值 */ }
    renderSettings();
    bind();
    nvBind();
    // 快捷键切换预设失败时当前页面显示不了提示（chrome:// 页面等）：在这里补一次，只显示一次
    if (hotkeyError) {
      call(() => chrome.storage.local.remove(NV_HOTKEY_ERROR_KEY)).catch(noop);
      const age = Date.now() - (+hotkeyError.at || 0);
      if (typeof hotkeyError.text === 'string' && age >= 0 && age < NV_HOTKEY_ERROR_MAX_AGE) nvMessage(hotkeyError.text.slice(0, 200), true);
    }
    renderShortcuts();
    nvStart().catch(() => nvFailed(null)); // NVIDIA 设置与当前页面无关，chrome:// 页面也能用

    if (!usable) {
      renderState(null);
      return;
    }
    await refresh();
    setInterval(refresh, REFRESH_MS);
  }

  init().catch(() => showMessage('此页面无法使用', false));
})();
