'use strict';
// Мини-клиент загрузки для тестов: повторяет протокол браузера (создать сессию → части → завершить).
const crypto = require('crypto');

async function createUpload(client, { path = '', name, size, mtime = 0, overwrite = false, relativePath, scope = {} }) {
  return client.post('/uploads', { path, name, size, mtime, overwrite, relativePath, ...scope });
}

async function putChunk(client, id, offset, buffer, extra = '') {
  return client.call('PUT', `/uploads/${id}?offset=${offset}${extra}`, buffer, { 'content-type': 'application/octet-stream' });
}

/** Загружает buffer целиком кусками по chunkSize. Возвращает ответы последнего запроса. */
async function uploadBuffer(client, buffer, options) {
  const created = await createUpload(client, { ...options, size: buffer.length });
  if (created.status !== 200) return created;
  const { id, chunkBytes } = created.data;
  const chunk = options.chunkSize || chunkBytes;
  let last = created;
  for (let offset = created.data.received; offset < buffer.length; offset += chunk) {
    const end = Math.min(buffer.length, offset + chunk);
    last = await putChunk(client, id, offset, buffer.subarray(offset, end), end === buffer.length ? '&finish=1' : '');
    if (last.status !== 200) return last;
  }
  if (buffer.length === 0) last = await client.post(`/uploads/${id}/finish`);
  return { ...last, id };
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const randomBytes = n => crypto.randomBytes(n);

module.exports = { createUpload, putChunk, uploadBuffer, sha256, randomBytes };
