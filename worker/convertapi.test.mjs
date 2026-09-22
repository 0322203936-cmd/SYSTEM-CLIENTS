import test from 'node:test';
import assert from 'node:assert/strict';
import { convertHeicToJpeg } from './convertapi.mjs';

test('converts HEIC bytes through ConvertAPI and downloads the JPG result', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(JSON.stringify({ Files: [{ Url: 'https://files.example/result.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  try {
    const result = await convertHeicToJpeg('secret', 'photo.heic', new Uint8Array([9, 8]));
    assert.deepEqual([...result], [1, 2, 3]);
    assert.equal(calls[0].url, 'https://v2.convertapi.com/convert/heic/to/jpg');
    assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
  } finally { globalThis.fetch = originalFetch; }
});
