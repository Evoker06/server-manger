'use strict';
// Сравнение «до / после» для узких мест, найденных при аудите. Запуск: node tools/benchmark.js [размер_в_МБ]
// «До» — модель прежнего кода, воспроизведённая по server.js версии 1.5.0 (multer не нужен: измеряется сам приём файла на диск).
// «После» — код из этого проекта. Измеряем два показателя: время и самую долгую «заморозку» панели (event loop).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { listDirectory } = require('../lib/file-manager');

const MIB = 1024 * 1024;
const sizeMb = Number(process.argv[2]) || 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bench-'));

/** Следит, не «замерзает» ли главный поток: каждые 10 мс проверяет, насколько опоздал таймер. */
function stallMeter() {
  let last = process.hrtime.bigint(), worst = 0;
  const timer = setInterval(() => { const now = process.hrtime.bigint(); worst = Math.max(worst, Number(now - last) / 1e6 - 10); last = now; }, 10);
  return { stop() { clearInterval(timer); return Math.max(0, worst); } };
}
async function measure(label, fn) {
  const meter = stallMeter();
  const start = process.hrtime.bigint();
  await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  await new Promise(resolve => setTimeout(resolve, 40)); // даём таймеру «проснуться»: так видна заморозка, случившаяся внутри синхронной операции
  const stall = meter.stop();
  console.log(`${label.padEnd(58)} ${(ms / 1000).toFixed(2).padStart(7)} с   макс. заморозка панели ${stall.toFixed(0).padStart(6)} мс`);
  return { ms, stall };
}

(async () => {
  const source = path.join(dir, 'source.bin');
  const block = crypto.randomBytes(MIB);
  const fd = fs.openSync(source, 'w');
  for (let i = 0; i < sizeMb; i++) fs.writeSync(fd, block);
  fs.closeSync(fd);
  console.log(`Файл ${sizeMb} МБ, ${os.cpus().length} ядро(а), Node ${process.version}\n`);

  console.log('— Перенос файла на другой диск (раньше: copyFileSync после загрузки; теперь: потоковое копирование) —');
  await measure('ДО:    fs.copyFileSync (блокирует всю панель)', async () => { fs.copyFileSync(source, path.join(dir, 'old-copy.bin')); });
  await measure('ДО:    поток с буфером 64 КБ (прежний xCopy)', () => pipeline(fs.createReadStream(source), fs.createWriteStream(path.join(dir, 'old-stream.bin'))));
  await measure('ПОСЛЕ:  pipeline, буфер 4 МБ + подсчёт прогресса', () => {
    let done = 0;
    return pipeline(fs.createReadStream(source, { highWaterMark: 4 * MIB }), new Transform({ transform(c, _e, cb) { done += c.length; cb(null, c); } }), fs.createWriteStream(path.join(dir, 'new-stream.bin'), { highWaterMark: 4 * MIB }));
  });

  console.log('\n— Список папки с 20 000 файлов (раньше: statSync на каждый файл; теперь: страница из 500 + асинхронно) —');
  const big = path.join(dir, 'big'); fs.mkdirSync(big);
  for (let i = 0; i < 20000; i++) fs.writeFileSync(path.join(big, `file-${String(i).padStart(5, '0')}.dat`), 'x');
  await measure('ДО:    readdirSync + statSync по всем файлам', async () => { for (const e of fs.readdirSync(big, { withFileTypes: true })) fs.statSync(path.join(big, e.name)); });
  const guard = { isPanelTempName: () => false, isProtectedPath: () => false };
  await measure('ПОСЛЕ:  listDirectory (сортировка по имени, страница 500)', () => listDirectory(big, { sort: 'name', limit: 500 }, guard));
  await measure('ПОСЛЕ:  listDirectory (сортировка по размеру, все stat async)', () => listDirectory(big, { sort: 'size', limit: 500 }, guard));

  fs.rmSync(dir, { recursive: true, force: true });
})();
