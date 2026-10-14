import { test, expect } from '@playwright/test';
import { joinTable, connect, connectStaff, fetchState, placeOrder, settle, addTable } from './helpers.js';

// Corre en su propio proyecto de Playwright, después de los specs en paralelo (ver
// playwright.config.js): cobrar suma a la caja del día, y tables.spec controla su monto.
test('cobrar una mesa con pedidos en cocina le avisa a cocina y los saca de su pantalla', async () => {
  const kitchen = await connectStaff('kitchen', 'cocina123');
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '39');
  const client = await connect();
  await joinTable(client, '39');

  // Un pedido ya servido y otro que cocina todavía está preparando
  const served = await placeOrder(client, 'm1');
  kitchen.socket.emit('update-order-status', { orderId: served.id, status: 'entregado' });
  const cooking = await placeOrder(client, 'm8');
  kitchen.socket.emit('update-order-status', { orderId: cooking.id, status: 'en_preparacion' });
  await settle();

  const alerts = [];
  kitchen.socket.on('order-modified', alert => { if (alert.order.tableId === '39') alerts.push(alert); });
  counter.socket.emit('close-table', { tableId: '39' });
  await settle();

  // Solo el que estaba en cocina genera aviso, y ya no figura en su estado
  expect(alerts.map(a => [a.order.id, a.reason])).toEqual([[cooking.id, 'closed']]);
  const kitchenState = await fetchState(kitchen.token);
  expect(kitchenState.orders.some(o => o.tableId === '39')).toBe(false);
  // Se cobró igual: la mesa queda libre y sin pedidos activos para el mostrador
  const counterState = await fetchState(counter.token);
  expect(counterState.orders.some(o => o.tableId === '39')).toBe(false);
  expect(counterState.tables.find(t => t.id === '39').status).toBe('libre');

  [client, kitchen.socket, counter.socket].forEach(s => s.close());
});
