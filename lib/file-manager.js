'use strict';
// Файловый менеджер: просмотр папок, поиск, чтение и запись текстовых файлов, создание, переименование, удаление, скачивание.
// Все операции работают с настоящей файловой системой. Любой путь проходит через pathGuard (lib/safe-paths.js).
// Всё, что может занять время (чтение папок, удаление), выполняется асинхронно, чтобы панель не «замирала».
const fs = require('fs');
const path = require('path');
const { sendJson, route } = require('./http-helpers');
const { UserError, scopeOf, describeFsError } = require('./safe-paths');
const { sendFile, sendZip } = require('./transfers/download');
const permissions = require('./permissions');

const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;
const LIST_DEFAULT_LIMIT = 500;
const LIST_MAX_LIMIT = 2000;
const LAZY_STAT_THRESHOLD = 3000;   // в больших папках при сортировке по имени/типу узнаём размер только у показанных файлов
const STAT_CONCURRENCY = 64;
const SEARCH_MAX_RESULTS = 500;
const SEARCH_MAX_DEPTH = 12;
const SEARCH_TIME_BUDGET_MS = 8000;
const BATCH_MAX_ITEMS = 1000;

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const extensionOf = name => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };

/** Выполняет fn для всех элементов, но не более limit одновременно. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  });
  await Promise.all(workers);
  return results;
}

/** Описание одного элемента папки. Битая ссылка показывается как файл без размера. */
async function describeEntry(directory, name, dirent) {
  const full = path.join(directory, name);
  try {
    const stats = await fs.promises.stat(full);
    return { name, type: stats.isDirectory() ? 'directory' : 'file', size: stats.isDirectory() ? null : stats.size, modified: stats.mtimeMs, ext: stats.isDirectory() ? '' : extensionOf(name), link: dirent.isSymbolicLink() || undefined };
  } catch {
    try {
      const stats = await fs.promises.lstat(full);
      return { name, type: 'file', size: stats.size, modified: stats.mtimeMs, ext: extensionOf(name), link: true, broken: true };
    } catch { return null; }
  }
}

function compareEntries(sort, order) {
  const direction = order === 'desc' ? -1 : 1;
  return (a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1; // папки всегда выше файлов
    let result = 0;
    if (sort === 'size') result = (a.size || 0) - (b.size || 0);
    else if (sort === 'modified') result = (a.modified || 0) - (b.modified || 0);
    else if (sort === 'type') result = collator.compare(a.ext, b.ext);
    if (result === 0) result = collator.compare(a.name, b.name);
    return result * direction;
  };
}

/** Содержимое папки: сортировка и постраничная выдача (offset/limit) для очень больших каталогов. */
async function listDirectory(directory, { sort = 'name', order = 'asc', offset = 0, limit = LIST_DEFAULT_LIMIT }, guard) {
  const dirents = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter(d => !guard.isPanelTempName(d.name) && !guard.isProtectedPath(path.join(directory, d.name)));
  const needsStats = sort === 'size' || sort === 'modified' || dirents.length <= LAZY_STAT_THRESHOLD;
  let entries;
  let total = dirents.length;
  if (needsStats) {
    entries = (await mapLimit(dirents, STAT_CONCURRENCY, d => describeEntry(directory, d.name, d))).filter(Boolean);
    total = entries.length;
    entries.sort(compareEntries(sort, order));
    entries = entries.slice(offset, offset + limit);
  } else {
    // Большая папка: сначала упорядочиваем по именам из списка, потом читаем подробности только у нужной страницы
    const light = dirents.map(d => ({ name: d.name, type: d.isDirectory() ? 'directory' : 'file', ext: d.isDirectory() ? '' : extensionOf(d.name), dirent: d }));
    light.sort(compareEntries(sort, order));
    const page = light.slice(offset, offset + limit);
    entries = (await mapLimit(page, STAT_CONCURRENCY, item => describeEntry(directory, item.name, item.dirent))).filter(Boolean);
  }
  return { total, offset, limit, entries };
}

/** Поиск по имени во вложенных папках. Ссылки на папки не раскрываются; время и число результатов ограничены. */
async function searchTree(rootAbsolute, startAbsolute, text, guard) {
  const wildcard = /[*?]/.test(text);
  const pattern = wildcard ? new RegExp('^' + text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  const needle = text.toLowerCase();
  const matches = name => (pattern ? pattern.test(name) : name.toLowerCase().includes(needle));
  const results = [];
  const startedAt = Date.now();
  let scanned = 0;
  let truncated = false;
  const queue = [{ dir: startAbsolute, depth: 0 }];

  while (queue.length && !truncated) {
    const { dir, depth } = queue.shift();
    let handle;
    try { handle = await fs.promises.opendir(dir); } catch { continue; }
    try {
      for await (const dirent of handle) {
        const full = path.join(dir, dirent.name);
        if (guard.isPanelTempName(dirent.name) || guard.isProtectedPath(full)) continue;
        scanned++;
        if (matches(dirent.name)) {
          const described = await describeEntry(dir, dirent.name, dirent);
          if (described) results.push({ ...described, path: path.relative(rootAbsolute, full).split(path.sep).join('/') });
        }
        if (dirent.isDirectory() && depth < SEARCH_MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
        if (results.length >= SEARCH_MAX_RESULTS || Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) { truncated = true; break; }
      }
    } finally { await handle.close().catch(() => {}); }
  }
  return { results, scanned, truncated };
}

function clampInt(value, fallback, min, max) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Список путей из запроса: один path или массив paths (в адресе — JSON-строка). */
function pathsFrom(params) {
  let list = params.paths;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { throw new UserError('Некорректный список файлов'); } }
  if (Array.isArray(list)) return list.map(String);
  return params.path !== undefined ? [String(params.path)] : [];
}

function registerFileRoutes({ app, pathGuard, audit, config, auth, archiverFactory, backupRoot, logFile, flushLog, mayUseNode }) {
  const scopedPath = (req, relative, scope = scopeOf(req)) => pathGuard.resolveScoped(scope, relative, req.user);
  const rootOf = req => path.resolve(pathGuard.resolveRoot(scopeOf(req), req.user));
  const mustHave = (req, id) => {
    if (!req.user.permissions.has(id)) throw new UserError('Недостаточно прав. Нужно разрешение: ' + permissions.titles([id]), 403);
  };
  const assertNotRoot = (req, target) => {
    if (target === rootOf(req)) throw new UserError('Нельзя изменять корневую папку');
    if (pathGuard.isPanelAncestor(target)) throw new UserError('Это папка самой панели (или её родитель) — менять её нельзя');
  };

  // Содержимое папки
  app.get('/api/files', route(async (req, res) => {
    const directory = scopedPath(req, req.query.path || '');
    const options = {
      sort: ['name', 'size', 'modified', 'type'].includes(req.query.sort) ? req.query.sort : 'name',
      order: req.query.order === 'desc' ? 'desc' : 'asc',
      offset: clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: clampInt(req.query.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT),
    };
    const listing = await listDirectory(directory, options, pathGuard);
    sendJson(res, 200, { path: String(req.query.path || ''), ...listing });
  }));

  // Поиск по имени внутри папки
  app.get('/api/files/search', route(async (req, res) => {
    const text = String(req.query.q || '').trim();
    if (!text) throw new UserError('Введите, что искать');
    const start = scopedPath(req, req.query.path || '');
    sendJson(res, 200, await searchTree(rootOf(req), start, text, pathGuard));
  }));

  // Чтение текстового файла для редактора
  app.get('/api/file', route(async (req, res) => {
    const file = scopedPath(req, req.query.path);
    const stats = await fs.promises.stat(file);
    if (stats.isDirectory()) throw new UserError('Это папка');
    if (stats.size > TEXT_EDIT_MAX_BYTES) throw new UserError(`Файл слишком большой для редактора (${(stats.size / 1048576).toFixed(1)} МБ, максимум 2 МБ). Скачайте его.`, 413);
    const buffer = await fs.promises.readFile(file);
    if (buffer.subarray(0, 8192).includes(0)) throw new UserError('Это бинарный файл — его нельзя редактировать как текст. Скачайте его.', 415);
    const raw = buffer.toString('utf8');
    sendJson(res, 200, { content: raw.replace(/\r\n/g, '\n'), eol: /\r\n/.test(raw) ? 'crlf' : 'lf', size: stats.size, mtime: stats.mtimeMs });
  }));

  // Сохранение текстового файла (или создание нового). Если файл изменили после открытия — сообщаем о конфликте
  app.post('/api/file', route(async (req, res) => {
    const body = req.body || {};
    const file = scopedPath(req, body.path);
    const existing = await fs.promises.stat(file).catch(() => null);
    if (existing) {
      mustHave(req, 'files.edit');
      if (existing.isDirectory()) throw new UserError('Это папка');
      if (body.mtime && !body.force && Math.abs(existing.mtimeMs - body.mtime) > 1) {
        throw new UserError('Файл был изменён после того, как вы его открыли (другим пользователем или самим приложением).', 409, { conflict: true });
      }
    } else {
      mustHave(req, 'files.mkdir');
      if (!fs.existsSync(path.dirname(file))) throw new UserError('Папка не найдена');
    }
    let content = String(body.content ?? '');
    if (body.eol === 'crlf') content = content.replace(/\r?\n/g, '\r\n');
    await fs.promises.writeFile(file, content, 'utf8');
    if (existing) audit(req.user, 'file_edit', path.relative(rootOf(req), file));
    sendJson(res, 200, { ok: true, mtime: (await fs.promises.stat(file)).mtimeMs });
  }));

  async function deletePath(req, relative) {
    const target = scopedPath(req, relative);
    assertNotRoot(req, target);
    await fs.promises.rm(target, { recursive: true, force: true });
  }

  app.delete('/api/file', route(async (req, res) => {
    const relative = String((req.body && req.body.path) ?? req.query.path ?? '');
    await deletePath(req, relative);
    audit(req.user, 'file_delete', relative);
    sendJson(res, 200, { ok: true });
  }));

  // Массовые операции над выбранными элементами. Сейчас: delete. Копирование и перемещение — через /api/transfer.
  app.post('/api/files/batch', route(async (req, res) => {
    const body = req.body || {};
    const list = Array.isArray(body.paths) ? body.paths.map(String) : [];
    if (body.op !== 'delete') throw new UserError('Неизвестная операция');
    mustHave(req, 'files.delete');
    rootOf(req); // область (диск/приложение) проверяется один раз — запрещённая область отклоняет весь запрос
    if (!list.length) throw new UserError('Ничего не выбрано');
    if (list.length > BATCH_MAX_ITEMS) throw new UserError(`За один раз можно выбрать не больше ${BATCH_MAX_ITEMS} элементов`);
    const results = [];
    for (const relative of list) {
      try { await deletePath(req, relative); results.push({ path: relative, ok: true }); }
      catch (error) { results.push({ path: relative, ok: false, error: describeFsError(error) }); }
    }
    const okCount = results.filter(r => r.ok).length;
    audit(req.user, 'file_delete', `${okCount} из ${list.length}: ${list.slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''}`);
    sendJson(res, 200, { results, okCount, failCount: results.length - okCount });
  }));

  app.post('/api/mkdir', route(async (req, res) => {
    const target = scopedPath(req, req.body && req.body.path);
    if (fs.existsSync(target)) throw new UserError('Уже существует');
    await fs.promises.mkdir(target, { recursive: true });
    sendJson(res, 200, { ok: true });
  }));

  app.post('/api/rename', route(async (req, res) => {
    const body = req.body || {};
    const from = scopedPath(req, body.oldPath);
    const to = scopedPath(req, body.newPath);
    assertNotRoot(req, from);
    if (to === rootOf(req)) throw new UserError('Недопустимый путь');
    if (!fs.existsSync(from)) throw new UserError('Файл или папка не найдены');
    if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new UserError('Файл или папка с таким именем уже существует');
    await fs.promises.rename(from, to);
    audit(req.user, 'file_rename', `${body.oldPath} → ${body.newPath}`);
    sendJson(res, 200, { ok: true });
  }));

  /* ---------- скачивание ---------- */

  app.get('/api/download', route(async (req, res) => {
    const params = req.downloadQuery || req.query; // при скачивании по билету параметры берутся из билета
    if (params.backup) {
      const name = path.basename(String(params.backup));
      if (!/\.zip$/i.test(name)) throw new UserError('Недопустимый файл');
      const file = path.join(backupRoot, name);
      if (!fs.existsSync(file)) throw new UserError('Backup не найден', 404);
      return sendFile(req, res, file, { downloadName: name });
    }
    if (params.applog) {
      const id = Number(params.applog);
      flushLog(id);
      const file = logFile(id);
      if (!fs.existsSync(file)) throw new UserError('Лог пуст', 404);
      return sendFile(req, res, file, { downloadName: `app-${id}.log`, contentType: 'text/plain; charset=utf-8' });
    }

    const scope = { app: params.app || undefined, disk: params.disk || undefined };
    const relatives = pathsFrom(params);
    if (!relatives.length) throw new UserError('Не указан файл');
    if (relatives.length > config.limits.maxZipItems) throw new UserError(`Слишком много элементов (максимум ${config.limits.maxZipItems})`);
    const targets = relatives.map(relative => scopedPath(req, relative, scope));

    if (targets.length === 1) {
      const stats = await fs.promises.stat(targets[0]);
      if (!stats.isDirectory()) return sendFile(req, res, targets[0], { downloadName: path.basename(targets[0]) });
    }
    // Папка или несколько элементов — ZIP на лету. Одинаковые имена получают номер: file.txt, file (2).txt
    const used = new Set();
    const entries = targets.map(absolutePath => {
      let name = path.basename(absolutePath) || 'root';
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${path.basename(absolutePath)} (${n})`;
      used.add(name.toLowerCase());
      return { absolutePath, nameInZip: name };
    });
    const zipName = (targets.length === 1 ? entries[0].nameInZip : 'files') + '.zip';
    audit(req.user, 'file_download_zip', `${zipName}: ${relatives.length} элем.`);
    await sendZip(req, res, { archiverFactory, entries, zipName, compressionLevel: 0 });
  }));

  // Билет на скачивание: короткоживущая ссылка вместо токена входа в адресной строке
  app.post('/api/tickets/download', route(async (req, res) => {
    const body = req.body || {};
    const node = String(body.node || 'local');
    const input = body.query || {};
    const query = {};
    for (const key of ['path', 'app', 'disk', 'backup', 'applog']) if (input[key] !== undefined && input[key] !== '') query[key] = String(input[key]);
    if (Array.isArray(input.paths)) query.paths = input.paths.map(String).slice(0, config.limits.maxZipItems);
    if (!mayUseNode(req.user, node)) throw new UserError('Нет доступа к этому серверу', 403);
    const verdict = permissions.check(req.user.permissions, 'GET', '/download', query);
    if (!verdict.ok) throw new UserError(verdict.reason, 403);
    const ticket = auth.issueTicket(req.user, node, query);
    const base = node === 'local' ? '/api' : `/api/n/${encodeURIComponent(node)}`;
    sendJson(res, 200, { ticket, url: `${base}/download?ticket=${encodeURIComponent(ticket)}` });
  }));
}

module.exports = { registerFileRoutes, listDirectory, searchTree, mapLimit };
