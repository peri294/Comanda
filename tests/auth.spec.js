import { test, expect } from '@playwright/test';
import { BACKEND, login, connectStaff, fetchState, settle } from './helpers.js';

// El freno de intentos fallidos no se prueba acá: bloquearía el login desde localhost
// para todos los specs que corren en paralelo. Lo cubre backend/auth.test.js.

test('logout revoca el token en el server y corta las pantallas conectadas con él', async () => {
  const { socket, token } = await connectStaff('counter', 'mostrador123');
  expect((await fetch(`${BACKEND}/api/initial-state`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  await settle(); // que el join se procese antes del logout

  const expelled = new Promise(resolve => socket.once('auth-error', resolve));
  await fetch(`${BACKEND}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  expect(await expelled).toEqual({ role: 'counter' });

  // El token ya no sirve por HTTP ni por socket (antes una copia seguía vigente)
  expect((await fetch(`${BACKEND}/api/initial-state`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  socket.emit('add-table', { id: '38' });
  await settle();
  const other = await login('counter', 'mostrador123');
  expect((await fetchState(other)).tables.some(t => t.id === '38')).toBe(false);

  socket.close();
});

test('contraseña incorrecta: 401 sin token', async () => {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'kitchen', password: 'cocina12' })
  });
  expect(res.status).toBe(401);
  expect((await res.json()).token).toBeUndefined();
});
