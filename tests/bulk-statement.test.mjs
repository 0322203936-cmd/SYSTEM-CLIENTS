/**
 * Reglas del envio masivo de estados de cuenta.
 *
 * Aqui vive lo que evita mandarle a quien no toca o mandar de mas, asi que se
 * prueba aparte de la pantalla.
 *
 * Ejecutar:  node tests/bulk-statement.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const outDir = path.resolve('.tmp-test-stmt');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
execFileSync('npx', ['tsc', 'src/app/bulk-statement.ts', '--outDir', '.tmp-test-stmt',
  '--module', 'es2020', '--target', 'es2020', '--moduleResolution', 'bundler',
  '--skipLibCheck', '--lib', 'es2020'],
  { stdio: 'inherit', shell: true });

const { buildBulkStatementRows, bulkStatementSummary, bulkStatementQueue } =
  await import(pathToFileURL(path.join(outDir, 'bulk-statement.js')).href);

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (error) { console.log('  FALLA', name, '\n        ', error.message); process.exitCode = 1; }
};

const cliente = (over = {}) => ({
  aliasKey: 'mexycan-usa', name: 'MexYCan USA', invoices: 3, balance: 1250.5,
  issuer: 'pacifica', ...over,
});
const correos = { 'mexycan-usa': 'jeff@mexycanusa.com', 'gringo-south': 'yulie@dosgringos.net' };
const construir = (grupos, opciones = {}) =>
  buildBulkStatementRows(grupos, { recipients: correos, ...opciones });

console.log('saldo');
test('un cliente sin saldo no genera renglon', () => {
  assert.deepEqual(construir([cliente({ balance: 0 })]), []);
});

test('el redondeo de medio centavo no cuenta como adeudo', () => {
  assert.deepEqual(construir([cliente({ balance: 0.004 })]), []);
});

test('un saldo a favor tampoco genera renglon', () => {
  assert.deepEqual(construir([cliente({ balance: -300 })]), []);
});

console.log('destinatarios');
test('sin destinatario el renglon queda bloqueado', () => {
  const filas = construir([cliente({ aliasKey: 'galleria-farms', name: 'Galleria Farms' })]);
  assert.equal(filas[0].selectable, false);
  assert.equal(filas[0].recipients, '');
});

test('con destinatario el renglon es seleccionable', () => {
  const filas = construir([cliente()]);
  assert.equal(filas[0].selectable, true);
  assert.equal(filas[0].recipients, 'jeff@mexycanusa.com');
});

test('los espacios de mas no cuentan como destinatario', () => {
  const filas = construir([cliente()], { recipients: { 'mexycan-usa': '   ' } });
  assert.equal(filas[0].selectable, false);
});

console.log('ultimo envio');
test('se arrastra la fecha del ultimo estado de cuenta', () => {
  const filas = construir([cliente()], { lastSent: { 'mexycan-usa': '2026-09-12T18:04:00.000Z' } });
  assert.equal(filas[0].lastSentAt, '2026-09-12T18:04:00.000Z');
});

test('sin envio previo la fecha queda vacia', () => {
  assert.equal(construir([cliente()])[0].lastSentAt, '');
});

console.log('orden y empresa');
test('los renglones salen ordenados por nombre', () => {
  const filas = construir([
    cliente({ aliasKey: 'zulu', name: 'Zulu' }),
    cliente({ aliasKey: 'alfa', name: 'Alfa' }),
  ], { recipients: { zulu: 'a@b.com', alfa: 'c@d.com' } });
  assert.deepEqual(filas.map(f => f.name), ['Alfa', 'Zulu']);
});

test('la empresa emisora viaja intacta', () => {
  assert.equal(construir([cliente({ issuer: 'centro' })])[0].issuer, 'centro');
});

console.log('resumen del boton');
test('cuenta correos y suma saldo de lo seleccionado', () => {
  const filas = construir([
    cliente({ aliasKey: 'mexycan-usa', balance: 1000 }),
    cliente({ aliasKey: 'gringo-south', name: 'Dos Gringos', balance: 500 }),
  ]);
  assert.deepEqual(bulkStatementSummary(filas, new Set()), { emails: 2, balance: 1500 });
});

test('lo deseleccionado no se cuenta', () => {
  const filas = construir([
    cliente({ aliasKey: 'mexycan-usa', balance: 1000 }),
    cliente({ aliasKey: 'gringo-south', name: 'Dos Gringos', balance: 500 }),
  ]);
  assert.deepEqual(bulkStatementSummary(filas, new Set(['gringo-south'])), { emails: 1, balance: 1000 });
});

test('un bloqueado no suma aunque no este deseleccionado', () => {
  const filas = construir([cliente({ aliasKey: 'galleria-farms', name: 'Galleria Farms', balance: 9000 })]);
  assert.deepEqual(bulkStatementSummary(filas, new Set()), { emails: 0, balance: 0 });
});

console.log('fila de envio');
test('la fila deja fuera bloqueados y deseleccionados', () => {
  const filas = construir([
    cliente({ aliasKey: 'mexycan-usa' }),
    cliente({ aliasKey: 'gringo-south', name: 'Dos Gringos' }),
    cliente({ aliasKey: 'galleria-farms', name: 'Galleria Farms' }),
  ]);
  const cola = bulkStatementQueue(filas, new Set(['gringo-south']));
  assert.deepEqual(cola.map(f => f.aliasKey), ['mexycan-usa']);
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} pruebas pasaron`);
