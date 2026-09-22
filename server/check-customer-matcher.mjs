function normalizeCustomer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const customerAliasGroups = new Map([
  ['we-got-flower', 'we-got-flowers'],
  ['we-got-flowers', 'we-got-flowers'],
  ['trader-joe-s', 'trader-joes'],
  ['trader-joes', 'trader-joes'],
  ['washington-floral-service-inc-spokane', 'washington-floral-service-inc-spokane'],
  ['wfs-spokane', 'washington-floral-service-inc-spokane'],
  ['stemaline-wholesale', 'stemline-wholesale'],
  ['stemline-wholesale', 'stemline-wholesale'],
  ['galleria-farms', 'galleria-farms'],
  ['galleria-farms-flores', 'galleria-farms'],
  ['bill-doran-co-portland', 'bill-doran'],
  ['bill-doran-portland', 'bill-doran'],
  ['bill-doran-company-dallas', 'bill-doran'],
  ['bill-doran-dallas', 'bill-doran'],
  ['bill-doran-everflora', 'bill-doran'],
  ['bill-doran-herrin', 'bill-doran'],
  ['bill-doran-springfield', 'bill-doran'],
  ['a-perris-farms', 'a-perris-farms'],
  ['on-time-fresh-express-a-perris-farms', 'a-perris-farms'],
  ['oberer-s-flowers-inc', 'oberer-s-flowers-inc'],
  ['oberers-flowers-deruette', 'oberer-s-flowers-inc'],
  ['dutches-bouquets', 'dutchess-bouquets'],
  ['dutchess-bouquets', 'dutchess-bouquets'],
  ['dutchess-buquets', 'dutchess-bouquets'],
  ['dr-delphinium', 'dr-delphinium'],
  ['arizona-floral-exchage', 'arizona-floral-exchange'],
  ['arizona-floral-exchange', 'arizona-floral-exchange']
]);

function customerIdentity(value) {
  const normalized = normalizeCustomer(value);
  if (normalized.startsWith('bill-doran-') || normalized.startsWith('billdoran-')) return 'bill-doran';
  return customerAliasGroups.get(normalized) || normalized;
}

export function checkCustomersMatch(invoiceCustomer, selectedCustomer) {
  const selectedIdentity = customerIdentity(selectedCustomer);
  return Boolean(selectedIdentity) && customerIdentity(invoiceCustomer) === selectedIdentity;
}
