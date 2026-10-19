'use strict';
// Server Manager — точка входа. Здесь модули только СОБИРАЮТСЯ в нужном порядке; сама работа — в папке lib/.
// Порядок важен: сначала прокси на удалённые серверы (его тело нельзя разбирать заранее — идёт потоком),
// затем разбор JSON, затем проверка прав, затем остальные маршруты.
const express = require('express');
const http = require('http');
const path = require('path');
const EventEmitter = require('events');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');

const { loadConfig, preparePaths, MINUTE, SECOND } = require('./lib/config');
const { openDatabase, createAuditWriter } = require('./lib/database');
const { createPathGuard } = require('./lib/safe-paths');
const { createAuth } = require('./lib/auth');
const LB = require('./lib/launcher');
const HW = require('./lib/hardware')();

/* ---------- настройки, папки, база ---------- */
const config = loadConfig();
const paths = preparePaths(config);
const db = openDatabase(paths.ROOT);
const audit = createAuditWriter(db);

/* ---------- общее состояние ---------- */
const procs = new Map();       // запущенные процессы приложений: id → { child, history, ... }
const cronJobs = new Map();    // расписания задач: id → cron-задача
const events = new EventEmitter();

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy); // за nginx: "trustProxy": 1
const server = http.createServer({ highWaterMark: 1024 * 1024 }, app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/** Рассылка события всем открытым вкладкам. Вывод консоли получают только те, у кого есть право «Просмотр логов». */
function broadcast(event) {
  events.emit(event.type, event);
  if (!wss.clients.size) return;
  const message = JSON.stringify(event); // один раз для всех
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (event.type === 'output' && !client.canReadOutput) continue;
    client.send(message);
  }
}

/* ---------- защитные заголовки ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'");
  next();
});

/* ---------- вход, права, удалённые серверы ---------- */
const auth = createAuth({ db, config, jwt, bcrypt });
const nodes = require('./lib/nodes')({ db, cfg: config, bcrypt, auth, audit, app, express }); // ДО express.json
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(paths.ROOT, 'public')));
auth.register(app); // POST /api/login, проверка прав для всех /api, /api/me, /api/password
nodes.registerRoutes(); // список серверов и автопоиск — только после проверки прав

/* ---------- приложения и процессы ---------- */
const appConfig = require('./lib/app-config')({ db, LB });
const processes = require('./lib/processes')({ db, procs, broadcast, paths, LB, appConfig });
const systemStats = require('./lib/system-stats')();
const backups = require('./lib/backups')({ app, db, procs, events, audit, paths, appConfig });
require('./lib/routes/apps')({ app, db, procs, jobs: cronJobs, audit, LB, appConfig, processes, systemStats });
require('./lib/routes/system')({ app, db, HW, systemStats, fmtBytes: backups.fmtBytes });
const tasks = require('./lib/tasks')({ app, db, procs, cronJobs, broadcast, audit, appConfig, processes, backups });
require('./lib/docker')({ app, audit });
require('./lib/users').registerUserRoutes({ app, db, bcrypt, audit });

/* ---------- файлы ---------- */
const pathGuard = createPathGuard({
  panelRoot: paths.ROOT,
  fileRoot: paths.FILE_ROOT,
  protectedDirs: [paths.UPLOAD_ROOT],
  hardware: HW,
  allowExternalLinks: !!config.allowExternalLinks,
  findApp: appConfig.appById,
});
const uploads = require('./lib/transfers/uploads');
const uploadService = uploads.createUploadService({ limits: config.limits, timeouts: { uploadStallSeconds: config.timeouts.uploadStallSeconds }, uploadRoot: paths.UPLOAD_ROOT });
uploads.registerUploadRoutes({ app, service: uploadService, pathGuard, audit });
require('./lib/file-manager').registerFileRoutes({
  app, pathGuard, audit, config, auth, archiverFactory: archiver,
  backupRoot: paths.BACKUP_ROOT, logFile: processes.logFile, flushLog: processes.logFlush, mayUseNode: nodes.mayUseNode,
});
require('./lib/transfer-jobs').registerTransferRoutes({ app, pathGuard, audit });
require('./lib/extract-jobs')({ app, cfg: config, audit, pathGuard, fmtBytes: backups.fmtBytes });
require('./lib/projects').registerProjectRoutes({ app, pathGuard, getRuntimes: () => appConfig.runtime() });

/* ---------- WebSocket: вывод консоли и события ---------- */
wss.on('connection', (socket, req) => {
  if (nodes.bridge(socket, req)) return; // соединение с удалённым сервером обработано в nodes
  try {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const user = nodes.isAgentToken(token) ? nodes.agentUser(req) : auth.userFromToken(token);
    if (!user) throw new Error('unauthorized');
    socket.canReadOutput = user.permissions.has('logs.view');
    socket.send(JSON.stringify({ type: 'hello' }));
    if (socket.canReadOutput) {
      for (const [id, state] of procs) {
        for (const line of state.history) socket.send(JSON.stringify({ type: 'output', id, stream: line.stream, data: line.data, time: line.time }));
      }
    }
  } catch { socket.close(1008, 'Unauthorized'); }
});

/* ---------- запуск ---------- */
db.prepare('SELECT * FROM tasks WHERE enabled=1').all().forEach(tasks.registerTask);
(async () => {
  for (const appRecord of db.prepare('SELECT * FROM apps WHERE auto_start=1 ORDER BY id').all()) {
    if (procs.has(appRecord.id)) continue;
    try { await processes.startWithDeps(appRecord); } catch (error) { console.error('Автозапуск:', appRecord.name, error.message); }
  }
})();

// Очистка брошенных загрузок: при старте и каждые 30 минут
const cleanUploads = () => uploadService.cleanupExpired().then(n => n && console.log(`Удалено заброшенных загрузок: ${n}`)).catch(() => {});
cleanUploads();
setInterval(cleanUploads, 30 * MINUTE).unref();

// Таймауты (все значения задаются в config.json → timeouts, см. README)
server.requestTimeout = config.timeouts.requestMinutes * MINUTE;   // максимум на получение одного запроса
server.headersTimeout = config.timeouts.headersSeconds * SECOND;   // время на заголовки
server.keepAliveTimeout = config.timeouts.keepAliveSeconds * SECOND;
server.timeout = config.timeouts.idleMinutes * MINUTE;             // соединение без единого байта закрывается

const PORT = config.port;
const HOST = config.host;
process.on('uncaughtException', error => console.error('uncaughtException:', error));
process.on('unhandledRejection', error => console.error('unhandledRejection:', error));
server.on('error', error => nodes.listenError(error, PORT, HOST));
server.listen(PORT, HOST, () => nodes.listening(PORT, HOST));

/** Корректное завершение: останавливаем приложения, закрываем соединения. */
function shutdown() {
  for (const appRecord of db.prepare('SELECT * FROM apps').all()) processes.stop(appRecord, true);
  for (const client of wss.clients) client.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
