/*
 * RTX HDR 开关 —— service worker（经典脚本）。
 * 记录每个 tab 各 frame 的报告，选出最佳 frame 设置角标、转发快捷键和弹窗请求；
 * 汇总各标签页上报的观看时间做「连续观看提醒」；
 * 通过本地组件（native messaging）读写 NVIDIA 全局设置：定时切换预设、「下一个预设」快捷键、撤销、弹窗兜底；
 * NVIDIA 写入统一经 nvWrite（互斥 + 修改记录）。settings 只由这里写（settingsTxn），其他页面提交补丁。
 */
'use strict';

importScripts('i18n.js', 'lib.js');
try { importScripts('icon-draw.js'); } catch (e) { /* 没有图标绘制脚本时沿用 manifest 里的静态图标 */ }
const L = self.RtxHdrLib;
const I18N = self.RtxHdrI18n;

const STALE_MS = 10000;
// 子 frame 有视频时每 3 秒一次心跳；超过这么久没消息就当它已经不在了（iframe 被移除、页面已离开）
const CHILD_DEAD_MS = 10000;
// 更久没消息的子 frame 报告直接删掉（隐藏标签页里的 iframe 回到前台时会马上重新上报）
const CHILD_PURGE_MS = 60000;
const PERSIST_DELAY_MS = 500;
const MAX_FRAMES_PER_TAB = 32;
const SESSION_PREFIX = 'tab:';
const EYE_SESSION_KEY = 'eye';
const MAX_EYE_INC_MS = 60000;
const NV_TIMEOUT_MS = 10000;
const NV_ALARM = 'nv-schedule';
const NV_PHASE_KEY = 'nvLastPhase';
const NV_LAST_PRESET_KEY = 'nvLastPresetId';
const NV_HOTKEY_ERROR_KEY = 'nvHotkeyError';
// 定时套用预设失败时下一分钟再试；这些错误重试也没用，本时段放弃
const NV_GIVE_UP = new Set(['no-dll', 'host-forbidden', 'bad-request', 'range']);
// 写入前就被拒、确定什么都没写的错误；写入阶段的其它错误（api、timeout、host-exit 等）可能已经写了一部分
const NV_NOT_WRITTEN = new Set(['host-missing', 'host-forbidden', 'no-dll', 'init', 'bad-request', 'range', 'unsupported', 'hdr-error']);
// 写入阶段出错时本时段最多试这么多次，免得每分钟把用户的手动修改覆盖回去
const NV_MAX_WRITE_FAILS = 3;
// 跟随 SDR 亮度：弹窗关着时每 30 秒看一次 Windows 的 SDR 白电平
const NV_FOLLOW_ALARM = 'nv-follow';
const SDR_LAST_KEY = 'nvLastSdrWhite';
// 「只关 HDR」模式的状态，内容脚本和弹窗读它：{active, leased, error?}
const HDR_ONLY_KEY = 'hdrOnlyStatus';
const HO_DEBOUNCE_MS = 150;
const HO_RETRY_MS = 60000; // 借全局开关失败后隔这么久再试
const MG_STEP = 5;
// 跟随 SDR：同一白电平连续这么多次调不成就不再重试
const NV_FOLLOW_MAX_FAILS = 3;
// 共用的本地组件端口：没有借用、也没有请求时空闲这么久就断开；连续这么多次没回复就退出时改用 sendNativeMessage，过一段时间再试
const HOST_IDLE_MS = 15000;
const HOST_MAX_FAILS = 3;
const HOST_RETRY_MS = 5 * 60000;
// NVIDIA 修改记录（storage.session）
const NV_LOG_KEY = 'nvLog';
const NV_DRAG_MS = 10000;
// 用户亲手发起的写入来源；其余（schedule、follow、site）是自动来源：读不到状态时不记日志，跟随 SDR 开着时不写中间灰
const NV_USER_SOURCES = new Set(['popup', 'panel', 'hotkey', 'profile', 'undo']);
// 能用扩展页面消息的页面（panel.html 是嵌在播放器网页里的扩展 iframe）
const EXT_PAGES = ['/popup.html', '/options.html', '/diag.html', '/panel.html'];
const CONTENT_PATCH_PER_SEC = 10;
// 面板能用的 nv-op 和 nv（不开放 display、follow-check）
const PANEL_NV_OPS = new Set(['set', 'apply-preset', 'undo']);
const PANEL_NV_CMDS = new Set(['hello', 'get']);
// 角标：HDR 用主题色，SDR 黑底白字；DRM 视频扩展管不了，不显示 HDR/SDR，免得和实际情况相反
const BADGE_SDR = { text: 'SDR', color: '#0A0A0A', textColor: '#FAFAFA' };
const BADGE_DRM = { text: 'DRM', color: '#6B6B6B', textColor: '#FFFFFF' };

const tabState = new Map(); // tabId → {frames: {frameId: report}, topDoc}
const tabLoads = new Map(); // tabId → 正在从 storage.session 恢复的 Promise
const badgeSig = new Map();
const persistTimers = new Map();
const recheckTimers = new Map();
// tabId → Set(frameId)：内容脚本和面板握手成功后登记的面板 iframe。没登记的 panel.html（网页自己嵌的副本）一律不认
const panelFrames = new Map();

function noop() {}

// 把同步异常也变成 rejected Promise，调用方统一 .catch
function call(fn) {
  try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
}

function validTabId(id) {
  return Number.isInteger(id) && id >= 0;
}

// ---------- 报告存储（内存 + storage.session，service worker 会被回收） ----------

function sanitizeReport(msg, ts, doc) {
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
  const str = (x) => (typeof x === 'string' ? x.slice(0, 2048) : null);
  return {
    hasVideo: !!msg.hasVideo,
    videoCount: num(msg.videoCount) || 0,
    offscreen: !!msg.offscreen,
    area: num(msg.area) || 0,
    playing: !!msg.playing,
    state: msg.state === 'on' || msg.state === 'off' ? msg.state : null,
    reason: str(msg.reason),
    key: str(msg.key),
    hostname: str(msg.hostname),
    drm: !!msg.drm,
    pip: !!msg.pip,
    contested: !!msg.contested,
    mean: num(msg.mean),
    white: num(msg.white),
    autoUnknown: str(msg.autoUnknown),
    fullscreen: !!msg.fullscreen,
    doc: doc || null,
    ts: ts
  };
}

function sanitizeTab(raw) {
  const out = { frames: {}, topDoc: null };
  if (raw && typeof raw === 'object') {
    if (raw.frames && typeof raw.frames === 'object') out.frames = raw.frames;
    if (typeof raw.topDoc === 'string') out.topDoc = raw.topDoc;
  }
  return out;
}

function getTab(tabId) {
  const t = tabState.get(tabId);
  if (t) return Promise.resolve(t);
  let p = tabLoads.get(tabId);
  if (!p) {
    const id = SESSION_PREFIX + tabId;
    p = call(() => chrome.storage.session.get(id))
      .then((r) => sanitizeTab(r && r[id]), () => sanitizeTab(null))
      .then((loaded) => {
        // 加载期间 tab 被关掉了就不再放回缓存
        if (tabLoads.get(tabId) === p) {
          tabLoads.delete(tabId);
          if (!tabState.has(tabId)) tabState.set(tabId, loaded);
        }
        return tabState.get(tabId) || loaded;
      });
    tabLoads.set(tabId, p);
  }
  return p;
}

function schedulePersist(tabId) {
  if (persistTimers.has(tabId)) return;
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    const t = tabState.get(tabId);
    if (t) call(() => chrome.storage.session.set({ [SESSION_PREFIX + tabId]: t })).catch(noop);
  }, PERSIST_DELAY_MS));
}

function forgetTab(tabId) {
  tabState.delete(tabId);
  tabLoads.delete(tabId);
  badgeSig.delete(tabId);
  clearTimeout(persistTimers.get(tabId));
  persistTimers.delete(tabId);
  clearTimeout(recheckTimers.get(tabId));
  recheckTimers.delete(tabId);
  patchRate.delete(tabId);
  panelFrames.delete(tabId);
  call(() => chrome.storage.session.remove(SESSION_PREFIX + tabId)).catch(noop);
}

function bestFrame(t) {
  return L.pickBestFrame(t.frames, Date.now(), STALE_MS, CHILD_DEAD_MS);
}

async function handleReport(msg, sender) {
  const now = Date.now();
  const eyeReply = await updateEye(msg, now).catch(() => null);

  const tabId = sender.tab && sender.tab.id;
  if (!validTabId(tabId)) return eyeReply;
  // 预渲染、往返缓存（bfcache）里的文档和正在卸载的旧文档发来的报告不算数
  const life = sender.documentLifecycle;
  if (typeof life === 'string' && life !== 'active') return eyeReply;
  const frameId = Number.isInteger(sender.frameId) && sender.frameId >= 0 ? sender.frameId : 0;
  const doc = typeof sender.documentId === 'string' ? sender.documentId : '';
  const t = await getTab(tabId);

  // 顶层文档换了（整页导航、从往返缓存恢复）：旧页面的子 frame 报告全部作废，
  // 新页面里有视频的 iframe 会在 3 秒内通过心跳重新报上来
  if (frameId === 0) {
    const top = doc || (typeof msg.timeOrigin === 'number' && isFinite(msg.timeOrigin) ? 't' + msg.timeOrigin : '');
    if (top && t.topDoc !== top) {
      if (msg.bye) return eyeReply; // 不认识的旧顶层文档在告别，不用管
      t.topDoc = top;
      badgeSig.delete(tabId);
      for (const id of Object.keys(t.frames)) if (id !== '0') delete t.frames[id];
    }
  }

  if (msg.bye) {
    // 文档要离开（pagehide）：只处理确实来自当前记录的那个文档的告别
    const cur = t.frames[frameId];
    if (cur && (!doc || !cur.doc || cur.doc === doc)) {
      if (frameId === 0) t.frames[0] = sanitizeReport({ hasVideo: false }, now, doc);
      else delete t.frames[frameId];
    }
  } else {
    t.frames[frameId] = sanitizeReport(msg, now, doc);
  }

  for (const id of Object.keys(t.frames)) {
    if (id !== '0' && !(now - ((t.frames[id] && t.frames[id].ts) || 0) <= CHILD_PURGE_MS)) delete t.frames[id];
  }
  const ids = Object.keys(t.frames);
  if (ids.length > MAX_FRAMES_PER_TAB) {
    ids.sort((a, b) => (t.frames[a].ts || 0) - (t.frames[b].ts || 0));
    for (const id of ids.slice(0, ids.length - MAX_FRAMES_PER_TAB)) delete t.frames[id];
  }

  schedulePersist(tabId);
  await refreshBadge(tabId, t);
  if (settingsCache && settingsCache.hdrOnly) hoSchedule();
  // 告诉内容脚本它在哪个标签页、哪个 frame：「只关 HDR」只对借开关时看的那个 frame 生效
  return Object.assign({ tabId: tabId, frameId: frameId }, eyeReply);
}

// ---------- 角标 ----------

// 最佳 frame 是子 frame 时，到它该有下一次心跳的时间再看一眼：iframe 悄悄消失（SPA 换页移除了它、
// 告别消息没送到）时角标不会一直停在旧状态
function scheduleRecheck(tabId, best) {
  clearTimeout(recheckTimers.get(tabId));
  recheckTimers.delete(tabId);
  if (!best || best.frameId === 0) return;
  const delay = Math.max(0, (+best.report.ts || 0) + CHILD_DEAD_MS - Date.now()) + 100;
  recheckTimers.set(tabId, setTimeout(() => {
    recheckTimers.delete(tabId);
    const t = tabState.get(tabId);
    if (t) refreshBadge(tabId, t).catch(noop);
  }, delay));
}

function badgeFor(report, accent) {
  if (!report) return null;
  if (report.drm) return BADGE_DRM;
  if (report.state === 'off') return BADGE_SDR;
  if (report.state !== 'on') return null;
  const ink = L.accentInk(accent);
  return { text: 'HDR', color: ink.accent, textColor: ink.on };
}

async function refreshBadge(tabId, t) {
  const best = bestFrame(t);
  scheduleRecheck(tabId, best);
  const s = await getSettings();
  const b = badgeFor(best && best.report, s.ui.accent);
  const sig = b ? b.text + '|' + b.color + '|' + b.textColor : '';
  if (badgeSig.get(tabId) === sig) return;
  badgeSig.set(tabId, sig);
  const a = chrome.action;
  const jobs = [call(() => a.setBadgeText({ tabId, text: b ? b.text : '' }))];
  if (b) {
    jobs.push(call(() => a.setBadgeBackgroundColor({ tabId, color: b.color })));
    jobs.push(call(() => a.setBadgeTextColor({ tabId, color: b.textColor })));
  }
  const results = await Promise.allSettled(jobs);
  // tab 已关闭等原因失败时，下次报告再试
  if (results.some((r) => r.status === 'rejected') && badgeSig.get(tabId) === sig) badgeSig.delete(tabId);
}

// 换了主题色：所有标签页的角标重画
function refreshAllBadges() {
  badgeSig.clear();
  for (const [tabId, t] of tabState) refreshBadge(tabId, t).catch(noop);
}

// 工具栏图标中间那道分割线用主题色（浏览器重启后会回到 manifest 的静态图标，启动时再画一次）
function applyIcon(accent) {
  const icon = self.RtxHdrIcon;
  if (!icon || typeof icon.imageDataSet !== 'function') return Promise.resolve();
  let imageData = null;
  try { imageData = icon.imageDataSet(L.normAccent(accent)); } catch (e) { imageData = null; }
  if (!imageData) return Promise.resolve();
  return call(() => chrome.action.setIcon({ imageData: imageData })).catch(noop);
}

// 界面语言：设置里的（自动时按浏览器界面语言）
let uiLanguage = '';
try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = ''; }

function langOf(s) {
  return I18N ? I18N.resolve(s && s.ui ? s.ui.lang : 'auto', uiLanguage) : 'zh';
}

// ---------- 护眼计时（跨视频、跨标签页累计） ----------

let eyeState = null;
let eyeLoading = null;
let eyePersistTimer = 0;
let settingsCache = null;
let settingsLoading = null;

function getSettings() {
  if (settingsCache) return Promise.resolve(settingsCache);
  if (!settingsLoading) {
    settingsLoading = call(() => chrome.storage.local.get('settings'))
      .then((r) => L.mergeSettings(r && r.settings), () => L.mergeSettings(null))
      .then((s) => {
        settingsLoading = null;
        if (!settingsCache) settingsCache = s;
        return settingsCache;
      });
  }
  return settingsLoading;
}

// 计时放在 storage.session（浏览器重启清零）；「护眼 SDR」以 storage.local 里的标记为准（内容脚本读它）
function getEye() {
  if (eyeState) return Promise.resolve(eyeState);
  if (!eyeLoading) {
    eyeLoading = Promise.all([
      call(() => chrome.storage.session.get(EYE_SESSION_KEY)).catch(() => null),
      call(() => chrome.storage.local.get(L.EYE_REST_KEY)).catch(() => null)
    ]).then(([ses, loc]) => {
      const s = L.eyeState(ses && ses[EYE_SESSION_KEY]);
      s.rest = !!L.eyeRestAt(loc && loc[L.EYE_REST_KEY]);
      eyeLoading = null;
      if (!eyeState) eyeState = s;
      return eyeState;
    });
  }
  return eyeLoading;
}

function persistEye() {
  if (eyePersistTimer) return;
  eyePersistTimer = setTimeout(() => {
    eyePersistTimer = 0;
    if (eyeState) call(() => chrome.storage.session.set({ [EYE_SESSION_KEY]: eyeState })).catch(noop);
  }, PERSIST_DELAY_MS);
}

function writeRest(on, now) {
  return call(() => (on
    ? chrome.storage.local.set({ [L.EYE_REST_KEY]: { on: true, at: now } })
    : chrome.storage.local.remove(L.EYE_REST_KEY))).catch(noop);
}

async function toggleShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const c = (cmds || []).find((x) => x && x.name === 'toggle-hdr');
    return (c && c.shortcut) || '';
  } catch (e) {
    return '';
  }
}

function eyeInc(x) {
  return typeof x === 'number' && isFinite(x) && x > 0 ? Math.min(x, MAX_EYE_INC_MS) : 0;
}

// 返回给发报告的内容脚本：到点时带上 remind，由它在视频上显示提醒
async function updateEye(msg, now) {
  const [s, settings] = await Promise.all([getEye(), getSettings()]);
  const res = L.eyeUpdate(s, { hdr: eyeInc(msg.eyeHdr), watch: eyeInc(msg.eyeWatch) }, settings.eye, now);
  persistEye();
  if (res.restChanged) writeRest(s.rest, now);
  if (!res.remind) return null;
  return {
    remind: {
      minutes: settings.eye.minutes,
      autoOff: s.rest && !msg.drm, // DRM 视频切不了
      shortcut: await toggleShortcut()
    }
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  if (changes.settings) {
    const prev = L.mergeSettings(changes.settings.oldValue);
    settingsCache = L.mergeSettings(changes.settings.newValue);
    // 改了时段或时段预设：马上检查一次（记录里的时段或预设对不上就套用新的）
    if (nvScheduleSig(prev) !== nvScheduleSig(settingsCache)) nvScheduleCheck();
    if (prev.ui.accent !== settingsCache.ui.accent) {
      applyIcon(settingsCache.ui.accent);
      refreshAllBadges();
    }
    if (prev.nv.followSdr !== settingsCache.nv.followSdr || prev.nv.displayId !== settingsCache.nv.displayId) {
      nvSyncFollowAlarm(settingsCache);
      if (settingsCache.nv.followSdr) nvFollowCheck();
    }
    if (prev.hdrOnly !== settingsCache.hdrOnly) {
      hoCaps = null; // 重新探测本地组件
      hoRetryAt = 0;
      hoSuppress = null;
      hoSchedule();
    }
    const e = settingsCache.eye;
    // 关掉提醒或「到时自动切回 SDR」：正在进行的护眼 SDR 也结束
    if (!e.minutes || !e.autoOff) {
      getEye().then((s) => {
        if (!s.rest) return;
        s.rest = false;
        persistEye();
        writeRest(false, Date.now());
      }).catch(noop);
    }
  }
  if (changes[L.EYE_REST_KEY]) {
    // 内容脚本在护眼 SDR 期间手动切回 HDR 时会删掉标记
    const on = !!L.eyeRestAt(changes[L.EYE_REST_KEY].newValue);
    getEye().then((s) => {
      if (s.rest === on) return;
      s.rest = on;
      persistEye();
    }).catch(noop);
  }
});

// ---------- 快捷键 ----------

async function activeTab() {
  const tabs = await call(() => chrome.tabs.query({ active: true, lastFocusedWindow: true })).catch(() => []);
  return tabs && tabs[0];
}

// 先发给有视频的 frame，失败再发给顶层 frame；都没送到返回 false
async function sendToBestFrame(tabId, msg) {
  const best = bestFrame(await getTab(tabId));
  const frames = best && best.frameId !== 0 ? [best.frameId, 0] : [0];
  for (const frameId of frames) {
    try {
      await chrome.tabs.sendMessage(tabId, msg, { frameId: frameId });
      return true;
    } catch (e) {
      // chrome:// 页面、内容脚本未注入或 frame 已不存在：试下一个
    }
  }
  return false;
}

async function handleCommand(command, tab) {
  if (command === 'nv-next-preset') return nvNextPreset();
  if (command === 'nv-mg-up') return nvMgHotkey(MG_STEP);
  if (command === 'nv-mg-down') return nvMgHotkey(-MG_STEP);
  if (command === 'nv-undo') return nvUndoHotkey();
  if (!tab || !validTabId(tab.id)) tab = await activeTab();
  const tabId = tab && validTabId(tab.id) ? tab.id : null;
  // 「开/关 自动检测」只改设置，直接在这里做（页面上没有内容脚本时也能用），提示显示在当前标签页的视频上
  if (command === 'toggle-auto') return toggleAuto(tabId === null ? null : { tabId: tabId });
  if (tabId !== null) await sendToBestFrame(tabId, { type: 'command', command: command });
}

chrome.commands.onCommand.addListener((command, tab) => {
  handleCommand(command, tab).catch(noop);
});

// ---------- 设置（只有 background 写 settings） ----------
// 弹窗、选项页、面板和内容脚本都提交补丁，这里排队「读最新值 → 改 → 规范化 → 有变化才写」，互相不会覆盖

let settingsQueue = Promise.resolve();
const patchRate = new Map(); // tabId → {at, n}：内容脚本提交补丁的次数（每秒最多 CONTENT_PATCH_PER_SEC 次）

// mutator 拿到 storage 里的原始值，返回新设置（再过 mergeSettings；返回的不是对象时只做规范化）。结果是规范化后的设置
function settingsTxn(mutator) {
  const run = settingsQueue.then(async () => {
    const r = await chrome.storage.local.get('settings');
    const cur = r && r.settings;
    const out = mutator(cur);
    const next = L.mergeSettings(out && typeof out === 'object' ? out : cur);
    if (JSON.stringify(cur) !== JSON.stringify(next)) await chrome.storage.local.set({ settings: next });
    settingsCache = next;
    return next;
  });
  settingsQueue = run.then(noop, noop);
  return run;
}

// 「开/关 自动检测」。where = {tabId, frameId?}：提示显示在这个 frame 上（没给 frameId 时显示在该标签页的主视频上）
async function toggleAuto(where) {
  const s = await settingsTxn(L.toggleAutoMode);
  if (!where || !validTabId(where.tabId)) return s;
  const lang = langOf(s);
  const msg = {
    type: 'osd',
    text: s.autoDetect === 'off' ? L.t(lang, 'content.autoOff')
      : L.t(lang, 'content.autoOn', { mode: L.autoModeText(s.autoDetect, lang) }),
    warn: false
  };
  let shown = false;
  if (Number.isInteger(where.frameId) && where.frameId >= 0) {
    shown = await call(() => chrome.tabs.sendMessage(where.tabId, msg, { frameId: where.frameId })).then(() => true, () => false);
  }
  if (!shown) await sendToBestFrame(where.tabId, msg);
  return s;
}

// 发消息的内容脚本所在标签页的顶层域名（<all_urls> 能读到 tab.url）
function senderTopHost(sender) {
  const url = sender.tab && typeof sender.tab.url === 'string' && sender.tab.url ? sender.tab.url
    : sender.frameId === 0 && typeof sender.url === 'string' ? sender.url : '';
  try {
    return url ? new URL(url).hostname : '';
  } catch (e) {
    return '';
  }
}

function patchRateOk(tabId) {
  const now = Date.now();
  const r = patchRate.get(tabId);
  if (!r || now - r.at >= 1000) {
    patchRate.set(tabId, { at: now, n: 1 });
    return true;
  }
  r.n++;
  return r.n <= CONTENT_PATCH_PER_SEC;
}

// {type:'settings-patch', patch} 或 {type:'settings-patch', op:'toggle-auto'} → {ok, settings} | {ok:false, code}。
// 弹窗、选项页能改任何字段；播放器里的内容脚本和面板只能改 L.contentPatchAllowed 放行的字段
// （网站相关的只能改自己顶层页面那一条，网站预设只有面板能改），并且按标签页限速
async function handleSettingsPatch(msg, sender, page) {
  const tabId = sender.tab && sender.tab.id;
  const inPlayer = !page || page === 'panel';
  if (inPlayer) {
    const life = sender.documentLifecycle;
    if (!validTabId(tabId) || (typeof life === 'string' && life !== 'active')) return { ok: false, code: 'forbidden' };
    if (!patchRateOk(tabId)) return { ok: false, code: 'busy' };
  }
  if (msg.op === 'toggle-auto') {
    // 内容脚本：提示显示在发起的 frame 上；面板：显示在所在标签页的主视频上
    let where = page === 'panel' ? { tabId: tabId } : { tabId: tabId, frameId: sender.frameId };
    if (page && page !== 'panel') {
      const tab = await activeTab();
      where = tab && validTabId(tab.id) ? { tabId: tab.id } : null;
    }
    return { ok: true, settings: await toggleAuto(where) };
  }
  const p = msg.patch;
  if (msg.op !== undefined || !p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, code: 'bad-request' };
  let patch = p;
  if (inPlayer) {
    const v = L.contentPatchAllowed(p, senderTopHost(sender), page === 'panel');
    if (!v.ok) return { ok: false, code: v.code };
    patch = v.patch;
  }
  return { ok: true, settings: await settingsTxn((cur) => L.applySettingsPatch(cur, patch)) };
}

// ---------- 本地组件连接 ----------
// 平时共用一个常驻端口（一个本地组件进程），请求按 id 匹配回复：借用、快捷键、时段、跟随 SDR、弹窗兜底都走它。
// 借用「只关 HDR」期间端口一直开着；没有借用、也没有等待中的请求时 HOST_IDLE_MS 后断开，service worker 才能休眠。
// connectNative 抛错，或本地组件连续 HOST_MAX_FAILS 次没回复就退出时，改用一次起一个进程的 sendNativeMessage

let nvQueue = Promise.resolve();
let hostConn = null; // {port, waiters, seq, idle, replied, closed}
let hostFails = 0;
let hostRetryAt = 0; // 退回 sendNativeMessage 期间，到这个时间再试常驻端口

// 一次请求起一个本地组件进程；lastError 和超时都变成 {ok:false, error}，永远不 reject
function nvSend(msg) {
  return new Promise((resolve) => {
    let timer = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    timer = setTimeout(() => finish({ ok: false, error: { code: 'timeout' } }), NV_TIMEOUT_MS);
    try {
      chrome.runtime.sendNativeMessage(L.NV_HOST, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) finish(L.nvPortError(err.message));
        else finish(res && typeof res === 'object' ? res : { ok: false, error: { code: 'host-error' } });
      });
    } catch (e) {
      finish(L.nvPortError((e && e.message) || 'error'));
    }
  });
}

// 一次一个进程的通道：请求排队一个一个来
function nvSendQueued(msg) {
  const p = nvQueue.then(() => nvSend(msg));
  nvQueue = p;
  return p;
}

function hostFailed() {
  hostFails++;
  if (hostFails >= HOST_MAX_FAILS) hostRetryAt = Date.now() + HOST_RETRY_MS;
}

function hostLeased(conn) {
  return !!hoLease && hoLease.conn === conn;
}

function hostOpen() {
  if (hostConn) return hostConn;
  let port;
  try {
    port = chrome.runtime.connectNative(L.NV_HOST);
  } catch (e) {
    hostFails = Math.max(hostFails, HOST_MAX_FAILS - 1);
    hostFailed();
    return null;
  }
  const conn = { port: port, waiters: [], seq: 0, idle: 0, replied: false, closed: false };
  port.onMessage.addListener((res) => {
    if (!res || typeof res !== 'object') return;
    const i = res.id == null ? 0 : conn.waiters.findIndex((w) => w.id === res.id);
    if (i < 0 || !conn.waiters.length) return;
    conn.replied = true;
    hostFails = 0;
    conn.waiters.splice(i, 1)[0].done(res);
    hostIdle(conn);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    // 一次都没回复就退出了（没安装、启动失败等）
    if (!conn.closed && !conn.replied) hostFailed();
    hostDrop(conn, L.nvPortError(err && err.message));
  });
  hostConn = conn;
  return conn;
}

// 端口不能再用了：等待中的请求按 fail 结束；借用随之结束（本地组件收到 EOF 时已经把 HDR 恢复了）
function hostDrop(conn, fail) {
  conn.closed = true;
  clearTimeout(conn.idle);
  if (hostConn === conn) hostConn = null;
  for (const w of conn.waiters.splice(0)) w.done(fail);
  if (hostLeased(conn)) {
    hoLease = null;
    hoSchedule();
  }
}

function hostClose(conn) {
  if (conn.closed) return;
  hostDrop(conn, { ok: false, error: { code: 'host-exit' } });
  try { conn.port.disconnect(); } catch (e) { /* ignore */ }
}

// 没有借用、也没有等待中的请求：空闲 HOST_IDLE_MS 后断开
function hostIdle(conn) {
  clearTimeout(conn.idle);
  conn.idle = 0;
  if (conn.closed || conn.waiters.length || hostLeased(conn)) return;
  conn.idle = setTimeout(() => {
    if (!conn.waiters.length && !hostLeased(conn)) hostClose(conn);
  }, HOST_IDLE_MS);
}

function hostRequest(conn, msg) {
  return new Promise((resolve) => {
    const id = ++conn.seq;
    const w = { id: id, done: null };
    const timer = setTimeout(() => {
      const i = conn.waiters.indexOf(w);
      if (i >= 0) conn.waiters.splice(i, 1);
      resolve({ ok: false, error: { code: 'timeout' } });
      // 本地组件卡住了：没有借用时下次换一个新进程（借用期间断开会让本地组件恢复 HDR，先留着）
      if (hostLeased(conn)) hostIdle(conn);
      else hostClose(conn);
    }, NV_TIMEOUT_MS);
    w.done = (res) => {
      clearTimeout(timer);
      resolve(res);
    };
    clearTimeout(conn.idle);
    conn.waiters.push(w);
    try {
      conn.port.postMessage(Object.assign({ id: id }, msg));
    } catch (e) {
      const i = conn.waiters.indexOf(w);
      if (i >= 0) conn.waiters.splice(i, 1);
      w.done(L.nvPortError((e && e.message) || 'error'));
      hostIdle(conn);
    }
  });
}

// 对本地组件的请求都走这里，永远不 reject。needPort：必须用常驻端口（借用绑在端口上）
function hostCall(msg, needPort) {
  if (!needPort && hostFails >= HOST_MAX_FAILS && Date.now() < hostRetryAt) return nvSendQueued(msg);
  const conn = hostOpen();
  if (conn) return hostRequest(conn, msg);
  return needPort ? Promise.resolve({ ok: false, error: { code: 'host-error' } }) : nvSendQueued(msg);
}

// 旧名字：读写 NVIDIA 设置的请求
const nvCall = hostCall;

// ---------- NVIDIA 写入：互斥、修改记录、撤销 ----------
// 每次「get → set」和借用的借、还都在 nvTxn 里排队执行。只能在锁内调用的函数以 Locked 结尾：
// 它们之间可以互相调用，但不能再调 nvTxn（会等自己，死锁）

let nvLock = Promise.resolve();
let nvLogQueue = Promise.resolve();
const nvDragStart = new Map(); // 来源 → {state, at}：拖动开始前的 State。commit:false 的中间帧不单独记，起点并进下一条 commit

function nvTxn(fn) {
  const run = nvLock.then(() => fn());
  nvLock = run.then(noop, noop);
  return run;
}

function nvHasEnabled(patch) {
  return !!patch && !!patch.hdr && typeof patch.hdr.enabled === 'boolean';
}

// 修改记录在 storage.session（浏览器重启清空，内容脚本读不到）。fn(旧日志) → 新日志，排队读改写
function nvLogUpdate(fn) {
  const run = nvLogQueue.then(async () => {
    const r = await call(() => chrome.storage.session.get(NV_LOG_KEY)).catch(() => null);
    const next = fn(r && r[NV_LOG_KEY]);
    if (next) await call(() => chrome.storage.session.set({ [NV_LOG_KEY]: next })).catch(noop);
    return next;
  });
  nvLogQueue = run.then(noop, noop);
  return run;
}

// 排在写入后面读，读到的是最新的
function nvLogRead() {
  let out = null;
  return nvLogUpdate((cur) => {
    out = L.nvNormLog(cur);
    return null;
  }).then(() => out || L.nvNormLog(null), () => L.nvNormLog(null));
}

// 记一次写入（L.nvWriteEntry 的参数，at 自动补上）；返回条目 id，不用记时返回 null
async function nvLogWrite(w) {
  const e = L.nvWriteEntry(Object.assign({ at: Date.now() }, w));
  if (!e) return null;
  const log = await nvLogUpdate((cur) => L.nvLogAppend(cur, e)).catch(() => null);
  return log ? log.seq : null;
}

/**
 * 所有 NVIDIA 写入（弹窗和面板拖动滑块除外，它们走自己的端口再补发 nv-log）：
 * req = {source, label?, patch | build(st), lease:'yield'|'suppress', commit=true, undoOf?}
 * → {ok, state, error?, stage?, noop?, empty?, diff?, logId?}，永远不 reject。
 * build(st) 拿到实时 State（已规范化），返回补丁或 null（null 时回复 empty，什么都不写）
 */
function nvWrite(req) {
  return nvTxn(() => nvWriteLocked(req))
    .catch((e) => ({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } }));
}

async function nvWriteLocked(req) {
  const source = req.source;
  const user = NV_USER_SOURCES.has(source);
  const commit = req.commit !== false;
  const got = await hostCall({ cmd: 'get' });
  const st = got && got.ok === true ? L.nvNormState(got.state) : null;
  if (!st) {
    const error = (got && got.error) || { code: 'host-error' };
    // 自动来源（时段、跟随 SDR 等）读不到就不记，免得没装本地组件时每分钟一条
    if (user) await nvLogWrite({ source: source, label: req.label, before: null, after: null, patch: req.patch, error: error, undoOf: req.undoOf });
    return { ok: false, error: error, stage: 'get' };
  }
  // 借用期间实时的「关」是借来的：记录的前后值都换回借用前的值（去重和校验仍对实时值做）
  const lease = hoLeaseInfo();
  const real = L.nvUnleased(got.state, lease);
  let patch = typeof req.build === 'function' ? req.build(st, lease) : req.patch;
  if (!patch || typeof patch !== 'object') return { ok: false, error: { code: 'unsupported' }, stage: 'get', empty: true, state: got.state };
  if (!user) patch = L.nvAutoGuard(patch, await getSettings(), source);
  // 先处理借用再去重：借用期间实时的「关」是借来的，和它比会漏掉用户真正想要的开关
  const adj = L.nvLeaseAdjust(patch, lease, req.lease === 'suppress' ? 'suppress' : 'yield');
  const reEval = () => { if (adj.action === 'drop-yield') hoSchedule(); };
  // 拖动的起点（NV_DRAG_MS 内没再动过的不算，比如弹窗松手前就关了）
  const drag = nvDragStart.get(source);
  const dragBefore = drag && Date.now() - drag.at < NV_DRAG_MS ? drag.state : null;
  const delta = L.nvPatchDelta(adj.patch, st);
  const v = delta ? L.nvValidatePatch(Object.assign(delta, { commit: commit }), got.state) : null;
  if (v && !v.ok) {
    // 校验不过就什么都不写，借用也不动
    if (user) await nvLogWrite({ source: source, label: req.label, before: real, after: null, patch: delta, error: v.error, undoOf: req.undoOf });
    return { ok: false, error: v.error, stage: 'set', state: got.state };
  }
  // 校验通过才归还借用。要开 HDR 时让本地组件自己写回借用前的值：之后的 set 失败也不会停在借来的「关」上
  const restore = !!adj.patch.hdr && adj.patch.hdr.enabled === true;
  if (adj.action === 'drop-suppress') await hoDropLocked(restore);
  else if (adj.action === 'drop-yield') await hoReleaseLocked(restore);
  const unleased = (state) => L.nvUnleased(state, hoLeaseInfo());
  if (!delta) {
    reEval();
    let logId = null;
    // 松手时的值和最后一帧相同：这次不用写，但整段拖动要记一条
    if (commit && dragBefore) {
      nvDragStart.delete(source);
      logId = await nvLogWrite({ source: source, label: req.label, before: dragBefore, after: unleased(got.state), patch: adj.patch, undoOf: req.undoOf });
    }
    return { ok: true, noop: true, state: got.state, logId: logId };
  }
  const res = await hostCall(Object.assign({ cmd: 'set' }, v.patch));
  reEval();
  const ok = !!res && res.ok === true;
  if (!commit) {
    if (ok) nvDragStart.set(source, { state: dragBefore || real, at: Date.now() });
    return ok ? { ok: true, state: res.state } : Object.assign({ ok: false, error: { code: 'host-error' } }, res, { stage: 'set' });
  }
  const before = dragBefore || real;
  const after = ok ? unleased(res.state) : null;
  nvDragStart.delete(source);
  const logId = await nvLogWrite({
    source: source, label: req.label, before: before, after: after, patch: v.patch,
    error: ok ? null : (res && res.error) || { code: 'host-error' }, undoOf: req.undoOf
  });
  if (!ok) return Object.assign({ ok: false, error: { code: 'host-error' } }, res, { stage: 'set', logId: logId });
  return { ok: true, state: res.state, diff: L.nvStateDiff(before, after), logId: logId };
}

// 套用预设：最高亮度夹到实时范围；HDR 出错（Windows 没开 HDR、显示器休眠或还没重新识别等）时只写超分，
// 成功的回复带 hdrSkipped；onlyHdr：只补写之前跳过的 HDR 部分，不再写超分。
// 失败的回复带 stage（'get'：什么都还没写）。预设开关和借用前的值一样时不碰借用（不闪烁）
async function nvApplyPreset(preset, onlyHdr, source) {
  let st = null;
  const res = await nvWrite({
    source: source || 'hotkey',
    label: preset.name,
    lease: 'yield',
    build: (x) => {
      st = x;
      const patch = L.nvPresetPatch(preset, x);
      if (patch && onlyHdr) delete patch.vsr;
      return patch && (patch.hdr || patch.vsr) ? patch : null;
    }
  });
  const hdrSkipped = !!(st && st.hdr.supported && st.hdr.error);
  if (res.empty) {
    const error = hdrSkipped ? { code: 'hdr-error', errorCode: st.hdr.error } : { code: 'unsupported' };
    return { ok: false, error: error, stage: 'get', state: res.state };
  }
  if (res.ok !== true) return res;
  await call(() => chrome.storage.local.set({ [NV_LAST_PRESET_KEY]: preset.id })).catch(noop);
  return hdrSkipped ? Object.assign({}, res, { hdrSkipped: true }) : res;
}

// 在当前标签页的视频上显示提示；warn（失败等）关了屏幕提示也显示，页面上显示不了时留到下次打开弹窗
async function hotkeyOsd(text, warn) {
  const tab = await activeTab();
  const shown = !!tab && validTabId(tab.id) && await sendToBestFrame(tab.id, { type: 'osd', text: text, warn: warn });
  if (warn && !shown) await call(() => chrome.storage.local.set({ [NV_HOTKEY_ERROR_KEY]: { text: text, at: Date.now() } })).catch(noop);
}

async function nvNextPreset() {
  const s = await getSettings();
  const lang = langOf(s);
  const presets = s.nv.presets;
  let text;
  let warn = true; // 失败或只套用了一部分
  if (!presets.length) {
    text = L.t(lang, 'bg.noPresets');
  } else {
    const r = await call(() => chrome.storage.local.get(NV_LAST_PRESET_KEY)).catch(() => null);
    const id = L.nvNextPresetId(presets, r && r[NV_LAST_PRESET_KEY]);
    const preset = presets.find((p) => p.id === id);
    const res = await nvApplyPreset(preset, false, 'hotkey');
    if (res.ok !== true) {
      text = L.t(lang, 'bg.presetFailed', { err: L.nvErrorText(res.error, lang) });
    } else if (res.hdrSkipped) {
      text = L.t(lang, 'bg.presetPartial', { name: preset.name });
    } else {
      text = L.t(lang, 'bg.preset', { name: preset.name });
      warn = false;
    }
  }
  await hotkeyOsd(text, warn);
}

// 快捷键：中间灰 ±5（读当前值再写，到头了只提示）
async function nvMgHotkey(delta) {
  const s = await getSettings();
  const lang = langOf(s);
  const fail = (err) => hotkeyOsd(L.t(lang, 'bg.nvFailed', { err: L.nvErrorText(err, lang) }), true);
  let st = null;
  let step = null;
  const res = await nvWrite({
    source: 'hotkey',
    build: (x) => {
      st = x;
      if (!x.hdr.supported || x.hdr.error) return null;
      step = L.nvMgStep(x, delta);
      return { hdr: { middleGrey: step.value } };
    }
  });
  if (!st) return fail(res.error);
  if (!st.hdr.supported) return fail({ code: 'unsupported', field: 'hdr' });
  if (st.hdr.error) return fail({ code: 'hdr-error', errorCode: st.hdr.error });
  if (res.noop) return hotkeyOsd(L.t(lang, 'bg.mgLimit', { value: step.value }), false);
  if (res.ok !== true) return fail(res.error);
  return hotkeyOsd(L.t(lang, 'bg.mg', { value: step.value, delta: (delta > 0 ? '+' : '−') + Math.abs(delta) }), false);
}

/**
 * 撤销最近一条可撤销的修改（连按逐条往前）：只撤销实时值仍等于当时改后值的参数（借用期间开关按借用前的值比较）。
 * from 是发起方（hotkey、popup、panel），记进撤销条目的 label。
 * 返回 nvWrite 的结果另带 target（被撤销的条目）、skipped（之后又被改过、没撤销的字段）
 * 和 unavailable（现在写不了的字段，比如 HDR 出错；这条留着，之后还能撤销）；没有可撤销的返回 {ok:false, code:'none'}
 */
function nvUndo(from) {
  return nvTxn(async () => {
    const done = (id) => nvLogUpdate((log) => L.nvLogMarkUndone(log, id)).catch(noop);
    for (;;) {
      const target = L.nvUndoTarget(await nvLogRead(), Date.now());
      if (!target) return { ok: false, code: 'none' };
      let u = null;
      const res = await nvWriteLocked({
        source: 'undo',
        label: typeof from === 'string' ? from : undefined,
        undoOf: target.id,
        lease: 'yield',
        build: (st, lease) => {
          u = L.nvUndoPatch(target, st, lease);
          return u && u.patch;
        }
      });
      const skipped = u ? u.skipped : [];
      const unavailable = u ? u.unavailable : [];
      const out = Object.assign({}, res, { target: target, skipped: skipped, unavailable: unavailable });
      // 实时值已经等于改前的值（比如最高亮度夹到范围后相同）：这条算撤销过了，接着往前找
      if (res.empty && u && !skipped.length && !unavailable.length) {
        await done(target.id);
        continue;
      }
      // 有现在写不了的字段：这条留着，等 HDR 恢复后还能撤销
      if (unavailable.length) {
        if (res.empty) out.error = L.nvUnavailableError(res.state, unavailable[0]) || { code: 'unsupported' };
        return out;
      }
      // 撤销成功，或者这条改过的参数之后全被改过了（撤销不了）：标记已撤销，下次往前找
      if (res.ok === true || (res.empty && skipped.length)) await done(target.id);
      return out;
    }
  }).catch((e) => ({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } }));
}

async function nvUndoHotkey() {
  const s = await getSettings();
  const lang = langOf(s);
  const res = await nvUndo('hotkey');
  if (res.code === 'none') return hotkeyOsd(L.t(lang, 'bg.undoNone'), false);
  if (res.ok === true) {
    const t = res.target;
    const change = L.nvChangeText(res.diff, lang) || L.nvChangeText({ before: t.after, after: t.before }, lang);
    return hotkeyOsd(L.t(lang, 'bg.undo', { change: change }), false);
  }
  if (res.empty && !(res.unavailable && res.unavailable.length) && res.skipped && res.skipped.length) {
    const fields = res.skipped.map((f) => L.t(lang, 'nv.field.' + f)).join(lang === 'en' ? ', ' : '、');
    return hotkeyOsd(L.t(lang, 'nv.undoSkipped', { fields: fields }), true);
  }
  return hotkeyOsd(L.t(lang, 'bg.undoFailed', { err: L.nvErrorText(res.error, lang) }), true);
}

// ---------- 跟随 Windows SDR 亮度 ----------

async function nvSyncFollowAlarm(s) {
  if (s.nv.followSdr) {
    const a = await call(() => chrome.alarms.get(NV_FOLLOW_ALARM)).catch(() => null);
    if (!a) await call(() => chrome.alarms.create(NV_FOLLOW_ALARM, { periodInMinutes: 0.5 })).catch(noop);
  } else {
    await call(() => chrome.alarms.clear(NV_FOLLOW_ALARM)).catch(noop);
  }
}

let nvFollowing = null;
let nvFollowFail = { white: null, n: 0 }; // 同一白电平连续调不成的次数

// 白电平和上次调中间灰时不一样才调：用户之后手动改的中间灰在 SDR 亮度再变之前不会被覆盖。
// 建议值和当前一样或写成功了才记下这个白电平；HDR 出错、读写失败时等下一轮（30 秒后）再试，
// 同一白电平连续 NV_FOLLOW_MAX_FAILS 次不成也记下，不再重试
function nvFollowCheck() {
  if (nvFollowing) return nvFollowing;
  nvFollowing = (async () => {
    const s = await getSettings();
    if (!s.nv.followSdr) return;
    const res = await hostCall({ cmd: 'display' });
    if (!res || res.ok !== true || !Array.isArray(res.displays)) return;
    const d = L.nvPickDisplay(res.displays, s.nv.displayId);
    if (!d || !d.hdrEnabled || d.sdrWhiteNits == null) return;
    const white = d.sdrWhiteNits;
    const r = await call(() => chrome.storage.local.get(SDR_LAST_KEY)).catch(() => null);
    if (r && r[SDR_LAST_KEY] === white) return;
    let sug = null;
    const w = await nvWrite({
      source: 'follow',
      build: (st) => {
        if (!st.hdr.supported || st.hdr.error) return null;
        sug = L.nvSuggest(d, st);
        return sug ? { hdr: { middleGrey: sug.middleGrey } } : null;
      }
    });
    if (w.ok !== true) {
      if (nvFollowFail.white !== white) nvFollowFail = { white: white, n: 0 };
      if (++nvFollowFail.n < NV_FOLLOW_MAX_FAILS) return;
    }
    nvFollowFail = { white: null, n: 0 };
    await call(() => chrome.storage.local.set({ [SDR_LAST_KEY]: white })).catch(noop);
    if (w.ok === true && !w.noop && s.osd) {
      const tab = await activeTab();
      if (tab && validTabId(tab.id)) await sendToBestFrame(tab.id, { type: 'osd', text: L.t(langOf(s), 'bg.follow', { value: sug.middleGrey }), warn: false });
    }
  })().catch(noop).then(() => { nvFollowing = null; });
  return nvFollowing;
}

// ---------- 只关 HDR（保留超分）：向本地组件借用全局 HDR 开关 ----------
// 当前窗口的当前标签页里，主视频想关 HDR 时借（本地组件关掉全局 HDR，超分不受影响），否则还。
// 借用绑在共用的常驻端口上：浏览器退出、扩展重载或端口断开时本地组件自己把 HDR 恢复。
// 借和还都在 nvTxn 里，和其他写入不会交错

let hoCaps = null; // null 未探测；true 本地组件支持 hdrLease；false 不支持或不可用
let hoCapsError = null;
let hoLease = null; // {conn, prevEnabled}：正借着全局开关；prevEnabled 是借用前的开关（不知道时为 null）
let hoTimer = 0;
let hoRunning = null;
let hoAgain = false;
let hoRetryAt = 0;
let hoLastError = null;
let hoSuppress = null; // {tabId, key}：用户亲手改了全局 HDR，这个视频不再借
let hoStatusSig = '';

function hoSchedule() {
  clearTimeout(hoTimer);
  hoTimer = setTimeout(() => {
    hoTimer = 0;
    hoEvaluate();
  }, HO_DEBOUNCE_MS);
}

function hoLeaseInfo() {
  return { held: !!hoLease, prevEnabled: hoLease ? hoLease.prevEnabled : null };
}

async function hoAcquireLocked() {
  if (hoLease) return true;
  const conn = hostOpen();
  if (!conn) {
    hoLastError = { code: 'host-error' };
    return false;
  }
  const res = await hostRequest(conn, { cmd: 'hdrLease', on: true });
  if (res && res.ok === true && !conn.closed) {
    hoLease = { conn: conn, prevEnabled: typeof res.prevEnabled === 'boolean' ? res.prevEnabled : null };
    hoLastError = null;
    hostIdle(conn);
    if (res.changed) await nvLogWrite({ source: 'lease', before: { hdr: { enabled: true } }, after: { hdr: { enabled: false } } });
    return true;
  }
  hoLastError = (res && res.error) || { code: 'host-error' };
  return false;
}

// restore:false：用户亲手改了全局 HDR，以用户的为准，不再恢复
async function hoReleaseLocked(restore) {
  const lease = hoLease;
  if (!lease) return;
  hoLease = null;
  const res = await hostRequest(lease.conn, { cmd: 'hdrLease', on: false, restore: restore !== false });
  if (res && res.ok === true) {
    if (res.changed) await nvLogWrite({ source: 'lease', before: { hdr: { enabled: false } }, after: { hdr: { enabled: true } } });
    hostIdle(lease.conn);
  } else {
    // 没还成：断开端口，本地组件收到 EOF 时自己还
    hostClose(lease.conn);
  }
}

function hoRelease(restore) {
  return nvTxn(() => hoReleaseLocked(restore));
}

async function hoProbe() {
  const hello = await hostCall({ cmd: 'hello' });
  if (hello && hello.ok === true) {
    hoCaps = Array.isArray(hello.caps) && hello.caps.indexOf('hdrLease') >= 0;
    hoCapsError = hoCaps ? null : { code: 'old-host' };
  } else {
    hoCaps = false;
    hoCapsError = (hello && hello.error) || { code: 'host-error' };
  }
}

async function hoSetStatus(st) {
  const sig = JSON.stringify(st);
  if (sig === hoStatusSig) return;
  hoStatusSig = sig;
  await call(() => chrome.storage.local.set({ [HDR_ONLY_KEY]: st })).catch(noop);
}

// 借开关时看的视频：当前窗口当前标签页里的主视频
async function hoTarget() {
  const tab = await activeTab();
  if (!tab || !validTabId(tab.id)) return null;
  const best = bestFrame(await getTab(tab.id));
  return { tabId: tab.id, frameId: best ? best.frameId : 0, report: best ? best.report : null };
}

// 主视频想关（不是 DRM）就要借
function hoWanted(target) {
  const r = target && target.report;
  if (!r || !r.hasVideo || r.drm || r.state !== 'off') return false;
  if (hoSuppress && hoSuppress.tabId === target.tabId && hoSuppress.key === r.key) return false;
  if (hoSuppress && (hoSuppress.tabId !== target.tabId || hoSuppress.key !== r.key)) hoSuppress = null;
  return true;
}

// 内容脚本只在 tabId / frameId 这个 frame 里不加滤镜，其他窗口里想关的视频照常加滤镜。
// 借用期间带上借用前的开关（prevEnabled）：弹窗保存预设、配置档时用它代替被借走的「关」
function hoActiveStatus(target, lease) {
  const st = { active: true, leased: !!lease, tabId: target ? target.tabId : -1, frameId: target ? target.frameId : -1 };
  if (lease && typeof lease.prevEnabled === 'boolean') st.prevEnabled = lease.prevEnabled;
  return st;
}

function hoEvaluate() {
  if (hoRunning) {
    hoAgain = true;
    return hoRunning;
  }
  hoRunning = (async () => {
    do {
      hoAgain = false;
      await hoEvaluateOnce().catch(noop);
    } while (hoAgain);
    hoRunning = null;
  })();
  return hoRunning;
}

async function hoEvaluateOnce() {
  const s = await getSettings();
  if (!s.hdrOnly) {
    await hoRelease(true);
    await hoSetStatus({ active: false, leased: false });
    return;
  }
  if (hoCaps === null) await hoProbe();
  if (!hoCaps) {
    await hoRelease(true);
    await hoSetStatus({ active: false, leased: false, error: hoCapsError });
    return;
  }
  if (Date.now() < hoRetryAt) return; // 上次借失败了：这段时间按逐视频滤镜处理
  const target = await hoTarget();
  if (hoWanted(target)) {
    if (!(await nvTxn(hoAcquireLocked))) {
      hoRetryAt = Date.now() + HO_RETRY_MS;
      await hoSetStatus({ active: false, leased: false, error: hoLastError });
      setTimeout(hoSchedule, HO_RETRY_MS + 100);
      return;
    }
  } else {
    await hoRelease(true);
  }
  await hoSetStatus(hoActiveStatus(target, hoLease));
}

// 用户亲手改了全局 HDR：把开关还给用户，这个视频不再借。restore：用户要开时由本地组件写回借用前的值，其他情况不恢复
async function hoDropLocked(restore) {
  const target = await hoTarget();
  hoSuppress = target && target.report ? { tabId: target.tabId, key: target.report.key } : null;
  await hoReleaseLocked(restore === true);
  const s = await getSettings();
  await hoSetStatus(s.hdrOnly && hoCaps ? hoActiveStatus(target, null) : { active: false, leased: false });
}

function hoDrop() {
  return nvTxn(hoDropLocked);
}

chrome.tabs.onActivated.addListener(() => {
  if (settingsCache && settingsCache.hdrOnly) hoSchedule();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  // 焦点离开浏览器（WINDOW_ID_NONE）时保持现状
  if (windowId !== chrome.windows.WINDOW_ID_NONE && settingsCache && settingsCache.hdrOnly) hoSchedule();
});

function nvScheduled(s) {
  return !!(s.nv.nightPresetId || s.nv.dayPresetId);
}

function nvScheduleSig(s) {
  return JSON.stringify([s.night.start, s.night.end, s.nv.nightPresetId, s.nv.dayPresetId]);
}

// 选了时段预设才每分钟叫醒一次 service worker
async function nvSyncAlarm(s) {
  if (nvScheduled(s)) {
    const a = await call(() => chrome.alarms.get(NV_ALARM)).catch(() => null);
    if (!a) await call(() => chrome.alarms.create(NV_ALARM, { periodInMinutes: 1 })).catch(noop);
  } else {
    await call(() => chrome.alarms.clear(NV_ALARM)).catch(noop);
  }
}

// 本地组件的写入错误带 written（已经写入的 id）；空数组说明第一次写入就失败了，什么都没改
function nvNothingWritten(err) {
  return !!err && Array.isArray(err.written) && err.written.length === 0;
}

// nvLastPhase：{phase, id, hdrPending?, fails?}——这个时段套用的是哪个预设、还差什么
function nvPhaseRecord(v) {
  if (!v || typeof v !== 'object' || typeof v.phase !== 'string') return null;
  return {
    phase: v.phase,
    id: typeof v.id === 'string' ? v.id : null,
    hdrPending: v.hdrPending === true,
    fails: Number.isInteger(v.fails) && v.fails > 0 ? v.fails : 0
  };
}

let nvChecking = null;
let nvCheckAgain = false;

// 时段（夜间 / 其余时间）或该时段选的预设变了才套用；套用完后同一时段内不覆盖用户之后的手动修改。
// 记录里带着预设 id：套用途中用户又改了选择，下一轮发现 id 对不上会再套用新的
async function nvScheduleOnce() {
  const s = await getSettings();
  await nvSyncAlarm(s);
  if (!nvScheduled(s)) return;
  const phase = L.nvSchedulePhase(s.night, L.minutesOfDay(Date.now()));
  const id = (phase === 'night' ? s.nv.nightPresetId : s.nv.dayPresetId) || null;
  const r = await chrome.storage.local.get(NV_PHASE_KEY);
  const last = nvPhaseRecord(r && r[NV_PHASE_KEY]);
  const same = !!last && last.phase === phase && last.id === id;
  if (same && !last.hdrPending && !last.fails) return;
  const preset = id ? s.nv.presets.find((p) => p.id === id) : null;
  const rec = { phase: phase, id: id };
  if (preset) {
    // 上次 HDR 不可用、只套用了超分：这次只补 HDR 部分（不再写超分，免得覆盖用户之后改的超分）
    const pending = same && last.hdrPending;
    const res = await nvApplyPreset(preset, pending, 'schedule');
    const code = res.error && res.error.code;
    if (res.ok === true) {
      if (res.hdrSkipped) rec.hdrPending = true; // 每分钟看一次，HDR 可用了再补
    } else if (NV_GIVE_UP.has(code)) {
      // 重试也没用：本时段放弃
    } else if (res.stage === 'set' && !NV_NOT_WRITTEN.has(code) && !nvNothingWritten(res.error)) {
      // 写入阶段出错，可能已经写了一部分：本时段最多试 NV_MAX_WRITE_FAILS 次
      const fails = (same ? last.fails : 0) + 1;
      if (fails < NV_MAX_WRITE_FAILS) {
        rec.fails = fails;
        if (pending) rec.hdrPending = true;
      }
    } else {
      // 什么都没写（没装本地组件、本地组件没响应、HDR 还不可用等）：不记，下一分钟再试
      return;
    }
  }
  // 这个时段没选预设也要记下，下次进入另一个时段时才会套用
  await chrome.storage.local.set({ [NV_PHASE_KEY]: rec });
}

function nvScheduleCheck() {
  if (nvChecking) {
    nvCheckAgain = true;
    return nvChecking;
  }
  nvChecking = (async () => {
    do {
      nvCheckAgain = false;
      await nvScheduleOnce().catch(noop);
    } while (nvCheckAgain);
    nvChecking = null;
  })();
  return nvChecking;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === NV_ALARM) nvScheduleCheck();
  else if (alarm && alarm.name === NV_FOLLOW_ALARM) nvFollowCheck();
});

// 浏览器启动：主题色图标、跟随 SDR 的闹钟、「只关 HDR」的状态（上次的借用在浏览器退出时已由本地组件还掉）
async function onBrowserStart() {
  const s = await getSettings();
  await applyIcon(s.ui.accent);
  await nvSyncFollowAlarm(s);
  hoStatusSig = '';
  hoSchedule();
}

chrome.runtime.onStartup.addListener(() => {
  nvScheduleCheck();
  onBrowserStart().catch(noop);
});

// ---------- 扩展页面的 NVIDIA 请求 ----------

// 写入记录里的来源：面板是 panel，其他扩展页面（弹窗、选项页、诊断页）都算 popup
function nvPageSource(page) {
  return page === 'panel' ? 'panel' : 'popup';
}

// 页面要写的补丁：静态校验（最高亮度的实时范围留给 nvWrite）；带 hdr.enabled 时默认按「用户亲手拨开关」处理借用
function nvPageWrite(payload, mode, page) {
  const v = L.nvValidatePatch(payload, null);
  if (!v.ok) return Promise.resolve({ ok: false, error: v.error });
  const lease = mode === 'suppress' || mode === 'yield' ? mode : nvHasEnabled(v.patch) ? 'suppress' : 'yield';
  return nvWrite({ source: nvPageSource(page), patch: v.patch, lease: lease, commit: v.patch.commit !== false });
}

// 弹窗的兜底通道（弹窗自己的 connectNative 端口不可用时）
function nvHandle(msg, page) {
  if (msg.op === 'hello' || msg.op === 'get' || msg.op === 'display') return hostCall({ cmd: msg.op });
  if (msg.op === 'set') return nvPageWrite(msg.payload, undefined, page);
  return Promise.resolve({ ok: false, error: { code: 'bad-request', message: 'unknown op' } });
}

// {type:'nv-op', op:'set'|'apply-preset'|'undo'|'follow-check'}：经后台的写入服务
async function nvOp(msg, page) {
  if (msg.op === 'set') return nvPageWrite(msg.patch, msg.mode, page);
  if (msg.op === 'apply-preset') {
    const s = await getSettings();
    const preset = typeof msg.id === 'string' && msg.id.length <= 40 ? s.nv.presets.find((p) => p.id === msg.id) : null;
    if (!preset) return { ok: false, error: { code: 'bad-request', message: 'unknown preset' } };
    return nvApplyPreset(preset, false, nvPageSource(page));
  }
  if (msg.op === 'undo') return nvUndo(nvPageSource(page));
  if (msg.op === 'follow-check') {
    await nvFollowCheck();
    return { ok: true };
  }
  return { ok: false, error: { code: 'bad-request', message: 'unknown op' } };
}

// {type:'nv-log', before, after, patch, error?, unconfirmed?}：弹窗和面板在自己端口上的写入，补记进修改记录
async function nvLogFromPage(msg, page) {
  const before = L.nvNormState(msg.before);
  const after = msg.after == null ? null : L.nvNormState(msg.after);
  const v = L.nvValidatePatch(msg.patch, null);
  if (!before || (msg.after != null && !after) || !v.ok) return { ok: false, code: 'bad-request' };
  const e = msg.error;
  const error = e && typeof e === 'object' && typeof e.code === 'string' && e.code ? e : null;
  const logId = await nvLogWrite({
    source: nvPageSource(page), before: before, after: error ? null : after, patch: v.patch,
    error: error, unconfirmed: !error && msg.unconfirmed === true
  });
  return { ok: true, logId: logId };
}

// ---------- 消息 ----------

// 扩展自己的页面 → 'popup' | 'options' | 'diag' | 'panel'；其他（内容脚本、网页）→ ''。
// 面板是嵌在网页里的扩展 iframe（use_dynamic_url，主机名是动态的）：网页也能自己嵌一份，所以还要求它所在的
// (tabId, frameId) 已由内容脚本握手登记（panelFrames），文档仍是活动的；其他页面带 tab 时（选项页、诊断页）必须是顶层 frame
function fromExtensionPage(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return '';
    const u = new URL(sender.url);
    if (u.protocol !== 'chrome-extension:' || EXT_PAGES.indexOf(u.pathname) < 0) return '';
    if (u.pathname === '/panel.html') {
      const frames = sender.tab && validTabId(sender.tab.id) ? panelFrames.get(sender.tab.id) : null;
      const life = sender.documentLifecycle;
      if (!frames || !frames.has(sender.frameId) || (typeof life === 'string' && life !== 'active')) return '';
    } else if (sender.tab && sender.frameId !== 0) {
      return '';
    }
    return u.pathname.slice(1, -'.html'.length);
  } catch (e) {
    return '';
  }
}

const internalError = (e) => ({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !sender || sender.id !== chrome.runtime.id) return false;

  if (msg.type === 'report') {
    if (!sender.tab) {
      sendResponse({ ok: true });
      return false;
    }
    handleReport(msg, sender).then(
      (r) => sendResponse(Object.assign({ ok: true }, r)),
      () => sendResponse({ ok: true })
    );
    return true;
  }

  const page = fromExtensionPage(sender);

  if (msg.type === 'settings-patch') {
    handleSettingsPatch(msg, sender, page).then(sendResponse, () => sendResponse({ ok: false, code: 'internal' }));
    return true;
  }

  if (msg.type === 'popup-get' && page) {
    // 面板只能查自己所在的标签页
    if (!validTabId(msg.tabId) || (page === 'panel' && msg.tabId !== sender.tab.id)) {
      sendResponse({ frameId: null });
      return false;
    }
    getTab(msg.tabId)
      .then((t) => {
        const best = bestFrame(t);
        sendResponse(best ? { frameId: best.frameId, report: best.report } : { frameId: null });
      })
      .catch(() => sendResponse({ frameId: null }));
    return true;
  }

  if (msg.type === 'nv' && page) {
    if (page === 'panel' && !PANEL_NV_CMDS.has(msg.op)) {
      sendResponse({ ok: false, error: { code: 'bad-request', message: 'unknown op' } });
      return false;
    }
    nvHandle(msg, page).then(sendResponse, (e) => sendResponse(L.nvPortError((e && e.message) || 'error')));
    return true;
  }

  if (msg.type === 'nv-op' && page) {
    if (page === 'panel' && (!PANEL_NV_OPS.has(msg.op) || !patchRateOk(sender.tab.id))) {
      sendResponse({ ok: false, error: { code: PANEL_NV_OPS.has(msg.op) ? 'busy' : 'bad-request' } });
      return false;
    }
    nvOp(msg, page).then(sendResponse, (e) => sendResponse(internalError(e)));
    return true;
  }

  if (msg.type === 'nv-log' && (page === 'popup' || (page === 'panel' && patchRateOk(sender.tab.id)))) {
    nvLogFromPage(msg, page).then(sendResponse, (e) => sendResponse(internalError(e)));
    return true;
  }

  if (msg.type === 'hdr-only' && msg.op === 'drop' && page && page !== 'panel') {
    hoDrop().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

// ---------- 安装 / 更新 ----------

// 补齐缺失字段，保留已有的合法设置
function initSettings() {
  return settingsTxn((cur) => cur);
}

// 安装前已打开的页面没有内容脚本，主动注入一次（content.js 自带防重复；扩展重新加载后由新实例接管旧实例）
async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => {
    if (!validTabId(t.id) || t.discarded) return null;
    return call(() => chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true },
      files: ['i18n.js', 'lib.js', 'content.js']
    })).catch(noop);
  }));
}

chrome.runtime.onInstalled.addListener((details) => {
  initSettings().catch(noop).then(nvScheduleCheck).then(() => onBrowserStart()).catch(noop);
  const reason = details && details.reason;
  if (reason === 'install' || reason === 'update') injectOpenTabs().catch(noop);
});

// ---------- tab 生命周期 ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  if (settingsCache && settingsCache.hdrOnly) hoSchedule();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => forgetTab(removedTabId));

// 整页导航时 Chrome 会清掉该 tab 的角标，缓存也要作废
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') badgeSig.delete(tabId);
});
