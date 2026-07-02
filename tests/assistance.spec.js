import { test, expect } from '@playwright/test';

test('flujo de asistencia y cuenta parcial', async ({ browser }) => {
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  const counterContext = await browser.newContext();
  const counterPage = await counterContext.newPage();

  // Navegar a vistas usando Mesa 3 (para no pisar otros tests paralelos)
  await clientPage.goto('/?view=client&table=3');
  await counterPage.goto('/?view=counter');

  // Login de Mostrador
  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();

  // Esperar carga de menú
  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });

  // 1. LLAMAR AL MOZO Y VERIFICAR ALERTA EN EL MOSTRADOR
  // Usamos el nombre /mozo/i porque el texto cambia de "Llamar al Mozo" a "Mozo en camino..."
  const llamarMozoBtn = clientPage.getByRole('button', { name: /mozo/i });
  await expect(llamarMozoBtn).toBeVisible({ timeout: 15000 });
  await llamarMozoBtn.click();

  // Validar estado deshabilitado en cliente
  await expect(llamarMozoBtn).toBeDisabled();
  await expect(clientPage.getByText('Mozo en camino...')).toBeVisible();

  // Validar que la alerta de asistencia aparece en el panel de mostrador (.first() evita strict mode violation)
  const alertaMesa = counterPage.getByText('Mesa 3 pidió asistencia').first();
  await expect(alertaMesa).toBeVisible({ timeout: 15000 });

  // 2. ATENDER LLAMADO Y VERIFICAR REHABILITACIÓN EN EL CLIENTE
  await counterPage.locator('div:has-text("Mesa 3")').getByRole('button', { name: /atendida/i }).click();

  // Validar que el botón vuelve a habilitarse en el cliente
  await expect(llamarMozoBtn).toBeEnabled({ timeout: 10000 });

  // 3. TICKET PARCIAL DEL CLIENTE
  // Agregar Espresso y confirmar pedido
  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();

  // Validar que "Mi Cuenta Parcial" aparece y muestra el Espresso a $1800
  const cuentaParcialHeader = clientPage.getByRole('button', { name: /mi cuenta parcial/i });
  await expect(cuentaParcialHeader).toBeVisible({ timeout: 15000 });
  await cuentaParcialHeader.click();
  
  await expect(clientPage.locator('.glass-panel:has-text("Mi Cuenta Parcial")').getByText('1x Espresso Italiano')).toBeVisible();
});
