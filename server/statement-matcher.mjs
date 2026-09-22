function normalizeReference(value) {
  const compact = String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
  if (!compact) return '';
  return /^\d+$/.test(compact) ? compact.replace(/^0+(?=\d)/, '') : compact;
}

function normalizeDate(value) {
  return String(value ?? '').trim().slice(0, 10);
}

function trailingAVariantMatches(left, right) {
  const normalizedLeft = normalizeReference(left);
  const normalizedRight = normalizeReference(right);
  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) return false;
  return normalizedLeft.replace(/A$/, '') === normalizedRight.replace(/A$/, '')
    && (normalizedLeft.endsWith('A') || normalizedRight.endsWith('A'));
}

/**
 * Produces deterministic one-to-one assignments between invoices and rows from
 * the uploaded account statement. A fallback is accepted only when both sides
 * have one unique candidate in that matching stage.
 */
export function matchStatementRows(invoices, rows) {
  const unmatchedInvoiceIndexes = new Set(invoices.map((_, index) => index));
  const unmatchedRowIndexes = new Set(rows.map((_, index) => index));
  const matches = [];

  const runPass = (method, predicate) => {
    const candidatesByRow = new Map();
    const rowsByInvoice = new Map();

    for (const rowIndex of unmatchedRowIndexes) {
      const candidates = [];
      for (const invoiceIndex of unmatchedInvoiceIndexes) {
        if (predicate(invoices[invoiceIndex], rows[rowIndex])) candidates.push(invoiceIndex);
      }
      candidatesByRow.set(rowIndex, candidates);
      for (const invoiceIndex of candidates) {
        const candidateRows = rowsByInvoice.get(invoiceIndex) || [];
        candidateRows.push(rowIndex);
        rowsByInvoice.set(invoiceIndex, candidateRows);
      }
    }

    const accepted = [];
    for (const [rowIndex, candidates] of candidatesByRow) {
      if (candidates.length !== 1) continue;
      const invoiceIndex = candidates[0];
      if ((rowsByInvoice.get(invoiceIndex) || []).length !== 1) continue;
      accepted.push({ rowIndex, invoiceIndex, method });
    }

    for (const match of accepted) {
      if (!unmatchedRowIndexes.has(match.rowIndex) || !unmatchedInvoiceIndexes.has(match.invoiceIndex)) continue;
      unmatchedRowIndexes.delete(match.rowIndex);
      unmatchedInvoiceIndexes.delete(match.invoiceIndex);
      matches.push(match);
    }
  };

  runPass('invoice-po', (invoice, row) => {
    const invoiceFolio = normalizeReference(invoice.folio);
    const invoicePo = normalizeReference(invoice.poNumber);
    return Boolean(invoiceFolio && invoicePo
      && invoiceFolio === normalizeReference(row.invoice)
      && invoicePo === normalizeReference(row.po));
  });

  runPass('statement-po-to-invoice', (invoice, row) => {
    const folio = normalizeReference(invoice.folio);
    return Boolean(folio && folio === normalizeReference(row.po));
  });

  runPass('invoice', (invoice, row) => {
    const folio = normalizeReference(invoice.folio);
    return Boolean(folio && folio === normalizeReference(row.invoice));
  });

  runPass('invoice-variant-date', (invoice, row) => trailingAVariantMatches(invoice.folio, row.invoice)
    && Boolean(normalizeDate(invoice.issued) && normalizeDate(invoice.issued) === normalizeDate(row.date)));

  runPass('po', (invoice, row) => {
    const po = normalizeReference(invoice.poNumber);
    return Boolean(po && po === normalizeReference(row.po));
  });

  runPass('statement-invoice-to-po', (invoice, row) => {
    const po = normalizeReference(invoice.poNumber);
    return Boolean(po && po === normalizeReference(row.invoice));
  });

  return {
    matches,
    unmatchedRowIndexes: [...unmatchedRowIndexes],
    unmatchedInvoiceIndexes: [...unmatchedInvoiceIndexes]
  };
}
