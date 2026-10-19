'use strict';
// Определение типа проекта по содержимому папки — для кнопки «Использовать проект».
// Ничего не запускается и не меняется: модуль только читает файлы и предлагает варианты запуска.
// Каждый вариант — готовая настройка для конструктора запуска (пресет + параметры), которую пользователь
// может изменить или заменить ручной настройкой перед сохранением приложения.
const fs = require('fs');
const path = require('path');
const LB = require('./launcher');
const { sendJson, route } = require('./http-helpers');
const { UserError } = require('./safe-paths');

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };
const SCRIPT_PREVIEW_BYTES = 1500;
const SERVER_JAR_NAME = /(server|paper|purpur|spigot|bukkit|fabric|forge|neoforge|folia|velocity|waterfall|bungee|minecraft|craftbukkit|pufferfish|leaf)/i;
const START_SCRIPT_NAME = /^(start|run|launch|server|startserver|start-server|run-server)[\w.\-]*\.(sh|bat|cmd)$/i;
const PYTHON_ENTRY_NAME = /^(main|app|server|bot|run|manage|start)\.py$/i;
const NODE_ENTRY_NAME = /^(index|server|app|main|bot)\.(js|mjs|cjs)$/i;
const NODE_SKIPPED_SCRIPTS = /^(test|lint|build|format|prepare|pre\w+|post\w+)/i;
// Что считаем подозрительным в скриптах запуска: пользователь увидит предупреждение и текст скрипта
const RISKY_SCRIPT_PATTERNS = [
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i, 'удаление каталогов (rm -rf)'],
  [/\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:/i, 'форматирование или запись на диск'],
  [/\bdel\s+\/[sqf]|\brd\s+\/s|\brmdir\s+\/s/i, 'массовое удаление файлов (del /s)'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(ba)?sh/i, 'загрузка и выполнение скрипта из интернета'],
  [/powershell[^\n]*(-enc|-encodedcommand)|invoke-expression|\biex\b/i, 'скрытое выполнение PowerShell'],
  [/\bshutdown\b|\breboot\b|\bhalt\b/i, 'выключение компьютера'],
  [/\breg\s+(add|delete)\b|\bnet\s+user\b|\bschtasks\b/i, 'изменение системных настроек'],
];

const clone = value => JSON.parse(JSON.stringify(value));
const presetDefaults = id => clone(LB.PRESETS.find(preset => preset.id === id).defaults.launch);

/** Какая версия Java нужна серверу Minecraft этой версии. null — версию определить не удалось. */
function requiredJavaForMinecraft(versionText) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(versionText || ''));
  if (!match || match[1] !== '1') return null;
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

/** Подбирает установленную Java: самую «скромную» из подходящих (>= требуемой). */
function pickJava(runtimes, required) {
  const javas = runtimes.filter(runtime => runtime.key === 'java' && runtime.major);
  if (!javas.length) return { ok: false, message: 'Java не найдена на этом компьютере. Установите её или укажите путь в настройках запуска.' };
  if (!required) {
    return { ok: true, message: '', path: '' };
  }
  const suitable = javas.filter(runtime => runtime.major >= required).sort((a, b) => a.major - b.major);
  if (!suitable.length) {
    const have = [...new Set(javas.map(runtime => runtime.major))].join(', ');
    return { ok: false, message: `Нужна Java ${required} или новее, найдена: ${have}. Установите подходящую версию.` };
  }
  const defaultJava = javas.find(runtime => runtime.isDefault);
  if (defaultJava && defaultJava.major >= required) return { ok: true, message: `Подходит Java ${defaultJava.major} (по умолчанию в системе)`, path: '' };
  return { ok: true, message: `Будет использована Java ${suitable[0].major}`, path: suitable[0].path };
}

function readHead(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function scriptRisks(text) {
  return RISKY_SCRIPT_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

function analyzeProject(directory, { runtimes = [], platform = process.platform, focusFile = '' } = {}) {
  const info = LB.inspect(directory);
  const windows = platform === 'win32';
  const candidates = [];
  const add = candidate => {
    let command = '';
    try { command = LB.buildCommand(candidate.launch, candidate.port || null); } catch { /* команда уточняется в конструкторе */ }
    candidates.push({ warnings: [], details: '', runtime: '', runtimePath: '', runtimeOk: true, runtimeMessage: '', preview: '', ...candidate, command });
  };
  const has = name => fs.existsSync(path.join(directory, name));

  // 1. Java / Minecraft
  for (const jar of info.files.jar) {
    const base = path.basename(jar);
    const installer = /installer/i.test(base);
    const serverLike = SERVER_JAR_NAME.test(base) || !!info.minecraft;
    const launch = presetDefaults('minecraft');
    launch.target = jar;
    const required = requiredJavaForMinecraft(base);
    const java = pickJava(runtimes, required);
    const warnings = [];
    if (installer) warnings.push('Это установщик, а не сам сервер: после установки выберите получившийся JAR сервера.');
    if (info.minecraft && info.minecraft.eula === false) warnings.push('eula.txt: лицензия Minecraft (EULA) не принята — сервер при запуске остановится. Откройте eula.txt и поставьте eula=true.');
    if (!java.ok) warnings.push(java.message);
    add({
      id: 'jar:' + jar, label: `Java: ${base}`, confidence: installer ? 'low' : serverLike ? 'high' : 'medium',
      preset: 'minecraft', launch, port: info.minecraft && info.minecraft.port, runtime: 'java', runtimePath: java.path || '',
      runtimeOk: java.ok, runtimeMessage: java.message, warnings,
      details: required ? `Определена версия Minecraft, нужна Java ${required}+` : 'Версия Java определяется по версии сервера',
    });
  }

  // 2. Скрипты запуска (.bat/.cmd/.sh)
  for (const script of info.files.exe.filter(file => /\.(sh|bat|cmd)$/i.test(file))) {
    const base = path.basename(script);
    const isWindowsScript = /\.(bat|cmd)$/i.test(base);
    const matchesOs = windows ? isWindowsScript : !isWindowsScript;
    const preview = readHead(path.join(directory, script), SCRIPT_PREVIEW_BYTES);
    const risks = scriptRisks(preview);
    const warnings = [];
    if (!matchesOs) warnings.push(isWindowsScript ? 'Скрипт для Windows, а панель работает не в Windows.' : 'Скрипт для Linux (sh), а панель работает в Windows: нужен Git Bash или WSL.');
    if (risks.length) warnings.push('Скрипт содержит потенциально опасные команды (' + risks.join(', ') + '). Прочитайте его перед запуском.');
    const launch = presetDefaults('exe');
    launch.target = script;
    add({
      id: 'script:' + script, label: `Скрипт: ${script}`,
      confidence: risks.length || !matchesOs ? 'low' : START_SCRIPT_NAME.test(base) ? 'high' : 'medium',
      preset: 'exe', launch, warnings, preview, details: 'Запускается существующий скрипт проекта',
    });
  }

  // 3. Node.js
  if (info.scripts.length || info.files.js.some(file => NODE_ENTRY_NAME.test(path.basename(file)) && !file.includes(path.sep))) {
    const missingModules = has('package.json') && !has('node_modules') && /"(dependencies|devDependencies)"/.test(readHead(path.join(directory, 'package.json'), 20000));
    const nodeWarning = missingModules ? ['Папка node_modules не найдена: перед запуском выполните «npm install» в папке проекта.'] : [];
    const nodeRuntimeOk = runtimes.some(runtime => runtime.key === 'node');
    for (const script of info.scripts.filter(item => !NODE_SKIPPED_SCRIPTS.test(item.name))) {
      const launch = presetDefaults('node');
      launch.mode = 'npm';
      launch.script = script.name;
      add({
        id: 'npm:' + script.name, label: `Node.js: npm ${script.name === 'start' ? 'start' : 'run ' + script.name}`,
        confidence: script.name === 'start' ? 'high' : /^(dev|serve|watch)$/.test(script.name) ? 'medium' : 'low',
        preset: 'node', launch, runtime: 'node', runtimeOk: nodeRuntimeOk, runtimeMessage: nodeRuntimeOk ? '' : 'Node.js не найден на этом компьютере',
        warnings: nodeWarning, details: `package.json: ${script.cmd}`,
      });
    }
    for (const file of info.files.js.filter(f => NODE_ENTRY_NAME.test(path.basename(f)) && !f.includes(path.sep))) {
      const launch = presetDefaults('node');
      launch.mode = 'file';
      launch.target = file;
      add({ id: 'node-file:' + file, label: `Node.js: ${file}`, confidence: info.scripts.some(s => s.name === 'start') ? 'low' : 'medium', preset: 'node', launch, runtime: 'node', runtimeOk: nodeRuntimeOk, warnings: nodeWarning });
    }
  }

  // 4. Python
  for (const file of info.files.py.filter(f => !f.includes(path.sep))) {
    const launch = presetDefaults('python');
    launch.target = file;
    if (has('requirements.txt')) launch.python.installReqs = false;
    const pythonOk = runtimes.some(runtime => runtime.key === 'python' || runtime.key === 'python3');
    add({
      id: 'py:' + file, label: `Python: ${file}`, confidence: PYTHON_ENTRY_NAME.test(file) ? 'high' : 'low',
      preset: 'python', launch, runtime: 'python', runtimeOk: pythonOk, runtimeMessage: pythonOk ? '' : 'Python не найден на этом компьютере',
      details: has('requirements.txt') ? 'Есть requirements.txt: зависимости можно установить командой pip install -r requirements.txt (опция в конструкторе)' : '',
    });
  }

  // 5. .NET
  for (const dll of info.files.dll) {
    const launch = presetDefaults('dotnet');
    launch.target = dll;
    const dotnetOk = runtimes.some(runtime => runtime.key === 'dotnet');
    add({ id: 'dll:' + dll, label: `.NET: ${dll}`, confidence: 'high', preset: 'dotnet', launch, runtime: 'dotnet', runtimeOk: dotnetOk, runtimeMessage: dotnetOk ? '' : '.NET не найден на этом компьютере' });
  }

  // 6. Docker Compose
  if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(has)) {
    add({
      id: 'compose', label: 'Docker Compose', confidence: 'medium', preset: 'custom', launch: { preset: 'custom' }, command: 'docker compose up',
      runtime: 'docker', runtimeOk: runtimes.some(runtime => runtime.key === 'docker'), runtimeMessage: 'Docker не найден на этом компьютере', details: 'В папке есть файл Docker Compose',
    });
    candidates[candidates.length - 1].command = 'docker compose up';
  }

  // 7. Исполняемые файлы (Windows)
  if (windows) {
    for (const exe of info.files.exe.filter(file => /\.exe$/i.test(file) && !/(unins|setup|install|update)/i.test(file))) {
      const launch = presetDefaults('exe');
      launch.target = exe;
      add({ id: 'exe:' + exe, label: `Программа: ${exe}`, confidence: 'medium', preset: 'exe', launch, details: 'Исполняемый файл. Убедитесь, что вы ему доверяете.' });
    }
  }

  // Если пользователь выбрал конкретный файл — этот вариант идёт первым
  if (focusFile) {
    const focused = candidates.findIndex(candidate => candidate.launch && candidate.launch.target === focusFile);
    if (focused >= 0) candidates[focused].confidence = 'high';
    else {
      const synthesized = candidateForFile(focusFile, runtimes);
      if (synthesized) add(synthesized);
    }
  }

  candidates.sort((a, b) => {
    const focusA = focusFile && a.launch && a.launch.target === focusFile ? -1 : 0;
    const focusB = focusFile && b.launch && b.launch.target === focusFile ? -1 : 0;
    return focusA - focusB || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  });

  return {
    directory, name: path.basename(directory) || 'Проект', suggest: info.suggest, minecraft: info.minecraft,
    port: (info.minecraft && info.minecraft.port) || (info.dotenv && Number(info.dotenv.PORT)) || null,
    candidates, platform,
  };
}

/** Вариант запуска для файла, который выбрал пользователь, если автоопределение его не нашло. */
function candidateForFile(file, runtimes) {
  const extension = path.extname(file).toLowerCase();
  const base = { id: 'file:' + file, confidence: 'high', details: 'Выбранный вами файл', warnings: [], runtimeOk: true, runtimeMessage: '', runtimePath: '', preview: '' };
  if (extension === '.jar') { const launch = presetDefaults('minecraft'); launch.target = file; return { ...base, label: `Java: ${file}`, preset: 'minecraft', launch, runtime: 'java', runtimeOk: pickJava(runtimes, requiredJavaForMinecraft(file)).ok }; }
  if (['.js', '.mjs', '.cjs'].includes(extension)) { const launch = presetDefaults('node'); launch.mode = 'file'; launch.target = file; return { ...base, label: `Node.js: ${file}`, preset: 'node', launch, runtime: 'node' }; }
  if (extension === '.py') { const launch = presetDefaults('python'); launch.target = file; return { ...base, label: `Python: ${file}`, preset: 'python', launch, runtime: 'python' }; }
  if (extension === '.dll') { const launch = presetDefaults('dotnet'); launch.target = file; return { ...base, label: `.NET: ${file}`, preset: 'dotnet', launch, runtime: 'dotnet' }; }
  if (['.sh', '.bat', '.cmd', '.exe'].includes(extension)) { const launch = presetDefaults('exe'); launch.target = file; return { ...base, label: `Запуск: ${file}`, preset: 'exe', launch }; }
  return null;
}

function registerProjectRoutes({ app, pathGuard, getRuntimes }) {
  // POST /api/projects/analyze  { path, app?, disk? } — путь папки (или файла) внутри файлового менеджера
  app.post('/api/projects/analyze', route(async (req, res) => {
    const body = req.body || {};
    const target = pathGuard.resolveScoped({ app: body.app || undefined, disk: body.disk || undefined }, body.path || '', req.user);
    const stats = await fs.promises.stat(target).catch(() => null);
    if (!stats) throw new UserError('Папка или файл не найдены', 404);
    const directory = stats.isDirectory() ? target : path.dirname(target);
    const focusFile = stats.isFile() ? path.basename(target) : '';
    sendJson(res, 200, analyzeProject(directory, { runtimes: getRuntimes(), focusFile }));
  }));
}

module.exports = { analyzeProject, registerProjectRoutes, requiredJavaForMinecraft, pickJava, scriptRisks };
