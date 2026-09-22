import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReconciliationSnapshot, usableReconciliationSnapshot } from './reconciliation-cache.mjs';

test('reconciliation snapshots have a stable cache envelope', () => {
  const snapshot = buildReconciliationSnapshot('credits', { rows: [], totals: { excel: 0 } }, { source: 'credits.xlsx' });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.kind, 'credits');
  assert.equal(snapshot.cacheKey, 'current');
  assert.equal(snapshot.source, 'credits.xlsx');
  assert.equal(usableReconciliationSnapshot(snapshot, 'credits'), true);
  assert.equal(usableReconciliationSnapshot(snapshot, 'invoices'), false);
});
