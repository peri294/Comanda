import { test, expect } from '@playwright/test';
import { clientUrl } from './helpers.js';

test('cliente realiza un pedido y aparece en cocina', async ({ browser }) => {
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  const kitchenContext = await browser.newContext();
  const kitchenPage = await kitchenContext.newPage();

  // Navegar a las vistas (CORREGIDO: agregar table=1)
  await clientPage.goto(await clientUrl(1));
  await kitchenPage.goto('/?view=kitchen');

  // Login de cocina (pantalla protegida por contraseña compartida de personal)
  await kitchenPage.getByPlaceholder('Contraseña').fill('cocina123');
  await kitchenPage.getByRole('button', { name: /ingresar/i }).click();

  // Esperar a que el texto "Cargando" desaparezca
  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });
  
  // Ahora buscar el botón "Agregar"
  const agregarBtn = clientPage.getByRole('button', { name: /agregar/i }).first();
  await expect(agregarBtn).toBeVisible({ timeout: 20000 });

  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();

  // .first(): otros specs pueden correr en paralelo y también tener "Espresso Italiano"
  // en otra mesa, lo cual es un estado legítimo de cocina, no un bug.
  await expect(kitchenPage.getByText('Espresso Italiano').first()).toBeVisible({ timeout: 15000 });
});
