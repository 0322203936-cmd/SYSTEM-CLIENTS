/**
 * Reglas del envio masivo de facturas (reconstruido del portal publicado):
 * que facturas entran, que renglones se bloquean y como se agrupa por cliente.
 */

export interface BulkSendInvoice {
  id: string | number;
  folio: string;
  client: string;
  /** Llave de agrupacion: las razones sociales de un mismo cliente comparten alias. */
  aliasKey: string;
  issued: string;
  hasReceiving: boolean;
  alreadySent: boolean;
}

export interface BulkSendRow {
  aliasKey: string;
  name: string;
  invoices: BulkSendInvoice[];
  /** Correos a los que se manda; vacio = el renglon queda bloqueado. */
  recipients: string;
  selectable: boolean;
}

export interface BulkSendOptions {
  from: string;
  to: string;
  onlyUnsent: boolean;
  recipients: Record<string, string>;
}

/** Un renglon por cliente con sus facturas del rango (los dos extremos cuentan), ordenados por nombre. */
export function buildBulkSendRows(invoices: BulkSendInvoice[], options: BulkSendOptions): BulkSendRow[] {
  const rows = new Map<string, BulkSendRow>();
  for (const invoice of invoices) {
    const issued = String(invoice.issued || '');
    if ((options.from && issued < options.from) || (options.to && issued > options.to)) continue;
    if (options.onlyUnsent && invoice.alreadySent) continue;
    const aliasKey = invoice.aliasKey;
    let row = rows.get(aliasKey);
    if (!row) {
      const recipients = String(options.recipients[aliasKey] || '').trim();
      row = { aliasKey, name: invoice.client, invoices: [], recipients, selectable: !!recipients };
      rows.set(aliasKey, row);
    }
    row.invoices.push(invoice);
  }
  for (const row of rows.values()) {
    row.invoices.sort((a, b) => a.issued.localeCompare(b.issued) || String(a.id).localeCompare(String(b.id)));
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** Lo que dice el boton: cuantos correos (facturas seleccionadas) y a cuantos clientes. */
export function bulkSendSummary(rows: BulkSendRow[], selectedIds: Set<string | number>): { emails: number; clients: number } {
  const selected = new Set([...selectedIds].map(String));
  let emails = 0;
  let clients = 0;
  for (const row of rows) {
    if (!row.selectable) continue;
    const count = row.invoices.filter(invoice => selected.has(String(invoice.id))).length;
    if (count) {
      emails += count;
      clients += 1;
    }
  }
  return { emails, clients };
}
