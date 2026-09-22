import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSaveEmailTemplate } from './email-template-save.mjs';

test('saves a template by default when the flag is missing', () => {
  assert.equal(shouldSaveEmailTemplate(undefined), true);
  assert.equal(shouldSaveEmailTemplate(true), true);
  assert.equal(shouldSaveEmailTemplate('true'), true);
});

test('respects an explicit opt-out', () => {
  assert.equal(shouldSaveEmailTemplate(false), false);
  assert.equal(shouldSaveEmailTemplate('false'), false);
});
