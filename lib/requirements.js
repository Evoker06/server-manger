'use strict';
// Проверка проекта перед запуском: нет ли чего-то недостающего (Java, JAR-файл, node_modules...)
// и не вышло ли обновление для файлов, которые панель умеет скачивать (Paper, Vanilla, Java).
// Проверка вызывается ТОЛЬКО при запуске проекта. Сетевые запросы — с короткими таймаутами:
// если интернета нет, проверка обновлений молча пропускается и запуск не блокируется.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');
// Скачивать разрешено только с этих доменов (и только по https)
const HOSTS = ['api.adoptium.net', 'github.com', 'githubusercontent.com', 'api.papermc.io', 'fill.papermc.io',
  'fill-data.papermc.io', 'piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com'];
const hostOk = h => HOSTS.some(x => h === x || h.endsWith('.' + x));
const UA = { 'user-agent': 'ServerManager/1.6 (+requirements-check)' };
const execP = (f, a, o) => new Promise((res, rej) => execFile(f, a, o, (e, so, se) => e ? rej(Object.assign(e, { stdout: so, stderr: se })) : res({ stdout: so, stderr: se })));
const win = process.platform === 'win32';
const tokens = s => (String(s || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d)
      return d;
  }
  return 0;
};
module.exports = function ({ ROOT, db }) {
  const RT_DIR = path.join(ROOT, 'runtimes');
  const mem = new Map();
  async function cached(key, ttl, fn) {
    const c = mem.get(key);
    if (c && Date.now() - c.t < c.ttl) {
      if (c.err)
        throw c.err;
      return c.v;
    }
    try {
      const v = await fn();
      mem.set(key, { t: Date.now(), ttl, v });
      return v;
    }
    catch (err) {
      mem.set(key, { t: Date.now(), ttl: 120000, err });
      throw err;
    }
  }
  /* ---------- сеть ---------- */
  function assertUrl(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !hostOk(u.hostname))
      throw Error('Недоверенный адрес загрузки: ' + u.hostname);
    return u;
  }
  async function getJson(url, ms = 5000) {
    assertUrl(url);
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
    if (!r.ok)
      throw Error('HTTP ' + r.status + ' ' + new URL(url).hostname);
    return r.json();
  }
  async function download(url, dest, { sha256, sha1, onProgress } = {}) {
    assertUrl(url);
    const ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) {
      clearTimeout(idle);
      throw Error('Загрузка не удалась: HTTP ' + r.status);
    }
    const fin = new URL(r.url);
    if (fin.protocol !== 'https:' || !hostOk(fin.hostname)) {
      clearTimeout(idle);
      ctl.abort();
      throw Error('Перенаправление на недоверенный адрес: ' + fin.hostname);
    }
    const total = +r.headers.get('content-length') || 0;
    let got = 0;
    const h256 = crypto.createHash('sha256'), h1 = crypto.createHash('sha1');
    const tap = new Transform({ transform(chunk, _e, cb) {
        got += chunk.length;
        h256.update(chunk);
        h1.update(chunk);
        clearTimeout(idle);
        idle = setTimeout(() => ctl.abort(), 30000);
        if (onProgress && total)
          onProgress(got / total);
        cb(null, chunk);
      } });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    try {
      await pipeline(Readable.fromWeb(r.body), tap, fs.createWriteStream(part));
      clearTimeout(idle);
      if (sha256 && h256.digest('hex').toLowerCase() !== String(sha256).toLowerCase())
        throw Error('Контрольная сумма SHA-256 не совпала — файл повреждён');
      if (sha1 && h1.digest('hex').toLowerCase() !== String(sha1).toLowerCase())
        throw Error('Контрольная сумма SHA-1 не совпала — файл повреждён');
      fs.renameSync(part, dest);
    }
    catch (e) {
      clearTimeout(idle);
      try {
        fs.rmSync(part, { force: true });
      }
      catch {
      }
      throw e;
    }
  }
  /* ---------- источники (всё берётся с официальных API) ---------- */
  const archOf = () => ({ x64: 'x64', arm64: 'aarch64', arm: 'arm' }[os.arch()] || 'x64');
  const osOf = () => ({ win32: 'windows', linux: 'linux', darwin: 'mac' }[process.platform] || 'linux');
  async function adoptium(major) {
    major = +major;
    if (!Number.isInteger(major) || major < 8 || major > 99)
      throw Error('Некорректная версия Java');
    return cached('adopt' + major, 600000, async () => {
      const j = await getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${archOf()}&image_type=jdk&os=${osOf()}&vendor=eclipse`, 8000);
      const x = Array.isArray(j) && j[0];
      const p = x && x.binary && x.binary.package;
      if (!p)
        throw Error('Для Java ' + major + ' нет сборки под эту систему');
      return { release: x.release_name, name: p.name, link: p.link, sha256: p.checksum, size: p.size };
    });
  }
  async function paperBuilds(project, version) {
    return cached(`paper:${project}:${version}`, 600000, async () => {
      try { // Fill v3
        const j = await getJson(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds`);
        const list = (Array.isArray(j) ? j : j.builds || []).map(b => {
          const d = b.downloads && (b.downloads['server:default'] || Object.values(b.downloads)[0]);
          return d && { build: b.id || b.build, channel: String(b.channel || '').toUpperCase(), name: d.name, url: d.url, sha256: d.checksums && d.checksums.sha256 };
        }).filter(Boolean);
        if (list.length)
          return list;
      }
      catch {
      }
      const j = await getJson(`https://api.papermc.io/v2/projects/${project}/versions/${version}/builds`); // старый API v2
      return (j.builds || []).map(b => {
        const d = b.downloads && b.downloads.application;
        return d && { build: b.build, channel: String(b.channel || 'default').toUpperCase(), name: d.name, sha256: d.sha256, url: `https://api.papermc.io/v2/projects/${project}/versions/${version}/builds/${b.build}/downloads/${d.name}` };
      }).filter(Boolean);
    });
  }
  async function paperLatest(project, version) {
    const l = await paperBuilds(project, version);
    const stable = l.filter(b => b.channel === 'STABLE' || b.channel === 'DEFAULT');
    const pool = stable.length ? stable : l;
    if (!pool.length)
      throw Error('Сборки не найдены');
    return pool.reduce((a, b) => +b.build > +a.build ? b : a);
  }
  async function paperVersions(project) {
    return cached('pv:' + project, 600000, async () => {
      let v;
      try {
        const j = await getJson(`https://fill.papermc.io/v3/projects/${project}`);
        v = j.versions;
      }
      catch {
        const j = await getJson(`https://api.papermc.io/v2/projects/${project}`);
        v = j.versions;
      }
      if (v && !Array.isArray(v))
        v = Object.values(v).flat();
      return (v || []).filter(x => /^\d+(\.\d+){1,2}$/.test(x)).sort((a, b) => cmpVer(b, a));
    });
  }
  const manifest = () => cached('mojang', 600000, () => getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 6000));
  async function vanillaVersions() {
    const m = await manifest();
    return m.versions.filter(v => v.type === 'release').map(v => v.id);
  }
  async function vanillaLatest() {
    return (await manifest()).latest.release;
  }
  async function vanillaDownload(id) {
    const m = await manifest();
    const v = m.versions.find(x => x.id === id);
    if (!v)
      throw Error('Версия не найдена: ' + id);
    const j = await getJson(v.url, 8000);
    const d = j.downloads && j.downloads.server;
    if (!d)
      throw Error('Для этой версии нет серверного JAR');
    return { url: d.url, sha1: d.sha1, name: 'server.jar', java: j.javaVersion && j.javaVersion.majorVersion };
  }
  async function versions(vendor) {
    if (vendor === 'vanilla')
      return vanillaVersions();
    if (vendor === 'paper' || vendor === 'folia')
      return paperVersions(vendor);
    throw Error('Неизвестный источник');
  }
  /* ---------- локальные проверки ---------- */
  function findBin(name, a) {
    const names = win ? [name + '.exe', name + '.cmd', name + '.bat'] : [name];
    const dirs = [];
    if (a.runtime_path) {
      try {
        const st = fs.statSync(a.runtime_path);
        const d = st.isDirectory() ? a.runtime_path : path.dirname(a.runtime_path);
        dirs.push(d, path.join(d, 'bin'));
      }
      catch {
      }
    }
    dirs.push(...String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean));
    for (const d of dirs)
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
  async function javaMajor(bin) {
    return cached('jv:' + bin, 600000, async () => {
      let out;
      try {
        const r = await execP(bin, ['-version'], { timeout: 10000, windowsHide: true });
        out = r.stderr + r.stdout;
      }
      catch (e) {
        out = (e.stderr || '') + (e.stdout || '');
      }
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (!m)
        return null;
      return m[1] === '1' ? +m[2] : +m[1];
    });
  }
  // какая Java нужна версии Minecraft 1.x
  function mcJava(v) {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v || '');
    if (!m || m[1] !== '1')
      return null;
    const mi = +m[2], pa = +(m[3] || 0);
    if (mi > 20 || (mi === 20 && pa >= 5))
      return 21;
    if (mi >= 17)
      return 17;
    return 8;
  }
  // version.json есть внутри vanilla server.jar
  async function jarInfo(file) {
    try {
      const d = await unzipper.Open.file(file);
      const e = d.files.find(f => f.path === 'version.json');
      if (!e)
        return null;
      const j = JSON.parse((await e.buffer()).toString('utf8'));
      return { id: j.id || j.name, java: j.java_version || (j.javaVersion && j.javaVersion.majorVersion) || null };
    }
    catch {
      return null;
    }
  }
  const PAPER_RE = /^(paper|folia)-(\d+(?:\.\d+){1,2})-(\d+)\.jar$/i;
  const SERVERJAR_RE = /(paper|folia|spigot|purpur|server|minecraft)/i;
  /** Проверка проекта. Возвращает {issues:[{id,level,title,message,fix}]} level: error | warn | update */
  // обновление сборки Paper
  async function check(a, { network = true } = {}) {
    const issues = [], push = i => {
      if (!issues.some(x => x.id === i.id))
        issues.push(i);
    };
    const wd = path.resolve(a.working_dir);
    if (!fs.existsSync(wd))
      return { issues };
    const segs = String(a.command || '').split(/&&|\|\||;/).map(tokens).filter(t => t.length);
    const seenRt = new Set();
    let needJava = null;
    const net = [];
    if (a.runtime_path && !fs.existsSync(a.runtime_path))
      push({ id: 'rt-path', level: 'error', title: 'Указанный Runtime не найден', message: a.runtime_path, fix: /java/i.test(a.runtime || a.command) ? { kind: 'runtime', label: 'Скачать Java', params: { key: 'java', major: 21 } } : null });
    for (const t of segs) {
      const exe = path.basename(t[0]).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
      if (exe === 'java') {
        const ji = t.findIndex(x => x.toLowerCase() === '-jar');
        const jarArg = ji >= 0 ? t[ji + 1] : null;
        let jarFile = jarArg ? path.resolve(wd, jarArg) : null, jarExists = jarFile && fs.existsSync(jarFile);
        let req = null;
        if (jarArg && jarExists) {
          const base = path.basename(jarFile), pm = PAPER_RE.exec(base);
          if (pm) {
            req = mcJava(pm[2]);
            if (network)
              net.push(async () => {
                const l = await paperLatest(pm[1].toLowerCase(), pm[2]);
                if (+l.build > +pm[3])
                  push({ id: `upd:${pm[1].toLowerCase()}-${pm[2]}-${l.build}`, level: 'update', title: `Обновление ${pm[1][0].toUpperCase() + pm[1].slice(1).toLowerCase()}`, message: `Для Minecraft ${pm[2]} вышла сборка #${l.build} (у вас #${pm[3]}). Обновление в пределах той же версии игры безопасно для мира.`, fix: { kind: 'jar-update', label: 'Обновить', params: { project: pm[1].toLowerCase(), jar: path.relative(wd, jarFile).split(path.sep).join('/') } } });
              });
          }
          else {
            const info = await jarInfo(jarFile);
            if (info) {
              req = info.java || mcJava(info.id);
              if (network && /^\d+\.\d+(\.\d+)?$/.test(info.id || ''))
                net.push(async () => {
                  const latest = await vanillaLatest();
                  if (cmpVer(latest, info.id) > 0)
                    push({ id: `upd:vanilla-${latest}`, level: 'update', title: 'Новая версия Minecraft', message: `Вышла версия ${latest} (у вас ${info.id}). После обновления мир нельзя откатить на старую версию — перед заменой панель создаст backup.`, fix: { kind: 'jar-update', label: 'Backup и обновить', params: { project: 'vanilla', jar: path.relative(wd, jarFile).split(path.sep).join('/') } } });
                });
            }
          }
        }
        else if (jarArg && !jarExists) {
          const rel = path.relative(wd, jarFile).split(path.sep).join('/'), base = path.basename(jarFile);
          const pm = PAPER_RE.exec(base);
          push({ id: 'file:' + rel, level: 'error', title: `Не найден файл ${rel}`, message: 'Команда запуска ссылается на этот JAR, но его нет в папке проекта. Положите файл во вкладке «Файлы» или скачайте его.',
            fix: SERVERJAR_RE.test(base) && /\.jar$/i.test(base) ? { kind: 'server-jar', label: 'Скачать серверный JAR…', params: { filename: base, vendor: pm ? pm[1].toLowerCase() : 'paper', version: pm ? pm[2] : '' } } : null });
        }
        if (req)
          needJava = Math.max(needJava || 0, req);
        if (!seenRt.has('java')) {
          seenRt.add('java');
          const bin = findBin('java', a);
          if (!bin)
            push({ id: 'rt-java', level: 'error', title: 'Java не найдена', message: 'Для запуска нужна Java, но её нет ни в PATH, ни в выбранном Runtime.', fix: { kind: 'runtime', label: `Скачать Java ${needJava || 21}`, params: { key: 'java', major: needJava || 21 } } });
          else if (needJava) {
            const m = await javaMajor(bin);
            if (m && m < needJava)
              push({ id: 'rt-java-old', level: 'error', title: `Нужна Java ${needJava}, найдена Java ${m}`, message: 'Эта версия сервера не запустится на старой Java.', fix: { kind: 'runtime', label: `Скачать Java ${needJava}`, params: { key: 'java', major: needJava } } });
          }
        }
      }
      else if (['node', 'npm', 'npx', 'yarn', 'pnpm'].includes(exe)) {
        if (!seenRt.has('node')) {
          seenRt.add('node');
          if (!findBin(exe === 'node' ? 'node' : exe, a))
            push({ id: 'rt-node', level: 'error', title: exe === 'node' ? 'Node.js не найден' : `${exe} не найден`, message: 'Команда запуска использует Node.js, но он недоступен в PATH процесса панели.', fix: { kind: 'use-panel-node', label: 'Использовать Node.js панели', params: {} } });
          try {
            const pj = JSON.parse(fs.readFileSync(path.join(wd, 'package.json'), 'utf8'));
            const deps = Object.keys(pj.dependencies || {}).length + Object.keys(pj.devDependencies || {}).length;
            if (deps && !fs.existsSync(path.join(wd, 'node_modules')))
              push({ id: 'npm-deps', level: 'error', title: 'Не установлены зависимости (node_modules)', message: 'В package.json есть зависимости, а папки node_modules нет. Нужно выполнить npm install.', fix: { kind: 'npm', label: 'Выполнить npm install', params: {} } });
          }
          catch {
          }
        }
      }
      else if (['python', 'python3', 'py'].includes(exe)) {
        if (!seenRt.has('python')) {
          seenRt.add('python');
          if (!findBin(exe, a))
            push({ id: 'rt-python', level: 'error', title: 'Python не найден', message: `Команда «${exe}» не найдена. В Linux часто нужна команда python3.`, fix: { kind: 'link', label: 'Открыть python.org', params: { url: 'https://www.python.org/downloads/' } } });
        }
      }
      else if (exe === 'dotnet') {
        if (!seenRt.has('dotnet')) {
          seenRt.add('dotnet');
          if (!findBin('dotnet', a))
            push({ id: 'rt-dotnet', level: 'error', title: '.NET не найден', message: 'Команда dotnet недоступна.', fix: { kind: 'link', label: 'Скачать .NET', params: { url: 'https://dotnet.microsoft.com/download' } } });
        }
      }
      else if (exe === 'docker') {
        if (!seenRt.has('docker')) {
          seenRt.add('docker');
          if (!findBin('docker', a))
            push({ id: 'rt-docker', level: 'error', title: 'Docker не найден', message: 'Команда docker недоступна.', fix: { kind: 'link', label: 'Инструкция по установке', params: { url: 'https://docs.docker.com/get-docker/' } } });
        }
      }
      else {
        // скрипт или исполняемый файл
        const sh = ['sh', 'bash'].includes(exe), target = sh ? t[1] : t[0];
        if (target && /\.(bat|cmd|sh|exe)$/i.test(target)) {
          const f = path.resolve(wd, target), rel = path.relative(wd, f).split(path.sep).join('/');
          if (!win && /\.(bat|cmd|exe)$/i.test(target))
            push({ id: 'plat:' + rel, level: 'error', title: `${path.basename(target)} — файл для Windows`, message: 'Сервер работает в Linux/macOS: замените команду запуска на start.sh или java -jar … (вкладка «Настройки»).', fix: null });
          else if (win && /\.sh$/i.test(target))
            push({ id: 'plat:' + rel, level: 'warn', title: `${path.basename(target)} — shell-скрипт`, message: 'В Windows .sh-скрипты обычно не запускаются.', fix: null });
          else if (!fs.existsSync(f))
            push({ id: 'file:' + rel, level: 'error', title: `Не найден файл ${rel}`, message: 'Команда запуска ссылается на этот файл, но его нет в папке проекта. Загрузите его во вкладке «Файлы».', fix: null });
        }
      }
    }
    // обновление Java, установленной самой панелью
    if (network && a.runtime_path && path.resolve(a.runtime_path).startsWith(RT_DIR + path.sep)) {
      const top = path.join(RT_DIR, path.relative(RT_DIR, path.resolve(a.runtime_path)).split(path.sep)[0]);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(top, '.sm-meta.json'), 'utf8'));
        net.push(async () => {
          const l = await adoptium(meta.major);
          if (l.release !== meta.release)
            push({ id: `upd:java-${meta.major}-${l.release}`, level: 'update', title: `Обновление Java ${meta.major}`, message: `Вышла сборка ${l.release} (установлена ${meta.release}).`, fix: { kind: 'runtime', label: 'Обновить Java', params: { key: 'java', major: meta.major } } });
        });
      }
      catch {
      }
    }
    await Promise.all(net.map(f => f().catch(() => {
    }))); // сеть недоступна — молча пропускаем
    const order = { error: 0, warn: 1, update: 2 };
    issues.sort((x, y) => order[x.level] - order[y.level]);
    return { issues };
  }
  /* ---------- исправления (только администратор) ---------- */
  async function extract(archive, dest) {
    fs.mkdirSync(dest, { recursive: true });
    if (/\.zip$/i.test(archive)) {
      const d = await unzipper.Open.file(archive), base = path.resolve(dest);
      for (const e of d.files) {
        const t = path.resolve(base, e.path);
        if (t !== base && !t.startsWith(base + path.sep))
          throw Error('Небезопасный путь в архиве');
        if (e.type === 'Directory') {
          fs.mkdirSync(t, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(t), { recursive: true });
        await pipeline(e.stream(), fs.createWriteStream(t));
      }
    }
    else
      await execP('tar', ['-xzf', archive, '-C', dest], { timeout: 600000 });
  }
  function findJavaBin(dir, depth = 0) {
    const exe = win ? 'java.exe' : 'java';
    if (fs.existsSync(path.join(dir, 'bin', exe)))
      return path.join(dir, 'bin');
    if (depth > 4)
      return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) {
        const r = findJavaBin(path.join(dir, e.name), depth + 1);
        if (r)
          return r;
      }
    return null;
  }
  const safeName = s => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
  // старую версию не удаляем, а откладываем
  const moveOld = (wd, file) => {
    const od = path.join(wd, '.sm-old');
    fs.mkdirSync(od, { recursive: true });
    fs.renameSync(file, path.join(od, `${path.basename(file)}.${Date.now()}`));
  };
  async function fix(a, kind, params, ctx) {
    params = params || {};
    const wd = path.resolve(a.working_dir), log = ctx.log, prog = ctx.progress;
    if (kind === 'runtime') {
      if (params.key !== 'java')
        throw Error('Автоматическая установка поддерживается только для Java');
      const major = +params.major;
      log(`Ищу Temurin JDK ${major} для ${osOf()}/${archOf()}…`);
      const r = await adoptium(major);
      const tmp = path.join(RT_DIR, '.tmp-' + Date.now()), arc = path.join(tmp, safeName(r.name));
      fs.mkdirSync(tmp, { recursive: true });
      try {
        log(`Скачиваю ${r.name} (${(r.size / 1048576).toFixed(0)} МБ)…`);
        await download(r.link, arc, { sha256: r.sha256, onProgress: prog });
        log('Распаковываю…');
        prog(null);
        const ex = path.join(tmp, 'x');
        await extract(arc, ex);
        const bin = findJavaBin(ex);
        if (!bin)
          throw Error('В архиве не найден bin/java');
        const final = path.join(RT_DIR, `java-${major}-${safeName(r.release)}`);
        fs.rmSync(final, { recursive: true, force: true });
        fs.renameSync(ex, final);
        fs.writeFileSync(path.join(final, '.sm-meta.json'), JSON.stringify({ key: 'java', major, release: r.release }));
        const newBin = findJavaBin(final);
        const old = a.runtime_path;
        db.prepare('UPDATE apps SET runtime_path=?,runtime=? WHERE id=?').run(newBin, a.runtime || 'java', a.id);
        log('Runtime подключён к приложению: ' + newBin);
        // удаляем прежнюю Java панели, если ей больше никто не пользуется
        if (old && path.resolve(old).startsWith(RT_DIR + path.sep)) {
          const top = path.join(RT_DIR, path.relative(RT_DIR, path.resolve(old)).split(path.sep)[0]);
          if (top !== final) {
            const used = db.prepare('SELECT runtime_path rp FROM apps UNION ALL SELECT runtime_path FROM profiles').all().some(x => x.rp && path.resolve(x.rp).startsWith(top + path.sep));
            if (!used)
              try {
                fs.rmSync(top, { recursive: true, force: true });
                log('Старая Java удалена');
              }
              catch {
              }
          }
        }
        return `Java ${major} (${r.release}) установлена`;
      }
      finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    if (kind === 'server-jar') {
      const filename = String(params.filename || 'server.jar');
      if (!/^[A-Za-z0-9._-]+\.jar$/.test(filename))
        throw Error('Недопустимое имя файла');
      const vendor = params.vendor, version = String(params.version || '');
      if (!/^\d+(\.\d+){1,2}$/.test(version))
        throw Error('Выберите версию');
      let url, sha256, sha1, finalName = filename;
      if (vendor === 'vanilla') {
        log('Запрашиваю данные у Mojang…');
        const d = await vanillaDownload(version);
        url = d.url;
        sha1 = d.sha1;
      }
      else if (vendor === 'paper' || vendor === 'folia') {
        log(`Запрашиваю последнюю сборку ${vendor} ${version}…`);
        const l = await paperLatest(vendor, version);
        url = l.url;
        sha256 = l.sha256;
        log(`Сборка #${l.build}`);
        if (PAPER_RE.test(filename))
          finalName = l.name;
      }
      else
        throw Error('Неизвестный источник');
      const dest = path.join(wd, finalName);
      if (fs.existsSync(dest))
        moveOld(wd, dest);
      log('Скачиваю ' + finalName + '…');
      await download(url, dest, { sha256, sha1, onProgress: prog });
      if (finalName !== filename) { // имя сборки изменилось — поправим команду
        const rep = s => String(s || '').split(filename).join(finalName);
        db.prepare('UPDATE apps SET command=?,launch_json=? WHERE id=?').run(rep(a.command), rep(a.launch_json), a.id);
      }
      return `Файл ${finalName} скачан`;
    }
    if (kind === 'jar-update') {
      const jar = String(params.jar || '');
      const file = path.resolve(wd, jar);
      if (!file.startsWith(wd + path.sep) || !/\.jar$/i.test(file) || !fs.existsSync(file))
        throw Error('JAR не найден');
      const base = path.basename(file);
      let url, sha256, sha1, finalName = base;
      if (params.project === 'vanilla') {
        const info = await jarInfo(file);
        const latest = await vanillaLatest();
        if (info && cmpVer(latest, info.id) <= 0)
          return 'Уже актуальная версия';
        if (ctx.backup) {
          log('Создаю backup перед обновлением…');
          await ctx.backup();
        }
        const d = await vanillaDownload(latest);
        url = d.url;
        sha1 = d.sha1;
        log('Версия ' + latest);
      }
      else {
        const pm = PAPER_RE.exec(base);
        if (!pm)
          throw Error('Имя файла не похоже на сборку Paper');
        const l = await paperLatest(pm[1].toLowerCase(), pm[2]);
        if (+l.build <= +pm[3])
          return 'Уже актуальная сборка';
        url = l.url;
        sha256 = l.sha256;
        finalName = l.name;
        log('Сборка #' + l.build);
      }
      const dest = path.join(path.dirname(file), finalName), tmp = dest + '.new';
      log('Скачиваю ' + finalName + '…');
      await download(url, tmp, { sha256, sha1, onProgress: prog });
      moveOld(wd, file);
      fs.renameSync(tmp, dest);
      log('Прежняя версия сохранена в .sm-old');
      if (finalName !== base) {
        const rep = s => String(s || '').split(base).join(finalName);
        db.prepare('UPDATE apps SET command=?,launch_json=? WHERE id=?').run(rep(a.command), rep(a.launch_json), a.id);
      }
      return `Обновлено: ${finalName}`;
    }
    if (kind === 'npm') {
      const env = { ...process.env };
      const pk = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
      if (a.runtime_path) {
        try {
          const st = fs.statSync(a.runtime_path);
          env[pk] = (st.isDirectory() ? a.runtime_path : path.dirname(a.runtime_path)) + path.delimiter + (env[pk] || '');
        }
        catch {
        }
      }
      log('npm install…');
      await new Promise((res, rej) => {
        const c = spawn('npm install', { cwd: wd, shell: true, env, windowsHide: true });
        const t = setTimeout(() => {
          c.kill();
          rej(Error('npm install: таймаут 10 минут'));
        }, 600000);
        const on = d => {
          const s = String(d);
          ctx.output && ctx.output(s);
          String(s).split(/\r?\n/).filter(Boolean).slice(-1).forEach(l => log(l));
        };
        c.stdout.on('data', on);
        c.stderr.on('data', on);
        c.on('error', e => {
          clearTimeout(t);
          rej(e);
        });
        c.on('close', code => {
          clearTimeout(t);
          code === 0 ? res() : rej(Error('npm install завершился с кодом ' + code));
        });
      });
      return 'Зависимости установлены';
    }
    if (kind === 'use-panel-node') {
      db.prepare('UPDATE apps SET runtime_path=? WHERE id=?').run(path.dirname(process.execPath), a.id);
      return 'Используется Node.js панели: ' + process.execPath;
    }
    throw Error('Это исправление выполняется вручную');
  }
  return { check, fix, versions, download, tokens };
};
