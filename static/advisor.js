/* A scripted interaction prototype. Replace reply() with the future model adapter.
   Recommendations never save, submit or decide a lending application. */
(function (root) {
  'use strict';
  const rubles = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0}).format(value) + ' ₽';
  const goals = [
    [/кассов|разрыв|до поступлен|не хватает до/, 'overdraft'],
    [/ипотек|помещени|недвижим|офис|купить склад/, 'commercial_mortgage'],
    [/лизинг|транспорт|автомобил|машин/, 'leasing'],
    [/факторинг|отсрочк|неоплачен.*счет|покупател.*позже/, 'factoring'],
    [/гаранти|тендер|госконтракт|закупках/, 'bank_guarantee'],
    [/господдерж|субсиди|льготн/, 'subsidized'],
    [/транш|частями|возобновляем|кредитн.*лини/, 'credit_line_revolving'],
    [/оборудован|производств|расшир|открыть|новую точк|ремонт|инвести/, 'equipment'],
    [/товар|закупк|сырье|оборот|материал|поставщик/, 'working_capital']
  ];
  function amountFrom(text, awaitingAmount) {
    const compact = text.replace(/(\d)[ \u00a0](?=\d{3}(?:\D|$))/g, '$1');
    const scaled = compact.match(/(-?\d+(?:[.,]\d+)?)\s*(млн|миллион\w*|тыс\.?|тысяч\w*)/);
    if (scaled) return Number(scaled[1].replace(',', '.')) * (scaled[2].startsWith('м') ? 1e6 : 1e3);
    const currency = compact.match(/(-?\d+(?:[.,]\d+)?)\s*(?:₽|руб\w*)/);
    if (currency) return Number(currency[1].replace(',', '.'));
    if (awaitingAmount && /^\s*\d{3,}\s*$/.test(compact)) return Number(compact);
    return null;
  }
  function termFrom(text) {
    const months = text.match(/(-?\d+(?:[.,]\d+)?)\s*(?:мес\w*|месяц\w*)/);
    if (months) return Number(months[1].replace(',', '.'));
    const years = text.match(/(-?\d+(?:[.,]\d+)?)\s*(?:год(?:а|ов)?|лет)(?![а-я])/);
    if (years) return Number(years[1].replace(',', '.')) * 12;
    if (/полгода/.test(text)) return 6;
    if (/на (?:один )?год(?![а-я])/.test(text)) return 12;
    if (/на два года/.test(text)) return 24;
    if (/на три года/.test(text)) return 36;
    return null;
  }
  function payment(amount, rate, months) {
    const r = rate / 1200;
    return r ? amount * r / (1 - Math.pow(1 + r, -months)) : amount / months;
  }
  function recommendation(state, products) {
    const product = products.find(item => item.id === state.productId);
    const valid = product && Number.isFinite(state.amount) && state.amount >= product.min_amount
      && state.amount <= product.max_amount && Number.isInteger(state.term)
      && state.term >= product.min_term && state.term <= product.max_term;
    return valid ? {product, amount:state.amount, term:state.term,
      monthlyPayment:payment(state.amount, product.annual_rate, state.term)} : null;
  }
  function reply(message, previous, products) {
    const text = message.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
    const state = {...previous};
    const detected = goals.find(([pattern]) => pattern.test(text));
    const question = /(?:какие|нужны|нужен|загруз|подготов|что|как|зачем|расскажи|объясни|список|требован)/.test(text);
    if (/(?:документ|выписк|отчетност|деклараци)/.test(text) && question) {
      return {state, answer:'Для предварительной проверки понадобятся банковская выписка за 6–12 месяцев, бухгалтерская отчётность или налоговая декларация, а также согласие на проверку кредитной истории. В кабинете документы загружаются в CSV. Если потребуется что-то ещё, банк запросит это в заявке.', quickReplies:['Помоги выбрать кредит', 'Как рассчитывается платёж?']};
    }
    if (/одобр|отказ|отклон|точно дадут|гарантирован/.test(text) && !detected) {
      return {state, answer:'Я могу помочь с выбором продукта и объяснить условия. Решение по заявке принимается после проверки данных и документов. Предварительный расчёт доступен в заявке — он покажет причины результата и возможный следующий шаг.', quickReplies:['Какие документы нужны?', 'Помоги выбрать кредит']};
    }
    if (/платеж|процент|ставк|переплат/.test(text) && question && !detected) {
      const product = products.find(item => item.id === state.productId);
      return {state, answer:product
        ? `В демонстрационном каталоге у продукта «${product.name}» ставка ${product.annual_rate}% годовых. Платёж рассчитывается по сумме и сроку. Более долгий срок уменьшает ежемесячный платёж, но может увеличить общую выплату. Точный расчёт с учётом обеспечения будет в заявке.`
        : 'Ежемесячный платёж зависит от суммы, срока и ставки. Более долгий срок обычно уменьшает платёж, но увеличивает общую выплату. Сначала подберём продукт под вашу задачу, затем посмотрим расчёт.', quickReplies:['Нужно закупить товар', 'Хочу купить оборудование']};
    }
    if (detected) { state.productId = detected[1]; state.purpose = message.trim().slice(0,500); }
    const amount = amountFrom(text, Boolean(state.productId && state.amount == null));
    const term = termFrom(text);
    if (amount !== null) state.amount = amount;
    if (term !== null) state.term = term;
    const product = products.find(item => item.id === state.productId);
    if (!product) return {state, answer:'Расскажите, на что нужны деньги: закупить товар, купить оборудование или покрыть кассовый разрыв? Подберём подходящий вид финансирования, затем уточним сумму и срок.', quickReplies:['Нужно закупить товар', 'Хочу купить оборудование', 'Нужно закрыть кассовый разрыв']};
    if (state.amount == null || state.amount < product.min_amount || state.amount > product.max_amount) {
      const invalid = state.amount != null;
      const amounts = [...new Set([500000, 1000000, 3000000].map(value => Math.min(product.max_amount, Math.max(product.min_amount, value))))];
      return {state, answer:invalid
        ? `Для продукта «${product.name}» доступна сумма от ${rubles(product.min_amount)} до ${rubles(product.max_amount)}. Какую сумму в этих пределах рассмотрим?`
        : `Для такой задачи можно рассмотреть «${product.name.toLocaleLowerCase('ru-RU')}». ${product.description} Какая сумма вам нужна?`, quickReplies:amounts.map(rubles)};
    }
    if (state.term == null || !Number.isInteger(state.term) || state.term < product.min_term || state.term > product.max_term) {
      const terms = [...new Set([12,24,36].map(value => Math.min(product.max_term, Math.max(product.min_term, value))))];
      return {state, answer:`На какой срок хотите взять ${rubles(state.amount)}? Для этого продукта доступно от ${product.min_term} до ${product.max_term} месяцев.`, quickReplies:terms.map(value => `${value} месяцев`)};
    }
    const offer = recommendation(state, products);
    return {state, answer:`Можно рассмотреть «${product.name.toLocaleLowerCase('ru-RU')}»: ${rubles(state.amount)} на ${state.term} мес. Ориентировочный платёж — ${rubles(offer.monthlyPayment)} в месяц. Условия собраны в карточке. Перенесите их в заявку, чтобы добавить финансовые данные и проверить параметры.`, quickReplies:['Какие документы нужны?', 'Как рассчитывается платёж?']};
  }
  const api = {reply, recommendation, amountFrom, termFrom};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CreditAdvisor = api;
})(globalThis);
