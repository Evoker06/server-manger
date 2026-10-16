'use strict';
// Распаковка архивов: ZIP/ZIPX (WinZip), RAR, 7z, TAR, TAR.GZ/TGZ, TAR.XZ/TXZ, TAR.BZ2, TAR.ZST, одиночные .gz/.xz/.bz2/.zst, CAB, ISO и др.
// Формат определяется по содержимому файла (сигнатуре), а не только по расширению.
// ZIP и GZ распаковываются встроенными средствами. Остальное — установленными в системе программами
// (tar/bsdtar, 7-Zip, UnRAR, xz, bzip2, zstd), вызываемыми с ФИКСИРОВАННЫМИ аргументами без shell.
// Всё извлекается во временную папку, проверяется (пути, ссылки, размер) и только потом переносится на место.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const unzipper = require('unzipper');

const win = process.platform === 'win32';
const TAR_NAME = /\.(tar\.(gz|xz|bz2|zst|lz|z)|tgz|txz|tbz2?|tzst)$/i;
const OTHER_EXT = /\.(iso|cab|arj|lzh|lzma|z|cpio|wim|deb|rpm)$/i;
const ARCHIVE_EXT = /\.(zip|zipx|rar|7z|tar|tgz|txz|tbz2?|tzst|gz|xz|bz2|zst|cab|iso|arj|lzh|lzma|z|cpio|wim)$/i;
const fail = m => { throw Error(m) };

/* ---------- определение формата ---------- */
function sniff(file) {
  const fd = fs.openSync(file, 'r'), b = Buffer.alloc(512);
  let n = 0; try { n = fs.readSync(fd, b, 0, 512, 0) } finally { fs.closeSync(fd) }
  const is = (sig, off = 0) => n >= off + sig.length && sig.every((v, i) => b[off + i] === v);
  if (is([0x50, 0x4B, 0x03, 0x04]) || is([0x50, 0x4B, 0x05, 0x06]) || is([0x50, 0x4B, 0x07, 0x08])) return 'zip';
  if (is([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07])) return 'rar';
  if (is([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])) return '7z';
  if (is([0x1F, 0x8B])) return 'gz';
  if (is([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])) return 'xz';
  if (is([0x42, 0x5A, 0x68])) return 'bz2';
  if (is([0x28, 0xB5, 0x2F, 0xFD])) return 'zst';
  if (is([0x4D, 0x53, 0x43, 0x46])) return 'cab';
  if (n >= 262 && b.toString('latin1', 257, 262) === 'ustar') return 'tar';
  return null;
}
function gzIsTar(file) {
  try {
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, 8192, 0); fs.closeSync(fd);
    const out = zlib.gunzipSync(b.subarray(0, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return out.length >= 262 && out.toString('latin1', 257, 262) === 'ustar';
  } catch { return false }
}
function classify(file, name) {
  const sig = sniff(file), tarName = TAR_NAME.test(name);
  if (sig === 'zip') return { kind: 'zip' };
  if (sig === 'tar') return { kind: 'tar' };
  if (sig === 'rar') return { kind: 'rar' };
  if (sig === '7z') return { kind: '7z' };
  if (sig === 'cab') return { kind: 'other' };
  if (['gz', 'xz', 'bz2', 'zst'].includes(sig)) return tarName || (sig === 'gz' && gzIsTar(file)) ? { kind: 'tar', codec: sig } : { kind: 'single', codec: sig };
  if (OTHER_EXT.test(name)) return { kind: 'other' };
  return null;
}
// имя папки по умолчанию: имя архива без расширения(й)
function baseName(name) {
  let b = name.replace(TAR_NAME, '').replace(/\.(zip|zipx|rar|7z|tar|gz|xz|bz2|zst|cab|iso|arj|lzh|lzma|z|cpio|wim)$/i, '');
  b = b.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return b || 'archive';
}

/* ---------- поиск программ ---------- */
function which(names, extra = []) {
  const dirs = [...extra, ...String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)];
  for (const d of dirs) for (const n of names) {
    for (const ext of win ? ['.exe', '.cmd', ''] : ['']) { const f = path.join(d, n + ext); try { if (fs.statSync(f).isFile()) return f } catch { } }
  }
  return null;
}
const runP = (cmd, args, opt = {}) => new Promise(res => {
  execFile(cmd, args, { timeout: opt.timeout || 8000, windowsHide: true, maxBuffer: 1 << 20 }, (e, so, se) => res({ code: e ? (e.code ?? 1) : 0, stdout: so || '', stderr: se || '' }));
});
let toolCache = null, toolCacheT = 0;
async function tools(force) {
  if (!force && toolCache && Date.now() - toolCacheT < 60000) return toolCache;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean);
  const dirs7 = win ? pf.map(p => path.join(p, '7-Zip')) : [];
  const dirsRar = win ? pf.map(p => path.join(p, 'WinRAR')) : [];
  const sys32 = win ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [];
  const t = {
    sevenZip: which(['7z', '7zz', '7za', '7zr'], dirs7),
    unrar: which(['unrar', 'UnRAR'], dirsRar),
    tar: which(['tar'], sys32), bsdtar: which(['bsdtar']),
    xz: which(['xz']), bzip2: which(['bzip2']), zstd: which(['zstd']),
  };
  t.tarIsBsd = false;
  if (t.tar) { const v = await runP(t.tar, ['--version']); t.tarIsBsd = /bsdtar|libarchive/i.test(v.stdout + v.stderr) }
  t.libarchive = t.bsdtar || (t.tarIsBsd ? t.tar : null); // умеет читать rar/7z/zip/tar.*
  toolCache = t; toolCacheT = Date.now();
  return t;
}
async function toolSummary() {
  const t = await tools(true);
  return {
    zip: true, gz: true, tar: !!t.tar || !!t.sevenZip, tarXz: !!(t.tar && (t.xz || t.tarIsBsd)) || !!t.sevenZip, tarBz2: !!(t.tar && (t.bzip2 || t.tarIsBsd)) || !!t.sevenZip,
    sevenZip: !!(t.sevenZip || t.libarchive), rar: !!(t.sevenZip || t.unrar || t.libarchive),
    tools: { '7-Zip': t.sevenZip, UnRAR: t.unrar, 'tar': t.tar, bsdtar: t.bsdtar },
    hint: installHint(),
  };
}
function installHint() {
  return win ? 'Для RAR, 7z и редких форматов установите 7-Zip (https://www.7-zip.org/) — панель найдёт его сама. Подойдёт и WinRAR.'
    : 'Для RAR, 7z и редких форматов установите 7-Zip или unrar (например: sudo apt install p7zip-full unrar).';
}

/* ---------- запуск программ ---------- */
function runTool(cmd, args, { timeout = 3600000, onChild } = {}) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { c.kill('SIGKILL'); rej(Error('Распаковка заняла слишком много времени и прервана')) }, timeout);
    c.stdout.on('data', d => { if (out.length < 1 << 20) out += d });
    c.stderr.on('data', d => { if (err.length < 1 << 16) err += d });
    c.on('error', e => { clearTimeout(t); rej(e) });
    c.on('close', code => { clearTimeout(t); res({ code, out, err }) });
    if (onChild) onChild(c);
  });
}

/* ---------- проверки безопасности ---------- */
function badEntry(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.includes('\0')) return true;
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return true;
  if (n.split('/').some(s => s === '..')) return true;
  if (win && /[:*?"<>|]/.test(n.replace(/^[A-Za-z]:/, ''))) return true;
  return false;
}
function checkNames(names, limits) {
  if (names.length > limits.files) fail(`В архиве слишком много файлов (${names.length}). Максимум ${limits.files}.`);
  const bad = names.find(badEntry);
  if (bad !== undefined) fail('Архив содержит небезопасный путь («' + String(bad).slice(0, 120) + '») — распаковка отклонена.');
}
function treeStats(dir, limits, st = { files: 0, bytes: 0, links: 0 }, fix = false) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e), s = fs.lstatSync(p);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) { if (fix) { fs.rmSync(p, { force: true, recursive: true }); st.links++ } continue }
    if (s.isDirectory()) { treeStats(p, limits, st, fix); continue }
    st.files++; st.bytes += s.size;
    if (fix && (s.mode & 0o7000)) { try { fs.chmodSync(p, s.mode & 0o777) } catch { } } // убираем setuid/setgid
    if (st.files > limits.files) fail('В архиве слишком много файлов');
    if (st.bytes > limits.bytes) fail('Распакованный размер превышает лимит ' + fmt(limits.bytes));
  }
  return st;
}
const fmt = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' ГБ' : (n / 1048576).toFixed(0) + ' МБ';

/* ---------- ZIP (встроенно) ---------- */
async function extractZip(archive, stage, limits, prog) {
  const d = await unzipper.Open.file(archive), files = d.files;
  checkNames(files.map(f => f.path), limits);
  if (files.some(f => (f.flags & 1) === 1)) fail('Архив защищён паролем. Распаковка защищённых паролем архивов не поддерживается.');
  if (files.some(f => f.type !== 'Directory' && ![0, 8].includes(f.compressionMethod))) { const e = Error('zip-method'); e.fallback = true; throw e }
  const total = files.reduce((a, f) => a + (f.uncompressedSize || 0), 0);
  if (total > limits.bytes) fail(`Распакованный размер (${fmt(total)}) превышает лимит ${fmt(limits.bytes)} — похоже на «архивную бомбу».`);
  const base = path.resolve(stage); let done = 0, n = 0;
  for (const f of files) {
    const rel = f.path.replace(/\\/g, '/'), dest = path.resolve(base, rel);
    if (dest !== base && !dest.startsWith(base + path.sep)) fail('Архив содержит небезопасный путь');
    if (f.type === 'Directory' || rel.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); continue }
    const mode = (f.externalFileAttributes >>> 16) & 0o170000;
    if (mode === 0o120000) { prog.links++; continue } // символические ссылки не создаём
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let written = 0;
    const tap = new Transform({ transform(c, _e, cb) { written += c.length; done += c.length; if (written > Math.max(f.uncompressedSize || 0, 1) * 1.01 + 1048576) return cb(Error('Размер файла в архиве не совпадает с заявленным')); prog.bytes = done; cb(null, c) } });
    await pipeline(f.stream(), tap, fs.createWriteStream(dest));
    prog.files = ++n;
  }
}

/* ---------- внешние программы ---------- */
async function list7z(exe, archive, limits) {
  const r = await runTool(exe, ['l', '-slt', '-ba', '-bd', '--', archive], { timeout: 120000 });
  if (r.code > 1) fail(/password|encrypted/i.test(r.out + r.err) ? 'Архив защищён паролем. Распаковка защищённых паролем архивов не поддерживается.' : 'Не удалось прочитать архив: ' + (r.err || r.out).trim().split('\n').slice(-1)[0]);
  const names = [], blocks = r.out.split(/\r?\n\r?\n/);
  let total = 0, enc = false;
  for (const b of blocks) {
    const p = /^Path = (.*)$/m.exec(b); if (!p) continue;
    names.push(p[1]); const s = /^Size = (\d+)$/m.exec(b); if (s) total += +s[1];
    if (/^Encrypted = \+$/m.test(b)) enc = true;
  }
  if (enc) fail('Архив защищён паролем. Распаковка защищённых паролем архивов не поддерживается.');
  checkNames(names, limits);
  if (total > limits.bytes) fail(`Распакованный размер (${fmt(total)}) превышает лимит ${fmt(limits.bytes)}.`);
  return total;
}
async function listTar(exe, archive, limits) {
  const r = await runTool(exe, ['-tf', archive], { timeout: 600000 });
  if (r.code !== 0) fail('Не удалось прочитать архив: ' + (r.err || '').trim().split('\n').slice(-1)[0]);
  checkNames(r.out.split(/\r?\n/).filter(Boolean), limits);
}
async function listUnrar(exe, archive, limits) {
  const r = await runTool(exe, ['lb', '-p-', '--', archive], { timeout: 120000 });
  if (r.code !== 0) fail(/password|encrypted/i.test(r.out + r.err) ? 'Архив защищён паролем. Распаковка защищённых паролем архивов не поддерживается.' : 'Не удалось прочитать RAR: ' + (r.err || r.out).trim().split('\n').slice(-1)[0]);
  checkNames(r.out.split(/\r?\n/).filter(Boolean), limits);
}
const noPwd = s => /wrong password|can't open encrypted|data error in encrypted|enter password/i.test(s);
async function with7z(exe, archive, stage, limits, watch) {
  await list7z(exe, archive, limits);
  const r = await runTool(exe, ['x', '-y', '-bd', '-aoa', '-o' + stage, '--', archive], { onChild: watch });
  if (r.code > 1) fail(noPwd(r.out + r.err) ? 'Архив защищён паролем.' : 'Ошибка распаковки (7-Zip): ' + (r.err || r.out).trim().split('\n').slice(-2).join(' '));
  // .tar.gz через 7-Zip распаковывается в два прохода
  const ents = fs.readdirSync(stage);
  if (ents.length === 1 && /\.tar$/i.test(ents[0]) && fs.lstatSync(path.join(stage, ents[0])).isFile()) {
    const inner = path.join(stage, ents[0]), s2 = path.join(stage, '.sm-inner');
    fs.mkdirSync(s2); await list7z(exe, inner, limits);
    const r2 = await runTool(exe, ['x', '-y', '-bd', '-aoa', '-o' + s2, '--', inner], { onChild: watch });
    if (r2.code > 1) fail('Ошибка распаковки (7-Zip): ' + (r2.err || r2.out).trim().split('\n').slice(-2).join(' '));
    fs.rmSync(inner, { force: true });
    for (const e of fs.readdirSync(s2)) fs.renameSync(path.join(s2, e), path.join(stage, e));
    fs.rmdirSync(s2);
  }
}
async function withTar(exe, archive, stage, limits, watch) {
  await listTar(exe, archive, limits);
  const r = await runTool(exe, ['-xf', archive, '-C', stage, '--no-same-owner'], { onChild: watch });
  if (r.code !== 0) fail('Ошибка распаковки (tar): ' + (r.err || r.out).trim().split('\n').slice(-2).join(' '));
}
async function withUnrar(exe, archive, stage, limits, watch) {
  await listUnrar(exe, archive, limits);
  const r = await runTool(exe, ['x', '-y', '-idq', '-p-', '--', archive, stage + path.sep], { onChild: watch });
  if (r.code !== 0) fail(noPwd(r.out + r.err) ? 'Архив защищён паролем.' : 'Ошибка распаковки (UnRAR): ' + (r.err || r.out).trim().split('\n').slice(-2).join(' '));
}
async function singleFile(c, archive, name, stage, limits, tl, prog) {
  let outName = name.replace(/\.(gz|xz|bz2|zst)$/i, '');
  if (outName === name) outName += '.out';
  outName = outName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  const dest = path.join(stage, outName);
  let n = 0;
  const tap = new Transform({ transform(ch, _e, cb) { n += ch.length; prog.bytes = n; if (n > limits.bytes) return cb(Error('Распакованный размер превышает лимит ' + fmt(limits.bytes))); cb(null, ch) } });
  if (c.codec === 'gz') { await pipeline(fs.createReadStream(archive), zlib.createGunzip(), tap, fs.createWriteStream(dest)); prog.files = 1; return }
  const exe = { xz: tl.xz, bz2: tl.bzip2, zst: tl.zstd }[c.codec];
  if (exe) {
    await new Promise((res, rej) => {
      const ch = spawn(exe, ['-dc', '--', archive], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = ''; ch.stderr.on('data', d => { if (err.length < 4096) err += d });
      pipeline(ch.stdout, tap, fs.createWriteStream(dest)).then(() => { }, rej);
      ch.on('error', rej); ch.on('close', code => code === 0 ? res() : rej(Error('Ошибка распаковки: ' + err.trim())));
    });
    prog.files = 1; return;
  }
  return null; // нужен 7-Zip
}

/* ---------- главная функция ---------- */
// info: {archive, name, stage, limits:{bytes,files}, progress:{files,bytes,links,phase,tool}}
async function extractToStage({ archive, name, stage, limits, progress }) {
  const c = classify(archive, name);
  if (!c) fail('Файл не похож на архив или формат не распознан.');
  const tl = await tools();
  fs.mkdirSync(stage, { recursive: true });
  progress.format = c.kind === 'single' ? c.codec : c.kind + (c.codec ? '.' + c.codec : '');
  // слежение за размером распаковываемого: прерываем, если выходит за лимит или заканчивается место
  let killer = null, tripped = '';
  const watch = ch => {
    const t = setInterval(() => {
      try {
        const s = treeStats(stage, { files: Infinity, bytes: Infinity }); progress.files = s.files; progress.bytes = s.bytes;
        if (s.bytes > limits.bytes || s.files > limits.files) { tripped = 'Распаковка прервана: превышен лимит размера/числа файлов (защита от «архивных бомб»).'; ch.kill('SIGKILL') }
      } catch { }
    }, 1500);
    ch.on('close', () => clearInterval(t));
    killer = t;
  };
  const use7z = () => tl.sevenZip ? (progress.tool = '7-Zip', with7z(tl.sevenZip, archive, stage, limits, watch)) : null;
  const useLib = () => tl.libarchive ? (progress.tool = 'bsdtar', withTar(tl.libarchive, archive, stage, limits, watch)) : null;
  const need = what => fail(`${what} Нужна программа-распаковщик. ${installHint()}`);
  try {
    if (c.kind === 'zip') {
      progress.tool = 'встроенный ZIP';
      try { await extractZip(archive, stage, limits, progress) }
      catch (e) {
        if (!e.fallback) throw e;
        fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage);
        const p = use7z() || useLib();
        if (!p) need('Этот ZIP использует метод сжатия, который встроенный распаковщик не поддерживает (например, WinZip .zipx).');
        await p;
      }
    } else if (c.kind === 'tar') {
      const p = tl.tar ? (progress.tool = 'tar', withTar(tl.tar, archive, stage, limits, watch)) : use7z();
      if (!p) need('Для TAR-архивов нужна программа tar или 7-Zip.');
      try { await p } catch (e) { // на минимальных системах нет xz/bzip2 для tar — пробуем 7-Zip
        if (tl.sevenZip && /xz|bzip2|zstd|not found|Cannot exec|Unsupported|Error is not recoverable/i.test(e.message)) { fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage); await use7z() } else throw e;
      }
    } else if (c.kind === 'single') {
      progress.tool = c.codec === 'gz' ? 'встроенный GZIP' : c.codec;
      const r = await singleFile(c, archive, name, stage, limits, tl, progress);
      if (r === null) { const p = use7z() || useLib(); if (!p) need(`Для .${c.codec} нужна программа ${c.codec === 'bz2' ? 'bzip2' : c.codec} или 7-Zip.`); await p }
    } else if (c.kind === 'rar') {
      const p = tl.unrar ? (progress.tool = 'UnRAR', withUnrar(tl.unrar, archive, stage, limits, watch)) : (use7z() || useLib());
      if (!p) need('Для RAR-архивов нужен 7-Zip, WinRAR (UnRAR) или unrar.');
      await p;
    } else { // 7z, cab, iso и прочее
      const p = use7z() || useLib();
      if (!p) need(`Для формата ${c.kind.toUpperCase()} нужен 7-Zip.`);
      await p;
    }
  } catch (e) { throw Error(tripped || (/FILE_ENDED|end of central|invalid signature|bad central|incorrect header|unexpected end|invalid (block|stored|distance|code)/i.test(e.message) ? 'Архив повреждён или неполный (возможно, загрузился не до конца).' : e.message)) }
  finally { if (killer) clearInterval(killer) }
  if (tripped) fail(tripped);
  // итоговая проверка: убираем ссылки и особые файлы, считаем размер
  const st = treeStats(stage, limits, { files: 0, bytes: 0, links: 0 }, true);
  progress.files = st.files; progress.bytes = st.bytes; progress.links += st.links;
  if (!st.files) fail('Архив пуст или распаковался без файлов.');
  return st;
}

/* ---------- перенос из временной папки на место ---------- */
function place(stage, destDir, { overwrite = false, flatten = false, deny = () => false } = {}) {
  let src = stage;
  if (flatten) { const e = fs.readdirSync(stage); if (e.length === 1 && fs.lstatSync(path.join(stage, e[0])).isDirectory()) src = path.join(stage, e[0]) }
  const st = { files: 0, skipped: 0 };
  if (!fs.existsSync(destDir)) { fs.mkdirSync(path.dirname(destDir), { recursive: true }); fs.renameSync(src, destDir); return { files: null, skipped: 0 } }
  const merge = (s, d) => {
    for (const e of fs.readdirSync(s)) {
      const sp = path.join(s, e), dp = path.join(d, e), sl = fs.lstatSync(sp);
      if (deny(dp)) { st.skipped++; continue }
      let dl = null; try { dl = fs.lstatSync(dp) } catch { }
      if (dl && dl.isSymbolicLink()) { st.skipped++; continue } // не пишем через ссылки, лежащие в папке назначения
      if (sl.isDirectory()) {
        if (dl && !dl.isDirectory()) { st.skipped++; continue }
        if (!dl) fs.mkdirSync(dp);
        merge(sp, dp);
      } else {
        if (dl) { if (!overwrite || dl.isDirectory()) { st.skipped++; continue } fs.rmSync(dp, { force: true }) }
        fs.renameSync(sp, dp); st.files++;
      }
    }
  };
  merge(src, destDir);
  return st;
}

module.exports = { classify, baseName, tools, toolSummary, extractToStage, place, installHint, ARCHIVE_EXT, _t: { sniff, badEntry, checkNames } };
