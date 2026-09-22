const address = value => String(value || '').trim().toLowerCase();

// A manual account always takes precedence, even when disabled.
export function resolveEmailLogin(db, email, normalizeKey) {
  const normalized = address(email);
  if (!normalized) return {kind: 'denied'};
  const manual = (db.users || []).find(user => address(user.username) === normalized || address(user.email) === normalized);
  if (manual) return {kind: 'manual', user: manual};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return {kind: 'denied'};
  const clients = new Set();
  for (const entry of db.emailLog || []) {
    if (!entry.sentAt || !Array.isArray(entry.to) || !entry.to.some(to => address(to) === normalized)) continue;
    if (entry.sentByRole === 'client') continue;
    const invoice = (db.invoices || []).find(item => String(item.id) === String(entry.invoiceId));
    const clientKey = normalizeKey(invoice?.clientKey || invoice?.client || entry.clientKey || entry.client);
    if (clientKey) clients.add(clientKey);
  }
  if (!clients.size) return {kind: 'denied'};
  return {kind: 'history', user: {
    id: `email:${normalized}`, name: normalized, email: normalized, role: 'client',
    loginSource: 'email-history', assignedClients: [...clients],
    permissions: ['dashboard', 'invoices', 'credits', 'accountStatement', 'preferences']
  }};
}

export function historyInvoiceAccess(user, invoice, normalizeKey) {
  const clientKey = normalizeKey(invoice.clientKey || invoice.client);
  return Boolean(clientKey && user.assignedClients?.includes(clientKey));
}

export function canSendEmailForInvoice(user, invoice, normalizeKey) {
  if (user?.role === 'admin') return true;
  if (!user || !invoice) return false;
  if (user.loginSource === 'email-history') return historyInvoiceAccess(user, invoice, normalizeKey);
  const invoiceKey = normalizeKey(invoice.clientKey || invoice.client);
  if (Array.isArray(user.assignedClients) && user.assignedClients.length) {
    return Boolean(invoiceKey && user.assignedClients.some(value => normalizeKey(value) === invoiceKey));
  }
  return Boolean((invoiceKey && user.clientKey && invoiceKey === normalizeKey(user.clientKey))
    || (address(invoice.email) && address(invoice.email) === address(user.email)));
}

export function canSendStatementForCustomer(user, customer, invoices, normalizeKey) {
  if (user?.role === 'admin') return true;
  const requestedKey = normalizeKey(customer);
  if (!user || !requestedKey) return false;
  return (invoices || []).some(invoice => normalizeKey(invoice.clientKey || invoice.client) === requestedKey
    && canSendEmailForInvoice(user, invoice, normalizeKey));
}

export function resolveEmailDeliveryRecipients(user, requestedTo, requestedCc) {
  if (user?.role === 'admin') {
    return { to: String(requestedTo || '').trim(), cc: String(requestedCc || '').trim() };
  }
  return { to: address(user?.email), cc: '' };
}
