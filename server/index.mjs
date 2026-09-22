import 'dotenv/config';
import { resolveEmailLogin, historyInvoiceAccess, canSendEmailForInvoice, canSendStatementForCustomer, resolveEmailDeliveryRecipients } from './email-login.mjs';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import convertHeic from 'heic-convert';
import XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import { PDFDocument } from 'pdf-lib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { matchStatementRows } from './statement-matcher.mjs';
import { extractReceivingReferences, findExplicitMultiReceivingInvoices, findReceivingInvoices, shouldAppendMatchedReceiving } from './receiving-matcher.mjs';
import { mergeReceivingPdfBuffers, normalizePdfBufferToPrintSize } from './receiving-pdf-merge.mjs';
import { isDuplicateInvoice } from './invoice-duplicate-matcher.mjs';
import { checkCustomersMatch } from './check-customer-matcher.mjs';
import { extractJasperKometInvoiceTotal } from './invoice-total-matcher.mjs';
import { extractKometInvoiceVariant } from './komet-invoice-variant.mjs';
import { extractDosGringosInvoice } from './dos-gringos-invoice.mjs';
import { buildCreditAllocationCandidates } from './credit-allocation.mjs';
import { buildInvoiceSearchText, extractInvoiceDocumentText } from './invoice-search.mjs';
import { neonEnabled, readNeonDb, writeNeonDb } from './neon-store.mjs';
import { shouldSaveEmailTemplate } from './email-template-save.mjs';
import { publicEmailStatus } from './email-status.mjs';
import { deleteOracleObject, getOracleObject, oracleStorageReady, putOracleObject } from './oracle-storage.mjs';
import { loadWalmexInvoices } from '../worker/walmex-source.mjs';
import { findCreditRecords } from './credit-replacement-matcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'database.json');
const uploadsDir = path.join(dataDir, 'uploads');
const reconciliationWorkbook = path.join(__dirname, '..', 'consolidacion.xlsx');
const statementSnapshotFile = path.join(dataDir, 'statement-reconciliation.json');
const creditReconciliationWorkbook = path.join(dataDir, 'credit-reconciliation.xlsx');
const creditFlagOverridesFile = path.join(dataDir, 'credit-flag-overrides.json');
const invoiceSyncJobFile = path.join(dataDir, 'invoice-sync-job.json');
const agentsFile = path.join(dataDir, 'agents.json');
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-esta-clave-en-produccion';
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const sharePoint = {
  tenantId: process.env.SHAREPOINT_TENANT_ID,
  clientId: process.env.SHAREPOINT_CLIENT_ID,
  clientSecret: process.env.SHAREPOINT_CLIENT_SECRET,
  hostname: 'pacificafarms-my.sharepoint.com',
  personalSitePath: '/personal/michele_martinez_cfbc_co',
  rootFolder: '02.PACIFICA'
};
// Buzón desde el que salen los correos de facturas. Requiere el permiso de
// aplicación Mail.Send concedido a la misma app de Azure que usa SharePoint.
const mailFrom = process.env.MAIL_FROM || '';
// Centro Floricultor factura desde su propio buzon; el resto sale del de AR.
const mailFromCentro = process.env.MAIL_FROM_CENTRO || '';
let graphToken = { value: '', expiresAt: 0 };
let activeInvoiceSyncJob = null;
let invoiceSyncJobPersist = Promise.resolve();

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:4200' }));
// 6 MB deja pasar el logo incrustado de las plantillas de correo.
app.use(express.json({ limit: '6mb' }));

async function seedDatabase() {
  await fs.mkdir(dataDir, { recursive: true });
  try { await fs.access(dataFile); return; } catch { /* create initial data */ }
  const users = [
    { id: 1, username: 'Jesus.sandoval@cfbc.co', email: 'Jesus.sandoval@cfbc.co', name: 'Jesús C.', role: 'admin', active: true, createdAt: new Date().toISOString(), passwordHash: await bcrypt.hash('jesuscholo22', 12) },
    { id: 2, username: 'cliente', email: 'cliente@demo.com', name: 'Mariana López', role: 'client', active: true, createdAt: new Date().toISOString(), passwordHash: await bcrypt.hash('Cliente2026', 12) }
  ];
  const invoices = [
    { id: 1, folio: 'FAC-2026-0048', client: 'Mariana López', email: 'cliente@demo.com', concept: 'Consultoría mensual', issued: '2026-07-01', due: '2026-07-15', amount: 14500, status: 'Pendiente' },
    { id: 2, folio: 'FAC-2026-0047', client: 'Mariana López', email: 'cliente@demo.com', concept: 'Implementación de plataforma', issued: '2026-06-14', due: '2026-06-28', amount: 28750, status: 'Pagada' },
    { id: 3, folio: 'FAC-2026-0046', client: 'Carlos Ramírez', email: 'carlos@empresa.mx', concept: 'Soporte técnico premium', issued: '2026-06-03', due: '2026-06-18', amount: 8900, status: 'Vencida' },
    { id: 4, folio: 'FAC-2026-0045', client: 'Sofía Herrera', email: 'sofia@estudio.mx', concept: 'Diseño de identidad corporativa', issued: '2026-05-20', due: '2026-06-03', amount: 19200, status: 'Pagada' },
    { id: 5, folio: 'FAC-2026-0044', client: 'Carlos Ramírez', email: 'carlos@empresa.mx', concept: 'Licencias anuales', issued: '2026-05-11', due: '2026-05-25', amount: 12400, status: 'Pendiente' }
  ];
  await writeDb({ users, invoices });
}

const canonicalClientNames = new Map([
  ['starter-bros-markets-socal', 'Starter Bros. Markets'],
  // Dos Gringos PDFs omit punctuation in this legal name. Keep one
  // canonical key/folder for Gringo South without changing displayed text.
  ['gringo-south-sa-de-cv', 'Gringo South S.A de C.V']
]);

function normalizeClientKey(value) {
  const normalized = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const canonicalName = canonicalClientNames.get(normalized);
  return canonicalName ? canonicalName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : normalized;
}

function isGalleriaClient(value) {
  return normalizeClientKey(value).includes('galleria-farms');
}

function normalizeFolio(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

function normalizeReference(value) {
  return normalizeFolio(String(value ?? '').replace(/\s+/g, ''));
}

// Las facturas internas usan ids numericos; Walmex usa ids estables como
// "walmex-1171" porque provienen de una fuente externa de solo lectura.
function normalizeInvoiceId(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  return /^\d+$/.test(text) ? Number(text) : text;
}

function invoiceIdMatches(left, right) {
  return String(left) === String(right);
}

function isWalmexInvoice(invoice) {
  return Boolean(invoice?.walmexSource || invoice?.clientKey === 'walmex' || String(invoice?.id || '').toLowerCase().startsWith('walmex-'));
}

function checkInvoiceBalance(invoice) {
  return invoice?.status === 'Pagada'
    ? 0
    : Math.max(0, Number(invoice?.balance ?? (Number(invoice?.amount || 0) - Number(invoice?.creditAmount || 0))));
}

function reconciliationDuplicateKey(client, folio) {
  const reference = normalizeReference(folio);
  if (!reference) return '';
  return `${normalizeClientKey(client) || '*'}::${reference}`;
}

// Algunos proveedores agregan una letra al folio dentro del portal (por ejemplo
// 7557A), mientras que ContPAQ conserva el folio numérico (7557). Solo usamos
// esta variante cuando fecha e importe también confirman la coincidencia.
function normalizeFolioVariant(value) {
  return normalizeReference(value).replace(/A$/, '');
}

function reconciliationContextMatches(invoice, row) {
  const invoiceDate = String(invoice.issued || invoice.issueDate || invoice.date || '').slice(0, 10);
  const invoiceAmount = Number(invoice.amount);
  const amountMatches = Number.isFinite(invoiceAmount) && Number.isFinite(row.total)
    ? Math.abs(invoiceAmount - row.total) < 0.01
    : false;
  const dateMatches = Boolean(invoiceDate && row.date && invoiceDate === row.date);
  return amountMatches && dateMatches;
}

function reconciliationAmountMatches(invoice, row) {
  const invoiceAmount = Number(invoice.amount);
  return Number.isFinite(invoiceAmount) && Number.isFinite(row.total)
    && Math.abs(invoiceAmount - row.total) < 0.01;
}

function reconciliationBalance(invoice) {
  const storedBalance = Number(invoice.balance);
  if (Number.isFinite(storedBalance)) return storedBalance;
  const amount = Number(invoice.amount);
  const credits = Number(invoice.creditAmount || 0);
  return Number.isFinite(amount) ? amount - (Number.isFinite(credits) ? credits : 0) : 0;
}

function reconciliationBalanceMatches(invoice, balance) {
  return Number.isFinite(balance) && Math.abs(reconciliationBalance(invoice) - balance) < 0.01;
}

function reconciliationClientMatches(invoice, row) {
  return Boolean(invoice.client && row.client)
    && normalizeClientKey(invoice.client) === normalizeClientKey(row.client);
}

function reconciliationDateDistance(invoice, row) {
  const invoiceDate = String(invoice.issued || invoice.issueDate || invoice.date || '').slice(0, 10);
  if (!invoiceDate || !row.date) return Number.POSITIVE_INFINITY;
  const invoiceTime = Date.parse(`${invoiceDate}T00:00:00Z`);
  const rowTime = Date.parse(`${row.date}T00:00:00Z`);
  if (!Number.isFinite(invoiceTime) || !Number.isFinite(rowTime)) return Number.POSITIVE_INFINITY;
  return Math.abs(invoiceTime - rowTime) / 86400000;
}

function chooseReconciliationCandidate(candidates, row) {
  const exactContext = candidates.filter(candidate => reconciliationContextMatches(candidate, row));
  if (exactContext.length === 1) return exactContext[0];

  // El mismo PO puede aparecer con un folio distinto o con una fecha de captura
  // diferente. Importe y cliente siguen siendo las confirmaciones principales;
  // la fecha solo desempata entre varios candidatos.
  const amountMatches = candidates.filter(candidate => reconciliationAmountMatches(candidate, row));
  if (!amountMatches.length) return null;

  const ranked = amountMatches
    .map(candidate => ({
      candidate,
      clientMatch: reconciliationClientMatches(candidate, row),
      dateDistance: reconciliationDateDistance(candidate, row)
    }))
    .sort((a, b) => Number(b.clientMatch) - Number(a.clientMatch) || a.dateDistance - b.dateDistance);

  const best = ranked[0];
  const next = ranked[1];
  const isUniqueBest = best && (!next
    || best.clientMatch !== next.clientMatch
    || best.dateDistance < next.dateDistance);
  return isUniqueBest ? best.candidate : null;
}

function normalizeExcelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }
  return String(value ?? '').trim();
}

async function readDb() {
  const db = await readNeonDb() || JSON.parse(await fs.readFile(dataFile, 'utf8'));
  const creditFlagOverrides = await readCreditFlagOverrides();
  let changed = false;
  if (!Array.isArray(db.checks)) { db.checks = []; changed = true; }
  if (!Array.isArray(db.supportTickets)) { db.supportTickets = []; changed = true; }
  if (!Array.isArray(db.notifications)) { db.notifications = []; changed = true; }
  if (!Array.isArray(db.emailTemplates)) { db.emailTemplates = []; changed = true; }
  if (!Array.isArray(db.emailLog)) { db.emailLog = []; changed = true; }
  for (const user of db.users || []) {
    if (user.role === 'client' && !user.clientKey) { user.clientKey = normalizeClientKey(user.name); changed = true; }
  }
  for (const invoice of db.invoices || []) {
    if (!invoice.clientKey) { invoice.clientKey = normalizeClientKey(invoice.client); changed = true; }
    if (invoice.guideNumber && !isGalleriaClient(invoice.client)) { delete invoice.guideNumber; changed = true; }
    for (const credit of invoice.credits || []) {
      const repairedDate = historicalCreditDateOverrides[String(credit.creditNumber || '')];
      if (!credit.date && repairedDate) { credit.date = repairedDate; changed = true; }
      const override = creditFlagOverrides.find(item => item.creditNumber === String(credit.creditNumber || '').trim()
        && item.clientKey === normalizeClientKey(invoice.client));
      if (override) {
        const target = db.invoices.find(candidate => candidate.id !== invoice.id
          && normalizeClientKey(candidate.client) === itemClientKey(override)
          && normalizeReference(candidate.folio) === normalizeReference(override.targetFolio)
          && (!override.targetGuide || normalizeReference(candidate.guideNumber) === normalizeReference(override.targetGuide)));
        if (target && Number(credit.creditFlagTargetInvoiceId) !== target.id) {
          credit.creditFlagTargetInvoiceId = target.id;
          changed = true;
        }
      }
    }
    if (!invoice.guideNumber && invoice.invoicePdfPath && isGalleriaClient(invoice.client)) {
      try {
        const invoiceBuffer = await readPdfPathFromStorage(invoice.invoicePdfPath);
        if (!invoiceBuffer) throw new Error('PDF no disponible');
        const extracted = await extractInvoicePdf(invoiceBuffer);
        if (extracted.guideNumber) { invoice.guideNumber = extracted.guideNumber; changed = true; }
      } catch {
        // Some historical invoice PDFs are no longer available locally.
      }
    }
  }
  if (changed) await writeDb(db);
  return db;
}

// Los agentes viven fuera de database.json: ese archivo lo reescribe por
// completo la sincronizacion con Oracle y borraria la cartera.
async function readAgents() {
  try {
    const agents = JSON.parse(await fs.readFile(agentsFile, 'utf8'));
    return Array.isArray(agents) ? agents : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAgents(agents) {
  const temp = `${agentsFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(agents, null, 2), 'utf8');
  await fs.rename(temp, agentsFile);
}

// El texto del correo se comparte por empresa emisora: editarlo para un
// cliente de Pacifica lo deja igual para todos los de Pacifica. Solo los
// destinatarios siguen siendo de cada cliente.
function upsertEmailTemplate(db, clientKey, patch) {
  if (!clientKey) return;
  db.emailTemplates = db.emailTemplates || [];
  const existing = db.emailTemplates.find(item => item.clientKey === clientKey);
  if (existing) Object.assign(existing, patch, { clientKey, updatedAt: new Date().toISOString() });
  else db.emailTemplates.push({ clientKey, ...patch, updatedAt: new Date().toISOString() });
}

async function readCreditFlagOverrides() {
  try {
    const overrides = JSON.parse(await fs.readFile(creditFlagOverridesFile, 'utf8'));
    return Array.isArray(overrides) ? overrides : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function itemClientKey(override) {
  return normalizeClientKey(override.clientKey || override.client || '');
}
async function writeDb(data) {
  if (neonEnabled()) await writeNeonDb(data);
  const temp = `${dataFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, dataFile);
}

function invoiceSyncJobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total || 0,
    scanned: job.scanned || 0,
    processed: job.processed || 0,
    skipped: job.skipped || 0,
    currentFile: job.currentFile || '',
    message: job.message || '',
    issues: Array.isArray(job.issues) ? job.issues : [],
    details: Array.isArray(job.details) ? job.details : [],
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    updatedAt: new Date().toISOString()
  };
}

function persistInvoiceSyncJob(job) {
  const snapshot = invoiceSyncJobSnapshot(job);
  invoiceSyncJobPersist = invoiceSyncJobPersist
    .catch(() => undefined)
    .then(async () => {
      const temp = `${invoiceSyncJobFile}.tmp`;
      await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.rename(temp, invoiceSyncJobFile);
    })
    .catch(error => console.error('[SYNC JOB] No se pudo guardar el checkpoint:', error.message));
  return invoiceSyncJobPersist;
}

function updateInvoiceSyncJob(job, patch, persist = true) {
  if (!job) return;
  Object.assign(job, patch);
  if (persist) void persistInvoiceSyncJob(job);
}

async function readInvoiceSyncJob(jobId) {
  if (activeInvoiceSyncJob?.id === jobId) return invoiceSyncJobSnapshot(activeInvoiceSyncJob);
  try {
    const saved = JSON.parse(await fs.readFile(invoiceSyncJobFile, 'utf8'));
    return saved?.id === jobId ? saved : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readStatementSnapshot() {
  try {
    return JSON.parse(await fs.readFile(statementSnapshotFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeStatementSnapshot(snapshot) {
  const temp = `${statementSnapshotFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.rename(temp, statementSnapshotFile);
}

function sharePointReady() {
  return Boolean(sharePoint.tenantId && sharePoint.clientId && sharePoint.clientSecret);
}

// External SharePoint/Graph requests must never hold a synchronization open
// indefinitely. A timeout only aborts the current network operation; it does
// not modify local data or remove the source PDF.
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(operation, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function graphAccessToken() {
  if (graphToken.value && graphToken.expiresAt > Date.now() + 60_000) return graphToken.value;
  if (!sharePointReady()) throw new Error('Faltan las variables de conexión de SharePoint en el archivo .env.');
  const body = new URLSearchParams({ client_id: sharePoint.clientId, client_secret: sharePoint.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const response = await fetchWithTimeout(`https://login.microsoftonline.com/${sharePoint.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'No fue posible autenticar con Microsoft Graph.');
  graphToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return graphToken.value;
}

async function graphRequest(endpoint, options = {}) {
  const token = await graphAccessToken();
  const response = await fetchWithTimeout(`https://graph.microsoft.com/v1.0${endpoint}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${data.error?.message || `Microsoft Graph respondió ${response.status}.`} (HTTP ${response.status}, endpoint ${endpoint})`);
  return data;
}

// --- Correo saliente (Microsoft Graph) -------------------------------------

// Por encima de este tamaño el adjunto ya no cabe en una sola petición de Graph
// y hay que subirlo por sesión de carga sobre un borrador.
const SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

// El emisor se deduce del texto extraido del PDF: las de Centro Floricultor
// lo llevan en el encabezado. El resto es Pacifica, que es la emisora normal.
function invoiceIssuerKey(invoice) {
  const text = `${invoice?.searchText || ''} ${invoice?.concept || ''}`.toLowerCase();
  return text.includes('centro floricultor') ? 'centro' : 'pacifica';
}

function senderForIssuer(issuer) {
  return issuer === 'centro' && mailFromCentro ? mailFromCentro : mailFrom;
}

function mailReady() {
  return Boolean(sharePointReady() && mailFrom);
}

function parseRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[;,]/);
  return list
    .map(item => String(item || '').trim())
    .filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    .map(address => ({ emailAddress: { address } }));
}

async function graphSendMailWithAttachment({ to, cc, subject, html, attachment, from }) {
  const fromAddress = from || mailFrom;
  if (!fromAddress) throw new Error('Falta configurar MAIL_FROM en el archivo .env.');
  const sender = encodeURIComponent(fromAddress);
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: to,
    ccRecipients: cc
  };

  // Sin adjunto o con uno pequeño: una sola llamada.
  if (!attachment || attachment.buffer.length < SIMPLE_ATTACHMENT_LIMIT) {
    if (attachment) {
      message.attachments = [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: attachment.name,
        contentType: 'application/pdf',
        contentBytes: attachment.buffer.toString('base64')
      }];
    }
    await graphRequest(`/users/${sender}/sendMail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true })
    });
    return;
  }

  // Adjunto grande: borrador + sesión de carga + envío.
  const draft = await graphRequest(`/users/${sender}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  if (!draft?.id) throw new Error('No fue posible crear el borrador del correo.');

  const session = await graphRequest(`/users/${sender}/messages/${draft.id}/attachments/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      AttachmentItem: { attachmentType: 'file', name: attachment.name, size: attachment.buffer.length, contentType: 'application/pdf' }
    })
  });
  if (!session?.uploadUrl) throw new Error('No fue posible iniciar la carga del adjunto.');

  const chunkSize = 4 * 1024 * 1024;
  for (let start = 0; start < attachment.buffer.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, attachment.buffer.length) - 1;
    const chunk = attachment.buffer.subarray(start, end + 1);
    const response = await fetchWithTimeout(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${attachment.buffer.length}`
      },
      body: chunk
    });
    if (!response.ok && response.status !== 201 && response.status !== 202) {
      throw new Error(`Falló la carga del adjunto (HTTP ${response.status}).`);
    }
  }

  await graphRequest(`/users/${sender}/messages/${draft.id}/send`, { method: 'POST' });
}

async function getSharePointDrive() {
  const site = await graphRequest(`/sites/${sharePoint.hostname}:${sharePoint.personalSitePath}`);
  if (!site?.id) throw new Error('No se encontró el sitio personal de SharePoint configurado.');
  const drive = await graphRequest(`/sites/${site.id}/drive`);
  if (!drive?.id) throw new Error('No se encontró la biblioteca de documentos de SharePoint.');
  return { siteId: site.id, driveId: drive.id };
}

// Walmex stores its invoice and receiving images in a separate SharePoint
// site.  The source URLs are private SharePoint links, so they must be read
// server-side with Graph instead of being opened directly by the browser
// (which would send the user to SharePoint's login page).
async function getWalmexDrive() {
  const site = await graphRequest('/sites/pacificafarms.sharepoint.com:/sites/requerimientovsproyeccion');
  if (!site?.id) throw new Error('No se encontró el sitio de Walmex en SharePoint.');
  const drive = await graphRequest(`/sites/${site.id}/drive`);
  if (!drive?.id) throw new Error('No se encontró la biblioteca de Walmex en SharePoint.');
  return drive.id;
}

function walmexRelativePath(rawUrl) {
  const raw = String(rawUrl || '');
  let relative = '';
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== 'pacificafarms.sharepoint.com') return null;
    const marker = '/Shared Documents/';
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    relative = decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
  } else {
    relative = decodeURIComponent(raw);
  }
  relative = relative.replace(/^\/+|\/+$/g, '');
  // Keep this proxy limited to the two Walmex document folders; in particular,
  // do not allow traversal or arbitrary files from the SharePoint drive.
  if (!/^requerimiento vs proyeccion\/WALMEX\/Gastos\/(?:Facturas|Acuses)\/[^/]+$/i.test(relative)) return null;
  if (relative.split('/').some(part => part === '..')) return null;
  return relative;
}

async function getOrCreateFolder(driveId, parentId, name) {
  const childrenEndpoint = parentId ? `/drives/${driveId}/items/${parentId}/children` : `/drives/${driveId}/root/children`;
  const escapedName = String(name).replace(/'/g, "''");
  const filter = encodeURIComponent(`name eq '${escapedName}'`);
  const existing = await graphRequest(`${childrenEndpoint}?$filter=${filter}`);
  const found = existing?.value?.find(item => item.folder && item.name === name);
  if (found) return found;
  return graphRequest(childrenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
}

function graphNextEndpoint(nextLink) {
  if (!nextLink) return '';
  try {
    const url = new URL(nextLink);
    return `${url.pathname.replace(/^\/v1\.0/, '')}${url.search}`;
  } catch {
    return String(nextLink);
  }
}

async function listDriveChildren(driveId, parentId) {
  const items = [];
  let endpoint = `/drives/${driveId}/items/${parentId}/children?$top=200`;
  while (endpoint) {
    const page = await graphRequest(endpoint);
    items.push(...(page?.value || []));
    endpoint = graphNextEndpoint(page?.['@odata.nextLink']);
  }
  return items;
}

async function collectInvoiceSyncFiles(driveId, rootId) {
  const rootItems = await listDriveChildren(driveId, rootId);
  // `02.PACIFICA` is the synchronization inbox. Only files placed
  // directly in that folder are pending imports; customer folders and
  // archives (including `Dos gringos`) contain already-processed documents
  // and must never be scanned as new source files.
  return rootItems
    .filter(item => !item.folder && isSyncDocument(item.name))
    .map(file => ({ file, sourcePath: file.name }));
}

async function uploadToSharePoint(buffer, driveId, parentId, fileName) {
  const session = await graphRequest(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(fileName)}:/createUploadSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } }) });
  const response = await fetchWithTimeout(session.uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(buffer.length), 'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}` }, body: buffer }, 180_000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `No se pudo subir ${fileName} a SharePoint.`);
  return data;
}

function safeFolderName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100) || 'Sin cliente';
}

function sharePointClientFolderName(value) {
  const raw = String(value || '').trim();
  return canonicalClientNames.get(raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || raw;
}

async function uploadInvoiceFilesToSharePoint({ client, location, issued, folio, invoiceFile, receivingFile }) {
  if (!invoiceFile && !receivingFile) return {};
  const { driveId } = await getSharePointDrive();
  const root = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
  const clientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(sharePointClientFolderName(client)));
  const locationFolder = location
    ? await getOrCreateFolder(driveId, clientFolder.id, safeFolderName(location))
    : clientFolder;
  const dateFolder = await getOrCreateFolder(driveId, locationFolder.id, issued);
  const result = {};
  if (invoiceFile) result.invoice = await uploadToSharePoint(invoiceFile.buffer, driveId, dateFolder.id, `Invoice-${folio}.pdf`);
  if (receivingFile) result.receiving = await uploadToSharePoint(receivingFile.buffer, driveId, dateFolder.id, `Receiving-${folio}.pdf`);
  return result;
}

async function attachReceivingToInvoices({ invoices, file, buffer, db, appendToExisting = false, sourceFiles = [file] }) {
  const normalizedSourceFiles = sourceFiles.map(source => ({
    id: String(source?.id || ''),
    name: String(source?.name || '')
  }));
  const sourceFileIds = normalizedSourceFiles.map(source => source.id).filter(Boolean);
  const sourceFileNames = normalizedSourceFiles.map(source => source.name).filter(Boolean);
  const sourceFileName = String(file?.name || sourceFileNames.join(' + ') || 'Receiving.pdf');
  const plans = [];
  const alreadyIncludedInvoices = [];

  for (const invoice of invoices) {
    const recordedSourceFileIds = Array.isArray(invoice.receivingSourceFileIds) ? invoice.receivingSourceFileIds : [];
    const recordedSourceFileNames = Array.isArray(invoice.receivingSourceFileNames) ? invoice.receivingSourceFileNames : [];
    const sourceWasAlreadyIncluded = normalizedSourceFiles.length > 0
      && normalizedSourceFiles.every(source => (source.id && recordedSourceFileIds.includes(source.id))
        || (source.name && recordedSourceFileNames.includes(source.name)));
    if (sourceWasAlreadyIncluded) {
      alreadyIncludedInvoices.push(invoice);
      continue;
    }

    const hasExistingReceiving = Boolean(invoice.receivingSharePointUrl || invoice.receivingPdfPath);
    if (hasExistingReceiving && !appendToExisting) continue;

    let finalBuffer = buffer;
    let mergedWithExisting = false;
    if (hasExistingReceiving) {
      if (!invoice.receivingPdfPath) {
        throw new Error(`No se puede anexar el recibimiento compartido a ${invoice.folio} porque falta su PDF local.`);
      }
      const existingBuffer = await readPdfPathFromStorage(invoice.receivingPdfPath);
      if (!existingBuffer) throw new Error(`No se puede anexar el recibimiento compartido a ${invoice.folio} porque falta su PDF.`);
      finalBuffer = await mergeReceivingPdfBuffers([existingBuffer, buffer]);
      mergedWithExisting = true;
    }

    plans.push({ invoice, finalBuffer, mergedWithExisting, recordedSourceFileIds, recordedSourceFileNames });
  }

  if (!plans.length) {
    return {
      processed: false,
      duplicate: true,
      linkedInvoices: [],
      reason: alreadyIncludedInvoices.length
        ? 'El recibimiento compartido ya fue integrado en todas las facturas coincidentes.'
        : 'El recibimiento ya está asociado a todas las facturas coincidentes.'
    };
  }

  await fs.mkdir(uploadsDir, { recursive: true });
  const linkedInvoices = [];
  const appendedInvoices = [];
  for (const plan of plans) {
    const { invoice, finalBuffer, mergedWithExisting, recordedSourceFileIds, recordedSourceFileNames } = plan;
    const sharePointFiles = await uploadInvoiceFilesToSharePoint({
      client: invoice.client,
      location: invoice.location,
      issued: invoice.issued,
      folio: invoice.folio,
      receivingFile: { buffer: finalBuffer, originalname: sourceFileName }
    });
    const receivingSharePointUrl = sharePointFiles.receiving?.webUrl || '';
    if (!receivingSharePointUrl) throw new Error(`SharePoint no devolvió la URL del recibimiento para la factura ${invoice.folio}.`);
    const receivingPdfPath = `${invoice.id}-receiving.pdf`;
    await fs.writeFile(path.join(uploadsDir, receivingPdfPath), finalBuffer);
    await syncPdfToOracle(receivingPdfPath, finalBuffer);
    Object.assign(invoice, {
      receivingFileName: mergedWithExisting ? `Merged-${invoice.folio}-receiving.pdf` : sourceFileName,
      receivingPdfPath,
      receivingSharePointUrl,
      receivingSourceFileIds: Array.from(new Set([...recordedSourceFileIds, ...sourceFileIds])),
      receivingSourceFileNames: Array.from(new Set([...recordedSourceFileNames, ...sourceFileNames]))
    });
    linkedInvoices.push(invoice);
    if (mergedWithExisting) appendedInvoices.push(invoice);
  }

  await writeDb(db);
  return { processed: true, duplicate: false, linkedInvoices, appendedInvoices };
}

async function findSharePointItem(driveId, segments) {
  let parentId = null;
  for (const segment of segments) {
    const childrenEndpoint = parentId
      ? `/drives/${driveId}/items/${parentId}/children`
      : `/drives/${driveId}/root/children`;
    const escapedName = String(segment).replace(/'/g, "''");
    const data = await graphRequest(`${childrenEndpoint}?$filter=${encodeURIComponent(`name eq '${escapedName}'`)}`);
    const item = data?.value?.find(candidate => candidate.name === segment);
    if (!item) return null;
    parentId = item.id;
  }
  return parentId ? { id: parentId } : null;
}

async function deleteSharePointFile({ client, location, issued, folio, type }) {
  if (!sharePointReady()) return;
  const { driveId } = await getSharePointDrive();
  const fileName = `${type === 'receiving' ? 'Receiving' : 'Invoice'}-${folio}.pdf`;
  const segments = [sharePoint.rootFolder, safeFolderName(sharePointClientFolderName(client))];
  if (location) segments.push(safeFolderName(location));
  segments.push(String(issued), fileName);
  const item = await findSharePointItem(driveId, segments);
  if (item?.id) await graphRequest(`/drives/${driveId}/items/${item.id}`, { method: 'DELETE' });
}

async function removeLocalFile(fileName) {
  if (!fileName) return;
  try { await fs.unlink(path.join(uploadsDir, fileName)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function invoicePdfObjectName(invoice, type) {
  const field = type === 'receiving' ? 'receivingPdfPath' : 'invoicePdfPath';
  return String(invoice?.[field] || `${invoice?.id}-${type}.pdf`).trim();
}

async function syncPdfToOracle(objectName, buffer) {
  if (!oracleStorageReady() || !objectName || !buffer) return;
  await withRetry(() => putOracleObject(objectName, buffer));
}

async function removePdfFromOracle(objectName) {
  if (!oracleStorageReady() || !objectName) return;
  await deleteOracleObject(objectName);
}

async function readPdfFromStorage(invoice, type) {
  const objectName = invoicePdfObjectName(invoice, type);
  if (oracleStorageReady()) {
    const oracleBuffer = await getOracleObject(objectName);
    if (oracleBuffer) return { buffer: oracleBuffer, objectName, source: 'oracle' };
  }
  const localPath = path.join(uploadsDir, objectName);
  try {
    return { buffer: await fs.readFile(localPath), objectName, source: 'local' };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

async function readPdfPathFromStorage(pdfPath) {
  const objectName = String(pdfPath || '').trim();
  if (!objectName) return null;
  if (oracleStorageReady()) {
    const oracleBuffer = await getOracleObject(objectName);
    if (oracleBuffer) return oracleBuffer;
  }
  try { return await fs.readFile(path.join(uploadsDir, objectName)); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensurePdf(file) {
  if (!file) return file;
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  let mime = String(file.mimetype || '').toLowerCase();
  if (extension === '.heic' || extension === '.heif' || mime === 'image/heic' || mime === 'image/heif') {
    const jpegBuffer = await convertHeicWithTimeout(file.buffer);
    file.buffer = Buffer.from(jpegBuffer);
    file.mimetype = 'image/jpeg';
    file.originalname = String(file.originalname || 'image.heic').replace(/\.(heic|heif)$/i, '.jpg');
    mime = 'image/jpeg';
  }
  if (mime === 'image/jpeg' || mime === 'image/png') {
    const pdfDoc = await PDFDocument.create();
    let image;
    if (mime === 'image/jpeg') {
      image = await pdfDoc.embedJpg(file.buffer);
    } else {
      image = await pdfDoc.embedPng(file.buffer);
    }
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    const pdfBytes = await pdfDoc.save();
    file.buffer = Buffer.from(pdfBytes);
    file.mimetype = 'application/pdf';
    file.originalname = file.originalname.replace(/\.(jpe?g|png)$/i, '.pdf');
  }
  return file;
}

function convertHeicWithTimeout(buffer, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heic-convert-worker.mjs', import.meta.url), {
      workerData: Buffer.from(buffer)
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`La conversión HEIC excedió ${Math.round(timeoutMs / 1000)} segundos.`));
    }, timeoutMs);
    worker.once('message', message => {
      if (message?.ok && message.buffer) finish(resolve, Buffer.from(message.buffer));
      else finish(reject, new Error(message?.error || 'No se pudo convertir el archivo HEIC.'));
    });
    worker.once('error', error => finish(reject, error));
    worker.once('exit', code => {
      if (code !== 0) finish(reject, new Error(`El conversor HEIC terminó con código ${code}.`));
    });
  });
}

function resolveReceivingSyncTargets(fileName, invoices, newlyProcessedInvoiceIds) {
  const allReceivingInvoices = findReceivingInvoices(fileName, invoices);
  const currentBatchInvoices = allReceivingInvoices.filter(invoice => newlyProcessedInvoiceIds.has(invoice.id));
  return {
    allReceivingInvoices,
    receivingInvoices: currentBatchInvoices.length ? currentBatchInvoices : allReceivingInvoices
  };
}

function hasInvoiceFilenameHint(fileName) {
  const name = String(fileName || '');
  return /\binvoice\b/i.test(name) && /\b(?:po|order|purchase)\b/i.test(name);
}

function receivingImageReferenceRank(invoice, fileName) {
  const invoiceReferences = extractReceivingReferences(invoice.invoiceFileName);
  const imageReferences = extractReceivingReferences(fileName);
  const ranks = imageReferences
    .map(reference => invoiceReferences.indexOf(reference))
    .filter(index => index >= 0);
  return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
}

function groupConvertedReceivingImages(pendingReceivings, invoices, newlyProcessedInvoiceIds) {
  const resolvedReceivings = pendingReceivings.map(pendingReceiving => ({
    ...pendingReceiving,
    ...resolveReceivingSyncTargets(pendingReceiving.file.name, invoices, newlyProcessedInvoiceIds)
  }));
  const candidatesByInvoiceId = new Map();

  for (const receiving of resolvedReceivings) {
    if (!receiving.convertedFromImage || receiving.receivingInvoices.length !== 1) continue;
    const [invoice] = receiving.receivingInvoices;
    const group = candidatesByInvoiceId.get(invoice.id) || [];
    group.push(receiving);
    candidatesByInvoiceId.set(invoice.id, group);
  }

  const groupedFileIds = new Set();
  const groups = [];
  for (const [invoiceId, candidates] of candidatesByInvoiceId) {
    if (candidates.length < 2) continue;
    const invoice = invoices.find(item => item.id === invoiceId);
    if (!invoice) continue;
    const orderedCandidates = [...candidates].sort((left, right) => {
      const rankDifference = receivingImageReferenceRank(invoice, left.file.name)
        - receivingImageReferenceRank(invoice, right.file.name);
      return rankDifference || left.file.name.localeCompare(right.file.name);
    });
    orderedCandidates.forEach(candidate => groupedFileIds.add(candidate.file.id));
    groups.push({ invoice, candidates: orderedCandidates });
  }

  return {
    groups,
    individualReceivings: resolvedReceivings.filter(receiving => !groupedFileIds.has(receiving.file.id))
  };
}

function addOneMonth(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
}

async function extractInvoicePdf(buffer) {
  const text = await extractInvoiceDocumentText(buffer);
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
  const dosGringosInvoice = extractDosGringosInvoice(text);
  if (dosGringosInvoice) {
    return {
      ...dosGringosInvoice,
      due: addOneMonth(dosGringosInvoice.issued),
      guideNumber: '',
      location: '',
      email: '',
      concept: 'Factura Dos Gringos importada desde PDF',
      searchText: buildInvoiceSearchText(text)
    };
  }
  // Formato anterior: Invoice Date, Invoice No., SOLD TO., PO, Number y Total.
  const oldDateMatch = text.match(/Invoice Date[\s\S]{0,180}?(20\d{2}-\d{2}-\d{2})/i);
  const oldNumberMatch = text.match(/Invoice No\.[\s\S]{0,180}?(\d{4})\s+20\d{2}-\d{2}-\d{2}/i);
  const originInvoiceMatch = text.match(/Origin Invoice No\.[\s\S]{0,120}?\b(\d{1,})\s+20\d{2}-\d{2}-\d{2}/i);
  const oldClientMatch = text.match(/SOLD TO\.?\s*[\r\n]+([^\r\n]+)/i);
  const oldPoMatch = text.match(/PO,?\s*Number\s*[\r\n]+20\d{2}-\d{2}-\d{2}\s+(\d{5,})/i);
  const standalonePoMatch = text.match(/(?:^|\r?\n)PO\s*:\s*([A-Z0-9-]+)/i);
  const inlinePoMatch = text.match(/PO,?\s*Number[\s\S]{0,80}?20\d{2}-\d{2}-\d{2}\s+([A-Z0-9-]+(?:-\s*[\r\n]+\s*[A-Z0-9-]+)?)/i);
  const splitPoMatch = text.match(/PO,?\s*Number[\s\S]{0,80}?20\d{2}-\d{2}-\d{2}\s+([A-Z0-9-]+-)\s*[\r\n]+\s*([A-Z0-9-]+)/i);
  const linePoMatch = text.match(/PO,?\s*Number[\s\S]{0,80}?20\d{2}-\d{2}-\d{2}\s+([^\r\n]+)/i);
  const oldTotalMatch = text.match(/Total\s+\$\s*([\d,]+\.\d{2})/i);
  const jasperKometTotal = extractJasperKometInvoiceTotal(text);

  // Nuevo Formato Alternativo (Trader Joe's): PO DATE, INVOICE #, ORDER #, Location ID, Invoice Total
  const tjAltDateMatch = text.match(/PO\s+DATE:\s*[\r\n]*\s*(20\d{2}-\d{2}-\d{2})/i);
  const tjAltNumberMatch = text.match(/INVOICE\s*#:\s*([A-Z0-9-]+)/i);
  const tjAltPoMatch = text.match(/ORDER\s*#:\s*([A-Z0-9-]+)/i);
  const tjAltTotalMatch = text.match(/Invoice\s+Total\s*\$\s*([\d,]+\.\d{2})/i);
  const tjAltLocationMatch = text.match(/Location\s*ID:[^\r\n]*[\r\n]+\s*([^\r\n]+)/i);
  const tjAltClient = (tjAltDateMatch && tjAltNumberMatch && text.match(/Trader Joe's/i)) ? "Trader Joe's" : '';

  // Formato Trader Joe's / Fontana: Invoice #, Order Number, Invoice Date e Invoice Total.
  const fontanaDateMatch = text.match(/PO\s+Date\s*:\s*[\r\n]+\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})/i);
  const fontanaNumberMatch = text.match(/Invoice\s*#\s*:\s*([A-Z0-9-]+)/i);
  const fontanaPoMatch = text.match(/Order\s+Number\s*:\s*([A-Z0-9-]+)/i);
  const fontanaClientMatch = text.match(/^Invoice\s*[\r\n]+\s*([^\r\n]+)\s*[\r\n]+\s*Invoice\s*#/im);
  const fontanaLocationMatch = text.match(/Location\s+ID\s*:[^\r\n]*[\r\n]+\s*([^\r\n]+)/i);
  const fontanaTotalMatch = text.match(/Invoice\s+Total\s*\$\s*([\d,]+\.\d{2})/i);
  const fontanaIssued = fontanaDateMatch
    ? `${fontanaDateMatch[3]}-${String(fontanaDateMatch[1]).padStart(2, '0')}-${String(fontanaDateMatch[2]).padStart(2, '0')}`
    : '';

  // Nuevo formato: SHIP DATE, INVOICE, Customer info, PO NUMBER y TOTAL DOLLARS.
  const newDateMatch = text.match(/SHIP DATE\s*:\s*(\d{1,2})-(\d{1,2})-(20\d{2})/i);
  let newIssued = '';
  if (newDateMatch) {
    let first = Number(newDateMatch[1]);
    let second = Number(newDateMatch[2]);
    if (first > 12) [first, second] = [second, first];
    newIssued = `${newDateMatch[3]}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`;
  }
  const newNumberMatch = text.match(/(?:^|\r?\n)INVOICE\s*:\s*([A-Z0-9-]+)/i);
  // En este formato, Customer info corresponde al proveedor; el cliente aparece debajo de INVOICE.
  const newClientMatch = text.match(/INVOICE\s*:\s*[A-Z0-9-]+\s*[\r\n]+([^\r\n]+)/i);
  const newClientAfterTotalMatch = text.match(/TOTAL DOLLARS\s*\$?\s*[\d,]+\.\d{2}\s*[\r\n]+([^\r\n]+)/i);
  const newPoMatch = text.match(/PO\s+NUM\w*\s*:\s*([A-Z0-9-]+)/i);
  const newTotalMatch = text.match(/\$\s*([\d,]+\.\d{2})\s*TOTAL DOLLARS/i);
  const totalDollarsPrefixMatch = text.match(/TOTAL DOLLARS\s*\$\s*([\d,]+\.\d{2})/i);
  const labeledTotalMatch = text.match(/([\d,]+\.\d{2})\s+TOTAL\b/i);
  // Formato Pacifica Farms: fecha MM/DD/YYYY, identificador W000246 y total bajo Totals.
  const pacificaDateMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})\s+Invoice Date/i);
  const pacificaLooseDateMatch = text.match(/^\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})\s*$/m);
  const pacificaDate = pacificaDateMatch || pacificaLooseDateMatch;
  const pacificaIssued = pacificaDate ? `${pacificaDate[3]}-${pacificaDate[1].padStart(2, '0')}-${pacificaDate[2].padStart(2, '0')}` : '';
  const pacificaInvoiceMatch = text.match(/Ship To\s*[\r\n]+([A-Z]?\d{4,})\s*[\r\n]+Bill To/i);
  const pacificaWInvoiceMatch = text.match(/\b(W\d{6,})\b/i);
  const pacificaClientMatch = text.match(/Sales Rep\s*[\r\n]+([^\r\n]+)/i);
  const pacificaClientAfterCarrierMatch = text.match(/Armellini\s*-\s*Regular[ \t]+([^\r\n]+)/i);
  const pacificaClientBeforeShipMatch = text.match(/([^\r\n]+)\s*[\r\n]+Ship To\s*[\r\n]+[A-Z]?\d{4,}\s*[\r\n]+Bill To/i);
  const pacificaPoMatch = text.match(/Bill To[\s\S]{0,80}?Net\s+\d+\s*[\r\n]+([A-Z0-9-]+)\s*[\r\n]+Terms/i);
  const pacificaTotalMatch = text.match(/Totals[\s\S]{0,80}?\$\s*([\d,]+\.\d{2})/i);
  const pacificaTopAmountMatch = text.match(/^\s*\$\s*([\d,]+\.\d{2})\s*$/m);
  // Formato Pacífica de muestras: el encabezado comparte la línea de
  // etiquetas y el folio aparece después de la fecha, antes del Order No.
  const pacificaSampleHeaderMatch = text.match(/Origin Division\s+Invoice No\.\s+Order No\.[\s\S]{0,140}?(20\d{2}-\d{2}-\d{2})\s+([A-Z0-9-]+)\s+([A-Z0-9-]+)/i);
  const pacificaSampleClientMatch = text.match(/SOLD TO\.\s*SHIP TO\.[\s\S]{0,40}?\r?\n([^\r\n]+)/i);
  const pacificaSampleTotalMatch = text.match(/\bTotal\s+\$\s*([\d,]+\.\d{2})/i);
  const pacificaClient = pacificaClientAfterCarrierMatch?.[1]
    || pacificaClientMatch?.[1]
    || (pacificaClientBeforeShipMatch?.[1] && !/^\s*[\d(]/.test(pacificaClientBeforeShipMatch[1])
      ? pacificaClientBeforeShipMatch[1]
      : '');

  // Este formato debe usar PO Date antes de cualquier detector genérico de fechas.
  const issued = tjAltDateMatch?.[1] || fontanaIssued || oldDateMatch?.[1] || newIssued || pacificaIssued || pacificaSampleHeaderMatch?.[1];
  const folio = tjAltNumberMatch?.[1] || oldNumberMatch?.[1] || newNumberMatch?.[1] || pacificaInvoiceMatch?.[1] || originInvoiceMatch?.[1] || pacificaWInvoiceMatch?.[1] || fontanaNumberMatch?.[1] || pacificaSampleHeaderMatch?.[2] || '';
  const rawClient = tjAltClient || oldClientMatch?.[1] || newClientAfterTotalMatch?.[1] || newClientMatch?.[1] || pacificaClient || fontanaClientMatch?.[1] || pacificaSampleClientMatch?.[1] || '';
  const totalValue = jasperKometTotal || tjAltTotalMatch?.[1] || oldTotalMatch?.[1] || newTotalMatch?.[1] || totalDollarsPrefixMatch?.[1] || pacificaTotalMatch?.[1] || pacificaTopAmountMatch?.[1] || labeledTotalMatch?.[1] || fontanaTotalMatch?.[1] || pacificaSampleTotalMatch?.[1] || '';
  const poCandidates = [
    tjAltPoMatch?.[1],
    standalonePoMatch?.[1],
    splitPoMatch ? `${splitPoMatch[1]}${splitPoMatch[2]}` : '',
    oldPoMatch?.[1],
    newPoMatch?.[1],
    pacificaPoMatch?.[1],
    pacificaSampleHeaderMatch?.[3],
    fontanaPoMatch?.[1],
    inlinePoMatch?.[1],
    linePoMatch?.[1]?.trim()
  ];
  const isUsablePo = (value) => {
    const candidate = String(value || '').trim();
    return candidate && !/\s/.test(candidate) && !/^(?:item|description|unit|price|total|value|number)$/i.test(candidate) && !/^20\d{2}-\d{2}-\d{2}$/.test(candidate);
  };
  const detectedPo = poCandidates.find(isUsablePo)?.trim() || '';
  const poNumber = detectedPo || folio;
  if (!issued || !folio || !rawClient || !totalValue) {
    throw new Error('No se pudieron detectar todos los datos principales de la factura.');
  }
  const client = rawClient.replace(/\s+\d{3,}\s+.*$/, '').trim();
  const location = (tjAltLocationMatch?.[1] || fontanaLocationMatch?.[1] || '')
    .replace(/\s+XDOCK\b.*$/i, '')
    .trim();
  return {
    folio,
    client,
    issued,
    due: addOneMonth(issued),
    amount: Number(totalValue.replace(/,/g, '')),
    poNumber,
    guideNumber: isGalleriaClient(rawClient) ? extractOrderNumber(text) : '',
    location,
    concept: 'Invoice importado desde PDF',
    searchText: buildInvoiceSearchText(text)
  };
}

function syncFileMimeType(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.heic' || extension === '.heif') return 'image/heic';
  return 'application/pdf';
}

function isSyncDocument(fileName) {
  return ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'].includes(path.extname(String(fileName || '')).toLowerCase());
}

function normalizeCreditDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})$/);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  const legacy = raw.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
  return legacy ? legacy[3] + '-' + legacy[1] + '-' + legacy[2] : '';
}

const historicalCreditDateOverrides = Object.freeze({
  '37284': '2026-08-11',
  '37276': '2026-07-23',
  '37273': '2026-07-14',
  '37272': '2026-07-09',
  '37275': '2026-07-17',
  '37268': '2026-07-04',
  '37282': '2026-08-05'
});

function extractOrderNumber(text) {
  const directMatch = text.match(/Order\s*(?:No\.?|Number|#)\s*[:\r\n \t]+([A-Z0-9-]+)/i);
  const directValue = directMatch?.[1]?.trim() || '';
  if (directValue && !/^(?:origin|invoice|no|date|division)$/i.test(directValue)) return directValue;
  const nearbyMatch = text.match(/Order\s*(?:No\.?|Number|#)[\s\S]{0,160}?\b([A-Z0-9]+(?:-[A-Z0-9]+)+)\b/i);
  return nearbyMatch?.[1]?.trim() || '';
}

async function extractCreditPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  const text = (await parser.getText()).text.replace(/\u00a0/g, ' ');
  await parser.destroy();
  
  const poMatch = text.match(/(?:^|\r?\n)P\.?O\.?\s*(?:#|:)?\s*([A-Z0-9-]+)/i);
  const creditMatch = text.match(/(?:^|\r?\n)CREDIT\s*:\s*([A-Z0-9-]+)/i);
  const customerMatch = text.match(/Customer\s*:\s*([^\r\n]+)/i);
  const customer = customerMatch?.[1]?.trim() || '';
  const guideNumber = isGalleriaClient(customer) || /Galleria\s+Farms/i.test(text) ? extractOrderNumber(text) : '';
  const creditDateMatch = text.match(/SHIP\s*DATE\s*:\s*(\d{4}[-\/]\d{2}[-\/]\d{2}|\d{2}[-\/]\d{2}[-\/]\d{4})/i);
  const totalMatch = text.match(/(?:^|\r?\n| )TOTAL\s*\$?\s*([\d,]+\.\d{2})/i) || 
                     text.match(/Total\s*\$?\s*([\d,]+\.\d{2})/i) ||
                     text.match(/\$?\s*([\d,]+\.\d{2})\s+TOTAL/i);
  
  const poNumber = poMatch?.[1]?.trim() || '';
  const creditNumber = creditMatch?.[1]?.trim() || '';
  const amountStr = totalMatch?.[1] || '0';
  const amount = Number(amountStr.replace(/,/g, ''));
  const creditDate = normalizeCreditDate(creditDateMatch?.[1]);
  
  if (amount <= 0) {
    console.log(`[DEBUG-PDF] Extracted text for PO ${poNumber}:\n${text}\n-------------------`);
  }

  return { poNumber, guideNumber, creditNumber, client: customer, amount, creditDate };
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
  if (!token) return res.status(401).json({ message: 'Sesión requerida.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ message: 'La sesión expiró. Ingresa nuevamente.' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Acceso exclusivo para administradores.' });
  next();
}

const portalPermissions = new Set(['dashboard', 'invoices', 'checks', 'support', 'credits', 'reconciliation', 'accountStatement', 'settings', 'users', 'preferences']);
function sanitizePermissions(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(item => portalPermissions.has(item)))] : [];
}

function publicUserProfile(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    loginSource: user.loginSource || undefined,
    email: user.email || undefined,
    clientKey: user.clientKey || undefined,
    assignedClients: Array.isArray(user.assignedClients) ? user.assignedClients : [],
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    firstName: user.firstName || undefined,
    lastName: user.lastName || undefined,
    phone: user.phone || undefined
  };
}

function issueUserSession(user) {
  const profile = publicUserProfile(user);
  return { token: jwt.sign(profile, JWT_SECRET, { expiresIn: '8h' }), user: profile };
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username) return res.status(400).json({ message: 'Ingresa tu correo.' });
    const db = await readDb();
    const resolved = resolveEmailLogin(db, username, normalizeClientKey);
    if (resolved.kind === 'history') return res.json(issueUserSession(resolved.user));
    if (resolved.kind === 'denied') return res.status(401).json({ message: 'No hay acceso habilitado para este correo.' });
    const user = resolved.user;
    if (!password && user.active !== false) return res.json({ requiresPassword: true });
    if (!user || user.active === false || !(await bcrypt.compare(String(password), user.passwordHash))) return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
    res.json(issueUserSession(user));
  } catch (error) { next(error); }
});

app.get('/api/account', authenticate, async (req, res, next) => {
  try {
    if (req.user.loginSource === 'email-history') return res.json(publicUserProfile(req.user));
    const db = await readDb();
    const user = db.users.find(item => String(item.id) === String(req.user.id));
    if (!user) return res.status(404).json({ message: 'No se encontró la cuenta.' });
    res.json(publicUserProfile(user));
  } catch (error) { next(error); }
});

app.patch('/api/account/profile', authenticate, async (req, res, next) => {
  try {
    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!firstName || !email) return res.status(400).json({ message: 'Nombre y correo son obligatorios.' });

    const db = await readDb();
    const user = db.users.find(item => String(item.id) === String(req.user.id));
    if (!user) return res.status(404).json({ message: 'No se encontró la cuenta.' });
    if (db.users.some(item => item.id !== user.id && item.email?.toLowerCase() === email)) return res.status(409).json({ message: 'Ese correo ya está registrado.' });

    user.firstName = firstName;
    user.lastName = lastName;
    user.name = [firstName, lastName].filter(Boolean).join(' ');
    user.phone = phone;
    user.email = email;
    await writeDb(db);
    res.json({ message: 'Información de cuenta actualizada.', ...issueUserSession(user) });
  } catch (error) { next(error); }
});

app.patch('/api/account/password', authenticate, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ message: 'Completa todos los campos de contraseña.' });
    if (newPassword.length < 8) return res.status(400).json({ message: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ message: 'Las contraseñas no coinciden.' });

    const db = await readDb();
    const user = db.users.find(item => String(item.id) === String(req.user.id));
    if (!user) return res.status(404).json({ message: 'No se encontró la cuenta.' });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) return res.status(400).json({ message: 'La contraseña actual no es correcta.' });

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    await writeDb(db);
    res.json({ message: 'Contraseña actualizada correctamente.' });
  } catch (error) { next(error); }
});

app.post('/api/support/tickets', authenticate, async (req, res, next) => {
  try {
    const category = String(req.body?.category || '').trim();
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!subject || !message) return res.status(400).json({ message: 'Asunto y descripción son obligatorios.' });
    if (subject.length > 120 || message.length > 2000) return res.status(400).json({ message: 'La solicitud excede la longitud permitida.' });

    const db = await readDb();
    const nextId = db.supportTickets.reduce((max, ticket) => Math.max(max, Number(ticket.id) || 0), 0) + 1;
    const ticket = {
      id: nextId,
      number: `SUP-${new Date().getFullYear()}-${String(nextId).padStart(5, '0')}`,
      category: category || 'Other',
      subject,
      message,
      userId: req.user.id,
      userName: req.user.name,
      email: req.user.email || '',
      role: req.user.role,
      clientKey: req.user.clientKey || '',
      status: 'open',
      createdAt: new Date().toISOString(),
      replies: []
    };
    db.supportTickets.push(ticket);
    await writeDb(db);
    res.status(201).json({ message: 'Solicitud registrada.', ticket: { number: ticket.number } });
  } catch (error) { next(error); }
});

app.get('/api/support/tickets', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const db = await readDb();
    res.json([...db.supportTickets].map(ticket => ({ ...ticket, replies: Array.isArray(ticket.replies) ? ticket.replies : [] })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  } catch (error) { next(error); }
});

app.get('/api/support/tickets/mine', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const tickets = db.supportTickets
      .filter(ticket => String(ticket.userId) === String(req.user.id))
      .map(ticket => ({ ...ticket, replies: Array.isArray(ticket.replies) ? ticket.replies : [] }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(tickets);
  } catch (error) { next(error); }
});

app.patch('/api/support/tickets/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const allowedStatuses = new Set(['open', 'in_progress', 'resolved']);
    const status = String(req.body?.status || '').trim();
    if (!allowedStatuses.has(status)) return res.status(400).json({ message: 'Estado de ticket no válido.' });
    const ticketId = Number(req.params.id);
    const db = await readDb();
    const ticket = db.supportTickets.find(item => Number(item.id) === ticketId);
    if (!ticket) return res.status(404).json({ message: 'No se encontró el ticket.' });
    ticket.status = status;
    ticket.updatedAt = new Date().toISOString();
    await writeDb(db);
    res.json({ message: 'Estado actualizado.', ticket: { ...ticket, replies: Array.isArray(ticket.replies) ? ticket.replies : [] } });
  } catch (error) { next(error); }
});

app.delete('/api/support/tickets/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const ticketId = Number(req.params.id);
    const db = await readDb();
    const ticketIndex = db.supportTickets.findIndex(item => Number(item.id) === ticketId);
    if (ticketIndex === -1) return res.status(404).json({ message: 'No se encontró el ticket.' });
    db.supportTickets.splice(ticketIndex, 1);
    db.notifications = db.notifications.filter(notification => Number(notification.ticketId) !== ticketId);
    await writeDb(db);
    res.json({ message: 'Ticket eliminado.' });
  } catch (error) { next(error); }
});

app.post('/api/support/tickets/:id/replies', authenticate, adminOnly, async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ message: 'La respuesta es obligatoria.' });
    if (message.length > 2000) return res.status(400).json({ message: 'La respuesta excede la longitud permitida.' });
    const ticketId = Number(req.params.id);
    const db = await readDb();
    const ticket = db.supportTickets.find(item => Number(item.id) === ticketId);
    if (!ticket) return res.status(404).json({ message: 'No se encontró el ticket.' });
    if (!Array.isArray(ticket.replies)) ticket.replies = [];
    const replyId = ticket.replies.reduce((max, reply) => Math.max(max, Number(reply.id) || 0), 0) + 1;
    const reply = { id: replyId, authorId: req.user.id, authorName: req.user.name, authorRole: req.user.role, message, createdAt: new Date().toISOString() };
    ticket.replies.push(reply);
    ticket.status = 'in_progress';
    ticket.updatedAt = reply.createdAt;
    const notificationId = db.notifications.reduce((max, notification) => Math.max(max, Number(notification.id) || 0), 0) + 1;
    db.notifications.push({ id: notificationId, userId: ticket.userId, type: 'support_reply', title: 'Nueva respuesta de atención al cliente', message: `Respondimos a ${ticket.number}.`, ticketId: ticket.id, ticketNumber: ticket.number, read: false, createdAt: reply.createdAt });
    await writeDb(db);
    res.json({ message: 'Respuesta enviada.', ticket });
  } catch (error) { next(error); }
});

app.get('/api/notifications', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    res.json(db.notifications.filter(notification => String(notification.userId) === String(req.user.id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  } catch (error) { next(error); }
});

app.patch('/api/notifications/:id/read', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const notification = db.notifications.find(item => Number(item.id) === Number(req.params.id) && String(item.userId) === String(req.user.id));
    if (!notification) return res.status(404).json({ message: 'No se encontró la notificación.' });
    notification.read = true;
    await writeDb(db);
    res.json({ message: 'Notificación marcada como leída.' });
  } catch (error) { next(error); }
});

app.delete('/api/notifications/:id', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const notificationIndex = db.notifications.findIndex(item => Number(item.id) === Number(req.params.id) && String(item.userId) === String(req.user.id));
    if (notificationIndex === -1) return res.status(404).json({ message: 'No se encontró la notificación.' });
    db.notifications.splice(notificationIndex, 1);
    await writeDb(db);
    res.json({ message: 'Notificación eliminada.' });
  } catch (error) { next(error); }
});

app.get('/api/invoices', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const assignedKeys = Array.isArray(req.user.assignedClients) ? req.user.assignedClients.map(normalizeClientKey).filter(Boolean) : [];
    const invoices = req.user.role === 'admin' && assignedKeys.length === 0 ? db.invoices : db.invoices.filter(item => {
      const invoiceKey = item.clientKey || normalizeClientKey(item.client);
      if (assignedKeys.length > 0) return assignedKeys.includes(invoiceKey);
      return invoiceKey === req.user.clientKey || item.email?.toLowerCase() === req.user.email?.toLowerCase();
    });
    const walmexAllowed = req.user.role === 'admin' || assignedKeys.includes('walmex') || req.user.clientKey === 'walmex';
    const walmex = walmexAllowed ? await loadWalmexInvoices(process.env.WALMEX_DATABASE_URL, db.checks || []) : [];
    const checksByInvoice = new Map();
    for (const check of db.checks || []) {
      for (const allocation of check.allocations || []) {
        const key = String(allocation.invoiceId);
        const list = checksByInvoice.get(key) || [];
        list.push({ date: String(check.date || '').slice(0, 10), amount: Number(allocation.amount || 0) });
        checksByInvoice.set(key, list);
      }
    }
    const withCheckHistory = item => ({ ...item, checkApplications: checksByInvoice.get(String(item.id)) || [] });
    res.json([...invoices, ...walmex].map(withCheckHistory).sort((a, b) => String(b.issued || b.id || '').localeCompare(String(a.issued || a.id || ''))));
  } catch (error) { next(error); }
});

// El frontend conserva esta ruta para cargar Walmex después de la página de
// facturas internas.  También debe incluir los cheques guardados en el portal.
app.get('/api/walmex/invoices', authenticate, async (req, res, next) => {
  try {
    const assignedKeys = Array.isArray(req.user.assignedClients) ? req.user.assignedClients.map(normalizeClientKey).filter(Boolean) : [];
    const allowed = req.user.role === 'admin' || assignedKeys.includes('walmex') || req.user.clientKey === 'walmex';
    if (!allowed) return res.status(403).json({ message: 'No tienes acceso a Walmex.' });
    const db = await readDb();
    const invoices = await loadWalmexInvoices(process.env.WALMEX_DATABASE_URL, db.checks || []);
    res.json({ invoices, stale: false });
  } catch (error) { next(error); }
});

app.get('/api/walmex/document', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.clientKey !== 'walmex' && !(req.user.assignedClients || []).map(normalizeClientKey).includes('walmex')) {
      return res.status(403).json({ message: 'No tienes acceso a los documentos de Walmex.' });
    }
    const relative = walmexRelativePath(req.query.url);
    if (!relative) return res.status(400).json({ message: 'La referencia del documento Walmex no es válida.' });
    const driveId = await getWalmexDrive();
    const encodedPath = relative.split('/').map(encodeURIComponent).join('/');
    const token = await graphAccessToken();
    const response = await fetchWithTimeout(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}:/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow'
    });
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ message: `No fue posible obtener el documento Walmex (HTTP ${response.status}).` });
    const filename = path.basename(relative);
    const contentType = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'application/octet-stream';
    res.status(200).set({
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store'
    });
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) { next(error); }
});

app.get('/api/checks', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const db = await readDb();
    res.json((db.checks || []).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id));
  } catch (error) { next(error); }
});

app.post('/api/checks', authenticate, adminOnly, async (req, res, next) => {
  try {
    const date = String(req.body?.date || '').trim();
    const series = String(req.body?.series || '').trim();
    const client = String(req.body?.client || '').trim();
    const total = Number(req.body?.total);
    const invoiceIds = Array.from(new Set((Array.isArray(req.body?.invoiceIds) ? req.body.invoiceIds : []).map(normalizeInvoiceId).filter(id => id !== null)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'La fecha del cheque no es válida.' });
    if (!series) return res.status(400).json({ message: 'Captura la serie o número del cheque.' });
    if (!client) return res.status(400).json({ message: 'Selecciona un cliente.' });
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ message: 'El total del cheque debe ser mayor que cero.' });
    if (!invoiceIds.length) return res.status(400).json({ message: 'Selecciona al menos una factura.' });

    const db = await readDb();
    const clientKey = normalizeClientKey(client);
    const duplicateCheck = (db.checks || []).find(check => normalizeClientKey(check.client) === clientKey && normalizeReference(check.series) === normalizeReference(series));
    if (duplicateCheck) return res.status(409).json({ message: `El cheque ${series} ya está registrado para este cliente.` });

    const needsWalmex = normalizeClientKey(client) === 'walmex' || invoiceIds.some(id => String(id).toLowerCase().startsWith('walmex-'));
    const walmex = needsWalmex ? await loadWalmexInvoices(process.env.WALMEX_DATABASE_URL, db.checks || []) : [];
    const allInvoices = [...db.invoices, ...walmex];
    const selectedInvoices = invoiceIds.map(id => allInvoices.find(invoice => invoiceIdMatches(invoice.id, id)));
    if (selectedInvoices.some(invoice => !invoice)) return res.status(400).json({ message: 'Una de las facturas seleccionadas ya no existe.' });
    if (selectedInvoices.some(invoice => !checkCustomersMatch(invoice.client, client))) return res.status(400).json({ message: 'Todas las facturas deben pertenecer al cliente seleccionado.' });

    const orderedInvoices = [...selectedInvoices].sort((a, b) => String(a.due || a.issued || '').localeCompare(String(b.due || b.issued || '')));
    const available = orderedInvoices.reduce((sum, invoice) => sum + checkInvoiceBalance(invoice), 0);
    if (total > available + 0.01) return res.status(400).json({ message: `El cheque excede el saldo disponible de las facturas seleccionadas (${available.toFixed(2)}).` });

    // Reparto manual opcional: [{ invoiceId, amount }]. Si no llega, se reparte automático (más antigua primero).
    const rawAllocations = Array.isArray(req.body?.allocations)
      ? req.body.allocations.map(a => ({ invoiceId: normalizeInvoiceId(a?.invoiceId), amount: Number(a?.amount) })).filter(a => a.invoiceId !== null && Number.isFinite(a.amount) && a.amount > 0)
      : [];

    const allocations = [];
    if (rawAllocations.length) {
      const invoiceIdSet = new Set(invoiceIds);
      if (rawAllocations.some(a => !invoiceIdSet.has(a.invoiceId))) return res.status(400).json({ message: 'El reparto incluye una factura que no está seleccionada.' });
      const sumAllocated = rawAllocations.reduce((sum, a) => sum + a.amount, 0);
      if (Math.abs(sumAllocated - total) > 0.01) return res.status(400).json({ message: 'El reparto por factura no coincide con el total del cheque.' });
      for (const alloc of rawAllocations) {
        const invoice = selectedInvoices.find(inv => invoiceIdMatches(inv.id, alloc.invoiceId));
        const balance = checkInvoiceBalance(invoice);
        if (alloc.amount > balance + 0.01) return res.status(400).json({ message: `El monto asignado a la factura ${invoice.folio} excede su saldo disponible (${balance.toFixed(2)}).` });
        const amount = Number(alloc.amount.toFixed(2));
        invoice.balance = Math.max(0, balance - amount);
        invoice.checkAmount = Number(invoice.checkAmount || 0) + amount;
        if (invoice.balance <= 0.01) { invoice.balance = 0; invoice.status = 'Pagada'; }
        allocations.push({ invoiceId: invoice.id, folio: invoice.folio, amount });
      }
    } else {
      let remaining = total;
      for (const invoice of orderedInvoices) {
        const amount = Math.min(remaining, checkInvoiceBalance(invoice));
        if (amount <= 0) continue;
        invoice.balance = Math.max(0, checkInvoiceBalance(invoice) - amount);
        invoice.checkAmount = Number(invoice.checkAmount || 0) + amount;
        if (invoice.balance <= 0.01) { invoice.balance = 0; invoice.status = 'Pagada'; }
        allocations.push({ invoiceId: invoice.id, folio: invoice.folio, amount: Number(amount.toFixed(2)) });
        remaining = Number((remaining - amount).toFixed(2));
        if (remaining <= 0) break;
      }
    }

    const check = {
      id: Date.now(),
      date,
      series,
      client,
      clientKey,
      total: Number(total.toFixed(2)),
      allocations,
      createdAt: new Date().toISOString()
    };
    db.checks.push(check);
    // Las facturas Walmex son de solo lectura; solo se persisten los cambios
    // de facturas internas y el cheque. Walmex se recalcula desde el historial.
    await writeDb(db);
    res.status(201).json({ message: `Cheque ${series} registrado correctamente.`, check });
  } catch (error) { next(error); }
});

// Revierte las asignaciones de un cheque, devolviendo el saldo a las facturas.
function reverseCheckAllocations(invoices, check) {
  for (const alloc of check.allocations || []) {
    const invoice = invoices.find(inv => invoiceIdMatches(inv.id, alloc.invoiceId));
    if (!invoice) continue;
    const amount = Number(alloc.amount) || 0;
    if (amount <= 0) continue;
    invoice.checkAmount = Math.max(0, Number(invoice.checkAmount || 0) - amount);
    const currentBalance = checkInvoiceBalance(invoice);
    invoice.balance = Number((currentBalance + amount).toFixed(2));
    if (invoice.balance > 0.01 && invoice.status === 'Pagada') invoice.status = 'Pendiente';
  }
}

// Aplica un conjunto de asignaciones al saldo de las facturas.
function applyCheckAllocations(invoices, allocations) {
  const applied = [];
  for (const alloc of allocations) {
    const invoice = invoices.find(inv => invoiceIdMatches(inv.id, alloc.invoiceId));
    if (!invoice) continue;
    const amount = Number(alloc.amount) || 0;
    if (amount <= 0) continue;
    const currentBalance = checkInvoiceBalance(invoice);
    invoice.balance = Math.max(0, Number((currentBalance - amount).toFixed(2)));
    invoice.checkAmount = Number((Number(invoice.checkAmount || 0) + amount).toFixed(2));
    if (invoice.balance <= 0.01) { invoice.balance = 0; invoice.status = 'Pagada'; }
    applied.push({ invoiceId: invoice.id, folio: invoice.folio, amount: Number(amount.toFixed(2)) });
  }
  return applied;
}

// Eliminar un cheque y devolver el saldo aplicado a las facturas.
app.delete('/api/checks/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const db = await readDb();
    const index = (db.checks || []).findIndex(check => check.id === id);
    if (index === -1) return res.status(404).json({ message: 'El cheque no existe.' });
    const [check] = db.checks.splice(index, 1);
    const needsWalmex = (check.allocations || []).some(allocation => String(allocation.invoiceId || '').toLowerCase().startsWith('walmex-'));
    const walmex = needsWalmex ? await loadWalmexInvoices(process.env.WALMEX_DATABASE_URL, db.checks || []) : [];
    reverseCheckAllocations([...db.invoices, ...walmex], check);
    await writeDb(db);
    res.json({ message: `Cheque ${check.series} eliminado y saldo restaurado.` });
  } catch (error) { next(error); }
});

// Editar un cheque: revierte el saldo anterior y aplica los nuevos montos.
app.patch('/api/checks/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const db = await readDb();
    const check = (db.checks || []).find(c => c.id === id);
    if (!check) return res.status(404).json({ message: 'El cheque no existe.' });

    const date = req.body?.date !== undefined ? String(req.body.date || '').trim() : check.date;
    const series = req.body?.series !== undefined ? String(req.body.series || '').trim() : check.series;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'La fecha del cheque no es válida.' });
    if (!series) return res.status(400).json({ message: 'Captura la serie o número del cheque.' });

    // Asignaciones editadas: [{ invoiceId, amount }]
    const rawAllocations = Array.isArray(req.body?.allocations) ? req.body.allocations : check.allocations;
    const newAllocations = rawAllocations
      .map(a => ({ invoiceId: normalizeInvoiceId(a.invoiceId), amount: Number(a.amount) }))
      .filter(a => a.invoiceId !== null && Number.isFinite(a.amount) && a.amount > 0);

    // Revertir el estado actual del cheque antes de validar y reaplicar.
    const needsWalmex = (check.allocations || []).some(allocation => String(allocation.invoiceId || '').toLowerCase().startsWith('walmex-'))
      || newAllocations.some(allocation => String(allocation.invoiceId || '').toLowerCase().startsWith('walmex-'));
    const walmex = needsWalmex ? await loadWalmexInvoices(process.env.WALMEX_DATABASE_URL, db.checks || []) : [];
    const allInvoices = [...db.invoices, ...walmex];
    reverseCheckAllocations(allInvoices, check);

    // Validar que cada monto no exceda el saldo restaurado de su factura.
    for (const alloc of newAllocations) {
      const invoice = allInvoices.find(inv => invoiceIdMatches(inv.id, alloc.invoiceId));
      if (!invoice) { applyCheckAllocations(allInvoices, check.allocations); return res.status(400).json({ message: 'Una de las facturas ya no existe.' }); }
      const available = checkInvoiceBalance(invoice);
      if (alloc.amount > available + 0.01) {
        // revertir la reversión (reaplicar lo original) para no dejar inconsistencia
        applyCheckAllocations(allInvoices, check.allocations);
        return res.status(400).json({ message: `El monto de la factura ${invoice.folio} excede su saldo disponible (${available.toFixed(2)}).` });
      }
    }

    const applied = applyCheckAllocations(allInvoices, newAllocations);
    check.date = date;
    check.series = series;
    check.total = Number(applied.reduce((sum, a) => sum + a.amount, 0).toFixed(2));
    check.allocations = applied;
    await writeDb(db);
    res.json({ message: `Cheque ${series} actualizado correctamente.`, check });
  } catch (error) { next(error); }
});

app.post('/api/reconciliation/upload', authenticate, adminOnly, upload.single('excel'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Por favor selecciona un archivo de Excel.' });
    await fs.writeFile(reconciliationWorkbook, req.file.buffer);
    res.json({ message: 'Archivo cargado correctamente.' });
  } catch (error) { next(error); }
});

app.post('/api/reconciliation/credits/upload', authenticate, adminOnly, upload.single('excel'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Por favor selecciona un archivo de Excel de créditos.' });
    await fs.writeFile(creditReconciliationWorkbook, req.file.buffer);
    res.json({ message: 'Excel de créditos cargado correctamente.' });
  } catch (error) { next(error); }
});

app.get('/api/reconciliation/credits', authenticate, adminOnly, async (_req, res, next) => {
  try {
    try { await fs.access(creditReconciliationWorkbook); } catch {
      return res.json({ rows: [], source: 'No hay Excel de créditos cargado', totals: { excel: 0, system: 0, both: 0, missing: 0, different: 0 } });
    }
    const db = await readDb();
    const workbook = XLSX.readFile(creditReconciliationWorkbook, { cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const sourceRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const parseAmount = value => {
      const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const excelEntries = sourceRows.map(row => ({
      po: String(row.Serie ?? row['Serie / PO'] ?? row.PO ?? '').trim(),
      folio: String(row.Folio ?? '').trim(),
      date: normalizeExcelDate(row.Fecha),
      client: String(row['Razón Social'] ?? row['Razon Social'] ?? '').trim(),
      amount: parseAmount(row.Total),
      agent: String(row['Nombre del agente'] ?? row['Nombre del agente '] ?? '').trim()
    })).filter(row => normalizeReference(row.po));
    const systemEntries = [];
    for (const invoice of db.invoices) {
      for (const credit of Array.isArray(invoice.credits) ? invoice.credits : []) {
        if (!normalizeReference(invoice.poNumber)) continue;
        systemEntries.push({
          po: String(invoice.poNumber || '').trim(), folio: String(invoice.folio || '').trim(),
          date: String(credit.date || credit.dateProcessed || '').slice(0, 10), client: invoice.client,
          amount: parseAmount(credit.amount), creditNumber: String(credit.creditNumber || '').trim()
        });
      }
    }
    const groups = [];
    const poGroups = new Map();
    const parent = [];
    const clientKey = value => normalizeClientKey(value);
    const ignoredCustomerTokens = new Set(['inc', 'llc', 'co', 'company', 'the']);
    const customerTokens = value => {
      const tokens = [];
      clientKey(value).split('-').forEach(token => {
        if (token === 's' && tokens.length > 0) {
          // normalizeClientKey separates possessives such as "Oberer's".
          tokens[tokens.length - 1] = `${tokens[tokens.length - 1]}s`;
          return;
        }
        if (token.length > 1 && !ignoredCustomerTokens.has(token)) tokens.push(token);
      });
      return tokens;
    };
    const customerAcronym = value => customerTokens(value).map(token => token[0]).join('');
    const customersMatch = (left, right) => {
      const leftKey = clientKey(left);
      const rightKey = clientKey(right);
      if (!leftKey || !rightKey) return false;
      if (leftKey === rightKey) return true;
      const leftTokens = new Set(customerTokens(left));
      const rightTokens = new Set(customerTokens(right));
      const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
      const smaller = Math.min(leftTokens.size, rightTokens.size);
      if (shared >= 2 && smaller > 0 && shared / smaller >= 0.6) return true;

      // Some customers appear once by legal name and elsewhere by an acronym,
      // for example "Washington Floral Service" and "WFS - Spokane".
      const leftAcronym = customerAcronym(left);
      const rightAcronym = customerAcronym(right);
      if (leftAcronym.length >= 3 && rightAcronym.length >= 3
        && (leftAcronym.includes(rightAcronym) || rightAcronym.includes(leftAcronym))) return true;

      // A short customer token can itself be an acronym, e.g. WFS for
      // Washington Floral Service. Compare it with the initials sequence of
      // the other customer's significant words.
      const acronymTokenMatches = (shortTokens, longTokens) => {
        const initials = [...longTokens].map(token => token[0]).join('');
        return [...shortTokens].some(token => token.length >= 3 && initials.includes(token));
      };
      return acronymTokenMatches(leftTokens, rightTokens) || acronymTokenMatches(rightTokens, leftTokens);
    };
    const createGroup = () => { const id = groups.length; groups.push({ excel: [], system: [] }); parent[id] = id; return id; };
    const find = id => { while (parent[id] !== id) { parent[id] = parent[parent[id]]; id = parent[id]; } return id; };
    const union = (left, right) => { const leftRoot = find(left); const rightRoot = find(right); if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot; };
    const add = (side, entry) => {
      const poKey = normalizeReference(entry.po);
      const customerKey = clientKey(entry.client);
      const poCustomerKey = poKey ? `${poKey}|${customerKey}` : '';
      let groupId = poCustomerKey ? poGroups.get(poCustomerKey) : undefined;
      if (groupId === undefined) { groupId = createGroup(); if (poCustomerKey) poGroups.set(poCustomerKey, groupId); }
      groups[groupId][side].push(entry);
    };
    excelEntries.forEach(entry => add('excel', entry));
    systemEntries.forEach(entry => add('system', entry));

    // Keep PO as the primary key, but allow harmless naming differences for the same customer.
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const leftEntries = [...groups[left].excel, ...groups[left].system];
        const rightEntries = [...groups[right].excel, ...groups[right].system];
        const samePo = leftEntries.some(first => rightEntries.some(second => normalizeReference(first.po) && normalizeReference(first.po) === normalizeReference(second.po)));
        const sameCustomer = leftEntries.some(first => rightEntries.some(second => customersMatch(first.client, second.client)));
        if (samePo && sameCustomer) union(left, right);
      }
    }

    // A credit number is a second, stronger identity when the PO was captured differently.
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const leftEntries = [...groups[left].excel, ...groups[left].system];
        const rightEntries = [...groups[right].excel, ...groups[right].system];
        const sameCredit = leftEntries.some(first => rightEntries.some(second => {
          const firstCredit = normalizeReference(first.creditNumber || first.folio);
          const secondCredit = normalizeReference(second.creditNumber || second.folio);
          return firstCredit && firstCredit === secondCredit;
        }));
        const sameCustomer = leftEntries.some(first => rightEntries.some(second => customersMatch(first.client, second.client)));
        if (sameCredit && sameCustomer) union(left, right);
      }
    }

    const mergedGroups = new Map();
    groups.forEach((group, groupId) => {
      const root = find(groupId);
      const merged = mergedGroups.get(root) || { excel: [], system: [] };
      merged.excel.push(...group.excel);
      merged.system.push(...group.system);
      mergedGroups.set(root, merged);
    });

    const rows = [...mergedGroups.values()].map(group => {
      const excelAmount = group.excel.reduce((sum, row) => sum + row.amount, 0);
      const systemAmount = group.system.reduce((sum, row) => sum + row.amount, 0);
      const hasExcel = group.excel.length > 0;
      const hasSystem = group.system.length > 0;
      const duplicate = group.excel.length > 1 || group.system.length > 1;
      const validation = duplicate ? 'duplicate' : !hasExcel || !hasSystem ? 'missing' : Math.abs(excelAmount - systemAmount) < 0.01 ? 'valid' : 'amount-different';
      return {
        po: [...new Set([...group.excel.map(row => row.po), ...group.system.map(row => row.po)].filter(Boolean))].join(', '),
        folios: [...new Set([...group.system.map(row => row.creditNumber), ...group.excel.map(row => row.folio)].filter(Boolean))].join(', '),
        client: group.system[0]?.client || group.excel[0]?.client || '',
        date: group.excel[0]?.date || group.system[0]?.date || '',
        systemCredits: [...new Set(group.system.map(row => row.creditNumber).filter(Boolean))].join(', '),
        systemAmount: hasSystem ? Number(systemAmount.toFixed(2)) : null,
        excelAmount: hasExcel ? Number(excelAmount.toFixed(2)) : null,
        difference: hasExcel && hasSystem ? Number((systemAmount - excelAmount).toFixed(2)) : null,
        agent: group.excel[0]?.agent || '',
        systemCount: group.system.length,
        excelCount: group.excel.length,
        sourceStatus: hasExcel && hasSystem ? 'both' : hasSystem ? 'system' : 'excel',
        validation
      };
    }).sort((a, b) => a.po.localeCompare(b.po, undefined, { numeric: true }));
    res.json({ source: path.basename(creditReconciliationWorkbook), rows, totals: {
      excel: excelEntries.length, system: systemEntries.length, both: rows.filter(row => row.sourceStatus === 'both').length,
      missing: rows.filter(row => row.validation === 'missing').length, different: rows.filter(row => row.validation === 'amount-different').length
    }});
  } catch (error) { next(error); }
});

app.get('/api/reconciliation', authenticate, adminOnly, async (_req, res, next) => {
  try {
    try { await fs.access(reconciliationWorkbook); } catch { return res.json({ rows: [], totals: { excel: 0, found: 0, missing: 0 }, source: 'No hay archivo cargado' }); }
    const db = await readDb();
    const statementSnapshot = await readStatementSnapshot();
    const statementByInvoiceId = new Map((statementSnapshot?.entries || []).map(entry => [String(entry.systemInvoiceId), entry]));
    const statementBalanceFor = invoice => {
      if (!statementSnapshot || !invoice) return null;
      const entry = statementByInvoiceId.get(String(invoice.id));
      return entry && entry.balance !== null && entry.balance !== '' && Number.isFinite(Number(entry.balance))
        ? Number(entry.balance)
        : null;
    };
    const statementCandidates = statementSnapshot
      ? [
          ...(statementSnapshot.entries || []).map(entry => ({
            invoice: entry.statementInvoice || entry.folio || '',
            po: entry.statementPo || entry.po || '',
            date: entry.statementDate || entry.date || '',
            balance: entry.balance
          })),
          ...(statementSnapshot.unmatchedRows || [])
        ]
      : [];
    const statementBalanceForContpaqRow = row => {
      if (!statementCandidates.length) return null;
      const folioKey = normalizeReference(row.folio);
      const folioMatches = statementCandidates.filter(candidate => normalizeReference(candidate.invoice) === folioKey);
      if (folioMatches.length === 1 && Number.isFinite(Number(folioMatches[0].balance))) return Number(folioMatches[0].balance);

      const poKey = normalizeReference(row.series);
      if (!poKey) return null;
      const poMatches = statementCandidates.filter(candidate => {
        if (normalizeReference(candidate.po) !== poKey) return false;
        return !row.date || !candidate.date || String(candidate.date) === String(row.date);
      });
      return poMatches.length === 1 && Number.isFinite(Number(poMatches[0].balance))
        ? Number(poMatches[0].balance)
        : null;
    };
    const workbook = XLSX.readFile(reconciliationWorkbook, { cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const sourceRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const systemByFolio = new Map();
    for (const invoice of db.invoices) {
      const key = normalizeReference(invoice.folio);
      if (!systemByFolio.has(key)) systemByFolio.set(key, invoice);
    }
    const systemByFolioVariant = new Map();
    const systemByPo = new Map();
    const systemBySeries = new Map();
    for (const invoice of db.invoices.filter(item => item.poNumber)) {
      const key = normalizeReference(invoice.poNumber);
      const candidates = systemByPo.get(key) || [];
      candidates.push(invoice);
      systemByPo.set(key, candidates);
    }
    for (const invoice of db.invoices) {
      const folioVariant = normalizeFolioVariant(invoice.folio);
      if (folioVariant) {
        const candidates = systemByFolioVariant.get(folioVariant) || [];
        candidates.push(invoice);
        systemByFolioVariant.set(folioVariant, candidates);
      }
      for (const reference of [invoice.poNumber, invoice.folio]) {
        const key = normalizeReference(reference);
        if (!key) continue;
        const candidates = systemBySeries.get(key) || [];
        if (!candidates.some(candidate => candidate.id === invoice.id)) candidates.push(invoice);
        systemBySeries.set(key, candidates);
      }
    }
    const preparedRows = sourceRows
      .map(row => {
        const folio = normalizeReference(row.Folio);
        const series = String(row.Serie ?? row['Serie / PO'] ?? row['PO Number'] ?? '').trim();
        const parseAmount = value => {
          const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
          return Number.isFinite(parsed) ? parsed : 0;
        };
        return {
          folio: String(row.Folio ?? '').trim(),
          series,
          client: String(row['Razón Social'] ?? row['Razon Social'] ?? '').trim(),
          date: normalizeExcelDate(row.Fecha),
          total: parseAmount(row.Total),
          contpaqBalance: parseAmount(row.Pendiente),
          exactInvoice: systemByFolio.get(folio) || null,
          invoice: null
        };
      })
      .filter(row => row.folio);
    const excelDuplicateCounts = new Map();
    for (const row of preparedRows) {
      const key = reconciliationDuplicateKey(row.client, row.folio);
      if (key) excelDuplicateCounts.set(key, (excelDuplicateCounts.get(key) || 0) + 1);
    }
    const systemDuplicateCounts = new Map();
    for (const invoice of db.invoices) {
      const key = reconciliationDuplicateKey(invoice.client, invoice.folio);
      if (key) systemDuplicateCounts.set(key, (systemDuplicateCounts.get(key) || 0) + 1);
    }
    const reconciliationMatches = matchStatementRows(
      db.invoices,
      preparedRows.map(row => ({ invoice: row.folio, po: row.series, date: row.date }))
    );
    const usedInvoiceIds = new Set();
    for (const match of reconciliationMatches.matches) {
      const row = preparedRows[match.rowIndex];
      const invoice = db.invoices[match.invoiceIndex];
      row.invoice = invoice;
      row.matchedBy = match.method;
      usedInvoiceIds.add(invoice.id);
    }
    const contpaqRows = preparedRows.map(row => {
      const balanceContPaq = row.invoice ? statementBalanceFor(row.invoice) : statementBalanceForContpaqRow(row);
      const isLiveInvoice = !row.invoice && Number.isFinite(balanceContPaq) && balanceContPaq > 0.01;
      return {
        folio: row.folio,
        series: row.series,
        client: row.client,
        date: row.date,
        // Amount is the invoice amount registered in the system. The
        // reconciliation workbook's Total is only an external reference and
        // must not replace the system's original invoice amount.
        total: row.invoice ? Number(row.invoice.amount || 0) : row.total,
        inContPaq: true,
        inSystem: Boolean(row.invoice),
        sourceStatus: row.invoice ? 'both' : 'contpaq',
        existsInSystem: Boolean(row.invoice),
        matchedBy: row.invoice ? row.matchedBy : null,
        systemInvoiceId: row.invoice?.id || null,
        balanceSystem: row.invoice ? reconciliationBalance(row.invoice) : null,
        balanceContPaq,
        validation: excelDuplicateCounts.get(reconciliationDuplicateKey(row.client, row.folio)) > 1
          ? (systemDuplicateCounts.get(reconciliationDuplicateKey(row.client, row.folio)) > 1 ? 'both-duplicate' : 'excel-duplicate')
          : (systemDuplicateCounts.get(reconciliationDuplicateKey(row.client, row.folio)) > 1
            ? 'system-duplicate'
            : (isLiveInvoice
              ? 'live-invoice'
            : (!row.invoice || !Number.isFinite(balanceContPaq)
              ? 'missing'
              : (reconciliationBalanceMatches(row.invoice, balanceContPaq) ? 'valid' : 'amount-different'))))
      };
    });
    const systemOnlyRows = db.invoices
      .filter(invoice => !usedInvoiceIds.has(invoice.id))
      .map(invoice => {
        const balanceContPaq = statementBalanceFor(invoice);
        return {
          folio: invoice.folio,
          series: invoice.poNumber || '',
          client: invoice.client,
          date: invoice.issued,
          total: Number(invoice.amount || 0),
          inContPaq: Number.isFinite(balanceContPaq),
          inSystem: true,
          sourceStatus: Number.isFinite(balanceContPaq) ? 'both' : 'system',
          existsInSystem: true,
          matchedBy: null,
          systemInvoiceId: invoice.id,
          balanceSystem: reconciliationBalance(invoice),
          balanceContPaq,
          validation: systemDuplicateCounts.get(reconciliationDuplicateKey(invoice.client, invoice.folio)) > 1
            ? 'system-duplicate'
            : (Number.isFinite(balanceContPaq)
              ? (reconciliationBalanceMatches(invoice, balanceContPaq) ? 'valid' : 'amount-different')
              : 'missing')
        };
      });
    const rows = [...contpaqRows, ...systemOnlyRows];
    res.json({
      source: path.basename(reconciliationWorkbook),
      statementSource: statementSnapshot?.source || null,
      statementUploadedAt: statementSnapshot?.uploadedAt || null,
      rows,
      totals: {
        excel: contpaqRows.length,
        found: contpaqRows.filter(row => row.sourceStatus === 'both').length,
        missing: contpaqRows.filter(row => row.sourceStatus === 'contpaq' && row.validation === 'missing').length,
        system: db.invoices.length,
        both: rows.filter(row => row.sourceStatus === 'both').length,
        contpaqOnly: rows.filter(row => row.sourceStatus === 'contpaq').length,
        systemOnly: rows.filter(row => row.sourceStatus === 'system').length
      }
    });
  } catch (error) { next(error); }
});

// Agentes: catalogo simple para agrupar clientes por cartera. No inician
// sesion; son solo etiquetas con una lista de clientes asignados.
const normalizeAgentClients = value => (Array.isArray(value) ? value : [])
  .map(item => String(item || '').trim())
  .filter(Boolean);

// Estado de cuenta por correo. El adjunto (Excel o imagen) se arma en el
// navegador y llega en base64, para no duplicar aqui la generacion.
app.post('/api/account-statement/send-email', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    if (!canSendStatementForCustomer(req.user, req.body?.client, db.invoices || [], normalizeClientKey)) {
      return res.status(403).json({ message: 'No tienes permiso para enviar el estado de cuenta de este cliente.' });
    }
    const parseRecipients = value => String(value || '')
      .split(/[;,]/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(address => ({ emailAddress: { address } }));

    const recipients = resolveEmailDeliveryRecipients(req.user, req.body?.to, req.body?.cc);
    const to = parseRecipients(recipients.to);
    if (!to.length) return res.status(400).json({ message: 'Captura al menos un destinatario.' });
    const cc = parseRecipients(recipients.cc);

    const subject = String(req.body?.subject || '').trim() || 'Estado de cuenta';
    const logo = String(req.body?.logo || '');
    const logoHtml = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo)
      ? `<p style="margin:18px 0 0"><img src="${logo}" alt="" style="max-width:220px;height:auto"></p>`
      : '';
    // rellena {{campo}} con los valores que manda el navegador
    const values = req.body?.placeholders && typeof req.body.placeholders === 'object' ? req.body.placeholders : {};
    const filled = String(req.body?.bodyHtml || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
      const normalized = String(key).toLowerCase();
      return Object.prototype.hasOwnProperty.call(values, normalized) ? String(values[normalized]) : match;
    });
    // el logo va al cierre, despues del mensaje
    const bodyHtml = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933">${filled}${logoHtml}</div>`;

    const attachmentName = String(req.body?.attachmentName || 'estado-de-cuenta').replace(/[\\/:*?"<>|]+/g, '-');
    const attachmentBase64 = String(req.body?.attachmentBase64 || '');
    if (!attachmentBase64) return res.status(400).json({ message: 'No se recibio el archivo adjunto.' });
    const buffer = Buffer.from(attachmentBase64, 'base64');
    if (!buffer.length) return res.status(400).json({ message: 'El archivo adjunto llego vacio.' });

    const issuer = String(req.body?.issuer || '') === 'centro' ? 'centro' : 'pacifica';
    await graphSendMailWithAttachment({
      to, cc, subject, html: bodyHtml,
      attachment: { name: attachmentName, buffer },
      from: senderForIssuer(issuer)
    });

    // registro con statementKey: distingue el envio de estado de cuenta del de
    // factura, y es lo que deja ver cuando se le mando a cada cliente
    const statementKey = String(req.body?.clientKey || '').trim().replace(/^stmt:/, '');
    db.emailLog = db.emailLog || [];
    db.emailLog.push({
      id: Date.now(),
      statementKey,
      client: String(req.body?.client || ''),
      to: to.map(item => item.emailAddress.address),
      cc: cc.map(item => item.emailAddress.address),
      subject,
      sentAt: new Date().toISOString(),
      sentBy: req.user.email || '',
      sentByRole: req.user.role === 'admin' ? 'admin' : 'client'
    });

    if (req.user.role === 'admin' && shouldSaveEmailTemplate(req.body?.saveTemplate)) {
      const clientKey = String(req.body?.clientKey || '').trim();
      if (clientKey) {
        const existing = (db.emailTemplates || []).find(item => item.clientKey === clientKey);
        const template = {
          clientKey,
          client: String(req.body?.client || ''),
          to: String(req.body?.to || ''),
          cc: String(req.body?.cc || ''),
          subject,
          bodyHtml: String(req.body?.bodyHtml || ''),
          logo,
          updatedAt: new Date().toISOString()
        };
        if (existing) Object.assign(existing, template);
        else db.emailTemplates = [...(db.emailTemplates || []), template];
      }
      upsertEmailTemplate(db, String(req.body?.companyKey || '').trim(), {
        subject,
        bodyHtml: String(req.body?.bodyHtml || ''),
        logo,
        updatedBy: req.user.email || ''
      });
    }
    // se guarda siempre: aunque no se pida plantilla, el registro debe quedar
    await writeDb(db);

    res.json({ message: 'Estado de cuenta enviado.' });
  } catch (error) { next(error); }
});

app.get('/api/agents', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const agents = (await readAgents()).map(agent => ({ ...agent, clients: normalizeAgentClients(agent.clients) }));
    res.json(agents.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es')));
  } catch (error) { next(error); }
});

app.post('/api/agents', authenticate, adminOnly, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: 'El nombre del agente es obligatorio.' });
    const agents = await readAgents();
    if (agents.some(agent => String(agent.name).toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ message: 'Ya existe un agente con ese nombre.' });
    }
    const agent = {
      id: Date.now(),
      name,
      email: String(req.body?.email || '').trim(),
      clients: normalizeAgentClients(req.body?.clients),
      createdAt: new Date().toISOString()
    };
    await writeAgents([...agents, agent]);
    res.status(201).json(agent);
  } catch (error) { next(error); }
});

app.put('/api/agents/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const agents = await readAgents();
    const agent = agents.find(item => String(item.id) === String(req.params.id));
    if (!agent) return res.status(404).json({ message: 'Agente no encontrado.' });
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ message: 'El nombre del agente es obligatorio.' });
      const duplicated = agents.some(item => String(item.id) !== String(agent.id)
        && String(item.name).toLowerCase() === name.toLowerCase());
      if (duplicated) return res.status(409).json({ message: 'Ya existe un agente con ese nombre.' });
      agent.name = name;
    }
    if (req.body?.email !== undefined) agent.email = String(req.body.email).trim();
    if (req.body?.clients !== undefined) agent.clients = normalizeAgentClients(req.body.clients);
    await writeAgents(agents);
    res.json(agent);
  } catch (error) { next(error); }
});

app.delete('/api/agents/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const agents = await readAgents();
    const remaining = agents.filter(item => String(item.id) !== String(req.params.id));
    if (remaining.length === agents.length) return res.status(404).json({ message: 'Agente no encontrado.' });
    await writeAgents(remaining);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/users', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const db = await readDb();
    const users = db.users.map(({ passwordHash, ...user }) => ({ ...user, assignedClients: Array.isArray(user.assignedClients) ? user.assignedClients : [], permissions: Array.isArray(user.permissions) ? user.permissions : [], active: user.active !== false }));
    res.json(users.sort((a, b) => b.id - a.id));
  } catch (error) { next(error); }
});

app.post('/api/users', authenticate, adminOnly, async (req, res, next) => {
  try {
    const { name, username, email, password, assignedClients, role, permissions } = req.body;
    if (!name || !username || !email || !password) return res.status(400).json({ message: 'Nombre, usuario, correo y contraseña son obligatorios.' });
    if (String(password).length < 8) return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres.' });
    const db = await readDb();
    const normalizedUsername = String(username).trim().toLowerCase();
    const normalizedEmail = String(email).trim().toLowerCase();
    if (db.users.some(user => user.username.toLowerCase() === normalizedUsername)) return res.status(409).json({ message: 'Ese nombre de usuario ya está registrado.' });
    if (db.users.some(user => user.email?.toLowerCase() === normalizedEmail)) return res.status(409).json({ message: 'Ese correo ya está registrado.' });
    const safeRole = role === 'admin' ? 'admin' : 'client';
    const user = { id: Date.now(), name: String(name).trim(), clientKey: normalizeClientKey(name), username: String(username).trim(), email: normalizedEmail, assignedClients: Array.isArray(assignedClients) ? assignedClients : [], permissions: sanitizePermissions(permissions), role: safeRole, active: true, createdAt: new Date().toISOString(), passwordHash: await bcrypt.hash(String(password), 12) };
    db.users.push(user);
    await writeDb(db);
    const { passwordHash, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (error) { next(error); }
});

app.patch('/api/users/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const user = db.users.find(item => item.id === Number(req.params.id));
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado.' });
    const { name, username, email, active, password, assignedClients, role, permissions } = req.body;
    const normalizedUsername = username ? String(username).trim().toLowerCase() : user.username.toLowerCase();
    const normalizedEmail = email ? String(email).trim().toLowerCase() : user.email;
    if (db.users.some(item => item.id !== user.id && item.username.toLowerCase() === normalizedUsername)) return res.status(409).json({ message: 'Ese nombre de usuario ya está registrado.' });
    if (db.users.some(item => item.id !== user.id && item.email?.toLowerCase() === normalizedEmail)) return res.status(409).json({ message: 'Ese correo ya está registrado.' });
    if (password && String(password).length < 8) return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres.' });
    if (name) { user.name = String(name).trim(); user.clientKey = normalizeClientKey(name); }
    if (username) user.username = String(username).trim();
    if (email) user.email = normalizedEmail;
    if (typeof active === 'boolean') user.active = active;
    if (Array.isArray(assignedClients)) user.assignedClients = assignedClients;
    if (Array.isArray(permissions)) user.permissions = sanitizePermissions(permissions);
    if (role === 'admin' || role === 'client') {
      if (user.id === 1 && role !== 'admin') return res.status(400).json({ message: 'El administrador principal debe conservar su perfil.' });
      if (user.id === req.user.id && role !== 'admin') return res.status(400).json({ message: 'No puedes retirar tu propio acceso administrativo.' });
      user.role = role;
    }
    if (password) user.passwordHash = await bcrypt.hash(String(password), 12);
    await writeDb(db);
    const { passwordHash, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) { next(error); }
});

app.delete('/api/users/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const index = db.users.findIndex(item => item.id === Number(req.params.id));
    if (index < 0) return res.status(404).json({ message: 'Usuario no encontrado.' });
    const user = db.users[index];
    if (user.id === req.user.id || user.id === 1) return res.status(400).json({ message: 'No puedes eliminar el administrador principal ni tu propia cuenta.' });
    if (user.role === 'admin' && db.users.filter(item => item.role === 'admin').length <= 1) return res.status(400).json({ message: 'Debe existir al menos un administrador.' });
    db.users.splice(index, 1);
    await writeDb(db);
    res.status(204).send();
  } catch (error) { next(error); }
});

app.get('/api/invoices/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (req.user.loginSource === 'email-history' ? !historyInvoiceAccess(req.user, invoice, normalizeClientKey) : (req.user.role !== 'admin' && (invoice.clientKey || normalizeClientKey(invoice.client)) !== req.user.clientKey && invoice.email?.toLowerCase() !== req.user.email?.toLowerCase())) {
      return res.status(403).json({ message: 'No tienes permiso.' });
    }
    const storedPdf = await readPdfFromStorage(invoice, 'invoice');
    if (storedPdf) {
      res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceFileName || `Invoice-${invoice.folio}.pdf`}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(storedPdf.buffer);
    }
    if (invoice.invoiceSharePointUrl) return res.redirect(invoice.invoiceSharePointUrl);
    return res.status(404).json({ message: 'El archivo no está disponible.' });
  } catch (error) { next(error); }
});

app.get('/api/invoices/:id/receiving-pdf', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (req.user.loginSource === 'email-history' ? !historyInvoiceAccess(req.user, invoice, normalizeClientKey) : (req.user.role !== 'admin' && (invoice.clientKey || normalizeClientKey(invoice.client)) !== req.user.clientKey && invoice.email?.toLowerCase() !== req.user.email?.toLowerCase())) {
      return res.status(403).json({ message: 'No tienes permiso.' });
    }
    const storedPdf = await readPdfFromStorage(invoice, 'receiving');
    if (storedPdf) {
      res.setHeader('Content-Disposition', `inline; filename="${invoice.receivingFileName || `Receiving-${invoice.folio}.pdf`}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(await normalizePdfBufferToPrintSize(storedPdf.buffer));
    }
    if (invoice.receivingSharePointUrl) return res.redirect(invoice.receivingSharePointUrl);
    return res.status(404).json({ message: 'El archivo no está disponible.' });
  } catch (error) { next(error); }
});

// Devuelve la factura y su recibimiento unidos en un solo PDF. Si no hay
// recibimiento, devuelve la factura sola. `null` si la factura no tiene PDF.
async function buildInvoicePrintPdf(invoice) {
  const invoiceSource = await readPdfFromStorage(invoice, 'invoice');
  if (!invoiceSource) return null;
  const buffers = [invoiceSource.buffer];

  if (invoice.receivingPdfPath || invoice.receivingSharePointUrl) {
    const receivingSource = await readPdfFromStorage(invoice, 'receiving');
    if (receivingSource) buffers.push(receivingSource.buffer);
  }

  return {
    buffer: buffers.length > 1 ? await mergeReceivingPdfBuffers(buffers) : buffers[0],
    includesReceiving: buffers.length > 1
  };
}

// Campos automáticos disponibles en el asunto y el mensaje de las plantillas.
function invoicePlaceholders(invoice) {
  const money = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const balance = invoice.status === 'Pagada'
    ? 0
    : Math.max(0, Number(invoice.balance ?? (Number(invoice.amount || 0) - Number(invoice.creditAmount || 0))));
  return {
    factura: invoice.folio || '',
    cliente: invoice.client || '',
    po: invoice.poNumber || '',
    guia: invoice.guideNumber || '',
    monto: money(invoice.amount),
    saldo: money(balance),
    emision: invoice.issued || '',
    vencimiento: invoice.due || ''
  };
}

function applyPlaceholders(text, invoice) {
  const values = invoicePlaceholders(invoice);
  return String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
    const normalized = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, normalized) ? values[normalized] : match;
  });
}

function findEmailTemplate(db, clientKey) {
  return (db.emailTemplates || []).find(template => template.clientKey === clientKey) || null;
}

// Plantillas de correo: una por cliente, más una general de respaldo.
app.get('/api/email-log', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const db = await readDb();
    const entries = (db.emailLog || []).map(entry => ({
      invoiceId: entry.invoiceId,
      creditNumber: entry.creditNumber || '',
      statementKey: entry.statementKey || '',
      sentAt: entry.sentAt,
      to: Array.isArray(entry.to) ? entry.to : [],
      includedReceiving: !!entry.includedReceiving
    }));
    res.json({ entries });
  } catch (error) { next(error); }
});

app.get('/api/email-templates', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const db = await readDb();
    const { summarizeEmailTemplate } = await import('./email-template-payload.mjs');
    res.json({ templates: (db.emailTemplates || []).map(summarizeEmailTemplate), mailReady: mailReady(), mailFrom, mailFromCentro });
  } catch (error) { next(error); }
});

app.get('/api/email-status', authenticate, (_req, res) => {
  res.set('Cache-Control', 'no-store').json(publicEmailStatus({ mailReady: mailReady(), mailFrom, mailFromCentro }));
});

app.get('/api/email-templates/:clientKey', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const key = decodeURIComponent(String(req.params.clientKey || ''));
    const template = (db.emailTemplates || []).find(item => String(item.clientKey || '') === key);
    if (!template) return res.status(404).json({ message: 'Plantilla no encontrada.' });
    res.json({ template });
  } catch (error) { next(error); }
});

app.put('/api/email-templates/:clientKey', authenticate, adminOnly, async (req, res, next) => {
  try {
    const clientKey = String(req.params.clientKey || '').trim();
    if (!clientKey) return res.status(400).json({ message: 'Falta el cliente de la plantilla.' });

    const db = await readDb();
    const template = {
      clientKey,
      client: String(req.body?.client || '').trim(),
      to: String(req.body?.to || '').trim(),
      cc: String(req.body?.cc || '').trim(),
      subject: String(req.body?.subject || '').trim(),
      bodyHtml: String(req.body?.bodyHtml || ''),
      logo: String(req.body?.logo || ''),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.email || ''
    };
    const index = (db.emailTemplates || []).findIndex(item => item.clientKey === clientKey);
    if (index >= 0) db.emailTemplates[index] = template;
    else db.emailTemplates.push(template);
    await writeDb(db);
    res.json({ message: 'Plantilla guardada.', template });
  } catch (error) { next(error); }
});

// Envía la factura junto con su recibimiento en un solo PDF adjunto.
app.post('/api/invoices/:id/send-email', authenticate, async (req, res, next) => {
  try {
    if (!mailReady()) {
      return res.status(503).json({ message: 'El envío de correo no está configurado. Falta MAIL_FROM en el .env o el permiso Mail.Send en Azure.' });
    }

    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (!canSendEmailForInvoice(req.user, invoice, normalizeClientKey)) return res.status(403).json({ message: 'No tienes permiso para enviar esta factura.' });

    const recipients = resolveEmailDeliveryRecipients(req.user, req.body?.to, req.body?.cc);
    const to = parseRecipients(recipients.to);
    if (!to.length) return res.status(400).json({ message: 'Captura al menos un destinatario válido.' });
    const cc = parseRecipients(recipients.cc);

    const subject = applyPlaceholders(req.body?.subject, invoice).trim();
    if (!subject) return res.status(400).json({ message: 'Captura el asunto del correo.' });

    const logo = String(req.body?.logo || '');
    const logoHtml = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo)
      ? `<p style="margin:0 0 16px"><img src="${logo}" alt="" style="max-width:220px;height:auto"></p>`
      : '';
    const bodyHtml = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933">${logoHtml}${applyPlaceholders(req.body?.bodyHtml, invoice)}</div>`;

    const printPdf = await buildInvoicePrintPdf(invoice);
    if (!printPdf) return res.status(404).json({ message: 'El PDF de la factura no está disponible.' });

    const attachmentName = `${invoice.folio || invoice.id}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
    await graphSendMailWithAttachment({
      to, cc, subject, html: bodyHtml,
      attachment: { name: attachmentName, buffer: printPdf.buffer },
      from: senderForIssuer(invoiceIssuerKey(invoice))
    });

    const entry = {
      id: Date.now(),
      invoiceId: invoice.id,
      folio: invoice.folio || '',
      clientKey: invoice.clientKey || normalizeClientKey(invoice.client),
      client: invoice.client || '',
      to: to.map(item => item.emailAddress.address),
      cc: cc.map(item => item.emailAddress.address),
      subject,
      includedReceiving: printPdf.includesReceiving,
      sentAt: new Date().toISOString(),
      sentBy: req.user.email || '',
      sentByRole: req.user.role === 'admin' ? 'admin' : 'client'
    };
    db.emailLog.push(entry);

    // Guardar como plantilla del cliente si así lo pidió el usuario.
    if (req.user.role === 'admin' && shouldSaveEmailTemplate(req.body?.saveTemplate)) {
      // el navegador manda el alias del cliente; la razon social de la
      // factura solo sirve de respaldo
      const clientKey = String(req.body?.clientKey || '').trim() || invoice.clientKey || normalizeClientKey(invoice.client);
      const template = {
        clientKey,
        client: invoice.client || '',
        to: String(req.body?.to || '').trim(),
        cc: String(req.body?.cc || '').trim(),
        subject: String(req.body?.subject || '').trim(),
        bodyHtml: String(req.body?.bodyHtml || ''),
        logo,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.email || ''
      };
      const index = (db.emailTemplates || []).findIndex(item => item.clientKey === clientKey);
      if (index >= 0) db.emailTemplates[index] = template;
      else db.emailTemplates.push(template);

      upsertEmailTemplate(db, String(req.body?.companyKey || '').trim(), {
        subject: template.subject,
        bodyHtml: template.bodyHtml,
        logo,
        updatedBy: req.user.email || ''
      });
    }

    await writeDb(db);
    res.json({
      message: printPdf.includesReceiving
        ? `Factura ${invoice.folio} y su recibimiento enviados.`
        : `Factura ${invoice.folio} enviada. Esta factura todavía no tiene recibimiento.`,
      entry
    });
  } catch (error) { next(error); }
});

app.get('/api/invoices/:id/print-pdf', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (req.user.loginSource === 'email-history' ? !historyInvoiceAccess(req.user, invoice, normalizeClientKey) : (req.user.role !== 'admin' && (invoice.clientKey || normalizeClientKey(invoice.client)) !== req.user.clientKey && invoice.email?.toLowerCase() !== req.user.email?.toLowerCase())) {
      return res.status(403).json({ message: 'No tienes permiso.' });
    }

    const printPdf = await buildInvoicePrintPdf(invoice);
    if (!printPdf) return res.status(404).json({ message: 'El PDF de la factura no está disponible.' });
    const output = printPdf.buffer;
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${invoice.folio}-Print.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    // The merged document is generated on demand; never let the browser reuse
    // a lower-quality PDF generated before the native merger was enabled.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(output);
  } catch (error) { next(error); }
});

app.post('/api/invoices/:id/send-credit-email', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (!canSendEmailForInvoice(req.user, invoice, normalizeClientKey)) return res.status(403).json({ message: 'No tienes permiso para enviar este crédito.' });
    const credit = (invoice.credits || []).find(item => !item.creditFlagHidden
      && String(item.creditNumber || '') === String(req.body?.creditNumber || '')
      && String(item.creditPdfPath || '') === String(req.body?.creditPath || ''));
    if (!credit?.creditPdfPath) return res.status(404).json({ message: 'La nota de devolución no está asociada a esta factura.' });

    const recipients = resolveEmailDeliveryRecipients(req.user, req.body?.to, req.body?.cc);
    const to = parseRecipients(recipients.to);
    if (!to.length) return res.status(400).json({ message: 'Captura al menos un destinatario válido.' });
    const cc = parseRecipients(recipients.cc);

    // los campos {{campo}} se rellenan con lo que manda el navegador
    const values = req.body?.placeholders && typeof req.body.placeholders === 'object' ? req.body.placeholders : {};
    const fill = text => String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
      const norm = String(key).toLowerCase();
      return Object.prototype.hasOwnProperty.call(values, norm) ? String(values[norm]) : match;
    });
    const subject = fill(req.body?.subject).trim();
    if (!subject) return res.status(400).json({ message: 'Captura el asunto del correo.' });

    const logo = String(req.body?.logo || '');
    const logoHtml = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo)
      ? `<p style="margin:0 0 16px"><img src="${logo}" alt="" style="max-width:220px;height:auto"></p>`
      : '';
    const bodyHtml = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933">${logoHtml}${fill(req.body?.bodyHtml)}</div>`;

    const buffer = await readPdfPathFromStorage(credit.creditPdfPath);
    if (!buffer) return res.status(404).json({ message: 'El PDF de la devolución no está disponible.' });
    const attachmentName = `Devolucion-${String(credit.creditNumber || invoice.folio || invoice.id).replace(/[\/:*?"<>|]+/g, '-')}.pdf`;

    await graphSendMailWithAttachment({
      to, cc, subject, html: bodyHtml,
      attachment: { name: attachmentName, buffer },
      from: senderForIssuer(invoiceIssuerKey(invoice))
    });

    // el mensaje de devolucion se guarda por empresa, aparte del de facturas
    if (req.user.role === 'admin' && req.body?.saveTemplate) {
      upsertEmailTemplate(db, String(req.body?.companyKey || '').trim(), {
        subject, bodyHtml: String(req.body?.bodyHtml || ''), logo, updatedBy: req.user.email || ''
      });
    }
    // registro con creditNumber: distingue el envio de devolucion del de factura
    db.emailLog = db.emailLog || [];
    db.emailLog.push({
      id: Date.now(), invoiceId: invoice.id, creditNumber: String(credit.creditNumber || ''),
      folio: invoice.folio || '', client: invoice.client || '',
      to: to.map(item => item.emailAddress.address), cc: cc.map(item => item.emailAddress.address),
      sentAt: new Date().toISOString(), sentBy: req.user.email || '', sentByRole: req.user.role === 'admin' ? 'admin' : 'client'
    });
    await writeDb(db);

    res.json({ message: `Devolución ${credit.creditNumber || ''} enviada.`.replace('  ', ' ') });
  } catch (error) { next(error); }
});

app.get('/api/invoices/:id/credits-pdf', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (req.user.loginSource === 'email-history' ? !historyInvoiceAccess(req.user, invoice, normalizeClientKey) : (req.user.role !== 'admin' && (invoice.clientKey || normalizeClientKey(invoice.client)) !== req.user.clientKey && invoice.email?.toLowerCase() !== req.user.email?.toLowerCase())) {
      return res.status(403).json({ message: 'No tienes permiso.' });
    }

    const directCreditPaths = (invoice.credits || [])
      .filter(credit => !credit.creditFlagHidden)
      .map(credit => credit.creditPdfPath)
      .filter(Boolean);
    const redirectedCreditPaths = db.invoices
      .filter(sourceInvoice => sourceInvoice.id !== invoice.id)
      .flatMap(sourceInvoice => (sourceInvoice.credits || [])
        .filter(credit => !credit.creditFlagHidden && Number(credit.creditFlagTargetInvoiceId) === invoice.id)
        .map(credit => credit.creditPdfPath)
        .filter(Boolean));
    const creditPaths = Array.from(new Set([...directCreditPaths, ...redirectedCreditPaths]));
    if (!creditPaths.length) return res.status(404).json({ message: 'No hay PDFs de crédito disponibles para esta factura.' });

    const mergedPdf = await PDFDocument.create();
    let includedFiles = 0;
    for (const creditPath of creditPaths) {
      const sourceBytes = await readPdfPathFromStorage(creditPath);
      if (!sourceBytes) continue;
      try {
        const sourcePdf = await PDFDocument.load(sourceBytes);
        const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
        includedFiles++;
      } catch (loadError) {
        try {
          const parser = new PDFParse({ data: sourceBytes });
          const screenshots = await parser.getScreenshot({ scale: 1.5, imageBuffer: true });
          await parser.destroy();
          for (const screenshot of screenshots.pages) {
            const image = await mergedPdf.embedPng(Buffer.from(screenshot.data));
            const page = mergedPdf.addPage([screenshot.width, screenshot.height]);
            page.drawImage(image, { x: 0, y: 0, width: screenshot.width, height: screenshot.height });
          }
          includedFiles++;
          console.warn(`[CREDITS PDF] Included ${creditPath} through rendered fallback: ${loadError.message}`);
        } catch (fallbackError) {
          console.warn(`[CREDITS PDF] Could not include ${creditPath}: ${fallbackError.message}`);
        }
      }
    }
    if (!includedFiles || !mergedPdf.getPageCount()) return res.status(404).json({ message: 'No se pudieron leer los PDFs de crédito.' });

    const fileName = `Credits-${String(invoice.folio || invoice.id).replace(/[^a-z0-9-_]+/gi, '-')}.pdf`;
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(await mergedPdf.save()));
  } catch (error) { next(error); }
});

app.get('/api/invoices/:id/credit-pdf', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (req.user.loginSource === 'email-history' ? !historyInvoiceAccess(req.user, invoice, normalizeClientKey) : (req.user.role !== 'admin' && (invoice.clientKey || normalizeClientKey(invoice.client)) !== req.user.clientKey && invoice.email?.toLowerCase() !== req.user.email?.toLowerCase())) return res.status(403).json({ message: 'No tienes permiso.' });
    const credit = (invoice.credits || []).find(item => !item.creditFlagHidden && String(item.creditNumber || '') === String(req.query.creditNumber || '') && String(item.creditPdfPath || '') === String(req.query.creditPath || ''));
    if (!credit?.creditPdfPath) return res.status(404).json({ message: 'El PDF de crédito no está asociado a esta factura.' });
    const bytes = await readPdfPathFromStorage(credit.creditPdfPath);
    if (!bytes) return res.status(404).json({ message: 'El PDF de crédito no está disponible.' });
    res.setHeader('Content-Disposition', `inline; filename="Credit-${String(credit.creditNumber || invoice.folio || invoice.id).replace(/[^a-z0-9-_]+/gi, '-')}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  } catch (error) { next(error); }
});

app.post('/api/invoices/parse', authenticate, adminOnly, upload.fields([{ name: 'invoicePdf', maxCount: 1 }, { name: 'receivingPdf', maxCount: 1 }]), async (req, res, next) => {
  try {
    const invoiceFile = req.files?.invoicePdf?.[0];
    if (!invoiceFile) return res.status(400).json({ message: 'Selecciona el PDF de la factura.' });
    res.json(await extractInvoicePdf(invoiceFile.buffer));
  } catch (error) { next(error); }
});

app.post('/api/invoices', authenticate, adminOnly, upload.fields([{ name: 'invoicePdf', maxCount: 1 }, { name: 'receivingPdf', maxCount: 1 }]), async (req, res, next) => {
  try {
    const invoiceFile = req.files?.invoicePdf?.[0];
    let receivingFile = req.files?.receivingPdf?.[0];
    receivingFile = await ensurePdf(receivingFile);
    const extracted = invoiceFile ? await extractInvoicePdf(invoiceFile.buffer) : {};
    // Los cambios hechos manualmente en el formulario tienen prioridad sobre el PDF.
    const { folio, poNumber, guideNumber, client, location, email, concept, issued, due, amount, status = 'Pendiente' } = { ...extracted, ...req.body };
    const parsedAmount = Number(amount);
    if (!client || !email || !concept || !issued || !due || amount === undefined || amount === null || String(amount).trim() === '' || !Number.isFinite(parsedAmount) || parsedAmount < 0) return res.status(400).json({ message: 'Completa todos los datos de la factura.' });
    if (!['Pagada', 'Pendiente', 'Vencida'].includes(status)) return res.status(400).json({ message: 'Estado de factura inválido.' });
    const sharePointFiles = await uploadInvoiceFilesToSharePoint({ client, location, issued, folio: folio || 'invoice', invoiceFile, receivingFile });
    const db = await readDb();
    const next = Math.max(48, ...db.invoices.map(item => Number(item.folio.split('-').pop()))) + 1;
    await fs.mkdir(uploadsDir, { recursive: true });
    const id = Date.now();
    const invoicePdfPath = invoiceFile ? `${id}-invoice.pdf` : '';
    const receivingPdfPath = receivingFile ? `${id}-receiving.pdf` : '';
    if (invoiceFile) await fs.writeFile(path.join(uploadsDir, invoicePdfPath), invoiceFile.buffer);
    if (receivingFile) await fs.writeFile(path.join(uploadsDir, receivingPdfPath), receivingFile.buffer);
    if (invoiceFile) await syncPdfToOracle(invoicePdfPath, invoiceFile.buffer);
    if (receivingFile) await syncPdfToOracle(receivingPdfPath, receivingFile.buffer);
    const invoice = { id, folio: String(folio || `FAC-${new Date().getFullYear()}-${String(next).padStart(4, '0')}`).trim(), poNumber: String(poNumber || '').trim(), guideNumber: String(guideNumber || '').trim(), client: String(client).trim(), location: String(location || '').trim(), clientKey: normalizeClientKey(client), email: String(email).trim().toLowerCase(), concept: String(concept).trim(), searchText: extracted.searchText || '', issued, due, amount: parsedAmount, status, invoiceFileName: invoiceFile?.originalname || '', receivingFileName: receivingFile?.originalname || '', invoicePdfPath, receivingPdfPath, invoiceSharePointUrl: sharePointFiles.invoice?.webUrl || '', receivingSharePointUrl: sharePointFiles.receiving?.webUrl || '' };
    invoice.sharePointStorage = { client: invoice.client, location: invoice.location, issued: invoice.issued, folio: invoice.folio };
    db.invoices.push(invoice);
    await writeDb(db);
    res.status(201).json(invoice);
  } catch (error) { next(error); }
});

app.patch('/api/invoices/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    if (req.body.status && !['Pagada', 'Pendiente', 'Vencida'].includes(req.body.status)) return res.status(400).json({ message: 'Estado inválido.' });
    const editableFields = ['folio', 'poNumber', 'guideNumber', 'client', 'location', 'email', 'concept', 'issued', 'due', 'amount', 'status', 'balance'];
    const changes = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => editableFields.includes(key)));
    if (!invoice.sharePointStorage) invoice.sharePointStorage = { client: invoice.client, location: invoice.location || '', issued: invoice.issued, folio: invoice.folio };
    if (changes.client !== undefined && !String(changes.client).trim()) return res.status(400).json({ message: 'El nombre del cliente es obligatorio.' });
    if (changes.email !== undefined && !String(changes.email).trim()) return res.status(400).json({ message: 'El correo electrÃ³nico es obligatorio.' });
    if (changes.concept !== undefined && !String(changes.concept).trim()) return res.status(400).json({ message: 'La descripciÃ³n es obligatoria.' });
    if (changes.issued !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.issued))) return res.status(400).json({ message: 'La fecha de emisiÃ³n no es vÃ¡lida.' });
    if (changes.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.due))) return res.status(400).json({ message: 'La fecha de vencimiento no es vÃ¡lida.' });
    if (changes.amount !== undefined && (!Number.isFinite(Number(changes.amount)) || Number(changes.amount) <= 0)) return res.status(400).json({ message: 'El importe debe ser mayor que cero.' });
    if (changes.balance !== undefined && (!Number.isFinite(Number(changes.balance)) || Number(changes.balance) < 0)) return res.status(400).json({ message: 'El saldo debe ser un número mayor o igual a cero.' });
    if (changes.folio !== undefined) {
      const nextFolio = String(changes.folio).trim();
      if (normalizeReference(nextFolio) !== normalizeReference(invoice.folio)) invoice.folioEditedManually = true;
      invoice.folio = nextFolio;
    }
    if (changes.poNumber !== undefined) invoice.poNumber = String(changes.poNumber).trim();
    if (changes.guideNumber !== undefined) invoice.guideNumber = String(changes.guideNumber).trim();
    if (changes.client !== undefined) { invoice.client = String(changes.client).trim(); invoice.clientKey = normalizeClientKey(invoice.client); }
    if (changes.location !== undefined) invoice.location = String(changes.location).trim();
    if (changes.email !== undefined) invoice.email = String(changes.email).trim().toLowerCase();
    if (changes.concept !== undefined) invoice.concept = String(changes.concept).trim();
    if (changes.issued !== undefined) invoice.issued = String(changes.issued);
    if (changes.due !== undefined) invoice.due = String(changes.due);
    if (changes.amount !== undefined) invoice.amount = Number(changes.amount);
    if (changes.status !== undefined) invoice.status = changes.status;
    if (changes.balance !== undefined) invoice.balance = Number(changes.balance);
    invoice.sharePointStorage = {
      ...(invoice.sharePointStorage || {}),
      client: invoice.client,
      location: invoice.location || '',
      issued: invoice.issued,
      folio: invoice.folio
    };
    await writeDb(db);
    res.json(invoice);
  } catch (error) { next(error); }
});

app.patch('/api/invoices/:id/receiving', authenticate, adminOnly, upload.single('receivingPdf'), async (req, res, next) => {
  try {
    let receivingFile = req.file;
    if (!receivingFile) return res.status(400).json({ message: 'Selecciona el PDF de recibimiento.' });
    receivingFile = await ensurePdf(receivingFile);
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    const sharePointFiles = await uploadInvoiceFilesToSharePoint({ client: invoice.client, location: invoice.location, issued: invoice.issued, folio: invoice.folio, receivingFile });
    await fs.mkdir(uploadsDir, { recursive: true });
    const receivingPdfPath = `${invoice.id}-receiving.pdf`;
    await fs.writeFile(path.join(uploadsDir, receivingPdfPath), receivingFile.buffer);
    await syncPdfToOracle(receivingPdfPath, receivingFile.buffer);
    Object.assign(invoice, {
      receivingFileName: receivingFile.originalname,
      receivingPdfPath,
      receivingSharePointUrl: sharePointFiles.receiving?.webUrl || invoice.receivingSharePointUrl || ''
    });
    await writeDb(db);
    res.json(invoice);
  } catch (error) { next(error); }
});

app.patch('/api/invoices/:id/invoice-pdf', authenticate, adminOnly, upload.single('invoicePdf'), async (req, res, next) => {
  try {
    const invoiceFile = req.file;
    if (!invoiceFile) return res.status(400).json({ message: 'Selecciona el PDF de la factura.' });
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    const sharePointFiles = await uploadInvoiceFilesToSharePoint({ client: invoice.client, location: invoice.location, issued: invoice.issued, folio: invoice.folio, invoiceFile });
    await fs.mkdir(uploadsDir, { recursive: true });
    const invoicePdfPath = `${invoice.id}-invoice.pdf`;
    await fs.writeFile(path.join(uploadsDir, invoicePdfPath), invoiceFile.buffer);
    await syncPdfToOracle(invoicePdfPath, invoiceFile.buffer);
    Object.assign(invoice, {
      invoiceFileName: invoiceFile.originalname,
      invoicePdfPath,
      invoiceSharePointUrl: sharePointFiles.invoice?.webUrl || invoice.invoiceSharePointUrl || ''
    });
    await writeDb(db);
    res.json(invoice);
    } catch (error) { next(error); }
  });

  app.post('/api/invoices/sync/replace', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const existingInvoiceId = Number(req.body?.existingInvoiceId);
      const sourceFileId = String(req.body?.sourceFileId || '').trim();
      if (!existingInvoiceId || !sourceFileId) return res.status(400).json({ message: 'Faltan los datos de la factura que se reemplazará.' });

      const db = await readDb();
      const invoice = db.invoices.find(item => item.id === existingInvoiceId);
      if (!invoice) return res.status(404).json({ message: 'La factura existente ya no está disponible.' });

      const { driveId } = await getSharePointDrive();
      const sourceItem = await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!sourceItem?.name || !sourceItem['@microsoft.graph.downloadUrl']) return res.status(404).json({ message: 'El PDF duplicado ya no está disponible en SharePoint.' });
      if (!String(sourceItem.name).toLowerCase().endsWith('.pdf')) return res.status(400).json({ message: 'El archivo seleccionado no es un PDF.' });

      const response = await fetch(sourceItem['@microsoft.graph.downloadUrl']);
      if (!response.ok) return res.status(502).json({ message: `No se pudo descargar el PDF duplicado (${response.status}).` });
      const buffer = Buffer.from(await response.arrayBuffer());
      const extracted = await extractInvoicePdf(buffer);
      if (!extracted?.folio || !Number.isFinite(extracted.amount) || !extracted?.client) return res.status(422).json({ message: 'El PDF seleccionado no contiene una factura válida.' });

      const conflictingInvoice = db.invoices.find(item => item.id !== invoice.id
        && normalizeClientKey(item.client) === normalizeClientKey(extracted.client)
        && normalizeReference(item.folio) === normalizeReference(extracted.folio));
      if (conflictingInvoice) return res.status(409).json({ message: 'Existe otra factura con el mismo cliente y folio. No se realizó el reemplazo.' });

      const previousStorage = invoice.sharePointStorage || {
        client: invoice.client,
        location: invoice.location || '',
        issued: invoice.issued,
        folio: invoice.folio
      };
      const nextStorage = {
        client: extracted.client,
        location: extracted.location || '',
        issued: extracted.issued,
        folio: invoice.folioEditedManually ? invoice.folio : extracted.folio
      };
      const sameStorage = normalizeClientKey(previousStorage.client) === normalizeClientKey(nextStorage.client)
        && String(previousStorage.location || '') === String(nextStorage.location || '')
        && String(previousStorage.issued || '') === String(nextStorage.issued || '')
        && normalizeReference(previousStorage.folio) === normalizeReference(nextStorage.folio);

      const sharePointFiles = await uploadInvoiceFilesToSharePoint({
        client: extracted.client,
        location: extracted.location || '',
        issued: extracted.issued,
        folio: nextStorage.folio,
        invoiceFile: { buffer, originalname: sourceItem.name }
      });
      if (!sameStorage) await deleteSharePointFile({ ...previousStorage, type: 'invoice' });

      const invoicePdfPath = `${invoice.id}-invoice.pdf`;
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(path.join(uploadsDir, invoicePdfPath), buffer);
      await syncPdfToOracle(invoicePdfPath, buffer);
      Object.assign(invoice, {
        folio: nextStorage.folio,
        poNumber: extracted.poNumber || '',
        guideNumber: extracted.guideNumber || '',
        client: extracted.client,
        clientKey: normalizeClientKey(extracted.client),
        location: extracted.location || '',
        concept: extracted.concept || invoice.concept || 'Factura importada desde PDF',
        searchText: extracted.searchText || '',
        issued: extracted.issued || invoice.issued,
        due: extracted.due || invoice.due,
        amount: extracted.amount,
        invoiceFileName: sourceItem.name,
        invoicePdfPath,
        invoiceSharePointUrl: sharePointFiles.invoice?.webUrl || invoice.invoiceSharePointUrl || '',
        sharePointStorage: nextStorage
      });

      await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      await writeDb(db);
      res.json({ message: `Factura ${invoice.folio} reemplazada correctamente. El recibimiento existente se conservó.`, invoice });
    } catch (error) { next(error); }
  });

  app.post('/api/invoices/sync/replace-receiving', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const sourceFileId = String(req.body?.sourceFileId || '').trim();
      const invoiceIds = Array.isArray(req.body?.invoiceIds) ? req.body.invoiceIds.map(Number).filter(Boolean) : [];
      if (!sourceFileId || invoiceIds.length !== 1) return res.status(400).json({ message: 'Selecciona exactamente una factura para reemplazar el recibimiento.' });

      const db = await readDb();
      const targetInvoices = db.invoices.filter(invoice => invoiceIds.includes(Number(invoice.id)));
      if (!targetInvoices.length) return res.status(404).json({ message: 'No se encontraron las facturas coincidentes.' });
      const { driveId } = await getSharePointDrive();
      const sourceItem = await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!sourceItem?.name || !sourceItem['@microsoft.graph.downloadUrl']) return res.status(404).json({ message: 'El recibimiento ya no está disponible en SharePoint.' });
      const response = await fetch(sourceItem['@microsoft.graph.downloadUrl']);
      if (!response.ok) return res.status(502).json({ message: `No se pudo descargar el recibimiento (${response.status}).` });
      const buffer = Buffer.from(await response.arrayBuffer());

      for (const invoice of targetInvoices) {
        if (invoice.receivingSharePointUrl) {
          await deleteSharePointFile({
            client: invoice.client,
            location: invoice.location || '',
            issued: invoice.issued,
            folio: invoice.folio,
            type: 'receiving'
          });
        }
        await removePdfFromOracle(invoicePdfObjectName(invoice, 'receiving'));
        await removeLocalFile(invoice.receivingPdfPath);
        invoice.receivingSharePointUrl = '';
        invoice.receivingFileName = '';
        invoice.receivingPdfPath = '';
      }

      const receivingResult = await attachReceivingToInvoices({ invoices: targetInvoices, file: sourceItem, buffer, db });
      if (!receivingResult.processed) return res.status(409).json({ message: receivingResult.reason });
      await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      res.json({ message: `Recibimiento reemplazado y asociado a ${receivingResult.linkedInvoices.length} factura(s).` });
    } catch (error) { next(error); }
  });

  app.post('/api/invoices/sync/revert-receiving', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const invoiceIds = Array.isArray(req.body?.invoiceIds) ? req.body.invoiceIds.map(Number).filter(Boolean) : [];
      if (!invoiceIds.length) return res.status(400).json({ message: 'Faltan las facturas que se deben revertir.' });
      const db = await readDb();
      const invoices = db.invoices.filter(invoice => invoiceIds.includes(Number(invoice.id)) && String(invoice.receivingFileName || '') === '21082026-7735.pdf');
      if (!invoices.length) return res.status(404).json({ message: 'No se encontraron las asociaciones del recibimiento indicado.' });
      for (const invoice of invoices) {
        await deleteSharePointFile({ client: invoice.client, location: invoice.location || '', issued: invoice.issued, folio: invoice.folio, type: 'receiving' });
        await removePdfFromOracle(invoicePdfObjectName(invoice, 'receiving'));
        await removeLocalFile(invoice.receivingPdfPath);
        invoice.receivingFileName = '';
        invoice.receivingPdfPath = '';
        invoice.receivingSharePointUrl = '';
      }
      await writeDb(db);
      res.json({ message: `Se revirtieron ${invoices.length} asociaciones de recibimiento.`, invoiceIds: invoices.map(invoice => invoice.id) });
    } catch (error) { next(error); }
  });

  app.post('/api/invoices/sync/remove', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const sourceFileId = String(req.body?.sourceFileId || '').trim();
      if (!sourceFileId) return res.status(400).json({ message: 'Falta el archivo que se eliminará.' });
      const { driveId } = await getSharePointDrive();
      const sourceItem = await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!sourceItem?.name) return res.status(404).json({ message: 'El PDF ya no está disponible en SharePoint.' });
      const rootFolder = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
      if (sourceItem.parentReference?.id !== rootFolder.id) return res.status(400).json({ message: 'Solo se pueden eliminar archivos sueltos de la carpeta de sincronización.' });
      await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      res.json({ message: `Archivo ${sourceItem.name} eliminado de la carpeta de sincronización.` });
    } catch (error) { next(error); }
  });

  app.post('/api/invoices/sync', authenticate, adminOnly, async (req, res) => {
    if (activeInvoiceSyncJob && ['queued', 'running'].includes(activeInvoiceSyncJob.status)) {
      return res.status(409).json({ message: 'Ya hay una sincronización de facturas en curso.', jobId: activeInvoiceSyncJob.id });
    }

    const authorization = req.headers.authorization || '';
    const job = {
      id: randomUUID(),
      status: 'queued',
      total: 0,
      scanned: 0,
      processed: 0,
      skipped: 0,
      currentFile: '',
      message: 'Sincronización en cola.',
      issues: [],
      details: [],
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    activeInvoiceSyncJob = job;
    await persistInvoiceSyncJob(job);
    res.status(202).json({ jobId: job.id, status: job.status });

    void (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/invoices/sync/run`, {
          method: 'POST',
          headers: { Authorization: authorization, 'X-Sync-Job-Id': job.id }
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || `La sincronización terminó con HTTP ${response.status}.`);
        updateInvoiceSyncJob(job, {
          status: 'completed',
          message: result.message || 'Sincronización completada.',
          processed: result.processed || 0,
          skipped: result.skipped || 0,
          issues: result.issues || [],
          details: result.details || [],
          currentFile: '',
          finishedAt: new Date().toISOString()
        });
        await persistInvoiceSyncJob(job);
      } catch (error) {
        updateInvoiceSyncJob(job, {
          status: 'failed',
          message: error.message || 'La sincronización no pudo completarse.',
          issues: [{ status: 'error', reason: error.message || 'Error interno de sincronización.' }],
          currentFile: '',
          finishedAt: new Date().toISOString()
        });
        await persistInvoiceSyncJob(job);
      } finally {
        activeInvoiceSyncJob = null;
      }
    })();
  });

  app.get('/api/invoices/sync/status/:jobId', authenticate, adminOnly, async (req, res, next) => {
    try {
      const job = await readInvoiceSyncJob(String(req.params.jobId || ''));
      if (!job) return res.status(404).json({ message: 'No se encontró la sincronización solicitada.' });
      res.json(job);
    } catch (error) { next(error); }
  });

  app.post('/api/invoices/sync/run', authenticate, adminOnly, async (req, res, next) => {
    const jobId = String(req.headers['x-sync-job-id'] || '');
    const job = activeInvoiceSyncJob?.id === jobId ? activeInvoiceSyncJob : null;
    updateInvoiceSyncJob(job, { status: 'running', message: 'Preparando archivos…' });
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const { driveId } = await getSharePointDrive();
      const root = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
      const sourceEntries = await collectInvoiceSyncFiles(driveId, root.id);
      updateInvoiceSyncJob(job, { total: sourceEntries.length, scanned: 0, processed: 0, skipped: 0, currentFile: '', message: `Se encontraron ${sourceEntries.length} archivos.` });
      
      let processed = 0;
      let skipped = 0;
      const issues = [];
      const details = [];
      const pendingReceivings = [];
      const newlyProcessedInvoiceIds = new Set();
      const pendingSourceDeletions = [];
      const db = await readDb();
  
      for (const sourceEntry of sourceEntries) {
        const { file, sourcePath } = sourceEntry;
        updateInvoiceSyncJob(job, { scanned: (job?.scanned || 0) + 1, currentFile: file.name, message: `Procesando ${file.name}` });
        if (!file['@microsoft.graph.downloadUrl']) { issues.push({ file: file.name, status: 'error', reason: 'No se pudo obtener el enlace de descarga.' }); skipped++; updateInvoiceSyncJob(job, { skipped }); continue; }
        
        let response;
        try {
          response = await withRetry(async () => {
            const result = await fetchWithTimeout(file['@microsoft.graph.downloadUrl']);
            if (result.status >= 500) throw new Error(`Descarga fallida (${result.status}).`);
            return result;
          });
        } catch (error) {
          issues.push({ file: file.name, status: 'error', reason: error.message || 'Descarga fallida.' });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
          continue;
        }
        if (!response.ok) { issues.push({ file: file.name, status: 'error', reason: `Descarga fallida (${response.status}).` }); skipped++; updateInvoiceSyncJob(job, { skipped }); continue; }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        let normalizedFile;
        try {
          normalizedFile = await ensurePdf({
            buffer,
            mimetype: syncFileMimeType(file.name),
            originalname: file.name
          });
        } catch (error) {
          issues.push({ file: file.name, status: 'error', reason: `No se pudo convertir el recibimiento: ${error.message || 'formato no compatible'}` });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
          continue;
        }
        const convertedFromImage = normalizedFile.originalname !== file.name;
        
        let extracted = null;
        try {
          extracted = await extractInvoicePdf(normalizedFile.buffer);
        } catch (e) {
          console.log(`[SYNC INVOICE] ${file.name} no parece una factura: ${e.message}`);
        }
        
        if (!extracted?.folio || !Number.isFinite(extracted.amount) || !extracted?.client) {
          // A file explicitly named as an invoice must never be guessed as a
          // receiving solely because its folio happens to match another
          // customer's invoice. Leave it in the source folder for review.
          if (hasInvoiceFilenameHint(file.name)) {
            issues.push({
              file: file.name,
              status: 'error',
              reason: 'El archivo parece una factura (nombre INVOICE + PO), pero no se pudieron leer todos sus datos. No se asignó como recibimiento.'
            });
            skipped++;
            updateInvoiceSyncJob(job, { skipped });
            continue;
          }
          pendingReceivings.push({ file, buffer: normalizedFile.buffer, convertedFromImage, convertedName: normalizedFile.originalname });
          continue;
        }

        const normalizedClient = normalizeClientKey(extracted.client);
        const normalizedFolio = normalizeReference(extracted.folio);
        const duplicateInvoice = db.invoices.find(existing => isDuplicateInvoice(existing, extracted));
        if (duplicateInvoice) {
          const duplicateLabel = `${extracted.client} / factura ${extracted.folio}`;
          console.log(`[SYNC INVOICE] Skipped ${file.name}: Duplicate ${duplicateLabel}`);
          issues.push({
            file: file.name,
            status: 'duplicate',
            reason: `La factura ya existe para este cliente (registro ${duplicateInvoice.id}). No se subió ni se movió el PDF.`,
            replacement: { kind: 'invoice', sourceFileId: file.id, existingInvoiceId: duplicateInvoice.id }
          });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
          continue;
        }
        
        console.log(`[SYNC INVOICE] Processing ${file.name}: Folio=${extracted.folio}, Client=${extracted.client}, Amount=${extracted.amount}`);
        
        let sharePointFiles;
        try {
          sharePointFiles = await withRetry(() => uploadInvoiceFilesToSharePoint({
            client: extracted.client,
            location: extracted.location || '',
            issued: extracted.issued,
            folio: extracted.folio,
            invoiceFile: { buffer: normalizedFile.buffer, originalname: normalizedFile.originalname }
          }));
        } catch (error) {
          // A failed destination upload must not abort the whole batch or
          // create a partial invoice record. The original source remains in
          // SharePoint and can be retried safely on the next synchronization.
          issues.push({ file: file.name, status: 'error', reason: `No se pudo guardar la copia de la factura: ${error.message}` });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
          continue;
        }
        
        const invoice = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          folio: extracted.folio,
          poNumber: extracted.poNumber || '',
          guideNumber: extracted.guideNumber || '',
          client: extracted.client,
          clientKey: normalizeClientKey(extracted.client),
          location: extracted.location || '',
          email: extracted.email || '',
          concept: extracted.concept || 'Factura (Auto-Sync)',
          searchText: extracted.searchText || '',
          issued: extracted.issued || new Date().toISOString().split('T')[0],
          due: extracted.due || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          amount: extracted.amount,
          status: 'Pendiente',
          credits: [],
          creditAmount: 0,
          invoiceFileName: file.name,
          sourceSharePointPath: sourcePath,
          invoicePdfPath: `${Date.now() + Math.floor(Math.random() * 1000)}-invoice.pdf`,
          invoiceSharePointUrl: sharePointFiles.invoice?.webUrl || '',
          receivingFileName: '',
          receivingPdfPath: '',
          receivingSharePointUrl: '',
          sharePointStorage: { client: extracted.client, location: extracted.location || '', issued: extracted.issued, folio: extracted.folio }
        };
        
        invoice.invoicePdfPath = `${invoice.id}-invoice.pdf`;
        await fs.mkdir(uploadsDir, { recursive: true });
        await fs.writeFile(path.join(uploadsDir, invoice.invoicePdfPath), normalizedFile.buffer);
        await syncPdfToOracle(invoice.invoicePdfPath, normalizedFile.buffer);
        
        db.invoices.push(invoice);
        // Do not remove the source until the database checkpoint below has
        // succeeded. If a later operation fails, the loose source remains
        // available for a safe retry.
        pendingSourceDeletions.push({ id: file.id, name: file.name });
        newlyProcessedInvoiceIds.add(invoice.id);
        details.push({
          file: file.name,
          type: 'invoice',
          status: 'processed',
          targets: [{ folio: invoice.folio, client: invoice.client }],
          reason: 'Factura registrada correctamente.'
        });
        processed++;
        updateInvoiceSyncJob(job, { processed });
      }

      const { groups: imageReceivingGroups, individualReceivings } = groupConvertedReceivingImages(
        pendingReceivings,
        db.invoices,
        newlyProcessedInvoiceIds
      );
      const receivingPlans = [];

      for (const group of imageReceivingGroups) {
        const { invoice, candidates } = group;
        const sourceFiles = candidates.map(candidate => candidate.file);
        receivingPlans.push({
          file: { id: sourceFiles[0].id, name: `Merged-${invoice.folio}-receiving.pdf` },
          sourceFiles,
          buffer: await mergeReceivingPdfBuffers(candidates.map(candidate => candidate.buffer)),
          receivingInvoices: [invoice],
          appendToExisting: shouldAppendMatchedReceiving([invoice]),
          combinedImages: true,
          sourceNames: sourceFiles.map(source => source.name)
        });
      }

      for (const pendingReceiving of individualReceivings) {
        const { file, buffer, allReceivingInvoices, receivingInvoices } = pendingReceiving;
        const explicitMultiInvoices = findExplicitMultiReceivingInvoices(file.name, allReceivingInvoices);
        const targetInvoices = explicitMultiInvoices.length ? explicitMultiInvoices : receivingInvoices;
        const receivingFile = pendingReceiving.convertedFromImage
          ? { ...file, name: pendingReceiving.convertedName }
          : file;
        if (!targetInvoices.length) {
          issues.push({ file: file.name, status: 'missing', reason: 'No se detectó una factura válida y el nombre del PDF no coincide con ninguna factura registrada.' });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
          continue;
        }
        if (!explicitMultiInvoices.length && !newlyProcessedInvoiceIds.has(targetInvoices[0]?.id) && allReceivingInvoices.length > 1) {
          issues.push({
            file: file.name,
            status: 'warning',
            reason: 'El nombre coincide con varias facturas existentes y no hay una factura nueva que permita identificarla con certeza. No se subió.',
            replacement: {
              kind: 'receiving',
              sourceFileId: file.id,
              invoiceIds: allReceivingInvoices.map(invoice => invoice.id),
              invoiceOptions: allReceivingInvoices.map(invoice => ({ id: invoice.id, folio: invoice.folio, client: invoice.client }))
            }
          });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
          continue;
        }
        receivingPlans.push({
          file: receivingFile,
          sourceFiles: [file],
          buffer,
          receivingInvoices: targetInvoices,
          appendToExisting: shouldAppendMatchedReceiving(targetInvoices),
          combinedImages: false,
          sourceNames: [file.name]
        });
      }

      for (const receivingPlan of receivingPlans) {
        try {
          const receivingResult = await attachReceivingToInvoices({
            invoices: receivingPlan.receivingInvoices,
            file: receivingPlan.file,
            buffer: receivingPlan.buffer,
            db,
            appendToExisting: receivingPlan.appendToExisting,
            sourceFiles: receivingPlan.sourceFiles
          });
          const targets = receivingPlan.receivingInvoices.map(invoice => ({ folio: invoice.folio, client: invoice.client }));
          if (receivingResult.duplicate) {
            details.push({ file: receivingPlan.file.name, type: 'receiving', status: 'duplicate', targets, reason: receivingResult.reason });
            issues.push({ file: receivingPlan.file.name, status: 'duplicate', reason: receivingResult.reason });
            skipped++;
            updateInvoiceSyncJob(job, { skipped });
            continue;
          }
          const linkedTargets = receivingResult.linkedInvoices.map(invoice => ({ folio: invoice.folio, client: invoice.client }));
          const reason = receivingPlan.combinedImages
            ? `${receivingPlan.sourceNames.length} imágenes fueron unidas en un solo PDF y asociadas correctamente.`
            : (receivingResult.appendedInvoices?.length
              ? 'Recibimiento compartido anexado al PDF existente de cada factura coincidente.'
              : (receivingPlan.sourceFiles[0].name !== receivingPlan.file.name
                ? 'Imagen convertida a PDF y recibimiento asociado correctamente.'
                : 'Recibimiento asociado correctamente.'));
          details.push({ file: receivingPlan.file.name, type: 'receiving', status: 'linked', targets: linkedTargets, reason });
          for (const sourceFile of receivingPlan.sourceFiles) {
            await graphRequest(`/drives/${driveId}/items/${sourceFile.id}`, { method: 'DELETE' })
              .catch(error => issues.push({ file: sourceFile.name, status: 'warning', reason: `Recibimiento asociado, pero no se pudo retirar el original: ${error.message}` }));
          }
          processed++;
          updateInvoiceSyncJob(job, { processed });
        } catch (error) {
          issues.push({ file: receivingPlan.file.name, status: 'error', reason: `No se pudo asociar el recibimiento: ${error.message}` });
          skipped++;
          updateInvoiceSyncJob(job, { skipped });
        }
      }
      
      if (processed > 0) {
        await writeDb(db);
      }

      for (const sourceFile of pendingSourceDeletions) {
        await graphRequest(`/drives/${driveId}/items/${sourceFile.id}`, { method: 'DELETE' })
          .catch(error => issues.push({ file: sourceFile.name, status: 'warning', reason: `Factura registrada, pero no se pudo retirar el original: ${error.message}` }));
      }
      
      res.json({ message: `Sincronización completada. ${processed} procesadas, ${skipped} ignoradas.`, processed, skipped, issues, details });
    } catch (error) { next(error); }
  });
  
  app.post('/api/credits/sync', authenticate, adminOnly, async (req, res, next) => {
  try {
    if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
    const { driveId } = await getSharePointDrive();
    const root = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
    const creditFolder = await getOrCreateFolder(driveId, root.id, 'Credit');
    const filesRes = await graphRequest(`/drives/${driveId}/items/${creditFolder.id}/children`);
    const files = (filesRes?.value || []).filter(f => !f.folder);
    
    let processed = 0;
    let skipped = 0;
    const issues = [];
    const details = [];
    const db = await readDb();

    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf')) continue;
      if (!file['@microsoft.graph.downloadUrl']) { issues.push({ file: file.name, status: 'error', reason: 'No se pudo obtener el enlace de descarga.' }); skipped++; continue; }
      
      const response = await fetch(file['@microsoft.graph.downloadUrl']);
      if (!response.ok) { issues.push({ file: file.name, status: 'error', reason: `Descarga fallida (${response.status}).` }); skipped++; continue; }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      const extracted = await extractCreditPdf(buffer);
      console.log(`[SYNC] Extracted from ${file.name}: PO=${extracted.poNumber}, Guide=${extracted.guideNumber}, Amount=${extracted.amount}, Credit=${extracted.creditNumber}`);
      if ((!extracted.poNumber && !extracted.guideNumber) || extracted.amount <= 0) {
        console.log(`[SYNC] Skipped ${file.name}: Missing PO/Guide or Amount <= 0`);
        issues.push({ file: file.name, status: 'warning', reason: 'Falta PO o el importe no es válido.' });
        skipped++;
        continue;
      }

      const poTarget = normalizeReference(extracted.poNumber);
      const guideTarget = normalizeReference(extracted.guideNumber);
      const referenceTargets = [poTarget, guideTarget].filter(Boolean);
      const extractedCustomerKey = normalizeClientKey(extracted.client);
      const matchingInvoices = db.invoices.filter(inv => {
        const references = [inv.poNumber, inv.guideNumber, inv.folio, inv.invoiceFileName]
          .map(normalizeReference)
          .filter(Boolean);
        return referenceTargets.some(target => references.some(reference => reference === target || reference.includes(target)));
      });
      const customerMatches = matchingInvoices.filter(inv => extractedCustomerKey && normalizeClientKey(inv.client) === extractedCustomerKey);
      const candidateInvoices = customerMatches.length ? customerMatches : matchingInvoices;
      if (candidateInvoices.length > 1) {
        const invoiceOptions = candidateInvoices.map(candidate => ({
          id: candidate.id,
          folio: candidate.folio,
          client: candidate.client,
          balance: Number(candidate.balance || 0)
        }));
        issues.push({
          file: file.name,
          po: extracted.poNumber,
          guide: extracted.guideNumber,
          credit: extracted.creditNumber,
          amount: extracted.amount,
          status: 'warning',
          reason: `El PO ${extracted.poNumber || extracted.guideNumber} coincide con varias facturas. Selecciona la factura correcta para aplicar el crédito.`,
          creditAssignment: {
            sourceFileId: file.id,
            creditNumber: extracted.creditNumber,
            amount: Number(extracted.amount),
            customer: extracted.client || '',
            invoiceOptions
          }
        });
        skipped++;
        continue;
      }
      const invoice = candidateInvoices[0];

      if (!invoice) {
        const referenceLabel = extracted.poNumber || extracted.guideNumber;
        console.log(`[SYNC] Skipped ${file.name}: No matching invoice for PO/Guide ${referenceLabel}`);
        issues.push({ file: file.name, po: extracted.poNumber, guide: extracted.guideNumber, credit: extracted.creditNumber, amount: extracted.amount, status: 'missing', reason: `No se encontró una factura relacionada con el PO o guía ${referenceLabel}.` });
        skipped++;
        continue; // No matching invoice
      }
      
      const invoiceCustomerKey = normalizeClientKey(invoice.client);
      const customerKey = extractedCustomerKey && extractedCustomerKey === invoiceCustomerKey
        ? extractedCustomerKey
        : invoiceCustomerKey;
      const existingCreditRecords = extracted.creditNumber
        ? db.invoices.flatMap(candidate => normalizeClientKey(candidate.client) === customerKey
          ? (candidate.credits || []).filter(credit => credit.creditNumber === extracted.creditNumber)
          : [])
        : [];
      const existingCreditAmount = existingCreditRecords
        .filter(credit => !credit.documentOnly)
        .reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
      const existingCreditDocument = existingCreditRecords.find(credit => credit.creditPdfPath || credit.creditSharePointUrl);
      const remainingCreditAmount = Math.max(0, Number(extracted.amount) - existingCreditAmount);
      if (remainingCreditAmount < 0.01) {
        console.log(`[SYNC] Skipped ${file.name}: Credit ${extracted.creditNumber} already fully allocated`);
        const duplicateOptions = db.invoices
          .filter(candidate => normalizeClientKey(candidate.client) === customerKey && Number(candidate.balance) > 0)
          .map(candidate => ({ id: candidate.id, folio: candidate.folio, client: candidate.client, balance: Number(candidate.balance) }));
        issues.push({
          file: file.name,
          po: extracted.poNumber,
          credit: extracted.creditNumber,
          amount: extracted.amount,
          status: 'duplicate',
          reason: `El crédito ${extracted.creditNumber} ya fue aplicado por completo y no se volvió a descontar.`,
          creditAction: {
            sourceFileId: file.id,
            creditNumber: extracted.creditNumber,
            amount: Number(extracted.amount),
            customer: extracted.client || invoice.client,
            invoiceOptions: duplicateOptions
          }
        });
        skipped++;
        continue;
      }

      const availableBalance = candidate => {
        const previousCredits = (candidate.credits || [])
          .filter(credit => !credit.documentOnly)
          .reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
        const amount = Math.max(0, Number(candidate.amount || 0));
        if (candidate.status === 'Pagada') return 0;
        const maximumBeforeCredit = Math.max(0, amount - previousCredits);
        const declaredBalance = Number(candidate.balance);
        return Number.isFinite(declaredBalance)
          ? Math.min(Math.max(0, declaredBalance), maximumBeforeCredit)
          : maximumBeforeCredit;
      };
      const useGalleriaOldestBalanceRule = isGalleriaClient(invoice.client);
      const allocationCandidates = buildCreditAllocationCandidates({
        invoices: db.invoices,
        matchedInvoice: invoice,
        customerKey,
        normalizeClientKey,
        availableBalance,
        useOldestUnflaggedRule: useGalleriaOldestBalanceRule
      });
      let remainingAmount = remainingCreditAmount;
      const allocations = [];
      for (const candidate of allocationCandidates) {
        const allocation = Math.min(remainingAmount, availableBalance(candidate));
        if (allocation <= 0) continue;
        allocations.push({ invoice: candidate, amount: allocation });
        remainingAmount = Math.max(0, remainingAmount - allocation);
        if (remainingAmount < 0.01) break;
      }
      if (remainingAmount >= 0.01) {
        issues.push({ file: file.name, po: extracted.poNumber, credit: extracted.creditNumber, amount: extracted.amount, status: 'warning', reason: `No hay saldo suficiente en ${extracted.client || invoice.client} para distribuir el crédito completo. Quedaron ${remainingAmount.toFixed(2)} sin aplicar.` });
        skipped++;
        continue;
      }

      let movedFile = null;
      let creditPdfPath = existingCreditDocument?.creditPdfPath || '';
      let creditSharePointUrl = existingCreditDocument?.creditSharePointUrl || '';
      if (!existingCreditDocument) {
        const storage = invoice.sharePointStorage || invoice;
        const clientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(sharePointClientFolderName(storage.client)));
        const locationFolder = storage.location
          ? await getOrCreateFolder(driveId, clientFolder.id, safeFolderName(storage.location))
          : clientFolder;
        const dateFolder = await getOrCreateFolder(driveId, locationFolder.id, storage.issued);

        const finalName = `Credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`;
        movedFile = await graphRequest(`/drives/${driveId}/items/${file.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parentReference: { id: dateFolder.id },
            name: finalName
          })
        });

        await fs.mkdir(uploadsDir, { recursive: true });
        creditPdfPath = `${invoice.id}-credit-${Date.now()}.pdf`;
        await fs.writeFile(path.join(uploadsDir, creditPdfPath), buffer);
        await syncPdfToOracle(creditPdfPath, buffer);
        creditSharePointUrl = movedFile?.webUrl || '';
      }

      const processedAt = new Date().toISOString();
      for (const allocation of allocations) {
        const target = allocation.invoice;
        const currentBalance = availableBalance(target);
        const previousCreditAmount = (target.credits || [])
          .filter(credit => !credit.documentOnly)
          .reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
        target.creditAmount = previousCreditAmount + allocation.amount;
        target.balance = Math.max(0, currentBalance - allocation.amount);
        if (!target.credits) target.credits = [];
        target.credits.push({
          creditNumber: extracted.creditNumber,
          amount: allocation.amount,
          guideNumber: extracted.guideNumber || '',
          allocationType: target.id === invoice.id ? 'invoice' : 'same-customer-balance',
          dateProcessed: processedAt,
          date: extracted.creditDate || '',
          creditPdfPath,
          creditSharePointUrl,
          ...(useGalleriaOldestBalanceRule ? { creditFlagTargetInvoiceId: invoice.id } : {})
        });
        if (target.balance < 0.01) { target.balance = 0; target.status = 'Pagada'; }
      }
      details.push({
        file: file.name,
        type: 'credit',
        status: 'processed',
        targets: allocations.map(allocation => ({ folio: allocation.invoice.folio, client: allocation.invoice.client, amount: allocation.amount })),
        reason: `Crédito ${extracted.creditNumber || extracted.poNumber} aplicado correctamente.`
      });
      processed++;
    }

    if (processed > 0) {
      await writeDb(db);
    }
    
    res.json({ message: `Sincronización completada. ${processed} procesados, ${skipped} ignorados.`, processed, skipped, issues, details });
  } catch (error) { next(error); }
});

  app.post('/api/credits/sync/remove', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const sourceFileId = String(req.body?.sourceFileId || '').trim();
      if (!sourceFileId) return res.status(400).json({ message: 'Falta el PDF de crédito que se eliminará.' });
      const { driveId } = await getSharePointDrive();
      const creditFolder = await getOrCreateFolder(driveId, (await getOrCreateFolder(driveId, null, sharePoint.rootFolder)).id, 'Credit');
      const sourceItem = await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!sourceItem?.name) return res.status(404).json({ message: 'El PDF de crédito ya no está disponible.' });
      if (sourceItem.parentReference?.id !== creditFolder.id) return res.status(400).json({ message: 'Solo se puede eliminar el PDF duplicado que sigue en la carpeta Credit.' });
      await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      res.json({ message: `PDF de crédito ${sourceItem.name} eliminado. El crédito ya aplicado no fue modificado.` });
    } catch (error) { next(error); }
  });

  app.post('/api/credits/sync/replace', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const sourceFileId = String(req.body?.sourceFileId || '').trim();
      const creditNumber = String(req.body?.creditNumber || '').trim();
      const customer = String(req.body?.customer || '').trim();
      if (!sourceFileId || !creditNumber) return res.status(400).json({ message: 'Faltan el PDF duplicado y el número de crédito.' });

      const db = await readDb();
      const existingRecords = findCreditRecords(db.invoices, creditNumber, customer, normalizeClientKey);
      if (!existingRecords.length) return res.status(404).json({ message: 'No se encontró un crédito aplicado para reemplazar.' });

      const { driveId } = await getSharePointDrive();
      const root = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
      const creditFolder = await getOrCreateFolder(driveId, root.id, 'Credit');
      const sourceItem = await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!sourceItem?.name || !sourceItem['@microsoft.graph.downloadUrl']) return res.status(404).json({ message: 'El PDF duplicado ya no está disponible.' });
      if (sourceItem.parentReference?.id !== creditFolder.id) return res.status(400).json({ message: 'El PDF seleccionado ya no está en la carpeta Credit.' });
      const response = await fetch(sourceItem['@microsoft.graph.downloadUrl']);
      if (!response.ok) return res.status(502).json({ message: `No se pudo descargar el PDF duplicado (${response.status}).` });
      const buffer = Buffer.from(await response.arrayBuffer());
      const extracted = await extractCreditPdf(buffer);
      if (!extracted.creditNumber || extracted.creditNumber !== creditNumber) return res.status(422).json({ message: 'El PDF no corresponde al crédito seleccionado.' });

      const primary = existingRecords.find(item => item.credit.creditPdfPath || item.credit.creditSharePointUrl) || existingRecords[0];
      const storage = primary.invoice.sharePointStorage || primary.invoice;
      const clientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(sharePointClientFolderName(storage.client)));
      const locationFolder = storage.location ? await getOrCreateFolder(driveId, clientFolder.id, safeFolderName(storage.location)) : clientFolder;
      const dateFolder = await getOrCreateFolder(driveId, locationFolder.id, storage.issued);
      const oldCreditNames = new Set();
      for (const record of existingRecords) {
        const recordStorage = record.invoice.sharePointStorage || record.invoice;
        const recordClientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(sharePointClientFolderName(recordStorage.client)));
        const recordLocationFolder = recordStorage.location ? await getOrCreateFolder(driveId, recordClientFolder.id, safeFolderName(recordStorage.location)) : recordClientFolder;
        const recordDateFolder = await getOrCreateFolder(driveId, recordLocationFolder.id, recordStorage.issued);
        const children = await graphRequest(`/drives/${driveId}/items/${recordDateFolder.id}/children`);
        for (const item of children?.value || []) {
          if (!item.folder && String(item.name).startsWith(`Credit-${creditNumber}-`)) oldCreditNames.add(`${item.id}`);
        }
      }
      for (const itemId of oldCreditNames) await graphRequest(`/drives/${driveId}/items/${itemId}`, { method: 'DELETE' }).catch(() => {});

      const replacementName = `Credit-${creditNumber}-replacement-${Date.now()}.pdf`;
      const movedFile = await uploadToSharePoint(buffer, driveId, dateFolder.id, replacementName);
      const localPath = `credit-${creditNumber}-replacement-${Date.now()}.pdf`;
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(path.join(uploadsDir, localPath), buffer);
      await syncPdfToOracle(localPath, buffer);
      const previousPaths = new Set(existingRecords.map(record => record.credit.creditPdfPath).filter(Boolean));
      for (const oldPath of previousPaths) {
        await removePdfFromOracle(oldPath).catch(() => {});
        await removeLocalFile(oldPath).catch(() => {});
      }
      for (const record of existingRecords) {
        record.credit.creditPdfPath = localPath;
        record.credit.creditSharePointUrl = movedFile?.webUrl || '';
      }
      await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      await writeDb(db);
      res.json({ message: `Crédito ${creditNumber} reemplazado. Se conservaron sus aplicaciones y balances.` });
    } catch (error) { next(error); }
  });

  app.post('/api/credits/sync/assign', authenticate, adminOnly, async (req, res, next) => {
    try {
      if (!sharePointReady()) return res.status(400).json({ message: 'SharePoint no configurado.' });
      const sourceFileId = String(req.body?.sourceFileId || '').trim();
      const invoiceId = Number(req.body?.invoiceId);
      const assignmentMode = req.body?.mode === 'document-only' ? 'document-only' : 'apply';
      if (!sourceFileId || !invoiceId) return res.status(400).json({ message: 'Selecciona el PDF y una factura destino.' });
      const db = await readDb();
      const invoice = db.invoices.find(item => Number(item.id) === invoiceId);
      if (!invoice) return res.status(404).json({ message: 'La factura destino ya no está disponible.' });
      const { driveId } = await getSharePointDrive();
      const root = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
      const creditFolder = await getOrCreateFolder(driveId, root.id, 'Credit');
      const sourceItem = await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!sourceItem?.name || !sourceItem['@microsoft.graph.downloadUrl']) return res.status(404).json({ message: 'El PDF de crédito ya no está disponible.' });
      if (sourceItem.parentReference?.id !== creditFolder.id) return res.status(400).json({ message: 'El PDF seleccionado ya no está en la carpeta Credit.' });
      const response = await fetch(sourceItem['@microsoft.graph.downloadUrl']);
      if (!response.ok) return res.status(502).json({ message: `No se pudo descargar el PDF (${response.status}).` });
      const buffer = Buffer.from(await response.arrayBuffer());
      const extracted = await extractCreditPdf(buffer);
      if ((!extracted.poNumber && !extracted.guideNumber) || extracted.amount <= 0) return res.status(422).json({ message: 'El PDF no contiene un crédito válido.' });

      if (assignmentMode === 'document-only') {
        const storage = invoice.sharePointStorage || invoice;
        const clientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(sharePointClientFolderName(storage.client)));
        const locationFolder = storage.location
          ? await getOrCreateFolder(driveId, clientFolder.id, safeFolderName(storage.location))
          : clientFolder;
        const dateFolder = await getOrCreateFolder(driveId, locationFolder.id, storage.issued);
        const movedFile = await uploadToSharePoint(buffer, driveId, dateFolder.id, `Credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`);
        const localPath = `credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`;
        await fs.mkdir(uploadsDir, { recursive: true });
        await fs.writeFile(path.join(uploadsDir, localPath), buffer);
        await syncPdfToOracle(localPath, buffer);
        if (!invoice.credits) invoice.credits = [];
        invoice.credits.push({
          creditNumber: extracted.creditNumber,
          // Keep the full credit value in the report even when the PDF is
          // attached without applying it to the invoice balance.
          amount: Number(extracted.amount),
          documentOnly: true,
          guideNumber: extracted.guideNumber || '',
          allocationType: 'document-only',
          dateProcessed: new Date().toISOString(),
          date: extracted.creditDate || '',
          creditPdfPath: localPath,
          creditSharePointUrl: movedFile?.webUrl || ''
        });
        await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
        await writeDb(db);
        return res.json({ message: `PDF del crédito ${extracted.creditNumber || extracted.poNumber} asociado a la factura ${invoice.folio} sin modificar el balance.` });
      }

      const customerKey = normalizeClientKey(invoice.client);
      const availableBalance = candidate => {
        const previousCredits = (candidate.credits || [])
          .filter(credit => !credit.documentOnly)
          .reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
        const amount = Math.max(0, Number(candidate.amount || 0));
        if (candidate.status === 'Pagada') return 0;
        const declaredBalance = Number(candidate.balance);
        const maximumBeforeCredit = Math.max(0, amount - previousCredits);
        return Number.isFinite(declaredBalance) ? Math.min(Math.max(0, declaredBalance), maximumBeforeCredit) : maximumBeforeCredit;
      };
      const useGalleriaOldestBalanceRule = isGalleriaClient(invoice.client);
      const allocationCandidates = buildCreditAllocationCandidates({
        invoices: db.invoices,
        matchedInvoice: invoice,
        customerKey,
        normalizeClientKey,
        availableBalance,
        useOldestUnflaggedRule: useGalleriaOldestBalanceRule
      });
      let remaining = Number(extracted.amount);
      const allocations = [];
      for (const candidate of allocationCandidates) {
        const amount = Math.min(remaining, availableBalance(candidate));
        if (amount <= 0) continue;
        allocations.push({ invoice: candidate, amount });
        remaining = Math.max(0, remaining - amount);
        if (remaining < 0.01) break;
      }
      if (remaining >= 0.01) return res.status(409).json({ message: `No hay saldo suficiente para aplicar el crédito completo. Faltan $${remaining.toFixed(2)}.` });
      const storage = invoice.sharePointStorage || invoice;
      const clientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(sharePointClientFolderName(storage.client)));
      const locationFolder = storage.location ? await getOrCreateFolder(driveId, clientFolder.id, safeFolderName(storage.location)) : clientFolder;
      const dateFolder = await getOrCreateFolder(driveId, locationFolder.id, storage.issued);
      const movedFile = await uploadToSharePoint(buffer, driveId, dateFolder.id, `Credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`);
      const localPath = `credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`;
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(path.join(uploadsDir, localPath), buffer);
      await syncPdfToOracle(localPath, buffer);
      const processedAt = new Date().toISOString();
      for (const allocation of allocations) {
        const target = allocation.invoice;
        const previousCreditAmount = (target.credits || [])
          .filter(credit => !credit.documentOnly)
          .reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
        target.creditAmount = previousCreditAmount + allocation.amount;
        target.balance = Math.max(0, availableBalance(target) - allocation.amount);
        if (!target.credits) target.credits = [];
        target.credits.push({ creditNumber: extracted.creditNumber, amount: allocation.amount, guideNumber: extracted.guideNumber || '', allocationType: target.id === invoice.id ? 'invoice' : 'same-customer-balance', dateProcessed: processedAt, date: extracted.creditDate || '', creditPdfPath: localPath, creditSharePointUrl: movedFile?.webUrl || '', ...(useGalleriaOldestBalanceRule ? { creditFlagTargetInvoiceId: invoice.id } : {}) });
        if (target.balance < 0.01) { target.balance = 0; target.status = 'Pagada'; }
      }
      await graphRequest(`/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      await writeDb(db);
      res.json({ message: `Crédito ${extracted.creditNumber || extracted.poNumber} asignado a ${allocations.length} factura(s).` });
    } catch (error) { next(error); }
  });

app.post('/api/invoices/sync-statement', authenticate, adminOnly, upload.single('statementFile'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Selecciona el archivo de Estado de Cuenta (Excel).' });
    
    const xlsx = await import('xlsx');
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames.find(s => s.toUpperCase() === 'INVOICE');
    if (!sheetName) return res.status(400).json({ message: 'El archivo no contiene la pestaña INVOICE.' });
    
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    
    let headersRowIndex = -1;
    for (let i = 0; i < Math.min(20, data.length); i++) {
      const rowStr = (data[i] || []).join(' ').toLowerCase();
      if (rowStr.includes('date') && rowStr.includes('po') && rowStr.includes('invoice')) {
        headersRowIndex = i;
        break;
      }
    }
    
    if (headersRowIndex === -1) return res.status(400).json({ message: 'No se encontraron los encabezados (Date, PO, Invoice) en la hoja INVOICE.' });
    
    const parseStatementAmount = value => {
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
      const parsed = Number(String(value ?? '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const statementRows = [];
    for (let i = headersRowIndex + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;
      
      const poNum = String(row[1] || '').trim(); // Col B
      const invNum = String(row[2] || '').trim(); // Col C
      
      if (!poNum && !invNum) continue;
      
      const val1 = parseStatementAmount(row[3]); // Col D
      const val2 = parseStatementAmount(row[4]); // Col E
      const val3 = parseStatementAmount(row[5]); // Col F
      const val4 = parseStatementAmount(row[6]); // Col G
      const balance = val1 + val2 + val3 + val4;
      
      statementRows.push({
        po: poNum,
        invoice: invNum,
        date: normalizeExcelDate(row[0]),
        balance,
        sourceRow: i + 1
      });
    }
    
    const db = await readDb();
    let updatedBalances = 0;
    let markedPaid = 0;
    const issues = [];
    const paidCutoff = new Date('2026-07-31T23:59:59Z');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const matching = matchStatementRows(db.invoices, statementRows);
    const matchByInvoiceIndex = new Map(matching.matches.map(match => [match.invoiceIndex, match]));
    const snapshotEntries = [];

    for (let invoiceIndex = 0; invoiceIndex < db.invoices.length; invoiceIndex++) {
      const dbInv = db.invoices[invoiceIndex];
      const assignment = matchByInvoiceIndex.get(invoiceIndex);

      if (assignment) {
        const statementRow = statementRows[assignment.rowIndex];
        dbInv.balance = statementRow.balance;
        if (statementRow.balance <= 0.01) {
          dbInv.status = 'Pagada';
        } else if (dbInv.due && new Date(`${dbInv.due}T23:59:59`) < today) {
          dbInv.status = 'Vencida';
        } else {
          dbInv.status = 'Pendiente';
        }
        updatedBalances++;
        snapshotEntries.push({
          systemInvoiceId: dbInv.id,
          folio: dbInv.folio,
          po: dbInv.poNumber || '',
          balance: statementRow.balance,
          found: true,
          matchMethod: assignment.method,
          sourceRow: statementRow.sourceRow,
          date: statementRow.date,
          statementInvoice: statementRow.invoice,
          statementPo: statementRow.po
        });
      } else {
        issues.push({ invoice: dbInv.folio, po: dbInv.poNumber || '', status: 'missing', reason: 'La factura no fue encontrada en el Estado de Cuenta cargado.' });
        const invDate = new Date(dbInv.issued);
        const isHistoricalMissing = !Number.isNaN(invDate.getTime()) && invDate <= paidCutoff;
        if (isHistoricalMissing) {
          if (dbInv.status !== 'Pagada') {
            dbInv.status = 'Pagada';
            markedPaid++;
          }
          dbInv.balance = 0;
        } else {
          if (dbInv.balance === undefined) {
            dbInv.balance = dbInv.amount;
          }
        }
        snapshotEntries.push({
          systemInvoiceId: dbInv.id,
          folio: dbInv.folio,
          po: dbInv.poNumber || '',
          balance: isHistoricalMissing ? 0 : null,
          found: false,
          matchMethod: null,
          sourceRow: null,
          statementInvoice: '',
          statementPo: ''
        });
      }
    }

    const unmatchedStatementRows = matching.unmatchedRowIndexes.map(rowIndex => statementRows[rowIndex]);
    for (const row of unmatchedStatementRows) {
      issues.push({
        invoice: row.invoice,
        po: row.po,
        status: 'unmatched-statement-row',
        reason: `La fila ${row.sourceRow} del Estado de Cuenta no tiene una coincidencia única en el sistema.`
      });
    }

    await writeDb(db);
    await writeStatementSnapshot({
      source: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      entries: snapshotEntries,
      unmatchedRows: unmatchedStatementRows
    });
    res.json({
      message: `Sincronización completada. ${updatedBalances} saldos actualizados, ${markedPaid} facturas marcadas como Pagadas.`,
      updatedBalances,
      markedPaid,
      unmatchedStatementRows: unmatchedStatementRows.length,
      issues
    });
  } catch (error) { next(error); }
});

app.delete('/api/invoices/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const index = db.invoices.findIndex(item => item.id === Number(req.params.id));
    if (index < 0) return res.status(404).json({ message: 'Factura no encontrada.' });
    const invoice = db.invoices[index];
    const storage = invoice.sharePointStorage || invoice;
    await deleteSharePointFile({ client: storage.client, location: storage.location, issued: storage.issued, folio: storage.folio, type: 'invoice' });
    if (invoice.receivingSharePointUrl || invoice.receivingFileName || invoice.receivingPdfPath) await deleteSharePointFile({ client: storage.client, location: storage.location, issued: storage.issued, folio: storage.folio, type: 'receiving' });
    await removePdfFromOracle(invoicePdfObjectName(invoice, 'invoice'));
    if (invoice.receivingSharePointUrl || invoice.receivingFileName || invoice.receivingPdfPath) await removePdfFromOracle(invoicePdfObjectName(invoice, 'receiving'));
    await removeLocalFile(invoice.invoicePdfPath);
    await removeLocalFile(invoice.receivingPdfPath);
    db.invoices.splice(index, 1);
    await writeDb(db);
    res.status(204).send();
  } catch (error) { next(error); }
});

// Local production preview: serve the exact bundle downloaded from Oracle while
// retaining this local API and its local data copy. It is opt-in so the Oracle
// deployment continues to be served exclusively by nginx.
const localDistDirectory = path.join(__dirname, '..', 'dist', 'facturacion-clientes');
const localDistIndexFile = path.join(localDistDirectory, 'index.html');
if (process.env.SERVE_LOCAL_DIST === 'true') {
  app.use(express.static(localDistDirectory));
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    try {
      await fs.access(localDistIndexFile);
      return res.sendFile(localDistIndexFile);
    } catch {
      return next();
    }
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (process.env.NODE_ENV !== 'production') return res.status(500).json({ message: error?.message || 'Error interno del servidor.' });
  res.status(500).json({ message: 'Ocurrió un error interno en el servidor.' });
});

await seedDatabase();
await readDb();
app.listen(PORT, () => console.log(`API de Factura Clara activa en http://localhost:${PORT}`));
