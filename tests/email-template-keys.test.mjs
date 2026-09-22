/**
 * Llaves de las plantillas de correo.
 *
 * El caso real que falla: Gringo se muestra como un solo cliente pero sus
 * facturas traen tres clientKey distintos. Al guardar el To con una factura
 * y abrir otra, la llave cambiaba y el campo salia vacio.
 *
 * Ejecutar:  node tests/email-template-keys.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const outDir = path.resolve('.tmp-test');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
execFileSync('npx', ['tsc', 'src/app/email-template-keys.ts', '--outDir', '.tmp-test',
  '--module', 'es2020', '--target', 'es2020', '--moduleResolution', 'bundler',
  '--skipLibCheck', '--lib', 'es2020'],
  { stdio: 'inherit', shell: true });

const mod = await import(pathToFileURL(path.join(outDir, 'email-template-keys.js')).href);
const { companyTemplateKey, clientTemplateKey, findClientTemplate } = mod;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (error) { console.log('  FALLA', name, '\n        ', error.message); process.exitCode = 1; }
};

// Las tres razones sociales de Gringo, tal como estan en la base.
const GRINGO_LEGACY = ['gringo-south-s-a-de-c-v', 'gringo-south-sa-de-cv', 'gringo-ventures-dba-dos-gringos'];
const ALIAS = 'gringo-south';

console.log('llaves por empresa');
test('factura, pacifica', () => assert.equal(companyTemplateKey('invoice', 'pacifica'), 'co:pacifica'));
test('factura, centro', () => assert.equal(companyTemplateKey('invoice', 'centro'), 'co:centro'));
test('estado de cuenta, pacifica', () => assert.equal(companyTemplateKey('statement', 'pacifica'), 'stmt:co:pacifica'));
test('estado de cuenta, centro', () => assert.equal(companyTemplateKey('statement', 'centro'), 'stmt:co:centro'));

console.log('llaves por cliente');
test('la factura usa el alias, no la razon social', () => assert.equal(clientTemplateKey('invoice', ALIAS), 'gringo-south'));
test('el estado de cuenta lleva su prefijo', () => assert.equal(clientTemplateKey('statement', ALIAS), 'stmt:gringo-south'));

console.log('lectura con registros ya guardados (el caso que fallaba)');
test('encuentra el To guardado bajo otra razon social', () => {
  const templates = [{ clientKey: 'gringo-south-sa-de-cv', to: 'yulie.garcia@dosgringos.net' }];
  const found = findClientTemplate(templates, 'invoice', ALIAS, GRINGO_LEGACY);
  assert.equal(found?.to, 'yulie.garcia@dosgringos.net');
});

test('encuentra el estado de cuenta guardado bajo otra razon social', () => {
  const templates = [{ clientKey: 'stmt:gringo-south-s-a-de-c-v', to: 'yulie.garcia@dosgringos.net' }];
  const found = findClientTemplate(templates, 'statement', ALIAS, GRINGO_LEGACY);
  assert.equal(found?.to, 'yulie.garcia@dosgringos.net');
});

test('la llave nueva gana sobre la vieja', () => {
  const templates = [
    { clientKey: 'gringo-south-sa-de-cv', to: 'viejo@ejemplo.com' },
    { clientKey: 'gringo-south', to: 'nuevo@ejemplo.com' },
  ];
  assert.equal(findClientTemplate(templates, 'invoice', ALIAS, GRINGO_LEGACY)?.to, 'nuevo@ejemplo.com');
});

test('no confunde el registro de factura con el de estado de cuenta', () => {
  const templates = [{ clientKey: 'gringo-south', to: 'factura@ejemplo.com' }];
  assert.equal(findClientTemplate(templates, 'statement', ALIAS, GRINGO_LEGACY), null);
});

test('no toma el registro de empresa como si fuera del cliente', () => {
  const templates = [{ clientKey: 'co:centro', subject: 'de la empresa' }];
  assert.equal(findClientTemplate(templates, 'invoice', 'centro', ['centro']), null);
});

test('un cliente sin nada guardado devuelve null', () => {
  assert.equal(findClientTemplate([], 'invoice', 'kendall-farms', ['kendall-farms']), null);
});

test('un cliente de una sola razon social sigue funcionando', () => {
  const templates = [{ clientKey: 'kendall-farms', to: 'compras@kendall.com' }];
  assert.equal(findClientTemplate(templates, 'invoice', 'kendall-farms', ['kendall-farms'])?.to, 'compras@kendall.com');
});

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} pruebas pasaron`);
