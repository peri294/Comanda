import { test, expect } from '@playwright/test';
import { clientUrl, connectStaff, addTable } from './helpers.js';

// Los cortes se simulan con window.__socket (solo existe en desarrollo, ver App.jsx).

test('sin conexión, el Mostrador queda en pausa y avisa; al volver se reactiva', async ({ page }) => {
  await page.goto('/?view=counter');
  await page.getByPlaceholder('Contraseña').fill('mostrador123');
  await page.getByRole('button', { name: /ingresar/i }).click();
  const startDay = page.getByRole('button', { name: /iniciar día/i });
  await expect(startDay).toBeEnabled({ timeout: 15000 });

  await page.evaluate(() => window.__socket.disconnect());
  await expect(page.getByRole('alert').filter({ hasText: 'Sin conexión con el servidor' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Sin conexión' })).toBeVisible();
  // Todas las acciones quedan deshabilitadas: nada se puede tocar y perder en silencio
  await expect(startDay).toBeDisabled();
  await expect(page.getByRole('button', { name: /administrar menú/i })).toBeDisabled();

  await page.evaluate(() => window.__socket.connect());
  await expect(startDay).toBeEnabled({ timeout: 10000 });
  await expect(page.getByRole('alert').filter({ hasText: 'Sin conexión con el servidor' })).toHaveCount(0);
});

test('un cliente sin conexión ve que tiene que pedir ayuda al mozo', async ({ page }) => {
  const counter = await connectStaff('counter', 'mostrador123');
  await addTable(counter, '46');
  await page.goto(await clientUrl('46'));
  await expect(page.getByText('Nuestro Menú')).toBeVisible({ timeout: 20000 });
  // Cargar la página no es un corte: no hay aviso
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.evaluate(() => window.__socket.disconnect());
  await expect(page.getByRole('alert')).toContainText('pedile ayuda al mozo o al encargado');

  await page.evaluate(() => window.__socket.connect());
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 10000 });
  counter.socket.close();
});
