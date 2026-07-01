import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

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

// Recalcula el total de una mesa a partir de sus pedidos activos (no archivados).
const recomputeTableTotal = (tableId) => {
  const table = findTable(tableId);
  if (!table) return;
  table.total = orders
    .filter(o => o.tableId === tableId && !o.archived)
    .reduce((acc, o) => acc + o.items.reduce((sum, item) => sum + item.price * item.quantity, 0), 0);
};

// Cocina solo necesita ver pedidos aún no entregados; el mostrador necesita ver todo
// lo consumido hasta que la mesa se cobra, aunque cocina ya lo haya servido.
const broadcastOrders = () => {
  io.to('kitchen').emit('orders-updated', orders.filter(o => o.status !== 'entregado'));
  io.to('counter').emit('orders-updated', orders.filter(o => !o.archived));
};

const broadcastTables = () => io.to('counter').emit('tables-updated', tables);

// --- ENDPOINTS HTTP ---

// Obtener menú
app.get('/api/menu', (req, res) => {
  res.json(MENU);
});

// Obtener estado inicial de mesas y pedidos activos
app.get('/api/initial-state', (req, res) => {
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

  // Unirse a un rol/canal específico
  socket.on('join', (role) => {
    socket.join(role);
    console.log(`Socket ${socket.id} se unió al canal: ${role}`);
    
    // Si es un cliente de mesa, también se une a su canal específico de mesa
    if (role.startsWith('table-')) {
      const tableId = role.replace('table-', '');
      socket.emit('table-state', findTable(tableId));
    }
  });

  // Evento: Agregar items a un pedido existente (mientras no fue entregado/archivado)
  socket.on('update-order', ({ orderId, items, notes, paymentMethod }) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    // Combinar items
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
    const { items, notes, paymentMethod } = orderData;

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
