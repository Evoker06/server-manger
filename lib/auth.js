'use strict';
// Вход в систему и проверка прав для каждого запроса.
//  • Токен входа (JWT) живёт 12 часов и привязан к текущему паролю: после смены пароля старые токены перестают работать.
//  • Подбор пароля ограничен: по IP-адресу и по логину.
//  • Скачивание файлов в браузере идёт по одноразовым «билетам» вместо токена в адресной строке.
//  • guard() проверяет КАЖДЫЙ запрос к /api по таблице прав (lib/permissions.js).
const crypto = require('crypto');
const permissions = require('./permissions');
const { sendJson } = require('./http-helpers');

const TOKEN_LIFETIME = '12h';
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS_PER_IP = 15;
const MAX_FAILS_PER_USERNAME = 10;
const TICKET_LIFETIME_MS = 15 * 60 * 1000;
const MAX_TICKETS = 5000;

const WORKS_WITHOUT_NODE_ACCESS = new Set(['/me', '/password', '/nodes', '/nodes/status', '/tickets/download']);

const passwordStamp = hash => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 12);

/** Счётчик неудачных попыток за скользящее окно. */
function createFailureCounter(limit, windowMs) {
  const attempts = new Map();
  const recent = key => {
    const now = Date.now();
    const list = (attempts.get(key) || []).filter(time => now - time < windowMs);
    if (list.length) attempts.set(key, list); else attempts.delete(key);
    return list;
  };
  return {
    blocked: key => recent(key).length >= limit,
    add: key => { if (attempts.size > 5000) attempts.clear(); attempts.set(key, [...recent(key), Date.now()]); },
    clear: key => attempts.delete(key),
  };
}

function createAuth({ db, config, jwt, bcrypt }) {
  const failuresByIp = createFailureCounter(MAX_FAILS_PER_IP, LOGIN_WINDOW_MS);
  const failuresByName = createFailureCounter(MAX_FAILS_PER_USERNAME, LOGIN_WINDOW_MS);
  const tickets = new Map();
  const defaultPasswordCache = new Map(); // хэш → true/false: «пароль всё ещё admin?» (bcrypt медленный, считаем один раз)
  let agentResolver = null; // подключается модулем nodes: пускает главную панель по токену агента

  /** Пользователь из строки БД в виде, удобном для проверок. */
  function toUser(row) {
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      overrides: permissions.parseOverrides(row.perms_json),
      permissions: permissions.effectivePermissions(row),
    };
  }

  const findRowById = id => db.prepare('SELECT id,username,role,perms_json,password_hash FROM users WHERE id=?').get(id);

  /** Можно ли пользователю работать с сервером ('local' — этот компьютер, иначе номер удалённого). Администратор — везде. */
  function mayUseNode(user, nodeId) {
    if (user.role === 'admin' || user.id === 0) return true; // id 0 — главная панель, она уже проверила доступ сама
    return !!db.prepare('SELECT 1 FROM user_nodes WHERE user_id=? AND node=?').get(user.id, String(nodeId));
  }

  function userFromToken(token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const row = findRowById(payload.id);
      if (!row) return null;
      if (payload.pv && payload.pv !== passwordStamp(row.password_hash)) return null; // пароль менялся
      return toUser(row);
    } catch { return null; }
  }

  function bearerToken(req) {
    return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  }

  function userFromRequest(req) {
    const token = bearerToken(req);
    if (!token) return null;
    if (agentResolver) {
      const agentUser = agentResolver(req, token);
      if (agentUser) return agentUser;
    }
    return userFromToken(token);
  }

  /* ---------- билеты на скачивание ---------- */

  /** node — 'local' или номер удалённого сервера; query — что именно скачивается. */
  function issueTicket(user, node, query) {
    const now = Date.now();
    if (tickets.size > MAX_TICKETS) for (const [id, t] of tickets) if (t.expires < now) tickets.delete(id);
    if (tickets.size > MAX_TICKETS) throw new Error('Слишком много активных ссылок на скачивание');
    const id = crypto.randomBytes(24).toString('base64url');
    tickets.set(id, { userId: user.id, username: user.username, agent: user.id === 0 ? user : null, node: String(node), query, expires: now + TICKET_LIFETIME_MS });
    return id;
  }

  /** Возвращает { user, query } или null. Права пользователя берутся на момент использования, а не выдачи. */
  function redeemTicket(ticketId, node) {
    const ticket = tickets.get(String(ticketId || ''));
    if (!ticket || ticket.expires < Date.now() || ticket.node !== String(node)) return null;
    const row = ticket.userId ? findRowById(ticket.userId) : null;
    if (!row) return null;
    return { user: toUser(row), query: ticket.query };
  }

  /* ---------- главный защитник /api ---------- */

  function guard(req, res, next) {
    const apiPath = req.path;
    // У этих маршрутов своя проверка: вход, подключение агента, прокси на удалённые серверы
    if (apiPath === '/login' || apiPath.startsWith('/agent/') || /^\/n(\/|$)/.test(apiPath)) return next();

    let user = null;
    let query = req.query || {};
    if (apiPath === '/download' && query.ticket) {
      const redeemed = redeemTicket(query.ticket, 'local');
      if (redeemed) { user = redeemed.user; query = redeemed.query; req.downloadQuery = redeemed.query; }
    } else {
      user = userFromRequest(req);
    }
    if (!user) return sendJson(res, 401, { error: 'Требуется авторизация' });

    // Страницы, нужные любому вошедшему, чтобы вообще показать интерфейс; остальное — только на разрешённых серверах
    if (!WORKS_WITHOUT_NODE_ACCESS.has(apiPath) && !mayUseNode(user, 'local')) {
      return sendJson(res, 403, { error: 'Нет доступа к этому серверу' });
    }
    const verdict = permissions.check(user.permissions, req.method, apiPath, query);
    if (!verdict.ok) return sendJson(res, 403, { error: verdict.reason });
    req.user = user;
    next();
  }

  /* ---------- вход и пароль ---------- */

  function login(req, res) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
    const { username = '', password = '' } = req.body || {};
    const nameKey = String(username).toLowerCase();
    if (failuresByIp.blocked(ip) || failuresByName.blocked(nameKey)) {
      return sendJson(res, 429, { error: 'Слишком много неудачных попыток входа. Подождите 10 минут' });
    }
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(String(username));
    if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
      failuresByIp.add(ip);
      failuresByName.add(nameKey);
      return sendJson(res, 401, { error: 'Неверный логин или пароль' });
    }
    failuresByIp.clear(ip);
    failuresByName.clear(nameKey);
    const token = jwt.sign({ id: row.id, pv: passwordStamp(row.password_hash) }, config.jwtSecret, { expiresIn: TOKEN_LIFETIME });
    sendJson(res, 200, { token, user: describeUser(toUser(row)) });
  }

  function usesDefaultPassword(userId) {
    const row = findRowById(userId);
    if (!row || row.role !== 'admin') return false;
    if (!defaultPasswordCache.has(row.password_hash)) {
      defaultPasswordCache.clear();
      defaultPasswordCache.set(row.password_hash, bcrypt.compareSync('admin', row.password_hash));
    }
    return defaultPasswordCache.get(row.password_hash);
  }

  /** Что видит браузер о текущем пользователе (права нужны, чтобы скрывать недоступные кнопки). */
  function describeUser(user) {
    return {
      id: user.id, username: user.username, role: user.role,
      permissions: [...user.permissions],
      defaultPassword: user.id > 0 && usesDefaultPassword(user.id),
    };
  }

  function changePassword(req, res) {
    const row = findRowById(req.user.id);
    const { currentPassword = '', newPassword = '' } = req.body || {};
    if (!row || !bcrypt.compareSync(String(currentPassword), row.password_hash)) return sendJson(res, 400, { error: 'Текущий пароль неверен' });
    if (String(newPassword).length < 8) return sendJson(res, 400, { error: 'Новый пароль должен содержать минимум 8 символов' });
    const hash = bcrypt.hashSync(String(newPassword), 12);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, row.id);
    const token = jwt.sign({ id: row.id, pv: passwordStamp(hash) }, config.jwtSecret, { expiresIn: TOKEN_LIFETIME });
    sendJson(res, 200, { ok: true, token }); // старые токены после смены пароля недействительны — выдаём новый
  }

  function register(app) {
    app.post('/api/login', login);
    app.use('/api', guard);
    app.get('/api/me', (req, res) => sendJson(res, 200, describeUser(req.user)));
    app.post('/api/password', changePassword);
  }

  return {
    register, guard, mayUseNode, userFromRequest, userFromToken, issueTicket, redeemTicket, describeUser, toUser,
    setAgentResolver: fn => { agentResolver = fn; },
  };
}

module.exports = { createAuth, passwordStamp };
