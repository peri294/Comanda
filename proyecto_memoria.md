# Memoria Técnica - Sistema de Cafetería QR

Este documento sirve como registro central de decisiones arquitectónicas, estructura del modelo de datos y cambios importantes en el sistema.

---

## 1. Arquitectura General del Sistema

El sistema utiliza una arquitectura cliente-servidor con comunicación bidireccional en tiempo real para coordinar al cliente, la cocina y la caja.

```
                      +-------------------+
                      |   Servidor Node   |
                      | (Express/Sockets) |
                      +---------+---------+
                                |
        +-----------------------+-----------------------+
        |                       |                       |
+-------v-------+       +-------v-------+       +-------v-------+
|  Cliente (QR) |       | Cocina Screen |       | Mostrador UI  |
| (Mobile View) |       | (Order Board) |       |  (Dashboard)  |
+---------------+       +---------------+       +---------------+
```

### Tecnologías Utilizadas
* **Backend**: Node.js, Express, Socket.io.
* **Frontend**: React (Vite), Vanilla CSS (Modo oscuro y temas cálidos/glassmorphism), Lucide Icons.
* **Comunicación**: HTTP (para carga inicial del menú) y WebSockets (para actualizaciones de pedidos y mesas en tiempo real).

---

## 2. Modelos de Datos (en memoria, respaldados por SQLite — ver Decisión 4)

### Mesas (Tables)
Cada mesa tiene un estado que determina qué puede hacer el cliente y qué se muestra en la caja.
```typescript
interface Table {
  id: string; // Número de mesa (e.g., "1", "2")
  status: 'libre' | 'pedido_pendiente' | 'comiendo' | 'esperando_cuenta' | 'pagando_tarjeta' | 'cuenta_cerrada';
  currentOrderId: string | null;
  paymentMethod: 'efectivo' | 'tarjeta' | null;
  total: number;
}
```

### Pedidos (Orders)
```typescript
interface OrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

interface Order {
  id: string;
  tableId: string;
  items: OrderItem[];
  status: 'pendiente' | 'en_preparacion' | 'listo' | 'entregado' | 'cancelado';
  archived: boolean; // true cuando la mesa se cobró (close-table) o el mostrador canceló el pedido
  createdAt: string; // ISO String
  notes?: string;
}
```
`status` es el flujo de cocina; `archived` es independiente y decide si el pedido cuenta para el
total/ticket del mostrador. Un pedido puede estar `entregado` (cocina ya lo sirvió) sin estar
`archived` todavía (la mesa no pagó) — por eso cocina filtra por `status` y mostrador por `archived`.

### Menú (Menu)
Administrable desde el Mostrador y persistido en SQLite (tabla `menu`); los 13 productos originales son solo la semilla del primer arranque.
```typescript
interface MenuItem {
  id: string; // 'm1'..'m13' de semilla; 'm-{timestamp}-{rand}' para altas del mostrador
  name: string;
  description: string;
  price: number;
  category: 'bebidas_calientes' | 'bebidas_frias' | 'pasteleria' | 'salado'; // fijas en v1 (los filtros del cliente están atados a ellas)
  image: string; // Nombre identificador para iconos ('coffee' por defecto en altas)
  available: boolean; // false = "Agotado": visible pero no pedible (rechazado también server-side)
}
```

---

## 3. Historial de Decisiones Técnicas
* **Decisión 1**: Almacenamiento en Memoria Volátil. Se decide no usar una base de datos física para la primera versión para simplificar la ejecución local. Toda la información se mantendrá en memoria RAM en el servidor de Node.js. *(Superada el 2026-07-02 por la Decisión 4: el estado ahora se persiste en SQLite.)*
* **Decisión 2**: Enrutamiento simple basado en Query Parameters en el frontend (`?view=client&table=X`, `?view=kitchen`, `?view=counter`). Esto permite que un único build sirva para los tres propósitos y facilita la simulación del código QR (ejemplo: `http://localhost:5173/?view=client&table=5`).
* **Decisión 3**: Sistema de Audio Sintético. Para no depender de archivos mp3 externos que puedan fallar en la carga local, el sistema utiliza la API Web Audio de JavaScript para sintetizar tonos de campana (`chime` y `double beep`) para notificar al cajero y cocineros.
* **Decisión 4**: Persistencia con SQLite embebido (`node:sqlite`, incluido en Node >= 22.13) bajo un patrón write-through: la memoria sigue siendo la copia de trabajo sobre la que opera toda la lógica de negocio, y cada mutación se refleja en disco de forma sincrónica. Se eligió el módulo nativo de Node (y no `better-sqlite3` ni Postgres/Mongo) para no agregar dependencias externas ni infraestructura: para el volumen de una cafetería alcanza de sobra. Los `items` de cada pedido se guardan como columna JSON (siempre se leen/escriben en bloque junto al pedido, `sanitizeItems()` ya garantiza su estructura; una tabla `order_items` separada solo agregaría joins sin ninguna consulta que lo justifique hoy). Los tokens de sesión de staff se quedan en memoria a propósito: re-loguearse tras un restart no es pérdida de datos, y persistir tokens en disco sería un riesgo de seguridad innecesario.

---

## 4. Guía de Ejecución y Pruebas Locales

Para iniciar la aplicación en tu entorno local:

1. **Servidor Backend**:
   - Ir a la carpeta `backend/`
   - Ejecutar `npm run dev` para iniciar el servidor de WebSockets en el puerto `3001`.
2. **Cliente Frontend**:
   - Ir a la carpeta `frontend/`
   - Ejecutar `npm run dev` para iniciar el servidor de desarrollo Vite en el puerto `5173`.
3. **Simulador General**:
   - Abrir `http://localhost:5173/` en el navegador.
   - Desde el panel principal se pueden abrir múltiples pestañas para simular diferentes mesas (clientes) y las pantallas del mostrador y cocina interactuando simultáneamente.

---

## 5. Registro de Cambios (Changelog)
* **2026-06-18**: 
  - Creación del archivo de memoria técnica y planificación general.
  - Implementación del servidor backend en `backend/server.js` (Express + Socket.io).
  - Implementación de la aplicación frontend con Vite y React en `frontend/src/` (incluyendo vistas de Cliente, Cocina, Mostrador y Portal de Simulación).
  - Estilizado de la aplicación con un diseño de Glassmorphism Premium en `index.css`.
  - Validación extremo a extremo (E2E) exitosa del flujo completo de pedido, cocina y cobro.
  - Inicialización del repositorio Git, vinculación al repositorio remoto de GitHub (https://github.com/peri294/PPR.git) y primer push a la rama `main`.
  - **Corrección de Bug**: Se corrigió el backend en `server.js` para acumular correctamente los montos consumidos cuando una misma mesa realiza múltiples pedidos sucesivos, y archivar correctamente todos los pedidos de la mesa al cerrar la cuenta.
  - **Prueba E2E Multi-Pedido**: Validación exitosa donde un cliente pide un *Espresso Italiano* ($1800), se le entrega, luego pide un *Cinnamon Roll* ($2200), acumulando correctamente **$4000** en el mostrador, solicitando la cuenta y cerrando la mesa de manera fluida.
* **2026-07-01**:
  - **Fix crítico**: Se restauró `ClientView.jsx`, que había quedado roto (sin carrito, cantidades, notas ni seguimiento de estado) en un commit anterior. Se corrigieron además bugs reales de sincronización: `tableId` inconsistente (number vs string) entre navegación por botón y por URL, estado de mesa pegado al cambiar de mesa en la misma pestaña, reconexión de sockets que no volvía a unirse a las salas, y el mostrador mostrando solo el último pedido de una mesa en vez del ticket completo (se separó el concepto de pedido `entregado` por cocina del de mesa `archived`/cobrada).
  - **Refactor**: se extrajeron `findTable()`, `recomputeTableTotal()`, `broadcastOrders()` y `broadcastTables()` en el backend para centralizar la lógica de filtrado que venía repetida en 6 puntos distintos; se creó `frontend/src/utils/sound.js` (unifica el boilerplate de Web Audio API) y `frontend/src/hooks/useSocketRoom.js` (unifica el patrón de unirse a una sala + re-unirse en reconexión).
  - **Autenticación de personal**: se agregó login con contraseña compartida por rol (`cocina123` / `mostrador123` por defecto, sobreescribibles con las variables de entorno `KITCHEN_PASSWORD` y `COUNTER_PASSWORD`) para las pantallas de Cocina y Mostrador. Sesión persistente en `localStorage` del navegador. El token no solo oculta la pantalla: el backend también rechaza `update-order-status` sin sesión de cocina y `close-table` sin sesión de mostrador, y `/api/initial-state` exige el token en el header `Authorization`. Limitación conocida: los tokens viven en memoria (se pierden si el server se reinicia, igual que el resto del estado) y no hay usuarios individuales, solo un password por rol — suficiente para una tablet compartida por turno, no para trazabilidad por empleado.
  - **Edición de pedidos desde el Mostrador**: para corregir errores humanos antes de cobrar, el mostrador puede editar (sacar/agregar items, cambiar cantidad) o cancelar un pedido completo, pero **solo mientras su estado sea `pendiente`** (si cocina ya lo empezó a preparar, el mostrador no puede tocarlo). Eventos nuevos `edit-order` y `cancel-order` (protegidos con `socket.data.roles.has('counter')`, misma lógica que `close-table`), reutilizando `broadcastOrders()`/`broadcastTables()` — no hizo falta cambiar la estructura de comunicación cocina-mostrador. Cocina recibe una alerta aparte (`order-modified`, sonido distinto + borde parpadeante `kitchen-card-flash` por 5s) para notar el cambio sin tener que estar mirando la pantalla fijo. Si se cancela el único pedido de una mesa, `recomputeTableTotal()` también resetea la mesa a `libre` (antes quedaba "fantasma": estado `pedido_pendiente` con $0 y ningún pedido real). Se agregó el status `cancelado` al modelo de `Order` (distinto de `entregado`, para no confundir al cliente si ve el estado de su pedido).
  - **Fix de seguridad — precio no confiable del cliente**: `new-order`, `update-order` y `edit-order` confiaban en el `price`/`name` que mandaba el navegador, así que con las devtools se podía pedir cualquier producto a $0 (o inflar el precio). Se agregó `sanitizeItems()` en `server.js`: cada item se resuelve contra el `MENU` del servidor por `productId` (precio y nombre siempre vienen del server, nunca del cliente), se descartan productos inexistentes y cantidades inválidas (negativas, no numéricas, cero), y si un `new-order` queda sin ningún item válido no se crea nada. Validado con ataques simulados vía socket crudo (price manipulado a 0, productId falso, quantity negativa/no numérica) — todos neutralizados correctamente sin romper el flujo normal.
* **2026-07-02**:
  - **Persistencia con SQLite (`backend/db.js`)**: hasta ahora todo el estado (mesas, pedidos, llamados al mozo) vivía en variables JS en memoria — cualquier reinicio del server (crash, deploy, `node --watch` al editar) borraba las mesas ocupadas y los pedidos en curso de toda la cafetería. Se migró a SQLite embebido vía `node:sqlite` (ver Decisión 4) con patrón write-through: `server.js` sigue operando sobre `tables`/`orders`/`activeAssistanceRequests` en memoria y la lógica de negocio no cambió en nada (`sanitizeItems()`, `recomputeTableTotal()`, filtros cocina/mostrador, regla de edición solo en `pendiente`, cooldown de asistencia — todo intacto); lo único nuevo es que cada uno de los ~10 puntos de mutación (handlers de sockets + `/api/test/reset`) refleja el cambio en la base al final, y al arrancar el server se carga el estado tal cual quedó. Las escrituras multi-fila (`close-table`, reset) van en transacción para que un crash a mitad de camino no deje estado inconsistente. La base vive en `backend/data/cafeteria.db` (gitignoreada, ruta sobreescribible con `DB_PATH`), se crea y siembra con las 12 mesas iniciales en el primer arranque, y usa modo WAL. Los pedidos archivados (mesa cobrada / cancelados) quedan en la base como historial pero no se recargan a memoria: ningún flujo los lee después de archivar, y de paso queda la materia prima para un futuro módulo de reportes/cierre de caja. `/api/test/reset` ahora también limpia la base (incluido el historial) además de la memoria, así los tests E2E siguen arrancando de cero. Verificado: pedido creado → kill del proceso → restart → la mesa conserva estado, total y pedido completo; suite Playwright completa en verde sin tocar los tests. Limitaciones conocidas: el historial archivado crece sin límite (sin compactación/rotación), y sigue sin haber reportes que lo aprovechen.
  - **Gestión dinámica de mesas**: las 12 mesas dejaron de ser una constante hardcodeada (ahora son solo la semilla del primer arranque). El Mostrador puede dar de alta mesas nuevas (evento `add-table`, botón "Agregar Mesa" en el header del panel) y dar de baja **cualquier** mesa, no solo la última (`remove-table`, botón en cada tarjeta de mesa libre, con confirmación). Reglas: al agregar sin número puntual se asigna el más chico sin usar (reponer una mesa dada de baja reutiliza su QR ya impreso); solo se puede quitar una mesa `libre` sin pedidos activos ni llamados al mozo pendientes — una mesa ocupada se cobra primero, para no destruir consumo en curso sin registro. Las demás mesas conservan su número al quitar una del medio (clave: los QR impresos apuntan a `?table=X`). Cambios acompañantes: `new-order` ahora rechaza pedidos de mesas inexistentes (antes creaba el pedido igual y solo salteaba la mesa — con QRs viejos de mesas dadas de baja eso pasaba de rareza teórica a pedido huérfano que cocina prepararía para nadie); el `join` a una mesa inexistente responde `table-state: null` y `ClientView` muestra una pantalla de "Esta mesa no está disponible" en vez de quedarse muda dejando pedir a una mesa fantasma (también reacciona en vivo al evento `table-removed` si la mesa se elimina mientras el cliente la mira). `/api/test/reset` sigue restaurando exactamente las 12 mesas iniciales. Nuevo spec E2E `tests/tables.spec.js`: alta → pedido desde la mesa nueva → intento de baja bloqueado (ocupada) → cobro/cierre → baja → QR viejo bloqueado (en vivo y tras recarga). Suite completa (4 specs) en verde; verificado además que altas/bajas sobreviven al restart del server.
  - **"Caja del Día" persistente (server-side)**: la caja era un `useState(0)` que el mostrador incrementaba localmente en cada cobro — recargar la página la reseteaba a $0. Ahora la calcula el server desde la DB y el navegador solo la muestra. Se descartó un primer enfoque que tenía tres fallas: (1) sin migración de esquema, el `INSERT` con la columna nueva rompía las bases existentes; (2) sumaba por `created_at` (fecha de *creación* del pedido, en UTC) en vez de por fecha de *cobro* — una mesa que pidió 23:50 y pagó 00:10 caía en el día equivocado, y en Argentina (UTC-3) el "día" cambiaba a las 21:00; (3) contaba pedidos cancelados como ventas (filtraba solo por `archived`). Implementación final: columna `orders.closed_at` (con migración `ALTER TABLE` con guarda vía `PRAGMA table_info`, la primera del proyecto) que `close-table` sella con el momento del cobro; `getDailySalesTotal()` suma pedidos `entregado`+`archived` con `closed_at >=` medianoche **local** del server (los items se suman en JS desde el JSON — un puñado de filas por día, sin denormalizar un `total` que pueda divergir); sin columna `total` extra. De paso se corrigió una rareza preexistente de `close-table`: pisaba a `entregado` los pedidos ya cancelados de la mesa (ahora los cancelados quedan `cancelado` y nunca cuentan para la caja). El valor viaja en `/api/initial-state` (carga/recarga) y en el broadcast nuevo `daily-sales-updated` tras cada cobro — el server es la única fuente: `CounterView` ya no suma nada localmente, y dos pestañas de mostrador abiertas ven el mismo número. Cubierto en `tables.spec.js` (cobro → $1800 → recarga → sigue $1800); suite completa en verde y migración verificada contra una base creada con el esquema anterior. Limitación conocida: "hoy" es la medianoche del reloj del server, no hay concepto de turno/cierre de caja manual. *(Resuelta el mismo día con el cierre de caja manual, ver siguiente entrada.)*
  - **Cierre de caja desde el Mostrador**: botón "Cerrar Caja" en el header del panel (evento `close-register`, solo rol `counter`, con confirmación). Cada cierre queda registrado en la tabla nueva `register_closures` (`closed_at`, `total`, `orders_count`) como histórico de arqueos, y la "Caja del Día" pasa a significar *lo cobrado desde el último cierre* (si nunca hubo cierres, desde la medianoche local — el comportamiento anterior). Decisiones: cerrar caja **no** exige mesas libres — lo que se cobre después del cierre cuenta para la caja siguiente, así una mesa que se queda hasta tarde no bloquea el arqueo del turno; y si el último cierre fue ayer, lo cobrado después entra en la caja de hoy (la plata que no entró en un arqueo entra en el siguiente, nunca se pierde). El server responde con el broadcast `register-closed` (total y cantidad de pedidos del cierre) a todos los mostradores conectados — aparece como alerta verde en el panel de notificaciones — más `daily-sales-updated` con la caja reiniciada en $0. `/api/test/reset` también limpia los cierres. Cubierto en `tables.spec.js` (cerrar caja → $0 + alerta "Cierre por $1800 (1 pedido cobrado)" → recarga → sigue $0); suite completa (4 specs) en verde. Limitación conocida: el histórico de cierres se guarda pero todavía no hay una vista para consultarlo (va de la mano del futuro módulo de reportes).
* **2026-07-05**:
  - **URL del backend derivada del host (acceso desde celulares en la red local)**: el frontend tenía `http://localhost:3001` hardcodeado en 6 lugares (socket en `App.jsx`, login en `useStaffAuth`, `initial-state` en Cocina y Mostrador, menú en Cliente y Mostrador) — un celular que escaneara el QR intentaba conectarse a *su propio* localhost y fallaba. Se centralizó en `frontend/src/config.js`: `BACKEND_URL = import.meta.env.VITE_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:3001``. Así, si el celular carga `http://192.168.0.15:5173/?view=client&table=3`, se conecta solo al backend en `192.168.0.15:3001` sin hardcodear IPs; `VITE_BACKEND_URL` queda como override para despliegues donde el backend no comparte host/puerto con el frontend (ej. detrás de un proxy). Pieza que faltaba en la propuesta original: `host: true` en `vite.config.js`, porque Vite por defecto escucha solo en localhost y el celular ni siquiera podía cargar el frontend (el backend ya estaba bien: Express escucha en todas las interfaces y CORS abierto). `tests/global-setup.js` conserva su `localhost:3001` a propósito — los tests siempre corren en la máquina local. Verificado: suite Playwright completa (4 specs) en verde, y frontend + backend respondiendo vía la IP de red local además de localhost. Limitación conocida: en Windows, el firewall puede pedir permiso la primera vez que Node/Vite escuchan en la red — hay que aceptarlo para que los celulares lleguen.
  - **Menú administrable desde el Mostrador (CRUD + stock)**: el `MENU` dejó de ser una constante hardcodeada en `server.js` — ahora vive en la tabla nueva `menu` de SQLite (los 13 productos originales son la semilla del primer arranque, con siembra independiente de la de mesas para que las bases existentes también la reciban) y `menuCache` en memoria es la copia de trabajo, mismo patrón write-through del resto del estado. El Mostrador tiene un panel "Administrar Menú" (alta con nombre/descripción/precio/categoría, edición, baja con confirmación, y switch rápido Agotar/Reponer para cortar un producto sin borrarlo). **El CRUD va por sockets (`menu-add`/`menu-update`/`menu-delete`) con la guarda `roles.has('counter')`, no por HTTP con `requireStaffAuth`**: ese middleware acepta también el token de cocina, que no tiene por qué poder tocar precios (verificado con test de bypass: una sesión de cocina real emitiendo `menu-delete` es ignorada). Validación server-side de inputs (nombre no vacío, precio finito > 0, categoría dentro de las 4 fijas de v1 — los filtros del cliente están atados a ellas; el server también rechaza payloads inválidos de un mostrador legítimo). Tras cada mutación: persistencia + broadcast global `menu-updated` — el cliente actualiza el catálogo en vivo sin recargar y sincroniza su carrito local (un producto borrado/agotado se saca solo del carrito, un precio editado se actualiza antes de confirmar; sin esto el `new-order` fallaría en silencio). Disponibilidad: "agotado" se muestra opaco con botón deshabilitado en el cliente, y `sanitizeItems()` lo rechaza también server-side (la UI no es la única defensa). **Regla clave en `edit-order`** (`sanitizeEditItems()`): los items que ya estaban en el pedido se conservan con su snapshot de nombre/precio aunque el producto se haya agotado o borrado después — solo los items nuevos se validan contra el menú vigente; sin esto, editar un pedido con un producto discontinuado lo borraba en silencio (y si era el único item, cancelaba el pedido entero). Borrar un producto no rompe el historial: `orders.items` guarda snapshots JSON. `/api/test/reset` re-siembra el menú y recarga `menuCache` (crítico con `fullyParallel`: los otros specs piden Espresso/Cappuccino por nombre y esperan sus precios de fábrica). Nuevo `tests/menu.spec.js` (un solo test secuencial, porque el menú es estado global): alta → visible en cliente en vivo → edición de precio reactiva → carrito reactivo ante agotado → ataque por socket crudo pidiendo el agotado (la mesa queda intacta) → bypass de rol cocina → inputs inválidos con rol válido → eliminación reflejada en cliente. Se agregó `socket.io-client` como devDependency de la raíz para los tests de ataque. Suite completa (5 specs) en verde; verificado además que altas y cambios de stock sobreviven al restart del server. Limitaciones conocidas: categorías fijas (agregar una implica tocar los filtros del cliente y la validación), sin foto real del producto (el cliente renderiza emoji por categoría) y el campo `image` de las altas queda en `'coffee'` genérico.

