import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKometInvoiceVariant } from './komet-invoice-variant.mjs';

test('extracts Komet invoice variant with Invoice Date after the label', () => {
  const text = `Invoice # W000292
Invoice Date 09/11/2026
Amount $222.00
PO #
Bill To                                      Sieck Wright Floral Products
Totals              $222.00`;
  assert.deepEqual(extractKometInvoiceVariant(text), {
    folio: 'W000292',
    client: 'Sieck Wright Floral Products',
    issued: '2026-09-11',
    amount: 222,
    poNumber: 'W000292',
    guideNumber: ''
  });
});

test('extracts the bill-to customer from the two-column Komet header', () => {
  const text = `Invoice #                W000292
Invoice Date             09/11/2026
Amount                   $222.00
PO #
Bill To                                      Ship To                                             Carrier
Sieck Wright Floral Products                 Sieck Wright Floral Products                        Armellini - Regular
Totals              $222.00`;
  assert.equal(extractKometInvoiceVariant(text).client, 'Sieck Wright Floral Products');
});
