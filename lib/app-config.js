'use strict';
// Проверка и подготовка настроек приложений: имя, команда, рабочая папка, переменные окружения, зависимости,
// а также автоопределение типа проекта (по команде и по содержимому папки).
const fs = require('fs');
const path = require('path');

module.exports = function createAppConfig({ db, LB }) {
function num(v, def, min = 0) {
  if (v === '' || v == null)
    return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : def;
}
function cleanEnv(o) {
  const out = {};
  if (o && typeof o === 'object' && !Array.isArray(o))
    for (const [k, v] of Object.entries(o)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        throw Error('Недопустимое имя переменной ENV: ' + k);
      out[k] = String(v ?? '');
    }
  return out;
}
// путь может быть на любом диске; проверяем только то, что реально мешает запуску
function checkWorkingDir(wd) {
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(wd)) {
    const root = wd.slice(0, 2) + '\\';
    try {
      fs.accessSync(root);
    }
    catch {
      throw Error(`Диск ${wd.slice(0, 2)} сейчас недоступен. Подключите его или выберите другую папку.`);
    }
  }
  try {
    if (!fs.statSync(wd).isDirectory())
      throw Error('Указанный путь — файл, а не папка');
  }
  catch (e) {
    if (/файл, а не папка/.test(e.message))
      throw e;
  }
}
function appInput(b, o, selfId) {
  const has = k => b[k] !== undefined, pick = (k, d) => has(k) ? b[k] : (o ? o[k] : d);
  let launch = o?.launch_json || '';
  if (has('launch')) {
    const l = b.launch;
    launch = l && l.preset && l.preset !== 'custom' ? JSON.stringify(LB.normalizeLaunch(l)) : '';
  }
  const port = has('port') ? num(b.port, null, 1) : (o ? o.port : null);
  if (port && port > 65535)
    throw Error('Порт должен быть от 1 до 65535');
  let command = has('command') ? String(b.command || '').trim() : (o?.command || '');
  if (launch)
    command = LB.buildCommand(JSON.parse(launch), port);
  if (!command)
    throw Error('Команда запуска обязательна');
  const name = String(pick('name', '')).trim(), wd = String(pick('working_dir', '')).trim();
  if (!name || !wd)
    throw Error('Название и рабочая папка обязательны');
  if (!o || o.working_dir !== wd)
    checkWorkingDir(wd); // уже настроенные пути не трогаем и не перепроверяем
  return { name, type: pick('type', 'auto') || 'auto', command, working_dir: wd, runtime: pick('runtime', '') || '', runtime_path: pick('runtime_path', '') || '', stop_command: String(pick('stop_command', '') || '').trim(),
    env_json: JSON.stringify(has('env') ? cleanEnv(b.env) : parseEnv(o?.env_json)), launch_json: launch,
    depends_on: JSON.stringify(has('depends_on') ? checkDeps(b.depends_on, selfId) : parseDeps(o?.depends_on)), ready_delay: num(b.ready_delay, o ? o.ready_delay : 0, 0),
    auto_start: has('auto_start') ? (b.auto_start ? 1 : 0) : (o ? o.auto_start : 0), auto_restart: has('auto_restart') ? (b.auto_restart ? 1 : 0) : (o ? o.auto_restart : 0),
    restart_delay: num(b.restart_delay, o ? o.restart_delay : 5), max_restarts: num(b.max_restarts, o ? o.max_restarts : 5), port };
}
const APP_COLS = ['name', 'type', 'command', 'working_dir', 'runtime', 'runtime_path', 'stop_command', 'env_json', 'launch_json', 'depends_on', 'ready_delay', 'auto_start', 'auto_restart', 'restart_delay', 'max_restarts', 'port'];
function parseEnv(s) {
  try {
    return JSON.parse(s || '{}');
  }
  catch {
    return {};
  }
}
let rtCache = null, rtTime = 0;
function runtime(force = false) {
  if (!force && rtCache && Date.now() - rtTime < 60000)
    return rtCache;
  rtCache = LB.discoverRuntimes();
  rtTime = Date.now();
  return rtCache;
}
function infer(command, cwd) {
  const s = (command || '').toLowerCase(), a = [];
  if (/java|\.jar|minecraft/.test(s))
    a.push('java');
  if (/node|npm|\.js|package\.json/.test(s) || fs.existsSync(path.join(cwd || '', 'package.json')))
    a.push('node');
  if (/python|\.py/.test(s) || fs.existsSync(path.join(cwd || '', 'requirements.txt')) || fs.existsSync(path.join(cwd || '', 'pyproject.toml')))
    a.push('python');
  if (/dotnet|\.dll|\.csproj/.test(s))
    a.push('dotnet');
  return [...new Set(a)];
}

function detectProject(cwd) {
  const dir = path.resolve(cwd || '.');
  const exists = n => fs.existsSync(path.join(dir, n));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const result = { cwd: dir, type: 'auto', command: '', runtime: '', runtimePath: '', detected: [], confidence: 'low' };
  if (exists('docker-compose.yml') || exists('compose.yaml') || exists('compose.yml')) {
    result.type = 'docker';
    result.command = 'docker compose up';
    result.runtime = 'docker';
    result.detected.push('Docker Compose');
    result.confidence = 'high';
    return result;
  }
  if (files.some(x => x.toLowerCase().endsWith('.jar'))) {
    const jar = files.find(x => x.toLowerCase().endsWith('.jar'));
    result.type = 'minecraft';
    result.command = `java -jar "${jar}"`;
    result.runtime = 'java';
    result.detected.push(jar);
    result.confidence = 'high';
    return result;
  }
  if (exists('package.json')) {
    result.type = 'node';
    result.command = 'npm start';
    result.runtime = 'node';
    result.detected.push('package.json');
    result.confidence = 'high';
    return result;
  }
  if (exists('requirements.txt') || exists('pyproject.toml')) {
    result.type = 'python';
    result.command = exists('pyproject.toml') ? 'python -m app' : 'python main.py';
    result.runtime = 'python';
    result.detected.push(exists('requirements.txt') ? 'requirements.txt' : 'pyproject.toml');
    result.confidence = 'medium';
    return result;
  }
  const dll = files.find(x => x.toLowerCase().endsWith('.dll'));
  if (dll) {
    result.type = 'dotnet';
    result.command = `dotnet "${dll}"`;
    result.runtime = 'dotnet';
    result.detected.push(dll);
    result.confidence = 'high';
    return result;
  }
  const exe = files.find(x => x.toLowerCase().endsWith('.exe'));
  if (exe) {
    result.type = 'executable';
    result.command = `"${exe}"`;
    result.detected.push(exe);
    result.confidence = 'medium';
    return result;
  }
  const bat = files.find(x => /\.(bat|cmd|sh)$/i.test(x));
  if (bat) {
    result.type = 'script';
    result.command = `"${bat}"`;
    result.detected.push(bat);
    result.confidence = 'medium';
    return result;
  }
  return result;
}
function scanProject(cwd) {
  const root = path.resolve(cwd || '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    throw Error('Папка не найдена: ' + root);
  const candidates = [];
  const seen = new Set();
  const add = (type, command, runtime, label, confidence = 'medium', details = '') => {
    const key = type + '|' + command;
    if (seen.has(key))
      return;
    seen.add(key);
    candidates.push({ type, command, runtime: runtime || '', label, confidence, details });
  };
  const walk = (dir, depth) => {
    if (depth > 2)
      return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || ['node_modules', 'venv', '.venv', 'bin', 'obj', 'storage'].includes(e.name))
        continue;
      const full = path.join(dir, e.name), rel = path.relative(root, full) || e.name;
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const low = e.name.toLowerCase();
      if (low === 'start.bat' || low === 'start.cmd')
        add('script', `"${rel}"`, '', `Запустить ${e.name}`, 'high', 'Windows script');
      if (low === 'start.sh')
        add('script', `sh "${rel}"`, '', `Запустить ${e.name}`, 'high', 'Shell script');
      if (low.endsWith('.jar'))
        add('minecraft', `java -jar "${rel}"`, 'java', `Java JAR: ${e.name}`, 'high', 'JAR application');
      if (low.endsWith('.exe'))
        add('executable', `"${rel}"`, '', `EXE: ${e.name}`, 'medium', 'Executable');
      if (low.endsWith('.dll'))
        add('dotnet', `dotnet "${rel}"`, 'dotnet', `.NET: ${e.name}`, 'high', 'DLL');
    }
  };
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  }
  catch {
  }
  if (pkg) {
    const scripts = pkg.scripts || {};
    if (scripts.start)
      add('node', 'npm start', 'node', 'Node.js: npm start', 'high', `package.json script: ${scripts.start}`);
    for (const [name, cmd] of Object.entries(scripts))
      if (name !== 'start')
        add('node', `npm run ${name}`, 'node', `Node.js: npm run ${name}`, 'medium', String(cmd));
  }
  if (fs.existsSync(path.join(root, 'requirements.txt')))
    add('python', 'python -m pip install -r requirements.txt && python main.py', 'python', 'Python: requirements.txt', 'high', 'requirements.txt');
  if (fs.existsSync(path.join(root, 'pyproject.toml')))
    add('python', 'python -m app', 'python', 'Python: pyproject.toml', 'medium', 'pyproject.toml');
  if (fs.existsSync(path.join(root, 'docker-compose.yml')) || fs.existsSync(path.join(root, 'compose.yml')) || fs.existsSync(path.join(root, 'compose.yaml')))
    add('docker', 'docker compose up', 'docker', 'Docker Compose', 'high', 'Compose project');
  walk(root, 0);
  if (!candidates.length)
    add('executable', '', '', 'Ручная настройка', 'low', 'Автоматический запуск не найден');
  const runtimes = runtime();
  return { cwd: root, candidates: candidates.map(x => ({ ...x, availableRuntime: !x.runtime || runtimes.some(r => r.key === x.runtime) })), runtimes };
}

function parseDeps(s) {
  try {
    const x = JSON.parse(s || '[]');
    return Array.isArray(x) ? x.map(Number).filter(Number.isInteger) : [];
  }
  catch {
    return [];
  }
}
const appById = id => db.prepare('SELECT * FROM apps WHERE id=?').get(id);
function checkDeps(raw, selfId) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];
  const nm = id => appById(id)?.name || ('#' + id);
  for (const id of ids) {
    if (id === selfId)
      throw Error('Приложение не может зависеть от самого себя');
    if (!appById(id))
      throw Error('Зависимость не найдена: #' + id);
  }
  if (selfId) {
    const walk = (id, trail, seen) => {
      if (id === selfId)
        throw Error('Циклическая зависимость: ' + [...trail, nm(selfId)].join(' → '));
      if (seen.has(id))
        return;
      seen.add(id);
      for (const d of parseDeps(appById(id)?.depends_on))
        walk(d, [...trail, nm(id)], seen);
    };
    for (const d of ids)
      walk(d, [nm(selfId)], new Set());
  }
  return ids;
}


  return { num, cleanEnv, checkWorkingDir, appInput, APP_COLS, parseEnv, runtime, infer, detectProject, scanProject, parseDeps, appById, checkDeps };
};
