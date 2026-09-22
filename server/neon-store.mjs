import pg from 'pg';

const { Pool } = pg;
const connectionString = String(process.env.NEON_DATABASE_URL || '').trim();
const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    })
  : null;

let schemaPromise = null;
let cacheLoaded = false;
let cachedDb = null;
let persistedState = emptyStorageState();
let writeQueue = Promise.resolve();

export function neonEnabled() {
  return Boolean(pool);
}

function emptyStorageState() {
  return { records: new Map(), metadata: new Map() };
}

function valueFingerprint(value) {
  return JSON.stringify(value);
}

function recordStorageKey(collection, recordKey) {
  return `${collection}\u0000${recordKey}`;
}

function cloneDb(data) {
  return data == null ? data : structuredClone(data);
}

export function dbToStorageState(data) {
  const state = emptyStorageState();
  for (const [collection, value] of Object.entries(data || {})) {
    if (!Array.isArray(value)) {
      state.metadata.set(collection, cloneDb(value));
      continue;
    }

    if (!value.length) {
      state.metadata.set(collection, []);
      continue;
    }

    const seenKeys = new Set();
    for (let index = 0; index < value.length; index += 1) {
      const record = value[index] ?? {};
      const baseKey = record.id === undefined || record.id === null
        ? String(index + 1)
        : String(record.id);
      let recordKey = baseKey;
      let suffix = 1;
      while (seenKeys.has(recordKey)) recordKey = `${baseKey}-${suffix++}`;
      seenKeys.add(recordKey);
      state.records.set(recordStorageKey(collection, recordKey), {
        collection,
        recordKey,
        position: index,
        record: cloneDb(record)
      });
    }
  }
  return state;
}

export function storageRowsToDb(recordRows = [], metadataRows = []) {
  if (!recordRows.length && !metadataRows.length) return null;
  const db = {};
  for (const row of recordRows) {
    if (!Array.isArray(db[row.collection])) db[row.collection] = [];
    db[row.collection].push(row.record);
  }
  for (const row of metadataRows) db[row.key] = row.value;
  return db;
}

export function diffStorageStates(previous, next) {
  const recordDeletes = [];
  const recordUpserts = [];
  const metadataDeletes = [];
  const metadataUpserts = [];

  for (const [key, row] of previous.records) {
    if (!next.records.has(key)) recordDeletes.push(row);
  }
  for (const [key, row] of next.records) {
    const oldRow = previous.records.get(key);
    if (!oldRow
      || oldRow.position !== row.position
      || valueFingerprint(oldRow.record) !== valueFingerprint(row.record)) {
      recordUpserts.push(row);
    }
  }
  for (const [key] of previous.metadata) {
    if (!next.metadata.has(key)) metadataDeletes.push(key);
  }
  for (const [key, value] of next.metadata) {
    if (!previous.metadata.has(key)
      || valueFingerprint(previous.metadata.get(key)) !== valueFingerprint(value)) {
      metadataUpserts.push({ key, value });
    }
  }

  return { recordDeletes, recordUpserts, metadataDeletes, metadataUpserts };
}

async function ensureSchema() {
  if (!pool) return;
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS app_records (
        collection text NOT NULL,
        record_key text NOT NULL,
        position integer,
        record jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, record_key)
      );
      ALTER TABLE app_records ADD COLUMN IF NOT EXISTS position integer;
      CREATE INDEX IF NOT EXISTS app_records_collection_idx ON app_records(collection);
      CREATE INDEX IF NOT EXISTS app_records_record_gin_idx ON app_records USING gin(record);
      CREATE TABLE IF NOT EXISTS app_metadata (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `).catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

export async function readNeonDb() {
  if (!pool) return null;
  if (cacheLoaded) return cachedDb;

  await ensureSchema();
  const [recordsResult, metadataResult] = await Promise.all([
    pool.query(`SELECT collection, record_key, position, record
                FROM app_records
                ORDER BY collection, position NULLS LAST, record_key`),
    pool.query('SELECT key, value FROM app_metadata WHERE key <> $1 ORDER BY key', ['migration_source'])
  ]);

  cachedDb = storageRowsToDb(recordsResult.rows, metadataResult.rows);
  persistedState = dbToStorageState(cachedDb || {});
  cacheLoaded = true;
  return cachedDb;
}

async function persistDbSnapshot(snapshot) {
  await ensureSchema();
  const nextState = dbToStorageState(snapshot);
  const changes = diffStorageStates(persistedState, nextState);
  const hasChanges = Object.values(changes).some(items => items.length > 0);
  if (!hasChanges) {
    cachedDb = snapshot;
    cacheLoaded = true;
    return;
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (changes.recordDeletes.length) {
      await client.query(
        `DELETE FROM app_records target
         USING jsonb_to_recordset($1::jsonb) AS removed(collection text, record_key text)
         WHERE target.collection = removed.collection
           AND target.record_key = removed.record_key`,
        [JSON.stringify(changes.recordDeletes.map(row => ({
          collection: row.collection,
          record_key: row.recordKey
        })))]
      );
    }
    if (changes.recordUpserts.length) {
      await client.query(
        `INSERT INTO app_records(collection, record_key, position, record)
         SELECT collection, record_key, position, record
         FROM jsonb_to_recordset($1::jsonb)
           AS incoming(collection text, record_key text, position integer, record jsonb)
         ON CONFLICT(collection, record_key) DO UPDATE
         SET position = excluded.position, record = excluded.record, updated_at = now()`,
        [JSON.stringify(changes.recordUpserts.map(row => ({
          collection: row.collection,
          record_key: row.recordKey,
          position: row.position,
          record: row.record
        })))]
      );
    }
    if (changes.metadataDeletes.length) {
      await client.query('DELETE FROM app_metadata WHERE key = ANY($1::text[])', [changes.metadataDeletes]);
    }
    if (changes.metadataUpserts.length) {
      await client.query(
        `INSERT INTO app_metadata(key, value)
         SELECT key, value
         FROM jsonb_to_recordset($1::jsonb) AS incoming(key text, value jsonb)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [JSON.stringify(changes.metadataUpserts)]
      );
    }
    await client.query(
      `INSERT INTO app_metadata(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      ['migration_source', JSON.stringify({ source: 'client-portal', updatedAt: new Date().toISOString() })]
    );

    await client.query('COMMIT');
    persistedState = nextState;
    cachedDb = snapshot;
    cacheLoaded = true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function writeNeonDb(data) {
  if (!pool) return;
  const snapshot = cloneDb(data || {});
  const pendingWrite = writeQueue.then(() => persistDbSnapshot(snapshot));
  writeQueue = pendingWrite.catch(() => {});
  await pendingWrite;
}

export async function closeNeon() {
  await writeQueue;
  if (pool) await pool.end();
}
