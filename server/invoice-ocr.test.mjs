import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseOcr } from './invoice-ocr.mjs';

test('uses OCR when a PDF has no extractable text', () => {
  assert.equal(shouldUseOcr(''), true);
  assert.equal(shouldUseOcr('   \n\t'), true);
});

test('does not use OCR when the PDF already exposes readable text', () => {
  assert.equal(shouldUseOcr('Invoice No.\n7084'), false);
});
