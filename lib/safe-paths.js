'use strict';
// Защита файловой системы. Любой путь, пришедший от пользователя, проходит через resolveInside():
//  • нельзя выйти за пределы выбранной корневой папки («../», абсолютные пути, символьные ссылки);
//  • закрыты секреты панели (config.json, server.db) и её служебные папки;
//  • в Windows запрещены недопустимые имена (CON, NUL, символы : * ? " < > |).
const fs = require('fs');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_FORBIDDEN_CHARS = /[:*?"<>|]/;
const PANEL_SECRET_FILES = /^(config\.json|server\.db)(-wal|-shm|-journal)?(\.bak.*)?$/i;
const PANEL_TEMP_NAME = /^\.sm-(upload|extract)-/; // временные файлы загрузки и распаковки

class UserError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Сравнение путей: в Windows регистр не важен. */
const comparable = value => (IS_WINDOWS ? String(value).toLowerCase() : String(value));
const withTrailingSeparator = value => (value.endsWith(path.sep) ? value : value + path.sep);

/** target лежит внутри root (или равен ему). */
function isInside(root, target) {
  const rootPath = comparable(path.resolve(root));
  const targetPath = comparable(path.resolve(target));
  return targetPath === rootPath || targetPath.startsWith(withTrailingSeparator(rootPath));
}

/** Настоящий путь ближайшей существующей папки: нужен, чтобы увидеть символьную ссылку ещё до создания файла. */
function realPathOfNearestExisting(target) {
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return fs.realpathSync(probe);
}

/** Понятное сообщение вместо технического кода ошибки файловой системы. */
function describeFsError(error) {
  const code = error && error.code;
  const messages = {
    ENOENT: 'Файл или папка не найдены',
    EACCES: 'Нет доступа (файл занят, защищён или не хватает прав)',
    EPERM: 'Нет доступа (файл занят, защищён или не хватает прав)',
    EBUSY: 'Файл занят другим процессом',
    ENOTEMPTY: 'Папка не пуста',
    EEXIST: 'Уже существует',
    ENOSPC: 'Недостаточно места на диске',
    EROFS: 'Диск доступен только для чтения',
    EFBIG: 'Файл слишком большой для файловой системы этого диска (FAT32 не принимает файлы больше 4 ГБ)',
    EISDIR: 'Это папка, а не файл',
    ENOTDIR: 'Это файл, а не папка',
    ENAMETOOLONG: 'Слишком длинное имя',
    EMFILE: 'Слишком много открытых файлов, попробуйте ещё раз',
  };
  return messages[code] || (error && error.message) || String(error);
}

/**
 * Создаёт «охранника путей» для конкретной установки панели.
 *  panelRoot            — папка самой панели (там config.json и server.db);
 *  fileRoot             — хранилище проектов (fileRoot из config.json);
 *  protectedDirs        — служебные папки панели, закрытые целиком (метаданные загрузок и т.п.);
 *  hardware             — модуль lib/hardware.js: blocked(путь), mountRoot(диск);
 *  allowExternalLinks   — разрешить символьные ссылки за пределы корня (опасно, по умолчанию нет);
 *  findApp(id)          — вернуть приложение по номеру (для области «папка приложения»).
 */
function createPathGuard({ panelRoot, fileRoot, protectedDirs = [], hardware, allowExternalLinks = false, findApp }) {
  const isSystemBlocked = real => !!(hardware && hardware.blocked && hardware.blocked(real));

  /** Секреты панели и служебные каталоги. */
  function isProtectedPath(absolutePath) {
    const resolved = path.resolve(absolutePath);
    if (comparable(path.dirname(resolved)) === comparable(panelRoot) && PANEL_SECRET_FILES.test(path.basename(resolved))) return true;
    return protectedDirs.some(dir => isInside(dir, resolved));
  }

  /** Папка панели или её родитель: их нельзя удалять, переименовывать и перемещать. */
  const isPanelAncestor = absolutePath => isInside(absolutePath, panelRoot);

  /** Скрытые временные файлы панели не показываются в списках. */
  const isPanelTempName = name => PANEL_TEMP_NAME.test(name);

  /** Главная проверка пути. Возвращает абсолютный путь или бросает UserError. */
  function resolveInside(root, relativePath) {
    const rootPath = path.resolve(root);
    const relative = String(relativePath || '');
    if (relative.includes('\0')) throw new UserError('Недопустимый путь');

    if (IS_WINDOWS) {
      for (const segment of relative.split(/[\\/]+/)) {
        if (segment && (WINDOWS_FORBIDDEN_CHARS.test(segment) || WINDOWS_RESERVED_NAME.test(segment))) {
          throw new UserError('Недопустимое имя: ' + segment);
        }
      }
    }

    const target = path.resolve(rootPath, relative);
    if (!isInside(rootPath, target)) throw new UserError('Недопустимый путь');
    if (isProtectedPath(target)) throw new UserError('Доступ к служебным файлам панели закрыт', 403);

    // Символьные ссылки: сравниваем НАСТОЯЩИЕ пути, а не те, что написал пользователь
    const realTarget = realPathOfNearestExisting(target);
    let realRoot;
    try { realRoot = fs.realpathSync(rootPath); } catch { realRoot = rootPath; }

    if (isSystemBlocked(realTarget) && !isSystemBlocked(realRoot)) throw new UserError('Этот системный каталог недоступен', 403);
    if (!allowExternalLinks && !isInside(realRoot, realTarget)) {
      throw new UserError('Символическая ссылка ведёт за пределы разрешённой папки', 403);
    }
    if (isProtectedPath(realTarget)) throw new UserError('Доступ к служебным файлам панели закрыт', 403);
    return target;
  }

  /**
   * Корневая папка для запроса. Область задаётся так: {} — хранилище проектов,
   * {app: 5} — рабочая папка приложения №5, {disk: 'D:\\'} — диск целиком (нужно право files.disks).
   */
  function resolveRoot(scope, user) {
    const disk = scope && scope.disk;
    const appId = scope && scope.app;
    if (disk) {
      if (appId) throw new UserError('Укажите либо приложение, либо диск');
      if (!user || !user.permissions || !user.permissions.has('files.disks')) {
        throw new UserError('Нет разрешения на работу с дисками компьютера', 403);
      }
      const mountRoot = hardware && hardware.mountRoot ? hardware.mountRoot(String(disk)) : null;
      if (!mountRoot) throw new UserError('Диск не найден или недоступен. Обновите список дисков.');
      if (!fs.existsSync(mountRoot)) throw new UserError('Диск недоступен: ' + mountRoot);
      return mountRoot;
    }
    const id = Number(appId);
    if (!appId || !id) return path.resolve(fileRoot);
    const app = findApp(id);
    if (!app) throw new UserError('Приложение не найдено', 404);
    const workingDir = path.resolve(app.working_dir);
    if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) throw new UserError('Рабочая папка не найдена: ' + workingDir);
    return workingDir;
  }

  const resolveScoped = (scope, relativePath, user) => resolveInside(resolveRoot(scope, user), relativePath);

  return { resolveInside, resolveRoot, resolveScoped, isProtectedPath, isPanelAncestor, isPanelTempName };
}

/** Область запроса {app, disk} из строки запроса или тела. */
function scopeOf(req) {
  const query = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const pick = key => query[key] || body[key] || undefined;
  return { app: pick('app'), disk: pick('disk') };
}

module.exports = { createPathGuard, scopeOf, describeFsError, isInside, comparable, UserError, IS_WINDOWS };
