import { Client } from 'pg';

/**
 * Conexion a la base de este servidor (PostgreSQL) a traves de Cloudflare Hyperdrive.
 *
 * Ofrece la misma forma que el cliente de Neon que ya usa el Worker, para no tocar las consultas:
 *   sql`SELECT ... ${valor}`        -> renglones
 *   sql.query(texto, parametros)    -> renglones
 *   sql.transaction(tx => [tx`...`, tx`...`])  -> todo o nada (BEGIN / COMMIT / ROLLBACK)
 *
 * Abre una sola conexion por peticion, la primera vez que se usa; end() la cierra al terminar.
 */
export function hyperdriveSql(connectionString) {
  let clientPromise = null;
  const connect = () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new Client({ connectionString });
        await client.connect();
        return client;
      })();
      clientPromise.catch(() => { clientPromise = null; });
    }
    return clientPromise;
  };
  // sql`...${a}...${b}` -> { text: '...$1...$2', values: [a, b] }
  const build = (strings, values) => {
    let text = '';
    strings.forEach((part, index) => {
      text += part;
      if (index < values.length) text += `$${index + 1}`;
    });
    return { text, values };
  };
  const run = async (text, params = []) => (await (await connect()).query(text, params)).rows;

  const sql = (strings, ...values) => {
    const query = build(strings, values);
    return run(query.text, query.values);
  };
  sql.query = (text, params = []) => run(text, params);
  sql.transaction = async (makeQueries) => {
    const queries = makeQueries((strings, ...values) => build(strings, values));
    const client = await connect();
    await client.query('BEGIN');
    try {
      const results = [];
      for (const query of queries) results.push((await client.query(query.text, query.values)).rows);
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  };
  sql.end = async () => {
    if (!clientPromise) return;
    const client = await clientPromise.catch(() => null);
    clientPromise = null;
    await client?.end().catch(() => {});
  };
  return sql;
}
