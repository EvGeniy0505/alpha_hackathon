'use strict';

const scenarios = {
  stock: {
    question: 'Нужно 800 тысяч на закупку товара на 18 месяцев.',
    reply: 'Для закупки товара подойдёт оборотный кредит. В кабинете можно уточнить сумму и срок, рассчитать платёж и перейти к заявке.',
    purpose: 'НА ПОПОЛНЕНИЕ ЗАПАСОВ', product: 'Оборотный кредит', amount: '800 000 ₽', term: '18 месяцев'
  },
  equipment: {
    question: 'Хочу купить новое оборудование. Нужно 3 миллиона на 3 года.',
    reply: 'Для покупки оборудования можно рассмотреть инвестиционный кредит. В кабинете уточним параметры и обеспечение, а затем рассчитаем условия.',
    purpose: 'НА ОБНОВЛЕНИЕ ОБОРУДОВАНИЯ', product: 'Инвестиционный кредит', amount: '3 000 000 ₽', term: '36 месяцев'
  },
  growth: {
    question: 'Планирую открыть вторую точку. Нужно 2 миллиона на 2 года.',
    reply: 'Для расширения бизнеса можно рассмотреть инвестиционный кредит. Расскажите о расходах и выручке в кабинете, чтобы проверить параметры заявки.',
    purpose: 'НА РАСШИРЕНИЕ БИЗНЕСА', product: 'Инвестиционный кредит', amount: '2 000 000 ₽', term: '24 месяца'
  }
};

document.querySelectorAll('[data-scenario]').forEach(button => {
  button.addEventListener('click', () => {
    const scenario = scenarios[button.dataset.scenario];
    document.querySelectorAll('[data-scenario]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    for (const [key, value] of Object.entries(scenario)) {
      document.getElementById('demo-' + key).textContent = value;
    }
  });
});
