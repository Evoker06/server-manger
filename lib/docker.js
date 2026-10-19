'use strict';
// Управление контейнерами Docker (через команду docker на этом компьютере).
// Все значения, которые попадают в командную строку docker, проверяются: нельзя подсунуть лишний параметр
// вроде «--privileged» вместо имени образа или контейнера.
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { UserError } = require('./safe-paths');
const { sendJson, route } = require('./http-helpers');

const DOCKER_TIMEOUT_MS = 30000;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,200}$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PORT_PATTERN = /^(\d{1,3}(\.\d{1,3}){3}:)?\d{1,5}(-\d{1,5})?:\d{1,5}(-\d{1,5})?(\/(tcp|udp))?$/;

async function runDocker(args) {
  try {
    return await execFileAsync('docker', args, { timeout: DOCKER_TIMEOUT_MS, windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
  } catch (error) {
    throw new UserError((error.stderr || error.message || 'Ошибка Docker').trim());
  }
}

function checkContainer(value) {
  const id = String(value || '');
  if (!CONTAINER_PATTERN.test(id)) throw new UserError('Недопустимое имя или идентификатор контейнера');
  return id;
}

function registerDockerRoutes({ app, audit }) {
  app.get('/api/docker', route(async (req, res) => {
    const { stdout } = await runDocker(['ps', '-a', '--format', '{{json .}}']);
    sendJson(res, 200, stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  }));

  app.post('/api/docker/run', route(async (req, res) => {
    const body = req.body || {};
    if (!body.image) throw new UserError('Image обязателен');
    const image = String(body.image);
    if (!IMAGE_PATTERN.test(image)) throw new UserError('Недопустимое имя образа');
    const name = body.name ? checkContainer(body.name) : `sm-${Date.now()}`;
    const args = ['run', '-d', '--name', name];
    for (const port of String(body.ports || '').split(',').map(item => item.trim()).filter(Boolean)) {
      if (!PORT_PATTERN.test(port)) throw new UserError('Недопустимый порт: ' + port + ' (пример: 8080:80)');
      args.push('-p', port);
    }
    args.push(image);
    if (body.command) args.push(...String(body.command).split(/\s+/).filter(Boolean));
    const { stdout } = await runDocker(args);
    audit(req.user, 'docker_run', body.name || image);
    sendJson(res, 200, { id: stdout.trim() });
  }));

  for (const action of ['start', 'stop', 'restart', 'remove']) {
    app.post(`/api/docker/:id/${action}`, route(async (req, res) => {
      const id = checkContainer(req.params.id);
      await runDocker(action === 'remove' ? ['rm', '-f', id] : [action, id]);
      audit(req.user, `docker_${action}`, id);
      sendJson(res, 200, { ok: true });
    }));
  }

  app.get('/api/docker/:id/logs', route(async (req, res) => {
    const { stdout, stderr } = await runDocker(['logs', '--tail', '500', checkContainer(req.params.id)]);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end((stdout || '') + (stderr || ''));
  }));
}

module.exports = registerDockerRoutes;
