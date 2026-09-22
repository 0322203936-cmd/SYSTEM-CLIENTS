import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCreditAllocationCandidates, flaggedInvoiceIds } from './credit-allocation.mjs';

const normalize = value => String(value || '').toLowerCase();
const availableBalance = invoice => Number(invoice.balance || 0);

test('identifies the invoice where a visible credit flag is displayed', () => {
  const invoices = [
    { id: 1, credits: [{ creditPdfPath: 'credit.pdf', creditFlagTargetInvoiceId: 2 }] },
    { id: 2, credits: [] },
    { id: 3, credits: [{ creditPdfPath: 'own-credit.pdf' }] }
  ];
  assert.deepEqual([...flaggedInvoiceIds(invoices)].sort(), [2, 3]);
});

test('Galleria allocates to the oldest positive balance without touching flagged invoices or the flag target', () => {
  const invoices = [
    { id: 1, client: 'Galleria Farms', issued: '2026-05-01', balance: 0, credits: [{ creditPdfPath: 'flag.pdf', creditFlagTargetInvoiceId: 4 }] },
    { id: 2, client: 'Galleria Farms', issued: '2026-06-02', balance: 400, credits: [] },
    { id: 3, client: 'Galleria Farms', issued: '2026-06-03', balance: 300, credits: [] },
    { id: 4, client: 'Galleria Farms', issued: '2026-06-01', balance: 500, credits: [] }
  ];
  const candidates = buildCreditAllocationCandidates({ invoices, matchedInvoice: invoices[1], customerKey: 'galleria farms', normalizeClientKey: normalize, availableBalance, useOldestUnflaggedRule: true });
  assert.deepEqual(candidates.map(invoice => invoice.id), [3]);
});

test('other customers continue applying the credit to the matched invoice first', () => {
  const invoices = [
    { id: 1, client: 'Other', issued: '2026-06-01', balance: 500, credits: [] },
    { id: 2, client: 'Other', issued: '2026-06-02', balance: 400, credits: [] }
  ];
  const candidates = buildCreditAllocationCandidates({ invoices, matchedInvoice: invoices[1], customerKey: 'other', normalizeClientKey: normalize, availableBalance, useOldestUnflaggedRule: false });
  assert.deepEqual(candidates.map(invoice => invoice.id), [2, 1]);
});
