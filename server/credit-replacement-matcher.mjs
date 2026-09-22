/** Find applied credit records without relying solely on the PDF's customer label. */
export function findCreditRecords(invoices, creditNumber, customer, normalizeClientKey) {
  const number = String(creditNumber || '').trim();
  const byNumber = (invoices || []).flatMap(invoice => (invoice.credits || [])
    .filter(credit => String(credit.creditNumber || '').trim() === number)
    .map(credit => ({ invoice, credit })));
  if (!customer) return byNumber;
  const customerKey = normalizeClientKey(customer);
  const exact = byNumber.filter(record => normalizeClientKey(record.invoice.client) === customerKey);
  return exact.length ? exact : (byNumber.length === 1 ? byNumber : []);
}
