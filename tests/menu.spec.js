import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';

const BACKEND = 'http://localhost:3001';

// Login de personal por HTTP + socket crudo unido a ese rol (simula una tablet real
// de staff, o un atacante que consiguió esa contraseña pero no la del otro rol).
async function connectStaffSocket(role, password) {
  const res = await fetch(`${BACKEND}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, password })
  });
  const { token } = await res.json();
  const socket = io(BACKEND, { transports: ['websocket'] });
  await new Promise(resolve => socket.on('connect', resolve));
  socket.emit('join', { role, token });
  return socket;
}

const fetchMenu = async () => (await fetch(`${BACKEND}/api/menu`)).json();

// Un solo test secuencial (no varios test() que con fullyParallel correrían a la vez):
// todas las etapas comparten el menú, que es estado global del sistema. Solo se toca
// el producto propio ("Café de Especialidad") para no pisar los specs paralelos, que
// piden Espresso/Cappuccino por nombre y esperan sus precios de fábrica.
test('menú administrable: CRUD, stock en vivo y seguridad', async ({ browser }) => {
  const counterPage = await (await browser.newContext()).newPage();
  const clientPage = await (await browser.newContext()).newPage();

  await counterPage.goto('/?view=counter');
  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();

  // Cliente en Mesa 4 (las demás suites usan 1, 2, 3 y 13)
  await clientPage.goto('/?view=client&table=4');
  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });

  // 1. ALTA DE PRODUCTO DESDE EL MOSTRADOR
  await counterPage.getByRole('button', { name: /administrar menú/i }).click();
  await counterPage.getByPlaceholder('Nombre del producto').fill('Café de Especialidad');
  await counterPage.getByPlaceholder('Descripción').fill('Filtrado de origen único.');
  await counterPage.getByPlaceholder('Precio').fill('3200');
  await counterPage.getByRole('button', { name: /agregar producto/i }).click();

  const adminRow = counterPage.locator('.menu-admin-row', { hasText: 'Café de Especialidad' });
  await expect(adminRow).toBeVisible({ timeout: 10000 });
  await expect(adminRow.getByText('$3200')).toBeVisible();

  // El cliente lo ve EN VIVO, sin recargar la página
  const clientCard = clientPage.locator('.menu-card', { hasText: 'Café de Especialidad' });
  await expect(clientCard).toBeVisible({ timeout: 10000 });
  await expect(clientCard.getByText('$3200')).toBeVisible();

  // 2. EDICIÓN DE PRECIO, REFLEJADA EN VIVO EN EL CLIENTE
  await adminRow.getByTitle('Editar Café de Especialidad').click();
  await counterPage.getByPlaceholder('Precio').fill('3600');
  await counterPage.getByRole('button', { name: /guardar cambios/i }).click();
  await expect(clientCard.getByText('$3600')).toBeVisible({ timeout: 10000 });

  // 3. CARRITO REACTIVO + AGOTADO
  // El cliente lo agrega al carrito; el mostrador lo marca agotado: el catálogo lo
  // deshabilita y el carrito se vacía solo (el botón flotante desaparece), para que
  // el cliente no intente enviar un pedido que el server rechazaría en silencio.
  await clientCard.getByRole('button', { name: /agregar/i }).click();
  await expect(clientPage.locator('.cart-float-btn')).toBeVisible();

  await adminRow.getByTitle('Marcar como agotado').click();

  await expect(clientCard.getByRole('button', { name: /agotado/i })).toBeDisabled({ timeout: 10000 });
  await expect(clientPage.locator('.cart-float-btn')).toHaveCount(0, { timeout: 10000 });

  // 4. ATAQUE POR SOCKET CRUDO: pedir el producto agotado directo al server.
  // sanitizeItems() debe descartarlo; como es el único item, no se crea ningún
  // pedido y la mesa objetivo (5, no usada por otros specs) queda intacta.
  const menuNow = await fetchMenu();
  const cafe = menuNow.find(m => m.name === 'Café de Especialidad');
  expect(cafe.available).toBe(false);

  const attacker = io(BACKEND, { transports: ['websocket'] });
  await new Promise(resolve => attacker.on('connect', resolve));
  attacker.emit('new-order', { tableId: '5', items: [{ productId: cafe.id, quantity: 3, price: 1 }] });
  await counterPage.waitForTimeout(1500);
  const mesa5 = counterPage.locator('.table-card', { hasText: 'Mesa 5' });
  await expect(mesa5.getByText('Mesa vacía')).toBeVisible();
  attacker.disconnect();

  // 5. BYPASS DE ROL: una sesión de COCINA (token válido, rol equivocado) intenta
  // borrar el producto. El server debe ignorarla: el CRUD del menú es solo de mostrador.
  const kitchenSocket = await connectStaffSocket('kitchen', 'cocina123');
  kitchenSocket.emit('menu-delete', { id: cafe.id });
  await counterPage.waitForTimeout(1000);
  const menuAfterKitchen = await fetchMenu();
  expect(menuAfterKitchen.some(m => m.id === cafe.id)).toBe(true);
  kitchenSocket.disconnect();

  // 6. INPUTS INVÁLIDOS CON ROL VÁLIDO: ni un precio negativo ni una categoría
  // inventada pasan la validación del server, aunque vengan de un mostrador real.
  const counterSocket = await connectStaffSocket('counter', 'mostrador123');
  counterSocket.emit('menu-add', { name: 'Hackeado Precio', price: -50, category: 'bebidas_calientes' });
  counterSocket.emit('menu-add', { name: 'Hackeado Categoria', price: 1000, category: 'categoria_falsa' });
  await counterPage.waitForTimeout(1000);
  const menuAfterInvalid = await fetchMenu();
  expect(menuAfterInvalid.some(m => m.name.startsWith('Hackeado'))).toBe(false);
  counterSocket.disconnect();

  // 7. ELIMINACIÓN: desaparece del panel del mostrador y del catálogo del cliente
  counterPage.once('dialog', dialog => dialog.accept());
  await adminRow.getByTitle('Eliminar Café de Especialidad').click();
  await expect(adminRow).toHaveCount(0, { timeout: 10000 });
  await expect(clientCard).toHaveCount(0, { timeout: 10000 });
});
