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

// --- ENDPOINTS HTTP ---

// Obtener menú
app.get('/api/menu', (req, res) => {
  res.json(MENU);
});

// Obtener estado inicial de mesas y pedidos activos
app.get('/api/initial-state', (req, res) => {
  res.json({
    tables,
    orders: orders.filter(o => o.status !== 'entregado')
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
      socket.emit('table-state', tables.find(t => t.id === tableId));
    }
  });

  // Evento: Nuevo pedido
  socket.on('new-order', (orderData) => {
    const { tableId, items, notes } = orderData;
    
    // Calcular total del pedido
    const orderTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    const newOrder = {
      id: `ord-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      tableId,
      items,
      notes: notes || '',
      status: 'pendiente',
      createdAt: new Date().toISOString()
    };
    
    orders.push(newOrder);
    
    // Actualizar estado de la mesa
    const tableIndex = tables.findIndex(t => t.id === tableId);
    if (tableIndex !== -1) {
      tables[tableIndex].status = 'pedido_pendiente';
      tables[tableIndex].currentOrderId = newOrder.id;
      tables[tableIndex].total += orderTotal;
    }
    
    // Notificar a cocina, mostrador y a la mesa correspondiente
    io.to('kitchen').emit('order-received', newOrder);
    io.to('counter').emit('tables-updated', tables);
    io.to('counter').emit('order-received-counter', newOrder);
    io.to(`table-${tableId}`).emit('table-state', tables[tableIndex]);
    io.to(`table-${tableId}`).emit('order-status-changed', newOrder);
  });

  // Evento: Actualizar estado del pedido (desde Cocina)
  socket.on('update-order-status', ({ orderId, status }) => {
    const orderIndex = orders.findIndex(o => o.id === orderId);
    if (orderIndex !== -1) {
      orders[orderIndex].status = status;
      const order = orders[orderIndex];
      
      // Si el pedido se entrega, actualizamos el estado de la mesa a 'comiendo'
      const tableIndex = tables.findIndex(t => t.id === order.tableId);
      if (tableIndex !== -1) {
        if (status === 'en_preparacion') {
          tables[tableIndex].status = 'pedido_pendiente'; // Sigue pendiente/preparando
        } else if (status === 'listo') {
          // El pedido está listo para retirar/llevar
        } else if (status === 'entregado') {
          tables[tableIndex].status = 'comiendo';
        }
      }
      
      // Notificar a todos los canales relevantes
      io.to('kitchen').emit('orders-updated', orders.filter(o => o.status !== 'entregado'));
      io.to('counter').emit('tables-updated', tables);
      io.to(`table-${order.tableId}`).emit('order-status-changed', order);
      if (tableIndex !== -1) {
        io.to(`table-${order.tableId}`).emit('table-state', tables[tableIndex]);
      }
    }
  });

  // Evento: Solicitar cierre de cuenta (desde Cliente)
  socket.on('request-bill', ({ tableId, paymentMethod }) => {
    const tableIndex = tables.findIndex(t => t.id === tableId);
    if (tableIndex !== -1) {
      const nextStatus = paymentMethod === 'efectivo' ? 'esperando_cuenta' : 'pagando_tarjeta';
      tables[tableIndex].status = nextStatus;
      tables[tableIndex].paymentMethod = paymentMethod;
      
      // Notificar a mostrador y al cliente de la mesa
      io.to('counter').emit('tables-updated', tables);
      io.to('counter').emit('bill-requested', { tableId, paymentMethod, total: tables[tableIndex].total });
      io.to(`table-${tableId}`).emit('table-state', tables[tableIndex]);
    }
  });

  // Evento: Confirmar cobro y liberar mesa (desde Mostrador/Caja)
  socket.on('close-table', ({ tableId }) => {
    const tableIndex = tables.findIndex(t => t.id === tableId);
    if (tableIndex !== -1) {
      // Marcar todos los pedidos de esa mesa como entregados/archivados
      orders.forEach(o => {
        if (o.tableId === tableId) {
          o.status = 'entregado';
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
      io.to('counter').emit('tables-updated', tables);
      io.to('kitchen').emit('orders-updated', orders.filter(o => o.status !== 'entregado'));
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
