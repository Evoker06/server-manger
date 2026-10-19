'use strict';
// Загрузка настроек из config.json.
// Чего нет в файле — берётся из DEFAULTS, поэтому старый config.json продолжает работать без правок.
// Секреты (jwtSecret) генерируются при первом запуске и сохраняются в config.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MINUTE = 60 * 1000;
const SECOND = 1000;

// Лимиты и таймауты. Все значения можно переопределить в config.json (см. README, раздел «Лимиты и таймауты»).
const DEFAULTS = {
  port: 80,
  host: '127.0.0.1',
  fileRoot: './servers',
  backupRoot: './storage/backups',
  logRoot: './storage/logs',
  uploadRoot: './storage/uploads',
  limits: {
    maxFileGb: 500,          // максимальный размер одного загружаемого файла
    uploadChunkMb: 16,       // размер одной части при загрузке (от 1 до 64 МБ)
    minFreeDiskMb: 256,      // столько свободного места должно остаться на диске после загрузки
    uploadSessionHours: 48,  // сколько хранить недозагруженный файл для продолжения
    maxActiveUploads: 8,     // одновременных незавершённых загрузок на пользователя
    maxZipItems: 2000,       // максимум элементов в одном ZIP-скачивании
  },
  timeouts: {
    requestMinutes: 20,      // максимальное время ПОЛУЧЕНИЯ одного запроса (в т.ч. одной части файла)
    idleMinutes: 20,         // соединение без единого байта дольше этого времени закрывается
    headersSeconds: 60,      // время на получение заголовков запроса
    keepAliveSeconds: 65,    // сколько держать свободное соединение (больше, чем у типичных прокси — 60 с)
    uploadStallSeconds: 60,  // загрузка части «зависла» — байты перестали приходить
    proxyIdleMinutes: 20,    // ожидание ответа удалённого агента
  },
};

function mergeSection(defaults, user) {
  const result = { ...defaults };
  if (user && typeof user === 'object') {
    for (const key of Object.keys(defaults)) {
      const value = Number(user[key]);
      if (user[key] !== undefined && Number.isFinite(value) && value > 0) result[key] = value;
    }
  }
  return result;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Атомарная запись config.json: сначала во временный файл, потом переименование. */
function writeConfigFile(data, file = CONFIG_FILE) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

/** Меняет отдельные поля в config.json, не трогая остальные (используется для токенов агента). */
function saveConfigPatch(patch) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* файла ещё нет */ }
  writeConfigFile({ ...current, ...patch });
}

function loadConfig(configFile = CONFIG_FILE) {
  let raw = {};
  if (fs.existsSync(configFile)) raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));

  const config = { ...DEFAULTS, ...raw };
  config.limits = mergeSection(DEFAULTS.limits, raw.limits);
  config.timeouts = mergeSection(DEFAULTS.timeouts, raw.timeouts);
  config.limits.uploadChunkMb = clamp(config.limits.uploadChunkMb, 1, 64);

  // Секрет подписи входа: слабый или стандартный заменяем новым случайным
  const secret = String(raw.jwtSecret || '');
  if (!secret || secret === 'CHANGE_THIS_SECRET_TO_A_LONG_RANDOM_VALUE' || secret.length < 32) {
    config.jwtSecret = crypto.randomBytes(48).toString('hex');
    try {
      writeConfigFile({ ...raw, jwtSecret: config.jwtSecret }, configFile);
      console.log('jwtSecret был небезопасным или отсутствовал — создан новый и сохранён в config.json');
    } catch (error) {
      console.warn('Не удалось сохранить jwtSecret в config.json:', error.message);
    }
  }

  // Путь в стиле Windows (E:\...) в Linux не работает — используем папку по умолчанию
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(String(config.fileRoot))) {
    console.warn(`fileRoot в стиле Windows (${config.fileRoot}) — используется ./servers`);
    config.fileRoot = './servers';
  }
  return config;
}

/** Создаёт рабочие папки и возвращает их абсолютные пути. */
function preparePaths(config, rootDir = PROJECT_ROOT) {
  const paths = {
    ROOT: rootDir,
    FILE_ROOT: path.resolve(rootDir, config.fileRoot),
    BACKUP_ROOT: path.resolve(rootDir, config.backupRoot),
    LOG_ROOT: path.resolve(rootDir, config.logRoot),
    UPLOAD_ROOT: path.resolve(rootDir, config.uploadRoot),
  };
  for (const key of ['FILE_ROOT', 'BACKUP_ROOT', 'LOG_ROOT', 'UPLOAD_ROOT']) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
  return paths;
}

module.exports = { loadConfig, preparePaths, saveConfigPatch, DEFAULTS, MIB, GIB, MINUTE, SECOND, PROJECT_ROOT };
