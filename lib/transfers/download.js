'use strict';
// Скачивание файлов потоком.
//  • Файл никогда не читается в память целиком: данные идут из файла в сеть кусками по 1 МБ,
//    а pipeline сам приостанавливает чтение, если клиент принимает медленно (обратное давление).
//  • Поддерживается докачка: заголовки Range / If-Range, ETag, Last-Modified.
//  • Если файл изменился во время передачи, соединение обрывается — клиент не примет повреждённый файл за целый.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { UserError } = require('../safe-paths');

const READ_BUFFER_BYTES = 1024 * 1024;

/** Разбор заголовка Range. null — диапазон не указан/не поддерживается (отдаём файл целиком); 'invalid' — запрос неверный. */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim()); // несколько диапазонов («bytes=0-1,5-9») не поддерживаем
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return 'invalid';
  let start;
  let end;
  if (startText === '') { // «последние N байт»
    const suffix = Number(endText);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Имя файла для заголовка Content-Disposition (с поддержкой кириллицы по RFC 5987). */
function contentDisposition(fileName, inline = false) {
  const type = inline ? 'inline' : 'attachment';
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** ETag меняется при любом изменении размера или времени файла. */
const etagOf = stats => `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

async function sendFile(req, res, filePath, { downloadName, inline = false, contentType = 'application/octet-stream' } = {}) {
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) throw new UserError('Это не файл');
  const size = stats.size;
  const etag = etagOf(stats);
  const lastModified = stats.mtime.toUTCString();

  const headers = {
    'content-type': contentType,
    'content-disposition': contentDisposition(downloadName || path.basename(filePath), inline),
    'accept-ranges': 'bytes',
    etag,
    'last-modified': lastModified,
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
  };

  // If-Range: докачка допустима только если файл не менялся; иначе отдаём новый файл целиком
  let range = null;
  const ifRange = req.headers['if-range'];
  if (!ifRange || ifRange === etag || ifRange === lastModified) range = parseRange(req.headers.range, size);

  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Запрошенная часть файла выходит за его размер' }));
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  headers['content-length'] = String(length);
  res.writeHead(range ? 206 : 200, headers);

  if (req.method === 'HEAD' || length === 0) { res.end(); return; }

  let sent = 0;
  const source = fs.createReadStream(filePath, { start, end, highWaterMark: READ_BUFFER_BYTES });
  source.on('data', chunk => { sent += chunk.length; });
  try {
    await pipeline(source, res);
  } catch (error) {
    // Клиент закрыл соединение или отменил скачивание — это не ошибка сервера
    if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE'].includes(error.code)) console.warn('[download]', filePath, error.message);
    return;
  }
  if (sent !== length) res.destroy(); // файл изменился во время передачи
}

/**
 * ZIP-архив «на лету» для папки или нескольких файлов. entries: [{ absolutePath, nameInZip }].
 * Сжатие по умолчанию выключено (режим store): игровые и медиафайлы почти не сжимаются, зато процессор не тормозит передачу.
 */
async function sendZip(req, res, { archiverFactory, entries, zipName, compressionLevel = 0 }) {
  const archive = archiverFactory('zip', { zlib: { level: compressionLevel }, forceZip64: false });
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(zipName),
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
  });
  const finished = pipeline(archive, res);
  archive.on('warning', warning => console.warn('[zip]', warning.message));
  for (const entry of entries) {
    const stats = await fs.promises.stat(entry.absolutePath).catch(() => null);
    if (!stats) continue;
    if (stats.isDirectory()) archive.directory(entry.absolutePath, entry.nameInZip);
    else if (stats.isFile()) archive.file(entry.absolutePath, { name: entry.nameInZip });
  }
  archive.finalize();
  try { await finished; } catch (error) { archive.abort(); if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE'].includes(error.code)) console.warn('[zip]', error.message); }
}

module.exports = { sendFile, sendZip, parseRange, contentDisposition, etagOf };
