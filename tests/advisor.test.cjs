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
