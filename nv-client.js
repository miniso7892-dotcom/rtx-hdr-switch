/* RTX HDR 开关 —— NVIDIA 设置客户端（弹窗和播放器面板共用）：连接本地组件、定时读取、乐观写入 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  // 这些错误说明本地组件或 NVIDIA App 用不了，不再轮询
  const FATAL = new Set(['host-missing', 'host-forbidden', 'no-dll', 'init', 'protocol']);
  const DEFAULTS = {
    pollMs: 2000,
    throttleMs: 200, // 和 NVIDIA App 拖动滑块时一样
    // 下拉框：键盘在收起的下拉框上按方向键时每一步都触发 change，停这么久没再变才写入
    debounceMs: 500,
    timeoutMs: 8000,
    maxPortFails: 3
  };

  function noop() {}

  function call(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  /**
   * opts:
   *   onChange()            状态、连接情况或拖动状态变了（重画界面）
   *   onError(error)        接口偶尔出错、写入校验不过：只提示，不换掉整块界面
   *   beforeSet(patch)      每次 set 发出前调用，可以返回 Promise（比如先让 background 放开借用）
   *   log                   自己端口上提交的写入发 nv-log 补记进修改记录（经 background 桥的由 background 自己记）
   *   pollMs / throttleMs / debounceMs / timeoutMs / maxPortFails
   */
  function create(opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const onChange = typeof o.onChange === 'function' ? o.onChange : noop;
    const onError = typeof o.onError === 'function' ? o.onError : noop;

    const c = {
      mode: 'connecting', // connecting | missing | error | ready
      error: null,
      state: null, // 最近读到的 State，叠加了还没确认的乐观修改
      caps: { display: false, hdrLease: false },
      drag: null // {id, start, moved}：正在拖的滑块
    };
    let confirmed = null; // 本地组件最近一次回的 State（不含乐观修改）：修改记录的「改前」
    let link = null; // {port, waiters}：页面开着时常驻的本地组件进程
    let seq = 0;
    let portFails = 0;
    let useBridge = false; // 端口用不了时改走 background（共用它的本地组件进程）
    let draft = null; // 节流期间攒着还没发的修改
    let queued = null; // 等在途的 set 回来后再发的修改
    let draftDone = []; // 随 draft / queued 一起走的回调：写完（或失败）后调用
    let queuedDone = [];
    let writing = false;
    let ops = 0; // 正在等的 background 写入（套用预设、全局 HDR 开关等）：期间自己的写入暂停
    let throttle = 0;
    let epoch = 0; // 每次写入 +1，丢弃写入前发出的读取结果
    let polling = false;
    let pollTimer = 0;
    let idleWaiters = [];
    let logBase = null; // 这一串写入开始前的 State
    let logPatch = null; // 这一串写入在自己端口上发过的修改（提交时补记一条）
    let inflight = null; // 在途的 set 的补丁（页面关闭时它的回复收不到，见 flushNow）
    let closed = false; // flushNow 之后迟到的回复不再补记（已记成未确认）

    function openLink() {
      let port;
      try { port = chrome.runtime.connectNative(L.NV_HOST); } catch (e) { return null; }
      const l = { port: port, waiters: [] };
      port.onMessage.addListener((res) => {
        if (!res || typeof res !== 'object') return;
        // 按 id 对应；本地组件没回 id 时按顺序。已超时的请求的迟到回复直接丢掉
        const i = res.id == null ? 0 : l.waiters.findIndex((w) => w.id === res.id);
        if (i < 0 || !l.waiters.length) return;
        l.waiters.splice(i, 1)[0].done(res);
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError; // 没安装本地组件时是 "Specified native messaging host not found."
        if (link === l) link = null;
        const fail = L.nvPortError(err && err.message);
        for (const w of l.waiters.splice(0)) w.done(fail);
      });
      return l;
    }

    function bridge(msg) {
      const payload = Object.assign({}, msg);
      delete payload.cmd;
      return call(() => chrome.runtime.sendMessage({ type: 'nv', op: msg.cmd, payload: payload })).then(
        (r) => (r && typeof r === 'object' ? r : { ok: false, error: { code: 'host-error' } }),
        (e) => L.nvPortError((e && e.message) || 'error'));
    }

    // 先用自己的端口（本地组件常驻，拖动滑块延迟低，页面关掉端口随之关闭）；
    // 端口连续断开 maxPortFails 次就改走 background。回复 {res, port: 是否走的自己的端口}
    function send(msg) {
      if (!useBridge && !link) {
        link = openLink();
        if (!link) useBridge = true;
      }
      if (useBridge) return bridge(msg).then((res) => ({ res: res, port: false }));
      const l = link;
      const id = ++seq;
      return new Promise((resolve) => {
        const w = { id: id, done: null };
        const timer = setTimeout(() => {
          const i = l.waiters.indexOf(w);
          if (i >= 0) l.waiters.splice(i, 1);
          resolve({ ok: false, error: { code: 'timeout' } });
        }, o.timeoutMs);
        w.done = (res) => {
          clearTimeout(timer);
          resolve(res);
        };
        l.waiters.push(w);
        try {
          l.port.postMessage(Object.assign({ id: id }, msg));
        } catch (e) {
          const i = l.waiters.indexOf(w);
          if (i >= 0) l.waiters.splice(i, 1);
          w.done(L.nvPortError((e && e.message) || 'error'));
        }
      }).then((res) => {
        const code = res && res.error && res.error.code;
        if (res && res.ok === true) portFails = 0;
        else if ((code === 'host-exit' || code === 'host-error') && ++portFails >= o.maxPortFails) useBridge = true;
        return { res: res, port: true };
      });
    }

    function request(msg) {
      return send(msg).then((x) => x.res);
    }

    function busy() {
      return writing || ops > 0 || !!queued || !!draft || !!c.drag;
    }

    function stopPolling() {
      clearInterval(pollTimer);
      pollTimer = 0;
    }

    function accept(state) {
      const st = L.nvNormState(state);
      if (!st) return;
      confirmed = st;
      c.state = st;
      c.mode = 'ready';
      c.error = null;
      onChange();
    }

    // 本地组件没装、NVIDIA App 缺失等：整块换成说明；接口偶尔出错：保留上次的状态，只提示一下
    function failed(res) {
      const err = (res && res.error) || { code: 'host-error' };
      if (err.code === 'host-missing') {
        c.mode = 'missing';
      } else if (FATAL.has(err.code) || !c.state) {
        c.mode = 'error';
      } else {
        onError(err);
        return;
      }
      c.error = err;
      if (FATAL.has(err.code)) stopPolling();
      onChange();
    }

    function dead() {
      return c.mode === 'missing' || (!!c.error && FATAL.has(c.error.code));
    }

    async function poll() {
      if (polling || busy() || c.mode === 'missing') return;
      polling = true;
      const startEpoch = epoch;
      try {
        const res = await request({ cmd: 'get' });
        if (startEpoch !== epoch || busy()) return; // 读的时候用户改过了：这份是旧的
        if (res && res.ok === true && L.nvNormState(res.state)) accept(res.state);
        else failed(res);
      } finally {
        polling = false;
      }
    }

    // hello（协议版本、caps）→ 读一次 → 定时读。本地组件用不了时停在 missing / error
    async function start() {
      onChange();
      const hello = await request({ cmd: 'hello' });
      if (!hello || hello.ok !== true) failed(hello);
      else if (hello.protocol !== L.NV_PROTOCOL) failed({ error: { code: 'protocol' } });
      else {
        const caps = Array.isArray(hello.caps) ? hello.caps : [];
        c.caps = { display: caps.indexOf('display') >= 0, hdrLease: caps.indexOf('hdrLease') >= 0 };
      }
      if (dead()) return;
      await poll();
      if (dead()) return;
      if (!pollTimer) pollTimer = setInterval(poll, o.pollMs);
    }

    function stop() {
      stopPolling();
      clearTimeout(throttle);
      throttle = 0;
      const l = link;
      link = null;
      if (l) {
        try { l.port.disconnect(); } catch (e) { /* 已断开 */ }
        for (const w of l.waiters.splice(0)) w.done({ ok: false, error: { code: 'host-exit' } });
      }
    }

    // 先乐观更新界面；拖动中 throttleMs 节流（commit:false），松手 / 键盘 / 选择时立即发并提交；
    // final 为 'soon'（下拉框）时停 debounceMs 没再变才发并提交，途经的选项不写进驱动。
    // done(res)：这次修改写完（或失败）后调用
    function write(patch, final, done) {
      if (!c.state) return;
      closed = false; // 页面从往返缓存回来后又有新修改
      epoch++;
      c.state = L.nvApplyPatch(c.state, patch);
      draft = L.nvMergePatch(draft, patch);
      if (done) draftDone.push(done);
      if (final === 'soon') {
        draft.commit = true;
        clearTimeout(throttle);
        throttle = setTimeout(throttled, o.debounceMs);
      } else if (final) {
        clearTimeout(throttle);
        throttle = 0;
        draft.commit = true;
        flush();
      } else if (!throttle) {
        throttle = setTimeout(throttled, o.throttleMs);
      }
      onChange();
    }

    // 只改界面上的状态，不写（交给 background 的写入在等回复时先显示用户要的值）
    function local(patch) {
      if (!c.state) return;
      epoch++;
      c.state = L.nvApplyPatch(c.state, patch);
      onChange();
    }

    function throttled() {
      throttle = 0;
      flush();
    }

    function flush() {
      if (!draft) return;
      queued = L.nvMergePatch(queued, draft);
      if (queued.commit !== true) queued.commit = false;
      queuedDone = queuedDone.concat(draftDone);
      draft = null;
      draftDone = [];
      pump();
    }

    function runDone(fns, res) {
      for (const f of fns) {
        try { f(res); } catch (e) { /* ignore */ }
      }
    }

    function settle() {
      if (writing || queued) return;
      const ws = idleWaiters;
      idleWaiters = [];
      for (const f of ws) f();
    }

    // 自己端口上的一串写入（拖动的中间帧 + 松手）提交后补记一条；经 background 桥的由 background 记
    function report(res, error, unconfirmed) {
      const before = logBase;
      const patch = logPatch;
      logBase = null;
      logPatch = null;
      if (!o.log || closed || !before || !patch) return;
      const msg = { type: 'nv-log', before: before, after: null, patch: patch };
      if (error) msg.error = error;
      else if (unconfirmed) msg.unconfirmed = true;
      else msg.after = res.state;
      call(() => chrome.runtime.sendMessage(msg)).catch(noop);
    }

    // 一次只有一个 set 在途；在途期间的修改合并成下一个。background 写入期间暂停
    async function pump() {
      if (writing || ops > 0 || !queued) return settle();
      const v = L.nvValidatePatch(queued, c.state);
      const done = queuedDone;
      queued = null;
      queuedDone = [];
      if (!v.ok) {
        onError(v.error);
        epoch++;
        settle();
        poll(); // 读回真实状态，撤销乐观修改
        runDone(done, v);
        return;
      }
      writing = true;
      let sent = null;
      try {
        if (o.beforeSet) await o.beforeSet(v.patch);
        if (!logBase) logBase = confirmed;
        inflight = v.patch;
        sent = await send(Object.assign({ cmd: 'set' }, v.patch));
      } catch (e) {
        sent = { res: { ok: false, error: { code: 'internal', message: String((e && e.message) || e) } }, port: false };
      } finally {
        writing = false;
        inflight = null;
      }
      const res = sent.res;
      epoch++;
      const ok = res && res.ok === true && L.nvNormState(res.state);
      if (ok) confirmed = L.nvNormState(res.state);
      if (sent.port) {
        logPatch = L.nvMergePatch(logPatch, v.patch);
        // 拖动中间帧失败不单独记：松手提交时连同起点一起记一条
        if (v.patch.commit === true) report(res, ok ? null : (res && res.error) || { code: 'host-error' }, false);
      } else {
        logBase = null;
        logPatch = null;
      }
      if (!ok) failed(res);
      runDone(done, ok ? res : Object.assign({ ok: false, error: { code: 'host-error' } }, res, { ok: false }));
      if (queued) {
        pump();
        return;
      }
      settle();
      if (ok) {
        if (!busy()) accept(res.state); // 以本地组件读回的为准（驱动可能修正了数值）
      } else if (c.mode === 'ready') {
        poll();
      }
    }

    // 手头的修改发完、在途的 set 回来
    function idle() {
      clearTimeout(throttle);
      throttle = 0;
      if (draft) {
        draft.commit = true;
        flush();
      }
      if (!writing && !queued) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    }

    /**
     * 交给 background 的写入（套用预设、全局 HDR 开关、跟随 SDR 等）：先把自己的修改发完，
     * 期间暂停自己的写入和读取，回复里带 State 时以它为准，否则重新读一次。fn() → Promise<回复>
     */
    async function exclusive(fn) {
      await idle();
      ops++;
      epoch++;
      let res;
      try {
        res = await fn();
      } catch (e) {
        res = { ok: false, error: { code: 'internal', message: String((e && e.message) || e) } };
      } finally {
        ops--;
      }
      epoch++;
      const st = res && L.nvNormState(res.state);
      if (st && !busy()) accept(res.state);
      else if (!st && c.mode === 'ready') poll();
      pump();
      return res;
    }

    // 页面关闭前把还没发出去的修改直接发出去：节流 / 防抖中的和排在在途 set 后面的合并成一次。
    // 不等回复（页面关了也收不到）：本地组件按顺序处理同一端口上的请求，
    // 走 background 时它也按队列顺序发；已经发出去的会被本地组件处理完
    function flushNow() {
      clearTimeout(throttle);
      throttle = 0;
      const pending = L.nvMergePatch(queued, draft);
      queued = null;
      draft = null;
      queuedDone = [];
      draftDone = [];
      const own = !useBridge && !!link;
      // 自己端口上已经在途的提交（松手后马上关了页面）也收不到回复：一起算进这条未确认记录
      const late = own && writing && inflight && inflight.commit === true ? inflight : null;
      if (late) logPatch = L.nvMergePatch(logPatch, late);
      let v = null;
      if (pending && c.state) {
        pending.commit = true;
        v = L.nvValidatePatch(pending, c.state);
      }
      try {
        if (v && v.ok) {
          const msg = Object.assign({ cmd: 'set' }, v.patch);
          if (own) {
            if (!logBase) logBase = confirmed;
            logPatch = L.nvMergePatch(logPatch, v.patch);
            link.port.postMessage(Object.assign({ id: ++seq }, msg));
          } else {
            bridge(msg).catch(noop);
          }
        }
        if (own && (late || (v && v.ok))) report(null, null, true); // 收不到回复：记一条「未确认」
      } catch (e) { /* 页面正在关闭 */ }
      closed = true;
    }

    // 拖动：按下记起点，拖动中不拿读到的值覆盖这个滑块，松手后提交
    function dragBegin(id, start) {
      c.drag = { id: id, start: start, moved: false };
    }

    function dragMove(id) {
      if (c.drag && c.drag.id === id) c.drag.moved = true;
    }

    function dragClear(id) {
      if (c.drag && c.drag.id === id) c.drag = null;
    }

    // 松手：返回刚结束的拖动 {id, start, moved}（没在拖时为 null）
    function dragEnd() {
      const d = c.drag;
      c.drag = null;
      return d;
    }

    return Object.assign(c, {
      start: start,
      stop: stop,
      request: request,
      poll: poll,
      write: write,
      local: local,
      exclusive: exclusive,
      flushNow: flushNow,
      failed: failed,
      busy: busy,
      dragBegin: dragBegin,
      dragMove: dragMove,
      dragClear: dragClear,
      dragEnd: dragEnd
    });
  }

  globalThis.RtxHdrNvClient = Object.freeze({ create: create, FATAL: FATAL });
})();
