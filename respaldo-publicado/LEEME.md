# Respaldo de lo publicado en Cloudflare (21 nov 2026)

La computadora desde donde se publicaba el Worker `pacifica-farms-portal` ya no existe, y lo último que se publicó (fin de octubre 2026) era más nuevo que este repositorio. Esto es lo que se recuperó de Cloudflare:

## `pagina/`: la página tal como está publicada (ya compilada)

- Es una copia exacta de los archivos que sirve el portal: `index.html`, `main…js`, los chunks `8/550/849/913…js`, `runtime…js`, estilos, fuentes, imágenes y `tinymce/` (272 archivos, idénticos a tinymce 8.9.0).
- Se guarda como referencia de lo que estaba publicado el 21 nov 2026.

### `src/` ya está al día (21 nov 2026)

El código de `src/` se reconstruyó a partir de esta página (no traía mapa de código, solo lo compilado):
pantalla de actividad del portal (AG Grid 31.3.4 + ApexCharts 3.54.1), saldo a favor de cheques y del estado de
cuenta, notas de crédito con varias facturas, colores de Pacifica (login, Excel/PDF del estado de cuenta, tema
global) y los módulos `email-template-keys.ts`, `bulk-send.ts` y `bulk-statement.ts`, que nunca se habían subido.

Comprobado: `ng build --configuration production` da los mismos archivos que esta carpeta. `styles`, `runtime`,
los chunks `8/550/849/913`, las imágenes y `tinymce/` salen idénticos byte por byte; `main…js` tiene los mismos
616,357 tokens sin ninguna diferencia de contenido (solo cambian los nombres cortos que elige el minificador, que
dependen de cómo estaban escritas las variables en el código original). Ya se puede compilar `src/` y publicar.

## API (`worker/` y `server/`)

Se recuperó con los archivos originales del mapa de código (`index.js.map`) del Worker publicado: `worker/direct-api.mjs`, `worker/invoice-parser.mjs`, `worker/walmex-source.mjs`, `server/email-login.mjs`, y los nuevos `server/check-customer-credit.mjs` y `server/portal-activity.mjs`. Los demás archivos ya eran iguales a lo publicado.

## Datos del Worker publicado

- Nombre: `pacifica-farms-portal`, URL `pacifica-farms-portal.pacifica-clients.workers.dev`
- Entrada: `worker/index.mjs`, archivos estáticos con binding `ASSETS`
- Fecha de compatibilidad: `2026-09-07`
- Variables: `DIRECT_API=true`, `ORIGIN_API` (la VM vieja de Oracle, ya no se usa). Los secretos (Neon, Oracle, SharePoint, correo, JWT, ConvertAPI, Walmex) siguen guardados en Cloudflare, no aquí.
