import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'database.json');
const uploadsDir = path.join(dataDir, 'uploads');
const reconciliationWorkbook = path.join(__dirname, '..', 'consolidacion.xlsx');
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
let graphToken = { value: '', expiresAt: 0 };

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:4200' }));
app.use(express.json({ limit: '1mb' }));

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

function normalizeClientKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeFolio(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

function normalizeReference(value) {
  return normalizeFolio(String(value ?? '').replace(/\s+/g, ''));
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
  const db = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  let changed = false;
  for (const user of db.users || []) {
    if (user.role === 'client' && !user.clientKey) { user.clientKey = normalizeClientKey(user.name); changed = true; }
  }
  for (const invoice of db.invoices || []) {
    if (!invoice.clientKey) { invoice.clientKey = normalizeClientKey(invoice.client); changed = true; }
  }
  if (changed) await writeDb(db);
  return db;
}
async function writeDb(data) {
  const temp = `${dataFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, dataFile);
}

function sharePointReady() {
  return Boolean(sharePoint.tenantId && sharePoint.clientId && sharePoint.clientSecret);
}

async function graphAccessToken() {
  if (graphToken.value && graphToken.expiresAt > Date.now() + 60_000) return graphToken.value;
  if (!sharePointReady()) throw new Error('Faltan las variables de conexión de SharePoint en el archivo .env.');
  const body = new URLSearchParams({ client_id: sharePoint.clientId, client_secret: sharePoint.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const response = await fetch(`https://login.microsoftonline.com/${sharePoint.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'No fue posible autenticar con Microsoft Graph.');
  graphToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return graphToken.value;
}

async function graphRequest(endpoint, options = {}) {
  const token = await graphAccessToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Microsoft Graph respondió ${response.status}.`);
  return data;
}

async function getSharePointDrive() {
  const site = await graphRequest(`/sites/${sharePoint.hostname}:${sharePoint.personalSitePath}`);
  if (!site?.id) throw new Error('No se encontró el sitio personal de SharePoint configurado.');
  const drive = await graphRequest(`/sites/${site.id}/drive`);
  if (!drive?.id) throw new Error('No se encontró la biblioteca de documentos de SharePoint.');
  return { siteId: site.id, driveId: drive.id };
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

async function uploadToSharePoint(buffer, driveId, parentId, fileName) {
  const session = await graphRequest(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(fileName)}:/createUploadSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } }) });
  const response = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(buffer.length), 'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}` }, body: buffer });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `No se pudo subir ${fileName} a SharePoint.`);
  return data;
}

function safeFolderName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100) || 'Sin cliente';
}

async function uploadInvoiceFilesToSharePoint({ client, location, issued, folio, invoiceFile, receivingFile }) {
  if (!invoiceFile && !receivingFile) return {};
  const { driveId } = await getSharePointDrive();
  const root = await getOrCreateFolder(driveId, null, sharePoint.rootFolder);
  const clientFolder = await getOrCreateFolder(driveId, root.id, safeFolderName(client));
  const locationFolder = location
    ? await getOrCreateFolder(driveId, clientFolder.id, safeFolderName(location))
    : clientFolder;
  const dateFolder = await getOrCreateFolder(driveId, locationFolder.id, issued);
  const result = {};
  if (invoiceFile) result.invoice = await uploadToSharePoint(invoiceFile.buffer, driveId, dateFolder.id, `Invoice-${folio}.pdf`);
  if (receivingFile) result.receiving = await uploadToSharePoint(receivingFile.buffer, driveId, dateFolder.id, `Receiving-${folio}.pdf`);
  return result;
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
  const segments = [sharePoint.rootFolder, safeFolderName(client)];
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

function addOneMonth(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
}

async function extractInvoicePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  const text = (await parser.getText()).text.replace(/\u00a0/g, ' ');
  await parser.destroy();
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
  const pacificaClient = pacificaClientAfterCarrierMatch?.[1]
    || pacificaClientMatch?.[1]
    || (pacificaClientBeforeShipMatch?.[1] && !/^\s*[\d(]/.test(pacificaClientBeforeShipMatch[1])
      ? pacificaClientBeforeShipMatch[1]
      : '');

  // Este formato debe usar PO Date antes de cualquier detector genérico de fechas.
  const issued = fontanaIssued || oldDateMatch?.[1] || newIssued || pacificaIssued;
  const folio = oldNumberMatch?.[1] || newNumberMatch?.[1] || pacificaInvoiceMatch?.[1] || originInvoiceMatch?.[1] || pacificaWInvoiceMatch?.[1] || fontanaNumberMatch?.[1] || '';
  const rawClient = oldClientMatch?.[1] || newClientAfterTotalMatch?.[1] || newClientMatch?.[1] || pacificaClient || fontanaClientMatch?.[1] || '';
  const totalValue = oldTotalMatch?.[1] || newTotalMatch?.[1] || totalDollarsPrefixMatch?.[1] || pacificaTotalMatch?.[1] || pacificaTopAmountMatch?.[1] || labeledTotalMatch?.[1] || fontanaTotalMatch?.[1] || '';
  const poCandidates = [
    standalonePoMatch?.[1],
    splitPoMatch ? `${splitPoMatch[1]}${splitPoMatch[2]}` : '',
    oldPoMatch?.[1],
    newPoMatch?.[1],
    pacificaPoMatch?.[1],
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
  const location = fontanaLocationMatch?.[1]?.replace(/\s+XDOCK\b.*$/i, '').trim() || '';
  return {
    folio,
    client,
    issued,
    due: addOneMonth(issued),
    amount: Number(totalValue.replace(/,/g, '')),
    poNumber,
    location,
    concept: 'Invoice importado desde PDF'
  };
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Sesión requerida.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ message: 'La sesión expiró. Ingresa nuevamente.' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Acceso exclusivo para administradores.' });
  next();
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Usuario y contraseña son obligatorios.' });
    const db = await readDb();
    const normalized = String(username).trim().toLowerCase();
    const user = db.users.find(item => item.username.toLowerCase() === normalized || item.email?.toLowerCase() === normalized);
    if (!user || user.active === false || !(await bcrypt.compare(String(password), user.passwordHash))) return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
    const profile = { id: user.id, name: user.name, role: user.role, email: user.email || undefined, clientKey: user.clientKey || undefined };
    const token = jwt.sign(profile, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: profile });
  } catch (error) { next(error); }
});

app.get('/api/invoices', authenticate, async (req, res, next) => {
  try {
    const db = await readDb();
    const invoices = req.user.role === 'admin' ? db.invoices : db.invoices.filter(item => (item.clientKey || normalizeClientKey(item.client)) === req.user.clientKey || item.email?.toLowerCase() === req.user.email?.toLowerCase());
    res.json(invoices.sort((a, b) => b.id - a.id));
  } catch (error) { next(error); }
});

app.post('/api/reconciliation/upload', authenticate, adminOnly, upload.single('excel'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Por favor selecciona un archivo de Excel.' });
    await fs.writeFile(reconciliationWorkbook, req.file.buffer);
    res.json({ message: 'Archivo cargado correctamente.' });
  } catch (error) { next(error); }
});

app.get('/api/reconciliation', authenticate, adminOnly, async (_req, res, next) => {
  try {
    try { await fs.access(reconciliationWorkbook); } catch { return res.json({ rows: [], totals: { excel: 0, found: 0, missing: 0 }, source: 'No hay archivo cargado' }); }
    const db = await readDb();
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
        return { folio: String(row.Folio ?? '').trim(), series, client: String(row['Razón Social'] ?? row['Razon Social'] ?? '').trim(), date: normalizeExcelDate(row.Fecha), total: Number(row.Total || 0), exactInvoice: systemByFolio.get(folio) || null, invoice: null };
      })
      .filter(row => row.folio);
    for (const row of preparedRows) {
      if (!row.exactInvoice) continue;
      const exact = row.exactInvoice;
      const sameReference = !row.series
        || normalizeReference(row.series) === normalizeReference(exact.poNumber)
        || normalizeReference(row.series) === normalizeReference(exact.folio);
      const sameReferenceAndAmount = reconciliationAmountMatches(exact, row) && sameReference;
      if (!reconciliationContextMatches(exact, row) && !sameReferenceAndAmount) row.exactInvoice = null;
    }
    const usedInvoiceIds = new Set();
    for (const row of preparedRows) {
      if (row.exactInvoice && !usedInvoiceIds.has(row.exactInvoice.id)) {
        row.invoice = row.exactInvoice;
        usedInvoiceIds.add(row.exactInvoice.id);
      }
    }
    // Segundo intento: folios del portal con el sufijo A que no aparece en ContPAQ.
    for (const row of preparedRows) {
      if (row.invoice || row.exactInvoice) continue;
      const candidates = (systemByFolioVariant.get(normalizeFolioVariant(row.folio)) || [])
        .filter(candidate => !usedInvoiceIds.has(candidate.id));
      const invoice = chooseReconciliationCandidate(candidates, row);
      if (invoice) {
        row.invoice = invoice;
        row.matchedBy = 'folio-variant';
        usedInvoiceIds.add(invoice.id);
      }
    }
    // Último intento: la Serie / PO de ContPAQ puede corresponder al PO del
    // portal o al folio alfanumérico del portal. El folio puede cambiar, la
    // fecha puede variar y el cliente puede venir escrito distinto; Serie/PO
    // e importe son la coincidencia principal.
    for (const row of preparedRows) {
      if (row.invoice || row.exactInvoice) continue;
      const candidates = (systemBySeries.get(normalizeReference(row.series)) || [])
        .filter(candidate => !usedInvoiceIds.has(candidate.id));
      const invoice = chooseReconciliationCandidate(candidates, row);
      if (invoice) {
        row.invoice = invoice;
        row.matchedBy = normalizeReference(invoice.folio) === normalizeReference(row.series) ? 'series' : 'po';
        usedInvoiceIds.add(invoice.id);
      }
    }
    const contpaqRows = preparedRows.map(row => ({
      folio: row.folio,
      series: row.series,
      client: row.client,
      date: row.date,
      total: row.total,
      inContPaq: true,
      inSystem: Boolean(row.invoice),
      sourceStatus: row.invoice ? 'both' : 'contpaq',
      existsInSystem: Boolean(row.invoice),
      matchedBy: row.invoice ? (row.exactInvoice ? 'folio' : row.matchedBy || 'po') : null,
      systemInvoiceId: row.invoice?.id || null
    }));
    const systemOnlyRows = db.invoices
      .filter(invoice => !usedInvoiceIds.has(invoice.id))
      .map(invoice => ({
        folio: invoice.folio,
        series: invoice.poNumber || '',
        client: invoice.client,
        date: invoice.issued,
        total: Number(invoice.amount || 0),
        inContPaq: false,
        inSystem: true,
        sourceStatus: 'system',
        existsInSystem: true,
        matchedBy: null,
        systemInvoiceId: invoice.id
      }));
    const rows = [...contpaqRows, ...systemOnlyRows];
    res.json({
      source: path.basename(reconciliationWorkbook),
      rows,
      totals: {
        excel: contpaqRows.length,
        found: contpaqRows.filter(row => row.sourceStatus === 'both').length,
        missing: contpaqRows.filter(row => row.sourceStatus === 'contpaq').length,
        system: db.invoices.length,
        both: rows.filter(row => row.sourceStatus === 'both').length,
        contpaqOnly: rows.filter(row => row.sourceStatus === 'contpaq').length,
        systemOnly: rows.filter(row => row.sourceStatus === 'system').length
      }
    });
  } catch (error) { next(error); }
});

app.get('/api/users', authenticate, adminOnly, async (_req, res, next) => {
  try {
    const db = await readDb();
    const users = db.users.filter(user => user.role === 'client').map(({ passwordHash, ...user }) => ({ ...user, active: user.active !== false }));
    res.json(users.sort((a, b) => b.id - a.id));
  } catch (error) { next(error); }
});

app.post('/api/users', authenticate, adminOnly, async (req, res, next) => {
  try {
    const { name, username, email, password } = req.body;
    if (!name || !username || !email || !password) return res.status(400).json({ message: 'Nombre, usuario, correo y contraseña son obligatorios.' });
    if (String(password).length < 8) return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres.' });
    const db = await readDb();
    const normalizedUsername = String(username).trim().toLowerCase();
    const normalizedEmail = String(email).trim().toLowerCase();
    if (db.users.some(user => user.username.toLowerCase() === normalizedUsername)) return res.status(409).json({ message: 'Ese nombre de usuario ya está registrado.' });
    if (db.users.some(user => user.email?.toLowerCase() === normalizedEmail)) return res.status(409).json({ message: 'Ese correo ya está registrado.' });
    const user = { id: Date.now(), name: String(name).trim(), clientKey: normalizeClientKey(name), username: String(username).trim(), email: normalizedEmail, role: 'client', active: true, createdAt: new Date().toISOString(), passwordHash: await bcrypt.hash(String(password), 12) };
    db.users.push(user);
    await writeDb(db);
    const { passwordHash, ...safeUser } = user;
    res.status(201).json(safeUser);
  } catch (error) { next(error); }
});

app.patch('/api/users/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const user = db.users.find(item => item.id === Number(req.params.id) && item.role === 'client');
    if (!user) return res.status(404).json({ message: 'Cliente no encontrado.' });
    const { name, username, email, active, password } = req.body;
    const normalizedUsername = username ? String(username).trim().toLowerCase() : user.username.toLowerCase();
    const normalizedEmail = email ? String(email).trim().toLowerCase() : user.email;
    if (db.users.some(item => item.id !== user.id && item.username.toLowerCase() === normalizedUsername)) return res.status(409).json({ message: 'Ese nombre de usuario ya está registrado.' });
    if (db.users.some(item => item.id !== user.id && item.email?.toLowerCase() === normalizedEmail)) return res.status(409).json({ message: 'Ese correo ya está registrado.' });
    if (password && String(password).length < 8) return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres.' });
    if (name) { user.name = String(name).trim(); user.clientKey = normalizeClientKey(name); }
    if (username) user.username = String(username).trim();
    if (email) user.email = normalizedEmail;
    if (typeof active === 'boolean') user.active = active;
    if (password) user.passwordHash = await bcrypt.hash(String(password), 12);
    await writeDb(db);
    const { passwordHash, ...safeUser } = user;
    res.json({ ...safeUser, active: safeUser.active !== false });
  } catch (error) { next(error); }
});

app.delete('/api/users/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const db = await readDb();
    const index = db.users.findIndex(item => item.id === Number(req.params.id) && item.role === 'client');
    if (index < 0) return res.status(404).json({ message: 'Cliente no encontrado.' });
    const user = db.users[index];
    if (db.invoices.some(invoice => (invoice.clientKey || normalizeClientKey(invoice.client)) === (user.clientKey || normalizeClientKey(user.name)) || invoice.email?.toLowerCase() === user.email?.toLowerCase())) return res.status(409).json({ message: 'No puedes eliminar un contacto con facturas. Desactiva su acceso en su lugar.' });
    db.users.splice(index, 1);
    await writeDb(db);
    res.status(204).send();
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
    const receivingFile = req.files?.receivingPdf?.[0];
    const extracted = invoiceFile ? await extractInvoicePdf(invoiceFile.buffer) : {};
    // Los cambios hechos manualmente en el formulario tienen prioridad sobre el PDF.
    const { folio, poNumber, client, location, email, concept, issued, due, amount, status = 'Pendiente' } = { ...extracted, ...req.body };
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
    const invoice = { id, folio: String(folio || `FAC-${new Date().getFullYear()}-${String(next).padStart(4, '0')}`).trim(), poNumber: String(poNumber || '').trim(), client: String(client).trim(), location: String(location || '').trim(), clientKey: normalizeClientKey(client), email: String(email).trim().toLowerCase(), concept: String(concept).trim(), issued, due, amount: parsedAmount, status, invoiceFileName: invoiceFile?.originalname || '', receivingFileName: receivingFile?.originalname || '', invoicePdfPath, receivingPdfPath, invoiceSharePointUrl: sharePointFiles.invoice?.webUrl || '', receivingSharePointUrl: sharePointFiles.receiving?.webUrl || '' };
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
    const editableFields = ['folio', 'poNumber', 'client', 'location', 'email', 'concept', 'issued', 'due', 'amount', 'status'];
    const changes = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => editableFields.includes(key)));
    if (!invoice.sharePointStorage) invoice.sharePointStorage = { client: invoice.client, location: invoice.location || '', issued: invoice.issued, folio: invoice.folio };
    if (changes.client !== undefined && !String(changes.client).trim()) return res.status(400).json({ message: 'El nombre del cliente es obligatorio.' });
    if (changes.email !== undefined && !String(changes.email).trim()) return res.status(400).json({ message: 'El correo electrÃ³nico es obligatorio.' });
    if (changes.concept !== undefined && !String(changes.concept).trim()) return res.status(400).json({ message: 'La descripciÃ³n es obligatoria.' });
    if (changes.issued !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.issued))) return res.status(400).json({ message: 'La fecha de emisiÃ³n no es vÃ¡lida.' });
    if (changes.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.due))) return res.status(400).json({ message: 'La fecha de vencimiento no es vÃ¡lida.' });
    if (changes.amount !== undefined && (!Number.isFinite(Number(changes.amount)) || Number(changes.amount) <= 0)) return res.status(400).json({ message: 'El importe debe ser mayor que cero.' });
    if (changes.folio !== undefined) invoice.folio = String(changes.folio).trim();
    if (changes.poNumber !== undefined) invoice.poNumber = String(changes.poNumber).trim();
    if (changes.client !== undefined) { invoice.client = String(changes.client).trim(); invoice.clientKey = normalizeClientKey(invoice.client); }
    if (changes.location !== undefined) invoice.location = String(changes.location).trim();
    if (changes.email !== undefined) invoice.email = String(changes.email).trim().toLowerCase();
    if (changes.concept !== undefined) invoice.concept = String(changes.concept).trim();
    if (changes.issued !== undefined) invoice.issued = String(changes.issued);
    if (changes.due !== undefined) invoice.due = String(changes.due);
    if (changes.amount !== undefined) invoice.amount = Number(changes.amount);
    if (changes.status !== undefined) invoice.status = changes.status;
    await writeDb(db);
    res.json(invoice);
  } catch (error) { next(error); }
});

app.patch('/api/invoices/:id/receiving', authenticate, adminOnly, upload.single('receivingPdf'), async (req, res, next) => {
  try {
    const receivingFile = req.file;
    if (!receivingFile) return res.status(400).json({ message: 'Selecciona el PDF de recibimiento.' });
    const db = await readDb();
    const invoice = db.invoices.find(item => item.id === Number(req.params.id));
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada.' });
    const sharePointFiles = await uploadInvoiceFilesToSharePoint({ client: invoice.client, location: invoice.location, issued: invoice.issued, folio: invoice.folio, receivingFile });
    await fs.mkdir(uploadsDir, { recursive: true });
    const receivingPdfPath = `${invoice.id}-receiving.pdf`;
    await fs.writeFile(path.join(uploadsDir, receivingPdfPath), receivingFile.buffer);
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
    Object.assign(invoice, {
      invoiceFileName: invoiceFile.originalname,
      invoicePdfPath,
      invoiceSharePointUrl: sharePointFiles.invoice?.webUrl || invoice.invoiceSharePointUrl || ''
    });
    await writeDb(db);
    res.json(invoice);
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
    await removeLocalFile(invoice.invoicePdfPath);
    await removeLocalFile(invoice.receivingPdfPath);
    db.invoices.splice(index, 1);
    await writeDb(db);
    res.status(204).send();
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (process.env.NODE_ENV !== 'production') return res.status(500).json({ message: error?.message || 'Error interno del servidor.' });
  res.status(500).json({ message: 'Ocurrió un error interno en el servidor.' });
});

await seedDatabase();
app.listen(PORT, () => console.log(`API de Factura Clara activa en http://localhost:${PORT}`));
