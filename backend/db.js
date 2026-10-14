// Persistencia en SQLite usando node:sqlite (incluido en Node >= 22.13, sin
// dependencias nativas que compilar). Este módulo es solo la plomería de la base:
// esquema, prepared statements y conversión fila <-> objeto. La lógica de negocio
// vive en server.js y sigue operando sobre las estructuras en memoria; acá solo se
// refleja cada mutación en disco (write-through) y se recarga el estado al arrancar.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemsTotal } from './domain.js';

const DEFAULT_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'cafeteria.db');
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL: escrituras rápidas sin bloquear lecturas; suficiente durabilidad para este uso.
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS tables (
    id               TEXT PRIMARY KEY,
    status           TEXT NOT NULL,
    current_order_id TEXT,
    payment_method   TEXT,
    total            REAL NOT NULL DEFAULT 0,
    -- Secreto del QR de la mesa: sin él no se puede unir a la mesa ni pedir a su nombre.
    qr_token         TEXT,
    -- Mesa habilitada para pedidos (el Mostrador la abre al iniciar el día o una por una).
    -- Una mesa bloqueada siempre está vacía: si tenía clientes, queda marcada con
    -- block_on_close y se bloquea recién cuando se cobra.
    enabled          INTEGER NOT NULL DEFAULT 0,
    block_on_close   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id         TEXT PRIMARY KEY,
    table_id   TEXT NOT NULL,
    -- Items como JSON embebido: siempre se leen/escriben en bloque junto al pedido y
    -- sanitizeItems() ya garantiza su estructura al entrar. Una tabla order_items
    -- separada obligaría a joins y sincronización extra sin ninguna consulta que lo
    -- justifique hoy (si algún día hay reportes por producto, existe json_each()).
    items      TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    closed_at  TEXT
  );

  -- Menú administrable desde el Mostrador. 'available' permite apagar un producto
  -- agotado sin borrarlo (el cliente lo ve como "Agotado" y el server rechaza pedirlo).
  -- Borrar un producto no rompe el historial: orders.items guarda un snapshot JSON
  -- con nombre y precio al momento de la compra.
  CREATE TABLE IF NOT EXISTS menu (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL,
    category    TEXT NOT NULL,
    image       TEXT NOT NULL,
    available   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS assistance_requests (
    table_id    TEXT PRIMARY KEY,
    timestamp   INTEGER NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER
  );

  -- Cierres de caja del mostrador: cada cierre sella cuánto se cobró desde el cierre
  -- anterior. La "caja actual" siempre se calcula desde el último cierre en adelante.
  CREATE TABLE IF NOT EXISTS register_closures (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    closed_at    TEXT NOT NULL,
    total        REAL NOT NULL,
    orders_count INTEGER NOT NULL
  );

  -- Configuración del local que se edita desde el Mostrador (nombre, logo). Clave/valor:
  -- cada ajuste nuevo es una fila más, sin migraciones de columnas.
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Categorías del menú, administradas desde el Mostrador. Las cuatro originales se
  -- siembran con sus ids de siempre, así los productos existentes no cambian.
  CREATE TABLE IF NOT EXISTS categories (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    icon     TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
  );

  -- Fotos de productos y logo del local. Viven en la misma base a propósito: una sola
  -- cosa que respaldar, y nada que se pierda en un disco efímero (Render).
  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Migraciones para bases creadas antes de que existieran estas columnas (CREATE TABLE
// IF NOT EXISTS no agrega columnas a una tabla ya existente, y el sentido de la
// persistencia es justamente que las bases viejas sigan funcionando tras actualizar).
const addColumnIfMissing = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
addColumnIfMissing('orders', 'closed_at', 'TEXT');
// Las mesas de una base vieja quedan sin token (server.js les genera uno al arrancar)
// y arrancan bloqueadas: se habilitan con "Iniciar día".
addColumnIfMissing('tables', 'qr_token', 'TEXT');
addColumnIfMissing('tables', 'enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('tables', 'block_on_close', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('menu', 'image_id', 'TEXT');
// Mesas de una base anterior al código de visita: server.js les genera uno al arrancar.
addColumnIfMissing('tables', 'visit_code', 'TEXT');
// Los reportes y la caja filtran los pedidos cobrados por momento del cobro.
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_closed_at ON orders(closed_at)');

// --- PREPARED STATEMENTS ---

const upsertTableStmt = db.prepare(`
  INSERT INTO tables (id, status, current_order_id, payment_method, total, qr_token, enabled, block_on_close, visit_code)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    current_order_id = excluded.current_order_id,
    payment_method = excluded.payment_method,
    total = excluded.total,
    qr_token = excluded.qr_token,
    enabled = excluded.enabled,
    block_on_close = excluded.block_on_close,
    visit_code = excluded.visit_code
`);

const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (id, table_id, items, notes, status, archived, created_at, closed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    items = excluded.items,
    notes = excluded.notes,
    status = excluded.status,
    archived = excluded.archived,
    closed_at = excluded.closed_at
`);

const upsertAssistanceStmt = db.prepare(`
  INSERT INTO assistance_requests (table_id, timestamp, resolved, resolved_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(table_id) DO UPDATE SET
    timestamp = excluded.timestamp,
    resolved = excluded.resolved,
    resolved_at = excluded.resolved_at
`);

const upsertMenuStmt = db.prepare(`
  INSERT INTO menu (id, name, description, price, category, image, available, image_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    price = excluded.price,
    category = excluded.category,
    image = excluded.image,
    available = excluded.available,
    image_id = excluded.image_id
`);

const upsertCategoryStmt = db.prepare(`
  INSERT INTO categories (id, name, icon, position) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, position = excluded.position
`);
const deleteCategoryStmt = db.prepare('DELETE FROM categories WHERE id = ?');
const insertImageStmt = db.prepare('INSERT INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?)');
const getImageStmt = db.prepare('SELECT mime, data FROM images WHERE id = ?');
const imageExistsStmt = db.prepare('SELECT 1 FROM images WHERE id = ?');
const deleteImageStmt = db.prepare('DELETE FROM images WHERE id = ?');

const deleteAssistanceStmt = db.prepare('DELETE FROM assistance_requests WHERE table_id = ?');
const deleteTableStmt = db.prepare('DELETE FROM tables WHERE id = ?');
const deleteMenuStmt = db.prepare('DELETE FROM menu WHERE id = ?');
const insertClosureStmt = db.prepare('INSERT INTO register_closures (closed_at, total, orders_count) VALUES (?, ?, ?)');

// --- CONVERSIÓN FILA <-> OBJETO ---

const rowToTable = (row) => ({
  id: row.id,
  status: row.status,
  currentOrderId: row.current_order_id,
  paymentMethod: row.payment_method,
  total: row.total,
  qrToken: row.qr_token,
  visitCode: row.visit_code,
  enabled: Boolean(row.enabled),
  blockOnClose: Boolean(row.block_on_close)
});

const rowToMenuItem = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  price: row.price,
  category: row.category,
  image: row.image,
  imageId: row.image_id,
  available: Boolean(row.available)
});

const rowToOrder = (row) => ({
  id: row.id,
  tableId: row.table_id,
  items: JSON.parse(row.items),
  notes: row.notes,
  status: row.status,
  archived: Boolean(row.archived),
  createdAt: row.created_at,
  closedAt: row.closed_at
});

// --- API DEL MÓDULO ---

// Agrupa varias escrituras para que un crash a mitad de camino no deje estado
// inconsistente (ej.: close-table archiva N pedidos + resetea la mesa).
export const runInTransaction = (fn) => {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

export const persistTable = (table) => {
  upsertTableStmt.run(table.id, table.status, table.currentOrderId, table.paymentMethod, table.total, table.qrToken || null,
    table.enabled ? 1 : 0, table.blockOnClose ? 1 : 0, table.visitCode || null);
};

export const persistOrder = (order) => {
  upsertOrderStmt.run(
    order.id,
    order.tableId,
    JSON.stringify(order.items),
    order.notes || '',
    order.status,
    order.archived ? 1 : 0,
    order.createdAt,
    order.closedAt || null
  );
};

export const persistAssistance = (tableId, request) => {
  upsertAssistanceStmt.run(tableId, request.timestamp, request.resolved ? 1 : 0, request.resolvedAt);
};

export const deleteAssistance = (tableId) => {
  deleteAssistanceStmt.run(tableId);
};

export const deleteTable = (tableId) => {
  deleteTableStmt.run(tableId);
};

export const persistMenuItem = (item) => {
  upsertMenuStmt.run(
    item.id,
    item.name,
    item.description || '',
    item.price,
    item.category,
    item.image,
    item.available ? 1 : 0,
    item.imageId || null
  );
};

export const persistCategory = (category) => {
  upsertCategoryStmt.run(category.id, category.name, category.icon || '', category.position);
};

export const deleteCategory = (id) => {
  deleteCategoryStmt.run(id);
};

// --- IMÁGENES ---

export const saveImage = ({ id, mime, data }) => {
  insertImageStmt.run(id, mime, data, new Date().toISOString());
};

export const getImage = (id) => getImageStmt.get(id);

export const imageExists = (id) => Boolean(imageExistsStmt.get(id));

export const deleteImage = (id) => {
  deleteImageStmt.run(id);
};

// Borra las imágenes que no están en keepIds: fotos que se subieron y nunca se asignaron
// (un formulario que se canceló después de elegir la foto).
export const deleteUnusedImages = (keepIds) => {
  const keep = new Set(keepIds);
  const unused = db.prepare('SELECT id FROM images').all().map(row => row.id).filter(id => !keep.has(id));
  runInTransaction(() => unused.forEach(id => deleteImageStmt.run(id)));
  return unused.length;
};

export const deleteMenuItem = (id) => {
  deleteMenuStmt.run(id);
};

// Carga el estado persistido a memoria. Si la base está vacía (primer arranque),
// la siembra con las mesas iniciales. Los pedidos ya archivados (mesa cobrada o
// pedido cancelado) quedan en la base como historial pero no se cargan: ningún
// flujo los lee después de archivar, y así la memoria no crece sin límite.
export const loadState = (initialTables, defaultMenu, defaultCategories) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tables').get();
  if (n === 0) {
    runInTransaction(() => initialTables.forEach(persistTable));
  }

  // El menú se siembra aparte de las mesas: una base creada antes de que existiera
  // la tabla menu ya tiene mesas, pero el menú igual necesita su semilla inicial.
  const { m } = db.prepare('SELECT COUNT(*) AS m FROM menu').get();
  if (m === 0) {
    runInTransaction(() => defaultMenu.forEach(persistMenuItem));
  }

  // Las categorías también se siembran aparte: una base anterior a la tabla categories
  // tiene productos en las cuatro categorías fijas de antes, que son justo la semilla.
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM categories').get();
  if (c === 0) {
    runInTransaction(() => defaultCategories.forEach(persistCategory));
  }

  return {
    tables: db.prepare('SELECT * FROM tables ORDER BY CAST(id AS INTEGER)').all().map(rowToTable),
    // rowid preserva el orden de inserción, igual que el array en memoria.
    orders: db.prepare('SELECT * FROM orders WHERE archived = 0 ORDER BY rowid').all().map(rowToOrder),
    menu: db.prepare('SELECT * FROM menu ORDER BY rowid').all().map(rowToMenuItem),
    categories: db.prepare('SELECT * FROM categories ORDER BY position, rowid').all()
      .map(({ id, name, icon, position }) => ({ id, name, icon, position })),
    assistanceRequests: new Map(
      db.prepare('SELECT * FROM assistance_requests').all().map(row => [
        row.table_id,
        { timestamp: row.timestamp, resolved: Boolean(row.resolved), resolvedAt: row.resolved_at }
      ])
    )
  };
};

// Ventas cobradas después de un instante dado. Se filtra por closed_at (momento del
// cobro, no de la creación del pedido: una mesa que pidió a las 23:50 y pagó a las
// 00:10 cuenta para la caja en que entró la plata; comparar ISO strings funciona
// porque ordenan lexicográficamente). Los cancelados nunca tienen closed_at, así que
// quedan afuera. El total se suma en JS desde el JSON de items — son un puñado de
// filas por caja y evita denormalizar un total que pueda divergir de los items.
const salesSince = (sinceIso) => {
  const rows = db
    .prepare("SELECT items FROM orders WHERE archived = 1 AND status = 'entregado' AND closed_at > ?")
    .all(sinceIso);
  return {
    total: rows.reduce((acc, row) => acc + itemsTotal(JSON.parse(row.items)), 0),
    ordersCount: rows.length
  };
};

// La caja actual arranca en el último cierre de caja. Si nunca se cerró la caja, en la
// medianoche LOCAL del server (el comportamiento previo a que existieran los cierres).
// Ojo: si el último cierre fue ayer, lo cobrado después de ese cierre cuenta para la
// caja de hoy — la plata que no entró en un arqueo entra en el siguiente, no se pierde.
const getRegisterStartIso = () => {
  const lastClosure = db.prepare('SELECT MAX(closed_at) AS at FROM register_closures').get().at;
  if (lastClosure) return lastClosure;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
};

// "Caja del Día" que muestra el mostrador: lo cobrado desde el último cierre.
export const getDailySalesTotal = () => salesSince(getRegisterStartIso()).total;

// Cierre de caja: sella lo cobrado desde el cierre anterior como una fila del
// histórico y devuelve el resumen. La caja siguiente arranca desde este instante.
export const closeRegister = () => {
  const { total, ordersCount } = salesSince(getRegisterStartIso());
  const closedAt = new Date().toISOString();
  insertClosureStmt.run(closedAt, total, ordersCount);
  return { closedAt, total, ordersCount };
};

// --- CONFIGURACIÓN DEL LOCAL ---

const upsertSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// Los ajustes guardados, sobre los valores por defecto (un ajuste que nunca se tocó no
// tiene fila).
export const getSettings = (defaults) => ({
  ...defaults,
  ...Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(row => [row.key, row.value]))
});

export const saveSettings = (settings) => {
  runInTransaction(() => {
    for (const [key, value] of Object.entries(settings)) upsertSettingStmt.run(key, value);
  });
};

// --- REPORTES ---

// Datos crudos de un reporte de ventas entre dos instantes ([desde, hasta)). La
// agregación es de domain.js (buildSalesReport), igual que la caja suma los items en JS.
// Los cancelados no tienen closed_at: se cuentan por la fecha en que se pidieron.
export const getSalesReportData = (startIso, endIso) => ({
  paidOrders: db
    .prepare("SELECT table_id, items, closed_at FROM orders WHERE archived = 1 AND status = 'entregado' AND closed_at >= ? AND closed_at < ?")
    .all(startIso, endIso)
    .map(row => ({ tableId: row.table_id, items: JSON.parse(row.items), closedAt: row.closed_at })),
  cancelledCount: db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelado' AND created_at >= ? AND created_at < ?")
    .get(startIso, endIso).n,
  closures: db
    .prepare('SELECT closed_at, total, orders_count FROM register_closures WHERE closed_at >= ? AND closed_at < ? ORDER BY closed_at')
    .all(startIso, endIso)
    .map(row => ({ closedAt: row.closed_at, total: row.total, ordersCount: row.orders_count }))
});

// Solo para los tests E2E: hace que SQLite rechace toda escritura en la tabla `orders`
// (o la vuelve a permitir), para probar qué pasa cuando una escritura falla. Es un
// trigger TEMP: vive en esta conexión y desaparece al reiniciar el server.
export const setOrderWritesFailing = (failing) => {
  db.exec('DROP TRIGGER IF EXISTS temp.fail_order_insert; DROP TRIGGER IF EXISTS temp.fail_order_update;');
  if (!failing) return;
  db.exec(`
    CREATE TEMP TRIGGER fail_order_insert BEFORE INSERT ON main.orders BEGIN SELECT RAISE(ABORT, 'escritura forzada a fallar'); END;
    CREATE TEMP TRIGGER fail_order_update BEFORE UPDATE ON main.orders BEGIN SELECT RAISE(ABORT, 'escritura forzada a fallar'); END;
  `);
};

// Solo para /api/test/reset y el reset de la demo pública: vuelve la base al estado de
// primer arranque. Borra también el historial de pedidos archivados — aceptable porque
// en un despliegue real (producción sin DEMO_MODE) no se llama nunca.
export const resetState = (initialTables, defaultMenu, defaultCategories) => {
  runInTransaction(() => {
    db.exec('DELETE FROM orders; DELETE FROM assistance_requests; DELETE FROM register_closures; DELETE FROM tables; DELETE FROM menu; DELETE FROM settings; DELETE FROM categories; DELETE FROM images;');
    initialTables.forEach(persistTable);
    defaultMenu.forEach(persistMenuItem);
    defaultCategories.forEach(persistCategory);
  });
};
