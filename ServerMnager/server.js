const express=require('express');
const http=require('http');
const WebSocket=require('ws');
const fs=require('fs');
const path=require('path');
const {spawn,execFileSync,execFile}=require('child_process');
const {promisify}=require('util');
const execFileAsync=promisify(execFile);
const os=require('os');
const jwt=require('jsonwebtoken');
const bcrypt=require('bcryptjs');
const Database=require('better-sqlite3');
const multer=require('multer');
const archiver=require('archiver');
const unzipper=require('unzipper');
const cron=require('node-cron');
const pidusage=require('pidusage');
const EventEmitter=require('events');
const net=require('net');
const LB=require('./lib/launcher');
const HW=require('./lib/hardware')(); // M8: оборудование и диски
const ARC=require('./lib/archive'); // M9: распаковка архивов

const ROOT=__dirname;
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'));
if(!cfg.jwtSecret||cfg.jwtSecret==='CHANGE_THIS_SECRET_TO_A_LONG_RANDOM_VALUE'||String(cfg.jwtSecret).length<32){
  cfg.jwtSecret=require('crypto').randomBytes(48).toString('hex');
  try{fs.writeFileSync(path.join(ROOT,'config.json'),JSON.stringify(cfg,null,2));console.log('jwtSecret был небезопасным — сгенерирован новый и сохранён в config.json')}catch(e){console.warn('Не удалось сохранить jwtSecret:',e.message)}
}
if(process.platform!=='win32'&&/^[A-Za-z]:[\\/]/.test(String(cfg.fileRoot||''))){console.warn('fileRoot в стиле Windows ('+cfg.fileRoot+') — используется ./servers');cfg.fileRoot='./servers'}
const FILE_ROOT=path.resolve(ROOT,cfg.fileRoot);
const BACKUP_ROOT=path.resolve(ROOT,cfg.backupRoot);
const LOG_ROOT=path.resolve(ROOT,cfg.logRoot||'./storage/logs');
fs.mkdirSync(FILE_ROOT,{recursive:true});
fs.mkdirSync(BACKUP_ROOT,{recursive:true});
fs.mkdirSync(LOG_ROOT,{recursive:true});

const db=new Database(path.join(ROOT,'server.db'));
db.pragma('journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,role TEXT);
CREATE TABLE IF NOT EXISTS apps(id INTEGER PRIMARY KEY,name TEXT,type TEXT,command TEXT,working_dir TEXT,runtime TEXT,runtime_path TEXT,stop_command TEXT,env_json TEXT,auto_start INTEGER,auto_restart INTEGER,restart_delay INTEGER,max_restarts INTEGER,port INTEGER);
CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY,app_id INTEGER,name TEXT,command TEXT,runtime_path TEXT,env_json TEXT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,name TEXT,cron TEXT,app_id INTEGER,action TEXT,enabled INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,username TEXT,action TEXT,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
{const cols=db.prepare('PRAGMA table_info(apps)').all().map(c=>c.name);
for(const [n,d] of [['launch_json',"TEXT DEFAULT ''"],['depends_on',"TEXT DEFAULT '[]'"],['ready_delay','INTEGER DEFAULT 0']])if(!cols.includes(n))db.exec(`ALTER TABLE apps ADD COLUMN ${n} ${d}`);}
{const tc=db.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name);
for(const [n,d] of [['payload',"TEXT DEFAULT ''"],['keep','INTEGER DEFAULT 0'],['last_run','TEXT'],['last_status','TEXT'],['last_message','TEXT']])if(!tc.includes(n))db.exec(`ALTER TABLE tasks ADD COLUMN ${n} ${d}`);
const pc=db.prepare('PRAGMA table_info(profiles)').all().map(c=>c.name);
for(const [n,d] of [['note',"TEXT DEFAULT ''"],['launch_json',"TEXT DEFAULT ''"]])if(!pc.includes(n))db.exec(`ALTER TABLE profiles ADD COLUMN ${n} ${d}`);}
if(!db.prepare('SELECT 1 FROM users WHERE username=?').get('admin')) db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('admin',bcrypt.hashSync('admin',12),'admin');

const procs=new Map();
const jobs=new Map();
const events=new EventEmitter();
const app=express();
const server=http.createServer(app);
const wss=new WebSocket.Server({server,path:'/ws'});
const NODES=require('./lib/nodes')({db,cfg,express,jwt,bcrypt,auth,admin,audit,app}); // удалённые серверы
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(ROOT,'public')));

// ---- M7/M8: файловый менеджер — хранилище, папка приложения (?app=ID) или диск (?disk=том, только администратор) ----
const winRe=process.platform==='win32';
const RESERVED=/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const cmpP=s=>winRe?String(s).toLowerCase():String(s);
const withSep=r=>r.endsWith(path.sep)?r:r+path.sep;
const within=(root,t)=>{const r=cmpP(path.resolve(root)),x=cmpP(path.resolve(t));return x===r||x.startsWith(withSep(r))};
const PANEL_FILES=/^(config\.json|server\.db)(-wal|-shm|-journal)?(\.bak.*)?$/i; // секреты панели: пароли, токены, база пользователей
const protectedPath=p=>cmpP(path.dirname(p))===cmpP(ROOT)&&PANEL_FILES.test(path.basename(p));
const panelAncestor=p=>within(p,ROOT); // p — папка панели или её родитель
function realOf(p){let probe=p;while(!fs.existsSync(probe)){const up=path.dirname(probe);if(up===probe)break;probe=up}return fs.realpathSync(probe)}
function safeIn(root,p){
  const r=path.resolve(root),rel=String(p||'');
  if(rel.includes('\0'))throw Error('Недопустимый путь');
  if(winRe)for(const seg of rel.split(/[\\/]+/))if(seg&&(/[:*?"<>|]/.test(seg)||RESERVED.test(seg)))throw Error('Недопустимое имя: '+seg);
  const t=path.resolve(r,rel);
  if(!within(r,t))throw Error('Недопустимый путь');
  if(protectedPath(t))throw Error('Доступ к служебным файлам панели закрыт');
  const real=realOf(t);
  let rr;try{rr=fs.realpathSync(r)}catch{rr=r}
  if(HW.blocked(real)&&!HW.blocked(rr))throw Error('Этот системный каталог недоступен'); // /proc, /sys, /dev закрыты, если вы не работаете внутри явно заданной папки проекта
  if(!cfg.allowExternalLinks&&!within(rr,real))throw Error('Символическая ссылка ведёт за пределы разрешённой папки'); // symlink/junction не должны выводить за пределы выбранной папки или диска
  if(protectedPath(real))throw Error('Доступ к служебным файлам панели закрыт');
  return t;
}
function safe(p){return safeIn(FILE_ROOT,p)}
function rootOf(q){
  const dk=(q.query&&q.query.disk)||(q.body&&q.body.disk),raw=(q.query&&q.query.app)||(q.body&&q.body.app);
  if(dk){
    if(raw)throw Error('Укажите либо приложение, либо диск');
    if(!q.user||q.user.role!=='admin')throw Error('Доступ к дискам есть только у администратора');
    const m=HW.mountRoot(String(dk));
    if(!m)throw Error('Диск не найден или недоступен. Обновите список дисков.');
    if(!fs.existsSync(m))throw Error('Диск недоступен: '+m);
    return m;
  }
  const id=+raw;
  if(!raw||!id)return FILE_ROOT;
  const a=appById(id);if(!a)throw Error('Приложение не найдено');
  const wd=path.resolve(a.working_dir);
  if(!fs.existsSync(wd)||!fs.statSync(wd).isDirectory())throw Error('Рабочая папка не найдена: '+wd);
  return wd;
}
const safeQ=(q,p)=>safeIn(rootOf(q),p);
function fsErr(e){const c=e&&e.code;if(c==='ENOENT')return'Файл или папка не найдены';if(c==='EACCES'||c==='EPERM')return'Нет доступа (файл занят, защищён или не хватает прав)';if(c==='EBUSY')return'Файл занят другим процессом';if(c==='ENOTEMPTY')return'Папка не пуста';if(c==='EEXIST')return'Уже существует';if(c==='ENOSPC')return'Недостаточно места на диске';if(c==='EROFS')return'Диск доступен только для чтения';return e&&e.message||String(e)}
function auth(req,res,next){
  try{
    let token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    const userFromQuery=(req.path==='/api/download'||((req.baseUrl||'').startsWith('/api/n/')&&req.path==='/download'))&&req.query.token;
    if(!token&&userFromQuery) token=String(userFromQuery);
    if(NODES.isAgentToken(token)){req.user=NODES.agentUser(req);return next();} // запрос от главной панели
    const decoded=jwt.verify(token,cfg.jwtSecret);
    req.user=db.prepare('SELECT id,username,role FROM users WHERE id=?').get(decoded.id);
    if(!req.user) throw Error();
    next();
  }catch{res.status(401).json({error:'Требуется авторизация'});}
}
function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Требуются права администратора'});next();}
function audit(user,action,details=''){db.prepare('INSERT INTO audit(username,action,details) VALUES(?,?,?)').run(user?.username||'system',action,details);}
function num(v,def,min=0){if(v===''||v==null)return def;const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.trunc(n)):def}
function cleanEnv(o){const out={};if(o&&typeof o==='object'&&!Array.isArray(o))for(const [k,v] of Object.entries(o)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))throw Error('Недопустимое имя переменной ENV: '+k);out[k]=String(v??'')}return out}
function checkWorkingDir(wd){ // путь может быть на любом диске; проверяем только то, что реально мешает запуску
  if(process.platform==='win32'&&/^[A-Za-z]:/.test(wd)){const root=wd.slice(0,2)+'\\';try{fs.accessSync(root)}catch{throw Error(`Диск ${wd.slice(0,2)} сейчас недоступен. Подключите его или выберите другую папку.`)}}
  try{if(!fs.statSync(wd).isDirectory())throw Error('Указанный путь — файл, а не папка')}catch(e){if(/файл, а не папка/.test(e.message))throw e}
}
function appInput(b,o,selfId){
  const has=k=>b[k]!==undefined,pick=(k,d)=>has(k)?b[k]:(o?o[k]:d);
  let launch=o?.launch_json||'';
  if(has('launch')){const l=b.launch;launch=l&&l.preset&&l.preset!=='custom'?JSON.stringify(LB.normalizeLaunch(l)):''}
  const port=has('port')?num(b.port,null,1):(o?o.port:null);
  if(port&&port>65535)throw Error('Порт должен быть от 1 до 65535');
  let command=has('command')?String(b.command||'').trim():(o?.command||'');
  if(launch)command=LB.buildCommand(JSON.parse(launch),port);
  if(!command)throw Error('Команда запуска обязательна');
  const name=String(pick('name','')).trim(),wd=String(pick('working_dir','')).trim();
  if(!name||!wd)throw Error('Название и рабочая папка обязательны');
  if(!o||o.working_dir!==wd)checkWorkingDir(wd); // уже настроенные пути не трогаем и не перепроверяем
  return {name,type:pick('type','auto')||'auto',command,working_dir:wd,runtime:pick('runtime','')||'',runtime_path:pick('runtime_path','')||'',stop_command:String(pick('stop_command','')||'').trim(),
    env_json:JSON.stringify(has('env')?cleanEnv(b.env):parseEnv(o?.env_json)),launch_json:launch,
    depends_on:JSON.stringify(has('depends_on')?checkDeps(b.depends_on,selfId):parseDeps(o?.depends_on)),ready_delay:num(b.ready_delay,o?o.ready_delay:0,0),
    auto_start:has('auto_start')?(b.auto_start?1:0):(o?o.auto_start:0),auto_restart:has('auto_restart')?(b.auto_restart?1:0):(o?o.auto_restart:0),
    restart_delay:num(b.restart_delay,o?o.restart_delay:5),max_restarts:num(b.max_restarts,o?o.max_restarts:5),port};
}
const APP_COLS=['name','type','command','working_dir','runtime','runtime_path','stop_command','env_json','launch_json','depends_on','ready_delay','auto_start','auto_restart','restart_delay','max_restarts','port'];
function parseEnv(s){try{return JSON.parse(s||'{}')}catch{return {}}}
let rtCache=null,rtTime=0;
function runtime(force=false){if(!force&&rtCache&&Date.now()-rtTime<60000)return rtCache;rtCache=LB.discoverRuntimes();rtTime=Date.now();return rtCache}
function infer(command,cwd){
  const s=(command||'').toLowerCase(),a=[];
  if(/java|\.jar|minecraft/.test(s))a.push('java');
  if(/node|npm|\.js|package\.json/.test(s)||fs.existsSync(path.join(cwd||'','package.json')))a.push('node');
  if(/python|\.py/.test(s)||fs.existsSync(path.join(cwd||'','requirements.txt'))||fs.existsSync(path.join(cwd||'','pyproject.toml')))a.push('python');
  if(/dotnet|\.dll|\.csproj/.test(s))a.push('dotnet');
  return [...new Set(a)];
}
function detectProject(cwd){
  const dir=path.resolve(cwd||'.');
  const exists=n=>fs.existsSync(path.join(dir,n));
  const files=fs.existsSync(dir)?fs.readdirSync(dir):[];
  const result={cwd:dir,type:'auto',command:'',runtime:'',runtimePath:'',detected:[],confidence:'low'};
  if(exists('docker-compose.yml')||exists('compose.yaml')||exists('compose.yml')){result.type='docker';result.command='docker compose up';result.runtime='docker';result.detected.push('Docker Compose');result.confidence='high';return result;}
  if(files.some(x=>x.toLowerCase().endsWith('.jar'))){const jar=files.find(x=>x.toLowerCase().endsWith('.jar'));result.type='minecraft';result.command=`java -jar "${jar}"`;result.runtime='java';result.detected.push(jar);result.confidence='high';return result;}
  if(exists('package.json')){result.type='node';result.command='npm start';result.runtime='node';result.detected.push('package.json');result.confidence='high';return result;}
  if(exists('requirements.txt')||exists('pyproject.toml')){result.type='python';result.command=exists('pyproject.toml')?'python -m app':'python main.py';result.runtime='python';result.detected.push(exists('requirements.txt')?'requirements.txt':'pyproject.toml');result.confidence='medium';return result;}
  const dll=files.find(x=>x.toLowerCase().endsWith('.dll'));if(dll){result.type='dotnet';result.command=`dotnet "${dll}"`;result.runtime='dotnet';result.detected.push(dll);result.confidence='high';return result;}
  const exe=files.find(x=>x.toLowerCase().endsWith('.exe'));if(exe){result.type='executable';result.command=`"${exe}"`;result.detected.push(exe);result.confidence='medium';return result;}
  const bat=files.find(x=>/\.(bat|cmd|sh)$/i.test(x));if(bat){result.type='script';result.command=`"${bat}"`;result.detected.push(bat);result.confidence='medium';return result;}
  return result;
}

function scanProject(cwd){
  const root=path.resolve(cwd||'.');
  if(!fs.existsSync(root)||!fs.statSync(root).isDirectory()) throw Error('Папка не найдена: '+root);
  const candidates=[]; const seen=new Set();
  const add=(type,command,runtime,label,confidence='medium',details='')=>{
    const key=type+'|'+command; if(seen.has(key))return; seen.add(key); candidates.push({type,command,runtime:runtime||'',label,confidence,details});
  };
  const walk=(dir,depth)=>{
    if(depth>2)return;
    let entries=[]; try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
    for(const e of entries){
      if(e.name.startsWith('.')||['node_modules','venv','.venv','bin','obj','storage'].includes(e.name))continue;
      const full=path.join(dir,e.name), rel=path.relative(root,full)||e.name;
      if(e.isDirectory()){walk(full,depth+1);continue}
      const low=e.name.toLowerCase();
      if(low==='start.bat'||low==='start.cmd')add('script',`"${rel}"`,'',`Запустить ${e.name}`,'high','Windows script');
      if(low==='start.sh')add('script',`sh "${rel}"`,'',`Запустить ${e.name}`,'high','Shell script');
      if(low.endsWith('.jar'))add('minecraft',`java -jar "${rel}"`,'java',`Java JAR: ${e.name}`,'high','JAR application');
      if(low.endsWith('.exe'))add('executable',`"${rel}"`,'',`EXE: ${e.name}`,'medium','Executable');
      if(low.endsWith('.dll'))add('dotnet',`dotnet "${rel}"`,'dotnet',`.NET: ${e.name}`,'high','DLL');
    }
  };
  let pkg=null; try{pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))}catch{}
  if(pkg){
    const scripts=pkg.scripts||{};
    if(scripts.start)add('node','npm start','node','Node.js: npm start','high',`package.json script: ${scripts.start}`);
    for(const [name,cmd] of Object.entries(scripts)) if(name!=='start') add('node',`npm run ${name}`,'node',`Node.js: npm run ${name}`,'medium',String(cmd));
  }
  if(fs.existsSync(path.join(root,'requirements.txt'))) add('python','python -m pip install -r requirements.txt && python main.py','python','Python: requirements.txt','high','requirements.txt');
  if(fs.existsSync(path.join(root,'pyproject.toml'))) add('python','python -m app','python','Python: pyproject.toml','medium','pyproject.toml');
  if(fs.existsSync(path.join(root,'docker-compose.yml'))||fs.existsSync(path.join(root,'compose.yml'))||fs.existsSync(path.join(root,'compose.yaml'))) add('docker','docker compose up','docker','Docker Compose','high','Compose project');
  walk(root,0);
  if(!candidates.length)add('executable','', '', 'Ручная настройка','low','Автоматический запуск не найден');
  const runtimes=runtime();
  return {cwd:root,candidates:candidates.map(x=>({...x,availableRuntime:!x.runtime||runtimes.some(r=>r.key===x.runtime)})),runtimes};
}

function stat(a){const s=procs.get(a.id);return{running:!!s,pid:s?.child.pid||null,uptime:s?Date.now()-s.startedAt:0,restarts:s?.restarts||0};}
function allApps(){return db.prepare('SELECT * FROM apps ORDER BY id DESC').all().map(a=>({...a,...stat(a)}));}
function broadcast(x){events.emit(x.type,x);if(!wss.clients.size)return;const msg=JSON.stringify(x);for(const client of wss.clients)if(client.readyState===WebSocket.OPEN)client.send(msg);} // JSON собирается один раз для всех клиентов
// ---- M7: вывод приложения и лог-файлы (по строкам, с ротацией 10 МБ) ----
const logBuf=new Map(),logSize=new Map(),LOG_MAX=10*1024*1024;
function logFile(id){return path.join(LOG_ROOT,`app-${id}.log`)}
const logQ=new Map();let logTimer=null;
function logRaw(id,text){logQ.set(id,(logQ.get(id)||'')+text);if(!logTimer){logTimer=setTimeout(logFlushAll,250);logTimer.unref()}} // пишем пачками раз в 250 мс, а не на каждый кусок вывода
function logFlush(id){
  const t=logQ.get(id);if(!t)return;logQ.delete(id);
  const f=logFile(id);
  try{
    let sz=logSize.get(id);if(sz===undefined){try{sz=fs.statSync(f).size}catch{sz=0}}
    if(sz>LOG_MAX){try{fs.renameSync(f,f+'.1')}catch{}sz=0}
    fs.appendFileSync(f,t,'utf8');logSize.set(id,sz+Buffer.byteLength(t));
  }catch{}
}
function logFlushAll(){clearTimeout(logTimer);logTimer=null;for(const id of [...logQ.keys()])logFlush(id)}
process.on('exit',logFlushAll);
function logWrite(id,stream,text){
  const ts=new Date().toISOString();
  if(stream==='system')for(const s of ['stdout','stderr']){const k=id+':'+s,rest=logBuf.get(k);if(rest){logBuf.set(k,'');logRaw(id,`[${ts}] [${s}] ${rest}\n`)}}
  const k=id+':'+stream,parts=((logBuf.get(k)||'')+text).split(/\r?\n/);
  logBuf.set(k,parts.pop());
  if(parts.length)logRaw(id,parts.map(l=>`[${ts}] [${stream}] ${l}`).join('\n')+'\n');
}
function logClear(id){for(const s of ['stdout','stderr','system'])logBuf.delete(id+':'+s);logSize.delete(id);logQ.delete(id);for(const f of [logFile(id),logFile(id)+'.1'])try{fs.rmSync(f,{force:true})}catch{}}
function tailFile(file,maxBytes){const st=fs.statSync(file),len=Math.min(st.size,maxBytes),fd=fs.openSync(file,'r');try{const buf=Buffer.alloc(len);fs.readSync(fd,buf,0,len,st.size-len);let t=buf.toString('utf8');if(st.size>len){const nl=t.indexOf('\n');t=nl>=0?t.slice(nl+1):t}return t}finally{fs.closeSync(fd)}}
function appendOutput(id,stream,data){const text=String(data??'');const s=procs.get(id);if(s){s.history.push({stream,data:text,time:Date.now()});if(s.history.length>500)s.history.shift();}logWrite(id,stream,text);broadcast({type:'output',id,stream,data:text});}
function start(a,existingState=null){
  if(procs.has(a.id)) throw Error('Уже запущено');
  const cwd=path.resolve(a.working_dir);
  if(!fs.existsSync(cwd)||!fs.statSync(cwd).isDirectory()) throw Error('Рабочая папка не найдена: '+cwd+(process.platform==='win32'&&!fs.existsSync(path.parse(cwd).root)?` (диск ${path.parse(cwd).root} недоступен)`:''));
  const env={...process.env,...LB.launchEnv(a),...parseEnv(a.env_json)};
  if(a.runtime_path){let st;try{st=fs.statSync(a.runtime_path)}catch{throw Error('Runtime не найден: '+a.runtime_path)}const runtimeDir=st.isDirectory()?a.runtime_path:path.dirname(a.runtime_path);const pk=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';env[pk]=runtimeDir+path.delimiter+(env[pk]||'');}
  const state=existingState||{restarts:0,history:[],startedAt:Date.now(),stableTimer:null,manualStop:false};
  state.manualStop=false;state.startedAt=Date.now();
  const child=spawn(a.command,{cwd,shell:true,windowsHide:true,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  state.child=child;procs.set(a.id,state);
  appendOutput(a.id,'system',`[Server Manager] Запуск PID ${child.pid}\n`);
  child.stdout.on('data',d=>appendOutput(a.id,'stdout',d));
  child.stderr.on('data',d=>appendOutput(a.id,'stderr',d));
  child.on('error',err=>appendOutput(a.id,'stderr',`[process error] ${err.message}\n`));
  child.stdin.on('error',()=>{});
  state.stableTimer=setTimeout(()=>{state.restarts=0;},30000);
  child.on('close',code=>{
    clearTimeout(state.stableTimer);clearTimeout(state.killTimer);
    procs.delete(a.id);
    broadcast({type:'exit',id:a.id,code});
    appendOutput(a.id,'system',`[Server Manager] Процесс завершён с кодом ${code}\n`);
    if(!state.manualStop&&a.auto_restart&&state.restarts<a.max_restarts){
      state.restarts++;
      appendOutput(a.id,'system',`[Server Manager] Автоперезапуск ${state.restarts}/${a.max_restarts} через ${a.restart_delay} сек.\n`);
      setTimeout(()=>{try{start(a,state)}catch(e){broadcast({type:'error',id:a.id,error:e.message});}},Math.max(0,a.restart_delay)*1000);
    }
  });
  return {running:true,pid:child.pid};
}
function stop(a,kill=false){
  const s=procs.get(a.id);if(!s)return false;
  s.manualStop=true;
  if(!kill){clearTimeout(s.killTimer);s.killTimer=setTimeout(()=>{if(procs.get(a.id)===s){appendOutput(a.id,'system','[Server Manager] Процесс не завершился за 60 с — принудительное завершение\n');stop(a,true)}},60000);}
  if(!kill&&a.stop_command){
    if(a.stop_command.startsWith('stdin:')){try{s.child.stdin.write(a.stop_command.slice(6)+'\n')}catch(e){appendOutput(a.id,'stderr',`[stop stdin error] ${e.message}\n`)}return true;}
    const sp=spawn(a.stop_command,{cwd:a.working_dir,shell:true,windowsHide:true,stdio:'ignore'});sp.on('error',e=>appendOutput(a.id,'stderr',`[stop_command error] ${e.message}\n`));return true;
  }
  if(process.platform==='win32')spawn('taskkill',['/F','/T','/PID',String(s.child.pid)],{windowsHide:true});
  else{const sig=kill?'SIGKILL':'SIGTERM';try{process.kill(-s.child.pid,sig)}catch{try{s.child.kill(sig)}catch{}}}
  return true;
}
function waitForExit(id,timeout=10000){return new Promise(resolve=>{if(!procs.has(id))return resolve(true);const started=Date.now();const timer=setInterval(()=>{if(!procs.has(id)){clearInterval(timer);resolve(true)}else if(Date.now()-started>=timeout){clearInterval(timer);resolve(false)}},100);});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function portFree(port){return new Promise(res=>{const sv=net.createServer();sv.once('error',()=>res(false));sv.once('listening',()=>sv.close(()=>res(true)));sv.listen(port,'0.0.0.0')})}
function parseDeps(s){try{const x=JSON.parse(s||'[]');return Array.isArray(x)?x.map(Number).filter(Number.isInteger):[]}catch{return[]}}
const appById=id=>db.prepare('SELECT * FROM apps WHERE id=?').get(id);
function checkDeps(raw,selfId){
  const ids=[...new Set((Array.isArray(raw)?raw:[]).map(Number).filter(Number.isInteger))];
  const nm=id=>appById(id)?.name||('#'+id);
  for(const id of ids){if(id===selfId)throw Error('Приложение не может зависеть от самого себя');if(!appById(id))throw Error('Зависимость не найдена: #'+id)}
  if(selfId){
    const walk=(id,trail,seen)=>{if(id===selfId)throw Error('Циклическая зависимость: '+[...trail,nm(selfId)].join(' → '));if(seen.has(id))return;seen.add(id);for(const d of parseDeps(appById(id)?.depends_on))walk(d,[...trail,nm(id)],seen)};
    for(const d of ids)walk(d,[nm(selfId)],new Set());
  }
  return ids;
}
async function startWithDeps(a,stack=[]){
  if(stack.includes(a.id))throw Error('Циклическая зависимость приложений');
  if(!stack.length&&procs.has(a.id))throw Error('Уже запущено');
  for(const depId of parseDeps(a.depends_on)){
    const d=appById(depId);if(!d||procs.has(d.id))continue;
    appendOutput(a.id,'system',`[Server Manager] Сначала запускается зависимость: ${d.name}\n`);
    await startWithDeps(d,[...stack,a.id]);
    if(d.ready_delay>0)await sleep(d.ready_delay*1000);
    if(!procs.has(d.id))throw Error(`Зависимость «${d.name}» завершилась сразу после запуска`);
  }
  if(procs.has(a.id))return;
  if(a.port&&!(await portFree(a.port)))throw Error(`Порт ${a.port} уже занят другим процессом`);
  return start(a);
}
function runningDependents(id){return db.prepare('SELECT * FROM apps').all().filter(x=>procs.has(x.id)&&parseDeps(x.depends_on).includes(id)).map(x=>x.name)}
async function restart(a){if(procs.has(a.id)){stop(a,false);const done=await waitForExit(a.id,62000);if(!done){stop(a,true);await waitForExit(a.id,3000)}}return start(a);}
// ---- M7: резервные копии ----
const BK_RE=/^app-(\d+)-(\d+)(?:-([a-z]+))?\.zip$/;
const fmtBytes=n=>n<1048576?(n/1024).toFixed(0)+' КБ':n<1073741824?(n/1048576).toFixed(1)+' МБ':(n/1073741824).toFixed(2)+' ГБ';
function listBackups(appId){
  return fs.readdirSync(BACKUP_ROOT).filter(n=>/\.zip$/i.test(n)).map(n=>{
    const m=BK_RE.exec(n);if(appId&&(!m||+m[1]!==appId))return null;
    let s;try{s=fs.statSync(path.join(BACKUP_ROOT,n))}catch{return null}
    return{name:n,app_id:m?+m[1]:null,tag:m&&m[3]||'',size:s.size,modified:s.mtime};
  }).filter(Boolean).sort((a,b)=>b.modified-a.modified);
}
function pruneBackups(appId,keep){ // оставляем keep последних обычных копий (страховочные «pre» не трогаем)
  const old=listBackups(appId).filter(b=>!b.tag).slice(keep);let n=0;
  for(const b of old){try{fs.rmSync(path.join(BACKUP_ROOT,b.name),{force:true});n++}catch{}}
  return n;
}
const backingUp=new Set();
const isMc=a=>a.type==='minecraft'||/minecraft|paper|spigot|purpur|folia|fabric|forge|neoforge/i.test((a.command||'')+(a.launch_json||''));
function waitOutput(id,re,ms){return new Promise(res=>{const h=x=>{if(x.id===id&&re.test(String(x.data))){clearTimeout(t);events.off('output',h);res(true)}};const t=setTimeout(()=>{events.off('output',h);res(false)},ms);events.on('output',h)})}
async function mcFlush(a){ // чтобы мир в архиве был целым: save-off + save-all flush
  const s=procs.get(a.id);if(!s||!s.child.stdin.writable)return false;
  const w=c=>{try{s.child.stdin.write(c+'\n')}catch{}};
  let p=waitOutput(a.id,/Automatic saving is now disabled|Saving is already turned off/i,6000);w('save-off');await p;
  p=waitOutput(a.id,/Saved the (game|world)/i,40000);w('save-all flush');await p;
  return true;
}
function mcResume(a){const s=procs.get(a.id);if(s&&s.child.stdin.writable)try{s.child.stdin.write('save-on\n')}catch{}}
async function createBackup(a,opt={}){
  const source=path.resolve(a.working_dir);
  if(!fs.existsSync(source))throw Error('Рабочая папка не найдена: '+source);
  if(backingUp.has(a.id))throw Error('Backup этого приложения уже создаётся');
  backingUp.add(a.id);
  const name=`app-${a.id}-${Date.now()}${opt.tag?'-'+opt.tag:''}.zip`,dest=path.join(BACKUP_ROOT,name),part=dest+'.partial';
  const skipped=[],bRoot=path.resolve(BACKUP_ROOT),lRoot=path.resolve(LOG_ROOT),uRoot=path.join(ROOT,'.uploads');
  const skipDir=full=>full===bRoot||full===lRoot||full===uRoot||path.basename(full)==='.sm-old'||path.basename(full).startsWith('.sm-extract-');
  let flushed=false;
  try{
    flushed=isMc(a)&&procs.has(a.id)&&await mcFlush(a);
    const out=fs.createWriteStream(part),zip=archiver('zip',{zlib:{level:6}});
    const closed=new Promise((res,rej)=>{out.on('close',res);out.on('error',rej);zip.on('error',rej)});closed.catch(()=>{});
    zip.on('warning',w=>skipped.push(String(w.message||w)));
    zip.pipe(out);
    let cnt=0;
    const walk=async(dir,rel)=>{
      let ents;try{ents=fs.readdirSync(dir,{withFileTypes:true})}catch{skipped.push(rel||'.');return}
      for(const e of ents){
        if(++cnt%200===0)await new Promise(r=>setImmediate(r)); // отдаём управление, чтобы панель не «замирала» на больших папках
        const full=path.join(dir,e.name),r=rel?rel+'/'+e.name:e.name;
        if(e.isDirectory()){if(skipDir(full))continue;zip.append(null,{name:r+'/'});await walk(full,r)}
        else if(e.isFile()){
          if(e.name==='session.lock')continue; // Minecraft пересоздаёт; в Windows файл заблокирован
          try{const fd=fs.openSync(full,'r');try{fs.readSync(fd,Buffer.alloc(1),0,1,0)}finally{fs.closeSync(fd)}}catch{skipped.push(r);continue} // занятые файлы пропускаем, а не рушим весь backup
          zip.file(full,{name:r});
        }
      }
    };
    try{await walk(source,'');zip.finalize();await closed}catch(e){try{zip.abort()}catch{}out.destroy();throw e}
    fs.renameSync(part,dest);
  }catch(e){try{fs.rmSync(part,{force:true})}catch{}throw e}
  finally{backingUp.delete(a.id);if(flushed)mcResume(a)}
  return{name,path:dest,size:fs.statSync(dest).size,modified:new Date().toISOString(),skipped};
}
async function restoreBackup(a,file){
  const nm=path.basename(String(file||'')),m=BK_RE.exec(nm);
  if(!m||+m[1]!==a.id)throw Error('Этот backup создан для другого приложения');
  const abs=path.resolve(BACKUP_ROOT,nm);
  if(!fs.existsSync(abs))throw Error('Backup не найден');
  const target=path.resolve(a.working_dir);fs.mkdirSync(target,{recursive:true});
  const safety=await createBackup(a,{tag:'pre'}); // страховка: текущее состояние сохраняется перед восстановлением
  const dir=await unzipper.Open.file(abs);
  for(const entry of dir.files){
    const dest=path.resolve(target,entry.path);
    if(dest!==target&&!dest.startsWith(target+path.sep))throw Error('Backup содержит недопустимый путь');
    if(entry.type==='Directory'){fs.mkdirSync(dest,{recursive:true});continue;}
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    await new Promise((resolve,reject)=>entry.stream().pipe(fs.createWriteStream(dest)).on('finish',resolve).on('error',reject));
  }
  return{safety:safety.name};
}

app.post('/api/login',(q,r)=>{const {username,password}=q.body||{};const u=db.prepare('SELECT * FROM users WHERE username=?').get(username);if(!u||!bcrypt.compareSync(password||'',u.password_hash))return r.status(401).json({error:'Неверный логин или пароль'});r.json({token:jwt.sign({id:u.id},cfg.jwtSecret,{expiresIn:'12h'}),user:{id:u.id,username:u.username,role:u.role}})});
app.get('/api/me',auth,(q,r)=>r.json(q.user));
app.get('/api/apps',auth,(q,r)=>r.json(allApps()));
app.get('/api/apps/:id',auth,(q,r)=>{const a=db.prepare('SELECT * FROM apps WHERE id=?').get(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});r.json({...a,...stat(a),profiles:db.prepare('SELECT * FROM profiles WHERE app_id=? ORDER BY id').all(a.id)})});
app.post('/api/apps',auth,(q,r)=>{try{const v=appInput(q.body||{},null,0);const x=db.prepare(`INSERT INTO apps(${APP_COLS.join(',')}) VALUES(${APP_COLS.map(()=>'?').join(',')})`).run(...APP_COLS.map(c=>v[c]));const a=appById(x.lastInsertRowid);audit(q.user,'app_create',a.name);r.json(a)}catch(e){r.status(400).json({error:e.message})}});
app.post('/api/apps/import',auth,(q,r)=>{try{const b=q.body||{},d=scanProject(b.working_dir);const c=d.candidates[Number.isInteger(+b.candidate)?+b.candidate:0];if(!c||!c.command)return r.status(400).json({error:'Не выбран способ запуска'});const name=b.name||path.basename(d.cwd)||'Новое приложение';const x=db.prepare(`INSERT INTO apps(name,type,command,working_dir,runtime,runtime_path,stop_command,env_json,auto_start,auto_restart,restart_delay,max_restarts,port) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(name,c.type,c.command,d.cwd,c.runtime||'',b.runtime_path||'',b.stop_command||'',JSON.stringify(b.env||{}),b.auto_start?1:0,b.auto_restart?1:0,num(b.restart_delay,5),num(b.max_restarts,5),num(b.port,null,1));const a=db.prepare('SELECT * FROM apps WHERE id=?').get(x.lastInsertRowid);audit(q.user,'app_import',`${a.name}: ${c.label}`);r.json({...a,detected:d,candidate:c})}catch(e){r.status(400).json({error:e.message})}});
app.put('/api/apps/:id',auth,(q,r)=>{try{const id=+q.params.id,o=appById(id);if(!o)return r.status(404).json({error:'Не найдено'});if(procs.has(id))return r.status(409).json({error:'Сначала остановите приложение'});const v=appInput(q.body||{},o,id);db.prepare(`UPDATE apps SET ${APP_COLS.map(c=>c+'=?').join(',')} WHERE id=?`).run(...APP_COLS.map(c=>v[c]),id);audit(q.user,'app_update',v.name);r.json(appById(id))}catch(e){r.status(400).json({error:e.message})}});
app.delete('/api/apps/:id',auth,(q,r)=>{const a=db.prepare('SELECT * FROM apps WHERE id=?').get(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});stop(a,true);db.prepare('DELETE FROM profiles WHERE app_id=?').run(a.id);for(const t of db.prepare('SELECT id FROM tasks WHERE app_id=?').all(a.id)){jobs.get(t.id)?.stop();jobs.delete(t.id)}db.prepare('DELETE FROM tasks WHERE app_id=?').run(a.id);db.prepare('DELETE FROM apps WHERE id=?').run(a.id);audit(q.user,'app_delete',a.name);r.json({ok:true})});
app.post('/api/apps/:id/start',auth,async(q,r)=>{try{const a=appById(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});await startWithDeps(a);audit(q.user,'start',a.name);r.json({ok:true})}catch(e){r.status(400).json({error:e.message})}});
for(const [route,fn] of [['stop',a=>stop(a)],['kill',a=>stop(a,true)]])app.post('/api/apps/:id/'+route,auth,(q,r)=>{try{const a=appById(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});const was=procs.has(a.id);fn(a);audit(q.user,route,a.name);const deps=was?runningDependents(a.id):[];r.json({ok:true,warning:deps.length?`Работают зависимые приложения: ${deps.join(', ')}`:undefined})}catch(e){r.status(400).json({error:e.message})}});
// --- M6: конструктор запуска ---
app.get('/api/launch/presets',auth,(q,r)=>r.json(LB.PRESETS));
app.post('/api/launch/preview',auth,(q,r)=>{try{r.json({command:LB.buildCommand(q.body?.launch||{},num(q.body?.port,null,1))})}catch(e){r.json({command:'',error:e.message})}});
app.get('/api/launch/inspect',auth,(q,r)=>{try{r.json(LB.inspect(path.resolve(String(q.query.cwd||''))))}catch(e){r.status(400).json({error:e.message})}});
app.get('/api/port-check',auth,async(q,r)=>{const port=num(q.query.port,0,0);if(!port||port>65535)return r.status(400).json({error:'Некорректный порт'});const ex=num(q.query.exclude,0,0),self=!!(ex&&procs.has(ex));r.json({port,self,free:self?true:await portFree(port),others:db.prepare('SELECT id,name FROM apps WHERE port=? AND id!=?').all(port,ex)})});
app.post('/api/apps/:id/restart',auth,async(q,r)=>{try{const a=db.prepare('SELECT * FROM apps WHERE id=?').get(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});await restart(a);audit(q.user,'restart',a.name);r.json({ok:true})}catch(e){r.status(400).json({error:e.message})}});
app.post('/api/apps/:id/command',auth,(q,r)=>{const s=procs.get(+q.params.id);if(!s?.child.stdin.writable)return r.status(400).json({error:'Процесс не принимает команды'});s.child.stdin.write(String(q.body.command||'')+'\n');r.json({ok:true})});
app.get('/api/apps/:id/output',auth,(q,r)=>{const s=procs.get(+q.params.id);r.json(s?.history||[])});
async function pidTree(root){
  try{
    const {stdout}=await execFileAsync('ps',['-A','-o','pid=,ppid='],{timeout:5000});
    const kids=new Map();for(const l of stdout.split('\n')){const m=l.trim().split(/\s+/).map(Number);if(m.length===2&&!m.some(isNaN)){if(!kids.has(m[1]))kids.set(m[1],[]);kids.get(m[1]).push(m[0])}}
    const out=[root],queue=[root];while(queue.length){const p=queue.shift();for(const c of kids.get(p)||[]){out.push(c);queue.push(c)}}
    return out;
  }catch{return [root]}
}
async function posixStats(root){
  const pids=await pidTree(root);
  try{
    const res=await pidusage(pids);let cpu=0,memory=0;
    for(const k of Object.keys(res)){cpu+=res[k]?.cpu||0;memory+=res[k]?.memory||0}
    return {cpu,memory};
  }catch{
    const {stdout}=await execFileAsync('ps',['-o','%cpu=,rss=','-p',pids.join(',')],{timeout:5000});
    let cpu=0,memory=0;for(const l of stdout.split('\n')){const m=l.trim().split(/\s+/).map(Number);if(m.length===2&&!m.some(isNaN)){cpu+=m[0];memory+=m[1]*1024}}
    return {cpu,memory};
  }
}
// Windows: pidusage использует wmic, которого нет в новых Windows 11 — берём данные через PowerShell/CIM.
let winSnap=null;const winPrev=new Map();
async function winProcesses(){
  if(winSnap&&Date.now()-winSnap.time<1500)return winSnap;
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress'],{timeout:15000,windowsHide:true,maxBuffer:64*1024*1024});
  let list=JSON.parse(stdout||'[]');if(!Array.isArray(list))list=[list];
  winSnap={time:Date.now(),list};return winSnap;
}
async function winStats(root){
  const snap=await winProcesses();
  const kids=new Map(),byPid=new Map();
  for(const p of snap.list){byPid.set(p.ProcessId,p);if(!kids.has(p.ParentProcessId))kids.set(p.ParentProcessId,[]);kids.get(p.ParentProcessId).push(p.ProcessId)}
  const seen=new Set([root]),queue=[root];let memory=0,cpuTime=0;
  while(queue.length){const pid=queue.shift(),p=byPid.get(pid);if(p){memory+=Number(p.WorkingSetSize)||0;cpuTime+=(Number(p.UserModeTime)||0)+(Number(p.KernelModeTime)||0)}for(const c of kids.get(pid)||[])if(!seen.has(c)){seen.add(c);queue.push(c)}}
  const prev=winPrev.get(root);let cpu=prev?.cpu??0;
  if(!prev||snap.time>prev.time){if(prev)cpu=Math.max(0,(cpuTime-prev.cpuTime)/10000/(snap.time-prev.time)*100);winPrev.set(root,{time:snap.time,cpuTime,cpu})}
  return {cpu,memory};
}
let sysCpu=0,sysPrev=os.cpus();
setInterval(()=>{const now=os.cpus();let idle=0,total=0;now.forEach((c,i)=>{const p=sysPrev[i]||c;for(const k in c.times)total+=c.times[k]-p.times[k];idle+=c.times.idle-p.times.idle});sysPrev=now;if(total>0)sysCpu=Math.min(100,Math.max(0,(1-idle/total)*100))},2000).unref();
// ---- M8: оборудование ----
app.get('/api/hw/info',auth,admin,async(q,r)=>{try{r.json(await HW.info(q.query.refresh==='1'))}catch(e){r.status(500).json({error:e.message})}});
app.get('/api/hw/live',auth,admin,async(q,r)=>{try{r.json(await HW.live({gpu:q.query.gpu!=='0'}))}catch(e){r.status(500).json({error:e.message})}});
app.get('/api/hw/disks',auth,admin,async(q,r)=>{try{r.json(await HW.disks({force:q.query.refresh==='1',spaceOnly:q.query.mode==='space'}))}catch(e){r.status(500).json({error:e.message})}});

// ---- M8: копирование и перемещение (в том числе между дисками) ----
const xfers=new Map();
const tick=()=>new Promise(r=>setImmediate(r));
async function xScan(p,job){const st=fs.lstatSync(p);if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile())){job.skippedCount++;if(job.skipped.length<30)job.skipped.push(p);return}if(st.isDirectory()){for(const e of fs.readdirSync(p)){if(++job._n%300===0)await tick();await xScan(path.join(p,e),job)}}else{job.total+=st.size;job.files++}}
async function xCopy(src,dst,job){
  const st=fs.lstatSync(src);
  if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile()))return; // ссылки не копируем (иначе можно «вытащить» посторонние файлы)
  if(st.isDirectory()){fs.mkdirSync(dst);for(const e of fs.readdirSync(src))await xCopy(path.join(src,e),path.join(dst,e),job);try{fs.utimesSync(dst,st.atime,st.mtime)}catch{}return}
  const tmp=dst+'.sm-part';
  try{
    await new Promise((res,rej)=>{const rs=fs.createReadStream(src),ws=fs.createWriteStream(tmp);rs.on('data',c=>{job.done+=c.length});rs.on('error',e=>{ws.destroy();rej(e)});ws.on('error',rej);ws.on('close',res);rs.pipe(ws)});
    fs.renameSync(tmp,dst);try{fs.utimesSync(dst,st.atime,st.mtime)}catch{}
  }catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
}
async function xVerify(a,b,job){ // оригинал удаляется только после того, как каждый файл копии совпал по размеру
  const sa=fs.lstatSync(a);if(sa.isSymbolicLink()||(!sa.isDirectory()&&!sa.isFile()))return;
  const sb=fs.statSync(b);
  if(sa.isDirectory()){for(const e of fs.readdirSync(a)){if(++job._n%300===0)await tick();await xVerify(path.join(a,e),path.join(b,e),job)}}
  else if(sb.size!==sa.size)throw Error('Проверка не пройдена: размер копии отличается — '+b);
}
app.post('/api/transfer',auth,admin,async(q,r)=>{try{
  const b=q.body||{},mode=b.mode==='move'?'move':'copy',S=b.src||{},D=b.dst||{};
  const sRoot=rootOf({query:S,body:{},user:q.user}),dRoot=rootOf({query:D,body:{},user:q.user});
  const srcRel=String(S.path||''),dirRel=String(D.path||'');
  const src=safeIn(sRoot,srcRel);
  if(src===path.resolve(sRoot))throw Error('Нельзя копировать или перемещать корень');
  if(!fs.existsSync(src))throw Error('Источник не найден');
  const dstDir=safeIn(dRoot,dirRel);
  if(!fs.existsSync(dstDir)||!fs.statSync(dstDir).isDirectory())throw Error('Папка назначения не найдена');
  const name=path.basename(String(b.name||path.basename(src))),dst=safeIn(dRoot,path.join(dirRel,name));
  const srcIsDir=fs.statSync(src).isDirectory();
  if(cmpP(path.resolve(src))===cmpP(path.resolve(dst)))throw Error('Источник и назначение совпадают');
  if(srcIsDir&&within(src,dst))throw Error('Нельзя копировать папку внутрь самой себя');
  if(mode==='move'&&panelAncestor(src))throw Error('Нельзя перемещать папку самой панели');
  if(fs.existsSync(dst)&&(!b.overwrite||srcIsDir||fs.statSync(dst).isDirectory()))throw Error(`В папке назначения уже есть «${name}»`+(srcIsDir?'':' (можно заменить файл)'));
  if([...xfers.values()].filter(j=>j.status==='running').length>=3)throw Error('Уже выполняется несколько операций — дождитесь завершения');
  const id=require('crypto').randomBytes(8).toString('hex');
  const job={id,mode,name,status:'running',phase:'scan',total:0,done:0,files:0,skipped:[],skippedCount:0,message:'',_n:0};
  xfers.set(id,job);
  const created=!fs.existsSync(dst);
  (async()=>{try{
    if(mode==='move'&&created){try{fs.renameSync(src,dst);job.phase='done';job.status='done';job.message='Перемещено';return}catch(e){if(e.code!=='EXDEV')throw e}} // тот же диск — мгновенно; другой диск — копирование
    await xScan(src,job);
    const u=await fs.promises.statfs(dstDir);
    if(u.bavail*u.bsize<job.total+16*1048576)throw Error(`Недостаточно места на диске назначения (нужно ${fmtBytes(job.total)}, свободно ${fmtBytes(u.bavail*u.bsize)})`);
    job.phase='copy';await xCopy(src,dst,job);
    job.phase='verify';job._n=0;await xVerify(src,dst,job);
    if(mode==='move'){
      if(job.skippedCount){job.message=`Скопировано, но оригинал НЕ удалён: ${job.skippedCount} ссылок/особых файлов не копируются`}
      else{job.phase='cleanup';fs.rmSync(src,{recursive:true,force:true});job.message='Перемещено (копия проверена, оригинал удалён)'}
    }else job.message=job.skippedCount?`Скопировано. Пропущено ссылок/особых файлов: ${job.skippedCount}`:'Скопировано';
    job.status='done';job.phase='done';
  }catch(e){
    job.status='error';job.message=fsErr(e);
    if(created){try{fs.rmSync(dst,{recursive:true,force:true})}catch{}} // убираем недокопированное; оригинал не тронут
  }finally{setTimeout(()=>xfers.delete(id),600000).unref()}})();
  audit(q.user,mode==='move'?'file_move':'file_copy',`${src} → ${dst}`);
  r.json({job:id});
}catch(e){r.status(400).json({error:fsErr(e)})}});
app.get('/api/transfer/:id',auth,admin,(q,r)=>{const j=xfers.get(String(q.params.id));if(!j)return r.status(404).json({error:'Операция не найдена'});const{_n,...o}=j;r.json(o)});
// ---- M9: распаковка архивов (ZIP/ZIPX, RAR, 7z, TAR, TAR.GZ/XZ/BZ2/ZST, GZ, XZ, BZ2 и др.) ----
const extracts=new Map();
const exLimits=()=>({bytes:Math.round((cfg.maxExtractMb||(cfg.maxExtractGb||20)*1024)*1048576),files:cfg.maxExtractFiles||300000}); // защита от «архивных бомб»
app.get('/api/extract/tools',auth,admin,async(q,r)=>{try{r.json(await ARC.toolSummary())}catch(e){r.status(500).json({error:e.message})}});
app.post('/api/extract',auth,admin,async(q,r)=>{try{
  const b=q.body||{},root=path.resolve(rootOf(q)),archive=safeQ(q,b.path),st=fs.statSync(archive);
  if(!st.isFile())throw Error('Это не файл');
  const name=path.basename(archive),parent=path.dirname(archive),mode=b.mode==='here'?'here':'folder';
  if(!ARC.classify(archive,name))throw Error('Файл не похож на архив или формат не распознан');
  let destDir=parent;
  if(mode==='folder'){const base=ARC.baseName(name);let n=base,i=2;while(fs.existsSync(path.join(parent,n)))n=`${base} (${i++})`;destDir=path.join(parent,n)}
  safeIn(root,path.relative(root,destDir)); // та же проверка путей, что и у остальных операций
  if([...extracts.values()].filter(j=>j.status==='running').length>=2)throw Error('Уже выполняются две распаковки — дождитесь завершения');
  const fsStat=await fs.promises.statfs(parent);
  if(fsStat.bavail*fsStat.bsize<Math.max(st.size*2,256*1048576))throw Error(`Недостаточно места на диске (свободно ${fmtBytes(fsStat.bavail*fsStat.bsize)})`);
  const id=require('crypto').randomBytes(8).toString('hex'),stage=path.join(parent,'.sm-extract-'+id);
  const job={id,name,status:'running',phase:'extract',files:0,bytes:0,links:0,skipped:0,message:'',tool:'',format:'',dest:path.relative(root,destDir).split(path.sep).join('/')};
  extracts.set(id,job);
  (async()=>{try{
    await ARC.extractToStage({archive,name,stage,limits:exLimits(),progress:job});
    job.phase='place';
    const pl=ARC.place(stage,destDir,{overwrite:!!b.overwrite,flatten:mode==='folder',deny:protectedPath});
    if(pl.files!=null)job.files=pl.files;
    job.skipped=pl.skipped;job.status='done';job.phase='done';
    job.message=`Распаковано файлов: ${job.files} (${fmtBytes(job.bytes)})`+(job.skipped?`. Пропущено существующих или защищённых файлов: ${job.skipped}`:'')+(job.links?`. Символические ссылки в архиве не создавались: ${job.links}`:'');
  }catch(e){job.status='error';job.message=fsErr(e)}
  finally{try{fs.rmSync(stage,{recursive:true,force:true})}catch{}setTimeout(()=>extracts.delete(id),600000).unref()}})();
  audit(q.user,'extract',`${archive} → ${destDir}`);
  r.json({job:id});
}catch(e){r.status(400).json({error:fsErr(e)})}});
app.get('/api/extract/:id',auth,admin,(q,r)=>{const j=extracts.get(String(q.params.id));if(!j)return r.status(404).json({error:'Операция не найдена'});r.json(j)});
app.get('/api/system',auth,(q,r)=>r.json({cpu:sysCpu,cores:os.cpus().length,memTotal:os.totalmem(),memUsed:os.totalmem()-os.freemem()}));
app.get('/api/apps/:id/stats',auth,async(q,r)=>{const a=db.prepare('SELECT * FROM apps WHERE id=?').get(+q.params.id),s=procs.get(a?.id);if(!s)return r.json({cpu:0,memory:0});try{r.json(process.platform==='win32'?await winStats(s.child.pid):await posixStats(s.child.pid))}catch(e){console.warn('stats error:',e.message);r.json({cpu:0,memory:0,error:e.message})}});
app.post('/api/apps/:id/backup',auth,async(q,r)=>{try{const a=appById(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});const b=await createBackup(a);const keep=num(q.body&&q.body.keep,0,0);if(keep)pruneBackups(a.id,keep);audit(q.user,'backup_create',`${a.name}: ${b.name}`);r.json({name:b.name,size:b.size,modified:b.modified,skipped:b.skipped})}catch(e){r.status(400).json({error:fsErr(e)})}});
app.post('/api/apps/:id/restore',auth,async(q,r)=>{try{const a=appById(+q.params.id);if(!a)return r.status(404).json({error:'Не найдено'});if(procs.has(a.id))return r.status(409).json({error:'Сначала остановите приложение'});const x=await restoreBackup(a,q.body&&q.body.name);audit(q.user,'backup_restore',`${a.name}: ${q.body.name}`);r.json({ok:true,safety:x.safety})}catch(e){r.status(400).json({error:fsErr(e)})}});
app.get('/api/backups',auth,(q,r)=>{try{r.json(listBackups(+q.query.app||0))}catch(e){r.status(400).json({error:e.message})}});
app.delete('/api/backups/:name',auth,(q,r)=>{try{const n=path.basename(q.params.name);if(!/\.zip$/i.test(n))throw Error('Недопустимый файл');fs.rmSync(path.join(BACKUP_ROOT,n),{force:true});audit(q.user,'backup_delete',n);r.json({ok:true})}catch(e){r.status(400).json({error:e.message})}});
app.get('/api/runtimes',auth,(q,r)=>r.json(runtime(q.query.refresh==='1')));
app.post('/api/runtimes/suggest',auth,(q,r)=>{const rt=runtime();r.json(infer(q.body.command,q.body.cwd).map(k=>({key:k,candidates:rt.filter(x=>x.key===k)})))});
app.post('/api/detect',auth,(q,r)=>{try{const d=detectProject(q.body.cwd);d.runtimes=runtime().filter(x=>x.key===d.runtime);r.json(d)}catch(e){r.status(400).json({error:e.message})}});
app.post('/api/scan',auth,(q,r)=>{try{r.json(scanProject(q.body.cwd))}catch(e){r.status(400).json({error:e.message})}});
app.get('/api/browse',auth,admin,async(q,r)=>{try{
  const requested=q.query.path||'';
  if(!requested){ // корень выбора папки: обнаруженные диски и разделы (с названием и свободным местом)
    let list=[];try{await HW.disks();list=HW.mountList()}catch{}
    if(!list.length&&process.platform==='win32'){for(let c=65;c<=90;c++){const d=String.fromCharCode(c)+':\\';try{if(fs.existsSync(d))list.push({mount:d,label:'',free:null})}catch{}}}
    if(!list.length)list=[{mount:path.parse(process.cwd()).root,label:'',free:null}];
    return r.json(list.map(p=>({name:`${p.mount}${p.label?'  ·  '+p.label:''}${p.free!=null?'  ·  свободно '+fmtBytes(p.free):''}`,type:'directory',path:p.mount})));
  }
  const target=path.resolve(requested);
  if(!fs.existsSync(target)||!fs.statSync(target).isDirectory())return r.status(400).json({error:'Папка не найдена или диск недоступен'});
  if(HW.blocked(fs.realpathSync(target)))return r.status(400).json({error:'Этот системный каталог недоступен'});
  r.json(fs.readdirSync(target,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>({name:e.name,type:'directory',path:path.join(target,e.name)})));
}catch(e){r.status(400).json({error:fsErr(e)})}});
// ---- M7: файлы. Без ?app= — общее хранилище (fileRoot); с ?app=ID (или body.app) — рабочая папка приложения ----
const EDIT_MAX=2*1024*1024;
function fileEntry(dir,e){const p=path.join(dir,e.name);if(protectedPath(p)||e.name.startsWith('.sm-extract-'))return null;let s;try{s=fs.statSync(p)}catch{try{s=fs.lstatSync(p)}catch{return null}}return{name:e.name,type:s.isDirectory()?'directory':'file',size:s.size,modified:s.mtime}}
app.get('/api/files',auth,(q,r)=>{try{const dir=safeQ(q,q.query.path||'');r.json(fs.readdirSync(dir,{withFileTypes:true}).map(e=>fileEntry(dir,e)).filter(Boolean).sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='directory'?-1:1))}catch(e){r.status(400).json({error:fsErr(e)})}});
app.get('/api/file',auth,(q,r)=>{try{
  const p=safeQ(q,q.query.path),st=fs.statSync(p);
  if(st.isDirectory())throw Error('Это папка');
  if(st.size>EDIT_MAX)return r.status(413).json({error:`Файл слишком большой для редактора (${(st.size/1048576).toFixed(1)} МБ, максимум 2 МБ). Скачайте его.`});
  const buf=fs.readFileSync(p);
  if(buf.subarray(0,8192).includes(0))return r.status(415).json({error:'Это бинарный файл — его нельзя редактировать как текст. Скачайте его.'});
  const raw=buf.toString('utf8');
  r.json({content:raw.replace(/\r\n/g,'\n'),eol:/\r\n/.test(raw)?'crlf':'lf',size:st.size,mtime:st.mtimeMs});
}catch(e){r.status(400).json({error:fsErr(e)})}});
app.post('/api/file',auth,(q,r)=>{try{
  const b=q.body||{},p=safeQ(q,b.path);
  if(fs.existsSync(p)){const st=fs.statSync(p);if(st.isDirectory())throw Error('Это папка');if(b.mtime&&!b.force&&Math.abs(st.mtimeMs-b.mtime)>1)return r.status(409).json({conflict:true,error:'Файл был изменён после того, как вы его открыли (другим пользователем или самим приложением).'})}
  else if(!fs.existsSync(path.dirname(p)))throw Error('Папка не найдена');
  let c=String(b.content??'');if(b.eol==='crlf')c=c.replace(/\r?\n/g,'\r\n');
  fs.writeFileSync(p,c,'utf8');
  r.json({ok:true,mtime:fs.statSync(p).mtimeMs});
}catch(e){r.status(400).json({error:fsErr(e)})}});
app.delete('/api/file',auth,(q,r)=>{try{const root=path.resolve(rootOf(q)),p=safeQ(q,q.body.path);if(p===root)throw Error('Нельзя удалить корневую папку');if(panelAncestor(p))throw Error('Это папка самой панели (или её родитель) — удалять нельзя');fs.rmSync(p,{recursive:true,force:true});r.json({ok:true})}catch(e){r.status(400).json({error:fsErr(e)})}});
app.post('/api/mkdir',auth,(q,r)=>{try{const p=safeQ(q,q.body.path);if(fs.existsSync(p))throw Error('Уже существует');fs.mkdirSync(p,{recursive:true});r.json({ok:true})}catch(e){r.status(400).json({error:fsErr(e)})}});
app.post('/api/rename',auth,(q,r)=>{try{const root=path.resolve(rootOf(q)),a=safeQ(q,q.body.oldPath),b=safeQ(q,q.body.newPath);if(a===root||b===root)throw Error('Недопустимый путь');if(panelAncestor(a))throw Error('Нельзя переименовать папку панели');if(!fs.existsSync(a))throw Error('Файл или папка не найдены');if(fs.existsSync(b))throw Error('Файл или папка с таким именем уже существует');fs.renameSync(a,b);r.json({ok:true})}catch(e){r.status(400).json({error:fsErr(e)})}});
const upload=multer({dest:path.join(ROOT,'.uploads'),limits:{fileSize:(cfg.maxUploadMb||512)*1024*1024}});fs.mkdirSync(path.join(ROOT,'.uploads'),{recursive:true});
app.post('/api/upload',auth,upload.single('file'),(q,r)=>{try{
  if(!q.file)throw Error('Файл не получен');
  let nm=q.file.originalname;try{const u=Buffer.from(nm,'latin1').toString('utf8');if(!u.includes('\ufffd'))nm=u}catch{} // multer отдаёт имя в latin1 — чиним кириллицу
  const dest=safeQ(q,path.join(String(q.body.path||''),path.basename(nm)));
  if(fs.existsSync(dest)&&!/^(1|true)$/.test(String(q.body.overwrite||''))){try{fs.unlinkSync(q.file.path)}catch{}return r.status(409).json({exists:true,error:'Файл уже существует'})}
  try{fs.renameSync(q.file.path,dest)}catch(e){if(e.code!=='EXDEV')throw e;fs.copyFileSync(q.file.path,dest);fs.unlinkSync(q.file.path)} // другой диск
  r.json({ok:true,name:path.basename(dest)});
}catch(e){if(q.file)try{fs.unlinkSync(q.file.path)}catch{}r.status(400).json({error:fsErr(e)})}});
app.get('/api/download',auth,(q,r)=>{try{
  if(q.query.backup){const n=path.basename(String(q.query.backup));if(!/\.zip$/i.test(n))throw Error('Недопустимый файл');const f=path.join(BACKUP_ROOT,n);if(!fs.existsSync(f))throw Error('Backup не найден');return r.download(f,n)}
  if(q.query.applog){const id=+q.query.applog,f=logFile(id);logFlush(id);if(!fs.existsSync(f))throw Error('Лог пуст');return r.download(f,`app-${id}.log`)}
  const p=safeQ(q,q.query.path),st=fs.statSync(p);
  if(st.isDirectory()){const z=archiver('zip',{zlib:{level:5}});r.attachment((path.basename(p)||'folder')+'.zip');z.on('error',()=>r.destroy());z.pipe(r);z.directory(p,false);z.finalize();return}
  r.download(p);
}catch(e){r.status(400).json({error:fsErr(e)})}});
// ---- M7: профили запуска ----
const sameEnv=(a,b)=>{const x=parseEnv(a),y=parseEnv(b),kx=Object.keys(x).sort(),ky=Object.keys(y).sort();return kx.length===ky.length&&kx.every((k,i)=>k===ky[i]&&String(x[k])===String(y[k]))};
const profActive=(a,p)=>p.command===a.command&&(p.runtime_path||'')===(a.runtime_path||'')&&sameEnv(p.env_json,a.env_json);
const profilesOf=a=>db.prepare('SELECT * FROM profiles WHERE app_id=? ORDER BY id').all(a.id).map(p=>({...p,active:profActive(a,p)}));
app.get('/api/apps/:id/profiles',auth,(q,r)=>{const a=appById(+q.params.id);if(!a)return r.status(404).json({error:'Приложение не найдено'});r.json(profilesOf(a))});
app.post('/api/apps/:id/profiles',auth,admin,(q,r)=>{try{
  const a=appById(+q.params.id);if(!a)return r.status(404).json({error:'Приложение не найдено'});
  const b=q.body||{},name=String(b.name||'').trim();
  if(!name)throw Error('Введите название профиля');
  if(db.prepare('SELECT 1 FROM profiles WHERE app_id=? AND name=?').get(a.id,name))throw Error('Профиль с таким названием уже есть');
  let command,rp,env,launch;
  if(b.from_current){command=a.command;rp=a.runtime_path||'';env=a.env_json||'{}';launch=a.launch_json||''}
  else{command=String(b.command||'').trim();if(!command)throw Error('Введите команду запуска');rp=String(b.runtime_path||'').trim();env=JSON.stringify(cleanEnv(b.env));launch=''}
  const x=db.prepare('INSERT INTO profiles(app_id,name,command,runtime_path,env_json,note,launch_json) VALUES(?,?,?,?,?,?,?)').run(a.id,name,command,rp,env,String(b.note||'').trim().slice(0,300),launch);
  audit(q.user,'profile_create',`${a.name}: ${name}`);
  r.json(db.prepare('SELECT * FROM profiles WHERE id=?').get(x.lastInsertRowid));
}catch(e){r.status(400).json({error:e.message})}});
app.put('/api/profiles/:id',auth,admin,(q,r)=>{try{
  const id=+q.params.id,b=q.body||{},old=db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
  if(!old)return r.status(404).json({error:'Профиль не найден'});
  const name=String(b.name??old.name).trim(),command=String(b.command??old.command).trim();
  if(!name)throw Error('Введите название профиля');if(!command)throw Error('Введите команду запуска');
  if(name!==old.name&&db.prepare('SELECT 1 FROM profiles WHERE app_id=? AND name=? AND id!=?').get(old.app_id,name,id))throw Error('Профиль с таким названием уже есть');
  const env=b.env!==undefined?JSON.stringify(cleanEnv(b.env)):old.env_json;
  db.prepare('UPDATE profiles SET name=?,command=?,runtime_path=?,env_json=?,note=?,launch_json=? WHERE id=?').run(name,command,String(b.runtime_path??old.runtime_path??'').trim(),env,String(b.note??old.note??'').trim().slice(0,300),command!==old.command?'':(old.launch_json||''),id);
  audit(q.user,'profile_update',`#${old.app_id}: ${name}`);
  r.json(db.prepare('SELECT * FROM profiles WHERE id=?').get(id));
}catch(e){r.status(400).json({error:e.message})}});
app.delete('/api/profiles/:id',auth,admin,(q,r)=>{const p=db.prepare('SELECT * FROM profiles WHERE id=?').get(+q.params.id);db.prepare('DELETE FROM profiles WHERE id=?').run(+q.params.id);if(p)audit(q.user,'profile_delete',`#${p.app_id}: ${p.name}`);r.json({ok:true})});
app.post('/api/apps/:id/profiles/:profileId/apply',auth,async(q,r)=>{try{
  const a=appById(+q.params.id),p=db.prepare('SELECT * FROM profiles WHERE id=? AND app_id=?').get(+q.params.profileId,+q.params.id);
  if(!a||!p)return r.status(404).json({error:'Не найдено'});
  const running=procs.has(a.id),again=!!(q.body&&q.body.restart);
  if(running&&!again)return r.status(409).json({error:'Приложение запущено. Остановите его или выберите «Применить и перезапустить».',running:true});
  if(running){stop(a,false);if(!(await waitForExit(a.id,62000))){stop(a,true);await waitForExit(a.id,3000)}}
  db.prepare('UPDATE apps SET command=?,runtime_path=?,env_json=?,launch_json=? WHERE id=?').run(p.command,p.runtime_path,p.env_json,p.launch_json||'',a.id);
  audit(q.user,'profile_apply',`${a.name}: ${p.name}`);
  if(running)await startWithDeps(appById(a.id));
  r.json({...appById(a.id),restarted:running});
}catch(e){r.status(400).json({error:e.message})}});

app.get('/api/apps/:id/log',auth,(q,r)=>{try{const f=logFile(+q.params.id);logFlush(+q.params.id);if(!fs.existsSync(f))return r.type('text').send('');const kb=Math.min(4096,Math.max(16,num(q.query.kb,256,1)));r.type('text').send(tailFile(f,kb*1024))}catch(e){r.status(400).json({error:fsErr(e)})}});
app.delete('/api/apps/:id/log',auth,(q,r)=>{try{logClear(+q.params.id);r.json({ok:true})}catch(e){r.status(400).json({error:fsErr(e)})}});

async function dockerCommand(args){try{return await execFileAsync(process.platform==='win32'?'docker':'docker',args,{timeout:30000,windowsHide:true,maxBuffer:5*1024*1024});}catch(e){throw Error((e.stderr||e.message||'Docker error').trim());}}
app.get('/api/docker',auth,async(q,r)=>{try{const {stdout}=await dockerCommand(['ps','-a','--format','{{json .}}']);const rows=stdout.split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));r.json(rows);}catch(e){r.status(400).json({error:e.message})}});
app.post('/api/docker/run',auth,async(q,r)=>{try{const b=q.body||{};if(!b.image)return r.status(400).json({error:'Image обязательен'});const args=['run','-d','--name',String(b.name||`sm-${Date.now()}`)];if(b.ports){for(const p of String(b.ports).split(',').map(x=>x.trim()).filter(Boolean))args.push('-p',p)}args.push(b.image);if(b.command)args.push(...String(b.command).split(/\s+/));const {stdout}=await dockerCommand(args);audit(q.user,'docker_run',b.name||b.image);r.json({id:stdout.trim()});}catch(e){r.status(400).json({error:e.message})}});
for(const action of ['start','stop','restart','remove'])app.post(`/api/docker/:id/${action}`,auth,async(q,r)=>{try{const id=String(q.params.id);const args=action==='remove'?['rm','-f',id]:[action,id];await dockerCommand(args);audit(q.user,`docker_${action}`,id);r.json({ok:true});}catch(e){r.status(400).json({error:e.message})}});
app.get('/api/docker/:id/logs',auth,async(q,r)=>{try{const {stdout,stderr}=await dockerCommand(['logs','--tail','500',String(q.params.id)]);r.type('text').send((stdout||'')+(stderr||''));}catch(e){r.status(400).json({error:e.message})}});
// ---- M7: задачи по расписанию ----
const TASK_ACTIONS=['start','stop','restart','backup','command'];
const taskBusy=new Set();
function parseField(s,min,max,sun){
  const set=new Set();
  for(const part of String(s).split(',')){
    const m=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);if(!m)return null;
    let lo,hi;
    if(m[1]==='*'){lo=min;hi=max}else if(m[1].includes('-')){[lo,hi]=m[1].split('-').map(Number)}else{lo=+m[1];hi=m[2]?max:lo}
    const st=m[2]?+m[2]:1;if(!st||lo<min||hi>max||lo>hi)return null;
    for(let v=lo;v<=hi;v+=st)set.add(sun&&v===7?0:v);
  }
  return set;
}
const lt=d=>{const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`};
function nextRuns(expr,n=3){ // ближайшие запуски для 5-польного cron (локальное время сервера)
  const f=String(expr).trim().split(/\s+/);if(f.length!==5)return[];
  const mi=parseField(f[0],0,59),ho=parseField(f[1],0,23),dm=parseField(f[2],1,31),mo=parseField(f[3],1,12),dw=parseField(f[4],0,7,true);
  if(!mi||!ho||!dm||!mo||!dw)return[];
  const out=[],d=new Date();d.setSeconds(0,0);d.setMinutes(d.getMinutes()+1);
  for(let i=0;i<600000&&out.length<n;i++){
    if(!mo.has(d.getMonth()+1)||!dm.has(d.getDate())||!dw.has(d.getDay())){d.setHours(0,0,0,0);d.setDate(d.getDate()+1);continue}
    if(!ho.has(d.getHours())){d.setMinutes(0,0,0);d.setHours(d.getHours()+1);continue}
    if(mi.has(d.getMinutes()))out.push(lt(d));
    d.setMinutes(d.getMinutes()+1);
  }
  return out;
}
async function runTask(t,by='расписание'){
  if(taskBusy.has(t.id))return;taskBusy.add(t.id);
  let status='ok',msg='';
  try{
    const a=appById(t.app_id);if(!a)throw Error('Приложение удалено');
    const on=procs.has(a.id);
    if(t.action==='start'){if(on)msg='Уже запущено — пропущено';else{await startWithDeps(a);msg='Запущено'}}
    else if(t.action==='stop'){if(!on)msg='Не запущено — пропущено';else{stop(a);msg='Команда остановки отправлена'}}
    else if(t.action==='restart'){await restart(a);msg='Перезапущено'}
    else if(t.action==='backup'){const b=await createBackup(a);const pr=t.keep>0?pruneBackups(a.id,t.keep):0;msg=`${b.name} (${fmtBytes(b.size)})${b.skipped.length?`; пропущено занятых файлов: ${b.skipped.length}`:''}${pr?`; удалено старых копий: ${pr}`:''}`}
    else if(t.action==='command'){const s=procs.get(a.id);if(!s||!s.child.stdin.writable)throw Error('Приложение не запущено');s.child.stdin.write(String(t.payload||'')+'\n');msg='Команда отправлена'}
    else throw Error('Неизвестное действие');
  }catch(e){status='error';msg=e.message;broadcast({type:'task_error',id:t.id,error:e.message})}
  finally{taskBusy.delete(t.id)}
  db.prepare('UPDATE tasks SET last_run=?,last_status=?,last_message=? WHERE id=?').run(lt(new Date()),status,String(msg).slice(0,400),t.id);
  audit({username:by},'task_run',`${t.name}: ${status==='ok'?'OK':'ОШИБКА'} — ${msg}`);
}
function registerTask(t){
  jobs.get(t.id)?.stop();jobs.delete(t.id);
  if(!t.enabled||!cron.validate(t.cron))return;
  jobs.set(t.id,cron.schedule(t.cron,()=>{const cur=db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id);if(cur&&cur.enabled)runTask(cur)}));
}
const taskOut=t=>({...t,enabled:!!t.enabled,next:t.enabled?(nextRuns(t.cron,1)[0]||null):null,running:taskBusy.has(t.id)});
function taskInput(b,o){
  const name=String(b.name??o?.name??'').trim();if(!name)throw Error('Название обязательно');
  const cr=String(b.cron??o?.cron??'').trim().replace(/\s+/g,' ');
  if(cr.split(' ').length!==5||!cron.validate(cr))throw Error('Некорректное расписание (нужен cron из 5 полей)');
  const action=String(b.action??o?.action??'');if(!TASK_ACTIONS.includes(action))throw Error('Недопустимое действие');
  const app_id=+(b.app_id??o?.app_id);if(!appById(app_id))throw Error('Приложение не найдено');
  const payload=String(b.payload??o?.payload??'').trim();if(action==='command'&&!payload)throw Error('Введите команду для консоли');
  const keep=action==='backup'?Math.min(1000,num(b.keep,o?o.keep:0,0)):0;
  const enabled=b.enabled===undefined?(o?o.enabled:1):(b.enabled?1:0);
  return{name,cron:cr,action,app_id,payload:action==='command'?payload:'',keep,enabled};
}
app.get('/api/tasks',auth,(q,r)=>r.json(db.prepare('SELECT * FROM tasks ORDER BY id DESC').all().map(taskOut)));
app.get('/api/tasks/preview',auth,(q,r)=>r.json({next:nextRuns(String(q.query.cron||''),3)}));
app.post('/api/tasks',auth,(q,r)=>{try{const v=taskInput(q.body||{},null);const x=db.prepare('INSERT INTO tasks(name,cron,app_id,action,enabled,payload,keep) VALUES(?,?,?,?,?,?,?)').run(v.name,v.cron,v.app_id,v.action,v.enabled,v.payload,v.keep);const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(x.lastInsertRowid);registerTask(t);audit(q.user,'task_create',t.name);r.json(taskOut(t))}catch(e){r.status(400).json({error:e.message})}});
app.put('/api/tasks/:id',auth,(q,r)=>{try{const id=+q.params.id,o=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!o)return r.status(404).json({error:'Задача не найдена'});const v=taskInput(q.body||{},o);db.prepare('UPDATE tasks SET name=?,cron=?,app_id=?,action=?,enabled=?,payload=?,keep=? WHERE id=?').run(v.name,v.cron,v.app_id,v.action,v.enabled,v.payload,v.keep,id);const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);registerTask(t);audit(q.user,'task_update',t.name);r.json(taskOut(t))}catch(e){r.status(400).json({error:e.message})}});
app.post('/api/tasks/:id/run',auth,(q,r)=>{const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(+q.params.id);if(!t)return r.status(404).json({error:'Задача не найдена'});if(taskBusy.has(t.id))return r.status(409).json({error:'Задача уже выполняется'});runTask(t,q.user.username+' (вручную)');r.json({ok:true})});
app.delete('/api/tasks/:id',auth,(q,r)=>{const id=+q.params.id;jobs.get(id)?.stop();jobs.delete(id);db.prepare('DELETE FROM tasks WHERE id=?').run(id);r.json({ok:true})});
app.get('/api/audit',auth,(q,r)=>r.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all()));
app.post('/api/password',auth,(q,r)=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(q.user.id);if(!bcrypt.compareSync(q.body.currentPassword||'',u.password_hash))return r.status(400).json({error:'Текущий пароль неверен'});if(String(q.body.newPassword||'').length<8)return r.status(400).json({error:'Новый пароль должен содержать минимум 8 символов'});db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(q.body.newPassword,12),u.id);r.json({ok:true})});

wss.on('connection',(socket,req)=>{if(NODES.bridge(socket,req))return;try{const u=new URL(req.url,'http://localhost');const token=u.searchParams.get('token');if(!NODES.isAgentToken(token)){const decoded=jwt.verify(token,cfg.jwtSecret);if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(decoded.id))throw Error();}socket.send(JSON.stringify({type:'hello'}));for(const [id,s] of procs){for(const h of s.history)socket.send(JSON.stringify({type:'output',id,stream:h.stream,data:h.data,time:h.time}))}}catch{socket.close(1008,'Unauthorized')}});

db.prepare('SELECT * FROM tasks WHERE enabled=1').all().forEach(registerTask);
(async()=>{for(const a of db.prepare('SELECT * FROM apps WHERE auto_start=1 ORDER BY id').all()){if(procs.has(a.id))continue;try{await startWithDeps(a)}catch(e){console.error('Autostart:',a.name,e.message)}}})();

const PORT=cfg.port||80;const HOST=cfg.host||'127.0.0.1';process.on('uncaughtException',e=>console.error('uncaughtException:',e));
process.on('unhandledRejection',e=>console.error('unhandledRejection:',e));
server.on('error',e=>NODES.listenError(e,PORT,HOST));server.listen(PORT,HOST,()=>NODES.listening(PORT,HOST));
function shutdown(){for(const a of db.prepare('SELECT * FROM apps').all())stop(a,true);for(const c of wss.clients)c.terminate();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref()}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
