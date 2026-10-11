# Escenario local de prueba

Abrir http://localhost:3000/login en esta computadora.

| Usuario | Correo | Contraseña | Rol |
| --- | --- | --- | --- |
| Dueño | dueno@uco-demo.test | DuenoPrueba2026! | OWNER |
| Atención | atencion@uco-demo.test | AtencionPrueba2026! | ADMIN de Local principal |

Negocio: Almacén Don Pedro. Una sucursal: Local principal. Una caja: Caja mostrador.
12 productos con precios ARS y stock registrado mediante INVENTARIO_INICIAL, tres categorías de catálogo, dos categorías de gasto, un cliente y un proveedor ficticios. No hay ventas ni sesiones de caja abiertas inicialmente.

Para empezar a vender: ingresar, seleccionar el negocio, abrir POS sin conexión, definir un PIN de al menos 8 caracteres y pulsar Autorizar este equipo y crear PIN. Esto también habilita el dispositivo para caja online. Luego ir a Sesiones de caja, abrir Caja mostrador con el efectivo inicial deseado y entrar a POS. Cada navegador/usuario debe preparar su propio acceso.

Los datos persisten en el volumen Docker uconext-demo-postgres. La base uconext_small_business_demo usa PostgreSQL en 127.0.0.1:55432. Los secretos técnicos y claves offline permanecen en .env.local, excluido de Git. No eliminar ese archivo: contiene claves necesarias para operaciones offline pendientes.

Si se reinicia la computadora, ejecutar desde la raíz del repositorio:

```powershell
docker start uconext-demo-postgres
node output/mvp-demo/start.mjs
```

No repetir setup.mjs: rechaza una base con datos para evitar sobrescribir pruebas. start.mjs inicia API y Next en segundo plano; processes.json registra los PID y api.log/web.log contienen los logs.

Verificación ejecutada: compilación API, login de ambos usuarios en Chromium, selección de organización/sucursal, catálogo con 12 precios, autorización de dispositivo y formulario de apertura de caja. complete-and-verify.mjs comprueba cantidades, correspondencia stock/ledger, auditoría de altas, lectura cross-tenant denegada por RLS y readiness API. No se confirmó una venta ni se probó el ciclo completo de caja en esta sesión.

Limitaciones del entorno: Next funciona en modo desarrollo y sus herramientas muestran avisos CSP; se conserva la política existente. MinIO no pudo descargarse (registro denegado), por lo que no se inició el worker: exportaciones PDF asíncronas de reportes y correos de invitación/recuperación están pendientes de configurar. Mailpit está disponible en http://localhost:8025 pero aún falta conectar el gateway de correo del worker. Este enlace es local; no es una publicación para otros equipos.

No se modificó código funcional del MVP. Los scripts de preparación y verificación están en esta carpeta y utilizan las migraciones y servicios compilados del proyecto.
