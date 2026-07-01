import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';

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

// Tokens de sesión válidos por rol. En memoria, igual que el resto del estado:
// se pierden si el server se reinicia (obliga a un nuevo login, no es un bug).
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

// --- BASE DE DATOS EN MEMORIA ---

// Generar 12 mesas
const INITIAL_TABLES = Array.from({ length: 12 }, (_, i) => ({
  id: String(i + 1),
  status: 'libre', // 'libre' | 'pedido_pendiente' | 'comiendo' | 'esperando_cuenta' | 'pagando_tarjeta'
  currentOrderId: null,
  paymentMethod: null,
  total: 0
}));

let tables = JSON.parse(JSON.stringify(INITIAL_TABLES));
let orders = [];

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
    orders: orders.filter(o => !o.archived)
  });
});

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
      socket.emit('table-state', findTable(tableId));
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

    broadcastOrders();
    broadcastTables();
    io.to(`table-${order.tableId}`).emit('order-status-changed', order);
  });
  // Evento: Nuevo pedido
  socket.on('new-order', (orderData) => {
    // El tableId puede llegar como número o string según cómo navegó el cliente en el frontend;
    // se normaliza a string porque tables[].id siempre es string.
    const tableId = String(orderData.tableId);
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
    const table = findTable(tableId);
    if (table) {
      table.status = 'pedido_pendiente';
      table.currentOrderId = newOrder.id;
      table.total += orderTotal;
      if (paymentMethod) table.paymentMethod = paymentMethod;
    }

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

    // Notificar a mostrador y al cliente de la mesa
    broadcastTables();
    io.to('counter').emit('bill-requested', { tableId, paymentMethod, total: table.total });
    io.to(`table-${tableId}`).emit('table-state', table);
  });

  // Evento: Confirmar cobro y liberar mesa (desde Mostrador/Caja)
  socket.on('close-table', ({ tableId: rawTableId }) => {
    if (!socket.data.roles?.has('counter')) return;
    const tableId = String(rawTableId);
    const tableIndex = tables.findIndex(t => t.id === tableId);
    if (tableIndex !== -1) {
      // Marcar todos los pedidos de esa mesa como entregados y archivados (mesa cobrada)
      orders.forEach(o => {
        if (o.tableId === tableId) {
          o.status = 'entregado';
          o.archived = true;
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

      // Notificar a mostrador, cocina y a la mesa correspondiente
      broadcastTables();
      broadcastOrders();
      io.to(`table-${tableId}`).emit('table-closed');
      io.to(`table-${tableId}`).emit('table-state', tables[tableIndex]);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Servidor de la cafetería corriendo en http://localhost:${PORT}`);
});
