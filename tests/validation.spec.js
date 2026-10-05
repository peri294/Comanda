import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';

const BACKEND = 'http://localhost:3001';

const login = async (role, password) => {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, password })
  });
  return (await res.json()).token;
};

const connect = async () => {
  const socket = io(BACKEND, { transports: ['websocket'] });
  await new Promise(resolve => socket.on('connect', resolve));
  return socket;
};

const fetchState = async (token) =>
  (await fetch(`${BACKEND}/api/initial-state`, { headers: { Authorization: `Bearer ${token}` } })).json();

const settle = () => new Promise(resolve => setTimeout(resolve, 300));

test('cocina solo puede avanzar un pedido por estados válidos', async () => {
  const counterToken = await login('counter', 'mostrador123');
  const kitchen = await connect();
  kitchen.emit('join', { role: 'kitchen', token: await login('kitchen', 'cocina123') });

  // Mesa 7: libre de los otros specs que corren en paralelo
  const client = await connect();
  client.emit('join', { role: 'table-7' });
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
  client.emit('join', { role: 'table-9' });

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
