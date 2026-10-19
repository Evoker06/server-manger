'use strict';
// Права доступа через настоящий сервер: роли, индивидуальные права, прямые запросы в обход интерфейса, повышение привилегий.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');
const { createUpload, putChunk } = require('./helpers/upload-client');

let server, admin, operator, viewer, nobody;
const password = 'password-123';
test.before(async () => {
  server = await boot();
  admin = await server.login();
  fs.mkdirSync(path.join(server.dir, 'servers', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'servers', 'docs', 'a.txt'), 'content');
  for (const [username, role] of [['oper', 'operator'], ['view', 'viewer']]) assert.equal((await admin.post('/users', { username, password, role })).status, 200);
  operator = await server.login('oper', password);
  viewer = await server.login('view', password);
});
test.after(() => server.stop());
const forbidden = async (promise, label) => { const r = await promise; assert.equal(r.status, 403, `${label}: ожидали 403, получили ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`); return r; };

test('без токена и с неверным токеном — 401 на любых маршрутах', async () => {
  for (const [method, p] of [['GET', '/apps'], ['GET', '/files'], ['POST', '/uploads'], ['GET', '/users'], ['DELETE', '/file'], ['GET', '/hw/info']]) {
    const r = await fetch(server.url + '/api' + p, { method, headers: { authorization: 'Bearer wrong' } });
    assert.equal(r.status, 401, `${method} ${p}`);
    assert.equal((await fetch(server.url + '/api' + p, { method })).status, 401, `${method} ${p} без токена`);
  }
});

test('наблюдатель видит приложения, но ничего не может изменить', async () => {
  assert.equal((await viewer.get('/apps')).status, 200);
  assert.equal((await viewer.get('/me')).data.permissions.includes('files.view'), false);
  await forbidden(viewer.get('/files'), 'список файлов');
  await forbidden(viewer.get('/file?path=docs/a.txt'), 'чтение файла');
  await forbidden(viewer.post('/file', { path: 'docs/hack.txt', content: 'x' }), 'запись');
  await forbidden(viewer.del('/file', { path: 'docs/a.txt' }), 'удаление');
  await forbidden(viewer.post('/mkdir', { path: 'docs/x' }), 'mkdir');
  await forbidden(viewer.post('/rename', { oldPath: 'docs/a.txt', newPath: 'docs/b.txt' }), 'rename');
  await forbidden(viewer.post('/files/batch', { op: 'delete', paths: ['docs/a.txt'] }), 'batch');
  await forbidden(viewer.post('/uploads', { name: 'x', size: 1 }), 'upload');
  await forbidden(viewer.post('/transfer', { mode: 'copy', src: { path: 'docs' }, dst: { path: '' } }), 'transfer');
  await forbidden(viewer.post('/apps', { name: 'x', command: 'echo hi', working_dir: server.dir }), 'create app');
  await forbidden(viewer.get('/users'), 'users');
  await forbidden(viewer.get('/tasks'), 'tasks');
  await forbidden(viewer.get('/docker'), 'docker');
  assert.ok(fs.existsSync(path.join(server.dir, 'servers', 'docs', 'a.txt')));
});

test('оператор: файлы и управление — да; создание приложений, диски, пользователи, задачи — нет', async () => {
  assert.equal((await operator.get('/files?path=docs')).status, 200);
  assert.equal((await operator.post('/file', { path: 'docs/op.txt', content: 'x' })).status, 200);
  assert.equal((await operator.post('/mkdir', { path: 'docs/op-dir' })).status, 200);
  assert.equal((await operator.post('/rename', { oldPath: 'docs/op.txt', newPath: 'docs/op2.txt' })).status, 200);
  assert.equal((await operator.del('/file', { path: 'docs/op2.txt' })).status, 200);
  await forbidden(operator.post('/apps', { name: 'x', command: 'echo', working_dir: server.dir }), 'create app');
  await forbidden(operator.post('/transfer', { mode: 'copy', src: { path: 'docs' }, dst: { path: '' } }), 'copy');
  await forbidden(operator.post('/extract', { path: 'docs/a.zip' }), 'extract');
  await forbidden(operator.get('/users'), 'users');
  await forbidden(operator.get('/tasks'), 'tasks');
  await forbidden(operator.get('/hw/info'), 'hw');
  await forbidden(operator.get('/browse'), 'browse');
  await forbidden(operator.post('/nodes', { name: 'x', url: 'http://1.2.3.4', token: 'x' }), 'nodes');
});

test('обход через параметр disk: в строке запроса и в теле — везде 403', async () => {
  await forbidden(operator.get('/files?disk=' + encodeURIComponent('/')), 'список с disk');
  await forbidden(operator.get('/file?disk=/&path=etc/hostname'), 'чтение с disk');
  await forbidden(operator.post('/tickets/download', { query: { disk: '/', path: 'etc/hostname' } }), 'билет с disk');
  for (const [p, body] of [['/file', { disk: '/', path: 'tmp/pwn.txt', content: 'x' }], ['/mkdir', { disk: '/', path: 'tmp/pwn' }], ['/rename', { disk: '/', oldPath: 'a', newPath: 'b' }], ['/uploads', { disk: '/', name: 'pwn.txt', size: 1 }], ['/files/batch', { op: 'delete', disk: '/', paths: ['tmp/x'] }]]) {
    const r = await operator.post(p, body);
    assert.ok([400, 403].includes(r.status), `${p} с disk в теле: ${r.status}`);
    assert.match(JSON.stringify(r.data), /разрешени|Недостаточно/i, `${p}: ${JSON.stringify(r.data)}`);
  }
  assert.ok(!fs.existsSync('/tmp/pwn.txt') && !fs.existsSync('/tmp/pwn'));
});

test('индивидуальные права: оператору отозвано удаление, наблюдателю выдана загрузка', async () => {
  const op = (await admin.get('/users')).data.find(u => u.username === 'oper');
  assert.equal((await admin.put('/users/' + op.id, { revoke: ['files.delete'] })).status, 200);
  const restricted = await server.login('oper', password);
  assert.ok(!restricted.user.permissions.includes('files.delete'));
  await forbidden(restricted.del('/file', { path: 'docs/a.txt' }), 'удаление после отзыва');
  await forbidden(restricted.post('/files/batch', { op: 'delete', paths: ['docs/a.txt'] }), 'batch после отзыва');
  assert.equal((await restricted.post('/mkdir', { path: 'docs/still-works' })).status, 200);
  const view = (await admin.get('/users')).data.find(u => u.username === 'view');
  await admin.put('/users/' + view.id, { grant: ['files.upload'] });
  const granted = await server.login('view', password);
  assert.ok(granted.user.permissions.includes('files.view'), 'загрузка подразумевает просмотр папок');
  const s = await createUpload(granted, { name: 'viewer-upload.txt', size: 3 });
  assert.equal(s.status, 200);
  assert.equal((await putChunk(granted, s.data.id, 0, Buffer.from('abc'), '&finish=1')).data.done, true);
  await forbidden(granted.get('/download?path=docs/a.txt'), 'скачивание без права');
});

test('создание файла требует files.mkdir, изменение существующего — files.edit', async () => {
  const limited = await admin.post('/users', { username: 'editor', password, role: 'viewer', grant: ['files.edit'] });
  assert.equal(limited.status, 200);
  const editor = await server.login('editor', password);
  assert.equal((await editor.post('/file', { path: 'docs/a.txt', content: 'edited' })).status, 200);
  await forbidden(editor.post('/file', { path: 'docs/brand-new.txt', content: 'x' }), 'создание нового файла');
});

test('повышение привилегий: нельзя менять себя, выдавать чужие права, создавать админов, трогать админов', async () => {
  // оператору выдаём «управление пользователями», но не «изменение прав»
  const op = (await admin.get('/users')).data.find(u => u.username === 'oper');
  await admin.put('/users/' + op.id, { grant: ['users.manage'], revoke: [] });
  const manager = await server.login('oper', password);
  assert.equal((await manager.get('/users')).status, 200);
  const me = (await manager.get('/users')).data.find(u => u.username === 'oper');
  await forbidden(manager.put('/users/' + me.id, { role: 'admin' }), 'повысить себя до админа');
  await forbidden(manager.put('/users/' + me.id, { grant: ['users.permissions'] }), 'выдать себе права');
  await forbidden(manager.post('/users', { username: 'sneaky', password, role: 'operator' }), 'создать оператора без права изменения прав');
  assert.equal((await manager.post('/users', { username: 'plainviewer', password, role: 'viewer' })).status, 200, 'просмотрщика создать можно');
  const adminRow = (await manager.get('/users')).data.find(u => u.username === 'admin');
  await forbidden(manager.put('/users/' + adminRow.id, { password: 'new-password-1' }), 'сменить пароль админа');
  await forbidden(manager.del('/users/' + adminRow.id), 'удалить админа');

  // даём «изменение прав» — но выдать можно только то, что есть у самого
  await admin.put('/users/' + op.id, { grant: ['users.manage', 'users.permissions'] });
  const delegate = await server.login('oper', password);
  const target = (await delegate.get('/users')).data.find(u => u.username === 'plainviewer');
  await forbidden(delegate.put('/users/' + target.id, { role: 'admin' }), 'назначить админа не-админом');
  await forbidden(delegate.put('/users/' + target.id, { grant: ['docker.manage'] }), 'выдать право, которого нет самому');
  assert.equal((await delegate.put('/users/' + target.id, { grant: ['logs.clear'] })).status, 200, 'выдать то, что есть у самого — можно');
  await forbidden(delegate.put('/users/' + (await delegate.get('/users')).data.find(u => u.username === 'oper').id, { revoke: ['files.view'] }), 'править собственные права');
});

test('последнего администратора нельзя удалить или понизить; себя удалить нельзя', async () => {
  const adminRow = (await admin.get('/users')).data.find(u => u.username === 'admin');
  assert.equal((await admin.del('/users/' + adminRow.id)).status, 400);
  assert.equal((await admin.put('/users/' + adminRow.id, { role: 'viewer' })).status, 403); // себя менять нельзя
});

test('пароль: смена делает старый токен недействительным; короткий пароль отклоняется', async () => {
  const temp = (await admin.post('/users', { username: 'pwuser', password, role: 'viewer' })).data;
  const client = await server.login('pwuser', password);
  assert.equal((await client.post('/password', { currentPassword: password, newPassword: 'short' })).status, 400);
  assert.equal((await client.post('/password', { currentPassword: 'wrong', newPassword: 'long-enough-1' })).status, 400);
  const changed = await client.post('/password', { currentPassword: password, newPassword: 'long-enough-1' });
  assert.equal(changed.status, 200);
  assert.equal((await client.get('/apps')).status, 401, 'старый токен больше не работает');
  const fresh = require('./helpers/boot').makeClient(server.url, changed.data.token);
  assert.equal((await fresh.get('/apps')).status, 200, 'новый токен работает');
  assert.ok(temp.id);
});

test('подбор пароля ограничивается по логину', async () => {
  let last;
  for (let i = 0; i < 12; i++) {
    last = await fetch(server.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'view', password: 'wrong' + i }) });
  }
  assert.equal(last.status, 429);
});

test('скрытие кнопок в интерфейсе опирается на список прав, который отдаёт сервер (/api/me)', async () => {
  const me = (await admin.get('/me')).data;
  assert.ok(me.permissions.includes('users.permissions'));
  assert.equal(me.defaultPassword, true, 'панель знает, что у admin пароль по умолчанию');
});
