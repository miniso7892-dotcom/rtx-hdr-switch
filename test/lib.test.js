'use strict';
// 运行：node test/lib.test.js   （只依赖 node 内置模块）

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../lib.js');

const ROOT = path.join(__dirname, '..');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- videoKey ----------

test('videoKey: YouTube 各种形式', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&t=42s&list=PL123&si=abc`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://music.youtube.com/watch?v=${id}&si=x`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?si=xyz`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://youtu.be/${id}?si=share`
  ]) assert.equal(L.videoKey(url), `yt:${id}`, url);
  assert.ok(L.videoKey('https://www.youtube.com/').startsWith('u:'));
  assert.ok(L.videoKey('https://www.youtube.com/embed/videoseries?list=PL1').startsWith('u:'));
});

test('videoKey: YouTube 频道直播嵌入按频道区分', () => {
  assert.equal(L.videoKey('https://www.youtube.com/embed/live_stream?channel=UC123'), 'yt:live:UC123');
  assert.equal(L.videoKey('https://www.youtube-nocookie.com/embed/live_stream?channel=UC_x-9&autoplay=1'), 'yt:live:UC_x-9');
  assert.notEqual(L.videoKey('https://www.youtube.com/embed/live_stream?channel=UC123'),
    L.videoKey('https://www.youtube.com/embed/live_stream?channel=UC999'));
  // 没有频道参数：走兜底，不能变成 yt:live_stream
  const k = L.videoKey('https://www.youtube.com/embed/live_stream');
  assert.ok(k.startsWith('u:'), k);
});

test('videoKey: Bilibili', () => {
  assert.equal(L.videoKey('https://www.bilibili.com/video/BV1GJ411x7h7'), 'bili:BV1GJ411x7h7:p1');
  assert.equal(L.videoKey('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&spm_id_from=333.1&vd_source=abc'), 'bili:BV1GJ411x7h7:p3');
  assert.equal(L.videoKey('https://m.bilibili.com/video/BV1GJ411x7h7?p=0'), 'bili:BV1GJ411x7h7:p1');
  assert.equal(L.videoKey('https://www.bilibili.com/video/av170001'), 'bili:av:170001');
  assert.equal(L.videoKey('https://www.bilibili.com/bangumi/play/ep123456?from=search'), 'bili:ep:123456');
  assert.equal(L.videoKey('https://www.bilibili.com/bangumi/play/ss33802'), 'bili:ss:33802');
  assert.equal(L.videoKey('https://live.bilibili.com/21452505?broadcast_type=0'), 'blive:21452505');
  assert.equal(L.videoKey('https://live.bilibili.com/blanc/21452505'), 'blive:21452505');
  assert.equal(L.videoKey('https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&p=2&autoplay=0'), 'bili:BV1GJ411x7h7:p2');
  assert.equal(L.videoKey('https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7'), 'bili:BV1GJ411x7h7:p1');
  assert.equal(L.videoKey('https://player.bilibili.com/player.html?aid=170001'), 'bili:av:170001');
  assert.equal(L.videoKey('https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1GJ411x7h7&p=2'), 'bili:BV1GJ411x7h7:p2');
});

test('videoKey: 腾讯视频 / 爱奇艺 / Twitch', () => {
  assert.equal(L.videoKey('https://v.qq.com/x/cover/mzc00200abc/x0045xyz.html'), 'qq:x0045xyz');
  assert.equal(L.videoKey('https://v.qq.com/x/cover/mzc00200abc.html?ptag=1'), 'qq:mzc00200abc');
  assert.equal(L.videoKey('https://v.qq.com/x/page/b0035abc.html'), 'qq:b0035abc');
  assert.equal(L.videoKey('https://www.iqiyi.com/v_19rr7p8x2k.html?vfrm=pcw'), 'iqiyi:19rr7p8x2k');
  assert.equal(L.videoKey('https://www.twitch.tv/videos/1234567890?t=1h2m'), 'twitch:v:1234567890');
  assert.equal(L.videoKey('https://www.twitch.tv/SomeChannel'), 'twitch:somechannel');
  assert.equal(L.videoKey('https://www.twitch.tv/somechannel/videos'), 'twitch:somechannel');
  assert.ok(L.videoKey('https://www.twitch.tv/directory').startsWith('u:'));
  assert.equal(L.videoKey('https://player.twitch.tv/?video=v987&parent=x.com'), 'twitch:v:987');
  assert.equal(L.videoKey('https://player.twitch.tv/?channel=Foo&parent=x.com'), 'twitch:foo');
});

test('videoKey: Twitch 剪辑不和频道直播共用 key', () => {
  assert.equal(L.videoKey('https://www.twitch.tv/somechannel/clip/FunnyClip-abc'), 'twitch:clip:FunnyClip-abc');
  assert.equal(L.videoKey('https://www.twitch.tv/somechannel/clip/FunnyClip-abc?filter=clips'), 'twitch:clip:FunnyClip-abc');
  assert.equal(L.videoKey('https://m.twitch.tv/somechannel/clip/FunnyClip-abc'), 'twitch:clip:FunnyClip-abc');
  assert.equal(L.videoKey('https://clips.twitch.tv/FunnyClip-abc'), 'twitch:clip:FunnyClip-abc');
  assert.equal(L.videoKey('https://clips.twitch.tv/embed?clip=FunnyClip-abc&parent=x.com'), 'twitch:clip:FunnyClip-abc');
  assert.notEqual(L.videoKey('https://www.twitch.tv/somechannel/clip/FunnyClip-abc'), L.videoKey('https://www.twitch.tv/somechannel'));
  assert.equal(L.videoKey('https://www.twitch.tv/somechannel'), 'twitch:somechannel');
});

test('videoKey: 兜底去掉跟踪参数并排序', () => {
  assert.equal(
    L.videoKey('https://example.com/watch/42?utm_source=x&b=2&a=1&spm=1.2&from=feed&share_source=wx&vd_source=v&t=30&si=s&feature=f&fbclid=z#frag'),
    'u:https://example.com/watch/42?a=1&b=2');
  assert.equal(L.videoKey('https://example.com/v?z=1&a=2'), L.videoKey('https://example.com/v?a=2&z=1&utm_medium=m'));
  assert.equal(L.videoKey('https://example.com/'), 'u:https://example.com/');
  assert.equal(L.videoKey('https://example.com/a?q=hello%20world'), 'u:https://example.com/a?q=hello%20world');
  assert.equal(L.videoKey('not a url'), 'u:not a url');
  assert.equal(L.videoKey(''), 'u:');
  assert.ok(L.videoKey('about:blank').startsWith('u:about:'));
});

// ---------- decide ----------

const S = (patch) => L.mergeSettings(Object.assign({}, patch));
const NOON = 12 * 60;

test('decide: 每一级优先级', () => {
  const settings = S({
    sites: { 'example.com': 'on' },
    night: { enabled: true, start: '23:00', end: '07:00' },
    defaultState: 'on'
  });
  const base = { settings, hostname: 'www.example.com', minutes: 23 * 60 + 30, autoState: 'off' };

  // manual 压过一切
  assert.deepEqual(L.decide(Object.assign({}, base, { manual: 'on', saved: { s: 'off', t: 1 } })), { state: 'on', reason: 'manual' });
  assert.deepEqual(L.decide(Object.assign({}, base, { manual: { state: 'off', reason: 'eye' }, saved: { s: 'on', t: 1 } })), { state: 'off', reason: 'eye' });
  // video 压过 site/night/auto
  assert.deepEqual(L.decide(Object.assign({}, base, { saved: { s: 'off', t: 1 } })), { state: 'off', reason: 'video' });
  assert.deepEqual(L.decide(Object.assign({}, base, { saved: { s: 'on', t: 1 } })), { state: 'on', reason: 'video' });
  // site（去掉 www. 比较）压过 night/auto
  assert.deepEqual(L.decide(base), { state: 'on', reason: 'site' });
  // night 压过 auto/default
  assert.deepEqual(L.decide(Object.assign({}, base, { hostname: 'other.com' })), { state: 'off', reason: 'night' });
  // auto
  assert.deepEqual(L.decide(Object.assign({}, base, { hostname: 'other.com', minutes: NOON })), { state: 'off', reason: 'auto' });
  // default
  assert.deepEqual(L.decide(Object.assign({}, base, { hostname: 'other.com', minutes: NOON, autoState: 'on' })), { state: 'on', reason: 'default' });
  assert.deepEqual(L.decide({ settings: S({ defaultState: 'off' }), hostname: 'a.com', minutes: NOON }), { state: 'off', reason: 'default' });
});

test('decide: 细节', () => {
  // 自动检测关闭时忽略 autoState
  assert.equal(L.decide({ settings: S({ autoDetect: 'off' }), hostname: 'a.com', minutes: NOON, autoState: 'off' }).reason, 'default');
  // 非法的 saved / manual 被忽略
  assert.equal(L.decide({ settings: S(), hostname: 'a.com', minutes: NOON, saved: { s: 'maybe' }, manual: 'x' }).reason, 'default');
  // 网站规则可以写在顶层页面的域名上（视频在 iframe 里）
  const s = S({ sites: { 'blog.example': 'off' } });
  assert.deepEqual(L.decide({ settings: s, hostname: 'player.bilibili.com', topHostname: 'www.blog.example', minutes: NOON }), { state: 'off', reason: 'site' });
  // 顶层页面（弹窗「本网站」编辑的那个）的规则优先于 iframe 自身域名的规则
  const s2 = S({ sites: { 'blog.example': 'off', 'player.bilibili.com': 'on' } });
  assert.deepEqual(L.decide({ settings: s2, hostname: 'player.bilibili.com', topHostname: 'blog.example', minutes: NOON }), { state: 'off', reason: 'site' });
  const s3 = S({ sites: { 'youtube.com': 'on', 'example.com': 'off' } });
  assert.deepEqual(L.decide({ settings: s3, hostname: 'www.youtube.com', topHostname: 'example.com', minutes: 600 }), { state: 'off', reason: 'site' });
  // 顶层没有规则时用 iframe 自身域名的
  assert.deepEqual(L.decide({ settings: s3, hostname: 'www.youtube.com', topHostname: 'news.test', minutes: 600 }), { state: 'on', reason: 'site' });
  // 没有 settings 时用默认值
  assert.deepEqual(L.decide({}), { state: 'on', reason: 'default' });
  assert.deepEqual(L.decide(null), { state: 'on', reason: 'default' });
  // 用 now 计算夜间时段
  const night = S({ night: { enabled: true, start: '23:00', end: '07:00' } });
  assert.equal(L.decide({ settings: night, hostname: 'a.com', now: new Date(2026, 0, 1, 2, 0) }).reason, 'night');
  assert.equal(L.decide({ settings: night, hostname: 'a.com', now: new Date(2026, 0, 1, 12, 0) }).reason, 'default');
});

test('文案', () => {
  assert.equal(L.reasonText('manual'), '手动');
  assert.equal(L.reasonText('video'), '已记住此视频');
  assert.equal(L.reasonText('site'), '网站规则');
  assert.equal(L.reasonText('night'), '夜间护眼');
  assert.equal(L.reasonText('auto'), '自动检测(白底)');
  assert.equal(L.reasonText('eye'), '护眼提醒');
  assert.equal(L.reasonText('default'), '默认');
  assert.equal(L.osdText('on', 'manual'), 'RTX HDR：开（手动）');
  assert.equal(L.osdText('off', 'auto'), 'RTX HDR：关（自动检测·白底）');
  assert.equal(L.formatLuma(0.72, 0.41), '画面亮度 72% · 白色占比 41%');
  assert.equal(L.formatLuma(null, null), '');
});

// ---------- 夜间时段 ----------

test('夜间时段：跨午夜', () => {
  const n = { enabled: true, start: '23:00', end: '07:00' };
  const at = (h, m) => L.inNightWindow(n, h * 60 + m);
  assert.equal(at(22, 59), false);
  assert.equal(at(23, 0), true);
  assert.equal(at(0, 0), true);
  assert.equal(at(6, 59), true);
  assert.equal(at(7, 0), false);
  assert.equal(at(12, 0), false);
});

test('夜间时段：不跨午夜、关闭、非法', () => {
  const n = { enabled: true, start: '13:30', end: '15:00' };
  assert.equal(L.inNightWindow(n, 13 * 60 + 29), false);
  assert.equal(L.inNightWindow(n, 13 * 60 + 30), true);
  assert.equal(L.inNightWindow(n, 14 * 60 + 59), true);
  assert.equal(L.inNightWindow(n, 15 * 60), false);
  assert.equal(L.inNightWindow(Object.assign({}, n, { enabled: false }), 14 * 60), false);
  assert.equal(L.inNightWindow({ enabled: true, start: '10:00', end: '10:00' }, 10 * 60), false);
  assert.equal(L.inNightWindow({ enabled: true, start: 'xx', end: '07:00' }, 0), false);
  assert.equal(L.parseTime('7:05'), 425);
  assert.equal(L.parseTime('24:00'), null);
  assert.equal(L.parseTime('12:60'), null);
});

// ---------- analyzeFrame ----------

function frame(pixels) {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => { out.set([p[0], p[1], p[2], 255], i * 4); });
  return out;
}
const fill = (rgb, n) => Array.from({ length: n }, () => rgb);

test('analyzeFrame', () => {
  const white = L.analyzeFrame(frame(fill([255, 255, 255], 100)));
  assert.ok(Math.abs(white.mean - 1) < 1e-9);
  assert.equal(white.white, 1);
  assert.equal(white.black, 0);

  const black = L.analyzeFrame(frame(fill([0, 0, 0], 100)));
  assert.equal(black.mean, 0);
  assert.equal(black.black, 1);
  assert.equal(black.white, 0);

  // Rec.709 权重：纯绿比纯红亮得多
  const g = L.analyzeFrame(frame([[0, 255, 0]]));
  const r = L.analyzeFrame(frame([[255, 0, 0]]));
  assert.ok(Math.abs(g.mean - 0.7152) < 1e-9);
  assert.ok(Math.abs(r.mean - 0.2126) < 1e-9);

  const half = L.analyzeFrame(frame(fill([255, 255, 255], 50).concat(fill([0, 0, 0], 50))));
  assert.ok(Math.abs(half.mean - 0.5) < 1e-9);
  assert.equal(half.white, 0.5);
  assert.equal(half.black, 0.5);

  // 0.85 / 0.03 是严格不等
  const mid = L.analyzeFrame(frame([[217, 217, 217], [7, 7, 7]])); // 217/255≈0.851, 7/255≈0.027
  assert.equal(mid.white, 0.5);
  assert.equal(mid.black, 0.5);

  assert.deepEqual(L.analyzeFrame(new Uint8ClampedArray(0)), { mean: 0, white: 0, black: 1 });
  assert.equal(L.analyzeFrame(null).black, 1);
});

// ---------- 自动检测状态机 ----------

const BRIGHT = { mean: 0.9, white: 0.8, black: 0 };
const DARK = { mean: 0.2, white: 0.05, black: 0.1 };
const GREY = { mean: 0.5, white: 0.25, black: 0 }; // medium 下既不亮也不暗
const BLACK = { mean: 0.01, white: 0, black: 0.995 };

function feed(det, samples, start, step) {
  let t = start || 0;
  for (const s of samples) { det.update(s, t); t += step || 1500; }
  return t;
}

test('自动检测：连续 3 个亮帧才关闭', () => {
  const d = L.createAutoDetector('medium', 'disable');
  assert.equal(d.state, 'on');
  feed(d, [BRIGHT, BRIGHT]);
  assert.equal(d.state, 'on');
  feed(d, [BRIGHT], 3000);
  assert.equal(d.state, 'off');

  const d2 = L.createAutoDetector('medium', 'disable');
  feed(d2, [BRIGHT, BRIGHT, GREY, BRIGHT, BRIGHT]);
  assert.equal(d2.state, 'on', '中间夹一个非亮帧要重新计数');
});

test('自动检测：disable 模式粘滞', () => {
  const d = L.createAutoDetector('medium', 'disable');
  const t = feed(d, [BRIGHT, BRIGHT, BRIGHT]);
  assert.equal(d.state, 'off');
  assert.equal(d.settled, true);
  feed(d, Array(30).fill(DARK), t, 60000);
  assert.equal(d.state, 'off');
  d.reset();
  assert.equal(d.state, 'on');
  assert.equal(d.settled, false);
});

test('自动检测：both 模式恢复与 10 秒最短保持', () => {
  const d = L.createAutoDetector('medium', 'both');
  feed(d, [BRIGHT, BRIGHT, BRIGHT], 0); // 第 3 帧在 t=3000 关闭
  assert.equal(d.state, 'off');
  assert.equal(d.settled, false);

  // 6 个暗帧，但离上次切换不到 10 秒 → 保持
  feed(d, Array(6).fill(DARK), 3100, 1000); // t = 3100..8100
  assert.equal(d.state, 'off');
  // 保持期结束后，下一个暗帧（累计仍连续）立即恢复
  d.update(DARK, 13000);
  assert.equal(d.state, 'on');

  // 恢复后同样要保持 10 秒才能再次关闭
  feed(d, [BRIGHT, BRIGHT, BRIGHT, BRIGHT], 14000, 1000); // t = 14000..17000
  assert.equal(d.state, 'on');
  d.update(BRIGHT, 23000);
  assert.equal(d.state, 'off');
});

test('自动检测：both 模式暗帧必须连续 6 个', () => {
  const d = L.createAutoDetector('medium', 'both');
  feed(d, [BRIGHT, BRIGHT, BRIGHT], 0);
  feed(d, [DARK, DARK, DARK, DARK, DARK, GREY, DARK, DARK, DARK, DARK, DARK], 20000);
  assert.equal(d.state, 'off');
  d.update(DARK, 60000);
  assert.equal(d.state, 'on');
});

test('自动检测：全黑帧不计入', () => {
  const d = L.createAutoDetector('medium', 'disable');
  feed(d, [BRIGHT, BLACK, BRIGHT, BLACK, BLACK, BRIGHT]);
  assert.equal(d.state, 'off', '黑帧既不打断也不计数');

  const d2 = L.createAutoDetector('medium', 'both');
  feed(d2, [BRIGHT, BRIGHT, BRIGHT], 0);
  feed(d2, [DARK, DARK, DARK, BLACK, BLACK, DARK, DARK, DARK], 20000);
  assert.equal(d2.state, 'on');

  const d3 = L.createAutoDetector('medium', 'disable');
  feed(d3, [BRIGHT, BRIGHT, BLACK]);
  assert.equal(d3.state, 'on', '黑帧不能当亮帧');
});

test('自动检测：灵敏度阈值', () => {
  const cases = [
    // [sample, low, medium, high]
    [{ mean: 0.5, white: 0.46, black: 0 }, true, true, true],
    [{ mean: 0.5, white: 0.30, black: 0 }, false, true, true],
    [{ mean: 0.5, white: 0.20, black: 0 }, false, false, true],
    [{ mean: 0.5, white: 0.19, black: 0 }, false, false, false],
    [{ mean: 0.70, white: 0, black: 0 }, true, true, true],
    [{ mean: 0.62, white: 0, black: 0 }, false, true, true],
    [{ mean: 0.55, white: 0, black: 0 }, false, false, true],
    [{ mean: 0.54, white: 0, black: 0 }, false, false, false]
  ];
  for (const [sample, ...expect] of cases) {
    ['low', 'medium', 'high'].forEach((sens, i) => {
      const d = L.createAutoDetector(sens, 'disable');
      feed(d, [sample, sample, sample]);
      assert.equal(d.state === 'off', expect[i], `${sens} ${JSON.stringify(sample)}`);
    });
  }
  assert.deepEqual(L.createAutoDetector('bogus', 'disable').thresholds, L.THRESHOLDS.medium);
});

test('自动检测：以 off 状态重建（已判定白底的视频 loadstart、改灵敏度后不回到 HDR）', () => {
  const d = L.createAutoDetector('high', 'disable', 'off');
  assert.equal(d.state, 'off');
  assert.equal(d.settled, true);
  feed(d, Array(10).fill(DARK));
  assert.equal(d.state, 'off', 'disable 模式保持');

  // both 模式从 off 开始：照常需要 6 个暗帧才恢复，没有 10 秒保持期的限制（之前没切换过）
  const b = L.createAutoDetector('medium', 'both', 'off');
  assert.equal(b.state, 'off');
  assert.equal(b.settled, false);
  feed(b, Array(5).fill(DARK), 0, 1500);
  assert.equal(b.state, 'off');
  b.update(DARK, 7500);
  assert.equal(b.state, 'on');

  // off 模式不检测，忽略初始 off
  assert.equal(L.createAutoDetector('medium', 'off', 'off').state, 'on');
  // reset() 回到 on
  d.reset();
  assert.equal(d.state, 'on');
  assert.equal(L.createAutoDetector('medium', 'disable', 'bogus').state, 'on');
});

test('自动检测：off 模式与非法输入', () => {
  const d = L.createAutoDetector('high', 'off');
  feed(d, Array(10).fill(BRIGHT));
  assert.equal(d.state, 'on');
  assert.equal(d.settled, true);
  const d2 = L.createAutoDetector('medium', 'disable');
  for (const bad of [null, undefined, 5, {}, { mean: NaN, white: 1 }]) d2.update(bad, 0);
  assert.equal(d2.state, 'on');
});

// ---------- mergeSettings ----------

test('mergeSettings: 缺失字段补默认值', () => {
  assert.deepEqual(L.mergeSettings(undefined), JSON.parse(JSON.stringify(L.DEFAULT_SETTINGS)));
  assert.deepEqual(L.mergeSettings(null), L.mergeSettings({}));
  assert.deepEqual(L.mergeSettings('garbage'), L.mergeSettings({}));
  const m = L.mergeSettings({ osd: false, night: { enabled: true } });
  assert.equal(m.osd, false);
  assert.deepEqual(m.night, { enabled: true, start: '23:00', end: '07:00' });
  assert.deepEqual(m.eye, { minutes: 45, autoOff: false });
  assert.equal(m.defaultState, 'on');
  assert.equal(m.autoDetect, 'disable');
  assert.equal(m.autoLastMode, 'disable');
  assert.equal(m.sensitivity, 'medium');
  assert.equal(m.rememberManual, true);
  assert.deepEqual(m.sites, {});
});

test('mergeSettings: 旧字段和非法值', () => {
  const m = L.mergeSettings({
    autoDetect: true, defaultState: false, sensitivity: 'ultra', autoLastMode: 'off',
    night: { enabled: 'yes', start: '7:5', end: '6:30' },
    eye: { minutes: '30', autoOff: 1 },
    sites: { 'WWW.Example.COM': 'off', 'b.com': 'maybe', '': 'on', 'c.com.': 'on' },
    legacyField: 123
  });
  assert.equal(m.autoDetect, 'disable');
  assert.equal(m.defaultState, 'off');
  assert.equal(m.sensitivity, 'medium');
  assert.equal(m.autoLastMode, 'disable');
  assert.equal(m.night.enabled, false);
  assert.equal(m.night.start, '23:00', '7:5 不合法');
  assert.equal(m.night.end, '06:30', '补零');
  assert.equal(m.eye.minutes, 30);
  assert.equal(m.eye.autoOff, false);
  assert.deepEqual(m.sites, { 'example.com': 'off', 'c.com': 'on' });
  assert.ok(!('legacyField' in m));
  assert.equal(L.mergeSettings({ autoDetect: false }).autoDetect, 'off');
  assert.equal(L.mergeSettings({ eye: { minutes: -5 } }).eye.minutes, 0);
  assert.equal(L.mergeSettings({ eye: { minutes: 99999 } }).eye.minutes, 600);
  assert.equal(L.mergeSettings({ eye: { minutes: 'abc' } }).eye.minutes, 45);
  assert.equal(L.mergeSettings({ eye: { minutes: 0 } }).eye.minutes, 0);
});

test('mergeSettings: 不修改输入、不共享默认对象', () => {
  const input = { sites: { 'a.com': 'on' }, night: { enabled: true, start: '22:00', end: '06:00' } };
  const snapshot = JSON.stringify(input);
  const m = L.mergeSettings(input);
  assert.equal(JSON.stringify(input), snapshot);
  m.sites['x.com'] = 'off';
  m.night.enabled = false;
  assert.deepEqual(L.mergeSettings(null).sites, {});
  assert.equal(L.mergeSettings(null).night.enabled, false);
  assert.ok(Object.isFrozen(L.DEFAULT_SETTINGS.night));
});

test('toggleAutoMode', () => {
  let s = L.mergeSettings({ autoDetect: 'both' });
  s = L.toggleAutoMode(s);
  assert.equal(s.autoDetect, 'off');
  assert.equal(s.autoLastMode, 'both');
  s = L.toggleAutoMode(s);
  assert.equal(s.autoDetect, 'both');
  assert.equal(L.toggleAutoMode({ autoDetect: 'off' }).autoDetect, 'disable');
  assert.equal(L.toggleAutoMode(undefined).autoDetect, 'off');
});

// ---------- pruneKeys ----------

test('pruneKeys', () => {
  const entries = { settings: { osd: true } };
  for (let i = 0; i < 10; i++) entries['v:k' + i] = { s: 'on', t: 1000 + i };
  assert.deepEqual(L.pruneKeys(entries, 10), []);
  assert.deepEqual(L.pruneKeys(entries, 7), ['v:k0', 'v:k1', 'v:k2']);
  assert.deepEqual(L.pruneKeys(entries, 0).length, 10);
  entries['v:old'] = { s: 'off' }; // 没有时间戳的当作最旧
  assert.deepEqual(L.pruneKeys(entries, 10), ['v:old']);
  assert.deepEqual(L.pruneKeys([['v:a', { t: 5 }], ['v:b', { t: 1 }], ['x', {}]], 1), ['v:b']);
  assert.deepEqual(L.pruneKeys(null, 1), []);
  const many = {};
  for (let i = 0; i < 2005; i++) many['v:' + i] = { s: 'on', t: i };
  assert.deepEqual(L.pruneKeys(many), ['v:0', 'v:1', 'v:2', 'v:3', 'v:4']);
});

// ---------- 选择主视频 / 最佳 frame ----------

test('pickPrimary', () => {
  assert.equal(L.pickPrimary([]), -1);
  assert.equal(L.pickPrimary([{ area: 0, playing: true }]), -1);
  assert.equal(L.pickPrimary([{ area: 100, playing: false }, { area: 50, playing: true }]), 1);
  assert.equal(L.pickPrimary([{ area: 100, playing: true }, { area: 500, playing: true }, { area: 900, playing: false }]), 1);
  assert.equal(L.pickPrimary([{ area: 100, playing: false }, { area: 300, playing: false }]), 1);
});

test('pickBestFrame', () => {
  const now = 100000;
  const frames = {
    0: { hasVideo: false, ts: now },
    3: { hasVideo: true, playing: false, area: 9000, ts: now, state: 'on' },
    5: { hasVideo: true, playing: true, area: 100, ts: now, state: 'off' },
    7: { hasVideo: true, playing: true, area: 99999, ts: now - 60000, state: 'on' }
  };
  const best = L.pickBestFrame(frames, now, 10000);
  assert.equal(best.frameId, 5);
  assert.equal(best.report.state, 'off');
  delete frames[5];
  assert.equal(L.pickBestFrame(frames, now, 10000).frameId, 3);
  assert.equal(L.pickBestFrame({ 0: { hasVideo: false } }, now, 10000), null);
  assert.equal(L.pickBestFrame({ 2: { hasVideo: true, ts: 1 } }, now, 10000).frameId, 2, '过期的也可以兜底');
  assert.equal(L.pickBestFrame(null, now, 10000), null);
});

test('pickBestFrame: 长时间没消息的子 frame 不算（iframe 已消失）', () => {
  const now = 100000;
  const frames = {
    0: { hasVideo: false, ts: now },
    7: { hasVideo: true, playing: true, area: 300000, ts: now - 15000, state: 'on' }
  };
  assert.equal(L.pickBestFrame(frames, now, 10000, 10000), null);
  assert.equal(L.pickBestFrame(frames, now, 10000).frameId, 7, '不传 childMaxAgeMs 时行为不变');
  frames[7].ts = now - 4000;
  assert.equal(L.pickBestFrame(frames, now, 10000, 10000).frameId, 7);
  // 顶层 frame 过期仍可兜底
  assert.equal(L.pickBestFrame({ 0: { hasVideo: true, ts: 1, state: 'off' } }, now, 10000, 10000).frameId, 0);
  // 活着的子 frame 压过过期的顶层
  const f2 = { 0: { hasVideo: true, playing: true, area: 9e9, ts: now - 60000 }, 4: { hasVideo: true, area: 10, ts: now } };
  assert.equal(L.pickBestFrame(f2, now, 10000, 10000).frameId, 4);
});

// ---------- 关闭用的滤镜 ----------

test('offFilterFor / isOffFilter：保留页面自己的滤镜', () => {
  const OFF = L.OFF_FILTER;
  assert.equal(OFF, 'brightness(0.9999)');
  assert.equal(L.offFilterFor(''), OFF);
  assert.equal(L.offFilterFor(null), OFF);
  assert.equal(L.offFilterFor('none'), OFF);
  assert.equal(L.offFilterFor(' None '), OFF);
  for (const kw of ['initial', 'inherit', 'unset', 'revert', 'revert-layer']) assert.equal(L.offFilterFor(kw), OFF, kw);
  assert.equal(L.offFilterFor('contrast(1.2)'), 'contrast(1.2) ' + OFF);
  assert.equal(L.offFilterFor('blur(4px) saturate(2)'), 'blur(4px) saturate(2) ' + OFF);
  assert.equal(L.offFilterFor('url("#f")'), 'url("#f") ' + OFF);
  // var() 组合后可能在计算时失效，不叠加
  assert.equal(L.offFilterFor('var(--x)'), OFF);

  assert.equal(L.isOffFilter(OFF), true);
  assert.equal(L.isOffFilter('contrast(1.2) ' + OFF), true);
  assert.equal(L.isOffFilter(' ' + OFF + ' '), true);
  assert.equal(L.isOffFilter('contrast(1.2)'), false);
  assert.equal(L.isOffFilter('xbrightness(0.9999)'), false);
  assert.equal(L.isOffFilter(''), false);
  assert.equal(L.isOffFilter(null), false);
  // 叠加后仍然能被识别成「我们的」
  for (const o of ['', 'none', 'contrast(1.2)', 'var(--x)']) assert.equal(L.isOffFilter(L.offFilterFor(o)), true, o);
});

// ---------- 护眼计时 ----------

const MIN = 60000;
function eye(minutes, autoOff) { return { minutes: minutes, autoOff: !!autoOff }; }

test('护眼：跨视频持续累计，到点提醒后清零', () => {
  const s = L.eyeState(null);
  assert.deepEqual(s, { ms: 0, lastHdrAt: 0, lastWatchAt: 0, rest: false });
  let t = 1e12;
  let reminders = 0;
  // 连播 3 个 90 秒的视频（中间切视频不影响累计），每 3 秒一次上报
  for (let i = 0; i < 90; i++) {
    t += 3000;
    if (L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(2), t).remind) reminders++;
  }
  assert.equal(reminders, 2, '270 秒、每 2 分钟提醒一次');
  assert.equal(s.ms, 30000);
  assert.equal(s.rest, false, '没开自动切回 SDR');
});

test('护眼：停看超过 5 分钟清零，短暂停不清零；SDR 时间不计入', () => {
  const s = L.eyeState(null);
  let t = 1e12;
  L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(45), t);
  t += 4 * MIN; // 暂停 4 分钟
  L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(45), t);
  assert.equal(s.ms, 6000);
  // SDR 下继续看：只算观看，不算 HDR
  t += 3000;
  L.eyeUpdate(s, { hdr: 0, watch: 3000 }, eye(45), t);
  assert.equal(s.ms, 6000);
  t += 6 * MIN; // 停看 6 分钟后第一份报告（哪怕没有增量）就清零
  L.eyeUpdate(s, {}, eye(45), t);
  assert.equal(s.ms, 0);
});

test('护眼：多个标签页同时上报不重复累计', () => {
  const s = L.eyeState(null);
  let t = 1e12;
  L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(45), t);
  // 两个 frame 交错上报，每份都说自己看了 3 秒，实际每 1.5 秒一份
  for (let i = 0; i < 10; i++) {
    t += 1500;
    L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(45), t);
  }
  assert.equal(s.ms, 3000 + 10 * 1500);
});

test('护眼：到时自动切回 SDR —— 护眼 SDR 持续到停看 5 分钟或关掉选项', () => {
  const s = L.eyeState(null);
  let t = 1e12;
  let r = null;
  for (let i = 0; i < 20; i++) { t += 3000; r = L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(1, true), t); if (r.remind) break; }
  assert.equal(r.remind, true);
  assert.equal(r.restChanged, true);
  assert.equal(s.rest, true);
  // 换到下一个视频继续看（SDR）：护眼 SDR 保持
  for (let i = 0; i < 100; i++) { t += 3000; r = L.eyeUpdate(s, { hdr: 0, watch: 3000 }, eye(1, true), t); }
  assert.equal(s.rest, true);
  assert.equal(r.restChanged, false);
  // 暂停 5 分钟以上 → 结束
  t += 5 * MIN + 1000;
  r = L.eyeUpdate(s, { hdr: 0, watch: 3000 }, eye(1, true), t);
  assert.equal(s.rest, false);
  assert.equal(r.restChanged, true);
  // 关掉「到时自动切回 SDR」也结束
  s.rest = true;
  r = L.eyeUpdate(s, {}, eye(1, false), t + 1000);
  assert.equal(s.rest, false);
  assert.equal(r.restChanged, true);
  // 提醒间隔设为 0：关闭，计时清零
  s.ms = 5000;
  r = L.eyeUpdate(s, { hdr: 3000, watch: 3000 }, eye(0, true), t + 2000);
  assert.equal(r.remind, false);
  assert.equal(s.ms, 0);
});

test('护眼：存储格式与提醒文案', () => {
  assert.deepEqual(L.eyeState({ ms: -1, lastHdrAt: 'x', lastWatchAt: 5, rest: 1 }), { ms: 0, lastHdrAt: 0, lastWatchAt: 5, rest: false });
  assert.equal(L.eyeRestAt({ on: true, at: 123 }), 123);
  assert.equal(L.eyeRestAt({ on: true }), 1);
  assert.equal(L.eyeRestAt({ on: false, at: 5 }), 0);
  assert.equal(L.eyeRestAt(undefined), 0);
  assert.equal(L.EYE_REST_KEY, 'eyeRest');
  assert.equal(L.eyeReminderText(45, false, 'Alt+H'), '已连续观看 HDR 45 分钟，休息一下眼睛吧');
  assert.equal(L.eyeReminderText(45, true, 'Alt+H'), '已连续观看 HDR 45 分钟，已切回 SDR，休息一下眼睛吧（按 Alt+H 可恢复 HDR）');
  assert.equal(L.eyeReminderText(30, true, ''), '已连续观看 HDR 30 分钟，已切回 SDR，休息一下眼睛吧（可在扩展弹窗里恢复 HDR）');
  assert.equal(L.reasonText('drm'), '受版权保护，无法控制');
  assert.equal(L.reasonText('contested'), '页面不断改写视频样式，无法关闭');
});

// ---------- 纯度 ----------

test('lib.js 不引用 chrome / document / window', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bchrome\./.test(src), 'chrome');
  assert.ok(!/\bdocument\b/.test(src), 'document');
  assert.ok(!/\bwindow\b/.test(src), 'window');
  assert.equal(typeof globalThis.RtxHdrLib, 'object', '同时挂在 globalThis 上');
});

// ---------- manifest ----------

test('manifest.json 合法且引用的文件都存在', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'HDR Switch for RTX Video');
  assert.ok(manifest.name.length <= 75, 'name 不超过 75 字符');
  assert.equal(new URL(manifest.homepage_url).protocol, 'https:', 'homepage_url 是合法的 https 网址');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions.slice().sort(), ['scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.ok(manifest.description.length <= 132, 'description 不超过 132 字符');

  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.js, ['lib.js', 'content.js']);
  assert.equal(cs.all_frames, true);
  assert.equal(cs.match_about_blank, true);
  assert.equal(cs.match_origin_as_fallback, true);
  assert.equal(cs.run_at, 'document_start');
  assert.equal(manifest.commands['toggle-hdr'].suggested_key.default, 'Alt+H');
  assert.equal(manifest.commands['toggle-auto'].suggested_key.default, 'Alt+Shift+H');
  assert.ok(!manifest.commands['forget-video'].suggested_key);

  const files = new Set([manifest.background.service_worker, manifest.action.default_popup]);
  for (const c of manifest.content_scripts) for (const f of c.js || []) files.add(f);
  for (const f of Object.values(manifest.icons)) files.add(f);
  for (const f of Object.values(manifest.action.default_icon)) files.add(f);
  // popup.html 里引用的脚本和样式
  const html = fs.readFileSync(path.join(ROOT, manifest.action.default_popup), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) files.add(m[1]);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), '缺少文件 ' + f);

  // 图标尺寸与文件名一致（PNG IHDR）
  for (const [size, f] of Object.entries(manifest.icons)) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    assert.equal(buf.toString('ascii', 1, 4), 'PNG', f);
    assert.equal(buf.readUInt32BE(16), Number(size), f + ' 宽度');
    assert.equal(buf.readUInt32BE(20), Number(size), f + ' 高度');
  }
});

// ---------- 运行 ----------

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log('  ok    ' + t.name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + t.name);
    console.log('        ' + String(e && e.message || e).split('\n').join('\n        '));
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
process.exitCode = failed ? 1 : 0;
