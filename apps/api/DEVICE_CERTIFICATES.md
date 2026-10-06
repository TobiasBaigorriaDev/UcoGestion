# Certificados de dispositivos POS

La API necesita `DEVICE_CERTIFICATE_KEY` para autorizar dispositivos POS. Su valor es una clave aleatoria de 32 bytes codificada en base64url. Guardala en el gestor de secretos del despliegue y mantené el mismo valor entre réplicas y reinicios.

La autorización `POST /api/v1/devices/authorize-pos` exige sesión de OWNER o ADMIN, sucursal activa dentro de su alcance, CSRF, `Idempotency-Key` y una clave pública ECDSA P-256 en PEM SPKI. Guarda la clave y su thumbprint en PostgreSQL; devuelve un certificado cifrado y autenticado ligado a ambos IDs y al thumbprint. El certificado por sí solo no autoriza ninguna ruta. El canal de entrega con challenge y prueba de posesión se implementa en T201A. Su verificador deberá comprobar la firma sobre los bytes `UcoNext:delivery-challenge:v1:` concatenados con el challenge; ese dominio impide reutilizar la firma como operación comercial.

Para crear la clave en un entorno seguro: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.

No rotar ni retirar esta clave mientras existan certificados y sobres que puedan seguir pendientes. La política y el soporte de rotación de claves de ingestión se completan en T189A y T201A.
