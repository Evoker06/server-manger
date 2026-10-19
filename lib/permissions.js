'use strict';
// Система прав доступа. ВСЕ решения «можно / нельзя» принимаются здесь, на сервере.
//
// Как это работает:
//  1. У каждого пользователя есть РОЛЬ (набор прав по умолчанию) и, при желании, ИНДИВИДУАЛЬНЫЕ права:
//     grant — добавить к роли, revoke — убрать у роли. Администратор всегда имеет все права.
//  2. Каждый маршрут API описан в таблице ROUTE_RULES: какое разрешение нужно для запроса.
//     Маршрута нет в таблице — доступ запрещён всем, кроме администратора (принцип «запрещено по умолчанию»).
//  3. Проверку делает auth.guard для каждого запроса к панели и nodes.proxy для запросов к удалённым серверам.
//     Удалённый сервер дополнительно проверяет права сам (панель передаёт их в заголовке).

// danger: true — разрешение фактически позволяет выполнять код на сервере (прямо или через подмену файлов запуска).
const PERMISSION_GROUPS = [
  { id: 'panel', title: 'Панель', items: [
    { id: 'panel.view', title: 'Просмотр панели (главная страница)' },
  ] },
  { id: 'apps', title: 'Приложения', items: [
    { id: 'apps.view', title: 'Просмотр списка приложений' },
    { id: 'apps.create', title: 'Создание приложений', danger: true },
    { id: 'apps.edit', title: 'Редактирование настроек приложений', danger: true },
    { id: 'apps.delete', title: 'Удаление приложений' },
    { id: 'apps.control', title: 'Запуск и остановка' },
    { id: 'apps.restart', title: 'Перезапуск' },
    { id: 'apps.console', title: 'Отправка команд в консоль приложения', danger: true },
  ] },
  { id: 'logs', title: 'Логи', items: [
    { id: 'logs.view', title: 'Просмотр логов и консоли' },
    { id: 'logs.clear', title: 'Очистка логов' },
  ] },
  { id: 'files', title: 'Файлы', items: [
    { id: 'files.view', title: 'Просмотр файлов и папок' },
    { id: 'files.upload', title: 'Загрузка файлов', danger: true },
    { id: 'files.download', title: 'Скачивание файлов' },
    { id: 'files.mkdir', title: 'Создание папок и файлов' },
    { id: 'files.rename', title: 'Переименование' },
    { id: 'files.move_copy', title: 'Перемещение и копирование' },
    { id: 'files.delete', title: 'Удаление файлов и папок' },
    { id: 'files.edit', title: 'Редактирование содержимого файлов', danger: true },
    { id: 'files.extract', title: 'Распаковка архивов', danger: true },
    { id: 'files.disks', title: 'Доступ к дискам компьютера (вне хранилища проектов)', danger: true },
  ] },
  { id: 'backups', title: 'Резервные копии', items: [
    { id: 'backups.view', title: 'Просмотр резервных копий' },
    { id: 'backups.create', title: 'Создание резервных копий' },
    { id: 'backups.restore', title: 'Восстановление из копии', danger: true },
    { id: 'backups.delete', title: 'Удаление резервных копий' },
  ] },
  { id: 'tasks', title: 'Задачи по расписанию', items: [
    { id: 'tasks.view', title: 'Просмотр задач' },
    { id: 'tasks.manage', title: 'Создание, изменение и запуск задач', danger: true },
  ] },
  { id: 'system', title: 'Система', items: [
    { id: 'system.view', title: 'Сведения о компьютере и дисках' },
    { id: 'runtimes.view', title: 'Среды выполнения (Java, Node.js, Python…)' },
    { id: 'audit.view', title: 'Журнал действий' },
    { id: 'docker.manage', title: 'Управление Docker', danger: true },
  ] },
  { id: 'admin', title: 'Администрирование', items: [
    { id: 'users.manage', title: 'Управление пользователями (создание, удаление, пароли)', danger: true },
    { id: 'users.permissions', title: 'Создание и изменение прав пользователей', danger: true },
    { id: 'settings.manage', title: 'Глобальные настройки панели (подключение серверов)', danger: true },
  ] },
];

const CATALOG = PERMISSION_GROUPS.flatMap(group => group.items.map(item => ({ ...item, group: group.id, groupTitle: group.title })));
const ALL_IDS = CATALOG.map(item => item.id);
const TITLE_BY_ID = Object.fromEntries(CATALOG.map(item => [item.id, item.title]));

// «Для X нужно ещё Y»: выдали загрузку файлов — значит, нужен и просмотр папок.
const FILE_ACTIONS = ['upload', 'download', 'mkdir', 'rename', 'move_copy', 'delete', 'edit', 'extract', 'disks'];
const IMPLIES = {
  'apps.create': ['apps.view'],
  'apps.edit': ['apps.view'],
  'apps.delete': ['apps.view'],
  'apps.control': ['apps.view'],
  'apps.restart': ['apps.view'],
  'apps.console': ['apps.view', 'logs.view'],
  'logs.clear': ['logs.view'],
  'backups.create': ['backups.view'],
  'backups.restore': ['backups.view'],
  'backups.delete': ['backups.view'],
  'tasks.manage': ['tasks.view'],
  'users.permissions': ['users.manage'],
  ...Object.fromEntries(FILE_ACTIONS.map(action => [`files.${action}`, ['files.view']])),
};

const ROLES = {
  admin: { title: 'Администратор', permissions: ALL_IDS },
  operator: {
    title: 'Оператор',
    permissions: [
      'panel.view', 'apps.view', 'apps.control', 'apps.restart', 'apps.console', 'logs.view', 'logs.clear',
      'files.view', 'files.upload', 'files.download', 'files.mkdir', 'files.rename', 'files.delete', 'files.edit',
      'backups.view', 'backups.create', 'backups.restore',
    ],
  },
  viewer: { title: 'Только просмотр', permissions: ['panel.view', 'apps.view', 'logs.view'] },
};
const ROLE_IDS = Object.keys(ROLES);

/** Добавляет к набору прав всё, что из них следует (см. IMPLIES). */
function withImplied(ids) {
  const result = new Set();
  const visit = id => {
    if (!TITLE_BY_ID[id] || result.has(id)) return;
    result.add(id);
    for (const implied of IMPLIES[id] || []) visit(implied);
  };
  ids.forEach(visit);
  return result;
}

/** Читает индивидуальные права из поля users.perms_json; всё лишнее отбрасывается. */
function parseOverrides(json) {
  let data = {};
  try { data = JSON.parse(json || '{}') || {}; } catch { /* повреждённое значение = нет индивидуальных прав */ }
  return sanitizeOverrides(data);
}

function sanitizeOverrides(data) {
  const clean = list => [...new Set((Array.isArray(list) ? list : []).map(String))].filter(id => TITLE_BY_ID[id]);
  const grant = clean(data && data.grant);
  const revoke = clean(data && data.revoke).filter(id => !grant.includes(id));
  return { grant, revoke };
}

/** Итоговый набор прав пользователя: роль + grant − revoke (+ следствия). Администратор — всё. */
function effectivePermissions(user) {
  if (!user) return new Set();
  if (user.role === 'admin') return new Set(ALL_IDS);
  const role = ROLES[user.role];
  const base = new Set(role ? role.permissions : []);
  const overrides = user.overrides || parseOverrides(user.perms_json);
  overrides.grant.forEach(id => base.add(id));
  overrides.revoke.forEach(id => base.delete(id));
  const result = withImplied(base);
  // «Отозвано» сильнее следствий: если явно убрали просмотр файлов, остальные файловые права не вернут его обратно
  overrides.revoke.forEach(id => result.delete(id));
  return result;
}

/** Права пользователя, пришедшего через главную панель (заголовок x-panel-permissions). */
function permissionsFromHeader(value) {
  return new Set(String(value || '').split(',').map(s => s.trim()).filter(id => TITLE_BY_ID[id]));
}

/* ---------------- Таблица маршрутов: какое право нужно для запроса ---------------- */

const need = (...ids) => ({ all: ids });
const anyOf = (...ids) => ({ any: ids });
const NONE = { all: [] }; // достаточно войти в систему
const APP_FORM = anyOf('apps.create', 'apps.edit');       // конструктор запуска
const RUNTIMES = anyOf('runtimes.view', 'apps.create', 'apps.edit');

/** Для скачивания нужное право зависит от того, ЧТО скачивают. */
function downloadSpec(query) {
  if (query.backup) return need('backups.view');
  if (query.applog) return need('logs.view');
  return need('files.download');
}

// [метод, шаблон пути без /api, требование]. Требование — объект или функция (query) => объект.
const ROUTE_RULES = [
  // Любому вошедшему пользователю
  ['GET', /^\/me$/, NONE],
  ['POST', /^\/password$/, NONE],
  ['GET', /^\/system$/, NONE],
  ['GET', /^\/nodes$/, NONE],
  ['GET', /^\/nodes\/status$/, NONE],
  ['POST', /^\/tickets\/download$/, NONE], // права на цель проверяются внутри обработчика

  // Серверы и пользователи
  ['GET', /^\/nodes\/discover$/, need('settings.manage')],
  ['POST', /^\/nodes(\/test|\/pair)?$/, need('settings.manage')],
  ['PUT', /^\/nodes\/\d+$/, need('settings.manage')],
  ['DELETE', /^\/nodes\/\d+$/, need('settings.manage')],
  ['GET', /^\/permissions$/, need('users.manage')],
  ['GET', /^\/users$/, need('users.manage')],
  ['POST', /^\/users$/, need('users.manage')],
  ['PUT', /^\/users\/\d+$/, need('users.manage')], // смена роли и прав дополнительно требует users.permissions
  ['DELETE', /^\/users\/\d+$/, need('users.manage')],
  ['GET', /^\/audit$/, need('audit.view')],

  // Приложения
  ['GET', /^\/apps$/, need('apps.view')],
  ['GET', /^\/apps\/\d+$/, need('apps.view')],
  ['GET', /^\/apps\/\d+\/stats$/, need('apps.view')],
  ['GET', /^\/apps\/\d+\/output$/, need('logs.view')],
  ['GET', /^\/apps\/\d+\/log$/, need('logs.view')],
  ['DELETE', /^\/apps\/\d+\/log$/, need('logs.clear')],
  ['POST', /^\/apps$/, need('apps.create')],
  ['POST', /^\/apps\/import$/, need('apps.create')],
  ['PUT', /^\/apps\/\d+$/, need('apps.edit')],
  ['DELETE', /^\/apps\/\d+$/, need('apps.delete')],
  ['POST', /^\/apps\/\d+\/(start|stop|kill)$/, need('apps.control')],
  ['POST', /^\/apps\/\d+\/restart$/, need('apps.restart')],
  ['POST', /^\/apps\/\d+\/command$/, need('apps.console')],
  ['GET', /^\/apps\/\d+\/profiles$/, need('apps.view')],
  ['POST', /^\/apps\/\d+\/profiles$/, need('apps.edit')],
  ['PUT', /^\/profiles\/\d+$/, need('apps.edit')],
  ['DELETE', /^\/profiles\/\d+$/, need('apps.edit')],
  ['POST', /^\/apps\/\d+\/profiles\/\d+\/apply$/, need('apps.control')],

  // Конструктор запуска и определение проектов
  ['GET', /^\/launch\/(presets|inspect)$/, APP_FORM],
  ['POST', /^\/launch\/preview$/, APP_FORM],
  ['GET', /^\/port-check$/, APP_FORM],
  ['POST', /^\/(detect|scan)$/, APP_FORM],
  ['POST', /^\/projects\/analyze$/, { all: ['files.view'], any: ['apps.create', 'apps.edit'] }],
  ['GET', /^\/runtimes$/, RUNTIMES],
  ['POST', /^\/runtimes\/suggest$/, RUNTIMES],
  ['GET', /^\/browse$/, need('files.disks')],

  // Резервные копии, задачи, Docker, оборудование
  ['GET', /^\/backups$/, need('backups.view')],
  ['POST', /^\/apps\/\d+\/backup$/, need('backups.create')],
  ['POST', /^\/apps\/\d+\/restore$/, need('backups.restore')],
  ['DELETE', /^\/backups\/[^/]+$/, need('backups.delete')],
  ['GET', /^\/tasks(\/preview)?$/, need('tasks.view')],
  ['POST', /^\/tasks(\/\d+\/run)?$/, need('tasks.manage')],
  ['PUT', /^\/tasks\/\d+$/, need('tasks.manage')],
  ['DELETE', /^\/tasks\/\d+$/, need('tasks.manage')],
  ['*', /^\/docker(\/|$)/, need('docker.manage')],
  ['GET', /^\/hw\/(info|live|disks)$/, need('system.view')],

  // Файлы
  ['GET', /^\/files$/, need('files.view')],
  ['GET', /^\/files\/search$/, need('files.view')],
  ['GET', /^\/file$/, need('files.view')],
  ['POST', /^\/file$/, anyOf('files.edit', 'files.mkdir')], // создание нового файла — mkdir, изменение — edit (уточняется в обработчике)
  ['DELETE', /^\/file$/, need('files.delete')],
  ['POST', /^\/mkdir$/, need('files.mkdir')],
  ['POST', /^\/rename$/, need('files.rename')],
  ['POST', /^\/files\/batch$/, need('files.view')], // конкретное право зависит от операции — проверяется в обработчике
  ['POST', /^\/transfer$/, need('files.move_copy')],
  ['GET', /^\/transfer\/[^/]+$/, need('files.move_copy')],
  ['DELETE', /^\/transfer\/[^/]+$/, need('files.move_copy')],
  ['GET', /^\/extract\/tools$/, need('files.extract')],
  ['POST', /^\/extract$/, need('files.extract')],
  ['GET', /^\/extract\/[^/]+$/, need('files.extract')],
  ['GET', /^\/download$/, downloadSpec],
  ['POST', /^\/uploads$/, need('files.upload')],
  ['GET', /^\/uploads\/[\w-]+$/, need('files.upload')],
  ['PUT', /^\/uploads\/[\w-]+$/, need('files.upload')],
  ['POST', /^\/uploads\/[\w-]+\/finish$/, need('files.upload')],
  ['DELETE', /^\/uploads\/[\w-]+$/, need('files.upload')],
];

// Маршруты, где параметр ?disk= выводит за пределы хранилища проектов — для них нужно files.disks
const DISK_SCOPED = /^\/(files|file|download|mkdir|rename|transfer|extract|uploads|projects)(\/|$)/;

function normalizePath(apiPath) {
  return String(apiPath || '').replace(/\/+$/, '') || '/';
}

/** Что требуется для запроса. undefined — маршрут не описан (запрещён). */
function requirementFor(method, apiPath, query = {}) {
  const verb = method === 'HEAD' ? 'GET' : method;
  const pathOnly = normalizePath(apiPath);
  for (const [ruleMethod, pattern, requirement] of ROUTE_RULES) {
    if ((ruleMethod === '*' || ruleMethod === verb) && pattern.test(pathOnly)) {
      return typeof requirement === 'function' ? requirement(query) : requirement;
    }
  }
  return undefined;
}

function titles(ids) {
  return ids.map(id => `«${TITLE_BY_ID[id] || id}»`).join(', ');
}

/** Проверяет запрос. Возвращает { ok, reason }. permissions — Set прав пользователя. */
function check(permissions, method, apiPath, query = {}) {
  const requirement = requirementFor(method, apiPath, query);
  if (!requirement) return { ok: false, reason: 'Этот запрос не разрешён' };
  const missingAll = (requirement.all || []).filter(id => !permissions.has(id));
  if (missingAll.length) return { ok: false, reason: `Недостаточно прав. Нужно разрешение: ${titles(missingAll)}` };
  if (requirement.any && requirement.any.length && !requirement.any.some(id => permissions.has(id))) {
    return { ok: false, reason: `Недостаточно прав. Нужно одно из разрешений: ${titles(requirement.any)}` };
  }
  if (query.disk && DISK_SCOPED.test(normalizePath(apiPath)) && !permissions.has('files.disks')) {
    return { ok: false, reason: `Недостаточно прав. Нужно разрешение: ${titles(['files.disks'])}` };
  }
  return { ok: true };
}

module.exports = {
  PERMISSION_GROUPS, CATALOG, ALL_IDS, ROLES, ROLE_IDS, ROUTE_RULES,
  IMPLIES, withImplied, parseOverrides, sanitizeOverrides, effectivePermissions, permissionsFromHeader,
  requirementFor, check, titles,
};
