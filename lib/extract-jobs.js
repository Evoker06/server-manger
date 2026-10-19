'use strict';
// Распаковка архивов (zip, tar, 7z…) в фоне: безопасно, с защитой от «бомб» и выхода за пределы папки.
const fs = require('fs');
const path = require('path');
const { describeFsError, scopeOf } = require('./safe-paths');
const ARC = require('./archive');

module.exports = function registerExtractRoutes({ app, cfg, audit, pathGuard, fmtBytes }) {
const extracts = new Map();
const exLimits = () => ({ bytes: Math.round((cfg.maxExtractMb || (cfg.maxExtractGb || 20) * 1024) * 1048576), files: cfg.maxExtractFiles || 300000 }); // защита от «архивных бомб»
app.get('/api/extract/tools', async (req, res) => {
  try {
    res.json(await ARC.toolSummary());
  }
  catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/extract', async (req, res) => {
  try {
    const b = req.body || {}, root = path.resolve(pathGuard.resolveRoot(scopeOf(req), req.user)), archive = pathGuard.resolveInside(root, b.path), st = fs.statSync(archive);
    if (!st.isFile())
      throw Error('Это не файл');
    const name = path.basename(archive), parent = path.dirname(archive), mode = b.mode === 'here' ? 'here' : 'folder';
    if (!ARC.classify(archive, name))
      throw Error('Файл не похож на архив или формат не распознан');
    let destDir = parent;
    if (mode === 'folder') {
      const base = ARC.baseName(name);
      let n = base, i = 2;
      while (fs.existsSync(path.join(parent, n)))
        n = `${base} (${i++})`;
      destDir = path.join(parent, n);
    }
    pathGuard.resolveInside(root, path.relative(root, destDir)); // та же проверка путей, что и у остальных операций
    if ([...extracts.values()].filter(j => j.status === 'running').length >= 2)
      throw Error('Уже выполняются две распаковки — дождитесь завершения');
    const fsStat = await fs.promises.statfs(parent);
    if (fsStat.bavail * fsStat.bsize < Math.max(st.size * 2, 256 * 1048576))
      throw Error(`Недостаточно места на диске (свободно ${fmtBytes(fsStat.bavail * fsStat.bsize)})`);
    const id = require('crypto').randomBytes(8).toString('hex'), stage = path.join(parent, '.sm-extract-' + id);
    const job = { id, name, status: 'running', phase: 'extract', files: 0, bytes: 0, links: 0, skipped: 0, message: '', tool: '', format: '', dest: path.relative(root, destDir).split(path.sep).join('/') };
    extracts.set(id, job);
    (async () => {
      try {
        await ARC.extractToStage({ archive, name, stage, limits: exLimits(), progress: job });
        job.phase = 'place';
        const pl = ARC.place(stage, destDir, { overwrite: !!b.overwrite, flatten: mode === 'folder', deny: pathGuard.isProtectedPath });
        if (pl.files != null)
          job.files = pl.files;
        job.skipped = pl.skipped;
        job.status = 'done';
        job.phase = 'done';
        job.message = `Распаковано файлов: ${job.files} (${fmtBytes(job.bytes)})` + (job.skipped ? `. Пропущено существующих или защищённых файлов: ${job.skipped}` : '') + (job.links ? `. Символические ссылки в архиве не создавались: ${job.links}` : '');
      }
      catch (e) {
        job.status = 'error';
        job.message = describeFsError(e);
      }
      finally {
        try {
          fs.rmSync(stage, { recursive: true, force: true });
        }
        catch {
        }
        setTimeout(() => extracts.delete(id), 600000).unref();
      }
    })();
    audit(req.user, 'extract', `${archive} → ${destDir}`);
    res.json({ job: id });
  }
  catch (e) {
    res.status(400).json({ error: describeFsError(e) });
  }
});
app.get('/api/extract/:id', (req, res) => {
  const j = extracts.get(String(req.params.id));
  if (!j)
    return res.status(404).json({ error: 'Операция не найдена' });
  res.json(j);
});


};
