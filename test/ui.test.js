'use strict';
// Проверка интерфейса в настоящем браузере (Chromium через Playwright): вход, навигация «назад/вперёд», файловый менеджер,
// загрузка, выделение, контекстное меню, «Использовать проект», скрытие кнопок по правам.
// Тест пропускается, если Playwright или Chromium недоступны.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/boot');

let chromium;
for (const candidate of ['playwright', '/home/claude/.npm-global/lib/node_modules/playwright']) {
  try { ({ chromium } = require(candidate)); break; } catch { /* пробуем дальше */ }
}
const skip = !chromium && 'Playwright не установлен';

test('интерфейс в браузере', { skip, timeout: 120000 }, async t => {
  const server = await boot();
  let browser;
  try { browser = await chromium.launch(); } catch (error) { t.skip('Chromium недоступен: ' + error.message.split('\n')[0]); await server.stop(); return; }
  const admin = await server.login();
  const root = (...p) => path.join(server.dir, 'servers', ...p);
  fs.mkdirSync(root('Minecraft', 'world'), { recursive: true });
  fs.writeFileSync(root('Minecraft', 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(root('Minecraft', 'report-1.txt'), 'a');
  fs.mkdirSync(root('my-bot'), { recursive: true });
  fs.writeFileSync(root('my-bot', 'package.json'), JSON.stringify({ scripts: { start: 'node bot.js' } }));
  fs.writeFileSync(root('my-bot', 'bot.js'), 'setInterval(()=>{},1000)');
  fs.writeFileSync(root('big.bin'), Buffer.alloc(300000, 1));
  fs.writeFileSync(root('small.txt'), 'x');

  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|401|403/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());

  await t.test('вход и баннер о пароле по умолчанию', async () => {
    await page.goto(server.url);
    await page.fill('#u', 'admin'); await page.fill('#p', 'admin');
    await page.click('#login button');
    await page.waitForSelector('#app:not(.hidden)');
    assert.equal(await page.isVisible('#banner'), true);
    assert.match(page.url(), /#\/dash$/);
  });

  await t.test('навигация: каждый раздел — запись в истории, «Назад» и «Вперёд» работают', async () => {
    await page.click('aside [data-page=files]');
    await page.waitForSelector('.fmrow');
    assert.match(page.url(), /#\/files$/);
    await page.dblclick('.fmrow:has-text("Minecraft")');
    await page.waitForSelector('.fmrow:has-text("server.properties")');
    assert.match(decodeURIComponent(page.url()), /#\/files\?path=Minecraft$/);
    await page.goBack();
    await page.waitForSelector('.fmrow:has-text("my-bot")');
    assert.match(page.url(), /#\/files$/);
    await page.goBack();
    await page.waitForSelector('#content');
    assert.match(page.url(), /#\/dash$/);
    await page.goForward(); await page.goForward();
    await page.waitForSelector('.fmrow:has-text("server.properties")');
    assert.match(decodeURIComponent(page.url()), /path=Minecraft/);
    await page.reload();
    await page.waitForSelector('.fmrow:has-text("server.properties")'); // прямая ссылка на папку
    assert.equal(await page.isVisible('#login'), false, 'после перезагрузки вход сохранён');
  });

  await t.test('загрузка файла через кнопку: очередь передач, прогресс, файл на диске, список обновился', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await page.setInputFiles('#fmPick', { name: 'uploaded.bin', mimeType: 'application/octet-stream', buffer: data });
    await page.waitForSelector('#transferPanel');
    await page.waitForSelector('#transferPanel .tr-done', { timeout: 30000 });
    assert.equal(fs.statSync(root('Minecraft', 'uploaded.bin')).size, data.length);
    await page.waitForSelector('.fmrow:has-text("uploaded.bin")');
  });

  await t.test('загрузка папки с вложенными файлами', async () => {
    fs.mkdirSync(path.join(server.dir, 'to-upload', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(server.dir, 'to-upload', 'a.txt'), 'A');
    fs.writeFileSync(path.join(server.dir, 'to-upload', 'sub', 'b.txt'), 'B');
    await page.setInputFiles('#fmPickFolder', path.join(server.dir, 'to-upload'));
    await page.waitForFunction(() => document.querySelectorAll('#transferPanel .tr-done').length >= 3, null, { timeout: 30000 });
    assert.equal(fs.readFileSync(root('Minecraft', 'to-upload', 'sub', 'b.txt'), 'utf8'), 'B');
  });

  await t.test('выделение (Ctrl, Shift), контекстное меню, переименование', async () => {
    await page.click('.fmrow:has-text("report-1.txt")');
    await page.click('.fmrow:has-text("server.properties")', { modifiers: ['Control'] });
    assert.match(await page.textContent('.selbar'), /Выбрано: 2/);
    await page.click('[data-act=deselect]');
    await page.click('.fmrow:has-text("report-1.txt")', { button: 'right' });
    await page.waitForSelector('#fmMenu');
    assert.match(await page.textContent('#fmMenu'), /Переименовать/);
    await page.click('#fmMenu [data-menu=rename]');
    await page.waitForSelector('#askInput');
    await page.fill('#askInput', 'report-renamed.txt');
    await page.press('#askInput', 'Enter');
    await page.waitForSelector('.fmrow:has-text("report-renamed.txt")');
    assert.ok(fs.existsSync(root('Minecraft', 'report-renamed.txt')));
    assert.ok(!fs.existsSync(root('Minecraft', 'report-1.txt')));
  });

  await t.test('поиск по имени и сортировка по размеру', async () => {
    await page.fill('#fmSearch', 'report');
    await page.waitForSelector('th:has-text("Папка")');
    assert.equal(await page.locator('.fmrow').count(), 1);
    await page.fill('#fmSearch', '');
    await page.press('#fmSearch', 'Enter');
    await page.waitForSelector('.fmrow:has-text("uploaded.bin")');
    await page.click('[data-sort=size]'); await page.click('[data-sort=size]'); // по убыванию
    await page.waitForFunction(() => document.querySelector('.fmrow:not(:first-child) .fmname, .fmrow .fmname'));
    const files = await page.$$eval('.fmrow', rows => rows.map(r => r.querySelector('.fmtext').textContent));
    assert.equal(files.filter(n => n.endsWith('.bin'))[0], 'uploaded.bin', 'самый большой файл — первым среди файлов');
  });

  await t.test('удаление нескольких файлов с подтверждением', async () => {
    await page.click('.fmrow:has-text("uploaded.bin")');
    await page.click('.fmrow:has-text("report-renamed.txt")', { modifiers: ['Control'] });
    await page.keyboard.press('Delete');
    await page.waitForSelector('#cfOk');
    assert.ok(fs.existsSync(root('Minecraft', 'uploaded.bin')), 'до подтверждения ничего не удалено');
    await page.click('#cfOk');
    await page.waitForFunction(() => !document.querySelector('#fmDrop').textContent.includes('uploaded.bin'));
    assert.ok(!fs.existsSync(root('Minecraft', 'uploaded.bin')) && !fs.existsSync(root('Minecraft', 'report-renamed.txt')));
  });

  await t.test('копирование и вставка через буфер менеджера, перемещение перетаскиванием не требуется для проверки', async () => {
    await page.click('.fmrow:has-text("server.properties")');
    await page.click('[data-act=copy]');
    await page.dblclick('.fmrow:has-text("world")');
    await page.waitForSelector('[data-act=paste]');
    await page.click('[data-act=paste]');
    await page.waitForSelector('#transferPanel .tr-done:has-text("Копирование")', { timeout: 15000 });
    await page.waitForSelector('.fmrow:has-text("server.properties")');
    assert.equal(fs.readFileSync(root('Minecraft', 'world', 'server.properties'), 'utf8'), 'server-port=25565\n');
  });

  await t.test('«Использовать проект»: Файлы → диалог вариантов → конструктор → приложение создано', async () => {
    await page.goto(server.url + '/#/files');
    await page.waitForSelector('.fmrow:has-text("my-bot")');
    await page.click('.fmrow:has-text("my-bot")', { button: 'right' });
    await page.click('#fmMenu [data-menu=useProject]');
    await page.waitForSelector('#projNext');
    assert.match(await page.textContent('#modal'), /npm start/);
    assert.match(await page.textContent('#modal'), /my-bot/);
    assert.equal((await admin.get('/apps')).data.length, 0, 'диалог ничего не создаёт');
    await page.click('#projNext');
    await page.waitForSelector('#lb [onclick="lbSave()"]');
    assert.equal(await page.inputValue('#lb input >> nth=0'), 'my-bot');
    await page.click('#lb [onclick="lbSave()"]');
    await page.waitForURL(/#\/app\/\d+\/overview/);
    const apps = (await admin.get('/apps')).data;
    assert.equal(apps.length, 1);
    assert.equal(apps[0].working_dir, root('my-bot'));
    assert.equal(apps[0].command, 'npm start');
    assert.equal(apps[0].running, false, 'приложение не запускается автоматически');
    await page.goBack(); // возврат к разделу «Файлы»
    await page.waitForSelector('.fmrow:has-text("my-bot")');
  });

  await t.test('наблюдатель и оператор видят только разрешённые разделы и кнопки', async () => {
    await admin.post('/users', { username: 'viewer-ui', password: 'password-123', role: 'viewer' });
    await admin.post('/users', { username: 'oper-ui', password: 'password-123', role: 'operator' });
    const loginAs = async (username) => {
      const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
      const p = await ctx.newPage();
      await p.goto(server.url);
      await p.fill('#u', username); await p.fill('#p', 'password-123');
      await p.click('#login button');
      await p.waitForSelector('#app:not(.hidden)');
      await p.waitForTimeout(300);
      return { ctx, p };
    };
    const visibleMenu = p => p.$$eval('aside [data-page]', buttons => buttons.filter(b => !b.hidden).map(b => b.dataset.page));
    const v = await loginAs('viewer-ui');
    assert.deepEqual((await visibleMenu(v.p)).sort(), ['apps', 'dash', 'settings']);
    assert.equal(await v.p.isVisible('[data-perm="apps.create"]'), false);
    assert.equal(await v.p.isVisible('#banner'), false);
    await v.p.goto(server.url + '/#/files'); // прямая ссылка на недоступный раздел
    await v.p.waitForTimeout(500);
    assert.doesNotMatch(v.p.url(), /#\/files/, 'недоступный раздел заменяется доступным');
    await v.ctx.close();
    const o = await loginAs('oper-ui');
    const menu = await visibleMenu(o.p);
    assert.ok(menu.includes('files') && menu.includes('backups') && !menu.includes('users') && !menu.includes('nodes'));
    await o.p.click('aside [data-page=files]');
    await o.p.waitForSelector('.fmrow');
    assert.equal(await o.p.isVisible('[data-act=useProject]'), false, 'оператор не создаёт приложения');
    assert.equal(await o.p.isVisible('[data-act=upload]'), true);
    await o.p.click('.fmrow:has-text("small.txt")', { button: 'right' });
    assert.doesNotMatch(await o.p.textContent('#fmMenu'), /Копировать|Использовать проект/, 'в меню оператора нет недоступных действий');
    await o.ctx.close();
  });

  await t.test('страница «Пользователи»: редактор прав создаёт пользователя с индивидуальными разрешениями', async () => {
    await page.click('aside [data-page=users]');
    await page.waitForSelector('table.table');
    await page.click('text=+ Добавить пользователя');
    await page.waitForSelector('#uf');
    await page.fill('#uf [name=username]', 'custom-ui');
    await page.fill('#uf [name=password]', 'password-123');
    await page.selectOption('#uf [name=role]', 'viewer');
    await page.check('#uf input[value="files.upload"]');
    assert.equal(await page.isChecked('#uf input[value="files.view"]'), true, 'загрузка автоматически включает просмотр папок');
    await page.click('#userSaveBtn');
    await page.waitForSelector('td:has-text("custom-ui")');
    const created = (await admin.get('/users')).data.find(u => u.username === 'custom-ui');
    assert.deepEqual(created.grant.sort(), ['files.upload', 'files.view']);
    assert.equal(created.role, 'viewer');
  });

  assert.deepEqual(errors, [], 'в консоли браузера не должно быть ошибок JavaScript');
  await browser.close();
  await server.stop();
});
