// URL del backend (HTTP y WebSocket). Se deriva del host desde el que se cargó la
// página: si un celular entra por http://192.168.1.50:5173/?view=client&table=3,
// se conecta solo a http://192.168.1.50:3001 sin hardcodear IPs — clave para que
// los QR funcionen en la red local del salón, no solo en la máquina de desarrollo.
// VITE_BACKEND_URL permite sobreescribirla cuando el backend no vive en el mismo
// host o puerto que el frontend (ej. un despliegue detrás de un proxy).
export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  `${window.location.protocol}//${window.location.hostname}:3001`;
