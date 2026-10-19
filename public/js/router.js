// Вход в систему и навигация между разделами.
//
// Навигация построена на штатной истории браузера (History API), поэтому работают:
//  • кнопки «назад/вперёд» браузера и боковые кнопки мыши (их обрабатывает сам браузер — мы их не перехватываем);
//  • клавиши Alt+← / Alt+→ и прямые ссылки на разделы, например  /#/files?path=minecraft/world
//  • восстановление позиции прокрутки при возврате на страницу.
// Адрес раздела:  #/<раздел>[?параметры]   или   #/app/<номер>/<вкладка>
const PAGES = {
  dash: { title: 'Панель', sub: 'Состояние всех процессов', perm: 'panel.view', render: () => dashboard() },
  apps: { title: 'Приложения', sub: 'Управление запущенными проектами', perm: 'apps.view', render: () => apps() },
  files: { title: 'Файлы', sub: 'Файловый менеджер', perm: 'files.view', render: () => files() },
  runtimes: { title: 'Runtime', sub: 'Обнаруженные среды выполнения', anyPerm: ['runtimes.view'], render: () => runtimes() },
  docker: { title: 'Docker', sub: 'Контейнеры Docker', perm: 'docker.manage', render: () => docker() },
  tasks: { title: 'Задачи', sub: 'Автоматизация по расписанию', perm: 'tasks.view', render: () => tasks() },
  backups: { title: 'Резервные копии', sub: 'Создание и восстановление архивов', perm: 'backups.view', render: () => backups() },
  audit: { title: 'Журнал', sub: 'История действий', perm: 'audit.view', render: () => audit() },
  settings: { title: 'Настройки', sub: 'Учётная запись и безопасность', perm: null, render: () => settings() },
  nodes: { title: 'Серверы', sub: 'Подключённые компьютеры', perm: 'settings.manage', render: () => nodesPage() },
  users: { title: 'Пользователи', sub: 'Учётные записи, роли и права', perm: 'users.manage', render: () => usersPage() },
  system: { title: 'Система', sub: 'Процессор, видеокарта, память и накопители', perm: 'system.view', render: () => systemPage() },
};
const SCROLL_SAVE_DELAY_MS = 150;
const SCROLL_RESTORE_RETRY_MS = [0, 200, 600];

/* ---------- адрес ⇄ раздел ---------- */

/** Из адреса получаем { page: 'files', params: {...} } или { page: 'app:12', tab: 'console' }. */
function parseRoute(hash = location.hash) {
  const text = hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = text.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (parts[0] === 'app' && /^\d+$/.test(parts[1] || '')) return { page: 'app:' + parts[1], tab: parts[2] || 'overview', params };
  return { page: PAGES[parts[0]] ? parts[0] : firstAllowedPage(), params };
}

function routeToHash(pageName, params = {}) {
  const clean = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  const query = clean.length ? '?' + new URLSearchParams(clean).toString() : '';
  if (String(pageName).startsWith('app:')) return `#/app/${pageName.split(':')[1]}/${params.tab || 'overview'}`;
  return `#/${pageName}${query}`;
}

const isAllowed = name => {
  const entry = PAGES[name];
  return !!entry && (entry.perm ? can(entry.perm) : entry.anyPerm ? canAny(...entry.anyPerm) : true);
};
const firstAllowedPage = () => Object.keys(PAGES).find(isAllowed) || 'settings';

/* ---------- переходы ---------- */

let routeParams = {}; // параметры текущего раздела (для восстановления при возврате)

/** Запоминаем прокрутку страницы в записи истории — чтобы вернуться на то же место. */
let scrollTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, ''), SCROLL_SAVE_DELAY_MS);
}, { passive: true });

/** Открыть раздел. page('files'), page('app:12'), page('files', { path: 'a/b' }). Добавляет запись в историю браузера. */
function page(name, params = {}, options = {}) {
  const target = String(name).startsWith('app:') ? name : (PAGES[name] ? name : firstAllowedPage());
  const hash = routeToHash(target, params);
  if (location.hash !== hash) {
    history[options.replace ? 'replaceState' : 'pushState']({ scrollY: 0 }, '', hash);
  }
  renderRoute({ page: target, tab: params.tab, params });
}

/** Меняет адрес без новой записи в истории (например, смена вкладки приложения или папки при поиске). */
function updateRoute(name, params = {}) {
  const hash = routeToHash(name, params);
  if (location.hash !== hash) history.replaceState(history.state || {}, '', hash);
  routeParams = params;
}

async function renderRoute(route, { restoreScroll = false } = {}) {
  navigationId++;
  clearInterval(statsTimer);
  if (typeof closeModal === 'function') closeModal();
  currentPage = route.page;
  routeParams = route.params || {};
  const name = route.page;
  if (name.startsWith('app:')) {
    document.querySelectorAll('aside [data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === 'apps'));
    $('title').textContent = 'Приложение';
    $('sub').textContent = 'Управление приложением';
    await appWorkspace(Number(name.split(':')[1]), route.tab || 'overview');
  } else {
    const entry = PAGES[name];
    if (!isAllowed(name)) { page(firstAllowedPage(), {}, { replace: true }); return; }
    $('title').textContent = entry.title;
    $('sub').textContent = entry.sub;
    document.querySelectorAll('aside [data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    await entry.render();
  }
  const y = restoreScroll ? (history.state && history.state.scrollY) || 0 : 0;
  SCROLL_RESTORE_RETRY_MS.forEach(delay => setTimeout(() => window.scrollTo(0, y), delay));
}

// «Назад»/«вперёд» браузера, боковые кнопки мыши, Alt+←/→
window.addEventListener('popstate', () => renderRoute(parseRoute(), { restoreScroll: true }));

const refreshCurrent = () => renderRoute(parseRoute());

/* ---------- вход и запуск ---------- */

async function login() {
  try {
    const data = await api('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('u').value, password: $('p').value }) });
    token = data.token;
    localStorage.sm_token = token;
    await show();
  } catch (error) {
    $('err').textContent = error.message;
  }
}

async function logout() {
  localStorage.removeItem('sm_token');
  token = '';
  location.hash = '';
  location.reload();
}

/** Показ нужных пунктов меню и кнопок по правам пользователя. */
function applyPermissions() {
  document.querySelectorAll('aside [data-page]').forEach(button => { button.hidden = !isAllowed(button.dataset.page); });
  document.querySelectorAll('[data-perm]').forEach(element => { element.hidden = !can(element.dataset.perm); });
  const banner = $('banner');
  if (banner) banner.hidden = !(me && me.defaultPassword);
}

async function show() {
  try {
    setCurrentUser(await api('/me'));
    $('login').className = 'hidden';
    $('app').className = 'app';
    $('who').innerHTML = `${esc(me.username)}<br><small>${esc(roleTitle(me.role))}</small><br><button class="link" onclick="logout()">Выйти</button>`;
    await loadNodes();
    applyPermissions();
    connectWS();
    const route = location.hash ? parseRoute() : { page: firstAllowedPage(), params: {} };
    history.replaceState(history.state || {}, '', routeToHash(route.page, { ...route.params, tab: route.tab }));
    renderRoute(route, { restoreScroll: true });
  } catch {
    localStorage.removeItem('sm_token');
    token = '';
    $('login').className = 'login';
    $('app').className = 'hidden';
  }
}

const roleTitle = role => ({ admin: 'Администратор', operator: 'Оператор', viewer: 'Только просмотр' }[role] || role);

document.addEventListener('click', event => {
  const nav = event.target.closest('aside [data-page]');
  if (nav) page(nav.dataset.page);
});

if (token) show();
