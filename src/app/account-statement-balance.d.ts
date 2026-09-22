export declare function accountStatementInvoiceBalance(
  invoice: { amount?: number; balance?: number; creditAmount?: number; checkAmount?: number; status?: string; credits?: { date?: string; dateProcessed?: string; amount?: number }[]; checkApplications?: { date?: string; amount?: number }[] },
  statementDateTo?: string
): number;
