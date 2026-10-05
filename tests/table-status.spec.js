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

const connectStaff = async (role, password) => {
  const token = await login(role, password);
  const socket = await connect();
  socket.emit('join', { role, token });
  return { socket, token };
};

const fetchState = async (token) =>
  (await fetch(`${BACKEND}/api/initial-state`, { headers: { Authorization: `Bearer ${token}` } })).json();

const tableOf = async (token, tableId) => (await fetchState(token)).tables.find(t => t.id === tableId);

// Manda un pedido desde un socket de mesa y devuelve el pedido creado por el server
const placeOrder = async (client, tableId, productId) => {
  const created = new Promise(resolve => {
    const onChange = (order) => {
      if (order.status === 'pendiente' && order.items.some(i => i.productId === productId)) {
        client.off('order-status-changed', onChange);
        resolve(order);
      }
    };
    client.on('order-status-changed', onChange);
  });
  client.emit('new-order', { tableId, items: [{ productId, quantity: 1 }] });
  return created;
};

const settle = () => new Promise(resolve => setTimeout(resolve, 300));

test('la mesa pasa a "comiendo" recién cuando todos sus pedidos están entregados', async () => {
  const kitchen = await connectStaff('kitchen', 'cocina123');
  const counterToken = await login('counter', 'mostrador123');
  // Mesa 10: libre de los otros specs que corren en paralelo
  const client = await connect();
  client.emit('join', { role: 'table-10' });

  const order1 = await placeOrder(client, '10', 'm1');
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'en_preparacion' });
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'listo' });
  await settle();

  // Mientras el mozo lleva el pedido 1, la mesa pide el pedido 2
  const order2 = await placeOrder(client, '10', 'm8');
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'entregado' });
  await settle();
  expect((await tableOf(counterToken, '10')).status).toBe('pedido_pendiente');

  kitchen.socket.emit('update-order-status', { orderId: order2.id, status: 'entregado' });
  await settle();
  expect((await tableOf(counterToken, '10')).status).toBe('comiendo');

  client.close();
  kitchen.socket.close();
});

test('entregar un pedido no pisa la cuenta pedida; pedir algo más la cancela y sigue sumando', async () => {
  const kitchen = await connectStaff('kitchen', 'cocina123');
  const counter = await connectStaff('counter', 'mostrador123');
  const billCancelled = new Promise(resolve => {
    counter.socket.on('bill-cancelled', (data) => { if (data.tableId === '11') resolve(data); });
  });
  // Mesa 11: libre de los otros specs que corren en paralelo
  const client = await connect();
  client.emit('join', { role: 'table-11' });

  const order1 = await placeOrder(client, '11', 'm1'); // Espresso $1800
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'listo' });
  await settle();

  // La mesa pide la cuenta mientras el mozo le lleva el pedido
  client.emit('request-bill', { tableId: '11', paymentMethod: 'efectivo' });
  await settle();
  kitchen.socket.emit('update-order-status', { orderId: order1.id, status: 'entregado' });
  await settle();
  let table = await tableOf(counter.token, '11');
  expect(table.status).toBe('esperando_cuenta');
  expect(table.paymentMethod).toBe('efectivo');

  // Se acordaron de algo más: la cuenta se cancela y el consumo sigue sumando
  await placeOrder(client, '11', 'm8'); // Medialuna $800
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
  await clientPage.goto('/?view=client&table=12');
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
