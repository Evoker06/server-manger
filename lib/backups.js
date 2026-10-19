'use strict';
// Резервные копии приложений (ZIP): создание с паузой сохранения мира Minecraft, восстановление, список, удаление.
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { describeFsError } = require('./safe-paths');

module.exports = function createBackups({ app, db, procs, events, audit, paths, appConfig }) {
  const { BACKUP_ROOT, LOG_ROOT, ROOT } = paths;
  const { appById, num } = appConfig;
const BK_RE = /^app-(\d+)-(\d+)(?:-([a-z]+))?\.zip$/;
const fmtBytes = n => n < 1048576 ? (n / 1024).toFixed(0) + ' КБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1073741824).toFixed(2) + ' ГБ';
function listBackups(appId) {
  return fs.readdirSync(BACKUP_ROOT).filter(n => /\.zip$/i.test(n)).map(n => {
    const m = BK_RE.exec(n);
    if (appId && (!m || +m[1] !== appId))
      return null;
    let s;
    try {
      s = fs.statSync(path.join(BACKUP_ROOT, n));
    }
    catch {
      return null;
    }
    return { name: n, app_id: m ? +m[1] : null, tag: m && m[3] || '', size: s.size, modified: s.mtime };
  }).filter(Boolean).sort((a, b) => b.modified - a.modified);
}
// оставляем keep последних обычных копий (страховочные «pre» не трогаем)
function pruneBackups(appId, keep) {
  const old = listBackups(appId).filter(b => !b.tag).slice(keep);
  let n = 0;
  for (const b of old) {
    try {
      fs.rmSync(path.join(BACKUP_ROOT, b.name), { force: true });
      n++;
    }
    catch {
    }
  }
  return n;
}
const backingUp = new Set();
const isMc = a => a.type === 'minecraft' || /minecraft|paper|spigot|purpur|folia|fabric|forge|neoforge/i.test((a.command || '') + (a.launch_json || ''));
function waitOutput(id, re, ms) {
  return new Promise(res => {
    const h = x => {
      if (x.id === id && re.test(String(x.data))) {
        clearTimeout(t);
        events.off('output', h);
        res(true);
      }
    };
    const t = setTimeout(() => {
      events.off('output', h);
      res(false);
    }, ms);
    events.on('output', h);
  });
}
// чтобы мир в архиве был целым: save-off + save-all flush
async function mcFlush(appRecord) {
  const s = procs.get(appRecord.id);
  if (!s || !s.child.stdin.writable)
    return false;
  const w = c => {
    try {
      s.child.stdin.write(c + '\n');
    }
    catch {
    }
  };
  let p = waitOutput(appRecord.id, /Automatic saving is now disabled|Saving is already turned off/i, 6000);
  w('save-off');
  await p;
  p = waitOutput(appRecord.id, /Saved the (game|world)/i, 40000);
  w('save-all flush');
  await p;
  return true;
}
function mcResume(appRecord) {
  const s = procs.get(appRecord.id);
  if (s && s.child.stdin.writable)
    try {
      s.child.stdin.write('save-on\n');
    }
    catch {
    }
}
async function createBackup(appRecord, opt = {}) {
  const source = path.resolve(appRecord.working_dir);
  if (!fs.existsSync(source))
    throw Error('Рабочая папка не найдена: ' + source);
  if (backingUp.has(appRecord.id))
    throw Error('Backup этого приложения уже создаётся');
  backingUp.add(appRecord.id);
  const name = `app-${appRecord.id}-${Date.now()}${opt.tag ? '-' + opt.tag : ''}.zip`, dest = path.join(BACKUP_ROOT, name), part = dest + '.partial';
  const skipped = [], bRoot = path.resolve(BACKUP_ROOT), lRoot = path.resolve(LOG_ROOT), uRoot = path.join(ROOT, '.uploads');
  const skipDir = full => full === bRoot || full === lRoot || full === uRoot || path.basename(full) === '.sm-old' || path.basename(full).startsWith('.sm-extract-');
  let flushed = false;
  try {
    flushed = isMc(appRecord) && procs.has(appRecord.id) && await mcFlush(appRecord);
    const out = fs.createWriteStream(part), zip = archiver('zip', { zlib: { level: 6 } });
    const closed = new Promise((res, rej) => {
      out.on('close', res);
      out.on('error', rej);
      zip.on('error', rej);
    });
    closed.catch(() => {
    });
    zip.on('warning', w => skipped.push(String(w.message || w)));
    zip.pipe(out);
    let cnt = 0;
    const walk = async (dir, rel) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      }
      catch {
        skipped.push(rel || '.');
        return;
      }
      for (const e of ents) {
        if (++cnt % 200 === 0)
          await new Promise(r => setImmediate(r)); // отдаём управление, чтобы панель не «замирала» на больших папках
        const full = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if (skipDir(full))
            continue;
          zip.append(null, { name: r + '/' });
          await walk(full, r);
        }
        else if (e.isFile()) {
          if (e.name === 'session.lock')
            continue; // Minecraft пересоздаёт; в Windows файл заблокирован
          try {
            const fd = fs.openSync(full, 'r');
            try {
              fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
            }
            finally {
              fs.closeSync(fd);
            }
          }
          catch {
            skipped.push(r);
            continue;
          } // занятые файлы пропускаем, а не рушим весь backup
          zip.file(full, { name: r });
        }
      }
    };
    try {
      await walk(source, '');
      zip.finalize();
      await closed;
    }
    catch (e) {
      try {
        zip.abort();
      }
      catch {
      }
      out.destroy();
      throw e;
    }
    fs.renameSync(part, dest);
  }
  catch (e) {
    try {
      fs.rmSync(part, { force: true });
    }
    catch {
    }
    throw e;
  }
  finally {
    backingUp.delete(appRecord.id);
    if (flushed)
      mcResume(appRecord);
  }
  return { name, path: dest, size: fs.statSync(dest).size, modified: new Date().toISOString(), skipped };
}
async function restoreBackup(appRecord, file) {
  const nm = path.basename(String(file || '')), m = BK_RE.exec(nm);
  if (!m || +m[1] !== appRecord.id)
    throw Error('Этот backup создан для другого приложения');
  const abs = path.resolve(BACKUP_ROOT, nm);
  if (!fs.existsSync(abs))
    throw Error('Backup не найден');
  const target = path.resolve(appRecord.working_dir);
  fs.mkdirSync(target, { recursive: true });
  const safety = await createBackup(appRecord, { tag: 'pre' }); // страховка: текущее состояние сохраняется перед восстановлением
  const dir = await unzipper.Open.file(abs);
  for (const entry of dir.files) {
    const dest = path.resolve(target, entry.path);
    if (dest !== target && !dest.startsWith(target + path.sep))
      throw Error('Backup содержит недопустимый путь');
    if (entry.type === 'Directory') {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => entry.stream().pipe(fs.createWriteStream(dest)).on('finish', resolve).on('error', reject));
  }
  return { safety: safety.name };
}

app.post('/api/apps/:id/backup', async (req, res) => {
  try {
    const a = appById(+req.params.id);
    if (!a)
      return res.status(404).json({ error: 'Не найдено' });
    const b = await createBackup(a);
    const keep = num(req.body && req.body.keep, 0, 0);
    if (keep)
      pruneBackups(a.id, keep);
    audit(req.user, 'backup_create', `${a.name}: ${b.name}`);
    res.json({ name: b.name, size: b.size, modified: b.modified, skipped: b.skipped });
  }
  catch (e) {
    res.status(400).json({ error: describeFsError(e) });
  }
});
app.post('/api/apps/:id/restore', async (req, res) => {
  try {
    const a = appById(+req.params.id);
    if (!a)
      return res.status(404).json({ error: 'Не найдено' });
    if (procs.has(a.id))
      return res.status(409).json({ error: 'Сначала остановите приложение' });
    const x = await restoreBackup(a, req.body && req.body.name);
    audit(req.user, 'backup_restore', `${a.name}: ${req.body.name}`);
    res.json({ ok: true, safety: x.safety });
  }
  catch (e) {
    res.status(400).json({ error: describeFsError(e) });
  }
});
app.get('/api/backups', (req, res) => {
  try {
    res.json(listBackups(+req.query.app || 0));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/backups/:name', (req, res) => {
  try {
    const n = path.basename(req.params.name);
    if (!/\.zip$/i.test(n))
      throw Error('Недопустимый файл');
    fs.rmSync(path.join(BACKUP_ROOT, n), { force: true });
    audit(req.user, 'backup_delete', n);
    res.json({ ok: true });
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});


  return { createBackup, restoreBackup, listBackups, pruneBackups, fmtBytes };
};
