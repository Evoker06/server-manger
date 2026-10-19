'use strict';
// M6: конструктор запуска — пресеты, сборка команды, поиск Runtime, инспекция папки.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const WIN = process.platform === 'win32';
/* ---------- утилиты ---------- */
const int = (v, def, min, max) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max = 500) => String(v ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
const quote = s => WIN ? `"${String(s).replace(/"/g, '')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`; // Linux: одинарные кавычки — без раскрытия $ и `
const SHELL_SH = !WIN && ['/bin/bash', '/usr/bin/bash'].some(p => fs.existsSync(p)) ? 'bash' : 'sh'; // .sh чаще пишут под bash, а sh в Debian/Ubuntu = dash
const memArg = mb => mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`;
/* ---------- JVM-флаги ---------- */
function aikarFlags(xmxMb) {
  const big = xmxMb > 12 * 1024; // для куч > 12 ГБ Aikar рекомендует другие значения
  return ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`, `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`, `-XX:G1HeapRegionSize=${big ? '16M' : '8M'}`, `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4', `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`, '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'].join(' ');
}
const gcFlags = (gc, xmx) => gc === 'aikar' ? aikarFlags(xmx) : gc === 'g1' ? '-XX:+UseG1GC' : gc === 'zgc' ? '-XX:+UseZGC' : '';
/* ---------- пресеты (единый источник правды для UI) ---------- */
const PRESETS = [
  { id: 'minecraft', label: 'Minecraft', icon: '⛏', type: 'minecraft', runtime: ['java'], ext: ['jar'],
    hint: 'Java-сервер (Vanilla, Paper, Purpur, Fabric, Forge…). Нужна Java: для 1.18–1.20.4 — 17+, для 1.20.5+ — 21+. Порт передаётся аргументом --port. Остановка командой stop в консоль.',
    defaults: { launch: { preset: 'minecraft', target: '', java: { xms: 2048, xmx: 2048, gc: 'aikar', jvmArgs: '', nogui: true }, args: '' }, port: 25565, stop_command: 'stdin:stop', auto_restart: true, restart_delay: 10, max_restarts: 3, env: {} } },
  { id: 'node', label: 'Node.js', icon: '⬢', type: 'node', runtime: ['node'], ext: ['js', 'mjs', 'cjs'],
    hint: 'Запуск через npm-скрипт из package.json или напрямую файлом. Порт передаётся в переменной PORT.',
    defaults: { launch: { preset: 'node', mode: 'npm', script: 'start', target: '', node: { maxOld: 0, nodeArgs: '' }, args: '' }, port: 3000, stop_command: '', auto_restart: true, restart_delay: 5, max_restarts: 5, env: { NODE_ENV: 'production' } } },
  { id: 'python', label: 'Python', icon: '🐍', type: 'python', runtime: ['python', 'python3'], ext: ['py'],
    hint: 'Запуск .py-файла. Флаг -u отключает буферизацию, чтобы логи появлялись сразу. Порт передаётся в переменной PORT.',
    defaults: { launch: { preset: 'python', target: 'main.py', python: { interpreter: WIN ? 'python' : 'python3', unbuffered: true, installReqs: false }, args: '' }, port: 8000, stop_command: '', auto_restart: true, restart_delay: 5, max_restarts: 5, env: {} } },
  { id: 'dotnet', label: '.NET', icon: '◆', type: 'dotnet', runtime: ['dotnet'], ext: ['dll'],
    hint: 'Запуск опубликованной сборки (dotnet app.dll). Порт задаётся через ASPNETCORE_URLS (слушает на всех интерфейсах).',
    defaults: { launch: { preset: 'dotnet', target: '', args: '' }, port: 5000, stop_command: '', auto_restart: true, restart_delay: 5, max_restarts: 5, env: { ASPNETCORE_ENVIRONMENT: 'Production' } } },
  { id: 'exe', label: 'EXE / скрипт', icon: '▣', type: 'executable', runtime: [], ext: ['exe', 'bat', 'cmd', 'sh'],
    hint: 'Любой исполняемый файл или скрипт (.exe, .bat, .cmd, .sh) с аргументами. Порт передаётся в переменной PORT.',
    defaults: { launch: { preset: 'exe', target: '', args: '' }, port: null, stop_command: '', auto_restart: false, restart_delay: 5, max_restarts: 5, env: {} } },
  { id: 'custom', label: 'Своя команда', icon: '⌨', type: 'auto', runtime: ['node', 'python', 'python3', 'java', 'dotnet'], ext: [],
    hint: 'Произвольная команда оболочки — как раньше.',
    defaults: { launch: { preset: 'custom' }, port: null, stop_command: '', auto_restart: false, restart_delay: 5, max_restarts: 5, env: {} } }
];
const PRESET_IDS = PRESETS.map(p => p.id);
/* ---------- нормализация и сборка команды ---------- */
function normalizeLaunch(l = {}) {
  l = l && typeof l === 'object' ? l : {};
  const preset = PRESET_IDS.includes(l.preset) ? l.preset : 'custom';
  const out = { preset, target: str(l.target, 300), args: str(l.args, 1000) };
  if (preset === 'minecraft') {
    const j = l.java || {}, xmx = int(j.xmx, 2048, 128, 1048576), xms = int(j.xms, xmx, 64, xmx);
    out.java = { xmx, xms, gc: ['none', 'g1', 'aikar', 'zgc'].includes(j.gc) ? j.gc : 'aikar', jvmArgs: str(j.jvmArgs, 1000), nogui: j.nogui !== false };
  }
  if (preset === 'node') {
    const n = l.node || {};
    out.mode = l.mode === 'file' ? 'file' : 'npm';
    out.script = /^[\w:.\-]+$/.test(String(l.script || '')) ? String(l.script) : 'start';
    out.node = { maxOld: int(n.maxOld, 0, 0, 1048576), nodeArgs: str(n.nodeArgs, 500) };
  }
  if (preset === 'python') {
    const p = l.python || {};
    out.python = { interpreter: ['python', 'python3', 'py'].includes(p.interpreter) ? p.interpreter : (WIN ? 'python' : 'python3'), unbuffered: p.unbuffered !== false, installReqs: p.installReqs === true };
  }
  return out;
}
function buildCommand(raw, port) {
  const l = normalizeLaunch(raw);
  const needTarget = what => {
    if (!l.target)
      throw new Error(`Выберите ${what}`);
  };
  const p = [];
  switch (l.preset) {
    case 'minecraft': {
      needTarget('JAR-файл сервера');
      const j = l.java;
      p.push('java', `-Xms${memArg(j.xms)}`, `-Xmx${memArg(j.xmx)}`);
      const gc = gcFlags(j.gc, j.xmx);
      if (gc)
        p.push(gc);
      if (j.jvmArgs)
        p.push(j.jvmArgs);
      p.push('-jar', quote(l.target));
      if (j.nogui)
        p.push('nogui');
      if (port && !/--port\b/.test(l.args))
        p.push('--port', String(port));
      if (l.args)
        p.push(l.args);
      return p.join(' ');
    }
    case 'node': {
      if (l.mode === 'npm') {
        const base = l.script === 'start' ? 'npm start' : `npm run ${l.script}`;
        return l.args ? `${base} -- ${l.args}` : base;
      }
      needTarget('JS-файл');
      p.push('node');
      if (l.node.maxOld)
        p.push(`--max-old-space-size=${l.node.maxOld}`);
      if (l.node.nodeArgs)
        p.push(l.node.nodeArgs);
      p.push(quote(l.target));
      if (l.args)
        p.push(l.args);
      return p.join(' ');
    }
    case 'python': {
      needTarget('Python-файл');
      const y = l.python;
      p.push(y.interpreter);
      if (y.unbuffered)
        p.push('-u');
      p.push(quote(l.target));
      if (l.args)
        p.push(l.args);
      const run = p.join(' ');
      return y.installReqs ? `${y.interpreter} -m pip install -r requirements.txt && ${run}` : run;
    }
    case 'dotnet':
      needTarget('DLL-файл');
      p.push('dotnet', quote(l.target));
      if (l.args)
        p.push(l.args);
      return p.join(' ');
    case 'exe': {
      needTarget('исполняемый файл');
      let t = l.target;
      if (/\.sh$/i.test(t))
        p.push(SHELL_SH, quote(t));
      else {
        if (!WIN && !/[\\/]/.test(t))
          t = './' + t; // на Linux/macOS файл из текущей папки ищется только по явному пути
        p.push(quote(t));
      }
      if (l.args)
        p.push(l.args);
      return p.join(' ');
    }
    default: return '';
  }
}
/* ---------- ENV, который менеджер добавляет сам ---------- */
function launchEnv(a) {
  const env = {};
  let l = null;
  try {
    l = a.launch_json ? JSON.parse(a.launch_json) : null;
  }
  catch {
  }
  const preset = l?.preset;
  if (a.port) {
    if (preset === 'dotnet')
      env.ASPNETCORE_URLS = `http://0.0.0.0:${a.port}`;
    else if (preset !== 'minecraft')
      env.PORT = String(a.port);
  }
  if ((a.runtime === 'java' || preset === 'minecraft') && a.runtime_path) {
    try {
      const dir = fs.statSync(a.runtime_path).isDirectory() ? a.runtime_path : path.dirname(a.runtime_path);
      if (path.basename(dir).toLowerCase() === 'bin')
        env.JAVA_HOME = path.dirname(dir);
    }
    catch {
    }
  }
  return env;
}
/* ---------- поиск Runtime (несколько версий) ---------- */
const DEFS = [['node', 'Node.js', 'node'], ['npm', 'npm', 'npm'], ['python', 'Python', 'python'], ['python3', 'Python', 'python3'], ['java', 'Java', 'java'], ['dotnet', '.NET', 'dotnet'], ['git', 'Git', 'git'], ['docker', 'Docker', 'docker']];
const realp = p => {
  try {
    return fs.realpathSync(p);
  }
  catch {
    return p;
  }
};
function whichAll(bin) {
  const r = spawnSync(WIN ? 'where' : 'which', WIN ? [bin] : ['-a', bin], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
}
function getVersion(p, args) {
  const sh = WIN && /\.(cmd|bat)$/i.test(p), opt = { encoding: 'utf8', windowsHide: true, timeout: 8000 };
  // .cmd/.bat запускаются только через shell — тогда команда передаётся одной строкой (без массива args, иначе DEP0190)
  const r = sh ? spawnSync(`"${p}" ${args.join(' ')}`, { ...opt, shell: true }) : spawnSync(p, args, opt);
  if (r.status !== 0)
    return '';
  return ((r.stdout || '') + '\n' + (r.stderr || '')).trim().split(/\r?\n/)[0].trim();
}
function javaMajor(v) {
  const m = /"?(\d+)(?:\.(\d+))?/.exec(v.replace(/^.*?version\s+/i, ''));
  if (!m)
    return null;
  return m[1] === '1' && m[2] ? +m[2] : +m[1];
}
function listDir(d) {
  try {
    return fs.readdirSync(d);
  }
  catch {
    return [];
  }
}
function extraCandidates(key) {
  const c = [], exe = n => WIN ? n + '.exe' : n, home = os.homedir();
  if (key === 'java') {
    if (process.env.JAVA_HOME)
      c.push(path.join(process.env.JAVA_HOME, 'bin', exe('java')));
    const roots = WIN ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).flatMap(pf => ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'AdoptOpenJDK'].map(d => path.join(pf, d))) :
      process.platform === 'darwin' ? ['/Library/Java/JavaVirtualMachines'] : ['/usr/lib/jvm', '/usr/java', '/opt/java', path.join(home, '.sdkman/candidates/java')];
    for (const r of roots)
      for (const e of listDir(r)) {
        c.push(path.join(r, e, 'bin', exe('java')));
        c.push(path.join(r, e, 'Contents', 'Home', 'bin', 'java'));
      }
  }
  if (key === 'node') {
    if (WIN && process.env.NVM_HOME)
      for (const e of listDir(process.env.NVM_HOME))
        c.push(path.join(process.env.NVM_HOME, e, 'node.exe'));
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const e of listDir(nvm))
      c.push(path.join(nvm, e, 'bin', 'node'));
  }
  if (key === 'python') {
    if (WIN) {
      for (const base of [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'), process.env.ProgramFiles || ''])
        for (const e of listDir(base))
          if (/^python/i.test(e))
            c.push(path.join(base, e, 'python.exe'));
    }
    else
      for (const d of ['/usr/bin', '/usr/local/bin'])
        for (const e of listDir(d))
          if (/^python3(\.\d+)?$/.test(e))
            c.push(path.join(d, e));
  }
  return c.filter(p => {
    try {
      return fs.statSync(p).isFile();
    }
    catch {
      return false;
    }
  });
}
function discoverRuntimes() {
  const out = [], seen = new Set();
  const push = (key, label, p, source) => {
    if (WIN && !/\.[a-z0-9]+$/i.test(p))
      return; // «npm» без расширения — это sh-шим, а не запускаемый файл
    const id = key + '|' + realp(p).toLowerCase();
    if (seen.has(id))
      return;
    const version = getVersion(p, key === 'java' ? ['-version'] : ['--version']);
    if (!version)
      return;
    seen.add(id);
    const e = { key, label, path: p, version, source, isDefault: source === 'PATH' && !out.some(x => x.key === key && x.isDefault) };
    if (key === 'java')
      e.major = javaMajor(version);
    out.push(e);
  };
  for (const [key, label, bin] of DEFS) {
    for (const p of whichAll(bin))
      push(key, label, p, 'PATH');
    for (const p of extraCandidates(key))
      push(key, label, p, 'scan');
  }
  return out;
}
/* ---------- инспекция папки проекта ---------- */
const SKIP = new Set(['node_modules', 'venv', '.venv', '__pycache__', 'obj', 'storage', 'libraries', 'versions', 'mods', 'plugins', 'logs', 'cache', 'crash-reports', 'world', 'world_nether', 'world_the_end']);
function parseDotenv(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#'))
      continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
function inspect(cwd) {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
    throw new Error('Папка не найдена: ' + cwd);
  const files = { jar: [], js: [], py: [], dll: [], exe: [] }, dlls = new Set(), runtimeCfg = [];
  const MAX = 200;
  const walk = (dir, depth) => {
    if (depth > 5)
      return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.'))
        continue;
      const full = path.join(dir, e.name), rel = path.relative(cwd, full);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && (depth < 2 || e.name === 'bin' || e.name === 'publish' || /^net/.test(e.name) || /^Release|Debug$/.test(e.name)))
          walk(full, depth + 1);
        continue;
      }
      const low = e.name.toLowerCase(), add = k => {
        if (files[k].length < MAX)
          files[k].push(rel);
      };
      if (depth > 2 && !low.endsWith('.dll') && !low.endsWith('.json'))
        continue;
      if (low.endsWith('.jar'))
        add('jar');
      else if (/\.(js|mjs|cjs)$/.test(low))
        add('js');
      else if (low.endsWith('.py'))
        add('py');
      else if (/\.(exe|bat|cmd|sh)$/.test(low))
        add('exe');
      else if (low.endsWith('.dll'))
        dlls.add(rel);
      else if (low.endsWith('.runtimeconfig.json'))
        runtimeCfg.push(rel);
    }
  };
  walk(cwd, 0);
  // Запускаемые .NET-сборки — те, рядом с которыми есть *.runtimeconfig.json
  for (const cfg of runtimeCfg) {
    const dll = cfg.replace(/\.runtimeconfig\.json$/i, '.dll');
    if (dlls.has(dll))
      files.dll.push(dll);
  }
  const rd = n => {
    try {
      return fs.readFileSync(path.join(cwd, n), 'utf8');
    }
    catch {
      return null;
    }
  };
  let scripts = [];
  const pkg = rd('package.json');
  if (pkg) {
    try {
      scripts = Object.entries(JSON.parse(pkg).scripts || {}).map(([name, cmd]) => ({ name, cmd: String(cmd) }));
    }
    catch {
    }
  }
  const props = rd('server.properties'), eula = rd('eula.txt');
  let minecraft = null;
  if (props !== null || eula !== null) {
    const m = props && /^\s*server-port\s*=\s*(\d+)/m.exec(props);
    minecraft = { port: m ? +m[1] : null, eula: eula === null ? null : /eula\s*=\s*true/i.test(eula) };
  }
  const dot = rd('.env');
  let suggest = 'custom';
  if (minecraft)
    suggest = 'minecraft';
  else if (pkg)
    suggest = 'node';
  else if (files.dll.length)
    suggest = 'dotnet';
  else if (rd('requirements.txt') !== null || rd('pyproject.toml') !== null || files.py.length)
    suggest = 'python';
  else if (files.jar.length)
    suggest = 'minecraft';
  else if (files.exe.length)
    suggest = 'exe';
  return { cwd, suggest, files, scripts, minecraft, dotenv: dot === null ? null : parseDotenv(dot) };
}
module.exports = { PRESETS, normalizeLaunch, buildCommand, launchEnv, discoverRuntimes, inspect, parseDotenv, javaMajor, aikarFlags };
