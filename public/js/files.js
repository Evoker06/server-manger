// Файловый менеджер.
//  • Список и «плитки», хлебные крошки, сортировка (на сервере), поиск, выделение (клик, Ctrl, Shift, Ctrl+A), контекстное меню.
//  • Создание, переименование, копирование, перемещение, удаление (в т.ч. нескольких файлов), распаковка, редактор текста.
//  • Загрузка перетаскиванием (файлы и папки) и кнопками; скачивание файлов, папок и нескольких файлов (ZIP).
//  • «Использовать проект» — создание приложения из папки/файла (project-dialog.js).
// Все действия выполняются на сервере над настоящей файловой системой; права проверяются там же — здесь они лишь скрывают лишние кнопки.
const FM_PAGE_SIZE = 500;
const FM_SEARCH_DELAY_MS = 350;
const FM_TEXT_FILE = /(\.(txt|md|json|ya?ml|xml|properties|cfg|conf|ini|log|js|mjs|cjs|ts|py|sh|bat|cmd|html?|css|csv|toml|env|java|sql|gradle|service|lang|mcmeta|secret)|^(dockerfile|makefile|readme|license))$/i;
const FM_ARCHIVE = /\.(zip|zipx|rar|7z|tar|tgz|txz|tbz2?|tzst|gz|xz|bz2|zst|cab|iso|arj|lzh|lzma|z|cpio|wim)$/i;
const FM_ICONS = [[/\.(zip|rar|7z|tar|gz|tgz|xz|bz2)$/i, '🗜'], [/\.jar$/i, '☕'], [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, '🖼'], [/\.(sh|bat|cmd|exe|ps1)$/i, '▶'], [/\.(log|txt|md)$/i, '📝'], [/\.(json|ya?ml|xml|properties|cfg|conf|ini|toml)$/i, '⚙']];

const fmIcon = entry => (entry.type === 'directory' ? '📁' : (FM_ICONS.find(([pattern]) => pattern.test(entry.name)) || [0, '📄'])[1]);
const fmJoin = (folder, name) => (folder ? folder + '/' : '') + name;
const fmParent = path => path.split('/').slice(0, -1).join('/');
const fmDate = ms => (ms ? new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// Состояние открытого файлового менеджера (одновременно виден только один)
let fm = null;
// Буфер «копировать/вырезать» живёт между открытиями папок
let fmClipboard = null;
let fmDisks = null;

/* =========================== запуск ============================ */

/** Страница «Файлы» (адрес #/files?path=…&disk=…). */
async function files() {
  const params = routeParams || {};
  const scope = {};
  if (params.disk && can('files.disks')) scope.disk = params.disk;
  await mountFileManager('content', { scope, rootLabel: scope.disk || 'Хранилище', path: params.path || '', routed: true });
}

/** Открыть раздел «Файлы» на нужном диске (кнопка на странице «Система»). */
function filesOpenDisk(mount) { page('files', { disk: mount }); }

/** Подключает файловый менеджер к элементу страницы. scope: {} — хранилище, {app: 5} — папка приложения, {disk: 'D:\\'} — диск. */
async function mountFileManager(hostId, { scope = {}, rootLabel = 'Хранилище', path = '', routed = false } = {}) {
  const host = $(hostId);
  if (!host) return;
  fm = {
    host, hostId, scope, rootLabel, path, routed, entries: [], total: 0, loaded: 0, selection: new Set(), anchor: null,
    sort: localStorage.sm_fm_sort || 'name', order: localStorage.sm_fm_order || 'asc', view: localStorage.sm_fm_view || 'list',
    search: '', results: null, requestId: 0, error: '', loading: true,
  };
  host.innerHTML = '<div class=muted>Загрузка…</div>';
  attachFileManagerEvents(host);
  if (can('files.disks') && !scope.app && !fmDisks) {
    try { fmDisks = await api('/hw/disks'); } catch { fmDisks = { disks: [], others: [] }; }
  }
  await fmLoad();
}

const fmScopeQuery = () => [fm.scope.app && 'app=' + fm.scope.app, fm.scope.disk && 'disk=' + encodeURIComponent(fm.scope.disk)].filter(Boolean).join('&');
const fmScopeBody = () => ({ ...(fm.scope.app ? { app: fm.scope.app } : {}), ...(fm.scope.disk ? { disk: fm.scope.disk } : {}) });
const fmEntryKey = entry => entry.path || fmJoin(fm.path, entry.name);
const fmCurrentList = () => (fm.results ? fm.results : fm.entries);

/* =========================== загрузка данных ============================ */

async function fmLoad({ append = false } = {}) {
  // Запрос привязан к ТЕКУЩЕМУ экземпляру менеджера: если пользователь успел открыть другую папку, старый ответ отбрасывается
  const current = fm;
  const requestId = ++current.requestId;
  current.loading = !append;
  current.error = '';
  if (!append) current.selection.clear();
  try {
    const query = [`path=${encodeURIComponent(current.path)}`, `sort=${current.sort}`, `order=${current.order}`, `limit=${FM_PAGE_SIZE}`, `offset=${append ? current.loaded : 0}`, fmScopeQuery()].filter(Boolean).join('&');
    const data = await api('/files?' + query);
    if (current !== fm || requestId !== current.requestId) return;
    const list = Array.isArray(data) ? data : data.entries; // старый агент отдаёт просто массив
    current.entries = append ? current.entries.concat(list) : list;
    current.total = Array.isArray(data) ? list.length : data.total;
    current.loaded = current.entries.length;
  } catch (error) {
    if (current !== fm || requestId !== current.requestId) return;
    current.error = error.message;
  }
  current.loading = false;
  fmRender();
}

let fmSearchTimer = null;
function fmSearchNow() {
  const text = fm.search.trim();
  clearTimeout(fmSearchTimer);
  if (!text) { fm.results = null; fmRender(); return; }
  const current = fm;
  const requestId = ++current.requestId;
  api(`/files/search?path=${encodeURIComponent(current.path)}&q=${encodeURIComponent(text)}&${fmScopeQuery()}`).then(data => {
    if (current !== fm || requestId !== current.requestId) return;
    fm.results = data.results;
    fm.searchNote = data.truncated ? 'Показаны первые результаты — уточните запрос' : `Просмотрено элементов: ${data.scanned}`;
    fm.selection.clear();
    fmRender();
  }).catch(error => toast(error.message, true));
}

/* =========================== отрисовка ============================ */

function fmDiskOptions() {
  if (!fmDisks) return '';
  const partitions = [...(fmDisks.disks || []).flatMap(disk => disk.partitions.map(p => [p, disk.name])), ...(fmDisks.others || []).map(p => [p, 'Сетевой/прочий том'])]
    .filter(([p]) => p.accessible && p.kind !== 'optical' && p.kind !== 'other');
  return `<option value="">📦 Хранилище проектов</option>${partitions.map(([p, name]) => `<option value="${esc(p.mount)}" ${p.mount === fm.scope.disk ? 'selected' : ''}>💽 ${esc(p.mount)} — ${esc(name)}</option>`).join('')}`;
}

function fmBreadcrumbs() {
  const parts = fm.path ? fm.path.split('/') : [];
  return `<nav class=crumbs><button class=link data-go="">${esc(fm.rootLabel)}</button>${parts.map((part, i) => ` <span class=muted>/</span> <button class=link data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join('')}</nav>`;
}

function fmRender() {
  const list = fmCurrentList();
  const scopeBar = can('files.disks') && !fm.scope.app && fmDisks
    ? `<div class=toolbar><label class=scopelbl>Расположение<select id=fmScope>${fmDiskOptions()}</select></label><button class=btn data-act=rescan title="Заново найти диски">⟳</button></div>` : '';
  const canWrite = can('files.mkdir'), canUp = can('files.upload');
  const clip = fmClipboard ? `<button class=btn data-act=paste title="Вставить в текущую папку">📋 Вставить (${fmClipboard.paths.length}) — ${fmClipboard.mode === 'move' ? 'переместить' : 'копировать'}</button><button class=btn data-act=clipclear title="Очистить буфер">✕</button>` : '';
  const toolbar = `<div class=toolbar>${fm.path ? '<button class=btn data-act=up>↑ Вверх</button>' : ''}${fmBreadcrumbs()}</div>
    <div class="toolbar fmtools">
      ${canUp ? '<button class=primary data-act=upload>⬆ Загрузить</button><button class=btn data-act=uploadFolder>Папка…</button>' : ''}
      ${canWrite ? '<button class=btn data-act=newFolder>+ Папка</button><button class=btn data-act=newFile>+ Файл</button>' : ''}${clip}
      ${can('apps.create') ? '<button class=btn data-act=useProject title="Создать приложение из этой папки">🚀 Использовать проект</button>' : ''}
      <span class=fmsp></span>
      <input id=fmSearch class=search placeholder="Поиск по имени (можно * и ?)" value="${esc(fm.search)}">
      <button class="btn ${fm.view === 'list' ? 'on' : ''}" data-act=viewList title="Список">☰</button><button class="btn ${fm.view === 'grid' ? 'on' : ''}" data-act=viewGrid title="Плитки">▦</button>
      <button class=btn data-act=reload title="Обновить">↻</button>
      <input type=file id=fmPick multiple hidden><input type=file id=fmPickFolder webkitdirectory hidden>
    </div>`;
  let body;
  if (fm.error) {
    body = `<div class=empty>${esc(fm.error)}<br><br>${fm.path ? '<button class=btn data-go="">В корень</button> ' : ''}${fm.scope.disk ? '<button class=btn data-act=toStorage>В хранилище проектов</button>' : ''}</div>`;
  } else if (fm.loading) {
    body = '<div class=muted>Загрузка…</div>';
  } else if (!list.length) {
    body = `<div class=empty>${fm.results ? 'Ничего не найдено' : 'Папка пуста. Перетащите сюда файлы или нажмите «Загрузить».'}</div>`;
  } else {
    body = fm.view === 'grid' ? fmGridHtml(list) : fmTableHtml(list);
  }
  const more = !fm.results && fm.loaded < fm.total ? `<div class=fmmore><button class=btn data-act=more>Показать ещё (${fm.loaded} из ${fm.total})</button></div>` : '';
  const note = fm.results ? `<div class=muted>Найдено: ${fm.results.length}. ${esc(fm.searchNote || '')} <button class=link data-act=clearSearch>Сбросить поиск</button></div>` : (fm.total > 0 ? `<div class=muted>Элементов: ${fm.total}</div>` : '');
  fm.host.innerHTML = `<div class=fm>${scopeBar}${fm.scope.disk ? `<div class=fmwhere>Накопитель: <b>${esc(fm.scope.disk)}</b></div>` : ''}${toolbar}<div id=fmSel></div><div id=fmDrop class=fmdrop tabindex=0>${body}</div>${more}${note}</div>`;
  fmUpdateSelectionUi();
}

function fmSortHeader(key, label) {
  const arrow = fm.sort === key ? (fm.order === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th><button class="link sortbtn" data-sort="${key}">${label}${arrow}</button></th>`;
}

function fmTableHtml(list) {
  const rows = list.map(entry => {
    const key = fmEntryKey(entry);
    const where = fm.results ? `<td class=muted>${esc(fmParent(entry.path) || '/')}</td>` : '';
    return `<tr class=fmrow data-key="${esc(key)}" draggable=true><td class=fmchk><input type=checkbox data-check tabindex=-1></td>
      <td class=fmname><span class=fmico>${fmIcon(entry)}</span> <span class=fmtext>${esc(entry.name)}</span>${entry.link ? ' <small class=muted>ссылка</small>' : ''}</td>${where}
      <td class=fmsize>${entry.type === 'directory' ? '' : fmtSize(entry.size)}</td><td class=fmdate>${fmDate(entry.modified)}</td></tr>`;
  }).join('');
  const allChecked = list.length && list.every(entry => fm.selection.has(fmEntryKey(entry)));
  return `<table class="table fmtable"><thead><tr><th class=fmchk><input type=checkbox data-checkall ${allChecked ? 'checked' : ''}></th>${fmSortHeader('name', 'Имя')}${fm.results ? '<th>Папка</th>' : ''}${fmSortHeader('size', 'Размер')}${fmSortHeader('modified', 'Изменён')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function fmGridHtml(list) {
  return `<div class=fmgrid>${list.map(entry => `<div class=fmcard data-key="${esc(fmEntryKey(entry))}" draggable=true title="${esc(entry.name)}"><div class=fmbig>${fmIcon(entry)}</div><div class=fmcardname>${esc(entry.name)}</div><small class=muted>${entry.type === 'directory' ? 'папка' : fmtSize(entry.size)}</small></div>`).join('')}</div>`;
}

/* =========================== выделение ============================ */

const fmKeys = () => fmCurrentList().map(fmEntryKey);
const fmSelectedEntries = () => fmCurrentList().filter(entry => fm.selection.has(fmEntryKey(entry)));

function fmUpdateSelectionUi() {
  fm.host.querySelectorAll('[data-key]').forEach(row => {
    const selected = fm.selection.has(row.dataset.key);
    row.classList.toggle('sel', selected);
    const box = row.querySelector('[data-check]');
    if (box) box.checked = selected;
  });
  const all = fm.host.querySelector('[data-checkall]');
  if (all) all.checked = fmKeys().length > 0 && fmKeys().every(key => fm.selection.has(key));
  const bar = $('fmSel');
  if (!bar) return;
  const selected = fmSelectedEntries();
  // Место под панель занято всегда (см. #fmSel в style.css): иначе список «прыгает» вниз при первом клике и двойной клик не срабатывает
  if (!selected.length) { bar.innerHTML = '<div class="selbar idle"><small class=muted>Клик — выбрать, Ctrl/Shift — несколько, двойной клик — открыть, правая кнопка — меню. Файлы можно перетащить в это окно.</small></div>'; return; }
  const one = selected.length === 1;
  bar.innerHTML = `<div class=selbar><b>Выбрано: ${selected.length}</b>
    ${can('files.download') ? '<button class=btn data-act=download>⬇ Скачать</button>' : ''}
    ${can('files.move_copy') ? '<button class=btn data-act=copy>Копировать</button><button class=btn data-act=cut>Вырезать</button>' : ''}
    ${one && can('files.rename') ? '<button class=btn data-act=rename>Переименовать</button>' : ''}
    ${one && FM_ARCHIVE.test(selected[0].name) && can('files.extract') ? '<button class=btn data-act=extract>Распаковать</button>' : ''}
    ${one && can('apps.create') ? '<button class=btn data-act=useProject>🚀 Использовать проект</button>' : ''}
    ${can('files.delete') ? '<button class="btn bad" data-act=delete>Удалить</button>' : ''}
    <button class=link data-act=deselect>Снять выделение</button></div>`;
}

function fmSelectKey(key, { toggle = false, range = false } = {}) {
  const keys = fmKeys();
  if (range && fm.anchor && keys.includes(fm.anchor)) {
    const [from, to] = [keys.indexOf(fm.anchor), keys.indexOf(key)].sort((a, b) => a - b);
    if (!toggle) fm.selection.clear();
    keys.slice(from, to + 1).forEach(k => fm.selection.add(k));
  } else if (toggle) {
    if (fm.selection.has(key)) fm.selection.delete(key); else fm.selection.add(key);
    fm.anchor = key;
  } else {
    fm.selection = new Set([key]);
    fm.anchor = key;
  }
  fmUpdateSelectionUi();
}

/* =========================== события ============================ */

function attachFileManagerEvents(host) {
  host.onclick = event => {
    hideContextMenu();
    const go = event.target.closest('[data-go]');
    if (go) return fmGo(go.dataset.go);
    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) return fmSort(sortButton.dataset.sort);
    const action = event.target.closest('[data-act]');
    if (action) return fmAction(action.dataset.act);
    if (event.target.closest('[data-checkall]')) {
      const all = fmKeys().every(key => fm.selection.has(key));
      fm.selection = all ? new Set() : new Set(fmKeys());
      return fmUpdateSelectionUi();
    }
    const row = event.target.closest('[data-key]');
    if (row) fmSelectKey(row.dataset.key, { toggle: event.ctrlKey || event.metaKey || !!event.target.closest('[data-check]'), range: event.shiftKey });
    else if (event.target.id === 'fmDrop') { fm.selection.clear(); fmUpdateSelectionUi(); }
  };
  host.ondblclick = event => {
    const row = event.target.closest('[data-key]');
    if (row) fmOpenKey(row.dataset.key);
  };
  host.oncontextmenu = event => {
    const row = event.target.closest('[data-key]');
    if (!row && !event.target.closest('#fmDrop')) return;
    event.preventDefault();
    if (row && !fm.selection.has(row.dataset.key)) fmSelectKey(row.dataset.key);
    showContextMenu(event.clientX, event.clientY, !!row);
  };
  host.onchange = event => {
    if (event.target.id === 'fmScope') return fmChangeScope(event.target.value);
    if (event.target.id === 'fmPick') { fmUploadList([...event.target.files].map(file => ({ file }))); event.target.value = ''; }
    if (event.target.id === 'fmPickFolder') { fmUploadList([...event.target.files].map(file => ({ file, relativePath: file.webkitRelativePath }))); event.target.value = ''; }
  };
  host.oninput = event => {
    if (event.target.id !== 'fmSearch') return;
    fm.search = event.target.value;
    clearTimeout(fmSearchTimer);
    fmSearchTimer = setTimeout(fmSearchNow, FM_SEARCH_DELAY_MS);
  };
  host.onkeydown = event => {
    if (event.target.id === 'fmSearch') {
      if (event.key === 'Enter') fmSearchNow();
      if (event.key === 'Escape') { fm.search = ''; fmSearchNow(); }
      return;
    }
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === 'a') { event.preventDefault(); fm.selection = new Set(fmKeys()); fmUpdateSelectionUi(); }
    else if (ctrl && event.key.toLowerCase() === 'c') fmAction('copy');
    else if (ctrl && event.key.toLowerCase() === 'x') fmAction('cut');
    else if (ctrl && event.key.toLowerCase() === 'v') fmAction('paste');
    else if (event.key === 'Delete') fmAction('delete');
    else if (event.key === 'F2') { event.preventDefault(); fmAction('rename'); }
    else if (event.key === 'Enter' && fm.selection.size === 1) fmOpenKey([...fm.selection][0]);
    else if (event.key === 'Backspace' && fm.path && !fm.results) { event.preventDefault(); fmGo(fmParent(fm.path)); }
    else if (event.key === 'Escape') { fm.selection.clear(); fmUpdateSelectionUi(); hideContextMenu(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const keys = fmKeys();
      const current = keys.indexOf(fm.anchor);
      const next = Math.max(0, Math.min(keys.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      if (keys[next]) { fmSelectKey(keys[next], { range: event.shiftKey }); const row = [...fm.host.querySelectorAll('[data-key]')].find(r => r.dataset.key === keys[next]); if (row) row.scrollIntoView({ block: 'nearest' }); }
    }
  };
  // Перетаскивание: файлы из проводника — загрузка; строки внутри менеджера — перемещение в папку
  host.ondragstart = event => {
    const row = event.target.closest('[data-key]');
    if (!row || !can('files.move_copy')) return event.preventDefault();
    if (!fm.selection.has(row.dataset.key)) fmSelectKey(row.dataset.key);
    event.dataTransfer.setData('application/x-sm-paths', JSON.stringify([...fm.selection]));
    event.dataTransfer.effectAllowed = 'move';
  };
  host.ondragover = event => {
    event.preventDefault();
    const zone = $('fmDrop');
    if (zone) zone.classList.add('drag');
  };
  host.ondragleave = event => { if (!event.relatedTarget || !host.contains(event.relatedTarget)) { const zone = $('fmDrop'); if (zone) zone.classList.remove('drag'); } };
  host.ondrop = async event => {
    event.preventDefault();
    const zone = $('fmDrop');
    if (zone) zone.classList.remove('drag');
    const internal = event.dataTransfer.getData('application/x-sm-paths');
    if (internal) {
      const target = event.target.closest('[data-key]');
      const folder = target && fmCurrentList().find(entry => fmEntryKey(entry) === target.dataset.key && entry.type === 'directory');
      if (folder) fmTransfer('move', JSON.parse(internal), fmEntryKey(folder));
      return;
    }
    if (!can('files.upload')) return toast('Нет разрешения на загрузку файлов', true);
    fmUploadList(await fmCollectDropped(event.dataTransfer));
  };
}

/** Содержимое перетащенных файлов и папок (папки раскрываются рекурсивно). */
async function fmCollectDropped(dataTransfer) {
  const result = [];
  const readEntry = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      result.push({ file, relativePath: prefix ? prefix + entry.name : '' });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await readEntry(child, prefix + entry.name + '/');
      }
    }
  };
  const entries = [...dataTransfer.items].map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) { for (const entry of entries) await readEntry(entry, ''); return result; }
  return [...dataTransfer.files].map(file => ({ file }));
}

function fmUploadList(list) {
  if (!can('files.upload')) return toast('Нет разрешения на загрузку файлов', true);
  Transfers.upload(list, { folder: fm.path, scope: fmScopeBody() });
}

// Когда загрузка/копирование завершились — обновляем список, если мы смотрим на эту папку
window.addEventListener('transfers:done', () => { if (fm && document.body.contains(fm.host) && !fm.results) fmLoad(); });

/* =========================== действия ============================ */

function fmGo(path) {
  if (fm.routed) { page('files', { path, disk: fm.scope.disk }); return; } // у страницы «Файлы» папка — часть адреса (работает «Назад»)
  fm.path = path; fm.search = ''; fm.results = null; fmLoad();
}
function fmSort(key) {
  fm.order = fm.sort === key && fm.order === 'asc' ? 'desc' : 'asc';
  fm.sort = key;
  localStorage.sm_fm_sort = key; localStorage.sm_fm_order = fm.order;
  fmLoad();
}
function fmChangeScope(mount) {
  if (fm.routed) page('files', { disk: mount });
  else { fm.scope = mount ? { disk: mount } : {}; fm.rootLabel = mount || 'Хранилище'; fm.path = ''; fmLoad(); }
}
async function fmOpenKey(key) {
  const entry = fmCurrentList().find(item => fmEntryKey(item) === key);
  if (!entry) return;
  if (entry.type === 'directory') { fm.search = ''; fm.results = null; return fmGo(key); }
  if (FM_ARCHIVE.test(entry.name) && can('files.extract')) return fmExtractDialog(key);
  if (FM_TEXT_FILE.test(entry.name) && entry.size <= 2 * 1024 * 1024) return fmEdit(key);
  if (can('files.download')) fmDownloadEntries([entry]);
}

async function fmAction(action) {
  const selected = fmSelectedEntries();
  switch (action) {
    case 'up': return fmGo(fmParent(fm.path));
    case 'reload': fm.results ? fmSearchNow() : fmLoad(); return;
    case 'more': return fmLoad({ append: true });
    case 'viewList': case 'viewGrid': fm.view = action === 'viewList' ? 'list' : 'grid'; localStorage.sm_fm_view = fm.view; return fmRender();
    case 'upload': return $('fmPick').click();
    case 'uploadFolder': return $('fmPickFolder').click();
    case 'newFolder': return fmCreate('folder');
    case 'newFile': return fmCreate('file');
    case 'deselect': fm.selection.clear(); return fmUpdateSelectionUi();
    case 'clearSearch': fm.search = ''; fm.results = null; return fmRender();
    case 'toStorage': return fmChangeScope('');
    case 'rescan': try { fmDisks = await api('/hw/disks?refresh=1'); toast('Список дисков обновлён'); } catch (error) { toast(error.message, true); } return fmRender();
    case 'download': return fmDownloadEntries(selected);
    case 'copy': case 'cut': return selected.length ? fmClipSet(action === 'cut' ? 'move' : 'copy', selected) : undefined;
    case 'paste': return fmPaste();
    case 'clipclear': fmClipboard = null; return fmRender();
    case 'rename': return selected.length === 1 ? fmRename(selected[0]) : undefined;
    case 'delete': return selected.length ? fmDelete(selected) : undefined;
    case 'extract': return selected.length === 1 ? fmExtractDialog(fmEntryKey(selected[0])) : undefined;
    case 'edit': return selected.length === 1 ? fmEdit(fmEntryKey(selected[0])) : undefined;
    case 'useProject': return fmUseProject(selected.length === 1 ? fmEntryKey(selected[0]) : fm.path);
    default:
  }
}

/* ---------- диалоги ---------- */

function askText({ title, label, value = '', ok = 'OK' }) {
  return new Promise(resolve => {
    modal(title, `<div class=form><label>${esc(label)}<input id=askInput value="${esc(value)}" autocomplete=off></label><div class=actions><button class=primary id=askOk>${esc(ok)}</button><button class=btn id=askCancel>Отмена</button></div></div>`);
    const input = $('askInput');
    input.focus();
    input.setSelectionRange(0, value.includes('.') ? value.lastIndexOf('.') : value.length);
    const done = result => { closeModal(); resolve(result); };
    $('askOk').onclick = () => done(input.value.trim());
    $('askCancel').onclick = () => done(null);
    input.onkeydown = event => { if (event.key === 'Enter') done(input.value.trim()); if (event.key === 'Escape') done(null); };
  });
}

function askConfirm({ title, html, ok = 'Подтвердить', danger = false }) {
  return new Promise(resolve => {
    modal(title, `<div class=form>${html}<div class=actions><button class="${danger ? 'btn bad' : 'primary'}" id=cfOk>${esc(ok)}</button><button class=btn id=cfCancel>Отмена</button></div></div>`);
    const done = result => { closeModal(); resolve(result); };
    $('cfOk').onclick = () => done(true);
    $('cfCancel').onclick = () => done(false);
    $('cfCancel').focus();
  });
}

const FM_BAD_NAME = /[\\/\0]|^\.\.?$/;
function fmCheckName(name) {
  if (!name) return 'Введите имя';
  if (FM_BAD_NAME.test(name) || /[\x00-\x1f]/.test(name)) return 'Имя не может содержать / \\ и быть «.» или «..»';
  return '';
}

async function fmCreate(kind) {
  const name = await askText({ title: kind === 'folder' ? 'Новая папка' : 'Новый файл', label: 'Имя', ok: 'Создать' });
  if (name === null) return;
  const problem = fmCheckName(name);
  if (problem) return toast(problem, true);
  try {
    if (kind === 'folder') await api('/mkdir', { method: 'POST', headers: JH, body: JSON.stringify({ path: fmJoin(fm.path, name), ...fmScopeBody() }) });
    else await api('/file', { method: 'POST', headers: JH, body: JSON.stringify({ path: fmJoin(fm.path, name), content: '', ...fmScopeBody() }) });
    toast('Создано: ' + name);
    fmLoad();
  } catch (error) { toast(error.message, true); }
}

async function fmRename(entry) {
  const name = await askText({ title: 'Переименовать', label: 'Новое имя', value: entry.name, ok: 'Переименовать' });
  if (name === null || name === entry.name) return;
  const problem = fmCheckName(name);
  if (problem) return toast(problem, true);
  const from = fmEntryKey(entry);
  try {
    await api('/rename', { method: 'POST', headers: JH, body: JSON.stringify({ oldPath: from, newPath: fmJoin(fmParent(from), name), ...fmScopeBody() }) });
    toast('Переименовано');
    fm.results ? fmSearchNow() : fmLoad();
  } catch (error) { toast(error.message, true); }
}

async function fmDelete(selected) {
  const names = selected.slice(0, 6).map(entry => `<li>${fmIcon(entry)} ${esc(entry.name)}</li>`).join('');
  const sure = await askConfirm({ title: 'Удалить?', danger: true, ok: 'Удалить безвозвратно',
    html: `<p>Будет удалено элементов: <b>${selected.length}</b>. Папки удаляются вместе с содержимым. Это действие нельзя отменить.</p><ul class=muted>${names}${selected.length > 6 ? `<li>…и ещё ${selected.length - 6}</li>` : ''}</ul>` });
  if (!sure) return;
  try {
    const result = await api('/files/batch', { method: 'POST', headers: JH, body: JSON.stringify({ op: 'delete', paths: selected.map(fmEntryKey), ...fmScopeBody() }) });
    if (result.failCount) {
      const failed = result.results.filter(r => !r.ok).slice(0, 5).map(r => `<li><code>${esc(r.path)}</code>: ${esc(r.error)}</li>`).join('');
      modal('Удалено не всё', `<p>Удалено: ${result.okCount}, не удалось: ${result.failCount}</p><ul>${failed}</ul>`);
    } else toast(`Удалено: ${result.okCount}`);
  } catch (error) { toast(error.message, true); }
  fm.results ? fmSearchNow() : fmLoad();
}

function fmDownloadEntries(selected) {
  if (!selected.length) return;
  const scope = fmScopeBody();
  const stringScope = Object.fromEntries(Object.entries(scope).map(([k, v]) => [k, String(v)]));
  if (selected.length === 1) {
    const entry = selected[0];
    return Transfers.download({ path: fmEntryKey(entry), ...stringScope }, { name: entry.name, size: entry.size, isFile: entry.type === 'file' });
  }
  Transfers.download({ paths: selected.map(fmEntryKey), ...stringScope }, { name: 'files.zip' });
}

/* ---------- копирование и перемещение ---------- */

function fmClipSet(mode, selected) {
  fmClipboard = { mode, node, scope: fmScopeBody(), paths: selected.map(fmEntryKey) };
  toast(mode === 'move' ? `Вырезано: ${selected.length}. Откройте папку назначения и нажмите «Вставить»` : `Скопировано: ${selected.length}. Откройте папку назначения и нажмите «Вставить»`);
  fmRender();
}

function fmPaste() {
  if (!fmClipboard) return;
  if (!can('files.move_copy')) return toast('Нет разрешения на копирование и перемещение', true);
  if (fmClipboard.node !== node) return toast('Копирование между разными серверами не поддерживается', true);
  fmTransfer(fmClipboard.mode, fmClipboard.paths, fm.path, fmClipboard.scope);
}

async function fmTransfer(mode, paths, destination, sourceScope = fmScopeBody(), overwrite = false) {
  try {
    const result = await api('/transfer', { method: 'POST', headers: JH, body: JSON.stringify({ mode, overwrite, src: { ...sourceScope, paths }, dst: { ...fmScopeBody(), path: destination } }) });
    Transfers.trackJob({ kind: 'transfer', jobId: result.job, title: `${mode === 'move' ? 'Перемещение' : 'Копирование'}: ${paths.length === 1 ? paths[0].split('/').pop() : paths.length + ' элем.'}` });
    if (mode === 'move') fmClipboard = null;
  } catch (error) {
    if (/уже есть/.test(error.message) && !overwrite && await askConfirm({ title: 'Файлы уже существуют', html: `<p>${esc(error.message)}</p><p>Заменить существующие файлы?</p>`, ok: 'Заменить' })) {
      return fmTransfer(mode, paths, destination, sourceScope, true);
    }
    if (!/уже есть/.test(error.message)) toast(error.message, true);
  }
}

/* ---------- распаковка ---------- */

async function fmExtractDialog(key) {
  const name = key.split('/').pop();
  let tools = null;
  try { tools = await api('/extract/tools'); } catch { /* без подсказки */ }
  const base = name.replace(/\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tzst|zip|zipx|rar|7z|tar|gz|xz|bz2|zst|cab|iso|arj|lzh|lzma|z|cpio|wim)$/i, '') || name;
  const needs7z = /\.(rar|7z|cab|iso|zipx|arj|lzh|lzma|z|cpio|wim)$/i.test(name);
  const warning = tools && needs7z && !(tools.sevenZip || tools.rar) ? `<div class=hint>⚠ На компьютере с панелью не найден распаковщик для этого формата. ${esc(tools.hint)}</div>` : '';
  modal('Распаковать «' + name + '»', `<div class=form>${warning}
    <label class=checkline><input type=radio name=exmode value=folder checked> В новую папку «${esc(base)}» (рекомендуется)</label>
    <label class=checkline><input type=radio name=exmode value=here> В текущую папку</label>
    <label class=checkline><input type=checkbox id=exover> Заменять существующие файлы (по умолчанию они остаются нетронутыми)</label>
    <small class=muted>Архивы с паролем не поддерживаются. Символические ссылки из архива не создаются. Исходный архив не изменяется.</small>
    <button class=primary id=exGo>Распаковать</button></div>`);
  $('exGo').onclick = async () => {
    const mode = document.querySelector('input[name=exmode]:checked').value;
    const overwrite = $('exover').checked;
    closeModal();
    try {
      const result = await api('/extract', { method: 'POST', headers: JH, body: JSON.stringify({ path: key, mode, overwrite, ...fmScopeBody() }) });
      Transfers.trackJob({ kind: 'extract', jobId: result.job, title: 'Распаковка: ' + name });
    } catch (error) { toast(error.message, true); }
  };
}

/* ---------- редактор ---------- */

async function fmEdit(key) {
  try {
    const file = await api('/file?' + [`path=${encodeURIComponent(key)}`, fmScopeQuery()].filter(Boolean).join('&'));
    const writable = can('files.edit');
    const state = { path: key, eol: file.eol, mtime: file.mtime };
    modal('Редактор: ' + key, `<div class=editor>${fm.scope.app ? '<div class=hint style="margin-bottom:10px">⚠ Изменение конфигурации обычно применяется только после перезапуска приложения.</div>' : ''}
      <textarea id=ed spellcheck=false ${writable ? '' : 'readonly'}>${esc(file.content)}</textarea>
      <div class=actions style="margin-top:12px">${writable ? '<button class=primary id=edSave>Сохранить</button>' : '<span class=muted>Только просмотр: нет разрешения на редактирование</span>'}
      ${writable && fm.scope.app && can('apps.restart') ? '<button class=btn id=edRestart>Сохранить и перезапустить</button>' : ''}<span id=edmsg class=muted></span></div></div>`);
    const save = async (restart, force) => {
      try {
        const result = await api('/file', { method: 'POST', headers: JH, body: JSON.stringify({ path: state.path, content: $('ed').value, eol: state.eol, mtime: state.mtime, force: !!force, ...fmScopeBody() }) });
        state.mtime = result.mtime;
        if (restart) { closeModal(); await act(fm.scope.app, 'restart'); toast('Сохранено, перезапуск…'); return; }
        $('edmsg').textContent = '✓ Сохранено';
      } catch (error) {
        if (error.status === 409 && error.data && error.data.conflict) {
          if (await askConfirm({ title: 'Файл изменился', html: `<p>${esc(error.message)}</p><p>Перезаписать вашей версией?</p>`, ok: 'Перезаписать', danger: true })) return save(restart, true);
          return;
        }
        toast(error.message, true);
      }
    };
    if ($('edSave')) $('edSave').onclick = () => save(false);
    if ($('edRestart')) $('edRestart').onclick = () => save(true);
  } catch (error) { toast(error.message, true); }
}

/* =========================== контекстное меню ============================ */

function hideContextMenu() { const menu = $('fmMenu'); if (menu) menu.remove(); }

function showContextMenu(x, y, onItem) {
  hideContextMenu();
  const selected = fmSelectedEntries();
  const one = selected.length === 1 ? selected[0] : null;
  const items = [];
  if (onItem && one) items.push(['open', 'Открыть', true]);
  if (onItem && one && one.type === 'file' && FM_TEXT_FILE.test(one.name) && can('files.view')) items.push(['edit', can('files.edit') ? 'Редактировать' : 'Просмотреть', true]);
  if (onItem && selected.length && can('files.download')) items.push(['download', 'Скачать' + (selected.length > 1 || (one && one.type === 'directory') ? ' (ZIP)' : ''), true]);
  if (onItem && one && FM_ARCHIVE.test(one.name) && can('files.extract')) items.push(['extract', 'Распаковать…', true]);
  if (onItem && one && can('apps.create')) items.push(['useProject', '🚀 Использовать проект', true]);
  if (onItem && selected.length && can('files.move_copy')) items.push(['copy', 'Копировать', true], ['cut', 'Вырезать', true]);
  if (fmClipboard && can('files.move_copy') && !fm.results) items.push(['paste', 'Вставить сюда', true]);
  if (onItem && one && can('files.rename')) items.push(['rename', 'Переименовать', true]);
  if (onItem && selected.length && can('files.delete')) items.push(['delete', 'Удалить', true, true]);
  if (!onItem && can('files.mkdir')) items.push(['newFolder', 'Новая папка', true], ['newFile', 'Новый файл', true]);
  if (!onItem && can('files.upload')) items.push(['upload', 'Загрузить файлы…', true]);
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.id = 'fmMenu';
  menu.className = 'ctxmenu';
  menu.innerHTML = items.map(([id, label,, danger]) => `<button class="${danger ? 'danger' : ''}" data-menu="${id}">${label}</button>`).join('');
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - items.length * 34 - 12) + 'px';
  menu.onclick = event => {
    const id = event.target.dataset.menu;
    hideContextMenu();
    if (id === 'open') fmOpenKey(fmEntryKey(one)); else if (id) fmAction(id);
  };
  document.body.append(menu);
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
