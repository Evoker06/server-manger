'use strict';
// Автообнаружение агентов в локальной сети (UDP-broadcast) и одноразовые коды подключения.
const dgram=require('dgram'),os=require('os'),crypto=require('crypto');

const UDP_PORT=41234,MAGIC='server-manager/1';
const ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 символа без похожих 0/O и 1/I

/** Широковещательные адреса всех сетевых карт (255.255.255.255 на Windows уходит только через одну карту). */
function broadcastTargets(){
  const out=new Set(['255.255.255.255']);
  for(const list of Object.values(os.networkInterfaces()))for(const i of list||[]){
    if(i.family!=='IPv4'||i.internal||!i.netmask)continue;
    const ip=i.address.split('.').map(Number),mask=i.netmask.split('.').map(Number);
    out.add(ip.map((b,k)=>(b&mask[k])|(~mask[k]&255)).join('.'));
  }
  return [...out];
}

/** Агент: каждые несколько секунд сообщает «я здесь». Пароли и токены в рассылку не попадают. */
function startAnnouncer({id,name,port,targets=broadcastTargets(),udpPort=UDP_PORT,interval=3000}){
  const s=dgram.createSocket('udp4');
  s.on('error',()=>{});
  s.bind(0,()=>{try{s.setBroadcast(true)}catch{}});
  const body=Buffer.from(JSON.stringify({m:MAGIC,id,name,port}));
  const tick=()=>{for(const t of targets)try{s.send(body,udpPort,t,()=>{})}catch{}};
  const timer=setInterval(tick,interval);timer.unref();
  setTimeout(tick,300).unref();
  return {stop(){clearInterval(timer);try{s.close()}catch{}}};
}

/** Панель: слушает объявления агентов. */
function startListener({udpPort=UDP_PORT,onSeen}){
  const s=dgram.createSocket({type:'udp4',reuseAddr:true});
  s.on('error',e=>console.warn(`[discovery] UDP ${udpPort}: ${e.message} — автопоиск компьютеров отключён`));
  s.on('message',(buf,rinfo)=>{
    try{
      const d=JSON.parse(buf.toString());
      if(d.m!==MAGIC||!d.id||!(+d.port>0&&+d.port<65536))return;
      onSeen({id:String(d.id).slice(0,64),name:String(d.name||'').slice(0,60),port:+d.port,ip:rinfo.address});
    }catch{}
  });
  try{s.bind(udpPort,'0.0.0.0')}catch(e){console.warn('[discovery] '+e.message)}
  return {stop(){try{s.close()}catch{}}};
}

/** Код подключения: 8 символов (≈40 бит), одноразовый, живёт 30 минут, после 8 ошибок — блокировка на 10 минут. */
function makePairing({ttlMs=30*60*1000,maxFails=8,lockMs=10*60*1000,onNew}={}){
  let code='',exp=0,fails=[];
  const fmt=c=>c.slice(0,4)+'-'+c.slice(4);
  function gen(){code=Array.from(crypto.randomBytes(8),b=>ALPHA[b&31]).join('');exp=Date.now()+ttlMs;if(onNew)onNew(fmt(code),ttlMs)}
  gen();
  return {
    current:()=>fmt(code),
    tryCode(input){
      const now=Date.now();fails=fails.filter(t=>now-t<lockMs);
      if(fails.length>=maxFails)return {ok:false,status:429,error:'Слишком много неверных попыток. Подождите 10 минут'};
      if(now>exp){gen();return {ok:false,status:410,error:'Код истёк. Новый код показан в консоли агента'}}
      const norm=String(input||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      if(norm.length===8&&crypto.timingSafeEqual(Buffer.from(norm),Buffer.from(code))){gen();return {ok:true}}
      fails.push(now);
      return {ok:false,status:403,error:'Неверный код'};
    }
  };
}

module.exports={UDP_PORT,broadcastTargets,startAnnouncer,startListener,makePairing};
