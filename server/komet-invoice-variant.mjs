function cleanAmount(value) {
  const amount = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(amount) ? amount : 0;
}

export function extractKometInvoiceVariant(text) {
  const source = String(text || '').replace(/\u00a0/g, ' ');
  if (!/Invoice\s*#/i.test(source) || !/Invoice\s+Date/i.test(source)) return null;
  const shipToNumber = source.match(/Ship\s+To\s*\r?\n\s*([A-Z]?\d{4,})\s*\r?\n\s*Bill\s+To/i)?.[1]?.trim() || '';
  const invoiceLabelNumber = source.match(/Invoice\s*#\s*([A-Z0-9-]+)/i)?.[1]?.trim() || '';
  const number = shipToNumber || (/^(?:description|qty|amount|total|units|unit|price)$/i.test(invoiceLabelNumber) ? '' : invoiceLabelNumber);
  const date = source.match(/Invoice\s+Date\s+(\d{1,2})\/(\d{1,2})\/(20\d{2})/i)
    || source.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})\s*Invoice\s+Date/i);
  const amountText = source.match(/(?:^|\n)\s*Amount\s+\$\s*([\d,]+\.\d{2})/im)?.[1]
    || source.match(/\$\s*([\d,]+\.\d{2})\s*\r?\n\s*\d{1,2}\/\d{1,2}\/20\d{2}\s*Invoice\s+Date/i)?.[1]
    || '';
  const sameLineClient = source.match(/Bill\s+To\s+([^\r\n]+)/i)?.[1]?.trim() || '';
  const billToRow = source.match(/Bill\s+To[^\r\n]*\r?\n([^\r\n]+)/i)?.[1] || '';
  const rowClient = billToRow.split(/\s{2,}/)[0].trim();
  const reversedClient = source.match(/([^\r\n]+)\s*\r?\n\s*Ship\s+To\s*\r?\n\s*[A-Z]?\d{4,}\s*\r?\n\s*Bill\s+To/i)?.[1]?.trim() || '';
  const client = reversedClient
    || (sameLineClient && !/^Ship\s+To\b/i.test(sameLineClient) && !/^Carrier\b/i.test(sameLineClient)
    ? sameLineClient
    : rowClient);
  const amount = Number(amountText.replace(/,/g, ''));
  if (!number || !date || !client || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    folio: number,
    client,
    issued: `${date[3]}-${String(date[1]).padStart(2, '0')}-${String(date[2]).padStart(2, '0')}`,
    amount,
    poNumber: number,
    guideNumber: ''
  };
}
