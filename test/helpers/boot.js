'use strict';
// Запуск настоящего server.js в изолированной временной папке для проверки «снаружи» (по HTTP).
// Если в системе нет npm-пакетов проекта (express и др.), используются тестовые заглушки из test/shims.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..', '..');
const SHIMS = path.join(PROJECT, 'test', 'shims', 'node_modules');
// Если выполнен `npm install`, тесты работают с настоящими express, better-sqlite3 и т.д.; иначе — с упрощёнными заглушками из test/shims
const REAL_MODULES = path.join(PROJECT, 'node_modules');
const USING_REAL_PACKAGES = fs.existsSync(path.join(REAL_MODULES, 'express')) && fs.existsSync(path.join(REAL_MODULES, 'better-sqlite3'));
/** require для пакета из того набора (настоящий/заглушка), на котором работают тесты. */
const requireDependency = name => {
  try { return require(USING_REAL_PACKAGES ? path.join(REAL_MODULES, name) : path.join(SHIMS, name)); } catch { return require(name); } // ws в заглушки не входит — берётся настоящий
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    probe.on('error', reject);
  });
}

async function boot(configOverrides = {}, seedDir = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  if (seedDir) for (const name of fs.readdirSync(seedDir)) fs.cpSync(path.join(seedDir, name), path.join(dir, name), { recursive: true }); // готовая «старая установка»
  for (const item of ['server.js', 'package.json', 'lib', 'public']) fs.cpSync(path.join(PROJECT, item), path.join(dir, item), { recursive: true });
  const port = await freePort();
  const config = { port, host: '127.0.0.1', fileRoot: './servers', discovery: false, ...configOverrides };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  if (USING_REAL_PACKAGES) fs.symlinkSync(REAL_MODULES, path.join(dir, 'node_modules'), 'junction');
  const env = { ...process.env, ...(USING_REAL_PACKAGES ? {} : { NODE_PATH: [SHIMS, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) }), NODE_NO_WARNINGS: '1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Сервер не запустился:\n' + output);
    try { const r = await fetch(url + '/api/me'); if (r.status) break; } catch { /* ещё не слушает */ }
    await new Promise(r => setTimeout(r, 100));
  }
  const server = {
    url, dir, port, child, get output() { return output; },
    async stop() { child.kill('SIGTERM'); await new Promise(r => { child.once('exit', r); setTimeout(r, 3000); }); fs.rmSync(dir, { recursive: true, force: true }); },
    /** Вход пользователем; возвращает функцию запроса с токеном. */
    async login(username = 'admin', password = 'admin') {
      const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await r.json();
      if (!data.token) throw new Error('вход не удался: ' + JSON.stringify(data));
      return makeClient(url, data.token, data.user);
    },
  };
  return server;
}

function makeClient(url, token, user) {
  const call = async (method, pathname, body, headers = {}) => {
    const isRaw = body instanceof Uint8Array || Buffer.isBuffer(body);
    const r = await fetch(url + '/api' + pathname, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body !== undefined && !isRaw ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
  return { token, user, url, call, get: p => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p, b) => call('DELETE', p, b) };
}

module.exports = { boot, makeClient, requireDependency, USING_REAL_PACKAGES, PROJECT, SHIMS };
