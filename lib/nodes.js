'use strict';
// Удалённые серверы: подключение чужих компьютеров к одной панели.
//  • Панель: список серверов, прокси /api/n/<id>/..., поиск агентов в сети, подключение по коду.
//  • Агент:  обычный Server Manager с "agent": true (или agentToken) в config.json.
// Права пользователей проверяются в двух местах: панель проверяет запрос по таблице прав (lib/permissions.js)
// и передаёт агенту список разрешений в заголовке x-panel-permissions — агент проверяет их ещё раз сам.
const http = require('http'), https = require('https'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
const discovery = require('./discovery');
const permissions = require('./permissions');
const { sendJson } = require('./http-helpers');
const VERSION = require('../package.json').version;

const TIMEOUT_PING = 4000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Постоянные соединения с агентами: без них каждая часть загружаемого файла открывала бы новое TCP-соединение
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 16 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 16 });
// Эти маршруты относятся только к самой панели и на удалённые серверы не пересылаются
const LOCAL_ONLY_PATHS = /^\/(users|nodes|permissions|password|me|login|tickets|agent)(\/|$)/;
const HEADERS_NOT_FORWARDED = ['host', 'connection', 'authorization', 'cookie', 'upgrade', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-panel-user', 'x-panel-permissions'];

function friendly(e) {
  const c = e && e.code, m = String(e && e.message || e);
  if (c === 'ECONNREFUSED')
    return 'соединение отклонено (агент не запущен или порт закрыт)';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN')
    return 'адрес не найден (проверьте IP/имя)';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'ETIMEDOUT')
    return 'хост недоступен (проверьте IP, firewall, VPN)';
  if (c === 'ECONNRESET')
    return 'соединение разорвано';
  if (/CERT|SSL|TLS/i.test(String(c) + m))
    return 'ошибка TLS-сертификата';
  return m;
}
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s)
    throw new Error('Укажите адрес сервера');
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s))
    throw new Error('Поддерживаются только http:// и https://');
  if (!/^https?:\/\//i.test(s))
    s = 'http://' + s;
  let u;
  try {
    u = new URL(s);
  }
  catch {
    throw new Error('Некорректный адрес');
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname)
    throw new Error('Некорректный адрес');
  return u.origin + u.pathname.replace(/\/+$/, '');
}
function target(n, p) {
  const b = new URL(n.url), tls = b.protocol === 'https:';
  return { lib: tls ? https : http, opts: { hostname: b.hostname.replace(/^\[|\]$/g, ''), port: b.port || (tls ? 443 : 80), path: b.pathname.replace(/\/+$/, '') + p, agent: tls ? HTTPS_AGENT : HTTP_AGENT } };
}
/** Небольшой JSON-клиент для служебных вызовов (pair/verify). */
function requestJson(n, method, p, body, headers, timeout = 5000) {
  return new Promise(resolve => {
    let t;
    try {
      t = target(n, p);
    }
    catch (e) {
      return resolve({ status: 0, error: e.message });
    }
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) };
    const rq = t.lib.request({ ...t.opts, method, headers: h, timeout }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        if (s.length < 65536)
          s += c;
      });
      res.on('end', () => {
        let j = null;
        try {
          j = JSON.parse(s);
        }
        catch {
        }
        resolve({ status: res.statusCode, json: j });
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('нет ответа (таймаут)')));
    rq.on('error', e => resolve({ status: 0, error: friendly(e) }));
    rq.end(data);
  });
}
/** Проверка связи и токена: GET /api/system на агенте. */
function ping(n) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let t;
    try {
      t = target(n, '/api/system');
    }
    catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const rq = t.lib.request({ ...t.opts, method: 'GET', headers: { authorization: 'Bearer ' + n.token }, timeout: TIMEOUT_PING }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        if (body.length < 65536)
          body += c;
      });
      res.on('end', () => {
        if (res.statusCode === 401)
          return resolve({ ok: false, error: 'агент отклонил токен (agentToken в config.json агента)' });
        if (res.statusCode !== 200)
          return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
        let sys;
        try {
          sys = JSON.parse(body);
        }
        catch {
          return resolve({ ok: false, error: 'ответ не похож на Server Manager' });
        }
        resolve({ ok: true, ms: Date.now() - t0, system: sys });
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('нет ответа (таймаут)')));
    rq.on('error', e => resolve({ ok: false, error: friendly(e) }));
    rq.end();
  });
}
/** Проверяет, что по адресу действительно агент с нашим токеном (HMAC-ответ на случайный nonce), и возвращает его id. */
async function verifyAgent(n, token, expectedId) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const r = await requestJson(n, 'POST', '/api/agent/verify', { nonce }, null, 3000);
  if (r.status !== 200 || !r.json || typeof r.json.proof !== 'string')
    return null;
  const a = Buffer.from(r.json.proof), b = Buffer.from(crypto.createHmac('sha256', token).update(nonce).digest('hex'));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return null;
  if (expectedId && r.json.id !== expectedId)
    return null;
  return String(r.json.id || '');
}

/**
 * Пересылает запрос req на агента, ответ потоком возвращается в res.
 * restPath — путь после /api/n/<id>. user — пользователь панели (его права уходят агенту в заголовке).
 * idleMs — сколько ждать молчащего агента (по умолчанию 20 минут).
 */
function forward(node, req, res, restPath, user, idleMs) {
  let destination;
  try {
    restPath = String(restPath || '/');
    const url = new URL('http://x' + (restPath.startsWith('/') ? restPath : '/' + restPath)); // «//x» не превратится в адрес другого хоста
    url.searchParams.delete('token');
    url.searchParams.delete('ticket');
    destination = target(node, '/api' + url.pathname.replace(/\/+$/, '') + url.search); // '/api' добавляется ПОСЛЕ нормализации — выйти из /api нельзя
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const headers = { ...req.headers };
  for (const name of HEADERS_NOT_FORWARDED) delete headers[name];
  headers.authorization = 'Bearer ' + node.token;
  headers['x-panel-user'] = encodeURIComponent((user && user.username) || 'admin');
  headers['x-panel-permissions'] = [...((user && user.permissions) || [])].join(',');

  const upstream = destination.lib.request({ ...destination.opts, method: req.method, headers, timeout: idleMs }, upstreamResponse => {
    // 401 агента ≠ «сессия панели истекла»: иначе браузер разлогинит пользователя
    if (upstreamResponse.statusCode === 401) {
      upstreamResponse.resume();
      return sendJson(res, 502, { error: `Сервер «${node.name}» отклонил токен: проверьте agentToken` });
    }
    res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    upstreamResponse.on('error', () => res.destroy());
    upstreamResponse.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('нет ответа (таймаут)')));
  upstream.on('error', error => {
    if (!res.headersSent) sendJson(res, 502, { error: `Сервер «${node.name}» недоступен: ${friendly(error)}` });
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); }); // браузер ушёл — прекращаем и запрос к агенту
  req.pipe(upstream);
}

function listenError(e, port, host) {
  const win = process.platform === 'win32';
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n✗ Порт ${port} уже занят другой программой — панель не запущена.`);
    if (win) {
      console.error(`  Кто занял порт:  netstat -ano | findstr :${port}`);
      console.error('  Что за процесс:  tasklist /fi "PID eq <число из последнего столбца>"');
      if (port === 80)
        console.error('  На 80 порту чаще всего: IIS («Служба публикации в Интернете»), XAMPP/Apache/nginx, Skype, ещё одна копия панели.\n  Если PID = 4 (System) — это http.sys; остановите IIS командой  iisreset /stop  (PowerShell от администратора).');
    }
    else
      console.error(`  Кто занял порт:  sudo ss -ltnp | grep :${port}`);
    console.error('  Или укажите другой порт ("port") в config.json.');
  }
  else if (e && e.code === 'EACCES') {
    console.error(`\n✗ Нет прав слушать порт ${port}.`);
    if (win)
      console.error('  Запустите PowerShell «от имени администратора». Если не помогло, порт может быть зарезервирован системой:\n  netsh int ipv4 show excludedportrange protocol=tcp');
    else
      console.error('  Порты < 1024 требуют прав. Разрешите Node без root:\n  sudo setcap \'cap_net_bind_service=+ep\' "$(readlink -f "$(which node)")"');
    console.error('  Или укажите другой порт ("port") в config.json.');
  }
  else if (e && e.code === 'EADDRNOTAVAIL') {
    console.error(`\n✗ Адрес "${host}" не принадлежит этому компьютеру. Поставьте "host": "0.0.0.0" в config.json.`);
  }
  else
    console.error(e);
  process.exit(1);
}

function create({ db, cfg, bcrypt, auth, audit, app, express }) {
  const getNode = id => db.prepare('SELECT * FROM nodes WHERE id=?').get(+id);
  const pub = n => ({ id: n.id, name: n.name, url: n.url });
  const json = express.json({ limit: '1mb' });
  const proxyIdleMs = cfg.timeouts.proxyIdleMinutes * 60 * 1000;
  const hasAccess = (userId, node) => !!db.prepare('SELECT 1 FROM user_nodes WHERE user_id=? AND node=?').get(userId, String(node));
  const mayUseNode = auth.mayUseNode;

  /* ================= сторона АГЕНТА ================= */
  const agentMode = cfg.agent === true || !!cfg.agentToken;
  if (agentMode) {
    let dirty = false;
    if (!cfg.agentToken) {
      cfg.agentToken = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }
    if (!cfg.agentId) {
      cfg.agentId = crypto.randomBytes(8).toString('hex');
      dirty = true;
    }
    if (dirty)
      try { // сохраняем, чтобы токен и id не менялись при перезапуске
        const p = path.join(__dirname, '..', 'config.json'), cur = JSON.parse(fs.readFileSync(p, 'utf8'));
        cur.agentToken = cfg.agentToken;
        cur.agentId = cfg.agentId;
        fs.writeFileSync(p, JSON.stringify(cur, null, 2));
      }
      catch (e) {
        console.warn('[agent] не удалось сохранить config.json (' + e.message + ') — токен будет меняться при каждом запуске');
      }
  }
  const AGENT_TOKEN = typeof cfg.agentToken === 'string' && cfg.agentToken.length >= 24 ? cfg.agentToken : '';
  if (cfg.agentToken && !AGENT_TOKEN)
    console.warn('[agent] agentToken короче 24 символов — режим агента ВЫКЛЮЧЕН');
  const agentName = String(cfg.agentName || os.hostname()).slice(0, 60);
  function isAgentToken(t) {
    if (!AGENT_TOKEN || typeof t !== 'string')
      return false;
    const a = Buffer.from(t), b = Buffer.from(AGENT_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (AGENT_TOKEN) {
    if (cfg.agentOnly) {
      // Только «точка управления»: ни входа по паролю, ни страниц панели. Доступны лишь /api (по токену) и /ws.
      app.post('/api/login', (req, res) => sendJson(res, 403, { error: 'Этот сервер работает только как агент' }));
      app.use((req, res, next) => {
        if (/^\/(api|ws)(\/|\?|$)/i.test(req.url))
          return next();
        if (req.method === 'GET' && /^\/(\?.*)?$/.test(req.url)) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Server Manager Agent: на этом компьютере нет интерфейса. Управление идёт из панели Server Manager.\n');
        }
        sendJson(res, 404, { error: 'Not found' });
      });
    }
    const pairing = discovery.makePairing({ onNew: (code, ttl) => console.log(`\n[agent] КОД ПОДКЛЮЧЕНИЯ: ${code}   (введите его в панели; одноразовый, действует ${Math.round(ttl / 60000)} мин)\n`) });
    app.post('/api/agent/pair', json, (req, res) => {
      const x = pairing.tryCode(req.body && req.body.code);
      if (!x.ok)
        return res.status(x.status).json({ error: x.error });
      console.log('[agent] панель подключена по коду');
      res.json({ token: AGENT_TOKEN, id: cfg.agentId, name: agentName });
    });
    app.post('/api/agent/verify', json, (req, res) => {
      const nonce = String((req.body && req.body.nonce) || '').slice(0, 128);
      if (!nonce)
        return res.status(400).json({ error: 'nonce' });
      res.json({ id: cfg.agentId, proof: crypto.createHmac('sha256', AGENT_TOKEN).update(nonce).digest('hex') });
    });
    if (cfg.announce !== false)
      discovery.startAnnouncer({ id: cfg.agentId, name: agentName, port: cfg.port || 3000 });
    console.log(`[agent] режим агента включён${cfg.agentOnly ? ' (без интерфейса)' : ''}, имя «${agentName}»${cfg.announce !== false ? ', его видно в локальной сети' : ' (скрыт от автопоиска)'}`);
  }
  /**
   * Кто стоит за запросом, пришедшим от главной панели. Если панель передала список разрешений —
   * действуем строго в их рамках. Старая панель без заголовка считается администратором (как раньше).
   */
  function agentUser(req) {
    let who = 'panel';
    try {
      const header = req && req.headers && req.headers['x-panel-user'];
      if (header) who = decodeURIComponent(String(header)).replace(/[^\w.\-@ а-яА-ЯёЁ]/g, '').slice(0, 40) || 'panel';
    } catch { /* оставляем «panel» */ }
    const header = req && req.headers && req.headers['x-panel-permissions'];
    if (header === undefined) return { id: 0, username: 'panel:' + who, role: 'admin', permissions: new Set(permissions.ALL_IDS) };
    return { id: 0, username: 'panel:' + who, role: 'remote', permissions: permissions.permissionsFromHeader(header) };
  }
  auth.setAgentResolver((req, token) => (isAgentToken(token) ? agentUser(req) : null));

  /* ================= прокси на агента ================= */
  // Монтируется ДО express.json, чтобы тело запроса (в т.ч. части загружаемых файлов) шло потоком, без буферизации в памяти.
  app.use('/api/n/:id', (req, res) => {
    const node = getNode(req.params.id);
    let apiPath, query, restPath = req.url;
    try {
      const parsed = new URL('http://x' + (req.url.startsWith('/') ? req.url : '/' + req.url));
      apiPath = parsed.pathname.replace(/\/+$/, '') || '/';
      query = Object.fromEntries(parsed.searchParams);
    } catch { return sendJson(res, 400, { error: 'Некорректный путь' }); }

    let user = null;
    if (apiPath === '/download' && query.ticket) {
      // Скачивание по билету: что именно качаем, записано в билете, а не в адресе
      const redeemed = node && auth.redeemTicket(query.ticket, node.id);
      if (redeemed) {
        user = redeemed.user;
        query = redeemed.query;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
        restPath = '/download?' + params.toString();
      }
    } else {
      user = auth.userFromRequest(req);
    }
    if (!user) return sendJson(res, 401, { error: 'Требуется авторизация' });
    if (!node) return sendJson(res, 404, { error: 'Сервер не найден' });
    if (LOCAL_ONLY_PATHS.test(apiPath)) return sendJson(res, 403, { error: 'Этот запрос выполняется только на самой панели' });
    if (!mayUseNode(user, node.id)) return sendJson(res, 403, { error: 'Нет доступа к этому серверу' });
    const verdict = permissions.check(user.permissions, req.method, apiPath, query);
    if (!verdict.ok) return sendJson(res, 403, { error: verdict.reason });
    forward(node, req, res, restPath, user, proxyIdleMs);
  });


  /** Маршруты списка серверов и автопоиска. Вызывается ПОСЛЕ подключения проверки прав (auth.register). */
  function registerRoutes() {
  /* ================= обнаружение агентов ================= */
  const seen = new Map(), lastFollow = new Map();
  function onSeen(d) {
    if (d.id === cfg.agentId)
      return;
    const now = Date.now(), e = seen.get(d.id) || { ips: new Map() };
    e.ips.set(d.ip, now);
    Object.assign(e, { id: d.id, name: d.name, port: d.port, ip: d.ip, last: now });
    seen.set(d.id, e);
    // Компьютер сменил IP (DHCP) — находим по id и, убедившись по HMAC, что это он, обновляем адрес
    const n = db.prepare('SELECT * FROM nodes WHERE agent_id=?').get(d.id);
    if (!n)
      return;
    let cur;
    try {
      cur = new URL(n.url);
    }
    catch {
      return;
    }
    if (cur.protocol !== 'http:' || !IPV4.test(cur.hostname))
      return;
    const seenNow = [...e.ips].some(([ip, t]) => ip === cur.hostname && now - t < 10000);
    if (seenNow && String(cur.port || 80) === String(d.port))
      return;
    if (now - (lastFollow.get(d.id) || 0) < 30000)
      return;
    lastFollow.set(d.id, now);
    const url = `http://${d.ip}${d.port === 80 ? '' : ':' + d.port}`;
    verifyAgent({ url }, n.token, d.id).then(id => {
      if (!id)
        return;
      db.prepare('UPDATE nodes SET url=? WHERE id=?').run(url, n.id);
      console.log(`[nodes] «${n.name}» сменил адрес: ${cur.host} → ${url.replace('http://', '')}`);
    });
  }
  if (cfg.discovery !== false && !(AGENT_TOKEN && cfg.agentOnly))
    discovery.startListener({ onSeen });
  /* ================= список серверов ================= */
  const userNodes = id => db.prepare('SELECT node FROM user_nodes WHERE user_id=?').all(id).map(x => x.node);
  app.get('/api/nodes', (req, res) => {
    const all = db.prepare('SELECT id,name,url FROM nodes ORDER BY id').all();
    if (req.user.role === 'admin')
      return res.json({ local: true, nodes: all.map(pub) });
    const acc = new Set(userNodes(req.user.id));
    res.json({ local: acc.has('local'), nodes: all.filter(n => acc.has(String(n.id))).map(n => ({ id: n.id, name: n.name })) });
  });
  app.get('/api/nodes/status', async (req, res) => {
    let list = db.prepare('SELECT * FROM nodes ORDER BY id').all();
    if (req.user.role !== 'admin') {
      const acc = new Set(userNodes(req.user.id));
      list = list.filter(n => acc.has(String(n.id)));
    }
    res.json(await Promise.all(list.map(async (n) => ({ id: n.id, ...await ping(n) }))));
  });
  app.get('/api/nodes/discover', (req, res) => {
    const known = new Set(db.prepare('SELECT agent_id FROM nodes WHERE agent_id IS NOT NULL').all().map(x => x.agent_id)), now = Date.now();
    res.json([...seen.values()].filter(x => now - x.last < 15000 && !known.has(x.id)).map(x => ({ id: x.id, name: x.name, ip: x.ip, port: x.port })));
  });
  const input = (b, old) => {
    b = b || {};
    const name = String(b.name ?? old?.name ?? '').trim().slice(0, 60);
    if (!name)
      throw new Error('Укажите название');
    const url = normalizeUrl(b.url || old?.url);
    const token = String(b.token || old?.token || '').trim();
    if (token.length < 24)
      throw new Error('Токен агента должен быть не короче 24 символов');
    return { name, url, token };
  };
  app.post('/api/nodes/test', json, async (req, res) => {
    try {
      const b = req.body || {};
      let n;
      if (b.id) {
        n = getNode(b.id);
        if (!n)
          return res.status(404).json({ error: 'Сервер не найден' });
        if (b.url)
          n.url = normalizeUrl(b.url);
        if (b.token)
          n.token = String(b.token).trim();
      }
      else
        n = { url: normalizeUrl(b.url), token: String(b.token || '').trim() };
      res.json(await ping(n));
    }
    catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  // Подключение найденного агента по коду из его консоли: ни IP, ни токен вводить не нужно
  app.post('/api/nodes/pair', json, async (req, res) => {
    try {
      const b = req.body || {}, ip = String(b.ip || '').trim(), port = Number(b.port);
      if (!(IPV4.test(ip) || /^[A-Za-z0-9]([A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$/.test(ip)) || !(port >= 1 && port <= 65535))
        return res.status(400).json({ error: 'Некорректный адрес компьютера (IP или имя, например 203.0.113.5 или pc2.example.com)' });
      const base = { url: `http://${ip}${port === 80 ? '' : ':' + port}` };
      const x = await requestJson(base, 'POST', '/api/agent/pair', { code: b.code }, null, 6000);
      if (x.status === 0)
        return res.status(502).json({ error: 'Компьютер не отвечает: ' + x.error });
      if (x.status !== 200 || !x.json || !x.json.token)
        return res.status([403, 410, 429].includes(x.status) ? x.status : 502).json({ error: (x.json && x.json.error) || 'Код не принят' });
      const token = String(x.json.token), agentId = String(x.json.id || '');
      const pg = await ping({ ...base, token });
      if (!pg.ok)
        return res.status(502).json({ error: 'Код принят, но связь с агентом не работает: ' + pg.error });
      const name = String(b.name || x.json.name || ip).trim().slice(0, 60);
      const ex = agentId && db.prepare('SELECT * FROM nodes WHERE agent_id=?').get(agentId);
      let id;
      if (ex) {
        db.prepare('UPDATE nodes SET name=?,url=?,token=? WHERE id=?').run(name, base.url, token, ex.id);
        id = ex.id;
      }
      else
        id = db.prepare('INSERT INTO nodes(name,url,token,agent_id) VALUES(?,?,?,?)').run(name, base.url, token, agentId || null).lastInsertRowid;
      audit(req.user, 'node_pair', `${name} (${base.url})`);
      res.json(pub(getNode(id)));
    }
    catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.post('/api/nodes', json, async (req, res) => {
    try {
      const v = input(req.body);
      const aid = await verifyAgent({ url: v.url }, v.token, null);
      const x = db.prepare('INSERT INTO nodes(name,url,token,agent_id) VALUES(?,?,?,?)').run(v.name, v.url, v.token, aid || null);
      audit(req.user, 'node_add', `${v.name} (${v.url})`);
      res.json(pub(getNode(x.lastInsertRowid)));
    }
    catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.put('/api/nodes/:id', json, async (req, res) => {
    try {
      const o = getNode(req.params.id);
      if (!o)
        return res.status(404).json({ error: 'Сервер не найден' });
      const v = input(req.body, o);
      const aid = await verifyAgent({ url: v.url }, v.token, null);
      db.prepare('UPDATE nodes SET name=?,url=?,token=?,agent_id=? WHERE id=?').run(v.name, v.url, v.token, aid || o.agent_id || null, o.id);
      audit(req.user, 'node_update', v.name);
      res.json(pub(getNode(o.id)));
    }
    catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.delete('/api/nodes/:id', (req, res) => {
    const o = getNode(req.params.id);
    if (!o)
      return res.status(404).json({ error: 'Сервер не найден' });
    db.prepare('DELETE FROM nodes WHERE id=?').run(o.id);
    db.prepare('DELETE FROM user_nodes WHERE node=?').run(String(o.id));
    audit(req.user, 'node_delete', o.name);
    res.json({ ok: true });
  });
  }

  /* ================= WebSocket ================= */
  // Мост: браузер → панель (?node=<id>) → агент. true — соединение обработано здесь; false — дальше работает обычный обработчик панели.
  function bridge(socket, req) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return false; }
    const token = url.searchParams.get('token') || '';
    if (isAgentToken(token)) return false; // это главная панель подключилась к нам как к агенту
    const nodeId = url.searchParams.get('node') || 'local';
    try {
      const user = auth.userFromToken(token);
      if (!user) throw new Error('auth');
      if (!mayUseNode(user, nodeId)) throw new Error('forbidden');
      if (nodeId === 'local') return false;
      const node = getNode(nodeId);
      if (!node) throw new Error('node');
      const WebSocket = require('ws');
      const upstream = new WebSocket(node.url.replace(/^http/i, 'ws') + '/ws?token=' + encodeURIComponent(node.token), { handshakeTimeout: 8000 });
      const pending = [];
      const mayReadOutput = user.permissions.has('logs.view');
      upstream.on('open', () => { for (const message of pending) upstream.send(message); pending.length = 0; });
      upstream.on('message', (data, isBinary) => {
        if (socket.readyState !== 1) return;
        const text = isBinary ? data : data.toString();
        if (!mayReadOutput && typeof text === 'string' && text.startsWith('{"type":"output"')) return; // вывод консоли — только тем, у кого есть «Просмотр логов»
        socket.send(text);
      });
      upstream.on('close', () => { try { socket.close(1011, 'Node disconnected'); } catch { /* уже закрыт */ } });
      upstream.on('error', () => { try { socket.close(1011, 'Node unreachable'); } catch { /* уже закрыт */ } });
      socket.on('message', (data, isBinary) => {
        if (upstream.readyState === 1) upstream.send(data, { binary: isBinary });
        else if (upstream.readyState === 0 && pending.length < 50) pending.push(data);
      });
      socket.on('close', () => { try { upstream.terminate(); } catch { /* уже закрыт */ } });
      socket.on('error', () => { try { upstream.terminate(); } catch { /* уже закрыт */ } });
    } catch { try { socket.close(1008, 'Unauthorized'); } catch { /* уже закрыт */ } }
    return true;
  }

  /* ================= запуск: подсказки в консоли ================= */
  function listening(port, host) {
    const shown = port === 80 ? '' : ':' + port;
    if (AGENT_TOKEN && cfg.agentOnly) {
      console.log(`Server Manager — режим агента, БЕЗ интерфейса. Порт ${port}.`);
      if (host === '0.0.0.0' || host === '::') {
        const ips = [];
        for (const l of Object.values(os.networkInterfaces()))
          for (const i of l || [])
            if (i.family === 'IPv4' && !i.internal)
              ips.push(`${i.address}${shown}`);
        if (ips.length)
          console.log('Адрес этого компьютера: ' + ips.join('   '));
      }
      else
        console.warn('⚠ host = ' + host + ': агент слушает только этот компьютер. Для удалённого доступа поставьте "host": "0.0.0.0" в config.json.');
      console.log('Подключение: в панели «Серверы» → «+ Добавить сервер», код — в этой консоли (строка КОД ПОДКЛЮЧЕНИЯ).');
      return;
    }
    console.log(`Server Manager ${VERSION}: http://${host}${shown}`);
    if (host === '0.0.0.0' || host === '::') {
      const ips = [];
      for (const l of Object.values(os.networkInterfaces()))
        for (const i of l || [])
          if (i.family === 'IPv4' && !i.internal)
            ips.push(`http://${i.address}${shown}`);
      if (ips.length)
        console.log('Адрес для других компьютеров: ' + ips.join('   '));
      try {
        const a = db.prepare('SELECT password_hash FROM users WHERE username=?').get('admin');
        if (a && bcrypt.compareSync('admin', a.password_hash))
          console.warn('\n⚠ ВНИМАНИЕ: у пользователя admin пароль по умолчанию «admin», а панель открыта для сети. Смените его (Настройки → пароль).\n');
      }
      catch {
      }
    }
    else
      console.log('Панель слушает только этот компьютер. Чтобы открыть её другим людям, поставьте "host": "0.0.0.0" в config.json.');
  }
  return { isAgentToken, agentUser, bridge, registerRoutes, mayUseNode, listenError: (e, p, h) => listenError(e, p, h), listening };
}

module.exports = create;
create.forward = forward;
create.ping = ping;
create.normalizeUrl = normalizeUrl;
create.verifyAgent = verifyAgent;
create.listenError = listenError;
