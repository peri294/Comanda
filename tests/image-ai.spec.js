import { test, expect } from '@playwright/test';
import { BACKEND, clientUrl, connectStaff, addTable, login } from './helpers.js';

// El backend de los E2E corre con IMAGE_AI_PROVIDER=fake (ver ci.yml): la "generación"
// devuelve una imagen fija sin llamar a ningún proveedor real.
const generate = (token, body) => fetch(`${BACKEND}/api/images/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body)
});

test('generar la imagen de un producto con IA: vista previa, descartar, usar y publicar', async ({ browser }) => {
  const { imageGeneration } = await (await fetch(`${BACKEND}/api/config`)).json();
  test.skip(!imageGeneration, 'El backend no tiene proveedor de imágenes: levantarlo con IMAGE_AI_PROVIDER=fake');

  // Solo el mostrador, y con nombre
  expect((await generate(null, { name: 'Café' })).status).toBe(401);
  expect((await generate(await login('kitchen', 'cocina123'), { name: 'Café' })).status).toBe(403);
  expect((await generate(await login('counter', 'mostrador123'), { name: '  ' })).status).toBe(400);

  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '47');
  const clientPage = await (await browser.newContext()).newPage();
  await clientPage.goto(await clientUrl('47'));
  await expect(clientPage.getByText('Nuestro Menú')).toBeVisible({ timeout: 20000 });

  const page = await (await browser.newContext()).newPage();
  await page.goto('/?view=counter');
  await page.getByPlaceholder('Contraseña').fill('mostrador123');
  await page.getByRole('button', { name: /ingresar/i }).click();
  await page.getByRole('button', { name: /administrar menú/i }).click();

  await page.getByPlaceholder('Nombre del producto').fill('Medialuna IA de Prueba');
  await page.getByPlaceholder('Precio').fill('900');
  await page.getByLabel('Descripción del producto').fill('Medialuna de manteca recién horneada');

  // 1. Generar y descartar: no queda nada
  const generateButton = page.getByRole('button', { name: /generar con ia/i });
  await generateButton.click();
  const preview = page.getByAltText('Imagen generada con IA');
  await expect(preview).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Descartar' }).click();
  await expect(preview).toHaveCount(0);
  await expect(generateButton).toBeVisible();

  // 2. Generar otra vez y usarla: queda como la foto del producto y el botón de IA se va
  await generateButton.click();
  await expect(preview).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Usar esta imagen' }).click();
  await expect(page.getByAltText('Foto del producto')).toBeVisible({ timeout: 10000 });
  await expect(generateButton).toHaveCount(0);

  // 3. Se publica al guardar, y la mesa la ve en vivo
  await page.getByRole('button', { name: /agregar producto/i }).click();
  const card = clientPage.locator('.menu-card', { hasText: 'Medialuna IA de Prueba' });
  await expect(card.locator('img.menu-card-img')).toHaveAttribute('src', /\/api\/images\/img-/, { timeout: 10000 });

  // Limpieza: el producto (y su foto) se borran
  const item = (await (await fetch(`${BACKEND}/api/menu`)).json()).find(m => m.name === 'Medialuna IA de Prueba');
  counter.socket.emit('menu-delete', { id: item.id });
  await expect(card).toHaveCount(0, { timeout: 10000 });
  counter.socket.close();
});
