# Compra de NexoPos desde netxpremium.com/nexopos (Wompi)

Flujo:

1. El cliente elige un plan en `netxpremium.com/nexopos`.
2. `crear-compra` registra la compra `NEXOPOS-AAAAMMDD-XXXXXXXX` como `pendiente` y devuelve el Web Checkout de Wompi firmado.
3. El cliente paga y vuelve a `netxpremium.com/pago-nexopos`.
4. Wompi avisa a `wompi-webhook`. La función:
   - verifica la firma;
   - confirma la transacción en la API pública de Wompi;
   - crea el negocio y su cuenta con contraseña temporal, o renueva el existente (+30 días mensual, +365 anual, `activo = true`);
   - envía el acceso a https://nexopos.netxpremium.com y avisa a soporte.

El comercio de Wompi es el mismo de NexoBar (Elites Drinks), que tiene una sola URL de eventos.

| Ambiente | URL de eventos | Cómo verifica `wompi-webhook` de NexoPos |
|---|---|---|
| Sandbox | `https://voesyutyotonbktndrum.supabase.co/functions/v1/wompi-webhook` | Directo, con `WOMPI_EVENTS_SECRET` (de pruebas) |
| Producción | La de NexoBar (`fthjtbhxqqzqpyhtynaa…/wompi-webhook`) | NexoBar reenvía los `NEXOPOS-…` firmados con `REENVIO_NEXOPOS_SECRET` y no escribe nada en su base |

## 1. Base de datos

`migrations/20261030120000_planes_y_compras.sql`. Antes de pegarla en el SQL Editor, crea el secreto del barrido:

```sql
select vault.create_secret('<BARRIDO_SECRET>', 'barrido_secret');
```

## 2. Funciones (las dos con `--no-verify-jwt`)

```bash
supabase functions deploy crear-compra --no-verify-jwt --project-ref voesyutyotonbktndrum
supabase functions deploy wompi-webhook --no-verify-jwt --project-ref voesyutyotonbktndrum
```

Secretos del proyecto NexoPos para el **sandbox**:

```bash
supabase secrets set --project-ref voesyutyotonbktndrum \
  WOMPI_PUBLIC_KEY=pub_test_xxx \
  WOMPI_INTEGRITY_SECRET=test_integrity_xxx \
  WOMPI_EVENTS_SECRET=test_events_xxx \
  WOMPI_ENVIRONMENT=test \
  WOMPI_REDIRECT_URL=https://netxpremium.com/pago-nexopos \
  ALLOWED_ORIGINS=https://netxpremium.com,https://www.netxpremium.com \
  RESEND_API_KEY=<llave de Resend propia de NexoPos> \
  ALERTA_EMAIL_FROM="NexoPos <pagos@netxpremium.com>" \
  ALERTA_EMAIL_TO=soporte@netxpremium.com \
  BARRIDO_SECRET=<aleatorio, el mismo de Vault>
```

Prueba con las tarjetas de Wompi: `4242 4242 4242 4242` (aprobada) y `4111 1111 1111 1111` (rechazada).

## 3. Paso a producción (solo con confirmación)

1. Cambia `WOMPI_PUBLIC_KEY` y `WOMPI_INTEGRITY_SECRET` a las de producción. La de integridad es la misma del comercio de NexoBar: excepción aprobada.
2. Pon `WOMPI_ENVIRONMENT=prod` y `REENVIO_NEXOPOS_SECRET=<aleatorio>`.
3. Borra `WOMPI_EVENTS_SECRET`, así las llamadas directas quedan rechazadas.
4. En el proyecto de NexoBar, publica su `wompi-webhook` con el reenvío y define `NEXOPOS_WEBHOOK_URL=https://voesyutyotonbktndrum.supabase.co/functions/v1/wompi-webhook` y el mismo `REENVIO_NEXOPOS_SECRET`.

`compras` no tiene `business_id`. Su `negocio_id` es una llave foránea con `on delete set null`, así que `admin_delete_negocio` no necesita cambios y el historial de pagos se conserva.
