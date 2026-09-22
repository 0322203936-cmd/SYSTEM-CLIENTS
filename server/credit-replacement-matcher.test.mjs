import assert from 'node:assert/strict';
import test from 'node:test';
import { findCreditRecords } from './credit-replacement-matcher.mjs';

const normalize = value => String(value || '').toLowerCase().replace(/\s+co\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

test('finds a unique applied credit by number when the PDF customer has a naming suffix', () => {
  const invoices = [{ id: 1, client: 'Bill Doran - Green Bay', credits: [{ creditNumber: '37308', amount: 27.5 }] }];
  const records = findCreditRecords(invoices, '37308', 'Bill Doran Co - Green Bay', normalize);
  assert.equal(records.length, 1);
  assert.equal(records[0].invoice.id, 1);
});

test('does not guess when the same credit number exists for multiple customers', () => {
  const invoices = [
    { id: 1, client: 'Alpha', credits: [{ creditNumber: '37308', amount: 10 }] },
    { id: 2, client: 'Beta', credits: [{ creditNumber: '37308', amount: 10 }] },
  ];
  assert.deepEqual(findCreditRecords(invoices, '37308', 'Unknown', normalize), []);
});
