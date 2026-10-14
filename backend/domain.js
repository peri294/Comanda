// Reglas de negocio de la cafetería, sin estado global ni dependencias de transporte
// (sockets, HTTP) ni de persistencia (SQLite). Todo lo que necesitan llega por
// argumento —la mesa, sus pedidos activos, el menú—, así se pueden probar con unit
// tests sin levantar el server (ver domain.test.js). server.js busca el estado, llama
// acá, persiste y avisa por sockets.
//
// Las funciones que actualizan una mesa la modifican en el lugar (como hacía server.js
// antes de separar este módulo): la mesa es el mismo objeto que después se persiste y
// se emite, y copiarla obligaría a reemplazarla en el array de mesas en cada evento.
import crypto from 'node:crypto';

// Topes de las categorías del menú, que el Mostrador administra (ver la tabla categories).
export const MAX_CATEGORY_NAME_LENGTH = 40;
// Un emoji puede ocupar varias unidades UTF-16 (banderas, modificadores de tono).
export const MAX_CATEGORY_ICON_LENGTH = 8;

// Recorrido de un pedido en cocina, en orden. 'cancelado' no está: lo pone solo el Mostrador.
export const KITCHEN_FLOW = ['pendiente', 'en_preparacion', 'listo', 'entregado'];

export const PAYMENT_METHODS = ['efectivo', 'tarjeta'];

export const MAX_NOTES_LENGTH = 300;

// Tras atender un llamado al mozo, cuánto hay que esperar para poder volver a llamar.
export const ASSISTANCE_REOPEN_COOLDOWN_MS = 10_000;

// --- MESAS ---

// Token secreto del QR de cada mesa: el QR apunta a ?table=X&t=<token>, y sin el token
// el server no deja unirse a la mesa ni pedir, pedir la cuenta o llamar al mozo a su
// nombre. 12 bytes aleatorios (16 caracteres en base64url): imposible de adivinar y
// corto para que el QR no quede denso.
export const newQrToken = () => crypto.randomBytes(12).toString('base64url');

// Código de visita: 4 dígitos que el mozo le da a la mesa y cada celular ingresa una vez.
// El QR es fijo y cualquiera puede haberse guardado su link; el código cambia en cada
// visita (al cobrar), así que un link viejo sin el código vigente no ve ni pide nada.
// Pocos dígitos a propósito, para dictarlo; la fuerza bruta la frena server.js por IP.
export const newVisitCode = () => String(crypto.randomInt(0, 10_000)).padStart(4, '0');
export const isVisitCode = (code) => typeof code === 'string' && /^\d{4}$/.test(code);

export const createTable = (id) => ({
  id,
  status: 'libre', // 'libre' | 'pedido_pendiente' | 'comiendo' | 'esperando_cuenta' | 'pagando_tarjeta'
  currentOrderId: null,
  paymentMethod: null,
  total: 0,
  qrToken: newQrToken(),
  visitCode: newVisitCode(),
  // Toda mesa nace bloqueada: recibe pedidos recién cuando el Mostrador la habilita
  // (al iniciar el día o una por una). Fuera del horario, un link filtrado no sirve.
  enabled: false,
  // Bloqueo pedido con clientes sentados: se aplica al cobrar la mesa (ver applyEnabled).
  blockOnClose: false
});

// Número de la mesa a agregar. Con número pedido: entero positivo, normalizado (sin
// ceros a la izquierda) y sin usar; si no cumple, null. Sin número, el más chico libre.
export const resolveNewTableId = (existingIds, requested) => {
  const taken = new Set(existingIds);
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const n = Number(String(requested).trim());
    if (!Number.isInteger(n) || n < 1 || taken.has(String(n))) return null;
    return String(n);
  }
  let n = 1;
  while (taken.has(String(n))) n++;
  return String(n);
};

export const isBillRequested = (table) => table.status === 'esperando_cuenta' || table.status === 'pagando_tarjeta';

export const isTableEmpty = (table, activeOrders) => table.status === 'libre' && activeOrders.length === 0;

// Deriva el estado de la mesa de TODOS sus pedidos activos, no del último evento:
// antes, entregar el pedido 1 pasaba la mesa a "comiendo" aunque el pedido 2 siguiera
// en cocina, y pisaba un pedido de cuenta hecho mientras el mozo llevaba la comida.
// Con la cuenta pedida no se toca (solo la cancela un pedido nuevo, ver registerNewOrder);
// sin pedidos activos tampoco (eso lo resuelve recomputeTable liberando la mesa).
export const syncTableStatus = (table, activeOrders) => {
  if (isBillRequested(table) || activeOrders.length === 0) return;
  table.status = activeOrders.every(o => o.status === 'entregado') ? 'comiendo' : 'pedido_pendiente';
};

// Recalcula total, pedido actual y estado de la mesa a partir de sus pedidos activos
// (no archivados). Se usa después de que el Mostrador edita o cancela un pedido.
export const recomputeTable = (table, activeOrders) => {
  table.total = activeOrders.reduce((acc, o) => acc + itemsTotal(o.items), 0);

  // Si se cancela el único pedido pendiente, la mesa no puede quedar mostrando
  // "pedido pendiente"/"comiendo" fantasma con $0 y ningún pedido real detrás.
  if (activeOrders.length === 0 && (table.status === 'pedido_pendiente' || table.status === 'comiendo')) {
    table.status = 'libre';
    table.currentOrderId = null;
    table.paymentMethod = null;
    // Si la mesa tenía el bloqueo pendiente (se cerró el día o el mostrador la bloqueó
    // con clientes), se aplica ahora: quedó vacía y no hay nada que cobrar para que
    // close-table lo haga.
    if (table.blockOnClose) {
      table.enabled = false;
      table.blockOnClose = false;
    }
  } else if (table.currentOrderId && !activeOrders.find(o => o.id === table.currentOrderId)) {
    // El pedido "actual" de la mesa se canceló, pero quedan otros: apuntar al más reciente.
    table.currentOrderId = activeOrders[activeOrders.length - 1].id;
  }
  // Si el mostrador canceló el único pedido sin entregar, la mesa pasa a "comiendo".
  syncTableStatus(table, activeOrders);
};

// Una mesa bloqueada siempre está vacía: si no, el próximo que escaneara el QR al
// habilitarla vería la cuenta de los clientes anteriores. Por eso bloquear una mesa
// con clientes no la bloquea en el acto: la marca (blockOnClose) y se bloquea cuando
// se cobra. Habilitar una mesa marcada cancela el bloqueo pendiente.
// Devuelve si la mesa cambió.
export const applyEnabled = (table, enabled, activeOrders) => {
  let next;
  if (enabled) next = { enabled: true, blockOnClose: false };
  else if (isTableEmpty(table, activeOrders)) next = { enabled: false, blockOnClose: false };
  else next = { enabled: table.enabled, blockOnClose: true };

  if (next.enabled === table.enabled && next.blockOnClose === table.blockOnClose) return false;
  Object.assign(table, next);
  return true;
};

// Estado de la mesa tras cobrarla. El token se conserva: el QR impreso en la mesa tiene
// que seguir sirviendo para los próximos clientes. Si el Mostrador pidió bloquearla
// mientras tenía clientes (o se cerró el día), se bloquea ahora.
export const closedTable = (previous) => ({
  id: previous.id,
  status: 'libre',
  currentOrderId: null,
  paymentMethod: null,
  total: 0,
  qrToken: previous.qrToken,
  // Visita nueva, código nuevo: quien se quedó con el de la visita anterior pierde el acceso.
  visitCode: newVisitCode(),
  enabled: previous.enabled && !previous.blockOnClose,
  blockOnClose: false
});

// --- PEDIDOS ---

export const itemsTotal = (items) => items.reduce((sum, item) => sum + item.price * item.quantity, 0);

// Nunca confiar en precio/nombre que manda el cliente: siempre se recalculan contra
// el menú del servidor, así nadie puede pedir gratis (o más caro) manipulando el payload.
// También descarta productos inexistentes, agotados (available = false: la UI ya no
// deja pedirlos, pero un payload manual podría intentarlo igual) y cantidades inválidas.
//
// previousItems es para edit-order: "agotado" significa *no pedir más*, no *borrar lo
// ya pedido*. Los items que ya estaban en el pedido se conservan con su snapshot
// (nombre/precio al momento de pedirlos), aunque el producto se haya agotado o borrado
// del menú después — si no, editar un pedido con un producto discontinuado lo haría
// desaparecer en silencio (y con un solo item, cancelaría el pedido entero). Solo los
// items nuevos se validan estrictamente contra el menú vigente y su disponibilidad.
export const sanitizeItems = (rawItems, menu, previousItems = []) => {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.reduce((acc, item) => {
    const quantity = Math.floor(Number(item?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) return acc;

    const existing = previousItems.find(i => i.productId === item?.productId);
    const menuItem = menu.find(m => m.id === item?.productId);
    if (existing) {
      acc.push({ productId: existing.productId, name: existing.name, price: existing.price, quantity });
    } else if (menuItem?.available) {
      acc.push({ productId: menuItem.id, name: menuItem.name, price: menuItem.price, quantity });
    }
    return acc;
  }, []);
};

// Notas del cliente para cocina: siempre un string acotado. Antes se guardaba lo que
// llegara, y un objeto en notes tiraba abajo el render de Cocina y Mostrador (React no
// renderiza objetos), incluso tras recargar, porque el pedido quedaba persistido.
export const sanitizeNotes = (notes) => (typeof notes === 'string' ? notes.trim().slice(0, MAX_NOTES_LENGTH) : '');

// Suma un pedido nuevo a la mesa. Si la mesa ya había pedido la cuenta, pedir algo más
// la cancela: el consumo sigue sumando y la cuenta se vuelve a pedir cuando terminen
// (con su método de pago). Devuelve si se canceló la cuenta, para avisar al Mostrador.
export const registerNewOrder = (table, order) => {
  const billCancelled = isBillRequested(table);
  table.status = 'pedido_pendiente';
  table.currentOrderId = order.id;
  table.total += itemsTotal(order.items);
  // El método de pago se elige recién al pedir la cuenta (request-bill, que lo valida).
  if (billCancelled) table.paymentMethod = null;
  return billCancelled;
};

// Cocina solo puede mover un pedido por estados reales de su flujo y hacia adelante
// (puede saltear pasos, nunca retroceder): antes se guardaba cualquier string, y un
// pedido ya cobrado o cancelado podía "resucitar" en la pantalla de cocina.
export const canAdvanceKitchenStatus = (order, status) => {
  if (order.archived) return false;
  const from = KITCHEN_FLOW.indexOf(order.status);
  const to = KITCHEN_FLOW.indexOf(status);
  return from !== -1 && to > from;
};

// El Mostrador corrige o cancela un pedido solo mientras cocina no lo empezó a
// preparar, para no confundir al cocinero.
export const canCorrectOrder = (order) => !order.archived && order.status === 'pendiente';

// Cobro de la mesa: marca sus pedidos activos como entregados y archivados, sellando
// el momento del cobro (closedAt) para la "Caja del Día", y los devuelve para persistir.
// Solo los activos: los cancelados ya están archivados (nunca se cobraron, no pueden
// "resucitar" a entregado ni contar como venta), y los de visitas anteriores también.
// Antes se recorrían todos los pedidos de la mesa en memoria y los de visitas ya
// cobradas se volvían a sellar: si entre las dos visitas hubo un cierre de caja, se
// contaban de nuevo en la caja siguiente.
export const closeOrders = (orders, tableId, closedAt) => {
  const closed = orders.filter(o => o.tableId === tableId && !o.archived);
  closed.forEach(o => {
    o.status = 'entregado';
    o.archived = true;
    o.closedAt = closedAt;
  });
  return closed;
};

// Cocina no necesita ver pedidos ya entregados ni cancelados por el mostrador.
export const isKitchenVisible = (o) => o.status !== 'entregado' && o.status !== 'cancelado';

// --- CUENTA ---

// Mismas reglas que la UI del cliente (el botón solo aparece en "comiendo"): método de
// pago conocido y la mesa con todo entregado. Antes cualquier valor que no fuera
// 'efectivo' se tomaba como tarjeta, y una mesa libre en $0 podía "pedir la cuenta".
// Devuelve si se pidió.
export const requestBill = (table, paymentMethod) => {
  if (!PAYMENT_METHODS.includes(paymentMethod) || table.status !== 'comiendo') return false;
  table.status = paymentMethod === 'efectivo' ? 'esperando_cuenta' : 'pagando_tarjeta';
  table.paymentMethod = paymentMethod;
  return true;
};

// --- LLAMADOS AL MOZO ---

// Qué hacer con un "Llamar al Mozo" dado el llamado anterior de la mesa
// ({ timestamp, resolved, resolvedAt } o undefined):
// - 'pending': ya hay uno sin atender (sin importar el tiempo que pasó). No se duplica
//   la alerta, pero para el cliente sigue valiendo "mozo en camino".
// - 'cooldown': se atendió hace menos de ASSISTANCE_REOPEN_COOLDOWN_MS (medido desde
//   que se resolvió, no desde el llamado original). Evita un doble-click apenas se
//   habilita el botón sin bloquear un segundo pedido de ayuda legítimo. retryInMs dice
//   cuánto falta, así la UI rehabilita el botón en el momento exacto.
// - 'create': llamado nuevo.
export const assistanceDecision = (existing, now) => {
  if (!existing) return { action: 'create' };
  if (!existing.resolved) return { action: 'pending' };
  const sinceResolved = now - existing.resolvedAt;
  if (sinceResolved < ASSISTANCE_REOPEN_COOLDOWN_MS) {
    return { action: 'cooldown', retryInMs: ASSISTANCE_REOPEN_COOLDOWN_MS - sinceResolved };
  }
  return { action: 'create' };
};

// --- MENÚ ---

// Valida y normaliza los campos de un producto del menú que manda el mostrador.
// Devuelve null si algo es inválido (nombre vacío, precio no positivo, categoría
// desconocida): la validación visual del formulario no exime a la del server.
// La categoría tiene que existir: un producto con una categoría inventada no tendría
// pestaña donde aparecer en el menú del cliente.
export const sanitizeMenuFields = ({ name, description, price, category, image } = {}, categories = []) => {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const numPrice = Number(price);
  if (!cleanName || !Number.isFinite(numPrice) || numPrice <= 0 || !categories.some(c => c.id === category)) {
    return null;
  }
  return {
    name: cleanName,
    description: typeof description === 'string' ? description.trim() : '',
    price: numPrice,
    category,
    // El icono se elige por nombre; para productos nuevos sin icono propio se usa
    // uno genérico (el cliente igual renderiza por categoría, ver ClientView).
    image: (typeof image === 'string' && image.trim()) || 'coffee'
  };
};

// --- CONFIGURACIÓN DEL LOCAL ---

export const MAX_BUSINESS_NAME_LENGTH = 60;

// Ajustes que el Mostrador puede cambiar. Devuelve solo los campos válidos que vinieron
// (un formulario puede mandar uno solo), o null si no quedó ninguno.
// El logo es el id de una imagen ya subida (que server.js verifica que exista), o null
// para sacarlo.
export const sanitizeSettings = ({ businessName, logoImageId } = {}) => {
  const clean = {};
  if (typeof businessName === 'string') {
    const name = businessName.trim().slice(0, MAX_BUSINESS_NAME_LENGTH);
    if (name) clean.business_name = name;
  }
  if (logoImageId === null) clean.logo_image_id = '';
  else if (isImageId(logoImageId)) clean.logo_image_id = logoImageId;
  return Object.keys(clean).length > 0 ? clean : null;
};

// --- IMÁGENES ---

// Formatos que se aceptan para fotos y logo, con la firma de sus primeros bytes: el mime
// que declara el navegador no alcanza, se verifica el contenido.
const IMAGE_SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
};
// El frontend achica las fotos a 800 px antes de subirlas; esto es el techo del server.
export const MAX_IMAGE_BYTES = 300 * 1024;

export const newImageId = () => `img-${crypto.randomUUID()}`;
export const isImageId = (id) => typeof id === 'string' && /^img-[0-9a-f-]{36}$/.test(id);

// Imagen subida como { mime, data (base64) }. Devuelve { mime, data: Buffer } o el motivo
// del rechazo.
export const decodeImageUpload = ({ mime, data } = {}) => {
  if (!Object.hasOwn(IMAGE_SIGNATURES, mime)) return { error: 'unsupported_type' };
  if (typeof data !== 'string' || data.length === 0) return { error: 'invalid_image' };
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) return { error: 'too_large' };
  if (buffer.length < 12 || !IMAGE_SIGNATURES[mime](buffer)) return { error: 'invalid_image' };
  return { mime, data: buffer };
};

// --- CATEGORÍAS DEL MENÚ ---

export const newCategoryId = () => `cat-${crypto.randomBytes(6).toString('base64url')}`;

// Nombre e icono (emoji) de una categoría. El icono es opcional: el cliente lo muestra en
// los productos sin foto.
export const sanitizeCategoryFields = ({ name, icon } = {}) => {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_CATEGORY_NAME_LENGTH) : '';
  if (!cleanName) return null;
  const cleanIcon = typeof icon === 'string' ? icon.trim().slice(0, MAX_CATEGORY_ICON_LENGTH) : '';
  return { name: cleanName, icon: cleanIcon };
};

// Una categoría con productos no se borra: quedarían productos sin pestaña en el menú.
// Primero se mueven o se borran sus productos.
export const canDeleteCategory = (categoryId, menu) => !menu.some(item => item.category === categoryId);

// Nuevo orden de las categorías: tiene que ser una permutación exacta de las actuales
// (ni ids de más, ni de menos, ni repetidos). Devuelve las categorías con su position
// nueva, o null si el orden no es válido.
export const reorderCategories = (orderedIds, categories) => {
  if (!Array.isArray(orderedIds) || orderedIds.length !== categories.length) return null;
  if (new Set(orderedIds).size !== orderedIds.length) return null;
  const reordered = orderedIds.map((id, position) => {
    const category = categories.find(c => c.id === id);
    return category && { ...category, position };
  });
  return reordered.every(Boolean) ? reordered : null;
};

// --- REPORTES DE VENTAS ---

export const MAX_REPORT_DAYS = 366;

// Fecha local (zona horaria del server, variable TZ) como 'AAAA-MM-DD'. Los reportes
// agrupan por el día del local, no por el día UTC: en Argentina el día UTC cambia a las 21.
export const localDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const parseDateKey = (key) => {
  const match = typeof key === 'string' && key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  // new Date(2026, 1, 31) "corrige" a marzo: una fecha inexistente se rechaza.
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
};

// Rango de un reporte, con los dos extremos incluidos y en días locales. Devuelve el
// instante de inicio (medianoche del primer día), el de fin (medianoche del día siguiente
// al último) y la lista de días, o null si las fechas no son válidas, están invertidas o
// superan MAX_REPORT_DAYS.
export const parseReportRange = (from, to) => {
  const start = parseDateKey(from);
  const last = parseDateKey(to);
  if (!start || !last || last < start) return null;
  const days = [];
  for (const d = new Date(start); d <= last; d.setDate(d.getDate() + 1)) {
    days.push(localDateKey(d));
    if (days.length > MAX_REPORT_DAYS) return null;
  }
  const end = new Date(last);
  end.setDate(end.getDate() + 1);
  return { start, end, days };
};

// Arma el reporte a partir de los pedidos cobrados del rango ({ tableId, items, closedAt }).
// Una "visita" es un cobro de mesa: close-table sella el mismo closedAt en todos sus
// pedidos, así que el ticket promedio es por mesa cobrada y no por pedido.
export const buildSalesReport = ({ days, paidOrders, cancelledCount = 0, closures = [] }) => {
  const byDay = new Map(days.map(day => [day, { date: day, total: 0, orders: 0 }]));
  const products = new Map();
  const visits = new Set();
  let total = 0;

  for (const order of paidOrders) {
    const orderTotal = itemsTotal(order.items);
    total += orderTotal;
    visits.add(`${order.tableId}|${order.closedAt}`);
    const day = byDay.get(localDateKey(order.closedAt));
    if (day) {
      day.total += orderTotal;
      day.orders += 1;
    }
    for (const item of order.items) {
      // Por id de producto, con el nombre del último pedido: un producto renombrado
      // sigue sumando en la misma fila.
      const row = products.get(item.productId) || { productId: item.productId, name: item.name, quantity: 0, total: 0 };
      row.name = item.name;
      row.quantity += item.quantity;
      row.total += item.price * item.quantity;
      products.set(item.productId, row);
    }
  }

  return {
    total,
    ordersCount: paidOrders.length,
    visitsCount: visits.size,
    averageTicket: visits.size > 0 ? Math.round(total / visits.size) : 0,
    cancelledCount,
    byDay: [...byDay.values()],
    topProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity || b.total - a.total),
    closures
  };
};
