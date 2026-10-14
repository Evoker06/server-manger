// Server Manager: несколько серверов и пользователей в одной панели.
// Подключается в index.html ПЕРЕД app.js. Использует глобалы app.js
// (node, nodeList, me, api, modal, closeModal, esc, $, toolbar, page, ...) только во время вызова.
(function(){
let localOk=true,discTimer=null,usersCache=[],pairTarget=null;
const ROLE={admin:'Администратор',operator:'Оператор',viewer:'Наблюдатель'};
const genToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const jsonOpt=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const el=(tag,props,...kids)=>{const e=document.createElement(tag);Object.assign(e,props||{});for(const k of kids)e.append(k);return e};

function renderNodeSel(){
  const s=document.getElementById('nodeSel');if(!s)return;
  s.innerHTML=(localOk?'<option value="local">🖥 Эта панель</option>':'')+nodeList.map(n=>`<option value="${n.id}">🌐 ${esc(n.name)}</option>`).join('');
  s.value=node;
}
function applyRole(){
  const a=document.getElementById('app');if(!a||!me)return;
  a.classList.toggle('nonadmin',me.role!=='admin');
  a.classList.toggle('role-viewer',me.role==='viewer');
}

window.loadNodes=async function(){
  try{const r=await api('/nodes');nodeList=r.nodes||[];localOk=r.local!==false}catch{nodeList=[];localOk=true}
  const valid=node==='local'?localOk:nodeList.some(n=>String(n.id)===String(node));
  if(!valid){node=localOk?'local':(nodeList[0]?String(nodeList[0].id):'local');localStorage.sm_node=node}
  renderNodeSel();applyRole();
};

window.switchNode=function(id){
  node=String(id||'local');localStorage.sm_node=node;renderNodeSel();
  activeAppId=null;pathNow='';appCache=[];
  const old=ws;ws=null;if(old){old.onclose=null;try{old.close()}catch{}}
  connectWS();
  const cur=String(currentPage);
  page(cur.startsWith('app:')?'dash':cur);
};

/* ---------------- Серверы ---------------- */
window.nodesPage=async function(){
  clearInterval(statsTimer);
  await loadNodes();
  const sel=id=>String(id)===String(node)?' <small>(выбран)</small>':'';
  const rows=nodeList.map(n=>`<tr><td><b>${esc(n.name)}</b>${sel(n.id)}</td><td><code>${esc(n.url)}</code></td><td id="nst-${n.id}" class="muted">проверка…</td><td><div class=actions><button class=btn onclick="switchNode(${n.id});page('dash')">Открыть</button><button class=btn onclick="nodeForm(${n.id})">Изменить</button><button class="btn bad" onclick="nodeDelete(${n.id})">Удалить</button></div></td></tr>`).join('');
  $('content').innerHTML=toolbar(`<button class=primary onclick="nodeForm()">+ Добавить сервер</button><button class=btn onclick="nodesPage()">↻ Проверить связь</button>`)
    +`<table class=table><tr><th>Имя</th><th>Адрес</th><th>Статус</th><th></th></tr>`
    +`<tr><td><b>Эта панель</b>${sel('local')}</td><td><code>локально</code></td><td><span class="status good"><i class="dot on"></i>online</span></td><td><div class=actions><button class=btn onclick="switchNode('local');page('dash')">Открыть</button></div></td></tr>${rows}</table>`
    +`<div class=hint style="margin-top:18px"><b>Как подключить компьютер с серверами (без панели на нём)</b><br>1. На нём в <code>config.json</code>: <code>"agent": true, "agentOnly": true, "host": "0.0.0.0"</code>, запустите. Интерфейса там не будет — только «точка управления». В консоли появится <b>КОД ПОДКЛЮЧЕНИЯ</b> и адрес компьютера.<br>2. Здесь «+ Добавить сервер»: выберите найденный компьютер или введите его IP и порт и код. Токен вводить не нужно.<br>3. Людям выдавайте доступ на странице «Пользователи» этой панели: роль и список серверов. С каких IP они заходят, неважно. Не раздавайте код подключения: у кого он есть, тот получает полное управление компьютером.</div>`;
  try{
    for(const s of await api('/nodes/status')){
      const e=$('nst-'+s.id);if(!e)continue;
      e.innerHTML=s.ok?`<span class="status good"><i class="dot on"></i>online · ${s.ms} мс</span>`:`<span class="status" style="color:var(--bad)"><i class="dot"></i>${esc(s.error||'offline')}</span>`;
    }
  }catch{}
};

function discoverLoop(){
  clearInterval(discTimer);
  const tick=async()=>{
    const box=document.getElementById('ndisc');
    if(!box){clearInterval(discTimer);return}
    try{
      const list=await api('/nodes/discover');
      box.replaceChildren();
      if(!list.length){box.append(el('span',{className:'muted',textContent:'Пока никого не видно. Убедитесь, что на том компьютере запущен агент и он в этой же сети. Или добавьте вручную ниже.'}));return}
      for(const d of list){
        const b=el('button',{className:'primary',type:'button',textContent:'Подключить'});
        b.onclick=()=>nodePairForm(d.ip,d.port,d.name||d.ip);
        const info=el('div',{});info.append(el('b',{textContent:d.name||d.ip}),el('br'),el('small',{textContent:`${d.ip}:${d.port}`}));
        box.append(el('div',{className:'item'},info,b));
      }
    }catch{}
  };
  tick();discTimer=setInterval(tick,3000);
}

window.nodeForm=function(id){
  const n=id?nodeList.find(x=>x.id===id):null;
  modal(n?'Изменить сервер':'Добавить сервер',
    (n?'':`<div class=box style="margin-bottom:16px"><h3>Найдено в сети</h3><div id=ndisc class=list><span class=muted>Ищу компьютеры…</span></div><small>Нужен агент с <code>"agent": true</code> и код из его консоли.</small></div>
    <div class=box style="margin-bottom:16px"><h3>По IP и коду (в том числе через интернет)</h3><div class=two><label>Адрес компьютера<input id=maddr placeholder="203.0.113.5:3000" autocomplete=off></label><label>Код подключения<input id=mcode placeholder="ABCD-EFGH" maxlength=9 autocomplete=off></label></div><div id=merr style="color:var(--bad);margin:8px 0"></div><button type=button class=primary onclick="nodePairManual()">Подключить</button></div>
    <h3>Или вручную по токену</h3>`)
    +`<form id=nf class=form>
    <label>Название<input name=name value="${esc(n?.name||'')}" placeholder="Сервер Minecraft" required></label>
    <label>Адрес агента<input name=url value="${esc(n?.url||'')}" placeholder="http://192.168.1.50  или  http://192.168.1.50:3000"></label>
    <label>Токен агента${n?' (пусто — не менять)':''}<div class=inline><input name=token id=ntoken autocomplete=off placeholder="agentToken из config.json агента"><button type=button class=btn onclick="nodeGenToken()">Создать</button></div></label>
    <div class=hint>Для ручного режима в <code>config.json</code> агента: <code id=nsnip>"agentToken": "…"</code></div>
    <div id=ntest class=muted></div>
    <div class=actions><button type=button class=btn onclick="nodeTest(${n?n.id:0})">Проверить связь</button><button type=button class=primary onclick="nodeSave(${n?n.id:0})">Сохранить</button></div>
  </form>`);
  $('ntoken').addEventListener('input',nodeSnip);
  if(!n)discoverLoop();
};
function nodeSnip(){const v=$('ntoken').value.trim();$('nsnip').textContent=`"agentToken": "${v||'…'}"`}
window.nodeGenToken=function(){$('ntoken').value=genToken();nodeSnip()};

window.nodePairForm=function(ip,port,name){
  pairTarget={ip,port};
  modal('Подключение: '+name,`<form id=pf class=form>
    <div class=hint>Код показан в окне консоли (PowerShell) на компьютере <b>${esc(name)}</b> (${esc(ip)}). Он выглядит как <code>ABCD-EFGH</code> и действует один раз.</div>
    <label>Код подключения<input name=code id=pcode autocomplete=off maxlength=9 placeholder="ABCD-EFGH" style="text-transform:uppercase;letter-spacing:.2em;font-size:18px"></label>
    <label>Название в панели<input name=name value="${esc(name)}"></label>
    <div id=perr style="color:var(--bad)"></div>
    <div class=actions><button type=button class=btn onclick="nodeForm()">← Назад</button><button type=button class=primary onclick="nodePairDo()">Подключить</button></div>
  </form>`);
  $('pcode').focus();
  $('pcode').addEventListener('keydown',e=>{if(e.key==='Enter')nodePairDo()});
};
window.nodePairManual=async function(){
  const raw=$('maddr').value.trim().replace(/^https?:\/\//i,'').replace(/\/+$/,'');
  const m=/^(.+?)(?::(\d{1,5}))?$/.exec(raw);
  if(!m||!m[1]){$('merr').textContent='Введите адрес, например 203.0.113.5:3000';return}
  $('merr').textContent='Подключаю…';
  try{await api('/nodes/pair',jsonOpt('POST',{ip:m[1],port:m[2]?+m[2]:80,code:$('mcode').value}));closeModal();nodesPage()}
  catch(e){$('merr').textContent=e.message}
};
window.nodePairDo=async function(){
  const f=Object.fromEntries(new FormData($('pf')));
  $('perr').textContent='Подключаю…';
  try{
    await api('/nodes/pair',jsonOpt('POST',{ip:pairTarget.ip,port:pairTarget.port,code:f.code,name:f.name}));
    closeModal();nodesPage();
  }catch(e){$('perr').textContent=e.message}
};

const formData=()=>Object.fromEntries(new FormData($('nf')));
window.nodeTest=async function(id){
  const b=formData(),out=$('ntest');out.textContent='Проверка…';
  try{
    const r=await api('/nodes/test',jsonOpt('POST',{id:id||undefined,url:b.url,token:b.token}));
    out.innerHTML=r.ok?`<span class="status good"><i class="dot on"></i>Связь есть · ${r.ms} мс · CPU ${(+r.system?.cpu||0).toFixed(0)}% · ${r.system?.cores||'?'} потоков</span>`:`<span style="color:var(--bad)">✗ ${esc(r.error||'нет связи')}</span>`;
  }catch(e){out.innerHTML=`<span style="color:var(--bad)">✗ ${esc(e.message)}</span>`}
};
window.nodeSave=async function(id){
  const b=formData();
  try{await api(id?'/nodes/'+id:'/nodes',jsonOpt(id?'PUT':'POST',b));closeModal();nodesPage()}
  catch(e){alert(e.message)}
};
window.nodeDelete=async function(id){
  if(!confirm('Удалить сервер из панели? Сам удалённый ПК и его процессы не затрагиваются.'))return;
  try{
    await api('/nodes/'+id,{method:'DELETE'});
    if(String(node)===String(id))switchNode('local');else nodesPage();
  }catch(e){alert(e.message)}
};

/* ---------------- Пользователи ---------------- */
window.usersPage=async function(){
  clearInterval(statsTimer);
  const [users]=await Promise.all([api('/users'),loadNodes()]);
  usersCache=users;
  const nm=k=>k==='local'?'Эта панель':(nodeList.find(n=>String(n.id)===String(k))?.name||'?');
  const rows=users.map(u=>`<tr><td><b>${esc(u.username)}</b>${u.id===me.id?' <small>(это вы)</small>':''}</td><td>${esc(ROLE[u.role]||u.role)}</td><td>${u.role==='admin'?'<span class=muted>все серверы</span>':(u.nodes.length?u.nodes.map(k=>esc(nm(k))).join(', '):'<span class=muted>нет доступа</span>')}</td><td><div class=actions><button class=btn onclick="userForm(${u.id})">Изменить</button>${u.id===me.id?'':`<button class="btn bad" onclick="userDelete(${u.id})">Удалить</button>`}</div></td></tr>`).join('');
  $('content').innerHTML=toolbar(`<button class=primary onclick="userForm()">+ Добавить пользователя</button>`)
    +`<table class=table><tr><th>Логин</th><th>Роль</th><th>Доступ к серверам</th><th></th></tr>${rows}</table>`
    +`<div class=hint style="margin-top:18px"><b>Роли</b><br><b>Наблюдатель</b> — видит приложения, их состояние, консоль и логи; ничего не меняет.<br><b>Оператор</b> — ещё запускает, останавливает и перезапускает приложения, пишет в консоль, делает backup и работает с файлами в папке сервера. Учтите: кто может менять файлы, тот может изменить и скрипт запуска.<br><b>Администратор</b> — всё: приложения, Docker, задачи, серверы, пользователи.<br><br>Каждому пользователю отдельно выдаётся доступ к серверам (к этой панели и/или к подключённым компьютерам).</div>`;
};
window.userForm=function(id){
  const u=id?usersCache.find(x=>x.id===id):null;
  const items=[['local','Эта панель (локальные приложения и файлы)'],...nodeList.map(n=>[String(n.id),n.name])];
  const boxes=items.map(([k,l])=>`<label class=checkline><input type=checkbox name=nodes value="${esc(k)}" ${u&&u.nodes.includes(k)?'checked':''}> ${esc(l)}</label>`).join('');
  modal(u?'Пользователь '+u.username:'Новый пользователь',`<form id=uf class=form>
    <label>Логин<input name=username value="${esc(u?.username||'')}" ${u?'readonly':''} placeholder="например, ivan" autocomplete=off></label>
    <label>Пароль${u?' (пусто — не менять)':' (минимум 8 символов)'}<input name=password type=password autocomplete=new-password></label>
    <label>Роль<select name=role>${Object.entries(ROLE).map(([k,v])=>`<option value="${k}" ${(u?.role||'operator')===k?'selected':''}>${v}</option>`).join('')}</select></label>
    <div><div class=muted style="margin-bottom:6px">Доступ к серверам (у администратора — ко всем)</div><div class=list>${boxes||'<span class=muted>нет серверов</span>'}</div></div>
    <div class=actions><button type=button class=primary onclick="userSave(${u?u.id:0})">Сохранить</button></div>
  </form>`);
};
window.userSave=async function(id){
  const f=new FormData($('uf'));
  const body={role:f.get('role'),nodes:f.getAll('nodes')};
  if(!id)body.username=String(f.get('username')||'').trim();
  if(f.get('password'))body.password=f.get('password');
  try{await api(id?'/users/'+id:'/users',jsonOpt(id?'PUT':'POST',body));closeModal();usersPage()}
  catch(e){alert(e.message)}
};
window.userDelete=async function(id){
  const u=usersCache.find(x=>x.id===id);
  if(!confirm(`Удалить пользователя ${u?u.username:''}? Он сразу потеряет доступ.`))return;
  try{await api('/users/'+id,{method:'DELETE'});usersPage()}catch(e){alert(e.message)}
};

/* ---------------- Понятные заглушки вместо пустых страниц ---------------- */
window.addEventListener('unhandledrejection',e=>{
  const m=String(e.reason?.message||'');
  const c=document.getElementById('content');if(!c)return;
  if(!localOk&&!nodeList.length&&/Недостаточно прав|Требуется авторизация/.test(m)&&me){
    c.innerHTML=`<div class=empty><b>Пока нет доступа ни к одному серверу</b><br><br>Попросите администратора выдать вам доступ.</div>`;return;
  }
  if(node==='local'||!/(недоступен|отклонил)/i.test(m))return;
  c.innerHTML=`<div class=empty><b>Удалённый сервер не отвечает</b><br><br>${esc(m)}<br><br><div class=actions style="justify-content:center"><button class=primary onclick="refreshCurrent()">Повторить</button>${localOk?`<button class=btn onclick="switchNode('local')">Эта панель</button>`:''}${me&&me.role==='admin'?`<button class=btn onclick="page('nodes')">Серверы</button>`:''}</div></div>`;
});
})();
