'use strict';
// Маршруты приложений: список, создание, изменение, запуск/остановка, консоль, логи, профили запуска,
// конструктор запуска, среды выполнения (Java, Node…), автоопределение проектов.
const fs = require('fs');
const path = require('path');
const { describeFsError } = require('../safe-paths');

module.exports = function registerAppRoutes({ app, db, procs, jobs, audit, LB, appConfig, processes, systemStats }) {
  const { appById, num, APP_COLS, appInput, cleanEnv, parseEnv, runtime, infer, detectProject, scanProject } = appConfig;
  const { allApps, stat, stop, restart, startWithDeps, runningDependents, waitForExit, portFree, logFile, logFlush, logClear, tailFile } = processes;
  const { posixStats, winStats } = systemStats;
app.get('/api/apps', (req, res) => res.json(allApps()));
app.get('/api/apps/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM apps WHERE id=?').get(+req.params.id);
  if (!a)
    return res.status(404).json({ error: 'Не найдено' });
  res.json({ ...a, ...stat(a), profiles: db.prepare('SELECT * FROM profiles WHERE app_id=? ORDER BY id').all(a.id) });
});
app.post('/api/apps', (req, res) => {
  try {
    const v = appInput(req.body || {}, null, 0);
    const x = db.prepare(`INSERT INTO apps(${APP_COLS.join(',')}) VALUES(${APP_COLS.map(() => '?').join(',')})`).run(...APP_COLS.map(c => v[c]));
    const a = appById(x.lastInsertRowid);
    audit(req.user, 'app_create', a.name);
    res.json(a);
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/apps/import', (req, res) => {
  try {
    const b = req.body || {}, d = scanProject(b.working_dir);
    const c = d.candidates[Number.isInteger(+b.candidate) ? +b.candidate : 0];
    if (!c || !c.command)
      return res.status(400).json({ error: 'Не выбран способ запуска' });
    const name = b.name || path.basename(d.cwd) || 'Новое приложение';
    const x = db.prepare(`INSERT INTO apps(name,type,command,working_dir,runtime,runtime_path,stop_command,env_json,auto_start,auto_restart,restart_delay,max_restarts,port) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(name, c.type, c.command, d.cwd, c.runtime || '', b.runtime_path || '', b.stop_command || '', JSON.stringify(b.env || {}), b.auto_start ? 1 : 0, b.auto_restart ? 1 : 0, num(b.restart_delay, 5), num(b.max_restarts, 5), num(b.port, null, 1));
    const a = db.prepare('SELECT * FROM apps WHERE id=?').get(x.lastInsertRowid);
    audit(req.user, 'app_import', `${a.name}: ${c.label}`);
    res.json({ ...a, detected: d, candidate: c });
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/apps/:id', (req, res) => {
  try {
    const id = +req.params.id, o = appById(id);
    if (!o)
      return res.status(404).json({ error: 'Не найдено' });
    if (procs.has(id))
      return res.status(409).json({ error: 'Сначала остановите приложение' });
    const v = appInput(req.body || {}, o, id);
    db.prepare(`UPDATE apps SET ${APP_COLS.map(c => c + '=?').join(',')} WHERE id=?`).run(...APP_COLS.map(c => v[c]), id);
    audit(req.user, 'app_update', v.name);
    res.json(appById(id));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/apps/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM apps WHERE id=?').get(+req.params.id);
  if (!a)
    return res.status(404).json({ error: 'Не найдено' });
  stop(a, true);
  db.prepare('DELETE FROM profiles WHERE app_id=?').run(a.id);
  for (const t of db.prepare('SELECT id FROM tasks WHERE app_id=?').all(a.id)) {
    jobs.get(t.id)?.stop();
    jobs.delete(t.id);
  }
  db.prepare('DELETE FROM tasks WHERE app_id=?').run(a.id);
  db.prepare('DELETE FROM apps WHERE id=?').run(a.id);
  audit(req.user, 'app_delete', a.name);
  res.json({ ok: true });
});
app.post('/api/apps/:id/start', async (req, res) => {
  try {
    const a = appById(+req.params.id);
    if (!a)
      return res.status(404).json({ error: 'Не найдено' });
    await startWithDeps(a);
    audit(req.user, 'start', a.name);
    res.json({ ok: true });
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
for (const [route, fn] of [['stop', a => stop(a)], ['kill', a => stop(a, true)]])
  app.post(`/api/apps/:id/${route}`, (req, res) => {
    try {
      const a = appById(+req.params.id);
      if (!a)
        return res.status(404).json({ error: 'Не найдено' });
      const was = procs.has(a.id);
      fn(a);
      audit(req.user, route, a.name);
      const deps = was ? runningDependents(a.id) : [];
      res.json({ ok: true, warning: deps.length ? `Работают зависимые приложения: ${deps.join(', ')}` : undefined });
    }
    catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
// --- M6: конструктор запуска ---
app.get('/api/launch/presets', (req, res) => res.json(LB.PRESETS));
app.post('/api/launch/preview', (req, res) => {
  try {
    res.json({ command: LB.buildCommand(req.body?.launch || {}, num(req.body?.port, null, 1)) });
  }
  catch (e) {
    res.json({ command: '', error: e.message });
  }
});
app.get('/api/launch/inspect', (req, res) => {
  try {
    res.json(LB.inspect(path.resolve(String(req.query.cwd || ''))));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/port-check', async (req, res) => {
  const port = num(req.query.port, 0, 0);
  if (!port || port > 65535)
    return res.status(400).json({ error: 'Некорректный порт' });
  const ex = num(req.query.exclude, 0, 0), self = !!(ex && procs.has(ex));
  res.json({ port, self, free: self ? true : await portFree(port), others: db.prepare('SELECT id,name FROM apps WHERE port=? AND id!=?').all(port, ex) });
});
app.post('/api/apps/:id/restart', async (req, res) => {
  try {
    const a = db.prepare('SELECT * FROM apps WHERE id=?').get(+req.params.id);
    if (!a)
      return res.status(404).json({ error: 'Не найдено' });
    await restart(a);
    audit(req.user, 'restart', a.name);
    res.json({ ok: true });
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/apps/:id/command', (req, res) => {
  const s = procs.get(+req.params.id);
  if (!s?.child.stdin.writable)
    return res.status(400).json({ error: 'Процесс не принимает команды' });
  s.child.stdin.write(String(req.body.command || '') + '\n');
  res.json({ ok: true });
});
app.get('/api/apps/:id/output', (req, res) => {
  const s = procs.get(+req.params.id);
  res.json(s?.history || []);
});

app.get('/api/apps/:id/stats', async (req, res) => {
  const a = db.prepare('SELECT * FROM apps WHERE id=?').get(+req.params.id), s = procs.get(a?.id);
  if (!s)
    return res.json({ cpu: 0, memory: 0 });
  try {
    res.json(process.platform === 'win32' ? await winStats(s.child.pid) : await posixStats(s.child.pid));
  }
  catch (e) {
    console.warn('stats error:', e.message);
    res.json({ cpu: 0, memory: 0, error: e.message });
  }
});

app.get('/api/runtimes', (req, res) => res.json(runtime(req.query.refresh === '1')));
app.post('/api/runtimes/suggest', (req, res) => {
  const rt = runtime();
  res.json(infer(req.body.command, req.body.cwd).map(k => ({ key: k, candidates: rt.filter(x => x.key === k) })));
});
app.post('/api/detect', (req, res) => {
  try {
    const d = detectProject(req.body.cwd);
    d.runtimes = runtime().filter(x => x.key === d.runtime);
    res.json(d);
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/scan', (req, res) => {
  try {
    res.json(scanProject(req.body.cwd));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const sameEnv = (a, b) => {
  const x = parseEnv(a), y = parseEnv(b), kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
  return kx.length === ky.length && kx.every((k, i) => k === ky[i] && String(x[k]) === String(y[k]));
};
const profActive = (a, p) => p.command === a.command && (p.runtime_path || '') === (a.runtime_path || '') && sameEnv(p.env_json, a.env_json);
const profilesOf = a => db.prepare('SELECT * FROM profiles WHERE app_id=? ORDER BY id').all(a.id).map(p => ({ ...p, active: profActive(a, p) }));
app.get('/api/apps/:id/profiles', (req, res) => {
  const a = appById(+req.params.id);
  if (!a)
    return res.status(404).json({ error: 'Приложение не найдено' });
  res.json(profilesOf(a));
});
app.post('/api/apps/:id/profiles', (req, res) => {
  try {
    const a = appById(+req.params.id);
    if (!a)
      return res.status(404).json({ error: 'Приложение не найдено' });
    const b = req.body || {}, name = String(b.name || '').trim();
    if (!name)
      throw Error('Введите название профиля');
    if (db.prepare('SELECT 1 FROM profiles WHERE app_id=? AND name=?').get(a.id, name))
      throw Error('Профиль с таким названием уже есть');
    let command, rp, env, launch;
    if (b.from_current) {
      command = a.command;
      rp = a.runtime_path || '';
      env = a.env_json || '{}';
      launch = a.launch_json || '';
    }
    else {
      command = String(b.command || '').trim();
      if (!command)
        throw Error('Введите команду запуска');
      rp = String(b.runtime_path || '').trim();
      env = JSON.stringify(cleanEnv(b.env));
      launch = '';
    }
    const x = db.prepare('INSERT INTO profiles(app_id,name,command,runtime_path,env_json,note,launch_json) VALUES(?,?,?,?,?,?,?)').run(a.id, name, command, rp, env, String(b.note || '').trim().slice(0, 300), launch);
    audit(req.user, 'profile_create', `${a.name}: ${name}`);
    res.json(db.prepare('SELECT * FROM profiles WHERE id=?').get(x.lastInsertRowid));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/profiles/:id', (req, res) => {
  try {
    const id = +req.params.id, b = req.body || {}, old = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
    if (!old)
      return res.status(404).json({ error: 'Профиль не найден' });
    const name = String(b.name ?? old.name).trim(), command = String(b.command ?? old.command).trim();
    if (!name)
      throw Error('Введите название профиля');
    if (!command)
      throw Error('Введите команду запуска');
    if (name !== old.name && db.prepare('SELECT 1 FROM profiles WHERE app_id=? AND name=? AND id!=?').get(old.app_id, name, id))
      throw Error('Профиль с таким названием уже есть');
    const env = b.env !== undefined ? JSON.stringify(cleanEnv(b.env)) : old.env_json;
    db.prepare('UPDATE profiles SET name=?,command=?,runtime_path=?,env_json=?,note=?,launch_json=? WHERE id=?').run(name, command, String(b.runtime_path ?? old.runtime_path ?? '').trim(), env, String(b.note ?? old.note ?? '').trim().slice(0, 300), command !== old.command ? '' : (old.launch_json || ''), id);
    audit(req.user, 'profile_update', `#${old.app_id}: ${name}`);
    res.json(db.prepare('SELECT * FROM profiles WHERE id=?').get(id));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/profiles/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id=?').get(+req.params.id);
  db.prepare('DELETE FROM profiles WHERE id=?').run(+req.params.id);
  if (p)
    audit(req.user, 'profile_delete', `#${p.app_id}: ${p.name}`);
  res.json({ ok: true });
});
app.post('/api/apps/:id/profiles/:profileId/apply', async (req, res) => {
  try {
    const a = appById(+req.params.id), p = db.prepare('SELECT * FROM profiles WHERE id=? AND app_id=?').get(+req.params.profileId, +req.params.id);
    if (!a || !p)
      return res.status(404).json({ error: 'Не найдено' });
    const running = procs.has(a.id), again = !!(req.body && req.body.restart);
    if (running && !again)
      return res.status(409).json({ error: 'Приложение запущено. Остановите его или выберите «Применить и перезапустить».', running: true });
    if (running) {
      stop(a, false);
      if (!(await waitForExit(a.id, 62000))) {
        stop(a, true);
        await waitForExit(a.id, 3000);
      }
    }
    db.prepare('UPDATE apps SET command=?,runtime_path=?,env_json=?,launch_json=? WHERE id=?').run(p.command, p.runtime_path, p.env_json, p.launch_json || '', a.id);
    audit(req.user, 'profile_apply', `${a.name}: ${p.name}`);
    if (running)
      await startWithDeps(appById(a.id));
    res.json({ ...appById(a.id), restarted: running });
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/apps/:id/log', (req, res) => {
  try {
    const f = logFile(+req.params.id);
    logFlush(+req.params.id);
    if (!fs.existsSync(f))
      return res.type('text').send('');
    const kb = Math.min(4096, Math.max(16, num(req.query.kb, 256, 1)));
    res.type('text').send(tailFile(f, kb * 1024));
  }
  catch (e) {
    res.status(400).json({ error: describeFsError(e) });
  }
});
app.delete('/api/apps/:id/log', (req, res) => {
  try {
    logClear(+req.params.id);
    res.json({ ok: true });
  }
  catch (e) {
    res.status(400).json({ error: describeFsError(e) });
  }
});


};
