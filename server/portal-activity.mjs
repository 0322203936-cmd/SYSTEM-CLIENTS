/**
 * Actividad del portal: quien entra, cada cuando, y quien nunca ha entrado.
 *
 * Vive aparte de las rutas porque es puro calculo y es donde un numero se
 * puede ir mal sin que nadie lo note. Lo usan el servidor local y el Worker.
 *
 * No escribe ni lee nada: recibe los registros y devuelve el resumen.
 */

import { canonicalClientKey } from './email-login.mjs';

const address = value => String(value || '').trim().toLowerCase();

/** Correos de la casa. No cuentan como adopcion del cliente. */
const DOMINIOS_INTERNOS = ['cfbc.co', 'pacifica-farms.com'];

export function isInternalAddress(value) {
  const normalized = address(value);
  return DOMINIOS_INTERNOS.some(dominio => normalized.endsWith('@' + dominio));
}

/**
 * La fila que se guarda al entrar. Se arma aqui para que el servidor y el
 * Worker no puedan guardar cosas distintas.
 */
export function buildAccessRecord(user, entro, now = new Date()) {
  const correo = address(user?.email || user?.username);
  const clientes = Array.isArray(user?.assignedClients) ? [...user.assignedClients] : [];
  return {
    id: now.getTime(),
    tipo: 'login',
    correo,
    clientes,
    entro: entro === 'historial' ? 'historial' : 'manual',
    // se decide al escribir para que el criterio quede congelado con la fila
    interno: user?.role === 'admin' || isInternalAddress(correo),
    cuando: now.toISOString(),
  };
}

/**
 * Los clientes que hoy pueden entrar, con los correos que los habilitan.
 * Misma regla que usa el login por historial: si no, la cobertura se mide
 * contra un universo que no corresponde a quien realmente puede entrar.
 */
export function eligibleClients(emailLog, invoices, normalizeKey) {
  const porCliente = new Map();
  const facturas = new Map();
  for (const invoice of invoices || []) facturas.set(String(invoice.id), invoice);

  for (const entry of emailLog || []) {
    if (!entry?.sentAt || !Array.isArray(entry.to) || !entry.to.length) continue;
    if (entry.sentByRole === 'client') continue;
    const invoice = facturas.get(String(entry.invoiceId));
    const origen = invoice?.clientKey || invoice?.client || entry.clientKey || entry.client;
    const clientKey = canonicalClientKey(origen, normalizeKey);
    if (!clientKey) continue;
    let cliente = porCliente.get(clientKey);
    if (!cliente) {
      cliente = { clientKey, name: String(invoice?.client || entry.client || clientKey), addresses: new Set() };
      porCliente.set(clientKey, cliente);
    }
    for (const destino of entry.to) {
      const correo = address(destino);
      if (correo && !isInternalAddress(correo)) cliente.addresses.add(correo);
    }
  }

  // un cliente al que solo le escribimos a correos internos no esta habilitado
  for (const [clientKey, cliente] of porCliente) {
    if (!cliente.addresses.size) porCliente.delete(clientKey);
  }
  return porCliente;
}

/** El dia al que pertenece un acceso, en la zona con la que se leen los numeros. */
export function localDay(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // en-CA da AAAA-MM-DD, que ordena solo
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * La serie diaria con los huecos en cero. Sin esto la grafica pega dos dias
 * lejanos como si fueran consecutivos: los fines de semana caidos y las
 * rachas sin actividad desaparecen, y la curva miente.
 */
function dailySeries(counts, from, to) {
  const dias = [...counts.keys()].sort();
  const inicio = from || dias[0];
  const fin = to || dias[dias.length - 1];
  if (!inicio || !fin || inicio > fin) return [];

  const serie = [];
  // se avanza a mediodia UTC para que el cambio de horario no salte un dia
  const cursor = new Date(inicio + 'T12:00:00Z');
  const limite = new Date(fin + 'T12:00:00Z');
  while (cursor <= limite && serie.length < 800) {
    const dia = cursor.toISOString().slice(0, 10);
    serie.push({ date: dia, count: counts.get(dia) || 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return serie;
}

/**
 * El detalle de accesos que se manda a la pantalla: del mas reciente al mas
 * viejo y con tope, porque un rango largo podria traer miles y la lista es
 * para mirarla, no para procesarla.
 */
const TOPE_DETALLE = 200;

function recentLogins(logins) {
  return [...logins]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, TOPE_DETALLE);
}

/**
 * El resumen que pinta la pantalla. `from` y `to` son dias AAAA-MM-DD en la
 * zona local, inclusivos; vacios significan sin limite.
 */
export function summarizeActivity(options) {
  const {
    accessLog = [], emailLog = [], invoices = [],
    normalizeKey, from = '', to = '', timeZone = 'America/Tijuana',
  } = options || {};

  const habilitados = eligibleClients(emailLog, invoices, normalizeKey);
  const nombres = new Map([...habilitados].map(([key, cliente]) => [key, cliente.name]));

  const enRango = [];
  const clientesConAccesoAlgunaVez = new Set();

  for (const fila of accessLog) {
    if (fila?.tipo && fila.tipo !== 'login') continue;
    const dia = localDay(fila?.cuando, timeZone);
    if (!dia) continue;
    for (const clientKey of fila.clientes || []) {
      if (!fila.interno) clientesConAccesoAlgunaVez.add(canonicalClientKey(clientKey, normalizeKey));
    }
    if (from && dia < from) continue;
    if (to && dia > to) continue;
    enRango.push({ ...fila, dia });
  }

  const externos = enRango.filter(fila => !fila.interno);

  const porCliente = new Map();
  for (const fila of externos) {
    // un correo puede corresponder a varios clientes: cuentan todos, pero las
    // razones sociales de un mismo cliente se colapsan en una sola llave
    const llaves = new Set((fila.clientes || [])
      .map(raw => canonicalClientKey(raw, normalizeKey))
      .filter(Boolean));
    for (const clientKey of llaves) {
      let cliente = porCliente.get(clientKey);
      if (!cliente) {
        cliente = { clientKey, name: nombres.get(clientKey) || clientKey, accesses: 0, addresses: new Set(), days: new Set(), lastAt: '', logins: [] };
        porCliente.set(clientKey, cliente);
      }
      cliente.accesses += 1;
      if (fila.correo) cliente.addresses.add(fila.correo);
      cliente.days.add(fila.dia);
      cliente.logins.push({ email: fila.correo, at: String(fila.cuando) });
      if (String(fila.cuando) > cliente.lastAt) cliente.lastAt = String(fila.cuando);
    }
  }

  // dos cortes por dia, porque la pantalla los muestra por separado: mezclarlos
  // inflaria la adopcion con los accesos de la casa
  const porDia = new Map();
  for (const fila of externos) porDia.set(fila.dia, (porDia.get(fila.dia) || 0) + 1);
  const porDiaEquipo = new Map();
  for (const fila of enRango) {
    if (!fila.interno) continue;
    porDiaEquipo.set(fila.dia, (porDiaEquipo.get(fila.dia) || 0) + 1);
  }

  // Los accesos de la casa se agrupan por persona, no por cliente: un
  // administrador no pertenece a ningun cliente, asi que en el corte por
  // cliente no tendria donde caer.
  const porPersona = new Map();
  for (const fila of enRango) {
    if (!fila.interno) continue;
    const correo = String(fila.correo || '');
    if (!correo) continue;
    let persona = porPersona.get(correo);
    if (!persona) {
      persona = { correo, accesses: 0, days: new Set(), lastAt: '', logins: [] };
      porPersona.set(correo, persona);
    }
    persona.accesses += 1;
    persona.days.add(fila.dia);
    persona.logins.push({ email: correo, at: String(fila.cuando) });
    if (String(fila.cuando) > persona.lastAt) persona.lastAt = String(fila.cuando);
  }

  const nuncaHanEntrado = [...habilitados.values()]
    .filter(cliente => !clientesConAccesoAlgunaVez.has(cliente.clientKey))
    .map(cliente => ({ clientKey: cliente.clientKey, name: cliente.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const clientes = [...porCliente.values()]
    .map(cliente => ({
      clientKey: cliente.clientKey,
      name: cliente.name,
      lastAt: cliente.lastAt,
      accesses: cliente.accesses,
      addresses: cliente.addresses.size,
      activeDays: cliente.days.size,
      logins: recentLogins(cliente.logins),
    }))
    .sort((a, b) => b.accesses - a.accesses || a.name.localeCompare(b.name, 'es'));

  return {
    activeClients: clientes.length,
    accesses: externos.length,
    eligibleClients: habilitados.size,
    coverage: habilitados.size ? Math.round((clientesConAccesoAlgunaVez.size / habilitados.size) * 100) : 0,
    internalAccesses: enRango.length - externos.length,
    byDay: dailySeries(porDia, from, to),
    byDayTeam: dailySeries(porDiaEquipo, from, to),
    clients: clientes,
    team: [...porPersona.values()]
      .map(persona => ({
        email: persona.correo,
        lastAt: persona.lastAt,
        accesses: persona.accesses,
        activeDays: persona.days.size,
        logins: recentLogins(persona.logins),
      }))
      .sort((a, b) => b.accesses - a.accesses || a.email.localeCompare(b.email)),
    neverEntered: nuncaHanEntrado,
  };
}
