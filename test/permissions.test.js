'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../lib/permissions');

const user = (role, overrides = {}) => ({ role, overrides: P.sanitizeOverrides(overrides) });
const can = (u, method, route, query) => P.check(P.effectivePermissions(u), method, route, query).ok;

test('администратор имеет все права и не может быть ограничен индивидуально', () => {
  const perms = P.effectivePermissions(user('admin', { revoke: ['files.delete'] }));
  assert.equal(perms.size, P.ALL_IDS.length);
});

test('оператор: управляет приложениями и файлами, но не создаёт приложения и пользователей', () => {
  const op = user('operator');
  assert.ok(can(op, 'POST', '/apps/5/start'));
  assert.ok(can(op, 'DELETE', '/file'));
  assert.ok(!can(op, 'POST', '/apps'));
  assert.ok(!can(op, 'PUT', '/apps/5'));
  assert.ok(!can(op, 'GET', '/users'));
  assert.ok(!can(op, 'POST', '/transfer'), 'копирование — отдельное право');
  assert.ok(!can(op, 'GET', '/hw/info'));
});

test('наблюдатель: только просмотр', () => {
  const viewer = user('viewer');
  assert.ok(can(viewer, 'GET', '/apps'));
  assert.ok(can(viewer, 'GET', '/apps/3/log'));
  for (const [method, route] of [['POST', '/apps/3/start'], ['DELETE', '/file'], ['GET', '/files'], ['POST', '/uploads'], ['GET', '/download'], ['GET', '/backups']]) {
    assert.ok(!can(viewer, method, route), `${method} ${route} должен быть запрещён`);
  }
});

test('индивидуальные права: grant добавляет, revoke убирает, следствия подтягиваются', () => {
  const custom = user('viewer', { grant: ['files.upload'] });
  assert.ok(can(custom, 'POST', '/uploads'));
  assert.ok(can(custom, 'GET', '/files'), 'upload подразумевает просмотр папок');
  const limited = user('operator', { revoke: ['files.delete', 'files.view'] });
  assert.ok(!can(limited, 'DELETE', '/file'));
  assert.ok(!can(limited, 'GET', '/files'), 'явно отозванное не возвращается через следствия');
});

test('скачивание: нужное право зависит от того, что скачивают', () => {
  const backupsOnly = user('viewer', { grant: ['backups.view'] });
  assert.ok(can(backupsOnly, 'GET', '/download', { backup: 'a.zip' }));
  assert.ok(!can(backupsOnly, 'GET', '/download', { path: 'x' }));
  const logsOnly = user('viewer');
  assert.ok(can(logsOnly, 'GET', '/download', { applog: '1' }));
});

test('параметр disk требует права files.disks во всех файловых маршрутах', () => {
  const op = user('operator');
  for (const route of ['/files', '/file', '/download']) assert.ok(!can(op, 'GET', route, { disk: 'C:\\' }), route);
  const withDisks = user('operator', { grant: ['files.disks'] });
  assert.ok(can(withDisks, 'GET', '/files', { disk: 'C:\\' }));
});

test('неописанный маршрут запрещён по умолчанию, в том числе администратору (нет правила — нет доступа)', () => {
  assert.equal(P.requirementFor('GET', '/something-new'), undefined);
  assert.ok(!can(user('admin'), 'GET', '/something-new'));
});

test('мусор в индивидуальных правах отбрасывается', () => {
  const clean = P.sanitizeOverrides({ grant: ['files.view', 'hack.all', 5], revoke: ['files.view', 'apps.view'] });
  assert.deepEqual(clean.grant, ['files.view']);
  assert.deepEqual(clean.revoke, ['apps.view']);
  assert.deepEqual(P.parseOverrides('{не json'), { grant: [], revoke: [] });
});

test('каждый маршрут API, зарегистрированный в коде, описан в таблице прав', () => {
  const root = path.resolve(__dirname, '..');
  const files = [path.join(root, 'server.js'), ...['lib', 'lib/routes', 'lib/transfers'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => path.join(root, dir, f)))];
  const routeRegex = /app\.(get|post|put|delete)\(\s*[`'](\/api\/[^`']+)[`']/g;
  const found = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(routeRegex)) found.push([m[1].toUpperCase(), m[2]]);
  }
  assert.ok(found.length > 60, 'нашли только ' + found.length + ' маршрутов');
  const samples = { id: '7', name: 'backup.zip', profileId: '9' };
  const missing = [];
  for (const [method, route] of found) {
    if (/^\/api\/(login|agent\/)/.test(route)) continue; // у них своя проверка
    const concrete = route.replace('/api', '').replace(/\$\{\w+\}/, "start").replace(/:(\w+)/g, (_, n) => samples[n] || 'x');
    if (!P.requirementFor(method, concrete, {})) missing.push(`${method} ${route}`);
  }
  assert.deepEqual(missing, [], 'маршруты без правила доступа');
});
