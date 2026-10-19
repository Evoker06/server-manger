'use strict';
// Большие файлы (поток без загрузки в память) и обновление существующей установки (старая база и старый config.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Readable } = require('stream');
const { boot, requireDependency } = require('./helpers/boot');
const { createUploadService } = require('../lib/transfers/uploads');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

test('большой файл 1,5 ГБ: загрузка частями по 16 МБ и скачивание потоком; память сервера не растёт', { timeout: 280000 }, async () => {
  const server = await boot({ limits: { uploadChunkMb: 16 } });
  try {
    const admin = await server.login();
    const size = Math.floor(1.5 * GIB);
    // Данные генерируются «на лету» (псевдослучайный повторяющийся блок) — на диск тестового клиента ничего не пишется
    const block = crypto.randomBytes(MIB);
    const hash = crypto.createHash('sha256');
    const created = await admin.post('/uploads', { name: 'big.bin', size });
    assert.equal(created.status, 200);
    const chunk = created.data.chunkBytes;
    assert.equal(chunk, 16 * MIB);
    const rssBefore = await memoryOf(server);
    let peak = rssBefore;
    const started = Date.now();
    for (let offset = 0; offset < size; offset += chunk) {
      const length = Math.min(chunk, size - offset);
      const body = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += MIB) block.copy(body, i, 0, Math.min(MIB, length - i));
      body[0] = offset / chunk; // чтобы части различались
      hash.update(body);
      const r = await admin.call('PUT', `/uploads/${created.data.id}?offset=${offset}${offset + length >= size ? '&finish=1' : ''}`, body, { 'content-type': 'application/octet-stream' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      if ((offset / chunk) % 16 === 0) peak = Math.max(peak, await memoryOf(server));
    }
    const uploadSeconds = (Date.now() - started) / 1000;
    const expected = hash.digest('hex');
    const file = path.join(server.dir, 'servers', 'big.bin');
    assert.equal(fs.statSync(file).size, size);

    const ticket = await admin.post('/tickets/download', { query: { path: 'big.bin' } });
    const downloadHash = crypto.createHash('sha256');
    const downloadStarted = Date.now();
    let received = 0;
    await new Promise((resolve, reject) => {
      http.get(server.url + ticket.data.url, res => {
        assert.equal(Number(res.headers['content-length']), size);
        res.on('data', d => { downloadHash.update(d); received += d.length; });
        res.on('end', resolve); res.on('error', reject);
      }).on('error', reject);
    });
    const downloadSeconds = (Date.now() - downloadStarted) / 1000;
    peak = Math.max(peak, await memoryOf(server));
    assert.equal(received, size);
    assert.equal(downloadHash.digest('hex'), expected, 'скачанный файл совпадает с загруженным побайтно');
    console.log(`# 1,5 ГБ: загрузка ${uploadSeconds.toFixed(1)} с (${(size / MIB / uploadSeconds).toFixed(0)} МБ/с), скачивание ${downloadSeconds.toFixed(1)} с (${(size / MIB / downloadSeconds).toFixed(0)} МБ/с), пик памяти сервера ${(peak / MIB).toFixed(0)} МБ (до начала ${(rssBefore / MIB).toFixed(0)} МБ)`);
    assert.ok(peak - rssBefore < 300 * MIB, `память выросла на ${((peak - rssBefore) / MIB).toFixed(0)} МБ — файл не должен целиком попадать в память`);
    fs.rmSync(file);
  } finally { await server.stop(); }
});

async function memoryOf(server) {
  const status = fs.readFileSync(`/proc/${server.child.pid}/status`, 'utf8');
  return Number(/VmRSS:\s+(\d+) kB/.exec(status)[1]) * 1024;
}

test('лимит 500 ГБ: сессия на 500 ГБ принимается (при достаточном месте), 500 ГБ + 1 байт — нет; нехватка места — понятная ошибка', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sm-limit-'));
  const targetDir = path.join(dir, 'target'); fs.mkdirSync(targetDir);
  const limits = { maxFileGb: 500, uploadChunkMb: 16, minFreeDiskMb: 256, uploadSessionHours: 48, maxActiveUploads: 8 };
  const timeouts = { uploadStallSeconds: 60 };
  const roomy = createUploadService({ limits, timeouts, uploadRoot: path.join(dir, 'u1'), getFreeBytes: async () => 600 * GIB });
  const target = name => path.join(targetDir, name);
  const ok = await roomy.create({ owner: 'u', scope: {}, relativePath: 'a', targetPath: target('a'), size: 500 * GIB, mtimeMs: 1, overwrite: false });
  assert.equal(ok.session.size, 500 * GIB);
  await assert.rejects(roomy.create({ owner: 'u', scope: {}, relativePath: 'b', targetPath: target('b'), size: 500 * GIB + 1, mtimeMs: 1, overwrite: false }), /лимита \(500 ГБ\)/);
  const tight = createUploadService({ limits, timeouts, uploadRoot: path.join(dir, 'u2'), getFreeBytes: async () => 10 * GIB });
  await assert.rejects(tight.create({ owner: 'u', scope: {}, relativePath: 'c', targetPath: target('c'), size: 20 * GIB, mtimeMs: 1, overwrite: false }), /Недостаточно места/);
  assert.deepEqual(fs.readdirSync(targetDir).filter(n => n.startsWith('.sm-upload-')).length, 1, 'для отклонённых загрузок временных файлов не создаётся');
  await roomy.cancel(ok.session.id, 'u');
  assert.equal(fs.readdirSync(targetDir).length, 0);
});

test('ограничение числа незавершённых загрузок и очистка брошенных', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sm-ttl-'));
  fs.mkdirSync(path.join(dir, 't'));
  let now = 1000000;
  const service = createUploadService({ limits: { maxFileGb: 1, uploadChunkMb: 1, minFreeDiskMb: 1, uploadSessionHours: 1, maxActiveUploads: 2 }, timeouts: { uploadStallSeconds: 5 }, uploadRoot: path.join(dir, 'u'), getFreeBytes: async () => 100 * GIB, now: () => now });
  const make = n => service.create({ owner: 'u', scope: {}, relativePath: 'f' + n, targetPath: path.join(dir, 't', 'f' + n), size: 10, mtimeMs: n, overwrite: false });
  await make(1); await make(2);
  await assert.rejects(make(3), /Слишком много незавершённых/);
  now += 2 * 3600 * 1000; // прошло два часа
  assert.equal(await service.cleanupExpired(), 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 't')), [], 'временные файлы удалены');
  await make(3);
});

test('обновление существующей установки: старая база без новых столбцов и config.json с maxUploadMb', async () => {
  const fixtures = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sm-old-'));
  // Старая схема M6–M9: у users нет perms_json, нет таблиц nodes/user_nodes
  process.env.NODE_NO_WARNINGS = '1';
  const Database = requireDependency('better-sqlite3');
  const bcrypt = requireDependency('bcryptjs');
  const old = new Database(path.join(fixtures, 'server.db'));
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,role TEXT);
    CREATE TABLE apps(id INTEGER PRIMARY KEY,name TEXT,type TEXT,command TEXT,working_dir TEXT,runtime TEXT,runtime_path TEXT,stop_command TEXT,env_json TEXT,auto_start INTEGER,auto_restart INTEGER,restart_delay INTEGER,max_restarts INTEGER,port INTEGER);
    CREATE TABLE profiles(id INTEGER PRIMARY KEY,app_id INTEGER,name TEXT,command TEXT,runtime_path TEXT,env_json TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,name TEXT,cron TEXT,app_id INTEGER,action TEXT,enabled INTEGER);
    CREATE TABLE audit(id INTEGER PRIMARY KEY,username TEXT,action TEXT,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  old.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('boss', bcrypt.hashSync('old-password-1', 12), 'admin');
  old.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('helper', bcrypt.hashSync('old-password-2', 12), 'operator');
  old.prepare('INSERT INTO apps(name,type,command,working_dir,runtime,runtime_path,stop_command,env_json,auto_start,auto_restart,restart_delay,max_restarts,port) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-app', 'node', 'node x.js', '/tmp', '', '', '', '{}', 0, 0, 5, 5, 3000);
  old.close();
  const server = await boot({ maxUploadMb: 512, fileRoot: './servers', jwtSecret: 'a'.repeat(64) }, fixtures);
  try {
    const boss = await server.login('boss', 'old-password-1');
    assert.equal(boss.user.role, 'admin');
    assert.equal((await boss.get('/apps')).data[0].name, 'legacy-app', 'приложения сохранились');
    const users = (await boss.get('/users')).data;
    assert.deepEqual(users.map(u => u.username).sort(), ['boss', 'helper']);
    const helper = await server.login('helper', 'old-password-2');
    assert.ok(!helper.user.permissions.includes('apps.create'));
    assert.ok(helper.user.permissions.includes('files.delete'), 'оператор остался оператором');
    // Старый оператор без записей user_nodes не имеет доступа к серверам — как и раньше; администратор может выдать доступ
    assert.equal((await helper.get('/apps')).status, 403);
    const helperRow = users.find(u => u.username === 'helper');
    assert.equal((await boss.put('/users/' + helperRow.id, { nodes: ['local'] })).status, 200);
    assert.equal((await server.login('helper', 'old-password-2').then(c => c.get('/apps'))).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(server.dir, 'config.json'), 'utf8')).maxUploadMb, 512, 'config.json не переписан');
  } finally { await server.stop(); }
});
