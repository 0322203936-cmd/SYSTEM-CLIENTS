export function accountStatementInvoiceBalance(invoice, statementDateTo = '') {
  const amount = Math.max(0, Number(invoice.amount || 0));
  const amountAfterCredits = Math.max(0, amount - Number(invoice.creditAmount || 0));
  const currentBalance = invoice.status === 'Pagada'
    ? 0
    : Math.max(0, Number(invoice.balance ?? amountAfterCredits));
  if (!statementDateTo) return currentBalance;
  const credits = Array.isArray(invoice.credits) ? invoice.credits : [];
  const checks = Array.isArray(invoice.checkApplications) ? invoice.checkApplications : [];
  const hasMovementHistory = credits.length > 0 || checks.length > 0;
  if (!hasMovementHistory) return currentBalance;
  const creditsByCutoff = credits
    .filter(credit => String(credit.date || credit.dateProcessed || '').slice(0, 10) <= statementDateTo)
    .reduce((sum, credit) => sum + Math.max(0, Number(credit.amount || 0)), 0);
  const checksByCutoff = checks
    .filter(check => String(check.date || '').slice(0, 10) <= statementDateTo)
    .reduce((sum, check) => sum + Math.max(0, Number(check.amount || 0)), 0);
  return Math.max(0, amount - creditsByCutoff - checksByCutoff);
}
