import { test, expect } from '@playwright/test';
import { BACKEND, clientUrl, connectStaff, addTable } from './helpers.js';

const config = async () => (await fetch(`${BACKEND}/api/config`)).json();

test('el nombre del local se cambia desde el Mostrador y se ve en vivo en las mesas', async ({ browser }) => {
  // Desarrollo: la raíz es el simulador, y el nombre arranca en el de la demo
  const initial = await config();
  expect(initial.mode).toBe('dev');
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '40');

  const clientPage = await (await browser.newContext()).newPage();
  await clientPage.goto(await clientUrl('40'));
  await expect(clientPage.locator('.logo-name')).toHaveText(initial.businessName, { timeout: 20000 });

  const counterPage = await (await browser.newContext()).newPage();
  await counterPage.goto('/?view=counter');
  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();
  await counterPage.getByRole('button', { name: /configuración/i }).click();
  await counterPage.getByLabel('Nombre del local').fill('  Café de Prueba  ');
  await counterPage.getByRole('button', { name: /guardar nombre/i }).click();

  // La mesa lo ve sin recargar, y queda guardado (título de la pestaña incluido)
  await expect(clientPage.locator('.logo-name')).toHaveText('Café de Prueba', { timeout: 10000 });
  await expect(clientPage).toHaveTitle('Café de Prueba');
  expect((await config()).businessName).toBe('Café de Prueba');

  // Un nombre vacío o un rol que no es el mostrador no lo cambian
  counter.socket.emit('update-settings', { businessName: '   ' });
  const kitchen = await connectStaff('kitchen', 'cocina123');
  kitchen.socket.emit('update-settings', { businessName: 'Cocina manda' });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await config()).businessName).toBe('Café de Prueba');

  // Logo: una imagen subida por el mostrador reemplaza al ícono del header en las mesas
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  ).toString('base64');
  const uploaded = await (await fetch(`${BACKEND}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${counter.token}` },
    body: JSON.stringify({ mime: 'image/png', data: png })
  })).json();
  counter.socket.emit('update-settings', { logoImageId: uploaded.id });
  await expect(clientPage.locator('img.logo-img')).toHaveAttribute('src', new RegExp(uploaded.id), { timeout: 10000 });
  // Un id inventado no reemplaza el logo; null lo saca y borra la imagen
  counter.socket.emit('update-settings', { logoImageId: 'img-00000000-0000-0000-0000-000000000000' });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect((await config()).logoUrl).toBe(`/api/images/${uploaded.id}`);
  counter.socket.emit('update-settings', { logoImageId: null });
  await expect(clientPage.locator('img.logo-img')).toHaveCount(0, { timeout: 10000 });
  expect((await fetch(`${BACKEND}/api/images/${uploaded.id}`)).status).toBe(404);

  // Vuelve al nombre original para no afectar a otros specs
  counter.socket.emit('update-settings', { businessName: initial.businessName });
  await expect.poll(async () => (await config()).businessName).toBe(initial.businessName);
  [counter.socket, kitchen.socket].forEach(s => s.close());
});
