'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits:0}).format(Number(value) || 0) + ' ₽';
const statusNames = {draft:'Черновик',checking:'Проверка',manual_review:'На рассмотрении',needs_info:'Нужно уточнение',approved:'Одобрено',rejected:'Отказ',signed:'Подписано',funded:'Выдано · демо'};
const riskNames = {low:'низкий',medium:'средний',high:'высокий'};
const badge = status => `<span class="badge ${esc(status)}">${esc(statusNames[status] || status)}</span>`;
let user = null, products = [], profiles = [], applications = [], current = null, preview = null, stress = null, busy = false, noticeTimer;
const editable = () => user?.role === 'client' && (!current || ['draft','needs_info'].includes(current.status));
const clarificationTemplates = {
  overdue: 'Поясните причину и текущий статус просрочки: когда она возникла и погашена ли сейчас.',
  revenue: 'Уточните среднемесячную выручку и период расчёта. Поясните, есть ли сезонные колебания.',
  company: 'Подтвердите сведения о компании: проверьте ИНН и поясните её текущий статус и вид деятельности.'
};
function nextStep(status) {
  return {
    draft: 'Следующий шаг — клиент: проверить параметры, дать согласие и отправить заявку.',
    checking: 'Следующий шаг — система: завершить учебные проверки и обновить результат.',
    manual_review: 'Следующий шаг — банк: изучить причины и пояснения, принять решение или запросить уточнение.',
    needs_info: 'Следующий шаг — клиент: ответить на последнюю просьбу банка и повторно отправить эту же заявку.',
    approved: 'Следующий шаг — клиент: ознакомиться с учебным предложением и имитировать принятие условий.',
    rejected: 'Рассмотрение завершено. Клиент может изучить причины и создать новую заявку с другими параметрами.',
    signed: 'Следующий шаг — система: завершить имитацию выдачи.',
    funded: 'Путь заявки завершён: подписание и выдача смоделированы.'
  }[status] || '';
}
function notify(message, error = false) {
  const notice = $('#notice'); notice.textContent = message; notice.className = 'notice' + (error ? ' error' : ''); notice.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice.hidden = true; }, error ? 9000 : 4500);
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, {method, credentials:'same-origin', headers:data === undefined ? {} : {'Content-Type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
  return result;
}
async function act(fn) {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await fn(); } catch (error) { notify(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
function renderSession() {
  $('#login-screen').hidden = !!user; $('#workspace').hidden = !user;
  $('#session').innerHTML = user ? `<span>${user.role === 'bank' ? 'Банк · аналитик' : 'Клиент · ' + esc(user.username)}</span><button id="logout">Выйти</button>` : '<span class="small muted">Прототип / 2026</span>';
  if (user) $('#logout').onclick = () => act(async () => {
    await api('/api/logout','POST',{}); user = null; current = null; preview = null; stress = null; applications = [];
    $('#workspace').innerHTML = ''; $('#notice').hidden = true; renderSession();
  });
}
async function enter() {
  [products, profiles, applications] = await Promise.all([api('/api/products').then(r => r.products), api('/api/demo-profiles').then(r => r.profiles), api('/api/applications').then(r => r.applications)]);
  current = null; preview = null; stress = null; renderSession();
  $('#workspace').innerHTML = `<div class="workspace-heading"><div><span class="eyebrow">${user.role === 'bank' ? 'РАБОЧЕЕ МЕСТО БАНКА' : 'ВАШ БИЗНЕС. ПОНЯТНЫЕ ВОЗМОЖНОСТИ.'}</span><h1>${user.role === 'bank' ? 'Заявки на рассмотрении' : 'Кредитный кабинет'}</h1><p>${user.role === 'bank' ? 'Проверки, причины решения и история — в одной заявке.' : 'Начните с параметров. Решение можно предварительно проверить.'}</p></div>${user.role === 'client' ? '<button class="accent" id="new">+ Новая заявка</button>' : ''}</div><div class="workspace-grid"><aside class="sidebar"><div class="sidebar-title"><b>${user.role === 'bank' ? 'Все заявки' : 'Мои заявки'}</b><span class="count" id="count"></span></div><nav class="application-list" id="application-list" aria-label="Заявки"></nav></aside><section class="detail card" id="detail"></section></div>`;
  if ($('#new')) $('#new').onclick = () => { current = null; preview = null; stress = null; renderList(); renderDetail(); };
  renderList(); renderDetail();
}
function renderList() {
  $('#count').textContent = applications.length;
  $('#application-list').innerHTML = applications.length ? applications.map(app => `<button class="application-item ${current?.id === app.id ? 'selected' : ''}" data-id="${esc(app.id)}"><strong>${esc(app.data.company_name)}</strong>${badge(app.status)}<span class="item-meta"><span>${money(app.data.amount)}</span><span>№ ${esc(String(app.id).slice(0,8))}</span></span></button>`).join('') : '<div class="empty">Здесь появятся ваши заявки. Черновик можно сохранить и продолжить позже.</div>';
  $('#application-list').querySelectorAll('button').forEach(button => { button.onclick = () => act(async () => {
    current = await api('/api/applications/' + encodeURIComponent(button.dataset.id)); preview = null; stress = null; renderList(); renderDetail();
  }); });
}
function field(name, title, value, type = 'number', extra = '') {
  return `<label>${title}<input name="${name}" type="${type}" value="${esc(value)}" ${extra} ${editable() ? '' : 'disabled'}></label>`;
}
function blank() {
  return {company_name:'',tax_id:'',product_id:products[0]?.id || '',amount:500000,term_months:12,purpose:'',revenue_monthly:500000,expenses_monthly:300000,existing_payment:0,business_months:24,consent:false,clarification:''};
}
function renderDetail(d = current?.data || blank()) {
  if (!current && user.role === 'bank') { $('#detail').innerHTML = '<div class="empty"><h2>Выберите заявку слева</h2>Заявки с пограничным результатом поступают на ручное рассмотрение. Клиенты видят решения и запросы уточнений в своём кабинете.</div>'; return; }
  const edit = editable(), product = products.find(p => p.id === d.product_id) || products[0];
  const lastNote = [...(current?.events || [])].reverse().find(event => event.status === 'needs_info' && event.actor === 'analyst')?.note;
  $('#detail').innerHTML = `<div class="detail-header"><h2>${current ? esc(d.company_name) : 'Новая заявка'}</h2>${badge(current?.status || 'draft')}</div>
    <p class="next-step">${esc(nextStep(current?.status || 'draft'))}</p>
    ${current?.status === 'needs_info' ? `<div class="pending-note"><b>Банк просит уточнение</b><br>${esc(lastNote || 'Проверьте данные и добавьте пояснение ниже.')}</div>` : ''}
    ${current?.status === 'funded' ? '<div class="funded-note"><b>Демонстрационная выдача завершена.</b> Деньги не переводились, юридические документы не подписывались.</div>' : ''}
    <form id="application-form"><div class="form-grid"><div>
    ${edit && !current ? `<label class="profile-select">Быстрый старт на синтетических данных<select id="demo-profile"><option value="">Заполнить самостоятельно</option>${profiles.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select><span class="field-note" id="profile-description">Можно выбрать готовый пример и изменить параметры.</span></label>` : ''}
    <section class="form-section"><h3><span class="section-number">01</span> Бизнес</h3><div class="fields">
      ${field('company_name','Название компании',d.company_name,'text','required minlength="2" maxlength="120"')}
      ${field('tax_id','ИНН · синтетический',d.tax_id,'text','required pattern="[0-9]{10}([0-9]{2})?" inputmode="numeric" title="10 или 12 цифр"')}
      ${field('business_months','Возраст бизнеса, мес.',d.business_months,'number','required min="0" max="1200" step="1"')}
    </div></section>
    <section class="form-section"><h3><span class="section-number">02</span> Параметры кредита</h3><div class="fields">
      <label class="wide">Продукт<select name="product_id" ${edit ? '' : 'disabled'}>${products.map(p => `<option value="${esc(p.id)}" ${p.id === d.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><span class="field-note" id="product-note">${esc(product?.description || '')} · Учебная ставка ${esc(product?.annual_rate ?? '—')}% годовых</span></label>
      ${field('amount','Сумма, ₽',d.amount,'number',`required min="${product.min_amount}" max="${product.max_amount}" step="0.01"`)}
      ${field('term_months','Срок, мес.',d.term_months,'number',`required min="${product.min_term}" max="${product.max_term}" step="1"`)}
      <label class="wide">Цель кредита<textarea name="purpose" required minlength="5" maxlength="500" ${edit ? '' : 'disabled'}>${esc(d.purpose)}</textarea></label>
    </div></section>
    <section class="form-section"><h3><span class="section-number">03</span> Финансы в среднем за месяц</h3><div class="fields">
      ${field('revenue_monthly','Выручка, ₽',d.revenue_monthly,'number','required min="0" max="10000000000" step="0.01"')}
      ${field('expenses_monthly','Операционные расходы, ₽',d.expenses_monthly,'number','required min="0" max="10000000000" step="0.01"')}
      ${field('existing_payment','Платежи по другим кредитам, ₽',d.existing_payment,'number','required min="0" max="10000000000" step="0.01"')}
      <p class="field-note">Расходы укажите без кредитных платежей, чтобы не учитывать их дважды.</p>
    </div></section>
    ${current?.status === 'needs_info' || d.clarification ? `<label>Ответ клиента банку<textarea name="clarification" maxlength="2000" ${edit ? '' : 'disabled'} placeholder="Ответьте на запрос банка — от 10 символов при отправке">${esc(d.clarification)}</textarea></label>` : '<input type="hidden" name="clarification" value="">'}
    <label class="check-label"><input type="checkbox" name="consent" ${d.consent ? 'checked' : ''} ${edit ? '' : 'disabled'}><span>Разрешаю обработать указанные данные в рамках учебной демонстрации. Использую синтетические данные.</span></label>
    ${edit ? `<div class="form-actions"><button type="button" id="save">${current?.status === 'needs_info' ? 'Сохранить ответ' : 'Сохранить черновик'}</button><button type="submit" class="primary">${current?.status === 'needs_info' ? 'Отправить ответ банку →' : 'Отправить в банк →'}</button></div><p class="small muted compact-note">Предпросмотр не отправляет заявку. Перед отправкой данные сохранятся.</p>` : ''}
    </div><aside class="insight"><span class="eyebrow">ПОНЯТНОЕ РЕШЕНИЕ</span><h3>${edit ? 'Что изменить?' : 'Почему такое решение?'}</h3><p>${edit ? 'Посмотрите результат до подачи заявки. Меняйте сумму и срок — сравнивайте сценарии.' : 'Проверки и причины доступны клиенту и банку.'}</p>${edit ? '<button class="accent full preview-button" type="button" id="preview">Проверить параметры <span aria-hidden="true">↗</span></button>' : ''}<div id="assessment"></div>${edit ? '<section class="stress-test"><h4>А если выручка упадёт?</h4><p class="small muted">Сценарий, не прогноз: уменьшаем только выручку; расходы и платежи по долгам фиксированы.</p><div class="scenario-buttons"><button type="button" data-stress="10">Выручка −10%</button><button type="button" data-stress="20">Выручка −20%</button></div><div id="stress-result" aria-live="polite"></div></section>' : ''}</aside></div></form>
    ${user.role === 'bank' && current?.status === 'manual_review' ? '<section class="bank-actions"><h3>Решение аналитика</h3><p class="small muted">Шаблон заполняет комментарий. Отредактируйте его перед отправкой клиенту.</p><div class="template-buttons"><button type="button" data-template="overdue">Пояснить просрочку</button><button type="button" data-template="revenue">Уточнить выручку</button><button type="button" data-template="company">Подтвердить сведения о компании</button></div><label>Комментарий клиенту<textarea id="decision-note" minlength="10" maxlength="2000" placeholder="Объясните решение или укажите, что нужно уточнить — от 10 символов"></textarea></label><div class="form-actions"><button type="button" data-decision="approve" class="primary">Одобрить</button><button type="button" data-decision="request_info">Запросить уточнение</button><button type="button" data-decision="reject" class="danger">Отказать</button></div></section>' : ''}
    ${user.role === 'client' && current?.status === 'approved' ? '<section class="bank-actions"><h3>Предложение готово</h3><p class="small muted">Кнопка имитирует подписание предложения и выдачу кредита. Реальной подписи и перевода денег не будет.</p><button type="button" id="accept" class="primary">Принять условия и имитировать выдачу</button></section>' : ''}
    ${current ? `<section class="history"><h3>История заявки</h3><ol>${(current.events || []).slice().reverse().map(event => `<li><time>${esc(new Date(event.at).toLocaleString('ru-RU'))} · ${esc(event.actor)}</time><b>${esc(statusNames[event.status] || event.status)}</b>${event.note ? `<p>${esc(event.note)}</p>` : ''}</li>`).join('')}</ol></section>` : ''}`;
  renderAssessment(preview || current?.assessment);
  renderStress();
  bindDetail();
}
function readForm() {
  const form = $('#application-form'), data = Object.fromEntries(new FormData(form));
  ['amount','term_months','revenue_monthly','expenses_monthly','existing_payment','business_months'].forEach(key => { data[key] = Number(data[key]); });
  data.consent = form.elements.consent.checked;
  return data;
}
function valid() { return $('#application-form').reportValidity(); }
function renderAssessment(assessment) {
  const root = $('#assessment'); if (!root) return;
  if (!assessment) { root.innerHTML = '<p class="small muted">Здесь появятся ежемесячный платёж, причины решения и возможный следующий шаг.</p>'; return; }
  const {score = {}, decision = {}, alternative, bank_decision} = assessment;
  const isPreview = assessment === preview;
  const actualStatus = isPreview ? decision.status : current?.status || decision.status;
  const offer = bank_decision?.offer || decision.offer;
  const registry = {active:'Компания активна',inactive:'Компания неактивна',unknown:'Компания не подтверждена'}[assessment.checks?.registry_status] || 'Нет проверки';
  const reasons = [...new Set([...(decision.reasons || []), ...(score.reasons || [])])];
  const payment = offer?.monthly_payment ?? score.monthly_payment;
  root.innerHTML = `<div class="assessment"><span class="small muted">${isPreview ? 'Предварительный результат · не решение банка' : 'Результат рассмотрения'}</span><h3>${esc(statusNames[actualStatus] || 'Оценка готова')}</h3>${bank_decision && !isPreview ? `<p class="human-decision"><b>Комментарий сотрудника:</b> ${esc(bank_decision.note)}</p>` : ''}${offer ? `<p class="small">${money(offer.amount)} · ${esc(offer.term_months)} мес. · ${esc(offer.annual_rate)}% годовых (учебная ставка)</p>` : ''}${payment != null ? `<div class="metric"><span>Ориентировочный платёж в месяц</span><strong>${money(payment)}</strong></div>` : ''}<p class="small muted">Факторы автоматической оценки:</p><ul class="reason-list">${reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>
    ${alternative ? `<div class="alternative"><h4>Возможный следующий шаг</h4><p><b>${money(alternative.amount)} на ${esc(alternative.term_months)} мес.</b><br>${money(alternative.monthly_payment)} в месяц<br>Сумма платежей ≈ ${money(alternative.monthly_payment * alternative.term_months)}</p><p>Больший срок может увеличить общую выплату. Это учебный расчёт без комиссий.</p><p>${esc(alternative.explanation || 'Проверьте результат с другими параметрами.')}</p>${editable() ? '<button type="button" id="apply-alternative">Подставить и проверить →</button>' : ''}</div>` : ''}
    <div class="score-meta"><span>Учебный балл: ${esc(score.score ?? '—')}/100</span><span>Риск: ${esc(riskNames[score.risk] || score.risk || '—')}</span></div><details class="small compact-note"><summary>Источники и правила</summary><p>${esc(registry)}. Просрочка: ${assessment.checks?.overdue_days == null ? 'нет данных' : esc(assessment.checks.overdue_days) + ' дн.'}. Источник: локальный симулятор. Версия: ${esc(score.version)}.</p></details><p class="small muted compact-note">Учебные правила, не обученная ML-модель. Балл не является вероятностью дефолта. Реального предложения банка нет.</p></div>`;
  if ($('#apply-alternative')) $('#apply-alternative').onclick = () => act(async () => {
    const form = $('#application-form'); form.elements.amount.value = alternative.amount; form.elements.term_months.value = alternative.term_months;
    await makePreview(); notify('Параметры подставлены. Это предпросмотр; заявка ещё не отправлена.');
  });
}
async function makePreview() {
  if (!valid()) return;
  const data = readForm(), result = await api('/api/preview','POST',data);
  if (JSON.stringify(data) !== JSON.stringify(readForm())) return;
  preview = result; stress = null; renderAssessment(preview); renderStress();
}
function renderStress() {
  const root = $('#stress-result'); if (!root) return;
  if (!stress) { root.innerHTML = ''; return; }
  const rows = [['Результат', statusNames[stress.base.decision.status], statusNames[stress.result.decision.status]],
    ['Свободный поток', money(stress.base.score.features.free_cash_flow), money(stress.result.score.features.free_cash_flow)],
    ['Покрытие платежа', stress.base.score.features.payment_coverage.toFixed(2) + '×', stress.result.score.features.payment_coverage.toFixed(2) + '×']];
  root.innerHTML = `<table class="stress-table"><caption>Выручка −${stress.percent}% · данные заявки не изменены</caption><thead><tr><th>Показатель</th><th>Сейчас</th><th>Сценарий</th></tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="small muted">Покрытие ниже 1×: свободного потока не хватает на новый платёж. Доходы и расходы введены пользователем.</p>`;
}
async function save() {
  const data = readForm(); current = await api('/api/applications' + (current ? '/' + encodeURIComponent(current.id) : ''), current ? 'PUT' : 'POST', data);
  await refreshList(); return current;
}
async function refreshList() {
  applications = (await api('/api/applications')).applications; renderList();
}
function bindDetail() {
  const form = $('#application-form');
  if ($('#demo-profile')) $('#demo-profile').onchange = event => {
    const selected = profiles.find(profile => profile.id === event.target.value); if (!selected) return;
    preview = null; stress = null; renderDetail({...blank(), ...selected.application}); $('#demo-profile').value = selected.id;
    $('#profile-description').textContent = selected.description;
  };
  if (!editable()) form.onsubmit = event => event.preventDefault();
  else {
    form.addEventListener('input', () => { preview = null; stress = null; renderAssessment(null); renderStress(); });
    form.elements.product_id.onchange = () => {
      const product = products.find(p => p.id === form.elements.product_id.value);
      $('#product-note').textContent = `${product.description} · Учебная ставка ${product.annual_rate}% годовых`;
      form.elements.amount.min = product.min_amount; form.elements.amount.max = product.max_amount;
      form.elements.term_months.min = product.min_term; form.elements.term_months.max = product.max_term;
    };
    $('#preview').onclick = () => act(makePreview);
    document.querySelectorAll('[data-stress]').forEach(button => { button.onclick = () => act(async () => {
      if (!valid()) return;
      const data = readForm(), percent = Number(button.dataset.stress);
      const [base, result] = await Promise.all([api('/api/preview','POST',data), api('/api/preview','POST',{...data, revenue_monthly:Math.round(data.revenue_monthly * (1-percent/100) * 100)/100})]);
      if (JSON.stringify(data) !== JSON.stringify(readForm())) return;
      preview = base; stress = {percent,base,result}; renderAssessment(preview); renderStress();
    }); });
    $('#save').onclick = () => act(async () => { if (!valid()) return; await save(); renderDetail(); notify('Данные сохранены.'); });
    form.onsubmit = event => { event.preventDefault(); act(async () => {
      if (!valid()) return;
      if (!form.elements.consent.checked) { notify('Для отправки подтвердите согласие на обработку демо-данных.', true); form.elements.consent.focus(); return; }
      await save(); current = await api('/api/applications/' + encodeURIComponent(current.id) + '/submit','POST',{});
      preview = null; stress = null; await refreshList(); renderDetail(); notify('Заявка отправлена. Результат и история обновлены.');
    }); };
  }
  document.querySelectorAll('[data-template]').forEach(button => { button.onclick = () => {
    $('#decision-note').value = clarificationTemplates[button.dataset.template]; $('#decision-note').focus();
  }; });
  document.querySelectorAll('[data-decision]').forEach(button => { button.onclick = () => act(async () => {
    const note = $('#decision-note').value.trim(); if (note.length < 10) { notify('Добавьте понятный комментарий от 10 символов.', true); $('#decision-note').focus(); return; }
    current = await api('/api/applications/' + encodeURIComponent(current.id) + '/decision','POST',{action:button.dataset.decision,note});
    preview = null; await refreshList(); renderDetail(); notify('Решение сохранено и доступно клиенту.');
  }); });
  if ($('#accept')) $('#accept').onclick = () => act(async () => {
    current = await api('/api/applications/' + encodeURIComponent(current.id) + '/accept','POST',{});
    await refreshList(); renderDetail(); notify('Подписание и выдача имитированы. Реального перевода денег нет.');
  });
}
$('#login-form').onsubmit = event => { event.preventDefault(); act(async () => {
  const data = Object.fromEntries(new FormData(event.target)); user = (await api('/api/login','POST',data)).user; await enter();
}); };
setInterval(async () => {
  if (!user || busy || document.hidden) return;
  try {
    await refreshList();
    const fresh = applications.find(app => app.id === current?.id);
    if (fresh && fresh.updated_at !== current.updated_at && !editable() && !$('#decision-note')?.value) {
      current = fresh; preview = null; renderDetail();
    }
  } catch (_) { /* The next explicit action reports a connection error. */ }
}, 10000);
(async () => { try { user = (await api('/api/me')).user; if (user) await enter(); else renderSession(); } catch (_) { user = null; renderSession(); } })();
