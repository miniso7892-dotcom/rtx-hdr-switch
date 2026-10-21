/*
 * RTX HDR 开关 —— 纯逻辑模块。
 * 不访问 chrome / document / window：浏览器里作为内容脚本先于 content.js 注入（也被弹窗和
 * service worker 复用），Node 里通过 module.exports 导出给测试。
 * 整体包在 IIFE 里，onInstalled 重复注入到同一页面时不会因顶层 const 重复声明而报错。
 */
(function (root) {
  'use strict';

  const STATES = ['on', 'off'];
  const AUTO_MODES = ['off', 'disable', 'both'];
  const SENSITIVITIES = ['low', 'medium', 'high'];
  const VIDEO_PREFIX = 'v:';
  const MAX_VIDEO_ENTRIES = 2000;

  const DEFAULT_SETTINGS = deepFreeze({
    defaultState: 'on',
    rememberManual: true,
    autoDetect: 'disable',
    autoLastMode: 'disable',
    sensitivity: 'medium',
    night: { enabled: false, start: '23:00', end: '07:00' },
    eye: { minutes: 45, autoOff: false },
    osd: true,
    sites: {}
  });

  const REASON_TEXT = Object.freeze({
    manual: '手动',
    eye: '护眼提醒',
    video: '已记住此视频',
    site: '网站规则',
    night: '夜间护眼',
    auto: '自动检测(白底)',
    default: '默认',
    // 以下两个不是决策结果，而是「想关但关不掉」的说明
    drm: '受版权保护，无法控制',
    contested: '页面不断改写视频样式，无法关闭'
  });
  const REASON_OSD = Object.freeze(Object.assign({}, REASON_TEXT, { auto: '自动检测·白底' }));

  // 关闭 HDR 时加在 <video> 上的滤镜（8 bit 画面上看不出差别，又不会被当成恒等滤镜优化掉）
  const OFF_FILTER = 'brightness(0.9999)';
  // 护眼：停止观看超过这么久，连续观看计时清零、「护眼 SDR」结束
  const EYE_IDLE_MS = 5 * 60 * 1000;
  // storage.local 里的「护眼 SDR」标记：{on:true, at:开始时间}
  const EYE_REST_KEY = 'eyeRest';
  const AUTO_MODE_TEXT = Object.freeze({ off: '关闭', disable: '只自动关闭', both: '自动开关' });

  const THRESHOLDS = deepFreeze({
    low: { white: 0.45, mean: 0.70 },
    medium: { white: 0.30, mean: 0.62 },
    high: { white: 0.20, mean: 0.55 }
  });
  const BRIGHT_FRAMES = 3;
  const DARK_FRAMES = 6;
  const AUTO_HOLD_MS = 10000;
  const BLACK_FRAME = 0.98;

  // ---------- 通用 ----------

  function deepFreeze(o) {
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]);
    return Object.freeze(o);
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function pick(v, allowed, fallback) {
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function bool(v, fallback) {
    return typeof v === 'boolean' ? v : fallback;
  }

  function normalizeHost(host) {
    return String(host == null ? '' : host).trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  }

  function hostOf(url) {
    try { return new URL(String(url)).hostname; } catch (e) { return ''; }
  }

  // 'H:MM' / 'HH:MM' → 当天分钟数；非法返回 null
  function parseTime(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str == null ? '' : str).trim());
    if (!m) return null;
    const h = +m[1], min = +m[2];
    return h < 24 && min < 60 ? h * 60 + min : null;
  }

  function formatTime(minutes) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function normTime(v, fallback) {
    const m = parseTime(v);
    return m == null ? fallback : formatTime(m);
  }

  function minutesOfDay(now) {
    const d = now instanceof Date ? now : new Date(typeof now === 'number' ? now : Date.now());
    return d.getHours() * 60 + d.getMinutes();
  }

  // ---------- 设置 ----------

  function mergeSettings(raw) {
    const s = isObj(raw) ? raw : {};
    const d = DEFAULT_SETTINGS;
    const night = isObj(s.night) ? s.night : {};
    const eye = isObj(s.eye) ? s.eye : {};

    // 兼容旧版的布尔值写法
    let autoDetect = s.autoDetect;
    if (autoDetect === true) autoDetect = 'disable';
    else if (autoDetect === false) autoDetect = 'off';
    let defaultState = s.defaultState;
    if (defaultState === true) defaultState = 'on';
    else if (defaultState === false) defaultState = 'off';

    let minutes = typeof eye.minutes === 'string' && eye.minutes.trim() !== '' ? Number(eye.minutes) : eye.minutes;
    minutes = typeof minutes === 'number' && isFinite(minutes)
      ? Math.min(600, Math.max(0, Math.round(minutes)))
      : d.eye.minutes;

    const sites = {};
    if (isObj(s.sites)) {
      for (const k of Object.keys(s.sites)) {
        const host = normalizeHost(k);
        const v = s.sites[k];
        if (host && (v === 'on' || v === 'off')) sites[host] = v;
      }
    }

    return {
      defaultState: pick(defaultState, STATES, d.defaultState),
      rememberManual: bool(s.rememberManual, d.rememberManual),
      autoDetect: pick(autoDetect, AUTO_MODES, d.autoDetect),
      autoLastMode: pick(s.autoLastMode, ['disable', 'both'], d.autoLastMode),
      sensitivity: pick(s.sensitivity, SENSITIVITIES, d.sensitivity),
      night: {
        enabled: bool(night.enabled, d.night.enabled),
        start: normTime(night.start, d.night.start),
        end: normTime(night.end, d.night.end)
      },
      eye: { minutes: minutes, autoOff: bool(eye.autoOff, d.eye.autoOff) },
      osd: bool(s.osd, d.osd),
      sites: sites
    };
  }

  // 快捷键「开/关 自动检测」：在 'off' 与上次使用的模式之间切换
  function toggleAutoMode(settings) {
    const s = mergeSettings(settings);
    if (s.autoDetect === 'off') {
      s.autoDetect = s.autoLastMode;
    } else {
      s.autoLastMode = s.autoDetect;
      s.autoDetect = 'off';
    }
    return s;
  }

  // ---------- 视频 key ----------

  const TRACKING_EXACT = new Set([
    'from', 'from_source', 'vd_source', 't', 'si', 'feature',
    'fbclid', 'gclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'ref_src'
  ]);

  function isTrackingParam(name) {
    const k = String(name).toLowerCase();
    return TRACKING_EXACT.has(k) || k.startsWith('utm_') || k.startsWith('spm') || k.startsWith('share');
  }

  const TWITCH_RESERVED = new Set([
    'directory', 'search', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'friends',
    'messages', 'turbo', 'prime', 'jobs', 'store', 'login', 'signup', 'downloads', 'p', 'videos',
    'following', 'payments', 'products', 'bits', 'moderator', 'popout', 'team', 'u', 'privacy', 'legal'
  ]);

  function isHost(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  function pageNum(v) {
    const n = parseInt(v, 10);
    return n >= 1 ? n : 1;
  }

  function biliBv(id, p) {
    return 'bili:BV' + id.slice(2) + ':p' + pageNum(p);
  }

  function siteKey(u, host) {
    const path = u.pathname;
    const q = u.searchParams;
    let m;

    if (host === 'youtu.be') {
      m = /^\/([\w-]+)/.exec(path);
      if (m) return 'yt:' + m[1];
    }
    if (isHost(host, 'youtube.com') || isHost(host, 'youtube-nocookie.com')) {
      if (path === '/watch' || path === '/watch/') {
        const v = q.get('v');
        if (v && /^[\w-]+$/.test(v)) return 'yt:' + v;
      }
      m = /^\/(?:shorts|live|embed|v|e)\/([\w-]+)/.exec(path);
      if (m && m[1] === 'live_stream') {
        // 频道直播嵌入 /embed/live_stream?channel=<id>：按频道区分，没有频道参数就走兜底
        const ch = q.get('channel');
        if (ch && /^[\w-]+$/.test(ch)) return 'yt:live:' + ch;
      } else if (m && m[1] !== 'videoseries') {
        return 'yt:' + m[1];
      }
    }

    if (host === 'live.bilibili.com') {
      m = /^\/(?:blanc\/|h5\/)?(\d+)/.exec(path);
      if (m) return 'blive:' + m[1];
    }
    if (host === 'player.bilibili.com') {
      const bvid = q.get('bvid');
      if (bvid && /^bv[0-9a-z]+$/i.test(bvid)) return biliBv(bvid, q.get('p') || q.get('page'));
      const aid = q.get('aid');
      if (aid && /^\d+$/.test(aid)) return 'bili:av:' + aid;
    }
    if (isHost(host, 'bilibili.com')) {
      m = /^\/(?:s\/)?video\/(bv[0-9a-z]+)/i.exec(path);
      if (m) return biliBv(m[1], q.get('p'));
      m = /^\/(?:s\/)?video\/av(\d+)/i.exec(path);
      if (m) return 'bili:av:' + m[1];
      m = /^\/bangumi\/play\/(ep|ss)(\d+)/i.exec(path);
      if (m) return 'bili:' + m[1].toLowerCase() + ':' + m[2];
      // 稍后再看、收藏列表等页面用 ?bvid= 指定当前视频
      const bvid = q.get('bvid');
      if (bvid && /^bv[0-9a-z]+$/i.test(bvid)) return biliBv(bvid, q.get('p'));
    }

    if (host === 'v.qq.com' || host === 'm.v.qq.com') {
      m = /^\/x\/cover\/[^/]+\/([^/.]+)\.html$/.exec(path);
      if (m) return 'qq:' + m[1];
      m = /^\/x\/(?:cover|page)\/([^/.]+)\.html$/.exec(path);
      if (m) return 'qq:' + m[1];
    }

    if (isHost(host, 'iqiyi.com')) {
      m = /^\/v_([0-9a-z]+)\.html/i.exec(path);
      if (m) return 'iqiyi:' + m[1];
    }

    if (host === 'clips.twitch.tv') {
      // clips.twitch.tv/<slug> 和嵌入播放器 clips.twitch.tv/embed?clip=<slug>
      const clip = /^\/embed\/?$/.test(path) ? q.get('clip') : (/^\/([\w-]+)\/?$/.exec(path) || [])[1];
      if (clip && /^[\w-]+$/.test(clip)) return 'twitch:clip:' + clip;
    } else if (host === 'player.twitch.tv') {
      const video = (q.get('video') || '').replace(/^v/, '');
      if (/^\d+$/.test(video)) return 'twitch:v:' + video;
      const ch = q.get('channel');
      if (ch && /^\w+$/.test(ch)) return 'twitch:' + ch.toLowerCase();
    } else if (isHost(host, 'twitch.tv')) {
      m = /^\/videos\/(\d+)/.exec(path);
      if (m) return 'twitch:v:' + m[1];
      // 剪辑 /<channel>/clip/<slug> 不能和频道直播共用一个 key
      m = /^\/\w+\/clip\/([\w-]+)/.exec(path);
      if (m) return 'twitch:clip:' + m[1];
      m = /^\/(\w+)(?:\/|$)/.exec(path);
      if (m && !TWITCH_RESERVED.has(m[1].toLowerCase())) return 'twitch:' + m[1].toLowerCase();
    }
    return null;
  }

  function videoKey(url) {
    let u;
    try { u = new URL(String(url)); } catch (e) { return 'u:' + String(url == null ? '' : url); }
    const known = siteKey(u, normalizeHost(u.hostname));
    if (known) return known;

    const params = [];
    u.searchParams.forEach(function (v, k) { if (!isTrackingParam(k)) params.push([k, v]); });
    params.sort(function (a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    });
    const qs = params.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
    const base = u.origin && u.origin !== 'null' ? u.origin + u.pathname : u.protocol + u.pathname;
    return 'u:' + base + (qs ? '?' + qs : '');
  }

  // ---------- 决策 ----------

  // 夜间时段 [start, end)，start > end 表示跨午夜；start === end 视为空时段
  function inNightWindow(night, minutes) {
    if (!night || !night.enabled) return false;
    const s = parseTime(night.start), e = parseTime(night.end);
    if (s == null || e == null || s === e) return false;
    return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
  }

  function validRule(v) {
    return isObj(v) && (v.s === 'on' || v.s === 'off') ? { s: v.s, t: typeof v.t === 'number' && isFinite(v.t) ? v.t : 0 } : null;
  }

  function normManual(m) {
    if (m === 'on' || m === 'off') return { state: m, reason: 'manual' };
    if (isObj(m) && (m.state === 'on' || m.state === 'off')) {
      return { state: m.state, reason: m.reason === 'eye' ? 'eye' : 'manual' };
    }
    return null;
  }

  // 先看顶层页面的域名（弹窗「本网站」编辑的就是它），再看视频所在 frame 自己的域名
  function siteRule(sites, hostname, topHostname) {
    if (!isObj(sites)) return null;
    if (topHostname) {
      const top = sites[normalizeHost(topHostname)];
      if (top === 'on' || top === 'off') return top;
    }
    const own = sites[normalizeHost(hostname)];
    if (own === 'on' || own === 'off') return own;
    return null;
  }

  /**
   * ctx: { settings, hostname, topHostname?, manual?: 'on'|'off'|{state,reason}, saved?: {s,t},
   *        autoState?: 'on'|'off', minutes?: 当天分钟数, now?: Date|ms }
   * 返回 {state, reason}，reason ∈ manual|eye|video|site|night|auto|default
   */
  function decide(ctx) {
    const c = isObj(ctx) ? ctx : {};
    const s = isObj(c.settings) ? c.settings : DEFAULT_SETTINGS;

    const manual = normManual(c.manual);
    if (manual) return manual;

    const saved = validRule(c.saved);
    if (saved) return { state: saved.s, reason: 'video' };

    const rule = siteRule(s.sites, c.hostname, c.topHostname);
    if (rule) return { state: rule, reason: 'site' };

    if (s.night && s.night.enabled) {
      const minutes = typeof c.minutes === 'number' ? c.minutes : minutesOfDay(c.now);
      if (inNightWindow(s.night, minutes)) return { state: 'off', reason: 'night' };
    }

    if (s.autoDetect !== 'off' && c.autoState === 'off') return { state: 'off', reason: 'auto' };

    return { state: s.defaultState === 'off' ? 'off' : 'on', reason: 'default' };
  }

  function reasonText(reason) {
    return REASON_TEXT[reason] || '';
  }

  function osdText(state, reason) {
    const r = REASON_OSD[reason];
    return 'RTX HDR：' + (state === 'off' ? '关' : '开') + (r ? '（' + r + '）' : '');
  }

  // ---------- 自动检测 ----------

  // Rec.709 亮度（直接作用于 8 bit 编码值）
  function analyzeFrame(data) {
    const n = data && data.length ? Math.floor(data.length / 4) : 0;
    if (!n) return { mean: 0, white: 0, black: 1 };
    let sum = 0, white = 0, black = 0;
    for (let i = 0, end = n * 4; i < end; i += 4) {
      const y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      sum += y;
      if (y > 0.85) white++;
      else if (y < 0.03) black++;
    }
    return { mean: sum / n, white: white / n, black: black / n };
  }

  // initialState === 'off'：这个视频已经判定过是白底（loadstart、换元素、改灵敏度/模式后重建检测器时），
  // 直接从 off 开始，不再先回到 HDR 闪一下
  function createAutoDetector(sensitivity, mode, initialState) {
    const th = THRESHOLDS[sensitivity] || THRESHOLDS.medium;
    const m = pick(mode, AUTO_MODES, 'disable');
    let state, brightRun, darkRun, lastSwitch;

    function reset(initial) {
      state = initial === 'off' && m !== 'off' ? 'off' : 'on';
      brightRun = 0;
      darkRun = 0;
      lastSwitch = -Infinity;
    }
    reset(initialState);

    function isBright(x) { return x.white >= th.white || x.mean >= th.mean; }
    function isDark(x) { return x.white < th.white * 0.6 && x.mean < th.mean * 0.85; }

    function update(sample, nowMs) {
      if (m === 'off' || !isObj(sample)) return state;
      const mean = +sample.mean, white = +sample.white, black = +sample.black;
      if (!isFinite(mean) || !isFinite(white)) return state;
      if (black > BLACK_FRAME) return state; // 全黑帧（转场、加载）不计入
      const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
      const x = { mean: mean, white: white };

      if (state === 'on') {
        darkRun = 0;
        brightRun = isBright(x) ? brightRun + 1 : 0;
        if (brightRun >= BRIGHT_FRAMES && now - lastSwitch >= AUTO_HOLD_MS) {
          state = 'off';
          lastSwitch = now;
          brightRun = 0;
        }
      } else if (m === 'both') {
        brightRun = 0;
        darkRun = isDark(x) ? darkRun + 1 : 0;
        if (darkRun >= DARK_FRAMES && now - lastSwitch >= AUTO_HOLD_MS) {
          state = 'on';
          lastSwitch = now;
          darkRun = 0;
        }
      }
      return state;
    }

    return {
      mode: m,
      sensitivity: THRESHOLDS[sensitivity] ? sensitivity : 'medium',
      thresholds: th,
      update: update,
      reset: function () { reset('on'); },
      get state() { return state; },
      // 'disable' 模式判定为亮之后不会再变，调用方可停止采样
      get settled() { return m === 'off' || (m === 'disable' && state === 'off'); }
    };
  }

  // ---------- 选择 ----------

  // list: [{area, playing}] → 主视频下标；没有可见视频时 -1
  function pickPrimary(list) {
    let best = -1, bestPlaying = false, bestArea = 0;
    for (let i = 0; i < (list ? list.length : 0); i++) {
      const c = list[i];
      const area = c && +c.area;
      if (!(area > 0)) continue;
      const playing = !!c.playing;
      if (best < 0 || (playing && !bestPlaying) || (playing === bestPlaying && area > bestArea)) {
        best = i;
        bestPlaying = playing;
        bestArea = area;
      }
    }
    return best;
  }

  // frames: {frameId: report}；新鲜的优先，再按「在播放」「面积」排序。
  // childMaxAgeMs > 0 时，超过这么久没有消息的子 frame（iframe 已被移除、页面已离开）直接不算；
  // 顶层 frame（0）过期了仍可兜底。
  function pickBestFrame(frames, now, staleMs, childMaxAgeMs) {
    let best = null, bestScore = null;
    if (!isObj(frames)) return null;
    for (const id of Object.keys(frames)) {
      const r = frames[id];
      const frameId = Number(id);
      if (!isObj(r) || !r.hasVideo || !Number.isInteger(frameId) || frameId < 0) continue;
      const age = now - (+r.ts || 0);
      if (frameId !== 0 && childMaxAgeMs > 0 && age > childMaxAgeMs) continue;
      const fresh = !(staleMs > 0) || age <= staleMs;
      const score = [fresh ? 1 : 0, r.playing ? 1 : 0, +r.area || 0, frameId === 0 ? 1 : 0];
      if (!bestScore || compareScore(score, bestScore) > 0) {
        best = { frameId: frameId, report: r };
        bestScore = score;
      }
    }
    return best;
  }

  function compareScore(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    return 0;
  }

  // entries: storage 对象或 [key, value] 数组；返回需要删除的 v: 键（最旧的先删）
  function pruneKeys(entries, max) {
    const limit = typeof max === 'number' && max >= 0 ? Math.floor(max) : MAX_VIDEO_ENTRIES;
    const pairs = Array.isArray(entries) ? entries : isObj(entries) ? Object.keys(entries).map(function (k) { return [k, entries[k]]; }) : [];
    const list = [];
    for (const p of pairs) {
      if (!Array.isArray(p) || typeof p[0] !== 'string' || p[0].indexOf(VIDEO_PREFIX) !== 0) continue;
      const t = isObj(p[1]) && typeof p[1].t === 'number' && isFinite(p[1].t) ? p[1].t : 0;
      list.push([p[0], t]);
    }
    if (list.length <= limit) return [];
    list.sort(function (a, b) { return a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); });
    return list.slice(0, list.length - limit).map(function (x) { return x[0]; });
  }

  function formatLuma(mean, white) {
    if (typeof mean !== 'number' || typeof white !== 'number' || !isFinite(mean) || !isFinite(white)) return '';
    return '画面亮度 ' + Math.round(mean * 100) + '% · 白色占比 ' + Math.round(white * 100) + '%';
  }

  // ---------- 关闭用的滤镜 ----------

  // 页面自己有内联 filter 时把我们的滤镜叠加在后面，关闭期间保留页面的效果；
  // 没有、是关键字或含 var() 等组合后可能失效的值时，只用我们自己的滤镜
  function offFilterFor(orig) {
    const o = String(orig == null ? '' : orig).trim();
    if (!o || /^(none|initial|inherit|unset|revert|revert-layer)$/i.test(o) || /(?:var|env|attr)\(|!/i.test(o)) return OFF_FILTER;
    return o + ' ' + OFF_FILTER;
  }

  function isOffFilter(value) {
    const v = String(value == null ? '' : value).trim();
    return v === OFF_FILTER || v.slice(-(OFF_FILTER.length + 1)) === ' ' + OFF_FILTER;
  }

  // ---------- 护眼计时（由 service worker 维护，跨视频、跨标签页累计） ----------

  function eyeState(raw) {
    const s = isObj(raw) ? raw : {};
    const n = function (x) { return typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0; };
    return { ms: n(s.ms), lastHdrAt: n(s.lastHdrAt), lastWatchAt: n(s.lastWatchAt), rest: s.rest === true };
  }

  /**
   * 把一次上报带来的增量计入护眼计时，原地修改 state（eyeState() 的结构）。
   * inc: {hdr: 主视频在播放且 HDR 没被阻止的毫秒数, watch: 主视频在播放的毫秒数（不论 HDR 开关）}
   * eye: settings.eye；now: 当前时间（ms）。
   * 返回 {remind: 到点该提醒了, restChanged: 「护眼 SDR」状态变了}
   */
  function eyeUpdate(state, inc, eye, now) {
    const s = state;
    const wasRest = s.rest;
    const e = isObj(eye) ? eye : {};
    const minutes = e.minutes > 0 ? e.minutes : 0;
    const hdr = isObj(inc) && +inc.hdr > 0 ? +inc.hdr : 0;
    const watch = Math.max(isObj(inc) && +inc.watch > 0 ? +inc.watch : 0, hdr);
    let remind = false;
    // 停止观看（暂停、关掉、离开）超过 5 分钟：计时清零，护眼 SDR 也结束
    if (!minutes || now - s.lastWatchAt > EYE_IDLE_MS) {
      s.ms = 0;
      s.rest = false;
    }
    if (watch > 0) s.lastWatchAt = now;
    if (minutes && hdr > 0) {
      // 多个标签页 / frame 同时在播时，按实际经过的时间封顶，不重复累计
      s.ms += Math.min(hdr, Math.max(0, now - s.lastHdrAt));
      s.lastHdrAt = now;
      if (s.ms >= minutes * 60000) {
        s.ms = 0;
        remind = true;
        if (e.autoOff) s.rest = true;
      }
    }
    if (!e.autoOff) s.rest = false;
    return { remind: remind, restChanged: s.rest !== wasRest };
  }

  // storage 里的护眼 SDR 标记 → 开始时间（ms）；没有就是 0
  function eyeRestAt(v) {
    if (!isObj(v) || v.on !== true) return 0;
    return typeof v.at === 'number' && isFinite(v.at) && v.at > 0 ? v.at : 1;
  }

  function eyeReminderText(minutes, autoOff, shortcut) {
    const head = '已连续观看 HDR ' + minutes + ' 分钟';
    if (!autoOff) return head + '，休息一下眼睛吧';
    return head + '，已切回 SDR，休息一下眼睛吧' +
      (shortcut ? '（按 ' + shortcut + ' 可恢复 HDR）' : '（可在扩展弹窗里恢复 HDR）');
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    REASON_TEXT: REASON_TEXT,
    AUTO_MODE_TEXT: AUTO_MODE_TEXT,
    THRESHOLDS: THRESHOLDS,
    VIDEO_PREFIX: VIDEO_PREFIX,
    MAX_VIDEO_ENTRIES: MAX_VIDEO_ENTRIES,
    AUTO_HOLD_MS: AUTO_HOLD_MS,
    OFF_FILTER: OFF_FILTER,
    EYE_IDLE_MS: EYE_IDLE_MS,
    EYE_REST_KEY: EYE_REST_KEY,
    normalizeHost: normalizeHost,
    hostOf: hostOf,
    parseTime: parseTime,
    minutesOfDay: minutesOfDay,
    mergeSettings: mergeSettings,
    toggleAutoMode: toggleAutoMode,
    isTrackingParam: isTrackingParam,
    videoKey: videoKey,
    inNightWindow: inNightWindow,
    validRule: validRule,
    decide: decide,
    reasonText: reasonText,
    osdText: osdText,
    analyzeFrame: analyzeFrame,
    createAutoDetector: createAutoDetector,
    pickPrimary: pickPrimary,
    pickBestFrame: pickBestFrame,
    pruneKeys: pruneKeys,
    formatLuma: formatLuma,
    offFilterFor: offFilterFor,
    isOffFilter: isOffFilter,
    eyeState: eyeState,
    eyeUpdate: eyeUpdate,
    eyeRestAt: eyeRestAt,
    eyeReminderText: eyeReminderText
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RtxHdrLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
