// Страницы «Runtime», «Docker», «Журнал», «Настройки».

async function runtimes() {
  $('content').innerHTML = '<div class=muted>Поиск Runtime…</div>';
  const d = await api('/runtimes?refresh=1');
  $('content').innerHTML = toolbar(`<button class=btn onclick=runtimes()>↻ Обновить</button>`) + `<div class=grid>${d.map(x => `<div class=card><div class=split><h3>${esc(x.label)}${x.major ? ' ' + x.major : ''}</h3><span class="status ${x.isDefault ? 'good' : 'muted'}"><i class="dot ${x.isDefault ? 'on' : ''}"></i>${x.isDefault ? 'В PATH (по умолчанию)' : x.source === 'PATH' ? 'В PATH' : 'Найден поиском'}</span></div><p>${esc(x.version)}</p><code>${esc(x.path)}</code></div>`).join('') || empty('Runtime не найдены')}</div>`;
}
async function docker() {
  try {
    const d = await api('/docker');
    $('content').innerHTML = toolbar(`<button class=primary onclick=dockerRun()>+ Создать контейнер</button><button class=btn onclick=docker()>↻ Обновить</button>`) + `<div class=hint>Docker должен быть установлен и доступен пользователю Node.js.</div><table class=table><tr><th>Имя</th><th>Image</th><th>Статус</th><th></th></tr>${d.map(x => `<tr><td><b>${esc(x.Names || x.name)}</b></td><td><code>${esc(x.Image)}</code></td><td>${esc(x.Status)}</td><td><button class=btn onclick="dockerAct(${jsArg(x.ID)},'start')">Start</button><button class=btn onclick="dockerAct(${jsArg(x.ID)},'stop')">Stop</button><button class=btn onclick="dockerAct(${jsArg(x.ID)},'restart')">Restart</button><button class=btn onclick="dockerLogs(${jsArg(x.ID)})">Logs</button><button class="btn bad" onclick="dockerAct(${jsArg(x.ID)},'remove')">Удалить</button></td></tr>`).join('') || '<tr><td colspan=4 class=muted>Контейнеров нет или Docker недоступен.</td></tr>'}</table>`;
  }
  catch (e) {
    $('content').innerHTML = `<div class=empty>Docker недоступен: ${esc(e.message)}</div>`;
  }
}
async function dockerRun() {
  modal('Новый Docker-контейнер', `<form id=df class=form><label>Image<input name=image placeholder="nginx:latest" required></label><label>Имя<input name=name placeholder="my-server"></label><label>Порты<input name=ports placeholder="25565:25565,8080:80"></label><label>Команда<input name=command placeholder="Необязательно"></label><button class=primary type=button onclick=saveDocker()>Запустить</button></form>`);
}
async function saveDocker() {
  const b = Object.fromEntries(new FormData($('df')));
  try {
    await api('/docker/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    closeModal();
    docker();
  }
  catch (e) {
    alert(e.message);
  }
}
async function dockerAct(id, a) {
  if (a === 'remove' && !confirm('Удалить контейнер?'))
    return;
  try {
    await api(`/docker/${encodeURIComponent(id)}/${a}`, { method: 'POST' });
    docker();
  }
  catch (e) {
    alert(e.message);
  }
}
async function dockerLogs(id) {
  try {
    const d = await api('/docker/' + encodeURIComponent(id) + '/logs');
    modal('Docker Logs', `<div class=console><div class=out>${esc(d)}</div></div>`);
  }
  catch (e) {
    alert(e.message);
  }
}
async function audit() {
  const d = await api('/audit');
  $('content').innerHTML = `<table class=table><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Подробности</th></tr>${d.map(x => `<tr><td>${esc(x.created_at)}</td><td>${esc(x.username)}</td><td>${esc(x.action)}</td><td>${esc(x.details)}</td></tr>`).join('')}</table>`;
}
function settings() {
  modal('Настройки', `<form id=pf class=form><label>Текущий пароль<input type=password name=currentPassword></label><label>Новый пароль<input type=password name=newPassword minlength=8></label><button class=primary type=button onclick=changePass()>Изменить пароль</button></form><div class=hint style="margin-top:15px"><b>Важно</b><p>Для публичного доступа используйте HTTPS/reverse proxy. Процессы запускаются с правами пользователя Node.js.</p></div>`);
}
async function changePass() {
  const b = Object.fromEntries(new FormData($('pf')));
  try {
    const result = await api('/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    token = result.token; // после смены пароля старые токены недействительны — сервер выдаёт новый
    localStorage.sm_token = token;
    if (me) me.defaultPassword = false;
    applyPermissions();
    connectWS();
    alert('Пароль изменён');
    closeModal();
  }
  catch (e) {
    alert(e.message);
  }
}
