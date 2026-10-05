import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';
import { tableToken, joinTable } from './helpers.js';

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

const connectCounter = async () => {
  const token = await login('counter', 'mostrador123');
  const socket = await connect();
  socket.emit('join', { role: 'counter', token });
  return { socket, token };
};

const fetchState = async (token) =>
  (await fetch(`${BACKEND}/api/initial-state`, { headers: { Authorization: `Bearer ${token}` } })).json();

// Respuesta del server al join de una mesa: el estado de la mesa, o null si no entró
const joinWith = async (socket, tableId, token) => {
  const state = new Promise(resolve => socket.once('table-state', resolve));
  socket.emit('join', { role: `table-${tableId}`, token });
  return state;
};

const settle = () => new Promise(resolve => setTimeout(resolve, 300));

// Las 12 mesas semilla y la 13 (tables.spec) ya tienen dueño entre los specs que corren
// en paralelo: estos tests crean las suyas con número puntual (30 en adelante: con 2x,
// 5x o 6x chocarían con locators por substring como hasText: 'Mesa 2').
const addTable = async (counter, id) => {
  counter.socket.emit('add-table', { id });
  await expect.poll(async () => (await fetchState(counter.token)).tables.some(t => t.id === id)).toBe(true);
};

test('sin el token del QR no se entra a la mesa, y una mesa no puede actuar sobre otra', async () => {
  const counter = await connectCounter();
  await addTable(counter, '30');
  await addTable(counter, '31');
  const tableOf = async (id) => (await fetchState(counter.token)).tables.find(t => t.id === id);

  // 1. Sin token, o con el token de otra mesa: el join responde null
  const intruder = await connect();
  expect(await joinWith(intruder, '31', undefined)).toBeNull();
  expect(await joinWith(intruder, '31', await tableToken('30'))).toBeNull();

  // ...y por eso no ve los pedidos de la mesa 31 ni puede pedir a su nombre
  const spied = [];
  intruder.on('order-status-changed', order => spied.push(order));
  intruder.emit('new-order', { tableId: '31', items: [{ productId: 'm1', quantity: 1 }] });
  await settle();
  expect((await tableOf('31')).status).toBe('libre');

  // 2. La mesa 30, con su token, manda eventos con el tableId de la 31: se ignora el
  // tableId del payload y todo cae en la mesa 30.
  const client30 = await connect();
  expect((await joinWith(client30, '30', await tableToken('30'))).id).toBe('30');
  // Filtrado por mesa: otros specs en paralelo también llaman al mozo
  const assistance = new Promise(resolve => counter.socket.on('assistance-requested', data => {
    if (data.tableId === '30' || data.tableId === '31') resolve(data);
  }));
  const created = new Promise(resolve => client30.once('order-status-changed', resolve));
  client30.emit('new-order', { tableId: '31', items: [{ productId: 'm1', quantity: 1 }] });
  expect((await created).tableId).toBe('30');
  client30.emit('request-assistance', { tableId: '31' });
  expect((await assistance).tableId).toBe('30');
  expect((await tableOf('30')).status).toBe('pedido_pendiente');
  expect((await tableOf('31')).status).toBe('libre');

  // 3. La mesa 31 pide con su token: el intruso rechazado no recibe nada de ese pedido
  const client31 = await connect();
  await joinTable(client31, '31');
  const created31 = new Promise(resolve => client31.once('order-status-changed', resolve));
  client31.emit('new-order', { items: [{ productId: 'm8', quantity: 1 }] });
  expect((await created31).tableId).toBe('31');
  await settle();
  expect(spied).toEqual([]);

  // 4. La cocina no recibe los tokens: solo el mostrador los necesita para mostrar los QR
  const kitchenState = await fetchState(await login('kitchen', 'cocina123'));
  expect(kitchenState.tables.every(t => t.qrToken === undefined)).toBe(true);
  expect((await tableOf('30')).qrToken).toBe(await tableToken('30'));

  [intruder, client30, client31, counter.socket].forEach(s => s.close());
});

test('regenerar el QR corta al token viejo; cerrar la mesa lo conserva', async () => {
  const counter = await connectCounter();
  await addTable(counter, '32');
  const oldToken = await tableToken('32');

  // Cerrar la mesa (close-table la reconstruye) no cambia el token: el QR impreso sigue
  // sirviendo. El pedido se cancela antes para no sumar a la Caja del Día, que
  // tables.spec verifica con el monto exacto.
  const client = await connect();
  await joinTable(client, '32');
  const created = new Promise(resolve => client.once('order-status-changed', resolve));
  client.emit('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
  const order = await created;
  counter.socket.emit('cancel-order', { orderId: order.id });
  counter.socket.emit('close-table', { tableId: '32' });
  await settle();
  expect(await tableToken('32')).toBe(oldToken);

  // Regenerar: quien está conectado con el token viejo recibe el aviso y pierde el acceso
  const removed = new Promise(resolve => client.once('table-removed', resolve));
  counter.socket.emit('regenerate-table-qr', { tableId: '32' });
  await removed;
  const newToken = await tableToken('32');
  expect(newToken).not.toBe(oldToken);

  client.emit('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
  await settle();
  const table = (await fetchState(counter.token)).tables.find(t => t.id === '32');
  expect(table.status).toBe('libre');

  // El token viejo ya no entra; el nuevo sí
  expect(await joinWith(client, '32', oldToken)).toBeNull();
  expect((await joinWith(client, '32', newToken)).id).toBe('32');

  client.close();
  counter.socket.close();
});
