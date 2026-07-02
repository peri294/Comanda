import { test, expect } from '@playwright/test';

test('cliente agrega items a un pedido existente', async ({ browser }) => {
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  const kitchenContext = await browser.newContext();
  const kitchenPage = await kitchenContext.newPage();

  // Mesa distinta a e2e.spec.js: si Playwright corre los specs en paralelo, no se pisan.
  await clientPage.goto('/?view=client&table=2');
  await kitchenPage.goto('/?view=kitchen');

  // Login de cocina (pantalla protegida por contraseña compartida de personal)
  await kitchenPage.getByPlaceholder('Contraseña').fill('cocina123');
  await kitchenPage.getByRole('button', { name: /ingresar/i }).click();

  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });

  // 1. Pedido inicial: Espresso
  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();
  
  // Validar que el pedido original llegó (usamos .first() para evitar strict mode violation)
  await expect(kitchenPage.getByText('Espresso Italiano').first()).toBeVisible();

  // 2. Intentar agregar Cappuccino
  await clientPage.locator('.menu-card:has-text("Cappuccino Premium")').getByRole('button', { name: /agregar/i }).click();
  
  // Abrir carrito y buscar botón de "Actualizar pedido"
  await clientPage.locator('.cart-float-btn').click();
  const updateBtn = clientPage.getByRole('button', { name: /actualizar pedido/i });
  await expect(updateBtn).toBeVisible();
  await updateBtn.click();
  
  // 3. Validar en cocina que ahora tenemos ambos
  await expect(kitchenPage.getByText('Cappuccino Premium').first()).toBeVisible({ timeout: 10000 });
});
