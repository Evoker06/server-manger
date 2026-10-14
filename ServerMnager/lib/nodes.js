'use strict';
// Удалённые серверы, пользователи с ролями, автопоиск и подключение по коду.
//  • Панель:  список нод, прокси /api/n/<id>/..., пользователи и права, поиск агентов в сети.
//  • Агент:   обычный Server Manager с "agent": true (или agentToken) в config.json.
const http=require('http'),https=require('https'),crypto=require('crypto'),fs=require('fs'),path=require('path'),os=require('os');
const discovery=require('./discovery');

const TIMEOUT_LONG=10*60*1000; // backup/загрузка могут отвечать долго
const TIMEOUT_PING=4000;
const IPV4=/^\d{1,3}(\.\d{1,3}){3}$/;

const sendJson=(r,code,obj)=>{if(r.headersSent)return;r.writeHead(code,{'content-type':'application/json; charset=utf-8'});r.end(JSON.stringify(obj))};

function friendly(e){
  const c=e&&e.code,m=String(e&&e.message||e);
  if(c==='ECONNREFUSED')return 'соединение отклонено (агент не запущен или порт закрыт)';
  if(c==='ENOTFOUND'||c==='EAI_AGAIN')return 'адрес не найден (проверьте IP/имя)';
  if(c==='EHOSTUNREACH'||c==='ENETUNREACH'||c==='ETIMEDOUT')return 'хост недоступен (проверьте IP, firewall, VPN)';
  if(c==='ECONNRESET')return 'соединение разорвано';
  if(/CERT|SSL|TLS/i.test(String(c)+m))return 'ошибка TLS-сертификата';
  return m;
}

function normalizeUrl(raw){
  let s=String(raw||'').trim();
  if(!s)throw new Error('Укажите адрес сервера');
  if(/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)&&!/^https?:\/\//i.test(s))throw new Error('Поддерживаются только http:// и https://');
  if(!/^https?:\/\//i.test(s))s='http://'+s;
  let u;try{u=new URL(s)}catch{throw new Error('Некорректный адрес')}
  if(!['http:','https:'].includes(u.protocol)||!u.hostname)throw new Error('Некорректный адрес');
  return u.origin+u.pathname.replace(/\/+$/,'');
}

function target(n,p){
  const b=new URL(n.url),tls=b.protocol==='https:';
  return {lib:tls?https:http,opts:{hostname:b.hostname.replace(/^\[|\]$/g,''),port:b.port||(tls?443:80),path:b.pathname.replace(/\/+$/,'')+p}};
}

/** Небольшой JSON-клиент для служебных вызовов (pair/verify). */
function requestJson(n,method,p,body,headers,timeout=5000){
  return new Promise(resolve=>{
    let t;try{t=target(n,p)}catch(e){return resolve({status:0,error:e.message})}
    const data=body==null?null:Buffer.from(JSON.stringify(body));
    const h={...(headers||{}),...(data?{'content-type':'application/json','content-length':data.length}:{})};
    const rq=t.lib.request({...t.opts,method,headers:h,timeout},res=>{
      let s='';res.setEncoding('utf8');
      res.on('data',c=>{if(s.length<65536)s+=c});
      res.on('end',()=>{let j=null;try{j=JSON.parse(s)}catch{}resolve({status:res.statusCode,json:j})});
    });
    rq.on('timeout',()=>rq.destroy(new Error('нет ответа (таймаут)')));
    rq.on('error',e=>resolve({status:0,error:friendly(e)}));
    rq.end(data);
  });
}

/** Проверка связи и токена: GET /api/system на агенте. */
function ping(n){
  return new Promise(resolve=>{
    const t0=Date.now();let t;
    try{t=target(n,'/api/system')}catch(e){return resolve({ok:false,error:e.message})}
    const rq=t.lib.request({...t.opts,method:'GET',headers:{authorization:'Bearer '+n.token},timeout:TIMEOUT_PING},res=>{
      let body='';res.setEncoding('utf8');
      res.on('data',c=>{if(body.length<65536)body+=c});
      res.on('end',()=>{
        if(res.statusCode===401)return resolve({ok:false,error:'агент отклонил токен (agentToken в config.json агента)'});
        if(res.statusCode!==200)return resolve({ok:false,error:'HTTP '+res.statusCode});
        let sys;try{sys=JSON.parse(body)}catch{return resolve({ok:false,error:'ответ не похож на Server Manager'})}
        resolve({ok:true,ms:Date.now()-t0,system:sys});
      });
    });
    rq.on('timeout',()=>rq.destroy(new Error('нет ответа (таймаут)')));
    rq.on('error',e=>resolve({ok:false,error:friendly(e)}));
    rq.end();
  });
}

/** Проверяет, что по адресу действительно агент с нашим токеном (HMAC-ответ на случайный nonce), и возвращает его id. */
async function verifyAgent(n,token,expectedId){
  const nonce=crypto.randomBytes(16).toString('hex');
  const r=await requestJson(n,'POST','/api/agent/verify',{nonce},null,3000);
  if(r.status!==200||!r.json||typeof r.json.proof!=='string')return null;
  const a=Buffer.from(r.json.proof),b=Buffer.from(crypto.createHmac('sha256',token).update(nonce).digest('hex'));
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
  if(expectedId&&r.json.id!==expectedId)return null;
  return String(r.json.id||'');
}

/** Пересылает запрос q (IncomingMessage) на агента, ответ стримится в r. rest — путь после /api/n/<id>. */
function forward(n,q,r,rest,who){
  let t;
  try{
    rest=String(rest||'/');
    const u=new URL('http://x'+(rest.startsWith('/')?rest:'/'+rest)); // конкатенация, а не base: «//x» не превратится в хост
    u.searchParams.delete('token');                                    // JWT панели агенту не нужен
    t=target(n,'/api'+u.pathname.replace(/\/+$/,'')+u.search);         // '/api' добавляется ПОСЛЕ нормализации — выйти из /api нельзя
  }catch(e){return sendJson(r,400,{error:e.message})}
  const headers={...q.headers};
  for(const h of ['host','connection','authorization','cookie','upgrade','x-forwarded-for','x-forwarded-host','x-forwarded-proto'])delete headers[h];
  headers.authorization='Bearer '+n.token;
  headers['x-panel-user']=encodeURIComponent(who||'admin');
  const pr=t.lib.request({...t.opts,method:q.method,headers,timeout:TIMEOUT_LONG},pres=>{
    // 401 агента ≠ «сессия панели истекла»: иначе клиент разлогинит пользователя
    if(pres.statusCode===401){pres.resume();return sendJson(r,502,{error:`Сервер «${n.name}» отклонил токен: проверьте agentToken`})}
    r.writeHead(pres.statusCode,pres.headers);
    pres.on('error',()=>r.destroy());
    pres.pipe(r);
  });
  pr.on('timeout',()=>pr.destroy(new Error('нет ответа (таймаут)')));
  pr.on('error',e=>{if(!r.headersSent)sendJson(r,502,{error:`Сервер «${n.name}» недоступен: ${friendly(e)}`});else r.destroy()});
  r.on('close',()=>{if(!r.writableEnded)pr.destroy()});
  q.pipe(pr);
}

/* ---------------- Роли и права ---------------- */
// admin — всё. operator — управление приложениями, консоль, файлы, backup. viewer — только просмотр.
// Всё, чего нет в списках, для не-админов ЗАПРЕЩЕНО (default deny).
const ROLES=['admin','operator','viewer'];
const VIEW=[['GET',/^\/apps$/],['GET',/^\/apps\/[^/]+$/],['GET',/^\/apps\/[^/]+\/(output|stats|log)$/],['GET',/^\/system$/]];
const OPERATE=[...VIEW,
  ['POST',/^\/apps\/[^/]+\/(start|stop|kill|restart|command|backup|restore)$/],['DELETE',/^\/apps\/[^/]+\/log$/],
  ['GET',/^\/apps\/[^/]+\/profiles$/],['POST',/^\/apps\/[^/]+\/profiles\/[^/]+\/apply$/],['GET',/^\/backups$/],
  ['GET',/^\/(files|file|download)$/],['POST',/^\/(file|upload|mkdir|rename)$/],['DELETE',/^\/file$/]];
const ALWAYS_LOCAL=[['GET',/^\/me$/],['POST',/^\/password$/],['GET',/^\/nodes$/],['GET',/^\/nodes\/status$/]];

/** Разрешён ли запрос роли. p — нормализованный путь БЕЗ /api. local — запрос к самой панели (не к агенту). */
function can(role,method,p,local){
  if(role==='admin')return true;
  method=method==='HEAD'?'GET':method;
  p=String(p).replace(/\/+$/,'')||'/';
  const test=l=>l.some(([m,re])=>m===method&&re.test(p));
  if(local&&test(ALWAYS_LOCAL))return true;
  return test(role==='operator'?OPERATE:role==='viewer'?VIEW:[]);
}

function listenError(e,port,host){
  const win=process.platform==='win32';
  if(e&&e.code==='EADDRINUSE'){
    console.error(`\n✗ Порт ${port} уже занят другой программой — панель не запущена.`);
    if(win){
      console.error(`  Кто занял порт:  netstat -ano | findstr :${port}`);
      console.error('  Что за процесс:  tasklist /fi "PID eq <число из последнего столбца>"');
      if(port===80)console.error('  На 80 порту чаще всего: IIS («Служба публикации в Интернете»), XAMPP/Apache/nginx, Skype, ещё одна копия панели.\n  Если PID = 4 (System) — это http.sys; остановите IIS командой  iisreset /stop  (PowerShell от администратора).');
    }else console.error(`  Кто занял порт:  sudo ss -ltnp | grep :${port}`);
    console.error('  Или укажите другой порт ("port") в config.json.');
  }else if(e&&e.code==='EACCES'){
    console.error(`\n✗ Нет прав слушать порт ${port}.`);
    if(win)console.error('  Запустите PowerShell «от имени администратора». Если не помогло, порт может быть зарезервирован системой:\n  netsh int ipv4 show excludedportrange protocol=tcp');
    else console.error('  Порты < 1024 требуют прав. Разрешите Node без root:\n  sudo setcap \'cap_net_bind_service=+ep\' "$(readlink -f "$(which node)")"');
    console.error('  Или укажите другой порт ("port") в config.json.');
  }else if(e&&e.code==='EADDRNOTAVAIL'){
    console.error(`\n✗ Адрес "${host}" не принадлежит этому компьютеру. Поставьте "host": "0.0.0.0" в config.json.`);
  }else console.error(e);
  process.exit(1);
}

function create({db,cfg,express,jwt,bcrypt,auth,admin,audit,app}){
  db.exec(`CREATE TABLE IF NOT EXISTS nodes(id INTEGER PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,token TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  try{db.exec('ALTER TABLE nodes ADD COLUMN agent_id TEXT')}catch{}
  db.exec(`CREATE TABLE IF NOT EXISTS user_nodes(user_id INTEGER NOT NULL,node TEXT NOT NULL,PRIMARY KEY(user_id,node))`);
  const getNode=id=>db.prepare('SELECT * FROM nodes WHERE id=?').get(+id);
  const pub=n=>({id:n.id,name:n.name,url:n.url});
  const json=express.json({limit:'1mb'});
  const hasAccess=(uid,node)=>!!db.prepare('SELECT 1 FROM user_nodes WHERE user_id=? AND node=?').get(uid,String(node));
  // Админу можно всё. Остальным: служебные запросы (/me, /password, список серверов) — всегда, остальное — только при выданном доступе к этому серверу И подходящей роли.
  const authorize=(u,nodeId,method,p)=>{
    if(u.role==='admin')return true;
    if(nodeId==='local'&&can('none',method,p,true))return true;
    return hasAccess(u.id,nodeId)&&can(u.role,method,p,false);
  };

  /* ================= сторона АГЕНТА ================= */
  const agentMode=cfg.agent===true||!!cfg.agentToken;
  if(agentMode){
    let dirty=false;
    if(!cfg.agentToken){cfg.agentToken=crypto.randomBytes(32).toString('hex');dirty=true}
    if(!cfg.agentId){cfg.agentId=crypto.randomBytes(8).toString('hex');dirty=true}
    if(dirty)try{ // сохраняем, чтобы токен и id не менялись при перезапуске
      const p=path.join(__dirname,'..','config.json'),cur=JSON.parse(fs.readFileSync(p,'utf8'));
      cur.agentToken=cfg.agentToken;cur.agentId=cfg.agentId;fs.writeFileSync(p,JSON.stringify(cur,null,2));
    }catch(e){console.warn('[agent] не удалось сохранить config.json ('+e.message+') — токен будет меняться при каждом запуске')}
  }
  const AGENT_TOKEN=typeof cfg.agentToken==='string'&&cfg.agentToken.length>=24?cfg.agentToken:'';
  if(cfg.agentToken&&!AGENT_TOKEN)console.warn('[agent] agentToken короче 24 символов — режим агента ВЫКЛЮЧЕН');
  const agentName=String(cfg.agentName||os.hostname()).slice(0,60);

  function isAgentToken(t){
    if(!AGENT_TOKEN||typeof t!=='string')return false;
    const a=Buffer.from(t),b=Buffer.from(AGENT_TOKEN);
    return a.length===b.length&&crypto.timingSafeEqual(a,b);
  }
  function agentUser(req){
    let who='panel';
    try{const h=req&&req.headers&&req.headers['x-panel-user'];if(h)who=decodeURIComponent(String(h)).replace(/[^\w.\-@ а-яА-ЯёЁ]/g,'').slice(0,40)||'panel'}catch{}
    return {id:0,username:'panel:'+who,role:'admin'};
  }

  if(AGENT_TOKEN){
    if(cfg.agentOnly){
      // Только «точка управления»: ни входа по паролю, ни страниц панели. Доступны лишь /api (по токену) и /ws.
      app.post('/api/login',(q,r)=>sendJson(r,403,{error:'Этот сервер работает только как агент'}));
      app.use((q,r,next)=>{
        if(/^\/(api|ws)(\/|\?|$)/i.test(q.url))return next();
        if(q.method==='GET'&&/^\/(\?.*)?$/.test(q.url)){r.writeHead(200,{'content-type':'text/plain; charset=utf-8'});return r.end('Server Manager Agent: на этом компьютере нет интерфейса. Управление идёт из панели Server Manager.\n')}
        sendJson(r,404,{error:'Not found'});
      });
    }
    const pairing=discovery.makePairing({onNew:(code,ttl)=>console.log(`\n[agent] КОД ПОДКЛЮЧЕНИЯ: ${code}   (введите его в панели; одноразовый, действует ${Math.round(ttl/60000)} мин)\n`)});
    app.post('/api/agent/pair',json,(q,r)=>{
      const x=pairing.tryCode(q.body&&q.body.code);
      if(!x.ok)return r.status(x.status).json({error:x.error});
      console.log('[agent] панель подключена по коду');
      r.json({token:AGENT_TOKEN,id:cfg.agentId,name:agentName});
    });
    app.post('/api/agent/verify',json,(q,r)=>{
      const nonce=String((q.body&&q.body.nonce)||'').slice(0,128);
      if(!nonce)return r.status(400).json({error:'nonce'});
      r.json({id:cfg.agentId,proof:crypto.createHmac('sha256',AGENT_TOKEN).update(nonce).digest('hex')});
    });
    if(cfg.announce!==false)discovery.startAnnouncer({id:cfg.agentId,name:agentName,port:cfg.port||3000});
    console.log(`[agent] режим агента включён${cfg.agentOnly?' (без интерфейса)':''}, имя «${agentName}»${cfg.announce!==false?', его видно в локальной сети':' (скрыт от автопоиска)'}`);
  }

  /* ================= защита входа ================= */
  const fails=new Map();
  app.post('/api/login',(q,r,next)=>{
    const ip=(q.socket&&q.socket.remoteAddress)||'?',now=Date.now();
    const a=(fails.get(ip)||[]).filter(t=>now-t<600000);
    if(a.length>=15){fails.set(ip,a);return sendJson(r,429,{error:'Слишком много неудачных попыток входа. Подождите 10 минут'})}
    if(fails.size>2000)fails.clear();
    fails.set(ip,a);
    r.on('finish',()=>{if(r.statusCode===401)fails.set(ip,[...(fails.get(ip)||[]),Date.now()]);else if(r.statusCode===200)fails.delete(ip)});
    next();
  });

  /* ================= права доступа (для ВСЕХ запросов к /api) ================= */
  function userOf(q){
    let t=(q.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!t&&q.path==='/download'&&q.query&&q.query.token)t=String(q.query.token); // ссылка на скачивание в браузере
    if(isAgentToken(t))return agentUser(q);
    const d=jwt.verify(t,cfg.jwtSecret);
    return db.prepare('SELECT id,username,role FROM users WHERE id=?').get(d.id)||null;
  }
  app.use('/api',(q,r,next)=>{
    if(q.path==='/login'||q.path.startsWith('/agent/')||/^\/n(\/|$)/i.test(q.path))return next(); // у них своя проверка
    let u=null;try{u=userOf(q)}catch{}
    if(!u)return sendJson(r,401,{error:'Требуется авторизация'});
    if(!authorize(u,'local',q.method,q.path))return sendJson(r,403,{error:'Недостаточно прав для этого действия'});
    next();
  });

  /* ================= прокси на агента ================= */
  // Монтируется ДО express.json, чтобы тело (в т.ч. загрузка файлов) шло потоком.
  app.use('/api/n/:id',(q,r)=>{
    let u=null;try{u=userOf(q)}catch{}
    if(!u)return sendJson(r,401,{error:'Требуется авторизация'});
    const n=getNode(q.params.id);
    if(!n)return sendJson(r,404,{error:'Сервер не найден'});
    let p;
    try{p=new URL('http://x'+(q.url.startsWith('/')?q.url:'/'+q.url)).pathname.replace(/\/+$/,'')||'/'}catch{return sendJson(r,400,{error:'Некорректный путь'})}
    if(!authorize(u,String(n.id),q.method,p))return sendJson(r,403,{error:'Недостаточно прав для этого действия'});
    forward(n,q,r,q.url,u.username);
  });

  /* ================= обнаружение агентов ================= */
  const seen=new Map(),lastFollow=new Map();
  function onSeen(d){
    if(d.id===cfg.agentId)return;
    const now=Date.now(),e=seen.get(d.id)||{ips:new Map()};
    e.ips.set(d.ip,now);Object.assign(e,{id:d.id,name:d.name,port:d.port,ip:d.ip,last:now});seen.set(d.id,e);
    // Компьютер сменил IP (DHCP) — находим по id и, убедившись по HMAC, что это он, обновляем адрес
    const n=db.prepare('SELECT * FROM nodes WHERE agent_id=?').get(d.id);
    if(!n)return;
    let cur;try{cur=new URL(n.url)}catch{return}
    if(cur.protocol!=='http:'||!IPV4.test(cur.hostname))return;
    const seenNow=[...e.ips].some(([ip,t])=>ip===cur.hostname&&now-t<10000);
    if(seenNow&&String(cur.port||80)===String(d.port))return;
    if(now-(lastFollow.get(d.id)||0)<30000)return;
    lastFollow.set(d.id,now);
    const url=`http://${d.ip}${d.port===80?'':':'+d.port}`;
    verifyAgent({url},n.token,d.id).then(id=>{
      if(!id)return;
      db.prepare('UPDATE nodes SET url=? WHERE id=?').run(url,n.id);
      console.log(`[nodes] «${n.name}» сменил адрес: ${cur.host} → ${url.replace('http://','')}`);
    });
  }
  if(cfg.discovery!==false&&!(AGENT_TOKEN&&cfg.agentOnly))discovery.startListener({onSeen});

  /* ================= список серверов ================= */
  const userNodes=id=>db.prepare('SELECT node FROM user_nodes WHERE user_id=?').all(id).map(x=>x.node);
  app.get('/api/nodes',auth,(q,r)=>{
    const all=db.prepare('SELECT id,name,url FROM nodes ORDER BY id').all();
    if(q.user.role==='admin')return r.json({local:true,nodes:all.map(pub)});
    const acc=new Set(userNodes(q.user.id));
    r.json({local:acc.has('local'),nodes:all.filter(n=>acc.has(String(n.id))).map(n=>({id:n.id,name:n.name}))});
  });
  app.get('/api/nodes/status',auth,async(q,r)=>{
    let list=db.prepare('SELECT * FROM nodes ORDER BY id').all();
    if(q.user.role!=='admin'){const acc=new Set(userNodes(q.user.id));list=list.filter(n=>acc.has(String(n.id)))}
    r.json(await Promise.all(list.map(async n=>({id:n.id,...await ping(n)}))));
  });
  app.get('/api/nodes/discover',auth,admin,(q,r)=>{
    const known=new Set(db.prepare('SELECT agent_id FROM nodes WHERE agent_id IS NOT NULL').all().map(x=>x.agent_id)),now=Date.now();
    r.json([...seen.values()].filter(x=>now-x.last<15000&&!known.has(x.id)).map(x=>({id:x.id,name:x.name,ip:x.ip,port:x.port})));
  });

  const input=(b,old)=>{
    b=b||{};
    const name=String(b.name??old?.name??'').trim().slice(0,60);
    if(!name)throw new Error('Укажите название');
    const url=normalizeUrl(b.url||old?.url);
    const token=String(b.token||old?.token||'').trim();
    if(token.length<24)throw new Error('Токен агента должен быть не короче 24 символов');
    return {name,url,token};
  };
  app.post('/api/nodes/test',auth,admin,json,async(q,r)=>{
    try{
      const b=q.body||{};let n;
      if(b.id){n=getNode(b.id);if(!n)return r.status(404).json({error:'Сервер не найден'});if(b.url)n.url=normalizeUrl(b.url);if(b.token)n.token=String(b.token).trim()}
      else n={url:normalizeUrl(b.url),token:String(b.token||'').trim()};
      r.json(await ping(n));
    }catch(e){r.status(400).json({error:e.message})}
  });
  // Подключение найденного агента по коду из его консоли: ни IP, ни токен вводить не нужно
  app.post('/api/nodes/pair',auth,admin,json,async(q,r)=>{
    try{
      const b=q.body||{},ip=String(b.ip||'').trim(),port=Number(b.port);
      if(!(IPV4.test(ip)||/^[A-Za-z0-9]([A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$/.test(ip))||!(port>=1&&port<=65535))return r.status(400).json({error:'Некорректный адрес компьютера (IP или имя, например 203.0.113.5 или pc2.example.com)'});
      const base={url:`http://${ip}${port===80?'':':'+port}`};
      const x=await requestJson(base,'POST','/api/agent/pair',{code:b.code},null,6000);
      if(x.status===0)return r.status(502).json({error:'Компьютер не отвечает: '+x.error});
      if(x.status!==200||!x.json||!x.json.token)return r.status([403,410,429].includes(x.status)?x.status:502).json({error:(x.json&&x.json.error)||'Код не принят'});
      const token=String(x.json.token),agentId=String(x.json.id||'');
      const pg=await ping({...base,token});
      if(!pg.ok)return r.status(502).json({error:'Код принят, но связь с агентом не работает: '+pg.error});
      const name=String(b.name||x.json.name||ip).trim().slice(0,60);
      const ex=agentId&&db.prepare('SELECT * FROM nodes WHERE agent_id=?').get(agentId);
      let id;
      if(ex){db.prepare('UPDATE nodes SET name=?,url=?,token=? WHERE id=?').run(name,base.url,token,ex.id);id=ex.id}
      else id=db.prepare('INSERT INTO nodes(name,url,token,agent_id) VALUES(?,?,?,?)').run(name,base.url,token,agentId||null).lastInsertRowid;
      audit(q.user,'node_pair',`${name} (${base.url})`);
      r.json(pub(getNode(id)));
    }catch(e){r.status(400).json({error:e.message})}
  });
  app.post('/api/nodes',auth,admin,json,async(q,r)=>{
    try{
      const v=input(q.body);
      const aid=await verifyAgent({url:v.url},v.token,null);
      const x=db.prepare('INSERT INTO nodes(name,url,token,agent_id) VALUES(?,?,?,?)').run(v.name,v.url,v.token,aid||null);
      audit(q.user,'node_add',`${v.name} (${v.url})`);
      r.json(pub(getNode(x.lastInsertRowid)));
    }catch(e){r.status(400).json({error:e.message})}
  });
  app.put('/api/nodes/:id',auth,admin,json,async(q,r)=>{
    try{
      const o=getNode(q.params.id);if(!o)return r.status(404).json({error:'Сервер не найден'});
      const v=input(q.body,o);
      const aid=await verifyAgent({url:v.url},v.token,null);
      db.prepare('UPDATE nodes SET name=?,url=?,token=?,agent_id=? WHERE id=?').run(v.name,v.url,v.token,aid||o.agent_id||null,o.id);
      audit(q.user,'node_update',v.name);
      r.json(pub(getNode(o.id)));
    }catch(e){r.status(400).json({error:e.message})}
  });
  app.delete('/api/nodes/:id',auth,admin,(q,r)=>{
    const o=getNode(q.params.id);if(!o)return r.status(404).json({error:'Сервер не найден'});
    db.prepare('DELETE FROM nodes WHERE id=?').run(o.id);
    db.prepare('DELETE FROM user_nodes WHERE node=?').run(String(o.id));
    audit(q.user,'node_delete',o.name);
    r.json({ok:true});
  });

  /* ================= пользователи ================= */
  const adminsCount=()=>db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  const cleanNodes=list=>{
    const ok=new Set(['local',...db.prepare('SELECT id FROM nodes').all().map(x=>String(x.id))]);
    return [...new Set((Array.isArray(list)?list:[]).map(String))].filter(x=>ok.has(x));
  };
  const setNodes=(id,list)=>{
    db.prepare('DELETE FROM user_nodes WHERE user_id=?').run(id);
    const ins=db.prepare('INSERT OR IGNORE INTO user_nodes(user_id,node) VALUES(?,?)');
    for(const n of list)ins.run(id,n);
  };
  const userRow=u=>({id:u.id,username:u.username,role:u.role,nodes:u.role==='admin'?['all']:userNodes(u.id)});

  app.get('/api/users',auth,admin,(q,r)=>r.json(db.prepare('SELECT id,username,role FROM users ORDER BY id').all().map(userRow)));
  app.post('/api/users',auth,admin,json,(q,r)=>{
    try{
      const b=q.body||{},username=String(b.username||'').trim(),role=String(b.role||'viewer'),pw=String(b.password||'');
      if(!/^[\p{L}\p{N}_.\-@]{3,32}$/u.test(username))return r.status(400).json({error:'Логин: 3–32 символа (буквы, цифры, _ . - @)'});
      if(!ROLES.includes(role))return r.status(400).json({error:'Неизвестная роль'});
      if(pw.length<8)return r.status(400).json({error:'Пароль должен содержать минимум 8 символов'});
      if(db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username))return r.status(400).json({error:'Такой пользователь уже есть'});
      const id=db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(username,bcrypt.hashSync(pw,12),role).lastInsertRowid;
      setNodes(id,cleanNodes(b.nodes));
      audit(q.user,'user_add',`${username} (${role})`);
      r.json(userRow(db.prepare('SELECT id,username,role FROM users WHERE id=?').get(id)));
    }catch(e){r.status(400).json({error:e.message})}
  });
  app.put('/api/users/:id',auth,admin,json,(q,r)=>{
    try{
      const u=db.prepare('SELECT id,username,role FROM users WHERE id=?').get(+q.params.id);
      if(!u)return r.status(404).json({error:'Пользователь не найден'});
      const b=q.body||{},role=b.role===undefined?u.role:String(b.role);
      if(!ROLES.includes(role))return r.status(400).json({error:'Неизвестная роль'});
      if(u.role==='admin'&&role!=='admin'&&adminsCount()<=1)return r.status(400).json({error:'Нельзя убрать права у последнего администратора'});
      if(b.password){
        if(String(b.password).length<8)return r.status(400).json({error:'Пароль должен содержать минимум 8 символов'});
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(b.password),12),u.id);
      }
      db.prepare('UPDATE users SET role=? WHERE id=?').run(role,u.id);
      if(b.nodes!==undefined)setNodes(u.id,cleanNodes(b.nodes));
      audit(q.user,'user_update',`${u.username} (${role})`);
      r.json(userRow(db.prepare('SELECT id,username,role FROM users WHERE id=?').get(u.id)));
    }catch(e){r.status(400).json({error:e.message})}
  });
  app.delete('/api/users/:id',auth,admin,(q,r)=>{
    const u=db.prepare('SELECT id,username,role FROM users WHERE id=?').get(+q.params.id);
    if(!u)return r.status(404).json({error:'Пользователь не найден'});
    if(u.id===q.user.id)return r.status(400).json({error:'Нельзя удалить самого себя'});
    if(u.role==='admin'&&adminsCount()<=1)return r.status(400).json({error:'Нельзя удалить последнего администратора'});
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    db.prepare('DELETE FROM user_nodes WHERE user_id=?').run(u.id);
    audit(q.user,'user_delete',u.username);
    r.json({ok:true});
  });

  /* ================= WebSocket ================= */
  /** Мост: браузер → панель (?node=<id>) → агент. true — соединение обработано; false — дальше работает обычный обработчик. */
  function bridge(socket,req){
    let u;try{u=new URL(req.url,'http://x')}catch{return false}
    const token=u.searchParams.get('token')||'';
    if(isAgentToken(token))return false;            // это панель подключилась к нам как к агенту
    const nid=u.searchParams.get('node')||'local';
    try{
      const dec=jwt.verify(token,cfg.jwtSecret);
      const usr=db.prepare('SELECT id,role FROM users WHERE id=?').get(dec.id);
      if(!usr)throw Error('auth');
      if(usr.role!=='admin'&&!hasAccess(usr.id,nid))throw Error('forbidden');
      if(nid==='local')return false;
      const n=getNode(nid);if(!n)throw Error('node');
      const WebSocket=require('ws');
      const up=new WebSocket(n.url.replace(/^http/i,'ws')+'/ws?token='+encodeURIComponent(n.token),{handshakeTimeout:8000});
      const pending=[];
      up.on('open',()=>{for(const m of pending)up.send(m);pending.length=0});
      up.on('message',(d,bin)=>{if(socket.readyState===1)socket.send(bin?d:d.toString())});
      up.on('close',()=>{try{socket.close(1011,'Node disconnected')}catch{}});
      up.on('error',()=>{try{socket.close(1011,'Node unreachable')}catch{}});
      socket.on('message',(d,bin)=>{if(up.readyState===1)up.send(d,{binary:bin});else if(up.readyState===0&&pending.length<50)pending.push(d)});
      socket.on('close',()=>{try{up.terminate()}catch{}});
      socket.on('error',()=>{try{up.terminate()}catch{}});
    }catch{try{socket.close(1008,'Unauthorized')}catch{}}
    return true;
  }

  /* ================= запуск: подсказки в консоли ================= */
  function listening(port,host){
    const shown=port===80?'':':'+port;
    if(AGENT_TOKEN&&cfg.agentOnly){
      console.log(`Server Manager — режим агента, БЕЗ интерфейса. Порт ${port}.`);
      if(host==='0.0.0.0'||host==='::'){
        const ips=[];
        for(const l of Object.values(os.networkInterfaces()))for(const i of l||[])if(i.family==='IPv4'&&!i.internal)ips.push(`${i.address}${shown}`);
        if(ips.length)console.log('Адрес этого компьютера: '+ips.join('   '));
      }else console.warn('⚠ host = '+host+': агент слушает только этот компьютер. Для удалённого доступа поставьте "host": "0.0.0.0" в config.json.');
      console.log('Подключение: в панели «Серверы» → «+ Добавить сервер», код — в этой консоли (строка КОД ПОДКЛЮЧЕНИЯ).');
      return;
    }
    console.log(`Server Manager M6: http://${host}${shown}`);
    if(host==='0.0.0.0'||host==='::'){
      const ips=[];
      for(const l of Object.values(os.networkInterfaces()))for(const i of l||[])if(i.family==='IPv4'&&!i.internal)ips.push(`http://${i.address}${shown}`);
      if(ips.length)console.log('Адрес для других компьютеров: '+ips.join('   '));
      try{
        const a=db.prepare('SELECT password_hash FROM users WHERE username=?').get('admin');
        if(a&&bcrypt.compareSync('admin',a.password_hash))console.warn('\n⚠ ВНИМАНИЕ: у пользователя admin пароль по умолчанию «admin», а панель открыта для сети. Смените его (Настройки → пароль).\n');
      }catch{}
    }else console.log('Панель слушает только этот компьютер. Чтобы открыть её другим людям, поставьте "host": "0.0.0.0" в config.json.');
  }

  return {isAgentToken,agentUser,bridge,listenError:(e,p,h)=>listenError(e,p,h),listening};
}

module.exports=create;
create.forward=forward;
create.ping=ping;
create.normalizeUrl=normalizeUrl;
create.can=can;
create.verifyAgent=verifyAgent;
create.listenError=listenError;
