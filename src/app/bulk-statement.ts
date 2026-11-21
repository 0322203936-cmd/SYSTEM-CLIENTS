/**
 * Reglas del envio masivo de estados de cuenta (reconstruido del portal publicado):
 * un renglon por cliente con saldo pendiente, bloqueado si no tiene destinatario.
 */

export interface BulkStatementGroup {
  aliasKey: string;
  name: string;
  /** Cuantas facturas trae el estado de cuenta. */
  invoices: number;
  balance: number;
  /** Empresa emisora (pacifica / centro). */
  issuer: string;
}

export interface BulkStatementRow extends BulkStatementGroup {
  recipients: string;
  selectable: boolean;
  /** Fecha del ultimo estado de cuenta enviado (ISO), vacia si nunca se ha enviado. */
  lastSentAt: string;
}

export interface BulkStatementOptions {
  recipients: Record<string, string>;
  lastSent?: Record<string, string>;
}

/** Solo clientes que deben (mas de medio centavo); un saldo a favor no genera renglon. */
export function buildBulkStatementRows(groups: BulkStatementGroup[], options: BulkStatementOptions): BulkStatementRow[] {
  const rows: BulkStatementRow[] = [];
  for (const group of groups) {
    if (!(group.balance > 0.005)) continue;
    const recipients = String(options.recipients[group.aliasKey] || '').trim();
    rows.push({
      ...group,
      recipients,
      selectable: !!recipients,
      lastSentAt: String(options.lastSent?.[group.aliasKey] || ''),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** Lo que dice el boton: correos a enviar y saldo que suman (sin bloqueados ni deseleccionados). */
export function bulkStatementSummary(rows: BulkStatementRow[], unselected: Set<string>): { emails: number; balance: number } {
  let emails = 0;
  let balance = 0;
  for (const row of rows) {
    if (!row.selectable || unselected.has(row.aliasKey)) continue;
    emails += 1;
    balance += row.balance;
  }
  return { emails, balance };
}

/** Los renglones que de verdad se envian, en orden. */
export function bulkStatementQueue(rows: BulkStatementRow[], unselected: Set<string>): BulkStatementRow[] {
  return rows.filter(row => row.selectable && !unselected.has(row.aliasKey));
}
