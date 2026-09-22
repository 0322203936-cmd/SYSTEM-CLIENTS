import test from 'node:test';
import assert from 'node:assert/strict';
import { publicEmailStatus } from './email-status.mjs';

test('public email status exposes readiness and sender addresses but no secrets', () => {
  const result = publicEmailStatus({
    mailReady: true,
    mailFrom: 'billing@pacifica-farms.com',
    mailFromCentro: 'billing-centro@pacifica-farms.com',
    clientSecret: 'must-not-leak',
    tenantId: 'must-not-leak-either',
  });

  assert.deepEqual(result, {
    mailReady: true,
    mailFrom: 'billing@pacifica-farms.com',
    mailFromCentro: 'billing-centro@pacifica-farms.com',
  });
});

test('public email status represents missing sender configuration as not ready', () => {
  assert.deepEqual(publicEmailStatus({ mailReady: false }), {
    mailReady: false,
    mailFrom: '',
    mailFromCentro: '',
  });
});
