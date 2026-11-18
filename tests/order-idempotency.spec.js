import { test, expect } from '@playwright/test';
import { connect, connectStaff, fetchState, joinTable, addTable, settle } from './helpers.js';

// Mesa 48: propia de este spec (1–13 y 30–47 ya tienen dueño; no empieza con 2, 5, 6, 12,
// 13, 34 ni 35, así no choca con ningún locator hasText: 'Mesa N').

const sendOrder = (socket, payload) => socket.timeout(5000).emitWithAck('new-order', payload);

test('reintentar new-order con el mismo clientOrderId devuelve el mismo pedido sin duplicarlo', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  const kitchen = await connectStaff('kitchen', 'cocina123');
  await addTable(counter, '48');

  const kitchenOrders = [];
  kitchen.socket.on('order-received', (order) => {
    if (order.tableId === '48') kitchenOrders.push(order);
  });

  const client = await connect();
  await joinTable(client, '48');
  await settle();

  const payload = {
    items: [{ productId: 'm1', quantity: 1 }],
    notes: 'sin azúcar',
    clientOrderId: 'intento-mesa-48-1'
  };

  const first = await sendOrder(client, payload);
  expect(first.ok).toBe(true);
  expect(first.orderId).toMatch(/^ord-/);

  // Segundo envío con el mismo clientOrderId (simula un reintento tras perderse el ack)
  const second = await sendOrder(client, payload);
  expect(second).toEqual({ ok: true, orderId: first.orderId });
  await settle();

  const state = await fetchState(counter.token);
  const tableOrders = state.orders.filter(o => o.tableId === '48');
  expect(tableOrders).toHaveLength(1);
  expect(tableOrders[0].id).toBe(first.orderId);
  expect(state.tables.find(t => t.id === '48').total).toBe(1800);
  expect(kitchenOrders).toHaveLength(1);

  // Otro carrito con un clientOrderId distinto sí crea un pedido nuevo
  const third = await sendOrder(client, {
    items: [{ productId: 'm8', quantity: 1 }],
    clientOrderId: 'intento-mesa-48-2'
  });
  expect(third.ok).toBe(true);
  expect(third.orderId).not.toBe(first.orderId);
  const afterThird = (await fetchState(counter.token)).orders.filter(o => o.tableId === '48');
  expect(afterThird).toHaveLength(2);

  [client, kitchen.socket, counter.socket].forEach(s => s.close());
});
