'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits:0}).format(Number(value) || 0) + ' ₽';
const statusNames = {draft:'Черновик',checking:'Проверка',manual_review:'На рассмотрении',needs_info:'Нужно уточнение',approved:'Одобрено',rejected:'Отказ',signed:'Подписано',funded:'Выдано'};
const riskNames = {low:'низкий',medium:'средний',high:'высокий'};
const badge = status => `<span class="badge ${esc(status)}">${esc(statusNames[status] || status)}</span>`;
let user = null, products = [], profiles = [], applications = [], clients = [], clientProfile = null;
let current = null, preview = null, stress = null, busy = false, noticeTimer, activeView = 'applications';
const bankFilters = {query:'', status:'', client:''};
let creditHelper = {step:0, answers:{}};
const freshAdvisor = () => ({messages:[], productId:null, amount:null, term:null, purpose:'', pending:false, requestId:0, quickReplies:[]});
let advisor = freshAdvisor();
let advisorRequestSequence = 0;
const collateralNames = {
  none:'Без залога', real_estate:'Недвижимость', equipment:'Оборудование', vehicle:'Транспорт',
  deposit:'Денежный депозит', purchased_asset:'Приобретаемый объект', msp_guarantee:'Поручительство Корпорации МСП / РГО'
};
const financialDocumentNames = {accounting:'Бухгалтерская отчётность',tax_declaration:'Налоговая декларация',usn_declaration:'Декларация УСН',management:'Управленческий отчёт'};
const textReplacements = [
  ['Выполнены условия автоматического одобрения учебной политики.', 'Финансовые показатели соответствуют условиям автоматического одобрения.'],
  ['Компания неактивна в синтетическом реестре.', 'По указанным данным компания сейчас не ведёт деятельность.'],
  ['В синтетическом реестре компания неактивна.', 'По указанным данным компания сейчас не ведёт деятельность.'],
  ['Учебная политика не допускает просрочку от 30 дней.', 'Есть просрочка по действующим обязательствам от 30 дней.'],
  ['Синтетическая просрочка составляет 30 дней или больше.', 'Есть просрочка по действующим обязательствам от 30 дней.'],
  ['Обнаружена небольшая синтетическая просрочка.', 'Есть действующая просрочка по обязательствам.'],
  ['Статус компании не подтвержден учебной проверкой.', 'Не удалось подтвердить текущий статус компании.'],
  ['Нет учебных данных о просрочке.', 'Не удалось получить сведения о действующих просрочках.'],
  ['Нужно выяснить обстоятельства учебной просрочки.', 'Специалисту нужно уточнить обстоятельства просрочки.'],
  ['Индекс правил ниже учебного порога 45.', 'Совокупность указанных данных не позволяет одобрить заявку.'],
  ['Индекс правил ниже порога автоматического одобрения 75.', 'Совокупность указанных данных требует дополнительной проверки специалистом.'],
  ['Свободного денежного потока не хватает на новый платеж.', 'После указанных расходов денег недостаточно для нового ежемесячного платежа.'],
  ['Запас свободного потока меньше 1,5 нового платежа.', 'После расходов остаётся небольшой запас для нового ежемесячного платежа.'],
  ['Свободный поток покрывает менее двух новых платежей.', 'После расходов остаётся ограниченный запас для нового ежемесячного платежа.'],
  ['Свободный поток покрывает не менее двух новых платежей.', 'Доходов достаточно для нового платежа с финансовым запасом.'],
  ['Бизнес работает меньше 6 месяцев.', 'Компания работает меньше 6 месяцев, поэтому требуется дополнительная проверка.'],
  ['Бизнес работает меньше 12 месяцев.', 'Компания работает меньше 12 месяцев, поэтому заявку должен проверить специалист.']
];
function friendlyText(value) {
  return textReplacements.reduce((text, [from, to]) => text.split(from).join(to), String(value ?? ''));
}
function scrollPageToTop() {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => window.scrollTo(0, 0));
}
const editable = () => user?.role === 'client' && (!current || ['draft','needs_info'].includes(current.status));
const clarificationTemplates = {
  overdue: 'Поясните причину и текущий статус просрочки: когда она возникла и погашена ли сейчас.',
  revenue: 'Уточните среднемесячную выручку и период расчёта. Поясните, есть ли сезонные колебания.',
  company: 'Подтвердите сведения о компании: проверьте ИНН и поясните её текущий статус и вид деятельности.'
};
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
  $('.skip-link').href = user ? '#workspace' : '#main-content';
  $('#session').innerHTML = user ? `<span class="session-avatar" aria-hidden="true">${user.role === 'bank' ? 'А' : 'К'}</span><span>${user.role === 'bank' ? 'Сотрудник банка' : esc(clientProfile?.company_name || user.username)}</span><button id="logout">Выйти</button>` : '<span class="login-session-note">Кабинет предпринимателя</span>';
  if (user) $('#logout').onclick = () => act(async () => {
    await api('/api/logout','POST',{}); user = null; current = null; preview = null; stress = null; applications = []; clients = []; clientProfile = null; advisor = freshAdvisor();
    $('#workspace').innerHTML = ''; $('#notice').hidden = true; history.replaceState(null, '', '/login'); renderSession();
  });
}
async function enter() {
  [products, profiles, applications] = await Promise.all([api('/api/products').then(r => r.products), api('/api/demo-profiles').then(r => r.profiles), api('/api/applications').then(r => r.applications)]);
  if (user.role === 'client') clientProfile = (await api('/api/client-profile')).client;
  else clients = (await api('/api/clients')).clients;
  current = null; preview = null; stress = null; activeView = user.role === 'client' ? 'advisor' : 'applications'; history.replaceState(null, '', '/cabinet'); renderSession(); renderWorkspace(); scrollPageToTop();
}

function renderWorkspace() {
  const bank = user.role === 'bank';
  $('#workspace').classList.toggle('advisor-mode', activeView === 'advisor');
  const titles = bank ? {
    applications:['Последние заявки','Поиск, проверка и решения по заявкам клиентов.'],
    clients:['Клиенты банка','Реквизиты компаний и история обращений каждого клиента.']
  } : {
    advisor:['Кредитный советчик','Обсудите задачу и соберите условия для заявки.'],
    applications:['Заявки на финансирование','Выберите продукт, заполните данные и следите за решением.'],
    profile:['Профиль компании','Эти сведения автоматически используются при подаче заявки.']
  };
  const [title, subtitle] = titles[activeView];
  const tabs = bank ? [['applications','Заявки'],['clients','Клиенты']] : [['advisor','Советчик'],['applications','Заявки'],['profile','Данные компании']];
  const reviewCount = applications.filter(app => app.status === 'manual_review').length;
  $('#workspace').innerHTML = `<div class="workspace-heading ${activeView === 'advisor' ? 'advisor-workspace-heading' : ''}"><div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${!bank && activeView === 'applications' ? '<button class="accent" id="new">+ Новая заявка</button>' : ''}</div>${bank ? `<button type="button" class="review-overview" id="review-overview"><span>Ожидают решения: <b>${reviewCount}</b></span><small>Открыть очередь ручного рассмотрения</small></button>` : ''}<nav class="portal-tabs" aria-label="Разделы кабинета">${tabs.map(([view,label]) => `<button class="${activeView === view ? 'active' : ''}" data-view="${view}">${label}</button>`).join('')}</nav><div id="workspace-content"></div>`;
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => {
    activeView = button.dataset.view; current = null; preview = null; stress = null; renderWorkspace();
  }; });
  if ($('#review-overview')) $('#review-overview').onclick = () => {
    activeView = 'applications'; bankFilters.client = ''; bankFilters.status = 'manual_review'; current = null; renderWorkspace();
  };
  if (activeView === 'applications') renderApplicationsWorkspace();
  else if (activeView === 'advisor') renderAdvisorView();
  else if (activeView === 'profile') renderProfileView();
  else renderClientsView();
}

function renderApplicationsWorkspace() {
  const bank = user.role === 'bank';
  const filterPanel = bank ? `<section class="bank-filter-panel"><div class="application-filters"><label>Поиск<input id="application-search" value="${esc(bankFilters.query)}" placeholder="Название компании или ИНН"></label><label>Статус<select id="status-filter"><option value="">Все статусы</option>${[['approved','Одобренные'],['manual_review','Требуют рассмотрения'],['needs_info','Нужно уточнение'],['rejected','Отказы'],['draft','Черновики'],['funded','Завершённые']].map(([value,label]) => `<option value="${value}" ${bankFilters.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${bankFilters.client ? `<button type="button" class="filter-chip" id="clear-client-filter">Клиент: ${esc(clients.find(item => item.username === bankFilters.client)?.company_name || bankFilters.client)} ×</button>` : ''}</div></section>` : '';
  const list = `<aside class="sidebar ${bank && !current ? 'expanded-sidebar' : ''}"><div class="sidebar-title"><b>${bank ? 'Найденные заявки' : 'Мои заявки'}</b><span class="count" id="count"></span></div><nav class="application-list ${bank && !current ? 'expanded-list' : ''}" id="application-list" aria-label="Заявки"></nav>${!bank ? '<section class="sidebar-help"><h3>Работа с черновиком</h3><p>Сначала выберите продукт и укажите параметры. Затем добавьте документы и проверьте заявку перед отправкой.</p><p>Черновик можно сохранить и продолжить позже.</p></section>' : ''}</aside>`;
  $('#workspace-content').innerHTML = bank && !current ? `${filterPanel}<div class="expanded-applications">${list}</div>` : `${filterPanel}<div class="workspace-grid">${list}<section class="detail card" id="detail"></section></div>`;
  if ($('#new')) $('#new').onclick = () => { current = null; preview = null; stress = null; renderList(); renderDetail(); };
  if (bank) {
    $('#application-search').oninput = event => { bankFilters.query = event.target.value; current = null; renderList(); if ($('#detail')) renderDetail(); };
    $('#status-filter').onchange = event => { bankFilters.status = event.target.value; current = null; renderList(); if ($('#detail')) renderDetail(); };
    if ($('#clear-client-filter')) $('#clear-client-filter').onclick = () => { bankFilters.client = ''; current = null; renderApplicationsWorkspace(); };
  }
  renderList(); if ($('#detail')) renderDetail();
}

function filteredApplications() {
  if (user.role !== 'bank') return applications;
  const query = bankFilters.query.trim().toLocaleLowerCase('ru-RU');
  return applications.filter(app => {
    const profile = app.client || {};
    return (!bankFilters.status || app.status === bankFilters.status)
      && (!bankFilters.client || app.owner === bankFilters.client)
      && (!query || `${profile.company_name || ''} ${profile.tax_id || ''}`.toLocaleLowerCase('ru-RU').includes(query));
  });
}

function renderList() {
  const root = $('#application-list'); if (!root) return;
  const visible = filteredApplications();
  $('#count').textContent = visible.length;
  const expanded = user.role === 'bank' && !current;
  root.innerHTML = visible.length ? visible.map(app => {
    const product = products.find(item => item.id === app.data.product_id);
    return expanded ? `<button class="application-overview" data-id="${esc(app.id)}"><span class="overview-company"><strong>${esc(app.client?.company_name || app.owner)}</strong><small>${esc(app.client?.organization_type || '')} · ИНН ${esc(app.client?.tax_id || '—')}</small></span><span>${badge(app.status)}<small>${esc(new Date(app.created_at).toLocaleDateString('ru-RU'))}</small></span><span><small>Продукт</small><b>${esc(product?.name || app.data.product_id)}</b></span><span><small>Сумма и срок</small><b>${money(app.data.amount)} · ${esc(app.data.term_months)} мес.</b></span><span><small>Выручка</small><b>${money(app.data.revenue_monthly)}</b></span><span class="overview-open">Открыть</span></button>` : `<button class="application-item ${current?.id === app.id ? 'selected' : ''}" data-id="${esc(app.id)}"><strong>${esc(app.client?.company_name || app.owner)}</strong>${badge(app.status)}<span class="item-meta"><span>${money(app.data.amount)}</span><span>№ ${esc(String(app.id).slice(0,8))}</span></span></button>`;
  }).join('') : `<div class="empty">${user.role === 'bank' ? 'По выбранным условиям заявок нет.' : '<b>Здесь будут ваши заявки</b><p>Создайте первую — её статус и ответ банка появятся в этом разделе.</p>'}</div>`;
  root.querySelectorAll('button').forEach(button => { button.onclick = () => act(async () => {
    current = await api('/api/applications/' + encodeURIComponent(button.dataset.id)); preview = null; stress = null;
    if (user.role === 'bank') renderApplicationsWorkspace(); else { renderList(); renderDetail(); }
  }); });
}

function renderProfileView() {
  const p = clientProfile;
  $('#workspace-content').innerHTML = `<section class="profile-card card"><div class="profile-intro"><div><h2>${esc(p.company_name)}</h2><p>Изменения будут использоваться в новых заявках.</p></div><span class="profile-login">Логин: ${esc(p.username)}</span></div><form id="profile-form"><div class="profile-fields"><label>Название компании<input name="company_name" value="${esc(p.company_name)}" required maxlength="120"></label><label>ИНН<input name="tax_id" value="${esc(p.tax_id)}" required pattern="[0-9]{10}([0-9]{2})?"></label><label>Вид организации<select name="organization_type">${['ИП','ООО','АО','ПАО','Самозанятый'].map(value => `<option ${p.organization_type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Возраст бизнеса, мес.<input name="business_months" type="number" min="0" max="1200" step="1" value="${esc(p.business_months)}" required></label><label>Сфера деятельности<input name="industry" value="${esc(p.industry)}" required maxlength="120"></label><label>Средняя выручка за последние 6 месяцев, ₽<input name="average_revenue_6m" type="number" min="0" max="10000000000" step="0.01" value="${esc(p.average_revenue_6m)}" required></label><label>Контактное лицо<input name="contact_name" value="${esc(p.contact_name)}" required maxlength="120"></label><label>Телефон<input name="phone" value="${esc(p.phone)}" required maxlength="40"></label><label>Email<input name="email" type="email" value="${esc(p.email)}" required maxlength="120"></label><label class="wide">Юридический адрес<input name="legal_address" value="${esc(p.legal_address)}" required maxlength="300"></label></div><div class="form-actions"><button class="primary" type="submit">Сохранить данные</button></div></form></section>`;
  $('#profile-form').onsubmit = event => { event.preventDefault(); act(async () => {
    const data = Object.fromEntries(new FormData(event.target));
    data.business_months = Number(data.business_months); data.average_revenue_6m = Number(data.average_revenue_6m);
    clientProfile = (await api('/api/client-profile','PUT',data)).client;
    renderProfileView(); notify('Данные компании обновлены.');
  }); };
}

function renderClientsView() {
  $('#workspace-content').innerHTML = `<section class="client-registry card"><div class="registry-toolbar"><label>Поиск клиента<input id="client-search" placeholder="Название компании или ИНН"></label><span>${clients.length} клиентов</span></div><div id="client-table"></div></section>`;
  const draw = () => {
    const query = $('#client-search').value.trim().toLocaleLowerCase('ru-RU');
    const visible = clients.filter(item => `${item.company_name} ${item.tax_id}`.toLocaleLowerCase('ru-RU').includes(query));
    $('#client-table').innerHTML = visible.length ? `<div class="client-table"><div class="client-row client-table-head"><span>Компания</span><span>Реквизиты</span><span>Средняя выручка</span><span>Заявки</span><span></span></div>${visible.map(item => `<div class="client-row"><span><strong>${esc(item.company_name)}</strong><small>${esc(item.industry)}</small></span><span>${esc(item.organization_type)} · ${esc(item.tax_id)}<small>${esc(item.business_months)} мес. работы</small></span><span>${money(item.average_revenue_6m)}<small>за последние 6 месяцев</small></span><span>${esc(item.application_count)}<small>${item.manual_review_count ? `На рассмотрении: ${esc(item.manual_review_count)}` : 'Нет ожидающих решения'}</small></span><span><button type="button" data-client-apps="${esc(item.username)}">Посмотреть заявки</button></span></div>`).join('')}</div>` : '<div class="empty">Клиенты не найдены.</div>';
    document.querySelectorAll('[data-client-apps]').forEach(button => { button.onclick = () => {
      bankFilters.client = button.dataset.clientApps; bankFilters.query = ''; bankFilters.status = '';
      activeView = 'applications'; current = null; renderWorkspace();
    }; });
  };
  $('#client-search').oninput = draw; draw();
}
function renderAdvisorView() {
  const offer = CreditAdvisor.recommendation(advisor, products);
  const product = products.find(item => item.id === advisor.productId);
  const started = advisor.messages.length > 0;
  const quickReplies = started ? advisor.quickReplies : [
    'Нужно закупить товар', 'Хочу купить оборудование', 'Нужно закрыть кассовый разрыв', 'Какие документы нужны?'
  ];
  const welcome = '<div class="advisor-welcome"><h2>На что нужны деньги?</h2><p>Расскажите Пушу о задаче, сумме и сроке.<br>Или начните с одного из вопросов.</p></div>';
  const messages = advisor.messages.map(message => `<article class="chat-message ${message.role === 'user' ? 'from-user' : 'from-advisor'}">${message.role === 'assistant' ? '<span class="message-avatar" aria-hidden="true"><img src="/push.png" alt=""></span>' : ''}<div><span class="message-author">${message.role === 'user' ? 'Вы' : 'Пуш'}</span><p>${esc(message.text)}</p></div></article>`).join('');
  $('#workspace-content').innerHTML = `<div class="advisor-layout"><section class="advisor-chat" aria-label="Кредитный советчик Пуш"><header class="advisor-chat-header"><span class="advisor-avatar" aria-hidden="true"><img src="/push.png" alt=""></span><div><h2>Пуш</h2><p>Помощник по финансированию</p></div><button type="button" id="advisor-reset" ${!started || advisor.pending ? 'disabled' : ''}>Начать заново</button></header>
    <div class="advisor-conversation" id="advisor-conversation">${started ? `<div class="chat-messages" role="log" aria-label="Диалог с Пушем" aria-live="polite">${messages}${advisor.pending ? '<p class="advisor-thinking" role="status">Пуш готовит ответ…</p>' : ''}</div>` : welcome}
    <div class="advisor-quick ${started ? '' : 'welcome-quick'}" aria-label="Быстрые вопросы">${quickReplies.map((text,index) => `<button type="button" data-advisor-prompt="${index}" ${advisor.pending ? 'disabled' : ''}><span>${esc(text)}</span></button>`).join('')}</div></div>
    ${offer ? '<button type="button" class="primary chat-next-action" id="advisor-continue">Перейти к заявке</button>' : ''}<div class="advisor-composer"><form id="advisor-form"><label class="visually-hidden" for="advisor-message">Сообщение советчику</label><textarea id="advisor-message" name="message" rows="1" maxlength="1000" placeholder="Напишите Пушу…" ${advisor.pending ? 'disabled' : ''}></textarea><button type="submit" class="primary" aria-label="Отправить сообщение" disabled><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form><p><span class="demo-dot" aria-hidden="true"></span>Демо-диалог · Ответы по готовым сценариям</p></div></section>
    <aside class="advisor-sidebar"><section class="advisor-summary"><div class="advisor-summary-heading"><span class="summary-label">Условия заявки</span><span class="summary-status ${offer ? 'ready' : ''}">${offer ? 'Подобраны' : 'Подбираем'}</span></div><h2>${product ? esc(product.name) : 'Начнём с вашей задачи'}</h2><p>${product ? esc(product.description) : 'Условия появятся здесь по ходу разговора. Их можно будет перенести в заявку.'}</p><dl><div><dt>Сумма</dt><dd>${advisor.amount !== null ? money(advisor.amount) : 'Пока не указана'}</dd></div><div><dt>Срок</dt><dd>${advisor.term !== null ? esc(advisor.term) + ' мес.' : 'Пока не указан'}</dd></div>${product ? `<div><dt>Ставка в демо</dt><dd>${esc(product.annual_rate)}% годовых</dd></div>` : ''}</dl><div class="advisor-payment"><span>Платёж в месяц</span><strong>${offer ? money(offer.monthlyPayment) : '—'}</strong><small>${offer ? 'Предварительно, без учёта обеспечения' : 'Рассчитаем после выбора суммы и срока'}</small></div><button type="button" class="primary full" id="advisor-apply" ${offer ? '' : 'disabled'}><span>Перейти к заявке</span></button><p class="advisor-estimate-note">Расчёт демонстрационный. Решение будет доступно после проверки заявки.</p></section>
    <section class="advisor-next"><h3>Что дальше</h3><ol><li class="${product ? 'done' : 'active'}"><span>1</span><div><b>Обсудим задачу</b><p>Подберём вид финансирования</p></div></li><li class="${offer ? 'done' : product ? 'active' : ''}"><span>2</span><div><b>Соберём условия</b><p>Сумма, срок и платёж</p></div></li><li><span>3</span><div><b>Перейдём к заявке</b><p>Проверите данные и добавите документы</p></div></li></ol></section><p class="advisor-help-note">Пуш помогает с выбором.<br>Окончательное решение — после проверки данных.</p></aside></div>`;
  $('#advisor-form').onsubmit = event => { event.preventDefault(); sendAdvisorMessage($('#advisor-message').value); };
  $('#advisor-message').oninput = event => { $('#advisor-form button').disabled = advisor.pending || !event.target.value.trim(); };
  $('#advisor-message').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#advisor-form').requestSubmit(); }
  };
  document.querySelectorAll('[data-advisor-prompt]').forEach(button => {
    button.onclick = () => sendAdvisorMessage(quickReplies[Number(button.dataset.advisorPrompt)]);
  });
  $('#advisor-reset').onclick = () => { advisor = {...freshAdvisor(), requestId:++advisorRequestSequence}; renderAdvisorView(); };
  $('#advisor-apply').onclick = applyAdvisorRecommendation;
  if ($('#advisor-continue')) $('#advisor-continue').onclick = applyAdvisorRecommendation;
  if (started) $('#advisor-conversation').scrollTop = $('#advisor-conversation').scrollHeight;
}
// Future model integration has one boundary; the UI and form handoff stay the same.
async function requestAdvisorReply(message, context) {
  return CreditAdvisor.reply(message, context, products);
}
async function sendAdvisorMessage(value) {
  const message = String(value || '').trim();
  if (!message || advisor.pending || !user || user.role !== 'client') return;
  if (message.length > 1000) { notify('Сообщение должно быть не длиннее 1000 символов.', true); return; }
  if (advisor.messages.length >= 40) { notify('Для новой задачи начните диалог заново.'); return; }
  const account = user.username, requestId = ++advisorRequestSequence;
  advisor.requestId = requestId;
  advisor.messages.push({role:'user', text:message}); advisor.pending = true; advisor.quickReplies = [];
  renderAdvisorView();
  try {
    const context = {productId:advisor.productId, amount:advisor.amount, term:advisor.term, purpose:advisor.purpose};
    const result = await requestAdvisorReply(message, context);
    if (user?.username !== account || advisor.requestId !== requestId) return;
    Object.assign(advisor, result.state);
    advisor.messages.push({role:'assistant', text:result.answer}); advisor.quickReplies = result.quickReplies || [];
  } catch (_) {
    if (user?.username !== account || advisor.requestId !== requestId) return;
    advisor.messages.push({role:'assistant', text:'Не удалось подготовить ответ. Попробуйте задать вопрос ещё раз.'});
  } finally {
    if (user?.username === account && advisor.requestId === requestId) {
      advisor.pending = false;
      if (activeView === 'advisor') { renderAdvisorView(); $('#advisor-message').focus({preventScroll:true}); }
    }
  }
}
function applyAdvisorRecommendation() {
  const offer = CreditAdvisor.recommendation(advisor, products);
  if (!offer || advisor.pending) return;
  current = null; preview = null; stress = null; activeView = 'applications'; renderWorkspace();
  renderDetail({...blank(), product_id:offer.product.id, amount:offer.amount, term_months:offer.term, purpose:advisor.purpose});
  scrollPageToTop(); notify('Условия перенесены. Проверьте данные и добавьте документы.');
}
function field(name, title, value, type = 'number', extra = '') {
  return `<label>${title}<input name="${name}" type="${type}" value="${esc(value)}" ${extra} ${editable() ? '' : 'disabled'}></label>`;
}
function blank() {
  const revenue = Number(clientProfile?.average_revenue_6m) || 500000;
  return {product_id:products[0]?.id || '',amount:500000,term_months:12,purpose:'',revenue_monthly:revenue,expenses_monthly:300000,existing_payment:0,finance_period_months:6,collateral_type:'none',collateral_value:0,statement_source:'not_provided',statement_filename:'',statement_period_months:6,statement_monthly_inflow:revenue,statement_min_monthly_inflow:revenue,statement_average_balance:0,statement_negative_days:0,statement_tax_payments:false,statement_seasonality:0,statement_top_counterparty_share:0,bki_consent:false,financial_document_source:'not_provided',financial_document_type:'accounting',financial_document_filename:'',financial_document_period_months:12,reported_revenue_monthly:revenue,reported_net_profit_monthly:revenue-300000,consent:false,clarification:''};
}
function monthlyPayment(amount, annualRate, termMonths) {
  const principal = Number(amount), months = Number(termMonths), rate = Number(annualRate) / 1200;
  if (!Number.isFinite(principal) || principal <= 0 || !Number.isInteger(months) || months <= 0 || !Number.isFinite(rate) || rate < 0) return null;
  const payment = rate === 0 ? principal / months : principal * rate / (1 - Math.pow(1 + rate, -months));
  return Number.isFinite(payment) ? payment : null;
}
function collateralRate(product, collateralType, collateralValue, amount) {
  const haircuts = {real_estate:.7,equipment:.5,vehicle:.55,deposit:.95,purchased_asset:.7};
  const eligible = collateralType === 'msp_guarantee' ? Number(amount) * .5 : (collateralType === 'purchased_asset' ? Number(amount) : Number(collateralValue) || 0) * (haircuts[collateralType] || 0);
  const coverage = Number(amount) > 0 ? eligible / Number(amount) : 0;
  const discount = collateralType === 'msp_guarantee' ? .5 : coverage >= .7 ? 1.5 : coverage >= .4 ? .75 : 0;
  return Math.max(0, Number(product?.annual_rate) - discount);
}
function livePaymentMarkup(d, product) {
  const rate = collateralRate(product, d.collateral_type || 'none', d.collateral_value || 0, d.amount);
  const payment = monthlyPayment(d.amount, rate, Number(d.term_months));
  return `<div class="live-payment wide" id="live-payment"><span>Ориентировочный платёж в месяц</span><strong>${payment == null ? '—' : money(payment)}</strong><small id="live-rate">Расчёт по ставке ${esc(rate)}% годовых</small></div>`;
}
function updateLivePayment() {
  const form = $('#application-form'), root = $('#live-payment'); if (!form || !root) return;
  const product = products.find(item => item.id === form.elements.product_id.value);
  const rate = collateralRate(product, form.elements.collateral_type.value, form.elements.collateral_value.value, form.elements.amount.value);
  const payment = monthlyPayment(form.elements.amount.value, rate, Number(form.elements.term_months.value));
  root.querySelector('strong').textContent = payment == null ? '—' : money(payment);
  $('#live-rate').textContent = `Расчёт по ставке ${rate}% годовых`;
}
function updateCollateralUI() {
  const form = $('#application-form'); if (!form) return;
  const product = products.find(item => item.id === form.elements.product_id.value);
  const select = form.elements.collateral_type;
  const requiresPledge = Boolean(product?.required_collateral_coverage);
  select.required = requiresPledge;
  [...select.options].forEach(option => {
    if (option.value === 'none' || option.value === 'msp_guarantee') option.disabled = requiresPledge;
  });
  if (requiresPledge && ['none','msp_guarantee'].includes(select.value)) select.value = '';
  if (!requiresPledge && !select.value) select.value = 'none';
  const type = select.value;
  const wrap = $('#collateral-value-wrap');
  const needsValue = Boolean(type) && !['none','msp_guarantee','purchased_asset'].includes(type);
  wrap.hidden = !needsValue; form.elements.collateral_value.required = needsValue;
  form.elements.collateral_value.min = needsValue ? '1' : '0';
  $('#collateral-requirement').textContent = requiresPledge
    ? 'Для этого вида финансирования залог обязателен. Выберите предмет обеспечения.'
    : 'Для этого вида финансирования можно подать заявку без залога.';
  updateLivePayment();
}
function parseStatementNumber(value) {
  const normalized = String(value ?? '').replace(/[\s\u00a0₽]/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const number = Number(normalized); return Number.isFinite(number) ? number : null;
}
function statementMonth(dateValue) {
  const value = String(dateValue ?? '').trim();
  const ru = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  const date = ru ? new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : {key:`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`, date};
}
async function importBankStatement(file) {
  const form = $('#application-form'), text = await file.text();
  const rows = text.split(/\r?\n/).filter(row => row.trim());
  if (rows.length < 2) throw new Error('В выписке нет операций. Проверьте CSV-файл.');
  const delimiter = (rows[0].match(/;/g) || []).length >= (rows[0].match(/,/g) || []).length ? ';' : ',';
  const split = row => row.split(delimiter).map(value => value.trim().replace(/^"|"$/g, ''));
  const headers = split(rows[0]).map(value => value.toLocaleLowerCase('ru-RU'));
  const column = variants => headers.findIndex(header => variants.some(variant => header.includes(variant)));
  const dateIndex = column(['дата','date']), amountIndex = column(['сумма','amount']), directionIndex = column(['направ','тип операции','direction','type']), balanceIndex = column(['остат','balance']), purposeIndex = column(['назнач','purpose','описан','description']), counterpartyIndex = column(['контрагент','плательщик','counterparty','payer']);
  if (dateIndex < 0 || amountIndex < 0) throw new Error('В CSV нужны как минимум колонки «дата» и «сумма».');
  const inflows = new Map(), counterparties = new Map(), balances = [], negativeDates = new Set(); let latestDate = null, taxPayments = false, operations = 0;
  rows.slice(1).forEach(row => {
    const cells = split(row), parsedDate = statementMonth(cells[dateIndex]), rawAmount = parseStatementNumber(cells[amountIndex]);
    if (!parsedDate || rawAmount == null) return;
    operations += 1; if (!latestDate || parsedDate.date > latestDate) latestDate = parsedDate.date;
    const direction = String(cells[directionIndex] || '').toLocaleLowerCase('ru-RU');
    const incoming = direction ? /(приход|поступ|вход|income|credit)/.test(direction) : rawAmount > 0;
    if (incoming) {
      const amount = Math.abs(rawAmount); inflows.set(parsedDate.key, (inflows.get(parsedDate.key) || 0) + amount);
      const counterparty = String(cells[counterpartyIndex] || 'Не указан').trim(); counterparties.set(counterparty, (counterparties.get(counterparty) || 0) + amount);
    }
    const balance = balanceIndex >= 0 ? parseStatementNumber(cells[balanceIndex]) : null;
    if (balance != null) { balances.push(balance); if (balance < 0) negativeDates.add(parsedDate.date.toISOString().slice(0,10)); }
    if (purposeIndex >= 0 && /(налог|фнс|казнач|страхов.*взнос)/i.test(cells[purposeIndex] || '')) taxPayments = true;
  });
  if (!operations || !latestDate) throw new Error('Не удалось распознать операции в выписке.');
  const detectedMonths = new Set(inflows.keys()).size, period = detectedMonths > 6 ? 12 : 6, monthly = [];
  for (let offset = period - 1; offset >= 0; offset -= 1) {
    const date = new Date(latestDate.getFullYear(), latestDate.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; monthly.push(inflows.get(key) || 0);
  }
  const set = (name,value) => { form.elements[name].value = Math.round(value * 100) / 100; };
  const totalInflow = monthly.reduce((sum,value) => sum + value, 0), averageInflow = totalInflow / period;
  const variance = monthly.reduce((sum,value) => sum + Math.pow(value - averageInflow, 2), 0) / period;
  const seasonality = averageInflow > 0 ? Math.sqrt(variance) / averageInflow : 0;
  const topCounterparty = Math.max(0, ...counterparties.values());
  form.elements.statement_source.value = 'uploaded'; form.elements.statement_filename.value = file.name;
  form.elements.statement_period_months.value = String(period);
  set('statement_monthly_inflow', averageInflow);
  set('statement_min_monthly_inflow', Math.min(...monthly));
  set('statement_average_balance', balances.length ? balances.reduce((sum,value) => sum + value, 0) / balances.length : 0);
  set('statement_negative_days', negativeDates.size);
  set('statement_seasonality', seasonality);
  set('statement_top_counterparty_share', totalInflow > 0 ? topCounterparty / totalInflow : 0);
  form.elements.statement_tax_payments.value = String(taxPayments);
  $('#statement-status').textContent = `Загружено: ${file.name}`; $('#statement-status').classList.add('ready');
  preview = null; renderAssessment(null); notify(`Выписка обработана: ${operations} операций, период ${period} месяцев.`);
}
async function importFinancialDocument(file) {
  const form = $('#application-form'), text = await file.text();
  const rows = text.split(/\r?\n/).filter(row => row.trim());
  if (rows.length < 2) throw new Error('В финансовом документе нет строки с показателями.');
  const delimiter = (rows[0].match(/;/g) || []).length >= (rows[0].match(/,/g) || []).length ? ';' : ',';
  const split = row => row.split(delimiter).map(value => value.trim().replace(/^"|"$/g, ''));
  const headers = split(rows[0]).map(value => value.toLocaleLowerCase('ru-RU'));
  const column = variants => headers.findIndex(header => variants.some(variant => header.includes(variant)));
  const periodIndex = column(['период_месяцев','период месяцев','period_months']);
  const revenueIndex = column(['выручка_за_период','выручка за период','revenue_total']);
  const profitIndex = column(['чистая_прибыль_за_период','чистая прибыль за период','net_profit_total']);
  if (periodIndex < 0 || revenueIndex < 0 || profitIndex < 0) throw new Error('Нужны колонки «период_месяцев», «выручка_за_период» и «чистая_прибыль_за_период».');
  const values = split(rows[1]), period = parseStatementNumber(values[periodIndex]);
  const revenue = parseStatementNumber(values[revenueIndex]), profit = parseStatementNumber(values[profitIndex]);
  if (![3,6,12].includes(period) || revenue == null || profit == null) throw new Error('Проверьте период и числовые значения финансового документа.');
  form.elements.financial_document_source.value = 'uploaded'; form.elements.financial_document_filename.value = file.name;
  form.elements.financial_document_period_months.value = String(period);
  form.elements.reported_revenue_monthly.value = Math.round(revenue / period * 100) / 100;
  form.elements.reported_net_profit_monthly.value = Math.round(profit / period * 100) / 100;
  $('#financial-document-status').textContent = `Загружено: ${file.name}`; $('#financial-document-status').classList.add('ready');
  preview = null; renderAssessment(null); notify('Финансовый документ обработан. Среднемесячные показатели рассчитаны.');
}
function applicationDetails(d, title, profile = current?.client || clientProfile) {
  const product = products.find(item => item.id === d.product_id);
  const item = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  return `<section class="application-details"><div class="section-heading"><span class="eyebrow">ДАННЫЕ ЗАЯВКИ</span><h3>${esc(title)}</h3></div><div class="detail-groups">
    <section><h4>Компания</h4><dl>${item('Название', profile?.company_name || '—')}${item('ИНН', profile?.tax_id || '—')}${item('Вид организации', profile?.organization_type || '—')}${item('Возраст бизнеса', `${profile?.business_months ?? '—'} мес.`)}${item('Средняя выручка за 6 месяцев', money(profile?.average_revenue_6m))}</dl></section>
    <section><h4>Кредит</h4><dl>${item('Продукт', product?.name || d.product_id)}${item('Сумма', money(d.amount))}${item('Срок', `${d.term_months} мес.`)}${item('Цель', d.purpose)}${item('Обеспечение', collateralNames[d.collateral_type || 'none'])}${d.collateral_value ? item('Стоимость залога до оценки банка', money(d.collateral_value)) : ''}</dl></section>
    <section><h4>Финансы и документы</h4><dl>${item('Период расчёта', `среднее за последние ${d.finance_period_months || 6} полных месяцев`)}${item('Выручка', money(d.revenue_monthly))}${item('Операционные расходы', money(d.expenses_monthly))}${item('Платежи по другим кредитам', money(d.existing_payment))}${item('Банковская выписка', d.statement_source === 'uploaded' ? `загружена · ${d.statement_filename || 'CSV'}` : d.statement_source === 'bank_account' ? 'доступна банку по расчётному счёту' : 'не предоставлена')}${d.statement_source && d.statement_source !== 'not_provided' ? item('Средние поступления по выписке', money(d.statement_monthly_inflow)) + item('Минимальные поступления за месяц', money(d.statement_min_monthly_inflow)) + item('Дней с отрицательным остатком', d.statement_negative_days ?? 0) + item('Доля крупнейшего контрагента', `${Math.round(Number(d.statement_top_counterparty_share || 0) * 100)}%`) : ''}${item('Финансовый документ', d.financial_document_source === 'uploaded' ? `${financialDocumentNames[d.financial_document_type] || 'Документ'} · ${d.financial_document_filename || 'CSV'}` : 'не предоставлен')}${d.financial_document_source === 'uploaded' ? item('Выручка по документу', money(d.reported_revenue_monthly)) + item('Чистая прибыль по документу', money(d.reported_net_profit_monthly)) : ''}${item('Согласие на БКИ', d.bki_consent ? 'предоставлено' : 'не предоставлено')}</dl></section>
  </div>${d.clarification ? `<div class="client-answer"><span>Ответ клиента банку</span><p>${esc(d.clarification)}</p></div>` : ''}</section>`;
}
function historyBlock() {
  if (!current) return '';
  return `<section class="history"><h3>История заявки</h3><ol>${(current.events || []).slice().reverse().map(event => `<li><time>${esc(new Date(event.at).toLocaleString('ru-RU'))} · ${esc(event.actor)}</time><b>${esc(statusNames[event.status] || event.status)}</b>${event.note ? `<p>${esc(friendlyText(event.note))}</p>` : ''}</li>`).join('')}</ol></section>`;
}
function companySummary(profile) {
  return `<div class="company-summary"><div><span>Название компании</span><strong>${esc(profile?.company_name || '—')}</strong></div><div><span>ИНН</span><strong>${esc(profile?.tax_id || '—')}</strong></div><div><span>Вид организации</span><strong>${esc(profile?.organization_type || '—')}</strong></div><div><span>Возраст бизнеса</span><strong>${esc(profile?.business_months ?? '—')} мес.</strong></div><div><span>Сфера деятельности</span><strong>${esc(profile?.industry || '—')}</strong></div><div><span>Средняя выручка за 6 месяцев</span><strong>${money(profile?.average_revenue_6m)}</strong></div></div>`;
}
function processTracker(status = 'draft') {
  const steps = ['Документы','Проверка','Решение','Предложение и выдача'];
  const currentStep = ['draft','needs_info'].includes(status) ? 0 : ['checking','manual_review'].includes(status) ? 1 : ['approved','rejected'].includes(status) ? 2 : 3;
  return `<ol class="process-tracker" aria-label="Этапы заявки">${steps.map((step,index) => `<li class="${index < currentStep ? 'complete' : index === currentStep ? 'current' : ''}"><span>${index + 1}</span><b>${step}</b></li>`).join('')}</ol>`;
}
function productCatalog(selectedId) {
  const categories = [...new Set(products.map(product => product.category))];
  return categories.map(category => `<details class="product-group" ${products.some(product => product.category === category && product.id === selectedId) ? 'open' : ''}><summary class="product-group-title"><span>${esc(category)}</span><small>${products.filter(product => product.category === category).length} вар.</small></summary><div class="product-options">${products.filter(product => product.category === category).map(product => `<label class="product-option"><input type="radio" name="product_id" value="${esc(product.id)}" ${product.id === selectedId ? 'checked' : ''}><span class="product-option-body"><span class="product-option-heading"><strong>${esc(product.name)}</strong><b>${esc(product.annual_rate)}% годовых</b></span><span>${esc(product.description)}</span><small>${money(product.min_amount)}–${money(product.max_amount)} · ${esc(product.min_term)}–${esc(product.max_term)} мес.${product.manual_review ? ' · решение специалиста' : ''}</small></span></label>`).join('')}</div></details>`).join('');
}
const helperQuestions = [
  {
    key:'goal', title:'Для чего нужны средства?', hint:'Выберите ближайший сценарий — детали можно уточнить на следующем шаге.',
    options:[['liquidity','Закрыть текущую потребность','Кассовый разрыв, закупка или регулярные оборотные расходы'],['growth','Развивать бизнес','Оборудование, недвижимость или новый проект'],['contracts','Использовать специальный инструмент','Господдержка, лизинг, факторинг или участие в закупках']]
  },
  {
    key:'detail', title:'Что именно вы планируете?', hint:'Ответ определит подходящую механику финансирования.',
    optionsByGoal:{
      liquidity:[['cash_gap','Покрывать краткие кассовые разрывы','Деньги нужны ненадолго до ближайших поступлений'],['one_purchase','Оплатить одну закупку или обязательство','Нужна одна сумма на конкретную текущую задачу'],['recurring_tranches','Брать деньги частями','Финансирование потребуется несколькими траншами']],
      growth:[['equipment','Купить оборудование или расширить производство','Инвестиции с окупаемостью в течение нескольких лет'],['property','Купить коммерческую недвижимость','Офис, склад, помещение или участок'],['project','Запустить крупный новый проект','Погашение планируется из будущих доходов проекта']],
      contracts:[['subsidy','Подать заявку по программе господдержки','Компания соответствует отраслевой или региональной программе'],['leasing','Получить технику или транспорт','Имущество передаётся в пользование с последующим выкупом'],['factoring','Получить деньги по неоплаченным счетам','Покупатели платят с отсрочкой, но деньги нужны сейчас'],['tender','Участвовать в закупке или исполнить контракт','Нужна гарантия либо тендерное финансирование']]
    }
  },
  {
    key:'horizon', title:'На какой срок нужна поддержка?', hint:'Срок помогает выбрать между лимитом, разовой выдачей и долгосрочным финансированием.',
    options:[['short','До 12 месяцев','Краткая текущая потребность'],['medium','От 1 года до 3 лет','Среднесрочное финансирование'],['long','Более 3 лет','Долгосрочное вложение']]
  }
];
function helperRecommendation() {
  const detail = creditHelper.answers.detail, horizon = creditHelper.answers.horizon;
  if (detail === 'recurring_tranches') return horizon === 'long' ? 'credit_line_nonrevolving' : 'credit_line_revolving';
  return {cash_gap:'overdraft',one_purchase:'working_capital',equipment:'equipment',property:'commercial_mortgage',project:'project_finance',subsidy:'subsidized',leasing:'leasing',factoring:'factoring',tender:'bank_guarantee'}[detail] || 'working_capital';
}
function renderCreditHelper() {
  const root = $('#credit-helper'); if (!root) return;
  if (creditHelper.step >= helperQuestions.length) {
    const product = products.find(item => item.id === helperRecommendation());
    root.innerHTML = `<div class="helper-result"><span class="eyebrow">РЕКОМЕНДАЦИЯ</span><h4>${esc(product?.name || '')}</h4><p>${esc(product?.description || '')}</p><div class="helper-result-meta"><span>Ориентир ставки: <b>${esc(product?.annual_rate)}% годовых</b></span><span>Срок: <b>${esc(product?.min_term)}–${esc(product?.max_term)} мес.</b></span></div><div class="helper-actions"><button type="button" id="helper-back">Назад</button><button type="button" class="primary" id="helper-apply">Выбрать этот вид кредита</button></div></div>`;
    $('#helper-back').onclick = () => { creditHelper.step -= 1; renderCreditHelper(); };
    $('#helper-apply').onclick = () => {
      const input = $(`input[name="product_id"][value="${product.id}"]`); input.closest('details').open = true; input.checked = true; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
      root.hidden = true; root.innerHTML = ''; document.querySelector('.product-catalog').scrollIntoView({behavior:'smooth',block:'start'});
      notify(`Выбран вариант «${product.name}». Проверьте сумму и срок.`);
    };
    return;
  }
  const question = helperQuestions[creditHelper.step];
  const options = question.options || question.optionsByGoal[creditHelper.answers.goal] || [];
  root.innerHTML = `<div class="helper-progress"><span>Шаг ${creditHelper.step + 1} из ${helperQuestions.length}</span><i><b style="width:${((creditHelper.step + 1) / helperQuestions.length) * 100}%"></b></i></div><h4>${esc(question.title)}</h4><p>${esc(question.hint)}</p><div class="helper-options">${options.map(([value,title,description]) => `<button type="button" data-helper-value="${esc(value)}" class="${creditHelper.answers[question.key] === value ? 'selected' : ''}"><strong>${esc(title)}</strong><span>${esc(description)}</span></button>`).join('')}</div><div class="helper-actions">${creditHelper.step ? '<button type="button" id="helper-back">← К предыдущему вопросу</button>' : '<button type="button" id="helper-close">Закрыть</button>'}</div>`;
  document.querySelectorAll('[data-helper-value]').forEach(button => { button.onclick = () => {
    creditHelper.answers[question.key] = button.dataset.helperValue;
    if (question.key === 'goal') delete creditHelper.answers.detail;
    creditHelper.step += 1; renderCreditHelper();
  }; });
  if ($('#helper-back')) $('#helper-back').onclick = () => { creditHelper.step -= 1; renderCreditHelper(); };
  if ($('#helper-close')) $('#helper-close').onclick = () => { root.hidden = true; root.innerHTML = ''; };
}
function renderDetail(d = current?.data || blank()) {
  if (!current && user.role === 'bank') { $('#detail').innerHTML = '<div class="empty"><h2>Выберите заявку слева</h2>Заявки с пограничным результатом поступают на ручное рассмотрение. Клиенты видят решения и запросы уточнений в своём кабинете.</div>'; return; }
  const profile = current?.client || clientProfile;
  const product = products.find(p => p.id === d.product_id) || products[0];
  const lastNote = [...(current?.events || [])].reverse().find(event => event.status === 'needs_info' && event.actor === 'analyst')?.note;
  const draftView = user.role === 'client' && (!current || ['draft','needs_info'].includes(current.status));
  if (draftView) {
    $('#detail').innerHTML = `<div class="detail-header"><div><h2>${current ? 'Заявка на финансирование' : 'Новая заявка'}</h2><p class="detail-subtitle">Укажите задачу бизнеса — поможем подобрать условия.</p></div>${badge(current?.status || 'draft')}</div>${processTracker(current?.status || 'draft')}
    <form id="application-form" class="application-form">
    ${current?.status === 'needs_info' ? `<section class="clarification-card"><span class="eyebrow">ТРЕБУЕТСЯ ВАШ ОТВЕТ</span><h3>Банк просит уточнение</h3><p>${esc(lastNote || 'Проверьте данные и добавьте пояснение.')}</p><label>Ответ банку<textarea name="clarification" required minlength="10" maxlength="2000" placeholder="Ответьте на запрос банка и при необходимости исправьте данные ниже">${esc(d.clarification)}</textarea></label></section>` : '<input type="hidden" name="clarification" value="">'}
    <section class="form-section readonly-company"><div class="section-title-row"><h3><span class="section-number">01</span> Сведения о компании</h3><button type="button" id="open-profile">Изменить в профиле</button></div>${companySummary(profile)}</section>
    <section class="form-section product-catalog"><div class="catalog-heading"><div><h3><span class="section-number">02</span> На что нужны средства?</h3><p>Выберите продукт самостоятельно или ответьте на три вопроса помощника.</p></div></div><button type="button" class="credit-helper-start" id="credit-helper-start"><span><strong>Помочь с выбором кредита</strong><small>Подберём вариант под задачу вашего бизнеса</small></span></button><div class="credit-helper" id="credit-helper" hidden></div>${productCatalog(product.id)}</section>
    <section class="form-section"><h3><span class="section-number">03</span> Параметры финансирования и обеспечение</h3><div class="parameter-fields">
      ${field('amount','Сумма, ₽',d.amount,'number',`required min="${product.min_amount}" max="${product.max_amount}" step="0.01"`)}
      <label>Срок, мес.<input name="term_months" type="number" value="${esc(d.term_months)}" required min="${product.min_term}" max="${product.max_term}" step="1"><span class="field-limit" id="term-limit">От ${esc(product.min_term)} до ${esc(product.max_term)} месяцев для этого вида финансирования</span></label>
      ${livePaymentMarkup(d, product)}
      <label class="wide">На что планируете направить средства?<textarea name="purpose" required minlength="5" maxlength="500">${esc(d.purpose)}</textarea></label>
      <label>Обеспечение<select name="collateral_type" id="collateral-type"><option value="">Выберите обеспечение</option>${Object.entries(collateralNames).map(([value,label]) => `<option value="${value}" ${(d.collateral_type || 'none') === value ? 'selected' : ''}>${label}</option>`).join('')}</select><span class="field-limit" id="collateral-requirement"></span></label>
      <label id="collateral-value-wrap" ${(d.collateral_type && !['none','msp_guarantee','purchased_asset'].includes(d.collateral_type)) ? '' : 'hidden'}>Ориентировочная рыночная стоимость, ₽<input name="collateral_value" type="number" min="0" max="100000000000" step="0.01" value="${esc(d.collateral_value || 0)}"><span class="field-note">Банк проверит право собственности, обременения и ликвидную стоимость отдельно.</span></label>
    </div></section>
    <section class="form-section"><h3><span class="section-number">04</span> Среднемесячные финансовые показатели</h3><div class="fields">
      <label class="wide">Период расчёта<select name="finance_period_months"><option value="6" ${Number(d.finance_period_months || 6) === 6 ? 'selected' : ''}>Последние 6 полных месяцев</option><option value="12" ${Number(d.finance_period_months) === 12 ? 'selected' : ''}>Последние 12 полных месяцев</option></select><span class="field-note">Укажите среднее за выбранный период: сложите фактические значения за полные календарные месяцы и разделите на 6 или 12. Для сезонного бизнеса лучше выбрать 12 месяцев.</span></label>
      ${field('revenue_monthly','Выручка, ₽',d.revenue_monthly,'number','required min="0" max="10000000000" step="0.01"')}
      ${field('expenses_monthly','Операционные расходы, ₽',d.expenses_monthly,'number','required min="0" max="10000000000" step="0.01"')}
      ${field('existing_payment','Платежи по другим кредитам, ₽',d.existing_payment,'number','required min="0" max="10000000000" step="0.01"')}
      <p class="field-note">Выручка по умолчанию взята из профиля за 6 месяцев. Если выбираете 12 месяцев, скорректируйте её по своей отчётности. Расходы укажите без платежей по кредитам.</p>
    </div></section>
    <section class="form-section statement-section"><div class="statement-heading"><div><h3><span class="section-number">05</span> Банковская выписка</h3><p>Выписка подтверждает реальные обороты, стабильность поступлений, налоговые платежи и дни с отрицательным остатком.</p></div><span class="statement-status ${d.statement_source === 'uploaded' ? 'ready' : ''}" id="statement-status">${d.statement_source === 'uploaded' ? 'Данные выписки загружены' : 'Выписка не предоставлена'}</span></div><div class="statement-upload"><label>Загрузить выписку в CSV<input id="statement-file" type="file" accept=".csv,text/csv"></label><p>Колонки: дата, сумма, направление (приход/расход); дополнительно — остаток и назначение платежа. Исходный файл остаётся на устройстве, в заявке сохраняются только рассчитанные показатели.</p></div><input type="hidden" name="statement_source" value="${esc(d.statement_source || 'not_provided')}"><input type="hidden" name="statement_filename" value="${esc(d.statement_filename || '')}"><div class="statement-fields">
      <label>Период выписки<select name="statement_period_months"><option value="6" ${Number(d.statement_period_months || 6) === 6 ? 'selected' : ''}>6 месяцев</option><option value="12" ${Number(d.statement_period_months) === 12 ? 'selected' : ''}>12 месяцев</option></select></label>
      ${field('statement_monthly_inflow','Средние поступления в месяц, ₽',d.statement_monthly_inflow ?? d.revenue_monthly,'number','required min="0" max="100000000000" step="0.01"')}
      ${field('statement_min_monthly_inflow','Минимальные поступления за месяц, ₽',d.statement_min_monthly_inflow ?? d.revenue_monthly,'number','required min="0" max="100000000000" step="0.01"')}
      ${field('statement_average_balance','Средний остаток, ₽',d.statement_average_balance || 0,'number','required min="-10000000000" max="10000000000" step="0.01"')}
      ${field('statement_negative_days','Дней с отрицательным остатком',d.statement_negative_days || 0,'number','required min="0" max="366" step="1"')}
      <input type="hidden" name="statement_tax_payments" value="${d.statement_tax_payments ? 'true' : 'false'}">
      <input type="hidden" name="statement_seasonality" value="${esc(d.statement_seasonality || 0)}"><input type="hidden" name="statement_top_counterparty_share" value="${esc(d.statement_top_counterparty_share || 0)}">
    </div></section>
    <section class="form-section document-section"><div class="statement-heading"><div><h3><span class="section-number">06</span> Финансовый документ и кредитная история</h3><p>Отчётность подтверждает выручку и прибыль, а кредитный отчёт показывает все действующие обязательства компании.</p></div><span class="statement-status ${d.financial_document_source === 'uploaded' ? 'ready' : ''}" id="financial-document-status">${d.financial_document_source === 'uploaded' ? 'Финансовый документ загружен' : 'Финансовый документ не предоставлен'}</span></div><div class="document-grid"><label>Вид документа<select name="financial_document_type"><option value="accounting" ${d.financial_document_type === 'accounting' ? 'selected' : ''}>Бухгалтерская отчётность</option><option value="tax_declaration" ${d.financial_document_type === 'tax_declaration' ? 'selected' : ''}>Налоговая декларация</option><option value="usn_declaration" ${d.financial_document_type === 'usn_declaration' ? 'selected' : ''}>Декларация УСН</option><option value="management" ${d.financial_document_type === 'management' ? 'selected' : ''}>Управленческий отчёт</option></select></label><label>Загрузить сводные данные в CSV<input id="financial-document-file" type="file" accept=".csv,text/csv"></label></div><p class="document-format">CSV должен содержать колонки «период_месяцев», «выручка_за_период» и «чистая_прибыль_за_период». В заявке сохраняются рассчитанные среднемесячные значения.</p><input type="hidden" name="financial_document_source" value="${esc(d.financial_document_source || 'not_provided')}"><input type="hidden" name="financial_document_filename" value="${esc(d.financial_document_filename || '')}"><div class="statement-fields"><label>Период документа<select name="financial_document_period_months"><option value="3" ${Number(d.financial_document_period_months) === 3 ? 'selected' : ''}>3 месяца</option><option value="6" ${Number(d.financial_document_period_months) === 6 ? 'selected' : ''}>6 месяцев</option><option value="12" ${Number(d.financial_document_period_months || 12) === 12 ? 'selected' : ''}>12 месяцев</option></select></label>${field('reported_revenue_monthly','Выручка по документу в месяц, ₽',d.reported_revenue_monthly ?? d.revenue_monthly,'number','required min="0" max="100000000000" step="0.01"')}${field('reported_net_profit_monthly','Чистая прибыль по документу в месяц, ₽',d.reported_net_profit_monthly ?? 0,'number','required min="-10000000000" max="10000000000" step="0.01"')}</div><label class="check-label bki-consent"><input type="checkbox" name="bki_consent" ${d.bki_consent ? 'checked' : ''}><span><b>Согласие на получение кредитного отчёта</b><small>Разрешаю запросить кредитный отчёт компании для рассмотрения этой заявки. Цель — оценка кредитоспособности; пользователь отчёта — банк. Согласие оформляется при отправке заявки.</small></span></label></section>
    <section class="form-section preview-section"><div class="preview-heading"><div><span class="eyebrow">ПРЕДВАРИТЕЛЬНАЯ ОЦЕНКА</span><h3><span class="section-number">07</span> Проверить параметры</h3><p>Проверим, хватает ли бизнесу денег на новый платёж, совпадают ли данные анкеты с выпиской и отчётностью и нет ли проблем по действующим кредитам. Если заявку нельзя одобрить сразу, подскажем, чего не хватает и что можно изменить.</p></div><button class="accent preview-button" type="button" id="preview">Проверить параметры</button></div><div id="assessment" data-context="preview"></div></section>
    <label class="check-label"><input type="checkbox" name="consent" ${d.consent ? 'checked' : ''}><span>Разрешаю обработать указанные данные для рассмотрения заявки.</span></label>
    <div class="form-actions"><button type="button" id="save">${current?.status === 'needs_info' ? 'Сохранить изменения' : 'Сохранить черновик'}</button><button type="submit" class="primary">${current?.status === 'needs_info' ? 'Отправить ответ банку' : 'Отправить в банк'}</button></div><p class="small muted compact-note">Предпросмотр не отправляет заявку. Перед отправкой данные сохранятся.</p>
    </form>${current?.status === 'needs_info' ? historyBlock() : ''}`;
    renderAssessment(preview || current?.assessment);
    bindDetail();
    return;
  }

  const analyst = user.role === 'bank';
  const bankActions = analyst && current?.status === 'manual_review' ? '<section class="bank-actions"><span class="eyebrow">ВАШЕ РЕШЕНИЕ</span><h3>Ответ аналитика</h3><p class="small muted">Поля заявки неизменяемы. Выберите решение. Для запроса уточнения и отказа добавьте комментарий; при одобрении он необязателен.</p><div class="template-buttons"><button type="button" data-template="overdue">Пояснить просрочку</button><button type="button" data-template="revenue">Уточнить выручку</button><button type="button" data-template="company">Подтвердить сведения о компании</button></div><label>Комментарий клиенту <span class="muted">(необязательно при одобрении)</span><textarea id="decision-note" maxlength="2000" placeholder="Объясните решение или укажите, что нужно уточнить"></textarea></label><div class="form-actions"><button type="button" data-decision="approve" class="primary">Одобрить</button><button type="button" data-decision="request_info">Запросить уточнение</button><button type="button" data-decision="reject" class="danger">Отказать</button></div></section>' : '';
  const offerAction = user.role === 'client' && current?.status === 'approved' ? '<section class="offer-action"><h3>Предложение готово</h3><button type="button" id="accept" class="primary">Принять условия</button></section>' : '';
  $('#detail').innerHTML = `${analyst ? '<button type="button" class="back-to-list" id="back-to-applications">← Вернуться ко всем заявкам</button>' : ''}<div class="detail-header"><h2>${esc(profile?.company_name || current?.owner)}</h2>${badge(current?.status || 'draft')}</div>${processTracker(current?.status || 'draft')}
    <section class="result-hero ${analyst ? 'analyst-result' : ''}"><span class="eyebrow">${analyst ? 'ПРЕДВАРИТЕЛЬНЫЙ ОТВЕТ СИСТЕМЫ' : 'ОТВЕТ СИСТЕМЫ'}</span><div id="assessment" data-context="${analyst ? 'analyst' : 'client'}"></div></section>
    ${current?.status === 'funded' ? '<div class="funded-note"><b>Предложение принято.</b></div>' : ''}
    ${offerAction}${applicationDetails(d, analyst ? 'Ответы клиента на вопросы заявки' : 'Детали вашей заявки')}${bankActions}${historyBlock()}`;
  renderAssessment(current?.assessment);
  bindDetail();
}
function readForm() {
  const form = $('#application-form'), data = Object.fromEntries(new FormData(form));
  ['amount','term_months','revenue_monthly','expenses_monthly','existing_payment','finance_period_months','collateral_value','statement_period_months','statement_monthly_inflow','statement_min_monthly_inflow','statement_average_balance','statement_negative_days','statement_seasonality','statement_top_counterparty_share','financial_document_period_months','reported_revenue_monthly','reported_net_profit_monthly'].forEach(key => { data[key] = Number(data[key]); });
  data.consent = form.elements.consent.checked;
  data.statement_tax_payments = form.elements.statement_tax_payments.value === 'true';
  data.bki_consent = form.elements.bki_consent.checked;
  return data;
}
function valid() { return $('#application-form').reportValidity(); }
function improvementTipsFor(assessment, actualStatus) {
  if (!['rejected','manual_review'].includes(actualStatus)) return [];
  const score = assessment.score || {}, features = score.features || {}, checks = assessment.checks || {};
  const product = products.find(item => item.id === ($('#application-form')?.elements.product_id.value || current?.data?.product_id));
  const tips = [];
  if (features.covers_payment === false) {
    tips.push(`После расходов и действующих кредитов остаётся ${money(features.free_cash_flow)}, а новый платёж составляет около ${money(score.monthly_payment)}. Коэффициент покрытия платежа (DSCR) — ${Number(features.dscr || 0).toFixed(2)}. Попробуйте уменьшить сумму или увеличить срок в пределах ${product?.min_term || 'доступного'}–${product?.max_term || 'доступного'} месяцев.`);
  } else if (features.has_approval_buffer === false) {
    tips.push(`Платёж помещается в денежный поток, но запас составляет ${Number(features.payment_coverage || 0).toFixed(1)} платежа. Для «${product?.name || 'этого продукта'}» ориентир — не менее ${features.required_coverage || 'установленного банком'}. Попробуйте уменьшить сумму нового кредита или увеличить его срок.`);
  }
  if (features.meets_business_age === false) tips.push(`Для «${product?.name || 'выбранного продукта'}» обычно нужна более длительная история бизнеса. Можно выбрать более короткий оборотный продукт или приложить договоры с постоянными покупателями.`);
  if (features.has_required_collateral === false) tips.push(`Для «${product?.name || 'выбранного продукта'}» нужен залог. Укажите недвижимость, оборудование, транспорт, депозит или приобретаемый объект и его рыночную стоимость.`);
  if (features.statement_source === 'not_provided') tips.push('Загрузите банковскую выписку за 6–12 месяцев: она подтвердит обороты и покажет стабильность поступлений.');
  if (features.statement_source && features.statement_source !== 'not_provided' && features.statement_revenue_ratio < .8) tips.push(`По выписке подтверждается около ${Math.round(features.statement_revenue_ratio * 100)}% заявленной выручки. Проверьте сумму выручки или добавьте выписки с других расчётных счетов.`);
  if (features.statement_source && features.statement_source !== 'not_provided' && features.statement_stability < .35) tips.push('Поступления заметно меняются от месяца к месяцу. Добавьте пояснение о сезонности и договоры, подтверждающие будущие поступления.');
  if (features.statement_seasonality > .5) tips.push('В слабые месяцы обороты существенно ниже среднего. Укажите сезон бизнеса и проверьте, будет ли хватать денег на платёж именно в эти месяцы.');
  if (features.statement_top_counterparty_share > .6) tips.push(`Около ${Math.round(features.statement_top_counterparty_share * 100)}% поступлений зависит от одного покупателя. Добавьте действующий договор с ним или покажите других регулярных покупателей.`);
  if (features.statement_negative_days > 15) tips.push(`За период выписки счёт уходил в минус ${features.statement_negative_days} дней. Сократите кассовые разрывы или поясните, почему они возникали.`);
  if (features.statement_source && features.statement_source !== 'not_provided' && features.statement_tax_payments === false) tips.push('Если налоги оплачиваются с другого счёта, приложите выписку по нему или подтверждение из налогового органа.');
  if (features.bki_consent === false) tips.push('Подтвердите согласие на получение кредитного отчёта — без него банк не сможет проверить действующие обязательства компании.');
  if (features.credit_report && features.effective_existing_payment > features.declared_existing_payment * 1.1 + 1) tips.push(`В кредитном отчёте найдено платежей на ${money(features.effective_existing_payment)} в месяц, а в заявке указано ${money(features.declared_existing_payment)}. Проверьте действующие кредиты и исправьте сумму.`);
  if (features.financial_document_source === 'not_provided') tips.push('Загрузите бухгалтерскую отчётность или налоговую декларацию, чтобы подтвердить выручку и прибыль.');
  if (features.financial_document_source && features.financial_document_source !== 'not_provided' && features.reported_revenue_ratio < .8) tips.push(`Финансовый документ подтверждает около ${Math.round(features.reported_revenue_ratio * 100)}% заявленной выручки. Проверьте период расчёта или уменьшите выручку в заявке.`);
  if (features.reported_net_profit_monthly < 0) tips.push('По финансовому документу бизнес убыточен. Добавьте пояснение причин убытка и покажите, за счёт каких поступлений будет погашаться кредит.');
  if (checks.overdue_days >= 30) tips.push('Сначала погасите просрочку и дождитесь обновления кредитной истории: смена продукта эту причину не устранит.');
  else if (checks.overdue_days > 0) tips.push('Подготовьте короткое пояснение по текущей просрочке и документ о её погашении или графике урегулирования.');
  if (checks.registry_status !== 'active') tips.push('Проверьте регистрационные сведения компании и подготовьте актуальную выписку из реестра.');
  if (!tips.length && actualStatus === 'manual_review') tips.push('Заявку проверяет специалист. Если понадобятся дополнительные сведения, запрос появится в этом кабинете.');
  return [...new Set(tips)];
}
function renderAssessment(assessment) {
  const root = $('#assessment'); if (!root) return;
  const context = root.dataset.context || 'client';
  if (!assessment) { root.innerHTML = `<p class="small muted">${context === 'analyst' ? 'Система ещё не сформировала предварительный вывод по этой заявке.' : 'Здесь появятся причины решения и возможный следующий шаг.'}</p>`; return; }
  const {score = {}, decision = {}, alternative, product_alternatives = [], missing_documents = [], bank_decision} = assessment;
  const isPreview = assessment === preview;
  const actualStatus = isPreview || context === 'analyst' ? decision.status : current?.status || decision.status;
  const finalClientResult = context !== 'analyst' && !isPreview && ['approved','rejected','funded'].includes(actualStatus);
  const offer = bank_decision?.offer || decision.offer;
  const registry = {active:'Статус компании подтверждён',inactive:'По указанным данным компания сейчас не ведёт деятельность',unknown:'Статус компании не подтверждён'}[assessment.checks?.registry_status] || 'Статус компании не определён';
  const reasons = [...new Set([...(decision.reasons || []), ...(score.reasons || [])].map(friendlyText))];
  const decisionReasons = [...new Set((decision.reasons || []).map(friendlyText))];
  const specificRejectionReasons = decisionReasons.filter(reason => !reason.startsWith('Совокупность указанных данных'));
  const rejectionReasons = specificRejectionReasons.length ? specificRejectionReasons : decisionReasons;
  const payment = offer?.monthly_payment ?? score.monthly_payment;
  const label = context === 'analyst' ? 'Предварительный вывод системы' : isPreview ? 'Предварительный результат' : 'Результат рассмотрения';
  const manualCallout = (context === 'analyst' ? decision.status : actualStatus) === 'manual_review' ? `<p class="manual-review-callout">${isPreview ? 'Заявка будет рассматриваться вручную' : context === 'analyst' ? 'Система рекомендует ручное рассмотрение' : 'Заявка рассматривается вручную'}</p>` : '';
  const canApplyAlternative = !!$('#application-form');
  const rejectionBlock = actualStatus === 'rejected' ? `<section class="rejection-reasons"><h4>Причины отказа</h4><ul class="reason-list">${rejectionReasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></section>` : '';
  const detailsReasons = actualStatus === 'rejected' ? [] : reasons;
  const analystSummary = context === 'analyst' ? `<div class="analyst-score-panel"><div><span>Оценка системы</span><strong>${esc(score.score ?? '—')}<small>/100</small></strong></div><div><span>Уровень риска</span><strong>${esc(riskNames[score.risk] || score.risk || '—')}</strong></div><div><span>DSCR после всех обязательств</span><strong>${score.features?.dscr == null ? '—' : Number(score.features.dscr).toFixed(2)}<small>×</small></strong></div><div><span>Долг по данным БКИ</span><strong>${score.features?.credit_report ? money(score.features.credit_report.total_debt) : 'нет отчёта'}</strong></div></div><div class="analyst-factors"><h4>Что повлияло на оценку</h4><ul class="reason-list">${reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><p>${esc(registry)}. Сведения о просрочке: ${assessment.checks?.overdue_days == null ? 'нет данных' : esc(assessment.checks.overdue_days) + ' дн'}.</p></div>` : '';
  const decisionDetails = context === 'analyst' ? analystSummary : finalClientResult ? '' : `<details class="decision-details"><summary>Подробности решения</summary><div class="decision-details-content">${detailsReasons.length ? `<p class="small muted">Что повлияло на результат</p><ul class="reason-list">${detailsReasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}<div class="score-meta"><span>Оценка системы: ${esc(score.score ?? '—')}/100</span></div><p class="small muted details-checks">${esc(registry)}. Сведения о просрочке: ${assessment.checks?.overdue_days == null ? 'нет данных' : esc(assessment.checks.overdue_days) + ' дн'}.</p></div></details>`;
  const improvementTips = improvementTipsFor(assessment, actualStatus);
  const improvements = ['rejected','manual_review'].includes(actualStatus) && context !== 'analyst' && improvementTips.length ? `<section class="improvement-tips"><h4>${actualStatus === 'rejected' ? 'Что можно изменить' : 'Как повысить шансы на одобрение'}</h4><ul>${improvementTips.map(tip => `<li>${esc(tip)}</li>`).join('')}</ul></section>` : '';
  const productOptions = ['rejected','manual_review'].includes(actualStatus) && context !== 'analyst' && product_alternatives.length ? `<section class="product-alternatives"><h4>Другие варианты финансирования</h4><p>Это новый предварительный расчёт по тем же финансовым данным, а не обещание одобрения.</p><div>${product_alternatives.map(item => `<article><span>${badge(item.status)}</span><h5>${esc(item.name)}</h5><p>${esc(item.description)}</p><b>${money(item.amount)} · ${esc(item.term_months)} мес.</b><small>${esc(item.annual_rate)}% годовых · около ${money(item.monthly_payment)} в месяц</small>${canApplyAlternative ? `<button type="button" data-product-alternative="${esc(item.product_id)}" data-amount="${esc(item.amount)}" data-term="${esc(item.term_months)}">Выбрать и проверить</button>` : ''}</article>`).join('')}</div></section>` : '';
  const missingDocumentsBlock = !finalClientResult && missing_documents.length ? `<section class="missing-documents"><h4>Что ещё нужно предоставить</h4><ul>${missing_documents.map(document => `<li>${esc(document)}</li>`).join('')}</ul></section>` : '';
  root.innerHTML = `<div class="assessment"><span class="small muted">${label}</span><h3>${esc(statusNames[actualStatus] || 'Оценка готова')}</h3>${rejectionBlock}${manualCallout}${bank_decision?.note && !isPreview && context !== 'analyst' ? `<p class="human-decision"><b>Комментарий сотрудника:</b> ${esc(friendlyText(bank_decision.note))}</p>` : ''}${offer ? `<p class="small">${money(offer.amount)} · ${esc(offer.term_months)} мес. · ${esc(offer.annual_rate)}% годовых</p>` : ''}${payment != null && actualStatus !== 'rejected' && context !== 'analyst' ? `<div class="metric"><span>Ориентировочный платёж в месяц</span><strong>${money(payment)}</strong></div>` : ''}
    ${missingDocumentsBlock}${improvements}${alternative ? `<div class="alternative"><h4>Вариант с другими параметрами</h4><p><b>${money(alternative.amount)} на ${esc(alternative.term_months)} мес.</b><br>${money(alternative.monthly_payment)} в месяц<br>Сумма платежей ≈ ${money(alternative.monthly_payment * alternative.term_months)}</p><p>Больший срок может увеличить общую выплату. Расчёт указан без комиссий.</p><p>${esc(friendlyText(alternative.explanation || 'Проверьте результат с другими параметрами.'))}</p>${canApplyAlternative ? '<button type="button" id="apply-alternative">Подставить и проверить</button>' : ''}</div>` : ''}
    ${productOptions}${decisionDetails}</div>`;
  if ($('#apply-alternative')) $('#apply-alternative').onclick = () => act(async () => {
    const form = $('#application-form'); form.elements.amount.value = alternative.amount; form.elements.term_months.value = alternative.term_months;
    await makePreview(); notify('Параметры подставлены. Это предпросмотр; заявка ещё не отправлена.');
  });
  document.querySelectorAll('[data-product-alternative]').forEach(button => { button.onclick = () => act(async () => {
    const form = $('#application-form'), input = $(`input[name="product_id"][value="${button.dataset.productAlternative}"]`);
    input.closest('details').open = true; input.checked = true; input.dispatchEvent(new Event('change', {bubbles:true}));
    form.elements.amount.value = button.dataset.amount; form.elements.term_months.value = button.dataset.term;
    await makePreview(); notify('Альтернативный продукт подставлен. Заявка ещё не отправлена.');
  }); });
}
async function makePreview() {
  if (!valid()) return;
  const data = readForm(), result = await api('/api/preview','POST',data);
  if (JSON.stringify(data) !== JSON.stringify(readForm())) return;
  preview = result; stress = null; renderAssessment(preview);
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
  applications = (await api('/api/applications')).applications;
  if (user?.role === 'bank') {
    clients = (await api('/api/clients')).clients;
    const count = applications.filter(app => app.status === 'manual_review').length;
    const overview = $('#review-overview');
    if (overview) overview.innerHTML = `<span>Ожидают решения: <b>${count}</b></span><small>Открыть очередь ручного рассмотрения</small>`;
  }
  renderList();
}
function bindDetail() {
  const form = $('#application-form');
  if (form) {
    if ($('#open-profile')) $('#open-profile').onclick = () => { activeView = 'profile'; current = null; preview = null; stress = null; renderWorkspace(); };
    $('#credit-helper-start').onclick = () => {
      creditHelper = {step:0, answers:{}};
      $('#credit-helper').hidden = false; renderCreditHelper();
      $('#credit-helper').scrollIntoView({behavior:'smooth', block:'center'});
    };
    $('#statement-file').onchange = event => {
      const file = event.target.files?.[0]; if (!file) return;
      act(async () => importBankStatement(file));
    };
    $('#financial-document-file').onchange = event => {
      const file = event.target.files?.[0]; if (!file) return;
      act(async () => importFinancialDocument(file));
    };
    form.addEventListener('input', () => { preview = null; stress = null; renderAssessment(null); updateLivePayment(); });
    form.elements.collateral_type.onchange = updateCollateralUI;
    document.querySelectorAll('input[name="product_id"]').forEach(input => { input.onchange = () => {
      const product = products.find(p => p.id === form.elements.product_id.value); if (!product) return;
      form.elements.amount.min = product.min_amount; form.elements.amount.max = product.max_amount;
      form.elements.term_months.min = product.min_term; form.elements.term_months.max = product.max_term;
      form.elements.amount.value = Math.min(product.max_amount, Math.max(product.min_amount, Number(form.elements.amount.value) || product.min_amount));
      form.elements.term_months.value = Math.min(product.max_term, Math.max(product.min_term, Number(form.elements.term_months.value) || product.min_term));
      $('#term-limit').textContent = `От ${product.min_term} до ${product.max_term} месяцев для этого вида финансирования`;
      preview = null; stress = null; renderAssessment(null); updateCollateralUI();
    }; });
    $('#preview').onclick = () => act(makePreview);
    $('#save').onclick = () => act(async () => { if (!valid()) return; await save(); renderDetail(); notify('Данные сохранены.'); });
    form.onsubmit = event => { event.preventDefault(); act(async () => {
      if (!valid()) return;
      if (!form.elements.consent.checked) { notify('Для отправки подтвердите согласие на обработку данных.', true); form.elements.consent.focus(); return; }
      if (!form.elements.bki_consent.checked) { notify('Для отправки подтвердите согласие на получение кредитного отчёта.', true); form.elements.bki_consent.focus(); return; }
      await save(); current = await api('/api/applications/' + encodeURIComponent(current.id) + '/submit','POST',{});
      preview = null; stress = null; await refreshList(); renderDetail(); scrollPageToTop(); notify('Заявка отправлена. Результат и история обновлены.');
    }); };
    updateCollateralUI();
  }
  if ($('#back-to-applications')) $('#back-to-applications').onclick = () => { current = null; preview = null; stress = null; renderApplicationsWorkspace(); };
  document.querySelectorAll('[data-template]').forEach(button => { button.onclick = () => {
    $('#decision-note').value = clarificationTemplates[button.dataset.template]; $('#decision-note').focus();
  }; });
  document.querySelectorAll('[data-decision]').forEach(button => { button.onclick = () => act(async () => {
    const action = button.dataset.decision, note = $('#decision-note').value.trim();
    if ((action !== 'approve' || note.length > 0) && note.length < 10) { notify(action === 'approve' ? 'Оставьте поле пустым или добавьте комментарий от 10 символов.' : 'Добавьте понятный комментарий от 10 символов.', true); $('#decision-note').focus(); return; }
    current = await api('/api/applications/' + encodeURIComponent(current.id) + '/decision','POST',{action,note});
    preview = null; await refreshList(); renderDetail(); notify('Решение сохранено и доступно клиенту.');
  }); });
  if ($('#accept')) $('#accept').onclick = () => act(async () => {
    current = await api('/api/applications/' + encodeURIComponent(current.id) + '/accept','POST',{});
    await refreshList(); renderDetail(); notify('Предложение принято.');
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
