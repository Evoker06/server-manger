// Ядро интерфейса: состояние, запросы к API, вспомогательные функции, окна, уведомления, WebSocket.

let node = localStorage.sm_node || 'local', nodeList = [], token = localStorage.sm_token || '', me = null, ws = null, currentPage = 'dash', pathNow = '', appCache = [], statsTimer = null, activeAppId = null;
const $ = id => document.getElementById(id);
// Адрес запроса. Страницы панели (вход, пользователи, серверы, билеты) всегда обслуживает сама панель, остальное — выбранный сервер.
const apiPath = (u, forNode = node) => '/api' + (forNode !== 'local' && !/^\/(login|me|password|nodes|users|permissions|tickets)(\/|\?|$)/.test(u) ? '/n/' + encodeURIComponent(forNode) : '') + u;

// Права текущего пользователя (список приходит с сервера в /api/me). Сервер проверяет их сам — здесь они только для показа нужных кнопок.
let permissionSet = new Set();
const can = id => permissionSet.has(id);
const canAny = (...ids) => ids.some(can);
function setCurrentUser(user) {
  me = user;
  permissionSet = new Set((user && user.permissions) || []);
}

const basename = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
document.addEventListener('submit', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.target.id === 'u' || e.target.id === 'p'))
    login();
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsArg = v => esc(JSON.stringify(String(v ?? '')));
const fmtSize = n => {
  n = +n || 0;
  if (n < 1024)
    return n + ' B';
  if (n < 1048576)
    return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824)
    return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
};
const fmtTime = ms => {
  let s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600);
  s %= 3600;
  let m = Math.floor(s / 60);
  s %= 60;
  return `${h ? String(h).padStart(2, '0') + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
// Номер текущего перехода между разделами. Ответ на запрос ДАННЫХ (GET), начатый на предыдущей странице, к новой странице не применяется:
// иначе запоздавший ответ перерисовал бы содержимое поверх страницы, на которую пользователь уже перешёл.
let navigationId = 0;

async function api(url, opt = {}) {
  const startedOnNavigation = navigationId;
  opt.headers = { ...(opt.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  const r = await fetch(apiPath(url, opt.node), opt); // opt.node — запрос к конкретному серверу независимо от выбранного сейчас
  const raw = await r.text();
  const isDataRequest = !opt.method || opt.method === 'GET';
  if (isDataRequest && !opt.keepAcrossPages && startedOnNavigation !== navigationId) return new Promise(() => {}); // устаревший ответ: молча отбрасываем
  let d = raw;
  try {
    d = raw ? JSON.parse(raw) : '';
  }
  catch {
  }
  if (r.status === 401 && url !== '/login' && token) {
    localStorage.removeItem('sm_token');
    token = '';
    location.reload();
    throw Error('Сессия истекла');
  }
  if (!r.ok) {
    const e = Error((d && d.error) || (typeof d === 'string' && d.trim().slice(0, 200)) || `HTTP ${r.status}`);
    e.status = r.status;
    e.data = d;
    throw e;
  }
  return d;
}

function toolbar(html = '') {
  return `<div class=toolbar>${html}</div>`;
}

function modal(title, body) {
  $('modal').className = 'modal';
  $('modal').innerHTML = `<div><div class=modalhead><h2 style="margin:0">${esc(title)}</h2><button class=close onclick=closeModal()>×</button></div>${body}</div>`;
}
function closeModal() {
  $('modal').className = 'hidden';
  $('modal').innerHTML = '';
  clearInterval(statsTimer);
}
function connectWS() {
  if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState))
    return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}&node=${encodeURIComponent(node)}`);
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'output' && String(d.id) === String(activeAppId)) {
      consoleAppend(d.data);
    }
    if (d.type === 'exit') {
      if (currentPage === 'dash' || currentPage === 'apps')
        refreshCurrent();
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
}

function pathSep(p) {
  return p.includes('\\') ? '\\' : '/';
}

/* ================= M7 ================= */
const JH = { 'Content-Type': 'application/json' };

async function apiText(url) {
  const r = await fetch(apiPath(url), { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const t = await r.text();
  if (r.status === 401 && token) {
    localStorage.removeItem('sm_token');
    token = '';
    location.reload();
    throw Error('Сессия истекла');
  }
  if (!r.ok) {
    let m;
    try {
      m = JSON.parse(t).error;
    }
    catch {
    }
    throw Error(m || `HTTP ${r.status}`);
  }
  return t;
}
function toast(msg, bad) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.className = 'toast show' + (bad ? ' bad' : '');
  t.textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.className = 'toast', bad ? 6000 : 3000);
}
const fmtDate = s => s ? new Date(s).toLocaleString() : '—';

/* ================= Оформление: иконки, тема, боковое меню ================= */
// Иконки рисуются прямо в странице (внешние шрифты и CDN запрещены политикой безопасности панели).
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  cube: '<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  tasks: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  backup: '<path d="m16 16-4-4-4 4M12 12v9"/><path d="M20.4 18.9A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 3 16.3"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  server: '<path d="M22 12H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1zM6 16h.01M10 16h.01"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};
const ic = (name, cls = '') => `<i class="ic ${cls}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg></i>`;
function applyIcons(root = document) {
  root.querySelectorAll('[data-ic]').forEach(el => {
    const svg = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[el.dataset.ic] || ''}</svg>`;
    el.innerHTML = svg;
    if (!el.classList.contains('ic') && !el.classList.contains('logo')) el.classList.add('ic');
    if (el.classList.contains('logo')) el.style.cssText = '';
    el.removeAttribute('data-ic');
  });
}
applyIcons();

function toggleSidebar() { document.body.classList.toggle('nav-open'); }
document.addEventListener('click', e => { if (e.target.closest('aside nav button')) document.body.classList.remove('nav-open'); });

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.sm_theme = next; } catch { }
  if (typeof dashDrawChart === 'function') dashDrawChart(); // график берёт цвета из темы
}

/** Счётчики в боковом меню — только настоящие данные (ничего не выдумываем). */
function setNavBadges() {
  const apps = $('nb-apps'), nodes = $('nb-nodes'), sel = $('nodeSel');
  if (apps) {
    const running = appCache.filter(a => a.running).length;
    apps.textContent = appCache.length ? `${running}/${appCache.length}` : '';
    apps.className = running ? 'g' : '';
  }
  if (nodes && sel) nodes.textContent = sel.options.length > 1 ? String(sel.options.length) : '';
}
