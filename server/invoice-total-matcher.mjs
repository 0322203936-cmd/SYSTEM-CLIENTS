function isJasperKometInvoice(text) {
  return /\bPackages\b/i.test(text)
    && /\bInv\.\s*Subtotal\b/i.test(text)
    && /\bDiscount\s+Amt\.?/i.test(text)
    && /\bInv\.\s*Total\b/i.test(text);
}

/**
 * JasperReports places the right-hand summary labels after their values in
 * pdf-parse's reading order. For this layout, the first currency value before
 * the Invoice # block is the same amount shown as Inv. Total, while the later
 * values are the subtotal and discount.
 */
export function extractJasperKometInvoiceTotal(text) {
  const normalizedText = String(text || '').replace(/\u00a0/g, ' ');
  if (!isJasperKometInvoice(normalizedText)) return '';

  const amountBeforeInvoiceBlock = normalizedText.match(
    /\$\s*([\d,]+\.\d{2})[\s\S]{0,320}?\bInvoice\s*#/i
  );
  return amountBeforeInvoiceBlock?.[1] || '';
}
