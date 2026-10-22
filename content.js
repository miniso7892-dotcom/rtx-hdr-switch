/*
 * RTX HDR 开关 —— 内容脚本（所有 frame，document_start）。
 * 关闭 = 在 <video> 自身加内联 filter:brightness(0.9999) !important（页面已有内联 filter 时叠加在它后面），
 * 让 Chrome 不再把视频提升为 DirectComposition overlay，从而绕开 NVIDIA 视频处理器；开启 = 还原页面原来的内联 filter。
 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  let runtime = null;
  try { runtime = chrome.runtime; } catch (e) { /* 不在扩展环境 */ }
  if (!L || !runtime || !runtime.id) return;

  // 同一个 isolated world 里重复注入：同一实例直接返回；旧实例（runtime 不同）把视频交给新实例接管
  const prev = window.__rtxHdrSwitchLoaded;
  if (prev) {
    if (typeof prev !== 'object' || prev.runtime === runtime) return;
    try { prev.destroy('keep'); } catch (e) { /* ignore */ }
  }

  const OFF_FILTER = L.OFF_FILTER;
  // 扩展重新加载后新实例在新的 isolated world 里，看不到旧实例的 window 属性；DOM 事件可以跨 world
  const TAKEOVER_EVENT = 'rtxhdrswitch-takeover';
  // 每个实例的标记，写在 video 的 data-rtxhdr-owner 上：失效的旧实例只还原仍归自己管的视频
  const TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const VIDEO_EVENTS = ['play', 'playing', 'pause', 'loadstart', 'emptied', 'loadedmetadata', 'resize',
    'enterpictureinpicture', 'leavepictureinpicture'];
  const TICK_MS = 1000;
  const SCAN_EVERY_TICKS = 2;
  const SAMPLE_MS = 1500;
  const HEARTBEAT_MS = 3000;
  const OSD_MS = 1600;
  const EYE_OSD_MS = 6000;
  const ORPHAN_RESTORE_MS = 5000;
  // 页面改写 style 冲掉滤镜时：20 ms 内被改回超过 6 次（页面在跟我们互相改）或 1 秒超过 120 次就让步
  const FIGHT_WINDOW_MS = 20;
  const FIGHT_BURST = 6;
  const FIGHT_PER_SEC = 120;
  const CONTEST_RETRY_MS = 10000;
  const IO_THRESHOLDS = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1];
  const SAMPLE_W = 64;
  const SAMPLE_H = 36;
  const EYE_OFF = Object.freeze({ state: 'off', reason: 'eye' });
  // 只有这些元素（以及自定义元素）能挂 shadow root
  const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span']);
  // 这些元素的子节点不会被渲染，全屏时不能把 OSD 挂进去
  const NO_CHILD_RENDER = new Set(['video', 'audio', 'iframe', 'frame', 'canvas', 'img', 'embed', 'object',
    'input', 'textarea', 'select', 'picture']);
  // 屏幕提示：C 风格的黑底白字方块，左边一个主题色小方块（放在 closed shadow root 里）
  const OSD_CSS = 'all:initial !important;position:fixed !important;z-index:2147483647 !important;' +
    'pointer-events:none !important;display:block !important;box-sizing:border-box !important;' +
    'margin:0 !important;padding:7px 12px !important;' +
    'border-radius:0 !important;background:rgba(10,10,10,.9) !important;color:#FAFAFA !important;' +
    'font:700 14px/1.45 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif !important;' +
    'letter-spacing:.02em !important;overflow:hidden !important;' +
    'box-shadow:0 0 0 2px rgba(250,250,250,.14),0 4px 14px rgba(0,0,0,.4) !important;transition:none !important;';
  const OSD_INNER_CSS = ':host{all:initial}.m{display:inline-block;width:9px;height:9px;margin:0 9px 1px 0;vertical-align:middle}' +
    '.t{font:inherit;color:inherit}' +
    '.b{display:block;margin:6px 0 0 18px;padding:3px 8px;border:0;border-radius:0;background:#FAFAFA;color:#0A0A0A;' +
    'font:700 12px/1.45 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;cursor:pointer;text-align:left}' +
    '.b:focus-visible{outline:2px solid #FAFAFA;outline-offset:2px}';
  // 按住对比的小标记（紧凑）。所有提示都盖在视频上：不用透明度过渡，隐藏时立即移除
  const OSD_PEEK_CSS = 'padding:4px 8px !important;font-size:12px !important;';
  // 提议「本标签页后续视频沿用」的提示显示多久；peek 命令开始后多久内重复到达的命令忽略（按键自动重复）
  const OFFER_MS = 4000;
  const PEEK_REPEAT_MS = 500;
  // 收到 fs-hint 推送后这么久内，报告回复里的 topFs 和它不一致时不信（回复可能是推送之前算的）
  const FS_HINT_TRUST_MS = 1500;
  // background 写的「只关 HDR」状态：{active: 用全局开关代替逐视频滤镜, leased, error?}
  const HDR_ONLY_KEY = 'hdrOnlyStatus';

  const isTop = (() => { try { return window.top === window; } catch (e) { return false; } })();
  const openOrClosedShadowRoot = (() => {
    try {
      const dom = chrome.dom;
      return dom && typeof dom.openOrClosedShadowRoot === 'function' ? dom.openOrClosedShadowRoot.bind(dom) : null;
    } catch (e) { return null; }
  })();

  let settings = L.mergeSettings(null);
  let settingsReady = false;
  let uiLanguage = '';
  try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = navigator.language || ''; }
  let lang = 'zh';
  let hdrOnly = false; // 「只关 HDR」对本 frame 生效：想关的主视频不加滤镜，由 background 关掉全局 HDR
  let hdrOnlyStatus = null; // background 写的 {active, leased, tabId, frameId}
  let selfTab = -1; // 本 frame 所在的标签页和 frame，background 回复报告时告诉我们
  let selfFrame = -1;
  let settingsTouched = false;
  let eyeRestAt = 0; // 护眼 SDR 开始的时间（0 = 没有）
  let eyeRestTouched = false;
  let hdrOnlyTouched = false;
  let destroyed = false;
  let quietNext = false;

  const videos = new Set();
  const infos = new WeakMap();
  const savedRules = new Map(); // key → {s,t} | null（已从 storage 读出）
  const loadingKeys = new Set();
  const brightKeys = new Set(); // 本页面会话内自动检测判定为白底的视频 key
  const observedRoots = new WeakSet();
  const noClosedShadow = new WeakSet();

  let lastHref = '';
  let pageKey = '';
  let hostname = '';
  let topHostname = '';
  let primary = null;
  let pipVideo = null;
  let offscreenCount = 0;
  let evalTimer = 0;
  let tickTimer = 0;
  let sampleTimer = 0;
  let restoreTimer = 0;
  let tickCount = 0;
  let lastTickAt = 0;
  let lastSampleAt = 0;
  let canvas = null;
  let ctx2d = null;
  const eyePending = { hdr: 0, watch: 0 }; // 还没报给 background 的观看时间
  let lastSig = '';
  let lastReportAt = 0;
  let everReported = false;
  let osdEl = null;
  let osdText = null; // 放文字的节点（closed shadow root 里的 span；不支持 shadow root 时就是 osdEl 本身）
  let osdMark = null;
  let osdBtn = null;  // 提议「本标签页沿用」时显示的按钮（closed shadow root 里）
  let osdKind = '';   // 当前提示的种类：'' 普通，'peek' 对比标记，'offer' 带按钮的提议
  let osdOffer = '';  // 提议里按钮对应的状态
  let osdHideTimer = 0;
  // 按住对比：{video, key, base 决策状态, state 显示状态, source 'button'|'key'|'panel'|'command', at, timer}
  let peek = null;
  // 本标签页沿用：{state, at}；只在内存里，跟着当前文档走（刷新、整页导航后失效）
  let tabSticky = null;
  let lastManual = null; // 上一次对主视频的手动切换 {key, state}
  const tabNotified = new Set(); // 由沿用决定时已经提示过的视频 key
  let fsElNow = null;     // 本 frame 的全屏元素（沿 shadow 往下找到的），evaluate 和 fullscreenchange 时更新
  let topFsHint = false;  // 子 frame：父页面把本 frame 所在的 iframe 设为了全屏（background 转发）
  let fsHintAt = 0;       // 上一次收到 fs-hint 推送的时间

  function noop() {}

  // 页面环境千奇百怪：所有回调都包一层，异常不外抛、不打日志
  function guard(fn) {
    return function () {
      if (destroyed) return undefined;
      try { return fn.apply(this, arguments); } catch (e) { return undefined; }
    };
  }

  function storageCall(fn) {
    try { return Promise.resolve(fn()).catch(noop); } catch (e) { return Promise.resolve(); }
  }

  function updateLang() {
    const i18n = globalThis.RtxHdrI18n;
    lang = i18n ? i18n.resolve(settings.ui.lang, uiLanguage) : 'zh';
  }

  function infoOf(v) {
    let i = infos.get(v);
    if (!i) {
      i = {
        key: pageKey, src: '',          // 元素当前媒体所属的视频 key 和它的 currentSrc
        manual: null, manualKey: null, manualAt: 0, // 手动状态，仅对所属 key 有效
        ownerKey: null,                 // 当过主视频的 key：享有按视频记忆和自动检测结果
        detector: null, detectorKey: null, detectorCfg: '',
        decision: null, decisionKey: null, eff: null, // eff：实际生效的状态（DRM、被页面改回时为 on）
        last: null, unknown: null,
        area: 0, ioArea: null, offscreen: false, playing: false,
        fightAt: 0, fights: 0, secAt: 0, secFights: 0,
        contested: 0, contestCount: 0, contestNotified: false
      };
      infos.set(v, i);
    }
    return i;
  }

  function keyOf(info) {
    return info.key || pageKey;
  }

  function currentSrcOf(v) {
    try { return v.currentSrc || ''; } catch (e) { return ''; }
  }

  function isPlaying(v) {
    return !v.paused && !v.ended && v.readyState >= 2;
  }

  // ---------- 页面 URL / key ----------

  function effectiveUrl() {
    const href = location.href;
    if (!/^(about|blob|data|javascript):/i.test(href)) return href;
    try {
      const p = window.parent.location.href;
      if (p && !/^about:/i.test(p)) return p;
    } catch (e) { /* 跨源父页面 */ }
    return document.referrer || href;
  }

  function computeTopHost(own) {
    if (isTop) return own;
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return L.hostOf(ao[ao.length - 1]);
    } catch (e) { /* ignore */ }
    return '';
  }

  // 迷你播放器（YouTube 小窗、Twitch 迷你播放器）：从视频页跳到非视频页（新 key 是兜底的 u:）时，
  // 仍在播放同一媒体的元素保留原来的视频 key 以及它的手动状态、记忆和自动检测结果
  function keepsKey(v, i, newKey) {
    return !!i.key && i.key.indexOf('u:') !== 0 && newKey.indexOf('u:') === 0 &&
      !!i.src && currentSrcOf(v) === i.src;
  }

  // 新媒体：检测器计数、采样结果、与页面争夺样式的状态都重来（白底结论按 key 记在 brightKeys 里，不丢）
  function resetMedia(i) {
    i.detector = null;
    i.last = null;
    i.unknown = null;
    i.contested = 0;
    i.contestCount = 0;
    i.contestNotified = false;
    i.fights = 0;
    i.secFights = 0;
  }

  function rekey(v, i, key) {
    i.key = key;
    i.src = currentSrcOf(v);
    i.manual = null;
    i.manualKey = null;
    i.manualAt = 0;
    i.ownerKey = null;
    resetMedia(i);
  }

  function checkUrl() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    btnSite = L.playerSite(location.hostname, location.pathname) || '';
    const url = effectiveUrl();
    hostname = L.hostOf(url);
    topHostname = computeTopHost(hostname);
    const key = L.videoKey(url);
    if (key === pageKey) return;
    pageKey = key;
    for (const v of videos) {
      const i = infoOf(v);
      if (!keepsKey(v, i, key)) rekey(v, i, key);
    }
    if (savedRules.size > 300) savedRules.clear(); // 被清掉的 key 用到时会重新读
    loadRule(key);
    scheduleEvaluate();
  }

  function loadRule(key) {
    if (!key || savedRules.has(key) || loadingKeys.has(key)) return;
    loadingKeys.add(key);
    const id = L.VIDEO_PREFIX + key;
    storageCall(() => chrome.storage.local.get(id).then((r) => {
      if (!savedRules.has(key)) savedRules.set(key, L.validRule(r && r[id]));
    })).then(() => {
      if (!savedRules.has(key)) savedRules.set(key, null);
      loadingKeys.delete(key);
      scheduleEvaluate();
    });
  }

  // ---------- 发现视频 ----------

  const domObserver = new MutationObserver(guard(onDomMutations));
  const styleObserver = new MutationObserver(guard(onStyleMutations));
  const onVideoEvent = guard(function (e) {
    if (e.type === 'loadstart') {
      const v = e.currentTarget;
      const i = infoOf(v);
      if (i.key !== pageKey) {
        rekey(v, i, pageKey);
      } else {
        i.src = currentSrcOf(v);
        resetMedia(i);
      }
    }
    scheduleEvaluate();
  });

  // 子 frame 用 IntersectionObserver 判断视频在顶层视口里是否真的可见（含父页面滚动、裁剪）
  const onIntersect = guard(function (entries) {
    for (const e of entries) {
      const r = e.intersectionRect;
      infoOf(e.target).ioArea = e.isIntersecting && r ? r.width * r.height : 0;
    }
    scheduleEvaluate();
  });
  let io = null;
  if (!isTop) {
    try { io = new IntersectionObserver(onIntersect, { threshold: IO_THRESHOLDS }); } catch (e) { io = null; }
  }

  function register(v) {
    if (destroyed || videos.has(v) || !(v instanceof HTMLVideoElement)) return;
    videos.add(v);
    const i = infoOf(v);
    if (i.key !== pageKey && !keepsKey(v, i, pageKey)) rekey(v, i, pageKey);
    else if (!i.src) i.src = currentSrcOf(v);
    for (const t of VIDEO_EVENTS) v.addEventListener(t, onVideoEvent);
    try { styleObserver.observe(v, { attributes: true, attributeFilter: ['style'] }); } catch (e) { /* ignore */ }
    if (io) { try { io.observe(v); } catch (e) { /* ignore */ } }
    scheduleEvaluate();
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    try { domObserver.observe(root, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
  }

  function shadowRootOf(el) {
    const open = el.shadowRoot;
    if (open) return open;
    const name = el.localName;
    const custom = name.indexOf('-') > 0;
    if (!openOrClosedShadowRoot || (!custom && !SHADOW_HOSTS.has(name)) || noClosedShadow.has(el)) return null;
    let sr = null;
    try { sr = openOrClosedShadowRoot(el); } catch (e) { sr = null; }
    if (!sr) {
      // 未升级的自定义元素之后还可能挂上 shadow root，暂不缓存
      let defined = true;
      if (custom) { try { defined = el.matches(':defined'); } catch (e) { defined = true; } }
      if (defined) noClosedShadow.add(el);
    }
    return sr;
  }

  // document.fullscreenElement / pictureInPictureElement 会被重定向到 shadow host，沿 shadow 树往下找到真正的元素
  function deepElement(prop) {
    let el = null;
    try { el = document[prop] || null; } catch (e) { return null; }
    for (let n = 0; el && n < 32; n++) {
      const sr = shadowRootOf(el);
      let inner = null;
      try { inner = sr ? sr[prop] : null; } catch (e) { inner = null; }
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function scan(root) {
    const list = root.querySelectorAll('video');
    for (let i = 0; i < list.length; i++) register(list[i]);
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const sr = shadowRootOf(all[i]);
      if (sr) {
        observeRoot(sr);
        scan(sr);
      }
    }
  }

  function fullScan() {
    if (document.documentElement) scan(document);
  }

  function onDomMutations(records) {
    // 控制栏被网站重建、按钮跟着没了：下一帧重新放（只看一次 isConnected，不另外观察）
    if (pbtn && !btnRaf && !pbtn.el.isConnected) btnRaf = requestAnimationFrame(onBtnLost);
    let removed = false;
    for (let r = 0; r < records.length; r++) {
      const rec = records[r];
      if (rec.removedNodes.length) removed = true;
      const added = rec.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const n = added[i];
        if (n.nodeType !== 1) continue;
        if (n.localName === 'video') {
          register(n);
        } else if (n.firstElementChild && !isOwnNode(n)) { // 我们自己插入的按钮、提示里没有视频
          const list = n.getElementsByTagName('video');
          for (let j = 0; j < list.length; j++) register(list[j]);
        }
      }
    }
    if (removed && videos.size) {
      for (const v of videos) {
        if (!v.isConnected) { scheduleEvaluate(); break; }
      }
    }
  }

  // ---------- 应用状态 ----------

  function isOurs(style) {
    return L.isOffFilter(style.getPropertyValue('filter')) && style.getPropertyPriority('filter') === 'important';
  }

  // raw：按 want 原样加或去滤镜（对比、页面冲掉滤镜后补回），不做「只关 HDR」的替换
  function applyState(v, want, raw) {
    const st = v.style;
    const ds = v.dataset;
    if (!st || !ds) return;
    // 「只关 HDR」模式：主视频仍走 overlay（超分保留），HDR 由 background 关掉全局开关来关
    const state = want === 'off' && !raw && hdrOnly && v === primary ? 'on' : want;
    if (state === 'off') {
      if (!isOurs(st)) {
        const orig = st.getPropertyValue('filter');
        ds.rtxhdrOrigFilter = orig;
        if (st.getPropertyPriority('filter') === 'important') ds.rtxhdrOrigImportant = '1';
        else if ('rtxhdrOrigImportant' in ds) delete ds.rtxhdrOrigImportant;
        // 页面自己的滤镜保留，我们的叠加在后面
        st.setProperty('filter', L.offFilterFor(orig), 'important');
        // 叠加后的值浏览器不接受时退回只用我们自己的滤镜
        if (!isOurs(st)) st.setProperty('filter', OFF_FILTER, 'important');
      }
    } else {
      if (isOurs(st)) {
        const orig = ds.rtxhdrOrigFilter || '';
        if (orig) st.setProperty('filter', orig, ds.rtxhdrOrigImportant ? 'important' : '');
        else st.removeProperty('filter');
      }
      if ('rtxhdrOrigFilter' in ds) delete ds.rtxhdrOrigFilter;
      if ('rtxhdrOrigImportant' in ds) delete ds.rtxhdrOrigImportant;
    }
    if (ds.rtxhdr !== state) ds.rtxhdr = state;
    if (ds.rtxhdrOwner !== TOKEN) ds.rtxhdrOwner = TOKEN;
  }

  // 页面改写了 video 的 style 把我们的滤镜冲掉时立刻重新加上（MutationObserver 在下一次绘制前执行，
  // 逐帧改 style 的播放器也不会闪）。页面反过来监听并改回（互相触发）时让步，标记为 contested。
  function onStyleMutations(records) {
    const now = Date.now();
    for (const rec of records) {
      const v = rec.target;
      if (!videos.has(v) || v.dataset.rtxhdr !== 'off' || isOurs(v.style)) continue;
      const info = infoOf(v);
      if (info.contested) continue;
      if (now - info.fightAt > FIGHT_WINDOW_MS) {
        info.fightAt = now;
        info.fights = 0;
      }
      if (now - info.secAt > 1000) {
        info.secAt = now;
        info.secFights = 0;
      }
      if (++info.fights > FIGHT_BURST || ++info.secFights > FIGHT_PER_SEC) {
        setContested(v, info, now);
        continue;
      }
      // data-rtxhdr 为 off 的视频一定是加了滤镜的（对比时「只关 HDR」的主视频也可能是）
      applyState(v, 'off', true);
    }
  }

  function setContested(v, info, now) {
    info.contested = now;
    info.contestCount++;
    scheduleEvaluate();
    if (v === primary && !info.contestNotified) {
      info.contestNotified = true;
      showOsd(L.t(lang, 'content.contested'), OSD_MS, v, false);
    }
  }

  // 让步后隔一段时间再试一次，失败次数越多隔得越久（10 秒起，最长约 5 分钟）
  function contestExpired(info, now) {
    return now - info.contested > CONTEST_RETRY_MS * Math.pow(2, Math.min(Math.max(info.contestCount - 1, 0), 5));
  }

  function visibleArea(v, info, vw, vh) {
    info.offscreen = false;
    const r = v.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return 0;
    // 新旧两套选项名都传（Chrome 121 前叫 checkOpacity / checkVisibilityCSS）
    if (typeof v.checkVisibility === 'function' && !v.checkVisibility({
      visibilityProperty: true, opacityProperty: true, checkVisibilityCSS: true, checkOpacity: true
    })) return 0;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    let area = w > 0 && h > 0 ? w * h : 0;
    if (info.ioArea !== null && info.ioArea < area) area = info.ioArea;
    if (!(area > 0)) {
      info.offscreen = true; // 有尺寸、没被隐藏，只是不在视口里
      return 0;
    }
    return area;
  }

  function autoCfg() {
    return settings.sensitivity + '|' + settings.autoDetect;
  }

  // 视频 key、灵敏度或模式变化时重建检测器；本页面会话里已判定为白底的 key 直接从 off 开始
  function detectorFor(info) {
    const key = keyOf(info);
    const cfg = autoCfg();
    if (!info.detector || info.detectorKey !== key || info.detectorCfg !== cfg) {
      info.detector = L.createAutoDetector(settings.sensitivity, settings.autoDetect, brightKeys.has(key) ? 'off' : 'on');
      info.detectorKey = key;
      info.detectorCfg = cfg;
    }
    return info.detector;
  }

  // 返回 null 表示此视频的记忆还没读出来，先不动它
  function decideFor(v, info, skipAuto) {
    const key = keyOf(info);
    const owner = info.ownerKey === key;
    let manual = info.manualKey === key ? info.manual : null;
    // 护眼 SDR 作用于主视频；在它之后的手动切换优先
    if (eyeRestAt && v === primary && !(manual && info.manualAt > eyeRestAt)) manual = EYE_OFF;
    // 本标签页沿用压过视频记忆：不用等记忆读出来（仍然预读），换视频时不会先闪一下
    const tab = owner && tabSticky ? tabSticky.state : null;
    if (owner && !manual && !savedRules.has(key)) {
      loadRule(key);
      if (!tab) return null;
    }
    const det = owner && !skipAuto && settings.autoDetect !== 'off' ? detectorFor(info) : null;
    return L.decide({
      settings: settings,
      hostname: hostname,
      topHostname: topHostname,
      manual: manual,
      tab: tab,
      saved: owner ? savedRules.get(key) : null,
      fullscreen: v === primary && isFullscreenFor(v),
      autoState: det ? det.state : null
    });
  }

  // ---------- 全屏判定（「仅全屏时开启 HDR」） ----------

  // node 在 root 里面吗（遇到 shadow root 跳到它的 host）
  function containsDeep(root, node) {
    for (let n = node, i = 0; n && i < 4096; i++) {
      if (n === root) return true;
      const p = n.parentNode;
      n = p && p.nodeType === 11 && p.host ? p.host : p;
    }
    return false;
  }

  // 本 frame 的视口不小于屏幕的 1/4：父页面「关」的通知丢了时，小尺寸的嵌入不会一直被当成全屏
  function frameFillsScreen() {
    let sw = 0, sh = 0;
    try { sw = screen.width; sh = screen.height; } catch (e) { return true; }
    return !(sw > 0 && sh > 0) || window.innerWidth * window.innerHeight * 4 >= sw * sh;
  }

  // 主视频是否算在全屏里：本 frame 的全屏元素包含它；父页面把本 frame 设为全屏；网页全屏（设置允许时）。
  // 画中画和 F11 浏览器全屏都不算
  function isFullscreenFor(v) {
    if (fsElNow) return containsDeep(fsElNow, v);
    if (!isTop && topFsHint && frameFillsScreen()) return true;
    const site = btnSite ? PLAYER_BARS[btnSite] : null;
    if (!settings.fullscreenWeb || !site || !site.webFull) return false;
    try { return !!v.closest(site.webFull); } catch (e) { return false; }
  }

  // 顶层 frame：全屏的是别的东西（iframe 本身，或里面有个占视口一半以上的 iframe），不是顶层自己的主视频。
  // background 据此通知那个子 frame（fs-hint）
  function fsFrameNow() {
    const fs = fsElNow;
    if (!fs || (primary && containsDeep(fs, primary))) return false;
    if (fs.localName === 'iframe' || fs.localName === 'frame') return true;
    const half = window.innerWidth * window.innerHeight / 2;
    let list = null;
    try { list = fs.querySelectorAll('iframe,frame'); } catch (e) { return false; }
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (r.width * r.height >= half) return true;
    }
    return false;
  }

  function setTopFsHint(on) {
    if (isTop || on === topFsHint) return;
    topFsHint = on;
    // 全屏时 iframe 的视口跟着变大：1/4 屏幕的检查要重新算
    try {
      if (on) window.addEventListener('resize', onFsResize);
      else window.removeEventListener('resize', onFsResize);
    } catch (e) { /* ignore */ }
    scheduleEvaluate();
  }

  const onFsResize = guard(function () { scheduleEvaluate(); });

  function scheduleEvaluate() {
    if (destroyed || evalTimer) return;
    evalTimer = setTimeout(evaluateSoon, 50);
  }

  const evaluateSoon = guard(function () {
    evalTimer = 0;
    evaluate(false);
  });

  // quiet：调用方自己会显示 OSD（手动切换、护眼提醒等），这里不再提示状态变化
  function evaluate(quiet) {
    if (evalTimer) {
      clearTimeout(evalTimer);
      evalTimer = 0;
    }
    if (destroyed || !settingsReady) return;
    if (quietNext) {
      quiet = true;
      quietNext = false;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    fsElNow = deepElement('fullscreenElement');
    const pip = deepElement('pictureInPictureElement');
    const list = [];
    const cands = [];
    let offscreen = 0;
    pipVideo = null;
    for (const v of videos) {
      if (!v.isConnected) {
        videos.delete(v);
        continue;
      }
      const info = infoOf(v);
      info.playing = isPlaying(v);
      info.area = visibleArea(v, info, vw, vh);
      if (v === pip) {
        // 画中画：页面里滚出去了也是用户正在看的视频
        pipVideo = v;
        info.offscreen = false;
        info.area = Math.max(info.area, vw * vh, 1);
      }
      if (info.offscreen) offscreen++;
      list.push(v);
      cands.push({ area: info.area, playing: info.playing });
    }
    offscreenCount = offscreen;
    const idx = pipVideo ? list.indexOf(pipVideo) : L.pickPrimary(cands);
    primary = idx >= 0 ? list[idx] : null;
    if (primary) {
      const pi = infoOf(primary);
      pi.ownerKey = keyOf(pi);
    }

    // 对比中的视频被移除了：对比结束（它不在 list 里，下面不会再看到它）
    if (peek && !videos.has(peek.video)) peekClear();

    const now = Date.now();
    for (const v of list) {
      const info = infoOf(v);
      const d = decideFor(v, info, false);
      if (!d) continue;
      const key = keyOf(info);
      // DRM 视频走 MediaFoundation overlay，CSS 管不了：不加滤镜、不提示，只如实上报
      const drm = !!v.mediaKeys;
      if (info.contested && contestExpired(info, now)) {
        info.contested = 0;
        info.fights = 0;
        info.secFights = 0;
      }
      const want = drm ? 'on' : d.state;
      // 对比只改显示：主视频、视频 key、决策状态都没变时按对比的状态加或去滤镜，否则对比就地结束。
      // info.eff、报告、角标、护眼计时、「只关 HDR」的借用都仍按决策状态
      let shown = want;
      if (peek && peek.video === v) {
        if (v === primary && key === peek.key && want === peek.base && !drm && !(peek.state === 'off' && info.contested)) shown = peek.state;
        else peekClear();
      }
      if (shown !== 'off' || !info.contested) applyState(v, shown, shown !== want);
      const eff = want === 'off' && info.contested ? 'on' : want;
      const prevEff = info.decisionKey === key ? info.eff : null;
      info.decision = d;
      info.decisionKey = key;
      info.eff = eff;
      if (v === primary && !quiet && !drm && !info.contested) {
        if (prevEff && prevEff !== eff) {
          showOsd(L.osdText(eff, d.reason, lang), OSD_MS, v, false);
        } else if (!prevEff && d.reason === 'tab' && !tabNotified.has(key)) {
          // 新视频由「本标签页沿用」决定：每个视频提示一次
          tabNotify(key);
          showOsd(L.osdText(eff, 'tab', lang), OSD_MS, v, false);
        }
      }
    }
    updateSampler();
    report(false);
    syncButton();
  }

  // ---------- 自动检测采样 ----------

  function wantSampling() {
    const v = primary;
    if (!v || document.hidden || settings.autoDetect === 'off') return false;
    const info = infoOf(v);
    if (!info.playing || info.unknown || info.ownerKey !== keyOf(info)) return false;
    if (v.mediaKeys) {
      info.unknown = 'drm';
      return false;
    }
    if (detectorFor(info).settled) return false;
    // 更高优先级规则已命中，或默认就是关（不全屏时的「仅全屏」也是），就没必要采样
    const base = decideFor(v, info, true);
    return !!base && (base.reason === 'default' || base.reason === 'fullscreen') && base.state === 'on';
  }

  function updateSampler() {
    const want = wantSampling();
    if (want && !sampleTimer) {
      sampleTimer = setInterval(sampleTick, SAMPLE_MS);
      // 立刻先采一帧，白底视频尽早关掉；距上次采样不足一个间隔时不补（暂停/播放来回切时不连采）
      if (Date.now() - lastSampleAt >= SAMPLE_MS) setTimeout(sampleTick, 0);
    } else if (!want && sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = 0;
    }
  }

  function grabFrame(v, info) {
    if (v.mediaKeys) {
      info.unknown = 'drm';
      return null;
    }
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    try {
      if (!ctx2d) {
        canvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
        ctx2d = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx2d) {
          canvas = null;
          info.unknown = 'error';
          return null;
        }
      }
      ctx2d.drawImage(v, 0, 0, SAMPLE_W, SAMPLE_H);
      return L.analyzeFrame(ctx2d.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
    } catch (e) {
      // 跨源视频会永久污染画布，丢弃后下次重建
      canvas = null;
      ctx2d = null;
      info.unknown = e && e.name === 'SecurityError' ? 'tainted' : 'error';
      return null;
    }
  }

  const sampleTick = guard(function () {
    if (!sampleTimer || !wantSampling()) {
      updateSampler();
      report(false);
      return;
    }
    const v = primary;
    const info = infoOf(v);
    lastSampleAt = Date.now();
    const res = grabFrame(v, info);
    if (!res) {
      if (info.unknown) {
        updateSampler();
        report(false);
      }
      return;
    }
    info.last = res;
    const det = detectorFor(info);
    const before = det.state;
    det.update(res, Date.now());
    if (det.state !== before) {
      const key = keyOf(info);
      if (det.state === 'off') {
        brightKeys.add(key);
        if (brightKeys.size > 500) brightKeys.delete(brightKeys.values().next().value);
      } else {
        brightKeys.delete(key);
      }
      evaluate(false);
    }
  });

  // ---------- OSD ----------

  function osdParent() {
    const root = document.documentElement;
    const fs = deepElement('fullscreenElement');
    // 全屏元素是 video 本身时只能挂到 documentElement（会被 top layer 挡住，看不到）
    if (!fs || NO_CHILD_RENDER.has(fs.localName)) return root;
    // 全屏的是 Web Components 播放器（自己挂着 shadow root）时放进它的 shadow root，不依赖 slot 也会被渲染
    return shadowRootOf(fs) || fs;
  }

  // kind：'peek' 对比标记（紧凑，关了屏幕提示也显示）；'offer' 带按钮的提议（可以点）；其他为普通提示
  function showOsd(text, ms, video, force, kind) {
    const k = kind === 'peek' || kind === 'offer' ? kind : '';
    if (!force && k !== 'peek' && !settings.osd) return;
    const root = document.documentElement;
    if (!root) return;
    if (!osdEl) {
      osdEl = document.createElement('rtx-hdr-osd');
      // 文字放进 closed shadow root：页面脚本读不到提示内容（预设名、错误详情等）
      try {
        const sr = osdEl.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = OSD_INNER_CSS;
        osdMark = document.createElement('span');
        osdMark.className = 'm';
        osdText = document.createElement('span');
        osdText.className = 't';
        osdBtn = document.createElement('button');
        osdBtn.className = 'b';
        osdBtn.type = 'button';
        osdBtn.addEventListener('click', onOfferClick);
        sr.append(style, osdMark, osdText, osdBtn);
        // 可以点的提议盖在播放器上：点它不能传到网站（暂停、显示控制栏、双击全屏、右键菜单）
        for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
          osdEl.addEventListener(t, onOsdPointer);
        }
      } catch (e) {
        osdText = osdEl;
        osdMark = null;
        osdBtn = null;
      }
    }
    const offer = k === 'offer' && !!osdBtn;
    osdKind = offer || k === 'peek' ? k : '';
    if (osdBtn) osdBtn.style.display = offer ? '' : 'none';
    if (!offer) osdOffer = '';
    if (osdMark) osdMark.style.background = settings.ui.accent;
    const parent = osdParent() || root;
    const vw = window.innerWidth;
    let left = 16;
    let top = 16;
    if (video && video.isConnected) {
      const r = video.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        left = Math.min(Math.max(r.left, 0) + 16, Math.max(16, vw - 200));
        top = Math.min(Math.max(r.top, 0) + 16, Math.max(16, window.innerHeight - 48));
      }
    }
    const maxW = Math.max(160, Math.round(vw - left - 16));
    // 护眼提醒、提议等长文字允许换行，状态提示保持一行
    const wrap = force || offer ? 'white-space:normal !important;' : 'white-space:nowrap !important;text-overflow:ellipsis !important;';
    const extra = (k === 'peek' ? OSD_PEEK_CSS : '') + (offer ? 'pointer-events:auto !important;' : '');
    osdEl.style.cssText = OSD_CSS + wrap + extra + 'max-width:' + maxW + 'px !important;left:' + Math.round(left) +
      'px !important;top:' + Math.round(top) + 'px !important;opacity:1 !important;';
    osdText.textContent = text;
    if (osdEl.parentNode !== parent) parent.appendChild(osdEl);
    clearTimeout(osdHideTimer);
    osdHideTimer = setTimeout(hideOsd, ms);
  }

  const hideOsd = guard(function () {
    if (!osdEl) return;
    osdOffer = '';
    osdKind = '';
    removeOsd();
  });

  // 只收起对比标记（别的提示已经盖掉它时不动）
  function hidePeekOsd() {
    if (osdKind !== 'peek') return;
    osdKind = '';
    clearTimeout(osdHideTimer);
    removeOsd();
  }

  // 屏幕提示上的提议：手动切换的提示加一个「本标签页后续视频都……」按钮
  function showOffer(text, state, video) {
    showOsd(text, OFFER_MS, video, false, 'offer');
    if (osdKind !== 'offer') return;
    osdOffer = state;
    osdBtn.textContent = L.t(lang, state === 'on' ? 'content.tabOfferOn' : 'content.tabOfferOff');
  }

  const onOfferClick = guard(function (e) {
    if (!e.isTrusted || osdKind !== 'offer' || !osdOffer) return;
    const state = osdOffer;
    osdOffer = '';
    setTabSticky(state);
  });

  const onOsdPointer = guard(function (e) {
    e.stopPropagation();
    if (e.type === 'mousedown') e.preventDefault(); // 不抢焦点（焦点留在播放器上）
    if (e.type === 'contextmenu') e.preventDefault();
  });

  function removeOsd() {
    try { if (osdEl) osdEl.remove(); } catch (e) { /* ignore */ }
  }

  // ---------- 命令 ----------

  function setManual(v, state) {
    const info = infoOf(v);
    const key = keyOf(info);
    info.manual = { state: state, reason: 'manual' };
    info.manualKey = key;
    info.manualAt = Date.now();
    info.ownerKey = key;
    // 用户亲自操作：之前被页面改回而让步的，再试一次
    info.contested = 0;
    info.contestCount = 0;
    info.contestNotified = false;
    info.fights = 0;
    info.secFights = 0;
    // 护眼 SDR 期间手动切回 HDR：护眼 SDR 结束（所有标签页）
    if (state === 'on' && eyeRestAt) {
      eyeRestAt = 0;
      storageCall(() => chrome.storage.local.remove(L.EYE_REST_KEY));
    }
    if (settings.rememberManual && key) saveRule(key, state);
    // 在下一个视频上又做了同样的切换：提示里提议「本标签页后续视频沿用」；沿用开着时最新的选择接着沿用
    let offer = false;
    if (v === primary && key) {
      offer = settings.osd && L.tabOffer(lastManual, key, state, tabSticky);
      if (tabSticky) tabSticky = { state: state, at: Date.now() };
      lastManual = { key: key, state: state };
    }
    evaluate(true);
    if (offer) showOffer(L.osdText(state, 'manual', lang), state, v);
    else showOsd(L.osdText(state, 'manual', lang), OSD_MS, v, false);
  }

  // 本标签页后续视频沿用 state（'on' | 'off'；其他值 = 不再沿用）。只在内存里，不写视频记忆
  function setTabSticky(state) {
    const on = state === 'on' || state === 'off';
    tabSticky = on ? { state: state, at: Date.now() } : null;
    evaluate(true);
    if (!on) return;
    if (primary) tabNotify(keyOf(infoOf(primary)));
    showOsd(L.t(lang, state === 'on' ? 'content.tabSetOn' : 'content.tabSetOff'), EYE_OSD_MS, primary, false);
  }

  function tabNotify(key) {
    tabNotified.add(key);
    if (tabNotified.size > 200) tabNotified.delete(tabNotified.values().next().value);
  }

  // ---------- 按住对比 ----------

  // 不能对比时返回提示文字的 i18n 键，能对比返回空串
  function peekGuard(v) {
    if (!v || v !== primary) return 'content.noVideo';
    if (v.mediaKeys) return 'content.drm';
    const info = infoOf(v);
    const d = info.decisionKey === keyOf(info) ? info.decision : null;
    if (!d) return 'content.noVideo';
    if (d.state === 'off' && info.contested) return 'content.contested';
    // 全局 HDR 被「只关 HDR」借走了：没有 HDR 可以对比
    if (d.state === 'off' && hdrOnly) return 'content.peekHdrOnly';
    return '';
  }

  // 主视频临时变成相反的状态 ms 毫秒（不调用 setManual、不写视频记忆、不动护眼计时）
  function peekStart(v, source, ms) {
    evaluate(true);
    // 按钮在这次求值里被换掉了：手势已经作废，不再开始对比（否则松开收不到，要等 30 秒）
    if ((source === 'button' || source === 'key') && !(btnHold.held && btnHoldSrc === source)) {
      swallowClick = false;
      return false;
    }
    const why = peekGuard(v);
    if (why) {
      showOsd(L.t(lang, why), OSD_MS, v, false);
      return false;
    }
    if (peek) peekClear();
    const info = infoOf(v);
    const base = info.decision.state;
    const dur = Math.min(ms > 0 ? ms : L.PEEK_MAX_MS, L.PEEK_MAX_MS);
    peek = { video: v, key: keyOf(info), base: base, state: base === 'on' ? 'off' : 'on', source: source,
      at: Date.now(), timer: setTimeout(onPeekTimeout, dur) };
    applyState(v, peek.state, true);
    hideTip();
    renderButton();
    const st = peek.state === 'on' ? 'HDR' : 'SDR';
    const text = source === 'command'
      ? L.t(lang, 'content.peekTimed', { state: st, seconds: Math.round(dur / 1000) })
      : L.t(lang, 'content.peek', { state: st });
    showOsd(text, dur, v, false, 'peek');
    return true;
  }

  // 只清掉对比状态，不重新求值（evaluate 里就地调用）
  function peekClear() {
    const p = peek;
    if (!p) return;
    peek = null;
    clearTimeout(p.timer);
    hidePeekOsd();
  }

  // 结束对比，视频回到决策状态。source 给了时只结束这个来源开始的对比
  function peekEnd(source) {
    if (!peek || (source && peek.source !== source)) return;
    peekClear();
    evaluate(true);
  }

  const onPeekTimeout = guard(function () { peekEnd(); });

  // 命令 peek：对比 5 秒；对比中再按一次立即恢复（开始后 500 ms 内重复到达的忽略）
  function peekCommand() {
    if (peek) {
      if (Date.now() - peek.at >= PEEK_REPEAT_MS) peekEnd();
      return;
    }
    const v = controllablePrimary();
    if (v) peekStart(v, 'command', L.PEEK_CMD_MS);
  }

  // 返回可以手动控制的主视频；没有时给出提示
  function controllablePrimary() {
    evaluate(true);
    if (!primary) {
      showOsd(L.t(lang, 'content.noVideo'), OSD_MS, null, false);
      return null;
    }
    if (primary.mediaKeys) {
      showOsd(L.t(lang, 'content.drm'), OSD_MS, primary, false);
      return null;
    }
    return primary;
  }

  function toggleHdr() {
    toggleVideo(controllablePrimary());
  }

  // 手动切换一个视频（快捷键对主视频，控制栏按钮对它所在播放器的视频）
  function toggleVideo(v) {
    if (!v) return;
    setManual(v, effState(v) === 'on' ? 'off' : 'on');
  }

  // 以实际生效的状态为准（被页面改回时显示的是开，再按一次是「关」）；还没决策过时看 data-rtxhdr
  function effState(v) {
    const info = infoOf(v);
    return info.decisionKey === keyOf(info) && info.eff ? info.eff : v.dataset.rtxhdr === 'off' ? 'off' : 'on';
  }

  function setState(state) {
    if (state === 'clear') {
      forgetVideo();
      return;
    }
    if (state !== 'on' && state !== 'off') return;
    const v = controllablePrimary();
    if (v) setManual(v, state);
  }

  // 设置只由 background 写：它按 storage 里的最新设置切换并在这个 frame 上显示提示，新设置经 storage.onChanged 回来
  function toggleAuto() {
    storageCall(() => runtime.sendMessage({ type: 'settings-patch', op: 'toggle-auto' }));
  }

  function forgetVideo() {
    evaluate(true);
    const key = primary ? keyOf(infoOf(primary)) : pageKey;
    if (key) {
      savedRules.set(key, null);
      storageCall(() => chrome.storage.local.remove(L.VIDEO_PREFIX + key));
    }
    for (const v of videos) {
      const i = infoOf(v);
      if (i.manualKey === key) {
        i.manual = null;
        i.manualKey = null;
        i.manualAt = 0;
      }
    }
    // 清除记忆时本标签页的沿用一起取消
    const hadTab = !!tabSticky;
    tabSticky = null;
    lastManual = null;
    evaluate(true);
    showOsd(L.t(lang, !primary ? 'content.noVideo' : hadTab ? 'content.forgotTab' : 'content.forgot'), OSD_MS, primary, false);
  }

  function saveRule(key, state) {
    const val = { s: state, t: Date.now() };
    savedRules.set(key, val);
    storageCall(() => chrome.storage.local.set({ [L.VIDEO_PREFIX + key]: val })).then(pruneStorage);
  }

  function pruneStorage() {
    return storageCall(async () => {
      const local = chrome.storage.local;
      if (typeof local.getKeys === 'function') {
        const keys = await local.getKeys();
        let n = 0;
        for (const k of keys) if (k.indexOf(L.VIDEO_PREFIX) === 0) n++;
        if (n <= L.MAX_VIDEO_ENTRIES) return;
      }
      const old = L.pruneKeys(await local.get(null), L.MAX_VIDEO_ENTRIES);
      if (old.length) await local.remove(old);
    });
  }

  // ---------- 播放器控制栏按钮 ----------

  // 各网站的控制栏（选择器只写在这里）：
  //   root：从主视频往上找到的播放器；skip：不加按钮的播放器（悬停预览）
  //   bars：控制栏右侧，依次取第一个找得到的；before：插在控制栏里含有它的那个子元素前面，依次找，
  //   都没有时 append 为真就加在最后，否则当作控制栏还没好
  //   make：照网站原生按钮的结构造按钮（大小、悬停、全屏变大、焦点框都用网站自己的 CSS）
  //   webFull：网页全屏时视频 closest 能命中的选择器（「网页全屏也算全屏」）
  const PLAYER_BARS = Object.freeze({
    bilibili: {
      root: '.bpx-player-container',
      skip: '.v-recommend-inline-player',
      bars: ['.bpx-player-control-bottom-right'],
      before: ['.bpx-player-ctrl-setting', '.bpx-player-ctrl-pip', '.bpx-player-ctrl-full'],
      append: true,
      webFull: '.bpx-player-container[data-screen="web"]',
      make: makeBiliButton
    },
    youtube: {
      root: '#movie_player',
      skip: '#inline-preview-player',
      // 新版（delhi）右侧分左右两组，放进左组（和字幕、设置同一个圆角框）；旧版直接在 .ytp-right-controls 里
      bars: ['.ytp-chrome-bottom .ytp-right-controls-left', '.ytp-chrome-bottom .ytp-right-controls'],
      before: ['.ytp-subtitles-button', '.ytp-settings-button'],
      append: true,
      make: makeYtButton
    },
    twitch: {
      root: '.video-player',
      bars: ['.player-controls__right-control-group'],
      // class 名每次构建都会变：插在包着设置按钮的那一层前面，结构和 class 运行时照设置按钮抄
      before: ['[data-a-target="player-settings-button"]'],
      append: false,
      make: makeTwitchButton
    },
    tencent: {
      root: '#player-component, .txp_player',
      bars: ['.txp_right_controls'],
      before: ['.txp_btn_pip', '.txp_btn_fake', '.txp_btn_fullscreen'],
      append: true,
      make: makeTxpButton
    }
  });
  // 按钮、提示、样式都带这个 class 和 data-rtxhdr-owner=实例标记：新实例清掉旧实例留下的
  const BTN_CLASS = 'rtxhdr-player-btn';
  const BTN_RETRY_MS = 500;
  const BTN_WAIT_MS = 15000;
  const BTN_APPEND_MS = 3000;
  // 网站不停从同一个控制栏里删掉我们的按钮时别跟它较劲：10 秒内重插超过 8 次就停手，等下一次导航或换主视频
  // （控制栏整个重建、换了新元素不算）
  const BTN_INSERT_WINDOW_MS = 10000;
  const BTN_INSERT_MAX = 8;
  // 放好以后锚点才出现或换了、按钮被挪到锚点后面时挪回去；每次放置最多挪 3 次，不和别的扩展来回抢位置
  const BTN_MOVE_MAX = 3;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 图标画在 24×24 上：圆角矩形徽标里的 H、D、R 都是路径（不用字体）
  const ICON_LETTERS = 'M4.75 8V16M7.85 8V16M4.75 12H7.85' +
    'M10.45 8.75H11.3A2.25 2.25 0 0 1 13.55 11V13A2.25 2.25 0 0 1 11.3 15.25H10.45Z' +
    'M16.15 16V8.75H17.5A1.75 1.75 0 0 1 17.5 12.25H16.15M17.9 12.25L19.25 16';
  const ICON_SLASH = 'M3 3L21 21';
  const LETTER_CSS = 'fill:none;stroke-width:1.5;stroke-linecap:butt;stroke-linejoin:miter;stroke:';
  // 自己画的提示（原生提示不管插进来的按钮）。B 站照它自己的提示；YouTube 照它的提示大小，
  // 但不用 backdrop-filter（盖在视频上会让视频离开 overlay，RTX HDR 跟着失效）
  const TIP_CSS = 'position:absolute;display:none;z-index:12000;pointer-events:none;box-sizing:border-box;' +
    'width:max-content;margin:0;text-align:left;white-space:normal;overflow-wrap:break-word;word-break:normal;' +
    'cursor:default;user-select:none;opacity:1;transform:none;text-shadow:none;';
  const TIP_CSS_BILI = TIP_CSS + 'max-width:18em;padding:6px 8px;border-radius:2px;' +
    'background-color:var(--bpx-tooltip-bgcolor,#000);color:var(--bpx-tooltip-color,#fff);' +
    'font-size:12px;font-weight:400;line-height:1.5;';
  const TIP_CSS_YT = TIP_CSS + 'z-index:1003;max-width:300px;padding:5px 9px;' +
    'background-color:rgba(28,28,28,.9);color:#eee;font-size:118%;font-weight:500;line-height:15px;';

  let btnSite = '';    // 本 frame 的网站（L.playerSite）；空 = 不加按钮
  // 当前按钮：{el 插进控制栏的元素, btn 可点的元素, icon, dim, tip, tipHost, txpTip,
  //   bar, root, video, site, anchor 放在它前面（null = 加在最后）, moves 放好后挪过几次, sig, tipOn}
  let pbtn = null;
  let btnWait = null;  // 控制栏还没出现：{video, href, since, until}；until 为 -1 表示已放弃，等导航或换主视频
  let btnRetryTimer = 0;
  let btnRaf = 0;
  let btnInserts = new WeakMap(); // 控制栏元素 → 最近往里插按钮的时间
  let btnStyle = null;
  let btnSeq = 0;
  let btnSpace = false;
  // 按住对比：按钮的指针和回车共用一个手势；按满 300 ms 后跟来的那个 click 吞掉
  const btnHold = L.createHoldGesture(L.PEEK_HOLD_MS);
  let btnHoldSrc = '';  // 'button'（指针）| 'key'（回车）
  let btnHoldTimer = 0;
  let swallowClick = false;

  // evaluate() 末尾调用：主视频所在播放器的控制栏里放一个按钮，状态跟着这个视频走
  function syncButtonNow() {
    const site = btnSite && settings.playerButton ? PLAYER_BARS[btnSite] : null;
    if (!site) {
      if (pbtn || btnStyle) {
        if (pbtn) btnInserts.delete(pbtn.bar); // 自己拿掉的，不算网站删的
        removeButton();
        removeBtnStyle();
      }
      btnWait = null; // 规则里再打开时从头找（之前放弃等待的也重新等）
      return;
    }
    // 按钮被网站拿掉了（控制栏重建、子元素换掉）：先丢掉，下面重新放。
    // 等控制栏期间 pbtn 为空，页面的 DOM 变化不会再触发重查
    if (pbtn && !buttonPlaced()) removeButton();
    const v = primary && primary.isConnected ? primary : null;
    const root = v && !(site.skip && v.closest(site.skip)) ? v.closest(site.root) : null;
    if (!root) {
      // 主视频不在支持的播放器里（悬停预览、没有可见的视频）：已有的按钮留在原处
      renderButton();
      return;
    }
    if (pbtn && root.contains(pbtn.bar)) {
      pbtn.video = v;
      keepInPlace(site);
      renderButton();
      return;
    }
    placeButton(site, v, root);
  }
  const syncButton = guard(syncButtonNow);

  // 网站后来才把原生按钮填进控制栏（按钮先加在了最后）、换了锚点元素、或者把按钮挪到了锚点后面：
  // 挪回锚点前面。别的扩展插在按钮和锚点之间不算错位
  function keepInPlace(site) {
    const p = pbtn;
    const anchor = anchorIn(p.bar, site.before);
    if (!anchor || anchor === p.el || p.moves >= BTN_MOVE_MAX) return;
    const before = !!(p.el.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (anchor === p.anchor && before) return;
    p.anchor = anchor;
    if (before && p.el.nextElementSibling === anchor) return;
    p.moves++;
    p.bar.insertBefore(p.el, anchor);
  }

  function buttonPlaced() {
    return pbtn.el.parentNode === pbtn.bar && pbtn.bar.isConnected;
  }

  function isOwnNode(n) {
    const c = n.classList;
    return !!c && (c.contains(BTN_CLASS) || c.contains(BTN_CLASS + '-tip'));
  }

  function placeButton(site, v, root) {
    const href = location.href;
    if (btnWait && btnWait.video === v && btnWait.href === href && btnWait.until < 0) return;
    let bar = null;
    for (let i = 0; i < site.bars.length && !bar; i++) bar = root.querySelector(site.bars[i]);
    const anchor = bar ? anchorIn(bar, site.before) : null;
    // 控制栏可能还空着、正在填充（B 站实测）：先等锚点出现，等了 BTN_APPEND_MS 还没有（网站改版）才加在最后
    if (!bar || (!anchor && (!site.append || !waitedFor(v, href, BTN_APPEND_MS)))) {
      waitForBar(v, href);
      return;
    }
    removeButton();
    if (!insertAllowed(bar)) {
      btnWait = { video: v, href: href, since: Date.now(), until: -1 };
      return;
    }
    removeStaleButtons();
    const made = site.make(bar, anchor, root);
    if (!made) {
      waitForBar(v, href);
      return;
    }
    const el = made.el;
    const b = made.btn;
    el.classList.add(BTN_CLASS);
    el.setAttribute('data-rtxhdr-owner', TOKEN);
    b.addEventListener('mousedown', onBtnMouseDown);
    b.addEventListener('pointerdown', onBtnPointerDown);
    b.addEventListener('pointerup', onBtnPointerUp);
    b.addEventListener('pointercancel', onBtnPointerCancel);
    b.addEventListener('lostpointercapture', onBtnPointerCancel);
    b.addEventListener('contextmenu', onBtnContextMenu);
    b.addEventListener('click', onBtnClick);
    b.addEventListener('keydown', onBtnKeyDown);
    b.addEventListener('keyup', onBtnKeyUp);
    b.addEventListener('focus', onBtnFocus);
    b.addEventListener('blur', onBtnBlur);
    if (made.tip) {
      made.tip.className = BTN_CLASS + '-tip';
      made.tip.setAttribute('data-rtxhdr-owner', TOKEN);
      made.tip.setAttribute('aria-hidden', 'true');
      b.addEventListener('mouseenter', onBtnEnter);
      b.addEventListener('mouseleave', onBtnLeave);
    }
    bar.insertBefore(el, anchor);
    pbtn = Object.assign(made, { bar: bar, root: root, video: v, site: btnSite, anchor: anchor, moves: 0, sig: '', tipOn: false });
    btnWait = null;
    ensureBtnStyle();
    renderButton();
  }

  // 控制栏里含有 sels 之一的那个直接子元素
  function anchorIn(bar, sels) {
    for (const sel of sels) {
      let n = bar.querySelector(sel);
      while (n && n.parentElement !== bar) n = n.parentElement;
      if (n) return n;
    }
    return null;
  }

  function waitedFor(v, href, ms) {
    return !!btnWait && btnWait.video === v && btnWait.href === href && btnWait.until > 0 && Date.now() - btnWait.since >= ms;
  }

  // 控制栏还没出现（播放器晚于视频渲染）：每 500 ms 再找一次，15 秒后放弃，等下一次导航或换主视频
  function waitForBar(v, href) {
    const now = Date.now();
    if (!btnWait || btnWait.video !== v || btnWait.href !== href) btnWait = { video: v, href: href, since: now, until: now + BTN_WAIT_MS };
    if (btnWait.until < 0) return;
    if (now >= btnWait.until) {
      btnWait.until = -1;
      return;
    }
    if (!btnRetryTimer) btnRetryTimer = setTimeout(retryButton, BTN_RETRY_MS);
  }

  const retryButton = guard(function () {
    btnRetryTimer = 0;
    scheduleEvaluate();
  });

  function insertAllowed(bar) {
    const now = Date.now();
    const list = (btnInserts.get(bar) || []).filter((t) => now - t < BTN_INSERT_WINDOW_MS);
    btnInserts.set(bar, list);
    if (list.length >= BTN_INSERT_MAX) return false;
    list.push(now);
    return true;
  }

  // SPA 导航、播放器重建、往返缓存恢复：重新找控制栏（之前 15 秒没找到的也重新等）
  function kickButton() {
    btnWait = null;
    btnInserts = new WeakMap();
    if (btnSite || pbtn) scheduleEvaluate();
  }

  function removeButton() {
    clearTimeout(btnRetryTimer);
    btnRetryTimer = 0;
    const p = pbtn;
    if (!p) return;
    pbtn = null;
    // 按钮被移除：按住的手势作废，从按钮开始的对比结束（可能在 evaluate 里，不重新求值）
    holdReset();
    if (peek && (peek.source === 'button' || peek.source === 'key')) {
      peekClear();
      scheduleEvaluate();
    }
    try { p.el.remove(); } catch (e) { /* ignore */ }
    if (p.tip) { try { p.tip.remove(); } catch (e) { /* ignore */ } }
  }

  // 扩展重新加载后旧实例留下的按钮、提示和样式（旧实例失效前没来得及删的）
  function removeStaleButtons() {
    let list = null;
    try { list = document.querySelectorAll('.' + BTN_CLASS + ',.' + BTN_CLASS + '-tip,.' + BTN_CLASS + '-style'); } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.getAttribute('data-rtxhdr-owner') !== TOKEN) { try { el.remove(); } catch (e) { /* ignore */ } }
    }
  }

  // B 站小窗（data-screen="mini"）不显示按钮：用一条样式规则，切换时立即生效
  function ensureBtnStyle() {
    if (btnSite !== 'bilibili' || (btnStyle && btnStyle.isConnected)) return;
    const el = document.createElement('style');
    el.className = BTN_CLASS + '-style';
    el.setAttribute('data-rtxhdr-owner', TOKEN);
    el.textContent = '.bpx-player-container[data-screen="mini"] .' + BTN_CLASS + '{display:none !important}';
    (document.head || document.documentElement).appendChild(el);
    btnStyle = el;
  }

  function removeBtnStyle() {
    if (!btnStyle) return;
    try { btnStyle.remove(); } catch (e) { /* ignore */ }
    btnStyle = null;
  }

  // 状态、文字只在变化时写 DOM（evaluate 每秒都会调到这里）
  function renderButton() {
    const p = pbtn;
    if (!p) return;
    const v = p.video;
    const drm = !!(v && v.mediaKeys);
    const state = v ? effState(v) : 'on';
    // 对比时图标跟着显示的状态走；aria-pressed 和文字仍按决策状态
    const shown = peek && peek.video === v ? peek.state : state;
    const sig = (drm ? 'drm' : state + '|' + shown) + '|' + lang;
    if (sig === p.sig) return;
    p.sig = sig;
    const b = p.btn;
    const sdr = !drm && state === 'off';
    const iconSdr = !drm && shown === 'off';
    const text = drm ? L.t(lang, 'player.drm') : sdr ? L.t(lang, 'player.off') : L.t(lang, 'player.on');
    b.setAttribute('aria-label', text);
    if (drm) {
      // 受版权保护：CSS 管不了这个视频，按钮变暗、点了没反应
      b.setAttribute('aria-disabled', 'true');
      b.removeAttribute('aria-pressed');
    } else {
      b.removeAttribute('aria-disabled');
      b.setAttribute('aria-pressed', sdr ? 'false' : 'true');
    }
    p.icon.on.style.display = iconSdr ? 'none' : '';
    p.icon.off.style.display = iconSdr ? '' : 'none';
    if (p.dim) {
      p.dim.style.opacity = drm ? '0.4' : '';
      p.dim.style.cursor = drm ? 'default' : '';
    }
    if (p.tip) {
      p.tip.textContent = text;
      if (p.tipOn) placeTip(p);
    } else if (p.txpTip) {
      p.txpTip.textContent = text;
    } else {
      b.title = text;
    }
  }

  // 点按钮 = 对按钮所在播放器的视频按一次 Alt+H；受版权保护时按钮是禁用的，什么都不做
  function pressButton() {
    const p = pbtn;
    const v = p && p.video && p.video.isConnected && videos.has(p.video) ? p.video : null;
    if (!v) {
      toggleHdr();
      return;
    }
    if (v.mediaKeys) return;
    evaluate(true);
    toggleVideo(v);
  }

  // 不抢焦点（焦点留在播放器上，网站快捷键照常），也不拦事件传播
  const onBtnMouseDown = guard(function (e) {
    if (e.button === 0) e.preventDefault();
  });

  const onBtnClick = guard(function (e) {
    // 只认用户的点击：页面脚本合成的 click 不能切换、改写记忆或吃掉按住之后的 click
    if (!e.isTrusted) return;
    // 按住对比之后跟来的 click：不切换
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    // 按钮有焦点时按空格，<button> 松开时会自己点一下：空格是播放器的，不切换（鼠标点击 detail ≥ 1，照常）
    if (btnSpace && e.detail === 0) return;
    pressButton();
  });

  // 按下开始计时：300 ms 内松开是普通点击（指针走 click，回车在 keyup 里切换），按满就开始对比
  function holdBegin(src) {
    holdReset();
    swallowClick = false;
    btnHold.down(Date.now());
    btnHoldSrc = src;
    btnHoldTimer = setTimeout(onHoldDue, btnHold.holdMs);
  }

  const onHoldDue = guard(function () {
    btnHoldTimer = 0;
    if (btnHold.due(Date.now()) !== 'hold') {
      // 计时器比 Date.now() 早到了一点：再等一帧
      if (btnHold.pressed && !btnHold.held) btnHoldTimer = setTimeout(onHoldDue, 16);
      return;
    }
    if (btnHoldSrc === 'button') swallowClick = true;
    const p = pbtn;
    const v = p && p.video && p.video.isConnected && videos.has(p.video) ? p.video : null;
    if (v && v.mediaKeys) return; // 受版权保护时按钮是禁用的
    peekStart(v || primary, btnHoldSrc, L.PEEK_MAX_MS);
  });

  // 松开：返回 'tap' | 'release' | null
  function holdUp() {
    clearTimeout(btnHoldTimer);
    btnHoldTimer = 0;
    const r = btnHold.up();
    const src = btnHoldSrc;
    btnHoldSrc = '';
    if (r === 'release') peekEnd(src);
    return r;
  }

  // 取消（不切换）：已经在对比就结束对比
  function holdReset() {
    clearTimeout(btnHoldTimer);
    btnHoldTimer = 0;
    const src = btnHoldSrc;
    btnHoldSrc = '';
    if (btnHold.cancel() === 'release' && peek && peek.source === src) {
      peekClear();
      scheduleEvaluate();
    }
  }

  // 主指针（鼠标左键、触屏、触控笔）按下；捕获指针，移出按钮也能收到松开
  const onBtnPointerDown = guard(function (e) {
    if (!e.isTrusted || !e.isPrimary || e.button !== 0) return;
    holdBegin('button');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });

  const onBtnPointerUp = guard(function (e) {
    if (!e.isTrusted || btnHoldSrc !== 'button' || !e.isPrimary) return;
    holdUp();
  });

  const onBtnPointerCancel = guard(function () {
    if (btnHoldSrc === 'button') holdReset();
  });

  // 触屏长按：按满之后别弹出系统菜单
  const onBtnContextMenu = guard(function (e) {
    if (btnHold.held || swallowClick) e.preventDefault();
  });

  // 回车：短按（松开时）= 点击，按住 = 对比（<button> 自己的回车点击被取消，避免切两次）；空格留给播放器
  const onBtnKeyDown = guard(function (e) {
    if (e.key === ' ' || e.key === 'Spacebar') {
      btnSpace = true;
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || !e.isTrusted) return;
    holdBegin('key');
  });

  const onBtnKeyUp = guard(function (e) {
    if (!e.isTrusted) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      setTimeout(clearBtnSpace, 0);
      return;
    }
    if (e.key !== 'Enter' || btnHoldSrc !== 'key') return;
    e.preventDefault();
    e.stopPropagation();
    if (holdUp() === 'tap') pressButton();
  });

  function clearBtnSpace() {
    btnSpace = false;
  }

  const onBtnEnter = guard(function () { showTip(); });
  const onBtnLeave = guard(function () { hideTip(); });
  // 空格按下后焦点离开（松开不在按钮上）：别让标记一直留着；回车按住时失去焦点：不切换，结束对比
  const onBtnBlur = guard(function () {
    btnSpace = false;
    if (btnHoldSrc === 'key') holdReset();
    hideTip();
  });
  // 只有键盘焦点才显示提示
  const onBtnFocus = guard(function (e) {
    let visible = true;
    try { visible = e.currentTarget.matches(':focus-visible'); } catch (err) { visible = true; }
    if (visible) showTip();
  });

  function showTip() {
    const p = pbtn;
    if (!p || !p.tip) return;
    if (p.tip.parentNode !== p.tipHost) p.tipHost.appendChild(p.tip);
    p.tip.style.display = 'block';
    p.tipOn = true;
    placeTip(p);
  }

  function hideTip() {
    const p = pbtn;
    if (!p || !p.tip || !p.tipOn) return;
    p.tipOn = false;
    p.tip.style.display = 'none';
  }

  // 提示在按钮正上方居中，左右不超出播放器；和按钮的距离照原生提示
  // （B 站普通 19 px、网页全屏 28 px，约为按钮宽度的 0.53；YouTube 22 px，按钮变大时按比例放大）
  function placeTip(p) {
    const tip = p.tip;
    const b = p.btn.getBoundingClientRect();
    const c = p.root.getBoundingClientRect();
    const host = tip.offsetParent;
    const o = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const gap = p.site === 'bilibili' ? Math.round(b.width * 0.53) : Math.round(22 * b.height / 40);
    const x = Math.max(c.left + 4, Math.min(b.left + (b.width - w) / 2, c.right - 4 - w));
    tip.style.left = Math.round(x - o.left) + 'px';
    tip.style.top = Math.round(b.top - gap - h - o.top) + 'px';
  }

  function svgEl(name, css, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    // 颜色、线宽都写内联样式：网站给按钮里的 svg / path 设的 fill、stroke 盖不过它
    if (css) el.style.cssText = css;
    return el;
  }

  // 两种状态的图标放在同一个 svg 里：on = 实心徽标、字母镂空；off = 描边徽标加斜杠（斜杠两侧留缝）。
  // 用 createElementNS 拼（YouTube 页面有 Trusted Types，不用 innerHTML）
  function makeIcon(width, height, viewBox) {
    const id = BTN_CLASS + '-' + TOKEN + '-' + (++btnSeq);
    const svg = svgEl('svg', '', { viewBox: viewBox, focusable: 'false', 'aria-hidden': 'true' });
    if (width) svg.setAttribute('width', width);
    if (height) svg.setAttribute('height', height);
    const box = { x: '1', y: '5', width: '22', height: '14', rx: '3.5' };
    const area = { maskUnits: 'userSpaceOnUse', x: '-8', y: '-8', width: '40', height: '40' };
    const mOn = svgEl('mask', '', Object.assign({ id: id + '-on' }, area));
    mOn.append(svgEl('rect', 'fill:#fff;stroke:none', box), svgEl('path', LETTER_CSS + '#000', { d: ICON_LETTERS }));
    const mOff = svgEl('mask', '', Object.assign({ id: id + '-off' }, area));
    mOff.append(svgEl('rect', 'fill:#fff;stroke:none', { x: '-8', y: '-8', width: '40', height: '40' }),
      svgEl('path', 'fill:none;stroke:#000;stroke-width:4.5;stroke-linecap:round', { d: ICON_SLASH }));
    const defs = svgEl('defs');
    defs.append(mOn, mOff);
    const on = svgEl('rect', 'fill:#fff;stroke:none', Object.assign({ mask: 'url(#' + id + '-on)' }, box));
    const cut = svgEl('g', '', { mask: 'url(#' + id + '-off)' });
    cut.append(svgEl('rect', 'fill:none;stroke:#fff;stroke-width:2', { x: '2', y: '6', width: '20', height: '12', rx: '2.5' }),
      svgEl('path', LETTER_CSS + '#fff', { d: ICON_LETTERS }));
    const off = svgEl('g');
    off.append(cut, svgEl('path', 'fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round', { d: ICON_SLASH }));
    svg.append(defs, on, off);
    return { svg: svg, on: on, off: off };
  }

  // 原生图标的 viewBox 比 24 大（YouTube 旧版 36、腾讯 28）时，把 24×24 的图标放在正中，大小和原生图标一致
  function centeredViewBox(ref) {
    const m = ref && /^\s*0[\s,]+0[\s,]+([\d.]+)[\s,]+([\d.]+)\s*$/.exec(ref.getAttribute('viewBox') || '');
    const n = m ? Math.max(+m[1], +m[2]) : 24;
    if (!(n > 24 && n <= 48)) return '0 0 24 24';
    const o = (24 - n) / 2;
    return o + ' ' + o + ' ' + n + ' ' + n;
  }

  // B 站：div.bpx-player-ctrl-btn[role=button] > .bpx-player-ctrl-btn-icon > span.bpx-common-svg-icon > svg，
  // 提示放在按钮里（B 站的提示由它自己的脚本统一管理，插进来的按钮没有）
  function makeBiliButton() {
    const b = document.createElement('div');
    b.className = 'bpx-player-ctrl-btn';
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    const box = document.createElement('div');
    box.className = 'bpx-player-ctrl-btn-icon';
    const span = document.createElement('span');
    span.className = 'bpx-common-svg-icon';
    const icon = makeIcon('24', '24', '0 0 24 24');
    icon.svg.style.cssText = 'width:100%;height:100%';
    span.appendChild(icon.svg);
    box.appendChild(span);
    const tip = document.createElement('div');
    tip.style.cssText = TIP_CSS_BILI;
    b.append(box, tip);
    return { el: b, btn: b, icon: icon, dim: box, tip: tip, tipHost: b };
  }

  // YouTube：<button class="ytp-button">；图标尺寸照设置按钮（新版 24×24，旧版是 36×36 的框）；
  // 提示挂在 #movie_player 里（全屏时也在全屏元素里）
  function makeYtButton(bar, anchor, root) {
    const b = document.createElement('button');
    b.className = 'ytp-button';
    b.type = 'button';
    const ref = root.querySelector('.ytp-settings-button svg');
    const w = (ref && ref.getAttribute('width')) || '24';
    const icon = makeIcon(w, (ref && ref.getAttribute('height')) || w, centeredViewBox(ref));
    b.appendChild(icon.svg);
    const tip = document.createElement('div');
    tip.style.cssText = TIP_CSS_YT + 'border-radius:' + (root.classList.contains('ytp-delhi-modern') ? '8px;' : '2px;');
    return { el: b, btn: b, icon: icon, dim: null, tip: tip, tipHost: root };
  }

  // Twitch：照设置按钮抄结构和 class：InjectLayout > ScLayoutCssVars > button > ButtonIconFigure > ScSvgWrapper > svg
  // （和影院模式、全屏按钮的结构一样）；提示用 title（Twitch 的提示是 React 弹层）
  function makeTwitchButton(bar, anchor) {
    const ref = anchor && anchor.querySelector('[data-a-target="player-settings-button"]');
    if (!ref) return null;
    const refSvg = ref.querySelector('svg');
    const b = document.createElement('button');
    b.className = ref.className;
    b.type = 'button';
    const icon = makeIcon((refSvg && refSvg.getAttribute('width')) || '24', (refSvg && refSvg.getAttribute('height')) || '24', '0 0 24 24');
    let inner = icon.svg;
    for (let n = refSvg && refSvg.parentElement; n && n !== ref && ref.contains(n); n = n.parentElement) {
      const w = document.createElement('div');
      w.className = n.className;
      w.appendChild(inner);
      inner = w;
    }
    b.appendChild(inner);
    let outer = b;
    for (let n = ref.parentElement, i = 0; n && n !== anchor && n !== bar && i < 2; n = n.parentElement, i++) {
      const w = document.createElement('div');
      w.className = n.className;
      w.appendChild(outer);
      outer = w;
    }
    return { el: outer, btn: b, icon: icon, dim: icon.svg, tip: null };
  }

  // 腾讯视频：div.txp_btn > svg.txp_icon + div.txp_tooltip（悬停时由腾讯自己的 CSS 显示提示）
  function makeTxpButton(bar) {
    const b = document.createElement('div');
    b.className = 'txp_btn';
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    const ref = bar.querySelector('.txp_btn_pip svg, .txp_btn_fake svg, .txp_btn_fullscreen svg');
    const vb = centeredViewBox(ref);
    const size = vb.split(' ')[2];
    const icon = makeIcon(size, size, vb);
    icon.svg.setAttribute('class', 'txp_icon');
    const tip = document.createElement('div');
    tip.className = 'txp_tooltip';
    b.append(icon.svg, tip);
    return { el: b, btn: b, icon: icon, dim: icon.svg, tip: null, txpTip: tip };
  }

  const onBtnLost = guard(function () {
    btnRaf = 0;
    if (pbtn && !pbtn.el.isConnected) evaluate(false);
  });

  // ---------- 护眼计时 ----------

  // 只在本地攒「主视频在播放（且 HDR 没被阻止）」的时间，随报告交给 background 跨视频、跨标签页累计；
  // 到点提醒、自动切回 SDR、暂停超过 5 分钟清零都在 background 里做
  function eyeTick(dt) {
    if (!settings.eye.minutes || !(dt > 0)) return;
    const v = primary;
    if (!v || (document.hidden && v !== pipVideo) || !isPlaying(v)) return;
    eyePending.watch += dt;
    const info = infoOf(v);
    if (info.decisionKey === keyOf(info) && info.eff === 'on') eyePending.hdr += dt;
  }

  // 「只关 HDR」只管 background 借开关时看的那个 frame；变了返回 true
  function updateHdrOnly() {
    const next = L.hdrOnlyApplies(hdrOnlyStatus, selfTab, selfFrame);
    if (next === hdrOnly) return false;
    hdrOnly = next;
    return true;
  }

  const onReply = guard(function (res) {
    if (!res) return;
    if (Number.isInteger(res.tabId) && Number.isInteger(res.frameId) && (res.tabId !== selfTab || res.frameId !== selfFrame)) {
      selfTab = res.tabId;
      selfFrame = res.frameId;
      if (updateHdrOnly()) {
        quietNext = true; // 视频该开该关没变，只是换了关的方法
        scheduleEvaluate();
      }
    }
    // 父页面把本 frame 设为全屏：fs-hint 推送丢了时，靠报告的回复兜底（心跳 3 秒）
    // （推送刚到时，在它之前算好的回复可能晚到，先不信）
    if (!isTop && typeof res.topFs === 'boolean' && Date.now() - fsHintAt > FS_HINT_TRUST_MS) setTopFsHint(res.topFs);
    if (!res.remind) return;
    const m = res.remind;
    showOsd(L.eyeReminderText(m.minutes, !!m.autoOff, typeof m.shortcut === 'string' ? m.shortcut : '', lang),
      EYE_OSD_MS, primary, true);
  });

  // ---------- 与 background 通信 ----------

  function round3(x) {
    return typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 1000 : null;
  }

  function buildReport() {
    const v = primary;
    const info = v ? infoOf(v) : null;
    const key = info ? keyOf(info) : pageKey;
    const d = info && info.decisionKey === key ? info.decision : null;
    const last = info && info.detectorKey === key ? info.last : null;
    const drm = !!(v && v.mediaKeys);
    const contested = !!(d && !drm && info.contested && d.state === 'off');
    const r = {
      type: 'report',
      hasVideo: !!v,
      videoCount: videos.size,
      offscreen: !v && offscreenCount > 0,
      area: info ? Math.round(info.area) : 0,
      playing: !!(info && info.playing),
      state: d ? info.eff : null,
      reason: !d ? null : drm ? 'drm' : contested ? 'contested' : d.reason,
      key: key,
      hostname: hostname,
      drm: drm,
      pip: !!(v && v === pipVideo),
      contested: contested,
      mean: last ? round3(last.mean) : null,
      white: last ? round3(last.white) : null,
      autoUnknown: info ? info.unknown : null,
      // 本 frame 自己的全屏元素包含主视频
      fullscreen: !!(v && fsElNow && containsDeep(fsElNow, v))
    };
    if (isTop) {
      // 让 background 识别顶层文档换了，清掉旧页面子 frame 的报告（新版 Chrome 另有 documentId）
      r.timeOrigin = Math.round(performance.timeOrigin);
      // 全屏的是某个 iframe：background 通知那个子 frame（fs-hint）
      r.fsFrame = fsFrameNow();
    }
    return r;
  }

  function send(r) {
    lastReportAt = Date.now();
    everReported = true;
    if (eyePending.hdr > 0 || eyePending.watch > 0) {
      r.eyeHdr = Math.round(eyePending.hdr);
      r.eyeWatch = Math.round(eyePending.watch);
      eyePending.hdr = 0;
      eyePending.watch = 0;
    }
    try {
      runtime.sendMessage(r).then(onReply, onSendError);
    } catch (e) {
      onSendError();
    }
  }

  function onSendError() {
    if (!runtime.id) destroy('later');
  }

  function report(force) {
    const r = buildReport();
    // 没有视频的子 frame 保持安静，避免广告 iframe 不停唤醒 service worker
    if (!isTop && !r.hasVideo && !everReported) return;
    const sig = [r.hasVideo, r.playing, r.state, r.reason, r.key, r.drm, r.fullscreen, r.fsFrame, r.autoUnknown,
      r.offscreen, r.pip, Math.round(r.area / 4096)].join('|');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    send(r);
  }

  function heartbeat(now) {
    if (primary && (!document.hidden || primary === pipVideo) && now - lastReportAt >= HEARTBEAT_MS) send(buildReport());
  }

  function snapshot() {
    const r = buildReport();
    const info = primary ? infoOf(primary) : null;
    const saved = savedRules.get(r.key);
    r.type = 'state';
    r.ok = true;
    r.reasonText = L.reasonText(r.reason, lang);
    r.hdrOnly = hdrOnly;
    r.topHostname = topHostname;
    r.isTop = isTop;
    r.settingsReady = settingsReady;
    r.manual = !!(info && info.manualKey === r.key && info.manual);
    r.saved = saved ? saved.s : null;
    r.eyeRest = !!eyeRestAt;
    r.tab = tabSticky ? tabSticky.state : null;
    r.peek = !!peek;
    r.auto = {
      mode: settings.autoDetect,
      detected: info && info.detector && info.detectorKey === r.key ? info.detector.state : null,
      sampling: !!sampleTimer,
      unknown: info ? info.unknown : null
    };
    return r;
  }

  function onMessage(msg, sender, sendResponse) {
    if (destroyed || !msg || typeof msg !== 'object' || (sender && sender.id !== runtime.id)) return false;
    if (msg.type === 'fs-hint') {
      // background：父页面把本 frame 所在的 iframe 设为全屏 / 退出了
      try {
        if (!isTop) {
          fsHintAt = Date.now();
          setTopFsHint(msg.on === true);
        }
      } catch (e) { /* ignore */ }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type !== 'get-state' && msg.type !== 'command' && msg.type !== 'set-state' && msg.type !== 'osd') return false;
    try {
      if (msg.type === 'get-state') evaluate(false);
      else if (msg.type === 'osd') {
        // background 的提示（切换 NVIDIA 预设）：显示在主视频上，没有视频时在左上角；
        // 失败等需要注意的（warn）关了屏幕提示也显示，显示更久、允许换行
        if (typeof msg.text === 'string' && msg.text) {
          showOsd(msg.text.slice(0, 200), msg.warn ? EYE_OSD_MS : OSD_MS, primary, !!msg.warn);
        }
      } else if (msg.type === 'command') {
        if (msg.command === 'toggle-hdr') toggleHdr();
        else if (msg.command === 'toggle-auto') toggleAuto();
        else if (msg.command === 'forget-video') forgetVideo();
        else if (msg.command === 'peek') peekCommand();
      } else setState(msg.state);
    } catch (e) { /* 仍然回复，避免调用方重试到别的 frame */ }
    try { sendResponse(snapshot()); } catch (e) { sendResponse({ ok: false }); }
    return false;
  }

  const onStorageChanged = guard(function (changes, area) {
    if (area !== 'local' || !changes) return;
    let dirty = false;
    if (changes.settings) {
      const next = L.mergeSettings(changes.settings.newValue);
      // 切换自动检测的一方（快捷键由 background）自己显示提示，视频随之变化不再提示，免得盖掉它
      if (next.autoDetect !== settings.autoDetect || next.autoLastMode !== settings.autoLastMode) quietNext = true;
      settings = next;
      settingsTouched = true;
      updateLang();
      dirty = true;
    }
    if (changes[HDR_ONLY_KEY]) {
      hdrOnlyStatus = changes[HDR_ONLY_KEY].newValue || null;
      hdrOnlyTouched = true;
      if (updateHdrOnly()) {
        quietNext = true; // 视频该开该关没变，只是换了关的方法
        dirty = true;
      }
    }
    if (changes[L.EYE_REST_KEY]) {
      eyeRestAt = L.eyeRestAt(changes[L.EYE_REST_KEY].newValue);
      eyeRestTouched = true;
      quietNext = true; // 护眼提醒自己会显示 OSD
      dirty = true;
    }
    for (const id of Object.keys(changes)) {
      if (id.indexOf(L.VIDEO_PREFIX) !== 0) continue;
      const key = id.slice(L.VIDEO_PREFIX.length);
      if (savedRules.has(key) || key === pageKey) {
        savedRules.set(key, L.validRule(changes[id].newValue));
        dirty = true;
      }
    }
    if (dirty) scheduleEvaluate();
  });

  // ---------- 定时与页面事件 ----------

  const tick = guard(function () {
    if (!runtime.id) { // 扩展被重载或禁用
      destroy('later');
      return;
    }
    const now = Date.now();
    const dt = lastTickAt ? Math.min(now - lastTickAt, 3000) : 0;
    lastTickAt = now;
    checkUrl();
    tickCount++;
    if (!document.hidden) {
      if (tickCount % SCAN_EVERY_TICKS === 0) fullScan();
      if (videos.size || primary) evaluate(false);
    }
    eyeTick(dt);
    heartbeat(now);
  });

  const onNavigate = guard(function () {
    checkUrl();
    kickButton();
  });
  const onDomReady = guard(function () {
    fullScan();
    scheduleEvaluate();
  });
  const onVisibility = guard(function () {
    if (document.hidden) {
      // 页面隐藏：按住的手势作废，对比结束
      holdReset();
      if (peek) peekEnd();
      updateSampler();
      return;
    }
    fullScan();
    evaluate(false);
    if (primary) report(true);
  });
  const onFullscreen = guard(function () {
    hideTip();
    evaluate(false);
  });
  const onPageShow = guard(function (e) {
    kickButton();
    if (!e.persisted) return;
    lastSig = '';
    evaluate(false);
  });
  // 预渲染的页面被激活：之前的报告 background 不认（documentLifecycle 是 prerender），重新报一次
  const onPrerender = guard(function () {
    lastSig = '';
    scheduleEvaluate();
  });
  // 文档要离开（iframe 被移除、整页导航、进入往返缓存）：告诉 background 这个 frame 没有视频了
  const onPageHide = guard(function () {
    if (!everReported) return;
    lastSig = '';
    const r = buildReport();
    r.bye = true;
    r.hasVideo = false;
    send(r);
  });

  let navApi = null;
  try { navApi = window.navigation || null; } catch (e) { navApi = null; }

  function restoreVideos(list) {
    for (const v of list) {
      try {
        const ds = v.dataset;
        if (ds.rtxhdrOwner && ds.rtxhdrOwner !== TOKEN) continue; // 已经由新实例接管
        applyState(v, 'on'); // 只还原我们加的 filter
        delete ds.rtxhdr;
        delete ds.rtxhdrOwner;
      } catch (e) { /* ignore */ }
    }
  }

  function stopTakeoverListener() {
    try { document.removeEventListener(TAKEOVER_EVENT, onTakeover); } catch (e) { /* ignore */ }
  }

  // 新实例启动时派发 TAKEOVER_EVENT：已失效的旧实例不再还原视频样式，交给新实例接着管
  function onTakeover() {
    try {
      if (!destroyed && runtime.id) return; // 自己仍然有效（也可能是页面伪造的事件），忽略
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = 0;
      }
      if (!destroyed) destroy('keep');
      else stopTakeoverListener();
    } catch (e) { /* ignore */ }
  }

  // mode：'now' 立即还原视频样式；'later' 扩展失效（重载/停用）时先等几秒，没有新实例接管再还原；
  //       'keep' 新实例接管，不动视频
  function destroy(mode) {
    if (destroyed) return;
    destroyed = true;
    clearInterval(tickTimer);
    clearInterval(sampleTimer);
    clearTimeout(evalTimer);
    clearTimeout(osdHideTimer);
    clearTimeout(btnHoldTimer);
    if (peek) {
      clearTimeout(peek.timer);
      peek = null;
    }
    if (btnRaf) { try { cancelAnimationFrame(btnRaf); } catch (e) { /* ignore */ } }
    try { removeButton(); } catch (e) { /* ignore */ }
    removeBtnStyle();
    try { domObserver.disconnect(); } catch (e) { /* ignore */ }
    try { styleObserver.disconnect(); } catch (e) { /* ignore */ }
    if (io) { try { io.disconnect(); } catch (e) { /* ignore */ } }
    try {
      document.removeEventListener('DOMContentLoaded', onDomReady);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('prerenderingchange', onPrerender);
      window.removeEventListener('yt-navigate-finish', onNavigate, true);
      window.removeEventListener('yt-player-updated', onNavigate, true);
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('resize', onFsResize);
      if (navApi) navApi.removeEventListener('navigatesuccess', onNavigate);
    } catch (e) { /* ignore */ }
    const list = Array.from(videos);
    for (const v of list) {
      try { for (const t of VIDEO_EVENTS) v.removeEventListener(t, onVideoEvent); } catch (e) { /* ignore */ }
    }
    videos.clear();
    removeOsd();
    try { runtime.onMessage.removeListener(onMessage); } catch (e) { /* ignore */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* ignore */ }
    if (window.__rtxHdrSwitchLoaded === handle) window.__rtxHdrSwitchLoaded = undefined;
    if (mode === 'keep') {
      stopTakeoverListener();
    } else if (mode === 'later') {
      restoreTimer = setTimeout(() => {
        restoreTimer = 0;
        stopTakeoverListener();
        restoreVideos(list);
      }, ORPHAN_RESTORE_MS);
    } else {
      stopTakeoverListener();
      restoreVideos(list);
    }
  }

  const handle = { runtime: runtime, destroy: destroy };
  window.__rtxHdrSwitchLoaded = handle;

  try { document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT)); } catch (e) { /* ignore */ }

  try {
    document.addEventListener(TAKEOVER_EVENT, onTakeover);
    runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (e) {
    destroy('now');
    return;
  }

  try {
    checkUrl();
    observeRoot(document); // document_start 时 documentElement 可能还不存在，直接观察 document
    fullScan();
    removeStaleButtons(); // 扩展重新加载：旧实例的控制栏按钮
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('prerenderingchange', onPrerender);
    window.addEventListener('yt-navigate-finish', onNavigate, true);
    window.addEventListener('yt-player-updated', onNavigate, true);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    if (navApi && typeof navApi.addEventListener === 'function') navApi.addEventListener('navigatesuccess', onNavigate);
    tickTimer = setInterval(tick, TICK_MS);
  } catch (e) {
    destroy('now');
    return;
  }

  storageCall(() => chrome.storage.local.get(['settings', L.EYE_REST_KEY, HDR_ONLY_KEY]).then((r) => {
    // onChanged 先到的话以它为准
    if (!settingsTouched) settings = L.mergeSettings(r && r.settings);
    if (!eyeRestTouched) eyeRestAt = L.eyeRestAt(r && r[L.EYE_REST_KEY]);
    if (!hdrOnlyTouched) {
      hdrOnlyStatus = (r && r[HDR_ONLY_KEY]) || null;
      updateHdrOnly();
    }
    updateLang();
  })).then(() => {
    settingsReady = true;
    scheduleEvaluate();
  });
})();
