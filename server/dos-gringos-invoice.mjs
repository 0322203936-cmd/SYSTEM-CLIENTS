const MONTHS = new Map([
  ['JAN', 1], ['JANUARY', 1], ['ENE', 1], ['ENERO', 1],
  ['FEB', 2], ['FEBRUARY', 2], ['FEBRERO', 2],
  ['MAR', 3], ['MARCH', 3], ['MARZO', 3],
  ['APR', 4], ['APRIL', 4], ['ABR', 4], ['ABRIL', 4],
  ['MAY', 5], ['MAYO', 5],
  ['JUN', 6], ['JUNE', 6], ['JUNIO', 6],
  ['JUL', 7], ['JULY', 7], ['JULIO', 7],
  ['AUG', 8], ['AUGUST', 8], ['AGO', 8], ['AGOSTO', 8],
  ['SEP', 9], ['SEPT', 9], ['SEPTEMBER', 9], ['SEPTIEMBRE', 9],
  ['OCT', 10], ['OCTOBER', 10], ['OCTUBRE', 10],
  ['NOV', 11], ['NOVEMBER', 11], ['NOVIEMBRE', 11],
  ['DEC', 12], ['DECEMBER', 12], ['DIC', 12], ['DICIEMBRE', 12]
]);

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function parseShipDate(value) {
  const raw = normalizeText(value).toUpperCase().replace(/[–—/]/g, '-');
  const parts = raw.split('-').map(part => part.trim());
  if (parts.length !== 3) return '';

  let year;
  let month;
  let day;
  if (/^20\d{2}$/.test(parts[0])) {
    year = Number(parts[0]);
    if (MONTHS.has(parts[1])) month = MONTHS.get(parts[1]);
    else month = Number(parts[1]);
    day = Number(parts[2]);
  } else {
    year = Number(parts[2]);
    if (!/^20\d{2}$/.test(parts[2]) || !Number.isInteger(year)) return '';
    if (MONTHS.has(parts[0])) {
      month = MONTHS.get(parts[0]);
      day = Number(parts[1]);
    } else {
      const first = Number(parts[0]);
      const second = Number(parts[1]);
      if (!Number.isInteger(first) || !Number.isInteger(second)) return '';
      // These PDFs use MM-DD-YYYY when both values could be months.
      month = first > 12 ? second : first;
      day = first > 12 ? first : second;
    }
  }

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
    || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function matchValue(text, pattern) {
  const match = text.match(pattern);
  return normalizeText(match?.[1] || '');
}

function parseAmount(text) {
  const matches = [
    text.match(/\bTOTAL\b[\s\r\n]*\$?\s*([\d,]+\.\d{2,3})/i),
    text.match(/\$?\s*([\d,]+\.\d{2,3})\s*\bTOTAL\b/i)
  ];
  const raw = matches.find(Boolean)?.[1] || '';
  if (raw) {
    const amount = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0) return amount;
  }

  // Some Dos Gringos product invoices explicitly show a dash in the total
  // column when the amount is zero. That is still a valid invoice and must
  // not fall through to the receiving matcher. Keep missing totals distinct
  // so unrelated documents are not imported as $0 invoices.
  const explicitZero = text.match(/\bTOTAL\b[\s\r\n]*[-—–](?:\s|$)/i)
    || text.match(/[-—–][\s\r\n]*\bTOTAL\b/i);
  return explicitZero ? 0 : null;
}

/**
 * Extracts the two non-freight Dos Gringos invoice layouts.
 * Returns null for unrelated PDFs so the existing parser remains unchanged.
 */
export function extractDosGringosInvoice(text) {
  const source = String(text || '').replace(/\u00a0/g, ' ');
  if (!/CENTRO\s+FLORICULTOR\s+DE\s+BAJA\s+CALIFORNIA/i.test(source)
    || !/\bGRINGO\s+(?:SOUTH|VENTURES)\b/i.test(source)) return null;

  // Accept the colon/hash variants used by the two Dos Gringos layouts and
  // also the occasional `INVOICE 7638` / `PO 008010` header without a colon.
  const invoiceHeader = source.match(/\bINVOICE\s*(?::|#)\s*([A-Z0-9-]+)|\bINVOICE\s+(?=\d)([A-Z0-9-]+)/i);
  const folio = normalizeText(invoiceHeader?.[1] || invoiceHeader?.[2] || '');
  const poNumber = matchValue(source, /\b(?:PO|P\.O\.)(?:\s*(?:NUMBER|NO\.?|#))?\s*(?::|-)?\s*([A-Z0-9-]+)/i)
    || matchValue(source, /\bORDEN\s+DE\s+COMPRA\s*:\s*([A-Z0-9-]+)/i);
  const dateRaw = matchValue(source, /\bSHIP\s+DATE\s*(?::|-)?\s*([A-ZÁÉÍÓÚ]+[-/]\d{1,2}[-/]20\d{2}|\d{1,2}[-/]\d{1,2}[-/]20\d{2})/i);
  const issued = parseShipDate(dateRaw);
  const customerLabelValue = matchValue(source, /\bCustomer\s*:\s*(?:\r?\n\s*)?([^\r\n]+)/i);
  // A few invoices place an "Address:" label immediately after Customer:.
  // Prefer the explicit Gringo legal-name line so that label text is never
  // stored as the customer.
  const legalClient = matchValue(source, /^\s*(GRINGO\s+(?:SOUTH|VENTURES)\b[^\r\n]*)\s*$/im);
  const client = legalClient || customerLabelValue;
  const amount = parseAmount(source);

  if (!folio || !poNumber || !issued || !client || amount === null) return null;
  return { folio, poNumber, issued, client, amount, format: 'dos-gringos-product' };
}

export { parseShipDate };
