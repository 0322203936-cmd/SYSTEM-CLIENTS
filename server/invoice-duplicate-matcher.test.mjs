import test from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateInvoice } from './invoice-duplicate-matcher.mjs';

test('does not mark a different folio as duplicate when PO and amount match', () => {
  const existing = { folio: '6995', client: 'Bill Doran Portland', poNumber: '11062026', amount: 209 };
  const incoming = { folio: '7031', client: 'Bill Doran Portland', poNumber: '11062026', amount: 209 };

  assert.equal(isDuplicateInvoice(existing, incoming), false);
});

test('marks the same client and folio as duplicate', () => {
  const existing = { folio: '6995', client: 'Bill Doran Portland', poNumber: '11062026', amount: 209 };
  const incoming = { folio: '6995', client: 'Bill Doran Portland', poNumber: 'different', amount: 999 };

  assert.equal(isDuplicateInvoice(existing, incoming), true);
});
