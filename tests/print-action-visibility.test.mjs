import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('invoice print action is not restricted to administrators', async () => {
  const html = await readFile(new URL('../src/app/app.html', import.meta.url), 'utf8');
  const actionLine = html.split('\n').find(line => line.includes('portal-icon-action-print'));
  assert.ok(actionLine, 'invoice action row should contain the print button');
  const printIndex = actionLine.indexOf('portal-icon-action-print');
  const adminIndex = actionLine.lastIndexOf('@if (user()!.role === \'admin\')');
  assert.ok(adminIndex < 0 || printIndex < adminIndex, 'print button must appear before the admin-only block');
});
