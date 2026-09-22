import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDosGringosInvoice, parseShipDate } from './dos-gringos-invoice.mjs';

test('parses English month product invoice', () => {
  const result = extractDosGringosInvoice(`
    CENTRO FLORICULTOR DE BAJA CALIFORNIA SA DE CV
    INVOICE: 6678
    PO: DG-006880
    SHIP DATE: APR-07-2026
    Customer:
    GRINGO SOUTH SA DE CV
    TOTAL $7,275.750
  `);
  assert.deepEqual(result, {
    folio: '6678',
    poNumber: 'DG-006880',
    issued: '2026-04-07',
    client: 'GRINGO SOUTH SA DE CV',
    amount: 7275.75,
    format: 'dos-gringos-product'
  });
});

test('parses numeric month/day and Gringo Ventures name', () => {
  const result = extractDosGringosInvoice(`
    CENTRO FLORICULTOR DE BAJA CALIFORNIA SA DE CV
    INVOICE: 7639
    PO: 29082026
    SHIP DATE: 08-28-2026
    Customer: Gringo Ventures DBA Dos Gringos
    TOTAL
    1,190.40
  `);
  assert.equal(result.issued, '2026-08-28');
  assert.equal(result.client, 'Gringo Ventures DBA Dos Gringos');
  assert.equal(result.amount, 1190.4);
});

test('accepts invoice and PO headers without punctuation', () => {
  const result = extractDosGringosInvoice(`
    CENTRO FLORICULTOR DE BAJA CALIFORNIA SA DE CV
    INVOICE 7638
    PO 008010
    SHIP DATE SEP-27-2026
    Customer: GRINGO SOUTH SA DE CV
    TOTAL 4,060.950
  `);
  assert.equal(result.folio, '7638');
  assert.equal(result.poNumber, '008010');
  assert.equal(result.issued, '2026-09-27');
  assert.equal(result.amount, 4060.95);
});

test('does not mistake the Address label for the customer', () => {
  const result = extractDosGringosInvoice(`
    CENTRO FLORICULTOR DE BAJA CALIFORNIA SA DE CV
    INVOICE: 7625
    PO: 007757
    SHIP DATE: AUG-28-2026
    Customer:
    Address:
    GRINGO SOUTH SA DE CV
    TOTAL 99.300
  `);
  assert.equal(result.client, 'GRINGO SOUTH SA DE CV');
});

test('accepts the freight order label without claiming a non-Dos Gringos PDF', () => {
  const result = extractDosGringosInvoice(`
    CENTRO FLORICULTOR DE BAJA CALIFORNIA SA DE CV
    INVOICE: 264
    ORDEN DE COMPRA: 264-0226
    SHIP DATE: ENERO-10-2026
    Customer: GRINGO SOUTH SA DE CV
    TOTAL 160.00
  `);
  assert.equal(result.poNumber, '264-0226');
  assert.equal(result.issued, '2026-01-10');
  assert.equal(result.amount, 160);
});

test('accepts an explicit dash total as a zero-value Dos Gringos invoice', () => {
  const result = extractDosGringosInvoice(`
    CENTRO FLORICULTOR DE BAJA CALIFORNIA SA DE CV
    INVOICE: 7652
    PO: 20092026-2
    SHIP DATE: 09-18-2026
    Customer: Gringo Ventures DBA Dos Gringos
    TOTAL                                               -
  `);
  assert.deepEqual(result, {
    folio: '7652',
    poNumber: '20092026-2',
    issued: '2026-09-18',
    client: 'Gringo Ventures DBA Dos Gringos',
    amount: 0,
    format: 'dos-gringos-product'
  });
});

test('does not claim unrelated invoices', () => {
  assert.equal(extractDosGringosInvoice('INVOICE: 123\nCustomer: Other Flowers\nTOTAL 10.00'), null);
});

test('parses both numeric date orientations safely', () => {
  assert.equal(parseShipDate('05-18-2026'), '2026-05-18');
  assert.equal(parseShipDate('18-05-2026'), '2026-05-18');
});
