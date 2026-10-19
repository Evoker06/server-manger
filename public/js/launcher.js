/* M6 — конструктор запуска: пресеты, память Java, аргументы, ENV, Runtime, порт, автоперезапуск, зависимости */
let LB = null, lbTimer = null;
const lbGB = mb => mb >= 1024 ? (+(mb / 1024).toFixed(1)) + ' ГБ' : mb + ' МБ';
const lbJSON = o => JSON.parse(JSON.stringify(o));
const lbHdr = { 'Content-Type': 'application/json' };
function appForm() {
  return '<div id=lb></div>';
}
function newApp() {
  modal('Новое приложение', `<div class=grid>
  <div class=card><h3>Импорт папки</h3><p class=muted>Мастер сканирует папку и предлагает найденные способы запуска.</p><button class=btn onclick="closeModal();importWizard()">Открыть мастер</button></div>
  <div class=card><h3>Конструктор запуска</h3><p class=muted>Пресеты, память Java, аргументы, ENV, Runtime, порт, автоперезапуск, зависимости.</p><button class=primary onclick="lbOpenModal()">Открыть конструктор</button></div></div>`);
}
function lbOpenModal() {
  modal('Конструктор запуска', '<div id=lb></div>');
  lbMount({});
}
async function lbMount(a) {
  const el = $('lb');
  if (!el)
    return;
  el.innerHTML = '<div class=muted>Загрузка конструктора…</div>';
  try {
    const [presets, rts, sys, apps] = await Promise.all([api('/launch/presets'), api('/runtimes'), api('/system'), api('/apps')]);
    LB = lbInitState(a, presets, rts, sys, apps);
    lbRender();
    if (LB.working_dir)
      lbInspect();
  }
  catch (e) {
    el.innerHTML = `<div class=hint>Ошибка загрузки конструктора: ${esc(e.message)}</div>`;
  }
}
function lbInitState(a, presets, rts, sys, apps) {
  let launch = null, env = {}, deps = [];
  try {
    launch = a.launch_json ? JSON.parse(a.launch_json) : null;
  }
  catch {
  }
  try {
    env = typeof a.env_json === 'string' ? JSON.parse(a.env_json || '{}') : (a.env || {});
  }
  catch {
  }
  try {
    deps = JSON.parse(a.depends_on || '[]');
  }
  catch {
  }
  const preset = launch?.preset || 'custom', st = a.stop_command || '';
  const s = { id: a.id || 0, running: !!a.running, presets, rts, sys, apps: apps.filter(x => x.id !== a.id), info: null, browse: null,
    name: a.name || '', working_dir: a.working_dir || '', type: a.type || 'auto', preset, launch: launch || { preset: 'custom' }, command: a.command || '',
    runtime: a.runtime || '', runtime_path: a.runtime_path || '', env: Object.entries(env).map(([k, v]) => ({ k, v: String(v) })), port: a.port || '',
    stopMode: st.startsWith('stdin:') ? 'stdin' : st ? 'cmd' : 'signal', stopValue: st.startsWith('stdin:') ? st.slice(6) : st,
    auto_start: !!a.auto_start, auto_restart: a.id ? !!a.auto_restart : false, restart_delay: a.restart_delay ?? 5, max_restarts: a.max_restarts ?? 5,
    ready_delay: a.ready_delay || 0, depends_on: deps, same: true, cmdPreview: a.command || '' };
  if (launch?.java)
    s.same = launch.java.xms === launch.java.xmx;
  return s;
}
const lbPresetObj = () => LB.presets.find(p => p.id === LB.preset) || LB.presets.find(p => p.id === 'custom');
function lbIn(p, v) {
  const k = p.split('.');
  let o = LB;
  for (let i = 0; i < k.length - 1; i++)
    o = o[k[i]];
  o[k[k.length - 1]] = v;
  lbPrevSoon();
}
/* ---------- файлы проекта ---------- */
function lbFileList() {
  const f = LB.info?.files;
  if (!f)
    return [];
  return ({ minecraft: f.jar, node: f.js, python: f.py, dotnet: f.dll, exe: f.exe }[LB.preset]) || [];
}
async function lbWd(v) {
  LB.working_dir = v.trim();
  await lbInspect();
}
async function lbInspect() {
  LB.infoErr = '';
  if (!LB.working_dir) {
    LB.info = null;
    return lbRender();
  }
  try {
    LB.info = await api('/launch/inspect?cwd=' + encodeURIComponent(LB.working_dir));
  }
  catch (e) {
    LB.info = null;
    LB.infoErr = e.message;
  }
  if (LB.info) {
    if (!LB.name)
      LB.name = basename(LB.working_dir);
    if (LB.preset !== 'custom' && !LB.launch.target) {
      const f = lbFileList();
      if (f.length === 1)
        LB.launch.target = f[0];
    }
    if (LB.preset === 'node' && LB.launch.mode === 'npm' && LB.info.scripts.length && !LB.info.scripts.some(s => s.name === LB.launch.script))
      LB.launch.script = LB.info.scripts[0].name;
  }
  lbRender();
}
/* ---------- пресеты ---------- */
function lbApplyPreset(id) {
  const p = LB.presets.find(x => x.id === id), d = p.defaults, old = LB.launch;
  if (LB.preset !== 'custom' && id === 'custom')
    LB.command = LB.cmdPreview || LB.command;
  LB.preset = id;
  LB.type = p.type === 'auto' ? (LB.type || 'auto') : p.type;
  LB.launch = lbJSON(d.launch);
  if (old.preset === id && old.target)
    LB.launch.target = old.target;
  if (id !== 'custom' && !LB.launch.target) {
    const f = lbFileList();
    if (f.length)
      LB.launch.target = f[0];
  }
  if (id === 'node' && LB.info?.scripts?.length) {
    LB.launch.script = LB.info.scripts.some(s => s.name === 'start') ? 'start' : LB.info.scripts[0].name;
  }
  if (id === 'node' && LB.info && !LB.info.scripts.length) {
    LB.launch.mode = 'file';
  }
  if (id === 'minecraft') {
    const mb = Math.max(1024, Math.min(4096, Math.floor(LB.sys.memTotal / 1048576 * 0.5 / 256) * 256));
    LB.launch.java.xmx = LB.launch.java.xms = mb;
    LB.same = true;
  }
  if (!LB.port && d.port)
    LB.port = id === 'minecraft' && LB.info?.minecraft?.port ? LB.info.minecraft.port : d.port;
  const sc = d.stop_command || '';
  LB.stopMode = sc.startsWith('stdin:') ? 'stdin' : sc ? 'cmd' : 'signal';
  LB.stopValue = sc.startsWith('stdin:') ? sc.slice(6) : sc;
  if (!LB.id) {
    LB.auto_restart = d.auto_restart;
    LB.restart_delay = d.restart_delay;
    LB.max_restarts = d.max_restarts;
  }
  for (const [k, v] of Object.entries(d.env || {}))
    if (!LB.env.some(e => e.k === k))
      LB.env.push({ k, v });
  const keys = p.runtime;
  if (LB.runtime && !keys.includes(LB.runtime)) {
    LB.runtime = '';
    LB.runtime_path = '';
  }
  lbRender();
}
/* ---------- отрисовка ---------- */
function lbRender() {
  const el = $('lb');
  if (!el || !LB)
    return;
  const p = lbPresetObj();
  el.innerHTML = `<div class=lb>
  ${LB.running ? '<div class=hint style="border-color:#7a5a1e;color:#e8c27a">Приложение запущено — чтобы сохранить изменения, сначала остановите его.</div>' : ''}
  ${lbBasics()}${lbPresets(p)}${p.id === 'custom' ? lbCustom() : lbBuilder(p)}${lbRuntime(p)}${lbEnv()}${lbPortBox(p)}${lbLife()}${lbDeps()}
  <div class=box><h3>Итоговая команда</h3>${p.id === 'custom' ? '' : `<code id=lbCmd class=cmdprev>—</code><small id=lbCmdErr class=err></small>`}
    <div class=muted style="margin-top:8px">Папка запуска: <code>${esc(LB.working_dir || '—')}</code></div></div>
  <div class=actions><button class=primary onclick=lbSave()>Сохранить</button></div></div>`;
  lbPreview();
  lbMemInfo();
}
function lbBasics() {
  const b = LB.browse;
  return `<div class=box><h3>Основное</h3><div class=form>
  <label>Название<input value="${esc(LB.name)}" oninput="LB.name=this.value" placeholder="Например: Survival-сервер"></label>
  <label>Рабочая папка<div class=inline><input value="${esc(LB.working_dir)}" onchange="lbWd(this.value)" placeholder="C:\\Servers\\MyServer или /opt/myserver"><button type=button class=btn onclick=lbBrowse()>Обзор…</button></div></label>
  ${LB.infoErr ? `<small class=err>${esc(LB.infoErr)}</small>` : ''}
  ${b ? `<div class=browser><div class=split><code>${esc(b.cur || '/')}</code><button type=button class=btn onclick=lbBrowseUp()>Вверх</button></div>
    ${(b.items || []).map(x => `<button type=button class=item onclick="lbBrowseGo(${jsArg(x.path)})">📁 ${esc(x.name)}</button>`).join('') || '<div class=muted>Нет вложенных папок</div>'}
    <div class=actions><button type=button class=primary onclick="lbBrowsePick(${jsArg(b.cur)})" ${b.cur ? '' : 'disabled'}>Выбрать эту папку</button><button type=button class=btn onclick="LB.browse=null;lbRender()">Отмена</button></div></div>` : ''}
  </div></div>`;
}
async function lbBrowse() {
  LB.browse = { cur: LB.working_dir || '', items: [] };
  await lbBrowseLoad();
}
async function lbBrowseLoad() {
  try {
    LB.browse.items = await api('/browse?path=' + encodeURIComponent(LB.browse.cur));
  }
  catch (e) {
    LB.browse.items = [];
  }
  lbRender();
}
function lbBrowseGo(p) {
  LB.browse.cur = p;
  lbBrowseLoad();
}
function lbBrowseUp() {
  let c = LB.browse.cur;
  const sep = c.includes('\\') ? '\\' : '/';
  c = c.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join(sep);
  if (/^[A-Za-z]:$/.test(c))
    c += '\\';
  LB.browse.cur = c;
  lbBrowseLoad();
}
function lbBrowsePick(p) {
  LB.working_dir = p;
  LB.browse = null;
  lbInspect();
}
function lbPresets(p) {
  const sug = LB.info?.suggest;
  return `<div class=box><h3>Пресет</h3><div class=presets>${LB.presets.map(x => `<button type=button class="preset ${x.id === LB.preset ? 'active' : ''}" onclick="lbApplyPreset('${x.id}')"><span class=pi>${x.icon}</span><b>${esc(x.label)}</b>${x.id === sug && x.id !== LB.preset ? '<em>подходит</em>' : ''}</button>`).join('')}</div>
  <div class=hint style="margin-top:10px">${esc(p.hint)}</div></div>`;
}
const lbOpt = (v, t, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(t)}</option>`;
function lbFileInput(label, val, path, ph) {
  const files = lbFileList();
  return `<label>${label}<input list=lbFiles value="${esc(val)}" oninput="lbIn('${path}',this.value)" placeholder="${esc(ph)}"></label><datalist id=lbFiles>${files.map(f => `<option value="${esc(f)}">`).join('')}</datalist>${LB.info && !files.length ? '<small class=muted>В папке подходящих файлов не найдено — можно ввести путь вручную.</small>' : ''}`;
}
function lbCustom() {
  return `<div class=box><h3>Команда запуска</h3><label>Команда<textarea rows=3 oninput="LB.command=this.value" placeholder='npm start  ·  "start.bat"  ·  java -jar server.jar'>${esc(LB.command)}</textarea></label>
  <small class=muted>Выберите пресет выше, чтобы собрать команду визуально.</small></div>`;
}
function lbBuilder(p) {
  const L = LB.launch;
  let h = '';
  if (p.id === 'minecraft') {
    const j = L.java, mc = LB.info?.minecraft;
    h = `${lbFileInput('JAR-файл сервера', L.target, 'launch.target', 'server.jar')}
    <div class=memblock><div class=split><b>Память Java (-Xmx): <span id=lbXmxL></span></b><span class=muted>ОЗУ компьютера: ${lbGB(Math.round(LB.sys.memTotal / 1048576))}</span></div>
    <input type=range id=lbXmx min=512 max=${lbMemMax()} step=256 value=${j.xmx} oninput="lbMem('xmx',+this.value)">
    <div class=inline>${[1, 2, 4, 6, 8, 12, 16, 24, 32].filter(g => g * 1024 <= lbMemMax()).map(g => `<button type=button class=btn onclick="lbMem('xmx',${g * 1024})">${g} ГБ</button>`).join('')}</div>
    <label class=checkline><input type=checkbox ${LB.same ? 'checked' : ''} onchange="lbSame(this.checked)"> Xms = Xmx — резервировать память сразу (рекомендуется для серверов)</label>
    <div id=lbXmsRow class="${LB.same ? 'hidden' : ''}"><b>Начальная память (-Xms): <span id=lbXmsL></span></b><input type=range id=lbXms min=256 max=${j.xmx} step=256 value=${j.xms} oninput="lbMem('xms',+this.value)"></div>
    <div id=lbMemWarn class="hint hidden"></div></div>
    <div class=two><label>Сборщик мусора (GC)<select onchange="lbIn('launch.java.gc',this.value)">${lbOpt('aikar', 'Aikar flags (оптимально для Minecraft)', j.gc)}${lbOpt('g1', 'G1GC', j.gc)}${lbOpt('zgc', 'ZGC', j.gc)}${lbOpt('none', 'Не задавать', j.gc)}</select></label>
    <label>Доп. JVM-аргументы<input value="${esc(j.jvmArgs)}" oninput="lbIn('launch.java.jvmArgs',this.value)" placeholder="-Dfile.encoding=UTF-8"></label></div>
    <div class=two><label>Аргументы сервера<input value="${esc(L.args)}" oninput="lbIn('launch.args',this.value)" placeholder="--world MyWorld"></label>
    <div class=checks style="align-self:end"><label><input type=checkbox ${j.nogui ? 'checked' : ''} onchange="lbIn('launch.java.nogui',this.checked)"> nogui (без окна)</label></div></div>
    ${mc && mc.eula === false ? '<div class=hint style="border-color:#7a5a1e;color:#e8c27a">В eula.txt указано <code>eula=false</code> — сервер завершится сразу после запуска. Поменяйте на <code>eula=true</code> в файловом менеджере, приняв условия Mojang.</div>' : ''}`;
  }
  else if (p.id === 'node') {
    const scripts = LB.info?.scripts || [];
    h = `<div class=two><label>Способ запуска<select onchange="lbIn('launch.mode',this.value);lbRender()">${lbOpt('npm', 'npm-скрипт из package.json', L.mode)}${lbOpt('file', 'JS-файл напрямую (node файл.js)', L.mode)}</select></label>
    ${L.mode === 'npm' ? `<label>Скрипт<input list=lbScripts value="${esc(L.script)}" oninput="lbIn('launch.script',this.value)"><datalist id=lbScripts>${scripts.map(s => `<option value="${esc(s.name)}">${esc(s.cmd)}</option>`).join('')}</datalist></label>` : lbFileInput('JS-файл', L.target, 'launch.target', 'index.js')}</div>
    <div class=two><label>Лимит памяти Node, МБ (0 — по умолчанию)<input type=number min=0 step=128 value=${L.node.maxOld} oninput="lbIn('launch.node.maxOld',+this.value)"></label>
    <label>Доп. аргументы Node<input value="${esc(L.node.nodeArgs)}" oninput="lbIn('launch.node.nodeArgs',this.value)" placeholder="--inspect"></label></div>
    <label>Аргументы приложения<input value="${esc(L.args)}" oninput="lbIn('launch.args',this.value)"></label>`;
  }
  else if (p.id === 'python') {
    h = `${lbFileInput('Python-файл', L.target, 'launch.target', 'main.py')}
    <div class=two><label>Интерпретатор<select onchange="lbIn('launch.python.interpreter',this.value)">${['python', 'python3', 'py'].map(x => lbOpt(x, x, L.python.interpreter)).join('')}</select></label>
    <label>Аргументы<input value="${esc(L.args)}" oninput="lbIn('launch.args',this.value)"></label></div>
    <div class=checks><label><input type=checkbox ${L.python.unbuffered ? 'checked' : ''} onchange="lbIn('launch.python.unbuffered',this.checked)"> -u (логи без буферизации)</label>
    <label><input type=checkbox ${L.python.installReqs ? 'checked' : ''} onchange="lbIn('launch.python.installReqs',this.checked)"> pip install -r requirements.txt перед запуском</label></div>`;
  }
  else if (p.id === 'dotnet') {
    h = `${lbFileInput('DLL-файл сборки', L.target, 'launch.target', 'MyApp.dll')}<label>Аргументы<input value="${esc(L.args)}" oninput="lbIn('launch.args',this.value)"></label>`;
  }
  else {
    h = `${lbFileInput('Исполняемый файл или скрипт', L.target, 'launch.target', 'server.exe')}<label>Аргументы<input value="${esc(L.args)}" oninput="lbIn('launch.args',this.value)"></label>`;
  }
  return `<div class=box><h3>${p.icon} Параметры запуска</h3><div class=form>${h}</div></div>`;
}
/* ---------- память ---------- */
const lbMemMax = () => Math.max(2048, Math.floor(LB.sys.memTotal / 1048576 * 0.9 / 256) * 256, LB.launch.java?.xmx || 0);
function lbMem(k, v) {
  const j = LB.launch.java;
  if (k === 'xmx') {
    j.xmx = v;
    if (LB.same || j.xms > v)
      j.xms = v;
  }
  else
    j.xms = Math.min(v, j.xmx);
  lbMemInfo();
  lbPrevSoon();
}
function lbSame(on) {
  LB.same = on;
  if (on)
    LB.launch.java.xms = LB.launch.java.xmx;
  lbRender();
}
function lbMemInfo() {
  const j = LB.launch?.java;
  if (!j || !$('lbXmx'))
    return;
  $('lbXmx').value = j.xmx;
  $('lbXmxL').textContent = lbGB(j.xmx);
  if ($('lbXms')) {
    $('lbXms').max = j.xmx;
    $('lbXms').value = j.xms;
    $('lbXmsL').textContent = lbGB(j.xms);
  }
  const tot = LB.sys.memTotal / 1048576, pct = Math.round(j.xmx / tot * 100), w = $('lbMemWarn');
  if (pct > 80) {
    w.className = 'hint';
    w.textContent = `Xmx занимает ${pct}% оперативной памяти компьютера — системе и другим приложениям может не хватить памяти (у Java сверх кучи есть ещё служебная память).`;
  }
  else
    w.className = 'hint hidden';
}
/* ---------- Runtime ---------- */
function lbRuntime(p) {
  const keys = p.runtime;
  if (!keys.length)
    return '';
  const list = LB.rts.filter(r => keys.includes(r.key)), cur = LB.runtime_path;
  const lab = r => `${r.label}${r.major ? ' ' + r.major : ''} — ${r.version.replace(/^openjdk version /, '')} · ${r.path}${r.isDefault ? ' (по умолчанию в PATH)' : ''}`;
  const known = list.some(r => r.path === cur);
  let note = '';
  if (p.id === 'minecraft') {
    const sel = list.find(r => r.path === cur) || list.find(r => r.isDefault && r.key === 'java'), maj = sel?.major;
    if (!list.length)
      note = 'Java не найдена на этом компьютере. Установите JDK (для 1.20.5+ — Java 21) или укажите путь вручную.';
    else if (maj && maj < 17)
      note = `Выбрана Java ${maj}: современные версии Minecraft (1.18+) требуют Java 17+, а 1.20.5+ — Java 21.`;
  }
  else if (!list.length)
    note = `${p.label}: подходящий Runtime не найден — установите его или укажите путь вручную.`;
  return `<div class=box><h3>Runtime</h3><div class=form>
  <label>Найденные версии<select onchange="lbRuntimeSel(this.value)">${lbOpt('', 'Авто — использовать из PATH', cur)}${list.map(r => lbOpt(r.path, lab(r), cur)).join('')}${cur && !known ? lbOpt(cur, 'Сохранённый: ' + cur, cur) : ''}</select></label>
  <label>Или путь вручную (файл или папка с runtime)<input value="${esc(cur)}" oninput="lbRuntimeManual(this.value)" placeholder="Необязательно"></label>
  ${note ? `<div class=hint style="border-color:#7a5a1e;color:#e8c27a">${esc(note)}</div>` : ''}
  <small class=muted>Выбранная папка добавляется в начало PATH процесса${p.id === 'minecraft' ? ', а также выставляется JAVA_HOME' : ''}.</small></div></div>`;
}
function lbRuntimeSel(path) {
  const r = LB.rts.find(x => x.path === path);
  LB.runtime_path = path;
  LB.runtime = r ? r.key : '';
  lbRender();
}
function lbRuntimeManual(v) {
  LB.runtime_path = v.trim();
  const r = LB.rts.find(x => x.path === LB.runtime_path);
  LB.runtime = r ? r.key : (LB.runtime_path ? (lbPresetObj().runtime[0] || '') : '');
}
/* ---------- ENV ---------- */
function lbEnv() {
  const auto = [];
  if (LB.port) {
    if (LB.preset === 'dotnet')
      auto.push(`ASPNETCORE_URLS=http://0.0.0.0:${LB.port}`);
    else if (LB.preset !== 'minecraft')
      auto.push(`PORT=${LB.port}`);
  }
  return `<div class=box><h3>Переменные окружения (ENV)</h3>
  ${LB.env.map((e, i) => `<div class=envrow><input value="${esc(e.k)}" placeholder="NAME" oninput="LB.env[${i}].k=this.value"><input value="${esc(e.v)}" placeholder="значение" oninput="LB.env[${i}].v=this.value"><button type=button class="btn bad" onclick="lbEnvDel(${i})">×</button></div>`).join('') || '<div class=muted style="margin-bottom:8px">Переменных нет.</div>'}
  <div class=actions><button type=button class=btn onclick=lbEnvAdd()>+ Переменная</button><button type=button class=btn onclick=lbEnvDotenv() ${LB.info?.dotenv ? '' : 'disabled title="В папке нет файла .env"'}>Импорт из .env</button></div>
  ${auto.length ? `<small class=muted>Автоматически добавляется менеджером: <code>${esc(auto.join('  '))}</code> (вашу переменную с тем же именем он не перезаписывает).</small>` : ''}</div>`;
}
function lbEnvAdd() {
  LB.env.push({ k: '', v: '' });
  lbRender();
}
function lbEnvDel(i) {
  LB.env.splice(i, 1);
  lbRender();
}
function lbEnvDotenv() {
  for (const [k, v] of Object.entries(LB.info?.dotenv || {})) {
    const e = LB.env.find(x => x.k === k);
    if (e)
      e.v = v;
    else
      LB.env.push({ k, v });
  }
  lbRender();
}
/* ---------- порт ---------- */
function lbPortBox(p) {
  const mc = LB.info?.minecraft;
  return `<div class=box><h3>Порт</h3><div class=inline><input type=number min=1 max=65535 value="${esc(LB.port)}" oninput="lbIn('port',this.value)" placeholder="не задан">
  <button type=button class=btn onclick=lbPortCheck()>Проверить порт</button>
  ${p.id === 'minecraft' && mc?.port ? `<button type=button class=btn onclick="LB.port=${mc.port};lbRender()">Из server.properties: ${mc.port}</button>` : ''}</div>
  <div id=lbPortMsg class=muted style="margin-top:8px"></div>
  ${p.id === 'minecraft' ? '<small class=muted>Порт передаётся серверу аргументом <code>--port</code>.</small>' : ''}</div>`;
}
async function lbPortCheck() {
  const m = $('lbPortMsg');
  if (!LB.port) {
    m.textContent = 'Порт не задан';
    return;
  }
  try {
    const d = await api(`/port-check?port=${encodeURIComponent(LB.port)}&exclude=${LB.id}`);
    let t = d.self ? 'Порт используется этим приложением (оно сейчас запущено).' : d.free ? '✓ Порт свободен.' : '✗ Порт занят другим процессом на этом компьютере.';
    if (d.others.length)
      t += ` Этот порт также указан у: ${d.others.map(x => x.name).join(', ')}.`;
    m.textContent = t;
  }
  catch (e) {
    m.textContent = e.message;
  }
}
/* ---------- остановка, автозапуск, автоперезапуск ---------- */
function lbLife() {
  return `<div class=box><h3>Остановка и перезапуск</h3><div class=form>
  <div class=two><label>Способ остановки<select onchange="lbStopMode(this.value)">${lbOpt('signal', 'Сигнал завершения процесса', LB.stopMode)}${lbOpt('stdin', 'Команда в консоль приложения (stdin)', LB.stopMode)}${lbOpt('cmd', 'Отдельная команда оболочки', LB.stopMode)}</select></label>
    <label class="${LB.stopMode === 'signal' ? 'hidden' : ''}">${LB.stopMode === 'stdin' ? 'Команда (например, stop)' : 'Команда остановки'}<input value="${esc(LB.stopValue)}" oninput="LB.stopValue=this.value"></label></div>
  <small class=muted>Если приложение не завершилось за 60 секунд после остановки, оно будет завершено принудительно.</small>
  <div class=checks><label><input type=checkbox ${LB.auto_start ? 'checked' : ''} onchange="LB.auto_start=this.checked"> Запускать вместе с менеджером</label>
    <label><input type=checkbox ${LB.auto_restart ? 'checked' : ''} onchange="LB.auto_restart=this.checked"> Автоперезапуск при падении</label></div>
  <div class=two><label>Задержка перед перезапуском, сек<input type=number min=0 value=${LB.restart_delay} oninput="LB.restart_delay=this.value"></label>
    <label>Макс. автоперезапусков подряд<input type=number min=0 value=${LB.max_restarts} oninput="LB.max_restarts=this.value"></label></div></div></div>`;
}
function lbStopMode(m) {
  LB.stopMode = m;
  if (m === 'stdin' && !LB.stopValue)
    LB.stopValue = 'stop';
  if (m === 'signal')
    LB.stopValue = '';
  lbRender();
}
/* ---------- зависимости ---------- */
function lbOrder() {
  const by = new Map(LB.apps.map(a => [a.id, a])), seen = new Set(), out = [];
  const visit = id => {
    if (seen.has(id))
      return;
    seen.add(id);
    const a = by.get(id);
    if (!a)
      return;
    let ds = [];
    try {
      ds = JSON.parse(a.depends_on || '[]');
    }
    catch {
    }
    ds.forEach(visit);
    out.push(a.name);
  };
  LB.depends_on.forEach(visit);
  return out;
}
const lbOrderHtml = () => {
  const o = lbOrder();
  return o.length ? `Порядок запуска: ${o.map(esc).join(' → ')} → <b>${esc(LB.name || 'это приложение')}</b>` : 'Зависимостей нет — приложение запускается самостоятельно.';
};
function lbDeps() {
  return `<div class=box><h3>Зависимости</h3>
  ${LB.apps.length ? `<div class=list>${LB.apps.map(x => `<label class=checkline><input type=checkbox ${LB.depends_on.includes(x.id) ? 'checked' : ''} onchange="lbDep(${x.id},this.checked)"> ${esc(x.name)} <small class=muted>${x.running ? '● запущено' : 'остановлено'}</small></label>`).join('')}</div>` : '<div class=muted>Других приложений пока нет.</div>'}
  <div id=lbOrder class=hint style="margin:10px 0">${lbOrderHtml()}</div>
  <label>Пауза после запуска ЭТОГО приложения, сек<input type=number min=0 value=${LB.ready_delay} oninput="LB.ready_delay=this.value"></label>
  <small class=muted>Перед запуском менеджер стартует выбранные приложения (если они ещё не работают) и ждёт их паузу — например, чтобы база данных успела подняться. При остановке зависимые приложения сами не останавливаются: менеджер только предупредит.</small></div>`;
}
function lbDep(id, on) {
  const s = new Set(LB.depends_on);
  on ? s.add(id) : s.delete(id);
  LB.depends_on = [...s];
  $('lbOrder').innerHTML = lbOrderHtml();
}
/* ---------- предпросмотр и сохранение ---------- */
function lbPrevSoon() {
  clearTimeout(lbTimer);
  lbTimer = setTimeout(lbPreview, 200);
}
async function lbPreview() {
  if (!LB || !$('lbCmd'))
    return;
  try {
    const d = await api('/launch/preview', { method: 'POST', headers: lbHdr, body: JSON.stringify({ launch: LB.launch, port: LB.port || null }) });
    LB.cmdPreview = d.command || '';
    if ($('lbCmd')) {
      $('lbCmd').textContent = d.command || '—';
      $('lbCmdErr').textContent = d.error || '';
    }
  }
  catch {
  }
}
async function lbSave() {
  const s = LB;
  if (!s.name.trim())
    return alert('Укажите название');
  if (!s.working_dir.trim())
    return alert('Укажите рабочую папку');
  const env = {};
  for (const { k, v } of s.env) {
    const key = k.trim();
    if (!key)
      continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      return alert('Недопустимое имя переменной: ' + key);
    env[key] = v;
  }
  const custom = s.preset === 'custom';
  if (custom && !s.command.trim())
    return alert('Введите команду запуска или выберите пресет');
  const body = { name: s.name.trim(), working_dir: s.working_dir.trim(), type: lbPresetObj().type === 'auto' ? s.type : lbPresetObj().type,
    launch: custom ? { preset: 'custom' } : s.launch, runtime: s.runtime, runtime_path: s.runtime_path, env, port: s.port ? +s.port : null,
    stop_command: s.stopMode === 'stdin' ? 'stdin:' + (s.stopValue || 'stop') : s.stopMode === 'cmd' ? s.stopValue : '',
    auto_start: s.auto_start, auto_restart: s.auto_restart, restart_delay: s.restart_delay, max_restarts: s.max_restarts, ready_delay: s.ready_delay, depends_on: s.depends_on };
  if (custom)
    body.command = s.command;
  try {
    const a = await api(s.id ? '/apps/' + s.id : '/apps', { method: s.id ? 'PUT' : 'POST', headers: lbHdr, body: JSON.stringify(body) });
    closeModal();
    if (s.id)
      appWorkspace(s.id, 'settings');
    else
      page('app:' + a.id);
  }
  catch (e) {
    alert(e.message);
  }
}
