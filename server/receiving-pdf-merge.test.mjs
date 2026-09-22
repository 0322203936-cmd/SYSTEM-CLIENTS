import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { mergeReceivingPdfBuffers, PRINT_PAGE_HEIGHT, PRINT_PAGE_WIDTH } from './receiving-pdf-merge.mjs';

async function createPdf(pageCount) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) pdf.addPage([120, 120]);
  return Buffer.from(await pdf.save());
}

test('appends a shared receiving document without dropping the original pages', async () => {
  const merged = await mergeReceivingPdfBuffers([await createPdf(1), await createPdf(2)]);
  const result = await PDFDocument.load(merged);

  assert.equal(result.getPageCount(), 3);
  result.getPages().forEach(page => {
    assert.equal(page.getWidth(), PRINT_PAGE_WIDTH);
    assert.equal(page.getHeight(), PRINT_PAGE_HEIGHT);
  });
});

test('requires at least two documents to merge', async () => {
  const source = await createPdf(1);

  await assert.rejects(() => mergeReceivingPdfBuffers([source]), /al menos dos PDFs/);
});
