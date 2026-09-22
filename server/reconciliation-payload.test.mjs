import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReconciliationInvoice } from './reconciliation-payload.mjs';

test('keeps only fields needed to reconcile an invoice', () => {
  const result = projectReconciliationInvoice({ id: '7', folio: '7196', client: 'Galleria Farms', amount: '100', balance: '80', searchText: 'large text' });
  assert.deepEqual(result, { id: 7, folio: '7196', poNumber: '', client: 'Galleria Farms', issued: '', amount: 100, balance: 80, creditAmount: 0, status: '', credits: [] });
  assert.equal('searchText' in result, false);
});
