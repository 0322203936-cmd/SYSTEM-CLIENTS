import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvoiceSearchText, extractInvoiceDocumentText } from './invoice-search.mjs';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(serverDirectory, 'data');
const dataFile = path.join(dataDirectory, 'database.json');
const uploadsDirectory = path.join(dataDirectory, 'uploads');
const scanFile = path.join(dataDirectory, 'invoice-search-backfill.json');
const mode = process.argv[2] || 'scan';

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

async function scanInvoices() {
  const sourceBytes = await fs.readFile(dataFile);
  const database = JSON.parse(sourceBytes.toString('utf8'));
  const records = [];
  const failures = [];

  for (const [index, invoice] of (database.invoices || []).entries()) {
    const relativePath = invoice.invoicePdfPath || `${invoice.id}-invoice.pdf`;
    try {
      const buffer = await fs.readFile(path.join(uploadsDirectory, relativePath));
      const searchText = buildInvoiceSearchText(await extractInvoiceDocumentText(buffer));
      if (searchText) records.push({ id: invoice.id, searchText });
      else failures.push({ id: invoice.id, folio: invoice.folio, reason: 'PDF sin texto indexable.' });
    } catch (error) {
      failures.push({ id: invoice.id, folio: invoice.folio, reason: error.message });
    }
    if ((index + 1) % 50 === 0) console.log(`INDEXED_PROGRESS=${index + 1}/${database.invoices.length}`);
  }

  const result = {
    createdAt: new Date().toISOString(),
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    invoiceCount: database.invoices?.length || 0,
    records,
    failures
  };
  await writeJsonAtomic(scanFile, result);
  console.log(JSON.stringify({ mode: 'scan', invoiceCount: result.invoiceCount, indexed: records.length, failed: failures.length, scanFile }, null, 2));
}

async function applyScan() {
  const scan = JSON.parse(await fs.readFile(scanFile, 'utf8'));
  const database = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  const searchById = new Map((scan.records || []).map(record => [String(record.id), record.searchText]));
  let updated = 0;
  for (const invoice of database.invoices || []) {
    const searchText = searchById.get(String(invoice.id));
    if (searchText && invoice.searchText !== searchText) {
      invoice.searchText = searchText;
      updated++;
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dataFile}.backup-search-${timestamp}`;
  await fs.copyFile(dataFile, backupPath);
  await writeJsonAtomic(dataFile, database);
  console.log(JSON.stringify({ mode: 'apply', updated, backupPath, indexed: scan.records?.length || 0, failed: scan.failures?.length || 0 }, null, 2));
}

if (mode === 'scan') await scanInvoices();
else if (mode === 'apply') await applyScan();
else throw new Error('Usa "scan" o "apply".');
