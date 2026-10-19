'use strict';
// Удалённые серверы: главная панель + агент. Проверяем, что файлы, загрузка, скачивание и права работают через прокси
// и что права пользователя действуют ДВАЖДЫ — на панели и на агенте (агент не доверяет браузеру, получает права в заголовке).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { boot, makeClient } = require('./helpers/boot');
const { sha256, randomBytes } = require('./helpers/upload-client');

const MIB = 1024 * 1024;
const agentToken = crypto.randomBytes(32).toString('hex');
let agent, panel, admin, nodeId;
const agentFile = (...p) => path.join(agent.dir, 'servers', ...p);
const password = 'password-123';

test.before(async () => {
  agent = await boot({ agent: true, agentToken, agentId: 'agent-test-id', agentOnly: true, limits: { uploadChunkMb: 1 } });
  panel = await boot();
  admin = await panel.login();
  const added = await admin.post('/nodes', { name: 'ПК-2', url: agent.url, token: agentToken });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  nodeId = added.data.id;
  for (const [username, role, nodes] of [['rem-op', 'operator', [String(nodeId)]], ['rem-view', 'viewer', [String(nodeId)]], ['local-only', 'operator', ['local']]]) {
    assert.equal((await admin.post('/users', { username, password, role, nodes })).status, 200);
  }
});
test.after(async () => { await panel.stop(); await agent.stop(); });
const remote = (client, p) => `/n/${nodeId}${p}`;

test('агент в режиме agentOnly не принимает вход по паролю и не отдаёт страницы панели', async () => {
  const login = await fetch(agent.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 403);
  assert.equal((await fetch(agent.url + '/index.html')).status, 404);
});

test('администратор видит файлы удалённого сервера через панель', async () => {
  fs.mkdirSync(agentFile('proj'), { recursive: true });
  fs.writeFileSync(agentFile('proj', 'a.txt'), 'remote file');
  const list = await admin.get(remote(admin, '/files?path=proj'));
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.deepEqual(list.data.entries.map(e => e.name), ['a.txt']);
});

test('загрузка частями через прокси на агента: данные побайтно совпадают, временных файлов нет', async () => {
  const data = randomBytes(3 * MIB + 999);
  const create = await admin.post(remote(admin, '/uploads'), { name: 'via-proxy.bin', path: 'proj', size: data.length });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const { id, chunkBytes } = create.data;
  assert.equal(chunkBytes, MIB);
  let last;
  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    const end = Math.min(data.length, offset + chunkBytes);
    last = await admin.call('PUT', remote(admin, `/uploads/${id}?offset=${offset}${end === data.length ? '&finish=1' : ''}`), data.subarray(offset, end), { 'content-type': 'application/octet-stream' });
    assert.equal(last.status, 200, JSON.stringify(last.data));
  }
  assert.equal(last.data.done, true);
  assert.equal(sha256(fs.readFileSync(agentFile('proj', 'via-proxy.bin'))), sha256(data));
  assert.deepEqual(fs.readdirSync(agentFile('proj')).filter(n => n.startsWith('.sm-')), []);
  assert.ok(!fs.existsSync(path.join(panel.dir, 'servers', 'proj')), 'на самой панели файл не появился');
});

test('докачка через прокси: сессия живёт на агенте и продолжается с нужного места', async () => {
  const data = randomBytes(2 * MIB);
  const create = await admin.post(remote(admin, '/uploads'), { name: 'resume-proxy.bin', size: data.length, mtime: 123 });
  await admin.call('PUT', remote(admin, `/uploads/${create.data.id}?offset=0`), data.subarray(0, MIB), { 'content-type': 'application/octet-stream' });
  const again = await admin.post(remote(admin, '/uploads'), { name: 'resume-proxy.bin', size: data.length, mtime: 123 });
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.received, MIB);
  const done = await admin.call('PUT', remote(admin, `/uploads/${again.data.id}?offset=${MIB}&finish=1`), data.subarray(MIB), { 'content-type': 'application/octet-stream' });
  assert.equal(done.data.done, true);
  assert.equal(sha256(fs.readFileSync(agentFile('resume-proxy.bin'))), sha256(data));
});

test('скачивание с удалённого сервера по билету: целиком и с Range', async () => {
  const data = randomBytes(MIB + 5);
  fs.writeFileSync(agentFile('dl.bin'), data);
  const ticket = await admin.post('/tickets/download', { node: String(nodeId), query: { path: 'dl.bin' } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  assert.match(ticket.data.url, new RegExp(`^/api/n/${nodeId}/download\\?ticket=`));
  const full = await fetch(panel.url + ticket.data.url);
  assert.equal(full.status, 200);
  assert.equal(sha256(Buffer.from(await full.arrayBuffer())), sha256(data));
  const part = await fetch(panel.url + ticket.data.url, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), data.subarray(10, 20));
  const wrongNode = await fetch(panel.url + ticket.data.url.replace(`/n/${nodeId}/`, '/'));
  assert.equal(wrongNode.status, 401, 'билет для удалённого сервера не открывает локальный');
});

test('оператор удалённого сервера: файловые операции работают, но «диск» в теле запроса запрещён агентом', async () => {
  const op = await panel.login('rem-op', password);
  assert.equal((await op.post(remote(op, '/mkdir'), { path: 'proj/by-op' })).status, 200);
  assert.ok(fs.statSync(agentFile('proj', 'by-op')).isDirectory());
  for (const [p, body] of [['/file', { disk: '/', path: 'tmp/remote-pwn.txt', content: 'x' }], ['/mkdir', { disk: '/', path: 'tmp/remote-pwn' }], ['/uploads', { disk: '/', name: 'remote-pwn.txt', size: 1 }], ['/files/batch', { op: 'delete', disk: '/', paths: ['tmp/x'] }]]) {
    const r = await op.post(remote(op, p), body);
    assert.equal(r.status, 403, `${p}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  assert.ok(!fs.existsSync('/tmp/remote-pwn.txt') && !fs.existsSync('/tmp/remote-pwn'));
  assert.equal((await op.get(remote(op, '/files?disk=/'))).status, 403, 'и в адресе — тоже');
});

test('агент сам проверяет права из заголовка (даже если запрос пришёл «с правильным токеном»)', async () => {
  const direct = (permissions, method, p, body) => fetch(agent.url + '/api' + p, {
    method, headers: { authorization: 'Bearer ' + agentToken, 'x-panel-user': 'tester', 'x-panel-permissions': permissions, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  fs.writeFileSync(agentFile('victim.txt'), 'keep me');
  assert.equal((await direct('files.view', 'GET', '/files')).status, 200);
  assert.equal((await direct('files.view', 'DELETE', '/file', { path: 'victim.txt' })).status, 403);
  assert.equal((await direct('files.view', 'POST', '/apps', { name: 'x', command: 'x', working_dir: '/' })).status, 403);
  assert.equal((await direct('', 'GET', '/files')).status, 403, 'пустой список прав — ничего нельзя');
  assert.ok(fs.existsSync(agentFile('victim.txt')));
  assert.equal((await direct('files.view,files.delete', 'DELETE', '/file', { path: 'victim.txt' })).status, 200);
  assert.equal((await fetch(agent.url + '/api/files', { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
});

test('наблюдатель удалённого сервера и пользователь без доступа к серверу', async () => {
  const viewer = await panel.login('rem-view', password);
  assert.equal((await viewer.get(remote(viewer, '/apps'))).status, 200);
  assert.equal((await viewer.get(remote(viewer, '/files'))).status, 403);
  assert.equal((await viewer.del(remote(viewer, '/file'), { path: 'a' })).status, 403);
  const localOnly = await panel.login('local-only', password);
  assert.equal((await localOnly.get(remote(localOnly, '/files'))).status, 403, 'нет доступа к серверу');
  assert.equal((await localOnly.get('/files')).status, 200, 'зато основной сервер доступен');
  const remoteOnly = await panel.login('rem-op', password);
  assert.equal((await remoteOnly.get('/apps')).status, 403, 'доступ только к удалённому — основной закрыт');
  assert.equal((await remoteOnly.get('/me')).status, 200, 'но войти и увидеть список серверов можно');
  assert.equal((await remoteOnly.post('/tickets/download', { node: 'local', query: { path: 'x' } })).status, 403);
});

test('локальные страницы управления недоступны через прокси удалённого сервера', async () => {
  for (const p of ['/users', '/nodes', '/permissions', '/password', '/tickets/download']) {
    const r = await admin.call(p === '/password' || p === '/tickets/download' ? 'POST' : 'GET', remote(admin, p), p === '/password' || p === '/tickets/download' ? {} : undefined);
    assert.equal(r.status, 403, p);
  }
  assert.equal((await admin.get('/n/999/files')).status, 404);
  assert.equal((await fetch(panel.url + `/api/n/${nodeId}/files`)).status, 401, 'без токена — 401');
});
