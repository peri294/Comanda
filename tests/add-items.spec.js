import { test, expect } from '@playwright/test';
import { clientUrl, joinTable, login, connect, fetchState } from './helpers.js';

test('cada ronda del cliente es una comanda nueva en cocina, sin tocar la que ya está en preparación', async ({ browser }) => {
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();
  const kitchenContext = await browser.newContext();
  const kitchenPage = await kitchenContext.newPage();

  // Mesa distinta a e2e.spec.js: si Playwright corre los specs en paralelo, no se pisan.
  await clientPage.goto(await clientUrl(2));
  await kitchenPage.goto('/?view=kitchen');

  // Login de cocina (pantalla protegida por contraseña compartida de personal)
  await kitchenPage.getByPlaceholder('Contraseña').fill('cocina123');
  await kitchenPage.getByRole('button', { name: /ingresar/i }).click();

  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });

  // 1. Pedido inicial: Espresso
  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();

  const mesa2Cards = kitchenPage.locator('.kitchen-card', { hasText: 'Mesa 2' });
  const espressoCard = mesa2Cards.filter({ hasText: 'Espresso Italiano' });
  await expect(espressoCard).toHaveCount(1);

  // 2. Cocina confirma el pedido: desde acá ese pedido no se modifica más
  await espressoCard.getByRole('button', { name: /empezar preparación/i }).click();
  await expect(espressoCard.getByRole('button', { name: /marcar como listo/i })).toBeVisible();

  // 3. El cliente pide otra cosa: el carrito ya no ofrece "Actualizar Pedido"
  await clientPage.locator('.menu-card:has-text("Cappuccino Premium")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await expect(clientPage.getByRole('button', { name: /actualizar pedido/i })).toHaveCount(0);
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();

  // 4. Cocina recibe una comanda nueva (pendiente) y la que está en preparación queda intacta
  const cappuccinoCard = mesa2Cards.filter({ hasText: 'Cappuccino Premium' });
  await expect(cappuccinoCard).toHaveCount(1, { timeout: 10000 });
  await expect(cappuccinoCard.getByRole('button', { name: /empezar preparación/i })).toBeVisible();
  await expect(cappuccinoCard).not.toContainText('Espresso Italiano');
  await expect(espressoCard).not.toContainText('Cappuccino Premium');
  await expect(espressoCard.getByRole('button', { name: /marcar como listo/i })).toBeVisible();
});

test('update-order ya no existe: un socket no puede meter items en un pedido ajeno', async () => {
  // Mesa 8: libre de los otros specs que corren en paralelo
  const client = await connect();
  await joinTable(client, '8');
  const orderPromise = new Promise(resolve => client.once('order-status-changed', resolve));
  client.emit('new-order', { tableId: '8', items: [{ productId: 'm1', quantity: 1 }] });
  const order = await orderPromise;

  // Un socket anónimo (sin join) intenta colarse en el pedido con el evento viejo
  const attacker = await connect();
  attacker.emit('update-order', { orderId: order.id, items: [{ productId: 'm12', quantity: 5 }] });
  await new Promise(resolve => setTimeout(resolve, 500));

  const token = await login('counter', 'mostrador123');
  const after = (await fetchState(token)).orders.find(o => o.id === order.id);
  expect(after.items).toEqual([expect.objectContaining({ productId: 'm1', quantity: 1 })]);

  client.close();
  attacker.close();
});
