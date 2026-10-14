import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKEND, login } from './helpers.js';

const backup = (token) =>
  fetch(`${BACKEND}/api/backup`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('la copia de seguridad es la base completa y solo la descarga el mostrador', async () => {
  expect((await backup(null)).status).toBe(401);
  expect((await backup(await login('kitchen', 'cocina123'))).status).toBe(403);

  const res = await backup(await login('counter', 'mostrador123'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toMatch(/comanda-\d{4}-\d{2}-\d{2}\.db/);
  const file = Buffer.from(await res.arrayBuffer());
  expect(file.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');

  // Se abre como cualquier base y tiene el menú y las categorías
  const dir = mkdtempSync(path.join(os.tmpdir(), 'comanda-backup-test-'));
  try {
    const dbFile = path.join(dir, 'backup.db');
    writeFileSync(dbFile, file);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    // (No se compara la cantidad de productos: menu.spec agrega y borra uno en paralelo)
    expect(db.prepare("SELECT name FROM menu WHERE id = 'm1'").get().name).toBe('Espresso Italiano');
    expect(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n).toBeGreaterThan(0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
