// Unit tests de las reglas de negocio (domain.js). Corren sin server ni base:
// `npm test` en backend/ (node:test, incluido en Node, sin dependencias).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTable,
  resolveNewTableId,
  syncTableStatus,
  recomputeTable,
  applyEnabled,
  closedTable,
  closeOrders,
  sanitizeItems,
  sanitizeNotes,
  sanitizeMenuFields,
  registerNewOrder,
  canAdvanceKitchenStatus,
  canCorrectOrder,
  requestBill,
  assistanceDecision,
  ASSISTANCE_REOPEN_COOLDOWN_MS,
  MAX_NOTES_LENGTH
} from './domain.js';

const MENU = [
  { id: 'm1', name: 'Espresso', price: 1800, category: 'bebidas_calientes', available: true },
  { id: 'm2', name: 'Medialuna', price: 800, category: 'pasteleria', available: false }
];

const table = (overrides = {}) => ({ ...createTable('1'), enabled: true, ...overrides });
const order = (id, status = 'pendiente', items = [{ productId: 'm1', name: 'Espresso', price: 1800, quantity: 1 }]) =>
  ({ id, tableId: '1', items, status, archived: false });

describe('sanitizeItems', () => {
  test('toma nombre y precio del menú, no del cliente', () => {
    assert.deepEqual(sanitizeItems([{ productId: 'm1', quantity: 2, price: 1, name: 'Gratis' }], MENU), [
      { productId: 'm1', name: 'Espresso', price: 1800, quantity: 2 }
    ]);
  });

  test('descarta inexistentes, agotados y cantidades inválidas; trunca decimales', () => {
    const items = sanitizeItems([
      { productId: 'nope', quantity: 1 },
      { productId: 'm2', quantity: 1 },
      { productId: 'm1', quantity: 0 },
      { productId: 'm1', quantity: -3 },
      { productId: 'm1', quantity: 'abc' },
      null,
      { productId: 'm1', quantity: 1.7 }
    ], MENU);
    assert.deepEqual(items, [{ productId: 'm1', name: 'Espresso', price: 1800, quantity: 1 }]);
  });

  test('no array -> vacío', () => {
    assert.deepEqual(sanitizeItems(undefined, MENU), []);
    assert.deepEqual(sanitizeItems({ productId: 'm1' }, MENU), []);
  });

  test('en una edición conserva el snapshot de items ya pedidos aunque estén agotados o borrados', () => {
    const previous = [
      { productId: 'm2', name: 'Medialuna', price: 700, quantity: 1 },
      { productId: 'borrado', name: 'Tostado', price: 3000, quantity: 1 }
    ];
    const items = sanitizeItems([
      { productId: 'm2', quantity: 3 },
      { productId: 'borrado', quantity: 1 }
    ], MENU, previous);
    assert.deepEqual(items, [
      { productId: 'm2', name: 'Medialuna', price: 700, quantity: 3 },
      { productId: 'borrado', name: 'Tostado', price: 3000, quantity: 1 }
    ]);
  });
});

describe('sanitizeNotes', () => {
  test('solo strings, recortados y acotados', () => {
    assert.equal(sanitizeNotes({ x: 1 }), '');
    assert.equal(sanitizeNotes(undefined), '');
    assert.equal(sanitizeNotes('  sin azúcar  '), 'sin azúcar');
    assert.equal(sanitizeNotes('a'.repeat(5000)).length, MAX_NOTES_LENGTH);
  });
});

describe('sanitizeMenuFields', () => {
  test('normaliza un producto válido con icono por defecto', () => {
    assert.deepEqual(sanitizeMenuFields({ name: ' Latte ', price: '2500', category: 'bebidas_calientes' }), {
      name: 'Latte', description: '', price: 2500, category: 'bebidas_calientes', image: 'coffee'
    });
  });

  test('rechaza nombre vacío, precio no positivo o categoría desconocida', () => {
    const ok = { name: 'Latte', price: 2500, category: 'bebidas_calientes' };
    assert.equal(sanitizeMenuFields({ ...ok, name: '   ' }), null);
    assert.equal(sanitizeMenuFields({ ...ok, price: 0 }), null);
    assert.equal(sanitizeMenuFields({ ...ok, price: 'abc' }), null);
    assert.equal(sanitizeMenuFields({ ...ok, category: 'bebidas_alcoholicas' }), null);
    assert.equal(sanitizeMenuFields(), null);
  });
});

describe('estado de la mesa', () => {
  test('pasa a comiendo recién con todos los pedidos entregados', () => {
    const t = table({ status: 'pedido_pendiente' });
    syncTableStatus(t, [order('a', 'entregado'), order('b', 'listo')]);
    assert.equal(t.status, 'pedido_pendiente');
    syncTableStatus(t, [order('a', 'entregado'), order('b', 'entregado')]);
    assert.equal(t.status, 'comiendo');
  });

  test('con la cuenta pedida no se toca', () => {
    const t = table({ status: 'esperando_cuenta' });
    syncTableStatus(t, [order('a', 'pendiente')]);
    assert.equal(t.status, 'esperando_cuenta');
  });

  test('un pedido nuevo suma al total y cancela la cuenta pedida', () => {
    const t = table({ status: 'pagando_tarjeta', paymentMethod: 'tarjeta', total: 1800 });
    assert.equal(registerNewOrder(t, order('b')), true);
    assert.equal(t.status, 'pedido_pendiente');
    assert.equal(t.paymentMethod, null);
    assert.equal(t.currentOrderId, 'b');
    assert.equal(t.total, 3600);
    assert.equal(registerNewOrder(t, order('c')), false);
  });

  test('la cuenta solo se pide con un método válido y la mesa en comiendo', () => {
    const libre = table();
    assert.equal(requestBill(libre, 'efectivo'), false);
    const comiendo = table({ status: 'comiendo' });
    assert.equal(requestBill(comiendo, 'bitcoin'), false);
    assert.equal(comiendo.paymentMethod, null);
    assert.equal(requestBill(comiendo, 'efectivo'), true);
    assert.equal(comiendo.status, 'esperando_cuenta');
    const tarjeta = table({ status: 'comiendo' });
    requestBill(tarjeta, 'tarjeta');
    assert.equal(tarjeta.status, 'pagando_tarjeta');
  });
});

describe('recomputeTable', () => {
  test('cancelar el único pedido libera la mesa y aplica el bloqueo pendiente', () => {
    const t = table({ status: 'pedido_pendiente', currentOrderId: 'a', total: 1800, blockOnClose: true });
    recomputeTable(t, []);
    assert.equal(t.status, 'libre');
    assert.equal(t.total, 0);
    assert.equal(t.currentOrderId, null);
    assert.equal(t.enabled, false);
    assert.equal(t.blockOnClose, false);
  });

  test('si se cancela el pedido actual apunta al más reciente que queda', () => {
    const t = table({ status: 'pedido_pendiente', currentOrderId: 'c' });
    recomputeTable(t, [order('a', 'entregado'), order('b', 'entregado')]);
    assert.equal(t.currentOrderId, 'b');
    assert.equal(t.total, 3600);
    // Queda todo entregado: la mesa pasa a comiendo
    assert.equal(t.status, 'comiendo');
  });
});

describe('habilitación de mesas', () => {
  test('una mesa vacía se bloquea en el acto; una ocupada, al cobrarla', () => {
    const vacia = table();
    assert.equal(applyEnabled(vacia, false, []), true);
    assert.equal(vacia.enabled, false);

    const ocupada = table({ status: 'pedido_pendiente' });
    assert.equal(applyEnabled(ocupada, false, [order('a')]), true);
    assert.equal(ocupada.enabled, true);
    assert.equal(ocupada.blockOnClose, true);

    const cobrada = closedTable(ocupada);
    assert.equal(cobrada.enabled, false);
    assert.equal(cobrada.blockOnClose, false);
    assert.equal(cobrada.qrToken, ocupada.qrToken);
  });

  test('habilitar cancela el bloqueo pendiente; sin cambios devuelve false', () => {
    const t = table({ status: 'comiendo', blockOnClose: true });
    assert.equal(applyEnabled(t, true, [order('a', 'entregado')]), true);
    assert.equal(t.blockOnClose, false);
    assert.equal(applyEnabled(t, true, [order('a', 'entregado')]), false);
  });

  test('cobrar una mesa sin bloqueo pendiente la deja habilitada y vacía', () => {
    const cobrada = closedTable(table({ status: 'comiendo', total: 5000, paymentMethod: 'efectivo' }));
    assert.equal(cobrada.enabled, true);
    assert.equal(cobrada.status, 'libre');
    assert.equal(cobrada.total, 0);
    assert.equal(cobrada.paymentMethod, null);
  });
});

describe('closeOrders', () => {
  test('cierra solo los pedidos activos de la mesa', () => {
    const anterior = { ...order('viejo', 'entregado'), archived: true, closedAt: '2026-10-08T20:00:00.000Z' };
    const cancelado = { ...order('cancelado', 'cancelado'), archived: true };
    const otraMesa = { ...order('otra'), tableId: '2' };
    const actual = order('actual', 'listo');
    const orders = [anterior, cancelado, otraMesa, actual];

    const closed = closeOrders(orders, '1', '2026-10-09T20:00:00.000Z');

    assert.deepEqual(closed.map(o => o.id), ['actual']);
    assert.equal(actual.status, 'entregado');
    assert.equal(actual.archived, true);
    // Regresión: el pedido de una visita ya cobrada conserva su sello (antes se pisaba y
    // volvía a contar en la caja siguiente), el cancelado sigue cancelado y la otra mesa
    // no se toca.
    assert.equal(anterior.closedAt, '2026-10-08T20:00:00.000Z');
    assert.equal(cancelado.status, 'cancelado');
    assert.equal(otraMesa.archived, false);
  });
});

describe('pedidos en cocina y mostrador', () => {
  test('cocina solo avanza por su flujo y nunca retrocede', () => {
    assert.equal(canAdvanceKitchenStatus(order('a', 'pendiente'), 'listo'), true);
    assert.equal(canAdvanceKitchenStatus(order('a', 'listo'), 'en_preparacion'), false);
    assert.equal(canAdvanceKitchenStatus(order('a', 'pendiente'), 'hackeado'), false);
    assert.equal(canAdvanceKitchenStatus(order('a', 'pendiente'), 'cancelado'), false);
    assert.equal(canAdvanceKitchenStatus({ ...order('a', 'cancelado'), archived: true }, 'listo'), false);
  });

  test('el mostrador corrige solo pedidos pendientes y activos', () => {
    assert.equal(canCorrectOrder(order('a', 'pendiente')), true);
    assert.equal(canCorrectOrder(order('a', 'en_preparacion')), false);
    assert.equal(canCorrectOrder({ ...order('a'), archived: true }), false);
  });
});

describe('assistanceDecision', () => {
  const now = 1_000_000;
  test('sin llamado previo, o con el cooldown vencido, se crea uno', () => {
    assert.deepEqual(assistanceDecision(undefined, now), { action: 'create' });
    const resolved = { resolved: true, resolvedAt: now - ASSISTANCE_REOPEN_COOLDOWN_MS };
    assert.deepEqual(assistanceDecision(resolved, now), { action: 'create' });
  });

  test('un llamado sin atender no se duplica, sin importar el tiempo', () => {
    assert.deepEqual(assistanceDecision({ timestamp: 0, resolved: false }, now), { action: 'pending' });
  });

  test('dentro del cooldown informa cuánto falta', () => {
    assert.deepEqual(assistanceDecision({ resolved: true, resolvedAt: now - 4000 }, now),
      { action: 'cooldown', retryInMs: ASSISTANCE_REOPEN_COOLDOWN_MS - 4000 });
  });
});

describe('resolveNewTableId', () => {
  test('sin número, el más chico libre', () => {
    assert.equal(resolveNewTableId(['1', '2', '4'], undefined), '3');
    assert.equal(resolveNewTableId([], ''), '1');
  });

  test('con número: entero positivo, normalizado y sin usar', () => {
    assert.equal(resolveNewTableId(['1'], ' 007 '), '7');
    assert.equal(resolveNewTableId(['1'], '1'), null);
    assert.equal(resolveNewTableId(['1'], 0), null);
    assert.equal(resolveNewTableId(['1'], '2.5'), null);
    assert.equal(resolveNewTableId(['1'], 'abc'), null);
  });
});
