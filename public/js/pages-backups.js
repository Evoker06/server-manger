// Страница «Резервные копии».

/* ---------- backup ---------- */
const BK_TAG = { pre: 'страховочная (перед восстановлением)' };
function bkRows(list, opt) {
  return list.map(b => `<tr><td><b>${esc(fmtDate(b.modified))}</b><br><code>${esc(b.name)}</code></td>${opt.app ? '' : `<td>${esc(((appCache.find(a => a.id === b.app_id) || {}).name) || (b.app_id ? '#' + b.app_id : '—'))}</td>`}<td>${fmtSize(b.size)}</td><td>${esc(BK_TAG[b.tag] || 'обычная')}</td><td class=rowact><button class=btn onclick="bkDownload(${jsArg(b.name)})">Скачать</button>${b.app_id && can('backups.restore') ? `<button class=btn ${opt.running ? 'disabled title="Сначала остановите приложение"' : ''} onclick="bkRestore(${b.app_id},${jsArg(b.name)})">Восстановить</button>` : ''}${can('backups.delete') ? `<button class="btn bad" onclick="deleteBackup(${jsArg(b.name)},${opt.app || 0})">Удалить</button>` : ''}</td></tr>`).join('');
}
async function backups() {
  const [d] = await Promise.all([api('/backups'), api('/apps').then(a => appCache = a)]);
  $('content').innerHTML = toolbar(`<span class=hint>Копии хранятся в storage/backups. Создавать их удобнее во вкладке «Backup» нужного проекта.</span>${can('tasks.manage') ? `<button class=btn onclick="taskForm(0,{action:'backup'})">⏱ Настроить расписание</button>` : ''}`) +
    `<table class=table><tr><th>Копия</th><th>Приложение</th><th>Размер</th><th>Тип</th><th></th></tr>${bkRows(d, {}) || '<tr><td colspan=5 class=muted>Копий пока нет.</td></tr>'}</table>`;
}
async function bkTab(id, a) {
  const d = await api('/backups?app=' + id);
  return `<div class=toolbar>${can('backups.create') ? `<button class=primary id=bkbtn onclick="backup(${id})">+ Создать backup</button>` : ''}${can('tasks.manage') ? `<button class=btn onclick="taskForm(0,{action:'backup',app_id:${id}})">⏱ По расписанию…</button>` : ''}<button class=btn onclick="appWorkspace(${id},'backups')">↻</button></div>
  <div class=hint style="margin-bottom:14px">Копируется вся рабочая папка проекта (<code>${esc(a.working_dir)}</code>). ${a.running ? 'Приложение запущено — для Minecraft перед копированием выполняется <code>save-all</code>, поэтому создание может занять до минуты. ' : ''}Файлы, занятые другим процессом, пропускаются. Перед восстановлением панель автоматически делает страховочную копию текущего состояния.</div>
  <div id=bkmsg></div><table class=table><tr><th>Копия</th><th>Размер</th><th>Тип</th><th></th></tr>${bkRows(d, { app: id, running: a.running }) || '<tr><td colspan=4 class=muted>Копий этого проекта пока нет.</td></tr>'}</table>`;
}
async function backup(id) {
  const b = $('bkbtn');
  if (b) {
    b.disabled = true;
    b.textContent = 'Создаётся…';
  }
  try {
    const d = await api('/apps/' + id + '/backup', { method: 'POST', headers: JH, body: '{}' });
    toast(`Backup создан: ${fmtSize(d.size)}` + (d.skipped && d.skipped.length ? `, пропущено файлов: ${d.skipped.length}` : ''));
    if (String(currentPage).startsWith('app:'))
      appWorkspace(id, 'backups');
    else if (currentPage === 'backups')
      backups();
  }
  catch (e) {
    alert('Не удалось создать backup: ' + e.message);
    if (b) {
      b.disabled = false;
      b.textContent = '+ Создать backup';
    }
  }
}
async function bkRestore(appId, name) {
  if (!confirm(`Восстановить проект из копии?\n\n${name}\n\nФайлы из копии заменят текущие (файлы, которых нет в копии, останутся). Перед этим будет создана страховочная копия текущего состояния.`))
    return;
  try {
    const r = await api(`/apps/${appId}/restore`, { method: 'POST', headers: JH, body: JSON.stringify({ name }) });
    toast('Восстановлено. Страховочная копия: ' + r.safety);
    if (String(currentPage).startsWith('app:'))
      appWorkspace(appId, 'backups');
    else
      backups();
  }
  catch (e) {
    alert(e.message);
  }
}
function bkDownload(name) {
  downloadByTicket({ backup: name });
}
async function deleteBackup(n, appId) {
  if (!confirm('Удалить backup?'))
    return;
  try {
    await api('/backups/' + encodeURIComponent(n), { method: 'DELETE' });
    if (appId)
      appWorkspace(appId, 'backups');
    else
      backups();
  }
  catch (e) {
    alert(e.message);
  }
}
