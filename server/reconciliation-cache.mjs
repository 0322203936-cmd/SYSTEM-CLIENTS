export const RECONCILIATION_CACHE = Object.freeze({
  invoices: { collection: 'reconciliationSnapshots', key: 'current' },
  credits: { collection: 'creditReconciliationSnapshots', key: 'current' },
});

export function reconciliationCache(kind) {
  const config = RECONCILIATION_CACHE[kind];
  if (!config) throw new Error(`Tipo de conciliación no válido: ${kind}`);
  return config;
}

export function usableReconciliationSnapshot(value, kind) {
  const config = reconciliationCache(kind);
  return Boolean(value && value.version === 1 && value.kind === kind && value.cacheKey === config.key && Array.isArray(value.rows) && value.totals && typeof value.totals === 'object');
}

export function buildReconciliationSnapshot(kind, payload, metadata = {}) {
  const config = reconciliationCache(kind);
  return {
    version: 1,
    kind,
    cacheKey: config.key,
    generatedAt: new Date().toISOString(),
    ...metadata,
    ...payload,
  };
}
