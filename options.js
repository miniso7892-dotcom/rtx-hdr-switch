/* RTX HDR 开关 —— 选项页：导出 / 导入备份（文件选择框会关掉弹窗，所以放在这个页面里做） */
(() => {
  'use strict';

  const L = globalThis.RtxHdrLib;
  const I = globalThis.RtxHdrI18n;
  const $ = (id) => document.getElementById(id);

  let uiLanguage = '';
  try { uiLanguage = chrome.i18n.getUILanguage(); } catch (e) { uiLanguage = navigator.language || ''; }
  let lang = 'zh';
  let pending = null; // 通过检查、等确认的备份：{data: 文件里的原始对象, res: L.validateBackup 的结果}
  const t = (key, params) => I.t(lang, key, params);

  function applyI18n(settings) {
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

  function message(id, text, warn) {
    const el = $(id);
    el.textContent = text || '';
    el.classList.toggle('warn', !!warn);
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fileStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  async function doExport() {
    const all = await chrome.storage.local.get(null);
    const now = new Date();
    const backup = L.makeBackup(all, chrome.runtime.getManifest().version, now.getTime());
    const name = 'rtx-hdr-switch-backup-' + fileStamp(now) + '.json';
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
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

  // 覆盖：设置只由 background 写，交给它再检查一遍后整体覆盖（先删掉现有的视频记忆，再写入备份里的设置和记忆；
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
      applyI18n(L.mergeSettings(r.settings));
      message('import-msg', t('backup.done'));
    } catch (e) {
      message('import-msg', t('backup.failed', { err: (e && e.message) || '' }), true);
    } finally {
      $('btn-confirm').disabled = false;
    }
  }

  async function init() {
    let settings = L.mergeSettings(null);
    try {
      const r = await chrome.storage.local.get('settings');
      settings = L.mergeSettings(r && r.settings);
    } catch (e) { /* 用默认值 */ }
    applyI18n(settings);
    $('btn-export').addEventListener('click', () => {
      doExport().catch((e) => message('export-msg', (e && e.message) || 'error', true));
    });
    $('file').addEventListener('change', onFile);
    $('btn-confirm').addEventListener('click', doImport);
    // 从弹窗的「导出备份」「导入备份」进来时把焦点放到对应的按钮上
    const target = location.hash === '#import' ? $('file') : location.hash === '#export' ? $('btn-export') : null;
    if (target) {
      target.closest('section').scrollIntoView({ block: 'start' });
      target.focus();
    }
  }

  init();
})();
