import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseWalmexCache } from './walmex-cache-policy.mjs';

test('does not use Walmex cache after an authorization failure', () => {
  assert.equal(shouldUseWalmexCache(401), false);
  assert.equal(shouldUseWalmexCache(403), false);
});

test('may use Walmex cache for a transient non-authorization failure', () => {
  assert.equal(shouldUseWalmexCache(0), true);
  assert.equal(shouldUseWalmexCache(503), true);
});
