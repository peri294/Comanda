// Persistencia en SQLite usando node:sqlite (incluido en Node >= 22.13, sin
// dependencias nativas que compilar). Este módulo es solo la plomería de la base:
// esquema, prepared statements y conversión fila <-> objeto. La lógica de negocio
// vive en server.js y sigue operando sobre las estructuras en memoria; acá solo se
// refleja cada mutación en disco (write-through) y se recarga el estado al arrancar.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    total            REAL NOT NULL DEFAULT 0
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
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assistance_requests (
    table_id    TEXT PRIMARY KEY,
    timestamp   INTEGER NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER
  );
`);

// --- PREPARED STATEMENTS ---

const upsertTableStmt = db.prepare(`
  INSERT INTO tables (id, status, current_order_id, payment_method, total)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    current_order_id = excluded.current_order_id,
    payment_method = excluded.payment_method,
    total = excluded.total
`);

const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (id, table_id, items, notes, status, archived, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    items = excluded.items,
    notes = excluded.notes,
    status = excluded.status,
    archived = excluded.archived
`);

const upsertAssistanceStmt = db.prepare(`
  INSERT INTO assistance_requests (table_id, timestamp, resolved, resolved_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(table_id) DO UPDATE SET
    timestamp = excluded.timestamp,
    resolved = excluded.resolved,
    resolved_at = excluded.resolved_at
`);

const deleteAssistanceStmt = db.prepare('DELETE FROM assistance_requests WHERE table_id = ?');

// --- CONVERSIÓN FILA <-> OBJETO ---

const rowToTable = (row) => ({
  id: row.id,
  status: row.status,
  currentOrderId: row.current_order_id,
  paymentMethod: row.payment_method,
  total: row.total
});

const rowToOrder = (row) => ({
  id: row.id,
  tableId: row.table_id,
  items: JSON.parse(row.items),
  notes: row.notes,
  status: row.status,
  archived: Boolean(row.archived),
  createdAt: row.created_at
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
  upsertTableStmt.run(table.id, table.status, table.currentOrderId, table.paymentMethod, table.total);
};

export const persistOrder = (order) => {
  upsertOrderStmt.run(
    order.id,
    order.tableId,
    JSON.stringify(order.items),
    order.notes || '',
    order.status,
    order.archived ? 1 : 0,
    order.createdAt
  );
};

export const persistAssistance = (tableId, request) => {
  upsertAssistanceStmt.run(tableId, request.timestamp, request.resolved ? 1 : 0, request.resolvedAt);
};

export const deleteAssistance = (tableId) => {
  deleteAssistanceStmt.run(tableId);
};

// Carga el estado persistido a memoria. Si la base está vacía (primer arranque),
// la siembra con las mesas iniciales. Los pedidos ya archivados (mesa cobrada o
// pedido cancelado) quedan en la base como historial pero no se cargan: ningún
// flujo los lee después de archivar, y así la memoria no crece sin límite.
export const loadState = (initialTables) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tables').get();
  if (n === 0) {
    runInTransaction(() => initialTables.forEach(persistTable));
  }

  return {
    tables: db.prepare('SELECT * FROM tables ORDER BY CAST(id AS INTEGER)').all().map(rowToTable),
    // rowid preserva el orden de inserción, igual que el array en memoria.
    orders: db.prepare('SELECT * FROM orders WHERE archived = 0 ORDER BY rowid').all().map(rowToOrder),
    assistanceRequests: new Map(
      db.prepare('SELECT * FROM assistance_requests').all().map(row => [
        row.table_id,
        { timestamp: row.timestamp, resolved: Boolean(row.resolved), resolvedAt: row.resolved_at }
      ])
    )
  };
};

// Solo para /api/test/reset: vuelve la base al estado de primer arranque.
// Borra también el historial de pedidos archivados — aceptable porque el endpoint
// no existe en producción y los tests necesitan un estado 100% limpio.
export const resetState = (initialTables) => {
  runInTransaction(() => {
    db.exec('DELETE FROM orders; DELETE FROM assistance_requests; DELETE FROM tables;');
    initialTables.forEach(persistTable);
  });
};
