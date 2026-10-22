/*
 * RTX HDR 开关 —— 选项页：配置档（套用、重命名、删除、导出、从文件导入）和备份（导出 / 导入）。
 * 文件选择框会关掉弹窗，所以放在这个页面里做。配置档和设置都只由 background 写：这里只发消息
 */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const I = globalThis.RtxHdrI18n;
  const $ = (id) => document.getElementById(id);
  const PROFILES_KEY = 'profiles'; // background 写：{v, list, activeId}
  const CONFIRM_MS = 4000; // 「删除」按第一次后等确认的时间

  let uiLanguage = '';
  try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = navigator.language || ''; }
  let lang = 'zh';
  let settings = L.mergeSettings(null);
  let pending = null; // 通过检查、等确认的备份：{data: 文件里的原始对象, res: L.validateBackup 的结果}
  let profiles = L.normProfiles(null); // background 回复的配置档列表
  let renaming = null; // 正在重命名的配置档 id
  let armed = null; // {id, timer}：「删除」按了第一次
  let summaryTimer = 0;
  const msgTimers = {};
  const t = (key, params) => I.t(lang, key, params);

  function call(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  function version() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
  }

  function applyI18n() {
    lang = I.resolve(settings.ui.lang, uiLanguage);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const i = pair.indexOf(':');
        if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      }
    }
    const ink = L.accentInk(settings.ui.accent);
    const st = document.documentElement.style;
    st.setProperty('--accent', ink.accent);
    st.setProperty('--on-accent', ink.on);
    st.setProperty('--accent-fg', ink.fg);
  }

  // 结果提示；配置档区的提示几秒后自己消失（warn 的久一点）
  function message(id, text, warn) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('warn', !!warn);
    clearTimeout(msgTimers[id]);
    if (text && id === 'pf-msg') msgTimers[id] = setTimeout(() => { el.textContent = ''; }, warn ? 8000 : 4000);
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fileStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function download(obj, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------- 配置档 ----------

  function profileMsg(op, extra) {
    return call(() => chrome.runtime.sendMessage(Object.assign({ type: 'profile', op: op }, extra))).then(
      (r) => (r && typeof r === 'object' ? r : { ok: false, code: 'internal' }), () => ({ ok: false, code: 'internal' }));
  }

  function profileError(r) {
    const key = 'profile.err.' + (r && typeof r.code === 'string' ? r.code : '');
    return Object.prototype.hasOwnProperty.call(I.DICT.zh, key) ? t(key) : L.nvErrorText(r && r.error, lang);
  }

  function profilesAccept(r) {
    if (!r || r.ok !== true) return;
    profiles = L.normProfiles(r.profiles);
    if (renaming && !profiles.list.some((p) => p.id === renaming)) renaming = null;
    renderProfiles();
  }

  async function loadProfiles() {
    profilesAccept(await profileMsg('list'));
  }

  function button(text, act, id, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = text;
    b.dataset.id = id;
    b.dataset.act = act;
    b.addEventListener('click', fn);
    return b;
  }

  // 每行：名称、套用、重命名、导出、删除；当前配置档左边一道主题色。重建后焦点回到同一个配置档的同一个按钮
  function renderProfiles() {
    const ul = $('pf-list');
    const f = document.activeElement && ul.contains(document.activeElement) ? document.activeElement : null;
    const keep = f ? [f.dataset.id, f.dataset.act] : null;
    ul.textContent = '';
    $('pf-export-all').disabled = !profiles.list.length;
    for (const p of profiles.list) {
      const li = document.createElement('li');
      if (p.id === profiles.activeId) li.setAttribute('aria-current', 'true');
      if (renaming === p.id) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pf-input';
        input.maxLength = L.NV_NAME_MAX;
        input.value = p.name;
        input.autocomplete = 'off';
        input.dataset.id = p.id;
        input.dataset.act = 'name';
        input.setAttribute('aria-label', t('profile.name'));
        input.addEventListener('keydown', (e) => {
          if (e.isComposing) return; // 输入法选词时的回车不算
          if (e.key === 'Enter') {
            e.preventDefault();
            renameProfile(p, input.value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            stopRename(p);
          }
        });
        li.appendChild(input);
        li.appendChild(button(t('profile.saveOk'), 'save', p.id, () => renameProfile(p, input.value)));
        li.appendChild(button(t('common.cancel'), 'cancel', p.id, () => stopRename(p)));
        ul.appendChild(li);
        continue;
      }
      const name = document.createElement('span');
      name.className = 'pf-name';
      name.id = 'pf-n-' + p.id;
      name.textContent = p.name;
      li.appendChild(name);
      const acts = [
        button(t('profile.apply'), 'apply', p.id, () => applyProfile(p)),
        button(t('profile.rename'), 'rename', p.id, () => startRename(p)),
        button(t('profile.exportOne'), 'export', p.id, () => exportProfiles([p])),
        button(armed && armed.id === p.id ? t('nv.confirmDelete') : t('profile.delete'), 'delete', p.id, () => deleteProfile(p))
      ];
      for (const b of acts) {
        b.setAttribute('aria-describedby', name.id);
        li.appendChild(b);
      }
      ul.appendChild(li);
    }
    if (keep) {
      const again = Array.from(ul.querySelectorAll('button, input')).find((x) => x.dataset.id === keep[0] && x.dataset.act === keep[1]);
      if (again) again.focus();
    }
  }

  function disarm() {
    if (!armed) return;
    clearTimeout(armed.timer);
    armed = null;
    renderProfiles();
  }

  async function applyProfile(p) {
    disarm();
    const r = await profileMsg('apply', { id: p.id });
    if (!r || r.ok !== true) {
      message('pf-msg', profileError(r), true);
      loadProfiles();
      return;
    }
    profilesAccept(r);
    if (r.nvError) message('pf-msg', t('bg.profileNvFailed', { name: r.name, err: L.nvErrorText(r.nvError, lang) }), true);
    else if (r.hdrSkipped) message('pf-msg', t('bg.profilePartial', { name: r.name }), true);
    else message('pf-msg', t('profile.applied', { name: r.name }));
  }

  function startRename(p) {
    disarm();
    renaming = p.id;
    renderProfiles();
    const input = $('pf-list').querySelector('input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function stopRename(p) {
    renaming = null;
    renderProfiles();
    const b = Array.from($('pf-list').querySelectorAll('button')).find((x) => x.dataset.id === p.id && x.dataset.act === 'rename');
    if (b) b.focus();
  }

  async function renameProfile(p, value) {
    const name = L.nvName(value);
    if (!name) {
      message('pf-msg', t('profile.err.name'), true);
      return;
    }
    if (name === p.name) return stopRename(p);
    const r = await profileMsg('rename', { id: p.id, name: name });
    if (!r || r.ok !== true) {
      message('pf-msg', profileError(r), true);
      return;
    }
    renaming = null;
    profilesAccept(r);
    stopRename(p);
    message('pf-msg', t('profile.renamed', { name: name }));
  }

  // 删除不能撤销：第一次只把按钮变成「确认删除？」，4 秒内再按一次才删
  async function deleteProfile(p) {
    if (!armed || armed.id !== p.id) {
      disarm();
      armed = { id: p.id, timer: setTimeout(disarm, CONFIRM_MS) };
      renderProfiles();
      message('pf-msg', t('profile.deleteAsk', { name: p.name }), true);
      return;
    }
    clearTimeout(armed.timer);
    armed = null;
    const r = await profileMsg('delete', { id: p.id });
    if (!r || r.ok !== true) {
      message('pf-msg', profileError(r), true);
      loadProfiles();
      return;
    }
    profilesAccept(r);
    message('pf-msg', t('profile.deleted', { name: p.name }));
    const next = $('pf-list').querySelector('button') || $('pf-export-all');
    if (next && !next.disabled) next.focus();
  }

  function exportProfiles(list) {
    disarm();
    if (!list.length) return;
    const now = new Date();
    const name = 'rtx-hdr-switch-profiles-' + fileStamp(now) + '.json';
    download(L.makeProfilesFile(list, version(), now.getTime()), name);
    message('pf-msg', t('profile.exported', { file: name }));
  }

  // 从文件导入（合并）：这里先检查，background 再规范化一遍，重名的改名
  function onProfileFile(e) {
    const file = e.target.files && e.target.files[0];
    disarm();
    if (!file) return;
    file.text().then(async (text) => {
      e.target.value = '';
      let obj = null;
      try { obj = JSON.parse(text); } catch (err) { obj = null; }
      const v = L.validateProfilesFile(obj);
      if (!v.ok) {
        message('pf-msg', t('profile.err.' + v.code), true);
        return;
      }
      const r = await profileMsg('import', { profiles: v.profiles });
      if (!r || r.ok !== true) {
        message('pf-msg', profileError(r), true);
        return;
      }
      profilesAccept(r);
      const n = r.added.length;
      const renamed = r.added.filter((a) => a.renamed).length;
      let msg = renamed ? t('profile.importedRenamed', { n: n, renamed: renamed }) : t('profile.imported', { n: n });
      if (r.dropped) msg += (lang === 'en' ? '. ' : '；') + t('profile.dropped', { n: r.dropped });
      message('pf-msg', msg, !!r.dropped);
    }, () => message('pf-msg', t('backup.readError'), true));
  }

  // ---------- 备份 ----------

  function backupCounts(b) {
    return {
      videos: Object.keys(b.videos).length,
      presets: b.settings.nv.presets.length,
      sites: Object.keys(b.settings.sites).length,
      profiles: b.profiles ? b.profiles.list.length : 0
    };
  }

  // 现在导出的备份里有什么
  async function renderSummary() {
    const all = await call(() => chrome.storage.local.get(null)).catch(() => null);
    if (!all) return;
    $('backup-summary').textContent = t('backup.summaryProfiles', backupCounts(L.makeBackup(all, version())));
  }

  function scheduleSummary() {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(renderSummary, 300);
  }

  async function doExport() {
    const all = await chrome.storage.local.get(null);
    const now = new Date();
    const backup = L.makeBackup(all, version(), now.getTime());
    const name = 'rtx-hdr-switch-backup-' + fileStamp(now) + '.json';
    download(backup, name);
    message('export-msg', t('backup.exported', { file: name }));
  }

  function showPreview(data, res) {
    pending = { data: data, res: res };
    $('preview').hidden = false;
    // 备份里有配置档时导入会整体替换现有的配置档：摘要里写出数量
    $('preview-summary').textContent = t(res.profiles ? 'backup.summaryProfiles' : 'backup.summary', res.summary);
    let date = res.exportedAt;
    const d = new Date(res.exportedAt);
    if (!isNaN(d.getTime())) date = d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en');
    $('preview-from').textContent = res.exportedAt ? t('backup.from', { date: date, version: res.extensionVersion || '?' }) : '';
    $('btn-confirm').focus();
  }

  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    pending = null;
    $('preview').hidden = true;
    message('import-msg', '');
    if (!file) return;
    file.text().then((text) => {
      let obj = null;
      try { obj = JSON.parse(text); } catch (err) { obj = null; }
      const res = L.validateBackup(obj);
      if (!res.ok) {
        message('import-msg', t(res.code === 'newer' ? 'backup.newer' : 'backup.invalid'), true);
        return;
      }
      showPreview(obj, res);
    }, () => message('import-msg', t('backup.readError'), true));
  }

  // 覆盖：设置和配置档只由 background 写，交给它再检查一遍后整体覆盖（先删掉现有的视频记忆，再写入备份里的设置、记忆和配置档；
  // 时段记录清掉，让定时切换按新预设重新判断）
  async function doImport() {
    const p = pending;
    if (!p) return;
    $('btn-confirm').disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'backup', op: 'import', data: p.data });
      if (!r || r.ok !== true) {
        const code = (r && r.code) || 'error';
        if (code === 'invalid' || code === 'newer') message('import-msg', t(code === 'newer' ? 'backup.newer' : 'backup.invalid'), true);
        else message('import-msg', t('backup.failed', { err: (r && r.message) || code }), true);
        return;
      }
      pending = null;
      $('preview').hidden = true;
      $('file').value = '';
      settings = L.mergeSettings(r.settings);
      applyI18n();
      message('import-msg', t('backup.done'));
    } catch (e) {
      message('import-msg', t('backup.failed', { err: (e && e.message) || '' }), true);
    } finally {
      $('btn-confirm').disabled = false;
    }
  }

  async function init() {
    try {
      const r = await chrome.storage.local.get('settings');
      settings = L.mergeSettings(r && r.settings);
    } catch (e) { /* 用默认值 */ }
    applyI18n();
    $('btn-export').addEventListener('click', () => {
      doExport().catch((e) => message('export-msg', (e && e.message) || 'error', true));
    });
    $('file').addEventListener('change', onFile);
    $('btn-confirm').addEventListener('click', doImport);
    $('pf-export-all').addEventListener('click', () => exportProfiles(profiles.list));
    $('pf-file').addEventListener('change', onProfileFile);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.settings) {
          settings = L.mergeSettings(changes.settings.newValue);
          applyI18n();
          renderProfiles();
        }
        if (changes[PROFILES_KEY]) loadProfiles();
        scheduleSummary();
      });
    } catch (e) { /* ignore */ }
    renderSummary();
    await loadProfiles();
    // 从弹窗的「导出备份」「导入备份」进来时把焦点放到对应的按钮上
    const target = location.hash === '#import' ? $('file') : location.hash === '#export' ? $('btn-export') : null;
    if (target) {
      target.closest('section').scrollIntoView({ block: 'start' });
      target.focus();
    }
  }

  init();
})();
