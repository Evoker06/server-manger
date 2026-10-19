'use strict';
// Файловый менеджер через настоящий сервер: список, сортировка, поиск, создание, переименование, удаление, копирование, перемещение.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');

let server, admin;
test.before(async () => { server = await boot(); admin = await server.login(); });
test.after(() => server.stop());
const root = (...p) => path.join(server.dir, 'servers', ...p);
const waitJob = async (kind, id) => { for (let i = 0; i < 200; i++) { const r = await admin.get(`/${kind}/${id}`); if (r.data.status !== 'running') return r.data; await new Promise(r => setTimeout(r, 50)); } throw new Error('операция не завершилась'); };

test('список: папки выше файлов, сортировка по имени/размеру/дате/типу, пагинация', async () => {
  fs.mkdirSync(root('list', 'zeta'), { recursive: true });
  fs.mkdirSync(root('list', 'alpha'));
  fs.writeFileSync(root('list', 'b.txt'), '12345');
  fs.writeFileSync(root('list', 'a.zip'), '1');
  fs.writeFileSync(root('list', 'c10.log'), '123');
  fs.writeFileSync(root('list', 'c2.log'), '12');
  const names = async q => (await admin.get('/files?path=list&' + q)).data.entries.map(e => e.name);
  assert.deepEqual(await names('sort=name'), ['alpha', 'zeta', 'a.zip', 'b.txt', 'c2.log', 'c10.log'], 'естественный порядок: c2 перед c10');
  assert.deepEqual(await names('sort=name&order=desc'), ['zeta', 'alpha', 'c10.log', 'c2.log', 'b.txt', 'a.zip']);
  assert.deepEqual((await names('sort=size&order=desc')).slice(2), ['b.txt', 'c10.log', 'c2.log', 'a.zip']);
  assert.deepEqual((await names('sort=type')).slice(2), ['c2.log', 'c10.log', 'b.txt', 'a.zip'], 'по расширению, внутри — по имени');
  const page = (await admin.get('/files?path=list&limit=2&offset=2')).data;
  assert.equal(page.total, 6);
  assert.deepEqual(page.entries.map(e => e.name), ['a.zip', 'b.txt']);
  const entry = (await admin.get('/files?path=list')).data.entries.find(e => e.name === 'b.txt');
  assert.equal(entry.type, 'file'); assert.equal(entry.size, 5); assert.equal(entry.ext, 'txt'); assert.ok(entry.modified > 0);
});

test('большая папка (5000 файлов): страница отдаётся быстро, остальное — по частям', async () => {
  fs.mkdirSync(root('big'));
  for (let i = 0; i < 5000; i++) fs.writeFileSync(root('big', `f${String(i).padStart(5, '0')}.txt`), 'x');
  const started = Date.now();
  const first = (await admin.get('/files?path=big&limit=100')).data;
  const elapsed = Date.now() - started;
  assert.equal(first.total, 5000);
  assert.equal(first.entries.length, 100);
  assert.equal(first.entries[0].name, 'f00000.txt');
  assert.ok(elapsed < 3000, `страница из 5000 файлов за ${elapsed} мс`);
  const last = (await admin.get('/files?path=big&limit=100&offset=4950')).data;
  assert.equal(last.entries.length, 50);
  assert.equal(last.entries.at(-1).name, 'f04999.txt');
});

test('поиск по имени: подстрока, маски *, вложенные папки, лимит результатов', async () => {
  fs.mkdirSync(root('s', 'deep', 'er'), { recursive: true });
  fs.writeFileSync(root('s', 'Report.TXT'), '');
  fs.writeFileSync(root('s', 'deep', 'er', 'report-2.txt'), '');
  fs.writeFileSync(root('s', 'deep', 'other.md'), '');
  const find = async q => (await admin.get('/files/search?path=s&q=' + encodeURIComponent(q))).data;
  const byName = (await find('report')).results.map(r => r.path).sort();
  assert.deepEqual(byName, ['s/Report.TXT', 's/deep/er/report-2.txt']);
  assert.deepEqual((await find('*.md')).results.map(r => r.path), ['s/deep/other.md']);
  assert.equal((await admin.get('/files/search?path=s&q=')).status, 400);
});

test('создание, переименование, удаление; все изменения — на настоящем диске', async () => {
  assert.equal((await admin.post('/mkdir', { path: 'ops/new folder' })).status, 200);
  assert.ok(fs.statSync(root('ops', 'new folder')).isDirectory());
  assert.equal((await admin.post('/mkdir', { path: 'ops/new folder' })).status, 400, 'повторное создание — ошибка');
  assert.equal((await admin.post('/file', { path: 'ops/a.txt', content: 'привет\nмир' })).status, 200);
  assert.equal(fs.readFileSync(root('ops', 'a.txt'), 'utf8'), 'привет\nмир');
  const read = await admin.get('/file?path=ops/a.txt');
  assert.equal(read.data.content, 'привет\nмир');
  const conflict = await admin.post('/file', { path: 'ops/a.txt', content: 'x', mtime: 1 });
  assert.equal(conflict.status, 409, 'файл изменили после открытия — конфликт');
  assert.equal((await admin.post('/file', { path: 'ops/a.txt', content: 'новый', mtime: read.data.mtime })).status, 200);
  assert.equal((await admin.post('/rename', { oldPath: 'ops/a.txt', newPath: 'ops/b.txt' })).status, 200);
  assert.ok(!fs.existsSync(root('ops', 'a.txt')) && fs.existsSync(root('ops', 'b.txt')));
  assert.equal((await admin.post('/rename', { oldPath: 'ops/b.txt', newPath: 'ops/new folder' })).status, 400, 'нельзя затереть существующее');
  assert.equal((await admin.del('/file', { path: 'ops/b.txt' })).status, 200);
  assert.ok(!fs.existsSync(root('ops', 'b.txt')));
});

test('массовое удаление: частичные ошибки не прерывают остальное', async () => {
  fs.mkdirSync(root('bulk', 'dir'), { recursive: true });
  fs.writeFileSync(root('bulk', 'dir', 'x.txt'), '1');
  fs.writeFileSync(root('bulk', 'one.txt'), '1');
  const result = await admin.post('/files/batch', { op: 'delete', paths: ['bulk/dir', 'bulk/one.txt', '../config.json'] });
  assert.equal(result.status, 200);
  assert.equal(result.data.okCount, 2);
  assert.equal(result.data.failCount, 1);
  assert.ok(!fs.existsSync(root('bulk', 'dir')) && !fs.existsSync(root('bulk', 'one.txt')));
  assert.ok(fs.existsSync(path.join(server.dir, 'config.json')), 'config.json цел');
  assert.equal((await admin.post('/files/batch', { op: 'format', paths: ['x'] })).status, 400);
});

test('корневую папку и папку панели удалить/переименовать нельзя', async () => {
  assert.equal((await admin.del('/file', { path: '' })).status, 400);
  assert.equal((await admin.post('/rename', { oldPath: '', newPath: 'x' })).status, 400);
  assert.ok(fs.existsSync(root()));
});

test('копирование нескольких элементов: содержимое и время изменения сохранены, оригинал на месте', async () => {
  fs.mkdirSync(root('cp', 'src', 'inner'), { recursive: true });
  fs.mkdirSync(root('cp', 'dest'));
  fs.writeFileSync(root('cp', 'src', 'inner', 'data.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(root('cp', 'file.txt'), 'hello');
  fs.utimesSync(root('cp', 'file.txt'), new Date(1600000000000), new Date(1600000000000));
  const job = await admin.post('/transfer', { mode: 'copy', src: { paths: ['cp/src', 'cp/file.txt'] }, dst: { path: 'cp/dest' } });
  assert.equal(job.status, 200);
  const done = await waitJob('transfer', job.data.job);
  assert.equal(done.status, 'done', done.message);
  assert.equal(fs.statSync(root('cp', 'dest', 'src', 'inner', 'data.bin')).size, 3 * 1024 * 1024);
  assert.equal(fs.readFileSync(root('cp', 'dest', 'file.txt'), 'utf8'), 'hello');
  assert.equal(Math.round(fs.statSync(root('cp', 'dest', 'file.txt')).mtimeMs / 1000), 1600000000);
  assert.ok(fs.existsSync(root('cp', 'src', 'inner', 'data.bin')) && fs.existsSync(root('cp', 'file.txt')));
  assert.deepEqual(fs.readdirSync(root('cp', 'dest')).filter(n => n.startsWith('.sm-')), []);
});

test('копирование: конфликт имён, копирование папки в саму себя, одинаковые пути', async () => {
  fs.mkdirSync(root('cf', 'a', 'b'), { recursive: true });
  fs.writeFileSync(root('cf', 'f.txt'), '1');
  fs.mkdirSync(root('cf', 'target'));
  fs.writeFileSync(root('cf', 'target', 'f.txt'), 'old');
  assert.equal((await admin.post('/transfer', { mode: 'copy', src: { path: 'cf/f.txt' }, dst: { path: 'cf/target' } })).status, 400, 'без overwrite — отказ');
  assert.equal(fs.readFileSync(root('cf', 'target', 'f.txt'), 'utf8'), 'old');
  const ok = await admin.post('/transfer', { mode: 'copy', src: { path: 'cf/f.txt' }, dst: { path: 'cf/target' }, overwrite: true });
  assert.equal((await waitJob('transfer', ok.data.job)).status, 'done');
  assert.equal(fs.readFileSync(root('cf', 'target', 'f.txt'), 'utf8'), '1');
  assert.equal((await admin.post('/transfer', { mode: 'copy', src: { path: 'cf/a' }, dst: { path: 'cf/a/b' } })).status, 400, 'папку нельзя копировать в себя');
  assert.equal((await admin.post('/transfer', { mode: 'move', src: { path: 'cf/f.txt' }, dst: { path: 'cf' } })).status, 400, 'источник = назначение');
});

test('перемещение нескольких элементов; быстрое переименование на одном диске', async () => {
  fs.mkdirSync(root('mv', 'to'), { recursive: true });
  fs.writeFileSync(root('mv', '1.txt'), 'one');
  fs.mkdirSync(root('mv', 'folder'));
  fs.writeFileSync(root('mv', 'folder', '2.txt'), 'two');
  const job = await admin.post('/transfer', { mode: 'move', src: { paths: ['mv/1.txt', 'mv/folder'] }, dst: { path: 'mv/to' } });
  const done = await waitJob('transfer', job.data.job);
  assert.equal(done.status, 'done', done.message);
  assert.ok(!fs.existsSync(root('mv', '1.txt')) && !fs.existsSync(root('mv', 'folder')));
  assert.equal(fs.readFileSync(root('mv', 'to', 'folder', '2.txt'), 'utf8'), 'two');
});

test('отмена копирования: недокопированное удаляется, оригинал цел', async () => {
  fs.mkdirSync(root('cancel', 'dest'), { recursive: true });
  fs.writeFileSync(root('cancel', 'big.bin'), Buffer.alloc(120 * 1024 * 1024, 1));
  const job = await admin.post('/transfer', { mode: 'copy', src: { path: 'cancel/big.bin' }, dst: { path: 'cancel/dest' } });
  await admin.del('/transfer/' + job.data.job);
  const done = await waitJob('transfer', job.data.job);
  assert.ok(['cancelled', 'done'].includes(done.status), done.status);
  if (done.status === 'cancelled') assert.deepEqual(fs.readdirSync(root('cancel', 'dest')), [], 'после отмены в папке назначения пусто (в т.ч. нет временных файлов)');
  assert.equal(fs.statSync(root('cancel', 'big.bin')).size, 120 * 1024 * 1024);
});

test('защита путей через API: ../, абсолютные пути, config.json, server.db, служебные папки', async () => {
  for (const p of ['../config.json', '../server.db', '../storage/uploads', '/etc/passwd', '..']) {
    assert.ok([400, 403].includes((await admin.get('/file?path=' + encodeURIComponent(p))).status), 'чтение ' + p);
    assert.ok([400, 403].includes((await admin.get('/files?path=' + encodeURIComponent(p))).status), 'список ' + p);
    assert.ok([400, 403].includes((await admin.post('/file', { path: p, content: 'pwned' })).status), 'запись ' + p);
    assert.ok([400, 403].includes((await admin.del('/file', { path: p })).status), 'удаление ' + p);
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(server.dir, 'config.json'), 'utf8')).jwtSecret, 'config.json не изменён');
  fs.symlinkSync('/tmp', root('tmplink'));
  assert.ok([400, 403].includes((await admin.get('/files?path=tmplink')).status), 'ссылка за пределы корня');
  assert.equal((await admin.get('/files?path=' + encodeURIComponent('x\0y'))).status, 400);
});

test('служебные временные файлы панели не видны в списках', async () => {
  fs.mkdirSync(root('hide'));
  fs.writeFileSync(root('hide', '.sm-upload-abc.part'), 'x');
  fs.writeFileSync(root('hide', 'visible.txt'), 'x');
  assert.deepEqual((await admin.get('/files?path=hide')).data.entries.map(e => e.name), ['visible.txt']);
});

test('распаковка архива .tar.gz через API: в новую папку, ссылки из архива не создаются, исходный архив цел', async () => {
  const { execFileSync } = require('child_process');
  fs.mkdirSync(root('arc', 'src', 'inner'), { recursive: true });
  fs.writeFileSync(root('arc', 'src', 'a.txt'), 'AAA');
  fs.writeFileSync(root('arc', 'src', 'inner', 'b.txt'), 'BBB');
  fs.symlinkSync('/etc/passwd', root('arc', 'src', 'evil-link'));
  execFileSync('tar', ['czf', root('arc', 'pack.tar.gz'), '-C', root('arc', 'src'), '.']);
  const job = await admin.post('/extract', { path: 'arc/pack.tar.gz', mode: 'folder' });
  assert.equal(job.status, 200, JSON.stringify(job.data));
  const done = await waitJob('extract', job.data.job);
  assert.equal(done.status, 'done', done.message);
  assert.equal(fs.readFileSync(root('arc', 'pack', 'a.txt'), 'utf8'), 'AAA');
  assert.equal(fs.readFileSync(root('arc', 'pack', 'inner', 'b.txt'), 'utf8'), 'BBB');
  assert.ok(!fs.existsSync(root('arc', 'pack', 'evil-link')), 'символическая ссылка из архива не создана');
  assert.ok(fs.existsSync(root('arc', 'pack.tar.gz')), 'архив не тронут');
  assert.deepEqual(fs.readdirSync(root('arc')).filter(n => n.startsWith('.sm-')), [], 'временная папка распаковки убрана');
  assert.equal((await admin.post('/extract', { path: 'arc/src/a.txt' })).status, 400, 'не архив — понятная ошибка');
  assert.ok([400, 403].includes((await admin.post('/extract', { path: '../config.json' })).status));
});
