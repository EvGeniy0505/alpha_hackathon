'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {join} = require('node:path');
const advisor = require('../static/advisor.js');
const products = JSON.parse(execFileSync(process.env.PYTHON || 'python',
  ['-c', 'import json; from scoring import PRODUCTS; print(json.dumps(PRODUCTS))'],
  {cwd:join(__dirname, '..'), encoding:'utf8'}));
const blank = () => ({productId:null, amount:null, term:null, purpose:''});

test('free-text goal, amount and term produce transferable conditions', () => {
  const result = advisor.reply('Нужно 800 тысяч рублей на закупку товара на 18 месяцев', blank(), products);
  const offer = advisor.recommendation(result.state, products);
  assert.equal(offer.product.id, 'working_capital');
  assert.equal(offer.amount, 800000);
  assert.equal(offer.term, 18);
  assert.ok(offer.monthlyPayment > 51000 && offer.monthlyPayment < 52000);
  assert.equal(blank().amount, null);
});
test('multi-turn conversation preserves the previous answers', () => {
  const goal = advisor.reply('Хочу купить оборудование', blank(), products);
  assert.equal(goal.state.productId, 'equipment');
  assert.equal(advisor.recommendation(goal.state, products), null);
  const amount = advisor.reply('1 500 000 ₽', goal.state, products);
  assert.equal(amount.state.amount, 1500000);
  assert.equal(advisor.recommendation(amount.state, products), null);
  const term = advisor.reply('На три года', amount.state, products);
  assert.equal(advisor.recommendation(term.state, products).term, 36);
  assert.equal(goal.state.amount, null, 'earlier context is not mutated');
});
test('Russian years, commas, fractions and half-year parse consistently', () => {
  for (const [text, expected] of [['на 2 года',24],['на 5 лет',60],['на год',12],['на 1,5 года',18],['на полгода',6]]) {
    assert.equal(advisor.termFrom(text), expected, text);
  }
  assert.equal(advisor.amountFrom('1,5 млн рублей', false), 1500000);
  assert.equal(advisor.amountFrom('800 000 рублей', false), 800000);
});
test('amounts with Russian grouping spaces are read in full, including quick replies', () => {
  const goal = advisor.reply('Хочу купить оборудование', blank(), products);
  for (const space of [' ', '\u00a0', '\u202f']) {
    for (const suffix of ['', ' ₽', ' рублей']) {
      const text = `1${space}500${space}000${suffix}`;
      const result = advisor.reply(text, goal.state, products);
      assert.equal(result.state.amount, 1500000, text);
      assert.match(result.answer, /На какой срок/);
    }
  }
  for (const text of goal.quickReplies) {
    const result = advisor.reply(text, goal.state, products);
    assert.equal(result.state.amount, Number(text.replace(/\D/g, '')), text);
    assert.match(result.answer, /На какой срок/);
  }
});
test('a bare amount corrects an out-of-range answer and allows the handoff', () => {
  for (const invalidAmount of ['900 млн', '-500 тыс', '1 рубль']) {
    const invalid = advisor.reply(`Нужно ${invalidAmount} на закупку товара на 12 месяцев`, blank(), products);
    assert.equal(advisor.recommendation(invalid.state, products), null);
    const corrected = advisor.reply('1000000', invalid.state, products);
    assert.equal(advisor.recommendation(corrected.state, products).amount, 1000000);
    assert.equal(corrected.state.term, 12);
  }
});
test('exact product amount limits are accepted after an invalid amount', () => {
  for (const product of products) {
    for (const amount of [product.min_amount, product.max_amount]) {
      const state = {productId:product.id, amount:product.max_amount + 1, term:product.min_term, purpose:'Закупка'};
      const result = advisor.reply(String(amount), state, products);
      assert.equal(advisor.recommendation(result.state, products)?.amount, amount, product.id);
    }
  }
});
test('negative bare amounts stay invalid and term-only answers preserve the amount', () => {
  const goal = advisor.reply('Нужно закупить товар', blank(), products);
  const invalid = advisor.reply('-500000', goal.state, products);
  assert.equal(invalid.state.amount, -500000);
  assert.equal(advisor.recommendation(invalid.state, products), null);
  const corrected = advisor.reply('800000,50', invalid.state, products);
  assert.equal(corrected.state.amount, 800000.5);
  const term = advisor.reply('18 месяцев', corrected.state, products);
  assert.equal(advisor.recommendation(term.state, products).amount, 800000.5);
  assert.equal(term.state.term, 18);
});
test('out-of-range and negative amounts never enable the form handoff', () => {
  for (const text of ['Нужно 900 млн на закупку товара на 12 месяцев', 'Нужно -500 тыс на товар на 12 месяцев']) {
    const result = advisor.reply(text, blank(), products);
    assert.equal(advisor.recommendation(result.state, products), null);
    assert.match(result.answer, /доступна сумма/);
  }
});
test('fractional and out-of-range terms cannot be transferred', () => {
  for (const term of [-12, 1.5, 500]) {
    assert.equal(advisor.recommendation({productId:'working_capital',amount:800000,term}, products), null);
  }
  assert.equal(advisor.termFrom('на -12 месяцев'), -12);
});
test('bare numbers answer the term question without changing the selected amount', () => {
  const state = {productId:'overdraft',amount:499999,term:null,purpose:'Кассовый разрыв'};
  for (const [message, expected] of [['3',3],['5',5],['на 6',6],[' 12 ',12]]) {
    const result = advisor.reply(message, state, products);
    const offer = advisor.recommendation(result.state, products);
    assert.equal(offer.term, expected, message);
    assert.equal(offer.amount, 499999, message);
  }
  assert.equal(state.term, null);
});
test('invalid bare terms ask again and can be corrected with another bare number', () => {
  const state = {productId:'overdraft',amount:499999,term:null,purpose:'Кассовый разрыв'};
  for (const message of ['0','13','-3','1,5']) {
    const invalid = advisor.reply(message, state, products);
    assert.equal(advisor.recommendation(invalid.state, products), null, message);
    assert.match(invalid.answer, /от 1 до 12 месяцев/);
    assert.equal(invalid.state.amount, 499999);
    const corrected = advisor.reply('5', invalid.state, products);
    assert.equal(advisor.recommendation(corrected.state, products).term, 5);
  }
});
test('an amount-only answer does not also become the term', () => {
  const goal = advisor.reply('Нужно закрыть кассовый разрыв', blank(), products);
  const amount = advisor.reply('499999', goal.state, products);
  assert.equal(amount.state.amount, 499999);
  assert.equal(amount.state.term, null);
  assert.match(amount.answer, /На какой срок/);
  assert.equal(advisor.termFrom('3'), null, 'a bare number requires a term question');
});
test('bare term answers accept the exact limits of each product', () => {
  for (const product of products) {
    const state = {productId:product.id,amount:product.min_amount,term:null,purpose:'Финансирование бизнеса'};
    for (const term of [product.min_term,product.max_term]) {
      const result = advisor.reply(String(term), state, products);
      assert.equal(advisor.recommendation(result.state, products)?.term, term, product.id);
    }
  }
});
test('document questions preserve the chosen conditions', () => {
  const state = {productId:'working_capital',amount:800000,term:18,purpose:'Закупка товара'};
  const result = advisor.reply('Какие документы нужны?', state, products);
  assert.deepEqual(result.state, state);
  assert.match(result.answer, /CSV/);
  assert.match(result.answer, /кредитной истории/);
});
test('the advisor explains the process without approving a loan', () => {
  const result = advisor.reply('Вы точно одобрите кредит?', blank(), products);
  assert.match(result.answer, /после проверки/);
  assert.equal(advisor.recommendation(result.state, products), null);
});
test('unknown requests ask a clarifying question and do not invent conditions', () => {
  const result = advisor.reply('Хочу узнать подробнее', blank(), products);
  assert.equal(result.state.productId, null);
  assert.equal(advisor.recommendation(result.state, products), null);
  assert.ok(result.quickReplies.length > 0);
});
