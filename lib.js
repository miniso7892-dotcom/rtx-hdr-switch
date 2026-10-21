/*
 * RTX HDR 开关 —— 纯逻辑模块。
 * 不访问 chrome / document / window：浏览器里作为内容脚本先于 content.js 注入（也被弹窗和
 * service worker 复用），Node 里通过 module.exports 导出给测试。
 * 整体包在 IIFE 里，onInstalled 重复注入到同一页面时不会因顶层 const 重复声明而报错。
 */
(function (root) {
  'use strict';

  // 界面文字表（i18n.js）：浏览器里先于 lib.js 加载，Node 里直接 require
  const I = root.RtxHdrI18n || (typeof require === 'function' ? require('./i18n.js') : null);

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
    playerButton: true,
    hdrOnly: false,
    sites: {},
    ui: { lang: 'auto', accent: '#A98BFF' },
    nv: { presets: [], nightPresetId: null, dayPresetId: null, followSdr: false, displayId: null }
  });

  // 主题色预设（弹窗「规则」里的色块）；默认薰衣紫
  const ACCENTS = deepFreeze([
    { id: 'lime', hex: '#C8FF2E' },
    { id: 'yellow', hex: '#FFE600' },
    { id: 'orange', hex: '#FF7A1A' },
    { id: 'pink', hex: '#FF5CA8' },
    { id: 'cyan', hex: '#22E1FF' },
    { id: 'lavender', hex: '#A98BFF' }
  ]);
  const DEFAULT_ACCENT = '#A98BFF';
  const UI_LANGS = ['auto', 'zh', 'en'];

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

  // ---------- NVIDIA 设置（本地组件 native-host） ----------

  const NV_HOST = 'io.github.rtx_hdr_switch';
  const NV_PROTOCOL = 1;
  const NV_MAX_PRESETS = 20;
  const NV_NAME_MAX = 24;
  const NV_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  // 0x330 里的「在视频上显示状态指示器」：0x1 HDR、0x100 超分
  const NV_INDICATOR_BITS = 0x101;
  // NVIDIA App 的取值范围；最高亮度在预设里只粗夹到 400..10000，套用时再夹到显卡实时报告的 peakMin..peakMax
  const NV_RANGES = deepFreeze({
    hdr: {
      peak: { min: 400, max: 10000 },
      middleGrey: { min: 10, max: 100 },
      contrast: { min: -100, max: 100 },
      saturation: { min: -100, max: 100 }
    },
    vsr: {
      mode: { min: 0, max: 5 }, // 0 关，1..4 手动质量级别，5 自动
      priority: { min: 0, max: 2 } // GPU 优先级 低/中/高，只在自动模式下有意义
    }
  });
  const NV_HDR_FIELDS = ['peak', 'middleGrey', 'contrast', 'saturation'];
  const NV_VSR_FIELDS = ['mode', 'priority'];
  // 0x318 errorCode（2 是 NVIDIA 自己翻错了的那句，这里写对）
  const NV_HDR_ERROR_TEXT = Object.freeze({
    1: '未检测到活动的 HDR10 显示器。',
    2: 'Windows 显示设置中未开启 HDR。',
    3: '禁用 Surround 以使用 HDR'
  });
  const NV_FIELD_TEXT = Object.freeze({
    'hdr.enabled': 'HDR',
    'hdr.peak': '最高亮度',
    'hdr.middleGrey': '中间灰',
    'hdr.contrast': '对比度',
    'hdr.saturation': '饱和度',
    'vsr.mode': '超分辨率',
    'vsr.priority': 'GPU 优先级',
    indicator: '状态指示器'
  });

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

    const ui = isObj(s.ui) ? s.ui : {};

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
      playerButton: bool(s.playerButton, d.playerButton),
      hdrOnly: bool(s.hdrOnly, d.hdrOnly),
      sites: sites,
      ui: { lang: pick(ui.lang, UI_LANGS, d.ui.lang), accent: normAccent(ui.accent) },
      nv: normNv(s.nv)
    };
  }

  // '#rgb' / '#rrggbb'（不区分大小写）→ '#RRGGBB'；不合法用默认主题色
  function normAccent(v) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v == null ? '' : v).trim());
    if (!m) return DEFAULT_ACCENT;
    const h = m[1].length === 3 ? m[1].replace(/./g, function (c) { return c + c; }) : m[1];
    return '#' + h.toUpperCase();
  }

  // 主题色上用的文字色：按相对亮度选黑字或白字（取对比度更高的那个，分界约 0.18）；
  // fg：主题色放在黑底上当文字 / 线条用时的颜色，主题色太暗就退成白色
  function accentInk(hex) {
    const accent = normAccent(hex);
    const lin = [1, 3, 5].map(function (i) {
      const c = parseInt(accent.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    const light = lum > 0.18;
    return { accent: accent, on: light ? '#0A0A0A' : '#FAFAFA', fg: light ? accent : '#FAFAFA', lum: lum };
  }

  // 数字或数字字符串 → 夹到范围内的整数；非法返回 null
  function nvInt(v, r) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && isFinite(n) ? Math.min(r.max, Math.max(r.min, Math.round(n))) : null;
  }

  // 去掉首尾空白，最多 24 个字符（按码点截断，不拆开代理对）
  function nvName(v) {
    if (typeof v !== 'string') return '';
    return Array.from(v.trim()).slice(0, NV_NAME_MAX).join('').trim();
  }

  // 预设：{id, name, hdr: {enabled?, peak, middleGrey, contrast, saturation}, vsr?: {mode, priority}}；不合法返回 null
  function normPreset(p) {
    if (!isObj(p) || !isObj(p.hdr)) return null;
    const id = typeof p.id === 'string' && NV_ID_RE.test(p.id) ? p.id : null;
    const name = nvName(p.name);
    if (!id || !name) return null;
    const hdr = {};
    if (typeof p.hdr.enabled === 'boolean') hdr.enabled = p.hdr.enabled;
    for (const k of NV_HDR_FIELDS) {
      const n = nvInt(p.hdr[k], NV_RANGES.hdr[k]);
      if (n == null) return null;
      hdr[k] = n;
    }
    const out = { id: id, name: name, hdr: hdr };
    // 超分：mode 必须有；priority 可以没有（驱动没有 GPU 优先级时存的预设）
    const mode = isObj(p.vsr) ? nvInt(p.vsr.mode, NV_RANGES.vsr.mode) : null;
    if (mode != null) {
      out.vsr = { mode: mode };
      const priority = nvInt(p.vsr.priority, NV_RANGES.vsr.priority);
      if (priority != null) out.vsr.priority = priority;
    }
    return out;
  }

  function normNv(raw) {
    const v = isObj(raw) ? raw : {};
    const presets = [];
    const ids = new Set();
    if (Array.isArray(v.presets)) {
      for (const p of v.presets) {
        if (presets.length >= NV_MAX_PRESETS) break;
        const n = normPreset(p);
        if (n && !ids.has(n.id)) {
          ids.add(n.id);
          presets.push(n);
        }
      }
    }
    // 指向已删除预设的时段设置变回「不切换」
    const ref = function (id) { return typeof id === 'string' && ids.has(id) ? id : null; };
    const displayId = typeof v.displayId === 'string' && v.displayId && v.displayId.length <= 512 ? v.displayId : null;
    return {
      presets: presets,
      nightPresetId: ref(v.nightPresetId),
      dayPresetId: ref(v.dayPresetId),
      followSdr: v.followSdr === true,
      displayId: displayId
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

  // 播放器控制栏里加 HDR 按钮的网站：按视频所在 frame 自己的域名判断（完整域名，不按后缀），
  // 路径只用来排除 YouTube 嵌入播放器（/embed/ 是另一套控制栏）。
  // 返回 'bilibili' | 'youtube' | 'twitch' | 'tencent'；其他网站（含 B 站直播、爱奇艺）返回 null
  function playerSite(hostname, pathname) {
    const h = String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/\.$/, '');
    if (h === 'www.bilibili.com' || h === 'bilibili.com' || h === 'player.bilibili.com') return 'bilibili';
    if (h === 'www.youtube.com' || h === 'youtube.com') {
      return /^\/embed(?:\/|$)/i.test(String(pathname == null ? '' : pathname)) ? null : 'youtube';
    }
    if (h === 'www.twitch.tv' || h === 'twitch.tv') return 'twitch';
    if (h === 'v.qq.com') return 'tencent';
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

  // 界面文字：lang 省略时是中文（和旧版本的输出一致）
  function tr(lang, key, params) {
    return I ? I.t(lang || 'zh', key, params) : key;
  }

  // 半角 / 全角括号：中文「（…）」，英文「 (…)」
  function paren(lang, text) {
    return lang === 'en' ? ' (' + text + ')' : '（' + text + '）';
  }

  function reasonText(reason, lang) {
    return REASON_TEXT[reason] ? tr(lang, 'reason.' + reason) : '';
  }

  function osdText(state, reason, lang) {
    const st = tr(lang, state === 'off' ? 'osd.off' : 'osd.on');
    const r = !REASON_OSD[reason] ? '' : reason === 'auto' ? tr(lang, 'osd.reason.auto') : tr(lang, 'reason.' + reason);
    return r ? tr(lang, 'osd.stateReason', { state: st, reason: r }) : tr(lang, 'osd.state', { state: st });
  }

  function autoModeText(mode, lang) {
    return AUTO_MODE_TEXT[mode] ? tr(lang, 'autoMode.' + mode) : '';
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

  function formatLuma(mean, white, lang) {
    if (typeof mean !== 'number' || typeof white !== 'number' || !isFinite(mean) || !isFinite(white)) return '';
    return tr(lang, 'luma', { mean: Math.round(mean * 100), white: Math.round(white * 100) });
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

  function eyeReminderText(minutes, autoOff, shortcut, lang) {
    const head = tr(lang, 'eye.head', { minutes: minutes });
    if (!autoOff) return head + tr(lang, 'eye.rest');
    return head + tr(lang, 'eye.restOff') +
      (shortcut ? tr(lang, 'eye.restoreKey', { key: shortcut }) : tr(lang, 'eye.restorePopup'));
  }

  // ---------- NVIDIA 设置 ----------

  function nvFail(code, extra) {
    return { ok: false, error: Object.assign({ code: code }, extra) };
  }

  /**
   * 本地组件返回的 State → 字段齐全的新对象（不合法返回 null）。读数保持原值，只补默认值：
   * {hdr: {supported, enabled, active, error, peak, peakMin, peakMax, middleGrey, contrast, saturation},
   *  vsr: {supported, mode, level, priority}, indicator, flags}
   * 驱动没有 0x32F / 0x330 时本地组件回 null：vsr.priority、indicator、flags 保持 null（界面隐藏对应控件）
   */
  function nvNormState(raw) {
    if (!isObj(raw) || !isObj(raw.hdr) || !isObj(raw.vsr)) return null;
    const h = raw.hdr, v = raw.vsr;
    const int = function (x, d) { return Number.isInteger(x) ? x : d; };
    const peakMin = int(h.peakMin, 0) > 0 ? h.peakMin : NV_RANGES.hdr.peak.min;
    const peak = int(h.peak, peakMin);
    const peakMax = int(h.peakMax, 0) >= peakMin ? h.peakMax : Math.max(peakMin, peak);
    const flags = int(raw.flags, -1) >= 0 ? raw.flags : null;
    return {
      hdr: {
        supported: h.supported === true,
        enabled: h.enabled === true,
        active: h.active === true,
        error: int(h.error, 0) > 0 ? h.error : 0,
        peak: peak,
        peakMin: peakMin,
        peakMax: peakMax,
        middleGrey: int(h.middleGrey, 50),
        contrast: int(h.contrast, 0),
        saturation: int(h.saturation, 0)
      },
      vsr: {
        supported: v.supported === true,
        mode: int(v.mode, 0),
        level: int(v.level, 0),
        priority: int(v.priority, null)
      },
      indicator: typeof raw.indicator === 'boolean' ? raw.indicator : flags === null ? null : (flags & NV_INDICATOR_BITS) !== 0,
      flags: flags
    };
  }

  /**
   * 检查一次 set 的参数（与本地组件的校验一致：全部字段先校验，任何一个不合法整个请求作废；只收整数）。
   * patch: {hdr?: {enabled?, peak?, middleGrey?, contrast?, saturation?}, vsr?: {mode?, priority?}, indicator?, commit?}
   * state: 当前 State（可省略）。给了就按实时的 peakMin..peakMax 检查最高亮度，并拒绝不支持 / HDR 出错时的写入。
   * 返回 {ok: true, patch: 只含已知字段的新对象} 或 {ok: false, error: {code, field?, …}}
   */
  function nvValidatePatch(patch, state) {
    if (!isObj(patch)) return nvFail('bad-request', { message: 'patch 必须是对象' });
    const st = state == null ? null : nvNormState(state);
    const out = {};
    const groups = [['hdr', NV_HDR_FIELDS], ['vsr', NV_VSR_FIELDS]];
    for (const g of groups) {
      const name = g[0];
      const src = patch[name];
      if (src === undefined) continue;
      if (!isObj(src)) return nvFail('range', { field: name });
      const o = {};
      if (name === 'hdr' && src.enabled !== undefined) {
        if (typeof src.enabled !== 'boolean') return nvFail('range', { field: 'hdr.enabled' });
        o.enabled = src.enabled;
      }
      for (const k of g[1]) {
        const x = src[k];
        if (x === undefined) continue;
        let r = NV_RANGES[name][k];
        if (name === 'hdr' && k === 'peak' && st) r = { min: st.hdr.peakMin, max: st.hdr.peakMax };
        if (!Number.isInteger(x) || x < r.min || x > r.max) {
          return nvFail('range', { field: name + '.' + k, min: r.min, max: r.max });
        }
        o[k] = x;
      }
      if (Object.keys(o).length) out[name] = o;
    }
    for (const k of ['indicator', 'commit']) {
      if (patch[k] === undefined) continue;
      if (typeof patch[k] !== 'boolean') return nvFail('range', { field: k });
      out[k] = patch[k];
    }
    if (st) {
      if (out.hdr && !st.hdr.supported) return nvFail('unsupported', { field: 'hdr' });
      if (out.hdr && st.hdr.error) return nvFail('hdr-error', { errorCode: st.hdr.error });
      if (out.vsr && !st.vsr.supported) return nvFail('unsupported', { field: 'vsr' });
      if (out.vsr && out.vsr.priority !== undefined && st.vsr.priority === null) return nvFail('unsupported', { field: 'vsr.priority' });
      if (out.indicator !== undefined && st.indicator === null) return nvFail('unsupported', { field: 'indicator' });
    }
    return { ok: true, patch: out };
  }

  // 两次 set 合并成一次（b 覆盖 a；任何一次要 commit 就 commit）；都不是对象时返回 null
  function nvMergePatch(a, b) {
    if (!isObj(a) && !isObj(b)) return null;
    const A = isObj(a) ? a : {}, B = isObj(b) ? b : {};
    const out = Object.assign({}, A, B);
    for (const k of ['hdr', 'vsr']) {
      if (isObj(A[k]) || isObj(B[k])) out[k] = Object.assign({}, isObj(A[k]) ? A[k] : null, isObj(B[k]) ? B[k] : null);
    }
    if (A.commit === true || B.commit === true) out.commit = true;
    return out;
  }

  // 乐观更新：把 patch 套到 state 上得到新 State（不改输入）
  function nvApplyPatch(state, patch) {
    const st = nvNormState(state);
    if (!st) return null;
    const p = isObj(patch) ? patch : {};
    if (isObj(p.hdr)) {
      if (typeof p.hdr.enabled === 'boolean') st.hdr.enabled = p.hdr.enabled;
      for (const k of NV_HDR_FIELDS) if (Number.isInteger(p.hdr[k])) st.hdr[k] = p.hdr[k];
    }
    if (isObj(p.vsr)) for (const k of NV_VSR_FIELDS) if (Number.isInteger(p.vsr[k])) st.vsr[k] = p.vsr[k];
    if (typeof p.indicator === 'boolean' && st.indicator !== null) {
      st.indicator = p.indicator;
      st.flags = p.indicator ? (st.flags | NV_INDICATOR_BITS) : (st.flags & ~NV_INDICATOR_BITS);
    }
    return st;
  }

  // 当前设置存成预设（不支持超分时不带 vsr）；state 或名称不合法返回 null
  function nvPresetFromState(state, name, id) {
    const st = nvNormState(state);
    if (!st) return null;
    const h = st.hdr;
    const raw = {
      id: id,
      name: name,
      hdr: { enabled: h.enabled, peak: h.peak, middleGrey: h.middleGrey, contrast: h.contrast, saturation: h.saturation }
    };
    if (st.vsr.supported) raw.vsr = { mode: st.vsr.mode, priority: st.vsr.priority };
    return normPreset(raw); // priority 为 null（驱动没有）时 normPreset 会去掉它
  }

  /**
   * 套用预设要发的 set（commit:true）。最高亮度再夹到实时的 peakMin..peakMax；
   * 显卡不支持或 HDR 出错（errorCode≠0）的部分跳过。什么都写不了时返回 null。
   */
  function nvPresetPatch(preset, state) {
    const p = normPreset(preset);
    const st = nvNormState(state);
    if (!p || !st) return null;
    const out = {};
    if (st.hdr.supported && !st.hdr.error) {
      const h = {};
      if (typeof p.hdr.enabled === 'boolean') h.enabled = p.hdr.enabled;
      h.peak = Math.min(st.hdr.peakMax, Math.max(st.hdr.peakMin, p.hdr.peak));
      h.middleGrey = p.hdr.middleGrey;
      h.contrast = p.hdr.contrast;
      h.saturation = p.hdr.saturation;
      out.hdr = h;
    }
    if (p.vsr && st.vsr.supported) {
      out.vsr = { mode: p.vsr.mode };
      if (p.vsr.priority !== undefined && st.vsr.priority !== null) out.vsr.priority = p.vsr.priority;
    }
    if (!out.hdr && !out.vsr) return null;
    out.commit = true;
    return out;
  }

  // 按夜间护眼的时段分「夜间 / 其余时间」，与夜间护眼开关无关；时段为空（起止相同）时总是 'day'
  function nvSchedulePhase(nightCfg, minutes) {
    const n = isObj(nightCfg) ? nightCfg : {};
    const m = typeof minutes === 'number' ? minutes : minutesOfDay(minutes);
    return inNightWindow({ enabled: true, start: n.start, end: n.end }, m) ? 'night' : 'day';
  }

  // 快捷键「下一个预设」：currentId 的下一个（循环）；找不到 currentId 时从第一个开始；没有预设返回 null
  function nvNextPresetId(presets, currentId) {
    const ids = Array.isArray(presets) ? presets.filter(isObj).map(function (p) { return p.id; }) : [];
    if (!ids.length) return null;
    const i = ids.indexOf(currentId);
    return ids[(i + 1) % ids.length];
  }

  // 「预设 N」里第一个没被占用的 N
  function nvDefaultPresetName(presets, lang) {
    const used = new Set(Array.isArray(presets) ? presets.filter(isObj).map(function (p) { return p.name; }) : []);
    let n = 1;
    while (used.has(tr(lang, 'nv.presetDefault', { n: n }))) n++;
    return tr(lang, 'nv.presetDefault', { n: n });
  }

  function nvHdrErrorText(code, lang) {
    if (NV_HDR_ERROR_TEXT[code]) return tr(lang, 'nv.hdrErr.' + code);
    return code ? tr(lang, 'nv.hdrErr.other', { code: code }) : '';
  }

  // chrome.runtime.lastError.message → 统一的错误回复
  function nvPortError(message) {
    const m = String(message == null ? '' : message);
    let code = 'host-error';
    if (!m || /exited/i.test(m)) code = 'host-exit';
    else if (/not found/i.test(m)) code = 'host-missing';
    else if (/forbidden/i.test(m)) code = 'host-forbidden';
    return nvFail(code, m ? { message: m } : undefined);
  }

  function nvErrorText(err, lang) {
    const e = isObj(err) ? err : { code: err };
    switch (e.code) {
      // host-forbidden 只在扩展 ID 不在本地组件清单的 allowed_origins 里时出现，重新运行 install.cmd 解决不了
      case 'host-missing':
      case 'host-forbidden':
      case 'host-exit':
      case 'host-error':
      case 'timeout':
      case 'protocol':
      case 'old-host':
      case 'no-dll':
      case 'init':
      case 'bad-request':
      case 'internal':
        return tr(lang, 'nv.err.' + e.code);
      case 'api': return tr(lang, 'nv.err.api', { rc: e.rc != null ? paren(lang, 'rc=' + e.rc) : '' });
      case 'range': {
        const name = !e.field ? '' : NV_FIELD_TEXT[e.field] ? tr(lang, 'nv.field.' + e.field) : e.field;
        return tr(lang, 'nv.err.range', { field: name ? paren(lang, name) : '' });
      }
      case 'unsupported':
        return tr(lang, ['vsr', 'hdr', 'vsr.priority', 'indicator'].indexOf(e.field) >= 0 ? 'nv.err.unsupported.' + e.field : 'nv.err.unsupported');
      case 'hdr-error': return nvHdrErrorText(e.errorCode, lang) || tr(lang, 'nv.err.hdr-error');
      default: return tr(lang, 'nv.err.unknown', { code: e.code ? paren(lang, e.code) : '' });
    }
  }

  // ---------- Windows SDR 亮度 → 建议值 ----------

  // sRGB 编码值 128/255 的线性亮度：让 RTX 视频 HDR 的 50% 灰和桌面上的 50% 灰一样亮
  const K_MID = 0.2158;
  const SUGGEST_CONTRAST = 25; // 伽马约 2.2，和 Windows 显示 SDR 内容的曲线接近
  const SUGGEST_PEAK_CAP = 1000; // 驱动实测输出到约 1000 尼特为止

  // 本地组件 display 命令里的一项 → 规范化对象；不合法返回 null
  function nvNormDisplay(raw) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
    const nits = typeof raw.sdrWhiteNits === 'number' && isFinite(raw.sdrWhiteNits) && raw.sdrWhiteNits > 0 ? raw.sdrWhiteNits : null;
    let slider = Number.isInteger(raw.sdrSlider) ? raw.sdrSlider : null;
    if (slider === null && nits !== null) slider = Math.round((nits - 80) / 4);
    return {
      id: raw.id.slice(0, 512),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 64) : '',
      hdrSupported: raw.hdrSupported === true,
      hdrEnabled: raw.hdrEnabled === true,
      sdrWhiteNits: nits,
      sdrSlider: slider === null ? null : Math.min(100, Math.max(0, slider)),
      bitsPerColor: Number.isInteger(raw.bitsPerColor) ? raw.bitsPerColor : null
    };
  }

  // 记住的显示器 → 第一个开着 HDR 的 → 第一个
  function nvPickDisplay(displays, id) {
    const list = Array.isArray(displays) ? displays.map(nvNormDisplay).filter(Boolean) : [];
    if (!list.length) return null;
    return list.find(function (d) { return d.id === id; }) ||
      list.find(function (d) { return d.hdrEnabled; }) || list[0];
  }

  /**
   * 按 Windows SDR 白电平给出 RTX 视频 HDR 的建议值（不碰饱和度）：
   * 中间灰 = SDR 白 × 0.2158（夹到 10..100），最高亮度 = min(上限, 1000)，对比度 +25。
   * display 没开 HDR 或读不到白电平时返回 null；state 省略时最高亮度不按显卡范围夹
   */
  function nvSuggest(display, state) {
    const d = nvNormDisplay(display);
    if (!d || !d.hdrEnabled || d.sdrWhiteNits === null) return null;
    const st = state == null ? null : nvNormState(state);
    const mg = NV_RANGES.hdr.middleGrey;
    let peak = SUGGEST_PEAK_CAP;
    if (st) peak = Math.min(st.hdr.peakMax, Math.max(st.hdr.peakMin, Math.min(st.hdr.peakMax, SUGGEST_PEAK_CAP)));
    return {
      middleGrey: Math.min(mg.max, Math.max(mg.min, Math.round(d.sdrWhiteNits * K_MID))),
      peak: peak,
      contrast: SUGGEST_CONTRAST
    };
  }

  // 中间灰快捷键：当前值 ± step，夹到 10..100；没变（已到头）时 changed 为 false
  function nvMgStep(state, delta) {
    const st = nvNormState(state);
    if (!st) return null;
    const r = NV_RANGES.hdr.middleGrey;
    const value = Math.min(r.max, Math.max(r.min, st.hdr.middleGrey + (Number(delta) || 0)));
    return { value: value, changed: value !== st.hdr.middleGrey };
  }

  // ---------- 备份 ----------

  const BACKUP_FORMAT = 'rtx-hdr-switch-backup';
  const BACKUP_VERSION = 1;

  // storage.local 的全部内容 → 备份对象：设置（规范化过）+ 按视频的记忆；不含护眼状态、会话数据
  function makeBackup(all, extVersion, nowMs) {
    const src = isObj(all) ? all : {};
    const videos = {};
    for (const k of Object.keys(src)) {
      if (k.indexOf(VIDEO_PREFIX) !== 0 || k.length <= VIDEO_PREFIX.length) continue;
      const r = validRule(src[k]);
      if (r) videos[k.slice(VIDEO_PREFIX.length)] = r;
    }
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString(),
      extensionVersion: String(extVersion || ''),
      settings: mergeSettings(src.settings),
      videos: videos
    };
  }

  /**
   * 检查并规范化备份文件内容。成功：{ok, settings, videos: {key: {s,t}}, summary: {videos, presets, sites},
   * exportedAt, extensionVersion}；失败：{ok:false, code:'invalid'|'newer'}。
   * 视频记忆超过上限时只留最新的那些
   */
  function validateBackup(obj) {
    if (!isObj(obj) || obj.format !== BACKUP_FORMAT || !Number.isInteger(obj.version)) return { ok: false, code: 'invalid' };
    if (obj.version > BACKUP_VERSION) return { ok: false, code: 'newer' };
    if (obj.version < 1 || !isObj(obj.settings)) return { ok: false, code: 'invalid' };
    const settings = mergeSettings(obj.settings);
    const videos = {};
    if (isObj(obj.videos)) {
      for (const k of Object.keys(obj.videos)) {
        const r = validRule(obj.videos[k]);
        if (r && k && k.length <= 2048) videos[k] = r;
      }
    }
    const drop = pruneKeys(Object.keys(videos).map(function (k) { return [VIDEO_PREFIX + k, videos[k]]; }), MAX_VIDEO_ENTRIES);
    for (const id of drop) delete videos[id.slice(VIDEO_PREFIX.length)];
    return {
      ok: true,
      settings: settings,
      videos: videos,
      summary: { videos: Object.keys(videos).length, presets: settings.nv.presets.length, sites: Object.keys(settings.sites).length },
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt.slice(0, 40) : '',
      extensionVersion: typeof obj.extensionVersion === 'string' ? obj.extensionVersion.slice(0, 20) : ''
    };
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ACCENTS: ACCENTS,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    UI_LANGS: UI_LANGS,
    REASON_TEXT: REASON_TEXT,
    AUTO_MODE_TEXT: AUTO_MODE_TEXT,
    t: tr,
    autoModeText: autoModeText,
    normAccent: normAccent,
    accentInk: accentInk,
    K_MID: K_MID,
    nvNormDisplay: nvNormDisplay,
    nvPickDisplay: nvPickDisplay,
    nvSuggest: nvSuggest,
    nvMgStep: nvMgStep,
    BACKUP_FORMAT: BACKUP_FORMAT,
    BACKUP_VERSION: BACKUP_VERSION,
    makeBackup: makeBackup,
    validateBackup: validateBackup,
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
    playerSite: playerSite,
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
    eyeReminderText: eyeReminderText,
    NV_HOST: NV_HOST,
    NV_PROTOCOL: NV_PROTOCOL,
    NV_MAX_PRESETS: NV_MAX_PRESETS,
    NV_NAME_MAX: NV_NAME_MAX,
    NV_RANGES: NV_RANGES,
    nvNormState: nvNormState,
    nvValidatePatch: nvValidatePatch,
    nvMergePatch: nvMergePatch,
    nvApplyPatch: nvApplyPatch,
    nvPresetFromState: nvPresetFromState,
    nvPresetPatch: nvPresetPatch,
    nvSchedulePhase: nvSchedulePhase,
    nvNextPresetId: nvNextPresetId,
    nvDefaultPresetName: nvDefaultPresetName,
    nvHdrErrorText: nvHdrErrorText,
    nvPortError: nvPortError,
    nvErrorText: nvErrorText
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RtxHdrLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
