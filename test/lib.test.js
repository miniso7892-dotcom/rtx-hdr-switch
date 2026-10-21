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

// ---------- 控制栏按钮的网站 ----------

test('playerSite: 有控制栏按钮的网站（按 frame 自己的完整域名）', () => {
  assert.equal(L.playerSite('www.bilibili.com', '/video/BV1GJ411x7h7/'), 'bilibili');
  assert.equal(L.playerSite('www.bilibili.com', '/bangumi/play/ep123456'), 'bilibili');
  assert.equal(L.playerSite('www.bilibili.com', '/list/watchlater'), 'bilibili');
  assert.equal(L.playerSite('www.bilibili.com', '/festival/2026bnj'), 'bilibili');
  assert.equal(L.playerSite('bilibili.com'), 'bilibili');
  assert.equal(L.playerSite('player.bilibili.com', '/player.html'), 'bilibili', '嵌入播放器');
  assert.equal(L.playerSite(' WWW.BiliBili.COM. ', '/video/x'), 'bilibili', '大小写、末尾的点');
  assert.equal(L.playerSite('www.youtube.com', '/watch'), 'youtube');
  assert.equal(L.playerSite('www.youtube.com', '/'), 'youtube', '首页（小窗里的播放器）');
  assert.equal(L.playerSite('youtube.com'), 'youtube');
  assert.equal(L.playerSite('www.twitch.tv', '/somechannel'), 'twitch');
  assert.equal(L.playerSite('twitch.tv', '/videos/1'), 'twitch');
  assert.equal(L.playerSite('v.qq.com', '/x/cover/mzc00200abc/x0045xyz.html'), 'tencent');
});

test('playerSite: 嵌入播放器、直播、其他网站不加按钮', () => {
  assert.equal(L.playerSite('www.youtube.com', '/embed/dQw4w9WgXcQ'), null);
  assert.equal(L.playerSite('www.youtube.com', '/EMBED/x'), null);
  assert.equal(L.playerSite('www.youtube.com', '/embed'), null);
  assert.equal(L.playerSite('www.youtube.com', '/embedded-page'), 'youtube', '只排除 /embed/ 这一段');
  for (const h of ['www.youtube-nocookie.com', 'm.youtube.com', 'music.youtube.com', 'live.bilibili.com', 'm.bilibili.com',
    'space.bilibili.com', 'www.iqiyi.com', 'm.v.qq.com', 'player.twitch.tv', 'clips.twitch.tv', 'example.com', '', null, undefined]) {
    assert.equal(L.playerSite(h, '/'), null, String(h));
  }
  // 只认完整域名，不按后缀或子串
  assert.equal(L.playerSite('www.bilibili.com.evil.example'), null);
  assert.equal(L.playerSite('evil-youtube.com'), null);
  assert.equal(L.playerSite('notv.qq.com'), null);
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

// ---------- NVIDIA 设置 ----------

// 规格里的示例 State（本机基线）
const NV_STATE = Object.freeze({
  hdr: { supported: true, enabled: true, active: false, error: 0, peak: 1000, peakMin: 400, peakMax: 1970, middleGrey: 65, contrast: 25, saturation: 0 },
  vsr: { supported: true, mode: 5, level: 0, priority: 2 },
  indicator: false,
  flags: 0
});
const nvState = (patch) => {
  const s = JSON.parse(JSON.stringify(NV_STATE));
  if (patch && patch.hdr) Object.assign(s.hdr, patch.hdr);
  if (patch && patch.vsr) Object.assign(s.vsr, patch.vsr);
  return s;
};
const preset = (id, name, extra) => Object.assign({ id: id, name: name, hdr: { peak: 1000, middleGrey: 50, contrast: 0, saturation: 0 } }, extra);

test('NV 常量', () => {
  assert.equal(L.NV_HOST, 'io.github.rtx_hdr_switch');
  assert.ok(/^[a-z0-9._]+$/.test(L.NV_HOST), '本地组件名只能用 [a-z0-9._]');
  assert.equal(L.NV_PROTOCOL, 1);
  assert.equal(L.NV_MAX_PRESETS, 20);
  assert.deepEqual(L.NV_RANGES.hdr.middleGrey, { min: 10, max: 100 });
  assert.deepEqual(L.NV_RANGES.hdr.contrast, { min: -100, max: 100 });
  assert.deepEqual(L.NV_RANGES.hdr.saturation, { min: -100, max: 100 });
  assert.deepEqual(L.NV_RANGES.hdr.peak, { min: 400, max: 10000 });
  assert.deepEqual(L.NV_RANGES.vsr.mode, { min: 0, max: 5 });
  assert.deepEqual(L.NV_RANGES.vsr.priority, { min: 0, max: 2 });
  assert.ok(Object.isFrozen(L.NV_RANGES.hdr.peak));
});

test('mergeSettings: nv 默认值', () => {
  const m = L.mergeSettings(null);
  assert.deepEqual(m.nv, { presets: [], nightPresetId: null, dayPresetId: null, followSdr: false, displayId: null });
  assert.deepEqual(L.mergeSettings({ nv: 'x' }).nv, m.nv);
  assert.deepEqual(L.mergeSettings({ nv: { presets: 'x', nightPresetId: 5 } }).nv, m.nv);
  // 不共享默认对象
  m.nv.presets.push(1);
  assert.deepEqual(L.mergeSettings(null).nv.presets, []);
  assert.ok(Object.isFrozen(L.DEFAULT_SETTINGS.nv.presets));
});

test('mergeSettings: nv 预设规范化', () => {
  const m = L.mergeSettings({
    nv: {
      presets: [
        { id: 'a', name: '  夜间  ', hdr: { enabled: false, peak: 99999, middleGrey: 5, contrast: -500, saturation: '30' }, vsr: { mode: 9, priority: -1 }, junk: 1 },
        { id: 'b', name: 'x', hdr: { peak: 650.4, middleGrey: 100.6, contrast: 12.5, saturation: -100 } },
        { id: 'c', name: 'vsr 不完整', hdr: { peak: 800, middleGrey: 50, contrast: 0, saturation: 0 }, vsr: { mode: 2 } },
        { id: 'd', name: 'enabled 不是布尔', hdr: { enabled: 1, peak: 800, middleGrey: 50, contrast: 0, saturation: 0 } },
        { id: 'e', name: 'vsr 没有 mode', hdr: { peak: 800, middleGrey: 50, contrast: 0, saturation: 0 }, vsr: { priority: 1 } }
      ],
      nightPresetId: 'a',
      dayPresetId: 'b'
    }
  });
  const [a, b, c, d, e] = m.nv.presets;
  assert.ok(!('vsr' in e), '没有 mode 的 vsr 去掉');
  assert.deepEqual(a, { id: 'a', name: '夜间', hdr: { enabled: false, peak: 10000, middleGrey: 10, contrast: -100, saturation: 30 }, vsr: { mode: 5, priority: 0 } });
  assert.deepEqual(b, { id: 'b', name: 'x', hdr: { peak: 650, middleGrey: 100, contrast: 13, saturation: -100 } });
  assert.deepEqual(c.vsr, { mode: 2 }, 'vsr 可以没有 priority（驱动没有 GPU 优先级）');
  assert.ok(!('enabled' in d.hdr), '非布尔的 enabled 去掉');
  assert.equal(m.nv.nightPresetId, 'a');
  assert.equal(m.nv.dayPresetId, 'b');
  assert.equal(L.mergeSettings({ nv: { presets: [preset('a', 'x', { hdr: { peak: 1, middleGrey: 50, contrast: 0, saturation: 0 } })] } }).nv.presets[0].hdr.peak, 400);
  // 规范化是幂等的
  assert.deepEqual(L.mergeSettings(m), m);
});

test('mergeSettings: nv 预设名称、id、数量和引用', () => {
  const bad = [
    null, 'x', [], { id: 'a', name: 'x' }, // 没有 hdr
    preset('', 'x'), preset('has space', 'x'), preset('a'.repeat(41), 'x'), preset(5, 'x'), // id 不合法
    preset('n1', ''), preset('n2', '   '), preset('n3', 7), // 名称为空或不是字符串
    preset('m1', 'x', { hdr: { peak: 1000, middleGrey: 'abc', contrast: 0, saturation: 0 } }),
    preset('m2', 'x', { hdr: { peak: 1000, middleGrey: 50, contrast: 0 } }),
    preset('m3', 'x', { hdr: { peak: NaN, middleGrey: 50, contrast: 0, saturation: 0 } })
  ];
  assert.deepEqual(L.mergeSettings({ nv: { presets: bad } }).nv.presets, []);

  // 名称最多 24 个字符（按码点，不拆 emoji）
  const long = L.mergeSettings({ nv: { presets: [preset('a', '一二三四五六七八九十一二三四五六七八九十一二三四五六七八'), preset('b', '😀'.repeat(30))] } }).nv.presets;
  assert.equal(long[0].name, '一二三四五六七八九十一二三四五六七八九十一二三四');
  assert.equal(Array.from(long[1].name).length, 24);
  assert.equal(long[1].name, '😀'.repeat(24));

  // 重复 id 只保留第一个；最多 20 个
  const many = [];
  for (let i = 0; i < 30; i++) many.push(preset('p' + i, '预设 ' + i));
  many.splice(1, 0, preset('p0', '重复'));
  const n = L.mergeSettings({ nv: { presets: many, nightPresetId: 'p25', dayPresetId: 'p19' } }).nv;
  assert.equal(n.presets.length, 20);
  assert.equal(n.presets[0].name, '预设 0');
  assert.equal(n.presets[1].id, 'p1');
  assert.equal(n.nightPresetId, null, '第 21 个以后被截掉的预设不能被引用');
  assert.equal(n.dayPresetId, 'p19');

  // 指向不存在的预设变回 null
  const r = L.mergeSettings({ nv: { presets: [preset('a', 'x')], nightPresetId: 'zzz', dayPresetId: '' } }).nv;
  assert.equal(r.nightPresetId, null);
  assert.equal(r.dayPresetId, null);
  // 不修改输入
  const input = { nv: { presets: [preset('a', ' x ')] } };
  const snap = JSON.stringify(input);
  L.mergeSettings(input);
  assert.equal(JSON.stringify(input), snap);
});

test('nvNormState', () => {
  assert.deepEqual(L.nvNormState(NV_STATE), NV_STATE);
  assert.notEqual(L.nvNormState(NV_STATE).hdr, NV_STATE.hdr, '返回新对象');
  for (const bad of [null, undefined, 'x', {}, { hdr: {} }, { vsr: {} }, { hdr: [], vsr: {} }]) assert.equal(L.nvNormState(bad), null);
  const s = L.nvNormState({ hdr: { supported: 1, enabled: 'yes', error: -3, peak: 1.5, peakMax: 'x' }, vsr: {}, flags: 0x100 });
  assert.equal(s.hdr.supported, false, '只认 true');
  assert.equal(s.hdr.enabled, false);
  assert.equal(s.hdr.error, 0);
  assert.equal(s.hdr.peakMin, 400);
  assert.equal(s.hdr.peak, 400);
  assert.equal(s.hdr.peakMax, 400);
  assert.equal(s.vsr.mode, 0);
  assert.equal(s.indicator, true, '没有 indicator 时由 flags & 0x101 推出');
  assert.equal(s.vsr.priority, null, '没有 0x32F：priority 为 null');
  // 驱动没有 0x330：本地组件回 indicator / flags 为 null
  const old = L.nvNormState({ hdr: {}, vsr: { priority: null }, indicator: null, flags: null });
  assert.equal(old.indicator, null);
  assert.equal(old.flags, null);
  assert.equal(old.vsr.priority, null);
  assert.equal(L.nvNormState({ hdr: {}, vsr: {}, flags: -1 }).flags, null);
  assert.equal(L.nvNormState({ hdr: {}, vsr: {}, flags: 0x4 }).indicator, false);
  assert.equal(L.nvNormState({ hdr: {}, vsr: {}, flags: 0x1, indicator: false }).indicator, false, 'indicator 优先');
  assert.equal(L.nvNormState({ hdr: { error: 2 }, vsr: {} }).hdr.error, 2);
});

test('nvValidatePatch: 合法的补丁', () => {
  const full = { hdr: { enabled: true, peak: 1970, middleGrey: 10, contrast: -100, saturation: 100 }, vsr: { mode: 0, priority: 2 }, indicator: true, commit: true };
  assert.deepEqual(L.nvValidatePatch(full, NV_STATE), { ok: true, patch: full });
  assert.deepEqual(L.nvValidatePatch({}, NV_STATE), { ok: true, patch: {} });
  assert.deepEqual(L.nvValidatePatch({ hdr: { peak: 400 } }, NV_STATE), { ok: true, patch: { hdr: { peak: 400 } } });
  // 未知字段丢掉，空的 hdr/vsr 不写
  assert.deepEqual(L.nvValidatePatch({ cmd: 'x', hdr: { foo: 1 }, vsr: {}, extra: 1, commit: false }, NV_STATE), { ok: true, patch: { commit: false } });
  // 不给 state：最高亮度只按 400..10000 检查
  assert.equal(L.nvValidatePatch({ hdr: { peak: 5000 } }).ok, true);
  assert.equal(L.nvValidatePatch({ hdr: { peak: 5000 } }, null).ok, true);
  for (const mode of [0, 1, 2, 3, 4, 5]) assert.equal(L.nvValidatePatch({ vsr: { mode: mode } }, NV_STATE).ok, true, 'mode ' + mode);
});

test('nvValidatePatch: 每个字段的范围检查（任何一个不合法整个作废）', () => {
  const cases = [
    [{ hdr: { peak: 399 } }, 'hdr.peak'],
    [{ hdr: { peak: 1971 } }, 'hdr.peak'],
    [{ hdr: { peak: 1000.5 } }, 'hdr.peak'],
    [{ hdr: { peak: '1000' } }, 'hdr.peak'],
    [{ hdr: { middleGrey: 9 } }, 'hdr.middleGrey'],
    [{ hdr: { middleGrey: 101 } }, 'hdr.middleGrey'],
    [{ hdr: { contrast: -101 } }, 'hdr.contrast'],
    [{ hdr: { contrast: 101 } }, 'hdr.contrast'],
    [{ hdr: { saturation: -101 } }, 'hdr.saturation'],
    [{ hdr: { saturation: NaN } }, 'hdr.saturation'],
    [{ hdr: { saturation: null } }, 'hdr.saturation'],
    [{ hdr: { enabled: 1 } }, 'hdr.enabled'],
    [{ vsr: { mode: -1 } }, 'vsr.mode'],
    [{ vsr: { mode: 6 } }, 'vsr.mode'],
    [{ vsr: { priority: 3 } }, 'vsr.priority'],
    [{ vsr: { priority: 1.5 } }, 'vsr.priority'],
    [{ indicator: 'yes' }, 'indicator'],
    [{ commit: 1 }, 'commit'],
    // 前面合法、后面一个不合法：整个作废
    [{ hdr: { peak: 1000, middleGrey: 50 }, vsr: { mode: 5, priority: 9 }, commit: true }, 'vsr.priority']
  ];
  for (const [patch, field] of cases) {
    const r = L.nvValidatePatch(patch, NV_STATE);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.error.code, 'range', JSON.stringify(patch));
    assert.equal(r.error.field, field, JSON.stringify(patch));
    assert.ok(!('patch' in r));
  }
  // 最高亮度按实时范围给出 min/max
  assert.deepEqual(L.nvValidatePatch({ hdr: { peak: 2000 } }, NV_STATE).error, { code: 'range', field: 'hdr.peak', min: 400, max: 1970 });
  assert.equal(L.nvValidatePatch({ hdr: { peak: 10001 } }).error.field, 'hdr.peak');
  // 结构不对
  for (const bad of [null, 5, 'x', []]) assert.equal(L.nvValidatePatch(bad, NV_STATE).error.code, 'bad-request');
  assert.deepEqual(L.nvValidatePatch({ hdr: 5 }, NV_STATE).error, { code: 'range', field: 'hdr' }, '与本地组件一致');
  assert.deepEqual(L.nvValidatePatch({ vsr: [] }, NV_STATE).error, { code: 'range', field: 'vsr' });
});

test('nvValidatePatch: 不支持 / HDR 出错时拒绝对应部分', () => {
  const hdrErr = nvState({ hdr: { error: 2 } });
  assert.deepEqual(L.nvValidatePatch({ hdr: { middleGrey: 50 } }, hdrErr).error, { code: 'hdr-error', errorCode: 2 });
  assert.deepEqual(L.nvValidatePatch({ hdr: { enabled: false } }, hdrErr).error, { code: 'hdr-error', errorCode: 2 });
  assert.equal(L.nvValidatePatch({ vsr: { mode: 1 }, indicator: true }, hdrErr).ok, true, 'HDR 出错不影响超分');
  const noHdr = nvState({ hdr: { supported: false } });
  assert.deepEqual(L.nvValidatePatch({ hdr: { contrast: 0 } }, noHdr).error, { code: 'unsupported', field: 'hdr' });
  const noVsr = nvState({ vsr: { supported: false } });
  assert.deepEqual(L.nvValidatePatch({ vsr: { priority: 0 } }, noVsr).error, { code: 'unsupported', field: 'vsr' });
  assert.equal(L.nvValidatePatch({ hdr: { contrast: 0 } }, noVsr).ok, true);
  // 驱动没有 GPU 优先级 / 视频标志位
  const oldDrv = Object.assign(nvState({ vsr: { priority: null } }), { indicator: null, flags: null });
  assert.deepEqual(L.nvValidatePatch({ vsr: { mode: 5, priority: 1 } }, oldDrv).error, { code: 'unsupported', field: 'vsr.priority' });
  assert.deepEqual(L.nvValidatePatch({ indicator: true }, oldDrv).error, { code: 'unsupported', field: 'indicator' });
  assert.equal(L.nvValidatePatch({ vsr: { mode: 5 }, hdr: { peak: 500 } }, oldDrv).ok, true);
  // 范围错误优先于不支持
  assert.equal(L.nvValidatePatch({ hdr: { contrast: 999 } }, noHdr).error.code, 'range');
});

test('nvMergePatch / nvApplyPatch', () => {
  assert.equal(L.nvMergePatch(null, undefined), null);
  assert.deepEqual(L.nvMergePatch(null, { hdr: { peak: 500 } }), { hdr: { peak: 500 } });
  const a = { hdr: { peak: 500, contrast: 1 }, commit: true };
  const b = { hdr: { peak: 600 }, vsr: { mode: 1 }, commit: false, indicator: true };
  const m = L.nvMergePatch(a, b);
  assert.deepEqual(m, { hdr: { peak: 600, contrast: 1 }, vsr: { mode: 1 }, commit: true, indicator: true });
  assert.deepEqual(a, { hdr: { peak: 500, contrast: 1 }, commit: true }, '不修改输入');
  assert.equal(L.nvMergePatch({ commit: false }, { hdr: { peak: 1 } }).commit, false);
  assert.ok(!('commit' in L.nvMergePatch({ hdr: { peak: 1 } }, { hdr: { peak: 2 } })));

  const s = L.nvApplyPatch(NV_STATE, { hdr: { enabled: false, peak: 1500, saturation: -20, bogus: 1 }, vsr: { mode: 3 }, indicator: true });
  assert.equal(s.hdr.enabled, false);
  assert.equal(s.hdr.peak, 1500);
  assert.equal(s.hdr.saturation, -20);
  assert.equal(s.hdr.middleGrey, 65);
  assert.equal(s.vsr.mode, 3);
  assert.equal(s.vsr.priority, 2);
  assert.equal(s.indicator, true);
  assert.equal(s.flags, 0x101);
  assert.equal(NV_STATE.hdr.peak, 1000, '不修改输入');
  const off = L.nvApplyPatch(Object.assign({}, NV_STATE, { flags: 0x405, indicator: true }), { indicator: false });
  assert.equal(off.flags, 0x404, '只清 0x1|0x100，保留其他位');
  assert.equal(L.nvApplyPatch(null, {}), null);
  const noFlags = L.nvApplyPatch(Object.assign({}, NV_STATE, { indicator: null, flags: null }), { indicator: true });
  assert.equal(noFlags.indicator, null, '没有 0x330 时不乐观更新');
  assert.equal(noFlags.flags, null);
  assert.deepEqual(L.nvApplyPatch(NV_STATE, null), NV_STATE);
});

test('nvPresetFromState', () => {
  const p = L.nvPresetFromState(NV_STATE, '  白天 ', 'p1');
  assert.deepEqual(p, { id: 'p1', name: '白天', hdr: { enabled: true, peak: 1000, middleGrey: 65, contrast: 25, saturation: 0 }, vsr: { mode: 5, priority: 2 } });
  assert.ok(!('vsr' in L.nvPresetFromState(nvState({ vsr: { supported: false } }), 'x', 'p2')), '不支持超分时不带 vsr');
  assert.deepEqual(L.nvPresetFromState(nvState({ vsr: { priority: null } }), 'x', 'p3').vsr, { mode: 5 }, '没有 GPU 优先级时只存 mode');
  assert.equal(L.nvPresetFromState(NV_STATE, '   ', 'p1'), null);
  assert.equal(L.nvPresetFromState(NV_STATE, 'x', 'bad id'), null);
  assert.equal(L.nvPresetFromState(null, 'x', 'p1'), null);
  // 存进设置后原样保留
  assert.deepEqual(L.mergeSettings({ nv: { presets: [p] } }).nv.presets[0], p);
});

test('nvPresetPatch: 套用时按实时范围夹最高亮度、跳过不可用的部分', () => {
  const p = preset('a', 'x', { hdr: { enabled: false, peak: 5000, middleGrey: 40, contrast: -10, saturation: 15 }, vsr: { mode: 2, priority: 0 } });
  assert.deepEqual(L.nvPresetPatch(p, NV_STATE), {
    hdr: { enabled: false, peak: 1970, middleGrey: 40, contrast: -10, saturation: 15 },
    vsr: { mode: 2, priority: 0 },
    commit: true
  });
  assert.equal(L.nvPresetPatch(preset('a', 'x', { hdr: { peak: 400, middleGrey: 50, contrast: 0, saturation: 0 } }), nvState({ hdr: { peakMin: 500 } })).hdr.peak, 500);
  assert.ok(!('enabled' in L.nvPresetPatch(preset('a', 'x'), NV_STATE).hdr), '预设没存开关时不动开关');
  // HDR 出错：只写超分
  assert.deepEqual(L.nvPresetPatch(p, nvState({ hdr: { error: 1 } })), { vsr: { mode: 2, priority: 0 }, commit: true });
  assert.deepEqual(L.nvPresetPatch(p, nvState({ vsr: { supported: false } })).vsr, undefined);
  // 驱动没有 GPU 优先级：不发 priority（否则整个请求会被本地组件拒绝）
  assert.deepEqual(L.nvPresetPatch(p, nvState({ vsr: { priority: null } })).vsr, { mode: 2 });
  assert.deepEqual(L.nvPresetPatch(preset('a', 'x', { vsr: { mode: 1 } }), NV_STATE).vsr, { mode: 1 });
  // 什么都写不了
  assert.equal(L.nvPresetPatch(preset('a', 'x'), nvState({ hdr: { supported: false } })), null);
  assert.equal(L.nvPresetPatch(null, NV_STATE), null);
  assert.equal(L.nvPresetPatch(p, null), null);
  // 结果一定能通过校验
  for (const st of [NV_STATE, nvState({ hdr: { peakMax: 600 } }), nvState({ hdr: { error: 3 } }), nvState({ vsr: { priority: null } })]) {
    assert.equal(L.nvValidatePatch(L.nvPresetPatch(p, st), st).ok, true);
  }
});

test('nvSchedulePhase: 与夜间护眼开关无关', () => {
  const n = { enabled: false, start: '23:00', end: '07:00' };
  const at = (h, m) => L.nvSchedulePhase(n, h * 60 + m);
  assert.equal(at(22, 59), 'day');
  assert.equal(at(23, 0), 'night');
  assert.equal(at(3, 0), 'night');
  assert.equal(at(6, 59), 'night');
  assert.equal(at(7, 0), 'day');
  assert.equal(L.nvSchedulePhase({ enabled: true, start: '13:00', end: '14:00' }, 13 * 60 + 30), 'night');
  assert.equal(L.nvSchedulePhase({ start: '13:00', end: '14:00' }, 14 * 60), 'day');
  assert.equal(L.nvSchedulePhase({ start: '10:00', end: '10:00' }, 10 * 60), 'day', '空时段');
  assert.equal(L.nvSchedulePhase(null, 0), 'day');
  assert.equal(L.nvSchedulePhase(L.mergeSettings(null).night, new Date(2026, 0, 1, 23, 30)), 'night', '也接受 Date');
  assert.equal(L.nvSchedulePhase(L.mergeSettings(null).night, new Date(2026, 0, 1, 12, 0)), 'day');
});

test('nvNextPresetId / nvDefaultPresetName', () => {
  const ps = [preset('a', '预设 1'), preset('b', '预设 3'), preset('c', 'x')];
  assert.equal(L.nvNextPresetId(ps, 'a'), 'b');
  assert.equal(L.nvNextPresetId(ps, 'b'), 'c');
  assert.equal(L.nvNextPresetId(ps, 'c'), 'a', '循环');
  assert.equal(L.nvNextPresetId(ps, null), 'a');
  assert.equal(L.nvNextPresetId(ps, 'gone'), 'a');
  assert.equal(L.nvNextPresetId([preset('a', 'x')], 'a'), 'a');
  assert.equal(L.nvNextPresetId([], 'a'), null);
  assert.equal(L.nvNextPresetId(null, 'a'), null);
  assert.equal(L.nvDefaultPresetName(ps), '预设 2');
  assert.equal(L.nvDefaultPresetName([]), '预设 1');
  assert.equal(L.nvDefaultPresetName(null), '预设 1');
});

test('NV 错误文案', () => {
  assert.equal(L.nvHdrErrorText(1), '未检测到活动的 HDR10 显示器。');
  assert.equal(L.nvHdrErrorText(2), 'Windows 显示设置中未开启 HDR。');
  assert.equal(L.nvHdrErrorText(3), '禁用 Surround 以使用 HDR');
  assert.equal(L.nvHdrErrorText(0), '');
  assert.equal(L.nvHdrErrorText(9), 'HDR 不可用（错误 9）');
  assert.deepEqual(L.nvPortError('Specified native messaging host not found.'),
    { ok: false, error: { code: 'host-missing', message: 'Specified native messaging host not found.' } });
  assert.equal(L.nvPortError('Access to the specified native messaging host is forbidden.').error.code, 'host-forbidden');
  assert.equal(L.nvPortError('Native host has exited.').error.code, 'host-exit');
  assert.deepEqual(L.nvPortError(undefined), { ok: false, error: { code: 'host-exit' } });
  assert.equal(L.nvPortError('Error when communicating with the native messaging host.').error.code, 'host-error');
  assert.equal(L.nvErrorText({ code: 'host-missing' }), '未安装本地组件，无法读写 NVIDIA 设置。');
  assert.equal(L.nvErrorText('host-missing'), '未安装本地组件，无法读写 NVIDIA 设置。');
  assert.equal(L.nvErrorText({ code: 'hdr-error', errorCode: 2 }), 'Windows 显示设置中未开启 HDR。');
  assert.equal(L.nvErrorText({ code: 'api', rc: -5, id: '0x318' }), 'NVIDIA 接口调用失败（rc=-5）。');
  assert.equal(L.nvErrorText({ code: 'range', field: 'hdr.peak' }), '数值超出范围（最高亮度）。');
  assert.equal(L.nvErrorText({ code: 'unsupported', field: 'vsr' }), '此显卡或驱动不支持 RTX 视频超分辨率。');
  assert.equal(L.nvErrorText({ code: 'unsupported', field: 'vsr.priority' }), '此驱动不支持 GPU 优先级设置。');
  assert.equal(L.nvErrorText({ code: 'unsupported', field: 'indicator' }), '此驱动不支持状态指示器设置。');
  assert.equal(L.nvErrorText({ code: 'internal', message: 'NullReferenceException' }), '本地组件内部错误。');
  assert.equal(L.nvErrorText({ code: 'weird' }), '未知错误（weird）。');
  assert.equal(L.nvErrorText(null), '未知错误。');
  for (const c of ['host-missing', 'host-forbidden', 'host-exit', 'host-error', 'timeout', 'protocol', 'no-dll', 'init', 'api', 'range', 'unsupported', 'hdr-error', 'bad-request', 'internal']) {
    assert.ok(!/未知错误/.test(L.nvErrorText({ code: c })), c);
  }
});

// ---------- 界面文字 ----------

test('i18n：中英文键一致、没有空值、占位符一致', () => {
  const I = require('../i18n.js');
  const zh = Object.keys(I.DICT.zh).sort();
  const en = Object.keys(I.DICT.en).sort();
  assert.deepEqual(en, zh);
  for (const lang of ['zh', 'en']) {
    for (const [k, v] of Object.entries(I.DICT[lang])) assert.ok(typeof v === 'string' && v.length > 0, lang + ' ' + k);
  }
  const ph = (v) => Array.from(v.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort().join(',');
  for (const k of zh) assert.equal(ph(I.DICT.en[k]), ph(I.DICT.zh[k]), '占位符 ' + k);
  assert.equal(I.resolve('auto', 'zh-CN'), 'zh');
  assert.equal(I.resolve('auto', 'zh-TW'), 'zh');
  assert.equal(I.resolve('auto', 'en-US'), 'en');
  assert.equal(I.resolve('auto', ''), 'en');
  assert.equal(I.resolve('en', 'zh-CN'), 'en');
  assert.equal(I.t('en', 'nv.saved', { name: 'A' }), 'Saved preset: A');
  assert.equal(I.t('en', 'no.such.key'), 'no.such.key');
  assert.equal(I.t('xx', 'tab.video'), '视频'); // 不认识的语言用中文
});

test('i18n：弹窗、选项页、内容脚本、background 用到的键都存在', () => {
  const I = require('../i18n.js');
  const keys = new Set(Object.keys(I.DICT.zh));
  for (const f of ['popup.html', 'options.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) assert.ok(keys.has(m[1]), f + ' ' + m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) assert.ok(keys.has(pair.split(':')[1]), f + ' ' + pair);
    }
  }
  for (const f of ['popup.js', 'options.js', 'content.js', 'background.js']) {
    const js = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // t('key') / L.t(lang, 'key')
    for (const m of js.matchAll(/\bt\((?:lang, |lg, )?'([a-z][\w.-]*)'\s*[,)]/g)) assert.ok(keys.has(m[1]), f + ' ' + m[1]);
  }
});

test('文案：英文', () => {
  assert.equal(L.reasonText('manual', 'en'), 'manual');
  assert.equal(L.osdText('off', 'auto', 'en'), 'RTX HDR: off (auto · white)');
  assert.equal(L.osdText('on', 'nothing', 'en'), 'RTX HDR: on');
  assert.equal(L.autoModeText('both', 'en'), 'Turn off and on');
  assert.equal(L.formatLuma(0.5, 0.25, 'en'), 'Brightness 50% · white 25%');
  assert.equal(L.eyeReminderText(30, false, '', 'en'), "You've watched HDR for 30 min — time to rest your eyes");
  assert.equal(L.nvErrorText({ code: 'range', field: 'hdr.peak' }, 'en'), 'Value out of range (peak brightness).');
  assert.equal(L.nvErrorText({ code: 'weird' }, 'en'), 'Unknown error (weird).');
  assert.equal(L.nvHdrErrorText(2, 'en'), 'HDR is off in Windows display settings.');
  assert.equal(L.nvDefaultPresetName([{ name: 'Preset 1' }], 'en'), 'Preset 2');
  assert.equal(L.nvDefaultPresetName([{ name: 'Preset 1' }]), '预设 1');
});

// ---------- 主题色 ----------

test('主题色：规范化与文字色', () => {
  assert.equal(L.normAccent('#a98bff'), '#A98BFF');
  assert.equal(L.normAccent('abc'), '#AABBCC');
  assert.equal(L.normAccent('#12345'), L.DEFAULT_ACCENT);
  assert.equal(L.normAccent(null), L.DEFAULT_ACCENT);
  assert.equal(L.DEFAULT_ACCENT, '#A98BFF');
  assert.ok(L.ACCENTS.some((a) => a.hex === L.DEFAULT_ACCENT));
  // 预设色都够亮：上面放黑字，放在黑底上也看得清
  for (const a of L.ACCENTS) {
    const ink = L.accentInk(a.hex);
    assert.equal(ink.on, '#0A0A0A', a.id);
    assert.equal(ink.fg, a.hex, a.id);
  }
  const dark = L.accentInk('#2E5BFF');
  assert.equal(dark.on, '#FAFAFA');
  assert.equal(dark.fg, '#FAFAFA');
  assert.equal(L.accentInk('#FFFFFF').on, '#0A0A0A');
  assert.equal(L.accentInk('#000000').on, '#FAFAFA');
});

test('mergeSettings：界面语言、主题色、只关 HDR、控制栏按钮、跟随 SDR', () => {
  const d = L.mergeSettings(null);
  assert.deepEqual(d.ui, { lang: 'auto', accent: '#A98BFF' });
  assert.equal(d.hdrOnly, false);
  assert.equal(d.playerButton, true);
  const m = L.mergeSettings({ ui: { lang: 'en', accent: '#c8ff2e' }, hdrOnly: true, playerButton: false, nv: { followSdr: true, displayId: 'dev-1' } });
  assert.deepEqual(m.ui, { lang: 'en', accent: '#C8FF2E' });
  assert.equal(m.hdrOnly, true);
  assert.equal(m.playerButton, false);
  assert.equal(m.nv.followSdr, true);
  assert.equal(m.nv.displayId, 'dev-1');
  const bad = L.mergeSettings({ ui: { lang: 'fr', accent: 'red' }, hdrOnly: 'yes', playerButton: 1, nv: { followSdr: 'true', displayId: '' } });
  assert.deepEqual(bad.ui, { lang: 'auto', accent: '#A98BFF' });
  assert.equal(bad.hdrOnly, false);
  assert.equal(bad.playerButton, true);
  assert.equal(bad.nv.followSdr, false);
  assert.equal(bad.nv.displayId, null);
});

// ---------- SDR 亮度 → 建议值 ----------

test('nvSuggest：中间灰 = SDR 白 × 0.2158，最高亮度 ≤ 1000，对比度 +25', () => {
  const st = { hdr: { supported: true, enabled: true, peak: 1400, peakMin: 400, peakMax: 1970, middleGrey: 65, contrast: 0, saturation: 0 }, vsr: { supported: true } };
  const disp = (nits, hdr) => ({ id: 'd', name: 'X', hdrEnabled: hdr !== false, hdrSupported: true, sdrWhiteNits: nits, sdrSlider: Math.round((nits - 80) / 4) });
  assert.deepEqual(L.nvSuggest(disp(276), st), { middleGrey: 60, peak: 1000, contrast: 25 });
  assert.deepEqual(L.nvSuggest(disp(480), st), { middleGrey: 100, peak: 1000, contrast: 25 }); // 480 × 0.2158 = 104 → 夹到 100
  assert.deepEqual(L.nvSuggest(disp(80), st), { middleGrey: 17, peak: 1000, contrast: 25 });
  // 显卡上限低于 1000 时取上限
  assert.equal(L.nvSuggest(disp(276), { hdr: { peak: 700, peakMin: 400, peakMax: 800 }, vsr: {} }).peak, 800);
  assert.equal(L.nvSuggest(disp(276, false), st), null, '显示器没开 HDR');
  assert.equal(L.nvSuggest({ id: 'd', hdrEnabled: true }, st), null, '读不到白电平');
  assert.equal(L.nvSuggest(null, st), null);
  assert.equal(L.K_MID, 0.2158);
});

test('nvNormDisplay / nvPickDisplay', () => {
  assert.equal(L.nvNormDisplay({ name: 'x' }), null);
  const d = L.nvNormDisplay({ id: 'a', name: 'Mon', hdrEnabled: true, sdrWhiteNits: 276 });
  assert.equal(d.sdrSlider, 49);
  assert.equal(L.nvNormDisplay({ id: 'a', sdrWhiteNits: 999, sdrSlider: 150 }).sdrSlider, 100);
  const list = [{ id: 'a', hdrEnabled: false, sdrWhiteNits: 200 }, { id: 'b', hdrEnabled: true, sdrWhiteNits: 300 }, { bad: 1 }];
  assert.equal(L.nvPickDisplay(list, 'a').id, 'a');
  assert.equal(L.nvPickDisplay(list, 'zz').id, 'b', '记住的不在了：第一个开着 HDR 的');
  assert.equal(L.nvPickDisplay([{ id: 'c' }], null).id, 'c');
  assert.equal(L.nvPickDisplay([], null), null);
  assert.equal(L.nvPickDisplay(null, null), null);
});

test('nvMgStep：±5 夹到 10..100', () => {
  const st = (mg) => ({ hdr: { middleGrey: mg, peak: 1000, peakMin: 400, peakMax: 1970 }, vsr: {} });
  assert.deepEqual(L.nvMgStep(st(65), 5), { value: 70, changed: true });
  assert.deepEqual(L.nvMgStep(st(98), 5), { value: 100, changed: true });
  assert.deepEqual(L.nvMgStep(st(100), 5), { value: 100, changed: false });
  assert.deepEqual(L.nvMgStep(st(12), -5), { value: 10, changed: true });
  assert.equal(L.nvMgStep(null, 5), null);
});

// ---------- 备份 ----------

test('备份：导出只带设置和视频记忆，导入前检查', () => {
  const all = {
    settings: { defaultState: 'off', ui: { accent: '#ff5ca8' }, sites: { 'Example.com': 'off' },
      nv: { presets: [{ id: 'p1', name: '电影', hdr: { peak: 1000, middleGrey: 60, contrast: 25, saturation: 0 } }] } },
    'v:yt:abc': { s: 'off', t: 5 },
    'v:bad': { s: 'maybe' },
    eyeRest: { on: true, at: 1 },
    nvLastPhase: { phase: 'day' }
  };
  const b = L.makeBackup(all, '1.2.0', Date.UTC(2026, 9, 21, 12, 0));
  assert.equal(b.format, L.BACKUP_FORMAT);
  assert.equal(b.version, 1);
  assert.equal(b.exportedAt, '2026-10-21T12:00:00.000Z');
  assert.equal(b.extensionVersion, '1.2.0');
  assert.deepEqual(Object.keys(b.videos), ['yt:abc']);
  assert.equal(b.settings.ui.accent, '#FF5CA8');
  assert.ok(!('eyeRest' in b) && !('nvLastPhase' in b));

  const back = L.validateBackup(JSON.parse(JSON.stringify(b)));
  assert.equal(back.ok, true);
  assert.deepEqual(back.summary, { videos: 1, presets: 1, sites: 1 });
  assert.deepEqual(back.settings, b.settings);
  assert.deepEqual(back.videos, { 'yt:abc': { s: 'off', t: 5 } });

  assert.deepEqual(L.validateBackup(null), { ok: false, code: 'invalid' });
  assert.deepEqual(L.validateBackup({ format: 'other', version: 1, settings: {} }), { ok: false, code: 'invalid' });
  assert.deepEqual(L.validateBackup({ format: L.BACKUP_FORMAT, version: 2, settings: {} }), { ok: false, code: 'newer' });
  assert.deepEqual(L.validateBackup({ format: L.BACKUP_FORMAT, version: 1 }), { ok: false, code: 'invalid' });
  // 设置里的非法值按 mergeSettings 规范化，视频记忆里的坏条目丢掉
  const odd = L.validateBackup({ format: L.BACKUP_FORMAT, version: 1, settings: { ui: { lang: 'xx' } }, videos: { a: { s: 'on', t: 1 }, b: 'x' } });
  assert.equal(odd.ok, true);
  assert.equal(odd.settings.ui.lang, 'auto');
  assert.deepEqual(Object.keys(odd.videos), ['a']);
});

test('备份：视频记忆超过上限时只留最新的', () => {
  const videos = {};
  for (let i = 0; i < L.MAX_VIDEO_ENTRIES + 5; i++) videos['k' + i] = { s: 'on', t: i };
  const r = L.validateBackup({ format: L.BACKUP_FORMAT, version: 1, settings: {}, videos: videos });
  assert.equal(r.summary.videos, L.MAX_VIDEO_ENTRIES);
  assert.ok(!('k0' in r.videos) && ('k' + (L.MAX_VIDEO_ENTRIES + 4)) in r.videos);
});

test('options.js 用到的元素 id 在 options.html 里都有', () => {
  const html = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(m[1]), '缺少 #' + m[1]);
});

// ---------- 弹窗 ----------

test('popup.js 用到的元素 id 在 popup.html 里都有', () => {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const used = new Set(Array.from(js.matchAll(/\$\('([^']+)'\)/g), (m) => m[1]));
  // 拼出来的 id：滑块和它们的读数
  for (const f of ['peak', 'middleGrey', 'contrast', 'saturation']) used.add('nv-' + f);
  for (const f of ['middleGrey', 'contrast', 'saturation']) used.add('nv-' + f + '-out');
  for (const id of used) assert.ok(ids.has(id), '缺少 #' + id);
  // 每个表单控件都有可访问的名称
  for (const m of html.matchAll(/<(input|select)\b([^>]*)>/g)) {
    const attrs = m[2];
    const id = (/\bid="([^"]+)"/.exec(attrs) || [])[1];
    const labelled = /aria-label(ledby)?=/.test(attrs) || (id && html.includes('for="' + id + '"'));
    const wrapped = /type="(radio|checkbox)"/.test(attrs); // 包在 <label> 里
    assert.ok(labelled || wrapped, '控件没有标签：' + m[0]);
  }
  assert.ok(html.includes('https://github.com/miniso7892-dotcom/rtx-hdr-switch#nvidia-settings-panel'));
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
  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.default_locale, 'en');
  assert.ok(manifest.name.length <= 75, 'name 不超过 75 字符');
  assert.equal(new URL(manifest.homepage_url).protocol, 'https:', 'homepage_url 是合法的 https 网址');
  assert.equal(manifest.version, '1.2.0');
  assert.equal(manifest.minimum_chrome_version, '120'); // chrome.alarms 30 秒周期
  assert.deepEqual(manifest.permissions.slice().sort(), ['alarms', 'nativeMessaging', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  // 名称、说明、快捷键说明都走 _locales：每种语言都有全部的 __MSG_x__
  const used = new Set(Array.from(JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g), (m) => m[1]));
  for (const loc of ['en', 'zh_CN']) {
    const msgs = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8'));
    for (const k of used) assert.ok(msgs[k] && msgs[k].message, loc + ' 缺少 ' + k);
    assert.ok(msgs.extName.message.length <= 75, loc + ' 名称不超过 75 字符');
    assert.ok(msgs.extDescription.message.length <= 132, loc + ' 说明不超过 132 字符');
  }

  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.js, ['i18n.js', 'lib.js', 'content.js']);
  assert.equal(cs.all_frames, true);
  assert.equal(cs.match_about_blank, true);
  assert.equal(cs.match_origin_as_fallback, true);
  assert.equal(cs.run_at, 'document_start');
  assert.equal(manifest.commands['toggle-hdr'].suggested_key.default, 'Alt+H');
  assert.equal(manifest.commands['toggle-auto'].suggested_key.default, 'Alt+Shift+H');
  assert.equal(manifest.commands['nv-mg-up'].suggested_key.default, 'Alt+Shift+Up');
  assert.equal(manifest.commands['nv-mg-down'].suggested_key.default, 'Alt+Shift+Down');
  assert.ok(!manifest.commands['forget-video'].suggested_key);
  assert.ok(!manifest.commands['nv-next-preset'].suggested_key, '下一个 NVIDIA 预设：不预设快捷键');
  // Chrome 最多接受 4 个预设快捷键
  assert.ok(Object.values(manifest.commands).filter((c) => c.suggested_key).length <= 4);
  assert.equal(manifest.options_ui.page, 'options.html');

  const files = new Set([manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page]);
  for (const c of manifest.content_scripts) for (const f of c.js || []) files.add(f);
  for (const f of Object.values(manifest.icons)) files.add(f);
  for (const f of Object.values(manifest.action.default_icon)) files.add(f);
  // popup.html / options.html 里引用的脚本和样式，service worker 里 importScripts 的脚本
  for (const page of [manifest.action.default_popup, manifest.options_ui.page]) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (!/^[a-z][a-z0-9+.-]*:/i.test(m[1])) files.add(m[1]); // 跳过外部链接
  }
  const sw = fs.readFileSync(path.join(ROOT, manifest.background.service_worker), 'utf8');
  for (const m of sw.matchAll(/importScripts\(([^)]*)\)/g)) for (const f of m[1].matchAll(/'([^']+)'/g)) files.add(f[1]);
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
