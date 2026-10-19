// Страница «Задачи» (расписание).

/* ---------- задачи по расписанию ---------- */
const TK_ACT = { start: 'Запустить', stop: 'Остановить', restart: 'Перезапустить', backup: 'Создать backup', command: 'Отправить команду в консоль' };
const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const p2 = n => String(n).padStart(2, '0');
function tkHuman(c) {
  let m;
  c = String(c || '').trim();
  if (m = /^(\d+) (\d+) \* \* \*$/.exec(c))
    return `Каждый день в ${p2(m[2])}:${p2(m[1])}`;
  if (m = /^(\d+) (\d+) \* \* ([\d,]+)$/.exec(c))
    return `По дням: ${m[3].split(',').map(d => DOW[+d % 7]).join(', ')} в ${p2(m[2])}:${p2(m[1])}`;
  if (m = /^\*\/(\d+) \* \* \* \*$/.exec(c))
    return `Каждые ${m[1]} мин.`;
  if (m = /^(\d+) \*\/(\d+) \* \* \*$/.exec(c))
    return `Каждые ${m[2]} ч. (в ${p2(m[1])} мин.)`;
  if (m = /^(\d+) (\d+) (\d+) \* \*$/.exec(c))
    return `Раз в месяц, ${m[3]}-го числа в ${p2(m[2])}:${p2(m[1])}`;
  return 'Свой cron';
}
function tkParse(c) {
  let m;
  c = String(c || '').trim();
  if (m = /^(\d+) (\d+) \* \* \*$/.exec(c))
    return { mode: 'daily', time: `${p2(m[2])}:${p2(m[1])}` };
  if (m = /^(\d+) (\d+) \* \* ([\d,]+)$/.exec(c))
    return { mode: 'weekly', time: `${p2(m[2])}:${p2(m[1])}`, days: m[3].split(',').map(d => +d % 7) };
  if (m = /^\*\/(\d+) \* \* \* \*$/.exec(c))
    return { mode: 'min', n: +m[1] };
  if (m = /^(\d+) \*\/(\d+) \* \* \*$/.exec(c))
    return { mode: 'hour', n: +m[2], at: +m[1] };
  if (m = /^(\d+) (\d+) (\d+) \* \*$/.exec(c))
    return { mode: 'month', time: `${p2(m[2])}:${p2(m[1])}`, day: +m[3] };
  return { mode: 'custom', cron: c };
}
async function tasks() {
  clearInterval(statsTimer);
  const t = await api('/tasks');
  appCache = await api('/apps');
  const st = x => x.last_run ? `<span class="tkst ${x.last_status === 'ok' ? 'ok' : 'err'}" title="${esc(x.last_message || '')}">${x.last_status === 'ok' ? '✓' : '✗'} ${esc(x.last_run)}</span><br><small class=muted>${esc((x.last_message || '').slice(0, 70))}</small>` : '<small class=muted>ещё не запускалась</small>';
  $('content').innerHTML = toolbar(`<button class=primary onclick="taskForm()">+ Задача</button><button class=btn onclick=tasks()>↻</button><span class=hint>Время — по часам компьютера, на котором работает панель.</span>`) +
    `<table class=table><tr><th>Задача</th><th>Расписание</th><th>Приложение</th><th>Действие</th><th>Следующий запуск</th><th>Последний запуск</th><th></th></tr>${t.map(x => `<tr class="${x.enabled ? '' : 'tkoff'}"><td><b>${esc(x.name)}</b>${x.running ? ' <small class=muted>выполняется…</small>' : ''}</td><td>${esc(tkHuman(x.cron))}<br><code>${esc(x.cron)}</code></td><td>${esc((appCache.find(a => a.id === x.app_id) || {}).name || '#' + x.app_id)}</td><td>${esc(TK_ACT[x.action] || x.action)}${x.action === 'command' ? `<br><code>${esc(x.payload)}</code>` : ''}${x.action === 'backup' && x.keep ? `<br><small class=muted>хранить ${x.keep} шт.</small>` : ''}</td><td>${x.enabled ? esc(x.next || '—') : '<small class=muted>выключена</small>'}</td><td>${st(x)}</td><td class=rowact><label class=switch title="Включить/выключить"><input type=checkbox ${x.enabled ? 'checked' : ''} onchange="tkToggle(${x.id},this.checked)"><i></i></label><button class=btn onclick="tkRun(${x.id})" title="Выполнить сейчас">▶</button><button class=btn onclick="taskForm(${x.id})">Изменить</button><button class="btn bad" onclick="delTask(${x.id})">Удалить</button></td></tr>`).join('') || '<tr><td colspan=7 class=muted>Задач пока нет. Например: «каждый день в 04:00 — перезапустить сервер» или «создавать backup каждую ночь и хранить 7 копий».</td></tr>'}</table>`;
  window._tasks = t;
}
async function taskForm(id, preset) {
  const apps = await api('/apps');
  const cur = id ? (window._tasks || []).find(x => x.id === id) : null;
  const o = cur || { name: '', cron: '0 4 * * *', app_id: preset?.app_id || (apps[0] && apps[0].id), action: preset?.action || 'restart', payload: '', keep: preset?.action === 'backup' ? 7 : 0 };
  const s = tkParse(o.cron);
  modal(id ? 'Изменить задачу' : 'Новая задача', `<div id=tf class=form>
  <label>Название<input id=tkname value="${esc(o.name)}" placeholder="Например, Ночной перезапуск"></label>
  <div class=two><label>Приложение<select id=tkapp>${apps.map(a => `<option value=${a.id} ${a.id === o.app_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
  <label>Действие<select id=tkact onchange=tkAct()>${Object.entries(TK_ACT).map(([k, v]) => `<option value=${k} ${k === o.action ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
  <div id=tkextra></div>
  <div class=box><h3>Когда выполнять</h3>
  <label>Режим<select id=tkmode onchange=tkMode()><option value=daily>Каждый день в…</option><option value=weekly>По дням недели</option><option value=hour>Каждые N часов</option><option value=min>Каждые N минут</option><option value=month>Раз в месяц</option><option value=custom>Свой cron (для опытных)</option></select></label>
  <div id=tksched style="margin-top:10px"></div>
  <div class=hint style="margin-top:10px" id=tkprev></div></div>
  <button class=primary onclick="tkSave(${id || 0})">${id ? 'Сохранить' : 'Создать задачу'}</button></div>`);
  window._tkS = s;
  window._tkO = o;
  $('tkmode').value = s.mode;
  tkAct();
  tkMode();
}
function tkAct() {
  const a = $('tkact').value, o = window._tkO || {};
  $('tkextra').innerHTML = a === 'command' ? `<label>Команда (отправляется в консоль приложения)<input id=tkpay value="${esc(o.payload || '')}" placeholder="say Перезапуск через минуту"></label>`
    : a === 'backup' ? `<label>Сколько последних копий хранить (0 — не удалять старые)<input id=tkkeep type=number min=0 max=1000 value="${o.keep || 0}"></label><div class=hint>Копия делается из рабочей папки проекта. Для Minecraft запущенный сервер перед копированием сохраняет мир.</div>`
      : a === 'restart' ? `<div class=hint>Если нужно предупредить игроков — создайте отдельную задачу «Отправить команду» за минуту до перезапуска.</div>` : '';
}
function tkMode() {
  const m = $('tkmode').value, s = window._tkS || {}, days = s.days || [1];
  const time = v => `<label>Время<input id=tktime type=time value="${v || '04:00'}" oninput=tkPrev()></label>`;
  $('tksched').innerHTML = m === 'daily' ? time(s.time) :
    m === 'weekly' ? `<div class=checks style="flex-wrap:wrap;margin-bottom:10px">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type=checkbox class=tkday value=${d} ${days.includes(d) ? 'checked' : ''} onchange=tkPrev()> ${DOW[d]}</label>`).join('')}</div>${time(s.time)}` :
      m === 'hour' ? `<div class=two><label>Каждые (часов)<input id=tkn type=number min=1 max=23 value="${s.n || 6}" oninput=tkPrev()></label><label>В какую минуту<input id=tkat type=number min=0 max=59 value="${s.at || 0}" oninput=tkPrev()></label></div>` :
        m === 'min' ? `<label>Каждые (минут)<input id=tkn type=number min=1 max=59 value="${s.n || 15}" oninput=tkPrev()></label>` :
          m === 'month' ? `<div class=two><label>Число месяца<input id=tkday type=number min=1 max=31 value="${s.day || 1}" oninput=tkPrev()></label>${time(s.time)}</div>` :
            `<label>Cron (5 полей: минута час день месяц день_недели)<input id=tkcron value="${esc(s.cron || '0 4 * * *')}" oninput=tkPrev()></label>`;
  tkPrev();
}
function tkCron() {
  const m = $('tkmode').value, tm = () => {
    const [h, mi] = ($('tktime').value || '04:00').split(':').map(Number);
    return [mi, h];
  };
  if (m === 'daily') {
    const [mi, h] = tm();
    return `${mi} ${h} * * *`;
  }
  if (m === 'weekly') {
    const [mi, h] = tm();
    const d = [...document.querySelectorAll('.tkday:checked')].map(x => x.value);
    return d.length ? `${mi} ${h} * * ${d.join(',')}` : '';
  }
  if (m === 'hour')
    return `${+$('tkat').value || 0} */${Math.max(1, +$('tkn').value || 1)} * * *`;
  if (m === 'min')
    return `*/${Math.max(1, +$('tkn').value || 1)} * * * *`;
  if (m === 'month') {
    const [mi, h] = tm();
    return `${mi} ${h} ${Math.min(31, Math.max(1, +$('tkday').value || 1))} * *`;
  }
  return ($('tkcron').value || '').trim();
}
let tkPrevT = null;
function tkPrev() {
  const c = tkCron(), el = $('tkprev');
  if (!el)
    return;
  if (!c) {
    el.textContent = 'Выберите хотя бы один день недели';
    return;
  }
  el.innerHTML = `<b>${esc(tkHuman(c))}</b> · <code>${esc(c)}</code><div id=tknext class=muted></div>`;
  clearTimeout(tkPrevT);
  tkPrevT = setTimeout(async () => {
    try {
      const r = await api('/tasks/preview?cron=' + encodeURIComponent(c));
      if ($('tknext'))
        $('tknext').textContent = r.next.length ? 'Ближайшие запуски: ' + r.next.join(' · ') : 'Расписание некорректно';
    }
    catch {
    }
  }, 300);
}
async function tkSave(id) {
  const b = { name: $('tkname').value.trim(), app_id: +$('tkapp').value, action: $('tkact').value, cron: tkCron() };
  if (b.action === 'command')
    b.payload = $('tkpay').value;
  if (b.action === 'backup')
    b.keep = +$('tkkeep').value || 0;
  try {
    await api(id ? '/tasks/' + id : '/tasks', { method: id ? 'PUT' : 'POST', headers: JH, body: JSON.stringify(b) });
    closeModal();
    tasks();
  }
  catch (e) {
    alert(e.message);
  }
}
async function tkToggle(id, on) {
  try {
    await api('/tasks/' + id, { method: 'PUT', headers: JH, body: JSON.stringify({ enabled: on }) });
    tasks();
  }
  catch (e) {
    alert(e.message);
    tasks();
  }
}
async function tkRun(id) {
  try {
    await api(`/tasks/${id}/run`, { method: 'POST' });
    toast('Задача запущена');
    setTimeout(tasks, 2500);
  }
  catch (e) {
    alert(e.message);
  }
}
async function delTask(id) {
  if (confirm('Удалить задачу?')) {
    await api('/tasks/' + id, { method: 'DELETE' });
    tasks();
  }
}
