import { extractText } from 'unpdf';
import { extractDosGringosInvoice } from '../server/dos-gringos-invoice.mjs';
import { extractJasperKometInvoiceTotal } from '../server/invoice-total-matcher.mjs';
import { extractKometInvoiceVariant } from '../server/komet-invoice-variant.mjs';

function normalizeClientKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isGalleriaClient(value) {
  return normalizeClientKey(value).includes('galleria-farms');
}

function addOneMonth(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function extractOrderNumber(text) {
  const direct = text.match(/Order\s*(?:No\.?|Number|#)\s*[:\r\n \t]+([A-Z0-9-]+)/i)?.[1]?.trim() || '';
  if (direct && !/^(?:origin|invoice|no|date|division)$/i.test(direct)) return direct;
  return text.match(/Order\s*(?:No\.?|Number|#)[\s\S]{0,160}?\b([A-Z0-9]+(?:-[A-Z0-9]+)+)\b/i)?.[1]?.trim() || '';
}

function buildInvoiceSearchText(text) {
  const tokens = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  return [...new Set(tokens)].join(' ').slice(0, 12000);
}

export async function extractInvoicePdf(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = await extractText(source.slice(), { mergePages: true });
  const text = String(result.text || '').replace(/\u00a0/g, ' ');
  const kometVariant = extractKometInvoiceVariant(text);
  if (kometVariant) {
    return {
      ...kometVariant,
      due: addOneMonth(kometVariant.issued),
      location: '',
      email: '',
      concept: 'Factura Komet importada desde PDF',
      searchText: buildInvoiceSearchText(text)
    };
  }
  const dosGringos = extractDosGringosInvoice(text);
  if (dosGringos) return { ...dosGringos, due: addOneMonth(dosGringos.issued), guideNumber: '', location: '', email: '', concept: 'Factura Dos Gringos importada desde PDF', searchText: buildInvoiceSearchText(text) };

  const oldDateMatch = text.match(/Invoice Date[\s\S]{0,180}?(20\d{2}-\d{2}-\d{2})/i);
  const oldNumberMatch = text.match(/Invoice No\.[\s\S]{0,180}?(\d{4})\s+20\d{2}-\d{2}-\d{2}/i);
  const originInvoiceMatch = text.match(/Origin Invoice No\.[\s\S]{0,120}?\b(\d{1,})\s+20\d{2}-\d{2}-\d{2}/i);
  // Algunas facturas de Galleria imprimen el número de guía, el folio y la
  // fecha sin separadores: `555-26342278802026-08-24`. En Oracle se aceptaba
  // este encabezado compacto; el folio son los cuatro dígitos inmediatamente
  // anteriores a la fecha.
  const compactOriginInvoiceMatch = text.match(/Origin Invoice No\.[\s\S]{0,100}?(\d{4})20\d{2}-\d{2}-\d{2}/i);
  const oldClientMatch = text.match(/SOLD TO\.?\s*[\r\n]+([^\r\n]+)/i);
  const inlineSoldToMatch = text.match(/SOLD TO\.?\s+([A-Za-z][A-Za-z .'-]*?)(?=\s+\d{3,})/i);
  const oldPoMatch = text.match(/PO,?\s*Number\s*[\r\n]+20\d{2}-\d{2}-\d{2}\s+(\d{5,})/i);
  const standalonePoMatch = text.match(/(?:^|\r?\n)PO\s*:\s*([A-Z0-9-]+)/i);
  const inlinePoMatch = text.match(/PO,?\s*Number[\s\S]{0,80}?20\d{2}-\d{2}-\d{2}\s+([A-Z0-9-]+(?:-\s*[\r\n]+\s*[A-Z0-9-]+)?)/i);
  const splitPoMatch = text.match(/PO,?\s*Number[\s\S]{0,80}?20\d{2}-\d{2}-\d{2}\s+([A-Z0-9-]+-)\s*[\r\n]+\s*([A-Z0-9-]+)/i);
  const linePoMatch = text.match(/PO,?\s*Number[\s\S]{0,80}?20\d{2}-\d{2}-\d{2}\s+([^\r\n]+)/i);
  const oldTotalMatch = text.match(/Total\s+\$\s*([\d,]+\.\d{2})/i);
  const jasperTotal = extractJasperKometInvoiceTotal(text);

  const altDate = text.match(/PO\s+DATE:\s*[\r\n]*\s*(20\d{2}-\d{2}-\d{2})/i);
  const altNumber = text.match(/INVOICE\s*#:\s*([A-Z0-9-]+)/i);
  const altPo = text.match(/ORDER\s*#:\s*([A-Z0-9-]+)/i);
  const altTotal = text.match(/Invoice\s+Total\s*\$\s*([\d,]+\.\d{2})/i);
  const altLocation = text.match(/Location\s*ID:[^\r\n]*[\r\n]+\s*([^\r\n]+)/i);
  const altClient = altDate && altNumber && /Trader Joe's/i.test(text) ? "Trader Joe's" : '';

  const fontanaDate = text.match(/PO\s+Date\s*:\s*[\r\n]+\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})/i);
  const fontanaIssued = fontanaDate ? `${fontanaDate[3]}-${String(fontanaDate[1]).padStart(2, '0')}-${String(fontanaDate[2]).padStart(2, '0')}` : '';
  const fontanaNumber = text.match(/Invoice\s*#\s*:\s*([A-Z0-9-]+)/i);
  const fontanaPo = text.match(/Order\s+Number\s*:\s*([A-Z0-9-]+)/i);
  const fontanaClient = text.match(/^Invoice\s*[\r\n]+\s*([^\r\n]+)\s*[\r\n]+\s*Invoice\s*#/im);
  const fontanaLocation = text.match(/Location\s+ID\s*:[^\r\n]*[\r\n]+\s*([^\r\n]+)/i);
  const fontanaTotal = text.match(/Invoice\s+Total\s*\$\s*([\d,]+\.\d{2})/i);

  const newDate = text.match(/SHIP DATE\s*:\s*(\d{1,2})-(\d{1,2})-(20\d{2})/i);
  let newIssued = '';
  if (newDate) { let first = Number(newDate[1]); let second = Number(newDate[2]); if (first > 12) [first, second] = [second, first]; newIssued = `${newDate[3]}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`; }
  const newNumber = text.match(/(?:^|\r?\n)INVOICE\s*:\s*([A-Z0-9-]+)/i);
  const newClient = text.match(/INVOICE\s*:\s*[A-Z0-9-]+\s*[\r\n]+([^\r\n]+)/i);
  const newClientAfterTotal = text.match(/TOTAL DOLLARS\s*\$?\s*[\d,]+\.\d{2}\s*[\r\n]+([^\r\n]+)/i);
  const newPo = text.match(/PO\s+NUM\w*\s*:\s*([A-Z0-9-]+)/i);
  const newTotal = text.match(/\$\s*([\d,]+\.\d{2})\s*TOTAL DOLLARS/i);
  const prefixTotal = text.match(/TOTAL DOLLARS\s*\$\s*([\d,]+\.\d{2})/i);
  const labeledTotal = text.match(/([\d,]+\.\d{2})\s+TOTAL\b/i);

  // Centro Floricultor: el encabezado usa nombres en español y el total va
  // debajo de la etiqueta TOTAL, por ejemplo:
  // `INVOICE: 298`, `ORDEN DE COMPRA: 298-3626`,
  // `SHIP DATE: SEPTIEMBRE-08-2026` y `Customer: ...`.
  const centroInvoice = text.match(/(?:^|\r?\n)\s*INVOICE\s*:\s*([A-Z0-9-]+)/i);
  const centroPo = text.match(/ORDEN\s+DE\s+COMPRA\s*:\s*([A-Z0-9-]+)/i);
  const centroClient = text.match(/(?:^|\r?\n)\s*Customer\s*:\s*([^\r\n]+)/i);
  const centroClientAfterInvoice = text.match(/INVOICE\s*:\s*[A-Z0-9-]+\s*\r?\n\s*([^\r\n]+)/i);
  const centroDate = text.match(/SHIP\s+DATE\s*:\s*([A-ZÁÉÍÓÚ]+)-(\d{1,2})-(20\d{2})/i);
  const centroMonthNames = {
    enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
    julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
    noviembre: '11', diciembre: '12'
  };
  const centroMonth = centroDate ? centroMonthNames[String(centroDate[1]).toLowerCase()] : '';
  const centroIssued = centroDate && centroMonth
    ? `${centroDate[3]}-${centroMonth}-${String(centroDate[2]).padStart(2, '0')}`
    : '';
  const centroTotal = text.match(/([\d,]+\.\d{2})\s*TOTAL\b/i);

  const pacificaDate = text.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})\s+Invoice Date/i) || text.match(/^\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})\s*$/m);
  const pacificaIssued = pacificaDate ? `${pacificaDate[3]}-${pacificaDate[1].padStart(2, '0')}-${pacificaDate[2].padStart(2, '0')}` : '';
  const pacificaInvoice = text.match(/Ship To\s*[\r\n]+([A-Z]?\d{4,})\s*[\r\n]+Bill To/i);
  const pacificaWInvoice = text.match(/\b(W\d{6,})\b/i);
  const pacificaClientMatch = text.match(/Sales Rep\s*[\r\n]+([^\r\n]+)/i);
  const pacificaClientAfterCarrier = text.match(/Armellini\s*-\s*Regular[ \t]+([^\r\n]+)/i);
  const pacificaClientBeforeShip = text.match(/([^\r\n]+)\s*[\r\n]+Ship To\s*[\r\n]+[A-Z]?\d{4,}\s*[\r\n]+Bill To/i);
  const pacificaPo = text.match(/Bill To[\s\S]{0,80}?Net\s+\d+\s*[\r\n]+([A-Z0-9-]+)\s*[\r\n]+Terms/i);
  const pacificaTotal = text.match(/Totals[\s\S]{0,80}?\$\s*([\d,]+\.\d{2})/i);
  const pacificaTopAmount = text.match(/^\s*\$\s*([\d,]+\.\d{2})\s*$/m);
  const sampleHeader = text.match(/Origin Division\s+Invoice No\.\s+Order No\.[\s\S]{0,140}?(20\d{2}-\d{2}-\d{2})\s+([A-Z0-9-]+)\s+([A-Z0-9-]+)/i);
  const sampleClient = text.match(/SOLD TO\.\s*SHIP TO\.[\s\S]{0,40}?\r?\n([^\r\n]+)/i);
  const sampleTotal = text.match(/\bTotal\s+\$\s*([\d,]+\.\d{2})/i);
  const pacificaClient = pacificaClientAfterCarrier?.[1] || pacificaClientMatch?.[1] || (pacificaClientBeforeShip?.[1] && !/^\s*[\d(]/.test(pacificaClientBeforeShip[1]) ? pacificaClientBeforeShip[1] : '');

  const issued = altDate?.[1] || fontanaIssued || oldDateMatch?.[1] || newIssued || centroIssued || pacificaIssued || sampleHeader?.[1];
  const folio = altNumber?.[1] || oldNumberMatch?.[1] || newNumber?.[1] || centroInvoice?.[1] || pacificaInvoice?.[1] || originInvoiceMatch?.[1] || compactOriginInvoiceMatch?.[1] || pacificaWInvoice?.[1] || fontanaNumber?.[1] || sampleHeader?.[2] || '';
  const rawClient = altClient || oldClientMatch?.[1] || inlineSoldToMatch?.[1] || newClientAfterTotal?.[1] || centroClientAfterInvoice?.[1] || centroClient?.[1] || newClient?.[1] || pacificaClient || fontanaClient?.[1] || sampleClient?.[1] || '';
  const totalValue = jasperTotal || altTotal?.[1] || oldTotalMatch?.[1] || newTotal?.[1] || prefixTotal?.[1] || centroTotal?.[1] || pacificaTotal?.[1] || pacificaTopAmount?.[1] || labeledTotal?.[1] || fontanaTotal?.[1] || sampleTotal?.[1] || '';
  const poCandidates = [altPo?.[1], standalonePoMatch?.[1], splitPoMatch ? `${splitPoMatch[1]}${splitPoMatch[2]}` : '', oldPoMatch?.[1], newPo?.[1], centroPo?.[1], pacificaPo?.[1], sampleHeader?.[3], fontanaPo?.[1], inlinePoMatch?.[1], linePoMatch?.[1]?.trim()];
  const usablePo = value => { const candidate = String(value || '').trim(); return candidate.length >= 3 && !/\s/.test(candidate) && !/^(?:item|description|unit|price|total|value|number)$/i.test(candidate) && !/^20\d{2}-\d{2}-\d{2}$/.test(candidate); };
  if (!issued || !folio || !rawClient || !totalValue) throw new Error('No se pudieron detectar todos los datos principales de la factura.');
  const client = rawClient.replace(/\s+\d{3,}\s+.*$/, '').trim();
  const location = (altLocation?.[1] || fontanaLocation?.[1] || '').replace(/\s+XDOCK\b.*$/i, '').trim();
  return { folio, client, issued, due: addOneMonth(issued), amount: Number(totalValue.replace(/,/g, '')), poNumber: poCandidates.find(usablePo)?.trim() || folio, guideNumber: isGalleriaClient(rawClient) ? extractOrderNumber(text) : '', location, concept: 'Invoice importado desde PDF', searchText: buildInvoiceSearchText(text) };
}

function normalizeCreditDate(value) {
  const raw = String(value || '').trim();
  const iso = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  return us ? `${us[3]}-${us[1]}-${us[2]}` : '';
}

export async function extractCreditPdf(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const result = await extractText(source.slice(), { mergePages: true });
  const text = String(result.text || '').replace(/\u00a0/g, ' ');
  const poNumber = text.match(/(?:^|\r?\n)P\.?O\.?\s*(?:#|:)?\s*([A-Z0-9-]+)/i)?.[1]?.trim() || '';
  const creditNumber = text.match(/(?:^|\r?\n)CREDIT\s*:\s*([A-Z0-9-]+)/i)?.[1]?.trim() || '';
  const customer = text.match(/Customer\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
  const guideNumber = isGalleriaClient(customer) || /Galleria\s+Farms/i.test(text) ? extractOrderNumber(text) : '';
  const date = text.match(/SHIP\s*DATE\s*:\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4})/i)?.[1] || '';
  const total = text.match(/(?:^|\r?\n| )TOTAL\s*\$?\s*([\d,]+\.\d{2})/i) || text.match(/Total\s*\$?\s*([\d,]+\.\d{2})/i) || text.match(/\$?\s*([\d,]+\.\d{2})\s+TOTAL/i);
  return { poNumber, guideNumber, creditNumber, client: customer, amount: Number(String(total?.[1] || '0').replace(/,/g, '')), creditDate: normalizeCreditDate(date) };
}
