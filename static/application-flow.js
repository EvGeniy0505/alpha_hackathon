'use strict';

const ApplicationFlow = (() => {
  const steps = [
    ['Условия', 'Начнём с задачи бизнеса', 'Выберите продукт, сумму и срок. Платёж посчитаем сразу.'],
    ['Финансы', 'Как идут дела у бизнеса?', 'Укажите среднемесячные показатели за один и тот же период.'],
    ['Документы', 'Подтвердим ваши цифры', 'Добавьте выписку и финансовый документ. Показатели из файлов можно проверить.'],
    ['Проверка', 'Всё готово к проверке', 'Сверьте условия, проверьте параметры и только затем отправляйте заявку.']
  ];

  function revealInvalid(form, control) {
    const panel = control.closest('[data-application-panel]');
    if (panel) form.showFlowStep(Number(panel.dataset.applicationPanel));
    for (let parent = control.parentElement; parent && parent !== form; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    control.reportValidity();
    control.focus();
  }

  function validate(form, root = form) {
    const invalid = Array.from(root.querySelectorAll('input,select,textarea')).find(control => !control.checkValidity());
    if (!invalid) return true;
    revealInvalid(form, invalid);
    return false;
  }

  function mount(form, {company, summary, catalog, initialStep = 0}) {
    if (form.dataset.flowMounted) return;
    form.dataset.flowMounted = 'true';
    form.noValidate = true;
    const sections = Array.from(form.querySelectorAll(':scope > .form-section'));
    if (sections.length !== 7) return;
    const tracker = form.parentElement.querySelector('.process-tracker');
    if (tracker) tracker.hidden = true;
    form.parentElement.querySelector('.detail-subtitle').textContent = 'Четыре понятных шага. Черновик можно сохранить и продолжить позже.';

    const navigation = document.createElement('nav');
    navigation.className = 'application-flow-nav'; navigation.setAttribute('aria-label', 'Этапы заполнения заявки');
    navigation.innerHTML = steps.map(([title], index) => `<button type="button" data-flow-step="${index}"><span>${index + 1}</span>${title}</button>`).join('');
    form.prepend(navigation);

    const identity = document.createElement('details');
    identity.className = 'application-identity';
    identity.innerHTML = '<summary><span class="identity-symbol" aria-hidden="true">А</span><span><b class="identity-company"></b><small class="identity-tax"></small></span><span class="identity-toggle">Реквизиты</span></summary>';
    identity.querySelector('.identity-company').textContent = company.company_name;
    identity.querySelector('.identity-tax').textContent = `ИНН ${company.tax_id} · Данные из вашего профиля`;
    identity.append(sections[0]); navigation.after(identity);

    const clarification = form.querySelector(':scope > .clarification-card');
    const consent = form.querySelector('input[name="consent"]').closest('label');
    const existingActions = form.querySelector(':scope > .form-actions');
    const note = form.querySelector(':scope > .compact-note');
    const groups = [[sections[1], sections[2]], [sections[3]], [sections[4], sections[5]], [sections[6], consent]];
    if (clarification) groups[3].unshift(clarification);
    const panels = groups.map((nodes, index) => {
      const panel = document.createElement('section');
      panel.className = 'application-flow-panel'; panel.dataset.applicationPanel = index;
      panel.innerHTML = `<div class="flow-panel-heading"><span>Шаг ${index + 1} из ${steps.length}</span><h3 tabindex="-1">${steps[index][1]}</h3><p>${steps[index][2]}</p></div>`;
      if (index === 3) {
        const review = document.createElement('div'); review.className = 'flow-review';
        review.innerHTML = '<div><span>Продукт</span><strong data-flow-summary="product"></strong></div><div><span>Сумма</span><strong data-flow-summary="amount"></strong></div><div><span>Срок</span><strong data-flow-summary="term"></strong></div><button type="button" data-flow-edit>Изменить условия</button>';
        review.querySelector('button').onclick = () => form.showFlowStep(0, true);
        panel.append(review);
      }
      nodes.forEach(node => panel.append(node));
      form.append(panel); return panel;
    });

    const productPicker = document.createElement('div'); productPicker.className = 'flow-product-picker';
    productPicker.innerHTML = '<label>Вид финансирования<select id="flow-product-select"></select></label><p class="flow-product-description"></p>';
    const select = productPicker.querySelector('select');
    catalog.forEach(product => select.add(new Option(product.name, product.id)));
    const comparison = document.createElement('details'); comparison.className = 'flow-product-comparison';
    comparison.innerHTML = `<summary>Сравнить все продукты · ${catalog.length}</summary>`;
    sections[1].querySelectorAll(':scope > .product-group').forEach(group => comparison.append(group));
    sections[1].append(productPicker, comparison);
    const purpose = form.elements.purpose.closest('label'); purpose.classList.add('flow-purpose');
    form.elements.purpose.placeholder = 'Например, закупить товар к началу сезона';
    sections[1].querySelector('.catalog-heading').after(purpose);
    const helperButton = form.querySelector('#credit-helper-start');
    helperButton.innerHTML = '<img class="helper-push" src="/push.png" alt="" width="46" height="50"><span><strong>Помочь с выбором?</strong><small>Ответьте на три коротких вопроса</small></span>';
    select.onchange = () => {
      const radio = Array.from(form.querySelectorAll('[name="product_id"]')).find(input => input.value === select.value);
      radio.checked = true; radio.dispatchEvent(new Event('change', {bubbles:true}));
    };

    // Keep parsed document values available without making them the first thing a visitor sees.
    form.querySelectorAll('.statement-fields').forEach(fields => {
      const details = document.createElement('details'); details.className = 'parsed-document-values';
      details.innerHTML = '<summary>Посмотреть и уточнить показатели</summary>';
      fields.before(details); details.append(fields);
    });
    form.querySelectorAll('.statement-upload>p,.document-format').forEach(text => {
      const details = document.createElement('details'); details.className = 'document-guidance';
      details.innerHTML = '<summary>Как подготовить файл</summary>';
      text.before(details); details.append(text);
    });

    const footer = document.createElement('div'); footer.className = 'application-flow-footer';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'flow-back'; back.textContent = 'Назад';
    const next = document.createElement('button'); next.type = 'button'; next.className = 'primary flow-next';
    const submit = existingActions.querySelector('[type="submit"]');
    existingActions.append(next); footer.append(back, existingActions); form.append(footer);
    if (note) form.append(note);
    let active = Math.max(0, Math.min(3, initialStep));

    const updateSummary = () => {
      const values = summary();
      form.querySelectorAll('[data-flow-summary]').forEach(element => { element.textContent = values[element.dataset.flowSummary]; });
      const product = catalog.find(item => item.id === form.elements.product_id.value);
      select.value = product?.id || '';
      productPicker.querySelector('p').textContent = product?.description || '';
    };
    form.showFlowStep = (index, scroll = false) => {
      active = Math.max(0, Math.min(3, index)); form.dataset.flowStep = active;
      panels.forEach((panel, i) => { panel.hidden = i !== active; });
      navigation.querySelectorAll('button').forEach((button, i) => {
        if (i === active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
      });
      back.hidden = active === 0; next.hidden = active === 3; submit.hidden = active !== 3;
      next.textContent = active < 3 ? `Дальше: ${steps[active + 1][0].toLocaleLowerCase('ru-RU')}` : '';
      if (note) note.hidden = active !== 3;
      updateSummary();
      if (scroll) { navigation.scrollIntoView({behavior:'smooth', block:'start'}); panels[active].querySelector('h3').focus({preventScroll:true}); }
    };
    const advance = () => { if (validate(form, panels[active])) form.showFlowStep(active + 1, true); };
    navigation.querySelectorAll('button').forEach(button => { button.onclick = () => form.showFlowStep(Number(button.dataset.flowStep), true); });
    next.onclick = advance; back.onclick = () => form.showFlowStep(active - 1, true);
    form.addEventListener('input', event => { if (event.target !== select) updateSummary(); });
    form.addEventListener('change', updateSummary);
    form.addEventListener('submit', event => {
      if (active < 3) { event.preventDefault(); event.stopImmediatePropagation(); advance(); }
    }, true);
    form.showFlowStep(active);
  }
  return {mount, validate};
})();
