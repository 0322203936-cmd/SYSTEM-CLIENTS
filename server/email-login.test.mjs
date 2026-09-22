import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmailLogin, historyInvoiceAccess, canSendEmailForInvoice, canSendStatementForCustomer, resolveEmailDeliveryRecipients } from './email-login.mjs';
const key = value => String(value || '').trim().toLowerCase().replaceAll(' ', '-');
const db = { users: [], invoices: [{id: 1, client: 'Galleria Farms'}, {id: 2, client: 'Other'}], emailLog: [
  {invoiceId: 1, to: ['buyer@example.com'], cc: ['copy@example.com'], sentAt: '2026-09-14'},
] };
test('To recipient receives only associated customers, never admin permissions', () => {
  const result = resolveEmailLogin(db, ' BUYER@EXAMPLE.COM ', key);
  assert.equal(result.kind, 'history');
  assert.deepEqual(result.user.assignedClients, ['galleria-farms']);
  assert.equal(result.user.role, 'client');
  assert.ok(result.user.permissions.includes('dashboard'));
  assert.ok(!result.user.permissions.includes('settings'));
  assert.ok(result.user.permissions.includes('preferences'));
  assert.equal(historyInvoiceAccess(result.user, db.invoices[0], key), true);
  assert.equal(historyInvoiceAccess(result.user, db.invoices[1], key), false);
});
test('CC, unknown and partial addresses never grant access', () => {
  for (const email of ['copy@example.com', 'sent-by-client@example.com', 'unknown@example.com', 'buyer', '']) {
    assert.equal(resolveEmailLogin(db, email, key).kind, 'denied');
  }
  const clientSentLog = {...db, emailLog: [{invoiceId: 1, to: ['sent-by-client@example.com'], sentAt: '2026-09-14', sentByRole: 'client'}]};
  assert.equal(resolveEmailLogin(clientSentLog, 'sent-by-client@example.com', key).kind, 'denied');
});
test('existing manual accounts, including inactive ones, cannot bypass password', () => {
  for (const active of [true, false]) {
    const result = resolveEmailLogin({...db, users: [{id: 4, email: 'buyer@example.com', role: 'admin', active}]}, 'buyer@example.com', key);
    assert.equal(result.kind, 'manual');
    assert.equal(result.user.id, 4);
  }
});
test('multiple customers deduplicate; CC-only customer is excluded', () => {
  const result = resolveEmailLogin({...db, emailLog: [...db.emailLog, ...db.emailLog,
  {invoiceId: 2, to: ['someone@example.com'], cc: ['buyer@example.com'], sentAt: '2026-09-14'},
    {invoiceId: 2, to: ['sent-by-client@example.com'], sentAt: '2026-09-14', sentByRole: 'client'},
    {clientKey: 'third', to: ['buyer@example.com'], sentAt: '2026-09-14'}]}, 'buyer@example.com', key);
  assert.deepEqual(result.user.assignedClients, ['galleria-farms', 'third']);
});
test('unattributed or unsent entries cannot authorize a customer', () => {
  assert.equal(resolveEmailLogin({...db, emailLog: [{to: ['buyer@example.com'], sentAt:'2026-09-14'}, {to:['buyer@example.com'], clientKey:'other'}]}, 'buyer@example.com', key).kind, 'denied');
});

test('email-history client can send only documents for assigned customers', () => {
  const user = resolveEmailLogin(db, 'buyer@example.com', key).user;
  assert.equal(canSendEmailForInvoice(user, db.invoices[0], key), true);
  assert.equal(canSendEmailForInvoice(user, db.invoices[1], key), false);
  assert.equal(canSendStatementForCustomer(user, 'Galleria Farms', db.invoices, key), true);
  assert.equal(canSendStatementForCustomer(user, 'Other', db.invoices, key), false);
});

test('manual client account is limited to its customer while admin retains access', () => {
  const client = { role: 'client', clientKey: 'galleria-farms' };
  const assignedClient = { role: 'client', assignedClients: ['Galleria Farms'] };
  const admin = { role: 'admin' };
  assert.equal(canSendEmailForInvoice(client, db.invoices[0], key), true);
  assert.equal(canSendEmailForInvoice(client, db.invoices[1], key), false);
  assert.equal(canSendStatementForCustomer(client, 'Other', db.invoices, key), false);
  assert.equal(canSendEmailForInvoice(assignedClient, db.invoices[0], key), true);
  assert.equal(canSendEmailForInvoice(assignedClient, db.invoices[1], key), false);
  assert.equal(canSendEmailForInvoice(admin, db.invoices[1], key), true);
  assert.equal(canSendStatementForCustomer(admin, 'Other', db.invoices, key), true);
});

test('non-admin email deliveries are forced to the signed-in address with no CC', () => {
  assert.deepEqual(resolveEmailDeliveryRecipients({ role: 'client', email: 'client@example.com' }, 'external@example.com', 'copy@example.com'), {
    to: 'client@example.com', cc: ''
  });
  assert.deepEqual(resolveEmailDeliveryRecipients({ role: 'user', email: 'user@example.com' }, 'external@example.com', 'copy@example.com'), {
    to: 'user@example.com', cc: ''
  });
  assert.deepEqual(resolveEmailDeliveryRecipients({ role: 'admin' }, 'recipient@example.com', 'copy@example.com'), {
    to: 'recipient@example.com', cc: 'copy@example.com'
  });
});
