'use strict';
// Копирование и перемещение файлов и папок (в том числе между дисками) в фоновом режиме.
// Панель сразу отвечает «задача принята», а ход работы виден по GET /api/transfer/<id>.
// Надёжность:
//  • файл копируется во временный файл и только после полной записи переименовывается — старая копия не портится;
//  • оригинал при перемещении между дисками удаляется только после проверки, что размеры копий совпали;
//  • при ошибке или отмене недокопированное удаляется, оригинал не трогается;
//  • перед началом проверяется свободное место на диске назначения.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { UserError, scopeOf, describeFsError, isInside, comparable } = require('./safe-paths');
const { sendJson, route } = require('./http-helpers');

const COPY_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_RUNNING_JOBS = 3;
const JOB_KEEP_MS = 10 * 60 * 1000;
const MIN_FREE_AFTER_COPY = 16 * 1024 * 1024;
const YIELD_EVERY = 300;

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));
const formatBytes = n => (n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1073741824).toFixed(2) + ' ГБ');

function registerTransferRoutes({ app, pathGuard, audit }) {
  const jobs = new Map();

  /** Подсчёт объёма. Ссылки и особые файлы не копируются (иначе через ссылку можно «вытащить» посторонние файлы). */
  async function scan(target, job) {
    const stats = await fs.promises.lstat(target);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      job.skippedCount++;
      if (job.skipped.length < 30) job.skipped.push(target);
      return;
    }
    if (stats.isDirectory()) {
      for (const name of await fs.promises.readdir(target)) {
        if (++job.scanned % YIELD_EVERY === 0) await yieldToEventLoop();
        await scan(path.join(target, name), job);
      }
    } else { job.total += stats.size; job.files++; }
  }

  async function copyFile(from, to, stats, job) {
    const temporary = path.join(path.dirname(to), `.sm-upload-copy-${job.id}-${job.tempCounter++}.part`);
    const counter = new Transform({ transform(chunk, _encoding, callback) { job.done += chunk.length; callback(null, chunk); } });
    try {
      await pipeline(
        fs.createReadStream(from, { highWaterMark: COPY_BUFFER_BYTES }), counter,
        fs.createWriteStream(temporary, { highWaterMark: COPY_BUFFER_BYTES }),
        { signal: job.abort.signal },
      );
      await fs.promises.rename(temporary, to);
      await fs.promises.utimes(to, stats.atime, stats.mtime).catch(() => {});
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function copyTree(from, to, job) {
    const stats = await fs.promises.lstat(from);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) return;
    if (stats.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true });
      for (const name of await fs.promises.readdir(from)) await copyTree(path.join(from, name), path.join(to, name), job);
      await fs.promises.utimes(to, stats.atime, stats.mtime).catch(() => {});
    } else await copyFile(from, to, stats, job);
  }

  /** Сверка размеров: оригинал удаляется только если каждая копия совпала. */
  async function verifyTree(from, to, job) {
    const source = await fs.promises.lstat(from);
    if (source.isSymbolicLink() || (!source.isDirectory() && !source.isFile())) return;
    if (source.isDirectory()) {
      for (const name of await fs.promises.readdir(from)) {
        if (++job.scanned % YIELD_EVERY === 0) await yieldToEventLoop();
        await verifyTree(path.join(from, name), path.join(to, name), job);
      }
    } else if ((await fs.promises.stat(to)).size !== source.size) throw new UserError('Проверка не пройдена: размер копии отличается — ' + to);
  }

  /** Проверяет один элемент до начала работы. Возвращает { from, to, isDirectory, createdNew }. */
  function planItem(req, mode, sourceScope, sourceRelative, destScope, destFolderAbs, destRoot, forcedName, overwrite) {
    const sourceRoot = pathGuard.resolveRoot(sourceScope, req.user);
    const from = pathGuard.resolveInside(sourceRoot, sourceRelative);
    if (from === path.resolve(sourceRoot)) throw new UserError('Нельзя копировать или перемещать корень');
    if (!fs.existsSync(from)) throw new UserError('Источник не найден: ' + sourceRelative);
    const name = path.basename(String(forcedName || path.basename(from)));
    const to = pathGuard.resolveInside(destRoot, path.relative(destRoot, path.join(destFolderAbs, name)));
    const isDirectory = fs.statSync(from).isDirectory();
    if (comparable(from) === comparable(to)) throw new UserError('Источник и назначение совпадают: ' + name);
    if (isDirectory && isInside(from, to)) throw new UserError('Нельзя копировать папку внутрь самой себя: ' + name);
    if (mode === 'move' && pathGuard.isPanelAncestor(from)) throw new UserError('Нельзя перемещать папку самой панели');
    const exists = fs.existsSync(to);
    if (exists && (!overwrite || isDirectory || fs.statSync(to).isDirectory())) {
      throw new UserError(`В папке назначения уже есть «${name}»` + (isDirectory ? '' : ' (можно заменить файл)'));
    }
    return { from, to, name, isDirectory, createdNew: !exists };
  }

  async function runJob(job, items, destFolderAbs, mode) {
    const created = [];
    try {
      // Быстрый путь: на одном диске перемещение — это переименование
      const remaining = [];
      for (const item of items) {
        if (mode === 'move' && item.createdNew) {
          try { await fs.promises.rename(item.from, item.to); job.moved++; continue; } catch (error) { if (error.code !== 'EXDEV') throw error; }
        }
        remaining.push(item);
      }
      if (remaining.length) {
        job.phase = 'scan';
        for (const item of remaining) await scan(item.from, job);
        const stats = await fs.promises.statfs(destFolderAbs);
        const free = Number(stats.bavail) * Number(stats.bsize);
        if (free < job.total + MIN_FREE_AFTER_COPY) throw new UserError(`Недостаточно места на диске назначения (нужно ${formatBytes(job.total)}, свободно ${formatBytes(free)})`);
        job.phase = 'copy';
        for (const item of remaining) {
          if (item.createdNew) created.push(item.to);
          await copyTree(item.from, item.to, job);
        }
        job.phase = 'verify';
        job.scanned = 0;
        for (const item of remaining) await verifyTree(item.from, item.to, job);
        if (mode === 'move') {
          if (job.skippedCount) job.message = `Скопировано, но оригинал НЕ удалён: ${job.skippedCount} ссылок/особых файлов не копируются`;
          else {
            job.phase = 'cleanup';
            for (const item of remaining) await fs.promises.rm(item.from, { recursive: true, force: true });
            job.message = 'Перемещено (копия проверена, оригинал удалён)';
          }
        } else job.message = job.skippedCount ? `Скопировано. Пропущено ссылок/особых файлов: ${job.skippedCount}` : 'Скопировано';
      } else job.message = 'Перемещено';
      job.status = 'done';
      job.phase = 'done';
    } catch (error) {
      job.status = job.abort.signal.aborted ? 'cancelled' : 'error';
      job.message = job.abort.signal.aborted ? 'Отменено. Оригиналы не изменены.' : describeFsError(error);
      for (const target of created) await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {}); // убираем недокопированное
    } finally {
      job.finishedAt = Date.now();
      setTimeout(() => jobs.delete(job.id), JOB_KEEP_MS).unref();
    }
  }

  app.post('/api/transfer', route(async (req, res) => {
    const body = req.body || {};
    const mode = body.mode === 'move' ? 'move' : 'copy';
    const source = body.src || {};
    const dest = body.dst || {};
    const sourceScope = scopeOf({ query: {}, body: source });
    const destScope = scopeOf({ query: {}, body: dest });
    const destRoot = path.resolve(pathGuard.resolveRoot(destScope, req.user));
    const destFolder = pathGuard.resolveInside(destRoot, String(dest.path || ''));
    if (!fs.existsSync(destFolder) || !fs.statSync(destFolder).isDirectory()) throw new UserError('Папка назначения не найдена');

    const relatives = Array.isArray(source.paths) ? source.paths.map(String) : [String(source.path || '')];
    if (!relatives.length || relatives.length > 1000) throw new UserError('Выберите от 1 до 1000 элементов');
    const forcedName = relatives.length === 1 ? body.name : undefined;
    const items = relatives.map(relative => planItem(req, mode, sourceScope, relative, destScope, destFolder, destRoot, forcedName, !!body.overwrite));
    if (new Set(items.map(item => comparable(item.to))).size !== items.length) throw new UserError('В выбранных элементах есть одинаковые имена');
    if ([...jobs.values()].filter(job => job.status === 'running').length >= MAX_RUNNING_JOBS) throw new UserError('Уже выполняется несколько операций — дождитесь завершения', 429);

    const id = crypto.randomBytes(8).toString('hex');
    const job = {
      id, mode, name: items.length === 1 ? items[0].name : `${items.length} элем.`, status: 'running', phase: 'scan',
      total: 0, done: 0, files: 0, moved: 0, skipped: [], skippedCount: 0, message: '', scanned: 0, tempCounter: 0,
      startedAt: Date.now(), abort: new AbortController(),
    };
    jobs.set(id, job);
    runJob(job, items, destFolder, mode); // выполняется в фоне
    audit(req.user, mode === 'move' ? 'file_move' : 'file_copy', `${relatives.slice(0, 3).join(', ')}${relatives.length > 3 ? '…' : ''} → ${dest.path || '/'}`);
    sendJson(res, 200, { job: id });
  }));

  const publicJob = job => { const { abort, scanned, tempCounter, ...visible } = job; return visible; };

  app.get('/api/transfer/:id', route(async (req, res) => {
    const job = jobs.get(String(req.params.id));
    if (!job) throw new UserError('Операция не найдена', 404);
    sendJson(res, 200, publicJob(job));
  }));

  app.delete('/api/transfer/:id', route(async (req, res) => {
    const job = jobs.get(String(req.params.id));
    if (!job) throw new UserError('Операция не найдена', 404);
    job.abort.abort();
    sendJson(res, 200, { ok: true });
  }));
}

module.exports = { registerTransferRoutes };
