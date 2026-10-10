import { test, expect } from '@playwright/test';
import { connectStaff, settle } from './helpers.js';

// Corre en su propio proyecto, al final de la suite (ver playwright.config.js): cierra
// las sesiones de personal de todos los specs.

const loginAs = async (page, view, password) => {
  await page.goto(`/?view=${view}`);
  await page.getByPlaceholder('Contraseña').fill(password);
  await page.getByRole('button', { name: /ingresar/i }).click();
};

test('el mostrador cierra todas las demás sesiones y conserva la suya', async ({ browser }) => {
  const counterPage = await (await browser.newContext()).newPage();
  const kitchenPage = await (await browser.newContext()).newPage();
  await loginAs(counterPage, 'counter', 'mostrador123');
  await loginAs(kitchenPage, 'kitchen', 'cocina123');
  await expect(kitchenPage.getByText('Monitor de Cocina')).toBeVisible({ timeout: 15000 });

  // Otra tablet de mostrador, por socket crudo
  const otherCounter = await connectStaff('counter', 'mostrador123');
  await settle();
  const expelled = new Promise(resolve => otherCounter.socket.once('auth-error', resolve));

  counterPage.once('dialog', dialog => dialog.accept());
  await counterPage.getByRole('button', { name: /cerrar otras sesiones/i }).click();

  // Las demás pantallas vuelven al login en el acto, sin tener que emitir nada
  expect(await expelled).toEqual({ role: 'counter' });
  await expect(kitchenPage.getByPlaceholder('Contraseña')).toBeVisible({ timeout: 10000 });

  // La que lo pidió sigue adentro, también tras recargar
  await expect(counterPage.getByText(/Se cerraron \d+ sesi/)).toBeVisible({ timeout: 10000 });
  await counterPage.reload();
  await expect(counterPage.getByText('Panel del Mostrador')).toBeVisible({ timeout: 15000 });
  await expect(counterPage.getByPlaceholder('Contraseña')).toHaveCount(0);

  otherCounter.socket.close();
});
