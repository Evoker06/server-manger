// Страница «Система»: процессор, память, диски.

/* ---------- Система: процессор, видеокарта, память, накопители ---------- */
function hwSize(n) {
  if (n == null)
    return '—';
  const gb = n / 1073741824;
  if (gb >= 1024)
    return (gb / 1024).toFixed(2) + ' ТБ';
  if (gb >= 1)
    return gb.toFixed(gb >= 100 ? 0 : 1) + ' ГБ';
  return Math.max(0, Math.round(n / 1048576)) + ' МБ';
}
const hwNA = (why) => `<span class=muted title="${esc(why || 'Система или оборудование не сообщают это значение')}">Недоступно</span>`;
const hwCls = p => p >= 90 ? 'crit' : p >= 75 ? 'warn' : '';
const hwId = m => 'hw_' + String(m).replace(/[^A-Za-z0-9]/g, '_');
const hwPct = v => v == null ? null : Math.max(0, Math.min(100, v));
const hwMeter = (id, p) => `<div class=meter><i id="${id}" class="${hwCls(p)}" style="width:${hwPct(p) || 0}%"></i></div>`;
const hwHz = m => m == null ? null : (m >= 1000 ? (m / 1000).toFixed(2) + ' ГГц' : m + ' МГц');
let hwState = { sig: '', tick: 0, busy: false, auto: true };
function hwDiskSig(d) {
  return JSON.stringify([d.disks.map(x => [x.id, x.name, x.status, x.partitions.map(p => p.mount)]), d.others.map(p => p.mount)]);
}
function hwTypeBadge(t) {
  return `<span class="dtype t-${t === 'Не определён' ? 'na' : t}" title="${t === 'Не определён' ? 'Тип невозможно определить надёжно — панель не угадывает его по букве диска или скорости' : 'Тип определён по данным операционной системы'}">${esc(t)}</span>`;
}
function hwHealth(d) {
  const t = d.temperature != null ? `${Math.round(d.temperature)} °C` : null, h = d.health;
  const hb = h ? `<span class="hbadge ${d.smart && d.smart.status === 'ok' ? 'ok' : d.smart && d.smart.status === 'warn' ? 'warn' : 'bad'}" title="${esc(d.smart && d.smart.note || '')}">${esc(h)}</span>` : `<span title="${esc(d.smart && d.smart.note || '')}">${hwNA(d.smart && d.smart.note)}</span>`;
  return `<div class=dmeta><span>Состояние / SMART: ${hb}</span><span>Температура: ${t || hwNA('Датчик температуры недоступен или нужны права администратора')}</span>${d.powerOnHours != null ? `<span>Наработка: ${Math.round(d.powerOnHours)} ч</span>` : ''}</div>`;
}
function hwPartRow(p) {
  const id = hwId(p.mount), kindRu = { fixed: '', removable: 'съёмный', network: 'сетевой', optical: 'оптический', other: 'прочий' }[p.kind] || '';
  const bar = p.accessible && p.percent != null ? `${hwMeter(id + '_b', p.percent)}<small id="${id}_t" class=muted>${hwSize(p.used)} занято из ${hwSize(p.size)} · свободно <b>${hwSize(p.free)}</b> (${p.percent}%)</small>` : `<small class=muted>${esc(p.note || 'Нет данных об объёме')}</small>`;
  const open = can('files.disks') && can('files.view') && p.accessible && p.kind !== 'optical' ? `<button class=btn onclick="filesOpenDisk(${jsArg(p.mount)})" title="Открыть файлы этого раздела">Открыть файлы</button>` : '';
  return `<div class=partrow><div><b>${esc(p.mount)}</b> ${p.label ? esc(p.label) : ''}<br><small class=muted>${esc(p.fs || '')} ${kindRu ? '· ' + kindRu : ''} ${p.system ? '· системный' : ''} ${p.readOnly ? '· только чтение' : ''}</small></div><div>${bar}</div><div>${open}</div></div>`;
}
function hwDiskCards(d) {
  const disks = d.disks.map(k => `<div class="hwcard diskcard ${k.status !== 'ok' ? 'off' : ''}"><div class=split><div><h3>${esc(k.name)}</h3><small class=muted>${k.bus ? esc(k.bus) + ' · ' : ''}${k.removable ? 'съёмный · ' : ''}${esc(k.id)}</small></div><div class=dbadges>${hwTypeBadge(k.type)}<span class=dsize>${hwSize(k.size)}</span></div></div>${k.typeNote ? `<small class=muted>${esc(k.typeNote)}</small>` : ''}${k.statusNote ? `<div class=hint style="margin:8px 0">${esc(k.statusNote)}</div>` : ''}${hwHealth(k)}${k.partitions.length ? k.partitions.map(hwPartRow).join('') : `<div class=partrow><small class=muted>${k.status === 'offline' ? 'Диск отключён — разделы недоступны' : 'Нет смонтированных разделов, доступных для работы'}</small></div>`}</div>`).join('');
  const others = d.others.length ? `<div class="hwcard diskcard"><h3>Сетевые и прочие тома</h3><small class=muted>Тома, не привязанные к физическому диску этого компьютера</small>${d.others.map(hwPartRow).join('')}</div>` : '';
  return disks + others || '<div class=empty>Накопители не обнаружены</div>';
}
function hwCpuCard(i) {
  const c = i.cpu;
  return `<div class=hwcard><div class=split><h3>Процессор (CPU)</h3><span id=hw_cpu_val class=hwbig>—</span></div><b>${esc(c.model || 'Модель не определена')}</b>
  <div class=kv><span>Ядра / потоки</span><span>${c.physicalCores ? c.physicalCores + ' физ.' : hwNA('Число физических ядер не сообщается')} · ${c.logicalCores || '—'} потоков${c.sockets > 1 ? ` · процессоров: ${c.sockets}` : ''}</span>
  <span>Частота</span><span id=hw_cpu_mhz title="" >—</span>
  ${c.maxMHz ? `<span>Максимум</span><span>${hwHz(c.maxMHz)}</span>` : ''}${c.cache ? `<span>Кэш</span><span>${esc(c.cache)}</span>` : ''}
  <span>Температура</span><span id=hw_cpu_temp>—</span></div>${hwMeter('hw_cpu_bar', 0)}
  <details class=hwdet><summary>Загрузка по потокам</summary><div id=hw_cores class=cores></div></details></div>`;
}
function hwRamCard(i) {
  return `<div class=hwcard><div class=split><h3>Оперативная память (RAM)</h3><span id=hw_ram_val class=hwbig>—</span></div><b>Всего ${hwSize(i.ram.total)}</b>${hwMeter('hw_ram_bar', 0)}<div class=kv><span>Занято</span><span id=hw_ram_used>—</span><span>Свободно</span><span id=hw_ram_free>—</span><span id=hw_swap_l class=hidden>Подкачка</span><span id=hw_swap class=hidden></span></div></div>`;
}
function hwGpuCards(i) {
  if (!i.gpus.length)
    return `<div class=hwcard><h3>Видеокарта (GPU)</h3><div class=muted>Видеокарты не обнаружены или система их не сообщает. Это не ошибка.</div></div>`;
  return i.gpus.map((g, n) => `<div class="hwcard ${g.virtual ? 'virt' : ''}"><div class=split><h3>Видеокарта${i.gpus.length > 1 ? ' №' + (n + 1) : ''}</h3><span id="hw_g${n}_val" class=hwbig>—</span></div><b>${esc(g.name || 'Модель не определена')}</b>${g.virtual ? ' <small class=muted>виртуальный адаптер</small>' : ''}
  <div class=kv><span>Видеопамять</span><span id="hw_g${n}_vram">${g.vramTotal ? hwSize(g.vramTotal) : hwNA('Объём видеопамяти не сообщается')}</span><span>Загрузка GPU</span><span id="hw_g${n}_load">${g.live && g.live.load ? '…' : hwNA('Для этой видеокарты загрузка недоступна: ' + (i.platform === 'win32' ? 'в Windows читается только у NVIDIA' : 'нужен драйвер с поддержкой датчиков'))}</span><span>Температура</span><span id="hw_g${n}_temp">${g.live && g.live.temp ? '…' : hwNA()}</span>${g.driver ? `<span>Драйвер</span><span>${esc(g.driver)}</span>` : ''}</div>${g.live && g.live.load ? hwMeter(`hw_g${n}_bar`, 0) : ''}</div>`).join('');
}
function hwApplyLive(l) {
  const set = (id, h) => {
    const e = $(id);
    if (e)
      e.innerHTML = h;
  }, bar = (id, p) => {
    const e = $(id);
    if (e) {
      e.style.width = (hwPct(p) || 0) + '%';
      e.className = hwCls(p);
    }
  };
  if (l.cpu) {
    set('hw_cpu_val', l.cpu.load != null ? l.cpu.load.toFixed(0) + '%' : '—');
    bar('hw_cpu_bar', l.cpu.load);
    set('hw_cpu_mhz', l.cpu.mhz ? `<span title="${esc(l.cpu.mhzNote || '')}">${hwHz(l.cpu.mhz)}</span>` : hwNA());
    set('hw_cpu_temp', l.cpu.temp != null ? Math.round(l.cpu.temp) + ' °C' : hwNA('Датчик процессора недоступен (нужен доступ к датчикам ОС)'));
    const cs = $('hw_cores');
    if (cs && l.cpu.cores)
      cs.innerHTML = l.cpu.cores.slice(0, 128).map((v, n) => `<div class=core title="Поток ${n + 1}: ${v.toFixed(0)}%"><i class="${hwCls(v)}" style="height:${Math.max(2, v)}%"></i></div>`).join('');
  }
  if (l.ram) {
    const r = l.ram;
    set('hw_ram_val', (r.percent ?? 0).toFixed(0) + '%');
    bar('hw_ram_bar', r.percent);
    set('hw_ram_used', hwSize(r.used));
    set('hw_ram_free', hwSize(r.free));
    if (r.swapTotal) {
      $('hw_swap_l').classList.remove('hidden');
      $('hw_swap').classList.remove('hidden');
      set('hw_swap', `${hwSize(r.swapUsed)} из ${hwSize(r.swapTotal)}`);
    }
  }
  (l.gpus || []).forEach((g, n) => {
    const gi = window._hw.info.gpus[n];
    if (!gi)
      return;
    const lv = gi.live || {};
    if (lv.load) {
      set(`hw_g${n}_val`, g.load != null ? g.load + '%' : '—');
      set(`hw_g${n}_load`, g.load != null ? g.load + '%' : hwNA());
      bar(`hw_g${n}_bar`, g.load);
    }
    else
      set(`hw_g${n}_val`, '');
    if (lv.temp)
      set(`hw_g${n}_temp`, g.temp != null ? Math.round(g.temp) + ' °C' : hwNA());
    if (g.vramTotal)
      set(`hw_g${n}_vram`, g.vramUsed != null ? `${hwSize(g.vramUsed)} из ${hwSize(g.vramTotal)}` : hwSize(g.vramTotal));
  });
}
function hwApplySpace(d) {
  for (const p of [...d.disks.flatMap(x => x.partitions), ...d.others]) {
    const id = hwId(p.mount), b = $(id + '_b'), t = $(id + '_t');
    if (!b || p.percent == null)
      continue;
    b.style.width = p.percent + '%';
    b.className = hwCls(p.percent);
    if (t)
      t.innerHTML = `${hwSize(p.used)} занято из ${hwSize(p.size)} · свободно <b>${hwSize(p.free)}</b> (${p.percent}%)`;
  }
}
function hwDisksSection(d) {
  return `<div class=sectionhead><h3>Накопители (HDD / SSD / NVMe)</h3><div class=actions><label class=checkline style="margin:0" title="Каждые 2 минуты проверять, не подключили ли новый диск"><input type=checkbox id=hwauto ${hwState.auto ? 'checked' : ''} onchange="hwState.auto=this.checked"> искать новые диски автоматически</label><button class=btn id=hwrescan onclick=hwRescan()>⟳ Обновить список дисков</button></div></div>
  ${(d.errors || []).map(e => `<div class=hint style="margin-bottom:10px">⚠ ${esc(e)}</div>`).join('')}<div class=hwgrid id=hwdisks>${hwDiskCards(d)}</div><small class=muted id=hwscan>Список обновлён: ${new Date(d.scannedAt).toLocaleTimeString()}. Объёмы показаны в ГБ/ТБ по 1024 (как в Windows).</small>`;
}
async function hwRescan() {
  const b = $('hwrescan');
  if (b) {
    b.disabled = true;
    b.textContent = 'Сканирую…';
  }
  try {
    const d = await api('/hw/disks?refresh=1');
    fmDisks = d;
    hwState.sig = hwDiskSig(d);
    window._hw.disks = d;
    const box = $('hwdisksec');
    if (box)
      box.innerHTML = hwDisksSection(d);
    toast('Список дисков обновлён');
  }
  catch (e) {
    toast('Не удалось обновить: ' + e.message, true);
    if (b) {
      b.disabled = false;
      b.textContent = '⟳ Обновить список дисков';
    }
  }
}
async function systemPage() {
  clearInterval(statsTimer);
  $('content').innerHTML = '<div class=empty><div class=pbar style="max-width:240px;margin:0 auto 10px"><i class=busy></i></div>Собираю сведения об оборудовании…</div>';
  let info, disks;
  try {
    [info, disks] = await Promise.all([api('/hw/info'), api('/hw/disks')]);
  }
  catch (e) {
    $('content').innerHTML = `<div class=empty>Не удалось получить данные: ${esc(e.message)}<br><br><button class=btn onclick=systemPage()>Повторить</button></div>`;
    return;
  }
  window._hw = { info, disks };
  fmDisks = disks;
  hwState = { sig: hwDiskSig(disks), tick: 0, busy: false, auto: hwState.auto };
  $('content').innerHTML = `<div id=hwroot><div class=hwgrid>${hwCpuCard(info)}${hwRamCard(info)}${hwGpuCards(info)}</div>
  ${info.notes && info.notes.length ? `<details class=hwdet style="margin:6px 0 18px"><summary>О точности данных</summary>${info.notes.map(n => `<div class=muted style="margin:6px 0">• ${esc(n)}</div>`).join('')}<div class=muted style="margin:6px 0">• Если значение не получено, показано «Недоступно» — панель ничего не придумывает.</div></details>` : ''}
  <div id=hwdisksec>${hwDisksSection(disks)}</div><div id=hwerr class=err></div></div>`;
  hwTick(true);
  statsTimer = setInterval(() => hwTick(), 3000);
}
async function hwTick(first) {
  if (!$('hwroot')) {
    clearInterval(statsTimer);
    return;
  }
  if (document.hidden || hwState.busy)
    return;
  hwState.busy = true;
  const n = hwState.tick++;
  try {
    const l = await api('/hw/live?gpu=' + (first || n % 2 === 0 ? 1 : 0));
    hwApplyLive(l);
    $('hwerr').textContent = '';
    if (!first && n % 5 === 0) { // свободное место — раз в ~15 с
      const d = await api('/hw/disks?mode=space');
      window._hw.disks = d;
      hwApplySpace(d);
    }
    if (!first && hwState.auto && n % 40 === 0 && n > 0) { // новые диски — раз в ~2 мин
      const d = await api('/hw/disks');
      if (hwDiskSig(d) !== hwState.sig) {
        hwState.sig = hwDiskSig(d);
        fmDisks = d;
        window._hw.disks = d;
        $('hwdisksec').innerHTML = hwDisksSection(d);
        toast('Список дисков изменился');
      }
    }
  }
  catch (e) {
    const x = $('hwerr');
    if (x)
      x.textContent = 'Не удалось обновить показатели: ' + e.message;
  }
  finally {
    hwState.busy = false;
  }
}
