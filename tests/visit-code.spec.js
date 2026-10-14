import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';
import { BACKEND, connect, connectStaff, addTable, tableLink, joinTable, settle } from './helpers.js';

// Corre último, en su propio proyecto de Playwright (ver playwright.config.js): la prueba
// de fuerza bruta bloquea la IP local para una mesa, y conviene que nada corra después.
// /api/test/reset limpia el bloqueo.
test.describe.configure({ mode: 'serial' });

// Join a la mesa y la primera respuesta del server: table-state (entró o no existe),
// visit-code-required o visit-code-error.
const joinAndWait = (socket, tableId, token, code) => new Promise(resolve => {
  const events = ['table-state', 'visit-code-required', 'visit-code-error'];
  const handlers = events.map(event => {
    const handler = (data) => {
      events.forEach((e, i) => socket.off(e, handlers[i]));
      resolve({ event, data });
    };
    socket.on(event, handler);
    return handler;
  });
  socket.emit('join', { role: `table-${tableId}`, token, code });
});

test('sin el código de la visita no se ve ni se pide nada, y el código cambia al cobrar', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '43');
  const { qrToken, visitCode: code } = await tableLink('43');

  // 1. QR válido sin código: el server pide el código y no deja pedir
  const outsider = await connect();
  expect((await joinAndWait(outsider, '43', qrToken)).event).toBe('visit-code-required');
  const spied = [];
  outsider.on('order-status-changed', order => spied.push(order));
  expect(await outsider.emitWithAck('new-order', { items: [{ productId: 'm1', quantity: 1 }] }))
    .toEqual({ ok: false, error: 'table_unavailable' });

  // 2. Con el código entra, y quien no lo tiene no ve los pedidos de la mesa
  const guest = await connect();
  const joined = await joinAndWait(guest, '43', qrToken, code);
  expect(joined.event).toBe('table-state');
  expect(joined.data.id).toBe('43');
  expect((await guest.emitWithAck('new-order', { items: [{ productId: 'm1', quantity: 1 }] })).ok).toBe(true);
  await settle();
  expect(spied).toEqual([]);

  // 3. Un código equivocado se rechaza
  expect(await joinAndWait(outsider, '43', qrToken, code === '0000' ? '1111' : '0000'))
    .toEqual({ event: 'visit-code-error', data: {} });

  // 4. Al cobrar empieza otra visita con otro código: el viejo ya no entra
  const closed = new Promise(resolve => guest.once('table-closed', resolve));
  counter.socket.emit('close-table', { tableId: '43' });
  await closed;
  const { visitCode: nextCode } = await tableLink('43');
  // Un celular que se quedó con el código viejo no está adivinando: se le avisa que cambió
  if (nextCode !== code) {
    expect(await joinAndWait(guest, '43', qrToken, code))
      .toEqual({ event: 'visit-code-required', data: { tableId: '43', changed: true } });
  }
  expect((await joinAndWait(guest, '43', qrToken, nextCode)).event).toBe('table-state');

  // 5. El mostrador cambia el código a mano: los celulares conectados lo tienen que reingresar
  const required = new Promise(resolve => guest.once('visit-code-required', resolve));
  counter.socket.emit('regenerate-visit-code', { tableId: '43' });
  expect(await required).toMatchObject({ tableId: '43', changed: true });
  expect(await guest.emitWithAck('new-order', { items: [{ productId: 'm1', quantity: 1 }] }))
    .toEqual({ ok: false, error: 'table_unavailable' });
  const regenerated = await tableLink('43');
  expect(regenerated.qrToken).toBe(qrToken);
  await joinTable(guest, '43');

  [outsider, guest, counter.socket].forEach(s => s.close());
});

test('el cliente ingresa el código en pantalla y queda guardado al recargar', async ({ page }) => {
  const { qrToken, visitCode: code } = await tableLink('43');
  // El link del QR impreso: sin el código
  await page.goto(`/?view=client&table=43&t=${qrToken}`);
  const input = page.getByLabel('Código de la mesa');
  await expect(input).toBeVisible({ timeout: 20000 });

  await input.fill(code === '0000' ? '1111' : '0000');
  await page.getByRole('button', { name: /entrar a la mesa/i }).click();
  await expect(page.getByRole('alert')).toContainText('no es el de la mesa', { timeout: 10000 });

  await input.fill(code);
  await page.getByRole('button', { name: /entrar a la mesa/i }).click();
  await expect(page.getByText('Nuestro Menú')).toBeVisible({ timeout: 10000 });

  // Recargar no lo vuelve a pedir
  await page.reload();
  await expect(page.getByText('Nuestro Menú')).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Código de la mesa')).toHaveCount(0);
});

test('probar códigos se frena a los 10 intentos fallidos, por IP y por mesa', async () => {
  // Mesa propia: los intentos fallidos de los otros tests de este archivo son de la 43
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '44');
  const { qrToken, visitCode: code } = await tableLink('44');
  const wrong = code === '0000' ? '1111' : '0000';
  // Siempre por 127.0.0.1: "localhost" puede alternar entre ::1 y 127.0.0.1, que para el
  // freno son dos IP distintas.
  const attacker = io(BACKEND.replace('localhost', '127.0.0.1'), { transports: ['websocket'] });
  await new Promise(resolve => attacker.on('connect', resolve));

  for (let i = 0; i < 9; i++) {
    expect(await joinAndWait(attacker, '44', qrToken, wrong)).toEqual({ event: 'visit-code-error', data: {} });
  }
  // El décimo fallo ya informa la espera, y desde ahí ni el código correcto entra
  const tenth = await joinAndWait(attacker, '44', qrToken, wrong);
  expect(tenth.event).toBe('visit-code-error');
  expect(tenth.data.retryAfterMs).toBeGreaterThan(0);
  const blocked = await joinAndWait(attacker, '44', qrToken, code);
  expect(blocked.event).toBe('visit-code-error');
  expect(blocked.data.retryAfterMs).toBeGreaterThan(0);

  // El bloqueo es de esa mesa: desde la misma IP, la 43 sigue entrando con su código
  const other = await tableLink('43');
  expect((await joinAndWait(attacker, '43', other.qrToken, other.visitCode)).event).toBe('table-state');

  attacker.close();
  counter.socket.close();
});
