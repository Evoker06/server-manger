'use strict';
// Запуск, остановка и перезапуск приложений; вывод консоли, лог-файлы с ротацией; зависимости между приложениями.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

module.exports = function createProcesses({ db, procs, broadcast, paths, LB, appConfig }) {
  const LOG_ROOT = paths.LOG_ROOT;
  const { parseEnv, parseDeps, appById, checkDeps } = appConfig;
function stat(appRecord) {
  const s = procs.get(appRecord.id);
  return { running: !!s, pid: s?.child.pid || null, uptime: s ? Date.now() - s.startedAt : 0, restarts: s?.restarts || 0 };
}
function allApps() {
  return db.prepare('SELECT * FROM apps ORDER BY id DESC').all().map(a => ({ ...a, ...stat(a) }));
}

const logBuf = new Map(), logSize = new Map(), LOG_MAX = 10 * 1024 * 1024;
function logFile(id) {
  return path.join(LOG_ROOT, `app-${id}.log`);
}
const logQ = new Map();
let logTimer = null;
function logRaw(id, text) {
  logQ.set(id, (logQ.get(id) || '') + text);
  if (!logTimer) {
    logTimer = setTimeout(logFlushAll, 250);
    logTimer.unref();
  }
} // пишем пачками раз в 250 мс, а не на каждый кусок вывода
function logFlush(id) {
  const t = logQ.get(id);
  if (!t)
    return;
  logQ.delete(id);
  const f = logFile(id);
  try {
    let sz = logSize.get(id);
    if (sz === undefined) {
      try {
        sz = fs.statSync(f).size;
      }
      catch {
        sz = 0;
      }
    }
    if (sz > LOG_MAX) {
      try {
        fs.renameSync(f, f + '.1');
      }
      catch {
      }
      sz = 0;
    }
    fs.appendFileSync(f, t, 'utf8');
    logSize.set(id, sz + Buffer.byteLength(t));
  }
  catch {
  }
}
function logFlushAll() {
  clearTimeout(logTimer);
  logTimer = null;
  for (const id of [...logQ.keys()])
    logFlush(id);
}
process.on('exit', logFlushAll);
function logWrite(id, stream, text) {
  const ts = new Date().toISOString();
  if (stream === 'system')
    for (const s of ['stdout', 'stderr']) {
      const k = id + ':' + s, rest = logBuf.get(k);
      if (rest) {
        logBuf.set(k, '');
        logRaw(id, `[${ts}] [${s}] ${rest}\n`);
      }
    }
  const k = id + ':' + stream, parts = ((logBuf.get(k) || '') + text).split(/\r?\n/);
  logBuf.set(k, parts.pop());
  if (parts.length)
    logRaw(id, parts.map(l => `[${ts}] [${stream}] ${l}`).join('\n') + '\n');
}
function logClear(id) {
  for (const s of ['stdout', 'stderr', 'system'])
    logBuf.delete(id + ':' + s);
  logSize.delete(id);
  logQ.delete(id);
  for (const f of [logFile(id), logFile(id) + '.1'])
    try {
      fs.rmSync(f, { force: true });
    }
    catch {
    }
}
function tailFile(file, maxBytes) {
  const st = fs.statSync(file), len = Math.min(st.size, maxBytes), fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let t = buf.toString('utf8');
    if (st.size > len) {
      const nl = t.indexOf('\n');
      t = nl >= 0 ? t.slice(nl + 1) : t;
    }
    return t;
  }
  finally {
    fs.closeSync(fd);
  }
}
function appendOutput(id, stream, data) {
  const text = String(data ?? '');
  const s = procs.get(id);
  if (s) {
    s.history.push({ stream, data: text, time: Date.now() });
    if (s.history.length > 500)
      s.history.shift();
  }
  logWrite(id, stream, text);
  broadcast({ type: 'output', id, stream, data: text });
}
function start(appRecord, existingState = null) {
  if (procs.has(appRecord.id))
    throw Error('Уже запущено');
  const cwd = path.resolve(appRecord.working_dir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
    throw Error('Рабочая папка не найдена: ' + cwd + (process.platform === 'win32' && !fs.existsSync(path.parse(cwd).root) ? ` (диск ${path.parse(cwd).root} недоступен)` : ''));
  const env = { ...process.env, ...LB.launchEnv(appRecord), ...parseEnv(appRecord.env_json) };
  if (appRecord.runtime_path) {
    let st;
    try {
      st = fs.statSync(appRecord.runtime_path);
    }
    catch {
      throw Error('Runtime не найден: ' + appRecord.runtime_path);
    }
    const runtimeDir = st.isDirectory() ? appRecord.runtime_path : path.dirname(appRecord.runtime_path);
    const pk = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pk] = runtimeDir + path.delimiter + (env[pk] || '');
  }
  const state = existingState || { restarts: 0, history: [], startedAt: Date.now(), stableTimer: null, manualStop: false };
  state.manualStop = false;
  state.startedAt = Date.now();
  const child = spawn(appRecord.command, { cwd, shell: true, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  state.child = child;
  procs.set(appRecord.id, state);
  appendOutput(appRecord.id, 'system', `[Server Manager] Запуск PID ${child.pid}\n`);
  child.stdout.on('data', d => appendOutput(appRecord.id, 'stdout', d));
  child.stderr.on('data', d => appendOutput(appRecord.id, 'stderr', d));
  child.on('error', err => appendOutput(appRecord.id, 'stderr', `[process error] ${err.message}\n`));
  child.stdin.on('error', () => {
  });
  state.stableTimer = setTimeout(() => {
    state.restarts = 0;
  }, 30000);
  child.on('close', code => {
    clearTimeout(state.stableTimer);
    clearTimeout(state.killTimer);
    procs.delete(appRecord.id);
    broadcast({ type: 'exit', id: appRecord.id, code });
    appendOutput(appRecord.id, 'system', `[Server Manager] Процесс завершён с кодом ${code}\n`);
    if (!state.manualStop && appRecord.auto_restart && state.restarts < appRecord.max_restarts) {
      state.restarts++;
      appendOutput(appRecord.id, 'system', `[Server Manager] Автоперезапуск ${state.restarts}/${appRecord.max_restarts} через ${appRecord.restart_delay} сек.\n`);
      setTimeout(() => {
        try {
          start(appRecord, state);
        }
        catch (e) {
          broadcast({ type: 'error', id: appRecord.id, error: e.message });
        }
      }, Math.max(0, appRecord.restart_delay) * 1000);
    }
  });
  return { running: true, pid: child.pid };
}
function stop(appRecord, kill = false) {
  const s = procs.get(appRecord.id);
  if (!s)
    return false;
  s.manualStop = true;
  if (!kill) {
    clearTimeout(s.killTimer);
    s.killTimer = setTimeout(() => {
      if (procs.get(appRecord.id) === s) {
        appendOutput(appRecord.id, 'system', '[Server Manager] Процесс не завершился за 60 с — принудительное завершение\n');
        stop(appRecord, true);
      }
    }, 60000);
  }
  if (!kill && appRecord.stop_command) {
    if (appRecord.stop_command.startsWith('stdin:')) {
      try {
        s.child.stdin.write(appRecord.stop_command.slice(6) + '\n');
      }
      catch (e) {
        appendOutput(appRecord.id, 'stderr', `[stop stdin error] ${e.message}\n`);
      }
      return true;
    }
    const sp = spawn(appRecord.stop_command, { cwd: appRecord.working_dir, shell: true, windowsHide: true, stdio: 'ignore' });
    sp.on('error', e => appendOutput(appRecord.id, 'stderr', `[stop_command error] ${e.message}\n`));
    return true;
  }
  if (process.platform === 'win32')
    spawn('taskkill', ['/F', '/T', '/PID', String(s.child.pid)], { windowsHide: true });
  else {
    const sig = kill ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-s.child.pid, sig);
    }
    catch {
      try {
        s.child.kill(sig);
      }
      catch {
      }
    }
  }
  return true;
}
function waitForExit(id, timeout = 10000) {
  return new Promise(resolve => {
    if (!procs.has(id))
      return resolve(true);
    const started = Date.now();
    const timer = setInterval(() => {
      if (!procs.has(id)) {
        clearInterval(timer);
        resolve(true);
      }
      else if (Date.now() - started >= timeout) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function portFree(port) {
  return new Promise(res => {
    const sv = net.createServer();
    sv.once('error', () => res(false));
    sv.once('listening', () => sv.close(() => res(true)));
    sv.listen(port, '0.0.0.0');
  });
}

async function startWithDeps(appRecord, stack = []) {
  if (stack.includes(appRecord.id))
    throw Error('Циклическая зависимость приложений');
  if (!stack.length && procs.has(appRecord.id))
    throw Error('Уже запущено');
  for (const depId of parseDeps(appRecord.depends_on)) {
    const d = appById(depId);
    if (!d || procs.has(d.id))
      continue;
    appendOutput(appRecord.id, 'system', `[Server Manager] Сначала запускается зависимость: ${d.name}\n`);
    await startWithDeps(d, [...stack, appRecord.id]);
    if (d.ready_delay > 0)
      await sleep(d.ready_delay * 1000);
    if (!procs.has(d.id))
      throw Error(`Зависимость «${d.name}» завершилась сразу после запуска`);
  }
  if (procs.has(appRecord.id))
    return;
  if (appRecord.port && !(await portFree(appRecord.port)))
    throw Error(`Порт ${appRecord.port} уже занят другим процессом`);
  return start(appRecord);
}
function runningDependents(id) {
  return db.prepare('SELECT * FROM apps').all().filter(x => procs.has(x.id) && parseDeps(x.depends_on).includes(id)).map(x => x.name);
}
async function restart(appRecord) {
  if (procs.has(appRecord.id)) {
    stop(appRecord, false);
    const done = await waitForExit(appRecord.id, 62000);
    if (!done) {
      stop(appRecord, true);
      await waitForExit(appRecord.id, 3000);
    }
  }
  return start(appRecord);
}


  return { stat, allApps, logFile, logFlush, logFlushAll, logWrite, logClear, tailFile, appendOutput, start, stop, waitForExit, sleep, portFree, startWithDeps, runningDependents, restart };
};
