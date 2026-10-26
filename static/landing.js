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

function examplePayment(amount, months, annualRate = 19.5) {
  const rate = annualRate / 1200;
  return Math.round(rate === 0 ? amount / months : amount * rate / (1 - (1 + rate) ** -months));
}

const labAmount = document.getElementById('lab-amount');
if (labAmount) {
  let term = 18, mode = 'product';
  const rubles = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits:0}).format(value) + ' ₽';
  const content = {
    product:['Под вашу задачу', 'Оборотный кредит', 'Для товара, сырья и текущих расходов бизнеса.'],
    payment:['Всё перед глазами', 'Сколько платить в месяц?', 'Платёж меняется вместе с суммой и сроком. Попробуйте.'],
    options:['Есть что сравнить', 'А если вернуть позже?', 'Проверьте другой срок. Условия выбираете вы.']
  };
  const updateLab = () => {
    const amount = Number(labAmount.value), alternativeTerm = term < 36 ? 36 : 24;
    document.getElementById('lab-amount-value').textContent = rubles(amount);
    document.getElementById('lab-payment').textContent = rubles(examplePayment(amount, term));
    document.getElementById('lab-payment-detail').textContent = `${rubles(amount)} на ${term} месяцев`;
    ['note','title','copy'].forEach((key,index) => { document.getElementById('lab-answer-' + key).textContent = content[mode][index]; });
    const comparison = document.getElementById('lab-comparison');
    comparison.hidden = mode !== 'options';
    document.getElementById('lab-alternative-term').textContent = alternativeTerm + ' мес.';
    document.getElementById('lab-alternative-payment').textContent = rubles(examplePayment(amount, alternativeTerm)) + ' / мес.';
    comparison.querySelector('span').firstChild.textContent = alternativeTerm > term ? 'Если увеличить срок до ' : 'Если сократить срок до ';
    comparison.querySelector('small').textContent = alternativeTerm > term ? 'Платёж ниже, общая сумма выплат больше.' : 'Платёж выше, общая сумма выплат меньше.';
    document.querySelector('.lab-answer').dataset.mode = mode;
  };
  labAmount.addEventListener('input', updateLab);
  document.querySelectorAll('[data-lab-term]').forEach(button => button.addEventListener('click', () => {
    term = Number(button.dataset.labTerm);
    document.querySelectorAll('[data-lab-term]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateLab();
  }));
  document.querySelectorAll('[data-lab-mode]').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.labMode;
    document.querySelectorAll('[data-lab-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateLab();
  }));
  updateLab();
}
