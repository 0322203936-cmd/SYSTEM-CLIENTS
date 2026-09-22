/**
 * Reglas del envio masivo: que se incluye, que se bloquea y como se agrupa.
 *
 * Aqui vive lo que evita equivocarse al mandar varios correos de un jalon,
 * asi que se prueba aparte de la pantalla.
 *
 * Ejecutar:  node tests/bulk-send.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const outDir = path.resolve('.tmp-test-bulk');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
execFileSync('npx', ['tsc', 'src/app/bulk-send.ts', '--outDir', '.tmp-test-bulk',
  '--module', 'es2020', '--target', 'es2020', '--moduleResolution', 'bundler',
  '--skipLibCheck', '--lib', 'es2020'],
  { stdio: 'inherit', shell: true });

const { buildBulkSendRows, bulkSendSummary } = await import(pathToFileURL(path.join(outDir, 'bulk-send.js')).href);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (error) { console.log('  FALLA', name, '\n        ', error.message); process.exitCode = 1; }
};

const factura = (over = {}) => ({
  id: 1, folio: '7000', client: 'MexYCan USA', aliasKey: 'mexycan-usa',
  issued: '2026-09-14', hasReceiving: true, alreadySent: false, ...over,
});
const correos = { 'mexycan-usa': 'jeff@mexycanusa.com', 'gringo-south': 'yulie@dosgringos.net' };
const construir = (facturas, opciones = {}) => buildBulkSendRows(facturas, {
  from: '2026-09-14', to: '2026-09-15', onlyUnsent: true, recipients: correos, ...opciones,
});

console.log('rango de fechas');
test('incluye los dos extremos', () => {
  const filas = construir([factura({ id: 1, issued: '2026-09-14' }), factura({ id: 2, issued: '2026-09-15' })]);
  assert.equal(filas[0].invoices.length, 2);
});

test('deja fuera lo anterior y lo posterior', () => {
  const filas = construir([factura({ id: 1, issued: '2026-09-13' }), factura({ id: 2, issued: '2026-09-16' })]);
  assert.deepEqual(filas, []);
});

console.log('ya enviadas');
test('se omiten cuando solo se piden las pendientes', () => {
  const filas = construir([factura({ id: 1, alreadySent: true }), factura({ id: 2, folio: '7001' })]);
  assert.equal(filas[0].invoices.length, 1);
  assert.equal(filas[0].invoices[0].folio, '7001');
});

test('aparecen marcadas cuando se piden todas', () => {
  const filas = construir([factura({ alreadySent: true })], { onlyUnsent: false });
  assert.equal(filas[0].invoices[0].alreadySent, true);
});

test('un cliente sin pendientes no genera renglon', () => {
  assert.deepEqual(construir([factura({ alreadySent: true })]), []);
});

console.log('destinatarios');
test('sin destinatario el renglon queda bloqueado', () => {
  const filas = construir([factura({ aliasKey: 'flower-truck-la', client: 'Flower Truck LA' })]);
  assert.equal(filas[0].selectable, false);
  assert.equal(filas[0].recipients, '');
});

test('con destinatario el renglon es seleccionable', () => {
  const filas = construir([factura()]);
  assert.equal(filas[0].selectable, true);
  assert.equal(filas[0].recipients, 'jeff@mexycanusa.com');
});

console.log('agrupacion');
test('dos razones sociales del mismo cliente van en un renglon', () => {
  const filas = construir([
    factura({ id: 1, client: 'GRINGO SOUTH SA DE CV', aliasKey: 'gringo-south' }),
    factura({ id: 2, folio: '7001', client: 'Gringo Ventures DBA Dos Gringos', aliasKey: 'gringo-south' }),
  ]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].invoices.length, 2);
});

test('los renglones salen ordenados por nombre', () => {
  const filas = construir([
    factura({ id: 1, client: 'Zulu', aliasKey: 'zulu' }),
    factura({ id: 2, client: 'Alfa', aliasKey: 'alfa' }),
  ]);
  assert.deepEqual(filas.map(f => f.name), ['Alfa', 'Zulu']);
});

console.log('resumen del boton');
test('cuenta solo lo seleccionado', () => {
  const filas = construir([
    factura({ id: 1 }),
    factura({ id: 2, folio: '7001' }),
    factura({ id: 3, client: 'Flower Truck LA', aliasKey: 'flower-truck-la' }),
  ]);
  const resumen = bulkSendSummary(filas, new Set([1, 2]));
  assert.equal(resumen.emails, 2);
  assert.equal(resumen.clients, 1);
});

test('sin nada seleccionado el resumen queda en cero', () => {
  assert.deepEqual(bulkSendSummary(construir([factura()]), new Set()), { emails: 0, clients: 0 });
});

test('las facturas sin recibimiento se marcan pero se envian', () => {
  const filas = construir([factura({ hasReceiving: false })]);
  assert.equal(filas[0].invoices[0].hasReceiving, false);
  assert.equal(filas[0].selectable, true);
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} pruebas pasaron`);
