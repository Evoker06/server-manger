// Страницы «Панель» и «Приложения»: карточки, консоль, логи, профили запуска, вкладки приложения.

/* ================= Главная: показатели, приложения, график, серверы, события ================= */
let dashState = { status: 'all', q: '', n: 0, gpu: null, disks: null, hist: { cpu: [], ram: [] }, busy: false };
const DASH_HIST = 40; // ~2 минуты при опросе раз в 3 секунды

const dashMetric = (id, label, cls) => `<div class="lm na" id="lmw_${id}"><span class="lml ${cls}">${label}</span><b id="lm_${id}">—</b><div class=lbar><i class="${cls}" id="lb_${id}" style="width:0"></i></div></div>`;
function dashSetMetric(id, value) {
  const wrap = $('lmw_' + id), text = $('lm_' + id), bar = $('lb_' + id);
  if (!wrap) return;
  const ok = value != null && !isNaN(value);
  wrap.classList.toggle('na', !ok);
  text.textContent = ok ? Math.round(value) + '%' : '—';
  bar.style.width = ok ? Math.max(0, Math.min(100, value)) + '%' : '0';
}

async function dashboard() {
  clearInterval(statsTimer);
  appCache = await api('/apps');
  dashState = { status: 'all', q: '', n: 0, gpu: null, disks: null, hist: { cpu: [], ram: [] }, busy: false };
  const taskCard = can('tasks.view') ? `<div class=kpi id=kpiTasks><div class=kpi-top><span>Задачи по расписанию</span><i class="kpi-ic amber">${ic('tasks')}</i></div><div class=kpi-val><b>—</b><small class=muted>включено</small></div><div class=kpi-foot><span>загрузка…</span></div></div>` : '';
  $('content').innerHTML = `<div class=pagehead><div><h1>Главный экран панели</h1><p>Сводка по приложениям, серверам и нагрузке</p></div><button class=btn onclick="refreshCurrent()">${ic('refresh')} Обновить данные</button></div>
  <div class=kpis>
    <div class=kpi id=kpiApps></div>
    <div class=kpi id=kpiSrv></div>
    ${taskCard}
    <div class=kpi id=kpiLoad><div class=kpi-top><span>Нагрузка системы</span><i class="kpi-ic green">${ic('cpu')}</i></div>
      <div class=loadgrid>${dashMetric('cpu', 'CPU', 'c-blue')}${dashMetric('gpu', 'GPU', 'c-purple')}${dashMetric('ram', 'RAM', 'c-indigo')}${dashMetric('hdd', 'HDD', 'c-amber')}${dashMetric('ssd', 'SSD', 'c-teal')}</div>
      <div class=kpi-foot><span id=loadinfo>—</span></div></div>
  </div>
  <div class=dashgrid>
    <div class=dashcol>
      <div class=panelbox>
        <div class=pbhead><div><h3>Ключевые приложения и проекты</h3><small class=muted>Состояние и управление запуском</small></div><button class=pblink onclick="page('apps')">Все приложения (${appCache.length}) →</button></div>
        <div class=dashtools>
          <div class=seg id=dashSeg><button class=active data-s=all>Все</button><button data-s=running>Работают</button><button data-s=stopped>Остановлены</button></div>
          <input id=dashQ placeholder="Быстрый поиск…" autocomplete=off>
        </div>
        <div class=tablewrap><table class=table><thead><tr><th>Проект</th><th>Статус</th><th>Процесс</th><th></th></tr></thead><tbody id=dashApps></tbody></table></div>
      </div>
      <div class=panelbox>
        <div class=pbhead><div><h3>Мониторинг компьютера</h3><small class=muted>CPU и RAM с момента открытия страницы</small></div><span class=livemark>Live</span></div>
        <div class=chartbox><canvas id=dashChart></canvas></div>
        <div class=legend><span><i style="background:#3b82f6"></i>CPU</span><span><i style="background:#8b5cf6"></i>RAM</span></div>
      </div>
    </div>
    <div class=dashcol>
      <div class=panelbox><div class=pbhead><h3>Серверы</h3>${can('settings.manage') ? `<button class=pblink onclick="page('nodes')">Управление →</button>` : ''}</div><div class=srvlist id=dashSrv><span class=muted>Проверка связи…</span></div>${can('settings.manage') ? `<button class=addnode onclick="page('nodes');setTimeout(()=>nodeForm(),300)">+ Добавить сервер</button>` : ''}</div>
      ${can('audit.view') ? `<div class=panelbox><div class=pbhead><h3>События</h3><button class=pblink onclick="page('audit')">Весь журнал →</button></div><div class=evlist id=dashEv><span class=muted>Загрузка…</span></div></div>` : ''}
    </div>
  </div>`;
  $('dashSeg').onclick = e => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    dashState.status = b.dataset.s;
    $('dashSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    dashRenderApps();
  };
  $('dashQ').oninput = e => { dashState.q = e.target.value.toLowerCase(); dashRenderApps(); };
  dashRenderApps();
  dashLoadSide();
  dashTick();
  pollCards();
}

/** Карточка «Приложения», таблица и счётчик в меню — из свежего appCache. */
function dashRenderApps() {
  const total = appCache.length, running = appCache.filter(a => a.running).length;
  const kpi = $('kpiApps');
  if (kpi) kpi.innerHTML = `<div class=kpi-top><span>Приложения и проекты</span><i class="kpi-ic blue">${ic('cube')}</i></div><div class=kpi-val><b>${total}</b><small class=muted>всего</small></div><div class=kpi-foot><span class=ok>${running} запущено</span><span>${total - running} остановлено</span></div>`;
  setNavBadges();
  const body = $('dashApps');
  if (!body) return;
  const rows = appCache.filter(a => (dashState.status === 'all' || (dashState.status === 'running') === !!a.running)
    && (a.name + ' ' + (a.type || '')).toLowerCase().includes(dashState.q));
  body.innerHTML = rows.slice(0, 12).map(a => `<tr><td><div class=pcell><i class="pico ${a.running ? 'on' : ''}">${ic('cube')}</i><div><b>${esc(a.name)}</b><small class=muted>${esc(a.type || 'auto')}</small></div></div></td>
    <td><span class="pill ${a.running ? 'ok' : ''}"><i class=dot></i>${a.running ? 'Запущено' : 'Остановлено'}</span></td>
    <td class=muted>PID ${a.pid || '—'} · ${a.port ? 'порт ' + a.port : 'порт не указан'}</td>
    <td><div class=rowbtns>${a.running ? `<button class="btn stop" onclick="act(${a.id},'stop')">Стоп</button>` : `<button class="btn go" onclick="act(${a.id},'start')">Запуск</button>`}<button class=btn onclick="page('app:${a.id}')">Открыть</button></div></td></tr>`).join('')
    || `<tr><td colspan=4 class=muted>${total ? 'Ничего не найдено.' : 'Приложений пока нет — добавьте первое.'}</td></tr>`;
}

/** Серверы и последние события — загружаются один раз при открытии страницы. */
async function dashLoadSide() {
  const hasLocal = !!document.querySelector('#nodeSel option[value=local]');
  const list = [...(hasLocal ? [{ id: 'local', name: 'Эта панель' }] : []), ...nodeList];
  const status = {};
  try { for (const s of await api('/nodes/status')) status[s.id] = s; } catch { }
  const srv = $('dashSrv');
  if (srv) srv.innerHTML = list.map(n => {
    const s = status[n.id], isLocal = n.id === 'local', ok = isLocal || (s && s.ok);
    const info = isLocal ? 'локально' : s ? (s.ok ? `online · ${s.ms} мс` : esc(s.error || 'offline')) : 'нет данных';
    return `<div class="srvitem ${ok ? '' : 'off'}"><div style="min-width:0"><b><i class="dot ${ok ? 'on' : 'bad'}"></i><span style="overflow:hidden;text-overflow:ellipsis">${esc(n.name)}</span>${String(n.id) === String(node) ? ' <small class=muted>(выбран)</small>' : ''}</b><small class=muted>${info}</small></div>${String(n.id) === String(node) ? '' : `<button class=btn onclick="switchNode(${jsArg(n.id)})">Открыть</button>`}</div>`;
  }).join('') || '<span class=muted>Серверов нет</span>';
  const online = list.filter(n => n.id === 'local' || (status[n.id] && status[n.id].ok)).length;
  const k = $('kpiSrv');
  if (k) k.innerHTML = `<div class=kpi-top><span>Серверы</span><i class="kpi-ic indigo">${ic('server')}</i></div><div class=kpi-val><b>${list.length}</b><small class=muted>${list.length === 1 ? 'сервер' : 'в панели'}</small></div><div class=kpi-foot><span class=ok>${online} онлайн</span><span class="${list.length - online ? 'no' : ''}">${list.length - online} офлайн</span></div>`;
  if (can('tasks.view')) {
    try {
      const t = await api('/tasks'), on = t.filter(x => x.enabled).length, bad = t.filter(x => x.last_status && x.last_status !== 'ok').length;
      const kt = $('kpiTasks');
      if (kt) kt.innerHTML = `<div class=kpi-top><span>Задачи по расписанию</span><i class="kpi-ic amber">${ic('tasks')}</i></div><div class=kpi-val><b>${on}</b><small class=muted>включено</small></div><div class=kpi-foot><span class="${bad ? 'no' : 'ok'}">${bad ? bad + ' с ошибкой' : 'ошибок нет'}</span><span>всего ${t.length}</span></div>`;
    } catch { }
  }
  if (can('audit.view') && $('dashEv')) {
    try {
      const ev = (await api('/audit')).slice(0, 6);
      $('dashEv').innerHTML = ev.map(x => `<div class=evitem><i class=evic>${ic('activity')}</i><div><b>${esc(x.action)}</b><small class=muted>${esc(x.username)}${x.details ? ' · ' + esc(x.details) : ''}</small><small class=muted>${esc(x.created_at)}</small></div></div>`).join('') || '<span class=muted>Событий пока нет</span>';
    } catch (e) { if ($('dashEv')) $('dashEv').innerHTML = `<span class=muted>${esc(e.message)}</span>`; }
  }
}

/** Живые показатели: CPU/RAM каждые 3 с, GPU — каждые 6 с, диски — каждые 15 с. Чего система не сообщает, показывается как «—». */
async function dashTick() {
  if (!$('kpiLoad') || dashState.busy || document.hidden) return;
  dashState.busy = true;
  const n = dashState.n++;
  try {
    const s = await api('/system');
    const cpu = +s.cpu || 0, ram = s.memTotal ? s.memUsed / s.memTotal * 100 : 0;
    dashSetMetric('cpu', cpu);
    dashSetMetric('ram', ram);
    const info = $('loadinfo');
    if (info) info.textContent = `${s.cores} потоков · RAM ${fmtSize(s.memUsed)} из ${fmtSize(s.memTotal)}`;
    const h = dashState.hist;
    h.cpu.push(cpu); h.ram.push(ram);
    if (h.cpu.length > DASH_HIST) { h.cpu.shift(); h.ram.shift(); }
    dashDrawChart();
    if (can('system.view')) {
      if (n % 2 === 0) {
        try {
          const l = await api('/hw/live?gpu=1');
          const g = (l.gpus || []).find(x => x.load != null);
          dashState.gpu = g ? g.load : null;
        } catch { dashState.gpu = null; }
      }
      dashSetMetric('gpu', dashState.gpu);
      if (n % 5 === 0) {
        try {
          const d = await api('/hw/disks?mode=space');
          const use = types => {
            const parts = d.disks.filter(k => types.includes(k.type)).flatMap(k => k.partitions).filter(p => p.accessible && p.size);
            const size = parts.reduce((a, p) => a + p.size, 0);
            return size ? parts.reduce((a, p) => a + p.used, 0) / size * 100 : null;
          };
          dashState.disks = { hdd: use(['HDD']), ssd: use(['SSD', 'NVMe']) };
        } catch { dashState.disks = null; }
      }
      dashSetMetric('hdd', dashState.disks && dashState.disks.hdd);
      dashSetMetric('ssd', dashState.disks && dashState.disks.ssd);
    }
  } catch { } finally { dashState.busy = false; }
}

/** График CPU/RAM на обычном canvas (без внешних библиотек), цвета берутся из текущей темы. */
function dashDrawChart() {
  const c = $('dashChart');
  if (!c) return;
  const ratio = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  c.width = w * ratio; c.height = h * ratio;
  const g = c.getContext('2d');
  g.scale(ratio, ratio);
  const css = getComputedStyle(document.documentElement), grid = css.getPropertyValue('--line').trim() || '#1f2937', txt = css.getPropertyValue('--muted').trim() || '#9ca3af';
  const L = 34, R = 8, T = 8, B = 8, pw = w - L - R, ph = h - T - B;
  g.font = '10px Inter, Segoe UI, sans-serif'; g.textBaseline = 'middle'; g.lineWidth = 1;
  for (const v of [0, 25, 50, 75, 100]) {
    const y = T + ph - ph * v / 100;
    g.strokeStyle = grid; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
    g.fillStyle = txt; g.fillText(v + '%', 2, y);
  }
  const line = (arr, color, fill) => {
    if (arr.length < 2) return;
    const step = pw / (DASH_HIST - 1), x0 = L + pw - step * (arr.length - 1);
    g.beginPath();
    arr.forEach((v, i) => { const x = x0 + i * step, y = T + ph - ph * Math.min(100, Math.max(0, v)) / 100; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    if (fill) {
      g.lineTo(x0 + (arr.length - 1) * step, T + ph); g.lineTo(x0, T + ph); g.closePath();
      g.fillStyle = fill; g.fill();
    }
  };
  line(dashState.hist.ram, '#8b5cf6');
  line(dashState.hist.cpu, '#3b82f6', 'rgba(59,130,246,.12)');
}
window.addEventListener('resize', () => { if (typeof dashDrawChart === 'function') dashDrawChart(); });

function appCard(a) {
  return `<div class=card><div class=split><div><h3>${esc(a.name)}</h3><small>${esc(a.type || 'auto')}</small></div><span class="status ${a.running ? 'good' : 'muted'}"><i class="dot ${a.running ? 'on' : ''}"></i>${a.running ? 'Запущено' : 'Остановлено'}</span></div><div class=appmeta>PID: ${a.pid || '—'} · ${a.port ? 'порт ' + a.port : 'порт не указан'}</div><div class=actions><button class=primary onclick="act(${a.id},'start')" ${a.running ? 'disabled' : ''}>Запуск</button><button class=btn onclick="act(${a.id},'restart')">↻</button><button class=btn onclick="act(${a.id},'stop')" ${!a.running ? 'disabled' : ''}>Стоп</button><button class=btn onclick="page('app:${a.id}')">Открыть</button></div></div>`;
}
async function pollCards() {
  clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (document.hidden || (currentPage !== 'dash' && currentPage !== 'apps'))
      return;
    try {
      appCache = await api('/apps');
      setNavBadges();
      if (currentPage === 'dash') {
        dashRenderApps();
        dashTick();
      }
      else if ($('appgrid')) {
        const q = ($('search')?.value || '').toLowerCase();
        $('appgrid').innerHTML = appCache.filter(x => (x.name + ' ' + x.type + ' ' + x.command).toLowerCase().includes(q)).map(appCard).join('') || empty('Добавьте первое приложение');
      }
    }
    catch {
    }
  }, 3000);
}
async function apps() {
  clearInterval(statsTimer);
  appCache = await api('/apps');
  $('content').innerHTML = toolbar(`<input id=search class=search placeholder="Поиск приложения..." oninput=filterApps()><button class=primary onclick=newApp()>+ Добавить</button>`) + `<div id=appgrid class=grid>${appCache.map(appCard).join('') || empty('Добавьте первое приложение')}</div>`;
  pollCards();
}
function filterApps() {
  const q = $('search').value.toLowerCase();
  $('appgrid').innerHTML = appCache.filter(x => (x.name + ' ' + x.type + ' ' + x.command).toLowerCase().includes(q)).map(appCard).join('');
}
function empty(x) {
  return `<div class=empty>${esc(x)}</div>`;
}
async function updateSys() {
  try {
    const s = await api('/system');
    let el = $('dsys');
    if (!el) {
      const st = document.querySelector('#content .stats');
      if (!st)
        return;
      st.insertAdjacentHTML('afterend', '<div class=hint id=dsys style="margin-bottom:18px"></div>');
      el = $('dsys');
    }
    el.innerHTML = `Компьютер: CPU <b>${s.cpu.toFixed(0)}%</b> (${s.cores} потоков) · RAM <b>${fmtSize(s.memUsed)}</b> из ${fmtSize(s.memTotal)} (${(s.memUsed / s.memTotal * 100).toFixed(0)}%)`;
  }
  catch {
  }
}
async function deleteApp(id) {
  if (confirm('Удалить приложение?')) {
    try {
      await api('/apps/' + id, { method: 'DELETE' });
      closeModal();
      apps();
    }
    catch (e) {
      alert(e.message);
    }
  }
}
function consoleOpen(id) {
  activeAppId = id;
  window.consoleAppId = id;
  const title = (appCache.find(x => x.id === id) || {}).name || 'Консоль';
  modal(title, `<div class=console><div id=out class=out></div><div class=cin><input id=ci placeholder="Команда..."><button onclick="send(${id})">SEND</button></div></div>`);
  loadOutput(id);
}
async function loadOutput(id) {
  try {
    const d = await api('/apps/' + id + '/output');
    if ($('out')) {
      $('out').textContent = d.map(x => x.data).join('');
      $('out').scrollTop = $('out').scrollHeight;
    }
  }
  catch {
  }
}
async function send(id) {
  const x = $('ci');
  if (x.value) {
    try {
      await api('/apps/' + id + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: x.value }) });
      x.value = '';
    }
    catch (e) {
      alert(e.message);
    }
  }
}
async function sendDetail(id) {
  const x = $('detailCmd');
  if (x?.value) {
    await sendCommand(id, x.value);
    x.value = '';
  }
}
async function sendCommand(id, c) {
  try {
    await api('/apps/' + id + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: c }) });
  }
  catch (e) {
    alert(e.message);
  }
}
async function browseSelect(field) {
  const start = $('appform')?.elements[field]?.value || '';
  let cur = start;
  async function draw() {
    const d = await api('/browse?path=' + encodeURIComponent(cur));
    modal('Выбор папки', `<div class=browser><div class=split><code>${esc(cur || '/')}</code><button class=btn onclick="browseRoot()">Корень</button></div>${d.map(x => `<button class=item onclick="browseInto(${jsArg(x.path)})">📁 ${esc(x.name)}</button>`).join('') || empty('Нет вложенных папок')}<button class=primary onclick="chooseBrowse(${jsArg(field)},${jsArg(cur)})">Выбрать эту папку</button></div>`);
  }
  window.browseInto = p => {
    cur = p;
    draw();
  };
  window.browseRoot = () => {
    cur = '';
    draw();
  };
  window.chooseBrowse = (f, p) => {
    $('appform').elements[f].value = p;
    closeModal();
  };
  draw();
}

// M5: project import wizard and full application workspace
async function importWizard() {
  let scan = null;
  const draw = () => {
    const candidates = scan?.candidates || [];
    modal('Импорт проекта', `<div class=wizard><div class=step><b>1.</b> Укажите папку проекта</div><div class=inline><input id=scanPath value="${esc(scan?.cwd || '')}" placeholder="C:\\Servers\\MyServer или /opt/myserver"><button class=btn onclick="wizardBrowse()">Обзор…</button></div><button class=primary onclick="runScan()">🔎 Просканировать</button>${scan ? `<div class=step><b>2.</b> Выберите способ запуска</div><div class=scanlist>${candidates.map((c, i) => `<label class="scanitem"><input type=radio name=scanCandidate value="${i}" ${i === 0 ? 'checked' : ''}><div><b>${esc(c.label)}</b><small>${esc(c.command || 'Без команды')} · ${esc(c.confidence)}${c.runtime && !c.availableRuntime ? ' · runtime не найден' : ''}</small>${c.details ? `<small>${esc(c.details)}</small>` : ''}</div></label>`).join('')}</div><div class=two><label>Название<input id=scanName value="${esc(basename(scan.cwd))}"></label><label>Порт<input id=scanPort type=number></label></div><div class=checks><label><input id=scanAutoStart type=checkbox> Автозапуск</label><label><input id=scanAutoRestart type=checkbox> Автоперезапуск</label></div><button class=primary onclick="finishImport()">✓ Создать приложение</button>` : ''}</div>`);
  };
  window.runScan = async () => {
    const cwd = $('scanPath').value.trim();
    if (!cwd)
      return alert('Укажите папку');
    try {
      scan = await api('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) });
      draw();
    }
    catch (e) {
      alert(e.message);
    }
  };
  window.wizardBrowse = () => browseScanPath();
  window.finishImport = async () => {
    const chosen = document.querySelector('input[name=scanCandidate]:checked');
    if (!chosen)
      return;
    try {
      const b = { working_dir: scan.cwd, candidate: +chosen.value, name: $('scanName').value.trim(), port: $('scanPort').value || null, auto_start: $('scanAutoStart').checked, auto_restart: $('scanAutoRestart').checked };
      const a = await api('/apps/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      closeModal();
      page('app:' + a.id);
    }
    catch (e) {
      alert(e.message);
    }
  };
  window.browseScanPath = async () => {
    let cur = '';
    const drawBrowse = async () => {
      const d = await api('/browse?path=' + encodeURIComponent(cur));
      modal('Выбор папки', `<div class=browser><div class=split><code>${esc(cur || '/')}</code><button class=btn onclick="${cur ? 'scanParent()' : 'void(0)'}">${cur ? 'Вверх' : 'Корень'}</button></div>${d.map(x => `<button class=item onclick="scanInto(${jsArg(x.path)})">📁 ${esc(x.name)}</button>`).join('') || empty('Нет вложенных папок')}<button class=primary onclick="scanChoose(${jsArg(cur)})">Выбрать</button></div>`);
    };
    window.scanInto = p => {
      cur = p;
      drawBrowse();
    };
    window.scanParent = () => {
      cur = cur.replace(/[\\/]$/, '').split(/[\\/]/).slice(0, -1).join(pathSep(cur)) || '';
      if (/^[A-Za-z]:$/.test(cur))
        cur += '\\';
      drawBrowse();
    };
    window.scanChoose = p => {
      closeModal();
      setTimeout(() => {
        importWizard();
        setTimeout(() => {
          $('scanPath').value = p;
        }, 50);
      }, 50);
    };
    await drawBrowse();
  };
  draw();
}

async function workspaceStats(id) {
  const points = [];
  clearInterval(statsTimer);
  const c = $('chart');
  if (!c)
    return;
  const ctx = c.getContext('2d');
  updateSys();
  const plot = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#6ea8fe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((v, i) => {
      const x = 10 + i * (c.width - 20) / Math.max(1, points.length - 1), y = c.height - 20 - Math.min(100, v) * 1.5;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  statsTimer = setInterval(async () => {
    try {
      const s = await api(`/apps/${id}/stats`);
      if ($('dcpu'))
        $('dcpu').textContent = s.cpu.toFixed(1) + '%';
      if ($('dram'))
        $('dram').textContent = fmtSize(s.memory);
      updateSys();
      points.push(Math.min(100, s.cpu));
      if (points.length > 80)
        points.shift();
      plot();
    }
    catch {
    }
  }, 1000);
  plot();
}

/* консоль: вывод пачками по кадрам, не больше ~1500 блоков, прокрутка только если вы внизу */
let _cq = '', _cr = 0;
function consoleAppend(t) {
  _cq += t;
  if (_cr)
    return;
  _cr = requestAnimationFrame(() => {
    _cr = 0;
    const s = _cq;
    _cq = '';
    for (const id of ['out', 'detailOut']) {
      const el = $(id);
      if (!el)
        continue;
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      el.appendChild(document.createTextNode(s));
      el._n = (el._n || 0) + 1;
      if (el._n > 1500) {
        while (el.childNodes.length > 1000)
          el.removeChild(el.firstChild);
        el._n = 1000;
      }
      if (atEnd)
        el.scrollTop = el.scrollHeight;
    }
  });
}
/* ---------- запуск/остановка ---------- */
async function act(id, a) {
  try {
    const d = await api(`/apps/${id}/${a}`, { method: 'POST', headers: JH, body: '{}' });
    if (d && d.warning)
      alert(d.warning);
    if (currentPage === 'apps')
      apps();
    else if (String(currentPage).startsWith('app:'))
      appWorkspace(id, wsTab);
    else
      dashboard();
  }
  catch (e) {
    alert(e.message);
  }
}

/* ---------- логи ---------- */
let lgKb = 256, lgTimer = null;
const LG_RE = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[(stdout|stderr|system)\] ?(.*)$/;
function lgRender(text) {
  const f = $('lgf').value, q = ($('lgq').value || '').toLowerCase(), out = $('lgout');
  if (!out)
    return;
  const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  let n = 0, html = [];
  for (const line of text.split('\n')) {
    if (!line)
      continue;
    const m = LG_RE.exec(line);
    const st = m ? m[2] : 'stdout', body = m ? m[3] : line;
    if (f === 'stderr' && st !== 'stderr')
      continue;
    if (f === 'system' && st !== 'system')
      continue;
    if (q && !line.toLowerCase().includes(q))
      continue;
    n++;
    html.push(`<div class="lgl ${st}">${m ? `<span class=lgt>${esc(new Date(m[1]).toLocaleTimeString())}</span>` : ''}${esc(body)}</div>`);
  }
  if (html.length > 3000)
    html = html.slice(-3000); // показываем последние 3000 строк — иначе браузер тормозит
  out.innerHTML = html.join('') || '<div class=muted style="padding:6px">Нет строк</div>';
  $('lgn').textContent = html.length + ' строк';
  if (atEnd)
    out.scrollTop = out.scrollHeight;
}
async function lgLoad(id) {
  try {
    const t = await apiText(`/apps/${id}/log?kb=${lgKb}`);
    if (t === window._lgText && $('lgout') && $('lgout').children.length)
      return;
    window._lgText = t;
    lgRender(t);
  }
  catch (e) {
    if ($('lgout'))
      $('lgout').innerHTML = `<div class=err>${esc(e.message)}</div>`;
  }
}
function lgTab(id) {
  return `<div class=toolbar><select id=lgf onchange="lgRender(window._lgText||'')" style="width:auto"><option value=all>Все</option><option value=stderr>Только ошибки</option><option value=system>Только панель</option></select><input id=lgq class=search placeholder="Поиск по логу…" oninput="lgRender(window._lgText||'')"><label class=checkline style="margin:0"><input type=checkbox id=lgauto checked onchange="lgAuto(${id})"> автообновление</label><button class=btn onclick="lgLoad(${id})">↻</button><button class=btn onclick="lgMore(${id})">Показать больше</button><button class=btn onclick="lgDownload(${id})">Скачать</button>${can('logs.clear') ? `<button class="btn bad" onclick="clearAppLog(${id})">Очистить</button>` : ''}<small id=lgn class=muted></small></div><div class=console><div id=lgout class="out lgout">Загрузка…</div></div>`;
}
function lgAuto(id) {
  clearInterval(lgTimer);
  if ($('lgauto') && $('lgauto').checked)
    lgTimer = setInterval(() => {
      if (!$('lgout')) {
        clearInterval(lgTimer);
        return;
      }
      if (document.hidden)
        return;
      lgLoad(id);
    }, 3000);
}
function lgMore(id) {
  lgKb = Math.min(4096, lgKb * 4);
  lgLoad(id);
}
function lgDownload(id) {
  downloadByTicket({ applog: String(id) });
}
async function clearAppLog(id) {
  if (!confirm('Очистить лог приложения?'))
    return;
  try {
    await api(`/apps/${id}/log`, { method: 'DELETE' });
    lgLoad(id);
  }
  catch (e) {
    alert(e.message);
  }
}

/* ---------- профили запуска ---------- */
let profRt = [];
const envCount = s => {
  try {
    return Object.keys(JSON.parse(s || '{}')).length;
  }
  catch {
    return 0;
  }
};
function profRtName(p) {
  if (!p)
    return 'по умолчанию (из PATH)';
  const r = profRt.find(x => x.path === p);
  return r ? `${r.label}${r.major ? ' ' + r.major : ''} (${r.version || ''})` : p;
}
async function profTab(id, a) {
  const [list, rt] = await Promise.all([api(`/apps/${id}/profiles`), api('/runtimes').catch(() => [])]);
  profRt = rt;
  const adm = can('apps.edit');
  const cards = list.map(p => `<div class="profcard ${p.active ? 'active' : ''}"><div class=split><div><h3>${esc(p.name)} ${p.active ? '<span class=pfbadge style="background:#14301f;color:var(--good)">● Активен</span>' : ''}</h3>${p.note ? `<small class=muted>${esc(p.note)}</small>` : ''}</div></div>
  <div class=profrows><div><small>Команда запуска</small><code>${esc(p.command)}</code></div><div><small>Среда выполнения (Java / Node…)</small><span>${esc(profRtName(p.runtime_path))}</span></div><div><small>Переменные окружения</small><span>${envCount(p.env_json) ? envCount(p.env_json) + ' шт.' : 'нет'}</span></div></div>
  <div class=actions style="margin-top:12px">${p.active ? '<button class=btn disabled>Уже применён</button>' : a.running ? `<button class=primary onclick="profApply(${id},${p.id},true)">Применить и перезапустить</button>` : `<button class=primary onclick="profApply(${id},${p.id},false)">Применить</button>`}${adm ? `<button class=btn onclick="profForm(${id},${p.id})">Изменить</button><button class=btn onclick="profCopy(${id},${p.id})">Копия</button><button class="btn bad" onclick="profDelete(${id},${p.id})">Удалить</button>` : ''}</div></div>`).join('');
  return `<div class=hint style="margin-bottom:14px"><b>Что такое профиль.</b> Профиль — это сохранённый вариант запуска проекта: команда, версия Java/Node и переменные окружения. Например, «Java 17» и «Java 21» или «Рабочий» и «Тестовый». Переключайтесь между ними одной кнопкой — настройки приложения заменятся на настройки профиля.</div>
  <div class=box style="margin-bottom:16px"><div class=split><div><h3>Сейчас используется</h3><small class=muted>текущие настройки приложения</small></div>${adm ? `<button class=btn onclick="profSnapshot(${id})">💾 Сохранить как профиль</button>` : ''}</div><div class=profrows style="margin-top:10px"><div><small>Команда запуска</small><code>${esc(a.command)}</code></div><div><small>Среда выполнения</small><span>${esc(profRtName(a.runtime_path))}</span></div><div><small>Переменные окружения</small><span>${envCount(a.env_json) ? envCount(a.env_json) + ' шт.' : 'нет'}</span></div></div></div>
  <div class=sectionhead><h3>Сохранённые профили</h3>${adm ? `<button class=primary onclick="profForm(${id})">+ Новый профиль</button>` : ''}</div>
  <div class=list>${cards || empty('Профилей нет. Нажмите «Сохранить как профиль», чтобы запомнить текущие настройки.')}</div>`;
}
function profSnapshot(id) {
  modal('Сохранить текущие настройки', `<div class=form><label>Название профиля<input id=pfname placeholder="Например, Java 21 — основной"></label><label>Заметка (необязательно)<input id=pfnote></label><button class=primary onclick="profSnapSave(${id})">Сохранить</button></div>`);
}
async function profSnapSave(id) {
  try {
    await api(`/apps/${id}/profiles`, { method: 'POST', headers: JH, body: JSON.stringify({ from_current: true, name: $('pfname').value, note: $('pfnote').value }) });
    closeModal();
    appWorkspace(id, 'profiles');
  }
  catch (e) {
    alert(e.message);
  }
}
function profEnvRow(k = '', v = '') {
  return `<div class=envrow><input class=pek placeholder="ИМЯ" value="${esc(k)}"><input class=pev placeholder="значение" value="${esc(v)}"><button type=button class="btn bad" onclick="this.parentNode.remove()">×</button></div>`;
}
async function profForm(appId, pid) {
  let p = { name: '', note: '', command: '', runtime_path: '', env_json: '{}' };
  if (pid) {
    p = (await api(`/apps/${appId}/profiles`)).find(x => x.id === pid) || p;
  }
  else {
    const a = await api('/apps/' + appId);
    p.command = a.command;
    p.runtime_path = a.runtime_path || '';
    p.env_json = a.env_json || '{}';
  }
  if (!profRt.length)
    profRt = await api('/runtimes').catch(() => []);
  let env = {};
  try {
    env = JSON.parse(p.env_json || '{}');
  }
  catch {
  }
  const known = !p.runtime_path || profRt.some(r => r.path === p.runtime_path);
  modal(pid ? 'Изменить профиль' : 'Новый профиль', `<div class=form>
  <label>Название<input id=pfname value="${esc(p.name)}" placeholder="Например, Java 17"></label>
  <label>Заметка (необязательно)<input id=pfnote value="${esc(p.note || '')}" placeholder="Для чего этот профиль"></label>
  <label>Команда запуска<input id=pfcmd value="${esc(p.command)}"></label><small class=muted style="margin-top:-6px">Это команда, которой запускается проект, например <code>java -Xmx4G -jar server.jar nogui</code>. Новый профиль уже заполнен текущей командой приложения.</small>
  <label>Среда выполнения<select id=pfrt onchange="$('pfrtc').classList.toggle('hidden',this.value!=='__c')"><option value="">По умолчанию (из PATH)</option>${profRt.map(r => `<option value="${esc(r.path)}" ${r.path === p.runtime_path ? 'selected' : ''}>${esc(r.label)}${r.major ? ' ' + r.major : ''} — ${esc(r.version || '')}</option>`).join('')}<option value="__c" ${known ? '' : 'selected'}>Свой путь…</option></select></label>
  <input id=pfrtc class="${known ? 'hidden' : ''}" value="${known ? '' : esc(p.runtime_path)}" placeholder="Путь к папке с java / node">
  <div><small class=muted>Переменные окружения</small><div id=pfenv style="margin-top:6px">${Object.entries(env).map(([k, v]) => profEnvRow(k, v)).join('')}</div><button type=button class=btn onclick="$('pfenv').insertAdjacentHTML('beforeend',profEnvRow())">+ Переменная</button></div>
  <button class=primary onclick="profSave(${appId},${pid || 0})">Сохранить</button></div>`);
}
async function profSave(appId, pid) {
  const env = {};
  document.querySelectorAll('#pfenv .envrow').forEach(r => {
    const k = r.querySelector('.pek').value.trim();
    if (k)
      env[k] = r.querySelector('.pev').value;
  });
  let rt = $('pfrt').value;
  if (rt === '__c')
    rt = $('pfrtc').value.trim();
  const b = { name: $('pfname').value, note: $('pfnote').value, command: $('pfcmd').value, runtime_path: rt, env };
  try {
    await api(pid ? '/profiles/' + pid : `/apps/${appId}/profiles`, { method: pid ? 'PUT' : 'POST', headers: JH, body: JSON.stringify(b) });
    closeModal();
    appWorkspace(appId, 'profiles');
  }
  catch (e) {
    alert(e.message);
  }
}
async function profCopy(appId, pid) {
  const p = (await api(`/apps/${appId}/profiles`)).find(x => x.id === pid);
  if (!p)
    return;
  let env = {};
  try {
    env = JSON.parse(p.env_json || '{}');
  }
  catch {
  }
  try {
    await api(`/apps/${appId}/profiles`, { method: 'POST', headers: JH, body: JSON.stringify({ name: p.name + ' (копия)', note: p.note, command: p.command, runtime_path: p.runtime_path, env }) });
    appWorkspace(appId, 'profiles');
  }
  catch (e) {
    alert(e.message);
  }
}
async function profApply(appId, pid, restart) {
  if (restart && !confirm('Приложение будет остановлено, настройки заменены на настройки профиля, затем оно запустится снова. Продолжить?'))
    return;
  try {
    await api(`/apps/${appId}/profiles/${pid}/apply`, { method: 'POST', headers: JH, body: JSON.stringify({ restart }) });
    toast(restart ? 'Профиль применён, приложение перезапущено' : 'Профиль применён');
    appWorkspace(appId, 'profiles');
  }
  catch (e) {
    alert(e.message);
  }
}
async function profDelete(appId, pid) {
  if (confirm('Удалить профиль? Настройки приложения не изменятся.')) {
    try {
      await api('/profiles/' + pid, { method: 'DELETE' });
      appWorkspace(appId, 'profiles');
    }
    catch (e) {
      alert(e.message);
    }
  }
}

/* ---------- рабочее пространство проекта ---------- */
let wsTab = 'overview';
async function appWorkspace(id, tab = 'overview') {
  activeAppId = id;
  wsTab = tab;
  clearInterval(statsTimer);
  clearInterval(lgTimer);
  let a;
  try {
    a = await api('/apps/' + id);
  }
  catch (e) {
    $('content').innerHTML = `<div class=empty>${esc(e.message)}<br><br><button class=btn onclick="page('apps')">← Приложения</button></div>`;
    return;
  }
  $('title').textContent = a.name;
  $('sub').textContent = `${a.type || 'auto'} · ${a.working_dir}`;
  const op = can('apps.control') || can('apps.restart'), adm = can('apps.edit');
  const nav = `<div class=toolbar><button class=btn onclick="page('apps')">← Приложения</button>${op ? `<button class=primary onclick="act(${id},'start')" ${a.running ? 'disabled' : ''}>Запуск</button><button class=btn onclick="act(${id},'restart')">↻ Перезапуск</button><button class=btn onclick="act(${id},'stop')" ${!a.running ? 'disabled' : ''}>Стоп</button>` : ''}</div>`;
  const T = [['overview', 'Обзор', 1], ['console', 'Консоль', can('logs.view')], ['files', 'Файлы', can('files.view')], ['profiles', 'Профили', op], ['backups', 'Backup', can('backups.view')], ['logs', 'Логи', can('logs.view')], ['settings', 'Настройки', adm]].filter(t => t[2]);
  if (!T.some(t => t[0] === tab)) {
    tab = wsTab = 'overview';
    updateRoute('app:' + id, { tab }); // вкладка недоступна — подменяем адрес без новой записи в истории
  }
  const tabs = `<div class=tabbar>${T.map(t => `<button class="tab ${tab === t[0] ? 'active' : ''}" onclick="page('app:${id}',{tab:'${t[0]}'})">${t[1]}</button>`).join('')}</div>`;
  let body = '', after = null;
  try {
    if (tab === 'overview') {
      const s = await api(`/apps/${id}/stats`);
      body = `<div class=stats><div class=stat><small>Статус</small><b>${a.running ? '🟢 Запущено' : '⚪ Остановлено'}</b></div><div class=stat><small>CPU</small><b id=dcpu>${s.cpu.toFixed(1)}%</b></div><div class=stat><small>RAM</small><b id=dram>${fmtSize(s.memory)}</b></div><div class=stat><small>Uptime</small><b>${fmtTime(a.uptime)}</b></div></div><div class=box><div class=two><div><small>Команда</small><code>${esc(a.command)}</code></div><div><small>Рабочая папка</small><code>${esc(a.working_dir)}</code></div></div><p><b>Runtime:</b> ${esc(a.runtime || 'авто')} ${a.runtime_path ? `<code>${esc(a.runtime_path)}</code>` : ''}</p><p><b>Порт:</b> ${a.port || 'не указан'} · <b>Автозапуск:</b> ${a.auto_start ? 'да' : 'нет'} · <b>Автоперезапуск:</b> ${a.auto_restart ? 'да' : 'нет'}</p></div><canvas id=chart width=1000 height=220 class=chart></canvas>`;
      after = () => setTimeout(() => workspaceStats(id), 0);
    }
    else if (tab === 'console') {
      const out = await api(`/apps/${id}/output`);
      body = `<div class=console><div id=detailOut class=out>${out.map(x => esc(x.data)).join('')}</div>${op ? `<div class=cin><input id=detailCmd placeholder="Команда для stdin" onkeydown="if(event.key==='Enter')sendDetail(${id})"><button onclick="sendDetail(${id})">SEND</button></div>` : ''}</div>`;
      after = () => {
        const o = $('detailOut');
        if (o)
          o.scrollTop = o.scrollHeight;
      };
    }
    else if (tab === 'files') {
      body = '<div id=fmhost></div>';
      after = () => {
        mountFileManager('fmhost', { scope: { app: id }, rootLabel: a.name, path: (routeParams && routeParams.path) || '', routed: true, routeName: 'app:' + id });
      };
    }
    else if (tab === 'profiles')
      body = await profTab(id, a);
    else if (tab === 'backups')
      body = await bkTab(id, a);
    else if (tab === 'logs') {
      body = lgTab(id);
      after = () => {
        lgLoad(id);
        lgAuto(id);
      };
    }
    else {
      body = appForm(a) + `<div class=actions style="margin-top:16px"><button class=btn onclick="page('app:${id}',{tab:'backups'})">Backup…</button><button class="btn bad" onclick="deleteApp(${id})">Удалить приложение</button></div>`;
      after = () => lbMount(a);
    }
  }
  catch (e) {
    body = `<div class=empty>${esc(e.message)}</div>`;
  }
  $('content').innerHTML = nav + tabs + body;
  if (after)
    after();
}
