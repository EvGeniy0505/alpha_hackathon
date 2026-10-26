'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sandbox = {document:{querySelectorAll:() => [], getElementById:() => null}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/landing.js'),'utf8'),sandbox);

test('public example matches the existing annuity calculation', () => {
  assert.equal(sandbox.examplePayment(800000,18),51618);
  assert.equal(sandbox.examplePayment(800000,36),29527);
  assert.equal(sandbox.examplePayment(120000,12,0),10000);
});

test('longer terms reduce monthly payments but increase total repayments', () => {
  const short = sandbox.examplePayment(800000,18), long = sandbox.examplePayment(800000,36);
  assert.ok(long < short);
  assert.ok(long * 36 > short * 18);
  assert.ok(Math.abs(sandbox.examplePayment(1600000,18) - 2 * short) <= 1);
});
