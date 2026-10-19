'use strict';
// Загрузка и скачивание через настоящий сервер: части, обрывы, докачка, лимиты, ограничения диска.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { boot } = require('./helpers/boot');
const { createUpload, putChunk, uploadBuffer, sha256, randomBytes } = require('./helpers/upload-client');

const MIB = 1024 * 1024;
let server;
let admin;
test.before(async () => {
  server = await boot({ limits: { uploadChunkMb: 1, maxFileGb: 0.01 }, timeouts: { uploadStallSeconds: 1 } });
  admin = await server.login();
});
test.after(() => server.stop());
const stored = (...parts) => path.join(server.dir, 'servers', ...parts);
const leftovers = dir => fs.readdirSync(dir).filter(n => n.startsWith('.sm-upload-'));

test('загрузка небольшого файла за один запрос с автозавершением', async () => {
  const data = randomBytes(300 * 1024);
  const result = await uploadBuffer(admin, data, { name: 'small.bin' });
  assert.equal(result.status, 200);
  assert.equal(result.data.done, true);
  assert.equal(sha256(fs.readFileSync(stored('small.bin'))), sha256(data));
  assert.deepEqual(leftovers(stored()), [], 'временных файлов не осталось');
});

test('загрузка частями (несколько частей по 1 МБ), содержимое побайтно совпадает', async () => {
  const data = randomBytes(3 * MIB + 12345);
  const result = await uploadBuffer(admin, data, { name: 'parts.bin', path: '' });
  assert.equal(result.status, 200);
  assert.equal(fs.statSync(stored('parts.bin')).size, data.length);
  assert.equal(sha256(fs.readFileSync(stored('parts.bin'))), sha256(data));
});

test('пустой файл загружается', async () => {
  const result = await uploadBuffer(admin, Buffer.alloc(0), { name: 'empty.txt' });
  assert.equal(result.status, 200);
  assert.equal(fs.statSync(stored('empty.txt')).size, 0);
});

test('имя с кириллицей и вложенные папки (relativePath) создаются автоматически', async () => {
  const data = Buffer.from('привет, мир');
  const result = await uploadBuffer(admin, data, { name: 'ignored', relativePath: 'Мой проект/конфиги/файл №1.txt', path: '' });
  assert.equal(result.status, 200);
  assert.equal(fs.readFileSync(stored('Мой проект', 'конфиги', 'файл №1.txt'), 'utf8'), 'привет, мир');
});

test('продолжение после обрыва: загрузка возобновляется с последней целой части, в том числе «после перезагрузки страницы»', async () => {
  const data = randomBytes(4 * MIB);
  const fingerprint = { name: 'resume.bin', mtime: 1700000000000 };
  const first = await createUpload(admin, { ...fingerprint, size: data.length });
  assert.equal(first.data.received, 0);
  assert.equal((await putChunk(admin, first.data.id, 0, data.subarray(0, MIB))).status, 200);
  assert.equal((await putChunk(admin, first.data.id, MIB, data.subarray(MIB, 2 * MIB))).status, 200);
  // «страницу закрыли» — заново создаём загрузку того же файла: сервер должен вернуть ту же сессию с позицией 2 МБ
  const again = await createUpload(admin, { ...fingerprint, size: data.length });
  assert.equal(again.data.resumed, true);
  assert.equal(again.data.id, first.data.id);
  assert.equal(again.data.received, 2 * MIB);
  const status = await admin.get('/uploads/' + again.data.id);
  assert.equal(status.data.received, 2 * MIB);
  let last;
  for (let offset = again.data.received; offset < data.length; offset += MIB) last = await putChunk(admin, again.data.id, offset, data.subarray(offset, offset + MIB), offset + MIB >= data.length ? '&finish=1' : '');
  assert.equal(last.data.done, true);
  assert.equal(sha256(fs.readFileSync(stored('resume.bin'))), sha256(data));
});

test('неверное смещение отклоняется и сообщает, откуда продолжать; данные не портятся', async () => {
  const data = randomBytes(2 * MIB);
  const s = await createUpload(admin, { name: 'offset.bin', size: data.length });
  await putChunk(admin, s.data.id, 0, data.subarray(0, MIB));
  const wrong = await putChunk(admin, s.data.id, 5, data.subarray(0, 100));
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.received, MIB);
  const duplicate = await putChunk(admin, s.data.id, 0, data.subarray(0, MIB)); // повтор уже принятой части (ответ потерялся)
  assert.equal(duplicate.status, 409);
  const done = await putChunk(admin, s.data.id, MIB, data.subarray(MIB), '&finish=1');
  assert.equal(done.data.done, true);
  assert.equal(sha256(fs.readFileSync(stored('offset.bin'))), sha256(data));
});

test('обрыв соединения в середине части: недописанные байты отбрасываются, загрузка продолжается', async () => {
  const data = randomBytes(2 * MIB);
  const s = await createUpload(admin, { name: 'cut.bin', size: data.length });
  // Отправляем заголовок части 1 МБ, но только 300 КБ тела, и закрываем сокет
  await new Promise(resolve => {
    const socket = net.connect(server.port, '127.0.0.1', () => {
      socket.write(`PUT /api/uploads/${s.data.id}?offset=0 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${admin.token}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${MIB}\r\n\r\n`);
      socket.write(data.subarray(0, 300 * 1024), () => setTimeout(() => { socket.destroy(); resolve(); }, 150));
    });
    socket.on('error', () => resolve());
  });
  await new Promise(r => setTimeout(r, 300));
  const status = await admin.get('/uploads/' + s.data.id);
  assert.equal(status.data.received, 0, 'ни одной целой части не принято');
  const part = leftovers(stored())[0];
  assert.ok(part);
  assert.equal(fs.statSync(stored(part)).size, 0, 'временный файл очищен до последней целой части');
  for (let offset = 0; offset < data.length; offset += MIB) await putChunk(admin, s.data.id, offset, data.subarray(offset, offset + MIB), offset + MIB >= data.length ? '&finish=1' : '');
  assert.equal(sha256(fs.readFileSync(stored('cut.bin'))), sha256(data));
});

test('«зависшая» передача (байты перестали приходить) прерывается по таймауту неактивности', async () => {
  const s = await createUpload(admin, { name: 'stall.bin', size: 2 * MIB });
  const started = Date.now();
  const closedAfter = await new Promise(resolve => {
    const socket = net.connect(server.port, '127.0.0.1', () => {
      socket.write(`PUT /api/uploads/${s.data.id}?offset=0 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${admin.token}\r\nContent-Length: ${MIB}\r\n\r\n`);
      socket.write(Buffer.alloc(1000)); // и больше ни байта
    });
    socket.on('close', () => resolve(Date.now() - started));
    socket.on('error', () => {});
    setTimeout(() => { socket.destroy(); resolve(-1); }, 8000);
  });
  assert.ok(closedAfter > 500 && closedAfter < 5000, `соединение должно закрыться примерно через 1 с, закрылось через ${closedAfter} мс`);
  const status = await admin.get('/uploads/' + s.data.id);
  assert.equal(status.data.received, 0);
});

test('существующий файл не портится, если загрузка не завершилась', async () => {
  fs.writeFileSync(stored('keep.txt'), 'старая версия');
  const refuse = await createUpload(admin, { name: 'keep.txt', size: 10 });
  assert.equal(refuse.status, 409);
  assert.equal(refuse.data.exists, true);
  const s = await createUpload(admin, { name: 'keep.txt', size: 2 * MIB, overwrite: true });
  assert.equal(s.status, 200);
  await putChunk(admin, s.data.id, 0, randomBytes(MIB)); // загрузили половину и бросили
  assert.equal(fs.readFileSync(stored('keep.txt'), 'utf8'), 'старая версия');
  const early = await admin.post(`/uploads/${s.data.id}/finish`);
  assert.equal(early.status, 409, 'неполный файл завершить нельзя');
  assert.equal(fs.readFileSync(stored('keep.txt'), 'utf8'), 'старая версия');
  const cancel = await admin.del('/uploads/' + s.data.id);
  assert.equal(cancel.status, 200);
  assert.equal(fs.readFileSync(stored('keep.txt'), 'utf8'), 'старая версия');
  assert.deepEqual(leftovers(stored()).filter(n => n.includes(s.data.id)), [], 'временный файл удалён при отмене');
  assert.equal((await admin.get('/uploads/' + s.data.id)).status, 404);
});

test('успешная загрузка с overwrite заменяет файл целиком и атомарно', async () => {
  fs.writeFileSync(stored('replace.txt'), 'old');
  const result = await uploadBuffer(admin, Buffer.from('new content'), { name: 'replace.txt', overwrite: true });
  assert.equal(result.data.done, true);
  assert.equal(fs.readFileSync(stored('replace.txt'), 'utf8'), 'new content');
});

test('лимит размера файла: больше лимита отклоняется сразу', async () => {
  const r = await createUpload(admin, { name: 'huge.bin', size: 11 * MIB }); // лимит в этом тесте ≈ 10,2 МБ (0,01 ГБ)
  assert.equal(r.status, 413);
  assert.match(r.data.error, /лимит/);
});

test('защита: имя файла с путём, выход из корня, служебные имена', async () => {
  assert.equal((await createUpload(admin, { name: '../evil.txt', size: 1 })).status, 400);
  assert.equal((await createUpload(admin, { name: 'a/b.txt', size: 1 })).status, 400);
  assert.equal((await createUpload(admin, { name: 'x.txt', path: '../..', size: 1 })).status, 400);
  assert.equal((await createUpload(admin, { name: '.sm-upload-hack.part', size: 1 })).status, 400);
  assert.equal((await createUpload(admin, { name: 'x', size: -5 })).status, 400);
  assert.equal((await createUpload(admin, { name: 'x', size: 'abc' })).status, 400);
  assert.ok(!fs.existsSync(path.join(server.dir, 'evil.txt')));
});

test('нельзя дописывать чужую загрузку', async () => {
  const s = await createUpload(admin, { name: 'private.bin', size: 100 });
  const other = await admin.post('/users', { username: 'second', password: 'password-123', role: 'operator' });
  assert.equal(other.status, 200);
  const second = await server.login('second', 'password-123');
  assert.equal((await putChunk(second, s.data.id, 0, Buffer.alloc(100))).status, 403);
  assert.equal((await second.get('/uploads/' + s.data.id)).status, 403);
  assert.equal((await second.del('/uploads/' + s.data.id)).status, 403);
});

test('скачивание: файл целиком, заголовки, имя с кириллицей', async () => {
  const data = randomBytes(2 * MIB + 77);
  fs.writeFileSync(stored('Мир сервера.bin'), data);
  const t = await admin.post('/tickets/download', { query: { path: 'Мир сервера.bin' } });
  assert.equal(t.status, 200);
  const response = await fetch(server.url + t.data.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(response.headers.get('content-length')), data.length);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%D0%9C%D0%B8%D1%80/);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(data));
});

test('докачка: Range, If-Range, HEAD, неверный диапазон', async () => {
  const data = randomBytes(1 * MIB);
  fs.writeFileSync(stored('range.bin'), data);
  const url = server.url + (await admin.post('/tickets/download', { query: { path: 'range.bin' } })).data.url;
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const etag = head.headers.get('etag');
  const part = await fetch(url, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${data.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), data.subarray(1000, 2000));
  const tail = await fetch(url, { headers: { range: `bytes=${data.length - 10}-` } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), data.subarray(data.length - 10));
  const suffix = await fetch(url, { headers: { range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), data.subarray(data.length - 5));
  const matching = await fetch(url, { headers: { range: 'bytes=0-9', 'if-range': etag } });
  assert.equal(matching.status, 206);
  const stale = await fetch(url, { headers: { range: 'bytes=0-9', 'if-range': '"stale"' } });
  assert.equal(stale.status, 200, 'при несовпадении ETag отдаётся весь файл');
  assert.equal(Number(stale.headers.get('content-length')), data.length);
  const bad = await fetch(url, { headers: { range: `bytes=${data.length + 5}-` } });
  assert.equal(bad.status, 416);
});

test('скачивание ZIP: папка и несколько выбранных файлов', async () => {
  fs.mkdirSync(stored('ziptest', 'sub'), { recursive: true });
  fs.writeFileSync(stored('ziptest', 'a.txt'), 'AAA');
  fs.writeFileSync(stored('ziptest', 'sub', 'b.txt'), 'BBB');
  fs.writeFileSync(stored('single.txt'), 'S');
  const dirTicket = await admin.post('/tickets/download', { query: { path: 'ziptest' } });
  const dirZip = path.join(server.dir, 'dir.zip');
  fs.writeFileSync(dirZip, Buffer.from(await (await fetch(server.url + dirTicket.data.url)).arrayBuffer()));
  assert.match(execFileSync('unzip', ['-l', dirZip]).toString(), /ziptest\/a\.txt[\s\S]*ziptest\/sub\/b\.txt/);
  assert.match(execFileSync('unzip', ['-p', dirZip, 'ziptest/sub/b.txt']).toString(), /BBB/);
  const multi = await admin.post('/tickets/download', { query: { paths: ['ziptest/a.txt', 'single.txt'] } });
  const multiZip = path.join(server.dir, 'multi.zip');
  fs.writeFileSync(multiZip, Buffer.from(await (await fetch(server.url + multi.data.url)).arrayBuffer()));
  const listing = execFileSync('unzip', ['-l', multiZip]).toString();
  assert.match(listing, /a\.txt/); assert.match(listing, /single\.txt/);
  assert.equal(execFileSync('unzip', ['-p', multiZip, 'single.txt']).toString(), 'S');
});

test('билет на скачивание: чужой/подделанный/без прав не работает, токен в адресе не принимается', async () => {
  fs.writeFileSync(stored('t.txt'), 'x');
  assert.equal((await fetch(server.url + '/api/download?ticket=fake')).status, 401);
  assert.equal((await fetch(server.url + `/api/download?path=t.txt&token=${admin.token}`)).status, 401, 'JWT в адресной строке больше не принимается');
  const viewerCreate = await admin.post('/users', { username: 'viewer1', password: 'password-123', role: 'viewer' });
  assert.equal(viewerCreate.status, 200);
  const viewer = await server.login('viewer1', 'password-123');
  assert.equal((await viewer.post('/tickets/download', { query: { path: 't.txt' } })).status, 403, 'без права скачивания билет не выдаётся');
  const ticket = (await admin.post('/tickets/download', { query: { path: 't.txt' } })).data.ticket;
  const swapped = await fetch(server.url + `/api/download?ticket=${ticket}&path=${encodeURIComponent('../../config.json')}`);
  assert.equal(swapped.status, 200);
  assert.equal(await swapped.text(), 'x', 'параметры берутся из билета, а не из адреса');
});

test('скачивание не обходит защиту путей и секретов', async () => {
  assert.equal((await admin.post('/tickets/download', { query: { path: '../config.json' } })).status, 200); // билет выдан…
  const t = await admin.post('/tickets/download', { query: { path: '../config.json' } });
  const response = await fetch(server.url + t.data.url);
  assert.ok([400, 403].includes(response.status), 'config.json не должен скачиваться, статус ' + response.status);
  const t2 = await admin.post('/tickets/download', { query: { path: '../server.db' } });
  assert.ok([400, 403].includes((await fetch(server.url + t2.data.url)).status));
});
