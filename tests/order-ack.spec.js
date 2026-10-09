import { test, expect } from '@playwright/test';
import { connect, connectStaff, fetchState, joinTable, addTable, clientUrl } from './helpers.js';

// Mesas 36 y 37, creadas por cada test (ver addTable en helpers.js).

// new-order con acknowledgement: devuelve la respuesta del server
const sendOrder = (socket, payload) => socket.timeout(5000).emitWithAck('new-order', payload);

test('new-order confirma o rechaza con motivo, y sanea notes y paymentMethod', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '36');
  const stateOf36 = async () => {
    const state = await fetchState(counter.token);
    return { table: state.tables.find(t => t.id === '36'), orders: state.orders.filter(o => o.tableId === '36') };
  };

  // Conexión sin mesa: rechazo explícito en vez de silencio
  const anonymous = await connect();
  expect(await sendOrder(anonymous, { items: [{ productId: 'm1', quantity: 1 }] }))
    .toEqual({ ok: false, error: 'table_unavailable' });

  const client = await connect();
  await joinTable(client, '36');

  // Nada válido para pedir
  expect(await sendOrder(client, { items: [{ productId: 'no-existe', quantity: 1 }] }))
    .toEqual({ ok: false, error: 'no_valid_items' });
  expect(await sendOrder(client, null)).toEqual({ ok: false, error: 'no_valid_items' });

  // notes que no es string (antes tiraba abajo el render de Cocina y Mostrador) y un
  // paymentMethod inventado (antes se guardaba tal cual en la mesa)
  const res = await sendOrder(client, { items: [{ productId: 'm1', quantity: 1 }], notes: { x: 1 }, paymentMethod: 'bitcoin' });
  expect(res.ok).toBe(true);
  let { table, orders } = await stateOf36();
  expect(orders.find(o => o.id === res.orderId).notes).toBe('');
  expect(table.paymentMethod).toBeNull();

  // notes largo: se recorta al tope del server
  const long = await sendOrder(client, { items: [{ productId: 'm8', quantity: 1 }], notes: 'a'.repeat(5000) });
  ({ orders } = await stateOf36());
  expect(orders.find(o => o.id === long.orderId).notes).toHaveLength(300);

  // Mesa bloqueada: rechazo con su motivo (vaciarla primero para que se bloquee en el acto)
  orders.forEach(o => counter.socket.emit('cancel-order', { orderId: o.id }));
  counter.socket.emit('set-table-enabled', { tableId: '36', enabled: false });
  await expect.poll(async () => (await stateOf36()).table.enabled).toBe(false);
  expect(await sendOrder(client, { items: [{ productId: 'm1', quantity: 1 }] }))
    .toEqual({ ok: false, error: 'table_disabled' });

  [anonymous, client, counter.socket].forEach(s => s.close());
});

test('sin conexión el pedido no se pierde: el carrito se conserva y se reenvía al volver', async ({ page }) => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '37');

  await page.goto(await clientUrl(37));
  await expect(page.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });
  await page.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await page.locator('.cart-float-btn').click();

  // Se corta la señal justo antes de confirmar
  await page.evaluate(() => window.__socket.disconnect());
  await page.getByRole('button', { name: /confirmar y enviar pedido/i }).click();
  await expect(page.getByRole('alert')).toContainText('Sin conexión');
  await expect(page.getByText('Espresso Italiano').last()).toBeVisible(); // sigue en el carrito

  // Vuelve la señal: el reenvío llega una sola vez (antes el evento quedaba en el buffer,
  // salía antes del join a la mesa y el server lo descartaba)
  await page.evaluate(() => window.__socket.connect());
  await expect(page.getByText('Servidor Conectado')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /confirmar y enviar pedido/i }).click();
  await expect(page.getByText('Pedido Recibido')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.cart-float-btn')).toHaveCount(0);

  const orders = (await fetchState(counter.token)).orders.filter(o => o.tableId === '37');
  expect(orders).toHaveLength(1);

  counter.socket.close();
});
