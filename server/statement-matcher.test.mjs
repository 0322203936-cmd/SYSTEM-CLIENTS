import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStatementRows } from './statement-matcher.mjs';

function assignments(invoices, rows) {
  const result = matchStatementRows(invoices, rows);
  return Object.fromEntries(result.matches.map(match => [rows[match.rowIndex].key, invoices[match.invoiceIndex].folio]));
}

test('reserves exact invoice and PO pairs when the PO is shared', () => {
  const invoices = [
    { folio: '7354', poNumber: '15072026', issued: '2026-07-15' },
    { folio: '7348', poNumber: '15072026', issued: '2026-07-15' }
  ];
  const rows = [
    { key: 'paid', invoice: '7354', po: '15072026', date: '2026-07-15' },
    { key: 'open', invoice: '7348', po: '15072026', date: '2026-07-15' }
  ];
  assert.deepEqual(assignments(invoices, rows), { paid: '7354', open: '7348' });
});

test('uses the PO to disambiguate repeated invoice numbers', () => {
  const invoices = [
    { folio: '7323', poNumber: '28mayesh', issued: '2026-07-10' },
    { folio: '7323', poNumber: '1688329', issued: '2026-07-08' }
  ];
  const rows = [
    { key: 'mayesh', invoice: '7323', po: '28mayesh', date: '2026-07-10' },
    { key: 'norcal', invoice: '7323', po: '1688329', date: '2026-07-08' }
  ];
  assert.deepEqual(assignments(invoices, rows), { mayesh: '7323', norcal: '7323' });
});

test('supports a ContPAQ PO that corresponds to the system invoice', () => {
  const invoices = [
    { folio: 'W000238', poNumber: 'W000238', issued: '2026-07-10' },
    { folio: '7324', poNumber: '362764', issued: '2026-07-08' }
  ];
  const rows = [
    { key: 'sieck', invoice: '7324', po: 'W000238', date: '2026-07-10' },
    { key: 'safeway', invoice: '7324', po: '362764', date: '2026-07-08' }
  ];
  assert.deepEqual(assignments(invoices, rows), { sieck: 'W000238', safeway: '7324' });
});

test('prefers a statement PO that names a system invoice over a conflicting isolated folio', () => {
  const invoices = [
    { folio: 'W000238', poNumber: 'W000238', issued: '2026-07-10' },
    { folio: '7324', poNumber: '362764', issued: '2026-07-08' }
  ];
  const rows = [{ key: 'sieck', invoice: '7324', po: 'W000238', date: '2026-07-10' }];
  assert.deepEqual(assignments(invoices, rows), { sieck: 'W000238' });
});

test('matches a controlled trailing A folio variant when the date agrees', () => {
  const invoices = [{ folio: '7557A', poNumber: '108112', issued: '2026-07-30' }];
  const rows = [{ key: 'kendall', invoice: '7557', po: '108125', date: '2026-07-30' }];
  assert.deepEqual(assignments(invoices, rows), { kendall: '7557A' });
});

test('does not assign an ambiguous PO fallback', () => {
  const invoices = [
    { folio: 'A-1', poNumber: 'SHARED', issued: '2026-07-01' },
    { folio: 'A-2', poNumber: 'SHARED', issued: '2026-07-01' }
  ];
  const rows = [{ key: 'ambiguous', invoice: 'UNKNOWN', po: 'SHARED', date: '2026-07-01' }];
  assert.deepEqual(assignments(invoices, rows), {});
});
