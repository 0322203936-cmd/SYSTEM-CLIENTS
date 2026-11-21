# Respaldo de lo publicado en Cloudflare (21 nov 2026)

La computadora desde donde se publicaba el Worker `pacifica-farms-portal` ya no existe, y lo último que se publicó (fin de octubre 2026) era más nuevo que este repositorio. Esto es lo que se recuperó de Cloudflare:

## `pagina/`: la página tal como está publicada (ya compilada)

- Es una copia exacta de los archivos que sirve el portal: `index.html`, `main…js`, los chunks `8/550/849/913…js`, `runtime…js`, estilos, fuentes, imágenes y `tinymce/` (272 archivos, idénticos a tinymce 8.9.0).
- **Ojo:** el código de `src/` de este repositorio **NO** tiene todo lo de esta página. Las pantallas de saldo a favor de cheques y de actividad del portal solo existen aquí, ya compiladas. Si se compila `src/` (`ng build`) y se publica eso, esas pantallas desaparecen.
- Mientras `src/` no se ponga al día, para publicar hay que usar esta carpeta como los archivos estáticos (assets) del Worker.

## API (`worker/` y `server/`)

Se recuperó con los archivos originales del mapa de código (`index.js.map`) del Worker publicado: `worker/direct-api.mjs`, `worker/invoice-parser.mjs`, `worker/walmex-source.mjs`, `server/email-login.mjs`, y los nuevos `server/check-customer-credit.mjs` y `server/portal-activity.mjs`. Los demás archivos ya eran iguales a lo publicado.

## Datos del Worker publicado

- Nombre: `pacifica-farms-portal`, URL `pacifica-farms-portal.pacifica-clients.workers.dev`
- Entrada: `worker/index.mjs`, archivos estáticos con binding `ASSETS`
- Fecha de compatibilidad: `2026-09-07`
- Variables: `DIRECT_API=true`, `ORIGIN_API` (la VM vieja de Oracle, ya no se usa). Los secretos (Neon, Oracle, SharePoint, correo, JWT, ConvertAPI, Walmex) siguen guardados en Cloudflare, no aquí.
