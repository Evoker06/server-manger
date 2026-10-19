'use strict';
// Мелкие общие помощники для HTTP-ответов. Работают и с Express, и с «голым» http.
const { describeFsError, UserError } = require('./safe-paths');

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

/** Превращает любую ошибку в понятный JSON-ответ. Служебные поля ошибки (received, exists…) передаются клиенту. */
function sendError(res, error, fallbackStatus = 400) {
  if (res.headersSent) {
    // Ответ уже начат (например, скачивание) — остаётся только оборвать соединение, чтобы клиент не принял файл за целый
    res.destroy();
    return;
  }
  const status = error instanceof UserError ? error.status : (error && error.status) || fallbackStatus;
  const extra = {};
  for (const key of ['exists', 'received', 'conflict', 'size', 'limit']) if (error && error[key] !== undefined) extra[key] = error[key];
  sendJson(res, status, { error: describeFsError(error), ...extra });
}

/** Обёртка для асинхронных обработчиков: любая ошибка превращается в ответ, а не в «упавший» запрос. */
const route = handler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(error => sendError(res, error));
};

module.exports = { sendJson, sendError, route };
