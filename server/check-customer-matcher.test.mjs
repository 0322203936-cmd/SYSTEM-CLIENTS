import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCustomersMatch } from './check-customer-matcher.mjs';

test('allows aliases from the same customer group in Checks', () => {
  assert.equal(checkCustomersMatch('Bill Doran Company - Dallas', 'Bill Doran - Herrin'), true);
  assert.equal(checkCustomersMatch('Bill Doran Everflora', 'Bill Doran Springfield'), true);
  assert.equal(checkCustomersMatch('Bill Doran - San Antonio', 'Bill Doran Portland'), true);
  assert.equal(checkCustomersMatch('Trader Joes', "Trader Joe's"), true);
  assert.equal(checkCustomersMatch('WFS - SPOKANE', 'Washington Floral Service, Inc.-Spokane'), true);
  assert.equal(checkCustomersMatch('Galleria Farms FLORES', 'Galleria Farms'), true);
});

test('does not allow an unrelated customer in an alias group', () => {
  assert.equal(checkCustomersMatch('Arizona Floral Exchange', 'Bill Doran - Herrin'), false);
  assert.equal(checkCustomersMatch('Stemline Wholesale', 'Trader Joe\'s'), false);
});

test('keeps strict matching for non-Bill Doran customers', () => {
  assert.equal(checkCustomersMatch('Galleria Farms', 'galleria farms'), true);
  assert.equal(checkCustomersMatch('Galleria Farms', 'Allure Farms'), false);
});
