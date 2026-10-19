'use strict';
// Сведения об оборудовании и дисках. Всё выполняется на сервере; внешние команды запускаются
// ТОЛЬКО с фиксированными аргументами (ничего из HTTP-запросов в команды не попадает).
// Windows: PowerShell + CIM/Storage-командлеты. Linux: /proc, /sys, lsblk, (опционально) nvidia-smi, smartctl.
// Если характеристику получить нельзя — возвращается null, а интерфейс пишет «Недоступно».
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');
const win = process.platform === 'win32', lin = process.platform === 'linux';
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const num = v => {
  if (v === null || v === undefined || v === '')
    return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const truthy = v => v === true || v === 1 || v === '1' || v === 'true';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
function run(cmd, args, opt = {}) {
  return new Promise((res, rej) => {
    const c = execFile(cmd, args, { timeout: opt.timeout || 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (e, so, se) => e ? rej(Object.assign(e, { stdout: so, stderr: se })) : res({ stdout: so, stderr: se }));
    if (c.stdin)
      c.stdin.end();
  });
}
function which(name) {
  const names = win ? [name + '.exe', name + '.cmd', name] : [name];
  for (const d of String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean))
    for (const n of names) {
      const f = path.join(d, n);
      try {
        if (fs.statSync(f).isFile())
          return f;
      }
      catch {
      }
    }
  return null;
}
const PSHEAD = "$ErrorActionPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
async function psJson(script, timeout = 30000) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PSHEAD + script], { timeout });
  const t = stdout.replace(/^\uFEFF/, '').trim();
  if (!t)
    throw Error('PowerShell вернул пустой ответ');
  return JSON.parse(t);
}
const readText = f => {
  try {
    return fs.readFileSync(f, 'utf8');
  }
  catch {
    return null;
  }
};
const readdir = d => {
  try {
    return fs.readdirSync(d);
  }
  catch {
    return [];
  }
};
const readTemp = f => {
  const t = readText(f);
  const v = t == null ? NaN : parseInt(t, 10);
  return Number.isFinite(v) && v > 0 && v < 150000 ? v / 1000 : null;
};
/* ---------------- тип накопителя ---------------- */
// Тип определяется только по данным системы (интерфейс, флаг вращения, MediaType). По букве диска или скорости — никогда.
function classifyDisk({ kname = '', bus = '', media = '', rota = null, model = '', removable = false }) {
  const b = String(bus).toLowerCase(), m = String(media).toLowerCase();
  if (/qemu|vbox|virtualbox|vmware|virtual|msft|hyper-v|xen/i.test(model) || /^(virtio|virtual|file backed virtual|storage spaces)$/.test(b))
    return { type: 'Не определён', note: 'Виртуальный диск: система не сообщает, какой носитель находится под ним.' };
  if (b === 'nvme' || /^nvme/i.test(kname))
    return { type: 'NVMe', note: '' };
  if (m === 'ssd')
    return { type: 'SSD', note: '' };
  if (m === 'hdd')
    return { type: 'HDD', note: '' };
  if (m === 'scm')
    return { type: 'Не определён', note: 'Память класса SCM.' };
  if (rota === true && !/^(mmc|sd)$/.test(b))
    return { type: 'HDD', note: '' };
  if (rota === false && ['sata', 'ata', 'sas'].includes(b))
    return { type: 'SSD', note: '' };
  return { type: 'Не определён', note: removable || b === 'usb' ? 'USB-накопитель: система не сообщает, флешка это, SSD или HDD.' : 'Система не сообщает тип носителя.' };
}
const HEALTH_RU = { healthy: 'Исправен', warning: 'Предупреждение', unhealthy: 'Неисправен' };
/* ---------------- разделы ---------------- */
function mkPartition(o) {
  const size = num(o.size), free = num(o.free);
  const used = size != null && free != null ? Math.max(0, size - free) : (num(o.used));
  return {
    mount: o.mount, label: o.label || '', fs: o.fs || '', kind: o.kind || 'fixed', system: !!o.system, readOnly: !!o.readOnly,
    size, used, free, percent: size ? Math.round((used / size) * 1000) / 10 : null,
    accessible: o.accessible !== false, note: o.note || '',
  };
}
// свободное место (в Windows и Linux одинаково)
async function statMount(mount) {
  const s = await fs.promises.statfs(mount);
  const bs = s.bsize, total = s.blocks * bs, free = s.bavail * bs, used = (s.blocks - s.bfree) * bs;
  return { total, free, used };
}
/* ---------------- Windows: накопители ---------------- */
const WIN_DISK_PS = String.raw `
$pd=@(Get-PhysicalDisk | ForEach-Object { [pscustomobject]@{Id=[string]$_.DeviceId;Name=[string]$_.FriendlyName;Media=[string]$_.MediaType;Bus=[string]$_.BusType;Size=[int64]$_.Size;Health=[string]$_.HealthStatus;Op=(@($_.OperationalStatus) -join ',')} })
$dk=@(Get-Disk | ForEach-Object { [pscustomobject]@{Number=[int]$_.Number;Name=[string]$_.FriendlyName;Size=[int64]$_.Size;Offline=[bool]$_.IsOffline;Boot=[bool]$_.IsBoot;System=[bool]$_.IsSystem;Bus=[string]$_.BusType;Style=[string]$_.PartitionStyle} })
$pt=@(Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { [pscustomobject]@{Disk=[int]$_.DiskNumber;Letter=[string]$_.DriveLetter} })
$lg=@(Get-CimInstance Win32_LogicalDisk | ForEach-Object { [pscustomobject]@{Id=[string]$_.DeviceID;Type=[int]$_.DriveType;Label=[string]$_.VolumeName;Fs=[string]$_.FileSystem;Size=[int64]$_.Size;Free=[int64]$_.FreeSpace;Provider=[string]$_.ProviderName} })
$rc=@(Get-PhysicalDisk | ForEach-Object { $r=$_ | Get-StorageReliabilityCounter; [pscustomobject]@{Id=[string]$_.DeviceId;Temp=$r.Temperature;Hours=$r.PowerOnHours} })
[pscustomobject]@{pd=$pd;dk=$dk;pt=$pt;lg=$lg;rc=$rc} | ConvertTo-Json -Depth 5 -Compress`;
// Чистая функция (удобно проверять на образцах): превращает ответ PowerShell в список дисков.
function buildWindowsDisks(d, sysDrive = (process.env.SystemDrive || 'C:')) {
  const pd = arr(d.pd), dk = arr(d.dk), pt = arr(d.pt), lg = arr(d.lg), rc = arr(d.rc);
  const letterToDisk = new Map(pt.map(p => [String(p.Letter).toUpperCase() + ':', num(p.Disk)]));
  const rcById = new Map(rc.map(r => [String(r.Id), r]));
  const pdById = new Map(pd.map(p => [String(p.Id), p]));
  const ids = new Set([...pd.map(p => String(p.Id)), ...dk.map(x => String(x.Number))]);
  const dkByNum = new Map(dk.map(x => [String(x.Number), x]));
  const disks = [], used = new Set();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const p = pdById.get(id) || {}, k = dkByNum.get(id) || {};
    const cls = classifyDisk({ bus: p.Bus || k.Bus, media: p.Media, model: p.Name || k.Name });
    const rel = rcById.get(id) || {};
    const hRaw = String(p.Health || '').toLowerCase();
    const parts = [];
    for (const l of lg) {
      if (letterToDisk.get(l.Id.toUpperCase()) !== Number(id))
        continue;
      used.add(l.Id.toUpperCase());
      parts.push(winPartition(l, sysDrive));
    }
    disks.push({
      id: 'disk' + id, name: (p.Name || k.Name || 'Диск ' + id).trim(), type: cls.type, typeNote: cls.note,
      bus: p.Bus || k.Bus || null, size: num(p.Size) || num(k.Size), removable: /usb|sd|mmc/i.test(p.Bus || k.Bus || ''),
      status: k.Offline ? 'offline' : 'ok',
      statusNote: k.Offline ? 'Диск отключён (Offline). Включите его в «Управлении дисками» Windows.' : (p.Op && !/^ok$/i.test(p.Op) ? 'Состояние: ' + p.Op : ''),
      health: HEALTH_RU[hRaw] || null, healthRaw: hRaw || null,
      temperature: num(rel.Temp), powerOnHours: num(rel.Hours),
      smart: hRaw ? { status: hRaw === 'healthy' ? 'ok' : hRaw === 'warning' ? 'warn' : 'fail', note: 'Состояние по данным Windows Storage' } : { status: 'unavailable', note: 'Windows не сообщила состояние' },
      partitions: parts,
    });
  }
  const others = lg.filter(l => !used.has(l.Id.toUpperCase())).map(l => winPartition(l, sysDrive));
  return { disks, others };
}
function winPartition(l, sysDrive) {
  const kinds = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'other' };
  const kind = kinds[l.Type] || 'other';
  const noMedia = (kind === 'removable' || kind === 'optical') && !num(l.Size);
  return mkPartition({
    mount: l.Id.toUpperCase() + '\\', label: l.Label || (l.Provider || ''), fs: l.Fs, kind, system: l.Id.toUpperCase() === String(sysDrive).toUpperCase(),
    size: l.Size, free: l.Free, accessible: !noMedia, note: noMedia ? 'Нет носителя' : '',
  });
}
/* ---------------- Linux: накопители ---------------- */
const LSBLK_COLS = ['NAME', 'KNAME', 'PATH', 'TYPE', 'SIZE', 'MODEL', 'VENDOR', 'ROTA', 'TRAN', 'RM', 'HOTPLUG', 'RO', 'FSTYPE', 'LABEL'];
async function lsblk() {
  for (const mp of ['MOUNTPOINTS', 'MOUNTPOINT']) {
    try {
      const { stdout } = await run('lsblk', ['-J', '-b', '-o', [...LSBLK_COLS, mp].join(',')]);
      return JSON.parse(stdout).blockdevices || [];
    }
    catch {
    }
  }
  return null;
}
const mountsOf = n => [...new Set([...(arr(n.mountpoints)), n.mountpoint].filter(m => m && m !== '[SWAP]' && String(m).startsWith('/')))];
function diskTempLinux(kname) {
  const c = [], nv = /^(nvme\d+)n\d+/.exec(kname);
  if (nv)
    for (const base of [`/sys/class/nvme/${nv[1]}`, `/sys/class/nvme/${nv[1]}/device`])
      for (const h of readdir(base).filter(x => x.startsWith('hwmon')))
        c.push(`${base}/${h}/temp1_input`);
  if (nv)
    for (const h of readdir(`/sys/class/nvme/${nv[1]}/device/hwmon`))
      c.push(`/sys/class/nvme/${nv[1]}/device/hwmon/${h}/temp1_input`);
  for (const h of readdir(`/sys/block/${kname}/device/hwmon`))
    c.push(`/sys/block/${kname}/device/hwmon/${h}/temp1_input`);
  for (const f of c) {
    const t = readTemp(f);
    if (t != null)
      return t;
  }
  return null;
}
async function smartLinux(kname) {
  const bin = which('smartctl');
  if (!bin)
    return { status: 'unavailable', note: 'Не установлен smartmontools (smartctl)' };
  if (!/^[a-z0-9]+$/i.test(kname))
    return { status: 'unavailable', note: 'Недопустимое имя устройства' };
  let r;
  try {
    r = await run(bin, ['-j', '-H', '-A', '/dev/' + kname], { timeout: 12000 });
  }
  catch (e) {
    r = e;
  }
  let j;
  try {
    j = JSON.parse(r.stdout);
  }
  catch {
    return { status: 'unavailable', note: 'smartctl не вернул данных (нужны права root)' };
  }
  if (!j.smart_status)
    return { status: 'unavailable', note: (j.smartctl && j.smartctl.messages && j.smartctl.messages[0] && j.smartctl.messages[0].string) || 'SMART не поддерживается устройством или нужны права root' };
  return { status: j.smart_status.passed ? 'ok' : 'fail', note: 'SMART (smartctl)', temperature: num(j.temperature && j.temperature.current), powerOnHours: num(j.power_on_time && j.power_on_time.hours) };
}
function procMounts() {
  const t = readText('/proc/mounts') || '';
  return t.split('\n').map(l => l.split(' ')).filter(a => a.length >= 3).map(a => ({ src: a[0], mount: a[1].replace(/\\040/g, ' '), fs: a[2] }));
}
const NET_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs']);
async function scanLinux(prevSmart) {
  const errors = [], disks = [], others = [], seen = new Set(), pm = procMounts();
  const tree = await lsblk();
  const addPart = async (n, rm, ro) => {
    const out = [];
    for (const m of mountsOf(n)) {
      if (seen.has(m))
        continue;
      seen.add(m);
      let u = null, err = '';
      try {
        u = await withTimeout(statMount(m), 4000, null);
        if (!u)
          err = 'Нет ответа (диск «спит» или занят)';
      }
      catch (e) {
        err = e.code === 'EACCES' ? 'Нет доступа' : (e.code || e.message);
      }
      out.push(mkPartition({
        mount: m, label: n.label, fs: n.fstype || (pm.find(x => x.mount === m) || {}).fs || '', kind: rm ? 'removable' : 'fixed', system: m === '/' || m.startsWith('/boot'), readOnly: ro,
        size: u ? u.total : num(n.size), free: u ? u.free : null, used: u ? u.used : null, accessible: !!u, note: err,
      }));
    }
    return out;
  };
  const descend = async (n, rm, ro) => {
    let res = await addPart(n, rm, ro);
    for (const c of arr(n.children))
      res = res.concat(await descend(c, rm, ro));
    return res;
  };
  if (tree) {
    for (const n of tree) {
      if (n.type !== 'disk' || /^(loop|zram|ram|fd)\d*/.test(n.kname || n.name) || !num(n.size))
        continue;
      const rm = truthy(n.rm) || truthy(n.hotplug), ro = truthy(n.ro);
      const model = [n.vendor, n.model].filter(Boolean).map(s => String(s).trim()).filter(s => !/^0x[0-9a-f]+$/i.test(s)).join(' ').trim();
      const cls = classifyDisk({ kname: n.kname || n.name, bus: n.tran || '', rota: n.rota == null ? null : truthy(n.rota), model, removable: rm });
      const smart = prevSmart && prevSmart.get(n.kname) || null;
      disks.push({
        id: n.kname || n.name, name: model || ('Диск ' + (n.kname || n.name)), type: cls.type, typeNote: cls.note,
        bus: n.tran ? String(n.tran).toUpperCase() : null, size: num(n.size), removable: rm, status: 'ok', statusNote: ro ? 'Только чтение' : '',
        health: null, temperature: diskTempLinux(n.kname || n.name), powerOnHours: null,
        smart: smart || { status: 'unavailable', note: 'Проверка SMART ещё не выполнялась' }, partitions: await descend(n, rm, ro), _kname: n.kname || n.name,
      });
    }
  }
  else {
    errors.push('lsblk недоступен — физические диски не определены, показаны только смонтированные тома.');
    for (const m of procMounts().filter(x => x.src.startsWith('/dev/') && !/\/loop|\/ram|\/zram/.test(x.src) && !seen.has(x.mount))) {
      seen.add(m.mount);
      let u = null;
      try {
        u = await withTimeout(statMount(m.mount), 4000, null);
      }
      catch {
      }
      others.push(mkPartition({ mount: m.mount, fs: m.fs, system: m.mount === '/' || m.mount.startsWith('/boot'), size: u && u.total, free: u && u.free, accessible: !!u, note: u ? '' : 'Нет доступа' }));
    }
  }
  for (const m of procMounts().filter(x => NET_FS.has(x.fs) && !seen.has(x.mount))) { // сетевые тома
    seen.add(m.mount);
    let u = null;
    try {
      u = await withTimeout(statMount(m.mount), 4000, null);
    }
    catch {
    }
    others.push(mkPartition({ mount: m.mount, label: m.src, fs: m.fs, kind: 'network', size: u && u.total, free: u && u.free, accessible: !!u, note: u ? '' : 'Нет ответа' }));
  }
  return { disks, others, errors };
}
/* ---------------- CPU / RAM ---------------- */
function cpuInfoLinux() {
  const t = readText('/proc/cpuinfo') || '', blocks = t.split(/\n\s*\n/).filter(Boolean);
  const phys = new Set(), sockets = new Set();
  let cache = null;
  for (const b of blocks) {
    const pid = /physical id\s*:\s*(\d+)/.exec(b), cid = /core id\s*:\s*(\d+)/.exec(b), cs = /cache size\s*:\s*(.+)/.exec(b);
    if (pid)
      sockets.add(pid[1]);
    if (pid && cid)
      phys.add(pid[1] + ':' + cid[1]);
    if (cs && !cache)
      cache = cs[1].trim();
  }
  let max = null;
  for (const f of ['/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', '/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq']) {
    const v = num(readText(f));
    if (v) {
      max = Math.round(v / 1000);
      break;
    }
  }
  return { physicalCores: phys.size || null, sockets: sockets.size || null, cache, maxMHz: max };
}
function cpuTempLinux() {
  for (const h of readdir('/sys/class/hwmon')) {
    const dir = '/sys/class/hwmon/' + h, name = (readText(dir + '/name') || '').trim();
    if (!/^(coretemp|k10temp|zenpower|cpu_thermal|acpitz)$/.test(name))
      continue;
    let best = null;
    for (const f of readdir(dir).filter(x => /^temp\d+_input$/.test(x))) {
      const label = (readText(dir + '/' + f.replace('_input', '_label')) || '').trim(), t = readTemp(dir + '/' + f);
      if (t == null)
        continue;
      if (/package|tctl|tdie/i.test(label))
        return t;
      if (best == null)
        best = t;
    }
    if (best != null)
      return best;
  }
  return null;
}
function ramLive() {
  let total = os.totalmem(), avail = os.freemem(), swapT = null, swapF = null;
  if (lin) {
    const m = readText('/proc/meminfo') || '', g = k => {
      const r = new RegExp('^' + k + ':\\s+(\\d+) kB', 'm').exec(m);
      return r ? Number(r[1]) * 1024 : null;
    };
    total = g('MemTotal') || total;
    avail = g('MemAvailable') ?? avail;
    swapT = g('SwapTotal');
    swapF = g('SwapFree');
  }
  const used = Math.max(0, total - avail);
  return { total, used, free: avail, percent: total ? Math.round((used / total) * 1000) / 10 : null, swapTotal: swapT, swapUsed: swapT != null && swapF != null ? swapT - swapF : null };
}
/* ---------------- GPU ---------------- */
function parseNvidiaCsv(text) {
  const na = v => {
    const s = String(v).trim();
    return /^\[?(n\/a|not supported|unknown error|\[n\/a\])\]?$/i.test(s) || s === '' ? null : s;
  };
  return String(text).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const p = l.split(/\s*,\s*/);
    return { index: Number(p[0]), name: na(p[1]), vramTotal: num(na(p[2])) != null ? num(p[2]) * 1048576 : null, vramUsed: num(na(p[3])) != null ? num(p[3]) * 1048576 : null, load: num(na(p[4])), temp: num(na(p[5])), driver: na(p[6]) };
  }).filter(x => Number.isFinite(x.index));
}
function nvidiaBin() {
  const c = [which('nvidia-smi')];
  if (win)
    c.push('C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe');
  return c.find(f => f && fs.existsSync(f)) || null;
}
const VENDORS = { '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x8086': 'Intel', '0x1af4': 'Virtio', '0x15ad': 'VMware' };
// Linux: видеоадаптеры по /sys/class/drm
function drmCards() {
  const res = [];
  for (const c of readdir('/sys/class/drm').filter(x => /^card\d+$/.test(x))) {
    const dev = `/sys/class/drm/${c}/device`, v = (readText(dev + '/vendor') || '').trim().toLowerCase();
    if (!v)
      continue;
    res.push({ card: c, dev, vendorId: v, vendor: VENDORS[v] || ('Вендор ' + v) });
  }
  return res;
}
const VIRTUAL_GPU = /remote display|virtual display|meta virtual|parsec|spacedesk|indirect|hyper-v video|basic render/i;
/* ---------------- фабрика ---------------- */
module.exports = function createHardware() {
  const cache = { info: null, infoT: 0, disks: null, disksT: 0, smart: new Map(), smartT: 0, nv: { t: 0, v: null, miss: 0 }, scanning: null };
  let cpuPrev = os.cpus(), cpuLast = null, cpuLastT = 0;
  function cpuLoad() {
    const t = Date.now();
    if (cpuLast && t - cpuLastT < 500)
      return cpuLast;
    const now = os.cpus();
    const cores = now.map((c, i) => {
      const p = cpuPrev[i] || c;
      let tot = 0;
      for (const k in c.times)
        tot += c.times[k] - p.times[k];
      const idle = c.times.idle - p.times.idle;
      return tot > 0 ? Math.min(100, Math.max(0, (1 - idle / tot) * 100)) : 0;
    });
    cpuPrev = now;
    cpuLastT = t;
    cpuLast = { load: cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : null, cores };
    return cpuLast;
  }
  function cpuFreq() {
    if (lin) {
      const f = readdir('/sys/devices/system/cpu').filter(x => /^cpu\d+$/.test(x)).map(x => num(readText(`/sys/devices/system/cpu/${x}/cpufreq/scaling_cur_freq`))).filter(v => v);
      if (f.length)
        return { mhz: Math.round(f.reduce((a, b) => a + b, 0) / f.length / 1000), note: 'Текущая средняя частота' };
      const m = (readText('/proc/cpuinfo') || '').match(/cpu MHz\s*:\s*([\d.]+)/g);
      if (m) {
        const v = m.map(x => parseFloat(x.split(':')[1]));
        return { mhz: Math.round(v.reduce((a, b) => a + b, 0) / v.length), note: 'Текущая средняя частота' };
      }
    }
    const c = os.cpus()[0];
    return c && c.speed ? { mhz: c.speed, note: 'Номинальная частота по данным ОС (текущая недоступна)' } : { mhz: null, note: '' };
  }
  async function nvidiaLive() {
    const t = Date.now();
    if (cache.nv.v && t - cache.nv.t < 2000)
      return cache.nv.v;
    if (cache.nv.miss && t - cache.nv.miss < 60000)
      return [];
    const bin = nvidiaBin();
    if (!bin) {
      cache.nv.miss = t;
      return [];
    }
    try {
      const { stdout } = await run(bin, ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,driver_version', '--format=csv,noheader,nounits'], { timeout: 5000 });
      cache.nv = { t, v: parseNvidiaCsv(stdout), miss: 0 };
      return cache.nv.v;
    }
    catch {
      cache.nv.miss = t;
      return [];
    }
  }
  async function gpuStatic() {
    const list = [], nv = await nvidiaLive(), notes = [];
    for (const g of nv)
      list.push({ id: 'nvidia:' + g.index, name: g.name, vendor: 'NVIDIA', vramTotal: g.vramTotal, driver: g.driver, virtual: false, live: { load: true, temp: true, vram: true }, source: 'nvidia-smi' });
    if (win) {
      try {
        const d = await psJson(String.raw `
$v=@(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{Name=[string]$_.Name;Ram=[int64]$_.AdapterRAM;Driver=[string]$_.DriverVersion;Status=[string]$_.Status} })
$k='HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$m=@(Get-ChildItem $k | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.DriverDesc){ $q=$p.'HardwareInformation.qwMemorySize'; if($q -is [byte[]]){$q=[BitConverter]::ToUInt64($q,0)}; [pscustomobject]@{Name=[string]$p.DriverDesc;Mem=[double]$q} } })
[pscustomobject]@{v=$v;m=$m} | ConvertTo-Json -Depth 4 -Compress`);
        const mem = new Map(arr(d.m).filter(x => x.Mem > 0).map(x => [x.Name, x.Mem]));
        arr(d.v).forEach((g, i) => {
          if (nv.length && /nvidia/i.test(g.Name))
            return; // уже есть из nvidia-smi
          const ram = num(g.Ram);
          let vram = mem.get(g.Name) || null;
          if (!vram && ram && ram < 4000000000)
            vram = ram; // у AdapterRAM потолок 4 ГБ — большие значения не доверяем
          list.push({ id: 'win:' + i, name: g.Name, vendor: /nvidia/i.test(g.Name) ? 'NVIDIA' : /amd|radeon/i.test(g.Name) ? 'AMD' : /intel/i.test(g.Name) ? 'Intel' : null, vramTotal: vram, driver: g.Driver || null, virtual: VIRTUAL_GPU.test(g.Name), live: { load: false, temp: false, vram: false }, source: 'Windows CIM' });
        });
        notes.push('Загрузка и температура GPU в Windows доступны только для видеокарт NVIDIA (через nvidia-smi).');
      }
      catch (e) {
        notes.push('Не удалось получить список видеоадаптеров Windows: ' + e.message);
      }
    }
    else if (lin) {
      const cards = drmCards();
      let names = {};
      const lspci = which('lspci');
      if (lspci) {
        try {
          const { stdout } = await run(lspci, ['-mm']);
          stdout.split('\n').filter(l => /"(VGA compatible controller|3D controller|Display controller)"/.test(l)).forEach(l => {
            const q = l.match(/"([^"]*)"/g) || [];
            if (q.length >= 4)
              names[l.split(' ')[0]] = (q[2] + ' ' + q[3]).replace(/"/g, '');
          });
        }
        catch {
        }
      }
      for (const c of cards) {
        if (c.vendorId === '0x10de' && nv.length)
          continue;
        const slot = (fs.realpathSync(c.dev).split('/').pop() || '').replace(/^0000:/, '');
        const nm = names[slot] || null, amd = c.vendorId === '0x1002';
        const vt = num(readText(c.dev + '/mem_info_vram_total'));
        list.push({ id: 'drm:' + c.card, name: nm || `Видеоадаптер ${c.vendor} (модель не определена)`, vendor: c.vendor, vramTotal: amd ? vt : null, driver: null, virtual: /virtio|vmware/i.test(c.vendor), live: { load: amd && readText(c.dev + '/gpu_busy_percent') != null, temp: amd, vram: amd && vt != null }, source: nm ? 'lspci/sysfs' : 'sysfs' });
      }
      notes.push('В Linux загрузка GPU доступна для NVIDIA (nvidia-smi) и AMD (amdgpu); для Intel — только название.');
    }
    else
      notes.push('Сведения о GPU для этой ОС не поддерживаются.');
    return { list, notes };
  }
  async function info(force = false) {
    if (!force && cache.info && Date.now() - cache.infoT < 300000)
      return cache.info;
    const cpus = os.cpus(), c = { model: cpus[0] ? cpus[0].model.trim() : null, logicalCores: cpus.length || null, physicalCores: null, sockets: null, baseMHz: cpus[0] ? cpus[0].speed || null : null, maxMHz: null, cache: null, vendor: null };
    const notes = [];
    if (lin) {
      Object.assign(c, cpuInfoLinux());
      const v = /vendor_id\s*:\s*(.+)/.exec(readText('/proc/cpuinfo') || '');
      c.vendor = v ? v[1].trim() : null;
    }
    else if (win) {
      try {
        const p = arr(await psJson("@(Get-CimInstance Win32_Processor | ForEach-Object { [pscustomobject]@{Name=[string]$_.Name;Cores=[int]$_.NumberOfCores;Threads=[int]$_.NumberOfLogicalProcessors;Max=[int]$_.MaxClockSpeed;Vendor=[string]$_.Manufacturer;L3=[int]$_.L3CacheSize} }) | ConvertTo-Json -Compress"));
        if (p.length) {
          c.model = (p[0].Name || c.model || '').trim();
          c.physicalCores = p.reduce((a, x) => a + (x.Cores || 0), 0) || null;
          c.logicalCores = p.reduce((a, x) => a + (x.Threads || 0), 0) || c.logicalCores;
          c.sockets = p.length;
          c.baseMHz = p[0].Max || c.baseMHz;
          c.maxMHz = p[0].Max || null;
          c.vendor = p[0].Vendor || null;
          c.cache = p[0].L3 ? Math.round(p[0].L3 / 1024) + ' МБ (L3)' : null;
        }
      }
      catch (e) {
        notes.push('Подробности о процессоре Windows недоступны: ' + e.message);
      }
    }
    const g = await gpuStatic();
    cache.info = {
      platform: process.platform, arch: os.arch(), hostname: os.hostname(), os: `${os.type()} ${os.release()}`, uptime: os.uptime(),
      cpu: c, gpus: g.list, ram: { total: os.totalmem() }, notes: [...notes, ...g.notes],
    };
    cache.infoT = Date.now();
    return cache.info;
  }
  async function gpuLive() {
    const inf = await info(), nv = await nvidiaLive(), out = [];
    for (const g of inf.gpus) {
      const o = { id: g.id, load: null, temp: null, vramUsed: null, vramTotal: g.vramTotal };
      if (g.id.startsWith('nvidia:')) {
        const x = nv.find(n => 'nvidia:' + n.index === g.id);
        if (x) {
          o.load = x.load;
          o.temp = x.temp;
          o.vramUsed = x.vramUsed;
          o.vramTotal = x.vramTotal ?? o.vramTotal;
        }
      }
      else if (g.id.startsWith('drm:') && lin) {
        const dev = `/sys/class/drm/${g.id.slice(4)}/device`;
        o.load = num(readText(dev + '/gpu_busy_percent'));
        o.vramUsed = num(readText(dev + '/mem_info_vram_used'));
        for (const h of readdir(dev + '/hwmon')) {
          const t = readTemp(`${dev}/hwmon/${h}/temp1_input`);
          if (t != null) {
            o.temp = t;
            break;
          }
        }
      }
      out.push(o);
    }
    return out;
  }
  async function live({ gpu = true } = {}) {
    const c = cpuLoad(), f = cpuFreq();
    return { time: Date.now(), cpu: { load: c.load, cores: c.cores, mhz: f.mhz, mhzNote: f.note, temp: lin ? cpuTempLinux() : null, loadAvg: win ? null : os.loadavg() }, ram: ramLive(), gpus: gpu ? await gpuLive() : undefined };
  }
  /* --- диски --- */
  async function scanDisks(force) {
    const t = Date.now();
    if (!force && cache.disks && t - cache.disksT < 60000)
      return cache.disks;
    if (cache.scanning)
      return cache.scanning;
    cache.scanning = (async () => {
      let res;
      try {
        if (win) {
          const d = await psJson(WIN_DISK_PS, 40000), b = buildWindowsDisks(d);
          res = { ...b, errors: [] };
        }
        else if (lin) {
          const wantSmart = force || Date.now() - cache.smartT > 300000;
          res = await scanLinux(cache.smart);
          if (wantSmart) { // SMART — не чаще раза в 5 минут (команда медленная)
            for (const d of res.disks)
              d.smart = await smartLinux(d._kname);
            for (const d of res.disks) {
              cache.smart.set(d._kname, d.smart);
              if (d.smart.temperature != null && d.temperature == null)
                d.temperature = d.smart.temperature;
              if (d.smart.powerOnHours != null)
                d.powerOnHours = d.smart.powerOnHours;
            }
            cache.smartT = Date.now();
          }
          for (const d of res.disks) {
            if (d.smart && d.smart.status !== 'unavailable')
              d.health = d.smart.status === 'ok' ? 'Исправен' : d.smart.status === 'warn' ? 'Предупреждение' : 'Неисправен';
            delete d._kname;
          }
        }
        else {
          const root = path.parse(process.cwd()).root, u = await statMount(root).catch(() => null);
          res = { disks: [], others: [mkPartition({ mount: root, size: u && u.total, free: u && u.free, used: u && u.used, accessible: !!u })], errors: ['Определение физических дисков для этой ОС не поддерживается.'] };
        }
      }
      catch (e) {
        res = { disks: [], others: [], errors: ['Не удалось получить список дисков: ' + e.message] };
        if (cache.disks && cache.disks.disks.length)
          res = { ...cache.disks, errors: [...res.errors, 'Показаны данные предыдущего сканирования.'] };
      }
      res.scannedAt = Date.now();
      cache.disks = res;
      cache.disksT = res.scannedAt;
      return res;
    })();
    try {
      return await cache.scanning;
    }
    finally {
      cache.scanning = null;
    }
  }
  // обновляет только занятое/свободное место, без повторного сканирования
  async function refreshSpace(res) {
    const all = [...res.disks.flatMap(d => d.partitions), ...res.others];
    await Promise.all(all.filter(p => p.accessible && p.kind !== 'optical').map(async (p) => {
      try {
        const u = await withTimeout(statMount(p.mount), 3000, null);
        if (u) {
          p.size = u.total;
          p.free = u.free;
          p.used = u.used;
          p.percent = u.total ? Math.round(((u.total - u.free) / u.total) * 1000) / 10 : null;
        }
      }
      catch {
      }
    }));
    res.spaceAt = Date.now();
    return res;
  }
  async function disks({ force = false, spaceOnly = false } = {}) {
    if (spaceOnly && cache.disks)
      return refreshSpace(cache.disks);
    return scanDisks(force);
  }
  // Разрешённые корни для файлового менеджера: только обнаруженные тома
  function mountList() {
    const d = cache.disks;
    if (!d)
      return [];
    return [...d.disks.flatMap(x => x.partitions), ...d.others].filter(p => p.accessible && p.kind !== 'optical' && p.kind !== 'other');
  }
  const norm = m => win ? String(m).toUpperCase().replace(/[\\/]+$/, '') + '\\' : String(m).replace(/\/+$/, '') || '/';
  // Синхронно (используется в файловых операциях). Неизвестный том — только если он реально есть в системе.
  function mountRoot(id) {
    if (typeof id !== 'string' || !id || id.includes('\0'))
      return null;
    const want = norm(id), hit = mountList().find(p => norm(p.mount) === want);
    if (hit)
      return hit.mount;
    try {
      if (win) {
        if (/^[A-Za-z]:\\$/.test(want) && fs.statSync(want).isDirectory()) {
          cache.disksT = 0;
          return want;
        }
      }
      else if (lin) {
        const m = procMounts().find(x => norm(x.mount) === want && (x.src.startsWith('/dev/') || NET_FS.has(x.fs)) && !/\/loop/.test(x.src));
        if (m) {
          cache.disksT = 0;
          return m.mount;
        }
      }
    }
    catch {
    }
    return null;
  }
  // Пути, в которые нельзя заходить ни при каких условиях (виртуальные ФС Linux)
  function blocked(real) {
    if (!lin)
      return false;
    return ['/proc', '/sys', '/dev'].some(b => real === b || real.startsWith(b + '/'));
  }
  return { info, live, disks, mountRoot, mountList, blocked, _t: { classifyDisk, buildWindowsDisks, parseNvidiaCsv, scanLinux } };
};
