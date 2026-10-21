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

  // 'fullscreen'：只在全屏时开（defaultState 和网站规则都可以设）
  const STATES = ['on', 'off', 'fullscreen'];
  const SITE_RULES = ['on', 'off', 'fullscreen'];
  const AUTO_MODES = ['off', 'disable', 'both'];
  const SENSITIVITIES = ['low', 'medium', 'high'];
  // 播放器按钮的设置面板：悬停打开 / 右键打开 / 不用
  const PANEL_MODES = ['hover', 'right', 'off'];
  const VIDEO_PREFIX = 'v:';
  const MAX_VIDEO_ENTRIES = 2000;
  const NV_SITE_PRESETS_MAX = 200;

  const DEFAULT_SETTINGS = deepFreeze({
    defaultState: 'on',
    fullscreenWeb: true,
    rememberManual: true,
    autoDetect: 'disable',
    autoLastMode: 'disable',
    sensitivity: 'medium',
    night: { enabled: false, start: '23:00', end: '07:00' },
    eye: { minutes: 45, autoOff: false },
    osd: true,
    playerButton: true,
    playerPanel: 'hover',
    hdrOnly: false,
    updateCheck: true,
    sites: {},
    ui: { lang: 'auto', accent: '#A98BFF' },
    nv: { presets: [], nightPresetId: null, dayPresetId: null, followSdr: false, displayId: null, sitePresets: {} }
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
    tab: '本标签页沿用',
    fullscreen: '仅全屏',
    // 以下两个不是决策结果，而是「想关但关不掉」的说明
    drm: '受版权保护，无法控制',
    contested: '页面不断改写视频样式，无法关闭'
  });
  const REASON_OSD = Object.freeze(Object.assign({}, REASON_TEXT, { auto: '检测到白底' }));

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

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  // JSON 能表示的值的深拷贝
  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  // 按码点截断（不拆开代理对）
  function cut(s, max) {
    return Array.from(String(s)).slice(0, max).join('');
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

    const ui = isObj(s.ui) ? s.ui : {};

    return {
      defaultState: pick(defaultState, STATES, d.defaultState),
      fullscreenWeb: bool(s.fullscreenWeb, d.fullscreenWeb),
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
      playerPanel: pick(s.playerPanel, PANEL_MODES, d.playerPanel),
      hdrOnly: bool(s.hdrOnly, d.hdrOnly),
      updateCheck: bool(s.updateCheck, d.updateCheck),
      sites: normSites(s.sites, Infinity),
      ui: { lang: pick(ui.lang, UI_LANGS, d.ui.lang), accent: normAccent(ui.accent) },
      nv: normNv(s.nv)
    };
  }

  // 网站规则 {host: 'on'|'off'|'fullscreen'}：域名规范化后重复的以后出现的为准；最多 max 个域名
  function normSites(raw, max) {
    const out = {};
    if (!isObj(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      const host = normalizeHost(k);
      const v = raw[k];
      if (!host || host === '__proto__' || SITE_RULES.indexOf(v) < 0) continue;
      if (!hasOwn(out, host)) {
        if (n >= max) continue;
        n++;
      }
      out[host] = v;
    }
    return out;
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
    // 按网站切换的预设 {host: presetId}：同样丢掉指向已删除预设的条目
    const sitePresets = {};
    if (isObj(v.sitePresets)) {
      let n = 0;
      for (const k of Object.keys(v.sitePresets)) {
        const host = normalizeHost(k);
        const id = ref(v.sitePresets[k]);
        if (!host || host === '__proto__' || host.length > 253 || !id) continue;
        if (!hasOwn(sitePresets, host)) {
          if (n >= NV_SITE_PRESETS_MAX) continue;
          n++;
        }
        sitePresets[host] = id;
      }
    }
    return {
      presets: presets,
      nightPresetId: ref(v.nightPresetId),
      dayPresetId: ref(v.dayPresetId),
      followSdr: v.followSdr === true,
      displayId: displayId,
      sitePresets: sitePresets
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

  // ---------- 设置补丁（只有 background 写 settings，其他页面提交补丁） ----------

  // 按键合并的「表」：补丁里的值为 null 表示删除这个键，其余对象递归合并，数组和标量整体替换
  const SETTINGS_MAPS = ['sites', 'nv.sitePresets'];

  function mergePatch(base, patch, path) {
    const out = isObj(base) ? Object.assign({}, base) : {};
    for (const k of Object.keys(patch)) {
      if (k === '__proto__') continue;
      const p = path ? path + '.' + k : k;
      const v = patch[k];
      if (SETTINGS_MAPS.indexOf(p) >= 0 && isObj(v)) {
        const m = isObj(out[k]) ? Object.assign({}, out[k]) : {};
        for (const raw of Object.keys(v)) {
          const h = normalizeHost(raw);
          if (!h || h === '__proto__') continue;
          if (v[raw] === null) delete m[h];
          else m[h] = v[raw];
        }
        out[k] = m;
      } else if (isObj(v) && isObj(out[k])) {
        out[k] = mergePatch(out[k], v, p);
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  }

  /**
   * 把补丁套到设置上，结果再过 mergeSettings。patch 为 null/undefined 时只做规范化；
   * 不是对象时返回 null。不修改输入
   */
  function applySettingsPatch(cur, patch) {
    if (patch == null) return mergeSettings(cur);
    if (!isObj(patch)) return null;
    return mergeSettings(mergePatch(mergeSettings(cur), patch, ''));
  }

  function diffSettings(a, b, path) {
    const out = {};
    let any = false;
    const keys = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !hasOwn(a, k); }));
    for (const k of keys) {
      const p = path ? path + '.' + k : k;
      const x = a[k], y = b[k];
      if (SETTINGS_MAPS.indexOf(p) >= 0) {
        const xa = isObj(x) ? x : {}, yb = isObj(y) ? y : {};
        const m = {};
        let changed = false;
        for (const h of Object.keys(xa)) if (!hasOwn(yb, h)) { m[h] = null; changed = true; }
        for (const h of Object.keys(yb)) if (xa[h] !== yb[h]) { m[h] = yb[h]; changed = true; }
        if (changed) { out[k] = m; any = true; }
      } else if (isObj(x) && isObj(y)) {
        const d = diffSettings(x, y, p);
        if (d) { out[k] = d; any = true; }
      } else if (JSON.stringify(x) !== JSON.stringify(y)) {
        out[k] = clone(y);
        any = true;
      }
    }
    return any ? out : null;
  }

  // 最小补丁：applySettingsPatch(prev, 结果) 与 mergeSettings(next) 相等；没有差别返回 null
  function settingsPatchFor(prev, next) {
    return diffSettings(mergeSettings(prev), mergeSettings(next), '');
  }

  function joinPatch(a, b) {
    const out = {};
    for (const k of Object.keys(a)) if (k !== '__proto__') out[k] = a[k];
    for (const k of Object.keys(b)) {
      if (k === '__proto__') continue;
      out[k] = isObj(b[k]) && isObj(out[k]) ? joinPatch(out[k], b[k]) : clone(b[k]);
    }
    return out;
  }

  /**
   * 两个补丁合并成一个（b 在后）：对象递归合并，网站表里的 null（删除）照样保留，数组和标量整体替换。
   * 先套 a 再套 b 与套一次合并结果相同。两个都不是对象时返回 null；不修改输入
   */
  function mergeSettingsPatch(a, b) {
    if (!isObj(a) && !isObj(b)) return null;
    return joinPatch(isObj(a) ? clone(a) : {}, isObj(b) ? b : {});
  }

  // 播放器 frame（内容脚本、面板）能改的字段；网站相关的只能改顶层页面自己那一条
  const CONTENT_PATCH_FIELDS = Object.freeze({
    autoDetect: AUTO_MODES,
    autoLastMode: ['disable', 'both'],
    sensitivity: SENSITIVITIES,
    playerButton: [true, false],
    playerPanel: PANEL_MODES
  });

  function onlyHostEntry(map, host, okValue) {
    if (!host || host === '__proto__' || !isObj(map)) return null;
    const keys = Object.keys(map);
    if (keys.length !== 1 || normalizeHost(keys[0]) !== host || !okValue(map[keys[0]])) return null;
    const out = {};
    out[host] = map[keys[0]];
    return out;
  }

  /**
   * 检查播放器 frame 提交的设置补丁：只放行白名单字段，sites / nv.sitePresets 只能有 topHost 这一个键。
   * nv.sitePresets 会让 background 进入网站时写 NVIDIA，只有面板（扩展页面，sitePreset 为 true）能改，内容脚本不能。
   * 出现任何其他字段或非法值就整单拒绝。返回 {ok:true, patch: 规范化后的新对象} 或 {ok:false, code:'forbidden'}
   */
  function contentPatchAllowed(patch, topHost, sitePreset) {
    const no = { ok: false, code: 'forbidden' };
    if (!isObj(patch)) return no;
    const host = normalizeHost(topHost);
    const out = {};
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (hasOwn(CONTENT_PATCH_FIELDS, k)) {
        if (CONTENT_PATCH_FIELDS[k].indexOf(v) < 0) return no;
        out[k] = v;
      } else if (k === 'sites') {
        const m = onlyHostEntry(v, host, function (x) { return x === null || SITE_RULES.indexOf(x) >= 0; });
        if (!m) return no;
        out.sites = m;
      } else if (k === 'nv' && sitePreset === true) {
        if (!isObj(v) || Object.keys(v).length !== 1 || !hasOwn(v, 'sitePresets')) return no;
        const m = onlyHostEntry(v.sitePresets, host, function (x) { return x === null || (typeof x === 'string' && NV_ID_RE.test(x)); });
        if (!m) return no;
        out.nv = { sitePresets: m };
      } else {
        return no;
      }
    }
    return { ok: true, patch: out };
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
  // 返回 'bilibili' | 'youtube' | 'twitch' | 'tencent'；其他网站（含 B 站直播、爱奇艺）返回 null。
  // PLAYER_HOSTS 是完整域名 → 网站的表，面板的 web_accessible_resources 和测试也从它派生
  const PLAYER_HOSTS = Object.freeze({
    'www.bilibili.com': 'bilibili',
    'bilibili.com': 'bilibili',
    'player.bilibili.com': 'bilibili',
    'www.youtube.com': 'youtube',
    'youtube.com': 'youtube',
    'www.twitch.tv': 'twitch',
    'twitch.tv': 'twitch',
    'v.qq.com': 'tencent'
  });

  function playerSite(hostname, pathname) {
    const h = String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/\.$/, '');
    const site = hasOwn(PLAYER_HOSTS, h) ? PLAYER_HOSTS[h] : null;
    if (site === 'youtube' && /^\/embed(?:\/|$)/i.test(String(pathname == null ? '' : pathname))) return null;
    return site;
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
    const ok = function (v) { return typeof v === 'string' && SITE_RULES.indexOf(v) >= 0; };
    if (topHostname) {
      const top = sites[normalizeHost(topHostname)];
      if (ok(top)) return top;
    }
    const own = sites[normalizeHost(hostname)];
    if (ok(own)) return own;
    return null;
  }

  /**
   * ctx: { settings, hostname, topHostname?, manual?: 'on'|'off'|{state,reason}, tab?: 'on'|'off',
   *        saved?: {s,t}, fullscreen?: bool, autoState?: 'on'|'off', minutes?: 当天分钟数, now?: Date|ms }
   * 优先级：手动 / 护眼 > 本标签页沿用 > 记住的视频 > 网站规则 > 夜间 > 白底检测 > 默认。
   * 网站规则和默认都可以是「仅全屏」：状态取 ctx.fullscreen，reason 分别是 site / fullscreen。
   * 返回 {state, reason}，reason ∈ manual|eye|tab|video|site|night|auto|default|fullscreen
   */
  function decide(ctx) {
    const c = isObj(ctx) ? ctx : {};
    const s = isObj(c.settings) ? c.settings : DEFAULT_SETTINGS;
    const fs = c.fullscreen === true ? 'on' : 'off';

    const manual = normManual(c.manual);
    if (manual) return manual;

    if (c.tab === 'on' || c.tab === 'off') return { state: c.tab, reason: 'tab' };

    const saved = validRule(c.saved);
    if (saved) return { state: saved.s, reason: 'video' };

    const rule = siteRule(s.sites, c.hostname, c.topHostname);
    if (rule) return { state: rule === 'fullscreen' ? fs : rule, reason: 'site' };

    if (s.night && s.night.enabled) {
      const minutes = typeof c.minutes === 'number' ? c.minutes : minutesOfDay(c.now);
      if (inNightWindow(s.night, minutes)) return { state: 'off', reason: 'night' };
    }

    if (s.autoDetect !== 'off' && c.autoState === 'off') return { state: 'off', reason: 'auto' };

    if (s.defaultState === 'fullscreen') return { state: fs, reason: 'fullscreen' };
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

  // 「只关 HDR」对这个 frame 生效吗：模式在工作，而且 background 借开关时看的就是它
  // （当前窗口当前标签页里有主视频的 frame）。其他窗口里想关的视频照常加滤镜。
  function hdrOnlyApplies(status, tabId, frameId) {
    return !!(isObj(status) && status.active === true && Number.isInteger(tabId) && tabId >= 0 &&
      status.tabId === tabId && status.frameId === frameId);
  }

  /**
   * 父页面把 iframe 设为全屏时（顶层报告带 fsFrame），该通知哪个子 frame：返回 frameId，不用通知时返回 -1。
   * 某个新鲜的子 frame 自己报告了 fullscreen（它自己就知道）时也返回 -1。
   */
  function fsHintTarget(frames, now, staleMs, childMaxAgeMs) {
    if (!isObj(frames) || !isObj(frames[0]) || frames[0].fsFrame !== true) return -1;
    const children = {};
    for (const id of Object.keys(frames)) {
      const frameId = Number(id);
      const r = frames[id];
      if (!Number.isInteger(frameId) || frameId <= 0 || !isObj(r)) continue;
      const fresh = !(staleMs > 0) || now - (+r.ts || 0) <= staleMs;
      if (fresh && r.fullscreen === true) return -1;
      children[id] = r;
    }
    const best = pickBestFrame(children, now, staleMs, childMaxAgeMs);
    return best ? best.frameId : -1;
  }

  // ---------- 按住对比、本标签页沿用 ----------

  // 按住多久算「按住对比」；命令 peek 对比多久；对比最长多久（防止松开事件丢失）
  const PEEK_HOLD_MS = 300;
  const PEEK_CMD_MS = 5000;
  const PEEK_MAX_MS = 30000;

  /**
   * 短按 / 长按手势（纯状态机，计时由调用方 setTimeout(holdMs) 后调 due）：
   * down(now) 按下（已按下时忽略并返回 null）；due(now) 到阈值时只返回一次 'hold'；
   * up(now) 已进入按住返回 'release'，否则 'tap'；cancel() 已进入按住返回 'release'，否则 null
   */
  function createHoldGesture(holdMs) {
    const ms = typeof holdMs === 'number' && holdMs > 0 ? holdMs : PEEK_HOLD_MS;
    let downAt = null, held = false;

    function reset() {
      const was = held;
      downAt = null;
      held = false;
      return was;
    }

    return {
      holdMs: ms,
      down: function (now) {
        if (downAt !== null) return null;
        downAt = typeof now === 'number' ? now : 0;
        held = false;
        return 'down';
      },
      due: function (now) {
        if (downAt === null || held || !(now - downAt >= ms)) return null;
        held = true;
        return 'hold';
      },
      up: function () {
        if (downAt === null) return null;
        return reset() ? 'release' : 'tap';
      },
      cancel: function () {
        if (downAt === null) return null;
        return reset() ? 'release' : null;
      },
      get pressed() { return downAt !== null; },
      get held() { return held; }
    };
  }

  /**
   * 屏幕提示上要不要提议「本标签页后续视频沿用」：上一次手动切换是另一个视频、同一个状态，且还没有沿用。
   * last: {key, state}（上一次手动切换）；key / state：这一次
   */
  function tabOffer(last, key, state, sticky) {
    if (sticky || !isObj(last) || typeof key !== 'string' || !key) return false;
    if (state !== 'on' && state !== 'off') return false;
    return typeof last.key === 'string' && last.key !== '' && last.key !== key && last.state === state;
  }

  /**
   * 浮层放在按钮正上方：水平居中，左右离 root 边缘至少 margin；高度不超过按钮上方的可用空间。
   * btn / root：{left, top, width, height}（getBoundingClientRect 的结果）；返回 {x, y, h}（视口坐标），参数不合法返回 null
   */
  function placeAbove(btn, root, w, h, gap, margin) {
    const rect = function (o) {
      if (!o || typeof o !== 'object') return null;
      const left = +o.left, top = +o.top, width = +o.width, height = +o.height;
      return [left, top, width, height].every(isFinite) ? { left: left, top: top, right: left + width, width: width } : null;
    };
    const b = rect(btn), c = rect(root);
    if (!b || !c || !(w > 0) || !(h > 0)) return null;
    const g = gap > 0 ? gap : 0, m = margin > 0 ? margin : 0;
    const x = Math.max(c.left + m, Math.min(b.left + (b.width - w) / 2, c.right - m - w));
    const hh = Math.min(h, Math.max(0, b.top - g - (c.top + m)));
    return { x: Math.round(x), y: Math.round(b.top - g - hh), h: Math.round(hh) };
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

  // 当前设置存成预设（不支持超分时不带 vsr）；state 或名称不合法返回 null。
  // state.hdr.enabled 不是布尔值（nvUnleased 在不知道借用前的值时会去掉它）时预设不带开关
  function nvPresetFromState(state, name, id) {
    const st = nvNormState(state);
    if (!st) return null;
    const h = st.hdr;
    const raw = {
      id: id,
      name: name,
      hdr: { peak: h.peak, middleGrey: h.middleGrey, contrast: h.contrast, saturation: h.saturation }
    };
    if (typeof state.hdr.enabled === 'boolean') raw.hdr.enabled = state.hdr.enabled;
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
      // host-forbidden 只在扩展 ID 不在本地组件清单的 allowed_origins 里时出现：商店版换 1.2.1 起的本地组件能解决，其他 ID 重新运行 install.cmd 也没用
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

  // ---------- NVIDIA 写入：借用、去重、修改记录、撤销 ----------

  // 可写字段（与 NV_FIELD_TEXT 的键一致）。NvVals = {hdr?:{enabled?,peak?,…}, vsr?:{mode?,priority?}, indicator?}
  const NV_FIELDS = Object.freeze(['hdr.enabled', 'hdr.peak', 'hdr.middleGrey', 'hdr.contrast', 'hdr.saturation', 'vsr.mode', 'vsr.priority', 'indicator']);
  const NV_SOURCES = Object.freeze(['popup', 'panel', 'hotkey', 'schedule', 'follow', 'profile', 'site', 'lease', 'undo']);
  const NV_LOG_MAX = 100;
  const NV_LABEL_MAX = 40;
  const NV_UNDO_MAX_AGE_MS = 60 * 60 * 1000;

  function nvGet(vals, f) {
    if (!isObj(vals)) return undefined;
    const i = f.indexOf('.');
    if (i < 0) return vals[f];
    const g = vals[f.slice(0, i)];
    return isObj(g) ? g[f.slice(i + 1)] : undefined;
  }

  function nvSet(vals, f, x) {
    const i = f.indexOf('.');
    if (i < 0) { vals[f] = x; return; }
    const g = f.slice(0, i);
    if (!isObj(vals[g])) vals[g] = {};
    vals[g][f.slice(i + 1)] = x;
  }

  function nvDel(vals, f) {
    const i = f.indexOf('.');
    if (i < 0) { delete vals[f]; return; }
    const g = f.slice(0, i);
    if (!isObj(vals[g])) return;
    delete vals[g][f.slice(i + 1)];
    if (!Object.keys(vals[g]).length) delete vals[g];
  }

  // State / 补丁 / NvVals → 只含可写字段、类型和范围都对的 NvVals（新对象）；不是对象返回 null
  function nvVals(raw) {
    if (!isObj(raw)) return null;
    const out = {};
    for (const f of NV_FIELDS) {
      const x = nvGet(raw, f);
      if (f === 'hdr.enabled' || f === 'indicator') {
        if (typeof x === 'boolean') nvSet(out, f, x);
        continue;
      }
      const g = f.split('.');
      const r = NV_RANGES[g[0]][g[1]];
      if (Number.isInteger(x) && x >= r.min && x <= r.max) nvSet(out, f, x);
    }
    return out;
  }

  // 这个字段现在能写吗（显卡支持、HDR 没出错、驱动有对应的值）
  function nvWritable(st, f) {
    if (f.indexOf('hdr.') === 0) return st.hdr.supported && !st.hdr.error;
    if (f === 'vsr.priority') return st.vsr.supported && st.vsr.priority !== null;
    if (f.indexOf('vsr.') === 0) return st.vsr.supported;
    return st.indicator !== null;
  }

  function nvHeld(lease) {
    return isObj(lease) && (lease.held === true || lease.leased === true);
  }

  /**
   * 「只关 HDR」借用期间的真实状态：把被借走的 hdr.enabled 换回借用前的值（prevEnabled）；
   * 不知道 prevEnabled 时去掉 enabled。lease 可以是 {held, prevEnabled}，也可以是 hdrOnlyStatus（{leased, prevEnabled}）。
   * 保存预设、配置档和「打开时的值」都用它。state 不合法返回 null
   */
  function nvUnleased(state, lease) {
    const st = nvNormState(state);
    if (!st) return null;
    if (nvHeld(lease)) {
      if (typeof lease.prevEnabled === 'boolean') st.hdr.enabled = lease.prevEnabled;
      else delete st.hdr.enabled;
    }
    return st;
  }

  /**
   * 带 hdr.enabled 的写入遇上借用时怎么办。mode 'suppress'（用户亲手拨 HDR 开关）：只要在借就 drop-suppress；
   * 'yield'（预设、配置档等）：enabled 等于借用前的值时去掉 enabled（不闪烁），否则 drop-yield。
   * 返回 {patch: 新对象, action: 'none'|'drop-suppress'|'drop-yield'}；patch 不是对象返回 null
   */
  function nvLeaseAdjust(patch, lease, mode) {
    if (!isObj(patch)) return null;
    const p = clone(patch);
    const en = nvGet(p, 'hdr.enabled');
    if (!nvHeld(lease) || typeof en !== 'boolean') return { patch: p, action: 'none' };
    if (mode === 'suppress') return { patch: p, action: 'drop-suppress' };
    if (en === lease.prevEnabled) {
      nvDel(p, 'hdr.enabled');
      return { patch: p, action: 'none' };
    }
    return { patch: p, action: 'drop-yield' };
  }

  // 跟随 SDR 开着时，时段和网站预设这类自动来源不写中间灰（由跟随 SDR 独占）
  function nvAutoGuard(patch, settings, source) {
    if (!isObj(patch)) return null;
    const p = clone(patch);
    const follow = isObj(settings) && isObj(settings.nv) && settings.nv.followSdr === true;
    if (follow && (source === 'schedule' || source === 'site')) nvDel(p, 'hdr.middleGrey');
    return p;
  }

  // 去掉和实时值相同的字段（commit 原样保留）；全都相同时返回 null，不用写注册表。state 不合法时不去重
  function nvPatchDelta(patch, state) {
    if (!isObj(patch)) return null;
    const st = nvNormState(state);
    const out = {};
    for (const f of NV_FIELDS) {
      const x = nvGet(patch, f);
      if (x === undefined || (st && nvGet(st, f) === x)) continue;
      nvSet(out, f, x);
    }
    if (!Object.keys(out).length) return null;
    if (typeof patch.commit === 'boolean') out.commit = patch.commit;
    return out;
  }

  // 两次状态之间变了哪些可写字段（两边都有的才比较）：{before, after}（NvVals）；没变或不合法返回 null
  function nvStateDiff(before, after) {
    const a = nvVals(before), b = nvVals(after);
    if (!a || !b) return null;
    const out = { before: {}, after: {} };
    let any = false;
    for (const f of NV_FIELDS) {
      const x = nvGet(a, f), y = nvGet(b, f);
      if (x === undefined || y === undefined || x === y) continue;
      nvSet(out.before, f, x);
      nvSet(out.after, f, y);
      any = true;
    }
    return any ? out : null;
  }

  // state 里补丁写到的那些字段（NvVals，新对象）：页面补记的修改记录只算它自己写的字段，
  // 不把这期间别的写入方（借用、快捷键、跟随 SDR 等）改的字段算进来。参数不合法返回 null
  function nvPatchVals(state, patch) {
    const a = nvVals(state), want = nvVals(patch);
    if (!a || !want) return null;
    const out = {};
    for (const f of NV_FIELDS) if (nvGet(want, f) !== undefined && nvGet(a, f) !== undefined) nvSet(out, f, nvGet(a, f));
    return out;
  }

  /**
   * 修改记录的一条 → 规范化的新对象；不合法（来源未知、没有时间）返回 null：
   * {id, at, source, label?, ok, error?:{code,field?,errorCode?,written?}, before?, after?, want?,
   *  undoable, undone?, undoOf?, unconfirmed?}。失败、未确认、没有前后值的条目不可撤销
   */
  function nvLogEntry(raw) {
    if (!isObj(raw) || NV_SOURCES.indexOf(raw.source) < 0) return null;
    if (typeof raw.at !== 'number' || !isFinite(raw.at) || raw.at < 0) return null;
    const e = { id: Number.isInteger(raw.id) && raw.id > 0 ? raw.id : 0, at: raw.at, source: raw.source };
    const label = typeof raw.label === 'string' ? cut(raw.label.trim(), NV_LABEL_MAX).trim() : '';
    if (label) e.label = label;
    e.ok = raw.ok === true;
    if (isObj(raw.error) && typeof raw.error.code === 'string' && raw.error.code) {
      const er = { code: raw.error.code.slice(0, 40) };
      if (typeof raw.error.field === 'string') er.field = raw.error.field.slice(0, 40);
      if (Number.isInteger(raw.error.errorCode)) er.errorCode = raw.error.errorCode;
      if (typeof raw.error.written === 'boolean') er.written = raw.error.written;
      e.error = er;
    }
    for (const k of ['before', 'after', 'want']) {
      const v = nvVals(raw[k]);
      if (v && Object.keys(v).length) e[k] = v;
    }
    if (raw.unconfirmed === true) e.unconfirmed = true;
    e.undoable = raw.undoable === true && e.ok && !e.unconfirmed && !!e.before && !!e.after;
    if (raw.undone === true) e.undone = true;
    if (Number.isInteger(raw.undoOf) && raw.undoOf > 0) e.undoOf = raw.undoOf;
    return e;
  }

  // storage.session 的 nvLog → {v:1, seq, list}（丢掉坏条目，只留最新的 max 条）
  function nvNormLog(raw, max) {
    const lim = Number.isInteger(max) && max > 0 ? max : NV_LOG_MAX;
    const r = isObj(raw) ? raw : {};
    const list = Array.isArray(r.list) ? r.list.map(nvLogEntry).filter(function (e) { return e && e.id > 0; }) : [];
    let seq = Number.isInteger(r.seq) && r.seq >= 0 ? r.seq : 0;
    for (const e of list) if (e.id > seq) seq = e.id;
    return { v: 1, seq: seq, list: list.slice(-lim) };
  }

  // 追加一条（id = seq + 1，环形保留最新的 max 条），返回新日志；条目不合法时只返回规范化后的旧日志
  function nvLogAppend(log, entry, max) {
    const lim = Number.isInteger(max) && max > 0 ? max : NV_LOG_MAX;
    const l = nvNormLog(log, lim);
    const e = nvLogEntry(entry);
    if (!e) return l;
    e.id = l.seq + 1;
    l.seq = e.id;
    l.list.push(e);
    if (l.list.length > lim) l.list = l.list.slice(-lim);
    return l;
  }

  // 把某条标记为已撤销，返回新日志
  function nvLogMarkUndone(log, id) {
    const l = nvNormLog(log);
    for (const e of l.list) if (e.id === id) e.undone = true;
    return l;
  }

  /**
   * 一次写入 → 修改记录的条目（还没编号，交给 nvLogAppend）。
   * w: {source, at, label?, before: 写入前的 State, after: 写入后的 State|null, patch, error?, unconfirmed?, undoOf?}。
   * 拿到写入后的状态时 before/after 只留变了的字段；失败或没有写入后的状态时 before 只留补丁涉及的字段，want 记补丁。
   * 没出错、没变化也不是「未确认」时返回 null（不用记）；来源不合法同样返回 null
   */
  function nvWriteEntry(w) {
    if (!isObj(w) || NV_SOURCES.indexOf(w.source) < 0) return null;
    const want = nvVals(w.patch) || {};
    const err = isObj(w.error) ? w.error : null;
    const diff = isObj(w.after) ? nvStateDiff(w.before, w.after) : null;
    if (!err && !diff && !(w.unconfirmed === true && Object.keys(want).length)) return null;
    const raw = { at: w.at, source: w.source, label: w.label, ok: !err, undoable: w.source !== 'lease' && !err, undoOf: w.undoOf };
    if (err) {
      raw.error = { code: err.code, field: err.field, errorCode: err.errorCode };
      // 本地组件的 written 是已经写入的 id 列表：记成「是否写了一部分」
      if (Array.isArray(err.written)) raw.error.written = err.written.length > 0;
    }
    if (diff) {
      raw.before = diff.before;
      raw.after = diff.after;
    } else {
      const b = nvVals(w.before) || {};
      const picked = {};
      for (const f of NV_FIELDS) if (nvGet(want, f) !== undefined && nvGet(b, f) !== undefined) nvSet(picked, f, nvGet(b, f));
      raw.before = picked;
    }
    if (Object.keys(want).length) raw.want = want;
    if (w.unconfirmed === true) raw.unconfirmed = true;
    return nvLogEntry(raw);
  }

  // 该撤销哪一条：从新到旧找第一条成功、可撤销、未撤销、不是 undo / lease 来源、且不超过 maxAgeMs 的
  function nvUndoTarget(log, now, maxAgeMs) {
    const age = typeof maxAgeMs === 'number' && maxAgeMs > 0 ? maxAgeMs : NV_UNDO_MAX_AGE_MS;
    const l = nvNormLog(log);
    for (let i = l.list.length - 1; i >= 0; i--) {
      const e = l.list[i];
      if (now - e.at > age) continue;
      if (e.ok && e.undoable && !e.undone && e.source !== 'undo' && e.source !== 'lease') return e;
    }
    return null;
  }

  /**
   * 把「after」写回「before」：只处理实时值仍等于 after 的字段（之后又被改过的放进 skipped）；
   * 最高亮度夹到实时范围；现在写不了的部分（HDR 出错、不支持）放进 unavailable。
   * lease（可省略，同 nvUnleased）：借用期间 hdr.enabled 和借用前的值比较；不知道借用前的值时这个字段算 skipped。
   * 返回 {patch: 补丁或 null, skipped: [字段], unavailable: [字段]}；参数不合法返回 null
   */
  function nvRevertFields(before, after, state, lease) {
    const st = nvNormState(state);
    const cur = nvUnleased(state, lease);
    const a = nvVals(before), b = nvVals(after);
    if (!st || !a || !b) return null;
    const out = {};
    const skipped = [];
    const unavailable = [];
    for (const f of NV_FIELDS) {
      const to = nvGet(b, f), back = nvGet(a, f);
      if (to === undefined || back === undefined || to === back) continue;
      if (!nvWritable(st, f)) { unavailable.push(f); continue; }
      if (nvGet(cur, f) !== to) { skipped.push(f); continue; }
      const v = f === 'hdr.peak' ? clamp(back, st.hdr.peakMin, st.hdr.peakMax) : back;
      if (v !== to) nvSet(out, f, v);
    }
    if (!Object.keys(out).length) return { patch: null, skipped: skipped, unavailable: unavailable };
    out.commit = true;
    return { patch: out, skipped: skipped, unavailable: unavailable };
  }

  // 撤销一条修改记录要发的 set：{patch, skipped, unavailable}；条目或状态不合法返回 null
  function nvUndoPatch(entry, state, lease) {
    if (!isObj(entry)) return null;
    return nvRevertFields(entry.before, entry.after, state, lease);
  }

  // 某个字段现在为什么写不了：{code:'hdr-error', errorCode} 或 {code:'unsupported', field}（nvErrorText 能显示）；能写或参数不合法返回 null
  function nvUnavailableError(state, f) {
    const st = nvNormState(state);
    if (!st || NV_FIELDS.indexOf(f) < 0 || nvWritable(st, f)) return null;
    if (f.indexOf('hdr.') === 0) return st.hdr.supported ? { code: 'hdr-error', errorCode: st.hdr.error } : { code: 'unsupported', field: 'hdr' };
    if (f === 'vsr.priority' && st.vsr.supported) return { code: 'unsupported', field: 'vsr.priority' };
    return { code: 'unsupported', field: f.indexOf('vsr.') === 0 ? 'vsr' : f };
  }

  /**
   * 面板「还原到打开时」：只生成和打开时快照（snap，State 或 NvVals）不同的字段；
   * 最高亮度夹到实时范围；现在写不了的部分跳过。没有要还原的返回 null
   */
  function nvRevertPatch(cur, snap) {
    const st = nvNormState(cur);
    const want = nvVals(snap);
    if (!st || !want) return null;
    const out = {};
    for (const f of NV_FIELDS) {
      let v = nvGet(want, f);
      if (v === undefined || !nvWritable(st, f)) continue;
      if (f === 'hdr.peak') v = clamp(v, st.hdr.peakMin, st.hdr.peakMax);
      if (nvGet(st, f) !== v) nvSet(out, f, v);
    }
    if (!Object.keys(out).length) return null;
    out.commit = true;
    return out;
  }

  function nvValText(f, x, lang) {
    if (f === 'hdr.enabled' || f === 'indicator') return tr(lang, x ? 'osd.on' : 'osd.off');
    if (f === 'vsr.mode') return tr(lang, x === 5 ? 'vsr.auto' : x === 0 ? 'vsr.off' : 'vsrLevel.' + x);
    if (f === 'vsr.priority') return tr(lang, 'level.' + SENSITIVITIES[x]);
    if (f === 'hdr.contrast' || f === 'hdr.saturation') return x > 0 ? '+' + x : String(x);
    return String(x);
  }

  /**
   * {before, after}（nvStateDiff 的结果或修改记录的条目）→「中间灰 65 → 70，最高亮度 1000 → 800」。
   * OSD、弹窗、诊断页共用；没有变化返回空串
   */
  function nvChangeText(vals, lang) {
    if (!isObj(vals)) return '';
    const a = nvVals(vals.before) || {}, b = nvVals(vals.after) || {};
    const items = [];
    for (const f of NV_FIELDS) {
      const y = nvGet(b, f), x = nvGet(a, f);
      if (y === undefined || x === y) continue;
      items.push(tr(lang, 'nv.field.' + f) + ' ' + (x === undefined ? '' : nvValText(f, x, lang) + ' → ') + nvValText(f, y, lang));
    }
    return items.join(lang === 'en' ? ', ' : '，');
  }

  // ---------- 按网站切换 NVIDIA 预设 ----------

  const NV_SITE_GRACE_MS = 30000;

  // 先看顶层页面的域名，再看 frame 自己的（与网站规则相同）→ {host: 命中的键, presetId}|null
  function sitePresetMatch(sitePresets, frameHost, topHost) {
    if (!isObj(sitePresets)) return null;
    for (const raw of [topHost, frameHost]) {
      const host = raw ? normalizeHost(raw) : '';
      if (host && hasOwn(sitePresets, host) && typeof sitePresets[host] === 'string') return { host: host, presetId: sitePresets[host] };
    }
    return null;
  }

  function sitePresetFor(sitePresets, frameHost, topHost) {
    const m = sitePresetMatch(sitePresets, frameHost, topHost);
    return m ? m.presetId : null;
  }

  /**
   * 网站预设引擎的一次判断。
   * record：当前生效的记录 {host, presetId, seenAt, …}|null；target：焦点标签页的最佳 frame
   * {topHost, frameHost, hasVideo, playing}|null；presetIds：现有预设的 id。
   * 返回 {action:'none'|'apply'|'leave'|'wait', host?, presetId?, at?}：
   * none 且带 at 时调用方把 seenAt 更新为 at；wait 的 at 是该再看一次的时间
   */
  function nvSiteDecide(opts) {
    const c = isObj(opts) ? opts : {};
    const now = typeof c.now === 'number' ? c.now : 0;
    const grace = typeof c.graceMs === 'number' && c.graceMs >= 0 ? c.graceMs : NV_SITE_GRACE_MS;
    const ids = Array.isArray(c.presetIds) ? c.presetIds : [];
    const t = isObj(c.target) ? c.target : null;
    let bind = t ? sitePresetMatch(c.sitePresets, t.frameHost, t.topHost) : null;
    if (bind && ids.indexOf(bind.presetId) < 0) bind = null;
    const rec = isObj(c.record) && typeof c.record.host === 'string' && c.record.host ? c.record : null;
    const playing = !!(t && t.playing === true);
    const hasVideo = !!(t && (t.hasVideo === true || playing));

    if (!rec) return bind && playing ? { action: 'apply', host: bind.host, presetId: bind.presetId, at: now } : { action: 'none' };
    // 换到未绑定的网站、chrome:// 页面，或者绑定被删
    if (!bind) return { action: 'leave', host: rec.host };
    const same = bind.host === rec.host && bind.presetId === rec.presetId;
    if (same && hasVideo) return { action: 'none', host: rec.host, presetId: rec.presetId, at: now };
    // 绑定网站换了（A → B）或同一网站的绑定被改了
    if (!same && playing) return { action: 'apply', host: bind.host, presetId: bind.presetId, at: now };
    // 仍在绑定网站但没有视频：宽限期内等一等
    const seen = typeof rec.seenAt === 'number' ? rec.seenAt : typeof rec.at === 'number' ? rec.at : 0;
    if (now - seen < grace) return { action: 'wait', host: rec.host, at: seen + grace };
    return { action: 'leave', host: rec.host };
  }

  // 离开绑定网站时恢复：只恢复实时值仍等于 record.wrote 的字段（回到 record.base）；没有要恢复的返回 null
  function nvSiteRestorePatch(record, state) {
    if (!isObj(record)) return null;
    const r = nvRevertFields(record.base, record.wrote, state);
    return r ? r.patch : null;
  }

  // ---------- 配置档 ----------

  // 配置档包含的行为设置；不包含的（网站规则单独可选，NVIDIA 参数单独可选）。两组合起来必须正好是 DEFAULT_SETTINGS 的全部键
  const PROFILE_BEHAVIOR_KEYS = Object.freeze(['defaultState', 'fullscreenWeb', 'rememberManual', 'autoDetect', 'autoLastMode',
    'sensitivity', 'night', 'eye', 'osd', 'playerButton', 'playerPanel', 'hdrOnly']);
  const PROFILE_EXCLUDED_KEYS = Object.freeze(['sites', 'ui', 'nv', 'updateCheck']);
  const PROFILES_MAX = 20;
  const PROFILE_SITES_MAX = 1000;
  const PROFILES_FORMAT = 'rtx-hdr-switch-profiles';
  const PROFILES_VERSION = 1;

  function profileBehavior(raw) {
    const s = mergeSettings(raw);
    const out = {};
    for (const k of PROFILE_BEHAVIOR_KEYS) out[k] = s[k];
    return out;
  }

  // 配置档里的 NVIDIA 部分：{hdr:{enabled?,peak,middleGrey,contrast,saturation}, vsr?:{mode,priority?}, indicator?}
  function normProfileNv(raw) {
    if (!isObj(raw)) return null;
    const p = normPreset({ id: 'x', name: 'x', hdr: raw.hdr, vsr: raw.vsr });
    if (!p) return null;
    const out = { hdr: p.hdr };
    if (p.vsr) out.vsr = p.vsr;
    if (typeof raw.indicator === 'boolean') out.indicator = raw.indicator;
    return out;
  }

  /**
   * 配置档：{id, name, savedAt, behavior: {PROFILE_BEHAVIOR_KEYS 的全部字段}, sites?: {host: 规则}, nv?}；
   * 不合法返回 null
   */
  function normProfile(p) {
    if (!isObj(p) || !isObj(p.behavior)) return null;
    const id = typeof p.id === 'string' && NV_ID_RE.test(p.id) ? p.id : null;
    const name = nvName(p.name);
    if (!id || !name) return null;
    const savedAt = typeof p.savedAt === 'number' && isFinite(p.savedAt) && p.savedAt >= 0 ? Math.round(p.savedAt) : 0;
    const out = { id: id, name: name, savedAt: savedAt, behavior: profileBehavior(p.behavior) };
    if (isObj(p.sites)) out.sites = normSites(p.sites, PROFILE_SITES_MAX);
    const nv = normProfileNv(p.nv);
    if (nv) out.nv = nv;
    return out;
  }

  // storage 的 profiles → {v:1, list, activeId}：最多 20 个，id 去重，activeId 必须在 list 里
  function normProfiles(raw) {
    const r = isObj(raw) ? raw : {};
    const list = [];
    const ids = new Set();
    if (Array.isArray(r.list)) {
      for (const x of r.list) {
        if (list.length >= PROFILES_MAX) break;
        const p = normProfile(x);
        if (p && !ids.has(p.id)) {
          ids.add(p.id);
          list.push(p);
        }
      }
    }
    return { v: 1, list: list, activeId: typeof r.activeId === 'string' && ids.has(r.activeId) ? r.activeId : null };
  }

  /**
   * 把当前设置存成配置档。opts: {id, name, now, sites: bool, nv: bool, lease}。
   * NVIDIA 部分先过 nvUnleased；indicator 为 null 时不存；不支持超分时不存 vsr；不含 ui 和 displayId。
   * 要 NVIDIA 部分但 nvState 不合法、或 id / 名称不合法时返回 null
   */
  function profileFromCurrent(settings, nvState, opts) {
    const o = isObj(opts) ? opts : {};
    const s = mergeSettings(settings);
    const raw = { id: o.id, name: o.name, savedAt: typeof o.now === 'number' ? o.now : 0, behavior: s };
    if (o.sites === true) raw.sites = s.sites;
    if (o.nv === true) {
      const st = nvUnleased(nvState, o.lease);
      if (!st) return null;
      const h = st.hdr;
      const nv = { hdr: { peak: h.peak, middleGrey: h.middleGrey, contrast: h.contrast, saturation: h.saturation } };
      if (typeof h.enabled === 'boolean') nv.hdr.enabled = h.enabled;
      if (st.vsr.supported) {
        nv.vsr = { mode: st.vsr.mode };
        if (st.vsr.priority !== null) nv.vsr.priority = st.vsr.priority;
      }
      if (st.indicator !== null) nv.indicator = st.indicator;
      raw.nv = nv;
    }
    return normProfile(raw);
  }

  // 套用配置档的设置部分：整体替换行为字段；配置档带 sites 时整体替换 sites；ui、nv、updateCheck 不碰
  function profileApply(settings, profile) {
    const p = normProfile(profile);
    if (!p) return null;
    const s = mergeSettings(settings);
    for (const k of PROFILE_BEHAVIOR_KEYS) s[k] = clone(p.behavior[k]);
    if (p.sites) s.sites = clone(p.sites);
    return mergeSettings(s);
  }

  // 套用配置档的 NVIDIA 部分要发的 set（同 nvPresetPatch，另外带 indicator）；没有可写的返回 null
  function profileNvPatch(profile, nvState) {
    const p = normProfile(profile);
    const st = nvNormState(nvState);
    if (!p || !p.nv || !st) return null;
    let out = nvPresetPatch({ id: 'x', name: 'x', hdr: p.nv.hdr, vsr: p.nv.vsr }, st);
    if (typeof p.nv.indicator === 'boolean' && st.indicator !== null) {
      out = out || { commit: true };
      out.indicator = p.nv.indicator;
    }
    return out;
  }

  function sortedJson(map) {
    return JSON.stringify(Object.keys(map).sort().map(function (k) { return [k, map[k]]; }));
  }

  /**
   * 当前状态与配置档的差别：[{key, from, to}]，key 形如 'osd'、'night.start'、'sites'（from/to 是规则条数）、
   * 'nv.hdr.peak'。一致时返回空数组；配置档不合法返回 null。nvState 读不到时不比较 NVIDIA 部分
   */
  function profileDiff(settings, nvState, profile) {
    const p = normProfile(profile);
    if (!p) return null;
    const s = mergeSettings(settings);
    const out = [];
    for (const k of PROFILE_BEHAVIOR_KEYS) {
      const a = s[k], b = p.behavior[k];
      if (isObj(a) && isObj(b)) {
        for (const sub of Object.keys(b)) if (a[sub] !== b[sub]) out.push({ key: k + '.' + sub, from: a[sub], to: b[sub] });
      } else if (a !== b) {
        out.push({ key: k, from: a, to: b });
      }
    }
    if (p.sites && sortedJson(s.sites) !== sortedJson(p.sites)) {
      out.push({ key: 'sites', from: Object.keys(s.sites).length, to: Object.keys(p.sites).length });
    }
    const want = p.nv ? profileNvPatch(p, nvState) : null;
    if (want) {
      const live = nvVals(nvState) || {};
      for (const f of NV_FIELDS) {
        const y = nvGet(want, f), x = nvGet(live, f);
        if (y !== undefined && x !== undefined && x !== y) out.push({ key: 'nv.' + f, from: x, to: y });
      }
    }
    return out;
  }

  /**
   * 保存配置档到列表：同名的覆盖（保留原 id），否则追加。返回 {list: 新列表, overwrote, id}；
   * 已满返回 {code:'max'}，配置档不合法或 id 与别的配置档冲突返回 {code:'invalid'}
   */
  function profileUpsert(list, profile) {
    const p = normProfile(profile);
    if (!p) return { code: 'invalid' };
    const cur = normProfiles({ list: list }).list;
    const i = cur.findIndex(function (x) { return x.name === p.name; });
    if (i >= 0) {
      p.id = cur[i].id;
      cur[i] = p;
      return { list: cur, overwrote: true, id: p.id };
    }
    if (cur.some(function (x) { return x.id === p.id; })) return { code: 'invalid' };
    if (cur.length >= PROFILES_MAX) return { code: 'max' };
    cur.push(p);
    return { list: cur, overwrote: false, id: p.id };
  }

  // 重名时改成「名 (2)」「名 (3)」…，总长不超过 24 个码点
  function uniqueName(used, name) {
    if (!used.has(name)) return name;
    for (let n = 2; ; n++) {
      const suffix = ' (' + n + ')';
      const cand = cut(name, NV_NAME_MAX - suffix.length).trim() + suffix;
      if (!used.has(cand)) return cand;
    }
  }

  /**
   * 导入配置档（合并）：导入的全部换新 id，重名的改名；超过上限或不合法的不导入。
   * now 只用来生成 id。返回 {list: 新列表, added: [{id, name, renamed}], dropped: 没导入的个数}
   */
  function profilesMerge(list, incoming, now) {
    const cur = normProfiles({ list: list }).list;
    const src = Array.isArray(incoming) ? incoming : [];
    const names = new Set(cur.map(function (p) { return p.name; }));
    const ids = new Set(cur.map(function (p) { return p.id; }));
    const stamp = Math.floor(typeof now === 'number' && isFinite(now) && now >= 0 ? now : Date.now()).toString(36);
    const added = [];
    let dropped = 0, seq = 0;
    for (const raw of src) {
      const p = isObj(raw) ? normProfile(Object.assign({}, raw, { id: 'x' })) : null;
      if (!p || cur.length >= PROFILES_MAX) { dropped++; continue; }
      let id;
      do id = 'i' + stamp + '-' + (++seq).toString(36); while (ids.has(id));
      ids.add(id);
      const name = uniqueName(names, p.name);
      names.add(name);
      added.push({ id: id, name: name, renamed: name !== p.name });
      p.id = id;
      p.name = name;
      cur.push(p);
    }
    return { list: cur, added: added, dropped: dropped };
  }

  // 配置档文件（导出全部 / 单个，复制为文本也用这个格式）
  function makeProfilesFile(list, extVersion, nowMs) {
    return {
      format: PROFILES_FORMAT,
      version: PROFILES_VERSION,
      exportedAt: new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString(),
      extensionVersion: String(extVersion || ''),
      profiles: normProfiles({ list: list }).list
    };
  }

  // 检查配置档文件：{ok:true, profiles} 或 {ok:false, code:'invalid'|'newer'|'empty'}
  function validateProfilesFile(obj) {
    if (!isObj(obj) || obj.format !== PROFILES_FORMAT || !Number.isInteger(obj.version)) return { ok: false, code: 'invalid' };
    if (obj.version > PROFILES_VERSION) return { ok: false, code: 'newer' };
    if (obj.version < 1 || !Array.isArray(obj.profiles)) return { ok: false, code: 'invalid' };
    const list = obj.profiles.map(normProfile).filter(Boolean).slice(0, PROFILES_MAX);
    return list.length ? { ok: true, profiles: list } : { ok: false, code: 'empty' };
  }

  // ---------- 更新检查 ----------

  const RELEASE_PREFIX = 'https://github.com/miniso7892-dotcom/rtx-hdr-switch/releases/';
  const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  function parseSemver(v) {
    const m = /^[vV]?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
      .exec(typeof v === 'string' ? v.trim() : '');
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
  }

  // 版本比较：-1 / 0 / 1；接受前缀 v，预发布版小于正式版；格式不合法返回 null
  function semverCmp(a, b) {
    const x = parseSemver(a), y = parseSemver(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      const p = x.pre[i], q = y.pre[i];
      if (p === undefined) return -1;
      if (q === undefined) return 1;
      const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
      if (pn && qn) {
        if (+p !== +q) return +p > +q ? 1 : -1;
      } else if (pn !== qn) {
        return pn ? -1 : 1;
      } else if (p !== q) {
        return p > q ? 1 : -1;
      }
    }
    return 0;
  }

  // 只认本仓库发布页下的地址（规范化后再比较前缀）
  function releaseUrl(u) {
    if (typeof u !== 'string' || u.length > 500) return null;
    let x;
    try { x = new URL(u); } catch (e) { return null; }
    return x.href.indexOf(RELEASE_PREFIX) === 0 ? x.href : null;
  }

  /**
   * GitHub latest release 的 JSON → {version, tag, url, zip, digest, publishedAt, name}；
   * draft、prerelease、版本号不合法或发布页不在本仓库时返回 null。zip 优先选名字带 rtx-hdr-switch 的
   */
  function parseRelease(json) {
    if (!isObj(json) || json.draft === true || json.prerelease === true) return null;
    const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : '';
    if (tag.length > 40 || !parseSemver(tag)) return null;
    const url = releaseUrl(json.html_url);
    if (!url) return null;
    const assets = Array.isArray(json.assets) ? json.assets.filter(isObj) : [];
    const zips = assets.filter(function (a) {
      return typeof a.name === 'string' && /\.zip$/i.test(a.name) && releaseUrl(a.browser_download_url);
    });
    const best = zips.find(function (a) { return /rtx-hdr-switch/i.test(a.name); }) || zips[0] || null;
    const digest = best && typeof best.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(best.digest) ? best.digest.toLowerCase() : null;
    return {
      version: tag.replace(/^[vV]/, ''),
      tag: tag,
      url: url,
      zip: best ? releaseUrl(best.browser_download_url) : null,
      digest: digest,
      publishedAt: typeof json.published_at === 'string' ? json.published_at.slice(0, 40) : '',
      name: typeof json.name === 'string' ? cut(json.name.trim(), 80) : ''
    };
  }

  /**
   * 请求失败后什么时候再试（ms 时间戳）。403 / 429：按 Retry-After（秒）或 X-RateLimit-Reset（秒级时间戳），
   * 都没有时 1 小时，夹到 1 分钟..24 小时；5xx：fails（之前连续失败的次数）为 0、1、2、≥3 时退避 3、6、12、24 小时。
   * 其他状态返回 0（不限制）
   */
  function updateBackoff(status, headers, fails, now) {
    const h = isObj(headers) ? headers : {};
    const n = Number.isInteger(fails) && fails > 0 ? Math.min(fails, 3) : 0;
    const num = function (v) { return v == null || v === '' ? NaN : Number(v); };
    if (status === 403 || status === 429) {
      let at = 0;
      const ra = num(h.retryAfter), rem = num(h.remaining), reset = num(h.reset);
      if (isFinite(ra) && ra >= 0) at = now + ra * 1000;
      else if (rem === 0 && isFinite(reset) && reset > 0) at = reset * 1000;
      if (!at) at = now + HOUR_MS;
      return clamp(at, now + 60000, now + 24 * HOUR_MS);
    }
    if (status >= 500 && status <= 599) return now + 3 * Math.pow(2, n) * HOUR_MS;
    return 0;
  }

  // 该不该检查：上次成功检查后满 24 小时（或时钟被调回过），并且已过退避时间
  function updateDue(state, now) {
    const s = isObj(state) ? state : {};
    const fin = function (v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0; };
    const checked = fin(s.checkedAt), retry = fin(s.retryAt);
    if (now < retry) return false;
    return now - checked >= UPDATE_INTERVAL_MS || checked > now;
  }

  // 要不要提醒：有比当前新的版本，且没被跳过、没在「7 天内不再提醒」里 → {version, url, zip}|null
  function updateNotice(state, curVersion, now) {
    const s = isObj(state) ? state : {};
    const l = isObj(s.latest) ? s.latest : null;
    if (!l || semverCmp(l.version, curVersion) !== 1) return null;
    if (s.skipped === l.version) return null;
    if (s.snoozeVersion === l.version && typeof s.snoozeUntil === 'number' && now < s.snoozeUntil) return null;
    const url = releaseUrl(l.url);
    if (!url) return null;
    return { version: l.version, url: url, zip: releaseUrl(l.zip) };
  }

  // 本地组件需要的 caps（以后哪个版本加了新 cap 就加到这里）
  const NV_HOST_CAPS = Object.freeze(['display', 'hdrLease']);

  /**
   * 本地组件 hello 的回复 → {status:'ok'|'old'|'protocol'|'no-dll'|'error', version, missingCaps, code}。
   * 1.1 版没有 caps（old）；dll 为空表示没装 NVIDIA App；status 为 error 时 code 是错误码
   */
  function nvHostCheck(hello) {
    const h = isObj(hello) ? hello : null;
    const version = h && typeof h.version === 'string' ? h.version.slice(0, 20) : '';
    const res = function (status, missing, code) { return { status: status, version: version, missingCaps: missing || [], code: code || null }; };
    if (!h || h.ok !== true) {
      const code = h && isObj(h.error) && typeof h.error.code === 'string' ? h.error.code : 'host-error';
      return code === 'no-dll' ? res('no-dll') : res('error', null, code);
    }
    if (h.protocol !== NV_PROTOCOL) return res('protocol');
    if (!Array.isArray(h.caps)) return res('old', NV_HOST_CAPS.slice());
    const missing = NV_HOST_CAPS.filter(function (c) { return h.caps.indexOf(c) < 0; });
    if (missing.length) return res('old', missing);
    if (typeof h.dll !== 'string' || !h.dll) return res('no-dll');
    return res('ok');
  }

  // ---------- 诊断信息脱敏 ----------

  const REDACT_HOST_FIELDS = new Set(['hostname', 'host', 'topHostname', 'topHost', 'frameHost', 'tabHost']);
  const REDACT_URL_FIELDS = new Set(['url', 'href', 'pendingUrl', 'src', 'origin', 'frameUrl', 'topUrl']);
  const REDACT_KEY_FIELDS = new Set(['key', 'videoKey', 'ownerKey']);
  // hello 回复里的 host 字段是本地组件自己的名字，不是网站
  const NV_HOST_NAME = 'rtx_hdr_host';

  /**
   * 诊断快照的深拷贝，把能认出人和网站的值换成编号：域名、网址、sites 和 sitePresets 的键 → host#n；
   * 视频 key 和 v:* 键 → key#n；显示器 id / name 和 displayId → display#n；标题 → text#n；
   * 路径里的 C:\Users\<名> → <user>。同一个值总是对应同一个编号
   */
  function diagRedact(obj) {
    const maps = { host: new Map(), key: new Map(), display: new Map(), text: new Map() };
    const tag = function (kind, v) {
      const m = maps[kind];
      if (!m.has(v)) m.set(v, kind + '#' + (m.size + 1));
      return m.get(v);
    };
    const hostTag = function (h) { const n = normalizeHost(h); return tag('host', n || String(h)); };
    const urlTag = function (u) { const h = hostOf(u); return h ? hostTag(h) : tag('host', String(u)); };
    // 其他文字：里面夹着的网址换成域名编号，路径里的用户名去掉
    const plain = function (s) {
      return s.replace(/\b(?:https?|file|ftp|wss?):\/\/[^\s"'<>]+/gi, urlTag)
        .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/gi, '<user>');
    };

    function str(v, key, display) {
      if (!v) return v;
      if (REDACT_HOST_FIELDS.has(key)) return key === 'host' && v === NV_HOST_NAME ? v : hostTag(v);
      if (REDACT_URL_FIELDS.has(key)) return urlTag(v);
      if (REDACT_KEY_FIELDS.has(key)) return tag('key', v);
      if (key === 'displayId' || (display && (key === 'id' || key === 'name'))) return tag('display', v);
      if (key === 'title') return tag('text', v);
      return plain(v);
    }

    function walk(v, key, display, depth) {
      if (depth > 40) return null;
      if (typeof v === 'string') return str(v, key, display);
      if (Array.isArray(v)) {
        return v.map(function (x) { return walk(x, key, display || key === 'displays', depth + 1); });
      }
      if (!isObj(v)) return v;
      const own = display || key === 'display';
      const hostKeys = key === 'sites' || key === 'sitePresets';
      const out = {};
      for (const k of Object.keys(v)) {
        let nk = k;
        if (hostKeys) nk = hostTag(k);
        else if (k.indexOf(VIDEO_PREFIX) === 0 && k.length > VIDEO_PREFIX.length) nk = tag('key', k.slice(VIDEO_PREFIX.length));
        if (nk === '__proto__') continue;
        // 网站预设的修改记录：label 是域名
        if (k === 'label' && v.source === 'site' && typeof v[k] === 'string' && v[k] !== 'restore') out[nk] = hostTag(v[k]);
        else out[nk] = walk(v[k], k, own, depth + 1);
      }
      return out;
    }

    return walk(obj, '', false, 0);
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
    const out = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString(),
      extensionVersion: String(extVersion || ''),
      settings: mergeSettings(src.settings),
      videos: videos
    };
    // 1.3 起可选的顶层字段：配置档（1.2 导入时会忽略它）
    if (isObj(src.profiles)) out.profiles = normProfiles(src.profiles);
    return out;
  }

  /**
   * 检查并规范化备份文件内容。成功：{ok, settings, videos: {key: {s,t}}, profiles: {v,list,activeId}|null,
   * summary: {videos, presets, sites, profiles}, exportedAt, extensionVersion}；失败：{ok:false, code:'invalid'|'newer'}。
   * 视频记忆超过上限时只留最新的那些；备份里没有配置档（1.2 的备份）时 profiles 为 null，导入时保留现有的
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
    const profiles = isObj(obj.profiles) ? normProfiles(obj.profiles) : null;
    return {
      ok: true,
      settings: settings,
      videos: videos,
      profiles: profiles,
      summary: {
        videos: Object.keys(videos).length,
        presets: settings.nv.presets.length,
        sites: Object.keys(settings.sites).length,
        profiles: profiles ? profiles.list.length : 0
      },
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
    hdrOnlyApplies: hdrOnlyApplies,
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
    nvErrorText: nvErrorText,
    // 1.3：设置补丁
    PANEL_MODES: PANEL_MODES,
    SITE_RULES: SITE_RULES,
    applySettingsPatch: applySettingsPatch,
    settingsPatchFor: settingsPatchFor,
    mergeSettingsPatch: mergeSettingsPatch,
    contentPatchAllowed: contentPatchAllowed,
    // 1.3：观看
    PEEK_HOLD_MS: PEEK_HOLD_MS,
    PEEK_CMD_MS: PEEK_CMD_MS,
    PEEK_MAX_MS: PEEK_MAX_MS,
    createHoldGesture: createHoldGesture,
    tabOffer: tabOffer,
    fsHintTarget: fsHintTarget,
    // 1.3：播放器面板
    PLAYER_HOSTS: PLAYER_HOSTS,
    placeAbove: placeAbove,
    nvEffectiveState: nvUnleased,
    nvRevertPatch: nvRevertPatch,
    // 1.3：NVIDIA 写入、修改记录、撤销
    NV_FIELDS: NV_FIELDS,
    NV_SOURCES: NV_SOURCES,
    NV_LOG_MAX: NV_LOG_MAX,
    NV_UNDO_MAX_AGE_MS: NV_UNDO_MAX_AGE_MS,
    NV_SITE_PRESETS_MAX: NV_SITE_PRESETS_MAX,
    nvVals: nvVals,
    nvUnleased: nvUnleased,
    nvLeaseAdjust: nvLeaseAdjust,
    nvAutoGuard: nvAutoGuard,
    nvPatchDelta: nvPatchDelta,
    nvStateDiff: nvStateDiff,
    nvPatchVals: nvPatchVals,
    nvLogEntry: nvLogEntry,
    nvNormLog: nvNormLog,
    nvLogAppend: nvLogAppend,
    nvLogMarkUndone: nvLogMarkUndone,
    nvWriteEntry: nvWriteEntry,
    nvUndoTarget: nvUndoTarget,
    nvUndoPatch: nvUndoPatch,
    nvUnavailableError: nvUnavailableError,
    nvChangeText: nvChangeText,
    // 1.3：按网站切换预设
    NV_SITE_GRACE_MS: NV_SITE_GRACE_MS,
    sitePresetFor: sitePresetFor,
    nvSiteDecide: nvSiteDecide,
    nvSiteRestorePatch: nvSiteRestorePatch,
    // 1.3：配置档
    PROFILE_BEHAVIOR_KEYS: PROFILE_BEHAVIOR_KEYS,
    PROFILE_EXCLUDED_KEYS: PROFILE_EXCLUDED_KEYS,
    PROFILES_MAX: PROFILES_MAX,
    PROFILES_FORMAT: PROFILES_FORMAT,
    PROFILES_VERSION: PROFILES_VERSION,
    normProfile: normProfile,
    normProfiles: normProfiles,
    profileFromCurrent: profileFromCurrent,
    profileApply: profileApply,
    profileNvPatch: profileNvPatch,
    profileDiff: profileDiff,
    profileUpsert: profileUpsert,
    profilesMerge: profilesMerge,
    makeProfilesFile: makeProfilesFile,
    validateProfilesFile: validateProfilesFile,
    // 1.3：更新检查、本地组件、诊断
    RELEASE_PREFIX: RELEASE_PREFIX,
    UPDATE_INTERVAL_MS: UPDATE_INTERVAL_MS,
    semverCmp: semverCmp,
    parseRelease: parseRelease,
    updateBackoff: updateBackoff,
    updateDue: updateDue,
    updateNotice: updateNotice,
    NV_HOST_CAPS: NV_HOST_CAPS,
    nvHostCheck: nvHostCheck,
    diagRedact: diagRedact
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RtxHdrLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
