'use strict';
// Приложения: создание, запуск, остановка, перезапуск, логи; сценарий «Использовать проект» от файлов до работающего приложения.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');

let server, admin;
test.before(async () => { server = await boot(); admin = await server.login(); });
test.after(() => server.stop());
const root = (...p) => path.join(server.dir, 'servers', ...p);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('не дождались'); await new Promise(r => setTimeout(r, 100)); } };
const statusOf = async id => ((await admin.get('/apps/' + id)).data.running ? 'running' : 'stopped');

test('«Использовать проект»: Node.js-проект в Файлах → анализ → создание приложения → запуск → остановка', async () => {
  fs.mkdirSync(root('my-bot'), { recursive: true });
  fs.writeFileSync(root('my-bot', 'package.json'), JSON.stringify({ name: 'bot', scripts: { start: 'node bot.js' } }));
  fs.writeFileSync(root('my-bot', 'bot.js'), "console.log('bot-started'); setInterval(() => {}, 1000);");
  const analysis = await admin.post('/projects/analyze', { path: 'my-bot' });
  assert.equal(analysis.status, 200);
  assert.equal(analysis.data.directory, root('my-bot'));
  const pick = analysis.data.candidates[0];
  assert.equal(pick.id, 'npm:start');
  assert.ok(!(await admin.get('/apps')).data.length, 'анализ ничего не создаёт и не запускает');
  // Пользователь подтверждает выбор: форма создания приложения получает путь и настройки запуска
  const created = await admin.post('/apps', { name: analysis.data.name, type: 'node', working_dir: analysis.data.directory, launch: pick.launch, port: 0 });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  assert.equal(created.data.command, 'npm start');
  assert.equal((await admin.get('/apps')).data.length, 1);
  assert.equal((await admin.post(`/apps/${id}/start`)).status, 200);
  await until(async () => (await statusOf(id)) === 'running');
  const output = await until(async () => { const o = (await admin.get(`/apps/${id}/output`)).data; return JSON.stringify(o).includes('bot-started') && o; });
  assert.ok(output);
  assert.equal((await admin.post(`/apps/${id}/stop`)).status, 200);
  await until(async () => (await statusOf(id)) !== 'running');
});

test('анализ файла: выбранный JAR становится рекомендованным вариантом', async () => {
  fs.mkdirSync(root('mc'), { recursive: true });
  fs.writeFileSync(root('mc', 'paper-1.20.4.jar'), 'x');
  fs.writeFileSync(root('mc', 'start.sh'), '#!/bin/sh\necho hi\n');
  const a = await admin.post('/projects/analyze', { path: 'mc/paper-1.20.4.jar' });
  assert.equal(a.status, 200);
  assert.equal(a.data.directory, root('mc'));
  assert.equal(a.data.candidates[0].launch.target, 'paper-1.20.4.jar');
  assert.ok(a.data.candidates.length >= 2, 'несколько способов запуска показываются на выбор');
  assert.equal((await admin.post('/projects/analyze', { path: 'нет-такой-папки' })).status, 404);
  assert.ok([400, 403].includes((await admin.post('/projects/analyze', { path: '../' })).status), 'за пределами хранилища анализировать нельзя');
});

test('жизненный цикл: запуск → консоль → команда → перезапуск → принудительная остановка → удаление', async () => {
  fs.mkdirSync(root('echo'), { recursive: true });
  fs.writeFileSync(root('echo', 'echo.js'), "process.stdin.on('data', d => console.log('got:' + d.toString().trim())); console.log('ready');");
  const created = await admin.post('/apps', { name: 'echo', type: 'node', command: 'node echo.js', working_dir: root('echo') });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  assert.equal((await admin.post(`/apps/${id}/start`)).status, 200);
  await until(async () => (await statusOf(id)) === 'running');
  assert.equal((await admin.post(`/apps/${id}/start`)).status === 200, false, 'повторный запуск запущенного приложения отклоняется');
  assert.equal((await admin.post(`/apps/${id}/command`, { command: 'ping-123' })).status, 200);
  await until(async () => JSON.stringify((await admin.get(`/apps/${id}/output`)).data).includes('got:ping-123'));
  const pidBefore = (await admin.get('/apps/' + id)).data.pid;
  assert.equal((await admin.post(`/apps/${id}/restart`)).status, 200);
  await until(async () => { const a = (await admin.get('/apps/' + id)).data; return a.running && a.pid !== pidBefore; });
  assert.ok((await admin.get(`/apps/${id}/log`)).status === 200);
  assert.equal((await admin.post(`/apps/${id}/kill`)).status, 200);
  await until(async () => (await statusOf(id)) !== 'running');
  assert.equal((await admin.del(`/apps/${id}/log`)).status, 200);
  assert.equal((await admin.del('/apps/' + id)).status, 200);
  assert.equal((await admin.get('/apps/' + id)).status, 404);
});

test('опасные значения при создании приложения отклоняются или нормализуются', async () => {
  assert.equal((await admin.post('/apps', { name: '', command: 'x', working_dir: root('echo') })).status, 400);
  assert.equal((await admin.post('/apps', { name: 'x', command: 'echo', working_dir: root('echo', 'echo.js') })).status, 400, 'вместо папки указан файл');
  assert.equal((await admin.post('/apps', { name: 'x', command: '', working_dir: root('echo') })).status, 400);
});

test('наблюдатель получает вывод консоли по WebSocket только при наличии права «Просмотр логов»', async () => {
  const WebSocket = require('./helpers/boot').requireDependency('ws');
  await admin.post('/users', { username: 'nologs', password: 'password-123', role: 'viewer', revoke: ['logs.view'] });
  const limited = await server.login('nologs', 'password-123');
  assert.ok(!limited.user.permissions.includes('logs.view'));
  fs.mkdirSync(root('chatter'), { recursive: true });
  fs.writeFileSync(root('chatter', 'c.js'), "setTimeout(() => console.log('SECRET-OUTPUT'), 600); setInterval(() => {}, 1000);");
  const app = (await admin.post('/apps', { name: 'chatter', command: 'node c.js', working_dir: root('chatter') })).data;
  const listen = (token) => new Promise(resolve => {
    const messages = [];
    const ws = new WebSocket(server.url.replace('http', 'ws') + '/ws?token=' + token);
    ws.on('message', d => messages.push(d.toString()));
    ws.on('open', () => setTimeout(async () => { await admin.post(`/apps/${app.id}/start`); setTimeout(() => { ws.close(); resolve(messages); }, 1800); }, 200));
  });
  const limitedMessages = await listen(limited.token);
  assert.ok(limitedMessages.some(m => m.includes('hello')));
  assert.ok(!limitedMessages.some(m => m.includes('SECRET-OUTPUT')), 'без права logs.view вывод консоли не передаётся');
  await admin.post(`/apps/${app.id}/kill`);
  await until(async () => (await statusOf(app.id)) !== 'running');
  const adminMessages = await listen(admin.token);
  assert.ok(adminMessages.some(m => m.includes('SECRET-OUTPUT')), 'у администратора вывод есть');
  await admin.post(`/apps/${app.id}/kill`);
});

test('задачи по расписанию: создание, ручной запуск (команда в консоль), предпросмотр расписания, удаление', async () => {
  fs.mkdirSync(root('taskapp'), { recursive: true });
  fs.writeFileSync(root('taskapp', 't.js'), "process.stdin.on('data', d => console.log('task-got:' + d.toString().trim())); setInterval(() => {}, 1000);");
  const created = (await admin.post('/apps', { name: 'task-app', command: 'node t.js', working_dir: root('taskapp') })).data;
  await admin.post(`/apps/${created.id}/start`);
  await until(async () => (await statusOf(created.id)) === 'running');
  const preview = await admin.get('/tasks/preview?cron=' + encodeURIComponent('*/5 * * * *'));
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const bad = await admin.post('/tasks', { name: 'bad', cron: 'это не cron', app_id: created.id, action: 'command', payload: 'x', enabled: 1 });
  assert.equal(bad.status, 400);
  const task = await admin.post('/tasks', { name: 'say-hello', cron: '0 3 * * *', app_id: created.id, action: 'command', payload: 'say hello', enabled: 1 });
  assert.equal(task.status, 200, JSON.stringify(task.data));
  assert.equal((await admin.get('/tasks')).data.length, 1);
  assert.equal((await admin.post(`/tasks/${task.data.id}/run`)).status, 200);
  await until(async () => JSON.stringify((await admin.get(`/apps/${created.id}/output`)).data).includes('task-got:say hello'));
  assert.equal((await admin.del('/tasks/' + task.data.id)).status, 200);
  assert.equal((await admin.get('/tasks')).data.length, 0);
  await admin.post(`/apps/${created.id}/kill`);
});
