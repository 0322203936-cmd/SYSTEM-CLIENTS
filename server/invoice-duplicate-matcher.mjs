function normalizeClient(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeReference(value) {
  const reference = String(value ?? '').trim();
  if (!reference) return '';
  return /^\d+$/.test(reference) ? reference.replace(/^0+(?=\d)/, '') : reference.toUpperCase();
}

export function isDuplicateInvoice(existing, incoming) {
  if (normalizeClient(existing.client) !== normalizeClient(incoming.client)) return false;
  return normalizeReference(existing.folio) === normalizeReference(incoming.folio);
}
