#!/usr/bin/env node
'use strict';
// Перенос установки Server Manager из Windows в Linux (или подготовка config.json). Безопасно запускать повторно.
//   node tools/linux-setup.js [--root /opt/server-manager] [--files /srv/servers] [--port 80]
//        [--map "E:\Bof\Bof=/srv/servers/bof"] ...   (можно несколько --map)
// Что делает:
//   1. config.json — заменяет путь fileRoot в стиле Windows, задаёт порт и host;
//   2. server.db   — переписывает пути приложений (рабочая папка и путь к Java) из Windows в Linux по правилам --map.
// Перед правкой создаются копии *.bak-linux. Сами файлы проектов скопируйте на Linux-машину отдельно.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const options = { map: [] };
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const key = args[i].slice(2);
  const value = args[++i];
  if (key === 'map') options.map.push(value); else options[key] = value;
}
const root = path.resolve(options.root || '.');
const backup = file => { const copy = file + '.bak-linux'; if (!fs.existsSync(copy)) fs.copyFileSync(file, copy); };

// 1. config.json
const configPath = path.join(root, 'config.json');
if (!fs.existsSync(configPath)) { console.error('✗ нет config.json в ' + root); process.exit(1); }
backup(configPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.fileRoot = options.files || (!config.fileRoot || /^[A-Za-z]:[\\/]/.test(config.fileRoot) ? './servers' : config.fileRoot);
config.port = Number(options.port || 80);
config.host = config.host || '0.0.0.0';
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`✓ config.json: fileRoot=${config.fileRoot}, port=${config.port}, host=${config.host}`);

// 2. server.db
const dbPath = path.join(root, 'server.db');
if (!fs.existsSync(dbPath)) process.exit(0);
let Database;
try { Database = require(path.join(root, 'node_modules', 'better-sqlite3')); } catch {
  console.log('• better-sqlite3 не установлен — выполните npm install и запустите этот скрипт ещё раз для переноса базы');
  process.exit(0);
}
backup(dbPath);
const db = new Database(dbPath);
const rules = options.map.map(rule => {
  const at = rule.lastIndexOf('=');
  return [rule.slice(0, at).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase(), rule.slice(at + 1).replace(/\/+$/, '')];
});
const looksLikeWindows = value => /^[A-Za-z]:[\\/]|\\/.test(value || '');
function convert(value) {
  if (!value || !looksLikeWindows(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  for (const [from, to] of rules) {
    if (normalized.toLowerCase() === from || normalized.toLowerCase().startsWith(from + '/')) return to + normalized.slice(from.length);
  }
  return value;
}
const update = db.prepare('UPDATE apps SET working_dir=?,runtime_path=? WHERE id=?');
for (const app of db.prepare('SELECT id,name,command,working_dir,runtime_path FROM apps').all()) {
  const workingDir = convert(app.working_dir);
  const runtimePath = convert(app.runtime_path);
  if (workingDir !== app.working_dir || runtimePath !== app.runtime_path) { update.run(workingDir, runtimePath, app.id); console.log(`✓ приложение №${app.id} «${app.name}»: ${app.working_dir} → ${workingDir}`); }
  else if (looksLikeWindows(app.working_dir)) console.log(`! приложение №${app.id} «${app.name}»: путь Windows остался (${app.working_dir}) — добавьте --map`);
  if (/\.(bat|cmd)\b|\.exe\b|powershell/i.test(app.command)) console.log(`! приложение №${app.id} «${app.name}»: команда Windows (${app.command.slice(0, 60)}) — замените на start.sh или java -jar …`);
}
db.close();
