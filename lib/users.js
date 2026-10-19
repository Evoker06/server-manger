'use strict';
// Пользователи, роли и индивидуальные права.
// Защита от повышения привилегий (всё проверяется на сервере):
//  • менять роль и права может только тот, у кого есть users.permissions, и никогда — самому себе;
//  • выдать можно только те права, которые есть у самого выдающего;
//  • администраторов создаёт, меняет и удаляет только администратор;
//  • последнего администратора нельзя удалить или понизить.
const permissions = require('./permissions');
const { sendJson, route } = require('./http-helpers');
const { UserError } = require('./safe-paths');

const USERNAME_PATTERN = /^[\p{L}\p{N}_.\-@]{3,32}$/u;
const MIN_PASSWORD_LENGTH = 8;

function registerUserRoutes({ app, db, bcrypt, audit }) {
  const selectUser = db.prepare('SELECT id,username,role,perms_json FROM users WHERE id=?');
  const nodesOf = userId => db.prepare('SELECT node FROM user_nodes WHERE user_id=?').all(userId).map(row => row.node);
  const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;

  function describe(row) {
    const overrides = permissions.parseOverrides(row.perms_json);
    return {
      id: row.id, username: row.username, role: row.role,
      nodes: row.role === 'admin' ? ['all'] : nodesOf(row.id),
      grant: overrides.grant, revoke: overrides.revoke,
      permissions: [...permissions.effectivePermissions(row)],
    };
  }

  function validNodeList(list) {
    const known = new Set(['local', ...db.prepare('SELECT id FROM nodes').all().map(row => String(row.id))]);
    return [...new Set((Array.isArray(list) ? list : []).map(String))].filter(id => known.has(id));
  }

  function replaceNodes(userId, list) {
    db.prepare('DELETE FROM user_nodes WHERE user_id=?').run(userId);
    const insert = db.prepare('INSERT OR IGNORE INTO user_nodes(user_id,node) VALUES(?,?)');
    list.forEach(node => insert.run(userId, node));
  }

  const isAdmin = actor => actor.role === 'admin';

  /** Права, которых нет у выдающего, выдать нельзя. */
  function assertActorMayGrant(actor, before, after) {
    if (isAdmin(actor)) return;
    const added = [...after].filter(id => !before.has(id));
    const missing = added.filter(id => !actor.permissions.has(id));
    if (missing.length) throw new UserError('Нельзя выдать права, которых нет у вас: ' + permissions.titles(missing), 403);
  }

  function assertActorMayGrantNodes(actor, nodeList) {
    if (isAdmin(actor)) return;
    const own = new Set(nodesOf(actor.id));
    const forbidden = nodeList.filter(node => !own.has(node));
    if (forbidden.length) throw new UserError('Нельзя дать доступ к серверам, к которым нет доступа у вас', 403);
  }

  app.get('/api/permissions', (req, res) => {
    const roles = Object.fromEntries(permissions.ROLE_IDS.map(id => [id, { title: permissions.ROLES[id].title, permissions: permissions.ROLES[id].permissions }]));
    sendJson(res, 200, { groups: permissions.PERMISSION_GROUPS, roles, implies: permissions.IMPLIES });
  });

  app.get('/api/users', (req, res) => {
    sendJson(res, 200, db.prepare('SELECT id,username,role,perms_json FROM users ORDER BY id').all().map(describe));
  });

  app.post('/api/users', route(async (req, res) => {
    const actor = req.user;
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const role = String(body.role || 'viewer');
    const password = String(body.password || '');
    if (!USERNAME_PATTERN.test(username)) throw new UserError('Логин: 3–32 символа (буквы, цифры, _ . - @)');
    if (!permissions.ROLE_IDS.includes(role)) throw new UserError('Неизвестная роль');
    if (password.length < MIN_PASSWORD_LENGTH) throw new UserError('Пароль должен содержать минимум 8 символов');
    if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) throw new UserError('Такой пользователь уже есть');

    const overrides = permissions.sanitizeOverrides({ grant: body.grant, revoke: body.revoke });
    const nodes = validNodeList(body.nodes === undefined ? ['local'] : body.nodes); // без явного списка — доступ к этому компьютеру
    const assignsAccess = role !== 'viewer' || overrides.grant.length || overrides.revoke.length || body.nodes !== undefined;
    if (assignsAccess && !actor.permissions.has('users.permissions')) throw new UserError('Назначать роли, права и доступ к серверам может только тот, у кого есть право «изменение прав пользователей»', 403);
    if (role === 'admin' && !isAdmin(actor)) throw new UserError('Администраторов создаёт только администратор', 403);
    const newPermissions = permissions.effectivePermissions({ role, overrides });
    assertActorMayGrant(actor, new Set(), newPermissions);
    assertActorMayGrantNodes(actor, nodes);

    const perms = overrides.grant.length || overrides.revoke.length ? JSON.stringify(overrides) : '';
    const id = db.prepare('INSERT INTO users(username,password_hash,role,perms_json) VALUES(?,?,?,?)').run(username, bcrypt.hashSync(password, 12), role, perms).lastInsertRowid;
    replaceNodes(id, nodes);
    audit(actor, 'user_add', `${username} (${role})`);
    sendJson(res, 200, describe(selectUser.get(id)));
  }));

  app.put('/api/users/:id', route(async (req, res) => {
    const actor = req.user;
    const body = req.body || {};
    const target = selectUser.get(Number(req.params.id));
    if (!target) throw new UserError('Пользователь не найден', 404);
    if (target.role === 'admin' && !isAdmin(actor)) throw new UserError('Администратора может изменять только администратор', 403);

    const changesAccess = ['role', 'grant', 'revoke', 'nodes'].some(key => body[key] !== undefined);
    if (changesAccess) {
      if (!actor.permissions.has('users.permissions')) throw new UserError('Менять роли и права может только тот, у кого есть право «изменение прав пользователей»', 403);
      if (target.id === actor.id) throw new UserError('Нельзя менять собственные права', 403);
    }

    const newRole = body.role === undefined ? target.role : String(body.role);
    if (!permissions.ROLE_IDS.includes(newRole)) throw new UserError('Неизвестная роль');
    if (newRole === 'admin' && !isAdmin(actor)) throw new UserError('Назначать администраторов может только администратор', 403);
    if (target.role === 'admin' && newRole !== 'admin' && adminCount() <= 1) throw new UserError('Нельзя убрать права у последнего администратора');

    const oldOverrides = permissions.parseOverrides(target.perms_json);
    const newOverrides = (body.grant !== undefined || body.revoke !== undefined)
      ? permissions.sanitizeOverrides({ grant: body.grant ?? oldOverrides.grant, revoke: body.revoke ?? oldOverrides.revoke })
      : oldOverrides;
    const before = permissions.effectivePermissions({ role: target.role, overrides: oldOverrides });
    const after = permissions.effectivePermissions({ role: newRole, overrides: newOverrides });
    assertActorMayGrant(actor, before, after);

    if (body.password) {
      if (String(body.password).length < MIN_PASSWORD_LENGTH) throw new UserError('Пароль должен содержать минимум 8 символов');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(body.password), 12), target.id);
    }
    if (changesAccess) {
      const perms = newOverrides.grant.length || newOverrides.revoke.length ? JSON.stringify(newOverrides) : '';
      db.prepare('UPDATE users SET role=?,perms_json=? WHERE id=?').run(newRole, perms, target.id);
      if (body.nodes !== undefined) {
        const nodes = validNodeList(body.nodes);
        assertActorMayGrantNodes(actor, nodes.filter(node => !nodesOf(target.id).includes(node)));
        replaceNodes(target.id, nodes);
      }
    }
    audit(actor, 'user_update', `${target.username} (${newRole})${body.password ? ', новый пароль' : ''}`);
    sendJson(res, 200, describe(selectUser.get(target.id)));
  }));

  app.delete('/api/users/:id', route(async (req, res) => {
    const actor = req.user;
    const target = selectUser.get(Number(req.params.id));
    if (!target) throw new UserError('Пользователь не найден', 404);
    if (target.id === actor.id) throw new UserError('Нельзя удалить самого себя');
    if (target.role === 'admin' && !isAdmin(actor)) throw new UserError('Администратора может удалить только администратор', 403);
    if (target.role === 'admin' && adminCount() <= 1) throw new UserError('Нельзя удалить последнего администратора');
    db.prepare('DELETE FROM users WHERE id=?').run(target.id);
    db.prepare('DELETE FROM user_nodes WHERE user_id=?').run(target.id);
    audit(actor, 'user_delete', target.username);
    sendJson(res, 200, { ok: true });
  }));

  return { nodesOf };
}

module.exports = { registerUserRoutes };
