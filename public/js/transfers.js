// Передача файлов: очередь загрузок, скачивания и фоновых операций (копирование, перемещение, распаковка).
//
//  Загрузка идёт частями (по 16 МБ) на сервер: если связь оборвалась, повторяется только последняя часть,
//  а после закрытия страницы загрузку можно продолжить, выбрав тот же файл ещё раз.
//  Скачивание: если браузер умеет писать файл потоком (Chrome/Edge на https или localhost) — со скоростью, остатком времени
//  и докачкой; иначе файл скачивает сам браузер (с его собственным индикатором).
//  Панель очереди — в правом нижнем углу.
const MAX_PARALLEL_UPLOADS = 2;
const MAX_CHUNK_RETRIES = 8;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const SPEED_WINDOW_MS = 5000;
const JOB_POLL_MS = 600;

const Transfers = (() => {
  const items = [];                     // все элементы очереди (новые — внизу)
  let nextId = 1;
  let panelOpen = true;
  let overwriteChoice = null;           // «для всех» в текущей пачке: 'replace' | 'skip' | null

  const find = id => items.find(item => item.id === id);
  const activeUploads = () => items.filter(item => item.kind === 'upload' && item.status === 'uploading').length;
  const isBusy = () => items.some(item => ['uploading', 'queued', 'running'].includes(item.status));

  /* ---------- скорость и остаток времени ---------- */
  function sample(item, bytes) {
    const now = Date.now();
    item.samples = (item.samples || []).filter(s => now - s.t < SPEED_WINDOW_MS);
    item.samples.push({ t: now, bytes });
    const first = item.samples[0];
    const seconds = (now - first.t) / 1000;
    item.speed = seconds > 0.5 ? (bytes - first.bytes) / seconds : item.speed || 0;
  }
  function etaText(item) {
    const remaining = item.size - item.done;
    if (!item.speed || item.speed < 1 || remaining <= 0 || !item.startedAt || Date.now() - item.startedAt < 2500) return '';
    const seconds = Math.round(remaining / item.speed);
    return seconds < 90 ? `${seconds} с` : seconds < 5400 ? `${Math.round(seconds / 60)} мин` : `${(seconds / 3600).toFixed(1)} ч`;
  }

  /* ---------- общий запрос с повторами ---------- */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isNetworkError = error => !error.status || error.status >= 500 || error.status === 408 || error.status === 429;

  /** PUT одной части через XMLHttpRequest: fetch не показывает прогресс отправки. */
  function putChunk(item, offset, blob, last) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open('PUT', apiPath(`/uploads/${item.sessionId}?offset=${offset}${last ? '&finish=1' : ''}`, item.node));
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = event => { item.done = offset + event.loaded; sample(item, item.done); render(); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* пустой или не JSON */ }
        if (xhr.status === 200) return resolve(data);
        const error = new Error(data.error || `HTTP ${xhr.status}`);
        error.status = xhr.status;
        error.data = data;
        reject(error);
      };
      xhr.onerror = () => reject(new Error('Нет связи с сервером'));
      xhr.ontimeout = () => reject(new Error('Таймаут'));
      xhr.onabort = () => { const error = new Error('Остановлено'); error.aborted = true; reject(error); };
      xhr.send(blob);
    });
  }

  /* ---------- загрузка ---------- */
  async function runUpload(item) {
    item.status = 'uploading';
    item.error = '';
    item.startedAt = item.startedAt || Date.now();
    render();
    try {
      let session = await api('/uploads', { method: 'POST', node: item.node, headers: JH, body: JSON.stringify({
        path: item.folder, name: item.file.name, relativePath: item.relativePath, size: item.file.size, mtime: item.file.lastModified,
        overwrite: item.overwrite, ...item.scope,
      }) });
      item.sessionId = session.id;
      item.done = session.received;
      item.samples = [];
      let offset = session.received;
      const chunk = session.chunkBytes;
      if (item.file.size === 0) { await api(`/uploads/${item.sessionId}/finish`, { method: 'POST', node: item.node, headers: JH, body: '{}' }); return finishItem(item); }

      while (offset < item.file.size) {
        const end = Math.min(item.file.size, offset + chunk);
        let attempt = 0;
        for (;;) {
          try {
            const result = await putChunk(item, offset, item.file.slice(offset, end), end === item.file.size);
            offset = result.received;
            item.done = offset;
            sample(item, offset);
            if (result.done) return finishItem(item);
            break;
          } catch (error) {
            if (error.aborted) return; // пауза или отмена — статус уже выставлен
            if (error.status === 409 && error.data && error.data.received !== undefined) { offset = error.data.received; item.done = offset; break; } // сервер уже принял часть — идём с его позиции
            if (!isNetworkError(error) || ++attempt > MAX_CHUNK_RETRIES) throw error;
            item.note = `Обрыв связи, повтор ${attempt}…`;
            render();
            await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
            try { // узнаём, сколько сервер реально получил
              const state = await api('/uploads/' + item.sessionId, { node: item.node, keepAcrossPages: true });
              offset = state.received; item.done = offset;
              if (offset >= item.file.size) { const done = await api(`/uploads/${item.sessionId}/finish`, { method: 'POST', node: item.node, headers: JH, body: '{}' }); return finishItem(item, done); }
              break;
            } catch (stateError) { if (stateError.status === 404) throw new Error('Загрузка утеряна на сервере — начните заново'); }
          }
        }
        item.note = '';
      }
    } catch (error) {
      if (error.aborted) return;
      if (error.status === 409 && error.data && error.data.exists) return askAndRetryOverwrite(item);
      item.status = 'error';
      item.error = error.message;
      render();
    } finally { schedule(); }
  }

  function finishItem(item) {
    item.status = 'done';
    item.done = item.file.size;
    item.speed = 0;
    render();
    notifyDone(item);
  }

  /** Файл с таким именем уже есть: спрашиваем «заменить / пропустить» (можно сразу для всех). */
  async function askAndRetryOverwrite(item) {
    let choice = overwriteChoice;
    if (!choice) {
      choice = await new Promise(resolve => {
        modal('Файл уже существует', `<div class=form><p>В папке уже есть файл <b>${esc(item.relativePath || item.file.name)}</b>. Заменить его новым?</p>
          <small class=muted>Старый файл останется нетронутым, пока новый не будет полностью загружен.</small>
          <label class=checkline><input type=checkbox id=ovAll> Применить ко всем следующим файлам</label>
          <div class=actions><button class=primary id=ovReplace>Заменить</button><button class=btn id=ovSkip>Пропустить</button></div></div>`);
        const answer = value => { if ($('ovAll') && $('ovAll').checked) overwriteChoice = value; closeModal(); resolve(value); };
        $('ovReplace').onclick = () => answer('replace');
        $('ovSkip').onclick = () => answer('skip');
      });
    }
    if (choice === 'replace') { item.overwrite = true; item.status = 'queued'; } else { item.status = 'cancelled'; item.error = 'Пропущено'; }
    render();
    schedule();
  }

  function schedule() {
    for (const item of items) {
      if (activeUploads() >= MAX_PARALLEL_UPLOADS) break;
      if (item.kind === 'upload' && item.status === 'queued') runUpload(item);
    }
    if (!isBusy()) overwriteChoice = null;
    render();
  }

  /** Добавляет файлы в очередь. files: [{ file, relativePath? }] */
  function upload(list, { folder, scope }) {
    if (!list.length) return;
    for (const entry of list) {
      items.push({ id: nextId++, kind: 'upload', status: 'queued', file: entry.file, relativePath: entry.relativePath || '', folder: folder || '',
        scope: scope || {}, node, name: entry.relativePath || entry.file.name, size: entry.file.size, done: 0, speed: 0, overwrite: false });
    }
    panelOpen = true;
    schedule();
  }

  /* ---------- скачивание ---------- */
  async function ticketUrl(query) {
    const result = await api('/tickets/download', { method: 'POST', headers: JH, body: JSON.stringify({ node, query }) });
    return result.url;
  }

  const canStreamToDisk = () => typeof window.showSaveFilePicker === 'function' && window.isSecureContext;

  /**
   * Скачать. query: { path } | { paths: [...] } | { backup } | { applog }, плюс область (app/disk).
   * Для одного файла известного размера — потоково с прогрессом; для папок (ZIP) и без поддержки браузера — штатное скачивание.
   */
  async function download(query, { name, size, isFile } = {}) {
    try {
      if (isFile && size != null && canStreamToDisk()) return await streamDownload(query, name, size);
      // Браузер сам сохранит файл и покажет свой индикатор. Ссылка «download» не уводит со страницы панели, даже если сервер вернёт ошибку.
      const link = document.createElement('a');
      link.href = await ticketUrl(query);
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
      toast('Скачивание начато в браузере');
    } catch (error) {
      if (error.name === 'AbortError') return; // пользователь закрыл окно выбора файла
      toast(error.message, true);
    }
  }

  async function streamDownload(query, name, size) {
    const handle = await window.showSaveFilePicker({ suggestedName: name });
    const writable = await handle.createWritable();
    const item = { id: nextId++, kind: 'download', status: 'running', name, size, done: 0, speed: 0, startedAt: Date.now(), samples: [], abort: new AbortController() };
    items.push(item);
    panelOpen = true;
    render();
    let url = await ticketUrl(query);
    let attempt = 0;
    try {
      while (item.done < size) {
        try {
          const response = await fetch(url, { headers: item.done ? { Range: `bytes=${item.done}-` } : {}, signal: item.abort.signal });
          if (response.status === 401) { url = await ticketUrl(query); continue; } // билет истёк — получаем новый
          if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
          if (item.done && response.status !== 206) { await writable.truncate(0); item.done = 0; } // сервер не умеет докачку — начинаем сначала
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writable.write({ type: 'write', position: item.done, data: value });
            item.done += value.length;
            sample(item, item.done);
            render();
          }
          attempt = 0;
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          if (!isNetworkError(error) || ++attempt > MAX_CHUNK_RETRIES) throw error;
          item.note = `Обрыв связи, докачка (${attempt})…`;
          render();
          await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
        }
      }
      await writable.close();
      item.status = 'done'; item.speed = 0; item.note = '';
    } catch (error) {
      try { await writable.abort(); } catch { /* уже закрыт */ }
      item.status = item.abort.signal.aborted ? 'cancelled' : 'error';
      item.error = item.abort.signal.aborted ? 'Отменено' : error.message;
    }
    render();
  }

  /* ---------- фоновые операции на сервере (копирование, перемещение, распаковка) ---------- */
  function trackJob({ kind, jobId, name, title }) {
    const item = { id: nextId++, kind: 'job', jobKind: kind, status: 'running', name: title || name, size: 0, done: 0, speed: 0, startedAt: Date.now(), samples: [], jobId, node, note: 'Подготовка…' };
    items.push(item);
    panelOpen = true;
    render();
    const tick = async () => {
      if (item.status !== 'running') return;
      try {
        const job = await api(`/${kind}/${jobId}`, { node: item.node, keepAcrossPages: true });
        item.size = job.total || 0;
        item.done = job.done || job.bytes || 0;
        if (job.status === 'running') {
          sample(item, item.done);
          item.note = ({ scan: 'Подсчёт…', copy: 'Копирование…', verify: 'Проверка…', cleanup: 'Удаление оригинала…' }[job.phase]) || (kind === 'extract' ? `Распаковка… файлов: ${job.files || 0}` : 'Выполняется…');
          render();
          return setTimeout(tick, JOB_POLL_MS);
        }
        item.status = job.status === 'done' ? 'done' : job.status === 'cancelled' ? 'cancelled' : 'error';
        item.note = '';
        item.error = job.message || '';
        if (item.status === 'done') { item.done = item.size; notifyDone(item); } else toast(item.error || 'Операция не выполнена', true);
      } catch (error) { item.status = 'error'; item.error = error.message; }
      render();
    };
    tick();
    return item;
  }

  function notifyDone(item) { window.dispatchEvent(new CustomEvent('transfers:done', { detail: { kind: item.kind, node: item.node } })); }

  /* ---------- управление ---------- */
  function pause(id) { const item = find(id); if (item && item.status === 'uploading') { item.status = 'paused'; if (item.xhr) item.xhr.abort(); render(); schedule(); } }
  function resume(id) { const item = find(id); if (item && ['paused', 'error'].includes(item.status)) { item.status = 'queued'; item.error = ''; schedule(); } }
  async function cancel(id) {
    const item = find(id);
    if (!item) return;
    const wasRunning = ['uploading', 'running', 'queued', 'paused', 'error'].includes(item.status);
    if (item.kind === 'upload') {
      item.status = 'cancelled'; item.error = 'Отменено';
      if (item.xhr) item.xhr.abort();
      if (item.sessionId && wasRunning) { try { await api('/uploads/' + item.sessionId, { method: 'DELETE', node: item.node }); } catch { /* сессия уже удалена */ } }
    } else if (item.kind === 'download') { item.abort.abort(); }
    else if (item.kind === 'job' && item.jobKind === 'transfer') { try { await api('/transfer/' + item.jobId, { method: 'DELETE', node: item.node }); } catch { /* уже завершено */ } }
    render();
    schedule();
  }
  const remove = id => { const i = items.findIndex(item => item.id === id); if (i >= 0 && !['uploading', 'running'].includes(items[i].status)) items.splice(i, 1); render(); };
  const clearFinished = () => { for (let i = items.length - 1; i >= 0; i--) if (['done', 'cancelled'].includes(items[i].status)) items.splice(i, 1); render(); };

  /* ---------- панель ---------- */
  const STATUS_TEXT = { queued: 'В очереди', uploading: 'Загрузка', paused: 'Пауза', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено', running: 'Выполняется' };

  function rowHtml(item) {
    const percent = item.size ? Math.min(100, Math.floor(item.done / item.size * 100)) : (item.status === 'done' ? 100 : 0);
    const active = ['uploading', 'running'].includes(item.status);
    const eta = active ? etaText(item) : '';
    const sizeText = item.size ? `${fmtSize(item.done)} из ${fmtSize(item.size)}` : '';
    const speedText = active && item.speed ? ` · ${fmtSize(item.speed)}/с` : '';
    const detail = item.status === 'error' || item.status === 'cancelled' ? esc(item.error) : [sizeText, speedText.slice(3), eta && 'осталось ' + eta, item.note].filter(Boolean).map(esc).join(' · ');
    const icon = { upload: '⬆', download: '⬇', job: item.jobKind === 'extract' ? '🗜' : '⧉' }[item.kind];
    const buttons = [];
    if (item.status === 'uploading') buttons.push(['pause', '⏸', 'Пауза']);
    if (['paused', 'error'].includes(item.status) && item.kind === 'upload') buttons.push(['resume', '▶', 'Продолжить']);
    if (!['done', 'cancelled'].includes(item.status) && !(item.kind === 'job' && item.jobKind === 'extract')) buttons.push(['cancel', '✕', 'Отменить']);
    if (['done', 'cancelled', 'error'].includes(item.status)) buttons.push(['remove', '🗑', 'Убрать из списка']);
    return `<div class="tr tr-${item.status}"><div class=trtop><span class=trname title="${esc(item.name)}">${icon} ${esc(item.name)}</span><span class=trstatus>${STATUS_TEXT[item.status] || ''}</span>
      <span class=tract>${buttons.map(([action, label, title]) => `<button class=trbtn data-tr="${action}" data-id="${item.id}" title="${title}">${label}</button>`).join('')}</span></div>
      <div class=pbar><i class="${active && !item.size ? 'busy' : ''}" style="width:${percent}%"></i></div><small class=muted>${detail}</small></div>`;
  }

  function render() {
    let box = document.getElementById('transferPanel');
    if (!items.length) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'transferPanel';
      box.addEventListener('click', event => {
        const button = event.target.closest('[data-tr]');
        if (button) { const id = Number(button.dataset.id); ({ pause, resume, cancel, remove })[button.dataset.tr](id); return; }
        if (event.target.closest('[data-tr-toggle]')) { panelOpen = !panelOpen; render(); }
        if (event.target.closest('[data-tr-clear]')) clearFinished();
      });
      document.body.append(box);
    }
    const running = items.filter(item => ['uploading', 'running', 'queued'].includes(item.status)).length;
    box.innerHTML = `<div class=trhead data-tr-toggle><b>Передачи</b> <span class=muted>${running ? `активно: ${running}` : 'все завершены'} · всего ${items.length}</span><span class=tract><button class=trbtn data-tr-clear title="Убрать завершённые">Очистить</button><button class=trbtn>${panelOpen ? '▾' : '▴'}</button></span></div>${panelOpen ? `<div class=trlist>${items.slice().reverse().map(rowHtml).join('')}</div>` : ''}`;
  }

  window.addEventListener('beforeunload', event => { if (items.some(item => ['uploading', 'queued'].includes(item.status))) { event.preventDefault(); event.returnValue = ''; } });

  return { upload, download, trackJob, isBusy, ticketUrl };
})();

/** Скачивание «как ссылка» для резервных копий и логов (без сохранения в файл через API браузера). */
function downloadByTicket(query) { Transfers.download(query, {}); }
