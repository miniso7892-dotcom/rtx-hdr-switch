// 本地组件测试。运行：node native-host/test/host.test.mjs          （只读：不会改任何 NVIDIA 设置）
//                       node native-host/test/host.test.mjs --live   （另加一次可逆写入：中间灰 +1 → 校验 → 恢复）
// 只依赖 node 内置模块；先运行 native-host\build.cmd 生成 rtx_hdr_host.exe。

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = path.join(HERE, '..');
const ROOT = path.join(HOST_DIR, '..');
const EXE = path.join(HOST_DIR, 'rtx_hdr_host.exe');
const HOST_MANIFEST = path.join(HOST_DIR, 'io.github.rtx_hdr_switch.json');
const EXT_ID = 'omgekmljdifpghaimigdbbbcmnjddmdd';
const ORIGIN = `chrome-extension://${EXT_ID}/`;
const LIVE = process.argv.includes('--live');
// NVIDIA 的调试日志：每次 NvCplApiSetSetting 都会记一行，用来证明只读测试真的没写
const UXD_LOG = path.join(process.env.ProgramData || 'C:\\ProgramData', 'NVIDIA Corporation', 'NVIDIA App', 'UXD', 'Log.rtx_hdr_host.exe.log');
const CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

// ---------- 帧与进程 ----------

function frame(body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  return Buffer.concat([h, b]);
}

class HostProc {
  constructor() {
    this.waiters = [];
    this.replies = [];
    this.raw = [];
    this.buf = Buffer.alloc(0);
    this.stderr = '';
    this.p = spawn(EXE, [ORIGIN, '--parent-window=0'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.p.stderr.on('data', d => { this.stderr += d; });
    this.p.stdout.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 4) {
        const n = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + n) break;
        const body = Buffer.from(this.buf.subarray(4, 4 + n));
        this.buf = this.buf.subarray(4 + n);
        this.raw.push(body);
        const msg = JSON.parse(body.toString('utf8'));
        const w = this.waiters.shift();
        if (w) w(msg); else this.replies.push(msg);
      }
    });
    this.exit = new Promise(resolve => this.p.on('exit', code => resolve(code)));
    this.p.stdin.on('error', () => {}); // 进程已退出时写入会 EPIPE，测试自己判断
  }
  send(body) { this.p.stdin.write(frame(body)); }
  writeRaw(buf) { this.p.stdin.write(buf); }
  next(ms = 10000) {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no reply within ' + ms + ' ms; stderr: ' + this.stderr)), ms);
      this.waiters.push(m => { clearTimeout(t); resolve(m); });
    });
  }
  async call(obj) { this.send(obj); return this.next(); }
  async close(ms = 10000) {
    this.p.stdin.end();
    return withTimeout(this.exit, ms, 'host did not exit after stdin EOF');
  }
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(what)), ms); })])
    .finally(() => clearTimeout(t));
}

async function once(obj) {
  const h = new HostProc();
  try { return await h.call(obj); } finally { await h.close(); }
}

// t0 之后本 exe 调过几次 NvCplApiSetSetting（日志会轮转到 .log1，所以两份都看，按行首的本地时间过滤）
function uxdSetsSince(t0) {
  let found = false;
  let n = 0;
  for (const f of [UXD_LOG, UXD_LOG + '1']) {
    let text;
    try { text = fs.readFileSync(f, 'latin1'); } catch { continue; }
    found = true;
    for (const line of text.split('\n')) {
      if (!line.includes('NvCplApiSetSetting')) continue;
      const t = new Date(line.slice(0, 23).replace(' ', 'T')).getTime(); // 无时区 → 按本地时间解析
      if (!(t < t0)) n++;
    }
  }
  return found ? n : null;
}

// 返回 { '<子键>\\<值名>': 数值 }，只读
function regTrueHdrM() {
  let out;
  try {
    out = execFileSync('reg', ['query', CLASS_KEY, '/s', '/f', '_VAL_TrueHDR_M'], { encoding: 'latin1', windowsHide: true });
  } catch { return null; }
  const r = {};
  let key = '';
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) key = line.split('\\').pop();
    const m = line.match(/^\s+(_User_\S+_VAL_TrueHDR_M)\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) r[key + '\\' + m[1]] = parseInt(m[2], 16);
  }
  return Object.keys(r).length ? r : null;
}

// 与可变的实时字段（HDR 是否正在工作、超分当前档位）无关的部分
function stable(s) {
  return {
    hdr: { ...s.hdr, active: undefined },
    vsr: { ...s.vsr, level: undefined },
    indicator: s.indicator,
    flags: s.flags,
  };
}

function checkState(s) {
  assert.equal(typeof s, 'object');
  const h = s.hdr, v = s.vsr;
  for (const k of ['supported', 'enabled', 'active']) assert.equal(typeof h[k], 'boolean', 'hdr.' + k);
  for (const k of ['error', 'peak', 'peakMin', 'peakMax', 'middleGrey', 'contrast', 'saturation']) assert.ok(Number.isInteger(h[k]), 'hdr.' + k);
  assert.ok(h.error >= 0, 'hdr.error');
  assert.ok(h.peakMin <= h.peakMax, 'peakMin <= peakMax');
  if (h.supported) {
    assert.ok(h.peak >= h.peakMin && h.peak <= h.peakMax, 'peak in range');
    assert.ok(h.middleGrey >= 10 && h.middleGrey <= 100, 'middleGrey 10..100');
    assert.ok(h.contrast >= -100 && h.contrast <= 100, 'contrast');
    assert.ok(h.saturation >= -100 && h.saturation <= 100, 'saturation');
  }
  assert.equal(typeof v.supported, 'boolean');
  assert.ok(Number.isInteger(v.mode) && v.mode >= 0 && v.mode <= 5, 'vsr.mode');
  assert.ok(v.level === null || (Number.isInteger(v.level) && v.level >= 0 && v.level <= 4), 'vsr.level');
  assert.ok(v.priority === null || [0, 1, 2].includes(v.priority), 'vsr.priority');
  assert.ok(s.flags === null || Number.isInteger(s.flags), 'flags');
  if (s.flags !== null) assert.equal(s.indicator, (s.flags & 0x101) !== 0, 'indicator == flags & 0x101');
  else assert.equal(s.indicator, null);
  assert.deepEqual(Object.keys(s).sort(), ['flags', 'hdr', 'indicator', 'vsr']);
}

// ---------- 测试 ----------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('rtx_hdr_host.exe 是 x64 控制台程序', () => {
  const b = fs.readFileSync(EXE);
  const pe = b.readUInt32LE(0x3c);
  assert.equal(b.toString('latin1', pe, pe + 4), 'PE\0\0');
  assert.equal(b.readUInt16LE(pe + 4), 0x8664, 'machine x64');
  assert.equal(b.readUInt16LE(pe + 24 + 68), 3, 'subsystem = console');
});

test('host 清单：名称、路径、来源与扩展 key 一致', () => {
  const m = JSON.parse(fs.readFileSync(HOST_MANIFEST, 'utf8'));
  assert.equal(m.name, 'io.github.rtx_hdr_switch');
  assert.match(m.name, /^[a-z0-9_]+(\.[a-z0-9_]+)*$/);
  assert.equal(m.type, 'stdio');
  assert.equal(m.path, 'rtx_hdr_host.exe');
  assert.ok(fs.existsSync(path.join(HOST_DIR, m.path)), 'path 相对清单目录存在');
  assert.deepEqual(m.allowed_origins, [ORIGIN]);
  const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (ext.key) { // 扩展 ID = sha256(DER 公钥) 前 16 字节，0-f 映射到 a-p
    const hex = crypto.createHash('sha256').update(Buffer.from(ext.key, 'base64')).digest('hex').slice(0, 32);
    assert.equal([...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''), EXT_ID);
  }
});

test('帧：往返、id 原样返回、回复无 BOM 且长度正确', async () => {
  const h = new HostProc();
  try {
    const ids = [1, 'a\nb 中文 é', { nested: [1, 2] }, 0, ''];
    for (const id of ids) {
      const r = await h.call({ cmd: 'hello', id });
      assert.deepEqual(r.id, id);
      assert.equal(r.ok, true);
    }
    const r = await h.call({ cmd: 'hello' });
    assert.equal('id' in r, false, '没有 id 就不回 id');
    for (const body of h.raw) {
      assert.notEqual(body[0], 0xef, 'no BOM');
      assert.doesNotThrow(() => JSON.parse(body.toString('utf8')));
    }
  } finally {
    assert.equal(await h.close(), 0);
  }
});

test('hello 形状', async () => {
  const r = await once({ cmd: 'hello', id: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.id, 7);
  assert.equal(r.host, 'rtx_hdr_host');
  assert.equal(r.version, '1.1.0');
  assert.equal(r.protocol, 1);
  assert.ok(r.dll === null || /nvcpl\.dll$/i.test(r.dll), 'dll');
  console.log('        dll: ' + r.dll);
});

test('get 形状', async () => {
  const r = await once({ cmd: 'get', id: 'g' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.id, 'g');
  checkState(r.state);
  console.log('        state: ' + JSON.stringify(r.state));
});

test('坏请求：非法 JSON / 非对象 / 非法 UTF-8 → bad-request，进程继续工作', async () => {
  const h = new HostProc();
  try {
    const bodies = ['{bad', '', '[1,2]', 'null', '42', '"str"', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])];
    for (const b of bodies) {
      h.send(b);
      const r = await h.next();
      assert.equal(r.ok, false, String(b));
      assert.equal(r.error.code, 'bad-request', String(b));
      assert.equal('id' in r, false);
    }
    assert.equal((await h.call({ cmd: 'hello' })).ok, true, '之后仍可用');
  } finally {
    assert.equal(await h.close(), 0);
  }
});

test('未知或缺少 cmd → bad-request，id 原样返回', async () => {
  const h = new HostProc();
  try {
    for (const req of [{ cmd: 'nope', id: 3 }, { id: 4 }, { cmd: 5, id: 5 }, { cmd: 'GET', id: 6 }]) {
      const r = await h.call(req);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'bad-request');
      assert.equal(r.id, req.id);
    }
  } finally {
    assert.equal(await h.close(), 0);
  }
});

test('range：每个坏字段都让整单被拒，且什么都没写', async () => {
  const h = new HostProc();
  try {
    const before = (await h.call({ cmd: 'get' })).state;
    const t0 = Date.now() - 1000; // 日志时间只到毫秒且可能略有偏差，往前留 1 秒
    // 其余字段都填当前值：就算校验有漏洞，写下去也不会改变用户设置
    const cur = {
      hdr: { enabled: before.hdr.enabled, peak: before.hdr.peak, middleGrey: before.hdr.middleGrey, contrast: before.hdr.contrast, saturation: before.hdr.saturation },
      vsr: { mode: before.vsr.mode, priority: before.vsr.priority === null ? undefined : before.vsr.priority },
      indicator: before.indicator === null ? undefined : before.indicator,
    };
    const bad = [
      ['hdr.enabled', { hdr: { enabled: 1 } }], ['hdr.enabled', { hdr: { enabled: 'true' } }],
      ['hdr.peak', { hdr: { peak: before.hdr.peakMin - 1 } }], ['hdr.peak', { hdr: { peak: before.hdr.peakMax + 1 } }],
      ['hdr.peak', { hdr: { peak: 1000.5 } }], ['hdr.peak', { hdr: { peak: '1000' } }], ['hdr.peak', { hdr: { peak: 2 ** 40 } }],
      ['hdr.middleGrey', { hdr: { middleGrey: 9 } }], ['hdr.middleGrey', { hdr: { middleGrey: 101 } }], ['hdr.middleGrey', { hdr: { middleGrey: 50.5 } }],
      ['hdr.contrast', { hdr: { contrast: -101 } }], ['hdr.contrast', { hdr: { contrast: 101 } }], ['hdr.contrast', { hdr: { contrast: [] } }],
      ['hdr.saturation', { hdr: { saturation: -101 } }], ['hdr.saturation', { hdr: { saturation: 101 } }],
      ['vsr.mode', { vsr: { mode: -1 } }], ['vsr.mode', { vsr: { mode: 6 } }], ['vsr.mode', { vsr: { mode: '5' } }],
      ['vsr.priority', { vsr: { priority: -1 } }], ['vsr.priority', { vsr: { priority: 3 } }], ['vsr.priority', { vsr: { priority: true } }],
      ['indicator', { indicator: 1 }], ['indicator', { indicator: 'yes' }],
      ['commit', { commit: 'yes' }],
      ['hdr', { hdr: 5 }], ['vsr', { vsr: [1] }],
    ];
    const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    for (const [field, patch] of bad) {
      // 当前值 + 一个坏字段（对象就合并，其它类型直接替换）
      const req = { cmd: 'set', id: field, commit: true, hdr: { ...cur.hdr }, vsr: { ...cur.vsr }, indicator: cur.indicator };
      for (const [k, v] of Object.entries(patch)) req[k] = isObj(v) && isObj(req[k]) ? { ...req[k], ...v } : v;
      const r = await h.call(req);
      assert.equal(r.ok, false, field + ' ' + JSON.stringify(patch));
      assert.equal(r.error.code, 'range', field + ' ' + JSON.stringify(r.error));
      assert.equal(r.error.field, field, JSON.stringify(patch));
      assert.equal(r.id, field);
    }
    const after = (await once({ cmd: 'get' })).state; // 新进程重新读
    assert.deepEqual(stable(after), stable(before), '状态没变');
    const sets = uxdSetsSince(t0);
    if (sets !== null) assert.equal(sets, 0, 'NVIDIA 日志里出现了新的 NvCplApiSetSetting');
    console.log(`        ${bad.length} 个坏请求全部被拒；` + (sets === null ? '（无 NVIDIA 调试日志，仅比对状态）' : `NVIDIA 日志里本测试期间的 SetSetting 调用：${sets} 次`));
  } finally {
    assert.equal(await h.close(), 0);
  }
});

test('300 次连续 get（同一进程，流水线）', async () => {
  const h = new HostProc();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) h.send({ cmd: 'get', id: i });
    for (let i = 0; i < 300; i++) {
      const r = await h.next(30000);
      assert.equal(r.id, i, 'order');
      assert.equal(r.ok, true, JSON.stringify(r.error));
    }
    console.log(`        300 replies in ${Date.now() - t0} ms`);
  } finally {
    assert.equal(await h.close(), 0);
  }
});

test('stdin EOF → 退出码 0；坏长度头 / 截断帧 → 非 0 退出，不挂起', async () => {
  const a = new HostProc();
  assert.equal(await a.close(), 0);
  const b = new HostProc();
  const big = Buffer.alloc(4); big.writeUInt32LE(0x7fffffff);
  b.writeRaw(big);
  assert.notEqual(await withTimeout(b.exit, 10000, 'bad length: no exit'), 0);
  const c = new HostProc();
  const part = Buffer.alloc(4); part.writeUInt32LE(100);
  c.writeRaw(Buffer.concat([part, Buffer.from('{"cmd"')]));
  assert.notEqual(await c.close(), 0);
});

// ---------- --live：可逆写入 ----------

if (LIVE) {
  test('live：中间灰 +1 → 回复/新进程/注册表都变 → 恢复并核对', async () => {
    const before = (await once({ cmd: 'get' })).state;
    checkState(before);
    if (!before.hdr.supported || before.hdr.error !== 0) {
      console.log('        跳过：RTX Video HDR 当前不可用（supported=' + before.hdr.supported + ', error=' + before.hdr.error + '）');
      return;
    }
    const tLive = Date.now() - 1000;
    const mg0 = before.hdr.middleGrey;
    const mg1 = mg0 < 100 ? mg0 + 1 : mg0 - 1;
    const reg0 = regTrueHdrM();
    let restored = false;
    try {
      const w = await once({ cmd: 'set', hdr: { middleGrey: mg1 }, commit: true });
      assert.equal(w.ok, true, JSON.stringify(w.error));
      assert.equal(w.state.hdr.middleGrey, mg1, '回复里的新值');
      assert.deepEqual(stable({ ...w.state, hdr: { ...w.state.hdr, middleGrey: mg0 } }), stable(before), '其它字段不变');
      const fresh = (await once({ cmd: 'get' })).state;
      assert.equal(fresh.hdr.middleGrey, mg1, '新进程读到新值');
      const reg1 = regTrueHdrM();
      if (reg1) {
        for (const [k, v] of Object.entries(reg1)) assert.equal(v, mg1, '注册表 ' + k);
        console.log('        注册表：' + JSON.stringify(reg0) + ' → ' + JSON.stringify(reg1));
      } else {
        console.log('        （没找到 _VAL_TrueHDR_M 注册表值，跳过注册表核对）');
      }
    } finally {
      await once({ cmd: 'set', hdr: { middleGrey: mg0 }, commit: true });
      let after = (await once({ cmd: 'get' })).state;
      if (!isDeepStrictEqual(stable(after), stable(before))) {
        // 兜底：按测试前读到的完整状态写回 0x318 / 0x317 / 0x32F / 0x330。
        // indicator 会把 0x1 和 0x100 一起置位或清零：测试前只开了其中一位时用它写回会改动测试没碰过的那一位，
        // 这种情况不写 0x330，留给下面的「恢复失败」报告和备份文件，人工处理
        const bits = before.flags === null ? null : before.flags & 0x101;
        const full = { cmd: 'set', commit: true,
          hdr: { enabled: before.hdr.enabled, peak: before.hdr.peak, middleGrey: mg0, contrast: before.hdr.contrast, saturation: before.hdr.saturation },
          vsr: { mode: before.vsr.mode, priority: before.vsr.priority === null ? undefined : before.vsr.priority },
          indicator: bits === 0 || bits === 0x101 ? before.indicator : undefined };
        await once(full);
        after = (await once({ cmd: 'get' })).state;
      }
      restored = isDeepStrictEqual(stable(after), stable(before));
      if (!restored) {
        const backup = path.join(os.tmpdir(), 'rtx_hdr_host_live_backup.json');
        fs.writeFileSync(backup, JSON.stringify(before, null, 2));
        console.log('        !!! 恢复失败。测试前的状态：' + JSON.stringify(before) + '（已存到 ' + backup + '）');
      }
    }
    assert.ok(restored, '已恢复');
    const after = (await once({ cmd: 'get' })).state;
    assert.deepEqual(stable(after), stable(before), '恢复后与测试前完全一致');
    const reg2 = regTrueHdrM();
    if (reg0 && reg2) assert.deepEqual(reg2, reg0, '注册表恢复');
    const sets = uxdSetsSince(tLive); // 反向对照：证明只读测试用的日志检测确实能看到写入
    if (sets !== null) assert.ok(sets >= 2, 'NVIDIA 日志应记录到 2 次 SetSetting，实际 ' + sets);
    console.log('        已恢复：middleGrey ' + mg0 + ' → ' + mg1 + ' → ' + after.hdr.middleGrey +
      (sets === null ? '' : '；NVIDIA 日志记录到 SetSetting ' + sets + ' 次'));
  });
}

// ---------- 运行 ----------

if (!fs.existsSync(EXE)) {
  console.log('找不到 ' + EXE + '，请先运行 native-host\\build.cmd');
  process.exit(1);
}
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log('  ok    ' + t.name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + t.name);
    console.log('        ' + String(e && e.stack || e).split('\n').join('\n        '));
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total` + (LIVE ? ' (live)' : ''));
process.exitCode = failed ? 1 : 0;
