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
  status: 'pendiente' | 'en_preparacion' | 'listo' | 'entregado';
  createdAt: string; // ISO String
  notes?: string;
}
```

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
