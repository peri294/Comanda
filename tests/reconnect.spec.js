import { test, expect } from '@playwright/test';
import { clientUrl } from './helpers.js';

// Cubre los dos fixes de sincronización:
// 1. El server responde assistance-ack al pedir asistencia: un rechazo por cooldown
//    ya no deja al cliente bloqueado 60s en "Mozo en camino..." sin llamado real.
// 2. Las vistas de personal re-piden el estado inicial al reconectar el socket,
//    en vez de quedarse congeladas con lo anterior al corte de conexión.

test('cooldown de asistencia: el rechazo rehabilita el botón sin alertar al mostrador', async ({ browser }) => {
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  const counterContext = await browser.newContext();
  const counterPage = await counterContext.newPage();

  // Mesa 5: libre de los otros specs que corren en paralelo
  await clientPage.goto(await clientUrl(5));
  await counterPage.goto('/?view=counter');

  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();

  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });

  // 1. Llamar al mozo y que el mostrador lo atienda (flujo ya cubierto en assistance.spec,
  // acá solo se arma el escenario para dejar el cooldown de 10s corriendo)
  const llamarMozoBtn = clientPage.getByRole('button', { name: /mozo/i });
  await expect(llamarMozoBtn).toBeVisible({ timeout: 15000 });
  await llamarMozoBtn.click();
  await expect(llamarMozoBtn).toBeDisabled();

  // Fila exacta de la Mesa 5: con otros specs en paralelo puede haber más llamados en pantalla
  const atendidaBtn = counterPage.locator('.assistance-row', { has: counterPage.getByText('Mesa 5', { exact: true }) })
    .getByRole('button', { name: /atendida/i });
  await expect(atendidaBtn).toBeVisible({ timeout: 15000 });
  await atendidaBtn.click();
  await expect(llamarMozoBtn).toBeEnabled({ timeout: 10000 });

  // 2. Volver a llamar DENTRO del cooldown: el server rechaza con assistance-ack.
  // El botón queda deshabilitado solo hasta que vence el cooldown (~10s), no 60s,
  // y el mostrador no recibe ninguna alerta nueva.
  await llamarMozoBtn.click();
  await expect(llamarMozoBtn).toBeDisabled();
  await counterPage.waitForTimeout(1500);
  await expect(atendidaBtn).toHaveCount(0);
  await expect(llamarMozoBtn).toBeEnabled({ timeout: 12000 });

  // 3. Pasado el cooldown, un llamado nuevo sí llega al mostrador
  await llamarMozoBtn.click();
  await expect(llamarMozoBtn).toBeDisabled();
  await expect(atendidaBtn).toBeVisible({ timeout: 10000 });
});

test('el mostrador se resincroniza al reconectar el socket', async ({ browser }) => {
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  const counterContext = await browser.newContext();
  const counterPage = await counterContext.newPage();

  // Mesa 6: libre de los otros specs que corren en paralelo
  await clientPage.goto(await clientUrl(6));
  await counterPage.goto('/?view=counter');

  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();

  const mesa6Card = counterPage.locator('.table-card', { hasText: 'Mesa 6' });
  await expect(mesa6Card).toBeVisible({ timeout: 15000 });
  await expect(mesa6Card).toContainText('Libre');

  // Cortar el socket del mostrador (disconnect manual: socket.io no auto-reconecta)
  await counterPage.evaluate(() => window.__socket.disconnect());

  // Mientras el mostrador está sordo, un cliente hace un pedido
  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });
  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();
  // El server lo procesó (el propio cliente recibe el estado de vuelta)
  await expect(clientPage.getByText('Pedido Recibido')).toBeVisible({ timeout: 15000 });

  // El mostrador se perdió el evento: sigue mostrando la mesa libre
  await expect(mesa6Card).toContainText('Libre');

  // Al reconectar, el refetch del estado inicial rehidrata el panel
  await counterPage.evaluate(() => window.__socket.connect());
  await expect(mesa6Card).toContainText('Pedido Recibido', { timeout: 15000 });
  await expect(mesa6Card).toContainText('$1.800');
});
