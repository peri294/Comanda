import { BACKEND, login, connect } from './helpers.js';

// Corre una sola vez antes de toda la suite (no por test) para no generar la misma
// condición de carrera que se busca evitar: si el reset corriera en el beforeEach de
// cada test, dos tests en paralelo podrían pisarse el pedido a mitad de camino.
export default async function globalSetup() {
  const res = await fetch(`${BACKEND}/api/test/reset`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(
      `No se pudo resetear el backend antes de los tests (¿está corriendo en :3001?). Status: ${res.status}`
    );
  }

  // Las mesas nacen bloqueadas: se inicia el día como lo haría el Mostrador.
  const token = await login('counter', 'mostrador123');
  const socket = await connect();
  const started = new Promise(resolve => socket.once('tables-updated', resolve));
  socket.emit('join', { role: 'counter', token });
  socket.emit('start-day');
  const tables = await started;
  socket.close();
  if (!tables.every(t => t.enabled)) {
    throw new Error('No se pudo iniciar el día antes de los tests');
  }
}
