import { PDFParse } from 'pdf-parse';
import { extractPdfTextWithOcr, shouldUseOcr } from './invoice-ocr.mjs';

export function buildInvoiceSearchText(text) {
  const tokens = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) || [];

  // The browser only needs a compact searchable index, not a second copy of
  // the complete PDF text. Keeping unique tokens makes the API response small.
  return Array.from(new Set(tokens)).join(' ').slice(0, 12000);
}

export async function extractInvoiceDocumentText(buffer) {
  const parser = new PDFParse({ data: buffer });
  let extractedText = '';
  try {
    extractedText = (await parser.getText()).text.replace(/\u00a0/g, ' ');
  } finally {
    await parser.destroy();
  }

  return shouldUseOcr(extractedText)
    ? extractPdfTextWithOcr(buffer)
    : extractedText;
}
