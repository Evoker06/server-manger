let node=localStorage.sm_node||'local',nodeList=[],token=localStorage.sm_token||'',me=null,ws=null,currentPage='dash',pathNow='',appCache=[],statsTimer=null,activeAppId=null;
const $=id=>document.getElementById(id);
const apiPath=u=>'/api'+(node!=='local'&&!/^\/(login|me|password|nodes)(\/|\?|$)/.test(u)?'/n/'+encodeURIComponent(node):'')+u;
const basename=p=>String(p||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop();
document.addEventListener('submit',e=>e.preventDefault());
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.target.id==='u'||e.target.id==='p'))login()});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const jsArg=v=>esc(JSON.stringify(String(v??'')));
const fmtSize=n=>{n=+n||0;if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';if(n<1073741824)return (n/1048576).toFixed(1)+' MB';return (n/1073741824).toFixed(2)+' GB'};
const fmtTime=ms=>{let s=Math.floor((ms||0)/1000),h=Math.floor(s/3600);s%=3600;let m=Math.floor(s/60);s%=60;return `${h?String(h).padStart(2,'0')+':':''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`};
async function api(url,opt={}){opt.headers={...(opt.headers||{}),...(token?{Authorization:'Bearer '+token}:{})};const r=await fetch(apiPath(url),opt);const raw=await r.text();let d=raw;try{d=raw?JSON.parse(raw):''}catch{}if(r.status===401&&url!=='/login'&&token){localStorage.removeItem('sm_token');token='';location.reload();throw Error('Сессия истекла')}if(!r.ok){const e=Error((d&&d.error)||(typeof d==='string'&&d.trim().slice(0,200))||`HTTP ${r.status}`);e.status=r.status;e.data=d;throw e}return d}
async function login(){try{const d=await api('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('u').value,password:$('p').value})});token=d.token;localStorage.sm_token=token;me=d.user;show()}catch(e){$('err').textContent=e.message}}
async function show(){try{me=await api('/me');$('login').className='hidden';$('app').className='app';$('who').innerHTML=`${esc(me.username)}<br><small>${esc(me.role)}</small>`;await loadNodes();connectWS();page('dash')}catch{localStorage.removeItem('sm_token');token='';$('login').className='login';$('app').className='hidden'}}
function page(p){clearInterval(statsTimer);currentPage=p;if(String(p).startsWith('app:')){const id=Number(String(p).split(':')[1]);appWorkspace(id);return;}const names={dash:['Панель','Состояние всех процессов'],apps:['Приложения','Управление запущенными проектами'],files:['Файлы','Файловое хранилище Server Manager'],runtimes:['Runtime','Обнаруженные среды выполнения'],docker:['Docker','Контейнеры Docker'],tasks:['Задачи','Автоматизация по расписанию'],backups:['Резервные копии','Создание и восстановление архивов'],audit:['Журнал','История действий'],settings:['Настройки','Учётная запись и безопасность'],nodes:['Серверы','Подключённые компьютеры'],users:['Пользователи','Учётные записи и доступ'],system:['Система','Процессор, видеокарта, память и накопители']};$('title').textContent=names[p][0];$('sub').textContent=names[p][1];document.querySelectorAll('aside>button').forEach(b=>b.classList.toggle('active',b.getAttribute('onclick')?.includes(`'${p}'`)));if(p==='dash')dashboard();if(p==='apps')apps();if(p==='files')files();if(p==='runtimes')runtimes();if(p==='docker')docker();if(p==='tasks')tasks();if(p==='backups')backups();if(p==='audit')audit();if(p==='settings')settings();if(p==='nodes')nodesPage();if(p==='users')usersPage();if(p==='system')systemPage()}
async function refreshCurrent(){page(currentPage)}
function toolbar(html=''){return `<div class=toolbar>${html}</div>`}
async function dashboard(){clearInterval(statsTimer);appCache=await api('/apps');const running=appCache.filter(x=>x.running).length;const cpu=appCache.reduce((n,x)=>n+(x.running?1:0),0);$('content').innerHTML=`<div class=stats><div class=stat><small>Приложений</small><b>${appCache.length}</b></div><div class=stat><small>Запущено</small><b>${running}</b></div><div class=stat><small>Остановлено</small><b>${appCache.length-running}</b></div><div class=stat><small>Активных процессов</small><b>${cpu}</b></div></div><div class=sectionhead><h3>Процессы</h3><button class=btn onclick="page('apps')">Все приложения →</button></div><div id=cards class=grid>${appCache.slice(0,8).map(appCard).join('')||empty('Приложений пока нет')}</div>`;pollCards()}
function appCard(a){return `<div class=card><div class=split><div><h3>${esc(a.name)}</h3><small>${esc(a.type||'auto')}</small></div><span class="status ${a.running?'good':'muted'}"><i class="dot ${a.running?'on':''}"></i>${a.running?'Запущено':'Остановлено'}</span></div><div class=appmeta>PID: ${a.pid||'—'} · ${a.port?'порт '+a.port:'порт не указан'}</div><div class=actions><button class=primary onclick="act(${a.id},'start')" ${a.running?'disabled':''}>Запуск</button><button class=btn onclick="act(${a.id},'restart')">↻</button><button class=btn onclick="act(${a.id},'stop')" ${!a.running?'disabled':''}>Стоп</button><button class=btn onclick="page('app:${a.id}')">Открыть</button></div></div>`}
async function pollCards(){clearInterval(statsTimer);if(currentPage==='dash')updateSys();statsTimer=setInterval(async()=>{if(document.hidden||(currentPage!=='dash'&&currentPage!=='apps'))return;try{appCache=await api('/apps');if(currentPage==='dash'){updateSys();const el=$('cards');if(el)el.innerHTML=appCache.slice(0,8).map(appCard).join('')||empty('Приложений пока нет')}else if($('appgrid')){const q=($('search')?.value||'').toLowerCase();$('appgrid').innerHTML=appCache.filter(x=>(x.name+' '+x.type+' '+x.command).toLowerCase().includes(q)).map(appCard).join('')||empty('Добавьте первое приложение')}}catch{}},3000)}
async function apps(){clearInterval(statsTimer);appCache=await api('/apps');$('content').innerHTML=toolbar(`<input id=search class=search placeholder="Поиск приложения..." oninput=filterApps()><button class=primary onclick=newApp()>+ Добавить</button>`)+`<div id=appgrid class=grid>${appCache.map(appCard).join('')||empty('Добавьте первое приложение')}</div>`;pollCards()}
function filterApps(){const q=$('search').value.toLowerCase();$('appgrid').innerHTML=appCache.filter(x=>(x.name+' '+x.type+' '+x.command).toLowerCase().includes(q)).map(appCard).join('')}
function empty(x){return `<div class=empty>${esc(x)}</div>`}
async function updateSys(){try{const s=await api('/system');let el=$('dsys');if(!el){const st=document.querySelector('#content .stats');if(!st)return;st.insertAdjacentHTML('afterend','<div class=hint id=dsys style="margin-bottom:18px"></div>');el=$('dsys')}el.innerHTML=`Компьютер: CPU <b>${s.cpu.toFixed(0)}%</b> (${s.cores} потоков) · RAM <b>${fmtSize(s.memUsed)}</b> из ${fmtSize(s.memTotal)} (${(s.memUsed/s.memTotal*100).toFixed(0)}%)`}catch{}}
async function deleteApp(id){if(confirm('Удалить приложение?')){try{await api('/apps/'+id,{method:'DELETE'});closeModal();apps()}catch(e){alert(e.message)}}}
function consoleOpen(id){activeAppId=id;window.consoleAppId=id;const title=(appCache.find(x=>x.id===id)||{}).name||'Консоль';modal(title,`<div class=console><div id=out class=out></div><div class=cin><input id=ci placeholder="Команда..."><button onclick="send(${id})">SEND</button></div></div>`);loadOutput(id)}
async function loadOutput(id){try{const d=await api('/apps/'+id+'/output');if($('out')){$('out').textContent=d.map(x=>x.data).join('');$('out').scrollTop=$('out').scrollHeight}}catch{}}
async function send(id){const x=$('ci');if(x.value){try{await api('/apps/'+id+'/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:x.value})});x.value=''}catch(e){alert(e.message)}}}
async function sendDetail(id){const x=$('detailCmd');if(x?.value){await sendCommand(id,x.value);x.value=''}}async function sendCommand(id,c){try{await api('/apps/'+id+'/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:c})})}catch(e){alert(e.message)}}
async function browseSelect(field){const start=$('appform')?.elements[field]?.value||'';let cur=start;async function draw(){const d=await api('/browse?path='+encodeURIComponent(cur));modal('Выбор папки',`<div class=browser><div class=split><code>${esc(cur||'/')}</code><button class=btn onclick="browseRoot()">Корень</button></div>${d.map(x=>`<button class=item onclick="browseInto(${jsArg(x.path)})">📁 ${esc(x.name)}</button>`).join('')||empty('Нет вложенных папок')}<button class=primary onclick="chooseBrowse(${jsArg(field)},${jsArg(cur)})">Выбрать эту папку</button></div>`)}window.browseInto=p=>{cur=p;draw()};window.browseRoot=()=>{cur='';draw()};window.chooseBrowse=(f,p)=>{$('appform').elements[f].value=p;closeModal()};draw()}
async function runtimes(){$('content').innerHTML='<div class=muted>Поиск Runtime…</div>';const d=await api('/runtimes?refresh=1');$('content').innerHTML=toolbar(`<button class=btn onclick=runtimes()>↻ Обновить</button>`)+`<div class=grid>${d.map(x=>`<div class=card><div class=split><h3>${esc(x.label)}${x.major?' '+x.major:''}</h3><span class="status ${x.isDefault?'good':'muted'}"><i class="dot ${x.isDefault?'on':''}"></i>${x.isDefault?'В PATH (по умолчанию)':x.source==='PATH'?'В PATH':'Найден поиском'}</span></div><p>${esc(x.version)}</p><code>${esc(x.path)}</code></div>`).join('')||empty('Runtime не найдены')}</div>`}
async function docker(){try{const d=await api('/docker');$('content').innerHTML=toolbar(`<button class=primary onclick=dockerRun()>+ Создать контейнер</button><button class=btn onclick=docker()>↻ Обновить</button>`)+`<div class=hint>Docker должен быть установлен и доступен пользователю Node.js.</div><table class=table><tr><th>Имя</th><th>Image</th><th>Статус</th><th></th></tr>${d.map(x=>`<tr><td><b>${esc(x.Names||x.name)}</b></td><td><code>${esc(x.Image)}</code></td><td>${esc(x.Status)}</td><td><button class=btn onclick="dockerAct(${jsArg(x.ID)},'start')">Start</button><button class=btn onclick="dockerAct(${jsArg(x.ID)},'stop')">Stop</button><button class=btn onclick="dockerAct(${jsArg(x.ID)},'restart')">Restart</button><button class=btn onclick="dockerLogs(${jsArg(x.ID)})">Logs</button><button class="btn bad" onclick="dockerAct(${jsArg(x.ID)},'remove')">Удалить</button></td></tr>`).join('')||'<tr><td colspan=4 class=muted>Контейнеров нет или Docker недоступен.</td></tr>'}</table>`}catch(e){$('content').innerHTML=`<div class=empty>Docker недоступен: ${esc(e.message)}</div>`}}
async function dockerRun(){modal('Новый Docker-контейнер',`<form id=df class=form><label>Image<input name=image placeholder="nginx:latest" required></label><label>Имя<input name=name placeholder="my-server"></label><label>Порты<input name=ports placeholder="25565:25565,8080:80"></label><label>Команда<input name=command placeholder="Необязательно"></label><button class=primary type=button onclick=saveDocker()>Запустить</button></form>`)}async function saveDocker(){const b=Object.fromEntries(new FormData($('df')));try{await api('/docker/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});closeModal();docker()}catch(e){alert(e.message)}}async function dockerAct(id,a){if(a==='remove'&&!confirm('Удалить контейнер?'))return;try{await api(`/docker/${encodeURIComponent(id)}/${a}`,{method:'POST'});docker()}catch(e){alert(e.message)}}async function dockerLogs(id){try{const d=await api('/docker/'+encodeURIComponent(id)+'/logs');modal('Docker Logs',`<div class=console><div class=out>${esc(d)}</div></div>`)}catch(e){alert(e.message)}}
async function audit(){const d=await api('/audit');$('content').innerHTML=`<table class=table><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Подробности</th></tr>${d.map(x=>`<tr><td>${esc(x.created_at)}</td><td>${esc(x.username)}</td><td>${esc(x.action)}</td><td>${esc(x.details)}</td></tr>`).join('')}</table>`}
function settings(){modal('Настройки',`<form id=pf class=form><label>Текущий пароль<input type=password name=currentPassword></label><label>Новый пароль<input type=password name=newPassword minlength=8></label><button class=primary type=button onclick=changePass()>Изменить пароль</button></form><div class=hint style="margin-top:15px"><b>Важно</b><p>Для публичного доступа используйте HTTPS/reverse proxy. Процессы запускаются с правами пользователя Node.js.</p></div>`)}async function changePass(){const b=Object.fromEntries(new FormData($('pf')));try{await api('/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});alert('Пароль изменён');closeModal()}catch(e){alert(e.message)}}
function modal(title,body){$('modal').className='modal';$('modal').innerHTML=`<div><div class=modalhead><h2 style="margin:0">${esc(title)}</h2><button class=close onclick=closeModal()>×</button></div>${body}</div>`}function closeModal(){$('modal').className='hidden';$('modal').innerHTML='';clearInterval(statsTimer)}
function connectWS(){if(ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState))return;ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}&node=${encodeURIComponent(node)}`);ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.type==='output'&&String(d.id)===String(activeAppId)){consoleAppend(d.data)}if(d.type==='exit'){if(currentPage==='dash'||currentPage==='apps')refreshCurrent()}};ws.onclose=()=>setTimeout(connectWS,2000)}
if(token)show();

// M5: project import wizard and full application workspace
async function importWizard(){
  let scan=null;
  const draw=()=>{
    const candidates=scan?.candidates||[];
    modal('Импорт проекта',`<div class=wizard><div class=step><b>1.</b> Укажите папку проекта</div><div class=inline><input id=scanPath value="${esc(scan?.cwd||'')}" placeholder="C:\\Servers\\MyServer или /opt/myserver"><button class=btn onclick="wizardBrowse()">Обзор…</button></div><button class=primary onclick="runScan()">🔎 Просканировать</button>${scan?`<div class=step><b>2.</b> Выберите способ запуска</div><div class=scanlist>${candidates.map((c,i)=>`<label class="scanitem"><input type=radio name=scanCandidate value="${i}" ${i===0?'checked':''}><div><b>${esc(c.label)}</b><small>${esc(c.command||'Без команды')} · ${esc(c.confidence)}${c.runtime&&!c.availableRuntime?' · runtime не найден':''}</small>${c.details?`<small>${esc(c.details)}</small>`:''}</div></label>`).join('')}</div><div class=two><label>Название<input id=scanName value="${esc(basename(scan.cwd))}"></label><label>Порт<input id=scanPort type=number></label></div><div class=checks><label><input id=scanAutoStart type=checkbox> Автозапуск</label><label><input id=scanAutoRestart type=checkbox> Автоперезапуск</label></div><button class=primary onclick="finishImport()">✓ Создать приложение</button>`:''}</div>`)
  };
  window.runScan=async()=>{const cwd=$('scanPath').value.trim();if(!cwd)return alert('Укажите папку');try{scan=await api('/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd})});draw()}catch(e){alert(e.message)}};
  window.wizardBrowse=()=>browseScanPath();
  window.finishImport=async()=>{const chosen=document.querySelector('input[name=scanCandidate]:checked');if(!chosen)return;try{const b={working_dir:scan.cwd,candidate:+chosen.value,name:$('scanName').value.trim(),port:$('scanPort').value||null,auto_start:$('scanAutoStart').checked,auto_restart:$('scanAutoRestart').checked};const a=await api('/apps/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});closeModal();page('app:'+a.id)}catch(e){alert(e.message)}};
  window.browseScanPath=async()=>{let cur='';const drawBrowse=async()=>{const d=await api('/browse?path='+encodeURIComponent(cur));modal('Выбор папки',`<div class=browser><div class=split><code>${esc(cur||'/')}</code><button class=btn onclick="${cur?'scanParent()':'void(0)'}">${cur?'Вверх':'Корень'}</button></div>${d.map(x=>`<button class=item onclick="scanInto(${jsArg(x.path)})">📁 ${esc(x.name)}</button>`).join('')||empty('Нет вложенных папок')}<button class=primary onclick="scanChoose(${jsArg(cur)})">Выбрать</button></div>`)};window.scanInto=p=>{cur=p;drawBrowse()};window.scanParent=()=>{cur=cur.replace(/[\\/]$/,'').split(/[\\/]/).slice(0,-1).join(pathSep(cur))||'';if(/^[A-Za-z]:$/.test(cur))cur+='\\';drawBrowse()};window.scanChoose=p=>{closeModal();setTimeout(()=>{importWizard();setTimeout(()=>{$('scanPath').value=p},50)},50)};await drawBrowse()};
  draw();
}
function pathSep(p){return p.includes('\\')?'\\':'/'}

async function workspaceStats(id){const points=[];clearInterval(statsTimer);const c=$('chart');if(!c)return;const ctx=c.getContext('2d');updateSys();const plot=()=>{ctx.clearRect(0,0,c.width,c.height);ctx.strokeStyle='#6ea8fe';ctx.lineWidth=2;ctx.beginPath();points.forEach((v,i)=>{const x=10+i*(c.width-20)/Math.max(1,points.length-1),y=c.height-20-Math.min(100,v)*1.5;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();};statsTimer=setInterval(async()=>{try{const s=await api(`/apps/${id}/stats`);if($('dcpu'))$('dcpu').textContent=s.cpu.toFixed(1)+'%';if($('dram'))$('dram').textContent=fmtSize(s.memory);updateSys();points.push(Math.min(100,s.cpu));if(points.length>80)points.shift();plot()}catch{}},1000);plot()}


/* ================= M7 ================= */
const JH={'Content-Type':'application/json'};
const isAdmin=()=>me&&me.role==='admin';
const canOp=()=>me&&me.role!=='viewer';
async function apiText(url){const r=await fetch(apiPath(url),{headers:token?{Authorization:'Bearer '+token}:{}});const t=await r.text();if(r.status===401&&token){localStorage.removeItem('sm_token');token='';location.reload();throw Error('Сессия истекла')}if(!r.ok){let m;try{m=JSON.parse(t).error}catch{}throw Error(m||`HTTP ${r.status}`)}return t}
function toast(msg,bad){let t=$('toast');if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t)}t.className='toast show'+(bad?' bad':'');t.textContent=msg;clearTimeout(toast.t);toast.t=setTimeout(()=>t.className='toast',bad?6000:3000)}
const fmtDate=s=>s?new Date(s).toLocaleString():'—';

/* консоль: вывод пачками по кадрам, не больше ~1500 блоков, прокрутка только если вы внизу */
let _cq='',_cr=0;
function consoleAppend(t){_cq+=t;if(_cr)return;_cr=requestAnimationFrame(()=>{_cr=0;const s=_cq;_cq='';for(const id of ['out','detailOut']){const el=$(id);if(!el)continue;const atEnd=el.scrollHeight-el.scrollTop-el.clientHeight<60;el.appendChild(document.createTextNode(s));el._n=(el._n||0)+1;if(el._n>1500){while(el.childNodes.length>1000)el.removeChild(el.firstChild);el._n=1000}if(atEnd)el.scrollTop=el.scrollHeight}})}
/* ---------- запуск/остановка ---------- */
async function act(id,a){
  try{
    const d=await api(`/apps/${id}/${a}`,{method:'POST',headers:JH,body:'{}'});
    if(d&&d.warning)alert(d.warning);
    if(currentPage==='apps')apps();else if(String(currentPage).startsWith('app:'))appWorkspace(id,wsTab);else dashboard();
  }catch(e){alert(e.message)}
}


/* ---------- файлы: общая страница и вкладка проекта ---------- */
const fmCtx={app:0,disk:'',path:'',host:'content',root:'Хранилище'};
let fmLastDisk='',fmDiskList=null,fmClip=null;
const fmQ=(extra='')=>(fmCtx.app?'app='+fmCtx.app+'&':'')+(fmCtx.disk?'disk='+encodeURIComponent(fmCtx.disk)+'&':'')+extra;
const fmScopeObj=()=>({app:fmCtx.app||undefined,disk:fmCtx.disk||undefined});
const fmBody=o=>JSON.stringify({...o,...fmScopeObj()});
const fmAbs=()=>{if(!fmCtx.disk)return null;const sep=fmCtx.disk.includes('\\')?'\\':'/';return fmCtx.disk.replace(/[\\/]+$/,'')+sep+fmCtx.path.split('/').join(sep)};
const fmJoin=n=>(fmCtx.path?fmCtx.path+'/':'')+n;
async function files(){fmCtx.app=0;fmCtx.disk=isAdmin()?fmLastDisk:'';fmCtx.path=pathNow||'';fmCtx.host='content';fmCtx.root=fmCtx.disk||'Хранилище';pathNow='';await fmMount()}
function filesOpenDisk(m){fmLastDisk=m;fmCtx.path='';page('files')}
async function fmMount(){
  const host=$(fmCtx.host);if(!host)return;
  const scoped=isAdmin()&&!fmCtx.app;
  if(scoped&&!fmDiskList){try{fmDiskList=await api('/hw/disks')}catch{fmDiskList={disks:[],others:[]}}}
  let d;
  try{d=await api('/files?'+fmQ('path='+encodeURIComponent(fmCtx.path)))}
  catch(e){host.innerHTML=`<div class=empty>${esc(e.message)}<br><br>${fmCtx.path?`<button class=btn onclick="fmGo('')">В корень</button> `:''}${fmCtx.disk?`<button class=btn onclick="fmScope('')">В хранилище проектов</button> <button class=btn onclick=fmRescan()>⟳ Обновить список дисков</button>`:''}</div>`;return}
  const parts=fmCtx.path?fmCtx.path.split('/'):[];
  const crumbs=`<button class=link onclick="fmGo('')">${esc(fmCtx.root)}</button>`+parts.map((p,i)=>` / <button class=link onclick="fmGo(${jsArg(parts.slice(0,i+1).join('/'))})">${esc(p)}</button>`).join('');
  const ed=canOp(),adm=isAdmin();
  const opts=scoped?[...(fmDiskList.disks||[]).flatMap(k=>k.partitions.map(p=>[p,k.name])),...(fmDiskList.others||[]).map(p=>[p,'Сетевой/прочий том'])].filter(([p])=>p.accessible&&p.kind!=='optical'&&p.kind!=='other'):[];
  const scopeBar=scoped?`<div class=toolbar><label class=scopelbl>Расположение<select id=fmscope onchange="fmScope(this.value)"><option value="">📦 Хранилище проектов</option>${opts.map(([p,n])=>`<option value="${esc(p.mount)}" ${p.mount===fmCtx.disk?'selected':''}>💽 ${esc(p.mount)} ${esc(p.label)} — ${esc(n)}${p.free!=null?' · свободно '+hwSize(p.free):''}</option>`).join('')}</select></label><button class=btn onclick=fmRescan() title="Найти диски, подключённые после запуска панели">⟳ Обновить диски</button>${fmCtx.disk?'<small class=muted>Вы работаете с реальными файлами диска. Системные каталоги и файлы панели закрыты.</small>':''}</div>`:'';
  const where=fmCtx.disk?`<div class=fmwhere>Накопитель: <b>${esc(fmCtx.disk)}</b> · Путь: <code>${esc(fmAbs())}</code></div>`:'';
  const clip=fmClip?`<button class=btn onclick=fmPaste() title="Вставить в текущую папку">📋 Вставить «${esc(fmClip.name)}» (${fmClip.mode==='move'?'переместить':'копировать'})</button><button class=btn onclick=fmClipClear()>✕</button>`:'';
  host.innerHTML=scopeBar+where+`<div class=toolbar>${fmCtx.path?`<button class=btn onclick="fmGo(${jsArg(parts.slice(0,-1).join('/'))})">↑ Вверх</button>`:''}${ed?`<button class=btn onclick=fmNewFile()>+ Файл</button><button class=btn onclick=fmMkdir()>+ Папка</button><input type=file id=fmpick multiple hidden onchange=fmUpload(this.files)><button class=btn onclick="$('fmpick').click()">⬆ Загрузить</button>`:''}${clip}<button class=btn onclick=fmMount()>↻</button><span class=path>${crumbs}</span></div>
  <div id=fmdrop class=fmdrop><table class=table><tr><th>Имя</th><th>Размер</th><th>Изменён</th><th></th></tr>${d.map(x=>{const full=fmJoin(x.name),dir=x.type==='directory';
    return `<tr><td>${dir?`📁 <button class=link onclick="fmGo(${jsArg(full)})">${esc(x.name)}</button>`:`📄 <button class=link onclick="fmEdit(${jsArg(full)})">${esc(x.name)}</button>`}</td><td>${dir?'—':fmtSize(x.size)}</td><td>${fmtDate(x.modified)}</td><td class=rowact>${!dir&&ed?`<button class=btn onclick="fmEdit(${jsArg(full)})">Изменить</button>`:''}<button class=btn onclick="fmDownload(${jsArg(full)})">${dir?'ZIP':'Скачать'}</button>${adm?`<button class=btn onclick="fmClipSet('copy',${jsArg(x.name)})">Копировать</button><button class=btn onclick="fmClipSet('move',${jsArg(x.name)})">Вырезать</button>`:''}${ed?`<button class=btn onclick="fmRename(${jsArg(x.name)})">Переименовать</button><button class="btn bad" onclick="fmDelete(${jsArg(x.name)},${dir})">Удалить</button>`:''}</td></tr>`}).join('')||'<tr><td colspan=4 class=muted>Папка пуста. Перетащите сюда файлы, чтобы загрузить.</td></tr>'}</table></div>
  <div id=fmup class=muted></div>`;
  const dz=$('fmdrop');if(dz&&ed){dz.ondragover=e=>{e.preventDefault();dz.classList.add('drag')};dz.ondragleave=()=>dz.classList.remove('drag');dz.ondrop=e=>{e.preventDefault();dz.classList.remove('drag');fmUpload(e.dataTransfer.files)}}
}
function fmGo(p){fmCtx.path=p;fmMount()}
async function fmNewFile(){const n=prompt('Имя нового файла (например, config.yml)');if(!n)return;try{await api('/file',{method:'POST',headers:JH,body:fmBody({path:fmJoin(n),content:''})});await fmMount();fmEdit(fmJoin(n))}catch(e){alert(e.message)}}
async function fmMkdir(){const n=prompt('Название папки');if(!n)return;try{await api('/mkdir',{method:'POST',headers:JH,body:fmBody({path:fmJoin(n)})});fmMount()}catch(e){alert(e.message)}}
async function fmRename(old){const n=prompt('Новое имя',old);if(!n||n===old)return;try{await api('/rename',{method:'POST',headers:JH,body:fmBody({oldPath:fmJoin(old),newPath:fmJoin(n)})});fmMount()}catch(e){alert(e.message)}}
async function fmDelete(name,dir){if(!confirm(dir?`Удалить папку «${name}» со всем содержимым?`:`Удалить файл «${name}»?`))return;try{await api('/file',{method:'DELETE',headers:JH,body:fmBody({path:fmJoin(name)})});fmMount()}catch(e){alert(e.message)}}
function fmDownload(p){location.href=apiPath('/download')+'?'+fmQ('path='+encodeURIComponent(p))+'&token='+encodeURIComponent(token)}
function fmSend(file,overwrite){
  return new Promise((resolve,reject)=>{
    const fd=new FormData();if(fmCtx.app)fd.append('app',fmCtx.app);fd.append('path',fmCtx.path);if(overwrite)fd.append('overwrite','1');fd.append('file',file);
    const x=new XMLHttpRequest();x.open('POST',apiPath('/upload'));if(token)x.setRequestHeader('Authorization','Bearer '+token);
    x.upload.onprogress=e=>{if(e.lengthComputable&&$('fmup'))$('fmup').textContent=`Загрузка «${file.name}»: ${Math.round(e.loaded/e.total*100)}%`};
    x.onload=()=>{let d={};try{d=JSON.parse(x.responseText)}catch{}if(x.status===200)resolve(d);else{const e=Error(d.error||`Ошибка загрузки (HTTP ${x.status}). Возможно, файл больше лимита.`);e.exists=!!d.exists;reject(e)}};
    x.onerror=()=>reject(Error('Сеть недоступна'));x.send(fd);
  });
}
async function fmUpload(list){
  for(const f of [...list]){
    try{await fmSend(f,false)}
    catch(e){if(e.exists&&confirm(`Файл «${f.name}» уже существует. Заменить?`)){try{await fmSend(f,true)}catch(e2){alert(e2.message)}}else if(!e.exists)alert(e.message)}
  }
  toast('Загрузка завершена');fmMount();
}
let fmEd=null;
async function fmEdit(p){
  try{
    const d=await api('/file?'+fmQ('path='+encodeURIComponent(p)));
    fmEd={path:p,eol:d.eol,mtime:d.mtime};
    let running=false;if(fmCtx.app){try{running=(await api('/apps/'+fmCtx.app)).running}catch{}}
    modal('Редактор: '+p,`<div class=editor><div class=hint style="margin-bottom:10px">⚠ Изменение конфигурации не всегда применяется сразу — многим серверам для этого нужен перезапуск.${running?' Приложение сейчас запущено.':''}</div><textarea id=ed spellcheck=false onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();fmSave(false)}">${esc(d.content)}</textarea><div class=actions style="margin-top:12px"><button class=primary onclick="fmSave(false)">Сохранить</button>${fmCtx.app&&running?`<button class=btn onclick="fmSave(true)">Сохранить и перезапустить</button>`:''}<button class=btn onclick="closeModal();fmMount()">Закрыть</button><span id=edmsg class=muted></span></div></div>`);
  }catch(e){alert(e.message)}
}
async function fmSave(restart,force){
  try{
    const r=await api('/file',{method:'POST',headers:JH,body:fmBody({path:fmEd.path,content:$('ed').value,eol:fmEd.eol,mtime:fmEd.mtime,force:!!force})});
    fmEd.mtime=r.mtime;
    if(restart){closeModal();await act(fmCtx.app,'restart');toast('Сохранено, перезапуск…');fmMount();return}
    $('edmsg').textContent=fmCtx.app?'✓ Сохранено. Чтобы изменения вступили в силу, перезапустите приложение.':'✓ Сохранено';
  }catch(e){
    if(e.status===409&&e.data&&e.data.conflict){if(confirm(e.message+'\nПерезаписать вашей версией?'))return fmSave(restart,true);return}
    alert(e.message);
  }
}

/* ---------- выбор диска, копирование и перемещение ---------- */
function fmScope(m){fmCtx.disk=m;fmLastDisk=m;fmCtx.path='';fmCtx.root=m||'Хранилище';fmMount()}
async function fmRescan(){try{fmDiskList=await api('/hw/disks?refresh=1');toast('Список дисков обновлён')}catch(e){toast(e.message,true)}fmMount()}
function fmClipSet(mode,name){fmClip={mode,name,scope:fmScopeObj(),path:fmJoin(name)};toast(mode==='move'?'Вырезано. Откройте нужную папку (или другой диск) и нажмите «Вставить»':'Скопировано. Откройте нужную папку (или другой диск) и нажмите «Вставить»');fmMount()}
function fmClipClear(){fmClip=null;fmMount()}
async function fmPaste(overwrite){
  if(!fmClip)return;
  try{
    const r=await api('/transfer',{method:'POST',headers:JH,body:JSON.stringify({mode:fmClip.mode,src:{...fmClip.scope,path:fmClip.path},dst:{...fmScopeObj(),path:fmCtx.path},overwrite:!!overwrite})});
    const mode=fmClip.mode,name=fmClip.name;
    xferPoll(r.job,`${mode==='move'?'Перемещение':'Копирование'}: ${name}`,()=>{if(mode==='move')fmClip=null;fmMount()});
  }catch(e){
    if(!overwrite&&/можно заменить файл/.test(e.message)&&confirm(e.message+'\nЗаменить существующий файл?'))return fmPaste(true);
    alert(e.message);
  }
}
function xferPoll(job,title,done){
  modal(title,`<div id=xfbox><div class=pbar><i class=busy></i></div><small class=muted>Подготовка…</small></div>`);
  const tick=async()=>{
    const box=$('xfbox');if(!box)return;
    try{
      const j=await api('/transfer/'+job);
      const pct=j.total?Math.min(100,Math.round(j.done/j.total*100)):null,ph={scan:'Подсчёт файлов…',copy:'Копирование…',verify:'Проверка копии…',cleanup:'Удаление оригинала…',done:''}[j.phase]||'';
      if(j.status==='running'){box.innerHTML=`<div class=pbar><i style="width:${pct==null?100:pct}%" class="${pct==null?'busy':''}"></i></div><small class=muted>${ph} ${j.total?hwSize(j.done)+' из '+hwSize(j.total):''} ${j.files?'· файлов: '+j.files:''}</small>`;setTimeout(tick,500)}
      else if(j.status==='done'){closeModal();toast(j.message||'Готово');if(j.skippedCount)alert(j.message+(j.skipped&&j.skipped.length?'\n\nНе скопированы:\n'+j.skipped.join('\n'):''));done&&done()}
      else{closeModal();alert('Операция не выполнена: '+j.message+'\nИсходные файлы не изменены.');done&&done()}
    }catch(e){closeModal();alert(e.message)}
  };
  tick();
}


/* ---------- задачи по расписанию ---------- */
const TK_ACT={start:'Запустить',stop:'Остановить',restart:'Перезапустить',backup:'Создать backup',command:'Отправить команду в консоль'};
const DOW=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const p2=n=>String(n).padStart(2,'0');
function tkHuman(c){
  let m;c=String(c||'').trim();
  if(m=/^(\d+) (\d+) \* \* \*$/.exec(c))return `Каждый день в ${p2(m[2])}:${p2(m[1])}`;
  if(m=/^(\d+) (\d+) \* \* ([\d,]+)$/.exec(c))return `По дням: ${m[3].split(',').map(d=>DOW[+d%7]).join(', ')} в ${p2(m[2])}:${p2(m[1])}`;
  if(m=/^\*\/(\d+) \* \* \* \*$/.exec(c))return `Каждые ${m[1]} мин.`;
  if(m=/^(\d+) \*\/(\d+) \* \* \*$/.exec(c))return `Каждые ${m[2]} ч. (в ${p2(m[1])} мин.)`;
  if(m=/^(\d+) (\d+) (\d+) \* \*$/.exec(c))return `Раз в месяц, ${m[3]}-го числа в ${p2(m[2])}:${p2(m[1])}`;
  return 'Свой cron';
}
function tkParse(c){
  let m;c=String(c||'').trim();
  if(m=/^(\d+) (\d+) \* \* \*$/.exec(c))return{mode:'daily',time:`${p2(m[2])}:${p2(m[1])}`};
  if(m=/^(\d+) (\d+) \* \* ([\d,]+)$/.exec(c))return{mode:'weekly',time:`${p2(m[2])}:${p2(m[1])}`,days:m[3].split(',').map(d=>+d%7)};
  if(m=/^\*\/(\d+) \* \* \* \*$/.exec(c))return{mode:'min',n:+m[1]};
  if(m=/^(\d+) \*\/(\d+) \* \* \*$/.exec(c))return{mode:'hour',n:+m[2],at:+m[1]};
  if(m=/^(\d+) (\d+) (\d+) \* \*$/.exec(c))return{mode:'month',time:`${p2(m[2])}:${p2(m[1])}`,day:+m[3]};
  return{mode:'custom',cron:c};
}
async function tasks(){
  clearInterval(statsTimer);
  const t=await api('/tasks');appCache=await api('/apps');
  const st=x=>x.last_run?`<span class="tkst ${x.last_status==='ok'?'ok':'err'}" title="${esc(x.last_message||'')}">${x.last_status==='ok'?'✓':'✗'} ${esc(x.last_run)}</span><br><small class=muted>${esc((x.last_message||'').slice(0,70))}</small>`:'<small class=muted>ещё не запускалась</small>';
  $('content').innerHTML=toolbar(`<button class=primary onclick="taskForm()">+ Задача</button><button class=btn onclick=tasks()>↻</button><span class=hint>Время — по часам компьютера, на котором работает панель.</span>`)+
  `<table class=table><tr><th>Задача</th><th>Расписание</th><th>Приложение</th><th>Действие</th><th>Следующий запуск</th><th>Последний запуск</th><th></th></tr>${t.map(x=>`<tr class="${x.enabled?'':'tkoff'}"><td><b>${esc(x.name)}</b>${x.running?' <small class=muted>выполняется…</small>':''}</td><td>${esc(tkHuman(x.cron))}<br><code>${esc(x.cron)}</code></td><td>${esc((appCache.find(a=>a.id===x.app_id)||{}).name||'#'+x.app_id)}</td><td>${esc(TK_ACT[x.action]||x.action)}${x.action==='command'?`<br><code>${esc(x.payload)}</code>`:''}${x.action==='backup'&&x.keep?`<br><small class=muted>хранить ${x.keep} шт.</small>`:''}</td><td>${x.enabled?esc(x.next||'—'):'<small class=muted>выключена</small>'}</td><td>${st(x)}</td><td class=rowact><label class=switch title="Включить/выключить"><input type=checkbox ${x.enabled?'checked':''} onchange="tkToggle(${x.id},this.checked)"><i></i></label><button class=btn onclick="tkRun(${x.id})" title="Выполнить сейчас">▶</button><button class=btn onclick="taskForm(${x.id})">Изменить</button><button class="btn bad" onclick="delTask(${x.id})">Удалить</button></td></tr>`).join('')||'<tr><td colspan=7 class=muted>Задач пока нет. Например: «каждый день в 04:00 — перезапустить сервер» или «создавать backup каждую ночь и хранить 7 копий».</td></tr>'}</table>`;
  window._tasks=t;
}
async function taskForm(id,preset){
  const apps=await api('/apps');
  const cur=id?(window._tasks||[]).find(x=>x.id===id):null;
  const o=cur||{name:'',cron:'0 4 * * *',app_id:preset?.app_id||(apps[0]&&apps[0].id),action:preset?.action||'restart',payload:'',keep:preset?.action==='backup'?7:0};
  const s=tkParse(o.cron);
  modal(id?'Изменить задачу':'Новая задача',`<div id=tf class=form>
    <label>Название<input id=tkname value="${esc(o.name)}" placeholder="Например, Ночной перезапуск"></label>
    <div class=two><label>Приложение<select id=tkapp>${apps.map(a=>`<option value=${a.id} ${a.id===o.app_id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label>
    <label>Действие<select id=tkact onchange=tkAct()>${Object.entries(TK_ACT).map(([k,v])=>`<option value=${k} ${k===o.action?'selected':''}>${v}</option>`).join('')}</select></label></div>
    <div id=tkextra></div>
    <div class=box><h3>Когда выполнять</h3>
    <label>Режим<select id=tkmode onchange=tkMode()><option value=daily>Каждый день в…</option><option value=weekly>По дням недели</option><option value=hour>Каждые N часов</option><option value=min>Каждые N минут</option><option value=month>Раз в месяц</option><option value=custom>Свой cron (для опытных)</option></select></label>
    <div id=tksched style="margin-top:10px"></div>
    <div class=hint style="margin-top:10px" id=tkprev></div></div>
    <button class=primary onclick="tkSave(${id||0})">${id?'Сохранить':'Создать задачу'}</button></div>`);
  window._tkS=s;window._tkO=o;$('tkmode').value=s.mode;tkAct();tkMode();
}
function tkAct(){
  const a=$('tkact').value,o=window._tkO||{};
  $('tkextra').innerHTML=a==='command'?`<label>Команда (отправляется в консоль приложения)<input id=tkpay value="${esc(o.payload||'')}" placeholder="say Перезапуск через минуту"></label>`
   :a==='backup'?`<label>Сколько последних копий хранить (0 — не удалять старые)<input id=tkkeep type=number min=0 max=1000 value="${o.keep||0}"></label><div class=hint>Копия делается из рабочей папки проекта. Для Minecraft запущенный сервер перед копированием сохраняет мир.</div>`
   :a==='restart'?`<div class=hint>Если нужно предупредить игроков — создайте отдельную задачу «Отправить команду» за минуту до перезапуска.</div>`:'';
}
function tkMode(){
  const m=$('tkmode').value,s=window._tkS||{},days=s.days||[1];
  const time=v=>`<label>Время<input id=tktime type=time value="${v||'04:00'}" oninput=tkPrev()></label>`;
  $('tksched').innerHTML=m==='daily'?time(s.time):
    m==='weekly'?`<div class=checks style="flex-wrap:wrap;margin-bottom:10px">${[1,2,3,4,5,6,0].map(d=>`<label><input type=checkbox class=tkday value=${d} ${days.includes(d)?'checked':''} onchange=tkPrev()> ${DOW[d]}</label>`).join('')}</div>${time(s.time)}`:
    m==='hour'?`<div class=two><label>Каждые (часов)<input id=tkn type=number min=1 max=23 value="${s.n||6}" oninput=tkPrev()></label><label>В какую минуту<input id=tkat type=number min=0 max=59 value="${s.at||0}" oninput=tkPrev()></label></div>`:
    m==='min'?`<label>Каждые (минут)<input id=tkn type=number min=1 max=59 value="${s.n||15}" oninput=tkPrev()></label>`:
    m==='month'?`<div class=two><label>Число месяца<input id=tkday type=number min=1 max=31 value="${s.day||1}" oninput=tkPrev()></label>${time(s.time)}</div>`:
    `<label>Cron (5 полей: минута час день месяц день_недели)<input id=tkcron value="${esc(s.cron||'0 4 * * *')}" oninput=tkPrev()></label>`;
  tkPrev();
}
function tkCron(){
  const m=$('tkmode').value,tm=()=>{const [h,mi]=($('tktime').value||'04:00').split(':').map(Number);return[mi,h]};
  if(m==='daily'){const [mi,h]=tm();return `${mi} ${h} * * *`}
  if(m==='weekly'){const [mi,h]=tm();const d=[...document.querySelectorAll('.tkday:checked')].map(x=>x.value);return d.length?`${mi} ${h} * * ${d.join(',')}`:''}
  if(m==='hour')return `${+$('tkat').value||0} */${Math.max(1,+$('tkn').value||1)} * * *`;
  if(m==='min')return `*/${Math.max(1,+$('tkn').value||1)} * * * *`;
  if(m==='month'){const [mi,h]=tm();return `${mi} ${h} ${Math.min(31,Math.max(1,+$('tkday').value||1))} * *`}
  return ($('tkcron').value||'').trim();
}
let tkPrevT=null;
function tkPrev(){
  const c=tkCron(),el=$('tkprev');if(!el)return;
  if(!c){el.textContent='Выберите хотя бы один день недели';return}
  el.innerHTML=`<b>${esc(tkHuman(c))}</b> · <code>${esc(c)}</code><div id=tknext class=muted></div>`;
  clearTimeout(tkPrevT);tkPrevT=setTimeout(async()=>{try{const r=await api('/tasks/preview?cron='+encodeURIComponent(c));if($('tknext'))$('tknext').textContent=r.next.length?'Ближайшие запуски: '+r.next.join(' · '):'Расписание некорректно'}catch{}},300);
}
async function tkSave(id){
  const b={name:$('tkname').value.trim(),app_id:+$('tkapp').value,action:$('tkact').value,cron:tkCron()};
  if(b.action==='command')b.payload=$('tkpay').value;if(b.action==='backup')b.keep=+$('tkkeep').value||0;
  try{await api(id?'/tasks/'+id:'/tasks',{method:id?'PUT':'POST',headers:JH,body:JSON.stringify(b)});closeModal();tasks()}catch(e){alert(e.message)}
}
async function tkToggle(id,on){try{await api('/tasks/'+id,{method:'PUT',headers:JH,body:JSON.stringify({enabled:on})});tasks()}catch(e){alert(e.message);tasks()}}
async function tkRun(id){try{await api(`/tasks/${id}/run`,{method:'POST'});toast('Задача запущена');setTimeout(tasks,2500)}catch(e){alert(e.message)}}
async function delTask(id){if(confirm('Удалить задачу?')){await api('/tasks/'+id,{method:'DELETE'});tasks()}}


/* ---------- backup ---------- */
const BK_TAG={pre:'страховочная (перед восстановлением)'};
function bkRows(list,opt){
  return list.map(b=>`<tr><td><b>${esc(fmtDate(b.modified))}</b><br><code>${esc(b.name)}</code></td>${opt.app?'':`<td>${esc(((appCache.find(a=>a.id===b.app_id)||{}).name)||(b.app_id?'#'+b.app_id:'—'))}</td>`}<td>${fmtSize(b.size)}</td><td>${esc(BK_TAG[b.tag]||'обычная')}</td><td class=rowact><button class=btn onclick="bkDownload(${jsArg(b.name)})">Скачать</button>${b.app_id&&canOp()?`<button class=btn ${opt.running?'disabled title="Сначала остановите приложение"':''} onclick="bkRestore(${b.app_id},${jsArg(b.name)})">Восстановить</button>`:''}${isAdmin()?`<button class="btn bad" onclick="deleteBackup(${jsArg(b.name)},${opt.app||0})">Удалить</button>`:''}</td></tr>`).join('');
}
async function backups(){
  const [d]=await Promise.all([api('/backups'),api('/apps').then(a=>appCache=a)]);
  $('content').innerHTML=toolbar(`<span class=hint>Копии хранятся в storage/backups. Создавать их удобнее во вкладке «Backup» нужного проекта.</span>${isAdmin()?`<button class=btn onclick="taskForm(0,{action:'backup'})">⏱ Настроить расписание</button>`:''}`)+
   `<table class=table><tr><th>Копия</th><th>Приложение</th><th>Размер</th><th>Тип</th><th></th></tr>${bkRows(d,{})||'<tr><td colspan=5 class=muted>Копий пока нет.</td></tr>'}</table>`;
}
async function bkTab(id,a){
  const d=await api('/backups?app='+id);
  return `<div class=toolbar><button class=primary id=bkbtn onclick="backup(${id})">+ Создать backup</button>${isAdmin()?`<button class=btn onclick="taskForm(0,{action:'backup',app_id:${id}})">⏱ По расписанию…</button>`:''}<button class=btn onclick="appWorkspace(${id},'backups')">↻</button></div>
  <div class=hint style="margin-bottom:14px">Копируется вся рабочая папка проекта (<code>${esc(a.working_dir)}</code>). ${a.running?'Приложение запущено — для Minecraft перед копированием выполняется <code>save-all</code>, поэтому создание может занять до минуты. ':''}Файлы, занятые другим процессом, пропускаются. Перед восстановлением панель автоматически делает страховочную копию текущего состояния.</div>
  <div id=bkmsg></div><table class=table><tr><th>Копия</th><th>Размер</th><th>Тип</th><th></th></tr>${bkRows(d,{app:id,running:a.running})||'<tr><td colspan=4 class=muted>Копий этого проекта пока нет.</td></tr>'}</table>`;
}
async function backup(id){
  const b=$('bkbtn');if(b){b.disabled=true;b.textContent='Создаётся…'}
  try{const d=await api('/apps/'+id+'/backup',{method:'POST',headers:JH,body:'{}'});toast(`Backup создан: ${fmtSize(d.size)}`+(d.skipped&&d.skipped.length?`, пропущено файлов: ${d.skipped.length}`:''));
    if(String(currentPage).startsWith('app:'))appWorkspace(id,'backups');else if(currentPage==='backups')backups()}
  catch(e){alert('Не удалось создать backup: '+e.message);if(b){b.disabled=false;b.textContent='+ Создать backup'}}
}
async function bkRestore(appId,name){
  if(!confirm(`Восстановить проект из копии?\n\n${name}\n\nФайлы из копии заменят текущие (файлы, которых нет в копии, останутся). Перед этим будет создана страховочная копия текущего состояния.`))return;
  try{const r=await api(`/apps/${appId}/restore`,{method:'POST',headers:JH,body:JSON.stringify({name})});toast('Восстановлено. Страховочная копия: '+r.safety);if(String(currentPage).startsWith('app:'))appWorkspace(appId,'backups');else backups()}
  catch(e){alert(e.message)}
}
function bkDownload(name){location.href=apiPath('/download')+'?backup='+encodeURIComponent(name)+'&token='+encodeURIComponent(token)}
async function deleteBackup(n,appId){if(!confirm('Удалить backup?'))return;try{await api('/backups/'+encodeURIComponent(n),{method:'DELETE'});if(appId)appWorkspace(appId,'backups');else backups()}catch(e){alert(e.message)}}

/* ---------- логи ---------- */
let lgKb=256,lgTimer=null;
const LG_RE=/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[(stdout|stderr|system)\] ?(.*)$/;
function lgRender(text){
  const f=$('lgf').value,q=($('lgq').value||'').toLowerCase(),out=$('lgout');if(!out)return;
  const atEnd=out.scrollHeight-out.scrollTop-out.clientHeight<40;
  let n=0,html=[];
  for(const line of text.split('\n')){
    if(!line)continue;const m=LG_RE.exec(line);const st=m?m[2]:'stdout',body=m?m[3]:line;
    if(f==='stderr'&&st!=='stderr')continue;if(f==='system'&&st!=='system')continue;
    if(q&&!line.toLowerCase().includes(q))continue;
    n++;html.push(`<div class="lgl ${st}">${m?`<span class=lgt>${esc(new Date(m[1]).toLocaleTimeString())}</span>`:''}${esc(body)}</div>`);
  }
  if(html.length>3000)html=html.slice(-3000); // показываем последние 3000 строк — иначе браузер тормозит
  out.innerHTML=html.join('')||'<div class=muted style="padding:6px">Нет строк</div>';
  $('lgn').textContent=html.length+' строк';
  if(atEnd)out.scrollTop=out.scrollHeight;
}
async function lgLoad(id){try{const t=await apiText(`/apps/${id}/log?kb=${lgKb}`);if(t===window._lgText&&$('lgout')&&$('lgout').children.length)return;window._lgText=t;lgRender(t)}catch(e){if($('lgout'))$('lgout').innerHTML=`<div class=err>${esc(e.message)}</div>`}}
function lgTab(id){
  return `<div class=toolbar><select id=lgf onchange="lgRender(window._lgText||'')" style="width:auto"><option value=all>Все</option><option value=stderr>Только ошибки</option><option value=system>Только панель</option></select><input id=lgq class=search placeholder="Поиск по логу…" oninput="lgRender(window._lgText||'')"><label class=checkline style="margin:0"><input type=checkbox id=lgauto checked onchange="lgAuto(${id})"> автообновление</label><button class=btn onclick="lgLoad(${id})">↻</button><button class=btn onclick="lgMore(${id})">Показать больше</button><button class=btn onclick="lgDownload(${id})">Скачать</button>${canOp()?`<button class="btn bad" onclick="clearAppLog(${id})">Очистить</button>`:''}<small id=lgn class=muted></small></div><div class=console><div id=lgout class="out lgout">Загрузка…</div></div>`;
}
function lgAuto(id){clearInterval(lgTimer);if($('lgauto')&&$('lgauto').checked)lgTimer=setInterval(()=>{if(!$('lgout')){clearInterval(lgTimer);return}if(document.hidden)return;lgLoad(id)},3000)}
function lgMore(id){lgKb=Math.min(4096,lgKb*4);lgLoad(id)}
function lgDownload(id){location.href=apiPath('/download')+'?applog='+id+'&token='+encodeURIComponent(token)}
async function clearAppLog(id){if(!confirm('Очистить лог приложения?'))return;try{await api(`/apps/${id}/log`,{method:'DELETE'});lgLoad(id)}catch(e){alert(e.message)}}


/* ---------- профили запуска ---------- */
let profRt=[];
const envCount=s=>{try{return Object.keys(JSON.parse(s||'{}')).length}catch{return 0}};
function profRtName(p){if(!p)return 'по умолчанию (из PATH)';const r=profRt.find(x=>x.path===p);return r?`${r.label}${r.major?' '+r.major:''} (${r.version||''})`:p}
async function profTab(id,a){
  const [list,rt]=await Promise.all([api(`/apps/${id}/profiles`),api('/runtimes').catch(()=>[])]);profRt=rt;
  const adm=isAdmin();
  const cards=list.map(p=>`<div class="profcard ${p.active?'active':''}"><div class=split><div><h3>${esc(p.name)} ${p.active?'<span class=pfbadge style="background:#14301f;color:var(--good)">● Активен</span>':''}</h3>${p.note?`<small class=muted>${esc(p.note)}</small>`:''}</div></div>
    <div class=profrows><div><small>Команда запуска</small><code>${esc(p.command)}</code></div><div><small>Среда выполнения (Java / Node…)</small><span>${esc(profRtName(p.runtime_path))}</span></div><div><small>Переменные окружения</small><span>${envCount(p.env_json)?envCount(p.env_json)+' шт.':'нет'}</span></div></div>
    <div class=actions style="margin-top:12px">${p.active?'<button class=btn disabled>Уже применён</button>':a.running?`<button class=primary onclick="profApply(${id},${p.id},true)">Применить и перезапустить</button>`:`<button class=primary onclick="profApply(${id},${p.id},false)">Применить</button>`}${adm?`<button class=btn onclick="profForm(${id},${p.id})">Изменить</button><button class=btn onclick="profCopy(${id},${p.id})">Копия</button><button class="btn bad" onclick="profDelete(${id},${p.id})">Удалить</button>`:''}</div></div>`).join('');
  return `<div class=hint style="margin-bottom:14px"><b>Что такое профиль.</b> Профиль — это сохранённый вариант запуска проекта: команда, версия Java/Node и переменные окружения. Например, «Java 17» и «Java 21» или «Рабочий» и «Тестовый». Переключайтесь между ними одной кнопкой — настройки приложения заменятся на настройки профиля.</div>
  <div class=box style="margin-bottom:16px"><div class=split><div><h3>Сейчас используется</h3><small class=muted>текущие настройки приложения</small></div>${adm?`<button class=btn onclick="profSnapshot(${id})">💾 Сохранить как профиль</button>`:''}</div><div class=profrows style="margin-top:10px"><div><small>Команда запуска</small><code>${esc(a.command)}</code></div><div><small>Среда выполнения</small><span>${esc(profRtName(a.runtime_path))}</span></div><div><small>Переменные окружения</small><span>${envCount(a.env_json)?envCount(a.env_json)+' шт.':'нет'}</span></div></div></div>
  <div class=sectionhead><h3>Сохранённые профили</h3>${adm?`<button class=primary onclick="profForm(${id})">+ Новый профиль</button>`:''}</div>
  <div class=list>${cards||empty('Профилей нет. Нажмите «Сохранить как профиль», чтобы запомнить текущие настройки.')}</div>`;
}
function profSnapshot(id){modal('Сохранить текущие настройки',`<div class=form><label>Название профиля<input id=pfname placeholder="Например, Java 21 — основной"></label><label>Заметка (необязательно)<input id=pfnote></label><button class=primary onclick="profSnapSave(${id})">Сохранить</button></div>`)}
async function profSnapSave(id){try{await api(`/apps/${id}/profiles`,{method:'POST',headers:JH,body:JSON.stringify({from_current:true,name:$('pfname').value,note:$('pfnote').value})});closeModal();appWorkspace(id,'profiles')}catch(e){alert(e.message)}}
function profEnvRow(k='',v=''){return `<div class=envrow><input class=pek placeholder="ИМЯ" value="${esc(k)}"><input class=pev placeholder="значение" value="${esc(v)}"><button type=button class="btn bad" onclick="this.parentNode.remove()">×</button></div>`}
async function profForm(appId,pid){
  let p={name:'',note:'',command:'',runtime_path:'',env_json:'{}'};
  if(pid){p=(await api(`/apps/${appId}/profiles`)).find(x=>x.id===pid)||p}else{const a=await api('/apps/'+appId);p.command=a.command;p.runtime_path=a.runtime_path||'';p.env_json=a.env_json||'{}'}
  if(!profRt.length)profRt=await api('/runtimes').catch(()=>[]);
  let env={};try{env=JSON.parse(p.env_json||'{}')}catch{}
  const known=!p.runtime_path||profRt.some(r=>r.path===p.runtime_path);
  modal(pid?'Изменить профиль':'Новый профиль',`<div class=form>
    <label>Название<input id=pfname value="${esc(p.name)}" placeholder="Например, Java 17"></label>
    <label>Заметка (необязательно)<input id=pfnote value="${esc(p.note||'')}" placeholder="Для чего этот профиль"></label>
    <label>Команда запуска<input id=pfcmd value="${esc(p.command)}"></label><small class=muted style="margin-top:-6px">Это команда, которой запускается проект, например <code>java -Xmx4G -jar server.jar nogui</code>. Новый профиль уже заполнен текущей командой приложения.</small>
    <label>Среда выполнения<select id=pfrt onchange="$('pfrtc').classList.toggle('hidden',this.value!=='__c')"><option value="">По умолчанию (из PATH)</option>${profRt.map(r=>`<option value="${esc(r.path)}" ${r.path===p.runtime_path?'selected':''}>${esc(r.label)}${r.major?' '+r.major:''} — ${esc(r.version||'')}</option>`).join('')}<option value="__c" ${known?'':'selected'}>Свой путь…</option></select></label>
    <input id=pfrtc class="${known?'hidden':''}" value="${known?'':esc(p.runtime_path)}" placeholder="Путь к папке с java / node">
    <div><small class=muted>Переменные окружения</small><div id=pfenv style="margin-top:6px">${Object.entries(env).map(([k,v])=>profEnvRow(k,v)).join('')}</div><button type=button class=btn onclick="$('pfenv').insertAdjacentHTML('beforeend',profEnvRow())">+ Переменная</button></div>
    <button class=primary onclick="profSave(${appId},${pid||0})">Сохранить</button></div>`);
}
async function profSave(appId,pid){
  const env={};document.querySelectorAll('#pfenv .envrow').forEach(r=>{const k=r.querySelector('.pek').value.trim();if(k)env[k]=r.querySelector('.pev').value});
  let rt=$('pfrt').value;if(rt==='__c')rt=$('pfrtc').value.trim();
  const b={name:$('pfname').value,note:$('pfnote').value,command:$('pfcmd').value,runtime_path:rt,env};
  try{await api(pid?'/profiles/'+pid:`/apps/${appId}/profiles`,{method:pid?'PUT':'POST',headers:JH,body:JSON.stringify(b)});closeModal();appWorkspace(appId,'profiles')}catch(e){alert(e.message)}
}
async function profCopy(appId,pid){const p=(await api(`/apps/${appId}/profiles`)).find(x=>x.id===pid);if(!p)return;let env={};try{env=JSON.parse(p.env_json||'{}')}catch{}try{await api(`/apps/${appId}/profiles`,{method:'POST',headers:JH,body:JSON.stringify({name:p.name+' (копия)',note:p.note,command:p.command,runtime_path:p.runtime_path,env})});appWorkspace(appId,'profiles')}catch(e){alert(e.message)}}
async function profApply(appId,pid,restart){
  if(restart&&!confirm('Приложение будет остановлено, настройки заменены на настройки профиля, затем оно запустится снова. Продолжить?'))return;
  try{await api(`/apps/${appId}/profiles/${pid}/apply`,{method:'POST',headers:JH,body:JSON.stringify({restart})});toast(restart?'Профиль применён, приложение перезапущено':'Профиль применён');appWorkspace(appId,'profiles')}catch(e){alert(e.message)}
}
async function profDelete(appId,pid){if(confirm('Удалить профиль? Настройки приложения не изменятся.')){try{await api('/profiles/'+pid,{method:'DELETE'});appWorkspace(appId,'profiles')}catch(e){alert(e.message)}}}

/* ---------- рабочее пространство проекта ---------- */
let wsTab='overview';
async function appWorkspace(id,tab='overview'){
  activeAppId=id;wsTab=tab;clearInterval(statsTimer);clearInterval(lgTimer);
  let a;try{a=await api('/apps/'+id)}catch(e){$('content').innerHTML=`<div class=empty>${esc(e.message)}<br><br><button class=btn onclick="page('apps')">← Приложения</button></div>`;return}
  $('title').textContent=a.name;$('sub').textContent=`${a.type||'auto'} · ${a.working_dir}`;
  const op=canOp(),adm=isAdmin();
  const nav=`<div class=toolbar><button class=btn onclick="page('apps')">← Приложения</button>${op?`<button class=primary onclick="act(${id},'start')" ${a.running?'disabled':''}>Запуск</button><button class=btn onclick="act(${id},'restart')">↻ Перезапуск</button><button class=btn onclick="act(${id},'stop')" ${!a.running?'disabled':''}>Стоп</button>`:''}</div>`;
  const T=[['overview','Обзор',1],['console','Консоль',1],['files','Файлы',op],['profiles','Профили',op],['backups','Backup',op],['logs','Логи',1],['settings','Настройки',adm]].filter(t=>t[2]);
  if(!T.some(t=>t[0]===tab))tab=wsTab='overview';
  const tabs=`<div class=tabbar>${T.map(t=>`<button class="tab ${tab===t[0]?'active':''}" onclick="appWorkspace(${id},'${t[0]}')">${t[1]}</button>`).join('')}</div>`;
  let body='',after=null;
  try{
    if(tab==='overview'){const s=await api(`/apps/${id}/stats`);body=`<div class=stats><div class=stat><small>Статус</small><b>${a.running?'🟢 Запущено':'⚪ Остановлено'}</b></div><div class=stat><small>CPU</small><b id=dcpu>${s.cpu.toFixed(1)}%</b></div><div class=stat><small>RAM</small><b id=dram>${fmtSize(s.memory)}</b></div><div class=stat><small>Uptime</small><b>${fmtTime(a.uptime)}</b></div></div><div class=box><div class=two><div><small>Команда</small><code>${esc(a.command)}</code></div><div><small>Рабочая папка</small><code>${esc(a.working_dir)}</code></div></div><p><b>Runtime:</b> ${esc(a.runtime||'авто')} ${a.runtime_path?`<code>${esc(a.runtime_path)}</code>`:''}</p><p><b>Порт:</b> ${a.port||'не указан'} · <b>Автозапуск:</b> ${a.auto_start?'да':'нет'} · <b>Автоперезапуск:</b> ${a.auto_restart?'да':'нет'}</p></div><canvas id=chart width=1000 height=220 class=chart></canvas>`;after=()=>setTimeout(()=>workspaceStats(id),0)}
    else if(tab==='console'){const out=await api(`/apps/${id}/output`);body=`<div class=console><div id=detailOut class=out>${out.map(x=>esc(x.data)).join('')}</div>${op?`<div class=cin><input id=detailCmd placeholder="Команда для stdin" onkeydown="if(event.key==='Enter')sendDetail(${id})"><button onclick="sendDetail(${id})">SEND</button></div>`:''}</div>`;after=()=>{const o=$('detailOut');if(o)o.scrollTop=o.scrollHeight}}
    else if(tab==='files'){body='<div id=fmhost></div>';after=()=>{if(fmCtx.app!==id)fmCtx.path='';fmCtx.app=id;fmCtx.disk='';fmCtx.host='fmhost';fmCtx.root=a.name;fmMount()}}
    else if(tab==='profiles')body=await profTab(id,a);
    else if(tab==='backups')body=await bkTab(id,a);
    else if(tab==='logs'){body=lgTab(id);after=()=>{lgLoad(id);lgAuto(id)}}
    else{body=appForm(a)+`<div class=actions style="margin-top:16px"><button class=btn onclick="appWorkspace(${id},'backups')">Backup…</button><button class="btn bad" onclick="deleteApp(${id})">Удалить приложение</button></div>`;after=()=>lbMount(a)}
  }catch(e){body=`<div class=empty>${esc(e.message)}</div>`}
  $('content').innerHTML=nav+tabs+body;if(after)after();
}


/* ---------- Система: процессор, видеокарта, память, накопители ---------- */
function hwSize(n){if(n==null)return '—';const gb=n/1073741824;if(gb>=1024)return (gb/1024).toFixed(2)+' ТБ';if(gb>=1)return gb.toFixed(gb>=100?0:1)+' ГБ';return Math.max(0,Math.round(n/1048576))+' МБ'}
const hwNA=(why)=>`<span class=muted title="${esc(why||'Система или оборудование не сообщают это значение')}">Недоступно</span>`;
const hwCls=p=>p>=90?'crit':p>=75?'warn':'';
const hwId=m=>'hw_'+String(m).replace(/[^A-Za-z0-9]/g,'_');
const hwPct=v=>v==null?null:Math.max(0,Math.min(100,v));
const hwMeter=(id,p)=>`<div class=meter><i id="${id}" class="${hwCls(p)}" style="width:${hwPct(p)||0}%"></i></div>`;
const hwHz=m=>m==null?null:(m>=1000?(m/1000).toFixed(2)+' ГГц':m+' МГц');
let hwState={sig:'',tick:0,busy:false,auto:true};
function hwDiskSig(d){return JSON.stringify([d.disks.map(x=>[x.id,x.name,x.status,x.partitions.map(p=>p.mount)]),d.others.map(p=>p.mount)])}
function hwTypeBadge(t){return `<span class="dtype t-${t==='Не определён'?'na':t}" title="${t==='Не определён'?'Тип невозможно определить надёжно — панель не угадывает его по букве диска или скорости':'Тип определён по данным операционной системы'}">${esc(t)}</span>`}
function hwHealth(d){
  const t=d.temperature!=null?`${Math.round(d.temperature)} °C`:null,h=d.health;
  const hb=h?`<span class="hbadge ${d.smart&&d.smart.status==='ok'?'ok':d.smart&&d.smart.status==='warn'?'warn':'bad'}" title="${esc(d.smart&&d.smart.note||'')}">${esc(h)}</span>`:`<span title="${esc(d.smart&&d.smart.note||'')}">${hwNA(d.smart&&d.smart.note)}</span>`;
  return `<div class=dmeta><span>Состояние / SMART: ${hb}</span><span>Температура: ${t||hwNA('Датчик температуры недоступен или нужны права администратора')}</span>${d.powerOnHours!=null?`<span>Наработка: ${Math.round(d.powerOnHours)} ч</span>`:''}</div>`;
}
function hwPartRow(p){
  const id=hwId(p.mount),kindRu={fixed:'',removable:'съёмный',network:'сетевой',optical:'оптический',other:'прочий'}[p.kind]||'';
  const bar=p.accessible&&p.percent!=null?`${hwMeter(id+'_b',p.percent)}<small id="${id}_t" class=muted>${hwSize(p.used)} занято из ${hwSize(p.size)} · свободно <b>${hwSize(p.free)}</b> (${p.percent}%)</small>`:`<small class=muted>${esc(p.note||'Нет данных об объёме')}</small>`;
  const open=isAdmin()&&p.accessible&&p.kind!=='optical'?`<button class=btn onclick="filesOpenDisk(${jsArg(p.mount)})" title="Открыть файлы этого раздела">Открыть файлы</button>`:'';
  return `<div class=partrow><div><b>${esc(p.mount)}</b> ${p.label?esc(p.label):''}<br><small class=muted>${esc(p.fs||'')} ${kindRu?'· '+kindRu:''} ${p.system?'· системный':''} ${p.readOnly?'· только чтение':''}</small></div><div>${bar}</div><div>${open}</div></div>`;
}
function hwDiskCards(d){
  const disks=d.disks.map(k=>`<div class="hwcard diskcard ${k.status!=='ok'?'off':''}"><div class=split><div><h3>${esc(k.name)}</h3><small class=muted>${k.bus?esc(k.bus)+' · ':''}${k.removable?'съёмный · ':''}${esc(k.id)}</small></div><div class=dbadges>${hwTypeBadge(k.type)}<span class=dsize>${hwSize(k.size)}</span></div></div>${k.typeNote?`<small class=muted>${esc(k.typeNote)}</small>`:''}${k.statusNote?`<div class=hint style="margin:8px 0">${esc(k.statusNote)}</div>`:''}${hwHealth(k)}${k.partitions.length?k.partitions.map(hwPartRow).join(''):`<div class=partrow><small class=muted>${k.status==='offline'?'Диск отключён — разделы недоступны':'Нет смонтированных разделов, доступных для работы'}</small></div>`}</div>`).join('');
  const others=d.others.length?`<div class="hwcard diskcard"><h3>Сетевые и прочие тома</h3><small class=muted>Тома, не привязанные к физическому диску этого компьютера</small>${d.others.map(hwPartRow).join('')}</div>`:'';
  return disks+others||'<div class=empty>Накопители не обнаружены</div>';
}
function hwCpuCard(i){
  const c=i.cpu;
  return `<div class=hwcard><div class=split><h3>Процессор (CPU)</h3><span id=hw_cpu_val class=hwbig>—</span></div><b>${esc(c.model||'Модель не определена')}</b>
  <div class=kv><span>Ядра / потоки</span><span>${c.physicalCores?c.physicalCores+' физ.':hwNA('Число физических ядер не сообщается')} · ${c.logicalCores||'—'} потоков${c.sockets>1?` · процессоров: ${c.sockets}`:''}</span>
  <span>Частота</span><span id=hw_cpu_mhz title="" >—</span>
  ${c.maxMHz?`<span>Максимум</span><span>${hwHz(c.maxMHz)}</span>`:''}${c.cache?`<span>Кэш</span><span>${esc(c.cache)}</span>`:''}
  <span>Температура</span><span id=hw_cpu_temp>—</span></div>${hwMeter('hw_cpu_bar',0)}
  <details class=hwdet><summary>Загрузка по потокам</summary><div id=hw_cores class=cores></div></details></div>`;
}
function hwRamCard(i){return `<div class=hwcard><div class=split><h3>Оперативная память (RAM)</h3><span id=hw_ram_val class=hwbig>—</span></div><b>Всего ${hwSize(i.ram.total)}</b>${hwMeter('hw_ram_bar',0)}<div class=kv><span>Занято</span><span id=hw_ram_used>—</span><span>Свободно</span><span id=hw_ram_free>—</span><span id=hw_swap_l class=hidden>Подкачка</span><span id=hw_swap class=hidden></span></div></div>`}
function hwGpuCards(i){
  if(!i.gpus.length)return `<div class=hwcard><h3>Видеокарта (GPU)</h3><div class=muted>Видеокарты не обнаружены или система их не сообщает. Это не ошибка.</div></div>`;
  return i.gpus.map((g,n)=>`<div class="hwcard ${g.virtual?'virt':''}"><div class=split><h3>Видеокарта${i.gpus.length>1?' №'+(n+1):''}</h3><span id="hw_g${n}_val" class=hwbig>—</span></div><b>${esc(g.name||'Модель не определена')}</b>${g.virtual?' <small class=muted>виртуальный адаптер</small>':''}
  <div class=kv><span>Видеопамять</span><span id="hw_g${n}_vram">${g.vramTotal?hwSize(g.vramTotal):hwNA('Объём видеопамяти не сообщается')}</span><span>Загрузка GPU</span><span id="hw_g${n}_load">${g.live&&g.live.load?'…':hwNA('Для этой видеокарты загрузка недоступна: '+(i.platform==='win32'?'в Windows читается только у NVIDIA':'нужен драйвер с поддержкой датчиков'))}</span><span>Температура</span><span id="hw_g${n}_temp">${g.live&&g.live.temp?'…':hwNA()}</span>${g.driver?`<span>Драйвер</span><span>${esc(g.driver)}</span>`:''}</div>${g.live&&g.live.load?hwMeter(`hw_g${n}_bar`,0):''}</div>`).join('');
}
function hwApplyLive(l){
  const set=(id,h)=>{const e=$(id);if(e)e.innerHTML=h},bar=(id,p)=>{const e=$(id);if(e){e.style.width=(hwPct(p)||0)+'%';e.className=hwCls(p)}};
  if(l.cpu){set('hw_cpu_val',l.cpu.load!=null?l.cpu.load.toFixed(0)+'%':'—');bar('hw_cpu_bar',l.cpu.load);set('hw_cpu_mhz',l.cpu.mhz?`<span title="${esc(l.cpu.mhzNote||'')}">${hwHz(l.cpu.mhz)}</span>`:hwNA());set('hw_cpu_temp',l.cpu.temp!=null?Math.round(l.cpu.temp)+' °C':hwNA('Датчик процессора недоступен (нужен доступ к датчикам ОС)'));
    const cs=$('hw_cores');if(cs&&l.cpu.cores)cs.innerHTML=l.cpu.cores.slice(0,128).map((v,n)=>`<div class=core title="Поток ${n+1}: ${v.toFixed(0)}%"><i class="${hwCls(v)}" style="height:${Math.max(2,v)}%"></i></div>`).join('')}
  if(l.ram){const r=l.ram;set('hw_ram_val',(r.percent??0).toFixed(0)+'%');bar('hw_ram_bar',r.percent);set('hw_ram_used',hwSize(r.used));set('hw_ram_free',hwSize(r.free));if(r.swapTotal){$('hw_swap_l').classList.remove('hidden');$('hw_swap').classList.remove('hidden');set('hw_swap',`${hwSize(r.swapUsed)} из ${hwSize(r.swapTotal)}`)}}
  (l.gpus||[]).forEach((g,n)=>{const gi=window._hw.info.gpus[n];if(!gi)return;const lv=gi.live||{};
    if(lv.load){set(`hw_g${n}_val`,g.load!=null?g.load+'%':'—');set(`hw_g${n}_load`,g.load!=null?g.load+'%':hwNA());bar(`hw_g${n}_bar`,g.load)}else set(`hw_g${n}_val`,'');
    if(lv.temp)set(`hw_g${n}_temp`,g.temp!=null?Math.round(g.temp)+' °C':hwNA());
    if(g.vramTotal)set(`hw_g${n}_vram`,g.vramUsed!=null?`${hwSize(g.vramUsed)} из ${hwSize(g.vramTotal)}`:hwSize(g.vramTotal))});
}
function hwApplySpace(d){
  for(const p of [...d.disks.flatMap(x=>x.partitions),...d.others]){const id=hwId(p.mount),b=$(id+'_b'),t=$(id+'_t');if(!b||p.percent==null)continue;b.style.width=p.percent+'%';b.className=hwCls(p.percent);if(t)t.innerHTML=`${hwSize(p.used)} занято из ${hwSize(p.size)} · свободно <b>${hwSize(p.free)}</b> (${p.percent}%)`}
}
function hwDisksSection(d){
  return `<div class=sectionhead><h3>Накопители (HDD / SSD / NVMe)</h3><div class=actions><label class=checkline style="margin:0" title="Каждые 2 минуты проверять, не подключили ли новый диск"><input type=checkbox id=hwauto ${hwState.auto?'checked':''} onchange="hwState.auto=this.checked"> искать новые диски автоматически</label><button class=btn id=hwrescan onclick=hwRescan()>⟳ Обновить список дисков</button></div></div>
  ${(d.errors||[]).map(e=>`<div class=hint style="margin-bottom:10px">⚠ ${esc(e)}</div>`).join('')}<div class=hwgrid id=hwdisks>${hwDiskCards(d)}</div><small class=muted id=hwscan>Список обновлён: ${new Date(d.scannedAt).toLocaleTimeString()}. Объёмы показаны в ГБ/ТБ по 1024 (как в Windows).</small>`;
}
async function hwRescan(){
  const b=$('hwrescan');if(b){b.disabled=true;b.textContent='Сканирую…'}
  try{const d=await api('/hw/disks?refresh=1');fmDiskList=d;hwState.sig=hwDiskSig(d);window._hw.disks=d;const box=$('hwdisksec');if(box)box.innerHTML=hwDisksSection(d);toast('Список дисков обновлён')}
  catch(e){toast('Не удалось обновить: '+e.message,true);if(b){b.disabled=false;b.textContent='⟳ Обновить список дисков'}}
}
async function systemPage(){
  clearInterval(statsTimer);
  $('content').innerHTML='<div class=empty><div class=pbar style="max-width:240px;margin:0 auto 10px"><i class=busy></i></div>Собираю сведения об оборудовании…</div>';
  let info,disks;
  try{[info,disks]=await Promise.all([api('/hw/info'),api('/hw/disks')])}catch(e){$('content').innerHTML=`<div class=empty>Не удалось получить данные: ${esc(e.message)}<br><br><button class=btn onclick=systemPage()>Повторить</button></div>`;return}
  window._hw={info,disks};fmDiskList=disks;hwState={sig:hwDiskSig(disks),tick:0,busy:false,auto:hwState.auto};
  $('content').innerHTML=`<div id=hwroot><div class=hwgrid>${hwCpuCard(info)}${hwRamCard(info)}${hwGpuCards(info)}</div>
  ${info.notes&&info.notes.length?`<details class=hwdet style="margin:6px 0 18px"><summary>О точности данных</summary>${info.notes.map(n=>`<div class=muted style="margin:6px 0">• ${esc(n)}</div>`).join('')}<div class=muted style="margin:6px 0">• Если значение не получено, показано «Недоступно» — панель ничего не придумывает.</div></details>`:''}
  <div id=hwdisksec>${hwDisksSection(disks)}</div><div id=hwerr class=err></div></div>`;
  hwTick(true);
  statsTimer=setInterval(()=>hwTick(),3000);
}
async function hwTick(first){
  if(!$('hwroot')){clearInterval(statsTimer);return}
  if(document.hidden||hwState.busy)return;
  hwState.busy=true;const n=hwState.tick++;
  try{
    const l=await api('/hw/live?gpu='+(first||n%2===0?1:0));hwApplyLive(l);$('hwerr').textContent='';
    if(!first&&n%5===0){ // свободное место — раз в ~15 с
      const d=await api('/hw/disks?mode=space');window._hw.disks=d;hwApplySpace(d)}
    if(!first&&hwState.auto&&n%40===0&&n>0){ // новые диски — раз в ~2 мин
      const d=await api('/hw/disks');if(hwDiskSig(d)!==hwState.sig){hwState.sig=hwDiskSig(d);fmDiskList=d;window._hw.disks=d;$('hwdisksec').innerHTML=hwDisksSection(d);toast('Список дисков изменился')}}
  }catch(e){const x=$('hwerr');if(x)x.textContent='Не удалось обновить показатели: '+e.message}
  finally{hwState.busy=false}
}
