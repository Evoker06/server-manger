'use strict';
// База данных SQLite: создание таблиц и безопасные миграции старых баз.
// Существующие данные никогда не удаляются — новые столбцы добавляются через ALTER TABLE.
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,role TEXT);
CREATE TABLE IF NOT EXISTS apps(id INTEGER PRIMARY KEY,name TEXT,type TEXT,command TEXT,working_dir TEXT,runtime TEXT,runtime_path TEXT,stop_command TEXT,env_json TEXT,auto_start INTEGER,auto_restart INTEGER,restart_delay INTEGER,max_restarts INTEGER,port INTEGER);
CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY,app_id INTEGER,name TEXT,command TEXT,runtime_path TEXT,env_json TEXT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,name TEXT,cron TEXT,app_id INTEGER,action TEXT,enabled INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,username TEXT,action TEXT,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS nodes(id INTEGER PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,token TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS user_nodes(user_id INTEGER NOT NULL,node TEXT NOT NULL,PRIMARY KEY(user_id,node));
`;

// Столбцы, добавленные в разных версиях панели: [таблица, столбец, описание типа]
const ADDED_COLUMNS = [
  ['apps', 'launch_json', "TEXT DEFAULT ''"],
  ['apps', 'depends_on', "TEXT DEFAULT '[]'"],
  ['apps', 'ready_delay', 'INTEGER DEFAULT 0'],
  ['tasks', 'payload', "TEXT DEFAULT ''"],
  ['tasks', 'keep', 'INTEGER DEFAULT 0'],
  ['tasks', 'last_run', 'TEXT'],
  ['tasks', 'last_status', 'TEXT'],
  ['tasks', 'last_message', 'TEXT'],
  ['profiles', 'note', "TEXT DEFAULT ''"],
  ['profiles', 'launch_json', "TEXT DEFAULT ''"],
  // Индивидуальные права пользователя поверх роли: {"grant":[...],"revoke":[...]}
  ['users', 'perms_json', "TEXT DEFAULT ''"],
  // Удалённые серверы: стабильный идентификатор агента (для поиска после смены IP)
  ['nodes', 'agent_id', 'TEXT'],
];

function addMissingColumns(db) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function openDatabase(rootDir) {
  const db = new Database(path.join(rootDir, 'server.db'));
  db.pragma('journal_mode=WAL');
  db.exec(BASE_SCHEMA);
  addMissingColumns(db);
  // Первый запуск (пользователей ещё нет): администратор admin / admin — панель просит сменить пароль.
  // Если администратора переименовали, «admin» заново НЕ создаётся: иначе появилась бы учётная запись с известным паролем.
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('admin', bcrypt.hashSync('admin', 12), 'admin');
  }
  return db;
}

/** Запись в журнал действий. user — объект пользователя или null (системное действие). */
function createAuditWriter(db) {
  const insert = db.prepare('INSERT INTO audit(username,action,details) VALUES(?,?,?)');
  return function audit(user, action, details = '') {
    insert.run(user?.username || 'system', action, String(details).slice(0, 2000));
  };
}

module.exports = { openDatabase, createAuditWriter };
