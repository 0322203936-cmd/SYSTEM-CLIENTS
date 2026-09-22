import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJasperKometInvoiceTotal } from './invoice-total-matcher.mjs';

test('extracts Inv. Total instead of discount from the JasperReports layout', () => {
  const text = `
    $190.80
    Invoice #
    W000063
    Packages
    $285.60
    5 Total Pkgs Inv. Subtotal
    Inv. Total
    $94.80 Discount Amt.
  `;

  assert.equal(extractJasperKometInvoiceTotal(text), '190.80');
});

test('does not apply the JasperReports detector to another layout', () => {
  assert.equal(extractJasperKometInvoiceTotal('Invoice Total $190.80'), '');
});
