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
  isVisitCode,
  closeOrders,
  sanitizeSettings,
  orderRateDecision,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_LINES,
  MAX_PRICE,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_TABLE_NUMBER,
  MAX_ORDERS_PER_WINDOW,
  ORDER_RATE_WINDOW_MS,
  parseReportRange,
  buildSalesReport,
  localDateKey,
  MAX_REPORT_DAYS,
  decodeImageUpload,
  newImageId,
  MAX_IMAGE_BYTES,
  MAX_BUSINESS_NAME_LENGTH,
  sanitizeItems,
  sanitizeNotes,
  sanitizeMenuFields,
  sanitizeCategoryFields,
  canDeleteCategory,
  reorderCategories,
  MAX_CATEGORY_NAME_LENGTH,
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
  const categories = [{ id: 'bebidas_calientes', name: 'Café Caliente' }, { id: 'cat-tortas', name: 'Tortas' }];

  test('normaliza un producto válido con icono por defecto', () => {
    assert.deepEqual(sanitizeMenuFields({ name: ' Latte ', price: '2500', category: 'bebidas_calientes' }, categories), {
      name: 'Latte', description: '', price: 2500, category: 'bebidas_calientes', image: 'coffee'
    });
  });

  test('acepta una categoría creada por el mostrador', () => {
    assert.equal(sanitizeMenuFields({ name: 'Lemon Pie', price: 3000, category: 'cat-tortas' }, categories).category, 'cat-tortas');
  });

  test('rechaza nombre vacío, precio no positivo o categoría que no existe', () => {
    const ok = { name: 'Latte', price: 2500, category: 'bebidas_calientes' };
    assert.equal(sanitizeMenuFields({ ...ok, name: '   ' }, categories), null);
    assert.equal(sanitizeMenuFields({ ...ok, price: 0 }, categories), null);
    assert.equal(sanitizeMenuFields({ ...ok, price: 'abc' }, categories), null);
    assert.equal(sanitizeMenuFields({ ...ok, category: 'bebidas_alcoholicas' }, categories), null);
    assert.equal(sanitizeMenuFields(ok), null);
    assert.equal(sanitizeMenuFields(), null);
  });
});

describe('categorías', () => {
  const categories = [
    { id: 'a', name: 'A', icon: '', position: 0 },
    { id: 'b', name: 'B', icon: '', position: 1 }
  ];

  test('sanitizeCategoryFields recorta nombre e icono y exige nombre', () => {
    assert.deepEqual(sanitizeCategoryFields({ name: '  Tortas ', icon: ' 🍰 ' }), { name: 'Tortas', icon: '🍰' });
    assert.deepEqual(sanitizeCategoryFields({ name: 'Tortas' }), { name: 'Tortas', icon: '' });
    assert.equal(sanitizeCategoryFields({ name: 'x'.repeat(100) }).name.length, MAX_CATEGORY_NAME_LENGTH);
    assert.equal(sanitizeCategoryFields({ name: '  ' }), null);
    assert.equal(sanitizeCategoryFields(), null);
  });

  test('una categoría con productos no se puede borrar', () => {
    const menu = [{ id: 'm1', category: 'a' }];
    assert.equal(canDeleteCategory('a', menu), false);
    assert.equal(canDeleteCategory('b', menu), true);
  });

  test('reorderCategories exige una permutación exacta', () => {
    assert.deepEqual(reorderCategories(['b', 'a'], categories).map(c => [c.id, c.position]), [['b', 0], ['a', 1]]);
    assert.equal(reorderCategories(['a'], categories), null);
    assert.equal(reorderCategories(['a', 'a'], categories), null);
    assert.equal(reorderCategories(['a', 'z'], categories), null);
    assert.equal(reorderCategories('a,b', categories), null);
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

describe('código de visita', () => {
  test('cada mesa nace con un código de 4 dígitos', () => {
    const t = createTable('7');
    assert.ok(isVisitCode(t.visitCode));
  });

  test('cobrar la mesa empieza una visita con otro código, y el QR se conserva', () => {
    // Con 10.000 códigos posibles, uno puede repetirse por azar: se prueba que se regenera
    // en varias visitas seguidas, no que nunca coincida con el anterior.
    let mesa = createTable('7');
    const codes = new Set([mesa.visitCode]);
    for (let i = 0; i < 20; i++) {
      const qrToken = mesa.qrToken;
      mesa = closedTable(mesa);
      assert.equal(mesa.qrToken, qrToken);
      assert.ok(isVisitCode(mesa.visitCode));
      codes.add(mesa.visitCode);
    }
    assert.ok(codes.size > 1);
  });

  test('isVisitCode exige exactamente 4 dígitos', () => {
    assert.equal(isVisitCode('0042'), true);
    assert.equal(isVisitCode('42'), false);
    assert.equal(isVisitCode(4242), false);
    assert.equal(isVisitCode('42a2'), false);
    assert.equal(isVisitCode(undefined), false);
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

describe('sanitizeSettings', () => {
  test('recorta el nombre y lo devuelve con la clave de la base', () => {
    assert.deepEqual(sanitizeSettings({ businessName: '  Café Central  ' }), { business_name: 'Café Central' });
  });

  test('corta el nombre en el máximo', () => {
    const { business_name } = sanitizeSettings({ businessName: 'x'.repeat(200) });
    assert.equal(business_name.length, MAX_BUSINESS_NAME_LENGTH);
  });

  test('el logo es un id de imagen, o null para sacarlo', () => {
    const id = newImageId();
    assert.deepEqual(sanitizeSettings({ logoImageId: id }), { logo_image_id: id });
    assert.deepEqual(sanitizeSettings({ logoImageId: null }), { logo_image_id: '' });
    assert.equal(sanitizeSettings({ logoImageId: '../etc/passwd' }), null);
  });

  test('sin campos válidos devuelve null', () => {
    assert.equal(sanitizeSettings({ businessName: '   ' }), null);
    assert.equal(sanitizeSettings({ businessName: 42 }), null);
    assert.equal(sanitizeSettings({}), null);
    assert.equal(sanitizeSettings(), null);
  });
});

describe('decodeImageUpload', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

  test('acepta una imagen cuyo contenido coincide con el tipo declarado', () => {
    const decoded = decodeImageUpload({ mime: 'image/png', data: png.toString('base64') });
    assert.equal(decoded.mime, 'image/png');
    assert.ok(decoded.data.equals(png));
    assert.equal(decodeImageUpload({ mime: 'image/jpeg', data: jpeg.toString('base64') }).mime, 'image/jpeg');
  });

  test('rechaza tipos no admitidos, contenido que no coincide y archivos grandes', () => {
    assert.deepEqual(decodeImageUpload({ mime: 'image/svg+xml', data: png.toString('base64') }), { error: 'unsupported_type' });
    assert.deepEqual(decodeImageUpload({ mime: 'image/jpeg', data: png.toString('base64') }), { error: 'invalid_image' });
    assert.deepEqual(decodeImageUpload({ mime: 'image/png', data: '' }), { error: 'invalid_image' });
    const big = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64');
    assert.deepEqual(decodeImageUpload({ mime: 'image/png', data: big }), { error: 'too_large' });
    assert.deepEqual(decodeImageUpload(), { error: 'unsupported_type' });
  });
});

describe('reportes de ventas', () => {
  test('parseReportRange incluye ambos extremos en días locales', () => {
    const range = parseReportRange('2026-10-01', '2026-10-03');
    assert.deepEqual(range.days, ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.equal(localDateKey(range.start), '2026-10-01');
    assert.equal(localDateKey(range.end), '2026-10-04');
    assert.deepEqual(parseReportRange('2026-10-05', '2026-10-05').days, ['2026-10-05']);
  });

  test('parseReportRange rechaza fechas inválidas, invertidas o un rango demasiado largo', () => {
    assert.equal(parseReportRange('2026-02-31', '2026-03-01'), null);
    assert.equal(parseReportRange('2026-10-03', '2026-10-01'), null);
    assert.equal(parseReportRange('ayer', '2026-10-01'), null);
    assert.equal(parseReportRange(undefined, undefined), null);
    assert.equal(parseReportRange('2024-01-01', '2026-01-01'), null);
    assert.equal(parseReportRange('2025-01-01', '2025-12-31').days.length, 365);
    assert.ok(MAX_REPORT_DAYS >= 366);
  });

  test('buildSalesReport suma por día, por producto y por visita', () => {
    const day1 = new Date(2026, 9, 1, 12).toISOString();
    const day1Later = new Date(2026, 9, 1, 20).toISOString();
    const day2 = new Date(2026, 9, 2, 10).toISOString();
    const espresso = (quantity) => ({ productId: 'm1', name: 'Espresso', price: 1800, quantity });
    const medialuna = (quantity) => ({ productId: 'm8', name: 'Medialuna', price: 800, quantity });
    const report = buildSalesReport({
      days: ['2026-10-01', '2026-10-02', '2026-10-03'],
      // Mesa 1: una visita con dos pedidos (mismo closedAt). Mesa 2: dos visitas.
      paidOrders: [
        { tableId: '1', closedAt: day1, items: [espresso(1)] },
        { tableId: '1', closedAt: day1, items: [medialuna(2)] },
        { tableId: '2', closedAt: day1Later, items: [espresso(2)] },
        { tableId: '2', closedAt: day2, items: [medialuna(1), espresso(1)] }
      ],
      cancelledCount: 3,
      closures: [{ closedAt: day2, total: 1, ordersCount: 1 }]
    });

    assert.equal(report.total, 1800 + 1600 + 3600 + 2600);
    assert.equal(report.ordersCount, 4);
    assert.equal(report.visitsCount, 3);
    assert.equal(report.averageTicket, Math.round(9600 / 3));
    assert.equal(report.cancelledCount, 3);
    assert.deepEqual(report.byDay, [
      { date: '2026-10-01', total: 7000, orders: 3 },
      { date: '2026-10-02', total: 2600, orders: 1 },
      { date: '2026-10-03', total: 0, orders: 0 }
    ]);
    assert.deepEqual(report.topProducts.map(p => [p.name, p.quantity, p.total]), [
      ['Espresso', 4, 7200],
      ['Medialuna', 3, 2400]
    ]);
    assert.equal(report.closures.length, 1);
  });

  test('buildSalesReport sin ventas', () => {
    const report = buildSalesReport({ days: ['2026-10-01'], paidOrders: [] });
    assert.equal(report.total, 0);
    assert.equal(report.averageTicket, 0);
    assert.deepEqual(report.topProducts, []);
  });
});

describe('topes de pedidos y menú', () => {
  const menu = [{ id: 'm1', name: 'Espresso', price: 1800, available: true }];
  const categories = [{ id: 'cafe', name: 'Café' }];

  test('sanitizeItems descarta cantidades por encima del tope (1e308 daba un total Infinity)', () => {
    assert.deepEqual(sanitizeItems([{ productId: 'm1', quantity: 1e308 }], menu), []);
    assert.deepEqual(sanitizeItems([{ productId: 'm1', quantity: MAX_ITEM_QUANTITY + 1 }], menu), []);
    assert.equal(sanitizeItems([{ productId: 'm1', quantity: MAX_ITEM_QUANTITY }], menu)[0].quantity, MAX_ITEM_QUANTITY);
  });

  test('sanitizeItems rechaza un pedido con demasiadas líneas', () => {
    const lines = (n) => Array.from({ length: n }, () => ({ productId: 'm1', quantity: 1 }));
    assert.equal(sanitizeItems(lines(MAX_ORDER_LINES), menu).length, MAX_ORDER_LINES);
    assert.deepEqual(sanitizeItems(lines(MAX_ORDER_LINES + 1), menu), []);
  });

  test('sanitizeMenuFields: precio máximo y textos recortados', () => {
    assert.equal(sanitizeMenuFields({ name: 'X', price: MAX_PRICE + 1, category: 'cafe' }, categories), null);
    const long = sanitizeMenuFields({ name: 'n'.repeat(500), description: 'd'.repeat(5000), price: 100, category: 'cafe' }, categories);
    assert.equal(long.name.length, MAX_PRODUCT_NAME_LENGTH);
    assert.equal(long.description.length, 300);
  });

  test('resolveNewTableId no pasa del número máximo de mesa', () => {
    assert.equal(resolveNewTableId([], String(MAX_TABLE_NUMBER)), String(MAX_TABLE_NUMBER));
    assert.equal(resolveNewTableId([], String(MAX_TABLE_NUMBER + 1)), null);
    assert.equal(resolveNewTableId([], '1e20'), null);
  });

  test('orderRateDecision frena el pedido número 11 de la ventana y vuelve a aceptar al vencer', () => {
    const now = 1_000_000;
    let recent = [];
    for (let i = 0; i < MAX_ORDERS_PER_WINDOW; i++) {
      const decision = orderRateDecision(recent, now + i);
      assert.equal(decision.allowed, true);
      recent = decision.recent;
    }
    const blocked = orderRateDecision(recent, now + 100);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryInMs, ORDER_RATE_WINDOW_MS - 100);
    assert.equal(orderRateDecision(recent, now + ORDER_RATE_WINDOW_MS).allowed, true);
  });
});
