import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const template = await readFile(new URL('./app.html', import.meta.url), 'utf8');

test('Preferences contact uses the Pacifica support email', () => {
  assert.match(template, /<span class="preferences-value">AR&#64;Pacifica-farms\.com<\/span>/);
  assert.doesNotMatch(template, /modestofm22&#64;gmail\.com/);
});
