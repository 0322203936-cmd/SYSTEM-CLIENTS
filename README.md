# Factura Clara

Sistema web de facturación para clientes creado con Angular 22 y Tailwind CSS 4.

## Funciones incluidas

- Inicio de sesión para administrador y cliente.
- Panel con totales facturados, pagados y pendientes.
- Buscador y filtro por estado.
- Alta y eliminación de facturas (administrador).
- Cambio de factura a estado pagado.
- Vista detallada e impresión/guardado como PDF.
- Vista de cliente limitada a sus propias facturas.
- Backend REST con Express y persistencia del lado del servidor.
- Autenticación JWT y contraseñas cifradas con bcrypt.
- Diseño adaptable para computadora, tableta y celular.

## Accesos

**Administrador**

- Usuario/correo: `Jesus.sandoval@cfbc.co`
- Contraseña: `jesuscholo22`

**Cliente de demostración**

- Usuario: `cliente@demo.com`
- Contraseña: `Cliente2026`

## Ejecutar el sistema

Requiere Node.js y npm. Abre una terminal en esta carpeta y ejecuta:

```bash
npm install
npm start
```

El comando inicia Angular y la API. Después visita `http://localhost:4200`.

La API se ejecuta en `http://localhost:3000`. En el primer arranque crea automáticamente `server/data/database.json` con usuarios, contraseñas cifradas y facturas iniciales.

## Compilar para producción

```bash
npm run build
```

El resultado se genera dentro de `dist/`.

## Importante para producción

Antes de publicar, copia `.env.example` como `.env` y reemplaza `JWT_SECRET` con una clave larga y aleatoria. Para un despliegue con alto volumen conviene sustituir el archivo JSON por PostgreSQL o MySQL y servir todo mediante HTTPS.

### PDFs en Oracle Object Storage

El backend puede usar el bucket privado de Oracle como fuente primaria y conservar SharePoint como respaldo. Si Oracle no está configurado, el comportamiento anterior no cambia.

En el `.env` define `OCI_AUTH_MODE`, `OCI_NAMESPACE`, `OCI_BUCKET_NAME` y `OCI_REGION`. En la VM de Oracle se recomienda `OCI_AUTH_MODE=instance_principal` con una política IAM que permita al recurso leer, escribir y borrar objetos del bucket. En local se puede usar `OCI_AUTH_MODE=config` con un archivo `~/.oci/config`, o `OCI_AUTH_MODE=api_key` con `OCI_TENANCY_ID`, `OCI_USER_ID`, `OCI_FINGERPRINT` y `OCI_PRIVATE_KEY_PATH`.

Las lecturas intentan Oracle, después la copia local y finalmente SharePoint. Las nuevas facturas, recibimientos y créditos se escriben en Oracle y SharePoint; los reemplazos y eliminaciones también mantienen ambos almacenamientos alineados.
