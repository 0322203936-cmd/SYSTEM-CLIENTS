# Manual: base de datos del portal de facturación (Neon → PostgreSQL del servidor)

Este documento explica cómo está la base de datos del portal de facturación (`SYSTEM-CLIENTS`) después de la
migración del **24/11/2026**, cómo se hizo, cómo revisarla, cómo respaldarla y cómo regresar a Neon si hiciera falta.
No contiene contraseñas ni tokens: esos viven en `.env` (local, no está en git) y en los secretos de Cloudflare.

---

## 1. Resumen

| | Antes | Desde el 24/11/2026 09:24 (Tijuana) |
|---|---|---|
| Base principal (facturas, usuarios, cheques, créditos, correos, accesos, marketing…) | Neon (nube) | **PostgreSQL 18 en la PC servidor** `DESKTOP-289VQPM`, base `facturacion` |
| Cómo llega el Worker de Cloudflare | Driver `@neondatabase/serverless` por internet | **Cloudflare Tunnel → Workers VPC → Hyperdrive** (binding `HYPERDRIVE`) |
| Walmex | Neon aparte (`WALMEX_DATABASE_URL`) | **Sin cambios**: sigue en su Neon, solo lectura |
| Link del portal | `pacifica-farms-portal.pacifica-clients.workers.dev` | **El mismo** |

Consecuencia importante: **la PC servidor debe estar prendida y con internet**. Si se apaga, el portal no puede leer ni
guardar datos.

---

## 2. Arquitectura

```
Cliente (navegador)
   │  https
   ▼
Cloudflare Worker "pacifica-farms-portal"  (worker/index.mjs → worker/direct-api.mjs)
   │  env.HYPERDRIVE.connectionString   (pg Client, una conexión por petición)
   ▼
Hyperdrive "facturacion-db"
   │
   ▼
Servicio Workers VPC "facturacion-postgres"  (TCP 127.0.0.1:5432, postgresql, verify_ca)
   │
   ▼
Cloudflare Tunnel "facturacion-pc"  ←── cloudflared (servicio de Windows en la PC servidor)
   │
   ▼
PostgreSQL 18 (servicio postgresql-x64-18) — base "facturacion", usuario "facturacion_app", SSL activo
```

El túnel sale de la PC hacia Cloudflare: **no hay puertos abiertos** y Postgres sigue escuchando solo en `localhost`.
No se necesitó dominio (método "Workers VPC", recomendado por Cloudflare para bases privadas).

---

## 3. Identificadores (no son secretos)

| Recurso | Nombre | ID |
|---|---|---|
| Cuenta Cloudflare | Default account | `237e6563b534b414920d97a257974de3` |
| Worker | `pacifica-farms-portal` | versión publicada al migrar: `bc6f1abd-d22f-4b2f-a075-0189cdae7139` |
| Túnel | `facturacion-pc` | `fb34bcbb-ed7d-4966-bf92-30f9b64d059a` |
| Certificado CA (el `server.crt` de Postgres) | `facturacion-postgres-ca` | `2c4101ed-9168-449e-adb2-56e6e4e78941` (vence 21/11/2036) |
| Servicio VPC | `facturacion-postgres` | `01a20e8b-145f-7141-8a54-7128af5a8484` |
| Hyperdrive | `facturacion-db` | `f1dcd1bae40b46149c432cab2c088d07` (binding `HYPERDRIVE`) |
| Neon (base principal vieja) | proyecto `ep-withered-hill-b52ml8h8`, base `neondb` | se dejó intacto como respaldo |

---

## 4. PostgreSQL en la PC servidor

- Versión 18.6, servicio de Windows `postgresql-x64-18`, datos en `C:\Program Files\PostgreSQL\18\data`.
- **El mismo Postgres lo usan otros sistemas**: Reunion 123 (base `reunion123`, usuario `reunion`) y ORDENES MAYESH
  (bases `mayesh` y `mayesh_prueba`, usuario `mayesh_app`). **No tocar esas bases.**
- Base del portal: **`facturacion`**, dueño **`facturacion_app`** (usuario solo para el portal).
- La conexión local está en `SYSTEM-CLIENTS\.env` como `LOCAL_DATABASE_URL`
  (`postgres://facturacion_app:<contraseña>@localhost:5432/facturacion`). La contraseña se generó al azar.
- El superusuario `postgres` tiene su contraseña en `C:\reunion123\.env` (`PG_SUPERPASSWORD`).
- **SSL activado** (Hyperdrive lo exige):
  - `ALTER SYSTEM SET ssl = on` + `SELECT pg_reload_conf()` (recarga, sin reiniciar).
  - Certificado propio `server.crt` / `server.key` en la carpeta de datos (CN `desktop-289vqpm-postgres`, 10 años).
  - SSL es **opcional** para los clientes: Reunion y Mayesh siguen conectándose sin cifrar como siempre (verificado).
- Estructura (igual que en Neon): tablas `app_records(collection, record_key, position, record jsonb, updated_at)`
  y `app_metadata(key, value jsonb, updated_at)`. Sin extensiones.

---

## 5. Cambios en el código (repo `0322203936-cmd/SYSTEM-CLIENTS`)

| Commit | Qué |
|---|---|
| `34d17e7` | Cambios de Marketing que estaban sin subir (se subieron antes de tocar nada) |
| `79cbc7a` | `worker/pg-sql.mjs` + cambios en `worker/direct-api.mjs` + `nodejs_compat` |
| `b923084` | Activa `hyperdrive` en `wrangler.jsonc` (el cambio final) |
| `8cb2c0f` | Respaldos: `tools/respaldo_bd.ps1`, `tools/instalar_respaldo.ps1`, `.gitignore` con `/respaldos` |

### `worker/pg-sql.mjs`
Adaptador que ofrece **la misma forma que el cliente de Neon**, para no tocar las consultas existentes:
- `` sql`SELECT ... ${valor}` `` → renglones (parametriza `$1, $2…`)
- `sql.query(texto, parametros)` → renglones
- `sql.transaction(tx => [tx`...`, tx`...`])` → `BEGIN` / `COMMIT` / `ROLLBACK`
- `sql.end()` cierra la conexión.
Abre una sola conexión `pg.Client` por petición, la primera vez que se usa.

### `worker/direct-api.mjs`
- `sqlClient(env)`: si existe `env.HYPERDRIVE` usa el adaptador; **si no, usa Neon** (`NEON_DATABASE_URL`) como antes.
- `tryDirectApi(request, env)` ahora envuelve a `handleDirectApi(...)`: registra las conexiones de esa petición y las
  cierra en un `finally`.
- `/api/health` reporta `databaseSource: "hyperdrive"` o `"neon"`.
- `worker/walmex-source.mjs` **no se tocó** (Walmex sigue con Neon).

### `wrangler.jsonc`
- `compatibility_flags`: `["global_fetch_strictly_public", "nodejs_compat"]` (`pg` necesita `nodejs_compat`).
- Bloque `"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "f1dcd1bae40b46149c432cab2c088d07" }]`.
- `keep_vars: true` (conserva `DIRECT_API` y `ORIGIN_API` del panel). Los secretos no los toca `wrangler deploy`.

---

## 6. Cómo se hizo la migración (orden real)

1. `git pull` y subir los cambios pendientes (Marketing) para no mezclar.
2. Revisar versiones: Neon PostgreSQL 18.7, local 18.6 (misma versión mayor → `pg_dump`/`pg_restore` directo).
3. Crear usuario `facturacion_app` y base `facturacion` (solo creación; ninguna otra base se tocó).
4. Copia: `pg_dump --format=custom --no-owner --no-privileges` desde Neon (endpoint **directo**, sin `-pooler`) y
   `pg_restore --no-owner --no-privileges` en `facturacion`.
5. Comparación por colección: conteo + `md5` de todo el contenido, más `app_metadata` e índices → 15/15 iguales.
6. Activar SSL en Postgres (sección 4).
7. Wrangler: `npx.cmd wrangler login` (en PowerShell usar `npx.cmd`; `npx` está bloqueado por la política de scripts).
8. Túnel: Cloudflare → Cómputo → VPC → Crear Tunnel `facturacion-pc` (Windows 64-bit); instalar
   `cloudflared-windows-amd64.msi` y correr `cloudflared.exe service install <token>` en CMD **como administrador**.
9. Subir el certificado de Postgres como CA:
   `npx.cmd wrangler cert upload certificate-authority --ca-cert server.crt --name facturacion-postgres-ca`
10. Servicio VPC:
    `npx.cmd wrangler vpc service create facturacion-postgres --type tcp --tcp-port 5432 --app-protocol postgresql --tunnel-id fb34bcbb-ed7d-4966-bf92-30f9b64d059a --ipv4 127.0.0.1 --cert-verification-mode verify_ca --certificate-authority 2c4101ed-9168-449e-adb2-56e6e4e78941`
11. Hyperdrive (Cloudflare valida la conexión al crearlo):
    `npx.cmd wrangler hyperdrive create facturacion-db --service-id 01a20e8b-145f-7141-8a54-7128af5a8484 --database facturacion --user facturacion_app --password <de LOCAL_DATABASE_URL> --scheme postgresql`
12. Código (sección 5) probado en local y en una **versión de prueba** sin publicar
    (`npx.cmd wrangler versions upload --preview-alias base-servidor`). Resultado: funcionó y fue más rápido que Neon
    (0.55–0.82 s contra 1.1–2.4 s en la misma consulta).
13. Cambio final: copia final de Neon 09:22:56 → comparación 15/15 → activar `hyperdrive` → `ng build --configuration production`
    → `npx.cmd wrangler deploy` (09:24:34). Verificado: `/api/health` con `databaseSource: "hyperdrive"`, la base responde,
    la página carga y **Neon no recibió escrituras** entre la copia y la publicación.

---

## 7. Respaldos

- Script: `tools/respaldo_bd.ps1` → `respaldos\facturacion_AAAAMMDD_HHmm.dump` (`pg_dump` formato custom), guarda los **14** más
  recientes, registro en `respaldos\respaldo.log`. La carpeta `respaldos` **no** se sube a git (tiene datos de clientes).
- Tarea programada de Windows **"Facturacion Respaldo"**: 2:30 a.m. y 2:30 p.m. (si la PC estaba apagada, corre al prender).
  Se instala con `tools/instalar_respaldo.ps1` en **PowerShell como administrador**.
- Restaurar un respaldo (reemplaza las tablas de `facturacion`; hacerlo con cuidado):
  `& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' --clean --if-exists --no-owner --no-privileges --dbname=<LOCAL_DATABASE_URL> <archivo.dump>`
- Pendiente recomendado: copiar los respaldos **fuera de la PC** (OneDrive, disco externo u otra computadora).

---

## 8. Cómo revisar que todo funciona

| Qué | Cómo |
|---|---|
| El portal usa la base del servidor | `GET https://pacifica-farms-portal.pacifica-clients.workers.dev/api/health` → `"databaseSource":"hyperdrive"` |
| El túnel está vivo | Servicio de Windows `cloudflared` = Running; en Cloudflare → VPC → Tunnels, `facturacion-pc` = Healthy |
| Postgres está vivo | Servicio `postgresql-x64-18` = Running |
| Hay conexiones de Cloudflare | `select usename, count(*) from pg_stat_activity where datname='facturacion' group by 1` (usuario `facturacion_app`) |
| Los respaldos corren | `Get-ScheduledTask 'Facturacion Respaldo' \| Get-ScheduledTaskInfo` y `respaldos\respaldo.log` |

---

## 9. Cómo regresar a Neon (solo si algo grave falla)

1. En `wrangler.jsonc` comentar el bloque `"hyperdrive"` y publicar (`ng build --configuration production` + `npx.cmd wrangler deploy`).
   Sin el binding, el Worker usa `NEON_DATABASE_URL` automáticamente.
2. **Ojo:** lo que se haya guardado en la base del servidor después del 24/11/2026 09:24 **no está en Neon**. Antes de
   regresar hay que copiar esos datos de vuelta (`pg_dump` de `facturacion` → restaurar en Neon), o se pierden.

---

## 10. Reglas y cuidados

- **No borrar datos** de ninguna base. No tocar `reunion123`, `mayesh` ni `mayesh_prueba`.
- **Walmex se queda en Neon** (otro proyecto, solo lectura). Antes de borrar algo en Neon, confirmar que Walmex no está en el
  proyecto `ep-withered-hill-b52ml8h8`.
- **No volver a publicar desde otra computadora** sin traer antes el código de GitHub (ya pasó una vez que lo publicado era
  más nuevo que el repo). Todo cambio: commit + push antes o junto con el `wrangler deploy`.
- Secretos (contraseñas, `.env`, token del túnel) **nunca** en git ni en chats.
- Neon (base principal) se deja intacto unas semanas como respaldo; después se puede borrar ese proyecto para que deje de
  cobrar.
