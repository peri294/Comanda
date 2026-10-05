import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';
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

const app = express();
app.use(cors());
app.use(express.json());

// --- AUTENTICACION DE PERSONAL ---
// Password compartida por rol (cocina/mostrador), pensada para una tablet compartida
// por todo el turno, no para trazabilidad por empleado. Sobreescribible por variable
// de entorno para no dejar las credenciales de demo en un despliegue real.
const ROLE_PASSWORDS = {
  kitchen: process.env.KITCHEN_PASSWORD || 'cocina123',
  counter: process.env.COUNTER_PASSWORD || 'mostrador123'
};

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
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// --- ESTADO DE TRABAJO (en memoria, respaldado por SQLite) ---

// Token secreto del QR de cada mesa: el QR apunta a ?table=X&t=<token>, y sin el token
// el server no deja unirse a la mesa ni pedir, pedir la cuenta o llamar al mozo a su
// nombre. 12 bytes aleatorios (16 caracteres en base64url): imposible de adivinar y
// corto para que el QR no quede denso.
const newQrToken = () => crypto.randomBytes(12).toString('base64url');

const createTable = (id) => ({
  id,
  status: 'libre', // 'libre' | 'pedido_pendiente' | 'comiendo' | 'esperando_cuenta' | 'pagando_tarjeta'
  currentOrderId: null,
  paymentMethod: null,
  total: 0,
  qrToken: newQrToken(),
  // Toda mesa nace bloqueada: recibe pedidos recién cuando el Mostrador la habilita
  // (al iniciar el día o una por una). Fuera del horario, un link filtrado no sirve.
  enabled: false,
  // Bloqueo pedido con clientes sentados: se aplica al cobrar la mesa (ver applyEnabled).
  blockOnClose: false
});

// Semilla del primer arranque: 12 mesas libres. Es una función y no una constante
// porque cada siembra (incluido /api/test/reset) tiene que generar tokens nuevos.
const initialTables = () => Array.from({ length: 12 }, (_, i) => createTable(String(i + 1)));

// Categorías válidas en v1: los filtros del cliente están atados a estas cuatro,
// un producto con una categoría inventada no tendría pestaña donde aparecer.
const MENU_CATEGORIES = ['bebidas_calientes', 'bebidas_frias', 'pasteleria', 'salado'];

// Recorrido de un pedido en cocina, en orden. 'cancelado' no está: lo pone solo el Mostrador.
const KITCHEN_FLOW = ['pendiente', 'en_preparacion', 'listo', 'entregado'];

const PAYMENT_METHODS = ['efectivo', 'tarjeta'];

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

// Solicitudes de "Llamar al Mozo" activas, indexadas por mesa: { timestamp, resolved, resolvedAt }.
// Mientras sigue sin atender, se bloquea cualquier duplicado sin importar el tiempo transcurrido.
// Una vez atendida, solo se aplica un cooldown corto (medido desde que se resolvió, no desde el
// pedido original) para evitar un doble-click accidental, sin bloquear un pedido de ayuda legítimo.
const activeAssistanceRequests = persistedState.assistanceRequests;
const ASSISTANCE_REOPEN_COOLDOWN_MS = 10_000;

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
const getMenuItem = (productId) => menuCache.find(m => m.id === productId);

// Nunca confiar en precio/nombre que manda el cliente: siempre se recalculan contra
// el menú del servidor, así nadie puede pedir gratis (o más caro) manipulando el payload.
// También descarta productos inexistentes, agotados (available = false: la UI ya no
// deja pedirlos, pero un payload manual podría intentarlo igual) y cantidades inválidas.
const sanitizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items.reduce((acc, item) => {
    const menuItem = getMenuItem(item?.productId);
    const quantity = Math.floor(Number(item?.quantity));
    if (menuItem && menuItem.available && Number.isFinite(quantity) && quantity > 0) {
      acc.push({ productId: menuItem.id, name: menuItem.name, price: menuItem.price, quantity });
    }
    return acc;
  }, []);
};

// Variante para edit-order: "agotado" significa *no pedir más*, no *borrar lo ya pedido*.
// Los items que ya estaban en el pedido se conservan con su snapshot (nombre/precio al
// momento de pedirlos), aunque el producto se haya agotado o borrado del menú después
// — si no, editar un pedido con un producto discontinuado lo haría desaparecer en
// silencio (y con un solo item, cancelaría el pedido entero). Solo los items nuevos
// se validan estrictamente contra el menú vigente y su disponibilidad.
const sanitizeEditItems = (order, rawItems) => {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.reduce((acc, item) => {
    const quantity = Math.floor(Number(item?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) return acc;

    const existing = order.items.find(i => i.productId === item?.productId);
    if (existing) {
      acc.push({ productId: existing.productId, name: existing.name, price: existing.price, quantity });
    } else {
      const menuItem = getMenuItem(item?.productId);
      if (menuItem && menuItem.available) {
        acc.push({ productId: menuItem.id, name: menuItem.name, price: menuItem.price, quantity });
      }
    }
    return acc;
  }, []);
};

// Valida y normaliza los campos de un producto del menú que manda el mostrador.
// Devuelve null si algo es inválido (nombre vacío, precio no positivo, categoría
// desconocida): la validación visual del formulario no exime a la del server.
const sanitizeMenuFields = ({ name, description, price, category, image } = {}) => {
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const numPrice = Number(price);
  if (!cleanName || !Number.isFinite(numPrice) || numPrice <= 0 || !MENU_CATEGORIES.includes(category)) {
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

const isBillRequested = (table) => table.status === 'esperando_cuenta' || table.status === 'pagando_tarjeta';

// Deriva el estado de la mesa de TODOS sus pedidos activos, no del último evento:
// antes, entregar el pedido 1 pasaba la mesa a "comiendo" aunque el pedido 2 siguiera
// en cocina, y pisaba un pedido de cuenta hecho mientras el mozo llevaba la comida.
// Con la cuenta pedida no se toca (solo la cancela un pedido nuevo, ver new-order);
// sin pedidos activos tampoco (eso lo resuelve recomputeTableTotal liberando la mesa).
const syncTableStatus = (table) => {
  if (isBillRequested(table)) return;
  const activeOrders = orders.filter(o => o.tableId === table.id && !o.archived);
  if (activeOrders.length === 0) return;
  table.status = activeOrders.every(o => o.status === 'entregado') ? 'comiendo' : 'pedido_pendiente';
};

// Recalcula el total de una mesa a partir de sus pedidos activos (no archivados).
const recomputeTableTotal = (tableId) => {
  const table = findTable(tableId);
  if (!table) return;
  const activeOrders = orders.filter(o => o.tableId === tableId && !o.archived);
  table.total = activeOrders.reduce((acc, o) => acc + o.items.reduce((sum, item) => sum + item.price * item.quantity, 0), 0);

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
  syncTableStatus(table);
};

// Cocina no necesita ver pedidos ya entregados ni cancelados por el mostrador.
const isKitchenVisible = (o) => o.status !== 'entregado' && o.status !== 'cancelado';

// Cocina solo necesita ver pedidos activos; el mostrador necesita ver todo
// lo consumido hasta que la mesa se cobra, aunque cocina ya lo haya servido.
const broadcastOrders = () => {
  io.to('kitchen').emit('orders-updated', orders.filter(isKitchenVisible));
  io.to('counter').emit('orders-updated', orders.filter(o => !o.archived));
};

const broadcastTables = () => io.to('counter').emit('tables-updated', tables);

const isTableEmpty = (table) =>
  table.status === 'libre' && !orders.some(o => o.tableId === table.id && !o.archived);

// Una mesa bloqueada siempre está vacía: si no, el próximo que escaneara el QR al
// habilitarla vería la cuenta de los clientes anteriores. Por eso bloquear una mesa
// con clientes no la bloquea en el acto: la marca (blockOnClose) y se bloquea cuando
// se cobra. Habilitar una mesa marcada cancela el bloqueo pendiente.
// Devuelve si la mesa cambió.
const applyEnabled = (table, enabled) => {
  let next;
  if (enabled) next = { enabled: true, blockOnClose: false };
  else if (isTableEmpty(table)) next = { enabled: false, blockOnClose: false };
  else next = { enabled: table.enabled, blockOnClose: true };

  if (next.enabled === table.enabled && next.blockOnClose === table.blockOnClose) return false;
  Object.assign(table, next);
  return true;
};

// Habilita o bloquea un grupo de mesas, persiste solo las que cambian y avisa al
// mostrador y a cada mesa afectada (el cliente muestra u oculta el menú en vivo).
const setTablesEnabled = (targets, enabled) => {
  const changed = targets.filter(t => applyEnabled(t, enabled));
  if (changed.length === 0) return;
  runInTransaction(() => changed.forEach(persistTable));
  broadcastTables();
  changed.forEach(t => io.to(`table-${t.id}`).emit('table-state', t));
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

// Solo para los tests E2E: vuelve el estado (memoria y SQLite, incluido el historial
// de pedidos archivados) a como queda un primer arranque: mesas libres, sin pedidos
// ni llamados de asistencia. No toca las sesiones de personal logueadas. No existe
// si NODE_ENV=production, para no exponerlo en un despliegue real.
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/test/reset', (req, res) => {
    // Las conexiones atadas a mesas viejas pierden el acceso: cada reset genera tokens nuevos.
    tables = initialTables();
    orders = [];
    // El menú también vuelve a la semilla: los specs de menú crean/borran productos
    // y los demás specs piden los productos por nombre esperando sus precios de fábrica.
    menuCache = JSON.parse(JSON.stringify(DEFAULT_MENU));
    activeAssistanceRequests.clear();
    resetState(tables, DEFAULT_MENU);
    res.json({ ok: true });
  });

  // Links con token de cada mesa para el simulador de QR del portal y para los tests
  // E2E. Expone los tokens sin login, por eso tampoco existe en producción: ahí los
  // links salen solo del Mostrador.
  app.get('/api/demo/table-links', (req, res) => {
    res.json(tables.map(t => ({ id: t.id, qrToken: t.qrToken })));
  });
}

// --- WEBSOCKETS (SOCKET.IO) ---

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

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
      orders
        .filter(o => o.tableId === tableId && !o.archived)
        .forEach(o => socket.emit('order-status-changed', o));
    }
  });

  // Evento: Nuevo pedido. Es la única forma en que el cliente manda items a cocina:
  // un pedido enviado no se modifica desde la mesa, cada ronda es una comanda nueva
  // (antes existía update-order, que mezclaba items en un pedido que cocina podía
  // tener ya en preparación o listo, y esos items nuevos nunca se preparaban).
  // Las correcciones de un pedido quedan del lado del Mostrador (edit-order/cancel-order).
  socket.on('new-order', (orderData = {}) => {
    // La mesa es la de la conexión, no el tableId del payload: antes, desde las devtools,
    // la mesa 3 podía pedir a nombre de la 7. También cubre las mesas dadas de baja: un
    // QR viejo no puede generar pedidos huérfanos que cocina prepararía para nadie.
    const table = getSocketTable(socket);
    if (!table || !table.enabled) return;
    const tableId = table.id;

    const { notes, paymentMethod } = orderData;
    const items = sanitizeItems(orderData.items);
    if (items.length === 0) return; // nada válido para pedir (menú manipulado, cantidades inválidas, etc.)

    // Calcular total del pedido
    const orderTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    const newOrder = {
      id: `ord-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      tableId,
      items,
      notes: notes || '',
      status: 'pendiente',
      archived: false, // se marca true recién cuando se cierra/cobra la mesa (close-table)
      createdAt: new Date().toISOString()
    };
    
    orders.push(newOrder);

    // Si la mesa ya había pedido la cuenta, pedir algo más la cancela: el consumo sigue
    // sumando y la cuenta se vuelve a pedir cuando terminen (con su método de pago).
    const billCancelled = isBillRequested(table);

    // Actualizar estado de la mesa
    table.status = 'pedido_pendiente';
    table.currentOrderId = newOrder.id;
    table.total += orderTotal;
    if (billCancelled) table.paymentMethod = null;
    if (paymentMethod) table.paymentMethod = paymentMethod;

    runInTransaction(() => {
      persistOrder(newOrder);
      persistTable(table);
    });

    // Notificar a cocina, mostrador y a la mesa correspondiente
    io.to('kitchen').emit('order-received', newOrder);
    io.to('counter').emit('order-received-counter', newOrder);
    // Alerta aparte: el mozo puede estar yendo a la mesa con la cuenta impresa.
    if (billCancelled) io.to('counter').emit('bill-cancelled', { tableId });
    broadcastTables();
    io.to(`table-${tableId}`).emit('table-state', table);
    io.to(`table-${tableId}`).emit('order-status-changed', newOrder);
  });

  // Evento: Actualizar estado del pedido (desde Cocina)
  // Solo estados reales del flujo de cocina y solo hacia adelante (puede saltear pasos,
  // nunca retroceder): antes se guardaba cualquier string, y un pedido ya cobrado o
  // cancelado podía "resucitar" en la pantalla de cocina.
  socket.on('update-order-status', ({ orderId, status }) => {
    if (!socket.data.roles?.has('kitchen')) return;
    const order = orders.find(o => o.id === orderId);
    if (!order || order.archived) return;
    const from = KITCHEN_FLOW.indexOf(order.status);
    const to = KITCHEN_FLOW.indexOf(status);
    if (from === -1 || to <= from) return;
    order.status = status;

    // La mesa pasa a 'comiendo' recién cuando TODOS sus pedidos activos están entregados
    const table = findTable(order.tableId);
    if (table) syncTableStatus(table);

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
  // Solo mientras cocina no lo empezó a preparar, para no confundir al cocinero.
  socket.on('edit-order', ({ orderId, items: rawItems }) => {
    if (!socket.data.roles?.has('counter')) return;
    const order = orders.find(o => o.id === orderId);
    if (!order || order.archived || order.status !== 'pendiente') return;

    // Variante especial de sanitización: conserva los items ya pedidos aunque el
    // producto se haya agotado/borrado del menú después (ver sanitizeEditItems).
    const items = sanitizeEditItems(order, rawItems);
    // Si el mostrador saca todos los items (o no quedó ninguno válido), es lo mismo
    // que cancelar el pedido entero.
    if (items.length === 0) {
      order.status = 'cancelado';
      order.archived = true;
    } else {
      order.items = items;
    }

    recomputeTableTotal(order.tableId);

    runInTransaction(() => {
      persistOrder(order);
      const table = findTable(order.tableId);
      if (table) persistTable(table);
    });

    broadcastOrders();
    broadcastTables();
    io.to(`table-${order.tableId}`).emit('order-status-changed', order);
    // El total y el estado de la mesa cambiaron (y puede haber quedado bloqueada).
    io.to(`table-${order.tableId}`).emit('table-state', findTable(order.tableId));
    // Alerta aparte para cocina: el pedido ya estaba en su pantalla y cambió.
    io.to('kitchen').emit('order-modified', { order, reason: order.archived ? 'cancelled' : 'edited' });
  });

  // Evento: Cancelar un pedido completo desde el Mostrador (mismas reglas que edit-order).
  socket.on('cancel-order', ({ orderId }) => {
    if (!socket.data.roles?.has('counter')) return;
    const order = orders.find(o => o.id === orderId);
    if (!order || order.archived || order.status !== 'pendiente') return;

    order.status = 'cancelado';
    order.archived = true;

    recomputeTableTotal(order.tableId);

    runInTransaction(() => {
      persistOrder(order);
      const table = findTable(order.tableId);
      if (table) persistTable(table);
    });

    broadcastOrders();
    broadcastTables();
    io.to(`table-${order.tableId}`).emit('order-status-changed', order);
    // El total y el estado de la mesa cambiaron (y puede haber quedado bloqueada).
    io.to(`table-${order.tableId}`).emit('table-state', findTable(order.tableId));
    io.to('kitchen').emit('order-modified', { order, reason: 'cancelled' });
  });

  // Evento: Solicitar cierre de cuenta (desde Cliente)
  socket.on('request-bill', ({ paymentMethod } = {}) => {
    const table = getSocketTable(socket);
    if (!table) return;
    const tableId = table.id;
    // Mismas reglas que la UI del cliente (el botón solo aparece en "comiendo"): método
    // de pago conocido y la mesa con todo entregado. Antes cualquier valor que no fuera
    // 'efectivo' se tomaba como tarjeta, y una mesa libre en $0 podía "pedir la cuenta".
    if (!PAYMENT_METHODS.includes(paymentMethod) || table.status !== 'comiendo') return;

    table.status = paymentMethod === 'efectivo' ? 'esperando_cuenta' : 'pagando_tarjeta';
    table.paymentMethod = paymentMethod;
    persistTable(table);

    // Notificar a mostrador y al cliente de la mesa
    broadcastTables();
    io.to('counter').emit('bill-requested', { tableId, paymentMethod, total: table.total });
    io.to(`table-${tableId}`).emit('table-state', table);
  });

  // Evento: Llamar al mozo (desde Cliente). Protegido en el servidor, no solo en la UI:
  // se rechaza si la mesa ya tiene una solicitud sin atender (sin importar el tiempo que
  // pasó), o si se resolvió hace menos de ASSISTANCE_REOPEN_COOLDOWN_MS (evita doble-click
  // apenas se habilita el botón, sin bloquear un segundo pedido de ayuda legítimo).
  // Siempre responde assistance-ack al cliente que pidió: antes el rechazo por cooldown
  // era silencioso y la UI quedaba en "Mozo en camino..." 60s sin ningún llamado real.
  socket.on('request-assistance', () => {
    const table = getSocketTable(socket);
    if (!table) return;
    // Con la mesa bloqueada (siempre vacía) un link filtrado no sirve para llamar al
    // mozo con el local cerrado. request-bill no lo necesita: ya exige la mesa en "comiendo".
    if (!table.enabled) return;
    const tableId = table.id;

    const existing = activeAssistanceRequests.get(tableId);
    const now = Date.now();
    if (existing) {
      if (!existing.resolved) {
        // Ya hay un llamado sin atender: no se duplica la alerta al mostrador, pero
        // para este cliente sigue valiendo "mozo en camino" (botón bloqueado).
        socket.emit('assistance-ack', { accepted: true });
        return;
      }
      const sinceResolved = now - existing.resolvedAt;
      if (sinceResolved < ASSISTANCE_REOPEN_COOLDOWN_MS) {
        // Rechazado por cooldown: se informa cuánto falta para poder volver a llamar,
        // así la UI rehabilita el botón en el momento exacto.
        socket.emit('assistance-ack', { accepted: false, retryInMs: ASSISTANCE_REOPEN_COOLDOWN_MS - sinceResolved });
        return;
      }
    }

    const request = { timestamp: now, resolved: false, resolvedAt: null };
    activeAssistanceRequests.set(tableId, request);
    persistAssistance(tableId, request);
    socket.emit('assistance-ack', { accepted: true });
    io.to('counter').emit('assistance-requested', { tableId, timestamp: now });
  });

  // Evento: Marcar una solicitud de asistencia como atendida (desde Mostrador)
  socket.on('resolve-assistance', ({ tableId: rawTableId }) => {
    if (!socket.data.roles?.has('counter')) return;
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
  socket.on('add-table', ({ id } = {}) => {
    if (!socket.data.roles?.has('counter')) return;

    let tableId;
    if (id !== undefined && id !== null && String(id).trim() !== '') {
      // Número puntual: entero positivo, normalizado (sin ceros a la izquierda) y único.
      const requested = Number(String(id).trim());
      if (!Number.isInteger(requested) || requested < 1) return;
      tableId = String(requested);
      if (findTable(tableId)) return;
    } else {
      let n = 1;
      while (findTable(String(n))) n++;
      tableId = String(n);
    }

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
  socket.on('remove-table', ({ tableId: rawTableId } = {}) => {
    if (!socket.data.roles?.has('counter')) return;
    const tableId = String(rawTableId);
    const table = findTable(tableId);
    if (!table || table.status !== 'libre') return;
    if (orders.some(o => o.tableId === tableId && !o.archived)) return;
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
  socket.on('regenerate-table-qr', ({ tableId: rawTableId } = {}) => {
    if (!socket.data.roles?.has('counter')) return;
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
  socket.on('set-table-enabled', ({ tableId: rawTableId, enabled } = {}) => {
    if (!socket.data.roles?.has('counter')) return;
    if (typeof enabled !== 'boolean') return;
    const table = findTable(String(rawTableId));
    if (!table) return;
    setTablesEnabled([table], enabled);
  });

  // Evento: Iniciar el día (habilita todas las mesas)
  socket.on('start-day', () => {
    if (!socket.data.roles?.has('counter')) return;
    setTablesEnabled(tables, true);
  });

  // Evento: Cerrar el día. Bloquea las mesas vacías en el acto y marca las ocupadas para
  // bloquearse al cobrarlas, así no hace falta cobrar todo para cerrar. Independiente
  // del cierre de caja: el Mostrador puede hacer los dos juntos, pero no es obligatorio.
  socket.on('end-day', () => {
    if (!socket.data.roles?.has('counter')) return;
    setTablesEnabled(tables, false);
  });

  // Evento: Confirmar cobro y liberar mesa (desde Mostrador/Caja)
  socket.on('close-table', ({ tableId: rawTableId }) => {
    if (!socket.data.roles?.has('counter')) return;
    const tableId = String(rawTableId);
    const tableIndex = tables.findIndex(t => t.id === tableId);
    if (tableIndex !== -1) {
      // Marcar los pedidos de esa mesa como entregados y archivados (mesa cobrada),
      // sellando el momento del cobro (closedAt) para la "Caja del Día". Los pedidos
      // cancelados no se tocan: nunca se cobraron, no pueden "resucitar" a entregado
      // ni contar como venta (antes este forEach los pisaba, inflando la caja).
      const closedAt = new Date().toISOString();
      const closedOrders = [];
      orders.forEach(o => {
        if (o.tableId === tableId && o.status !== 'cancelado') {
          o.status = 'entregado';
          o.archived = true;
          o.closedAt = closedAt;
          closedOrders.push(o);
        }
      });

      // Resetear mesa a valores iniciales. El token se conserva: el QR impreso en la
      // mesa tiene que seguir sirviendo para los próximos clientes. Si el Mostrador
      // pidió bloquearla mientras tenía clientes (o se cerró el día), se bloquea ahora.
      const previous = tables[tableIndex];
      tables[tableIndex] = {
        id: tableId,
        status: 'libre',
        currentOrderId: null,
        paymentMethod: null,
        total: 0,
        qrToken: previous.qrToken,
        enabled: previous.enabled && !previous.blockOnClose,
        blockOnClose: false
      };
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
    }
  });

  // --- CRUD DEL MENÚ (desde Mostrador) ---
  // Por sockets y no por HTTP a propósito: la guarda roles.has('counter') es la misma
  // que protege close-table/add-table (requireStaffAuth no alcanza: aceptaría también
  // el token de cocina, que no tiene por qué poder tocar precios). Tras cada mutación
  // se persiste en SQLite y se emite menu-updated a TODOS los conectados (los clientes
  // en las mesas actualizan catálogo y carrito en vivo, sin recargar).

  // Evento: Agregar un producto al menú
  socket.on('menu-add', (data = {}) => {
    if (!socket.data.roles?.has('counter')) return;
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
  socket.on('menu-update', (data = {}) => {
    if (!socket.data.roles?.has('counter')) return;
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
  // conserva los items ya pedidos aunque el producto ya no exista (sanitizeEditItems).
  socket.on('menu-delete', ({ id } = {}) => {
    if (!socket.data.roles?.has('counter')) return;
    if (!menuCache.some(m => m.id === id)) return;

    menuCache = menuCache.filter(m => m.id !== id);
    deleteMenuItem(id);
    io.emit('menu-updated', menuCache);
  });

  // Evento: Cerrar la caja (desde Mostrador). Registra un cierre en el histórico con
  // lo cobrado desde el cierre anterior y la caja arranca de nuevo en $0. No exige
  // mesas libres: lo que se cobre después del cierre cuenta para la caja siguiente,
  // así una mesa que se queda hasta tarde no bloquea el arqueo del turno.
  socket.on('close-register', () => {
    if (!socket.data.roles?.has('counter')) return;
    const closure = closeRegister();
    io.to('counter').emit('register-closed', closure);
    io.to('counter').emit('daily-sales-updated', getDailySalesTotal());
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Servidor de la cafetería corriendo en http://localhost:${PORT}`);
});
