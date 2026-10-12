import { test, expect } from '@playwright/test';
import { BACKEND, joinTable, login, connect, fetchState, settle } from './helpers.js';

test('cocina solo puede avanzar un pedido por estados válidos', async () => {
  const counterToken = await login('counter', 'mostrador123');
  const kitchen = await connect();
  kitchen.emit('join', { role: 'kitchen', token: await login('kitchen', 'cocina123') });

  // Mesa 7: libre de los otros specs que corren en paralelo
  const client = await connect();
  await joinTable(client, '7');
  const created = new Promise(resolve => client.once('order-status-changed', resolve));
  client.emit('new-order', { tableId: '7', items: [{ productId: 'm1', quantity: 1 }] });
  const order = await created;
  const statusOf = async () => (await fetchState(counterToken)).orders.find(o => o.id === order.id)?.status;

  // Estado inventado: se ignora
  kitchen.emit('update-order-status', { orderId: order.id, status: 'hackeado' });
  await settle();
  expect(await statusOf()).toBe('pendiente');

  // 'cancelado' no es un estado de cocina (lo pone solo el Mostrador)
  kitchen.emit('update-order-status', { orderId: order.id, status: 'cancelado' });
  await settle();
  expect(await statusOf()).toBe('pendiente');

  // Avanzar funciona, retroceder no
  kitchen.emit('update-order-status', { orderId: order.id, status: 'listo' });
  await settle();
  expect(await statusOf()).toBe('listo');
  kitchen.emit('update-order-status', { orderId: order.id, status: 'en_preparacion' });
  await settle();
  expect(await statusOf()).toBe('listo');

  // Un pedido cancelado por el Mostrador no puede "resucitar" en la pantalla de cocina
  const counter = await connect();
  counter.emit('join', { role: 'counter', token: counterToken });
  const second = new Promise(resolve => client.once('order-status-changed', resolve));
  client.emit('new-order', { tableId: '7', items: [{ productId: 'm8', quantity: 1 }] });
  const cancelled = await second;
  counter.emit('cancel-order', { orderId: cancelled.id });
  await settle();
  const kitchenLists = [];
  kitchen.on('orders-updated', list => kitchenLists.push(list));
  kitchen.emit('update-order-status', { orderId: cancelled.id, status: 'listo' });
  await settle();
  // La lista de cocina filtra por estado: si el cambio pasara, el cancelado reaparecería ahí
  expect(kitchenLists.some(list => list.some(o => o.id === cancelled.id))).toBe(false);

  [client, kitchen, counter].forEach(s => s.close());
});

test('la cuenta solo se pide con un método válido y la mesa con todo entregado', async () => {
  const counterToken = await login('counter', 'mostrador123');
  const tableOf = async () => (await fetchState(counterToken)).tables.find(t => t.id === '9');

  // Mesa 9: libre de los otros specs que corren en paralelo
  const client = await connect();
  await joinTable(client, '9');

  // Mesa libre en $0: no hay cuenta que pedir
  client.emit('request-bill', { tableId: '9', paymentMethod: 'efectivo' });
  await settle();
  expect((await tableOf()).status).toBe('libre');

  const kitchen = await connect();
  kitchen.emit('join', { role: 'kitchen', token: await login('kitchen', 'cocina123') });
  const created = new Promise(resolve => client.once('order-status-changed', resolve));
  client.emit('new-order', { tableId: '9', items: [{ productId: 'm1', quantity: 1 }] });
  const order = await created;
  kitchen.emit('update-order-status', { orderId: order.id, status: 'entregado' });
  await settle();
  expect((await tableOf()).status).toBe('comiendo');

  // Método de pago inventado: se ignora
  client.emit('request-bill', { tableId: '9', paymentMethod: 'bitcoin' });
  await settle();
  let table = await tableOf();
  expect(table.status).toBe('comiendo');
  expect(table.paymentMethod).toBeNull();

  // Método válido: funciona
  client.emit('request-bill', { tableId: '9', paymentMethod: 'tarjeta' });
  await settle();
  table = await tableOf();
  expect(table.status).toBe('pagando_tarjeta');
  expect(table.paymentMethod).toBe('tarjeta');

  client.close();
  kitchen.close();
});

test('un payload null en los eventos públicos no tira abajo el server', async () => {
  // Sin login ni token de mesa: lo que puede mandar cualquiera desde la consola
  const attacker = await connect();
  attacker.emit('join', null);
  attacker.emit('request-bill', null);
  attacker.emit('new-order', null);
  await settle();

  // El server sigue vivo: responde HTTP y la conexión no se cortó
  expect((await fetch(`${BACKEND}/api/menu`)).ok).toBe(true);
  expect(attacker.connected).toBe(true);

  attacker.close();
});

test('un payload null en los eventos del personal no tira abajo el server', async () => {
  const counter = await connect();
  counter.emit('join', { role: 'counter', token: await login('counter', 'mostrador123') });
  const kitchen = await connect();
  kitchen.emit('join', { role: 'kitchen', token: await login('kitchen', 'cocina123') });
  await settle();

  // Solo los eventos que leen el payload. add-table queda afuera: sin número agrega una
  // mesa, y las que no ignoran el payload (end-day, close-register, revoke-other-sessions)
  // afectarían a los specs que corren en paralelo.
  kitchen.emit('update-order-status', null);
  ['edit-order', 'cancel-order', 'resolve-assistance', 'remove-table', 'regenerate-table-qr',
    'set-table-enabled', 'close-table', 'menu-add', 'menu-update', 'menu-delete']
    .forEach(event => counter.emit(event, null));
  await settle();

  expect((await fetch(`${BACKEND}/api/menu`)).ok).toBe(true);
  expect(counter.connected).toBe(true);
  expect(kitchen.connected).toBe(true);

  counter.close();
  kitchen.close();
});
