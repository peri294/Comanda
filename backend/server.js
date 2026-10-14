import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
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
  closeRegister,
  setOrderWritesFailing,
  getSettings,
  saveSettings,
  persistCategory,
  deleteCategory,
  saveImage,
  getImage,
  imageExists,
  deleteImage,
  deleteUnusedImages,
  getSalesReportData,
  backupTo
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
  closeOrders,
  sanitizeSettings,
  newCategoryId,
  sanitizeCategoryFields,
  canDeleteCategory,
  reorderCategories,
  newImageId,
  isImageId,
  decodeImageUpload,
  parseReportRange,
  buildSalesReport,
  newVisitCode,
  orderRateDecision,
  MAX_TABLES,
  MAX_MENU_ITEMS,
  MAX_CATEGORIES,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  buildProductImagePrompt
} from './domain.js';
import { passwordMatches, createSessionStore, createLoginThrottle, throttleKeyForIp } from './auth.js';
import { generateProductImage, resolveProvider, ImageAIError } from './imageAI.js';

// Seguro por defecto: lo que solo sirve para desarrollar (endpoints de test que borran
// la base, contraseñas por defecto, CORS abierto) existe únicamente con DEV_MODE=1, que
// setea `npm run dev` vía .env.development. Antes dependía de que el despliegue no se
// olvidara de NODE_ENV=production: sin esa variable, /api/test/reset quedaba público.
const DEV_MODE = process.env.DEV_MODE === '1';
// Demo pública del portfolio: expone los links de las mesas y las contraseñas en el
// portal, y vuelve el estado a fábrica cuando nadie la usa (ver DEMO_IDLE_MINUTES).
const DEMO_MODE = process.env.DEMO_MODE === '1';
// Lo que ve el frontend: en producción la raíz es la pantalla del personal; en demo y
// desarrollo, el simulador con los links de las mesas.
const APP_MODE = DEMO_MODE ? 'demo' : DEV_MODE ? 'dev' : 'production';

// Ajustes del local hasta que el Mostrador los cambie (ver la tabla settings).
const DEFAULT_SETTINGS = {
  business_name: DEMO_MODE || DEV_MODE ? 'Café Premium' : 'Mi Cafetería',
  logo_image_id: ''
};
const imageUrl = (id) => (id ? `/api/images/${id}` : null);
// Forma en que los ajustes viajan al frontend (camelCase, sin las claves de la base).
const publicSettings = () => {
  const settings = getSettings(DEFAULT_SETTINGS);
  return { businessName: settings.business_name, logoUrl: imageUrl(settings.logo_image_id) };
};

// --- AUTENTICACION DE PERSONAL ---

const MIN_PASSWORD_LENGTH = 12;
// Password compartida por rol (cocina/mostrador), pensada para una tablet compartida
// por todo el turno, no para trazabilidad por empleado. Fuera de desarrollo y del modo
// demo es obligatorio definirlas: no se arranca con las credenciales por defecto.
if (!DEV_MODE && !DEMO_MODE) {
  const { KITCHEN_PASSWORD, COUNTER_PASSWORD } = process.env;
  if (!KITCHEN_PASSWORD || !COUNTER_PASSWORD) {
    console.error('Faltan KITCHEN_PASSWORD y/o COUNTER_PASSWORD (obligatorias salvo DEV_MODE=1 o DEMO_MODE=1).');
    process.exit(1);
  }
  // El freno de login frena a una IP, no a un ataque repartido entre muchas: lo que
  // protege de verdad es que la contraseña no se pueda adivinar.
  if (KITCHEN_PASSWORD.length < MIN_PASSWORD_LENGTH || COUNTER_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    console.error(`KITCHEN_PASSWORD y COUNTER_PASSWORD tienen que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    process.exit(1);
  }
  // Con la misma contraseña, cualquiera de la cocina entra también al mostrador.
  if (KITCHEN_PASSWORD === COUNTER_PASSWORD) {
    console.error('KITCHEN_PASSWORD y COUNTER_PASSWORD tienen que ser distintas.');
    process.exit(1);
  }
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
app.disable('x-powered-by');

// Headers de seguridad para todo lo que sirve el server (el build del frontend incluido).
// La CSP permite solo lo que la app usa: sus propios scripts, estilos inline (React los
// usa en todos lados), las fuentes de Google que importa index.css, las imágenes propias
// y las de vista previa (data:/blob:) y el WebSocket al mismo server.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // El link de cada mesa lleva su token: que no viaje en el Referer a otros sitios.
  'Referrer-Policy': 'no-referrer',
  // Los navegadores lo ignoran por HTTP; detrás de HTTPS (Render) fija el HTTPS.
  'Strict-Transport-Security': 'max-age=15552000'
};
app.use((req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
});
// Detrás de un proxy (Render, Railway, Fly.io) todas las conexiones llegan desde la IP
// del proxy: sin esto, el freno de login trataría a todos los clientes como uno solo.
// TRUST_PROXY = cantidad de proxies delante del server (normalmente 1).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
// Content-Disposition expuesto: el frontend lee de ahí el nombre de la copia de seguridad.
if (CORS_ORIGIN) app.use(cors({ origin: CORS_ORIGIN, exposedHeaders: ['Content-Disposition'] }));
app.use(express.json());

// Sesiones de personal (ver auth.js): no vencen solas, se revocan con logout, desde el
// Mostrador (revoke-other-sessions) o al reiniciar el server.
// Tope de sesiones por rol (ver createSessionStore): 50 sobra para un local. En desarrollo
// es mucho más alto porque una corrida de los E2E abre decenas de sesiones, y con el tope
// real el server revocaba la de un spec que todavía la estaba usando.
const sessions = createSessionStore({ maxPerRole: DEV_MODE ? 1000 : 50 });

// Freno de fuerza bruta del login: 5 intentos fallidos por IP cada 15 minutos (las IPv6
// agrupadas por /64, ver throttleKeyForIp). Además, un tope por rol para un ataque
// repartido entre muchas IP: pasados 50 fallos en 15 minutos, ese rol no acepta logins
// hasta que vence la ventana. Las sesiones abiertas siguen funcionando.
const loginThrottle = createLoginThrottle({ maxFailures: 5, windowMs: 15 * 60_000 });
const roleLoginThrottle = createLoginThrottle({ maxFailures: 50, windowMs: 15 * 60_000 });

// Freno para el código de visita de las mesas: con 4 dígitos, sin límite se probarían los
// 10.000 en segundos. La clave es IP + mesa, no solo la IP: con la app en la nube, todos
// los clientes del WiFi del local salen con la misma IP pública, y un par de errores de
// tipeo en una mesa no puede bloquear a las demás. Con 10 intentos cada 15 minutos,
// probar todos los códigos de una mesa lleva días, y el código cambia en cada visita.
// No se limpia al acertar: alguien sentado en la mesa conoce el código vigente, y si
// acertar reiniciara el contador podría intercalarlo para seguir probando.
const newVisitCodeThrottle = () => createLoginThrottle({ maxFailures: 10, windowMs: 15 * 60_000 });
let visitCodeThrottle = newVisitCodeThrottle();
// Código de la visita anterior de cada mesa. Un celular que se quedó con ese código (lo
// tenía guardado de antes del cobro) no está adivinando: se le avisa que el código
// cambió y no cuenta como intento fallido. Solo en memoria: tras un reinicio, como mucho
// cuenta como un error más.
const previousVisitCodes = new Map();

const staffRoleOf = (token) => sessions.roleOf(token);

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

// Como requireStaffAuth, pero solo para un rol: la sesión de cocina no puede subir fotos
// ni ver reportes.
const requireRole = (role) => (req, res, next) =>
  requireStaffAuth(req, res, () => (req.staffRole === role ? next() : res.status(403).json({ error: 'Sin permiso' })));

const httpServer = createServer(app);
// maxHttpBufferSize: ningún evento legítimo pesa más de unos pocos KB (las fotos van por
// HTTP). El default de 1 MB dejaba mandar pedidos con decenas de miles de items.
const io = new Server(httpServer, {
  maxHttpBufferSize: 64 * 1024,
  ...(CORS_ORIGIN && {
    cors: {
      origin: CORS_ORIGIN,
      methods: ['GET', 'POST']
    }
  })
});

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

// Categorías de fábrica: las cuatro que el menú tuvo fijas hasta que pasaron a la base,
// con los mismos ids que usan los productos de DEFAULT_MENU.
const DEFAULT_CATEGORIES = [
  { id: 'bebidas_calientes', name: 'Café Caliente', icon: '☕' },
  { id: 'bebidas_frias', name: 'Fríos y Licuados', icon: '🍹' },
  { id: 'pasteleria', name: 'Pastelería', icon: '🍰' },
  { id: 'salado', name: 'Salado', icon: '🥪' }
].map((category, position) => ({ ...category, position }));

// Las lecturas y la lógica de negocio operan sobre estas estructuras en memoria;
// cada mutación se refleja en SQLite (write-through, ver db.js), así un restart
// del server ya no borra las mesas, pedidos ni cambios del menú.
const persistedState = loadState(initialTables(), DEFAULT_MENU, DEFAULT_CATEGORIES);
let tables = persistedState.tables;
// Mesas de una base anterior a los tokens de QR o al código de visita: se les genera
// lo que les falte al arrancar.
tables.filter(t => !t.qrToken || !t.visitCode).forEach(t => {
  t.qrToken ||= newQrToken();
  t.visitCode ||= newVisitCode();
  persistTable(t);
});
let orders = persistedState.orders;
let menuCache = persistedState.menu;
let categoriesCache = persistedState.categories;
// Fotos subidas que nunca se asignaron a un producto ni al logo.
deleteUnusedImages([...menuCache.map(m => m.imageId), getSettings(DEFAULT_SETTINGS).logo_image_id].filter(Boolean));

// Instantes de los pedidos recientes de cada mesa, para el freno de orderRateDecision.
// Solo en memoria: un reinicio a lo sumo deja pedir unos pocos más.
const recentOrdersByTable = new Map();

// Solicitudes de "Llamar al Mozo" activas, indexadas por mesa: { timestamp, resolved, resolvedAt }
// (las reglas de duplicados y cooldown están en assistanceDecision, ver domain.js).
let activeAssistanceRequests = persistedState.assistanceRequests;

// Los handlers mutan la memoria y después persisten: si la escritura falla, la
// transacción vuelve atrás pero la memoria ya cambió, y el server seguiría mostrando
// (y cobrando) un estado que la base no tiene. Como SQLite quedó en el último estado
// confirmado, se rehace la memoria desde ahí. Los avisos a las pantallas salen después
// de persistir, así que ninguna llegó a ver el estado descartado.
const reloadFromDb = () => {
  const state = loadState(initialTables(), DEFAULT_MENU, DEFAULT_CATEGORIES);
  tables = state.tables;
  orders = state.orders;
  menuCache = state.menu;
  categoriesCache = state.categories;
  activeAssistanceRequests = state.assistanceRequests;
};

// Los pedidos archivados (mesa cobrada o pedido cancelado) quedan en SQLite como
// historial y salen de la memoria apenas se persisten, igual que no se cargan al
// arrancar: si no, el array crecía con cada pedido del día.
const pruneArchivedOrders = () => {
  orders = orders.filter(o => !o.archived);
};

// Borra una imagen que dejó de usarse (foto reemplazada, producto borrado, logo
// cambiado), salvo que otro producto o el logo todavía la usen.
const releaseImage = (id) => {
  if (!id) return;
  if (menuCache.some(m => m.imageId === id)) return;
  if (getSettings(DEFAULT_SETTINGS).logo_image_id === id) return;
  deleteImage(id);
};

// --- HELPERS ---

const findTable = (tableId) => tables.find(t => t.id === tableId);

// Payload de un evento de socket como objeto. El default `= {}` de un parámetro
// desestructurado solo cubre undefined: con un emit(evento, null) el handler tiraba un
// TypeError que Socket.IO no atrapa, y cualquiera sin login tiraba abajo el server.
const payloadOf = (data) => (data !== null && typeof data === 'object' ? data : {});

// Mesa a la que está atada esta conexión (por un join con token válido), o null.
// Se revalida contra el token actual y contra la sala: si la mesa se dio de baja, su QR
// se regeneró o se cobró (kickTableClients), la conexión pierde el acceso aunque siga
// abierta, y para volver a pedir tiene que unirse de nuevo.
// También se revalida el código de visita: al cobrar la mesa cambia, y una conexión de la
// visita anterior no puede actuar sobre la siguiente.
const getSocketTable = (socket) => {
  const bound = socket.data.table;
  if (!bound || !socket.rooms.has(`table-${bound.id}`)) return null;
  const table = findTable(bound.id);
  return table && table.qrToken === bound.token && table.visitCode === bound.visitCode ? table : null;
};

// IP del cliente de un socket, para el freno del código de visita. Detrás de un proxy
// (TRUST_PROXY) la conexión llega desde el proxy y la IP real viene en X-Forwarded-For.
const socketIp = (socket) => {
  const forwarded = process.env.TRUST_PROXY && socket.handshake.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;
};

// --- SESIONES DE PERSONAL EN LOS SOCKETS ---

// La conexión se unió a la sala del rol con un token que sigue vigente.
const hasStaffRole = (socket, role) => {
  const token = socket.data.staffTokens?.[role];
  return Boolean(token) && staffRoleOf(token) === role;
};

// Saca a la conexión de la sala del rol (deja de recibir pedidos, mesas y caja) y le
// avisa: el frontend vuelve a la pantalla de login con el evento auth-error.
const expelFromRole = (socket, role) => {
  delete socket.data.staffTokens[role];
  socket.leave(role);
  socket.emit('auth-error', { role });
};

// Revisa todas las pantallas de personal conectadas y corta las que tienen el token
// revocado. Se llama después de revocar: una pantalla que solo mira (la de cocina casi
// no emite) seguiría recibiendo los pedidos hasta su próximo evento.
const expelStaleStaff = () => {
  for (const socket of io.of('/').sockets.values()) {
    for (const role of Object.keys(socket.data.staffTokens || {})) {
      if (!hasStaffRole(socket, role)) expelFromRole(socket, role);
    }
  }
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
  pruneArchivedOrders();

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

// Categorías del menú, en el orden en que se muestran.
app.get('/api/categories', (req, res) => {
  res.json(categoriesCache);
});

// Subida de una foto de producto o del logo (solo el mostrador). Llega como JSON con la
// imagen en base64, ya achicada por el navegador (ver resizeImage.js en el frontend);
// el límite propio de 400 KB cubre los 300 KB de imagen más el inflado del base64.
// Devuelve el id, que después se asigna con menu-add/menu-update o update-settings.
app.post('/api/images', requireRole('counter'), express.json({ limit: '400kb' }), (req, res) => {
  const image = decodeImageUpload(req.body);
  if (image.error) return res.status(400).json({ error: image.error });
  const id = newImageId();
  saveImage({ id, ...image });
  res.status(201).json({ id, url: imageUrl(id) });
});

// Generación de la foto de un producto con IA (solo el mostrador). Devuelve la imagen al
// navegador sin guardarla: el encargado la revisa y, si la acepta, se sube como cualquier
// foto (POST /api/images), así que las descartadas no dejan nada en la base.
// Freno de costo: hasta 30 imágenes por hora para todo el local (Gemini cobra por imagen
// y la cuota gratuita de Cloudflare es diaria).
const newImageAIThrottle = () => createLoginThrottle({ maxFailures: 30, windowMs: 60 * 60_000 });
let imageAIThrottle = newImageAIThrottle();
const IMAGE_AI_ERRORS = {
  not_configured: [503, 'No hay un servicio de imágenes con IA configurado.'],
  blocked: [422, 'El servicio no generó una imagen para este producto. Probá con otra descripción.'],
  quota_exceeded: [429, 'Se agotó la cuota del servicio de imágenes. Probá más tarde.'],
  provider_error: [502, 'El servicio de imágenes no respondió. Probá de nuevo en un rato.']
};
app.post('/api/images/generate', requireRole('counter'), async (req, res) => {
  const { name, description, category } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_PRODUCT_NAME_LENGTH) : '';
  if (!cleanName) return res.status(400).json({ error: 'Falta el nombre del producto' });

  const limit = imageAIThrottle.check('image-ai');
  if (!limit.allowed) {
    res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({ error: `Se alcanzó el tope de imágenes por hora. Probá de nuevo en ${Math.ceil(limit.retryAfterMs / 60_000)} min.` });
  }
  imageAIThrottle.fail('image-ai');

  const prompt = buildProductImagePrompt({
    name: cleanName,
    description: typeof description === 'string' ? description.slice(0, MAX_PRODUCT_DESCRIPTION_LENGTH) : '',
    categoryName: categoriesCache.find(c => c.id === category)?.name
  });
  try {
    res.json(await generateProductImage(prompt));
  } catch (err) {
    // Express 4 no atrapa los errores de un handler async: se responde acá.
    if (!(err instanceof ImageAIError)) {
      console.error('Error inesperado al generar una imagen:', err);
      return res.status(500).json({ error: 'Error interno' });
    }
    // Solo el motivo: el mensaje del proveedor puede traer datos de la cuenta.
    console.error(`Generación de imagen fallida: ${err.reason}`);
    const [status, message] = IMAGE_AI_ERRORS[err.reason] || IMAGE_AI_ERRORS.provider_error;
    res.status(status).json({ error: message, reason: err.reason });
  }
});

// Las imágenes no cambian nunca (una foto nueva es un id nuevo): se cachean para siempre.
app.get('/api/images/:id', (req, res) => {
  const image = isImageId(req.params.id) && getImage(req.params.id);
  if (!image) return res.status(404).end();
  res.set({ 'Content-Type': image.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.send(Buffer.from(image.data));
});

// Login de personal (cocina/mostrador). Devuelve un token de sesión que el frontend
// guarda en localStorage para no pedir contraseña en cada carga.
app.post('/api/auth/login', (req, res) => {
  const { role, password } = req.body || {};
  if (!Object.hasOwn(ROLE_PASSWORDS, role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }
  const ipKey = throttleKeyForIp(req.ip);
  const ipLimit = loginThrottle.check(ipKey);
  const roleLimit = roleLoginThrottle.check(role);
  const limit = !ipLimit.allowed ? ipLimit : roleLimit;
  if (!limit.allowed) {
    const retryAfterSec = Math.ceil(limit.retryAfterMs / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Probá de nuevo en ${Math.ceil(retryAfterSec / 60)} min.`
    });
  }
  if (!passwordMatches(password, ROLE_PASSWORDS[role])) {
    loginThrottle.fail(ipKey);
    roleLoginThrottle.fail(role);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  loginThrottle.succeed(ipKey);
  const token = sessions.create(role);
  // Si se llegó al tope de sesiones del rol, la más vieja se revocó: se corta su pantalla.
  expelStaleStaff();
  res.json({ token });
});

// Logout: revoca el token en el server (antes cerrar sesión solo lo borraba del
// navegador, y una copia del token seguía sirviendo) y corta en el acto las
// pantallas conectadas con él.
app.post('/api/auth/logout', (req, res) => {
  sessions.revoke((req.headers.authorization || '').replace('Bearer ', ''));
  expelStaleStaff();
  res.json({ ok: true });
});

// Obtener estado inicial de mesas y pedidos activos (requiere sesión de personal).
// Cocina recibe lo mismo que por la sala 'kitchen': solo los pedidos que tiene que
// preparar. Las mesas (con sus tokens de QR), la caja y los llamados al mozo son del mostrador.
app.get('/api/initial-state', requireStaffAuth, (req, res) => {
  if (req.staffRole === 'kitchen') {
    return res.json({ orders: orders.filter(isKitchenVisible) });
  }
  res.json({
    tables,
    // No incluye pedidos de mesas ya cerradas/cobradas. A diferencia del filtro de cocina,
    // esto SÍ incluye pedidos ya servidos pero aún no pagados, que el mostrador necesita
    // mostrar en el ticket.
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

// Reporte de ventas entre dos fechas locales incluidas (?from=AAAA-MM-DD&to=AAAA-MM-DD),
// solo para el mostrador. Los días son los de la zona horaria del server (variable TZ).
app.get('/api/reports', requireRole('counter'), (req, res) => {
  const range = parseReportRange(req.query.from, req.query.to);
  if (!range) return res.status(400).json({ error: 'Rango de fechas inválido' });
  const data = getSalesReportData(range.start.toISOString(), range.end.toISOString());
  res.json({ from: req.query.from, to: req.query.to, ...buildSalesReport({ days: range.days, ...data }) });
});

// Copia de seguridad de la base completa, para descargar desde Configuración (solo el
// mostrador). Se genera en una carpeta temporal y se borra después de enviarla.
app.get('/api/backup', requireRole('counter'), (req, res) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'comanda-backup-'));
  const file = path.join(dir, 'backup.db');
  try {
    backupTo(file);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const date = new Date().toISOString().slice(0, 10);
  res.download(file, `comanda-${date}.db`, () => rmSync(dir, { recursive: true, force: true }));
});

// Vuelve el estado (memoria y SQLite, incluido el historial de pedidos archivados) a
// como queda un primer arranque: mesas libres, sin pedidos ni llamados de asistencia y
// el menú de fábrica. No toca las sesiones de personal logueadas.
// keepQrTokens: las mesas conservan su token, así las pestañas abiertas siguen valiendo
// (el reset de la demo); si no, cada mesa nace con uno nuevo (el de los tests).
// enableTables: las mesas arrancan habilitadas en vez de bloqueadas.
const resetToSeed = ({ keepQrTokens = false, enableTables = false } = {}) => {
  const previous = new Map(tables.map(t => [t.id, t]));
  tables = initialTables();
  tables.forEach(t => {
    // La demo conserva token y código, así las pestañas abiertas siguen entrando.
    if (keepQrTokens && previous.has(t.id)) {
      t.qrToken = previous.get(t.id).qrToken;
      t.visitCode = previous.get(t.id).visitCode;
    }
    t.enabled = enableTables;
  });
  orders = [];
  menuCache = JSON.parse(JSON.stringify(DEFAULT_MENU));
  categoriesCache = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  activeAssistanceRequests.clear();
  resetState(tables, DEFAULT_MENU, DEFAULT_CATEGORIES);
};

// Conexión desde la misma máquina. Se mira el socket y no req.ip, que con TRUST_PROXY
// sale de un header que el cliente puede inventar.
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const loopbackOnly = (req, res, next) => (isLoopback(req) ? next() : res.status(403).json({ error: 'Solo desde este equipo' }));

// Solo para los tests E2E. Existe únicamente con DEV_MODE=1: borra la base sin pedir
// login, así que no puede quedar expuesto en un despliegue real (ni en la demo pública).
// Además solo responde a la misma máquina: un `npm run dev` en el WiFi del local no
// puede dejar que cualquier celular conectado borre la base.
if (DEV_MODE) {
  app.use('/api/test', loopbackOnly);
  app.post('/api/test/reset', (req, res) => {
    // Las conexiones atadas a mesas viejas pierden el acceso: cada reset genera tokens nuevos.
    // El menú también vuelve a la semilla: los specs de menú crean/borran productos
    // y los demás specs piden los productos por nombre esperando sus precios de fábrica.
    setOrderWritesFailing(false);
    // El spec del código de visita bloquea la IP local a propósito: una corrida nueva de
    // la suite tiene que arrancar sin ese bloqueo.
    visitCodeThrottle = newVisitCodeThrottle();
    previousVisitCodes.clear();
    recentOrdersByTable.clear();
    imageAIThrottle = newImageAIThrottle();
    // Las sesiones de corridas anteriores no le sirven a nadie: cada corrida arranca sin ellas.
    sessions.revokeAllExcept(null);
    expelStaleStaff();
    resetToSeed();
    res.json({ ok: true });
  });

  // Hace fallar (o vuelve a permitir) las escrituras de pedidos en SQLite, para probar
  // que el server se recupera de una escritura fallida (ver reloadFromDb).
  app.post('/api/test/order-writes', (req, res) => {
    setOrderWritesFailing(req.body?.failing === true);
    res.json({ ok: true });
  });
}

// Links con token de cada mesa para el simulador de QR del portal y para los tests
// E2E. Expone los tokens sin login, por eso solo existe en desarrollo y en la demo:
// en un despliegue real los links salen solo del Mostrador.
// En desarrollo (sin DEMO_MODE) también solo desde la misma máquina: los links llevan el
// token y el código de cada mesa.
if (DEV_MODE || DEMO_MODE) {
  app.get('/api/demo/table-links', DEMO_MODE ? (req, res, next) => next() : loopbackOnly, (req, res) => {
    res.json(tables.map(t => ({ id: t.id, qrToken: t.qrToken, visitCode: t.visitCode })));
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

// Configuración pública que el frontend necesita antes de cualquier login: el modo
// (decide qué muestra la raíz) y la identidad del local. En la demo suma las contraseñas
// del personal, que se muestran en el portal.
app.get('/api/config', (req, res) => {
  res.json({
    mode: APP_MODE,
    ...publicSettings(),
    // Hay un proveedor de imágenes con IA configurado (ver imageAI.js): el Mostrador
    // muestra el botón "Generar con IA" solo si es true.
    imageGeneration: Boolean(resolveProvider()),
    ...(DEMO_MODE && { credentials: ROLE_PASSWORDS, idleResetMinutes: DEMO_IDLE_MINUTES })
  });
});

// --- WEBSOCKETS (SOCKET.IO) ---

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  // Cualquier acción (no el join, que es solo mirar) cuenta como actividad de la demo.
  if (DEMO_MODE) socket.onAny((event) => { if (event !== 'join') markDemoActivity(); });

  // Todos los handlers pasan por acá. Un error (típicamente una escritura en SQLite que
  // falla) antes tiraba abajo el server, y si no lo hacía dejaba la memoria con cambios
  // que la base no tiene: se rehace la memoria desde la base (ver reloadFromDb) y, si el
  // evento esperaba respuesta, se le contesta que falló en vez de dejarlo esperando.
  const on = (event, handler) =>
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`Error en el evento ${event}; se recarga el estado desde la base:`, err);
        reloadFromDb();
        broadcastTables();
        broadcastOrders();
        const ack = args.at(-1);
        if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
      }
    });

  // Evento de personal: se ignora si esta conexión no se unió con ese rol (join con
  // token). El token se revalida en cada evento: si se revocó después del join, la
  // conexión pierde el rol (antes lo conservaba hasta reconectarse).
  // El payload llega siempre como objeto (ver payloadOf): un emit con null de una
  // pantalla de personal tiraba abajo el server igual que desde una mesa.
  const staffOn = (role, event, handler) =>
    on(event, (data) => {
      if (hasStaffRole(socket, role)) handler(payloadOf(data));
      else if (socket.data.staffTokens?.[role]) expelFromRole(socket, role);
    });

  // Unirse a un rol/canal específico. 'kitchen' y 'counter' son canales de personal
  // y requieren un token de sesión válido; 'table-X' requiere el token del QR de la mesa.
  on('join', (data) => {
    const { role, token, code } = payloadOf(data);
    if (typeof role !== 'string') return;

    if (role === 'kitchen' || role === 'counter') {
      if (staffRoleOf(token) !== role) {
        socket.emit('auth-error', { role });
        return;
      }
      socket.data.staffTokens = { ...socket.data.staffTokens, [role]: token };
      socket.join(role);
      console.log(`Socket ${socket.id} se unió al canal: ${role}`);
      // La pantalla pide su estado inicial recién con esta confirmación: si lo pidiera
      // en paralelo al join, un evento emitido entre la respuesta del estado y la entrada
      // a la sala (un pedido, un llamado al mozo) no le llegaba por ningún lado.
      socket.emit('staff-joined', { role });
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

      // Segundo paso: el código de la visita (ver newVisitCode en domain.js). Con el QR
      // válido pero sin código, el cliente pide que lo ingresen; no entra a la sala ni ve
      // los pedidos de la mesa. Un código errado cuenta para el freno (IP + mesa), salvo
      // que sea el de la visita anterior.
      if (code === undefined || code === null || code === '') {
        socket.emit('visit-code-required', { tableId });
        return;
      }
      if (code !== table.visitCode && code === previousVisitCodes.get(tableId)) {
        socket.emit('visit-code-required', { tableId, changed: true });
        return;
      }
      const throttleKey = `${throttleKeyForIp(socketIp(socket))}|${tableId}`;
      const limit = visitCodeThrottle.check(throttleKey);
      if (!limit.allowed) {
        socket.emit('visit-code-error', { retryAfterMs: limit.retryAfterMs });
        return;
      }
      if (code !== table.visitCode) {
        visitCodeThrottle.fail(throttleKey);
        const after = visitCodeThrottle.check(throttleKey);
        socket.emit('visit-code-error', after.allowed ? {} : { retryAfterMs: after.retryAfterMs });
        return;
      }

      // Una conexión atiende a una sola mesa: el simulador del portal puede cambiar de
      // mesa en la misma pestaña, y la mesa anterior no tiene que seguir recibiendo eventos.
      const previous = socket.data.table;
      if (previous && previous.id !== tableId) socket.leave(`table-${previous.id}`);
      // Los eventos del cliente (new-order, request-bill, request-assistance) usan esta
      // mesa y no el tableId que manda el navegador (ver getSocketTable).
      socket.data.table = { id: tableId, token, visitCode: code };
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
  on('new-order', (orderData, ack) => {
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

    const rate = orderRateDecision(recentOrdersByTable.get(tableId), Date.now());
    recentOrdersByTable.set(tableId, rate.recent);
    if (!rate.allowed) return reply({ ok: false, error: 'rate_limited', retryInMs: rate.retryInMs });

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
  on('request-bill', (data) => {
    const { paymentMethod } = payloadOf(data);
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
  on('request-assistance', () => {
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
    if (tables.length >= MAX_TABLES) return;
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

  // Evento: Nuevo código de visita para una mesa (desde Mostrador). Para cuando el código
  // se filtró o alguien que ya se fue lo sigue usando: los celulares conectados pierden el
  // acceso y tienen que ingresar el código nuevo. No toca el QR impreso.
  staffOn('counter', 'regenerate-visit-code', ({ tableId: rawTableId }) => {
    const table = findTable(String(rawTableId));
    if (!table) return;

    previousVisitCodes.set(table.id, table.visitCode);
    table.visitCode = newVisitCode();
    persistTable(table);

    broadcastTables();
    io.to(`table-${table.id}`).emit('visit-code-required', { tableId: table.id, changed: true });
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

    // Pedidos que cocina todavía tiene en pantalla: al cobrar se dan por entregados y
    // desaparecen de su monitor, así que se le avisa igual que con una cancelación (el
    // Mostrador ya lo confirmó antes de cobrar).
    const stillInKitchen = activeOrdersOf(tableId).filter(isKitchenVisible);
    // Solo los pedidos activos de la visita (ver closeOrders).
    const closedOrders = closeOrders(orders, tableId, new Date().toISOString());
    previousVisitCodes.set(tableId, tables[tableIndex].visitCode);
    tables[tableIndex] = closedTable(tables[tableIndex]);
    activeAssistanceRequests.delete(tableId);

    runInTransaction(() => {
      closedOrders.forEach(persistOrder);
      persistTable(tables[tableIndex]);
      deleteAssistance(tableId);
    });
    pruneArchivedOrders();

    // Notificar a mostrador, cocina y a la mesa correspondiente
    broadcastTables();
    broadcastOrders();
    stillInKitchen.forEach(order => io.to('kitchen').emit('order-modified', { order, reason: 'closed' }));
    // El server es la única fuente de la caja: todos los mostradores conectados
    // reciben el total real (dos pestañas abiertas no divergen por sumas locales).
    io.to('counter').emit('daily-sales-updated', getDailySalesTotal());
    // La visita terminó: se desconecta de la mesa a todos sus celulares. Si no, el que
    // deja la página abierta seguiría viendo en vivo los pedidos del grupo siguiente.
    // Para volver a pedir hay que escanear el QR de nuevo.
    io.to(`table-${tableId}`).emit('table-closed');
    kickTableClients(tableId);
  });

  // Evento: Cerrar todas las demás sesiones de personal (desde Mostrador). Para una
  // tablet perdida o alguien que dejó de trabajar: todas las pantallas de cocina y
  // mostrador vuelven al login, salvo la que lo pidió. Si la contraseña también se
  // filtró, hay que cambiarla (y reiniciar el server, que cierra todas las sesiones).
  staffOn('counter', 'revoke-other-sessions', () => {
    const revoked = sessions.revokeAllExcept(socket.data.staffTokens.counter);
    expelStaleStaff();
    socket.emit('other-sessions-revoked', { revoked });
  });

  // --- CRUD DEL MENÚ (desde Mostrador) ---
  // Por sockets y no por HTTP a propósito: la guarda de rol counter (staffOn) es la misma
  // que protege close-table/add-table (requireStaffAuth no alcanza: aceptaría también
  // el token de cocina, que no tiene por qué poder tocar precios). Tras cada mutación
  // se persiste en SQLite y se emite menu-updated a TODOS los conectados (los clientes
  // en las mesas actualizan catálogo y carrito en vivo, sin recargar).

  // Foto de un producto en un menu-add/menu-update: el id de una imagen ya subida, null
  // para sacarla, o lo que tenía si el formulario no la tocó.
  const imageIdFrom = (data, current = null) => {
    if (data.imageId === null) return null;
    if (isImageId(data.imageId) && imageExists(data.imageId)) return data.imageId;
    return current;
  };

  // Evento: Agregar un producto al menú
  staffOn('counter', 'menu-add', (data) => {
    if (menuCache.length >= MAX_MENU_ITEMS) return;
    const fields = sanitizeMenuFields(data, categoriesCache);
    if (!fields) return;

    const newItem = {
      id: `m-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      ...fields,
      imageId: imageIdFrom(data),
      available: true
    };
    menuCache.push(newItem);
    persistMenuItem(newItem);
    io.emit('menu-updated', menuCache);
  });

  // Evento: Editar un producto (datos y/o disponibilidad). El switch rápido de
  // "agotado" del mostrador usa este mismo evento con available invertido.
  staffOn('counter', 'menu-update', (data) => {
    const item = menuCache.find(m => m.id === data.id);
    if (!item) return;
    const fields = sanitizeMenuFields(data, categoriesCache);
    if (!fields) return;

    // Si el payload no trae available (edición de datos solamente), se conserva el
    // actual: que un formulario incompleto no "agote" un producto por accidente.
    const available = data.available === undefined ? item.available : Boolean(data.available);
    const previousImageId = item.imageId;
    Object.assign(item, fields, { available, imageId: imageIdFrom(data, item.imageId) });
    persistMenuItem(item);
    if (previousImageId !== item.imageId) releaseImage(previousImageId);
    io.emit('menu-updated', menuCache);
  });

  // Evento: Eliminar un producto del menú. No rompe nada retroactivamente: los
  // pedidos (activos y archivados) guardan snapshot de nombre/precio, y edit-order
  // conserva los items ya pedidos aunque el producto ya no exista (sanitizeItems).
  staffOn('counter', 'menu-delete', ({ id }) => {
    const item = menuCache.find(m => m.id === id);
    if (!item) return;

    menuCache = menuCache.filter(m => m.id !== id);
    deleteMenuItem(id);
    releaseImage(item.imageId);
    io.emit('menu-updated', menuCache);
  });

  // --- CATEGORÍAS DEL MENÚ (desde Mostrador) ---
  // Mismo esquema que el CRUD de productos: persistir y difundir a todos los conectados
  // (los filtros del menú del cliente cambian en vivo).
  const broadcastCategories = () => io.emit('categories-updated', categoriesCache);

  staffOn('counter', 'category-add', (data) => {
    if (categoriesCache.length >= MAX_CATEGORIES) return;
    const fields = sanitizeCategoryFields(data);
    if (!fields) return;
    const category = { id: newCategoryId(), ...fields, position: categoriesCache.length };
    categoriesCache.push(category);
    persistCategory(category);
    broadcastCategories();
  });

  staffOn('counter', 'category-update', (data) => {
    const category = categoriesCache.find(c => c.id === data.id);
    const fields = sanitizeCategoryFields(data);
    if (!category || !fields) return;
    Object.assign(category, fields);
    persistCategory(category);
    broadcastCategories();
  });

  // Una categoría con productos no se borra (ver canDeleteCategory).
  staffOn('counter', 'category-delete', ({ id }) => {
    if (!categoriesCache.some(c => c.id === id) || !canDeleteCategory(id, menuCache)) return;
    categoriesCache = categoriesCache.filter(c => c.id !== id);
    deleteCategory(id);
    broadcastCategories();
  });

  staffOn('counter', 'category-reorder', ({ ids }) => {
    const reordered = reorderCategories(ids, categoriesCache);
    if (!reordered) return;
    categoriesCache = reordered;
    runInTransaction(() => reordered.forEach(persistCategory));
    broadcastCategories();
  });

  // Evento: Cambiar la configuración del local (desde Mostrador). Todas las pantallas,
  // mesas incluidas, actualizan el nombre en vivo.
  staffOn('counter', 'update-settings', (data) => {
    const settings = sanitizeSettings(data);
    if (!settings) return;
    // El logo tiene que ser una imagen que exista (subida antes por /api/images).
    if (settings.logo_image_id && !imageExists(settings.logo_image_id)) delete settings.logo_image_id;
    if (Object.keys(settings).length === 0) return;
    const previousLogo = getSettings(DEFAULT_SETTINGS).logo_image_id;
    saveSettings(settings);
    if ('logo_image_id' in settings && settings.logo_image_id !== previousLogo) releaseImage(previousLogo);
    io.emit('settings-updated', publicSettings());
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

  on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// El build del frontend (npm run build) se sirve desde el mismo server: en producción
// queda todo en un solo servicio y un solo origen. En desarrollo lo sirve Vite.
const FRONTEND_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'dist');
if (existsSync(FRONTEND_DIST)) app.use(express.static(FRONTEND_DIST));

// Errores de Express (JSON malformado, un error en un endpoint): respuesta corta, sin el
// stack ni las rutas del server, que el handler por defecto muestra si NODE_ENV no es
// production (este proyecto no la usa, ver DEV_MODE).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Demasiado grande' });
  console.error('Error en', req.method, req.path, err);
  res.status(err.status || 500).json({ error: 'Error interno' });
});

if (DEMO_MODE) {
  // Cada visitante llega a una demo limpia y con las mesas habilitadas.
  resetDemo();
  setInterval(() => {
    const idleMs = Date.now() - lastDemoActivityAt;
    if (lastDemoActivityAt > lastDemoResetAt && idleMs > DEMO_IDLE_MINUTES * 60_000) resetDemo();
  }, 60_000).unref();
}

// Limpieza de las ventanas vencidas de los frenos, para que no crezcan sin límite.
setInterval(() => {
  loginThrottle.sweep();
  roleLoginThrottle.sweep();
  visitCodeThrottle.sweep();
}, 60_000).unref();

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Servidor de la cafetería corriendo en http://localhost:${PORT}`);
});
