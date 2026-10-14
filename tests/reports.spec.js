import { test, expect } from '@playwright/test';
import { BACKEND, connect, connectStaff, joinTable, addTable, login } from './helpers.js';

// Corre en su propio proyecto de Playwright, después de los specs en paralelo (ver
// playwright.config.js): cobra una mesa, y otros specs controlan el monto de la caja.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const report = (token, from = today(), to = today()) =>
  fetch(`${BACKEND}/api/reports?from=${from}&to=${to}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('el reporte del día suma lo cobrado, por producto y por mesa, y solo lo ve el mostrador', async ({ browser }) => {
  const counter = await connectStaff('counter', 'mostrador123');
  const before = await (await report(counter.token)).json();
  const espressoBefore = before.topProducts.find(p => p.productId === 'm1')?.quantity || 0;

  // Mesa 42: dos pedidos en una misma visita, y se cobra
  await addTable(counter, '42');
  const client = await connect();
  await joinTable(client, '42');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect((await client.emitWithAck('new-order', { items: [{ productId: 'm1', quantity: 2 }] })).ok).toBe(true);
  expect((await client.emitWithAck('new-order', { items: [{ productId: 'm8', quantity: 1 }] })).ok).toBe(true);
  const closed = new Promise(resolve => client.once('table-closed', resolve));
  counter.socket.emit('close-table', { tableId: '42' });
  await closed;

  const after = await (await report(counter.token)).json();
  expect(after.total - before.total).toBe(2 * 1800 + 800);
  expect(after.ordersCount - before.ordersCount).toBe(2);
  expect(after.visitsCount - before.visitsCount).toBe(1);
  expect(after.topProducts.find(p => p.productId === 'm1').quantity - espressoBefore).toBe(2);
  expect(after.byDay).toEqual([{ date: today(), total: after.total, orders: after.ordersCount }]);

  // Solo el mostrador, y con un rango válido
  expect((await report(null)).status).toBe(401);
  expect((await report(await login('kitchen', 'cocina123'))).status).toBe(403);
  expect((await report(counter.token, '2026-10-05', '2026-10-01')).status).toBe(400);
  expect((await report(counter.token, 'ayer', today())).status).toBe(400);

  // En el Mostrador: el panel muestra los mismos números
  const page = await (await browser.newContext()).newPage();
  await page.goto('/?view=counter');
  await page.getByPlaceholder('Contraseña').fill('mostrador123');
  await page.getByRole('button', { name: /ingresar/i }).click();
  await page.getByRole('button', { name: /reportes/i }).click();
  await page.getByRole('button', { name: 'Hoy' }).click();
  const totalTile = page.locator('.report-kpis .glass-panel', { hasText: 'Total vendido' });
  await expect(totalTile).toContainText(`$${after.total.toLocaleString('es-AR')}`, { timeout: 10000 });
  await expect(page.locator('.report-products')).toContainText('Espresso Italiano');

  client.close();
  counter.socket.close();
});
