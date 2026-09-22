export function projectReconciliationInvoice(record) {
  return {
    id: Number(record?.id),
    folio: String(record?.folio || ''),
    poNumber: String(record?.poNumber || ''),
    client: String(record?.client || ''),
    issued: String(record?.issued || ''),
    amount: Number(record?.amount || 0),
    balance: record?.balance === undefined ? undefined : Number(record.balance),
    creditAmount: Number(record?.creditAmount || 0),
    status: String(record?.status || ''),
    credits: Array.isArray(record?.credits) ? record.credits : []
  };
}
