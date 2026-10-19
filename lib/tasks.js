'use strict';
// Задачи по расписанию (cron): запуск, остановка, перезапуск, резервные копии и команды в консоль.
const cron = require('node-cron');

module.exports = function createTasks({ app, db, procs, cronJobs, broadcast, audit, appConfig, processes, backups }) {
  const jobs = cronJobs;
  const { appById, num } = appConfig;
  const { restart, startWithDeps, stop } = processes;
  const { createBackup, pruneBackups, fmtBytes } = backups;
const TASK_ACTIONS = ['start', 'stop', 'restart', 'backup', 'command'];
const taskBusy = new Set();
function parseField(s, min, max, sun) {
  const set = new Set();
  for (const part of String(s).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m)
      return null;
    let lo, hi;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    }
    else if (m[1].includes('-')) {
      [lo, hi] = m[1].split('-').map(Number);
    }
    else {
      lo = +m[1];
      hi = m[2] ? max : lo;
    }
    const st = m[2] ? +m[2] : 1;
    if (!st || lo < min || hi > max || lo > hi)
      return null;
    for (let v = lo; v <= hi; v += st)
      set.add(sun && v === 7 ? 0 : v);
  }
  return set;
}
const lt = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
// ближайшие запуски для 5-польного cron (локальное время сервера)
function nextRuns(expr, n = 3) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5)
    return [];
  const mi = parseField(f[0], 0, 59), ho = parseField(f[1], 0, 23), dm = parseField(f[2], 1, 31), mo = parseField(f[3], 1, 12), dw = parseField(f[4], 0, 7, true);
  if (!mi || !ho || !dm || !mo || !dw)
    return [];
  const out = [], d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 600000 && out.length < n; i++) {
    if (!mo.has(d.getMonth() + 1) || !dm.has(d.getDate()) || !dw.has(d.getDay())) {
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      continue;
    }
    if (!ho.has(d.getHours())) {
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
      continue;
    }
    if (mi.has(d.getMinutes()))
      out.push(lt(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}
async function runTask(t, by = 'расписание') {
  if (taskBusy.has(t.id))
    return;
  taskBusy.add(t.id);
  let status = 'ok', msg = '';
  try {
    const a = appById(t.app_id);
    if (!a)
      throw Error('Приложение удалено');
    const on = procs.has(a.id);
    if (t.action === 'start') {
      if (on)
        msg = 'Уже запущено — пропущено';
      else {
        await startWithDeps(a);
        msg = 'Запущено';
      }
    }
    else if (t.action === 'stop') {
      if (!on)
        msg = 'Не запущено — пропущено';
      else {
        stop(a);
        msg = 'Команда остановки отправлена';
      }
    }
    else if (t.action === 'restart') {
      await restart(a);
      msg = 'Перезапущено';
    }
    else if (t.action === 'backup') {
      const b = await createBackup(a);
      const pr = t.keep > 0 ? pruneBackups(a.id, t.keep) : 0;
      msg = `${b.name} (${fmtBytes(b.size)})${b.skipped.length ? `; пропущено занятых файлов: ${b.skipped.length}` : ''}${pr ? `; удалено старых копий: ${pr}` : ''}`;
    }
    else if (t.action === 'command') {
      const s = procs.get(a.id);
      if (!s || !s.child.stdin.writable)
        throw Error('Приложение не запущено');
      s.child.stdin.write(String(t.payload || '') + '\n');
      msg = 'Команда отправлена';
    }
    else
      throw Error('Неизвестное действие');
  }
  catch (e) {
    status = 'error';
    msg = e.message;
    broadcast({ type: 'task_error', id: t.id, error: e.message });
  }
  finally {
    taskBusy.delete(t.id);
  }
  db.prepare('UPDATE tasks SET last_run=?,last_status=?,last_message=? WHERE id=?').run(lt(new Date()), status, String(msg).slice(0, 400), t.id);
  audit({ username: by }, 'task_run', `${t.name}: ${status === 'ok' ? 'OK' : 'ОШИБКА'} — ${msg}`);
}
function registerTask(t) {
  jobs.get(t.id)?.stop();
  jobs.delete(t.id);
  if (!t.enabled || !cron.validate(t.cron))
    return;
  jobs.set(t.id, cron.schedule(t.cron, () => {
    const cur = db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id);
    if (cur && cur.enabled)
      runTask(cur);
  }));
}
const taskOut = t => ({ ...t, enabled: !!t.enabled, next: t.enabled ? (nextRuns(t.cron, 1)[0] || null) : null, running: taskBusy.has(t.id) });
function taskInput(b, o) {
  const name = String(b.name ?? o?.name ?? '').trim();
  if (!name)
    throw Error('Название обязательно');
  const cr = String(b.cron ?? o?.cron ?? '').trim().replace(/\s+/g, ' ');
  if (cr.split(' ').length !== 5 || !cron.validate(cr))
    throw Error('Некорректное расписание (нужен cron из 5 полей)');
  const action = String(b.action ?? o?.action ?? '');
  if (!TASK_ACTIONS.includes(action))
    throw Error('Недопустимое действие');
  const app_id = +(b.app_id ?? o?.app_id);
  if (!appById(app_id))
    throw Error('Приложение не найдено');
  const payload = String(b.payload ?? o?.payload ?? '').trim();
  if (action === 'command' && !payload)
    throw Error('Введите команду для консоли');
  const keep = action === 'backup' ? Math.min(1000, num(b.keep, o ? o.keep : 0, 0)) : 0;
  const enabled = b.enabled === undefined ? (o ? o.enabled : 1) : (b.enabled ? 1 : 0);
  return { name, cron: cr, action, app_id, payload: action === 'command' ? payload : '', keep, enabled };
}
app.get('/api/tasks', (req, res) => res.json(db.prepare('SELECT * FROM tasks ORDER BY id DESC').all().map(taskOut)));
app.get('/api/tasks/preview', (req, res) => res.json({ next: nextRuns(String(req.query.cron || ''), 3) }));
app.post('/api/tasks', (req, res) => {
  try {
    const v = taskInput(req.body || {}, null);
    const x = db.prepare('INSERT INTO tasks(name,cron,app_id,action,enabled,payload,keep) VALUES(?,?,?,?,?,?,?)').run(v.name, v.cron, v.app_id, v.action, v.enabled, v.payload, v.keep);
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(x.lastInsertRowid);
    registerTask(t);
    audit(req.user, 'task_create', t.name);
    res.json(taskOut(t));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/tasks/:id', (req, res) => {
  try {
    const id = +req.params.id, o = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!o)
      return res.status(404).json({ error: 'Задача не найдена' });
    const v = taskInput(req.body || {}, o);
    db.prepare('UPDATE tasks SET name=?,cron=?,app_id=?,action=?,enabled=?,payload=?,keep=? WHERE id=?').run(v.name, v.cron, v.app_id, v.action, v.enabled, v.payload, v.keep, id);
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    registerTask(t);
    audit(req.user, 'task_update', t.name);
    res.json(taskOut(t));
  }
  catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/tasks/:id/run', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+req.params.id);
  if (!t)
    return res.status(404).json({ error: 'Задача не найдена' });
  if (taskBusy.has(t.id))
    return res.status(409).json({ error: 'Задача уже выполняется' });
  runTask(t, req.user.username + ' (вручную)');
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', (req, res) => {
  const id = +req.params.id;
  jobs.get(id)?.stop();
  jobs.delete(id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  res.json({ ok: true });
});


  return { registerTask };
};
