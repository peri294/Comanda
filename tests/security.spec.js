import { test, expect } from '@playwright/test';
import { BACKEND, connect, connectStaff, addTable, joinTable, settle } from './helpers.js';

test('las respuestas llevan headers de seguridad y los errores no muestran el stack', async () => {
  const res = await fetch(`${BACKEND}/api/config`);
  expect(res.headers.get('x-powered-by')).toBeNull();
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');

  const malformed = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"role": "counter", '
  });
  expect(malformed.status).toBe(400);
  const body = await malformed.text();
  expect(JSON.parse(body)).toEqual({ error: 'JSON inválido' });
  expect(body).not.toMatch(/at |node_modules|\\\\|\//);
});

test('topes de pedidos: cantidades y líneas, freno por mesa y tamaño de los mensajes', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '45');
  const client = await connect();
  await joinTable(client, '45');
  await settle();
  const order = (items) => client.emitWithAck('new-order', { items });

  // Una cantidad gigante (1e308 daba un total Infinity) o demasiadas líneas no se aceptan
  expect(await order([{ productId: 'm1', quantity: 1e308 }])).toEqual({ ok: false, error: 'no_valid_items' });
  expect(await order([{ productId: 'm1', quantity: 51 }])).toEqual({ ok: false, error: 'no_valid_items' });
  const lines = Array.from({ length: 31 }, () => ({ productId: 'm8', quantity: 1 }));
  expect(await order(lines)).toEqual({ ok: false, error: 'no_valid_items' });

  // Diez pedidos seguidos pasan; el undécimo se frena
  for (let i = 0; i < 10; i++) {
    expect((await order([{ productId: 'm8', quantity: 1 }])).ok).toBe(true);
  }
  const limited = await order([{ productId: 'm8', quantity: 1 }]);
  expect(limited).toMatchObject({ ok: false, error: 'rate_limited' });
  expect(limited.retryInMs).toBeGreaterThan(0);

  // Un mensaje de más de 64 KB corta la conexión en vez de procesarse
  const disconnected = new Promise(resolve => client.once('disconnect', resolve));
  client.emit('new-order', { items: [{ productId: 'm8', quantity: 1 }], notes: 'x'.repeat(70 * 1024) });
  await disconnected;

  client.close();
  counter.socket.close();
});

test('topes del menú: precio máximo y textos recortados', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  const menu = async () => (await fetch(`${BACKEND}/api/menu`)).json();

  counter.socket.emit('menu-add', { name: 'Precio Absurdo', price: 1e9, category: 'salado' });
  counter.socket.emit('menu-add', { name: 'Largo '.repeat(50), description: 'd'.repeat(5000), price: 100, category: 'salado' });
  await expect.poll(async () => (await menu()).some(m => m.name.startsWith('Largo'))).toBe(true);
  const items = await menu();
  expect(items.some(m => m.name === 'Precio Absurdo')).toBe(false);
  const long = items.find(m => m.name.startsWith('Largo'));
  expect(long.name.length).toBeLessThanOrEqual(80);
  expect(long.description.length).toBe(300);

  counter.socket.emit('menu-delete', { id: long.id });
  await expect.poll(async () => (await menu()).some(m => m.id === long.id)).toBe(false);
  counter.socket.close();
});
