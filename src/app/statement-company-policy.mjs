const ALL_ISSUERS = ['pacifica', 'centro'];

export function visibleStatementCompanies(role, issuers) {
  if (role === 'admin') return [...ALL_ISSUERS];
  const available = new Set(issuers);
  return ALL_ISSUERS.filter(issuer => available.has(issuer));
}
