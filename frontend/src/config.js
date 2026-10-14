// URL del backend (HTTP y WebSocket). En el build de producción el backend sirve el
// frontend, así que es el mismo origen de la página. En desarrollo se deriva del host
// desde el que se cargó Vite: si un celular entra por http://192.168.1.50:5173/?view=client&table=3,
// se conecta solo a http://192.168.1.50:3001 sin hardcodear IPs — clave para que
// los QR funcionen en la red local del salón, no solo en la máquina de desarrollo.
// VITE_BACKEND_URL permite sobreescribirla cuando el backend vive en otro dominio.
export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : window.location.origin);

// Link que va en el QR de una mesa. El token (t) es el secreto de la mesa: sin él el
// server no deja unirse a la mesa ni pedir a su nombre.
export const tableClientUrl = (tableId, qrToken) =>
  `?view=client&table=${encodeURIComponent(tableId)}&t=${encodeURIComponent(qrToken)}`;

// URL de una imagen guardada en el server (foto de producto o logo). Las rutas que da el
// server son relativas (/api/images/...): en desarrollo el backend está en otro puerto.
export const imageUrl = (imageId) => (imageId ? `${BACKEND_URL}/api/images/${encodeURIComponent(imageId)}` : null);
export const absoluteBackendUrl = (path) => (path ? `${BACKEND_URL}${path}` : null);
