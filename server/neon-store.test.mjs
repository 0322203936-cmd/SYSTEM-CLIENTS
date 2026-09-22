import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dbToStorageState,
  diffStorageStates,
  storageRowsToDb
} from './neon-store.mjs';

test('reconstructs collections and empty arrays from Neon rows', () => {
  const db = storageRowsToDb(
    [
      { collection: 'invoices', record_key: '1', record: { id: 1, folio: '100' } },
      { collection: 'invoices', record_key: '2', record: { id: 2, folio: '101' } }
    ],
    [
      { key: 'checks', value: [] },
      { key: 'preferences', value: { language: 'en' } }
    ]
  );

  assert.deepEqual(db, {
    invoices: [{ id: 1, folio: '100' }, { id: 2, folio: '101' }],
    checks: [],
    preferences: { language: 'en' }
  });
});

test('detects only the changed, added, and removed records', () => {
  const previous = dbToStorageState({
    invoices: [{ id: 1, balance: 100 }, { id: 2, balance: 200 }],
    checks: [],
    version: 1
  });
  const next = dbToStorageState({
    invoices: [{ id: 1, balance: 75 }, { id: 3, balance: 300 }],
    checks: [],
    version: 1
  });
  const changes = diffStorageStates(previous, next);

  assert.deepEqual(changes.recordDeletes.map(row => row.recordKey), ['2']);
  assert.deepEqual(changes.recordUpserts.map(row => row.recordKey), ['1', '3']);
  assert.deepEqual(changes.metadataDeletes, []);
  assert.deepEqual(changes.metadataUpserts, []);
});

test('preserves deterministic keys when duplicate ids exist', () => {
  const state = dbToStorageState({ invoices: [{ id: 7 }, { id: 7 }, {}] });
  assert.deepEqual(
    [...state.records.values()].map(row => row.recordKey),
    ['7', '7-1', '3']
  );
  assert.deepEqual(
    [...state.records.values()].map(row => row.position),
    [0, 1, 2]
  );
});
