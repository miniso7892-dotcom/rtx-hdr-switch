/*
 * RTX HDR 开关 —— service worker（经典脚本）。
 * 记录每个 tab 各 frame 的报告，选出最佳 frame 设置角标、转发快捷键和弹窗请求；
 * 汇总各标签页上报的观看时间做「连续观看提醒」。
 */
'use strict';

importScripts('lib.js');
const L = self.RtxHdrLib;

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
const BADGE = {
  on: { text: 'HDR', color: '#2e7d32' },
  off: { text: 'SDR', color: '#616161' },
  // DRM 视频扩展管不了：不显示 HDR/SDR，免得和实际情况相反
  drm: { text: 'DRM', color: '#8d6e00' }
};

const tabState = new Map(); // tabId → {frames: {frameId: report}, topDoc}
const tabLoads = new Map(); // tabId → 正在从 storage.session 恢复的 Promise
const badgeSig = new Map();
const persistTimers = new Map();
const recheckTimers = new Map();

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
  return eyeReply;
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

function badgeFor(report) {
  if (!report) return null;
  if (report.drm) return BADGE.drm;
  return BADGE[report.state] || null;
}

async function refreshBadge(tabId, t) {
  const best = bestFrame(t);
  scheduleRecheck(tabId, best);
  const b = badgeFor(best && best.report);
  const text = b ? b.text : '';
  if (badgeSig.get(tabId) === text) return;
  badgeSig.set(tabId, text);
  const a = chrome.action;
  const jobs = [call(() => a.setBadgeText({ tabId, text }))];
  if (b) {
    jobs.push(call(() => a.setBadgeBackgroundColor({ tabId, color: b.color })));
    jobs.push(call(() => a.setBadgeTextColor({ tabId, color: '#ffffff' })));
  }
  const results = await Promise.allSettled(jobs);
  // tab 已关闭等原因失败时，下次报告再试
  if (results.some((r) => r.status === 'rejected') && badgeSig.get(tabId) === text) badgeSig.delete(tabId);
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
    settingsCache = L.mergeSettings(changes.settings.newValue);
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

async function toggleAutoInStorage() {
  const r = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: L.toggleAutoMode(r && r.settings) });
}

async function handleCommand(command, tab) {
  if (!tab || !validTabId(tab.id)) tab = await activeTab();
  if (!tab || !validTabId(tab.id)) return;
  const best = bestFrame(await getTab(tab.id));
  const frames = best && best.frameId !== 0 ? [best.frameId, 0] : [0];
  const msg = { type: 'command', command: command };
  for (const frameId of frames) {
    try {
      await chrome.tabs.sendMessage(tab.id, msg, { frameId: frameId });
      return;
    } catch (e) {
      // chrome:// 页面、内容脚本未注入或 frame 已不存在：试下一个
    }
  }
  // 页面上没有内容脚本时，「开/关 自动检测」仍然可以直接改设置
  if (command === 'toggle-auto') await toggleAutoInStorage().catch(noop);
}

chrome.commands.onCommand.addListener((command, tab) => {
  handleCommand(command, tab).catch(noop);
});

// ---------- 消息 ----------

function fromExtensionPage(sender) {
  try {
    return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  } catch (e) {
    return false;
  }
}

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

  if (msg.type === 'popup-get' && fromExtensionPage(sender)) {
    if (!validTabId(msg.tabId)) {
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
  return false;
});

// ---------- 安装 / 更新 ----------

async function initSettings() {
  const r = await chrome.storage.local.get('settings');
  const cur = r && r.settings;
  const merged = L.mergeSettings(cur); // 补齐缺失字段，保留已有的合法设置
  if (JSON.stringify(cur) !== JSON.stringify(merged)) await chrome.storage.local.set({ settings: merged });
}

// 安装前已打开的页面没有内容脚本，主动注入一次（content.js 自带防重复；扩展重新加载后由新实例接管旧实例）
async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => {
    if (!validTabId(t.id) || t.discarded) return null;
    return call(() => chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true },
      files: ['lib.js', 'content.js']
    })).catch(noop);
  }));
}

chrome.runtime.onInstalled.addListener((details) => {
  initSettings().catch(noop);
  const reason = details && details.reason;
  if (reason === 'install' || reason === 'update') injectOpenTabs().catch(noop);
});

// ---------- tab 生命周期 ----------

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => forgetTab(removedTabId));

// 整页导航时 Chrome 会清掉该 tab 的角标，缓存也要作废
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === 'loading') badgeSig.delete(tabId);
});
