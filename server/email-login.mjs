const address = value => String(value || '').trim().toLowerCase();

// Some customers have historical legal-name/typo variants. Keep only the
// variants that the UI intentionally groups together; separate branches (for
// example, different Bill Doran locations) remain separate customers.
const CLIENT_ALIAS_GROUPS = [
  ['gringo-south', 'gringo-south-sa-de-cv', 'gringo-south-s-a-de-c-v', 'gringo-ventures-dba-dos-gringos'],
  ['we-got-flower', 'we-got-flowers'],
  ['trader-joe-s', 'trader-joes'],
  ['washington-floral-service-inc-spokane', 'wfs-spokane'],
  ['stemaline-wholesale', 'stemline-wholesale'],
  ['galleria-farms', 'galleria-farms-flores'],
  ['billdoran-co-portland', 'bill-doran-co-portland', 'bill-doran-portland'],
  ['bill-doran-springfield', 'billdoran-springfield'],
  ['a-perris-farms', 'on-time-fresh-express-a-perris-farms'],
  ['oberer-s-flowers-inc', 'oberers-flowers-deruette'],
  ['dutches-bouquets', 'dutchess-bouquets', 'dutchess-buquets'],
  ['arizona-floral-exchage', 'arizona-floral-exchange'],
].map(group => new Set(group));

function clientAliasGroup(value, normalizeKey) {
  const key = normalizeKey(value);
  return CLIENT_ALIAS_GROUPS.find(group => group.has(key)) || null;
}

function addClientKeyWithAliases(target, value, normalizeKey) {
  const key = normalizeKey(value);
  if (!key) return;
  const aliases = clientAliasGroup(key, normalizeKey);
  if (aliases) {
    aliases.forEach(alias => target.add(alias));
    return;
  }
  target.add(key);
}

/**
 * La llave con la que se cuenta a un cliente que tiene varias razones
 * sociales. Sin esto, un mismo cliente aparece varias veces: al resolver el
 * acceso se guardan todas sus variantes, y cada una parece un cliente aparte.
 */
export function canonicalClientKey(value, normalizeKey) {
  const key = normalizeKey(value);
  if (!key) return '';
  const group = clientAliasGroup(key, normalizeKey);
  return group ? [...group][0] : key;
}

export function expandClientKeys(values, normalizeKey) {
  const expanded = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    addClientKeyWithAliases(expanded, value, normalizeKey);
  }
  return [...expanded];
}

function clientKeysMatch(left, right, normalizeKey) {
  const leftKey = normalizeKey(left);
  const rightKey = normalizeKey(right);
  if (!leftKey || !rightKey) return false;
  const leftAliases = clientAliasGroup(leftKey, normalizeKey);
  const rightAliases = clientAliasGroup(rightKey, normalizeKey);
  return leftKey === rightKey
    || Boolean(leftAliases && rightAliases && leftAliases === rightAliases);
}

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
    if (clientKey) addClientKeyWithAliases(clients, clientKey, normalizeKey);
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
  return Boolean((clientKey && user.assignedClients?.some(value => clientKeysMatch(value, clientKey, normalizeKey)))
    || (address(invoice.email) && address(invoice.email) === address(user.email)));
}

export function canSendEmailForInvoice(user, invoice, normalizeKey) {
  if (user?.role === 'admin') return true;
  if (!user || !invoice) return false;
  if (user.loginSource === 'email-history') return historyInvoiceAccess(user, invoice, normalizeKey);
  const invoiceKey = normalizeKey(invoice.clientKey || invoice.client);
  if (Array.isArray(user.assignedClients) && user.assignedClients.length) {
    return Boolean(invoiceKey && user.assignedClients.some(value => clientKeysMatch(value, invoiceKey, normalizeKey)));
  }
  return Boolean((invoiceKey && user.clientKey && clientKeysMatch(invoiceKey, user.clientKey, normalizeKey))
    || (address(invoice.email) && address(invoice.email) === address(user.email)));
}

export function canSendStatementForCustomer(user, customer, invoices, normalizeKey) {
  if (user?.role === 'admin') return true;
  const requestedKey = normalizeKey(customer);
  if (!user || !requestedKey) return false;
  return (invoices || []).some(invoice => clientKeysMatch(invoice.clientKey || invoice.client, requestedKey, normalizeKey)
    && canSendEmailForInvoice(user, invoice, normalizeKey));
}

export function resolveEmailDeliveryRecipients(user, requestedTo, requestedCc) {
  if (user?.role === 'admin') {
    return { to: String(requestedTo || '').trim(), cc: String(requestedCc || '').trim() };
  }
  return { to: address(user?.email), cc: '' };
}
