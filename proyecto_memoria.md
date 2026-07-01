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

## 2. Modelos de Datos (Estructuras en Memoria)

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
```typescript
interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  category: 'bebidas_calientes' | 'bebidas_frias' | 'pasteleria' | 'salado';
  image: string; // Nombre identificador para iconos
}
```

---

## 3. Historial de Decisiones Técnicas
* **Decisión 1**: Almacenamiento en Memoria Volátil. Se decide no usar una base de datos física para la primera versión para simplificar la ejecución local. Toda la información se mantendrá en memoria RAM en el servidor de Node.js.
* **Decisión 2**: Enrutamiento simple basado en Query Parameters en el frontend (`?view=client&table=X`, `?view=kitchen`, `?view=counter`). Esto permite que un único build sirva para los tres propósitos y facilita la simulación del código QR (ejemplo: `http://localhost:5173/?view=client&table=5`).
* **Decisión 3**: Sistema de Audio Sintético. Para no depender de archivos mp3 externos que puedan fallar en la carga local, el sistema utiliza la API Web Audio de JavaScript para sintetizar tonos de campana (`chime` y `double beep`) para notificar al cajero y cocineros.

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

