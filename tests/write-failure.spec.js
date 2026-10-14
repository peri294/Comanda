import { test, expect } from '@playwright/test';
import { BACKEND, connect, connectStaff, fetchState, joinTable, settle } from './helpers.js';

const setOrderWritesFailing = (failing) =>
  fetch(`${BACKEND}/api/test/order-writes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failing })
  });

// Corre en su propio proyecto de Playwright, después de los specs en paralelo (ver
// playwright.config.js): mientras las escrituras fallan, nadie más puede pedir.
test('si SQLite rechaza la escritura, el server sigue vivo y la memoria no queda con el cambio', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  const kitchen = await connectStaff('kitchen', 'cocina123');

  // Mesa propia: corre solo, así que alcanza con la primera libre que asigne el server
  const added = new Promise(resolve => counter.socket.once('tables-updated', resolve));
  const before = (await fetchState(counter.token)).tables.map(t => t.id);
  counter.socket.emit('add-table', {});
  const tableId = (await added).find(t => !before.includes(t.id)).id;
  counter.socket.emit('set-table-enabled', { tableId, enabled: true });
  await expect.poll(async () => (await fetchState(counter.token)).tables.find(t => t.id === tableId)?.enabled).toBe(true);

  const client = await connect();
  await joinTable(client, tableId);
  await settle();
  const kitchenAlerts = [];
  kitchen.socket.on('order-received', order => kitchenAlerts.push(order));

  // 1. El pedido falla al guardarse: el cliente recibe el error (no se queda esperando)
  await setOrderWritesFailing(true);
  try {
    const reply = await client.timeout(5000).emitWithAck('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
    expect(reply).toEqual({ ok: false, error: 'server_error' });
  } finally {
    await setOrderWritesFailing(false);
  }

  // 2. Ni cocina ni el mostrador se enteraron de un pedido que no existe, y la mesa sigue libre
  await settle();
  expect(kitchenAlerts).toEqual([]);
  const state = await fetchState(counter.token);
  expect(state.orders.filter(o => o.tableId === tableId)).toEqual([]);
  expect(state.tables.find(t => t.id === tableId)).toMatchObject({ status: 'libre', total: 0 });

  // 3. Con la base sana, el mismo cliente pide normalmente
  const ok = await client.timeout(5000).emitWithAck('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
  expect(ok.ok).toBe(true);
  expect((await fetchState(counter.token)).tables.find(t => t.id === tableId).status).toBe('pedido_pendiente');

  counter.socket.emit('close-table', { tableId });
  await settle();
  [client, counter.socket, kitchen.socket].forEach(s => s.close());
});
