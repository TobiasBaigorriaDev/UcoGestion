# Escenario local de prueba

Abrir http://localhost:3000/login en esta computadora.

| Usuario | Correo | Contraseña | Rol |
| --- | --- | --- | --- |
| Dueño | dueno@uco-demo.test | DuenoPrueba2026! | OWNER |
| Atención | atencion@uco-demo.test | AtencionPrueba2026! | ADMIN de Local principal |

Negocio: Almacén Don Pedro. Una sucursal: Local principal. Una caja: Caja mostrador.
12 productos con precios ARS y stock registrado mediante INVENTARIO_INICIAL, tres categorías de catálogo, dos categorías de gasto, un cliente y un proveedor ficticios. No hay ventas ni sesiones de caja abiertas inicialmente.

Para empezar a vender: ingresar, seleccionar el negocio, abrir POS sin conexión, definir un PIN de al menos 8 caracteres y pulsar Autorizar este equipo y crear PIN. Esto también habilita el dispositivo para caja online. Luego ir a Sesiones de caja, abrir Caja mostrador con el efectivo inicial deseado y entrar a POS. Cada navegador/usuario debe preparar su propio acceso.

Para cambiar el PIN offline: abrir POS sin conexión, desbloquear con el PIN actual y pulsar Cambiar PIN offline. Ingresar el PIN actual, uno nuevo de al menos 8 caracteres distinto del anterior y su confirmación; pulsar Guardar nuevo PIN. Conserva los datos y pendientes del usuario en ese equipo y funciona sin conexión; no modifica la contraseña de acceso ni renueva la autorización. Un PIN olvidado o bloqueado no puede reemplazarse con este formulario.

Los datos persisten en el volumen Docker uconext-demo-postgres. La base uconext_small_business_demo usa PostgreSQL en 127.0.0.1:55432. Los secretos técnicos y claves offline permanecen en .env.local, excluido de Git. No eliminar ese archivo: contiene claves necesarias para operaciones offline pendientes.

Si se reinicia la computadora, ejecutar desde la raíz del repositorio:

```powershell
docker start uconext-demo-postgres
node output/mvp-demo/start.mjs
```

No repetir setup.mjs: rechaza una base con datos para evitar sobrescribir pruebas. start.mjs inicia API y Next en segundo plano; processes.json registra los PID y api.log/web.log contienen los logs.

Verificación ejecutada: compilación API, login de ambos usuarios en Chromium, selección de organización/sucursal, catálogo con 12 precios, autorización de dispositivo y formulario de apertura de caja. complete-and-verify.mjs comprueba cantidades, correspondencia stock/ledger, auditoría de altas, lectura cross-tenant denegada por RLS y readiness API. No se confirmó una venta ni se probó el ciclo completo de caja en esta sesión.

Reportes PDF habilitados: start.mjs inicia almacenamiento S3 local en 127.0.0.1:9000 y el worker de reportes con la cola, RLS, autorización y limpieza reales. Se procesaron las exportaciones pendientes y se verificó en Chromium la generación y descarga de Inventario actual (HTTP 200, application/pdf, 3622 bytes). El worker local reclama exclusivamente REPORT_PDF y OBJECT_FILE_CLEANUP; no envía correos. Los archivos temporales persisten en storage-data y vencen a las 24 h.

Preparación reproducible si faltan los archivos locales de herramientas:

```powershell
New-Item -ItemType Directory -Force output/mvp-demo/storage-runtime | Out-Null
Set-Content output/mvp-demo/storage-runtime/package.json '{"name":"uco-demo-storage","private":true,"dependencies":{"s3rver":"3.7.1"}}'
pnpm --dir output/mvp-demo/storage-runtime install --ignore-workspace --config.node-linker=hoisted
node output/mvp-demo/configure-pdf.mjs
node output/mvp-demo/start.mjs
```

El registro rechazó las imágenes MinIO y el servidor oficial de descargas dejó de distribuir el binario. Se usa [S3rver](https://github.com/jamhall/s3rver) 3.7.1 como herramienta de desarrollo local, con firmas verificadas y datos persistentes; es un proyecto archivado para sandbox, no un proveedor de producción. No agrega dependencias al workspace ni altera compose productivo. configure-pdf.mjs crea una credencial dispatcher separada en el PostgreSQL local, sin BYPASSRLS, y conserva las claves offline existentes; no repetir setup.mjs. Los directorios de almacenamiento y herramientas están excluidos de Git.

Limitaciones del entorno: Next funciona en modo desarrollo y sus herramientas muestran avisos CSP; se conserva la política existente. Los correos de invitación/recuperación siguen pendientes de configurar; falta conectar el gateway de correo del worker. Este enlace es local; no es una publicación para otros equipos.

No se modificó código funcional del MVP. Los scripts de preparación y verificación están en esta carpeta y utilizan las migraciones y servicios compilados del proyecto.
