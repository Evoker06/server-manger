// Пользователи, роли и индивидуальные права.
// Права = права роли + «добавить» − «убрать». Все проверки выполняет сервер; здесь только удобный редактор.
let usersCache = [];
let permCatalog = null;

const closureOf = ids => {
  const result = new Set();
  const visit = id => { if (result.has(id)) return; result.add(id); (permCatalog.implies[id] || []).forEach(visit); };
  ids.forEach(visit);
  return result;
};

async function usersPage() {
  clearInterval(statsTimer);
  const [users, catalog] = await Promise.all([api('/users'), api('/permissions'), loadNodes()]);
  usersCache = users;
  permCatalog = catalog;
  const total = catalog.groups.reduce((sum, group) => sum + group.items.length, 0);
  const nodeName = key => key === 'local' ? 'Эта панель' : (nodeList.find(n => String(n.id) === String(key))?.name || '?');
  const rows = users.map(user => {
    const extra = [user.grant.length ? `+${user.grant.length}` : '', user.revoke.length ? `−${user.revoke.length}` : ''].filter(Boolean).join(' ');
    return `<tr><td><b>${esc(user.username)}</b>${user.id === me.id ? ' <small>(это вы)</small>' : ''}</td>
      <td>${esc(catalog.roles[user.role]?.title || user.role)}</td>
      <td>${user.permissions.length} из ${total}${extra ? ` <span class=pfbadge title="Отличия от роли">${extra}</span>` : ''}</td>
      <td>${user.role === 'admin' ? '<span class=muted>все серверы</span>' : (user.nodes.length ? user.nodes.map(k => esc(nodeName(k))).join(', ') : '<span class=muted>нет доступа</span>')}</td>
      <td><div class=actions><button class=btn onclick="userForm(${user.id})">Изменить</button>${user.id === me.id ? '' : `<button class="btn bad" onclick="userDelete(${user.id})">Удалить</button>`}</div></td></tr>`;
  }).join('');
  $('content').innerHTML = toolbar('<button class=primary onclick="userForm()">+ Добавить пользователя</button>')
    + `<table class=table><tr><th>Логин</th><th>Роль</th><th>Разрешений</th><th>Доступ к серверам</th><th></th></tr>${rows}</table>`
    + `<div class=hint style="margin-top:18px"><b>Как устроены права.</b> У каждой роли есть набор разрешений по умолчанию; администратору можно дополнительно <b>разрешить</b> или <b>запретить</b> отдельные действия конкретному пользователю.
    Проверка выполняется на сервере при каждом запросе — скрытая кнопка не даёт обойти запрет. Разрешения со знаком ⚠ позволяют выполнять код на сервере (прямо или через замену файлов запуска): выдавайте их только тем, кому доверяете как администратору.</div>`;
}

function permissionMatrixHtml(checked, locked) {
  return permCatalog.groups.map(group => `<fieldset class=permgroup><legend>${esc(group.title)}</legend>${group.items.map(item => {
    const mayGrant = me.role === 'admin' || can(item.id);
    return `<label class=checkline title="${esc(item.id)}"><input type=checkbox name=perm value="${esc(item.id)}" ${checked.has(item.id) ? 'checked' : ''} ${locked || !mayGrant ? 'disabled' : ''}> ${esc(item.title)}${item.danger ? ' <span class=warnmark title="Даёт возможность выполнять код на сервере">⚠</span>' : ''}${!mayGrant && !locked ? ' <small class=muted>(у вас нет этого права)</small>' : ''}</label>`;
  }).join('')}</fieldset>`).join('');
}

function userForm(id) {
  const user = id ? usersCache.find(u => u.id === id) : null;
  const self = !!user && user.id === me.id;
  const roleOptions = Object.entries(permCatalog.roles).filter(([key]) => me.role === 'admin' || key !== 'admin' || user?.role === 'admin')
    .map(([key, role]) => `<option value="${key}" ${(user?.role || 'viewer') === key ? 'selected' : ''}>${esc(role.title)}</option>`).join('');
  const nodeItems = [['local', 'Эта панель (локальные приложения и файлы)'], ...nodeList.map(n => [String(n.id), n.name])];
  const nodeBoxes = nodeItems.map(([key, label]) => `<label class=checkline><input type=checkbox name=nodes value="${esc(key)}" ${(user ? user.nodes.includes(key) : key === 'local') ? 'checked' : ''} ${self ? 'disabled' : ''}> ${esc(label)}</label>`).join('');
  const checked = new Set(user ? user.permissions : closureOf(permCatalog.roles.viewer.permissions));
  modal(user ? 'Пользователь ' + user.username : 'Новый пользователь', `<form id=uf class=form>
    <label>Логин<input name=username value="${esc(user?.username || '')}" ${user ? 'readonly' : ''} placeholder="например, ivan" autocomplete=off></label>
    <label>Пароль${user ? ' (пусто — не менять)' : ' (минимум 8 символов)'}<input name=password type=password autocomplete=new-password></label>
    ${self ? '<div class=hint>Свою роль и права менять нельзя — это может сделать другой администратор.</div>' : ''}
    <label>Роль<select name=role ${self ? 'disabled' : ''}>${roleOptions}</select></label>
    <div><div class=muted style="margin-bottom:6px">Доступ к серверам (у администратора — ко всем)</div><div class=list>${nodeBoxes}</div></div>
    <div><div class=muted style="margin:6px 0">Разрешения <small>(при смене роли возвращаются к значениям роли)</small></div><div id=permBox class=permbox>${permissionMatrixHtml(checked, self || user?.role === 'admin')}</div></div>
    <div class=actions><button type=button class=primary id=userSaveBtn>Сохранить</button></div></form>`);

  const form = $('uf');
  const boxes = () => [...form.querySelectorAll('input[name=perm]')];
  const setChecked = set => boxes().forEach(box => { box.checked = set.has(box.value); });
  form.elements.role.onchange = () => {
    const role = form.elements.role.value;
    $('permBox').innerHTML = permissionMatrixHtml(closureOf(permCatalog.roles[role].permissions), role === 'admin');
  };
  $('permBox').onchange = event => { // зависимости: «загрузка» требует «просмотра», и наоборот при снятии
    const box = event.target;
    if (box.name !== 'perm') return;
    const current = new Set(boxes().filter(b => b.checked).map(b => b.value));
    if (box.checked) closureOf([box.value]).forEach(item => current.add(item));
    else for (const [dependent, needs] of Object.entries(permCatalog.implies)) if (needs.includes(box.value)) current.delete(dependent);
    setChecked(current);
  };
  $('userSaveBtn').onclick = async () => {
    const data = new FormData(form);
    const body = {};
    if (!user) body.username = String(data.get('username') || '').trim();
    if (data.get('password')) body.password = data.get('password');
    if (!self) {
      const role = form.elements.role.value;
      const base = closureOf(permCatalog.roles[role].permissions);
      const desired = new Set(boxes().filter(b => b.checked).map(b => b.value));
      body.role = role;
      body.nodes = data.getAll('nodes');
      if (role !== 'admin') {
        body.grant = [...desired].filter(p => !base.has(p));
        body.revoke = [...base].filter(p => !desired.has(p));
      }
    }
    try {
      await api(user ? '/users/' + user.id : '/users', { method: user ? 'PUT' : 'POST', headers: JH, body: JSON.stringify(body) });
      closeModal();
      toast('Сохранено');
      usersPage();
    } catch (error) { alert(error.message); }
  };
}

async function userDelete(id) {
  const user = usersCache.find(u => u.id === id);
  if (!confirm(`Удалить пользователя ${user ? user.username : ''}? Он сразу потеряет доступ.`)) return;
  try { await api('/users/' + id, { method: 'DELETE' }); usersPage(); } catch (error) { alert(error.message); }
}
