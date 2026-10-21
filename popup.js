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
    _execute_action: '打开此弹窗'
  };

  let tabId = null;
  let tabHost = '';
  let usable = false;
  let isFile = false;
  let frameId = 0;
  let current = null;
  let settings = L.mergeSettings(null);
  let busy = false;
  let epoch = 0; // 每次用户操作 +1，丢弃操作前发出的刷新结果

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
    setText('state-reason', st.reasonText ? '原因：' + st.reasonText : '');

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
  }

  function save(mutate) {
    const next = L.mergeSettings(settings);
    mutate(next);
    settings = L.mergeSettings(next);
    renderSettings();
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
        if (area === 'local' && changes.settings) {
          settings = L.mergeSettings(changes.settings.newValue);
          renderSettings();
        }
      });
    } catch (e) { /* ignore */ }
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

    try {
      const r = await chrome.storage.local.get('settings');
      settings = L.mergeSettings(r && r.settings);
    } catch (e) { /* 用默认值 */ }
    renderSettings();
    bind();
    renderShortcuts();

    if (!usable) {
      renderState(null);
      return;
    }
    await refresh();
    setInterval(refresh, REFRESH_MS);
  }

  init().catch(() => showMessage('此页面无法使用', false));
})();
