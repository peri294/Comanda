import { expect } from '@playwright/test';
import { io } from 'socket.io-client';

// E2E_BACKEND permite correr la suite contra otro backend (otro puerto y otra base), sin
// tocar el que se está usando a mano: la suite arranca con /api/test/reset, que la borra.
export const BACKEND = process.env.E2E_BACKEND || 'http://localhost:3001';

export const settle = () => new Promise(resolve => setTimeout(resolve, 300));

// Login de personal por HTTP: devuelve el token de sesión
export const login = async (role, password) => {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, password })
  });
  return (await res.json()).token;
};

// Socket crudo ya conectado
export const connect = async () => {
  const socket = io(BACKEND, { transports: ['websocket'] });
  await new Promise(resolve => socket.on('connect', resolve));
  return socket;
};

// Login + socket unido a ese rol (simula una tablet real de staff)
export const connectStaff = async (role, password) => {
  const token = await login(role, password);
  const socket = await connect();
  socket.emit('join', { role, token });
  return { socket, token };
};

export const fetchState = async (token) =>
  (await fetch(`${BACKEND}/api/initial-state`, { headers: { Authorization: `Bearer ${token}` } })).json();

// Manda un pedido desde un socket de mesa y devuelve el pedido creado por el server
export const placeOrder = async (client, productId) => {
  const created = new Promise(resolve => {
    const onChange = (order) => {
      if (order.status === 'pendiente' && order.items.some(i => i.productId === productId)) {
        client.off('order-status-changed', onChange);
        resolve(order);
      }
    };
    client.on('order-status-changed', onChange);
  });
  client.emit('new-order', { items: [{ productId, quantity: 1 }] });
  return created;
};

// Cada mesa tiene un token secreto en su QR (?table=X&t=<token>), y sin él el server no
// deja unirse a la mesa. Los tests lo leen del endpoint de demo, que solo existe fuera
// de producción (igual que /api/test/reset).
export const tableLink = async (tableId) => {
  const links = await (await fetch(`${BACKEND}/api/demo/table-links`)).json();
  return links.find(l => l.id === String(tableId));
};
export const tableToken = async (tableId) => (await tableLink(tableId))?.qrToken;
// Código de la visita en curso de la mesa (lo que el mozo le da a los clientes).
export const visitCode = async (tableId) => (await tableLink(tableId))?.visitCode;

// URL de la mesa con el código de la visita, como la arma el simulador del portal, para
// page.goto(). El QR impreso no lleva el código (c): ver visit-code.spec.js.
export const clientUrl = async (tableId) => {
  const { qrToken, visitCode: code } = await tableLink(tableId);
  return `/?view=client&table=${tableId}&t=${qrToken}&c=${code}`;
};

// Une un socket crudo a la mesa con su token y el código de la visita, como ClientView
export const joinTable = async (socket, tableId) => {
  const { qrToken, visitCode: code } = await tableLink(tableId);
  socket.emit('join', { role: `table-${tableId}`, token: qrToken, code });
};

// Agrega una mesa con número puntual y la habilita (las mesas nuevas nacen bloqueadas).
// Para specs que necesitan mesas propias: las 12 semilla y la 13 ya tienen dueño entre
// los specs que corren en paralelo. Usar 30 en adelante: con 2x, 5x o 6x chocarían con
// locators por substring como hasText: 'Mesa 2'.
export const addTable = async (counter, id) => {
  counter.socket.emit('add-table', { id });
  counter.socket.emit('set-table-enabled', { tableId: id, enabled: true });
  await expect.poll(async () => (await fetchState(counter.token)).tables.find(t => t.id === id)?.enabled).toBe(true);
};
