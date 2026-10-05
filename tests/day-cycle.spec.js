import { test, expect } from '@playwright/test';
import { clientUrl, joinTable, connect, connectStaff, settle } from './helpers.js';

// Corre en su propio proyecto de Playwright, después de todos los demás specs (ver
// playwright.config.js): cerrar el día bloquea todas las mesas.
test('cerrar el día bloquea las mesas libres al instante y las ocupadas al cobrarlas', async ({ browser }) => {
  const counterPage = await (await browser.newContext()).newPage();
  const clientPage = await (await browser.newContext()).newPage();

  await counterPage.goto('/?view=counter');
  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();

  // Panel cargado antes de agregar mesas: si no, la respuesta del estado inicial podría
  // llegar después del aviso de las mesas nuevas y pisarlo
  await expect(counterPage.locator('.table-card', { hasText: 'Mesa 12' })).toBeVisible({ timeout: 15000 });

  // Mesas propias: la 34 va a quedar ocupada y la 35 libre, con un cliente mirándola
  const mesa34 = counterPage.locator('.table-card', { hasText: 'Mesa 34' });
  const mesa35 = counterPage.locator('.table-card', { hasText: 'Mesa 35' });
  const { socket: counterSocket } = await connectStaff('counter', 'mostrador123');
  counterSocket.emit('add-table', { id: '34' });
  counterSocket.emit('add-table', { id: '35' });
  await expect(mesa35).toBeVisible({ timeout: 10000 });
  // Iniciar el día habilita todas las mesas, incluidas las recién agregadas
  await counterPage.getByRole('button', { name: /iniciar día/i }).click();
  await expect(mesa34.getByText('Libre')).toBeVisible({ timeout: 10000 });
  await expect(mesa35.getByText('Libre')).toBeVisible();

  const client34 = await connect();
  await joinTable(client34, '34');
  const created = new Promise(resolve => client34.once('order-status-changed', resolve));
  client34.emit('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
  await created;
  await expect(mesa34.getByText('Pedido Recibido')).toBeVisible({ timeout: 10000 });

  await clientPage.goto(await clientUrl(35));
  await expect(clientPage.getByText('Nuestro Menú')).toBeVisible({ timeout: 20000 });

  // CERRAR EL DÍA, sin cerrar la caja (es opcional: se rechaza el segundo diálogo)
  const dialogs = [];
  counterPage.on('dialog', dialog => {
    dialogs.push(dialog.message());
    if (dialog.message().includes('¿Cerrar el día?')) dialog.accept();
    else dialog.dismiss();
  });
  await counterPage.getByRole('button', { name: /cerrar día/i }).click();

  // La mesa libre se bloquea al instante, y su cliente lo ve en vivo
  await expect(mesa35.getByText('Bloqueada')).toBeVisible({ timeout: 10000 });
  await expect(clientPage.getByText('Mesa no habilitada')).toBeVisible({ timeout: 10000 });
  expect(dialogs.some(m => m.includes('¿Cerrar también la caja?'))).toBe(true);
  await expect(counterPage.getByText('Caja cerrada')).toHaveCount(0);

  // La ocupada queda marcada y sus clientes siguen pudiendo pedir
  await expect(mesa34.getByText('Se bloquea al cobrar')).toBeVisible();
  const second = new Promise(resolve => client34.once('order-status-changed', resolve));
  client34.emit('new-order', { items: [{ productId: 'm8', quantity: 1 }] });
  expect((await second).tableId).toBe('34');

  // Al cobrarla se resetea, se bloquea y sus celulares quedan desconectados
  const closed = new Promise(resolve => client34.once('table-closed', resolve));
  counterSocket.emit('close-table', { tableId: '34' });
  await closed;
  await expect(mesa34.getByText('Bloqueada')).toBeVisible({ timeout: 10000 });
  await expect(mesa34.getByText('Se bloquea al cobrar')).toHaveCount(0);

  // Quien vuelve a escanear el QR de una mesa bloqueada no ve nada de la visita anterior
  const late = await connect();
  const lateState = new Promise(resolve => late.once('table-state', resolve));
  const lateOrders = [];
  late.on('order-status-changed', order => lateOrders.push(order));
  await joinTable(late, '34');
  expect((await lateState).enabled).toBe(false);
  await settle();
  expect(lateOrders).toEqual([]);

  // INICIAR EL DÍA: todas las mesas se habilitan y el cliente vuelve a ver el menú en vivo
  await counterPage.getByRole('button', { name: /iniciar día/i }).click();
  await expect(mesa34.getByText('Libre')).toBeVisible({ timeout: 10000 });
  await expect(mesa35.getByText('Libre')).toBeVisible();
  await expect(clientPage.getByText('Nuestro Menú')).toBeVisible({ timeout: 10000 });

  [client34, late, counterSocket].forEach(s => s.close());
});
