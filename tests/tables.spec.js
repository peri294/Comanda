import { test, expect } from '@playwright/test';

test('alta y baja de mesas desde el mostrador', async ({ browser }) => {
  const counterContext = await browser.newContext();
  const counterPage = await counterContext.newPage();
  const clientContext = await browser.newContext();
  const clientPage = await clientContext.newPage();

  await counterPage.goto('/?view=counter');

  // Login de Mostrador
  await counterPage.getByPlaceholder('Contraseña').fill('mostrador123');
  await counterPage.getByRole('button', { name: /ingresar/i }).click();

  // 1. AGREGAR UNA MESA NUEVA
  // El backend asigna el número más chico sin usar: con las 12 iniciales, es la 13.
  // (Este es el único test que altera mesas, así no choca con los que corren en paralelo.)
  const mesa13 = counterPage.locator('.table-card', { hasText: 'Mesa 13' });
  await expect(mesa13).toHaveCount(0);
  await counterPage.getByRole('button', { name: /agregar mesa/i }).click();
  await expect(mesa13).toBeVisible({ timeout: 10000 });

  // La mesa nueva nace bloqueada: su QR no deja pedir hasta que el mostrador la habilita
  await expect(mesa13.getByText('Bloqueada')).toBeVisible();
  await mesa13.getByRole('button', { name: 'Habilitar Mesa 13' }).click();
  await expect(mesa13.getByText('Libre')).toBeVisible({ timeout: 10000 });

  // 2. PEDIR DESDE LA MESA NUEVA, con el link del QR que muestra el mostrador
  const qrLink = await mesa13.getByRole('link', { name: 'QR de la Mesa 13' }).getAttribute('href');
  expect(qrLink).toMatch(/[?&]t=/);
  await clientPage.goto(`/${qrLink}`);
  await expect(clientPage.getByText('Cargando menú delicioso...')).not.toBeVisible({ timeout: 20000 });
  await clientPage.locator('.menu-card:has-text("Espresso Italiano")').getByRole('button', { name: /agregar/i }).click();
  await clientPage.locator('.cart-float-btn').click();
  await clientPage.getByRole('button', { name: /confirmar y enviar pedido/i }).click();

  // La mesa nueva pasa a ocupada en el mostrador, con el consumo del pedido
  await expect(mesa13.getByText('Pedido Recibido')).toBeVisible({ timeout: 15000 });
  await expect(mesa13.getByText('$1800')).toBeVisible();

  // 3. UNA MESA OCUPADA NO SE PUEDE QUITAR (el botón de baja solo existe en mesas libres)
  await expect(mesa13.getByTitle('Dar de baja la Mesa 13')).toHaveCount(0);

  // 4. COBRAR Y CERRAR LA MESA PARA LIBERARLA
  await mesa13.getByRole('button', { name: /detalles/i }).click();
  await counterPage.getByRole('button', { name: /confirmar cobro y cerrar mesa/i }).click();
  await expect(mesa13.getByText('Mesa vacía')).toBeVisible({ timeout: 10000 });
  // Al cobrar, el server desconecta los celulares de la mesa: la visita terminó
  await expect(clientPage.getByText('¡Gracias por tu visita!')).toBeVisible({ timeout: 10000 });

  // 5. LA CAJA DEL DÍA REFLEJA EL COBRO Y SOBREVIVE A UNA RECARGA
  // (este es el único test de la suite que cierra mesas, así que el valor es exacto)
  const cajaPanel = counterPage.locator('.glass-panel', { hasText: 'Caja del Día' });
  await expect(cajaPanel.getByText('$1800')).toBeVisible({ timeout: 10000 });
  // Antes la caja era un contador local del navegador: recargar la volvía a $0.
  // Ahora la calcula el server desde la DB (pedidos cobrados hoy).
  await counterPage.reload();
  await expect(cajaPanel.getByText('$1800')).toBeVisible({ timeout: 15000 });

  // 6. CERRAR CAJA: queda registrado el cierre y la caja arranca de nuevo en $0
  counterPage.once('dialog', dialog => dialog.accept());
  await counterPage.getByRole('button', { name: /cerrar caja/i }).click();
  await expect(cajaPanel.getByText('$0')).toBeVisible({ timeout: 10000 });
  await expect(counterPage.getByText('Caja cerrada')).toBeVisible();
  await expect(counterPage.getByText('Cierre por $1800 (1 pedido cobrado).')).toBeVisible();
  // El cierre también persiste: tras recargar, la caja sigue en $0 (no vuelve a $1800)
  await counterPage.reload();
  await expect(cajaPanel.getByText('$0')).toBeVisible({ timeout: 15000 });

  // El cliente vuelve a escanear el QR: la mesa sigue habilitada, así que entra de nuevo
  await clientPage.reload();
  await expect(clientPage.getByText('Nuestro Menú')).toBeVisible({ timeout: 15000 });

  // 7. DAR DE BAJA LA MESA
  counterPage.once('dialog', dialog => dialog.accept());
  await mesa13.getByTitle('Dar de baja la Mesa 13').click();
  await expect(mesa13).toHaveCount(0, { timeout: 10000 });

  // 8. EL QR VIEJO QUEDA BLOQUEADO PARA EL CLIENTE
  // El cliente que estaba mirando la mesa recibe el aviso en vivo (table-removed)...
  await expect(clientPage.getByText('Esta mesa no está disponible')).toBeVisible({ timeout: 10000 });
  // ...y quien entra de cero con ese QR también la ve como no disponible (join responde null)
  await clientPage.reload();
  await expect(clientPage.getByText('Esta mesa no está disponible')).toBeVisible({ timeout: 15000 });
});
