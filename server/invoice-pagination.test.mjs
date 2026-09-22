import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoicePagination, pageRows } from './invoice-pagination.mjs';

test('normalizes paged invoice requests to a bounded page and offset', () => {
  assert.deepEqual(parseInvoicePagination(new URL('https://portal.test/api/invoices?page=3&pageSize=100')), {
    page: 3, pageSize: 100, offset: 200
  });
});

test('pages reconciliation rows in blocks of 100', () => {
  const rows = Array.from({ length: 245 }, (_, index) => index);
  assert.deepEqual(pageRows(rows, parseInvoicePagination(new URL('https://portal.test/?page=3&pageSize=100'))), Array.from({ length: 45 }, (_, index) => index + 200));
});
