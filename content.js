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
    'box-shadow:0 0 0 2px rgba(250,250,250,.14),0 4px 14px rgba(0,0,0,.4) !important;transition:opacity .35s ease !important;';
  const OSD_INNER_CSS = ':host{all:initial}.m{display:inline-block;width:9px;height:9px;margin:0 9px 1px 0;vertical-align:middle}' +
    '.t{font:inherit;color:inherit}';
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
  let osdHideTimer = 0;
  let osdRemoveTimer = 0;

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
        } else if (n.firstElementChild) {
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

  function applyState(v, want) {
    const st = v.style;
    const ds = v.dataset;
    if (!st || !ds) return;
    // 「只关 HDR」模式：主视频仍走 overlay（超分保留），HDR 由 background 关掉全局开关来关
    const state = want === 'off' && hdrOnly && v === primary ? 'on' : want;
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
      applyState(v, 'off');
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
    if (owner && !manual && !savedRules.has(key)) {
      loadRule(key);
      return null;
    }
    const det = owner && !skipAuto && settings.autoDetect !== 'off' ? detectorFor(info) : null;
    return L.decide({
      settings: settings,
      hostname: hostname,
      topHostname: topHostname,
      manual: manual,
      saved: owner ? savedRules.get(key) : null,
      autoState: det ? det.state : null
    });
  }

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
      if (want !== 'off' || !info.contested) applyState(v, want);
      const eff = want === 'off' && info.contested ? 'on' : want;
      const prevEff = info.decisionKey === key ? info.eff : null;
      info.decision = d;
      info.decisionKey = key;
      info.eff = eff;
      if (v === primary && !quiet && !drm && !info.contested && prevEff && prevEff !== eff) {
        showOsd(L.osdText(eff, d.reason, lang), OSD_MS, v, false);
      }
    }
    updateSampler();
    report(false);
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
    // 更高优先级规则已命中，或默认就是关，就没必要采样
    const base = decideFor(v, info, true);
    return !!base && base.reason === 'default' && base.state === 'on';
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

  function showOsd(text, ms, video, force) {
    if (!force && !settings.osd) return;
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
        sr.append(style, osdMark, osdText);
      } catch (e) {
        osdText = osdEl;
        osdMark = null;
      }
    }
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
    // 护眼提醒等长文字允许换行，状态提示保持一行
    const wrap = force ? 'white-space:normal !important;' : 'white-space:nowrap !important;text-overflow:ellipsis !important;';
    osdEl.style.cssText = OSD_CSS + wrap + 'max-width:' + maxW + 'px !important;left:' + Math.round(left) +
      'px !important;top:' + Math.round(top) + 'px !important;opacity:1 !important;';
    osdText.textContent = text;
    if (osdEl.parentNode !== parent) parent.appendChild(osdEl);
    clearTimeout(osdHideTimer);
    clearTimeout(osdRemoveTimer);
    osdHideTimer = setTimeout(hideOsd, ms);
  }

  const hideOsd = guard(function () {
    if (!osdEl) return;
    osdEl.style.setProperty('opacity', '0', 'important');
    osdRemoveTimer = setTimeout(removeOsd, 400);
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
    evaluate(true);
    showOsd(L.osdText(state, 'manual', lang), OSD_MS, v, false);
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
    const v = controllablePrimary();
    if (!v) return;
    const info = infoOf(v);
    // 以实际生效的状态为准（被页面改回时显示的是开，再按一次是「关」）
    const cur = info.decisionKey === keyOf(info) && info.eff ? info.eff
      : v.dataset.rtxhdr === 'off' ? 'off' : 'on';
    setManual(v, cur === 'on' ? 'off' : 'on');
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

  // 以 storage 里的设置为准再切换，避免设置还没读出来时用默认值覆盖用户设置
  function toggleAuto() {
    storageCall(async () => {
      const r = await chrome.storage.local.get('settings');
      const next = L.toggleAutoMode(r && r.settings);
      await chrome.storage.local.set({ settings: next });
      if (destroyed) return;
      settings = next;
      settingsTouched = true;
      settingsReady = true;
      evaluate(true);
      updateLang();
      showOsd(next.autoDetect === 'off' ? L.t(lang, 'content.autoOff')
        : L.t(lang, 'content.autoOn', { mode: L.autoModeText(next.autoDetect, lang) }), OSD_MS, primary, false);
    });
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
    evaluate(true);
    showOsd(L.t(lang, primary ? 'content.forgot' : 'content.noVideo'), OSD_MS, primary, false);
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
      fullscreen: !!document.fullscreenElement
    };
    // 让 background 识别顶层文档换了，清掉旧页面子 frame 的报告（新版 Chrome 另有 documentId）
    if (isTop) r.timeOrigin = Math.round(performance.timeOrigin);
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
    const sig = [r.hasVideo, r.playing, r.state, r.reason, r.key, r.drm, r.fullscreen, r.autoUnknown,
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
      } else setState(msg.state);
    } catch (e) { /* 仍然回复，避免调用方重试到别的 frame */ }
    try { sendResponse(snapshot()); } catch (e) { sendResponse({ ok: false }); }
    return false;
  }

  const onStorageChanged = guard(function (changes, area) {
    if (area !== 'local' || !changes) return;
    let dirty = false;
    if (changes.settings) {
      settings = L.mergeSettings(changes.settings.newValue);
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

  const onNavigate = guard(checkUrl);
  const onDomReady = guard(function () {
    fullScan();
    scheduleEvaluate();
  });
  const onVisibility = guard(function () {
    if (document.hidden) {
      updateSampler();
      return;
    }
    fullScan();
    evaluate(false);
    if (primary) report(true);
  });
  const onFullscreen = guard(function () { evaluate(false); });
  const onPageShow = guard(function (e) {
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
    clearTimeout(osdRemoveTimer);
    try { domObserver.disconnect(); } catch (e) { /* ignore */ }
    try { styleObserver.disconnect(); } catch (e) { /* ignore */ }
    if (io) { try { io.disconnect(); } catch (e) { /* ignore */ } }
    try {
      document.removeEventListener('DOMContentLoaded', onDomReady);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('prerenderingchange', onPrerender);
      window.removeEventListener('yt-navigate-finish', onNavigate, true);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
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
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('prerenderingchange', onPrerender);
    window.addEventListener('yt-navigate-finish', onNavigate, true);
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
