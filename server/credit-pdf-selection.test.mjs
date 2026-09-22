import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedCreditPdfPath } from './credit-pdf-selection.mjs';

test('selects only the requested credit PDF from the invoice credits', () => {
  const invoice = { credits: [
    { creditNumber: '37301', creditPdfPath: 'credit-37301.pdf' },
    { creditNumber: '37313', creditPdfPath: 'credit-37313.pdf' }
  ] };
  assert.equal(selectedCreditPdfPath(invoice, invoice.credits[1]), 'credit-37313.pdf');
  assert.equal(selectedCreditPdfPath(invoice, { creditNumber: '37313', creditPdfPath: 'wrong.pdf' }), '');
});
