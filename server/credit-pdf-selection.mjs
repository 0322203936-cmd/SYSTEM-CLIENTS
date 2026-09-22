export function selectedCreditPdfPath(invoice, credit) {
  const path = String(credit?.creditPdfPath || '').trim();
  if (!path) return '';
  const exists = (invoice?.credits || []).some(item => !item.creditFlagHidden
    && String(item.creditPdfPath || '').trim() === path
    && (!credit?.creditNumber || String(item.creditNumber || '') === String(credit.creditNumber || '')));
  return exists ? path : '';
}
