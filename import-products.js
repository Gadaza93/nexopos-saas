/* NexoPos · Módulo de Importación Masiva de Productos e Inventario (Excel / CSV)
   Permite descargar la plantilla oficial, parsear archivos .xlsx/.csv usando SheetJS,
   mapear encabezados inteligentes, previsualizar los datos, persistir en IndexedDB
   y sincronizar el lote en Supabase. */

(function () {
  'use strict';

  let currentParsedItems = [];
  let currentFile = null;

  // SheetJS (~900 KB) ya no se carga al arrancar: se pide la primera vez que hace falta y queda en caché.
  // Es un archivo propio (CSP 'self') y el service worker lo guarda, así que funciona sin conexión.
  let xlsxLoading = null;
  function loadXlsxLib() {
    const ready = () => (typeof XLSX !== 'undefined' ? XLSX : globalThis.XLSX) || null;
    if (ready()) return Promise.resolve(ready());
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return Promise.resolve(null);
    if (!xlsxLoading) {
      xlsxLoading = new Promise(resolve => {
        const script = document.createElement('script');
        script.src = './xlsx.full.min.js';
        script.onload = () => resolve(ready());
        script.onerror = () => { xlsxLoading = null; script.remove(); resolve(null); };
        document.head.appendChild(script);
      });
    }
    return xlsxLoading;
  }

  // 1. Normalización de encabezados (sin tildes, minúsculas, sin caracteres especiales)
  function normalizeHeader(h) {
    if (!h) return '';
    return String(h)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 2. Mapeo inteligente de encabezados habituales de Excel/CSV
  function mapColumns(headers) {
    const map = {
      name: -1,
      category: -1,
      price: -1,
      cost: -1,
      stock: -1,
      minStock: -1,
      unit: -1,
      code: -1
    };

    headers.forEach((h, idx) => {
      const norm = normalizeHeader(h);
      if (!norm) return;

      // Nombre del producto
      if (map.name === -1 && (
        norm === 'nombre item' || norm === 'nombre de item' || norm === 'nombre' ||
        norm === 'producto' || norm === 'item' || norm === 'descripcion' ||
        norm === 'articulo' || norm === 'nombre producto' || norm.startsWith('nombre') ||
        norm.startsWith('producto')
      )) {
        map.name = idx;
        return;
      }

      // Categoría
      if (map.category === -1 && (
        norm === 'categoria' || norm === 'category' || norm === 'linea' ||
        norm === 'grupo' || norm === 'familia' || norm === 'seccion' ||
        norm === 'clasificacion'
      )) {
        map.category = idx;
        return;
      }

      // Precio de venta
      if (map.price === -1 && (
        norm === 'precio venta' || norm === 'precio de venta' || norm === 'precio' ||
        norm === 'pvp' || norm === 'valor venta' || norm === 'precio unitario' ||
        norm === 'valor unitario' || norm.includes('venta') || norm.startsWith('precio')
      )) {
        map.price = idx;
        return;
      }

      // Costo Unitario
      if (map.cost === -1 && (
        norm === 'costo unitario promedio' || norm === 'costo unitario' || norm === 'costo' ||
        norm === 'costo promedio' || norm === 'valor costo' || norm === 'precio compra' ||
        norm === 'costo compra' || norm.includes('costo')
      )) {
        map.cost = idx;
        return;
      }

      // Stock / Cantidad actual
      if (map.stock === -1 && (
        norm === 'cantidad actual' || norm === 'stock actual' || norm === 'stock' ||
        norm === 'cantidad' || norm === 'existencias' || norm === 'inventario actual' ||
        norm === 'cant' || norm === 'qty' || norm === 'existencia'
      )) {
        map.stock = idx;
        return;
      }

      // Stock mínimo
      if (map.minStock === -1 && (
        norm === 'stock minimo' || norm === 'minimo' || norm === 'stock min' ||
        norm === 'alerta minimo' || norm === 'cant minima' || norm === 'min'
      )) {
        map.minStock = idx;
        return;
      }

      // Unidad de medida
      if (map.unit === -1 && (
        norm === 'unidad' || norm === 'medida' || norm === 'unidad de medida' ||
        norm === 'presentacion' || norm === 'u m' || norm === 'um' || norm === 'und'
      )) {
        map.unit = idx;
        return;
      }

      // Código / Código de barras
      if (map.code === -1 && (
        norm === 'codigo' || norm === 'codigo de barras' || norm === 'barcode' ||
        norm === 'sku' || norm === 'ref' || norm === 'referencia' || norm === 'plu' ||
        norm === 'cod' || norm.startsWith('cod')
      )) {
        map.code = idx;
        return;
      }
    });

    return map;
  }

  // 3. Limpieza y conversión numérica inteligente (soporta '$', comas, puntos, espacios)
  function parseMoneyOrNumber(val, defaultVal = 0) {
    if (val === null || val === undefined || val === '') return defaultVal;
    if (typeof val === 'number') return Number.isNaN(val) ? defaultVal : val;

    let s = String(val).trim().replace(/[$\sCOPcop]/g, '');
    if (!s) return defaultVal;

    // Detectar separadores decimales vs miles
    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        // Formato 12.500,00 -> 12500.00
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        // Formato 12,500.00 -> 12500.00
        s = s.replace(/,/g, '');
      }
    } else if (s.includes(',')) {
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length === 3) {
        s = parts[0] + parts[1]; // e.g. 12,500
      } else {
        s = s.replace(',', '.');
      }
    } else if (s.includes('.')) {
      const parts = s.split('.');
      if (parts.length === 2 && parts[1].length === 3) {
        s = parts[0] + parts[1]; // e.g. 12.500
      }
    }

    const num = parseFloat(s);
    return Number.isNaN(num) ? defaultVal : num;
  }

  // 4. Descarga de la plantilla estándar (.xlsx con fallback a .csv)
  async function downloadProductTemplate() {
    const headers = ['Categoría', 'Nombre ítem', 'Precio Venta', 'Costo Unitario', 'Stock Actual', 'Stock Mínimo', 'Unidad', 'Código'];
    const sampleRows = [
      ['Cervezas', 'Cerveza Corona 330ml', 9000, 4800, 48, 12, 'Unidad', '770123456789'],
      ['Licores', 'Aguardiente Antioqueño 750ml', 85000, 48000, 15, 4, 'Botella', '770987654321'],
      ['Cócteles', 'Mojito Clásico', 22000, 6500, 30, 8, 'Copa', 'COCT-001'],
      ['Bebidas', 'Agua Manantial con Gas 300ml', 5000, 1800, 24, 6, 'Botella', '770555111222'],
      ['Snacks', 'Papas Pringles Original 124g', 14000, 7500, 20, 5, 'Unidad', 'SNK-002']
    ];

    const xlsxLib = await loadXlsxLib();

    if (xlsxLib && typeof xlsxLib.utils === 'object') {
      try {
        const wb = xlsxLib.utils.book_new();
        const wsData = [headers, ...sampleRows];
        const ws = xlsxLib.utils.aoa_to_sheet(wsData);

        ws['!cols'] = [
          { wch: 18 }, // Categoría
          { wch: 34 }, // Nombre ítem
          { wch: 15 }, // Precio Venta
          { wch: 15 }, // Costo Unitario
          { wch: 14 }, // Stock Actual
          { wch: 14 }, // Stock Mínimo
          { wch: 12 }, // Unidad
          { wch: 16 }  // Código
        ];

        xlsxLib.utils.book_append_sheet(wb, ws, 'Plantilla Productos');
        xlsxLib.writeFile(wb, 'plantilla_productos_nexopos.xlsx');
        if (typeof showToast === 'function') showToast('Plantilla Excel descargada.');
        return;
      } catch (err) {
        console.warn('[ImportProducts] Error generando XLSX, usando fallback CSV:', err);
      }
    }

    // Fallback CSV (UTF-8 con BOM para que Excel lo abra con tildes y caracteres correctos)
    const csvLines = [headers.join(';'), ...sampleRows.map(r => r.join(';'))].join('\r\n');
    const blob = new Blob(['\uFEFF' + csvLines], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'plantilla_productos_nexopos.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    if (typeof showToast === 'function') showToast('Plantilla CSV descargada.');
  }

  // 5. Apertura del modal
  function openImportProductsDialog() {
    if (typeof can === 'function' && !can('products')) {
      if (typeof deny === 'function') return deny();
      if (typeof showToast === 'function') return showToast('No tienes permisos para gestionar productos.');
      return;
    }

    resetImportDialog();
    loadXlsxLib(); // se adelanta la descarga mientras el usuario elige el archivo
    const dlg = document.querySelector('#importProductsDialog');
    if (dlg) {
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }
  }

  // 6. Resetear el modal al estado inicial
  function resetImportDialog() {
    currentParsedItems = [];
    currentFile = null;

    const fileInput = document.querySelector('#importProductFileInput');
    if (fileInput) fileInput.value = '';

    const dropZone = document.querySelector('#importDropZone');
    if (dropZone) dropZone.hidden = false;

    const fileDetails = document.querySelector('#importFileDetails');
    if (fileDetails) fileDetails.hidden = true;

    const previewContainer = document.querySelector('#importPreviewContainer');
    if (previewContainer) previewContainer.hidden = true;

    const errorAlert = document.querySelector('#importErrorAlert');
    if (errorAlert) {
      errorAlert.hidden = true;
      errorAlert.textContent = '';
    }

    const confirmBtn = document.querySelector('#confirmImportBtn');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirmar e Importar';
    }
  }

  // 7. Parsear archivo con SheetJS
  async function parseProductFile(file) {
    if (!file) return;

    const xlsxLib = await loadXlsxLib();
    if (!xlsxLib) {
      showErrorAlert('La librería para procesar Excel no se pudo cargar. Recarga la app e inténtalo de nuevo.');
      return;
    }

    currentFile = file;
    showFileDetails(file);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = xlsxLib.read(new Uint8Array(buffer), { type: 'array' });

      if (!workbook.SheetNames || !workbook.SheetNames.length) {
        showErrorAlert('El archivo no contiene hojas de cálculo con datos.');
        return;
      }

      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = xlsxLib.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });

      if (!rawRows || rawRows.length < 2) {
        showErrorAlert('El archivo está vacío o solo contiene la fila de encabezados.');
        return;
      }

      // Encontrar la fila de encabezados (normalmente la primera no vacía)
      let headerRowIndex = 0;
      for (let i = 0; i < Math.min(5, rawRows.length); i++) {
        const row = rawRows[i];
        if (Array.isArray(row) && row.some(cell => String(cell).trim().length > 0)) {
          headerRowIndex = i;
          break;
        }
      }

      const headers = rawRows[headerRowIndex].map(c => String(c).trim());
      const colMap = mapColumns(headers);

      if (colMap.name === -1) {
        showErrorAlert('No se detectó la columna del Nombre del Producto (e.g. «Nombre ítem», «Producto» o «Item»). Verifica los encabezados.');
        return;
      }

      // Mapear filas de datos
      const existingProducts = (typeof state !== 'undefined' && Array.isArray(state.products)) ? state.products : [];
      const parsedItems = [];

      for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
        const row = rawRows[r];
        if (!Array.isArray(row) || row.every(c => String(c).trim() === '')) {
          continue; // ignorar filas totalmente vacías
        }

        const rawName = colMap.name !== -1 ? String(row[colMap.name] || '').trim() : '';
        if (!rawName) {
          // Fila inválida sin nombre
          parsedItems.push({
            isInvalid: true,
            error: 'Fila sin nombre de producto',
            rawRow: row
          });
          continue;
        }

        const category = colMap.category !== -1 && String(row[colMap.category] || '').trim() ? String(row[colMap.category]).trim() : 'General';
        const price = colMap.price !== -1 ? Math.max(0, parseMoneyOrNumber(row[colMap.price], 0)) : 0;
        const cost = colMap.cost !== -1 ? Math.max(0, parseMoneyOrNumber(row[colMap.cost], 0)) : 0;
        const rawStock = colMap.stock !== -1 ? parseMoneyOrNumber(row[colMap.stock], 0) : 0;
        const minStock = colMap.minStock !== -1 ? Math.max(0, parseMoneyOrNumber(row[colMap.minStock], 1)) : 1;
        const unit = colMap.unit !== -1 && String(row[colMap.unit] || '').trim() ? String(row[colMap.unit]).trim() : 'Unidad';
        const code = colMap.code !== -1 && String(row[colMap.code] || '').trim() ? String(row[colMap.code]).trim() : '';

        // Mismas reglas que el formulario manual: el precio de venta debe ser mayor a $0
        if (!(price > 0)) {
          parsedItems.push({ isInvalid: true, error: `«${rawName}»: precio de venta en $0 o vacío`, rawRow: row });
          continue;
        }

        // Detectar si ya existe
        const isMatch = existingProducts.some(p => {
          if (code && p.code && String(p.code).trim().toLowerCase() === code.toLowerCase()) return true;
          return p.name && p.name.trim().toLowerCase() === rawName.toLowerCase();
        });

        parsedItems.push({
          name: rawName,
          category,
          price,
          cost,
          stock: rawStock,
          minStock,
          unit,
          code,
          isUpdate: isMatch,
          isInvalid: false
        });
      }

      if (!parsedItems.length) {
        showErrorAlert('No se encontraron filas de productos válidas en el archivo.');
        return;
      }

      currentParsedItems = parsedItems;
      renderPreview(parsedItems);

    } catch (err) {
      console.error('[ImportProducts] Error al leer archivo:', err);
      showErrorAlert(`Error al leer el archivo: ${err.message || 'Formato no compatible'}`);
    }
  }

  // 8. Mostrar detalles del archivo seleccionado
  function showFileDetails(file) {
    const dropZone = document.querySelector('#importDropZone');
    const fileDetails = document.querySelector('#importFileDetails');
    const nameEl = document.querySelector('#importFileName');
    const sizeEl = document.querySelector('#importFileSize');

    if (dropZone) dropZone.hidden = true;
    if (fileDetails) fileDetails.hidden = false;
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;

    const errorAlert = document.querySelector('#importErrorAlert');
    if (errorAlert) {
      errorAlert.hidden = true;
      errorAlert.textContent = '';
    }
  }

  // 9. Mostrar alerta de error
  function showErrorAlert(msg) {
    const errorAlert = document.querySelector('#importErrorAlert');
    if (errorAlert) {
      errorAlert.hidden = false;
      errorAlert.textContent = msg;
    }
    const previewContainer = document.querySelector('#importPreviewContainer');
    if (previewContainer) previewContainer.hidden = true;
    const confirmBtn = document.querySelector('#confirmImportBtn');
    if (confirmBtn) confirmBtn.disabled = true;
  }

  // 10. Renderizar la previsualización y resumen
  function renderPreview(items) {
    const validItems = items.filter(i => !i.isInvalid);
    const newCount = validItems.filter(i => !i.isUpdate).length;
    const updateCount = validItems.filter(i => i.isUpdate).length;
    const warningCount = items.filter(i => i.isInvalid).length;

    const totalEl = document.querySelector('#importSummaryTotal');
    const newEl = document.querySelector('#importSummaryNew');
    const updateEl = document.querySelector('#importSummaryUpdate');
    const warningEl = document.querySelector('#importSummaryWarning');
    const warningWrap = document.querySelector('#importSummaryWarningWrap');

    if (totalEl) totalEl.textContent = String(items.length);
    if (newEl) newEl.textContent = String(newCount);
    if (updateEl) updateEl.textContent = String(updateCount);
    if (warningEl) warningEl.textContent = String(warningCount);
    if (warningWrap) warningWrap.hidden = warningCount === 0;

    const tbody = document.querySelector('#importPreviewBody');
    if (tbody) {
      tbody.innerHTML = items.slice(0, 50).map(item => {
        if (item.isInvalid) {
          return `
            <tr style="opacity:0.6;">
              <td><span class="import-badge badge-invalid">Inválido</span></td>
              <td colspan="8"><span class="muted">${escapeHtml(item.error || 'Fila omitida')}</span></td>
            </tr>
          `;
        }

        const badge = item.isUpdate
          ? '<span class="import-badge badge-update">Actualizar</span>'
          : '<span class="import-badge badge-new">Nuevo</span>';

        const fmtMoney = (val) => {
          if (typeof money !== 'undefined' && typeof money.format === 'function') return money.format(val);
          return `$${Number(val).toLocaleString('es-CO')}`;
        };

        const stockWarning = item.stock < 0 ? ' <small style="color:var(--danger);">(Negativo)</small>' : '';

        return `
          <tr>
            <td>${badge}</td>
            <td><strong>${escapeHtml(item.name)}</strong></td>
            <td>${escapeHtml(item.category)}</td>
            <td>${fmtMoney(item.cost)}</td>
            <td><strong>${fmtMoney(item.price)}</strong></td>
            <td>${item.stock}${stockWarning}</td>
            <td>${item.minStock}</td>
            <td><small class="muted">${escapeHtml(item.unit)}</small></td>
            <td><small class="muted">${escapeHtml(item.code || '—')}</small></td>
          </tr>
        `;
      }).join('');

      if (items.length > 50) {
        tbody.innerHTML += `
          <tr>
            <td colspan="9" style="text-align:center;color:var(--muted);padding:10px;">
              ... y ${items.length - 50} productos más listos para importar.
            </td>
          </tr>
        `;
      }
    }

    const previewContainer = document.querySelector('#importPreviewContainer');
    if (previewContainer) previewContainer.hidden = false;

    const confirmBtn = document.querySelector('#confirmImportBtn');
    if (confirmBtn) {
      confirmBtn.disabled = validItems.length === 0;
      confirmBtn.textContent = `Confirmar e Importar (${validItems.length} productos)`;
    }
  }

  // 11. Ejecución del Guardado Masivo (IndexedDB + Supabase)
  async function executeProductImport() {
    const validItems = currentParsedItems.filter(i => !i.isInvalid);
    if (!validItems.length) {
      if (typeof showToast === 'function') showToast('No hay productos válidos para importar.');
      return;
    }

    const confirmBtn = document.querySelector('#confirmImportBtn');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ Importando catálogo...';
    }

    const updateExisting = document.querySelector('#importUpdateExisting')?.checked ?? true;

    if (typeof state === 'undefined' || !state) {
      if (typeof showToast === 'function') showToast('Error: base de datos local no disponible.');
      return;
    }

    if (!Array.isArray(state.products)) state.products = [];
    if (!Array.isArray(state.inventory)) state.inventory = [];
    if (!Array.isArray(state.categories)) state.categories = [];

    let newCount = 0;
    let updatedCount = 0;
    const nowIso = new Date().toISOString();

    for (const item of validItems) {
      const finalStock = Math.max(0, Number(item.stock) || 0); // el sistema no admite existencias negativas (igual que el formulario)

      // Buscar si el producto ya existe por código o por nombre
      let existingProd = null;
      if (updateExisting) {
        existingProd = state.products.find(p => {
          if (item.code && p.code && String(p.code).trim().toLowerCase() === item.code.toLowerCase()) return true;
          return p.name && p.name.trim().toLowerCase() === item.name.toLowerCase();
        });
      }

      if (existingProd) {
        // Actualizar producto existente
        existingProd.name = item.name;
        existingProd.category = item.category;
        existingProd.cost = item.cost;
        existingProd.price = item.price;
        existingProd.stock = finalStock;
        if (item.code) existingProd.code = item.code;
        existingProd.sync_status = 'pending';
        existingProd.updated_at = nowIso;

        // Actualizar o crear insumo en state.inventory
        let supply = state.inventory.find(i => i.id === existingProd.inventoryId || i.id === `stock-${existingProd.id}`);
        if (supply) {
          supply.name = item.name;
          supply.qty = finalStock;
          supply.min = item.minStock;
          supply.unit = item.unit || supply.unit || 'und';
        } else {
          const invId = existingProd.inventoryId || `stock-${existingProd.id}`;
          existingProd.inventoryId = invId;
          existingProd.recipe = { [invId]: 1 };
          state.inventory.push({
            id: invId,
            name: item.name,
            unit: item.unit || 'und',
            qty: finalStock,
            min: item.minStock
          });
        }

        updatedCount++;
      } else {
        // Crear nuevo producto e insumo
        const invId = (typeof uid === 'function') ? uid('inv') : `inv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const prodId = (typeof uid === 'function') ? uid('prod') : `prod-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

        state.inventory.push({
          id: invId,
          name: item.name,
          unit: item.unit || 'und',
          qty: finalStock,
          min: item.minStock
        });

        state.products.push({
          id: prodId,
          name: item.name,
          category: item.category,
          cost: item.cost,
          price: item.price,
          stock: finalStock,
          code: item.code || '',
          icon: '🍾',
          image: null,
          inventoryId: invId,
          recipe: { [invId]: 1 },
          sync_status: 'pending',
          createdAt: Date.now(),
          created_at: nowIso,
          updated_at: nowIso
        });

        newCount++;
      }

      // Asegurar categoría en el catálogo
      if (item.category && !state.categories.includes(item.category)) {
        state.categories.push(item.category);
      }
    }

    // 1. Guardar localmente de inmediato (Offline-First en IndexedDB y espejo local)
    if (typeof saveState === 'function') saveState();

    // 2. Registrar en la bitácora de auditoría
    if (typeof logAudit === 'function') {
      logAudit('Importación masiva', `${validItems.length} productos procesados (${newCount} nuevos, ${updatedCount} actualizados)`);
    }

    // 3. Actualizar vistas inmediatamente
    if (typeof renderAll === 'function') renderAll();
    if (typeof renderInventory === 'function') renderInventory();
    if (typeof renderNavigation === 'function') renderNavigation();
    if (typeof renderProducts === 'function') renderProducts();

    // 4. Cerrar el diálogo
    const dlg = document.querySelector('#importProductsDialog');
    if (dlg && typeof dlg.close === 'function') dlg.close();

    // 5. Notificar al usuario
    const summaryMsg = `✅ ${validItems.length} productos procesados exitosamente (${newCount} creados, ${updatedCount} actualizados).`;
    if (typeof showToast === 'function') showToast(summaryMsg);

    // 6. Enviar lote masivo a Supabase (Cloud Sync)
    if (globalThis.NexoSync && typeof globalThis.NexoSync.syncProductos === 'function') {
      globalThis.NexoSync.syncProductos({ force: true }).then(res => {
        if (res && res.ok) {
          console.log(`[NexoSync] ✅ Lote importado sincronizado con Supabase (${res.count} registros).`);
        } else {
          console.warn('[NexoSync] ⚠️ Aviso: los productos quedaron guardados localmente y se sincronizarán en el próximo ciclo:', res?.error);
        }
      }).catch(err => {
        console.warn('[NexoSync] ⚠️ Error en sincronización de productos importados:', err.message);
      });
    }
  }

  // 12. Helper para escapar HTML seguro
  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 13. Vinculación de eventos al cargar el DOM
  function setupImportEvents() {
    // Botón descargar plantilla en cabecera
    const downloadBtn = document.querySelector('#downloadTemplateBtn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => downloadProductTemplate());
    }

    // Link dentro del modal
    const modalTemplateLink = document.querySelector('#importDialogTemplateLink');
    if (modalTemplateLink) {
      modalTemplateLink.addEventListener('click', (e) => {
        e.preventDefault();
        downloadProductTemplate();
      });
    }

    // Botón abrir modal en cabecera
    const importBtn = document.querySelector('#importProductsBtn');
    if (importBtn) {
      importBtn.addEventListener('click', () => openImportProductsDialog());
    }

    // Input file y Drop zone
    const fileInput = document.querySelector('#importProductFileInput');
    const dropZone = document.querySelector('#importDropZone');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });

      ['dragleave', 'dragend'].forEach(evt => {
        dropZone.addEventListener(evt, () => dropZone.classList.remove('dragover'));
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          parseProductFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
          parseProductFile(e.target.files[0]);
        }
      });
    }

    // Botón remover archivo
    const removeBtn = document.querySelector('#importRemoveFileBtn');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => resetImportDialog());
    }

    // Botón confirmar importación
    const confirmBtn = document.querySelector('#confirmImportBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => executeProductImport());
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupImportEvents);
  } else {
    setupImportEvents();
  }

  // Exposición global
  globalThis.downloadProductTemplate = downloadProductTemplate;
  globalThis.openImportProductsDialog = openImportProductsDialog;
  globalThis.executeProductImport = executeProductImport;
  globalThis.normalizeHeader = normalizeHeader;
  globalThis.mapColumns = mapColumns;
  globalThis.parseMoneyOrNumber = parseMoneyOrNumber;
})();
