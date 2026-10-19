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
