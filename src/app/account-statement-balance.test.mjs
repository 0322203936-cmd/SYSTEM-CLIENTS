import test from 'node:test';
import assert from 'node:assert/strict';
import { accountStatementInvoiceBalance } from './account-statement-balance.mjs';

test('excludes checks applied after the statement cutoff', () => {
  assert.equal(accountStatementInvoiceBalance({ amount: 1000, balance: 250, creditAmount: 100, status: 'Pendiente', checkApplications: [{ date: '2026-08-20', amount: 400 }, { date: '2026-09-03', amount: 350 }] }, '2026-08-31'), 600);
});

test('restores a later check when it made the invoice paid', () => {
  assert.equal(accountStatementInvoiceBalance({ amount: 500, balance: 0, creditAmount: 0, status: 'Pagada', checkApplications: [{ date: '2026-09-02', amount: 500 }] }, '2026-08-31'), 500);
});

test('keeps checks applied by the cutoff in the saved balance', () => {
  assert.equal(accountStatementInvoiceBalance({ amount: 500, balance: 0, creditAmount: 125, status: 'Pagada', credits: [{ date: '2026-08-01', amount: 125 }], checkApplications: [{ date: '2026-08-20', amount: 375 }] }, '2026-08-31'), 0);
});

test('uses the current saved balance when there is no To cutoff', () => {
  assert.equal(accountStatementInvoiceBalance({ amount: 1000, balance: 250, creditAmount: 100, status: 'Pendiente', checkApplications: [{ date: '2026-09-03', amount: 650 }] }), 250);
  assert.equal(accountStatementInvoiceBalance({ amount: 500, balance: 0, status: 'Pagada', checkApplications: [{ date: '2026-09-03', amount: 500 }] }), 0);
});

test('rebuilds a historical balance from dated credits and checks', () => {
  assert.equal(accountStatementInvoiceBalance({ amount: 112, balance: 0, creditAmount: 112, status: 'Pagada', credits: [{ date: '2026-07-03', amount: 56 }], checkApplications: [{ date: '2026-09-09', amount: 56 }] }, '2026-08-31'), 56);
});
