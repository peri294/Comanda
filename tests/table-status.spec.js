import { test, expect } from '@playwright/test';
import { clientUrl, joinTable, login, connect, connectStaff, fetchState, placeOrder, settle } from './helpers.js';

const tableOf = async (token, tableId) => (await fetchState(token)).tables.find(t => t.id === tableId);

test('la mesa pasa a "comiendo" recién cuando todos sus pedidos están entregados', async () => {
  const kitchen = await connectStaff('kitchen', 'cocina123');
  const counterToken = await login('counter', 'mostrador123');
  // Mesa 10: libre de los otros specs que corren en paralelo
  const client = await connect();
  await joinTable(client, '10');

  const order1 = await placeOrder(client, 'm1');
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'en_preparacion' });
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'listo' });
  await settle();

  // Mientras el mozo lleva el pedido 1, la mesa pide el pedido 2
  const order2 = await placeOrder(client, 'm8');
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'entregado' });
  await settle();
  expect((await tableOf(counterToken, '10')).status).toBe('pedido_pendiente');

  kitchen.socket.emit('update-order-status', { orderId: order2.id, status: 'entregado' });
  await settle();
  expect((await tableOf(counterToken, '10')).status).toBe('comiendo');

  client.close();
  kitchen.socket.close();
});

test('la cuenta se pide con todo entregado; pedir algo más la cancela y sigue sumando', async () => {
  const kitchen = await connectStaff('kitchen', 'cocina123');
  const counter = await connectStaff('counter', 'mostrador123');
  const billCancelled = new Promise(resolve => {
    counter.socket.on('bill-cancelled', (data) => { if (data.tableId === '11') resolve(data); });
  });
  // Mesa 11: libre de los otros specs que corren en paralelo
  const client = await connect();
  await joinTable(client, '11');

  const order1 = await placeOrder(client, 'm1'); // Espresso $1800
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'listo' });
  await settle();

  // Con el pedido todavía sin entregar, el server rechaza el pedido de cuenta
  client.emit('request-bill', { tableId: '11', paymentMethod: 'efectivo' });
  await settle();
  let table = await tableOf(counter.token, '11');
  expect(table.status).toBe('pedido_pendiente');

  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'entregado' });
  await settle();
  client.emit('request-bill', { tableId: '11', paymentMethod: 'efectivo' });
  await settle();
  table = await tableOf(counter.token, '11');
  expect(table.status).toBe('esperando_cuenta');
  expect(table.paymentMethod).toBe('efectivo');

  // Se acordaron de algo más: la cuenta se cancela y el consumo sigue sumando
  await placeOrder(client, 'm8'); // Medialuna $800
  await settle();
  table = await tableOf(counter.token, '11');
  expect(table.status).toBe('pedido_pendiente');
  expect(table.paymentMethod).toBeNull();
  expect(table.total).toBe(2600);
  await expect(billCancelled).resolves.toEqual({ tableId: '11' });

  client.close();
  kitchen.socket.close();
  counter.socket.close();
});

test('el cliente puede seguir pidiendo con la cuenta solicitada, avisado de que se cancela', async ({ browser }) => {
  const kitchen = await connectStaff('kitchen', 'cocina123');
  const clientPage = await (await browser.newContext()).newPage();
  // Mesa 12: libre de los otros specs que corren en paralelo
  await clientPage.goto(await clientUrl(12));
  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });

  const orderCreated = new Promise(resolve => {
    kitchen.socket.on('order-received', (order) => { if (order.tableId === '12') resolve(order); });
  });
  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();
  const order = await orderCreated;
  kitchen.socket.emit('update-order-status', { orderId: order.id, status: 'entregado' });

  await clientPage.getByRole('button', { name: /cerrar en efectivo/i }).click();
  await expect(clientPage.getByText('Cuenta Solicitada')).toBeVisible();

  // El menú sigue disponible y el carrito avisa que se cancela la cuenta
  await clientPage.locator('.menu-card:has-text("Medialuna Premium")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await expect(clientPage.getByText(/al enviar este pedido se cancela/i)).toBeVisible();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();

  await expect(clientPage.getByText('Cuenta Solicitada')).not.toBeVisible({ timeout: 10000 });

  kitchen.socket.close();
});
