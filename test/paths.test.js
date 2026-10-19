'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPathGuard } = require('../lib/safe-paths');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-paths-'));
  const panel = path.join(base, 'panel');
  const root = path.join(panel, 'servers');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.writeFileSync(path.join(panel, 'config.json'), '{}');
  fs.writeFileSync(path.join(panel, 'server.db'), '');
  fs.mkdirSync(path.join(panel, 'storage', 'uploads'), { recursive: true });
  const guard = createPathGuard({ panelRoot: panel, fileRoot: root, protectedDirs: [path.join(panel, 'storage', 'uploads')], hardware: null, findApp: id => (id === 1 ? { working_dir: root } : null) });
  return { base, panel, root, outside, guard, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('обычные пути внутри корня разрешены', () => {
  const t = setup();
  assert.equal(t.guard.resolveInside(t.root, 'a/b.txt'), path.join(t.root, 'a', 'b.txt'));
  assert.equal(t.guard.resolveInside(t.root, ''), t.root);
  t.cleanup();
});

test('выход через ../ и абсолютные пути запрещён', () => {
  const t = setup();
  for (const bad of ['../outside/secret.txt', '../../etc/passwd', 'a/../../x', t.outside, path.join(t.outside, 'secret.txt'), '/etc/passwd']) {
    assert.throws(() => t.guard.resolveInside(t.root, bad), /Недопустимый путь/, bad);
  }
  t.cleanup();
});

test('символическая ссылка за пределы корня запрещена (и для существующих, и для будущих файлов)', () => {
  const t = setup();
  fs.symlinkSync(t.outside, path.join(t.root, 'link'));
  assert.throws(() => t.guard.resolveInside(t.root, 'link'), /ссылка/i);
  assert.throws(() => t.guard.resolveInside(t.root, 'link/secret.txt'), /ссылка/i);
  assert.throws(() => t.guard.resolveInside(t.root, 'link/new-file.txt'), /ссылка/i);
  t.cleanup();
});

test('секреты панели и служебные папки закрыты', () => {
  const t = setup();
  assert.throws(() => t.guard.resolveInside(t.panel, 'config.json'), /служебным/);
  assert.throws(() => t.guard.resolveInside(t.panel, 'server.db'), /служебным/);
  assert.throws(() => t.guard.resolveInside(t.panel, 'storage/uploads/abc.json'), /служебным/);
  assert.ok(t.guard.resolveInside(t.panel, 'servers')); // остальное в папке панели доступно
  t.cleanup();
});

test('нулевой байт в пути отвергается', () => {
  const t = setup();
  assert.throws(() => t.guard.resolveInside(t.root, 'a\0b'), /Недопустимый путь/);
  t.cleanup();
});

test('области: хранилище, приложение, диск (только с правом files.disks)', () => {
  const t = setup();
  const plain = { permissions: new Set(['files.view']) };
  const withDisks = { permissions: new Set(['files.disks']) };
  assert.equal(t.guard.resolveRoot({}, plain), path.resolve(t.root));
  assert.equal(t.guard.resolveRoot({ app: '1' }, plain), path.resolve(t.root));
  assert.throws(() => t.guard.resolveRoot({ app: '99' }, plain), /не найдено/);
  assert.throws(() => t.guard.resolveRoot({ disk: 'C:\\' }, plain), /разрешения/);
  assert.throws(() => t.guard.resolveRoot({ disk: 'C:\\' }, withDisks), /Диск не найден/); // права есть, но диска нет
  assert.throws(() => t.guard.resolveRoot({ disk: 'X', app: '1' }, withDisks), /либо приложение, либо диск/);
  t.cleanup();
});

test('папка панели и её родители определяются как «нельзя трогать»', () => {
  const t = setup();
  assert.ok(t.guard.isPanelAncestor(t.panel));
  assert.ok(t.guard.isPanelAncestor(t.base));
  assert.ok(!t.guard.isPanelAncestor(t.root));
  t.cleanup();
});
