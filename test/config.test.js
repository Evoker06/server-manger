'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, DEFAULTS, GIB } = require('../lib/config');

const tempConfig = data => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cfg-')), 'config.json'); fs.writeFileSync(f, JSON.stringify(data)); return f; };

test('значения по умолчанию: лимит 500 ГБ и таймауты 20 минут', () => {
  const config = loadConfig(tempConfig({ jwtSecret: 'x'.repeat(64) }));
  assert.equal(config.limits.maxFileGb, 500);
  assert.equal(config.limits.maxFileGb * GIB, 500 * 1024 ** 3);
  assert.equal(config.timeouts.requestMinutes, 20);
  assert.equal(config.timeouts.idleMinutes, 20);
  assert.equal(config.timeouts.proxyIdleMinutes, 20);
});

test('старый config.json без новых разделов работает; значения можно переопределить', () => {
  const config = loadConfig(tempConfig({ port: 3000, maxUploadMb: 512, jwtSecret: 'x'.repeat(64), limits: { maxFileGb: 100, uploadChunkMb: 999 }, timeouts: { uploadStallSeconds: 5, requestMinutes: -3 } }));
  assert.equal(config.port, 3000);
  assert.equal(config.limits.maxFileGb, 100);
  assert.equal(config.limits.uploadChunkMb, 64, 'размер части ограничен 64 МБ');
  assert.equal(config.timeouts.uploadStallSeconds, 5);
  assert.equal(config.timeouts.requestMinutes, DEFAULTS.timeouts.requestMinutes, 'некорректное значение игнорируется');
});

test('слабый или отсутствующий jwtSecret заменяется и сохраняется', () => {
  const file = tempConfig({ port: 80, jwtSecret: 'CHANGE_THIS_SECRET_TO_A_LONG_RANDOM_VALUE' });
  const config = loadConfig(file);
  assert.ok(config.jwtSecret.length >= 64);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).jwtSecret, config.jwtSecret);
});
