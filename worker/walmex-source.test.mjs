import assert from 'node:assert/strict';
import test from 'node:test';
import { balanceForWalmexFolio, withTimeout } from './walmex-source.mjs';

test('withTimeout returns fallback instead of waiting for a slow Walmex query', async () => {
  const result = await withTimeout(new Promise(() => {}), 10, ['cached']);
  assert.deepEqual(result, ['cached']);
});

test('uses the invoice amount as the initial balance for a folio after the historical snapshot', () => {
  assert.equal(balanceForWalmexFolio('1171', 8516, '2026-09-11'), 8516);
});

test('uses the invoice amount from the August 11 cutoff onward even when the snapshot differs', () => {
  assert.equal(balanceForWalmexFolio('1162', 8516, '2026-09-09'), 8516);
});

test('uses the historical snapshot balance before the August 11 cutoff', () => {
  assert.equal(balanceForWalmexFolio('1162', 8516, '2026-08-10'), 10026);
});

test('keeps an absent folio at zero before the August 11 cutoff', () => {
  assert.equal(balanceForWalmexFolio('1153', 8516, '2026-08-10'), 0);
});
