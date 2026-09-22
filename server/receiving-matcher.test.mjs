import test from 'node:test';
import assert from 'node:assert/strict';
import { findReceivingInvoices, shouldAppendMatchedReceiving } from './receiving-matcher.mjs';

test('does not associate a date-only reference with a different numeric invoice file reference', () => {
  const matches = findReceivingInvoices('INVOICE 7084 PO 17062026.jpg', [
    {
      folio: '7086',
      poNumber: '16062026',
      invoiceFileName: '17062026000000-7086.pdf'
    }
  ]);

  assert.deepEqual(matches, []);
});

test('associates an exact numeric reference', () => {
  const invoice = { folio: '7084', poNumber: '17062026', invoiceFileName: 'INVOICE 7084 PO 17062026.pdf' };
  const matches = findReceivingInvoices('17062026-7084.pdf', [invoice]);

  assert.deepEqual(matches, [invoice]);
});

test('associates a receiving using the complete hyphenated guide', () => {
  const invoice = {
    id: 7839,
    folio: '7839',
    guideNumber: '555-263410',
    invoiceFileName: '555-263410000000-7839.pdf'
  };
  const matches = findReceivingInvoices('555-263410.pdf', [invoice]);

  assert.deepEqual(matches, [invoice]);
});

test('does not confuse equal guide suffixes with different prefixes', () => {
  const invoice = {
    id: 7839,
    folio: '7839',
    guideNumber: '556-263410',
    invoiceFileName: '556-263410000000-7839.pdf'
  };
  const matches = findReceivingInvoices('555-263410.pdf', [invoice]);

  assert.deepEqual(matches, []);
});

test('returns every invoice that intentionally shares the complete guide', () => {
  const invoices = [
    { id: 7843, folio: '7843', guideNumber: '555-263414', invoiceFileName: '555-263414000000-7843.pdf' },
    { id: 7852, folio: '7852', guideNumber: '555-263414', invoiceFileName: '555-263414000000-7852.pdf' }
  ];

  assert.deepEqual(findReceivingInvoices('555-263414.pdf', invoices), invoices);
});

test('allows a unique individual receiving to append after a shared receiving in the same batch', () => {
  const invoice7825 = { id: 7825, folio: '7825' };
  const invoice7826 = { id: 7826, folio: '7826' };

  assert.equal(shouldAppendMatchedReceiving([invoice7825]), true);
  assert.equal(shouldAppendMatchedReceiving([invoice7826]), true);
  assert.equal(shouldAppendMatchedReceiving([invoice7825, invoice7826]), true);
  assert.equal(shouldAppendMatchedReceiving([]), false);
});
