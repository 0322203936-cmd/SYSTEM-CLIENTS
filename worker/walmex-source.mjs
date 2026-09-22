import { neon } from '@neondatabase/serverless';
import { WALMEX_BALANCES } from './walmex-balance.mjs';

// The supplied statement was only an initial reference. From this date onward
// the invoice amount is the authoritative balance, not the old spreadsheet.
const WALMEX_BALANCE_START_DATE = '2026-08-11';
const WALMEX_BALANCE_SNAPSHOT_LAST_FOLIO = 1170;

export async function withTimeout(promise, timeoutMs, fallback = []) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fileName(url, fallback) {
  const value = String(url || '').split(/[?#]/)[0];
  return value.split('/').pop() || fallback;
}

export function balanceForWalmexFolio(folio, amount, issued = '') {
  const key = String(folio || '');
  const issuedDate = String(issued || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
  if (issuedDate && issuedDate >= WALMEX_BALANCE_START_DATE) return Number(amount || 0);
  if (Object.prototype.hasOwnProperty.call(WALMEX_BALANCES, key)) return Number(WALMEX_BALANCES[key]);
  const numericFolio = Number(key);
  if (Number.isFinite(numericFolio) && numericFolio <= WALMEX_BALANCE_SNAPSHOT_LAST_FOLIO) return 0;
  return Number(amount || 0);
}

/**
 * Walmex invoices live in a separate database.  Check records live in the
 * portal database, so apply their allocations while projecting the source
 * rows instead of trying to write back to the read-only Walmex source.
 */
export async function loadWalmexInvoices(databaseUrl, checks = []) {
  if (!databaseUrl) return [];
  const sql = neon(databaseUrl);
  const rows = await sql`
    SELECT folio,
           MAX(diario)::date AS issued,
           MAX(salida) AS po_number,
           MAX(tienda) AS location,
           SUM(COALESCE(venta_total, 0)) AS amount,
           MAX(NULLIF(url_factura, '')) AS invoice_url,
           MAX(NULLIF(url_acuse, '')) AS receiving_url
      FROM facturas_folios
     WHERE NULLIF(TRIM(url_factura), '') IS NOT NULL
     GROUP BY folio
     ORDER BY MAX(diario) DESC NULLS LAST, folio DESC
  `;
  const allocationsByInvoice = new Map();
  for (const check of Array.isArray(checks) ? checks : []) {
    for (const allocation of Array.isArray(check?.allocations) ? check.allocations : []) {
      const key = String(allocation?.invoiceId || '').trim();
      const amount = Number(allocation?.amount || 0);
      if (!key || !Number.isFinite(amount) || amount <= 0 || !key.toLowerCase().startsWith('walmex-')) continue;
      const list = allocationsByInvoice.get(key) || [];
      list.push({ date: String(check?.date || '').slice(0, 10), amount });
      allocationsByInvoice.set(key, list);
    }
  }

  return rows.map((row, index) => {
    const issued = row.issued instanceof Date
      ? row.issued.toISOString().slice(0, 10)
      : (String(row.issued || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '');
    const dueDate = issued ? new Date(`${issued}T00:00:00Z`) : new Date();
    dueDate.setUTCMonth(dueDate.getUTCMonth() + 1);
    const due = dueDate.toISOString().slice(0, 10);
    const amount = Number(row.amount || 0);
    const id = `walmex-${String(row.folio || index)}`;
    const checkApplications = allocationsByInvoice.get(id) || [];
    const sourceBalance = balanceForWalmexFolio(row.folio, amount, issued);
    const balance = Number(Math.max(0, sourceBalance - checkApplications.reduce((sum, item) => sum + item.amount, 0)).toFixed(2));
    return {
      id,
      folio: String(row.folio || ''),
      poNumber: String(row.po_number || ''),
      guideNumber: '',
      client: 'Walmex',
      clientKey: 'walmex',
      email: '',
      concept: 'Factura Walmex',
      issued, due, amount, balance,
      status: balance > 0.01 ? 'Pendiente' : 'Pagada',
      checkApplications,
      location: String(row.location || ''),
      invoiceFileName: fileName(row.invoice_url, `Factura-${row.folio}.jpg`),
      receivingFileName: row.receiving_url ? fileName(row.receiving_url, `Acuse-${row.folio}.jpg`) : '',
      invoiceSharePointUrl: String(row.invoice_url || ''),
      receivingSharePointUrl: String(row.receiving_url || ''),
      walmexSource: true,
      readOnly: true,
    };
  });
}
