import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleStatementCompanies } from './statement-company-policy.mjs';

test('limits a client account to the issuers represented by its visible invoices', () => {
  assert.deepEqual(visibleStatementCompanies('client', ['pacifica']), ['pacifica']);
  assert.deepEqual(visibleStatementCompanies('client', ['pacifica', 'centro']), ['pacifica', 'centro']);
});

test('keeps both company filters for administrators', () => {
  assert.deepEqual(visibleStatementCompanies('admin', ['pacifica']), ['pacifica', 'centro']);
});
