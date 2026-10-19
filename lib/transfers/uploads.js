'use strict';
// Загрузка файлов частями с возможностью продолжить.
//
// Как это работает (простыми словами):
//  1. Браузер сообщает серверу: «хочу загрузить файл X размером N» → сервер создаёт СЕССИЮ и пустой временный файл
//     .sm-upload-<id>.part рядом с местом назначения (на том же диске — поэтому итоговое переименование мгновенное).
//  2. Браузер отправляет файл кусками (по 16 МБ). Каждый кусок пишется в нужное место временного файла потоком,
//     без чтения в оперативную память. Если связь оборвалась — недописанный кусок отбрасывается,
//     а загрузка продолжается с последнего целого куска (даже после перезагрузки страницы).
//  3. Когда получены все байты, временный файл переименовывается в итоговый. Существующий файл заменяется
//     только в этот момент, поэтому неудачная загрузка никогда не портит старую версию.
// Сведения о сессиях хранятся в storage/uploads/<id>.json и переживают перезапуск панели.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { UserError } = require('../safe-paths');
const { sendJson, route } = require('../http-helpers');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_CHUNK_BYTES = 64 * MIB;
const WRITE_BUFFER_BYTES = 1 * MIB;

const formatBytes = n => (n >= GIB ? (n / GIB).toFixed(2) + ' ГБ' : (n / MIB).toFixed(1) + ' МБ');

function createUploadService({ limits, timeouts, uploadRoot, getFreeBytes, now = () => Date.now() }) {
  fs.mkdirSync(uploadRoot, { recursive: true });
  const maxFileBytes = limits.maxFileGb * GIB;
  const sessionTtlMs = limits.uploadSessionHours * 3600 * 1000;
  const stallMs = timeouts.uploadStallSeconds * 1000;
  const minFreeBytes = limits.minFreeDiskMb * MIB;

  const sessions = new Map(); // id → сессия (кэш; истина — файл на диске)
  const metaFile = id => path.join(uploadRoot, id + '.json');

  const freeBytesOf = getFreeBytes || (async dir => {
    const stats = await fs.promises.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  });

  async function saveSession(session) {
    const { busy, activeStream, ...data } = session; // служебные поля в файл не пишем
    const temp = metaFile(session.id) + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(data));
    await fs.promises.rename(temp, metaFile(session.id));
  }

  async function loadSession(id) {
    if (!/^[\w-]+$/.test(id)) throw new UserError('Загрузка не найдена', 404);
    if (sessions.has(id)) return sessions.get(id);
    let data;
    try { data = JSON.parse(await fs.promises.readFile(metaFile(id), 'utf8')); } catch { throw new UserError('Загрузка не найдена или уже завершена', 404); }
    sessions.set(id, data);
    return data;
  }

  async function getSession(id, owner) {
    const session = await loadSession(id);
    if (session.owner !== owner) throw new UserError('Эта загрузка принадлежит другому пользователю', 403);
    return session;
  }

  async function allSessions() {
    const result = [];
    for (const name of await fs.promises.readdir(uploadRoot).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try { result.push(await loadSession(name.slice(0, -5))); } catch { /* повреждённый файл — пропускаем */ }
    }
    return result;
  }

  async function removeSessionFiles(session) {
    sessions.delete(session.id);
    await fs.promises.rm(session.partPath, { force: true }).catch(() => {});
    await fs.promises.rm(metaFile(session.id), { force: true }).catch(() => {});
  }

  /**
   * Новая загрузка (или продолжение прежней, если такой же файл уже загружался частично).
   * targetPath — уже проверенный абсолютный путь назначения.
   */
  async function create({ owner, scope, relativePath, targetPath, size, mtimeMs, overwrite }) {
    if (!Number.isSafeInteger(size) || size < 0) throw new UserError('Не указан размер файла');
    if (size > maxFileBytes) throw new UserError(`Файл больше допустимого лимита (${limits.maxFileGb} ГБ)`, 413, { limit: maxFileBytes });

    const existing = await fs.promises.stat(targetPath).catch(() => null);
    if (existing && existing.isDirectory()) throw new UserError('На этом месте уже есть папка с таким именем', 409);
    if (existing && !overwrite) throw new UserError('Файл уже существует', 409, { exists: true });

    // Тот же файл уже загружали? Продолжаем с того места, где остановились
    const all = await allSessions();
    const same = all.find(s => s.owner === owner && s.targetPath === targetPath && s.size === size && s.mtimeMs === mtimeMs
      && now() - s.updatedAt < sessionTtlMs);
    if (same) {
      const partStat = await fs.promises.stat(same.partPath).catch(() => null);
      if (partStat && partStat.size >= same.received) {
        if (partStat.size > same.received) await fs.promises.truncate(same.partPath, same.received);
        same.overwrite = !!overwrite;
        return { session: same, resumed: true };
      }
      await removeSessionFiles(same); // временный файл потерян — начинаем заново
    }

    if (all.filter(s => s.owner === owner).length >= limits.maxActiveUploads) {
      throw new UserError(`Слишком много незавершённых загрузок (максимум ${limits.maxActiveUploads}). Завершите или отмените часть из них.`, 429);
    }

    const free = await freeBytesOf(path.dirname(targetPath));
    if (free < size + minFreeBytes) {
      throw new UserError(`Недостаточно места на диске: нужно ${formatBytes(size + minFreeBytes)} (с запасом), свободно ${formatBytes(Math.max(0, free))}`, 507);
    }

    const id = crypto.randomBytes(16).toString('hex');
    const partPath = path.join(path.dirname(targetPath), `.sm-upload-${id}.part`);
    await (await fs.promises.open(partPath, 'wx')).close();
    const session = { id, owner, scope, relativePath, targetPath, partPath, size, received: 0, mtimeMs: mtimeMs || 0,
      overwrite: !!overwrite, createdAt: now(), updatedAt: now() };
    sessions.set(id, session);
    await saveSession(session);
    return { session, resumed: false };
  }

  /** Принимает одну часть файла из потока stream. Возвращает обновлённую сессию. */
  async function writeChunk(id, owner, offset, stream, contentLength) {
    const session = await getSession(id, owner);
    if (session.busy) throw new UserError('Эта загрузка уже принимает данные в другом запросе', 409, { received: session.received });
    if (!Number.isSafeInteger(offset) || offset !== session.received) {
      throw new UserError('Смещение не совпадает с уже загруженным — продолжите с указанного места', 409, { received: session.received });
    }
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) throw new UserError('Не указана длина данных (Content-Length)', 411);
    if (contentLength > MAX_CHUNK_BYTES) throw new UserError(`Часть слишком большая (максимум ${MAX_CHUNK_BYTES / MIB} МБ)`, 413);
    if (offset + contentLength > session.size) throw new UserError('Данных больше, чем заявленный размер файла', 400, { received: session.received });

    session.busy = true;
    session.activeStream = stream;
    let written = 0;
    let stallTimer = null;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stream.destroy(new UserError('Передача остановилась: данные не поступают', 408)), stallMs);
    };
    stream.on('data', chunk => { written += chunk.length; armStallTimer(); });
    armStallTimer();

    try {
      const output = fs.createWriteStream(session.partPath, { flags: 'r+', start: offset, highWaterMark: WRITE_BUFFER_BYTES });
      await pipeline(stream, output); // pipeline сам следит за скоростью записи (backpressure) и закрывает файлы при ошибке
      if (written !== contentLength) throw new UserError('Получено меньше данных, чем заявлено', 400);
      session.received = offset + written;
      session.updatedAt = now();
      await saveSession(session);
      return session;
    } catch (error) {
      // Обрыв: выбрасываем недописанный кусок, чтобы файл содержал только проверенные данные
      await fs.promises.truncate(session.partPath, session.received).catch(() => {});
      if (session.cancelled) throw new UserError('Загрузка отменена', 410);
      error.received = session.received;
      throw error;
    } finally {
      clearTimeout(stallTimer);
      session.busy = false;
      session.activeStream = null;
    }
  }

  /** Завершение: проверка размера и мгновенное переименование временного файла в итоговый. */
  async function finish(id, owner, { targetPath, overwrite }) {
    const session = await getSession(id, owner);
    if (session.busy) throw new UserError('Загрузка ещё принимает данные', 409);
    if (session.received !== session.size) {
      throw new UserError(`Загружено ${session.received} из ${session.size} байт — файл неполный`, 409, { received: session.received });
    }
    const existing = await fs.promises.stat(targetPath).catch(() => null);
    if (existing && existing.isDirectory()) throw new UserError('На этом месте уже есть папка с таким именем', 409);
    if (existing && !(overwrite || session.overwrite)) throw new UserError('Файл уже существует', 409, { exists: true });

    const handle = await fs.promises.open(session.partPath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); } // данные точно записаны на диск
    await fs.promises.rename(session.partPath, targetPath);
    if (session.mtimeMs) await fs.promises.utimes(targetPath, new Date(), new Date(session.mtimeMs)).catch(() => {});
    sessions.delete(id);
    await fs.promises.rm(metaFile(id), { force: true });
    return { name: path.basename(targetPath), size: session.size };
  }

  async function cancel(id, owner) {
    const session = await getSession(id, owner);
    session.cancelled = true;
    if (session.activeStream) session.activeStream.destroy(new UserError('Загрузка отменена', 410));
    await removeSessionFiles(session);
  }

  /** Удаляет давно заброшенные загрузки вместе с временными файлами. */
  async function cleanupExpired() {
    let removed = 0;
    for (const session of await allSessions()) {
      if (!session.busy && now() - session.updatedAt > sessionTtlMs) { await removeSessionFiles(session); removed++; }
    }
    return removed;
  }

  return { create, writeChunk, finish, cancel, getSession, cleanupExpired, chunkBytes: limits.uploadChunkMb * MIB };
}

/* ---------------- HTTP-маршруты ---------------- */

const ownerOf = user => `${user.id}:${user.username}`;

/** Проверка имени файла из запроса: без папок, без управляющих символов. */
function checkFileName(name) {
  const value = String(name || '');
  if (!value || value.length > 255 || /[\\/\0]/.test(value) || value === '.' || value === '..' || /[\x00-\x1f]/.test(value)) {
    throw new UserError('Недопустимое имя файла: ' + value.slice(0, 80));
  }
  return value;
}

/** Относительный путь внутри загружаемой папки: «Папка/Вложенная/файл.txt». */
function checkRelativeParts(relative) {
  const parts = String(relative || '').split(/[\\/]+/).filter(Boolean);
  if (parts.length > 40) throw new UserError('Слишком глубокая вложенность папок');
  return parts.map(checkFileName);
}

function registerUploadRoutes({ app, service, pathGuard, audit }) {
  const scopeFrom = body => ({ app: body.app || undefined, disk: body.disk || undefined });

  // Создать загрузку (или найти прежнюю, чтобы продолжить)
  app.post('/api/uploads', route(async (req, res) => {
    const body = req.body || {};
    const scope = scopeFrom(body);
    const parts = body.relativePath ? checkRelativeParts(body.relativePath) : [checkFileName(body.name)];
    const folder = String(body.path || '');
    const relativePath = [folder, ...parts].filter(Boolean).join('/');
    const targetPath = pathGuard.resolveScoped(scope, relativePath, req.user);
    if (pathGuard.isPanelTempName(path.basename(targetPath))) throw new UserError('Недопустимое имя файла');
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true }); // для загрузки папок: создаём вложенные каталоги
    const { session, resumed } = await service.create({
      owner: ownerOf(req.user), scope, relativePath, targetPath,
      size: Number(body.size), mtimeMs: Number(body.mtime) || 0, overwrite: !!body.overwrite,
    });
    sendJson(res, 200, { id: session.id, received: session.received, size: session.size, chunkBytes: service.chunkBytes, resumed });
  }));

  // Узнать, сколько уже загружено (для продолжения после обрыва)
  app.get('/api/uploads/:id', route(async (req, res) => {
    const session = await service.getSession(req.params.id, ownerOf(req.user));
    sendJson(res, 200, { id: session.id, received: session.received, size: session.size, name: path.basename(session.targetPath), chunkBytes: service.chunkBytes });
  }));

  // Принять часть файла. Тело запроса — сырые байты (application/octet-stream)
  app.put('/api/uploads/:id', route(async (req, res) => {
    const offset = Number(req.query.offset);
    const length = Number(req.headers['content-length']);
    const session = await service.writeChunk(req.params.id, ownerOf(req.user), offset, req, length);
    if (req.query.finish === '1' && session.received === session.size) {
      const targetPath = pathGuard.resolveScoped(session.scope, session.relativePath, req.user);
      const done = await service.finish(req.params.id, ownerOf(req.user), { targetPath, overwrite: session.overwrite });
      audit(req.user, 'file_upload', `${session.relativePath} (${session.size} байт)`);
      return sendJson(res, 200, { received: session.size, done: true, name: done.name });
    }
    sendJson(res, 200, { received: session.received, done: false });
  }));

  app.post('/api/uploads/:id/finish', route(async (req, res) => {
    const owner = ownerOf(req.user);
    const session = await service.getSession(req.params.id, owner);
    const targetPath = pathGuard.resolveScoped(session.scope, session.relativePath, req.user);
    const done = await service.finish(req.params.id, owner, { targetPath, overwrite: !!(req.body && req.body.overwrite) || session.overwrite });
    audit(req.user, 'file_upload', `${session.relativePath} (${session.size} байт)`);
    sendJson(res, 200, { done: true, name: done.name });
  }));

  app.delete('/api/uploads/:id', route(async (req, res) => {
    await service.cancel(req.params.id, ownerOf(req.user));
    sendJson(res, 200, { ok: true });
  }));
}

module.exports = { createUploadService, registerUploadRoutes, MAX_CHUNK_BYTES };
