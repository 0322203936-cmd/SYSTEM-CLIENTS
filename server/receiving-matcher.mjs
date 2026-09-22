function normalizeReference(value) {
  const text = String(value ?? '').replace(/[^a-z0-9]+/gi, '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

function extractReceivingParts(fileName) {
  const stem = String(fileName || '').replace(/\.pdf$/i, '');
  const ignoredLabels = new Set([
    'invoice', 'invoices', 'receiving', 'receipt', 'receipts',
    'credit', 'credits', 'cancelada', 'cancelled', 'sample',
    'number', 'folio', 'order'
  ]);
  return stem
    .split(/[^a-z0-9]+/i)
    .map(normalizeReference)
    .filter(value => value && !ignoredLabels.has(value.toLowerCase()));
}

function extractReceivingTokens(fileName) {
  return extractReceivingParts(fileName)
    .filter(value => value.length >= 4 && /\d/.test(value));
}

export function extractReceivingReferences(fileName) {
  const tokens = extractReceivingTokens(fileName);
  // Keep short guide segments (for example, the leading 555 in
  // 555-263410) only while building the complete reference. They are not
  // exposed as standalone matches because short numeric tokens are ambiguous.
  const parts = extractReceivingParts(fileName);
  const cumulative = parts
    .map((_, index) => parts.slice(0, index + 1).join(''))
    .filter(value => value.length >= 4 && /\d/.test(value));
  return Array.from(new Set([...tokens, ...cumulative]));
}

function invoiceExactReferences(invoice) {
  const fieldReferences = [invoice.folio, invoice.poNumber, invoice.guideNumber]
    .map(normalizeReference)
    .filter(value => value.length >= 4);
  return new Set([...fieldReferences, ...extractReceivingTokens(invoice.invoiceFileName)]);
}

export function findExplicitMultiReceivingInvoices(fileName, invoices) {
  const fileReferences = Array.from(new Set(extractReceivingTokens(fileName)))
    .filter(reference => !/^\d{8}$/.test(reference));
  if (fileReferences.length < 2) return [];

  const exactMatchesByReference = fileReferences.map(reference => (
    invoices.filter(invoice => invoiceExactReferences(invoice).has(reference))
  ));
  if (exactMatchesByReference.some(matches => matches.length !== 1)) return [];

  const exactInvoices = Array.from(new Map(
    exactMatchesByReference.map(([invoice]) => [invoice.id, invoice])
  ).values());
  return exactInvoices.length > 1 ? exactInvoices : [];
}

export function receivingReferenceMatches(fileReference, invoiceReference) {
  if (!fileReference || !invoiceReference) return false;
  if (fileReference === invoiceReference) return true;

  // Oracle también relacionaba los recibimientos escaneados con la factura
  // larga por prefijo: por ejemplo, `555263422` identifica a
  // `5552634220000007880`. Permitimos ese caso únicamente cuando el sufijo
  // concatenado tiene al menos cuatro dígitos y ninguno de los valores parece
  // una fecha de ocho dígitos; así no convertimos fechas en coincidencias.
  const isDateReference = value => /^\d{8}$/.test(value);
  const numericPrefixMatch = /^\d+$/.test(fileReference)
    && /^\d+$/.test(invoiceReference)
    && !isDateReference(fileReference)
    && !isDateReference(invoiceReference)
    && Math.abs(fileReference.length - invoiceReference.length) >= 4
    && (fileReference.startsWith(invoiceReference) || invoiceReference.startsWith(fileReference));
  if (numericPrefixMatch) return true;

  const isAlphaNumeric = value => /[a-z]/i.test(value) && /\d/.test(value);
  if (!isAlphaNumeric(fileReference) || !isAlphaNumeric(invoiceReference)) return false;

  return fileReference.length >= 5
    && invoiceReference.length >= 6
    && (fileReference.startsWith(invoiceReference) || invoiceReference.startsWith(fileReference));
}

export function findReceivingInvoices(fileName, invoices) {
  const fileReferences = extractReceivingReferences(fileName);
  const specificFileReferences = fileReferences.filter(reference => !/^\d{8}$/.test(reference));
  const hasAlphaReference = fileReferences.some(reference => /[a-z]/i.test(reference));

  const exactMatches = invoices.filter(invoice => {
    const invoiceFileReferences = extractReceivingReferences(invoice.invoiceFileName);
    const invoiceReferences = [invoice.folio, invoice.poNumber, invoice.guideNumber]
      .map(normalizeReference)
      .filter(value => value.length >= 4);
    return specificFileReferences.some(reference => invoiceReferences.includes(reference) || invoiceFileReferences.includes(reference));
  });
  if (exactMatches.length) return exactMatches;

  return invoices.filter(invoice => {
    const invoiceFileReferences = extractReceivingReferences(invoice.invoiceFileName);
    const invoiceReferences = [invoice.folio, invoice.poNumber, invoice.guideNumber]
      .map(normalizeReference)
      .filter(value => value.length >= 4);
    const fileNameMatch = fileReferences.some(fileReference => invoiceFileReferences.some(invoiceReference => receivingReferenceMatches(fileReference, invoiceReference)));
    if (hasAlphaReference && invoiceFileReferences.length) return fileNameMatch;
    invoiceReferences.push(...invoiceFileReferences);
    return fileReferences.some(fileReference => invoiceReferences.some(invoiceReference => receivingReferenceMatches(fileReference, invoiceReference)));
  });
}

// Every receiving whose target was identified with certainty may be appended
// at execution time. This must not depend on whether the invoice already had
// a receiving while the batch plan was being created: an earlier shared
// document in the same batch can change that state before this plan runs.
export function shouldAppendMatchedReceiving(invoices) {
  return Array.isArray(invoices) && invoices.length > 0;
}
