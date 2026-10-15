#!/usr/bin/env node
'use strict';
// Установка обновления M8 в папку проекта Server Manager.
//   node install-m8.js [папка_проекта]      (по умолчанию — текущая)
// Перед заменой каждый файл копируется в *.bak-m7. Безопасно запускать повторно.
const fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || '.');
const FILES = ['server.js', 'lib/hardware.js', 'public/app.js', 'public/style.css', 'public/index.html'];
if (!fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(path.join(root, 'public'))) {
  console.error('✗ В папке ' + root + ' не найден server.js и public/. Укажите папку проекта: node install-m8.js <папка>');
  process.exit(1);
}
if (+process.versions.node.split('.')[0] < 20) { console.error('✗ Нужен Node.js 20 или новее (используется встроенный fetch)'); process.exit(1); }
for (const f of FILES) {
  const src = path.join(__dirname, f), dst = path.join(root, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && !fs.existsSync(dst + '.bak-m7')) fs.copyFileSync(dst, dst + '.bak-m7');
  fs.copyFileSync(src, dst);
  console.log('✓ ' + f);
}
console.log('\nГотово. Перезапустите панель (остановите и снова запустите node server.js / службу), затем обновите страницу в браузере (Ctrl+F5).');
console.log('Откат: скопируйте файлы *.bak-m7 обратно под прежними именами.');
