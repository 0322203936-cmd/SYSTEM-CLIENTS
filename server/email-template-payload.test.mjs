import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEmailTemplate } from './email-template-payload.mjs';

test('template catalog summary omits the large logo payload', () => {
  const result = summarizeEmailTemplate({ clientKey: 'demo', subject: 'Hi', logo: 'x'.repeat(100000) });
  assert.equal(result.clientKey, 'demo');
  assert.equal(result.subject, 'Hi');
  assert.equal(result.hasLogo, true);
  assert.equal(Object.hasOwn(result, 'logo'), false);
});
