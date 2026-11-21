function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

export function checkCustomerCreditRemaining(check) {
  const credit = check?.customerCredit;
  const original = Math.max(0, Number(credit?.amount || 0));
  const applied = (Array.isArray(credit?.applications) ? credit.applications : [])
    .reduce((sum, application) => sum + Math.max(0, Number(application?.amount || 0)), 0);
  return money(Math.max(0, original - applied));
}

function invoiceBalance(invoice) {
  return invoice?.status === 'Pagada'
    ? 0
    : Math.max(0, Number(invoice?.balance ?? (Number(invoice?.amount || 0) - Number(invoice?.creditAmount || 0))));
}

function applyOneCustomerCredit(invoice, check, amount) {
  const applied = money(Math.min(amount, invoiceBalance(invoice)));
  if (applied <= 0) return 0;
  const balance = money(Math.max(0, invoiceBalance(invoice) - applied));
  invoice.balance = balance;
  invoice.checkAmount = money(Number(invoice.checkAmount || 0) + applied);
  if (balance <= 0.01) {
    invoice.balance = 0;
    invoice.status = 'Pagada';
  }
  const application = {
    invoiceId: invoice.id,
    folio: invoice.folio || String(invoice.id),
    amount: applied,
    date: String(invoice.issued || check.date || '').slice(0, 10),
  };
  check.customerCredit.applications = Array.isArray(check.customerCredit.applications)
    ? check.customerCredit.applications
    : [];
  check.customerCredit.applications.push(application);
  if (Array.isArray(invoice.checkApplications)) invoice.checkApplications.push({ date: application.date, amount: applied });
  return applied;
}

function isEligibleCreditInvoice(invoice, check, customerMatches) {
  const issued = String(invoice?.issued || '').slice(0, 10);
  const checkDate = String(check?.date || '').slice(0, 10);
  return String(invoice?.id) !== String(check?.customerCredit?.sourceInvoiceId)
    && customerMatches(invoice?.client || '', check?.client || '')
    && (!issued || !checkDate || issued >= checkDate)
    && invoiceBalance(invoice) > 0.01;
}

/** Consume a check's remaining customer credit on eligible, later invoices. */
export function applyCustomerCreditToInvoices(invoices, check, customerMatches) {
  if (!check?.customerCredit || typeof customerMatches !== 'function') return [];
  const changed = [];
  const ordered = [...invoices]
    .filter(invoice => isEligibleCreditInvoice(invoice, check, customerMatches))
    .sort((a, b) => String(a.issued || a.due || '').localeCompare(String(b.issued || b.due || ''))
      || String(a.due || '').localeCompare(String(b.due || ''))
      || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  for (const invoice of ordered) {
    const remaining = checkCustomerCreditRemaining(check);
    if (remaining <= 0.01) break;
    const amount = applyOneCustomerCredit(invoice, check, remaining);
    if (amount > 0) changed.push(invoice);
  }
  return changed;
}

/** Consume existing check credits when an internal invoice first arrives. */
export function applyPendingCustomerCreditsToInvoice(invoice, checks, customerMatches) {
  if (!invoice || typeof customerMatches !== 'function') return false;
  let changed = false;
  const orderedChecks = [...(Array.isArray(checks) ? checks : [])]
    .filter(check => check?.customerCredit)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || Number(a.id || 0) - Number(b.id || 0));
  for (const check of orderedChecks) {
    if (checkCustomerCreditRemaining(check) <= 0.01 || !isEligibleCreditInvoice(invoice, check, customerMatches)) continue;
    const amount = applyOneCustomerCredit(invoice, check, checkCustomerCreditRemaining(check));
    changed = changed || amount > 0;
  }
  return changed;
}

/** Attach payment and customer-credit history without changing stored invoices. */
export function attachCheckCustomerCreditHistory(invoices, checks) {
  const paymentsByInvoice = new Map();
  const creditHistoryByInvoice = new Map();
  const creditBalanceByInvoice = new Map();
  const addPayment = (invoiceId, event) => {
    const key = String(invoiceId);
    const events = paymentsByInvoice.get(key) || [];
    events.push(event);
    paymentsByInvoice.set(key, events);
  };
  const addCreditHistory = (invoiceId, event) => {
    const key = String(invoiceId);
    const events = creditHistoryByInvoice.get(key) || [];
    events.push(event);
    creditHistoryByInvoice.set(key, events);
  };

  for (const check of Array.isArray(checks) ? checks : []) {
    for (const allocation of Array.isArray(check?.allocations) ? check.allocations : []) {
      addPayment(allocation.invoiceId, { date: String(check.date || '').slice(0, 10), amount: Number(allocation.amount || 0) });
    }
    const credit = check?.customerCredit;
    if (!credit) continue;
    const sourceId = credit.sourceInvoiceId;
    if (sourceId !== undefined && sourceId !== null) {
      addCreditHistory(sourceId, { date: String(check.date || '').slice(0, 10), amount: Number(credit.amount || 0) });
      creditBalanceByInvoice.set(String(sourceId), money((creditBalanceByInvoice.get(String(sourceId)) || 0) + checkCustomerCreditRemaining(check)));
    }
    for (const application of Array.isArray(credit.applications) ? credit.applications : []) {
      const amount = Number(application.amount || 0);
      const date = String(application.date || check.date || '').slice(0, 10);
      addPayment(application.invoiceId, { date, amount });
      if (sourceId !== undefined && sourceId !== null) addCreditHistory(sourceId, { date, amount: -amount });
    }
  }

  return invoices.map(invoice => ({
    ...invoice,
    checkApplications: paymentsByInvoice.get(String(invoice.id)) || [],
    customerCreditBalance: money(creditBalanceByInvoice.get(String(invoice.id)) || 0),
    customerCreditHistory: creditHistoryByInvoice.get(String(invoice.id)) || [],
  }));
}
