#!/usr/bin/env node
'use strict';
// Подготовка Server Manager к запуску в Linux. Безопасно запускать повторно.
//   node linux-setup.js [--root /opt/server-manager] [--files /srv/servers] [--port 80]
//        [--map "E:\Bof\Bof=/srv/servers/bof"] ...   (можно несколько --map)
// Что делает: правит config.json (fileRoot/port/host), патчит server.js (Windows-путь, SIGTERM),
// переписывает пути приложений в server.db (Windows → Linux). Копии: *.bak-linux
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2),opt={map:[]};
for(let i=0;i<args.length;i++){const a=args[i];if(!a.startsWith('--'))continue;const k=a.slice(2),v=args[++i];if(k==='map')opt.map.push(v);else opt[k]=v}
const root=path.resolve(opt.root||'.');
const rd=f=>fs.readFileSync(f,'utf8');
const backup=f=>{const b=f+'.bak-linux';if(!fs.existsSync(b))fs.copyFileSync(f,b)};

// 1. config.json
const cfgPath=path.join(root,'config.json');
if(!fs.existsSync(cfgPath)){console.error('✗ нет config.json в '+root);process.exit(1)}
backup(cfgPath);
const cfg=JSON.parse(rd(cfgPath));
const files=opt.files||(/^[A-Za-z]:[\\/]/.test(cfg.fileRoot||'')||!cfg.fileRoot?'./servers':cfg.fileRoot);
cfg.fileRoot=files;
cfg.port=+(opt.port||80);
cfg.host=cfg.host||'0.0.0.0';
fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2));
console.log(`✓ config.json: fileRoot=${cfg.fileRoot}, port=${cfg.port}, host=${cfg.host}`);

// 2. server.js
const srvPath=path.join(root,'server.js');
let s=rd(srvPath),changed=false;
const A="const FILE_ROOT=path.resolve(ROOT,cfg.fileRoot);";
const A2="if(process.platform!=='win32'&&/^[A-Za-z]:[\\\\/]/.test(String(cfg.fileRoot||''))){console.warn('fileRoot в стиле Windows ('+cfg.fileRoot+') — используется ./servers');cfg.fileRoot='./servers'}\n"+A;
if(s.includes(A)&&!s.includes('fileRoot в стиле Windows')){s=s.replace(A,A2);changed=true}
const B="process.on('SIGINT',shutdown);";
if(s.includes(B)&&!s.includes("process.on('SIGTERM'")){s=s.replace(B,B+"process.on('SIGTERM',shutdown);");changed=true}
if(changed){backup(srvPath);fs.writeFileSync(srvPath,s);console.log('✓ server.js пропатчен (Windows-путь fileRoot, SIGTERM)')}else console.log('• server.js уже готов');

// 3. server.db
const dbPath=path.join(root,'server.db');
if(fs.existsSync(dbPath)){
  let Database;try{Database=require(path.join(root,'node_modules','better-sqlite3'))}catch{console.log('• better-sqlite3 не установлен — миграцию БД выполните после npm install (повторный запуск скрипта)');process.exit(0)}
  backup(dbPath);
  const db=new Database(dbPath);
  const maps=opt.map.map(m=>{const i=m.lastIndexOf('=');return[m.slice(0,i).replace(/[\\/]+$/,'').replace(/\\/g,'/').toLowerCase(),m.slice(i+1).replace(/\/+$/,'')]});
  const conv=p=>{if(!p)return p;if(!/^[A-Za-z]:[\\/]|\\/.test(p))return p;const n=p.replace(/\\/g,'/');
    for(const[from,to]of maps)if(n.toLowerCase()===from||n.toLowerCase().startsWith(from+'/'))return to+n.slice(from.length);
    return p};
  const up=db.prepare('UPDATE apps SET working_dir=?,runtime_path=? WHERE id=?');
  for(const a of db.prepare('SELECT id,name,command,working_dir,runtime_path FROM apps').all()){
    const w=conv(a.working_dir),r=conv(a.runtime_path);
    if(w!==a.working_dir||r!==a.runtime_path){up.run(w,r,a.id);console.log(`✓ app #${a.id} «${a.name}»: ${a.working_dir} → ${w}`)}
    else if(/^[A-Za-z]:[\\/]|\\/.test(a.working_dir))console.log(`! app #${a.id} «${a.name}»: путь Windows остался (${a.working_dir}) — добавьте --map`);
    if(/\.(bat|cmd)\b|\.exe\b|powershell/i.test(a.command))console.log(`! app #${a.id} «${a.name}»: команда Windows (${a.command.slice(0,60)}) — замените на start.sh / java -jar ...`);
  }
  db.close();
}
