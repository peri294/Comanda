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

const isStaffToken = (token) => validTokens.kitchen.has(token) || validTokens.counter.has(token);

// Exige un token de staff (cocina o mostrador) vía header "Authorization: Bearer <token>"
const requireStaffAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!isStaffToken(token)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
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

// Semilla del primer arranque: 12 mesas libres
const INITIAL_TABLES = Array.from({ length: 12 }, (_, i) => ({
  id: String(i + 1),
  status: 'libre', // 'libre' | 'pedido_pendiente' | 'comiendo' | 'esperando_cuenta' | 'pagando_tarjeta'
  currentOrderId: null,
  paymentMethod: null,
  total: 0
}));

// Las lecturas y la lógica de negocio operan sobre estas estructuras en memoria;
// cada mutación se refleja en SQLite (write-through, ver db.js), así un restart
// del server ya no borra las mesas y pedidos en curso.
const persistedState = loadState(INITIAL_TABLES);
let tables = persistedState.tables;
let orders = persistedState.orders;

// Solicitudes de "Llamar al Mozo" activas, indexadas por mesa: { timestamp, resolved, resolvedAt }.
// Mientras sigue sin atender, se bloquea cualquier duplicado sin importar el tiempo transcurrido.
// Una vez atendida, solo se aplica un cooldown corto (medido desde que se resolvió, no desde el
// pedido original) para evitar un doble-click accidental, sin bloquear un pedido de ayuda legítimo.
const activeAssistanceRequests = persistedState.assistanceRequests;
const ASSISTANCE_REOPEN_COOLDOWN_MS = 10_000;

// Menú de la cafetería
const MENU = [
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
];

// --- HELPERS ---

const findTable = (tableId) => tables.find(t => t.id === tableId);
const getMenuItem = (productId) => MENU.find(m => m.id === productId);

// Nunca confiar en precio/nombre que manda el cliente: siempre se recalculan contra
// el MENU del servidor, así nadie puede pedir gratis (o más caro) manipulando el payload.
// También descarta productos inexistentes y cantidades inválidas.
const sanitizeItems = (items) => {
  if (!Array.isArray(items)) return [];
  return items.reduce((acc, item) => {
    const menuItem = getMenuItem(item?.productId);
    const quantity = Math.floor(Number(item?.quantity));
    if (menuItem && Number.isFinite(quantity) && quantity > 0) {
      acc.push({ productId: menuItem.id, name: menuItem.name, price: menuItem.price, quantity });
    }
    return acc;
  }, []);
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
  } else if (table.currentOrderId && !activeOrders.find(o => o.id === table.currentOrderId)) {
    // El pedido "actual" de la mesa se canceló, pero quedan otros: apuntar al más reciente.
    table.currentOrderId = activeOrders[activeOrders.length - 1].id;
  }
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

// --- ENDPOINTS HTTP ---

// Obtener menú
app.get('/api/menu', (req, res) => {
  res.json(MENU);
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
    tables,
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
    tables = JSON.parse(JSON.stringify(INITIAL_TABLES));
    orders = [];
    activeAssistanceRequests.clear();
    resetState(INITIAL_TABLES);
    res.json({ ok: true });
  });
}

// --- WEBSOCKETS (SOCKET.IO) ---

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // Unirse a un rol/canal específico. 'kitchen' y 'counter' son canales de personal
  // y requieren un token de sesión válido; 'table-X' es público (lo usa el cliente).
  socket.on('join', ({ role, token } = {}) => {
    if (!role) return;

    if (role === 'kitchen' || role === 'counter') {
      if (!validTokens[role].has(token)) {
        socket.emit('auth-error', { role });
        return;
      }
      socket.data.roles = socket.data.roles || new Set();
      socket.data.roles.add(role);
    }

    socket.join(role);
    console.log(`Socket ${socket.id} se unió al canal: ${role}`);

    // Si es un cliente de mesa, también se une a su canal específico de mesa
    if (role.startsWith('table-')) {
      const tableId = role.replace('table-', '');
      // null explícito si la mesa no existe (QR viejo de una mesa dada de baja):
      // el cliente lo usa para mostrar "mesa no disponible" en vez de quedarse mudo.
      socket.emit('table-state', findTable(tableId) || null);
      // Hidratar todos los pedidos activos de la mesa (no solo el último), para que el
      // cliente pueda armar "Mi Cuenta Parcial" aunque recién esté entrando/recargando
      // la página con pedidos ya en curso. Reutiliza el mismo evento que usan las
      // actualizaciones en vivo, así el cliente no necesita un handler distinto.
      orders
        .filter(o => o.tableId === tableId && !o.archived)
        .forEach(o => socket.emit('order-status-changed', o));
    }
  });

  // Evento: Agregar items a un pedido existente (mientras no fue entregado/archivado)
  socket.on('update-order', ({ orderId, items: rawItems, notes, paymentMethod }) => {
    const order = orders.find(o => o.id === orderId);
    if (!order || order.archived) return;

    // Combinar items
    const items = sanitizeItems(rawItems);
    items.forEach(newItem => {
      const existingItem = order.items.find(i => i.productId === newItem.productId);
      if (existingItem) {
        existingItem.quantity += newItem.quantity;
      } else {
        order.items.push(newItem);
      }
    });
    if (notes) order.notes = notes;

    recomputeTableTotal(order.tableId);
    const table = findTable(order.tableId);
    if (table && paymentMethod) table.paymentMethod = paymentMethod;

    runInTransaction(() => {
      persistOrder(order);
      if (table) persistTable(table);
    });

    broadcastOrders();
    broadcastTables();
    io.to(`table-${order.tableId}`).emit('order-status-changed', order);
  });
  // Evento: Nuevo pedido
  socket.on('new-order', (orderData) => {
    // El tableId puede llegar como número o string según cómo navegó el cliente en el frontend;
    // se normaliza a string porque tables[].id siempre es string.
    const tableId = String(orderData.tableId);
    // La mesa tiene que existir: ahora que se pueden dar de baja mesas, un QR viejo
    // no puede generar pedidos huérfanos que cocina prepararía para nadie.
    const table = findTable(tableId);
    if (!table) return;

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

    // Actualizar estado de la mesa
    table.status = 'pedido_pendiente';
    table.currentOrderId = newOrder.id;
    table.total += orderTotal;
    if (paymentMethod) table.paymentMethod = paymentMethod;

    runInTransaction(() => {
      persistOrder(newOrder);
      persistTable(table);
    });

    // Notificar a cocina, mostrador y a la mesa correspondiente
    io.to('kitchen').emit('order-received', newOrder);
    io.to('counter').emit('order-received-counter', newOrder);
    broadcastTables();
    io.to(`table-${tableId}`).emit('table-state', table);
    io.to(`table-${tableId}`).emit('order-status-changed', newOrder);
  });

  // Evento: Actualizar estado del pedido (desde Cocina)
  socket.on('update-order-status', ({ orderId, status }) => {
    if (!socket.data.roles?.has('kitchen')) return;
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    order.status = status;

    // Si el pedido se entrega, actualizamos el estado de la mesa a 'comiendo'
    const table = findTable(order.tableId);
    if (table) {
      if (status === 'en_preparacion') table.status = 'pedido_pendiente'; // Sigue pendiente/preparando
      else if (status === 'entregado') table.status = 'comiendo';
    }

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

    const items = sanitizeItems(rawItems);
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
    io.to('kitchen').emit('order-modified', { order, reason: 'cancelled' });
  });

  // Evento: Solicitar cierre de cuenta (desde Cliente)
  socket.on('request-bill', ({ tableId: rawTableId, paymentMethod }) => {
    const tableId = String(rawTableId);
    const table = findTable(tableId);
    if (!table) return;

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
  socket.on('request-assistance', ({ tableId: rawTableId }) => {
    const tableId = String(rawTableId);
    if (!findTable(tableId)) return;

    const existing = activeAssistanceRequests.get(tableId);
    const now = Date.now();
    if (existing) {
      if (!existing.resolved) return;
      if (now - existing.resolvedAt < ASSISTANCE_REOPEN_COOLDOWN_MS) return;
    }

    const request = { timestamp: now, resolved: false, resolvedAt: null };
    activeAssistanceRequests.set(tableId, request);
    persistAssistance(tableId, request);
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
  // más chico sin usar: así reponer una mesa dada de baja reutiliza su QR ya impreso.
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

    const newTable = { id: tableId, status: 'libre', currentOrderId: null, paymentMethod: null, total: 0 };
    tables.push(newTable);
    tables.sort((a, b) => Number(a.id) - Number(b.id));
    persistTable(newTable);

    broadcastTables();
    // Si alguien ya estaba mirando el QR de ese número, su mesa "revive" al instante.
    io.to(`table-${tableId}`).emit('table-state', newTable);
  });

  // Evento: Quitar una mesa (desde Mostrador). Puede quitarse cualquiera —las demás
  // conservan su número, clave porque los QR impresos apuntan a ?table=X— pero solo si
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

      // Resetear mesa a valores iniciales
      tables[tableIndex] = {
        id: tableId,
        status: 'libre',
        currentOrderId: null,
        paymentMethod: null,
        total: 0
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
      io.to(`table-${tableId}`).emit('table-closed');
      io.to(`table-${tableId}`).emit('table-state', tables[tableIndex]);
    }
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
