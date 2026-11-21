// El saldo que el estado de cuenta muestra para una factura. Un saldo a favor del cliente
// (customerCreditBalance / customerCreditHistory) se resta y puede dejar el saldo en negativo.
export function accountStatementInvoiceBalance(invoice, statementDateTo = '') {
  const amount = Math.max(0, Number(invoice.amount || 0));
  const amountAfterCredits = Math.max(0, amount - Number(invoice.creditAmount || 0));
  const currentBalance = invoice.status === 'Pagada'
    ? 0
    : Math.max(0, Number(invoice.balance ?? amountAfterCredits));
  const customerCreditHistory = Array.isArray(invoice.customerCreditHistory) ? invoice.customerCreditHistory : [];
  const customerCredit = Math.max(0, Number(invoice.customerCreditBalance
    ?? customerCreditHistory.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)));
  if (!statementDateTo) return Number((currentBalance - customerCredit).toFixed(2));
  const credits = Array.isArray(invoice.credits) ? invoice.credits : [];
  const checks = Array.isArray(invoice.checkApplications) ? invoice.checkApplications : [];
  const hasMovementHistory = credits.length > 0 || checks.length > 0 || customerCreditHistory.length > 0;
  if (!hasMovementHistory) return Number((currentBalance - customerCredit).toFixed(2));
  const creditsByCutoff = credits
    .filter(credit => String(credit.date || credit.dateProcessed || '').slice(0, 10) <= statementDateTo)
    .reduce((sum, credit) => sum + Math.max(0, Number(credit.amount || 0)), 0);
  const checksByCutoff = checks
    .filter(check => String(check.date || '').slice(0, 10) <= statementDateTo)
    .reduce((sum, check) => sum + Math.max(0, Number(check.amount || 0)), 0);
  const customerCreditByCutoff = Math.max(0, customerCreditHistory
    .filter(entry => String(entry.date || '').slice(0, 10) <= statementDateTo)
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
  return Number((Math.max(0, amount - creditsByCutoff - checksByCutoff) - customerCreditByCutoff).toFixed(2));
}
