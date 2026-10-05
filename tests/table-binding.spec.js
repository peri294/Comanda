import { test, expect } from '@playwright/test';
import { tableToken, joinTable, login, connect, connectStaff, fetchState, placeOrder, settle } from './helpers.js';

// Respuesta del server al join de una mesa: el estado de la mesa, o null si no entró
const joinWith = async (socket, tableId, token) => {
  const state = new Promise(resolve => socket.once('table-state', resolve));
  socket.emit('join', { role: `table-${tableId}`, token });
  return state;
};

// Las 12 mesas semilla y la 13 (tables.spec) ya tienen dueño entre los specs que corren
// en paralelo: estos tests crean las suyas con número puntual (30 en adelante: con 2x,
// 5x o 6x chocarían con locators por substring como hasText: 'Mesa 2').
// Las mesas nuevas nacen bloqueadas: se agregan y se habilitan.
const addTable = async (counter, id) => {
  counter.socket.emit('add-table', { id });
  counter.socket.emit('set-table-enabled', { tableId: id, enabled: true });
  await expect.poll(async () => (await fetchState(counter.token)).tables.find(t => t.id === id)?.enabled).toBe(true);
};

test('sin el token del QR no se entra a la mesa, y una mesa no puede actuar sobre otra', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
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
  const counter = await connectStaff('counter', 'mostrador123');
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
  const closed = new Promise(resolve => client.once('table-closed', resolve));
  counter.socket.emit('close-table', { tableId: '32' });
  await closed;
  expect(await tableToken('32')).toBe(oldToken);

  // Al cerrar la mesa, el server desconecta a sus celulares: ese socket ya no puede pedir
  // (si no, un celular olvidado seguiría actuando sobre la mesa del grupo siguiente)
  client.emit('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
  await settle();
  expect((await fetchState(counter.token)).tables.find(t => t.id === '32').status).toBe('libre');
  // Volver a escanear el QR (mismo token) lo deja entrar de nuevo
  expect((await joinWith(client, '32', oldToken)).id).toBe('32');

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

test('una mesa bloqueada siempre está vacía: con clientes, se bloquea recién al cerrarla', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '33');
  const tableOf = async () => (await fetchState(counter.token)).tables.find(t => t.id === '33');
  const assistanceCalls = [];
  counter.socket.on('assistance-requested', data => { if (data.tableId === '33') assistanceCalls.push(data); });

  const client = await connect();
  await joinTable(client, '33');
  const order1 = await placeOrder(client, 'm1');

  // Bloquear con clientes sentados: queda habilitada y marcada, y puede seguir pidiendo
  counter.socket.emit('set-table-enabled', { tableId: '33', enabled: false });
  await settle();
  let table = await tableOf();
  expect(table.enabled).toBe(true);
  expect(table.blockOnClose).toBe(true);
  const order2 = await placeOrder(client, 'm8');

  // Cancelar todo deja la mesa vacía: el bloqueo pendiente se aplica en ese momento.
  // (Se cancela en vez de cobrar para no sumar a la Caja del Día, que tables.spec
  // verifica con el monto exacto.)
  const blocked = new Promise(resolve => client.on('table-state', state => { if (state && !state.enabled) resolve(state); }));
  counter.socket.emit('cancel-order', { orderId: order1.id });
  counter.socket.emit('cancel-order', { orderId: order2.id });
  await blocked;
  table = await tableOf();
  expect(table.enabled).toBe(false);
  expect(table.blockOnClose).toBe(false);
  expect(table.status).toBe('libre');

  // Bloqueada: no acepta pedidos ni llamados al mozo
  client.emit('new-order', { items: [{ productId: 'm1', quantity: 1 }] });
  client.emit('request-assistance');
  await settle();
  expect((await tableOf()).status).toBe('libre');
  expect(assistanceCalls).toEqual([]);

  // Habilitarla de nuevo deja pedir
  const enabled = new Promise(resolve => client.on('table-state', state => { if (state?.enabled) resolve(state); }));
  counter.socket.emit('set-table-enabled', { tableId: '33', enabled: true });
  await enabled;
  await placeOrder(client, 'm1');

  // (El bloqueo al cobrar con close-table lo cubre day-cycle.spec, que corre después de
  // tables.spec y puede sumar a la caja.)

  client.close();
  counter.socket.close();
});
