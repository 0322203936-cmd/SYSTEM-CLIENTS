import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('statement email action is restricted to administrators', async () => {
  const html = await readFile(new URL('../src/app/app.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /@if \(user\(\)!\.role === 'admin'\)\s*\{\s*<button[^>]*class="stmt-mail-button"/s,
    'statement email action must be inside admin-only block'
  );
});
