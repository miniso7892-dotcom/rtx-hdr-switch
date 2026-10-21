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

test('playerSite 认得的每个网站在 content.js 的 PLAYER_BARS 里都有选择器', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const m = /const PLAYER_BARS = Object\.freeze\(\{([\s\S]*?)\n {2}\}\);/.exec(src);
  assert.ok(m, '找到 PLAYER_BARS');
  const keys = Array.from(m[1].matchAll(/^ {4}(\w+): \{/gm), (x) => x[1]).sort();
  const sites = new Set([['www.bilibili.com', '/video/x'], ['player.bilibili.com', '/player.html'], ['www.youtube.com', '/watch'],
    ['www.twitch.tv', '/x'], ['v.qq.com', '/x/cover/a/b.html']].map(([h, p]) => L.playerSite(h, p)));
  assert.deepEqual(keys, Array.from(sites).sort());
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
  assert.equal(L.osdText('off', 'auto'), 'RTX HDR：关（检测到白底）');
  assert.equal(L.formatLuma(0.72, 0.41), '画面亮度 72%，白色占比 41%');
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
  assert.deepEqual(m.nv, { presets: [], nightPresetId: null, dayPresetId: null, followSdr: false, displayId: null, sitePresets: {} });
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
  assert.equal(L.osdText('off', 'auto', 'en'), 'RTX HDR: off (white video detected)');
  assert.equal(L.osdText('on', 'nothing', 'en'), 'RTX HDR: on');
  assert.equal(L.autoModeText('both', 'en'), 'Turn off and on');
  assert.equal(L.formatLuma(0.5, 0.25, 'en'), 'Brightness 50%, white 25%');
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

test('hdrOnlyApplies：只对借开关时看的那个标签页和 frame 生效', () => {
  const st = { active: true, leased: true, tabId: 7, frameId: 0 };
  assert.equal(L.hdrOnlyApplies(st, 7, 0), true);
  assert.equal(L.hdrOnlyApplies(st, 8, 0), false, '另一个窗口的标签页照常加滤镜');
  assert.equal(L.hdrOnlyApplies(st, 7, 3), false, '同一标签页里别的 frame');
  assert.equal(L.hdrOnlyApplies(st, -1, -1), false, '还不知道自己在哪：先按滤镜处理');
  assert.equal(L.hdrOnlyApplies({ active: false, leased: false }, 7, 0), false);
  assert.equal(L.hdrOnlyApplies({ active: true, leased: false }, 7, 0), false, '1.2 早期的状态没有 tabId');
  assert.equal(L.hdrOnlyApplies(null, 7, 0), false);
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
  assert.deepEqual(back.summary, { videos: 1, presets: 1, sites: 1, profiles: 0 });
  assert.equal(back.profiles, null, '没有配置档字段（1.2 的备份）：导入时保留现有的');
  assert.ok(!('profiles' in b), 'storage 里没有配置档时不写这个字段');
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
  assert.equal(manifest.version, '1.3.0');
  assert.equal(manifest.minimum_chrome_version, '120'); // chrome.alarms 30 秒周期
  // 1.3 去掉 tabs：tab.url 由 <all_urls> 主机权限覆盖，tabs.query / sendMessage / create 不需要它
  assert.deepEqual(manifest.permissions.slice().sort(), ['alarms', 'nativeMessaging', 'scripting', 'storage']);
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
  for (const c of ['peek', 'next-profile', 'nv-undo']) assert.ok(manifest.commands[c] && !manifest.commands[c].suggested_key, c + '：1.3 新命令，不预设快捷键');
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

// ======================== 1.3 ========================

// ---------- 设置：新字段 ----------

test('mergeSettings 1.3：新字段的默认值与非法值', () => {
  const d = L.mergeSettings(null);
  assert.equal(d.playerPanel, 'hover');
  assert.equal(d.fullscreenWeb, true);
  assert.equal(d.updateCheck, true);
  assert.deepEqual(d.nv.sitePresets, {});
  const m = L.mergeSettings({ playerPanel: 'right', fullscreenWeb: false, updateCheck: false, defaultState: 'fullscreen', sites: { 'a.com': 'fullscreen', 'b.com': 'off' } });
  assert.equal(m.playerPanel, 'right');
  assert.equal(m.fullscreenWeb, false);
  assert.equal(m.updateCheck, false);
  assert.equal(m.defaultState, 'fullscreen');
  assert.deepEqual(m.sites, { 'a.com': 'fullscreen', 'b.com': 'off' });
  assert.equal(L.mergeSettings({ playerPanel: 'off' }).playerPanel, 'off');
  const bad = L.mergeSettings({ playerPanel: 'Hover', fullscreenWeb: 'no', updateCheck: 0, defaultState: 'Fullscreen', sites: { 'a.com': 'FULLSCREEN' } });
  assert.equal(bad.playerPanel, 'hover');
  assert.equal(bad.fullscreenWeb, true);
  assert.equal(bad.updateCheck, true);
  assert.equal(bad.defaultState, 'on', '大小写不对回退成 on');
  assert.deepEqual(bad.sites, {});
  assert.equal(L.mergeSettings({ defaultState: 'whenever' }).defaultState, 'on');
  assert.deepEqual(L.mergeSettings(m), m, '幂等');
  assert.deepEqual(L.mergeSettings(undefined), JSON.parse(JSON.stringify(L.DEFAULT_SETTINGS)));
});

test('mergeSettings 1.3：nv.sitePresets 规范化、悬空引用、200 条上限', () => {
  const ps = [preset('a', 'x'), preset('b', 'y')];
  const m = L.mergeSettings({ nv: { presets: ps, sitePresets: { 'WWW.YouTube.com.': 'a', 'bilibili.com': 'b', 'gone.com': 'zzz', '': 'a', 'x.com': 5, 'y.com': null } } }).nv;
  assert.deepEqual(m.sitePresets, { 'youtube.com': 'a', 'bilibili.com': 'b' });
  // 预设删掉后，指向它的绑定一起去掉（同 nightPresetId）
  assert.deepEqual(L.mergeSettings({ nv: { presets: [ps[0]], sitePresets: m.sitePresets } }).nv.sitePresets, { 'youtube.com': 'a' });
  const many = {};
  for (let i = 0; i < 250; i++) many['s' + i + '.com'] = 'a';
  const capped = L.mergeSettings({ nv: { presets: ps, sitePresets: many } }).nv.sitePresets;
  assert.equal(Object.keys(capped).length, L.NV_SITE_PRESETS_MAX);
  assert.equal(capped['s0.com'], 'a');
  assert.ok(!('s200.com' in capped));
  assert.deepEqual(L.mergeSettings({ nv: { presets: ps, sitePresets: 'x' } }).nv.sitePresets, {});
  const once = L.mergeSettings({ nv: { presets: ps, sitePresets: m.sitePresets } });
  assert.deepEqual(L.mergeSettings(once), once, '幂等');
});

// ---------- 设置补丁 ----------

test('applySettingsPatch：递归合并、null 删除网站键、数组整体替换、不修改输入', () => {
  const cur = S({ osd: true, sites: { 'a.com': 'on', 'b.com': 'off' }, night: { enabled: true, start: '22:00', end: '06:00' },
    nv: { presets: [preset('p1', 'x'), preset('p2', 'y')], sitePresets: { 'a.com': 'p1' } } });
  const snap = JSON.stringify(cur);
  const patch = { osd: false, night: { start: '21:30' }, sites: { 'WWW.A.com': null, 'c.com': 'fullscreen' }, nv: { sitePresets: { 'b.com': 'p2' } } };
  const psnap = JSON.stringify(patch);
  const out = L.applySettingsPatch(cur, patch);
  assert.equal(out.osd, false);
  assert.deepEqual(out.night, { enabled: true, start: '21:30', end: '06:00' });
  assert.deepEqual(out.sites, { 'b.com': 'off', 'c.com': 'fullscreen' });
  assert.deepEqual(out.nv.sitePresets, { 'a.com': 'p1', 'b.com': 'p2' });
  assert.equal(out.nv.presets.length, 2, '没提到的数组保留');
  assert.equal(JSON.stringify(cur), snap, '不修改输入');
  assert.equal(JSON.stringify(patch), psnap, '不修改补丁');
  // 数组整体替换；删掉预设后指向它的绑定一起清掉
  const r = L.applySettingsPatch(cur, { nv: { presets: [preset('p2', 'y')] } });
  assert.deepEqual(r.nv.presets.map((p) => p.id), ['p2']);
  assert.deepEqual(r.nv.sitePresets, {});
  // 结果总是过 mergeSettings
  assert.equal(L.applySettingsPatch(cur, { defaultState: 'bogus' }).defaultState, 'on');
  assert.ok(!('junk' in L.applySettingsPatch(cur, { junk: 1 })));
  assert.deepEqual(L.applySettingsPatch(cur, null), cur);
  assert.deepEqual(L.applySettingsPatch(undefined, {}), L.mergeSettings(null));
  assert.equal(L.applySettingsPatch(cur, 'x'), null);
  assert.equal(L.applySettingsPatch(cur, []), null);
  // __proto__ 不会污染原型
  const evil = L.applySettingsPatch(cur, JSON.parse('{"__proto__": {"polluted": 1}, "sites": {"__proto__": "on"}}'));
  assert.equal(({}).polluted, undefined);
  assert.equal(evil.polluted, undefined);
  assert.deepEqual(evil.sites, cur.sites);
});

test('settingsPatchFor：最小补丁，与 applySettingsPatch 往返一致', () => {
  const a = S({ sites: { 'a.com': 'on', 'b.com': 'off' }, nv: { presets: [preset('p1', 'x')], sitePresets: { 'a.com': 'p1' } } });
  assert.equal(L.settingsPatchFor(a, a), null);
  assert.equal(L.settingsPatchFor(a, JSON.parse(JSON.stringify(a))), null);
  const b = JSON.parse(JSON.stringify(a));
  b.osd = false;
  b.night.end = '08:00';
  delete b.sites['a.com'];
  b.sites['c.com'] = 'fullscreen';
  b.nv.sitePresets = {};
  b.ui.accent = '#C8FF2E';
  const p = L.settingsPatchFor(a, b);
  assert.deepEqual(p, { osd: false, night: { end: '08:00' }, sites: { 'a.com': null, 'c.com': 'fullscreen' }, ui: { accent: '#C8FF2E' }, nv: { sitePresets: { 'a.com': null } } });
  assert.deepEqual(L.applySettingsPatch(a, p), L.mergeSettings(b));
  // 数组整体替换
  const c = JSON.parse(JSON.stringify(a));
  c.nv.presets.push(preset('p2', 'y'));
  assert.deepEqual(L.settingsPatchFor(a, c), { nv: { presets: c.nv.presets } });
  for (const next of [c, S({ defaultState: 'fullscreen' }), S({ eye: { minutes: 10 } }), S(), S({ sites: { 'x.com': 'off' } })]) {
    assert.deepEqual(L.applySettingsPatch(a, L.settingsPatchFor(a, next)), L.mergeSettings(next));
  }
});

test('contentPatchAllowed：只放行白名单字段和顶层网站自己的那一条', () => {
  const ok = (p, host) => L.contentPatchAllowed(p, host === undefined ? 'www.example.com' : host);
  const all = { autoDetect: 'both', sensitivity: 'high', playerButton: false, playerPanel: 'right', autoLastMode: 'both' };
  assert.deepEqual(ok(all), { ok: true, patch: all });
  assert.deepEqual(ok({ sites: { 'example.com': 'off' } }), { ok: true, patch: { sites: { 'example.com': 'off' } } });
  assert.deepEqual(ok({ sites: { 'WWW.Example.com': null } }), { ok: true, patch: { sites: { 'example.com': null } } });
  assert.equal(ok({ sites: { 'example.com': 'fullscreen' } }).ok, true);
  // 网站预设只有面板（第三个参数）能改，内容脚本改不了
  const panel = (p) => L.contentPatchAllowed(p, 'www.example.com', true);
  assert.deepEqual(panel({ nv: { sitePresets: { 'example.com': 'p1' } } }), { ok: true, patch: { nv: { sitePresets: { 'example.com': 'p1' } } } });
  assert.equal(panel({ nv: { sitePresets: { 'example.com': null } } }).ok, true);
  for (const bad of [{ nv: { sitePresets: { 'other.com': 'p1' } } }, { nv: { presets: [] } }, { hdrOnly: true }]) assert.equal(panel(bad).ok, false, JSON.stringify(bad));
  assert.deepEqual(ok({}), { ok: true, patch: {} });
  const forbidden = { ok: false, code: 'forbidden' };
  for (const bad of [
    null, 'x', [],
    { sites: { 'other.com': 'off' } }, // 别的网站
    { sites: { 'example.com': 'off', 'other.com': 'on' } },
    { sites: { 'example.com': 'maybe' } },
    { sites: 'off' },
    { nv: { presets: [] } }, // NVIDIA 预设本身
    { nv: { sitePresets: { 'example.com': 'p1' } } }, // 网站预设会让 background 写 NVIDIA：内容脚本不能改
    { nv: { sitePresets: { 'example.com': null } } },
    { nv: { sitePresets: { 'example.com': 'p1' }, followSdr: true } },
    { nv: { sitePresets: { 'other.com': 'p1' } } },
    { nv: { sitePresets: { 'example.com': 'bad id' } } },
    { hdrOnly: true }, { osd: false }, { defaultState: 'off' }, { ui: { lang: 'en' } }, { updateCheck: false }, // 白名单以外
    { autoDetect: 'sometimes' }, { playerButton: 'yes' }, { playerPanel: 'always' },
    { autoDetect: 'off', eye: { minutes: 1 } } // 混进一个越权字段：整单拒绝
  ]) assert.deepEqual(ok(bad), forbidden, JSON.stringify(bad));
  assert.deepEqual(ok({ sites: { 'example.com': 'off' } }, ''), forbidden, '不知道顶层网站时不能改网站规则');
  const input = { sites: { 'WWW.example.com': 'on' } };
  ok(input);
  assert.deepEqual(input, { sites: { 'WWW.example.com': 'on' } }, '不修改输入');
});

// ---------- NVIDIA 写入：借用、去重 ----------

test('nvUnleased / nvEffectiveState：借用期间用借用前的值', () => {
  const leased = nvState({ hdr: { enabled: false } });
  assert.equal(L.nvUnleased(leased, { held: true, prevEnabled: true }).hdr.enabled, true);
  assert.equal(L.nvEffectiveState(leased, { active: true, leased: true, prevEnabled: true }).hdr.enabled, true, 'hdrOnlyStatus 的写法');
  assert.ok(!('enabled' in L.nvUnleased(leased, { held: true }).hdr), '不知道借用前的值：去掉 enabled');
  assert.equal(L.nvUnleased(leased, { held: false, prevEnabled: true }).hdr.enabled, false, '没在借');
  assert.equal(L.nvUnleased(leased, null).hdr.enabled, false);
  assert.equal(L.nvUnleased(null, { held: true }), null);
  assert.equal(leased.hdr.enabled, false, '不修改输入');
  // 借用期间存的预设不会存成「关」；不知道借用前的值时不带开关
  assert.equal(L.nvPresetFromState(L.nvUnleased(leased, { held: true, prevEnabled: true }), 'x', 'p1').hdr.enabled, true);
  assert.ok(!('enabled' in L.nvPresetFromState(L.nvUnleased(leased, { held: true }), 'x', 'p1').hdr));
});

test('nvLeaseAdjust：借用与 suppress / yield 的 6 种组合', () => {
  const on = { hdr: { enabled: true, peak: 800 }, commit: true };
  const off = { hdr: { enabled: false }, commit: true };
  const lease = { held: true, prevEnabled: true };
  // 1. 没在借
  assert.deepEqual(L.nvLeaseAdjust(on, { held: false }, 'suppress'), { patch: on, action: 'none' });
  // 2. 补丁不带 enabled
  assert.deepEqual(L.nvLeaseAdjust({ hdr: { peak: 800 } }, lease, 'suppress'), { patch: { hdr: { peak: 800 } }, action: 'none' });
  // 3. 在借 + suppress（用户亲手拨开关）
  assert.deepEqual(L.nvLeaseAdjust(on, lease, 'suppress'), { patch: on, action: 'drop-suppress' });
  // 4. 在借 + yield + 与借用前相同：去掉 enabled，不闪烁
  assert.deepEqual(L.nvLeaseAdjust(on, lease, 'yield'), { patch: { hdr: { peak: 800 }, commit: true }, action: 'none' });
  assert.deepEqual(L.nvLeaseAdjust({ hdr: { enabled: true } }, lease, 'yield'), { patch: {}, action: 'none' }, 'hdr 空了就去掉');
  // 5. 在借 + yield + 不同
  assert.deepEqual(L.nvLeaseAdjust(off, lease, 'yield'), { patch: off, action: 'drop-yield' });
  // 6. 在借 + yield + 不知道借用前的值
  assert.equal(L.nvLeaseAdjust(on, { held: true }, 'yield').action, 'drop-yield');
  assert.equal(on.hdr.enabled, true, '不修改输入');
  assert.equal(L.nvLeaseAdjust(null, lease, 'yield'), null);
  assert.equal(L.nvLeaseAdjust(on, { leased: true, prevEnabled: true }, 'suppress').action, 'drop-suppress', 'hdrOnlyStatus 的写法');
});

test('nvAutoGuard / nvPatchDelta', () => {
  const follow = S({ nv: { followSdr: true } });
  const p = { hdr: { middleGrey: 50, peak: 900 }, commit: true };
  assert.deepEqual(L.nvAutoGuard(p, follow, 'schedule'), { hdr: { peak: 900 }, commit: true });
  assert.deepEqual(L.nvAutoGuard(p, follow, 'site'), { hdr: { peak: 900 }, commit: true });
  assert.deepEqual(L.nvAutoGuard({ hdr: { middleGrey: 50 }, commit: true }, follow, 'site'), { commit: true });
  for (const src of ['popup', 'panel', 'hotkey', 'profile', 'undo']) assert.deepEqual(L.nvAutoGuard(p, follow, src), p, src);
  assert.deepEqual(L.nvAutoGuard(p, S(), 'schedule'), p, '没开跟随 SDR');
  assert.equal(p.hdr.middleGrey, 50, '不修改输入');
  assert.equal(L.nvAutoGuard(null, follow, 'site'), null);

  assert.deepEqual(L.nvPatchDelta({ hdr: { peak: 1000, middleGrey: 70, enabled: true }, vsr: { mode: 5, priority: 1 }, indicator: false, commit: true }, NV_STATE),
    { hdr: { middleGrey: 70 }, vsr: { priority: 1 }, commit: true });
  assert.equal(L.nvPatchDelta({ hdr: { peak: 1000 }, vsr: { mode: 5 }, commit: true }, NV_STATE), null, '全都相同：不写');
  assert.deepEqual(L.nvPatchDelta({ hdr: { peak: 1000 } }, null), { hdr: { peak: 1000 } }, '读不到状态时不去重');
  assert.equal(L.nvPatchDelta(null, NV_STATE), null);
});

// ---------- 修改记录与撤销 ----------

test('nvStateDiff / nvChangeText', () => {
  const after = nvState({ hdr: { middleGrey: 70, peak: 800, contrast: -5 }, vsr: { mode: 0 } });
  const d = L.nvStateDiff(NV_STATE, after);
  assert.deepEqual(d, {
    before: { hdr: { peak: 1000, middleGrey: 65, contrast: 25 }, vsr: { mode: 5 } },
    after: { hdr: { peak: 800, middleGrey: 70, contrast: -5 }, vsr: { mode: 0 } }
  });
  assert.equal(L.nvStateDiff(NV_STATE, nvState()), null);
  assert.equal(L.nvStateDiff(NV_STATE, null), null);
  // 只比较可写字段（active、level、flags 不算）
  assert.equal(L.nvStateDiff(NV_STATE, Object.assign(nvState({ hdr: { active: true }, vsr: { level: 3 } }), { flags: 4 })), null);
  assert.equal(L.nvChangeText(d), '最高亮度 1000 → 800，中间灰 65 → 70，对比度 +25 → -5，超分辨率 自动 → 关');
  assert.equal(L.nvChangeText(d, 'en'), 'peak brightness 1000 → 800, middle grey 65 → 70, contrast +25 → -5, super resolution Auto → Off');
  assert.equal(L.nvChangeText({ before: { hdr: { enabled: true } }, after: { hdr: { enabled: false } } }), 'HDR 开 → 关');
  assert.equal(L.nvChangeText({ after: { vsr: { priority: 0 } } }), 'GPU 优先级 低');
  assert.equal(L.nvChangeText(null), '');
  assert.ok(!L.nvChangeText(d).includes('\u00b7') && !L.nvChangeText(d, 'en').includes('\u00b7'));
});

const logEntry = (o) => Object.assign({ at: 1000, source: 'popup', ok: true, undoable: true, before: { hdr: { middleGrey: 65 } }, after: { hdr: { middleGrey: 70 } } }, o);

test('nvLogEntry / nvLogAppend：规范化与环形上限', () => {
  const e = L.nvLogEntry(logEntry({ label: 'x'.repeat(60), junk: 1, before: { hdr: { middleGrey: 65, peak: 5, foo: 1 } } }));
  assert.equal(e.label.length, 40);
  assert.ok(!('junk' in e));
  assert.deepEqual(e.before, { hdr: { middleGrey: 65 } }, '超出范围和未知的字段丢掉');
  assert.equal(e.undoable, true);
  const failed = L.nvLogEntry(logEntry({ ok: false, error: { code: 'hdr-error', errorCode: 2, x: 1 } }));
  assert.equal(failed.undoable, false, '失败的不可撤销');
  assert.deepEqual(failed.error, { code: 'hdr-error', errorCode: 2 });
  assert.equal(L.nvLogEntry(logEntry({ unconfirmed: true })).undoable, false, '未确认的不可撤销');
  assert.equal(L.nvLogEntry(logEntry({ after: undefined })).undoable, false, '没有修改后的值');
  for (const bad of [null, logEntry({ source: 'evil' }), logEntry({ at: NaN }), logEntry({ at: -1 })]) assert.equal(L.nvLogEntry(bad), null);

  let log = null;
  for (let i = 0; i < 105; i++) log = L.nvLogAppend(log, logEntry({ at: 1000 + i }));
  assert.equal(log.v, 1);
  assert.equal(log.list.length, L.NV_LOG_MAX);
  assert.equal(log.seq, 105);
  assert.equal(log.list[0].id, 6);
  assert.equal(log.list[99].id, 105);
  const snap = JSON.stringify(log);
  assert.equal(L.nvLogAppend(log, { source: 'bogus' }).seq, 105, '不合法的条目不追加');
  L.nvLogAppend(log, logEntry());
  assert.equal(JSON.stringify(log), snap, '不修改输入');
  let small = null;
  for (let i = 0; i < 5; i++) small = L.nvLogAppend(small, logEntry(), 3);
  assert.deepEqual(small.list.map((x) => x.id), [3, 4, 5]);
  assert.equal(L.nvLogMarkUndone(small, 4).list[1].undone, true);
  assert.ok(!small.list[1].undone, '不修改输入');
});

test('nvUndoTarget：跳过已撤销、借用、撤销、失败、过期的条目', () => {
  const now = 1e10;
  let log = null;
  const add = (o) => { log = L.nvLogAppend(log, logEntry(Object.assign({ at: now - 1000 }, o))); return log.seq; };
  const old = add({ at: now - 2 * 3600000 });
  const good = add({});
  add({ source: 'lease', undoable: false });
  add({ ok: false, error: { code: 'api' } });
  const done = add({});
  log = L.nvLogMarkUndone(log, done);
  add({ source: 'undo', undoOf: done });
  assert.equal(L.nvUndoTarget(log, now).id, good);
  log = L.nvLogMarkUndone(log, good);
  assert.equal(L.nvUndoTarget(log, now), null, '更早的那条已经超过 1 小时');
  assert.equal(L.nvUndoTarget(log, now, 3 * 3600000).id, old, '放宽时限后可以撤销');
  assert.equal(L.nvUndoTarget(null, now), null);
});

test('nvWriteEntry：写入结果 → 修改记录条目', () => {
  const before = nvState({ hdr: { middleGrey: 65, peak: 1000 } });
  const after = nvState({ hdr: { middleGrey: 70, peak: 1000 } });
  const patch = { hdr: { middleGrey: 70, peak: 1000 }, commit: true };
  const snap = JSON.stringify([before, after, patch]);
  const ok = L.nvWriteEntry({ source: 'hotkey', at: 5, label: '电影', before, after, patch, undoOf: 3 });
  assert.deepEqual(ok, { id: 0, at: 5, source: 'hotkey', label: '电影', ok: true, before: { hdr: { middleGrey: 65 } }, after: { hdr: { middleGrey: 70 } },
    want: { hdr: { peak: 1000, middleGrey: 70 } }, undoable: true, undoOf: 3 });
  assert.equal(JSON.stringify([before, after, patch]), snap, '不修改输入');
  assert.equal(L.nvWriteEntry({ source: 'popup', at: 5, before, after: before, patch }), null, '没变化不记');
  const failed = L.nvWriteEntry({ source: 'schedule', at: 5, before, after: null, patch, error: { code: 'api', written: ['0x318'] } });
  assert.deepEqual(failed.before, { hdr: { peak: 1000, middleGrey: 65 } }, '失败时 before 只留补丁涉及的字段');
  assert.deepEqual(failed.error, { code: 'api', written: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.undoable, false);
  const unc = L.nvWriteEntry({ source: 'popup', at: 5, before, after: null, patch, unconfirmed: true });
  assert.equal(unc.unconfirmed, true);
  assert.equal(unc.undoable, false, '未确认的不可撤销');
  assert.equal(L.nvWriteEntry({ source: 'popup', at: 5, before, after: null, patch: {}, unconfirmed: true }), null);
  const lease = L.nvWriteEntry({ source: 'lease', at: 5, before: { hdr: { enabled: true } }, after: { hdr: { enabled: false } } });
  assert.deepEqual([lease.before, lease.after, lease.undoable], [{ hdr: { enabled: true } }, { hdr: { enabled: false } }, false], '借用不可撤销');
  for (const bad of [null, { source: 'evil', at: 5, before, after }, { source: 'popup', before, after }]) assert.equal(L.nvWriteEntry(bad), null);
  // 能直接追加进日志，撤销能找到它
  const log = L.nvLogAppend(null, ok);
  assert.equal(L.nvUndoTarget(log, 10).id, 1);
});

test('nvUndoPatch：实时值仍等于修改后的值才撤销，peak 夹到实时范围，HDR 出错时去掉 hdr', () => {
  const e = { before: { hdr: { middleGrey: 65, peak: 3000 }, vsr: { mode: 5 } }, after: { hdr: { middleGrey: 70, peak: 1500 }, vsr: { mode: 1 } } };
  const live = nvState({ hdr: { middleGrey: 70, peak: 1500 }, vsr: { mode: 1 } });
  assert.deepEqual(L.nvUndoPatch(e, live), { patch: { hdr: { middleGrey: 65, peak: 1970 }, vsr: { mode: 5 }, commit: true }, skipped: [], unavailable: [] });
  assert.equal(L.nvValidatePatch(L.nvUndoPatch(e, live).patch, live).ok, true, '结果能通过校验');
  // 中间灰之后又被改过：只撤销其他字段
  const moved = nvState({ hdr: { middleGrey: 80, peak: 1500 }, vsr: { mode: 1 } });
  assert.deepEqual(L.nvUndoPatch(e, moved), { patch: { hdr: { peak: 1970 }, vsr: { mode: 5 }, commit: true }, skipped: ['hdr.middleGrey'], unavailable: [] });
  // HDR 出错：只撤销超分，HDR 的字段算「现在写不了」，不算「之后又被改过」
  const err = nvState({ hdr: { middleGrey: 70, peak: 1500, error: 2 }, vsr: { mode: 1 } });
  assert.deepEqual(L.nvUndoPatch(e, err), { patch: { vsr: { mode: 5 }, commit: true }, skipped: [], unavailable: ['hdr.peak', 'hdr.middleGrey'] });
  assert.equal(L.nvUndoPatch(e, NV_STATE).patch, null, '全都被改过');
  // 最高亮度夹到实时范围后正好等于改后的值：没有要写的，两个列表都空（这条算已撤销）
  const clamped = { before: { hdr: { peak: 3000 } }, after: { hdr: { peak: 1970 } } };
  assert.deepEqual(L.nvUndoPatch(clamped, nvState({ hdr: { peak: 1970 } })), { patch: null, skipped: [], unavailable: [] });
  // 写不了的原因：nvErrorText 能显示
  assert.deepEqual(L.nvUnavailableError(err, 'hdr.peak'), { code: 'hdr-error', errorCode: 2 });
  assert.deepEqual(L.nvUnavailableError(nvState({ hdr: { supported: false } }), 'hdr.middleGrey'), { code: 'unsupported', field: 'hdr' });
  assert.deepEqual(L.nvUnavailableError(nvState({ vsr: { priority: null } }), 'vsr.priority'), { code: 'unsupported', field: 'vsr.priority' });
  assert.deepEqual(L.nvUnavailableError(nvState({ vsr: { supported: false } }), 'vsr.mode'), { code: 'unsupported', field: 'vsr' });
  assert.equal(L.nvUnavailableError(live, 'hdr.peak'), null, '能写');
  assert.equal(L.nvUnavailableError(live, 'nope'), null);
  assert.equal(L.nvUnavailableError(null, 'hdr.peak'), null);
  assert.equal(L.nvUndoPatch(null, live), null);
  assert.equal(L.nvUndoPatch(e, null), null);
});

test('nvUndoPatch：借用期间 hdr.enabled 和借用前的值比较', () => {
  const on = { before: { hdr: { enabled: false } }, after: { hdr: { enabled: true } } };
  const leased = nvState({ hdr: { enabled: false } }); // 实时的「关」是借来的
  assert.deepEqual(L.nvUndoPatch(on, leased), { patch: null, skipped: ['hdr.enabled'], unavailable: [] }, '不看借用会误判为之后又被改过');
  assert.deepEqual(L.nvUndoPatch(on, leased, { held: true, prevEnabled: true }),
    { patch: { hdr: { enabled: false }, commit: true }, skipped: [], unavailable: [] });
  assert.deepEqual(L.nvUndoPatch(on, leased, { leased: true, prevEnabled: true }).patch, { hdr: { enabled: false }, commit: true }, '也接受 hdrOnlyStatus');
  assert.deepEqual(L.nvUndoPatch(on, leased, { held: true, prevEnabled: null }), { patch: null, skipped: ['hdr.enabled'], unavailable: [] }, '不知道借用前的值：不撤销开关');
  const off = { before: { hdr: { enabled: true } }, after: { hdr: { enabled: false } } };
  assert.deepEqual(L.nvUndoPatch(off, leased, { held: true, prevEnabled: false }).patch, { hdr: { enabled: true }, commit: true });
  assert.deepEqual(L.nvUndoPatch(off, leased, { held: false, prevEnabled: true }).patch, { hdr: { enabled: true }, commit: true }, '没在借：看实时值');
  assert.deepEqual(leased, nvState({ hdr: { enabled: false } }), '不修改输入');
});

test('nvRevertPatch：只还原有差异的字段，peak 夹到实时范围，HDR 出错时跳过', () => {
  const snap = nvState({ hdr: { middleGrey: 50, peak: 2500 } });
  const cur = nvState({ hdr: { middleGrey: 80 } });
  assert.deepEqual(L.nvRevertPatch(cur, snap), { hdr: { peak: 1970, middleGrey: 50 }, commit: true });
  assert.equal(L.nvRevertPatch(NV_STATE, nvState()), null, '没有差异');
  assert.deepEqual(L.nvRevertPatch(nvState({ hdr: { error: 2, middleGrey: 80 }, vsr: { mode: 1 } }), snap), { vsr: { mode: 5 }, commit: true });
  assert.equal(L.nvRevertPatch(nvState({ hdr: { peak: 1970, middleGrey: 50 } }), snap), null, '夹完后和实时值相同');
  // 打开时正在借用：快照里没有 enabled，不会把 HDR 关掉
  const leasedSnap = L.nvEffectiveState(nvState({ hdr: { enabled: false } }), { leased: true });
  assert.equal(L.nvRevertPatch(nvState({ hdr: { enabled: true } }), leasedSnap), null);
  assert.equal(L.nvRevertPatch(null, snap), null);
  assert.equal(L.nvRevertPatch(cur, null), null);
});

// ---------- 按网站切换 NVIDIA 预设 ----------

test('sitePresetFor：先看顶层页面，再看 frame 自己的', () => {
  const sp = { 'blog.example': 'p1', 'youtube.com': 'p2' };
  assert.equal(L.sitePresetFor(sp, 'www.youtube.com', 'www.blog.example'), 'p1');
  assert.equal(L.sitePresetFor(sp, 'www.youtube.com', 'news.test'), 'p2');
  assert.equal(L.sitePresetFor(sp, 'www.youtube.com'), 'p2');
  assert.equal(L.sitePresetFor(sp, 'other.com', 'x.com'), null);
  assert.equal(L.sitePresetFor(null, 'youtube.com'), null);
});

test('nvSiteDecide：进入、暂停、A → B、离开、宽限期、手动、绑定被删', () => {
  const sp = { 'a.com': 'p1', 'b.com': 'p2' };
  const now = 100000;
  const T = (host, o) => Object.assign({ topHost: host, frameHost: host, hasVideo: true, playing: true }, o);
  const D = (record, target, extra) => L.nvSiteDecide(Object.assign({ record, target, sitePresets: sp, presetIds: ['p1', 'p2'], now }, extra));
  const recA = { host: 'a.com', presetId: 'p1', seenAt: now - 5000, base: {}, wrote: {} };
  // 进入：在绑定网站上播放
  assert.deepEqual(D(null, T('www.a.com')), { action: 'apply', host: 'a.com', presetId: 'p1', at: now });
  assert.deepEqual(D(null, T('a.com', { playing: false })), { action: 'none' }, '暂停时不套用');
  assert.deepEqual(D(null, T('other.com')), { action: 'none' });
  assert.deepEqual(D(null, null), { action: 'none' });
  // 同一网站、同一预设：只更新 seenAt（暂停也算还在看）
  assert.deepEqual(D(recA, T('a.com', { playing: false })), { action: 'none', host: 'a.com', presetId: 'p1', at: now });
  assert.equal(D(Object.assign({ manual: true }, recA), T('a.com')).action, 'none', '手动改过也不重新套用');
  // A → B；同一网站换了绑定
  assert.deepEqual(D(recA, T('b.com')), { action: 'apply', host: 'b.com', presetId: 'p2', at: now });
  assert.deepEqual(D(recA, T('a.com'), { sitePresets: { 'a.com': 'p2' } }), { action: 'apply', host: 'a.com', presetId: 'p2', at: now });
  // 仍在绑定网站但没有视频：宽限期内等，过了离开
  assert.deepEqual(D(recA, T('a.com', { hasVideo: false, playing: false })), { action: 'wait', host: 'a.com', at: recA.seenAt + L.NV_SITE_GRACE_MS });
  assert.deepEqual(D(Object.assign({}, recA, { seenAt: now - 31000 }), T('a.com', { hasVideo: false, playing: false })), { action: 'leave', host: 'a.com' });
  // 换到未绑定的网站、chrome:// 页面（没有目标）、绑定被删、预设被删
  assert.deepEqual(D(recA, T('other.com')), { action: 'leave', host: 'a.com' });
  assert.deepEqual(D(recA, null), { action: 'leave', host: 'a.com' });
  assert.deepEqual(D(recA, T('a.com'), { sitePresets: {} }), { action: 'leave', host: 'a.com' });
  assert.deepEqual(D(recA, T('a.com'), { presetIds: ['p2'] }), { action: 'leave', host: 'a.com' });
  // 嵌入的播放器：按顶层页面的域名
  assert.equal(D(null, T('a.com', { frameHost: 'www.youtube.com' })).host, 'a.com');
  assert.equal(D(null, T('news.test', { frameHost: 'b.com' })).host, 'b.com', '顶层没绑定时看 frame 自己的');
});

test('nvSiteRestorePatch：只恢复实时值仍等于写入值的字段', () => {
  const rec = { base: { hdr: { peak: 1000, middleGrey: 65, contrast: 25 } }, wrote: { hdr: { peak: 800, middleGrey: 50, contrast: 25 } } };
  assert.deepEqual(L.nvSiteRestorePatch(rec, nvState({ hdr: { peak: 800, middleGrey: 50 } })), { hdr: { peak: 1000, middleGrey: 65 }, commit: true });
  assert.deepEqual(L.nvSiteRestorePatch(rec, nvState({ hdr: { peak: 800, middleGrey: 55 } })), { hdr: { peak: 1000 }, commit: true }, '用户改过的中间灰不动');
  assert.equal(L.nvSiteRestorePatch(rec, NV_STATE), null, '都已经被改回去了');
  assert.equal(L.nvSiteRestorePatch(rec, nvState({ hdr: { peak: 800, middleGrey: 50, error: 1 } })), null, 'HDR 出错时不写 hdr');
  assert.equal(L.nvSiteRestorePatch(null, NV_STATE), null);
});

// ---------- 配置档 ----------

const profileSettings = () => S({ defaultState: 'off', osd: false, night: { enabled: true, start: '22:00', end: '06:00' }, sites: { 'a.com': 'on' },
  ui: { lang: 'en' }, nv: { presets: [preset('p1', 'x')], displayId: 'dev-1', followSdr: true } });

test('配置档的两组键正好覆盖 DEFAULT_SETTINGS 的全部顶层键', () => {
  const b = L.PROFILE_BEHAVIOR_KEYS, e = L.PROFILE_EXCLUDED_KEYS;
  assert.deepEqual(b.concat(e).sort(), Object.keys(L.DEFAULT_SETTINGS).sort(), '新设置要决定归哪一组');
  assert.equal(b.filter((k) => e.includes(k)).length, 0, '两组不重叠');
  assert.ok(Object.isFrozen(b) && Object.isFrozen(e));
});

test('normProfile / normProfiles', () => {
  const p = L.normProfile({ id: 'p1', name: '  电影  ', savedAt: 5, behavior: { osd: false, junk: 1, ui: { lang: 'en' } },
    sites: { 'WWW.A.com': 'off', 'b.com': 'x' }, nv: { hdr: { peak: 1000, middleGrey: 60, contrast: 0, saturation: 0 }, indicator: true, junk: 1 }, junk: 1 });
  assert.equal(p.name, '电影');
  assert.deepEqual(Object.keys(p.behavior).sort(), L.PROFILE_BEHAVIOR_KEYS.slice().sort());
  assert.equal(p.behavior.osd, false);
  assert.ok(!('ui' in p.behavior) && !('junk' in p));
  assert.deepEqual(p.sites, { 'a.com': 'off' });
  assert.deepEqual(p.nv, { hdr: { peak: 1000, middleGrey: 60, contrast: 0, saturation: 0 }, indicator: true });
  assert.deepEqual(L.normProfile(p), p, '幂等');
  for (const bad of [null, { id: 'p1', name: 'x' }, { id: 'bad id', name: 'x', behavior: {} }, { id: 'p1', name: ' ', behavior: {} }]) assert.equal(L.normProfile(bad), null);
  assert.ok(!('nv' in L.normProfile({ id: 'p1', name: 'x', behavior: {}, nv: { hdr: { peak: 'x' } } })), '坏的 NVIDIA 部分丢掉');
  const sites = {};
  for (let i = 0; i < 1100; i++) sites['s' + i + '.com'] = 'on';
  assert.equal(Object.keys(L.normProfile({ id: 'p1', name: 'x', behavior: {}, sites }).sites).length, 1000, '网站规则最多 1000 条');

  const list = [];
  for (let i = 0; i < 25; i++) list.push({ id: 'p' + i, name: 'n' + i, behavior: {} });
  list.splice(1, 0, { id: 'p0', name: 'dup', behavior: {} });
  const ps = L.normProfiles({ list, activeId: 'p3' });
  assert.equal(ps.v, 1);
  assert.equal(ps.list.length, L.PROFILES_MAX);
  assert.equal(ps.list[1].id, 'p1', 'id 去重');
  assert.equal(ps.activeId, 'p3');
  assert.equal(L.normProfiles({ list, activeId: 'p24' }).activeId, null, 'activeId 必须在列表里');
  assert.deepEqual(L.normProfiles(null), { v: 1, list: [], activeId: null });
});

test('profileFromCurrent：借用、各部分开关，不含 ui 和 displayId', () => {
  const s = profileSettings();
  const leased = nvState({ hdr: { enabled: false, middleGrey: 55 } });
  const p = L.profileFromCurrent(s, leased, { id: 'p1', name: '夜间', now: 123, sites: true, nv: true, lease: { held: true, prevEnabled: true } });
  assert.equal(p.savedAt, 123);
  assert.equal(p.behavior.defaultState, 'off');
  assert.deepEqual(p.behavior.night, { enabled: true, start: '22:00', end: '06:00' });
  assert.deepEqual(p.sites, { 'a.com': 'on' });
  assert.deepEqual(p.nv, { hdr: { enabled: true, peak: 1000, middleGrey: 55, contrast: 25, saturation: 0 }, vsr: { mode: 5, priority: 2 }, indicator: false });
  const json = JSON.stringify(p);
  assert.ok(!/dev-1|"ui"|"lang"|displayId|followSdr/.test(json), json);
  const q = L.profileFromCurrent(s, null, { id: 'p2', name: 'x' });
  assert.ok(!('sites' in q) && !('nv' in q), '不要网站规则和 NVIDIA 部分');
  // 不知道借用前的值时不存开关；不支持超分、没有指示器时不存
  const r = L.profileFromCurrent(s, Object.assign(nvState({ vsr: { supported: false } }), { indicator: null, flags: null }), { id: 'p3', name: 'x', nv: true, lease: { held: true } });
  assert.deepEqual(r.nv, { hdr: { peak: 1000, middleGrey: 65, contrast: 25, saturation: 0 } });
  assert.equal(L.profileFromCurrent(s, null, { id: 'p4', name: 'x', nv: true }), null, '要 NVIDIA 部分但读不到');
  assert.equal(L.profileFromCurrent(s, NV_STATE, { id: 'bad id', name: 'x' }), null);
});

test('profileApply / profileNvPatch / profileDiff', () => {
  const s = profileSettings();
  const p = L.profileFromCurrent(s, NV_STATE, { id: 'p1', name: 'x', sites: true, nv: true });
  assert.deepEqual(L.profileDiff(s, NV_STATE, p), [], '刚保存的配置档与当前一致');
  const other = S({ eye: { minutes: 10 }, sites: { 'z.com': 'off' }, ui: { lang: 'zh', accent: '#FF7A1A' }, nv: { presets: [preset('p9', 'y')], displayId: 'dev-2' } });
  const applied = L.profileApply(other, p);
  for (const k of L.PROFILE_BEHAVIOR_KEYS) assert.deepEqual(applied[k], s[k], k);
  assert.deepEqual(applied.sites, { 'a.com': 'on' }, '配置档带 sites 时整体替换');
  assert.deepEqual(applied.ui, other.ui, 'ui 不碰');
  assert.deepEqual(applied.nv, other.nv, 'nv 不碰');
  assert.equal(applied.updateCheck, other.updateCheck);
  const noSites = L.profileFromCurrent(s, null, { id: 'p2', name: 'y' });
  assert.deepEqual(L.profileApply(other, noSites).sites, other.sites, '不带 sites 时保留');
  assert.equal(L.profileApply(other, null), null);

  const diff = L.profileDiff(other, nvState({ hdr: { peak: 1500, middleGrey: 50 } }), p);
  const keys = diff.map((d) => d.key);
  for (const k of ['defaultState', 'osd', 'night.enabled', 'night.start', 'eye.minutes', 'sites']) assert.ok(keys.includes(k), k + '：' + keys.join());
  assert.deepEqual(diff.find((d) => d.key === 'sites'), { key: 'sites', from: 1, to: 1 });
  assert.deepEqual(diff.find((d) => d.key === 'nv.hdr.peak'), { key: 'nv.hdr.peak', from: 1500, to: 1000 });
  assert.deepEqual(diff.find((d) => d.key === 'nv.hdr.middleGrey'), { key: 'nv.hdr.middleGrey', from: 50, to: 65 });
  assert.equal(keys.filter((k) => k.indexOf('nv.') === 0).length, 2);
  assert.ok(L.profileDiff(other, null, p).every((d) => d.key.indexOf('nv.') !== 0), '读不到 NVIDIA 状态时不比较');
  assert.equal(L.profileDiff(s, NV_STATE, null), null);

  // NVIDIA 部分：同 nvPresetPatch，另外带 indicator
  assert.deepEqual(L.profileNvPatch(p, nvState({ hdr: { peakMax: 900 } })),
    { hdr: { enabled: true, peak: 900, middleGrey: 65, contrast: 25, saturation: 0 }, vsr: { mode: 5, priority: 2 }, indicator: false, commit: true });
  assert.deepEqual(L.profileNvPatch(p, Object.assign(nvState({ hdr: { error: 2 } }), { indicator: null, flags: null })), { vsr: { mode: 5, priority: 2 }, commit: true });
  assert.deepEqual(L.profileNvPatch(p, nvState({ hdr: { supported: false }, vsr: { supported: false } })), { commit: true, indicator: false });
  assert.equal(L.profileNvPatch(noSites, NV_STATE), null);
  assert.equal(L.profileNvPatch(p, null), null);
});

test('profileUpsert：同名覆盖并保留 id，上限', () => {
  const mk = (id, name) => ({ id, name, behavior: {} });
  let r = L.profileUpsert([], mk('a', '电影'));
  assert.deepEqual([r.overwrote, r.id, r.list.length], [false, 'a', 1]);
  r = L.profileUpsert(r.list, Object.assign(mk('b', '电影'), { behavior: { osd: false } }));
  assert.deepEqual([r.overwrote, r.id, r.list.length], [true, 'a', 1]);
  assert.equal(r.list[0].behavior.osd, false);
  assert.deepEqual(L.profileUpsert(r.list, mk('a', '别的')), { code: 'invalid' }, 'id 冲突');
  assert.deepEqual(L.profileUpsert(r.list, null), { code: 'invalid' });
  const full = [];
  for (let i = 0; i < 20; i++) full.push(mk('p' + i, 'n' + i));
  assert.deepEqual(L.profileUpsert(full, mk('new', 'new')), { code: 'max' });
  assert.equal(L.profileUpsert(full, mk('new', 'n3')).overwrote, true, '满了也能覆盖同名的');
  assert.equal(full.length, 20, '不修改输入');
});

test('profilesMerge：换新 id、重名改名且不超过 24 个码点、上限', () => {
  const mk = (id, name) => ({ id, name, behavior: {} });
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四';
  const cur = [mk('a', '电影'), mk('b', long), mk('c', '电影 (2)')];
  const r = L.profilesMerge(cur, [mk('a', '电影'), mk('zz', long), mk('x', '新的'), { junk: 1 }, 'x'], 1000);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.added.map((a) => [a.name, a.renamed]), [['电影 (3)', true], [long.slice(0, 20) + ' (2)', true], ['新的', false]]);
  for (const a of r.added) assert.ok(Array.from(a.name).length <= 24, a.name);
  const ids = r.list.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 唯一');
  assert.ok(r.added.every((a) => !['a', 'b', 'c', 'zz', 'x'].includes(a.id)), '导入的全部换新 id');
  assert.equal(r.list.length, 6);
  assert.equal(cur.length, 3, '不修改输入');
  const full = [];
  for (let i = 0; i < 19; i++) full.push(mk('p' + i, 'n' + i));
  const m = L.profilesMerge(full, [mk('q1', 'x'), mk('q2', 'y')], 1);
  assert.equal(m.list.length, L.PROFILES_MAX);
  assert.equal(m.added.length, 1);
  assert.equal(m.dropped, 1);
});

test('配置档文件：导出与检查（invalid / newer / empty）', () => {
  const f = L.makeProfilesFile([{ id: 'a', name: '电影', behavior: { osd: false } }], '1.3.0', Date.UTC(2026, 9, 22));
  assert.equal(f.format, 'rtx-hdr-switch-profiles');
  assert.equal(f.version, 1);
  assert.equal(f.exportedAt, '2026-10-22T00:00:00.000Z');
  assert.equal(f.extensionVersion, '1.3.0');
  const back = L.validateProfilesFile(JSON.parse(JSON.stringify(f)));
  assert.equal(back.ok, true);
  assert.deepEqual(back.profiles, f.profiles);
  assert.deepEqual(L.validateProfilesFile(null), { ok: false, code: 'invalid' });
  assert.deepEqual(L.validateProfilesFile({ format: L.BACKUP_FORMAT, version: 1, profiles: [] }), { ok: false, code: 'invalid' });
  assert.deepEqual(L.validateProfilesFile(Object.assign({}, f, { version: 2 })), { ok: false, code: 'newer' });
  assert.deepEqual(L.validateProfilesFile(Object.assign({}, f, { profiles: 'x' })), { ok: false, code: 'invalid' });
  assert.deepEqual(L.validateProfilesFile(Object.assign({}, f, { profiles: [{ id: 'a' }] })), { ok: false, code: 'empty' });
});

test('备份 1.3：带配置档往返，1.2 格式仍能导入', () => {
  const all = { settings: { osd: false }, profiles: { v: 1, list: [{ id: 'a', name: '电影', behavior: {} }, { bad: 1 }], activeId: 'a' }, 'v:yt:x': { s: 'on', t: 1 } };
  const b = L.makeBackup(all, '1.3.0', 0);
  assert.equal(b.version, 1, 'BACKUP_VERSION 不变');
  assert.equal(b.profiles.list.length, 1);
  assert.equal(b.profiles.activeId, 'a');
  const back = L.validateBackup(JSON.parse(JSON.stringify(b)));
  assert.deepEqual(back.profiles, b.profiles);
  assert.equal(back.summary.profiles, 1);
  const old = L.validateBackup({ format: L.BACKUP_FORMAT, version: 1, settings: { defaultState: 'off' }, videos: {} });
  assert.equal(old.ok, true);
  assert.equal(old.profiles, null);
  assert.equal(old.summary.profiles, 0);
  assert.equal(old.settings.updateCheck, true, '1.2 的设置补上新字段');
  assert.equal(L.validateBackup(Object.assign({}, b, { profiles: 'x' })).profiles, null, '坏的配置档字段当作没有');
});

// ---------- 更新检查、本地组件 ----------

test('semverCmp', () => {
  assert.equal(L.semverCmp('1.10.0', '1.9.0'), 1);
  assert.equal(L.semverCmp('1.9.0', '1.10.0'), -1);
  assert.equal(L.semverCmp('v1.3.0', '1.3.0'), 0);
  assert.equal(L.semverCmp('1.3.0-beta.1', '1.3.0'), -1, '预发布版小于正式版');
  assert.equal(L.semverCmp('1.3.0', '1.3.0-rc.1'), 1);
  assert.equal(L.semverCmp('1.3.0-beta.2', '1.3.0-beta.10'), -1);
  assert.equal(L.semverCmp('1.3.0-alpha', '1.3.0-beta'), -1);
  assert.equal(L.semverCmp('1.3.0-1', '1.3.0-alpha'), -1, '数字标识小于字母标识');
  assert.equal(L.semverCmp('1.3.0-beta', '1.3.0-beta.1'), -1);
  assert.equal(L.semverCmp('2.0.0+build.5', '2.0.0'), 0);
  for (const bad of ['1.3', '1.3.0.1', 'x', '', null, 5, 'v', '1.3.0-', '1.2.3x']) assert.equal(L.semverCmp(bad, '1.0.0'), null, String(bad));
});

const REPO = 'https://github.com/miniso7892-dotcom/rtx-hdr-switch/releases/';
const release = () => ({
  tag_name: 'v1.4.0', name: 'RTX HDR Switch 1.4.0', draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z',
  html_url: REPO + 'tag/v1.4.0',
  assets: [
    { name: 'notes.txt', browser_download_url: REPO + 'download/v1.4.0/notes.txt' },
    { name: 'other.zip', browser_download_url: REPO + 'download/v1.4.0/other.zip' },
    { name: 'rtx-hdr-switch-1.4.0.zip', browser_download_url: REPO + 'download/v1.4.0/rtx-hdr-switch-1.4.0.zip', digest: 'sha256:' + 'A'.repeat(64) }
  ]
});

test('parseRelease：外站链接、zip 选择、prerelease', () => {
  assert.deepEqual(L.parseRelease(release()), {
    version: '1.4.0', tag: 'v1.4.0', url: REPO + 'tag/v1.4.0', zip: REPO + 'download/v1.4.0/rtx-hdr-switch-1.4.0.zip',
    digest: 'sha256:' + 'a'.repeat(64), publishedAt: '2026-11-01T00:00:00Z', name: 'RTX HDR Switch 1.4.0'
  });
  const j = release();
  j.assets = [j.assets[1], { name: 'evil.zip', browser_download_url: 'https://evil.example/x.zip' }];
  assert.equal(L.parseRelease(j).zip, REPO + 'download/v1.4.0/other.zip', '没有 rtx-hdr-switch 的 zip 时退而求其次');
  assert.equal(L.parseRelease(j).digest, null);
  j.assets = [{ name: 'rtx-hdr-switch.zip', browser_download_url: 'https://evil.example/rtx-hdr-switch.zip' }];
  assert.equal(L.parseRelease(j).zip, null, '外站的 zip 不要');
  assert.equal(L.parseRelease(Object.assign(release(), { prerelease: true })), null);
  assert.equal(L.parseRelease(Object.assign(release(), { draft: true })), null);
  for (const url of ['https://evil.example/releases/tag/v1.4.0', 'https://github.com/someone-else/rtx-hdr-switch/releases/tag/v1.4.0',
    REPO + '../../../evil', 'http://github.com/miniso7892-dotcom/rtx-hdr-switch/releases/tag/v1.4.0', 'javascript:alert(1)', null]) {
    assert.equal(L.parseRelease(Object.assign(release(), { html_url: url })), null, String(url));
  }
  assert.equal(L.parseRelease(Object.assign(release(), { tag_name: 'latest' })), null);
  assert.equal(L.parseRelease(null), null);
});

test('updateBackoff / updateDue / updateNotice', () => {
  const now = 1e12, H = 3600000;
  assert.equal(L.updateBackoff(429, { retryAfter: '120' }, 0, now), now + 120000);
  assert.equal(L.updateBackoff(403, { remaining: '0', reset: String((now + 30 * 60000) / 1000) }, 0, now), now + 30 * 60000);
  assert.equal(L.updateBackoff(403, {}, 0, now), now + H, '没有限流信息时 1 小时');
  assert.equal(L.updateBackoff(429, { retryAfter: '1' }, 0, now), now + 60000, '至少 1 分钟');
  assert.equal(L.updateBackoff(403, { remaining: '0', reset: String(now / 1000 + 3 * 86400) }, 0, now), now + 24 * H, '最多 24 小时');
  assert.deepEqual([0, 1, 2, 3, 9].map((f) => (L.updateBackoff(503, {}, f, now) - now) / H), [3, 6, 12, 24, 24]);
  assert.equal(L.updateBackoff(200, {}, 0, now), 0);
  assert.equal(L.updateBackoff(0, {}, 2, now), 0, '离线不退避');

  assert.equal(L.updateDue(null, now), true);
  assert.equal(L.updateDue({ checkedAt: now - 23 * H }, now), false);
  assert.equal(L.updateDue({ checkedAt: now - 24 * H }, now), true);
  assert.equal(L.updateDue({ checkedAt: now - 48 * H, retryAt: now + 1 }, now), false, '还在退避');
  assert.equal(L.updateDue({ checkedAt: now + 5 * H }, now), true, '时钟被调回过');

  const st = { latest: { version: '1.4.0', url: REPO + 'tag/v1.4.0', zip: null } };
  assert.deepEqual(L.updateNotice(st, '1.3.0', now), { version: '1.4.0', url: REPO + 'tag/v1.4.0', zip: null });
  assert.equal(L.updateNotice(st, '1.4.0', now), null);
  assert.equal(L.updateNotice(st, '1.5.0', now), null);
  assert.equal(L.updateNotice(Object.assign({ skipped: '1.4.0' }, st), '1.3.0', now), null);
  assert.equal(L.updateNotice(Object.assign({ snoozeVersion: '1.4.0', snoozeUntil: now + 1 }, st), '1.3.0', now), null);
  assert.ok(L.updateNotice(Object.assign({ snoozeVersion: '1.4.0', snoozeUntil: now - 1 }, st), '1.3.0', now), '7 天过了');
  assert.ok(L.updateNotice(Object.assign({ snoozeVersion: '1.3.5', snoozeUntil: now + 1 }, st), '1.3.0', now), '更新的版本照常提醒');
  assert.equal(L.updateNotice({ latest: { version: '1.4.0', url: 'https://evil.example/' } }, '1.3.0', now), null);
  assert.equal(L.updateNotice({}, '1.3.0', now), null);
});

test('nvHostCheck：1.1、协议、缺 dll、正常', () => {
  const hello = { ok: true, host: 'rtx_hdr_host', version: '1.2.0', protocol: 1, dll: 'C:\\Program Files\\NVIDIA\\nvcpl.dll', caps: ['display', 'hdrLease'] };
  assert.deepEqual(L.nvHostCheck(hello), { status: 'ok', version: '1.2.0', missingCaps: [], code: null });
  const v11 = Object.assign({}, hello, { version: '1.1.0' });
  delete v11.caps;
  assert.deepEqual(L.nvHostCheck(v11), { status: 'old', version: '1.1.0', missingCaps: ['display', 'hdrLease'], code: null });
  assert.deepEqual(L.nvHostCheck(Object.assign({}, hello, { caps: ['display'] })).missingCaps, ['hdrLease']);
  assert.equal(L.nvHostCheck(Object.assign({}, hello, { protocol: 2 })).status, 'protocol');
  assert.equal(L.nvHostCheck(Object.assign({}, hello, { dll: null })).status, 'no-dll');
  assert.equal(L.nvHostCheck({ ok: false, error: { code: 'no-dll' } }).status, 'no-dll');
  assert.deepEqual(L.nvHostCheck({ ok: false, error: { code: 'host-missing' } }), { status: 'error', version: '', missingCaps: [], code: 'host-missing' });
  assert.equal(L.nvHostCheck(null).code, 'host-error');
});

test('diagRedact：去掉网址、域名、视频 key、显示器名和用户名，同一个值同一个编号', () => {
  const snap = {
    hello: { ok: true, host: 'rtx_hdr_host', dll: 'C:\\Users\\Alice\\AppData\\Local\\nvcpl.dll' },
    settings: { sites: { 'secret-site.com': 'on' }, nv: { displayId: '\\\\?\\DISPLAY#SECRETMON#1', sitePresets: { 'secret-site.com': 'p1' } } },
    frames: {
      0: { hostname: 'www.secret-site.com', key: 'yt:SECRETKEY', url: 'https://www.secret-site.com/watch?v=SECRETKEY' },
      3: { hostname: 'embed.other.com', topHostname: 'secret-site.com', key: 'u:https://embed.other.com/x' }
    },
    displays: [{ id: '\\\\?\\DISPLAY#SECRETMON#1', name: 'Secret Monitor', hdrEnabled: true }],
    log: [{ source: 'site', label: 'secret-site.com', ok: true }, { source: 'profile', label: '电影', ok: true }],
    'v:yt:SECRETKEY': { s: 'on', t: 1 },
    note: 'see https://www.secret-site.com/a for details'
  };
  const before = JSON.stringify(snap);
  const r = L.diagRedact(snap);
  const out = JSON.stringify(r);
  for (const s of ['secret-site', 'SECRETKEY', 'SECRETMON', 'Secret Monitor', 'Alice', 'other.com']) assert.ok(!out.includes(s), s + '：' + out);
  assert.equal(JSON.stringify(snap), before, '不修改输入');
  assert.equal(r.frames[0].hostname, r.frames[3].topHostname, '同一个网站同一个编号');
  assert.equal(r.frames[0].hostname, Object.keys(r.settings.sites)[0]);
  assert.equal(r.frames[0].url, r.frames[0].hostname, '网址换成它的域名编号');
  assert.equal(r.log[0].label, r.frames[0].hostname);
  assert.equal(r.log[1].label, '电影', '配置档名不是网站');
  assert.equal(r.settings.nv.displayId, r.displays[0].id);
  assert.match(r.displays[0].name, /^display#\d+$/);
  assert.equal(r.hello.host, 'rtx_hdr_host');
  assert.equal(r.hello.dll, '<user>\\AppData\\Local\\nvcpl.dll');
  assert.equal(r.displays[0].hdrEnabled, true);
  assert.equal(r.note, 'see ' + r.frames[0].hostname + ' for details');
  assert.ok(Object.keys(r).includes(r.frames[0].key), 'v:* 键与 key 字段用同一套编号');
});

// ---------- 观看：决策、按住对比、本标签页沿用、全屏转发 ----------

test('decide 1.3：本标签页沿用', () => {
  const settings = S({ sites: { 'example.com': 'off' } });
  const d = (o) => L.decide(Object.assign({ settings, hostname: 'example.com', minutes: NOON, autoState: 'off' }, o));
  assert.deepEqual(d({ tab: 'on', manual: 'off' }), { state: 'off', reason: 'manual' }, 'manual > tab');
  assert.deepEqual(d({ tab: 'on', manual: { state: 'off', reason: 'eye' } }), { state: 'off', reason: 'eye' }, '护眼 > tab');
  assert.deepEqual(d({ tab: 'on', saved: { s: 'off', t: 1 } }), { state: 'on', reason: 'tab' }, 'tab > video');
  assert.deepEqual(d({ tab: 'on' }), { state: 'on', reason: 'tab' }, 'tab > site');
  assert.deepEqual(d({ tab: 'off', fullscreen: true }), { state: 'off', reason: 'tab' });
  for (const bad of ['yes', true, 1, { state: 'on' }, null]) assert.equal(d({ tab: bad }).reason, 'site', JSON.stringify(bad));
});

test('decide 1.3：仅全屏', () => {
  const fsDef = S({ defaultState: 'fullscreen' });
  const d = (s, o) => L.decide(Object.assign({ settings: s, hostname: 'a.com', minutes: NOON }, o));
  assert.deepEqual(d(fsDef, { fullscreen: true }), { state: 'on', reason: 'fullscreen' });
  assert.deepEqual(d(fsDef, { fullscreen: false }), { state: 'off', reason: 'fullscreen' });
  assert.deepEqual(d(fsDef, {}), { state: 'off', reason: 'fullscreen' }, '缺省按不全屏');
  assert.equal(d(fsDef, { fullscreen: 'yes' }).state, 'off');
  // 夜间、白底检测压过默认级的仅全屏
  const night = S({ defaultState: 'fullscreen', night: { enabled: true, start: '23:00', end: '07:00' } });
  assert.deepEqual(d(night, { fullscreen: true, minutes: 0 }), { state: 'off', reason: 'night' });
  assert.deepEqual(d(fsDef, { fullscreen: true, autoState: 'off' }), { state: 'off', reason: 'auto' });
  // 网站规则的仅全屏：全屏时开、reason 是 site，并压过夜间
  const site = S({ sites: { 'a.com': 'fullscreen' }, night: { enabled: true, start: '23:00', end: '07:00' } });
  assert.deepEqual(d(site, { fullscreen: true, minutes: 0 }), { state: 'on', reason: 'site' });
  assert.deepEqual(d(site, { fullscreen: false, minutes: 0 }), { state: 'off', reason: 'site' });
  // 记住的视频、本标签页沿用压过网站规则的仅全屏
  assert.deepEqual(d(site, { saved: { s: 'on', t: 1 } }), { state: 'on', reason: 'video' });
  assert.deepEqual(d(site, { tab: 'on' }), { state: 'on', reason: 'tab' });
  // 顶层页面的规则优先于 iframe 自身域名的
  const both = S({ sites: { 'blog.example': 'fullscreen', 'a.com': 'on' } });
  assert.deepEqual(d(both, { topHostname: 'blog.example' }), { state: 'off', reason: 'site' });
});

test('文案 1.3：本标签页沿用、仅全屏', () => {
  assert.equal(L.reasonText('tab'), '本标签页沿用');
  assert.equal(L.reasonText('fullscreen'), '仅全屏');
  assert.equal(L.reasonText('tab', 'en'), 'kept for this tab');
  assert.equal(L.reasonText('fullscreen', 'en'), 'fullscreen only');
  assert.equal(L.osdText('on', 'tab'), 'RTX HDR：开（本标签页沿用）');
  assert.equal(L.osdText('off', 'fullscreen'), 'RTX HDR：关（仅全屏）');
  assert.equal(L.osdText('on', 'tab', 'en'), 'RTX HDR: on (kept for this tab)');
  assert.equal(L.osdText('on', 'fullscreen', 'en'), 'RTX HDR: on (fullscreen only)');
});

test('createHoldGesture：短按、按住、重复调用', () => {
  assert.equal(L.PEEK_HOLD_MS, 300);
  const g = L.createHoldGesture(L.PEEK_HOLD_MS);
  assert.equal(g.down(1000), 'down');
  assert.equal(g.due(1299), null, '没到阈值');
  assert.equal(g.up(1299), 'tap');
  assert.equal(g.pressed, false);
  assert.equal(g.down(2000), 'down');
  assert.equal(g.down(2100), null, '已经按下时忽略');
  assert.equal(g.due(2300), 'hold', '从第一次按下算起');
  assert.equal(g.due(2400), null, '只返回一次');
  assert.equal(g.held, true);
  assert.equal(g.up(2500), 'release');
  assert.equal(g.up(2600), null, '没按下时松开');
  g.down(3000);
  assert.equal(g.cancel(), null, '按住前取消');
  assert.equal(g.due(3500), null, '取消之后不会再进入按住');
  g.down(4000);
  g.due(4300);
  assert.equal(g.cancel(), 'release', '按住后取消');
  assert.equal(g.cancel(), null);
  assert.equal(L.createHoldGesture().holdMs, 300, '默认 300 ms');
});

test('tabOffer：只在下一个视频重复同样的操作时提议', () => {
  assert.equal(L.tabOffer({ key: 'yt:a', state: 'off' }, 'yt:b', 'off', null), true);
  assert.equal(L.tabOffer({ key: 'yt:b', state: 'off' }, 'yt:b', 'off', null), false, '同一个视频');
  assert.equal(L.tabOffer({ key: 'yt:a', state: 'on' }, 'yt:b', 'off', null), false, '状态不同');
  assert.equal(L.tabOffer({ key: 'yt:a', state: 'off' }, 'yt:b', 'off', { state: 'off', at: 1 }), false, '已在沿用');
  assert.equal(L.tabOffer(null, 'yt:b', 'off', null), false, '上一次为空');
  assert.equal(L.tabOffer({ key: 'yt:a', state: 'off' }, '', 'off', null), false);
  assert.equal(L.tabOffer({ key: 'yt:a', state: 'x' }, 'yt:b', 'x', null), false);
});

test('fsHintTarget：父页面把 iframe 设为全屏时通知哪个子 frame', () => {
  const now = 100000;
  const top = { hasVideo: false, ts: now, fsFrame: true };
  const F = (frames, childMax) => L.fsHintTarget(frames, now, 10000, childMax === undefined ? 10000 : childMax);
  assert.equal(F({ 0: Object.assign({}, top, { fsFrame: false }), 3: { hasVideo: true, ts: now } }), -1, '顶层没有 fsFrame');
  assert.equal(F({ 0: top, 3: { hasVideo: true, ts: now } }), 3);
  assert.equal(F({ 0: top, 3: { hasVideo: true, ts: now }, 5: { hasVideo: true, ts: now, fullscreen: true } }), -1, '子 frame 自己全屏');
  assert.equal(F({ 0: top, 5: { hasVideo: true, ts: now - 60000, fullscreen: true }, 3: { hasVideo: true, ts: now } }, 0), 3, '过期子 frame 的全屏不算');
  assert.equal(F({ 0: top, 3: { hasVideo: true, ts: now - 20000 } }), -1, '子 frame 已消失');
  assert.equal(F({ 0: top, 3: { hasVideo: true, playing: false, area: 9000, ts: now }, 4: { hasVideo: true, playing: true, area: 100, ts: now },
    6: { hasVideo: true, playing: true, area: 500, ts: now } }), 6, '在播放的优先，再比面积');
  assert.equal(F({ 0: Object.assign({}, top, { hasVideo: true, playing: true, area: 9e9 }) }), -1, '不会选顶层自己');
  assert.equal(F(null), -1);
});

// ---------- 播放器面板 ----------

test('placeAbove：按钮上方居中、左右夹边、空间不足时缩小高度', () => {
  const root = { left: 0, top: 0, width: 800, height: 450 };
  const btn = { left: 700, top: 400, width: 40, height: 40 };
  assert.deepEqual(L.placeAbove(btn, root, 320, 200, 22, 8), { x: 472, y: 178, h: 200 }, '右边夹到 800 - 8 - 320');
  assert.deepEqual(L.placeAbove({ left: 10, top: 400, width: 40, height: 40 }, root, 320, 200, 22, 8), { x: 8, y: 178, h: 200 }, '左边夹到 8');
  assert.deepEqual(L.placeAbove({ left: 380, top: 400, width: 40, height: 40 }, root, 320, 200, 22, 8), { x: 240, y: 178, h: 200 }, '居中');
  assert.deepEqual(L.placeAbove(btn, root, 320, 500, 22, 8), { x: 472, y: 8, h: 370 }, '高度夹到按钮上方的可用空间');
  assert.deepEqual(L.placeAbove(btn, { left: 100, top: 50, width: 800, height: 450 }, 320, 500, 22, 8), { x: 560, y: 58, h: 320 });
  assert.equal(L.placeAbove(null, root, 320, 200, 22, 8), null);
  assert.equal(L.placeAbove(btn, root, 0, 200, 22, 8), null);
  assert.equal(L.placeAbove({ left: 'x', top: 0, width: 1, height: 1 }, root, 1, 1, 0, 0), null);
});

test('PLAYER_HOSTS 与 playerSite 一致', () => {
  assert.ok(Object.isFrozen(L.PLAYER_HOSTS));
  for (const [h, site] of Object.entries(L.PLAYER_HOSTS)) assert.equal(L.playerSite(h, '/watch'), site, h);
  assert.deepEqual(Array.from(new Set(Object.values(L.PLAYER_HOSTS))).sort(), ['bilibili', 'tencent', 'twitch', 'youtube']);
  assert.equal(L.playerSite('www.youtube.com', '/embed/x'), null, '嵌入播放器仍然排除');
  assert.equal(L.playerSite('toString'), null, '原型上的键不算');
});

// ---------- 1.3 结构测试 ----------

test('i18n：界面文字不含「·」', () => {
  const I = require('../i18n.js');
  for (const lang of ['zh', 'en']) for (const [k, v] of Object.entries(I.DICT[lang])) assert.ok(!v.includes('\u00b7'), lang + ' ' + k + '：' + v);
  for (const loc of ['en', 'zh_CN']) {
    const msgs = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8'));
    for (const [k, v] of Object.entries(msgs)) assert.ok(!v.message.includes('\u00b7'), loc + ' ' + k);
  }
  // 页面脚本去掉注释后的源码（字符串字面量、拼接的分隔符），以及所有 HTML（没有 data-i18n 的静态文字）
  const scripts = fs.readdirSync(ROOT).filter((f) => /\.js$/.test(f));
  assert.ok(['lib.js', 'popup.js', 'options.js', 'content.js', 'background.js'].every((f) => scripts.indexOf(f) >= 0), scripts.join());
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!src.includes('\u00b7'), f);
  }
  for (const f of fs.readdirSync(ROOT).filter((x) => /\.html$/.test(x))) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!html.includes('\u00b7'), f);
  }
});

test('i18n：动态拼出的键都存在（修改记录来源、字段、更新和配置档的错误码、面板打开方式）', () => {
  const I = require('../i18n.js');
  const keys = new Set(Object.keys(I.DICT.zh));
  for (const s of L.NV_SOURCES) assert.ok(keys.has('nv.source.' + s), s);
  for (const f of L.NV_FIELDS) assert.ok(keys.has('nv.field.' + f), f);
  for (const c of ['offline', 'rate', 'http', 'invalid', 'timeout']) assert.ok(keys.has('update.err.' + c), c);
  for (const c of ['invalid', 'newer', 'empty', 'max', 'exists', 'nv-unavailable', 'not-found', 'expired', 'name']) assert.ok(keys.has('profile.err.' + c), c);
  for (const r of Object.keys(L.REASON_TEXT)) assert.ok(keys.has('reason.' + r), r);
  for (const m of L.PANEL_MODES) assert.ok(keys.has('rules.panel' + m[0].toUpperCase() + m.slice(1)), m);
});

test('manifest：每个命令都有 cmd.* 文案和两种语言的 _locales 说明，预设快捷键不超过 4 个', () => {
  const I = require('../i18n.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const locales = ['en', 'zh_CN'].map((loc) => JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', loc, 'messages.json'), 'utf8')));
  for (const [name, c] of Object.entries(manifest.commands)) {
    for (const lang of ['zh', 'en']) assert.ok(I.DICT[lang]['cmd.' + name], lang + ' cmd.' + name);
    const m = /^__MSG_(\w+)__$/.exec(c.description || '');
    assert.ok(m, name + ' 的说明走 _locales');
    for (const msgs of locales) assert.ok(msgs[m[1]] && msgs[m[1]].message, m[1]);
  }
  for (const k of ['cmdPeek', 'cmdNextProfile', 'cmdNvUndo']) for (const msgs of locales) assert.ok(msgs[k], k);
  assert.ok(Object.values(manifest.commands).filter((c) => c.suggested_key).length <= 4);
});

test('content.js 报告里的字段都经过 background 的 sanitizeReport', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const body = /function buildReport\(\) \{[\s\S]*?\n {2}\}/.exec(content);
  assert.ok(body, '找到 buildReport');
  const m = /const r = \{([\s\S]*?)\n {4}\};/.exec(body[0]);
  assert.ok(m, '找到 buildReport 里的 r');
  const fields = Array.from(m[1].matchAll(/^ {6}(\w+):/gm), (x) => x[1]).filter((f) => f !== 'type');
  assert.ok(fields.length > 10, fields.join());
  // 字面量之后补上的字段（比如只由顶层 frame 发的）同样要经过 sanitizeReport
  const later = Array.from(body[0].matchAll(/\br\.(\w+)\s*=(?!=)/g), (x) => x[1]);
  assert.ok(later.indexOf('timeOrigin') >= 0, '扫得到字面量之后补上的字段');
  // background 在 sanitizeReport 之外单独读的字段：handleReport 用 timeOrigin 识别顶层文档
  const OUTSIDE = ['timeOrigin'];
  for (const f of OUTSIDE) assert.ok(new RegExp('\\bmsg\\.' + f + '\\b').test(bg), 'background 读取 ' + f);
  const s = /function sanitizeReport\([\s\S]*?\n\}/.exec(bg);
  assert.ok(s, '找到 sanitizeReport');
  for (const f of fields.concat(later)) {
    if (OUTSIDE.indexOf(f) >= 0) continue;
    assert.ok(new RegExp('\\bmsg\\.' + f + '\\b').test(s[0]), 'sanitizeReport 缺少 ' + f);
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
