# NexoPos — POS para restaurantes y cafeterías

POS para restaurantes y cafeterías en Colombia, derivado de NexoBar. Funciona sin conexión: guarda los pedidos, pagos, inventario y cierres en el equipo, y sincroniza con la nube cuando hay internet.

## Incluye

- Punto de venta por mesas, barra, salón, terraza, VIP y venta de mostrador.
- Productos de ejemplo en pesos colombianos, con recetas básicas.
- Creación de productos con nombre, categoría, precio de costo, precio de venta, unidad y stock inicial.
- Edición y eliminación de productos; administración de categorías y foto para cada producto.
- Cobros en efectivo, tarjeta, Nequi y Daviplata.
- Pago dividido: al cobrar una mesa se eligen todos o algunos productos (y cuántas unidades de cada uno); cada pago genera su propia factura y la cuenta sigue abierta con lo pendiente hasta pagarla completa.
- Descuento automático de inventario al cobrar y alertas de existencias mínimas.
- Facturas de compra: cada producto recibido se suma automáticamente al inventario y actualiza el último costo de los productos creados en el catálogo.
- Registro separado de servicios y otros gastos, visible en Compras y gastos y en los reportes diarios.
- Conteo de efectivo por denominación en el cierre de caja (billetes de $2.000 a $100.000 y monedas de $50 a $1.000), con suma automática.
- Apertura y cierre obligatorio de turnos de caja, con base física inicial, desglose de ventas y cálculo de efectivo esperado.
- Cuentas personalizadas que permanecen abiertas para llevar consumos separados por persona.
- Perfil del negocio con nombre, dirección, celular e imagen que personaliza el panel lateral.
- Gráfica de ventas por producto e informe de utilidad bruta/margen sobre las ventas cerradas.
- Reportes por período: hoy, 7, 15 o 30 días, o una fecha específica, con gráfico de ventas por día. El historial de movimientos muestra los últimos 20.
- Reporte diario, cierre de caja y respaldo/restauración en JSON.
- Caché para seguir funcionando sin conexión después de la primera carga.

## Para usarlo

1. Abre `index.html` en un navegador moderno para probarlo.
2. Para habilitar completamente la instalación como aplicación y la caché offline, publícalo en un servidor HTTPS o ejecútalo desde `localhost`.
3. Cambia los productos, precios, recetas, mesas y existencias de ejemplo antes de usarlo en operación real.
4. Descarga un respaldo desde **Exportar respaldo** al terminar cada turno. El respaldo se puede restaurar desde **Importar respaldo**.

## Límites de este prototipo

Los datos son locales a un navegador/dispositivo. Una operación real con varios celulares y caja necesita la siguiente fase: base de datos sincronizada, cuentas de usuario, cola de sincronización offline y copias de seguridad en la nube. Para emitir factura electrónica colombiana también se debe integrar un proveedor tecnológico autorizado por la DIAN; no se activa automáticamente en este prototipo.

## Novedades

**Usuarios y roles (pestaña Equipo)**
- Al abrir la app se elige el usuario y se ingresa un PIN de 4 dígitos. Primer ingreso: usuario *Administrador*, PIN `1234` (el sistema obliga a cambiarlo).
- *Mesero*: toma pedidos. *Cajero*: además cobra, abre/cierra caja, registra compras, gastos y mermas, y ve facturas. *Administrador*: todo (productos, reportes, equipo, respaldos, editar/eliminar facturas, conteo físico).
- Los permisos se ajustan en la tabla `ROLE_PERMS` de `modules.js`.
- Aviso: los datos viven en el navegador, así que el PIN es un control de acceso para el personal, no una protección contra alguien con conocimientos técnicos que abra el dispositivo.

**Facturas (pestaña Facturas)**
- Filtro por fecha, medio de pago y búsqueda. El administrador puede corregir una factura (productos, cantidades, precios, cliente, medio de pago) o eliminarla, siempre con motivo. El inventario se ajusta solo y todo queda en la bitácora (la factura eliminada se guarda completa).
- Los números de factura ya no se repiten aunque se elimine alguna.

**Proveedores y costo promedio**: cada compra actualiza el costo promedio ponderado del producto (y guarda el último costo); la utilidad usa ese costo.

**Mermas y conteo físico (Inventario)**: registro de mermas con motivo, conteo físico con diferencia valorizada y ajuste automático, con historial.

**Reportes**: comparativo con el período anterior, ventas por hora, por día de la semana, por categoría y por mesero, mermas, exportación a Excel (.xlsx con varias hojas) e impresión/PDF.

## Almacenamiento y respaldos

- Los datos ahora se guardan en **IndexedDB** (mucho más espacio que el límite de ~5 MB de antes). Al abrir la app por primera vez con esta versión, lo que estaba en el navegador se migra solo.
- **Respaldos** (Mi negocio → Respaldos de la base de datos): se crea una copia completa de la base de datos **al cerrar caja** (activable/desactivable), a demanda con «Respaldar ahora» y, en la app de Windows, también **una vez al día** automáticamente. En el navegador el respaldo se descarga como archivo `.json`; en Windows se guarda en `Documentos\BrasaPOS\Respaldos` (carpeta configurable; se conservan los últimos 120).
- Para restaurar: **Importar respaldo** (administrador).

## App de escritorio para Windows (instalador)

La carpeta incluye un proyecto de Electron que empaqueta la app como programa instalable. Guarda los datos en el disco del PC (IndexedDB + archivo espejo `nexopos.json` en `%APPDATA%\NexoPos\datos`) y escribe los respaldos en una carpeta normal.

**Crear el instalador (una sola vez, en un PC con Windows e internet):**
1. Instala Node.js LTS desde https://nodejs.org
2. Haz doble clic en `crear-instalador-windows.bat`.
3. Al terminar se abre la carpeta `dist` con `NexoPos-Setup-<versión>.exe` (por ejemplo `NexoPos-Setup-1.0.1.exe`). Cópialo al PC del negocio y ejecútalo: crea el acceso directo en el escritorio y en el menú Inicio.

Para probar sin instalar: `probar-en-escritorio.bat`.

Notas: el instalador no está firmado digitalmente, por lo que Windows SmartScreen puede mostrar «Windows protegió su PC» (Más información → Ejecutar de todas formas). Para actualizar la app se genera un instalador nuevo y se instala encima; los datos se conservan.

## Diseño y temas

- Dos temas: **oscuro «barra nocturna»** (por defecto, pensado para poca luz) y **claro** (vino y latón). Se cambia con el botón de sol/luna de la barra superior y se recuerda en cada equipo.
- Los colores viven como variables en `theme.css`; la capa visual está en `design.css`. Para cambiar la paleta basta con editar `theme.css`.
- Tipografía: Bahnschrift (números, títulos) y Segoe UI Variable, que vienen con Windows 10/11 y funcionan sin internet.
