import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceSearchText } from './invoice-search.mjs';

test('indexes product descriptions without accents and without duplicate terms', () => {
  const index = buildInvoiceSearchText('Mameluca médica azul\nMAMELUCA talla mediana');

  assert.equal(index, 'mameluca medica azul talla mediana');
  assert.match(index, /\bmameluca\b/);
});

test('keeps invoice references searchable with product terms', () => {
  const index = buildInvoiceSearchText('Invoice 7825 PO 106976795 Product: Mameluca');

  assert.match(index, /\b7825\b/);
  assert.match(index, /\b106976795\b/);
  assert.match(index, /\bmameluca\b/);
});
