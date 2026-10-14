import { test, expect } from '@playwright/test';
import { BACKEND, clientUrl, connectStaff, addTable, login } from './helpers.js';

// Los dos tests tocan las categorías (estado global): en serie, para que el del orden no
// vea aparecer la categoría del otro a mitad de camino.
test.describe.configure({ mode: 'serial' });

const fetchJson = async (path) => (await fetch(`${BACKEND}${path}`)).json();

// PNG de 1x1: lo mínimo que el navegador puede abrir para achicarlo y subirlo.
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// Un solo test secuencial: las categorías son estado global. Solo se tocan la categoría
// y el producto propios, que se borran al final.
test('categorías administrables y fotos de productos, en vivo en las mesas', async ({ browser }) => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '41');

  const counterPage = await (await browser.newContext()).newPage();
  await counterPage.goto('/?view=counter');
  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();
  await counterPage.getByRole('button', { name: /administrar menú/i }).click();

  const clientPage = await (await browser.newContext()).newPage();
  await clientPage.goto(await clientUrl('41'));
  await expect(clientPage.getByText('Nuestro Menú')).toBeVisible({ timeout: 20000 });

  // 1. CATEGORÍA NUEVA: sin productos todavía, el cliente no ve una pestaña vacía
  await counterPage.getByLabel('Emoji de la categoría').fill('🎂');
  await counterPage.getByPlaceholder('Nombre de la categoría').fill('Tortas de Prueba');
  await counterPage.getByRole('button', { name: /^agregar$/i }).click();
  const categoryRow = counterPage.locator('.category-admin-row', { hasText: 'Tortas de Prueba' });
  await expect(categoryRow).toBeVisible({ timeout: 10000 });
  const category = (await fetchJson('/api/categories')).find(c => c.name === 'Tortas de Prueba');
  expect(category.icon).toBe('🎂');
  await expect(clientPage.getByRole('button', { name: 'Tortas de Prueba' })).toHaveCount(0);

  // 2. PRODUCTO CON FOTO EN ESA CATEGORÍA
  await counterPage.getByPlaceholder('Nombre del producto').fill('Lemon Pie de Prueba');
  await counterPage.getByPlaceholder('Precio').fill('4100');
  await counterPage.getByLabel('Categoría del producto').selectOption(category.id);
  await counterPage.getByTestId('product-photo-input').setInputFiles({ name: 'pie.png', mimeType: 'image/png', buffer: tinyPng });
  await expect(counterPage.getByAltText('Foto del producto')).toBeVisible({ timeout: 10000 });
  await counterPage.getByRole('button', { name: /agregar producto/i }).click();

  // El cliente ve la pestaña nueva y la foto, en vivo
  const tab = clientPage.getByRole('button', { name: 'Tortas de Prueba' });
  await expect(tab).toBeVisible({ timeout: 10000 });
  await tab.click();
  const card = clientPage.locator('.menu-card', { hasText: 'Lemon Pie de Prueba' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Tortas de Prueba')).toBeVisible();
  const photoSrc = await card.locator('img.menu-card-img').getAttribute('src');
  expect(photoSrc).toMatch(/\/api\/images\/img-/);
  const photo = await fetch(photoSrc);
  expect(photo.status).toBe(200);
  expect(photo.headers.get('content-type')).toBe('image/jpeg');

  // 3. UNA CATEGORÍA CON PRODUCTOS NO SE BORRA (ni desde la UI ni por socket)
  await categoryRow.getByTitle('Eliminar categoría Tortas de Prueba').click();
  await expect(counterPage.getByRole('alert')).toContainText('tiene 1 producto');
  counter.socket.emit('category-delete', { id: category.id });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await fetchJson('/api/categories')).some(c => c.id === category.id)).toBe(true);

  // 4. SUBIR IMÁGENES ES SOLO DEL MOSTRADOR, y solo imágenes de verdad
  const upload = (token, body) => fetch(`${BACKEND}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body)
  });
  const png = { mime: 'image/png', data: tinyPng.toString('base64') };
  expect((await upload(null, png)).status).toBe(401);
  expect((await upload(await login('kitchen', 'cocina123'), png)).status).toBe(403);
  expect((await upload(counter.token, { mime: 'image/svg+xml', data: png.data })).status).toBe(400);
  expect((await upload(counter.token, { mime: 'image/jpeg', data: png.data })).status).toBe(400);

  // 5. BORRAR EL PRODUCTO LIBERA SU FOTO, y después la categoría ya se puede borrar
  counterPage.once('dialog', dialog => dialog.accept());
  await counterPage.locator('.menu-admin-row', { hasText: 'Lemon Pie de Prueba' }).getByTitle('Eliminar Lemon Pie de Prueba').click();
  await expect(card).toHaveCount(0, { timeout: 10000 });
  expect((await fetch(photoSrc)).status).toBe(404);

  counterPage.once('dialog', dialog => dialog.accept());
  await categoryRow.getByTitle('Eliminar categoría Tortas de Prueba').click();
  await expect(categoryRow).toHaveCount(0, { timeout: 10000 });
  expect((await fetchJson('/api/categories')).some(c => c.id === category.id)).toBe(false);

  counter.socket.close();
});

test('el orden de las categorías se cambia desde el Mostrador', async () => {
  const counter = await connectStaff('counter', 'mostrador123');
  const before = (await fetchJson('/api/categories')).map(c => c.id);

  // Un orden inválido (falta una categoría) se ignora
  counter.socket.emit('category-reorder', { ids: before.slice(1) });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await fetchJson('/api/categories')).map(c => c.id)).toEqual(before);

  // Uno válido se aplica, y se vuelve al original para no afectar a otros specs
  const reversed = [...before].reverse();
  counter.socket.emit('category-reorder', { ids: reversed });
  await expect.poll(async () => (await fetchJson('/api/categories')).map(c => c.id)).toEqual(reversed);
  counter.socket.emit('category-reorder', { ids: before });
  await expect.poll(async () => (await fetchJson('/api/categories')).map(c => c.id)).toEqual(before);
  counter.socket.close();
});
