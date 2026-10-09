import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  loadState,
  persistTable,
  persistOrder,
  persistAssistance,
  deleteAssistance,
  deleteTable,
  persistMenuItem,
  deleteMenuItem,
  resetState,
  runInTransaction,
  getDailySalesTotal,
  closeRegister
} from './db.js';
import {
  newQrToken,
  createTable,
  resolveNewTableId,
  syncTableStatus,
  recomputeTable,
  isTableEmpty,
  applyEnabled,
  closedTable,
  sanitizeItems,
  sanitizeNotes,
  sanitizeMenuFields,
  registerNewOrder,
  canAdvanceKitchenStatus,
  canCorrectOrder,
  isKitchenVisible,
  requestBill,
  assistanceDecision,
  closeOrders
} from './domain.js';

// Seguro por defecto: lo que solo sirve para desarrollar (endpoints de test que borran
// la base, contraseñas por defecto, CORS abierto) existe únicamente con DEV_MODE=1, que
// setea `npm run dev` vía .env.development. Antes dependía de que el despliegue no se
// olvidara de NODE_ENV=production: sin esa variable, /api/test/reset quedaba público.
const DEV_MODE = process.env.DEV_MODE === '1';
// Demo pública del portfolio: expone los links de las mesas y las contraseñas en el
// portal, y vuelve el estado a fábrica cuando nadie la usa (ver DEMO_IDLE_MINUTES).
const DEMO_MODE = process.env.DEMO_MODE === '1';

// --- AUTENTICACION DE PERSONAL ---
// Password compartida por rol (cocina/mostrador), pensada para una tablet compartida
// por todo el turno, no para trazabilidad por empleado. Fuera de desarrollo y del modo
// demo es obligatorio definirlas: no se arranca con las credenciales por defecto.
if (!DEV_MODE && !DEMO_MODE && (!process.env.KITCHEN_PASSWORD || !process.env.COUNTER_PASSWORD)) {
  console.error('Faltan KITCHEN_PASSWORD y/o COUNTER_PASSWORD (obligatorias salvo DEV_MODE=1 o DEMO_MODE=1).');
  process.exit(1);
}
const ROLE_PASSWORDS = {
  kitchen: process.env.KITCHEN_PASSWORD || 'cocina123',
  counter: process.env.COUNTER_PASSWORD || 'mostrador123'
};

// CORS: en desarrollo el frontend de Vite (:5173) le habla al backend (:3001) desde
// cualquier IP de la red local. En producción el backend sirve el frontend en el mismo
// origen y no hace falta; CORS_ORIGIN lo habilita si el frontend vive en otro dominio.
const CORS_ORIGIN = process.env.CORS_ORIGIN || (DEV_MODE ? '*' : null);

const app = express();
if (CORS_ORIGIN) app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Tokens de sesión válidos por rol. Se quedan en memoria a propósito (a diferencia
// de mesas/pedidos, que se persisten en SQLite): son sesiones de tablet de turno,
// re-loguearse tras un restart no es pérdida de datos, y guardar tokens de sesión
// en disco sería un riesgo de seguridad innecesario para este alcance.
const validTokens = { kitchen: new Set(), counter: new Set() };

const staffRoleOf = (token) =>
  validTokens.counter.has(token) ? 'counter' : validTokens.kitchen.has(token) ? 'kitchen' : null;

// Exige un token de staff (cocina o mostrador) vía header "Authorization: Bearer <token>".
// Deja el rol en req.staffRole para los endpoints que muestran distinto según quién pide.
const requireStaffAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const role = staffRoleOf(token);
  if (!role) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  req.staffRole = role;
  next();
};

const httpServer = createServer(app);
const io = new Server(httpServer, CORS_ORIGIN ? {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST']
  }
} : {});

// --- ESTADO DE TRABAJO (en memoria, respaldado por SQLite) ---

// Semilla del primer arranque: 12 mesas libres. Es una función y no una constante
// porque cada siembra (incluido /api/test/reset) tiene que generar tokens nuevos.
const initialTables = () => Array.from({ length: 12 }, (_, i) => createTable(String(i + 1)));

// Semilla del menú para el primer arranque (y para /api/test/reset). Después de
// sembrarse, la copia de trabajo es menuCache y la fuente durable es la tabla
// `menu` en SQLite: este array ya no se consulta en los flujos normales.
const DEFAULT_MENU = [
  {
    id: 'm1',
    name: 'Espresso Italiano',
    description: 'Café corto, intenso y con una crema avellanada persistente.',
    price: 1800,
    category: 'bebidas_calientes',
    image: 'espresso'
  },
  {
    id: 'm2',
    name: 'Cappuccino Premium',
    description: 'Espresso con partes iguales de leche vaporizada y espuma cremosa, espolvoreado con cacao.',
    price: 2400,
    category: 'bebidas_calientes',
    image: 'cappuccino'
  },
  {
    id: 'm3',
    name: 'Flat White',
    description: 'Doble shot de espresso con una capa fina de leche aterciopelada.',
    price: 2600,
    category: 'bebidas_calientes',
    image: 'flatwhite'
  },
  {
    id: 'm4',
    name: 'Caramel Macchiato',
    description: 'Café espresso con vainilla, leche vaporizada y un delicioso dibujo de caramelo.',
    price: 2800,
    category: 'bebidas_calientes',
    image: 'caramel_macchiato'
  },
  {
    id: 'm5',
    name: 'Iced Latte',
    description: 'Doble shot de espresso servido sobre leche fría y hielo.',
    price: 2600,
    category: 'bebidas_frias',
    image: 'iced_latte'
  },
  {
    id: 'm6',
    name: 'Jugo de Naranja Exprimido',
    description: '100% natural, recién exprimido.',
    price: 2500,
    category: 'bebidas_frias',
    image: 'orange_juice'
  },
  {
    id: 'm7',
    name: 'Cold Brew Vainilla',
    description: 'Café extraído en frío por 18 horas, servido con un toque de crema de vainilla.',
    price: 2700,
    category: 'bebidas_frias',
    image: 'cold_brew'
  },
  {
    id: 'm8',
    name: 'Medialuna Premium',
    description: 'Clásica medialuna de manteca, hojaldrada y almibarada.',
    price: 800,
    category: 'pasteleria',
    image: 'medialuna'
  },
  {
    id: 'm9',
    name: 'Cinnamon Roll',
    description: 'Rol de canela tibio con un glaseado suave de queso crema.',
    price: 2200,
    category: 'pasteleria',
    image: 'cinnamon_roll'
  },
  {
    id: 'm10',
    name: 'Porción de Chocotorta',
    description: 'El clásico postre argentino hecho con galletitas de chocolate, dulce de leche y queso crema.',
    price: 3500,
    category: 'pasteleria',
    image: 'chocotorta'
  },
  {
    id: 'm11',
    name: 'Tostado de Masa Madre',
    description: 'Sándwich caliente de jamón cocido natural y queso dambo derretido en pan de masa madre.',
    price: 3600,
    category: 'salado',
    image: 'tostado'
  },
  {
    id: 'm12',
    name: 'Avocado Toast',
    description: 'Tostada de masa madre con palta pisada, semillas, tomates cherry y un huevo poché arriba.',
    price: 4200,
    category: 'salado',
    image: 'avocado_toast'
  },
  {
    id: 'm13',
    name: 'Porción de Chipás',
    description: 'Tres pancitos de queso calientes y crujientes por fuera, húmedos por dentro.',
    price: 1500,
    category: 'salado',
    image: 'chipas'
  }
].map(item => ({ ...item, available: true }));

// Las lecturas y la lógica de negocio operan sobre estas estructuras en memoria;
// cada mutación se refleja en SQLite (write-through, ver db.js), así un restart
// del server ya no borra las mesas, pedidos ni cambios del menú.
const persistedState = loadState(initialTables(), DEFAULT_MENU);
let tables = persistedState.tables;
// Mesas de una base anterior a los tokens de QR: se les genera uno al arrancar.
tables.filter(t => !t.qrToken).forEach(t => {
  t.qrToken = newQrToken();
  persistTable(t);
});
let orders = persistedState.orders;
let menuCache = persistedState.menu;

// Solicitudes de "Llamar al Mozo" activas, indexadas por mesa: { timestamp, resolved, resolvedAt }
// (las reglas de duplicados y cooldown están en assistanceDecision, ver domain.js).
const activeAssistanceRequests = persistedState.assistanceRequests;

// --- HELPERS ---

const findTable = (tableId) => tables.find(t => t.id === tableId);

// Mesa a la que está atada esta conexión (por un join con token válido), o null.
// Se revalida contra el token actual y contra la sala: si la mesa se dio de baja, su QR
// se regeneró o se cobró (kickTableClients), la conexión pierde el acceso aunque siga
// abierta, y para volver a pedir tiene que unirse de nuevo.
const getSocketTable = (socket) => {
  const bound = socket.data.table;
  if (!bound || !socket.rooms.has(`table-${bound.id}`)) return null;
  const table = findTable(bound.id);
  return table && table.qrToken === bound.token ? table : null;
};

// Saca de la sala de la mesa a todas las conexiones atadas a ella (baja de la mesa, QR
// regenerado o mesa cobrada), así dejan de recibir sus pedidos y estado y, por
// getSocketTable, tampoco pueden actuar sobre la mesa.
const kickTableClients = (tableId) => io.in(`table-${tableId}`).socketsLeave(`table-${tableId}`);

// Pedidos que todavía cuentan para la mesa (ni cobrados ni cancelados)
const activeOrdersOf = (tableId) => orders.filter(o => o.tableId === tableId && !o.archived);

// Cocina solo necesita ver pedidos activos; el mostrador necesita ver todo
// lo consumido hasta que la mesa se cobra, aunque cocina ya lo haya servido.
const broadcastOrders = () => {
  io.to('kitchen').emit('orders-updated', orders.filter(isKitchenVisible));
  io.to('counter').emit('orders-updated', orders.filter(o => !o.archived));
};

const broadcastTables = () => io.to('counter').emit('tables-updated', tables);

// Habilita o bloquea un grupo de mesas, persiste solo las que cambian y avisa al
// mostrador y a cada mesa afectada (el cliente muestra u oculta el menú en vivo).
const setTablesEnabled = (targets, enabled) => {
  const changed = targets.filter(t => applyEnabled(t, enabled, activeOrdersOf(t.id)));
  if (changed.length === 0) return;
  runInTransaction(() => changed.forEach(persistTable));
  broadcastTables();
  changed.forEach(t => io.to(`table-${t.id}`).emit('table-state', t));
};

// Después de que el mostrador edita o cancela un pedido: recalcula la mesa, persiste y
// avisa a todos. Cocina recibe una alerta aparte porque el pedido ya estaba en su
// pantalla y cambió; la mesa, su total y estado nuevos (y puede haber quedado bloqueada).
const applyCounterCorrection = (order) => {
  const table = findTable(order.tableId);
  if (table) recomputeTable(table, activeOrdersOf(table.id));

  runInTransaction(() => {
    persistOrder(order);
    if (table) persistTable(table);
  });

  broadcastOrders();
  broadcastTables();
  io.to(`table-${order.tableId}`).emit('order-status-changed', order);
  io.to(`table-${order.tableId}`).emit('table-state', table);
  io.to('kitchen').emit('order-modified', { order, reason: order.archived ? 'cancelled' : 'edited' });
};

// --- ENDPOINTS HTTP ---

// Obtener menú (incluye los agotados: el cliente los muestra como "Agotado")
app.get('/api/menu', (req, res) => {
  res.json(menuCache);
});

// Login de personal (cocina/mostrador). Devuelve un token de sesión de larga duración
// que el frontend guarda en localStorage para no pedir contraseña en cada carga.
app.post('/api/auth/login', (req, res) => {
  const { role, password } = req.body || {};
  if (!ROLE_PASSWORDS[role]) {
    return res.status(400).json({ error: 'Rol inválido' });
  }
  if (password !== ROLE_PASSWORDS[role]) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = crypto.randomUUID();
  validTokens[role].add(token);
  res.json({ token });
});

// Obtener estado inicial de mesas y pedidos activos (requiere sesión de personal)
app.get('/api/initial-state', requireStaffAuth, (req, res) => {
  res.json({
    // Los tokens de QR solo los necesita el mostrador (para mostrar el link de cada mesa).
    tables: req.staffRole === 'counter' ? tables : tables.map(({ qrToken, ...t }) => t),
    // No incluye pedidos de mesas ya cerradas/cobradas. A diferencia del filtro de cocina
    // (status !== 'entregado'), esto SÍ incluye pedidos ya servidos pero aún no pagados,
    // que el mostrador necesita mostrar en el ticket. KitchenView aplica su propio filtro extra.
    orders: orders.filter(o => !o.archived),
    // Para que un mostrador que recién se loguea (o recargó la página) vea los llamados
    // que quedaron sin atender mientras no estaba conectado, no solo los que lleguen a partir de ahora.
    assistanceRequests: Array.from(activeAssistanceRequests.entries())
      .filter(([, req]) => !req.resolved)
      .map(([tableId, req]) => ({ tableId, timestamp: req.timestamp })),
    // "Caja del Día" calculada desde la base (pedidos cobrados hoy), no acumulada en el
    // navegador: así una recarga de la página del mostrador no la resetea a $0.
    dailySales: getDailySalesTotal()
  });
});

// Vuelve el estado (memoria y SQLite, incluido el historial de pedidos archivados) a
// como queda un primer arranque: mesas libres, sin pedidos ni llamados de asistencia y
// el menú de fábrica. No toca las sesiones de personal logueadas.
// keepQrTokens: las mesas conservan su token, así las pestañas abiertas siguen valiendo
// (el reset de la demo); si no, cada mesa nace con uno nuevo (el de los tests).
// enableTables: las mesas arrancan habilitadas en vez de bloqueadas.
const resetToSeed = ({ keepQrTokens = false, enableTables = false } = {}) => {
  const previousTokens = new Map(tables.map(t => [t.id, t.qrToken]));
  tables = initialTables();
  tables.forEach(t => {
    if (keepQrTokens && previousTokens.has(t.id)) t.qrToken = previousTokens.get(t.id);
    t.enabled = enableTables;
  });
  orders = [];
  menuCache = JSON.parse(JSON.stringify(DEFAULT_MENU));
  activeAssistanceRequests.clear();
  resetState(tables, DEFAULT_MENU);
};

// Solo para los tests E2E. Existe únicamente con DEV_MODE=1: borra la base sin pedir
// login, así que no puede quedar expuesto en un despliegue real (ni en la demo pública).
if (DEV_MODE) {
  app.post('/api/test/reset', (req, res) => {
    // Las conexiones atadas a mesas viejas pierden el acceso: cada reset genera tokens nuevos.
    // El menú también vuelve a la semilla: los specs de menú crean/borran productos
    // y los demás specs piden los productos por nombre esperando sus precios de fábrica.
    resetToSeed();
    res.json({ ok: true });
  });
}

// Links con token de cada mesa para el simulador de QR del portal y para los tests
// E2E. Expone los tokens sin login, por eso solo existe en desarrollo y en la demo:
// en un despliegue real los links salen solo del Mostrador.
if (DEV_MODE || DEMO_MODE) {
  app.get('/api/demo/table-links', (req, res) => {
    res.json(tables.map(t => ({ id: t.id, qrToken: t.qrToken })));
  });
}

// --- MODO DEMO ---
// La demo es pública y compartida: cualquiera puede borrar el menú o bloquear las mesas.
// Para que el próximo visitante la encuentre entera, se vuelve a fábrica (con las mesas
// habilitadas) cuando pasaron DEMO_IDLE_MINUTES sin actividad. Se espera a que esté
// inactiva para no recargarle la pantalla a alguien en medio de una prueba.
const DEMO_IDLE_MINUTES = Number(process.env.DEMO_IDLE_MINUTES) || 30;
let lastDemoActivityAt = 0;
let lastDemoResetAt = 0;
const markDemoActivity = () => { lastDemoActivityAt = Date.now(); };

const resetDemo = () => {
  resetToSeed({ keepQrTokens: true, enableTables: true });
  lastDemoResetAt = Date.now();
  // Las pantallas abiertas se recargan para tomar el estado nuevo de una vez.
  io.emit('demo-reset');
  console.log('Demo reiniciada al estado de fábrica');
};

if (DEMO_MODE) {
  app.get('/api/demo/info', (req, res) => {
    res.json({ credentials: ROLE_PASSWORDS, idleResetMinutes: DEMO_IDLE_MINUTES });
  });
}

// --- WEBSOCKETS (SOCKET.IO) ---

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // Cualquier acción (no el join, que es solo mirar) cuenta como actividad de la demo.
  if (DEMO_MODE) socket.onAny((event) => { if (event !== 'join') markDemoActivity(); });

  // Evento de personal: se ignora si esta conexión no se unió con ese rol (join con token).
  const staffOn = (role, event, handler) =>
    socket.on(event, (...args) => { if (socket.data.roles?.has(role)) handler(...args); });

  // Unirse a un rol/canal específico. 'kitchen' y 'counter' son canales de personal
  // y requieren un token de sesión válido; 'table-X' requiere el token del QR de la mesa.
  socket.on('join', ({ role, token } = {}) => {
    if (typeof role !== 'string') return;

    if (role === 'kitchen' || role === 'counter') {
      if (!validTokens[role].has(token)) {
        socket.emit('auth-error', { role });
        return;
      }
      socket.data.roles = socket.data.roles || new Set();
      socket.data.roles.add(role);
      socket.join(role);
      console.log(`Socket ${socket.id} se unió al canal: ${role}`);
      return;
    }

    if (role.startsWith('table-')) {
      const tableId = role.replace('table-', '');
      const table = findTable(tableId);
      // null explícito si la mesa no existe (QR viejo de una mesa dada de baja) o el
      // token no es el de su QR (URL armada a mano, QR regenerado): el cliente lo usa
      // para mostrar "mesa no disponible" en vez de quedarse mudo. Sin token válido no
      // entra a la sala, así que tampoco ve los pedidos ni el estado de esa mesa.
      if (!table || typeof token !== 'string' || token !== table.qrToken) {
        socket.emit('table-state', null);
        return;
      }

      // Una conexión atiende a una sola mesa: el simulador del portal puede cambiar de
      // mesa en la misma pestaña, y la mesa anterior no tiene que seguir recibiendo eventos.
      const previous = socket.data.table;
      if (previous && previous.id !== tableId) socket.leave(`table-${previous.id}`);
      // Los eventos del cliente (new-order, request-bill, request-assistance) usan esta
      // mesa y no el tableId que manda el navegador (ver getSocketTable).
      socket.data.table = { id: tableId, token };
      socket.join(role);
      console.log(`Socket ${socket.id} se unió al canal: ${role}`);

      socket.emit('table-state', table);
      // Hidratar todos los pedidos activos de la mesa (no solo el último), para que el
      // cliente pueda armar "Mi Cuenta Parcial" aunque recién esté entrando/recargando
      // la página con pedidos ya en curso. Reutiliza el mismo evento que usan las
      // actualizaciones en vivo, así el cliente no necesita un handler distinto.
      activeOrdersOf(tableId).forEach(o => socket.emit('order-status-changed', o));
    }
  });

  // Evento: Nuevo pedido. Es la única forma en que el cliente manda items a cocina:
  // un pedido enviado no se modifica desde la mesa, cada ronda es una comanda nueva
  // (antes existía update-order, que mezclaba items en un pedido que cocina podía
  // tener ya en preparación o listo, y esos items nuevos nunca se preparaban).
  // Las correcciones de un pedido quedan del lado del Mostrador (edit-order/cancel-order).
  //
  // Responde por acknowledgement ({ ok } o { ok: false, error }): antes un rechazo era
  // silencioso y el cliente ya había vaciado el carrito creyendo que el pedido salió.
  socket.on('new-order', (orderData, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    // La mesa es la de la conexión, no el tableId del payload: antes, desde las devtools,
    // la mesa 3 podía pedir a nombre de la 7. También cubre las mesas dadas de baja: un
    // QR viejo no puede generar pedidos huérfanos que cocina prepararía para nadie.
    const table = getSocketTable(socket);
    if (!table) return reply({ ok: false, error: 'table_unavailable' });
    if (!table.enabled) return reply({ ok: false, error: 'table_disabled' });
    const tableId = table.id;

    const items = sanitizeItems(orderData?.items, menuCache);
    // Nada válido para pedir (menú manipulado, cantidades inválidas, todo agotado, etc.)
    if (items.length === 0) return reply({ ok: false, error: 'no_valid_items' });

    const newOrder = {
      id: `ord-${crypto.randomUUID()}`,
      tableId,
      items,
      notes: sanitizeNotes(orderData?.notes),
      status: 'pendiente',
      archived: false, // se marca true recién cuando se cierra/cobra la mesa (close-table)
      createdAt: new Date().toISOString()
    };
    
    orders.push(newOrder);
    // Si la mesa ya había pedido la cuenta, este pedido la cancela (ver registerNewOrder).
    const billCancelled = registerNewOrder(table, newOrder);

    runInTransaction(() => {
      persistOrder(newOrder);
      persistTable(table);
    });
    reply({ ok: true, orderId: newOrder.id });

    // Notificar a cocina, mostrador y a la mesa correspondiente
    io.to('kitchen').emit('order-received', newOrder);
    io.to('counter').emit('order-received-counter', newOrder);
    // Alerta aparte: el mozo puede estar yendo a la mesa con la cuenta impresa.
    if (billCancelled) io.to('counter').emit('bill-cancelled', { tableId });
    broadcastTables();
    io.to(`table-${tableId}`).emit('table-state', table);
    io.to(`table-${tableId}`).emit('order-status-changed', newOrder);
  });

  // Evento: Actualizar estado del pedido (desde Cocina). Solo hacia adelante por el
  // flujo de cocina (ver canAdvanceKitchenStatus).
  staffOn('kitchen', 'update-order-status', ({ orderId, status } = {}) => {
    const order = orders.find(o => o.id === orderId);
    if (!order || !canAdvanceKitchenStatus(order, status)) return;
    order.status = status;

    // La mesa pasa a 'comiendo' recién cuando TODOS sus pedidos activos están entregados
    const table = findTable(order.tableId);
    if (table) syncTableStatus(table, activeOrdersOf(table.id));

    runInTransaction(() => {
      persistOrder(order);
      if (table) persistTable(table);
    });

    // Notificar a todos los canales relevantes
    broadcastOrders();
    broadcastTables();
    io.to(`table-${order.tableId}`).emit('order-status-changed', order);
    if (table) io.to(`table-${order.tableId}`).emit('table-state', table);
  });

  // Evento: Corregir un pedido desde el Mostrador (error humano, antes de cobrar).
  // Reemplaza la lista de items completa (permite sacar, cambiar cantidad y agregar).
  // Solo mientras cocina no lo empezó a preparar (ver canCorrectOrder).
  staffOn('counter', 'edit-order', ({ orderId, items: rawItems } = {}) => {
    const order = orders.find(o => o.id === orderId);
    if (!order || !canCorrectOrder(order)) return;

    // Conserva los items ya pedidos aunque el producto se haya agotado/borrado del
    // menú después (ver sanitizeItems).
    const items = sanitizeItems(rawItems, menuCache, order.items);
    // Si el mostrador saca todos los items (o no quedó ninguno válido), es lo mismo
    // que cancelar el pedido entero.
    if (items.length === 0) {
      order.status = 'cancelado';
      order.archived = true;
    } else {
      order.items = items;
    }

    applyCounterCorrection(order);
  });

  // Evento: Cancelar un pedido completo desde el Mostrador (mismas reglas que edit-order).
  staffOn('counter', 'cancel-order', ({ orderId } = {}) => {
    const order = orders.find(o => o.id === orderId);
    if (!order || !canCorrectOrder(order)) return;

    order.status = 'cancelado';
    order.archived = true;
    applyCounterCorrection(order);
  });

  // Evento: Solicitar cierre de cuenta (desde Cliente)
  socket.on('request-bill', ({ paymentMethod } = {}) => {
    const table = getSocketTable(socket);
    if (!table) return;
    const tableId = table.id;
    if (!requestBill(table, paymentMethod)) return;
    persistTable(table);

    // Notificar a mostrador y al cliente de la mesa
    broadcastTables();
    io.to('counter').emit('bill-requested', { tableId, paymentMethod, total: table.total });
    io.to(`table-${tableId}`).emit('table-state', table);
  });

  // Evento: Llamar al mozo (desde Cliente). Protegido en el servidor, no solo en la UI:
  // no se duplica un llamado sin atender ni se reabre dentro del cooldown (ver
  // assistanceDecision). Siempre responde assistance-ack al cliente que pidió: antes el rechazo por cooldown
  // era silencioso y la UI quedaba en "Mozo en camino..." 60s sin ningún llamado real.
  socket.on('request-assistance', () => {
    const table = getSocketTable(socket);
    if (!table) return;
    // Con la mesa bloqueada (siempre vacía) un link filtrado no sirve para llamar al
    // mozo con el local cerrado. request-bill no lo necesita: ya exige la mesa en "comiendo".
    if (!table.enabled) return;
    const tableId = table.id;

    const now = Date.now();
    const decision = assistanceDecision(activeAssistanceRequests.get(tableId), now);
    // Ya hay un llamado sin atender: para este cliente sigue valiendo "mozo en camino".
    if (decision.action === 'pending') return socket.emit('assistance-ack', { accepted: true });
    if (decision.action === 'cooldown') {
      return socket.emit('assistance-ack', { accepted: false, retryInMs: decision.retryInMs });
    }

    const request = { timestamp: now, resolved: false, resolvedAt: null };
    activeAssistanceRequests.set(tableId, request);
    persistAssistance(tableId, request);
    socket.emit('assistance-ack', { accepted: true });
    io.to('counter').emit('assistance-requested', { tableId, timestamp: now });
  });

  // Evento: Marcar una solicitud de asistencia como atendida (desde Mostrador)
  staffOn('counter', 'resolve-assistance', ({ tableId: rawTableId }) => {
    const tableId = String(rawTableId);

    const existing = activeAssistanceRequests.get(tableId);
    if (existing) {
      existing.resolved = true;
      existing.resolvedAt = Date.now();
      persistAssistance(tableId, existing);
    }

    io.to(`table-${tableId}`).emit('assistance-resolved');
  });

  // Evento: Agregar una mesa nueva (desde Mostrador). Sin número pedido, se asigna el
  // más chico sin usar. La mesa nace con un token nuevo: reponer una mesa dada de baja
  // necesita un QR nuevo (el viejo, con el token anterior, ya no vale).
  staffOn('counter', 'add-table', ({ id } = {}) => {
    const tableId = resolveNewTableId(tables.map(t => t.id), id);
    if (!tableId) return;

    const newTable = createTable(tableId);
    tables.push(newTable);
    tables.sort((a, b) => Number(a.id) - Number(b.id));
    persistTable(newTable);

    broadcastTables();
  });

  // Evento: Quitar una mesa (desde Mostrador). Puede quitarse cualquiera —las demás
  // conservan su número y su QR impreso— pero solo si
  // está libre: sin pedidos activos ni llamados al mozo pendientes. Una mesa ocupada
  // se cobra/cierra primero; si no, se destruiría consumo en curso sin registro.
  staffOn('counter', 'remove-table', ({ tableId: rawTableId } = {}) => {
    const tableId = String(rawTableId);
    const table = findTable(tableId);
    if (!table || !isTableEmpty(table, activeOrdersOf(tableId))) return;
    const assistance = activeAssistanceRequests.get(tableId);
    if (assistance && !assistance.resolved) return;

    tables = tables.filter(t => t.id !== tableId);
    activeAssistanceRequests.delete(tableId);
    runInTransaction(() => {
      deleteTable(tableId);
      deleteAssistance(tableId);
    });

    broadcastTables();
    // El QR viejo deja de valer: cualquier cliente mirando esa mesa pasa a "no disponible".
    io.to(`table-${tableId}`).emit('table-removed');
    kickTableClients(tableId);
  });

  // Evento: Regenerar el QR de una mesa (desde Mostrador). Para cuando el link de una
  // mesa se filtró (alguien se lo llevó y pide a su nombre desde afuera): el token viejo
  // deja de valer al instante y quien esté conectado con él pierde el acceso. Se permite
  // con la mesa ocupada a propósito, porque ese es justamente el caso urgente; el consumo
  // de la mesa no se toca, y los clientes sentados escanean el QR nuevo.
  staffOn('counter', 'regenerate-table-qr', ({ tableId: rawTableId } = {}) => {
    const table = findTable(String(rawTableId));
    if (!table) return;

    table.qrToken = newQrToken();
    persistTable(table);

    broadcastTables();
    io.to(`table-${table.id}`).emit('table-removed');
    kickTableClients(table.id);
  });

  // --- HABILITACIÓN DE MESAS (desde Mostrador) ---
  // Una mesa bloqueada no acepta pedidos ni llamados al mozo. El inicio y el cierre del
  // día cambian todas las mesas a la vez; en el medio, cada mesa se maneja por separado.
  // Las mesas con clientes se bloquean recién al cobrarlas (ver applyEnabled).

  // Evento: Habilitar o bloquear una mesa puntual
  staffOn('counter', 'set-table-enabled', ({ tableId: rawTableId, enabled } = {}) => {
    if (typeof enabled !== 'boolean') return;
    const table = findTable(String(rawTableId));
    if (!table) return;
    setTablesEnabled([table], enabled);
  });

  // Evento: Iniciar el día (habilita todas las mesas)
  staffOn('counter', 'start-day', () => {
    setTablesEnabled(tables, true);
  });

  // Evento: Cerrar el día. Bloquea las mesas vacías en el acto y marca las ocupadas para
  // bloquearse al cobrarlas, así no hace falta cobrar todo para cerrar. Independiente
  // del cierre de caja: el Mostrador puede hacer los dos juntos, pero no es obligatorio.
  staffOn('counter', 'end-day', () => {
    setTablesEnabled(tables, false);
  });

  // Evento: Confirmar cobro y liberar mesa (desde Mostrador/Caja)
  staffOn('counter', 'close-table', ({ tableId: rawTableId } = {}) => {
    const tableId = String(rawTableId);
    const tableIndex = tables.findIndex(t => t.id === tableId);
    if (tableIndex === -1) return;

    // Solo los pedidos activos de la visita (ver closeOrders).
    const closedOrders = closeOrders(orders, tableId, new Date().toISOString());
    tables[tableIndex] = closedTable(tables[tableIndex]);
    activeAssistanceRequests.delete(tableId);

    runInTransaction(() => {
      closedOrders.forEach(persistOrder);
      persistTable(tables[tableIndex]);
      deleteAssistance(tableId);
    });

    // Notificar a mostrador, cocina y a la mesa correspondiente
    broadcastTables();
    broadcastOrders();
    // El server es la única fuente de la caja: todos los mostradores conectados
    // reciben el total real (dos pestañas abiertas no divergen por sumas locales).
    io.to('counter').emit('daily-sales-updated', getDailySalesTotal());
    // La visita terminó: se desconecta de la mesa a todos sus celulares. Si no, el que
    // deja la página abierta seguiría viendo en vivo los pedidos del grupo siguiente.
    // Para volver a pedir hay que escanear el QR de nuevo.
    io.to(`table-${tableId}`).emit('table-closed');
    kickTableClients(tableId);
  });

  // --- CRUD DEL MENÚ (desde Mostrador) ---
  // Por sockets y no por HTTP a propósito: la guarda de rol counter (staffOn) es la misma
  // que protege close-table/add-table (requireStaffAuth no alcanza: aceptaría también
  // el token de cocina, que no tiene por qué poder tocar precios). Tras cada mutación
  // se persiste en SQLite y se emite menu-updated a TODOS los conectados (los clientes
  // en las mesas actualizan catálogo y carrito en vivo, sin recargar).

  // Evento: Agregar un producto al menú
  staffOn('counter', 'menu-add', (data = {}) => {
    const fields = sanitizeMenuFields(data);
    if (!fields) return;

    const newItem = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      ...fields,
      available: true
    };
    menuCache.push(newItem);
    persistMenuItem(newItem);
    io.emit('menu-updated', menuCache);
  });

  // Evento: Editar un producto (datos y/o disponibilidad). El switch rápido de
  // "agotado" del mostrador usa este mismo evento con available invertido.
  staffOn('counter', 'menu-update', (data = {}) => {
    const item = menuCache.find(m => m.id === data.id);
    if (!item) return;
    const fields = sanitizeMenuFields(data);
    if (!fields) return;

    // Si el payload no trae available (edición de datos solamente), se conserva el
    // actual: que un formulario incompleto no "agote" un producto por accidente.
    const available = data.available === undefined ? item.available : Boolean(data.available);
    Object.assign(item, fields, { available });
    persistMenuItem(item);
    io.emit('menu-updated', menuCache);
  });

  // Evento: Eliminar un producto del menú. No rompe nada retroactivamente: los
  // pedidos (activos y archivados) guardan snapshot de nombre/precio, y edit-order
  // conserva los items ya pedidos aunque el producto ya no exista (sanitizeItems).
  staffOn('counter', 'menu-delete', ({ id } = {}) => {
    if (!menuCache.some(m => m.id === id)) return;

    menuCache = menuCache.filter(m => m.id !== id);
    deleteMenuItem(id);
    io.emit('menu-updated', menuCache);
  });

  // Evento: Cerrar la caja (desde Mostrador). Registra un cierre en el histórico con
  // lo cobrado desde el cierre anterior y la caja arranca de nuevo en $0. No exige
  // mesas libres: lo que se cobre después del cierre cuenta para la caja siguiente,
  // así una mesa que se queda hasta tarde no bloquea el arqueo del turno.
  staffOn('counter', 'close-register', () => {
    const closure = closeRegister();
    io.to('counter').emit('register-closed', closure);
    io.to('counter').emit('daily-sales-updated', getDailySalesTotal());
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// El build del frontend (npm run build) se sirve desde el mismo server: en producción
// queda todo en un solo servicio y un solo origen. En desarrollo lo sirve Vite.
const FRONTEND_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'dist');
if (existsSync(FRONTEND_DIST)) app.use(express.static(FRONTEND_DIST));

if (DEMO_MODE) {
  // Cada visitante llega a una demo limpia y con las mesas habilitadas.
  resetDemo();
  setInterval(() => {
    const idleMs = Date.now() - lastDemoActivityAt;
    if (lastDemoActivityAt > lastDemoResetAt && idleMs > DEMO_IDLE_MINUTES * 60_000) resetDemo();
  }, 60_000).unref();
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Servidor de la cafetería corriendo en http://localhost:${PORT}`);
});
