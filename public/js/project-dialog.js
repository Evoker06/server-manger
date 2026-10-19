// «Использовать проект»: из выбранной папки или файла в разделе «Файлы» — к созданию приложения.
// Панель только читает файлы проекта, предлагает варианты запуска и открывает обычный конструктор запуска с подставленными значениями.
// Ничего не запускается автоматически, а приложение создаётся только после вашего подтверждения в конструкторе.
const PROJECT_CONFIDENCE = { high: ['Рекомендуется', 'ok'], medium: ['Возможно', 'warn'], low: ['Маловероятно', 'muted'] };

async function fmUseProject(path) {
  if (!can('apps.create')) return toast('Нет разрешения на создание приложений', true);
  try {
    const result = await api('/projects/analyze', { method: 'POST', headers: JH, body: JSON.stringify({ path, ...fmScopeBody() }) });
    showProjectDialog(result);
  } catch (error) { toast(error.message, true); }
}

function projectCandidateHtml(candidate, index) {
  const [label, tone] = PROJECT_CONFIDENCE[candidate.confidence] || PROJECT_CONFIDENCE.low;
  const warnings = (candidate.warnings || []).map(text => `<div class=hint style="margin-top:6px">⚠ ${esc(text)}</div>`).join('');
  const runtime = candidate.runtimeMessage ? `<div class="${candidate.runtimeOk ? 'muted' : 'err'}" style="margin-top:4px">${esc(candidate.runtimeMessage)}</div>` : '';
  const preview = candidate.preview ? `<details style="margin-top:6px"><summary class=muted>Показать начало скрипта</summary><pre class=cmdprev>${esc(candidate.preview)}</pre></details>` : '';
  return `<label class=scanitem><input type=radio name=projcand value="${index}" ${index === 0 ? 'checked' : ''}>
    <div><b>${esc(candidate.label)}</b> <span class="pfbadge ${tone}">${label}</span>
    ${candidate.command ? `<code class=cmdline title="${esc(candidate.command)}">${esc(candidate.command)}</code>` : ''}
    ${candidate.details ? `<small>${esc(candidate.details)}</small>` : ''}${runtime}${warnings}${preview}</div></label>`;
}

function showProjectDialog(result) {
  const candidates = result.candidates || [];
  const body = candidates.length
    ? `<p class=muted>Найдено способов запуска: ${candidates.length}. Выберите подходящий — его можно будет изменить в конструкторе.</p><div class=scanlist>${candidates.map(projectCandidateHtml).join('')}</div>`
    : '<div class=hint>Тип проекта определить автоматически не удалось — в папке не найдено файлов запуска. Вы можете настроить запуск вручную.</div>';
  modal('Использовать проект: ' + result.name, `<div class=form><div class=fmwhere>Папка проекта: <code>${esc(result.directory)}</code>${result.port ? ` · порт: ${result.port}` : ''}</div>${body}
    <div class=actions>${candidates.length ? '<button class=primary id=projNext>Продолжить</button>' : ''}<button class=btn id=projManual>Настроить вручную</button><button class=btn id=projCancel>Отмена</button></div></div>`);
  if ($('projNext')) $('projNext').onclick = () => {
    const chosen = document.querySelector('input[name=projcand]:checked');
    openConstructorForProject(result, candidates[chosen ? Number(chosen.value) : 0]);
  };
  $('projManual').onclick = () => openConstructorForProject(result, null);
  $('projCancel').onclick = closeModal;
}

/** Открывает конструктор запуска с подставленными значениями (приложение создаётся обычным способом). */
function openConstructorForProject(result, candidate) {
  const prefill = { name: result.name, working_dir: result.directory, port: result.port || '', env_json: '{}' };
  if (candidate) {
    Object.assign(prefill, { launch_json: candidate.launch && candidate.launch.preset !== 'custom' ? JSON.stringify(candidate.launch) : '', command: candidate.preset === 'custom' ? candidate.command : '', runtime_path: candidate.runtimePath || '' });
  }
  modal('Новое приложение из проекта', '<div id=lb></div>');
  lbMount(prefill);
}
