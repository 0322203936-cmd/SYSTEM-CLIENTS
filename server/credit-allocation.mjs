function hasVisibleCreditFlag(credit) {
  return !credit?.creditFlagHidden && Boolean(credit?.creditPdfPath || credit?.creditSharePointUrl);
}

export function flaggedInvoiceIds(invoices) {
  const ids = new Set();
  for (const invoice of invoices || []) {
    for (const credit of invoice.credits || []) {
      if (!hasVisibleCreditFlag(credit)) continue;
      const redirectedId = Number(credit.creditFlagTargetInvoiceId);
      ids.add(Number.isFinite(redirectedId) && redirectedId > 0 ? redirectedId : Number(invoice.id));
    }
  }
  return ids;
}

export function buildCreditAllocationCandidates({
  invoices,
  matchedInvoice,
  customerKey,
  normalizeClientKey,
  availableBalance,
  useOldestUnflaggedRule
}) {
  const allSameCustomer = (invoices || [])
    .filter(candidate => normalizeClientKey(candidate.client) === customerKey);
  const sameCustomer = allSameCustomer.filter(candidate => availableBalance(candidate) > 0);

  if (!useOldestUnflaggedRule) {
    const remaining = sameCustomer
      .filter(candidate => Number(candidate.id) !== Number(matchedInvoice.id))
      .sort((a, b) => String(a.issued || '').localeCompare(String(b.issued || '')) || Number(a.id) - Number(b.id));
    return availableBalance(matchedInvoice) > 0 ? [matchedInvoice, ...remaining] : remaining;
  }

  const excludedIds = flaggedInvoiceIds(allSameCustomer);
  excludedIds.add(Number(matchedInvoice.id));
  return sameCustomer
    .filter(candidate => !excludedIds.has(Number(candidate.id)))
    .sort((a, b) => String(a.issued || '').localeCompare(String(b.issued || '')) || Number(a.id) - Number(b.id));
}
