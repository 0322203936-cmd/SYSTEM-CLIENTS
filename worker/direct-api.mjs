import bcrypt from 'bcryptjs';
import { neon } from '@neondatabase/serverless';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import * as XLSX from 'xlsx';
import decodeHeic, { init as initHeic } from '@discourse/heic/decode';
import heicWasm from '@discourse/heic/codec/dec/heic_dec.wasm';
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode';
import jpegWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import { extractCreditPdf, extractInvoicePdf } from './invoice-parser.mjs';
import { convertHeicToJpeg } from './convertapi.mjs';
import { loadWalmexInvoices, withTimeout } from './walmex-source.mjs';
import { findCreditRecords } from '../server/credit-replacement-matcher.mjs';
import { findExplicitMultiReceivingInvoices, findReceivingInvoices } from '../server/receiving-matcher.mjs';
import { isDuplicateInvoice } from '../server/invoice-duplicate-matcher.mjs';
import { buildCreditAllocationCandidates } from '../server/credit-allocation.mjs';
import { matchStatementRows } from '../server/statement-matcher.mjs';
import { shouldSaveEmailTemplate } from '../server/email-template-save.mjs';
import { summarizeEmailTemplate } from '../server/email-template-payload.mjs';
import { publicEmailStatus } from '../server/email-status.mjs';
import { parseInvoicePagination, pageRows } from '../server/invoice-pagination.mjs';
import { projectReconciliationInvoice } from '../server/reconciliation-payload.mjs';
import { buildReconciliationSnapshot, reconciliationCache, usableReconciliationSnapshot } from '../server/reconciliation-cache.mjs';
import { selectedCreditPdfPath } from '../server/credit-pdf-selection.mjs';
import { resolveEmailLogin, historyInvoiceAccess, canSendEmailForInvoice, canSendStatementForCustomer, resolveEmailDeliveryRecipients, expandClientKeys } from '../server/email-login.mjs';
import { buildAccessRecord, summarizeActivity } from '../server/portal-activity.mjs';
import { applyCustomerCreditToInvoices, applyPendingCustomerCreditsToInvoice, attachCheckCustomerCreditHistory, checkCustomerCreditRemaining } from '../server/check-customer-credit.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SIMPLE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const reconciliationSnapshotMemory = new Map();

initHeic(heicWasm);
initJpeg(jpegWasm);

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cfbc-api': 'direct', ...headers },
  });
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function clientKey(value) {
  return String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeReference(value) {
  const text = String(value ?? '').replace(/\s+/g, '').trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

function normalizeInvoiceId(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  return /^\d+$/.test(text) ? Number(text) : text;
}

function isWalmexInvoice(invoice) {
  return Boolean(invoice?.walmexSource || invoice?.clientKey === 'walmex' || String(invoice?.id || '').toLowerCase().startsWith('walmex-'));
}

function invoiceIdMatches(left, right) {
  return String(left) === String(right);
}

function normalizeExcelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }
  return String(value ?? '').trim();
}

function reconciliationBalance(invoice) {
  const stored = Number(invoice.balance);
  if (Number.isFinite(stored)) return stored;
  return Math.max(0, Number(invoice.amount || 0) - Number(invoice.creditAmount || 0));
}

function reconciliationPage(payload, url) {
  const pagination = parseInvoicePagination(url);
  return { ...payload, rows: pageRows(payload.rows, pagination), pagination: { page: pagination.page, pageSize: pagination.pageSize, total: Array.isArray(payload.rows) ? payload.rows.length : 0 } };
}

function reconciliationDuplicateKey(client, folio) {
  return `${clientKey(client) || '*'}::${normalizeReference(folio)}`;
}

function checkCustomersMatch(invoiceCustomer, selectedCustomer) {
  const aliases = new Map([
    ['we-got-flower', 'we-got-flowers'], ['we-got-flowers', 'we-got-flowers'],
    ['trader-joe-s', 'trader-joes'], ['trader-joes', 'trader-joes'],
    ['wfs-spokane', 'washington-floral-service-inc-spokane'],
    ['washington-floral-service-inc-spokane', 'washington-floral-service-inc-spokane'],
    ['stemaline-wholesale', 'stemline-wholesale'], ['stemline-wholesale', 'stemline-wholesale'],
    ['galleria-farms-flores', 'galleria-farms'], ['galleria-farms', 'galleria-farms'],
    ['a-perris-farms', 'a-perris-farms'], ['on-time-fresh-express-a-perris-farms', 'a-perris-farms'],
    ['oberer-s-flowers-inc', 'oberer-s-flowers-inc'], ['oberers-flowers-deruette', 'oberer-s-flowers-inc'],
    ['dutches-bouquets', 'dutchess-bouquets'], ['dutchess-bouquets', 'dutchess-bouquets'],
    ['dutchess-buquets', 'dutchess-bouquets'], ['arizona-floral-exchage', 'arizona-floral-exchange'],
    ['arizona-floral-exchange', 'arizona-floral-exchange'],
  ]);
  const identity = value => {
    const key = clientKey(value);
    if (key.startsWith('bill-doran-') || key.startsWith('billdoran-')) return 'bill-doran';
    return aliases.get(key) || key;
  };
  return Boolean(identity(selectedCustomer)) && identity(invoiceCustomer) === identity(selectedCustomer);
}

function invoiceBalance(invoice) {
  return invoice.status === 'Pagada' ? 0 : Math.max(0, Number(invoice.balance ?? (Number(invoice.amount || 0) - Number(invoice.creditAmount || 0))));
}

function reverseCheckAllocations(invoices, check) {
  const allocations = [
    ...(check.allocations || []),
    ...(check.customerCredit?.applications || []),
  ];
  for (const allocation of allocations) {
    const invoice = invoices.find(item => String(item.id) === String(allocation.invoiceId));
    const amount = Number(allocation.amount) || 0;
    if (!invoice || amount <= 0) continue;
    invoice.checkAmount = Math.max(0, Number(invoice.checkAmount || 0) - amount);
    invoice.balance = Number((invoiceBalance(invoice) + amount).toFixed(2));
    if (invoice.balance > 0.01 && invoice.status === 'Pagada') invoice.status = 'Pendiente';
  }
}

function applyCheckAllocations(invoices, allocations) {
  const applied = [];
  for (const allocation of allocations) {
    const invoice = invoices.find(item => String(item.id) === String(allocation.invoiceId));
    const amount = Number(allocation.amount) || 0;
    if (!invoice || amount <= 0) continue;
    invoice.balance = Math.max(0, Number((invoiceBalance(invoice) - amount).toFixed(2)));
    invoice.checkAmount = Number((Number(invoice.checkAmount || 0) + amount).toFixed(2));
    if (invoice.balance <= 0.01) { invoice.balance = 0; invoice.status = 'Pagada'; }
    applied.push({ invoiceId: invoice.id, folio: invoice.folio, amount: Number(amount.toFixed(2)) });
  }
  return applied;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    loginSource: user.loginSource || undefined,
    email: user.email || undefined,
    clientKey: user.clientKey || clientKey(user.name),
    assignedClients: Array.isArray(user.assignedClients) ? user.assignedClients : [],
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    firstName: user.firstName || undefined,
    lastName: user.lastName || undefined,
    phone: user.phone || undefined,
  };
}

function publicAdminUser(user) {
  const profile = publicUser(user);
  return {
    ...profile,
    username: user.username,
    active: user.active !== false,
    createdAt: user.createdAt,
  };
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signJwt(payload, secret) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyJwt(token, secret) {
  const [header, body, signature] = String(token || '').split('.');
  if (!header || !body || !signature) throw new Error('invalid token');
  const input = `${header}.${body}`;
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), base64UrlDecode(signature), encoder.encode(input));
  if (!valid) throw new Error('invalid signature');
  const payload = JSON.parse(decoder.decode(base64UrlDecode(body)));
  if (payload.exp && Number(payload.exp) <= Math.floor(Date.now() / 1000)) throw new Error('expired token');
  return payload;
}

function issueSession(user, secret) {
  const profile = publicUser(user);
  return signJwt({ ...profile, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 }, secret)
    .then(token => ({ token, user: profile }));
}

function sqlClient(env) {
  if (!env.NEON_DATABASE_URL) throw new Error('NEON_DATABASE_URL no está configurada en Cloudflare.');
  return neon(env.NEON_DATABASE_URL);
}

async function collection(sql, name) {
  const rows = await sql`SELECT record FROM app_records WHERE collection = ${name} ORDER BY position NULLS LAST, record_key`;
  return rows.map(row => row.record);
}

async function recordByKey(sql, collectionName, recordKey) {
  const rows = await sql.query(
    'SELECT record, position FROM app_records WHERE collection = $1 AND record_key = $2 LIMIT 1',
    [collectionName, String(recordKey)],
  );
  return rows[0] || null;
}

async function saveRecord(sql, collectionName, recordKey, record, position = null) {
  await sql.query(
    `INSERT INTO app_records(collection, record_key, position, record)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT(collection, record_key)
     DO UPDATE SET position = COALESCE(EXCLUDED.position, app_records.position), record = EXCLUDED.record, updated_at = now()`,
    [collectionName, String(recordKey), position, JSON.stringify(record)],
  );
}

// Consume a pending customer credit exactly once. Previously the new invoice
// was updated in memory but the check's application list was not persisted,
// so the same credit could be applied again to the next invoice.
async function applyPendingCustomerCreditAndPersist(sql, invoice) {
  const rows = await sql.query("SELECT record, position FROM app_records WHERE collection = 'checks' ORDER BY position NULLS LAST, record_key");
  const checks = rows.map(row => row.record);
  const beforeApplications = new Map(checks.map(check => [String(check.id), JSON.stringify(check.customerCredit?.applications || [])]));
  const changed = applyPendingCustomerCreditsToInvoice(invoice, checks, checkCustomersMatch);
  if (!changed) return false;
  for (const row of rows) {
    const key = String(row.record.id);
    if (JSON.stringify(row.record.customerCredit?.applications || []) !== beforeApplications.get(key)) {
      await saveRecord(sql, 'checks', row.record.id, row.record, row.position);
    }
  }
  return true;
}

/**
 * Deja constancia de quien entro. Si falla el registro el usuario entra igual:
 * una metrica no puede dejar a nadie afuera.
 */
async function logPortalAccess(sql, user, entro) {
  try {
    const record = buildAccessRecord(user, entro);
    await saveRecord(sql, 'portalAccessLog', record.id, record);
  } catch { /* el acceso ya se concedio */ }
}

async function saveRecords(sql, collectionName, records) {
  if (!records.length) return;
  const payload = records.map((item, index) => ({ key: String(item.id), position: Number.isFinite(item.position) ? item.position : index, record: item }));
  await sql.query(
    `INSERT INTO app_records(collection, record_key, position, record)
     SELECT $1, item->>'key', NULLIF(item->>'position', '')::integer, item->'record'
     FROM jsonb_array_elements($2::jsonb) AS item
     ON CONFLICT(collection, record_key)
     DO UPDATE SET position = COALESCE(EXCLUDED.position, app_records.position), record = EXCLUDED.record, updated_at = now()`,
    [collectionName, JSON.stringify(payload)],
  );
}

async function saveCheckWithInvoicesAtomically(sql, invoices, check, checkPosition = null) {
  // Walmex invoices are projected from its separate source database and must
  // never be copied into the portal's invoices collection.
  const invoicePayload = invoices.filter(item => !isWalmexInvoice(item)).map(item => ({
    key: String(item.id),
    position: null,
    record: item,
  }));
  const invoiceJson = JSON.stringify(invoicePayload);
  const checkJson = JSON.stringify(check);

  // Neon sends the complete transaction as one HTTP request. This prevents
  // a large check from exhausting Cloudflare's per-invocation subrequest
  // limit and guarantees that invoices and their check are committed
  // together or not at all.
  await sql.transaction(tx => [
    tx`
      INSERT INTO app_records(collection, record_key, position, record)
      SELECT 'invoices', item->>'key', NULLIF(item->>'position', '')::integer, item->'record'
      FROM jsonb_array_elements(${invoiceJson}::jsonb) AS item
      ON CONFLICT(collection, record_key)
      DO UPDATE SET position = COALESCE(EXCLUDED.position, app_records.position), record = EXCLUDED.record, updated_at = now()
    `,
    tx`
      INSERT INTO app_records(collection, record_key, position, record)
      VALUES ('checks', ${String(check.id)}, ${checkPosition}, ${checkJson}::jsonb)
      ON CONFLICT(collection, record_key)
      DO UPDATE SET position = COALESCE(EXCLUDED.position, app_records.position), record = EXCLUDED.record, updated_at = now()
    `,
  ]);
}

async function removeRecord(sql, collectionName, recordKey) {
  await sql.query('DELETE FROM app_records WHERE collection = $1 AND record_key = $2', [collectionName, String(recordKey)]);
}

async function nextNumericId(sql, collectionName) {
  const rows = await sql.query("SELECT COALESCE(MAX((record_key)::bigint), 0) + 1 AS next_id FROM app_records WHERE collection = $1 AND record_key ~ '^[0-9]+$'", [collectionName]);
  return Number(rows[0]?.next_id || Date.now());
}

async function authenticate(request, env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || new URL(request.url).searchParams.get('token');
  if (!token) return { response: json({ message: 'Sesión requerida.' }, 401) };
  try {
    return { user: await verifyJwt(token, env.JWT_SECRET) };
  } catch {
    return { response: json({ message: 'La sesión expiró. Ingresa nuevamente.' }, 401) };
  }
}

function adminOnly(user) {
  return user?.role === 'admin';
}

const portalPermissions = new Set(['dashboard', 'invoices', 'checks', 'support', 'credits', 'reconciliation', 'accountStatement', 'settings', 'users', 'preferences']);
function sanitizePermissions(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(item => portalPermissions.has(item)))] : [];
}

function normalizeAgentClients(value) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function parseRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[;,]/);
  return list.map(item => String(item || '').trim()).filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}

function invoicePlaceholders(invoice) {
  const money = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const balance = invoice.status === 'Pagada' ? 0 : Math.max(0, Number(invoice.balance ?? (Number(invoice.amount || 0) - Number(invoice.creditAmount || 0))));
  return { factura: invoice.folio || '', cliente: invoice.client || '', po: invoice.poNumber || '', guia: invoice.guideNumber || '', monto: money(invoice.amount), saldo: money(balance), emision: invoice.issued || '', vencimiento: invoice.due || '' };
}

function applyPlaceholders(text, invoice) {
  const values = invoicePlaceholders(invoice);
  return String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
    const normalized = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, normalized) ? values[normalized] : match;
  });
}

function base64Encode(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(String(value || '').replace(/^data:[^,]+,/, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function graphAccessToken(env) {
  if (!env.SHAREPOINT_TENANT_ID || !env.SHAREPOINT_CLIENT_ID || !env.SHAREPOINT_CLIENT_SECRET) throw new Error('Faltan las credenciales de Microsoft Graph en Cloudflare.');
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.SHAREPOINT_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.SHAREPOINT_CLIENT_ID, client_secret: env.SHAREPOINT_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || `Microsoft Graph respondió ${response.status}.`);
  return data.access_token;
}

async function graphRequest(env, endpoint, options = {}) {
  const token = await graphAccessToken(env);
  const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Microsoft Graph respondió ${response.status}.`);
  return data;
}

const SHAREPOINT_HOST = 'pacificafarms-my.sharepoint.com';
const WALMEX_SHAREPOINT_HOST = 'pacificafarms.sharepoint.com';
const SHAREPOINT_SITE_PATH = '/personal/michele_martinez_cfbc_co';
const SHAREPOINT_ROOT_FOLDER = '02.PACIFICA';

async function getSharePointDrive(env) {
  const site = await graphRequest(env, `/sites/${SHAREPOINT_HOST}:${SHAREPOINT_SITE_PATH}`);
  const drive = await graphRequest(env, `/sites/${site.id}/drive`);
  if (!drive?.id) throw new Error('No se encontró la biblioteca de SharePoint.');
  return drive.id;
}

async function readReconciliationSnapshot(sql, kind) {
  const cache = reconciliationCache(kind);
  const memory = reconciliationSnapshotMemory.get(kind);
  if (usableReconciliationSnapshot(memory, kind)) return memory;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const row = await recordByKey(sql, cache.collection, cache.key);
      if (usableReconciliationSnapshot(row?.record, kind)) {
        reconciliationSnapshotMemory.set(kind, row.record);
        return row.record;
      }
      return null;
    } catch (error) {
      if (attempt === 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  return null;
}

async function readReconciliationSnapshotPage(sql, kind, url) {
  const cache = reconciliationCache(kind);
  const pagination = parseInvoicePagination(url);
  const rows = await sql.query(`
    SELECT jsonb_set(record->'payload', '{rows}', COALESCE((
      SELECT jsonb_agg(item ORDER BY ord)
      FROM jsonb_array_elements(record->'payload'->'rows') WITH ORDINALITY AS items(item, ord)
      WHERE ord > $3 AND ord <= $4
    ), '[]'::jsonb)) AS payload,
    jsonb_array_length(record->'payload'->'rows')::int AS total
    FROM app_records
    WHERE collection = $1 AND record_key = $2
    LIMIT 1`, [cache.collection, cache.key, pagination.offset, pagination.offset + pagination.pageSize]);
  const row = rows[0];
  if (!row?.payload) return null;
  return { payload: row.payload, total: Number(row.total || 0), pagination };
}

function reconciliationPageResult(page) {
  return { ...page.payload, pagination: { page: page.pagination.page, pageSize: page.pagination.pageSize, total: page.total } };
}

async function pagedInvoices(sql, user, pagination) {
  const assigned = expandClientKeys(user.assignedClients, clientKey);
  const params = ['invoices'];
  const filters = ['collection = $1'];
  if (!(user.role === 'admin' && assigned.length === 0)) {
    if (assigned.length) {
      params.push(assigned);
      filters.push(`(record->>'clientKey' = ANY($${params.length}::text[]) OR nullif(lower(trim(coalesce(record->>'email', ''))), '') = $${params.length + 1})`);
      params.push(String(user.email || '').toLowerCase());
    } else {
      params.push(String(user.clientKey || ''));
      params.push(String(user.email || '').toLowerCase());
      filters.push(`(record->>'clientKey' = $${params.length - 1} OR nullif(lower(trim(coalesce(record->>'email', ''))), '') = $${params.length})`);
    }
  }
  const where = filters.join(' AND ');
  const countRows = await sql.query(`SELECT COUNT(*)::int AS total FROM app_records WHERE ${where}`, params);
  const pageParams = [...params, pagination.pageSize, pagination.offset];
  const rows = await sql.query(`SELECT record FROM app_records WHERE ${where}
    ORDER BY record->>'issued' DESC, record->>'id' DESC
    LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`, pageParams);
  return { items: await attachCheckApplications(sql, rows.map(row => row.record)), total: Number(countRows[0]?.total || 0), page: pagination.page, pageSize: pagination.pageSize };
}

async function attachCheckApplications(sql, invoices) {
  const checks = await collection(sql, 'checks');
  return attachCheckCustomerCreditHistory(invoices, checks);
}

async function reconciliationInvoices(sql) {
  const rows = await sql.query(`SELECT jsonb_build_object(
    'id', record->>'id', 'folio', record->>'folio', 'poNumber', record->>'poNumber',
    'client', record->>'client', 'issued', record->>'issued', 'amount', record->>'amount',
    'balance', record->>'balance', 'creditAmount', record->>'creditAmount',
    'status', record->>'status', 'credits', COALESCE(record->'credits', '[]'::jsonb)
  ) AS record FROM app_records WHERE collection = 'invoices' ORDER BY position NULLS LAST, record_key`);
  return rows.map(row => projectReconciliationInvoice(row.record));
}

async function getWalmexDrive(env) {
  const site = await graphRequest(env, `/sites/${WALMEX_SHAREPOINT_HOST}:/sites/requerimientovsproyeccion`);
  const drive = await graphRequest(env, `/sites/${site.id}/drive`);
  if (!drive?.id) throw new Error('No se encontró la biblioteca de SharePoint de Walmex.');
  return drive.id;
}

async function walmexDocumentResponse(request, env) {
  const raw = new URL(request.url).searchParams.get('url') || '';
  let relativePath = '';
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch { return json({ message: 'Enlace Walmex inválido.' }, 400); }
    if (parsed.hostname.toLowerCase() !== 'pacificafarms.sharepoint.com') return json({ message: 'El documento no pertenece al almacenamiento Walmex permitido.' }, 403);
    const marker = '/Shared Documents/';
    const markerIndex = parsed.pathname.toLowerCase().indexOf(marker.toLowerCase());
    if (markerIndex < 0) return json({ message: 'No se reconoció la ruta del documento Walmex.' }, 400);
    relativePath = decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
  } else {
    // The Walmex source database stores the SharePoint path, not the full URL.
    relativePath = decodeURIComponent(String(raw)).replace(/^\/+|\/+$/g, '');
  }
  if (!/^requerimiento vs proyeccion\/WALMEX\/Gastos\/(?:Facturas|Acuses)\/[^/]+$/i.test(relativePath) || relativePath.includes('..')) return json({ message: 'Ruta de documento Walmex no permitida.' }, 403);
  const driveId = await getWalmexDrive(env);
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  const token = await graphAccessToken(env);
  const response = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}:/content`, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow' });
  if (!response.ok) return json({ message: `No se pudo abrir el documento Walmex (HTTP ${response.status}).` }, response.status === 404 ? 404 : 502);
  const headers = new Headers(response.headers);
  headers.set('content-type', /\.(?:jpe?g)$/i.test(relativePath) ? 'image/jpeg' : 'application/octet-stream');
  headers.set('cache-control', 'private, no-store');
  headers.set('content-disposition', `inline; filename="${relativePath.split('/').pop().replace(/"/g, '')}"`);
  return new Response(response.body, { status: 200, headers });
}

async function listDriveChildren(env, driveId, parentId) {
  const items = [];
  let endpoint = `/drives/${driveId}/items/${parentId}/children?$top=200`;
  while (endpoint) {
    const page = await graphRequest(env, endpoint);
    items.push(...(page?.value || []));
    const next = page?.['@odata.nextLink'];
    endpoint = next ? `${new URL(next).pathname.replace(/^\/v1\.0/, '')}${new URL(next).search}` : '';
  }
  return items;
}

async function findRootFolder(env, driveId) {
  const result = await graphRequest(env, `/drives/${driveId}/root/children?$filter=${encodeURIComponent(`name eq '${SHAREPOINT_ROOT_FOLDER}'`)}`);
  const root = result?.value?.find(item => item.folder && item.name === SHAREPOINT_ROOT_FOLDER);
  if (!root) throw new Error(`No se encontró la carpeta ${SHAREPOINT_ROOT_FOLDER} en SharePoint.`);
  return root;
}

async function findChildFolder(env, driveId, parentId, name) {
  const result = await graphRequest(env, `/drives/${driveId}/items/${parentId}/children?$filter=${encodeURIComponent(`name eq '${String(name).replace(/'/g, "''")}'`)}`);
  const folder = result?.value?.find(item => item.folder && item.name === name);
  if (!folder) throw new Error(`No se encontró la carpeta ${name} en SharePoint.`);
  return folder;
}

function availableCreditBalance(invoice) {
  const previous = (invoice.credits || []).filter(credit => !credit.documentOnly).reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
  if (invoice.status === 'Pagada') return 0;
  const maximum = Math.max(0, Number(invoice.amount || 0) - previous);
  const declared = Number(invoice.balance);
  return Number.isFinite(declared) ? Math.min(Math.max(0, declared), maximum) : maximum;
}

function isSyncDocument(name) {
  return /\.(?:pdf|jpe?g|png|heic|heif)$/i.test(String(name || ''));
}

function hasInvoiceFilenameHint(fileName) {
  const name = String(fileName || '');
  return /\binvoice\b/i.test(name) && /\b(?:po|order|purchase)\b/i.test(name);
}

async function mergePdfBytes(buffers) {
  return mergePdfBuffers(buffers);
}

async function syncBytesToPdf(env, name, bytes) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.pdf')) return bytes;
  if (/\.hei[cf]$/.test(lower)) {
    const jpeg = env.CONVERTAPI_SECRET
      ? await convertHeicToJpeg(env.CONVERTAPI_SECRET, name, bytes)
      : new Uint8Array(await encodeJpeg(await decodeHeic(bytes), { quality: 90 }));
    return ensurePdfBytes(new File([jpeg], `${name.replace(/\.hei[cf]$/i, '')}.jpg`, { type: 'image/jpeg' }));
  }
  const type = lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return ensurePdfBytes(new File([bytes], name, { type }));
}

// El emisor se deduce del texto extraido del PDF: las de Centro Floricultor
// lo llevan en el encabezado. El resto es Pacifica, la emisora normal.
function invoiceIssuerKey(invoice) {
  const text = `${invoice?.searchText || ''} ${invoice?.concept || ''}`.toLowerCase();
  return text.includes('centro floricultor') ? 'centro' : 'pacifica';
}

// Centro Floricultor factura desde su propio buzon; el resto sale del de AR.
function senderForIssuer(env, issuer) {
  return issuer === 'centro' && env.MAIL_FROM_CENTRO ? env.MAIL_FROM_CENTRO : env.MAIL_FROM;
}

// Guarda o mezcla una plantilla por su clientKey. Sirve tanto para el
// registro del cliente (destinatarios) como para el de la empresa (mensaje).
async function upsertEmailTemplate(sql, key, patch) {
  if (!key) return;
  const templates = await collection(sql, 'emailTemplates');
  const existing = templates.find(item => String(item.clientKey || '') === key);
  const record = { ...(existing || {}), clientKey: key, ...patch, updatedAt: new Date().toISOString() };
  if (existing) {
    const rows = await sql.query('SELECT record_key, position FROM app_records WHERE collection = $1 AND record->>\'clientKey\' = $2 LIMIT 1', ['emailTemplates', key]);
    await saveRecord(sql, 'emailTemplates', rows[0]?.record_key || existing.id || key, record, rows[0]?.position ?? null);
  } else {
    await saveRecord(sql, 'emailTemplates', await nextNumericId(sql, 'emailTemplates'), record, templates.length);
  }
}

async function sendGraphMail(env, { to, cc, subject, html, attachment, from }) {
  const fromAddress = from || env.MAIL_FROM;
  if (!fromAddress) throw new Error('Falta MAIL_FROM en los secretos de Cloudflare.');
  const sender = encodeURIComponent(fromAddress);
  const message = { subject, body: { contentType: 'HTML', content: html }, toRecipients: to.map(address => ({ emailAddress: { address } })), ccRecipients: cc.map(address => ({ emailAddress: { address } })) };
  if (!attachment || attachment.bytes.length < SIMPLE_ATTACHMENT_LIMIT) {
    if (attachment) message.attachments = [{ '@odata.type': '#microsoft.graph.fileAttachment', name: attachment.name, contentType: attachment.contentType || 'application/pdf', contentBytes: base64Encode(attachment.bytes) }];
    await graphRequest(env, `/users/${sender}/sendMail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) });
    return;
  }
  const draft = await graphRequest(env, `/users/${sender}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
  const session = await graphRequest(env, `/users/${sender}/messages/${draft.id}/attachments/createUploadSession`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: attachment.name, size: attachment.bytes.length, contentType: attachment.contentType || 'application/pdf' } }) });
  if (!session?.uploadUrl) throw new Error('No fue posible iniciar la carga del adjunto.');
  const chunkSize = 4 * 1024 * 1024;
  for (let start = 0; start < attachment.bytes.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, attachment.bytes.length) - 1;
    const chunk = attachment.bytes.slice(start, end + 1);
    const upload = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end}/${attachment.bytes.length}` }, body: chunk });
    if (!upload.ok && upload.status !== 201 && upload.status !== 202) throw new Error(`Falló la carga del adjunto (HTTP ${upload.status}).`);
  }
  await graphRequest(env, `/users/${sender}/messages/${draft.id}/send`, { method: 'POST' });
}

async function mergePdfBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  try {
    const output = await PDFDocument.create();
    const sources = [];
    let pageTreePrototype;
    for (const bytes of buffers) {
      const source = await PDFDocument.load(bytes);
      const pagesNode = source.catalog.Pages();
      if (typeof pagesNode.traverse === 'function' && !pageTreePrototype) pageTreePrototype = Object.getPrototypeOf(pagesNode);
      sources.push(source);
    }
    for (const source of sources) {
      const pagesNode = source.catalog.Pages();
      if (typeof pagesNode.traverse !== 'function' && pageTreePrototype) Object.setPrototypeOf(pagesNode, pageTreePrototype);
      for (const pageIndex of source.getPageIndices()) {
        const sourcePage = source.getPage(pageIndex);
        const sourceWidth = sourcePage.getWidth();
        const sourceHeight = sourcePage.getHeight();
        const landscape = sourceWidth > sourceHeight;
        const pageWidth = landscape ? 792 : 612;
        const pageHeight = landscape ? 612 : 792;
        const embedded = await output.embedPage(sourcePage);
        const scale = Math.min(pageWidth / sourceWidth, pageHeight / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        const page = output.addPage([pageWidth, pageHeight]);
        page.drawPage(embedded, {
          x: (pageWidth - width) / 2,
          y: (pageHeight - height) / 2,
          width,
          height,
        });
      }
    }
    return new Uint8Array(await output.save());
  } catch {
    // Algunos PDFs de proveedores son válidos para el visor, pero no para
    // pdf-lib. El Worker devuelve al menos la factura original; la unión
    // completa seguirá disponible mientras se termina la ruta de procesamiento.
    return buffers[0];
  }
}

async function ensurePdfBytes(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return bytes;
  if (type === 'image/heic' || type === 'image/heif' || /\.hei[cf]$/.test(name)) throw new Error('El formato HEIC se convertirá durante la sincronización; para una carga manual usa PDF, JPG o PNG.');
  const document = await PDFDocument.create();
  let image;
  if (type === 'image/png' || name.endsWith('.png')) image = await document.embedPng(bytes);
  else if (type === 'image/jpeg' || /\.jpe?g$/.test(name)) image = await document.embedJpg(bytes);
  else throw new Error('El archivo debe ser PDF, JPG, PNG o HEIC.');
  const page = document.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return new Uint8Array(await document.save());
}

function normalizeObjectName(value) {
  return String(value || '').replace(/^\/+/, '').trim();
}

function pemToBytes(pem) {
  const body = String(pem || '').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  return base64UrlDecode(body.replace(/\+/g, '-').replace(/\//g, '_'));
}

async function oracleSigningKey(env) {
  const pem = env.OCI_PRIVATE_KEY;
  if (!pem) throw new Error('OCI_PRIVATE_KEY no está configurada en Cloudflare.');
  return crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sha256Base64(bytes) {
  return base64Encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function oracleObject(request, env, objectName, body = null, contentType = 'application/octet-stream') {
  const namespace = String(env.OCI_NAMESPACE || '').trim();
  const bucket = String(env.OCI_BUCKET_NAME || '').trim();
  const region = String(env.OCI_REGION || '').trim();
  const tenancy = String(env.OCI_TENANCY_ID || '').trim();
  const user = String(env.OCI_USER_ID || '').trim();
  const fingerprint = String(env.OCI_FINGERPRINT || '').trim();
  if (!namespace || !bucket || !region || !tenancy || !user || !fingerprint || !env.OCI_PRIVATE_KEY) {
    throw new Error('Faltan secretos de Oracle Object Storage en Cloudflare.');
  }

  const encodedObject = normalizeObjectName(objectName).split('/').map(encodeURIComponent).join('/');
  // OCI native Object Storage endpoint (the namespace is part of the path).
  const host = `objectstorage.${region}.oraclecloud.com`;
  const url = `https://${host}/n/${encodeURIComponent(namespace)}/b/${encodeURIComponent(bucket)}/o/${encodedObject}`;
  const urlObject = new URL(url);
  const date = new Date().toUTCString();
  const method = request.method.toUpperCase();
  const target = `${method.toLowerCase()} ${urlObject.pathname}${urlObject.search}`;
  const headers = { date, host };
  let signedHeaders = '(request-target) host date';
  let signingString = `(request-target): ${target}\nhost: ${host}\ndate: ${date}`;
  if (method === 'PUT' || method === 'POST') {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body || 0);
    headers['content-type'] = contentType;
    headers['content-length'] = String(bytes.byteLength);
    headers['x-content-sha256'] = await sha256Base64(bytes);
    signedHeaders += ' content-type content-length x-content-sha256';
    signingString += `\ncontent-type: ${headers['content-type']}\ncontent-length: ${headers['content-length']}\nx-content-sha256: ${headers['x-content-sha256']}`;
    body = bytes;
  }
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await oracleSigningKey(env), encoder.encode(signingString));
  const signatureBase64 = base64UrlEncode(new Uint8Array(signature)).replace(/-/g, '+').replace(/_/g, '/');
  const authorization = `Signature version="1",keyId="${tenancy}/${user}/${fingerprint}",algorithm="rsa-sha256",headers="${signedHeaders}",signature="${signatureBase64}"`;
  delete headers.host;
  headers.Authorization = authorization;
  return fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : body });
}

async function oraclePdfBytes(env, objectName) {
  const response = await oracleObject(new Request('https://objectstorage.invalid/', { method: 'GET' }), env, objectName);
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

async function putOracleObject(env, objectName, bytes, contentType = 'application/pdf') {
  const response = await oracleObject(new Request('https://objectstorage.invalid/', { method: 'PUT' }), env, objectName, bytes, contentType);
  if (!response.ok) throw new Error(`Oracle Object Storage rechazó la carga (HTTP ${response.status}).`);
}

async function deleteOracleObject(env, objectName) {
  if (!normalizeObjectName(objectName)) return;
  const response = await oracleObject(new Request('https://objectstorage.invalid/', { method: 'DELETE' }), env, objectName);
  if (!response.ok && response.status !== 404) throw new Error(`Oracle Object Storage rechazó la eliminación (HTTP ${response.status}).`);
}

async function invoicePdfResponse(request, env, invoice, type) {
  const objectName = normalizeObjectName(type === 'receiving' ? invoice.receivingPdfPath : invoice.invoicePdfPath);
  if (!objectName) return json({ message: 'El PDF no está registrado para esta factura.' }, 404);
  const storageResponse = await oracleObject(request, env, objectName);
  if (!storageResponse.ok) return json({ message: 'El PDF no está disponible en Oracle Object Storage.' }, storageResponse.status === 404 ? 404 : 502);
  const headers = new Headers(storageResponse.headers);
  headers.set('content-type', 'application/pdf');
  headers.set('cache-control', 'private, no-store');
  headers.set('x-cfbc-api', 'direct');
  headers.set('content-disposition', `inline; filename="${objectName.replace(/"/g, '')}"`);
  return new Response(storageResponse.body, { status: 200, headers });
}

async function processInvoiceSyncFile(env, sql, job, file) {
  const issues = Array.isArray(job.issues) ? job.issues : [];
  const details = Array.isArray(job.details) ? job.details : [];
  let processed = Number(job.processed || 0);
  let skipped = Number(job.skipped || 0);
  try {
    const downloadUrl = file.downloadUrl;
    if (!downloadUrl) throw new Error('No se pudo obtener el enlace de descarga.');
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Descarga fallida (HTTP ${response.status}).`);
    const normalizedBytes = await syncBytesToPdf(env, file.name, new Uint8Array(await response.arrayBuffer()));
    const invoices = await collection(sql, 'invoices');
    let extracted = null;
    try { extracted = await extractInvoicePdf(normalizedBytes); } catch { /* receiving candidate */ }

    if (extracted?.folio && extracted?.client && Number.isFinite(extracted.amount)) {
      const duplicate = invoices.find(invoice => isDuplicateInvoice(invoice, extracted));
      if (duplicate) {
        issues.push({ file: file.name, status: 'duplicate', reason: `La factura ya existe para este cliente (registro ${duplicate.id}). No se subió ni se movió el PDF.`, replacement: { kind: 'invoice', sourceFileId: file.id, existingInvoiceId: duplicate.id } });
        skipped += 1;
      } else {
        const id = Date.now() + Math.floor(Math.random() * 1000);
        const objectName = `${id}-invoice.pdf`;
        await putOracleObject(env, objectName, normalizedBytes);
        const invoice = { id, folio: extracted.folio, poNumber: extracted.poNumber || '', guideNumber: extracted.guideNumber || '', client: extracted.client, clientKey: clientKey(extracted.client), location: extracted.location || '', email: extracted.email || '', concept: extracted.concept || 'Factura (Auto-Sync)', searchText: extracted.searchText || '', issued: extracted.issued || new Date().toISOString().slice(0, 10), due: extracted.due || new Date(Date.now() + 2592000000).toISOString().slice(0, 10), amount: Number(extracted.amount), status: 'Pendiente', credits: [], creditAmount: 0, invoiceFileName: file.name, sourceSharePointPath: file.name, sourceSharePointFileId: file.id, invoicePdfPath: objectName, invoiceSharePointUrl: '', receivingFileName: '', receivingPdfPath: '', receivingSharePointUrl: '', sharePointStorage: { client: extracted.client, location: extracted.location || '', issued: extracted.issued, folio: extracted.folio } };
        await applyPendingCustomerCreditAndPersist(sql, invoice);
        await saveRecord(sql, 'invoices', id, invoice, invoices.length);
        await graphRequest(env, `/drives/${job.driveId}/items/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
        details.push({ file: file.name, type: 'invoice', status: 'processed', targets: [{ folio: invoice.folio, client: invoice.client }], reason: 'Factura registrada correctamente.' });
        processed += 1;
      }
    } else if (job.phase === 'invoices') {
      // Primera fase: no clasificar todavía como recibimiento. La copia
      // anterior esperaba a terminar de registrar todas las facturas para
      // poder relacionar después los recibimientos por folio/PO/guía.
      if (hasInvoiceFilenameHint(file.name)) {
        issues.push({ file: file.name, status: 'error', reason: 'El archivo parece una factura (nombre INVOICE + PO), pero no se pudieron leer todos sus datos. No se asignó como recibimiento.' });
        skipped += 1;
      } else {
        job.pendingReceivings = [...(job.pendingReceivings || []), file];
      }
    } else {
      const allMatches = findReceivingInvoices(file.name, invoices);
      const explicit = findExplicitMultiReceivingInvoices(file.name, allMatches);
      const targets = explicit.length ? explicit : allMatches;
      if (!targets.length) {
        issues.push({ file: file.name, status: 'missing', reason: 'No se detectó una factura válida y el nombre del archivo no coincide con ninguna factura registrada.' });
        skipped += 1;
      } else if (!explicit.length && targets.length > 1) {
        issues.push({ file: file.name, status: 'warning', reason: 'El nombre coincide con varias facturas. Selecciona la correcta.', replacement: { kind: 'receiving', sourceFileId: file.id, invoiceIds: targets.map(invoice => invoice.id), invoiceOptions: targets.map(invoice => ({ id: invoice.id, folio: invoice.folio, client: invoice.client })) } });
        skipped += 1;
      } else {
        for (const invoice of targets) {
          const row = await recordByKey(sql, 'invoices', invoice.id);
          if (!row) continue;
          let outputBytes = normalizedBytes;
          if (row.record.receivingPdfPath) {
            const current = await oraclePdfBytes(env, row.record.receivingPdfPath);
            if (current) outputBytes = await mergePdfBytes([current, normalizedBytes]);
          }
          const objectName = `${row.record.id}-receiving.pdf`;
          await putOracleObject(env, objectName, outputBytes);
          row.record.receivingPdfPath = objectName;
          row.record.receivingFileName = file.name;
          row.record.receivingSourceFileIds = [...new Set([...(row.record.receivingSourceFileIds || []), file.id])];
          await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
        }
        await graphRequest(env, `/drives/${job.driveId}/items/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
        details.push({ file: file.name, type: 'receiving', status: 'linked', targets: targets.map(invoice => ({ folio: invoice.folio, client: invoice.client })), reason: 'Recibimiento asociado correctamente.' });
        processed += 1;
      }
    }
  } catch (error) {
    issues.push({ file: file.name, status: 'error', reason: error?.message || 'No fue posible procesar el archivo.' });
    skipped += 1;
  }
  Object.assign(job, { processed, skipped, issues, details });
}

export async function tryDirectApi(request, env) {
  // La activación es explícita para que la migración se pueda probar sin
  // cambiar el tráfico actual antes de configurar todos los secretos.
  if (String(env.DIRECT_API || '').toLowerCase() !== 'true') return null;
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok', runtime: 'cloudflare-worker', database: Boolean(env.NEON_DATABASE_URL), oracle: Boolean(env.OCI_PRIVATE_KEY && env.OCI_NAMESPACE), graph: Boolean(env.MAIL_FROM && env.SHAREPOINT_TENANT_ID && env.SHAREPOINT_CLIENT_ID && env.SHAREPOINT_CLIENT_SECRET) });

  if (path === '/api/auth/login' && request.method === 'POST') {
    try {
      const body = await request.json();
      const normalized = String(body?.username || '').trim().toLowerCase();
      const password = String(body?.password || '');
      if (!normalized) return json({ message: 'Ingresa tu correo.' }, 400);
      const sql = sqlClient(env);
      const users = await collection(sql, 'users');
      const user = users.find(item => String(item.username || '').toLowerCase() === normalized || String(item.email || '').toLowerCase() === normalized);
      if (user) {
        if (!password && user.active !== false) return json({ requiresPassword: true });
        if (user.active === false || !(await bcrypt.compare(password, String(user.passwordHash || '')))) return json({ message: 'Usuario o contraseña incorrectos.' }, 401);
        const session = await issueSession(user, env.JWT_SECRET);
        await logPortalAccess(sql, user, 'manual');
        return json(session);
      }
      const [invoices, emailLog] = await Promise.all([collection(sql, 'invoices'), collection(sql, 'emailLog')]);
      const resolved = resolveEmailLogin({ users, invoices, emailLog }, normalized, clientKey);
      if (resolved.kind === 'history') {
        const session = await issueSession(resolved.user, env.JWT_SECRET);
        await logPortalAccess(sql, resolved.user, 'historial');
        return json(session);
      }
      return json({ message: 'No hay acceso habilitado para este correo.' }, 401);
    } catch (error) {
      return json({ message: error?.message || 'No se pudo iniciar sesión.' }, 500);
    }
  }

  const auth = await authenticate(request, env);
  if (auth.response) return auth.response;
  const user = auth.user;
  const sql = sqlClient(env);

  if (path === '/api/account' && request.method === 'GET') {
    if (user.loginSource === 'email-history') return json(publicUser(user));
    const users = await collection(sql, 'users');
    const current = users.find(item => String(item.id) === String(user.id));
    return current ? json(publicUser(current)) : json({ message: 'No se encontró la cuenta.' }, 404);
  }

  if (path === '/api/account/profile' && request.method === 'PATCH') {
    const body = await request.json();
    const firstName = String(body?.firstName || '').trim();
    const lastName = String(body?.lastName || '').trim();
    const phone = String(body?.phone || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    if (!firstName || !email) return json({ message: 'Nombre y correo son obligatorios.' }, 400);
    const users = await collection(sql, 'users');
    const current = users.find(item => String(item.id) === String(user.id));
    if (!current) return json({ message: 'No se encontró la cuenta.' }, 404);
    if (users.some(item => String(item.id) !== String(current.id) && String(item.email || '').toLowerCase() === email)) return json({ message: 'Ese correo ya está registrado.' }, 409);
    current.firstName = firstName;
    current.lastName = lastName;
    current.name = [firstName, lastName].filter(Boolean).join(' ');
    current.phone = phone;
    current.email = email;
    const row = await recordByKey(sql, 'users', current.id);
    await saveRecord(sql, 'users', current.id, current, row?.position ?? null);
    return json({ message: 'Información de cuenta actualizada.', ...(await issueSession(current, env.JWT_SECRET)) });
  }

  if (path === '/api/account/password' && request.method === 'PATCH') {
    const body = await request.json();
    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');
    const confirmPassword = String(body?.confirmPassword || '');
    if (!currentPassword || !newPassword || !confirmPassword) return json({ message: 'Completa todos los campos de contraseña.' }, 400);
    if (newPassword.length < 8) return json({ message: 'La nueva contraseña debe tener al menos 8 caracteres.' }, 400);
    if (newPassword !== confirmPassword) return json({ message: 'Las contraseñas no coinciden.' }, 400);
    const row = await recordByKey(sql, 'users', user.id);
    if (!row) return json({ message: 'No se encontró la cuenta.' }, 404);
    if (!(await bcrypt.compare(currentPassword, String(row.record?.passwordHash || '')))) return json({ message: 'La contraseña actual no es correcta.' }, 400);
    row.record.passwordHash = await bcrypt.hash(newPassword, 12);
    await saveRecord(sql, 'users', user.id, row.record, row.position);
    return json({ message: 'Contraseña actualizada correctamente.' });
  }

  if (path === '/api/invoices' && request.method === 'GET') {
    if (url.searchParams.has('page') || url.searchParams.has('pageSize')) {
      return json(await pagedInvoices(sql, user, parseInvoicePagination(url)));
    }
    const invoices = await collection(sql, 'invoices');
    const assigned = expandClientKeys(user.assignedClients, clientKey);
    const visible = user.role === 'admin' && assigned.length === 0 ? invoices : invoices.filter(invoice => {
      if (user.loginSource === 'email-history') return historyInvoiceAccess(user, invoice, clientKey);
      const key = invoice.clientKey || clientKey(invoice.client);
      if (assigned.length) return assigned.includes(key);
      return key === user.clientKey || String(invoice.email || '').toLowerCase() === String(user.email || '').toLowerCase();
    });
    return json((await attachCheckApplications(sql, visible)).sort((a, b) => String(b.issued || b.id || '').localeCompare(String(a.issued || a.id || ''))));
  }

  if (path === '/api/walmex/invoices' && request.method === 'GET') {
    const assigned = Array.isArray(user.assignedClients) ? user.assignedClients.map(clientKey).filter(Boolean) : [];
    const allowed = user.role === 'admin' || assigned.includes('walmex') || user.clientKey === 'walmex';
    if (!allowed) return json({ message: 'No tienes acceso a Walmex.' }, 403);
    const checks = await collection(sql, 'checks');
    const invoices = await withTimeout(loadWalmexInvoices(env.WALMEX_DATABASE_URL, checks), 10000, null);
    if (invoices === null) return json({ invoices: [], stale: true, message: 'Walmex está tardando en responder.' });
    return json({ invoices, stale: false });
  }

  if (path === '/api/walmex/document' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    return walmexDocumentResponse(request, env);
  }

  if (path === '/api/checks' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const checks = await collection(sql, 'checks');
    return json(checks.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id || 0) - Number(a.id || 0)));
  }

  if (path === '/api/checks' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const date = String(body?.date || '').trim();
    const series = String(body?.series || '').trim();
    const selectedClient = String(body?.client || '').trim();
    const total = Number(body?.total);
    const invoiceIds = [...new Set((Array.isArray(body?.invoiceIds) ? body.invoiceIds : []).map(normalizeInvoiceId).filter(id => id !== null))];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ message: 'La fecha del cheque no es válida.' }, 400);
    if (!series) return json({ message: 'Captura la serie o número del cheque.' }, 400);
    if (!selectedClient) return json({ message: 'Selecciona un cliente.' }, 400);
    if (!Number.isFinite(total) || total <= 0) return json({ message: 'El total del cheque debe ser mayor que cero.' }, 400);
    if (!invoiceIds.length) return json({ message: 'Selecciona al menos una factura.' }, 400);
    const [checks, invoices] = await Promise.all([collection(sql, 'checks'), collection(sql, 'invoices')]);
    const needsWalmex = clientKey(selectedClient) === 'walmex' || invoiceIds.some(id => String(id).toLowerCase().startsWith('walmex-'));
    const walmex = needsWalmex ? await loadWalmexInvoices(env.WALMEX_DATABASE_URL, checks) : [];
    const allInvoices = [...invoices, ...walmex];
    if (checks.some(check => checkCustomersMatch(check.client, selectedClient) && normalizeReference(check.series) === normalizeReference(series))) return json({ message: `El cheque ${series} ya está registrado para este cliente.` }, 409);
    const selected = invoiceIds.map(id => allInvoices.find(invoice => invoiceIdMatches(invoice.id, id)));
    if (selected.some(invoice => !invoice)) return json({ message: 'Una de las facturas seleccionadas ya no existe.' }, 400);
    if (selected.some(invoice => !checkCustomersMatch(invoice.client, selectedClient))) return json({ message: 'Todas las facturas deben pertenecer al cliente seleccionado.' }, 400);
    const ordered = [...selected].sort((left, right) => String(left.due || left.issued || '').localeCompare(String(right.due || right.issued || '')));
    const available = ordered.reduce((sum, invoice) => sum + invoiceBalance(invoice), 0);
    const raw = Array.isArray(body?.allocations) ? body.allocations.map(item => ({ invoiceId: normalizeInvoiceId(item?.invoiceId), amount: Number(item?.amount) })).filter(item => item.invoiceId !== null && Number.isFinite(item.amount) && item.amount > 0) : [];
    let allocations = [];
    if (raw.length) {
      if (raw.some(item => !invoiceIds.includes(item.invoiceId))) return json({ message: 'El reparto incluye una factura que no está seleccionada.' }, 400);
      const allocated = raw.reduce((sum, item) => sum + item.amount, 0);
      const overpayment = total - allocated;
      if (overpayment < -0.01) return json({ message: 'El reparto por factura supera el total del cheque.' }, 400);
      if (overpayment > 0.01 && (total <= available + 0.01 || Math.abs(allocated - available) > 0.01)) {
        return json({ message: 'Para registrar un saldo a favor, aplica primero el saldo completo de las facturas seleccionadas.' }, 400);
      }
      if (overpayment <= 0.01 && Math.abs(allocated - total) > 0.01) return json({ message: 'El reparto por factura no coincide con el total del cheque.' }, 400);
      for (const item of raw) {
        const invoice = selected.find(candidate => invoiceIdMatches(candidate.id, item.invoiceId));
        if (item.amount > invoiceBalance(invoice) + 0.01) return json({ message: `El monto asignado a la factura ${invoice.folio} excede su saldo disponible (${invoiceBalance(invoice).toFixed(2)}).` }, 400);
      }
      allocations = applyCheckAllocations(allInvoices, raw);
    } else {
      let remaining = Math.min(total, available);
      const planned = [];
      for (const invoice of ordered) {
        const amount = Math.min(remaining, invoiceBalance(invoice));
        if (amount > 0) planned.push({ invoiceId: invoice.id, amount });
        remaining = Number((remaining - amount).toFixed(2));
        if (remaining <= 0) break;
      }
      allocations = applyCheckAllocations(allInvoices, planned);
    }
    const allocatedTotal = allocations.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const excess = Number(Math.max(0, total - allocatedTotal).toFixed(2));
    if (excess > 0.01 && !allocations.length) return json({ message: 'Selecciona una factura para relacionar el saldo a favor del cliente.' }, 400);
    const sourceAllocation = allocations[allocations.length - 1];
    const check = {
      id: Date.now(), date, series, client: selectedClient, clientKey: clientKey(selectedClient),
      total: Number(total.toFixed(2)), allocations, createdAt: new Date().toISOString(),
      ...(excess > 0.01 ? { customerCredit: { amount: excess, sourceInvoiceId: sourceAllocation.invoiceId, sourceFolio: sourceAllocation.folio, applications: [] } } : {}),
    };
    const creditInvoices = excess > 0.01 ? applyCustomerCreditToInvoices(allInvoices, check, checkCustomersMatch) : [];
    const affectedIds = new Set([...allocations.map(item => String(item.invoiceId)), ...creditInvoices.map(item => String(item.id))]);
    const affected = allInvoices.filter(invoice => affectedIds.has(String(invoice.id)));
    await saveCheckWithInvoicesAtomically(sql, affected, check, checks.length);
    const remainingCredit = checkCustomerCreditRemaining(check);
    const message = remainingCredit > 0.01
      ? `Cheque ${series} registrado. El excedente quedó como saldo a favor del cliente.`
      : `Cheque ${series} registrado y el excedente se aplicó a facturas posteriores.`;
    return json({ message, check }, 201);
  }

  if ((path === '/api/reconciliation/upload' || path === '/api/reconciliation/credits/upload') && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const form = await request.formData();
    const field = path.includes('/credits/') ? 'excel' : 'excel';
    const file = form.get(field);
    if (!file || typeof file.arrayBuffer !== 'function') return json({ message: 'Por favor selecciona un archivo de Excel.' }, 400);
    const objectName = path.includes('/credits/') ? '_system/credit-reconciliation.xlsx' : '_system/reconciliation.xlsx';
    await putOracleObject(env, objectName, new Uint8Array(await file.arrayBuffer()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await saveRecord(sql, 'systemFiles', objectName, { id: objectName, name: file.name, uploadedAt: new Date().toISOString() }, 0);
    const kind = path.includes('/credits/') ? 'credits' : 'invoices';
    const cache = reconciliationCache(kind);
    await removeRecord(sql, cache.collection, cache.key);
    reconciliationSnapshotMemory.delete(kind);
    return json({ message: 'Archivo cargado correctamente.' });
  }

  if (path === '/api/reconciliation' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const cachedPage = await readReconciliationSnapshotPage(sql, 'invoices', url);
    if (cachedPage) return json(reconciliationPageResult(cachedPage));
    const bytes = await oraclePdfBytes(env, '_system/reconciliation.xlsx');
    if (!bytes) return json({ rows: [], totals: { excel: 0, found: 0, missing: 0 }, source: 'No hay archivo cargado' });
    const workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
    const sourceRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    const invoices = await reconciliationInvoices(sql);
    const snapshot = (await recordByKey(sql, 'statementSnapshots', 'current'))?.record || null;
    const statementByInvoice = new Map((snapshot?.entries || []).map(entry => [String(entry.systemInvoiceId), entry]));
    const prepared = sourceRows.map(row => ({ folio: String(row.Folio ?? '').trim(), series: String(row.Serie ?? row['Serie / PO'] ?? row['PO Number'] ?? '').trim(), client: String(row['Razón Social'] ?? row['Razon Social'] ?? '').trim(), date: normalizeExcelDate(row.Fecha), total: Number(String(row.Total ?? '').replace(/[$,\s]/g, '')) || 0 })).filter(row => row.folio);
    const matches = matchStatementRows(invoices, prepared.map(row => ({ invoice: row.folio, po: row.series, date: row.date })));
    const byRow = new Map(matches.matches.map(match => [match.rowIndex, match]));
    const used = new Set();
    const excelCounts = new Map(); const systemCounts = new Map();
    prepared.forEach(row => excelCounts.set(reconciliationDuplicateKey(row.client, row.folio), (excelCounts.get(reconciliationDuplicateKey(row.client, row.folio)) || 0) + 1));
    invoices.forEach(invoice => systemCounts.set(reconciliationDuplicateKey(invoice.client, invoice.folio), (systemCounts.get(reconciliationDuplicateKey(invoice.client, invoice.folio)) || 0) + 1));
    const contpaqRows = prepared.map((row, index) => {
      const match = byRow.get(index); const invoice = match ? invoices[match.invoiceIndex] : null; if (invoice) used.add(String(invoice.id));
      const statement = invoice ? statementByInvoice.get(String(invoice.id)) : null;
      const externalBalance = statement && Number.isFinite(Number(statement.balance)) ? Number(statement.balance) : null;
      const duplicateKey = reconciliationDuplicateKey(row.client, row.folio);
      const validation = excelCounts.get(duplicateKey) > 1 ? (systemCounts.get(duplicateKey) > 1 ? 'both-duplicate' : 'excel-duplicate') : systemCounts.get(duplicateKey) > 1 ? 'system-duplicate' : !invoice || externalBalance === null ? 'missing' : Math.abs(reconciliationBalance(invoice) - externalBalance) < 0.01 ? 'valid' : 'amount-different';
      return { folio: row.folio, series: row.series, client: row.client, date: row.date, total: invoice ? Number(invoice.amount || 0) : row.total, inContPaq: true, inSystem: Boolean(invoice), sourceStatus: invoice ? 'both' : 'contpaq', existsInSystem: Boolean(invoice), matchedBy: match?.method || null, systemInvoiceId: invoice?.id || null, balanceSystem: invoice ? reconciliationBalance(invoice) : null, balanceContPaq: externalBalance, validation };
    });
    const systemOnlyRows = invoices.filter(invoice => !used.has(String(invoice.id))).map(invoice => { const statement = statementByInvoice.get(String(invoice.id)); const externalBalance = statement && Number.isFinite(Number(statement.balance)) ? Number(statement.balance) : null; return { folio: invoice.folio, series: invoice.poNumber || '', client: invoice.client, date: invoice.issued, total: Number(invoice.amount || 0), inContPaq: externalBalance !== null, inSystem: true, sourceStatus: externalBalance !== null ? 'both' : 'system', existsInSystem: true, matchedBy: null, systemInvoiceId: invoice.id, balanceSystem: reconciliationBalance(invoice), balanceContPaq: externalBalance, validation: externalBalance === null ? 'missing' : Math.abs(reconciliationBalance(invoice) - externalBalance) < 0.01 ? 'valid' : 'amount-different' }; });
    const rows = [...contpaqRows, ...systemOnlyRows];
    const source = (await recordByKey(sql, 'systemFiles', '_system/reconciliation.xlsx'))?.record?.name || 'reconciliation.xlsx';
    const payload = { source, statementSource: snapshot?.source || null, statementUploadedAt: snapshot?.uploadedAt || null, rows, totals: { excel: contpaqRows.length, found: contpaqRows.filter(row => row.sourceStatus === 'both').length, missing: contpaqRows.filter(row => row.sourceStatus === 'contpaq' && row.validation === 'missing').length, system: invoices.length, both: rows.filter(row => row.sourceStatus === 'both').length, contpaqOnly: rows.filter(row => row.sourceStatus === 'contpaq').length, systemOnly: rows.filter(row => row.sourceStatus === 'system').length } };
    const cache = reconciliationCache('invoices');
    const storedSnapshot = buildReconciliationSnapshot('invoices', { payload }, { source, statementUploadedAt: snapshot?.uploadedAt || null });
    await saveRecord(sql, cache.collection, cache.key, storedSnapshot, 0);
    reconciliationSnapshotMemory.set('invoices', storedSnapshot);
    return json(reconciliationPage(payload, url));
  }

  if (path === '/api/reconciliation/credits' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const cachedPage = await readReconciliationSnapshotPage(sql, 'credits', url);
    if (cachedPage) return json(reconciliationPageResult(cachedPage));
    const bytes = await oraclePdfBytes(env, '_system/credit-reconciliation.xlsx');
    if (!bytes) return json({ rows: [], source: 'No hay Excel de créditos cargado', totals: { excel: 0, system: 0, both: 0, missing: 0, different: 0 } });
    const workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
    const rowsFromExcel = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' }).map(row => ({ po: String(row.Serie ?? row['Serie / PO'] ?? row.PO ?? '').trim(), folio: String(row.Folio ?? '').trim(), date: normalizeExcelDate(row.Fecha), client: String(row['Razón Social'] ?? row['Razon Social'] ?? '').trim(), amount: Number(String(row.Total ?? '').replace(/[$,\s]/g, '')) || 0, agent: String(row['Nombre del agente'] ?? row['Nombre del agente '] ?? '').trim() })).filter(row => normalizeReference(row.po));
    const invoices = await reconciliationInvoices(sql);
    const systemRows = invoices.flatMap(invoice => (invoice.credits || []).map(credit => ({ po: invoice.poNumber || '', folio: invoice.folio || '', date: String(credit.date || credit.dateProcessed || '').slice(0, 10), client: invoice.client || '', amount: Number(credit.amount || 0), creditNumber: String(credit.creditNumber || '') })).filter(row => normalizeReference(row.po)));
    const key = row => `${normalizeReference(row.po)}|${clientKey(row.client)}`;
    const keys = [...new Set([...rowsFromExcel.map(key), ...systemRows.map(key)])];
    const rows = keys.map(groupKey => { const excel = rowsFromExcel.filter(row => key(row) === groupKey); const system = systemRows.filter(row => key(row) === groupKey); const excelAmount = excel.reduce((sum, row) => sum + row.amount, 0); const systemAmount = system.reduce((sum, row) => sum + row.amount, 0); const both = excel.length && system.length; const validation = excel.length > 1 || system.length > 1 ? 'duplicate' : !both ? 'missing' : Math.abs(excelAmount - systemAmount) < 0.01 ? 'valid' : 'amount-different'; return { po: excel[0]?.po || system[0]?.po || '', folios: [...new Set([...system.map(row => row.creditNumber), ...excel.map(row => row.folio)].filter(Boolean))].join(', '), client: system[0]?.client || excel[0]?.client || '', date: excel[0]?.date || system[0]?.date || '', systemCredits: [...new Set(system.map(row => row.creditNumber).filter(Boolean))].join(', '), systemAmount: system.length ? Number(systemAmount.toFixed(2)) : null, excelAmount: excel.length ? Number(excelAmount.toFixed(2)) : null, difference: both ? Number((systemAmount - excelAmount).toFixed(2)) : null, agent: excel[0]?.agent || '', systemCount: system.length, excelCount: excel.length, sourceStatus: both ? 'both' : system.length ? 'system' : 'excel', validation }; }).sort((a, b) => a.po.localeCompare(b.po, undefined, { numeric: true }));
    const source = (await recordByKey(sql, 'systemFiles', '_system/credit-reconciliation.xlsx'))?.record?.name || 'credit-reconciliation.xlsx';
    const payload = { source, rows, totals: { excel: rowsFromExcel.length, system: systemRows.length, both: rows.filter(row => row.sourceStatus === 'both').length, missing: rows.filter(row => row.validation === 'missing').length, different: rows.filter(row => row.validation === 'amount-different').length } };
    const cache = reconciliationCache('credits');
    const storedSnapshot = buildReconciliationSnapshot('credits', { payload }, { source });
    await saveRecord(sql, cache.collection, cache.key, storedSnapshot, 0);
    reconciliationSnapshotMemory.set('credits', storedSnapshot);
    return json(reconciliationPage(payload, url));
  }

  const checkMatch = path.match(/^\/api\/checks\/([^/]+)$/);
  if (checkMatch && request.method === 'DELETE') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const [row, invoices, checks] = await Promise.all([recordByKey(sql, 'checks', checkMatch[1]), collection(sql, 'invoices'), collection(sql, 'checks')]);
    if (!row) return json({ message: 'El cheque no existe.' }, 404);
    const needsWalmex = [...(row.record.allocations || []), ...(row.record.customerCredit?.applications || [])]
      .some(allocation => String(allocation.invoiceId || '').toLowerCase().startsWith('walmex-'))
      || String(row.record.customerCredit?.sourceInvoiceId || '').toLowerCase().startsWith('walmex-');
    const walmex = needsWalmex ? await loadWalmexInvoices(env.WALMEX_DATABASE_URL, checks) : [];
    const allInvoices = [...invoices, ...walmex];
    reverseCheckAllocations(allInvoices, row.record);
    const changedIds = new Set([
      ...(row.record.allocations || []).map(item => String(item.invoiceId)),
      ...(row.record.customerCredit?.applications || []).map(item => String(item.invoiceId)),
    ]);
    for (const invoice of invoices.filter(item => changedIds.has(String(item.id)))) {
      if (!invoice) continue;
      const invoiceRow = await recordByKey(sql, 'invoices', invoice.id);
      await saveRecord(sql, 'invoices', invoice.id, invoice, invoiceRow?.position ?? null);
    }
    await removeRecord(sql, 'checks', checkMatch[1]);
    return json({ message: `Cheque ${row.record.series} eliminado y saldo restaurado.` });
  }

  if (checkMatch && request.method === 'PATCH') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const [row, invoices, checks] = await Promise.all([recordByKey(sql, 'checks', checkMatch[1]), collection(sql, 'invoices'), collection(sql, 'checks')]);
    if (!row) return json({ message: 'El cheque no existe.' }, 404);
    if (row.record.customerCredit) return json({ message: 'Este cheque tiene saldo a favor relacionado. Para modificarlo, elimínalo primero; se restaurarán todas sus aplicaciones.' }, 409);
    const body = await request.json();
    const date = body?.date !== undefined ? String(body.date || '').trim() : row.record.date;
    const series = body?.series !== undefined ? String(body.series || '').trim() : row.record.series;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ message: 'La fecha del cheque no es válida.' }, 400);
    if (!series) return json({ message: 'Captura la serie o número del cheque.' }, 400);
    const allocations = (Array.isArray(body?.allocations) ? body.allocations : row.record.allocations || []).map(item => ({ invoiceId: normalizeInvoiceId(item.invoiceId), amount: Number(item.amount) })).filter(item => item.invoiceId !== null && Number.isFinite(item.amount) && item.amount > 0);
    const needsWalmex = [...(row.record.allocations || []), ...(row.record.customerCredit?.applications || [])].some(allocation => String(allocation.invoiceId || '').toLowerCase().startsWith('walmex-'))
      || String(row.record.customerCredit?.sourceInvoiceId || '').toLowerCase().startsWith('walmex-')
      || allocations.some(allocation => String(allocation.invoiceId || '').toLowerCase().startsWith('walmex-'));
    const walmex = needsWalmex ? await loadWalmexInvoices(env.WALMEX_DATABASE_URL, checks) : [];
    const allInvoices = [...invoices, ...walmex];
    reverseCheckAllocations(allInvoices, row.record);
    for (const allocation of allocations) {
      const invoice = allInvoices.find(item => invoiceIdMatches(item.id, allocation.invoiceId));
      if (!invoice || allocation.amount > invoiceBalance(invoice) + 0.01) {
        applyCheckAllocations(allInvoices, row.record.allocations || []);
        return json({ message: invoice ? `El monto de la factura ${invoice.folio} excede su saldo disponible (${invoiceBalance(invoice).toFixed(2)}).` : 'Una de las facturas ya no existe.' }, 400);
      }
    }
    const applied = applyCheckAllocations(allInvoices, allocations);
    const affected = new Set([...(row.record.allocations || []).map(item => String(item.invoiceId)), ...applied.map(item => String(item.invoiceId))]);
    for (const invoice of invoices.filter(item => affected.has(String(item.id)))) {
      const invoiceRow = await recordByKey(sql, 'invoices', invoice.id);
      await saveRecord(sql, 'invoices', invoice.id, invoice, invoiceRow?.position ?? null);
    }
    Object.assign(row.record, { date, series, total: Number(applied.reduce((sum, item) => sum + item.amount, 0).toFixed(2)), allocations: applied });
    await saveRecord(sql, 'checks', row.record.id, row.record, row.position);
    return json({ message: `Cheque ${series} actualizado correctamente.`, check: row.record });
  }

  if (path === '/api/agents' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const agents = await collection(sql, 'agents');
    return json(agents.map(agent => ({ ...agent, clients: normalizeAgentClients(agent.clients) })).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es')));
  }

  if (path === '/api/agents' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const name = String(body?.name || '').trim();
    if (!name) return json({ message: 'El nombre del agente es obligatorio.' }, 400);
    const agents = await collection(sql, 'agents');
    if (agents.some(agent => String(agent.name || '').toLowerCase() === name.toLowerCase())) return json({ message: 'Ya existe un agente con ese nombre.' }, 409);
    const agent = { id: Date.now(), name, email: String(body?.email || '').trim(), clients: normalizeAgentClients(body?.clients), createdAt: new Date().toISOString() };
    await saveRecord(sql, 'agents', agent.id, agent, agents.length);
    return json(agent, 201);
  }

  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && request.method === 'PUT') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'agents', agentMatch[1]);
    if (!row) return json({ message: 'Agente no encontrado.' }, 404);
    const body = await request.json();
    const agents = await collection(sql, 'agents');
    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return json({ message: 'El nombre del agente es obligatorio.' }, 400);
      if (agents.some(item => String(item.id) !== String(row.record.id) && String(item.name || '').toLowerCase() === name.toLowerCase())) return json({ message: 'Ya existe un agente con ese nombre.' }, 409);
      row.record.name = name;
    }
    if (body?.email !== undefined) row.record.email = String(body.email).trim();
    if (body?.clients !== undefined) row.record.clients = normalizeAgentClients(body.clients);
    await saveRecord(sql, 'agents', row.record.id, row.record, row.position);
    return json(row.record);
  }

  if (agentMatch && request.method === 'DELETE') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'agents', agentMatch[1]);
    if (!row) return json({ message: 'Agente no encontrado.' }, 404);
    await removeRecord(sql, 'agents', agentMatch[1]);
    return json({ ok: true });
  }

  if (path === '/api/users' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const users = await collection(sql, 'users');
    return json(users.map(publicAdminUser).sort((a, b) => Number(b.id || 0) - Number(a.id || 0)));
  }

  if (path === '/api/users' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const name = String(body?.name || '').trim();
    const username = String(body?.username || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!name || !username || !email || !password) return json({ message: 'Nombre, usuario, correo y contraseña son obligatorios.' }, 400);
    if (password.length < 8) return json({ message: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
    const users = await collection(sql, 'users');
    if (users.some(item => String(item.username || '').toLowerCase() === username.toLowerCase())) return json({ message: 'Ese nombre de usuario ya está registrado.' }, 409);
    if (users.some(item => String(item.email || '').toLowerCase() === email)) return json({ message: 'Ese correo ya está registrado.' }, 409);
    const newUser = {
      id: Date.now(),
      name,
      clientKey: clientKey(name),
      username,
      email,
      assignedClients: Array.isArray(body?.assignedClients) ? body.assignedClients : [],
      permissions: sanitizePermissions(body?.permissions),
      role: body?.role === 'admin' ? 'admin' : 'client',
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: await bcrypt.hash(password, 12),
    };
    await saveRecord(sql, 'users', newUser.id, newUser, users.length);
    return json(publicAdminUser(newUser), 201);
  }

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === 'PATCH') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const userId = userMatch[1];
    const row = await recordByKey(sql, 'users', userId);
    if (!row) return json({ message: 'Usuario no encontrado.' }, 404);
    const target = row.record;
    const body = await request.json();
    const users = await collection(sql, 'users');
    const normalizedUsername = body?.username ? String(body.username).trim().toLowerCase() : String(target.username || '').toLowerCase();
    const normalizedEmail = body?.email ? String(body.email).trim().toLowerCase() : String(target.email || '').toLowerCase();
    if (users.some(item => String(item.id) !== String(target.id) && String(item.username || '').toLowerCase() === normalizedUsername)) return json({ message: 'Ese nombre de usuario ya está registrado.' }, 409);
    if (users.some(item => String(item.id) !== String(target.id) && String(item.email || '').toLowerCase() === normalizedEmail)) return json({ message: 'Ese correo ya está registrado.' }, 409);
    if (body?.password && String(body.password).length < 8) return json({ message: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
    if (body?.name) { target.name = String(body.name).trim(); target.clientKey = clientKey(target.name); }
    if (body?.username) target.username = String(body.username).trim();
    if (body?.email) target.email = normalizedEmail;
    if (typeof body?.active === 'boolean') target.active = body.active;
    if (Array.isArray(body?.assignedClients)) target.assignedClients = body.assignedClients;
    if (Array.isArray(body?.permissions)) target.permissions = sanitizePermissions(body.permissions);
    if (body?.role === 'admin' || body?.role === 'client') {
      if (String(target.id) === '1' && body.role !== 'admin') return json({ message: 'El administrador principal debe conservar su perfil.' }, 400);
      if (String(target.id) === String(user.id) && body.role !== 'admin') return json({ message: 'No puedes retirar tu propio acceso administrativo.' }, 400);
      target.role = body.role;
    }
    if (body?.password) target.passwordHash = await bcrypt.hash(String(body.password), 12);
    await saveRecord(sql, 'users', target.id, target, row.position);
    return json(publicAdminUser(target));
  }

  if (userMatch && request.method === 'DELETE') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const userId = userMatch[1];
    const row = await recordByKey(sql, 'users', userId);
    if (!row) return json({ message: 'Usuario no encontrado.' }, 404);
    const target = row.record;
    if (String(target.id) === String(user.id) || String(target.id) === '1') return json({ message: 'No puedes eliminar el administrador principal ni tu propia cuenta.' }, 400);
    if (target.role === 'admin') {
      const admins = (await collection(sql, 'users')).filter(item => item.role === 'admin');
      if (admins.length <= 1) return json({ message: 'Debe existir al menos un administrador.' }, 400);
    }
    const invoices = await collection(sql, 'invoices');
    const targetKey = target.clientKey || clientKey(target.name);
    await removeRecord(sql, 'users', userId);
    return new Response(null, { status: 204, headers: { 'x-cfbc-api': 'direct' } });
  }

  if (path === '/api/email-log' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const entries = (await collection(sql, 'emailLog')).map(entry => ({
      invoiceId: entry.invoiceId,
      creditNumber: entry.creditNumber || '',
      statementKey: entry.statementKey || '',
      sentAt: entry.sentAt,
      to: Array.isArray(entry.to) ? entry.to : [],
      includedReceiving: !!entry.includedReceiving
    }));
    return json({ entries });
  }

  // Actividad del portal: quien entra y quien todavia no. Devuelve el resumen
  // ya digerido, no las filas de la bitacora.
  if (path === '/api/portal-activity' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const [accessLog, emailLog, invoices] = await Promise.all([
      collection(sql, 'portalAccessLog'), collection(sql, 'emailLog'), collection(sql, 'invoices'),
    ]);
    return json(summarizeActivity({
      accessLog, emailLog, invoices,
      normalizeKey: clientKey,
      from: String(url.searchParams.get('from') || '').trim(),
      to: String(url.searchParams.get('to') || '').trim(),
    }));
  }

  if (path === '/api/email-templates' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const templates = await collection(sql, 'emailTemplates');
    return json({ templates: templates.map(summarizeEmailTemplate), mailReady: Boolean(env.MAIL_FROM && env.SHAREPOINT_CLIENT_ID && env.SHAREPOINT_CLIENT_SECRET && env.SHAREPOINT_TENANT_ID), mailFrom: env.MAIL_FROM || '', mailFromCentro: env.MAIL_FROM_CENTRO || '' });
  }

  if (path === '/api/email-status' && request.method === 'GET') {
    return json(publicEmailStatus({
      mailReady: Boolean(env.MAIL_FROM && env.SHAREPOINT_CLIENT_ID && env.SHAREPOINT_CLIENT_SECRET && env.SHAREPOINT_TENANT_ID),
      mailFrom: env.MAIL_FROM,
      mailFromCentro: env.MAIL_FROM_CENTRO,
    }));
  }

  const emailTemplateMatch = path.match(/^\/api\/email-templates\/([^/]+)$/);
  if (emailTemplateMatch && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const requestedKey = decodeURIComponent(emailTemplateMatch[1]);
    const templates = await collection(sql, 'emailTemplates');
    const template = templates.find(item => String(item.clientKey || '') === requestedKey);
    if (!template) return json({ message: 'Plantilla no encontrada.' }, 404);
    return json({ template });
  }

  const sendInvoiceMatch = path.match(/^\/api\/invoices\/([^/]+)\/send-email$/);
  if (sendInvoiceMatch && request.method === 'POST') {
    if (!env.MAIL_FROM || !env.SHAREPOINT_TENANT_ID || !env.SHAREPOINT_CLIENT_ID || !env.SHAREPOINT_CLIENT_SECRET) return json({ message: 'El envío de correo no está configurado en Cloudflare.' }, 503);
    const invoices = await collection(sql, 'invoices');
    const invoice = invoices.find(item => String(item.id) === String(sendInvoiceMatch[1]));
    if (!invoice) return json({ message: 'Factura no encontrada.' }, 404);
    if (!canSendEmailForInvoice(user, invoice, clientKey)) return json({ message: 'No tienes permiso para enviar esta factura.' }, 403);
    const body = await request.json();
    const recipients = resolveEmailDeliveryRecipients(user, body?.to, body?.cc);
    const to = parseRecipients(recipients.to);
    const cc = parseRecipients(recipients.cc);
    if (!to.length) return json({ message: 'Captura al menos un destinatario válido.' }, 400);
    const subject = applyPlaceholders(body?.subject, invoice).trim();
    if (!subject) return json({ message: 'Captura el asunto del correo.' }, 400);
    const invoiceBytes = await oraclePdfBytes(env, invoice.invoicePdfPath);
    if (!invoiceBytes) return json({ message: 'El PDF de la factura no está disponible.' }, 404);
    const buffers = [invoiceBytes];
    let includesReceiving = false;
    if (invoice.receivingPdfPath) {
      const receivingBytes = await oraclePdfBytes(env, invoice.receivingPdfPath);
      if (receivingBytes) { buffers.push(receivingBytes); includesReceiving = true; }
    }
    const logo = String(body?.logo || '');
    const logoHtml = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo) ? `<p style="margin:0 0 16px"><img src="${logo}" alt="" style="max-width:220px;height:auto"></p>` : '';
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933">${logoHtml}${applyPlaceholders(body?.bodyHtml, invoice)}</div>`;
    const attachmentBytes = await mergePdfBuffers(buffers);
    const attachmentName = `${String(invoice.folio || invoice.id).replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
    await sendGraphMail(env, { to, cc, subject, html, attachment: { name: attachmentName, bytes: attachmentBytes }, from: senderForIssuer(env, invoiceIssuerKey(invoice)) });
    const entry = { id: Date.now(), invoiceId: invoice.id, folio: invoice.folio || '', clientKey: invoice.clientKey || clientKey(invoice.client), client: invoice.client || '', to, cc, subject, includedReceiving: includesReceiving, sentAt: new Date().toISOString(), sentBy: user.email || '', sentByRole: user.role === 'admin' ? 'admin' : 'client' };
    const emailLog = await collection(sql, 'emailLog');
    await saveRecord(sql, 'emailLog', entry.id, entry, emailLog.length);
    if (user.role === 'admin' && shouldSaveEmailTemplate(body?.saveTemplate)) {
      const templateKey = String(body?.clientKey || '').trim() || invoice.clientKey || clientKey(invoice.client);
      const templates = await collection(sql, 'emailTemplates');
      const existing = templates.find(item => String(item.clientKey || '') === templateKey);
      const template = { clientKey: templateKey, client: invoice.client || '', to: String(body?.to || '').trim(), cc: String(body?.cc || '').trim(), subject: String(body?.subject || '').trim(), bodyHtml: String(body?.bodyHtml || ''), logo, updatedAt: new Date().toISOString(), updatedBy: user.email || '' };
      if (existing) {
        const rows = await sql.query('SELECT record_key, position FROM app_records WHERE collection = $1 AND record->>\'clientKey\' = $2 LIMIT 1', ['emailTemplates', templateKey]);
        await saveRecord(sql, 'emailTemplates', rows[0]?.record_key || existing.id || templateKey, template, rows[0]?.position ?? null);
      } else {
        await saveRecord(sql, 'emailTemplates', await nextNumericId(sql, 'emailTemplates'), template, templates.length);
      }
      await upsertEmailTemplate(sql, String(body?.companyKey || '').trim(), {
        subject: template.subject,
        bodyHtml: template.bodyHtml,
        logo,
        updatedBy: user.email || ''
      });
    }
    return json({ message: includesReceiving ? `Factura ${invoice.folio} y su recibimiento enviados.` : `Factura ${invoice.folio} enviada. Esta factura todavía no tiene recibimiento.`, entry });
  }

  if (path === '/api/account-statement/send-email' && request.method === 'POST') {
    if (!env.MAIL_FROM || !env.SHAREPOINT_TENANT_ID || !env.SHAREPOINT_CLIENT_ID || !env.SHAREPOINT_CLIENT_SECRET) return json({ message: 'El envío de correo no está configurado en Cloudflare.' }, 503);
    const body = await request.json();
    const invoices = await collection(sql, 'invoices');
    if (!canSendStatementForCustomer(user, body?.client, invoices, clientKey)) return json({ message: 'No tienes permiso para enviar el estado de cuenta de este cliente.' }, 403);
    const recipients = resolveEmailDeliveryRecipients(user, body?.to, body?.cc);
    const to = parseRecipients(recipients.to);
    const cc = parseRecipients(recipients.cc);
    if (!to.length) return json({ message: 'Captura al menos un destinatario.' }, 400);
    const attachmentBytes = base64Decode(body?.attachmentBase64);
    if (!attachmentBytes.length) return json({ message: 'El archivo adjunto llegó vacío.' }, 400);
    const logo = String(body?.logo || '');
    const logoHtml = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo) ? `<p style="margin:18px 0 0"><img src="${logo}" alt="" style="max-width:220px;height:auto"></p>` : '';
    // Igual que el servidor local, reemplaza los marcadores enviados por el
    // editor ({{saldo}}, {{fecha}}, {{facturas}}, etc.) antes de enviar.
    const placeholders = body?.placeholders && typeof body.placeholders === 'object' ? body.placeholders : {};
    const filledBody = String(body?.bodyHtml || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
      const normalized = String(key).toLowerCase();
      return Object.prototype.hasOwnProperty.call(placeholders, normalized) ? String(placeholders[normalized]) : match;
    });
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933">${filledBody}${logoHtml}</div>`;
    const issuer = String(body?.issuer || '') === 'centro' ? 'centro' : 'pacifica';
    await sendGraphMail(env, { to, cc, subject: String(body?.subject || '').trim() || 'Estado de cuenta', html, attachment: { name: String(body?.attachmentName || 'estado-de-cuenta').replace(/[\\/:*?"<>|]+/g, '-'), bytes: attachmentBytes, contentType: 'application/octet-stream' }, from: senderForIssuer(env, issuer) });
    if (user.role === 'admin' && shouldSaveEmailTemplate(body?.saveTemplate)) {
      const subject = String(body?.subject || '').trim();
      const bodyHtml = String(body?.bodyHtml || '');
      await upsertEmailTemplate(sql, String(body?.clientKey || '').trim(), {
        client: String(body?.client || ''),
        to: String(body?.to || ''),
        cc: String(body?.cc || ''),
        subject, bodyHtml, logo,
        updatedBy: user.email || ''
      });
      await upsertEmailTemplate(sql, String(body?.companyKey || '').trim(), {
        subject, bodyHtml, logo,
        updatedBy: user.email || ''
      });
    }
    // registro con statementKey: distingue el envio de estado de cuenta del de
    // factura, y es lo que deja ver cuando se le mando a cada cliente
    const stmtLog = await collection(sql, 'emailLog');
    const stmtEntry = {
      id: Date.now(),
      statementKey: String(body?.clientKey || '').trim().replace(/^stmt:/, ''),
      client: String(body?.client || ''),
      to, cc,
      subject: String(body?.subject || '').trim() || 'Estado de cuenta',
      sentAt: new Date().toISOString(),
      sentBy: user.email || '',
      sentByRole: user.role === 'admin' ? 'admin' : 'client'
    };
    await saveRecord(sql, 'emailLog', stmtEntry.id, stmtEntry, stmtLog.length);
    return json({ message: 'Estado de cuenta enviado.' });
  }

  if (path === '/api/invoices/parse' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const form = await request.formData();
      const file = form.get('invoicePdf');
      if (!file || typeof file.arrayBuffer !== 'function') return json({ message: 'Selecciona el PDF de la factura.' }, 400);
      return json(await extractInvoicePdf(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      return json({ message: error?.message || 'No fue posible leer la factura.' }, 400);
    }
  }

  if (path === '/api/invoices' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const form = await request.formData();
      const invoiceFile = form.get('invoicePdf');
      const receivingFile = form.get('receivingPdf');
      const extracted = invoiceFile && typeof invoiceFile.arrayBuffer === 'function' ? await extractInvoicePdf(new Uint8Array(await invoiceFile.arrayBuffer())) : {};
      const field = name => form.has(name) && String(form.get(name) ?? '').trim() !== '' ? String(form.get(name)).trim() : extracted[name];
      const folio = field('folio');
      const poNumber = field('poNumber');
      const guideNumber = field('guideNumber');
      const client = field('client');
      const location = field('location') || '';
      const email = field('email');
      const concept = field('concept');
      const issued = field('issued');
      const due = field('due');
      const amount = Number(field('amount'));
      const status = field('status') || 'Pendiente';
      if (!client || !email || !concept || !issued || !due || !Number.isFinite(amount) || amount < 0) return json({ message: 'Completa todos los datos de la factura.' }, 400);
      if (!['Pagada', 'Pendiente', 'Vencida'].includes(status)) return json({ message: 'Estado de factura inválido.' }, 400);
      const invoices = await collection(sql, 'invoices');
      const id = Date.now();
      const numericFolios = invoices.map(item => Number(String(item.folio || '').split('-').pop())).filter(Number.isFinite);
      const generatedFolio = `FAC-${new Date().getFullYear()}-${String(Math.max(48, ...numericFolios) + 1).padStart(4, '0')}`;
      let invoiceBytes = null;
      let receivingBytes = null;
      if (invoiceFile && typeof invoiceFile.arrayBuffer === 'function') invoiceBytes = new Uint8Array(await invoiceFile.arrayBuffer());
      if (receivingFile && typeof receivingFile.arrayBuffer === 'function') receivingBytes = await ensurePdfBytes(receivingFile);
      const invoicePdfPath = invoiceBytes ? `${id}-invoice.pdf` : '';
      const receivingPdfPath = receivingBytes ? `${id}-receiving.pdf` : '';
      if (invoiceBytes) await putOracleObject(env, invoicePdfPath, invoiceBytes);
      if (receivingBytes) await putOracleObject(env, receivingPdfPath, receivingBytes);
      const invoice = { id, folio: String(folio || generatedFolio).trim(), poNumber: String(poNumber || '').trim(), guideNumber: String(guideNumber || '').trim(), client: String(client).trim(), location, clientKey: clientKey(client), email: String(email).trim().toLowerCase(), concept: String(concept).trim(), searchText: extracted.searchText || '', issued, due, amount, status, invoiceFileName: invoiceFile?.name || '', receivingFileName: receivingFile?.name || '', invoicePdfPath, receivingPdfPath, invoiceSharePointUrl: '', receivingSharePointUrl: '', sharePointStorage: { client: String(client).trim(), location, issued, folio: String(folio || generatedFolio).trim() } };
      await applyPendingCustomerCreditAndPersist(sql, invoice);
      await saveRecord(sql, 'invoices', id, invoice, invoices.length);
      return json(invoice, 201);
    } catch (error) {
      return json({ message: error?.message || 'No se pudo registrar la factura.' }, 500);
    }
  }

  if (path === '/api/invoices/sync-statement' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const file = (await request.formData()).get('statementFile');
      if (!file || typeof file.arrayBuffer !== 'function') return json({ message: 'Selecciona el archivo de Estado de Cuenta (Excel).' }, 400);
      const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
      const sheetName = workbook.SheetNames.find(name => name.toUpperCase() === 'INVOICE');
      if (!sheetName) return json({ message: 'El archivo no contiene la pestaña INVOICE.' }, 400);
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
      let headerIndex = -1;
      for (let index = 0; index < Math.min(20, data.length); index += 1) { const text = (data[index] || []).join(' ').toLowerCase(); if (text.includes('date') && text.includes('po') && text.includes('invoice')) { headerIndex = index; break; } }
      if (headerIndex < 0) return json({ message: 'No se encontraron los encabezados (Date, PO, Invoice) en la hoja INVOICE.' }, 400);
      const amount = value => { if (typeof value === 'number') return Number.isFinite(value) ? value : 0; const parsed = Number(String(value ?? '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(parsed) ? parsed : 0; };
      const statementRows = [];
      for (let index = headerIndex + 1; index < data.length; index += 1) {
        const row = data[index] || [];
        const po = String(row[1] || '').trim(); const invoice = String(row[2] || '').trim();
        if (!po && !invoice) continue;
        statementRows.push({ po, invoice, date: normalizeExcelDate(row[0]), balance: amount(row[3]) + amount(row[4]) + amount(row[5]) + amount(row[6]), sourceRow: index + 1 });
      }
      const invoices = await collection(sql, 'invoices');
      const matching = matchStatementRows(invoices, statementRows);
      const matchByInvoice = new Map(matching.matches.map(match => [match.invoiceIndex, match]));
      const issues = [];
      const snapshotEntries = [];
      let updatedBalances = 0;
      let markedPaid = 0;
      const paidCutoff = new Date('2026-07-31T23:59:59Z');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let index = 0; index < invoices.length; index += 1) {
        const invoice = invoices[index]; const assignment = matchByInvoice.get(index);
        if (assignment) {
          const statement = statementRows[assignment.rowIndex];
          invoice.balance = statement.balance;
          invoice.status = statement.balance <= 0.01 ? 'Pagada' : invoice.due && new Date(`${invoice.due}T23:59:59`) < today ? 'Vencida' : 'Pendiente';
          updatedBalances += 1;
          snapshotEntries.push({ systemInvoiceId: invoice.id, folio: invoice.folio, po: invoice.poNumber || '', balance: statement.balance, found: true, matchMethod: assignment.method, sourceRow: statement.sourceRow, date: statement.date, statementInvoice: statement.invoice, statementPo: statement.po });
        } else {
          issues.push({ invoice: invoice.folio, po: invoice.poNumber || '', status: 'missing', reason: 'La factura no fue encontrada en el Estado de Cuenta cargado.' });
          const issued = new Date(invoice.issued);
          const historical = !Number.isNaN(issued.getTime()) && issued <= paidCutoff;
          if (historical) { if (invoice.status !== 'Pagada') markedPaid += 1; invoice.status = 'Pagada'; invoice.balance = 0; }
          else if (invoice.balance === undefined) invoice.balance = invoice.amount;
          snapshotEntries.push({ systemInvoiceId: invoice.id, folio: invoice.folio, po: invoice.poNumber || '', balance: historical ? 0 : null, found: false, matchMethod: null, sourceRow: null, statementInvoice: '', statementPo: '' });
        }
      }
      await saveRecords(sql, 'invoices', invoices);
      const unmatchedRows = matching.unmatchedRowIndexes.map(index => statementRows[index]);
      unmatchedRows.forEach(row => issues.push({ invoice: row.invoice, po: row.po, status: 'unmatched-statement-row', reason: `La fila ${row.sourceRow} del Estado de Cuenta no tiene una coincidencia única en el sistema.` }));
      const snapshot = { source: file.name, uploadedAt: new Date().toISOString(), entries: snapshotEntries, unmatchedRows };
      await saveRecord(sql, 'statementSnapshots', 'current', snapshot, 0);
      await removeRecord(sql, 'reconciliationSnapshots', 'current');
      reconciliationSnapshotMemory.delete('invoices');
      return json({ message: `Sincronización completada. ${updatedBalances} saldos actualizados, ${markedPaid} facturas marcadas como Pagadas.`, updatedBalances, markedPaid, unmatchedStatementRows: unmatchedRows.length, issues });
    } catch (error) { return json({ message: error?.message || 'No se pudo sincronizar el Estado de Cuenta.' }, 500); }
  }

  const receivingUploadMatch = path.match(/^\/api\/invoices\/([^/]+)\/receiving$/);
  if (receivingUploadMatch && request.method === 'PATCH') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const row = await recordByKey(sql, 'invoices', receivingUploadMatch[1]);
      if (!row) return json({ message: 'Factura no encontrada.' }, 404);
      const file = (await request.formData()).get('receivingPdf');
      if (!file || typeof file.arrayBuffer !== 'function') return json({ message: 'Selecciona el PDF de recibimiento.' }, 400);
      const bytes = await ensurePdfBytes(file);
      const objectName = `${row.record.id}-receiving-${Date.now()}.pdf`;
      await putOracleObject(env, objectName, bytes);
      const oldPath = row.record.receivingPdfPath;
      Object.assign(row.record, { receivingFileName: file.name || objectName, receivingPdfPath: objectName });
      await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
      if (oldPath && oldPath !== objectName) await deleteOracleObject(env, oldPath).catch(() => {});
      return json(row.record);
    } catch (error) { return json({ message: error?.message || 'No se pudo cargar el recibimiento.' }, 500); }
  }

  const invoiceUploadMatch = path.match(/^\/api\/invoices\/([^/]+)\/invoice-pdf$/);
  if (invoiceUploadMatch && request.method === 'PATCH') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const row = await recordByKey(sql, 'invoices', invoiceUploadMatch[1]);
      if (!row) return json({ message: 'Factura no encontrada.' }, 404);
      const file = (await request.formData()).get('invoicePdf');
      if (!file || typeof file.arrayBuffer !== 'function') return json({ message: 'Selecciona el PDF de la factura.' }, 400);
      const bytes = await ensurePdfBytes(file);
      const objectName = `${row.record.id}-invoice-${Date.now()}.pdf`;
      await putOracleObject(env, objectName, bytes);
      const oldPath = row.record.invoicePdfPath;
      Object.assign(row.record, { invoiceFileName: file.name || objectName, invoicePdfPath: objectName });
      await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
      if (oldPath && oldPath !== objectName) await deleteOracleObject(env, oldPath).catch(() => {});
      return json(row.record);
    } catch (error) { return json({ message: error?.message || 'No se pudo cargar la factura.' }, 500); }
  }

  const invoiceMutationMatch = path.match(/^\/api\/invoices\/([^/]+)$/);
  if (invoiceMutationMatch && request.method === 'PATCH') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'invoices', invoiceMutationMatch[1]);
    if (!row) return json({ message: 'Factura no encontrada.' }, 404);
    const body = await request.json();
    if (body?.status && !['Pagada', 'Pendiente', 'Vencida'].includes(body.status)) return json({ message: 'Estado inválido.' }, 400);
    const editable = ['folio', 'poNumber', 'guideNumber', 'client', 'location', 'email', 'concept', 'issued', 'due', 'amount', 'status', 'balance'];
    const changes = Object.fromEntries(Object.entries(body || {}).filter(([key]) => editable.includes(key)));
    const invoice = row.record;
    if (changes.client !== undefined && !String(changes.client).trim()) return json({ message: 'El nombre del cliente es obligatorio.' }, 400);
    if (changes.email !== undefined && !String(changes.email).trim()) return json({ message: 'El correo electrónico es obligatorio.' }, 400);
    if (changes.concept !== undefined && !String(changes.concept).trim()) return json({ message: 'La descripción es obligatoria.' }, 400);
    if (changes.issued !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.issued))) return json({ message: 'La fecha de emisión no es válida.' }, 400);
    if (changes.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(changes.due))) return json({ message: 'La fecha de vencimiento no es válida.' }, 400);
    if (changes.amount !== undefined && (!Number.isFinite(Number(changes.amount)) || Number(changes.amount) <= 0)) return json({ message: 'El importe debe ser mayor que cero.' }, 400);
    if (changes.balance !== undefined && (!Number.isFinite(Number(changes.balance)) || Number(changes.balance) < 0)) return json({ message: 'El saldo debe ser un número mayor o igual a cero.' }, 400);
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'client') { invoice.client = String(value).trim(); invoice.clientKey = clientKey(invoice.client); }
      else if (key === 'email') invoice.email = String(value).trim().toLowerCase();
      else if (['amount', 'balance'].includes(key)) invoice[key] = Number(value);
      else invoice[key] = String(value).trim();
    }
    invoice.sharePointStorage = { ...(invoice.sharePointStorage || {}), client: invoice.client, location: invoice.location || '', issued: invoice.issued, folio: invoice.folio };
    await saveRecord(sql, 'invoices', invoice.id, invoice, row.position);
    return json(invoice);
  }

  if (invoiceMutationMatch && request.method === 'DELETE') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'invoices', invoiceMutationMatch[1]);
    if (!row) return json({ message: 'Factura no encontrada.' }, 404);
    await Promise.all([deleteOracleObject(env, row.record.invoicePdfPath), deleteOracleObject(env, row.record.receivingPdfPath)]);
    await removeRecord(sql, 'invoices', invoiceMutationMatch[1]);
    return new Response(null, { status: 204, headers: { 'x-cfbc-api': 'direct' } });
  }

  if (path === '/api/support/tickets' && request.method === 'POST') {
    const body = await request.json();
    const category = String(body?.category || '').trim();
    const subject = String(body?.subject || '').trim();
    const message = String(body?.message || '').trim();
    if (!subject || !message) return json({ message: 'Asunto y descripción son obligatorios.' }, 400);
    if (subject.length > 120 || message.length > 2000) return json({ message: 'La solicitud excede la longitud permitida.' }, 400);
    const id = await nextNumericId(sql, 'supportTickets');
    const ticket = { id, number: `SUP-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`, category: category || 'Other', subject, message, userId: user.id, userName: user.name, email: user.email || '', role: user.role, clientKey: user.clientKey || '', status: 'open', createdAt: new Date().toISOString(), replies: [] };
    const tickets = await collection(sql, 'supportTickets');
    await saveRecord(sql, 'supportTickets', id, ticket, tickets.length);
    return json({ message: 'Solicitud registrada.', ticket: { number: ticket.number } }, 201);
  }

  if (path === '/api/support/tickets' && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const tickets = await collection(sql, 'supportTickets');
    return json(tickets.map(ticket => ({ ...ticket, replies: Array.isArray(ticket.replies) ? ticket.replies : [] })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
  }

  if (path === '/api/support/tickets/mine' && request.method === 'GET') {
    const tickets = await collection(sql, 'supportTickets');
    return json(tickets.filter(ticket => String(ticket.userId) === String(user.id)).map(ticket => ({ ...ticket, replies: Array.isArray(ticket.replies) ? ticket.replies : [] })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
  }

  const replyMatch = path.match(/^\/api\/support\/tickets\/([^/]+)\/replies$/);
  if (replyMatch && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'supportTickets', replyMatch[1]);
    if (!row) return json({ message: 'No se encontró el ticket.' }, 404);
    const body = await request.json();
    const message = String(body?.message || '').trim();
    if (!message) return json({ message: 'La respuesta es obligatoria.' }, 400);
    if (message.length > 2000) return json({ message: 'La respuesta excede la longitud permitida.' }, 400);
    const replies = Array.isArray(row.record.replies) ? row.record.replies : [];
    const replyId = replies.reduce((max, reply) => Math.max(max, Number(reply.id) || 0), 0) + 1;
    const reply = { id: replyId, authorId: user.id, authorName: user.name, authorRole: user.role, message, createdAt: new Date().toISOString() };
    replies.push(reply);
    row.record.replies = replies;
    row.record.status = 'in_progress';
    row.record.updatedAt = reply.createdAt;
    await saveRecord(sql, 'supportTickets', row.record.id, row.record, row.position);
    const notificationId = await nextNumericId(sql, 'notifications');
    const notifications = await collection(sql, 'notifications');
    const notification = { id: notificationId, userId: row.record.userId, type: 'support_reply', title: 'Nueva respuesta de atención al cliente', message: `Respondimos a ${row.record.number}.`, ticketId: row.record.id, ticketNumber: row.record.number, read: false, createdAt: reply.createdAt };
    await saveRecord(sql, 'notifications', notificationId, notification, notifications.length);
    return json({ message: 'Respuesta enviada.', ticket: row.record });
  }

  const ticketMatch = path.match(/^\/api\/support\/tickets\/([^/]+)$/);
  if (ticketMatch && request.method === 'PATCH') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const status = String((await request.json())?.status || '').trim();
    if (!new Set(['open', 'in_progress', 'resolved']).has(status)) return json({ message: 'Estado de ticket no válido.' }, 400);
    const row = await recordByKey(sql, 'supportTickets', ticketMatch[1]);
    if (!row) return json({ message: 'No se encontró el ticket.' }, 404);
    row.record.status = status;
    row.record.updatedAt = new Date().toISOString();
    await saveRecord(sql, 'supportTickets', row.record.id, row.record, row.position);
    return json({ message: 'Estado actualizado.', ticket: row.record });
  }

  if (ticketMatch && request.method === 'DELETE') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'supportTickets', ticketMatch[1]);
    if (!row) return json({ message: 'No se encontró el ticket.' }, 404);
    await removeRecord(sql, 'supportTickets', ticketMatch[1]);
    await sql.query("DELETE FROM app_records WHERE collection = 'notifications' AND record->>'ticketId' = $1", [String(row.record.id)]);
    return json({ message: 'Ticket eliminado.' });
  }

  if (path === '/api/notifications' && request.method === 'GET') {
    const notifications = await collection(sql, 'notifications');
    return json(notifications.filter(item => String(item.userId) === String(user.id)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
  }

  const notificationReadMatch = path.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (notificationReadMatch && request.method === 'PATCH') {
    const row = await recordByKey(sql, 'notifications', notificationReadMatch[1]);
    if (!row || String(row.record.userId) !== String(user.id)) return json({ message: 'No se encontró la notificación.' }, 404);
    row.record.read = true;
    await saveRecord(sql, 'notifications', row.record.id, row.record, row.position);
    return json({ message: 'Notificación marcada como leída.' });
  }

  const notificationMatch = path.match(/^\/api\/notifications\/([^/]+)$/);
  if (notificationMatch && request.method === 'DELETE') {
    const row = await recordByKey(sql, 'notifications', notificationMatch[1]);
    if (!row || String(row.record.userId) !== String(user.id)) return json({ message: 'No se encontró la notificación.' }, 404);
    await removeRecord(sql, 'notifications', notificationMatch[1]);
    return json({ message: 'Notificación eliminada.' });
  }

  const printMatch = path.match(/^\/api\/invoices\/([^/]+)\/print-pdf$/);
  if (printMatch && request.method === 'GET') {
    const invoices = await collection(sql, 'invoices');
    const invoice = invoices.find(item => String(item.id) === String(printMatch[1]));
    if (!invoice) return json({ message: 'Factura no encontrada.' }, 404);
    if (user.loginSource === 'email-history' ? !historyInvoiceAccess(user, invoice, clientKey) : (user.role !== 'admin' && clientKey(invoice.client) !== clientKey(user.clientKey) && String(invoice.email || '').toLowerCase() !== String(user.email || '').toLowerCase())) return json({ message: 'No tienes permiso.' }, 403);
    const invoiceBytes = await oraclePdfBytes(env, invoice.invoicePdfPath);
    if (!invoiceBytes) return json({ message: 'El PDF de la factura no está disponible.' }, 404);
    const buffers = [invoiceBytes];
    if (invoice.receivingPdfPath) {
      const receivingBytes = await oraclePdfBytes(env, invoice.receivingPdfPath);
      if (receivingBytes) buffers.push(receivingBytes);
    }
    const merged = await mergePdfBuffers(buffers);
    return new Response(merged, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="Invoice-${String(invoice.folio || invoice.id).replace(/"/g, '')}-Print.pdf"`, 'cache-control': 'private, no-store', 'x-cfbc-api': 'direct' } });
  }

  const sendCreditMatch = path.match(/^\/api\/invoices\/([^/]+)\/send-credit-email$/);
  if (sendCreditMatch && request.method === 'POST') {
    if (!env.MAIL_FROM || !env.SHAREPOINT_TENANT_ID || !env.SHAREPOINT_CLIENT_ID || !env.SHAREPOINT_CLIENT_SECRET) return json({ message: 'El envío de correo no está configurado en Cloudflare.' }, 503);
    const invoices = await collection(sql, 'invoices');
    const invoice = invoices.find(item => String(item.id) === String(sendCreditMatch[1]));
    if (!invoice) return json({ message: 'Factura no encontrada.' }, 404);
    if (!canSendEmailForInvoice(user, invoice, clientKey)) return json({ message: 'No tienes permiso para enviar este crédito.' }, 403);
    const body = await request.json();
    const objectName = selectedCreditPdfPath(invoice, { creditNumber: body?.creditNumber || '', creditPdfPath: body?.creditPath || '' });
    if (!objectName) return json({ message: 'La nota de devolución no está asociada a esta factura.' }, 404);
    const recipients = resolveEmailDeliveryRecipients(user, body?.to, body?.cc);
    const to = parseRecipients(recipients.to);
    if (!to.length) return json({ message: 'Captura al menos un destinatario válido.' }, 400);
    const cc = parseRecipients(recipients.cc);
    const values = body?.placeholders && typeof body.placeholders === 'object' ? body.placeholders : {};
    const fill = text => String(text || '').replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) => {
      const norm = String(key).toLowerCase();
      return Object.prototype.hasOwnProperty.call(values, norm) ? String(values[norm]) : match;
    });
     const subjectTemplate = String(body?.templateSubject || body?.subject || '').trim();
     const subject = fill(subjectTemplate).trim();
    if (!subject) return json({ message: 'Captura el asunto del correo.' }, 400);
    const logo = String(body?.logo || '');
    const logoHtml = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(logo) ? `<p style="margin:0 0 16px"><img src="${logo}" alt="" style="max-width:220px;height:auto"></p>` : '';
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2933">${logoHtml}${fill(body?.bodyHtml)}</div>`;
    const bytes = await oraclePdfBytes(env, objectName);
    if (!bytes) return json({ message: 'El PDF de la devolución no está disponible.' }, 404);
    const issuer = invoiceIssuerKey(invoice);
    await sendGraphMail(env, { to, cc, subject, html, attachment: { name: `Devolucion-${String(body?.creditNumber || invoice.folio || invoice.id).replace(/[\/:*?"<>|]+/g, '-')}.pdf`, bytes }, from: senderForIssuer(env, issuer) });
    if (user.role === 'admin' && body?.saveTemplate) {
       await upsertEmailTemplate(sql, String(body?.companyKey || '').trim(), {
         // Keep template markers in storage. The resolved subject is only for
         // this message; saving it would reuse old credit/invoice values.
         subject: subjectTemplate, bodyHtml: String(body?.bodyHtml || ''), logo, updatedBy: user.email || ''
       });
    }
    const creditLog = await collection(sql, 'emailLog');
    const creditEntry = { id: Date.now(), invoiceId: invoice.id, creditNumber: String(body?.creditNumber || ''), folio: invoice.folio || '', client: invoice.client || '', to, cc, sentAt: new Date().toISOString(), sentBy: user.email || '', sentByRole: user.role === 'admin' ? 'admin' : 'client' };
    await saveRecord(sql, 'emailLog', creditEntry.id, creditEntry, creditLog.length);
    return json({ message: `Devolución ${body?.creditNumber || ''} enviada.`.replace('  ', ' ') });
  }

  const creditsPdfMatch = path.match(/^\/api\/invoices\/([^/]+)\/credits-pdf$/);
  const creditPdfMatch = path.match(/^\/api\/invoices\/([^/]+)\/credit-pdf$/);
  if (creditPdfMatch && request.method === 'GET') {
    const invoices = await collection(sql, 'invoices');
    const invoice = invoices.find(item => String(item.id) === String(creditPdfMatch[1]));
    if (!invoice) return json({ message: 'Factura no encontrada.' }, 404);
    if (user.loginSource === 'email-history' ? !historyInvoiceAccess(user, invoice, clientKey) : (user.role !== 'admin' && clientKey(invoice.client) !== clientKey(user.clientKey) && String(invoice.email || '').toLowerCase() !== String(user.email || '').toLowerCase())) return json({ message: 'No tienes permiso.' }, 403);
    const objectName = selectedCreditPdfPath(invoice, { creditNumber: url.searchParams.get('creditNumber') || '', creditPdfPath: url.searchParams.get('creditPath') || '' });
    if (!objectName) return json({ message: 'El PDF de crédito no está asociado a esta factura.' }, 404);
    const bytes = await oraclePdfBytes(env, objectName);
    if (!bytes) return json({ message: 'El PDF de crédito no está disponible.' }, 404);
    return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="Credit-${String(url.searchParams.get('creditNumber') || invoice.folio || invoice.id).replace(/"/g, '')}.pdf"`, 'cache-control': 'private, no-store', 'x-cfbc-api': 'direct' } });
  }
  if (creditsPdfMatch && request.method === 'GET') {
    const invoices = await collection(sql, 'invoices');
    const invoice = invoices.find(item => String(item.id) === String(creditsPdfMatch[1]));
    if (!invoice) return json({ message: 'Factura no encontrada.' }, 404);
    if (user.loginSource === 'email-history' ? !historyInvoiceAccess(user, invoice, clientKey) : (user.role !== 'admin' && clientKey(invoice.client) !== clientKey(user.clientKey) && String(invoice.email || '').toLowerCase() !== String(user.email || '').toLowerCase())) return json({ message: 'No tienes permiso.' }, 403);
    const paths = (Array.isArray(invoice.credits) ? invoice.credits : []).filter(credit => !credit.creditFlagHidden && credit.creditPdfPath).map(credit => credit.creditPdfPath);
    const buffers = [];
    for (const objectName of paths) {
      const bytes = await oraclePdfBytes(env, objectName);
      if (bytes) buffers.push(bytes);
    }
    if (!buffers.length) return json({ message: 'No hay PDFs de crédito disponibles para esta factura.' }, 404);
    const merged = await mergePdfBuffers(buffers);
    return new Response(merged, { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="Credits-${String(invoice.folio || invoice.id).replace(/"/g, '')}.pdf"`, 'cache-control': 'private, no-store', 'x-cfbc-api': 'direct' } });
  }

  const templateMatch = path.match(/^\/api\/email-templates\/([^/]+)$/);
  if (templateMatch && request.method === 'PUT') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const requestedKey = decodeURIComponent(templateMatch[1]).trim();
    if (!requestedKey) return json({ message: 'Falta el cliente de la plantilla.' }, 400);
    const body = await request.json();
    const templates = await collection(sql, 'emailTemplates');
    const existing = templates.find(item => String(item.clientKey || '') === requestedKey);
    const template = {
      clientKey: requestedKey,
      client: String(body?.client || '').trim(),
      to: String(body?.to || '').trim(),
      cc: String(body?.cc || '').trim(),
      subject: String(body?.subject || '').trim(),
      bodyHtml: String(body?.bodyHtml || ''),
      logo: String(body?.logo || ''),
      updatedAt: new Date().toISOString(),
      updatedBy: user.email || '',
    };
    if (existing) {
      const rows = await sql.query('SELECT record_key, position FROM app_records WHERE collection = $1 AND record->>\'clientKey\' = $2 LIMIT 1', ['emailTemplates', requestedKey]);
      await saveRecord(sql, 'emailTemplates', rows[0]?.record_key || existing.id || requestedKey, template, rows[0]?.position ?? null);
    } else {
      const rows = await sql.query('SELECT COALESCE(MAX((record_key)::bigint), 0) + 1 AS next_key, COALESCE(MAX(position), -1) + 1 AS next_position FROM app_records WHERE collection = $1 AND record_key ~ \'^[0-9]+$\'', ['emailTemplates']);
      await saveRecord(sql, 'emailTemplates', rows[0]?.next_key || Date.now(), template, rows[0]?.next_position ?? null);
    }
    return json({ message: 'Plantilla guardada.', template });
  }

  if (path === '/api/invoices/sync/remove' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const sourceFileId = String((await request.json())?.sourceFileId || '').trim();
    if (!sourceFileId) return json({ message: 'Falta el archivo que se eliminará.' }, 400);
    try {
      const driveId = await getSharePointDrive(env);
      const source = await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!source?.name) return json({ message: 'El archivo ya no está disponible en SharePoint.' }, 404);
      const root = await findRootFolder(env, driveId);
      if (source.parentReference?.id !== root.id) return json({ message: 'Solo se pueden eliminar archivos sueltos de la carpeta de sincronización.' }, 400);
      await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      return json({ message: `Archivo ${source.name} eliminado de la carpeta de sincronización.` });
    } catch (error) { return json({ message: error?.message || 'No se pudo eliminar el archivo.' }, 500); }
  }

  if (path === '/api/invoices/sync/replace' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const sourceFileId = String(body?.sourceFileId || '').trim();
    const row = await recordByKey(sql, 'invoices', body?.existingInvoiceId);
    if (!sourceFileId || !row) return json({ message: 'Faltan los datos de la factura que se reemplazará.' }, 400);
    try {
      const driveId = await getSharePointDrive(env);
      const source = await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!source?.['@microsoft.graph.downloadUrl']) return json({ message: 'El archivo ya no está disponible en SharePoint.' }, 404);
      const response = await fetch(source['@microsoft.graph.downloadUrl']);
      if (!response.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${response.status}).`);
      const bytes = await syncBytesToPdf(env, source.name, new Uint8Array(await response.arrayBuffer()));
      const extracted = await extractInvoicePdf(bytes);
      const invoices = await collection(sql, 'invoices');
      if (invoices.some(item => String(item.id) !== String(row.record.id) && isDuplicateInvoice(item, extracted))) return json({ message: 'Existe otra factura con el mismo cliente y folio.' }, 409);
      const objectName = `${row.record.id}-invoice.pdf`;
      await putOracleObject(env, objectName, bytes);
      Object.assign(row.record, { folio: row.record.folioEditedManually ? row.record.folio : extracted.folio, poNumber: extracted.poNumber || '', guideNumber: extracted.guideNumber || '', client: extracted.client, clientKey: clientKey(extracted.client), location: extracted.location || '', concept: extracted.concept || row.record.concept || 'Factura importada desde PDF', searchText: extracted.searchText || '', issued: extracted.issued || row.record.issued, due: extracted.due || row.record.due, amount: Number(extracted.amount), invoiceFileName: source.name, invoicePdfPath: objectName });
      await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
      await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      return json({ message: `Factura ${row.record.folio} reemplazada correctamente. El recibimiento existente se conservó.`, invoice: row.record });
    } catch (error) { return json({ message: error?.message || 'No se pudo reemplazar la factura.' }, 500); }
  }

  if (path === '/api/invoices/sync/replace-receiving' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const sourceFileId = String(body?.sourceFileId || '').trim();
    const invoiceIds = Array.isArray(body?.invoiceIds) ? body.invoiceIds.map(String) : [];
    if (!sourceFileId || invoiceIds.length !== 1) return json({ message: 'Selecciona exactamente una factura para reemplazar el recibimiento.' }, 400);
    const row = await recordByKey(sql, 'invoices', invoiceIds[0]);
    if (!row) return json({ message: 'No se encontró la factura seleccionada.' }, 404);
    try {
      const driveId = await getSharePointDrive(env);
      const source = await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!source?.['@microsoft.graph.downloadUrl']) return json({ message: 'El recibimiento ya no está disponible en SharePoint.' }, 404);
      const response = await fetch(source['@microsoft.graph.downloadUrl']);
      if (!response.ok) throw new Error(`No se pudo descargar el recibimiento (HTTP ${response.status}).`);
      const bytes = await syncBytesToPdf(env, source.name, new Uint8Array(await response.arrayBuffer()));
      const objectName = `${row.record.id}-receiving.pdf`;
      await putOracleObject(env, objectName, bytes);
      Object.assign(row.record, { receivingPdfPath: objectName, receivingFileName: source.name, receivingSourceFileIds: [sourceFileId] });
      await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
      await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      return json({ message: 'Recibimiento reemplazado y asociado a 1 factura.' });
    } catch (error) { return json({ message: error?.message || 'No se pudo reemplazar el recibimiento.' }, 500); }
  }

  if (path === '/api/credits/sync' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const driveId = await getSharePointDrive(env);
      const root = await findRootFolder(env, driveId);
      const creditFolder = await findChildFolder(env, driveId, root.id, 'Credit');
      const files = (await listDriveChildren(env, driveId, creditFolder.id)).filter(item => !item.folder && /\.pdf$/i.test(item.name));
      let processed = 0;
      let skipped = 0;
      const issues = [];
      const details = [];
      for (const file of files) {
        try {
          if (!file['@microsoft.graph.downloadUrl']) throw new Error('No se pudo obtener el enlace de descarga.');
          const response = await fetch(file['@microsoft.graph.downloadUrl']);
          if (!response.ok) throw new Error(`Descarga fallida (HTTP ${response.status}).`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const extracted = await extractCreditPdf(bytes);
          if ((!extracted.poNumber && !extracted.guideNumber) || extracted.amount <= 0) {
            issues.push({ file: file.name, status: 'warning', reason: 'Falta PO o el importe no es válido.' }); skipped += 1; continue;
          }
          const invoices = await collection(sql, 'invoices');
          const references = [extracted.poNumber, extracted.guideNumber].map(normalizeReference).filter(Boolean);
          const matches = invoices.filter(invoice => {
            const invoiceRefs = [invoice.poNumber, invoice.guideNumber, invoice.folio, invoice.invoiceFileName].map(normalizeReference).filter(Boolean);
            return references.some(target => invoiceRefs.some(reference => reference === target || reference.includes(target)));
          });
          const customerMatches = matches.filter(invoice => extracted.client && clientKey(invoice.client) === clientKey(extracted.client));
          const candidates = customerMatches.length ? customerMatches : matches;
          if (candidates.length > 1) {
            issues.push({ file: file.name, po: extracted.poNumber, guide: extracted.guideNumber, credit: extracted.creditNumber, amount: extracted.amount, status: 'warning', reason: `El PO ${extracted.poNumber || extracted.guideNumber} coincide con varias facturas. Selecciona la factura correcta para aplicar el crédito.`, creditAssignment: { sourceFileId: file.id, creditNumber: extracted.creditNumber, amount: extracted.amount, customer: extracted.client || '', invoiceOptions: candidates.map(invoice => ({ id: invoice.id, folio: invoice.folio, client: invoice.client, balance: Number(invoice.balance || 0) })) } });
            skipped += 1; continue;
          }
          const matched = candidates[0];
          if (!matched) { issues.push({ file: file.name, po: extracted.poNumber, guide: extracted.guideNumber, credit: extracted.creditNumber, amount: extracted.amount, status: 'missing', reason: `No se encontró una factura relacionada con el PO o guía ${extracted.poNumber || extracted.guideNumber}.` }); skipped += 1; continue; }
          const customerIdentity = clientKey(matched.client);
          const existingRecords = invoices.flatMap(invoice => clientKey(invoice.client) === customerIdentity ? (invoice.credits || []).filter(credit => String(credit.creditNumber || '') === String(extracted.creditNumber || '')) : []);
          const existingApplied = existingRecords.filter(credit => !credit.documentOnly).reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
          const remainingTotal = Math.max(0, extracted.amount - existingApplied);
          if (remainingTotal < 0.01) {
            issues.push({ file: file.name, po: extracted.poNumber, credit: extracted.creditNumber, amount: extracted.amount, status: 'duplicate', reason: `El crédito ${extracted.creditNumber} ya fue aplicado por completo y no se volvió a descontar.`, creditAction: { sourceFileId: file.id, creditNumber: extracted.creditNumber, amount: extracted.amount, customer: extracted.client || matched.client, invoiceOptions: invoices.filter(invoice => clientKey(invoice.client) === customerIdentity && availableCreditBalance(invoice) > 0).map(invoice => ({ id: invoice.id, folio: invoice.folio, client: invoice.client, balance: Number(invoice.balance || 0) })) } });
            skipped += 1; continue;
          }
          const allocationCandidates = buildCreditAllocationCandidates({ invoices, matchedInvoice: matched, customerKey: customerIdentity, normalizeClientKey: clientKey, availableBalance: availableCreditBalance, useOldestUnflaggedRule: clientKey(matched.client).includes('galleria-farms') });
          let remaining = remainingTotal;
          const allocations = [];
          for (const invoice of allocationCandidates) { const amount = Math.min(remaining, availableCreditBalance(invoice)); if (amount > 0) allocations.push({ invoice, amount }); remaining = Math.max(0, remaining - amount); if (remaining < 0.01) break; }
          if (remaining >= 0.01) { issues.push({ file: file.name, status: 'warning', reason: `No hay saldo suficiente para distribuir el crédito completo. Quedaron ${remaining.toFixed(2)} sin aplicar.` }); skipped += 1; continue; }
          const existingDocument = existingRecords.find(credit => credit.creditPdfPath);
          const creditPdfPath = existingDocument?.creditPdfPath || `credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`;
          if (!existingDocument) await putOracleObject(env, creditPdfPath, bytes);
          const processedAt = new Date().toISOString();
          for (const allocation of allocations) {
            const invoice = allocation.invoice;
            const row = await recordByKey(sql, 'invoices', invoice.id);
            if (!row) continue;
            const previousCreditAmount = (row.record.credits || []).filter(credit => !credit.documentOnly).reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
            row.record.creditAmount = previousCreditAmount + allocation.amount;
            row.record.balance = Math.max(0, availableCreditBalance(row.record) - allocation.amount);
            row.record.credits = [...(row.record.credits || []), { creditNumber: extracted.creditNumber, amount: allocation.amount, guideNumber: extracted.guideNumber || '', allocationType: String(invoice.id) === String(matched.id) ? 'invoice' : 'same-customer-balance', dateProcessed: processedAt, date: extracted.creditDate || '', creditPdfPath, creditSharePointUrl: '', ...(clientKey(matched.client).includes('galleria-farms') ? { creditFlagTargetInvoiceId: matched.id } : {}) }];
            if (row.record.balance < 0.01) { row.record.balance = 0; row.record.status = 'Pagada'; }
            await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
          }
          await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
          details.push({ file: file.name, type: 'credit', status: 'processed', targets: allocations.map(allocation => ({ folio: allocation.invoice.folio, client: allocation.invoice.client, amount: allocation.amount })), reason: `Crédito ${extracted.creditNumber || extracted.poNumber} aplicado correctamente.` });
          processed += 1;
        } catch (error) { issues.push({ file: file.name, status: 'error', reason: error?.message || 'No se pudo procesar el crédito.' }); skipped += 1; }
      }
      return json({ message: `Sincronización completada. ${processed} procesados, ${skipped} ignorados.`, processed, skipped, issues, details });
    } catch (error) { return json({ message: error?.message || 'No se pudo sincronizar créditos.' }, 500); }
  }

  if (path === '/api/credits/sync/remove' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const sourceFileId = String((await request.json())?.sourceFileId || '').trim();
    if (!sourceFileId) return json({ message: 'Falta el PDF de crédito que se eliminará.' }, 400);
    try {
      const driveId = await getSharePointDrive(env);
      const creditFolder = await findChildFolder(env, driveId, (await findRootFolder(env, driveId)).id, 'Credit');
      const source = await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!source?.name) return json({ message: 'El PDF de crédito ya no está disponible.' }, 404);
      if (source.parentReference?.id !== creditFolder.id) return json({ message: 'Solo se puede eliminar el PDF que sigue en la carpeta Credit.' }, 400);
      await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      return json({ message: `PDF de crédito ${source.name} eliminado. El crédito ya aplicado no fue modificado.` });
    } catch (error) { return json({ message: error?.message || 'No se pudo eliminar el PDF.' }, 500); }
  }

  if (path === '/api/credits/sync/assign' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const sourceFileId = String(body?.sourceFileId || '').trim();
    const row = await recordByKey(sql, 'invoices', body?.invoiceId);
    const mode = body?.mode === 'document-only' ? 'document-only' : 'apply';
    if (!sourceFileId || !row) return json({ message: 'Selecciona el PDF y una factura destino.' }, 400);
    try {
      const driveId = await getSharePointDrive(env);
      const source = await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!source?.['@microsoft.graph.downloadUrl']) return json({ message: 'El PDF de crédito ya no está disponible.' }, 404);
      const response = await fetch(source['@microsoft.graph.downloadUrl']);
      if (!response.ok) throw new Error(`No se pudo descargar el PDF (HTTP ${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const extracted = await extractCreditPdf(bytes);
      if ((!extracted.poNumber && !extracted.guideNumber) || extracted.amount <= 0) return json({ message: 'El PDF no contiene un crédito válido.' }, 422);
      const objectName = `credit-${extracted.creditNumber || extracted.poNumber}-${Date.now()}.pdf`;
      await putOracleObject(env, objectName, bytes);
      const processedAt = new Date().toISOString();
      if (mode === 'document-only') {
        row.record.credits = [...(row.record.credits || []), { creditNumber: extracted.creditNumber, amount: Number(extracted.amount), documentOnly: true, guideNumber: extracted.guideNumber || '', allocationType: 'document-only', dateProcessed: processedAt, date: extracted.creditDate || '', creditPdfPath: objectName, creditSharePointUrl: '' }];
        await saveRecord(sql, 'invoices', row.record.id, row.record, row.position);
        await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
        return json({ message: `PDF del crédito ${extracted.creditNumber || extracted.poNumber} asociado a la factura ${row.record.folio} sin modificar el balance.` });
      }
      const invoices = await collection(sql, 'invoices');
      const matched = invoices.find(invoice => String(invoice.id) === String(row.record.id));
      const candidates = buildCreditAllocationCandidates({ invoices, matchedInvoice: matched, customerKey: clientKey(matched.client), normalizeClientKey: clientKey, availableBalance: availableCreditBalance, useOldestUnflaggedRule: clientKey(matched.client).includes('galleria-farms') });
      let remaining = Number(extracted.amount);
      const allocations = [];
      for (const invoice of candidates) { const amount = Math.min(remaining, availableCreditBalance(invoice)); if (amount > 0) allocations.push({ invoice, amount }); remaining = Math.max(0, remaining - amount); if (remaining < 0.01) break; }
      if (remaining >= 0.01) { await deleteOracleObject(env, objectName); return json({ message: `No hay saldo suficiente para aplicar el crédito completo. Faltan $${remaining.toFixed(2)}.` }, 409); }
      for (const allocation of allocations) {
        const invoiceRow = await recordByKey(sql, 'invoices', allocation.invoice.id);
        if (!invoiceRow) continue;
        const previous = (invoiceRow.record.credits || []).filter(credit => !credit.documentOnly).reduce((sum, credit) => sum + Number(credit.amount || 0), 0);
        invoiceRow.record.creditAmount = previous + allocation.amount;
        invoiceRow.record.balance = Math.max(0, availableCreditBalance(invoiceRow.record) - allocation.amount);
        invoiceRow.record.credits = [...(invoiceRow.record.credits || []), { creditNumber: extracted.creditNumber, amount: allocation.amount, guideNumber: extracted.guideNumber || '', allocationType: String(invoiceRow.record.id) === String(matched.id) ? 'invoice' : 'same-customer-balance', dateProcessed: processedAt, date: extracted.creditDate || '', creditPdfPath: objectName, creditSharePointUrl: '' }];
        if (invoiceRow.record.balance < 0.01) { invoiceRow.record.balance = 0; invoiceRow.record.status = 'Pagada'; }
        await saveRecord(sql, 'invoices', invoiceRow.record.id, invoiceRow.record, invoiceRow.position);
      }
      await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      return json({ message: `Crédito ${extracted.creditNumber || extracted.poNumber} asignado a ${allocations.length} factura(s).` });
    } catch (error) { return json({ message: error?.message || 'No se pudo asignar el crédito.' }, 500); }
  }

  if (path === '/api/credits/sync/replace' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const body = await request.json();
    const sourceFileId = String(body?.sourceFileId || '').trim();
    const creditNumber = String(body?.creditNumber || '').trim();
    const customer = String(body?.customer || '').trim();
    if (!sourceFileId || !creditNumber) return json({ message: 'Faltan el PDF duplicado y el número de crédito.' }, 400);
    try {
      const invoices = await collection(sql, 'invoices');
      const records = findCreditRecords(invoices, creditNumber, customer, clientKey);
      if (!records.length) return json({ message: 'No se encontró un crédito aplicado para reemplazar.' }, 404);
      const driveId = await getSharePointDrive(env);
      const source = await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`);
      if (!source?.['@microsoft.graph.downloadUrl']) return json({ message: 'El PDF duplicado ya no está disponible.' }, 404);
      const response = await fetch(source['@microsoft.graph.downloadUrl']);
      if (!response.ok) throw new Error(`No se pudo descargar el PDF (HTTP ${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const extracted = await extractCreditPdf(bytes);
      if (String(extracted.creditNumber || '') !== creditNumber) return json({ message: 'El PDF no corresponde al crédito seleccionado.' }, 422);
      const objectName = `credit-${creditNumber}-replacement-${Date.now()}.pdf`;
      await putOracleObject(env, objectName, bytes);
      const oldPaths = [...new Set(records.map(item => item.credit.creditPdfPath).filter(Boolean))];
      for (const record of records) {
        record.credit.creditPdfPath = objectName;
        // The replacement is stored in Oracle; clear the old SharePoint URL
        // so the portal cannot keep opening the superseded PDF.
        record.credit.creditSharePointUrl = '';
      }
      for (const invoice of [...new Map(records.map(record => [record.invoice.id, record.invoice])).values()]) {
        const invoiceRow = await recordByKey(sql, 'invoices', invoice.id);
        await saveRecord(sql, 'invoices', invoice.id, invoice, invoiceRow?.position ?? null);
      }
      for (const oldPath of oldPaths) await deleteOracleObject(env, oldPath).catch(() => {});
      await graphRequest(env, `/drives/${driveId}/items/${encodeURIComponent(sourceFileId)}`, { method: 'DELETE' });
      return json({ message: `Crédito ${creditNumber} reemplazado. Se conservaron sus aplicaciones y balances.` });
    } catch (error) { return json({ message: error?.message || 'No se pudo reemplazar el crédito.' }, 500); }
  }

  if (path === '/api/invoices/sync' && request.method === 'POST') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    try {
      const previous = (await collection(sql, 'invoiceSyncJobs')).find(job => ['queued', 'running'].includes(job.status));
      if (previous) return json({ message: 'Ya hay una sincronización de facturas en curso.', jobId: previous.id }, 409);
      const driveId = await getSharePointDrive(env);
      const root = await findRootFolder(env, driveId);
      const entries = (await listDriveChildren(env, driveId, root.id)).filter(item => !item.folder && isSyncDocument(item.name)).map(item => ({ id: item.id, name: item.name, downloadUrl: item['@microsoft.graph.downloadUrl'] || '' }));
      const id = crypto.randomUUID();
      const job = { id, status: entries.length ? 'queued' : 'completed', phase: 'invoices', total: entries.length, scanned: 0, processed: 0, skipped: 0, currentFile: '', message: entries.length ? `Se encontraron ${entries.length} archivos. Primero se identificarán las facturas.` : 'Sincronización completada. No había archivos pendientes.', issues: [], details: [], files: entries, pendingReceivings: [], driveId, startedAt: new Date().toISOString(), finishedAt: entries.length ? null : new Date().toISOString() };
      await saveRecord(sql, 'invoiceSyncJobs', id, job, null);
      return json({ jobId: id, status: job.status }, 202);
    } catch (error) { return json({ message: error?.message || 'No se pudo iniciar la sincronización.' }, 500); }
  }

  const invoiceSyncStatusMatch = path.match(/^\/api\/invoices\/sync\/status\/([^/]+)$/);
  if (invoiceSyncStatusMatch && request.method === 'GET') {
    if (!adminOnly(user)) return json({ message: 'Acceso exclusivo para administradores.' }, 403);
    const row = await recordByKey(sql, 'invoiceSyncJobs', decodeURIComponent(invoiceSyncStatusMatch[1]));
    if (!row) return json({ message: 'No se encontró la sincronización solicitada.' }, 404);
    const job = row.record;
    if (['queued', 'running'].includes(job.status)) {
      const file = (job.files || [])[Number(job.scanned || 0)];
      if (file) {
        job.status = 'running';
        job.currentFile = file.name;
        job.message = `Procesando ${file.name}`;
        await processInvoiceSyncFile(env, sql, job, file);
        job.scanned = Number(job.scanned || 0) + 1;
      }
      if (Number(job.scanned || 0) >= Number(job.total || 0)) {
        if (job.phase === 'invoices' && Array.isArray(job.pendingReceivings) && job.pendingReceivings.length) {
          job.phase = 'receivings';
          job.files = job.pendingReceivings;
          job.total = job.files.length;
          job.scanned = 0;
          job.currentFile = '';
          job.message = `Facturas identificadas. Ahora se relacionarán ${job.total} recibimientos por nombre y referencias.`;
        } else {
          job.status = 'completed';
          job.currentFile = '';
          job.finishedAt = new Date().toISOString();
          job.message = `Sincronización completada. ${job.processed || 0} procesadas, ${job.skipped || 0} ignoradas.`;
        }
      }
      await saveRecord(sql, 'invoiceSyncJobs', job.id, job, row.position);
    }
    const { files, driveId, ...publicJob } = job;
    return json(publicJob);
  }

  const pdfMatch = path.match(/^\/api\/invoices\/([^/]+)\/(pdf|receiving-pdf)$/);
  if (pdfMatch && request.method === 'GET') {
    const invoices = await collection(sql, 'invoices');
    const invoice = invoices.find(item => String(item.id) === String(pdfMatch[1]));
    if (!invoice) return json({ message: 'No se encontró la factura.' }, 404);
    if (user.loginSource === 'email-history' ? !historyInvoiceAccess(user, invoice, clientKey) : (user.role !== 'admin' && clientKey(invoice.client) !== clientKey(user.clientKey) && String(invoice.email || '').toLowerCase() !== String(user.email || '').toLowerCase())) return json({ message: 'No tienes permiso para ver esta factura.' }, 403);
    return invoicePdfResponse(request, env, invoice, pdfMatch[2] === 'receiving-pdf' ? 'receiving' : 'invoice');
  }

  // Todo lo demás sigue usando el backend actual hasta migrar y probar cada
  // escritura, carga y sincronización por separado.
  return null;
}
