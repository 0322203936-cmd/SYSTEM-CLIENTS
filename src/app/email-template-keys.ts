/**
 * Llaves de las plantillas de correo (reconstruido del portal publicado).
 *
 * - Empresa: `co:<empresa>` para facturas y `stmt:co:<empresa>` para estados de cuenta.
 * - Cliente: el alias del cliente (`gringo-south`) y `stmt:<alias>` para estados de cuenta.
 *
 * Un cliente puede tener varias razones sociales (Gringo trae tres clientKey). Al leer,
 * se busca primero la llave del alias y despues las llaves viejas, para no perder un To
 * guardado bajo otra razon social.
 */

export type TemplateKind = 'invoice' | 'statement';

const STATEMENT_PREFIX = 'stmt:';

export function companyTemplateKey(kind: TemplateKind, company: string): string {
  return (kind === 'statement' ? STATEMENT_PREFIX + 'co:' : 'co:') + company;
}

export function clientTemplateKey(kind: TemplateKind, clientKey: string): string {
  return kind === 'statement' ? STATEMENT_PREFIX + clientKey : clientKey;
}

/** La plantilla del cliente: la del alias gana; si no hay, la de alguna razon social vieja. */
export function findClientTemplate<T extends { clientKey: string }>(
  templates: T[],
  kind: TemplateKind,
  aliasKey: string,
  legacyKeys: string[] = [],
): T | null {
  const keys = [aliasKey, ...legacyKeys].filter(Boolean).map(key => clientTemplateKey(kind, key));
  for (const key of keys) {
    if (isCompanyTemplateKey(key)) continue;
    const found = templates.find(template => template.clientKey === key);
    if (found) return found;
  }
  return null;
}

/** Las llaves de empresa (`co:` / `stmt:co:`) nunca cuentan como plantilla de un cliente. */
function isCompanyTemplateKey(key: string): boolean {
  return (key.startsWith(STATEMENT_PREFIX) ? key.slice(STATEMENT_PREFIX.length) : key).startsWith('co:');
}
